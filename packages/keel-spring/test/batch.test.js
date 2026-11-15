// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) en keel-spring: la forma de lo que emite build sobre los
// diseños de keel-core/test/helpers/batch-designs.js. Lo que esto NO dice —que cada elemento vaya en su transacción, que
// uno mal formado sea su resultado y no un 400, que un fallo no declarado detenga el lote, que el 207 salga siempre— lo
// mide scripts/batch-check.js contra el motor real (BA-1 a BA-7).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, batchNote } from '@keel-system/keel-core/gen/batch';
import { BATCH_DESIGNS, BATCH_JOB_DESIGNS, BATCH_KEY_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { batchStatements, batchSyncStatements } from '@keel-system/keel-core/gen/batch-store';
import { jobCasesOf } from '../src/lib/batch-job-probes.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { casesOf } from '../src/lib/batch-probes.js';
import { keyCasesOf } from '../src/lib/batch-key-probes.js';
import { buildModel } from '../src/lib/model.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => BATCH_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name) {
  const { manifest, layers, document } = load(name);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-spring y su sonda ejecuta los casos que les tocan', () => {
  const expected = {
    'catalog-batch': ['BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5', 'BA-7'],
    'catalog-batch-mongo': ['BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5', 'BA-7'],
    'catalog-batch-atomic': ['BA-6', 'BA-7']
  };
  for (const { name } of BATCH_DESIGNS) {
    const { manifest, layers, document } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const model = buildModel({ manifest, layers, stack: { database: document ? 'mongodb' : 'postgresql' } });
    assert.deepEqual(casesOf(model), expected[name], name);
  }
});

test('la frontera: la idempotencia del lote síncrono entero la genera keel-spring (D15); la clave que es un campo, no', () => {
  const idempotent = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  });
  assert.deepEqual(checkSupportedFeatures(idempotent.manifest, idempotent.layers).errors, []);
  const field = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'payload-field', keyField: 'items' };
  });
  assert.match(checkSupportedFeatures(field.manifest, field.layers).errors.join('\n'), /importProducts\.idempotency en un lote \(DSL 2\.30, D13\): keel-spring/);
});

test('el handler procesa UN elemento: su mensaje lleva el elemento y devuelve el ItemResult, con la nota neutral', () => {
  const { files, model } = plan('catalog-batch');
  const message = fileOf(files, '/application/commands/ImportProductsCommand.java');
  assert.match(message, /public record ImportProductsCommand\(\s+ProductDraft item\s+\) implements ReturningCommand<ImportProductsItemResult>/);
  assert.doesNotMatch(message, /List</, 'el mensaje no lleva la lista');
  assert.match(fileOf(files, '/application/dtos/ImportProductsItemResult.java'), /public record ImportProductsItemResult\(\s+UUID productId\s+\)/);
  const handler = fileOf(files, '/application/usecases/ImportProductsCommandHandler.java');
  assert.match(handler, /implements ReturningCommandHandler<ImportProductsCommand, ImportProductsItemResult>/);
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'importProducts');
  for (const line of batchNote(operation.batch)) assert.ok(handler.includes(`// ${line}`), `falta en la nota: ${line}`);
});

