// La mensajería en el ARNÉS de integración de keel-nest (incremento 9c): lo que una prueba de flujo usa
// para entregar un mensaje a una suscripción, leer lo publicado y lo descartado, tumbar y levantar el
// broker, y fabricar las precondiciones del outbox. Es lo que en el AbstractFlowIT de keel-spring hacen
// `deliver<Sub>`, `publishedMessages`, `deadLetterMessages`, `purgeMessages`, `stopBroker`/`startBroker`,
// `deadLetteredEvents` y `abandonOutboxEvent`.
//
// Los comandos con los que se habla con el broker NO se escriben aquí: salen de keel-core/gen/
// broker-probes.js —los mismos que ejecuta el arnés de keel-spring y los que ejecuta `broker-check`—, y
// se renderizan a TypeScript con `renderParts`/`spliceBody`. Viajan por el contenedor devtools de infra/,
// que está en la red del compose. Los tres brokers: RabbitMQ, Kafka (9f) y SNS/SQS (9g).
//
// Kafka no tiene purga (kcat no borra registros): el aislamiento entre flujos es una MARCA DE OFFSET por canal
// y por topic de descarte, que se fija al abrir cada flujo — la misma que el AbstractFlowIT de keel-spring.
//
// Lo que el arnés de keel-nest puede y el de keel-spring no: el servidor corre EN EL MISMO PROCESO que la
// suite, así que la cuenta de lo rendido y la pausa del relay se piden al relay, y la espera a que la
// conexión con el broker vuelva tras levantarlo se le pregunta a la conexión.

import {
  ENDPOINTS,
  RECORD_FORMAT,
  UNKNOWN_TOPIC,
  deliverParts,
  deliverShell,
  hole,
  offsetsParts,
  shellQuote,
  purgeParts,
  rabbitProbeBody,
  rabbitPublishBody,
  readParts,
  releaseParts,
  READ_BATCH_LIMIT,
  SQS_SWEEP_VISIBILITY,
  prefix,
  renderParts,
  spliceBody,
  expr
} from 'keel-core/gen/broker-probes';
import { BROKERS, brokerContainer, devtoolsContainer } from 'keel-core/gen/infra-catalog';
import { deadLetterDestination, subscriptionDestination } from 'keel-core/gen';
import { harnessQueueName } from 'keel-core/gen/messaging-provisioning';
import { tsString } from './render.js';
import { publishedChannels } from './rabbitmq.js';
import { kafkaConsumption } from './kafka.js';
import { snsSqsConsumption } from './snssqs.js';
import {
  usesKafka,
  usesNestOutbox,
  usesRabbitMq,
  usesSnsSqs,
  KAFKA_CONNECTION_TS,
  SNSSQS_CONNECTION_TS,
  MESSAGING_SETTINGS_TS,
  OUTBOX_RELAY_TS,
  RABBIT_CONNECTION_TS
} from './messaging.js';

/** ¿Lleva el arnés la mensajería? Con los tres brokers que keel-nest genera. */
export function usesMessagingHarness(model) {
  return usesRabbitMq(model) || usesKafka(model) || usesSnsSqs(model);
}

/** Los imports del servidor que necesita la sección (flow.ts es la única excepción de la caja negra). */
export function messagingHarnessImports(model) {
  if (!usesMessagingHarness(model)) return '';
  const [connection, file] = usesKafka(model)
    ? ['KafkaConnection', KAFKA_CONNECTION_TS]
    : usesSnsSqs(model)
      ? ['SnsSqsConnection', SNSSQS_CONNECTION_TS]
      : ['RabbitConnection', RABBIT_CONNECTION_TS];
  const lines = [`import { ${connection} } from '../../../${file.replace(/\.ts$/, '.js')}';`];
  if (usesNestOutbox(model)) {
    lines.push(
      `import { OutboxRelay } from '../../../${OUTBOX_RELAY_TS.replace(/\.ts$/, '.js')}';`,
      `import { MESSAGING_SETTINGS, type MessagingSettings } from '../../../${MESSAGING_SETTINGS_TS.replace(/\.ts$/, '.js')}';`
    );
  }
  return `\n${lines.join('\n')}`;
}

const pascal = (name) => name.charAt(0).toUpperCase() + name.slice(1);
const ts = (parts) => renderParts(parts, tsString);

export function messagingHarnessSection(model) {
  if (!usesMessagingHarness(model)) return '';
  if (usesKafka(model)) return kafkaSection(model);
  if (usesSnsSqs(model)) return snsSqsSection(model);
  return rabbitSection(model);
}

