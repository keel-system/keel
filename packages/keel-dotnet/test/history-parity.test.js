// El HISTORIAL DE CAMBIOS (DSL 2.29) en keel-dotnet: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/history-designs.js, y su PARIDAD con lo que emiten keel-spring y keel-nest del mismo diseño (los
// mismos casos, las mismas sentencias, las mismas tablas, los mismos patrones personales y la misma nota). Lo que esto NO
// dice —que la entrada entre en la transacción, que el autor sea el del token, que la página ordene y filtre, que la lectura
// no vea lo que la ficha no ve, que la retención se lleve o anonimice el historial— lo miden db-check y doc-check contra el
// motor real (scripts/lib/history-probes.js: HI-1 a HI-10). El diff y la anonimización emitidos los EJECUTA la prueba
// emitida HistorySupportTests contra las referencias de keel-core, en cs-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { historyStatements, CHANGE_HISTORY, CHANGE_HISTORY_FIELD, CHANGE_HISTORY_COLLECTION } from '@keel-system/keel-core/gen/history-store';
import { historyPersonalPatterns } from '@keel-system/keel-core/gen/history';
import { HISTORY_DESIGNS } from '../../keel-core/test/helpers/history-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { historyCases } from '../scripts/lib/history-probes.js';
import { csString, csVerbatim } from '../src/scaffold/render.js';
import { FIXTURES_DIR, planFixture } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/history-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { historyCases as nestCases } from '../../keel-nest/scripts/lib/history-probes.js';

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

test('los sujetos pasan la frontera de keel-dotnet y su sonda ejecuta los MISMOS casos que las de keel-spring y keel-nest', () => {
  for (const { name } of HISTORY_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const mine = historyCases(plan(name).model);
    assert.deepEqual(mine, springCases(plan(name, { generator: planSpring }).model), `${name} (keel-spring)`);
    assert.deepEqual(mine, nestCases(plan(name, { generator: planNest }).model), `${name} (keel-nest)`);
  }
});

test('un motor sin sentencias del historial se rechaza en planService, con el mismo motivo que keel-nest', () => {
  const { manifest, layers } = load('cards-history');
  assert.throws(() => planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mariadb' } }), /el almacén del historial tiene sentencias medidas para postgresql, mysql/);
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, como keel-spring y keel-nest, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const mine = fileOf(plan('cards-history', { database }).files, 'Persistence/History/ChangeHistory.cs');
    const spring = fileOf(plan('cards-history', { database, generator: planSpring }).files, '/history/JdbcChangeHistory.java');
    const S = historyStatements(database);
    for (const sql of [S.insertEntry, S.insertField, S.pageHead, S.countHead, S.pageTail, S.entriesOfRoot, S.updateChanges, S.deleteFields, S.deleteEntries, ...Object.values(S.filters)]) {
      assert.ok(mine.includes(csString(sql)), `${database}: keel-dotnet no lleva ${sql}`);
      assert.ok(spring.includes(JSON.stringify(sql).slice(1, -1)), `${database}: keel-spring no lleva ${sql}`);
    }
    // La entrada va por la transacción en curso del contexto, con el autor de la autoría.
    assert.match(mine, /command\.Transaction = db\.Database\.CurrentTransaction\?\.GetDbTransaction\(\);/);
    assert.match(mine, /\["author"\] = AuditActor\.Current\(\)/);
  }
});

test('las dos tablas, con su índice y su FK en cascada, entran en el DbContext, en el registro y en la prueba del modelo', () => {
  const { files } = plan('cards-history');
  const rows = fileOf(files, 'Persistence/Rows/ChangeHistoryRow.cs');
  assert.ok(rows.includes(`row.ToTable("${CHANGE_HISTORY.table}");`));
  assert.ok(rows.includes(`row.ToTable("${CHANGE_HISTORY_FIELD.table}");`));
  const index = CHANGE_HISTORY.indexes[0];
  assert.ok(rows.includes(`row.HasIndex(r => new { r.RootType, r.RootId, r.At, r.Id }, "${index.name}").HasDatabaseName("${index.name}");`));
  assert.match(rows, /HasConstraintName\("fk_change_history_field_entry"\)\.OnDelete\(DeleteBehavior\.Cascade\)/);
  // text, y no el longtext que MySQL daría a una cadena sin tope: el tipo de los otros tres.
  assert.match(rows, /HasColumnName\("changes"\)\.HasColumnType\("text"\)/);
  for (const column of [...CHANGE_HISTORY.columns, ...CHANGE_HISTORY_FIELD.columns]) assert.ok(rows.includes(`.HasColumnName("${column.name}")`), column.name);
  const context = files.find((file) => file.path.endsWith('DbContext.cs') && !file.path.includes('DesignTime')).content;
  assert.match(context, /ApplyConfiguration\(new ChangeHistoryRowConfiguration\(\)\)/);
  assert.match(context, /ApplyConfiguration\(new ChangeHistoryFieldRowConfiguration\(\)\)/);
  assert.match(fileOf(files, 'Persistence/PersistenceRegistration.cs'), /services\.AddScoped<ChangeHistory>\(\);/);
  const model = fileOf(files, 'PersistenceModelTests.cs');
  for (const name of ['change_history', 'change_history_pkey', index.name, 'change_history_field', 'change_history_field_pkey', 'fk_change_history_field_entry']) assert.ok(model.includes(`[InlineData("${name}")]`), name);
  // El actor de la autoría se emite aunque el diseño no pida autoría en las filas (D5).
  assert.ok(files.some((file) => file.path.endsWith('Persistence/AuditActor.cs')));
});

