#!/usr/bin/env node
// La persistencia de keel-go contra un PostgreSQL o un MySQL REAL (`--database=mysql`), en dos partes:
//
//   esquema  la migración baseline que escribe build para cada fixture relacional se aplica a una base vacía, y el
//            catálogo del motor (information_schema, y pg_constraint y pg_indexes en PostgreSQL) tiene que decir lo
//            mismo que el SQL emitido —el que compara con keel-spring la paridad de test/schema-parity.test.js y
//            test/mysql.test.js—: las mismas tablas y columnas, con su nulabilidad, cota y escala, los mismos nombres de
//            constraint, índice y FK, y cada índice condicionado con su predicado (en MySQL, con su columna generada al
//            final del índice, y además el tipo y la collation de cada columna). Después, la vuelta atrás de goose
//            (Down) tiene que dejar la base vacía;
//   sondas   por sujeto, una prueba Go generada desde el modelo (scripts/lib/db-probes.js) que EJECUTA los adaptadores
//            emitidos: arranca como el servicio (Open + Migrate), guarda y relee cada raíz campo a campo, la versión, la
//            fusión de hijas y listas, cada unicidad con su code y su mensaje, la cota del motor, la página, los finders,
//            el lote, las inversas, el orden por rango y la transacción (interbloqueo repetido, conflicto agotado, tope).
//
// Por qué hace falta además de las paridades: las paridades leen el texto. Un nombre de más de 63 caracteres que
// PostgreSQL trunca, un predicado que el motor no acepta, un Scan con las columnas en otro orden o una fusión que no
// borra la hija quitada pasan la paridad y rompen aquí.
//
//   node packages/keel-go/scripts/db-check.js [--database=postgresql|mysql] [--only=<fixture>] [--sabotage=<id>] [--keep]
//   npm run db-check --workspace packages/keel-go
//
// --sabotage=<id> rompe lo emitido EN MEMORIA, antes de escribirlo (una red que reconstruye lo que mide no lo falsa, la
// lección del 16e de keel-dotnet), conservando la forma: sigue compilando. El check tiene que salir rojo en las sondas
// que miden ese mecanismo y solo en ellas (`expect`, y `also` para las que caen con él por una dependencia legítima).
// Sin sabotaje, el esquema se falsa además aplicando una migración sin un índice de FK.
//
// Necesita Go, podman o docker y la caché de módulos (o red la primera vez).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { AUTHORSHIP_DESIGNS, FIXTURES_DIR, UNCOVERED_BRANCHES, makeWorkspace } from '../test/helpers/workspace.js';
import { goView } from '../test/helpers/contract.js';
import { baselineOf, goSchema } from '../test/helpers/schema.js';
import { probeFile } from './lib/db-probes.js';
import { FINDER_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';
import { DB_SABOTAGES as SABOTAGES, applyDbSabotage } from '../test/helpers/db-sabotages.js';
import { resolveRuntime, startDatabase, stopDatabase } from '../../keel-nest/scripts/lib/database-container.js';
import { ENGINE_LABELS, STORE_PACKAGES } from '../src/lib/relational-engine.js';
import { SUPPORTED_DATABASES } from '../src/lib/supported-features.js';
import { schemaSteps } from '../src/scaffold/persistence.js';

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null;
const engine = process.argv.find((arg) => arg.startsWith('--database='))?.slice('--database='.length) ?? 'postgresql';
// MongoDB tiene su propia red (doc-check.js): aquí solo los motores relacionales.
if (!SUPPORTED_DATABASES.includes(engine) || !STORE_PACKAGES[engine]) {
  console.error(`--database=${engine}: db-check mide ${SUPPORTED_DATABASES.filter((candidate) => STORE_PACKAGES[candidate]).join(', ')} (MongoDB: npm run doc-check).`);
  process.exit(2);
}
const label = ENGINE_LABELS[engine];
const stack = { database: engine };
const storePath = `internal/infrastructure/${STORE_PACKAGES[engine]}`;
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.slice('--sabotage='.length) ?? null;
const keep = process.argv.includes('--keep');

if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function run(command, args, { input, cwd, env } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime))) process.exit(1);
if (!step('Go disponible', run('go', ['version']).ok)) process.exit(1);

let database;
try {
  database = await startDatabase(runtime, engine);
} catch (error) {
  step(`${label} en marcha`, false, error.message);
  process.exit(1);
}
step(`${label} en marcha`, true, `puerto ${database.port}`);

