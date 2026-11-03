// `infra/fixtures.sql` (el estado de partida de los escenarios, de `fixtures.yaml`) contra el ESQUEMA que emite keel-go. El SQL
// lo escribe keel-core/gen/fixtures.js sin mirar a ningún generador, así que lo que se mide aquí es que su lectura del modelo
// sea la de keel-go: toda tabla y columna que nombra existe, y no deja fuera ninguna columna NOT NULL. Y que `build` lo
// recibe: hasta el incremento 16 se descartaba en silencio, y shop-api se generaba sin su estado de partida.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { build } from '../src/commands/build.js';
import { check } from '../src/commands/check.js';
import { FIXTURES_DIR, makeWorkspace, mountDesign, runCommand } from './helpers/workspace.js';
import { goSchema } from './helpers/schema.js';
import fs from 'node:fs';

const UUID = (n) => `0190c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;

// Una relación a-uno entre raíces, una autorreferencia, un enum, una sombra plegada (catalog-extended) y un value object
// aplanado (product-catalog): los casos de keel-dotnet.
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
  for (const database of ['postgresql', 'mysql']) {
    test(`${name} (${database}): fixtures.sql nombra las tablas y columnas de la baseline, sin dejarse una NOT NULL`, () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const { files } = planService({ manifest, layers, fixtures: doc, workspace: FIXTURES_DIR, stack: { database } });
      const sql = files.find((file) => file.path === 'infra/fixtures.sql')?.content;
      assert.ok(sql, 'build emite infra/fixtures.sql');
      assert.match(files.find((file) => file.path === 'infra/reset-db.sh').content, /exec -i .* < "\$\(dirname "\$0"\)\/fixtures\.sql"/, 'reset-db.sh lo carga tras vaciar');
      const schema = goSchema(files);
      const rows = inserts(sql);
      assert.equal(rows.length, Object.values(doc.entities).reduce((total, block) => total + block.records.length, 0));
      for (const row of rows) {
        const table = schema.get(row.table);
        assert.ok(table, `la tabla ${row.table} existe`);
        for (const column of row.columns) assert.ok(table.columns.has(column), `${row.table}.${column} existe`);
        for (const [column, spec] of table.columns) {
          if (!spec.nullable) assert.ok(row.columns.includes(column), `${row.table}.${column} es NOT NULL y el INSERT no lo trae`);
        }
      }
      if (name === 'catalog-extended') assert.deepEqual(rows.map((row) => row.table), ['categories', 'categories', 'products']);
    });
  }
}

test('sin fixtures no hay fixtures.sql ni paso de carga', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR });
  assert.equal(files.some((file) => file.path === 'infra/fixtures.sql'), false);
  assert.doesNotMatch(files.find((file) => file.path === 'infra/reset-db.sh').content, /fixtures\.sql/);
});

test('build y check llevan el fixtures.yaml del diseño hasta el proyecto: shop-api sale con su estado de partida', async () => {
  const workspace = makeWorkspace('keel-go-fixtures-yaml-');
  const dir = mountDesign(workspace, 'shop-api');
  const checked = await runCommand(workspace, check, dir);
  assert.doesNotMatch(checked.output, /no puede construir/, checked.output);
  const built = await runCommand(workspace, build, dir, { acceptUnready: true, yes: true });
  assert.ok(built.exitCode === undefined || built.exitCode === 0, built.output);
  const project = path.join(workspace, 'services', 'shop-api-go');
  assert.ok(fs.existsSync(path.join(project, 'infra', 'fixtures.sql')), 'shop-api se generó sin infra/fixtures.sql');
  assert.match(fs.readFileSync(path.join(project, 'infra', 'reset-db.sh'), 'utf8'), /fixtures\.sql/);
});
