// Los LOTES con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`, modo `sync`) en keel-nest: incremento 2 de
// PLAN-DSL-230-LOTES.md, el gemelo del `BatchRunner` de keel-spring. Lo que decide QUÉ (qué operaciones son lotes, qué
// falla solo su elemento, qué detiene el lote, la respuesta como referencia ejecutable, la nota) es de keel-core
// (gen/batch.js); aquí solo se escribe en TypeScript:
//
//   · el lector de la operación (controllers.js) lee el SOBRE: el campo que se recorre llega como `unknown[]` sin leer, y
//     solo se validan su presencia y su `maxItems` (BA-7). Leído con `json.listOf(read<Elemento>)`, el primer elemento
//     mal formado sería un 400 del lote entero (D3);
//   · `batch.ts`: el bucle. Cada elemento se lee con el MISMO `read<Elemento>` que usa el borde (las guardas del
//     constructor del value object incluidas), así que «mal formado» significa lo mismo dentro del lote que fuera, y su
//     fallo es su `failed` con VALIDATION_ERROR. Después se despacha por el mediator, que abre una transacción por
//     elemento (D2) con su reintento del conflicto transitorio. Un fallo se traduce con el propio ApiExceptionFilter: el
//     `code` y el `message` del elemento son los que respondería la operación sola;
//   · `BatchResponse`: la forma de wire-contract.md § Lotes, con las cinco claves de cada elemento siempre (también con
//     `conventions.nulls: omit`: no lleva la marca OmitNulls).
//
// El handler de la operación procesa UN elemento: su mensaje lleva el elemento (`item`) en vez de la lista
// (services.js), y devuelve `<Op>ItemResult` cuando el diseño declara `batch.output` (keel-core/gen/model.js).

import { usesBatch, batchModelOperations, BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, BATCH_MULTI_STATUS } from '@keel-system/keel-core/gen/batch';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { tsModule, tsString } from './render.js';

export const BATCH_TS = 'src/infrastructure/rest/batch.ts';
export const BATCH_ITEM_COMPONENT = 'item';

// Las rutas de lo que importa batch.ts, escritas aquí y no importadas: rest-support.js y exceptions.js importan, a través
// de otros emisores, a services.js, que importa este módulo (un ciclo que revienta al cargar).
const ERROR_RESPONSE_TS = 'src/infrastructure/rest/error-response.ts';
const EXCEPTION_FILTER_TS = 'src/infrastructure/rest/api-exception-filter.ts';
const REQUEST_ERRORS_TS = 'src/infrastructure/rest/request-errors.ts';
const INVALID_VALUE_TS = 'src/domain/errors/invalid-value-exception.ts';
const TRANSACTION_CONTEXT_TS = 'src/infrastructure/persistence/transaction-context.ts';

export { usesBatch };

/** ¿Hay algún lote que se confirma entero? Solo entonces el bucle necesita la transacción abarcadora. */
export const usesAllOrNothing = (model) => batchModelOperations(model).some(({ batch }) => batch.atomicity === 'all-or-nothing');

/** ¿Abre el lote todo o nada una transacción alrededor? Sin persistencia no hay nada que revertir. */
export const atomicTransaction = (model) => usesAllOrNothing(model) && Boolean(model.layersPresent?.persistence);

export function generate(model) {
  if (!usesBatch(model)) return [];
  const transactional = atomicTransaction(model);
  const imports = [
    { symbol: 'ApiExceptionFilter', from: EXCEPTION_FILTER_TS },
    { symbol: 'ErrorResponse', from: ERROR_RESPONSE_TS },
    { symbol: 'MalformedRequestError', from: REQUEST_ERRORS_TS },
    { symbol: 'InvalidValueException', from: INVALID_VALUE_TS },
    ...(transactional ? [{ symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS, type: true }] : [])
  ];
  return [{ path: BATCH_TS, content: tsModule(BATCH_TS, imports, batchBody(model, transactional)) }];
}

