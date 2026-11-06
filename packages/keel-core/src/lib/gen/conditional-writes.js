// La ESCRITURA CONDICIONAL (DSL 2.25, `api.concurrency`), neutral: la misma decisión en los cuatro generadores.
//
// `optimisticLocking` arbitra dos transacciones que se cruzan DENTRO del servidor. La actualización perdida de verdad
// ocurre ENTRE dos peticiones: Ana carga la ficha, Luis cambia el precio, Ana guarda con el formulario viejo y el precio
// de Luis desaparece sin que nada falle. Lo arregla el estándar HTTP: `ETag` en la lectura, `If-Match` en la escritura,
// 412 si no coincide y 428 si falta y se exige. Plan y decisiones (D1-D7): PLAN-DSL-225-ESCRITURA-CONDICIONAL.md.
//
// Aquí vive todo lo que los cuatro tienen que decidir igual:
//   · qué escrituras comparan versión (las listadas) y qué lecturas dan el ETag (se DERIVAN, no se declaran);
//   · qué escrituras devuelven el ETag nuevo y, con ello, qué handlers devuelven `Versioned<T>` (D6);
//   · cómo se lee la cabecera (los casos de `wire.js`) y qué se estampa en el mensaje (D5);
//   · los errores, la nota del handler, las filas del gate y los casos `CW-*` con sus sabotajes.
//
// La derivación es UNA y tiene dos entradas: las capas, para `keel validate` (crossrefs.js), y el modelo, para los
// generadores. Las dos se reducen a la misma forma y pasan por `derive`, así que no pueden decir cosas distintas.

import { aggregateIndex, locksEntity, operationTargetEntity, resolveRoute } from './model.js';
import { idParamNames } from './api-contract.js';
import { FRAMEWORK_ERRORS } from '../framework-errors.js';
import { FRAMEWORK_RESPONSES } from './api-errors.js';
import { effectiveErrorCode } from './declared-errors.js';
import { WIRE_IF_MATCH_CASES } from './wire.js';

/** Las políticas de `api.concurrency.conditionalWrites`, en el orden del schema. */
export const CONDITIONAL_WRITE_POLICIES = ['none', 'optional', 'required'];

/** Cabeceras del contrato. */
export const ETAG_HEADER = 'ETag';
export const IF_MATCH_HEADER = 'If-Match';

/**
 * El campo del mensaje que estampa el borde a partir de `If-Match` (D5): la lista de versiones que valen, o null si no se
 * compara. Lista y no un número porque `If-Match` admite varias (D2). Desde otra puerta (evento, despacho, reloj) llega
 * nulo. camelCase; cada generador lo proyecta a su convención.
 */
export const EXPECTED_VERSIONS_FIELD = 'expectedVersions';

/** El método del puerto del repositorio que carga comparando (D4) y el tipo que devuelve el handler (D6). */
export const LOAD_EXPECTING = 'loadExpecting';
export const VERSIONED_TYPE = 'Versioned';

/** El campo que lleva la versión de una raíz, con `all` (infraestructura) y con `declared` (dominio). */
export const VERSION_FIELD = 'lockVersion';

// ─── El cable (D1, D2) ────────────────────────────────────────────────────────────────────────────────────────────

/** El ETag de una versión (D1): fuerte, entre comillas, opaco para el cliente. */
export function etagOf(version) {
  return `"${version}"`;
}

const STRONG_VERSION = /^"(0|[1-9][0-9]*)"$/;

/**
 * Lo que el borde estampa en el mensaje a partir de la cabecera (D2, D5): null si no hay que comparar (ausente, vacía o
 * `*`, que se cumple si el recurso existe y eso ya lo dice el 404), y si no la lista de versiones fuertes que trae. Un
 * elemento débil, sin comillas o ilegible no entra; una cabecera con solo esos da `[]`, que no casa con nada (412).
 */
export function expectedVersionsFrom(header) {
  if (header == null) return null;
  const value = String(header).trim();
  if (value === '' || value === '*') return null;
  const versions = [];
  for (const element of value.split(',')) {
    const match = STRONG_VERSION.exec(element.trim());
    if (match) versions.push(Number(match[1]));
  }
  return versions;
}

