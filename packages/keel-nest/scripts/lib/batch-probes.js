// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) contra lo emitido, para db-check y doc-check: BA-1 a BA-7
// de keel-core/gen/batch.js, con los ids que ejecuta keel-spring (batch-check) sobre los MISMOS diseños
// (keel-core/test/helpers/batch-designs.js). Dos cosas se escriben dentro del sujeto, y no forman parte del proyecto:
//
//   · el HANDLER de `importProducts`, en el lugar del stub (batchProbePatch): lo que escribiría el agente para UN
//     elemento —un nombre «BOOM» es un fallo que ningún diseño declara—. A diferencia de la sonda de keel-spring, no
//     busca el sku antes de guardar: el duplicado lo rechaza la UNICIDAD del motor y lo traduce el filtro al error que el
//     diseño declara. Así el duplicado envenena la transacción donde el motor lo hace (PostgreSQL, MongoDB), que es lo
//     único que distingue en keel-nest una transacción por elemento de una para el lote (ver BATCH_ONE_TX);
//   · el bloque de la sonda: el controlador emitido con su mediator y el almacén real, llamado como lo llama Nest
//     (params, query, cuerpo ya leído, reply). Lo que se mide es lo que build pone alrededor del handler: el sobre, el
//     bucle, la transacción por elemento, la lectura de cada elemento y la respuesta, y lo que quedó en la base.
//
// El status de un lote por elemento lo fija el decorador `@HttpCode` y no el desenlace, así que solo BA-1 lo lee (de su
// metadato, como lo lee Nest); los demás casos miran el cuerpo y la base, y BA-3 que no salga un 400 del lote.

import { BATCH_CASES, BATCH_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { controllerClasses } from '../../src/scaffold/controllers.js';
import { CONTAINER_TS, MEDIATOR_TS } from '../../src/scaffold/mediator.js';
import { handlerPath } from '../../src/scaffold/services.js';
import { EXCEPTION_FILTER_TS } from '../../src/scaffold/rest-support.js';
import { quoteIdentifierFor } from '@keel-system/keel-core/gen/relational';

const js = (value) => JSON.stringify(value);

/** Lo que el nombre de un elemento pide al handler de la sonda: fallar con algo que el diseño no declara (BA-4). */
export const UNDECLARED_FAILURE_NAME = 'BOOM';

/** Las operaciones por lotes del modelo. */
export const batchOperations = (model) => model.services.flatMap((service) => service.operations).filter((operation) => operation.batch);

/** Los casos que ejecuta este diseño: los mismos que keel-spring (batch-parity.test.js lo compara). */
export function batchCases(model) {
  const atomicities = new Set(batchOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5');
  if (atomicities.has('all-or-nothing')) ids.push('BA-6');
  if (atomicities.size > 0) ids.push('BA-7');
  return BATCH_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const BATCH = /infrastructure[\\/]rest[\\/]batch\.ts$/;
const CONTROLLER = /infrastructure[\\/]rest[\\/]controllers[\\/][\w-]+\.ts$/;

const SAME = (spec) => ({ relational: spec, document: spec });

/** El texto que se busca y se sustituye en lo emitido, por sabotaje y por almacén (relational | document). */
export const BATCH_SABOTAGE_SPECS = {
  // El lote entero en UNA transacción: los despachos se unen a ella (el mediator no abre otra si hay una en curso).
  'ba-one-tx': SAME([CONTROLLER, /return perItem\((.*)\);/g, "return this.mediator['transactions'].inTransaction(() => perItem($1));"]),
  // Un elemento mal formado tumba el lote entero con un 400, como si el borde validara el DTO completo.
  'ba-validate-whole': SAME([BATCH, 'results.push(BatchItem.failed(index, VALIDATION_ERROR, (error as InvalidItem).message));\n      continue;', 'throw new MalformedRequestError();']),
  // Un fallo que no es de su elemento no detiene el lote.
  'ba-continue-on-undeclared': SAME([BATCH, 'stopped = true;', 'stopped = false;']),
  // El lote por elemento responde 200: el status deja de ser el del método.
  'ba-status': SAME([CONTROLLER, '@HttpCode(207)', '@HttpCode(200)']),
  // all-or-nothing sin la transacción que abarca el lote: cada elemento se confirma en la suya.
  'ba-atomic-no-tx': SAME([BATCH, 'await transactions.inTransaction(() => work())', 'await work()'])
};

export const isBatchSabotage = (id) => Boolean(BATCH_SABOTAGE_SPECS[id]);

/**
 * Dónde cae `ba-one-tx` en keel-nest, por motor. En keel-spring una transacción del lote cae también en BA-4, porque el
 * fallo de un elemento la marca para revertir; en TypeORM y en el driver de MongoDB un error capturado no marca nada, y
 * lo único que tumba la transacción del lote es un duplicado que el MOTOR rechaza dentro de ella: PostgreSQL y MongoDB
 * abortan la transacción entera, y su commit falla (BA-2, BA-5). MySQL no: tras un duplicado la transacción sigue viva y
 * el lote se confirma igual, así que en MySQL una transacción para el lote no es observable desde fuera y el sabotaje
 * no se mide ahí (`[]`: el veredicto lo dice en voz alta en vez de pasar en verde).
 */
export const BATCH_ONE_TX = { postgresql: ['BA-2', 'BA-5'], mongodb: ['BA-2', 'BA-5'], mysql: [] };

/** Lo que tiene que caer con un sabotaje en este diseño y este motor: sus casos que el bloque ejecuta, y solo esos. */
export function batchSabotageVerdict(checks, id, model, engine) {
  const cases = batchCases(model);
  const declared = id === 'ba-one-tx' ? BATCH_ONE_TX[engine] : BATCH_SABOTAGES[id];
  const want = declared.filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^BA-\d+:/.test(check.name)).map((check) => /^(BA-\d+):/.exec(check.name)[1]))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want, unmeasured: want.length === 0 && cases.some((caseId) => BATCH_SABOTAGES[id].includes(caseId)) };
}