const psql = (db, sql, flags = []) => run(runtime, ['exec', '-i', database.name, 'psql', '-U', database.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...flags, '-f', '-'], { input: sql });
// En MySQL, como root: el usuario de la imagen solo tiene permisos sobre su base, y cada sujeto lleva la suya.
const mysql = (db, sql) => run(runtime, ['exec', '-i', database.name, 'mysql', '-u', 'root', `-p${database.password}`, '-N', '-B', ...(db ? [db] : [])], { input: sql });
// Una consulta de una fila por línea, con las columnas separadas por tabulador.
const query = (db, sql) => (engine === 'mysql' ? mysql(db, sql) : psql(db, sql, ['-A', '-t', '-F', '\t']));
// Un script en la base (Up, Down).
const execute = (db, sql) => (engine === 'mysql' ? mysql(db, sql) : psql(db, sql));
// Crear (de cero) o borrar una base, como el superusuario.
const recreate = (db) => (engine === 'mysql' ? mysql(null, `DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db};`) : psql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);\nCREATE DATABASE ${db};`));
const drop = (db) => (engine === 'mysql' ? mysql(null, `DROP DATABASE IF EXISTS ${db};`) : psql('postgres', `DROP DATABASE IF EXISTS ${db};`));
const root = makeWorkspace('keel-go-db-check-');

try {
  const allRelational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
    const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
    return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
  });
  const relational = allRelational.filter((name) => !only || name === only);
  // Los sujetos de las sondas: las fixtures relacionales y los diseños DERIVADOS de los finders (DSL 2.22) que comparten
  // los generadores, los que salen de una fixture relacional (los mismos que miden keel-dotnet y keel-nest).
  const probeSubjects = [
    ...relational.map((name) => ({ name, from: name, mutate: null })),
    ...FINDER_DESIGNS.filter((design) => allRelational.includes(design.from) && (!only || design.name === only)).map((design) => ({ name: design.name, from: design.from, mutate: design.mutate })),
    // La autoría (13g): los derivados relacionales, que otro nombre de servicio hace su propio módulo.
    ...AUTHORSHIP_DESIGNS.filter((design) => allRelational.includes(design.from) && (!only || design.name === only)).map((design) => ({ name: design.name, from: design.from, mutate: (layers, manifest) => design.mutate(manifest, layers) })),
    // La escritura condicional (DSL 2.25, CW-1 a CW-5): las siluetas relacionales, los MISMOS diseños que miden keel-dotnet y
    // keel-nest (keel-core/test/helpers/conditional-write-designs.js).
    ...UNCOVERED_BRANCHES.filter((design) => ['catalog-conditional', 'shop-conditional'].includes(design.name) && (!only || design.name === only)).map((design) => ({ name: design.name, from: design.from, mutate: (layers, manifest) => design.mutate(manifest, layers) }))
  ];

  // ─── El esquema ─────────────────────────────────────────────────────────────────────────────────
  if (!sabotage) {
    // La fixture ENTERA, como las sondas: planService no pasa por la frontera, y así entran también las tablas de los
    // mecanismos que keel-go ya emite aunque su capa todavía se rechace (outbox_event y processed_event, incremento 9).
    for (const name of relational) {
      const files = planService({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack }).files;
      const differences = applyAndCompare(name.replace(/-/g, '_'), baselineOf(files), goSchema(files));
      step(`${name}: el catálogo del motor es el esquema emitido, y Down lo deja vacío`, differences.length === 0, differences.slice(0, 8).join(' | '));
    }
    // Falsado: sin un índice de FK, la comparación tiene que verlo. Si el sabotaje ya no se aplica, el paso sale rojo.
    // El de la purga del registro de idempotencia (ix_idempotency_record_expires_at) no es de una FK, ni el de las marcas de reconciliación: se saltan.
    const subject = relational.find((name) => /^CREATE INDEX ix_(?!idempotency_record_|outbox_event_|processed_event_|reconciliation_claim_)/m.test(baselineOf(planService({ ...goView(name), workspace: FIXTURES_DIR, stack }).files)));
    if (subject) {
      const files = planService({ ...goView(subject), workspace: FIXTURES_DIR, stack }).files;
      const sql = baselineOf(files);
      const sabotaged = sql.replace(/^CREATE INDEX ix_(?!idempotency_record_|outbox_event_|processed_event_|reconciliation_claim_)\w+ ON .*;\n\n?/m, '');
      const differences = sabotaged === sql ? [] : applyAndCompare(`${subject.replace(/-/g, '_')}_sabotaged`, sabotaged, goSchema(files));
      step(`falsado: ${subject} sin un índice de FK → la comparación lo ve`, differences.some((d) => /ix_/.test(d)), differences.slice(0, 3).join(' | ') || 'no vio nada');
    }
  }

  // ─── Las sondas ─────────────────────────────────────────────────────────────────────────────────
  // Cada sujeto es su módulo y su base: se preparan en orden y se ejecutan de cuatro en cuatro (tidy y la compilación son
  // lo que tarda), y se informan en orden.
  let applied = 0;
  const subjects = [];
  for (const { name, from, mutate } of probeSubjects) {
    // Toda la fixture, como go-check --fixtures: planService no pasa por la frontera.
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    if (mutate) mutate(layers, manifest);
    const plan = planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
    let files = plan.files;
    if (sabotage) {
      const sabotaged = applyDbSabotage(SABOTAGES[sabotage], files, engine);
      // Un sabotaje que no toca a este sujeto no dice nada de él.
      if (sabotaged.changed === 0) continue;
      applied += sabotaged.changed;
      files = sabotaged.files;
    }
    const probe = probeFile(plan.model, files);
    const dir = path.join(root, name);
    for (const file of [...files, probe]) {
      const target = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    if (probe.unsampled.length > 0) console.log(`  (${name}: sin muestra para ${probe.unsampled.join(', ')})`);
    const db = `${name.replace(/-/g, '_')}_probes`;
    // Una base que no se pudo crear daría un rojo de las sondas que no es del generador: se dice aquí.
    const created = recreate(db);
    if (!step(`${name}: base ${db} creada`, created.ok, created.ok ? '' : created.output.trim().slice(0, 300))) continue;
    subjects.push({ name, dir, db });
  }
  const env = (db) =>
    engine === 'mysql'
      ? { DB_CHECK_URL: `mysql://127.0.0.1:${database.port}/${db}`, DB_CHECK_USER: 'root', DB_CHECK_PASSWORD: database.password }
      : { DB_CHECK_URL: `postgresql://127.0.0.1:${database.port}/${db}`, DB_CHECK_USER: database.user, DB_CHECK_PASSWORD: database.password };
  const outcomes = await pool(subjects, 4, async ({ dir, db }) => {
    const tidied = await runAsync('go', ['mod', 'tidy'], { cwd: dir });
    if (!tidied.ok) return { tidied };
    // La sonda se compila aparte (go test -c) y se ejecuta desde el sujeto, como haría go test desde el paquete. No con
    // go test a secas: en Windows el antivirus denegó («Acceso denegado») el postgres.test.exe que go test enlaza en
    // %TEMP%\go-build… para un sujeto concreto, de forma repetible, mientras el MISMO binario compilado aquí corría
    // (medido el 2026-10-30 con stock-reservation).
    const binary = path.join(dir, process.platform === 'win32' ? 'db-probe.test.exe' : 'db-probe.test');
    const built = await runAsync('go', ['test', '-c', '-o', binary, `./${storePath}/`], { cwd: dir, env: env(db) });
    if (!built.ok) return { tidied, tested: built };
    return { tidied, tested: await runAsync(binary, ['-test.count=1', '-test.v'], { cwd: path.join(dir, storePath), env: env(db) }) };
  });
  subjects.forEach(({ name }, index) => {
    const { tidied, tested } = outcomes[index];
    if (!step(`${name}: go mod tidy`, tidied.ok, tidied.ok ? '' : tidied.output.slice(0, 2000))) return;
    const failed = [...tested.output.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]).filter((test) => !test.includes('/'));
    const passed = [...tested.output.matchAll(/^\s*--- PASS: (\S+)/gm)].map((m) => m[1]);
    const skipped = [...tested.output.matchAll(/^\s*--- SKIP: (\S+)/gm)].map((m) => m[1]);
    const ran = failed.length + passed.length;
    if (!sabotage) {
      const ok = tested.ok && ran > 0;
      const detail = ok ? (skipped.length > 0 ? `se saltan ${skipped.join(', ')}` : '') : failed.join(', ') || tested.output.slice(-3000);
      step(`${name}: los adaptadores guardan, leen y traducen contra ${label} (${passed.length} sondas)`, ok, detail);
      if (!ok && failed.length > 0) console.error(failureLines(tested.output));
      return;
    }
    const { expect } = SABOTAGES[sabotage];
    const also = SABOTAGES[sabotage][engine]?.also ?? SABOTAGES[sabotage].also;
    const expected = failed.filter((test) => expect.test(test));
    const stray = failed.filter((test) => !expect.test(test) && !(also && also.test(test)));
    const compiled = ran > 0;
    // Un sujeto donde el sabotaje toca lo emitido pero ninguna sonda lo mide sale verde y lo dice: se juzga en conjunto.
    step(
      `falsado: ${sabotage} en ${name} → ${expected.length > 0 ? `rojo en ${expected.join(', ')}` : 'ninguna sonda lo mide aquí'}`,
      compiled && stray.length === 0,
      compiled ? (stray.length > 0 ? `caen además ${stray.join(', ')}` : '') : `no compila: ${tested.output.slice(0, 2000)}`
    );
    if (expected.length > 0) results.at(-1).caught = true;
  });
  if (!sabotage && (!only || only === 'product-catalog')) await schemaEvolution(env);
  if (!sabotage && (!only || only === 'product-catalog')) await generatorSchemaStep(env);
  if (sabotage) {
    if (step(`el sabotaje ${sabotage} se aplica a lo emitido`, applied > 0, applied === 0 ? '¿cambió el texto emitido?' : `${applied} archivo(s)`)) {
      step(`el sabotaje ${sabotage} lo ve al menos una sonda`, results.some((result) => result.caught));
    }
  }
} finally {
  const client = engine === 'mysql' ? 'mysql -u root -p' : `psql -U ${database.user}`;
  if (keep) console.log(`\n${label} sigue en marcha (${runtime} exec -it ${database.name} ${client}); sujetos en ${root}`);
  else stopDatabase(runtime, database);
}

