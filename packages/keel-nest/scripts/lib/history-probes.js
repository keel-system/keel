// El HISTORIAL DE CAMBIOS (DSL 2.29) contra lo emitido, para db-check y doc-check: HI-1 a HI-10 de keel-core/gen/history.js,
// con los ids que ejecuta keel-spring (history-check) sobre los MISMOS diseños (keel-core/test/helpers/history-designs.js).
// Habla con el puerto de la raíz, con el almacén del historial y con la retención y su recurrente; con la base cruda solo
// para lo que el puerto no enseña (retrasar un borrado, mover la hora de una entrada). Vale para los dos almacenes. HI-11
// (logs y spans) lo mide telemetry-check, como PD-3.
//
// Las etiquetas importan para el falsado, como en keel-spring: cada sabotaje tiene que caer en EXACTAMENTE sus casos. Por
// eso HI-6 no escribe por el adaptador sino por el almacén (un diff roto no puede tumbar el orden ni el filtro), HI-3 solo
// afirma que las rutas de las hijas ESTÁN (el diff que lo lista todo es HI-2) y HI-4 mira la entrada del alta.

import { lifecycleRoots } from '@keel-system/keel-core/gen/data-lifecycle';
import { HISTORY_CASES, HISTORY_SABOTAGES } from '@keel-system/keel-core/gen/history';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { CHANGE_HISTORY_TS, HISTORY_SUPPORT_TS, historyReadsOf, recordsHistory, rootConstant } from '../../src/scaffold/history.js';
import { retentionClass, retentionPath, retentionTimerClass, retentionTimerPath } from '../../src/scaffold/data-lifecycle.js';
import { ormClass, ormPath } from '../../src/scaffold/persistence-entities.js';
import { quoteIdentifierFor } from '@keel-system/keel-core/gen/relational';
import { aggregateTables } from './lifecycle-probes.js';
import { READ_SCOPE_TS } from '../../src/scaffold/read-scope.js';
import { SECURITY_CONTEXT_TS } from '../../src/scaffold/security.js';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';

const js = (value) => JSON.stringify(value);
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const STORE = /history[\\/]change-history\.ts$/;
const SUPPORT = /history[\\/]history-support\.ts$/;
const IMPL = /-repository-impl\.ts$/;
const RETENTION = /-retention\.ts$/;

/** La carga de D7 sustituida por la raíz que se pide, sin mirar si la ficha la ve. */
const UNSCOPED = [IMPL, /const root = await this\.\w+\((\w+)(, scope)?\);/g, (_match, id, scope) => `const root = { id: ${id} };${scope ? ' void scope;' : ''}`];

