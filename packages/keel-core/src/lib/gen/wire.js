// El CONTRATO DEL CABLE (keel-core/gen): cómo viaja cada tipo del DSL en JSON, y la forma de los
// cuerpos que no declara el diseño (el error, la página, la envoltura de eventos).
//
// Es contrato observable y es lo primero que separa a dos servidores «equivalentes» de dos que solo
// lo parecen: un `2.50` que sale como `2.5`, un `long` que pierde los últimos dígitos o un instante
// con seis decimales en vez de tres no rompen ningún escenario que no los mire, y rompen a cualquier
// consumidor que sí. Por eso vive aquí, como DATOS, y cada generador demuestra que lo cumple:
//   · keel-spring, sobre la configuración de Jackson y los records que emite;
//   · keel-nest, ejecutando su serializador y su lector contra estos mismos casos.
//
// La referencia es lo que hacía keel-spring, salvo donde no estaba decidido —la notación de un
// decimal pequeño, que Jackson escribía en exponencial—: ahí el contrato decide y keel-spring se
// ajusta. Documentado para el diseñador en assets/core/docs/wire-contract.md.

/** Reglas, por id estable. Cada caso de abajo cita la suya. */
export const WIRE_RULES = {
  'decimal-scale': 'Un `decimal` viaja como número JSON con la escala que lleva: 2.50 sale 2.50, nunca 2.5.',
  'decimal-plain': 'Un `decimal` sale en notación plana, nunca exponencial: 0.0000001, no 1E-7.',
  'decimal-input': 'Un `decimal` se lee exacto, del texto del número; también desde una cadena numérica.',
  'long-exact': 'Un `long` viaja como número JSON con todos sus dígitos, también por encima de 2^53.',
  'int-number': 'Un `int` viaja como número JSON.',
  'timestamp-utc-millis': 'Un `timestamp` sale como cadena ISO-8601 en UTC con exactamente tres decimales y sufijo Z; se trunca, no se redondea.',
  'timestamp-input': 'Un `timestamp` se lee de una cadena ISO-8601 con zona (Z o ±hh:mm) y se normaliza a UTC.',
  'date-iso': 'Un `date` viaja como cadena YYYY-MM-DD; una fecha que no existe se rechaza.',
  'uuid-string': 'Un `uuid` viaja como cadena en su forma canónica en minúsculas.',
  'json-embedded': 'Un `json` viaja EMBEBIDO como valor JSON, no como cadena escapada; al leer se acepta también la cadena con el documento ya serializado.',
  'enum-value': 'Un enum viaja por el valor que declara el diseño, tal cual.',
  'string-utf8': 'El texto viaja en UTF-8 sin escapar lo que no es ASCII.',
  'boolean-literal': 'Un `boolean` viaja como true o false.',
  'nulls-include': 'Por defecto un campo sin valor viaja como null.',
  'nulls-omit': 'Con `conventions.nulls: omit` un campo sin valor no viaja en las respuestas ni en los payloads de evento; el cuerpo de error lo incluye siempre.',
  'unknown-ignored': 'Una propiedad desconocida en la entrada se ignora.',
  'etag-strong': 'El `ETag` de un recurso con escritura condicional (`api.concurrency`) es su versión entre comillas dobles: fuerte, sin `W/` y opaco para el cliente, que solo lo devuelve tal cual en `If-Match`.',
  'if-match-strong': '`If-Match` se compara en fuerte: `*` se cumple si el recurso existe y una lista si coincide cualquiera de sus elementos; un `W/"…"`, un valor sin comillas o ilegible no coincide (412). Una cabecera vacía cuenta como ausente.',
  'batch-multi-status': 'Un lote `per-item` síncrono (DSL 2.30) responde SIEMPRE 207 con `summary` e `items`, también si todo salió bien; uno `all-or-nothing` responde el mismo cuerpo con su `successStatus`, o el error del elemento culpable con su ruta (`items[7]`) en `details`.',
  'batch-item-stable': 'Cada elemento de un lote lleva siempre `index`, `status`, `result`, `error` y `message`, con `null` donde no aplica: su forma es estable, como la del error, y no depende de `conventions.nulls`.',
  'batch-stop': 'En un lote `per-item`, un fallo fuera de `itemErrors` (y que no es de forma del elemento) detiene el lote: ese elemento sale `failed` con su `code`, o con `BATCH_ABORTED` si no tiene, y los siguientes `notAttempted`.',
  'batch-job-accepted': 'Un lote asíncrono (DSL 2.30) responde 202 con el trabajo y su URL en `Location` (`…/jobs/{jobId}`), sin procesar nada en la petición; con idempotency, repetir la clave responde el mismo 202, con el mismo `Location` y el trabajo en el estado en que esté.',
  'batch-job-summary': 'El trabajo lleva `id`, `status` (`queued`, `running`, `completed`, `aborted`), `summary`, `createdAt` y `finishedAt` (null mientras no termina); `notAttempted` solo cuenta en un trabajo `aborted`, y sus resultados son los de los elementos intentados, paginados en orden de índice con la forma de cada elemento del 207.',
  'query-list': 'Una lista en la query (DSL 2.32) viaja repitiendo el parámetro (`?statuses=active&statuses=draft`); un valor con comas también se parte (`?statuses=active,draft`), así que un elemento que contenga una coma solo viaja repitiéndolo. Ausente no filtra; vacía, o con un elemento vacío, es 400.',
  'client-sort': 'El orden del cliente (DSL 2.32) es `?sort=campo` o `?sort=campo,asc|desc`, repetido para varios; solo sobre los campos de `sortable`, la dirección en minúsculas, y sustituye al orden del diseño. Cualquier otro valor, o un `?sort=` en un listado sin `sortable`, es 400.',
  'list-never-null': 'Una lista (`list: true`) nunca viaja como null: sin elementos sale `[]`, también con `conventions.nulls: omit`, y una lista que la entrada no informa se lee como `[]` (salvo la opcional de un PATCH, que ausente significa «no tocar»).'
};

