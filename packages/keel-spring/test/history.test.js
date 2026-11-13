// El HISTORIAL DE CAMBIOS (DSL 2.29) en keel-spring: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/history-designs.js. Lo que esto NO dice —que la entrada entre en la transacción, que el diff sea
// solo lo que cambió, que el autor sea el del token, que la página ordene y filtre, que la lectura no vea lo que la ficha
// no ve, que la retención se lleve o anonimice el historial— lo mide scripts/history-check.js contra el motor real
// (HI-1 a HI-10).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { historyStatements } from '@keel-system/keel-core/gen/history-store';
import { historyPersonalPatterns } from '@keel-system/keel-core/gen/history';
import { HISTORY_DESIGNS } from '../../keel-core/test/helpers/history-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { casesOf } from '../src/lib/history-probes.js';
import { historyStackErrors } from '../src/scaffold/history.js';
import { buildModel } from '../src/lib/model.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => HISTORY_DESIGNS.find((entry) => entry.name === name);

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
const javaText = (text) => JSON.stringify(text);

test('los sujetos pasan la frontera de keel-spring y su sonda ejecuta los casos que les tocan', () => {
  const expected = {
    'cards-history': ['HI-1', 'HI-2', 'HI-4', 'HI-5', 'HI-6', 'HI-7', 'HI-9', 'HI-10'],
    'cards-history-mongo': ['HI-1', 'HI-2', 'HI-4', 'HI-5', 'HI-6', 'HI-7', 'HI-9', 'HI-10'],
    'cards-history-anonymize': ['HI-1', 'HI-2', 'HI-4', 'HI-5', 'HI-6', 'HI-7', 'HI-8', 'HI-10'],
    'vault-history-scoped': ['HI-1', 'HI-2', 'HI-3', 'HI-4', 'HI-5', 'HI-6', 'HI-7'],
    'vault-history-scoped-mongo': ['HI-1', 'HI-2', 'HI-3', 'HI-4', 'HI-5', 'HI-6', 'HI-7']
  };
  for (const { name } of HISTORY_DESIGNS) {
    const { manifest, layers, document } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const model = buildModel({ manifest, layers, stack: { database: document ? 'mongodb' : 'postgresql' } });
    assert.deepEqual(casesOf(model), expected[name], name);
  }
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const store = fileOf(plan('cards-history', { database }).files, '/history/JdbcChangeHistory.java');
    const S = historyStatements(database);
    for (const sql of [S.insertEntry, S.insertField, S.pageHead, S.countHead, S.pageTail, S.entriesOfRoot, S.updateChanges, S.deleteFields, S.deleteEntries, ...Object.values(S.filters)]) {
      assert.ok(store.includes(javaText(sql)), `${database}: falta la sentencia ${sql}`);
    }
    // Las dos tablas, mapeadas solo para el esquema, con los nombres de keel-core.
    const files = plan('cards-history', { database }).files;
    assert.match(fileOf(files, '/ChangeHistoryJpa.java'), /@Table\(name = "change_history", indexes = @Index\(name = "ix_change_history_root", columnList = "root_type, root_id, at, id"\)\)/);
    assert.match(fileOf(files, '/ChangeHistoryFieldJpa.java'), /foreignKey = @ForeignKey\(name = "fk_change_history_field_entry"\)\)\s+@OnDelete\(action = OnDeleteAction\.CASCADE\)/);
  }
});

