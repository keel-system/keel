// Los LOTES con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`), como decisiones neutrales.
//
// La pregunta que el diseño contesta es «importo 500 filas y fallan 3: ¿qué le digo al cliente de cada una?». Lo que no
// depende del lenguaje se decide aquí, como datos y como referencias ejecutables: qué operaciones son lotes, qué campo
// del input se recorre, qué fallo es solo de su elemento y cuál detiene el lote, y la respuesta que sale de una serie de
// desenlaces. El bucle lo emite cada generador; el handler de la operación procesa UN elemento, como con el historial.
// Primero desde las capas (lo que leen las reglas de `crossrefs.js`) y después desde el modelo.
// Origen y decisiones (D1-D12): PLAN-DSL-230-LOTES.md. La semántica es la de Spring Batch —skip, commit interval y
// reanudación—, sin la librería.

import { FRAMEWORK_ERRORS } from '../framework-errors.js';

/** Cómo se confirma un lote (D1, D2). Sin default: es contrato (`OBL-BATCH-ATOMICITY-UNDECIDED`). */
export const BATCH_ATOMICITIES = Object.freeze(['all-or-nothing', 'per-item']);

/** Cuándo se procesa (fase A `sync`, fase B `async`). */
export const BATCH_EXECUTIONS = Object.freeze(['sync', 'async']);

/** El tope de un lote síncrono (D7): por encima, el 207 no cabe en una petición y el diseño tiene que elegir `async`. */
export const BATCH_SYNC_MAX_ITEMS = 1000;

/** El desenlace de cada elemento en el cable, en el orden del contrato. */
export const BATCH_ITEM_STATUSES = Object.freeze(['succeeded', 'failed', 'notAttempted']);

/** El status de un lote `per-item` síncrono: siempre el mismo, también si todo salió bien (D1). */
export const BATCH_MULTI_STATUS = 207;

/**
 * El `message` del elemento que detiene el lote sin un `code` propio (D4): un fallo de infraestructura o un defecto. Es
 * contrato observable, como los textos de `api-errors.js`, y por eso no lo escribe ningún generador a mano.
 */
export const BATCH_ABORTED_MESSAGE = 'El elemento falló por una causa que no es suya y el lote se detuvo en él';

/**
 * El `message` de un elemento que no se puede leer como su tipo (D3: un null, un tipo de JSON que no casa) cuando lo
 * que falla no es una guarda con su propio mensaje. Su `error` es VALIDATION_ERROR y falla solo él.
 */
export const BATCH_ITEM_MALFORMED_MESSAGE = 'El elemento no tiene la forma que el contrato declara para él';

// ─── Desde las capas ─────────────────────────────────────────────────────────

/** Las operaciones que declaran `batch`: `{ operation, op, batch }`, en su orden. */
export function batchOperations(layers) {
  return Object.entries(layers['use-cases']?.operations ?? {})
    .filter(([, op]) => op?.batch && typeof op.batch === 'object')
    .map(([operation, op]) => ({ operation, op, batch: op.batch }));
}

/** La ejecución efectiva de un lote: `sync` si no la declara. */
export function batchExecutionOf(batch) {
  return batch?.execution ?? 'sync';
}

/** El campo del input que recorre el lote, con su spec, o null si no existe. */
export function batchOverField(op) {
  const name = op?.batch?.over;
  const spec = typeof op?.input === 'object' ? op.input?.fields?.[name] : undefined;
  return spec ? { name, spec } : null;
}

/** El tope declarado del lote (`maxItems` del campo `over`), o null. */
export function batchMaxItems(op) {
  return batchOverField(op)?.spec?.constraints?.maxItems ?? null;
}

/**
 * ¿Entra la operación por HTTP? Un lote solo tiene sentido con alguien que espera el 207 (o sondea el trabajo): un
 * endpoint declarado, o uno que `api.auto` deriva para un `create<X>`.
 */
export function batchHttpEntry(layers, operation) {
  const api = layers.api;
  if (!api) return false;
  return Boolean(api.endpoints?.[operation]) || (api.auto === true && /^create[A-Z]/.test(operation));
}

