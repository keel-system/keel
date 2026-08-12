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
import { pascalCase } from '../lib/naming.js';
import { DATABASES, BROKERS, CACHES, selectedInfra, brokerContainer } from '../lib/stack-catalog.js';
import { cacheFlushCmd, concreteCmd, needsDevtools } from './devtools.js';
import { usesOutbox } from './outbox.js';
import { deadLetterDestination, deadLetterSubscriptions, usesDeadLetter } from '../lib/dead-letter.js';
import { needsMessagingProvisioning } from './messaging-provisioning.js';
import { tokenUrl, userTestClient } from './auth-provisioning.js';
import { declaresIdempotency } from './http-idempotency.js';
// Fuente única de los comandos de broker: lo que se emite aquí es lo mismo que
// `scripts/broker-check.js` ejecuta contra los brokers reales.
import {
  ENDPOINTS,
  deliverParts,
  deliverShell,
  emptyReadJava,
  expr,
  javaArgs,
  offsetsParts,
  prefix,
  purgeParts,
  rabbitProbeBodyJava,
  rabbitPublishBodyJava,
  readParts,
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
    { path: 'infra/score-scenarios.sh', content: scoreScenariosScript(model) }
  ];
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
#   2  precondición o arnés roto: la suite no se ejecutó, no hay matriz que leer
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

score_only=0
[ "\${1:-}" = "--score" ] && score_only=1

if [ "$score_only" -eq 0 ]; then
  rm -rf "$RESULTS"
${replicaJarStep(model)}  # Humo del arnés primero: son segundos y comprueba la fontanería de la que
  # dependen TODAS las clases de flujo (reset, servidor vivo, credenciales,
  # canales, caché). En rojo no se ejecuta la suite: correrla sobre una
  # fontanería rota produce decenas de fallos que parecen de negocio y no lo
  # son, y cuesta una pasada entera descubrirlo.
  echo "Humo del arnés (HarnessSmokeIT)…"
  if ! ./gradlew integrationTest --tests '*HarnessSmokeIT' --console=plain >"$LOG" 2>&1; then
    echo ""
    echo "HARNESS: KO — la suite NO se ejecutó."
    echo "  El defecto está en el andamiaje que generó build (AbstractFlowIT,"
    echo "  FailureCapture, HarnessSmokeIT) o falta infraestructura."
    echo "  log: $LOG"
    exit 2
  fi
  echo "Humo del arnés: OK."
  echo "Ejecutando la suite completa…"
  ./gradlew integrationTest --console=plain >>"$LOG" 2>&1
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

echo ""
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ] && [ "$ok" -gt 0 ]; then
  echo "RESULTADO: OK — $ok escenario(s) al 100%."
  exit 0
fi