const failedSteps = results.filter((result) => !result.ok).length;
console.log(failedSteps === 0 ? `\ndb-check: ${results.length}/${results.length} en verde.` : `\ndb-check: ${failedSteps} paso(s) en rojo.`);
process.exitCode = failedSteps === 0 ? 0 : 1;

/**
 * Una base desplegada ante un cambio de esquema (incremento 15, `references/schema-evolution.md` de la skill de la base):
 * con el Migrate emitido, la baseline reescrita NO llega a una base que aplicó la anterior, un paso nuevo SÍ llega, y una
 * base vacía acaba con baseline + paso en el mismo catálogo que la baseline nueva sola. El primer paso es la razón de todo
 * lo demás: si un día saliera verde, el aviso de EVOLUTION.md sobraría.
 */
async function schemaEvolution(env) {
  const FIELD = 'weight';
  const planOf = (withField) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
    if (withField) layers.domain.entities.Product.fields[FIELD] = { type: 'int' };
    return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
  };
  const before = planOf(false);
  const after = planOf(true);
  const oldBaseline = baselineOf(before.files);
  const newBaseline = baselineOf(after.files);
  const table = [...newBaseline.slice(0, newBaseline.indexOf(`${FIELD} `)).matchAll(/CREATE TABLE [`"]?(\w+)/g)].at(-1)?.[1];
  const definition = new RegExp(`^\\s*([\`"]?${FIELD}[\`"]? [^,\\n]*),?$`, 'm').exec(newBaseline)?.[1];
  if (!step('evolución del esquema: la baseline nueva trae la columna', Boolean(table && definition), `${table}: ${definition}`)) return;

  const dir = path.join(root, 'schema-evolution');
  const write = (file) => {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  };
  for (const file of [...before.files, probeFile(before.model, before.files)]) write(file);
  const tidied = await runAsync('go', ['mod', 'tidy'], { cwd: dir });
  if (!step('evolución del esquema: go mod tidy', tidied.ok, tidied.ok ? '' : tidied.output.slice(0, 2000))) return;

  const migrations = path.join(dir, storePath, 'migrations');
  const baselineFile = path.join(migrations, '00001_baseline.sql');
  const stepFile = path.join(migrations, `00002_add_product_${FIELD}.sql`);
  const stepSql = `-- +goose Up\nALTER TABLE ${table} ADD COLUMN ${definition};\n\n-- +goose Down\nALTER TABLE ${table} DROP COLUMN ${FIELD};\n`;
  // La sonda migra en su TestMain, como arranca el servidor; las migraciones van embebidas, así que se compila cada vez.
  const boot = async (db) => {
    const binary = path.join(dir, process.platform === 'win32' ? 'evolution-probe.test.exe' : 'evolution-probe.test');
    const built = await runAsync('go', ['test', '-c', '-o', binary, `./${storePath}/`], { cwd: dir });
    if (!built.ok) return built;
    return runAsync(binary, ['-test.run=^$'], { cwd: path.join(dir, storePath), env: env(db) });
  };
  const catalogOf = (db) => (engine === 'mysql' ? mysqlCatalog(db) : catalog(db));
  const hasColumn = (db) => catalogOf(db).get(table)?.columns.has(FIELD) ?? false;
  // El catálogo sin depender del orden: una columna añadida va al final, y en la baseline, en su sitio.
  const shape = (db) =>
    JSON.stringify(
      [...catalogOf(db).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { columns, names }]) => [name, [...columns.entries()].sort(([a], [b]) => a.localeCompare(b)), [...names].sort()])
    );

  const deployed = 'schema_evolution_deployed';
  recreate(deployed);
  const first = await boot(deployed);
  if (!step('evolución del esquema: la base desplegada aplica la baseline anterior', first.ok && !hasColumn(deployed), first.ok ? '' : first.output.slice(-1500))) return;

  // Lo que hace --refresh: reescribir la baseline. goose ve la versión 1 aplicada y no hace nada, y el arranque no se queja.
  fs.writeFileSync(baselineFile, newBaseline);
  const rewritten = await boot(deployed);
  step('evolución del esquema: la baseline reescrita arranca y NO llega a la base desplegada', rewritten.ok && !hasColumn(deployed), rewritten.ok ? '' : rewritten.output.slice(-1500));

  // Lo que dice la referencia: devolver la baseline y escribir el paso.
  fs.writeFileSync(baselineFile, oldBaseline);
  fs.writeFileSync(stepFile, stepSql);
  const stepped = await boot(deployed);
  step('evolución del esquema: el paso nuevo SÍ llega a la base desplegada', stepped.ok && hasColumn(deployed), stepped.ok ? '' : stepped.output.slice(-1500));

  const viaSteps = 'schema_evolution_steps';
  recreate(viaSteps);
  const fresh = await boot(viaSteps);
  fs.rmSync(stepFile);
  fs.writeFileSync(baselineFile, newBaseline);
  const viaBaseline = 'schema_evolution_baseline';
  recreate(viaBaseline);
  const whole = await boot(viaBaseline);
  const same = fresh.ok && whole.ok && shape(viaSteps) === shape(viaBaseline);
  const shapeDifference = () => {
    const [a, b] = [JSON.parse(shape(viaSteps)), JSON.parse(shape(viaBaseline))];
    const differing = a.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(b[index]));
    return differing.map(([name]) => `${name}: pasos ${JSON.stringify(a.find(([n]) => n === name))} · baseline ${JSON.stringify(b.find(([n]) => n === name))}`).join(' | ');
  };
  step('evolución del esquema: baseline + paso sobre una base vacía es el catálogo de la baseline nueva', same, same ? '' : !(fresh.ok && whole.ok) ? `${fresh.output.slice(-500)} ${whole.output.slice(-500)}` : shapeDifference());
  // Falsado: sin el paso, las dos formas tienen que diferir, o la comparación no compara nada.
  const withoutStep = 'schema_evolution_without_step';
  fs.writeFileSync(baselineFile, oldBaseline);
  recreate(withoutStep);
  await boot(withoutStep);
  step('falsado: sin el paso, el catálogo difiere de la baseline nueva', shape(withoutStep) !== shape(viaBaseline));
}

