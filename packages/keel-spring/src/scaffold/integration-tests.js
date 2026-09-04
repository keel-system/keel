// Andamiaje del source set integrationTest: la base de la que heredan las clases
// de flujo (<Flow>FlowIT) que escribe el agente keel-spring-tests a partir de
// specs/validation-scenarios.md, y el TestWatcher que vuelca la evidencia de cada
// fallo para que arbitrarlo no pierda información frente al curl a mano.
//
// Aquí NO se genera ninguna clase de flujo: eso es derivado del diseño y lo
// escribe el agente. Lo que build aporta es lo transversal al stack: arranque del
// servidor, cliente HTTP, reset de estado, credenciales y sondeo del broker.
//
// Caja negra por construcción: build.gradle deja src/main/java fuera del
// compileClasspath de este source set, así que nada de lo que se genera aquí
// puede importar una clase del servicio.

import { javaFile, javaPath } from './render.js';
import { mailSection, hasMail, MAIL_IMPORTS } from './mail-harness.js';
import { pascalCase, snakeCase, screamingSnake } from '../lib/naming.js';
import { DATABASES, BROKERS, CACHES, selectedInfra, brokerContainer } from '../lib/stack-catalog.js';
import { cacheFlushCmd, concreteCmd, needsDevtools } from './devtools.js';
import { outboxRelayBeanName, usesOutbox } from './outbox.js';
import {
  deadLetterDestination,
  deadLetterSubscriptions,
  publishedDestination,
  subscriptionDestination,
  usesDeadLetter
} from '../lib/dead-letter.js';
import { needsMessagingProvisioning } from './messaging-provisioning.js';
import {
  setStateScript,
  ageClockScript,
  missingClockCountScript,
  outboxPendingScript,
  abandonOutboxScript,
  clearAbandonedScript,
  CLOCK
} from '../lib/mongo-probes.js';
import { tokenUrl, userTestClient } from './auth-provisioning.js';
// La forma de la tabla y el SQL con el que el arnés fabrica la precondición del rescate:
// fuente única con scripts/claim-check.js, que ejecuta AMBOS contra el motor junto al reclamo
// que los lee. Copiar la derivación en vez de compartirla hacía que el check midiera su propia
// copia — se vio rompiendo esto a propósito y viendo el check seguir en verde.
import { stallSql, missingClockCountSql, rescueShape } from '../lib/claim-probes.js';
import { declaresIdempotency } from './http-idempotency.js';
// Fuente única de los comandos de broker: lo que se emite aquí es lo mismo que
// `scripts/broker-check.js` ejecuta contra los brokers reales.
import {
  ENDPOINTS,
  deliverParts,
  deliverShell,
  collapseToSingleLineJava,
  emptyReadJava,
  emptyReadValue,
  expr,
  READ_BATCH_LIMIT,
  READ_DEDUPE_KEY,
  readAttemptLimit,
  javaArgs,
  offsetsParts,
  prefix,
  purgeParts,
  rabbitProbeBodyJava,
  rabbitPublishBodyJava,
  readParts,
  releaseParts,
  SQS_SWEEP_VISIBILITY,
  shellQuote,
  UNKNOWN_TOPIC
} from '../lib/broker-probes.js';

// El reset por script existe con las mismas condiciones con las que docker.js lo
// genera: una BD con cliResetCmd, una caché que vaciar, o destinos de mensajería
// que purgar. Sin script (H2 en memoria y nada más) el aislamiento entre clases de
// flujo lo da @DirtiesContext.
function hasResetScript(model) {
  const { layersPresent, stack } = model;
  const db = layersPresent.persistence && stack.database ? DATABASES[stack.database] : null;
  // El stub de proveedores cuenta: sus mappings y su log de peticiones son estado
  // sucio igual que una fila, y devtools.js ya los reinicia desde el script.
  return Boolean(db?.cliResetCmd || stack.cache || purgeableChannels(model).length > 0 || layersPresent.httpClients);
}

// El aislamiento de la BD entre clases de flujo lo da @DirtiesContext cuando la BD
// no se puede vaciar por CLI (H2 en memoria). Es independiente de que exista el
// script: con H2 + un broker purgable, el script existe pero no toca la BD.
function needsDirtiesContext({ layersPresent, stack }) {
  if (!layersPresent.persistence) return false;
  const db = stack.database ? DATABASES[stack.database] : null;
  return !db?.cliResetCmd;
}

// Destinos que el script puede purgar: los canales del diseño, si el broker
// elegido tiene primitiva de purga (Kafka no: se aísla por marca de offset).
function purgeableChannels(model) {
  const broker = brokerEntry(model);
  if (!broker?.cliPurgeCmd) return [];
  return channels(model);
}

function channels(model) {
  return model.messaging?.channels ?? [];
}

function brokerEntry(model) {
  if (!model.layersPresent.messaging || !model.stack.broker) return null;
  return BROKERS[model.stack.broker] ?? null;
}

// ¿Hay contenedor devtools al que hablar? Misma condición que usa docker.js para
// añadirlo al compose: sin él no se genera nada de sondeo.
function usesDevtools(model) {
  return needsDevtools(selectedInfra(model));
}

// ¿Hay contenedor de BD al que hablar? Sin serviceKey no hay servicio en el compose
// (H2 vive dentro de la JVM), y entonces no hay nada que sondear por CLI.
function dbEntry(model) {
  if (!model.layersPresent.persistence || !model.stack.database) return null;
  const entry = DATABASES[model.stack.database];
  return entry?.serviceKey ? entry : null;
}

// Misma regla que devtools.js aplica en validate-infra.sh y reset-db.sh: la CLI de
// Mongo y de Oracle no está en el toolbox, sino dentro del contenedor de la BD.
function dbContainer(model) {
  const entry = dbEntry(model);
  if (!entry) return null;
  return entry.cliVia === 'dbcontainer' ? `${model.service.name}-db` : `${model.service.name}-devtools`;
}

// El motor de ejecución en contenedor hace falta para cualquiera de las dos vías.
function usesContainerExec(model) {
  return usesDevtools(model) || Boolean(dbEntry(model));
}