/** ¿Falta la cabecera? Ausente o vacía: es lo que da 428 con `required`. */
export function ifMatchAbsent(header) {
  return header == null || String(header).trim() === '';
}

/** ¿Cumple la versión vigente lo esperado? null no compara. Es la comparación que hace `loadExpecting` (D4). */
export function versionMatches(expected, current) {
  return expected == null || expected.some((version) => version === Number(current));
}

/** Los casos de la cabecera (los de `wire.js`), para que cada generador los ejecute con el mismo id (CW-7). */
export const IF_MATCH_CASES = WIRE_IF_MATCH_CASES;

// ─── La derivación ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El plan de un diseño, o null si no declara escritura condicional (o la declara `none`).
 *
 *   · `writes`: las escrituras listadas que se pueden generar, `{ name, root, echoes }`. `echoes`: su salida es la
 *     representación única de esa raíz, así que devuelve el ETag nuevo (para encadenar dos ediciones sin releer).
 *   · `readers`: las lecturas derivadas que dan el ETag, `{ name, root }`: queries con endpoint cuya salida es la
 *     representación única (ni lista ni página) de una raíz que escribe alguna operación listada.
 *   · `problems`: por qué una operación listada no se puede generar, `{ operation, kind, root }`, con `kind` en
 *     `unknown` (no existe, no es un command o no tiene endpoint), `unversioned` (su raíz no tiene versión), `create` (no
 *     recibe el id de su raíz) y `no-reader` (ninguna lectura derivada da el ETag de su raíz).
 */
function derive({ concurrency, operations, versionedRoot }) {
  const policy = concurrency?.conditionalWrites ?? 'none';
  if (!concurrency || policy === 'none') return null;
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  const problems = [];
  const candidates = [];
  for (const name of concurrency.operations ?? []) {
    const operation = byName.get(name);
    if (!operation || operation.kind !== 'command' || !operation.route) {
      problems.push({ operation: name, kind: 'unknown', root: null });
      continue;
    }
    const root = operation.targetEntity;
    if (!root || !versionedRoot(root)) {
      problems.push({ operation: name, kind: 'unversioned', root });
      continue;
    }
    const owns = idParamNames(root);
    if (!operation.pathParams.some((param) => owns.has(param))) {
      problems.push({ operation: name, kind: 'create', root });
      continue;
    }
    candidates.push({ name, root, echoes: operation.single === root });
  }
  const roots = new Set(candidates.map((write) => write.root));
  const readers = operations
    .filter((operation) => operation.kind === 'query' && operation.route && roots.has(operation.single))
    .map((operation) => ({ name: operation.name, root: operation.single }));
  const read = new Set(readers.map((reader) => reader.root));
  const writes = [];
  for (const write of candidates) {
    if (read.has(write.root)) writes.push(write);
    else problems.push({ operation: write.name, kind: 'no-reader', root: write.root });
  }
  return { policy, writes, readers: readers.filter((reader) => writes.some((write) => write.root === reader.root)), problems };
}

const singleEntity = (output) =>
  output && typeof output === 'object' && output.entity && !output.list && !output.paginated ? output.entity : null;

/** Las operaciones y las raíces con versión de las CAPAS, en la forma que lee `derive`. */
function layersInput(layers) {
  const api = layers?.api ?? null;
  const domainEntities = layers?.domain?.entities ?? {};
  const internalOf = aggregateIndex(layers?.domain ?? {});
  const policy = layers?.persistence?.consistency?.optimisticLocking ?? 'all';
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {}).map(([name, op]) => {
    const targetEntity = operationTargetEntity(name, op ?? {}, domainEntities);
    const route = resolveRoute(name, op ?? {}, api, targetEntity, []);
    return {
      name,
      kind: op?.kind ?? 'command',
      route,
      pathParams: route ? [...String(route.path).matchAll(/{([A-Za-z][A-Za-z0-9]*)}/g)].map((m) => m[1]) : [],
      targetEntity,
      single: singleEntity(op?.output)
    };
  });
  const versionedRoot = (entity) =>
    Boolean(layers?.persistence) &&
    Boolean(domainEntities[entity]) &&
    (layers.persistence.entities?.[entity]?.persisted ?? true) &&
    locksEntity(policy, !internalOf.has(entity), Object.hasOwn(domainEntities[entity]?.fields ?? {}, VERSION_FIELD));
  return { operations, versionedRoot };
}