/** Las otras puertas por las que entra la operación, que no tienen a quién devolver el resultado por elemento. */
export function batchForeignEntries(layers, operation) {
  const entries = [];
  const op = layers['use-cases']?.operations?.[operation];
  if (op?.internal) entries.push('internal: true');
  if (op?.schedule) entries.push('schedule');
  for (const [name, subscription] of Object.entries(layers.messaging?.subscriptions ?? {})) {
    if (subscription?.triggers === operation) entries.push(`messaging.subscriptions.${name}`);
  }
  for (const [name, other] of Object.entries(layers['use-cases']?.operations ?? {})) {
    if ((other?.dispatches ?? []).includes(operation)) entries.push(`use-cases.${name}.dispatches`);
  }
  return entries;
}

// ─── La respuesta (D1-D4): referencia ejecutable ─────────────────────────────

/**
 * La ruta del elemento culpable en `details` de un error de `all-or-nothing` (D1): `items[7]`. Un fallo de forma del
 * elemento lleva además la del campo (`items[7].price must be …`), que es lo que ya escribe la validación del borde.
 */
export function batchItemPath(over, index) {
  return `${over}[${index}]`;
}

/**
 * ¿Falla solo su elemento? Lo que declara `itemErrors` y un fallo de forma del elemento (D3). Lo demás —un error
 * declarado fuera de `itemErrors`, un conflicto del framework, un fallo sin `code`— detiene el lote (D4).
 */
export function isItemFailure(plan, code) {
  return code === FRAMEWORK_ERRORS.validation.code || (plan.itemErrors ?? []).includes(code);
}

/**
 * La respuesta de un lote a partir de los desenlaces de sus elementos, en orden de índice. Cada desenlace es
 * `{ ok: true, result }` o `{ ok: false, code, message }` (`code` null: un fallo sin code, D4). Los desenlaces que
 * siguen al que detiene el lote se ignoran: esos elementos no llegan a intentarse.
 *
 * - `per-item`: `{ status: 207, body: { summary, items } }`, también si todo salió bien (D1).
 * - `all-or-nothing` sin fallos: `{ status: 'success', body }` con el mismo cuerpo; el status es el `successStatus` del
 *   endpoint. Con un fallo: `{ status: 'error', committed: false, index, code, details }`, el error del elemento
 *   culpable con su ruta en `details`; nada queda confirmado.
 */
export function batchResponse(plan, outcomes) {
  if (plan.atomicity === 'all-or-nothing') {
    const index = outcomes.findIndex((outcome) => !outcome.ok);
    if (index >= 0) {
      const failed = outcomes[index];
      return { status: 'error', committed: false, index, code: failed.code ?? null, details: [batchItemPath(plan.over, index)] };
    }
    return { status: 'success', body: batchBody(outcomes.map((outcome, at) => succeeded(at, outcome))) };
  }
  const items = [];
  let stopped = false;
  outcomes.forEach((outcome, index) => {
    if (stopped) {
      items.push(batchItem(index, 'notAttempted'));
      return;
    }
    if (outcome.ok) {
      items.push(succeeded(index, outcome));
      return;
    }
    if (isItemFailure(plan, outcome.code)) {
      items.push(batchItem(index, 'failed', { error: outcome.code, message: outcome.message ?? null }));
      return;
    }
    // D4: el elemento que detiene el lote queda failed con su code, o con BATCH_ABORTED si no tiene; lo confirmado antes
    // no se deshace, y los siguientes quedan notAttempted para que el cliente sepa qué reenviar.
    stopped = true;
    items.push(
      outcome.code
        ? batchItem(index, 'failed', { error: outcome.code, message: outcome.message ?? null })
        : batchItem(index, 'failed', { error: FRAMEWORK_ERRORS.batchAborted.code, message: BATCH_ABORTED_MESSAGE })
    );
  });
  return { status: BATCH_MULTI_STATUS, body: batchBody(items) };
}

function succeeded(index, outcome) {
  return batchItem(index, 'succeeded', { result: outcome.result ?? null });
}

/** Un elemento del 207 con su forma estable: las cinco claves siempre, `null` donde no aplica (wire-contract.md). */
export function batchItem(index, status, { result = null, error = null, message = null } = {}) {
  return { index, status, result, error, message };
}

