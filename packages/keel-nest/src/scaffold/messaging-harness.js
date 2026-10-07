// La mensajería en el ARNÉS de integración de keel-nest (incremento 9c): lo que una prueba de flujo usa
// para entregar un mensaje a una suscripción, leer lo publicado y lo descartado, tumbar y levantar el
// broker, y fabricar las precondiciones del outbox. Es lo que en el AbstractFlowIT de keel-spring hacen
// `deliver<Sub>`, `publishedMessages`, `deadLetterMessages`, `purgeMessages`, `stopBroker`/`startBroker`,
// `deadLetteredEvents` y `abandonOutboxEvent`.
//
// Los comandos con los que se habla con el broker NO se escriben aquí: salen de keel-core/gen/
// broker-probes.js —los mismos que ejecuta el arnés de keel-spring y los que ejecuta `broker-check`—, y
// se renderizan a TypeScript con `renderParts`/`spliceBody`. Viajan por el contenedor devtools de infra/,
// que está en la red del compose. Hoy solo RabbitMQ: la frontera rechaza los demás brokers.
//
// Lo que el arnés de keel-nest puede y el de keel-spring no: el servidor corre EN EL MISMO PROCESO que la
// suite, así que la cuenta de lo rendido y la pausa del relay se piden al relay, y la espera a que la
// conexión con el broker vuelva tras levantarlo se le pregunta a la conexión.

import {
  ENDPOINTS,
  deliverParts,
  hole,
  purgeParts,
  rabbitProbeBody,
  rabbitPublishBody,
  readParts,
  renderParts,
  spliceBody,
  expr
} from 'keel-core/gen/broker-probes';
import { BROKERS, brokerContainer, devtoolsContainer } from 'keel-core/gen/infra-catalog';
import { deadLetterDestination, subscriptionDestination } from 'keel-core/gen';
import { tsString } from './render.js';
import { publishedChannels } from './rabbitmq.js';
import { usesNestOutbox, usesRabbitMq, MESSAGING_SETTINGS_TS, OUTBOX_RELAY_TS, RABBIT_CONNECTION_TS } from './messaging.js';

/** ¿Lleva el arnés la mensajería? Con RabbitMQ (el único broker que keel-nest genera hoy). */
export function usesMessagingHarness(model) {
  return usesRabbitMq(model);
}

/** Los imports del servidor que necesita la sección (flow.ts es la única excepción de la caja negra). */
export function messagingHarnessImports(model) {
  if (!usesMessagingHarness(model)) return '';
  const lines = [`import { RabbitConnection } from '../../../${RABBIT_CONNECTION_TS.replace(/\.ts$/, '.js')}';`];
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

const DEVTOOLS = ${tsString(devtoolsContainer(service))};
const BROKER_CONTAINER = ${tsString(brokerContainer(service, broker))};
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

/** Un mensaje leído del broker: su routing key, sus propiedades y su cuerpo. */
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
}

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
${deliveries}
/** Detiene el broker (el escenario del canal indisponible). Las lecturas devuelven vacío mientras tanto. */
export async function stopBroker(): Promise<void> {
  run(containerRuntime(), ['stop', BROKER_CONTAINER]);
  brokerStopped = true;
  await eventually(() => !brokerAccepts(), BROKER_TIMEOUT_MS, 'el broker sigue aceptando conexiones tras detenerlo');
}

/** Lo vuelve a levantar y espera a que la conexión del servicio se recupere (con su topología). */
export async function startBroker(): Promise<void> {
  run(containerRuntime(), ['start', BROKER_CONTAINER]);
  await eventually(() => brokerAccepts(), BROKER_TIMEOUT_MS, 'el broker no volvió a aceptar conexiones');
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
  const exchange = process.env[${tsString(topicEnv)}] ?? ${tsString(sub.topicDefault)};
  deliverMessage(exchange, messageId, ${body}, { ${headers.join(', ')} });
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
 * pasa por nuestro outbox, y con el broker parado por el escenario las filas esperan a propósito.
 */
async function awaitOutboxDrained(channel: string): Promise<void> {
  if (!PUBLISHED_CHANNELS.includes(channel) || brokerStopped) return;
  const destination = messagingSettings().destination.replaceAll("'", "''");
  const until = Date.now() + OUTBOX_DRAIN_TIMEOUT_MS;
  while (Date.now() < until && countOf(db(\`SELECT COUNT(*) FROM outbox_event WHERE destination = '\${destination}' AND published_at IS NULL\`)) > 0) {
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
