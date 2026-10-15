#!/usr/bin/env node
// La persistencia DOCUMENTAL de keel-dotnet contra un MongoDB REAL (incremento 12): lo único que juzga si lo emitido
// sostiene lo que el diseño pidió. `cs-check` dice que compila; esto dice que el documento que escribe el adaptador es el
// del contrato (keel-core/gen/document.js, el mismo que escriben keel-spring y keel-nest) y que los índices, la
// transacción y la traducción de errores hacen lo que dicen. Es el doc-check de keel-nest.
//
// Sobre un MongoDB miembro de un replica set (en contenedor) y por sujeto (las fixtures documentales):
//
//   sondas   un proyecto xUnit generado a partir del modelo (scripts/lib/doc-probes.js) que EJECUTA los adaptadores con
//            la DB_URL de keel-spring tal cual: ida y vuelta, el documento CRUDO contra la forma neutral a todo nivel, la
//            versión obsoleta, la clave natural y el índice condicionado con su error declarado, la carrera de dos
//            transacciones, la auditoría y la página;
//   índices  los vivos (listIndexes) contra keel-core/gen/document.js: nombre, claves en orden, unicidad y filtro
//            parcial, y ninguno de más; crearlos dos veces no falla (la fixture arranca dos veces).
//
//   node packages/keel-dotnet/scripts/doc-check.js [--keep] [--sabotage=<id>] [--only=<sujeto>]
//   npm run doc-check --workspace packages/keel-dotnet
//
// --sabotage=<id> rompe lo emitido CONSERVANDO LA FORMA (sigue compilando), y el check tiene que salir rojo en su
// comprobación:
//   decimal     el decimal se guarda como texto (se ordenaría lexicográficamente)
//   uuid        el uuid se guarda como texto EN LOS DOS SENTIDOS (la ida y vuelta pasa: solo lo ve el documento crudo)
//   version     la versión no va en el filtro del UPDATE (la escritura obsoleta pasa)
//   transient   el clasificador no reconoce el WriteConflict, ni por la etiqueta ni por el código (la carrera sale como 500)
//   constraint  el traductor no reconoce ningún índice (la clave repetida sale como 409 sin code)
//   partial     el filtro parcial lleva el literal del diseño y no la constante guardada (el índice no indexa nada)
//   created     el created_at DECLARADO (un campo del dominio) se reescribe en cada guardado
//   created-policy  el created_at de la auditoría de POLÍTICA (que el dominio no lleva) se reescribe en cada guardado
//   enum        el enum se guarda por su miembro de C# y no por la constante del diseño
//   day         el día se guarda en la zona del proceso, no a medianoche UTC
// y los de los almacenes del generador (incremento 12c):
//   outbox-order   el relay reclama sin el orden de llegada
//   outbox-mark    el reclamo del relay ignora la marca viva (lo reclamado vuelve en la pasada siguiente)
//   guard          la guarda no reconoce el _id repetido (la reentrega sale como error)
//   key-order      el _id del registro de idempotencia con sus campos en otro orden (la ida y vuelta pasa: solo lo ve el crudo)
//   claim-state    el reclamo de un barrido no filtra por su estado de partida
//   claim-stale    el rescate se lleva también lo recién entrado en vuelo (sin cota temporal)
//   claim-order    el reclamo ordena por el _id y no por el campo del diseño
//   reconciliation-held       la lectura de candidatos no excluye los de marca viva
//   reconciliation-threshold  el reclamo de reconciliación se lleva también lo recién encargado
//   reconciliation-expiry     la marca caduca con < y no con el <= de keel-core
//   purge-batch    cada lote borra hasta el corte y no hasta su frontera
//   purge-column   la purga del outbox corta por created_at y no por published_at
//   bridge-session el puente escribe la fila del outbox fuera de la sesión del cambio (sobrevive al aborto)
//   credential     el finder de resolvedBy busca solo en la primera credencial de la lista
//   send-guard     la guarda del envío (mail.sentBy) escribe en la sesión del caso de uso, no confirma al volver
//
// Necesita el SDK de .NET 10, podman o docker y red la primera vez (NuGet).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { documentIndexes } from 'keel-core/gen/document';
import { planFixture, makeWorkspace } from '../test/helpers/workspace.js';
import { docProbeProject, documentDatabaseOf } from './lib/doc-probes.js';
import { resolveRuntime, startMongo, stopDatabase, run } from '../../keel-nest/scripts/lib/database-container.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const only = args.find((arg) => arg.startsWith('--only='))?.split('=')[1] ?? null;

