// El HISTORIAL DE CAMBIOS (DSL 2.29) contra lo emitido, para db-check y doc-check: HI-1 a HI-10 de keel-core/gen/history.js,
// con los ids que ejecutan keel-spring (history-check) y keel-nest (scripts/lib/history-probes.js) sobre los MISMOS diseños
// (keel-core/test/helpers/history-designs.js). Habla con el puerto de la raíz, con el almacén del historial y con la
// retención y su recurrente; con la base cruda solo para lo que el puerto no enseña (retrasar un borrado, mover la hora de
// una entrada). Vale para los dos almacenes. HI-11 (logs y spans) no se mide aquí: es de telemetry-check, como PD-3.
//
// Un [Fact] por caso, con el id en el nombre (`ContactCard_HI6_…`), dentro de la clase de sondas de cada sujeto, como las del
// ciclo de vida (lifecycle-probes.js): comparte la base con el resto de sondas, así que NO vacía tablas como keel-nest. Cada
// caso siembra sus propias raíces y lee solo su historial (el de su id); HI-6 escribe por el almacén con una raíz inventada.
//
// Las etiquetas importan para el falsado, como en keel-spring y keel-nest: cada sabotaje tiene que caer en EXACTAMENTE sus
// casos. Por eso HI-6 no escribe por el adaptador sino por el almacén (un diff roto no puede tumbar el orden ni el filtro),
// HI-3 solo afirma que las rutas de las hijas ESTÁN y son las de su forma (el diff que lo lista todo es HI-2) y HI-4 mira la
// entrada del alta.

import { lifecycleRoots } from '@keel-system/keel-core/gen/data-lifecycle';
import { HISTORY_CASES, HISTORY_SABOTAGES } from '@keel-system/keel-core/gen/history';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { LOCK_VERSION } from '@keel-system/keel-core/gen/relational';
import { historyNamespace, historyInfraNamespace, historyReadsOf, recordsHistory, rootMember, CHANGE_HISTORY_CLASS } from '../../src/scaffold/history.js';
import { retentionClass, retentionTimerClass, retentionNamespace } from '../../src/scaffold/data-lifecycle.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { portClass } from '../../src/scaffold/repositories.js';
import { dbContextClass, rowClass } from '../../src/scaffold/persistence.js';
import { securityNamespace } from '../../src/scaffold/security.js';
import { timerNamespace } from '../../src/scaffold/timer.js';
import { csLocal, csMember, csString, namespaceOf } from '../../src/scaffold/render.js';
import { sampleState } from './db-probes.js';
import { cacheArg, retentionSettings } from './lifecycle-probes.js';

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const STORE = 'Persistence/History/ChangeHistory.cs';
const SUPPORT = 'Persistence/History/HistorySupport.cs';
const ADAPTER = 'Persistence/Repositories/';
const RETENTION = 'Persistence/Retention/';

