// El FINDER de una búsqueda (DSL 2.22) en C#: el record de sus filtros en Domain/Repository, el método del puerto y
// el del adaptador, relacional (LINQ sobre la fila de EF Core) y documental (el filtro BSON del driver). Qué restringe
// cada input lo decide keel-core/gen/query-filters.js, el mismo para los tres generadores: aquí solo se escribe.

import { findersOf, RANGE_OPERATORS } from 'keel-core/gen';
import { persistedMembers } from 'keel-core/gen/relational';
import { memberOf } from './enums.js';
import { csFile, csLocal, csMember, csString, fieldUsings, located, namespaceOf, xmlDoc } from './render.js';
import { screamingSnake } from 'keel-core/gen/naming';

/** Los finders de la raíz, en el orden de las operaciones. */
export function entityFinders(model, entity) {
  return findersOf(model, entity.name);
}

export const methodName = (finder) => csMember(finder.method);
export const hasFilter = (finder) => finder.criteria.length > 0;

/** El tipo C# de un filtro en su record: siempre anulable salvo que el input sea obligatorio. */
function filterType(criterion) {
  const type = criterion.input.csType;
  return criterion.required || type.endsWith('?') ? type : `${type}?`;
}

/** Los records `<Op>Filter`, uno por finder con filtros del input. */
export function filterRecordFiles(model, entity) {
  return entityFinders(model, entity)
    .filter(hasFilter)
    .map((finder) => {
      const { namespace, path } = located(model, 'repositories', finder.filterType);
      const usings = finder.criteria.flatMap((criterion) => fieldUsings(model, criterion.input));
      const params = finder.criteria.map((criterion) => `${filterType(criterion)} ${csMember(criterion.name)}`);
      const body = `${xmlDoc([
        `Los filtros de ${finder.operation}, como los declara el diseño (DSL 2.22). Un filtro opcional a null no restringe.`,
        ...finder.criteria.map((criterion) => `${csMember(criterion.name)}: ${criterionDoc(criterion)}.`)
      ])}public sealed record ${finder.filterType}(${params.join(', ')});`;
      return { path, content: csFile({ namespace, usings: [...new Set(usings)], body }) };
    });
}

const OPERATOR_DOC = { eq: 'igual a', gt: 'mayor que', gte: 'mayor o igual que', lt: 'menor que', lte: 'menor o igual que' };

function criterionDoc(criterion) {
  const subject = criterion.target.kind === 'relation' ? `el id de ${criterion.target.path}` : criterion.target.path;
  const folding = criterion.compare === 'ignore-case-accents' ? ', sin mayúsculas ni acentos' : criterion.compare === 'ignore-case' ? ', sin mayúsculas' : '';
  if (criterion.match === 'contains') return `${subject} lo contiene${folding}`;
  if (criterion.match === 'prefix') return `${subject} empieza por él${folding}`;
  return `${subject} ${OPERATOR_DOC[criterion.op]} él${folding}`;
}

export function finderParameters(finder) {
  const params = hasFilter(finder) ? [`${finder.filterType} filter`] : [];
  if (finder.result === 'page') params.push('Pageable pageable');
  params.push('CancellationToken cancellationToken = default');
  return params.join(', ');
}

export const resultType = (finder, entity) => (finder.result === 'page' ? `Page<${entity.name}>` : `IReadOnlyList<${entity.name}>`);

/** Las firmas del puerto. */
export function portFinderMethods(model, entity) {
  return entityFinders(model, entity).map(
    (finder) =>
      `${xmlDoc(
        [
          `La búsqueda de ${finder.operation} con los filtros del diseño y solo esos${finder.fixed.length > 0 ? ` (siempre: ${finder.fixed.map((entry) => `${entry.name} = ${entry.value}`).join(', ')})` : ''}.`,
          finder.result === 'page' ? 'Una página, en el orden pedido y con el id como desempate.' : 'Todas, en el orden del diseño y con el id como desempate.'
        ],
        '    '
      )}    Task<${resultType(finder, entity)}> ${methodName(finder)}(${finderParameters(finder)});`
  );
}

/** El valor fijo de un `where` como expresión C#. */
export function fixedValue(model, field, value) {
  if (field.kind === 'enum') return `${field.csType.replace(/\?$/, '')}.${memberOf(model, field.csType.replace(/\?$/, ''), screamingSnake(String(value)))}`;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  return csString(String(value));
}

/** La propiedad de la fila que restringe un criterio (relacional). */
function rowProperty(model, entity, criterion) {
  const { target } = criterion;
  if (criterion.shadow) return csMember(criterion.shadow.name);
  if (target.kind === 'relation') return csMember(`${target.relation.name}Id`);
  if (target.kind === 'vo') {
    const member = persistedMembers(model, entity).find((candidate) => candidate.kind === 'vo' && candidate.name === target.field.name);
    const sub = member?.subs.find((candidate) => candidate.voAccessor === target.sub.name);
    return csMember(sub?.name ?? `${target.field.name}${target.sub.name[0].toUpperCase()}${target.sub.name.slice(1)}`);
  }
  return csMember(target.field.name);
}