// Los sujetos y lo que cubre cada uno: hijas anidadas en dos niveles, un value object dentro de otro, fechas sin hora y
// listas de escalares (inspection-reports); el reloj y la clave natural del barrido (job-dispatch-mongo); value objects en
// listas, índices condicionados y la auditoría (notification-mailer-mongo); la autoría de política y otra raíz
// referenciada (asset-vault). Los mecanismos del 12c (mensajería, barridos, registro de idempotencia, reconciliación)
// no los mide esto: sobre documentos todavía se rechazan.
const SUBJECTS = [
  { name: 'inspection-reports' },
  { name: 'job-dispatch-mongo' },
  { name: 'notification-mailer-mongo' },
  { name: 'asset-vault' },
  // La sombra PLEGADA sobre documentos: ninguna fixture documental declara `compare`, así que se deriva de
  // job-dispatch-mongo con la clave natural plegada (la misma derivada que el doc-check de keel-nest).
  {
    name: 'job-dispatch-mongo-compare',
    from: 'job-dispatch-mongo',
    mutate(manifest, layers) {
      manifest.service.name = 'job-dispatch-mongo-compare';
      layers.domain.entities.Job.fields.reference.compare = 'ignore-case-accents';
    }
  }
].filter((subject) => !only || subject.name === only);

// Los sabotajes: [archivo (sufijo, en todos los sujetos), texto, sustituto].
// El fin de línea de lo emitido (la llamada sigue en la línea siguiente).
const NL = String.fromCharCode(10);
const SABOTAGES = {
  decimal: ['Persistence/BsonValues.cs', 'public static BsonValue Of(decimal value) => new BsonDecimal128(new Decimal128(value));', 'public static BsonValue Of(decimal value) => new BsonString(value.ToString(System.Globalization.CultureInfo.InvariantCulture));'],
  uuid: [
    'Persistence/BsonValues.cs',
    'BsonBinaryData { SubType: BsonBinarySubType.UuidStandard } binary => binary.ToGuid(GuidRepresentation.Standard),',
    'BsonString text => Guid.Parse(text.Value),'
  ],
  version: ['Repositories/', '{ "lock_version", new BsonInt64(expected.Value) } }', '{ "lock_version", new BsonDocument("$exists", true) } }'],
  transient: ['Persistence/PersistenceErrors.cs', 'mongo.HasErrorLabel("TransientTransactionError")', 'mongo.HasErrorLabel("TransientTransactionErrorX")'],
  'created-policy': ['Repositories/', 'fields["updated_at"] = now;', 'fields["updated_at"] = now; fields["created_at"] = now;'],
  constraint: ['Persistence/PersistenceErrors.cs', 'detail.IndexOf("index: " + index, StringComparison.Ordinal)', 'detail.IndexOf("index: " + index + "-", StringComparison.Ordinal)'],
  partial: ['Persistence/DocumentIndexes.cs', 'PartialFilterExpression = new BsonDocument("status", "', 'PartialFilterExpression = new BsonDocument("status", "x'],
  created: ['Persistence/BsonValues.cs', 'if (current.IsBsonNull || current is BsonString { Value: "" }', 'if (true || current.IsBsonNull || current is BsonString { Value: "" }'],
  enum: ['Persistence/BsonValues.cs', 'where T : struct, System.Enum => new BsonString(constant(value));', 'where T : struct, System.Enum => new BsonString(value.ToString());'],
  day: ['Persistence/BsonValues.cs', 'new DateTimeOffset(value.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero)', 'new DateTimeOffset(value.ToDateTime(TimeOnly.MinValue), TimeSpan.FromHours(-5))'],
  // Los almacenes del generador (incremento 12c).
  'outbox-order': ['Outbox/OutboxRelayStore.cs', 'Sort = new BsonDocument("created_at", 1), ', ''],
  'outbox-mark': [
    'Outbox/OutboxRelayStore.cs',
    'new BsonDocument("$or", new BsonArray { new BsonDocument("claimed_at", BsonNull.Value), new BsonDocument("claimed_at", new BsonDocument("$lte", claimCutoff)) })',
    'new BsonDocument()'
  ],
  guard: ['Idempotency/IdempotencyGuard.cs', 'when (PersistenceErrors.DuplicateKeyMessage(error) is not null)', 'when (PersistenceErrors.DuplicateKeyMessage(error) is null)'],
  'key-order': [
    'Persistence/IdempotencyStore.cs',
    'new BsonDocument { { "operation_scope", BsonValues.Of(scope) }, { "idempotency_key", BsonValues.Of(idempotencyKey) } }',
    'new BsonDocument { { "idempotency_key", BsonValues.Of(idempotencyKey) }, { "operation_scope", BsonValues.Of(scope) } }'
  ],
  'claim-state': ['Repositories/', 'new BsonDocument("$in", new BsonArray {', 'new BsonDocument("$nin", new BsonArray {'],
  'claim-stale': ['Repositories/', 'new BsonDocument("$lt", staleBefore)', 'new BsonDocument("$lt", claimedAt)'],
  'claim-order': ['Repositories/', '{ Sort = new BsonDocument(', '{ Sort = new BsonDocument("_id", 1).Add('],
  'reconciliation-held': ['Repositories/', 'new BsonDocument("$nin", new BsonArray(held))', 'new BsonDocument("$nin", new BsonArray())'],
  'reconciliation-threshold': ['Repositories/', 'new BsonDocument("$lt", BsonValues.Of(unansweredBefore))', 'new BsonDocument("$lt", BsonValues.Of(now.AddDays(1)))'],
  'reconciliation-expiry': ['Persistence/ReconciliationClaimStore.cs', 'new BsonDocument("$lte", BsonValues.Of(expiredBefore))', 'new BsonDocument("$lt", BsonValues.Of(expiredBefore))'],
  'purge-batch': ['Purge/TablePurges.cs', '{ "$lte", BsonValues.Of(upTo) }', '{ "$lte", BsonValues.Of(cutoff) }'],
  'purge-column': ['Purge/TablePurges.cs', 'new BsonDocument("published_at", ', 'new BsonDocument("created_at", '],
  'bridge-session': ['DomainEventBridge.cs', 'InsertManyAsync(session, rows, ', 'InsertManyAsync(rows, '],
  // resolvedBy (12e): el finder por credencial busca solo en la PRIMERA de la lista.
  credential: ['Repositories/', 'new BsonDocument("credential_keys", ', 'new BsonDocument("credential_keys.0", '],
  // La guarda del envío (mail.sentBy, 12e) escribe en la sesión del caso de uso: su marca se deshace con ella.
  'send-guard': ['Repositories/', 'Sin sesión: confirma al volver.' + NL + '        var document = await Collection.FindOneAndUpdateAsync<BsonDocument>(' + NL, 'Sin sesión: confirma al volver.' + NL + '        var document = await Collection.FindOneAndUpdateAsync<BsonDocument>(transactions.Session!,' + NL]
};
// El sabotaje del uuid tiene que cambiar las DOS direcciones (si no, la ida y vuelta lo cazaría sola): también al escribir.
// Y el del clasificador, sus DOS vías: la etiqueta y el código 112 dicen lo mismo, así que quitar una sola es una mutación
// equivalente (medido: con solo la etiqueta, doc-check seguía en verde).
const SECOND = {
  transient: ['Persistence/PersistenceErrors.cs', 'if (cause is MongoCommandException { Code: 112 } || cause is MongoWriteException { WriteError.Code: 112 })', 'if (cause is MongoCommandException { Code: -112 } || cause is MongoWriteException { WriteError.Code: -112 })'],
  uuid: ['Persistence/BsonValues.cs', 'public static BsonValue Of(Guid value) => new BsonBinaryData(value, GuidRepresentation.Standard);', 'public static BsonValue Of(Guid value) => new BsonString(value.ToString());']
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

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);
let database;
try {
  database = await startMongo(runtime);
  step('MongoDB en replica set, en contenedor', true, `puerto ${database.port}`);
} catch (error) {
  step('MongoDB en replica set, en contenedor', false, error.message);
  process.exit(1);
}

