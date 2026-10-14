#!/usr/bin/env node
// La persistencia de keel-dotnet contra un MOTOR REAL: lo único que juzga si lo emitido sostiene lo que el diseño
// pidió. `cs-check` dice que compila, que EF construye el modelo y que el servidor arranca; esto dice que los
// adaptadores generados guardan y leen sin perder nada y que el esquema que crea EF es el del diseño. Es el
// db-check de keel-nest, sobre PostgreSQL (el único motor que genera keel-dotnet).
//
// Por sujeto (las fixtures relacionales, que cubren value objects aplanados, decimales con escala, enums, json,
// listas de escalares y de value objects, hijas uni y bidireccionales, sombras plegadas, claves naturales, FK entre
// agregados y bloqueo optimista):
//
//   sondas   un proyecto xUnit generado a partir del modelo (scripts/lib/db-probes.js) que EJECUTA los adaptadores:
//            ida y vuelta, la fila en crudo, la versión obsoleta, la clave natural repetida con su error declarado,
//            la cota que rechaza el motor, la página y el borrado del grafo;
//   esquema  el catálogo del motor (information_schema, pg_indexes, pg_constraint) contra el mapeo emitido: cada
//            columna con su nulabilidad, su cota y su escala; cada índice, constraint y FK con SU NOMBRE, que es lo
//            que lee el traductor de errores; y el predicado de cada índice único condicionado.
//
//   node packages/keel-dotnet/scripts/db-check.js [--keep] [--sabotage=<id>] [--only=<fixture>]
//   npm run db-check --workspace packages/keel-dotnet
//
// --sabotage=<id> rompe lo emitido CONSERVANDO LA FORMA (sigue compilando), y el check tiene que salir rojo en su
// comprobación y solo en ella:
//   version     el adaptador no fija la versión leída como valor original del token (la versión obsoleta pasa)
//   enum        el conversor guarda el miembro de C# y no la constante del diseño
//   constraint  el traductor no reconoce ninguna constraint (la clave repetida sale como 409 sin code)
//   index       los índices únicos salen con OTRO nombre: el traductor ya no los reconoce
//   idempotency el adaptador del registro no reconoce el choque de la clave primaria (la carrera sale sin su code)
//   lease       el lease del reclamo vence en el pasado (la pasada siguiente vuelve a ver la fila en vuelo)
//   skip-locked el reclamo del outbox espera al lock de otra réplica en vez de saltarse la fila
//   guard       la guarda de procesados no reconoce el choque de la clave (la carrera sale como error)
//   purge       la purga del outbox corta por created_at y no por published_at (se lleva lo publicado ayer)
//   purge-batch cada lote borra hasta el corte y no hasta su frontera (la pasada deja de ir por lotes)
//   claim-skip-locked  el reclamo de un barrido espera al lock de otra réplica en vez de saltarse la fila
//   claim-stale        el rescate se lleva todo lo que está en vuelo, también lo recién entrado (sin cota temporal)
//
// Necesita el SDK de .NET 10, podman o docker y red la primera vez (NuGet).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planFixture, makeWorkspace, FIXTURES_DIR } from '../test/helpers/workspace.js';
import { dotnetSchema } from '../test/helpers/schema.js';
import { expectedSchemaNames } from '../src/scaffold/persistence.js';
import { probeProject, databaseOf } from './lib/db-probes.js';
import { resolveRuntime, startDatabase, stopDatabase, run } from '../../keel-nest/scripts/lib/database-container.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const only = args.find((arg) => arg.startsWith('--only='))?.split('=')[1] ?? null;