/** El texto que se busca y se sustituye en lo emitido, por sabotaje y por almacén (relational | document). */
export const HISTORY_SABOTAGE_SPECS = {
  // La entrada se escribe en una transacción PROPIA: sobrevive a la escritura que revierte.
  'hi-outside-tx': {
    relational: [STORE, 'await this.transactions.inTransaction(async (manager) => {\n      const id = Uuids.v7();', 'await this.transactions.inNewTransaction(async (manager) => {\n      const id = Uuids.v7();'],
    document: [STORE, 'await this.transactions.inTransaction((session) =>\n      this.collection.insertOne(', 'await this.transactions.inNewTransaction((session) =>\n      this.collection.insertOne(']
  },
  // Una actualización registra la instantánea entera, cambie o no.
  'hi-full-snapshot': {
    relational: [SUPPORT, 'if (was !== is) changes.push(', 'if (was !== is || before != null) changes.push('],
    document: [SUPPORT, 'if (was !== is) changes.push(', 'if (was !== is || before != null) changes.push(']
  },
  // La instantánea guarda el id, que el historial no registra (D4).
  'hi-sensitive': {
    relational: [IMPL, /const snapshot = new Map<string, string>\(\);/g, "const snapshot = new Map<string, string>();\n    snapshot.set('id', wireText(entity.id));"],
    document: [IMPL, /const snapshot = new Map<string, string>\(\);/g, "const snapshot = new Map<string, string>();\n    snapshot.set('id', wireText(entity.id));"]
  },
  // El autor es siempre el centinela.
  'hi-author': {
    relational: [STORE, 'author: currentActor()', "author: currentActor() === '' ? '' : 'system'"],
    document: [STORE, 'author: currentActor()', "author: currentActor() === '' ? '' : 'system'"]
  },
  // A igual instante desempata el id MENOR: el orden deja de ser estable de más reciente a más antiguo.
  'hi-order': {
    relational: [STORE, 'ORDER BY h.at DESC, h.id DESC', 'ORDER BY h.at DESC, h.id ASC'],
    document: [STORE, '.sort({ at: -1, _id: -1 })', '.sort({ at: -1, _id: 1 })']
  },
  // La lectura del historial no carga la raíz como su ficha: ve lo ajeno y lo borrado.
  'hi-unscoped': { relational: UNSCOPED, document: UNSCOPED },
  // La retención anonimiza la ficha y deja el historial como estaba.
  'hi-anonymize-miss': {
    relational: [RETENTION, /await this\.changeHistory\.anonymize\([^;]+;/g, 'void this.changeHistory;'],
    document: [RETENTION, /await this\.changeHistory\.anonymize\([^;]+;/g, 'void this.changeHistory;']
  },
  // La purga de lo borrado se deja el historial.
  'hi-purge-miss': {
    relational: [RETENTION, /await this\.changeHistory\.purge\([^;]+;/g, 'void this.changeHistory;'],
    document: [RETENTION, /await this\.changeHistory\.purge\([^;]+;/g, 'void this.changeHistory;']
  }
};

export const isHistorySabotage = (id) => Boolean(HISTORY_SABOTAGE_SPECS[id]);

// ─── Lo que se mide de cada diseño ───────────────────────────────────────────────────────────────────────────────

/** Lo que las sondas necesitan de cada raíz con historial, como keel-spring. */
export function probedRoots(model) {
  return model.entities.filter(recordsHistory).map((entity) => {
    const lifecycle = lifecycleRoots(model).find((root) => root.entity === entity.name) ?? null;
    const reads = historyReadsOf(model, entity);
    const scoped = reads.some((read) => read.scoped) ? scopedRootsOf(model).find((candidate) => candidate.entity?.name === entity.name) ?? null : null;
    // El campo que cambia una actualización: texto libre de la raíz, sin clave, sin unicidad y sin formato.
    const editable = entity.fields.find(
      (field) =>
        field.base === 'string' && !field.list && field.kind !== 'composite' && field.kind !== 'enum' && !field.isId && !field.unique &&
        !field.inheritedPattern && !(entity.naturalKey ?? []).includes(field.name) && entity.historyShape.paths.includes(field.name)
    );
    if (!editable) throw new Error(`history-probes: ${entity.name} no tiene un campo de texto libre que editar`);
    return { entity, lifecycle, reads, scoped, editable };
  });
}

/** Los casos que ejecuta el bloque de este diseño (los mismos que keel-spring: history-parity.test.js lo compara). */
export function historyCases(model) {
  const cases = new Set();
  for (const { entity, lifecycle, reads } of probedRoots(model)) {
    cases.add('HI-1').add('HI-2').add('HI-4').add('HI-5').add('HI-6');
    if (entity.historyShape.children.length > 0 || entity.historyShape.paths.some((path) => path.includes('.'))) cases.add('HI-3');
    if (reads.length > 0 && (lifecycle?.logical || reads.some((read) => read.scoped))) cases.add('HI-7');
    if (lifecycle?.restore) cases.add('HI-10');
    if (lifecycle?.retention?.fromDeleted) cases.add(lifecycle.retention.then === 'anonymize' ? 'HI-8' : 'HI-9');
  }
  const order = HISTORY_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Lo que tiene que caer con un sabotaje en este diseño: sus casos que el bloque ejecuta, y solo esos. */
export function historySabotageVerdict(checks, id, model) {
  const cases = historyCases(model);
  const want = HISTORY_SABOTAGES[id].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^HI-\d+:/.test(check.name)).map((check) => /^(HI-\d+):/.exec(check.name)[1]))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** Lo que el preámbulo de la sonda declara: el almacén, que el adaptador de una raíz con historial recibe el último. */
export function historyPreamble(model, ctx) {
  if (probedRoots(model).length === 0) return '';
  ctx.imports.add(`ChangeHistory|${CHANGE_HISTORY_TS}`);
  return 'const historyStore = new ChangeHistory(tx);';
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El bloque del historial, con `check`, `stateOf` y `randomUUID` del script de la sonda y su almacén (`dataSource` o
 * `database`). `sampleEntity` da el agregado de muestra y `adapterOf(entity)` el adaptador de una raíz.
 */
export function historyBlock(model, ctx, { document, engine, sampleEntity, adapterOf }) {
  const probes = probedRoots(model);
  if (probes.length === 0) return '';
  let salt = 0;
  const sample = (entity) => sampleEntity(model, entity, ctx, `hi${salt++}`);
  const dist = (symbol, file) => ctx.imports.add(`${symbol}|${file}`);
  dist('wireText', HISTORY_SUPPORT_TS);
  dist('SecurityContext', SECURITY_CONTEXT_TS);
  const marker = (position) => (engine === 'postgresql' ? `$${position}` : '?');
  // HI-6: mover la hora de las entradas que tocaron una ruta, para medir el orden y las fechas sin esperar.
  const setAt = document
    ? "async (path, at) => { await database.collection('change_history').updateMany({ 'fields.path': path }, { $set: { at } }); }"
    : `async (path, at) => { await dataSource.query(${js(`UPDATE change_history SET at = ${marker(1)} WHERE id IN (SELECT entry_id FROM change_history_field WHERE path = ${marker(2)})`)}, [at, path]); }`;
  const wipeHistory = document
    ? ["    await database.collection('change_history').deleteMany({});"]
    : ["    await dataSource.query('DELETE FROM change_history_field');", "    await dataSource.query('DELETE FROM change_history');"];
  const wiped = new Set();
  for (const { entity, scoped } of probes) {
    wiped.add(entity);
    const hop = scoped ? readScopePath(model, scoped.read).hops[0] : null;
    if (hop) wiped.add(hop.entity);
  }
  // Las raíces antes que sus dueñas (la referencia del alcance), y de cada una sus hijas y listas antes que ella.
  const wipeLines = [...wiped].flatMap((entity) =>
    document
      ? [`    await database.collection(${js(entity.collectionName)}).deleteMany({});`]
      : aggregateTables(model, entity).map((table) => `    await dataSource.query(${js(`DELETE FROM ${quoteIdentifierFor(engine, table)}`)});`)
  );
  const owners = new Set();

  const lines = [];
  const block = (title, body) => lines.push(`  // ${title}\n  {\n    await hiWipe();\n${body.join('\n')}\n  }`);
  for (const probe of probes) {
    const { entity, lifecycle, reads, scoped, editable } = probe;
    const name = entity.name;
    const shape = entity.historyShape;
    const idName = entity.idField?.name ?? 'id';
    const repo = `hi${name}`;
    const type = `${rootConstant(entity)}.type`;
    dist(rootConstant(entity), HISTORY_SUPPORT_TS);
    const key = (row) => `String(${row}.${idName})`;
    const label = (caseId, text) => js(`${caseId}: ${name} ${text}`);
    const overrides = (forced) => Object.entries(forced).map(([field, value]) => `, ${field}: ${value}`).join('');
    const build = (forced = {}) => `new ${name}({ ...stateOf(${sample(entity)}), ${idName}: randomUUID()${overrides(forced)} })`;
    const fresh = (variable, forced = {}) => `    const ${variable} = await ${repo}.save(${build(forced)});`;
    // Una copia de lo que hay en el almacén con algunos miembros cambiados: así se actualiza con la versión vigente.
    const update = (row, forced = {}) => `    await ${repo}.save(new ${name}({ ...stateOf(await ${repo}.findById(${row}.${idName})), ${overrides(forced).slice(2)} }));`;
    const edited = (text) => ({ [editable.name]: js(text) });

    block(`HI-1: ${name}`, [
      fresh('fila'),
      update('fila', edited(`hi1-${salt}`)),
      `    await ${repo}.deleteById(fila.${idName});`,
      `    const kinds = await hiKinds(${type}, ${key('fila')});`,
      `    check(${label('HI-1', 'deja una entrada por alta, cambio y baja')}, kinds.join() === 'deleted,updated,created', kinds.join());`,
      `    const revertida = ${build()};`,
      "    try { await tx.inTransaction(async () => { await " + repo + ".save(revertida); throw new Error('revierte'); }); } catch { /* lo esperado */ }",
      `    check(${label('HI-1', 'una escritura que revierte no deja entrada')}, (await hiEntries(${type}, ${key('revertida')})).length === 0);`
    ]);

    const value2 = `hi2-${salt}`;
    block(`HI-2: ${name}`, [
      fresh('fila'),
      update('fila'),
      `    check(${label('HI-2', 'un guardado sin cambios no escribe')}, (await hiKinds(${type}, ${key('fila')})).join() === 'created', (await hiKinds(${type}, ${key('fila')})).join());`,
      `    const before = wireText((await ${repo}.findById(fila.${idName})).${editable.name});`,
      update('fila', edited(value2)),
      `    const last = (await hiEntries(${type}, ${key('fila')}))[0];`,
      `    check(${label('HI-2', 'la entrada lleva solo lo que cambió')}, last.changes.map((change) => change.field).join() === ${js(editable.name)}, last.changes.map((change) => change.field).join());`,
      `    check(${label('HI-2', 'before es el valor anterior')}, wireText(last.changes[0]?.before) === before, wireText(last.changes[0]?.before));`,
      `    check(${label('HI-2', 'after es el valor nuevo')}, wireText(last.changes[0]?.after) === wireText(${js(value2)}), wireText(last.changes[0]?.after));`
    ]);

    const listChild = shape.children.find((candidate) => candidate.list);
    if (listChild) {
      const childEntity = model.entities.find((candidate) => candidate.name === listChild.entity);
      const childId = listChild.idField;
      const newChild = () => `new ${listChild.entity}({ ...stateOf(${sampleEntity(model, childEntity, ctx, `hic${salt++}`)}), ${childId}: randomUUID() })`;
      const paths = (variable) => `[${listChild.paths.map((path) => js(`.${path}`)).join(', ')}].map((path) => ${js(`${listChild.relation}[`)} + String(${variable}.${childId}) + ']' + path)`;
      block(`HI-3: ${name}.${listChild.relation}`, [
        `    const primera = ${newChild()};`,
        fresh('fila', { [listChild.relation]: '[primera]' }),
        `    const created = (await hiEntries(${type}, ${key('fila')}))[0].changes.map((change) => change.field);`,
        `    check(${label('HI-3', 'el alta lleva las rutas de la hija')}, ${paths('primera')}.every((path) => created.includes(path)), created.join(', '));`,
        `    const segunda = ${newChild()};`,
        `    const actual = await ${repo}.findById(fila.${idName});`,
        `    await ${repo}.save(new ${name}({ ...stateOf(actual), ${listChild.relation}: [...actual.${listChild.relation}, segunda] }));`,
        `    const added = (await hiEntries(${type}, ${key('fila')}))[0].changes.filter((change) => change.before === null).map((change) => change.field);`,
        `    check(${label('HI-3', 'la hija nueva aparece con su ruta')}, ${paths('segunda')}.every((path) => added.includes(path)), added.join(', '));`
      ]);
    } else if (shape.paths.some((path) => path.includes('.'))) {
      const dotted = shape.paths.filter((path) => path.includes('.'));
      block(`HI-3: ${name}`, [
        fresh('fila'),
        `    const created = (await hiEntries(${type}, ${key('fila')}))[0].changes.map((change) => change.field);`,
        `    check(${label('HI-3', 'el alta lleva las rutas de sus value objects')}, ${js(dotted)}.every((path) => created.includes(path)), created.join(', '));`
      ]);
    }

    const excluded = [
      idName,
      ...entity.fields.filter((field) => field.sensitive || field.generated).map((field) => field.name),
      ...(entity.usesOptimisticLocking ? ['lockVersion'] : [])
    ];
    block(`HI-4: ${name}`, [
      fresh('fila'),
      `    const recorded = (await hiEntries(${type}, ${key('fila')}))[0].changes.map((change) => change.field);`,
      `    check(${label('HI-4', 'el alta registró algo (la sonda mide)')}, recorded.length > 0);`,
      `    for (const forbidden of ${js([...new Set(excluded)])}) check(${label('HI-4', 'el historial no guarda ')} + forbidden, !recorded.includes(forbidden));`
    ]);

    block(`HI-5: ${name}`, [
      `    const conToken = await SecurityContext.runWith({ kind: 'token', name: 'nombre-hi5', authorities: new Set(), claims: { sub: 'sub-hi5' } }, () => ${repo}.save(${build()}));`,
      `    const autor = (await hiEntries(${type}, ${key('conToken')}))[0]?.author;`,
      `    check(${label('HI-5', 'el autor es el sujeto del token')}, autor === 'sub-hi5', autor);`,
      fresh('sinToken'),
      `    const sistema = (await hiEntries(${type}, ${key('sinToken')}))[0]?.author;`,
      `    check(${label('HI-5', 'fuera de una petición el autor es el centinela')}, sistema === 'system' || String(sistema).startsWith('system:'), sistema);`
    ]);

    block(`HI-6: ${name}`, [
      '    // Por el almacén: lo que se mide es su orden y sus filtros, no el diff del adaptador.',
      "    const root = 'hi6-' + randomUUID();",
      "    const t0 = new Date('2026-11-13T10:00:00Z');",
      "    const minutes = (n) => new Date(t0.getTime() + n * 60_000);",
      `    for (const path of ['a.x', 'b', 'c', 'd']) await historyStore.record(${type}, root, 'updated', [{ field: path, before: null, after: path }]);`,
      "    await hiSetAt('a.x', t0);",
      "    await hiSetAt('b', minutes(5));",
      "    await hiSetAt('c', minutes(5));",
      "    await hiSetAt('d', minutes(9));",
      `    const fields = async (filter, page, size) => (await historyStore.page(${type}, root, filter, { page, size, sort: [] })).items.map((entry) => entry.changes[0].field).join();`,
      `    check(${label('HI-6', 'el más reciente primero, con el id de desempate')}, (await fields(NO_FILTER, 0, 10)) === 'd,c,b,a.x', await fields(NO_FILTER, 0, 10));`,
      `    check(${label('HI-6', 'la segunda página sigue a la primera')}, (await fields(NO_FILTER, 1, 2)) === 'b,a.x', await fields(NO_FILTER, 1, 2));`,
      `    check(${label('HI-6', 'el total')}, (await historyStore.page(${type}, root, NO_FILTER, { page: 0, size: 1, sort: [] })).totalElements === 4);`,
      `    check(${label('HI-6', 'el campo de la raíz casa su ruta')}, (await fields({ ...NO_FILTER, field: 'a' }, 0, 10)) === 'a.x', await fields({ ...NO_FILTER, field: 'a' }, 0, 10));`,
      `    check(${label('HI-6', 'la ruta entera casa')}, (await fields({ ...NO_FILTER, field: 'a.x' }, 0, 10)) === 'a.x');`,
      `    check(${label('HI-6', 'un trozo que no es un campo no casa')}, (await fields({ ...NO_FILTER, field: 'x' }, 0, 10)) === '');`,
      `    const ranged = (await fields({ field: null, from: minutes(5), to: minutes(9) }, 0, 10)).split(',').sort().join();`,
      `    check(${label('HI-6', 'from y to incluyen sus extremos')}, ranged === 'b,c,d', ranged);`
    ]);

    if (historyCases(model).includes('HI-7') && reads.length > 0) {
      const read = reads.find((candidate) => candidate.scoped) ?? reads[0];
      const body = [];
      let ownerForBorrada = {};
      if (read.scoped && scoped) {
        dist('ReadScope', READ_SCOPE_TS);
        const path = readScopePath(model, scoped.read);
        if (path.hops.length > 1) throw new Error(`history-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
        const hop = path.hops[0] ?? null;
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `ReadScope.within([${value}])` : `ReadScope.ownedBy(${value})`);
        if (hop) {
          const target = hop.entity;
          const targetId = target.idField?.name ?? 'id';
          const owned = (tag) => `new ${target.name}({ ...stateOf(${sample(target)}), ${targetId}: randomUUID(), ${scoped.read.field}: ${js(`hi-own-${tag}`)} })`;
          owners.add(target);
          body.push(
            `    const ownerA = await hi${target.name}.save(${owned('a')});`,
            `    const ownerB = await hi${target.name}.save(${owned('b')});`,
            fresh('propia', { [`${hop.relation}Id`]: `ownerA.${targetId}` }),
            fresh('ajena', { [`${hop.relation}Id`]: `ownerB.${targetId}` }),
            `    const scope = ${scopeOf(`ownerA.${scoped.read.field}`)};`
          );
          ownerForBorrada = { [`${hop.relation}Id`]: `ownerA.${targetId}` };
        } else {
          body.push(fresh('propia', { [scoped.read.field]: js('hi-own-a') }), fresh('ajena', { [scoped.read.field]: js('hi-own-b') }), `    const scope = ${scopeOf(`propia.${scoped.read.field}`)};`);
          ownerForBorrada = { [scoped.read.field]: js('hi-own-a') };
        }
        const call = (row) => `${repo}.${read.method}(${row}.${read.param.name}, scope, NO_FILTER, { page: 0, size: 10, sort: [] })`;
        body.push(
          `    check(${label('HI-7', 'el historial de una raíz propia se ve')}, (await ${call('propia')}) != null);`,
          `    check(${label('HI-7', 'el historial de una raíz ajena no se ve')}, await hiMissed(() => ${call('ajena')}));`
        );
      }
      if (lifecycle?.logical) {
        const call = (row) => `${repo}.${read.method}(${row}.${read.param.name}${read.scoped ? ', scope' : ''}, NO_FILTER, { page: 0, size: 10, sort: [] })`;
        if (!read.scoped) body.push(fresh('propia'));
        body.push(
          fresh('borrada', read.scoped ? ownerForBorrada : {}),
          `    await ${repo}.deleteById(borrada.${idName});`,
          `    check(${label('HI-7', 'el historial de una raíz viva se ve')}, (await ${call('propia')}) != null);`,
          `    check(${label('HI-7', 'el historial de una raíz borrada no se ve')}, await hiMissed(() => ${call('borrada')}));`
        );
      }
      block(`HI-7: ${name}`, body);
    }

    if (lifecycle?.restore) {
      block(`HI-10: ${name}`, [
        fresh('fila'),
        `    await ${repo}.deleteById(fila.${idName});`,
        `    await ${repo}.restore(fila.${idName});`,
        `    const kinds = await hiKinds(${type}, ${key('fila')});`,
        `    check(${label('HI-10', 'restaurar deja la entrada restored')}, kinds.join() === 'restored,deleted,created', kinds.join());`
      ]);
    }

    if (lifecycle?.retention?.fromDeleted) {
      const span = lifecycle.retention.span;
      if (!span.days) throw new Error('history-probes: una retención que no es en días no tiene sujeto todavía');
      dist(retentionClass(name), retentionPath(name));
      dist(retentionTimerClass(name), retentionTimerPath(name));
      const cache = retentionCaches(model, name).length > 0 ? ', { clear: async () => {} }' : '';
      const settings = `{ ${decap(name)}: { cron: '0 30 2 * * *', batchSize: 10 } }`;
      const raw = document
        ? `(await database.collection(${js(entity.collectionName)}).findOne({ _id: new UUID(String(fila.${idName})) }))`
        : `(await dataSource.manager.findOne(${ormClass(name)}, { where: { ${idName}: fila.${idName} } }))`;
      if (!document) dist(ormClass(name), ormPath(name));
      const backdate = document
        ? `    await database.collection(${js(entity.collectionName)}).updateOne({ _id: new UUID(String(fila.${idName})) }, { $set: { deletedAt: new Date(Date.now() - ${span.days + 1} * 86_400_000) } });`
        : `    await dataSource.manager.update(${ormClass(name)}, { ${idName}: fila.${idName} }, { deletedAt: new Date(Date.now() - ${span.days + 1} * 86_400_000) });`;
      const expire = [
        fresh('fila'),
        update('fila', edited(`hi-ret-${salt}`)),
        `    await ${repo}.deleteById(fila.${idName});`,
        backdate,
        `    await new ${retentionTimerClass(name)}(new ${retentionClass(name)}(tx, historyStore), ${settings}${cache}).tick();`
      ];
      if (lifecycle.retention.then === 'delete') {
        block(`HI-9: ${name}`, [
          ...expire,
          `    check(${label('HI-9', 'la retención purgó la fila (la sonda mide)')}, ${raw} == null);`,
          `    check(${label('HI-9', 'la purga de lo borrado se lleva el historial')}, (await hiEntries(${type}, ${key('fila')})).length === 0);`
        ]);
      } else {
        const personal = Object.fromEntries(shape.personal.map(({ path, required }) => [path, required]));
        block(`HI-8: ${name}`, [
          ...expire,
          `    const all = await hiEntries(${type}, ${key('fila')});`,
          `    check(${label('HI-8', 'deja la entrada anonymized')}, all[0]?.change === 'anonymized', all[0]?.change);`,
          `    const personal = ${js(personal)};`,
          `    const substitute = wireText('anon-' + ${key('fila')});`,
          '    let seen = 0;',
          '    for (const entry of all) {',
          '      for (const change of entry.changes) {',
          '        if (!(change.field in personal)) continue;',
          '        seen += 1;',
          "        const expected = personal[change.field] ? substitute : 'null';",
          `        check(${label('HI-8', 'reescribe el before personal de ')} + entry.change + '.' + change.field, wireText(change.before) === expected, wireText(change.before));`,
          `        check(${label('HI-8', 'reescribe el after personal de ')} + entry.change + '.' + change.field, wireText(change.after) === expected, wireText(change.after));`,
          '      }',
          '    }',
          `    check(${label('HI-8', 'el historial tenía algún campo personal (la sonda mide)')}, seen > 0);`
        ]);
      }
    }
  }

  const repos = [...new Set([...probes.map(({ entity }) => entity), ...owners])];
  return `
// ═══ El historial de cambios (DSL 2.29): ${historyCases(model).join(', ')} ═══
try {
${repos.map((entity) => `  const hi${entity.name} = ${adapterOf(entity)};`).join('\n')}
  const NO_FILTER = { field: null, from: null, to: null };
  const hiEntries = async (type, root) => (await historyStore.page(type, root, NO_FILTER, { page: 0, size: 100, sort: [] })).items;
  const hiKinds = async (type, root) => (await hiEntries(type, root)).map((entry) => entry.change);
  const hiSetAt = ${setAt};
  /** No lo ve: null, o el error de su lectura (readMiss: forbidden). */
  const hiMissed = async (read) => { try { return (await read()) == null; } catch { return true; } };
  const hiWipe = async () => {
${wipeHistory.join('\n')}
${wipeLines.join('\n')}
  };
${lines.join('\n')}
  await hiWipe();
} catch (error) {
  check('HI-0: el bloque del historial corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 600));
}
`;
}

