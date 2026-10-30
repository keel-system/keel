// MySQL (tramo 6d), juzgado sin Go y sin base sobre el árbol en memoria de las fixtures relacionales generadas con
// `database: mysql`. Lo que solo se ve contra un MySQL real (el SQL de cada adaptador, el uuid en binary(16), la
// traducción de una violación) lo mide db-check; aquí va:
//   · PARIDAD DEL ESQUEMA con lo que EMITE keel-spring sobre el mismo motor: tablas, columnas, nombres y la unicidad
//     condicionada como columna GENERADA `<índice>_flag` (MySQL no tiene índices parciales) con la MISMA expresión y al
//     final de su índice único;
//   · el traductor de errores conoce las constraints del PersistenceErrors de keel-dotnet sobre MySQL, y db.yaml lleva
//     sus claves y valores (la URL JDBC de MySQL);
//   · go.mod pide go-sql-driver y goose, no pgx; el paquete es internal/infrastructure/mysql;
//   · nada del dialecto de PostgreSQL se cuela en el SQL (`$n`, `= ANY(…)`, `::tipo`, `ON CONFLICT`);
//   · el Go emitido pasa la red de sintaxis y la de idioma, como el de PostgreSQL.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { constraintErrors } from '@keel-system/keel-core/gen/constraint-errors';
import { repositoryRoots, usesRelational } from '@keel-system/keel-core/gen/features';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { springSchema, springCrossAggregateForeignKeys, schemaTable } from '../../keel-spring/test/helpers/schema-table.js';
import { sentinelOf } from '../src/scaffold/errors.js';
import { checkGoTree } from './helpers/go-tree.js';
import { checkGoIdioms } from './helpers/go-idioms.js';
import { goView } from './helpers/contract.js';
import { goSchema } from './helpers/schema.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const MYSQL = { database: 'mysql' };
const STORE = 'internal/infrastructure/mysql';

/** Las tablas de mecanismos de keel-spring que keel-go todavía no genera (las mismas que schema-parity.test.js). */
const MECHANISM_TABLES = ['idempotency_record', 'reconciliation_claim', 'outbox_event', 'processed_event'];

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const relational = fixtures
  .map((name) => {
    const design = goView(name);
    return { name, design, plan: planService({ ...design, workspace: FIXTURES_DIR, stack: MYSQL }) };
  })
  .filter(({ plan }) => usesRelational(plan.model) && repositoryRoots(plan.model).length > 0);
const file = (plan, filePath) => plan.files.find((candidate) => candidate.path === filePath)?.content;

test('hay fixtures relacionales que medir sobre MySQL', () => {
  assert.ok(relational.length >= 10, `solo ${relational.length}`);
});

