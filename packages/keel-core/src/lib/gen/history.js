// El historial de cambios consultable (DSL 2.29: `persistence.audit.history` y la salida `output: { history: <Raíz> }`
// de una query), como decisiones neutrales.
//
// La pregunta que el diseño contesta es «qué valía este campo en una fecha, quién lo cambió y desde qué valor». Lo que
// no depende del lenguaje se decide aquí, como datos y como referencias ejecutables: qué raíces llevan historial, qué
// campos entran en él y con qué ruta, qué cambió entre dos instantáneas del agregado (el diff), en qué orden se lee y
// qué casa con cada filtro. Primero desde las capas (lo que leen las reglas de `crossrefs.js`) y después desde el modelo.
// Origen y decisiones: PLAN-DSL-229-HISTORIAL.md.

import { aggregateIndex, internalEntitiesOf } from './data-lifecycle.js';

/** Lo que pasó en una escritura (D2). El orden es el del contrato, no el de los generadores. */
export const HISTORY_CHANGES = Object.freeze(['created', 'updated', 'deleted', 'restored', 'anonymized']);

/** Los filtros de una query de historial (`historyFilter` en un campo del input) y el tipo que exige cada uno. */
export const HISTORY_FILTERS = Object.freeze({ field: 'string', from: 'timestamp', to: 'timestamp' });

/** Los campos de una entrada en el cable, en su orden (wire-contract.md § Historial). */
export const HISTORY_ENTRY_FIELDS = Object.freeze(['at', 'author', 'change', 'changes']);

// ─── Desde las capas ─────────────────────────────────────────────────────────

/** Las raíces que el diseño nombra en `persistence.audit.history`, en su orden. */
export function historyRoots(layers) {
  return [...(layers.persistence?.audit?.history ?? [])];
}

/** Las operaciones cuya salida es un historial: `{ operation, op, root }`. */
export function historyQueries(layers) {
  return Object.entries(layers['use-cases']?.operations ?? {})
    .filter(([, op]) => typeof op?.output === 'object' && typeof op.output?.history === 'string')
    .map(([operation, op]) => ({ operation, op, root: op.output.history }));
}

/** Los campos del input de una operación que declaran `historyFilter`: `[{ field, role, spec }]`. */
export function historyFilterFields(op) {
  const fields = typeof op?.input === 'object' ? op.input?.fields ?? {} : {};
  return Object.entries(fields)
    .filter(([, spec]) => spec?.historyFilter !== undefined)
    .map(([field, spec]) => ({ field, role: spec.historyFilter, spec }));
}

/** ¿Lo guarda el historial? Ni un secreto (`sensitive`) ni lo que pone la infraestructura (`generated`): D4. */
function recordedField(spec) {
  return spec?.sensitive !== true && spec?.generated !== true && spec?.id !== true;
}

/** Las rutas de un campo: las hojas de un value object compuesto con dot-path, o el campo entero. */
function fieldPaths(name, spec, types, depth = 0) {
  const composite = types?.[spec?.type]?.fields;
  if (!composite || spec?.list === true || depth > 4) return [name];
  return Object.entries(composite)
    .filter(([, sub]) => recordedField(sub))
    .flatMap(([sub, subSpec]) => fieldPaths(`${name}.${sub}`, subSpec, types, depth + 1));
}

/**
 * Las rutas PERSONALES de una entidad (DSL 2.28): las de sus campos `personal`, con `required` de lo que vale al
 * anonimizar (D9 de la 2.28): un escalar obligatorio recibe el sustituto y lo demás, null. Un value object compuesto se
 * vacía entero, como en la retención: sus hojas van a null.
 */
