#!/usr/bin/env node
// La persistencia de keel-dotnet contra un MOTOR REAL: lo único que juzga si lo emitido sostiene lo que el diseño
// pidió. `cs-check` dice que compila, que EF construye el modelo y que el servidor arranca; esto dice que los
// adaptadores generados guardan y leen sin perder nada y que el esquema que crea EF es el del diseño. Es el
// db-check de keel-nest, sobre los dos motores relacionales que genera keel-dotnet: PostgreSQL y MySQL.
//
// Por sujeto (las fixtures relacionales, que cubren value objects aplanados, decimales con escala, enums, json,
// listas de escalares y de value objects, hijas uni y bidireccionales, sombras plegadas, claves naturales, FK entre
// agregados y bloqueo optimista), y por motor:
//
//   sondas   un proyecto xUnit generado a partir del modelo (scripts/lib/db-probes.js) que EJECUTA los adaptadores:
//            ida y vuelta, la fila en crudo (y en MySQL, el id en los bytes de UUID_TO_BIN), la versión obsoleta, la
//            clave natural repetida con su error declarado, la cota que rechaza el motor, la página y el borrado del grafo;
//   esquema  el catálogo del motor contra el mapeo emitido: cada columna con su nulabilidad, su cota y su escala (y en
//            MySQL su collation y su tipo binary(16)); cada índice, constraint y FK con SU NOMBRE, que es lo que lee el
//            traductor de errores; y la unicidad condicionada contra el DISEÑO: el predicado del índice parcial en
//            PostgreSQL, la columna generada y su lugar en el índice único en MySQL.
//
//   node packages/keel-dotnet/scripts/db-check.js [--keep] [--sabotage=<id>] [--only=<fixture>] [--database=postgresql|mysql]
//   npm run db-check --workspace packages/keel-dotnet
//
// Sin --database, los dos motores, uno detrás de otro.
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
//   created-by-empty  la autoría DECLARADA que el alta deja vacía se guarda vacía, sin el actor (sujeto mailer-author)
//   replica-tx  la copia de una réplica se guarda en la transacción de quien la escribe, no en la suya
//   replica-order  el proyector aplica un hecho anterior al guardado
//   replica-batch  la lectura por lote de la réplica no trae nada
//   id-batch    la lectura por lote por id (FindAllById) se deja el primer id
//   fold        TextFold.FoldCase no pliega: la clave natural con `compare` en mayúsculas pasa por otra (catalog-extended)
//   fold-accents  TextFold.FoldCaseAndAccents solo baja la caja: la sombra del filtro conserva los acentos
//   deadlock    el clasificador no reconoce el interbloqueo (40P01 / 1213): no se repite y sale como 500
//   retry       la transacción no repite el conflicto transitorio: el interbloqueo pierde una de las dos
//   partial-literal  el predicado del índice condicionado con el literal del diseño en minúsculas: no cubre ninguna fila
//   harness-stall          StallInFlight del arnés atasca todas las filas MENOS la pedida
//   harness-missing-clock  InFlightWithoutClock cuenta las que SÍ tienen reloj
//   stale-literal          el reloj rancio del arnés es CURRENT_TIMESTAMP: la fila atascada parece recién entrada
//   uuid-literal           IdLiteral pega el id sin envolver (PostgreSQL: sin comillas, no es SQL; MySQL: como TEXTO,
//                          que no casa con el binary(16) ni falla)
// Los cuatro últimos rompen el ARNÉS emitido (Support/FlowTest.cs), y lo ve la sonda del rescate, que ejecuta sus
// sentencias tal como salen. Solo en MySQL:
//   guid-format      el registro fija el formato de uuid de .NET (orden mixto): la fila deja de llevar los bytes de UUID_TO_BIN
//   discriminator    el índice condicionado pierde su columna generada: la unicidad pasa a ser sobre todas las filas
//   collation        la columna única pierde utf8mb4_bin: el motor pliega mayúsculas al comparar
//   read-committed   los reclamos corren en el REPEATABLE READ por defecto: toman los huecos entre claves
//
// Necesita el SDK de .NET 10, podman o docker y red la primera vez (NuGet).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planFixture, makeWorkspace, FIXTURES_DIR, UNCOVERED_BRANCHES } from '../test/helpers/workspace.js';
import { dotnetSchema } from '../test/helpers/schema.js';
import { partialIndexSpecs, discriminatorColumn, persistedMembers } from 'keel-core/gen';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { expectedSchemaNames } from '../src/scaffold/persistence.js';
import { probeProject, databaseOf } from './lib/db-probes.js';
import { resolveRuntime, startDatabase, stopDatabase, run } from '../../keel-nest/scripts/lib/database-container.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const only = args.find((arg) => arg.startsWith('--only='))?.split('=')[1] ?? null;
const ENGINES = ['postgresql', 'mysql'];
const requested = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? null;
if (requested && !ENGINES.includes(requested)) {
  console.error(`--database=${requested}: keel-dotnet genera ${ENGINES.join(' y ')}.`);
  process.exit(2);
}