// ─── El handler de la sonda ──────────────────────────────────────────────────────────────────────────────────────

/** El handler de la sonda en el lugar del stub de `importProducts`; el resto de archivos, tal cual. */
export function batchProbePatch(model, file) {
  const operation = batchOperations(model)[0];
  if (!operation || file.path !== handlerPath(operation)) return file.content;
  const result = operation.batch.resultFields.length > 0;
  const returnType = result ? operation.responseDto.name : 'void';
  const dto = result ? `import { ${returnType} } from '../dtos/${fileOf(returnType)}.js';\n` : '';
  return `import { ProductRepository } from '../../domain/repository/product-repository.js';
import { Product } from '../../domain/aggregate/product.js';
import { ProductStatus } from '../../domain/enums/product-status.js';
import { Uuids } from '../../domain/identity/uuids.js';
import { ApplicationComponent, Handles } from '../annotations/application-component.js';
import { ${operation.messageClass} } from '../commands/${fileOf(operation.messageClass)}.js';
${dto}import type { ${result ? 'ReturningCommandHandler' : 'CommandHandler'} } from '../interfaces/handlers.js';

/** La sonda de db-check y doc-check: lo que escribiría el agente para UN elemento. */
@ApplicationComponent()
@Handles(${operation.messageClass})
export class ${operation.handlerClass} implements ${result ? `ReturningCommandHandler<${operation.messageClass}, ${returnType}>` : `CommandHandler<${operation.messageClass}>`} {
  static readonly inject = [ProductRepository] as const;

  constructor(private readonly productRepository: ProductRepository) {}

  async handle(command: ${operation.messageClass}): Promise<${returnType}> {
    const draft = command.item;
    if (draft.name === ${js(UNDECLARED_FAILURE_NAME)}) throw new Error('sonda: un fallo que el diseño no declara');
    // Sin buscar el sku antes: el duplicado lo rechaza la unicidad del motor, y el filtro lo traduce al error declarado.
    const saved = await this.productRepository.save(
      new Product({ id: Uuids.v7(), sku: draft.sku, name: draft.name, notes: null, price: draft.price, apiToken: 'sonda', status: ProductStatus.DRAFT, lockVersion: null })
    );
    ${result ? `return new ${returnType}({ productId: saved.id });` : 'void saved;'}
  }
}
`;
}

const fileOf = (className) => className.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

const item = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });

/**
 * El bloque de los lotes, con `check` y `tx` del script de la sonda y su almacén (`dataSource` o `database`). `adapterOf`
 * da el adaptador de la raíz Product.
 */
