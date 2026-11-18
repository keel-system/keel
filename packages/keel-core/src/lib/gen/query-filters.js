// Los filtros de una búsqueda (DSL 2.22) y el FINDER que build emite con ellos, NEUTRAL: qué restringe cada input,
// con qué operador y contra qué columna o sombra; los tres generadores escriben de aquí su puerto y su adaptador.
//
// Un input de una query restringe la entidad de la salida si se llama como uno de sus campos, o como
// `<relación>Id` de una relación a otra raíz (el enlace por nombre, que ya usaban la sombra plegada y las notas de
// text-filters.js), o si lo dice su `filter: { field, op }`. La operación añade sus igualdades fijas en `where`.
//
// El finder se emite ENTERO o no se emite: una query con un input que no enlaza (un texto cuya regla vive en prosa, una
// lista de ids que no filtra con `in`) no tiene finder, y su nota lo dice.
//
// DSL 2.32 suma `in` (uno de los valores de una lista), `ne` (distinto, y lo NULO también es distinto: D11) y la búsqueda
// libre `search` (un OR de `match` sobre varios campos de texto, cada uno contra su sombra plegada: D13). Un input con
// `search` nunca se enlaza por nombre: aunque se llame como un campo, no es su igualdad. Uno a medias lo reescribiría el agente igual —la
// corrida catalog-dotnet (2026-10-19) reescribió los tres puertos y sus tres adaptadores para añadir un `Search(...)`
// que el diseño decía a medias en prosa—.

import { pascalCase } from './naming.js';
import { foldedShadow } from './relational.js';
import { implicitPredicates } from './implicit-predicates.js';

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

/**
 * Si la columna de un criterio admite filas sin valor: una relación o un campo obligatorios no. `ne` (D11) incluye esas
 * filas, y un lenguaje que tipa la columna sin nulo (el `Guid` de C#) no deja escribir la comparación con el nulo.
 */
export function criterionNullable(criterion) {
  const { target } = criterion;
  if (target.kind === 'relation') return !target.relation.required;
  if (target.field.required || target.field.id) return target.kind === 'vo' ? !target.sub.required : false;
  return true;
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
    if (input.search) {
      const criterion = searchCriterion(entity, valueObjects, input, gaps);
      if (criterion) criteria.push(criterion);
      continue;
    }
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
  // Sin nada que filtrar, la búsqueda es el listado entero: el List(pageable) que el puerto ya tiene. Salvo que la lectura
  // esté acotada (DSL 2.27, `reads`): entonces el predicado del alcance es el criterio, y se suma (AND) a los demás y al
  // conteo de la página (D4).
  // La vida de la fila (DSL 2.28) no crea un finder: el listado entero del puerto ya deja fuera lo borrado, como la carga.
  const { scope, live } = implicitPredicates(operation, entity);
  if (criteria.length === 0 && fixed.length === 0 && !scope) return none;
  return {
    finder: {
      operation: operation.name,
      method: operation.name,
      filterType: `${pascalCase(operation.name)}Filter`,
      entity: entity.name,
      result: operation.paginated ? 'page' : 'list',
      criteria,
      fixed,
      scope,
      // Lo borrado no se ve (DSL 2.28): se suma (AND) a los criterios, al alcance y al conteo de la página.
      live,
      sort: operation.sort ?? []
    },
    gaps: null
  };
}

