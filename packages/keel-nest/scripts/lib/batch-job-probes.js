// Los LOTES ASÍNCRONOS (DSL 2.30, fase B) contra lo emitido, para db-check y doc-check: BJ-1 a BJ-9 de
// keel-core/gen/batch.js, con los ids que ejecuta keel-spring (batch-check) sobre los MISMOS diseños
// (BATCH_JOB_DESIGNS de keel-core/test/helpers/batch-designs.js). El handler de la sonda es el de batch-probes.js
// (batchProbePatch), con su gancho `probeHooks.afterEffect`.
//
// Se llama al controlador emitido como lo llama Nest (la petición con el texto del cuerpo que guarda http-platform.ts, el
// reply), con el dueño puesto a mano en el SecurityContext (es lo que lee el actor de autoría); el temporizador de cada
// trabajo se dispara llamando a su handler, así que la sonda decide cuándo corre cada chunk. La caída de una réplica a
// mitad de chunk (BJ-4) es un almacén que lanza al escribir un resultado; la réplica que le quita el trabajo (BJ-5) es el
// gancho del handler, que mueve el cursor FUERA de la transacción del elemento, tras el efecto.

import { BATCH_JOB_CASES, BATCH_JOB_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { BATCH_JOB, BATCH_ITEM_RESULT, batchKind } from '@keel-system/keel-core/gen/batch-store';
import { KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { allBatchOperations, UNDECLARED_FAILURE_NAME } from './batch-probes.js';
import { CONTAINER_TS, MEDIATOR_TS } from '../../src/scaffold/mediator.js';
import { handlerPath } from '../../src/scaffold/services.js';
import { EXCEPTION_FILTER_TS } from '../../src/scaffold/rest-support.js';
import { controllerClasses } from '../../src/scaffold/controllers.js';
import { SQL_TIMER_STORE_TS, MONGO_TIMER_STORE_TS, TIMER_STORE_TS } from '../../src/scaffold/timer.js';
import { SECURITY_CONTEXT_TS } from '../../src/scaffold/security.js';
import {
  BATCH_JOBS_TS,
  BATCH_JOB_RUNNER_TS,
  SQL_BATCH_JOB_STORE_TS,
  MONGO_BATCH_JOB_STORE_TS,
  batchJobClass,
  batchJobPath
} from '../../src/scaffold/batch-jobs.js';
import { quoteIdentifierFor } from '@keel-system/keel-core/gen/relational';
import { WIRE_TS } from '../../src/scaffold/wire.js';

const js = (value) => JSON.stringify(value);

/** El tamaño del chunk con el que corre la sonda: pequeño, para que un trabajo de cinco elementos dé tres disparos. */
export const PROBE_CHUNK_SIZE = 2;

/** La operación asíncrona del modelo, o undefined. */
export const asyncOperation = (model) => allBatchOperations(model).find((operation) => operation.batch.execution === 'async');

/** Los casos de un lote ASÍNCRONO que ejecuta este diseño: todos, si declara uno. */
export function batchJobCases(model) {
  return asyncOperation(model) ? BATCH_JOB_CASES.map((entry) => entry.id) : [];
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const RUNNER = /infrastructure[\\/]rest[\\/]batch[\\/]batch-job-runner\.ts$/;
const JOBS = /infrastructure[\\/]rest[\\/]batch[\\/]batch-jobs\.ts$/;
const STEPS = /infrastructure[\\/]rest[\\/]batch[\\/]batch-job-steps\.ts$/;
const SAME = (spec) => ({ relational: spec, document: spec });

/** El texto que se busca y se sustituye en lo emitido, por sabotaje y por almacén (relational | document). */
export const BATCH_JOB_SABOTAGE_SPECS = {
  // Cada disparo empieza en el principio de su chunk y no en el cursor: tras una caída a mitad de chunk reprocesa lo ya
  // confirmado.
  'bj-no-resume': SAME([RUNNER, 'let index = job.nextIndex;', 'let index = job.nextIndex - (job.nextIndex % this.settings.chunkSize);']),
  // El efecto en su transacción, y el cursor con el resultado en otra, después.
  'bj-cursor-outside-tx': SAME([
    STEPS,
    'await this.transactions.inTransaction(async () => {\n        const result = await process(item);\n        await this.keep(jobId, index, BatchItem.succeeded(index, result));\n      });',
    'const result = await this.transactions.inTransaction(() => process(item));\n      await this.transactions.inTransaction(() => this.keep(jobId, index, BatchItem.succeeded(index, result)));'
  ]),
  // Las rutas del trabajo no miran el dueño.
  'bj-foreign-reader': SAME([JOBS, 'await this.store.owned(jobId, operation, currentActor());', 'await this.store.job(jobId).then((found) => (found?.operation === operation ? found : null));'])
};

export const isBatchJobSabotage = (id) => Boolean(BATCH_JOB_SABOTAGE_SPECS[id]);

/** Lo que tiene que caer con un sabotaje: sus casos BJ, y solo esos. */
export function batchJobSabotageVerdict(checks, id) {
  const want = [...BATCH_JOB_SABOTAGES[id]].sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^BJ-\d+:/.test(check.name)).map((check) => /^(BJ-\d+):/.exec(check.name)[1]))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

const item = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => js({ items });
const skus = (prefix, count) => Array.from({ length: count }, (_, n) => item(`${prefix}-000${n}`));

/** Lo que la sonda lee y retoca de las tablas, en cada modelo y motor. */
function storage(document, engine, product, operationName) {
  const kind = js(batchKind(operationName));
  if (document) {
    return `  const jobsOf = () => database.collection(${js(BATCH_JOB.table)});
  const resultsOf = () => database.collection(${js(BATCH_ITEM_RESULT.table)});
  const jobCount = () => jobsOf().countDocuments({});
  const armed = (id) => database.collection(${js(KEEL_TIMER.table)}).countDocuments({ kind: ${kind}, entity_id: id });
  const setTime = (id, column, value) => jobsOf().updateOne({ _id: id }, { $set: { [column]: value } });
  const cursor = async (id) => Number((await jobsOf().findOne({ _id: id }))?.next_index);
  const resultCount = (id) => resultsOf().countDocuments({ job_id: id });
  const exists = async (id) => (await jobsOf().findOne({ _id: id })) != null;
  // Otra réplica se lleva el elemento: mueve el cursor en SU transacción (aquí, sin sesión).
  const bumpCursor = (id) => jobsOf().updateOne({ _id: id }, { $inc: { next_index: 1 } });
  const wipe = async () => {
    await database.collection(${js(product.collectionName)}).deleteMany({});
    await resultsOf().deleteMany({});
    await jobsOf().deleteMany({});
    await database.collection(${js(KEEL_TIMER.table)}).deleteMany({ kind: { $regex: '^batch:' } });
  };`;
  }
  const mysql = engine === 'mysql';
  const q = (name) => quoteIdentifierFor(engine, name);
  const id = mysql ? 'UUID_TO_BIN(?)' : '$1';
  const at = (n) => (mysql ? '?' : `$${n}`);
  return `  const one = async (sql, params) => Number(Object.values((await dataSource.query(sql, params))[0] ?? {})[0] ?? 0);
  const jobCount = () => one(${js(`SELECT count(*) AS n FROM ${q(BATCH_JOB.table)}`)}, []);
  const armed = (id) => one(${js(`SELECT count(*) AS n FROM ${q(KEEL_TIMER.table)} WHERE kind = ${at(1)} AND entity_id = ${mysql ? 'UUID_TO_BIN(?)' : '$2'}`)}, [${kind}, id]);
  const setTime = (id, column, value) => dataSource.query(\`UPDATE ${q(BATCH_JOB.table)} SET \${column} = ${at(1)} WHERE id = ${mysql ? 'UUID_TO_BIN(?)' : '$2'}\`, [value, id]);
  const cursor = (id) => one(${js(`SELECT next_index FROM ${q(BATCH_JOB.table)} WHERE id = ${id}`)}, [id]);
  const resultCount = (id) => one(${js(`SELECT count(*) AS n FROM ${q(BATCH_ITEM_RESULT.table)} WHERE job_id = ${id}`)}, [id]);
  const exists = async (id) => (await one(${js(`SELECT count(*) AS n FROM ${q(BATCH_JOB.table)} WHERE id = ${id}`)}, [id])) === 1;
  // Otra réplica se lleva el elemento: mueve el cursor en SU transacción (aquí, una conexión del pool en autocommit).
  const bumpCursor = (id) => dataSource.query(${js(`UPDATE ${q(BATCH_JOB.table)} SET next_index = next_index + 1 WHERE id = ${id}`)}, [id]);
  const wipe = async () => {
    await dataSource.query(${js(`DELETE FROM ${q(product.tableName)}`)});
    await dataSource.query(${js(`DELETE FROM ${q(BATCH_ITEM_RESULT.table)}`)});
    await dataSource.query(${js(`DELETE FROM ${q(BATCH_JOB.table)}`)});
    await dataSource.query(${js(`DELETE FROM ${q(KEEL_TIMER.table)} WHERE kind LIKE 'batch:%'`)});
  };`;
}

/** El bloque de BJ-1 a BJ-9, con `check` y `tx` del script de la sonda. `adapterOf` da el adaptador de la raíz Product. */
export function batchJobBlock(model, ctx, { document, engine, adapterOf }) {
  const operation = asyncOperation(model);
  if (!operation) return '';
  const product = model.entities.find((entity) => entity.name === 'Product');
  const service = model.services.find((candidate) => candidate.operations.includes(operation));
  const controller = controllerClasses(model).find((entry) => entry.symbol === service.controllerClass);
  const dist = (symbol, file) => ctx.imports.add(`${symbol}|${file}`);
  dist('UseCaseContainer', CONTAINER_TS);
  dist('UseCaseMediator', MEDIATOR_TS);
  dist('ApiExceptionFilter', EXCEPTION_FILTER_TS);
  dist('SecurityContext', SECURITY_CONTEXT_TS);
  dist('toWireJson', WIRE_TS);
  dist('TimerArmedSignal', TIMER_STORE_TS);
  dist(document ? 'MongoTimerStore' : 'SqlTimerStore', document ? MONGO_TIMER_STORE_TS : SQL_TIMER_STORE_TS);
  dist(document ? 'MongoBatchJobStore' : 'SqlBatchJobStore', document ? MONGO_BATCH_JOB_STORE_TS : SQL_BATCH_JOB_STORE_TS);
  dist('BatchJobs', BATCH_JOBS_TS);
  dist('BatchJobRunner', BATCH_JOB_RUNNER_TS);
  dist(batchJobClass(operation), batchJobPath(operation));
  dist(controller.symbol, controller.from);
  dist(operation.handlerClass, handlerPath(operation));
  dist('probeHooks', handlerPath(operation));
  const at = js(`${model.api.routeBase}${operation.route.path}`);
  const name = operation.name;
  const jobClass = batchJobClass(operation);
  const maxItems = operation.batch.maxItems;
  const lines = [];
  const test = (id, title, code) => {
    lines.push(`  // ${id}: ${title}
  try {
    await wipe();
    await as('alice', async () => {
${code}
    });
  } catch (error) {
    check(${js(`${id}: ${title}`)}, false, error?.stack ?? error);
  }`);
  };
  test('BJ-1', 'el alta responde 202 sin procesar nada', `      const answer = await post(${js(body(...skus('JAA', 2)))}, null);
      check('BJ-1: el alta responde 202', answer.status === 202, js(answer));
      const id = answer.json.id;
      check('BJ-1: Location del trabajo', typeof answer.location === 'string' && answer.location.endsWith(${at} + '/jobs/' + id), answer.location);
      check('BJ-1: queued, con su total y sin terminar', answer.json.status === 'queued' && answer.json.summary?.total === 2 && answer.json.finishedAt === null, js(answer.json));
      check('BJ-1: el temporizador del trabajo se armó con él', (await armed(id)) === 1);
      check('BJ-1: el alta no procesa ningún elemento', (await batchProducts.findBySku('JAA-0000')) == null);`);
  test('BJ-2', 'por chunks hasta completed, con los resultados paginados', `      const id = await submit(${js(body(...skus('JBB', 5)))});
      check('BJ-2: el primer chunk deja trabajo', !(await fire(id)).done);
      check('BJ-2: un chunk de ${PROBE_CHUNK_SIZE}', (await cursor(id)) === ${PROBE_CHUNK_SIZE}, await cursor(id));
      check('BJ-2: el segundo también', !(await fire(id)).done);
      check('BJ-2: el tercero termina', (await fire(id)).done);
      const status = (await get(id)).json;
      check('BJ-2: completed', status.status === 'completed', js(status));
      check('BJ-2: el resumen', summaryIs(status, 5, 5, 0, 0), js(status.summary));
      check('BJ-2: finishedAt', status.finishedAt != null);
      const page = (await results(id, { page: '1', size: '2' })).json;
      check('BJ-2: los resultados, paginados', page.totalElements === 5, js(page));
      check('BJ-2: en orden de índice', page.items?.[0]?.index === 2 && page.items?.[1]?.index === 3, js(page.items));
      check('BJ-2: el result de batch.output', typeof page.items?.[0]?.result?.productId === 'string', js(page.items?.[0]));
      check('BJ-2: el último elemento entró', (await batchProducts.findBySku('JBB-0004')) != null);`);
  test('BJ-3', 'un itemError falla solo su elemento y uno no declarado detiene el trabajo', `      await run(await submit(${js(body(item('JCC-0009')))}));
      const id = await submit(${js(body(item('JCC-0001'), item('JCC-0009'), item('mal'), item('JCC-0003'), item('JCC-0004', UNDECLARED_FAILURE_NAME), item('JCC-0005')))});
      await run(id);
      const status = (await get(id)).json;
      check('BJ-3: un fallo no declarado detiene el trabajo', status.status === 'aborted', js(status));
      check('BJ-3: el resumen', summaryIs(status, 6, 2, 3, 1), js(status.summary));
      const page = (await results(id, { size: '50' })).json;
      check('BJ-3: los notAttempted no se escriben fila a fila', page.totalElements === 5, js(page));
      check('BJ-3: el duplicado', resultIs(page, 1, 'failed', 'SKU_ALREADY_EXISTS'), js(page.items));
      check('BJ-3: el mal formado', resultIs(page, 2, 'failed', 'VALIDATION_ERROR'), js(page.items));
      check('BJ-3: lo que sigue a un itemError se procesa', resultIs(page, 3, 'succeeded', null), js(page.items));
      check('BJ-3: el que detiene el trabajo', resultIs(page, 4, 'failed', 'BATCH_ABORTED'), js(page.items));
      check('BJ-3: lo que le sigue no se procesa', (await batchProducts.findBySku('JCC-0005')) == null);`);
  test('BJ-4', 'reanuda desde el cursor tras caer a mitad de chunk', `      const id = await submit(${js(body(...skus('JDD', 5)))});
      check('BJ-4: el primer chunk', !(await fire(id)).done);
      // La réplica cae al escribir el resultado del elemento 3, a mitad del segundo chunk: el 2 ya está confirmado.
      const crashing = new ${jobClass}(new BatchJobRunner(crashingAt(3), timerStore, tx, settings), mediator);
      let crashed = false;
      try {
        await crashing.handle(timer(id));
      } catch {
        crashed = true;
      }
      check('BJ-4: la sonda simula la caída', crashed);
      check('BJ-4: lo confirmado antes de caer queda', (await cursor(id)) === 3, await cursor(id));
      await run(id);
      const status = (await get(id)).json;
      check('BJ-4: otra réplica lo termina desde el cursor', status.status === 'completed', js(status));
      check('BJ-4: ningún elemento se repite ni se pierde', summaryIs(status, 5, 5, 0, 0), js(status.summary));
      check('BJ-4: un resultado por elemento', (await resultCount(id)) === 5, await resultCount(id));
      check('BJ-4: el elemento de la caída entró', (await batchProducts.findBySku('JDD-0003')) != null);`);
  test('BJ-5', 'la valla revierte al que pierde el trabajo', `      const id = await submit(${js(body(item('JEE-0001')))});
      probeHooks.afterEffect = async () => {
        probeHooks.afterEffect = null;
        await bumpCursor(id);
      };
      try {
        await fire(id);
      } finally {
        probeHooks.afterEffect = null;
      }
      check('BJ-5: el elemento del que perdió el trabajo revierte con su efecto', (await batchProducts.findBySku('JEE-0001')) == null);
      check('BJ-5: y sin resultado', (await resultCount(id)) === 0, await resultCount(id));
      check('BJ-5: el cursor es el de quien se lo llevó', (await cursor(id)) === 1, await cursor(id));`);
  test('BJ-6', 'solo lo lee quien lo creó', `      const id = await submit(${js(body(item('JFF-0001')))});
      await as('bob', async () => {
        const status = await get(id);
        const page = await results(id, {});
        check('BJ-6: un trabajo ajeno es un 404', status.status === 404 && status.json.code === 'BATCH_JOB_NOT_FOUND', js(status));
        check('BJ-6: también sus resultados', page.status === 404 && page.json.code === 'BATCH_JOB_NOT_FOUND', js(page));
      });
      check('BJ-6: uno inexistente, lo mismo', (await get(randomUUID())).status === 404);
      check('BJ-6: su dueño sí lo lee', (await get(id)).status === 200);
      check('BJ-6: y sus resultados', (await results(id, {})).status === 200);`);
  test('BJ-7', 'la clave del lote', `      const first = ${js(body(item('JGG-0001')))};
      const created = await post(first, 'clave-1');
      check('BJ-7: el alta con clave', created.status === 202, js(created));
      const id = created.json.id;
      await run(id);
      const repeated = await post(first, 'clave-1');
      check('BJ-7: la repetición responde el mismo 202', repeated.status === 202, js(repeated));
      check('BJ-7: con el mismo Location', repeated.location === created.location, repeated.location);
      check('BJ-7: y el trabajo en el estado en que esté', repeated.json.status === 'completed', js(repeated.json));
      const reused = await post(${js(body(item('JGG-0002')))}, 'clave-1');
      check('BJ-7: la misma clave con otro contenido', reused.status === 409 && reused.json.code === 'IDEMPOTENCY_KEY_REUSED', js(reused));
      await as('bob', async () => {
        check('BJ-7: la clave es por dueño', (await post(first, 'clave-1')).json.id !== id);
      });
      await setTime(id, 'key_expires_at', new Date(Date.now() - 60_000));
      const fresh = await post(${js(body(item('JGG-0002')))}, 'clave-1');
      check('BJ-7: pasada su ventana, la clave se libera', fresh.status === 202, js(fresh));
      check('BJ-7: y es un trabajo nuevo', fresh.json.id !== id);`);
  test('BJ-8', 'la purga se lleva lo terminado viejo, nunca lo que está en marcha', `      const old = await submit(${js(body(item('JHH-0001')))});
      await run(old);
      const recent = await submit(${js(body(item('JHH-0002')))});
      await run(recent);
      const running = await submit(${js(body(item('JHH-0003')))});
      await setTime(old, 'finished_at', new Date(Date.now() - 8 * 86_400_000));
      await setTime(running, 'created_at', new Date(Date.now() - 30 * 86_400_000));
      await jobStore.purge(7);
      check('BJ-8: el terminado hace más de la retención se va', !(await exists(old)));
      check('BJ-8: con sus resultados', (await resultCount(old)) === 0);
      check('BJ-8: el terminado reciente se queda', await exists(recent));
      check('BJ-8: uno en marcha no se purga nunca', await exists(running));`);
  test('BJ-9', 'el sobre es un 400 sin trabajo', `      const before = await jobCount();
      check('BJ-9: el campo que se recorre, ausente', (await post('{}', null)).status === 400);
      const many = await post(JSON.stringify({ items: Array.from({ length: ${maxItems + 1} }, () => ({})) }), null);
      check('BJ-9: más elementos que maxItems', many.status === 400, js(many));
      check('BJ-9: un cuerpo que no se lee', (await post('{"items":', null)).status === 400);
      check('BJ-9: ningún trabajo', (await jobCount()) === before);`);

  return `
// ── Lotes asíncronos (DSL 2.30, fase B): BJ-1 a BJ-9, con el controlador, el procesador y los almacenes emitidos.
{
  const batchProducts = ${adapterOf(product)};
  const timerStore = new ${document ? 'MongoTimerStore' : 'SqlTimerStore'}(tx, new TimerArmedSignal());
  const jobStore = new ${document ? 'MongoBatchJobStore' : 'SqlBatchJobStore'}(tx);
  const settings = { chunkSize: ${PROBE_CHUNK_SIZE}, retentionDays: 7, purgeCron: '0 0 0 * * *' };
  const mediator = new UseCaseMediator(UseCaseContainer.of([new ${operation.handlerClass}(batchProducts)]), tx);
  const batchJobs = new BatchJobs(jobStore, timerStore, tx);
  const job = new ${jobClass}(new BatchJobRunner(jobStore, timerStore, tx, settings), mediator);
  const controller = new ${controller.symbol}(mediator);
  controller.batchJobs = batchJobs;
  const errors = new ApiExceptionFilter();
  const js = (value) => JSON.stringify(value);
${storage(document, engine, product, operation.name)}
  // El llamante: su sujeto es el dueño de lo que crea (el actor de autoría).
  const as = (subject, work) => SecurityContext.runWith({ kind: 'token', name: subject, authorities: new Set(), claims: { sub: subject } }, work);
  // Como lo llama Nest: el status del decorador salvo que el método lo fije en el reply, el cuerpo con el serializador del
  // cable (toWireJson, el de http-platform.ts) y un fallo por el filtro global.
  const call = async (method, args) => {
    const reply = { code: null, headers: {}, status(value) { this.code = value; return this; }, header(key, value) { this.headers[key] = value; return this; } };
    try {
      const answer = await controller[method](...args(reply));
      return { status: reply.code ?? Reflect.getMetadata('__httpCode__', ${controller.symbol}.prototype[method]), location: reply.headers.Location ?? null, json: JSON.parse(toWireJson(answer)) };
    } catch (error) {
      const response = errors.translate(error);
      if (response == null) throw error;
      return { status: response.status, location: null, json: JSON.parse(JSON.stringify(response)) };
    }
  };
  const request = (content, key) => ({ rawBody: content, headers: key == null ? {} : { 'idempotency-key': key }, protocol: 'http', host: 'localhost' });
  const post = (content, key) => call(${js(name)}, (reply) => [request(content, key), reply]);
  const get = (id) => call(${js(`${name}Job`)}, () => [{ jobId: id }]);
  const results = (id, query) => call(${js(`${name}JobResults`)}, () => [{ jobId: id }, query]);
  const submit = async (content) => {
    const answer = await post(content, null);
    if (answer.status !== 202) throw new Error('el alta: ' + js(answer));
    return answer.json.id;
  };
  const timer = (id) => ({ id: randomUUID(), kind: ${js(batchKind(name))}, entityId: id, dueAt: new Date(), attempts: 0 });
  const fire = (id) => job.handle(timer(id), new Date());
  const run = async (id) => {
    for (let shot = 0; shot < 100; shot++) if ((await fire(id)).done) return;
    throw new Error('el trabajo no termina');
  };
  // El almacén de una réplica que cae al escribir el resultado del elemento index.
  const crashingAt = (index) => {
    const crashing = Object.create(jobStore);
    crashing.insertResult = async (jobId, at, ...rest) => {
      if (at === index) throw new Error('sonda: la réplica cae');
      return jobStore.insertResult(jobId, at, ...rest);
    };
    return crashing;
  };
  const summaryIs = (json, total, succeeded, failed, notAttempted) => js(json?.summary) === js({ total, succeeded, failed, notAttempted });
  const resultIs = (page, index, status, code) => {
    const element = (page.items ?? []).find((candidate) => candidate.index === index);
    return element != null && element.status === status && (code == null || element.error === code);
  };
  const UNDECLARED_FAILURE_NAME = ${js(UNDECLARED_FAILURE_NAME)};
${lines.join('\n')}
}
`;
}