/**
 * Salida: el valor tipado (escrito como literal del DSL) y el JSON EXACTO que tiene que producir.
 * `json` es el texto del valor, no de un objeto que lo contenga.
 */
export const WIRE_OUTPUT_CASES = [
  { id: 'decimal-keeps-scale', rule: 'decimal-scale', type: 'decimal', value: '2.50', json: '2.50' },
  { id: 'decimal-integer-scale', rule: 'decimal-scale', type: 'decimal', value: '10', json: '10' },
  { id: 'decimal-negative', rule: 'decimal-scale', type: 'decimal', value: '-0.50', json: '-0.50' },
  { id: 'decimal-small-plain', rule: 'decimal-plain', type: 'decimal', value: '0.0000001', json: '0.0000001' },
  { id: 'decimal-large-plain', rule: 'decimal-plain', type: 'decimal', value: '12345678901234567890.12', json: '12345678901234567890.12' },
  { id: 'long-beyond-double', rule: 'long-exact', type: 'long', value: '9007199254740993', json: '9007199254740993' },
  { id: 'long-negative', rule: 'long-exact', type: 'long', value: '-9223372036854775808', json: '-9223372036854775808' },
  { id: 'int', rule: 'int-number', type: 'int', value: '42', json: '42' },
  { id: 'timestamp-millis', rule: 'timestamp-utc-millis', type: 'timestamp', value: '2026-03-14T09:21:07.482Z', json: '"2026-03-14T09:21:07.482Z"' },
  { id: 'timestamp-pads', rule: 'timestamp-utc-millis', type: 'timestamp', value: '2026-03-14T09:21:07Z', json: '"2026-03-14T09:21:07.000Z"' },
  { id: 'timestamp-truncates', rule: 'timestamp-utc-millis', type: 'timestamp', value: '2026-03-14T09:21:07.4829Z', json: '"2026-03-14T09:21:07.482Z"' },
  { id: 'date', rule: 'date-iso', type: 'date', value: '2026-03-14', json: '"2026-03-14"' },
  { id: 'uuid', rule: 'uuid-string', type: 'uuid', value: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', json: '"0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e"' },
  { id: 'json-embedded', rule: 'json-embedded', type: 'json', value: '{"a":[1,2],"b":"x"}', json: '{"a":[1,2],"b":"x"}' },
  { id: 'enum-value', rule: 'enum-value', type: 'enum', value: 'in-review', json: '"in-review"' },
  { id: 'boolean', rule: 'boolean-literal', type: 'boolean', value: 'true', json: 'true' },
  { id: 'string-utf8', rule: 'string-utf8', type: 'string', value: 'Ñandú "x"', json: '"Ñandú \\"x\\""' }
];

/**
 * Entrada: el JSON que llega y el JSON que sale tras leerlo con su tipo y volver a escribirlo. Formular
 * la entrada como ida y vuelta la hace comparable entre lenguajes: no hace falta saber cómo representa
 * cada uno el valor, solo que no lo altera.
 */
export const WIRE_INPUT_CASES = [
  { id: 'decimal-scale-kept', rule: 'decimal-input', type: 'decimal', json: '2.50', roundTrip: '2.50' },
  { id: 'decimal-from-string', rule: 'decimal-input', type: 'decimal', json: '"2.50"', roundTrip: '2.50' },
  { id: 'decimal-exponent', rule: 'decimal-input', type: 'decimal', json: '1E-7', roundTrip: '0.0000001' },
  { id: 'long-exact', rule: 'long-exact', type: 'long', json: '9007199254740993', roundTrip: '9007199254740993' },
  { id: 'long-from-string', rule: 'long-exact', type: 'long', json: '"9007199254740993"', roundTrip: '9007199254740993' },
  { id: 'timestamp-offset', rule: 'timestamp-input', type: 'timestamp', json: '"2026-03-14T10:21:07.482+01:00"', roundTrip: '"2026-03-14T09:21:07.482Z"' },
  { id: 'timestamp-micros', rule: 'timestamp-input', type: 'timestamp', json: '"2026-03-14T09:21:07.482917Z"', roundTrip: '"2026-03-14T09:21:07.482Z"' },
  { id: 'date', rule: 'date-iso', type: 'date', json: '"2026-03-14"', roundTrip: '"2026-03-14"' },
  { id: 'json-object', rule: 'json-embedded', type: 'json', json: '{"a":1}', roundTrip: '{"a":1}' },
  { id: 'json-as-string', rule: 'json-embedded', type: 'json', json: '"{\\"a\\":1}"', roundTrip: '{"a":1}' }
];

/** Entrada que se RECHAZA (400 en la API): un valor que no es de su tipo no se adivina. */
export const WIRE_REJECTED_INPUTS = [
  { id: 'decimal-not-number', rule: 'decimal-input', type: 'decimal', json: '"dos"' },
  { id: 'long-not-number', rule: 'long-exact', type: 'long', json: '"x1"' },
  { id: 'timestamp-not-iso', rule: 'timestamp-input', type: 'timestamp', json: '"ayer"' },
  { id: 'date-impossible', rule: 'date-iso', type: 'date', json: '"2026-02-30"' }
];

/**
 * La forma —claves y su ORDEN— de los cuerpos que el diseño no declara. El orden importa: un consumidor
 * que compara cuerpos como texto, una firma sobre el cuerpo o un snapshot de prueba lo ven.
 */
export const WIRE_SHAPES = {
  // `correlationId` va al final: lo lleva todo servicio con API, que es el único que tiene cuerpo de error.
  errorResponse: ['timestamp', 'status', 'error', 'code', 'message', 'details', 'correlationId'],
  pagedResponse: ['items', 'page', 'size', 'totalElements', 'totalPages'],
  eventEnvelope: ['metadata', 'data'],
  eventMetadata: ['eventId', 'eventType', 'eventVersion', 'occurredAt', 'source', 'correlationId', 'traceparent'],
  // El resultado de un lote (DSL 2.30): el cuerpo del 207 y cada elemento, con su forma estable.
  batchResponse: ['summary', 'items'],
  batchSummary: ['total', 'succeeded', 'failed', 'notAttempted'],
  batchItem: ['index', 'status', 'result', 'error', 'message'],
  // El trabajo de un lote asíncrono (DSL 2.30, fase B). Sus resultados van en el sobre de página (`pagedResponse`), con la
  // forma de `batchItem` en cada elemento.
  batchJob: ['id', 'status', 'summary', 'createdAt', 'finishedAt']
};

/**
 * La ESCRITURA CONDICIONAL (DSL 2.25, `api.concurrency`): el `ETag` que da una lectura a partir de la versión de la
 * raíz, y cómo se lee el `If-Match` de una escritura. Son casos y no código porque los cuatro servidores tienen que
 * llegar a lo mismo: lo que el borde de cada uno estampa en el mensaje (`expected`: la lista de versiones que valen,
 * `null` si no se compara) y si la versión vigente (`current`) lo cumple.
 *
 * `expected: []` es una cabecera presente que no puede coincidir con nada (débil o ilegible): da 412 y no 400, para no
 * abrir una rama más que medir (D2 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md).
 */
export const WIRE_ETAG_CASES = [
  { id: 'etag-version', rule: 'etag-strong', version: 7, etag: '"7"' },
  { id: 'etag-first-version', rule: 'etag-strong', version: 0, etag: '"0"' }
];

export const WIRE_IF_MATCH_CASES = [
  { id: 'if-match-absent', rule: 'if-match-strong', header: null, current: 7, expected: null, outcome: 'absent' },
  { id: 'if-match-blank', rule: 'if-match-strong', header: '  ', current: 7, expected: null, outcome: 'absent' },
  { id: 'if-match-equal', rule: 'if-match-strong', header: '"7"', current: 7, expected: [7], outcome: 'match' },
  { id: 'if-match-padded', rule: 'if-match-strong', header: '  "7" ', current: 7, expected: [7], outcome: 'match' },
  { id: 'if-match-other', rule: 'if-match-strong', header: '"6"', current: 7, expected: [6], outcome: 'no-match' },
  { id: 'if-match-star', rule: 'if-match-strong', header: '*', current: 7, expected: null, outcome: 'match' },
  { id: 'if-match-list-hit', rule: 'if-match-strong', header: '"5", "7"', current: 7, expected: [5, 7], outcome: 'match' },
  { id: 'if-match-list-miss', rule: 'if-match-strong', header: '"5","6"', current: 7, expected: [5, 6], outcome: 'no-match' },
  { id: 'if-match-list-with-weak', rule: 'if-match-strong', header: 'W/"7", "5"', current: 7, expected: [5], outcome: 'no-match' },
  { id: 'if-match-weak', rule: 'if-match-strong', header: 'W/"7"', current: 7, expected: [], outcome: 'no-match' },
  { id: 'if-match-unquoted', rule: 'if-match-strong', header: '7', current: 7, expected: [], outcome: 'no-match' },
  { id: 'if-match-leading-zero', rule: 'if-match-strong', header: '"07"', current: 7, expected: [], outcome: 'no-match' },
  { id: 'if-match-unreadable', rule: 'if-match-strong', header: 'siete', current: 7, expected: [], outcome: 'no-match' }
];

/**
 * El TRABAJO de un lote asíncrono (DSL 2.30, fase B) en el cable, desde su fila: la referencia ejecutable es `batchJobView`
 * de `batch.js`. Los cuatro generadores ejecutan estos casos con el mismo id.
 */
export const WIRE_BATCH_JOB_CASES = [
  {
    id: 'batch-job-queued',
    rule: 'batch-job-summary',
    row: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'queued', total: 500, nextIndex: 0, succeeded: 0, failed: 0, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: null },
    job: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'queued', summary: { total: 500, succeeded: 0, failed: 0, notAttempted: 0 }, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: null }
  },
  {
    id: 'batch-job-running',
    rule: 'batch-job-summary',
    row: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'running', total: 500, nextIndex: 200, succeeded: 198, failed: 2, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: null },
    job: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'running', summary: { total: 500, succeeded: 198, failed: 2, notAttempted: 0 }, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: null }
  },
  {
    id: 'batch-job-aborted',
    rule: 'batch-job-summary',
    row: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'aborted', total: 500, nextIndex: 301, succeeded: 299, failed: 2, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: '2026-11-14T10:03:12.400Z' },
    job: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'aborted', summary: { total: 500, succeeded: 299, failed: 2, notAttempted: 199 }, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: '2026-11-14T10:03:12.400Z' }
  },
  {
    id: 'batch-job-completed',
    rule: 'batch-job-accepted',
    row: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'completed', total: 3, nextIndex: 3, succeeded: 3, failed: 0, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: '2026-11-14T10:00:01.000Z' },
    job: { id: '0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e', status: 'completed', summary: { total: 3, succeeded: 3, failed: 0, notAttempted: 0 }, createdAt: '2026-11-14T10:00:00.000Z', finishedAt: '2026-11-14T10:00:01.000Z' }
  }
];

