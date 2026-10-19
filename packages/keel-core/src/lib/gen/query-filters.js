// Los filtros de una búsqueda (DSL 2.22) y el FINDER que build emite con ellos, NEUTRAL: qué restringe cada input,
// con qué operador y contra qué columna o sombra; los tres generadores escriben de aquí su puerto y su adaptador.
//
// Un input de una query restringe la entidad de la salida si se llama como uno de sus campos, o como
// `<relación>Id` de una relación a otra raíz (el enlace por nombre, que ya usaban la sombra plegada y las notas de
// text-filters.js), o si lo dice su `filter: { field, op }`. La operación añade sus igualdades fijas en `where`.
//
// El finder se emite ENTERO o no se emite: una query con un input que no enlaza (una búsqueda libre sobre varios
// campos, una lista de ids) no tiene finder, y su nota lo dice. Uno a medias lo reescribiría el agente igual —la
// corrida catalog-dotnet (2026-10-19) reescribió los tres puertos y sus tres adaptadores para añadir un `Search(...)`
// que el diseño decía a medias en prosa—.

import { pascalCase } from './naming.js';
import { foldedShadow } from './relational.js';

/** Los operadores que comparan por orden; el resto de filtros es igualdad. */
export const RANGE_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte']);

/** Lo que una ruta de filtro nombra en la entidad: un campo, el subcampo de un value object o una relación a otra raíz. */
function targetOf(entity, valueObjects, path) {
  const [head, sub] = path.split('.');
  const field = entity.fields.find((candidate) => candidate.name === head);
  if (field && sub) {
    if (field.list || field.kind !== 'composite') return null;
    const vo = valueObjects.find((candidate) => candidate.name === field.namedType);
    const subField = vo?.fields.find((candidate) => candidate.name === sub);
    if (!subField || subField.list || subField.kind === 'composite') return null;
    return { kind: 'vo', path, field, sub: subField };
  }
  if (field) return field.list || field.kind === 'composite' ? null : { kind: 'field', path, field };
  if (sub) return null;
  const relation = (entity.relations ?? []).find(
    (candidate) => candidate.name === head && !candidate.internal && ['many-to-one', 'one-to-one'].includes(candidate.cardinality)
  );
  return relation ? { kind: 'relation', path, relation } : null;
}

/** El enlace por nombre: el campo que se llama como el input, o la relación `<nombre>Id`. */
function implicitTarget(entity, valueObjects, name) {
  const field = targetOf(entity, valueObjects, name);
  if (field && field.kind !== 'relation') return field;
  if (name.endsWith('Id') && name.length > 2) {
    const relation = targetOf(entity, valueObjects, name.slice(0, -2));
    if (relation?.kind === 'relation') return relation;
  }
  return null;
}

/**
 * El finder de una query, o por qué no lo tiene. `{ finder: null, gaps: null }` si la query no es una búsqueda sobre una
 * raíz persistida (no hay nada que decir); `{ finder: null, gaps: [...] }` si lo es y algo no enlaza.
 */
export function queryFinder({ operation, entities, valueObjects, persistence }) {
  const none = { finder: null, gaps: null };
  if (!persistence || operation.kind !== 'query' || !(operation.paginated || operation.returnsList)) return none;
  const entity = entities.find((candidate) => candidate.name === operation.responseDto?.entity);
  if (!entity?.persisted || !entity.isAggregateRoot) return none;
  // La que recibe la lista de ids de su raíz es una lectura POR LOTE, con su propio mecanismo (findAllById,
  // ref-targets.js): no es una búsqueda filtrada y su nota ya dice cómo se lee.
  const idBase = entity.idField?.base ?? 'uuid';
  if ((operation.bodyFields ?? []).some((input) => input.list && input.kind === 'base' && input.base === idBase)) return none;

  const gaps = [];
  const criteria = [];
  for (const input of [...(operation.pathParams ?? []), ...(operation.bodyFields ?? [])]) {
    const target = input.filter ? targetOf(entity, valueObjects, input.filter.field) : implicitTarget(entity, valueObjects, input.name);
    if (!target) {
      gaps.push(`${input.name}: no se llama como ningún campo de ${entity.name} y no declara filter`);
      continue;
    }
    const op = input.filter?.op ?? 'eq';
    const match = input.match ?? 'exact';
    const compare = input.compare ?? 'exact';
    // Un texto plegado se compara contra la SOMBRA que build mantiene (la del campo o la del filtro); sin ella —dos
    // filtros pidieron plegados distintos y deriveFilterFolds no emitió ninguna— el plegado no tiene columna.
    const shadow = compare !== 'exact' && target.kind === 'field' ? foldedShadow(target.field) : null;
    if (compare !== 'exact' && !shadow) {
      gaps.push(`${input.name}: compare ${compare} sin columna sombra de ${target.path} (otro filtro la pide con otro plegado)`);
      continue;
    }
    criteria.push({ name: input.name, input, op, required: Boolean(input.required), target, match, compare, shadow });
  }
  const fixed = Object.entries(operation.where ?? {}).map(([name, value]) => ({
    name,
    field: entity.fields.find((candidate) => candidate.name === name),
    value
  }));
  if (fixed.some((entry) => !entry.field)) gaps.push('where: nombra un campo que la entidad no tiene');
  const embeddedSort = (operation.sort ?? []).filter((criterion) => criterion.embedded);
  if (embeddedSort.length > 0) {
    gaps.push(`sort: ordena por ${embeddedSort.map((criterion) => criterion.path).join(', ')}, de otro agregado, que este no guarda`);
  }
  if (gaps.length > 0) return { finder: null, gaps };
  // Sin nada que filtrar, la búsqueda es el listado entero: el List(pageable) que el puerto ya tiene.
  if (criteria.length === 0 && fixed.length === 0) return none;
  return {
    finder: {
      operation: operation.name,
      method: operation.name,
      filterType: `${pascalCase(operation.name)}Filter`,
      entity: entity.name,
      result: operation.paginated ? 'page' : 'list',
      criteria,
      fixed,
      sort: operation.sort ?? []
    },
    gaps: null
  };
}