/**
 * El paso de esquema de BUILD (inc. 2b del plan 2.26, keel-core/gen/schema-steps.js): una tabla del generador que aparece
 * en un proyecto con base desplegada. `product-catalog` sin idempotencia es la base desplegada (su baseline no tiene
 * `idempotency_record`); el diseño la gana, build reescribe la baseline y escribe el paso leyendo la de disco. El paso
 * tiene que llevar la tabla a la base desplegada, no hacer nada sobre una base nueva (la baseline nueva ya la trae: el
 * mismo catálogo con y sin él) y, falsado, sin él la base desplegada se queda sin la tabla.
 */
async function generatorSchemaStep(env) {
  const TABLE = 'idempotency_record';
  const planOf = (withIdempotency) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
    if (!withIdempotency) for (const operation of Object.values(layers['use-cases'].operations)) delete operation.idempotency;
    return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
  };
  const before = planOf(false);
  const after = planOf(true);
  if (!step('paso de build: la baseline anterior no trae la tabla y la nueva sí', !baselineOf(before.files).includes(TABLE) && baselineOf(after.files).includes(TABLE))) return;

  const dir = path.join(root, 'generator-schema-step');
  const write = (file) => {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  };
  const tidy = async (label) => {
    const tidied = await runAsync('go', ['mod', 'tidy'], { cwd: dir });
    return step(`paso de build: go mod tidy (${label})`, tidied.ok, tidied.ok ? '' : tidied.output.slice(0, 2000));
  };
  for (const file of [...before.files, probeFile(before.model, before.files)]) write(file);
  if (!(await tidy('baseline anterior'))) return;
  const boot = async (db) => {
    const binary = path.join(dir, process.platform === 'win32' ? 'step-probe.test.exe' : 'step-probe.test');
    const built = await runAsync('go', ['test', '-c', '-o', binary, `./${storePath}/`], { cwd: dir });
    if (!built.ok) return built;
    return runAsync(binary, ['-test.run=^$'], { cwd: path.join(dir, storePath), env: env(db) });
  };
  const catalogOf = (db) => (engine === 'mysql' ? mysqlCatalog(db) : catalog(db));
  const hasTable = (db) => catalogOf(db).has(TABLE);
  const shape = (db) =>
    JSON.stringify(
      [...catalogOf(db).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { columns, names }]) => [name, [...columns.entries()].sort(([a], [b]) => a.localeCompare(b)), [...names].sort()])
    );

  const deployed = 'generator_step_deployed';
  recreate(deployed);
  const first = await boot(deployed);
  if (!step('paso de build: la base desplegada aplica la baseline anterior', first.ok && !hasTable(deployed), first.ok ? '' : first.output.slice(-1500))) return;

  // Lo que hace build --refresh: los pasos se deciden leyendo la baseline de DISCO (la que aplicó la base), y después se
  // escribe la nueva.
  const steps = schemaSteps(after.model, dir);
  const added = steps.added[0];
  if (!step('paso de build: build escribe el paso de la tabla', steps.added.length === 1 && steps.tables.includes(TABLE), added ?? 'ninguno')) return;
  for (const file of [...after.files, probeFile(after.model, after.files), ...steps.files]) write(file);
  if (!(await tidy('baseline nueva'))) return;
  const stepped = await boot(deployed);
  step('paso de build: la tabla llega a la base desplegada', stepped.ok && hasTable(deployed), stepped.ok ? '' : stepped.output.slice(-1500));
  const again = await boot(deployed);
  step('paso de build: el redespliegue no vuelve a aplicarlo', again.ok && hasTable(deployed), again.ok ? '' : again.output.slice(-1500));

  // Una base nueva: baseline nueva + paso (que no hace nada) es el catálogo de la baseline nueva sola.
  const withStep = 'generator_step_fresh';
  recreate(withStep);
  const fresh = await boot(withStep);
  const stepFile = path.join(dir, added);
  const stepContent = fs.readFileSync(stepFile, 'utf8');
  fs.rmSync(stepFile);
  const onlyBaseline = 'generator_step_only_baseline';
  recreate(onlyBaseline);
  const whole = await boot(onlyBaseline);
  const same = fresh.ok && whole.ok && shape(withStep) === shape(onlyBaseline);
  step('paso de build: sobre una base nueva no cambia nada', same, same ? '' : !(fresh.ok && whole.ok) ? `${fresh.output.slice(-500)} ${whole.output.slice(-500)}` : 'el catálogo con el paso difiere del de la baseline sola');

  // Falsado: sin el paso, la base desplegada se queda sin la tabla aunque la baseline la traiga.
  const withoutStep = 'generator_step_without';
  for (const file of [...before.files, probeFile(before.model, before.files)]) write(file);
  recreate(withoutStep);
  await boot(withoutStep);
  for (const file of [...after.files, probeFile(after.model, after.files)]) write(file);
  await boot(withoutStep);
  step('falsado: sin el paso de build, la base desplegada no tiene la tabla', !hasTable(withoutStep));
  fs.writeFileSync(stepFile, stepContent);
}