/**
 * Los LOTES (DSL 2.30, `use-cases.<op>.batch`): la respuesta que sale de una serie de desenlaces, en orden de índice.
 * `outcomes` es lo que devolvió cada elemento (`ok` con su `result`, o el `code` con que falló; `code: null` es un fallo
 * sin code). `response` es lo que tiene que responder el servidor; la referencia ejecutable es `batchResponse` de
 * `batch.js`. Los cuatro generadores ejecutan estos casos con el mismo id.
 */
export const WIRE_BATCH_CASES = [
  {
    id: 'batch-all-succeeded',
    rule: 'batch-multi-status',
    plan: { over: 'items', atomicity: 'per-item', itemErrors: ['SKU_ALREADY_EXISTS'] },
    outcomes: [{ ok: true, result: { productId: 'a' } }, { ok: true, result: { productId: 'b' } }],
    response: {
      status: 207,
      body: {
        summary: { total: 2, succeeded: 2, failed: 0, notAttempted: 0 },
        items: [
          { index: 0, status: 'succeeded', result: { productId: 'a' }, error: null, message: null },
          { index: 1, status: 'succeeded', result: { productId: 'b' }, error: null, message: null }
        ]
      }
    }
  },
  {
    id: 'batch-item-error-skipped',
    rule: 'batch-item-stable',
    plan: { over: 'items', atomicity: 'per-item', itemErrors: ['SKU_ALREADY_EXISTS'] },
    outcomes: [
      { ok: true, result: null },
      { ok: false, code: 'SKU_ALREADY_EXISTS', message: 'Ya existe un producto con ese SKU' },
      { ok: false, code: 'VALIDATION_ERROR', message: 'price must be greater than 0' },
      { ok: true, result: null }
    ],
    response: {
      status: 207,
      body: {
        summary: { total: 4, succeeded: 2, failed: 2, notAttempted: 0 },
        items: [
          { index: 0, status: 'succeeded', result: null, error: null, message: null },
          { index: 1, status: 'failed', result: null, error: 'SKU_ALREADY_EXISTS', message: 'Ya existe un producto con ese SKU' },
          { index: 2, status: 'failed', result: null, error: 'VALIDATION_ERROR', message: 'price must be greater than 0' },
          { index: 3, status: 'succeeded', result: null, error: null, message: null }
        ]
      }
    }
  },
  {
    id: 'batch-undeclared-stops',
    rule: 'batch-stop',
    plan: { over: 'items', atomicity: 'per-item', itemErrors: ['SKU_ALREADY_EXISTS'] },
    outcomes: [{ ok: true, result: null }, { ok: false, code: null, message: 'connection reset' }, { ok: true, result: null }],
    response: {
      status: 207,
      body: {
        summary: { total: 3, succeeded: 1, failed: 1, notAttempted: 1 },
        items: [
          { index: 0, status: 'succeeded', result: null, error: null, message: null },
          { index: 1, status: 'failed', result: null, error: 'BATCH_ABORTED', message: 'El elemento falló por una causa que no es suya y el lote se detuvo en él' },
          { index: 2, status: 'notAttempted', result: null, error: null, message: null }
        ]
      }
    }
  },
  {
    id: 'batch-declared-outside-item-errors-stops',
    rule: 'batch-stop',
    plan: { over: 'items', atomicity: 'per-item', itemErrors: ['SKU_ALREADY_EXISTS'] },
    outcomes: [{ ok: false, code: 'CATALOG_LOCKED', message: 'El catálogo está bloqueado' }, { ok: true, result: null }],
    response: {
      status: 207,
      body: {
        summary: { total: 2, succeeded: 0, failed: 1, notAttempted: 1 },
        items: [
          { index: 0, status: 'failed', result: null, error: 'CATALOG_LOCKED', message: 'El catálogo está bloqueado' },
          { index: 1, status: 'notAttempted', result: null, error: null, message: null }
        ]
      }
    }
  },
  {
    id: 'batch-all-or-nothing-rolls-back',
    rule: 'batch-multi-status',
    plan: { over: 'items', atomicity: 'all-or-nothing', itemErrors: [] },
    outcomes: [{ ok: true, result: null }, { ok: false, code: 'SKU_ALREADY_EXISTS', message: 'Ya existe un producto con ese SKU' }],
    response: { status: 'error', committed: false, index: 1, code: 'SKU_ALREADY_EXISTS', details: ['items[1]'] }
  }
];