/** El plan derivado de las CAPAS: lo que lee `keel validate`. */
export function conditionalWritesOfLayers(layers) {
  if (!layers?.api?.concurrency) return null;
  return derive({ concurrency: layers.api.concurrency, ...layersInput(layers) });
}

/**
 * Las escrituras que abren la pregunta (`OBL-API-CONCURRENCY-UNDECIDED`) en un diseño con API que no declara
 * `concurrency`: un PUT o un PATCH sobre una raíz con versión que recibe su id. Son la edición de una ficha, el caso
 * de la actualización perdida; un POST de transición o un DELETE no lo son por defecto, aunque se puedan listar.
 */
export function undecidedConditionalWrites(layers) {
  if (!layers?.api || layers.api.concurrency) return [];
  const { operations, versionedRoot } = layersInput(layers);
  return operations
    .filter((operation) => operation.kind === 'command' && ['PUT', 'PATCH'].includes(operation.route?.method))
    .filter((operation) => operation.targetEntity && versionedRoot(operation.targetEntity))
    .filter((operation) => operation.pathParams.some((param) => idParamNames(operation.targetEntity).has(param)))
    .map((operation) => ({ operation: operation.name, root: operation.targetEntity, method: operation.route.method }));
}

/** El plan derivado del MODELO: lo que leen los generadores. Memorizado por modelo. */
const plans = new WeakMap();
export function conditionalWritesOf(model) {
  if (!plans.has(model)) {
    const operations = allOperations(model).map((operation) => ({
      name: operation.name,
      kind: operation.kind,
      route: operation.route,
      pathParams: (operation.pathParams ?? []).map((param) => param.name),
      targetEntity: operation.targetEntity ?? null,
      single: !operation.returnsList && !operation.paginated ? (operation.responseDto?.entity ?? null) : null
    }));
    const versionedRoot = (entity) => {
      const found = (model.entities ?? []).find((candidate) => candidate.name === entity);
      return Boolean(found?.persisted && found.usesOptimisticLocking);
    };
    plans.set(model, derive({ concurrency: model.api?.concurrency, operations, versionedRoot }));
  }
  return plans.get(model);
}

/** ¿Emite el servicio escritura condicional? */
export function usesConditionalWrites(model) {
  return (conditionalWritesOf(model)?.writes.length ?? 0) > 0;
}

/** La política (`optional` | `required`), o null. */
export function conditionalWritePolicy(model) {
  return usesConditionalWrites(model) ? conditionalWritesOf(model).policy : null;
}

/** La entrada de una escritura condicional, `{ name, root, echoes }`, o null si la operación no lo es. */
export function conditionalWrite(model, operation) {
  return conditionalWritesOf(model)?.writes.find((write) => write.name === operation.name) ?? null;
}

/** ¿Da esta lectura el ETag de su raíz? */
export function etagReader(model, operation) {
  return Boolean(conditionalWritesOf(model)?.readers.some((reader) => reader.name === operation.name));
}

/**
 * ¿Devuelve el handler `Versioned<T>` (D6)? Las lecturas derivadas y las escrituras listadas que devuelven su raíz: el
 * borde pone el ETag a partir de esa versión, nunca de lo que el handler tenía en memoria antes del commit (T1).
 */
export function returnsVersioned(model, operation) {
  return etagReader(model, operation) || Boolean(conditionalWrite(model, operation)?.echoes);
}

/**
 * Cómo se lee «la versión de esta raíz» (T5): siempre `lockVersion`, y `declared` dice si es un campo del dominio (un
 * `int` con `optimisticLocking: declared`) o de infraestructura (con `all`). El borde la trata siempre como un entero.
 */
