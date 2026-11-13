// El CICLO DE VIDA DEL DATO (DSL 2.28) contra el adaptador emitido, para db-check y doc-check: LC-1 a LC-10, RT-1 a RT-4
// y PD-2 de keel-core/gen/data-lifecycle.js, con los ids que ejecutan keel-spring (lifecycle-check) y keel-nest
// (scripts/lib/lifecycle-probes.js) sobre los MISMOS diseños (keel-core/test/helpers/data-lifecycle-designs.js). Habla con
// el puerto, con la retención y su recurrente, y con el almacén solo para lo que el puerto no enseña (la marca, retrasar un
// borrado): vale para los dos almacenes.
//
// Un [Fact] por caso, con el id en el nombre (`ContactCard_LC3_…`), dentro de la clase de sondas de cada sujeto: comparte la
// base con el resto de sondas, así que NO vacía tablas como keel-nest. Cada caso siembra sus propias filas y afirma solo
// sobre ellas; el total de una página se mide como DIFERENCIA (antes y después de sembrar), porque otras sondas también
// guardan filas de la misma raíz. Las clases de prueba de un mismo proyecto no comparten base, y dentro de la clase las
// pruebas van una detrás de otra.
//
// Las etiquetas importan para el falsado, como en keel-spring y keel-nest: cada sabotaje tiene que caer en EXACTAMENTE sus
// casos. Por eso LC-10 no siembra ninguna fila borrada (mide que el alcance sobreviva al predicado de vida, no la vida, que
// es LC-1), LC-8 SUPONE que la clave de una borrada se puede reusar (si no, lo dice LC-5 y LC-8 no se mide), RT-1 mira el
// lote y RT-4 lo que purga `from: deleted`. PD-1 (el gate de logs) no necesita base: lo ejecuta
// test/data-lifecycle-parity.test.js.
//
// PD-2 es relacional: lo que copia el valor de una unicidad violada al log es EF (SaveChangesFailed y CommandError, con la
// excepción del motor), y en MySQL ese mensaje lo lleva (`Duplicate entry '…'`); en PostgreSQL va en el detalle, que Npgsql
// no incluye. En documental no hay logger de infraestructura que reciba la excepción del driver: la rama de la API sin
// constraint conocida la fija test/data-lifecycle-parity.test.js, sin base.