function rabbitSection(model) {
  const broker = BROKERS.rabbitmq;
  const service = model.service.name;
  const published = publishedChannels(model).map((entry) => entry.channel);
  const subscriptions = model.subscriptions ?? [];
  const deadLetters = subscriptions.filter((sub) => sub.deadLetter);
  const outbox = usesNestOutbox(model);

  const read = readParts('rabbitmq', { destination: expr('queue'), bodyFile: expr('PROBE_BODY'), base: expr('RABBIT_API') });
  const purge = purgeParts('rabbitmq', { destination: expr('queue'), base: expr('RABBIT_API') });
  const deliver = deliverParts('rabbitmq', { destination: expr('exchange'), bodyFile: expr('DELIVER_BODY'), base: expr('RABBIT_EXCHANGE_API') });
  const probeBody = spliceBody(rabbitProbeBody(hole(0)), ['String(count)'], tsString);
  const publishBody = spliceBody(
    rabbitPublishBody({ routingKey: hole(0), key: hole(1), headersJson: hole(2), payloadBase64: hole(3) }),
    ['key', 'key', 'headersJson(headers)', "Buffer.from(body, 'utf8').toString('base64')"],
    tsString
  );

  const outboxSection = outbox ? outboxHarness() : noOutboxDrain(model);
  const deliveries = subscriptions.map((sub) => deliverMethod(sub)).join('');
  return `
// ── Mensajería (RabbitMQ) ────────────────────────────────────────────────────
//
// Los comandos salen de keel-core/gen/broker-probes.js: los mismos que usa el arnés de keel-spring y los
// que ejecuta broker-check. Viajan por el contenedor devtools, que ve el broker por la red del compose.

${containerConstants(service, broker)}
const RABBIT_API = ${tsString(ENDPOINTS.rabbitmq.queuesApi)};
const RABBIT_EXCHANGE_API = ${tsString(ENDPOINTS.rabbitmq.exchangeApi)};
const PROBE_BODY = '/tmp/keel-probe.json';
const DELIVER_BODY = '/tmp/keel-deliver.json';
const BROKER_TIMEOUT_MS = 90_000;

/** Los canales que publica este servicio: cada uno es una cola con su nombre (rabbit-topology.ts). */
const PUBLISHED_CHANNELS: readonly string[] = [${published.map(tsString).join(', ')}];

/** Suscripción → la cola de la que consume este servicio. */
const QUEUE_OF: Readonly<Record<string, string>> = {
${subscriptions.map((sub) => `  ${tsString(sub.name)}: ${tsString(subscriptionDestination('rabbitmq', model, sub))}`).join(',\n')}
};

/** Suscripción → su cola de descarte (las que declaran onFailure.deadLetter). */
const DEAD_LETTER_OF: Readonly<Record<string, string>> = {
${deadLetters.map((sub) => `  ${tsString(sub.name)}: ${tsString(deadLetterDestination('rabbitmq', model, sub))}`).join(',\n')}
};

${brokerMessageAndDevtools('su routing key, sus propiedades y su cuerpo')}

/** Peek de una cola (leer no consume: un escenario puede afirmar dos veces sobre el mismo mensaje). */
function readQueue(queue: string, count: number): BrokerMessage[] {
  copyToDevtools(${probeBody}, PROBE_BODY);
  let raw: string;
  try {
    raw = devtools([${ts(read)}]);
  } catch (error) {
    // Con el broker parado POR EL ESCENARIO, «no hay mensajes» es la lectura correcta.
    if (brokerStopped) return [];
    throw error;
  }
  const list = JSON.parse(raw) as Array<{ routing_key?: string; properties?: Record<string, unknown>; payload?: string }>;
  return list.map((message) => {
    const body = message.payload ?? '';
    let payload: unknown = body;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = body;
    }
    return { routingKey: message.routing_key ?? '', properties: message.properties ?? {}, body, payload };
  });
}

/**
 * Lo publicado en un canal del diseño desde el último reset (hasta \`count\`). Con outbox, espera antes a
 * que el relay entregue lo que tenga pendiente: si no, lo que se lee depende de la fase del relay.
 */
export async function publishedMessages(channel: string, count = 50): Promise<BrokerMessage[]> {
  if (!PUBLISHED_CHANNELS.includes(channel)) {
    throw new Error(\`'\${channel}' no es un canal que este servicio publique. Publicados: \${PUBLISHED_CHANNELS.join(', ') || '(ninguno)'}\`);
  }
  await awaitOutboxDrained(channel);
  return readQueue(channel, count);
}

/**
 * Lo que acabó en el descarte de una suscripción desde el último reset. Úsalo también —y sobre todo— para
 * la aserción NEGATIVA: un duplicado absorbido se confirma SIN acabar aquí.
 */
export function deadLetterMessages(subscription: string, count = 50): BrokerMessage[] {
  const queue = DEAD_LETTER_OF[subscription];
  if (queue == null) {
    throw new Error(\`La suscripción '\${subscription}' no declara onFailure.deadLetter: no hay descarte. Declaradas: \${Object.keys(DEAD_LETTER_OF).join(', ') || '(ninguna)'}\`);
  }
  return readQueue(queue, count);
}

/**
 * Vacía un canal publicado (o la cola de una suscripción, por su nombre). El reset de estado ya lo hace al
 * abrir el flujo; repítelo justo antes de la acción cuyo Then afirma que NO se publica nada.
 */
export async function purgeMessages(channelOrSubscription: string): Promise<void> {
  const queue = QUEUE_OF[channelOrSubscription] ?? DEAD_LETTER_OF[channelOrSubscription] ?? channelOrSubscription;
  await awaitOutboxDrained(channelOrSubscription);
  devtools([${ts(purge)}]);
}

/**
 * Publica un mensaje crudo en un exchange (el canal de una fuente), con \`key\` como message_id y routing
 * key. Falla si RabbitMQ no lo enrutó a ninguna cola: lo acepta con 200 y \`"routed":false\`, y sin esto el
 * escenario moriría mucho después en un timeout que habla de otra cosa.
 */
export function deliverMessage(exchange: string, key: string, body: string, headers: Readonly<Record<string, string>> = {}): void {
  copyToDevtools(${publishBody}, DELIVER_BODY);
  const published = devtools([${ts(deliver)}]);
  if (!published.includes('"routed":true')) {
    throw new Error(\`RabbitMQ aceptó la publicación en '\${exchange}' pero no la enrutó a ninguna cola (routed:false): ¿arrancó la conexión del servicio y declaró su topología? Respuesta: \${published}\`);
  }
}

function headersJson(headers: Readonly<Record<string, string>>): string {
  return JSON.stringify(headers);
}
${deliveries}${brokerControl(broker, '(con su topología)')}
/** Espera a que la conexión del servidor con el broker esté arriba (y su topología, declarada). */
async function awaitBrokerConnection(): Promise<void> {
  const connection = currentApp?.get(RabbitConnection);
  if (connection == null) return;
  await eventually(() => connection.connected, BROKER_TIMEOUT_MS, 'la conexión del servicio con RabbitMQ no se recuperó');
}

/** Al abrir cada flujo: el broker arriba (un flujo anterior pudo dejarlo parado) y la conexión hecha. */
async function prepareMessaging(): Promise<void> {
  if (!brokerAccepts()) await startBroker();
  brokerStopped = false;
  await awaitBrokerConnection();
}
${outboxSection}`;
}

// ── Lo común a los dos brokers ──────────────────────────────────────────────

function containerConstants(service, broker) {
  return `const DEVTOOLS = ${tsString(devtoolsContainer(service))};
const BROKER_CONTAINER = ${tsString(brokerContainer(service, broker))};`;
}

