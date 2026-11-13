// El HISTORIAL DE CAMBIOS (DSL 2.29) en keel-nest: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/history-designs.js, y su PARIDAD con lo que emite keel-spring del mismo diseño (los mismos casos,
// las mismas sentencias, las mismas tablas, los mismos patrones personales y la misma nota). El diff y la anonimización
// emitidos se EJECUTAN aquí contra sus referencias de keel-core. Lo que esto NO dice —que la entrada entre en la
// transacción, que el autor sea el del token, que la página ordene y filtre, que la lectura no vea lo que la ficha no ve,
// que la retención se lleve o anonimice el historial— lo miden db-check y doc-check contra el motor real
// (scripts/lib/history-probes.js: HI-1 a HI-10).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { historyStatements, CHANGE_HISTORY, CHANGE_HISTORY_FIELD, CHANGE_HISTORY_COLLECTION } from '@keel-system/keel-core/gen/history-store';
import { historyPersonalPatterns, historyDiff, anonymizeHistoryChanges, anonymizedEntryChanges } from '@keel-system/keel-core/gen/history';
import { HISTORY_DESIGNS } from '../../keel-core/test/helpers/history-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { historyCases } from '../scripts/lib/history-probes.js';
import { HISTORY_SUPPORT_TS } from '../src/scaffold/history.js';
import { tsString } from '../src/scaffold/render.js';
import { BSON_VALUES_TS } from '../src/scaffold/document-persistence.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/history-probes.js';

const design = (name) => HISTORY_DESIGNS.find((entry) => entry.name === name);

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name, { database, generator = planService } = {}) {
  const { manifest, layers, document } = load(name);
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: database ?? (document ? 'mongodb' : 'postgresql') } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-nest y su sonda ejecuta los MISMOS casos que la de keel-spring', () => {
  for (const { name } of HISTORY_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    assert.deepEqual(historyCases(plan(name).model), springCases(plan(name, { generator: planSpring }).model), name);
  }
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, como keel-spring, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const nest = fileOf(plan('cards-history', { database }).files, 'history/change-history.ts');
    const spring = fileOf(plan('cards-history', { database, generator: planSpring }).files, '/history/JdbcChangeHistory.java');
    const S = historyStatements(database);
    for (const sql of [S.insertEntry, S.insertField, S.pageHead, S.countHead, S.pageTail, S.entriesOfRoot, S.updateChanges, S.deleteFields, S.deleteEntries, ...Object.values(S.filters)]) {
      assert.ok(nest.includes(tsString(sql).slice(1, -1)), `${database}: keel-nest no lleva ${sql}`);
      assert.ok(spring.includes(JSON.stringify(sql).slice(1, -1)), `${database}: keel-spring no lleva ${sql}`);
    }
  }
});

test('las dos tablas, con su índice y su FK en cascada, entran en el DataSource y en el módulo', () => {
  const { files } = plan('cards-history');
  const orm = fileOf(files, 'history/change-history-orm.ts');
  assert.match(orm, new RegExp(`@Entity\\(\\{ name: '${CHANGE_HISTORY.table}' \\}\\)`));
  assert.match(orm, new RegExp(`@Entity\\(\\{ name: '${CHANGE_HISTORY_FIELD.table}' \\}\\)`));
  assert.ok(orm.includes(`@Index('${CHANGE_HISTORY.indexes[0].name}', ['rootType', 'rootId', 'at', 'id'])`));
  assert.ok(orm.includes("foreignKeyConstraintName: 'fk_change_history_field_entry'"));
  assert.ok(orm.includes("onDelete: 'CASCADE'"));
  for (const column of [...CHANGE_HISTORY.columns, ...CHANGE_HISTORY_FIELD.columns]) assert.ok(orm.includes(`name: '${column.name}'`), column.name);
  assert.match(fileOf(files, 'persistence/data-source-options.ts'), /ChangeHistoryOrm, ChangeHistoryFieldOrm|ChangeHistoryFieldOrm/);
  assert.match(fileOf(files, 'persistence/persistence-module.ts'), /ChangeHistory\b/);
  // El actor de la autoría se emite aunque el diseño no pida autoría en las filas (D5).
  assert.ok(files.some((file) => file.path.endsWith('persistence/audit-actor.ts')));
});

test('en documental, el índice de la lectura va en DOCUMENT_INDEXES y no hay tablas', () => {
  const { files } = plan('cards-history-mongo');
  const indexes = fileOf(files, 'persistence/document-indexes.ts');
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  assert.ok(indexes.includes(`collection: '${CHANGE_HISTORY_COLLECTION.collection}'`));
  assert.ok(indexes.includes(`{ keys: { ${index.keys.map(([key, direction]) => `'${key}': ${direction}`).join(', ')} }, options: { name: '${index.name}' } }`));
  assert.ok(!files.some((file) => file.path.endsWith('change-history-orm.ts')));
  assert.match(fileOf(files, 'history/change-history.ts'), /fields: fields/);
});

