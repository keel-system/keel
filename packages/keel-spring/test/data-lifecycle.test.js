// El CICLO DE VIDA DEL DATO (DSL 2.28) en keel-spring: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/data-lifecycle-designs.js. Lo que esto NO dice —que el listado deje fuera lo borrado, que el
// índice libere la clave, que la ventana se compruebe, que el barrido no se adelante— lo mide scripts/lifecycle-check.js
// contra el motor real (LC-*, RT-1, RT-2, RT-4 y PD-2). PD-1, el gate de logs, sí se EJECUTA aquí, con bash.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { DATA_LIFECYCLE_DESIGNS, PERSONAL_TELEMETRY_DESIGN, withoutLifecycle } from '../../keel-core/test/helpers/data-lifecycle-designs.js';
import { planService, scaffoldService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { casesOf } from '../src/lib/lifecycle-probes.js';
import { buildModel } from '../src/lib/model.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const design = (name) => DATA_LIFECYCLE_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name, { database, mutate } = {}) {
  const { manifest, layers, document } = load(name, mutate);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: database ?? (document ? 'mongodb' : 'postgresql') } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-spring y su sonda ejecuta casos', () => {
  for (const { name } of DATA_LIFECYCLE_DESIGNS) {
    const { manifest, layers, document } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const model = buildModel({ manifest, layers, stack: { database: document ? 'mongodb' : 'postgresql' } });
    assert.ok(casesOf(model).length > 0, `${name}: la sonda no ejecuta ningún caso`);
  }
});

