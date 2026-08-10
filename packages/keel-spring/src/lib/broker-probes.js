// Fuente única de los comandos con los que se habla con cada broker desde el
// contenedor devtools.
//
// Por qué existe. El arnés de integración lleva estos comandos incrustados como
// literales Java, y son la clase de código que ningún test de cadenas puede
// juzgar: un `-C` que falta, un endpoint equivocado o una comilla de más pasan
// todos los `includes(...)` y solo se ven contra un broker de verdad, al precio
// de una corrida entera del pipeline. Los comentarios de `integration-tests.js`
// son el registro de esos hallazgos.
//
// Con una sola definición, el runner de conformidad (`scripts/broker-check.js`)
// ejecuta EXACTAMENTE los comandos que el generador emite. Si construyera los
// suyos comprobaría que los brokers responden, que no es lo mismo que comprobar
// que el generador acierta.
//
// Qué se comparte y qué no: lo de nivel exec (flags, hosts, puertos, rutas) y
// los cuerpos de petición. La orquestación con estado —la contabilidad de
// offsets de Kafka, el filtrado por eventType— vive en Java y el runner la
// reimplementa: es lógica del arnés, no del canal.

/** Los tres brokers soportados por el generador. */
export const BROKERS = ['kafka', 'rabbitmq', 'snssqs'];

/**
 * Endpoints tal como los ve el contenedor devtools, que está en la red del
 * compose: nombres de servicio, no localhost.
 */
export const ENDPOINTS = {
  kafka: { bootstrap: 'kafka:29092' },
  rabbitmq: {
    credentials: 'guest:guest',
    queuesApi: 'http://rabbitmq:15672/api/queues/%2F/',
    // El exchange por defecto enruta por nombre de cola: la routing key ES la cola.
    publishApi: 'http://rabbitmq:15672/api/exchanges/%2F/amq.default/publish'
  },
  snssqs: {
    endpoint: 'http://localstack:4566',
    region: 'us-east-1',
    queueUrlPrefix: 'http://localstack:4566/000000000000/',
    topicArnPrefix: 'arn:aws:sns:us-east-1:000000000000:'
  }
};

/**
 * Prefijo común de las invocaciones de un broker. En Java lo aporta un helper
 * (`aws(...)` para SQS) y por eso va aparte: el renderizador Java emite solo las
 * partes propias del comando, y el runner concatena las dos mitades.
 */
export function prefix(broker) {
  if (broker === 'snssqs') {
    return ['aws', '--endpoint-url', ENDPOINTS.snssqs.endpoint, '--region', ENDPOINTS.snssqs.region];
  }
  return [];
}

/** Marca un fragmento como EXPRESIÓN Java (una constante, una variable) y no como literal. */
export function expr(java, value = undefined) {
  return { java, value };
}

/** `["kcat", "-C", …]` → `"kcat", "-C", …`, con las expresiones sin comillas. */
export function javaArgs(parts) {
  return parts.map(renderJavaPart).join(', ');
}

/**
 * Los mismos parts resueltos a argv real. Cada expresión aporta su valor al
 * construirse (`expr(java, value)`): el runner no puede evaluar Java.
 */
export function argv(broker, parts) {
  return [...prefix(broker), ...parts.map(resolvePart)];
}

function renderJavaPart(part) {
  if (typeof part !== 'object') return javaString(part);
  if (part.pieces) return part.pieces.map(renderJavaPart).join(' + ');
  return part.java;
}

function resolvePart(part) {
  if (typeof part !== 'object') return part;
  if (part.pieces) return part.pieces.map(resolvePart).join('');
  if (part.value === undefined) {
    throw new Error(`broker-probes: la expresión '${part.java}' no trae valor y no se puede ejecutar`);
  }
  return part.value;
}

/** Concatenación que se renderiza a Java (suma) y a argv (valor resuelto). */
function concat(...pieces) {
  return { pieces };
}

// ─── Lectura ─────────────────────────────────────────────────────────────────
//
// Kafka: `-C` es obligatorio. kcat elige modo PRODUCTOR cuando su stdin no es un
// terminal —el caso de cualquier exec— y saldría con éxito y salida vacía, que es
// indistinguible de "el evento aún no llegó".
//
// `base` existe porque el Java guarda el endpoint en una constante
// (`RABBIT_API`, `QUEUE_URL`) y el runner usa el literal: es el mismo valor
// escrito una vez.

