// Las sondas de la BÚSQUEDA de DSL 2.32 (in, ne, search y el ?sort= del cliente) para db-check y doc-check: los casos
// FS-* (keel-core/gen/query-filters.js) y SO-* (keel-core/gen/pagination.js) sobre el sujeto `catalog-search` y su gemelo
// documental (keel-core/test/helpers/finder-designs.js, SEARCH_DESIGNS), con los MISMOS ids que el finder-check de
// keel-spring.
//
// Los FS-* guardan las filas de FINDER_SEARCH_ROWS por el ADAPTADOR emitido y llaman a su finder: lo que se mide es lo
// que emite build, también la collation del orden (FS-3 y FS-9 leen la página en el orden del diseño). Los SO-* llaman al
// readPageable emitido con lo que el controlador le pasa a esa operación (el orden del diseño y su sortable).

import { FINDER_SABOTAGES, FINDER_SEARCH_CASES, FINDER_SEARCH_ROWS } from '@keel-system/keel-core/gen/query-filters';
import { SO_CASES, SO_SABOTAGES, pageableDefaults } from '@keel-system/keel-core/gen/pagination';
import { classPath, DIRS } from '../../src/scaffold/render.js';
import { PAGEABLE_READING_TS } from '../../src/scaffold/controllers.js';

/** La query del sujeto, sobre la que están escritos los casos. */
export const SUBJECT_OPERATION = 'searchCatalog';

const js = (value) => JSON.stringify(value);
const IMPL = '-repository-impl.ts';
const READING = 'pageable-reading.ts';

/** Cada sabotaje, por rama: `[dónde, texto o expresión, sustituto]`. Todos compilan: lo que se mide es la sonda. */
const so = {
  'so-open': [READING, "Object.hasOwn(sortable, path) ? sortable[path] : undefined;", "Object.hasOwn(sortable, path) ? sortable[path] : path === '' ? undefined : path;"],
  'so-case': [READING, "const direction = parts[1] ?? 'asc';", "const direction = parts[1]?.toLowerCase() ?? 'asc';"],
  'so-duplicate': [READING, ' || seen.has(path)', ''],
  'so-append': [
    READING,
    'sort: sort ?? [...(defaults.defaultSort ?? [])]',
    'sort: sort == null ? [...(defaults.defaultSort ?? [])] : [...(defaults.defaultSort ?? []).filter((order) => !sort.some((asked) => asked.property === order.property)), ...sort]'
  ]
};