/** Como run, sin bloquear: para ejecutar varios sujetos a la vez. */
function runAsync(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ ok: status === 0, output }));
  });
}

/** Ejecuta work sobre cada elemento, como mucho size a la vez, y devuelve los resultados en el orden de items. */
async function pool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** Las líneas de la salida de go test que explican un rojo. */
function failureLines(output) {
  return output
    .split('\n')
    .filter((line) => /^\s+\S+_test\.go:\d+:|--- FAIL|panic:/.test(line))
    .slice(0, 40)
    .join('\n');
}

/** Crea la base, aplica Up, compara el catálogo con lo esperado, aplica Down y comprueba que queda vacía. */
function applyAndCompare(db, sql, expected) {
  const differences = [];
  const created = recreate(db);
  if (!created.ok) return [`no se pudo crear la base: ${created.output.trim()}`];
  const up = sql.slice(sql.indexOf('-- +goose Up'), sql.indexOf('-- +goose Down'));
  const down = sql.slice(sql.indexOf('-- +goose Down'));
  const applied = execute(db, up);
  if (!applied.ok) return [`Up falla: ${applied.output.trim()}`];

  const actual = engine === 'mysql' ? mysqlCatalog(db) : catalog(db);
  const tables = new Set([...expected.keys(), ...actual.keys()]);
  for (const table of [...tables].sort()) {
    const want = expected.get(table);
    const got = actual.get(table);
    if (!want || !got) {
      differences.push(`${table}: ${want ? 'no está en el motor' : 'no la emite build'}`);
      continue;
    }
    for (const column of new Set([...want.columns.keys(), ...got.columns.keys()])) {
      const w = want.columns.get(column);
      const g = got.columns.get(column);
      if (!w || !g) differences.push(`${table}.${column}: ${w ? 'falta en el motor' : 'sobra en el motor'}`);
      else if (w.nullable !== g.nullable || (w.length ?? null) !== g.length || (w.scale ?? null) !== g.scale) {
        differences.push(`${table}.${column}: emitido ${JSON.stringify({ nullable: w.nullable, length: w.length, scale: w.scale })}, motor ${JSON.stringify(g)}`);
      }
    }
    for (const index of new Set([...want.names, ...got.names])) {
      if (!want.names.has(index)) differences.push(`${table}: +${index} en el motor`);
      else if (!got.names.has(index)) differences.push(`${table}: -${index} en el motor`);
    }
    for (const [index, predicate] of want.predicates) {
      // El motor normaliza el predicado (`((status)::text = 'ACTIVE'::text)`): se compara su literal y su columna.
      const literal = /'([^']*)'/.exec(predicate)?.[1];
      const column = /^"?(\w+)"?/.exec(predicate)?.[1];
      const definition = got.predicates.get(index) ?? '';
      if (!definition.includes(`'${literal}'`) || !definition.includes(column)) differences.push(`${table}: ${index} con el predicado «${definition}», se esperaba «${predicate}»`);
    }
    if (engine === 'mysql') differences.push(...mysqlDifferences(table, want, got));
  }

  const reverted = execute(db, down);
  if (!reverted.ok) differences.push(`Down falla: ${reverted.output.trim()}`);
  else {
    const schema = engine === 'mysql' ? db : 'public';
    const left = query(db, `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${schema}'`);
    if (left.stdout.trim() !== '0') differences.push(`Down deja ${left.stdout.trim()} tabla(s)`);
  }
  drop(db);
  return differences;
}