test('el borde solo valida el SOBRE: los elementos llegan sin leer y los lee BatchRunner uno a uno (D3)', () => {
  const { files } = plan('catalog-batch');
  const request = fileOf(files, '/infrastructure/rest/batch/ImportProductsBatchRequest.java');
  assert.match(request, /@NotEmpty @Size\(max = 500\) List<JsonNode> items/);
  assert.doesNotMatch(request, /ProductDraft/, 'con List<ProductDraft>, Jackson leería todos al leer el cuerpo: el primero mal formado sería un 400');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /public ResponseEntity<BatchResponse> importProducts\(@Valid @RequestBody ImportProductsBatchRequest request\) \{\s+return batchRunner\.perItem\(request\.items\(\), ProductDraft\.class, Set\.of\("SKU_ALREADY_EXISTS"\),\s+item -> mediator\.dispatch\(new ImportProductsCommand\(item\)\)\);/);
  const runner = fileOf(files, '/infrastructure/rest/batch/BatchRunner.java');
  // Los mismos lectores que el borde: el ObjectMapper y el Validator de la aplicación, y el fallo traducido por ApiExceptionHandler.
  assert.match(runner, /item = mapper\.treeToValue\(node, itemType\);/);
  assert.match(runner, /validator\.validate\(item\)/);
  assert.match(runner, /new ExceptionHandlerMethodResolver\(ApiExceptionHandler\.class\)/);
  assert.match(runner, /ResponseEntity\.status\(HttpStatus\.MULTI_STATUS\)/);
  // Sin all-or-nothing no hay transacción abarcadora: la abre el mediator en cada elemento (D2).
  assert.doesNotMatch(runner, /TransactionTemplate/);
  // Los textos del contrato, de keel-core y no a mano.
  assert.ok(runner.includes(JSON.stringify(BATCH_ABORTED_MESSAGE)));
  assert.ok(runner.includes(JSON.stringify(BATCH_ITEM_MALFORMED_MESSAGE)));
  assert.match(runner, /BATCH_ABORTED = "BATCH_ABORTED"/);
  // Las cinco claves del elemento, también con conventions.nulls: omit.
  assert.match(fileOf(files, '/infrastructure/rest/batch/BatchResponse.java'), /@JsonInclude\(JsonInclude\.Include\.ALWAYS\)\s+public record Item\(int index, String status, Object result, String error, String message\)/);
});

test('all-or-nothing: todos los elementos en una transacción y el successStatus del endpoint', () => {
  const { files } = plan('catalog-batch-atomic');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /public ResponseEntity<\?> importProducts\(@Valid @RequestBody ImportProductsBatchRequest request\) \{\s+return batchRunner\.allOrNothing\("items", request\.items\(\), ProductDraft\.class, HttpStatus\.valueOf\(200\),/);
  const runner = fileOf(files, '/infrastructure/rest/batch/BatchRunner.java');
  assert.match(runner, /transaction\.execute\(status -> processAll\(items, itemType, process, sink\)\)/);
  assert.match(runner, /List<String> details = List\.of\(over \+ "\[" \+ failure\.index \+ "\]"\);/);
});

test('el contrato formal: 207 con el resultado por elemento, y ningún error del diseño como respuesta del lote', () => {
  const { files } = plan('catalog-batch');
  const document = YAML.parse(fileOf(files, 'docs/openapi.yaml'));
  const post = document.paths['/api/v1/products/batch'].post;
  assert.deepEqual(Object.keys(post.responses).sort(), ['207', '400', ...Object.keys(post.responses).filter((key) => ['401', '403'].includes(key))].sort());
  assert.equal(post.responses['207'].content['application/json'].schema.$ref, '#/components/schemas/ImportProductsBatchResponse');
  assert.deepEqual(document.components.schemas.ImportProductsBatchItem.required, ['index', 'status', 'result', 'error', 'message']);
  assert.ok(document.components.schemas.ImportProductsItemResult, 'el result de cada elemento');
});

// ─── La fase B: lotes asíncronos (inc. 6 de PLAN-DSL-230-LOTES.md) ───────────
//
// Lo que esto NO dice —que el chunk reanude desde el cursor, que la valla revierta al que perdió el trabajo, que el dueño
// sea el único lector— lo mide scripts/batch-check.js sobre catalog-batch-async y -mongo (BJ-1 a BJ-9).

const jobDesign = (name) => BATCH_JOB_DESIGNS.find((entry) => entry.name === name);

function loadJob(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, jobDesign(name).from));
  jobDesign(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function planJob(name, { database = null, mutate = null } = {}) {
  const { manifest, layers, document } = loadJob(name, mutate);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: database ?? (document ? 'mongodb' : 'postgresql') } });
}

test('fase B: los sujetos asíncronos pasan la frontera y su sonda ejecuta BJ-1 a BJ-9', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { manifest, layers, document } = loadJob(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const model = buildModel({ manifest, layers, stack: { database: document ? 'mongodb' : 'postgresql' } });
    assert.deepEqual(jobCasesOf(model), ['BJ-1', 'BJ-2', 'BJ-3', 'BJ-4', 'BJ-5', 'BJ-6', 'BJ-7', 'BJ-8', 'BJ-9'], name);
  }
});

