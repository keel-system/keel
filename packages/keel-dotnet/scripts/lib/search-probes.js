// Las sondas de la BÚSQUEDA de DSL 2.32 (in, ne, search y el ?sort= del cliente) para db-check y doc-check: los casos
// FS-* (keel-core/gen/query-filters.js) y SO-* (keel-core/gen/pagination.js) sobre el sujeto `catalog-search` y su gemelo
// documental (keel-core/test/helpers/finder-designs.js, SEARCH_DESIGNS), con los MISMOS ids que el finder-check de
// keel-spring y las sondas de keel-nest.
//
// Un [Fact] por caso, con el id en el nombre (`Search_FS3_…`), dentro de la clase de sondas. Los FS-* guardan las filas de
// FINDER_SEARCH_ROWS una sola vez por el ADAPTADOR emitido y llaman a su finder: lo que se mide es lo que emite build,
// también la collation del orden (FS-3 y FS-9 leen la página en el orden del diseño). Los SO-* llaman al
// PageableReading.Read emitido con lo que el endpoint le pasa a esa operación (el orden del diseño y su sortable).
//
// El sujeto solo ejecuta sus casos: FS-9 cuenta las filas de la tabla, y lo demás de product-catalog ya lo mide su sujeto.

import { FINDER_SABOTAGES, FINDER_SEARCH_CASES, FINDER_SEARCH_ROWS } from '@keel-system/keel-core/gen/query-filters';
import { SO_CASES, SO_SABOTAGES, pageableDefaults } from '@keel-system/keel-core/gen/pagination';
import { enumMember } from '../../src/lib/cs-projection.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { portClass, repositoriesNamespace } from '../../src/scaffold/repositories.js';
import { csMember, csString, entityPlace, namespaceOf, solution } from '../../src/scaffold/render.js';

/** La query del sujeto, sobre la que están escritos los casos. */
export const SUBJECT_OPERATION = 'searchCatalog';

const ADAPTER = 'Persistence/Repositories/';
const READING = 'Rest/PageableReading.cs';

/** Cada sabotaje del orden del cliente: `[dónde, texto, sustituto]`. Todos compilan: lo que se mide es la sonda. */
const so = {
  'so-open': [READING, '!sortable.TryGetValue(path, out var property)', '!(sortable.TryGetValue(path, out var property) || (property = path).Length > 0)'],
  'so-case': [READING, 'var direction = parts.Length > 1 ? parts[1] : "asc";', 'var direction = parts.Length > 1 ? parts[1].ToLowerInvariant() : "asc";'],
  'so-duplicate': [READING, ' || !seen.Add(path)', ' || !(seen.Add(path) || true)'],
  'so-append': [
    READING,
    'return new Pageable(page, size, sort ?? defaultSort);',
    'return new Pageable(page, size, sort is null ? defaultSort : [.. defaultSort.Where(order => !sort.Exists(asked => asked.Property == order.Property)), .. sort]);'
  ]
};