test('cards-logical: el borrado marca, las lecturas son vivas y la restauración tiene su ventana', () => {
  const { files } = plan('cards-logical');
  const port = fileOf(files, '/domain/repository/ContactCardRepository.java');
  assert.match(port, /Borrado LÓGICO[\s\S]*void deleteById\(UUID id\);/);
  assert.match(port, /Optional<ContactCard> findDeletedBySubject\(String subject\);/);
  assert.match(port, /Optional<ContactCard> restore\(UUID id\);/);
  const adapter = fileOf(files, '/persistence/repositories/ContactCardRepositoryImpl.java');
  assert.match(adapter, /contactCardJpaRepository\.findByIdAndDeletedAtIsNull\(id\)\.map\(this::toDomain\)/);
  assert.match(adapter, /findBySubjectAndDeletedAtIsNull\(subject\)/);
  assert.match(adapter, /findByEmailAndDeletedAtIsNull\(email\)/);
  assert.match(adapter, /findByIdAndDeletedAtIsNull\(id\)\.ifPresent\(jpa -> jpa\.setDeletedAt\(Instant\.now\(\)\)\)/);
  assert.match(adapter, /plus\(Duration\.ofDays\(30L\)\)\.isAfter\(Instant\.now\(\)\)\) \{\s+throw new CardNotRestorableError\(/);
  assert.match(adapter, /saveAndFlush\(row\)/);
  // La unicidad deja de ser constraint de tabla: va al índice parcial, con el MISMO nombre.
  const jpa = fileOf(files, '/persistence/entities/ContactCardJpa.java');
  assert.doesNotMatch(jpa, /UniqueConstraint/);
  assert.match(jpa, /@Column\(name = "deleted_at"\)\s+private Instant deletedAt;/);
  const sql = fileOf(files, 'db/partial-indexes.sql');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uk_contact_cards_natural ON contact_cards \(subject\) WHERE deleted_at IS NULL;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uk_contact_cards_email ON contact_cards \(email\) WHERE deleted_at IS NULL;/);
  // Los handlers reciben el puerto y la nota neutral.
  assert.match(fileOf(files, '/DeleteMyCardCommandHandler.java'), /private final ContactCardRepository contactCardRepository;[\s\S]*Borrado lógico \(persistence\.ContactCard\.deletion: logical/);
  assert.match(fileOf(files, '/RestoreMyCardCommandHandler.java'), /contactCardRepository\.findDeletedBySubject\(\.\.\.\)[\s\S]*contactCardRepository\.restore\(<su id>\)/);
});

test('cards-logical en MySQL: la unicidad entre vivas es una columna generada', () => {
  const sql = fileOf(plan('cards-logical', { database: 'mysql' }).files, 'db/partial-indexes.sql');
  assert.match(sql, /`uk_contact_cards_email_flag` TINYINT GENERATED ALWAYS AS \(CASE WHEN deleted_at IS NULL THEN 1 END\) STORED/);
});

test('cards-logical-mongo: el índice parcial cuenta solo los vivos (T1) y el adaptador marca', () => {
  const { files } = plan('cards-logical-mongo');
  const indexes = fileOf(files, 'MongoIndexConfig.java');
  assert.match(indexes, /\.unique\(\)\s+\.partial\(PartialIndexFilter\.of\(Criteria\.where\("deletedAt"\)\.is\(null\)\)\)\s+\.named\("uk_contact_cards_natural"\)/);
  const adapter = fileOf(files, '/persistence/repositories/ContactCardRepositoryImpl.java');
  assert.match(adapter, /findByIdAndDeletedAtIsNull\(id\)\.ifPresent\(document -> \{\s+document\.setDeletedAt\(Instant\.now\(\)\);/);
  assert.match(fileOf(files, 'ContactCardDocument.java'), /private Instant deletedAt;/);
});

test('codes-anonymize: la retención es un recurrente del cronómetro que anonimiza con el sustituto', () => {
  const { files } = plan('codes-anonymize');
  const retention = fileOf(files, '/retention/VerificationCodeRetention.java');
  assert.match(retention, /row\.setEmail\("anon-" \+ id\);\s+row\.setAnonymizedAt\(Instant\.now\(\)\);/);
  const repository = fileOf(files, 'VerificationCodeJpaRepository.java');
  assert.match(repository, /where e\.issuedAt <= :cutoff and e\.anonymizedAt is null order by e\.issuedAt asc/);
  const timer = fileOf(files, '/timer/VerificationCodeRetentionTimer.java');
  assert.match(timer, /implements RecurringTimerHandler/);
  assert.match(timer, /@Value\("\$\{retention\.verification-code\.cron:0 30 2 \* \* \*\}"\)/);
  assert.match(timer, /Instant cutoff = now\.minus\(Duration\.ofDays\(30\)\);/);
  assert.match(fileOf(files, '/timer/TimerKinds.java'), /RETENTION_VERIFICATION_CODE = "retention:VerificationCode";/);
});

test('codes-anonymize-mongo: save arrastra la marca de la anonimización (D11)', () => {
  const adapter = fileOf(plan('codes-anonymize-mongo').files, 'VerificationCodeRepositoryImpl.java');
  assert.match(adapter, /\.ifPresent\(existing -> document\.setAnonymizedAt\(existing\.getAnonymizedAt\(\)\)\);/);
});

test('vault-logical-scoped: el finder suma la vida al alcance, y la lectura por referencia la ve (D3)', () => {
  const { files } = plan('vault-logical-scoped');
  const asset = fileOf(files, '/persistence/repositories/AssetRepositoryImpl.java');
  assert.match(asset, /where\.add\(readScope\(root, query, cb, scope\)\);\n\s+where\.add\(cb\.isNull\(root\.get\("deletedAt"\)\)\);/);
  assert.match(asset, /candidatesForReconcileScansScanAsset|claimForReconcileScans/);
  assert.match(fileOf(files, 'AssetJpaRepository.java'), /and e\.deletedAt is null/);
  const owner = fileOf(files, '/persistence/repositories/OwnerRepositoryImpl.java');
  assert.match(owner, /return ownerJpaRepository\.findAllById\(ids\)\.stream\(\)/);
});

test('la frontera del stack: sin índice parcial no hay unicidad entre vivas, y sin cronómetro no hay retención', () => {
  assert.throws(() => plan('cards-logical', { database: 'mariadb', mutate: (layers) => delete layers.persistence.entities.ContactCard.retention }), /deletion: logical \(DSL 2\.28\): sus unicidades solo pueden contar las filas vivas/);
  assert.throws(() => plan('codes-delete', { database: 'oracle' }), /la retención corre sobre el cronómetro/);
});

test('PD-1: check-logging.sh sale rojo con el accesor de un campo personal y verde con el id', () => {
  const { manifest, layers } = load('cards-logical');
  const workspace = tmpDir('keel-lifecycle-gate-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { database: 'postgresql' } });
  const root = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);
  const run = () => spawnSync('bash', ['infra/check-logging.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0, `recién generado tiene que salir verde:\n${run().stdout}`);
  const dir = path.join(root, 'src', 'main', 'java', 'x');
  fs.mkdirSync(dir, { recursive: true });
  const write = (body) => fs.writeFileSync(path.join(dir, 'Probe.java'), `package x;\nclass Probe {\n    void a(Object command, Object card) {\n${body}\n    }\n}\n`);
  write('        log.info("Ficha {} guardada", card.getId());');
  assert.equal(run().status, 0, 'loguear el id no puede dar rojo');
  for (const body of ['        log.info("Ficha de {}", card.getEmail());', '        log.warn("Correo {} repetido", command.email());', '        log.info("Nombre {}", card.getDisplayName());']) {
    write(body);
    const result = run();
    assert.equal(result.status, 1, `${body.trim()}: tenía que salir rojo\n${result.stdout}`);
    assert.ok(result.stdout.includes('[personal]'), `el hallazgo no nombra su regla\n${result.stdout}`);
  }
});

test('con datos personales el aspecto y Hibernate no copian el mensaje del motor al log (PD-2); sin ellos, como siempre', () => {
  const { files } = plan('cards-logical');
  const aspect = fileOf(files, 'LogExceptionsAspect.java');
  assert.match(aspect, /String detail = exception instanceof DataAccessException/);
  assert.match(fileOf(files, 'parameters/local/logging.yaml'), /org\.hibernate\.orm\.jdbc\.error: OFF/);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'profile-directory'));
  withoutLifecycle(layers);
  const plain = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  assert.doesNotMatch(fileOf(plain, 'LogExceptionsAspect.java'), /DataAccessException/);
  assert.doesNotMatch(fileOf(plain, 'parameters/local/logging.yaml'), /orm\.jdbc\.error/);
});

test('T5: borrar y restaurar vacían la caché de las lecturas de la raíz, y el barrido de retención también', () => {
  const { files } = plan('cards-logical', { mutate: (layers) => (layers['use-cases'].operations.getMyCard.cache = { ttlSeconds: 60, keyFields: ['callerSubject'] }) });
  const mediator = fileOf(files, 'UseCaseMediator.java');
  assert.match(mediator, /Map\.entry\(DeleteMyCardCommand\.class, List\.of\(CachedOperations\.GET_MY_CARD_CACHE\)\)/);
  assert.match(mediator, /Map\.entry\(RestoreMyCardCommand\.class, List\.of\(CachedOperations\.GET_MY_CARD_CACHE\)\)/);
  assert.match(fileOf(files, 'ContactCardRetentionTimer.java'), /if \(processed > 0\) \{\s+operationCache\.clear\(CachedOperations\.GET_MY_CARD_CACHE\);/);
});

// PD-3 (DSL 2.28): con datos personales y telemetría, el span del caso de uso no recibe el mensaje de una excepción de
// acceso a datos, que al violar una unicidad lleva el valor (la traduce el @ControllerAdvice, fuera de la observación).
// En keel-nest esa misma fuga la midió el colector OTLP falso de su telemetry-check; aquí la red en vivo está pendiente.
test('PD-3: con datos personales el span del caso de uso lleva solo la clase de una DataAccessException; sin ellos, como siempre', () => {
  const mediator = (mutate) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, PERSONAL_TELEMETRY_DESIGN.from));
    if (mutate) mutate(layers);
    const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mysql', telemetry: 'otel' } });
    return files.find((file) => file.path.endsWith('/UseCaseMediator.java')).content;
  };
  const personal = mediator(PERSONAL_TELEMETRY_DESIGN.mutate);
  assert.ok(personal.includes('observation.error(ex instanceof DataAccessException ? new IllegalStateException(ex.getClass().getName()) : ex);'));
  assert.match(personal, /^import org\.springframework\.dao\.DataAccessException;$/m);
  const plain = mediator(withoutLifecycle);
  assert.ok(plain.includes('observation.error(ex);'));
  assert.doesNotMatch(plain, /DataAccessException/);
});