echo "RESULTADO: KO — $ok OK · $ko FALLO · $sk omitido(s) · $nc no ejercitado(s)."
echo "  evidencia por fallo: $EVIDENCE/<FL-id>.json (request, response y aserción)"
echo "  log completo de Gradle: $LOG"
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
    'java.util.UUID',
    'java.util.function.BooleanSupplier',
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
  if (reset || containerExec || oidc) imports.push('java.io.IOException');
  // Resolución explícita del bash con el que se invocan los scripts de infra/: la
  // usan el reset de estado y la resiembra de topología de startBroker().
  if (reset || needsBrokerReseed(model)) imports.push('java.io.File', 'java.util.Locale');
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
  // `Set.copyOf` deduplica los destinos de descarte al marcarlos: varias suscripciones
  // multiplexadas sobre el mismo topic comparten DLT, y marcarlo dos veces gastaría un
  // sondeo de más contra el broker por cada clase de flujo.
  if (broker?.id === 'kafka' && usesDeadLetter(model)) imports.push('java.util.Set');
  // Flag de la caída provocada por el propio escenario (palanca del outbox).
  if (usesBrokerControl(model)) imports.push('java.util.concurrent.atomic.AtomicBoolean');
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
${security && tokenProtocol(model) ? '\n    private final Map<String, String> credentials = new ConcurrentHashMap<>();\n' : ''}${inMemoryStateFields(model)}
    @BeforeAll
    void configureHttpClient() {
        // El factory por defecto (HttpURLConnection) no soporta PATCH; el del
        // HttpClient del JDK sí, y no añade dependencias.
        rest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());${inMemoryStateCapture(model)}
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
` : ''}
    private Response exchange(HttpMethod method, String path, String jsonBody, String token, String idempotencyKey) {
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
        ResponseEntity<String> entity = rest.exchange(path, method, new HttpEntity<>(jsonBody, headers), String.class);
        Response response = new Response(entity.getStatusCode().value(), entity.getHeaders(), entity.getBody());
        FailureCapture.record(method.name(), path, headers, jsonBody, response);
        return response;
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
        ResponseEntity<String> entity = rest.exchange(url, HttpMethod.POST, new HttpEntity<>(form, headers), String.class);
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
        return JsonPath.read(response.body(), path);
    }

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
${resetSection(model)}${inMemoryResetSection(model)}${bashExecutableSection(model)}${httpStubSection(model)}${devtoolsSection(model)}${brokerControlSection(model)}${replicaSection(model)}${dbSection(model)}${containerExecSection(model)}${securitySection(model)}}`;
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
        try {
            Process process = new ProcessBuilder(bashExecutable(), "infra/reset-db.sh").inheritIO().start();
            int exit = process.waitFor();
            if (exit != 0) {
                throw new IllegalStateException("infra/reset-db.sh falló (código " + exit + "). ¿Está la infraestructura arriba?");
            }${marks}
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo ejecutar infra/reset-db.sh", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido reseteando el estado", e);
        }
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
` : ''}${brokerSection(model)}${deadLetterSection(model)}${deliverySection(model)}${subscriptionDeliverySection(model)}
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
                            "--server.port=" + REPLICA_PORT)
                    .redirectErrorStream(true)
                    .redirectOutput(log.toFile())
                    .start();
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo arrancar la segunda réplica desde " + jar, e);
        }
        awaitReplicaReady(log);
        return REPLICA_PORT;
    }

    /** Para la réplica. Idempotente: sobre una ya parada no hace nada. */
    protected static void stopReplica() {
        if (REPLICA == null) {
            return;
        }
        REPLICA.destroy();
        try {
            if (!REPLICA.waitFor(30, TimeUnit.SECONDS)) {
                REPLICA.destroyForcibly();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            REPLICA.destroyForcibly();
        }
        REPLICA = null;
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

function brokerControlSection(model) {
  if (!usesBrokerControl(model)) return '';
  const broker = brokerEntry(model);
  const reseed = needsBrokerReseed(model)
    ? `
        reseedTopology();`
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
        try {
            Process process = new ProcessBuilder(bashExecutable(), "infra/init-messaging.sh").inheritIO().start();
            if (process.waitFor() != 0) {
                throw new IllegalStateException("infra/init-messaging.sh falló al resembrar la topología tras levantar el broker");
            }
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo ejecutar infra/init-messaging.sh", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido resembrando la topología", e);
        }
    }
`
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
        runProcess(List.of(containerRuntime(), "start", BROKER_CONTAINER));
        awaitBrokerReady();${reseed}
        // Se limpia DESPUÉS del sondeo: entre el \`start\` y el primer listener que
        // responde el broker sigue sin servir, y una lectura ahí tiene que tolerarse
        // igual que durante la parada.
        BROKER_STOPPED.set(false);
    }

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
     * Restaura el broker si algún escenario lo dejó caído. Idempotente: sobre un
     * contenedor ya arrancado, \`start\` no hace nada y el sondeo acierta a la primera.
     */
    private static void restoreBroker() {
        startBroker();
    }

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
function dbSection(model) {
  const entry = dbEntry(model);
  if (!entry) return '';
  const dbName = model.service.name.replaceAll('-', '_');
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
     * <p>La invocación del motor elegido (${entry.label}), la misma que usa
     * \`infra/validate-infra.sh\`:
     * <pre>dbShell(${javaString(concreteCmd(entry, dbName))});</pre>
     */
    protected static String db(String... argv) {
        List<String> command = new ArrayList<>(List.of(containerRuntime(), "exec", DB_CONTAINER));
        command.addAll(List.of(argv));
        return runProcess(command);
    }

    /** Igual que {@link #db}, pero a través de un shell: pipes y redirecciones. */
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
        try {
            Path temp = Files.createTempFile("keel-body", ".json");
            Files.writeString(temp, content, StandardCharsets.UTF_8);
            runProcess(List.of(containerRuntime(), "cp", temp.toString(), DEVTOOLS_CONTAINER + ":" + target));
            Files.deleteIfExists(temp);
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo preparar el cuerpo para devtools", e);
        }
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
     */
    private static String emptyIfBrokerStopped(RuntimeException e) {
        if (brokerIntentionallyStopped()) {
            return "";
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
    const read = readParts('rabbitmq', { destination: expr('destination'), bodyFile: expr('PROBE_BODY'), base });
    const purge = purgeParts('rabbitmq', { destination: expr('destination'), base });
    return `
    private static final String RABBIT_API = "${ENDPOINTS.rabbitmq.queuesApi}";

    private static final String PROBE_BODY = "/tmp/keel-probe.json";
