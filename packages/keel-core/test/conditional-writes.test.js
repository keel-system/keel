// La escritura condicional (DSL 2.25, src/lib/gen/conditional-writes.js): qué escrituras comparan If-Match, qué
// lecturas dan el ETag y qué handlers devuelven Versioned<T>. La derivación tiene dos entradas —las capas, para keel
// validate, y el modelo, para los generadores— y aquí se comprueba que dicen lo mismo en todas las fixtures y en los
// diseños derivados de test/helpers/conditional-write-designs.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import {
  CW_CASES,
  CW_SABOTAGES,
  PRECONDITION_ORDER,
  conditionalWriteErrors,
  conditionalWriteGateRows,
  conditionalWriteNote,
  conditionalWritesFrontierErrors,
  conditionalWritesOf,
  conditionalWritesOfLayers,
  etagReader,
  returnsVersioned,
  undecidedConditionalWrites,
  usesConditionalWrites,
  versionOf
} from '../src/lib/gen/conditional-writes.js';
import { conditionalWriteCases } from '../src/lib/gen/api-cases.js';
import { FRAMEWORK_ERRORS } from '../src/lib/framework-errors.js';
import { CONDITIONAL_WRITE_DESIGNS } from './helpers/conditional-write-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');
const FIXTURES = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

function designOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return { manifest, layers, model: buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }) };
}

const derived = (name) => {
  const design = CONDITIONAL_WRITE_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, design.mutate);
};
const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);

test('catalog-conditional: las dos escrituras listadas, su lectura derivada y quién devuelve la versión', () => {
  const { model, layers } = derived('catalog-conditional');
  const plan = conditionalWritesOf(model);
  assert.equal(plan.policy, 'required');
  assert.deepEqual(plan.writes, [
    { name: 'updateProduct', root: 'Product', echoes: true },
    { name: 'retireProduct', root: 'Product', echoes: true }
  ]);
  // getProductBySlug es la única query con endpoint que devuelve UN Product: las demás son lista o página.
  assert.deepEqual(plan.readers, [{ name: 'getProductBySlug', root: 'Product' }]);
  assert.deepEqual(plan.problems, []);
  assert.ok(etagReader(model, operationOf(model, 'getProductBySlug')));
  assert.ok(!etagReader(model, operationOf(model, 'listProducts')));
  assert.ok(returnsVersioned(model, operationOf(model, 'updateProduct')));
  assert.ok(!returnsVersioned(model, operationOf(model, 'addProductImage')), 'no listada: no devuelve Versioned');
  assert.deepEqual(versionOf(model, 'Product'), { field: 'lockVersion', declared: false });
  assert.deepEqual(checkCrossRefs({ layers }).errors, []);
});

test('las dos entradas de la derivación dicen lo mismo, en todas las fixtures y en los derivados', () => {
  const designs = [
    ...FIXTURES.map((fixture) => [fixture, designOf(fixture)]),
    ...CONDITIONAL_WRITE_DESIGNS.map((design) => [design.name, derived(design.name)])
  ];
  for (const [name, { layers, model }] of designs) {
    assert.deepEqual(conditionalWritesOf(model), conditionalWritesOfLayers(layers), name);
  }
  // Y solo la declara catalog-extended (la corrida de control, incremento 6 del plan), sobre la edición de la ficha.
  for (const fixture of FIXTURES) assert.equal(usesConditionalWrites(designOf(fixture).model), fixture === 'catalog-extended', fixture);
  assert.deepEqual(conditionalWritesOf(designOf('catalog-extended').model).writes.map((write) => write.name), ['updateProduct']);
});

test('la versión de la raíz con declared es un campo del dominio, y sin versión no hay escritura condicional', () => {
  const { model } = designOf('catalog-extended', (layers) => {
    layers.persistence.consistency = { ...layers.persistence.consistency, optimisticLocking: 'declared' };
    layers.domain.entities.Product.fields.lockVersion = { type: 'int', generated: true, description: 'Versión del producto.' };
    layers.api.concurrency = { conditionalWrites: 'optional', operations: ['updateProduct'] };
  });
  assert.deepEqual(versionOf(model, 'Product'), { field: 'lockVersion', declared: true });
  assert.equal(conditionalWritesOf(model).policy, 'optional');

  const { model: unversioned } = designOf('catalog-extended', (layers) => {
    layers.persistence.consistency = { ...layers.persistence.consistency, optimisticLocking: 'none' };
    layers.api.concurrency = { conditionalWrites: 'required', operations: ['updateProduct'] };
  });
  assert.deepEqual(conditionalWritesOf(unversioned).problems, [{ operation: 'updateProduct', kind: 'unversioned', root: 'Product' }]);
  assert.equal(usesConditionalWrites(unversioned), false);
});