test('en documental, el índice de la lectura va en DocumentIndexes con sus direcciones y no hay tablas', () => {
  const { files } = plan('cards-history-mongo');
  const indexes = fileOf(files, 'Persistence/DocumentIndexes.cs');
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  assert.ok(indexes.includes(`["${CHANGE_HISTORY_COLLECTION.collection}"] =`));
  assert.ok(indexes.includes(`new(new BsonDocument { ${index.keys.map(([key, direction]) => `{ "${key}", ${direction} }`).join(', ')} }, new CreateIndexOptions<BsonDocument> { Name = "${index.name}" })`));
  assert.ok(!files.some((file) => file.path.endsWith('ChangeHistoryRow.cs')));
  const store = fileOf(files, 'Persistence/History/ChangeHistory.cs');
  assert.match(store, /\{ "fields", rows \}/);
  assert.match(store, /\{ "changes", HistorySupport\.WriteChanges\(changes\) \}/);
  assert.match(store, /\.Sort\(new BsonDocument \{ \{ "at", -1 \}, \{ "_id", -1 \} \}\)/);
  assert.match(fileOf(files, 'Persistence/PersistenceRegistration.cs'), /services\.AddScoped<ChangeHistory>\(\);/);
});

test('las rutas personales de cada raíz son los patrones de keel-core, los mismos que llevan keel-spring y keel-nest', () => {
  for (const name of ['cards-history', 'cards-history-anonymize', 'vault-history-scoped']) {
    const { files, model } = plan(name);
    const support = fileOf(files, 'Persistence/History/HistorySupport.cs');
    const spring = fileOf(plan(name, { generator: planSpring }).files, '/history/HistoryRoots.java');
    const nest = fileOf(plan(name, { generator: planNest }).files, 'history/history-support.ts');
    for (const entity of model.entities.filter((candidate) => candidate.history)) {
      for (const { pattern, required } of historyPersonalPatterns(entity.historyShape)) {
        assert.ok(support.includes(`new PersonalPath(new Regex(${csVerbatim(pattern)}, RegexOptions.CultureInvariant), ${required})`), `${name}: ${pattern}`);
        assert.ok(spring.includes(`PersonalPath.of(${JSON.stringify(pattern)}, ${required})`), `${name} (keel-spring): ${pattern}`);
        assert.ok(nest.includes(`{ pattern: new RegExp(${JSON.stringify(pattern).replaceAll('"', "'")}), required: ${required} }`), `${name} (keel-nest): ${pattern}`);
      }
    }
  }
});