function entityPersonalPaths(layers, entityName) {
  const entity = layers.domain?.entities?.[entityName];
  const types = layers.domain?.types;
  return Object.entries(entity?.fields ?? {})
    .filter(([, spec]) => recordedField(spec) && spec?.personal === true)
    .flatMap(([name, spec]) => {
      const paths = fieldPaths(name, spec, types);
      const scalar = paths.length === 1 && paths[0] === name;
      return paths.map((path) => ({ path, required: scalar && spec.required === true }));
    });
}

/**
 * Las rutas que registra una entidad: sus campos y, de sus relaciones a OTRO agregado, `<relación>Id`. `own` son las
 * entidades de su propio agregado: una relación a ellas no es una referencia.
 */
function entityPaths(layers, entityName, own) {
  const entity = layers.domain?.entities?.[entityName];
  const types = layers.domain?.types;
  const paths = Object.entries(entity?.fields ?? {})
    .filter(([, spec]) => recordedField(spec))
    .flatMap(([name, spec]) => fieldPaths(name, spec, types));
  for (const [relation, spec] of Object.entries(entity?.relations ?? {})) {
    if (own.has(spec?.entity)) continue;
    if (spec?.cardinality === 'many-to-one' || spec?.cardinality === 'one-to-one') paths.push(`${relation}Id`);
  }
  return paths;
}

/** El campo id de una entidad, o `id`. */
function idFieldOf(layers, entityName) {
  return Object.entries(layers.domain?.entities?.[entityName]?.fields ?? {}).find(([, spec]) => spec?.id === true)?.[0] ?? 'id';
}

/**
 * Lo que el historial de una raíz registra, como forma: `{ root, paths, children: [{ relation, entity, idField, list,
 * paths }] }`. `paths` son las rutas del contrato (D3): un campo, la hoja de un value object compuesto con dot-path y
 * `<relación>Id` para una referencia a otro agregado. Las hijas son las relaciones de la raíz a una entidad interna de
 * su agregado; sus rutas se escriben `<relación>[<id>].<ruta>` (o `<relación>.<ruta>` si la relación es a una).
 */
export function historyShape(layers, rootName) {
  const internal = new Set(internalEntitiesOf(layers, rootName));
  const root = layers.domain?.entities?.[rootName];
  const children = Object.entries(root?.relations ?? {})
    .filter(([, spec]) => internal.has(spec?.entity))
    .map(([relation, spec]) => ({
      relation,
      entity: spec.entity,
      idField: idFieldOf(layers, spec.entity),
      list: spec.cardinality === 'one-to-many' || spec.cardinality === 'many-to-many',
      // La hija no registra su vuelta a la raíz: es la raíz misma, no una referencia a otro agregado.
      paths: entityPaths(layers, spec.entity, new Set([...internal, rootName])),
      personal: entityPersonalPaths(layers, spec.entity)
    }));
  return {
    root: rootName,
    idField: idFieldOf(layers, rootName),
    paths: entityPaths(layers, rootName, internal),
    personal: entityPersonalPaths(layers, rootName),
    children
  };
}

// ─── La anonimización del historial (D8): referencia ejecutable ──────────────

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Las rutas personales del historial de una raíz como patrones: `[{ pattern, required }]`, con `pattern` una expresión
 * regular ANCLADA que vale igual en JavaScript, Java, C# y Go (RE2): `^email$`, `^lines\[[^\]]*\]\.email$`. Un cambio
 * cuyo `field` casa con alguna es un valor personal: la anonimización lo reescribe y ningún log lo lleva (D9).
 */
export function historyPersonalPatterns(shape) {
  const out = shape.personal.map(({ path, required }) => ({ pattern: `^${escapeRegex(path)}$`, required }));
  for (const child of shape.children) {
    const prefix = child.list ? `${escapeRegex(child.relation)}\\[[^\\]]*\\]\\.` : `${escapeRegex(child.relation)}\\.`;
    for (const { path, required } of child.personal) out.push({ pattern: `^${prefix}${escapeRegex(path)}$`, required });
  }
  return out;
}