export function readParts(broker, { destination, offset, count, bodyFile, base }) {
  if (broker === 'rabbitmq') {
    return [
      'curl', '-sf', '-u', ENDPOINTS.rabbitmq.credentials, '-H', 'content-type: application/json',
      '-XPOST', '-d', concat('@', bodyFile), concat(base ?? ENDPOINTS.rabbitmq.queuesApi, destination, '/get')
    ];
  }
  if (broker === 'snssqs') {
    return [
      'sqs', 'receive-message', '--queue-url', concat(base ?? ENDPOINTS.snssqs.queueUrlPrefix, destination),
      '--max-number-of-messages', count, '--visibility-timeout', '0'
    ];
  }
  return ['kcat', '-C', '-b', ENDPOINTS.kafka.bootstrap, '-t', destination, '-o', offset, '-e', '-q'];
}

/**
 * Lo que dice kcat cuando el topic todavía no existe.
 *
 * Kafka crea el topic al primer PRODUCE, no al primer consumo, así que contra una
 * infraestructura recién levantada toda lectura previa a la primera publicación
 * sale con este error y código 1. El arnés lo traduce a "no hay mensajes" —es el
 * caso de cualquier Then que afirme que no se publica nada, el primero que corre
 * en una suite—, y por eso el literal vive aquí: `broker-check` comprueba contra
 * Kafka real que sigue siendo este, y no que el generador acierte de memoria.
 */
export const UNKNOWN_TOPIC = 'Unknown topic or partition';

/**
 * Formato de kcat para listar offsets: el offset y un salto. El `\n` es escape DE
 * KCAT, no del lenguaje, y por eso vive aquí: escrito a mano en cada lado, uno de
 * los dos acaba con el escapado del template en vez de con el del formato.
 */
export const OFFSET_FORMAT = String.raw`%o\n`;

/** Offsets existentes del topic (`-f %o`), base de la marca de aislamiento. Solo Kafka. */
export function offsetsParts({ destination, format = OFFSET_FORMAT }) {
  return ['kcat', '-C', '-b', ENDPOINTS.kafka.bootstrap, '-t', destination, '-o', 'beginning', '-e', '-q', '-f', format];
}

// ─── Purga ───────────────────────────────────────────────────────────────────
//
// Kafka no tiene: kcat no borra registros y devtools no trae las CLIs de Kafka.
// Su equivalente es una marca de offset por canal, que vive en el arnés.

export function purgeParts(broker, { destination, base }) {
  if (broker === 'rabbitmq') {
    return [
      'curl', '-sf', '-u', ENDPOINTS.rabbitmq.credentials, '-XDELETE',
      concat(base ?? ENDPOINTS.rabbitmq.queuesApi, destination, '/contents')
    ];
  }
  if (broker === 'snssqs') {
    // PurgeQueue está limitada a una vez cada 60 s por cola en AWS real;
    // LocalStack no aplica esa cuota.
    return ['sqs', 'purge-queue', '--queue-url', concat(base ?? ENDPOINTS.snssqs.queueUrlPrefix, destination)];
  }
  return null;
}

// ─── Entrega de mensajes entrantes ───────────────────────────────────────────
//
// El cuerpo viaja SIEMPRE por archivo, nunca embebido en la línea de comandos: en
// Windows el cliente de contenedores se come las comillas dobles del JSON y lo que
// llega al broker es un cuerpo roto que el consumidor no reconoce — y el síntoma es
// un timeout mudo, no un error.

export function deliverParts(broker, { destination, bodyFile, attrsFile, base, withAttributes = false }) {
  if (broker === 'rabbitmq') {
    return [
      'curl', '-sf', '-u', ENDPOINTS.rabbitmq.credentials, '-H', 'content-type: application/json',
      '-XPOST', '-d', concat('@', bodyFile), base ?? ENDPOINTS.rabbitmq.publishApi
    ];
  }
  if (broker === 'snssqs') {
    // Se publica en el TOPIC, no en la cola, y no es un detalle: el destino que
    // declara una suscripción es el topic de la fuente, y la cola del consumidor
    // cuelga de él por una suscripción con filtro por `eventType`. Enviar directo a
    // la cola —además de fallar con NonExistentQueue, porque el nombre del topic no
    // es el de ninguna cola— se saltaría precisamente el filtro que decide si el
    // mensaje llega, que es la mitad del contrato de recepción.
    const parts = [
      'sns', 'publish', '--topic-arn', concat(base ?? ENDPOINTS.snssqs.topicArnPrefix, destination),
      '--message', concat('file://', bodyFile)
    ];
    if (withAttributes) parts.push('--message-attributes', concat('file://', attrsFile));
    return parts;
  }
  return null; // Kafka va por shell: ver deliverShell.
}

