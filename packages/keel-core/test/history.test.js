// El historial de cambios consultable (DSL 2.29, src/lib/gen/history.js y history-store.js): qué raíces lo guardan, qué
// query lo lee y con qué filtros, la forma de lo que registra, la referencia ejecutable del diff, del orden y del filtro, y
// la frontera común de los generadores. Los sujetos son los de test/helpers/history-designs.js, los mismos que medirán
// los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { readScopesOfLayers } from '../src/lib/gen/read-scope.js';
import { gapInventory } from '../src/lib/gap-classes.js';
import {
  HISTORY_CASES,
  HISTORY_CHANGES,
  HISTORY_SABOTAGES,
  compareHistoryEntries,
  historyDiff,
  historyEntry,
  historyMatches,
  historyOperations,
  historyPendingErrors,
  historyQueries,
  historyRootNames,
  historyShape,
  topFieldOf,
  usesHistory
} from '../src/lib/gen/history.js';
import {
  CHANGE_HISTORY,
  CHANGE_HISTORY_FIELD,
  HISTORY_ENGINES,
  historyCountSql,
  historyFieldRows,
  historyPageSql,
  historyStatements
} from '../src/lib/gen/history-store.js';
import { anonymizeHistoryChanges, anonymizedEntryChanges, historyContractClause, historyNote, historyPersonalPaths, historyPersonalPatterns } from '../src/lib/gen/history.js';
import { personalDataInventory } from '../src/lib/gen/personal-data.js';
import { GENERATOR_TABLES, schemaStepSql } from '../src/lib/gen/schema-steps.js';
import { HISTORY_DESIGNS } from './helpers/history-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function designOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return { manifest, layers, model: buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }) };
}
const derived = (name) => {
  const design = HISTORY_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, design.mutate);
};
const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);
const HISTORY_IDS = /^(CHK-PERSIST-HISTORY|CHK-USECASES-HISTORY|CHK-SECURITY-HISTORY|OBL-HISTORY)/;
/** Los ids que dispara un diseño: los de los hallazgos y los de las obligaciones. */
const idsOf = ({ findings, obligations }) => [...findings.map((finding) => finding.id), ...obligations.map((entry) => entry.id)];

test('los sujetos validan sin errores ni hallazgos del historial', () => {
  for (const design of HISTORY_DESIGNS) {
    const { manifest, layers } = derived(design.name);
    const result = checkCrossRefs({ layers, manifest });
    assert.deepEqual(result.errors, [], design.name);
    assert.deepEqual(idsOf(result).filter((id) => HISTORY_IDS.test(id)), [], design.name);
  }
});

test('el modelo: la raíz guarda su historial y la query lo lee con sus tres filtros', () => {
  const { layers, model } = derived('cards-history');
  assert.deepEqual(historyRootNames(model), ['ContactCard']);
  assert.equal(usesHistory(model), true);
  assert.deepEqual(model.audit.history, ['ContactCard']);
  assert.deepEqual(historyQueries(layers).map((query) => [query.operation, query.root]), [['getMyCardHistory', 'ContactCard']]);
  const operation = operationOf(model, 'getMyCardHistory');
  assert.equal(operation.historyOf, 'ContactCard');
  assert.deepEqual(operation.historyFilters, { field: 'field', from: 'from', to: 'to' });
  // Una query con respuesta, aunque la respuesta no sea un DTO del diseño, y agrupada con su raíz.
  assert.equal(operation.messageKind, 'query');
  assert.equal(operation.responseDto, null);
  assert.equal(operation.targetEntity, 'ContactCard');
  assert.deepEqual(historyOperations(model), [{ operation: 'getMyCardHistory', root: 'ContactCard', filters: { field: 'field', from: 'from', to: 'to' } }]);
  // Las demás operaciones no leen historial.
  assert.equal(operationOf(model, 'getMyCard').historyOf, null);
  // Sin historial declarado, nada.
  const { model: plain } = designOf('profile-directory');
  assert.equal(usesHistory(plain), false);
  assert.deepEqual(historyOperations(plain), []);
});

