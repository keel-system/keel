// El FINDER de una búsqueda (DSL 2.22) en TypeScript: la interfaz de sus filtros junto al puerto, el método abstracto
// y el del adaptador, relacional (el `where` de TypeORM con sus operadores) y documental (el filtro del driver). Qué
// restringe cada input lo decide keel-core/gen/query-filters.js, el mismo para los tres generadores: aquí solo se
// escribe. Los nombres son los de keel-dotnet en camelCase: la misma API sobre otro lenguaje.

import { findersOf, RANGE_OPERATORS } from 'keel-core/gen';
import { persistedMembers } from 'keel-core/gen/relational';
import { screamingSnake } from 'keel-core/gen/naming';
import { classPath, DIRS, fieldImports, tsString } from './render.js';

export const entityFinders = (model, entity) => findersOf(model, entity.name);
export const hasFilter = (finder) => finder.criteria.length > 0;
const sortConstant = (finder) => `${screamingSnake(finder.method)}_SORT`;

export function finderSignature(finder, entity) {
  const params = [hasFilter(finder) ? `filter: ${finder.filterType}` : null, finder.result === 'page' ? 'pageable: Pageable' : null].filter(Boolean);
  const result = finder.result === 'page' ? `Page<${entity.name}>` : `${entity.name}[]`;
  return `${finder.method}(${params.join(', ')}): Promise<${result}>`;
}

const OPERATOR_DOC = { eq: 'igual a', gt: 'mayor que', gte: 'mayor o igual que', lt: 'menor que', lte: 'menor o igual que' };
function criterionDoc(criterion) {
  const subject = criterion.target.kind === 'relation' ? `el id de ${criterion.target.path}` : criterion.target.path;
  const folding = criterion.compare === 'ignore-case-accents' ? ', sin mayúsculas ni acentos' : criterion.compare === 'ignore-case' ? ', sin mayúsculas' : '';
  if (criterion.match === 'contains') return `${subject} lo contiene${folding}`;
  if (criterion.match === 'prefix') return `${subject} empieza por él${folding}`;
  return `${subject} ${OPERATOR_DOC[criterion.op]} él${folding}`;
}

/** Las interfaces de los filtros y las firmas abstractas, para el archivo del puerto. */
export function portFinderParts(model, entity, imports) {
  const finders = entityFinders(model, entity);
  const declarations = [];
  const methods = [];
  for (const finder of finders) {
    if (hasFilter(finder)) {
      for (const criterion of finder.criteria) imports.push(...fieldImports(model, criterion.input));
      declarations.push(`/**
 * Los filtros de ${finder.operation}, como los declara el diseño (DSL 2.22). Un filtro opcional a null no restringe.
${finder.criteria.map((criterion) => ` * ${criterion.name}: ${criterionDoc(criterion)}.`).join('\n')}
 */
export interface ${finder.filterType} {
${finder.criteria.map((criterion) => `  readonly ${criterion.name}: ${criterion.input.tsType}${criterion.required ? '' : ' | null'};`).join('\n')}
}`);
    }
    methods.push(
      `  /** La búsqueda de ${finder.operation} con los filtros del diseño y solo esos${finder.fixed.length > 0 ? ` (siempre: ${finder.fixed.map((entry) => `${entry.name} = ${entry.value}`).join(', ')})` : ''}. ${finder.result === 'page' ? 'Una página, en el orden pedido' : 'Todas, en el orden del diseño'} y con el id como desempate. */\n` +
        `  abstract ${finderSignature(finder, entity)};`
    );
  }
  return { declarations, methods };
}

/** El valor fijo de un `where`: la constante del enum, el booleano o el literal. */
function fixedValue(entry, imports) {
  if (entry.field.kind === 'enum') {
    imports.push({ symbol: entry.field.namedType, from: classPath(DIRS.enums, entry.field.namedType) });
    return `${entry.field.namedType}.${screamingSnake(String(entry.value))}`;
  }
  return typeof entry.value === 'string' ? tsString(entry.value) : String(entry.value);
}

/** La propiedad de la entidad ORM que restringe un criterio. */
function ormProperty(model, entity, criterion) {
  const { target } = criterion;
  if (criterion.shadow) return criterion.shadow.name;
  if (target.kind === 'relation') return `${target.relation.name}Id`;
  if (target.kind === 'vo') {
    const member = persistedMembers(model, entity).find((candidate) => candidate.kind === 'vo' && candidate.name === target.field.name);
    return member?.subs.find((candidate) => candidate.voAccessor === target.sub.name)?.name ?? `${target.field.name}${target.sub.name[0].toUpperCase()}${target.sub.name.slice(1)}`;
  }
  return target.field.name;
}

const TYPEORM_OPERATOR = { eq: 'Equal', gt: 'MoreThan', gte: 'MoreThanOrEqual', lt: 'LessThan', lte: 'LessThanOrEqual' };