export const SEARCH_SABOTAGE_SPECS = {
  'finder-in': {
    relational: [IMPL, /In\((filter\.\w+)\)/g, 'In($1.slice(0, 1))'],
    document: [IMPL, /\$in: (filter\.\w+)\.map/g, '$in: $1.slice(0, 1).map']
  },
  'finder-ne-null': {
    relational: [IMPL, /Or\(IsNull\(\), (Not\(Equal\(filter\.\w+\)\))\)/g, '$1'],
    document: [IMPL, /\$ne: (filter\.\w+)/g, '$nin: [null, $1]']
  },
  // Uno por modelo: en Mongo `%` y `_` no son comodines (FS-7 no ve nada) y el `.` sí (FS-10).
  'finder-search-literal': { relational: ['like-pattern.ts', String.raw`const SPECIAL = /[\\%_]/g;`, String.raw`const SPECIAL = /[\\]/g;`] },
  'finder-search-regex': { document: [IMPL, /literalPattern\((TextFold\.)/g, '($1'] },
  ...Object.fromEntries(Object.entries(so).map(([id, spec]) => [id, { relational: spec, document: spec }])),
  // La collation del orden (U7, D17): `name` vuelve a la de por defecto del motor. Solo se ve en MySQL, que ordena 'Ñandú'
  // junto a la N con utf8mb4_0900_ai_ci; PostgreSQL alpine compara bytes igualmente (B0, M11).
  'order-collation': { relational: [/product-orm\.ts$/, /(name: 'name', type: 'varchar', length: \d+, )collation: '[^']+', /, '$1'] }
};

const BREAKS = Object.fromEntries([...Object.entries(FINDER_SABOTAGES), ...Object.entries(SO_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

export const isSearchSabotage = (id) => Boolean(SEARCH_SABOTAGE_SPECS[id]);

/** La query del sujeto si este modelo es el de los casos (su finder con una búsqueda libre y su sortable), o null. */
function subjectOf(model) {
  const operation = (model.services ?? []).flatMap((group) => group.operations).find((candidate) => candidate.name === SUBJECT_OPERATION);
  return operation?.finder?.criteria.some((criterion) => criterion.op === 'search') && (operation.sortable ?? []).length > 0 ? operation : null;
}

/** Los casos que ejecuta el bloque de este diseño. */
export function searchCases(model) {
  return subjectOf(model) ? [...FINDER_SEARCH_CASES.map((entry) => entry.id), ...SO_CASES.map((entry) => entry.id)] : [];
}

/** Lo que tiene que caer con un sabotaje: sus casos, y solo esos (`order-collation`, solo en MySQL: en PostgreSQL, ninguno). */
export function searchSabotageVerdict(checks, id, model, { engine = null } = {}) {
  const cases = searchCases(model);
  const breaks = id === 'order-collation' ? (engine === 'mysql' ? ['FS-3', 'FS-9'] : []) : BREAKS[id] ?? [];
  const want = breaks.filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^(FS|SO)-\d+:/.test(check.name)).map((check) => /^((FS|SO)-\d+):/.exec(check.name)[1]))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El bloque ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El bloque de los casos, con `check`, `stateOf` y `randomUUID` del script de la sonda. `sampleEntity` da el agregado de
 * muestra (del que salen los campos que la fila no nombra) y `adapterOf(entity)` el adaptador de la raíz.
 */
export function searchBlock(model, ctx, { sampleEntity, adapterOf }) {
  const operation = subjectOf(model);
  if (!operation) return '';
  const root = model.entities.find((entity) => entity.name === operation.finder.entity);
  const status = root.fields.find((field) => field.name === 'status');
  ctx.imports.add(`${status.namedType}|${classPath(DIRS.enums, status.namedType)}`);
  ctx.imports.add(`readPageable|${PAGEABLE_READING_TS}`);
  const constantOf = (literal) => model.enums.find((entry) => entry.name === status.namedType).values.find((entry) => entry.literal === literal).constant;
  const idName = root.idField?.name ?? 'id';

  const rows = FINDER_SEARCH_ROWS.map(
    (row, at) =>
      `  await repository.save(new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `fs${at}`)}), ${idName}: randomUUID(), sku: ${js(row.sku)}, name: ${js(row.name)}, notes: ${js(row.notes)}, status: ${status.namedType}.${constantOf(row.status)} }));`
  );
  const { defaultSize, maxSize, defaultSort } = pageableDefaults(model, operation);
  const property = new Map([...defaultSort, ...operation.sortable].map((entry) => [entry.path, entry.property]));
  const sortable = Object.fromEntries(operation.sortable.map((entry) => [entry.path, entry.property]));
  const orderLiteral = js(defaultSort.map((entry) => ({ property: entry.property, direction: entry.direction })));
  const filterOf = (inputs) =>
    `{ ${operation.finder.criteria
      .map((criterion) => {
        const value = inputs[criterion.name];
        if (value === undefined) return `${criterion.name}: null`;
        if (criterion.op === 'in') return `${criterion.name}: [${value.map((literal) => `${status.namedType}.${constantOf(literal)}`).join(', ')}]`;
        return `${criterion.name}: ${js(value)}`;
      })
      .join(', ')} }`;
  const finderCases = FINDER_SEARCH_CASES.map((entry) => {
    const label = `${entry.id}: ${entry.what}`;
    return `  {
    const got = await searched(${filterOf(entry.inputs)});
    check(${js(label)}, JSON.stringify(got) === ${js(JSON.stringify(entry.expect))}, got.join(', '));
  }`;
  });
  const sortCases = SO_CASES.map((entry) => {
    const label = `${entry.id}: ${entry.what}`;
    const defaults = `{ defaultSize: ${defaultSize}, maxSize: ${maxSize}, defaultSort: ${orderLiteral}, sortable: ${js(entry.sortable ? Object.fromEntries(entry.sortable.map((path) => [path, property.get(path)])) : sortable)} }`;
    const query = entry.values === null ? '{}' : `{ sort: ${js(entry.values)} }`;
    const expected = entry.expect === 400 ? null : entry.expect.map(([path, direction]) => [property.get(path), direction]);
    return `  try {
    const read = readPageable(${query}, ${defaults}).sort.map((order) => [order.property, order.direction]);
    check(${js(label)}, ${expected === null ? 'false' : `JSON.stringify(read) === ${js(JSON.stringify(expected))}`}, JSON.stringify(read));
  } catch (error) {
    check(${js(label)}, ${expected === null ? "error?.name === 'InvalidSortError'" : 'false'}, error?.message);
  }`;
  });
  return `
// ─── La búsqueda de 2.32: FS-* (el finder) y SO-* (el ?sort= del cliente) ───
{
  const repository = ${adapterOf(root)};
${rows.join('\n')}
  // Solo las filas del caso, en el orden del diseño (${defaultSort.map((entry) => `${entry.path}:${entry.direction}`).join(', ')}, y el id de desempate).
  const known = new Set(${js(FINDER_SEARCH_ROWS.map((row) => row.sku))});
  const searched = async (filter) =>
    (await repository.${operation.finder.method}(filter, { page: 0, size: 100, sort: ${orderLiteral} })).items.map((found) => String(found.sku)).filter((sku) => known.has(sku));
${finderCases.join('\n')}
${sortCases.join('\n')}
}`;
}
