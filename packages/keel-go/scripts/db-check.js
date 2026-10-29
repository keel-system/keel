#!/usr/bin/env node
// La persistencia de keel-go contra un PostgreSQL REAL. En el tramo 6a mide el ESQUEMA: la migración baseline que
// escribe build para cada fixture relacional se aplica a una base vacía, y el catálogo del motor (information_schema,
// pg_constraint, pg_indexes) tiene que decir lo mismo que el SQL emitido —el que compara con keel-spring la paridad
// de test/schema-parity.test.js—: las mismas tablas y columnas, con su nulabilidad, cota y escala, los mismos nombres
// de constraint, índice y FK, y cada índice condicionado con su predicado. Después, la vuelta atrás de goose (Down)
// tiene que dejar la base vacía. Los repositorios y la transacción llegan en el tramo 6c.
//
// Por qué hace falta además de la paridad: la paridad lee el texto. Un nombre de más de 63 caracteres que PostgreSQL
// trunca, una palabra reservada sin citar o un predicado que el motor no acepta pasan la paridad y rompen aquí.
//
//   node packages/keel-go/scripts/db-check.js [--only=<fixture>] [--keep]
//   npm run db-check --workspace packages/keel-go
//
// Falsado: se aplica una migración sin un índice de FK, y la comparación tiene que verlo.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';
import { goView } from '../test/helpers/contract.js';
import { baselineOf, goSchema } from '../test/helpers/schema.js';

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null;
const keep = process.argv.includes('--keep');
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function run(command, args, input = undefined) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function containerRuntime() {
  for (const candidate of ['podman', 'docker']) if (run(candidate, ['--version']).ok) return candidate;
  return null;
}

const runtime = containerRuntime();
if (!step('podman o docker disponible', Boolean(runtime))) process.exit(1);

const engine = DATABASES.postgresql;
const container = `keel-go-db-check-${process.pid}`;
const started = run(runtime, ['run', '-d', '--rm', '--name', container, '-e', `POSTGRES_PASSWORD=${engine.password}`, engine.image]);
if (!step(`PostgreSQL en marcha (${engine.image})`, started.ok, started.ok ? '' : started.output.trim())) process.exit(1);

const psql = (db, sql, flags = []) => run(runtime, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...flags, '-f', '-'], sql);
const query = (db, sql) => psql(db, sql, ['-A', '-t', '-F', '\t']);

try {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !query('postgres', 'SELECT 1').ok) await new Promise((resolve) => setTimeout(resolve, 500));
  if (!step('PostgreSQL acepta conexiones', query('postgres', 'SELECT 1').ok)) process.exit(1);

  const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
    const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
    return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8')) && (!only || name === only);
  });

  for (const name of relational) {
    const files = planService({ ...goView(name), workspace: FIXTURES_DIR }).files;
    const sql = baselineOf(files);
    const differences = applyAndCompare(name.replace(/-/g, '_'), sql, goSchema(files));
    step(`${name}: el catálogo del motor es el esquema emitido, y Down lo deja vacío`, differences.length === 0, differences.slice(0, 8).join(' | '));
  }

  // Falsado: sin un índice de FK, la comparación tiene que verlo. Si el sabotaje ya no se aplica, el paso sale rojo.
  const subject = relational.find((name) => /^CREATE INDEX ix_/m.test(baselineOf(planService({ ...goView(name), workspace: FIXTURES_DIR }).files)));
  if (subject) {
    const files = planService({ ...goView(subject), workspace: FIXTURES_DIR }).files;
    const sql = baselineOf(files);
    const sabotaged = sql.replace(/^CREATE INDEX ix_\w+ ON .*;\n\n?/m, '');
    const differences = sabotaged === sql ? [] : applyAndCompare(`${subject.replace(/-/g, '_')}_sabotaged`, sabotaged, goSchema(files));
    step(`falsado: ${subject} sin un índice de FK → la comparación lo ve`, differences.some((d) => /ix_/.test(d)), differences.slice(0, 3).join(' | ') || 'no vio nada');
  }
} finally {
  if (keep) console.log(`\nPostgreSQL sigue en marcha: ${runtime} exec -it ${container} psql -U postgres`);
  else run(runtime, ['rm', '-f', container]);
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ndb-check: ${results.length}/${results.length} en verde.` : `\ndb-check: ${failed} paso(s) en rojo.`);
process.exitCode = failed === 0 ? 0 : 1;

/** Crea la base, aplica Up, compara el catálogo con lo esperado, aplica Down y comprueba que queda vacía. */
function applyAndCompare(db, sql, expected) {
  const differences = [];
  const created = psql('postgres', `DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db};`);
  if (!created.ok) return [`no se pudo crear la base: ${created.output.trim()}`];
  const up = sql.slice(sql.indexOf('-- +goose Up'), sql.indexOf('-- +goose Down'));
  const down = sql.slice(sql.indexOf('-- +goose Down'));
  const applied = psql(db, up);
  if (!applied.ok) return [`Up falla: ${applied.output.trim()}`];

  const actual = catalog(db);
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
  }

  const reverted = psql(db, down);
  if (!reverted.ok) differences.push(`Down falla: ${reverted.output.trim()}`);
  else {
    const left = query(db, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'");
    if (left.stdout.trim() !== '0') differences.push(`Down deja ${left.stdout.trim()} tabla(s)`);
  }
  psql('postgres', `DROP DATABASE IF EXISTS ${db};`);
  return differences;
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
