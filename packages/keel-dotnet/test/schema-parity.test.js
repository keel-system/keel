// La PARIDAD DEL ESQUEMA: para cada fixture relacional, las tablas que emite keel-dotnet (el mapeo fluente de EF
// Core) son las que emite keel-spring (anotaciones JPA) — mismas tablas, mismas columnas con la misma nulabilidad,
// cota de texto y escala, los mismos NOMBRES de constraint única, índice y FK, y el mismo predicado en cada índice
// único condicionado.
//
// Es la red sin contenedores, como contract-parity lo es del HTTP: compara lo que EMITEN los dos generadores, no el
// modelo del que salen los dos. El lector de keel-spring es el que usa también la paridad de keel-nest
// (keel-spring/test/helpers/schema-table.js). Lo que el motor hace con ello lo juzga `npm run db-check`.
//
// Una diferencia de forma, no de esquema: las FK entre AGREGADOS keel-spring no las anota (no hay asociación entre
// raíces) y las añade al baseline desde infra/export-schema.sh; en EF son parte del modelo, porque el esquema SALE
// del modelo (EnsureCreated y las migraciones). Se comparan contra ese baseline.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springSchema, springCrossAggregateForeignKeys, schemaTable } from '../../keel-spring/test/helpers/schema-table.js';
import { planFixture, FIXTURES_DIR } from './helpers/workspace.js';
import { dotnetSchema } from './helpers/schema.js';

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});

test('hay fixtures relacionales que comparar', () => {
  assert.ok(relational.length >= 6, relational.join(', '));
});

// Las tablas de los mecanismos del generador entran todas: el outbox y los mensajes procesados (incremento 9), el
// registro de idempotencia (7) y la marca del reclamo de reconciliación (11c).

for (const name of relational) {
  test(`${name}: el esquema de keel-dotnet es el de keel-spring`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const springFiles = planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files;
    const spring = springSchema(springFiles);
    for (const [tableName, fks] of springCrossAggregateForeignKeys(springFiles)) for (const fk of fks) schemaTable(spring, tableName).names.add(fk);
    const dotnet = dotnetSchema((await planFixture(name)).files);
    assert.deepEqual([...dotnet.keys()].sort(), [...spring.keys()].sort(), 'las mismas tablas');
    for (const [tableName, want] of spring) {
      const got = dotnet.get(tableName);
      assert.deepEqual([...got.names].sort(), [...want.names].sort(), `${tableName}: los mismos nombres de constraint, índice y FK`);
      assert.deepEqual([...got.columns.keys()].sort(), [...want.columns.keys()].sort(), `${tableName}: las mismas columnas`);
      // El predicado de un índice condicionado, letra a letra: con el literal del diseño en vez de la constante del
      // enum el índice se crea y no casa con ninguna fila.
      assert.deepEqual(Object.fromEntries(got.predicates), Object.fromEntries(want.predicates), `${tableName}: los mismos predicados`);
      for (const [column, spec] of want.columns) {
        const have = got.columns.get(column);
        if (spec.length != null) assert.equal(have.length, spec.length, `${tableName}.${column}: la cota declarada`);
        if (spec.scale != null) assert.equal(have.scale, spec.scale, `${tableName}.${column}: la escala declarada`);
        assert.equal(have.nullable, spec.nullable, `${tableName}.${column}: ${spec.nullable ? 'admite null' : 'NOT NULL'}`);
      }
    }
  });
}

// Ninguna fixture relacional aplana un value object OPCIONAL (solo `Product.price`, obligatorio), así que esa rama
// —sus columnas dejan de ser NOT NULL— se deriva de product-catalog en memoria, como en la paridad de keel-nest.
test('product-catalog con el precio OPCIONAL: sus columnas aplanadas admiten null en los dos', async () => {
  const optionalPrice = (_manifest, layers) => {
    layers.domain.entities.Product.fields.price.required = false;
  };
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  optionalPrice(manifest, layers);
  const spring = springSchema(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files);
  const dotnet = dotnetSchema((await planFixture('product-catalog', { mutate: optionalPrice })).files);
  for (const column of ['price_amount', 'price_currency']) {
    assert.equal(spring.get('products').columns.get(column).nullable, true, `keel-spring: ${column}`);
    assert.equal(dotnet.get('products').columns.get(column).nullable, true, `keel-dotnet: ${column}`);
  }
});
