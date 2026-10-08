// El arnés de integración sobre MongoDB (incremento 12d): lo que en la rama relacional hace `db()` con una
// sentencia SQL, aquí lo hace `mongoEval()` con un script de mongosh, y con él los ayudantes que fabrican las
// precondiciones que ninguna operación del diseño produce —la fila atascada de un rescate, la marca de espera
// envejecida de una reconciliación—. Los mismos nombres que el AbstractFlowIT de keel-spring, y los MISMOS
// scripts: salen de keel-core/gen/mongo-probes.js, la fuente que comparte con él (y que mide su mongo-check).
//
// Dos trampas que esa fuente ya documenta y que aquí se respetan tal cual:
//   · el script viaja por ARCHIVO dentro del contenedor, no por `--eval`: en Windows el cliente de
//     contenedores se come las comillas de un argumento, y mongosh recibe `db.getCollection(x)`;
//   · ejecutado por archivo, mongosh NO imprime el valor de la última expresión: sin el envoltorio
//     `print(...)` un countDocuments devuelve cadena vacía, y la cadena vacía se parece a un cero.

import { DATABASES } from 'keel-core/gen/infra-catalog';
import { PRINT_WRAPPER, CLOCK, setStateScript, ageClockScript, missingClockCountScript } from 'keel-core/gen/mongo-probes';
import { rescueProbes } from 'keel-core/gen';
import { documentShape } from 'keel-core/gen/document';
import { tsString } from './render.js';
import { usesDocument } from './persistence-entities.js';

/** La base documental de prueba como contenedor al que se le pueden mandar scripts. */
export function documentProbe(model) {
  if (!usesDocument(model)) return null;
  const entry = DATABASES.mongodb;
  if (!entry?.cliQueryArgv) return null;
  const dbName = model.service.name.replaceAll('-', '_');
  return {
    container: `${model.service.name}-db`,
    // El argv SIN `--eval`: mongosh acepta en su lugar un archivo de script, que es la única forma de que un
    // script con comillas llegue intacto.
    argv: entry.cliQueryArgv({ user: entry.user(dbName), pass: entry.password, db: dbName }).filter((part) => part !== '--eval'),
    label: entry.label
  };
}

/** Las marcas de espera que envejece `ageForReconciliation`, por activación, con su clave del documento. */
function agingTargets(model) {
  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        const entity = (model.entities ?? []).find((candidate) => candidate.name === target.entity) ?? null;
        if (!entity?.collectionName || !target.awaitingField) continue;
        const clockField = documentShape(model, entity).find((entry) => entry.member === target.awaitingField)?.name;
        if (!clockField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push({ collection: entity.collectionName, clockField });
      }
    }
  }
  // El barrido de la capa payments: su condición de entrada es la marca de espera del cobro, rancia, y la clave es el
  // nombre del barrido. Como en keel-spring.
  const payments = model.payments;
  if (payments?.reconciliation?.sweep && payments.record?.awaitingSince) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === payments.record.entity);
    const clockField = entity?.collectionName ? documentShape(model, entity).find((entry) => entry.member === payments.record.awaitingSince)?.name : null;
    if (clockField) {
      if (!targets.has(payments.reconciliation.sweep)) targets.set(payments.reconciliation.sweep, []);
      targets.get(payments.reconciliation.sweep).push({ collection: entity.collectionName, clockField });
    }
  }
  return targets;
}

/** La sección de flow.ts sobre documentos: `mongoEval`, el rescate y la reconciliación. */
export function documentHarnessSection(model) {
  const probe = documentProbe(model);
  if (!probe) return '';
  return `
const DB_CONTAINER = ${tsString(probe.container)};
const DB_SCRIPT_ARGV: readonly string[] = ${JSON.stringify(probe.argv)};
/** Dónde se deja el script dentro del contenedor de la base. */
const DB_SCRIPT = '/tmp/keel-eval.js';

/**
 * Ejecuta un script de mongosh contra la base de prueba (${probe.label}) y devuelve su salida en crudo.
 *
 * Es para lo que no se ve por HTTP: que una escritura llegó de verdad al almacén, o la precondición de un
 * escenario que ninguna operación del diseño puede fabricar. No es la vía por defecto: si el servicio lo
 * expone por su API, se comprueba por ahí. Los nombres son los del DOCUMENTO (snake_case, \`_id\`), y un id
 * va como \`UUID("…")\`: un literal que no case deja el script en cero modificados SIN fallar.
 *
 *   const salida = mongoEval('db.getCollection("jobs").countDocuments({ status: "QUEUED" })');
 *
 * El script viaja por ARCHIVO (el argv se come las comillas en Windows) y va envuelto en un print(...):
 * ejecutado por archivo, mongosh no imprime el valor de la última expresión, y sin él un countDocuments
 * devolvería cadena vacía, que se parece a un cero.
 */
export function mongoEval(script: string): string {
  const printed = ${tsString(PRINT_WRAPPER.prefix)} + script + ${tsString(PRINT_WRAPPER.suffix)};
  run(containerRuntime(), ['exec', '-i', DB_CONTAINER, 'sh', '-c', \`cat > \${DB_SCRIPT}\`], '¿Está la base arriba (bash infra/up.sh)?', printed);
  return run(containerRuntime(), ['exec', DB_CONTAINER, ...DB_SCRIPT_ARGV, DB_SCRIPT], '¿Está la base arriba (bash infra/up.sh)?');
}

/** Un id de documento para un script: valida la forma antes de meterlo dentro de \`UUID("…")\`. */
function documentId(id: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(\`No es un id: '\${id}'\`);
  return id;
}
${rescueSection(model)}${agingSection(model)}`;
}