/**
 * Lo que en MySQL se compara además: el TIPO de cada columna tal como lo guarda el motor (binary(16) para el uuid, la
 * collation sensible de una columna única), y la unicidad condicionada, que aquí es una columna generada `<índice>_flag`
 * con la constante en su expresión y como ÚLTIMA columna de su índice único (MySQL no tiene índices parciales).
 */
function mysqlDifferences(table, want, got) {
  const differences = [];
  for (const [column, w] of want.columns) {
    const g = got.columns.get(column);
    if (!g) continue;
    const [type, collation] = w.type.split(' COLLATE ');
    if (g.type !== type) differences.push(`${table}.${column}: el motor lo guarda como ${g.type}, se emitió ${type}`);
    if (collation && g.collation !== collation) differences.push(`${table}.${column}: collation ${g.collation || 'ninguna'}, se emitió ${collation}`);
  }
  for (const flag of new Set([...want.generated.keys(), ...got.generated.keys()])) {
    const expression = want.generated.get(flag);
    // MySQL guarda la expresión con las comillas escapadas (`\'ACTIVE\'`), y `mysql -B` escapa además las barras: la
    // expresión no lleva ninguna barra propia, así que se quitan todas.
    const live = got.generated.get(flag)?.replace(/\\/g, '');
    if (!expression || live == null) {
      differences.push(`${table}.${flag}: ${expression ? 'falta en el motor' : 'sobra en el motor'}`);
      continue;
    }
    // El motor normaliza la expresión (`(case when (\`status\` = _utf8mb4'ACTIVE') then 1 end)`): su literal y su columna.
    const literal = /'([^']*)'/.exec(expression)?.[1];
    const column = /WHEN `?(\w+)/.exec(expression)?.[1];
    if (!live.includes(`'${literal}'`) || !live.includes(column)) differences.push(`${table}.${flag}: la expresión del motor es «${live}», se emitió «${expression}»`);
    const index = flag.replace(/_flag$/, '');
    const columns = got.indexColumns.get(index);
    if (!columns?.unique || columns.columns.at(-1) !== flag) differences.push(`${index}: no es único con ${flag} al final (${columns ? columns.columns.join(', ') : 'no existe'})`);
  }
  return differences;
}

/** El esquema que ve MySQL: columnas (con su tipo y su collation), las generadas, los nombres de constraint e índice y las columnas de cada índice. */
function mysqlCatalog(db) {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, { columns: new Map(), names: new Set(), predicates: new Map(), generated: new Map(), indexColumns: new Map() });
    return tables.get(name);
  };
  // Sin trim(): se comería los tabuladores de los últimos campos vacíos de la última fila.
  const rows = (sql) =>
    query(db, sql)
      .stdout.split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'));
  // La cota solo de un varchar (binary y longtext también la declaran), y la escala solo de un decimal.
  for (const [tableName, column, nullable, length, scale, type, collation, generation, extra] of rows(
    `SELECT table_name, column_name, is_nullable, IF(data_type = 'varchar', character_maximum_length, ''), IF(data_type = 'decimal', numeric_scale, ''), column_type, IFNULL(collation_name, ''), IFNULL(generation_expression, ''), extra
       FROM information_schema.columns WHERE table_schema = '${db}'`
  )) {
    if (/GENERATED/i.test(extra)) table(tableName).generated.set(column, generation);
    else table(tableName).columns.set(column, { nullable: nullable === 'YES', length: length ? Number(length) : null, scale: scale ? Number(scale) : null, type, collation });
  }
  // La clave primaria se llama siempre PRIMARY: no la nombra ningún generador.
  for (const [tableName, name] of rows(`SELECT table_name, constraint_name FROM information_schema.table_constraints WHERE table_schema = '${db}' AND constraint_type IN ('UNIQUE', 'FOREIGN KEY')`)) {
    table(tableName).names.add(name);
  }
  for (const [tableName, name, columns, nonUnique] of rows(
    `SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index), MIN(non_unique) FROM information_schema.statistics WHERE table_schema = '${db}' AND index_name <> 'PRIMARY' GROUP BY table_name, index_name`
  )) {
    table(tableName).names.add(name);
    table(tableName).indexColumns.set(name, { columns: columns.split(','), unique: nonUnique === '0' });
  }
  return tables;
}

/** El esquema que ve el motor: columnas, nombres de constraint única, FK e índice, y el predicado de cada índice parcial. */
function catalog(db) {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, { columns: new Map(), names: new Set(), predicates: new Map() });
    return tables.get(name);
  };
  const columns = query(
    db,
    `SELECT table_name, column_name, is_nullable, coalesce(character_maximum_length::text, ''), CASE WHEN data_type = 'numeric' THEN numeric_scale::text ELSE '' END
       FROM information_schema.columns WHERE table_schema = 'public'`
  );
  for (const line of columns.stdout.trim().split('\n').filter(Boolean)) {
    const [tableName, column, nullable, length, scale] = line.split('\t');
    table(tableName).columns.set(column, { nullable: nullable === 'YES', length: length ? Number(length) : null, scale: scale ? Number(scale) : null });
  }
  const constraints = query(db, `SELECT conrelid::regclass::text, conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('u', 'f')`);
  for (const line of constraints.stdout.trim().split('\n').filter(Boolean)) {
    const [tableName, name] = line.split('\t');
    table(tableName.replace(/"/g, '')).names.add(name);
  }
  // Un índice que sostiene una constraint única lleva su mismo nombre: el conjunto lo cuenta una vez. La clave primaria
  // no la nombra ningún generador (`<tabla>_pkey`, la del motor).
  const indexes = query(db, `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname NOT LIKE '%\\_pkey'`);
  for (const line of indexes.stdout.trim().split('\n').filter(Boolean)) {
    const [tableName, name, definition] = line.split('\t');
    table(tableName).names.add(name);
    const where = / WHERE (.*)$/.exec(definition)?.[1];
    if (where) table(tableName).predicates.set(name, where);
  }
  return tables;
}
