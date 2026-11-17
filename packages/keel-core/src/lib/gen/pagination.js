// La PÁGINA de un listado con persistencia, sin lenguaje (keel-core/gen).
//
// Con persistencia, un listado paginado se lee como el Pageable de Spring Data: `page`, `size` y `sort`, con
// sus defaults y su tope. Qué tamaño toma quien no lo pide, hasta dónde se acota y qué orden se aplica cuando el
// cliente no manda `?sort=` son respuesta observable de los tres servidores del mismo diseño, así que se
// deciden aquí. Estaban escritos en keel-spring (el orden) y copiados en keel-nest (el orden y los dos números)
// (incremento 6a de PLAN-KEEL-DOTNET.md).
//
// Cómo se LEE la query (indulgente: lo ilegible es el default, no un 400) es comportamiento de cada plataforma y
// se escribe en su idioma; sus reglas las fija el PageableHandlerMethodArgumentResolver de Spring Data.

import { operationTargetEntity, resolveRoute } from './model.js';
import { isTextual } from './types.js';
import { tableOf } from './relational.js';
import { snakeCase } from './naming.js';

/**
 * Los defaults del Pageable de keel-spring: `@PageableDefault` sin tamaño es 10 (la anotación gana a
 * `spring.data.web.pageable.default-page-size`), y el tope de Spring Data sin `max-page-size` es 2000.
 */
export const PAGEABLE_DEFAULT_SIZE = 10;
export const PAGEABLE_MAX_SIZE = 2000;

/**
 * El orden por defecto del diseño (`output.sort`) que se puede aplicar sin más, o []. Un criterio sobre un
 * agregado embebido (`brand.name`) necesita un join que lo resuelva y no es una propiedad de la entidad de
 * persistencia: entonces no se traduce ninguno, y lo avisa el modelo (es la señal del adaptador de lectura).
 */
export function translatableSort(operation) {
  const sort = operation?.sort ?? [];
  if (sort.length === 0 || sort.some((criterion) => criterion.embedded)) return [];
  return sort;
}

/** Tamaño por defecto, tope y orden por defecto de la página de una operación, ya resueltos. */
export function pageableDefaults(model, operation) {
  return {
    defaultSize: model.pagination?.defaultSize ?? PAGEABLE_DEFAULT_SIZE,
    maxSize: model.pagination?.maxSize ?? PAGEABLE_MAX_SIZE,
    defaultSort: translatableSort(operation)
  };
}

/**
 * Los listados paginados para personas que no declaran `sortable` (U3 de PLAN-DSL-231-232, DSL 2.32): desde 2.32 todo
 * `?sort=` de un listado sin `sortable` es 400, y para una pantalla quitarle el orden de las columnas es una decisión
 * que alguien tiene que tomar. Un consumidor máquina (`audience: services`) pide el orden del diseño y no pierde nada.
 * Lo lee `OBL-QUERY-SORT-UNDECIDED`.
 */
export function undecidedClientSorts(layers) {
  const api = layers?.api;
  if (!api) return [];
  const entities = layers?.domain?.entities ?? {};
  const out = [];
  for (const [name, op] of Object.entries(layers?.['use-cases']?.operations ?? {})) {
    const output = op?.output;
    if (op?.kind !== 'query' || typeof output !== 'object' || !output?.entity || output.paginated !== true || output.sortable) continue;
    const route = resolveRoute(name, op, api, operationTargetEntity(name, op, entities), []);
    if (!route || route.audience === 'services') continue;
    out.push({ operation: name, entity: output.entity, audience: route.audience });
  }
  return out;
}

// ─── El orden que pide el cliente (`?sort=`, DSL 2.32, U3 y D16) ───────────────────────────────────────────────

/** Las rutas por las que el cliente puede ordenar una operación (`output.sortable`), o [] si no ofrece `sort`. */
export function sortableOf(operation) {
  return (operation?.sortable ?? []).map((entry) => entry.path);
}