import { lifecycleRoots, ANONYMOUS_PREFIX, DATA_LIFECYCLE_CASES, DATA_LIFECYCLE_SABOTAGES } from '@keel-system/keel-core/gen/data-lifecycle';
import { findersOf } from '@keel-system/keel-core/gen';
import { listsUnscoped } from '@keel-system/keel-core/gen/features';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { timerStatements, KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { naturalKeyFinder, uniqueFieldFinders, portClass } from '../../src/scaffold/repositories.js';
import { deletedFinder, retentionClass, retentionRoots, retentionTimerClass, retentionKindConstant, retentionNamespace } from '../../src/scaffold/data-lifecycle.js';
import { dbContextClass, rowClass } from '../../src/scaffold/persistence.js';
import { usesMySql } from '../../src/scaffold/relational-engine.js';
import { timerNamespace } from '../../src/scaffold/timer.js';
import { csLocal, csMember, csString, namespaceOf } from '../../src/scaffold/render.js';
import { sampleState } from './db-probes.js';

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que se busca y se sustituye en lo emitido, por sabotaje y por almacén: [sufijo del archivo, texto o expresión,
 * sustituto, y opcionalmente una expresión que el archivo tiene que contener]. Rompen lo emitido CONSERVANDO LA FORMA
 * (sigue compilando). Null: el sabotaje no tiene qué romper en ese almacén.
 */
export const LIFECYCLE_SABOTAGE_SPECS = {
  // El listado y el finder dejan de filtrar lo borrado (filas y total).
  'lc-no-filter': {
    relational: ['Repositories/', /\.Where\(r => r\.DeletedAt == null\)|^ {8}query = query\.Where\(r => r\.DeletedAt == null\);\n/gm, ''],
    document: ['Repositories/', /var all = NotDeleted;|^ {8}query = Live\(query\);\n/gm, (match) => (match.startsWith('var') ? 'var all = FilterDefinition<BsonDocument>.Empty;' : '')]
  },
  // Solo el total cuenta las filas borradas.
  'lc-count': {
    relational: ['Repositories/', /db\.Set<(\w+)>\(\)\.Where\(r => r\.DeletedAt == null\)\.LongCountAsync|var total = await query\.LongCountAsync/g, (match, row) => (row ? `db.Set<${row}>().LongCountAsync` : 'var total = await Graph().LongCountAsync'), /DeletedAt/],
    document: ['Repositories/', /CountDocumentsAsync\((session, )?(all|query), /g, 'CountDocumentsAsync($1FilterDefinition<BsonDocument>.Empty, ', /NotDeleted/]
  },
  // La carga por id y por clave ven las filas borradas.
  'lc-get-leak': {
    relational: ['Repositories/', / && r\.DeletedAt == null, cancellationToken\)/g, ', cancellationToken)'],
    document: ['Repositories/', /Find\(Live\((.*?)\)\)\.FirstOrDefaultAsync/g, 'Find($1).FirstOrDefaultAsync']
  },
  // Las unicidades cuentan también las filas borradas: el índice sin el predicado de vida.
  'lc-unique-all-rows': {
    relational: ['Persistence/Rows/', /`?deleted_at`? IS NULL/g, '1 = 1'],
    document: [
      'Persistence/DocumentIndexes.cs',
      /, PartialFilterExpression = new BsonDocument\("deletedAt", BsonNull\.Value\)|, \{ "deletedAt", BsonNull\.Value \}/g,
      ''
    ]
  },
  // La ventana de la restauración, mil veces más larga.
  'lc-restore-window': {
    relational: ['Repositories/', /\.AddDays\((\d+)\) > /g, '.AddDays($1 * 1000) > '],
    document: ['Repositories/', /\.AddDays\((\d+)\) > /g, '.AddDays($1 * 1000) > ']
  },
  // La lectura por referencia deja fuera lo borrado.
  'lc-embed-hidden': {
    relational: ['Repositories/', /Where\(r => keys\.Contains\(r\.Id\)\)/g, 'Where(r => keys.Contains(r.Id) && r.DeletedAt == null)', /DeletedAt/],
    document: ['Repositories/', /(var found = await Find\()(new BsonDocument\("_id", new BsonDocument\("\$in", [^;]*?)\)\.ToListAsync/g, '$1Live($2)).ToListAsync', /NotDeleted/]
  },
  // El predicado de vida SUSTITUYE a lo que el finder ya llevaba (el alcance) en vez de sumarse.
  'lc-implicit-replace': {
    relational: ['Repositories/', '        query = query.Where(r => r.DeletedAt == null);', '        query = Graph().AsNoTracking().Where(r => r.DeletedAt == null);'],
    document: ['Repositories/', '        query = Live(query);', '        query = Live(FilterDefinition<BsonDocument>.Empty);']
  },
  // La retención vence a mitad de su plazo.
  'rt-early': {
    relational: ['RetentionTimer.cs', /var cutoff = now\.AddDays\(-(\d+)\);/g, 'var cutoff = now.AddDays(-$1 / 2.0);'],
    document: ['RetentionTimer.cs', /var cutoff = now\.AddDays\(-(\d+)\);/g, 'var cutoff = now.AddDays(-$1 / 2.0);']
  },
  // La anonimización marca el agregado pero no toca sus campos personales.
  'rt-anonymize-miss': {
    relational: ['Persistence/Retention/', /^ +(found|child)\.\w+ = (substitute|null|TextFold\.\w+\(substitute\));\n/gm, ''],
    document: ['Persistence/Retention/', /^ +(found|child)\["[^"]+"\] = (new BsonString\([^;]*\)|BsonNull\.Value);\n/gm, '']
  },
  // Cada réplica tiene SU recurrente: el sondeador ya no encuentra el kind compartido y ninguna barre una sola vez.
  'rt-every-replica': {
    relational: ['RetentionTimer.cs', /public string Kind => (TimerKinds\.Retention\w+);/g, 'public string Kind { get; } = $1 + "@" + Guid.NewGuid();'],
    document: ['RetentionTimer.cs', /public string Kind => (TimerKinds\.Retention\w+);/g, 'public string Kind { get; } = $1 + "@" + Guid.NewGuid();']
  },
  // EF vuelve a escribir en el log el fallo de una sentencia, con la excepción del motor.
  'pd-log-value': {
    relational: [
      'Persistence/PersistenceRegistration.cs',
      'options.ConfigureWarnings(warnings => warnings.Ignore(CoreEventId.SaveChangesFailed, CoreEventId.QueryIterationFailed, RelationalEventId.CommandError));',
      '_ = options;'
    ],
    document: null
  }
};

export const isLifecycleSabotage = (id) => Boolean(LIFECYCLE_SABOTAGE_SPECS[id]);

/** Los sujetos de los sabotajes por almacén: los de data-lifecycle-designs.js con esa rama. */
export const LIFECYCLE_SUBJECTS = { relational: ['cards-logical', 'codes-anonymize', 'codes-delete', 'vault-logical-scoped'], document: ['cards-logical-mongo', 'codes-anonymize-mongo'] };

// ─── Lo que se mide de cada diseño ───────────────────────────────────────────────────────────────────────────────

/** Lo que las sondas necesitan de cada raíz con ciclo de vida, como keel-spring y keel-nest. */
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

/**
 * Los casos que ejecuta el bloque de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. `document`
 * deja fuera PD-2 (ver la cabecera).
 */
export function lifecycleCases(model, { document = model.persistenceKind === 'document' } = {}) {
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
    if (!document && personalUniques(model, probe.entity).length > 0) cases.add('PD-2');
  }
  const order = DATA_LIFECYCLE_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Lo que tiene que caer con un sabotaje en este diseño: sus casos que el bloque ejecuta. Con PostgreSQL, `pd-log-value`
 * no tiene nada que hacer caer: el mensaje del motor no lleva el valor (va en el detalle, que Npgsql no incluye).
 * `failures` son las líneas de `dotnet test` del proyecto del sujeto.
 */
export function lifecycleSabotageVerdict(failures, id, model, { engine }) {
  const cases = lifecycleCases(model);
  const falls = DATA_LIFECYCLE_SABOTAGES[id].filter(() => !(id === 'pd-log-value' && engine === 'postgresql'));
  const want = [...new Set(falls.filter((caseId) => cases.includes(caseId) && caseId !== 'PD-3'))].sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/_(LC|RT|PD)(\d+)_/g)].map((match) => `${match[1]}-${match[2]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Sustituye miembros del inicializador `<Entidad>State` que da sampleState: `{ Miembro: expresión }`. */
export function overriding(state, overrides) {
  let text = state;
  for (const [member, value] of Object.entries(overrides)) {
    const line = new RegExp(`^(\\s*)${member} = [^\\n]*,$`, 'm');
    if (!line.test(text)) throw new Error(`lifecycle-probes: la muestra no tiene el miembro ${member}`);
    text = text.replace(line, (_, pad) => `${pad}${member} = ${value},`);
  }
  return text;
}

/** Lo que el contenedor de la sonda registra para el ciclo de vida (antes de AddPersistence). */
export function lifecycleFixtureRegistration(model, { document }) {
  const lines = [];
  if (!document && lifecycleCases(model, { document }).includes('PD-2')) {
    lines.push('        // PD-2 (DSL 2.28): lo que escribe la persistencia en el log, capturado para buscar el valor personal.', '        services.AddLogging(logging => logging.AddProvider(LifecycleLogs.Provider));');
  }
  const roots = retentionRoots(model);
  if (roots.length > 0) {
    lines.push(
      '        // La retención (DSL 2.28): lotes de DOS, y cada recurrente contado por RetentionCount (RT-3).',
      `        services.AddSingleton(${retentionSettings(model, 2)});`,
      ...roots.flatMap(({ entity }) => [
        `        services.AddScoped<${retentionClass(entity.name)}>();`,
        `        services.AddScoped<IRecurringTimerHandler>(provider => new RetentionCount(new ${retentionTimerClass(entity.name)}(provider.GetRequiredService<${retentionClass(entity.name)}>(), provider.GetRequiredService<RetentionSettings>()${cacheArg(model, entity)})));`
      ])
    );
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/** La caché de las lecturas de la raíz, doblada (T5): el recurrente la vacía tras barrer, y aquí no hay Redis. */
export const cacheArg = (model, entity) => (retentionCaches(model, entity.name).length > 0 ? ', new LcNoCache()' : '');

export const retentionSettings = (model, batch) => `new RetentionSettings(${retentionRoots(model).map(() => `new RetentionSweep("0 30 2 * * *", ${batch})`).join(', ')})`;

export function lifecycleProbeUsings(model, { document }) {
  if (lifecycleRoots(model).length === 0) return [];
  const retention = retentionRoots(model).length > 0;
  return [
    'Microsoft.Extensions.Logging',
    'System.Collections.Concurrent',
    namespaceOf(model, 'repositories'),
    namespaceOf(model, 'persistence'),
    namespaceOf(model, 'errors'),
    ...(document ? ['MongoDB.Bson', 'MongoDB.Driver'] : ['Microsoft.EntityFrameworkCore', namespaceOf(model, 'rows')]),
    ...(retention ? [retentionNamespace(model), timerNamespace(model), 'Microsoft.Extensions.Logging.Abstractions'] : []),
    ...(retentionRoots(model).some(({ entity }) => retentionCaches(model, entity.name).length > 0) ? [namespaceOf(model, 'ports')] : [])
  ];
}

/**
 * Los [Fact] del ciclo de vida (van dentro de la clase de sondas, que declara `root`, `Cancel`, `InScope` y los
 * `Ensure<Raíz>`), y aparte las clases de apoyo. `ctx` es el de las muestras de la clase: sus `refs` dan los Ensure.
 */
export function lifecycleProbeBlock(model, ctx, { document }) {
  const probes = probedRoots(model);
  if (probes.length === 0) return null;
  const engine = document ? 'mongodb' : usesMySql(model) ? 'mysql' : 'postgresql';
  let salt = 0;
  const tests = [];
  const helpers = [];
  for (const probe of probes) {
    const { root, entity, keyFinders, listed, finders, batch, scoped } = probe;
    const name = entity.name;
    const port = portClass(entity);
    const id = csMember(entity.idField?.name ?? 'id');
    const fact = (caseId, title, lines, refs) =>
      tests.push(`    [Fact]
    public async Task ${name}_${caseId.replace('-', '')}_${title}() =>
        await InScope(async services =>
        {
${[...[...refs].map((ref) => `            var ${csLocal(`${ref}Id`)} = await Ensure${ref}(services);`), ...lines].join('\n')}
        });`);
    // Una fila nueva: la muestra de la raíz con lo que se fuerce, guardada. `refs` recoge los Ensure que necesita.
    const fresh = (variable, refs, overrides = {}) => {
      const inner = { usings: ctx.usings, refs: new Set(), unsampled: ctx.unsampled, counter: ctx.counter, document: ctx.document };
      const state = overriding(sampleState(model, entity, inner, `lc${salt++}`), overrides);
      for (const ref of inner.refs) {
        ctx.refs.add(ref);
        refs.add(ref);
      }
      return [`            var ${variable} = new ${name}(${state.replace(/\n/g, '\n    ')});`, `            await Lc<${port}>(port => port.Save(${variable}, Cancel));`];
    };
    const get = (expression) => `await LcRead<${port}, ${name}?>(port => port.${expression})`;
    const remove = (variable) => `            await Lc<${port}>(port => port.DeleteById(${variable}.${id}, Cancel));`;
    const keyArgs = (finder, variable) => finder.params.map((param) => `${variable}.${csMember(param.name)}!`).join(', ');
    const keyOverrides = (variable) => Object.fromEntries([...new Map(keyFinders.flatMap((finder) => finder.params).map((param) => [csMember(param.name), `${variable}.${csMember(param.name)}`])).entries()]);
    // El almacén crudo: la fila con sus marcas, y retrasar un borrado.
    const raw = document ? `LcDocument${name}` : `LcRow${name}`;
    if (document) {
      helpers.push(`    private static async Task<BsonDocument?> ${raw}(object id) =>
        await root.GetRequiredService<DocumentDatabase>().Collection(${csString(entity.collectionName)}).Find(new BsonDocument("_id", LcId(id))).FirstOrDefaultAsync(Cancel);${root.logical ? `

    private static async Task LcBackdate${name}(object id, int days) =>
        await root.GetRequiredService<DocumentDatabase>().Collection(${csString(entity.collectionName)}).UpdateOneAsync(
            new BsonDocument("_id", LcId(id)),
            new BsonDocument("$set", new BsonDocument("deletedAt", BsonValues.Of(DateTimeOffset.UtcNow.AddDays(-days)))),
            cancellationToken: Cancel);` : ''}`);
    } else {
      const row = rowClass(name);
      const context = dbContextClass(model);
      const idType = entity.idField?.csType ?? 'Guid';
      helpers.push(`    private static Task<${row}?> ${raw}(${idType} id) =>
        InScope(services => services.GetRequiredService<${context}>().Set<${row}>().AsNoTracking().SingleOrDefaultAsync(r => r.${id} == id, Cancel));${root.logical ? `

    private static Task LcBackdate${name}(${idType} id, int days) =>
        InScope(async services =>
        {
            var db = services.GetRequiredService<${context}>();
            var row = await db.Set<${row}>().SingleAsync(r => r.${id} == id, Cancel);
            row.DeletedAt = DateTimeOffset.UtcNow.AddDays(-days);
            await db.SaveChangesAsync(Cancel);
        });` : ''}`);
    }
    const markOf = (variable, mark) => (document ? `(await ${raw}(${variable}.${id}))?.GetValue(${csString(mark)}, BsonNull.Value).IsBsonNull == false` : `(await ${raw}(${variable}.${id}))?.${csMember(mark)} is not null`);
    const present = (variable) => `await ${raw}(${variable}.${id}) is not null`;

    if (root.logical) {
      {
        const refs = new Set();
        fact('LC-3', 'LaCargaPorIdNoVeUnaFilaBorrada', [
          ...fresh('borrada', refs),
          ...fresh('viva', refs),
          remove('borrada'),
          `            Assert.Null(${get(`FindById(borrada.${id}, Cancel)`)});`,
          `            Assert.NotNull(${get(`FindById(viva.${id}, Cancel)`)});`,
          '            // D5: borrarla otra vez no la devuelve.',
          remove('borrada'),
          `            Assert.Null(${get(`FindById(borrada.${id}, Cancel)`)});`
        ], refs);
      }
      for (const finder of keyFinders) {
        const refs = new Set();
        fact('LC-4', `${finder.name}NoVeUnaFilaBorrada`, [...fresh('borrada', refs), remove('borrada'), `            Assert.Null(${get(`${finder.name}(${keyArgs(finder, 'borrada')}, Cancel)`)});`], refs);
      }
      if (keyFinders.length > 0) {
        const refs = new Set();
        const lines = [...fresh('borrada', refs), remove('borrada')];
        const reuse = fresh('nueva', refs, keyOverrides('borrada'));
        lines.push(
          reuse[0],
          '            // La clave de la borrada, en otra fila viva: el índice único solo cuenta las vivas (D4).',
          reuse[1],
          `            Assert.NotNull(${get(`FindById(nueva.${id}, Cancel)`)});`
        );
        fact('LC-5', 'LaClaveDeUnaBorradaSePuedeVolverAUsar', lines, refs);
      }
      const listings = [];
      if (listed) listings.push({ call: (size) => `List(new Pageable(0, ${size}, []), Cancel)`, page: true, label: 'List' });
      for (const finder of finders) {
        if (finder.criteria.some((criterion) => criterion.required)) throw new Error(`lifecycle-probes: ${finder.method} tiene un filtro obligatorio; la sonda pide sin filtros`);
        const filter = finder.criteria.length > 0 ? `new ${finder.filterType}(${finder.criteria.map(() => 'null').join(', ')})` : null;
        listings.push({
          call: (size) => `${csMember(finder.method)}(${[filter, finder.result === 'page' ? `new Pageable(0, ${size}, [])` : null, finder.scope ? 'ReadScope.Unrestricted()' : null, 'Cancel'].filter(Boolean).join(', ')})`,
          page: finder.result === 'page',
          type: finder.result === 'page' ? `Page<${name}>` : `IReadOnlyList<${name}>`,
          label: csMember(finder.method)
        });
      }
      for (const listing of listings) {
        const type = listing.type ?? `Page<${name}>`;
        const call = (size) => `await LcRead<${port}, ${type}>(port => port.${listing.call(size)})`;
        {
          const refs = new Set();
          fact('LC-1', `${listing.label}NoDevuelveUnaFilaBorrada`, [
            ...fresh('borrada', refs),
            ...fresh('viva', refs),
            remove('borrada'),
            `            var seen = (${call(100_000)})${listing.page ? '.Items' : ''}.Select(row => row.${id}).ToList();`,
            `            Assert.Contains(viva.${id}, seen);`,
            `            Assert.DoesNotContain(borrada.${id}, seen);`
          ], refs);
        }
        if (listing.page) {
          const refs = new Set();
          fact('LC-2', `${listing.label}ElTotalNoCuentaLasBorradas`, [
            `            var before = (${call(1)}).TotalElements;`,
            ...fresh('borrada', refs),
            ...fresh('viva', refs),
            remove('borrada'),
            `            var after = (${call(1)}).TotalElements;`,
            '            // Otras sondas guardan filas de la misma raíz: lo que se mide es la diferencia, una viva más.',
            '            Assert.Equal(before + 1, after);'
          ], refs);
        }
      }
      if (root.restore) {
        const deleted = probe.deleted;
        {
          const refs = new Set();
          fact('LC-6', 'RestaurarDentroDeLaVentanaLaDejaViva', [
            ...fresh('borrada', refs),
            remove('borrada'),
            `            Assert.NotNull(${get(`Restore(borrada.${id}, Cancel)`)});`,
            `            Assert.NotNull(${get(`FindById(borrada.${id}, Cancel)`)});`,
            `            Assert.Null(${get(`Restore(borrada.${id}, Cancel)`)});`,
            ...(deleted
              ? [remove('borrada'), `            Assert.Equal(borrada.${id}, (${get(`${deleted.name}(${keyArgs(probe.keyFinder, 'borrada')}, Cancel)`)})?.${id});`]
              : [])
          ], refs);
        }
        if (Number.isInteger(root.restore.days)) {
          const error = operationError(model, root.restore.operation, root.restore.error);
          const refs = new Set();
          fact('LC-7', 'RestaurarFueraDeLaVentanaEsElErrorDeclarado', [
            ...fresh('borrada', refs),
            remove('borrada'),
            `            await LcBackdate${name}(borrada.${id}, ${root.restore.days + 1});`,
            `            await Assert.ThrowsAsync<${error.exceptionClass}>(() => LcRead<${port}, ${name}?>(port => port.Restore(borrada.${id}, Cancel)));`,
            '            // Por el almacén y no por la carga del puerto, que es LC-3: el intento no le quitó la marca.',
            `            Assert.True(${markOf('borrada', 'deletedAt')});`
          ], refs);
        }
        if (keyFinders.length > 0) {
          const refs = new Set();
          const lines = [...fresh('borrada', refs), remove('borrada')];
          const occupant = fresh('ocupante', refs, keyOverrides('borrada'));
          lines.push(
            '            // Supone LC-5: si la clave de una borrada no se puede reusar, lo dice LC-5 y este caso no tiene qué medir.',
            occupant[0],
            '            try',
            '            {',
            `    ${occupant[1]}`,
            '            }',
            '            catch (DomainException)',
            '            {',
            '                return;',
            '            }',
            `            var error = await Assert.ThrowsAnyAsync<DomainException>(() => LcRead<${port}, ${name}?>(port => port.Restore(borrada.${id}, Cancel)));`,
            '            Assert.Equal(409, error.HttpStatus);'
          );
          fact('LC-8', 'RestaurarConLaClaveOcupadaEsEl409DeSuUnicidad', lines, refs);
        }
      }
      if (batch) {
        const refs = new Set();
        fact('LC-9', 'FindAllByIdVeLaRaizBorrada', [
          ...fresh('borrada', refs),
          remove('borrada'),
          `            var seen = (await LcRead<${port}, IReadOnlyList<${name}>>(port => port.FindAllById(new[] { borrada.${id} }, Cancel))).Select(row => row.${id}).ToList();`,
          `            Assert.Contains(borrada.${id}, seen);`
        ], refs);
      }
      const scopedFinder = scoped ? finders.find((finder) => finder.scope) : null;
      if (scopedFinder) {
        const path = readScopePath(model, scoped.read);
        if (path.hops.length > 1) throw new Error(`lifecycle-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
        const hop = path.hops[0] ?? null;
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `ReadScope.Within(new[] { ${value} })` : `ReadScope.OwnedBy(${value})`);
        const refs = new Set();
        const lines = ['            // Sin ninguna fila borrada: lo que se mide es que el alcance sobreviva al predicado de vida, no la vida (LC-1).'];
        const values = { a: csString(`lc-own-a-${engine}`), b: csString(`lc-own-b-${engine}`) };
        if (hop) {
          const owners = portClass(hop.entity);
          const ownerId = csMember(hop.entity.idField?.name ?? 'id');
          for (const tag of ['a', 'b']) {
            const inner = { usings: ctx.usings, refs: new Set(), unsampled: ctx.unsampled, counter: ctx.counter, document: ctx.document };
            const state = overriding(sampleState(model, hop.entity, inner, `lcown${salt++}`), { [csMember(scoped.read.field)]: values[tag] });
            for (const ref of inner.refs) {
              ctx.refs.add(ref);
              refs.add(ref);
            }
            lines.push(`            var owner${tag.toUpperCase()} = new ${hop.to}(${state.replace(/\n/g, '\n    ')});`, `            await Lc<${owners}>(port => port.Save(owner${tag.toUpperCase()}, Cancel));`);
          }
          lines.push(...fresh('a1', refs, { [csMember(`${hop.relation}Id`)]: `ownerA.${ownerId}` }), ...fresh('b1', refs, { [csMember(`${hop.relation}Id`)]: `ownerB.${ownerId}` }));
        } else {
          lines.push(...fresh('a1', refs, { [csMember(scoped.read.field)]: values.a }), ...fresh('b1', refs, { [csMember(scoped.read.field)]: values.b }));
        }
        const filter = scopedFinder.criteria.length > 0 ? `new ${scopedFinder.filterType}(${scopedFinder.criteria.map(() => 'null').join(', ')})` : null;
        const type = scopedFinder.result === 'page' ? `Page<${name}>` : `IReadOnlyList<${name}>`;
        const call = `${csMember(scopedFinder.method)}(${[filter, scopedFinder.result === 'page' ? 'new Pageable(0, 100000, [])' : null, scopeOf(values.a), 'Cancel'].filter(Boolean).join(', ')})`;
        lines.push(
          `            var seen = (await LcRead<${port}, ${type}>(port => port.${call}))${scopedFinder.result === 'page' ? '.Items' : ''}.Select(row => row.${id}).ToList();`,
          `            Assert.Contains(a1.${id}, seen);`,
          `            Assert.DoesNotContain(b1.${id}, seen);`
        );
        fact('LC-10', `${csMember(scopedFinder.method)}ElPredicadoDeVidaNoSeComeElAlcance`, lines, refs);
      }
    }

    if (root.retention) {
      const retention = root.retention;
      const span = retention.span;
      if (!span.days) throw new Error('lifecycle-probes: una retención sin días literales no tiene sujeto todavía');
      const tick = `            await new ${retentionTimerClass(name)}(new ${retentionClass(name)}(root.GetRequiredService<IServiceScopeFactory>()), ${retentionSettings(model, 2)}${cacheArg(model, entity)}).Tick(Cancel);`;
      const ago = (days) => `DateTimeOffset.UtcNow.AddDays(-${days})`;
      if (retention.fromDeleted) {
        {
          const refs = new Set();
          fact('RT-1', 'UnaFilaVivaOBorradaDentroDeLaRetencionNoVence', [
            ...fresh('viva', refs),
            ...fresh('reciente', refs),
            remove('reciente'),
            `            await LcBackdate${name}(reciente.${id}, ${span.days - 1});`,
            tick,
            `            Assert.True(${present('viva')}, "una fila viva (sin deletedAt) no vence");`,
            `            Assert.True(${present('reciente')}, "una borrada dentro de la retención no vence");`
          ], refs);
        }
        {
          const refs = new Set();
          // Tres, con el lote de dos: el tick repite mientras salga lleno.
          const lines = [...fresh('vieja1', refs), ...fresh('vieja2', refs), ...fresh('vieja3', refs)];
          for (const variable of ['vieja1', 'vieja2', 'vieja3']) lines.push(remove(variable), `            await LcBackdate${name}(${variable}.${id}, ${span.days + 1});`);
          // Lo vencido se borra o, con then: anonymize (el primer sujeto que lo junta con from: deleted es el del historial,
          // DSL 2.29), se queda anonimizado.
          const gone = retention.then === 'delete' ? (variable) => `!(${present(variable)})` : (variable) => markOf(variable, 'anonymizedAt');
          lines.push(tick, ...['vieja1', 'vieja2', 'vieja3'].map((variable) => `            Assert.True(${gone(variable)}, "lo borrado hace más de la retención vence, también más allá del primer lote");`));
          fact('RT-4', 'LoBorradoHaceMasDeLaRetencionVence', lines, refs);
        }
      } else {
        const fromMember = csMember(retention.from);
        const due = retention.then === 'delete' ? (variable) => `!(${present(variable)})` : (variable) => markOf(variable, 'anonymizedAt');
        const kept = retention.then === 'delete' ? (variable) => present(variable) : (variable) => `!(${markOf(variable, 'anonymizedAt')})`;
        {
          const refs = new Set();
          fact('RT-1', 'SoloVenceLoQuePasoLaRetencion', [
            ...fresh('vencida', refs, { [fromMember]: ago(span.days + 1) }),
            ...fresh('reciente', refs, { [fromMember]: ago(span.days - 1) }),
            tick,
            `            Assert.True(${due('vencida')}, "lo vencido se ${retention.then === 'delete' ? 'borra' : 'anonimiza'}");`,
            `            Assert.True(${kept('reciente')}, "lo que está dentro de la retención no se ${retention.then === 'delete' ? 'borra' : 'anonimiza'}");`
          ], refs);
        }
        if (retention.then === 'anonymize') {
          const personal = retention.anonymize.find((member) => member.entity === name)?.fields ?? [];
          const checks = personal.flatMap((field) =>
            field.required
              ? [
                  `            Assert.Equal(${csString(ANONYMOUS_PREFIX)} + vencida.${id}, after?.${csMember(field.name)});`,
                  '            // La otra lleva SU sustituto: la unicidad sobrevive.',
                  `            Assert.Equal(${csString(ANONYMOUS_PREFIX)} + otra.${id}, other?.${csMember(field.name)});`
                ]
              : [`            Assert.Null(after?.${csMember(field.name)});`]
          );
          const refs = new Set();
          fact('RT-2', 'AnonymizeVaciaLosOpcionalesYSustituyeLosObligatorios', [
            ...fresh('vencida', refs, { [fromMember]: ago(span.days + 1) }),
            ...fresh('otra', refs, { [fromMember]: ago(span.days + 2) }),
            tick,
            `            var after = ${get(`FindById(vencida.${id}, Cancel)`)};`,
            `            var other = ${get(`FindById(otra.${id}, Cancel)`)};`,
            ...checks
          ], refs);
        }
      }
    }

    const personal = document ? [] : personalUniques(model, entity);
    if (personal.length > 0) {
      const finder = personal[0];
      const value = csString(`pd2-${name.toLowerCase()}@valor.personal`);
      const refs = new Set();
      const first = fresh('primera', refs, { [csMember(finder.field)]: value });
      const second = fresh('segunda', refs, { [csMember(finder.field)]: value });
      fact('PD-2', `UnaUnicidadVioladaNoLlevaElValorAlLog`, [
        ...first,
        second[0],
        '            LifecycleLogs.Lines.Clear();',
        `            await Assert.ThrowsAnyAsync<Exception>(() => ${second[1].trim().replace(/^await /, '').replace(/;$/, '')});`,
        '            // La sonda mide: EF escribe en el log que capturamos (las sentencias ejecutadas, sin sus parámetros).',
        '            Assert.NotEmpty(LifecycleLogs.Lines);',
        `            Assert.DoesNotContain(LifecycleLogs.Lines, line => line.Contains(${value}, StringComparison.Ordinal));`
      ], refs);
    }
  }

  // RT-3: dos réplicas, un barrido (el R1 de la 2.26), con la forma de la sonda de las purgas.
  const retained = probes.filter(({ root }) => root.retention);
  for (const { entity } of retained) {
    const kind = `TimerKinds.${retentionKindConstant(entity.name)}`;
    let clear;
    let fire;
    if (document) {
      clear = '            await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").DeleteManyAsync(new BsonDocument(), Cancel);';
      fire = `            var now = await InScope(services => services.GetRequiredService<ITimerStore>().DbNow(Cancel));
            await root.GetRequiredService<DocumentDatabase>().Collection("keel_timer").UpdateManyAsync(
                new BsonDocument("kind", ${kind}),
                new BsonDocument("$set", new BsonDocument { { "due_at", new BsonDateTime(now.UtcDateTime) }, { "claimed_until", BsonNull.Value }, { "claim_token", BsonNull.Value } }),
                cancellationToken: Cancel);`;
    } else {
      const context = dbContextClass(model);
      clear = `            await InScope(async services => await services.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync("DELETE FROM ${KEEL_TIMER.table}", Cancel));`;
      fire = `            await InScope(async services => await services.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(timerStatements(engine).fire.replace(':kind', '{0}'))}, [${kind}], Cancel));`;
    }
    tests.push(`    /// <summary>RT-3: con dos réplicas sondeando, cada tick de la retención de ${entity.name} lo barre una sola.</summary>
    [Fact]
    public async Task ${entity.name}_RT3_ConDosReplicasCadaTickLoBarreUna()
    {
        RetentionCount.Ticks.Clear();
${clear.replace(/^ {12}/gm, '        ')}
        var a = LcReplica();
        var b = LcReplica();
        await a.EnsureRecurring(Cancel);
        await b.EnsureRecurring(Cancel);
${fire.replace(/^ {12}/gm, '        ')}
        await a.PollOnce(Cancel);
        await b.PollOnce(Cancel);
        Assert.Equal(1, RetentionCount.Ticks.GetValueOrDefault(${kind}));
${clear.replace(/^ {12}/gm, '        ')}
    }`);
  }

  const shared = [
    '    // ═══ El ciclo de vida del dato (DSL 2.28) ═══',
    '',
    '    /// <summary>Una operación del puerto en su propio ámbito (una petición): sin el contexto de EF de la prueba.</summary>',
    '    private static Task Lc<TPort>(Func<TPort, Task> work) where TPort : notnull => InScope(services => work(services.GetRequiredService<TPort>()));',
    '',
    '    private static Task<T> LcRead<TPort, T>(Func<TPort, Task<T>> work) where TPort : notnull => InScope(services => work(services.GetRequiredService<TPort>()));',
    ...(document
      ? ['', '    /// <summary>Un id como lo guarda el documento (el uuid binario subtipo 4, o su número).</summary>', '    private static BsonValue LcId(object id) => id switch { Guid guid => BsonValues.Of(guid), long number => BsonValues.Of(number), int number => BsonValues.Of(number), _ => BsonValues.Of(id.ToString()) };']
      : []),
    ...(retained.length > 0
      ? ['', '    /// <summary>Una réplica: un sondeador propio sobre la misma base, como un proceso aparte.</summary>', '    private static TimerPoller LcReplica() =>', '        new(root.GetRequiredService<IServiceScopeFactory>(), new TimerSettings(true, 30_000, 50, 60_000, 10, 0, 7, "0 30 5 * * *"), root.GetRequiredService<TimerWakeup>(), TimeProvider.System, NullLogger<TimerPoller>.Instance);']
      : [])
  ];
  const methods = [...shared, '', helpers.join('\n\n'), '', tests.join('\n\n')].join('\n');

  const classes = [];
  if (retained.length > 0) {
    classes.push(`/// <summary>Un recurrente de la sonda que ejecuta el de verdad y cuenta sus ticks por kind (RT-3).</summary>
public sealed class RetentionCount(IRecurringTimerHandler inner) : IRecurringTimerHandler
{
    public static ConcurrentDictionary<string, int> Ticks { get; } = new(StringComparer.Ordinal);

    public string Kind => inner.Kind;

    public string Spec => inner.Spec;

    public async Task Tick(CancellationToken cancellationToken)
    {
        await inner.Tick(cancellationToken);
        Ticks.AddOrUpdate(inner.Kind, 1, (_, ticks) => ticks + 1);
    }
}`);
  }
  if (retained.some(({ entity }) => retentionCaches(model, entity.name).length > 0)) {
    classes.push(`/// <summary>La caché de las lecturas, doblada: el recurrente de la retención la vacía tras barrer (T5), y aquí no hay Redis.</summary>
public sealed class LcNoCache : IOperationCache
{
    public Task<T> GetOrLoad<T, TMessage>(CachedOperation<T, TMessage> cache, TMessage message, Func<CancellationToken, Task<T>> load, CacheLoadOptions<T>? options = null, CancellationToken cancellationToken = default) =>
        load(cancellationToken);

    public Task Evict(ICachedOperation cache, string key, CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task Clear(ICachedOperation cache, CancellationToken cancellationToken = default) => Task.CompletedTask;
}`);
  }
  if (!document && lifecycleCases(model, { document }).includes('PD-2')) {
    classes.push(`/// <summary>Lo que escribe la persistencia en el log, con la excepción entera (PD-2): ahí viaja el mensaje del motor.</summary>
public sealed class LifecycleLogs : ILoggerProvider
{
    public static LifecycleLogs Provider { get; } = new();

    public static ConcurrentQueue<string> Lines { get; } = new();

    public ILogger CreateLogger(string categoryName) => new Sink(categoryName);

    public void Dispose()
    {
    }

    private sealed class Sink(string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Enqueue($"{logLevel} {category}: {formatter(state, exception)} {exception}");
    }
}`);
  }
  return { methods, classes: classes.join('\n\n') };
}