function brokerMessageAndDevtools(what) {
  return `/** Un mensaje leído del broker: ${what}. */
export interface BrokerMessage {
  readonly routingKey: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /** El cuerpo tal cual viajó. */
  readonly body: string;
  /** El cuerpo leído como JSON (la envoltura Keel: \`payload.metadata.eventType\`, \`payload.data\`), o el texto si no lo es. */
  readonly payload: any;
}

let brokerStopped = false;

function devtools(args: readonly string[]): string {
  return run(containerRuntime(), ['exec', DEVTOOLS, ...args], '¿Está la infraestructura arriba (bash infra/up.sh)?');
}

/** Un archivo dentro del contenedor devtools: los cuerpos viajan así, nunca embebidos en la línea de comandos. */
function copyToDevtools(content: string, file: string): void {
  run(containerRuntime(), ['exec', '-i', DEVTOOLS, 'sh', '-c', \`cat > \${file}\`], '¿Está la infraestructura arriba?', content);
}`;
}

function brokerControl(broker, recovered, beforeRelease = '') {
  return `
/** Detiene el broker (el escenario del canal indisponible). Las lecturas devuelven vacío mientras tanto. */
export async function stopBroker(): Promise<void> {
  run(containerRuntime(), ['stop', BROKER_CONTAINER]);
  brokerStopped = true;
  await eventually(() => !brokerAccepts(), BROKER_TIMEOUT_MS, 'el broker sigue aceptando conexiones tras detenerlo');
}

/** Lo vuelve a levantar y espera a que la conexión del servicio se recupere ${recovered}. */
export async function startBroker(): Promise<void> {
  run(containerRuntime(), ['start', BROKER_CONTAINER]);
  await eventually(() => brokerAccepts(), BROKER_TIMEOUT_MS, 'el broker no volvió a aceptar conexiones');${beforeRelease}
  brokerStopped = false;
  await awaitBrokerConnection();
}

function brokerAccepts(): boolean {
  try {
    devtools(['sh', '-c', ${tsString(broker.cliValidateCmd)}]);
    return true;
  } catch {
    return false;
  }
}
`;
}

