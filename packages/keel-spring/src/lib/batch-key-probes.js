// Las sondas del lote SÍNCRONO con clave (DSL 2.30, D15, incremento 10b) para keel-spring: los casos BK-* de
// keel-core/gen/batch.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go, sobre los MISMOS diseños
// (BATCH_KEY_DESIGNS de keel-core/test/helpers/batch-designs.js). scripts/batch-check.js escribe dentro del proyecto
// generado el handler de la sonda (el de batch-probes.js, con su gancho AFTER_EFFECT) y esta clase JUnit, que no forman
// parte de él.
//
// Las peticiones van por MockMvc con el contexto entero contra el motor real. La petición que muere a mitad de lote (BK-3,
// BK-4) es el gancho del handler, que lanza un Error tras el efecto del segundo elemento: su transacción revierte, el
// primero queda confirmado y el trabajo se queda sin terminar. Que lleve muerto más que `batch.sync-stale-ms` se simula
// envejeciendo su `updated_at`.

import { BATCH_KEY_CASES } from '@keel-system/keel-core/gen/batch';
import { BATCH_SYNC_STALE } from '@keel-system/keel-core/gen/batch-store';
import { PACKAGE_LEAF, batchOperations, body, item } from './batch-probes.js';

/** La clase JUnit de los casos BK-*. */
export const KEY_CLASS_NAME = 'BatchKeyCheckTest';

/** Las operaciones síncronas con clave del modelo. */
const keyedOperations = (model) => batchOperations(model).filter((operation) => operation.batch.execution !== 'async' && operation.batch.idempotency);