/**
 * Entrega DIRECTA a una cola, sin pasar por el topic.
 *
 * Solo tiene sentido en snssqs y solo para destinos que no cuelgan de ningún topic —
 * hoy, las colas de descarte: una DLQ se alcanza por redrive, no por suscripción, así
 * que no hay ARN de topic con su nombre y `sns publish` falla con NotFound. En Kafka y
 * RabbitMQ el destino se nombra igual se publique donde se publique, y `deliverParts`
 * ya vale.
 *
 * No lo uses para un destino normal: saltarse el topic se salta también el filtro por
 * `eventType`, que es la mitad del contrato de recepción.
 */
export function queueDeliverParts({ destination, bodyFile, base }) {
  return [
    'sqs', 'send-message',
    '--queue-url', concat(base ?? ENDPOINTS.snssqs.queueUrlPrefix, destination),
    '--message-body', concat('file://', bodyFile)
  ];
}

/**
 * Kafka entrega por shell y no por argv: `-l` exige el archivo como argumento y
 * las cabeceras son flags repetibles. Se devuelve la línea ya montada.
 */
export function deliverShell({ destination, key, bodyFile, headers = {} }) {
  const flags = Object.entries(headers)
    .map(([name, value]) => ` -H ${shellQuote(`${name}=${value}`)}`)
    .join('');
  return `kcat -P -b ${ENDPOINTS.kafka.bootstrap} -t ${shellQuote(destination)} -k ${shellQuote(key)}${flags} -l ${bodyFile}`;
}

// ─── Cuerpos de petición ─────────────────────────────────────────────────────
//
// Cada cuerpo se escribe UNA vez, en JS, y su versión Java se deriva de él
// intercalando expresiones donde el arnés pone variables. Es la única forma de
// que un cambio de forma no pueda quedarse en uno de los dos lados.

/** Peek de RabbitMQ: leer no consume, así que un escenario puede assertar dos veces. */
export function rabbitProbeBody(count) {
  return `{"count":${count},"ackmode":"ack_requeue_true","encoding":"auto"}`;
}

export function rabbitProbeBodyJava(countExpr = 'count') {
  return spliceJava(rabbitProbeBody(HOLE(0)), [countExpr]);
}

/**
 * Publicación por la API de gestión. El cuerpo va en base64 a propósito: incrustar
 * un JSON dentro del campo `payload` —que es una cadena JSON— exigiría escaparlo a
 * mano, y ahí es donde se pierde un cuerpo.
 */
export function rabbitPublishBody({ destination, key, headersJson: headers, payloadBase64 }) {
  return (
    `{"properties":{"message_id":"${key}","headers":${headers}},` +
    `"routing_key":"${destination}","payload":"${payloadBase64}","payload_encoding":"base64"}`
  );
}

export function rabbitPublishBodyJava({ key, headers, destination, payload }) {
  return spliceJava(
    rabbitPublishBody({ key: HOLE(0), headersJson: HOLE(1), destination: HOLE(2), payloadBase64: HOLE(3) }),
    [key, headers, destination, payload]
  );
}

/** Cabeceras → atributos de mensaje SQS, que es su equivalente en este broker. */
export function sqsAttributesJson(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => `"${name}":{"DataType":"String","StringValue":"${value}"}`)
    .join(',');
  return `{${entries}}`;
}

export function headersJson(headers) {
  return `{${Object.entries(headers).map(([name, value]) => `"${name}":"${value}"`).join(',')}}`;
}

// ─── Predicado de "no hay mensajes" ──────────────────────────────────────────
//
// Cada broker dice "vacío" de una forma: RabbitMQ devuelve una lista JSON vacía,
// kcat no imprime nada y la CLI de SQS omite la clave `Messages`.

export function isEmptyRead(broker, output) {
  const text = (output ?? '').trim();
  if (broker === 'rabbitmq') return text === '[]';
  if (broker === 'snssqs') return !text.includes('"Messages"');
  return text === '';
}

/** El mismo predicado, como expresión Java sobre una lectura. */
export function emptyReadJava(broker, read) {
  if (broker === 'rabbitmq') return `${read}.trim().equals("[]")`;
  if (broker === 'snssqs') return `!${read}.contains("\\"Messages\\"")`;
  return `${read}.isBlank()`;
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

/** Comilla un valor para la shell del contenedor. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Marca de hueco: un carácter que no puede aparecer en un cuerpo JSON real. */
function HOLE(index) {
  return ` ${index} `;
}

/** Cuerpo con huecos → concatenación Java de literales y expresiones. */
function spliceJava(template, expressions) {
  return template
    .split(' ')
    .map((piece, index) => (index % 2 === 1 ? expressions[Number(piece)] : javaString(piece)))
    .filter((piece) => piece !== '""')
    .join(' + ');
}

function javaString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