${doc}
    protected static String publishedMessages(String destination, int count) {
        // Peek (ack_requeue_true): leer no consume, así que un escenario puede
        // assertar dos veces sobre el mismo mensaje.
        copyToDevtools(${rabbitProbeBodyJava('count')}, PROBE_BODY);
        try {
            return devtools(${javaArgs(read)});
        } catch (RuntimeException e) {
            return emptyIfBrokerStopped(e);
        }
    }
${purgeDoc}
    protected static void purgeMessages(String destination) {
        devtools(${javaArgs(purge)});
    }
${outage}`;
  }

  if (broker.id === 'snssqs') {
    const base = expr('QUEUE_URL');
    const read = readParts('snssqs', { destination: expr('destination'), count: expr('String.valueOf(size)'), base });
    const purge = purgeParts('snssqs', { destination: expr('destination'), base });
    return `
    private static final String QUEUE_URL = "${ENDPOINTS.snssqs.queueUrlPrefix}";

    private static final List<String> AWS = List.of(${javaArgs(prefix('snssqs'))});
${doc}
    protected static String publishedMessages(String destination, int count) {
        // SQS acota \`--max-number-of-messages\` a 1..10 y contesta InvalidParameterValue
        // por encima: pedir de una vez los mensajes de un escenario de clúster reventaba
        // la lectura en vez de esperar. Se pide por lotes y se corta en cuanto uno vuelve
        // INCOMPLETO, que es la señal de que la cola no tiene más — seguir pidiendo con
        // \`--visibility-timeout 0\` devolvería otra vez los mismos, y un conteo sobre el
        // texto acumulado los contaría dos veces.
        StringBuilder batches = new StringBuilder();
        int remaining = Math.max(count, 1);
        try {
            while (remaining > 0) {
                int size = Math.min(remaining, 10);
                String batch = aws(${javaArgs(read)});
                batches.append(batch);
                remaining -= size;
                if (receivedCount(batch) < size) {
                    break;
                }
            }
        } catch (RuntimeException e) {
            return emptyIfBrokerStopped(e);
        }
        return batches.toString();
    }

    /** Cuántos mensajes trae una respuesta de {@code receive-message}: uno por cuerpo. */
    private static int receivedCount(String response) {
        int total = 0;
        for (int at = response.indexOf("\\"Body\\""); at >= 0; at = response.indexOf("\\"Body\\"", at + 1)) {
            total++;
        }
        return total;
    }
${purgeDoc}
    protected static void purgeMessages(String destination) {
        // PurgeQueue está limitada a una vez cada 60 s por cola en AWS real;
        // LocalStack no aplica esa cuota.
        aws(${javaArgs(purge)});
    }

    private static String aws(String... arguments) {
        List<String> argv = new ArrayList<>(AWS);
        argv.addAll(List.of(arguments));
        return devtools(argv.toArray(String[]::new));
    }
