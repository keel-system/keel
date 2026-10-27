// `infra/fixtures.sql` (el estado de partida de los escenarios, de `fixtures.yaml`) contra el ESQUEMA que emiten keel-dotnet
// y keel-spring para el mismo diseño. El SQL lo escribe keel-core/gen/fixtures.js sin mirar a ningún generador, así que
// lo que se mide aquí es que su lectura del modelo sea la de los generadores: toda tabla y columna que nombra existe, y
// no deja fuera ninguna columna NOT NULL (si no, el primer INSERT moriría en el reset de cada flujo). Lo que el motor
// hace con él lo juzgan el reset en vivo y la paridad de keel-recover.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springSchema } from '../../keel-spring/test/helpers/schema-table.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { dotnetSchema } from './helpers/schema.js';

const UUID = (n) => `0190c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;

// Una relación a-uno entre raíces, una autorreferencia, un enum, una sombra plegada (catalog-extended) y un value
// object aplanado (product-catalog).
const CASES = {
  'catalog-extended': {
    kind: 'fixtures',
    schema: 1,
    entities: {
      Product: { records: [{ id: UUID(3), sku: 'TEA-0001', name: 'Té verde', status: 'active', category: UUID(2) }] },
      Category: {
        reference: true,
        records: [
          { id: UUID(1), slug: 'Bebidas', name: 'Bebidas', parent: null },
          { id: UUID(2), slug: 'Tes', name: 'Tés', parent: UUID(1) }
        ]
      }
    }
  },
  'product-catalog': {
    kind: 'fixtures',
    schema: 1,
    entities: { Product: { records: [{ id: UUID(9), sku: 'ABC-0001', name: 'Lámpara', price: { amount: 12.5, currency: 'EUR' }, status: 'draft' }] } }
  }
};

const inserts = (sql) =>
  [...sql.matchAll(/^INSERT INTO (\S+) \(([^)]*)\) VALUES \((.*)\);$/gm)].map((m) => ({ table: m[1].replace(/[`"]/g, ''), columns: m[2].split(', ').map((c) => c.replace(/[`"]/g, '')) }));

for (const [name, doc] of Object.entries(CASES)) {
  test(`${name}: fixtures.sql nombra las tablas y columnas del esquema emitido, sin dejarse una NOT NULL`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const files = planService({ manifest, layers, fixtures: doc, workspace: FIXTURES_DIR }).files;
    const sql = files.find((file) => file.path === 'infra/fixtures.sql')?.content;
    assert.ok(sql, 'build emite infra/fixtures.sql');
    const reset = files.find((file) => file.path === 'infra/reset-db.sh').content;
    assert.match(reset, /exec -i .* < "\$\(dirname "\$0"\)\/fixtures\.sql"/, 'reset-db.sh lo carga tras vaciar');
    const schemas = { 'keel-dotnet': dotnetSchema(files), 'keel-spring': springSchema(planSpring({ manifest, layers, fixtures: doc, workspace: FIXTURES_DIR }).files) };
    const rows = inserts(sql);
    assert.equal(rows.length, Object.values(doc.entities).reduce((total, block) => total + block.records.length, 0));
    for (const [generator, schema] of Object.entries(schemas)) {
      for (const row of rows) {
        const table = schema.get(row.table);
        assert.ok(table, `${generator}: la tabla ${row.table} existe`);
        for (const column of row.columns) assert.ok(table.columns.has(column), `${generator}: ${row.table}.${column} existe`);
        const required = [...table.columns].filter(([, spec]) => !spec.nullable).map(([column]) => column);
        for (const column of required) assert.ok(row.columns.includes(column), `${generator}: ${row.table}.${column} es NOT NULL y el INSERT no lo trae`);
      }
    }
    // El orden de carga: la categoría padre antes que la hija, y las dos antes que el producto que las nombra.
    if (name === 'catalog-extended') assert.deepEqual(rows.map((row) => row.table), ['categories', 'categories', 'products']);
  });
}

test('sin fixtures no hay fixtures.sql ni paso de carga', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const files = planService({ manifest, layers, workspace: FIXTURES_DIR }).files;
  assert.equal(files.some((file) => file.path === 'infra/fixtures.sql'), false);
  assert.doesNotMatch(files.find((file) => file.path === 'infra/reset-db.sh').content, /fixtures\.sql/);
});