export const SEARCH_SABOTAGE_SPECS = {
  'finder-in': {
    relational: [ADAPTER, /query = query\.Where\(r => (\w+)\.Contains\(r\.(\w+)\)\)/g, 'query = query.Where(r => r.$2 == $1[0])'],
    document: [ADAPTER, /new BsonArray\((\w+)\.Select\(/g, 'new BsonArray($1.Take(1).Select(']
  },
  // La lista vacía de un `in` vuelve a restringir: el `IN ()` que vacía el listado cuando la lista no viene (FS-11).
  'finder-in-empty': {
    relational: [ADAPTER, /is \{ Count: > 0 \} (\w+)\)/g, 'is { } $1)'],
    document: [ADAPTER, /is \{ Count: > 0 \} (\w+)\)/g, 'is { } $1)']
  },
  'finder-ne-null': {
    relational: [ADAPTER, /r\.(\w+) == null \|\| r\.\1 != /g, 'r.$1 != null && r.$1 != '],
    document: [ADAPTER, /new BsonDocument\("\$ne", (BsonValues\.\w+\([^()]*\))\)/g, 'new BsonDocument("$nin", new BsonArray { BsonNull.Value, $1 })']
  },
  // Uno por modelo: en Mongo `%` y `_` no son comodines (FS-7 no ve nada) y el `.` sí (FS-10).
  'finder-search-literal': { relational: [ADAPTER, /r\.(\w+)\.Contains\((\w+Folded)\)/g, 'EF.Functions.Like(r.$1, "%" + $2 + "%")'] },
  'finder-search-regex': { document: [ADAPTER, /Regex\.Escape\((\w+Folded)\)/g, '$1'] },
  ...Object.fromEntries(Object.entries(so).map(([id, spec]) => [id, { relational: spec, document: spec }])),
  // La collation del orden (U7, D17): `name` vuelve a la de por defecto del motor. Solo se ve en MySQL, que ordena 'Ñandú'
  // junto a la N con utf8mb4_0900_ai_ci; PostgreSQL alpine compara bytes igualmente (B0, M11).
  'order-collation': { relational: ['Persistence/Rows/ProductRow.cs', /(row\.Property\(r => r\.Name\)\.HasColumnName\("name"\)\.HasMaxLength\(\d+\))\.UseCollation\("[^"]+"\)/g, '$1'] }
};

const BREAKS = Object.fromEntries([...Object.entries(FINDER_SABOTAGES), ...Object.entries(SO_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

export const isSearchSabotage = (id) => Boolean(SEARCH_SABOTAGE_SPECS[id]);

/** La query del sujeto si este modelo es el de los casos (su finder con una búsqueda libre y su sortable), o null. */
export function searchSubject(model) {
  const operation = (model.services ?? []).flatMap((group) => group.operations).find((candidate) => candidate.name === SUBJECT_OPERATION);
  return operation?.finder?.criteria.some((criterion) => criterion.op === 'search') && (operation.sortable ?? []).length > 0 ? operation : null;
}

/** Los casos que ejecuta el bloque de este diseño. */
export function searchCases(model) {
  return searchSubject(model) ? [...FINDER_SEARCH_CASES.map((entry) => entry.id), ...SO_CASES.map((entry) => entry.id)] : [];
}

/** Lo que tiene que caer con un sabotaje: sus casos, y solo esos (`order-collation`, solo en MySQL: en PostgreSQL, ninguno). */
export function searchSabotageVerdict(failures, id, model, { engine = null } = {}) {
  const cases = searchCases(model);
  const breaks = id === 'order-collation' ? (engine === 'mysql' ? ['FS-3', 'FS-9', 'FS-11'] : []) : BREAKS[id] ?? [];
  const want = breaks.filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/_(FS|SO)(\d+)_/g)].map((match) => `${match[1]}-${match[2]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** La referencia al proyecto de la API (PageableReading vive en Api/Rest), solo en el sujeto. */
export function searchProjectReference(model, { already = false } = {}) {
  if (!searchSubject(model) || already) return '';
  return `\n    <ProjectReference Include="..\\..\\${solution(model).api.csproj.replaceAll('/', '\\')}" />`;
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

const pascal = (text) => text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join('');

/**
 * Los [Fact] de los casos y lo que necesitan, o null si el modelo no es el del sujeto: `{ methods }`. `ctx` es el de la
 * clase de sondas (sus `refs` dan los `Ensure<Raíz>`); `sampleState` da el estado de muestra del que salen los miembros
 * que la fila no nombra.
 */
export function searchProbeBlock(model, ctx, { sampleState }) {
  const operation = searchSubject(model);
  if (!operation) return null;
  const root = model.entities.find((entity) => entity.name === operation.finder.entity);
  const status = root.fields.find((field) => field.name === 'status');
  const repositories = repositoriesNamespace(model);
  ctx.usings.push(
    'System.Globalization',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.Primitives',
    repositories,
    namespaceOf(model, 'rest'),
    namespaceOf(model, 'appSupport'),
    namespaceOf(model, 'enums'),
    namespaceOf(model, entityPlace(root))
  );
  const port = portClass(root);
  const idName = root.idField?.name ?? 'id';

  const refsBefore = new Set(ctx.refs);
  ctx.refs.clear();
  const baseState = sampleState(model, root, ctx, 'search');
  const refs = [...ctx.refs];
  for (const ref of refsBefore) ctx.refs.add(ref);
  const params = refs.map((ref) => `${model.entities.find((entity) => entity.name === ref)?.idField?.csType ?? 'Guid'} ${ref[0].toLowerCase()}${ref.slice(1)}Id`).join(', ');
  const args = refs.map((ref) => `await Ensure${ref}(services)`).join(', ');

  const statusOf = (literal) => `${status.namedType}.${enumMember(literal)}`;
  const row = (entry) => {
    const values = { [idName]: 'Guid.NewGuid()', sku: csString(entry.sku), name: csString(entry.name), notes: entry.notes === null ? 'null' : csString(entry.notes), status: statusOf(entry.status) };
    const lines = domainMembers(model, root).map((member) => `${csMember(member.name)} = ${values[member.name] ?? `product.${csMember(member.name)}`},`);
    if (root.usesOptimisticLocking && !root.declaresLockVersion) lines.push('LockVersion = null,');
    return `            await other.GetRequiredService<${port}>().Save(new ${root.name}(new ${root.name}State { ${lines.join(' ')} }), Cancel);`;
  };
  const { defaultSize, maxSize, defaultSort } = pageableDefaults(model, operation);
  const property = new Map([...defaultSort, ...operation.sortable].map((entry) => [entry.path, entry.property]));
  const direction = (dir) => `${repositories}.SortDirection.${dir === 'desc' ? 'Desc' : 'Asc'}`;
  const defaultSortExpr = `new SortOrder[] { ${defaultSort.map((entry) => `new SortOrder(${csString(entry.property)}, ${direction(entry.direction)})`).join(', ')} }`;
  const sortableExpr = (paths) => `new Dictionary<string, string> { ${paths.map((path) => `[${csString(path)}] = ${csString(property.get(path))}`).join(', ')} }`;

  const filterOf = (inputs) =>
    `new ${operation.finder.filterType}(${operation.finder.criteria
      .map((criterion) => {
        const value = inputs[criterion.name];
        if (value === undefined) return 'null';
        if (criterion.op === 'in') return `new ${status.namedType}[] { ${value.map(statusOf).join(', ')} }`;
        return csString(value);
      })
      .join(', ')})`;

  const finderFacts = FINDER_SEARCH_CASES.map(
    (entry) => `    /// <summary>${entry.id}: ${entry.what}.</summary>
    [Fact]
    public async Task Search_${entry.id.replace('-', '')}_${pascal(entry.what)}() =>
        await InScope(async services =>
        {
            await SeedSearch(services);
            var found = await Searched(services, ${filterOf(entry.inputs)});
            Assert.Equal(${csString(entry.expect.join(','))}, string.Join(',', found));
        });`
  );
  const sortFacts = SO_CASES.map((entry) => {
    const sortable = entry.sortable ?? operation.sortable.map((item) => item.path);
    const query =
      entry.values === null
        ? 'new QueryCollection()'
        : `new QueryCollection(new Dictionary<string, StringValues> { ["sort"] = new StringValues(new[] { ${entry.values.map(csString).join(', ')} }) })`;
    const read = `PageableReading.Read(${query}, defaultSize: ${defaultSize}, maxSize: ${maxSize}, defaultSort: ${defaultSortExpr}, sortable: ${sortableExpr(sortable)})`;
    const body =
      entry.expect === 400
        ? `Assert.Throws<InvalidSortException>(() => ${read});`
        : `var read = ${read};
        Assert.Equal(${csString(entry.expect.map(([path, dir]) => `${property.get(path)},${dir}`).join(';'))}, string.Join(';', read.Sort.Select(order => $"{order.Property},{(order.Direction == ${direction('desc')} ? "desc" : "asc")}")));`;
    return `    /// <summary>${entry.id}: ${entry.what}.</summary>
    [Fact]
    public void Search_${entry.id.replace('-', '')}_${pascal(entry.what)}()
    {
        ${body}
    }`;
  });

  const methods = `    // ─── La búsqueda de 2.32: FS-* (el finder) y SO-* (el ?sort= del cliente) ───

${[...finderFacts, ...sortFacts].join('\n\n')}

    private static bool searchSeeded;

    /** Las filas de los casos, una sola vez: la clase comparte la base y los [Fact] corren uno tras otro. */
    private static async Task SeedSearch(IServiceProvider services)
    {
        if (searchSeeded)
        {
            return;
        }
        var product = ${root.name}SearchBase(${args});
        await InScope(async other =>
        {
${FINDER_SEARCH_ROWS.map(row).join('\n')}
        });
        searchSeeded = true;
    }

    /** Los sku que devuelve el finder, en el orden del diseño (${defaultSort.map((entry) => `${entry.path}:${entry.direction}`).join(', ')} y el id de desempate), solo los de los casos. */
    private static async Task<List<string>> Searched(IServiceProvider services, ${operation.finder.filterType} filter)
    {
        string[] known = [${FINDER_SEARCH_ROWS.map((entry) => csString(entry.sku)).join(', ')}];
        var page = await InScope(other => other.GetRequiredService<${port}>().${csMember(operation.finder.method)}(filter, new Pageable(0, 100, ${defaultSortExpr}), Cancel));
        return [.. page.Items.Select(found => found.Sku.ToString(CultureInfo.InvariantCulture)).Where(sku => known.Contains(sku))];
    }

    private static ${root.name}State ${root.name}SearchBase(${params}) =>
        ${baseState};`;
  return { methods };
}