test('el adaptador escribe la entrada en save (con lo que había, leído antes), en la baja, en la restauración y lee por historyOf', () => {
  const { files } = plan('cards-history');
  const adapter = fileOf(files, '/persistence/repositories/ContactCardRepositoryImpl.java');
  // T1: la instantánea «antes» sale de la fila cargada ANTES de volcar el agregado.
  assert.match(adapter, /Map<String, JsonNode> historyBefore = [^;]*findById\(entity\.getId\(\)\)\.map\(this::toDomain\)\.map\(this::historySnapshot\)[^;]*;\s+ContactCard saved = saveUnrecorded\(entity\);\s+recordSave\(historyBefore, saved\);/);
  assert.match(adapter, /HistoryDiff\.diff\(before, historySnapshot\(saved\)\)/);
  assert.match(adapter, /snapshot\.put\("email", changeHistory\.value\(entity\.getEmail\(\)\)\);/);
  assert.doesNotMatch(adapter, /snapshot\.put\("id"/, 'D4: el id es generated y no entra en el historial');
  assert.match(adapter, /setDeletedAt\(Instant\.now\(\)\);\s+\/\/[^\n]*\n\s+changeHistory\.record\(HistoryRoots\.CONTACT_CARD, String\.valueOf\(id\), ChangeHistory\.DELETED, List\.of\(\)\);/);
  assert.match(adapter, /changeHistory\.record\(HistoryRoots\.CONTACT_CARD, String\.valueOf\(id\), ChangeHistory\.RESTORED, List\.of\(\)\);\s+return Optional\.of\(restored\);/);
  assert.match(adapter, /public Optional<Page<HistoryEntry>> historyOf\(UUID id, HistoryFilter filter, Pageable pageable\) \{[\s\S]*?return findById\(id\)/);
  const port = fileOf(files, '/domain/repository/ContactCardRepository.java');
  assert.match(port, /Optional<Page<HistoryEntry>> historyOf\(UUID id, HistoryFilter filter, Pageable pageable\);/);
  // La purga de lo borrado se lleva el historial (D8), en la transacción de apply.
  assert.match(fileOf(files, '/ContactCardRetention.java'), /contactCardJpaRepository\.deleteById\(id\);\s+\/\/[^\n]*\n\s+changeHistory\.purge\(HistoryRoots\.CONTACT_CARD, String\.valueOf\(id\)\);/);
});

test('las rutas personales de HistoryRoots son los patrones de keel-core, y la retención que anonimiza los usa', () => {
  const { manifest, layers } = load('cards-history-anonymize');
  const model = buildModel({ manifest, layers, stack: { database: 'postgresql' } });
  const card = model.entities.find((entity) => entity.name === 'ContactCard');
  const { files } = plan('cards-history-anonymize');
  const roots = fileOf(files, '/domain/history/HistoryRoots.java');
  for (const { pattern, required } of historyPersonalPatterns(card.historyShape)) {
    assert.ok(roots.includes(`PersonalPath.of(${javaText(pattern)}, ${required})`), `falta ${pattern}`);
  }
  assert.match(fileOf(files, '/ContactCardRetention.java'), /changeHistory\.anonymize\(HistoryRoots\.CONTACT_CARD, String\.valueOf\(id\), HistoryRoots\.CONTACT_CARD_PERSONAL\);/);
});

test('la lectura acotada: historyOf carga con loadScoped, y las hijas viajan por su id', () => {
  for (const name of ['vault-history-scoped', 'vault-history-scoped-mongo']) {
    const { files } = plan(name);
    const adapter = fileOf(files, '/persistence/repositories/AssetRepositoryImpl.java');
    assert.match(adapter, /public Optional<Page<HistoryEntry>> historyOf\(UUID id, ReadScope scope, HistoryFilter filter, Pageable pageable\) \{[\s\S]*?return loadScoped\(id, scope\)/, name);
    assert.match(adapter, /String prefix = "revisions\[" \+ child\.getId\(\) \+ "\]\.";/, name);
    assert.doesNotMatch(adapter, /prefix \+ "assetId"/, `${name}: la hija no registra su vuelta a la raíz`);
  }
  assert.match(fileOf(plan('vault-history-scoped-mongo').files, '/history/MongoChangeHistory.java'), /\.named\("ix_change_history_root"\)/);
});

test('la query devuelve la página del contrato y su handler lleva la nota neutral', () => {
  const { files } = plan('cards-history');
  assert.match(fileOf(files, '/application/queries/GetMyCardHistoryQuery.java'), /implements Query<PagedResponse<HistoryEntry>>/);
  const handler = fileOf(files, '/application/usecases/GetMyCardHistoryQueryHandler.java');
  assert.match(handler, /public PagedResponse<HistoryEntry> handle\(GetMyCardHistoryQuery query\)/);
  assert.match(handler, /Historial \(output\.history: ContactCard, DSL 2\.29\): contactCardRepository\.historyOf\(<su id>, new HistoryFilter\(query\.field\(\), query\.from\(\), query\.to\(\)\), query\.pageable\(\)\)/);
  assert.match(fileOf(files, 'ContactCardV1Controller.java'), /public PagedResponse<HistoryEntry> getMyCardHistory\(/);
});

test('el actor de la autoría existe aunque el diseño no la pida en las filas (D5), y sin historial nada de esto se emite', () => {
  const { files } = plan('cards-history');
  assert.ok(files.some((file) => file.path.endsWith('/AuditorAwareConfig.java')), 'falta el AuditorAware que da el autor');
  const plain = plan('cards-history', {
    mutate(layers) {
      delete layers.persistence.audit.history;
      delete layers['use-cases'].operations.getMyCardHistory;
      delete layers.api.endpoints.getMyCardHistory;
      delete layers.security.access.rules.getMyCardHistory;
    }
  }).files;
  assert.ok(!plain.some((file) => /\/(domain\/history|persistence\/history)\//.test(file.path)), 'sin historial no hay almacén');
  assert.ok(!plain.some((file) => file.path.endsWith('/AuditorAwareConfig.java')));
  assert.doesNotMatch(fileOf(plain, '/persistence/repositories/ContactCardRepositoryImpl.java'), /changeHistory|historySnapshot/);
});

test('la frontera: un motor sin sentencias medidas del historial se rechaza con su motivo', () => {
  const { manifest, layers } = load('cards-history');
  const modelOn = (database) => Object.assign(buildModel({ manifest, layers, stack: { database } }), { stack: { database } });
  const errors = historyStackErrors(modelOn('mariadb'));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /audit\.history \(DSL 2\.29\): el almacén del historial tiene sentencias medidas para postgresql, mysql, y no para 'mariadb'/);
  assert.deepEqual(historyStackErrors(modelOn('mysql')), []);
});
