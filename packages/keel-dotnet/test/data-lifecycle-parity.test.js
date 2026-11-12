// El CICLO DE VIDA DEL DATO (DSL 2.28) en keel-dotnet: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/data-lifecycle-designs.js, y su PARIDAD con lo que emite keel-spring del mismo diseño (los mismos
// casos, los mismos nombres de índice, el mismo `kind` y las mismas claves del barrido, las mismas notas). Lo que esto NO
// dice —que el listado deje fuera lo borrado, que el índice libere la clave, que la ventana se compruebe, que el barrido
// no se adelante— lo miden db-check y doc-check contra el motor real (scripts/lib/lifecycle-probes.js: LC-*, RT-* y PD-2).
// PD-1, el gate de logs, sí se EJECUTA aquí, con bash.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { logicalDeletionNote, retentionParameters, deletedRootOf } from '@keel-system/keel-core/gen/data-lifecycle';
import { DATA_LIFECYCLE_DESIGNS, withoutLifecycle } from '../../keel-core/test/helpers/data-lifecycle-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { lifecycleCases } from '../scripts/lib/lifecycle-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/lifecycle-probes.js';

const design = (name) => DATA_LIFECYCLE_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name, { database, mutate, generator = planService } = {}) {
  const { manifest, layers, document } = load(name, mutate);
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: database ?? (document ? 'mongodb' : 'postgresql') } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-dotnet, y su sonda ejecuta los MISMOS casos que la de keel-spring (PD-2, solo en relacional)', () => {
  for (const { name } of DATA_LIFECYCLE_DESIGNS) {
    const { manifest, layers, document } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const dotnet = lifecycleCases(plan(name).model);
    assert.ok(dotnet.length > 0, `${name}: la sonda no ejecuta ningún caso`);
    // En documental no hay logger de infraestructura que reciba la excepción del driver (scripts/lib/lifecycle-probes.js).
    const spring = springCases(plan(name, { generator: planSpring }).model).filter((caseId) => !(document && caseId === 'PD-2'));
    assert.deepEqual(dotnet, spring, name);
  }
});