// Literal de cadena Java a partir de un comando del catálogo (que puede llevar
// comillas simples y barras).
function javaString(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// El arnés manda la cabecera si el diseño la declara, tenga o no persistencia
// donde registrarla: el predicado es el mismo que gobierna el scaffolding del
// store, importado de allí para que no haya dos lecturas del mismo campo.
const hasIdempotency = declaresIdempotency;

function hasMultipart(model) {
  return Boolean(model.hasFileUploads || model.layersPresent.storage);
}

function tokenProtocol(model) {
  const protocol = model.security?.protocol ?? 'none';
  return protocol === 'oidc' || protocol === 'jwt';
}

// ¿El diseño declara política CORS? Es lo que enciende los dos únicos helpers del
// arnés que mandan cabeceras de petición propias. Se gatea por el bloque declarado
// —igual que `exchangeWithKey` se gatea por `idempotency`— porque un preflight
// contra un servicio sin política CORS prueba una promesa que nadie hizo.
function hasCors(model) {
  return Boolean(model.security?.cors);
}

export function generate(model) {
  const pkg = `${model.service.basePackage}.flows`;
  return [
    {
      path: javaPath(model, 'flows', 'AbstractFlowIT', 'integrationTest'),
      content: javaFile(pkg, abstractImports(model), abstractBody(model))
    },
    {
      path: javaPath(model, 'flows', 'FailureCapture', 'integrationTest'),
      content: javaFile(pkg, failureCaptureImports(), failureCaptureBody())
    },
    {
      path: javaPath(model, 'flows', 'HarnessSmokeIT', 'integrationTest'),
      content: javaFile(pkg, smokeImports(model), smokeBody(model))
    },
    { path: 'infra/score-scenarios.sh', content: scoreScenariosScript(model) },
    { path: 'infra/check-test-idioms.sh', content: testIdiomsScript() }
  ];
}

// ─── check-test-idioms.sh ────────────────────────────────────────────────────
//
// El gate de un defecto que COMPILA y revienta en runtime, así que ni `compile-check` ni
// `compileIntegrationTestJava` lo ven: anidar una extracción de JSON dentro de una llamada
// con sobrecargas. `javac` elige la sobrecarga por el tipo estático y mete un `checkcast`
// —`String.valueOf(char[])` gana a `String.valueOf(Object)`— que salta como
// `ClassCastException: String cannot be cast to [C` cuando el escenario ya está corriendo.
//
// Existe porque la prosa ya falló. `conventions/integration-tests.md` documenta este caso
// EXACTO, con ejemplo MAL y BIEN, y aun así se coló en la quinta corrida y costó un ciclo de
// arbitraje. Cuando una regla escrita se incumple, lo que falta no es repetirla: es poder
// comprobarla. Mismo criterio que las familias de `check-idempotency.sh`.
function testIdiomsScript() {
  return `#!/usr/bin/env bash
# check-test-idioms.sh — idiomas de las pruebas de integración que no se ven al compilar.
#
# Sale 1 si encuentra algo. Lo ejecuta el agente de pruebas al cerrar, junto a
# ./gradlew compileIntegrationTestJava: ese compila, y esto mira lo que compilar no juzga.
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/integrationTest"
[ -d "$SRC" ] || { echo "No hay src/integrationTest: nada que revisar."; exit 0; }

found=0

# Los comentarios se borran ANTES de mirar: el propio ejemplo «MAL» de la convención, pegado
# en un comentario, haría de coartada o de falso positivo según el día.
strip() { sed -e 's://.*::' "$1"; }

while IFS= read -r -d '' file; do
  # Extracción anidada dentro de una llamada que tiene sobrecargas. La regla de la convención
  # es una sola: captura primero en una variable, usa después.
  hits="$(strip "$file" | grep -nE '(String\\.valueOf|\\.formatted|List\\.of|Map\\.of)\\([^)]*(jsonPath|JsonPath\\.read)\\(' || true)"
  if [ -n "$hits" ]; then
    found=1
    echo "[sobrecarga] \${file#"$ROOT/"}"
    echo "$hits" | sed 's/^/    /'
  fi
done < <(find "$SRC" -name '*.java' -print0)

if [ "$found" -ne 0 ]; then
  cat <<'AYUDA'

Una extracción de JSON anidada dentro de una llamada con sobrecargas deja que javac resuelva
la sobrecarga por el tipo estático e inserte un cast que revienta en RUNTIME
(ClassCastException: String cannot be cast to [C). Compila, así que no lo ve ningún gate de
compilación — por eso existe este.

  MAL:  String sku = String.valueOf(JsonPath.read(payload, "$.data.sku"));
  BIEN: Object raw = JsonPath.read(payload, "$.data.sku");
        String sku = String.valueOf(raw);

La regla y el porqué, en docs/keel/conventions/integration-tests.md.
AYUDA
  exit 1
fi

echo "Idiomas de las pruebas: OK."
`;
}

// ─── score-scenarios.sh ──────────────────────────────────────────────────────
//
// Puntuación MECÁNICA de la matriz de escenarios: ejecutar la suite y derivar
// «FL-x → OK | FALLO | NO_EJERCITADO» del XML de JUnit no requiere criterio, es
// parsear. Sacarlo del agente de validación deja a este con lo único
// irreducible —arbitrar de quién es la culpa de cada fallo— y hace que una
// generación en verde no cueste ninguna sesión de agente.
//
// Vive en infra/ como los demás scripts que necesitan la infraestructura arriba
// (validate-infra.sh, reset-db.sh, export-schema.sh) y comparte su estilo.
//
// Requisito de diseño: lo invoca el ORQUESTADOR, que es la sesión más larga del
// pipeline. Por eso la salida de Gradle va entera a un log y por stdout solo
// sale la matriz: volcarle miles de líneas en cada vuelta del bucle de fix lo
// dejaría compactado antes de llegar a la fase de calidad. Hoy ese ruido lo
// absorbe una sesión desechable; el script tiene que conservar esa propiedad.
/**
 * El jar que arranca la segunda réplica. Solo se construye cuando el diseno tiene
 * algo que contrastar entre replicas: es medio minuto de bootJar y no se le cobra a
 * quien no lo usa. Va ANTES del humo del arnes porque `startReplica()` lo exige en
 * disco, y un jar viejo levantaria una réplica con codigo distinto del que se esta
 * puntuando -un falso verde, o peor, un falso rojo imposible de atribuir.
 */
function replicaJarStep(model) {
  if (!usesReplica(model)) return '';
  return `  # Jar ejecutable para la segunda réplica (escenarios de clúster).
  echo "Empaquetando el jar (bootJar)..."
  if ! ./gradlew bootJar --console=plain >"$LOG" 2>&1; then
    blocked_by_lock && report_locked "el empaquetado del jar"
    echo ""
    echo "HARNESS: KO - bootJar falló, la suite NO se ejecutó."
    echo "  log: $LOG"
    exit 2
  fi

`;
}

function scoreScenariosScript(model) {
  return `#!/usr/bin/env bash
# score-scenarios.sh — ejecuta las pruebas de integración de ${model.service.name} y
# puntúa los escenarios FL-* contra specs/validation-scenarios.md.
#
# La matriz sale del XML de JUnit, sin criterio de por medio: el @DisplayName de
# cada prueba lleva el id delante de los dos puntos (FL-PRD-001-A: …). Arbitrar
# de quién es la culpa de un fallo NO es trabajo de este script — para eso está
# el agente keel-spring-validate, que se invoca solo si aquí sale algo en rojo.
#
# Uso (desde la raíz del proyecto, con la infraestructura arriba):
#   bash infra/score-scenarios.sh           # humo del arnés + suite + matriz
#   bash infra/score-scenarios.sh --score   # solo re-puntúa el XML ya existente
#
# Salida: la matriz por stdout (la de Gradle va al log). Código de salida:
#   0  todos los escenarios en OK
#   1  hay FALLO o NO_EJERCITADO → hay algo que arbitrar
#   2  precondición o arnés roto Y NADA QUE ARBITRAR: la suite no se ejecutó, o cayó
#      alguna clase entera sin dejar ni un FL-* en FALLO. Si además hay escenarios en
#      FALLO, sale 1: esos se arbitran, y devolver la corrida al agente de pruebas
#      cuando el rojo es del servidor es un bucle que no converge.
#   3  ENTORNO bloqueado: otro proceso sostiene este directorio. No es un defecto de
#      nadie y no hay agente que relanzar — se resuelve y se reintenta.
#
# El 3 existe porque su síntoma se disfraza del 2. Una corrida anterior interrumpida
# (un timeout de la herramienta que la lanzó) deja vivos el proceso de Gradle y su
# Test Executor, que siguen sosteniendo un lock sobre build/. El siguiente intento
# muere al limpiar los resultados, y leído como "HARNESS: KO" manda a revisar un
# andamiaje que está perfectamente bien —o a relanzar al agente de pruebas, que no
# tiene nada que arreglar—. Distinguirlo cuesta una comprobación y ahorra el ciclo.
set -u

RESULTS="build/test-results/integrationTest"
LOG_DIR="build/keel-scenarios"
LOG="$LOG_DIR/run.log"
EVIDENCE="build/keel-failures"
SCENARIOS="specs/validation-scenarios.md"

if [ ! -f ./gradlew ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró ./gradlew)." >&2
  exit 2
fi

mkdir -p "$LOG_DIR"

# La evidencia de la corrida ANTERIOR se borra antes de empezar, y no es limpieza: un
# volcado que sobrevive a una corrida verde se lee igual que uno recién escrito. La matriz
# solo cita la ruta de los fallos de ESTA pasada, así que un volcado de hace tres
# horas junto a un 100% no informa de nada — engaña, que es peor. Mismo motivo por el que el
# log de Gradle se sobrescribe en vez de acumularse.
rm -rf "$EVIDENCE"

# ¿Lo que tumbó a Gradle fue un lock y no un defecto? Las cuatro formas en que se
# manifiesta el mismo hecho: el lock propio de Gradle, y el del sistema de archivos
# en sus dos dialectos (POSIX y Windows). Se mira el LOG y no el código de salida
# porque Gradle devuelve 1 para esto igual que para una compilación rota.
blocked_by_lock() {
  grep -qiE "Timeout waiting to lock|Device or resource busy|being used by another process|Could not delete|Unable to delete" "$LOG" 2>/dev/null
}

report_locked() {  # $1 = qué paso se quedó bloqueado
  echo ""
  echo "ENTORNO: $1 no pudo continuar — otro proceso tiene bloqueado este directorio."
  echo "  La suite NO se ejecutó, y esto NO es un defecto del arnés ni del código."
  echo ""
  echo "  Para resolverlo:"
  echo "    ./gradlew --stop            # para los daemons de este proyecto"
  echo "    jps -l | grep -i gradle     # los workers no siempre caen con --stop"
  echo "    # y termina a mano los que queden antes de reintentar"
  echo ""
  echo "  log: $LOG"
  exit 3
}

score_only=0
[ "\${1:-}" = "--score" ] && score_only=1
# Con --score la suite no se ejecuta aquí, así que no hay veredicto de Gradle que
# contradiga a la matriz: 0 es el valor correcto para ese modo.
suite_failed=0

if [ "$score_only" -eq 0 ]; then
  # Limpiar los resultados es el primer paso Y el primer detector: si el directorio
  # sigue ahí después del rm, no es un permiso —el script acaba de crear su propio
  # log al lado— sino un lock, y el único que lo sostiene es un Gradle que no murió.
  rm -rf "$RESULTS" 2>/dev/null
  if [ -d "$RESULTS" ]; then
    echo ""
    echo "ENTORNO: no se pudo limpiar $RESULTS — otro proceso lo tiene abierto."
    echo "  La suite NO se ejecutó, y esto NO es un defecto del arnés ni del código:"
    echo "  casi siempre es una corrida anterior que se interrumpió sin terminar y dejó"
    echo "  vivos su proceso de Gradle y su Test Executor."
    echo ""
    echo "  Para resolverlo:"
    echo "    ./gradlew --stop            # para los daemons de este proyecto"
    echo "    jps -l | grep -i gradle     # los workers no siempre caen con --stop"
    echo "    # y termina a mano los que queden antes de reintentar"
    echo ""
    echo "  Cuando no quede ninguno, vuelve a lanzar este script tal cual."
    exit 3
  fi
${replicaJarStep(model)}  # Humo del arnés primero: son segundos y comprueba la fontanería de la que
  # dependen TODAS las clases de flujo (reset, servidor vivo, credenciales,
  # canales, caché). En rojo no se ejecuta la suite: correrla sobre una
  # fontanería rota produce decenas de fallos que parecen de negocio y no lo
  # son, y cuesta una pasada entera descubrirlo.
  echo "Humo del arnés (HarnessSmokeIT)…"
  if ! ./gradlew integrationTest --tests '*HarnessSmokeIT' --console=plain >"$LOG" 2>&1; then
    # El lock se descarta ANTES de acusar al andamiaje: los dos matan el humo del
    # arnés en el mismo sitio, y solo uno de los dos tiene a quien relanzar.
    blocked_by_lock && report_locked "el humo del arnés"
    echo ""
    echo "HARNESS: KO — la suite NO se ejecutó."
    echo "  El defecto está en el andamiaje que generó build (AbstractFlowIT,"
    echo "  FailureCapture, HarnessSmokeIT) o falta infraestructura."
    echo "  log: $LOG"
    exit 2
  fi
  echo "Humo del arnés: OK."
  echo "Ejecutando la suite completa…"
  # El código de salida de Gradle se GUARDA, no se ignora. La matriz solo mira los
  # \`FL-*\`, así que una prueba en rojo que no sea un escenario —un caso borde que el
  # agente añadió por su cuenta— no aparecería en ninguna fila y el script diría
  # "100%" sobre una suite roja. Ver el cierre.
  ./gradlew integrationTest --console=plain >>"$LOG" 2>&1 || suite_failed=1
  # Y si lo que la tumbó a mitad fue el lock, la matriz que saldría de un XML
  # incompleto sería todo NO_EJERCITADO: un rojo que mandaría a arbitrar un fallo
  # que no existe.
  [ "$suite_failed" -eq 1 ] && blocked_by_lock && report_locked "la suite"
fi

if [ ! -d "$RESULTS" ]; then
  echo ""
  echo "No hay resultados en $RESULTS: la suite no llegó a ejecutarse."
  echo "  log: $LOG"
  exit 2
fi

# Matriz desde el XML de JUnit. Un <testcase> cuenta como FALLO si lleva dentro
# un <failure> o un <error>; el id es lo que va delante de los dos puntos del
# @DisplayName y la clase sale del atributo classname (sin el paquete).
matrix="$(awk '
  BEGIN { RS = "<testcase " }
  NR == 1 { next }
  {
    rec = $0
    close_tag = index(rec, "</testcase>")
    self_tag = index(rec, "/>")
    if (close_tag > 0 && (self_tag == 0 || close_tag < self_tag)) seg = substr(rec, 1, close_tag)
    else if (self_tag > 0) seg = substr(rec, 1, self_tag)
    else seg = rec

    name = ""; cls = ""
    if (match(seg, /name="[^"]*"/)) name = substr(seg, RSTART + 6, RLENGTH - 7)
    if (match(seg, /classname="[^"]*"/)) cls = substr(seg, RSTART + 11, RLENGTH - 12)
    if (name == "") next

    # Sin classname no es un test: es el nodo contenedor que algunos runners
    # emiten para la clase. Su @DisplayName suele empezar por el id del flujo, y
    # colarlo duplica la fila y falsea el recuento (9 escenarios donde hay 6).
    if (cls == "") next

    id = name
    if (index(id, ":") > 0) id = substr(id, 1, index(id, ":") - 1)
    gsub(/^[ \\t]+|[ \\t]+$/, "", id)
    # El id es un token, nunca una frase: un @DisplayName de clase como
    # "FL-RES-001 · alta de reserva" no es un escenario.
    if (id !~ /^FL-[A-Za-z0-9-]+$/) next

    sub(/^.*\\./, "", cls)
    if (seg ~ /<(failure|error)[ >]/) print "FALLO\\t" id "\\t" cls
    else if (seg ~ /<skipped[ \\/>]/) print "OMITIDO\\t" id "\\t" cls
    else print "OK\\t" id "\\t" cls
  }
' "$RESULTS"/*.xml 2>/dev/null | sort -k2,2)"

# Escenarios que el documento declara y ninguna clase ejercita. No son OK: son
# cobertura que falta. El cruce es por prefijo porque el documento numera el
# flujo (FL-PRD-001) y las pruebas numeran cada escenario dentro de él
# (FL-PRD-001-A).
uncovered=""
if [ -f "$SCENARIOS" ]; then
  covered="$(printf '%s\\n' "$matrix" | cut -f2)"
  for id in $(grep -oE '^#{1,6}[[:space:]]*FL-[A-Za-z0-9-]+' "$SCENARIOS" \\
              | grep -oE 'FL-[A-Za-z0-9-]+' | sort -u); do
    printf '%s\\n' "$covered" | grep -qE "^\${id}(-|$)" || uncovered="$uncovered $id"
  done
fi

echo ""
echo "MATRIZ"
printf '%s\\n' "$matrix" | while IFS="$(printf '\\t')" read -r result id cls; do
  [ -n "\${id:-}" ] || continue
  if [ "$result" = "FALLO" ]; then
    printf '  %-8s %-20s %-28s %s\\n' "$result" "$id" "$cls" "$EVIDENCE/$id.json"
  else
    printf '  %-8s %-20s %s\\n' "$result" "$id" "$cls"
  fi
done
for id in $uncovered; do
  printf '  %-8s %s\\n' "NO_EJERC" "$id"
done

ok=$(printf '%s\\n' "$matrix" | grep -c '^OK')
ko=$(printf '%s\\n' "$matrix" | grep -c '^FALLO')
sk=$(printf '%s\\n' "$matrix" | grep -c '^OMITIDO')
nc=0
for id in $uncovered; do nc=$((nc + 1)); done

# Las pruebas en rojo que NO son escenarios: la matriz solo conoce los \`FL-*\`, y un
# testcase con otro nombre no pasa por ninguna fila. El caso que más duele es el
# \`initializationError\` que JUnit sintetiza cuando revienta un @BeforeAll: la clase
# entera no llega a ejecutar ni un escenario, así que sus \`FL-*\` no aparecen en el XML
# y reaparecen abajo como NO_EJERCITADO — una etiqueta que dice "sin cobertura" cuando
# lo que hubo fue un rojo. Por eso esto es una función y se invoca en LOS DOS
# desenlaces: enterrar la causa raíz en $LOG justo cuando hay algo que enmascarar es
# exactamente lo que hacía la versión anterior, que solo la imprimía con la matriz limpia.
non_scenario_failures() {
  awk '
    BEGIN { RS = "<testcase " }
    NR == 1 { next }
    {
      rec = $0
      close_tag = index(rec, "</testcase>")
      self_tag = index(rec, "/>")
      if (close_tag > 0 && (self_tag == 0 || close_tag < self_tag)) seg = substr(rec, 1, close_tag)
      else if (self_tag > 0) seg = substr(rec, 1, self_tag)
      else seg = rec
      name = ""; cls = ""
      if (match(seg, /name="[^"]*"/)) name = substr(seg, RSTART + 6, RLENGTH - 7)
      if (match(seg, /classname="[^"]*"/)) cls = substr(seg, RSTART + 11, RLENGTH - 12)
      if (name == "" || cls == "") next
      if (seg !~ /<(failure|error)[ >]/) next
      id = name
      if (index(id, ":") > 0) id = substr(id, 1, index(id, ":") - 1)
      gsub(/^[ \\t]+|[ \\t]+$/, "", id)
      if (id ~ /^FL-[A-Za-z0-9-]+$/) next
      sub(/.*\\./, "", cls)
      # El MENSAJE, que es lo único que convierte esta línea en accionable. Estaba aquí desde
      # siempre —el XML de JUnit lo guarda entero— y se descartaba: por stdout salía "IllegalState
      # Exception at Clase.java:45" y a diagnosticarlo se le iba un ciclo completo. Se colapsa a
      # una línea y se acota: quien lee esto es la sesión más larga del pipeline.
      msg = ""
      if (match(seg, /<(failure|error)[^>]*message="[^"]*"/)) {
        frag = substr(seg, RSTART, RLENGTH)
        if (match(frag, /message="[^"]*"/)) msg = substr(frag, RSTART + 9, RLENGTH - 10)
      }
      gsub(/&#10;/, " ", msg); gsub(/&#13;/, " ", msg)
      gsub(/&quot;/, "\\"", msg)
      gsub(/&lt;/, "<", msg); gsub(/&gt;/, ">", msg)
      gsub(/&amp;/, "\\\\&", msg)
      gsub(/  +/, " ", msg)
      if (length(msg) > 400) msg = substr(msg, 1, 400) " [...]"
      printf "    %s  (%s)\\n", name, cls
      if (msg != "") printf "      %s\\n", msg
    }
  ' "$RESULTS"/*.xml 2>/dev/null
}

broken="$(non_scenario_failures)"

echo ""
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ] && [ "$ok" -gt 0 ]; then
  # La matriz está limpia. Antes de cantar el 100% hay que preguntarle a Gradle: decir
  # "100%" con la suite roja es peor que no tener gate — el pipeline avanzaría a la fase
  # siguiente creyendo el servicio verde.
  if [ "$suite_failed" -ne 0 ]; then
    echo "RESULTADO: KO — los $ok escenario(s) FL-* están en OK, pero la suite falló."
    echo "  Hay pruebas en rojo que NO son escenarios y por eso no salen en la matriz:"
    printf '%s\\n' "$broken"
    echo "  log completo de Gradle: $LOG"
    echo "  Son del agente de pruebas, no del diseño: o las arregla o las retira."
    exit 1
  fi
  echo "RESULTADO: OK — $ok escenario(s) al 100%."
  exit 0
fi

echo "RESULTADO: KO — $ok OK · $ko FALLO · $sk omitido(s) · $nc no ejercitado(s)."
echo "  evidencia por fallo: $EVIDENCE/<FL-id>.json (request, response y aserción)"
echo "  log completo de Gradle: $LOG"
if [ -n "$broken" ]; then
  echo ""
  echo "  ARNÉS: hay pruebas en rojo que NO son escenarios y no salen en la matriz."
  printf '%s\\n' "$broken"
  echo "  Un \\\`initializationError\\\` aquí significa que esa clase no ejecutó NINGÚN escenario:"
  echo "  los FL-* que le tocaban salen arriba como NO_EJERC, y no es falta de cobertura."
  echo "  La causa va en la línea de debajo de cada clase; el volcado, en"
  echo "  $EVIDENCE/<Clase>-init.json (con el último comando ejecutado y su salida)."
  if [ "$ko" -eq 0 ]; then
    echo "  No hay ningún escenario en FALLO: no hay nada que arbitrar, así que esto sale"
    echo "  con 2 (arnés roto) y no con 1: se arregla la clase y se vuelve a puntuar."
    exit 2
  fi
  echo "  PERO hay $ko escenario(s) FL-* en FALLO, y eso SÍ se arbitra: esto sale con 1."
  echo "  Arreglar el @BeforeAll NO los pone en verde. Una inicialización que revienta porque"
  echo "  esperaba un comportamiento del servidor (un correo que no llega, un estado que no"
  echo "  transita) es el MISMO rojo que los FL-* de arriba, visto antes: no es del arnés."
  echo "  Salir con 2 aquí devolvería la corrida al agente de pruebas, que no puede leer"
  echo "  src/main/java — es exactamente el bucle que esta condición cierra."
fi
exit 1
`;
}

// ─── AbstractFlowIT ──────────────────────────────────────────────────────────

function abstractImports(model) {
  const security = model.layersPresent.security;
  const oidc = security && tokenProtocol(model);
  const devtools = usesDevtools(model);
  const broker = brokerEntry(model);
  const reset = hasResetScript(model);

  const imports = [
    'java.time.Duration',
    'java.time.Instant',
    'java.util.ArrayList',
    'java.util.List',
    // `itemById` y la guarda de JsonPath son transversales: toda respuesta de colección
    // se consulta por un elemento, y el índice tras un filtro no falla en ningún stack —
    // miente en todos.
    'java.util.Map',
    'java.util.Optional',
    'java.util.UUID',
    'java.util.function.BooleanSupplier',
    'java.util.regex.Pattern',
    // Los helpers de carrera (race/raceOf) son transversales: cualquier diseño puede
    // tener un escenario que fije qué pasa cuando dos peticiones coinciden.
    'java.util.concurrent.Callable',
    'java.util.concurrent.CountDownLatch',
    'java.util.concurrent.ExecutionException',
    'java.util.concurrent.ExecutorService',
    'java.util.concurrent.Executors',
    'java.util.concurrent.Future',
    'java.util.concurrent.TimeUnit',
    'java.util.concurrent.TimeoutException',
    // Resolución de la URL sin re-codificar (ver `uriOf`). No es condicional: toda
    // llamada del arnés pasa por ahí, tenga o no el diseño un id con caracteres raros.
    'java.net.URI',
    'org.springframework.web.util.UriComponentsBuilder',
    'org.junit.jupiter.api.BeforeAll',
    'org.junit.jupiter.api.MethodOrderer',
    'org.junit.jupiter.api.TestInstance',
    'org.junit.jupiter.api.TestMethodOrder',
    'org.junit.jupiter.api.extension.ExtendWith',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.boot.test.web.client.TestRestTemplate',
    'org.springframework.http.HttpEntity',
    'org.springframework.http.HttpHeaders',
    'org.springframework.http.HttpMethod',
    'org.springframework.http.MediaType',
    'org.springframework.http.ResponseEntity',
    'org.springframework.http.client.JdkClientHttpRequestFactory',
    'org.springframework.test.context.ActiveProfiles',
    'com.jayway.jsonpath.JsonPath',
    // Re-serialización de los nodos que extrae JsonPath (`toJson`). No depende del
    // stack: cualquier flujo que compare un fragmento de JSON lo necesita.
    'com.fasterxml.jackson.databind.ObjectMapper',
    'org.skyscreamer.jsonassert.JSONAssert',
    'org.skyscreamer.jsonassert.JSONCompareMode'
  ];
  const containerExec = usesContainerExec(model);
  if (reset || needsBrokerReseed(model) || containerExec || oidc) imports.push('java.io.IOException');
  // Resolución explícita del bash con el que se invocan los scripts de infra/: la
  // usan el reset de estado y la resiembra de topología de startBroker().
  // StandardCharsets y Arrays son de `runInfraScript`, que vive en esa misma sección: lee la
  // salida del script (la evidencia) y recorta sus últimas líneas para el mensaje del fallo.
  if (reset || needsBrokerReseed(model)) {
    imports.push('java.io.File', 'java.util.Locale', 'java.nio.charset.StandardCharsets', 'java.util.Arrays');
  }
  // Motor de ejecución en contenedor (runProcess) y las dos vías que lo usan:
  // `devtools(...)` y `db(...)` construyen su lista de argumentos igual.
  if (containerExec) imports.push('java.nio.charset.StandardCharsets', 'java.util.ArrayList');
  // Los cuerpos que van a una CLI del contenedor viajan por archivo, no por línea de
  // comandos: el sondeo de RabbitMQ, y con cualquier broker la entrega de mensajes
  // entrantes (deliverMessage), que es la que lleva JSON arbitrario del escenario.
  // `devtools` en la condición porque todo esto vive dentro de devtoolsSection: sin
  // contenedor no se genera, y el import quedaría sin uso.
  if (broker && devtools) {
    imports.push('java.nio.file.Files', 'java.nio.file.Path', 'java.util.ArrayList', 'java.util.Map');
  }
  // El cuerpo entregado a RabbitMQ va en base64 dentro del sobre de la API de gestión.
  if (broker?.id === 'rabbitmq' && devtools) imports.push('java.util.Base64');
  // Marcas de offset por destino (aislamiento de Kafka, que no tiene purga).
  if (broker?.id === 'kafka') imports.push('java.util.concurrent.ConcurrentHashMap');
  // Desescapado del cuerpo de aplicación (decodeBodies / decodePayloads). Lo necesitan
  // los dos brokers que lo devuelven como cadena JSON escapada DENTRO del JSON de la
  // respuesta: la CLI de SQS en su campo `Body` y la Management API de RabbitMQ en su
  // campo `payload`. Kafka no: kcat escupe el registro tal cual.
  if (broker?.id === 'snssqs' || broker?.id === 'rabbitmq') imports.push('java.util.regex.Matcher');
  // `Set.copyOf` deduplica los destinos de descarte al marcarlos: varias suscripciones
  // multiplexadas sobre el mismo topic comparten DLT, y marcarlo dos veces gastaría un
  // sondeo de más contra el broker por cada clase de flujo.
  if (broker?.id === 'kafka' && usesDeadLetter(model)) imports.push('java.util.Set');
  // El dedupe de la lectura de SQS: un Set con orden de inserción (el orden importa — la
  // lista que se devuelve es la que el escenario recorre) y el ObjectMapper para volver a
  // serializar cada mensaje ya deduplicado.
  if (broker?.id === 'snssqs') {
    imports.push('com.fasterxml.jackson.core.JsonProcessingException', 'java.util.LinkedHashSet', 'java.util.Set');
  }
  // La espera al drenaje del outbox declara su propio Set de canales publicados, y se
  // emite con los tres brokers (a diferencia del de arriba, que es solo de Kafka).
  if (drainsOutbox(model)) imports.push('java.util.Set');
  // Lectura del buzón: la dirección del escenario va codificada en la URL de
  // búsqueda, así que la sección necesita el codificador y su charset.
  if (hasMail(model)) imports.push(...MAIL_IMPORTS, 'java.util.ArrayList', 'java.util.List', 'java.util.Map');
  // Flag de la caída provocada por el propio escenario (palanca del outbox).
  if (usesBrokerControl(model)) imports.push('java.util.concurrent.atomic.AtomicBoolean');
  // La pausa del relay resuelve su bean por NOMBRE desde el contexto: nada de src/main.
  if (pausesRelay(model)) {
    imports.push(
      'org.springframework.context.ApplicationContext',
      'org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor'
    );
  }
  // Segunda réplica: proceso aparte lanzado desde el jar.
  if (usesReplica(model)) {
    imports.push(
      'java.io.IOException',
      'java.net.HttpURLConnection',
      'java.net.ServerSocket',
      'java.net.URI',
      'java.nio.file.Files',
      'java.nio.file.Path',
      'java.time.Duration',
      'java.time.Instant',
      'java.util.concurrent.TimeUnit',
      'java.util.stream.Stream'
    );
  }
  if (hasMultipart(model)) {
    imports.push(
      'java.util.Map',
      'org.springframework.core.io.ByteArrayResource',
      'org.springframework.util.LinkedMultiValueMap',
      'org.springframework.util.MultiValueMap'
    );
  }
  if (oidc) {
    imports.push(
      'java.net.URI',
      'java.net.http.HttpClient',
      'java.net.http.HttpRequest',
      'java.net.http.HttpResponse',
      'java.nio.file.Files',
      'java.nio.file.Path',
      'java.util.LinkedHashMap',
      'java.util.Locale',
      'java.util.Map',
      'java.util.concurrent.ConcurrentHashMap'
    );
  }
  // Programación del proveedor de prueba (WireMock): admin API por HTTP crudo,
  // porque el TestRestTemplate apunta al servidor bajo prueba, no al stub.
  if (hasHttpClients(model)) {
    imports.push(
      'java.net.URI',
      'java.net.http.HttpClient',
      'java.net.http.HttpRequest',
      'java.net.http.HttpResponse',
      'java.io.IOException',
      // Log de peticiones del stub: las cabeceras llegan como objeto (stubRequestHeader).
      'java.util.Map'
    );
  }
  // Estado en memoria de la aplicación que el reset por CLI no alcanza.
  if (usesCircuitBreakers(model)) {
    imports.push('io.github.resilience4j.circuitbreaker.CircuitBreaker', 'io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry');
  }
  if (usesOutboundOAuth2(model)) {
    imports.push('java.lang.reflect.Field', 'java.util.Map', 'org.springframework.security.oauth2.client.OAuth2AuthorizedClientService');
  }
  if (needsDirtiesContext(model)) imports.push('org.springframework.test.annotation.DirtiesContext');
  return imports;
}

function hasHttpClients(model) {
  return Boolean(model.layersPresent.httpClients);
}

// Estado que vive en beans singleton de la aplicación y que `reset-db.sh` no puede
// tocar: el script habla con la BD, el broker, la caché y el stub —procesos aparte—,
// pero la ventana de un circuito y la concesión OAuth2 cacheada están DENTRO de la
// JVM bajo prueba y sobreviven a todo el reset, entre escenarios y entre clases.
//
// Lo destapó la corrida de autenticación saliente: un circuito abría al tercer fallo
// en vez de al quinto porque arrastraba dos de otra clase, y un token cacheado hacía
// pasar un escenario cuyo proveedor de identidad debía estar caído. El segundo es el
// peor de los dos: no falla, aprueba de más. Y el diagnóstico costó dos vueltas de
// arbitraje porque la contaminación enmascaraba un defecto real del fallback.
function usesCircuitBreakers(model) {
  return (model.httpClients ?? []).some((client) => client.calls.some((call) => call.circuitBreaker));
}

function usesOutboundOAuth2(model) {
  return (model.httpClients ?? []).some((client) => client.auth?.type === 'oauth2-client-credentials');
}

function hasInMemoryState(model) {
  return usesCircuitBreakers(model) || usesOutboundOAuth2(model);
}

// Los beans se inyectan en la instancia (`@TestInstance(PER_CLASS)` hace que
// `@BeforeAll` sea de instancia) y se copian a estáticos porque `resetState()` es
// estático. El `@BeforeAll` de la superclase corre ANTES que el de la subclase, que
// es quien llama a `resetState()`, así que para entonces ya están puestos.
//
// `required = false` en los dos: un proyecto puede tener circuitos y no oauth2, o al
// revés, y esta clase es la misma para todos.
function inMemoryStateFields(model) {
  if (!hasInMemoryState(model)) return '';
  const parts = [];
  if (usesCircuitBreakers(model)) {
    parts.push(`
    @Autowired(required = false)
    private CircuitBreakerRegistry circuitBreakerRegistry;

    private static CircuitBreakerRegistry CIRCUIT_BREAKERS;`);
  }
  if (usesOutboundOAuth2(model)) {
    parts.push(`
    @Autowired(required = false)
    private OAuth2AuthorizedClientService authorizedClientService;

    private static OAuth2AuthorizedClientService AUTHORIZED_CLIENTS;`);
  }
  return `${parts.join('\n')}\n`;
}

function inMemoryStateCapture(model) {
  const lines = [];
  if (usesCircuitBreakers(model)) lines.push('        CIRCUIT_BREAKERS = circuitBreakerRegistry;');
  if (usesOutboundOAuth2(model)) lines.push('        AUTHORIZED_CLIENTS = authorizedClientService;');
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

// Los métodos, y la llamada que `resetState()` les hace. Se exponen como
// `protected` porque el reset es POR CLASE: un escenario que necesite el circuito
// cerrado a mitad de su propio flujo tiene que poder pedirlo sin reiniciar la BD.
function inMemoryResetSection(model) {
  if (!hasInMemoryState(model)) return '';
  let section = '';
  if (usesCircuitBreakers(model)) {
    section += `
    /**
     * Devuelve todos los circuitos a CLOSED con su ventana vacía.
     *
     * <p>La ventana de un circuito vive en un bean singleton, no en la BD ni en el
     * broker: sin esto, los fallos que provocó un escenario cuentan para el circuito
     * del siguiente y de la clase siguiente. El síntoma es un circuito que abre antes
     * de lo que dice el diseño, y la sospecha cae sobre la configuración, que está bien.
     */
    protected static void resetCircuitBreakers() {
        if (CIRCUIT_BREAKERS == null) return;
        CIRCUIT_BREAKERS.getAllCircuitBreakers().forEach(CircuitBreaker::reset);
    }
`;
  }
  if (usesOutboundOAuth2(model)) {
    section += `
    /**
     * Olvida las concesiones OAuth2 ya obtenidas.
     *
     * <p>Es el reset que más importa de los dos, porque su ausencia no hace fallar un
     * escenario: lo hace <b>pasar</b>. Un token cacheado de un escenario anterior sirve
     * para autorizar la llamada de uno cuyo proveedor de identidad debía estar caído,
     * así que el escenario que iba a medir esa caída aprueba sin haberla medido.
     *
     * <p>Se limpia por reflexión porque {@code OAuth2AuthorizedClientService} no expone
     * ninguna forma de vaciarlo entero: {@code removeAuthorizedClient} exige el nombre
     * del principal bajo el que quedó cacheada cada concesión, que con
     * client_credentials lo pone Spring por dentro. Falla ruidosamente si no encuentra
     * dónde limpiar: la alternativa —no hacer nada en silencio— es exactamente el
     * defecto que este método existe para cerrar.
     */
    protected static void resetOAuth2AuthorizedClients() {
        if (AUTHORIZED_CLIENTS == null) return;
        int cleared = 0;
        for (Field field : AUTHORIZED_CLIENTS.getClass().getDeclaredFields()) {
            if (!Map.class.isAssignableFrom(field.getType())) continue;
            try {
                field.setAccessible(true);
                Object value = field.get(AUTHORIZED_CLIENTS);
                if (value instanceof Map<?, ?> map) {
                    map.clear();
                    cleared++;
                }
            } catch (ReflectiveOperationException | RuntimeException e) {
                throw new AssertionError("No se pudo vaciar el cache de concesiones OAuth2 (" + field.getName() + ")", e);
            }
        }
        if (cleared == 0) {
            throw new AssertionError(
                    "El bean OAuth2AuthorizedClientService ("
                            + AUTHORIZED_CLIENTS.getClass().getName()
                            + ") no expone ningun Map que vaciar: un token cacheado sobrevivira entre escenarios"
                            + " y hara pasar los que midan un proveedor de identidad caido.");
        }
    }
`;
  }
  return section;
}

// La llamada desde `resetState()`. Va PRIMERO: es estado de la propia JVM, no
// depende de que la infraestructura esté arriba, y así también se limpia cuando el
// reset por script no existe.
function inMemoryResetCalls(model) {
  const lines = [];
  if (usesCircuitBreakers(model)) lines.push('        resetCircuitBreakers();');
  if (usesOutboundOAuth2(model)) lines.push('        resetOAuth2AuthorizedClients();');
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

function abstractBody(model) {
  const { layersPresent } = model;
  const security = layersPresent.security;
  const dirties = needsDirtiesContext(model)
    ? '// BD en memoria (no se puede vaciar por CLI): el aislamiento entre clases de flujo\n' +
      '// lo da recrear el contexto —y con él el esquema— antes de cada clase.\n' +
      '@DirtiesContext(classMode = DirtiesContext.ClassMode.BEFORE_CLASS)\n'
    : '';

  return `/**
 * Base de las clases de flujo (\`<Flow>FlowIT\`) que ejecutan los escenarios FL-*
 * de specs/validation-scenarios.md contra el servidor real y la infraestructura
 * de infra/docker-compose.yaml.
 *
 * <p><b>Caja negra.</b> build.gradle deja src/main/java fuera del compileClasspath
 * de este source set: aquí no se puede importar ningún DTO, comando ni entidad del
 * servicio, y un test que lo necesitase tendría mal planteada la aserción. Los
 * escenarios se expresan solo con HTTP y JSON, que es lo que exige el contrato de
 * equivalencia entre stacks.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@ExtendWith(FailureCapture.class)
${dirties}public abstract class AbstractFlowIT {
${layersPresent.api ? `
    /** Prefijo de todas las rutas del servicio (basePath del diseño + versión). */
    protected static final String ROUTE_BASE = "${model.api.routeBase}";
` : ''}
    /** Re-serializa a JSON los nodos que devuelve JsonPath. Ver {@link #toJson}. */
    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    protected TestRestTemplate rest;
${security && tokenProtocol(model) ? `
    private final Map<String, String> credentials = new ConcurrentHashMap<>();

    /**
     * Cuánta vida le tiene que quedar a un token cacheado para seguir sirviendo. Cubre lo que
     * tarde la petición en llegar y el desfase de reloj con el proveedor de identidad.
     */
    private static final Duration TOKEN_RENEWAL_MARGIN = Duration.ofSeconds(30);

    /** El claim {@code exp} dentro del payload del JWT, leído sin librerías de por medio. */
    private static final java.util.regex.Pattern EXP_CLAIM =
            java.util.regex.Pattern.compile("\\"exp\\"\\\\s*:\\\\s*(\\\\d+)");
` : ''}${
  pausesRelay(model)
    ? `
    /**
     * El contexto de la aplicación, solo para pausar el relay durante la resiembra de la
     * topología (ver {@link #pauseOutboxRelay()}). Se usa únicamente para resolver un bean
     * por NOMBRE: nada de {@code src/main/java} entra aquí — ese paquete no está en el
     * compileClasspath de este source set, y la caja negra sigue intacta.
     */
    @Autowired
    private ApplicationContext applicationContext;

    private static ApplicationContext CONTEXT;
` : ''}${inMemoryStateFields(model)}
    @BeforeAll
    void configureHttpClient() {
        // El factory por defecto (HttpURLConnection) no soporta PATCH; el del
        // HttpClient del JDK sí, y no añade dependencias.
        rest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());${
      pausesRelay(model) ? `
        CONTEXT = applicationContext;` : ''
    }${inMemoryStateCapture(model)}
    }

    /** Intercambio HTTP completo: lo que se asserta y lo que se vuelca al fallar. */
    public record Response(int status, HttpHeaders headers, String body) {
        public String header(String name) {
            return headers.getFirst(name);
        }
    }

    // ── Llamadas HTTP ────────────────────────────────────────────────────────

    protected Response get(String path) {
        return exchange(HttpMethod.GET, path, null, null);
    }

    protected Response post(String path, String jsonBody) {
        return exchange(HttpMethod.POST, path, jsonBody, null);
    }

    protected Response put(String path, String jsonBody) {
        return exchange(HttpMethod.PUT, path, jsonBody, null);
    }

    protected Response patch(String path, String jsonBody) {
        return exchange(HttpMethod.PATCH, path, jsonBody, null);
    }

    protected Response delete(String path) {
        return exchange(HttpMethod.DELETE, path, null, null);
    }
${security ? `
    protected Response get(String path, String token) {
        return exchange(HttpMethod.GET, path, null, token);
    }

    protected Response post(String path, String jsonBody, String token) {
        return exchange(HttpMethod.POST, path, jsonBody, token);
    }

    protected Response put(String path, String jsonBody, String token) {
        return exchange(HttpMethod.PUT, path, jsonBody, token);
    }

    protected Response patch(String path, String jsonBody, String token) {
        return exchange(HttpMethod.PATCH, path, jsonBody, token);
    }

    protected Response delete(String path, String token) {
        return exchange(HttpMethod.DELETE, path, null, token);
    }
` : ''}
    /**
     * Ejecuta la llamada y registra el intercambio en {@link FailureCapture}. Nunca
     * lanza por un 4xx/5xx: el status es una aserción del escenario, no un error.
     */
    protected Response exchange(HttpMethod method, String path, String jsonBody, String token) {
        return exchange(method, path, jsonBody, token, ${hasIdempotency(model) ? 'idempotencyKey()' : 'null'});
    }
${hasIdempotency(model) ? `
    /**
     * Variante con \`Idempotency-Key\` explícita: repetir la misma clave es lo que
     * ejercita la deduplicación. En el resto de escenarios va una uuid nueva por
     * request — reutilizarla entre flujos devuelve la respuesta del anterior
     * mientras dure el ttlSeconds del diseño.
     */
    protected Response exchangeWithKey(HttpMethod method, String path, String jsonBody, String token, String idempotencyKey) {
        return exchange(method, path, jsonBody, token, idempotencyKey);
    }
` : ''}${hasCors(model) ? `
    /**
     * Variante con cabeceras de petición propias del escenario. Existe por la política
     * CORS, que solo se observa si la petición dice de qué origen viene: sin \`Origin\`
     * el servidor contesta lo mismo con política y sin ella.
     *
     * <p><b>No es la vía para \`Authorization\` ni para \`Idempotency-Key\`.</b> Los dos
     * tienen su propio parámetro y su propia semántica (\`tokenFor(...)\` cachea por rol,
     * la clave se repite solo donde se prueba la deduplicación); colarlos por el mapa
     * salta esas garantías y hace que el escenario mida otra cosa.
     */
    protected Response exchangeWithHeaders(HttpMethod method, String path, String jsonBody, String token,
            Map<String, String> extraHeaders) {
        return exchange(method, path, jsonBody, token, ${hasIdempotency(model) ? 'idempotencyKey()' : 'null'}, extraHeaders);
    }

    /**
     * Preflight CORS: el \`OPTIONS\` que el navegador manda ANTES de la petición real.
     *
     * <p>Va deliberadamente <b>sin</b> \`Authorization\`, que es como lo manda un navegador
     * de verdad: el preflight es previo a la credencial. Por eso un 2xx aquí prueba algo
     * que ninguna otra llamada del arnés puede probar — que el filtro de CORS corre antes
     * de la autorización. Si contesta 401, la SPA no puede hacer ni una llamada.
     *
     * <p>\`requestHeaders\` es la lista separada por comas que el navegador anuncia
     * (\`authorization,content-type\`); nulo si el escenario no anuncia ninguna.
     */
    protected Response preflight(String path, String origin, String requestMethod, String requestHeaders) {
        Map<String, String> headers = requestHeaders == null
                ? Map.of(HttpHeaders.ORIGIN, origin,
                        HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, requestMethod)
                : Map.of(HttpHeaders.ORIGIN, origin,
                        HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, requestMethod,
                        HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, requestHeaders);
        return exchange(HttpMethod.OPTIONS, path, null, null, null, headers);
    }
` : ''}
    private Response exchange(HttpMethod method, String path, String jsonBody, String token, String idempotencyKey) {
        return exchange(method, path, jsonBody, token, idempotencyKey, null);
    }

    private Response exchange(HttpMethod method, String path, String jsonBody, String token, String idempotencyKey,
            Map<String, String> extraHeaders) {
        HttpHeaders headers = new HttpHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        if (jsonBody != null) {
            headers.setContentType(MediaType.APPLICATION_JSON);
        }
        if (token != null) {
            headers.setBearerAuth(token);
        }
        if (idempotencyKey != null && isMutation(method)) {
            headers.set("Idempotency-Key", idempotencyKey);
        }
        // Al final a propósito: el escenario añade lo suyo sobre lo que el arnés ya puso,
        // no al revés.
        if (extraHeaders != null) {
            extraHeaders.forEach(headers::set);
        }
        ResponseEntity<String> entity = rest.exchange(uriOf(path), method, new HttpEntity<>(jsonBody, headers), String.class);
        Response response = new Response(entity.getStatusCode().value(), entity.getHeaders(), entity.getBody());
        FailureCapture.record(method.name(), path, headers, jsonBody, response);
        return response;
    }

    /**
     * Resuelve el path a un {@link URI} <b>ya codificado</b>. Es la única forma de
     * llamar a {@code rest.exchange(...)} en este arnés.
     *
     * <p>Pasarle un {@code String} elige la sobrecarga de PLANTILLA de URI, que vuelve a
     * codificar lo que ya venía codificado: el {@code %40} de un email en la ruta llega
     * al servidor como {@code %2540}, la petición no autentica y el escenario ve un 401
     * que no tiene nada que ver con lo que estaba probando. Con {@code build(true)} se le
     * dice a Spring que el path ya está codificado y que no lo toque.
     *
     * <p>Efecto deliberado: si el escenario compone una URL con un carácter ilegal sin
     * codificar (un espacio crudo), esto <b>falla aquí</b>, señalando la URL. Antes esa
     * misma entrada se corrompía en silencio y el fallo aparecía como un status inesperado.
     */
    protected static URI uriOf(String path) {
        return UriComponentsBuilder.fromUriString(path).build(true).toUri();
    }

    private static boolean isMutation(HttpMethod method) {
        return HttpMethod.POST.equals(method) || HttpMethod.PUT.equals(method) || HttpMethod.PATCH.equals(method);
    }

${hasIdempotency(model) ? `
    protected String idempotencyKey() {
        return UUID.randomUUID().toString();
    }
` : ''}${hasMultipart(model) ? `
    /** Subida multipart: la parte binaria más los campos simples del formulario. */
    protected Response multipart(String path, String partName, String filename, String contentType, byte[] content, Map<String, String> fields${security ? ', String token' : ''}) {
        return multipartTo(path, partName, filename, contentType, content, fields${security ? ', token' : ''}, ${hasIdempotency(model) ? 'idempotencyKey()' : 'null'});
    }
${hasIdempotency(model) ? `
    /**
     * Variante con \`Idempotency-Key\` explícita, simétrica a {@link #exchangeWithKey}:
     * repetir la misma clave en dos subidas es lo que ejercita la deduplicación de
     * una operación multipart.
     */
    protected Response multipartWithKey(String path, String partName, String filename, String contentType, byte[] content, Map<String, String> fields${security ? ', String token' : ''}, String idempotencyKey) {
        return multipartTo(path, partName, filename, contentType, content, fields${security ? ', token' : ''}, idempotencyKey);
    }
` : ''}
    /**
     * El cuerpo de la subida, contra la URL que se le pase.
     *
     * Toma la URL y no la ruta porque la subida también tiene que poder dirigirse a la
     * SEGUNDA réplica ({@code onReplicaMultipart}), y ahí el destino es absoluto. Con la
     * ruta cerrada dentro, un escenario de clúster sobre una operación multipart no se
     * puede escribir — y ese es exactamente el caso que el registro de idempotencia
     * existe para cerrar.
     */
    private Response multipartTo(String url, String partName, String filename, String contentType, byte[] content, Map<String, String> fields${security ? ', String token' : ''}, String idempotencyKey) {
        ByteArrayResource part = new ByteArrayResource(content) {
            @Override
            public String getFilename() {
                return filename;
            }
        };
        HttpHeaders partHeaders = new HttpHeaders();
        partHeaders.setContentType(MediaType.parseMediaType(contentType));

        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add(partName, new HttpEntity<>(part, partHeaders));
        fields.forEach(form::add);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        if (idempotencyKey != null) {
            headers.set("Idempotency-Key", idempotencyKey);
        }${security ? `
        if (token != null) {
            headers.setBearerAuth(token);
        }` : ''}
        ResponseEntity<String> entity = rest.exchange(uriOf(url), HttpMethod.POST, new HttpEntity<>(form, headers), String.class);
        Response response = new Response(entity.getStatusCode().value(), entity.getHeaders(), entity.getBody());
        FailureCapture.record("POST (multipart)", url, headers, "<" + content.length + " bytes>", response);
        return response;
    }
` : ''}
    // ── Aserciones ───────────────────────────────────────────────────────────

    /**
     * Cuerpo completo en modo estricto: campos presentes <b>y</b> ausentes en una
     * sola aserción. Los valores no deterministas (ids, marcas de tiempo) no van
     * aquí: se extraen con {@link #jsonPath} y se verifican por forma.
     */
    protected void assertBody(Response response, String expectedJson) {
        assertJson(response.body(), expectedJson);
    }

    /**
     * Lo mismo, sobre un JSON que no viene de una {@link Response}: el cuerpo
     * <b>saliente</b> que el servidor mandó al proveedor de prueba
     * ({@code stubRequestBody(...)}), o el {@code data} de un evento leído del broker.
     */
    protected void assertJson(String actualJson, String expectedJson) {
        try {
            JSONAssert.assertEquals(expectedJson, actualJson, JSONCompareMode.STRICT);
        } catch (Exception e) {
            throw new AssertionError("El cuerpo no coincide con el esperado: " + e.getMessage(), e);
        }
    }

    /** Valor no determinista del cuerpo (id generado, marca de tiempo), por JsonPath. */
    protected <T> T jsonPath(Response response, String path) {
        rejectIndexAfterFilter(path);
        return JsonPath.read(response.body(), path);
    }

    /**
     * Un elemento de una colección del cuerpo, localizado por el valor de uno de sus
     * campos. <b>Esta es la vía</b>: filtrar y quedarse con el primero se hace aquí, en
     * Java, no encadenando un índice al JsonPath.
     *
     * <p>Devuelve vacío si no hay ningún elemento que case. Para preguntar por un campo
     * del elemento —«¿ya se apagó la espera?»— se encadena sobre el {@code Optional}, y
     * un campo nulo da vacío igual que un elemento ausente, que es justo lo que quiere
     * decir la pregunta:
     *
     * <pre>itemById(response, "$.items", "id", productId)
     *     .map(item -&gt; item.get("recordWithdrawalAwaitingSince"))
     *     .isPresent()</pre>
     *
     * <p>El {@code collectionPath} es explícito porque no siempre es el mismo: un listado
     * paginado lo trae bajo {@code $.items} y una salida de lista es el array raíz
     * ({@code $}).
     */
    protected Optional<Map<String, Object>> itemById(Response response, String collectionPath, String idField, Object idValue) {
        List<Map<String, Object>> items = JsonPath.read(response.body(), collectionPath);
        return items.stream().filter(item -> String.valueOf(idValue).equals(String.valueOf(item.get(idField)))).findFirst();
    }

    /**
     * Rechaza un JsonPath que indexa DESPUÉS de un filtro, que es el error que más caro
     * sale de esta clase porque no falla: miente.
     *
     * <p>{@code $.items[?(@.id=='x')].campo[0]} no devuelve el campo del primer elemento
     * que casa. Un filtro hace el path <i>indefinido</i>, y Jayway devuelve entonces
     * SIEMPRE una {@code JSONArray} —vacía si no hay nada, pero nunca {@code null} y
     * nunca {@code PathNotFoundException}—, valga lo que valga el campo de verdad. Un
     * {@code valor != null} sobre eso es constantemente cierto, así que un
     * {@code await(...)} construido encima expira aunque el servidor haya convergido hace
     * rato: el síntoma es un timeout que parece latencia del servidor, y manda a buscar el
     * defecto donde no está. En la corrida del 13/08/2026 costó un ciclo de arbitraje
     * completo y contaminó el diagnóstico del defecto que sí era real.
     *
     * <p>La forma correcta es {@link #itemById}, que filtra y toma el primero en Java.
     */
    private static void rejectIndexAfterFilter(String path) {
        int filter = path.indexOf("?(");
        if (filter >= 0 && INDEX_AFTER_FILTER.matcher(path.substring(filter)).find()) {
            throw new IllegalArgumentException(
                    "JsonPath con índice después de un filtro: " + path
                            + " — un filtro hace el path indefinido y Jayway devuelve siempre una lista (vacía), nunca el elemento,"
                            + " así que la comprobación que montes encima será constantemente cierta. Usa itemById(...) y quédate"
                            + " con el primero en Java.");
        }
    }

    private static final Pattern INDEX_AFTER_FILTER = Pattern.compile("\\\\[\\\\s*\\\\d+\\\\s*\\\\]");

    /**
     * JSON válido a partir de un nodo <b>objeto o array</b> extraído con
     * {@link #jsonPath} (o con {@code JsonPath.read} sobre cualquier otra cadena).
     *
     * <p>Con jackson-databind en el classpath —lo trae {@code spring-boot-starter-web}—
     * el proveedor por defecto de JsonPath materializa esos nodos como
     * {@code LinkedHashMap}/{@code List}, y {@code Object.toString()} sobre ellos da
     * sintaxis de Java ({@code {clave=valor}}), no JSON: volver a leer ese texto con
     * {@code JsonPath.read} lanza {@code PathNotFoundException} aunque el servidor cumpla
     * el contrato, y compararlo con {@code JSONAssert} falla por su propia técnica.
     * Re-serializar con Jackson es agnóstico de qué proveedor de JsonPath esté activo.
     *
     * <p>El caso donde más aparece es el {@code data} de un evento leído del broker
     * ({@code $.data} de la envoltura {@code {metadata, data}}).
     */
    protected String toJson(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (Exception e) {
            throw new AssertionError("No se pudo serializar el fragmento JSON: " + e.getMessage(), e);
        }
    }

    protected void assertIsUuid(String value) {
        UUID.fromString(value);
    }

    protected void assertIsInstant(String value) {
        Instant.parse(value);
    }

    /**
     * Espera activa para efectos asíncronos (publicación de eventos, consumo de
     * suscripciones). Sin dependencias nuevas: sondeo con periodo fijo.
     */
    protected void await(Duration timeout, BooleanSupplier condition) {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
                return;
            }
            try {
                Thread.sleep(200L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Espera interrumpida", e);
            }
        }
        throw new AssertionError("La condición no se cumplió en " + timeout);
    }

    private boolean preconditionsDone;
    private AssertionError preconditionsFailure;

    /**
     * Precondición que depende del <b>comportamiento de la aplicación</b>: una espera de
     * correo, un barrido que tiene que haber pasado, una transición del lifecycle que
     * ninguna llamada provoca directamente. Se invoca desde {@code @BeforeEach}, y esa
     * ubicación no es estilo.
     *
     * <p>En {@code @BeforeAll} el mismo fallo es <b>inatribuible</b>: JUnit aborta el
     * contenedor de la clase con {@code initializationError}, ningún escenario llega a
     * ejecutarse y sus {@code FL-*} salen de la matriz como NO_EJERCITADO — una etiqueta
     * que dice «sin cobertura» cuando lo que hubo fue un rojo del servidor. La puntuación
     * lo lee entonces como arnés roto y devuelve la corrida al agente de pruebas, que no
     * puede leer {@code src/main/java} y por tanto no puede arreglarlo. Ese bucle costó
     * una corrida entera.
     *
     * <p>Desde aquí, en cambio, el fallo cae sobre <b>cada escenario</b> de la clase: la
     * matriz los marca FALLO, {@code FailureCapture} deja su volcado, y quien arbitra es
     * {@code keel-spring-validate}, que sí puede dictaminar {@code culprit: code}.
     *
     * <p>Corre una sola vez por clase (las clases de flujo son
     * {@code @TestInstance(PER_CLASS)}) y <b>memoriza también el fallo</b>: sin eso, una
     * espera de correo agotada se pagaría entera en cada escenario de la clase.
     *
     * <p>Lo determinista —{@code resetState()}, las llamadas HTTP que devuelven 2xx por
     * contrato— se queda en {@code @BeforeAll}. Aquí va solo lo que el servidor puede
     * incumplir.
     */
    protected final void awaitPreconditions(Runnable seed) {
        if (preconditionsFailure != null) {
            throw preconditionsFailure;
        }
        if (preconditionsDone) {
            return;
        }
        try {
            seed.run();
            preconditionsDone = true;
        } catch (AssertionError e) {
            preconditionsFailure = e;
            throw e;
        }
    }

    /**
     * Ejecuta las tareas A LA VEZ y devuelve sus resultados en el orden de envío.
     *
     * <p>Para los escenarios que fijan qué pasa cuando dos peticiones idénticas, dos
     * entregas del mismo mensaje o dos mutaciones sobre la misma entidad coinciden en
     * el tiempo. Una sola instancia basta para ejercitarlos: el servidor es multihilo,
     * y el árbitro de la carrera —la clave primaria, el lock de fila— es el mismo que
     * arbitraría entre réplicas.
     *
     * <p>Tres reglas, y las tres son lo que hace que el escenario pruebe algo:
     * <ul>
     *   <li>Todas las tareas arrancan del <b>mismo latch</b>. Sin él, «simultáneo»
     *       acaba siendo «una detrás de otra» —el coste de crear cada hilo basta para
     *       serializarlas— y el escenario pasa sin haber ejercitado ninguna carrera.</li>
     *   <li>Las excepciones <b>se relanzan</b>, no se tragan: un fallo silenciado en un
     *       hilo secundario deja el {@code Then} afirmando sobre un {@code When} que
     *       nunca ocurrió.</li>
     *   <li>El método <b>no asserta nada</b>: junta y devuelve, para que toda aserción
     *       siga ocurriendo en el hilo del test. Ahí es donde JUnit las recoge.</li>
     * </ul>
     *
     * <p>El {@code Then} de una carrera se escribe como disyunción cerrada (los
     * desenlaces admisibles, enumerados) más al menos una afirmación que no dependa de
     * quién ganó — normalmente un conteo leído por la API. Ver
     * conventions/integration-tests.md.
     */
    protected <T> List<T> race(List<Callable<T>> tasks) {
        ExecutorService pool = Executors.newFixedThreadPool(tasks.size());
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<T>> pending = new ArrayList<>();
            for (Callable<T> task : tasks) {
                pending.add(pool.submit(() -> {
                    start.await();
                    return task.call();
                }));
            }
            start.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> future : pending) {
                try {
                    results.add(future.get(30, TimeUnit.SECONDS));
                } catch (ExecutionException e) {
                    throw new AssertionError("Una rama de la carrera falló", e.getCause());
                }
            }
            return results;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("La carrera fue interrumpida", e);
        } catch (TimeoutException e) {
            throw new AssertionError("La carrera no terminó a tiempo", e);
        } finally {
            pool.shutdownNow();
        }
    }

    /** La misma llamada, {@code times} veces a la vez. Ver {@link #race}. */
    protected <T> List<T> raceOf(int times, Callable<T> task) {
        List<Callable<T>> tasks = new ArrayList<>();
        for (int i = 0; i < times; i++) {
            tasks.add(task);
        }
        return race(tasks);
    }

    // ── Estado e infraestructura ─────────────────────────────────────────────
${resetSection(model)}${inMemoryResetSection(model)}${bashExecutableSection(model)}${httpStubSection(model)}${mailSection(model)}${devtoolsSection(model)}${brokerControlSection(model)}${replicaSection(model)}${dbSection(model)}${containerExecSection(model)}${securitySection(model)}}`;
}

// Proveedor de prueba de las integraciones salientes. Es infraestructura, no un
// doble: un proceso aparte que habla HTTP por el mismo socket que hablaría el
// proveedor real, así que el escenario sigue siendo de caja negra. Sin esto, un
// flujo que atraviesa un cliente de http-clients no se puede puntuar — falla por
// conexión rechazada, que no dice nada sobre el código.
function httpStubSection(model) {
  if (!hasHttpClients(model)) return '';
  const clients = model.httpClients.map((client) => client.id).join(', ');
  return `
    /** Admin API del proveedor de prueba (WireMock de infra/docker-compose.yaml). */
    private static final String STUB_ADMIN = "http://localhost:8090/__admin";

    private static final HttpClient STUB_HTTP = HttpClient.newHttpClient();

    /**
     * Programa qué responde el proveedor en <b>este</b> escenario: método, ruta
     * (regex sobre el path, sin query) y la respuesta que verá el servidor.
     *
     * <p>Clientes que salen por aquí: ${clients}. Sus \`base-url\` apuntan al stub en
     * el perfil \`local\`, que es el que activan estas pruebas.
     *
     * <p>El Given de cada flujo programa lo suyo y {@code resetState()} lo limpia
     * antes de la clase siguiente: un mapping que sobrevive a su escenario es
     * estado global y hace que el orden de ejecución decida el resultado.
     */
    protected static void stubFor(String method, String pathPattern, int status, String jsonBody) {
        String mapping = """
                {"request": {"method": "%s", "urlPathPattern": "%s"},
                 "response": {"status": %d, "headers": {"Content-Type": "application/json"}, "body": %s}}"""
                .formatted(method, pathPattern, status, jsonBody == null ? "\\"\\"" : quote(jsonBody));
        stubAdmin("/mappings", mapping);
    }

    /**
     * Fallo del proveedor sin cuerpo útil: lo que ejercita el fallback declarado
     * (onFailure/onMiss) y el circuit breaker. Un 5xx es reintentable; un 4xx no.
     */
    protected static void stubFailure(String method, String pathPattern, int status) {
        stubFor(method, pathPattern, status, "{}");
    }

    /**
     * El proveedor <b>no contesta</b>: corta la conexión antes de responder.
     *
     * <p>No es lo mismo que un 5xx y la diferencia importa, porque el diseño la
     * declara: una llamada con {@code retryOn: [timeout, connection]} —lo habitual en
     * una escritura ajena, donde repetir un 5xx puede duplicar el efecto— <b>no</b>
     * reintenta un 500 y sí reintenta esto. Sin esta primitiva, ningún escenario puede
     * ejercitar esa rama, y un retry declarado así queda sin cubrir por construcción.
     *
     * <p>Del lado del servidor llega como {@code ResourceAccessException}, que es lo
     * que el generador lista en {@code retry-exceptions} para {@code connection}.
     */
    protected static void stubConnectionFault(String method, String pathPattern) {
        String mapping = """
                {"request": {"method": "%s", "urlPathPattern": "%s"},
                 "response": {"fault": "CONNECTION_RESET_BY_PEER"}}"""
                .formatted(method, pathPattern);
        stubAdmin("/mappings", mapping);
    }

    /**
     * El proveedor tarda más de lo que la llamada tolera: el otro modo de fallo que
     * el DSL distingue del 5xx ({@code retryOn: [timeout]}).
     *
     * <p>{@code delayMs} tiene que superar el {@code timeoutMs} declarado para esa
     * llamada, o el escenario mide una respuesta lenta y no un timeout. Llega como
     * {@code ResourceAccessException}, igual que el corte de conexión.
     */
    protected static void stubTimeout(String method, String pathPattern, int delayMs) {
        String mapping = """
                {"request": {"method": "%s", "urlPathPattern": "%s"},
                 "response": {"status": 200, "fixedDelayMilliseconds": %d,
                              "headers": {"Content-Type": "application/json"}, "body": "{}"}}"""
                .formatted(method, pathPattern, delayMs);
        stubAdmin("/mappings", mapping);
    }

    /**
     * Cuántas veces llamó el servidor al proveedor. Es la única forma de afirmar
     * en caja negra que un dato se pidió una vez y se cacheó, o que una activación
     * con {@code onFailure: ignore} no se reintentó.
     */
    protected static int stubCallCount(String method, String pathPattern) {
        return JsonPath.read(stubAdmin("/requests/count", stubCriterion(method, pathPattern)), "$.count");
    }

    /**
     * Las peticiones que recibió el proveedor, cada una como el JSON con que las
     * registra el stub: {@code {"url":…, "method":…, "headers":{…}, "body":"…"}}.
     *
     * <p>Es el Then que no se conforma con <i>cuántas</i> veces se llamó al proveedor
     * sino con <b>qué</b> se le envió: que el cuerpo saliente lleve los campos que el
     * diseño promete, o que la llamada viajara con la cabecera de idempotencia — sin
     * ella, un reintento nuestro encarga dos veces el mismo trabajo y eso no se ve
     * desde fuera. Con {@link #stubRequestBody} y {@link #stubRequestHeader} se leen
     * las dos piezas sin conocer el formato del stub.
     */
    protected static List<String> stubRequests(String method, String pathPattern) {
        List<Object> found = JsonPath.read(stubAdmin("/requests/find", stubCriterion(method, pathPattern)), "$.requests");
        return found.stream().map(AbstractFlowIT::serialize).toList();
    }

    /** El cuerpo que viajó en esa petición, listo para {@link #assertJson}. */
    protected static String stubRequestBody(String requestJson) {
        return JsonPath.read(requestJson, "$.body");
    }

    /**
     * Una cabecera de esa petición, buscada <b>sin distinguir mayúsculas</b>: quien
     * decide el caso del nombre es el cliente HTTP, no el contrato. {@code null} si
     * la petición no la llevaba.
     */
    protected static String stubRequestHeader(String requestJson, String name) {
        Map<String, Object> headers = JsonPath.read(requestJson, "$.headers");
        for (Map.Entry<String, Object> header : headers.entrySet()) {
            if (header.getKey().equalsIgnoreCase(name)) {
                return String.valueOf(header.getValue());
            }
        }
        return null;
    }

    /** Borra los mappings y el log de peticiones. Lo llama {@link #resetState()}. */
    protected static void resetStubs() {
        stubAdmin("/reset", "");
    }

    /**
     * Criterio de búsqueda del admin API, compartido por el conteo y el log: los dos
     * tienen que seleccionar exactamente las mismas peticiones, así que es un literal.
     */
    private static String stubCriterion(String method, String pathPattern) {
        return """
                {"method": "%s", "urlPathPattern": "%s"}""".formatted(method, pathPattern);
    }

    private static String stubAdmin(String path, String body) {
        try {
            HttpResponse<String> response = STUB_HTTP.send(
                    HttpRequest.newBuilder(URI.create(STUB_ADMIN + path))
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body))
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 300) {
                throw new AssertionError(
                        "El proveedor de prueba rechazó " + path + " (HTTP " + response.statusCode() + "): " + response.body());
            }
            return response.body();
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new AssertionError(
                    "No se pudo hablar con el proveedor de prueba en " + STUB_ADMIN
                            + ". ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh)", e);
        }
    }

    /** Escapa un JSON para incrustarlo como cadena dentro de otro JSON. */
    private static String quote(String value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (Exception e) {
            throw new AssertionError("No se pudo escapar el cuerpo del stub", e);
        }
    }

    /**
     * Vuelve a JSON un nodo que extrajo JsonPath. Mismo motivo que {@link #toJson}:
     * {@code toString()} sobre el {@code LinkedHashMap} que materializa JsonPath da
     * sintaxis de Java, no JSON, y volver a leerlo lanza {@code PathNotFoundException}.
     */
    private static String serialize(Object node) {
        try {
            return JSON.writeValueAsString(node);
        } catch (Exception e) {
            throw new AssertionError("No se pudo serializar la petición del stub", e);
        }
    }
`;
}

function resetSection(model) {
  const script = hasResetScript(model);
  // Kafka no tiene purga: su parte del reset es marcar el offset actual de cada
  // destino, y eso vive en el proceso de test, no en el script.
  const kafka = brokerEntry(model)?.id === 'kafka';
  const marks = kafka ? '\n            markChannels();' : '';
  // El broker vuelve a estar arriba ANTES de cualquier otra cosa del reset: un flujo
  // de outbox lo detiene, y si su `finally` no llegó a correr (un assert que revienta
  // antes, un timeout de Gradle) todos los flujos siguientes de la misma suite
  // fallarían por una causa que no es la suya. Y el purgado del script habla con el
  // broker, así que tiene que encontrarlo vivo.
  const restore = usesBrokerControl(model) ? '\n        restoreBroker();' : '';
  // Y una réplica viva sigue publicando y barriendo: si el finally de su escenario
  // no llego a correr, los flujos siguientes fallarian por una causa ajena. Pararla
  // es idempotente, asi que abrir cada clase con esto no cuesta nada.
  const stopReplicaLine = usesReplica(model) ? '\n        stopReplica();' : '';

  if (!script) {
    return `
    /**
     * Sin script de reset: la BD es en memoria y el aislamiento lo da
     * \`@DirtiesContext\` a nivel de clase. Se conserva el método para que toda clase
     * de flujo llame a lo mismo desde su \`@BeforeAll\`.
     */
    protected static void resetState() {${inMemoryResetCalls(model)}${restore}${stopReplicaLine}${
      kafka
        ? `
        markChannels();`
        : restore || hasInMemoryState(model)
          ? ''
          : `
        // No-op: el contexto se recrea antes de cada clase de flujo.`
    }
    }
`;
  }
  return `
    /**
     * Deja el estado como recién arrancado. Se invoca desde el \`@BeforeAll\` de cada
     * clase de flujo: el reset es <b>por flujo</b>, nunca entre escenarios — dentro
     * de un flujo, un escenario usa lo que dejó el anterior.
     *
     * <p>Cubre exactamente lo que enumera \`infra/reset-db.sh\`: datos de la BD, claves
     * de la caché, destinos de mensajería declarados${model.layersPresent.httpClients ? ' y los mappings y el log de\n     * peticiones del proveedor de prueba' : ''}. Un recurso que no esté en esa
     * lista <b>no</b> se puede dar por limpio.
     */
    protected static void resetState() {${inMemoryResetCalls(model)}${restore}${stopReplicaLine}
        runInfraScript("infra/reset-db.sh", "¿Está la infraestructura arriba?");${marks}
    }
`;
}

// Resolución del bash con el que se invocan los scripts de `infra/`. Vive en su
// propia sección porque tiene dos consumidores con condiciones distintas: el reset
// de estado y —solo con brokers cuya topología no sobrevive a un reinicio— la
// resiembra de startBroker(). Emitirlo dos veces no compila; emitirlo solo con el
// reset dejaba a la resiembra sin él en el stack sin script.
function bashExecutableSection(model) {
  if (!hasResetScript(model) && !needsBrokerReseed(model)) return '';
  return `
    /**
     * Ejecutable de bash con el que se invocan los scripts de \`infra/\`.
     *
     * <p>Dejar que {@code CreateProcess} resuelva {@code "bash"} por {@code PATH} es
     * ambiguo en Windows: {@code %SystemRoot%\\System32} se consulta antes que el resto
     * del {@code PATH} y ahí vive el lanzador de WSL, un entorno Linux aislado que no ve
     * el {@code PATH} ni las variables de Windows — los scripts fallan aunque funcionen
     * desde Git Bash. Se resuelve explícitamente el bash de Git for Windows, con override
     * por {@code BASH_EXECUTABLE}, y se cae a {@code "bash"} literal fuera de Windows.
     */
    private static String bashExecutable() {
        String configured = System.getenv("BASH_EXECUTABLE");
        if (configured != null && !configured.isBlank()) {
            return configured;
        }
        if (System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
            String[] candidates = {
                System.getenv("ProgramFiles") + "\\\\Git\\\\bin\\\\bash.exe",
                System.getenv("ProgramFiles(x86)") + "\\\\Git\\\\bin\\\\bash.exe",
                System.getenv("LOCALAPPDATA") + "\\\\Programs\\\\Git\\\\bin\\\\bash.exe",
                "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"
            };
            for (String candidate : candidates) {
                if (candidate != null && new File(candidate).isFile()) {
                    return candidate;
                }
            }
        }
        return "bash";
    }

    /**
     * Ejecuta un script de {@code infra/} y <b>captura su salida</b>, que es la evidencia.
     *
     * <p><b>Por qué no {@code inheritIO()}</b>, que es lo que había aquí: esa salida va a los
     * descriptores del worker de Gradle, no a {@code System.out}, así que no la recoge ni
     * {@code build/keel-scenarios/run.log} ni el {@code system-out} del XML de JUnit. El fallo
     * llegaba como «falló (código 1)» y nada más — imposible de diagnosticar sin reproducirlo, que
     * es justo lo que la regla de {@code score-scenarios.sh} evita: la causa de un rojo tiene que
     * llegar por stdout.
     *
     * <p><b>El probe se registra SIEMPRE</b>, no solo al fallar, y esa es la otra mitad. Un
     * {@code @BeforeAll} que revienta deja {@code build/keel-failures/&lt;Clase&gt;-init.json}, y ese
     * volcado resuelve el sondeo cayendo a un campo estático compartido por toda la JVM: sin
     * registrar el reset, el volcado de esta clase podía mostrar el comando de OTRA, presentado
     * como «el último comando ejecutado». Evidencia ajena con aspecto de propia es peor que
     * ninguna.
     *
     * <p>El mensaje lleva el final de la salida y no toda: el error está al final, y el caso bueno
     * de {@code reset-db.sh} imprime una línea por canal purgado. La salida completa viaja en el
     * probe hasta el volcado.
     */
    private static void runInfraScript(String script, String hint) {
        List<String> command = List.of(bashExecutable(), script);
        try {
            Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            int exit = process.waitFor();
            FailureCapture.recordProbe(command, exit, output);
            if (exit != 0) {
                throw new IllegalStateException(
                        script + " falló (código " + exit + "). " + hint + System.lineSeparator()
                                + lastLines(output));
            }
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo ejecutar " + script, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido ejecutando " + script, e);
        }
    }

    /** Las últimas líneas de una salida: donde está el error, sin arrastrar el resto. */
    private static String lastLines(String output) {
        if (output == null || output.isBlank()) {
            return "(el script no escribió nada)";
        }
        String[] lines = output.strip().split("\\\\R");
        int from = Math.max(0, lines.length - 12);
        return String.join(System.lineSeparator(), Arrays.copyOfRange(lines, from, lines.length));
    }
`;
}

// Acceso al contenedor devtools: lo que no es observable por HTTP (mensajes
// publicados en el broker) se comprueba con la CLI del stack, igual que hace
// infra/validate-infra.sh. Nunca con brokers embebidos: la infraestructura de
// validación es la que está levantada.
function devtoolsSection(model) {
  if (!usesDevtools(model)) return '';
  return `
    private static final String DEVTOOLS_CONTAINER = "${model.service.name}-devtools";
${brokerEntry(model) ? `
    /** Archivo del contenedor por el que viaja el cuerpo de {@link #deliverMessage}. */
    private static final String DELIVER_BODY = "/tmp/keel-deliver.json";
` : ''}${queryCountSection(model)}${brokerSection(model)}${outboxDrainSection(model)}${reconciliationAgingSection(model)}${deadLetteredOutboxSection(model)}${abandonOutboxSection(model)}${deadLetterSection(model)}${deliverySection(model)}${subscriptionDeliverySection(model)}
    /**
     * Ejecuta un comando dentro del contenedor devtools y devuelve su salida.
     *
     * <p>Los argumentos van siempre como <b>lista</b>, nunca concatenados en una
     * cadena para \`sh -c\`: en Windows, invocar \`docker.exe\`/\`podman.exe\` con una
     * cadena que lleva comillas escapadas hace que el cliente las reinterprete y
     * corrompa el comando antes de reenviarlo al contenedor (un cuerpo JSON llega
     * roto y el servidor responde 400 sin que se vea por qué). Para un pipeline de
     * verdad está {@link #devtoolsShell}, que lo hace explícito.
     */
    protected static String devtools(String... argv) {
        List<String> command = new ArrayList<>(List.of(containerRuntime(), "exec", DEVTOOLS_CONTAINER));
        command.addAll(List.of(argv));
        return runProcess(command);
    }

    /** Igual que {@link #devtools}, pero a través de un shell: pipes y redirecciones. */
    protected static String devtoolsShell(String command) {
        return devtools("sh", "-c", command);
    }
${cacheHelper(model)}${bodyFileHelper(model)}`;
}

// ─── Control del broker (escenarios de outbox) ───────────────────────────────
//
// La única palanca del arnés sobre la infraestructura viva, y existe por un motivo
// muy concreto: sin ella, el outbox NO es observable en caja negra. Un escenario que
// mute y compruebe que el evento acaba en el canal lo pasa igual de bien un servicio
// que publica directo contra el broker dentro de la transacción — es decir, no prueba
// el mecanismo, solo que hay eventos. Lo que distingue al outbox es que la petición
// se completa y el evento sobrevive AUNQUE el broker no estuviera disponible en ese
// instante; y para afirmar eso hay que poder quitar el broker de en medio.
//
// Solo se genera con `reliability: outbox`. En cualquier otro diseño detener el
// broker no prueba nada: la publicación es best-effort por contrato y el escenario
// que lo ejercitase estaría afirmando una garantía que el diseño no dio.
function usesBrokerControl(model) {
  return usesOutbox(model) && Boolean(brokerEntry(model)) && usesDevtools(model);
}

/**
 * ¿Tiene este diseño alguna garantia cuyo enunciado sea "arbitrado ENTRE replicas"?
 *
 * Son tres, y las tres se afirman en el codigo con un comentario que dice que varias
 * instancias no se pisan: el relay del outbox (reclama filas con bloqueo de escritura
 * y SKIP LOCKED), el barrido de reconciliación (@Scheduled corre en TODAS las réplicas,
 * así que tiene que reclamar y no solo leer) y el registro de idempotencia de petición
 * (la clave primaria arbitra dos peticiones que ni siquiera están en el mismo proceso).
 * Con una sola instancia las tres pasan sus escenarios sin que nada de eso se ejercite:
 * dos hilos de la misma JVM comparten pool y contexto.
 */
function usesReplica(model) {
  return usesOutbox(model) || hasScheduledOperation(model) || declaresIdempotency(model);
}

function hasScheduledOperation(model) {
  return (model.services ?? []).some((group) => group.operations.some((operation) => operation.schedule));
}

/**
 * La segunda replica: un proceso aparte, arrancado del jar que produce `bootJar`.
 *
 * No es un segundo contexto de Spring dentro de esta JVM, y la diferencia importa por
 * dos motivos. El de alcance: lo que se contrasta es que dos PROCESOS con pools,
 * planificadores y relojes propios no se pisan, y dos contextos en la misma JVM
 * comparten demasiado. Y el estructural: el source set de las pruebas deja
 * `src/main/java` fuera del compileClasspath -esa es la caja negra-, así que el arnés
 * no puede ni nombrar la clase de aplicación. Lanzar el jar respeta las dos cosas.
 */
function replicaSection(model) {
  if (!usesReplica(model)) return '';
  return REPLICA_BODY(model);
}

function REPLICA_BODY(model) {
  const onReplica = model.layersPresent.api
    ? `
    /**
     * Petición dirigida a la SEGUNDA réplica, no a la que arranca JUnit. Es lo que
     * permite que dos peticiones simultáneas con la misma clave lleguen a procesos
     * distintos: el caso que el registro de idempotencia existe para cerrar y el
     * unico que dos hilos de esta JVM no reproducen.
     */
    protected Response onReplica(HttpMethod method, String path, String jsonBody${model.layersPresent.security ? ', String token' : ''}${hasIdempotency(model) ? ', String idempotencyKey' : ''}) {
        if (REPLICA == null || !REPLICA.isAlive()) {
            throw new IllegalStateException("La réplica no está arrancada: llama antes a startReplica()");
        }
        return exchange(method, "http://localhost:" + REPLICA_PORT + path, jsonBody${model.layersPresent.security ? ', token' : ', null'}${hasIdempotency(model) ? ', idempotencyKey' : ', null'});
    }
${hasMultipart(model) ? `
    /**
     * Lo mismo, para una operación MULTIPART. No es un adorno: sin esto, un diseño cuya
     * mutación con clave de idempotencia es una subida —el caso de cualquier custodia de
     * archivos— no puede escribir su escenario de clúster, porque {@link #onReplica} solo
     * sabe mandar JSON. El escenario se queda sin ejercitar y lo que no se ejercita es
     * justo lo que el registro de idempotencia existe para cerrar: dos peticiones con la
     * misma clave en dos PROCESOS distintos.
     */
    protected Response onReplicaMultipart(String path, String partName, String filename, String contentType, byte[] content, Map<String, String> fields${model.layersPresent.security ? ', String token' : ''}${hasIdempotency(model) ? ', String idempotencyKey' : ''}) {
        if (REPLICA == null || !REPLICA.isAlive()) {
            throw new IllegalStateException("La réplica no está arrancada: llama antes a startReplica()");
        }
        return multipartTo("http://localhost:" + REPLICA_PORT + path, partName, filename, contentType, content, fields${model.layersPresent.security ? ', token' : ''}${hasIdempotency(model) ? ', idempotencyKey' : ', null'});
    }
` : ''}`
    : '';
  return `
    // -- Segunda réplica ------------------------------------------------------

    private static Process REPLICA;
    private static int REPLICA_PORT;

    /** Espera máxima a que la réplica acepte tráfico. Arrancar Spring no es instantáneo. */
    private static final Duration REPLICA_READY_TIMEOUT = Duration.ofSeconds(120);

    /**
     * Arranca una segunda instancia del servicio contra la MISMA infraestructura y
     * devuelve su puerto.
     *
     * <p>Es la palanca de los escenarios de clúster: con dos procesos vivos hay dos
     * relays del outbox y dos barridos compitiendo por las mismas filas, y una
     * peticion puede dirigirse a una réplica u otra. Sin esto, "lo arbitra la clave
     * primaria" y "cada réplica se lleva un lote disjunto" son afirmaciones razonadas
     * que ningún escenario toca.
     *
     * <p><b>El escenario que la arranca tiene que pararla</b>, en un {@code finally}:
     * una réplica viva sigue publicando y barriendo durante los flujos siguientes, que
     * fallarian por una causa ajena. Como red, {@link #resetState} la para al abrir
     * cada clase.
     *
     * <p>Requiere el jar en {@code build/libs}: lo deja {@code infra/score-scenarios.sh},
     * que ejecuta {@code bootJar} antes de la suite.
     */
    protected static int startReplica() {
        if (REPLICA != null && REPLICA.isAlive()) {
            return REPLICA_PORT;
        }
        Path jar = bootJar();
        REPLICA_PORT = freePort();
        Path log = Path.of("build", "keel-replica.log");
        try {
            Files.createDirectories(log.getParent());
            // La salida va a un archivo y no al pipe del proceso: un arranque de Spring
            // llena el búfer del pipe y, sin nadie leyéndolo, la réplica se queda
            // bloqueada escribiendo. Un cuelgue que parece un arranque lento.
            REPLICA = new ProcessBuilder(
                            javaExecutable(),
                            "-jar",
                            jar.toString(),
                            "--spring.profiles.active=local",
                            "--server.port=" + REPLICA_PORT,
                            // El endpoint de apagado, abierto SOLO para este proceso y por
                            // línea de comandos: la configuración de la aplicación no lo
                            // expone y no tiene por qué. Es lo que permite que
                            // stopReplica() cierre ordenadamente en cualquier sistema
                            // operativo — ver su javadoc, que explica qué se rompe sin esto.
                            // Solo 'access', que es la forma de Boot 3.4+ y la que corresponde a
                            // la versión que fija este generador. NO añadir también el 'enabled'
                            // de las versiones anteriores «por si acaso»: Boot las trata como
                            // MUTUAMENTE EXCLUYENTES y aborta el arranque con «Update your
                            // configuration so that only one of the mutually exclusive properties
                            // is configured». La réplica no llega a levantar y el escenario de
                            // clúster falla con «murió durante el arranque».
                            "--management.endpoints.web.exposure.include=health,shutdown",
                            "--management.endpoint.shutdown.access=unrestricted")
                    .redirectErrorStream(true)
                    .redirectOutput(log.toFile())
                    .start();
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo arrancar la segunda réplica desde " + jar, e);
        }
        awaitReplicaReady(log);
        return REPLICA_PORT;
    }

    /**
     * Para la réplica, <b>ordenadamente</b>. Idempotente: sobre una ya parada no hace nada.
     *
     * <p><b>Por qué el rodeo del actuator y no {@code destroy()} a secas.</b> En Linux
     * {@code Process.destroy()} manda un SIGTERM y Spring ejecuta su cierre: para los
     * contenedores de escucha, devuelve al broker lo que tuviera en vuelo y suelta el pool.
     * En Windows {@code destroy()} es {@code TerminateProcess} — un kill duro, sin hooks de
     * apagado. La réplica muere consumiendo, y cada mensaje que tuviera recibido se queda
     * <b>invisible</b> hasta que vence el {@code VisibilityTimeout} de su cola (60 s), muy por
     * encima del plazo de cualquier {@code await} de un escenario.
     *
     * <p>El síntoma no se parece en nada a su causa: el escenario SIGUIENTE entrega un mensaje,
     * nadie lo procesa dentro de su plazo y lo que se ve es «un estado no transicionó a tiempo»,
     * sin excepción, sin DLQ y sin pérdida — el mensaje sigue en la cola, invisible. Se diagnosticó
     * en la corrida {@code refunds-http} deshabilitando el escenario de clúster: sin él, el de al lado
     * pasaba; con él, fallaba las tres veces.
     *
     * <p>El endpoint de apagado lo abre {@link #startReplica()} por línea de comandos y solo para
     * la réplica: la configuración de la aplicación no lo expone, y este proceso es de usar y
     * tirar. El {@code destroy()} sigue detrás como red — una réplica que no se puede parar por
     * las buenas tiene que morir igual.
     */
    protected static void stopReplica() {
        if (REPLICA == null) {
            return;
        }
        requestReplicaShutdown();
        try {
            // Al apagado ordenado se le da un plazo corto: si no ha muerto, es que el endpoint
            // no respondió o el cierre se atascó, y entonces vale más matarla que esperarla.
            if (!REPLICA.waitFor(15, TimeUnit.SECONDS)) {
                REPLICA.destroy();
                if (!REPLICA.waitFor(30, TimeUnit.SECONDS)) {
                    REPLICA.destroyForcibly();
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            REPLICA.destroyForcibly();
        }
        REPLICA = null;
    }

    /**
     * Pide el cierre ordenado por el actuator. No lanza: si el endpoint no está o la réplica ya
     * no acepta tráfico, el que manda es el {@code destroy()} de quien llama.
     */
    private static void requestReplicaShutdown() {
        try {
            HttpURLConnection connection = (HttpURLConnection)
                    URI.create("http://localhost:" + REPLICA_PORT + "/actuator/shutdown").toURL().openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(5000);
            try {
                connection.getResponseCode();
            } finally {
                connection.disconnect();
            }
        } catch (IOException yaNoAtiende) {
            // La réplica ya no atiende: no hay cierre ordenado que pedir.
        }
    }
${onReplica}
    /** Localiza el jar ejecutable, descartando el -plain que Boot genera al lado. */
    private static Path bootJar() {
        Path libs = Path.of("build", "libs");
        try (Stream<Path> files = Files.list(libs)) {
            return files.filter(p -> p.getFileName().toString().endsWith(".jar"))
                    .filter(p -> !p.getFileName().toString().endsWith("-plain.jar"))
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException(
                            "No hay jar ejecutable en " + libs + ": ejecuta ./gradlew bootJar"));
        } catch (IOException e) {
            throw new IllegalStateException(
                    "No se puede leer " + libs + ": ejecuta ./gradlew bootJar antes de la suite", e);
        }
    }

    /** El mismo java que corre esta suite: no se depende de que haya uno en el PATH. */
    private static String javaExecutable() {
        return Path.of(System.getProperty("java.home"), "bin", "java").toString();
    }

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new IllegalStateException("No hay puerto libre para la réplica", e);
        }
    }

    private static void awaitReplicaReady(Path log) {
        Instant deadline = Instant.now().plus(REPLICA_READY_TIMEOUT);
        while (Instant.now().isBefore(deadline)) {
            if (!REPLICA.isAlive()) {
                throw new IllegalStateException(
                        "La réplica murió durante el arranque. Revisa " + log.toAbsolutePath());
            }
            if (replicaAccepts()) {
                return;
            }
            try {
                Thread.sleep(500L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrumpido esperando a la réplica", e);
            }
        }
        stopReplica();
        throw new IllegalStateException(
                "La réplica no respondió en " + REPLICA_READY_TIMEOUT + ". Revisa " + log.toAbsolutePath());
    }

    private static boolean replicaAccepts() {
        try {
            HttpURLConnection connection = (HttpURLConnection)
                    URI.create("http://localhost:" + REPLICA_PORT + "/actuator/health/readiness").toURL().openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1000);
            try {
                return connection.getResponseCode() == 200;
            } finally {
                connection.disconnect();
            }
        } catch (IOException notYet) {
            return false;
        }
    }
`;
}

// Brokers cuya topología NO sobrevive a un reinicio del contenedor. LocalStack sirve
// SNS/SQS desde memoria (sin PERSISTENCE), así que al arrancar de nuevo vuelve sin
// topics ni colas: lo que se perdería no es el mensaje, es el destino, y el escenario
// fallaría por «cola inexistente» en vez de por el outbox. La topología la siembra
// `infra/init-messaging.sh`, que es idempotente por diseño, así que la resiembra es
// literalmente el mismo script que usa el arranque de la infra. Kafka y RabbitMQ
// conservan la suya: `stop`/`start` no borra el sistema de archivos del contenedor.
function needsBrokerReseed(model) {
  return usesBrokerControl(model) && needsMessagingProvisioning(model);
}

// La sonda de topología es exclusiva de SNS/SQS: es el único broker de los tres en el que
// publicar contra un destino a medio sembrar SALE BIEN y descarta el mensaje. Con Kafka o
// RabbitMQ, publicar sin destino falla y el relay reintenta, que es lo que se quiere.
// Necesita además un evento propio que publicar como sonda y su cola de arnés, es decir,
// que el servicio publique algo.
/**
 * ¿Hay que parar el relay de la aplicación mientras se resiembra la topología?
 *
 * Solo donde el broker la PIERDE al reiniciar, que es lo mismo que decide `needsBrokerReseed`
 * (LocalStack la sirve de memoria; Kafka y RabbitMQ la conservan). Donde no se pierde no hay
 * ventana que cerrar, y un mecanismo de más ahí solo añade una forma de romperse.
 *
 * Y hace falta el outbox: sin relay no hay nadie publicando por su cuenta.
 */
function pausesRelay(model) {
  return needsBrokerReseed(model) && usesOutbox(model);
}

function needsTopologyProbe(model) {
  return needsBrokerReseed(model) && model.stack?.broker === 'snssqs' && (model.events ?? []).length > 0;
}

/**
 * La sonda que confirma que la suscripción SNS→SQS resembrada ENTREGA, no solo que
 * existe. Ver `needsTopologyProbe` para por qué solo aquí.
 *
 * Se lee el broker directamente (sin `publishedMessages`) a propósito: `BROKER_STOPPED`
 * sigue en `true` mientras esto corre, así que un fallo de transporte real durante el
 * sondeo se toleraría en silencio si pasara por el camino normal.
 */
function topologyProbeMethods(model) {
  if (!needsTopologyProbe(model)) return '';
  // El evento y SU CANAL se eligen juntos, no por separado. La sonda se publica con
  // `eventType` en los atributos, y la suscripción de cada cola de arnés lleva un FILTRO
  // por ese campo (messaging-provisioning.js § harnessQueues): leer de la cola de otro
  // canal no entregaría la sonda aunque la URL fuese válida.
  const probe = model.events[0];
  const probeEvent = probe.name;
  // De dónde se LEE, que no es dónde se publica. Sale del resolutor canónico y no de una
  // composición a mano — ver el javadoc de las dos constantes de abajo.
  //
  // El canal se busca por el FILTRO de la cola, no en `probe.channel`: un evento que no declara
  // canal lo tiene igual —el modelo lo deriva del destino del servicio— y ahí el campo crudo es
  // null. Interpolarlo daba la cadena literal "null", y el `receive-message` contra
  // `.../000000000000/null` fallaba ANTES de que startBroker() soltara BROKER_STOPPED: el flag
  // se quedaba en true para toda la JVM y arrastraba a initializationError a cada clase
  // posterior. Llegó a bloquear 7 de 22 escenarios. Buscarlo por el eventType es además el
  // mismo criterio que el comentario de arriba: la cola entrega solo lo que su filtro admite.
  const probeChannel =
    Object.entries(model.messaging?.eventTypesByChannel ?? {}).find(([, events]) =>
      (events ?? []).includes(probe.name)
    )?.[0] ?? probe.channel;
  const probeQueue = publishedDestination(model.stack?.broker, model, probeChannel);
  return `
    /**
     * Topic al que se PUBLICA la sonda: el destino único del servicio, que es a lo que
     * {@code deliverMessage} le antepone el ARN.
     */
    private static final String TOPOLOGY_PROBE_DESTINATION = "${model.messaging.destinationDefault}";

    /**
     * Cola de la que se LEE la sonda, que <b>no</b> es la de arriba.
     *
     * <p>En SNS/SQS el destino de publicación es un TOPIC, y de un topic no se lee: el
     * aprovisionamiento cuelga de él una cola de arnés cuyo nombre es el del CANAL
     * ({@code infra/init-messaging.sh}). Usar el mismo nombre para las dos mitades pide un
     * {@code sqs receive-message} contra una cola que no existe — y eso no fallaba en un
     * sitio inocuo: {@link #startBroker()} no llega a soltar {@code BROKER_STOPPED}, el flag
     * se queda en {@code true} para toda la JVM y cada clase de flujo posterior muere en su
     * {@code @BeforeAll}. Con el flag puesto, además, {@code emptyIfBrokerStopped} da por
     * «canal vacío» cualquier fallo de lectura: las aserciones negativas saldrían verdes sin
     * mirar nada.
     */
    private static final String TOPOLOGY_PROBE_QUEUE = "${probeQueue}";

    /** Cuánto se espera, tras cada intento de sonda, a que llegue a la cola de arnés. */
    private static final Duration TOPOLOGY_PROBE_ATTEMPT_TIMEOUT = Duration.ofSeconds(5);

    /**
     * Confirma que la suscripción SNS→SQS recién sembrada por {@link #reseedTopology}
     * entrega de verdad, no solo que el topic y la cola existen.
     *
     * <p>SNS acepta un {@code publish} contra un topic recién creado aunque su suscripción
     * todavía no esté wireada, y no lo hace fallar: entrega EN EL MOMENTO, así que sin
     * suscriptor el mensaje se descarta sin ningún error observable. El {@code OutboxRelay}
     * de la aplicación sondea de forma autónoma —no coordinada con este arnés— y puede
     * publicar justo en esa ventana: marca la fila {@code published_at} y pierde el evento
     * para siempre, porque desde su punto de vista el publish tuvo éxito. Publicar una sonda
     * y esperar su llegada cierra la ventana <b>antes</b> de devolver el control al test:
     * {@link #startBroker()} no libera {@code BROKER_STOPPED} hasta que esto confirma la
     * entrega end-to-end.
     *
     * <p>Reintenta la sonda entera hasta {@link #BROKER_READY_TIMEOUT}: la primera puede
     * perderse por la misma razón que esto existe para detectar, así que una sonda perdida
     * no es un fallo — es la señal de reintentar.
     */
    private static void awaitTopologyWired() {
        Instant deadline = Instant.now().plus(BROKER_READY_TIMEOUT);
        while (true) {
            String probeId = "keel-topology-probe-" + UUID.randomUUID();
            deliverMessage(
                    TOPOLOGY_PROBE_DESTINATION,
                    probeId,
                    "{\\"metadata\\":{\\"eventId\\":\\"" + probeId + "\\",\\"eventType\\":\\"${probeEvent}\\"},\\"data\\":{}}",
                    Map.of("eventType", "${probeEvent}"));
            if (topologyProbeArrived(probeId)) {
                return;
            }
            if (Instant.now().isAfter(deadline)) {
                throw new IllegalStateException(
                        "La suscripción SNS→SQS de '" + TOPOLOGY_PROBE_DESTINATION + "' → '"
                                + TOPOLOGY_PROBE_QUEUE
                                + "' no entregó la sonda de verificación tras resembrar la topología en "
                                + BROKER_READY_TIMEOUT + ": el wiring SNS→SQS no llegó a tiempo.");
            }
        }
    }

    /**
     * Sondea la cola de arnés hasta encontrar la sonda, y la retira <b>solo a ella</b> por
     * su {@code ReceiptHandle}.
     *
     * <p>Un {@code purge-queue} aquí sería el defecto simétrico al que este método cierra:
     * el relay puede publicar un evento de negocio real mientras la sonda está en vuelo, y
     * cae en la <b>misma</b> cola de arnés. Purgarla entera se lo llevaría por delante, el
     * {@code Then} nunca vería su mensaje y el {@code await} agotaría su espera contra un
     * evento que sí se publicó y que el outbox ya dio por entregado. No es hipotético: la
     * primera versión de este arreglo usaba purge y reprodujo exactamente eso.
     */
    private static boolean topologyProbeArrived(String probeId) {
        Instant attemptDeadline = Instant.now().plus(TOPOLOGY_PROBE_ATTEMPT_TIMEOUT);
        while (Instant.now().isBefore(attemptDeadline)) {
            String raw = aws("sqs", "receive-message", "--queue-url",
                    QUEUE_URL + TOPOLOGY_PROBE_QUEUE, "--max-number-of-messages", "10", "--visibility-timeout", "0");
            for (Map<String, Object> message : receivedMessages(raw)) {
                Object body = message.get("Body");
                if (body != null && String.valueOf(body).contains(probeId)) {
                    aws("sqs", "delete-message", "--queue-url", QUEUE_URL + TOPOLOGY_PROBE_QUEUE,
                            "--receipt-handle", String.valueOf(message.get("ReceiptHandle")));
                    return true;
                }
            }
            try {
                Thread.sleep(200L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrumpido esperando la sonda de topología", e);
            }
        }
        return false;
    }

    // receivedMessages lo emite la rama SNS/SQS de brokerSection, que es donde vive la
    // lectura de mensajes. La sonda solo existe con ese broker, así que lo tiene siempre.
`;
}

/**
 * Parar y reanudar el `@Scheduled` del relay de la aplicación durante la resiembra.
 *
 * Es la SEGUNDA mitad de lo que cierra `awaitTopologyWired`, y las dos hacen falta: la sonda
 * confirma la entrega para sí misma, pero no puede cerrar la ventana para un publicador que
 * corre en paralelo. Sin esta pausa, el relay publica en el hueco que va del topic recreado a
 * su suscripción wireada — SNS acepta el publish, descarta el mensaje sin error, y el relay
 * marca `published_at`: el evento de negocio se pierde para siempre.
 *
 * Sobre la caja negra, que es lo que primero llama la atención aquí: `conventions/
 * integration-tests.md` prohibe COMPILAR contra `src/main/java`, que está fuera del
 * compileClasspath. `main` sí está en el runtimeClasspath, y resolver un bean por NOMBRE
 * devuelve `Object`, así que no se importa ninguna clase suya. Es el mismo terreno en el que
 * el arnés ya vacía por reflexión el caché de OAuth2.
 */
function relayPauseMethods(model) {
  if (!pausesRelay(model)) return '';
  return `
    /**
     * El relay en el contexto de Spring. El nombre lo deriva build de la clase que él mismo
     * genera (scaffold/outbox.js), no se escribe aquí: si se renombrara la clase, un literal
     * a este lado dejaría la pausa sin efecto y en silencio.
     */
    private static final String OUTBOX_RELAY_BEAN = "${outboxRelayBeanName()}";

    private static final AtomicBoolean OUTBOX_RELAY_PAUSED = new AtomicBoolean(false);

    /**
     * Detiene las tareas programadas del relay mientras la topología se recrea.
     *
     * <p><b>Por qué.</b> {@link #startBroker()} reinicia el contenedor entero, y con él se
     * pierden destinos y suscripciones. Entre que {@code infra/init-messaging.sh} recrea el
     * destino y que su suscripción queda wireada hay una ventana en la que el broker
     * <b>acepta</b> la publicación y descarta el mensaje sin error. El relay sondea por su
     * cuenta, no coordinado con este arnés: si cae ahí, marca la fila como publicada y el
     * evento no existe para nadie.
     *
     * <p><b>Cómo.</b> Por el {@code ScheduledAnnotationBeanPostProcessor} del propio contexto:
     * {@code postProcessBeforeDestruction} cancela las tareas registradas para ese bean y
     * {@code postProcessAfterInitialization} vuelve a registrarlas. No se toca el código de la
     * aplicación ni su configuración, y el bean se resuelve por nombre — su clase vive en
     * {@code src/main/java}, que este source set no compila.
     *
     * <p><b>Falla ruidosamente si no cancela nada.</b> Una pausa que no pausa deja el defecto
     * igual que antes pero con la apariencia de estar arreglado, y su síntoma —un evento
     * perdido cada varias corridas— cuesta un ciclo entero de arbitraje.
     */
    protected static void pauseOutboxRelay() {
        ApplicationContext context = CONTEXT;
        if (context == null || !context.containsBean(OUTBOX_RELAY_BEAN)) {
            return;
        }
        if (!OUTBOX_RELAY_PAUSED.compareAndSet(false, true)) {
            return;
        }
        ScheduledAnnotationBeanPostProcessor processor =
                context.getBean(ScheduledAnnotationBeanPostProcessor.class);
        int before = processor.getScheduledTasks().size();
        processor.postProcessBeforeDestruction(context.getBean(OUTBOX_RELAY_BEAN), OUTBOX_RELAY_BEAN);
        if (processor.getScheduledTasks().size() >= before) {
            OUTBOX_RELAY_PAUSED.set(false);
            throw new IllegalStateException(
                    "No se canceló ninguna tarea programada de '" + OUTBOX_RELAY_BEAN + "': la pausa del "
                            + "relay no está surtiendo efecto, y sin ella la resiembra pierde eventos en silencio.");
        }
    }

    /** Vuelve a registrar las tareas del relay. El registrar ya tiene scheduler: se replanifican en el acto. */
    protected static void resumeOutboxRelay() {
        ApplicationContext context = CONTEXT;
        if (context == null || !OUTBOX_RELAY_PAUSED.compareAndSet(true, false)) {
            return;
        }
        ScheduledAnnotationBeanPostProcessor processor =
                context.getBean(ScheduledAnnotationBeanPostProcessor.class);
        processor.postProcessAfterInitialization(context.getBean(OUTBOX_RELAY_BEAN), OUTBOX_RELAY_BEAN);
    }
`;
}

/**
 * El cuerpo de `startBroker`. Va aparte porque con resiembra se envuelve en un try/finally
 * —el relay de la aplicación tiene que estar parado durante toda ella— y eso cambia la
 * indentación de todo el bloque: resolverla aquí evita el Java válido y torcido que sale de
 * concatenar un `try {` delante de unas líneas ya indentadas.
 */
function startBrokerBody(model, reseed) {
  const core = [
    'runProcess(List.of(containerRuntime(), "start", BROKER_CONTAINER));',
    'awaitBrokerReady();',
    // `reseed` viene ya indentado para el cuerpo sin envolver: aquí se normaliza a
    // sangría cero y se vuelve a aplicar la que toque más abajo.
    ...reseed.split('\n').map((line) => line.trim()).filter(Boolean),
    '// Se limpia DESPUÉS del sondeo: entre el `start` y el primer listener que',
    '// responde el broker sigue sin servir, y una lectura ahí tiene que tolerarse',
    '// igual que durante la parada.',
    'BROKER_STOPPED.set(false);'
  ];
  const indent = (pad) => core.map((line) => `${pad}${line}`).join('\n');

  if (!pausesRelay(model)) return `${indent('        ')}\n`;
  return `        // El relay de la aplicación no puede publicar mientras la topología se recrea:
        // ver pauseOutboxRelay(). Una pasada suya que estuviera en vuelo AHORA publica
        // contra un broker todavía parado, así que falla y la fila se conserva — la
        // pérdida solo ocurre con el destino ya recreado y sin suscripción detrás.
        pauseOutboxRelay();
        try {
${indent('            ')}
        } finally {
            // En el finally y no al final: si la resiembra o el wiring lanzan, dejar el
            // relay pausado convertiría un fallo en otro distinto y mucho peor — un
            // servicio que deja de publicar sin que nadie lo note.
            resumeOutboxRelay();
        }
`;
}

/**
 * La secuencia «entregar con el broker vivo y tumbarlo después», como CÓDIGO.
 *
 * El javadoc de `awaitBrokerStopped` la documentaba en prosa desde el principio, y ningún flujo
 * la usaba: en la corrida `refunds-http`, `awaitBrokerStopped()` no estaba invocado en todo el
 * proyecto y el escenario que la necesitaba (`FL-OBX-005`) la escribió a mano con el orden
 * cambiado — fallaba con un error de fontanería, no con una aserción. Una secuencia que hay que
 * recordar en el orden correcto no es documentación: es un helper que falta.
 *
 * Solo con relay que pausar: sin outbox no hay nada que adelantarse a la parada, y `stopBroker()`
 * antes de entregar bastaría.
 */
function deliverThenDownHelper(model) {
  if (!pausesRelay(model)) return '';
  return `
    /**
     * Entrega un evento ENTRANTE con el broker todavía arriba y, acto seguido, lo tumba para
     * ejercitar la parte del escenario cuyo {@code Then} afirma sobre un canal de SALIDA caído.
     *
     * <p><b>Por qué existe.</b> {@link #stopBroker()} es todo-o-nada —para el contenedor
     * entero—, así que un escenario cuyo {@code When} es un evento entrante (que necesita el
     * broker vivo para entregarse) y cuyo {@code Then} exige el canal saliente caído no puede
     * llamar a {@link #stopBroker()} antes de entregar: la entrega tampoco llegaría. El orden
     * correcto es pausar el relay para que no se adelante, entregar, tumbar DESPUÉS y confirmar
     * con {@link #awaitBrokerStopped()} que ya no acepta conexiones antes de afirmar nada.
     *
     * <p>Va aquí, en un único sitio, para que ningún flujo lo reescriba a mano y se equivoque de
     * orden — que es exactamente lo que ocurrió la primera vez que un escenario lo necesitó.
     *
     * @param delivery   entrega el evento entrante; corre con el broker arriba y el relay en
     *                   pausa. Normalmente un {@code deliverXxx(...)} más, si el escenario lo
     *                   pide, el {@code await(...)} sobre el efecto de esa entrega que NO
     *                   dependa de que el canal saliente publique nada (un estado leído por la
     *                   propia API, por ejemplo).
     * @param whileDown  la aserción sobre el canal saliente caído; corre ya con
     *                   {@link #awaitBrokerStopped()} confirmado.
     */
    protected static void deliverThenTakeBrokerDown(Runnable delivery, Runnable whileDown) {
        pauseOutboxRelay();
        try {
            delivery.run();
            stopBroker();
            awaitBrokerStopped();
            whileDown.run();
        } finally {
            // Restaurar el broker es obligatorio: un escenario que no lo hace envenena los
            // flujos siguientes. {@link #startBroker()} reanuda el relay por su cuenta al
            // final, pero el resume explícito va igual — depender de esa reanudación ajena
            // deja el equilibrio de la pausa en manos de otro método, y una pausa que no se
            // deshace es un servicio que deja de publicar sin que nadie lo note. Es idempotente.
            startBroker();
            resumeOutboxRelay();
        }
    }
`;
}

function brokerControlSection(model) {
  if (!usesBrokerControl(model)) return '';
  const broker = brokerEntry(model);
  // La resiembra por sí sola NO basta con SNS/SQS, y ese fue el fallo intermitente más
  // caro de diagnosticar de la corrida del 14/08/2026: verde en aislamiento, rojo bajo la
  // suite completa. `sns publish` contra un topic que existe pero cuya suscripción SNS→SQS
  // todavía no está wireada **no falla** — SNS entrega en el momento, así que sin
  // suscriptor el mensaje se descarta sin error. El OutboxRelay de la app sondea por su
  // cuenta, sin coordinarse con el arnés, y puede publicar justo en esa ventana: marca la
  // fila `published_at` y pierde el evento para siempre. Confirmar la entrega END-TO-END
  // con una sonda antes de devolver el control es lo único que cierra la ventana.
  const wireCheck = needsTopologyProbe(model) ? `
        awaitTopologyWired();` : '';
  const reseed = needsBrokerReseed(model)
    ? `
        reseedTopology();${wireCheck}`
    : '';
  const reseedMethod = needsBrokerReseed(model)
    ? `
    /**
     * Vuelve a sembrar la topología de ${broker.label}: al reiniciar el contenedor se
     * pierden topics y colas, y sin destino el escenario fallaría por una causa que no
     * es la que está probando. Es el mismo script del arranque de la infra, que es
     * idempotente a propósito.
     */
    private static void reseedTopology() {
        runInfraScript("infra/init-messaging.sh", "La topología no quedó sembrada tras levantar el broker, "
                + "así que el escenario siguiente fallará por «destino inexistente» y no por lo que prueba.");
    }
${topologyProbeMethods(model)}${relayPauseMethods(model)}`
    : '';
  return `
    /** Contenedor de ${broker.label} en \`infra/docker-compose.yaml\`. */
    private static final String BROKER_CONTAINER = "${brokerContainer(model.service.name, broker)}";

    /** Espera máxima a que el broker vuelva a aceptar conexiones tras levantarlo. */
    private static final Duration BROKER_READY_TIMEOUT = Duration.ofSeconds(90);

    /**
     * Detiene el contenedor del broker. Es la palanca de los escenarios de
     * <b>outbox</b>: con el broker caído, una mutación tiene que responder igual y el
     * canal tiene que seguir vacío — ahí es donde un servicio que publica directo
     * dentro de la transacción se separa de uno que escribe en el outbox.
     *
     * <p><b>El escenario que lo llama tiene que restaurarlo</b>, y la forma correcta es
     * un {@code finally}: dejarlo caído envenena todos los flujos siguientes de la
     * misma suite, que fallarían por una causa ajena. Como red, {@link #resetState}
     * vuelve a levantarlo al principio de cada clase de flujo, así que un test que
     * muriera antes de su {@code finally} no arrastra el fallo más allá de su flujo.
     *
     * <p>No sustituye a nada: es infraestructura real parándose, no un doble.
     */
    protected static void stopBroker() {
        runProcess(List.of(containerRuntime(), "stop", BROKER_CONTAINER));
        // A partir de aquí, un fallo de TRANSPORTE al leer el canal es el efecto
        // buscado, no una infraestructura rota: ver {@link #brokerIntentionallyStopped}.
        BROKER_STOPPED.set(true);
    }

    /**
     * Levanta el contenedor del broker y <b>espera a que acepte conexiones</b>. Las dos
     * mitades importan: que el contenedor esté arrancado no es que el broker sirva, y
     * seguir sin esperar deja al escenario afirmando sobre un canal que todavía no
     * responde. El sondeo es el mismo que usa \`infra/validate-infra.sh\`.
     */
    protected static void startBroker() {
${startBrokerBody(model, reseed)}    }

    /**
     * ¿Tiró el broker el propio escenario? Es la diferencia entre el fallo que se
     * tolera y el que tiene que doler.
     *
     * <p>Leer el canal con el broker parado falla por <b>transporte</b>, no por «destino
     * desconocido», así que la tolerancia que existe para el destino que aún no se ha
     * creado no cubre este caso — y sin cubrirlo, el \`Then\` que afirma que <b>el canal
     * sigue vacío durante la caída</b> no es asertable. Ese \`Then\` es justo la mitad
     * negativa que separa un outbox de una publicación en línea: sin él, el escenario
     * del canal indisponible lo pasa igual un servidor que no tiene outbox ninguno.
     *
     * <p>Lo que NO se tolera, y por eso esto es un flag y no un \`catch\` ancho: una
     * infraestructura caída por su cuenta sigue reventando la suite en el sitio donde
     * se cae. Solo se perdona la indisponibilidad que el escenario provocó a propósito
     * y de la que es responsable de recuperarse.
     */
    private static final AtomicBoolean BROKER_STOPPED = new AtomicBoolean(false);

    /**
     * Restaura el broker si algún escenario lo dejó caído — y <b>solo</b> entonces.
     *
     * <p>El reset abre CADA clase de flujo, así que esto corre decenas de veces por
     * suite. Levantar un contenedor ya arrancado es barato, pero lo que cuelga de
     * {@link #startBroker()} no lo es: con un broker cuya topología no sobrevive al
     * reinicio, ahí dentro hay una resiembra y una sonda de entrega end-to-end que
     * espera hasta {@link #BROKER_READY_TIMEOUT}. Hacerlas cuando nadie tiró el broker
     * es trabajo inútil que, bajo la carga de la suite completa, agota su espera y mata
     * la clase entera por una causa que no es la suya.
     *
     * <p>El flag ya existe y es fiable: los tests corren en una sola JVM (sin
     * {@code forkEvery}), así que sobrevive entre clases. Si el escenario que lo tiró no
     * llegó a su \`finally\`, el flag sigue en \`true\` y esto lo restaura igual — que es
     * justo para lo que está.
     */
    private static void restoreBroker() {
        if (BROKER_STOPPED.get()) {
            startBroker();
        }
    }

    /**
     * Confirma que el broker parado por {@link #stopBroker()} <b>ya no acepta
     * conexiones</b>, en vez de darlo por hecho porque el comando de parada haya
     * devuelto el control.
     *
     * <p><b>Para qué existe.</b> Un escenario que entrega un evento ENTRANTE —que
     * necesita el broker arriba— y acto seguido tumba el canal de SALIDA tiene una
     * ventana de carrera real: el {@code stop} del contenedor tarda en cortar
     * conexiones de verdad, y lo que publique por su cuenta en esa ventana llega. El
     * escenario que afirma «el canal sigue vacío con el broker caído» pasaría por
     * casualidad de timing y no porque el mecanismo lo garantice.
     *
     * <p>Se llama <b>después</b> de {@link #stopBroker()}, y solo cuando el escenario
     * necesita esa certeza antes de soltar algo que publica solo.${pausesRelay(model)
      ? ` El caso típico —entregar
     * un evento entrante y tumbar el canal de salida— <b>no se escribe a mano</b>: está
     * resuelto en {@link #deliverThenTakeBrokerDown(Runnable, Runnable)}, que hace la
     * secuencia entera en el orden correcto y restaura en su {@code finally}. Esta secuencia
     * estuvo aquí en prosa y ningún flujo la usó: el primero que la necesitó la reescribió con
     * el orden cambiado.`
      : ''}
     */
    protected static void awaitBrokerStopped() {
        Instant deadline = Instant.now().plus(BROKER_READY_TIMEOUT);
        while (Instant.now().isBefore(deadline)) {
            if (!brokerAccepts()) {
                return;
            }
            try {
                Thread.sleep(200L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrumpido esperando a que el broker se detenga", e);
            }
        }
        throw new IllegalStateException(
                "${broker.label} sigue aceptando conexiones " + BROKER_READY_TIMEOUT
                        + " después de stopBroker(): la parada no surtió efecto real.");
    }
${deliverThenDownHelper(model)}

    private static void awaitBrokerReady() {
        Instant deadline = Instant.now().plus(BROKER_READY_TIMEOUT);
        while (Instant.now().isBefore(deadline)) {
            if (brokerAccepts()) {
                return;
            }
            try {
                Thread.sleep(500L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrumpido esperando al broker", e);
            }
        }
        throw new IllegalStateException("${broker.label} no volvió a aceptar conexiones en " + BROKER_READY_TIMEOUT);
    }

    /**
     * Sondeo de disponibilidad. Aquí el fallo <b>no</b> es un error: mientras el broker
     * arranca, el comando falla porque tiene que fallar. Por eso es el único sitio del
     * arnés donde se traga la excepción de {@link #runProcess}.
     */
    private static boolean brokerAccepts() {
        try {
            devtoolsShell(${javaString(broker.cliValidateCmd)});
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
${reseedMethod}`;
}

/**
 * El helper que escribe un UUID dentro de una sentencia a mano, con la forma que pide el
 * motor elegido.
 *
 * Existe porque tres clases de flujo de una misma corrida lo adivinaron mal, cada una por su
 * cuenta: en MySQL, Hibernate mapea `java.util.UUID` a `binary(16)`, y el literal en texto
 * plano no casa con ninguna fila NI da error — un WHERE devuelve vacío y un INSERT mete
 * basura. Eso no se lee como «he escrito mal el SQL»: se lee como que el servicio no hizo lo
 * que tenía que hacer, y se arbitra dos veces antes de mirar aquí.
 *
 * Solo se emite donde el motor declara su forma en `stack-catalog.js`. En los que no la
 * declaran no se inventa ninguna: un helper que devuelva lo que le parezca es peor que no
 * tenerlo, porque su nombre promete que está resuelto.
 */
function uuidLiteralHelper(model) {
  const entry = dbEntry(model);
  if (!entry?.uuidLiteral) return '';
  // La expresión Java que produce el literal SQL: los dos trozos del catalogo, con el
  // identificador concatenado en medio. Nada de interpolar Java dentro de una funcion que
  // compone SQL — ver el comentario de `uuidLiteral` en stack-catalog.js.
  const { prefix, suffix } = entry.uuidLiteral;
  const example = `${javaString(prefix)} + id + ${javaString(suffix)}`;
  const optimistic = model.persistenceKind === 'document' ? null : 'lock_version';
  return `
    /**
     * Un UUID escrito para una sentencia de {@link #db}, con la forma que pide ${entry.label}.
     *
     * <p>No es azucarillo: aquí la columna no es texto, y un literal en texto plano no casa
     * con ninguna fila <b>ni da error</b> — el WHERE sale vacío y el INSERT guarda algo que
     * luego no encuentra nadie. El síntoma no se parece a un SQL mal escrito, se parece a un
     * servicio que no hizo su trabajo.
     *
     * <pre>db(..., "SELECT status FROM &lt;tabla&gt; WHERE id = " + uuidLiteral(id));</pre>${
       optimistic
         ? `
     *
     * <p>Y la otra que se adivina mal: la columna del bloqueo optimista se llama
     * {@code ${optimistic}}, no {@code version}. Una fila sembrada sin ella (o con el nombre
     * equivocado) falla al primer UPDATE del servicio.`
         : ''
     }
     */
    protected static String uuidLiteral(String id) {
        return ${example};
    }
`;
}

// Vaciado de la caché a mitad de escenario. La orden es literalmente la misma que
// ejecuta infra/reset-db.sh (fuente única en devtools.js): un helper que borrase un
// conjunto distinto del que borra el reset dejaría al escenario midiendo un estado
// que ningún flujo puede reproducir.
function cacheHelper(model) {
  const cache = model.stack.cache ? CACHES[model.stack.cache] : null;
  if (!cache) return '';
  return `
    /**
     * Vacía las claves \`${model.service.artifactId}:*\` de la caché: las entradas
     * cacheadas y las claves de idempotencia, que comparten prefijo por convención.
     *
     * <p>Es el subconjunto de caché de {@link #resetState()}, con su misma orden. Vale
     * para el Then que necesita medir un <i>miss</i> a mitad de flujo —que un dato se
     * volvió a pedir al proveedor tras invalidarse— sin llevarse por delante los datos
     * que dejaron los escenarios anteriores del mismo flujo.
     */
    protected static void clearCache() {
        devtoolsShell(${javaString(cacheFlushCmd(cache, model.service))});
    }
`;
}

// Acceso a la base de datos desde el arnés. Solo resuelve runtime y CONTENEDOR: el
// comando lo escribe el escenario, porque lo que quiere comprobar es suyo. El
// contenedor no es siempre el mismo —con Mongo y Oracle la CLI vive dentro del
// propio contenedor de la BD (cliVia 'dbcontainer'), no en el toolbox—, y esa es
// justo la parte que no se puede escribir a mano en una clase de prueba sin
// duplicar la regla que ya aplican validate-infra.sh y reset-db.sh.
// Sentencia de ejemplo del javadoc de `db`. Es una LECTURA de una tabla que el
// diseño garantiza (la raíz del primer agregado), y no un `SELECT 1`: lo que el
// ejemplo tiene que enseñar es la sentencia entrando entera como un elemento del
// argv, comillas incluidas — un ejemplo sin comillas no distingue las dos formas,
// que es justo lo que hay que distinguir.
function exampleStatement(entry) {
  // Sin `<…>` en los marcadores de posición: el javadoc los leería como etiquetas
  // HTML desconocidas y doclint los reporta, incluso dentro de un <pre>.
  //
  // El ejemplo documental NO filtra por un enum: era lo único con pinta de enum que el arnés
  // ponía delante de quien escribe el SQL, y lo mostraba en minúsculas —la forma del cable, no
  // la de la columna—. Un ejemplo que enseña el valor equivocado es peor que no tenerlo: la
  // tabla de valores reales va aparte, en el javadoc de `db`.
  if (entry.kind === 'document') return 'db.getCollection("la_coleccion").countDocuments({ archived: true })';
  return "SELECT id FROM la_tabla WHERE slug = 'ejemplo'";
}

/**
 * Los enums que de verdad llegan a una columna, con sus valores ALMACENADOS.
 *
 * Quien escribe el SQL de un fixture no puede leer `src/main/java` (el source set deja `main`
 * fuera de su compileClasspath), así que todo lo que ve del enum —`specs/`, `openapi.yaml`, el
 * `@JsonValue`— muestra el literal del diseño en minúsculas. Pero la columna guarda `name()`, o
 * sea la constante: `@Enumerated(EnumType.STRING)` en la rama relacional y la serialización por
 * defecto de Spring Data en la documental. Esa asimetría el generador la conoce —la documenta en
 * web.js y hasta genera un converter para cerrarla en el borde HTTP— y nunca cruzaba hasta aquí.
 * El coste de no cruzarla fue una clase entera caída desde su `@BeforeAll` con un
 * `initializationError` sin causa visible: `SET status = 'sending'` contra un
 * `check (status in ('QUEUED','SENDING',…))`.
 *
 * Solo los de entidades PERSISTIDAS: los demás no aparecen en ninguna columna y serían ruido.
 */
/** El bloque del javadoc de `db` con los valores almacenados, o vacío si el diseño no tiene enums. */
function enumValuesDoc(model) {
  const enums = persistedEnums(model);
  if (enums.length === 0) return '';
  const rows = enums
    .map((enumDef) => `     * ${enumDef.name}: ${enumDef.values.map((value) => value.constant).join(', ')}`)
    .join('\n');
  return `
     *
     * <p><b>Valores tal como se GUARDAN.</b> La columna lleva el nombre de la constante, no el
     * literal del diseño que viaja en JSON: el que ves en \`specs/\` y en \`openapi.yaml\` es el
     * del cable. Un WHERE con el literal no casa ninguna fila, y un UPDATE con él choca contra la
     * restricción de la columna y se lleva la clase entera desde su \`@BeforeAll\`.
     * <pre>
${rows}
     * </pre>`;
}

function persistedEnums(model) {
  const referenced = new Set();
  for (const entity of model.entities ?? []) {
    if (!entity.persisted) continue;
    for (const field of entity.fields ?? []) {
      if (field.kind === 'enum' && field.javaType) referenced.add(field.javaType);
    }
  }
  return (model.enums ?? []).filter((enumDef) => referenced.has(enumDef.name));
}

// El script de mongosh viaja por ARCHIVO, nunca por `--eval` en el argv.
//
// Este generador ya sabía que el cliente de contenedores corrompe las comillas dobles
// incrustadas en Windows —`copyIntoContainer` existe exactamente por eso, para los cuerpos
// del broker— y aun así emitía la consulta del outbox como `--eval "db.getCollection(\"x\")..."`,
// y el javadoc de `db(...)` enseñaba esa forma como la correcta. En la corrida documental el
// arnés cayó con `ReferenceError: outbox_event is not defined` y `score-scenarios.sh` salió
// con código 2: la suite entera sin ejercitarse, por el ejemplo que el propio arnés predicaba.
//
// La URI va DENTRO del helper, no como parámetro: es la misma para todo el mundo, y pedirla
// por argumento es una invitación a que alguien la escriba a mano con otro `authSource`.
function mongoEvalHelper(scriptArgv) {
  if (!scriptArgv) return '';
  return `
    /** Dónde se deja el script dentro del contenedor de la base. */
    private static final String DB_SCRIPT = "/tmp/keel-eval.js";

    /**
     * Ejecuta un script de mongosh contra la base de prueba.
     *
     * <p><b>Esta es la vía, no {@link #db} con {@code --eval}.</b> Un script de mongosh lleva
     * comillas dobles casi siempre ({@code db.getCollection("x")}), y esas comillas NO
     * sobreviven al viaje por el argv en Windows: el cliente de contenedores reconstruye la
     * línea de comandos y se las come, con lo que mongosh recibe {@code db.getCollection(x)} y
     * responde {@code ReferenceError}. El script se copia como archivo y se ejecuta desde ahí.
     *
     * <pre>String salida = mongoEval("db.getCollection(\\"dispatch_orders\\").countDocuments({ status: \\"QUEUED\\" })");</pre>
     */
    protected static String mongoEval(String script) {
        copyIntoContainer(DB_CONTAINER, script, ".js", DB_SCRIPT);
        return db(${scriptArgv.map((part) => javaString(part)).join(', ')}, DB_SCRIPT);
    }
`;
}

// La sentencia SQL viaja por ARCHIVO cuando el motor no tiene forma argv.
//
// Es el mismo mecanismo que `mongoEval`, y por el mismo motivo: `sqlplus` no tiene un flag que
// tome la sentencia (la lee por stdin o de un fichero), y la salida obvia —`sh -c 'echo … |
// sqlplus'`— muere en Windows, donde el cliente de contenedores reconstruye la línea de comandos
// y se come las comillas de dentro. Mientras Oracle no declaró forma alguna, las cuatro secciones
// que componen SQL se apagaban EN SILENCIO y el motor se quedaba sin poder fabricar la
// precondición de ningún escenario de rescate, reconciliación u outbox.
function dbScriptHelper(entry, queryArgv) {
  if (entry.cliQueryForm !== 'scriptFile' || !queryArgv) return '';
  // El envoltorio lo pone el CATÁLOGO (directivas de formato y terminador): compuesto aquí sería
  // la segunda copia de un dato que solo el motor conoce.
  const wrapped = entry.cliScript('__STATEMENT__');
  const [prefix, suffix] = wrapped.split('__STATEMENT__');
  // El envoltorio es MULTILÍNEA y `javaString` no escapa saltos de línea (nada se los había
  // pasado hasta ahora): sin esto sale un literal Java sin cerrar, y el archivo entero deja de
  // compilar. Se escapan DESPUÉS de `javaString`, que solo toca `\` y `"`.
  const literal = (text) => javaString(text).replaceAll('\n', '\\n');
  return `
    /** Dónde se deja la sentencia dentro del contenedor de la base. */
    private static final String DB_SCRIPT = "/tmp/keel-eval${entry.cliScriptExtension}";

    /**
     * Ejecuta UNA sentencia contra la base de prueba.
     *
     * <p><b>Esta es la vía en ${entry.label}, no {@link #db} con la sentencia en el argv.</b>
     * {@code sqlplus} no tiene un flag que la tome: la lee de un fichero, así que la sentencia se
     * copia y solo su ruta viaja por el argv. Las directivas de formato y el {@code EXIT} los
     * pone este helper — sin ellas la salida trae cabecera y un «N rows selected» que ningún
     * {@code parseLong} sabe leer, y sin el {@code EXIT} el proceso no termina.
     *
     * <pre>String salida = dbSql("SELECT COUNT(*) FROM jobs WHERE status = 'QUEUED'");</pre>
     */
    protected static String dbSql(String statement) {
        copyIntoContainer(DB_CONTAINER, ${literal(prefix)} + statement + ${literal(suffix)}, ${javaString(entry.cliScriptExtension)}, DB_SCRIPT);
        return db(${queryArgv}, "@" + DB_SCRIPT);
    }
`;
}

/**
 * La llamada con la que el arnés ejecuta una sentencia, según la forma que declare el motor.
 *
 * Las cuatro secciones que componen SQL (`rescueSection`, `reconciliationAgingSection`,
 * `abandonOutboxSection`, `outboxDrainSection`) pasan por aquí en vez de escribir `db(argv…, …)`
 * cada una: así añadir un motor con otra forma de invocación no obliga a acordarse de las cuatro.
 */
function statementCall(entry, queryArgv, expression) {
  return entry.cliQueryForm === 'scriptFile' ? `dbSql(${expression})` : `db(${queryArgv}, ${expression})`;
}

function dbSection(model) {
  const entry = dbEntry(model);
  if (!entry) return '';
  const dbName = model.service.name.replaceAll('-', '_');
  // El argv sin `--eval`: mongosh acepta un ARCHIVO de script en su lugar, que es la única
  // forma de que un script con comillas llegue intacto (ver `copyIntoContainer`).
  const scriptArgv =
    entry.kind === 'document' && entry.cliQueryArgv
      ? entry
          .cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
          .filter((part) => part !== '--eval')
      : null;
  const queryArgv = entry.cliQueryArgv
    ? entry.cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
    : null;
  return `
    private static final String DB_CONTAINER = "${dbContainer(model)}";

    /**
     * Ejecuta una CLI contra la base de prueba y devuelve su salida. Argumentos
     * siempre como <b>lista</b>, nunca concatenados en una cadena para \`sh -c\`: en
     * Windows el cliente de contenedores reinterpreta las comillas escapadas y
     * corrompe el comando antes de reenviarlo${usesDevtools(model) ? ' (ver {@link #devtools})' : ''}.
     *
     * <p>Lo que no se ve por HTTP y tampoco es un mensaje: que una escritura llegó de
     * verdad al almacén, o que un borrado lógico dejó el documento donde debía. No es
     * la vía por defecto —si el propio servicio lo expone por su API, se comprueba por
     * ahí, que es lo que hace un cliente—, pero es la única para un efecto que ninguna
     * operación del diseño devuelve.
     *
     * <p><b>Toda sentencia va por aquí</b>, y cualquier helper propio que escribas
     * encima también: el motor elegido (${entry.label}) se invoca así, y la sentencia
     * entra como <b>un elemento más</b> del argv.${
       entry.cliQueryForm === 'scriptFile'
         ? `
     *
     * <p><b>Salvo la sentencia misma, que en ${entry.label} va por {@link #dbSql}.</b> Su
     * cliente no tiene un flag que la tome —la lee de un fichero—, así que este método se usa
     * para invocarlo, pero la sentencia la pone {@code dbSql} en un archivo del contenedor.
     * Armarla aquí a mano no falla en tu máquina y sí en Windows, donde el cliente de
     * contenedores reconstruye la línea de comandos y se come las comillas de dentro.`
         : ''
     }${scriptArgv ? `
     *
     * <p><b>Salvo un script de mongosh, que va por {@link #mongoEval}.</b> La promesa de
     * «las comillas llegan intactas» NO se sostiene cuando son las comillas de DENTRO del
     * argumento: en Windows el cliente de contenedores reconstruye la línea de comandos y se
     * las come. Un script de mongosh lleva comillas casi siempre, así que el ejemplo de abajo
     * se deja como lo que NO hay que hacer:` : ''}${
       entry.cliQueryForm === 'scriptFile'
         ? `
     * <pre>dbSql(${javaString(exampleStatement(entry))});</pre>`
         : queryArgv
           ? `
     * <pre>${scriptArgv ? '// NO — las comillas de dentro no sobreviven: ' : ''}db(${queryArgv.map((part) => javaString(part)).join(', ')},
     *    ${javaString(exampleStatement(entry))});</pre>`
           : ` este motor no declara
     * ninguna forma de invocación por CLI en el catálogo, así que lo único que queda es el
     * shell, con la sentencia armada por tu cuenta y su riesgo:
     * <pre>dbShell(${javaString(concreteCmd(entry, dbName))});</pre>`
     }${enumValuesDoc(model)}
     */
    protected static String db(String... argv) {
        List<String> command = new ArrayList<>(List.of(containerRuntime(), "exec", DB_CONTAINER));
        command.addAll(List.of(argv));
        return runProcess(command);
    }
${mongoEvalHelper(scriptArgv)}${dbScriptHelper(entry, queryArgv ? queryArgv.map((part) => javaString(part)).join(', ') : null)}
${uuidLiteralHelper(model)}${rescueSection(model)}

    /**
     * Igual que {@link #db}, pero a través de un shell: <b>solo</b> para lo que es del
     * shell —un pipe, una redirección, un prefijo de entorno que no se pueda resolver
     * con \`env\`—. La invocación de sondeo del motor, la misma que usa
     * \`infra/validate-infra.sh\`:
     * <pre>dbShell(${javaString(concreteCmd(entry, dbName))});</pre>
     *
     * <p><b>Una sentencia con comillas o con valores interpolados NO se arma como
     * cadena para este método</b>, por cómodo que resulte copiar la línea de arriba:
     * pasa por dos intérpretes (el cliente de contenedores y luego \`sh\`) y en Windows
     * el primero se la come — el síntoma es un error de sintaxis del motor sobre un
     * fragmento suelto de tu SQL, y como el fixture suele vivir en un \`@BeforeAll\`,
     * cae la clase entera con \`initializationError\`. Para eso está {@link #db}.
     */
    protected static String dbShell(String command) {
        return db("sh", "-c", command);
    }
`;
}

// Ejecución de comandos en un contenedor: el motor que comparten `devtools(...)` y
// `db(...)`. Vive aparte de los dos porque sus condiciones no coinciden — un
// proyecto documental sin nada más en el toolbox tiene BD que sondear y ningún
// contenedor devtools, y al revés.
function containerExecSection(model) {
  if (!usesContainerExec(model)) return '';
  return `
    private static String containerRuntime;

    /**
     * Copia contenido al contenedor como ARCHIVO, en vez de pasarlo como argumento.
     *
     * <p>Es la única forma fiable de que un texto CON COMILLAS llegue intacto: en Windows,
     * {@code ProcessBuilder} reconstruye una sola línea de comandos a partir de la lista y su
     * escapado rompe las comillas dobles incrustadas antes de que {@code docker.exe} /
     * {@code podman.exe} las reciba. El contenido llega sin comillas y el fallo aparece muy
     * lejos de su causa — un {@code ReferenceError} del intérprete de destino sobre un
     * fragmento suelto de lo que escribiste.
     */
    private static void copyIntoContainer(String container, String content, String suffix, String target) {
        try {
            Path temp = Files.createTempFile("keel-", suffix);
            Files.writeString(temp, content, StandardCharsets.UTF_8);
            runProcess(List.of(containerRuntime(), "cp", temp.toString(), container + ":" + target));
            Files.deleteIfExists(temp);
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo copiar el contenido al contenedor " + container, e);
        }
    }

    /**
     * Ejecuta el proceso, <b>exige código de salida 0</b> y deja la evidencia en
     * {@link FailureCapture}. Ignorar el código es lo que convierte un \`curl -sf\`
     * fallido en una cadena vacía y hace que el error aparezca mucho más tarde y muy
     * lejos de su causa.
     */
    private static String runProcess(List<String> command) {
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.redirectErrorStream(true);
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            int exit = process.waitFor();
            FailureCapture.recordProbe(command, exit, output);
            if (exit != 0) {
                throw new IllegalStateException("Falló el sondeo de infraestructura (código " + exit + "): "
                    + String.join(" ", command) + System.lineSeparator() + output);
            }
            return output;
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo ejecutar el comando en el contenedor: " + String.join(" ", command), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido hablando con el contenedor", e);
        }
    }

    /**
     * Runtime de contenedores, con la misma resolución que los scripts de \`infra/\`:
     * \`CONTAINER_RUNTIME\` y, si no está, el primero disponible entre docker y podman.
     * Caer a "docker" a secas dejaba la suite muerta en una máquina solo con podman.
     */
    private static synchronized String containerRuntime() {
        if (containerRuntime == null) {
            containerRuntime = detectContainerRuntime();
        }
        return containerRuntime;
    }

    private static String detectContainerRuntime() {
        String configured = System.getenv("CONTAINER_RUNTIME");
        if (configured != null && !configured.isBlank()) {
            return configured;
        }
        for (String candidate : List.of("docker", "podman")) {
            try {
                Process process = new ProcessBuilder(candidate, "--version").redirectErrorStream(true).start();
                process.getInputStream().readAllBytes();
                if (process.waitFor() == 0) {
                    return candidate;
                }
            } catch (IOException e) {
                // Ese runtime no está en el PATH: se prueba el siguiente.
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrumpido detectando el runtime de contenedores", e);
            }
        }
        throw new IllegalStateException("No se encontró docker ni podman en el PATH. Exporta CONTAINER_RUNTIME con el que uses.");
    }
`;
}

// Copia de cuerpos al contenedor devtools. Es la contrapartida del javadoc de
// `devtools`: todo cuerpo con comillas (un JSON) que necesite una CLI del contenedor
// viaja por archivo. Lo comparten el sondeo de RabbitMQ y, con los tres brokers, la
// entrega de mensajes entrantes — que lleva el JSON que escribe el escenario, así que
// es justo donde un escapado roto costaría más caro de diagnosticar.
function bodyFileHelper(model) {
  const broker = brokerEntry(model);
  if (!broker) return '';
  return `
    /**
     * Copia un cuerpo al contenedor en vez de pasarlo como argumento: un JSON con
     * comillas dentro de la línea de comandos es exactamente lo que el cliente de
     * contenedores corrompe en Windows. \`ProcessBuilder\` reconstruye una única
     * cadena de línea de comandos a partir de la lista de argumentos, y su escapado
     * rompe las comillas dobles incrustadas antes de que \`docker.exe\`/\`podman.exe\`
     * las reciba — el cuerpo llega sin comillas y el fallo aparece lejos de su causa.
     */
    private static void copyToDevtools(String content, String target) {
        copyIntoContainer(DEVTOOLS_CONTAINER, content, ".json", target);
    }
`;
}

// Lectura y aislamiento del canal de eventos, por broker. La API es la misma en
// los tres: publishedMessages(destino, n) devuelve lo publicado desde la última
// purga/marca, y purgeMessages(destino) reabre esa ventana.
// Lo que acabó en el descarte. Es la mitad que le faltaba al arnés: sin ella, toda
// cláusula del tipo «el mensaje se confirma sin acabar en la DLQ» quedaba `uncovered`,
// y son cláusulas que importan — distinguen «el duplicado se frenó con una guarda» de
// «el duplicado reventó y el broker lo apartó», que desde el estado propio se ven igual.
//
// El destino sale de `lib/dead-letter.js`, el mismo sitio del que lo toman la topología
// y `broker-check`: si el arnés leyera un nombre compuesto aquí, un día leería una cola
// distinta de la que el servicio alimenta y la aserción negativa saldría verde sin
// haber mirado nada.
function deadLetterSection(model) {
  const subs = deadLetterSubscriptions(model);
  const broker = brokerEntry(model);
  if (subs.length === 0 || !broker) return '';

  const entries = subs
    .map((sub) => `Map.entry("${sub.name}", "${deadLetterDestination(broker.id, model, sub)}")`)
    .join(',\n            ');

  // Kafka: el DLT NO EXISTE hasta que se publica el primer descarte, así que la lectura
  // del caso feliz —el que afirma que NADA acabó ahí— falla con «Unknown topic». Eso es
  // «vacío», no una avería: sin esta traducción, la mitad negativa del escenario sería
  // inasertable justo cuando el servicio se comporta bien. En RabbitMQ y SQS la cola la
  // crea build de antemano y el caso no se da.
  // Y se lee DESDE LA MARCA de la clase, no «los últimos count» del topic entero: el
  // DLT lo comparten todas las suscripciones y toda la suite, y en Kafka no hay purga
  // que lo vacíe entre flujos. `markChannels()` fija esa marca en cada `resetState()`.
  const read =
    broker.id === 'kafka'
      ? `        Long mark = MARKS.get(deadLetterTopic);
        String offset = mark != null ? String.valueOf(mark) : "-" + count;
        try {
            return devtools(${javaArgs(readParts('kafka', { destination: expr('deadLetterTopic'), offset: expr('offset') }))});
        } catch (RuntimeException e) {
            if (isUnknownTopic(e)) {
                return "";
            }
            return emptyIfBrokerStopped(e);
        }`
      : // El resto de brokers sí tienen la cola creada de antemano, así que leer no falla
        // — pero «vacío» NO es cadena vacía en ninguno de los dos: la API de RabbitMQ
        // devuelve el literal "[]" y la CLI de SQS un JSON sin la clave "Messages". El
        // javadoc de este método promete cadena vacía y la aserción que de verdad importa
        // es la NEGATIVA (`deadLetterMessages(...).isBlank()`), así que sin traducir, el
        // caso en que el servicio se comporta bien es justo el que falla. Se traduce con
        // el predicado del broker —el mismo de `broker-probes.js`— y no con una
        // comparación escrita a mano, que es como se olvida uno de los dos.
        `        String messages = publishedMessages(deadLetterTopic, count).trim();
        return ${emptyReadJava(broker.id, 'messages')} ? "" : messages;`;

  return `
    /** Suscripción → su destino de descarte, derivados del diseño. */
    private static final Map<String, String> DEAD_LETTER_OF = Map.ofEntries(
            ${entries});

    /**
     * Los mensajes del descarte de una suscripción publicados ${
       broker.id === 'kafka'
         ? `<b>desde la marca de la clase de flujo actual</b> (los últimos {@code count}
     * de respaldo si aún no hay marca), o cadena vacía si no hay ninguno. Lee desde la
     * marca —y no «los últimos {@code count}» del topic entero— porque el descarte lo
     * comparten todas las suscripciones y toda la suite, y en Kafka no hay purga que lo
     * vacíe entre flujos: sin aislamiento, un mensaje muerto de un flujo anterior
     * contamina la aserción negativa de cualquier flujo posterior`
         : `desde el último reset (hasta {@code count}), o cadena vacía si no hay
     * ninguno: \`reset-db.sh\` purga la cola de descarte junto a los canales`
     }.
     *
     * <p>Úsalo también —y sobre todo— para la aserción NEGATIVA: que un duplicado
     * frenado por la guarda de idempotencia se confirme <b>sin</b> acabar aquí es lo
     * que distingue una repetición absorbida de una que reventó por dentro. Las dos
     * dejan el estado propio idéntico.
     */
    protected static String deadLetterMessages(String subscription, int count) {
        String deadLetterTopic = DEAD_LETTER_OF.get(subscription);
        if (deadLetterTopic == null) {
            throw new IllegalArgumentException(
                    "La suscripción '" + subscription + "' no declara onFailure.deadLetter en el diseño: "
                            + "no hay descarte sobre el que afirmar. Declaradas: " + DEAD_LETTER_OF.keySet());
        }
${read}
    }
`;
}

// Desescapado del campo `Body` de SQS, exclusivo de este broker.
//
// La CLI de AWS devuelve el cuerpo de cada mensaje como una cadena JSON ESCAPADA dentro
// del JSON de la respuesta, así que `publishedMessages(...)` devolvía comillas con
// backslash y una aserción tan normal como `.contains("\"status\":\"draft\"")` no casaba
// NUNCA, aunque el mensaje publicado fuera correcto. El síntoma es mudo —no un error, un
// falso negativo— y en la corrida del 14/08/2026 apareció a la vez en tres clases de flujo
// sin ninguna relación entre sí, que es justo la firma de un defecto de arnés. Peor: un
// proyecto con aserciones más laxas (`.contains("draft")`) pasa de chiripa y nadie se
// entera de que su comprobación no comprueba lo que dice.
//
// Se escribe con String.raw para que los backslashes del patrón lleguen tal cual a Java.
const SQS_BODY_DECODING = String.raw`
    /**
     * Captura el valor entrecomillado de cada campo {@code "Body": "..."} de la salida de
     * la CLI.
     *
     * <p>El grupo repetido es <b>posesivo</b> ({@code *+}), no perezoso: con un {@code Body}
     * que trae muchos backslashes consecutivos —lo que ocurre cuando un mensaje llega
     * <b>sin</b> raw message delivery, envuelto en el sobre de notificación de SNS por
     * encima de la envoltura Keel— la forma perezosa es ambigua sobre cómo agrupar esa
     * racha y el motor prueba exponencialmente muchas particiones antes de fallar: un solo
     * {@code Body} así basta para agotar el stack ({@code StackOverflowError}) en vez de
     * devolver un resultado. En cada posición la expansión es determinista de todos modos
     * (backslash → el par, cualquier otro carácter → uno suelto), así que la forma posesiva
     * no cambia qué matchea: solo le prohíbe al motor reconsiderarlo.
     */
    private static final Pattern BODY_FIELD = Pattern.compile("\"Body\":\\s*\"((?:\\\\.|[^\"\\\\])*+)\"");

    /**
     * Desescapa el {@code Body} de cada mensaje. La CLI lo devuelve como cadena JSON
     * escapada, así que una aserción de texto como {@code .contains("\"status\":\"active\"")}
     * no casa contra la salida cruda aunque el mensaje sea correcto — y el fallo es mudo.
     *
     * <p>Se desescapa <b>solo</b> el valor de {@code Body}: la envoltura ({@code Messages},
     * {@code MessageId}, {@code ReceiptHandle}…) queda intacta porque hay comprobaciones que
     * dependen de ella.
     */
    private static String decodeBodies(String raw) {
        Matcher matcher = BODY_FIELD.matcher(raw);
        StringBuilder result = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            result.append(raw, last, matcher.start());
            // EMBEBIDO cuando es JSON, igual que su hermano de RabbitMQ, y no re-entrecomillado.
            // Concatenar el valor decodificado entre comillas —lo que esto hacía— produce un
            // documento INVÁLIDO en cuanto el cuerpo lleva una comilla, que es siempre: la primera
            // interna cierra la cadena y el resto quedan tokens sueltos. El síntoma es
            // InvalidJsonException: Unexpected token al leer lo publicado, y se llevó seis
            // escenarios por delante en la corrida documental.
            //
            // Re-escaparlo con el mapper arregla la validez y rompe lo otro: la aserción por
            // substring dejaría de casar, que es justo la trampa muda que el javadoc de
            // PAYLOAD_FIELD documenta haber costado cuatro clases de flujo. Embebido cumple las dos.
            result.append("\"Body\": ").append(embeddedBody(matcher.group(1)));
            last = matcher.end();
        }
        result.append(raw, last, raw.length());
        return result.toString();
    }

    /** El cuerpo como valor JSON si lo es; si no, tal cual vino (entrecomillado y escapado). */
    private static String embeddedBody(String escaped) {
        try {
            String decoded = JSON.readValue("\"" + escaped + "\"", String.class);
            JSON.readTree(decoded);
            return decoded;
        } catch (Exception notJson) {
            return "\"" + escaped + "\"";
        }
    }`;

// Desescapado del campo `payload` de RabbitMQ, hermano del de SQS.
//
// La Management API devuelve el sobre de aplicación como una cadena JSON ESCAPADA dentro
// del JSON de la respuesta, así que el texto crudo trae `{\"metadata\":...}` y una
// aserción tan normal como `.contains("\"status\":\"active\"")` no casa NUNCA aunque el
// evento publicado sea correcto. En la corrida del 18/08/2026, cuatro clases de flujo
// escritas por separado cometieron el mismo error: eso es una trampa del arnés, no un
// descuido del agente — el fallo es mudo (falso negativo, no error) y quien "arregla" la
// aserción aflojándola (`.contains("active")`) pasa de chiripa sin comprobar nada.
//
// A diferencia del de SQS, aquí el valor decodificado se emite EMBEBIDO cuando es JSON, no
// re-entrecomillado: así la respuesta sigue siendo JSON válido y `jsonPath` navega
// `$[*].payload.metadata.eventType` sin re-parsear a mano, además de hacer que la
// comparación por substring case.
//
// Se escribe con String.raw para que los backslashes del patrón lleguen tal cual a Java.
const RABBIT_PAYLOAD_DECODING = String.raw`
    /**
     * Captura el valor entrecomillado de cada campo {@code "payload": "..."} de la
     * respuesta de la Management API.
     *
     * <p>El grupo repetido es <b>posesivo</b> ({@code *+}) por la misma razón que su
     * gemelo de SQS: con un payload lleno de backslashes consecutivos, la forma perezosa
     * es ambigua sobre cómo agrupar la racha y el motor prueba exponencialmente muchas
     * particiones antes de fallar — un solo mensaje así basta para agotar el stack. La
     * expansión es determinista de todos modos, así que la forma posesiva no cambia qué
     * matchea: solo le prohíbe al motor reconsiderarlo.
     */
    private static final Pattern PAYLOAD_FIELD = Pattern.compile("\"payload\":\\s*\"((?:\\\\.|[^\"\\\\])*+)\"");

    /**
     * Desescapa el {@code payload} de cada mensaje y lo deja EMBEBIDO como JSON.
     *
     * <p>Sin esto, lo que devuelve {@link #publishedMessages} trae el sobre de aplicación
     * escapado dentro del JSON de la respuesta, y una aserción de texto como
     * {@code .contains("\"status\":\"active\"")} no casa aunque el evento sea correcto —
     * y el fallo es mudo. Con esto, el resultado sigue siendo JSON válido: lo natural es
     * leerlo con {@code JsonPath} sobre {@code $[*].payload.metadata.eventType}.
     *
     * <p>Se toca <b>solo</b> el valor de {@code payload}: la envoltura
     * ({@code properties}, {@code routing_key}, {@code payload_bytes}…) queda intacta
     * porque hay comprobaciones que dependen de ella. Y sin mensajes no hay campo que
     * tocar, así que un destino vacío sigue leyéndose como {@code []}.
     */
    private static String decodePayloads(String raw) {
        Matcher matcher = PAYLOAD_FIELD.matcher(raw);
        StringBuilder result = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            result.append(raw, last, matcher.start());
            result.append("\"payload\": ").append(embeddedPayload(matcher.group(1)));
            last = matcher.end();
        }
        result.append(raw, last, raw.length());
        return result.toString();
    }

    /** El payload como valor JSON si lo es; si no, tal cual vino (entrecomillado y escapado). */
    private static String embeddedPayload(String escaped) {
        try {
            String decoded = JSON.readValue("\"" + escaped + "\"", String.class);
            JSON.readTree(decoded);
            return decoded;
        } catch (Exception notJson) {
            return "\"" + escaped + "\"";
        }
    }`;

// Espera al drenaje del outbox antes de purgar un destino.
//
// La carrera que cierra, y que costó dos escenarios de la corrida del 18/08: el relay
// drena la tabla cada `fixed-delay-ms`, y su fase respecto al `purgeMessages()` de un
// test es arbitraria (la JVM lleva corriendo la suite entera y el relay no se reinicia
// entre clases). Un evento legítimo del escenario ANTERIOR puede aterrizar en la cola
// justo DESPUÉS de la purga, y el escenario siguiente lo lee como propio — con lo que
// falla una aserción de «no se publicó nada» por algo que no tiene que ver con ella.
//
// Se espera por CONSULTA, no por un margen adivinado: un margen fijo no basta si el
// relay acaba de empezar su ciclo, y sobra siempre que no haya nada pendiente. Y si la
// espera se agota (relay caído, fila atascada), se sigue adelante: esto acota una
// ventana de carrera, no es una condición del escenario, y bloquear aquí convertiría un
// problema de otra capa en un timeout mudo en el sitio equivocado.
function outboxDrainSection(model) {
  const entry = dbEntry(model);
  if (!usesOutbox(model) || !entry?.cliQueryArgv) return '';
  const dbName = model.service.name.replaceAll('-', '_');
  const argv = entry
    .cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
    .map((part) => javaString(part))
    .join(', ');
  // Mismos nombres de almacenamiento en los dos modelos (outbox.js): la columna/campo
  // `published_at` a null es la fila que el relay todavía no entregó.
  // Se consulta por EVENT_TOPIC, NO por el canal que recibe `purgeMessages`. La columna
  // `destination` la escribe el publicador con `messaging.publishing.destination` —el
  // destino FÍSICO, `<slug>.events`—, mientras que el canal es la agrupación LÓGICA del
  // diseño (`stockEvents`). Consultar por el canal daba `COUNT(*) = 0` siempre: la espera
  // volvía al instante sin esperar a nada, que es justo lo que su javadoc dice evitar.
  // El script documental sale de `mongo-probes.js`, como todo lo que habla mongosh: aquí
  // javac no es red —`javaString()` escapa siempre, así que un predicado que no case sale
  // como Java válido— y lo único que lo juzga es `mongo-check` contra un Mongo de verdad.
  const pending = outboxPendingScript();
  const documentCount = `${javaString(pending.prefix)} + OUTBOX_DESTINATION + ${javaString(pending.suffix)}`;
  const statement =
    entry.kind === 'document'
      ? null // documental: la consulta va por `mongoEval`, no por argv (ver mongoEvalHelper)
      : '"SELECT COUNT(*) FROM outbox_event WHERE destination = \'" + OUTBOX_DESTINATION + "\' AND published_at IS NULL"';
  const published = model.messaging?.publishChannels ?? [];
  return `
    /** Cuánto se espera, como mucho, a que el relay entregue lo que tenga pendiente. */
    private static final Duration OUTBOX_DRAIN_TIMEOUT = Duration.ofSeconds(15);

    /**
     * El destino FÍSICO que el publicador escribe en {@code outbox_event.destination}, que es
     * {@code messaging.publishing.destination} y NO el canal lógico del diseño. Se declara aquí
     * y no se reutiliza {@code EVENT_TOPIC} porque aquella constante solo existe en la rama
     * Kafka del arnés, y esta espera se emite con los tres brokers.
     */
    private static final String OUTBOX_DESTINATION =
            System.getenv().getOrDefault("${model.messaging?.destinationEnv ?? 'MESSAGING_DESTINATION'}", "${model.messaging?.destinationDefault ?? ''}");

    /** Canales que ESTE servicio publica: son los únicos cuyo trabajo pasa por nuestro outbox. */
    private static final Set<String> OUTBOX_CHANNELS = Set.of(${published.map((name) => `"${name}"`).join(', ')});

    /**
     * Espera a que no queden filas de {@code outbox_event} sin publicar para este
     * destino. Ver el comentario de {@link #purgeMessages}: purgar sin esperar deja que
     * un evento del escenario anterior aterrice después de la purga.
     */
    private static void awaitOutboxDrained(String destination) {
        // Un canal que este servicio no publica no pasa por nuestro outbox: no hay relay
        // que pueda entregar tarde, así que no hay nada que esperar.
        if (!OUTBOX_CHANNELS.contains(destination)) {
            return;
        }
        // Y con el broker parado POR EL PROPIO ESCENARIO no se espera: las filas están
        // pendientes a propósito —es toda la premisa del escenario del canal indisponible—
        // y el relay no puede drenarlas contra un broker caído. Esperar aquí no convergería
        // nunca: se agotaría el timeout entero en cada lectura de ese flujo.
        if (brokerIntentionallyStopped()) {
            return;
        }
        Instant deadline = Instant.now().plus(OUTBOX_DRAIN_TIMEOUT);
        while (Instant.now().isBefore(deadline) && pendingOutboxRows() > 0) {
            try {
                Thread.sleep(150L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrumpido esperando el drenaje del outbox", interrupted);
            }
        }
    }

    /**
     * Filas del outbox aún sin entregar.
     *
     * <p>Un fallo aquí NO se traduce a 0. Cero significa «drenado», así que tragarse el
     * error convierte una consulta rota en una espera que siempre pasa: los escenarios de
     * outbox seguirían corriendo, en verde, sin esperar a nada. Que se oiga.
     */
    private static int pendingOutboxRows() {
        try {
            String output = ${statement === null ? `mongoEval(${documentCount})` : statementCall(entry, argv, statement)};
            // Solo la ÚLTIMA línea: un cliente puede escribir avisos antes del resultado, y
            // concatenar sus dígitos daría un número enorme que parecería trabajo pendiente.
            String trimmed = output.trim();
            int lastBreak = Math.max(trimmed.lastIndexOf('\\n'), trimmed.lastIndexOf('\\r'));
            String digits = trimmed.substring(lastBreak + 1).replaceAll("[^0-9]", "");
            return digits.isEmpty() ? 0 : Integer.parseInt(digits);
        } catch (RuntimeException e) {
            throw new IllegalStateException(
                    "No se pudo leer outbox_event para saber si el relay había drenado. Sin esa lectura la "
                            + "espera del outbox no espera a nada y lo que dependa de ella mide humo.",
                    e);
        }
    }
`;
}

/**
 * Lo que se ve desde fuera cuando el outbox se RINDE.
 *
 * Una fila que agota `outbox.relay.max-attempts` deja de reclamarse y se queda ahí: es
 * pérdida de datos en el mecanismo cuya única promesa es que ningún evento se pierde. Hasta
 * ahora lo único que ocurría era un `log.error`, y un log no lo mira nadie ni lo puede
 * afirmar ningún escenario. El relay publica ahora un gauge, y esto lo lee por HTTP —el
 * actuator ya expone `metrics`—, así que la rendición es observable en caja negra, igual
 * que cualquier otro efecto.
 *
 * Es INSTANCIA y no estático a propósito: usa `get(...)`, que también lo es. Mezclarlos es
 * de los errores que ni comparar cadenas ni `java-syntax` ven, y solo aparece en javac.
 */
function deadLetteredOutboxSection(model) {
  if (!usesOutbox(model)) return '';
  return `
    /**
     * Cuántos eventos se rindió el outbox: agotaron sus reintentos y no salieron nunca.
     *
     * <p>El {@code Then} natural de casi cualquier escenario del outbox es que esto siga
     * valiendo <b>cero</b>: un relay que entrega tarde es correcto, uno que se rinde ha
     * perdido el evento. La aserción es barata y caza la diferencia, que ninguna otra
     * afirmación de la suite distingue — con el canal restablecido, el mensaje que nunca
     * salió y el que salió tarde se parecen mucho hasta que se cuenta.
     */
    protected long deadLetteredEvents() {
        Response response = get("/actuator/metrics/keel.outbox.dead_lettered");
        if (response.status() == 404) {
            // La métrica se registra al arrancar el relay: un 404 significa que no hay
            // outbox corriendo, no que no haya nada rendido. Decirlo evita leer un cero
            // tranquilizador de un servidor que no está midiendo nada.
            throw new IllegalStateException(
                    "El actuator no publica keel.outbox.dead_lettered: o el relay no arrancó, o "
                            + "'metrics' no está expuesto en el perfil con el que corre la suite.");
        }
        try {
            return JSON.readTree(response.body()).path("measurements").get(0).path("value").asLong();
        } catch (Exception e) {
            // Exception y no RuntimeException: readTree declara JsonProcessingException, que es
            // COMPROBADA. Es de los errores que ni comparar cadenas ni java-syntax ven — solo javac.
            throw new IllegalStateException("Respuesta inesperada del actuator: " + response.body(), e);
        }
    }
`;
}

/**
 * El rescate de una fila EN VUELO: la que otra réplica dejó a medias al morir.
 *
 * Es el tercer mecanismo cuya precondición se FABRICA en vez de esperarse, después del barrido
 * de silencio y del dead-letter del outbox. Y el que más caro salió por no tener palanca: CUATRO
 * corridas escribieron el mismo escenario a mano con cuatro SQL distintos —ni las tres
 * relacionales compartían estilo—, una reventó con «Data too long for column 'id'» por componer
 * el literal del UUID a mano, y el diagnóstico de la de Mongo costó un ciclo entero de arbitraje.
 *
 * Todo lo que tuvieron que adivinar ya lo calcula build: 'rescueClaim()' deja en 'claim.stalled'
 * el estado en vuelo y el campo del reloj, y la entidad lleva su tabla y su columna de lifecycle.
 *
 * Se MUEVE una fila creada por la API, no se siembra entera: los valores de negocio son del
 * diseño y build no los conoce. El estado que queda es el mismo —en vuelo y sin fila de outbox,
 * porque quien la escribe es el barrido que aún no ha corrido—.
 */
function rescueSection(model) {
  const entry = dbEntry(model);
  if (!entry?.cliQueryArgv) return '';
  const document = entry.kind === 'document';
  // Mismo criterio que 'ageForReconciliation': donde el motor no declara su forma, no se emite
  // el helper. Un UPDATE que no casa deja el escenario verde sin haber atascado nada.
  if (!document && (!entry.staleTimestamp || !entry.uuidLiteral)) return '';

  const rescates = [];
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const claim of operation.claim ?? []) {
      if (!claim.stalled) continue;
      const entity = (model.entities ?? []).find((e) => e.name === claim.entity);
      if (!entity?.tableName || !entity.lifecycle?.field) continue;
      rescates.push({ operation: operation.name, ...rescueShape(entity, claim) });
    }
  }
  if (rescates.length === 0) return '';

  const dbName = model.service.name.replaceAll('-', '_');
  const argv = entry
    .cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
    .map((part) => javaString(part))
    .join(', ');

  const NL = String.fromCharCode(10);

  // El reloj «a ahora» era una constante en línea mientras solo lo declaraban motores donde
  // CURRENT_TIMESTAMP es ANSI y significa lo mismo. Dejó de serlo con SQL Server, donde devuelve
  // la hora LOCAL del servidor y no UTC, mientras el rescate compara contra un `Instant`: con el
  // contenedor en UTC coincide, pero por coincidencia. De ahí `nowTimestamp`, que solo declara
  // quien se aparta del ANSI.
  const RANCIO = { sql: entry.staleTimestamp, mongo: CLOCK.stale };
  const AHORA = { sql: entry.nowTimestamp ?? 'CURRENT_TIMESTAMP', mongo: CLOCK.now };

  const mover = (r, clock) => {
    const script = setStateScript({
      collection: r.table,
      stateField: r.stateColumn,
      state: r.state,
      clockField: r.clockColumn,
      clock: clock.mongo
    });
    const cuerpo = document
      ? '            mongoEval(' + javaString(script.prefix) + ' + id + ' + javaString(script.suffix) + ');'
      : '            ' +
        statementCall(entry, argv, javaString(stallSql({ ...r, clockSql: clock.sql })) + ' + uuidLiteral(id)') +
        ';';
    return '        if (' + javaString(r.operation) + '.equals(operation)) {' + NL + cuerpo + NL + '            return;' + NL + '        }';
  };

  const contar = (r) => {
    const cuerpo = document
      ? '            return Long.parseLong(mongoEval(' +
        javaString(
          missingClockCountScript({
            collection: r.table,
            stateField: r.stateColumn,
            state: r.state,
            clockField: r.clockColumn
          })
        ) +
        ').trim());'
      : '            return Long.parseLong(' +
        statementCall(entry, argv, javaString(missingClockCountSql(r))) +
        '.trim());';
    return '        if (' + javaString(r.operation) + '.equals(operation)) {' + NL + cuerpo + NL + '        }';
  };

  const conocidas = rescates.map((r) => r.operation).join(', ');

  return [
    '',
    '    /**',
    '     * Deja la fila {@code id} EN VUELO con el reloj infinitamente rancio: el estado exacto en',
    '     * el que queda una réplica que murió con ella en la mano, que es lo que el rescate busca.',
    '     *',
    '     * <p>No dispara el barrido —lo dispara su cron, como en producción— y no siembra la fila:',
    '     * mueve una creada por la API, porque los valores de negocio son del diseño.',
    '     *',
    '     * <p>Barridos con rescate en este diseño: ' + conocidas + '.',
    '     */',
    '    protected static void stallInFlight(String operation, String id) {',
    rescates.map((r) => mover(r, RANCIO)).join(NL),
    '        unknownRescue(operation);',
    '    }',
    '',
    '    /**',
    '     * Lo mismo, pero con el reloj a AHORA: la fila acaba de entrar en vuelo y hay alguien',
    '     * trabajando en ella.',
    '     *',
    '     * <p>Es la mitad que separa <b>rescatar</b> de <b>robarle el trabajo a quien lo está',
    '     * haciendo</b>. Un rescate sin cota temporal pasa el escenario del rescate sin despeinarse',
    '     * y falla aquí — y su modo de fallo en producción no es un error: son dos réplicas',
    '     * encargando el mismo trabajo a la vez.',
    '     */',
    '    protected static void putInFlight(String operation, String id) {',
    rescates.map((r) => mover(r, AHORA)).join(NL),
    '        unknownRescue(operation);',
    '    }',
    '',
    '    /**',
    '     * Cuántas filas quedaron EN VUELO con el reloj sin estampar.',
    '     *',
    '     * <p>Tiene que valer <b>cero</b> siempre. Si el reclamo mueve el estado sin estampar la',
    '     * marca en el MISMO update, la fila que caiga en esa ventana queda irrescatable para',
    '     * siempre: quien la busca filtra por {@code < :staleBefore}, y con la marca a nulo esa',
    '     * comparación es UNKNOWN. El escenario del rescate no lo ve, porque él coloca la fila con',
    '     * el reloj ya retrasado — este contador es el único que mira el instante anterior.',
    '     */',
    '    protected static long inFlightWithoutClock(String operation) {',
    rescates.map(contar).join(NL),
    '        unknownRescue(operation);',
    '        return 0L;',
    '    }',
    '',
    '    private static void unknownRescue(String operation) {',
    '        throw new IllegalArgumentException(',
    '                "No hay rescate para el barrido \'" + operation + "\'. Los que lo tienen: ' + conocidas + '");',
    '    }',
    ''
  ].join(NL);
}

/**
 * Rendirse: lo que hace ALCANZABLE el dead-letter del outbox.
 *
 * Es el último comportamiento del outbox sin cobertura, y la señal que lo hace observable
 * —el gauge que lee `deadLetteredEvents()`— solo se afirmaba en la dirección que no importa:
 * todos los escenarios comprueban que vale CERO. Si la sonda estuviera rota y devolviera
 * siempre cero, las cinco aserciones pasarían en vacío. Esto es lo que permite verla en la
 * dirección positiva.
 *
 * Se fabrica la precondición, no se espera a que ocurra: `max-attempts` vale 40 en el perfil
 * local (y el backoff tope 2 s), así que agotarlos de verdad con el canal caído no cabe en
 * una suite. Y el valor que se escribe va MUY por encima de cualquier umbral a propósito: si
 * el arnés leyera el parámetro quedaría atado al perfil con el que corre.
 *
 * A diferencia de `ageForReconciliation`, esto NO necesita el literal de fecha ni el de uuid:
 * la fila se localiza por su tipo de evento, que es texto. Por eso alcanza a todos los motores
 * que declaran una CLI de consulta, y no solo a los dos de aquel.
 */
function abandonOutboxSection(model) {
  const entry = dbEntry(model);
  if (!usesOutbox(model) || !entry?.cliQueryArgv) return '';

  const dbName = model.service.name.replaceAll('-', '_');
  const argv = entry
    .cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
    .map((part) => javaString(part))
    .join(', ');
  const document = entry.kind === 'document';

  // Muy por encima de cualquier `outbox.relay.max-attempts` (40 en local, 10 en el resto):
  // el arnés no lee el parámetro para no quedar atado al perfil.
  const ABANDONED = 1000000;

  const abandon = abandonOutboxScript(ABANDONED);
  const update = document
    ? `        mongoEval(${javaString(abandon.prefix)} + eventType + ${javaString(abandon.suffix)});`
    : `        ${statementCall(
        entry,
        argv,
        `"UPDATE outbox_event SET attempts = ${ABANDONED} WHERE event_type = '" + eventType + "' AND published_at IS NULL"`
      )};`;

  const cleanup = document
    ? `        mongoEval(${javaString(clearAbandonedScript(ABANDONED))});`
    : `        ${statementCall(
        entry,
        argv,
        `"DELETE FROM outbox_event WHERE published_at IS NULL AND attempts >= ${ABANDONED}"`
      )};`;

  return `
    /**
     * Agota el presupuesto de reintentos de los eventos de ese tipo que siguen pendientes:
     * el relay los da por perdidos y deja de reclamarlos.
     *
     * <p>No espera a que ocurra —el presupuesto del perfil local es de 40 intentos— sino que
     * crea la condición que el relay dice que mira, igual que {@code ageForReconciliation}
     * fabrica el silencio de un barrido. El relay sigue corriendo por su cuenta.
     *
     * <p><b>Deja el contador sucio</b> hasta el siguiente reset: el cron de purga solo borra
     * lo publicado, así que la fila abandonada sobrevive dentro de la clase. Emparéjalo con
     * {@link #clearAbandonedOutboxEvents()} en un {@code finally}, o coloca el escenario el
     * ÚLTIMO de su clase — si no, los {@code deadLetteredEvents() == 0} de los siguientes
     * fallarán por culpa de este.
     */
    protected static void abandonOutboxEvent(String eventType) {
${update}
    }

    /** Retira los eventos abandonados, para que el contador vuelva a cero. */
    protected static void clearAbandonedOutboxEvents() {
${cleanup}
    }
`;
}

/**
 * Envejecer la marca de espera: lo que hace ALCANZABLE un barrido de reconciliación.
 *
 * El barrido era, de los seis mecanismos, el único con cobertura conductual CERO. La razón
 * escrita era que su disparador es el reloj y un cron no se llama desde fuera — cierta, pero
 * incompleta: el criterio que sacó al outbox de esa misma lista no es «¿puedo llamarlo?» sino
 * «¿hay algo que cambie ahí fuera según esté bien o mal?». Y aquí lo hay, por partida doble: el
 * barrido mueve el lifecycle y PUBLICA la cancelación al proveedor.
 *
 * Lo que faltaba era llegar a su condición de entrada sin esperar el plazo real. Bajarlo por
 * configuración NO sirve —`unansweredAfterSeconds` es global, y con un plazo corto el barrido
 * se lleva por delante las filas de todos los demás escenarios que están esperando su desenlace
 * normal—, así que se envejece LA FILA, que es quirúrgico: solo esa entra en el lote.
 *
 * El cron sigue disparando solo. Eso es lo que separa esto de inventarle una puerta al barrido,
 * que es lo que la doctrina prohíbe: no se invoca la operación, se crea la condición que el
 * diseño dice que la operación busca.
 */
function reconciliationAgingSection(model) {
  const entry = dbEntry(model);
  if (!entry?.cliQueryArgv) return '';
  const document = entry.kind === 'document';
  // Mismo criterio que `uuidLiteral`: donde el motor no declara su forma, no se emite el
  // helper. Inventarla es peor que no tenerlo — un UPDATE que no casa deja el escenario
  // verde sin haber envejecido nada.
  //
  // Y ese criterio es del eje RELACIONAL, no de todos: `staleTimestamp` y `uuidLiteral` son
  // literales SQL, y Mongo no declara ninguno de los dos porque no los necesita —su reloj es
  // `new Date(0)` y su id viaja como `UUID("…")` dentro del script—. Mientras la condición
  // fue única, un diseño documental con `reconciledBy` se quedaba sin este helper EN SILENCIO
  // y no podía tener el escenario que `crossrefs.js` le exige. Es la misma partición que
  // `rescueSection` ya hace una función más arriba.
  if (!document && (!entry.staleTimestamp || !entry.uuidLiteral)) return '';

  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        if (!target.table || !target.awaitingField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push(target);
      }
    }
  }
  if (targets.size === 0) return '';

  const dbName = model.service.name.replaceAll('-', '_');
  const argv = entry
    .cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
    .map((part) => javaString(part))
    .join(', ');

  const ramas = [...targets]
    .map(([name, list]) => {
      const updates = list
        .map((target) => {
          if (document) {
            // El script sale de mongo-probes.js CRUDO y lo escapa javaString(), que es la
            // regla del módulo: pre-escaparlo aquí produce el doble escape que ya se coló una
            // vez y que solo se ve leyendo el Java generado.
            const script = ageClockScript({
              collection: target.table,
              clockField: snakeCase(target.awaitingField)
            });
            return `            statements.add(${javaString(script.prefix)} + id + ${javaString(script.suffix)});`;
          }
          return `            statements.add(${javaString(
            `UPDATE ${target.table} SET ${snakeCase(target.awaitingField)} = ${entry.staleTimestamp} WHERE id = `
          )} + uuidLiteral(id));`;
        })
        .join(String.fromCharCode(10));
      // Varias tablas por activación cuando el mismo encargo deja esperando a más de una
      // entidad: el id es de UNA de ellas y las demás actualizan cero filas. Es inofensivo,
      // y la alternativa —que el escenario diga a qué tabla apunta— le pediría al test un
      // detalle de persistencia que la caja negra no tiene por qué conocer.
      return `        if (${javaString(name)}.equals(activation)) {
${updates}
        }`;
    })
    .join(String.fromCharCode(10));

  const conocidas = [...targets.keys()].join(', ');
  return `
    /**
     * Deja la marca de espera de {@code activation} infinitamente rancia para la fila
     * {@code id}, de modo que el barrido la tome en <b>su próxima pasada</b>.
     *
     * <p>No dispara el barrido: lo dispara su cron, como en producción. Lo que esto hace es
     * crear la condición que el barrido busca —«lleva esperando más de lo tolerado»— sin
     * esperar el plazo real, y solo para esta fila. Bajar el umbral por configuración sería
     * global y se llevaría por delante las filas de los demás escenarios, que están
     * esperando su desenlace normal.
     *
     * <p>Después, el {@code Then} es el de siempre: el estado que la API devuelve y el
     * mensaje que aparece en el canal. Deja margen para un tick del cron.
     *
     * <pre>{@code
     * ageForReconciliation("${[...targets.keys()][0]}", caseId);
     * await(Duration.ofSeconds(90), () -> "returnLost".equals(statusOf(caseId)));
     * }</pre>
     *
     * <p>Activaciones con barrido en este diseño: ${conocidas}.
     */
    protected static void ageForReconciliation(String activation, String id) {
        List<String> statements = new ArrayList<>();
${ramas}
        if (statements.isEmpty()) {
            throw new IllegalArgumentException(
                    "No hay barrido para la activación '" + activation + "'. Las que lo tienen: ${conocidas}");
        }
        for (String statement : statements) {
            ${document ? 'mongoEval(statement)' : statementCall(entry, argv, 'statement')};
        }
    }
`;
}

/**
 * La espera al drenaje, antepuesta a TODA lectura de mensajes.
 *
 * Va aquí dentro y no en las clases de flujo, y esa es la decisión. El agente de una corrida
 * lo resolvió llamando a `awaitOutboxDrained` trece veces en cinco clases; funciona, y es la
 * misma forma que ya ha fallado dos veces en este repo —el javadoc de `tokenFor` avisaba y dos
 * corridas volvieron a capturar el token—. Trece llamadas que hay que recordar son trece
 * oportunidades de olvidar una, y el fallo que produce olvidarla no se parece a un despiste:
 * se parece a un servicio que no publicó su evento.
 *
 * El coste es una consulta a `outbox_event` por lectura, y cuando no hay nada pendiente vuelve
 * en esa consulta. Cuando lo hay, esperar es exactamente lo que se quiere.
 */
function drainBeforeRead(model, parameter = 'destination') {
  if (!drainsOutbox(model)) return '';
  return `
        // Antes de leer: el relay corre en su propio fixed-delay, independiente del commit
        // del estado. Cuando un Then ve el estado ya cambiado, el evento puede no haber
        // salido todavía — y eso solo se nota bajo la contención de la suite completa, no
        // corriendo la clase sola.
        awaitOutboxDrained(${parameter});`;
}

// Con outbox, `purgeMessages` deja de ser la purga a secas: la purga cruda pasa a
// `purgeDestination` (privada, una por broker) y el método público la envuelve con la
// espera al drenaje. Sin outbox no hay relay que pueda entregar tarde, así que la purga
// es directa y no se paga ninguna espera.
function purgeEntryPoint(model) {
  return drainsOutbox(model) ? 'private static void purgeDestination' : 'protected static void purgeMessages';
}

function drainsOutbox(model) {
  return usesOutbox(model) && Boolean(dbEntry(model)?.cliQueryArgv);
}

// El wrapper público, común a los tres brokers.
function purgeWrapper(model) {
  if (!drainsOutbox(model)) return '';
  return `
    /**
     * Vacía el destino, esperando antes a que el outbox no tenga nada pendiente para él.
     *
     * <p>La espera no es prudencia: sin ella, un evento legítimo del escenario ANTERIOR
     * puede aterrizar en la cola justo después de la purga, y el escenario siguiente lo
     * lee como propio — con lo que falla una aserción de «no se publicó nada» por algo
     * que no tiene que ver con ella. El relay drena cada {@code fixed-delay-ms} y su fase
     * respecto a este método es arbitraria.
     */
    protected static void purgeMessages(String destination) {
        awaitOutboxDrained(destination);
        purgeDestination(destination);
    }
`;
}

// Contador de sentencias SQL, para acotar el COSTE de una lectura.
//
// Es lo que convierte «esto no hace N+1» de opinión sobre el código en algo que un
// escenario afirma: se toma la cuenta antes y después de la petición y se compara el
// salto contra una cota. Un listado que resuelve sus relaciones por lote cuesta un
// número FIJO de consultas; uno que las resuelve elemento a elemento crece con la
// página, y esa es exactamente la diferencia que la cota captura.
//
// La fuente es `hibernate.statements{status=prepared}`, que publica Micrometer desde
// las estadísticas de Hibernate (activadas solo en local y test). No hay dependencia
// nueva del arnés: es una lectura HTTP más.
function queryCountSection(model) {
  // Sin `api` no hay petición que medir, y tampoco existe el `get()` con el que se
  // mediría: el contador sería una llamada a un helper que no está.
  if (!model.layersPresent.api) return '';
  if (!model.layersPresent.persistence || model.persistenceKind !== 'relational') return '';
  const security = model.layersPresent.security && tokenProtocol(model);
  // El actuator no está entre las rutas públicas: con seguridad, la métrica se pide
  // con un token cualquiera —vale el de cualquier rol— porque la regla de cierre es
  // `authenticated()`.
  const role = model.security?.roles?.[0] ?? null;
  const call = security && role
    ? `get("/actuator/metrics/hibernate.statements?tag=status:prepared", tokenFor("${role}"))`
    : 'get("/actuator/metrics/hibernate.statements?tag=status:prepared")';
  return `
    /**
     * Sentencias SQL preparadas desde que arrancó la aplicación.
     *
     * <p>Sirve para acotar el coste de una lectura: se lee antes y después de la
     * petición y se afirma sobre el SALTO, nunca sobre el valor absoluto (la cuenta es
     * del proceso entero y la comparten todas las clases de la suite).
     *
     * <pre>
     * long antes = queryCount();
     * Response response = get(unaRutaDeListado${security ? ', admin' : ''});
     * assertThat(queryCount() - antes).isLessThanOrEqualTo(4);
     * </pre>
     *
     * <p><b>La cota se elige por FORMA, no por el número que salga hoy</b>: lo que se
     * está afirmando es que el coste NO crece con el tamaño de la página. Un margen
     * generoso sobre un coste constante sigue cazando el N+1; una cota ajustada al
     * valor exacto se rompe con cualquier índice o versión de Hibernate y acaba
     * subiéndose sin mirar, que es como un gate se convierte en ruido.
     *
     * <p>Para que la comparación signifique algo, la petición medida tiene que ser la
     * ÚNICA que corra en ese intervalo, y conviene ejecutarla dos veces midiendo la
     * segunda: la primera paga la caché de planes y la de segundo nivel.
     */
    // De INSTANCIA, no estático: se apoya en los helpers de petición, que lo son (y con
    // seguridad, en el que cachea el token por rol en un campo). Declararlo static —como
    // los helpers del broker, que sí lo son— no compila.
    protected long queryCount() {
        Response response = ${call};
        if (response.status() != 200) {
            throw new IllegalStateException(
                    "No se pudo leer hibernate.statements (" + response.status() + "): ¿está el actuator expuesto y"
                            + " generate_statistics activo en el perfil?");
        }
        Number value = JsonPath.read(response.body(), "$.measurements[0].value");
        return value.longValue();
    }
`;
}

/**
 * Canal del diseño → destino FÍSICO del broker, para los helpers que hablan con él.
 *
 * Un canal que este servicio publica coincide con su destino. Una SUSCRIPCIÓN, no: consume del
 * destino que le da su `source` (y en SNS/SQS, de su cola propia colgada del topic), que es lo
 * que resuelve `subscriptionDestination()` — la misma fuente de la que salen `reset-db.sh` y la
 * configuración del listener. `deliverXxx` ya lo resolvía; `purgeMessages` y `publishedMessages`
 * recibían el nombre del canal tal cual y hablaban con un destino que no existe: la purga fallaba
 * con un error de transporte que no dice nada del nombre, y la lectura habría dado «canal vacío»
 * para siempre, que es peor porque sale verde.
 *
 * Se emite el mapa solo cuando alguno difiere: donde canal y destino coinciden, resolver es la
 * identidad y una tabla vacía sería ruido.
 */
function physicalDestinationSection(model) {
  const broker = brokerEntry(model);
  // Los canales que ESTE servicio publica, y su destino: el único
  // `messaging.publishing.destination` por el que sale todo lo nuestro.
  //
  // Se miran PRIMERO y ganan, y esa precedencia es el arreglo de un defecto real. Antes
  // este mapa se construía solo desde `model.subscriptions`, así que un canal usado en
  // los dos sentidos —publicamos en él Y nos suscribimos a él, que es la silueta de
  // cualquier servicio que encarga trabajo y espera la respuesta por el mismo canal—
  // recibía la entrada de la SUSCRIPCIÓN por ser la única que se miraba. Resultado:
  // `publishedMessages("<canal>")` leía la cola del proveedor en vez del destino donde
  // publicamos, y con SNS/SQS ni eso — varias suscripciones lo partían en varias colas,
  // el canal caía en SPLIT_ACROSS y resolver LANZABA, reventando el humo del arnés para
  // un canal cuyo destino de publicación estaba perfectamente definido.
  //
  // Y el destino de un canal publicado NO es el mismo en los tres brokers, que es la
  // segunda mitad del arreglo y la que se destapó en la corrida de SNS/SQS: en RabbitMQ se
  // lee de la cola del destino único del servicio, pero en SNS/SQS eso es un TOPIC, y de un
  // topic no se lee — el aprovisionamiento crea una cola de arnés cuyo nombre ES el del
  // canal. Lo resuelve `publishedDestination`, que es la fuente única.
  const publishedChannels = model.messaging?.publishChannels ?? [];

  // El canal del que cuelga cada suscripción. Sin `channel` declarado, el canal ES su
  // destino y no hay nada que traducir.
  const byChannel = new Map();
  for (const sub of model.subscriptions ?? []) {
    if (!sub.channel) continue;
    // Lo que publicamos manda: para ese canal el destino no es ambiguo ni es el del
    // proveedor, es el nuestro.
    if (publishedChannels.includes(sub.channel)) continue;
    const physical = subscriptionDestination(broker.id, model, sub);
    if (physical === sub.channel) continue;
    const bucket = byChannel.get(sub.channel) ?? [];
    bucket.push({ name: sub.name, physical });
    byChannel.set(sub.channel, bucket);
  }

  const resolved = publishedChannels
    .map((channel) => [channel, publishedDestination(broker.id, model, channel)])
    // Donde el destino ES el canal (SNS/SQS y su cola de arnés), resolver es la identidad y
    // una entrada sería ruido que además invita a creer que ahí hay algo que traducir.
    .filter(([channel, destination]) => channel !== destination);
  const ambiguous = [];
  for (const [channel, subs] of byChannel) {
    const destinations = [...new Set(subs.map((sub) => sub.physical))];
    if (destinations.length === 1) resolved.push([channel, destinations[0]]);
    // Un canal que en este broker se reparte en varias colas —SNS/SQS le da una a cada
    // consumidor— no tiene UN destino físico. Elegir uno purgaría la cola equivocada y la
    // aserción siguiente saldría verde sin haber mirado nada, así que se falla en el sitio
    // y con los nombres delante.
    else ambiguous.push([channel, subs.map((sub) => `${sub.name} → ${sub.physical}`).join(', ')]);
  }

  const entriesOf = (rows) =>
    rows.map(([key, value]) => `Map.entry("${key}", "${value}")`).join(',' + '\n' + '            ');

  if (resolved.length === 0 && ambiguous.length === 0) {
    return `
    /**
     * Canal del diseño → destino físico. En este diseño coinciden todos, así que resolver es la
     * identidad; el punto de resolución existe igual para que los helpers no tengan que saberlo.
     */
    protected static String physicalDestination(String destination) {
        return destination;
    }
`;
  }

  const ambiguousBlock =
    ambiguous.length === 0
      ? ''
      : `
    /** Canales que en este broker NO tienen un destino único, con quién los consume. */
    private static final Map<String, String> SPLIT_ACROSS = Map.ofEntries(
            ${entriesOf(ambiguous)});
`;
  const ambiguousGuard =
    ambiguous.length === 0
      ? ''
      : `
        String split = SPLIT_ACROSS.get(destination);
        if (split != null) {
            throw new IllegalArgumentException(
                    "El canal '" + destination + "' lo consumen varias suscripciones con destino propio ("
                            + split + "): no hay uno solo con el que hablar. Pasa el destino concreto.");
        }`;

  return `
    /**
     * Canal del diseño → destino físico real en el broker (${broker.label}).
     *
     * <p>Para un canal que este servicio PUBLICA, el destino físico es
     * \`messaging.publishing.destination\` —uno solo para todo lo nuestro, con los eventos
     * distinguidos por routing key—, y NO el nombre del canal ni, aunque el mismo canal se
     * consuma, la cola del proveedor. El de una
     * SUSCRIPCIÓN lo deriva build de su \`source\` —y en SNS/SQS es además la cola propia del
     * consumidor—, no del nombre del canal: hablarle al canal a secas es hablarle a un destino que
     * no existe. Es la misma correspondencia que usan \`infra/reset-db.sh\` y la configuración del
     * listener, y de la que ya salía el destino de \`deliverXxx\`.
     */
    private static final Map<String, String> PHYSICAL_OF = ${
      resolved.length === 0
        ? 'Map.of();'
        : `Map.ofEntries(
            ${entriesOf(resolved)});`
    }
${ambiguousBlock}
    /** El destino con el que de verdad se habla, venga el nombre del canal o ya resuelto. */
    protected static String physicalDestination(String destination) {${ambiguousGuard}
        return PHYSICAL_OF.getOrDefault(destination, destination);
    }
`;
}

function brokerSection(model) {
  const broker = brokerEntry(model);
  if (!broker) return '';
  // `DEAD_LETTER_OF` lo emite `deadLetterSection`, que solo existe si alguna
  // suscripción declara el descarte: sin esto, `markChannels()` citaría un campo
  // que no está y el arnés no compilaría.
  const deadLetter = usesDeadLetter(model);
  // Tolerancia a la indisponibilidad que el ESCENARIO provocó. Sin la palanca de
  // outbox no existe tal caso, y entonces el helper no perdona nada: cualquier fallo
  // de lectura sigue siendo una infraestructura rota y tiene que doler donde ocurre.
  const outage = usesBrokerControl(model)
    ? `
    /**
     * Traduce a «canal vacío» el fallo de leer un destino <b>mientras el propio
     * escenario tiene el broker parado</b>, y solo ese. La condición es el flag, no el
     * tipo de error: una infraestructura que se cae por su cuenta sigue reventando la
     * suite en el punto donde se cayó.
     *
     * <p>Y «vacío» se dice como lo diga ${broker.label}, no con la cadena vacía. Cada broker
     * tiene su forma y el predicado que la reconoce es el mismo que usa el resto del arnés
     * (lib/broker-probes.js): devolver {@code ""} donde este espera {@code "[]"} hacía fallar
     * la aserción de canal vacío justo en el único escenario para el que esta palanca existe
     * —el broker caído y el outbox reteniendo—.
     */
    private static String emptyIfBrokerStopped(RuntimeException e) {
        if (brokerIntentionallyStopped()) {
            return ${javaString(emptyReadValue(broker.id))};
        }
        throw e;
    }

    /** ¿Está el broker parado porque lo paró {@link #stopBroker}? */
    private static boolean brokerIntentionallyStopped() {
        return BROKER_STOPPED.get();
    }
`
    : `
    /** Sin palanca de broker no hay caída provocada: todo fallo de lectura es real. */
    private static String emptyIfBrokerStopped(RuntimeException e) {
        throw e;
    }

    /** Sin palanca de broker, ninguna caída la provoca el escenario. */
    private static boolean brokerIntentionallyStopped() {
        return false;
    }
`;
  const doc = `
    /**
     * Últimos mensajes publicados en un destino, leídos del broker <b>real</b> del
     * compose (${broker.label}) vía el contenedor devtools. Nunca un broker embebido:
     * lo que se valida es la infraestructura levantada.
     */`;
  const purgeDoc = `
    /**
     * Vacía el destino. El reset de estado lo hace por cada canal declarado al abrir
     * el flujo; el test lo repite <b>inmediatamente antes</b> de la acción cuyo Then
     * afirma que no se publica nada — si no, lo que se lee es el evento que publicó
     * la preparación del propio escenario.
     */`;

  if (broker.id === 'rabbitmq') {
    const base = expr('RABBIT_API');
    // El destino con el que se habla es el FÍSICO: quien llama pasa el nombre del canal
    // del diseño, que para una suscripción no es el de su cola.
    const physical = expr('physicalDestination(destination)');
    const read = readParts('rabbitmq', { destination: physical, bodyFile: expr('PROBE_BODY'), base });
    const purge = purgeParts('rabbitmq', { destination: physical, base });
    return `
    private static final String RABBIT_API = "${ENDPOINTS.rabbitmq.queuesApi}";

    private static final String PROBE_BODY = "/tmp/keel-probe.json";
${physicalDestinationSection(model)}${doc}
    protected static String publishedMessages(String destination, int count) {${drainBeforeRead(model)}
        // Peek (ack_requeue_true): leer no consume, así que un escenario puede
        // assertar dos veces sobre el mismo mensaje.
        copyToDevtools(${rabbitProbeBodyJava('count')}, PROBE_BODY);
        try {
            // Desescapado ANTES de devolver: quien llama nunca ve el sobre de
            // aplicación como cadena escapada, que es la trampa que hacía fallar en
            // silencio aserciones por lo demás correctas.
            return decodePayloads(devtools(${javaArgs(read)}));
        } catch (RuntimeException e) {
            return emptyIfBrokerStopped(e);
        }
    }
${RABBIT_PAYLOAD_DECODING}
${purgeDoc}
    ${purgeEntryPoint(model)}(String destination) {
        devtools(${javaArgs(purge)});
    }
${purgeWrapper(model)}${outage}`;
  }

  if (broker.id === 'snssqs') {
    const base = expr('QUEUE_URL');
    // Igual que en RabbitMQ: en SNS/SQS el consumidor tiene cola propia colgada del topic,
    // así que el nombre del canal tampoco es el destino del que se lee ni el que se purga.
    const physical = expr('physicalDestination(destination)');
    const read = readParts('snssqs', { destination: physical, count: expr('String.valueOf(size)'), base });
    // El barrido es OTRO comando, no el mismo con un flag: oculta lo que devuelve para poder
    // avanzar más allá del primer lote. El porqué, en `SQS_SWEEP_VISIBILITY`.
    const sweep = readParts('snssqs', {
      destination: physical,
      count: expr('String.valueOf(size)'),
      base,
      hideSeconds: SQS_SWEEP_VISIBILITY
    });
    const release = releaseParts('snssqs', { destination: physical, receiptHandle: expr('handle'), base });
    // La cota de intentos, como EXPRESIÓN Java sobre `count`: la fórmula la fija
    // `readAttemptLimit` en lib/broker-probes.js, que es la misma que aplica el runner de
    // conformidad. Escribirla dos veces es como el gate en vivo deja de medir lo que se genera.
    const readAttemptLimitJava = `(wanted + ${READ_BATCH_LIMIT.snssqs - 1}) / ${READ_BATCH_LIMIT.snssqs} + ${readAttemptLimit('snssqs', 1) - 1}`;
    const purge = purgeParts('snssqs', { destination: physical, base });
    return `
    private static final String QUEUE_URL = "${ENDPOINTS.snssqs.queueUrlPrefix}";

    private static final List<String> AWS = List.of(${javaArgs(prefix('snssqs'))});
${physicalDestinationSection(model)}${doc}
    protected static String publishedMessages(String destination, int count) {${drainBeforeRead(model)}
        // Dos cosas se cruzan aquí y conviene no mezclarlas.
        //
        // La primera: SQS acota \`--max-number-of-messages\` a 1..10 y contesta
        // InvalidParameterValue por encima, así que un escenario de clúster hay que pedirlo
        // por lotes.
        //
        // La segunda, que es la que costó una corrida: con \`--visibility-timeout 0\` cada
        // mensaje devuelto vuelve a estar visible AL INSTANTE, así que un lote posterior
        // puede repescar uno ya contado. Cortar cuando un lote vuelve incompleto —lo que
        // esto hacía— no evita el solape: si el primero devuelve 10 completos y el segundo
        // repesca alguno, se cuenta dos veces. Y el resultado ni siquiera era JSON válido,
        // porque los lotes se concatenaban tal cual.
        //
        // Se dedupe por \`MessageId\`, que SQS asigna por MENSAJE y es estable entre
        // relecturas del mismo. No por el cuerpo ni por el id de aplicación: dos entregas
        // legítimas del mismo evento —la reentrega que un escenario de idempotencia
        // provoca a propósito— comparten cuerpo y \`metadata.eventId\`, y deduplicarlas
        // dejaría ese escenario pasando en verde sin probar nada.
        //
        // Y la ocultación del barrido no contradice el peek: se SUELTA lo oculto al terminar,
        // así que la cola queda como estaba y un escenario puede seguir afirmando dos veces
        // sobre el mismo mensaje. Subir el timeout sin soltar sí lo rompería — para todos, y
        // a cambio de arreglar solo la lectura larga.
        Set<String> seen = new LinkedHashSet<>();
        StringBuilder unique = new StringBuilder();
        // Cota de lotes: sin ella, una cola que solo puede repescar lo ya visto —menos
        // mensajes reales que los pedidos— deja el bucle sondeando para siempre.
        int wanted = Math.max(count, 1);
        int maxAttempts = ${readAttemptLimitJava};
        // Pedir más de lo que cabe en una llamada es un BARRIDO, y ahí el peek se vuelve en
        // contra: lo devuelto sigue visible, así que la llamada siguiente trae otra vez los
        // mismos diez y el conteo se queda corto para siempre. Barriendo se oculta lo leído y
        // se suelta al final, con lo que la cola queda como estaba.
        boolean sweeping = wanted > ${READ_BATCH_LIMIT.snssqs};
        List<String> hidden = new ArrayList<>();
        try {
            for (int attempt = 0; attempt < maxAttempts && seen.size() < wanted; attempt++) {
                int size = Math.min(wanted - seen.size(), ${READ_BATCH_LIMIT.snssqs});
                String batch = sweeping ? aws(${javaArgs(sweep)}) : aws(${javaArgs(read)});
                List<Map<String, Object>> messages = receivedMessages(batch);
                if (messages.isEmpty()) {
                    break;
                }
                for (Map<String, Object> message : messages) {
                    if (sweeping) {
                        hidden.add(String.valueOf(message.get("ReceiptHandle")));
                    }
                    if (seen.add(String.valueOf(message.get("${READ_DEDUPE_KEY.snssqs}")))) {
                        appendMessage(unique, message);
                    }
                }
                // Barriendo, un lote CORTO no prueba nada —lo devuelto quedó oculto—, así que
                // el único final fiable es el lote vacío. Sin barrer, el lote corto sí lo es.
                if (!sweeping && messages.size() < size) {
                    break;
                }
            }
        } catch (RuntimeException e) {
            return emptyIfBrokerStopped(e);
        } finally {
            // Se suelta SIEMPRE, también si la lectura revienta: dejar la cola ciega haría
            // fallar al escenario siguiente por algo que no es suyo.
            for (String handle : hidden) {
                try {
                    aws(${javaArgs(release)});
                } catch (RuntimeException ignored) {
                    // Soltar es de mejor esfuerzo: el plazo de ocultación vence solo.
                }
            }
        }
        // El desescapado va al final, sobre la lista ya deduplicada: decodeBodies es
        // TEXTUAL y deja de ser JSON navegable, así que deduplicar después sería tarde.
        return decodeBodies(seen.isEmpty() ? "{}" : "{\\"Messages\\": [" + unique + "]}");
    }

    /** Re-serializa un mensaje ya deduplicado y lo añade a la lista en construcción. */
    private static void appendMessage(StringBuilder target, Map<String, Object> message) {
        if (target.length() > 0) {
            target.append(',');
        }
        try {
            target.append(JSON.writeValueAsString(message));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("No se pudo re-serializar un mensaje de SQS", e);
        }
    }

    /**
     * La lista {@code Messages} de una respuesta cruda de {@code receive-message}, o vacía
     * si no había ninguno. Deliberadamente <b>no</b> pasa por {@code decodeBodies}: aquí hacen
     * falta los campos del SOBRE crudo —{@code MessageId} para deduplicar y
     * {@code ReceiptHandle} para soltar lo que un barrido ocultó—, y el desescapado se aplica
     * una sola vez al final, sobre la lista ya compuesta.
     */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> receivedMessages(String raw) {
        // Una cola agotada puede devolver la salida VACÍA —ni siquiera {}—, y sobre eso
        // JsonPath lanza IllegalArgumentException("json string can not be null or empty"),
        // que NO es el PathNotFoundException que se tolera abajo: se escapa, y como esto
        // corre con BROKER_STOPPED todavía en true, mata el @BeforeAll de la clase entera.
        // El mismo cuidado que ya tiene pendingOutboxRows con su salida numérica vacía.
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            return JsonPath.read(raw, "$.Messages");
        } catch (com.jayway.jsonpath.PathNotFoundException e) {
            return List.of();
        }
    }
${SQS_BODY_DECODING}
${purgeDoc}
    ${purgeEntryPoint(model)}(String destination) {
        // PurgeQueue está limitada a una vez cada 60 s por cola en AWS real;
        // LocalStack no aplica esa cuota.
        aws(${javaArgs(purge)});
    }
${purgeWrapper(model)}

    private static String aws(String... arguments) {
        List<String> argv = new ArrayList<>(AWS);
        argv.addAll(List.of(arguments));
        return devtools(argv.toArray(String[]::new));
    }
${outage}`;
  }

  // Kafka: sin purga posible (kcat no borra registros y devtools no trae las CLIs
  // de Kafka). El aislamiento equivalente es una marca de offset por canal sobre el
  // topic único del servicio — y por eso aquí NO hace falta resolver el destino
  // físico: no se le pasa ningún nombre de destino al broker, se marca un offset.
  const eventTypes = model.messaging?.eventTypesByChannel ?? {};
  const eventTypeEntries = Object.entries(eventTypes)
    .map(([channel, names]) => `        "${channel}", List.of(${names.map((name) => `"${name}"`).join(', ')})`)
    .join(',\n');
  return `
    private static final List<String> CHANNELS = List.of(${channels(model)
      .map((name) => `"${name}"`)
      .join(', ')});

    /**
     * Topic <b>físico</b> donde publica el servicio, que <b>no</b> es el canal del
     * diseño: todos los eventos comparten el destino único
     * \`messaging.publishing.destination\` y se distinguen por routing key
     * (\`docs/keel/conventions/mapping.md\` § messaging). Se resuelve igual que el perfil
     * \`local\`: la variable de entorno si está, y si no el default del diseño.
     */
    private static final String EVENT_TOPIC =
            System.getenv().getOrDefault("${model.messaging?.destinationEnv ?? 'MESSAGING_DESTINATION'}", "${model.messaging?.destinationDefault ?? ''}");

    /**
     * Canal lógico → \`metadata.eventType\` de los eventos que el diseño publica en él.
     * Es lo que permite que \`publishedMessages("<canal>", n)\` devuelva solo lo de ese
     * canal aunque todo viaje por el mismo topic. Un canal que no esté aquí (el de una
     * suscripción, por ejemplo) no filtra nada.
     */
    private static final Map<String, List<String>> CHANNEL_EVENT_TYPES = ${eventTypeEntries ? `Map.of(\n${eventTypeEntries});` : 'Map.of();'}

    /** Offset del topic desde el que lee cada canal (su última purga/marca). */
    private static final Map<String, Long> MARKS = new ConcurrentHashMap<>();

${doc}
    protected static String publishedMessages(String channel, int count) {${drainBeforeRead(model, 'channel')}
        Long mark = MARKS.get(channel);
        // Con marca se lee todo lo publicado después de ella; sin marca, los últimos
        // \`count\` (lo que hacía este helper antes de existir el aislamiento).
        String offset = mark != null ? String.valueOf(mark) : "-" + count;
        return filterByChannel(readTopic(offset), channel);
    }
${purgeDoc}
    ${purgeEntryPoint(model)}(String channel) {
        MARKS.put(channel, safeNextOffset());
    }
${purgeWrapper(model)}

    /**
     * Marca todos los canales declarados <b>y todos los destinos de descarte</b>: es la
     * parte del reset que el script no puede hacer.
     *
     * <p>Los DLT entran aquí por la misma razón que los canales, pero el fallo que
     * evitan es peor de ver: \`resetState()\` trunca la BD y reinicia el proveedor de
     * prueba, así que un flujo que empieza limpio por todos lados sigue leyendo los
     * mensajes muertos que dejó un flujo anterior. Y como la aserción típica sobre un
     * DLT es NEGATIVA —«el duplicado se absorbió sin acabar en el descarte»—, la
     * contaminación no se ve como ruido: se ve como el escenario fallando por algo que
     * no hizo.
     */
    private static void markChannels() {
        long offset = safeNextOffset();
        for (String channel : CHANNELS) {
            MARKS.put(channel, offset);
        }${deadLetter ? `
        for (String deadLetterTopic : Set.copyOf(DEAD_LETTER_OF.values())) {
            MARKS.put(deadLetterTopic, safeNextOffset(deadLetterTopic));
        }` : ''}
    }

    /**
     * Offset siguiente tolerando que el topic <b>aún no exista</b>: contra un broker
     * recién levantado nadie ha publicado todavía, \`kcat -o beginning\` sale con
     * \`Unknown topic or partition\` (código 1) y {@link #runProcess} lo convierte en
     * excepción. La marca correcta en ese caso es 0. Lo necesitan por igual el reset
     * (primer flujo de la suite) y la purga previa a un Then de "no se publica nada",
     * que puede ser la primerísima operación contra el broker.
     */
    private static long safeNextOffset() {
        return safeNextOffset(EVENT_TOPIC);
    }

    /** Igual que {@link #safeNextOffset()} pero contra un topic explícito (p. ej. un DLT). */
    private static long safeNextOffset(String topic) {
        try {
            return nextOffset(topic);
        } catch (RuntimeException e) {
            // Solo el topic que aún no existe: si lo que falla es el broker, marcar 0
            // en silencio convierte una infraestructura caída en una suite que empieza
            // a correr y falla mucho más tarde, lejos de la causa.
            if (isUnknownTopic(e)) {
                return 0L;
            }
            // Con el broker parado a propósito no hay offset que consultar, y marcar 0
            // es correcto: no se ha publicado nada que la marca deba dejar fuera.
            if (brokerIntentionallyStopped()) {
                return 0L;
            }
            throw e;
        }
    }

    /**
     * Lee el topic del servicio desde un offset. El flag <b>\`-C\` es obligatorio</b>:
     * kcat elige modo productor cuando su stdin no es un terminal —que es el caso de
     * un \`exec\` lanzado por ProcessBuilder— y devolvería éxito con salida vacía, un
     * falso negativo indistinguible de "el evento aún no llegó".
     */
    private static String readTopic(String offset) {
        try {
            return devtools(${javaArgs(readParts('kafka', { destination: expr('EVENT_TOPIC'), offset: expr('offset') }))});
        } catch (RuntimeException e) {
            // Kafka crea el topic al primer PRODUCE, no al primer consumo: contra una
            // infraestructura recién levantada, leer antes de que nadie haya publicado
            // sale con \`Unknown topic or partition\` y código 1. Y ese es justo el caso
            // de un Then que afirma que NO se publica nada, que es el primero que
            // corre en cualquier suite: sin esto, el escenario revienta en vez de
            // pasar. Solo se traga ese error concreto — un broker caído o un topic
            // equivocado tienen que seguir doliendo.
            if (isUnknownTopic(e)) {
                return "";
            }
            // Y el broker que el propio escenario tiró: ahí el fallo es de transporte,
            // no de topic, y «vacío» es la respuesta correcta.
            return emptyIfBrokerStopped(e);
        }
    }

    private static boolean isUnknownTopic(RuntimeException e) {
        String message = e.getMessage();
        return message != null && message.contains("${UNKNOWN_TOPIC}");
    }

    /**
     * Deja solo los mensajes cuyo \`metadata.eventType\` pertenece al canal. Se filtra
     * por el tipo de evento y no por la key del mensaje porque la key depende de la
     * ruta de publicación (routing key en outbox, id del agregado en best-effort).
     */
    private static String filterByChannel(String output, String channel) {
        List<String> types = CHANNEL_EVENT_TYPES.get(channel);
        if (types == null || types.isEmpty()) {
            return output;
        }
        StringBuilder kept = new StringBuilder();
        for (String line : output.split("\\\\R")) {
            String compact = line.replace(" ", "");
            for (String type : types) {
                if (compact.contains("\\"eventType\\":\\"" + type + "\\"")) {
                    kept.append(line).append(System.lineSeparator());
                    break;
                }
            }
        }
        return kept.toString();
    }

    /**
     * Offset en el que arrancará lo siguiente que se publique. Se obtiene leyendo los
     * offsets existentes (\`-f %o\`), no por marca de tiempo: \`offsetsForTimes\` devuelve
     * -1 en un topic sin tráfico reciente, que es justo el caso del reset.
     *
     * <p>Asume <b>una partición</b> por topic, y eso es una <b>decisión</b>, no una
     * limitación heredada del compose: la infraestructura de prueba se queda en el
     * default del broker porque más particiones no compran nada en single-node, y en
     * producción las gobierna el cluster (ver la skill keel-spring-kafka § Topología).
     * Una marca escalar solo aísla mientras eso se cumpla — \`kcat -o\` aplica el offset
     * a <b>cada</b> partición, así que con N particiones esta marca dejaría entrar
     * mensajes de la corrida anterior y se saltaría los propios. Quien suba las
     * particiones de \`infra/\` tiene que convertir MARKS en un mapa por partición y leer
     * con \`-p\`; cambiar solo el compose deja la suite intermitente.
     */
    private static long nextOffset() {
        return nextOffset(EVENT_TOPIC);
    }

    /** Igual que {@link #nextOffset()} pero contra un topic explícito (p. ej. un DLT). */
    private static long nextOffset(String topic) {
        String output = devtools(${javaArgs(offsetsParts({ destination: expr('topic') }))});
        long last = -1L;
        for (String line : output.split("\\\\R")) {
            String trimmed = line.trim();
            if (!trimmed.isEmpty()) {
                try {
                    last = Long.parseLong(trimmed);
                } catch (NumberFormatException ignored) {
                    // Línea que no es un offset (aviso de kcat): se ignora.
                }
            }
        }
        return last + 1;
    }

    /** Publica un mensaje crudo en el topic del servicio (solo lo usa el humo del arnés). */
    protected static void publishRaw(String key, String payload) {
        deliverMessage(EVENT_TOPIC, key, payload, Map.of());
    }

    /** Comilla un valor <b>sin comillas dobles</b> (una key, nunca un cuerpo JSON). */
    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\\\''") + "'";
    }
${outage}`;
}

// Entrega de mensajes ENTRANTES: la mitad que le faltaba al arnés. `publishedMessages`
// lee lo que este servicio publica; esto inyecta lo que consume, que es lo único con lo
// que se puede ejercitar una suscripción —y, sobre todo, su REENTREGA: el escenario que
// distingue un consumidor que deduplica de uno que aplica el efecto dos veces—. Sin esta
// primitiva, la obligación de escenario de una compensación no era ejecutable y el gate
// de la generación no podía verla.
function deliverySection(model) {
  const broker = brokerEntry(model);
  if (!broker) return '';
  const doc = `
    /**
     * Entrega un mensaje <b>crudo</b> en un destino del broker real, como si lo hubiera
     * publicado el servicio de origen. Es la contrapartida de {@link #publishedMessages}.
     *
     * <p>El cuerpo viaja por archivo vía {@link #copyToDevtools}, nunca embebido en la
     * línea de comandos: en Windows el cliente de contenedores se come las comillas
     * dobles del JSON y lo que llega al broker es un cuerpo roto que el consumidor nunca
     * reconoce — el síntoma es un timeout mudo, no un error.
     *
     * <p>\`key\` es la clave de enrutado del broker, <b>no</b> la identidad del mensaje:
     * la que deduplica viaja donde el contrato del diseño diga (metadata, cabecera o
     * campo), y de eso se encarga cada \`deliverXxx\`.
     */`;

  if (broker.id === 'rabbitmq') {
    const publish = deliverParts('rabbitmq', {
      bodyFile: expr('DELIVER_BODY'),
      base: expr('RABBIT_EXCHANGE_API'),
      destination: expr('destination')
    });
    return `
    /**
     * API de gestión hasta el exchange, sin incluirlo: el destino se le concatena.
     *
     * <p>Se publica en el exchange del canal, <b>no</b> en {@code amq.default}: ese enruta por
     * nombre de COLA, y el canal de una suscripción es un exchange. Publicando ahí el mensaje
     * no llegaba a ninguna cola y RabbitMQ no se quejaba — 200 y {@code "routed":false}.
     */
    private static final String RABBIT_EXCHANGE_API = "${ENDPOINTS.rabbitmq.exchangeApi}";
${doc}
    protected static void deliverMessage(String destination, String key, String body, Map<String, String> headers) {
        // El cuerpo va en base64: incrustar un JSON dentro del campo \`payload\` (que es
        // una cadena JSON) exigiría escaparlo a mano, y ahí es donde se pierde un cuerpo.
        String request = ${rabbitPublishBodyJava({
          key: 'key',
          headers: 'headersJson(headers)',
          routingKey: 'key',
          payload: 'Base64.getEncoder().encodeToString(body.getBytes(StandardCharsets.UTF_8))'
        })};
        copyToDevtools(request, DELIVER_BODY);
        String published = devtools(${javaArgs(publish)});
        // Publicar donde no hay binding que case NO es un error para RabbitMQ: contesta 200 y
        // \`"routed":false\`, así que el curl sale con 0 y la entrega parece hecha. El mensaje
        // no llega, el consumidor no reacciona, y el escenario muere mucho después en un
        // timeout que habla de otra cosa. Se falla aquí, con el destino delante.
        if (!published.contains("\\"routed\\":true")) {
            throw new IllegalStateException(
                    "RabbitMQ aceptó la publicación en '" + destination + "' pero no la enrutó a ninguna cola"
                            + " (routed:false): ¿existe el exchange y hay una cola bindeada? Respuesta: " + published);
        }
    }
${headersJsonHelper()}`;
  }

  if (broker.id === 'snssqs') {
    return `
    /** Archivo del contenedor por el que viajan los atributos del mensaje entregado. */
    private static final String DELIVER_ATTRS = "/tmp/keel-deliver-attrs.json";

    /**
     * Prefijo del ARN de los topics. La entrega ENTRANTE se publica en el topic de
     * la fuente —no en la cola de este consumidor—, que es como llega un mensaje de
     * verdad: por la suscripción SNS→SQS que siembra \`infra/init-messaging.sh\`, con
     * su filtro por \`eventType\`. Enviar directo a la cola se saltaría ese filtro.
     */
    private static final String TOPIC_ARN = "${ENDPOINTS.snssqs.topicArnPrefix}";
${doc}
    protected static void deliverMessage(String destination, String key, String body, Map<String, String> headers) {
        copyToDevtools(body, DELIVER_BODY);
        List<String> argv = new ArrayList<>(List.of(${javaArgs(
          deliverParts('snssqs', {
            destination: expr('destination'),
            bodyFile: expr('DELIVER_BODY'),
            base: expr('TOPIC_ARN')
          })
        )}));
        if (!headers.isEmpty()) {
            copyToDevtools(attributesJson(headers), DELIVER_ATTRS);
            argv.addAll(List.of(${javaArgs(
              deliverParts('snssqs', {
                destination: expr('destination'),
                bodyFile: expr('DELIVER_BODY'),
                attrsFile: expr('DELIVER_ATTRS'),
                base: expr('TOPIC_ARN'),
                withAttributes: true
              }).slice(-2)
            )}));
        }
        aws(argv.toArray(String[]::new));
    }

    /** Cabeceras → atributos de mensaje SQS, que es su equivalente en este broker. */
    private static String attributesJson(Map<String, String> headers) {
        StringBuilder json = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if (!first) {
                json.append(',');
            }
            json.append('"').append(header.getKey())
                .append("\\":{\\"DataType\\":\\"String\\",\\"StringValue\\":\\"").append(header.getValue()).append("\\"}");
            first = false;
        }
        return json.append('}').toString();
    }
`;
  }

  return `${doc}
    protected static void deliverMessage(String destination, String key, String body, Map<String, String> headers) {
        // \`-l\` manda UN MENSAJE POR LÍNEA del archivo, así que el cuerpo se colapsa a una
        // sola línea antes de copiarlo. Sin esto, un payload escrito como text block Java
        // —la forma natural de escribir JSON en un escenario— se publica troceado en varios
        // mensajes que el listener no puede deserializar, y de rebote satura la partición
        // con reintentos hasta la dead-letter. JSON válido no necesita saltos de línea
        // fuera de las cadenas, y dentro de una cadena viajan escapados como \\n.
        copyToDevtools(${collapseToSingleLineJava('body')}, DELIVER_BODY);
        StringBuilder command = new StringBuilder("${kafkaDeliverPrefix()}")
            .append(shellQuote(destination)).append(" -k ").append(shellQuote(key));
        headers.forEach((name, value) -> command.append(" -H ").append(shellQuote(name + "=" + value)));
        devtoolsShell(command.append(" -l ").append(DELIVER_BODY).toString());
    }
`;
}

// La cabeza de la línea de kcat, derivada del mismo constructor que ejecuta el
// runner de conformidad: `kcat -P -b <bootstrap> -t ` (el destino lo añade el Java,
// que es quien lo comilla en tiempo de ejecución).
function kafkaDeliverPrefix() {
  return deliverShell({ destination: '', key: '', bodyFile: '' }).split(shellQuote(''))[0];
}

// Un método por suscripción: el escenario no debería tener que saber en qué topic vive
// el evento, ni cómo lo envuelve la fuente, ni dónde declaró el contrato la clave de
// deduplicación. Todo eso lo sabe el diseño, así que lo sabe build. Lo que queda en la
// prueba es lo único que es del escenario: el payload y si el messageId se repite.
function subscriptionDeliverySection(model) {
  const broker = brokerEntry(model);
  const subscriptions = model.subscriptions ?? [];
  if (!broker || subscriptions.length === 0) return '';
  return subscriptions.map((sub) => deliverMethod(sub)).join('');
}

function deliverMethod(sub) {
  const headers = [];
  if (sub.discriminator?.location === 'header') {
    headers.push(`"${sub.discriminator.name}", "${sub.discriminator.value ?? sub.name}"`);
  }
  // El tipo del evento como atributo NATIVO del mensaje, además de donde lo lleve la
  // envoltura. En SNS no es decorativo: `init-messaging.sh` suscribe cada cola con una
  // FilterPolicy sobre el atributo `eventType`, así que un mensaje sin él lo descarta el
  // broker EN SILENCIO — el escenario espera un efecto que nunca se dispara y el fallo
  // apunta al handler, que no llegó a enterarse. En Kafka y RabbitMQ no enruta nada, pero
  // es lo que estampa un emisor real (`props.setType`, header del record), así que
  // mandarlo iguala el arnés a la fuente que suplanta en vez de a un caso especial.
  // Si el discriminador del diseño YA ocupa ese nombre, no se repite: `Map.of` con dos
  // claves iguales revienta en tiempo de ejecución.
  if (sub.discriminator?.location !== 'header' || sub.discriminator.name !== 'eventType') {
    headers.push(`"eventType", "${sub.name}"`);
  }
  if (sub.messageId?.location === 'header') {
    headers.push(`"${sub.messageId.name}", messageId`);
  }
  // La identidad del emisor, cuando el contrato dice que viaja en una cabecera del
  // broker. Es un parámetro y no una constante porque el escenario multi-inquilino
  // consiste precisamente en entregar dos mensajes que solo difieren en esto.
  const delivery = sub.identityDelivery;
  if (delivery?.placement === 'header') {
    headers.push(`"${delivery.name}", ${IDENTITY_PARAM}`);
  }
  const headerMap = headers.length > 0 ? `Map.of(${headers.join(', ')})` : 'Map.of()';

  // Dónde vive la identidad del mensaje decide qué escenario de reentrega es posible:
  // si el contrato no la declara en ninguna parte, el consumidor solo puede deduplicar
  // por el eventId de la envoltura Keel, y con `none` no hay ninguno.
  const identity =
    sub.envelope === 'keel'
      ? 'el `eventId` de la envoltura Keel'
      : sub.messageId
        ? `el ${sub.messageId.location === 'header' ? 'header' : 'campo'} \`${sub.messageId.name}\` del contrato`
        : null;

  return `
    /**
     * Entrega {@code ${sub.name}} en su canal real, con la envoltura que declara el
     * contrato del diseño (${sub.envelope}).
     *
     * <p>{@code messageId} es la identidad del mensaje${identity ? `, que viaja en ${identity}` : ''}:
     * llamar dos veces con el <b>mismo</b> valor es la <b>reentrega</b> que el consumidor
     * debe absorber sin segundo efecto, y es exactamente así como se escribe ese
     * escenario. Con valores distintos son dos hechos distintos, no una reentrega.${
       identity
         ? ''
         : `
     *
     * <p><b>Ojo</b>: el contrato de esta suscripción no declara {@code messageId} ni usa
     * la envoltura Keel, así que el consumidor no tiene clave con la que deduplicar. Si
     * el escenario de reentrega falla, el hueco está en el diseño, no en el código.`
     }${
       delivery
         ? `
     *
     * <p>{@code ${IDENTITY_PARAM}} es <b>la identidad de quien pide el trabajo</b>: por aquí no
     * llega ningún token, así que el contrato declara que la sustituye
     * {@code ${sub.identity.from.name}}, de donde el consumidor resuelve
     * {@code ${sub.identity.field}}. Dos entregas que solo difieran en este valor son dos
     * emisores distintos, y es así como se escribe cualquier escenario multi-inquilino. Un
     * valor que no corresponda a nadie registrado es el camino de {@code onUnresolved:
     * ${sub.identity.onUnresolved}}.`
         : ''
     }
     */
    protected static void deliver${pascalCase(sub.name)}(${deliverParams(delivery)}) {
        deliverMessage(${subscriptionTopicExpression(sub)}, messageId, ${envelopeExpression(sub)}, ${headerMap});
    }
`;
}

// El nombre del parámetro de identidad en los helpers de entrega. Único y estable:
// los escenarios lo citan por posición, pero el javadoc y las convenciones por nombre.
const IDENTITY_PARAM = 'source';

// Las suscripciones sin identidad declarada conservan la firma de dos parámetros: el
// contrato no dice que el emisor sea variable, así que pedirlo sería ruido en todos
// los escenarios que ya están escritos contra ellas.
function deliverParams(delivery) {
  return delivery
    ? `String messageId, String ${IDENTITY_PARAM}, String payloadJson`
    : 'String messageId, String payloadJson';
}

// El topic se resuelve como en el perfil `local`: la variable de entorno del parámetro
// si está, y si no el default del diseño. Es la misma regla que EVENT_TOPIC, y la razón
// es la misma: el arnés tiene que apuntar donde apunta la app, no donde cree el test.
function subscriptionTopicExpression(sub) {
  const envVar = sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');
  return `System.getenv().getOrDefault("${envVar}", "${sub.topicDefault}")`;
}

// Cómo se envuelve el payload al ponerlo en el cable, según el contrato declarado.
function envelopeExpression(sub) {
  const delivery = sub.identityDelivery;
  if (sub.envelope === 'keel') {
    // La fuente es otro servicio Keel: metadata + data, y el eventId ES la clave de
    // deduplicación por defecto del consumidor (architecture.md § correlación).
    // `metadata` deja de ser un literal cerrado SOLO cuando el contrato declara ahí la
    // identidad del emisor, que es el único campo que el escenario tiene que variar. Sin
    // ella se emite de una pieza: partir la cadena no cambiaría lo que llega al cable,
    // pero sí ensucia el arnés de todos los diseños que no la declaran.
    const head = `"{\\"metadata\\":{\\"eventId\\":\\"" + messageId + "\\",\\"eventType\\":\\"${sub.name}\\"`;
    return delivery?.placement === 'metadata'
      ? `${head}" + ",\\"${delivery.name}\\":\\"" + ${IDENTITY_PARAM} + "\\"" + "},\\"data\\":" + payloadJson + "}"`
      : `${head}},\\"data\\":" + payloadJson + "}"`;
  }
  if (sub.envelope === 'wrapped') {
    const parts = [`"{"`];
    if (sub.discriminator?.location === 'field') {
      parts.push(`+ "\\"${sub.discriminator.name}\\":\\"${sub.discriminator.value ?? sub.name}\\","`);
    }
    if (sub.messageId?.location === 'field') {
      parts.push(`+ "\\"${sub.messageId.name}\\":\\"" + messageId + "\\","`);
    }
    if (delivery?.placement === 'envelopeField') {
      parts.push(`+ "\\"${delivery.name}\\":\\"" + ${IDENTITY_PARAM} + "\\","`);
    }
    parts.push(`+ "\\"${sub.payloadPath}\\":" + payloadJson + "}"`);
    return parts.join(' ');
  }
  // `none`: el mensaje ES el payload. Si el contrato declara la identidad en un campo,
  // el escenario tiene que incluirla en el propio payloadJson — no hay dónde ponerla.
  return 'payloadJson';
}

function headersJsonHelper() {
  return `
    private static String headersJson(Map<String, String> headers) {
        StringBuilder json = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if (!first) {
                json.append(',');
            }
            json.append('"').append(header.getKey()).append("\\":\\"").append(header.getValue()).append('"');
            first = false;
        }
        return json.append('}').toString();
    }
`;
}

// Credenciales de los escenarios autenticados. Es el conocimiento que vivía en
// prosa en conventions/infra-validation.md, aquí ejecutable: el agente de
// infraestructura deja el proveedor con el realm y los usuarios que esta clase
// asume (misma convención documentada en esa convention).
function securitySection(model) {
  if (!model.layersPresent.security) return '';
  const clients = model.security?.serviceClients ?? [];

  if (!tokenProtocol(model)) {
    const clientKeys = clients
      .map((client) => `        if ("${client.name}".equals(client)) {\n            return "local-${client.name}-key";\n        }\n`)
      .join('');
    return `
    /**
     * Clave de API del entorno local, ya sembrada en
     * src/main/resources/parameters/local/security.yaml. No se inventa ni se edita:
     * cambiarla solo tiene sentido para ejercitar el 401 con clave inválida.
     */
    protected static String apiKey() {
        return "local-dev-api-key";
    }
${clientKeys ? `
    /** Clave del cliente máquina declarado en el diseño (security.api-keys.&lt;cliente&gt;). */
    protected static String serviceCredential(String client) {
${clientKeys}        throw new IllegalArgumentException("Cliente de servicio no declarado en el diseño: " + client);
    }
` : ''}
    /** Llamada autenticada por clave de API en lugar de Bearer token. */
    protected Response withApiKey(HttpMethod method, String path, String jsonBody, String apiKey) {
        HttpHeaders headers = new HttpHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        if (jsonBody != null) {
            headers.setContentType(MediaType.APPLICATION_JSON);
        }
        headers.set("X-API-Key", apiKey);
        ResponseEntity<String> entity = rest.exchange(uriOf(path), method, new HttpEntity<>(jsonBody, headers), String.class);
        Response response = new Response(entity.getStatusCode().value(), entity.getHeaders(), entity.getBody());
        FailureCapture.record(method.name(), path, headers, jsonBody, response);
        return response;
    }
`;
  }

  const serviceCred = model.security?.serviceAuth
    ? `
    /**
     * Credencial de máquina (client_credentials) del cliente declarado en
     * security.serviceClients: los escenarios \`level: service\` no usan token de
     * usuario.
     *
     * <p>El secreto sale de \`infra/test-credentials.env\`, que es donde lo dejó el
     * aprovisionamiento: primero la entrada del cliente
     * (\`AUTH_CLIENT_SECRET_&lt;CLIENTE&gt;\`), luego el default \`AUTH_CLIENT_SECRET\`.
     * Aquí no se inventa ningún literal — que las pruebas y la infraestructura
     * adivinasen cada una su secreto es exactamente lo que bloqueaba la suite entera.
     */
    protected String serviceCredential(String client) {
        return cachedToken("client:" + client, () ->
            requestToken("grant_type=client_credentials"
                + "&client_id=" + client
                + "&client_secret=" + clientSecret(client)));
    }

    private static String clientSecret(String client) {
        String key = "AUTH_CLIENT_SECRET_" + client.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "_");
        String specific = env(key, null);
        // Sin archivo de credenciales, la convención del secreto de un cliente del
        // diseño sigue siendo derivable: '<cliente>-secret' (auth-provisioning.js).
        return specific != null ? specific : env("AUTH_CLIENT_SECRET", client + "-secret");
    }
`
    : '';

  return `${
    model.security?.scoping
      ? `
    /**
     * El recurso al que alcanzan los usuarios de prueba NO exentos del alcance por recurso
     * (\`${model.security.scoping.claim}\` en el token). <b>No lo escribas a mano en un escenario</b>:
     * sale de \`infra/test-credentials.env\`, que es el mismo sitio del que lo lee el script que
     * siembra el realm. Cuando este valor y el que usa el escenario no coincidían, la clase entera
     * caía con un 403 en su \`@BeforeAll\` y el arreglo acababa siendo un parche a mano sobre un
     * archivo que regenera build.
     *
     * <p>Los roles exentos (${(model.security.scoping.exemptRoles ?? []).join(', ') || 'ninguno'}) no llevan el claim: alcanzan cualquier recurso.
     */
    protected static String scopedResource() {
        return env("AUTH_SCOPED_RESOURCE", "${model.security.scoping.testResource}");
    }
`
      : ''
  }
${
    // `tokenFor` pide un token de USUARIO con `grant_type=password`, y esos usuarios los crea
    // `init-keycloak.sh` uno por ROL declarado. Un diseño cuyo acceso es todo `level: service`
    // no declara roles, así que no hay ningún usuario que pedir: el método existía igual y su
    // javadoc prometía «un usuario por rol cuyo nombre es el rol», que ahí no es cierto. Quien
    // lo creyera se llevaba un `invalid_grant` que no se parece a su causa.
    //
    // No se arregla ajustando el javadoc —es el mismo método cuyo javadoc ya falló dos veces en
    // este repo—: se arregla no emitiéndolo. Para clientes máquina está `serviceCredential`.
    (model.security?.roles ?? []).length > 0
      ? `
    /**
     * Bearer token de un usuario con el rol pedido, cacheado por rol.
     *
     * <p>Los valores salen de \`infra/test-credentials.env\`, que genera
     * \`keel-spring build\` junto al script de aprovisionamiento: un realm por
     * servicio, el cliente público \`${userTestClient(model)}\` con direct access
     * grants y un usuario por rol cuyo nombre <b>es</b> el rol
     * (docs/keel/conventions/infra-validation.md). Sobreescribible por entorno
     * (AUTH_TOKEN_URL, AUTH_TEST_CLIENT, AUTH_TEST_PASSWORD).
     *
     * <p><b>Llámalo en cada petición; no guardes lo que devuelve.</b> La caché que hay detrás
     * renueva el token cuando le queda poca vida, pero solo puede hacerlo si se le pregunta:
     * un {@code token} capturado una vez en un campo o en {@code @BeforeAll} esquiva la
     * renovación por completo. El realm de prueba emite tokens de <b>cinco minutos</b>, así que
     * cualquier flujo con esperas reales —un rescate, una reconciliación, un barrido— se pasa
     * de ahí a mitad de clase y empieza a mandar credenciales caducadas. Lo que se ve entonces
     * no se parece a un problema de autenticación: un {@code 401} con cuerpo vacío y un
     * {@code IllegalArgumentException: json string can not be null or empty} al intentar
     * parsearlo, en un {@code Then} que no tiene nada que ver. Pedirlo por llamada no cuesta
     * nada — si sigue siendo válido, devuelve el mismo.
     */
    protected String tokenFor(String role) {
        return cachedToken(role, () ->
            requestToken("grant_type=password"
                + "&client_id=" + env("AUTH_TEST_CLIENT", "${userTestClient(model)}")
                + "&username=" + role
                + "&password=" + env("AUTH_TEST_PASSWORD", "password")));
    }

`
      : ''
  }
    /**
     * El token cacheado de esa clave, pedido de nuevo si ya no sirve.
     *
     * <p>La caché sin caducidad era un fallo con forma de 401 sin relación con nada: esta clase
     * es {@code PER_CLASS}, así que el token vive lo que dure la clase entera, y el realm de
     * prueba emite tokens de <b>cinco minutos</b> (el default de Keycloak; el aprovisionamiento
     * no fija {@code accessTokenLifespan}). Cualquier flujo con esperas largas —un rescate, una
     * reconciliación— pasa de ahí y empieza a mandar credenciales caducadas a mitad de clase.
     *
     * <p>Se renueva con margen sobre el claim {@code exp}, sin librerías: el payload de un JWT es
     * Base64 URL. Un token cuyo {@code exp} no se pueda leer se da por caducado — pedir otro
     * cuesta una llamada; usar uno inservible cuesta un escenario en rojo por el motivo equivocado.
     */
    private String cachedToken(String key, java.util.function.Supplier<String> mint) {
        String cached = credentials.get(key);
        if (cached != null && !expiresWithin(cached, TOKEN_RENEWAL_MARGIN)) {
            return cached;
        }
        String fresh = mint.get();
        credentials.put(key, fresh);
        return fresh;
    }

    /** ¿Le quedan a este token menos de {@code margin} de vida? */
    private static boolean expiresWithin(String token, Duration margin) {
        try {
            // Por índices y no con split("\\."): un regex aquí obliga a escapar el punto dos
            // veces (una para la plantilla, otra para Java) y es donde se cuela el escape roto.
            int firstDot = token.indexOf('.');
            int secondDot = firstDot < 0 ? -1 : token.indexOf('.', firstDot + 1);
            if (secondDot < 0) {
                return true;
            }
            String payload = new String(
                    java.util.Base64.getUrlDecoder().decode(token.substring(firstDot + 1, secondDot)),
                    java.nio.charset.StandardCharsets.UTF_8);
            java.util.regex.Matcher matcher = EXP_CLAIM.matcher(payload);
            if (!matcher.find()) {
                return true;
            }
            Instant expiry = Instant.ofEpochSecond(Long.parseLong(matcher.group(1)));
            return Instant.now().plus(margin).isAfter(expiry);
        } catch (RuntimeException e) {
            return true;
        }
    }
${serviceCred}
    private String requestToken(String form) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(env("AUTH_TOKEN_URL", "${tokenUrl(model)}")))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
            HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new IllegalStateException("El proveedor de identidad devolvió " + response.statusCode() + ": " + response.body());
            }
            return JsonPath.read(response.body(), "$.access_token");
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo obtener el token", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido obteniendo el token", e);
        }
    }

    /**
     * Credenciales del proveedor de identidad, por orden: variable de entorno →
     * \`infra/test-credentials.env\` → valor convencional.
     *
     * <p>El archivo lo escribe \`keel-spring build\` junto al script de
     * aprovisionamiento, así que los nombres de cliente y los secretos tienen un
     * <b>único productor</b>. Antes cada lado los hardcodeaba por su cuenta y el
     * desajuste no se veía hasta ejecutar la suite completa.
     */
    private static final Map<String, String> PROVISIONED = loadProvisionedCredentials();

    private static Map<String, String> loadProvisionedCredentials() {
        Path path = Path.of("infra", "test-credentials.env");
        if (!Files.isReadable(path)) {
            return Map.of();
        }
        try {
            Map<String, String> values = new LinkedHashMap<>();
            for (String line : Files.readAllLines(path)) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                    continue;
                }
                int separator = trimmed.indexOf('=');
                if (separator > 0) {
                    values.put(trimmed.substring(0, separator).trim(), trimmed.substring(separator + 1).trim());
                }
            }
            return values;
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo leer infra/test-credentials.env", e);
        }
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            value = PROVISIONED.get(name);
        }
        return value == null || value.isBlank() ? fallback : value;
    }
`;
}

// ─── HarnessSmokeIT ──────────────────────────────────────────────────────────
//
// Prueba de humo del propio arnés, no del servicio: reset, servidor vivo,
// credenciales, canal de eventos y caché. Existe porque el agente de pruebas
// trabaja en la fase 1 sin infraestructura levantada y no puede ejercitar la
// fontanería que hereda: un defecto en AbstractFlowIT solo se veía en la fase 2,
// con las clases de flujo ya escritas encima, y aparecía como decenas de fallos
// de negocio que no lo eran. Ejecutar esta clase primero convierte eso en un
// diagnóstico de 30 segundos.

function smokeImports(model) {
  const imports = [
    'org.junit.jupiter.api.DisplayName',
    'org.junit.jupiter.api.Order',
    'org.junit.jupiter.api.Test',
    'org.junit.jupiter.api.Assertions'
  ];
  const broker = brokerEntry(model);
  // El humo de Kafka publica un mensaje real y lo espera de vuelta; el del resto
  // de brokers solo recorre la lista de canales declarados.
  if (broker?.id === 'kafka' && Object.keys(model.messaging?.eventTypesByChannel ?? {}).length > 0) {
    imports.push('java.time.Duration', 'java.util.UUID');
  } else if (broker) {
    imports.push('java.util.List');
  }
  if (hasHttpClients(model)) {
    imports.push(
      'java.io.IOException',
      'java.net.URI',
      'java.net.http.HttpClient',
      'java.net.http.HttpRequest',
      'java.net.http.HttpResponse',
      // El humo del stub lee su log de peticiones (stubRequests).
      'java.util.List'
    );
  }
  return imports;
}

function smokeBody(model) {
  const tests = [];
  const reset = hasResetScript(model);

  tests.push(`
    @Test
    @Order(1)
    @DisplayName("SMOKE-1: el reset de estado se ejecuta sin error")
    void resetsState() {
        Assertions.assertDoesNotThrow(AbstractFlowIT::resetState,
            "El reset de estado falló: sin él ningún flujo arranca con el Given que declara.");
    }
`);

  tests.push(`
    @Test
    @Order(2)
    @DisplayName("SMOKE-2: el servidor responde")
    void serverResponds() {
        Response response = get("/actuator/health");
        Assertions.assertEquals(200, response.status(),
            "El servidor no responde en /actuator/health: " + response.body());
    }
`);

  const security = model.layersPresent.security;
  if (security && tokenProtocol(model)) {
    const role = model.security?.roles?.[0];
    const client = model.security?.serviceClients?.[0]?.name;
    const checks = [];
    if (role) {
      checks.push(`        Assertions.assertFalse(tokenFor("${role}").isBlank(),
            "El proveedor de identidad no devolvió token para el rol '${role}'.");`);
    }
    if (client && model.security?.serviceAuth) {
      checks.push(`        Assertions.assertFalse(serviceCredential("${client}").isBlank(),
            "No hay credencial de máquina para el cliente '${client}': revisa infra/test-credentials.env.");`);
    }
    if (checks.length > 0) {
      tests.push(`
    @Test
    @Order(3)
    @DisplayName("SMOKE-3: el proveedor de identidad emite credenciales")
    void issuesCredentials() {
${checks.join('\n\n')}
    }
`);
    }
  }

  const broker = brokerEntry(model);
  const publishChannels = model.messaging?.publishChannels ?? [];
  const kafkaProbes = broker?.id === 'kafka' ? Object.entries(model.messaging?.eventTypesByChannel ?? {}) : [];
  if (kafkaProbes.length > 0) {
    // Con Kafka el humo publica tráfico real y lo espera de vuelta. "Leer sin
    // lanzar excepción" no vale: Kafka autocrea el topic vacío al primer sondeo,
    // así que un topic equivocado —o un kcat que ni siquiera está consumiendo—
    // pasa en verde exactamente igual que un canal sano y purgado.
    const probes = kafkaProbes
      .map(([channel, types]) => `        probeChannel("${channel}", "${types[0]}");`)
      .join('\n');
    tests.push(`
    @Test
    @Order(4)
    @DisplayName("SMOKE-4: el sondeo de eventos lee de vuelta lo que se publica")
    void eventChannelsAreReadableAndPurgeable() {
${probes}
    }

    /**
     * Publica un mensaje sintético con el \`eventType\` del canal y comprueba que el
     * sondeo lo devuelve y que la purga lo deja fuera. Ejercita de una vez las tres
     * piezas que el humo anterior no cubría: el topic físico correcto, kcat en modo
     * consumidor y el filtrado por canal.
     */
    private void probeChannel(String channel, String eventType) {
        String marker = UUID.randomUUID().toString();
        purgeMessages(channel);
        publishRaw(eventType, "{\\"metadata\\":{\\"eventId\\":\\"" + marker + "\\",\\"eventType\\":\\"" + eventType + "\\"},\\"data\\":{}}");
        await(Duration.ofSeconds(15), () -> publishedMessages(channel, 1).contains(marker));
        purgeMessages(channel);
        Assertions.assertTrue(publishedMessages(channel, 1).isBlank(),
            "El canal '" + channel + "' sigue entregando mensajes después de purgarlo.");
    }
`);
  } else if (broker && publishChannels.length > 0) {
    tests.push(`
    @Test
    @Order(4)
    @DisplayName("SMOKE-4: cada canal de publicación se lee y se purga")
    void eventChannelsAreReadableAndPurgeable() {
        for (String channel : List.of(${publishChannels.map((name) => `"${name}"`).join(', ')})) {
            Assertions.assertDoesNotThrow(() -> publishedMessages(channel, 1),
                "No se pudo leer el canal '" + channel + "': la topología no está declarada o el sondeo está roto.");
            Assertions.assertDoesNotThrow(() -> purgeMessages(channel),
                "No se pudo purgar el canal '" + channel + "': las aserciones de mensajería leerían mensajes de la corrida anterior.");
            Assertions.assertTrue(${emptyReadExpression(broker)},
                "El canal '" + channel + "' sigue entregando mensajes después de purgarlo.");
        }
    }
`);
  }

  const cache = model.stack.cache ? CACHES[model.stack.cache] : null;
  if (cache && reset) {
    const key = `${model.service.artifactId}:keel-smoke`;
    tests.push(`
    @Test
    @Order(5)
    @DisplayName("SMOKE-5: la caché del servicio se vacía (clearCache y reset)")
    void resetClearsCache() {
        devtoolsShell("redis-cli -h ${cache.serviceKey} SET ${key} 1");
        clearCache();
        Assertions.assertEquals("0", cacheProbe(),
            "clearCache() no borra las claves '${model.service.artifactId}:*': un Then que mida un miss leería la entrada anterior.");
        devtoolsShell("redis-cli -h ${cache.serviceKey} SET ${key} 1");
        resetState();
        Assertions.assertEquals("0", cacheProbe(),
            "El reset no borra las claves '${model.service.artifactId}:*': una entrada cacheada o una clave de idempotencia sobrevive al flujo.");
    }

    private String cacheProbe() {
        return devtoolsShell("redis-cli -h ${cache.serviceKey} EXISTS ${key}").trim();
    }
`);
  }

  // El stub es fontanería como el broker: si no responde, todo flujo que llame a
  // otro servicio falla con un error de conexión que parece de negocio. Ejercita
  // el ciclo entero —programar, llamar, contar, resetear— porque cada pieza falla
  // por su cuenta (un volumen mal montado deja el admin API en pie pero sin servir).
  if (hasHttpClients(model)) {
    tests.push(`
    @Test
    @Order(6)
    @DisplayName("SMOKE-6: el proveedor de prueba se programa, responde y se resetea")
    void httpStubIsProgrammable() {
        resetStubs();
        stubFor("GET", "/__keel-smoke", 200, "{\\"ok\\":true}");
        Assertions.assertEquals(1, probeStub(), "El stub no devolvió lo programado en /__keel-smoke.");
        Assertions.assertEquals(1, stubCallCount("GET", "/__keel-smoke"),
            "El stub no contabiliza las llamadas: las aserciones sobre cuántas veces se llamó al proveedor no valdrían.");
        List<String> requests = stubRequests("GET", "/__keel-smoke");
        Assertions.assertEquals(1, requests.size(),
            "El stub no devuelve el log de peticiones: no se podría afirmar QUÉ se envió al proveedor, solo cuántas veces.");
        Assertions.assertEquals("1", stubRequestHeader(requests.get(0), "x-keel-smoke"),
            "El log de peticiones no conserva las cabeceras: la aserción sobre la cabecera de idempotencia saliente no valdría.");
        resetStubs();
        Assertions.assertEquals(0, stubCallCount("GET", "/__keel-smoke"),
            "El reset no borra el log de peticiones: un flujo contaría llamadas del anterior.");
    }

    private int probeStub() {
        try {
            HttpResponse<String> response = HttpClient.newHttpClient().send(
                    HttpRequest.newBuilder(URI.create("http://localhost:8090/__keel-smoke"))
                            // Cabecera propia: la busca el humo por su nombre en OTRO caso, que
                            // es como llegan las que pone un cliente HTTP de verdad.
                            .header("X-Keel-Smoke", "1")
                            .GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200 && response.body().contains("\\"ok\\"") ? 1 : 0;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new AssertionError("El proveedor de prueba no responde en http://localhost:8090", e);
        }
    }
`);
  }

  // El buzón es fontanería igual que el broker: si no responde, todo flujo que
  // termine en un correo falla en su Then con un error de conexión que no dice nada
  // sobre el servicio. Y que arranque VACÍO importa tanto como que responda — un
  // correo de la corrida anterior hace que el primer awaitMailTo devuelva el
  // mensaje equivocado, y el escenario falla (o pasa) por el motivo que no es.
  if (hasMail(model)) {
    tests.push(`
    @Test
    @Order(7)
    @DisplayName("SMOKE-7: el buzón de prueba responde y el reset lo deja vacío")
    void mailSinkIsReachable() {
        Assertions.assertEquals(0, mailCount("humo@keel.test"),
            "El buzón no arranca vacío: un correo de la corrida anterior haría que el primer awaitMailTo de un flujo devolviera el mensaje equivocado.");
    }
`);
  }

  return `/**
 * Humo del <b>arnés</b>, no del servicio: comprueba que la fontanería de
 * {@link AbstractFlowIT} funciona contra la infraestructura levantada antes de
 * que nadie interprete un fallo de flujo como un fallo de negocio.
 *
 * <p>Es lo primero que ejecuta la fase de validación
 * (\`./gradlew integrationTest --tests '*HarnessSmokeIT'\`). En rojo, el problema
 * está en el arnés o en la infraestructura: no tiene sentido correr la suite ni
 * relanzar al agente de pruebas.
 *
 * <p>La genera \`keel-spring build\` y <b>no se edita</b> para hacerla pasar: si
 * falla, o falta infraestructura o el defecto es del generador.
 */
@DisplayName("Humo del arnés de pruebas")
class HarnessSmokeIT extends AbstractFlowIT {
${tests.join('')}}`;
}

// "Nada publicado" no se expresa igual en cada broker: RabbitMQ devuelve una
// lista JSON vacía, kcat no imprime nada y la CLI de SQS omite `Messages`. El
// predicado vive en broker-probes.js, que es lo que ejecuta `broker-check`
// contra el broker real: si aquí divergiera, el gate en vivo probaría otra cosa.
function emptyReadExpression(broker) {
  return emptyReadJava(broker.id, 'publishedMessages(channel, 1)');
}

// ─── FailureCapture ──────────────────────────────────────────────────────────

function failureCaptureImports() {
  return [
    'java.io.IOException',
    'java.io.UncheckedIOException',
    'java.nio.file.Files',
    'java.nio.file.Path',
    'java.util.LinkedHashMap',
    'java.util.List',
    'java.util.Map',
    'java.util.Optional',
    'java.util.concurrent.atomic.AtomicReference',
    'org.junit.jupiter.api.extension.ExtensionContext',
    'org.junit.jupiter.api.extension.LifecycleMethodExecutionExceptionHandler',
    'org.junit.jupiter.api.extension.TestWatcher',
    'org.springframework.http.HttpHeaders',
    'com.fasterxml.jackson.databind.ObjectMapper'
  ];
}

function failureCaptureBody() {
  return `/**
 * Evidencia de los fallos, para que arbitrar un escenario no dependa de leer un
 * stack trace: al fallar un test vuelca el último intercambio HTTP completo a
 * \`build/keel-failures/&lt;FL-id&gt;.json\`. El agente de validación lo lee junto al XML
 * de JUnit y decide \`culprit: code | test | design\`.
 *
 * <p>La evidencia se guarda por hilo y, además, en un respaldo compartido: un escenario
 * de carrera hace sus peticiones desde un pool, y sin el respaldo el volcado saldría
 * vacío justo en el fallo más difícil de arbitrar.
 */
public class FailureCapture implements TestWatcher, LifecycleMethodExecutionExceptionHandler {

    private static final Path OUTPUT = Path.of("build", "keel-failures");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ThreadLocal<Map<String, Object>> LAST = new ThreadLocal<>();
    private static final ThreadLocal<Map<String, Object>> LAST_PROBE = new ThreadLocal<>();
    // Respaldo compartido: la última evidencia venga del hilo que venga.
    //
    // Los ThreadLocal aíslan los métodos de test entre sí, que es lo correcto — pero un
    // escenario de carrera (race/raceOf) hace sus peticiones desde un pool, y ahí el
    // ThreadLocal del hilo del test está vacío: el volcado saldría sin request ni
    // response y el agente de validación tendría que arbitrar a ciegas justo en el
    // escenario más difícil de arbitrar. Se lee solo como último recurso, así que el
    // aislamiento normal no cambia.
    //
    // Es correcto porque las clases de flujo NO corren en paralelo entre sí: no hay
    // junit-platform.properties con paralelismo, y el orquestador las ejecuta en serie.
    // Si algún día se activa, esto pasa a ser una fuente de evidencia cruzada y hay que
    // cambiarlo por un mapa indexado por test.
    private static final AtomicReference<Map<String, Object>> LAST_ANY = new AtomicReference<>();
    private static final AtomicReference<Map<String, Object>> LAST_PROBE_ANY = new AtomicReference<>();

    /** Registra el intercambio en curso; solo se persiste si el test falla. */
    static void record(String method, String path, HttpHeaders requestHeaders, String requestBody, AbstractFlowIT.Response response) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("method", method);
        request.put("path", path);
        request.put("headers", requestHeaders.toSingleValueMap());
        request.put("body", requestBody);

        Map<String, Object> received = new LinkedHashMap<>();
        received.put("status", response.status());
        received.put("headers", response.headers().toSingleValueMap());
        received.put("body", response.body());

        Map<String, Object> exchange = new LinkedHashMap<>();
        exchange.put("request", request);
        exchange.put("response", received);
        LAST.set(exchange);
        LAST_ANY.set(exchange);
    }

    /**
     * Registra el último sondeo de infraestructura (broker, caché) con su código de
     * salida y su salida cruda. Sin esto, un fallo de aserción sobre un evento deja
     * un volcado que solo habla de HTTP y no dice nada de por qué el canal devolvió
     * lo que devolvió — que es justo lo que hay que arbitrar.
     */
    static void recordProbe(List<String> command, int exitCode, String output) {
        Map<String, Object> probe = new LinkedHashMap<>();
        probe.put("command", String.join(" ", command));
        probe.put("exitCode", exitCode);
        probe.put("output", output);
        LAST_PROBE.set(probe);
        LAST_PROBE_ANY.set(probe);
    }

    /**
     * Marca del último volcado escrito, para que un fallo que llega DOS veces no se pise.
     *
     * <p>Un <code>@BeforeEach</code> que revienta pasa primero por
     * {@link #handleBeforeEachMethodExecutionException} —con el intercambio y el sondeo todavía
     * en memoria— y después por {@link #testFailed}, ya con {@link #clear} hecho. Sin esta
     * guarda el segundo sobrescribe el volcado bueno con uno que solo tiene la aserción: sin
     * request, sin response y sin <code>phase</code>. Un volcado vacío es peor que ninguno,
     * porque quien arbitra lo abre y no encuentra nada que contrastar con el <code>Then</code>.
     */
    private static final ThreadLocal<String> DUMPED = new ThreadLocal<>();

    @Override
    public void testFailed(ExtensionContext context, Throwable cause) {
        String displayName = context.getDisplayName();
        String scenario = displayName.split(":")[0].trim();
        if (scenario.equals(DUMPED.get())) {
            // Ya lo volcó el handler del ciclo de vida, y con más evidencia que la que queda aquí.
            clear();
            return;
        }
        dump(scenario, displayName, context.getTestClass().map(Class::getName).orElse("?"), null, cause);
    }

    /**
     * Un <code>@BeforeAll</code> que revienta NO pasa por {@link #testFailed}: JUnit aborta el
     * contenedor de la clase, ningún método llega a ejecutarse y el TestWatcher no recibe nada.
     *
     * <p>Y es justo la clase de fallo más cara de diagnosticar —la clase entera cae con
     * <code>initializationError</code> y sus escenarios salen como NO_EJERCITADO, que dice "sin
     * cobertura" cuando lo que hubo fue un rojo—. Hasta aquí era la única que no dejaba evidencia
     * en disco, y eso pese a que {@link #recordProbe} ya tenía en memoria el comando, su código de
     * salida y su salida completa en el instante del fallo.
     */
    @Override
    public void handleBeforeAllMethodExecutionException(ExtensionContext context, Throwable throwable) throws Throwable {
        String testClass = context.getTestClass().map(Class::getName).orElse("?");
        String simpleName = testClass.substring(testClass.lastIndexOf('.') + 1);
        dump(simpleName + "-init", context.getDisplayName(), testClass, "@BeforeAll", throwable);
        // Capturar no es tragar: se relanza para que el desenlace de la clase no cambie.
        throw throwable;
    }

    /**
     * Un <code>@BeforeEach</code> que revienta tampoco tiene garantizado el paso por
     * {@link #testFailed} — depende de la versión de JUnit—, y a diferencia del de
     * <code>@BeforeAll</code> aquí SÍ hay escenario: el contexto es el del método de prueba, así
     * que el volcado va a su <code>FL-id</code> y no a un <code>&lt;Clase&gt;-init</code>.
     *
     * <p>Es la mitad que faltaba de {@code awaitPreconditions}: sacar una espera del
     * <code>@BeforeAll</code> hace que el fallo se atribuya al escenario, pero sin esto el
     * escenario saldría FALLO <b>sin evidencia</b>, y la evidencia es justo lo que arbitra
     * {@code keel-spring-validate}.
     */
    @Override
    public void handleBeforeEachMethodExecutionException(ExtensionContext context, Throwable throwable) throws Throwable {
        String displayName = context.getDisplayName();
        dump(displayName.split(":")[0].trim(), displayName,
                context.getTestClass().map(Class::getName).orElse("?"), "@BeforeEach", throwable);
        throw throwable;
    }

    /** Vuelca el informe de un fallo con la evidencia que haya en memoria y limpia. */
    private static void dump(String scenario, String displayName, String testClass, String phase, Throwable cause) {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("scenario", scenario);
        report.put("displayName", displayName);
        report.put("testClass", testClass);
        if (phase != null) {
            report.put("phase", phase);
        }
        report.put("assertion", Optional.ofNullable(cause.getMessage()).orElse(cause.toString()));
        Map<String, Object> exchange = Optional.ofNullable(LAST.get()).orElseGet(LAST_ANY::get);
        if (exchange != null) {
            report.putAll(exchange);
        }
        Map<String, Object> probe = Optional.ofNullable(LAST_PROBE.get()).orElseGet(LAST_PROBE_ANY::get);
        if (probe != null) {
            report.put("probe", probe);
        }
        write(scenario, report);
        clear();
        DUMPED.set(scenario);
    }

    @Override
    public void testSuccessful(ExtensionContext context) {
        clear();
    }

    private static void clear() {
        DUMPED.remove();
        LAST.remove();
        LAST_PROBE.remove();
        LAST_ANY.set(null);
        LAST_PROBE_ANY.set(null);
    }

    private static void write(String scenario, Map<String, Object> report) {
        String name = scenario.replaceAll("[^A-Za-z0-9_.-]", "_");
        try {
            Files.createDirectories(OUTPUT);
            Files.writeString(
                OUTPUT.resolve((name.isEmpty() ? "unnamed" : name) + ".json"),
                JSON.writerWithDefaultPrettyPrinter().writeValueAsString(report));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}`;
}
