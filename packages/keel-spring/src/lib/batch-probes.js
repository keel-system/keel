// Las sondas de los LOTES con resultado por elemento (DSL 2.30, modo `sync`) para keel-spring: los casos BA-* de
// keel-core/gen/batch.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go, sobre los MISMOS diseños
// (keel-core/test/helpers/batch-designs.js). scripts/batch-check.js escribe dos cosas dentro del proyecto generado, que
// no forman parte de él:
//
//   · el HANDLER de `importProducts`, en el lugar del stub: lo que escribiría el agente para UN elemento —el sku que ya
//     existe es SKU_ALREADY_EXISTS y un nombre «BOOM» es un fallo que ningún diseño declara—. Lo que se mide es lo que
//     build pone alrededor: el sobre, el bucle, la transacción por elemento, la validación y la respuesta;
//   · una clase JUnit que hace las peticiones por MockMvc con el contexto entero contra el motor real de infra/, y mira
//     la respuesta Y lo que quedó confirmado en la base.
//
// Los sujetos son todos product-catalog con un lote de altas, así que la sonda conoce `Product`.

import { BATCH_CASES } from '@keel-system/keel-core/gen/batch';

export const PACKAGE_LEAF = 'batchcheck';
export const CLASS_NAME = 'BatchCheckTest';

/** Lo que el nombre de un elemento pide al handler de la sonda: fallar con algo que el diseño no declara (BA-4). */
export const UNDECLARED_FAILURE_NAME = 'BOOM';

/** Las operaciones por lotes del modelo. */
export const batchOperations = (model) => model.services.flatMap((service) => service.operations).filter((operation) => operation.batch);

/**
 * Los casos que ejecuta este diseño. BA-8 (idempotencia del lote) y BA-9 (eventos por elemento) piden un lote con
 * `idempotency` y con eventos, y ningún sujeto los declara: se miden cuando una fixture los traiga (inc. 11).
 */
