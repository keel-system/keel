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
import { tmpDir } from './helpers/tmp.js';
import { BASELINE_FILE, generatorTables, physicalType, schemaSteps, schemaTables } from '../src/scaffold/persistence.js';
import { layout } from '../src/scaffold/render.js';
import { GENERATOR_TABLES, schemaStepSql, stepSlug, storeColumnType } from '@keel-system/keel-core/gen/schema-steps';
import { storeColumns } from '@keel-system/keel-core/gen/messaging-stores';

/** Las tablas de mecanismos de keel-spring que keel-go todavía no genera, con el incremento que las trae. */
const MECHANISM_TABLES = {};

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});

test('hay fixtures relacionales que comparar', () => {
  assert.ok(relational.length >= 8, relational.join(', '));
});

function compare(spring, go) {
  for (const table of Object.keys(MECHANISM_TABLES)) spring.delete(table);
  // Las purgas sobre el cronómetro (DSL 2.26, inc. 7) dan keel_timer a todo diseño con purgas en keel-spring; keel-go lo
  // emite con su parte del inc. 7. Hasta entonces, solo se compara donde keel-go ya la tiene (los plazos).
  if (!go.has('keel_timer')) spring.delete('keel_timer');
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

// ─── Los pasos de esquema de build (inc. 2b del plan 2.26) ───────────────────────────────────
//
// El paso que lleva una tabla del generador a una base desplegada (persistence.js `schemaSteps`) tiene que dejarla
// IGUAL que la habría dejado la baseline: los mismos tipos físicos, la misma nulabilidad, la misma clave primaria, la
// misma unicidad y los mismos índices. El SQL del paso es el neutral (`schemaStepSql`, con `storeColumnType`) y el de la
// baseline es el de keel-go (`physicalType`): si divergen, una base nueva y una desplegada tendrían otro esquema.

const ENGINES = ['postgresql', 'mysql'];

test('pasos de esquema: storeColumnType de keel-core es el physicalType de la baseline en cada columna del generador', () => {
  for (const table of GENERATOR_TABLES) {
    for (const column of storeColumns(table, 'relational')) {
      for (const engine of ENGINES) {
        assert.equal(storeColumnType(column, engine), physicalType({ base: column.base, length: column.length }, engine), `${engine}: ${table.table}.${column.name}`);
      }
    }
  }
});

for (const engine of ENGINES) {
  test(`pasos de esquema (${engine}): cada tabla del generador de la baseline es la que crea el paso`, () => {
    let seen = 0;
    for (const name of relational) {
      const design = goView(name);
      const { model } = planService({ ...design, workspace: FIXTURES_DIR, stack: { database: engine } });
      const { tables, indexes } = schemaTables(model);
      for (const definition of generatorTables(model)) {
        seen += 1;
        const table = tables.find((candidate) => candidate.name === definition.table);
        const columns = storeColumns(definition, 'relational');
        const where = `${name}: ${definition.table}`;
        assert.deepEqual(table.columns.map((column) => [column.name, physicalType(column, engine), column.nullable]), columns.map((column) => [column.name, storeColumnType(column, engine), column.nullable]), `${where}: columnas`);
        assert.deepEqual(table.primaryKey.columns, columns.filter((column) => column.primary).map((column) => column.name), `${where}: clave primaria`);
        assert.deepEqual(table.constraints, (definition.uniques ?? []).map((unique) => ({ name: unique.name, columns: unique.columns })), `${where}: unicidad`);
        assert.deepEqual(indexes.filter((index) => index.table === definition.table).map((index) => [index.name, index.columns, index.unique]), (definition.indexes ?? []).map((index) => [index.name, index.columns, false]), `${where}: índices`);
      }
    }
    assert.ok(seen >= 4, `hay tablas del generador en las fixtures (${seen})`);
  });

  test(`pasos de esquema (${engine}): el paso es el SQL neutral dentro de un paso de goose embebido`, () => {
    // La fixture con más tablas del generador, sobre una «base desplegada» cuya baseline no crea ninguna.
    const plans = relational.map((name) => planService({ ...goView(name), workspace: FIXTURES_DIR, stack: { database: engine } }));
    const { model, files } = plans.sort((a, b) => generatorTables(b.model).length - generatorTables(a.model).length)[0];
    const tables = generatorTables(model);
    const projectDir = tmpDir('keel-go-schema-step-');
    const dir = path.join(projectDir, layout(model).store.dir, 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BASELINE_FILE), '-- +goose Up\nCREATE TABLE product (id uuid);\n');

    const schema = schemaSteps(model, projectDir);
    assert.deepEqual(schema.tables, tables.map((table) => table.table));
    assert.equal(schema.files.length, 1);
    const [step] = schema.files;
    assert.equal(step.path, `${layout(model).store.dir}/migrations/00002_${stepSlug(tables)}.sql`);
    const up = step.content.slice(step.content.indexOf('-- +goose Up\n') + '-- +goose Up\n'.length, step.content.indexOf('\n-- +goose Down\n'));
    assert.equal(up, schemaStepSql(engine, tables), 'el Up es schemaStepSql byte a byte');
    assert.ok(step.content.indexOf('-- +goose Up') < step.content.indexOf('-- +goose Down'), 'Up antes que Down');
    // goose parte por el `;` del final de línea: ninguna sentencia lleva otro dentro (sin StatementBegin).
    for (const statement of up.split(/;\n/).filter((text) => text.trim())) assert.ok(!statement.includes(';'), statement);
    // Lo embebe el `//go:embed migrations/*.sql` del paquete: entra sin registrarlo.
    assert.match(files.find((file) => file.path === `${layout(model).store.dir}/migrations.go`).content, /\/\/go:embed migrations\/\*\.sql\n/);
    assert.match(path.posix.basename(step.path), /^\d{5}_keel_[a-z_]+\.sql$/);
  });
}