/** La unicidad condicionada que keel-spring escribe para MySQL (db/partial-indexes.sql): su columna generada y su índice. */
function springDiscriminators(files) {
  const sql = files.find((candidate) => candidate.path.endsWith('db/partial-indexes.sql'))?.content ?? '';
  const flags = new Map();
  for (const match of sql.matchAll(/ADD COLUMN `(\w+)_flag` TINYINT GENERATED ALWAYS AS \((.*?)\) STORED'\)/g)) {
    flags.set(match[1], { flag: `${match[1]}_flag`, expression: match[2].replaceAll("''", "'") });
  }
  for (const match of sql.matchAll(/CREATE UNIQUE INDEX (\w+) ON (\w+) \(([^)]*)\)'\)/g)) {
    const columns = match[3].split(',').map((column) => column.trim().replaceAll('`', ''));
    flags.set(match[1], { ...flags.get(match[1]), table: match[2], last: columns.at(-1) });
  }
  return flags;
}

let discriminated = 0;

for (const { name, design, plan } of relational) {
  const { model } = plan;

  test(`${name}: sobre MySQL, el esquema de keel-go es el de keel-spring`, () => {
    const springFiles = planSpring({ ...design, workspace: FIXTURES_DIR, stack: MYSQL }).files;
    const spring = springSchema(springFiles);
    for (const [tableName, fks] of springCrossAggregateForeignKeys(springFiles)) for (const fk of fks) schemaTable(spring, tableName).names.add(fk);
    const springFlags = springDiscriminators(springFiles);
    for (const [index, { table }] of springFlags) schemaTable(spring, table).names.add(index);
    for (const table of MECHANISM_TABLES) spring.delete(table);

    const go = goSchema(plan.files);
    assert.deepEqual([...go.keys()].sort(), [...spring.keys()].sort(), 'las mismas tablas');
    const goFlags = new Map();
    for (const [tableName, want] of spring) {
      const got = go.get(tableName);
      assert.deepEqual([...got.names].sort(), [...want.names].sort(), `${tableName}: los mismos nombres de constraint, índice y FK`);
      assert.deepEqual([...got.columns.keys()].sort(), [...want.columns.keys()].sort(), `${tableName}: las mismas columnas`);
      assert.deepEqual(Object.fromEntries(got.predicates), {}, `${tableName}: ningún índice parcial (MySQL no los tiene)`);
      for (const [column, spec] of want.columns) {
        const have = got.columns.get(column);
        if (spec.length != null) assert.equal(have.length, spec.length, `${tableName}.${column}: la cota declarada`);
        if (spec.scale != null) assert.equal(have.scale, spec.scale, `${tableName}.${column}: la escala declarada`);
        assert.equal(have.nullable, spec.nullable, `${tableName}.${column}: ${spec.nullable ? 'admite null' : 'NOT NULL'}`);
      }
      for (const [flag, expression] of got.generated) {
        const index = flag.replace(/_flag$/, '');
        goFlags.set(index, { flag, expression, last: got.indexColumns.get(index)?.at(-1) });
      }
    }
    // La unicidad condicionada: la misma columna generada, con la MISMA expresión (la constante almacenada), y al final
    // de su índice único.
    assert.deepEqual([...goFlags.keys()].sort(), [...springFlags.keys()].sort(), 'los mismos índices condicionados');
    for (const [index, want] of springFlags) {
      const got = goFlags.get(index);
      assert.equal(got.expression, want.expression, `${index}: la expresión de ${want.flag}`);
      assert.equal(got.last, want.flag, `${index}: ${want.flag} es la última columna del índice`);
    }
    discriminated += goFlags.size;
  });

  test(`${name}: sobre MySQL, el traductor conoce las constraints de keel-dotnet y db.yaml lleva sus valores`, () => {
    const dotnet = planDotnet({ ...design, workspace: FIXTURES_DIR, stack: MYSQL }).files;
    const errorsGo = file(plan, `${STORE}/errors.go`);
    const go = new Map([...errorsGo.matchAll(/^\t"([a-z0-9_]+)":\s+domain\.(?:Status)?Errorf\(domain\.(Err\w+),/gm)].map(([, constraint, sentinel]) => [constraint, sentinel]));
    const persistenceErrors = dotnet.find((candidate) => candidate.path.endsWith('/PersistenceErrors.cs'))?.content ?? '';
    const cs = new Set([...persistenceErrors.matchAll(/\["([a-z0-9_]+)"\] = \(\) =>/g)].map(([, constraint]) => constraint));
    assert.deepEqual([...go.keys()].sort(), [...cs].sort());
    for (const entry of constraintErrors(model)) {
      assert.equal(go.get(entry.constraint.toLowerCase()), sentinelOf(entry.declared ? entry.declared.code : entry.code), entry.constraint);
    }
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const pairs = (text) =>
        (text ?? '')
          .split('\n')
          .filter((line) => /^\s*[a-z-]+:/.test(line))
          .map((line) => line.trim());
      const goYaml = pairs(file(plan, `config/parameters/${profile}/db.yaml`));
      const csYaml = pairs(dotnet.find((candidate) => candidate.path.endsWith(`config/parameters/${profile}/db.yaml`))?.content);
      assert.deepEqual(goYaml, csYaml.filter((line) => !line.startsWith('schema:')), profile);
    }
    assert.match(file(plan, 'config/parameters/local/db.yaml'), /jdbc:mysql:\/\/localhost:3306\//);
  });

  test(`${name}: sobre MySQL, el adaptador va en ${STORE}, con go-sql-driver y sin el dialecto de PostgreSQL`, () => {
    const goMod = file(plan, 'go.mod');
    assert.match(goMod, /\tgithub\.com\/go-sql-driver\/mysql v/);
    assert.match(goMod, /\tgithub\.com\/pressly\/goose\/v3 v/);
    assert.doesNotMatch(goMod, /jackc\/pgx/);
    assert.ok(!plan.files.some((candidate) => candidate.path.startsWith('internal/infrastructure/postgres/')), 'ningún archivo en el paquete postgres');
    assert.match(file(plan, `${STORE}/database.go`), /goose\.DialectMySQL/);
    for (const adapter of plan.files.filter((candidate) => candidate.path.startsWith(`${STORE}/`) && candidate.path.endsWith('.go'))) {
      const strings = [...adapter.content.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map(([, text]) => text);
      for (const text of strings.filter((candidate) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(candidate))) {
        assert.doesNotMatch(text, /\$\d|= ANY\(|::\w|ON CONFLICT|EXCLUDED\./, `${adapter.path}: ${text}`);
      }
      assert.doesNotMatch(adapter.content, /pgconn|pgx/, adapter.path);
    }
    // Los repositorios ven la conexión que escribe los uuid como sus 16 bytes, en la transacción y fuera de ella.
    const transactions = file(plan, `${STORE}/transactions.go`);
    assert.match(transactions, /return bound\{tx\}, nil/);
    assert.match(transactions, /return bound\{t\.db\}, nil/);
    assert.match(transactions, /fn\(context\.WithValue\(ctx, txKey\{\}, tx\), bound\{tx\}\)/);
    assert.match(file(plan, `${STORE}/migrations/00001_baseline.sql`), /^-- \+goose Down\nSET FOREIGN_KEY_CHECKS = 0;/m);
  });

  test(`${name}: sobre MySQL, el Go emitido es sintaxis válida, sus imports se usan y no tiene hallazgos de idioma`, async () => {
    assert.deepEqual(await checkGoTree(plan.files, model.service.goModule), []);
    assert.deepEqual(checkGoIdioms(plan.files), []);
  });
}

test('MySQL: alguna fixture tiene unicidad condicionada, o la comparación de las columnas generadas no mide nada', () => {
  assert.ok(discriminated > 0);
});
