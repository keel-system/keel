// Los LOTES con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`), como decisiones neutrales.
//
// La pregunta que el diseño contesta es «importo 500 filas y fallan 3: ¿qué le digo al cliente de cada una?». Lo que no
// depende del lenguaje se decide aquí, como datos y como referencias ejecutables: qué operaciones son lotes, qué campo
// del input se recorre, qué fallo es solo de su elemento y cuál detiene el lote, y la respuesta que sale de una serie de
// desenlaces. El bucle lo emite cada generador; el handler de la operación procesa UN elemento, como con el historial.
// Primero desde las capas (lo que leen las reglas de `crossrefs.js`) y después desde el modelo.
// Origen y decisiones (D1-D15): PLAN-DSL-230-LOTES.md. La semántica es la de Spring Batch —skip, commit interval y
// reanudación—, sin la librería.

import { createHash } from 'node:crypto';
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

/** El status del alta de un lote asíncrono (D8): el trabajo queda creado y se procesa después. */
export const BATCH_ACCEPTED_STATUS = 202;

/**
 * El status con que responde el éxito de una operación, lote o no: el asíncrono, 202; el `per-item`, SIEMPRE 207 (D1); el
 * resto, el de su ruta. Lo leen el contrato y las tablas de rutas de los generadores, para que digan lo mismo.
 */
export function batchSuccessStatus(operation) {
  const batch = operation.batch;
  if (batch?.execution === 'async') return BATCH_ACCEPTED_STATUS;
  if (batch?.atomicity === 'per-item') return BATCH_MULTI_STATUS;
  return operation.route.status;
}

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

// ─── El trabajo de un lote asíncrono (fase B, D8-D13): referencias ejecutables ─

/**
 * Las dos rutas del trabajo de una operación asíncrona, colgadas de la suya (D8): el estado y los resultados paginados.
 * La regla de acceso es la de la operación (D11).
 */
export function batchJobPaths(path) {
  return { status: `${path}/jobs/{jobId}`, results: `${path}/jobs/{jobId}/results` };
}

/** El parámetro de ruta del trabajo en las dos rutas. */
export const BATCH_JOB_PARAM = 'jobId';

/**
 * El trabajo en el cable (`batchJob` de wire.js), desde su fila: el resumen cuenta `notAttempted` solo cuando el trabajo se
 * detuvo (D4): los que quedan por procesar de uno en marcha no se han intentado todavía, pero tampoco se han descartado.
 */
export function batchJobView(row) {
  const notAttempted = row.status === 'aborted' ? row.total - row.nextIndex : 0;
  return {
    id: row.id,
    status: row.status,
    summary: { total: row.total, succeeded: row.succeeded, failed: row.failed, notAttempted },
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? null
  };
}

/**
 * La firma de la petición de un lote asíncrono (D13): el sha256 en hexadecimal de los BYTES del cuerpo tal como llegaron.
 * Es lo único que los cuatro calculan igual sin canonizar el JSON; un reintento manda los mismos bytes, y uno que reformatea
 * el cuerpo es otra petición. Con keySource payload-hash, la clave es esta misma firma.
 */