// Los sabotajes: [archivo (sufijo, en todos los sujetos), texto, sustituto].
const SABOTAGES = {
  version: ['Repositories/', 'Property(r => r.LockVersion).OriginalValue = expected;', 'Property(r => r.LockVersion).OriginalValue = row.LockVersion;'],
  enum: ['Persistence/EnumColumns.cs', 'new(value => ', 'new(value => value.ToString() ?? '],
  constraint: ['Persistence/PersistenceErrors.cs', 'ConstraintToError.TryGetValue(constraint, out var build)', 'ConstraintToError.TryGetValue(constraint + "-", out var build)'],
  index: ['Persistence/Rows/', '.IsUnique().HasDatabaseName("uk_', '.IsUnique().HasDatabaseName("zz_'],
  idempotency: ['Persistence/IdempotencyStore.cs', '"idempotency_record_pkey"', '"idempotency_record_pk"'],
  lease: ['Outbox/OutboxRelayStore.cs', 'now.AddMilliseconds(claimTimeoutMs)', 'now.AddMilliseconds(-claimTimeoutMs)'],
  'skip-locked': ['Outbox/OutboxRelayStore.cs', 'FOR UPDATE SKIP LOCKED', 'FOR UPDATE'],
  guard: ['Idempotency/IdempotencyGuard.cs', 'PostgresErrorCodes.UniqueViolation', 'PostgresErrorCodes.ForeignKeyViolation'],
  purge: ['Purge/TablePurges.cs', 'published_at IS NOT NULL AND published_at < {cutoff}', 'published_at IS NOT NULL AND created_at < {cutoff}'],
  'purge-batch': ['Purge/TablePurges.cs', ' <= {upTo.ToUniversalTime()}', ' <= {cutoff}'],
  'claim-skip-locked': ['Repositories/', 'LIMIT {batch} FOR UPDATE SKIP LOCKED', 'LIMIT {batch} FOR UPDATE'],
  'claim-stale': ['Repositories/', ' < {staleBefore}', ' <= {claimedAt}']
};

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function dotnet(cwd, dotnetArgs, env = {}) {
  const result = spawnSync('dotnet', dotnetArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env },
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const relational = fs.readdirSync(FIXTURES_DIR).filter((name) => {
  const file = path.join(FIXTURES_DIR, name, 'persistence.keel.yaml');
  return fs.existsSync(file) && !/model:\s*document/.test(fs.readFileSync(file, 'utf8'));
});
const SUBJECTS = only ? [only] : relational;

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);
let database;
try {
  database = await startDatabase(runtime, 'postgresql');
  step('PostgreSQL en contenedor', true, `puerto ${database.port}`);
} catch (error) {
  step('PostgreSQL en contenedor', false, error.message);
  process.exit(1);
}