test('fase B: el alta lee los BYTES del cuerpo y responde 202; las dos rutas del trabajo cuelgan de la suya', () => {
  const { files } = planJob('catalog-batch-async');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(
    controller,
    /@PostMapping\("\/products\/batch"\)\s+public ResponseEntity<BatchJobView> importProducts\(@RequestBody byte\[\] body, @RequestHeader\(value = "Idempotency-Key", required = false\) String idempotencyKey\)/
  );
  assert.match(controller, /batchJobs\.submit\("importProducts", TimerKinds\.BATCH_IMPORT_PRODUCTS, body, ImportProductsBatchRequest\.class,\s+ImportProductsBatchRequest::items, "client-key", idempotencyKey, 86400L\)/);
  assert.match(controller, /@GetMapping\("\/products\/batch\/jobs\/\{jobId\}"\)\s+public BatchJobView importProductsJob\(@PathVariable UUID jobId\)/);
  assert.match(controller, /@GetMapping\("\/products\/batch\/jobs\/\{jobId\}\/results"\)\s+public PagedResponse<BatchResponse\.Item> importProductsJobResults/);
  const jobs = fileOf(files, '/infrastructure/rest/batch/BatchJobs.java');
  // El alta: el sobre con los lectores del borde, la firma de los bytes y el trabajo con su temporizador en una transacción.
  const steps = fileOf(files, '/infrastructure/rest/batch/BatchJobSteps.java');
  assert.match(jobs, /steps\.readEnvelope\(body, requestType\)/);
  assert.match(jobs, /BatchJobSteps\.signature\(body\)/);
  assert.match(steps, /mapper\.readValue\(body, requestType\)/);
  assert.match(steps, /validator\.validate\(request\)/);
  assert.match(steps, /MessageDigest\.getInstance\("SHA-256"\)\.digest\(body\)/);
  assert.match(jobs, /store\.insert\(id, operation, owner, key, signature, ttlMs, input, total\);\s+\/\/[^\n]*\n\s+timers\.arm\(kind, id, timers\.dbNow\(\)\);/);
  assert.match(jobs, /ResponseEntity\.accepted\(\)\.location\(location\)\.body\(view\)/);
  // Solo el dueño lee el trabajo (D11).
  assert.match(jobs, /store\.owned\(jobId, operation, owner\(\)\)\.orElseThrow\(\(\) -> new BatchJobNotFoundException\(jobId\)\)/);
  assert.match(fileOf(files, '/infrastructure/rest/batch/BatchJobNotFoundException.java'), /"BATCH_JOB_NOT_FOUND", 404/);
});

test('fase B: D13, la clave vive en el trabajo y no en el registro de claves de petición', () => {
  const { files } = planJob('catalog-batch-async');
  const filter = files.find((file) => file.path.endsWith('/IdempotencyKeyFilter.java'))?.content ?? '';
  assert.doesNotMatch(filter, /\/products\/batch/, 'el filtro de la cabecera no mira el lote: su clave la lee BatchJobs');
  assert.match(fileOf(files, '/infrastructure/rest/batch/BatchJobKeyReusedException.java'), /Map\.of\("importProducts", "IDEMPOTENCY_KEY_REUSED"\)/);
  // Las sentencias de keel-core, tal cual.
  const store = fileOf(files, '/infrastructure/persistence/batch/JdbcBatchJobStore.java');
  for (const [name, sql] of Object.entries(batchStatements('postgresql'))) {
    assert.ok(store.includes(JSON.stringify(sql)), `falta la sentencia ${name}`);
  }
});