test('las rutas personales de cada raíz son los patrones de keel-core, los mismos que lleva keel-spring', () => {
  for (const name of ['cards-history', 'cards-history-anonymize', 'vault-history-scoped']) {
    const { files, model } = plan(name);
    const support = fileOf(files, 'history/history-support.ts');
    const spring = fileOf(plan(name, { generator: planSpring }).files, '/history/HistoryRoots.java');
    for (const entity of model.entities.filter((candidate) => candidate.history)) {
      for (const { pattern, required } of historyPersonalPatterns(entity.historyShape)) {
        assert.ok(support.includes(`{ pattern: new RegExp(${JSON.stringify(pattern).replaceAll('"', "'")}), required: ${required} }`), `${name}: ${pattern}`);
        assert.ok(spring.includes(`PersonalPath.of(${JSON.stringify(pattern)}, ${required})`), `${name} (keel-spring): ${pattern}`);
      }
    }
  }
});

test('el adaptador escribe la entrada en save, en la baja y en la restauración, y la lectura carga la raíz como su ficha', () => {
  const cards = fileOf(plan('cards-history').files, 'contact-card-repository-impl.ts');
  assert.match(cards, /const historyRow = await manager\.findOne\(ContactCardOrm, \{ where: \{ id: entity\.id \} \}\);\n\s+const saved = await manager\.save/);
  assert.match(cards, /await this\.recordSave\(historyRow == null \? null : this\.historySnapshot/);
  assert.match(cards, /if \(!marked\.affected\) return;\n\s+\/\/ El historial[^\n]*\n\s+await this\.changeHistory\.record\(CONTACT_CARD_HISTORY\.type, String\(id\), 'deleted', \[\]\);/);
  assert.match(cards, /'restored', \[\]\);/);
  assert.match(cards, /async historyOf\(id: string, filter: HistoryFilter, pageable: Pageable\): Promise<Page<HistoryEntry> \| null> \{\n[^\n]*\n\s+const root = await this\.findById\(id\);/);
  assert.match(cards, /@Inject\(ChangeHistory\) private readonly changeHistory: ChangeHistory\n/);
  const vault = fileOf(plan('vault-history-scoped').files, 'asset-repository-impl.ts');
  assert.match(vault, /async historyOf\(id: string, scope: ReadScope, filter: HistoryFilter, pageable: Pageable\)[^\n]*\n[^\n]*\n\s+const root = await this\.loadScoped\(id, scope\);/);
  assert.match(vault, /for \(const child of entity\.revisions \?\? \[\]\) \{\n\s+const prefix = `revisions\[\$\{String\(child\.id\)\}\]\.`;/);
  // El historial no registra el id, ni la versión, ni la autoría (D4).
  assert.doesNotMatch(vault, /snapshot\.set\('(id|lockVersion|createdBy|updatedBy|createdAt|updatedAt)'/);
});

test('la retención se lleva el historial o lo anonimiza, en su transacción', () => {
  const purge = fileOf(plan('cards-history').files, 'retention/contact-card-retention.ts');
  assert.match(purge, /await this\.changeHistory\.purge\(CONTACT_CARD_HISTORY\.type, String\(id\)\);/);
  const anonymize = fileOf(plan('cards-history-anonymize').files, 'retention/contact-card-retention.ts');
  assert.match(anonymize, /await this\.changeHistory\.anonymize\(CONTACT_CARD_HISTORY\.type, String\(id\), CONTACT_CARD_HISTORY\.personal\);\n\s+\}\);/);
});

test('la query devuelve la página de entradas, con la nota neutral en el handler, como keel-spring', () => {
  for (const name of ['cards-history', 'vault-history-scoped']) {
    const { files } = plan(name);
    const handler = files.find((file) => /history-query-handler\.ts$/.test(file.path)).content;
    assert.match(handler, /Promise<PagedResponse<HistoryEntry>>/);
    assert.match(handler, /Historial \(output\.history: \w+, DSL 2\.29\)/);
    const controller = files.find((file) => file.path.includes('rest/controllers/') && file.content.includes('History')).content;
    assert.match(controller, /Promise<PagedResponse<HistoryEntry>>/);
    const spring = plan(name, { generator: planSpring }).files.find((file) => /HistoryQueryHandler\.java$/.test(file.path)).content;
    const tail = (text) => /lectura que su ficha[\s\S]*?por otra vía\./.exec(text.replace(/\s*(\/\/|\*)\s*/g, ' '))?.[0];
    assert.ok(tail(handler), `${name}: la nota no está en el handler`);
    assert.equal(tail(handler), tail(spring), `${name}: la nota dice lo mismo en los dos`);
  }
});

test('lo emitido para una fixture sin historial no nombra el historial', () => {
  // profile-directory lo declara desde la v1.2.0: shop-api, relacional y con datos personales, no.
  const { files } = planFixture('shop-api', { stack: { database: 'postgresql' } });
  assert.ok(!files.some((file) => /history/.test(file.path)));
  assert.ok(!files.some((file) => typeof file.content === 'string' && /ChangeHistory|recordSave/.test(file.content)));
});

test('el diff y la anonimización emitidos EJECUTAN lo mismo que las referencias de keel-core', async () => {
  const { files, model } = plan('vault-history-scoped');
  const { load: loadModule } = transpileTree(files);
  const emitted = await loadModule(HISTORY_SUPPORT_TS);
  const { parseWireJson } = await loadModule('src/application/support/wire.ts');
  const shape = model.entities.find((entity) => entity.name === 'Asset').historyShape;
  // Las instantáneas como las arma el adaptador: ruta → texto del cable.
  const snapshot = (object) => {
    const map = new Map();
    for (const path of shape.paths) map.set(path, JSON.stringify(object[path] ?? null));
    for (const child of shape.children) {
      for (const item of object[child.relation] ?? []) for (const path of child.paths) map.set(`${child.relation}[${item.id}].${path}`, JSON.stringify(item[path] ?? null));
    }
    return map;
  };
  const before = { title: 'uno', status: 'draft', labels: ['a'], revisions: [{ id: 'r1', revisionNumber: 1, note: null }, { id: 'r2', revisionNumber: 2, note: 'x' }] };
  const after = { title: 'dos', status: 'draft', labels: ['a', 'b'], revisions: [{ id: 'r1', revisionNumber: 1, note: 'nota' }, { id: 'r3', revisionNumber: 3, note: null }] };
  const plain = (changes) => JSON.parse(JSON.stringify(changes, (_key, value) => (value?.constructor?.name === 'WireNumber' ? Number(value.source) : value)));
  assert.deepEqual(plain(emitted.historyDiff(snapshot(before), snapshot(after))), historyDiff(shape, before, after));
  assert.deepEqual(plain(emitted.historyDiff(null, snapshot(after))), historyDiff(shape, null, after));
  assert.deepEqual(emitted.historyDiff(snapshot(after), snapshot(after)), []);

  // La anonimización, sobre los patrones de una raíz con campos personales.
  const { files: anonFiles, model: anonModel } = plan('cards-history-anonymize');
  const anon = await transpileTree(anonFiles).load(HISTORY_SUPPORT_TS);
  const patterns = historyPersonalPatterns(anonModel.entities.find((entity) => entity.name === 'ContactCard').historyShape);
  const personal = patterns.map(({ pattern, required }) => ({ pattern: new RegExp(pattern), required }));
  assert.deepEqual(anon.CONTACT_CARD_HISTORY.personal.map((entry) => [entry.pattern.source, entry.required]), personal.map((entry) => [entry.pattern.source, entry.required]));
  const entries = [
    [{ field: 'subject', before: null, after: 's-1' }, { field: 'email', before: null, after: 'a@x.com' }, { field: 'displayName', before: null, after: 'Ana' }],
    [{ field: 'email', before: 'a@x.com', after: 'b@x.com' }]
  ];
  for (const changes of entries) {
    assert.deepEqual(anon.anonymizeChanges(parseWireJson(JSON.stringify(changes)), anon.CONTACT_CARD_HISTORY.personal, 'r-1'), anonymizeHistoryChanges(changes, patterns, 'r-1'));
  }
  assert.deepEqual(anon.anonymizedEntryChanges(entries, anon.CONTACT_CARD_HISTORY.personal, 'r-1'), anonymizedEntryChanges(entries, patterns, 'r-1'));
});

// history.js escribe la ruta de bson-values.ts a mano (importarla cierra un ciclo de módulos): que no se desvíe.
test('el almacén documental importa KeyedDocument de la ruta real de bson-values.ts', () => {
  const source = fs.readFileSync(new URL('../src/scaffold/history.js', import.meta.url), 'utf8');
  assert.ok(source.includes(`const BSON_VALUES_TS = '${BSON_VALUES_TS}';`), 'la copia de BSON_VALUES_TS en history.js no es la de document-persistence.js');
});
