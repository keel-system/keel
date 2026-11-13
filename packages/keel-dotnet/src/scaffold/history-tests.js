// La prueba emitida `HistorySupportTests` (DSL 2.29): el diff, la reescritura de lo personal y el id de la entrada que emite
// history.js, EJECUTADOS en `dotnet test` contra las referencias de keel-core (historyDiff, anonymizeHistoryChanges,
// anonymizedEntryChanges), como keel-nest los ejecuta transpilando su TypeScript (test/history-parity.test.js). Los casos se
// calculan aquí con keel-core y viajan como DATOS: la prueba no reimplementa nada, compara texto del cable.
//
// La forma es sintética y no la de una raíz del diseño: lo que se mide es el código de HistorySupport, que no depende de la
// raíz (la instantánea por raíz la miden HI-2 y HI-3 en db-check y doc-check).

import { usesHistory, historyDiff, historyPersonalPatterns, anonymizeHistoryChanges, anonymizedEntryChanges } from '@keel-system/keel-core/gen/history';
import { csFile, csString, csVerbatim, namespaceOf, solution } from './render.js';

const SHAPE = Object.freeze({
  paths: ['title', 'status', 'labels', 'price.amount'],
  personal: [
    { path: 'email', required: false },
    { path: 'subject', required: true }
  ],
  children: [{ relation: 'revisions', idField: 'id', list: true, paths: ['revisionNumber', 'note'], personal: [{ path: 'note', required: false }] }]
});

const BEFORE = { title: 'uno', status: 'draft', labels: ['a'], price: { amount: '19.90' }, revisions: [{ id: 'r1', revisionNumber: 1, note: null }, { id: 'r2', revisionNumber: 2, note: 'x' }] };
const AFTER = { title: 'dos', status: 'draft', labels: ['a', 'b'], price: { amount: '19.95' }, revisions: [{ id: 'r1', revisionNumber: 1, note: 'nota' }, { id: 'r3', revisionNumber: 3, note: null }] };

/** La instantánea como la arma el adaptador: ruta del contrato → texto del cable. */
function snapshot(object) {
  const map = [];
  const at = (value, path) => path.split('.').reduce((current, segment) => (current == null ? null : current[segment]), value) ?? null;
  for (const path of SHAPE.paths) map.push([path, JSON.stringify(at(object, path))]);
  for (const child of SHAPE.children) {
    for (const item of object[child.relation] ?? []) for (const path of child.paths) map.push([`${child.relation}[${item.id}].${path}`, JSON.stringify(at(item, path))]);
  }
  return map;
}

const dictionary = (entries) =>
  `new Dictionary<string, string>(StringComparer.Ordinal) { ${entries.map(([key, value]) => `[${csString(key)}] = ${csString(value)}`).join(', ')} }`;

const ENTRIES = [
  [{ field: 'subject', before: null, after: 's-1' }, { field: 'email', before: null, after: 'a@x.com' }, { field: 'title', before: null, after: 'Ana' }],
  [{ field: 'email', before: 'a@x.com', after: 'b@x.com' }, { field: 'revisions[r1].note', before: null, after: 'nota' }],
  [{ field: 'title', before: 'Ana', after: 'Eva' }]
];

export function generate(model) {
  if (!model.layersPresent?.persistence || !usesHistory(model)) return [];
  const sln = solution(model);
  const patterns = historyPersonalPatterns(SHAPE);
  const personal = `[${patterns.map(({ pattern, required }) => `new PersonalPath(new Regex(${csVerbatim(pattern)}, RegexOptions.CultureInvariant), ${required})`).join(', ')}]`;
  const anonymized = ENTRIES.map((changes, index) => {
    const reference = anonymizeHistoryChanges(changes, patterns, 'r-1');
    return `    [Fact]
    public void LaAnonimizacionDeLaEntrada${index + 1}EsLaDeKeelCore()
    {
        var (changes, touched) = HistorySupport.Anonymize(HistorySupport.ReadChanges(${csString(JSON.stringify(changes))}), Personal, "r-1");
        Assert.Equal(${csString(JSON.stringify(reference.changes))}, HistorySupport.WriteChanges(changes));
        Assert.${reference.touched ? 'True' : 'False'}(touched);
    }`;
  });
  const body = `/// <summary>
/// El diff, la reescritura de lo personal y el id de la entrada del historial (DSL 2.29), ejecutados contra las referencias de
/// keel-core: los resultados esperados los calculó build con historyDiff, anonymizeHistoryChanges y anonymizedEntryChanges.
/// </summary>
public sealed class HistorySupportTests
{
    private static readonly IReadOnlyList<PersonalPath> Personal = ${personal};

    [Fact]
    public void ElDiffDeUnCambioEsElDeKeelCore() =>
        Assert.Equal(
            ${csString(JSON.stringify(historyDiff(SHAPE, BEFORE, AFTER)))},
            HistorySupport.WriteChanges(HistorySupport.Diff(${dictionary(snapshot(BEFORE))}, ${dictionary(snapshot(AFTER))})));

    [Fact]
    public void ElDiffDeUnAltaEsElDeKeelCore() =>
        Assert.Equal(${csString(JSON.stringify(historyDiff(SHAPE, null, AFTER)))}, HistorySupport.WriteChanges(HistorySupport.Diff(null, ${dictionary(snapshot(AFTER))})));

    [Fact]
    public void UnGuardadoSinCambiosNoTieneDiff() => Assert.Empty(HistorySupport.Diff(${dictionary(snapshot(AFTER))}, ${dictionary(snapshot(AFTER))}));

${anonymized.join('\n\n')}

    [Fact]
    public void LaEntradaAnonymizedEsLaDeKeelCore()
    {
        var entries = new[] { ${ENTRIES.map((changes) => `HistorySupport.ReadChanges(${csString(JSON.stringify(changes))})`).join(', ')} };
        Assert.Equal(${csString(JSON.stringify(anonymizedEntryChanges(ENTRIES, patterns, 'r-1')))}, HistorySupport.WriteChanges(HistorySupport.AnonymizedEntryChanges(entries, Personal, "r-1")));
    }

    [Fact]
    public void ElIdDeLaEntradaCreceTambienDentroDelMismoMilisegundo()
    {
        var previous = HistorySupport.NextId().ToString("D");
        for (var index = 0; index < 10_000; index++)
        {
            var next = HistorySupport.NextId().ToString("D");
            Assert.True(string.CompareOrdinal(next, previous) > 0, $"{next} no es mayor que {previous}");
            previous = next;
        }
    }
}`;
  const usings = ['System.Text.RegularExpressions', 'Xunit', namespaceOf(model, 'historyInfra')];
  return [{ path: `${sln.unitTests.dir}/HistorySupportTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) }];
}