const COMPARISON = { eq: '==', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const TIMESTAMP = (criterion) => (criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field)?.base === 'timestamp';

/** El cuerpo de las condiciones de un criterio: el valor ya preparado (plegado, en UTC) y su Where. */
function relationalCondition(model, entity, criterion) {
  const property = rowProperty(model, entity, criterion);
  const local = csLocal(criterion.name).replace(/^@/, '');
  const prepared = [];
  let value = local;
  // El valor plegado se calcula fuera de la expresión: EF traduce la comparación, no la llamada.
  if (criterion.shadow) {
    prepared.push(`var ${local}Folded = TextFold.${criterion.shadow.accents ? 'FoldCaseAndAccents' : 'FoldCase'}(${local});`);
    value = `${local}Folded`;
  }
  // timestamptz solo admite instantes en UTC: uno con otro desfase lo rechaza Npgsql al escribir el parámetro.
  if (TIMESTAMP(criterion)) {
    prepared.push(`var ${local}Utc = ${local}.ToUniversalTime();`);
    value = `${local}Utc`;
  }
  // El texto buscado es LITERAL: EF Core escapa el patrón de StartsWith y Contains con un parámetro.
  const predicate =
    criterion.match === 'contains'
      ? `r.${property}.Contains(${value})`
      : criterion.match === 'prefix'
        ? `r.${property}.StartsWith(${value})`
        : `r.${property} ${COMPARISON[criterion.op]} ${value}`;
  return { local, prepared, predicate };
}

function relationalFilterLines(model, entity, finder) {
  const lines = [];
  for (const criterion of finder.criteria) {
    const { local, prepared, predicate } = relationalCondition(model, entity, criterion);
    const member = `filter.${csMember(criterion.name)}`;
    if (criterion.required) {
      lines.push(`        var ${local} = ${member};`, ...prepared.map((line) => `        ${line}`), `        query = query.Where(r => ${predicate});`);
    } else {
      lines.push(`        if (${member} is { } ${local})`, '        {', ...prepared.map((line) => `            ${line}`), `            query = query.Where(r => ${predicate});`, '        }');
    }
  }
  return lines;
}

/** Los métodos del adaptador relacional. Usan Graph(), Ordered() y ToDomain() del propio adaptador. */
export function relationalFinderMethods(model, entity) {
  return entityFinders(model, entity).map((finder) => {
    const fixed = finder.fixed.map((entry) => `r.${csMember(entry.name)} == ${fixedValue(model, entry.field, entry.value)}`);
    const start = `        var query = Graph().AsNoTracking()${fixed.length > 0 ? `.Where(r => ${fixed.join(' && ')})` : ''};`;
    const guards = [hasFilter(finder) ? '        ArgumentNullException.ThrowIfNull(filter);' : null, finder.result === 'page' ? '        ArgumentNullException.ThrowIfNull(pageable);' : null].filter(Boolean);
    const tail =
      finder.result === 'page'
        ? [
            '        var total = await query.LongCountAsync(cancellationToken);',
            '        var offset = (int)Math.Min((long)pageable.Page * pageable.Size, int.MaxValue);',
            '        var rows = await Ordered(query, pageable.Sort).Skip(offset).Take(pageable.Size).ToListAsync(cancellationToken);',
            '        var pages = pageable.Size == 0 ? 1 : (int)Math.Ceiling(total / (double)pageable.Size);',
            `        return new Page<${entity.name}>([.. rows.Select(ToDomain)], pageable.Page, pageable.Size, total, pages);`
          ]
        : [
            `        var rows = await Ordered(query, ${defaultSortConstant(finder)}).ToListAsync(cancellationToken);`,
            '        return [.. rows.Select(ToDomain)];'
          ];
    return `    public async Task<${resultType(finder, entity)}> ${methodName(finder)}(${finderParameters(finder)})
    {
${[...guards, start, ...relationalFilterLines(model, entity, finder), ...tail].join('\n')}
    }`;
  });
}

/** El orden fijo de un finder de lista, como constante del adaptador (el de una página lo trae el Pageable). */
export function defaultSortConstant(finder) {
  return `${methodName(finder)}Sort`;
}

export function sortConstants(model, entity) {
  return entityFinders(model, entity)
    .filter((finder) => finder.result === 'list')
    .map(
      (finder) =>
        `    private static readonly IReadOnlyList<SortOrder> ${defaultSortConstant(finder)} = [${finder.sort
          // Calificado: en la rama documental MongoDB.Driver tiene también un SortDirection.
          .map((criterion) => `new SortOrder(${csString(criterion.property)}, ${namespaceOf(model, 'repositories')}.SortDirection.${criterion.direction === 'desc' ? 'Desc' : 'Asc'})`)
          .join(', ')}];`
    );
}

/** ¿Necesita el adaptador el bloque de orden (Sortable + Ordered)? Con cualquier finder, sí. */
export function needsOrdering(model, entity) {
  return entityFinders(model, entity).length > 0;
}

/** La llamada que nombra la nota del handler, en la grafía de C#. */
export function finderCall(model, finder) {
  const repository = `${finder.entity[0].toLowerCase()}${finder.entity.slice(1)}Repository`;
  const args = [];
  if (hasFilter(finder)) args.push(`new ${finder.filterType}(${finder.criteria.map((criterion) => `query.${csMember(criterion.name)}`).join(', ')})`);
  if (finder.result === 'page') args.push('query.Pageable');
  args.push('cancellationToken');
  return `await ${repository}.${methodName(finder)}(${args.join(', ')})`;
}

export function findersUsings(model) {
  return [namespaceOf(model, 'repositories')];
}

/** ¿Nombra algún finder de la raíz un valor de enum (en su where o en un filtro)? Entonces el adaptador usa su namespace. */
export function finderEnums(model, entity) {
  return entityFinders(model, entity).some((finder) => finder.fixed.some((entry) => entry.field.kind === 'enum') || finder.criteria.some((criterion) => criterion.input.kind === 'enum'));
}