/** Pone `finder` (o `finderGaps`) en cada query del modelo. Lo llama buildModel, con las sombras ya derivadas. */
export function attachQueryFinders({ services, entities, valueObjects, persistence }) {
  for (const group of services) {
    for (const operation of group.operations) {
      const { finder, gaps } = queryFinder({ operation, entities, valueObjects, persistence });
      operation.finder = finder;
      operation.finderGaps = gaps;
    }
  }
}

/** Las raíces y sus finders, en orden de declaración: lo que el puerto de cada repositorio gana. */
export function findersOf(model, entityName) {
  return (model.services ?? []).flatMap((group) => group.operations).filter((operation) => operation.finder?.entity === entityName).map((operation) => operation.finder);
}

// ─── El vocabulario de las sondas del finder (db-check y doc-check de los tres generadores) ──────────

/**
 * Un texto con los tres caracteres que un patrón confunde con comodines (`%` y `_` en un LIKE, `.` en una expresión
 * regular): si el adaptador no tratara el buscado como LITERAL, los filtros «de fuera» lo encontrarían igual.
 */
export const FINDER_PROBE_TEXT = 'Ñandú 5%_.x';

const FINDER_TEXT_CASES = {
  contains: { hit: 'ndú 5%_.', misses: ['ndú 5_%', 'ndú 5%_..'] },
  prefix: { hit: 'Ñandú 5%', misses: ['Ñandú 5_', 'Ñandú 5%_..'] }
};

/** El texto buscado con el plegado del filtro aplicado al revés: en mayúsculas y, si los ignora, sin acentos. */
function probeFolding(text, compare) {
  if (compare === 'ignore-case-accents') return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (compare === 'ignore-case') return text.toUpperCase();
  return text;
}

/** Lo que una sonda busca en un filtro de texto por patrón sobre FINDER_PROBE_TEXT: lo que lo encuentra y lo que no. */
export function finderTextProbes(criterion) {
  const cases = FINDER_TEXT_CASES[criterion.match];
  if (!cases) return null;
  return { hit: probeFolding(cases.hit, criterion.compare), misses: cases.misses.map((text) => probeFolding(text, criterion.compare)) };
}

const OPERATOR_TEXT = { eq: '=', gt: '>', gte: '≥', lt: '<', lte: '≤' };

/** Cómo se lee un criterio en prosa: `price.amount ≥ minPrice`, `name contiene name (sin mayúsculas ni acentos)`. */
export function criterionText(criterion) {
  const { target, op, match, compare, name } = criterion;
  const subject = target.kind === 'relation' ? `${target.path} (su id)` : target.path;
  const folding = compare === 'ignore-case-accents' ? ' (sin mayúsculas ni acentos)' : compare === 'ignore-case' ? ' (sin mayúsculas)' : '';
  if (match === 'contains') return `${subject} contiene ${name}${folding}`;
  if (match === 'prefix') return `${subject} empieza por ${name}${folding}`;
  return `${subject} ${OPERATOR_TEXT[op]} ${name}${folding}`;
}

/**
 * La nota del handler, la misma en los tres generadores. `call` es la llamada en la grafía de la plataforma
 * (`productRepository.SearchPublishedProducts(filter, query.Pageable)`).
 */
export function finderNote(operation, { call }) {
  if (operation.finder) {
    const { criteria, fixed } = operation.finder;
    const applied = [
      ...criteria.map((criterion) => criterionText(criterion) + (criterion.required ? '' : ' si viene')),
      ...fixed.map((entry) => `${entry.name} = ${entry.value}`)
    ];
    return (
      `Las filas las busca ${call}, que build emite con los filtros del diseño y solo esos: ${applied.join('; ')}. ` +
      'Un filtro opcional sin valor no restringe. Lo que la operación valide en prosa (un rango imposible, un id que no existe) va ' +
      'en el handler ANTES de llamarlo; una rule que restrinja algo más que esto no la aplica el finder: si es contrato, es un ' +
      'designGap (falta en filter o where).'
    );
  }
  if (operation.finderGaps) {
    return (
      `Sin finder de build: ${operation.finderGaps.join('; ')}. La búsqueda la escribe el agente en el puerto y el adaptador; ` +
      'si el input restringe un campo, declararlo con filter (DSL 2.22) es lo que haría que build la emitiera.'
    );
  }
  return null;
}