// Los sabotajes: [archivo (sufijo, en todos los sujetos), texto, sustituto], o uno por motor cuando lo emitido cambia.
const SABOTAGES = {
  version: ['Repositories/', 'Property(r => r.LockVersion).OriginalValue = expected;', 'Property(r => r.LockVersion).OriginalValue = row.LockVersion;'],
  enum: ['Persistence/EnumColumns.cs', 'new(value => ', 'new(value => value.ToString() ?? '],
  constraint: ['Persistence/PersistenceErrors.cs', 'ConstraintToError.TryGetValue(constraint, out var build)', 'ConstraintToError.TryGetValue(constraint + "-", out var build)'],
  index: ['Persistence/Rows/', '.IsUnique().HasDatabaseName("uk_', '.IsUnique().HasDatabaseName("zz_'],
  idempotency: ['Persistence/IdempotencyStore.cs', 'IsPrimaryKeyViolation(error, "idempotency_record")', 'IsPrimaryKeyViolation(error, "idempotency_recor")'],
  lease: ['Outbox/OutboxRelayStore.cs', 'now.AddMilliseconds(claimTimeoutMs)', 'now.AddMilliseconds(-claimTimeoutMs)'],
  'skip-locked': ['Outbox/OutboxRelayStore.cs', 'FOR UPDATE SKIP LOCKED', 'FOR UPDATE'],
  guard: ['Idempotency/IdempotencyGuard.cs', 'PersistenceErrors.IsUniqueViolation(error)', 'PersistenceErrors.IsPrimaryKeyViolation(error, "nadie")'],
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
  // La autoría declarada: el "" del alta cuenta como valor (el `??=` de la corrida catalog-dotnet).
  'created-by-empty': ['Repositories/', 'if (string.IsNullOrEmpty(row.CreatedBy)) { row.CreatedBy = actor; }', 'row.CreatedBy ??= actor;'],
  // La réplica (13j): la copia se guarda en la transacción de quien la escribe; el proyector aplica un hecho anterior; el
  // lote no trae nada.
  'replica-tx': ['Repositories/', 'return await own.SaveHere(entity, cancellationToken);', 'return await SaveHere(entity, cancellationToken);'],
  'replica-order': ['Projection/', 'if (snapshot.OccurredAt <= existing.OccurredAt)', 'if (snapshot.OccurredAt == existing.OccurredAt)'],
  'replica-batch': ['Repositories/', 'Where(r => keys.Contains(r.Sku))', 'Where(r => keys.Skip(1).Contains(r.Sku))'],
  // La lectura por lote por id (los embebidos de una página) se deja el primer id.
  'id-batch': ['Repositories/', 'Where(r => keys.Contains(r.Id))', 'Where(r => keys.Skip(1).Contains(r.Id))'],
  // Los finders (DSL 2.22): el where que no filtra, el extremo inclusivo que deja de serlo y el texto sin plegar.
  'finder-where': ['Repositories/', 'var query = Graph().AsNoTracking().Where(r => ', 'var query = Graph().AsNoTracking().Where(r => true || '],
  'finder-range': ['Repositories/', /(query = query\.Where\(r => r\.\w+) >= /g, '$1 > '],
  'finder-fold': ['Repositories/', /var (\w+)Folded = TextFold\.\w+\((\w+)\);/g, 'var $1Folded = $2;'],
  // El plegado (DSL 2.14): la sombra con otro valor que el de TextFold.
  fold: ['Persistence/TextFold.cs', 'FoldCase(string? value) => value?.ToLowerInvariant();', 'FoldCase(string? value) => value;'],
  'fold-accents': ['Persistence/TextFold.cs', 'return kept.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant();', 'return value.ToLowerInvariant();'],
  // El reintento del conflicto transitorio: el clasificador o el bucle.
  deadlock: {
    postgresql: ['Persistence/PersistenceErrors.cs', 'SqlState is PostgresErrorCodes.DeadlockDetected or PostgresErrorCodes.SerializationFailure', 'SqlState is PostgresErrorCodes.SerializationFailure'],
    mysql: ['Persistence/PersistenceErrors.cs', 'EngineError(error)?.Number is 1213;', 'EngineError(error)?.Number is -1213;']
  },
  retry: ['Persistence/PersistenceTransactions.cs', 'attempt < WriteConflictAttempts &&', 'attempt < 1 &&'],
  // El predicado del índice único condicionado con el literal del diseño en minúsculas y no la constante almacenada
  // (el tropiezo de keel-nest): el índice existe, pero no cubre ninguna fila.
  'partial-literal': {
    postgresql: ['Persistence/Rows/', /HasFilter\("([^"']*)'([^']+)'"\)/g, (_, column, value) => `HasFilter("${column}'${value.toLowerCase()}'")`],
    mysql: ['Persistence/Rows/', /HasComputedColumnSql\("CASE WHEN ([^"']*)'([^']+)' THEN 1 END"/g, (_, column, value) => `HasComputedColumnSql("CASE WHEN ${column}'${value.toLowerCase()}' THEN 1 END"`]
  },
  // El arnés (Support/FlowTest.cs), cuyas sentencias ejecuta la sonda del rescate tal como salen.
  'harness-stall': ['IntegrationTests/Support/FlowTest.cs', ' WHERE id = ", "UPDATE ', ' WHERE id <> ", "UPDATE '],
  'harness-missing-clock': ['IntegrationTests/Support/FlowTest.cs', ' IS NULL"),', ' IS NOT NULL"),'],
  'stale-literal': ['IntegrationTests/Support/FlowTest.cs', "TIMESTAMP '1970-01-01 00:00:00'", 'CURRENT_TIMESTAMP'],
  'uuid-literal': {
    postgresql: ['IntegrationTests/Support/FlowTest.cs', `? "'" + id + "'"`, '? id'],
    // El literal en texto plano contra binary(16): el WHERE no casa con ninguna fila y tampoco falla.
    mysql: ['IntegrationTests/Support/FlowTest.cs', `? "UUID_TO_BIN('" + id + "')"`, `? "'" + id + "'"`]
  },
  // Solo MySQL: el formato del uuid, la columna generada de la unicidad condicionada, la collation y el aislamiento.
  'guid-format': { mysql: ['Persistence/PersistenceRegistration.cs', 'GuidFormat = MySqlGuidFormat.Binary16', 'GuidFormat = MySqlGuidFormat.LittleEndianBinary16'] },
  discriminator: { mysql: ['Persistence/Rows/', /, "(\w+)_flag"\], /g, '], '] },
  collation: { mysql: ['Persistence/Rows/', '.UseCollation("utf8mb4_bin")', ''] },
  'read-committed': { mysql: ['Persistence/PersistenceTransactions.cs', 'ClaimIsolation = IsolationLevel.ReadCommitted;', 'ClaimIsolation = null;'] }
};

/** El sabotaje para un motor: [sufijo, texto, sustituto], o null si no aplica a ese motor. */
function sabotageFor(id, engine) {
  const entry = SABOTAGES[id];
  if (!entry) return null;
  return Array.isArray(entry) ? entry : (entry[engine] ?? null);
}

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
  },
  // `optimisticLocking: declared`: el Save con la versión que declara el dominio (el MISMO parche que compila cs-check).
  ...uncoveredBranch('product-catalog-declared-lock'),
  // `audit.authorship: declared`: el alta deja la autoría vacía y el adaptador la estampa (raíz e hija).
  ...uncoveredBranch('mailer-author'),
  // El finder de una LISTA con un subcampo de value object y el texto por prefijo (DSL 2.22).
  ...uncoveredBranch('product-catalog-finder')
};

function uncoveredBranch(name) {
  const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);
  return { [name]: { from: branch.from, mutate: (manifest, layers) => branch.mutate(manifest, layers, name) } };
}
const SUBJECTS = only ? [only] : [...relational, ...Object.keys(DERIVED)];

if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'.`);
  process.exit(2);
}
// Un sabotaje de un solo motor corre solo en ese motor.
const engines = (requested ? [requested] : ENGINES).filter((engine) => !sabotage || sabotageFor(sabotage, engine));
if (engines.length === 0) {
  console.error(`El sabotaje '${sabotage}' no aplica a ${requested}.`);
  process.exit(2);
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);

// Salir a mitad (un sabotaje que no se aplica, lo emitido que no compila) pasa por el `finally`, que para la base: un
// process.exit dentro del try se lo saltaba y dejaba el contenedor vivo (medido con un sabotaje que no compilaba).
class Abort extends Error {
  constructor(code) {
    super(`db-check abortado (${code})`);
    this.code = code;
  }
}
let aborted = 0;
for (const engine of engines) {
  if (aborted) break;
  aborted = await checkEngine(engine);
}

async function checkEngine(engine) {
  const label = DATABASES[engine].label;
  let database;
  try {
    database = await startDatabase(runtime, engine);
    step(`${label} en contenedor`, true, `puerto ${database.port}`);
  } catch (error) {
    step(`${label} en contenedor`, false, error.message);
    return 1;
  }
  const root = makeWorkspace(`keel-dotnet-db-check-${engine}-`);
  const subjects = [];
  try {
    // ─── Los sujetos y sus sondas, en UNA solución ─────────────────────────────────────────────────
    const projects = [];
    // El sabotaje se aplica EN MEMORIA y antes de generar las sondas, que leen del arnés emitido las sentencias del rescate:
    // aplicado después, sobre el disco, un sabotaje del arnés no llegaba a lo que db-check ejecuta.
    const [suffix, from, to] = sabotage ? sabotageFor(sabotage, engine) : [];
    let applied = 0;
    for (const name of SUBJECTS) {
      const derived = DERIVED[name];
      const stack = engine === 'postgresql' ? null : { database: engine };
      const { model, files: planned } = await planFixture(derived?.from ?? name, { mutate: derived?.mutate ?? null, stack });
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
        console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy sobre ${label} (¿cambió el texto?).`);
        throw new Abort(2);
      }
      console.log(`(sabotaje: ${sabotage}, en ${applied} archivo(s) de ${label})`);
    }
    fs.writeFileSync(path.join(root, 'DbCheck.slnx'), ['<Solution>', ...projects.map((p) => `  <Project Path="${p}" />`), '</Solution>', ''].join('\n'));

    const built = dotnet(root, ['build', 'DbCheck.slnx', '-c', 'Release']);
    if (!step(`${label}: los ${subjects.length} sujetos y sus sondas compilan`, built.ok)) {
      console.error([...new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)))].slice(0, 60).join('\n'));
      throw new Abort(1);
    }

    // ─── Las sondas, contra el motor ──────────────────────────────────────────────────────────────
    const connection = adminConnection(engine, database);
    const tested = dotnet(root, ['test', '--solution', 'DbCheck.slnx', '--no-build', '-c', 'Release'], { DB_CHECK_CONNECTION: connection });
    const failures = tested.output.split('\n').filter((line) => /^\s*(con errores|failed)\s/i.test(line)).map((line) => line.trim());
    for (const subject of subjects) {
      // Con el espacio delante: `Catalog.DbProbes.` es subcadena de `ProductCatalog.DbProbes.`.
      const mine = failures.filter((line) => line.includes(` ${subject.probes.name}.`));
      const ran = tested.output.includes(`${subject.probes.name}.dll`);
      step(`${subject.name}: los adaptadores guardan, leen y traducen contra ${label}`, ran && mine.length === 0, ran ? mine.join('; ') : 'las sondas no se ejecutaron');
    }
    if (!tested.ok && failures.length === 0) console.error(tested.output.split('\n').slice(-40).join('\n'));
    if (process.env.DB_CHECK_VERBOSE) console.log(tested.output);
    // Que no falle ninguna no basta: tienen que haberse ejecutado (el total del resumen de dotnet test).
    const total = Number(/total: (\d+)/.exec(tested.output)?.[1] ?? 0);
    step(`${label}: las sondas se ejecutaron`, total > 0, `${total} sondas`);

    // ─── El esquema que creó EF, contra lo emitido ─────────────────────────────────────────────────
    const check = engine === 'mysql' ? mysqlSchemaCheck : postgresqlSchemaCheck;
    for (const subject of subjects) step(`${subject.name}: el catálogo de ${label} es el esquema emitido`, ...check(database, subject));
    return 0;
  } catch (error) {
    if (!(error instanceof Abort)) throw error;
    return error.code;
  } finally {
    stopDatabase(runtime, database);
    if (keep) {
      const kept = fs.mkdtempSync(path.join(path.dirname(root), `keel-dotnet-db-kept-${engine}-`));
      fs.cpSync(root, kept, { recursive: true });
      console.log(`Sujetos de ${label} conservados en ${kept}`);
    }
  }
}

/** La base de administración desde la que cada sujeto crea la suya. En MySQL, root: crear bases no es del usuario de la suya. */
function adminConnection(engine, database) {
  if (engine === 'mysql') return `Server=127.0.0.1;Port=${database.port};Database=${database.user};User ID=root;Password=${database.password}`;
  return `Host=127.0.0.1;Port=${database.port};Database=${database.user};Username=${database.user};Password=${database.password}`;
}

/** psql en el contenedor, sobre la base del sujeto; una fila por línea, columnas separadas por |. */
function psql(database, databaseName, sql) {
  const result = run(runtime, ['exec', database.name, 'psql', '-U', database.user, '-d', databaseName, '-At', '-F', '|', '-c', sql]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('|'));
}

/** mysql en el contenedor, con root, sobre la base del sujeto; una fila por línea, columnas separadas por tabulador. */
function mysql(database, databaseName, sql) {
  const result = run(runtime, ['exec', database.name, 'mysql', '-u', 'root', `-p${database.password}`, '-N', '-B', databaseName, '-e', sql]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.replace(/\r/g, '').split('\n').filter(Boolean).map((line) => line.split('\t'));
}

/** Las columnas del esquema emitido que no tiene el catálogo, o que no tienen su nulabilidad, su cota o su escala. */
function columnProblems(files, live) {
  const problems = [];
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
  return problems;
}

/** Los nombres del diseño que no están en el catálogo (sin las tablas, que no son un índice ni una constraint). */
function nameProblems(model, live, names, { skip = () => false } = {}) {
  const problems = [];
  for (const name of expectedSchemaNames(model)) {
    if (live.has(`${name}.id`) || [...live.keys()].some((key) => key.startsWith(`${name}.`))) continue;
    if (skip(name)) continue;
    if (!names.has(name)) problems.push(`falta ${name}`);
  }
  const foreign = [...names].filter((name) => /^(PK|FK|IX|AK)_/.test(name));
  if (foreign.length > 0) problems.push(`nombres puestos por EF: ${foreign.join(', ')}`);
  return problems;
}

function postgresqlSchemaCheck(database, { model, files }) {
  const db = databaseOf(model);
  let columns;
  let names;
  let indexes;
  try {
    columns = psql(database, db, "SELECT table_name, column_name, is_nullable, coalesce(character_maximum_length::text, ''), coalesce(numeric_scale::text, '') FROM information_schema.columns WHERE table_schema = 'public'");
    names = new Set([
      ...psql(database, db, "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'").map(([name]) => name),
      ...psql(database, db, "SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'").map(([name]) => name)
    ]);
    indexes = new Map(psql(database, db, "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'").map(([name, def]) => [name, def]));
  } catch (error) {
    return [false, `no se pudo leer el catálogo: ${error.message.split('\n')[0]}`];
  }
  const live = new Map(columns.map(([table, column, nullable, length, scale]) => [`${table}.${column}`, { nullable: nullable === 'YES', length: length === '' ? null : Number(length), scale: scale === '' ? null : Number(scale) }]));
  const problems = columnProblems(files, live);
  // El predicado de cada índice único condicionado, contra el DISEÑO (keel-core), no contra lo emitido: comparado con el
  // mapeo, un predicado mal emitido se daba la razón a sí mismo.
  for (const spec of partialIndexSpecs(model, 'postgresql')) {
    const def = indexes.get(spec.name) ?? '';
    if (!/ WHERE /.test(def) || !def.includes(`'${spec.stored}'`)) problems.push(`${spec.name}: sin el predicado ${spec.predicate} (${def || 'no existe'})`);
  }
  problems.push(...nameProblems(model, live, names));
  return [problems.length === 0, problems.slice(0, 8).join('; ')];
}

/**
 * MySQL: lo mismo, y lo que solo tiene sentido aquí. La clave primaria se llama siempre PRIMARY (los `<tabla>_pkey` del
 * diseño son, en el catálogo, la PRIMARY de su tabla); el uuid es binary(16); la columna única que el diseño pide
 * distinguiendo mayúsculas lleva utf8mb4_bin; y la unicidad condicionada es la columna generada `<índice>_flag`, con la
 * constante ALMACENADA en su expresión, como ÚLTIMA columna de su índice único.
 */
function mysqlSchemaCheck(database, { model, files }) {
  const db = databaseOf(model);
  let columns;
  let names;
  let indexColumns;
  let primaries;
  try {
    columns = mysql(
      database,
      db,
      `SELECT table_name, column_name, is_nullable, IFNULL(character_maximum_length, ''), IFNULL(numeric_scale, ''), IFNULL(collation_name, ''), column_type, IFNULL(generation_expression, '') FROM information_schema.columns WHERE table_schema = '${db}'`
    );
    names = new Set([
      ...mysql(database, db, `SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema = '${db}'`).map(([name]) => name),
      ...mysql(database, db, `SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = '${db}'`).map(([name]) => name)
    ]);
    indexColumns = new Map(
      mysql(database, db, `SELECT index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index), MIN(non_unique) FROM information_schema.statistics WHERE table_schema = '${db}' GROUP BY table_name, index_name`).map(
        ([name, list, nonUnique]) => [name, { columns: list.split(','), unique: nonUnique === '0' }]
      )
    );
    primaries = new Set(mysql(database, db, `SELECT table_name FROM information_schema.table_constraints WHERE table_schema = '${db}' AND constraint_type = 'PRIMARY KEY'`).map(([table]) => table));
  } catch (error) {
    return [false, `no se pudo leer el catálogo: ${error.message.split('\n')[0]}`];
  }
  const live = new Map(
    columns.map(([table, column, nullable, length, scale, collation, type, generation]) => [
      `${table}.${column}`,
      { nullable: nullable === 'YES', length: length === '' ? null : Number(length), scale: scale === '' ? null : Number(scale), collation, type, generation }
    ])
  );
  const problems = columnProblems(files, live);
  // La collation, contra el DISEÑO (columnSpec de keel-core la pone en cada columna única de texto): comparada con el mapeo
  // emitido, una collation que falta en los dos se daría la razón a sí misma.
  for (const { table, column, collation } of designCollations(model)) {
    const have = live.get(`${table}.${column}`);
    if (have && have.collation !== collation) problems.push(`${table}.${column}: collation ${have.collation || 'ninguna'}, no ${collation}`);
  }
  // El uuid: binary(16), y no el char(36) que el proveedor pone por defecto.
  for (const [key, have] of live) if (/char\(36\)/i.test(have.type)) problems.push(`${key}: ${have.type} (el uuid va en binary(16))`);
  // La unicidad condicionada, contra el DISEÑO.
  for (const spec of partialIndexSpecs(model, 'mysql')) {
    const flag = discriminatorColumn(spec);
    const generated = live.get(`${spec.tableName}.${flag}`);
    if (!generated) problems.push(`${spec.name}: falta su columna generada ${flag}`);
    else if (!generated.generation.includes(spec.stored)) problems.push(`${spec.name}: ${flag} no compara con '${spec.stored}' (${generated.generation})`);
    const index = indexColumns.get(spec.name);
    if (!index?.unique || index.columns.at(-1) !== flag) problems.push(`${spec.name}: no es único con ${flag} al final (${index ? index.columns.join(', ') : 'no existe'})`);
  }
  // La clave primaria se llama PRIMARY: un `<tabla>_pkey` del diseño es la PRIMARY de su tabla.
  for (const name of expectedSchemaNames(model).filter((candidate) => candidate.endsWith('_pkey'))) {
    if (!primaries.has(name.slice(0, -'_pkey'.length))) problems.push(`${name}: la tabla no tiene clave primaria`);
  }
  problems.push(...nameProblems(model, live, names, { skip: (name) => name.endsWith('_pkey') }));
  return [problems.length === 0, problems.slice(0, 8).join('; ')];
}

/** Las columnas a las que el diseño pone collation (las únicas de texto en un motor que pliega mayúsculas). */
function designCollations(model) {
  const columns = [];
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    for (const member of persistedMembers(model, entity)) {
      if (member.kind === 'scalar' && member.field.columns?.collation) columns.push({ table: entity.tableName, column: member.field.columns.name, collation: member.field.columns.collation });
      if (member.kind === 'vo') {
        for (const sub of member.subs) if (sub.sub.columns?.collation) columns.push({ table: entity.tableName, column: sub.column, collation: sub.sub.columns.collation });
      }
    }
  }
  return columns;
}

if (aborted) process.exit(aborted);
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ndb-check: ${results.length}/${results.length} en verde.` : `\ndb-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
