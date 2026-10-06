// La idempotencia de petición (incremento 10a): build genera el mecanismo —el mismo que keel-spring— y
// el agente escribe el uso. Aquí, sin red: qué se emite y cuándo, que el handler recibe el puerto y la
// nota con el algoritmo, que la cabecera llega al contexto, y la firma canónica EJECUTADA. Lo que solo
// juzga el motor (guardar, encontrar, la carrera, la caducidad, el rollback) lo mide `npm run db-check`;
// la tabla contra la de keel-spring, `schema-parity.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { NEST_READY_DESIGN } from './helpers/workspace.js';

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const MECHANISM = [
  'src/domain/idempotency/idempotency-store.ts',
  'src/domain/idempotency/idempotency-conflict-exception.ts',
  'src/domain/idempotency/idempotency-reuse-exception.ts',
  'src/application/support/command-signature.ts',
  'src/application/support/idempotency-context.ts',
  'src/infrastructure/persistence/entities/idempotency-record-orm.ts',
  'src/infrastructure/persistence/idempotency-store-impl.ts'
];

test('con idempotencia y persistencia, build emite el mecanismo entero; sin persistencia, nada', () => {
  const files = byPath(planFixture(NEST_READY_DESIGN.name).files);
  for (const file of MECHANISM) assert.ok(file in files, file);
  assert.match(files['src/infrastructure/persistence/data-source-options.ts'], /ENTITIES = \[.*IdempotencyRecordOrm/);
  assert.match(files['src/infrastructure/persistence/persistence-module.ts'], /\{ provide: IdempotencyStore, useClass: IdempotencyStoreImpl \}/);
  const bare = byPath(planFixture(NEST_READY_DESIGN.name, { withoutLayers: ['persistence'] }).files);
  for (const file of MECHANISM) assert.equal(bare[file], undefined, file);
});

test('el handler de la operación idempotente recibe el puerto y la nota con el algoritmo; los demás no', () => {
  const files = byPath(planFixture(NEST_READY_DESIGN.name).files);
  // Las notas se parten en líneas de comentario: se juntan para leerlas como texto.
  const create = files['src/application/usecases/create-product-command-handler.ts'].replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(create, /static readonly inject = \[ProductRepository, IdempotencyStore, ProductApplicationMapper\]/);
  assert.match(create, /RECLAMA PRIMERO/);
  assert.match(create, /IdempotencyConflictException \(409 IDEMPOTENCY_KEY_IN_PROGRESS\)/);
  assert.match(create, /NO escribas otro registro/);
  const retire = files['src/application/usecases/retire-product-command-handler.ts'];
  assert.doesNotMatch(retire, /IdempotencyStore/);
});

test('el code del diseño, si nombra el conflicto, es el que lanza el mecanismo', () => {
  const files = byPath(planFixture('catalog-extended').files);
  assert.match(files['src/domain/idempotency/idempotency-conflict-exception.ts'], /code: 'PRODUCT_KEY_IN_PROGRESS'/);
});

test('la cabecera Idempotency-Key llega al contexto de la petición', async () => {
  const files = planFixture(NEST_READY_DESIGN.name).files;
  assert.match(byPath(files)['src/infrastructure/http/http-platform.ts'], /IdempotencyContext\.runWith\(idempotencyKey, done\)/);
  const { IdempotencyContext } = await transpileTree(files).load('src/application/support/idempotency-context.ts');
  assert.equal(IdempotencyContext.get(), null);
  assert.equal(IdempotencyContext.runWith('  clave-1 ', () => IdempotencyContext.get()), 'clave-1');
  assert.equal(IdempotencyContext.runWith(['clave-2', 'otra'], () => IdempotencyContext.get()), 'clave-2');
  assert.equal(IdempotencyContext.runWith('   ', () => IdempotencyContext.get()), null, 'en blanco no abre contexto');
  assert.equal(IdempotencyContext.runWith(undefined, () => IdempotencyContext.get()), null);
});

test('la firma canónica: el orden de las claves no cuenta, el de las listas sí, la escala no, null sí', async () => {
  const tree = transpileTree(planFixture(NEST_READY_DESIGN.name).files);
  const { CommandSignature } = await tree.load('src/application/support/command-signature.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const sig = (value) => CommandSignature.of(value);
  assert.equal(sig({ a: 1, b: 'x' }), sig({ b: 'x', a: 1 }), 'el orden de las propiedades no cambia la firma');
  assert.notEqual(sig({ items: [1, 2] }), sig({ items: [2, 1] }), 'el orden de una lista es contenido');
  assert.equal(sig({ amount: Decimal.parse('1.50') }), sig({ amount: Decimal.parse('1.5') }), '1.50 y 1.5 son el mismo importe');
  assert.notEqual(sig({ amount: Decimal.parse('1.50') }), sig({ amount: Decimal.parse('1.51') }));
  assert.notEqual(sig({ notes: null }), sig({ notes: '~' }), 'null no se confunde con un texto');
  assert.notEqual(sig({ a: 'b,c' }), sig({ a: 'b', c: '' }), 'ningún contenido imita un separador');
  assert.equal(sig({ big: 9007199254740993n }), sig({ big: 9007199254740993n }));
  assert.match(sig({}), /^[0-9a-f]{64}$/);
  // Un método del comando (idempotencyScope) no entra en la firma.
  class Command {
    constructor() {
      this.sku = 'ACM-0001';
    }
    idempotencyScope() {
      return 'createProduct';
    }
  }
  assert.equal(sig(new Command()), sig({ sku: 'ACM-0001' }));
});