export function batchBlock(model, ctx, { document, engine, adapterOf }) {
  const operations = batchOperations(model);
  if (operations.length === 0) return '';
  const cases = new Set(batchCases(model));
  const product = model.entities.find((entity) => entity.name === 'Product');
  const service = model.services.find((candidate) => candidate.operations.includes(operations[0]));
  const controller = controllerClasses(model).find((entry) => entry.symbol === service.controllerClass);
  const dist = (symbol, file) => ctx.imports.add(`${symbol}|${file}`);
  dist('UseCaseContainer', CONTAINER_TS);
  dist('UseCaseMediator', MEDIATOR_TS);
  dist('ApiExceptionFilter', EXCEPTION_FILTER_TS);
  dist(controller.symbol, controller.from);
  for (const operation of operations) dist(operation.handlerClass, handlerPath(operation));
  const table = document ? null : quoteIdentifierFor(engine, product.tableName);
  const clear = document ? `await database.collection(${js(product.collectionName)}).deleteMany({})` : `await dataSource.query(${js(`DELETE FROM ${table}`)})`;
  const count = document
    ? `await database.collection(${js(product.collectionName)}).countDocuments({})`
    : `Number((await dataSource.query(${js(`SELECT COUNT(*) AS n FROM ${table}`)}))[0].n)`;
  const perItem = operations.find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const body = (...items) => js({ items });
  const lines = [];
  const test = (id, title, code) => {
    if (!cases.has(id)) return;
    lines.push(`  // ${id}: ${title}
  try {
    ${clear};
${code}
  } catch (error) {
    check(${js(`${id}: ${title}`)}, false, error?.stack ?? error);
  }`);
  };
  if (perItem) {
    const post = (items) => `await batchPost(${js(perItem.name)}, ${items})`;
    test('BA-1', 'sin fallos, 207 con todos succeeded y su result en orden', `    const answer = ${post(body(item('AAA-0001'), item('AAA-0002'), item('AAA-0003')))};
    check('BA-1: un lote per-item responde 207 también si todo salió bien', answer.status === 207, answer.status);
    check('BA-1: el resumen', summaryIs(answer.json, 3, 3, 0, 0), js(answer.json.summary));
    check('BA-1: en orden de índice, succeeded y con el result de batch.output',
      answer.json.items.every((element, index) => element.index === index && element.status === 'succeeded' && typeof element.result?.productId === 'string' && stable(element)), js(answer.json.items));`);
    test('BA-2', 'un error de itemErrors falla solo su elemento', `    await ${post(body(item('BBB-0001')))};
    check('BA-2: la siembra', await batchProducts.findBySku('BBB-0001') != null);
    const answer = ${post(body(item('BBB-0001'), item('BBB-0002')))};
    check('BA-2: el resumen', summaryIs(answer.json, 2, 1, 1, 0), js(answer.json));
    check('BA-2: el duplicado falla con su code', failedWith(answer.json.items?.[0], 'SKU_ALREADY_EXISTS'), js(answer.json.items?.[0]));
    check('BA-2: el siguiente quedó confirmado', answer.json.items?.[1]?.status === 'succeeded' && await batchProducts.findBySku('BBB-0002') != null);`);
    test('BA-3', 'un elemento mal formado es su failed con VALIDATION_ERROR', `    const answer = ${post(body(item('CCC-0001'), item('mal'), item('CCC-0003', 'x'.repeat(121)), null, item('CCC-0005')))};
    check('BA-3: un elemento mal formado no es un 400 del lote', answer.status !== 400 && summaryIs(answer.json, 5, 2, 3, 0), \`\${answer.status} \${js(answer.json)}\`);
    check('BA-3: el formato del sku, la cota del nombre y un null', [1, 2, 3].every((index) => failedWith(answer.json.items?.[index], 'VALIDATION_ERROR')), js(answer.json.items));
    check('BA-3: la guarda del value object es el message', /sku/.test(answer.json.items?.[1]?.message ?? ''), answer.json.items?.[1]?.message);
    check('BA-3: el siguiente quedó confirmado', await batchProducts.findBySku('CCC-0005') != null);`);
    test('BA-4', 'un error no declarado detiene el lote', `    const answer = ${post(body(item('DDD-0001'), item('DDD-0002', UNDECLARED_FAILURE_NAME), item('DDD-0003')))};
    check('BA-4: detener el lote no es un error del lote: el resumen', summaryIs(answer.json, 3, 1, 1, 1), js(answer.json));
    check('BA-4: el que lo detiene sale BATCH_ABORTED', failedWith(answer.json.items?.[1], 'BATCH_ABORTED'), js(answer.json.items?.[1]));
    check('BA-4: lo siguiente no se intenta', answer.json.items?.[2]?.status === 'notAttempted' && stable(answer.json.items[2]), js(answer.json.items?.[2]));
    check('BA-4: lo anterior queda confirmado', await batchProducts.findBySku('DDD-0001') != null);
    check('BA-4: lo siguiente no se procesó', await batchProducts.findBySku('DDD-0003') == null);`);
    test('BA-5', 'la misma clave dos veces en el lote falla en el segundo', `    const answer = ${post(body(item('EEE-0001'), item('EEE-0001')))};
    check('BA-5: el primero entra', answer.json.items?.[0]?.status === 'succeeded', js(answer.json));
    check('BA-5: el segundo choca con el primero, ya confirmado', failedWith(answer.json.items?.[1], 'SKU_ALREADY_EXISTS'), js(answer.json.items?.[1]));
    check('BA-5: el primero quedó confirmado', await batchProducts.findBySku('EEE-0001') != null);`);
    test('BA-7', 'el sobre: el campo ausente y exceder maxItems son un 400 del lote', envelope(perItem));
  }
  if (atomic) {
    const post = (items) => `await batchPost(${js(atomic.name)}, ${items})`;
    test('BA-6', 'all-or-nothing revierte entero y responde el error del culpable', `    const failed = ${post(body(item('FFF-0001'), item('FFF-0002'), item('FFF-0001')))};
    check('BA-6: el error del elemento culpable', failed.status === 409 && failed.json.code === 'SKU_ALREADY_EXISTS', js(failed));
    check('BA-6: la ruta del culpable en details', failed.json.details?.[0] === 'items[2]', js(failed.json.details));
    check('BA-6: no queda nada confirmado', await batchProducts.findBySku('FFF-0001') == null && await batchProducts.findBySku('FFF-0002') == null);
    const invalid = ${post(body(item('FFF-0003'), item('mal')))};
    check('BA-6: un elemento mal formado es el 400 del culpable', invalid.status === 400 && invalid.json.details?.[0] === 'items[1]', js(invalid));
    check('BA-6: tampoco queda el anterior', await batchProducts.findBySku('FFF-0003') == null);
    const good = ${post(body(item('FFF-0004'), item('FFF-0005')))};
    check('BA-6: sin fallos, el successStatus del endpoint', good.status === ${atomic.route.status} && summaryIs(good.json, 2, 2, 0, 0), js(good));`);
    if (!perItem) test('BA-7', 'el sobre: el campo ausente y exceder maxItems son un 400 del lote', envelope(atomic));
  }

  function envelope(operation) {
    return `    const absent = await batchPost(${js(operation.name)}, {});
    check('BA-7: el campo que se recorre, ausente', absent.status === 400, js(absent));
    const many = await batchPost(${js(operation.name)}, { items: Array.from({ length: ${(operation.batch.maxItems ?? 0) + 1} }, () => ({})) });
    check('BA-7: más elementos que maxItems', many.status === 400, many.status);
    check('BA-7: un 400 del sobre no procesa ningún elemento', ${count} === 0);`;
  }

  return `
// ── Lotes (DSL 2.30): BA-1 a BA-7, con el controlador, el mediator y el almacén emitidos.
{
  const batchProducts = ${adapterOf(product)};
  const batchMediator = new UseCaseMediator(UseCaseContainer.of([${operations.map((operation) => `new ${operation.handlerClass}(batchProducts)`).join(', ')}]), tx);
  const batchController = new ${controller.symbol}(batchMediator, tx);
  const batchErrors = new ApiExceptionFilter();
  const UNDECLARED_FAILURE_NAME = ${js(UNDECLARED_FAILURE_NAME)};
  // Como lo llama Nest: el cuerpo ya leído, el status del decorador salvo que el método lo fije en el reply, y un fallo
  // traducido por el filtro global.
  const batchPost = async (method, content) => {
    const reply = { code: null, status(value) { this.code = value; return this; }, header() { return this; } };
    const body = typeof content === 'string' ? JSON.parse(content) : content;
    try {
      const answer = await batchController[method]({}, {}, body, reply);
      return { status: reply.code ?? Reflect.getMetadata('__httpCode__', ${controller.symbol}.prototype[method]), json: JSON.parse(JSON.stringify(answer)) };
    } catch (error) {
      const response = batchErrors.translate(error);
      if (response == null) throw error;
      return { status: response.status, json: JSON.parse(JSON.stringify(response)) };
    }
  };
  const summaryIs = (json, total, succeeded, failed, notAttempted) =>
    js(json?.summary) === js({ total, succeeded, failed, notAttempted });
  const js = (value) => JSON.stringify(value);
  const stable = (element) => ['index', 'status', 'result', 'error', 'message'].every((key) => element != null && key in element);
  const failedWith = (element, code) => element?.status === 'failed' && element.error === code && element.result === null && stable(element);
${lines.join('\n')}
}
`;
}
