// El tramo que no estaba garantizado por construcción.
//
// De los cinco mecanismos de repetición y compensación, `build` genera tres enteros
// (`idempotency_record` con su store, `processed_event` con su guard, la
// `OutboundIdempotency` ya cableada) y deja el USO de los dos primeros al agente de
// código: el listener que llama al guard, el handler que consulta el store. Los otros
// dos —compensación y reconciliación— no generan ninguna clase: son lógica de negocio
// y salen enteros de la mano del agente.
//
// Ese tramo falla en silencio. Un listener sin guard, un handler que ignora el store, un
// `@Scheduled` que sigue lanzando: todo compila, todo arranca, y el camino feliz pasa en
// verde. Solo se nota en la primera repetición — que es justo cuando algo ya iba mal.
//
// Hasta ahora la red era prosa que leía un LLM (la sección homónima de
// `keel-spring-quality.md`). Este script la convierte en un gate determinista: `build`
// sabe qué listener toca qué orden, qué handler tiene qué `keySource` y qué operación
// barre qué activación, así que la matriz de expectativas se precomputa aquí y el script
// solo la contrasta contra el árbol final.
//
// Alcance deliberado: son comprobaciones ESTRUCTURALES, no análisis semántico. Cazan la
// ausencia (no se llama al guard) y el cruce (se llama en el orden que pierde mensajes),
// que es donde esto falla de verdad. Si el algoritmo del barrido es el correcto sigue
// siendo juicio, y ese lo pone el agente de calidad — que ahora ejecuta esto en vez de
// leer el árbol a mano.

import { declaresIdempotency, idempotentOperations } from './http-idempotency.js';
import { usesOutbox } from './outbox.js';

/**
 * ¿Hay algo de esta familia que comprobar? Sin suscripciones, sin idempotencia HTTP, sin
 * outbox y sin compensaciones ni reconciliaciones no hay tramo que vigilar y el script no
 * se genera: un gate que siempre sale verde no distingue «correcto» de «no mira».
 */
export function usesIdempotencyCheck(model) {
  return checksOf(model).length > 0;
}

export function generate(model) {
  const checks = checksOf(model);
  if (checks.length === 0) return [];
  return [{ path: 'infra/check-idempotency.sh', content: script(model, checks) }];
}

// ─── La matriz de expectativas ───────────────────────────────────────────────
//
// Cada entrada es { group, subject, class, require[], forbid[], why }. `class` es el
// nombre simple del archivo Java: el script lo localiza con `find`, no con una ruta
// hardcodeada, porque el agente escribe algunos de esos archivos y la ruta exacta es
// suya. `require`/`forbid` son expresiones regulares extendidas (grep -E).

function checksOf(model) {
  return [...dedupeChecks(model), ...commandChecks(model), ...compensationChecks(model), ...reconciliationChecks(model), ...outboxChecks(model)];
}

// 1. Consumo de mensajes. Las dos mitades —llamar al guard y ACTUAR sobre lo que
//    responde— más el orden, que no es intercambiable ni es cosa del agente: lo
//    prescribe el javadoc del <Evento>Message y lo decide `triggerHasDomainGuard`.
function dedupeChecks(model) {
  if (!model.layersPresent.messaging || !model.layersPresent.persistence) return [];
  return (model.subscriptions ?? []).map((sub) => {
    const guarded = sub.triggerHasDomainGuard;
    return {
      group: 'dedupe',
      subject: sub.name,
      class: sub.listenerClass,
      require: [
        'IdempotencyGuard',
        // Referenciar el guard sin mirar su respuesta no deduplica nada: el retorno
        // tiene que gobernar una rama o salir por un return.
        `(if|return|while|&&|\\|\\||!)[^;]*\\.?(alreadyProcessed|tryRecord)\\s*\\(`,
        guarded ? '\\.record\\s*\\(' : '\\.tryRecord\\s*\\('
      ],
      forbid: [
        // El cruce caro. `tryRecord` en un handler reintentable marca como procesado
        // un mensaje que falló y lo pierde; `alreadyProcessed`+`record` sin guarda de
        // dominio deja abierta la ventana entera entre las dos llamadas.
        guarded ? '\\.tryRecord\\s*\\(' : '\\.alreadyProcessed\\s*\\(',
        // Una clave inventada compila, pasa el camino feliz y deduplica cero.
        'UUID\\.randomUUID\\(\\)'
      ],
      why: guarded
        ? `'${sub.trigger}' declara transitions: alreadyProcessed(...) antes y record(...) DESPUÉS de despachar bien`
        : `'${sub.trigger}' no declara transitions: tryRecord(...) antes de despachar, que es lo único que cierra la ventana`
    };
  });
}