/** El cuerpo del 207: el resumen y los elementos, en orden de índice. */
export function batchBody(items) {
  const count = (status) => items.filter((item) => item.status === status).length;
  return {
    summary: { total: items.length, succeeded: count('succeeded'), failed: count('failed'), notAttempted: count('notAttempted') },
    items
  };
}

// ─── El contrato ─────────────────────────────────────────────────────────────

/**
 * Lo que la descripción de la respuesta de un lote dice en el contrato formal (`gen/openapi.js`): la forma no basta para
 * saber qué falla solo su elemento, qué detiene el lote ni qué queda confirmado. null si la operación no es un lote.
 */
export function batchContractClause(batch) {
  if (!batch) return null;
  if (batch.atomicity === 'all-or-nothing') {
    return (
      `Lote todo o nada (DSL 2.30): un resultado por elemento de '${batch.over}', en orden de índice. Con un fallo no queda ` +
      `nada confirmado y la respuesta es el error de ese elemento, con su ruta en details (${batchItemPath(batch.over, 0)}).`
    );
  }
  const skipped = [...batch.itemErrors, FRAMEWORK_ERRORS.validation.code].join(', ');
  return (
    `Lote por elemento (DSL 2.30): siempre ${BATCH_MULTI_STATUS}, con un resultado por elemento de '${batch.over}' en orden de ` +
    `índice, cada uno confirmado en su propia transacción. Fallan solo su elemento ${skipped}. Cualquier otro fallo ` +
    `detiene el lote: ese elemento sale failed con su code (${FRAMEWORK_ERRORS.batchAborted.code} si no tiene), lo ` +
    'anterior queda confirmado y lo siguiente sale notAttempted.'
  );
}

/**
 * Lo que ningún generador sabe generar todavía de un lote síncrono, con el mismo mensaje en los cuatro: la idempotencia
 * del lote entero (D5, BA-8), cuya repetición devuelve el mismo 207. El handler procesa un elemento, así que la de la
 * operación sola deduplicaría cada elemento y no el lote; generarla a medias respondería otra cosa en la repetición.
 */
export function batchFrontierErrors(layers, generator) {
  return batchOperations(layers)
    .filter(({ op }) => op.idempotency)
    .map(
      ({ operation }) =>
        `use-cases: ${operation}.batch con idempotency (DSL 2.30, D5): ${generator} todavía no genera la idempotencia del ` +
        'lote entero —la repetición tiene que devolver el mismo resultado sin volver a procesarlo—. Quita idempotency del ' +
        'lote (la clave natural de cada elemento ya lo guarda de duplicarse) o espera a que se genere.'
    );
}

// ─── La frontera de los generadores ──────────────────────────────────────────

/**
 * Lo que un generador todavía no emite de los lotes, con el mismo mensaje en los cuatro: lo llama cada
 * `supported-features.js` hasta su incremento de PLAN-DSL-230-LOTES.md. `syncIncrement` trae el modo `sync`;
 * `async` llega en la fase B (`asyncIncrement`). Un lote a medias responde 200 con un elemento confirmado y el resto
 * perdido sin decirlo, y por eso se rechaza entero.
 */
export function batchPendingErrors(layers, generator, { syncIncrement = null, asyncIncrement }) {
  const errors = [];
  for (const { operation, batch } of batchOperations(layers)) {
    const execution = batchExecutionOf(batch);
    const increment = execution === 'async' ? asyncIncrement : syncIncrement;
    if (increment === null || increment === undefined) continue;
    errors.push(
      `use-cases: ${operation}.batch (execution: ${execution}, DSL 2.30): ${generator} todavía no lo genera — llega en el ` +
        `incremento ${increment} de PLAN-DSL-230-LOTES.md, y a medias fallaría en silencio. Quita batch para generar este diseño.`
    );
  }
  return errors;
}

// ─── Lo que emite cada generador, desde el modelo ────────────────────────────