/** Los valores del parámetro `sort` que anuncia el contrato: `campo`, `campo,asc` y `campo,desc` de cada ordenable. */
export function sortParameterValues(operation) {
  return sortableOf(operation).flatMap((path) => [path, `${path},asc`, `${path},desc`]);
}

/**
 * Cómo se lee `?sort=`, la REFERENCIA EJECUTABLE de D16 que los cuatro lectores cumplen. `values` son los valores
 * del parámetro tal como llegaron (uno por cada `sort=` repetido; null o [] si no vino). Cada valor es `campo` o
 * `campo,dir`, con `dir` exactamente `asc` o `desc` (sin mayúsculas ni espacios: es contrato, no indulgencia). Un
 * valor vacío, uno que no está en `sortable`, una dirección ilegible, más de una coma o el mismo campo dos veces es
 * 400 con `invalidSortMessage(valor)`; sin `sortable`, CUALQUIER `?sort=` lo es. El orden del cliente SUSTITUYE al
 * del diseño, no se le suma; el desempate por id lo añade el adaptador en los dos casos, como siempre.
 *
 * Devuelve `{ sort: [{ path, direction }], client }` o `{ rejected: <valor> }`. `sabotage` deja falsar la referencia
 * (SO_SABOTAGES).
 */
export function readClientSort(values, { sortable = [], defaultSort = [] } = {}, { sabotage = null } = {}) {
  const received = values ?? [];
  if (received.length === 0) return { sort: defaultSort.map(({ path, direction }) => ({ path, direction })), client: false };
  const allowed = new Set(sortable);
  const seen = new Set();
  const sort = [];
  for (const value of received) {
    const parts = String(value).split(',');
    const [path, raw] = parts;
    const direction = sabotage === 'so-case' && raw ? raw.toLowerCase() : (raw ?? 'asc');
    const known = sabotage === 'so-open' ? path !== '' : allowed.has(path);
    if (parts.length > 2 || !known || !['asc', 'desc'].includes(direction)) return { rejected: value };
    if (seen.has(path) && sabotage !== 'so-duplicate') return { rejected: value };
    seen.add(path);
    sort.push({ path, direction });
  }
  if (sabotage === 'so-append') sort.unshift(...defaultSort.filter(({ path }) => !seen.has(path)).map(({ path, direction }) => ({ path, direction })));
  return { sort, client: true };
}

/**
 * Los casos del orden del cliente, con el mismo id en las cuatro redes. `sortable` y `defaultSort` son los del
 * sujeto (`catalog-search` de finder-designs.js: `sortable: [name, sku, price.amount]`, `sort: [name:asc]`);
 * `expect` es el orden leído o `400`.
 */
export const SO_CASES = Object.freeze([
  { id: 'SO-1', values: null, expect: [['name', 'asc']], what: 'sin ?sort=, el orden del diseño' },
  { id: 'SO-2', values: ['price.amount'], expect: [['price.amount', 'asc']], what: 'un campo solo ordena ascendente' },
  { id: 'SO-3', values: ['sku,desc'], expect: [['sku', 'desc']], what: 'con su dirección' },
  { id: 'SO-4', values: ['price.amount,desc', 'name'], expect: [['price.amount', 'desc'], ['name', 'asc']], what: 'varios, en el orden en que llegan, y sustituyen al del diseño' },
  { id: 'SO-5', values: ['apiToken'], expect: 400, what: 'un campo fuera de sortable (aquí, uno sensitive) es 400' },
  { id: 'SO-6', values: ['nombre'], expect: 400, what: 'un campo que no existe es 400, no 500' },
  { id: 'SO-7', values: ['name,DESC'], expect: 400, what: 'la dirección es asc o desc, en minúsculas' },
  { id: 'SO-8', values: ['name,asc,price.amount'], expect: 400, what: 'más de una coma en un valor es 400' },
  { id: 'SO-9', values: ['name', 'name,desc'], expect: 400, what: 'el mismo campo dos veces es 400' },
  { id: 'SO-10', values: [''], expect: 400, what: 'un ?sort= vacío es 400' },
  { id: 'SO-11', values: ['name'], sortable: [], expect: 400, what: 'sin sortable, cualquier ?sort= es 400' }
]);

