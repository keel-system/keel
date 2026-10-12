// La higiene de los logs que escribe el AGENTE (incremento 14e de PLAN-KEEL-NEST.md): `infra/check-logging.sh`,
// el gemelo del de keel-spring traducido a TypeScript. Los logs de las fronteras los fija build; los de negocio los
// añade el agente, y ahí hay formas de equivocarse que no rompen nada y salen caras.
//
// Es un gate de PROHIBICIÓN: nace VERDE sobre el árbol recién generado y se pone rojo cuando el agente introduce una
// forma vetada (al revés que check-idempotency.sh, que nace rojo porque exige un uso que build no escribe).
//
// Lo que NO se traduce de keel-spring, y por qué:
//   · concatenar dentro del log: en Node la plantilla (`pedido ${id}`) es la forma idiomática y el logger de Nest no
//     tiene argumentos estructurados que se pierdan;
//   · los executors que no propagan el contexto: AsyncLocalStorage sigue a las promesas, a los temporizadores y a los
//     callbacks sin que nadie haga nada. Lo único que lo pierde es OTRO hilo de JavaScript (worker_threads), y eso sí
//     se veta.
//
// Las reglas son datos (exportadas): el test recorre esta misma lista y la falsa regla a regla, así que una regla
// nueva no entra sin su caso.

/** Las herramientas de línea de comandos que build genera: su salida es la consola, a propósito. */
export const CLI_FILES = ['src/infrastructure/persistence/schema-baseline.ts'];

// Una llamada de log: el Logger de Nest (`this.log`, `this.logger`, `logger`) o la consola.
const LOG_CALL = String.raw`(?:\b(?:this\.)?(?:log|logger|LOG|LOGGER)\.(?:verbose|debug|log|warn|error|fatal)|\bconsole\.(?:log|info|warn|error|debug|trace))\s*\(`;
const ENTRY = '(?:command|query|dto|request|payload|body|envelope)';

export const LOGGING_RULES = [
  {
    id: 'wholeObject',
    pattern: String.raw`${LOG_CALL}[^;]*(?:JSON\.stringify\(\s*${ENTRY}\s*[,)]|\$\{\s*${ENTRY}\s*\}|,\s*${ENTRY}\s*[,)])`,
    why: 'loguea un objeto de entrada entero: lleva al backend de logs todos los datos de quien llama (emails, documentos, tokens), y cambia cuando el diseño añade un campo; loguea solo ids o campos concretos',
    sample: "this.log.log(`recibido ${JSON.stringify(command)}`);",
    allowed: 'this.log.log(`recibido el pedido ${command.orderId}`);'
  },
  {
    id: 'errorLevel',
    pattern: String.raw`(?:\b(?:this\.)?(?:log|logger|LOG|LOGGER)|\bconsole)\.(?:error|fatal)\s*\(`,
    paths: ['src/domain/', 'src/application/'],
    why: 'un ERROR desde el dominio o los casos de uso: ahí un fallo se LANZA y lo registra la frontera, una vez y con su pila; un error logueado y tragado es justo lo que el diseño no puede ver. Si es una degradación elegida, warn',
    sample: "console.error('no se pudo reservar');",
    allowed: "throw new StockUnavailableException('no se pudo reservar');"
  },
  {
    id: 'console',
    pattern: String.raw`\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(`,
    exclude: CLI_FILES,
    why: 'escribe en la consola a pelo: se salta el logger del servicio, así que la línea sale sin formato ECS, sin nivel y sin correlationId ni traza; usa new Logger(Contexto) de Nest',
    sample: "console.log('pedido creado', id);",
    allowed: "this.log.log(`pedido creado ${id}`);"
  },
  {
    id: 'context',
    pattern: String.raw`\bnew\s+Worker\s*\(`,
    why: 'lanza otro hilo de JavaScript (worker_threads), que empieza SIN el contexto de la petición: sin correlationId, sin la transacción del caso de uso y, con telemetría, sin la traza. El trabajo concurrente en Node va con promesas (Promise.all), que lo conservan',
    sample: "const worker = new Worker('./resize.js');",
    allowed: 'const [a, b] = await Promise.all([this.portA.find(id), this.portB.find(id)]);'
  }
];

export function generate(model) {
  if (!(model.services ?? []).some((service) => (service.operations ?? []).length > 0)) return [];
  return [{ path: 'infra/check-logging.sh', content: script(model) }];
}

