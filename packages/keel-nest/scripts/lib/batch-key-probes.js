// Los lotes SÍNCRONOS con clave (DSL 2.30, D15, incremento 10b) contra lo emitido, para db-check y doc-check: BK-1 a BK-5
// de keel-core/gen/batch.js, con los ids que ejecuta keel-spring (batch-check) sobre los MISMOS diseños
// (BATCH_KEY_DESIGNS de keel-core/test/helpers/batch-designs.js). El handler de la sonda es el de batch-probes.js
// (batchProbePatch).
//
// Se llama al controlador emitido como lo llama Nest (la petición con el texto del cuerpo que guarda http-platform.ts y la
// cabecera de la clave, el reply). La petición que muere a mitad de lote (BK-3, BK-4) es un almacén que lanza al escribir
// el resultado del SEGUNDO elemento: en TypeScript se captura todo, así que la muerte no puede ser un error del handler
// (sería el fallo de su elemento); el del almacén vuelve a caer al escribir el resultado de fallo y escapa del lote sin
// mover el cursor, como el Error del gancho de keel-spring. Que lleve muerto más que `batch.sync-stale-ms` se simula
// envejeciendo su `updated_at`.

import { BATCH_KEY_CASES, BATCH_KEY_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { BATCH_JOB, BATCH_ITEM_RESULT, BATCH_SYNC_STALE } from '@keel-system/keel-core/gen/batch-store';
import { batchOperations } from './batch-probes.js';
import { CONTAINER_TS, MEDIATOR_TS } from '../../src/scaffold/mediator.js';
import { handlerPath } from '../../src/scaffold/services.js';
import { EXCEPTION_FILTER_TS } from '../../src/scaffold/rest-support.js';
import { controllerClasses } from '../../src/scaffold/controllers.js';
import { KEYED_BATCHES_TS, SQL_BATCH_JOB_STORE_TS, MONGO_BATCH_JOB_STORE_TS } from '../../src/scaffold/batch-jobs.js';
import { quoteIdentifierFor } from '@keel-system/keel-core/gen/relational';
import { WIRE_TS } from '../../src/scaffold/wire.js';

const js = (value) => JSON.stringify(value);

/** Las operaciones síncronas con clave del modelo. */
const keyedOperations = (model) => batchOperations(model).filter((operation) => operation.batch.idempotency);

/** Los casos de un lote síncrono con clave que ejecuta este diseño: BK-1 a BK-4 con un per-item, BK-5 con un todo o nada. */
export function batchKeyCases(model) {
  const atomicities = new Set(keyedOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BK-1', 'BK-2', 'BK-3', 'BK-4');
  if (atomicities.has('all-or-nothing')) ids.push('BK-5');
  return BATCH_KEY_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const KEYED = /infrastructure[\\/]rest[\\/]batch[\\/]keyed-batches\.ts$/;
const SAME = (spec) => ({ relational: spec, document: spec });

/** El texto que se busca y se sustituye en lo emitido, por sabotaje y por almacén (relational | document). */
export const BATCH_KEY_SABOTAGE_SPECS = {
  // La repetición de un lote terminado lo vuelve a procesar en vez de responder lo guardado.
  'bk-replay-reprocess': SAME([
    KEYED,
    'if (started.replay) return this.steps.stored(started.id);\n    for (let index = started.from;',
    'if (started.replay) return perItem(items, readItem, itemErrors, process);\n    for (let index = started.from;'
  ]),
  // Un lote en marcha se toma igual que uno muerto.
  'bk-steal-running': SAME([KEYED, 'this.store.takeOver(job.id, this.settings.syncStaleMs)', 'this.store.takeOver(job.id, 0)']),
  // La reanudación empieza en el principio y no en el cursor.
  'bk-no-resume': SAME([KEYED, 'for (let index = started.from; index < items.length; index++) {', 'for (let index = 0; index < items.length; index++) {']),
  // El todo o nada que falla deja su trabajo.
  'bk-keep-failed': SAME([KEYED, 'await this.transactions.inTransaction(() => this.store.discard(id));', 'void id;'])
};

export const isBatchKeySabotage = (id) => Boolean(BATCH_KEY_SABOTAGE_SPECS[id]);

/** Lo que tiene que caer con un sabotaje en este diseño: sus casos BK que el bloque ejecuta, y solo esos. */
export function batchKeySabotageVerdict(checks, id, model) {
  const cases = batchKeyCases(model);
  const want = BATCH_KEY_SABOTAGES[id].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^BK-\d+:/.test(check.name)).map((check) => /^(BK-\d+):/.exec(check.name)[1]))].sort();
  return { exact: want.length > 0 && failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

const item = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => js({ items });

/** Lo que la sonda lee y retoca de las tablas, en cada modelo y motor. */
function storage(document, engine, product) {
  if (document) {
    return `  const jobsOf = () => database.collection(${js(BATCH_JOB.table)});
  const jobCount = () => jobsOf().countDocuments({});
  const resultCount = () => database.collection(${js(BATCH_ITEM_RESULT.table)}).countDocuments({});
  const age = (key, column, seconds) => jobsOf().updateOne({ idempotency_key: key }, { $set: { [column]: new Date(Date.now() - seconds * 1000) } });
  const wipe = async () => {
    await database.collection(${js(product.collectionName)}).deleteMany({});
    await database.collection(${js(BATCH_ITEM_RESULT.table)}).deleteMany({});
    await jobsOf().deleteMany({});
  };`;
  }
  const q = (name) => quoteIdentifierFor(engine, name);
  const mysql = engine === 'mysql';
  return `  const one = async (sql, params) => Number(Object.values((await dataSource.query(sql, params))[0] ?? {})[0] ?? 0);
  const jobCount = () => one(${js(`SELECT count(*) AS n FROM ${q(BATCH_JOB.table)}`)}, []);
  const resultCount = () => one(${js(`SELECT count(*) AS n FROM ${q(BATCH_ITEM_RESULT.table)}`)}, []);
  const age = (key, column, seconds) =>
    dataSource.query(\`UPDATE ${q(BATCH_JOB.table)} SET \${column} = ${mysql ? '?' : '$1'} WHERE idempotency_key = ${mysql ? '?' : '$2'}\`, [new Date(Date.now() - seconds * 1000), key]);
  const wipe = async () => {
    await dataSource.query(${js(`DELETE FROM ${q(product.tableName)}`)});
    await dataSource.query(${js(`DELETE FROM ${q(BATCH_ITEM_RESULT.table)}`)});
    await dataSource.query(${js(`DELETE FROM ${q(BATCH_JOB.table)}`)});
  };`;
}

/** El bloque de BK-1 a BK-5, con `check` y `tx` del script de la sonda. `adapterOf` da el adaptador de la raíz Product. */
export function batchKeyBlock(model, ctx, { document, engine, adapterOf }) {
  const operations = keyedOperations(model);
  if (operations.length === 0) return '';
  const cases = new Set(batchKeyCases(model));
  const product = model.entities.find((entity) => entity.name === 'Product');
  const service = model.services.find((candidate) => candidate.operations.includes(operations[0]));
  const controller = controllerClasses(model).find((entry) => entry.symbol === service.controllerClass);
  const dist = (symbol, file) => ctx.imports.add(`${symbol}|${file}`);
  dist('UseCaseContainer', CONTAINER_TS);
  dist('UseCaseMediator', MEDIATOR_TS);
  dist('ApiExceptionFilter', EXCEPTION_FILTER_TS);
  dist('toWireJson', WIRE_TS);
  dist(document ? 'MongoBatchJobStore' : 'SqlBatchJobStore', document ? MONGO_BATCH_JOB_STORE_TS : SQL_BATCH_JOB_STORE_TS);
  dist('KeyedBatches', KEYED_BATCHES_TS);
  dist(controller.symbol, controller.from);
  for (const operation of operations) dist(operation.handlerClass, handlerPath(operation));
  const perItem = operations.find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const stale = BATCH_SYNC_STALE.default;
  const lines = [];
  const test = (id, title, code) => {
    if (!cases.has(id)) return;
    lines.push(`  // ${id}: ${title}
  try {
    await wipe();
${code}
  } catch (error) {
    check(${js(`${id}: ${title}`)}, false, error?.stack ?? error);
  }`);
  };
  if (perItem) {
    const op = js(perItem.name);
    test('BK-1', 'la repetición devuelve el mismo 207', `    const content = ${js(body(item('KAA-0001'), item('KAA-0002')))};
    const first = await post(${op}, content, 'clave-1');
    check('BK-1: el primero responde 207', first.status === 207 && first.json.summary?.succeeded === 2, js(first));
    const results = await resultCount();
    const repeated = await post(${op}, content, 'clave-1');
    check('BK-1: la repetición responde 207', repeated.status === 207, js(repeated));
    check('BK-1: el MISMO 207', js(repeated.json) === js(first.json), js(repeated.json));
    check('BK-1: sin resultados nuevos', (await resultCount()) === results, await resultCount());
    check('BK-1: sin trabajo nuevo', (await jobCount()) === 1, await jobCount());`);
    test('BK-2', 'otra firma es la clave reutilizada', `    check('BK-2: el primero', (await post(${op}, ${js(body(item('KBB-0001')))}, 'clave-2')).status === 207);
    const reused = await post(${op}, ${js(body(item('KBB-0002')))}, 'clave-2');
    check('BK-2: la misma clave con otro cuerpo', reused.status === 409 && reused.json.code === 'IDEMPOTENCY_KEY_REUSED', js(reused));
    check('BK-2: sin procesar nada', (await batchProducts.findBySku('KBB-0002')) == null);
    await age('clave-2', 'key_expires_at', 60);
    const fresh = await post(${op}, ${js(body(item('KBB-0002')))}, 'clave-2');
    check('BK-2: pasada su ventana, un lote nuevo', fresh.status === 207, js(fresh));
    check('BK-2: que se procesa', (await batchProducts.findBySku('KBB-0002')) != null);
    check('BK-2: con su trabajo', (await jobCount()) === 2, await jobCount());`);
    test('BK-3', 'en marcha es 409', `    const content = ${js(body(item('KCC-0001'), item('KCC-0002'), item('KCC-0003')))};
    await dies(${op}, content, 'clave-3');
    const running = await post(${op}, content, 'clave-3');
    check('BK-3: el primero sigue en marcha', running.status === 409 && running.json.code === 'IDEMPOTENCY_KEY_IN_PROGRESS', js(running));
    check('BK-3: sin procesar nada', (await batchProducts.findBySku('KCC-0002')) == null);
    check('BK-3: solo el resultado del primero', (await resultCount()) === 1, await resultCount());`);
    test('BK-4', 'reanuda desde el cursor', `    const content = ${js(body(item('KDD-0001'), item('KDD-0002'), item('KDD-0003')))};
    await dies(${op}, content, 'clave-4');
    check('BK-4: lo confirmado antes de morir queda', (await batchProducts.findBySku('KDD-0001')) != null);
    await age('clave-4', 'updated_at', ${Math.ceil(stale / 1000) * 2});
    const resumed = await post(${op}, content, 'clave-4');
    check('BK-4: la repetición de un lote muerto lo sigue', resumed.status === 207, js(resumed));
    check('BK-4: el 207 los cuenta todos, sin repetir ninguno', summaryIs(resumed.json, 3, 3, 0, 0), js(resumed.json));
    check('BK-4: un resultado por elemento', (await resultCount()) === 3, await resultCount());
    check('BK-4: el último entró', (await batchProducts.findBySku('KDD-0003')) != null);`);
  }
  if (atomic) {
    const op = js(atomic.name);
    test('BK-5', 'todo o nada con clave', `    const good = ${js(body(item('KEE-0001'), item('KEE-0002')))};
    const first = await post(${op}, good, 'clave-5');
    check('BK-5: el lote confirmado', first.status === ${atomic.route.status}, js(first));
    const repeated = await post(${op}, good, 'clave-5');
    check('BK-5: se repite', repeated.status === ${atomic.route.status}, js(repeated));
    check('BK-5: con la misma respuesta', js(repeated.json) === js(first.json), js(repeated.json));
    check('BK-5: sin trabajo nuevo', (await jobCount()) === 1, await jobCount());
    const bad = ${js(body(item('KEE-0003'), item('KEE-0003')))};
    const failed = await post(${op}, bad, 'clave-6');
    check('BK-5: el que falla', failed.status === 409 && failed.json.code === 'SKU_ALREADY_EXISTS', js(failed));
    check('BK-5: no deja trabajo', (await jobCount()) === 1, await jobCount());
    const again = await post(${op}, bad, 'clave-6');
    check('BK-5: repetirlo lo vuelve a procesar', again.json.code === 'SKU_ALREADY_EXISTS', js(again));
    check('BK-5: no queda nada confirmado', (await batchProducts.findBySku('KEE-0003')) == null);`);
  }

  return `
// ── Lotes síncronos con clave (DSL 2.30, D15): BK-1 a BK-5, con el controlador, KeyedBatches y los almacenes emitidos.
{
  const batchProducts = ${adapterOf(product)};
  const jobStore = new ${document ? 'MongoBatchJobStore' : 'SqlBatchJobStore'}(tx);
  const settings = { chunkSize: 100, retentionDays: 7, purgeCron: '0 0 0 * * *', syncStaleMs: ${stale} };
  const mediator = new UseCaseMediator(UseCaseContainer.of([${operations.map((operation) => `new ${operation.handlerClass}(batchProducts)`).join(', ')}]), tx);
  const keyed = new KeyedBatches(jobStore, tx, settings);
  const controller = new ${controller.symbol}(mediator);
  controller.keyedBatches = keyed;
  const errors = new ApiExceptionFilter();
  const js = (value) => JSON.stringify(value);
${storage(document, engine, product)}
  // Como lo llama Nest: el status del decorador salvo que el método lo fije en el reply, el cuerpo con el serializador del
  // cable (toWireJson, el de http-platform.ts) y un fallo por el filtro global.
  const post = async (method, content, key) => {
    const reply = { code: null, status(value) { this.code = value; return this; }, header() { return this; } };
    const request = { rawBody: content, headers: { 'idempotency-key': key } };
    try {
      const answer = await controller[method]({}, {}, request, reply);
      return { status: reply.code ?? Reflect.getMetadata('__httpCode__', ${controller.symbol}.prototype[method]), json: JSON.parse(toWireJson(answer)) };
    } catch (error) {
      const response = errors.translate(error);
      if (response == null) throw error;
      return { status: response.status, json: JSON.parse(JSON.stringify(response)) };
    }
  };
  // La petición muere al escribir el resultado del SEGUNDO elemento: el primero queda confirmado y el trabajo, sin terminar.
  const dies = async (method, content, key) => {
    const crashing = Object.create(jobStore);
    let deaths = 0;
    crashing.insertResult = async (jobId, at, ...rest) => {
      if (at === 1) {
        deaths += 1;
        throw new Error('sonda: la petición muere');
      }
      return jobStore.insertResult(jobId, at, ...rest);
    };
    controller.keyedBatches = new KeyedBatches(crashing, tx, settings);
    let answer = null;
    try {
      answer = await post(method, content, key);
    } catch {
      // La muerte que la sonda provoca.
    } finally {
      controller.keyedBatches = keyed;
    }
    if (answer != null && answer.status !== 500) throw new Error('la sonda tenía que matar la petición: ' + js(answer));
    if (deaths === 0) throw new Error('la petición no llegó al segundo elemento');
  };
  const summaryIs = (json, total, succeeded, failed, notAttempted) => js(json?.summary) === js({ total, succeeded, failed, notAttempted });
${lines.join('\n')}
}
`;
}
