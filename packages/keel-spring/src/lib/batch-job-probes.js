// Las sondas de los LOTES ASÍNCRONOS (DSL 2.30, fase B) para keel-spring: los casos BJ-* de keel-core/gen/batch.js, con
// los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go, sobre los MISMOS diseños (BATCH_JOB_DESIGNS de
// keel-core/test/helpers/batch-designs.js). scripts/batch-check.js escribe dentro del proyecto generado el handler de la
// sonda (el de batch-probes.js, con su gancho AFTER_EFFECT) y esta clase JUnit, que no forman parte de él.
//
// Las peticiones van por MockMvc SIN la cadena de seguridad, con el dueño puesto a mano en el SecurityContext (es lo que
// lee el actor de autoría); el temporizador de cada trabajo se dispara llamando a su TimerHandler con el cronómetro
// apagado, así que la sonda decide cuándo corre cada chunk. La caída de una réplica a mitad de chunk (BJ-4) es un almacén
// envuelto que lanza un Error al escribir un resultado; la réplica que le quita el trabajo (BJ-5) es el gancho del
// handler, que mueve el cursor en OTRA transacción tras el efecto.

import { BATCH_JOB_CASES } from '@keel-system/keel-core/gen/batch';
import { PACKAGE_LEAF, batchOperations, body, item } from './batch-probes.js';

/** La clase JUnit de los casos BJ-*. */
export const JOB_CLASS_NAME = 'BatchJobCheckTest';

/** El tamaño del chunk con el que corre la sonda: pequeño, para que un trabajo de cinco elementos dé tres disparos. */
export const PROBE_CHUNK_SIZE = 2;

/** La operación asíncrona del modelo, o undefined. */
export const asyncOperation = (model) => batchOperations(model).find((operation) => operation.batch.execution === 'async');

/** Los casos de un lote ASÍNCRONO que ejecuta este diseño: todos, si declara uno. */
export function jobCasesOf(model) {
  return asyncOperation(model) ? BATCH_JOB_CASES.map((entry) => entry.id) : [];
}