// ── Kafka ────────────────────────────────────────────────────────────────────
//
// El servicio publica en UN topic (messaging.publishing.destination) con la routing key como clave, y los
// canales del diseño se distinguen por el tipo del evento; cada suscripción consume del topic de su fuente con
// su consumer group, y descarta en `<topic>.DLT` si el topic lo declara. Sin purga: marca de offset.
function kafkaSection(model) {
  const broker = BROKERS.kafka;
  const service = model.service.name;
  const published = publishedChannels(model).map((entry) => entry.channel);
  const subscriptions = model.subscriptions ?? [];
  const deadLettered = kafkaConsumption(model).filter((entry) => entry.deadLetter);
  const outbox = usesNestOutbox(model);
  const eventTypes = model.messaging?.eventTypesByChannel ?? {};
  const topicEnv = (sub) => sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');

  const read = readParts('kafka', { destination: expr('topic'), offset: expr('offset'), format: RECORD_FORMAT });
  const offsets = offsetsParts({ destination: expr('topic') });
  // La cabeza de la línea de kcat, del mismo constructor que ejecuta broker-check: el destino, la clave y los
  // headers los añade el arnés, que es quien los comilla en tiempo de ejecución.
  const produce = deliverShell({ destination: '', key: '', bodyFile: '' }).split(shellQuote(''))[0];
  const channelTypes = Object.entries(eventTypes)
    .map(([channel, names]) => `  ${tsString(channel)}: [${names.map(tsString).join(', ')}]`)
    .join(',\n');
  const topics = subscriptions.map((sub) => `  ${tsString(sub.name)}: process.env[${tsString(topicEnv(sub))}] ?? ${tsString(sub.topicDefault)}`).join(',\n');
  const deadLetters = deadLettered.map((entry) => `  ${tsString(entry.subscription)}: \`\${TOPIC_OF[${tsString(entry.subscription)}]}.DLT\``).join(',\n');

  const outboxSection = outbox ? outboxHarness() : noOutboxDrain(model);
  const deliveries = subscriptions.map((sub) => deliverMethod(sub)).join('');
  return `
// ── Mensajería (Kafka) ───────────────────────────────────────────────────────
//
// Los comandos salen de keel-core/gen/broker-probes.js: los mismos que usa el arnés de keel-spring y los
// que ejecuta broker-check. Viajan por el contenedor devtools, que ve el broker por la red del compose.

${containerConstants(service, broker)}
const DELIVER_BODY = '/tmp/keel-deliver.json';
const BROKER_TIMEOUT_MS = 90_000;
/** Lo que espera el arnés a que cada consumidor reciba sus particiones al abrir el flujo. */
const ASSIGNMENT_TIMEOUT_MS = 60_000;
const KCAT_PRODUCE = ${tsString(produce)};

/**
 * El topic FÍSICO donde publica este servicio, que no es el canal del diseño: todos los eventos comparten el
 * destino y se distinguen por su tipo. Como el perfil local: la variable si está, y si no el default.
 */
const EVENT_TOPIC = process.env['MESSAGING_DESTINATION'] ?? ${tsString(model.messaging?.destinationDefault ?? '')};

/** Los canales que publica este servicio. */
const PUBLISHED_CHANNELS: readonly string[] = [${published.map(tsString).join(', ')}];

/** Canal → el metadata.eventType de sus eventos: lo que separa los canales dentro del topic único. */
const CHANNEL_EVENT_TYPES: Readonly<Record<string, readonly string[]>> = {
${channelTypes}
};

/** Suscripción → el topic de su fuente, del que consume directamente. */
const TOPIC_OF: Readonly<Record<string, string>> = {
${topics}
};

/** Suscripción → su topic de descarte (\`<topic>.DLT\`), las que lo declaran (por topic, como en keel-spring). */
const DEAD_LETTER_OF: Readonly<Record<string, string>> = {
${deadLetters}
};

/** Desde qué offset lee cada canal y cada descarte: la marca de su último reset o purga. */
const MARKS = new Map<string, number>();

${brokerMessageAndDevtools('su clave (la routing key, si lo publicó un servicio Keel), sus headers y su cuerpo')}

function isUnknownTopic(error: unknown): boolean {
  return error instanceof Error && error.message.includes(${tsString(UNKNOWN_TOPIC)});
}

/**
 * Lee un topic desde un offset, un registro por línea (clave, headers y valor). Kafka crea el topic con el
 * PRIMER mensaje: leer antes es «no hay mensajes», no una avería — y es justo el caso de un Then que afirma que
 * no se publicó nada, el primero que corre en una suite.
 */
function readTopic(topic: string, offset: string): BrokerMessage[] {
  let raw: string;
  try {
    raw = devtools([${ts(read)}]);
  } catch (error) {
    if (isUnknownTopic(error)) return [];
    // Con el broker parado POR EL ESCENARIO, «no hay mensajes» es la lectura correcta.
    if (brokerStopped) return [];
    throw error;
  }
  return raw
    .split(/\\r?\\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const first = line.indexOf('\\t');
      const second = line.indexOf('\\t', first + 1);
      const routingKey = first < 0 ? '' : line.slice(0, first);
      const headerText = first < 0 || second < 0 ? '' : line.slice(first + 1, second);
      const body = second < 0 ? line : line.slice(second + 1);
      const properties: Record<string, string> = {};
      for (const pair of headerText.split(',')) {
        const equals = pair.indexOf('=');
        if (equals > 0) properties[pair.slice(0, equals)] = pair.slice(equals + 1);
      }
      let payload: unknown = body;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = body;
      }
      return { routingKey, properties, body, payload };
    });
}

/**
 * El offset en el que caerá lo siguiente que se publique en \`topic\`: el último existente más uno. Asume UNA
 * partición por topic, que es la decisión de infra/ (la skill keel-nest-kafka, § Topología): con varias, una
 * marca escalar no aísla.
 */
function nextOffset(topic: string): number {
  let raw: string;
  try {
    raw = devtools([${ts(offsets)}]);
  } catch (error) {
    // Solo el topic que aún no existe, o el broker parado a propósito: un broker caído sin más tiene que doler.
    if (isUnknownTopic(error) || brokerStopped) return 0;
    throw error;
  }
  let last = -1;
  for (const line of raw.split(/\\r?\\n/)) {
    const value = Number(line.trim());
    if (line.trim() !== '' && Number.isSafeInteger(value)) last = value;
  }
  return last + 1;
}

/**
 * Marca todos los canales y todos los topics de descarte: la parte del reset que el script no puede hacer. Los
 * descartes entran por lo mismo que los canales, y su fallo es peor de ver: la aserción típica sobre un descarte
 * es NEGATIVA, así que un mensaje muerto de un flujo anterior haría fallar uno posterior por algo que no hizo.
 */
function markChannels(): void {
  const offset = nextOffset(EVENT_TOPIC);
  for (const channel of PUBLISHED_CHANNELS) MARKS.set(channel, offset);
  for (const topic of new Set(Object.values(DEAD_LETTER_OF))) MARKS.set(topic, nextOffset(topic));
}

function filterByChannel(messages: BrokerMessage[], channel: string): BrokerMessage[] {
  const types = CHANNEL_EVENT_TYPES[channel];
  if (types == null || types.length === 0) return messages;
  return messages.filter((message) => types.includes(message.payload?.metadata?.eventType));
}

/**
 * Lo publicado en un canal del diseño desde el último reset (hasta \`count\`). Con outbox, espera antes a
 * que el relay entregue lo que tenga pendiente: si no, lo que se lee depende de la fase del relay.
 */
export async function publishedMessages(channel: string, count = 50): Promise<BrokerMessage[]> {
  if (!PUBLISHED_CHANNELS.includes(channel)) {
    throw new Error(\`'\${channel}' no es un canal que este servicio publique. Publicados: \${PUBLISHED_CHANNELS.join(', ') || '(ninguno)'}\`);
  }
  await awaitOutboxDrained(channel);
  const mark = MARKS.get(channel);
  return filterByChannel(readTopic(EVENT_TOPIC, mark != null ? String(mark) : \`-\${count}\`), channel).slice(0, count);
}

/**
 * Lo que acabó en el descarte de una suscripción desde el último reset. Úsalo también —y sobre todo— para la
 * aserción NEGATIVA: un duplicado absorbido se confirma SIN acabar aquí.
 */
export function deadLetterMessages(subscription: string, count = 50): BrokerMessage[] {
  const topic = DEAD_LETTER_OF[subscription];
  if (topic == null) {
    throw new Error(\`La suscripción '\${subscription}' no declara onFailure.deadLetter: no hay descarte. Declaradas: \${Object.keys(DEAD_LETTER_OF).join(', ') || '(ninguna)'}\`);
  }
  const mark = MARKS.get(topic);
  return readTopic(topic, mark != null ? String(mark) : \`-\${count}\`).slice(0, count);
}

/**
 * «Vacía» un canal publicado o el descarte de una suscripción: Kafka no borra, así que mueve su marca al final y
 * lo anterior deja de leerse. El reset ya lo hace al abrir el flujo; repítelo justo antes de la acción cuyo Then
 * afirma que NO se publica nada. El topic de una suscripción no se vacía: lo que publicó la fuente, ahí sigue.
 */
export async function purgeMessages(channelOrSubscription: string): Promise<void> {
  if (PUBLISHED_CHANNELS.includes(channelOrSubscription)) {
    await awaitOutboxDrained(channelOrSubscription);
    MARKS.set(channelOrSubscription, nextOffset(EVENT_TOPIC));
    return;
  }
  const deadLetter = DEAD_LETTER_OF[channelOrSubscription];
  if (deadLetter != null) {
    MARKS.set(deadLetter, nextOffset(deadLetter));
    return;
  }
  if (TOPIC_OF[channelOrSubscription] != null) return;
  MARKS.set(channelOrSubscription, nextOffset(channelOrSubscription));
}

/**
 * Publica un mensaje crudo en un topic (el de una fuente), con \`key\` como clave del registro. kcat manda UN
 * mensaje por línea del archivo, así que el cuerpo se colapsa a una sola línea: un JSON escrito en varias se
 * publicaría troceado en mensajes que el listener no puede leer.
 */
export function deliverMessage(topic: string, key: string, body: string, headers: Readonly<Record<string, string>> = {}): void {
  copyToDevtools(body.replace(/[\\r\\n]+/g, ' '), DELIVER_BODY);
  let command = KCAT_PRODUCE + shellQuote(topic) + ' -k ' + shellQuote(key);
  for (const [name, value] of Object.entries(headers)) command += ' -H ' + shellQuote(\`\${name}=\${value}\`);
  devtools(['sh', '-c', \`\${command} -l \${DELIVER_BODY}\`]);
}

/** Comilla un valor para la shell del contenedor (una clave o un header, nunca un cuerpo). */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\\\''") + "'";
}
${deliveries}${brokerControl(broker, 'y sus consumidores vuelvan a tener particiones')}
/** Los topics que existen ahora en el broker (kcat -L). */
function existingTopics(): Set<string> {
  try {
    return new Set([...devtools(['sh', '-c', ${tsString(broker.cliValidateCmd)}]).matchAll(/topic "([^"]+)"/g)].map((match) => match[1]!));
  } catch {
    return new Set();
  }
}

/**
 * Espera a que la conexión esté hecha y a que cada consumidor cuyo topic YA existe tenga sus particiones: hasta
 * entonces, lo que se le entregue espera al reparto del grupo, y un escenario que entrega y mira enseguida lo
 * vería tarde. El consumidor de un topic que aún no existe no se espera: lo recibirá cuando lo cree el primer
 * mensaje (el perfil local refresca los metadatos cada pocos segundos).
 */
async function awaitBrokerConnection(): Promise<void> {
  const connection = currentApp?.get(KafkaConnection);
  if (connection == null) return;
  await eventually(() => connection.connected, BROKER_TIMEOUT_MS, 'la conexión del servicio con Kafka no se hizo');
  const topics = existingTopics();
  await eventually(
    () => connection.subscriberStates().every((state) => !topics.has(state.topic) || state.partitions > 0),
    ASSIGNMENT_TIMEOUT_MS,
    'los consumidores del servicio no recibieron sus particiones'
  );
}

/** Al abrir cada flujo: el broker arriba, la conexión hecha y la marca de cada canal y cada descarte. */
async function prepareMessaging(): Promise<void> {
  if (!brokerAccepts()) await startBroker();
  brokerStopped = false;
  await awaitBrokerConnection();
  markChannels();
}
${outboxSection}`;
}