/** La carga de D7 quitada: el historial se lee por el id que se pide, sin mirar si la ficha lo ve. */
const UNSCOPED = [
  ADAPTER,
  /var root = await \w+\((\w+)(?:, scope)?, cancellationToken\);\n\s+return root is null \? null : await changeHistory\.PageOf\(([^,]+), HistorySupport\.Key\(root\.\w+\)/g,
  'return await changeHistory.PageOf($2, HistorySupport.Key($1)'
];

/**
 * Lo que se busca y se sustituye en lo emitido, por sabotaje y por almacén: [sufijo del archivo, texto o expresión,
 * sustituto]. Rompen lo emitido CONSERVANDO LA FORMA (sigue compilando).
 */
export const HISTORY_SABOTAGE_SPECS = {
  // La entrada se escribe por OTRA conexión, fuera de la transacción: sobrevive a la escritura que revierte.
  'hi-outside-tx': {
    relational: [
      STORE,
      /await Execute\(Insert(Entry|Field)Sql, |(    private Task<int> Execute\()/g,
      (match, which, method) =>
        method
          ? `    private async Task<int> ExecuteOutside(string sql, Dictionary<string, object?> values, CancellationToken cancellationToken)
    {
        await using var other = (DbConnection)((ICloneable)db.Database.GetDbConnection()).Clone();
        await other.OpenAsync(cancellationToken);
        await using var command = Command(sql, values);
        command.Connection = other;
        command.Transaction = null;
        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

${method}`
          : `await ExecuteOutside(Insert${which}Sql, `
    ],
    document: [STORE, 'await Collection.InsertOneAsync(\n                    transactions.Session!,\n', 'await Collection.InsertOneAsync(\n']
  },
  // Una actualización registra la instantánea entera, cambie o no.
  'hi-full-snapshot': {
    relational: [SUPPORT, 'if (!string.Equals(was, now, StringComparison.Ordinal))', 'if (!string.Equals(was, now, StringComparison.Ordinal) || before is not null)'],
    document: [SUPPORT, 'if (!string.Equals(was, now, StringComparison.Ordinal))', 'if (!string.Equals(was, now, StringComparison.Ordinal) || before is not null)']
  },
  // La instantánea guarda el id, que el historial no registra (D4).
  'hi-sensitive': {
    relational: [ADAPTER, /(var snapshot = new Dictionary<string, string>\(StringComparer\.Ordinal\)\n {8}\{)/g, '$1\n            ["id"] = HistorySupport.WireText(entity.Id),'],
    document: [ADAPTER, /(var snapshot = new Dictionary<string, string>\(StringComparer\.Ordinal\)\n {8}\{)/g, '$1\n            ["id"] = HistorySupport.WireText(entity.Id),']
  },
  // El autor es siempre el centinela.
  'hi-author': {
    relational: [STORE, '["author"] = AuditActor.Current()', '["author"] = AuditActor.System'],
    document: [STORE, '{ "author", AuditActor.Current() }', '{ "author", AuditActor.System }']
  },
  // A igual instante desempata el id MENOR: el orden deja de ser estable de más reciente a más antiguo.
  'hi-order': {
    relational: [STORE, 'ORDER BY h.at DESC, h.id DESC', 'ORDER BY h.at DESC, h.id ASC'],
    document: [STORE, '{ { "at", -1 }, { "_id", -1 } }', '{ { "at", -1 }, { "_id", 1 } }']
  },
  // La lectura del historial no carga la raíz como su ficha: ve lo ajeno y lo borrado.
  'hi-unscoped': { relational: UNSCOPED, document: UNSCOPED },
  // La retención anonimiza la ficha y deja el historial como estaba.
  'hi-anonymize-miss': {
    relational: [RETENTION, /await scope\.ServiceProvider\.GetRequiredService<ChangeHistory>\(\)\.Anonymize\([^;]+;/g, '_ = scope.ServiceProvider.GetRequiredService<ChangeHistory>();'],
    document: [RETENTION, /await scope\.ServiceProvider\.GetRequiredService<ChangeHistory>\(\)\.Anonymize\([^;]+;/g, '_ = scope.ServiceProvider.GetRequiredService<ChangeHistory>();']
  },
  // La purga de lo borrado se deja el historial.
  'hi-purge-miss': {
    relational: [RETENTION, /await scope\.ServiceProvider\.GetRequiredService<ChangeHistory>\(\)\.Purge\([^;]+;/g, '_ = scope.ServiceProvider.GetRequiredService<ChangeHistory>();'],
    document: [RETENTION, /await scope\.ServiceProvider\.GetRequiredService<ChangeHistory>\(\)\.Purge\([^;]+;/g, '_ = scope.ServiceProvider.GetRequiredService<ChangeHistory>();']
  }
};

export const isHistorySabotage = (id) => Boolean(HISTORY_SABOTAGE_SPECS[id]);

/** Los sujetos por almacén: los de history-designs.js. */
export const HISTORY_SUBJECTS = {
  relational: ['cards-history', 'cards-history-anonymize', 'vault-history-scoped'],
  document: ['cards-history-mongo', 'cards-history-anonymize-mongo', 'vault-history-scoped-mongo']
};

// ─── Lo que se mide de cada diseño ───────────────────────────────────────────────────────────────────────────────

/** Lo que las sondas necesitan de cada raíz con historial, como keel-spring y keel-nest. */
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

/** Los casos que ejecuta el bloque de este diseño (los mismos que keel-spring y keel-nest: history-parity.test.js lo compara). */
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

/** Lo que tiene que caer con un sabotaje en este diseño. `failures` son las líneas de `dotnet test` del proyecto del sujeto. */
export function historySabotageVerdict(failures, id, model) {
  const cases = historyCases(model);
  const want = HISTORY_SABOTAGES[id].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/_HI(\d+)_/g)].map((match) => `HI-${match[1]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

export function historyProbeUsings(model, { document }) {
  if (probedRoots(model).length === 0) return [];
  const retention = probedRoots(model).some(({ lifecycle }) => lifecycle?.retention?.fromDeleted);
  return [
    'System.Text.Json',
    historyNamespace(model),
    historyInfraNamespace(model),
    securityNamespace(model),
    namespaceOf(model, 'repositories'),
    namespaceOf(model, 'persistence'),
    ...(document ? ['MongoDB.Bson', 'MongoDB.Driver'] : ['Microsoft.EntityFrameworkCore', namespaceOf(model, 'rows')]),
    ...(retention ? [retentionNamespace(model), timerNamespace(model)] : [])
  ];
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sustituye miembros del inicializador `<Entidad>State` que da sampleState, también los de varias líneas (la lista de
 * hijas): el miembro llega hasta la siguiente línea con su misma sangría. `overriding` de lifecycle-probes.js solo ve una.
 */
function overridingBlock(state, overrides) {
  const lines = state.split('\n');
  for (const [member, value] of Object.entries(overrides)) {
    const start = lines.findIndex((line) => new RegExp(`^\\s*${member} = `).test(line));
    if (start < 0) throw new Error(`history-probes: la muestra no tiene el miembro ${member}`);
    const pad = /^\s*/.exec(lines[start])[0];
    // El miembro termina en la línea donde se cierran sus paréntesis, corchetes y llaves (sin contar los de un texto).
    let depth = 0;
    let end = start;
    for (; end < lines.length; end += 1) {
      for (const char of lines[end].replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
        if ('([{'.includes(char)) depth += 1;
        else if (')]}'.includes(char)) depth -= 1;
      }
      if (depth === 0) break;
    }
    lines.splice(start, end - start + 1, `${pad}${member} = ${value},`);
  }
  return lines.join('\n');
}

/**
 * Los [Fact] del historial (van dentro de la clase de sondas, que declara `root`, `Cancel`, `InScope` y los `Ensure<Raíz>`).
 * `ctx` es el de las muestras de la clase: sus `refs` dan los Ensure. Devuelve el texto de los métodos, o null.
 */
export function historyProbeBlock(model, ctx, { document }) {
  const probes = probedRoots(model);
  if (probes.length === 0) return null;
  let salt = 0;
  const tests = [];
  const helpers = [];

  for (const probe of probes) {
    const { entity, lifecycle, reads, scoped, editable } = probe;
    const name = entity.name;
    const port = portClass(entity);
    const id = csMember(entity.idField?.name ?? 'id');
    const idType = entity.idField?.csType ?? 'Guid';
    const shape = entity.historyShape;
    const type = `${rootMember(entity)}.Type`;
    const key = (variable) => `HistorySupport.Key(${variable}.${id})`;
    const fact = (caseId, title, lines, refs) =>
      tests.push(`    [Fact]
    public async Task ${name}_${caseId.replace('-', '')}_${title}() =>
        await InScope(async services =>
        {
${[...[...refs].map((ref) => `            var ${csLocal(`${ref}Id`)} = await Ensure${ref}(services);`), ...lines].join('\n')}
        });`);
    // Una raíz nueva: la muestra con lo que se fuerce, guardada. `refs` recoge los Ensure que necesita.
    const state = (target, refs, overrides = {}) => {
      const inner = { usings: ctx.usings, refs: new Set(), unsampled: ctx.unsampled, counter: ctx.counter, document: ctx.document };
      const text = overridingBlock(sampleState(model, target, inner, `hi${salt++}`), overrides);
      for (const ref of inner.refs) {
        ctx.refs.add(ref);
        refs.add(ref);
      }
      return text.replace(/\n/g, '\n    ');
    };
    const build = (variable, refs, overrides = {}) => `            var ${variable} = new ${name}(${state(entity, refs, overrides)});`;
    const save = (variable, portName = port) => `            await Hi<${portName}>(port => port.Save(${variable}, Cancel));`;
    const fresh = (variable, refs, overrides = {}) => [build(variable, refs, overrides), save(variable)];
    // Una copia de lo que hay en el almacén con algunos miembros cambiados: así se actualiza con la versión vigente.
    const members = [...domainMembers(model, entity).map((member) => csMember(member.name)), ...(entity.usesOptimisticLocking && !entity.declaresLockVersion ? [csMember(LOCK_VERSION.field)] : [])];
    const update = (variable, overrides = {}) => {
      const current = `${variable}Actual${salt++}`;
      // Un sustituto puede ser una función de la variable con lo cargado (la lista de hijas más una).
      const value = (member) => (typeof overrides[member] === 'function' ? overrides[member](current) : overrides[member]);
      const assigns = members.map((member) => `${member} = ${value(member) ?? `${current}.${member}`}`);
      return [
        `            var ${current} = (await HiRead<${port}, ${name}?>(port => port.FindById(${variable}.${id}, Cancel)))!;`,
        `            await Hi<${port}>(port => port.Save(new ${name}(new ${name}State { ${assigns.join(', ')} }), Cancel));`
      ];
    };
    const edited = (text) => ({ [csMember(editable.name)]: csString(text) });
    const remove = (variable) => `            await Hi<${port}>(port => port.DeleteById(${variable}.${id}, Cancel));`;

    {
      const refs = new Set();
      fact('HI-1', 'AltaCambioYBajaDejanUnaEntradaCadaUnoEnSuTransaccion', [
        ...fresh('fila', refs),
        ...update('fila', edited(`hi1-${salt}`)),
        remove('fila'),
        `            Assert.Equal("deleted,updated,created", string.Join(",", await HiKinds(${type}, ${key('fila')})));`,
        build('revertida', refs),
        '            // Una escritura que revierte (la transacción del caso de uso) no deja entrada.',
        '            await Assert.ThrowsAsync<InvalidOperationException>(() => InScope(async other =>',
        '                await other.GetRequiredService<PersistenceTransactions>().InTransaction<bool>(',
        '                    async () =>',
        '                    {',
        `                        await other.GetRequiredService<${port}>().Save(revertida, Cancel);`,
        '                        throw new InvalidOperationException("revierte");',
        '                    },',
        '                    readOnly: false,',
        '                    Cancel)));',
        `            Assert.Empty(await HiEntries(${type}, ${key('revertida')}));`
      ], refs);
    }

    {
      const refs = new Set();
      const value = `hi2-${salt}`;
      fact('HI-2', 'SoloLoQueCambioConSuAntesYSuDespues', [
        ...fresh('fila', refs),
        ...update('fila'),
        '            // Un guardado sin cambios no escribe.',
        `            Assert.Equal("created", string.Join(",", await HiKinds(${type}, ${key('fila')})));`,
        `            var antes = HistorySupport.WireText((await HiRead<${port}, ${name}?>(port => port.FindById(fila.${id}, Cancel)))!.${csMember(editable.name)});`,
        ...update('fila', edited(value)),
        `            var last = (await HiEntries(${type}, ${key('fila')}))[0];`,
        `            Assert.Equal(${csString(editable.name)}, string.Join(",", last.Changes.Select(change => change.Field)));`,
        '            Assert.Equal(antes, last.Changes[0].Before.GetRawText());',
        `            Assert.Equal(HistorySupport.WireText(${csString(value)}), last.Changes[0].After.GetRawText());`
      ], refs);
    }

    const listChild = shape.children.find((candidate) => candidate.list);
    if (listChild) {
      const childEntity = model.entities.find((candidate) => candidate.name === listChild.entity);
      const childId = csMember(listChild.idField);
      const prefix = (variable) => `${csString(`${listChild.relation}[`)} + HistorySupport.Key(${variable}.${childId}) + "]."`;
      const known = `new[] { ${listChild.paths.map(csString).join(', ')} }`;
      const refs = new Set();
      const relation = csMember(listChild.relation);
      fact('HI-3', `${relation}AparecenConSuRuta`, [
        `            var primera = new ${listChild.entity}(${state(childEntity, refs)});`,
        ...fresh('fila', refs, { [relation]: '[primera]' }),
        `            var created = (await HiEntries(${type}, ${key('fila')}))[0].Changes.Select(change => change.Field).ToList();`,
        `            var ofFirst = created.Where(field => field.StartsWith(${prefix('primera')}, StringComparison.Ordinal)).ToList();`,
        '            // El alta lleva las rutas de la hija, y solo las de su forma.',
        '            Assert.NotEmpty(ofFirst);',
        `            Assert.All(ofFirst, field => Assert.Contains(field[(${prefix('primera')}).Length..], ${known}));`,
        `            var segunda = new ${listChild.entity}(${state(childEntity, refs)});`,
        ...update('fila', { [relation]: (current) => `[.. ${current}.${relation}, segunda]` }),
        `            var added = (await HiEntries(${type}, ${key('fila')}))[0].Changes.Where(change => change.Before.ValueKind == JsonValueKind.Null).Select(change => change.Field).ToList();`,
        `            var ofSecond = added.Where(field => field.StartsWith(${prefix('segunda')}, StringComparison.Ordinal)).ToList();`,
        '            Assert.NotEmpty(ofSecond);',
        `            Assert.All(ofSecond, field => Assert.Contains(field[(${prefix('segunda')}).Length..], ${known}));`
      ], refs);
    } else if (shape.paths.some((path) => path.includes('.'))) {
      const dotted = shape.paths.filter((path) => path.includes('.'));
      const refs = new Set();
      fact('HI-3', 'LosValueObjectsAparecenConSuRuta', [
        ...fresh('fila', refs),
        `            var created = (await HiEntries(${type}, ${key('fila')}))[0].Changes.Select(change => change.Field).ToList();`,
        `            Assert.Contains(created, field => new[] { ${dotted.map(csString).join(', ')} }.Contains(field));`
      ], refs);
    }

    {
      const excluded = [
        entity.idField?.name ?? 'id',
        ...entity.fields.filter((field) => field.sensitive || field.generated).map((field) => field.name),
        ...(entity.usesOptimisticLocking ? [LOCK_VERSION.field] : [])
      ];
      const refs = new Set();
      fact('HI-4', 'NiSensitiveNiGeneratedEntranEnElHistorial', [
        ...fresh('fila', refs),
        `            var recorded = (await HiEntries(${type}, ${key('fila')}))[0].Changes.Select(change => change.Field).ToList();`,
        '            // La sonda mide: el alta registró algo.',
        '            Assert.NotEmpty(recorded);',
        ...[...new Set(excluded)].map((field) => `            Assert.DoesNotContain(${csString(field)}, recorded);`)
      ], refs);
    }

    {
      const refs = new Set();
      fact('HI-5', 'ElAutorEsElSujetoDelTokenYFueraDeUnaPeticionElCentinela', [
        build('conToken', refs),
        '            using (SecurityContext.Open(new Principal(PrincipalKind.Token, "nombre-hi5", new HashSet<string>(), JsonSerializer.Deserialize<Dictionary<string, JsonElement>>("""{"sub":"sub-hi5"}""")!)))',
        '            {',
        `    ${save('conToken')}`,
        '            }',
        `            Assert.Equal("sub-hi5", (await HiEntries(${type}, ${key('conToken')}))[0].Author);`,
        ...fresh('sinToken', refs),
        `            var sistema = (await HiEntries(${type}, ${key('sinToken')}))[0].Author;`,
        '            Assert.True(sistema == "system" || sistema.StartsWith("system:", StringComparison.Ordinal), sistema);'
      ], refs);
    }

    fact('HI-6', 'LaPaginaVaDelMasRecienteConDesempateEstableYFiltra', [
      '            // Por el almacén: lo que se mide es su orden y sus filtros, no el diff del adaptador.',
      '            var root6 = "hi6-" + Guid.NewGuid().ToString("D");',
      '            var t0 = new DateTimeOffset(2026, 11, 13, 10, 0, 0, TimeSpan.Zero);',
      '            foreach (var path in new[] { "a.x", "b", "c", "d" })',
      '            {',
      `                await InScope(other => other.GetRequiredService<${CHANGE_HISTORY_CLASS}>().Record(${type}, root6, HistoryChanges.Updated, [new FieldChange(path, JsonSerializer.SerializeToElement<string?>(null), JsonSerializer.SerializeToElement(path))], Cancel));`,
      '            }',
      '            await HiSetAt(root6, "a.x", t0);',
      '            await HiSetAt(root6, "b", t0.AddMinutes(5));',
      '            await HiSetAt(root6, "c", t0.AddMinutes(5));',
      '            await HiSetAt(root6, "d", t0.AddMinutes(9));',
      `            async Task<string> Fields(HistoryFilter filter, int page, int size) => string.Join(",", (await HiPage(${type}, root6, filter, page, size)).Items.Select(entry => entry.Changes[0].Field));`,
      '            Assert.Equal("d,c,b,a.x", await Fields(HistoryFilter.None, 0, 10));',
      '            Assert.Equal("b,a.x", await Fields(HistoryFilter.None, 1, 2));',
      `            Assert.Equal(4, (await HiPage(${type}, root6, HistoryFilter.None, 0, 1)).TotalElements);`,
      '            Assert.Equal("a.x", await Fields(HistoryFilter.None with { Field = "a" }, 0, 10));',
      '            Assert.Equal("a.x", await Fields(HistoryFilter.None with { Field = "a.x" }, 0, 10));',
      '            Assert.Equal("", await Fields(HistoryFilter.None with { Field = "x" }, 0, 10));',
      '            var ranged = (await Fields(new HistoryFilter(null, t0.AddMinutes(5), t0.AddMinutes(9)), 0, 10)).Split(",").Order(StringComparer.Ordinal);',
      '            Assert.Equal("b,c,d", string.Join(",", ranged));'
    ], new Set());

    if (historyCases(model).includes('HI-7') && reads.length > 0) {
      const read = reads.find((candidate) => candidate.scoped) ?? reads[0];
      const refs = new Set();
      const body = [];
      let ownerOverrides = {};
      if (read.scoped && scoped) {
        const path = readScopePath(model, scoped.read);
        if (path.hops.length > 1) throw new Error(`history-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
        const hop = path.hops[0] ?? null;
        const field = csMember(scoped.read.field);
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `ReadScope.Within(new[] { ${value} })` : `ReadScope.OwnedBy(${value})`);
        const values = { a: csString(`hi-own-a-${salt}`), b: csString(`hi-own-b-${salt}`) };
        if (hop) {
          const target = hop.entity;
          const targetId = csMember(target.idField?.name ?? 'id');
          for (const tag of ['a', 'b']) {
            const variable = `owner${tag.toUpperCase()}`;
            body.push(`            var ${variable} = new ${target.name}(${state(target, refs, { [field]: values[tag] })});`, save(variable, portClass(target)));
          }
          ownerOverrides = { [csMember(`${hop.relation}Id`)]: `ownerA.${targetId}` };
          body.push(...fresh('propia', refs, ownerOverrides), ...fresh('ajena', refs, { [csMember(`${hop.relation}Id`)]: `ownerB.${targetId}` }));
        } else {
          ownerOverrides = { [field]: values.a };
          body.push(...fresh('propia', refs, ownerOverrides), ...fresh('ajena', refs, { [field]: values.b }));
        }
        body.push(`            var scope = ${scopeOf(values.a)};`);
        const call = (variable) => `port => port.${read.method}(${variable}.${csMember(read.param.name.replace(/^@/, ''))}, scope, HistoryFilter.None, new Pageable(0, 10, []), Cancel)`;
        body.push(
          `            Assert.NotNull(await HiRead<${port}, Page<HistoryEntry>?>(${call('propia')}));`,
          `            Assert.True(await HiMissed<${port}>(${call('ajena')}), "el historial de una raíz ajena no se ve");`
        );
      }
      if (lifecycle?.logical) {
        const call = (variable) => `port => port.${read.method}(${variable}.${csMember(read.param.name.replace(/^@/, ''))}${read.scoped ? ', scope' : ''}, HistoryFilter.None, new Pageable(0, 10, []), Cancel)`;
        if (!read.scoped) body.push(...fresh('propia', refs));
        body.push(
          ...fresh('borrada', refs, read.scoped ? ownerOverrides : {}),
          remove('borrada'),
          `            Assert.NotNull(await HiRead<${port}, Page<HistoryEntry>?>(${call('propia')}));`,
          `            Assert.True(await HiMissed<${port}>(${call('borrada')}), "el historial de una raíz borrada no se ve");`
        );
      }
      fact('HI-7', 'UnaRaizAjenaOBorradaDaElErrorDeSuLecturaPorId', body, refs);
    }

    if (lifecycle?.restore) {
      const refs = new Set();
      fact('HI-10', 'RestaurarDejaLaEntradaRestored', [
        ...fresh('fila', refs),
        remove('fila'),
        `            await Hi<${port}>(port => port.Restore(fila.${id}, Cancel));`,
        `            Assert.Equal("restored,deleted,created", string.Join(",", await HiKinds(${type}, ${key('fila')})));`
      ], refs);
    }

    if (lifecycle?.retention?.fromDeleted) {
      const span = lifecycle.retention.span;
      if (!span.days) throw new Error('history-probes: una retención que no es en días no tiene sujeto todavía');
      // Retrasar el borrado lógico más allá de la retención, por el almacén crudo: el puerto no lo enseña.
      if (document) {
        helpers.push(`    private static async Task HiBackdate${name}(object id, int days) =>
        await root.GetRequiredService<DocumentDatabase>().Collection(${csString(entity.collectionName)}).UpdateOneAsync(
            new BsonDocument("_id", id switch { Guid guid => BsonValues.Of(guid), long number => BsonValues.Of(number), _ => BsonValues.Of(id.ToString()) }),
            new BsonDocument("$set", new BsonDocument("deletedAt", BsonValues.Of(DateTimeOffset.UtcNow.AddDays(-days)))),
            cancellationToken: Cancel);`);
      } else {
        const row = rowClass(name);
        const context = dbContextClass(model);
        helpers.push(`    private static Task HiBackdate${name}(${idType} id, int days) =>
        InScope(async services =>
        {
            var db = services.GetRequiredService<${context}>();
            var row = await db.Set<${row}>().SingleAsync(r => r.${id} == id, Cancel);
            row.DeletedAt = DateTimeOffset.UtcNow.AddDays(-days);
            await db.SaveChangesAsync(Cancel);
        });`);
      }
      const gone = document
        ? `!await root.GetRequiredService<DocumentDatabase>().Collection(${csString(entity.collectionName)}).Find(new BsonDocument("_id", BsonValues.Of(fila.${id}))).AnyAsync(Cancel)`
        : `!await InScope(other => other.GetRequiredService<${dbContextClass(model)}>().Set<${rowClass(name)}>().AnyAsync(r => r.${id} == fila.${id}, Cancel))`;
      const refs = new Set();
      const expire = [
        ...fresh('fila', refs),
        ...update('fila', edited(`hi-ret-${salt}`)),
        remove('fila'),
        `            await HiBackdate${name}(fila.${id}, ${span.days + 1});`,
        `            await new ${retentionTimerClass(name)}(new ${retentionClass(name)}(root.GetRequiredService<IServiceScopeFactory>()), ${retentionSettings(model, 10)}${cacheArg(model, entity)}).Tick(Cancel);`
      ];
      if (lifecycle.retention.then === 'delete') {
        fact('HI-9', 'LaPurgaDeLoBorradoSeLlevaElHistorial', [
          ...expire,
          '            // La sonda mide: la retención purgó la fila.',
          `            Assert.True(${gone});`,
          `            Assert.Empty(await HiEntries(${type}, ${key('fila')}));`
        ], refs);
      } else {
        const personal = shape.personal.map(({ path, required }) => `[${csString(path)}] = ${required}`);
        fact('HI-8', 'AnonymizeReescribeLosPersonalesYDejaLaEntradaAnonymized', [
          ...expire,
          `            var all = await HiEntries(${type}, ${key('fila')});`,
          '            Assert.Equal("anonymized", all[0].Change);',
          `            var personal = new Dictionary<string, bool>(StringComparer.Ordinal) { ${personal.join(', ')} };`,
          `            var substitute = HistorySupport.WireText("anon-" + ${key('fila')});`,
          '            var seen = 0;',
          '            foreach (var entry in all)',
          '            {',
          '                foreach (var change in entry.Changes.Where(change => personal.ContainsKey(change.Field)))',
          '                {',
          '                    seen += 1;',
          '                    var expected = personal[change.Field] ? substitute : "null";',
          '                    Assert.Equal(expected, change.Before.GetRawText());',
          '                    Assert.Equal(expected, change.After.GetRawText());',
          '                }',
          '            }',
          '            // La sonda mide: el historial tenía algún campo personal.',
          '            Assert.True(seen > 0);'
        ], refs);
      }
    }
  }

  const setAt = document
    ? `await root.GetRequiredService<DocumentDatabase>().Collection("change_history").UpdateManyAsync(
            new BsonDocument { { "root_id", rootId }, { "fields.path", path } },
            new BsonDocument("$set", new BsonDocument("at", BsonValues.Of(at))),
            cancellationToken: Cancel);`
    : `await InScope(async services => await services.GetRequiredService<${dbContextClass(model)}>().Database.ExecuteSqlRawAsync(
            "UPDATE change_history SET at = {0} WHERE root_id = {1} AND id IN (SELECT entry_id FROM change_history_field WHERE path = {2})",
            [at.UtcDateTime, rootId, path],
            Cancel));`;
  const methods = [
    '    // ═══ El historial de cambios (DSL 2.29) ═══',
    '',
    '    /// <summary>Una operación del puerto en su propio ámbito (una petición).</summary>',
    '    private static Task Hi<TPort>(Func<TPort, Task> work) where TPort : notnull => InScope(services => work(services.GetRequiredService<TPort>()));',
    '',
    '    private static Task<T> HiRead<TPort, T>(Func<TPort, Task<T>> work) where TPort : notnull => InScope(services => work(services.GetRequiredService<TPort>()));',
    '',
    '    /// <summary>No lo ve: null, o el error de su lectura (readMiss: forbidden).</summary>',
    '    private static async Task<bool> HiMissed<TPort>(Func<TPort, Task<Page<HistoryEntry>?>> read) where TPort : notnull',
    '    {',
    '        try',
    '        {',
    '            return await HiRead(read) is null;',
    '        }',
    '        catch (DomainException)',
    '        {',
    '            return true;',
    '        }',
    '    }',
    '',
    `    private static Task<Page<HistoryEntry>> HiPage(string type, string rootId, HistoryFilter filter, int page, int size) =>`,
    `        InScope(services => services.GetRequiredService<${CHANGE_HISTORY_CLASS}>().PageOf(type, rootId, filter, new Pageable(page, size, []), Cancel));`,
    '',
    '    private static async Task<IReadOnlyList<HistoryEntry>> HiEntries(string type, string rootId) => (await HiPage(type, rootId, HistoryFilter.None, 0, 100)).Items;',
    '',
    '    private static async Task<IReadOnlyList<string>> HiKinds(string type, string rootId) => [.. (await HiEntries(type, rootId)).Select(entry => entry.Change)];',
    '',
    '    /// <summary>HI-6: mueve la hora de las entradas de una raíz que tocaron una ruta, para medir el orden y las fechas sin esperar.</summary>',
    '    private static async Task HiSetAt(string rootId, string path, DateTimeOffset at) =>',
    `        ${setAt}`,
    ...(helpers.length > 0 ? ['', helpers.join('\n\n')] : []),
    '',
    tests.join('\n\n')
  ].join('\n');
  return { methods };
}
