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
//   reconciliation-expiry     la marca de reconciliación caduca con `<` y no con el `<=` de keel-core (el límite se retiene)
//   reconciliation-threshold  el reclamo de reconciliación se lleva también lo recién encargado (sin el umbral del diseño)
//   reconciliation-head       la lectura de candidatos no excluye los de marca viva (la cabeza de la cola tapa al resto)
//   credential  el finder de resolvedBy busca solo en la primera credencial de la lista
//   send-guard  la guarda del envío (mail.sentBy) escribe dentro de la transacción del caso de uso, no en la suya
//   created-by  el created_by de la autoría de política se reescribe en cada guardado (sujeto product-catalog-authorship)
//   replica-tx  la copia de una réplica se guarda en la transacción de quien la escribe, no en la suya
//   replica-order  el proyector aplica un hecho anterior al guardado
//   replica-batch  la lectura por lote de la réplica no trae nada
//   id-batch    la lectura por lote por id (FindAllById) se deja el primer id
//   fold        TextFold.FoldCase no pliega: la clave natural con `compare` en mayúsculas pasa por otra (catalog-extended)
//   fold-accents  TextFold.FoldCaseAndAccents solo baja la caja: la sombra del filtro conserva los acentos
//   deadlock    el clasificador no reconoce el interbloqueo (40P01): no se repite y sale como 500
//   retry       la transacción no repite el conflicto transitorio: el interbloqueo pierde una de las dos
//   partial-literal  el predicado del índice condicionado con el literal del diseño en minúsculas: no cubre ninguna fila
//   harness-stall          StallInFlight del arnés atasca todas las filas MENOS la pedida
//   harness-missing-clock  InFlightWithoutClock cuenta las que SÍ tienen reloj
//   stale-literal          el reloj rancio del arnés es CURRENT_TIMESTAMP: la fila atascada parece recién entrada
//   uuid-literal           IdLiteral pega el id sin comillas: la sentencia no es SQL válido
// Los cuatro últimos rompen el ARNÉS emitido (Support/FlowTest.cs), y lo ve la sonda del rescate, que ejecuta sus
// sentencias tal como salen.
//
// Necesita el SDK de .NET 10, podman o docker y red la primera vez (NuGet).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planFixture, makeWorkspace, FIXTURES_DIR } from '../test/helpers/workspace.js';
import { dotnetSchema } from '../test/helpers/schema.js';
import { partialIndexSpecs } from 'keel-core/gen';
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
  'claim-stale': ['Repositories/', ' < {staleBefore}', ' <= {claimedAt}'],
  'reconciliation-expiry': ['Persistence/ReconciliationClaimStore.cs', 'claimed_at <= {expired}', 'claimed_at < {expired}'],
  'reconciliation-threshold': ['Repositories/', ' < {unansweredBefore}', ' <= {now}'],
  'reconciliation-head': ['Repositories/', 'c.claimed_at > {claimExpiredBefore})', 'c.claimed_at > {claimExpiredBefore} AND 1 = 0)'],
  credential: ['Repositories/', 'Where(element => element.Value == ', 'Where(element => element.Position == 0 && element.Value == '],
  // La guarda del envío (mail.sentBy, 12e) escribe con el contexto del caso de uso: su marca se deshace con él.
  'send-guard': ['Repositories/', 'var own = scope.ServiceProvider.GetRequiredService<', 'var own = db; _ = scope.ServiceProvider.GetRequiredService<'],
  // La autoría de política (13h): created_by se reescribe en cada guardado.
  'created-by': ['Repositories/', 'if (string.IsNullOrEmpty(row.CreatedBy)) { row.CreatedBy = actor; }', 'row.CreatedBy = actor;'],
  // La réplica (13j): la copia se guarda en la transacción de quien la escribe; el proyector aplica un hecho anterior; el
  // lote no trae nada.
  'replica-tx': ['Repositories/', 'return await own.SaveHere(entity, cancellationToken);', 'return await SaveHere(entity, cancellationToken);'],
  'replica-order': ['Projection/', 'if (snapshot.OccurredAt <= existing.OccurredAt)', 'if (snapshot.OccurredAt == existing.OccurredAt)'],
  'replica-batch': ['Repositories/', 'Where(r => keys.Contains(r.Sku))', 'Where(r => keys.Skip(1).Contains(r.Sku))'],
  // La lectura por lote por id (los embebidos de una página) se deja el primer id.
  'id-batch': ['Repositories/', 'Where(r => keys.Contains(r.Id))', 'Where(r => keys.Skip(1).Contains(r.Id))'],
  // El plegado (DSL 2.14): la sombra con otro valor que el de TextFold.
  fold: ['Persistence/TextFold.cs', 'FoldCase(string? value) => value?.ToLowerInvariant();', 'FoldCase(string? value) => value;'],
  'fold-accents': ['Persistence/TextFold.cs', 'return kept.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant();', 'return value.ToLowerInvariant();'],
  // El reintento del conflicto transitorio: el clasificador o el bucle.
  deadlock: ['Persistence/PersistenceErrors.cs', 'SqlState is PostgresErrorCodes.DeadlockDetected or PostgresErrorCodes.SerializationFailure', 'SqlState is PostgresErrorCodes.SerializationFailure'],
  retry: ['Persistence/PersistenceTransactions.cs', 'attempt < WriteConflictAttempts &&', 'attempt < 1 &&'],
  // El predicado del índice único condicionado con el literal del diseño en minúsculas y no la constante almacenada
  // (el tropiezo de keel-nest): el índice existe, pero no cubre ninguna fila.
  'partial-literal': ['Persistence/Rows/', /HasFilter\("([^"']*)'([^']+)'"\)/g, (_, column, value) => `HasFilter("${column}'${value.toLowerCase()}'")`],
  // El arnés (Support/FlowTest.cs), cuyas sentencias ejecuta la sonda del rescate tal como salen.
  'harness-stall': ['IntegrationTests/Support/FlowTest.cs', ' WHERE id = ", "UPDATE ', ' WHERE id <> ", "UPDATE '],
  'harness-missing-clock': ['IntegrationTests/Support/FlowTest.cs', ' IS NULL"),', ' IS NOT NULL"),'],
  'stale-literal': ['IntegrationTests/Support/FlowTest.cs', "TIMESTAMP '1970-01-01 00:00:00'", 'CURRENT_TIMESTAMP'],
  'uuid-literal': ['IntegrationTests/Support/FlowTest.cs', `? "'" + id + "'"`, '? id']
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
// Los sujetos DERIVADOS: lo que ninguna fixture relacional declara. La autoría de política (13h) solo la declara
// asset-vault, que es documental: aquí, product-catalog con `authorship: all`, como el sujeto de keel-nest.
const DERIVED = {
  'product-catalog-authorship': {
    from: 'product-catalog',
    mutate: (manifest, layers) => {
      // Otro nombre de servicio: los sujetos van en UNA solución, y dos proyectos con el mismo nombre no caben.
      manifest.service.name = 'product-catalog-authorship';
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'all' };
    }
  }
};
const SUBJECTS = only ? [only] : [...relational, ...Object.keys(DERIVED)];

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
  // El sabotaje se aplica EN MEMORIA y antes de generar las sondas, que leen del arnés emitido las sentencias del rescate:
  // aplicado después, sobre el disco, un sabotaje del arnés no llegaba a lo que db-check ejecuta.
  const [suffix, from, to] = sabotage ? (SABOTAGES[sabotage] ?? []) : [];
  if (sabotage && !suffix) {
    console.error(`No hay ningún sabotaje '${sabotage}'.`);
    throw new Abort(2);
  }
  let applied = 0;
  for (const name of SUBJECTS) {
    const derived = DERIVED[name];
    const { model, files: planned } = await planFixture(derived?.from ?? name, { mutate: derived?.mutate ?? null });
    const files = sabotage
      ? planned.map((file) => {
          // Lo de `src/` por sufijo; el arnés, solo si el sabotaje lo nombra (sus sufijos llevan `IntegrationTests/`).
          const inScope = file.path.includes(suffix) && (file.path.startsWith('src/') || suffix.includes('IntegrationTests/'));
          if (!inScope || typeof file.content !== 'string') return file;
          const content = typeof from === 'string' ? file.content.replaceAll(from, to) : file.content.replace(from, to);
          if (content === file.content) return file;
          applied += 1;
          return { ...file, content };
        })
      : planned;
    const probes = probeProject(model, { files });
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
    if (applied === 0) {
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
  }
  // El predicado de cada índice único condicionado, contra el DISEÑO (keel-core), no contra lo emitido: comparado con el
  // mapeo, un predicado mal emitido se daba la razón a sí mismo.
  for (const spec of partialIndexSpecs(model, 'postgresql')) {
    const def = indexes.get(spec.name) ?? '';
    if (!/ WHERE /.test(def) || !def.includes(`'${spec.stored}'`)) problems.push(`${spec.name}: sin el predicado ${spec.predicate} (${def || 'no existe'})`);
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

if (aborted) process.exit(aborted);
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ndb-check: ${results.length}/${results.length} en verde.` : `\ndb-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);