export function versionOf(model, root) {
  const entity = (model.entities ?? []).find((candidate) => candidate.name === root);
  if (!entity?.persisted || !entity.usesOptimisticLocking) return null;
  return { field: VERSION_FIELD, declared: (entity.fields ?? []).some((field) => field.name === VERSION_FIELD) };
}

// ─── CORS (CW-9) ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las cabeceras que CORS expone: las del diseño y, con escritura condicional, `ETag`. Sin ella un navegador no puede
 * leer el ETag y nunca tendrá qué mandar en If-Match. La misma lista en los cuatro generadores.
 */
export function corsExposedHeaders(model) {
  const declared = model.security?.cors?.exposedHeaders ?? [];
  if (!usesConditionalWrites(model) || declared.some((header) => header.toLowerCase() === ETAG_HEADER.toLowerCase())) return declared;
  return [...declared, ETAG_HEADER];
}

/** Las cabeceras que CORS admite: las del diseño y, si no son `*`, `If-Match` con escritura condicional. */
export function corsAllowedHeaders(model) {
  const declared = model.security?.cors?.allowedHeaders ?? ['*'];
  if (!usesConditionalWrites(model) || declared.includes('*') || declared.some((header) => header.toLowerCase() === IF_MATCH_HEADER.toLowerCase())) return declared;
  return [...declared, IF_MATCH_HEADER];
}

// ─── Errores ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Los dos fallos de la escritura condicional con su `code` efectivo (el del diseño si nombra uno de su familia, si no
 * el canónico), su status y sus textos. El 409 de la carrera dentro del servidor sigue siendo `concurrency`: las dos
 * garantías no se funden (CW-5).
 */
export function conditionalWriteErrors(model) {
  return {
    failed: { ...FRAMEWORK_RESPONSES.preconditionFailed, code: effectiveErrorCode(model, FRAMEWORK_ERRORS.preconditionFailed) },
    required: { ...FRAMEWORK_RESPONSES.preconditionRequired, code: effectiveErrorCode(model, FRAMEWORK_ERRORS.preconditionRequired) }
  };
}

/**
 * El orden en que se deciden los fallos de una escritura condicional (D3). El 428 sale en el borde sin cargar nada; el
 * 404 va antes que el 412 porque el `NOT_FOUND` del diseño sigue siendo el contrato, y el alcance y la propiedad (403 y
 * 404) también (T4): un 412 sobre algo que el llamante no puede ver confirmaría que existe.
 */
export const PRECONDITION_ORDER = [401, 403, 428, 400, 404, 412, 409];

// ─── El handler y su gate ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * La nota del handler, la misma en los cuatro generadores, o null. `read` es cómo se lee el campo del mensaje en el
 * lenguaje del generador (`command.expectedVersions()`), `load` cómo se llama al puerto (`products.loadExpecting(id,
 * …)`) y `versioned` cómo se escribe el tipo de retorno (`Versioned<ProductResponseDto>`).
 */
export function conditionalWriteNote(model, operation, { read, load, versioned }) {
  const write = conditionalWrite(model, operation);
  if (write) {
    return (
      `Escritura condicional (api.concurrency: ${conditionalWritePolicy(model)}): carga '${write.root}' con ${load}, pasando ` +
      `${read}, que el borde estampó desde If-Match. La comparación la hace el adaptador: si la versión no es la esperada ` +
      `lanza la precondición (412) sin tocar la fila, y con ${read} nulo (sin cabecera, '*' u otra puerta) no compara. ` +
      'No cargues con el método sin comparar ni compares a mano: el gate check-conditional-writes.sh lo vigila.' +
      (write.echoes
        ? ` Devuelve ${versioned} con la versión que deja el guardado (la que devuelve save, ya persistida), no la que cargaste: ` +
          'con la de antes del commit, el ETag va un número por detrás y la siguiente edición encadenada da 412 sin conflicto.'
        : '')
    );
  }
  if (etagReader(model, operation)) {
    return (
      `Lectura que da el ETag de '${operation.responseDto?.entity}' (api.concurrency): devuelve ${versioned} con la versión ` +
      'de la raíz que cargaste. El borde la pone en la cabecera ETag; el cliente la devuelve en If-Match al escribir.'
    );
  }
  return null;
}

