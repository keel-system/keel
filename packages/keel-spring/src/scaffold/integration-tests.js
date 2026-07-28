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
import { DATABASES, BROKERS, CACHES, selectedInfra } from '../lib/stack-catalog.js';
import { needsDevtools } from './devtools.js';
import { tokenUrl, userTestClient } from './auth-provisioning.js';

// El reset por script existe con las mismas condiciones con las que docker.js lo
// genera: una BD con cliResetCmd, una caché que vaciar, o destinos de mensajería
// que purgar. Sin script (H2 en memoria y nada más) el aislamiento entre clases de
// flujo lo da @DirtiesContext.
function hasResetScript(model) {
  const { layersPresent, stack } = model;
  const db = layersPresent.persistence && stack.database ? DATABASES[stack.database] : null;
  return Boolean(db?.cliResetCmd || stack.cache || purgeableChannels(model).length > 0);
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

function hasIdempotency(model) {
  return model.services.some((group) => group.operations.some((operation) => operation.idempotency));
}

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
  # Humo del arnés primero: son segundos y comprueba la fontanería de la que
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

    id = name
    if (index(id, ":") > 0) id = substr(id, 1, index(id, ":") - 1)
    gsub(/^[ \\t]+|[ \\t]+$/, "", id)
    if (id !~ /^FL-/) next

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
    'java.util.List',
    'java.util.UUID',
    'java.util.function.BooleanSupplier',
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
    'org.skyscreamer.jsonassert.JSONAssert',
    'org.skyscreamer.jsonassert.JSONCompareMode'
  ];
  if (reset || devtools || oidc) imports.push('java.io.IOException');
  // Resolución explícita del bash con el que se invocan los scripts de infra/.
  if (reset) imports.push('java.io.File', 'java.util.Locale');
  if (devtools) imports.push('java.nio.charset.StandardCharsets', 'java.util.ArrayList');
  // El cuerpo del sondeo de RabbitMQ viaja por archivo, no por línea de comandos.
  if (broker?.id === 'rabbitmq') imports.push('java.nio.file.Files', 'java.nio.file.Path');
  // Marcas de offset por destino (aislamiento de Kafka, que no tiene purga).
  if (broker?.id === 'kafka') imports.push('java.util.Map', 'java.util.concurrent.ConcurrentHashMap');
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
  if (needsDirtiesContext(model)) imports.push('org.springframework.test.annotation.DirtiesContext');
  return imports;
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
    @Autowired
    protected TestRestTemplate rest;