test('la forma de lo que se registra: rutas del contrato, hijas por relación y sin id, sensitive ni generated', () => {
  const { layers } = derived('cards-history');
  assert.deepEqual(historyShape(layers, 'ContactCard'), {
    root: 'ContactCard',
    idField: 'id',
    paths: ['subject', 'displayName', 'email'],
    // Las personales, con lo que reciben al anonimizar: subject es obligatorio (el sustituto), los otros dos, null.
    personal: [
      { path: 'subject', required: true },
      { path: 'displayName', required: false },
      { path: 'email', required: false }
    ],
    children: []
  });
  // El modelo lleva la misma forma en la raíz que la guarda, y ninguna en las demás.
  assert.deepEqual(derived('cards-history').model.entities.find((entity) => entity.name === 'ContactCard').historyShape, historyShape(layers, 'ContactCard'));
  assert.equal(designOf('profile-directory').model.entities.find((entity) => entity.name === 'ContactCard').historyShape, null);
  const vault = historyShape(derived('vault-history-scoped').layers, 'Asset');
  assert.deepEqual(vault.children.map((child) => [child.relation, child.entity, child.list]), [['revisions', 'AssetRevision', true]]);
  // La hija no registra su vuelta a la raíz: no es una referencia a otro agregado.
  assert.deepEqual(vault.children[0].paths, ['revisionNumber', 'note']);
  // La referencia al propietario (otro agregado) viaja por su id.
  assert.ok(vault.paths.includes('ownerId'), vault.paths.join(', '));
  // Un value object compuesto con dot-path, y fuera lo sensitive y lo generated.
  const layers2 = {
    domain: {
      types: { Money: { fields: { amount: { type: 'decimal', required: true }, currency: { type: 'string', required: true } } } },
      entities: {
        Policy: {
          fields: {
            id: { type: 'uuid', id: true, generated: true },
            premium: { type: 'Money', required: true },
            secret: { type: 'string', sensitive: true },
            updatedAt: { type: 'timestamp', generated: true },
            tags: { type: 'string', list: true }
          }
        }
      }
    },
    persistence: { entities: { Policy: {} } }
  };
  assert.deepEqual(historyShape(layers2, 'Policy').paths, ['premium.amount', 'premium.currency', 'tags']);
});

test('el diff: solo lo que cambió, el alta con todo, las hijas por id y el guardado sin cambios no deja entrada', () => {
  const shape = {
    root: 'Order',
    idField: 'id',
    paths: ['status', 'total.amount', 'tags'],
    children: [{ relation: 'lines', entity: 'OrderLine', idField: 'id', list: true, paths: ['quantity'] }]
  };
  const v1 = { id: 'o1', status: 'open', total: { amount: '10.00' }, tags: ['a'], lines: [{ id: 'l1', quantity: 1 }] };
  const v2 = { ...v1, status: 'paid', tags: ['a'], lines: [{ id: 'l1', quantity: 2 }, { id: 'l2', quantity: 5 }] };
  assert.deepEqual(historyEntry(shape, { change: 'created', after: v1 }), {
    change: 'created',
    changes: [
      { field: 'lines[l1].quantity', before: null, after: 1 },
      { field: 'status', before: null, after: 'open' },
      { field: 'tags', before: null, after: ['a'] },
      { field: 'total.amount', before: null, after: '10.00' }
    ]
  });
  assert.deepEqual(historyDiff(shape, v1, v2), [
    { field: 'lines[l1].quantity', before: 1, after: 2 },
    { field: 'lines[l2].quantity', before: null, after: 5 },
    { field: 'status', before: 'open', after: 'paid' }
  ]);
  // Quitar una hija es su ruta a null; el orden de las claves de un objeto no es un cambio.
  assert.deepEqual(historyDiff(shape, v2, { ...v2, lines: [{ quantity: 5, id: 'l2' }] }), [{ field: 'lines[l1].quantity', before: 2, after: null }]);
  assert.equal(historyEntry(shape, { change: 'updated', before: v2, after: structuredClone(v2) }), null);
  assert.deepEqual(historyEntry(shape, { change: 'deleted', before: v2 }), { change: 'deleted', changes: [] });
  assert.deepEqual(historyEntry(shape, { change: 'restored', after: v2 }), { change: 'restored', changes: [] });
  assert.throws(() => historyEntry(shape, { change: 'touched' }), /no es un cambio del historial/);
  assert.deepEqual(HISTORY_CHANGES, ['created', 'updated', 'deleted', 'restored', 'anonymized']);
});