function batchBody(model, transactional) {
  const validation = FRAMEWORK_ERRORS.validation.code;
  const aborted = FRAMEWORK_ERRORS.batchAborted.code;
  const atomic = usesAllOrNothing(model);
  const allOrNothing = atomic
    ? `

/** El desenlace de un lote todo o nada: el cuerpo con su successStatus, o el error del elemento culpable. */
export type AtomicOutcome = { readonly ok: true; readonly body: BatchResponse } | { readonly ok: false; readonly error: ErrorResponse };

/**
 * Un lote \`all-or-nothing\`: todos los elementos en UNA transacción${transactional ? '' : ' (sin persistencia no hay ninguna que abrir)'}. El
 * primer fallo la revierte entera y el desenlace es su error, con la ruta del elemento culpable en \`details\`
 * (\`items[7]\`); sin fallos, el mismo cuerpo que un lote por elemento, con el \`successStatus\` del endpoint.
 *
 * Un fallo AL CONFIRMAR no es de ningún elemento: sale sin índice, por el filtro, como el de cualquier operación.
 */
export async function allOrNothing<T>(
  over: string,
  items: readonly unknown[],
  read: (value: unknown) => T | null,
  ${transactional ? 'transactions: TransactionContext' : '_transactions: null'},
  process: (item: T) => Promise<unknown>
): Promise<AtomicOutcome> {
  const work = async (): Promise<BatchItem[]> => {
    const results: BatchItem[] = [];
    for (let index = 0; index < items.length; index++) {
      let item: T;
      try {
        item = readItem(items[index], read);
      } catch (error) {
        throw new ItemFailure(index, invalidResponse(error as InvalidItem));
      }
      try {
        results.push(BatchItem.succeeded(index, await process(item)));
      } catch (error) {
        throw new ItemFailure(index, translate(error), error);
      }
    }
    return results;
  };
  try {
    const results = ${transactional ? 'await transactions.inTransaction(() => work())' : 'await work()'};
    return { ok: true, body: BatchResponse.of(results) };
  } catch (error) {
    if (!(error instanceof ItemFailure)) throw error;
    const failed = error.response;
    return {
      ok: false,
      error: ErrorResponse.of(failed.status, failed.error, failed.code, failed.message, [\`\${over}[\${error.index}]\`])
    };
  }
}

function invalidResponse(invalid: InvalidItem): ErrorResponse {
  return ErrorResponse.of(400, 'Validation Error', VALIDATION_ERROR, invalid.message, null);
}

/** El fallo de un elemento de un lote all-or-nothing: revierte la transacción y lleva su índice hasta la respuesta. */
class ItemFailure extends Error {
  constructor(
    readonly index: number,
    readonly response: ErrorResponse,
    cause?: unknown
  ) {
    super(response.message, { cause });
    this.name = 'ItemFailure';
  }
}`
    : '';
  return `// El bucle de los lotes con resultado por elemento (DSL 2.30, wire-contract.md § Lotes). El handler de la operación
// procesa UN elemento; esto lo llama una vez por elemento, en orden de índice y sin paralelismo, y compone la respuesta.
//
// Cada elemento se lee con el MISMO lector que el borde aplica a una petición suelta (D3): un elemento mal formado es
// su \`failed\` con ${validation}, no un 400 del lote. Su fallo se traduce con ApiExceptionFilter, así que el \`code\` y
// el \`message\` son los que daría la operación sola.
//
// No lo edites: lo regenera build.

/** El fallo de forma de un elemento: falla solo él (D3). */
export const VALIDATION_ERROR = ${tsString(validation)};

/** El elemento que detiene el lote sin un code propio (D4, framework-errors.md). */
export const BATCH_ABORTED = ${tsString(aborted)};

export const BATCH_ABORTED_MESSAGE = ${tsString(BATCH_ABORTED_MESSAGE)};

export const MALFORMED_MESSAGE = ${tsString(BATCH_ITEM_MALFORMED_MESSAGE)};

/** El status de un lote por elemento: siempre el mismo, también si todo salió bien (D1). */
export const MULTI_STATUS = ${BATCH_MULTI_STATUS};

/**
 * Un elemento, con sus cinco claves SIEMPRE: null donde no aplica. Su forma es estable, como la del cuerpo de error, y
 * no depende de conventions.nulls; por eso la clase no lleva la marca OmitNulls.
 */
export class BatchItem {
  private constructor(
    readonly index: number,
    readonly status: 'succeeded' | 'failed' | 'notAttempted',
    readonly result: unknown,
    readonly error: string | null,
    readonly message: string | null
  ) {}

  static succeeded(index: number, result: unknown): BatchItem {
    return new BatchItem(index, 'succeeded', result ?? null, null, null);
  }

  static failed(index: number, error: string, message: string | null): BatchItem {
    return new BatchItem(index, 'failed', null, error, message);
  }

  static notAttempted(index: number): BatchItem {
    return new BatchItem(index, 'notAttempted', null, null, null);
  }
}

/** Cuántos elementos hay y cómo acabó cada uno. */
export class BatchSummary {
  constructor(
    readonly total: number,
    readonly succeeded: number,
    readonly failed: number,
    readonly notAttempted: number
  ) {}
}

/**
 * La respuesta de un lote (wire-contract.md § Lotes): el resumen y un resultado por elemento, en orden de índice. La
 * forma no la declara el diseño: es la misma en todas las operaciones por lotes y en los cuatro generadores.
 */
export class BatchResponse {
  private constructor(
    readonly summary: BatchSummary,
    readonly items: readonly BatchItem[]
  ) {}

  static of(items: readonly BatchItem[]): BatchResponse {
    const count = (status: BatchItem['status']): number => items.filter((item) => item.status === status).length;
    return new BatchResponse(new BatchSummary(items.length, count('succeeded'), count('failed'), count('notAttempted')), [...items]);
  }
}

/**
 * Un lote \`per-item\`: una transacción por elemento (la abre el mediator en cada despacho), y la respuesta es SIEMPRE
 * ${BATCH_MULTI_STATUS} (D1), también si todo salió bien.
 *
 * Fallan solo su elemento los codes de \`itemErrors\` y ${validation}. Cualquier otro fallo DETIENE el lote (D4): ese
 * elemento sale \`failed\` con su code, o con ${aborted} si no tiene; lo anterior queda confirmado y lo siguiente sale
 * \`notAttempted\`, que es lo que el cliente tiene que reenviar.
 */
export async function perItem<T>(
  items: readonly unknown[],
  read: (value: unknown) => T | null,
  itemErrors: ReadonlySet<string>,
  process: (item: T) => Promise<unknown>
): Promise<BatchResponse> {
  const results: BatchItem[] = [];
  let stopped = false;
  for (let index = 0; index < items.length; index++) {
    if (stopped) {
      results.push(BatchItem.notAttempted(index));
      continue;
    }
    let item: T;
    try {
      item = readItem(items[index], read);
    } catch (error) {
      results.push(BatchItem.failed(index, VALIDATION_ERROR, (error as InvalidItem).message));
      continue;
    }
    try {
      results.push(BatchItem.succeeded(index, await process(item)));
    } catch (error) {
      const response = translate(error);
      const code = response.code;
      if (code != null && (code === VALIDATION_ERROR || itemErrors.has(code))) {
        results.push(BatchItem.failed(index, code, response.message));
      } else {
        stopped = true;
        results.push(code != null ? BatchItem.failed(index, code, response.message) : BatchItem.failed(index, BATCH_ABORTED, BATCH_ABORTED_MESSAGE));
      }
    }
  }
  return BatchResponse.of(results);
}${allOrNothing}

/** Un elemento mal formado: su mensaje es el que viaja en el resultado. */
class InvalidItem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidItem';
  }
}

/**
 * El elemento como lo leería el borde: el lector de su value object, con las guardas de su constructor. Un null, o un
 * valor que no se puede leer como el tipo, es su ${validation} con el mensaje de la guarda que lo rechazó, o el genérico.
 */
function readItem<T>(value: unknown, read: (value: unknown) => T | null): T {
  if (value == null) throw new InvalidItem(MALFORMED_MESSAGE);
  try {
    const item = read(value);
    if (item == null) throw new InvalidItem(MALFORMED_MESSAGE);
    return item;
  } catch (error) {
    if (error instanceof InvalidItem) throw error;
    if (error instanceof MalformedRequestError) throw new InvalidItem(guardMessage(error));
    throw error;
  }
}

/** El mensaje de la guarda del value object que rechazó el elemento, o el genérico si no fue una guarda. */
function guardMessage(error: unknown): string {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause === cause ? undefined : cause.cause) {
    if (cause instanceof InvalidValueException && cause.message) return cause.message;
  }
  return MALFORMED_MESSAGE;
}

const ERRORS = new ApiExceptionFilter();

/**
 * El cuerpo de error que respondería la operación sola ante este fallo: el mismo ApiExceptionFilter que traduce las
 * peticiones. Una unicidad que viola el motor sale con el error que el diseño declara para ella, y un fallo inesperado,
 * con el catch-all (sin code, y con su pila en el log).
 */
function translate(error: unknown): ErrorResponse {
  const response = ERRORS.translate(error);
  if (response == null) throw error;
  return response;
}`;
}

