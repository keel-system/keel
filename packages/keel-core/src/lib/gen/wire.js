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
  'unknown-ignored': 'Una propiedad desconocida en la entrada se ignora.'
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
  eventMetadata: ['eventId', 'eventType', 'eventVersion', 'occurredAt', 'source', 'correlationId', 'traceparent']
};