/** Lo que vale un cambio personal anonimizado: el sustituto `anon-<id de la raíz>` si es obligatorio, null si no. */
function anonymizedHistoryValue(required, rootId) {
  return required ? `anon-${rootId}` : null;
}

/** El patrón que casa con una ruta, o null. */
function personalMatch(patterns, field) {
  return patterns.find(({ pattern }) => new RegExp(pattern).test(field)) ?? null;
}

/**
 * Reescribe los valores personales de los cambios de UNA entrada (D8): `before` y `after` pasan al valor anonimizado. El
 * resto queda igual. Devuelve los cambios nuevos y si alguno cambió (una entrada sin cambios no se reescribe).
 */
export function anonymizeHistoryChanges(changes, patterns, rootId) {
  let touched = false;
  const out = changes.map((change) => {
    const match = personalMatch(patterns, change.field);
    if (!match) return change;
    const value = anonymizedHistoryValue(match.required, rootId);
    if (sameValue(change.before, value) && sameValue(change.after, value)) return change;
    touched = true;
    return { field: change.field, before: value, after: value };
  });
  return { changes: out, touched };
}

/**
 * Los cambios de la entrada `anonymized` que deja la retención (D8): una por ruta personal que aparece en el historial de
 * la raíz, ya anonimizada, con el valor anonimizado en `before` y en `after` (el anterior ya no existe en ninguna parte).
 * Ordenados por ruta, como los de `historyDiff`.
 */
export function anonymizedEntryChanges(entries, patterns, rootId) {
  const seen = new Map();
  for (const changes of entries) {
    for (const change of changes) {
      const match = personalMatch(patterns, change.field);
      if (match && !seen.has(change.field)) seen.set(change.field, anonymizedHistoryValue(match.required, rootId));
    }
  }
  return [...seen.keys()].sort().map((field) => ({ field, before: seen.get(field), after: seen.get(field) }));
}

/** ¿Es la raíz persistida de un agregado? Lo que puede llevar historial. */
export function isPersistedRoot(layers, entityName) {
  const at = aggregateIndex(layers).get(entityName);
  return Boolean(at?.isRoot) && layers.domain?.entities?.[entityName] !== undefined &&
    layers.persistence !== undefined && layers.persistence?.entities?.[entityName]?.persisted !== false;
}

// ─── El diff (D2, D3): referencia ejecutable ─────────────────────────────────

/** El valor en una ruta con dot-path de un objeto plano, o null. */
function valueAt(object, path) {
  let current = object;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return null;
    current = current[segment];
  }
  return current === undefined ? null : current;
}

/** Igualdad de dos valores del cable: por su JSON con las claves ordenadas, así que el orden de un objeto no cuenta. */
function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameValue(a, b) {
  return canonical(a ?? null) === canonical(b ?? null);
}

function diffPaths(prefix, paths, before, after, out) {
  for (const path of paths) {
    const was = before ? valueAt(before, path) : null;
    const is = after ? valueAt(after, path) : null;
    if (!sameValue(was, is)) out.push({ field: `${prefix}${path}`, before: was, after: is });
  }
}

/**
 * Lo que cambió entre dos instantáneas de un agregado, con la forma de `historyShape`: `[{ field, before, after }]`,
 * solo lo que cambió y ordenado por ruta. `before` null es un alta y `after` null, una baja; una hija nueva o quitada
 * aparece con todas sus rutas. Los valores son los del cable (wire.js): los cuatro generadores comparan esto mismo.
 */