test('fase B: un chunk por disparo, fuera de la transacción del sondeador, y la valla antes del resultado', () => {
  const { files } = planJob('catalog-batch-async');
  const handler = fileOf(files, '/infrastructure/rest/batch/ImportProductsBatchJob.java');
  assert.match(handler, /public boolean inTransaction\(\) \{\s+return false;/);
  assert.match(handler, /return TimerKinds\.BATCH_IMPORT_PRODUCTS;/);
  assert.match(fileOf(files, '/infrastructure/timer/TimerKinds.java'), /BATCH_IMPORT_PRODUCTS = "batch:importProducts"/);
  const poller = fileOf(files, '/infrastructure/timer/TimerPoller.java');
  assert.match(poller, /if \(handler\.inTransaction\(\)\) \{[\s\S]*?\} else \{\s+settle\(timer, token, handler\.handle\(timer, store\.dbNow\(\)\)\);/);
  const runner = fileOf(files, '/infrastructure/rest/batch/BatchJobRunner.java');
  assert.match(runner, /int index = job\.nextIndex\(\);/, 'cada disparo empieza en el cursor (bj-no-resume)');
  assert.match(runner, /steps\.process\(job\.id\(\), index, nodes\.get\(index\)/);
  // El efecto, el avance y el resultado en UNA transacción (bj-cursor-outside-tx); el avance primero: es la valla.
  const steps = fileOf(files, '/infrastructure/rest/batch/BatchJobSteps.java');
  assert.match(steps, /Boolean kept = transaction\.execute\(status -> \{\s+Object result = process\.apply\(item\);\s+return keep\(status, jobId, index, BatchResponse\.Item\.succeeded\(index, result\)\);/);
  assert.match(steps, /if \(!advance\(jobId, item\)\) \{\s+status\.setRollbackOnly\(\);/);
  assert.match(steps, /if \(!store\.advance\(jobId, item\.index\(\), ok \? 1 : 0, ok \? 0 : 1\)\) \{\s+return false;\s+\}[\s\S]*?store\.insertResult\(/);
  assert.match(runner, /@Value\("\$\{batch\.chunk-size:100\}"\) int chunkSize/);
  // La purga es un recurrente más, y el fragmento de configuración lleva los tres parámetros de keel-core.
  assert.match(fileOf(files, '/infrastructure/timer/BatchJobPurgeTimer.java'), /batchJobPurge\.purge\(\);/);
  const yaml = YAML.parse(fileOf(files, 'parameters/production/batch.yaml'));
  assert.deepEqual(Object.keys(yaml.batch), ['chunk-size', 'retention-days', 'purge']);
});

test('fase B: documental con el índice parcial de la clave, y las tablas en el esquema relacional', () => {
  const mongo = fileOf(planJob('catalog-batch-async-mongo').files, '/infrastructure/persistence/batch/MongoBatchJobStore.java');
  assert.match(mongo, /\.unique\(\)\s+\.partial\(PartialIndexFilter\.of\(new Document\("idempotency_key", new Document\("\$type", "string"\)\)\)\)\s+\.named\("uq_batch_job_key"\)/);
  const { files } = planJob('catalog-batch-async', { database: 'mysql' });
  assert.match(fileOf(files, '/BatchJobJpa.java'), /@Table\(name = "batch_job",\s+uniqueConstraints = @UniqueConstraint\(name = "uq_batch_job_key", columnNames = \{"operation", "owner", "idempotency_key"\}\)/);
  assert.match(fileOf(files, '/BatchItemResultJpa.java'), /foreignKey = @ForeignKey\(name = "fk_batch_item_result_job"\)/);
  assert.ok(fileOf(files, '/JdbcBatchJobStore.java').includes(JSON.stringify(batchStatements('mysql').advance)));
});

test('fase B: lo que el trabajo no puede llevarse de la petición, y un motor sin sentencias, los rechaza planService', () => {
  assert.throws(() => planJob('catalog-batch-async', { database: 'mariadb' }), /sentencias medidas para postgresql, mysql/);
  assert.throws(
    () =>
      planJob('catalog-batch-async', {
        mutate: (layers) => {
          layers.api.endpoints.importProducts.path = '/catalogs/{catalogId}/products/batch';
          layers['use-cases'].operations.importProducts.input.fields.catalogId = { type: 'uuid', required: true };
        }
      }),
    /guarda el CUERPO de la petición/
  );
});

// ─── El lote síncrono con clave (D15, incremento 10b) ────────────────────────

function planKeyed(name, { database = null } = {}) {
  const entry = BATCH_KEY_DESIGNS.find((candidate) => candidate.name === name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, entry.from));
  entry.mutate(layers);
  const document = layers.persistence?.default?.model === 'document';
  const stack = { database: database ?? (document ? 'mongodb' : 'postgresql') };
  return { ...planService({ manifest, layers, workspace: FIXTURES_DIR, stack }), manifest, layers, model: buildModel({ manifest, layers, stack }) };
}

test('D15: los sujetos con clave pasan la frontera y su sonda ejecuta los BA-* y los BK-* que les tocan', () => {
  const expected = {
    'catalog-batch-keyed': ['BK-1', 'BK-2', 'BK-3', 'BK-4'],
    'catalog-batch-keyed-mongo': ['BK-1', 'BK-2', 'BK-3', 'BK-4'],
    'catalog-batch-atomic-keyed': ['BK-5']
  };
  for (const { name } of BATCH_KEY_DESIGNS) {
    const { manifest, layers, model } = planKeyed(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    assert.deepEqual(keyCasesOf(model), expected[name], name);
    assert.ok(casesOf(model).includes('BA-7'), `${name}: el sobre leído en bytes sigue siendo el 400 del lote`);
  }
});

test('D15: el cuerpo llega en bytes con la cabecera de la clave, y KeyedBatches resuelve la repetición con el trabajo', () => {
  const { files } = planKeyed('catalog-batch-keyed');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /public ResponseEntity<BatchResponse> importProducts\(@RequestBody byte\[\] body, @RequestHeader\(value = "Idempotency-Key", required = false\) String idempotencyKey\)/);
  assert.match(controller, /ImportProductsBatchRequest request = keyedBatches\.read\(body, ImportProductsBatchRequest\.class\);/);
  assert.match(controller, /keyedBatches\.perItem\("importProducts", body, "client-key", idempotencyKey, 86400L, request\.items\(\), ProductDraft\.class,/);
  assert.doesNotMatch(controller, /@Valid @RequestBody ImportProductsBatchRequest/);
  const keyed = fileOf(files, '/infrastructure/rest/batch/KeyedBatches.java');
  // Sin capa security, el dueño es el de keel-core y no hace falta el actor de autoría.
  assert.match(keyed, /private static final String OWNER = "anonymous";/);
  assert.doesNotMatch(keyed, /AuditorAware/);
  // La repetición (batchSyncRepeat): reutilizada, terminada, en curso o muerta.
  assert.match(keyed, /if \(!hit\.signature\(\)\.equals\(signature\)\) \{\s+throw new BatchJobKeyReusedException\(operation, key\);/);
  assert.match(keyed, /if \(job\.finishedAt\(\) != null\) \{\s+return new Started\(job\.id\(\), job\.total\(\), true\);/);
  assert.match(keyed, /if \(!store\.takeOver\(job\.id\(\), staleMs\)\) \{\s+throw new BatchKeyInProgressException\(operation, key\);/);
  assert.match(keyed, /@Value\("\$\{batch\.sync-stale-ms:60000\}"\) long staleMs/);
  // Sigue desde el cursor (bk-no-resume) y responde siempre lo guardado (bk-replay-reprocess).
  assert.match(keyed, /for \(int index = started\.from\(\); index < items\.size\(\); index\+\+\) \{\s+BatchJobSteps\.Step step/);
  assert.match(keyed, /if \(started\.replay\(\)\) \{\s+return ResponseEntity\.status\(HttpStatus\.MULTI_STATUS\)\.body\(steps\.stored\(started\.id\(\)\)\);/);
  assert.doesNotMatch(keyed, /allOrNothing/, 'sin un todo o nada con clave, sin su método');
  assert.match(fileOf(files, '/BatchKeyInProgressException.java'), /Map\.of\("importProducts", "IDEMPOTENCY_KEY_IN_PROGRESS"\)/);
  assert.match(fileOf(files, '/BatchJobKeyReusedException.java'), /Map\.of\("importProducts", "IDEMPOTENCY_KEY_REUSED"\)/);
  // Sin temporizador ni rutas del trabajo: el lote se procesa en la petición.
  for (const absent of ['BatchJobs.java', 'BatchJobRunner.java', 'ImportProductsBatchJob.java', 'BatchJobView.java']) {
    assert.ok(!files.some((file) => file.path.endsWith(`/${absent}`)), `sobra ${absent}`);
  }
  assert.doesNotMatch(fileOf(files, '/infrastructure/timer/TimerKinds.java'), /BATCH_IMPORT_PRODUCTS/);
  // La purga del almacén sí: es un recurrente más del cronómetro.
  assert.match(fileOf(files, '/infrastructure/timer/BatchJobPurgeTimer.java'), /batchJobPurge\.purge\(\);/);
  const yaml = YAML.parse(fileOf(files, 'parameters/production/batch.yaml'));
  assert.deepEqual(Object.keys(yaml.batch), ['retention-days', 'purge', 'sync-stale-ms']);
});

test('D15: el almacén lleva las sentencias del lote síncrono de keel-core, tal cual, solo con lotes con clave', () => {
  for (const database of ['postgresql', 'mysql']) {
    const store = fileOf(planKeyed('catalog-batch-keyed', { database }).files, '/JdbcBatchJobStore.java');
    for (const [name, sql] of Object.entries({ ...batchStatements(database), ...batchSyncStatements(database) })) {
      assert.ok(store.includes(JSON.stringify(sql)), `${database}: falta la sentencia ${name}`);
    }
  }
  const asyncStore = fileOf(planJob('catalog-batch-async').files, '/JdbcBatchJobStore.java');
  assert.ok(!asyncStore.includes(JSON.stringify(batchSyncStatements('postgresql').takeOver)), 'sin lotes con clave no lleva takeOver');
  const mongo = fileOf(planKeyed('catalog-batch-keyed-mongo').files, '/MongoBatchJobStore.java');
  assert.match(mongo, /public boolean takeOver\(UUID id, long staleMs\) \{[\s\S]*?and\("updated_at"\)\.lte\(Date\.from\(now\.minusMillis\(staleMs\)\)\)/);
  assert.match(mongo, /public boolean discard\(UUID id\) \{\s+Query open = new Query\(Criteria\.where\("_id"\)\.is\(id\.toString\(\)\)\.and\("finished_at"\)\.is\(null\)\);/);
});

test('D15: el todo o nada con clave guarda en la transacción del lote y descarta su trabajo si falla (bk-keep-failed)', () => {
  const { files } = planKeyed('catalog-batch-atomic-keyed');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /keyedBatches\.allOrNothing\("importProducts", "items", body, "client-key", idempotencyKey, 86400L, request\.items\(\), ProductDraft\.class,\s+HttpStatus\.valueOf\(200\),/);
  const keyed = fileOf(files, '/KeyedBatches.java');
  assert.match(keyed, /public void kept\(BatchResponse\.Item item\) \{\s+steps\.keepInLot\(id, item\);/);
  assert.match(keyed, /public void discarded\(\) \{\s+transaction\.executeWithoutResult\(status -> store\.discard\(id\)\);/);
  const runner = fileOf(files, '/BatchRunner.java');
  assert.match(runner, /catch \(ItemFailure failure\) \{\s+sink\.discarded\(\);/);
  assert.match(runner, /results\.add\(done\);\s+sink\.kept\(done\);/);
});

test('D15: con capa security el dueño del lote con clave es el actor de autoría', () => {
  const entry = BATCH_KEY_DESIGNS.find((candidate) => candidate.name === 'catalog-batch-keyed');
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, entry.from));
  entry.mutate(layers);
  layers.security = {
    authentication: { protocol: 'oidc', tokenLocation: 'header' },
    access: { default: { level: 'required', description: 'Toda la API exige un token válido.' } }
  };
  const secured = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  const keyed = fileOf(secured, '/KeyedBatches.java');
  assert.match(keyed, /return auditor\.getCurrentAuditor\(\)\.orElseThrow\(\);/);
  assert.doesNotMatch(keyed, /OWNER/);
  assert.ok(secured.some((file) => file.path.endsWith('/AuditorAwareConfig.java')), 'el actor de autoría se emite para el dueño');
});

test('D15: un motor sin sentencias del almacén lo rechaza planService también para un lote síncrono con clave', () => {
  assert.throws(() => planKeyed('catalog-batch-keyed', { database: 'mariadb' }), /idempotency en un lote síncrono[\s\S]*sentencias medidas para postgresql, mysql/);
});