/** La llamada del controlador al bucle, con el lector del elemento y el despacho de UN elemento ya resueltos. */
export function controllerBatchCall(model, operation, { envelope, reader, imports }) {
  const batch = operation.batch;
  const message = 'envelope.message(item)';
  const dispatch = batch.resultFields.length > 0
    ? `(item) => this.mediator.dispatch(${message})`
    : `async (item) => {\n        await this.mediator.dispatch(${message});\n        return null;\n      }`;
  if (batch.atomicity === 'per-item') {
    imports.push({ symbol: 'perItem', from: BATCH_TS }, { symbol: 'BatchResponse', from: BATCH_TS, type: true });
    return {
      returnType: 'BatchResponse',
      status: BATCH_MULTI_STATUS,
      statements: `    const envelope = ${envelope};
    return perItem(envelope.${batch.over}, ${reader}, new Set<string>([${batch.itemErrors.map(tsString).join(', ')}]), ${dispatch});`
    };
  }
  imports.push(
    { symbol: 'allOrNothing', from: BATCH_TS },
    { symbol: 'BatchResponse', from: BATCH_TS, type: true },
    { symbol: 'ErrorResponse', from: ERROR_RESPONSE_TS, type: true }
  );
  const transactions = atomicTransaction(model) ? 'this.transactions' : 'null';
  return {
    returnType: 'BatchResponse | ErrorResponse',
    status: operation.route.status,
    reply: true,
    statements: `    const envelope = ${envelope};
    const outcome = await allOrNothing(${tsString(batch.over)}, envelope.${batch.over}, ${reader}, ${transactions}, ${dispatch});
    if (outcome.ok) return outcome.body;
    void reply.status(outcome.error.status);
    return outcome.error;`
  };
}