function script(model) {
  return `#!/usr/bin/env bash
# check-logging.sh — higiene de los logs de ${model.service.name}.
#
# Los logs de las fronteras los genera build; los de negocio los escribe el agente. Este gate veta cuatro formas que
# no rompen nada y salen caras: loguear un objeto de entrada entero, un ERROR desde domain/ o application/ (ahí un
# fallo se lanza y lo registra la frontera), la consola a pelo (se salta el logger del servicio) y un worker_thread
# (empieza sin el contexto de la petición).
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-logging.sh
#
# Código de salida:
#   0  sin hallazgos
#   1  hay hallazgos → vuelven al agente de código
set -u

if [ ! -d src ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró src/)." >&2
  exit 1
fi

${sourceGate({
  title: 'HIGIENE DE LOGS Y CONTEXTO',
  label: 'logging',
  rules: LOGGING_RULES.map(({ id, pattern, paths, exclude, why }) => ({ id, pattern, paths, exclude, why })),
  footer: model.stack?.telemetry === 'otel'
    ? 'Ver docs/keel/conventions/observability.md § Reglas para quien escribe código.'
    : 'Loguea con new Logger(Contexto) de Nest: el logger del servicio pone el formato, el nivel y la correlación.'
})}
`;
}

/**
 * El programa que recorre `src/` y aplica reglas por línea, sin comentarios (las notas que build deja en los stubs
 * explican estas mismas formas, y sin quitarlas el gate saldría rojo por su propia prosa). Va embebido en el `.sh`
 * como un heredoc con comillas —bash no expande nada dentro— y las reglas viajan como JSON.
 *
 * Una regla: `{ id, pattern, flags?, paths?, exclude?, why }`, o con `check: 'labelKeys'` el examen de las claves
 * de etiqueta de métrica (telemetry-gate.js).
 */
export function sourceGate({ title, label, rules, allowedKeys = [], footer }) {
  return `node --input-type=module - <<'KEEL_GATE'
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RULES = ${JSON.stringify(rules, null, 2)};
const ALLOWED_KEYS = new Set(${JSON.stringify(allowedKeys)});

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name).split('\\\\').join('/');
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

// El código sin comentarios, con las líneas en su sitio (un comentario de bloque se vacía, no se borra).
function code(text) {
  const blanked = text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, (block) => block.replace(/[^\\n]/g, ' '));
  return blanked.split('\\n').map((line) => line.replace(/(^|[^:'"\`])\\/\\/.*$/, '$1'));
}

// Las claves de un objeto literal de etiquetas: «clave: valor», «'clave': valor», «[ATTRIBUTES.x]: valor» o la
// forma corta «clave».
function keysOf(body) {
  return body
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const computed = /^\\[\\s*([A-Za-z0-9_.]+)\\s*\\]\\s*:/.exec(part);
      if (computed) return { key: computed[1], computed: true };
      const named = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][A-Za-z0-9_$]*))\\s*(?::|$)/.exec(part);
      return named ? { key: named[1] ?? named[2] ?? named[3], computed: false } : null;
    })
    .filter(Boolean);
}

function labelKeyFindings(line, rule) {
  const found = [];
  for (const match of line.matchAll(new RegExp(rule.pattern, 'g'))) {
    // El objeto de etiquetas es el grupo que casó (una regla puede tener varias formas).
    const body = match.slice(1).find((group) => group != null) ?? '';
    const keys = rule.listOfStrings ? [...body.matchAll(/['"]([^'"]+)['"]/g)].map((m) => ({ key: m[1], computed: false })) : keysOf(body);
    for (const { key, computed } of keys) {
      const ok = computed ? ALLOWED_KEYS.has(key) : ALLOWED_KEYS.has(key);
      if (!ok) found.push(key);
    }
  }
  return found;
}

let findings = 0;
const detail = [];
for (const file of files('src')) {
  const lines = code(readFileSync(file, 'utf8'));
  for (const rule of RULES) {
    if (rule.paths && !rule.paths.some((prefix) => file.startsWith(prefix))) continue;
    if (rule.exclude && rule.exclude.includes(file)) continue;
    const hits = [];
    lines.forEach((line, index) => {
      if (rule.check === 'labelKeys') {
        const keys = labelKeyFindings(line, rule);
        if (keys.length > 0) hits.push('      ' + (index + 1) + ': ' + line.trim() + '   ← ' + keys.join(', '));
      } else if (new RegExp(rule.pattern).test(line)) {
        hits.push('      ' + (index + 1) + ': ' + line.trim());
      }
    });
    if (hits.length > 0) {
      findings += 1;
      detail.push('  [' + rule.id + '] ' + file + ': ' + rule.why, ...hits);
    }
  }
}

console.log('');
console.log(${JSON.stringify(title)});
console.log('  ' + ${JSON.stringify(label)}.padEnd(20) + ' ' + (findings === 0 ? 'OK' : 'KO'));
if (findings > 0) {
  console.log('');
  console.log('HALLAZGOS (' + findings + ')');
  for (const line of detail) console.log(line);
  console.log('');
  console.log(${JSON.stringify(footer)});
  process.exit(1);
}
KEEL_GATE`;
}
