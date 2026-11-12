// El CICLO DE VIDA DEL DATO (DSL 2.28) en keel-go: la forma de lo que emite build sobre los diseños de
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
import { DATA_LIFECYCLE_DESIGNS } from '../../keel-core/test/helpers/data-lifecycle-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { lifecycleCases } from '../scripts/lib/lifecycle-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { PERSONAL_DATA_FILE } from '@keel-system/keel-core/gen/personal-data';
import { casesOf as springCases } from '../../keel-spring/src/lib/lifecycle-probes.js';

const design = (name) => DATA_LIFECYCLE_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  manifest.service.name = name;
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

// Una nota de un handler sin los saltos de su comentario.
const flat = (text) => text.replace(/\s*\n\s*\/\/\s*/g, ' ');

test('los sujetos pasan la frontera de keel-go, y su sonda ejecuta los MISMOS casos que la de keel-spring (PD-2, solo en relacional)', () => {
  for (const { name } of DATA_LIFECYCLE_DESIGNS) {
    const { manifest, layers, document } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const go = lifecycleCases(plan(name).model);
    assert.ok(go.length > 0, `${name}: la sonda no ejecuta ningún caso`);
    // En documental no hay mensaje del motor en el log que se cuele (scripts/lib/lifecycle-probes.js).
    const spring = springCases(plan(name, { generator: planSpring }).model).filter((caseId) => !(document && caseId === 'PD-2'));
    assert.deepEqual(go, spring, name);
  }
});