test('la lectura: el más reciente primero con desempate por id, y el filtro por ruta, por campo y por fechas', () => {
  const entries = [
    { id: 'a', at: '2026-11-13T10:00:00.000Z', changes: [{ field: 'price.amount' }] },
    { id: 'c', at: '2026-11-13T11:00:00.000Z', changes: [{ field: 'lines[7].quantity' }] },
    { id: 'b', at: '2026-11-13T11:00:00.000Z', changes: [{ field: 'status' }] }
  ];
  assert.deepEqual([...entries].sort(compareHistoryEntries).map((entry) => entry.id), ['c', 'b', 'a']);
  const ids = (filters) => entries.filter((entry) => historyMatches(entry, filters)).map((entry) => entry.id);
  assert.deepEqual(ids({ field: 'price' }), ['a']);
  assert.deepEqual(ids({ field: 'price.amount' }), ['a']);
  assert.deepEqual(ids({ field: 'lines' }), ['c']);
  assert.deepEqual(ids({ field: 'pri' }), [], 'un prefijo que no es un campo no casa');
  const at = Date.parse('2026-11-13T11:00:00.000Z');
  assert.deepEqual(ids({ fromMs: at }), ['c', 'b'], 'from incluye su extremo');
  assert.deepEqual(ids({ toMs: at - 1 }), ['a']);
  assert.deepEqual(ids({ field: 'status', fromMs: at, toMs: at }), ['b']);
  assert.equal(topFieldOf('lines[7].quantity'), 'lines');
  assert.equal(topFieldOf('email'), 'email');
});

test('el almacén: una entrada por escritura y una fila de campo por ruta, con el campo de la raíz para filtrar', () => {
  assert.equal(CHANGE_HISTORY.table, 'change_history');
  assert.deepEqual(CHANGE_HISTORY.indexes[0].columns, ['root_type', 'root_id', 'at', 'id']);
  assert.equal(CHANGE_HISTORY_FIELD.columns[0].references.onDelete, 'cascade');
  // CHANGE es palabra reservada en MySQL: la columna del `change` del cable es change_kind.
  assert.ok(CHANGE_HISTORY.columns.some((column) => column.name === 'change_kind'));
  assert.ok(!CHANGE_HISTORY.columns.some((column) => column.name === 'change'));
  assert.deepEqual(
    historyFieldRows([{ field: 'price.amount' }, { field: 'lines[7].quantity' }, { field: 'price.amount' }]),
    [{ path: 'price.amount', top: 'price' }, { path: 'lines[7].quantity', top: 'lines' }]
  );
});

test('D7: la query de historial es una lectura de UNA del alcance, y deja el historial de la raíz acotado', () => {
  const { layers } = derived('vault-history-scoped');
  const read = readScopesOfLayers(layers).reads.find((entry) => entry.operation === 'getAssetHistory');
  assert.equal(read?.shape, 'single');
  assert.deepEqual(readScopesOfLayers(layers).problems, []);
  // Quitarla de reads con la ficha acotada es CHK-SECURITY-HISTORY-UNSCOPED.
  const reads = layers.security.authentication.scoping.reads;
  reads.splice(reads.indexOf('getAssetHistory'), 1);
  assert.deepEqual(idsOf(checkCrossRefs({ layers })).filter((id) => HISTORY_IDS.test(id)), ['CHK-SECURITY-HISTORY-UNSCOPED']);
});

test('la clase 19 cuenta la raíz con historial, y la obligación pregunta quién lo lee', () => {
  const { layers, manifest } = derived('vault-history-scoped');
  const lifecycle = gapInventory(layers).find((entry) => entry.class === 19);
  assert.deepEqual(lifecycle?.units, ['Asset']);
  delete layers['use-cases'].operations.getAssetHistory;
  delete layers.api.endpoints.getAssetHistory;
  delete layers.security.access.rules.getAssetHistory;
  layers.security.authentication.scoping.reads = layers.security.authentication.scoping.reads.filter((name) => name !== 'getAssetHistory');
  assert.deepEqual(idsOf(checkCrossRefs({ layers, manifest })).filter((id) => HISTORY_IDS.test(id)), ['OBL-HISTORY-UNREAD']);
});