// ── SNS/SQS ─────────────────────────────────────────────────────────────────
//
// El servicio publica en UN topic (messaging.publishing.destination) con el tipo como message attribute
// `eventType`; de un topic no se lee, así que el aprovisionamiento cuelga de él una COLA DE ARNÉS por canal,
// llamada como el canal y filtrada por sus eventos. Cada suscripción consume de su cola propia, suscrita al topic
// de la fuente, y su DLQ cuelga de ella por RedrivePolicy. LocalStack sirve la topología de MEMORIA: levantar el
// broker exige resembrarla (infra/init-messaging.sh) y confirmar que la suscripción entrega antes de seguir.
function snsSqsSection(model) {
  const broker = BROKERS.snssqs;
  const service = model.service.name;
  const published = publishedChannels(model).map((entry) => entry.channel);
  const subscriptions = model.subscriptions ?? [];
  const consumption = snsSqsConsumption(model);
  const outbox = usesNestOutbox(model);
  const queueEnv = (sub) => `${sub.topicProperty.toUpperCase().replace(/[.-]/g, '_').replace(/_TOPIC$/, '')}_QUEUE`;
  const base = expr('QUEUE_URL');
  const read = readParts('snssqs', { destination: expr('queue'), count: expr('String(size)'), base });
  // El barrido es OTRO comando: oculta lo que devuelve para poder avanzar más allá del primer lote, y lo suelta
  // al terminar (el porqué, en SQS_SWEEP_VISIBILITY de keel-core/gen/broker-probes.js).
  const sweep = readParts('snssqs', { destination: expr('queue'), count: expr('String(size)'), base, hideSeconds: SQS_SWEEP_VISIBILITY });
  const release = releaseParts('snssqs', { destination: expr('queue'), receiptHandle: expr('handle'), base });
  const purge = purgeParts('snssqs', { destination: expr('queue'), base });
  const remove = ['sqs', 'delete-message', '--queue-url', expr('QUEUE_URL + queue'), '--receipt-handle', expr('handle')];
  const deliver = deliverParts('snssqs', {
    destination: expr('topic'),
    bodyFile: expr('DELIVER_BODY'),
    attrsFile: expr('DELIVER_ATTRS'),
    base: expr('TOPIC_ARN'),
    withAttributes: true
  });
  // La sonda de la resiembra: el primer evento publicado y la cola de arnés de SU canal (la que lo admite).
  const probe = (model.events ?? [])[0];
  const probeChannel = probe
    ? Object.entries(model.messaging?.eventTypesByChannel ?? {}).find(([, events]) => (events ?? []).includes(probe.name))?.[0]
    : null;
  const probeLines = probe && probeChannel ? topologyProbe(probe.name, harnessQueueName(probeChannel)) : '';

  const reseed = `

/**
 * Vuelve a sembrar la topología tras levantar LocalStack, que la sirve de memoria: sin esto el escenario fallaría
 * por «cola inexistente» y no por lo que prueba. ${outbox ? 'Con el relay del outbox EN PAUSA: si publicara en el hueco entre el topic recreado y su suscripción, SNS aceptaría el mensaje y lo descartaría sin error.' : ''}
 */
async function reseedTopology(): Promise<void> {${outbox ? `
  const relay = currentApp ? outboxRelay() : null;
  await relay?.pause();` : ''}
  try {
    run(bashExecutable(), ['infra/init-messaging.sh'], '¿Está la infraestructura arriba (bash infra/up.sh)?');${probeLines ? `
    await awaitTopologyWired();` : ''}
  } finally {${outbox ? `
    relay?.resume();` : ''}
  }
}`;

  const outboxSection = outbox ? outboxHarness() : noOutboxDrain(model);
  const deliveries = subscriptions.map((sub) => deliverMethod(sub)).join('');
  return `
// ── Mensajería (SNS/SQS) ─────────────────────────────────────────────────────
//
// Los comandos salen de keel-core/gen/broker-probes.js: los mismos que usa el arnés de keel-spring y los
// que ejecuta broker-check. Viajan por el contenedor devtools, que ve LocalStack por la red del compose.

${containerConstants(service, broker)}
const DELIVER_BODY = '/tmp/keel-deliver.json';
const DELIVER_ATTRS = '/tmp/keel-deliver-attrs.json';
const BROKER_TIMEOUT_MS = 90_000;
const QUEUE_URL = ${tsString(ENDPOINTS.snssqs.queueUrlPrefix)};
const TOPIC_ARN = ${tsString(ENDPOINTS.snssqs.topicArnPrefix)};
const AWS: readonly string[] = [${prefix('snssqs').map(tsString).join(', ')}];
/** SQS no devuelve más de diez mensajes por llamada. */
const READ_BATCH_LIMIT = ${READ_BATCH_LIMIT.snssqs};

/** Los canales que publica este servicio. */
const PUBLISHED_CHANNELS: readonly string[] = [${published.map(tsString).join(', ')}];

/** Canal → la cola de ARNÉS de la que se lee lo publicado (init-messaging.sh: se llama como el canal). */
const HARNESS_QUEUE_OF: Readonly<Record<string, string>> = {
${published.map((channel) => `  ${tsString(channel)}: ${tsString(harnessQueueName(channel))}`).join(',\n')}
};

/** Suscripción → su cola propia (la del perfil: la variable si está). */
const QUEUE_OF: Readonly<Record<string, string>> = {
${consumption.map((entry, index) => `  ${tsString(entry.subscription)}: process.env[${tsString(queueEnv(subscriptions[index]))}] ?? ${tsString(entry.queue)}`).join(',\n')}
};

/** Suscripción → su DLQ (las que declaran onFailure.deadLetter). */
const DEAD_LETTER_OF: Readonly<Record<string, string>> = {
${consumption.filter((entry) => entry.deadLetterQueue).map((entry) => `  ${tsString(entry.subscription)}: ${tsString(entry.deadLetterQueue)}`).join(',\n')}
};

${brokerMessageAndDevtools('su cuerpo (los message attributes no se leen: el MessageId de SQS cambia en cada reenvío)')}

function aws(args: readonly string[]): string {
  return devtools([...AWS, ...args]);
}

interface ReceivedMessage {
  readonly MessageId?: string;
  readonly ReceiptHandle?: string;
  readonly Body?: string;
}

/** La lista Messages de una respuesta de receive-message; una cola agotada puede no devolver ni un {}. */
function received(raw: string): ReceivedMessage[] {
  if (raw.trim() === '') return [];
  return (JSON.parse(raw) as { Messages?: ReceivedMessage[] }).Messages ?? [];
}

function toBrokerMessage(message: ReceivedMessage): BrokerMessage {
  const body = message.Body ?? '';
  let payload: unknown = body;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = body;
  }
  return { routingKey: '', properties: {}, body, payload };
}

/**
 * Lee una cola sin consumirla (hasta \`count\`). SQS da como mucho diez por llamada y, con la lectura en peek,
 * lo devuelto vuelve a estar visible al instante: pedir más de diez es un BARRIDO que oculta lo leído para
 * avanzar y lo SUELTA al final, así que la cola queda como estaba. Se deduplica por MessageId, que es estable
 * entre relecturas del mismo mensaje — y NO por el cuerpo: la reentrega de un escenario de idempotencia
 * comparte cuerpo con la primera entrega, y deduplicarla dejaría ese escenario verde sin probar nada.
 */
function readQueue(queue: string, count: number): BrokerMessage[] {
  const wanted = Math.max(count, 1);
  const sweeping = wanted > READ_BATCH_LIMIT;
  const seen = new Map<string, BrokerMessage>();
  const hidden: string[] = [];
  // Cota de llamadas: una cola que solo puede repescar lo ya visto no deja el bucle sondeando para siempre.
  const maxAttempts = Math.ceil(wanted / READ_BATCH_LIMIT) + 5;
  try {
    for (let attempt = 0; attempt < maxAttempts && seen.size < wanted; attempt++) {
      const size = Math.min(wanted - seen.size, READ_BATCH_LIMIT);
      const messages = received(sweeping ? aws([${ts(sweep)}]) : aws([${ts(read)}]));
      if (messages.length === 0) break;
      for (const message of messages) {
        if (sweeping && message.ReceiptHandle) hidden.push(message.ReceiptHandle);
        const id = message.MessageId ?? message.ReceiptHandle ?? String(seen.size);
        if (!seen.has(id)) seen.set(id, toBrokerMessage(message));
      }
      // Barriendo, un lote corto no prueba nada (lo devuelto quedó oculto); sin barrer, sí es el final.
      if (!sweeping && messages.length < size) break;
    }
  } catch (error) {
    // Con el broker parado POR EL ESCENARIO, «no hay mensajes» es la lectura correcta.
    if (brokerStopped) return [];
    throw error;
  } finally {
    for (const handle of hidden) {
      try {
        aws([${ts(release)}]);
      } catch {
        // Soltar es de mejor esfuerzo: el plazo de ocultación vence solo.
      }
    }
  }
  return [...seen.values()];
}

/**
 * Lo publicado en un canal del diseño desde el último reset (hasta \`count\`). Con outbox, espera antes a
 * que el relay entregue lo que tenga pendiente: si no, lo que se lee depende de la fase del relay.
 */
export async function publishedMessages(channel: string, count = 50): Promise<BrokerMessage[]> {
  const queue = HARNESS_QUEUE_OF[channel];
  if (queue == null) {
    throw new Error(\`'\${channel}' no es un canal que este servicio publique. Publicados: \${PUBLISHED_CHANNELS.join(', ') || '(ninguno)'}\`);
  }
  await awaitOutboxDrained(channel);
  return readQueue(queue, count);
}

/**
 * Lo que acabó en la DLQ de una suscripción desde el último reset. Úsalo también —y sobre todo— para la aserción
 * NEGATIVA: un duplicado absorbido se confirma SIN acabar aquí.
 */
export function deadLetterMessages(subscription: string, count = 50): BrokerMessage[] {
  const queue = DEAD_LETTER_OF[subscription];
  if (queue == null) {
    throw new Error(\`La suscripción '\${subscription}' no declara onFailure.deadLetter: no hay descarte. Declaradas: \${Object.keys(DEAD_LETTER_OF).join(', ') || '(ninguna)'}\`);
  }
  return readQueue(queue, count);
}

/**
 * Vacía la cola de un canal publicado, la de una suscripción o su DLQ (por su nombre). El reset ya lo hace al
 * abrir el flujo; repítelo justo antes de la acción cuyo Then afirma que NO se publica nada.
 */
export async function purgeMessages(channelOrSubscription: string): Promise<void> {
  const queue = HARNESS_QUEUE_OF[channelOrSubscription] ?? QUEUE_OF[channelOrSubscription] ?? DEAD_LETTER_OF[channelOrSubscription] ?? channelOrSubscription;
  await awaitOutboxDrained(channelOrSubscription);
  // PurgeQueue está limitada a una vez cada 60 s por cola en AWS real; LocalStack no aplica esa cuota.
  aws([${ts(purge)}]);
}

/**
 * Publica un mensaje crudo en el TOPIC de una fuente —no en la cola—, que es como llega uno de verdad: por la
 * suscripción SNS→SQS con su filtro por \`eventType\`. Sin ese header en \`headers\`, el filtro lo deja fuera de
 * la cola sin ningún error. \`key\` no viaja: SNS no tiene clave de mensaje.
 */
export function deliverMessage(topic: string, key: string, body: string, headers: Readonly<Record<string, string>> = {}): void {
  void key;
  copyToDevtools(body, DELIVER_BODY);
  const args = [${ts(deliver)}];
  if (Object.keys(headers).length === 0) {
    aws(args.slice(0, -2));
    return;
  }
  const attributes: Record<string, { DataType: string; StringValue: string }> = {};
  for (const [name, value] of Object.entries(headers)) attributes[name] = { DataType: 'String', StringValue: value };
  copyToDevtools(JSON.stringify(attributes), DELIVER_ATTRS);
  aws(args);
}
${deliveries}${brokerControl(broker, 'con su topología resembrada', `
  await reseedTopology();`)}${reseed}${probeLines}

/** Espera a que cada consumidor del servicio vuelva a sondear su cola. */
async function awaitBrokerConnection(): Promise<void> {
  const connection = currentApp?.get(SnsSqsConnection);
  if (connection == null) return;
  await eventually(() => connection.connected, BROKER_TIMEOUT_MS, 'los consumidores del servicio no volvieron a sondear sus colas');
}

/** Al abrir cada flujo: el broker arriba (con su topología) y los consumidores sondeando. */
async function prepareMessaging(): Promise<void> {
  if (!brokerAccepts()) await startBroker();
  brokerStopped = false;
  await awaitBrokerConnection();
}
${outboxSection}`;

  function topologyProbe(eventType, queue) {
    return `

const TOPOLOGY_PROBE_QUEUE = ${tsString(queue)};
const TOPOLOGY_PROBE_EVENT_TOPIC = process.env['MESSAGING_DESTINATION'] ?? ${tsString(model.messaging?.destinationDefault ?? '')};

/**
 * Confirma que la suscripción SNS→SQS resembrada ENTREGA, no solo que existe: SNS acepta un publish contra un
 * topic recién creado aunque su suscripción aún no esté lista, y sin suscriptor el mensaje se descarta sin error.
 * Publica una sonda y la espera en la cola de arnés de su canal (y la borra); una sonda perdida no es un fallo, es
 * la señal de reintentar.
 */
async function awaitTopologyWired(): Promise<void> {
  const deadline = Date.now() + BROKER_TIMEOUT_MS;
  for (;;) {
    const probeId = \`keel-topology-probe-\${Date.now()}-\${Math.random().toString(36).slice(2)}\`;
    deliverMessage(TOPOLOGY_PROBE_EVENT_TOPIC, probeId, JSON.stringify({ metadata: { eventId: probeId, eventType: ${tsString(eventType)} }, data: {} }), { eventType: ${tsString(eventType)} });
    const attemptDeadline = Date.now() + 5000;
    while (Date.now() < attemptDeadline) {
      const raw = aws(['sqs', 'receive-message', '--queue-url', QUEUE_URL + TOPOLOGY_PROBE_QUEUE, '--max-number-of-messages', '10', '--visibility-timeout', '0']);
      const found = received(raw).find((message) => (message.Body ?? '').includes(probeId));
      if (found?.ReceiptHandle) {
        const queue = TOPOLOGY_PROBE_QUEUE;
        const handle = found.ReceiptHandle;
        aws([${ts(remove)}]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (Date.now() > deadline) {
      throw new Error(\`La suscripción SNS→SQS de '\${TOPOLOGY_PROBE_EVENT_TOPIC}' → '\${TOPOLOGY_PROBE_QUEUE}' no entregó la sonda tras resembrar la topología\`);
    }
  }
}`;
  }
}

