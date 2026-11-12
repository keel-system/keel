// El CICLO DE VIDA DEL DATO (DSL 2.28) contra el adaptador emitido, para db-check y doc-check: LC-1 a LC-10, RT-1 a RT-4
// y PD-2 de keel-core/gen/data-lifecycle.js, con los ids que ejecuta keel-spring (lifecycle-check) sobre los MISMOS
// diseños (keel-core/test/helpers/data-lifecycle-designs.js). Habla con el puerto, con la retención y su recurrente, y con
// el almacén solo para lo que el puerto no enseña (la marca, retrasar un borrado): vale para los dos almacenes.
//
// Las etiquetas importan para el falsado, como en keel-spring: cada sabotaje tiene que caer en EXACTAMENTE sus casos. Por
// eso LC-10 no siembra ninguna fila borrada (mide que el alcance sobreviva al predicado de vida, no la vida, que es LC-1),
// LC-8 SUPONE que la clave de una borrada se puede reusar (si no, es LC-5 quien lo dice, y LC-8 no se mide), RT-1 mira el
// lote y RT-4 lo que purga `from: deleted`. PD-1 (el gate de logs) no necesita base: lo ejecuta test/data-lifecycle.test.js.

import { lifecycleRoots, ANONYMOUS_PREFIX, DATA_LIFECYCLE_CASES, DATA_LIFECYCLE_SABOTAGES } from '@keel-system/keel-core/gen/data-lifecycle';
import { findersOf } from '@keel-system/keel-core/gen';
import { listsUnscoped } from '@keel-system/keel-core/gen/features';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { persistedMembers, elementTable, quoteIdentifierFor } from '@keel-system/keel-core/gen/relational';
import { timerStatements, bindNamed, KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { naturalKeyFinder, uniqueFieldFinders } from '../../src/scaffold/repositories.js';
import { deletedFinder, retentionClass, retentionPath, retentionTimerClass, retentionTimerPath, retentionKindConstant, RETENTION_SETTINGS_TS } from '../../src/scaffold/data-lifecycle.js';
import { ormClass, ormPath } from '../../src/scaffold/persistence-entities.js';
import { READ_SCOPE_TS } from '../../src/scaffold/read-scope.js';
import { EXCEPTION_FILTER_TS } from '../../src/scaffold/rest-support.js';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { classPath, DIRS } from '../../src/scaffold/render.js';
import { MONGO_TIMER_STORE_TS, SQL_TIMER_STORE_TS, TIMER_STORE_TS, TIMER_POLLER_TS, TIMER_KINDS_TS } from '../../src/scaffold/timer.js';

const js = (value) => JSON.stringify(value);
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;
const distOf = (file) => `./${file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')}`;

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const IMPL = /-repository-impl\.ts$/;

/** El texto que se busca y se sustituye en lo emitido, por sabotaje y por almacén (relational | document). */
export const LIFECYCLE_SABOTAGE_SPECS = {
  // El listado y el finder dejan de filtrar lo borrado (filas y total).
  'lc-no-filter': {
    relational: [IMPL, / {4}and\('deletedAt', IsNull\(\)\);\n|where: \{ deletedAt: IsNull\(\) \},\n\s+/g, ''],
    document: [IMPL, /\.find\(\{ deletedAt: null \}|countDocuments\(\{ deletedAt: null \}| {4}conditions\.push\(\{ deletedAt: null \}\);\n/g, (match) => (match.startsWith('.find') ? '.find({}' : match.startsWith('count') ? 'countDocuments({}' : '')]
  },
  // Solo el total cuenta las filas borradas.
  'lc-count': {
    relational: [IMPL, /return pageOf\(rows\.map\(toDomain(\w+)\), pageable, total\);/g, 'return pageOf(rows.map(toDomain$1), pageable, await this.manager.count($1Orm));'],
    document: [IMPL, /countDocuments\((query|\{ deletedAt: null \}), \{ session: this\.session \}\)/g, 'countDocuments({}, { session: this.session })']
  },
  // La carga por id y por clave ven las filas borradas.
  'lc-get-leak': {
    relational: [IMPL, /(this\.manager\.findOne\(\w+, \{ where: \{ [^}]*?), deletedAt: IsNull\(\) \}/g, '$1 }'],
    document: [IMPL, /(this\.collection\.findOne\(\{ [^}]*?), deletedAt: null \}/g, '$1 }']
  },
  // Las unicidades cuentan también las filas borradas: el índice sin el predicado de vida.
  'lc-unique-all-rows': {
    relational: [/-orm\.ts$/, /`?deleted_at`? IS NULL/g, '1 = 1'],
    document: [/document-indexes\.ts$/, /, partialFilterExpression: \{ 'deletedAt': null \}/g, '']
  },
  // La ventana de la restauración, mil veces más larga.
  'lc-restore-window': {
    relational: [IMPL, '* 86_400_000 > Date.now()', '* 86_400_000 * 1000 > Date.now()'],
    document: [IMPL, '* 86_400_000 > Date.now()', '* 86_400_000 * 1000 > Date.now()']
  },
  // La lectura por referencia deja fuera lo borrado.
  'lc-embed-hidden': {
    relational: [IMPL, '{ where: { id: In([...ids])', '{ where: { deletedAt: IsNull(), id: In([...ids])'],
    document: [IMPL, '.find({ _id: { $in: ids.map(', '.find({ deletedAt: null, _id: { $in: ids.map(']
  },
  // El predicado de vida SUSTITUYE a lo que el finder ya llevaba (el alcance) en vez de sumarse.
  'lc-implicit-replace': {
    relational: [IMPL, "    and('deletedAt', IsNull());", "    for (const property of Object.keys(where)) delete where[property];\n    and('deletedAt', IsNull());"],
    document: [IMPL, '    conditions.push({ deletedAt: null });', '    conditions.length = 0;\n    conditions.push({ deletedAt: null });']
  },
  // La retención vence a mitad de su plazo.
  'rt-early': {
    relational: [/-retention-timer\.ts$/, /(const cutoff = new Date\(now\.getTime\(\) - \d+ \* 86_400_000)\)/, '$1 / 2)'],
    document: [/-retention-timer\.ts$/, /(const cutoff = new Date\(now\.getTime\(\) - \d+ \* 86_400_000)\)/, '$1 / 2)']
  },
  // La anonimización marca el agregado pero no toca sus campos personales.
  'rt-anonymize-miss': {
    relational: [/-retention\.ts$/, /^ {6}(found|child)\.\w+ = (substitute|null);\n/gm, ''],
    document: [/-retention\.ts$/, /^ {6}(found|child)\.\w+ = (substitute|null);\n/gm, '']
  },
  // Cada réplica arma SU recurrente: todas barren a la vez.
  'rt-every-replica': {
    relational: [/-retention-timer\.ts$/, /readonly kind = (TimerKinds\.RETENTION_\w+);/g, "readonly kind = $1 + '@' + Math.random().toString(36).slice(2);"],
    document: [/-retention-timer\.ts$/, /readonly kind = (TimerKinds\.RETENTION_\w+);/g, "readonly kind = $1 + '@' + Math.random().toString(36).slice(2);"]
  },
  // El filtro de la API vuelve a llevar la pila (con el mensaje del motor) al log.
  'pd-log-value': {
    relational: [/api-exception-filter\.ts$/, "`Violación de integridad no asociada a ninguna constraint conocida (${exception instanceof Error ? exception.name : 'error'})`)", "'Violación de integridad no asociada a ninguna constraint conocida', exception instanceof Error ? exception.stack : String(exception))"],
    document: [/api-exception-filter\.ts$/, "`Violación de integridad no asociada a ninguna constraint conocida (${exception instanceof Error ? exception.name : 'error'})`)", "'Violación de integridad no asociada a ninguna constraint conocida', exception instanceof Error ? exception.stack : String(exception))"]
  }
};

export const isLifecycleSabotage = (id) => Boolean(LIFECYCLE_SABOTAGE_SPECS[id]);

// ─── Lo que se mide de cada diseño ───────────────────────────────────────────────────────────────────────────────

/** Lo que las sondas necesitan de cada raíz con ciclo de vida, como keel-spring. */
export function probedRoots(model) {
  return lifecycleRoots(model).map((root) => {
    const entity = model.entities.find((candidate) => candidate.name === root.entity);
    const keyFinder = naturalKeyFinder(model, entity);
    const keyFinders = [keyFinder, ...uniqueFieldFinders(model, entity)].filter(Boolean);
    const paginated = model.services.some((group) => group.entity === entity.name && group.operations.some((op) => op.paginated));
    const finders = findersOf(model, entity.name).filter((finder) => finder.live);
    const scoped = scopedRootsOf(model).find((candidate) => candidate.entity?.name === entity.name) ?? null;
    return {
      root,
      entity,
      keyFinder,
      keyFinders,
      listed: root.logical && listsUnscoped(model, entity) && paginated,
      finders,
      batch: root.logical && Boolean(idBatchReason(model, entity)),
      scoped,
      deleted: root.restore ? deletedFinder(entity, keyFinder) : null
    };
  });
}

/** Los campos personales que llevan una unicidad propia: el sujeto de PD-2. */
function personalUniques(model, entity) {
  return uniqueFieldFinders(model, entity).filter((finder) => entity.fields.find((field) => field.name === finder.field)?.personal);
}

/** Los casos que ejecuta el bloque de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. */
export function lifecycleCases(model) {
  const cases = new Set();
  for (const probe of probedRoots(model)) {
    const { root, keyFinders, listed, finders, batch, scoped } = probe;
    if (root.logical) {
      cases.add('LC-3');
      if (keyFinders.length > 0) cases.add('LC-4').add('LC-5');
      if (listed || finders.length > 0) cases.add('LC-1');
      if (listed || finders.some((finder) => finder.result === 'page')) cases.add('LC-2');
      if (root.restore) {
        cases.add('LC-6');
        if (Number.isInteger(root.restore.days)) cases.add('LC-7');
        if (keyFinders.length > 0) cases.add('LC-8');
      }
      if (batch) cases.add('LC-9');
      if (scoped && finders.some((finder) => finder.scope)) cases.add('LC-10');
    }
    if (root.retention) {
      cases.add('RT-1').add('RT-3');
      if (root.retention.then === 'anonymize') cases.add('RT-2');
      if (root.retention.fromDeleted) cases.add('RT-4');
    }
    if (personalUniques(model, probe.entity).length > 0) cases.add('PD-2');
  }
  const order = DATA_LIFECYCLE_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Lo que tiene que caer con un sabotaje en este diseño: sus casos que el bloque ejecuta. Con PostgreSQL, `pd-log-value`
 * no tiene nada que hacer caer: el mensaje del driver no lleva el valor (va en `detail`, que ningún log generado copia;
 * medido), así que la pila que el sabotaje devuelve al log está limpia.
 */
export function lifecycleSabotageVerdict(checks, id, model, { engine }) {
  const cases = lifecycleCases(model);
  const falls = DATA_LIFECYCLE_SABOTAGES[id].filter((caseId) => !(id === 'pd-log-value' && engine === 'postgresql'));
  const want = falls.filter((caseId) => cases.includes(caseId) && caseId !== 'PD-3').sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^(LC|RT|PD)-\d+:/.test(check.name)).map((check) => /^((?:LC|RT|PD)-\d+):/.exec(check.name)[1]))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Las tablas de un agregado, hijas y listas antes que la raíz: lo que hay que vaciar para empezar limpio. */
function aggregateTables(model, entity, seen = new Set()) {
  const tables = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'elementCollection') tables.push(elementTable(entity, member).table);
    else if (member.kind === 'relationMany' && !member.relation.backReference && !seen.has(member.relation.entity)) {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      if (child) tables.push(...aggregateTables(model, child, new Set([...seen, entity.name])));
    }
  }
  tables.push(entity.tableName);
  return tables;
}

/**
 * El bloque del ciclo de vida, con `check`, `stateOf` y `randomUUID` del script de la sonda y su almacén (`dataSource` o
 * `database`). `sampleEntity` da el agregado de muestra y `adapterOf(entity)` el adaptador de una raíz.
 */
export function lifecycleBlock(model, ctx, { document, engine, sampleEntity, adapterOf }) {
  const probes = probedRoots(model);
  if (probes.length === 0) return '';
  // La caché de las lecturas de la raíz, doblada (T5): el recurrente la vacía tras barrer, y aquí no hay Redis.
  const cacheArg = (entity) => (retentionCaches(model, entity.name).length > 0 ? ', { clear: async () => {} }' : '');
  let salt = 0;
  const sample = (entity) => sampleEntity(model, entity, ctx, `lc${salt++}`);
  const dist = (symbol, file) => ctx.imports.add(`${symbol}|${file}`);
  const quote = (name) => quoteIdentifierFor(engine, name);
  const wiped = new Set();
  for (const { entity, scoped } of probes) {
    wiped.add(entity.name);
    const hop = scoped ? readScopePath(model, scoped.read).hops[0] : null;
    if (hop) wiped.add(hop.to);
  }
  const wipeLines = [...wiped].flatMap((name) => {
    const entity = model.entities.find((candidate) => candidate.name === name);
    return document
      ? [`    await database.collection(${js(entity.collectionName)}).deleteMany({});`]
      : aggregateTables(model, entity).map((table) => `    await dataSource.query(${js(`DELETE FROM ${quote(table)}`)});`);
  });
  const lines = [];
  for (const probe of probes) {
    const { root, entity, keyFinders, listed, finders, batch, scoped } = probe;
    const name = entity.name;
    const idName = entity.idField?.name ?? 'id';
    const repo = `lc${name}`;
    const has = (row) => `String(${row}.${idName})`;
    // Una fila nueva: la muestra con OTRO id (y otros ids en sus hijas, por la muestra nueva) y lo que se fuerce.
    const fresh = (variable, forced = {}) => {
      const overrides = Object.entries(forced).map(([key, value]) => `, ${key}: ${value}`).join('');
      return `    const ${variable} = await ${repo}.save(new ${name}({ ...stateOf(${sample(entity)}), ${idName}: randomUUID()${overrides} }));`;
    };
    const keyParams = [...new Map(keyFinders.flatMap((finder) => finder.params).map((param) => [param.name, param])).values()];
    const sameKeys = (row) => Object.fromEntries(keyParams.map((param) => [param.name, `${row}.${param.name}`]));
    const label = (caseId, text) => js(`${caseId}: ${name} ${text}`);
    // El almacén crudo: la fila con su marca, y retrasar un borrado.
    let rawRow;
    let backdate;
    if (document) {
      rawRow = (row) => `(await database.collection(${js(entity.collectionName)}).findOne({ _id: new UUID(String(${row}.${idName})) }))`;
      backdate = (row, days) => `    await database.collection(${js(entity.collectionName)}).updateOne({ _id: new UUID(String(${row}.${idName})) }, { $set: { deletedAt: new Date(Date.now() - ${days} * 86_400_000) } });`;
    } else {
      dist(ormClass(name), ormPath(name));
      rawRow = (row) => `(await dataSource.manager.findOne(${ormClass(name)}, { where: { ${idName}: ${row}.${idName} } }))`;
      backdate = (row, days) => `    await dataSource.manager.update(${ormClass(name)}, { ${idName}: ${row}.${idName} }, { deletedAt: new Date(Date.now() - ${days} * 86_400_000) });`;
    }
    const block = (title, body) => lines.push(`  // ${title}\n  {\n    await lcWipe();\n${body.join('\n')}\n  }`);

    if (root.logical) {
      block(`LC-3: ${name}`, [
        fresh('borrada'),
        fresh('viva'),
        `    await ${repo}.deleteById(borrada.${idName});`,
        `    check(${label('LC-3', 'la carga por id no ve una fila borrada')}, (await ${repo}.findById(borrada.${idName})) == null);`,
        `    check(${label('LC-3', 'la carga por id ve una fila viva')}, (await ${repo}.findById(viva.${idName})) != null);`,
        '    // D5: borrarla otra vez no la devuelve.',
        `    await ${repo}.deleteById(borrada.${idName});`,
        `    check(${label('LC-3', 'borrar dos veces no la devuelve')}, (await ${repo}.findById(borrada.${idName})) == null);`
      ]);
      for (const finder of keyFinders) {
        block(`LC-4: ${name}.${finder.name}`, [
          fresh('borrada'),
          `    await ${repo}.deleteById(borrada.${idName});`,
          `    check(${label('LC-4', `${finder.name} no ve una fila borrada`)}, (await ${repo}.${finder.name}(${finder.params.map((param) => `borrada.${param.name}`).join(', ')})) == null);`
        ]);
      }
      if (keyFinders.length > 0) {
        block(`LC-5: ${name}`, [
          fresh('borrada'),
          `    await ${repo}.deleteById(borrada.${idName});`,
          '    let nueva = null;',
          `    try { nueva = await ${repo}.save(new ${name}({ ...stateOf(${sample(entity)}), ${idName}: randomUUID()${Object.entries(sameKeys('borrada')).map(([key, value]) => `, ${key}: ${value}`).join('')} })); } catch (error) { check(${label('LC-5', 'la clave de una borrada se puede volver a usar')}, false, error?.message); }`,
          `    if (nueva) check(${label('LC-5', 'la clave de una borrada se puede volver a usar')}, (await ${repo}.findById(nueva.${idName})) != null && ${has('nueva')} !== ${has('borrada')});`
        ]);
      }
      const listings = [];
      if (listed) listings.push({ call: (size) => `${repo}.list({ page: 0, size: ${size}, sort: [] })`, page: true, label: 'list' });
      for (const finder of finders) {
        const filter = finder.criteria.length > 0 ? `{ ${finder.criteria.map((criterion) => `${criterion.name}: null`).join(', ')} }` : null;
        if (finder.scope) dist('ReadScope', READ_SCOPE_TS);
        listings.push({
          call: (size) => `${repo}.${finder.method}(${[filter, finder.result === 'page' ? `{ page: 0, size: ${size}, sort: [] }` : null, finder.scope ? 'ReadScope.unrestricted()' : null].filter(Boolean).join(', ')})`,
          page: finder.result === 'page',
          label: finder.method
        });
      }
      for (const listing of listings) {
        const ids = (size) => `(await ${listing.call(size)})${listing.page ? '.items' : ''}.map((row) => String(row.${idName}))`;
        block(`LC-1: ${name}.${listing.label}`, [
          fresh('borrada'),
          fresh('viva'),
          `    await ${repo}.deleteById(borrada.${idName});`,
          `    const seen = ${ids(100)};`,
          `    check(${label('LC-1', `${listing.label} ve la fila viva`)}, seen.includes(${has('viva')}), seen.join(', '));`,
          `    check(${label('LC-1', `${listing.label} no devuelve una fila borrada`)}, !seen.includes(${has('borrada')}));`
        ]);
        if (listing.page) {
          block(`LC-2: ${name}.${listing.label}`, [
            fresh('borrada'),
            fresh('viva1'),
            fresh('viva2'),
            `    await ${repo}.deleteById(borrada.${idName});`,
            `    const page = await ${listing.call(1)};`,
            `    check(${label('LC-2', `${listing.label}: el total y las páginas no cuentan las borradas`)}, page.totalElements === 2 && page.totalPages === 2, \`\${page.totalElements} / \${page.totalPages}\`);`
          ]);
        }
      }
      if (root.restore) {
        const deleted = probe.deleted;
        block(`LC-6: ${name}`, [
          fresh('borrada'),
          `    await ${repo}.deleteById(borrada.${idName});`,
          `    check(${label('LC-6', 'restore devuelve la fila')}, (await ${repo}.restore(borrada.${idName})) != null);`,
          `    check(${label('LC-6', 'tras restaurar se ve')}, (await ${repo}.findById(borrada.${idName})) != null);`,
          `    check(${label('LC-6', 'restaurar una viva da null')}, (await ${repo}.restore(borrada.${idName})) == null);`,
          ...(deleted
            ? [
                `    await ${repo}.deleteById(borrada.${idName});`,
                `    check(${label('LC-6', `${deleted.name} encuentra la borrada`)}, String((await ${repo}.${deleted.name}(${probe.keyFinder.params.map((param) => `borrada.${param.name}`).join(', ')}))?.${idName}) === ${has('borrada')});`
              ]
            : [])
        ]);
        if (Number.isInteger(root.restore.days)) {
          const error = operationError(model, root.restore.operation, root.restore.error);
          dist(error.exceptionClass, classPath(DIRS.errors, error.exceptionClass));
          block(`LC-7: ${name}`, [
            fresh('borrada'),
            `    await ${repo}.deleteById(borrada.${idName});`,
            backdate('borrada', root.restore.days + 1),
            `    try {`,
            `      await ${repo}.restore(borrada.${idName});`,
            `      check(${label('LC-7', `fuera de la ventana da ${root.restore.error}`)}, false, 'se restauró');`,
            `    } catch (error) {`,
            `      check(${label('LC-7', `fuera de la ventana da ${root.restore.error}`)}, error instanceof ${error.exceptionClass}, error?.message);`,
            `    }`,
            '    // Por el almacén y no por la carga del puerto, que es LC-3: el intento no le quitó la marca.',
            `    check(${label('LC-7', 'el intento la deja borrada')}, ${rawRow('borrada')}?.deletedAt != null);`
          ]);
        }
        if (keyFinders.length > 0) {
          block(`LC-8: ${name}`, [
            fresh('borrada'),
            `    await ${repo}.deleteById(borrada.${idName});`,
            '    // Supone LC-5: si la clave de una borrada no se puede reusar, lo dice LC-5 y este caso no tiene qué medir.',
            '    let ocupada = true;',
            `    try { await ${repo}.save(new ${name}({ ...stateOf(${sample(entity)}), ${idName}: randomUUID()${Object.entries(sameKeys('borrada')).map(([key, value]) => `, ${key}: ${value}`).join('')} })); } catch { ocupada = false; }`,
            '    if (ocupada) {',
            `      try {`,
            `        await ${repo}.restore(borrada.${idName});`,
            `        check(${label('LC-8', 'restaurar con la clave ocupada choca con la unicidad')}, false, 'se restauró');`,
            `      } catch (error) {`,
            `        const translated = translatePersistenceError(error);`,
            `        check(${label('LC-8', 'restaurar con la clave ocupada es el 409 de su unicidad, con su nombre')}, String(error?.message).includes('uk_') && translated?.httpStatus === 409, error?.message);`,
            `      }`,
            '    }'
          ]);
        }
      }
      if (batch) {
        block(`LC-9: ${name}`, [
          fresh('borrada'),
          `    await ${repo}.deleteById(borrada.${idName});`,
          `    const seen = (await ${repo}.findAllById([borrada.${idName}])).map((row) => String(row.${idName}));`,
          `    check(${label('LC-9', 'findAllById ve la raíz borrada (D3)')}, seen.includes(${has('borrada')}), seen.join(', '));`
        ]);
      }
      const scopedFinder = scoped ? finders.find((finder) => finder.scope) : null;
      if (scopedFinder) {
        dist('ReadScope', READ_SCOPE_TS);
        const path = readScopePath(model, scoped.read);
        if (path.hops.length > 1) throw new Error(`lifecycle-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
        const hop = path.hops[0] ?? null;
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `ReadScope.within([${value}])` : `ReadScope.ownedBy(${value})`);
        const seed = [];
        if (hop) {
          const owners = `lc${hop.to}`;
          seed.push(
            `    const ownerA = await ${owners}.save(new ${hop.to}({ ...stateOf(${sample(hop.entity)}), ${hop.entity.idField?.name ?? 'id'}: randomUUID(), ${scoped.read.field}: 'lc-own-a' }));`,
            `    const ownerB = await ${owners}.save(new ${hop.to}({ ...stateOf(${sample(hop.entity)}), ${hop.entity.idField?.name ?? 'id'}: randomUUID(), ${scoped.read.field}: 'lc-own-b' }));`,
            fresh('a1', { [`${hop.relation}Id`]: `ownerA.${hop.entity.idField?.name ?? 'id'}` }),
            fresh('b1', { [`${hop.relation}Id`]: `ownerB.${hop.entity.idField?.name ?? 'id'}` })
          );
        } else {
          seed.push(fresh('a1', { [scoped.read.field]: js('lc-own-a') }), fresh('b1', { [scoped.read.field]: js('lc-own-b') }));
        }
        const filter = scopedFinder.criteria.length > 0 ? `{ ${scopedFinder.criteria.map((criterion) => `${criterion.name}: null`).join(', ')} }` : null;
        const call = `${repo}.${scopedFinder.method}(${[filter, scopedFinder.result === 'page' ? '{ page: 0, size: 100, sort: [] }' : null, scopeOf("'lc-own-a'")].filter(Boolean).join(', ')})`;
        block(`LC-10: ${name}.${scopedFinder.method}`, [
          '    // Sin ninguna fila borrada: lo que se mide es que el alcance sobreviva al predicado de vida, no la vida (LC-1).',
          ...seed,
          `    const seen = (await ${call})${scopedFinder.result === 'page' ? '.items' : ''}.map((row) => String(row.${idName}));`,
          `    check(${label('LC-10', `${scopedFinder.method}: el listado acotado ve la fila propia`)}, seen.includes(${has('a1')}), seen.join(', '));`,
          `    check(${label('LC-10', `${scopedFinder.method}: el predicado de vida no se come el alcance`)}, !seen.includes(${has('b1')}));`
        ]);
      }
    }

    if (root.retention) {
      const retention = root.retention;
      const span = retention.span;
      if (!span.days) throw new Error('lifecycle-probes: una retención sin días literales no tiene sujeto todavía');
      dist(retentionClass(name), retentionPath(name));
      dist(retentionTimerClass(name), retentionTimerPath(name));
      const settings = `{ ${decap(name)}: { cron: '0 30 2 * * *', batchSize: 2 } }`;
      const tick = `    await new ${retentionTimerClass(name)}(new ${retentionClass(name)}(tx), ${settings}${cacheArg(entity)}).tick();`;
      const present = (row) => `${rawRow(row)} != null`;
      const ago = (days) => `new Date(Date.now() - ${days} * 86_400_000)`;
      if (retention.fromDeleted) {
        block(`RT-1: ${name}`, [
          fresh('viva'),
          fresh('reciente'),
          `    await ${repo}.deleteById(reciente.${idName});`,
          backdate('reciente', span.days - 1),
          tick,
          `    check(${label('RT-1', 'una fila viva (sin deletedAt) no vence')}, ${present('viva')});`,
          `    check(${label('RT-1', 'una borrada dentro de la retención no vence')}, ${present('reciente')});`
        ]);
        block(`RT-4: ${name}`, [
          // Tres, con el lote de dos: el tick repite mientras salga lleno.
          fresh('vieja1'),
          fresh('vieja2'),
          fresh('vieja3'),
          ...['vieja1', 'vieja2', 'vieja3'].flatMap((row) => [`    await ${repo}.deleteById(${row}.${idName});`, backdate(row, span.days + 1)]),
          tick,
          `    check(${label('RT-4', 'lo borrado hace más de la retención se purga, también más allá del primer lote')}, !(${present('vieja1')}) && !(${present('vieja2')}) && !(${present('vieja3')}));`
        ]);
      } else {
        const due = retention.then === 'delete' ? (row) => `!(${present(row)})` : (row) => `${rawRow(row)}?.anonymizedAt != null`;
        const kept = retention.then === 'delete' ? (row) => present(row) : (row) => `${rawRow(row)}?.anonymizedAt == null`;
        block(`RT-1: ${name}`, [
          fresh('vencida', { [retention.from]: ago(span.days + 1) }),
          fresh('reciente', { [retention.from]: ago(span.days - 1) }),
          tick,
          `    check(${label('RT-1', `lo vencido se ${retention.then === 'delete' ? 'borra' : 'anonimiza'}`)}, ${due('vencida')});`,
          `    check(${label('RT-1', `lo que está dentro de la retención no se ${retention.then === 'delete' ? 'borra' : 'anonimiza'}`)}, ${kept('reciente')});`
        ]);
        if (retention.then === 'anonymize') {
          const personal = retention.anonymize.find((member) => member.entity === name)?.fields ?? [];
          const checks = personal.flatMap((field) =>
            field.required
              ? [
                  `    check(${label('RT-2', `${field.name} lleva el sustituto`)}, after?.${field.name} === ${js(ANONYMOUS_PREFIX)} + ${has('vencida')}, after?.${field.name});`,
                  `    check(${label('RT-2', `${field.name} de la otra lleva SU sustituto (la unicidad sobrevive)`)}, other?.${field.name} === ${js(ANONYMOUS_PREFIX)} + ${has('otra')}, other?.${field.name});`
                ]
              : [`    check(${label('RT-2', `${field.name} queda vacío`)}, after?.${field.name} == null, after?.${field.name});`]
          );
          block(`RT-2: ${name}`, [
            fresh('vencida', { [retention.from]: ago(span.days + 1) }),
            fresh('otra', { [retention.from]: ago(span.days + 2) }),
            tick,
            `    const after = await ${repo}.findById(vencida.${idName});`,
            `    const other = await ${repo}.findById(otra.${idName});`,
            ...checks
          ]);
        }
      }
    }

    const personal = personalUniques(model, entity);
    if (personal.length > 0) {
      const finder = personal[0];
      const value = js(`pd2-${name.toLowerCase()}@valor.personal`);
      dist('ApiExceptionFilter', EXCEPTION_FILTER_TS);
      block(`PD-2: ${name}.${finder.field}`, [
        `    const primera = await ${repo}.save(new ${name}({ ...stateOf(${sample(entity)}), ${idName}: randomUUID(), ${finder.field}: ${value} }));`,
        '    void primera;',
        '    const captured = [];',
        "    const sink = (...parts) => captured.push(parts.map((part) => (part instanceof Error ? part.stack : String(part))).join(' '));",
        '    Logger.overrideLogger({ log: sink, error: sink, warn: sink, debug: sink, verbose: sink, fatal: sink });',
        '    let clash = null;',
        `    try { await ${repo}.save(new ${name}({ ...stateOf(${sample(entity)}), ${idName}: randomUUID(), ${finder.field}: ${value} })); } catch (error) { clash = error; }`,
        `    check(${label('PD-2', `la unicidad de ${finder.field} salta`)}, clash != null);`,
        '    // La misma violación sin constraint conocida, por el filtro de la API: la rama que escribe en el log.',
        '    const unknown = unattributed(clash);',
        "    const reply = { status() { return reply; }, header() { return reply; }, send() { return reply; } };",
        "    const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ method: 'POST', url: '/' }) }) };",
        '    new ApiExceptionFilter().catch(unknown, host);',
        "    Logger.overrideLogger(['log', 'error', 'warn']);",
        `    check(${label('PD-2', 'el filtro escribió la violación sin constraint conocida (la sonda mide)')}, captured.some((line) => line.includes('Violación de integridad')), captured.join(' | ').slice(0, 300));`,
        `    check(${label('PD-2', `ningún log generado lleva el valor personal de ${finder.field}`)}, !captured.some((line) => line.includes(${value})), captured.filter((line) => line.includes(${value})).join(' | ').slice(0, 300));`
      ]);
    }
  }

  // RT-3: dos réplicas, un barrido (el R1 de la 2.26), con la forma de la sonda de las purgas.
  const retained = probes.filter(({ root }) => root.retention);
  let replicaBlock = '';
  if (retained.length > 0) {
    const storeClass = document ? 'MongoTimerStore' : 'SqlTimerStore';
    // Importados DENTRO del bloque: el preámbulo del cronómetro (los plazos de codes-*) ya declara el almacén.
    const timerImports = [
      `    const { ${storeClass}: LcTimerStore } = await import('${distOf(document ? MONGO_TIMER_STORE_TS : SQL_TIMER_STORE_TS)}');`,
      `    const { TimerArmedSignal: LcSignal } = await import('${distOf(TIMER_STORE_TS)}');`,
      `    const { TimerPoller: LcPoller } = await import('${distOf(TIMER_POLLER_TS)}');`
    ].join('\n');
    const fire = document
      ? "await database.collection('keel_timer').updateMany({ kind }, { $set: { due_at: await lcStore.dbNow(), claimed_until: null, claim_token: null } });"
      : `await dataSource.query(${js(bindNamed(timerStatements(engine).fire, engine === 'postgresql' ? 'dollar' : 'question').sql)}, [kind]);`;
    const clear = document ? "await database.collection('keel_timer').deleteMany({});" : `await dataSource.query('DELETE FROM ${KEEL_TIMER.table}');`;
    replicaBlock = retained
      .map(
        ({ entity }) => `  // RT-3: ${entity.name}
  {
${timerImports}
    ${clear}
    const lcStore = new LcTimerStore(tx, new LcSignal());
    let sweeps = 0;
    // La retención, doblada y COMPARTIDA: contar sus \`due\` es contar quién barrió.
    const shared = { due: async () => { sweeps += 1; return []; }, apply: async () => {} };
    const settings = { ${decap(entity.name)}: { cron: '0 30 2 * * *', batchSize: 10 } };
    const pollerSettings = { enabled: true, maxSleepMs: 30_000, batchSize: 50, leaseMs: 60_000, maxAttempts: 10, retryDelayMs: 0, drainBudgetMs: 0, retentionDays: 7, purgeCron: '0 30 5 * * *' };
    const replica = () => {
      const recurring = new ${retentionTimerClass(entity.name)}(shared, settings${cacheArg(entity)});
      return { recurring, poller: new LcPoller(lcStore, [], [recurring], pollerSettings, tx, new LcSignal()) };
    };
    const a = replica();
    const b = replica();
    await a.poller.ensureRecurring();
    await b.poller.ensureRecurring();
    for (const { recurring: { kind } } of [a, b]) {
      ${fire}
    }
    await a.poller.pollOnce();
    await b.poller.pollOnce();
    check(${js(`RT-3: ${entity.name} con dos réplicas, cada tick de la retención lo barre una sola`)}, sweeps === 1, \`\${sweeps} barridos\`);
    ${clear}
  }`
      )
      .join('\n');
  }

  const repos = [...new Set([...probes.map(({ entity }) => entity), ...probes.filter(({ scoped }) => scoped).map(({ scoped }) => readScopePath(model, scoped.read).hops[0]?.entity).filter(Boolean)])];
  return `
// ═══ El ciclo de vida del dato (DSL 2.28): ${lifecycleCases(model).join(', ')} ═══
try {
  const { Logger } = await import('@nestjs/common');
${repos.map((entity) => `  const lc${entity.name} = ${adapterOf(entity)};`).join('\n')}
  const lcWipe = async () => {
${wipeLines.join('\n')}
  };
  /** La misma violación con su constraint renombrada: el traductor ya no la reconoce y va a la rama genérica. */
  const unattributed = (error, depth = 0) => {
    if (error == null || typeof error !== 'object' || depth > 3) return typeof error === 'string' ? error.replaceAll('uk_', 'zz_') : error;
    const copy = Object.create(Object.getPrototypeOf(error));
    for (const key of Object.getOwnPropertyNames(error)) copy[key] = unattributed(error[key], depth + 1);
    return copy;
  };
${lines.join('\n')}
${replicaBlock}
  await lcWipe();
} catch (error) {
  check('LC-0: el bloque del ciclo de vida corre sin un error inesperado', false, String(error?.stack ?? error).slice(0, 600));
}
`;
}

export { retentionKindConstant, RETENTION_SETTINGS_TS, TIMER_KINDS_TS };