/**
 * La LISTA EN LA QUERY (DSL 2.32, D10, D14 y U8): los valores del parámetro tal como llegan (uno por repetición; `null`
 * si no vino) y la lista que el borde lee, o `400`. Partir por comas es lo que hace Spring y lo que ya hacían los
 * cuatro (B0, M12); la lista vacía se rechaza porque «ninguno» nunca es lo que se quiere pedir. Leer el TIPO de cada
 * elemento (un enum, un uuid) es del lector de cada plataforma, con el 400 de siempre.
 */
export const WIRE_QUERY_LIST_CASES = [
  { id: 'query-list-absent', rule: 'query-list', values: null, read: null },
  { id: 'query-list-repeated', rule: 'query-list', values: ['active', 'draft'], read: ['active', 'draft'] },
  { id: 'query-list-comma', rule: 'query-list', values: ['active,draft'], read: ['active', 'draft'] },
  { id: 'query-list-mixed', rule: 'query-list', values: ['active,draft', 'retired'], read: ['active', 'draft', 'retired'] },
  { id: 'query-list-empty', rule: 'query-list', values: [''], read: 400 },
  { id: 'query-list-blank-element', rule: 'query-list', values: ['active,'], read: 400 },
  { id: 'query-list-blank-repeated', rule: 'query-list', values: ['active', ''], read: 400 }
];

/** Lo que el borde lee de una lista en la query: la referencia de WIRE_QUERY_LIST_CASES. `null` es «no filtra». */
export function readQueryList(values) {
  if (values === null || values === undefined || values.length === 0) return null;
  const read = values.flatMap((value) => String(value).split(','));
  return read.some((element) => element === '') ? 400 : read;
}
