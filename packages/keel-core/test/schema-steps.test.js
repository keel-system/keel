// Los pasos de esquema del generador (keel-core/gen/schema-steps.js, inc. 2b del plan 2.26): cómo llega una tabla del
// generador a una base ya desplegada. Que el SQL CASE con los dos motores, y que aplicarlo dos veces no haga nada, lo
// mide `npm run timer-sql-check`, que crea sus tablas con él.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import {
  GENERATOR_TABLES,
  STEP_ENGINES,
  STEP_MARK,
  createdTablesInSql,
  nextStepVersion,
  planSchemaSteps,
  schemaStepFiles,
  schemaStepSql,
  stepSlug
} from '../src/lib/gen/schema-steps.js';
import { evolutionState, mergePrevious, renderEvolutionMarkdown } from '../src/lib/gen/evolution.js';
import { OUTBOX_EVENT, PROCESSED_EVENT } from '../src/lib/gen/messaging-stores.js';
import { KEEL_TIMER } from '../src/lib/gen/timer-store.js';

const DIR = 'db/migration';
const flyway = (name) => /^V(\d+(?:_\d+)*)__.+\.sql$/.exec(name);
const RECIPE = {
  dir: DIR,
  isMigration: (name) => Boolean(flyway(name)),
  isBaseline: (name) => name === 'V1__baseline_schema.sql',
  versionOf: (name) => flyway(name)?.[1].split('_')[0] ?? null,
  renderStep: ({ version, slug, sql, header }) => ({ name: `V${version}__${slug}.sql`, content: `${header.map((line) => `-- ${line}`).join('\n')}\n\n${sql}` })
};

function project(files) {
  const dir = tmpDir('keel-schema-steps-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, DIR, name), content);
  }
  return dir;
}

const BASELINE = 'create table outbox_event (id uuid not null, primary key (id));\ncreate table "Product" (id uuid);\n';