// 2. Idempotencia de petición. El mecanismo está generado entero: lo que se comprueba
//    es que el handler lo USE, y que no se haya escrito otro al lado.
function commandChecks(model) {
  if (!declaresIdempotency(model) || !model.layersPresent.persistence) return [];
  return idempotentOperations(model).map((operation) => ({
    group: 'commandIdempotency',
    subject: operation.name,
    class: operation.handlerClass,
    require: ['IdempotencyStore', 'CommandSignature\\.of\\s*\\('],
    forbid: [
      // Una firma escrita a mano se compara contra firmas guardadas en otro
      // despliegue, y hashCode() ni siquiera es estable entre arranques.
      '\\.hashCode\\(\\)',
      // Con payload-hash la clave ES la firma: no hay cabecera, no hay contexto y no
      // hay caso «sin clave». Ese `if` es el defecto que hace que no deduplique nunca.
      ...(operation.idempotency.keySource === 'payload-hash' ? ['IdempotencyContext'] : [])
    ],
    why:
      operation.idempotency.keySource === 'payload-hash'
        ? 'keySource: payload-hash — la clave es CommandSignature.of(command), sin IdempotencyContext ni rama «sin clave»'
        : 'keySource: client-key — la clave llega por IdempotencyContext.get() y la firma por CommandSignature.of(command)'
  }));
}

// Las operaciones cuelgan de su servicio (un agregado, un servicio de aplicación), no
// del modelo: aplanarlas aquí evita repetir el doble bucle en cada familia.
const allOperations = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []);

// 3. Compensación. No hay clase que comprobar porque build no genera ninguna: lo que se
//    comprueba es que el handler que la ejecuta esté escrito y llegue al proveedor.
function compensationChecks(model) {
  const checks = [];
  for (const operation of allOperations(model)) {
    if (!operation.compensates) continue;
    const client = returnClientOf(model, operation);
    checks.push({
      group: 'compensation',
      subject: operation.name,
      class: operation.handlerClass,
      require: client ? [client] : [],
      // Deshacer a medias es peor que no deshacer: deja el proveedor y el estado
      // propio contando historias distintas. Un solo patrón, no dos: el stub de build
      // trae las dos marcas a la vez y separarlas contaría dos veces el mismo hecho.
      forbid: ['TODO|UnsupportedOperationException'],
      why: client
        ? `compensa ${operation.compensates.dependency}: además de devolver el estado propio tiene que avisar al proveedor por ${client}, que se le inyecta para eso`
        : `compensa ${operation.compensates.dependency}: el diseño no declara activación de vuelta, así que solo devuelve el estado propio`
    });
  }
  return checks;
}

// El cliente de la activación de vuelta: se inyecta en el handler por el mismo criterio
// que el resto (`triggeredBy` es el único enlace del DSL), así que si está inyectado y no
// aparece en el cuerpo, la mitad de la compensación que vive fuera no se hizo.
function returnClientOf(model, operation) {
  for (const { activation } of operation.dependencyActivations ?? []) {
    if (activation.http?.clientClass) return activation.http.clientClass;
  }
  return null;
}

// 4. Reconciliación. La pata del silencio, y la única que ningún escenario FL-* puede
//    ejercitar: el arnés es caja negra y un cron no se alcanza desde fuera. Sin esto no
//    la mira nadie.
function reconciliationChecks(model) {
  const checks = [];
  const schedulers = new Set();
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (!(operation.reconciles ?? []).length) continue;
      // El @Scheduled que la dispara vive en el scheduler de SU servicio, no en uno
      // global: dos agregados con barrido son dos clases distintas.
      schedulers.add(service.className.replace(/Service$/, 'Scheduler'));
    }
  }
  for (const operation of allOperations(model)) {
    if (!(operation.reconciles ?? []).length) continue;
    checks.push({
      group: 'reconciliation',
      subject: operation.name,
      class: operation.handlerClass,
      // El umbral de «demasiado tiempo» no lo declara el diseño: sale de parameters/,
      // nunca de una constante. Es la instrucción concreta de la nota del stub.
      require: ['@Value'],
      forbid: ['TODO|UnsupportedOperationException'],
      why: `barre ${operation.reconciles.map((r) => `${r.dependency}.${r.activation.name}`).join(', ')}: el umbral sale de parameters/ con @Value, no de una constante`
    });
  }
  for (const scheduler of schedulers) {
    checks.push({
      group: 'reconciliation',
      subject: scheduler,
      class: scheduler,
      require: ['@Scheduled'],
      // build lo deja lanzando cuando el mensaje necesita argumentos. Si sigue ahí, el
      // barrido no corre nunca y nada más lo delata.
      forbid: ['UnsupportedOperationException'],
      why: 'el disparador del barrido: build lo deja lanzando cuando el mensaje lleva argumentos'
    });
  }
  return checks;
}

