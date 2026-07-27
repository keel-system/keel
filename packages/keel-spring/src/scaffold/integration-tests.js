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
import { DATABASES, BROKERS } from '../lib/stack-catalog.js';
import { tokenUrl, userTestClient } from './auth-provisioning.js';

// Lectura de los últimos mensajes de un destino, ejecutada dentro del contenedor
// devtools (mismo mecanismo que infra/validate-infra.sh). Formato de String.format:
// %s/%1$s = destino, %d/%2$d = nº de mensajes. Sin entrada para un broker ⇒ no se
// genera el helper. Los valores son literales Java ya escapados.
const EVENT_READ_CMD = {
  kafka: 'kcat -b kafka:29092 -t %s -o -%d -e -q',
  rabbitmq:
    'curl -sf -u guest:guest -H \'content-type: application/json\' -XPOST -d \'{\\"count\\":%2$d,\\"ackmode\\":\\"ack_requeue_true\\",\\"encoding\\":\\"auto\\"}\' http://rabbitmq:15672/api/queues/%%2F/%1$s/get',
  snssqs:
    'aws --endpoint-url http://localstack:4566 --region us-east-1 sqs receive-message --queue-url http://localstack:4566/000000000000/%s --max-number-of-messages %d --visibility-timeout 0'
};

// El reset por script existe con las mismas condiciones con las que docker.js lo
// genera: una BD con cliResetCmd, o una caché que vaciar. Sin script (H2 en
// memoria) el aislamiento entre clases de flujo lo da @DirtiesContext.
function hasResetScript({ layersPresent, stack }) {
  const db = layersPresent.persistence && stack.database ? DATABASES[stack.database] : null;
  return Boolean(db?.cliResetCmd || stack.cache);
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

function eventReadCmd(model) {
  if (!model.layersPresent.messaging || !model.stack.broker) return null;
  return EVENT_READ_CMD[model.stack.broker] ?? null;
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
    }
  ];
}

// ─── AbstractFlowIT ──────────────────────────────────────────────────────────

function abstractImports(model) {
  const security = model.layersPresent.security;
  const oidc = security && tokenProtocol(model);
  const devtools = Boolean(eventReadCmd(model));
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
  if (devtools) imports.push('java.nio.charset.StandardCharsets');
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
  if (!reset) imports.push('org.springframework.test.annotation.DirtiesContext');
  return imports;
}

function abstractBody(model) {
  const { layersPresent } = model;
  const security = layersPresent.security;
  const dirties = hasResetScript(model)
    ? ''
    : '// Sin script de reset (BD en memoria): el aislamiento entre clases de flujo lo da\n' +
      '// recrear el contexto —y con él el esquema— antes de cada clase.\n' +
      '@DirtiesContext(classMode = DirtiesContext.ClassMode.BEFORE_CLASS)\n';

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
  if (!hasResetScript(model)) {
    return `
    /**
     * Sin script de reset: la BD es en memoria y el aislamiento lo da
     * \`@DirtiesContext\` a nivel de clase. Se conserva el método para que toda clase
     * de flujo llame a lo mismo desde su \`@BeforeAll\`.
     */
    protected static void resetState() {
        // No-op: el contexto se recrea antes de cada clase de flujo.
    }
`;
  }
  return `
    /**
     * Deja el estado como recién arrancado. Se invoca desde el \`@BeforeAll\` de cada
     * clase de flujo: el reset es <b>por flujo</b>, nunca entre escenarios — dentro
     * de un flujo, un escenario usa lo que dejó el anterior.
     */
    protected static void resetState() {
        try {
            Process process = new ProcessBuilder(bashExecutable(), "infra/reset-db.sh").inheritIO().start();
            int exit = process.waitFor();
            if (exit != 0) {
                throw new IllegalStateException("infra/reset-db.sh falló (código " + exit + "). ¿Está la infraestructura arriba?");
            }
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
  const template = eventReadCmd(model);
  if (!template) return '';
  const broker = BROKERS[model.stack.broker];
  return `
    /**
     * Últimos mensajes publicados en un destino, leídos del broker <b>real</b> del
     * compose (${broker.label}) vía el contenedor devtools. Nunca un broker embebido:
     * lo que se valida es la infraestructura levantada.
     */
    protected static String publishedMessages(String destination, int count) {
        return devtools(String.format("${template}", destination, count));
    }

    /** Ejecuta un comando dentro del contenedor devtools y devuelve su salida. */
    protected static String devtools(String command) {
        try {
            ProcessBuilder builder = new ProcessBuilder(containerRuntime(), "exec", "${model.service.name}-devtools", "sh", "-c", command);
            builder.redirectErrorStream(true);
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            process.waitFor();
            return output;
        } catch (IOException e) {
            throw new IllegalStateException("No se pudo hablar con devtools: " + command, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrumpido hablando con devtools", e);
        }
    }

    private static String containerRuntime() {
        String configured = System.getenv("CONTAINER_RUNTIME");
        return configured == null || configured.isBlank() ? "docker" : configured;
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

// ─── FailureCapture ──────────────────────────────────────────────────────────

function failureCaptureImports() {
  return [
    'java.io.IOException',
    'java.io.UncheckedIOException',
    'java.nio.file.Files',
    'java.nio.file.Path',
    'java.util.LinkedHashMap',
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
        write(scenario, report);
        LAST.remove();
    }

    @Override
    public void testSuccessful(ExtensionContext context) {
        LAST.remove();
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