export function casesOf(model) {
  const atomicities = new Set(batchOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5');
  if (atomicities.has('all-or-nothing')) ids.push('BA-6');
  if (atomicities.size > 0) ids.push('BA-7');
  return BATCH_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

/** El handler de la sonda para `importProducts`: el sku que existe falla su elemento, «BOOM» detiene el lote. */
export function probeHandler(model, { packages }) {
  const operation = batchOperations(model)[0];
  const result = operation.batch.resultFields.length > 0;
  const returnType = result ? operation.responseDto.name : 'Void';
  return `package ${packages.handler};

import ${packages.annotations}.ApplicationComponent;
import ${packages.commands}.${operation.messageClass};
${result ? `import ${packages.dtos}.${returnType};\n` : ''}import ${packages.interfaces}.${result ? 'ReturningCommandHandler' : 'CommandHandler'};
import ${packages.aggregate}.Product;
import ${packages.enums}.ProductStatus;
import ${packages.errors}.SkuAlreadyExistsError;
import ${packages.identity}.Uuids;
import ${packages.port}.ProductRepository;
import ${packages.valueobject}.ProductDraft;

/** La sonda de batch-check: lo que escribiría el agente para UN elemento. */
@ApplicationComponent
public class ${operation.handlerClass} implements ${result ? `ReturningCommandHandler<${operation.messageClass}, ${returnType}>` : `CommandHandler<${operation.messageClass}>`} {

    private final ProductRepository productRepository;

    public ${operation.handlerClass}(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    @Override
    public ${result ? returnType : 'void'} handle(${operation.messageClass} command) {
        ProductDraft draft = command.item();
        if (${JSON.stringify(UNDECLARED_FAILURE_NAME)}.equals(draft.name())) {
            throw new IllegalStateException("sonda: un fallo que el diseño no declara");
        }
        if (productRepository.findBySku(draft.sku()).isPresent()) {
            throw new SkuAlreadyExistsError("Ya existe un producto con ese sku");
        }
        Product saved = productRepository.save(
                new Product(Uuids.v7(), draft.sku(), draft.name(), null, draft.price(), "sonda", ProductStatus.DRAFT, null));
        ${result ? 'return new ' + returnType + '(saved.getId());' : ''}
    }
}
`;
}

const item = (sku, name = 'Producto') => `{"sku":"${sku}","name":"${name}","price":{"amount":10.00,"currency":"EUR"}}`;
const body = (...items) => JSON.stringify(`{"items":[${items.join(',')}]}`);

/** La clase JUnit de los casos BA-*. */
export function batchTestClass(model, { packages, document, properties, doubles }) {
  const cases = new Set(casesOf(model));
  const perItem = batchOperations(model).find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = batchOperations(model).find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const url = (operation) => JSON.stringify(`${model.api.routeBase}${operation.route.path}`);
  const store = document ? 'ProductMongoRepository' : 'ProductJpaRepository';
  const imports = new Set([
    'java.util.List',
    'java.util.stream.Collectors',
    'java.util.stream.IntStream',
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
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const fields = [
    '    @Autowired\n    private WebApplicationContext context;',
    '    @Autowired\n    private ObjectMapper mapper;',
    '    @Autowired\n    private ProductRepository products;',
    `    @Autowired\n    private ${store} store;`,
    '    private MockMvc mvc;'
  ];
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const port of doubles) {
    imports.add(port.fqn);
    fields.push(`    @MockitoBean\n    private ${port.type} ${port.type[0].toLowerCase()}${port.type.slice(1)};`);
  }

  const tests = [];
  if (perItem) {
    const at = url(perItem);
    if (cases.has('BA-1')) {
      tests.push(`    @Test
    void ba1_todosBien_207ConCadaResultado() throws Exception {
        Answer answer = post(${at}, ${body(item('AAA-0001'), item('AAA-0002'), item('AAA-0003'))});
        assertEquals(207, answer.status(), "BA-1: un lote per-item responde 207 también si todo salió bien");
        assertSummary(answer.json(), 3, 3, 0, 0, "BA-1");
        for (int index = 0; index < 3; index++) {
            JsonNode element = answer.json().get("items").get(index);
            assertEquals(index, element.get("index").asInt(), "BA-1: en orden de índice");
            assertEquals("succeeded", element.get("status").asString(), "BA-1");
            assertTrue(element.get("result").has("productId"), "BA-1: el result del elemento lleva batch.output");
            assertStable(element, "BA-1");
        }
    }`);
    }
    if (cases.has('BA-2')) {
      tests.push(`    @Test
    void ba2_itemErrorFallaSoloSuElemento() throws Exception {
        post(${at}, ${body(item('BBB-0001'))});
        assertTrue(products.findBySku("BBB-0001").isPresent(), "BA-2: la siembra");
        Answer answer = post(${at}, ${body(item('BBB-0001'), item('BBB-0002'))});
        assertEquals(207, answer.status(), "BA-2");
        assertSummary(answer.json(), 2, 1, 1, 0, "BA-2");
        assertFailed(answer.json(), 0, "SKU_ALREADY_EXISTS", "BA-2");
        assertEquals("succeeded", status(answer.json(), 1), "BA-2: el siguiente sigue");
        assertTrue(products.findBySku("BBB-0002").isPresent(), "BA-2: el siguiente quedó confirmado");
    }`);
    }
    if (cases.has('BA-3')) {
      tests.push(`    @Test
    void ba3_elementoMalFormadoEsSuFailed() throws Exception {
        Answer answer = post(${at}, ${body(item('CCC-0001'), item('mal'), item('CCC-0003', 'x'.repeat(121)), 'null', item('CCC-0005'))});
        assertEquals(207, answer.status(), "BA-3: un elemento mal formado no es un 400 del lote");
        assertSummary(answer.json(), 5, 2, 3, 0, "BA-3");
        assertFailed(answer.json(), 1, "VALIDATION_ERROR", "BA-3: el formato del sku");
        assertFailed(answer.json(), 2, "VALIDATION_ERROR", "BA-3: la cota del nombre");
        assertFailed(answer.json(), 3, "VALIDATION_ERROR", "BA-3: un elemento null");
        assertTrue(products.findBySku("CCC-0005").isPresent(), "BA-3: el siguiente quedó confirmado");
    }`);
    }
    if (cases.has('BA-4')) {
      tests.push(`    @Test
    void ba4_errorNoDeclaradoDetieneElLote() throws Exception {
        Answer answer = post(${at}, ${body(item('DDD-0001'), item('DDD-0002', 'BOOM'), item('DDD-0003'))});
        assertEquals(207, answer.status(), "BA-4: detener el lote sigue siendo un 207");
        assertSummary(answer.json(), 3, 1, 1, 1, "BA-4");
        assertFailed(answer.json(), 1, "BATCH_ABORTED", "BA-4");
        assertEquals("notAttempted", status(answer.json(), 2), "BA-4: lo siguiente no se intenta");
        assertStable(answer.json().get("items").get(2), "BA-4");
        assertTrue(products.findBySku("DDD-0001").isPresent(), "BA-4: lo anterior queda confirmado");
        assertFalse(products.findBySku("DDD-0003").isPresent(), "BA-4: lo siguiente no se procesó");
    }`);
    }
    if (cases.has('BA-5')) {
      tests.push(`    @Test
    void ba5_mismaClaveEnElLoteFallaEnElSegundo() throws Exception {
        Answer answer = post(${at}, ${body(item('EEE-0001'), item('EEE-0001'))});
        assertEquals(207, answer.status(), "BA-5");
        assertEquals("succeeded", status(answer.json(), 0), "BA-5: el primero entra");
        assertFailed(answer.json(), 1, "SKU_ALREADY_EXISTS", "BA-5: el segundo choca con el primero, ya confirmado");
    }`);
    }
    if (cases.has('BA-7')) tests.push(envelopeTest(at, 'perItem'));
  }
  if (atomic) {
    const at = url(atomic);
    if (cases.has('BA-6')) {
      tests.push(`    @Test
    void ba6_allOrNothingRevierteEntero() throws Exception {
        Answer failed = post(${at}, ${body(item('FFF-0001'), item('FFF-0002'), item('FFF-0001'))});
        assertEquals(409, failed.status(), "BA-6: el error del elemento culpable");
        assertEquals("SKU_ALREADY_EXISTS", failed.json().get("code").asString(), "BA-6");
        assertEquals("items[2]", failed.json().get("details").get(0).asString(), "BA-6: la ruta del culpable en details");
        assertFalse(products.findBySku("FFF-0001").isPresent(), "BA-6: no queda nada confirmado");
        assertFalse(products.findBySku("FFF-0002").isPresent(), "BA-6: no queda nada confirmado");
        Answer invalid = post(${at}, ${body(item('FFF-0003'), item('mal'))});
        assertEquals(400, invalid.status(), "BA-6: un elemento mal formado es el 400 del culpable");
        assertEquals("items[1]", invalid.json().get("details").get(0).asString(), "BA-6");
        assertFalse(products.findBySku("FFF-0003").isPresent(), "BA-6");
        Answer good = post(${at}, ${body(item('FFF-0004'), item('FFF-0005'))});
        assertEquals(${atomic.route.status}, good.status(), "BA-6: sin fallos, el successStatus del endpoint");
        assertSummary(good.json(), 2, 2, 0, 0, "BA-6");
    }`);
    }
    if (cases.has('BA-7') && !perItem) tests.push(envelopeTest(at, 'atomic'));
  }

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * Los lotes (DSL 2.30) contra lo que emitió build y el motor real de infra/: los casos BA-* de keel-core. Lo escribe
 * scripts/batch-check.js desde src/lib/batch-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${CLASS_NAME} {

${fields.join('\n\n')}

    @BeforeEach
    void vacia() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
        store.deleteAll();
    }

    private record Answer(int status, JsonNode json) {
    }

    private Answer post(String url, String content) throws Exception {
        MvcResult result = mvc.perform(MockMvcRequestBuilders.post(url).contentType(MediaType.APPLICATION_JSON).content(content)).andReturn();
        String text = result.getResponse().getContentAsString();
        return new Answer(result.getResponse().getStatus(), text.isBlank() ? mapper.createObjectNode() : mapper.readTree(text));
    }

    private static String status(JsonNode json, int index) {
        return json.get("items").get(index).get("status").asString();
    }

    private static void assertSummary(JsonNode json, int total, int succeeded, int failed, int notAttempted, String id) {
        JsonNode summary = json.get("summary");
        assertEquals(List.of(total, succeeded, failed, notAttempted),
                List.of(summary.get("total").asInt(), summary.get("succeeded").asInt(), summary.get("failed").asInt(), summary.get("notAttempted").asInt()),
                id + ": el resumen (total, succeeded, failed, notAttempted) de " + json);
    }

    private static void assertFailed(JsonNode json, int index, String code, String id) {
        JsonNode element = json.get("items").get(index);
        assertEquals("failed", element.get("status").asString(), id + ": " + element);
        assertEquals(code, element.get("error").asString(), id + ": " + element);
        assertTrue(element.get("result").isNull(), id + ": un elemento que falla no lleva result");
        assertStable(element, id);
    }

    /** Las cinco claves siempre, también las nulas (wire-contract.md § Lotes). */
    private static void assertStable(JsonNode element, String id) {
        for (String key : List.of("index", "status", "result", "error", "message")) {
            assertTrue(element.has(key), id + ": el elemento no lleva '" + key + "': " + element);
        }
    }

    private static String many(int count) {
        return "{\\"items\\":[" + IntStream.range(0, count).mapToObj(index -> "{}").collect(Collectors.joining(",")) + "]}";
    }

${tests.join('\n\n')}
}
`;
}

/** BA-7: el sobre. El campo ausente y uno con más elementos que su maxItems son un 400 del lote, sin procesar nada. */
function envelopeTest(at, suffix) {
  return `    @Test
    void ba7_sobre_${suffix}() throws Exception {
        assertEquals(400, post(${at}, "{}").status(), "BA-7: el campo que se recorre, ausente");
        assertEquals(400, post(${at}, many(501)).status(), "BA-7: más elementos que maxItems");
        assertEquals(0L, store.count(), "BA-7: un 400 del sobre no procesa ningún elemento");
    }`;
}