// 5. Entrega del outbox. El stub NO lanza a propósito (el relay contaría el intento como
//    fallo), así que su precio es que marca como publicadas filas que nunca salieron. El
//    fail-fast del arranque cubre los perfiles de verdad; esto lo cubre antes de arrancar.
function outboxChecks(model) {
  if (!usesOutbox(model)) return [];
  return [
    {
      group: 'outboxDelivery',
      subject: 'OutboxDispatcher',
      implementors: 'OutboxDispatcher',
      exclude: 'OutboxDispatcherFallbackConfig',
      why: 'con reliability: outbox el diseño prometió que ningún evento se pierde; con solo el fallback se pierden todos sin un solo error'
    }
  ];
}

// ─── El script ───────────────────────────────────────────────────────────────

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function script(model, checks) {
  const rows = checks.map((check) => {
    if (check.implementors) {
      return `impl ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.implementors)} ${shellQuote(check.exclude)} ${shellQuote(check.why)}`;
    }
    const require = (check.require ?? []).join('\u0001');
    const forbid = (check.forbid ?? []).join('\u0001');
    return `unit ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.class)} ${shellQuote(require)} ${shellQuote(forbid)} ${shellQuote(check.why)}`;
  });

  const groups = [...new Set(checks.map((check) => check.group))];

  return `#!/usr/bin/env bash
# check-idempotency.sh — comprueba que el código escrito por el agente USE los
# mecanismos de repetición y compensación que build generó para ${model.service.name}.
#
# Build genera los mecanismos; quien los usa es el agente. Ese es el único tramo de la
# cadena que no está garantizado por construcción, y falla en silencio: un listener sin
# guard o un handler que ignora el IdempotencyStore funcionan perfectamente hasta la
# primera repetición. La matriz de abajo la precomputó build desde el diseño.
#
# Son comprobaciones ESTRUCTURALES (presencia, ausencia y orden), no análisis semántico:
# cazan el hueco y el cruce, no si el algoritmo es correcto. Eso último lo juzga el
# agente de calidad, que ejecuta este script en vez de leer el árbol a mano.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-idempotency.sh
#
# Salida: un veredicto por familia (${groups.join(', ')}) y el detalle de lo que falta.
# Código de salida:
#   0  todas las familias en OK
#   1  hay hallazgos → van a 'remaining' del reporte y vuelven al agente de código
set -u

SRC="src/main/java"

if [ ! -d "$SRC" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró $SRC)." >&2
  exit 1
fi

findings=0
detail=""
${groups.map((group) => `${group}_ko=0`).join('\n')}

note() {  # familia, texto
  detail="$detail  [$1] $2\\n"
  findings=$((findings + 1))
  case "$1" in
${groups.map((group) => `    ${group}) ${group}_ko=1 ;;`).join('\n')}
  esac
}

# El archivo se busca por nombre, no por ruta: algunos los escribe el agente y dónde
# los ponga es suyo (la frontera hexagonal la vigila conventions/project-layout.md).
locate() {
  find "$SRC" -name "$1.java" -type f 2>/dev/null | head -n 1
}

# Una unidad de comprobación: un archivo, lo que tiene que aparecer y lo que no.
unit() {  # familia, sujeto, clase, requeridos (\\001), prohibidos (\\001), porqué
  local group="$1" subject="$2" class="$3" required="$4" forbidden="$5" why="$6"
  local file
  file="$(locate "$class")"
  if [ -z "$file" ]; then
    note "$group" "$subject: no existe $class.java — $why"
    return
  fi
  # Los comentarios no cuentan: un TODO tachado dentro de un bloque de javadoc que
  # explica lo que HAY que hacer no es lo mismo que un TODO vivo en el cuerpo. Se
  # miran las líneas de código, no la prosa que build dejó de guía.
  local code
  code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file")"
  local pattern
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    printf '%s' "$code" | grep -qE -- "$pattern" \\
      || note "$group" "$subject ($class): falta '$pattern' — $why"
  done <<EOF
$(printf '%s' "$required" | tr '\\001' '\\n')
EOF
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    printf '%s' "$code" | grep -qE -- "$pattern" \\
      && note "$group" "$subject ($class): NO debe aparecer '$pattern' — $why"
  done <<EOF
$(printf '%s' "$forbidden" | tr '\\001' '\\n')
EOF
}

# Que exista una implementación de un puerto distinta del fallback que generó build.
impl() {  # familia, sujeto, interfaz, clase excluida, porqué
  local group="$1" subject="$2" iface="$3" excluded="$4" why="$5"
  local found
  found="$(grep -rlE "implements[^{]*\\\\b$iface\\\\b|$iface[[:space:]]*\\\\(" "$SRC" 2>/dev/null \\
           | grep -v "/$excluded.java" | head -n 1)"
  [ -n "$found" ] || note "$group" "$subject: solo está el fallback $excluded — $why"
}

${rows.join('\n')}

echo ""
echo "IDEMPOTENCIA Y COMPENSACIÓN"
${groups
  .map(
    (group) =>
      `if [ "$${group}_ko" -eq 0 ]; then echo "  ${group.padEnd(20)} OK"; else echo "  ${group.padEnd(20)} KO"; fi`
  )
  .join('\n')}

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  exit 1
fi

exit 0
`;
}