test('la frontera común: rechaza el historial y su query con el mismo mensaje, y nada sin historial', () => {
  const { layers } = derived('cards-history');
  const errors = historyPendingErrors(layers, 'keel-x', 9);
  assert.equal(errors.length, 2, errors.join('\n'));
  for (const error of errors) {
    assert.match(error, /keel-x todavía no lo genera — llega en el incremento 9 de PLAN-DSL-229-HISTORIAL\.md/);
  }
  assert.deepEqual(historyPendingErrors(designOf('profile-directory').layers, 'keel-x', 9), []);
});

test('cada sabotaje cae en casos que existen, y cada caso lo derriba algún sabotaje o se mide por su lado', () => {
  const ids = new Set(HISTORY_CASES.map((entry) => entry.id));
  assert.equal(ids.size, HISTORY_CASES.length, 'ids repetidos');
  const covered = new Set();
  for (const [sabotage, cases] of Object.entries(HISTORY_SABOTAGES)) {
    assert.match(sabotage, /^hi-[a-z-]+$/);
    for (const id of cases) {
      assert.ok(ids.has(id), `${sabotage}: ${id} no es un caso`);
      covered.add(id);
    }
  }
  // HI-3 y HI-10 son el camino feliz del diff y de la restauración, que hi-full-snapshot e hi-outside-tx ya rompen; HI-11
  // lo derriba el pd-log-value de la 2.28, que es la misma fuga por otro camino.
  const unsabotaged = [...ids].filter((id) => !covered.has(id)).sort();
  assert.deepEqual(unsabotaged, ['HI-10', 'HI-11', 'HI-3']);
});

test('la anonimización del historial: los patrones de las rutas personales, la reescritura y la entrada anonymized', () => {
  const shape = {
    root: 'Order',
    idField: 'id',
    paths: ['buyer', 'note', 'address.street', 'status'],
    personal: [{ path: 'buyer', required: true }, { path: 'note', required: false }, { path: 'address.street', required: false }],
    children: [{ relation: 'lines', entity: 'OrderLine', idField: 'id', list: true, paths: ['recipient', 'quantity'], personal: [{ path: 'recipient', required: false }] }]
  };
  const patterns = historyPersonalPatterns(shape);
  assert.deepEqual(patterns.map((entry) => entry.pattern), ['^buyer$', '^note$', '^address\\.street$', '^lines\\[[^\\]]*\\]\\.recipient$']);
  const changes = [
    { field: 'buyer', before: 'ana', after: 'eva' },
    { field: 'status', before: 'open', after: 'paid' },
    { field: 'address.street', before: null, after: 'Mayor 1' },
    { field: 'lines[7].recipient', before: null, after: 'luis' },
    { field: 'lines[7].quantity', before: null, after: 2 },
    // `buyerX` no es `buyer`: el patrón va anclado.
    { field: 'buyerX', before: 'a', after: 'b' }
  ];
  const { changes: rewritten, touched } = anonymizeHistoryChanges(changes, patterns, 'o1');
  assert.equal(touched, true);
  assert.deepEqual(rewritten, [
    { field: 'buyer', before: 'anon-o1', after: 'anon-o1' },
    { field: 'status', before: 'open', after: 'paid' },
    { field: 'address.street', before: null, after: null },
    { field: 'lines[7].recipient', before: null, after: null },
    { field: 'lines[7].quantity', before: null, after: 2 },
    { field: 'buyerX', before: 'a', after: 'b' }
  ]);
  // Reescribirla otra vez no cambia nada (el barrido puede repetirse).
  assert.equal(anonymizeHistoryChanges(rewritten, patterns, 'o1').touched, false);
  assert.deepEqual(anonymizedEntryChanges([rewritten, [{ field: 'note', before: 'x', after: null }]], patterns, 'o1'), [
    { field: 'address.street', before: null, after: null },
    { field: 'buyer', before: 'anon-o1', after: 'anon-o1' },
    { field: 'lines[7].recipient', before: null, after: null },
    { field: 'note', before: null, after: null }
  ]);
  // Las expresiones valen como expresión regular (y son las que copia cada generador tal cual).
  for (const { pattern } of patterns) assert.doesNotThrow(() => new RegExp(pattern));
});