// Un método por suscripción: el escenario no tiene que saber en qué canal vive el evento, cómo lo envuelve
// la fuente ni dónde declaró el contrato su clave. Lo que queda en la prueba es lo suyo: el payload y si el
// messageId se repite (la reentrega).
function deliverMethod(sub) {
  const headers = [];
  if (sub.discriminator?.location === 'header') headers.push(`${tsString(sub.discriminator.name)}: ${tsString(sub.discriminator.value ?? sub.name)}`);
  // El tipo como atributo nativo, además de donde lo lleve la envoltura: es lo que estampa un emisor real.
  if (sub.discriminator?.location !== 'header' || sub.discriminator.name !== 'eventType') headers.push(`eventType: ${tsString(sub.name)}`);
  if (sub.messageId?.location === 'header') headers.push(`${tsString(sub.messageId.name)}: messageId`);
  const delivery = sub.identityDelivery;
  if (delivery?.placement === 'header') headers.push(`${tsString(delivery.name)}: source`);
  const topicEnv = sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');
  const params = delivery ? 'messageId: string, source: string, payloadJson: string' : 'messageId: string, payloadJson: string';
  let body;
  if (sub.envelope === 'keel') {
    // La envoltura COMPLETA, como la publica cualquier servicio Keel: la metadata en el orden del cable.
    const source = delivery?.placement === 'metadata' && delivery.name === 'source' ? 'source' : tsString(sub.source ?? 'keel-harness');
    body = `\`{"metadata":{"eventId":\${JSON.stringify(messageId)},"eventType":${JSON.stringify(sub.name)},"eventVersion":1,"occurredAt":\${JSON.stringify(new Date().toISOString())},"source":\${JSON.stringify(${source})},"correlationId":null,"traceparent":null},"data":\${payloadJson}}\``;
  } else if (sub.envelope === 'wrapped') {
    const fields = [];
    if (sub.discriminator?.location === 'field') fields.push(`"${sub.discriminator.name}":${JSON.stringify(sub.discriminator.value ?? sub.name)}`);
    if (sub.messageId?.location === 'field') fields.push(`"${sub.messageId.name}":\${JSON.stringify(messageId)}`);
    if (delivery?.placement === 'envelopeField') fields.push(`"${delivery.name}":\${JSON.stringify(source)}`);
    fields.push(`"${sub.payloadPath}":\${payloadJson}`);
    body = `\`{${fields.join(',')}}\``;
  } else {
    body = 'payloadJson';
  }
  const identity =
    sub.envelope === 'keel' ? 'el eventId de la envoltura Keel' : sub.messageId ? `el ${sub.messageId.location === 'header' ? 'header' : 'campo'} '${sub.messageId.name}' del contrato` : null;
  return `
/**
 * Entrega ${sub.name} en su canal real, con la envoltura que declara el contrato (${sub.envelope}).
 * \`messageId\` es la identidad del mensaje${identity ? `, que viaja en ${identity}` : ''}: llamar dos veces con el MISMO valor es
 * la REENTREGA que el consumidor debe absorber sin segundo efecto.${identity ? '' : ' OJO: el contrato no declara messageId ni usa la envoltura Keel, así que el consumidor no tiene con qué deduplicar.'}${
    delivery ? ` \`source\` es la identidad de quien pide el trabajo (${sub.identity.from.name}).` : ''
  } \`payloadJson\` es el payload ya escrito como JSON.
 */
export function deliver${pascal(sub.name)}(${params}): void {
  const destination = process.env[${tsString(topicEnv)}] ?? ${tsString(sub.topicDefault)};
  deliverMessage(destination, messageId, ${body}, { ${headers.join(', ')} });
}
`;
}