test('none no deriva nada; sin concurrency, el PATCH sobre una raíz con versión es la pregunta abierta', () => {
  const { model } = designOf('catalog-extended', (layers) => {
    layers.api.concurrency = { conditionalWrites: 'none' };
  });
  assert.equal(conditionalWritesOf(model), null);
  const { layers } = designOf('catalog-extended', (l) => {
    delete l.api.concurrency;
  });
  // updateProduct (PATCH /products/{id}); retireProduct es un POST de transición y no abre la pregunta por defecto.
  assert.deepEqual(undecidedConditionalWrites(layers), [{ operation: 'updateProduct', root: 'Product', method: 'PATCH' }]);
  const decided = designOf('catalog-extended', (l) => {
    l.api.concurrency = { conditionalWrites: 'none' };
  });
  assert.deepEqual(undecidedConditionalWrites(decided.layers), []);
});

test('los errores salen de la lista cerrada, con su override por errors', () => {
  const { model } = derived('catalog-conditional');
  const errors = conditionalWriteErrors(model);
  assert.equal(errors.failed.code, FRAMEWORK_ERRORS.preconditionFailed.code);
  assert.equal(errors.failed.status, 412);
  assert.equal(errors.required.code, FRAMEWORK_ERRORS.preconditionRequired.code);
  assert.equal(errors.required.status, 428);
  const { model: overridden } = designOf('catalog-extended', (layers) => {
    layers.api.concurrency = { conditionalWrites: 'required', operations: ['updateProduct'] };
    layers['use-cases'].operations.updateProduct.errors.push({ code: 'PRODUCT_VERSION_MISMATCH', when: 'Otro guardó antes.', http: 412 });
  });
  assert.equal(conditionalWriteErrors(overridden).failed.code, 'PRODUCT_VERSION_MISMATCH');
  // D3: el 428 sale antes que la validación del cuerpo y el 404 antes que el 412.
  assert.ok(PRECONDITION_ORDER.indexOf(428) < PRECONDITION_ORDER.indexOf(400));
  assert.ok(PRECONDITION_ORDER.indexOf(404) < PRECONDITION_ORDER.indexOf(412));
  assert.ok(PRECONDITION_ORDER.indexOf(412) < PRECONDITION_ORDER.indexOf(409));
});

test('la nota del handler y las filas del gate', () => {
  const { model } = derived('catalog-conditional');
  const args = { read: 'command.expectedVersions()', load: 'products.loadExpecting(id, expected)', versioned: 'Versioned<Dto>' };
  const update = conditionalWriteNote(model, operationOf(model, 'updateProduct'), args);
  assert.match(update, /products\.loadExpecting\(id, expected\)/);
  assert.match(update, /versión que deja el guardado/);
  assert.match(conditionalWriteNote(model, operationOf(model, 'getProductBySlug'), args), /Versioned<Dto>/);
  assert.equal(conditionalWriteNote(model, operationOf(model, 'listProducts'), args), null);
  assert.deepEqual(
    conditionalWriteGateRows(model).map((row) => [row.operation, row.handlerClass, row.marker]),
    [
      ['updateProduct', 'UpdateProductCommandHandler', 'loadExpecting'],
      ['retireProduct', 'RetireProductCommandHandler', 'loadExpecting']
    ]
  );
});

test('las peticiones de la prueba emitida (CW-6 a CW-10)', () => {
  const { model } = derived('catalog-conditional');
  const cases = conditionalWriteCases(model);
  assert.deepEqual(cases.write, { method: 'PATCH', url: '/api/v1/products/0192f1d2-0000-7000-8000-000000000001', operation: 'updateProduct' });
  assert.equal(cases.reader.operation, 'getProductBySlug');
  assert.equal(cases.required, true);
  assert.equal(cases.exposedHeader, 'ETag');
  assert.equal(cases.errors.failed.status, 412);
  assert.equal(conditionalWriteCases(designOf('catalog-extended', (layers) => delete layers.api.concurrency).model), null);
});

test('la frontera neutral: escritura condicional con Idempotency-Key no se genera todavía (T3)', () => {
  const { layers } = derived('catalog-conditional');
  assert.deepEqual(conditionalWritesFrontierErrors(layers, 'keel-x'), []);
  layers['use-cases'].operations.updateProduct.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  const [message] = conditionalWritesFrontierErrors(layers, 'keel-x');
  assert.match(message, /operations\.updateProduct/);
  assert.match(message, /keel-x/);
});

test('los casos y los sabotajes: ids únicos, y cada sabotaje cae en casos que existen', () => {
  const ids = CW_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 12);
  const sabotages = CW_SABOTAGES.map((entry) => entry.id);
  assert.equal(new Set(sabotages).size, sabotages.length);
  for (const sabotage of CW_SABOTAGES) {
    for (const id of sabotage.falls) assert.ok(ids.includes(id), `${sabotage.id}: ${id}`);
  }
});

test('el derivado documental valida igual y deriva lo mismo', () => {
  const relational = derived('catalog-conditional');
  const document = derived('catalog-conditional-mongo');
  assert.deepEqual(checkCrossRefs({ layers: document.layers }).errors, []);
  assert.deepEqual(conditionalWritesOf(document.model).writes, conditionalWritesOf(relational.model).writes);
});