test('el SQL es idempotente y lleva los nombres de keel-core; en MySQL los índices van dentro de la tabla', () => {
  for (const engine of STEP_ENGINES) {
    const sql = schemaStepSql(engine, GENERATOR_TABLES);
    for (const table of GENERATOR_TABLES) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table.table} \\(`), `${engine}: ${table.table}`);
      for (const index of table.indexes ?? []) assert.ok(sql.includes(index.name), `${engine}: ${index.name}`);
      for (const unique of table.uniques ?? []) assert.ok(sql.includes(`CONSTRAINT ${unique.name} UNIQUE`), `${engine}: ${unique.name}`);
    }
    // Cada CREATE lleva su guarda: aplicado sobre una base que ya tiene la tabla, no hace nada.
    assert.equal(sql.match(/CREATE (TABLE|INDEX)/g).length, sql.match(/IF NOT EXISTS/g).length, engine);
  }
  assert.doesNotMatch(schemaStepSql('mysql', GENERATOR_TABLES), /CREATE INDEX/);
  // La columna que solo existe en el modelo documental no entra en la tabla.
  assert.doesNotMatch(schemaStepSql('postgresql', [OUTBOX_EVENT]), /claimed_at/);
  assert.match(schemaStepSql('mysql', [KEEL_TIMER]), /entity_id binary\(16\) NOT NULL/);
  assert.match(schemaStepSql('postgresql', [KEEL_TIMER]), /due_at timestamp\(6\) with time zone NOT NULL/);
  assert.throws(() => schemaStepSql('oracle', [KEEL_TIMER]), /oracle/);
});

test('lo que la base ya tiene se lee de las migraciones, con o sin comillas ni esquema', () => {
  assert.deepEqual(createdTablesInSql('CREATE TABLE IF NOT EXISTS `keel_timer` (x int);\ncreate table public.outbox_event (y int)'), ['keel_timer', 'outbox_event']);
  assert.deepEqual(createdTablesInSql('await queryRunner.query(`CREATE TABLE "processed_event" (...)`)'), ['processed_event']);
  assert.deepEqual(createdTablesInSql('-- nada que crear\nALTER TABLE outbox_event ADD x int;'), []);
});

test('sin baseline no hay paso; con ella, solo las tablas que ninguna migración crea', () => {
  const tables = [OUTBOX_EVENT, PROCESSED_EVENT, KEEL_TIMER];
  assert.deepEqual(planSchemaSteps({ tables, migrations: [], baseline: false, engine: 'postgresql' }).missing, []);
  const migrations = [
    { name: 'V1__baseline_schema.sql', content: BASELINE },
    { name: 'V2__agent.sql', content: 'CREATE TABLE processed_event (a int);' }
  ];
  const plan = planSchemaSteps({ tables, migrations, baseline: true, engine: 'postgresql' });
  assert.deepEqual(plan.missing, [KEEL_TIMER]);
  assert.equal(plan.unsupported, false);
  // Un motor sin pasos no se queda callado: el plan dice que las tablas son trabajo del agente.
  assert.equal(planSchemaSteps({ tables, migrations, baseline: true, engine: 'sqlserver' }).unsupported, true);
});

test('la versión siguiente no choca con ningún paso, tampoco con uno de versión con punto', () => {
  const versionOf = RECIPE.versionOf;
  assert.equal(nextStepVersion(['V1__baseline_schema.sql', 'V2_1__fix.sql', 'V3__more.sql'], versionOf), 4);
  assert.equal(nextStepVersion(['V1__baseline_schema.sql', 'V2_1__fix.sql'], versionOf), 3);
  assert.equal(nextStepVersion([], versionOf), 1);
  assert.equal(stepSlug([KEEL_TIMER]), 'keel_timer');
  assert.equal(stepSlug([OUTBOX_EVENT, KEEL_TIMER]), 'keel_outbox_event_timer');
});

test('schemaStepFiles: escribe el paso que falta, después lo vuelve a emitir TAL CUAL y no escribe otro', () => {
  const dir = project({ 'V1__baseline_schema.sql': BASELINE, 'V2__agent.sql': 'create table processed_event (a int);', 'README.md': 'x' });
  const tables = [OUTBOX_EVENT, PROCESSED_EVENT, KEEL_TIMER];
  const first = schemaStepFiles({ projectDir: dir, tables, engine: 'postgresql', ...RECIPE });
  assert.deepEqual(first.added, [`${DIR}/V3__keel_timer.sql`]);
  const step = first.files.find((file) => file.path === first.added[0]);
  assert.ok(step.content.startsWith(`-- ${STEP_MARK} keel_timer`), step.content);

  // El agente lo aplica y escribe un paso suyo; alguien lo retoca a mano. build no lo reescribe ni crea otro.
  fs.writeFileSync(path.join(dir, step.path), `${step.content}\n-- retocado\n`);
  fs.writeFileSync(path.join(dir, DIR, 'V4__agent.sql'), 'alter table x add y int;');
  const second = schemaStepFiles({ projectDir: dir, tables, engine: 'postgresql', ...RECIPE });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.files.map((file) => file.path), [step.path]);
  assert.match(second.files[0].content, /-- retocado/);

  // Una tabla nueva del generador después: el siguiente número, tras el paso del agente.
  const third = schemaStepFiles({ projectDir: dir, tables: [...tables, ...GENERATOR_TABLES], engine: 'postgresql', ...RECIPE });
  assert.deepEqual(third.added, [`${DIR}/V5__keel_idempotency_record_reconciliation_claim.sql`]);
});

test('schemaStepFiles: sin baseline no escribe nada, y con un motor sin pasos deja el trabajo escrito', () => {
  const tables = [KEEL_TIMER];
  assert.deepEqual(schemaStepFiles({ projectDir: project({}), tables, engine: 'postgresql', ...RECIPE }), { files: [], added: [], work: [] });
  const unsupported = schemaStepFiles({ projectDir: project({ 'V1__baseline_schema.sql': BASELINE }), tables, engine: 'sqlserver', ...RECIPE });
  assert.deepEqual(unsupported.added, []);
  assert.match(unsupported.work[0], /`keel_timer`.*`sqlserver`/s);
});

test('EVOLUTION.md: el paso nuevo es informativo; la tabla sin paso es trabajo del agente', () => {
  const service = { name: 'demo', version: '1.0.0' };
  const informative = evolutionState({ service, schemaSteps: [`${DIR}/V3__keel_timer.sql`] });
  assert.equal(informative.pending, false);
  const md = renderEvolutionMarkdown(evolutionState({ service, schemaSteps: [`${DIR}/V3__keel_timer.sql`], newWithTodo: ['x'] }), {
    generator: 'g', skill: 's', keepBuild: 'k', scenarioWork: 'w', duplicateStub: 'd'
  });
  assert.match(md, /## Pasos de esquema de build[\s\S]*V3__keel_timer\.sql/);
  assert.equal(evolutionState({ service, schemaWork: ['nota'] }).pending, true);

  // Un paso solo es nuevo en el build que lo crea: el segundo lo arrastra mientras exista.
  const dir = project({ 'V3__keel_timer.sql': 'x' });
  const merged = mergePrevious(evolutionState({ service, newWithTodo: ['y'] }), { schemaSteps: [`${DIR}/V3__keel_timer.sql`, `${DIR}/V9__gone.sql`] }, dir);
  assert.deepEqual(merged.schemaSteps, [`${DIR}/V3__keel_timer.sql`]);
});