/** La clase JUnit de los casos BJ-*. */
export function batchJobTestClass(model, { packages, document, engine, properties, doubles }) {
  const operation = asyncOperation(model);
  const at = JSON.stringify(`${model.api.routeBase}${operation.route.path}`);
  const kind = JSON.stringify(`batch:${operation.name}`);
  const jobClass = `${operation.name[0].toUpperCase()}${operation.name.slice(1)}BatchJob`;
  const store = document ? 'ProductMongoRepository' : 'ProductJpaRepository';
  const mysql = engine === 'mysql';
  const skus = (prefix, count) => Array.from({ length: count }, (_, n) => item(`${prefix}-000${n}`));
  const imports = new Set([
    'java.lang.reflect.InvocationTargetException',
    'java.lang.reflect.Proxy',
    'java.time.Instant',
    'java.time.temporal.ChronoUnit',
    'java.util.List',
    'java.util.UUID',
    'java.util.stream.Collectors',
    'java.util.stream.IntStream',
    'org.junit.jupiter.api.AfterEach',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.http.MediaType',
    'org.springframework.security.core.context.SecurityContextHolder',
    'org.springframework.security.oauth2.jwt.Jwt',
    'org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken',
    'org.springframework.test.context.ActiveProfiles',
    'org.springframework.test.web.servlet.MockMvc',
    'org.springframework.test.web.servlet.MvcResult',
    'org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder',
    'org.springframework.test.web.servlet.request.MockMvcRequestBuilders',
    'org.springframework.test.web.servlet.setup.MockMvcBuilders',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.TransactionDefinition',
    'org.springframework.transaction.support.TransactionTemplate',
    'org.springframework.web.context.WebApplicationContext',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper',
    `${packages.port}.ProductRepository`,
    `${packages.adapters}.${store}`,
    `${packages.handler}.${operation.handlerClass}`,
    `${packages.batch}.BatchJobRunner`,
    `${packages.batch}.BatchRunner`,
    `${packages.batch}.${jobClass}`,
    `${packages.batchStore}.BatchJobPurge`,
    `${packages.batchStore}.BatchJobStore`,
    `${packages.timer}.ClaimedTimer`,
    `${packages.timer}.TimerOutcome`,
    `${packages.timer}.TimerStore`,
    `${packages.mediator}.UseCaseMediator`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertNotEquals',
    'static org.junit.jupiter.api.Assertions.assertThrows',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const storageImports = document
    ? ['org.bson.Document', 'org.springframework.data.mongodb.core.MongoTemplate', 'org.springframework.data.mongodb.core.query.Criteria', 'org.springframework.data.mongodb.core.query.Query', 'org.springframework.data.mongodb.core.query.Update', 'java.util.Date']
    : ['javax.sql.DataSource', 'org.springframework.jdbc.core.simple.JdbcClient', 'java.time.ZoneOffset', ...(mysql ? ['java.nio.ByteBuffer', 'java.time.LocalDateTime'] : [])];
  for (const name of storageImports) imports.add(name);

  const fields = [
    '    @Autowired\n    private WebApplicationContext context;',
    '    @Autowired\n    private ObjectMapper mapper;',
    '    @Autowired\n    private ProductRepository products;',
    `    @Autowired\n    private ${store} productStore;`,
    `    @Autowired\n    private ${jobClass} job;`,
    '    @Autowired\n    private BatchJobStore jobs;',
    '    @Autowired\n    private BatchJobPurge purge;',
    '    @Autowired\n    private BatchRunner batchRunner;',
    '    @Autowired\n    private TimerStore timers;',
    '    @Autowired\n    private UseCaseMediator mediator;',
    '    @Autowired\n    private PlatformTransactionManager transactionManager;',
    document ? '    @Autowired\n    private MongoTemplate mongo;' : '    @Autowired\n    private DataSource dataSource;',
    '    private MockMvc mvc;'
  ];
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const port of doubles) {
    imports.add(port.fqn);
    fields.push(`    @MockitoBean\n    private ${port.type} ${port.type[0].toLowerCase()}${port.type.slice(1)};`);
  }

  // Lo que la sonda lee y retoca de las tablas, en cada modelo: contar, envejecer, mover el cursor y vaciar.
  const storage = document ? mongoStorage(kind) : jdbcStorage(kind, mysql);

  const tests = [
    `    @Test
    void bj1_altaResponde202SinProcesar() throws Exception {
        Answer answer = post(${body(...skus('JAA', 2))}, null);
        assertEquals(202, answer.status(), "BJ-1: el alta responde 202: " + answer.json());
        UUID id = UUID.fromString(answer.json().get("id").asString());
        assertTrue(answer.location() != null && answer.location().endsWith(${at} + "/jobs/" + id), "BJ-1: Location del trabajo: " + answer.location());
        assertEquals("queued", answer.json().get("status").asString(), "BJ-1");
        assertEquals(2, answer.json().get("summary").get("total").asInt(), "BJ-1");
        assertTrue(answer.json().get("finishedAt").isNull(), "BJ-1: finishedAt null mientras no termina");
        assertEquals(1L, armed(id), "BJ-1: el temporizador del trabajo se armó con él");
        assertFalse(products.findBySku("JAA-0000").isPresent(), "BJ-1: el alta no procesa ningún elemento");
    }`,
    `    @Test
    void bj2_porChunksHastaCompleted() throws Exception {
        UUID id = submit(${body(...skus('JBB', 5))});
        assertFalse(fire(id).done(), "BJ-2: el primer chunk deja trabajo");
        assertEquals(${PROBE_CHUNK_SIZE}, cursor(id), "BJ-2: un chunk de ${PROBE_CHUNK_SIZE}");
        assertFalse(fire(id).done(), "BJ-2: el segundo también");
        assertTrue(fire(id).done(), "BJ-2: el tercero termina");
        JsonNode status = get(${at} + "/jobs/" + id).json();
        assertEquals("completed", status.get("status").asString(), "BJ-2: " + status);
        assertSummary(status, 5, 5, 0, 0, "BJ-2");
        assertFalse(status.get("finishedAt").isNull(), "BJ-2: finishedAt");
        JsonNode page = get(${at} + "/jobs/" + id + "/results?page=1&size=2").json();
        assertEquals(5, page.get("totalElements").asInt(), "BJ-2: los resultados, paginados: " + page);
        assertEquals(List.of(2, 3), List.of(page.get("items").get(0).get("index").asInt(), page.get("items").get(1).get("index").asInt()), "BJ-2: en orden de índice");
        assertTrue(page.get("items").get(0).get("result").has("productId"), "BJ-2: el result de batch.output");
        assertTrue(products.findBySku("JBB-0004").isPresent(), "BJ-2");
    }`,
    `    @Test
    void bj3_itemErrorsYFalloNoDeclarado() throws Exception {
        run(submit(${body(item('JCC-0009'))}));
        UUID id = submit(${body(item('JCC-0001'), item('JCC-0009'), item('mal'), item('JCC-0003'), item('JCC-0004', 'BOOM'), item('JCC-0005'))});
        run(id);
        JsonNode status = get(${at} + "/jobs/" + id).json();
        assertEquals("aborted", status.get("status").asString(), "BJ-3: un fallo no declarado detiene el trabajo: " + status);
        assertSummary(status, 6, 2, 3, 1, "BJ-3");
        JsonNode page = get(${at} + "/jobs/" + id + "/results?size=50").json();
        assertEquals(5, page.get("totalElements").asInt(), "BJ-3: los notAttempted no se escriben fila a fila");
        assertResult(page, 1, "failed", "SKU_ALREADY_EXISTS", "BJ-3");
        assertResult(page, 2, "failed", "VALIDATION_ERROR", "BJ-3");
        assertResult(page, 3, "succeeded", null, "BJ-3: lo que sigue a un itemError se procesa");
        assertResult(page, 4, "failed", "BATCH_ABORTED", "BJ-3");
        assertFalse(products.findBySku("JCC-0005").isPresent(), "BJ-3: lo que sigue al que detiene el trabajo no se procesa");
    }`,
    `    @Test
    void bj4_reanudaDesdeElCursorTrasCaer() throws Exception {
        UUID id = submit(${body(...skus('JDD', 5))});
        assertFalse(fire(id).done(), "BJ-4: el primer chunk");
        // La réplica cae al escribir el resultado del elemento 3, a mitad del segundo chunk: el 2 ya está confirmado.
        ${jobClass} crashing = new ${jobClass}(new BatchJobRunner(crashingAt(3), timers, batchRunner, mapper, transactionManager, ${PROBE_CHUNK_SIZE}), mediator);
        assertThrows(ReplicaCrash.class, () -> crashing.handle(timer(id), Instant.now()), "BJ-4: la sonda simula la caída");
        as("alice");
        assertEquals(3, cursor(id), "BJ-4: lo confirmado antes de caer queda");
        run(id);
        JsonNode status = get(${at} + "/jobs/" + id).json();
        assertEquals("completed", status.get("status").asString(), "BJ-4: otra réplica lo termina desde el cursor: " + status);
        assertSummary(status, 5, 5, 0, 0, "BJ-4: ningún elemento se repite ni se pierde");
        assertEquals(5L, resultCount(id), "BJ-4: un resultado por elemento");
        assertTrue(products.findBySku("JDD-0003").isPresent(), "BJ-4");
    }`,
    `    @Test
    void bj5_laVallaRevierteAlQuePierdeElTrabajo() throws Exception {
        UUID id = submit(${body(item('JEE-0001'))});
        TransactionTemplate other = new TransactionTemplate(transactionManager);
        other.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        ${operation.handlerClass}.AFTER_EFFECT = () -> other.executeWithoutResult(status -> bumpCursor(id));
        try {
            fire(id);
        } finally {
            ${operation.handlerClass}.AFTER_EFFECT = () -> {
            };
        }
        assertFalse(products.findBySku("JEE-0001").isPresent(), "BJ-5: el elemento del que perdió el trabajo revierte con su efecto");
        assertEquals(0L, resultCount(id), "BJ-5: y sin resultado");
        assertEquals(1, cursor(id), "BJ-5: el cursor es el de quien se lo llevó");
    }`,
    `    @Test
    void bj6_soloLoLeeQuienLoCreo() throws Exception {
        UUID id = submit(${body(item('JFF-0001'))});
        as("bob");
        for (String route : List.of(${at} + "/jobs/" + id, ${at} + "/jobs/" + id + "/results")) {
            Answer answer = get(route);
            assertEquals(404, answer.status(), "BJ-6: un trabajo ajeno es un 404: " + route);
            assertEquals("BATCH_JOB_NOT_FOUND", answer.json().get("code").asString(), "BJ-6");
        }
        as("alice");
        assertEquals(404, get(${at} + "/jobs/" + UUID.randomUUID()).status(), "BJ-6: uno inexistente, lo mismo");
        assertEquals(200, get(${at} + "/jobs/" + id).status(), "BJ-6: su dueño sí lo lee");
        assertEquals(200, get(${at} + "/jobs/" + id + "/results").status(), "BJ-6: y sus resultados");
    }`,
    `    @Test
    void bj7_laClaveDelLote() throws Exception {
        String first = ${body(item('JGG-0001'))};
        Answer created = post(first, "clave-1");
        assertEquals(202, created.status(), "BJ-7: " + created.json());
        UUID id = UUID.fromString(created.json().get("id").asString());
        run(id);
        Answer repeated = post(first, "clave-1");
        assertEquals(202, repeated.status(), "BJ-7: la repetición responde el mismo 202");
        assertEquals(created.location(), repeated.location(), "BJ-7: con el mismo Location");
        assertEquals("completed", repeated.json().get("status").asString(), "BJ-7: y el trabajo en el estado en que esté");
        Answer reused = post(${body(item('JGG-0002'))}, "clave-1");
        assertEquals(409, reused.status(), "BJ-7: la misma clave con otro contenido");
        assertEquals("IDEMPOTENCY_KEY_REUSED", reused.json().get("code").asString(), "BJ-7");
        as("bob");
        assertNotEquals(id.toString(), post(first, "clave-1").json().get("id").asString(), "BJ-7: la clave es por dueño");
        as("alice");
        setTime(id, "key_expires_at", Instant.now().minus(1, ChronoUnit.MINUTES));
        Answer fresh = post(${body(item('JGG-0002'))}, "clave-1");
        assertEquals(202, fresh.status(), "BJ-7: pasada su ventana, la clave se libera: " + fresh.json());
        assertNotEquals(id.toString(), fresh.json().get("id").asString(), "BJ-7: y es un trabajo nuevo");
    }`,
    `    @Test
    void bj8_laPurgaSeLlevaLoTerminadoViejo() throws Exception {
        UUID old = submit(${body(item('JHH-0001'))});
        run(old);
        UUID recent = submit(${body(item('JHH-0002'))});
        run(recent);
        UUID running = submit(${body(item('JHH-0003'))});
        setTime(old, "finished_at", Instant.now().minus(8, ChronoUnit.DAYS));
        setTime(running, "created_at", Instant.now().minus(30, ChronoUnit.DAYS));
        purge.purge();
        assertTrue(jobs.job(old).isEmpty(), "BJ-8: el terminado hace más de la retención se va");
        assertEquals(0L, resultCount(old), "BJ-8: con sus resultados");
        assertTrue(jobs.job(recent).isPresent(), "BJ-8: el terminado reciente se queda");
        assertTrue(jobs.job(running).isPresent(), "BJ-8: uno en marcha no se purga nunca");
    }`,
    `    @Test
    void bj9_elSobreEsUn400SinTrabajo() throws Exception {
        long before = jobCount();
        assertEquals(400, post("{}", null).status(), "BJ-9: el campo que se recorre, ausente");
        assertEquals(400, post(many(${operation.batch.maxItems + 1}), null).status(), "BJ-9: más elementos que maxItems");
        assertEquals(400, post("{\\"items\\":", null).status(), "BJ-9: un cuerpo que no se lee");
        assertEquals(before, jobCount(), "BJ-9: ningún trabajo");
    }`
  ];

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * Los lotes asíncronos (DSL 2.30, fase B) contra lo que emitió build y el motor real de infra/: los casos BJ-* de keel-core.
 * Lo escribe scripts/batch-check.js desde src/lib/batch-job-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', `"batch.chunk-size=${PROBE_CHUNK_SIZE}"`, ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${JOB_CLASS_NAME} {

${fields.join('\n\n')}

    /** La caída de una réplica: un Error, que ninguna rama del procesador captura. */
    private static final class ReplicaCrash extends Error {
    }

    @BeforeEach
    void vacia() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
        productStore.deleteAll();
        wipeJobs();
        as("alice");
    }

    @AfterEach
    void sinDueno() {
        SecurityContextHolder.clearContext();
    }

    private record Answer(int status, String location, JsonNode json) {
    }

    /** El llamante: su sujeto es el dueño de lo que crea (el actor de autoría). */
    private static void as(String subject) {
        SecurityContextHolder.getContext().setAuthentication(
                new JwtAuthenticationToken(Jwt.withTokenValue("sonda").header("alg", "none").subject(subject).build()));
    }

    private Answer post(String content, String key) throws Exception {
        MockHttpServletRequestBuilder request = MockMvcRequestBuilders.post(${at}).contentType(MediaType.APPLICATION_JSON).content(content);
        if (key != null) {
            request = request.header("Idempotency-Key", key);
        }
        return answer(mvc.perform(request).andReturn());
    }

    private Answer get(String url) throws Exception {
        return answer(mvc.perform(MockMvcRequestBuilders.get(url)).andReturn());
    }

    private Answer answer(MvcResult result) throws Exception {
        String text = result.getResponse().getContentAsString();
        return new Answer(result.getResponse().getStatus(), result.getResponse().getHeader("Location"),
                text.isBlank() ? mapper.createObjectNode() : mapper.readTree(text));
    }

    private UUID submit(String content) throws Exception {
        Answer answer = post(content, null);
        assertEquals(202, answer.status(), "el alta: " + answer.json());
        return UUID.fromString(answer.json().get("id").asString());
    }

    /** El temporizador del trabajo, como lo reclamaría el cronómetro. */
    private static ClaimedTimer timer(UUID id) {
        return new ClaimedTimer(id.toString(), ${kind}, id, Instant.now(), 0);
    }

    /** Un disparo del temporizador: un chunk. */
    private TimerOutcome fire(UUID id) {
        return job.handle(timer(id), Instant.now());
    }

    /** Los disparos que hagan falta hasta que el trabajo termine. */
    private void run(UUID id) {
        for (int shot = 0; shot < 100; shot++) {
            if (fire(id).done()) {
                return;
            }
        }
        throw new AssertionError("el trabajo no termina");
    }

    /** El almacén de una réplica que cae al escribir el resultado del elemento {@code index}. */
    private BatchJobStore crashingAt(int index) {
        return (BatchJobStore) Proxy.newProxyInstance(BatchJobStore.class.getClassLoader(), new Class<?>[] {BatchJobStore.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("insertResult") && (int) args[1] == index) {
                        throw new ReplicaCrash();
                    }
                    try {
                        return method.invoke(jobs, args);
                    } catch (InvocationTargetException ex) {
                        throw ex.getCause();
                    }
                });
    }

    private static void assertSummary(JsonNode json, int total, int succeeded, int failed, int notAttempted, String id) {
        JsonNode summary = json.get("summary");
        assertEquals(List.of(total, succeeded, failed, notAttempted),
                List.of(summary.get("total").asInt(), summary.get("succeeded").asInt(), summary.get("failed").asInt(), summary.get("notAttempted").asInt()),
                id + ": el resumen (total, succeeded, failed, notAttempted) de " + json);
    }

    private static void assertResult(JsonNode page, int index, String status, String code, String id) {
        for (JsonNode element : page.get("items")) {
            if (element.get("index").asInt() == index) {
                assertEquals(status, element.get("status").asString(), id + ": " + element);
                if (code != null) {
                    assertEquals(code, element.get("error").asString(), id + ": " + element);
                }
                return;
            }
        }
        throw new AssertionError(id + ": no hay resultado del elemento " + index + " en " + page);
    }

    private static String many(int count) {
        return "{\\"items\\":[" + IntStream.range(0, count).mapToObj(index -> "{}").collect(Collectors.joining(",")) + "]}";
    }