test('cards-logical: el borrado marca, las lecturas son vivas y la restauración tiene su ventana', () => {
  const { files, model } = plan('cards-logical');
  const port = fileOf(files, 'internal/domain/contact_card_repository.go');
  assert.match(port, /borrado LÓGICO[\s\S]*DeleteByID\(ctx context\.Context, id uuid\.UUID\) error/);
  assert.match(port, /FindDeletedBySubject\(ctx context\.Context, subject string\) \(\*ContactCard, bool, error\)/);
  assert.match(port, /Restore\(ctx context\.Context, id uuid\.UUID\) \(\*ContactCard, bool, error\)/);
  const adapter = fileOf(files, 'internal/infrastructure/postgres/contact_card_repository.go');
  assert.ok(adapter.includes('r.load(ctx, "WHERE id = $1 AND deleted_at IS NULL", id)'));
  assert.ok(adapter.includes('r.load(ctx, "WHERE subject = $1 AND deleted_at IS NULL", subject)'));
  assert.ok(adapter.includes('r.load(ctx, "WHERE email = $1 AND deleted_at IS NULL", email)'));
  assert.ok(adapter.includes('"UPDATE contact_cards SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL", time.Now().UTC(), id'));
  assert.match(adapter, /if !deletedAt\.Add\(30 \* 24 \* time\.Hour\)\.After\(time\.Now\(\)\) \{\s+return domain\.(?:Status)?Errorf\(domain\.ErrCardNotRestorable, [^\n]*"ContactCard borrado hace más de 30 días/);
  assert.ok(adapter.includes('AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1'));
  // La unicidad deja de ser de toda la tabla: va al índice parcial, con el MISMO nombre que en keel-spring.
  const baseline = fileOf(files, 'migrations/00001_baseline.sql');
  assert.match(baseline, /CREATE UNIQUE INDEX uk_contact_cards_natural ON contact_cards \(subject\) WHERE deleted_at IS NULL;/);
  assert.match(baseline, /CREATE UNIQUE INDEX uk_contact_cards_email ON contact_cards \(email\) WHERE deleted_at IS NULL;/);
  assert.doesNotMatch(baseline, /CONSTRAINT uk_contact_cards_(natural|email) UNIQUE/);
  assert.match(baseline, /deleted_at\s+timestamp\(6\) with time zone,?\n/);
  const spring = fileOf(plan('cards-logical', { generator: planSpring }).files, 'db/partial-indexes.sql');
  for (const name of ['uk_contact_cards_natural', 'uk_contact_cards_email']) assert.ok(spring.includes(name), `${name} no está en keel-spring`);
  // La nota neutral del borrado, la misma que los otros tres.
  const remove = fileOf(files, 'internal/application/delete_my_card_command_handler.go');
  const operation = model.services.flatMap((group) => group.operations).find((candidate) => candidate.name === 'deleteMyCard');
  const note = logicalDeletionNote(model, operation, { deleteCall: 'X' }).split('X').at(-1).slice(0, 80).trim();
  assert.ok(flat(remove).includes(note), 'la nota del borrado no es la neutral');
  assert.equal(deletedRootOf(model, operation)?.name, 'ContactCard');
  assert.match(flat(fileOf(files, 'internal/application/restore_my_card_command_handler.go')), /h\.contactCardRepository\.FindDeletedBySubject\(ctx, …\)[\s\S]*h\.contactCardRepository\.Restore\(ctx, <su id>\)/);
});

test('cards-logical en MySQL: la unicidad entre vivas es una columna generada, como en los otros tres', () => {
  const baseline = fileOf(plan('cards-logical', { database: 'mysql' }).files, 'migrations/00001_baseline.sql');
  assert.match(baseline, /uk_contact_cards_email_flag\s+tinyint GENERATED ALWAYS AS \(CASE WHEN deleted_at IS NULL THEN 1 END\)/);
  assert.match(baseline, /CREATE UNIQUE INDEX uk_contact_cards_email ON contact_cards \(email, uk_contact_cards_email_flag\);/);
});

test('cards-logical-mongo: el índice parcial cuenta solo los vivos (T1) y el adaptador marca', () => {
  const { files } = plan('cards-logical-mongo');
  assert.match(fileOf(files, 'internal/infrastructure/mongo/indexes.go'), /SetName\("uk_contact_cards_natural"\)\.SetUnique\(true\)\.SetPartialFilterExpression\(bson\.D\{\{Key: "deletedAt", Value: nil\}\}\)/);
  const adapter = fileOf(files, 'internal/infrastructure/mongo/contact_card_repository.go');
  assert.ok(adapter.includes('r.find(ctx, bson.D{{Key: "_id", Value: uuidValue(id)}, {Key: "deletedAt", Value: nil}}, options.Find().SetLimit(1))'));
  assert.ok(adapter.includes('{Key: "$set", Value: bson.D{{Key: "deletedAt", Value: instantValue(time.Now().UTC())}}}'));
  assert.ok(adapter.includes('SetSort(bson.D{{Key: "deletedAt", Value: -1}})'));
});

test('codes-anonymize: la retención es un recurrente del cronómetro que anonimiza con el sustituto, con el kind y las claves de keel-spring', () => {
  const { files } = plan('codes-anonymize');
  const retention = fileOf(files, 'internal/infrastructure/postgres/verification_code_retention.go');
  assert.match(retention, /substitute := "anon-" \+ id\.String\(\)\s+if _, err := q\.ExecContext\(ctx, "UPDATE verification_codes SET email = \$1, anonymized_at = \$2, lock_version = lock_version \+ 1 WHERE id = \$3", substitute, time\.Now\(\)\.UTC\(\), id\)/);
  assert.ok(retention.includes('"SELECT id FROM verification_codes WHERE issued_at <= $1 AND anonymized_at IS NULL ORDER BY issued_at LIMIT $2"'));
  assert.ok(retention.includes('cutoff := now.Add(-30 * 24 * time.Hour)'));
  assert.ok(retention.includes('return timer.NewRecurring(timer.KindRetentionVerificationCode, spec, r.Run)'));
  assert.match(fileOf(files, 'internal/infrastructure/timer/kinds.go'), /KindRetentionVerificationCode\s+= "retention:VerificationCode"/);
  assert.match(fileOf(plan('codes-anonymize', { generator: planSpring }).files, '/timer/TimerKinds.java'), /RETENTION_VERIFICATION_CODE = "retention:VerificationCode";/);
  const parameters = retentionParameters('VerificationCode');
  const settings = fileOf(files, 'internal/infrastructure/postgres/retention.go');
  assert.ok(settings.includes(`retentionSweep(cfg, "${parameters.cron.key}", "${parameters.cron.default}", "${parameters.batchSize.key}", ${parameters.batchSize.default})`));
  assert.match(fileOf(files, 'config/parameters/develop/retention.yaml'), new RegExp(`cron: "\\$\\{${parameters.cron.env}:`));
  const main = fileOf(files, 'cmd/server/main.go');
  assert.ok(main.includes('postgres.NewVerificationCodeRetention(transactions, retention.VerificationCode.BatchSize).Recurring(retention.VerificationCode.Cron)'));
  assert.match(main, /\[\]timer\.Recurring\{timerPurge, [^}]*retentionVerificationCode\}/);
});

test('codes-anonymize-mongo: la anonimización reescribe el documento, con su marca y su versión', () => {
  const retention = fileOf(plan('codes-anonymize-mongo').files, 'internal/infrastructure/mongo/verification_code_retention.go');
  assert.ok(retention.includes('filter := bson.D{{Key: "issued_at", Value: bson.D{{Key: "$lte", Value: instantValue(cutoff)}}}, {Key: "anonymizedAt", Value: nil}}'));
  assert.ok(retention.includes('{Key: "$set", Value: bson.D{{Key: "email", Value: substitute}, {Key: "anonymizedAt", Value: instantValue(time.Now().UTC())}}}, {Key: "$inc", Value: bson.D{{Key: "lock_version", Value: int64(1)}}}'));
});

test('vault-logical-scoped: el finder suma la vida DETRÁS del alcance, y la lectura por referencia la ve (D3)', () => {
  const { files } = plan('vault-logical-scoped');
  assert.match(fileOf(files, 'internal/infrastructure/postgres/asset_repository.go'), /\tr\.scoped\(&f, scope\)\n\tf\.alive\(\)\n/);
  assert.match(fileOf(files, 'internal/infrastructure/postgres/owner_repository.go'), /r\.load\(ctx, "WHERE id = ANY\(\$1::uuid\[\]\)", uuidTexts\(ids\)\)/);
});

test('la anonimización que keel-go no sabe hacer se rechaza con su motivo', () => {
  assert.throws(
    () => plan('codes-anonymize', { mutate: (layers) => (layers.domain.entities.VerificationCode.fields.aliases = { type: 'string', list: true, personal: true }) }),
    /keel-go no sabe anonimizar VerificationCode\.aliases \(elementCollection\)/
  );
});

test('PD-1: check-logging.sh sale rojo con un campo personal en un log y verde con el id', () => {
  const { files } = plan('cards-logical');
  const root = tmpDir('keel-go-lifecycle-gate-');
  for (const file of files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  const run = () => spawnSync('bash', ['infra/check-logging.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0, `recién generado tiene que salir verde:\n${run().stdout}`);
  const probe = path.join(root, 'internal', 'application', 'probe_logging.go');
  const write = (line) => fs.writeFileSync(probe, `package application\n\nimport (\n\t"context"\n\t"log/slog"\n)\n\nfunc probeLogging(ctx context.Context, logger *slog.Logger, cmd SaveMyCardCommand, card interface{ ID() string; DisplayName() string }) {\n${line}\n}\n`);
  write('\tlogger.InfoContext(ctx, "ficha guardada", "cardId", card.ID())');
  assert.equal(run().status, 0, `loguear el id no puede dar rojo:\n${run().stdout}`);
  for (const line of ['\tlogger.InfoContext(ctx, "ficha", "name", card.DisplayName())', '\tlogger.WarnContext(ctx, "correo repetido", "email", cmd.Email)']) {
    write(line);
    const result = run();
    assert.equal(result.status, 1, `${line.trim()}: tenía que salir rojo\n${result.stdout}`);
    assert.ok(result.stdout.includes('[personal]'), `el hallazgo no nombra su regla\n${result.stdout}`);
  }
});

test('PD-2: el error de una unicidad conocida no lleva el mensaje del motor, con datos personales o sin ellos', () => {
  for (const database of ['postgresql', 'mysql']) {
    const errors = fileOf(plan('cards-logical', { database }).files, `internal/infrastructure/${database === 'mysql' ? 'mysql' : 'postgres'}/errors.go`);
    assert.match(errors, /\t+return known\n/, database);
    assert.doesNotMatch(errors, /known, engine|engine\.Error\(\)/, database);
  }
});

test('T5: borrar y restaurar vacían la caché de las lecturas de la raíz, y el barrido de retención también', () => {
  const mutate = (layers) => (layers['use-cases'].operations.getMyCard.cache = { ttlSeconds: 60, keyFields: ['callerSubject'] });
  const { files } = plan('cards-logical', { mutate });
  const useCases = fileOf(files, 'internal/application/use_cases.go');
  assert.match(useCases, /NewDeleteMyCardCommandHandler[\s\S]*?deps\.OperationCache\.clearing\(GetMyCardCache\)/);
  assert.match(useCases, /NewRestoreMyCardCommandHandler[\s\S]*?deps\.OperationCache\.clearing\(GetMyCardCache\)/);
  const main = fileOf(files, 'cmd/server/main.go');
  assert.match(main, /operationCache := application\.NewOperationCache\(cacheStore, logger\)/);
  assert.match(main, /NewContactCardRetention\(transactions, retention\.ContactCard\.BatchSize, func\(ctx context\.Context\) \{\n\t\toperationCache\.Clear\(ctx, application\.GetMyCardCache\)\n\t\}\)/);
});

// El inventario de datos personales (D10) es el MISMO byte a byte en los cuatro proyectos: lo escribe keel-core, y cada
// generador solo lo coloca. Un diseño sin campos personales no lo lleva.
test('docs/keel/personal-data.md: el mismo en los cuatro, y ausente sin campos personales', () => {
  const generators = { spring: planSpring, nest: planNest, dotnet: planDotnet, go: planService };
  for (const { name } of DATA_LIFECYCLE_DESIGNS) {
    const docs = Object.entries(generators).map(([generator, planOf]) => [generator, plan(name, { generator: planOf }).files.find((file) => file.path === PERSONAL_DATA_FILE)]);
    const [, reference] = docs[0];
    for (const [generator, doc] of docs) {
      assert.equal(doc?.content, reference?.content, `${name}: ${generator} difiere de keel-spring`);
    }
  }
  const withPersonal = plan('codes-anonymize').files.find((file) => file.path === PERSONAL_DATA_FILE);
  assert.ok(withPersonal, 'codes-anonymize marca campos personales y no lleva el inventario');
  assert.match(withPersonal.content, /\| VerificationCode \| /);
  const plain = planService({ ...loadPlain('verification-codes'), workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.equal(plain.files.find((file) => file.path === PERSONAL_DATA_FILE), undefined);
});

function loadPlain(fixture) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return { manifest, layers };
}