const root = makeWorkspace('keel-dotnet-db-check-');
const subjects = [];
// Salir a mitad (un sabotaje que no se aplica, lo emitido que no compila) pasa por el `finally`, que para la base: un
// process.exit dentro del try se lo saltaba y dejaba el contenedor vivo (medido con un sabotaje que no compilaba).
class Abort extends Error {
  constructor(code) {
    super(`db-check abortado (${code})`);
    this.code = code;
  }
}
let aborted = 0;
try {
  // ─── Los sujetos y sus sondas, en UNA solución ─────────────────────────────────────────────────
  const projects = [];
  for (const name of SUBJECTS) {
    const { model, files } = await planFixture(name);
    const probes = probeProject(model);
    for (const file of [...files, ...probes.files]) {
      const target = path.join(root, name, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
      if (file.path === 'global.json') fs.writeFileSync(path.join(root, 'global.json'), file.content);
    }
    projects.push(`${name}/tests/${probes.name}/${probes.name}.csproj`);
    subjects.push({ name, model, files, probes });
  }
  if (sabotage) {
    const [suffix, from, to] = SABOTAGES[sabotage] ?? [];
    let applied = 0;
    for (const { name } of subjects) {
      for (const file of walk(path.join(root, name, 'src'))) {
        if (!file.replaceAll('\\', '/').includes(suffix)) continue;
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes(from)) {
          fs.writeFileSync(file, content.replaceAll(from, to));
          applied += 1;
        }
      }
    }
    if (!suffix || applied === 0) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
      throw new Abort(2);
    }
    console.log(`(sabotaje: ${sabotage}, en ${applied} archivo(s))`);
  }
  fs.writeFileSync(path.join(root, 'DbCheck.slnx'), ['<Solution>', ...projects.map((p) => `  <Project Path="${p}" />`), '</Solution>', ''].join('\n'));

  const built = dotnet(root, ['build', 'DbCheck.slnx', '-c', 'Release']);
  if (!step(`los ${subjects.length} sujetos y sus sondas compilan`, built.ok)) {
    console.error([...new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)))].slice(0, 60).join('\n'));
    throw new Abort(1);
  }

  // ─── Las sondas, contra el motor ──────────────────────────────────────────────────────────────
  const connection = `Host=127.0.0.1;Port=${database.port};Database=${database.user};Username=${database.user};Password=${database.password}`;
  const tested = dotnet(root, ['test', '--solution', 'DbCheck.slnx', '--no-build', '-c', 'Release'], { DB_CHECK_CONNECTION: connection });
  const failures = tested.output.split('\n').filter((line) => /^\s*(con errores|failed)\s/i.test(line)).map((line) => line.trim());
  for (const subject of subjects) {
    // Con el espacio delante: `Catalog.DbProbes.` es subcadena de `ProductCatalog.DbProbes.`.
    const mine = failures.filter((line) => line.includes(` ${subject.probes.name}.`));
    const ran = tested.output.includes(`${subject.probes.name}.dll`);
    step(`${subject.name}: los adaptadores guardan, leen y traducen contra PostgreSQL`, ran && mine.length === 0, ran ? mine.join('; ') : 'las sondas no se ejecutaron');
  }
  if (!tested.ok && failures.length === 0) console.error(tested.output.split('\n').slice(-40).join('\n'));
  if (process.env.DB_CHECK_VERBOSE) console.log(tested.output);
  // Que no falle ninguna no basta: tienen que haberse ejecutado (el total del resumen de dotnet test).
  const total = Number(/total: (\d+)/.exec(tested.output)?.[1] ?? 0);
  step('las sondas se ejecutaron', total > 0, `${total} sondas`);

  // ─── El esquema que creó EF, contra lo emitido ─────────────────────────────────────────────────
  for (const subject of subjects) step(`${subject.name}: el catálogo del motor es el esquema emitido`, ...schemaCheck(subject));
} catch (error) {
  if (!(error instanceof Abort)) throw error;
  aborted = error.code;
} finally {
  stopDatabase(runtime, database);
  if (keep) {
    const kept = fs.mkdtempSync(path.join(path.dirname(root), 'keel-dotnet-db-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Sujetos conservados en ${kept}`);
  }
}

/** psql en el contenedor, sobre la base del sujeto; una fila por línea, columnas separadas por |. */
function psql(databaseName, sql) {
  const result = run(runtime, ['exec', database.name, 'psql', '-U', database.user, '-d', databaseName, '-At', '-F', '|', '-c', sql]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('|'));
}

function schemaCheck({ model, files }) {
  const problems = [];
  const db = databaseOf(model);
  let columns;
  let names;
  let indexes;
  try {
    columns = psql(db, "SELECT table_name, column_name, is_nullable, coalesce(character_maximum_length::text, ''), coalesce(numeric_scale::text, '') FROM information_schema.columns WHERE table_schema = 'public'");
    names = new Set([
      ...psql(db, "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'").map(([name]) => name),
      ...psql(db, "SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'").map(([name]) => name)
    ]);
    indexes = new Map(psql(db, "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'").map(([name, def]) => [name, def]));
  } catch (error) {
    return [false, `no se pudo leer el catálogo: ${error.message.split('\n')[0]}`];
  }
  const live = new Map(columns.map(([table, column, nullable, length, scale]) => [`${table}.${column}`, { nullable: nullable === 'YES', length: length === '' ? null : Number(length), scale: scale === '' ? null : Number(scale) }]));
  for (const [table, spec] of dotnetSchema(files)) {
    for (const [column, want] of spec.columns) {
      const have = live.get(`${table}.${column}`);
      if (!have) problems.push(`falta ${table}.${column}`);
      else {
        if (have.nullable !== want.nullable) problems.push(`${table}.${column}: ${want.nullable ? 'debería admitir null' : 'debería ser NOT NULL'}`);
        if (want.length != null && have.length !== want.length) problems.push(`${table}.${column}: cota ${have.length}, no ${want.length}`);
        if (want.scale != null && have.scale !== want.scale) problems.push(`${table}.${column}: escala ${have.scale}, no ${want.scale}`);
      }
    }
    for (const [index, predicate] of spec.predicates) {
      const constant = /'([^']+)'/.exec(predicate)?.[1];
      const def = indexes.get(index) ?? '';
      if (!/ WHERE /.test(def) || (constant && !def.includes(`'${constant}'`))) problems.push(`${index}: sin el predicado ${predicate} (${def || 'no existe'})`);
    }
  }
  for (const name of expectedSchemaNames(model)) {
    // Una tabla es un nombre más del diseño, pero no un índice ni una constraint.
    if (live.has(`${name}.id`) || [...live.keys()].some((key) => key.startsWith(`${name}.`))) continue;
    if (!names.has(name)) problems.push(`falta ${name}`);
  }
  const foreign = [...names].filter((name) => /^(PK|FK|IX|AK)_/.test(name));
  if (foreign.length > 0) problems.push(`nombres puestos por EF: ${foreign.join(', ')}`);
  return [problems.length === 0, problems.slice(0, 8).join('; ')];
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

if (aborted) process.exit(aborted);
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ndb-check: ${results.length}/${results.length} en verde.` : `\ndb-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);