${outage}`;
  }

  // Kafka: sin purga posible (kcat no borra registros y devtools no trae las CLIs
  // de Kafka). El aislamiento equivalente es una marca de offset por canal sobre el
  // topic único del servicio.
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
    protected static String publishedMessages(String channel, int count) {
        Long mark = MARKS.get(channel);
        // Con marca se lee todo lo publicado después de ella; sin marca, los últimos
        // \`count\` (lo que hacía este helper antes de existir el aislamiento).
        String offset = mark != null ? String.valueOf(mark) : "-" + count;
        return filterByChannel(readTopic(offset), channel);
    }
${purgeDoc}
    protected static void purgeMessages(String channel) {
        MARKS.put(channel, safeNextOffset());
    }

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
    const publish = deliverParts('rabbitmq', { bodyFile: expr('DELIVER_BODY'), base: expr('RABBIT_PUBLISH') });
    return `
    /** Publicación por el exchange por defecto: la routing key <b>es</b> el nombre de la cola. */
    private static final String RABBIT_PUBLISH = "${ENDPOINTS.rabbitmq.publishApi}";
${doc}
    protected static void deliverMessage(String destination, String key, String body, Map<String, String> headers) {
        // El cuerpo va en base64: incrustar un JSON dentro del campo \`payload\` (que es
        // una cadena JSON) exigiría escaparlo a mano, y ahí es donde se pierde un cuerpo.
        String request = ${rabbitPublishBodyJava({
          key: 'key',
          headers: 'headersJson(headers)',
          destination: 'destination',
          payload: 'Base64.getEncoder().encodeToString(body.getBytes(StandardCharsets.UTF_8))'
        })};
        copyToDevtools(request, DELIVER_BODY);
        devtools(${javaArgs(publish)});
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
        copyToDevtools(body, DELIVER_BODY);
        // \`-l\`: el archivo es UNA línea y por tanto UN mensaje.
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
     }
     */
    protected static void deliver${pascalCase(sub.name)}(String messageId, String payloadJson) {
        deliverMessage(${subscriptionTopicExpression(sub)}, messageId, ${envelopeExpression(sub)}, ${headerMap});
    }
`;
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
  if (sub.envelope === 'keel') {
    // La fuente es otro servicio Keel: metadata + data, y el eventId ES la clave de
    // deduplicación por defecto del consumidor (architecture.md § correlación).
    return (
      `"{\\"metadata\\":{\\"eventId\\":\\"" + messageId + "\\",\\"eventType\\":\\"${sub.name}\\"},\\"data\\":" + payloadJson + "}"`
    );
  }
  if (sub.envelope === 'wrapped') {
    const parts = [`"{"`];
    if (sub.discriminator?.location === 'field') {
      parts.push(`+ "\\"${sub.discriminator.name}\\":\\"${sub.discriminator.value ?? sub.name}\\","`);
    }
    if (sub.messageId?.location === 'field') {
      parts.push(`+ "\\"${sub.messageId.name}\\":\\"" + messageId + "\\","`);
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
        ResponseEntity<String> entity = rest.exchange(path, method, new HttpEntity<>(jsonBody, headers), String.class);
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
        return credentials.computeIfAbsent("client:" + client, key ->
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

  return `
    /**
     * Bearer token de un usuario con el rol pedido, cacheado por rol.
     *
     * <p>Los valores salen de \`infra/test-credentials.env\`, que genera
     * \`keel-spring build\` junto al script de aprovisionamiento: un realm por
     * servicio, el cliente público \`${userTestClient(model)}\` con direct access
     * grants y un usuario por rol cuyo nombre <b>es</b> el rol
     * (docs/keel/conventions/infra-validation.md). Sobreescribible por entorno
     * (AUTH_TOKEN_URL, AUTH_TEST_CLIENT, AUTH_TEST_PASSWORD).
     */
    protected String tokenFor(String role) {
        return credentials.computeIfAbsent(role, key ->
            requestToken("grant_type=password"
                + "&client_id=" + env("AUTH_TEST_CLIENT", "${userTestClient(model)}")
                + "&username=" + key
                + "&password=" + env("AUTH_TEST_PASSWORD", "password")));
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
public class FailureCapture implements TestWatcher {

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

    @Override
    public void testFailed(ExtensionContext context, Throwable cause) {
        String displayName = context.getDisplayName();
        String scenario = displayName.split(":")[0].trim();

        Map<String, Object> report = new LinkedHashMap<>();
        report.put("scenario", scenario);
        report.put("displayName", displayName);
        report.put("testClass", context.getTestClass().map(Class::getName).orElse("?"));
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
    }

    @Override
    public void testSuccessful(ExtensionContext context) {
        clear();
    }

    private static void clear() {
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
