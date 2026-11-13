// El HISTORIAL DE CAMBIOS (DSL 2.29) en keel-go: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/history-designs.js, y su PARIDAD con lo que emiten keel-spring, keel-nest y keel-dotnet del mismo
// diseño (los mismos casos, las mismas sentencias, las mismas tablas, los mismos patrones personales y la misma nota). Lo que
// esto NO dice —que la entrada entre en la transacción, que el autor sea el del token, que la página ordene y filtre, que la
// lectura no vea lo que la ficha no ve, que la retención se lleve o anonimice el historial— lo miden db-check y doc-check
// contra el motor real (scripts/lib/history-probes.js: HI-1 a HI-10). El diff, la anonimización y el id emitidos los EJECUTA
// la prueba emitida history_test.go contra las referencias de keel-core, en go-check.

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
import { goString } from '../src/lib/go-source.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/history-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { historyCases as nestCases } from '../../keel-nest/scripts/lib/history-probes.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { historyCases as dotnetCases } from '../../keel-dotnet/scripts/lib/history-probes.js';

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

test('los sujetos pasan la frontera de keel-go y su sonda ejecuta los MISMOS casos que las de los otros tres', () => {
  for (const { name } of HISTORY_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const mine = historyCases(plan(name).model);
    assert.deepEqual(mine, springCases(plan(name, { generator: planSpring }).model), `${name} (keel-spring)`);
    assert.deepEqual(mine, nestCases(plan(name, { generator: planNest }).model), `${name} (keel-nest)`);
    assert.deepEqual(mine, dotnetCases(plan(name, { generator: planDotnet }).model), `${name} (keel-dotnet)`);
  }
});

