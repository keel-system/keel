// El CICLO DE VIDA DEL DATO (DSL 2.28) en keel-nest: la forma de lo que emite build sobre los diseños de
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
import { DATA_LIFECYCLE_DESIGNS, PERSONAL_TELEMETRY_DESIGN } from '../../keel-core/test/helpers/data-lifecycle-designs.js';
import { planService, scaffoldService } from '../src/scaffold/index.js';
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

test('los sujetos pasan la frontera de keel-nest, y su sonda ejecuta los MISMOS casos que la de keel-spring', () => {
  for (const { name } of DATA_LIFECYCLE_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const nest = lifecycleCases(plan(name).model);
    assert.ok(nest.length > 0, `${name}: la sonda no ejecuta ningún caso`);
    assert.deepEqual(nest, springCases(plan(name, { generator: planSpring }).model), name);
  }
});

test('cards-logical: el borrado marca, las lecturas son vivas y la restauración tiene su ventana', () => {
  const { files } = plan('cards-logical');
  const port = fileOf(files, 'domain/repository/contact-card-repository.ts');
  assert.match(port, /Borrado LÓGICO[\s\S]*abstract deleteById\(id: string\): Promise<void>;/);
  assert.match(port, /abstract findDeletedBySubject\(subject: string\): Promise<ContactCard \| null>;/);
  assert.match(port, /abstract restore\(id: string\): Promise<ContactCard \| null>;/);
  const adapter = fileOf(files, 'repositories/contact-card-repository-impl.ts');
  assert.match(adapter, /findOne\(ContactCardOrm, \{ where: \{ id, deletedAt: IsNull\(\) \} \}\)/);
  assert.match(adapter, /\{ where: \{ subject, deletedAt: IsNull\(\) \} \}/);
  assert.match(adapter, /\{ where: \{ email, deletedAt: IsNull\(\) \} \}/);
  assert.match(adapter, /manager\.update\(ContactCardOrm, \{ id, deletedAt: IsNull\(\) \}, \{ deletedAt: new Date\(\) \}\)/);
  assert.match(adapter, /deletedAt!\.getTime\(\) \+ 30 \* 86_400_000 > Date\.now\(\)\)\) \{\s+throw new CardNotRestorableError\(/);
  assert.match(adapter, /order: \{ deletedAt: 'DESC' \}/);
  // La unicidad deja de ser constraint de tabla: va al índice parcial, con el MISMO nombre que en keel-spring.
  const orm = fileOf(files, 'entities/contact-card-orm.ts');
  assert.doesNotMatch(orm, /@Unique/);
  assert.match(orm, /@Index\('uk_contact_cards_natural', \['subject'\], \{ unique: true, where: 'deleted_at IS NULL' \}\)/);
  assert.match(orm, /@Index\('uk_contact_cards_email', \['email'\], \{ unique: true, where: 'deleted_at IS NULL' \}\)/);
  assert.match(orm, /@Column\(\{ name: 'deleted_at', type: 'timestamptz', precision: 6, nullable: true \}\)\s+deletedAt: Date \| null;/);
  const spring = fileOf(plan('cards-logical', { generator: planSpring }).files, 'db/partial-indexes.sql');
  for (const name of ['uk_contact_cards_natural', 'uk_contact_cards_email']) assert.ok(spring.includes(name), `${name} no está en keel-spring`);
  // Los handlers reciben el puerto y la nota neutral, la misma que keel-spring.
  const remove = fileOf(files, 'delete-my-card-command-handler.ts');
  assert.match(remove, /static readonly inject = \[ContactCardRepository\] as const;/);
  const { model } = plan('cards-logical');
  const operation = model.services.flatMap((group) => group.operations).find((candidate) => candidate.name === 'deleteMyCard');
  const note = logicalDeletionNote(model, operation, { deleteCall: 'X' }).split('X').at(-1).slice(0, 80).trim();
  assert.ok(remove.replace(/\s*\n\s*\/\/\s*/g, ' ').includes(note), 'la nota del borrado no es la neutral');
  assert.equal(deletedRootOf(model, operation)?.name, 'ContactCard');
  assert.match(fileOf(files, 'restore-my-card-command-handler.ts'), /this\.contactCardRepository\.findDeletedBySubject\(\.\.\.\)[\s\S]*this\.contactCardRepository\.restore\(<su id>\)/);
});