/** Las operaciones del modelo que son lotes: `{ operation, batch }`. */
export function batchModelOperations(model) {
  return (model.services ?? [])
    .flatMap((group) => group.operations ?? [])
    .filter((operation) => operation.batch)
    .map((operation) => ({ operation: operation.name, batch: operation.batch }));
}

/** ¿Tiene el servicio algún lote? */
export function usesBatch(model) {
  return batchModelOperations(model).length > 0;
}

/**
 * La nota del handler de una operación por lotes, la misma en los cuatro generadores: el handler procesa UN elemento y
 * el bucle, la transacción por elemento y la respuesta los pone el generador.
 */
export function batchNote(batch) {
  const lines = [
    `Lote (DSL 2.30): este handler procesa UN elemento de '${batch.over}' (${batch.itemType}); el bucle, la validación de cada elemento y la respuesta los pone el generador.`
  ];
  if (batch.atomicity === 'per-item') {
    lines.push('Una transacción por elemento, en orden de índice: lo que falla aquí no deshace los elementos anteriores.');
    lines.push(
      batch.itemErrors.length > 0
        ? `Fallan solo su elemento: ${batch.itemErrors.join(', ')} y ${FRAMEWORK_ERRORS.validation.code}. Cualquier otro error detiene el lote: lánzalo y no lo captures.`
        : `Falla solo su elemento ${FRAMEWORK_ERRORS.validation.code}. Cualquier error detiene el lote: lánzalo y no lo captures.`
    );
  } else {
    lines.push('Todos los elementos en una transacción: el primer error la revierte entera y responde con el índice del culpable.');
  }
  lines.push(
    batch.resultFields.length > 0
      ? `Devuelve el resultado del elemento: ${batch.resultFields.map((field) => field.name).join(', ')}.`
      : 'No devuelve nada por elemento: su result es null.'
  );
  return lines;
}

// ─── Casos y sabotajes ───────────────────────────────────────────────────────

/** Los casos de un lote síncrono que los cuatro generadores ejecutan con el mismo id, y en qué red. */
export const BATCH_CASES = Object.freeze([
  { id: 'BA-1', level: 'adapter', asserts: 'per-item: un lote sin fallos responde 207 con todos succeeded y su result, en orden de índice' },
  { id: 'BA-2', level: 'adapter', asserts: 'per-item: un error de itemErrors falla solo su elemento y el siguiente se confirma' },
  { id: 'BA-3', level: 'adapter', asserts: 'per-item: un elemento con una cota incumplida es failed con VALIDATION_ERROR y no un 400 del lote' },
  { id: 'BA-4', level: 'adapter', asserts: 'per-item: un error no declarado detiene el lote; lo anterior queda confirmado y lo siguiente notAttempted' },
  { id: 'BA-5', level: 'adapter', asserts: 'per-item: dos elementos con la misma clave natural en el mismo lote fallan siempre en el segundo' },
  { id: 'BA-6', level: 'adapter', asserts: 'all-or-nothing: un fallo revierte el lote entero y responde su error con el índice del culpable en details' },
  { id: 'BA-7', level: 'adapter', asserts: 'el sobre: exceder maxItems o el campo over ausente es un 400 del lote, sin procesar ningún elemento' },
  { id: 'BA-8', level: 'adapter', asserts: 'idempotency de la operación: la repetición del lote devuelve el mismo 207 sin volver a procesarlo' },
  { id: 'BA-9', level: 'adapter', asserts: 'cada elemento confirmado publica lo que publicaría la operación sola, en su transacción' }
]);

/** Los sabotajes y los casos en los que tiene que caer cada uno: exactamente esos. */
export const BATCH_SABOTAGES = Object.freeze({
  // En UNA transacción, el elemento que falla la marca para revertir y el commit del lote entero falla: también el del
  // duplicado dentro del mismo lote (BA-5), medido en keel-spring.
  'ba-one-tx': ['BA-2', 'BA-4', 'BA-5'],
  'ba-validate-whole': ['BA-3'],
  'ba-continue-on-undeclared': ['BA-4'],
  'ba-status': ['BA-1'],
  // all-or-nothing sin la transacción que abarca el lote: lo anterior al culpable queda confirmado.
  'ba-atomic-no-tx': ['BA-6']
});