test('un motor sin sentencias del historial se rechaza en planService, con el mismo motivo que los otros', () => {
  const { manifest, layers } = load('cards-history');
  assert.throws(() => planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mariadb' } }), /el almacén del historial tiene sentencias medidas para postgresql, mysql|mariadb/);
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, como keel-spring, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const mine = fileOf(plan('cards-history', { database }).files, `${database === 'mysql' ? 'mysql' : 'postgres'}/history.go`);
    const spring = fileOf(plan('cards-history', { database, generator: planSpring }).files, '/history/JdbcChangeHistory.java');
    const S = historyStatements(database);
    for (const sql of [S.insertEntry, S.insertField, S.pageHead, S.countHead, S.pageTail, S.entriesOfRoot, S.updateChanges, S.deleteFields, S.deleteEntries, ...Object.values(S.filters)]) {
      assert.ok(mine.includes(goString(sql)), `${database}: keel-go no lleva ${sql}`);
      assert.ok(spring.includes(JSON.stringify(sql).slice(1, -1)), `${database}: keel-spring no lleva ${sql}`);
    }
    // La entrada va por la transacción que recibe (la de la escritura), con el autor de la autoría.
    assert.match(mine, /func recordHistory\(ctx context\.Context, q DBTX, /);
    assert.match(mine, /"author": auditActor\(ctx\)/);
  }
});

test('las dos tablas, con su índice y su FK en cascada, entran en la baseline de goose', () => {
  for (const database of ['postgresql', 'mysql']) {
    const { files } = plan('cards-history', { database });
    const baseline = fileOf(files, '/migrations/00001_baseline.sql');
    for (const table of [CHANGE_HISTORY, CHANGE_HISTORY_FIELD]) {
      assert.match(baseline, new RegExp(`CREATE TABLE [\`"]?${table.table}[\`"]? \\(`), `${database}: ${table.table}`);
      for (const column of table.columns) assert.ok(baseline.includes(column.name), `${database}: ${table.table}.${column.name}`);
    }
    assert.ok(baseline.includes(CHANGE_HISTORY.indexes[0].name), `${database}: el índice de la lectura`);
    assert.match(baseline, /ADD CONSTRAINT fk_change_history_field_entry\n\s+FOREIGN KEY \(\W?entry_id\W?\) REFERENCES \W?change_history\W? \(\W?id\W?\) ON DELETE CASCADE;/);
    // El actor de la autoría se emite aunque el diseño no pida autoría en las filas (D5).
    assert.ok(files.some((file) => file.path.endsWith('/audit_actor.go')));
  }
});

test('en documental, el índice de la lectura va en indexes.go con sus direcciones y no hay tablas', () => {
  const { files } = plan('cards-history-mongo');
  const indexes = fileOf(files, 'internal/infrastructure/mongo/indexes.go');
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  const keys = index.keys.map(([key, direction]) => `{Key: ${goString(key)}, Value: ${direction}}`).join(', ');
  assert.ok(indexes.includes(`${goString(CHANGE_HISTORY_COLLECTION.collection)}: {`));
  assert.ok(indexes.includes(`{Keys: bson.D{${keys}}, Options: options.Index().SetName(${goString(index.name)})},`));
  assert.doesNotMatch(fileOf(files, 'internal/infrastructure/mongo/history.go'), /change_history_field/);
  const store = fileOf(files, 'internal/infrastructure/mongo/history.go');
  assert.match(store, /\{Key: "fields", Value: fields\}/);
  assert.match(store, /\{Key: "changes", Value: text\}/);
  assert.match(store, /SetSort\(bson\.D\{\{Key: "at", Value: -1\}, \{Key: "_id", Value: -1\}\}\)/);
});

test('las rutas personales de cada raíz son los patrones de keel-core, los mismos que llevan los otros tres', () => {
  for (const name of ['cards-history', 'cards-history-anonymize', 'vault-history-scoped']) {
    const { files, model } = plan(name);
    const store = fileOf(files, 'postgres/history.go');
    const spring = fileOf(plan(name, { generator: planSpring }).files, '/history/HistoryRoots.java');
    for (const entity of model.entities.filter((candidate) => candidate.history)) {
      for (const { pattern, required } of historyPersonalPatterns(entity.historyShape)) {
        assert.ok(store.includes(`{pattern: regexp.MustCompile(\`${pattern}\`), required: ${required}},`), `${name}: ${pattern}`);
        assert.ok(spring.includes(`PersonalPath.of(${JSON.stringify(pattern)}, ${required})`), `${name} (keel-spring): ${pattern}`);
      }
    }
  }
});

test('el adaptador escribe la entrada en Save, en la baja y en la restauración, y la lectura carga la raíz como su ficha', () => {
  const cards = fileOf(plan('cards-history').files, 'postgres/contact_card_repository.go');
  // T1: lo que había, LEÍDO dentro de la transacción y antes de escribir.
  assert.match(cards, /if previous, err := queryContactCard\(ctx, q, "WHERE id = \$1", contactCard\.ID\(\)\); err != nil \{[\s\S]*?\n\t\tif err := writeContactCard\(ctx, q, contactCard\); err != nil \{/);
  assert.match(cards, /if err := recordSave\(ctx, q, contactCardHistory, fmt\.Sprint\(saved\.ID\(\)\), historyBefore, historyAfter\); err != nil \{/);
  assert.match(cards, /recordHistory\(ctx, q, contactCardHistory, fmt\.Sprint\(id\), domain\.HistoryDeleted, nil\)/);
  assert.match(cards, /recordHistory\(ctx, q, contactCardHistory, fmt\.Sprint\(id\), domain\.HistoryRestored, nil\)/);
  assert.match(cards, /func \(r \*ContactCardRepository\) HistoryOf\(ctx context\.Context, id uuid\.UUID, filter domain\.HistoryFilter, pageable domain\.Pageable\) \(domain\.Page\[domain\.HistoryEntry\], bool, error\) \{\n\troot, found, err := r\.FindByID\(ctx, id\)/);
  const vault = fileOf(plan('vault-history-scoped').files, 'postgres/asset_repository.go');
  assert.match(vault, /HistoryOf\(ctx context\.Context, id uuid\.UUID, scope domain\.ReadScope, filter domain\.HistoryFilter, pageable domain\.Pageable\) \(domain\.Page\[domain\.HistoryEntry\], bool, error\) \{\n\troot, found, err := r\.LoadScoped\(ctx, id, scope\)/);
  const vaultStore = fileOf(plan('vault-history-scoped').files, 'postgres/history.go');
  assert.match(vaultStore, /for _, child := range e\.Revisions\(\) \{\n\t\tprefix := "revisions\[" \+ fmt\.Sprint\(child\.ID\(\)\) \+ "\]\."/);
  // El historial no registra el id, ni la versión, ni la autoría (D4).
  assert.doesNotMatch(vaultStore, /s\.put\("(id|lockVersion|createdBy|updatedBy|createdAt|updatedAt)"/);
  // En documental, lo que había se LEE antes de escribirlo, con la sesión de la transacción (la de ctx).
  const mongo = fileOf(plan('cards-history-mongo').files, 'mongo/contact_card_repository.go');
  assert.match(mongo, /if previous, err := r\.find\(ctx, bson\.D\{\{Key: "_id", Value: uuidValue\(contactCard\.ID\(\)\)\}\}\); err != nil \{/);
  assert.match(mongo, /recordSave\(ctx, r\.tx, contactCardHistory, /);
  // El puerto nombra la lectura con los tipos del dominio.
  const port = fileOf(plan('cards-history').files, 'internal/domain/contact_card_repository.go');
  assert.match(port, /HistoryOf\(ctx context\.Context, id uuid\.UUID, filter HistoryFilter, pageable Pageable\) \(Page\[HistoryEntry\], bool, error\)/);
});

test('la retención se lleva el historial o lo anonimiza, en su misma transacción', () => {
  for (const [suffix, store] of [['', 'q'], ['-mongo', 'r.tx']]) {
    const purge = fileOf(plan(`cards-history${suffix}`).files, '/contact_card_retention.go');
    assert.ok(purge.includes(`if err := purgeHistory(ctx, ${store}, contactCardHistory, fmt.Sprint(id)); err != nil {`), `purga${suffix}`);
    const anonymize = fileOf(plan(`cards-history-anonymize${suffix}`).files, '/contact_card_retention.go');
    assert.ok(anonymize.includes(`if err := anonymizeHistory(ctx, ${store}, contactCardHistory, fmt.Sprint(id)); err != nil {`), `anonimización${suffix}`);
  }
});

test('la query devuelve la página de entradas, con la nota neutral en el handler, como los otros tres', () => {
  for (const name of ['cards-history', 'vault-history-scoped']) {
    const { files } = plan(name);
    const handler = files.find((file) => /history_query_handler\.go$/.test(file.path)).content;
    assert.match(handler, /\(PagedResponse\[domain\.HistoryEntry\], error\)/);
    const flat = (text) => text.replace(/\s*(\/\/\/?|\*)\s*/g, ' ');
    const tail = (text) => /lectura que su ficha[\s\S]*?por otra vía\./.exec(flat(text))?.[0];
    const spring = plan(name, { generator: planSpring }).files.find((file) => /HistoryQueryHandler\.java$/.test(file.path)).content;
    const dotnet = plan(name, { generator: planDotnet }).files.find((file) => /HistoryQueryHandler\.cs$/.test(file.path)).content;
    assert.ok(tail(handler), `${name}: la nota no está en el handler`);
    assert.equal(tail(handler), tail(spring), `${name}: la nota dice lo mismo que keel-spring`);
    assert.equal(tail(handler), tail(dotnet), `${name}: la nota dice lo mismo que keel-dotnet`);
    const endpoints = files.find((file) => file.path.startsWith('internal/httpapi/') && /func \(a \*api\) get\w*History\(/.test(file.content)).content;
    assert.match(endpoints, /response, err := a\.useCases\.Get\w*History\.Handle\(r\.Context\(\), query\)\n\tif err != nil \{\n\t\treturn err\n\t\}\n\treturn writeJSON\(w, http\.StatusOK, response\)/);
  }
});

test('la entrada del cable lleva at, author, change y changes, en ese orden', () => {
  const domain = fileOf(plan('cards-history').files, 'internal/domain/history.go');
  const tags = [...domain.matchAll(/`json:"(\w+)"`/g)].map((match) => match[1]);
  assert.deepEqual(tags, ['field', 'before', 'after', 'at', 'author', 'change', 'changes']);
});

test('lo emitido para una fixture sin historial no nombra el historial', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'profile-directory'));
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.ok(!files.some((file) => /\/history(_test)?\.go$/.test(file.path)));
  assert.ok(!files.some((file) => typeof file.content === 'string' && /recordSave|HistoryEntry|change_history|historyBefore/.test(file.content)));
});

test('cada sabotaje del historial se sigue aplicando a lo emitido: los de go-check --history y los hi-* de db-check y doc-check', async () => {
  const { HISTORY_EMITTED_SABOTAGES, HISTORY_SUBJECT, applyHistorySabotage } = await import('./helpers/history-sabotages.js');
  const { HISTORY_SABOTAGE_SPECS, HISTORY_SUBJECTS } = await import('../scripts/lib/history-probes.js');
  const subject = plan(HISTORY_SUBJECT).files;
  for (const sabotage of HISTORY_EMITTED_SABOTAGES) {
    assert.ok(applyHistorySabotage(sabotage, fileOf(subject, sabotage.file)), `${sabotage.id}: ya no se aplica a ${sabotage.file}`);
  }
  // Cada hi-* toca algo en algún sujeto de su almacén (el veredicto exacto lo da la red en vivo).
  for (const [id, spec] of Object.entries(HISTORY_SABOTAGE_SPECS)) {
    for (const [branch, names] of [['relational', HISTORY_SUBJECTS.relational], ['document', HISTORY_SUBJECTS.document]]) {
      const { files, from, to } = spec[branch];
      const touched = names.some((name) =>
        plan(name).files.some((file) => files.test(file.path) && (typeof from === 'string' ? file.content.includes(from) : file.content.replace(from, to) !== file.content))
      );
      assert.ok(touched, `${id} (${branch}): no toca nada de lo emitido`);
    }
  }
});