test('cards-logical: el borrado marca, las lecturas son vivas y la restauración tiene su ventana', () => {
  const { files, model } = plan('cards-logical');
  const port = fileOf(files, 'Domain/Repository/IContactCardRepository.cs');
  assert.match(port, /Borrado LÓGICO[\s\S]*Task DeleteById\(Guid id, CancellationToken cancellationToken = default\);/);
  assert.match(port, /Task<ContactCard\?> FindDeletedBySubject\(string subject, CancellationToken cancellationToken = default\);/);
  assert.match(port, /Task<ContactCard\?> Restore\(Guid id, CancellationToken cancellationToken = default\);/);
  const adapter = fileOf(files, 'Persistence/Repositories/ContactCardRepository.cs');
  assert.match(adapter, /SingleOrDefaultAsync\(r => r\.Id == id && r\.DeletedAt == null, cancellationToken\)/);
  assert.match(adapter, /SingleOrDefaultAsync\(r => r\.Subject == subject && r\.DeletedAt == null, cancellationToken\)/);
  assert.match(adapter, /SingleOrDefaultAsync\(r => r\.Email == email && r\.DeletedAt == null, cancellationToken\)/);
  assert.match(adapter, /if \(found is \{ DeletedAt: null \}\)\s+\{\s+found\.DeletedAt = DateTimeOffset\.UtcNow;/);
  assert.match(adapter, /if \(!\(deleted\.DeletedAt!\.Value\.AddDays\(30\) > DateTimeOffset\.UtcNow\)\)\s+\{\s+throw new \w+\("ContactCard borrado hace más de 30 días/);
  assert.match(adapter, /\.OrderByDescending\(r => r\.DeletedAt\)/);
  // La unicidad deja de ser de toda la tabla: va al índice parcial, con el MISMO nombre que en keel-spring.
  const row = fileOf(files, 'Persistence/Rows/ContactCardRow.cs');
  assert.match(row, /row\.HasIndex\(r => r\.Subject, "uk_contact_cards_natural"\)\.IsUnique\(\)\.HasFilter\("deleted_at IS NULL"\)/);
  assert.match(row, /row\.HasIndex\(r => r\.Email, "uk_contact_cards_email"\)\.IsUnique\(\)\.HasFilter\("deleted_at IS NULL"\)/);
  assert.match(row, /public DateTimeOffset\? DeletedAt \{ get; set; \}/);
  assert.match(row, /row\.Property\(r => r\.DeletedAt\)\.HasColumnName\("deleted_at"\)\.IsRequired\(false\);/);
  const spring = fileOf(plan('cards-logical', { generator: planSpring }).files, 'db/partial-indexes.sql');
  for (const name of ['uk_contact_cards_natural', 'uk_contact_cards_email']) assert.ok(spring.includes(name), `${name} no está en keel-spring`);
  // Los handlers reciben el puerto y la nota neutral, la misma que keel-spring y keel-nest.
  const remove = fileOf(files, 'DeleteMyCardCommandHandler.cs');
  assert.match(remove, /\(IContactCardRepository contactCardRepository\)/);
  const operation = model.services.flatMap((group) => group.operations).find((candidate) => candidate.name === 'deleteMyCard');
  const note = logicalDeletionNote(model, operation, { deleteCall: 'X' }).split('X').at(-1).slice(0, 80).trim();
  assert.ok(remove.replace(/\s*\n\s*\/\/\s*/g, ' ').includes(note), 'la nota del borrado no es la neutral');
  assert.equal(deletedRootOf(model, operation)?.name, 'ContactCard');
  assert.match(fileOf(files, 'RestoreMyCardCommandHandler.cs').replace(/\s*\n\s*\/\/\s*/g, ' '), /contactCardRepository\.FindDeletedBySubject\(\.\.\., cancellationToken\)[\s\S]*contactCardRepository\.Restore\(<su id>, cancellationToken\)/);
});

test('cards-logical en MySQL: la unicidad entre vivas es una columna generada, como en keel-spring y keel-nest', () => {
  const row = fileOf(plan('cards-logical', { database: 'mysql' }).files, 'Persistence/Rows/ContactCardRow.cs');
  assert.match(row, /row\.Property<sbyte\?>\("uk_contact_cards_email_flag"\)[^;]*HasComputedColumnSql\("CASE WHEN deleted_at IS NULL THEN 1 END", stored: true\);/);
  assert.match(row, /row\.HasIndex\(\["Email", "uk_contact_cards_email_flag"\], "uk_contact_cards_email"\)\.IsUnique\(\)/);
});

test('cards-logical-mongo: el índice parcial cuenta solo los vivos (T1) y el adaptador marca', () => {
  const { files } = plan('cards-logical-mongo');
  const indexes = fileOf(files, 'Persistence/DocumentIndexes.cs');
  assert.match(indexes, /Name = "uk_contact_cards_natural", Unique = true, PartialFilterExpression = new BsonDocument\("deletedAt", BsonNull\.Value\)/);
  const adapter = fileOf(files, 'Persistence/Repositories/ContactCardRepository.cs');
  assert.match(adapter, /Find\(Live\(new BsonDocument\("_id", BsonValues\.Of\(id\)\)\)\)\.FirstOrDefaultAsync/);
  assert.match(adapter, /Builders<BsonDocument>\.Filter\.And\(new BsonDocument\("_id", BsonValues\.Of\(id\)\), NotDeleted\),\s+new BsonDocument \{ \{ "\$set", new BsonDocument\("deletedAt", BsonValues\.Of\(DateTimeOffset\.UtcNow\)\) \}/);
  assert.match(adapter, /\.Sort\(new BsonDocument\("deletedAt", -1\)\)/);
});

test('codes-anonymize: la retención es un recurrente del cronómetro que anonimiza con el sustituto, con el kind y las claves de keel-spring', () => {
  const { files } = plan('codes-anonymize');
  const retention = fileOf(files, 'Persistence/Retention/VerificationCodeRetention.cs');
  assert.match(retention, /var substitute = "anon-" \+ Convert\.ToString\(id, CultureInfo\.InvariantCulture\);\s+found\.Email = substitute;\s+found\.AnonymizedAt = DateTimeOffset\.UtcNow;\s+found\.LockVersion = found\.LockVersion \+ 1;/);
  assert.match(retention, /\.Where\(r => r\.IssuedAt <= cutoff && r\.AnonymizedAt == null\)/);
  const timer = fileOf(files, 'Timers/VerificationCodeRetentionTimer.cs');
  assert.match(timer, /: IRecurringTimerHandler/);
  assert.match(timer, /var cutoff = now\.AddDays\(-30\);/);
  assert.match(fileOf(files, 'Timers/TimerKinds.cs'), /public const string RetentionVerificationCode = "retention:VerificationCode";/);
  assert.match(fileOf(plan('codes-anonymize', { generator: planSpring }).files, '/timer/TimerKinds.java'), /RETENTION_VERIFICATION_CODE = "retention:VerificationCode";/);
  const parameters = retentionParameters('VerificationCode');
  const settings = fileOf(files, 'Persistence/Retention/RetentionSettings.cs');
  const key = (name) => name.replaceAll('.', ':');
  assert.ok(settings.includes(`"${key(parameters.cron.key)}", "${parameters.cron.default}"`) && settings.includes(`"${key(parameters.batchSize.key)}", ${parameters.batchSize.default}`));
  assert.match(fileOf(files, 'parameters/develop/retention.yaml'), new RegExp(`cron: "\\$\\{${parameters.cron.env}:`));
  assert.match(fileOf(files, 'Timers/TimerRegistration.cs'), /services\.AddScoped<IRecurringTimerHandler, VerificationCodeRetentionTimer>\(\);/);
  assert.match(fileOf(files, 'Program.cs'), /builder\.Services\.AddSingleton\(RetentionSettings\.From\(configuration\)\);/);
});

test('codes-anonymize-mongo: la anonimización reescribe el documento, con su marca y su versión', () => {
  const retention = fileOf(plan('codes-anonymize-mongo').files, 'Persistence/Retention/VerificationCodeRetention.cs');
  assert.match(retention, /\.Find\(new BsonDocument \{ \{ "issued_at", new BsonDocument\("\$lte", BsonValues\.Of\(cutoff\)\) \}, \{ "anonymizedAt", BsonNull\.Value \} \}\)/);
  assert.match(retention, /found\["email"\] = new BsonString\(substitute\);\s+found\["anonymizedAt"\] = BsonValues\.Of\(DateTimeOffset\.UtcNow\);\s+found\["lock_version"\] = /);
});

test('vault-logical-scoped: el finder suma la vida DETRÁS del alcance, y la lectura por referencia la ve (D3)', () => {
  const { files } = plan('vault-logical-scoped');
  const asset = fileOf(files, 'Persistence/Repositories/AssetRepository.cs');
  assert.match(asset, / {8}query = Scoped\(query, scope\);\n {8}query = query\.Where\(r => r\.DeletedAt == null\);/);
  const owner = fileOf(files, 'Persistence/Repositories/OwnerRepository.cs');
  assert.match(owner, /\.Where\(r => keys\.Contains\(r\.Id\)\)\.ToListAsync/);
});

test('la anonimización que keel-dotnet no sabe hacer se rechaza con su motivo', () => {
  assert.throws(
    () => plan('codes-anonymize', { mutate: (layers) => (layers.domain.entities.VerificationCode.fields.aliases = { type: 'string', list: true, personal: true }) }),
    /keel-dotnet no sabe anonimizar VerificationCode\.aliases \(elementCollection\)/
  );
});

test('PD-1: check-logging.sh sale rojo con un campo personal en un log y verde con el id', () => {
  const { files } = plan('cards-logical');
  const root = tmpDir('keel-dotnet-lifecycle-gate-');
  for (const file of files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  const run = () => spawnSync('bash', ['infra/check-logging.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0, `recién generado tiene que salir verde:\n${run().stdout}`);
  const project = fs.readdirSync(path.join(root, 'src')).find((entry) => entry.endsWith('.Application'));
  const dir = path.join(root, 'src', project, 'Probe');
  fs.mkdirSync(dir, { recursive: true });
  const write = (body) =>
    fs.writeFileSync(path.join(dir, 'Probe.cs'), `namespace Probe;\n\npublic static class Probe\n{\n    public static void Run(Microsoft.Extensions.Logging.ILogger logger, dynamic command, dynamic card)\n    {\n${body}\n    }\n}\n`);
  write('        logger.LogInformation("Ficha {Id} guardada", card.Id);');
  assert.equal(run().status, 0, 'loguear el id no puede dar rojo');
  for (const body of ['        logger.LogInformation("Ficha de {Name}", card.DisplayName);', '        logger.LogWarning("Correo repetido {Email}", command.Email);']) {
    write(body);
    const result = run();
    assert.equal(result.status, 1, `${body.trim()}: tenía que salir rojo\n${result.stdout}`);
    assert.ok(result.stdout.includes('[personal]'), `el hallazgo no nombra su regla\n${result.stdout}`);
  }
});

test('con datos personales ni EF ni el manejador de la API copian el mensaje del motor al log (PD-2); sin ellos, como siempre', () => {
  const { files } = plan('cards-logical');
  assert.match(fileOf(files, 'Persistence/PersistenceRegistration.cs'), /options\.ConfigureWarnings\(warnings => warnings\.Ignore\(CoreEventId\.SaveChangesFailed, CoreEventId\.QueryIterationFailed, RelationalEventId\.CommandError\)\);/);
  const middleware = fileOf(files, 'Rest/ApiErrorMiddleware.cs');
  assert.match(middleware, /LogIntegrity\(integrity\.InnerException\?\.GetType\(\)\.Name \?\? nameof\(IntegrityViolationException\)\);/);
  assert.match(middleware, /private partial void LogIntegrity\(string cause\);/);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'profile-directory'));
  withoutLifecycle(layers);
  const plain = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  assert.doesNotMatch(fileOf(plain, 'Persistence/PersistenceRegistration.cs'), /ConfigureWarnings/);
  assert.match(fileOf(plain, 'Rest/ApiErrorMiddleware.cs'), /private partial void LogIntegrity\(Exception exception\);/);
});

test('T5: borrar y restaurar vacían la caché de las lecturas de la raíz, y el barrido de retención también', () => {
  const mutate = (layers) => (layers['use-cases'].operations.getMyCard.cache = { ttlSeconds: 60, keyFields: ['callerSubject'] });
  const { files } = plan('cards-logical', { mutate });
  const invalidations = files.find((file) => /CacheInvalidations\.cs$/.test(file.path))?.content ?? '';
  assert.match(invalidations, /typeof\(DeleteMyCardCommand\)[^\n]*GetMyCard/);
  assert.match(invalidations, /typeof\(RestoreMyCardCommand\)[^\n]*GetMyCard/);
  assert.match(fileOf(files, 'Timers/ContactCardRetentionTimer.cs'), /if \(processed > 0\)\s+\{\s+await operationCache\.Clear\(CachedOperations\.GetMyCard\w*, cancellationToken\);/);
});
