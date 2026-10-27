// El FINDER de una búsqueda (DSL 2.22) en Java: el record de sus filtros, anidado en el puerto, el método del puerto y
// el del adaptador, relacional (una Specification de JPA sobre el espejo) y documental (un Criteria de Spring Data
// MongoDB). Qué restringe cada input lo decide keel-core/gen/query-filters.js, el mismo para los tres generadores: aquí
// solo se escribe. Los nombres son los de keel-dotnet y keel-nest en la grafía de Java.

import { findersOf } from '@keel-system/keel-core/gen';
import { persistedMembers } from '@keel-system/keel-core/gen/relational';
import { screamingSnake } from '@keel-system/keel-core/gen/naming';
import { subPackage } from './render.js';
import { textFoldImport } from './text-fold.js';

export const entityFinders = (model, entity) => findersOf(model, entity.name);
const hasFilter = (finder) => finder.criteria.length > 0;
const pascal = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const sortConstant = (finder) => `${screamingSnake(finder.method)}_SORT`;

/** El tipo Java de un filtro (los records no admiten primitivos a null). */
const BOXED = { int: 'Integer', long: 'Long', boolean: 'Boolean', double: 'Double' };
const javaTypeOf = (field) => BOXED[field.javaType] ?? field.javaType;

function enumImport(model, field, imports) {
  if (field?.kind === 'enum' && field.namedType) imports.add(`${subPackage(model, 'domain.enums')}.${field.namedType}`);
}

function signature(finder, entity, qualify = '') {
  const params = [hasFilter(finder) ? `${qualify}${finder.filterType} filter` : null, finder.result === 'page' ? 'Pageable pageable' : null].filter(Boolean);
  return `${finder.result === 'page' ? `Page<${entity.name}>` : `List<${entity.name}>`} ${finder.method}(${params.join(', ')})`;
}

/** Los records de los filtros y las firmas, para la interfaz del puerto. */
export function portFinderMethods(model, entity, imports) {
  const methods = [];
  for (const finder of entityFinders(model, entity)) {
    imports.add(finder.result === 'page' ? 'org.springframework.data.domain.Page' : 'java.util.List');
    if (finder.result === 'page') imports.add('org.springframework.data.domain.Pageable');
    if (hasFilter(finder)) {
      for (const criterion of finder.criteria) {
        for (const name of criterion.input.imports ?? []) imports.add(name);
        enumImport(model, criterion.input, imports);
      }
      methods.push(`    /**
     * Los filtros de ${finder.operation}, como los declara el diseño (DSL 2.22). Un filtro a null no restringe.
     */
    record ${finder.filterType}(${finder.criteria.map((criterion) => `${javaTypeOf(criterion.input)} ${criterion.name}`).join(', ')}) {
    }`);
    }
    methods.push(
      `    /** La búsqueda de ${finder.operation} con los filtros del diseño y solo esos${finder.fixed.length > 0 ? ` (siempre: ${finder.fixed.map((entry) => `${entry.name} = ${entry.value}`).join(', ')})` : ''}. */\n    ${signature(finder, entity)};`
    );
  }
  return methods;
}

/** El valor fijo de un `where` como expresión Java. */
function fixedValue(model, entry, imports) {
  if (entry.field.kind === 'enum') {
    enumImport(model, entry.field, imports);
    return `${entry.field.namedType}.${screamingSnake(String(entry.value))}`;
  }
  return typeof entry.value === 'string' ? JSON.stringify(entry.value) : String(entry.value);
}

/** La propiedad del espejo (JPA o documento) que restringe un criterio. */
function mirrorProperty(model, entity, criterion, documental) {
  const { target } = criterion;
  if (criterion.shadow) return criterion.shadow.name;
  if (target.kind === 'relation') return `${target.relation.name}Id`;
  if (target.kind === 'vo') {
    if (documental) return `${target.field.name}.${target.sub.name}`;
    const member = persistedMembers(model, entity).find((candidate) => candidate.kind === 'vo' && candidate.name === target.field.name);
    return member?.subs.find((candidate) => candidate.voAccessor === target.sub.name)?.name ?? `${target.field.name}${pascal(target.sub.name)}`;
  }
  return target.field.name;
}