test('cards-logical en MySQL: la unicidad entre vivas es una columna generada, como en keel-spring', () => {
  const orm = fileOf(plan('cards-logical', { database: 'mysql' }).files, 'entities/contact-card-orm.ts');
  assert.match(orm, /name: 'uk_contact_cards_email_flag', type: 'tinyint', nullable: true, generatedType: 'STORED', asExpression: 'CASE WHEN deleted_at IS NULL THEN 1 END'/);
  assert.match(orm, /@Index\('uk_contact_cards_email', \['email', 'ukContactCardsEmailFlag'\], \{ unique: true \}\)/);
});

test('cards-logical-mongo: el índice parcial cuenta solo los vivos (T1) y el adaptador marca', () => {
  const { files } = plan('cards-logical-mongo');
  const indexes = fileOf(files, 'persistence/document-indexes.ts');
  assert.match(indexes, /name: 'uk_contact_cards_natural', unique: true, partialFilterExpression: \{ 'deletedAt': null \}/);
  const adapter = fileOf(files, 'repositories/contact-card-repository-impl.ts');
  assert.match(adapter, /findOne\(\{ _id: toUuid\(id\), deletedAt: null \}/);
  assert.match(adapter, /updateOne\(\{ _id: toUuid\(id\), deletedAt: null \}, \{ \$set: \{ deletedAt: new Date\(\) \} \}/);
  assert.match(adapter, /\{ sort: \{ deletedAt: -1 \}/);
});

test('codes-anonymize: la retención es un recurrente del cronómetro que anonimiza con el sustituto, con el kind y las claves de keel-spring', () => {
  const { files } = plan('codes-anonymize');
  const retention = fileOf(files, 'retention/verification-code-retention.ts');
  assert.match(retention, /const substitute = 'anon-' \+ String\(id\);\s+found\.email = substitute;\s+found\.anonymizedAt = new Date\(\);\s+found\.lockVersion = Number\(found\.lockVersion \?\? 0\) \+ 1;/);
  assert.match(retention, /where: \{ issuedAt: LessThanOrEqual\(cutoff\), anonymizedAt: IsNull\(\) \}/);
  const timer = fileOf(files, 'timer/verification-code-retention-timer.ts');
  assert.match(timer, /implements RecurringTimerHandler/);
  assert.match(timer, /const cutoff = new Date\(now\.getTime\(\) - 30 \* 86_400_000\);/);
  const kinds = fileOf(files, 'timer/timer-kinds.ts');
  assert.match(kinds, /RETENTION_VERIFICATION_CODE: 'retention:VerificationCode'/);
  assert.match(fileOf(plan('codes-anonymize', { generator: planSpring }).files, '/timer/TimerKinds.java'), /RETENTION_VERIFICATION_CODE = "retention:VerificationCode";/);
  const parameters = retentionParameters('VerificationCode');
  const settings = fileOf(files, 'retention/retention-settings.ts');
  assert.ok(settings.includes(`'${parameters.cron.key}', '${parameters.cron.default}'`) && settings.includes(`'${parameters.batchSize.key}', ${parameters.batchSize.default}`));
  assert.match(fileOf(files, 'parameters/develop/retention.yaml'), new RegExp(`cron: "\\$\\{${parameters.cron.env}:`));
  assert.match(fileOf(files, 'timer/timer-module.ts'), /\{ provide: RETENTION_SETTINGS, useValue: retentionSettings\(configuration\) \}/);
});

test('codes-anonymize-mongo: la anonimización reescribe el documento, con su marca y su versión', () => {
  const retention = fileOf(plan('codes-anonymize-mongo').files, 'retention/verification-code-retention.ts');
  assert.match(retention, /\.find\(\{ 'issued_at': \{ \$lte: cutoff \}, anonymizedAt: null \}/);
  assert.match(retention, /found\.email = substitute;\s+found\.anonymizedAt = new Date\(\);\s+found\.lock_version = BigInt/);
});

test('vault-logical-scoped: el finder suma la vida DETRÁS del alcance, y la lectura por referencia la ve (D3)', () => {
  const { files } = plan('vault-logical-scoped');
  const asset = fileOf(files, 'repositories/asset-repository-impl.ts');
  assert.match(asset, /for \(const \[property, condition\] of Object\.entries\(this\.readScopeWhere\(scope\)\)\) and\(property, condition\);\n {4}and\('deletedAt', IsNull\(\)\);/);
  const owner = fileOf(files, 'repositories/owner-repository-impl.ts');
  assert.match(owner, /\{ where: \{ id: In\(\[\.\.\.ids\]\) \} \}/);
});

test('la anonimización que keel-nest no sabe hacer se rechaza con su motivo', () => {
  assert.throws(
    () => plan('codes-anonymize', { mutate: (layers) => (layers.domain.entities.VerificationCode.fields.aliases = { type: 'string', list: true, personal: true }) }),
    /keel-nest no sabe anonimizar VerificationCode\.aliases \(elementCollection\)/
  );
});

test('PD-1: check-logging.sh sale rojo con un campo personal en un log y verde con el id', () => {
  const { manifest, layers } = load('cards-logical');
  const workspace = tmpDir('keel-nest-lifecycle-gate-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { database: 'postgresql' } });
  const root = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);
  const run = () => spawnSync('bash', ['infra/check-logging.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0, `recién generado tiene que salir verde:\n${run().stdout}`);
  const dir = path.join(root, 'src', 'application', 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const write = (body) => fs.writeFileSync(path.join(dir, 'probe.ts'), `export function a(command: { email: string }, card: { id: string; displayName: string }): void {\n${body}\n}\n`);
  write('  this.log.log(`ficha ${card.id} guardada`);');
  assert.equal(run().status, 0, 'loguear el id no puede dar rojo');
  for (const body of ['  this.log.log(`ficha de ${card.displayName}`);', "  this.log.warn('correo repetido', command.email);"]) {
    write(body);
    const result = run();
    assert.equal(result.status, 1, `${body.trim()}: tenía que salir rojo\n${result.stdout}`);
    assert.ok(result.stdout.includes('[personal]'), `el hallazgo no nombra su regla\n${result.stdout}`);
  }
});

test('con datos personales ni TypeORM ni el filtro de la API copian el mensaje del motor al log (PD-2); sin ellos, como siempre', () => {
  const { files } = plan('cards-logical');
  assert.match(fileOf(files, 'persistence/data-source-options.ts'), /detalle del motor omitido: puede llevar datos personales/);
  assert.match(fileOf(files, 'rest/api-exception-filter.ts'), /Violación de integridad no asociada a ninguna constraint conocida \(\$\{exception instanceof Error \? exception\.name : 'error'\}\)/);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'profile-directory'));
  const plain = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  assert.doesNotMatch(fileOf(plain, 'persistence/data-source-options.ts'), /detalle del motor omitido/);
  assert.match(fileOf(plain, 'rest/api-exception-filter.ts'), /exception instanceof Error \? exception\.stack : String\(exception\)\);/);
});

test('T5: borrar y restaurar vacían la caché de las lecturas de la raíz, y el barrido de retención también', () => {
  const mutate = (layers) => (layers['use-cases'].operations.getMyCard.cache = { ttlSeconds: 60, keyFields: ['callerSubject'] });
  const { files } = plan('cards-logical', { mutate });
  const invalidations = fileOf(files, 'cache/cache-invalidations.ts');
  assert.match(invalidations, /\[DeleteMyCardCommand, \[GET_MY_CARD_CACHE\]\]/);
  assert.match(invalidations, /\[RestoreMyCardCommand, \[GET_MY_CARD_CACHE\]\]/);
  assert.match(fileOf(files, 'timer/contact-card-retention-timer.ts'), /if \(processed > 0\) \{\s+await this\.operationCache\.clear\(GET_MY_CARD_CACHE\);/);
});

// PD-3 (DSL 2.28): con datos personales el span registra solo la CLASE de la excepción. La violación de una unicidad en
// MySQL llega cruda al span del caso de uso (la traduce el filtro de la API, fuera de él) y su mensaje lleva el valor: lo
// midió el colector OTLP falso de telemetry-check, que es la red en vivo (`--only=PD-3`, `--sabotage=pd-log-value`).
test('PD-3: con datos personales los spans registran solo la clase de la excepción; sin ellos, la excepción entera', () => {
  const telemetryOf = (mutate) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, PERSONAL_TELEMETRY_DESIGN.from));
    if (mutate) mutate(layers);
    const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mysql', telemetry: 'otel' } });
    return files.find((file) => file.path === 'src/infrastructure/telemetry/telemetry.ts').content;
  };
  const personal = telemetryOf(PERSONAL_TELEMETRY_DESIGN.mutate);
  assert.ok(personal.includes("return error instanceof Error ? { name: error.name } : 'error';"));
  assert.equal(personal.match(/span\.recordException\(exceptionOf\(error\)\);/g)?.length, 2, 'el caso de uso y el cliente saliente');
  assert.doesNotMatch(personal, /span\.recordException\(error instanceof Error/);
  const plain = telemetryOf(null);
  assert.doesNotMatch(plain, /exceptionOf/);
  assert.equal(plain.match(/span\.recordException\(error instanceof Error \? error : String\(error\)\);/g)?.length, 2);
});