/**
 * Las filas del gate `check-conditional-writes.sh` (CW-12): cada handler de una escritura condicional tiene que llamar a
 * `loadExpecting`. Sale rojo sobre el proyecto recién generado (el handler es del agente) y verde con la llamada.
 */
export function conditionalWriteGateRows(model) {
  return (conditionalWritesOf(model)?.writes ?? []).map((write) => {
    const operation = allOperations(model).find((candidate) => candidate.name === write.name);
    return { operation: write.name, handlerClass: operation?.handlerClass ?? null, root: write.root, marker: LOAD_EXPECTING };
  });
}

/** Dónde emite cada generador el gate de la escritura condicional. */
export const CHECK_CONDITIONAL_WRITES_SH = 'infra/check-conditional-writes.sh';

/**
 * El gate `infra/check-conditional-writes.sh` (CW-12), el mismo en los cuatro generadores: por cada escritura condicional,
 * su handler tiene que LLAMAR a `loadExpecting` (en la convención del lenguaje: `call`) fuera de un comentario. Nace ROJO
 * sobre el proyecto recién generado —el handler es del agente, y la nota que lo pide nombra la llamada en un comentario—
 * y verde con la llamada escrita. Sale con 1 si falta alguna y con 2 si no encuentra un handler.
 *
 * `handlerPath(row)` es la ruta del handler relativa a la raíz del proyecto; `lineComment` el comentario de línea del
 * lenguaje (las líneas que empiezan por él no cuentan).
 */
export function conditionalWritesGateScript(model, { handlerPath, call, lineComment = '//' }) {
  const rows = conditionalWriteGateRows(model);
  if (rows.length === 0) return null;
  const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
  const checks = rows.map((row) => `check ${quote(row.operation)} ${quote(row.root)} ${quote(handlerPath(row))}`);
  return `#!/usr/bin/env bash
# Gate de la ESCRITURA CONDICIONAL (api.concurrency, DSL 2.25) de ${model.service.name}. Generado por build: no lo edites.
#
# Cada escritura condicional carga su raíz con ${call}(…), que compara la versión que el borde estampó desde If-Match y
# lanza el 412 sin tocar la fila. Cargar con el método que no compara no rompe ninguna prueba de una sola escritura: es el
# fallo que este gate existe para ver. Recién generado sale ROJO (el handler es tuyo); en verde cuando cada uno la llama.
set -u
cd "$(dirname "$0")/.."
missing=0
broken=0
check() {
  if [ ! -f "$3" ]; then
    echo "  ? $1: no encuentro su handler ($3)"
    broken=1
    return
  fi
  if grep -v '^[[:space:]]*${lineComment}' "$3" | grep -q '${call}('; then
    echo "  ✓ $1 carga $2 con ${call}"
  else
    echo "  ✗ $1: su handler no llama a ${call}(…) — sin él, quien guarda un formulario viejo pisa el cambio de otro sin 412"
    missing=1
  fi
}
echo "Escritura condicional (${CHECK_CONDITIONAL_WRITES_SH}):"
${checks.join('\n')}
if [ "$broken" -ne 0 ]; then exit 2; fi
exit "$missing"
`;
}

// ─── La frontera neutral (T3) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que ningún generador genera todavía, con el mismo mensaje en los cuatro: una escritura condicional que además
 * repite la respuesta por `Idempotency-Key` (`keySource: client-key`). La respuesta repetida tendría que llevar el mismo
 * ETag, y ningún sujeto lo mide; se abre cuando un diseño lo pida.
 */
export function conditionalWritesFrontierErrors(layers, generator) {
  const plan = conditionalWritesOfLayers(layers);
  if (!plan) return [];
  const operations = layers['use-cases']?.operations ?? {};
  return plan.writes
    .filter((write) => operations[write.name]?.idempotency?.keySource === 'client-key')
    .map(
      (write) =>
        `use-cases: operations.${write.name} combina escritura condicional (api.concurrency) con idempotency.keySource: ` +
        `client-key — la respuesta repetida por Idempotency-Key tendría que llevar el mismo ETag, y ${generator} no lo ` +
        'genera todavía porque ningún diseño lo ha pedido. Quita una de las dos, o pídelo.'
    );
}