test('el adaptador escribe la entrada en Save, en la baja y en la restauración, y la lectura carga la raíz como su ficha', () => {
  const cards = fileOf(plan('cards-history').files, 'Repositories/ContactCardRepository.cs');
  // T1: la instantánea «antes» sale de la fila RASTREADA que el Save ya carga, antes de volcar el agregado.
  assert.match(cards, /historyBefore = HistorySnapshot\(ToDomain\(row\)\);\n\s+\}\n\s+Apply\(row, entity\);/);
  assert.match(cards, /await db\.SaveChangesAsync\(cancellationToken\);\n\s+var saved = ToDomain\(row\);\n[\s\S]*?await RecordSave\(historyBefore, saved, cancellationToken\);/);
  assert.match(cards, /HistoryChanges\.Deleted, \[\], cancellationToken\);/);
  assert.match(cards, /HistoryChanges\.Restored, \[\], cancellationToken\);/);
  assert.match(cards, /public async Task<Page<HistoryEntry>\?> HistoryOf\(Guid id, HistoryFilter filter, Pageable pageable, CancellationToken cancellationToken = default\)[\s\S]*?var root = await FindById\(id, cancellationToken\);/);
  assert.match(cards, /, ChangeHistory changeHistory\) : IContactCardRepository/);
  const vault = fileOf(plan('vault-history-scoped').files, 'Repositories/AssetRepository.cs');
  assert.match(vault, /HistoryOf\(Guid id, ReadScope scope, HistoryFilter filter, Pageable pageable, CancellationToken cancellationToken = default\)[\s\S]*?var root = await LoadScoped\(id, scope, cancellationToken\);/);
  assert.match(vault, /foreach \(var child in entity\.Revisions\)\n\s+\{\n\s+var prefix = \$"revisions\[\{HistorySupport\.Key\(child\.Id\)\}\]\.";/);
  // El historial no registra el id, ni la versión, ni la autoría (D4).
  assert.doesNotMatch(vault, /\["(id|lockVersion|createdBy|updatedBy|createdAt|updatedAt)"\] = HistorySupport/);
  // En documental, lo que había se LEE antes de escribirlo, con la sesión de la transacción.
  const mongo = fileOf(plan('cards-history-mongo').files, 'Repositories/ContactCardRepository.cs');
  assert.match(mongo, /var historyDocument = await Collection\.Find\(session, new BsonDocument\("_id", id\)\)\.FirstOrDefaultAsync\(cancellationToken\);/);
  // El puerto nombra la lectura con los tipos del dominio.
  const port = fileOf(plan('cards-history').files, 'Repository/IContactCardRepository.cs');
  assert.match(port, /Task<Page<HistoryEntry>\?> HistoryOf\(Guid id, HistoryFilter filter, Pageable pageable, CancellationToken cancellationToken = default\);/);
});

test('la retención se lleva el historial o lo anonimiza, con el almacén del ámbito de la pasada', () => {
  for (const suffix of ['', '-mongo']) {
    const purge = fileOf(plan(`cards-history${suffix}`).files, 'Retention/ContactCardRetention.cs');
    assert.match(purge, /await scope\.ServiceProvider\.GetRequiredService<ChangeHistory>\(\)\.Purge\(HistoryRoots\.ContactCard\.Type, HistorySupport\.Key\(id\), cancellationToken\);/);
    const anonymize = fileOf(plan(`cards-history-anonymize${suffix}`).files, 'Retention/ContactCardRetention.cs');
    assert.match(anonymize, /\.Anonymize\(HistoryRoots\.ContactCard\.Type, HistorySupport\.Key\(id\), HistoryRoots\.ContactCard\.Personal, cancellationToken\);/);
  }
});

test('la query devuelve la página de entradas, con la nota neutral en el handler, como keel-spring y keel-nest', () => {
  for (const name of ['cards-history', 'vault-history-scoped']) {
    const { files } = plan(name);
    const handler = files.find((file) => /HistoryQueryHandler\.cs$/.test(file.path)).content;
    assert.match(handler, /IQueryHandler<\w+HistoryQuery, PagedResponse<HistoryEntry>>/);
    const flat = (text) => text.replace(/\s*(\/\/\/?|\*)\s*/g, ' ');
    const tail = (text) => /lectura que su ficha[\s\S]*?por otra vía\./.exec(flat(text))?.[0];
    const spring = plan(name, { generator: planSpring }).files.find((file) => /HistoryQueryHandler\.java$/.test(file.path)).content;
    const nest = plan(name, { generator: planNest }).files.find((file) => /history-query-handler\.ts$/.test(file.path)).content;
    assert.ok(tail(handler), `${name}: la nota no está en el handler`);
    assert.equal(tail(handler), tail(spring), `${name}: la nota dice lo mismo que keel-spring`);
    assert.equal(tail(handler), tail(nest), `${name}: la nota dice lo mismo que keel-nest`);
    const endpoints = files.find((file) => file.path.includes('/Endpoints/') && file.content.includes('History(HttpContext http)')).content;
    assert.match(endpoints, /var response = await Mediator\(http\)\.Dispatch\(message, http\.RequestAborted\);\n\s+await HttpReply\.Json\(http, 200, response\);/);
  }
});

test('lo emitido para una fixture sin historial no nombra el historial', async () => {
  // profile-directory lo declara desde la v1.2.0: shop-api, relacional y con datos personales, no.
  const { files } = await planFixture('shop-api', { stack: { database: 'postgresql' } });
  assert.ok(!files.some((file) => /History\//.test(file.path) || /ChangeHistory/.test(file.path)));
  assert.ok(!files.some((file) => typeof file.content === 'string' && /ChangeHistory|RecordSave|HistoryEntry/.test(file.content)));
});
