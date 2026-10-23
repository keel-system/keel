// `fixtures.yaml`: el estado de partida de los escenarios. Que se lea con su schema, que se cruce con las capas (cada
// error con su sitio) y que `keel validate` lo trate como una referencia rota. El SQL que sale de él se mide contra el
// esquema que emiten los generadores en `keel-dotnet/test/fixtures-schema.test.js`, y aquí lo que es neutral: el
// literal de cada motor, el rechazo de lo que todavía no se carga y el paso de `reset-db.sh`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService, validateService } from '../src/index.js';
import { loadFixtures, checkFixtures, FIXTURES_FILE } from '../src/lib/fixtures.js';
import { SPEC_SIDE_FILES } from '../src/lib/spec-files.js';
import { buildModel } from '../src/lib/gen/model.js';
import { fixturesSql, fixturesUnsupported } from '../src/lib/gen/fixtures.js';
import { infraFiles, loadsFixtures } from '../src/lib/gen/infra-scripts.js';
import { STACK_DEFAULTS, DATABASES } from '../src/lib/gen/infra-catalog.js';
import { tmpDir } from './helpers/tmp.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');
const UUID = (n) => `0190c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;

const PROBE = {
  projectSuffix: 'probe',
  service: () => ({}),
  parameterType: () => ({}),
  fieldType: (resolved) => ({ probeType: resolved.name ?? resolved.base }),
  elementType: () => ({}),
  namedType: (name) => ({ probeType: name }),
  namedElement: () => ({}),
  renamed: (name) => ({ probeType: name }),
  typeNameOf: (field) => field?.probeType,
  carryType: (field) => ({ probeType: field.probeType }),
  uploadType: () => ({}),
  uploadValidation: () => ({ validation: [], inputValidation: [] }),
  replicaKey: () => ({}),
  errorBase: () => 'base',
  fieldDetails: () => ({ validation: [], numeric: null, inputValidation: [], inheritedPattern: null, columns: [], elementColumns: [], initializer: null }),
  messages: { lockVersionReserved: () => '', readQueriesRef: () => '', pathParamFallback: () => '', cognitoEmulated: () => '' }
};
const PLATFORM = {
  generator: 'keel-probe',
  historyTable: 'probe_history',
  strayProcess: { comment: '#', hint: '', close: '' },
  schemaRebuiltBy: { relational: 'x', document: 'y' },
  schemaHelp: { relational: '#', document: '#' },
  httpStubsReadme: () => ''
};

const catalog = () => loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
const GOOD = {
  kind: 'fixtures',
  schema: 1,
  entities: {
    Category: { reference: true, records: [{ id: UUID(1), slug: 'Bebidas', name: 'Bebidas', parent: null }] },
    Product: { records: [{ id: UUID(2), sku: 'TEA-0001', name: "Té 'verde'", status: 'active', category: UUID(1) }] }
  }
};
const modelOf = (layers, manifest, database = 'postgresql') => buildModel({ manifest, layers, stack: { ...STACK_DEFAULTS, database }, projection: PROBE });

test('viaja al publicar y al derivar: sin él los escenarios que lo dan por supuesto no se ejecutan', () => {
  assert.deepEqual(SPEC_SIDE_FILES.find((entry) => entry.file === FIXTURES_FILE), { file: FIXTURES_FILE, publish: true, derive: true });
});

test('se lee con su schema, y su ausencia no es un error', () => {
  const dir = tmpDir('keel-fixtures-');
  assert.deepEqual(loadFixtures(dir), { doc: null, errors: [] });
  fs.writeFileSync(path.join(dir, FIXTURES_FILE), YAML.stringify({ kind: 'fixtures', schema: 1, entities: { Category: { rows: [] } } }));
  const broken = loadFixtures(dir);
  assert.equal(broken.doc, null);
  assert.match(broken.errors.join('\n'), /fixtures\.yaml: \/entities\/Category must have required property 'records'/);
});

test('cruzado con las capas: un registro sano no dice nada, y cada error dice su sitio', () => {
  const { layers } = catalog();
  assert.deepEqual(checkFixtures(layers, GOOD), []);
  const bad = {
    kind: 'fixtures',
    schema: 1,
    entities: {
      Ghost: { records: [{ id: 1 }] },
      Category: {
        records: [
          { id: UUID(1), slug: 'a', name: 'A', parent: UUID(9) },
          { id: UUID(1), slug: 'b' }
        ]
      },
      Product: { records: [{ sku: 'TEA-0001', name: 'x', status: 'gone', category: UUID(1), colour: 'red', images: [] }] }
    }
  };
  const errors = checkFixtures(layers, bad);
  const has = (pattern) => assert.ok(errors.some((e) => pattern.test(e)), `${pattern}\n${errors.join('\n')}`);
  has(/^fixtures\.yaml: Ghost no es una entidad del dominio$/);
  has(/Category\[1\] repite el id/);
  has(/Category\[1\] no trae name, que es obligatorio/);
  has(/Category\[0\]\.parent apunta a Category "0190c0de-0000-7000-8000-000000000009", que no es ningún registro/);
  has(/Product\[0\] no lleva su id \(id\)/);
  has(/Product\[0\]\.status el valor "gone" no es de su enum ProductStatus/);
  has(/Product\[0\]\.colour no es un campo ni una relación de Product/);
  has(/Product\[0\]\.images es una relación one-to-many: no se escribe aquí/);
});

test('keel validate lo trata como una referencia rota: tumba ok', () => {
  const dir = tmpDir('keel-fixtures-validate-');
  fs.cpSync(path.join(FIXTURES_DIR, 'catalog-extended'), dir, { recursive: true });
  assert.equal(validateService(dir).crossRefErrors.length, 0);
  fs.writeFileSync(path.join(dir, FIXTURES_FILE), YAML.stringify({ kind: 'fixtures', schema: 1, entities: { Ghost: { records: [] } } }));
  const result = validateService(dir);
  assert.deepEqual(result.crossRefErrors, ['fixtures.yaml: Ghost no es una entidad del dominio']);
  assert.equal(result.ok, false);
});

test('el SQL: enum por su constante, texto escapado, sombra plegada, versión a 0 y el literal de cada motor', () => {
  const { manifest, layers } = catalog();
  const pg = fixturesSql(modelOf(layers, manifest), GOOD, { dialect: 'postgresql' });
  assert.match(pg, /^INSERT INTO categories \(id, slug, slug_normalized, name, parent_id, lock_version\) VALUES \('0190c0de-0000-7000-8000-000000000001', 'Bebidas', 'bebidas', 'Bebidas', NULL, 0\);$/m);
  assert.match(pg, /^INSERT INTO products \(.*status.*\) VALUES \(.*'Té ''verde''', 'te ''verde''', 'ACTIVE'.*\);$/m);
  assert.ok(pg.indexOf('INTO categories') < pg.indexOf('INTO products'), 'la categoría antes que el producto que la nombra');
  const mysql = fixturesSql(modelOf(layers, manifest, 'mysql'), GOOD, { dialect: 'mysql', uuidLiteral: DATABASES.mysql.uuidLiteral });
  assert.match(mysql, /INSERT INTO categories/);
  assert.equal(fixturesSql(modelOf(layers, manifest), null, { dialect: 'postgresql' }), null);
});

test('lo que todavía no carga se rechaza con su motivo, no se carga a medias', () => {
  const { manifest, layers } = catalog();
  const model = modelOf(layers, manifest);
  assert.match(fixturesUnsupported(model, { entities: { ProductImage: { records: [] } } }), /ProductImage es una entidad interna del agregado/);
  assert.throws(() => fixturesSql(model, { entities: { ProductImage: { records: [{}] } } }, { dialect: 'postgresql' }), /entidad interna/);
  assert.match(fixturesUnsupported({ ...model, persistenceKind: 'document' }, GOOD), /diseño documental/);
});

test('infra/: fixtures.sql y su carga en reset-db.sh tras vaciar; un motor sin cliScriptCmd lo dice', () => {
  const { manifest, layers } = catalog();
  const model = { ...modelOf(layers, manifest), fixtures: GOOD };
  model.stack = { ...STACK_DEFAULTS, database: 'postgresql', auth: 'none', cache: null };
  const files = Object.fromEntries(infraFiles(model, PLATFORM).map((file) => [file.path, file.content]));
  assert.match(files['infra/fixtures.sql'], /INSERT INTO categories/);
  const reset = files['infra/reset-db.sh'];
  assert.match(reset, /exec -i 'catalog-devtools' sh -c 'PGPASSWORD=.*psql .* -1 -f -' < "\$\(dirname "\$0"\)\/fixtures\.sql"/);
  assert.ok(reset.indexOf('Datos reseteados') < reset.indexOf('Estado de partida cargado'), 'primero se vacía, después se carga');
  assert.throws(() => loadsFixtures(model, { entry: { label: 'Oracle' } }), /el motor Oracle no sabe cargar un script SQL/);
  assert.equal(loadsFixtures({ fixtures: null }, null), false);
});