/** Los sabotajes del orden del cliente: verde es que cada uno cae en exactamente sus casos (la referencia, y la red de cada generador). */
export const SO_SABOTAGES = Object.freeze({
  'so-open': { breaks: ['SO-5', 'SO-6', 'SO-11'], what: 'el lector acepta cualquier propiedad (lo de antes de 2.32)' },
  'so-case': { breaks: ['SO-7'], what: 'la dirección se lee sin distinguir mayúsculas' },
  'so-duplicate': { breaks: ['SO-9'], what: 'el mismo campo dos veces se acepta' },
  'so-append': { breaks: ['SO-2', 'SO-3'], what: 'el orden del cliente se suma al del diseño en vez de sustituirlo' }
});

/**
 * Las columnas de TEXTO de una raíz por las que se ordena (el `sort` de una query o su `sortable`): U7 les da la
 * collation binaria del motor (`binaryCollationFor`), para que el texto se ordene por punto de código en los tres
 * motores (D17). Una sombra plegada cuenta por su columna; un enum se ordena por su rango, que es un número.
 * Devuelve `[{ path, property, folded }]` en el orden en que aparecen, sin repetir columna.
 */
export function orderedTextColumns(model, entityName) {
  const entity = (model.entities ?? []).find((candidate) => candidate.name === entityName);
  if (!entity?.persisted) return [];
  const out = new Map();
  for (const operation of (model.services ?? []).flatMap((group) => group.operations)) {
    if (operation.responseDto?.entity !== entityName) continue;
    for (const target of [...(operation.sort ?? []), ...(operation.sortable ?? [])]) {
      if (target.embedded || target.ranked || out.has(target.property)) continue;
      const [head, nested] = target.path.split('.');
      const field = entity.fields.find((candidate) => candidate.name === head);
      const leaf = nested ? (model.valueObjects ?? []).find((vo) => vo.name === field?.namedType)?.fields.find((sub) => sub.name === nested) : field;
      if (!leaf || !(target.folded || isTextual(leaf))) continue;
      out.set(target.property, { path: target.path, property: target.property, folded: Boolean(target.folded) });
    }
  }
  return [...out.values()];
}

/**
 * Lo que la collation del orden (U7, D17) deja PENDIENTE en una base ya desplegada: build cambia el mapeo de cada
 * columna de texto ordenable, y eso llega a una base nueva con su baseline, pero no altera una columna que ya existe.
 * `baseline` es el texto del esquema exportado del proyecto (el de la base desplegada) o null si no lo hay todavía;
 * una columna ordenable que aparece en él sin collation es trabajo de esquema: un ALTER que nadie más va a escribir.
 * Devuelve los textos para `EVOLUTION.md` (§ Esquema pendiente), uno por columna.
 */
export function orderCollationWork(model, baseline, collation) {
  if (!baseline || !collation) return [];
  const lines = baseline.split('\n');
  const work = [];
  for (const entity of (model.entities ?? []).filter((candidate) => candidate.persisted)) {
    const table = tableOf(model, entity.name);
    for (const column of orderedTextColumns(model, entity.name)) {
      const name = snakeCase(column.property);
      const declared = lines.find((line) => new RegExp(`^\\s*[\`"]?${name}[\`"]?\\s`, 'i').test(line));
      if (!declared || /collat/i.test(declared)) continue;
      work.push(
        `La columna \`${table}.${name}\` se ordena (${column.path}) y desde DSL 2.32 lleva la collation binaria \`${collation}\` para ordenar igual en los tres motores (D17); la base desplegada no la tiene: añade un paso que la altere con la collation y el tipo que declara el mapeo.`
      );
    }
  }
  return work;
}