test('las sentencias del almacén: la página se compone con los filtros presentes, en orden, y las dos tablas van en el paso de esquema', () => {
  for (const engine of HISTORY_ENGINES) {
    const S = historyStatements(engine);
    assert.equal(historyPageSql(S, {}), S.pageHead + S.pageTail);
    assert.equal(historyPageSql(S, { to: 't', field: 'email' }), S.pageHead + S.filters.field + S.filters.to + S.pageTail);
    assert.equal(historyCountSql(S, { from: 'f' }), S.countHead + S.filters.from);
    assert.match(S.pageTail, /ORDER BY h\.at DESC, h\.id DESC/);
    assert.match(S.insertEntry, engine === 'mysql' ? /utc_timestamp\(6\)/ : /current_timestamp/);
    const sql = schemaStepSql(engine, GENERATOR_TABLES);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS change_history \(/);
    assert.match(sql, /CONSTRAINT fk_change_history_field_entry FOREIGN KEY \(entry_id\) REFERENCES change_history \(id\) ON DELETE CASCADE/);
    // La tabla referenciada va antes que la que la referencia.
    assert.ok(sql.indexOf('TABLE IF NOT EXISTS change_history (') < sql.indexOf('TABLE IF NOT EXISTS change_history_field ('));
  }
  assert.throws(() => historyStatements('oracle'), /no tiene sentencias/);
});

test('la nota del handler: la llamada del generador, el vacío como no encontrado y los filtros del input', () => {
  const { model } = derived('cards-history');
  const note = historyNote(operationOf(model, 'getMyCardHistory'), { historyCall: 'repo.historyOf(...)' });
  assert.match(note, /^Historial \(output\.history: ContactCard, DSL 2\.29\): repo\.historyOf\(\.\.\.\) carga ContactCard/);
  assert.match(note, /Ese vacío es el error de no encontrado del diseño/);
  assert.match(note, /Filtros del input: field \(field\), from \(from\), to \(to\); uno nulo no filtra\.$/);
  assert.equal(historyNote(operationOf(model, 'getMyCard'), { historyCall: 'x' }), null);
});

test('el contrato: las rutas personales legibles, la cláusula de la respuesta y el historial en el inventario de datos personales', () => {
  const vault = derived('vault-history-scoped').model;
  const asset = vault.entities.find((entity) => entity.name === 'Asset');
  for (const path of historyPersonalPaths(asset.historyShape)) {
    // Cada ruta legible es la de un patrón de la anonimización, con el id de la hija en su sitio.
    const concrete = path.replace(/<[^>]+>/g, '0190a1b2-0000-7000-8000-000000000001');
    assert.ok(historyPersonalPatterns(asset.historyShape).some(({ pattern }) => new RegExp(pattern).test(concrete)), path);
  }
  assert.deepEqual(historyPersonalPaths(null), []);

  const { model } = derived('cards-history-anonymize');
  const card = model.entities.find((entity) => entity.name === 'ContactCard');
  assert.ok(historyPersonalPaths(card.historyShape).includes('email'));
  const clause = historyContractClause(operationOf(model, 'getMyCardHistory'));
  assert.match(clause, /^Historial de ContactCard \(output\.history, DSL 2\.29\)/);
  assert.match(clause, /el orden es fijo/);
  assert.match(clause, /`field` casa con la ruta exacta/);
  assert.match(clause, /nunca una página vacía/);
  assert.equal(historyContractClause(operationOf(model, 'getMyCard')), null);

  const inventory = personalDataInventory(model).content;
  assert.match(inventory, /## En el historial de cambios/);
  assert.match(inventory, /\| ContactCard \| [^|]*`email`[^|]* \| cuando la retención anonimiza la raíz/);
  assert.match(personalDataInventory(derived('cards-history').model).content, /cuando la retención borra la raíz, se borran todas sus entradas/);
  // Sin historial, el inventario de la 2.28 no cambia.
  assert.doesNotMatch(personalDataInventory(designOf('profile-directory').model).content, /historial/);
});