${security && tokenProtocol(model) ? '\n    private final Map<String, String> credentials = new ConcurrentHashMap<>();\n' : ''}
    @BeforeAll
    void configureHttpClient() {
        // El factory por defecto (HttpURLConnection) no soporta PATCH; el del
        // HttpClient del JDK sí, y no añade dependencias.
        rest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
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

    protected String idempotencyKey() {
        return UUID.randomUUID().toString();
    }
${hasMultipart(model) ? `
    /** Subida multipart: la parte binaria más los campos simples del formulario. */
    protected Response multipart(String path, String partName, String filename, String contentType, byte[] content, Map<String, String> fields${security ? ', String token' : ''}) {
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
        headers.set("Idempotency-Key", idempotencyKey());${security ? `
        if (token != null) {
            headers.setBearerAuth(token);
        }` : ''}
        ResponseEntity<String> entity = rest.exchange(path, HttpMethod.POST, new HttpEntity<>(form, headers), String.class);
        Response response = new Response(entity.getStatusCode().value(), entity.getHeaders(), entity.getBody());
        FailureCapture.record("POST (multipart)", path, headers, "<" + content.length + " bytes>", response);
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
        try {
            JSONAssert.assertEquals(expectedJson, response.body(), JSONCompareMode.STRICT);
        } catch (Exception e) {
            throw new AssertionError("El cuerpo no coincide con el esperado: " + e.getMessage(), e);
        }
    }

    /** Valor no determinista del cuerpo (id generado, marca de tiempo), por JsonPath. */
    protected <T> T jsonPath(Response response, String path) {
        return JsonPath.read(response.body(), path);
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

    // ── Estado e infraestructura ─────────────────────────────────────────────
${resetSection(model)}${devtoolsSection(model)}${securitySection(model)}}`;
}

function resetSection(model) {
  const script = hasResetScript(model);
  // Kafka no tiene purga: su parte del reset es marcar el offset actual de cada
  // destino, y eso vive en el proceso de test, no en el script.
  const kafka = brokerEntry(model)?.id === 'kafka';
  const marks = kafka ? '\n            markChannels();' : '';

  if (!script) {
    return `
    /**
     * Sin script de reset: la BD es en memoria y el aislamiento lo da
     * \`@DirtiesContext\` a nivel de clase. Se conserva el método para que toda clase
     * de flujo llame a lo mismo desde su \`@BeforeAll\`.
     */
    protected static void resetState() {${
      kafka
        ? `
        markChannels();`
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
     * de la caché y destinos de mensajería declarados. Un recurso que no esté en esa
     * lista <b>no</b> se puede dar por limpio.
     */
    protected static void resetState() {
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

    private static String containerRuntime;
${brokerSection(model)}
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
            throw new IllegalStateException("No se pudo hablar con devtools: " + String.join(" ", command), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido hablando con devtools", e);
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

// Lectura y aislamiento del canal de eventos, por broker. La API es la misma en
// los tres: publishedMessages(destino, n) devuelve lo publicado desde la última
// purga/marca, y purgeMessages(destino) reabre esa ventana.
function brokerSection(model) {
  const broker = brokerEntry(model);
  if (!broker) return '';
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
    return `
    private static final String RABBIT_API = "http://rabbitmq:15672/api/queues/%2F/";

    private static final String PROBE_BODY = "/tmp/keel-probe.json";
${doc}
    protected static String publishedMessages(String destination, int count) {
        // Peek (ack_requeue_true): leer no consume, así que un escenario puede
        // assertar dos veces sobre el mismo mensaje.
        copyToDevtools("{\\"count\\":" + count + ",\\"ackmode\\":\\"ack_requeue_true\\",\\"encoding\\":\\"auto\\"}", PROBE_BODY);
        return devtools("curl", "-sf", "-u", "guest:guest", "-H", "content-type: application/json",
            "-XPOST", "-d", "@" + PROBE_BODY, RABBIT_API + destination + "/get");
    }
${purgeDoc}
    protected static void purgeMessages(String destination) {
        devtools("curl", "-sf", "-u", "guest:guest", "-XDELETE", RABBIT_API + destination + "/contents");
    }

    /**
     * Copia el cuerpo del sondeo al contenedor en vez de pasarlo como argumento: un
     * JSON con comillas dentro de la línea de comandos es exactamente lo que el
     * cliente de contenedores corrompe en Windows.
     */
    private static void copyToDevtools(String content, String target) {
        try {
            Path temp = Files.createTempFile("keel-probe", ".json");
            Files.writeString(temp, content, StandardCharsets.UTF_8);
            runProcess(List.of(containerRuntime(), "cp", temp.toString(), DEVTOOLS_CONTAINER + ":" + target));
            Files.deleteIfExists(temp);
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo preparar el cuerpo del sondeo de mensajería", e);
        }
    }
`;
  }

  if (broker.id === 'snssqs') {
    return `
    private static final String QUEUE_URL = "http://localstack:4566/000000000000/";

    private static final List<String> AWS = List.of("aws", "--endpoint-url", "http://localstack:4566", "--region", "us-east-1");
${doc}
    protected static String publishedMessages(String destination, int count) {
        return aws("sqs", "receive-message", "--queue-url", QUEUE_URL + destination,
            "--max-number-of-messages", String.valueOf(count), "--visibility-timeout", "0");
    }
${purgeDoc}
    protected static void purgeMessages(String destination) {
        // PurgeQueue está limitada a una vez cada 60 s por cola en AWS real;
        // LocalStack no aplica esa cuota.
        aws("sqs", "purge-queue", "--queue-url", QUEUE_URL + destination);
    }

    private static String aws(String... arguments) {
        List<String> argv = new ArrayList<>(AWS);
        argv.addAll(List.of(arguments));
        return devtools(argv.toArray(String[]::new));
    }
`;
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
     * (\`.claude/conventions/mapping.md\` § messaging). Se resuelve igual que el perfil
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
        MARKS.put(channel, nextOffset());
    }

    /** Marca todos los canales declarados: es la parte del reset que el script no puede hacer. */
    private static void markChannels() {
        long offset;
        try {
            offset = nextOffset();
        } catch (RuntimeException e) {
            // El topic aún no existe porque nadie ha publicado: la marca es 0.
            offset = 0L;
        }
        for (String channel : CHANNELS) {
            MARKS.put(channel, offset);
        }
    }

    /**
     * Lee el topic del servicio desde un offset. El flag <b>\`-C\` es obligatorio</b>:
     * kcat elige modo productor cuando su stdin no es un terminal —que es el caso de
     * un \`exec\` lanzado por ProcessBuilder— y devolvería éxito con salida vacía, un
     * falso negativo indistinguible de "el evento aún no llegó".
     */
    private static String readTopic(String offset) {
        return devtools("kcat", "-C", "-b", "kafka:29092", "-t", EVENT_TOPIC, "-o", offset, "-e", "-q");
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
     * <p>Asume <b>una partición</b> en el topic del servicio, que es lo que crea el
     * Kafka single-node de \`infra/docker-compose.yaml\`.
     */
    private static long nextOffset() {
        String output = devtools("kcat", "-C", "-b", "kafka:29092", "-t", EVENT_TOPIC, "-o", "beginning", "-e", "-q", "-f", "%o\\\\n");
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
        devtoolsShell("printf '%s' " + shellQuote(payload)
            + " | kcat -P -b kafka:29092 -t " + EVENT_TOPIC + " -k " + shellQuote(key));
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\\\''") + "'";
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
     * (.claude/conventions/infra-validation.md). Sobreescribible por entorno
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
    @DisplayName("SMOKE-5: el reset vacía la caché del servicio")
    void resetClearsCache() {
        devtoolsShell("redis-cli -h ${cache.serviceKey} SET ${key} 1");
        resetState();
        Assertions.assertEquals("0", devtoolsShell("redis-cli -h ${cache.serviceKey} EXISTS ${key}").trim(),
            "El reset no borra las claves '${model.service.artifactId}:*': una entrada cacheada o una clave de idempotencia sobrevive al flujo.");
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
// lista JSON vacía, kcat no imprime nada y la CLI de SQS omite `Messages`.
function emptyReadExpression(broker) {
  if (broker.id === 'rabbitmq') return 'publishedMessages(channel, 1).trim().equals("[]")';
  if (broker.id === 'snssqs') return '!publishedMessages(channel, 1).contains("\\"Messages\\"")';
  return 'publishedMessages(channel, 1).isBlank()';
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
 */
public class FailureCapture implements TestWatcher {

    private static final Path OUTPUT = Path.of("build", "keel-failures");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ThreadLocal<Map<String, Object>> LAST = new ThreadLocal<>();
    private static final ThreadLocal<Map<String, Object>> LAST_PROBE = new ThreadLocal<>();

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
        Map<String, Object> exchange = LAST.get();
        if (exchange != null) {
            report.putAll(exchange);
        }
        Map<String, Object> probe = LAST_PROBE.get();
        if (probe != null) {
            report.put("probe", probe);
        }
        write(scenario, report);
        LAST.remove();
        LAST_PROBE.remove();
    }

    @Override
    public void testSuccessful(ExtensionContext context) {
        LAST.remove();
        LAST_PROBE.remove();
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