/** El valor buscado ya plegado: la MISMA función que estampa la sombra al guardar. */
function prepared(criterion, value, imports, textFold) {
  if (!criterion.shadow) return value;
  imports.push({ symbol: 'TextFold', from: textFold });
  return `TextFold.${criterion.shadow.accents ? 'foldCaseAndAccents' : 'foldCase'}(${value})`;
}

/** Los métodos del adaptador relacional. Usan RELATIONS, withStableOrder y toDomain<Raíz> del propio adaptador. */
export function relationalFinderMethods(model, entity, imports, { ormClass, hasRelations, textFold, likePattern }) {
  const finders = entityFinders(model, entity);
  if (finders.length === 0) return [];
  imports.push({ symbol: 'And', from: 'typeorm' }, { symbol: 'FindOperator', from: 'typeorm', type: true }, { symbol: 'FindOptionsWhere', from: 'typeorm', type: true });
  return finders.map((finder) => {
    const lines = [];
    for (const entry of finder.fixed) {
      imports.push({ symbol: 'Equal', from: 'typeorm' });
      lines.push(`    and(${tsString(entry.name)}, Equal(${fixedValue(entry, imports)}));`);
    }
    for (const criterion of finder.criteria) {
      const value = prepared(criterion, `filter.${criterion.name}`, imports, textFold);
      let condition;
      if (criterion.match !== 'exact') {
        // El texto buscado es LITERAL: LikePattern lo escapa (el Like() de TypeORM no escribe cláusula ESCAPE).
        imports.push({ symbol: 'Like', from: 'typeorm' }, { symbol: 'LikePattern', from: likePattern });
        condition = `Like(LikePattern.${criterion.match}(${value}))`;
      } else {
        imports.push({ symbol: TYPEORM_OPERATOR[criterion.op], from: 'typeorm' });
        condition = `${TYPEORM_OPERATOR[criterion.op]}(${value})`;
      }
      const statement = `and(${tsString(ormProperty(model, entity, criterion))}, ${condition});`;
      lines.push(criterion.required ? `    ${statement}` : `    if (filter.${criterion.name} != null) ${statement}`);
    }
    const order = finder.result === 'page' ? 'withStableOrder(pageable)' : `withStableOrder({ page: 0, size: 0, sort: ${sortConstant(finder)} })`;
    const options = `{
      where: where as FindOptionsWhere<${ormClass}>,
      ${hasRelations ? 'relations: RELATIONS,\n      ' : ''}order: ${order}${finder.result === 'page' ? ',\n      skip: pageable.page * pageable.size,\n      take: pageable.size' : ''}
    }`;
    const tail =
      finder.result === 'page'
        ? `    const [rows, total] = await this.manager.findAndCount(${ormClass}, ${options});
    return {
      items: rows.map(toDomain${entity.name}),
      page: pageable.page,
      size: pageable.size,
      totalElements: total,
      totalPages: Math.ceil(total / pageable.size)
    };`
        : `    const rows = await this.manager.find(${ormClass}, ${options});
    return rows.map(toDomain${entity.name});`;
    return `  async ${finderSignature(finder, entity)} {
    // Las condiciones del diseño por propiedad; dos sobre la misma (un rango) van juntas con And.
    // FindOperator<any>: los operadores de propiedades de tipos distintos conviven en el mismo where.
    const where: Record<string, FindOperator<any>> = {};
    const and = (property: string, condition: FindOperator<any>): void => {
      const prior = where[property];
      where[property] = prior == null ? condition : And(prior, condition);
    };
${lines.join('\n')}
${tail}
  }`;
  });
}

/** El orden fijo de cada finder de lista, como constante del módulo del adaptador (el de una página lo trae el Pageable). */
export function sortConstants(model, entity, imports, pageTs) {
  const lists = entityFinders(model, entity).filter((finder) => finder.result === 'list');
  if (lists.length > 0) imports.push({ symbol: 'SortOrder', from: pageTs, type: true });
  return lists
    .map(
      (finder) =>
        `/** El orden que declara ${finder.operation}. */\nconst ${sortConstant(finder)}: readonly SortOrder[] = [${finder.sort
          .map((criterion) => `{ property: ${tsString(criterion.property)}, direction: ${tsString(criterion.direction === 'desc' ? 'desc' : 'asc')} }`)
          .join(', ')}];\n\n`
    )
    .join('');
}

export { sortConstant };

/** La llamada que nombra la nota del handler. */
export function finderCall(finder) {
  const repository = `this.${finder.entity[0].toLowerCase()}${finder.entity.slice(1)}Repository`;
  const args = [];
  if (hasFilter(finder)) args.push(`{ ${finder.criteria.map((criterion) => `${criterion.name}: query.${criterion.name}`).join(', ')} }`);
  if (finder.result === 'page') args.push('query.pageable');
  return `await ${repository}.${finder.method}(${args.join(', ')})`;
}

export { RANGE_OPERATORS };