/**
 * El rescate de cada barrido que lo tiene, sobre documentos: los mismos tres ayudantes que la rama relacional y
 * que keel-spring (stallInFlight, putInFlight, inFlightWithoutClock), con los scripts de setStateScript y
 * missingClockCountScript. El reloj «rancio» es la época y el de «ahora», el instante de la escritura: la
 * diferencia es lo que separa rescatar de robarle el trabajo a quien lo está haciendo.
 */
function rescueSection(model) {
  const probes = rescueProbes(model);
  if (probes.length === 0) return '';
  const rows = probes
    .map((probe) => {
      const shape = { collection: probe.table, stateField: probe.stateColumn, state: probe.state, clockField: probe.clockColumn };
      const stall = setStateScript({ ...shape, clock: CLOCK.stale });
      const put = setStateScript({ ...shape, clock: CLOCK.now });
      return `  ${tsString(probe.operation)}: {
    stall: [${tsString(stall.prefix)}, ${tsString(stall.suffix)}],
    put: [${tsString(put.prefix)}, ${tsString(put.suffix)}],
    missing: ${tsString(missingClockCountScript(shape))}
  }`;
    })
    .join(',\n');
  const known = probes.map((probe) => probe.operation).join(', ');
  return `
/** Los scripts del rescate de cada barrido que lo tiene: ${known}. */
const RESCUES: Readonly<Record<string, { readonly stall: readonly [string, string]; readonly put: readonly [string, string]; readonly missing: string }>> = {
${rows}
};

function rescueOf(operation: string): { readonly stall: readonly [string, string]; readonly put: readonly [string, string]; readonly missing: string } {
  const rescue = RESCUES[operation];
  if (rescue == null) throw new Error(\`No hay rescate para el barrido '\${operation}'. Los que lo tienen: ${known}\`);
  return rescue;
}

/**
 * Deja el documento \`id\` EN VUELO con el reloj infinitamente rancio: el estado exacto en el que queda una
 * réplica que murió con él en la mano, que es lo que el rescate busca. No dispara el barrido —lo dispara su
 * cron— y no siembra el documento: mueve uno creado por la API.
 */
export function stallInFlight(operation: string, id: string): void {
  const [prefix, suffix] = rescueOf(operation).stall;
  mongoEval(prefix + documentId(id) + suffix);
}

/**
 * Lo mismo con el reloj a AHORA: acaba de entrar en vuelo y hay alguien trabajando en él. Un rescate sin cota
 * temporal pasa el escenario del rescate y falla aquí.
 */
export function putInFlight(operation: string, id: string): void {
  const [prefix, suffix] = rescueOf(operation).put;
  mongoEval(prefix + documentId(id) + suffix);
}

/** Cuántos quedaron EN VUELO sin reloj. Tiene que valer cero siempre. Vacío NO es cero: es un fallo del transporte. */
export function inFlightWithoutClock(operation: string): number {
  const output = mongoEval(rescueOf(operation).missing).trim();
  const count = Number(output.split(/\\s+/).pop());
  if (output === '' || !Number.isInteger(count)) throw new Error(\`La cuenta de documentos sin reloj no es un número: '\${output}'\`);
  return count;
}
`;
}

/** `ageForReconciliation` sobre documentos: envejece SOLO la marca de espera de ese documento. */
function agingSection(model) {
  const targets = agingTargets(model);
  if (targets.size === 0) return '';
  const known = [...targets.keys()].join(', ');
  const rows = [...targets]
    .map(([name, list]) => {
      const scripts = list.map((target) => {
        const script = ageClockScript(target);
        return `[${tsString(script.prefix)}, ${tsString(script.suffix)}]`;
      });
      return `  ${tsString(name)}: [${scripts.join(', ')}]`;
    })
    .join(',\n');
  return `
/** Las marcas de espera que envejece \`ageForReconciliation\`, por activación: ${known}. */
const RECONCILIATION_AGING: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
${rows}
};

/**
 * Deja la marca de espera de \`activation\` infinitamente rancia para el documento \`id\`, de modo que el barrido
 * lo tome en SU PRÓXIMA PASADA. No dispara el barrido —lo dispara su cron—, y no toca el estado: el documento
 * ya está donde el barrido lo busca. Bajar el umbral por configuración sería global.
 *
 *   ageForReconciliation(${tsString([...targets.keys()][0])}, id);
 *   await eventually(async () => (await flow.get(\`\${ROUTE_BASE}/…/\${id}\`)).json().status === '…', 90_000);
 */
export function ageForReconciliation(activation: string, id: string): void {
  const scripts = RECONCILIATION_AGING[activation];
  if (scripts == null) throw new Error(\`No hay barrido para la activación '\${activation}'. Las que lo tienen: ${known}\`);
  for (const [prefix, suffix] of scripts) mongoEval(prefix + documentId(id) + suffix);
}
`;
}