${storage}

${tests.join('\n\n')}
}
`;
}

function mongoStorage(kind) {
  return `    private long jobCount() {
        return mongo.count(new Query(), "batch_job");
    }

    private long armed(UUID id) {
        return mongo.count(new Query(Criteria.where("kind").is(${kind}).and("entity_id").is(id.toString())), "keel_timer");
    }

    private void setTime(UUID id, String column, Instant value) {
        mongo.updateFirst(new Query(Criteria.where("_id").is(id.toString())), new Update().set(column, Date.from(value)), "batch_job");
    }

    private int cursor(UUID id) {
        return mongo.findOne(new Query(Criteria.where("_id").is(id.toString())), Document.class, "batch_job").getInteger("next_index");
    }

    private long resultCount(UUID id) {
        return mongo.count(new Query(Criteria.where("job_id").is(id.toString())), "batch_item_result");
    }

    /** Otra réplica se lleva el elemento: mueve el cursor en SU transacción. */
    private void bumpCursor(UUID id) {
        mongo.updateFirst(new Query(Criteria.where("_id").is(id.toString())), new Update().inc("next_index", 1), "batch_job");
    }

    private void wipeJobs() {
        mongo.remove(new Query(), "batch_item_result");
        mongo.remove(new Query(), "batch_job");
        mongo.remove(new Query(Criteria.where("kind").regex("^batch:")), "keel_timer");
    }`;
}

function jdbcStorage(kind, mysql) {
  return `    private JdbcClient jdbc() {
        return JdbcClient.create(dataSource);
    }

    private static Object uuid(UUID value) {
        ${mysql ? 'return ByteBuffer.allocate(16).putLong(value.getMostSignificantBits()).putLong(value.getLeastSignificantBits()).array();' : 'return value;'}
    }

    private static Object time(Instant value) {
        ${mysql ? 'return LocalDateTime.ofInstant(value, ZoneOffset.UTC);' : 'return value.atOffset(ZoneOffset.UTC);'}
    }

    private long jobCount() {
        return jdbc().sql("SELECT count(*) FROM batch_job").query(Long.class).single();
    }

    private long armed(UUID id) {
        return jdbc().sql("SELECT count(*) FROM keel_timer WHERE kind = :kind AND entity_id = :id")
                .param("kind", ${kind}).param("id", uuid(id)).query(Long.class).single();
    }

    private void setTime(UUID id, String column, Instant value) {
        jdbc().sql("UPDATE batch_job SET " + column + " = :at WHERE id = :id").param("at", time(value)).param("id", uuid(id)).update();
    }

    private int cursor(UUID id) {
        return jdbc().sql("SELECT next_index FROM batch_job WHERE id = :id").param("id", uuid(id)).query(Integer.class).single();
    }

    private long resultCount(UUID id) {
        return jdbc().sql("SELECT count(*) FROM batch_item_result WHERE job_id = :id").param("id", uuid(id)).query(Long.class).single();
    }

    /** Otra réplica se lleva el elemento: mueve el cursor en SU transacción. */
    private void bumpCursor(UUID id) {
        jdbc().sql("UPDATE batch_job SET next_index = next_index + 1 WHERE id = :id").param("id", uuid(id)).update();
    }

    private void wipeJobs() {
        jdbc().sql("DELETE FROM batch_item_result").update();
        jdbc().sql("DELETE FROM batch_job").update();
        jdbc().sql("DELETE FROM keel_timer WHERE kind LIKE 'batch:%'").update();
    }`;
}
