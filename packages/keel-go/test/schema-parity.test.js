// La PARIDAD DEL ESQUEMA: para cada fixture relacional, las tablas de la migración baseline de keel-go son las que emite
// keel-spring (anotaciones JPA y el apéndice de su baseline) —mismas tablas, mismas columnas con la misma nulabilidad,
// cota de texto y escala, los mismos NOMBRES de constraint única, índice y FK, y el mismo predicado en cada índice único
// condicionado—. Es la paridad de keel-dotnet y keel-nest, con el mismo lector de keel-spring
// (keel-spring/test/helpers/schema-table.js). Lo que el motor hace con ello lo juzga go-check, que aplica la migración a
// un PostgreSQL real.
//
// Las dos comparan el diseño tal como keel-go lo genera hoy (sin las capas que su frontera rechaza, y keel-spring sobre
// el mismo). Las tablas de los mecanismos del generador que keel-go todavía no emite se descuentan con su incremento
// (MECHANISM_TABLES): cuando llegue, su fila se borra y la paridad las exige.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springSchema, springCrossAggregateForeignKeys, schemaTable } from '../../keel-spring/test/helpers/schema-table.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { goView } from './helpers/contract.js';
import { goSchema } from './helpers/schema.js';

/** Las tablas de mecanismos de keel-spring que keel-go todavía no genera, con el incremento que las trae. */
const MECHANISM_TABLES = {
  idempotency_record: 'incremento 10 (la idempotencia de petición)',
  reconciliation_claim: 'incremento 11 (la reconciliación)',
  outbox_event: 'incremento 9 (la mensajería)',
  processed_event: 'incremento 9 (la mensajería)'
};

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});

test('hay fixtures relacionales que comparar', () => {
  assert.ok(relational.length >= 8, relational.join(', '));
});

function compare(spring, go) {
  for (const table of Object.keys(MECHANISM_TABLES)) spring.delete(table);
  assert.deepEqual([...go.keys()].sort(), [...spring.keys()].sort(), 'las mismas tablas');
  for (const [tableName, want] of spring) {
    const got = go.get(tableName);
    assert.deepEqual([...got.names].sort(), [...want.names].sort(), `${tableName}: los mismos nombres de constraint, índice y FK`);
    assert.deepEqual([...got.columns.keys()].sort(), [...want.columns.keys()].sort(), `${tableName}: las mismas columnas`);
    // El predicado de un índice condicionado, letra a letra: con el literal del diseño en vez de la constante del enum
    // el índice se crea y no casa con ninguna fila.
    assert.deepEqual(Object.fromEntries(got.predicates), Object.fromEntries(want.predicates), `${tableName}: los mismos predicados`);
    for (const [column, spec] of want.columns) {
      const have = got.columns.get(column);
      if (spec.length != null) assert.equal(have.length, spec.length, `${tableName}.${column}: la cota declarada`);
      if (spec.scale != null) assert.equal(have.scale, spec.scale, `${tableName}.${column}: la escala declarada`);
      assert.equal(have.nullable, spec.nullable, `${tableName}.${column}: ${spec.nullable ? 'admite null' : 'NOT NULL'}`);
    }
  }
}

function springOf(design) {
  const files = planSpring({ ...design, workspace: FIXTURES_DIR }).files;
  const schema = springSchema(files);
  for (const [tableName, fks] of springCrossAggregateForeignKeys(files)) for (const fk of fks) schemaTable(schema, tableName).names.add(fk);
  return schema;
}

for (const name of relational) {
  test(`${name}: el esquema de keel-go es el de keel-spring`, () => {
    const design = goView(name);
    compare(springOf(design), goSchema(planService({ ...design, workspace: FIXTURES_DIR }).files));
  });
}

// Ninguna fixture relacional aplana un value object OPCIONAL (solo `Product.price`, obligatorio), así que esa rama —sus
// columnas dejan de ser NOT NULL— se deriva de product-catalog en memoria, como en las paridades de keel-nest y
// keel-dotnet.
test('product-catalog con el precio OPCIONAL: sus columnas aplanadas admiten null en los dos', () => {
  const design = goView('product-catalog');
  design.layers.domain.entities.Product.fields.price.required = false;
  const spring = springOf(design);
  const go = goSchema(planService({ ...design, workspace: FIXTURES_DIR }).files);
  for (const column of ['price_amount', 'price_currency']) {
    assert.equal(spring.get('products').columns.get(column).nullable, true, `keel-spring: ${column}`);
    assert.equal(go.get('products').columns.get(column).nullable, true, `keel-go: ${column}`);
  }
});