/**
 * El rechazo de un generador que todavía no genera la escritura condicional, con el mismo mensaje en los cuatro: llega
 * por incrementos (PLAN-DSL-225-ESCRITURA-CONDICIONAL.md) y, hasta el suyo, se rechaza entera, nunca a medias. Vacío si
 * el diseño no la declara o la declara `none`.
 */
export function conditionalWritesPendingErrors(layers, generator, increment) {
  if (!conditionalWritesOfLayers(layers)) return [];
  return [
    `api.concurrency (escritura condicional, DSL 2.25): ${generator} todavía no la genera — llega en el incremento ${increment} ` +
      'de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md, y una escritura condicional a medias (sin 412, o con el ETag de antes del guardado) ' +
      'sería peor que ninguna. Quita concurrency, o declárala conditionalWrites: none, para generar este diseño.'
  ];
}

// ─── La medición ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Los casos que los cuatro generadores ejecutan con el mismo id, y en qué red. */
export const CW_CASES = [
  { id: 'CW-1', level: 'adapter', asserts: 'cargar con la versión vigente devuelve el agregado' },
  { id: 'CW-2', level: 'adapter', asserts: 'cargar con otra versión lanza la precondición y no toca la fila' },
  { id: 'CW-3', level: 'adapter', asserts: 'cargar con la esperada nula no compara' },
  { id: 'CW-4', level: 'adapter', asserts: 'save devuelve la versión nueva, la misma que ve una lectura posterior' },
  { id: 'CW-5', level: 'adapter', asserts: 'con la esperada correcta y otra escritura entre la carga y el commit sale el 409 de concurrencia, no el 412' },
  { id: 'CW-6', level: 'api', asserts: 'una escritura sin If-Match con required da 428 con la forma de error del cable y no llega al mediator' },
  { id: 'CW-7', level: 'api', asserts: 'los casos de la cabecera (*, lista, débil, ilegible) dan lo que dicen los casos del cable' },
  { id: 'CW-8', level: 'api', asserts: 'la excepción de precondición da 412 con el code y el message de api-errors.js' },
  { id: 'CW-9', level: 'api', asserts: 'ETag va en las cabeceras expuestas de CORS' },
  { id: 'CW-10', level: 'api', asserts: 'el ETag de la lectura tiene el formato de D1' },
  { id: 'CW-11', level: 'cache', asserts: 'un acierto de caché devuelve el mismo ETag que la lectura que lo llenó' },
  { id: 'CW-12', level: 'gate', asserts: 'el gate sale rojo sobre el proyecto recién generado y verde con la llamada escrita' }
];

/** Los sabotajes, con el mismo id en los cuatro: verde significa que cada uno cae en exactamente sus casos. */
export const CW_SABOTAGES = [
  { id: 'cw-ignore-expected', breaks: 'el adaptador no compara', falls: ['CW-2'] },
  { id: 'cw-stale-version', breaks: 'save devuelve la versión cargada', falls: ['CW-4'] },
  { id: 'cw-collapse-409', breaks: 'el conflicto de la ventana sale como 412', falls: ['CW-5'] },
  { id: 'cw-no-428', breaks: 'el borde no exige la cabecera', falls: ['CW-6'] },
  { id: 'cw-weak-match', breaks: 'la comparación acepta W/', falls: ['CW-7'] },
  { id: 'cw-error-map', breaks: 'la precondición sale como 409', falls: ['CW-8'] },
  { id: 'cw-cors', breaks: 'ETag no se expone', falls: ['CW-9'] },
  { id: 'cw-cache-etag', breaks: 'la caché guarda solo el cuerpo', falls: ['CW-11'] },
  { id: 'cw-gate', breaks: 'el gate no mira el handler', falls: ['CW-12'] }
];

function allOperations(model) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []);
}