/** Los casos de un lote síncrono con clave que ejecuta este diseño: BK-1 a BK-4 con un per-item, BK-5 con un todo o nada. */
export function keyCasesOf(model) {
  const atomicities = new Set(keyedOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BK-1', 'BK-2', 'BK-3', 'BK-4');
  if (atomicities.has('all-or-nothing')) ids.push('BK-5');
  return BATCH_KEY_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

/** La clase JUnit de los casos BK-*. */
export function batchKeyTestClass(model, { packages, document, engine, properties, doubles }) {
  const cases = new Set(keyCasesOf(model));
  const perItem = keyedOperations(model).find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = keyedOperations(model).find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const url = (operation) => JSON.stringify(`${model.api.routeBase}${operation.route.path}`);
  const handler = (perItem ?? atomic).handlerClass;
  const store = document ? 'ProductMongoRepository' : 'ProductJpaRepository';
  const mysql = engine === 'mysql';
  const imports = new Set([
    'java.time.Instant',
    'java.time.temporal.ChronoUnit',
    'java.util.List',
    'java.util.concurrent.atomic.AtomicInteger',
    'org.junit.jupiter.api.AfterEach',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.http.MediaType',
    'org.springframework.test.context.ActiveProfiles',
    'org.springframework.test.web.servlet.MockMvc',
    'org.springframework.test.web.servlet.MvcResult',
    'org.springframework.test.web.servlet.request.MockMvcRequestBuilders',
    'org.springframework.test.web.servlet.setup.MockMvcBuilders',
    'org.springframework.web.context.WebApplicationContext',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper',
    `${packages.port}.ProductRepository`,
    `${packages.adapters}.${store}`,
    `${packages.handler}.${handler}`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const storageImports = document
    ? ['org.springframework.data.mongodb.core.MongoTemplate', 'org.springframework.data.mongodb.core.query.Criteria', 'org.springframework.data.mongodb.core.query.Query', 'org.springframework.data.mongodb.core.query.Update', 'java.util.Date']
    : ['javax.sql.DataSource', 'org.springframework.jdbc.core.simple.JdbcClient', 'java.time.ZoneOffset', ...(mysql ? ['java.time.LocalDateTime'] : [])];
  for (const name of storageImports) imports.add(name);

  const fields = [
    '    @Autowired\n    private WebApplicationContext context;',
    '    @Autowired\n    private ObjectMapper mapper;',
    '    @Autowired\n    private ProductRepository products;',
    `    @Autowired\n    private ${store} productStore;`,
    document ? '    @Autowired\n    private MongoTemplate mongo;' : '    @Autowired\n    private DataSource dataSource;',
    '    private MockMvc mvc;'
  ];
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const port of doubles) {
    imports.add(port.fqn);
    fields.push(`    @MockitoBean\n    private ${port.type} ${port.type[0].toLowerCase()}${port.type.slice(1)};`);
  }

  const stale = BATCH_SYNC_STALE.default;
  const tests = [];
  if (perItem) {
    const at = url(perItem);
    if (cases.has('BK-1')) {
      tests.push(`    @Test
    void bk1_laRepeticionDevuelveElMismo207() throws Exception {
        String content = ${body(item('KAA-0001'), item('KAA-0002'))};
        Answer first = post(${at}, content, "clave-1");
        assertEquals(207, first.status(), "BK-1: " + first.json());
        assertEquals(2, first.json().get("summary").get("succeeded").asInt(), "BK-1: " + first.json());
        long results = resultCount();
        Answer repeated = post(${at}, content, "clave-1");
        assertEquals(207, repeated.status(), "BK-1");
        assertEquals(first.json(), repeated.json(), "BK-1: la repetición responde el MISMO 207");
        assertEquals(results, resultCount(), "BK-1: sin resultados nuevos");
        assertEquals(1L, jobCount(), "BK-1: sin trabajo nuevo");
    }`);
    }
    if (cases.has('BK-2')) {
      tests.push(`    @Test
    void bk2_otraFirmaEsLaClaveReutilizada() throws Exception {
        assertEquals(207, post(${at}, ${body(item('KBB-0001'))}, "clave-2").status(), "BK-2");
        Answer reused = post(${at}, ${body(item('KBB-0002'))}, "clave-2");
        assertEquals(409, reused.status(), "BK-2: la misma clave con otro cuerpo: " + reused.json());
        assertEquals("IDEMPOTENCY_KEY_REUSED", reused.json().get("code").asString(), "BK-2");
        assertFalse(products.findBySku("KBB-0002").isPresent(), "BK-2: sin procesar nada");
        age("clave-2", "key_expires_at", 60);
        Answer fresh = post(${at}, ${body(item('KBB-0002'))}, "clave-2");
        assertEquals(207, fresh.status(), "BK-2: pasada su ventana, un lote nuevo: " + fresh.json());
        assertTrue(products.findBySku("KBB-0002").isPresent(), "BK-2");
        assertEquals(2L, jobCount(), "BK-2: y su trabajo");
    }`);
    }
    if (cases.has('BK-3')) {
      tests.push(`    @Test
    void bk3_enMarchaEs409() throws Exception {
        String content = ${body(item('KCC-0001'), item('KCC-0002'), item('KCC-0003'))};
        dies(${at}, content, "clave-3");
        Answer running = post(${at}, content, "clave-3");
        assertEquals(409, running.status(), "BK-3: el primero sigue en marcha: " + running.json());
        assertEquals("IDEMPOTENCY_KEY_IN_PROGRESS", running.json().get("code").asString(), "BK-3");
        assertFalse(products.findBySku("KCC-0002").isPresent(), "BK-3: sin procesar nada");
        assertEquals(1L, resultCount(), "BK-3: solo el resultado del primero");
    }`);
    }
    if (cases.has('BK-4')) {
      tests.push(`    @Test
    void bk4_reanudaDesdeElCursor() throws Exception {
        String content = ${body(item('KDD-0001'), item('KDD-0002'), item('KDD-0003'))};
        dies(${at}, content, "clave-4");
        assertTrue(products.findBySku("KDD-0001").isPresent(), "BK-4: lo confirmado antes de morir queda");
        age("clave-4", "updated_at", ${Math.ceil(stale / 1000) * 2});
        Answer resumed = post(${at}, content, "clave-4");
        assertEquals(207, resumed.status(), "BK-4: la repetición de un lote muerto lo sigue: " + resumed.json());
        JsonNode summary = resumed.json().get("summary");
        assertEquals(List.of(3, 3, 0, 0), List.of(summary.get("total").asInt(), summary.get("succeeded").asInt(), summary.get("failed").asInt(),
                summary.get("notAttempted").asInt()), "BK-4: el 207 los cuenta todos, sin repetir ninguno: " + resumed.json());
        assertEquals(3L, resultCount(), "BK-4: un resultado por elemento");
        assertTrue(products.findBySku("KDD-0003").isPresent(), "BK-4");
    }`);
    }
  }
  if (atomic && cases.has('BK-5')) {
    const at = url(atomic);
    tests.push(`    @Test
    void bk5_todoONadaConClave() throws Exception {
        String good = ${body(item('KEE-0001'), item('KEE-0002'))};
        Answer first = post(${at}, good, "clave-5");
        assertEquals(${atomic.route.status}, first.status(), "BK-5: " + first.json());
        Answer repeated = post(${at}, good, "clave-5");
        assertEquals(${atomic.route.status}, repeated.status(), "BK-5: el lote confirmado se repite");
        assertEquals(first.json(), repeated.json(), "BK-5: con la misma respuesta");
        assertEquals(1L, jobCount(), "BK-5");
        String bad = ${body(item('KEE-0003'), item('KEE-0003'))};
        Answer failed = post(${at}, bad, "clave-6");
        assertEquals(409, failed.status(), "BK-5: " + failed.json());
        assertEquals("SKU_ALREADY_EXISTS", failed.json().get("code").asString(), "BK-5");
        assertEquals(1L, jobCount(), "BK-5: el que falló no deja trabajo");
        Answer again = post(${at}, bad, "clave-6");
        assertEquals("SKU_ALREADY_EXISTS", again.json().get("code").asString(), "BK-5: repetirlo lo vuelve a procesar: " + again.json());
        assertFalse(products.findBySku("KEE-0003").isPresent(), "BK-5: no queda nada confirmado");
    }`);
  }

  const storage = document
    ? `    private long jobCount() {
        return mongo.count(new Query(), "batch_job");
    }

    private long resultCount() {
        return mongo.count(new Query(), "batch_item_result");
    }

    /** Lleva {@code column} del trabajo de la clave {@code seconds} segundos atrás. */
    private void age(String key, String column, long seconds) {
        mongo.updateFirst(new Query(Criteria.where("idempotency_key").is(key)),
                new Update().set(column, Date.from(Instant.now().minus(seconds, ChronoUnit.SECONDS))), "batch_job");
    }

    private void wipeJobs() {
        mongo.remove(new Query(), "batch_item_result");
        mongo.remove(new Query(), "batch_job");
    }`
    : `    private JdbcClient jdbc() {
        return JdbcClient.create(dataSource);
    }

    private long jobCount() {
        return jdbc().sql("SELECT count(*) FROM batch_job").query(Long.class).single();
    }

    private long resultCount() {
        return jdbc().sql("SELECT count(*) FROM batch_item_result").query(Long.class).single();
    }

    /** Lleva {@code column} del trabajo de la clave {@code seconds} segundos atrás. */
    private void age(String key, String column, long seconds) {
        Instant at = Instant.now().minus(seconds, ChronoUnit.SECONDS);
        jdbc().sql("UPDATE batch_job SET " + column + " = :at WHERE idempotency_key = :key")
                .param("at", ${mysql ? 'LocalDateTime.ofInstant(at, ZoneOffset.UTC)' : 'at.atOffset(ZoneOffset.UTC)'}).param("key", key).update();
    }

    private void wipeJobs() {
        jdbc().sql("DELETE FROM batch_item_result").update();
        jdbc().sql("DELETE FROM batch_job").update();
    }`;

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * Los lotes síncronos con clave (DSL 2.30, D15) contra lo que emitió build y el motor real de infra/: los casos BK-* de
 * keel-core. Lo escribe scripts/batch-check.js desde src/lib/batch-key-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${KEY_CLASS_NAME} {

${fields.join('\n\n')}

    /** La muerte de la petición a mitad de lote: un Error, que ninguna rama del bucle captura. */
    private static final class RequestDeath extends Error {
    }

    @BeforeEach
    void vacia() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
        productStore.deleteAll();
        wipeJobs();
    }

    @AfterEach
    void sinGancho() {
        ${handler}.AFTER_EFFECT = () -> {
        };
    }

    private record Answer(int status, JsonNode json) {
    }

    private Answer post(String url, String content, String key) throws Exception {
        MvcResult result = mvc.perform(MockMvcRequestBuilders.post(url).contentType(MediaType.APPLICATION_JSON).content(content)
                .header("Idempotency-Key", key)).andReturn();
        String text = result.getResponse().getContentAsString();
        return new Answer(result.getResponse().getStatus(), text.isBlank() ? mapper.createObjectNode() : mapper.readTree(text));
    }

    /** La petición muere tras el efecto del SEGUNDO elemento: el primero queda confirmado y el trabajo, sin terminar. */
    private void dies(String url, String content, String key) {
        AtomicInteger effects = new AtomicInteger();
        ${handler}.AFTER_EFFECT = () -> {
            if (effects.incrementAndGet() == 2) {
                throw new RequestDeath();
            }
        };
        Answer answer = null;
        try {
            answer = post(url, content, key);
        } catch (Throwable death) {
            // La muerte que la sonda provoca, envuelta por el DispatcherServlet.
        } finally {
            ${handler}.AFTER_EFFECT = () -> {
            };
        }
        // Si la traduce un manejador de errores, es un 500: el trabajo se queda igual de muerto.
        assertTrue(answer == null || answer.status() == 500, "la sonda tenía que matar la petición: " + (answer == null ? "" : answer.json()));
        assertEquals(2, effects.get(), "la petición murió en el segundo elemento");
    }

${storage}

${tests.join('\n\n')}
}
`;
}