const root = makeWorkspace('keel-dotnet-doc-check-');
const subjects = [];
class Abort extends Error {
  constructor(code) {
    super(`doc-check abortado (${code})`);
    this.code = code;
  }
}
let aborted = 0;
try {
  const projects = [];
  for (const subject of SUBJECTS) {
    const { model, files } = await planFixture(subject.from ?? subject.name, { mutate: subject.mutate ?? null });
    const probes = docProbeProject(model);
    for (const file of [...files, ...probes.files]) {
      const target = path.join(root, subject.name, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
      if (file.path === 'global.json') fs.writeFileSync(path.join(root, 'global.json'), file.content);
    }
    projects.push(`${subject.name}/tests/${probes.name}/${probes.name}.csproj`);
    subjects.push({ ...subject, model, files, probes });
  }
  if (sabotage) {
    let applied = 0;
    for (const [suffix, from, to] of [SABOTAGES[sabotage], SECOND[sabotage]].filter(Boolean)) {
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
    }
    if (!SABOTAGES[sabotage] || applied === 0) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?). Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
      throw new Abort(2);
    }
    console.log(`(sabotaje: ${sabotage}, en ${applied} archivo(s))`);
  }
  fs.writeFileSync(path.join(root, 'DocCheck.slnx'), ['<Solution>', ...projects.map((p) => `  <Project Path="${p}" />`), '</Solution>', ''].join('\n'));

  const built = dotnet(root, ['build', 'DocCheck.slnx', '-c', 'Release']);
  if (!step(`los ${subjects.length} sujetos y sus sondas compilan`, built.ok)) {
    console.error([...new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)))].slice(0, 60).join('\n'));
    throw new Abort(1);
  }

  // ─── Las sondas, contra el motor ──────────────────────────────────────────────────────────────
  // La URL con la forma de la de keel-spring, uuidRepresentation incluida: la misma DB_URL tiene que servir.
  const url = `mongodb://127.0.0.1:${database.port}/{database}?directConnection=true&uuidRepresentation=standard`;
  const tested = dotnet(root, ['test', '--solution', 'DocCheck.slnx', '--no-build', '-c', 'Release'], { DOC_CHECK_URL: url });
  const failures = tested.output.split('\n').filter((line) => /^\s*(con errores|failed)\s/i.test(line)).map((line) => line.trim());
  for (const subject of subjects) {
    const mine = failures.filter((line) => line.includes(` ${subject.probes.name}.`));
    const ran = tested.output.includes(`${subject.probes.name}.dll`);
    step(`${subject.name}: los adaptadores guardan, leen y traducen contra MongoDB`, ran && mine.length === 0, ran ? mine.join('; ') : 'las sondas no se ejecutaron');
  }
  if (!tested.ok && failures.length === 0) console.error(tested.output.split('\n').slice(-40).join('\n'));
  if (process.env.DOC_CHECK_VERBOSE || (!tested.ok && sabotage == null)) console.log(detailOf(tested.output));
  const total = Number(/total: (\d+)/.exec(tested.output)?.[1] ?? 0);
  step('las sondas se ejecutaron', total > 0, `${total} sondas`);

  // ─── Los índices vivos, contra el contrato ────────────────────────────────────────────────────
  for (const subject of subjects) step(`${subject.name}: los índices vivos son los del contrato`, ...indexCheck(subject));
} catch (error) {
  if (!(error instanceof Abort)) throw error;
  aborted = error.code;
} finally {
  stopDatabase(runtime, database);
  if (keep) {
    const kept = fs.mkdtempSync(path.join(path.dirname(root), 'keel-dotnet-doc-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Sujetos conservados en ${kept}`);
  }
}

/** Lo que dice dotnet test de cada prueba en rojo: el nombre y su primer mensaje. */
function detailOf(output) {
  return output
    .split('\n')
    .filter((line) => /error|con errores|failed|Assert|Exception/i.test(line))
    .slice(0, 80)
    .join('\n');
}

/** Los índices de cada colección de la base del sujeto, leídos por mongosh dentro del contenedor. */
function liveIndexes(databaseName) {
  const script = `const out = {}; db.getCollectionNames().forEach(function (name) { out[name] = db.getCollection(name).getIndexes(); }); print(JSON.stringify(out));`;
  const result = run(runtime, ['exec', database.name, 'mongosh', '--quiet', `mongodb://localhost:27017/${databaseName}?directConnection=true`, '--eval', script]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

function indexCheck({ model }) {
  const problems = [];
  let live;
  try {
    live = liveIndexes(documentDatabaseOf(model));
  } catch (error) {
    return [false, `no se pudieron leer los índices: ${error.message.split('\n')[0]}`];
  }
  const expected = documentIndexes(model, []);
  for (const { collection, specs } of expected) {
    const have = (live[collection] ?? []).filter((index) => index.name !== '_id_');
    for (const spec of specs) {
      const index = have.find((candidate) => candidate.name === spec.name);
      if (!index) {
        problems.push(`${collection}: falta ${spec.name}`);
        continue;
      }
      const keys = Object.entries(index.key);
      const want = spec.paths.map((p) => [p, 1]);
      if (JSON.stringify(keys) !== JSON.stringify(want)) problems.push(`${spec.name}: claves ${JSON.stringify(keys)}, no ${JSON.stringify(want)}`);
      if ((index.unique === true) !== Boolean(spec.unique)) problems.push(`${spec.name}: unique ${index.unique === true}, no ${Boolean(spec.unique)}`);
      const filter = spec.partialFilter ? { [spec.partialFilter.path]: spec.partialFilter.equals } : null;
      if (JSON.stringify(index.partialFilterExpression ?? null) !== JSON.stringify(filter)) {
        problems.push(`${spec.name}: filtro ${JSON.stringify(index.partialFilterExpression ?? null)}, no ${JSON.stringify(filter)}`);
      }
    }
    for (const index of have) if (!specs.some((spec) => spec.name === index.name)) problems.push(`${collection}: sobra ${index.name}`);
  }
  // Una colección con índices que el contrato no conoce: los creó otra cosa.
  for (const [collection, indexes] of Object.entries(live)) {
    if (expected.some((entry) => entry.collection === collection)) continue;
    const extra = indexes.filter((index) => index.name !== '_id_').map((index) => index.name);
    if (extra.length > 0) problems.push(`${collection}: índices fuera del contrato (${extra.join(', ')})`);
  }
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
console.log(failed === 0 ? `\ndoc-check: ${results.length}/${results.length} en verde.` : `\ndoc-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