function outboxHarness() {
  return `
// ── El outbox ────────────────────────────────────────────────────────────────

const OUTBOX_DRAIN_TIMEOUT_MS = 15_000;

function messagingSettings(): MessagingSettings {
  if (currentApp == null) throw new Error('El servidor no está arrancado: useFlow() se llama dentro del describe del flujo.');
  return currentApp.get<MessagingSettings>(MESSAGING_SETTINGS);
}

function outboxRelay(): OutboxRelay {
  if (currentApp == null) throw new Error('El servidor no está arrancado: useFlow() se llama dentro del describe del flujo.');
  return currentApp.get(OutboxRelay);
}

/** Un número de una consulta de una sola fila: la última línea. Vacío NO es cero. */
function countOf(output: string): number {
  const last = output.trim().split(/\\r?\\n/).pop() ?? '';
  const digits = last.replace(/[^0-9]/g, '');
  if (digits === '') throw new Error(\`La consulta de outbox_event no devolvió un número (salida: '\${output.trim()}')\`);
  return Number(digits);
}

/**
 * Espera a que no queden filas del outbox sin entregar para este servicio. Un canal que no publicamos no
 * pasa por nuestro outbox, y con el broker parado por el escenario las filas esperan a propósito. La fila
 * RENDIDA no cuenta: no va a salir nunca, y contarla agotaba la espera en cada lectura de su escenario.
 */
async function awaitOutboxDrained(channel: string): Promise<void> {
  if (!PUBLISHED_CHANNELS.includes(channel) || brokerStopped) return;
  const destination = messagingSettings().destination.replaceAll("'", "''");
  const maxAttempts = messagingSettings().outboxRelay!.maxAttempts;
  const until = Date.now() + OUTBOX_DRAIN_TIMEOUT_MS;
  while (Date.now() < until && countOf(db(\`SELECT COUNT(*) FROM outbox_event WHERE destination = '\${destination}' AND published_at IS NULL AND attempts < \${maxAttempts}\`)) > 0) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Cuántos eventos se rindió el outbox: agotaron sus reintentos y no salieron nunca. El Then natural de casi
 * cualquier escenario del outbox es que esto siga en CERO: entregar tarde es correcto, rendirse es perder.
 */
export function deadLetteredEvents(): Promise<number> {
  return outboxRelay().countDeadLettered();
}

/**
 * Agota el presupuesto de reintentos del evento pendiente de tipo \`eventType\` (el NOMBRE del evento en el
 * diseño): la precondición del escenario de la rendición, que de verdad costaría 40 intentos. Va el último
 * de su flujo, o limpia después con clearAbandonedOutboxEvents().
 */
export async function abandonOutboxEvent(eventType: string): Promise<void> {
  const relay = outboxRelay();
  await relay.pause();
  try {
    const type = eventType.replaceAll("'", "''");
    const pending = countOf(db(\`SELECT COUNT(*) FROM outbox_event WHERE event_type = '\${type}' AND published_at IS NULL\`));
    if (pending === 0) throw new Error(\`No hay ningún evento \${eventType} pendiente en el outbox que abandonar\`);
    db(\`UPDATE outbox_event SET attempts = \${messagingSettings().outboxRelay!.maxAttempts} WHERE event_type = '\${type}' AND published_at IS NULL\`);
  } finally {
    relay.resume();
  }
}

/** Retira lo que abandonOutboxEvent rindió: la purga no lo borra (solo lo publicado), y ensuciaría a los demás. */
export function clearAbandonedOutboxEvents(): void {
  db(\`DELETE FROM outbox_event WHERE published_at IS NULL AND attempts >= \${messagingSettings().outboxRelay!.maxAttempts}\`);
}

/** Suspende el relay del outbox (la pasada en vuelo termina): las filas quedan pendientes hasta resumeOutboxRelay(). */
export function pauseOutboxRelay(): Promise<void> {
  return outboxRelay().pause();
}

export function resumeOutboxRelay(): void {
  outboxRelay().resume();
}
`;
}

/** La espera al drenaje sin outbox: nada que esperar. */
export function noOutboxDrain(model) {
  return usesMessagingHarness(model) && !usesNestOutbox(model)
    ? `
async function awaitOutboxDrained(_channel: string): Promise<void> {}
`
    : '';
}