export function historyDiff(shape, before, after) {
  const out = [];
  diffPaths('', shape.paths, before, after, out);
  for (const child of shape.children) {
    if (!child.list) {
      diffPaths(`${child.relation}.`, child.paths, before?.[child.relation] ?? null, after?.[child.relation] ?? null, out);
      continue;
    }
    const byId = (items) => new Map((items ?? []).map((item) => [String(item?.[child.idField]), item]));
    const was = byId(before?.[child.relation]);
    const is = byId(after?.[child.relation]);
    for (const id of new Set([...was.keys(), ...is.keys()])) {
      diffPaths(`${child.relation}[${id}].`, child.paths, was.get(id) ?? null, is.get(id) ?? null, out);
    }
  }
  return out.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

/**
 * La entrada que deja una escritura, o null si no deja ninguna. Un alta es `created`, una baja `deleted` y una
 * restauración `restored` (estas dos, sin `changes`: la ficha no cambia, cambia si se ve); un `save` es `updated` solo si
 * algo cambió (D2).
 */
export function historyEntry(shape, { change, before = null, after = null }) {
  if (!HISTORY_CHANGES.includes(change)) throw new Error(`historyEntry: '${change}' no es un cambio del historial`);
  if (change === 'deleted' || change === 'restored') return { change, changes: [] };
  const changes = historyDiff(shape, change === 'created' ? null : before, after);
  if (change === 'updated' && changes.length === 0) return null;
  return { change, changes };
}

// ─── La lectura (D10): referencia ejecutable ─────────────────────────────────

/** La parte de una ruta que nombra el campo de la raíz: `price` en `price.amount`, `lines` en `lines[7].qty`. */
export function topFieldOf(path) {
  return path.split(/[.[]/)[0];
}

/**
 * ¿Casa la entrada con los filtros? `field` casa una ruta entera o el campo de la raíz que la contiene (`price` casa
 * `price.amount`); `from` y `to` son instantes en milisegundos, extremos incluidos. Los tres se combinan con AND.
 */
export function historyMatches(entry, { field = null, fromMs = null, toMs = null } = {}) {
  const atMs = typeof entry.at === 'number' ? entry.at : Date.parse(entry.at);
  if (fromMs !== null && atMs < fromMs) return false;
  if (toMs !== null && atMs > toMs) return false;
  if (field === null) return true;
  return (entry.changes ?? []).some((change) => change.field === field || topFieldOf(change.field) === field);
}

/** El orden del contrato: el más reciente primero y, a igual instante, el id de la entrada (descendente) desempata. */
export function compareHistoryEntries(a, b) {
  const atA = typeof a.at === 'number' ? a.at : Date.parse(a.at);
  const atB = typeof b.at === 'number' ? b.at : Date.parse(b.at);
  if (atA !== atB) return atB - atA;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ─── La frontera de los generadores ──────────────────────────────────────────

/**
 * Lo que un generador todavía no emite del historial, con el mismo mensaje en los cuatro: lo llama cada
 * `supported-features.js` hasta su incremento de PLAN-DSL-229-HISTORIAL.md. A medias falla en silencio —una escritura sin
 * entrada, un valor personal que sobrevive a la retención—, y por eso se rechaza entero.
 */
export function historyPendingErrors(layers, generator, increment) {
  const pending = (what, fix) =>
    `${what} (DSL 2.29): ${generator} todavía no lo genera — llega en el incremento ${increment} de ` +
    `PLAN-DSL-229-HISTORIAL.md, y a medias fallaría en silencio. ${fix} para generar este diseño.`;
  const errors = [];
  const roots = historyRoots(layers);
  if (roots.length > 0) errors.push(pending(`persistence: audit.history [${roots.join(', ')}]`, 'Quita audit.history'));
  for (const { operation } of historyQueries(layers)) {
    errors.push(pending(`use-cases: ${operation}.output.history`, 'Quita la query de historial'));
  }
  return errors;
}

// ─── Lo que emite cada generador, desde el modelo ────────────────────────────

/** Las raíces del modelo con historial: sus nombres, en el orden de las entidades. */
export function historyRootNames(model) {
  return (model.entities ?? []).filter((entity) => entity.history).map((entity) => entity.name);
}

/** ¿Usa el servicio el almacén del historial? */
export function usesHistory(model) {
  return historyRootNames(model).length > 0;
}

/** Las queries del modelo que leen un historial: `{ operation, root, filters }`. */
export function historyOperations(model) {
  return (model.services ?? [])
    .flatMap((group) => group.operations ?? [])
    .filter((operation) => operation.historyOf)
    .map((operation) => ({ operation: operation.name, root: operation.historyOf, filters: operation.historyFilters }));
}

/**
 * La nota del handler de una query de historial, la misma en los cuatro generadores. `historyCall` es la llamada al
 * puerto de la raíz en el lenguaje del generador (`historyOf(...)`), que carga la raíz con la MISMA lectura que su ficha
 * —viva y, si la raíz va acotada, con el alcance— antes de leer el almacén (D7).
 */
export function historyNote(operation, { historyCall }) {
  if (!operation?.historyOf) return null;
  const filters = Object.entries(operation.historyFilters ?? {}).filter(([, input]) => input).map(([role, input]) => `${input} (${role})`);
  return (
    `Historial (output.history: ${operation.historyOf}, DSL 2.29): ${historyCall} carga ${operation.historyOf} con la misma ` +
    'lectura que su ficha —viva y, si va acotada, con el alcance del llamante— y devuelve la página de entradas ya ordenada ' +
    '(la más reciente primero) y filtrada; vacío si la raíz no existe, está borrada o es ajena con readMiss: not-found. Ese ' +
    'vacío es el error de no encontrado del diseño. Las entradas las escribe el adaptador en cada escritura: aquí no se ' +
    `escribe ninguna, ni se lee el almacén por otra vía.${filters.length > 0 ? ` Filtros del input: ${filters.join(', ')}; uno nulo no filtra.` : ''}`
  );
}

// ─── Casos y sabotajes ───────────────────────────────────────────────────────

/** Los casos que los cuatro generadores ejecutan con el mismo id, y en qué red. */
export const HISTORY_CASES = Object.freeze([
  { id: 'HI-1', level: 'adapter', asserts: 'crear, modificar y borrar dejan una entrada cada uno, en la misma transacción: un rollback no deja entrada' },
  { id: 'HI-2', level: 'adapter', asserts: 'changes lleva solo lo que cambió, con before y after; un save sin cambios no escribe' },
  { id: 'HI-3', level: 'adapter', asserts: 'las hijas y los value objects aparecen con su ruta del contrato' },
  { id: 'HI-4', level: 'adapter', asserts: 'ni sensitive ni generated aparecen nunca' },
  { id: 'HI-5', level: 'adapter', asserts: 'author es el sub del token; fuera de una petición, el centinela' },
  { id: 'HI-6', level: 'adapter', asserts: 'la página va del más reciente al más antiguo con desempate estable, y filtra por field, from y to' },
  { id: 'HI-7', level: 'adapter', asserts: 'el historial de una raíz ajena o borrada da el error de su lectura por id' },
  { id: 'HI-8', level: 'timer', asserts: 'anonymize reescribe los personales del historial y deja la entrada anonymized' },
  { id: 'HI-9', level: 'timer', asserts: 'delete y la purga de lo borrado se llevan las entradas' },
  { id: 'HI-10', level: 'adapter', asserts: 'restaurar deja una entrada restored' },
  { id: 'HI-11', level: 'telemetry', asserts: 'ningún log ni span lleva un valor personal del historial' }
]);

/** Los sabotajes y los casos en los que tiene que caer cada uno: exactamente esos. */
export const HISTORY_SABOTAGES = Object.freeze({
  'hi-outside-tx': ['HI-1'],
  'hi-full-snapshot': ['HI-2'],
  'hi-sensitive': ['HI-4'],
  'hi-author': ['HI-5'],
  'hi-order': ['HI-6'],
  'hi-unscoped': ['HI-7'],
  'hi-anonymize-miss': ['HI-8'],
  'hi-purge-miss': ['HI-9']
});