export function batchRequestSignature(body) {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Qué hace el alta ante una clave (D13): `create` si no hay trabajo vivo con ella (ninguno, o su ventana pasó), `same` si
 * lo hay con la misma firma —responde 202 con el mismo Location y el trabajo en el estado en que esté— y `reused` si la
 * firma es otra —IDEMPOTENCY_KEY_REUSED—. `existing` es `{ signature, keyExpiresAt }` o null; `now` la hora del motor.
 */
export function batchJobRepeat(existing, signature, now) {
  if (!existing) return 'create';
  if (existing.keyExpiresAt !== null && existing.keyExpiresAt !== undefined && existing.keyExpiresAt <= now) return 'create';
  return existing.signature === signature ? 'same' : 'reused';
}

/**
 * Qué hace un lote SÍNCRONO con clave ante ella (D15): `create` si no hay trabajo vivo con ella (ninguno, o su ventana
 * pasó); `reused` si lo hay con otra firma (IDEMPOTENCY_KEY_REUSED); `replay` si terminó (la respuesta guardada, sin
 * procesar nada); `in-progress` si sigue en marcha —su última escritura es más reciente que `staleMs`: 409
 * IDEMPOTENCY_KEY_IN_PROGRESS—; y `resume` si quien lo procesaba murió a mitad: lo toma y sigue desde el cursor, y la
 * valla protege si en realidad seguía vivo. `existing` es `{ signature, keyExpiresAt, finishedAt, updatedAt }` o null y
 * `now` la hora del motor; en SQL, la frontera entre `in-progress` y `resume` la traza `takeOver` con la hora del motor.
 */
export function batchSyncRepeat(existing, signature, now, staleMs) {
  const repeat = batchJobRepeat(existing, signature, now);
  if (repeat !== 'same') return repeat;
  if (existing.finishedAt !== null && existing.finishedAt !== undefined) return 'replay';
  return existing.updatedAt <= now - staleMs ? 'resume' : 'in-progress';
}

/**
 * El cuerpo de un lote síncrono con clave, rehecho desde lo guardado (D15): los resultados escritos, en orden de índice, y,
 * si el trabajo se detuvo (aborted), un `notAttempted` por cada elemento desde el cursor. Es el MISMO cuerpo que
 * `batchResponse` da para esos desenlaces, y lo responden igual la primera petición, la que reanuda y la repetición. `row`
 * es `{ status, total, nextIndex }`; cada resultado, `{ index, status, result, error, message }`.
 */
export function batchStoredBody(row, results) {
  const items = [...results]
    .sort((a, b) => a.index - b.index)
    .map((stored) => batchItem(stored.index, stored.status, { result: stored.result ?? null, error: stored.error ?? null, message: stored.message ?? null }));
  if (row.status === 'aborted') for (let index = row.nextIndex; index < row.total; index += 1) items.push(batchItem(index, 'notAttempted'));
  return batchBody(items);
}

/** Un trabajo recién creado, como lo deja el alta. */
export function newBatchJob(total) {
  return { status: 'queued', total, nextIndex: 0, succeeded: 0, failed: 0, results: [] };
}

/**
 * Un disparo del temporizador de un trabajo (D9), en memoria: procesa hasta `chunkSize` elementos desde el cursor, cada uno
 * con su resultado, y dice si queda trabajo (`more`: rearmar el temporizador) o si terminó. `outcomeOf(index)` da el
 * desenlace de un elemento como en `batchResponse` (`{ ok, result }` o `{ ok: false, code, message }`); `crashAfter`, si se
 * da, simula que la réplica cae tras confirmar esos elementos del chunk: lo confirmado queda, y el temporizador se vuelve a
 * disparar desde el cursor. Devuelve el estado nuevo (sin mutar el de entrada).
 */
export function runBatchChunk(job, { plan, outcomeOf, chunkSize, crashAfter = null }) {
  const state = { ...job, results: [...job.results] };
  let done = 0;
  while (state.nextIndex < state.total && done < chunkSize) {
    if (crashAfter !== null && done === crashAfter) return { state, more: true, crashed: true };
    const index = state.nextIndex;
    const outcome = outcomeOf(index);
    done += 1;
    state.status = 'running';
    state.nextIndex = index + 1;
    if (outcome.ok) {
      state.succeeded += 1;
      state.results.push(batchItem(index, 'succeeded', { result: outcome.result ?? null }));
      continue;
    }
    state.failed += 1;
    if (isItemFailure(plan, outcome.code)) {
      state.results.push(batchItem(index, 'failed', { error: outcome.code, message: outcome.message ?? null }));
      continue;
    }
    // D4: el elemento que detiene el lote, con su code o con BATCH_ABORTED; los que quedan son notAttempted.
    state.results.push(
      outcome.code
        ? batchItem(index, 'failed', { error: outcome.code, message: outcome.message ?? null })
        : batchItem(index, 'failed', { error: FRAMEWORK_ERRORS.batchAborted.code, message: BATCH_ABORTED_MESSAGE })
    );
    state.status = 'aborted';
    return { state, more: false, crashed: false };
  }
  if (state.nextIndex >= state.total) {
    state.status = 'completed';
    return { state, more: false, crashed: false };
  }
  return { state, more: true, crashed: false };
}

// ─── El contrato ─────────────────────────────────────────────────────────────

/**
 * Lo que la descripción de la respuesta de un lote dice en el contrato formal (`gen/openapi.js`): la forma no basta para
 * saber qué falla solo su elemento, qué detiene el lote ni qué queda confirmado. null si la operación no es un lote.
 */
export function batchContractClause(batch) {
  if (!batch) return null;
  if (batch.execution === 'async') {
    const skipped = [...batch.itemErrors, FRAMEWORK_ERRORS.validation.code].join(', ');
    return (
      `Lote asíncrono (DSL 2.30): responde ${BATCH_ACCEPTED_STATUS} con el trabajo y su URL en Location, sin procesar nada en la ` +
      `petición. El trabajo procesa '${batch.over}' por partes, cada elemento en su propia transacción, y solo lo lee quien ` +
      `lo creó. Fallan solo su elemento ${skipped}; cualquier otro fallo detiene el trabajo (aborted) y lo que queda sale ` +
      'notAttempted. Con idempotency, repetir la clave devuelve el mismo trabajo en el estado en que esté.'
    );
  }
  if (batch.atomicity === 'all-or-nothing') {
    return (
      `Lote todo o nada (DSL 2.30): un resultado por elemento de '${batch.over}', en orden de índice. Con un fallo no queda ` +
      `nada confirmado y la respuesta es el error de ese elemento, con su ruta en details (${batchItemPath(batch.over, 0)}).` +
      (batch.idempotency
        ? ` Con idempotency, repetir la clave de un lote confirmado devuelve la misma respuesta sin volver a procesarlo; uno ` +
          `que falló no se guarda, y repetirlo lo vuelve a procesar. ${syncInProgressClause()}`
        : '')
    );
  }
  const skipped = [...batch.itemErrors, FRAMEWORK_ERRORS.validation.code].join(', ');
  return (
    `Lote por elemento (DSL 2.30): siempre ${BATCH_MULTI_STATUS}, con un resultado por elemento de '${batch.over}' en orden de ` +
    `índice, cada uno confirmado en su propia transacción. Fallan solo su elemento ${skipped}. Cualquier otro fallo ` +
    `detiene el lote: ese elemento sale failed con su code (${FRAMEWORK_ERRORS.batchAborted.code} si no tiene), lo ` +
    'anterior queda confirmado y lo siguiente sale notAttempted.' +
    (batch.idempotency
      ? ' Con idempotency, repetir la clave devuelve el mismo 207 sin volver a procesar el lote; si el primero se cortó a ' +
        `mitad, la repetición sigue desde el último elemento confirmado. ${syncInProgressClause()}`
      : '')
  );
}

/**
 * Lo que responde la repetición de un lote síncrono con clave que sigue en marcha (D15). Sin `code`: el diseño puede
 * sustituir el canónico, y el contrato ya lista el de la operación entre sus respuestas.
 */
function syncInProgressClause() {
  return `Mientras el primero sigue en marcha, responde ${FRAMEWORK_ERRORS.idempotencyRace.http}, el error de la clave en curso.`;
}

/**
 * Lo que ningún generador sabe generar todavía de un lote, con el mismo mensaje en los cuatro:
 *   · en `sync`, la idempotencia del lote entero (D15) mientras el generador no la genera (`syncIdempotency` false): la
 *     repetición devuelve la respuesta guardada en el trabajo (`batch_job`), y la de la operación sola deduplicaría cada
 *     elemento y no el lote;
 *   · en cualquier modo, la clave de un lote que es un campo (`payload-field`) o que se acota por campos (`partitionBy`):
 *     un lote se acota por su dueño (D13), y el campo de la clave no está en ningún elemento;
 *   · en `async`, una operación cuyo mensaje lleva la identidad del llamante (`callerIdentity`): el trabajo se procesa
 *     fuera de la petición, sin token, y la identidad no viaja en el sobre guardado.
 */
export function batchFrontierErrors(layers, generator, { syncIdempotency = false } = {}) {
  const errors = [];
  const identityField = layers.security?.authentication?.callerIdentity?.field ?? null;
  for (const { operation, op, batch } of batchOperations(layers)) {
    const execution = batchExecutionOf(batch);
    const idempotency = op.idempotency;
    if (idempotency && execution === 'sync' && !syncIdempotency) {
      errors.push(
        `use-cases: ${operation}.batch con idempotency (DSL 2.30, D15): ${generator} todavía no genera la idempotencia del ` +
          'lote síncrono entero —la repetición tiene que devolver la misma respuesta sin volver a procesarlo; llega en el ' +
          'incremento 10b de PLAN-DSL-230-LOTES.md—. Quita idempotency del lote (la clave natural de cada elemento ya lo ' +
          'guarda de duplicarse), declara execution: async o espera a que se genere.'
      );
    } else if (idempotency && (idempotency.keySource === 'payload-field' || idempotency.partitionBy)) {
      errors.push(
        `use-cases: ${operation}.idempotency en un lote (DSL 2.30, D13): ${generator} genera la clave de un lote con ` +
          'keySource client-key o payload-hash, acotada por el dueño del trabajo; payload-field y partitionBy no tienen ' +
          'sentido en un lote todavía. Usa client-key o payload-hash.'
      );
    }
    const fields = typeof op.input === 'object' ? op.input?.fields ?? {} : {};
    if (execution === 'async' && identityField && Object.hasOwn(fields, identityField)) {
      errors.push(
        `use-cases: ${operation}.batch (execution: async) con la identidad del llamante en el input ` +
          `(${identityField}, DSL 2.30): ${generator} procesa el trabajo fuera de la petición, sin token, y la identidad no ` +
          'viaja en el sobre guardado. Quita el campo del input, o declara execution: sync.'
      );
    }
  }
  return errors;
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

/** Las operaciones del modelo que son lotes ASÍNCRONOS (fase B): `{ operation, batch }`. */
export function asyncBatchOperations(model) {
  return batchModelOperations(model).filter(({ batch }) => batch.execution === 'async');
}

/** Los lotes SÍNCRONOS con clave (D15): su clave y su respuesta las guarda el trabajo (`batch_job`), sin temporizador. */
export function keyedSyncBatchOperations(model) {
  return batchModelOperations(model).filter(({ batch }) => batch.execution !== 'async' && batch.idempotency);
}

/** Los lotes que usan el almacén de trabajos (`batch_job`, su purga): los asíncronos y los síncronos con clave. */
export function batchJobStoreOperations(model) {
  return batchModelOperations(model).filter(({ batch }) => batch.execution === 'async' || batch.idempotency);
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
  if (batch.execution === 'async') {
    lines.push(
      'Lote asíncrono: se procesa por partes fuera de la petición, sin token. El actor de autoría de cada elemento es el dueño del trabajo, y lo que el handler lea de la petición tiene que venir en el mensaje.'
    );
  }
  if (batch.idempotency && batch.execution !== 'async') {
    lines.push('Lote con clave: la repetición la resuelve el generador con la respuesta guardada, sin llamar a este handler.');
  }
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
  { id: 'BA-8', level: 'adapter', asserts: 'idempotency de la operación (D15): la miden BK-1 a BK-5 sobre los sujetos con clave' },
  { id: 'BA-9', level: 'adapter', asserts: 'cada elemento confirmado publica lo que publicaría la operación sola, en su transacción' }
]);

/** Los casos de un lote SÍNCRONO con clave (D15) que los cuatro generadores ejecutan con el mismo id. */
export const BATCH_KEY_CASES = Object.freeze([
  { id: 'BK-1', level: 'adapter', asserts: 'per-item: repetir la clave de un lote terminado devuelve el MISMO 207 sin procesar nada (ni efectos, ni resultados nuevos)' },
  { id: 'BK-2', level: 'adapter', asserts: 'la misma clave con otro cuerpo es IDEMPOTENCY_KEY_REUSED sin procesar nada; pasada su ventana, un lote nuevo' },
  { id: 'BK-3', level: 'adapter', asserts: 'la repetición mientras el primero sigue en marcha es 409 IDEMPOTENCY_KEY_IN_PROGRESS sin procesar nada' },
  { id: 'BK-4', level: 'adapter', asserts: 'reanudación: si el primero murió a mitad, la repetición sigue desde el cursor sin repetir ningún elemento, y su 207 los cuenta todos' },
  { id: 'BK-5', level: 'adapter', asserts: 'all-or-nothing: el lote confirmado se repite con la misma respuesta; uno que falló no deja trabajo, y repetirlo lo vuelve a procesar' }
]);

/** Los sabotajes de la clave de un lote síncrono y los casos en los que tiene que caer cada uno: exactamente esos. */
export const BATCH_KEY_SABOTAGES = Object.freeze({
  // La repetición de un lote terminado lo vuelve a procesar en vez de devolver lo guardado.
  'bk-replay-reprocess': ['BK-1'],
  // Un lote en marcha se toma igual que uno muerto: dos peticiones procesan el mismo lote a la vez.
  'bk-steal-running': ['BK-3'],
  // La reanudación empieza en el principio y no en el cursor.
  'bk-no-resume': ['BK-4'],
  // El todo o nada que falla deja su trabajo: la repetición devuelve un lote que nunca se confirmó.
  'bk-keep-failed': ['BK-5']
});

/** Los casos de un lote ASÍNCRONO (fase B) que los cuatro generadores ejecutan con el mismo id. */
export const BATCH_JOB_CASES = Object.freeze([
  { id: 'BJ-1', level: 'adapter', asserts: 'el alta responde 202 con el trabajo queued y su URL en Location, sin procesar ningún elemento en la petición; el trabajo y su temporizador se crean en la misma transacción' },
  { id: 'BJ-2', level: 'adapter', asserts: 'el temporizador procesa el trabajo por chunks hasta completed; los resultados salen paginados en orden de índice y el resumen cuadra' },
  { id: 'BJ-3', level: 'adapter', asserts: 'un error de itemErrors falla solo su elemento; uno no declarado detiene el trabajo (aborted) y lo que queda cuenta como notAttempted' },
  { id: 'BJ-4', level: 'adapter', asserts: 'reanudación: si la réplica cae a mitad de chunk, otra sigue desde el cursor sin repetir ni perder ningún elemento' },
  { id: 'BJ-5', level: 'adapter', asserts: 'la valla del cursor: el elemento que procesa quien perdió el trabajo revierte entero, efecto incluido' },
  { id: 'BJ-6', level: 'adapter', asserts: 'solo lo lee quien lo creó: otro llamante, u otro id, recibe 404 en las dos rutas' },
  { id: 'BJ-7', level: 'adapter', asserts: 'idempotency (D13): la misma clave responde el mismo 202 con el mismo Location y el estado actual; con otro contenido, IDEMPOTENCY_KEY_REUSED; pasada su ventana, un trabajo nuevo' },
  { id: 'BJ-8', level: 'adapter', asserts: 'la purga se lleva los trabajos terminados hace más de la retención con sus resultados, y nunca uno en marcha' },
  { id: 'BJ-9', level: 'adapter', asserts: 'el sobre: exceder maxItems o el campo over ausente es un 400 sin crear ningún trabajo' }
]);

/** Los sabotajes de la fase B en los generadores y los casos en los que tiene que caer cada uno: exactamente esos. */
export const BATCH_JOB_SABOTAGES = Object.freeze({
  // El procesador empieza cada disparo desde el principio y no desde el cursor.
  'bj-no-resume': ['BJ-4'],
  // El resultado y el cursor se escriben en una transacción aparte, después del elemento: si la réplica cae entre las dos,
  // el elemento se aplica y se vuelve a procesar; y sin la valla en la transacción del elemento, el que perdió el trabajo
  // deja su efecto.
  'bj-cursor-outside-tx': ['BJ-4', 'BJ-5'],
  // Las rutas del trabajo no miran el dueño.
  'bj-foreign-reader': ['BJ-6']
});

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