/** El criterio de una búsqueda libre (2.32, D13): cada campo de `over` con su sombra si el `compare` pliega, o null y su hueco. */
function searchCriterion(entity, valueObjects, input, gaps) {
  const { over, match, compare } = input.search;
  const targets = [];
  for (const path of over) {
    const target = targetOf(entity, valueObjects, path);
    if (!target || target.kind === 'relation') {
      gaps.push(`${input.name}: search.over nombra ${path}, que no es un campo de texto de ${entity.name}`);
      return null;
    }
    const shadow = compare !== 'exact' && target.kind === 'field' ? foldedShadow(target.field) : null;
    if (compare !== 'exact' && !shadow) {
      gaps.push(`${input.name}: search con compare ${compare} sin columna sombra de ${path} (un subcampo de value object no la tiene, o otro filtro la pide con otro plegado)`);
      return null;
    }
    targets.push({ target, shadow });
  }
  return { name: input.name, input, op: 'search', required: Boolean(input.required), target: null, targets, match, compare, shadow: null };
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

/**
 * Cómo se lee un criterio en prosa: `price.amount ≥ minPrice`, `name contiene name (sin mayúsculas ni acentos)`,
 * `status es uno de statuses`, `notes ≠ notNotes (también sin valor)`, `name o notes contiene q`.
 */
export function criterionText(criterion) {
  const { target, op, match, compare, name } = criterion;
  const folding = compare === 'ignore-case-accents' ? ' (sin mayúsculas ni acentos)' : compare === 'ignore-case' ? ' (sin mayúsculas)' : '';
  const how = (subject) => (match === 'contains' ? `${subject} contiene ${name}${folding}` : match === 'prefix' ? `${subject} empieza por ${name}${folding}` : `${subject} = ${name}${folding}`);
  if (op === 'search') return how(criterion.targets.map((entry) => entry.target.path).join(' o '));
  const subject = target.kind === 'relation' ? `${target.path} (su id)` : target.path;
  if (op === 'in') return `${subject} es uno de ${name}${folding}`;
  if (op === 'ne') return `${subject} ≠ ${name} (también sin valor)`;
  if (match !== 'exact') return how(subject);
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
      'Un filtro opcional sin valor no restringe' +
      (criteria.some((criterion) => criterion.op === 'in') ? ' (y una lista de in vacía no llega: es 400 en el borde)' : '') +
      '. Lo que la operación valide en prosa (un rango imposible, un id que no existe) va ' +
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

/**
 * La frontera mientras un generador no genera la búsqueda de 2.32 (`op: in`/`ne`, `search` y `sortable`): se rechaza
 * entera, con el mismo mensaje en los cuatro, porque a medias fallaría en silencio —un finder que ignora un filtro
 * devuelve filas de más, y un `sortable` ignorado deja ordenar por cualquier campo—. Cada generador la quita en su
 * incremento de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md (B3-B6).
 */
export function searchPendingErrors(layers, generator, increment) {
  const pending = (what, fix) =>
    `${what} (DSL 2.32): ${generator} todavía no lo genera — llega en el incremento ${increment} de ` +
    `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md, y a medias fallaría en silencio. ${fix} para generar este diseño.`;
  const errors = [];
  for (const [name, op] of Object.entries(layers?.['use-cases']?.operations ?? {})) {
    for (const [field, input] of Object.entries(op?.input?.fields ?? {})) {
      if (['in', 'ne'].includes(input?.filter?.op)) {
        errors.push(pending(`use-cases: ${name}.input.fields.${field}.filter op: ${input.filter.op}`, 'Quita el filtro'));
      }
      if (input?.search) errors.push(pending(`use-cases: ${name}.input.fields.${field}.search`, 'Quita la búsqueda libre'));
    }
    if (op?.output?.sortable) errors.push(pending(`use-cases: ${name}.output.sortable`, 'Quita sortable'));
  }
  return errors;
}

// ─── La REFERENCIA del finder (DSL 2.32): lo que devuelve, fila a fila ──────────────────────────────────────────

/** El plegado de `TextFold` (el que estampa la sombra): sin marcas diacríticas si los ignora, y en minúsculas. */
export function foldText(text, compare) {
  if (text === null || text === undefined || compare === 'exact') return text;
  const unaccented = compare === 'ignore-case-accents' ? text.normalize('NFD').replace(/\p{M}+/gu, '') : text;
  return unaccented.toLowerCase();
}

const valueAt = (row, path) => path.split('.').reduce((value, key) => (value === null || value === undefined ? value : value[key]), row);
const absent = (value) => value === null || value === undefined;

/** ¿Casa un texto guardado con el buscado? El buscado es LITERAL: ningún carácter es comodín. */
function textMatches(stored, wanted, match, compare) {
  if (absent(stored)) return false;
  const [a, b] = [foldText(String(stored), compare), foldText(String(wanted), compare)];
  return match === 'contains' ? a.includes(b) : match === 'prefix' ? a.startsWith(b) : a === b;
}

/** El sabotaje del texto literal: el buscado como patrón de LIKE sin escapar, donde `%` y `_` son comodines. */
function likeMatches(stored, wanted, compare) {
  if (absent(stored)) return false;
  const pattern = [...foldText(String(wanted), compare)].map((char) => (char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(pattern, 'u').test(foldText(String(stored), compare));
}

/**
 * El sabotaje de la rama documental: el buscado como expresión regular sin citar. Ahí `%` y `_` no son comodines (FS-7
 * no lo ve) pero `.` sí, y casa con cualquier carácter.
 */
function regexMatches(stored, wanted, compare) {
  if (absent(stored)) return false;
  return new RegExp(foldText(String(wanted), compare), 'u').test(foldText(String(stored), compare));
}

const compareOrder = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/**
 * ¿Devuelve el finder esta fila con estos inputs? La REFERENCIA EJECUTABLE de los criterios, la que cumplen los
 * cuatro adaptadores: un input ausente no restringe; `ne` deja pasar la fila sin valor (D11); `in` pliega cada
 * elemento con su `compare` (D12); `search` es un OR sobre `over` (D13); un operador de orden nunca casa con una fila
 * sin valor (la semántica de SQL). `row` lleva los valores por su ruta del diseño (`price.amount`, la relación por
 * su nombre con el id). `sabotage` deja falsar la referencia (FINDER_SABOTAGES).
 */
export function matchesFinder(finder, row, inputs, { sabotage = null } = {}) {
  for (const criterion of finder.criteria) {
    const wanted = inputs[criterion.name];
    if (absent(wanted)) continue;
    if (criterion.op === 'search') {
      const paths = criterion.targets.map((entry) => entry.target.path);
      const hit = paths.some((path) =>
        sabotage === 'finder-search-literal'
          ? likeMatches(valueAt(row, path), wanted, criterion.compare)
          : sabotage === 'finder-search-regex'
            ? regexMatches(valueAt(row, path), wanted, criterion.compare)
            : textMatches(valueAt(row, path), wanted, criterion.match, criterion.compare)
      );
      if (!hit) return false;
      continue;
    }
    const stored = valueAt(row, criterion.target.path);
    if (criterion.op === 'in') {
      if (sabotage === 'finder-in') {
        if (!textMatches(stored, wanted[0], 'exact', criterion.compare)) return false;
      } else if (!wanted.some((value) => textMatches(stored, value, 'exact', criterion.compare))) return false;
      continue;
    }
    if (criterion.op === 'ne') {
      if (absent(stored)) {
        if (sabotage === 'finder-ne-null') return false;
        continue;
      }
      if (stored === wanted) return false;
      continue;
    }
    if (criterion.op === 'eq') {
      if (!textMatches(stored, wanted, criterion.match, criterion.compare)) return false;
      continue;
    }
    if (absent(stored)) return false;
    const order = compareOrder(stored, wanted);
    const ok = { gt: order > 0, gte: order >= 0, lt: order < 0, lte: order <= 0 }[criterion.op];
    if (!ok) return false;
  }
  return (finder.fixed ?? []).every((entry) => valueAt(row, entry.name) === entry.value);
}

/**
 * Los casos del finder de 2.32 sobre el sujeto `catalog-search` (finder-designs.js: la query `searchCatalog` sobre
 * `Product`), con el mismo id en las cuatro redes. `rows` son las filas que la sonda guarda (por su `sku`) y
 * `expect`, los `sku` que tiene que devolver, en el orden del diseño (`name:asc`, y el id de desempate).
 */
export const FINDER_SEARCH_ROWS = Object.freeze([
  { sku: 'AAA-0001', name: 'Ñandú de peluche', notes: 'Edición 50%_off', status: 'active' },
  { sku: 'AAA-0002', name: 'Mesa', notes: 'Roble', status: 'draft' },
  { sku: 'AAA-0003', name: 'Silla', notes: null, status: 'retired' },
  { sku: 'AAA-0004', name: 'Lámpara', notes: 'Para la mesa del ÑANDÚ', status: 'active' }
]);

export const FINDER_SEARCH_CASES = Object.freeze([
  { id: 'FS-1', inputs: { statuses: ['active', 'draft'] }, expect: ['AAA-0004', 'AAA-0002', 'AAA-0001'], what: 'in: uno de los estados de la lista' },
  { id: 'FS-2', inputs: { statuses: ['retired'] }, expect: ['AAA-0003'], what: 'in con un solo elemento' },
  { id: 'FS-3', inputs: { notNotes: 'Roble' }, expect: ['AAA-0004', 'AAA-0003', 'AAA-0001'], what: 'ne: la fila sin valor también es distinta' },
  { id: 'FS-4', inputs: { q: 'nandu' }, expect: ['AAA-0004', 'AAA-0001'], what: 'search: casa en name o en notes, sin mayúsculas ni acentos' },
  { id: 'FS-5', inputs: { q: 'MESA' }, expect: ['AAA-0004', 'AAA-0002'], what: 'search: el mismo texto casa por un campo en una fila y por otro en otra' },
  { id: 'FS-6', inputs: { q: '50%_' }, expect: ['AAA-0001'], what: 'search: el texto buscado es literal (sus comodines casan consigo mismos)' },
  { id: 'FS-7', inputs: { q: '5_%' }, expect: [], what: 'search: un comodín no casa con otro carácter' },
  { id: 'FS-8', inputs: { statuses: ['active'], q: 'mesa' }, expect: ['AAA-0004'], what: 'los criterios se suman (AND); la búsqueda es un OR solo dentro de over' },
  { id: 'FS-9', inputs: {}, expect: ['AAA-0004', 'AAA-0002', 'AAA-0003', 'AAA-0001'], what: 'sin inputs, el listado entero' },
  { id: 'FS-10', inputs: { q: 'r.ble' }, expect: [], what: 'search: un punto es un punto, no cualquier carácter (el comodín de una expresión regular)' }
]);

/** Los sabotajes de los finders de 2.32, con los casos que tumban; los nombra la red de cada generador. */
export const FINDER_SABOTAGES = Object.freeze({
  'finder-in': { breaks: ['FS-1'], what: 'in compara solo con el primer elemento de la lista' },
  'finder-ne-null': { breaks: ['FS-3'], what: 'ne deja fuera la fila sin valor (el `<>` de SQL a pelo)' },
  // Uno por familia de patrón, porque cada modelo tiene sus comodines: LIKE (relacional) y la expresión regular (documental).
  'finder-search-literal': { breaks: ['FS-7'], what: 'el texto de la búsqueda se usa como patrón LIKE, sin escapar (rama relacional)' },
  'finder-search-regex': { breaks: ['FS-10'], what: 'el texto de la búsqueda se usa como expresión regular, sin citar (rama documental)' }
});