/** El valor buscado, plegado con la MISMA función que estampa la sombra al guardar. */
function prepared(model, criterion, value, imports) {
  if (!criterion.shadow) return value;
  imports.add(textFoldImport(model));
  return `TextFold.${criterion.shadow.accents ? 'foldCaseAndAccents' : 'foldCase'}(${value})`;
}

const JPA_OPERATOR = { eq: 'equal', gt: 'greaterThan', gte: 'greaterThanOrEqualTo', lt: 'lessThan', lte: 'lessThanOrEqualTo' };
const MONGO_OPERATOR = { eq: 'is', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' };

/** El tipo del valor que se compara (para los genéricos de los operadores de orden de JPA). */
function targetJavaType(criterion) {
  const { target } = criterion;
  if (target.kind === 'relation') return 'java.util.UUID';
  return javaTypeOf(target.kind === 'vo' ? target.sub : target.field);
}

/** Los métodos del adaptador relacional: una Specification por búsqueda, ejecutada por el JpaRepository. */
export function jpaFinderMethods(model, entity, imports, jpaField) {
  const finders = entityFinders(model, entity);
  if (finders.length === 0) return [];
  const mirror = `${entity.name}Jpa`;
  for (const name of ['org.springframework.data.jpa.domain.Specification', 'jakarta.persistence.criteria.Predicate', 'java.util.ArrayList', 'java.util.List', 'org.springframework.data.domain.Sort']) imports.add(name);
  return finders.map((finder) => {
    const lines = [];
    for (const entry of finder.fixed) lines.push(`            where.add(cb.equal(root.get("${entry.name}"), ${fixedValue(model, entry, imports)}));`);
    for (const criterion of finder.criteria) {
      const property = mirrorProperty(model, entity, criterion, false);
      const value = prepared(model, criterion, `filter.${criterion.name}()`, imports);
      let predicate;
      if (criterion.match !== 'exact') {
        // El texto buscado es LITERAL: se escapa con la barra, que la consulta declara como carácter de escape.
        predicate = `cb.like(root.<String>get("${property}"), likePattern(${value}, ${criterion.match === 'prefix'}), '\\\\')`;
      } else if (criterion.op === 'eq') {
        predicate = `cb.equal(root.get("${property}"), ${value})`;
      } else {
        // Los de orden son genéricos sobre Comparable: el tipo de la propiedad va explícito.
        const target = criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field;
        for (const name of target.imports ?? []) imports.add(name);
        predicate = `cb.${JPA_OPERATOR[criterion.op]}(root.<${targetJavaType(criterion)}>get("${property}"), ${value})`;
      }
      lines.push(`            if (filter.${criterion.name}() != null) {`, `                where.add(${predicate});`, '            }');
    }
    const params = hasFilter(finder) ? `${entity.name}Repository.${finder.filterType} filter${finder.result === 'page' ? ', ' : ''}` : '';
    const call =
      finder.result === 'page'
        ? `return ${jpaField}.findAll(specification, withStableOrder(pageable)).map(this::toDomain);`
        : `return ${jpaField}.findAll(specification, ${sortConstant(finder)}).stream().map(this::toDomain).toList();`;
    return `    @Override
    public ${finder.result === 'page' ? `Page<${entity.name}>` : `List<${entity.name}>`} ${finder.method}(${params}${finder.result === 'page' ? 'Pageable pageable' : ''}) {
        Specification<${mirror}> specification = (root, query, cb) -> {
            List<Predicate> where = new ArrayList<>();
${lines.join('\n')}
            return cb.and(where.toArray(Predicate[]::new));
        };
        ${call}
    }`;
  });
}

/** Los métodos del adaptador documental: un Criteria por búsqueda, ejecutado con MongoTemplate. */
export function mongoFinderMethods(model, entity, imports) {
  const finders = entityFinders(model, entity);
  if (finders.length === 0) return [];
  const mirror = `${entity.name}Document`;
  for (const name of [
    'org.springframework.data.mongodb.core.query.Criteria',
    'org.springframework.data.mongodb.core.query.Query',
    'java.util.ArrayList',
    'java.util.List',
    'java.util.regex.Pattern',
    'org.springframework.data.domain.Sort'
  ])
    imports.add(name);
  return finders.map((finder) => {
    const lines = [];
    for (const entry of finder.fixed) lines.push(`        where.add(Criteria.where("${entry.name}").is(${fixedValue(model, entry, imports)}));`);
    for (const criterion of finder.criteria) {
      const property = mirrorProperty(model, entity, criterion, true);
      const value = prepared(model, criterion, `filter.${criterion.name}()`, imports);
      // El texto buscado es LITERAL: Pattern.quote lo encierra en \Q…\E, que MongoDB entiende igual.
      const condition =
        criterion.match === 'contains'
          ? `Criteria.where("${property}").regex(Pattern.quote(${value}))`
          : criterion.match === 'prefix'
            ? `Criteria.where("${property}").regex("^" + Pattern.quote(${value}))`
            : `Criteria.where("${property}").${MONGO_OPERATOR[criterion.op]}(${value})`;
      lines.push(`        if (filter.${criterion.name}() != null) {`, `            where.add(${condition});`, '        }');
    }
    const params = hasFilter(finder) ? `${entity.name}Repository.${finder.filterType} filter${finder.result === 'page' ? ', ' : ''}` : '';
    const tail =
      finder.result === 'page'
        ? `        long total = mongoTemplate.count(query, ${mirror}.class);
        List<${mirror}> rows = mongoTemplate.find(Query.of(query).with(withStableOrder(pageable)), ${mirror}.class);
        return new PageImpl<>(rows.stream().map(this::toDomain).toList(), pageable, total);`
        : `        return mongoTemplate.find(query.with(${sortConstant(finder)}), ${mirror}.class).stream().map(this::toDomain).toList();`;
    if (finder.result === 'page') imports.add('org.springframework.data.domain.PageImpl');
    return `    @Override
    public ${finder.result === 'page' ? `Page<${entity.name}>` : `List<${entity.name}>`} ${finder.method}(${params}${finder.result === 'page' ? 'Pageable pageable' : ''}) {
        List<Criteria> where = new ArrayList<>();
${lines.join('\n')}
        Query query = where.isEmpty() ? new Query() : new Query(new Criteria().andOperator(where));
${tail}
    }`;
  });
}

/** Los campos del adaptador que necesitan los finders: el orden fijo de cada lista, con el desempate por id. */
export function finderFields(model, entity) {
  return entityFinders(model, entity)
    .filter((finder) => finder.result === 'list')
    .map(
      (finder) =>
        `    /** El orden que declara ${finder.operation}, con el id como desempate. */\n    private static final Sort ${sortConstant(finder)} = Sort.by(${[
          ...finder.sort.map((criterion) => `Sort.Order.${criterion.direction === 'desc' ? 'desc' : 'asc'}("${criterion.property}")`),
          `Sort.Order.asc("${entity.idField?.name ?? 'id'}")`
        ].join(', ')});\n`
    );
}

/** El escape del patrón LIKE, una vez por adaptador relacional con algún filtro de texto por patrón. */
export function likePatternHelper(model, entity) {
  if (!entityFinders(model, entity).some((finder) => finder.criteria.some((criterion) => criterion.match !== 'exact'))) return null;
  return String.raw`    /**
     * El patrón LIKE de un filtro 'match: prefix | contains' del diseño. El texto buscado es LITERAL: un %, un _ o una
     * barra del parámetro casan consigo mismos, así que se escapan con la barra que la consulta declara como escape.
     */
    private static String likePattern(String text, boolean prefix) {
        String escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        return prefix ? escaped + "%" : "%" + escaped + "%";
    }`;
}

/** La llamada que nombra la nota del handler. */
export function finderCall(finder) {
  const repository = `${finder.entity[0].toLowerCase()}${finder.entity.slice(1)}Repository`;
  const args = [];
  if (hasFilter(finder)) args.push(`new ${finder.entity}Repository.${finder.filterType}(${finder.criteria.map((criterion) => `query.${criterion.name}()`).join(', ')})`);
  if (finder.result === 'page') args.push('query.pageable()');
  return `${repository}.${finder.method}(${args.join(', ')})`;
}
