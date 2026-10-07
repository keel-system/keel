// Kafka en keel-nest (incremento 9f): lo que en el servidor de keel-spring ponen Spring Boot y build sin
// que el agente escriba nada, y que en Node no pone nadie.
//
//   · el CONSUMO como datos (`kafka-consumption.ts`, TypeScript puro): por suscripción, su topic y su
//     consumer group (`<servicio>-<evento>`, keel-core/gen/dead-letter.js), si descarta en `<topic>.DLT`,
//     y el REINTENTO del consumidor (`kafkaListenerRetry`, neutral): la curva del `DeadLetterConfig` de
//     keel-spring, con lo que no se reintenta —el rechazo de negocio y el contrato incumplido—;
//   · la CONEXIÓN (`kafka-connection.ts`) sobre @confluentinc/kafka-javascript (librdkafka, API compatible
//     con KafkaJS): las mismas variables que keel-spring (KAFKA_BOOTSTRAP_SERVERS, los plazos del productor
//     de keel-core/gen/infra-catalog.js), un productor que espera el ack de todas las réplicas con
//     idempotencia (lo que kafka-clients 3 trae por defecto en Spring), un consumidor por suscripción que
//     hace lo que el `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` de keel-spring —reintentar en
//     memoria y, agotado o no reintentable, publicar en `<topic>.DLT` solo los topics que lo declaran—, y el
//     arranque SIN broker: se conecta en segundo plano y reintenta.
//
// Lo que escribe el agente (skill keel-nest-kafka) es lo mismo que en keel-spring: el dispatcher del outbox
// o los publishers best-effort sobre `KafkaConnection.publish`, y un listener por suscripción sobre
// `KafkaConnection.consume`. No crea topics: los autocrea el broker de infra/ y en producción los gobierna
// la plataforma (la skill keel-spring-kafka, § Topología).

import { KAFKA_PRODUCER_TIMEOUTS } from 'keel-core/gen/infra-catalog';
import { kafkaListenerRetry, subscriptionDestination, subscriptionGroupId } from 'keel-core/gen';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';
import { tsModule, tsString } from './render.js';
import { KAFKA_CONNECTION_TS, KAFKA_CONSUMPTION_TS, MESSAGE_CONTRACT_TS, MESSAGING_SETTINGS_TS, usesKafka } from './messaging.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** El techo de la espera entre reconexiones: el de RabbitMQ (y el de la recuperación del listener de Spring). */
export const KAFKA_RECONNECT_INTERVAL_MS = 5000;
/**
 * Cada cuánto refresca el consumidor los metadatos de sus topics, en el perfil `local`. Fuera de `local`,
 * el default de librdkafka (5 min), por variable.
 *
 * Por qué existe: un consumidor suscrito a un topic que aún no existe no se entera de que lo crean hasta el
 * siguiente refresco, y en infra/ los topics los autocrea el broker con el PRIMER mensaje. Con los 5 min de
 * librdkafka, el primer evento que entrega un escenario esperaba ahí cinco minutos; medido con un Kafka real
 * (2026-10-07): con 2 s llega en menos de medio segundo. El cliente de Java de keel-spring refresca solo
 * en cuanto ve el topic desconocido, así que allí no hace falta.
 */
export const KAFKA_LOCAL_METADATA_REFRESH_MS = 2000;
export const KAFKA_DEFAULT_METADATA_REFRESH_MS = 300000;

export function generate(model) {
  if (!usesKafka(model)) return [];
  return [
    { path: KAFKA_CONSUMPTION_TS, content: consumptionFile(model) },
    { path: KAFKA_CONNECTION_TS, content: connectionFile() },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/kafka.yaml`, content: kafkaYaml(profile) }))
  ];
}

/** El consumo como DATOS: una entrada por SUSCRIPCIÓN (cada una con su consumer group). */
export function kafkaConsumption(model) {
  const retry = kafkaListenerRetry(model);
  return (model.subscriptions ?? []).map((sub) => {
    const topic = subscriptionDestination('kafka', model, sub);
    return {
      subscription: sub.name,
      topic,
      groupId: subscriptionGroupId(model, sub),
      // Por TOPIC, como DEAD_LETTERED en keel-spring: basta con que una suscripción del topic lo declare.
      deadLetter: retry.deadLetteredTopics.includes(topic)
    };
  });
}

// ─── El consumo y el reintento (TypeScript puro) ─────────────────────────────

function consumptionFile(model) {
  const consumption = kafkaConsumption(model);
  const retry = kafkaListenerRetry(model);
  const entries = consumption
    .map(
      (entry) =>
        `  { subscription: ${tsString(entry.subscription)}, topic: ${tsString(entry.topic)}, groupId: ${tsString(entry.groupId)}, deadLetter: ${entry.deadLetter} }`
    )
    .join(',\n');
  const declared = retry.deadLetteredTopics.length > 0;
  const body = `/** Cómo consume una suscripción: los defaults del diseño (el perfil puede renombrar topic y grupo). */
export interface SubscriptionConsumption {
  readonly subscription: string;
  /** El topic de la fuente, del que se consume directamente (en Kafka no hay cola intermedia). */
  readonly topic: string;
  /** Su consumer group: uno por suscripción, para que cada una reciba el topic entero. */
  readonly groupId: string;
  /** ¿Publica en \`<topic>.DLT\` lo que agota sus reintentos? Por topic: basta con que una suscripción lo declare. */
  readonly deadLetter: boolean;
}

/**
 * El consumo de este servicio: el MISMO que el del servidor de keel-spring del diseño (los grupos de
 * \`messaging.subscriptions.<clave>.group-id\` y el DEAD_LETTERED de su DeadLetterConfig). Los topics no los
 * crea la aplicación: en infra/ los autocrea el broker con el primer mensaje, y en producción los aprovisiona
 * la plataforma.
 */
export const KAFKA_CONSUMPTION: readonly SubscriptionConsumption[] = [
${entries}
];

/** El destino de descarte de un topic: la convención de Spring Kafka (keel-core/gen/dead-letter.js). */
export function deadLetterTopic(topic: string): string {
  return \`\${topic}.DLT\`;
}

/** El reintento del consumidor (keel-core, kafkaListenerRetry). */
export interface ListenerRetry {
  readonly attempts: number;
  readonly initialMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number | null;
}

/**
 * ${
    declared
      ? `El reintento de las suscripciones con descarte (${model.subscriptions.filter((sub) => sub.deadLetter).map((sub) => sub.name).join(', ')}), aplicado a todas: uno para todo el\n * servicio, como el DefaultErrorHandler de keel-spring, y con varias políticas gana la más paciente.`
      : 'Ninguna suscripción declara descarte: rige el DefaultErrorHandler por defecto de Spring Kafka, diez intentos\n * seguidos sin espera, y después se registra y se confirma.'
  }
 */
export const LISTENER_RETRY: ListenerRetry = { attempts: ${retry.attempts}, initialMs: ${retry.initialMs}, multiplier: ${retry.multiplier}, maxDelayMs: ${retry.maxDelayMs ?? 'null'} };

/** Los intentos de una entrega, el primero incluido. */
export function listenerAttempts(retry: ListenerRetry = LISTENER_RETRY): number {
  return retry.attempts;
}

/** La espera antes del intento \`attempt + 1\`: initial·multiplier^(attempt-1), con su techo. */
export function listenerBackoffMs(attempt: number, retry: ListenerRetry = LISTENER_RETRY): number {
  const delay = retry.initialMs * retry.multiplier ** Math.max(attempt - 1, 0);
  return retry.maxDelayMs != null ? Math.min(delay, retry.maxDelayMs) : delay;
}

/**
 * ¿Se reintenta este fallo? No el rechazo de negocio (DomainException) ni el contrato incumplido
 * (MessageContractViolation): son el \`addNotRetryableExceptions(DomainException.class,
 * IllegalArgumentException.class)\` de keel-spring. No mejoran dentro de un segundo, y el reintento en memoria
 * repite la MISMA entrega: un guard que reclama antes (tryRecord) la encontraría ya marcada y la confirmaría
 * sin que llegara nunca al descarte.
 */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof DomainException) && !(error instanceof MessageContractViolation);
}`;
  return tsModule(
    KAFKA_CONSUMPTION_TS,
    [
      { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
      { symbol: 'MessageContractViolation', from: MESSAGE_CONTRACT_TS }
    ],
    body
  );
}

// ─── La conexión ─────────────────────────────────────────────────────────────

function connectionFile() {
  const body = `/** Token de la conexión con Kafka ya resuelta para el perfil. */
export const KAFKA_SETTINGS = Symbol('KAFKA_SETTINGS');

export interface KafkaSettings {
  /** false en el perfil test: las pruebas de build arrancan sin broker. */
  readonly enabled: boolean;
  readonly brokers: readonly string[];
  /** Cuánto puede retener el productor un envío sin confirmar (delivery.timeout.ms). */
  readonly deliveryTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /** Cada cuánto refresca el consumidor los metadatos de sus topics (ver kafka.yaml). */
  readonly metadataRefreshIntervalMs: number;
  /** La espera entre intentos de conexión, y entre intentos de publicar en el descarte. */
  readonly reconnectIntervalMs: number;
}

/** La conexión del perfil activo, con las mismas variables que keel-spring. */
export function kafkaSettings(configuration: Configuration): KafkaSettings {
  const servers = String(configuration.get('kafka.bootstrap-servers') ?? '').trim() || 'localhost:9092';
  return {
    enabled: configuration.get('kafka.enabled') !== false && configuration.get('kafka.enabled') !== 'false',
    brokers: servers.split(',').map((server) => server.trim()).filter((server) => server !== ''),
    deliveryTimeoutMs: positive(configuration.get('kafka.producer.delivery-timeout-ms'), ${KAFKA_PRODUCER_TIMEOUTS.delivery.default}),
    requestTimeoutMs: positive(configuration.get('kafka.producer.request-timeout-ms'), ${KAFKA_PRODUCER_TIMEOUTS.request.default}),
    metadataRefreshIntervalMs: positive(configuration.get('kafka.consumer.metadata-refresh-interval-ms'), ${KAFKA_DEFAULT_METADATA_REFRESH_MS}),
    reconnectIntervalMs: positive(configuration.get('kafka.reconnect-interval-ms'), ${KAFKA_RECONNECT_INTERVAL_MS})
  };
}

function positive(value: unknown, fallback: number): number {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`Kafka: '\${String(value)}' no es un entero positivo\`);
  return parsed;
}

/** Cuánto espera el apagado a que los clientes se desconecten. */
const CLOSE_TIMEOUT_MS = 5000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Un mensaje recibido, ya leído: la clave y el valor como texto y los headers como cadenas. */
export interface InboundMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  /** La clave del registro (la routing key, si lo publicó un servicio Keel); null si no trae. */
  readonly key: string | null;
  /** El valor tal cual viajó (el JSON de la envoltura, si lo publicó un servicio Keel). */
  readonly value: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Lo que un listener hace con un mensaje. Lanzar es fallar: se reintenta o va al descarte. */
export type MessageHandler = (message: InboundMessage) => Promise<void>;

/** El broker no está disponible ahora: la publicación no salió y hay que reintentarla. */
export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}

interface Subscriber {
  readonly subscription: string;
  readonly topic: string;
  readonly groupId: string;
  readonly deadLetter: boolean;
  readonly handler: MessageHandler;
  consumer: KafkaJS.Consumer | null;
  running: boolean;
}

/**
 * La conexión con Kafka: un productor y un consumidor por suscripción. El servicio arranca SIN broker —como el
 * de keel-spring—: los clientes se conectan en segundo plano y lo reintentan sin fin; una vez conectados,
 * librdkafka se reconecta solo si el broker se va y vuelve.
 *
 * Lo que escribe el agente usa dos métodos:
 *   · publish: resuelve cuando el broker CONFIRMA (acks de todas las réplicas, productor idempotente); falla si
 *     no hay conexión o si vence delivery.timeout.ms. Es lo que necesita el dispatcher del outbox: marcar como
 *     publicado lo que el broker no confirmó es lo que el outbox existe para impedir;
 *   · consume: registra el consumidor de una suscripción, con su consumer group. Confirma (el offset avanza) al
 *     terminar bien; reintenta en memoria con la curva del diseño lo que es transitorio; y lo agotado o no
 *     reintentable lo publica en \`<topic>.DLT\` si el topic lo declara, o lo registra y lo confirma si no.
 */
@Injectable()
export class KafkaConnection implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('KafkaConnection');
  private readonly subscribers: Subscriber[] = [];
  private readonly kafka: KafkaJS.Kafka;
  private producer: KafkaJS.Producer | null = null;
  private started = false;
  private stopping = false;

  constructor(
    @Inject(KAFKA_SETTINGS) private readonly settings: KafkaSettings,
    @Inject(MESSAGING_SETTINGS) private readonly messaging: MessagingSettings
  ) {
    this.kafka = new KafkaJS.Kafka({ kafkaJS: { brokers: [...settings.brokers], logger: kafkaLogger(this.logger) } });
  }

  /** ¿Está el productor conectado y corren todos los consumidores registrados? */
  get connected(): boolean {
    return this.producer != null && this.subscribers.every((subscriber) => subscriber.running);
  }

  /**
   * Cada consumidor con su topic y las particiones que tiene asignadas ahora. Sin el topic creado todavía no
   * tiene ninguna; tras arrancar o tras volver el broker, las recibe cuando el grupo termina de repartir.
   */
  subscriberStates(): Array<{ readonly subscription: string; readonly topic: string; readonly partitions: number }> {
    return this.subscribers.map((subscriber) => ({
      subscription: subscriber.subscription,
      topic: subscriber.topic,
      partitions: subscriber.consumer?.assignment().length ?? 0
    }));
  }

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) return;
    this.started = true;
    void this.connectProducer();
    for (const subscriber of this.subscribers) void this.startConsumer(subscriber);
  }

  /**
   * Desconecta los clientes. Con un tope: un broker que no contesta no puede retener el apagado del servicio,
   * que tiene su propio margen (server.shutdown-timeout).
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    const clients: Array<{ disconnect(): Promise<void> }> = [
      ...this.subscribers.flatMap((subscriber) => (subscriber.consumer ? [subscriber.consumer] : [])),
      ...(this.producer ? [this.producer] : [])
    ];
    const closing = Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())]);
  }

  /** Registra el consumidor de la suscripción \`subscription\` (su NOMBRE en el diseño): arranca con la conexión. */
  consume(subscription: string, handler: MessageHandler): void {
    const settings = this.messaging.subscriptions[subscription];
    const consumption = KAFKA_CONSUMPTION.find((entry) => entry.subscription === subscription);
    if (settings == null || consumption == null) {
      throw new Error(\`'\${subscription}' no es una suscripción de este servicio. Declaradas: \${KAFKA_CONSUMPTION.map((entry) => entry.subscription).join(', ')}\`);
    }
    const subscriber: Subscriber = {
      subscription,
      topic: settings.topic,
      groupId: settings.groupId ?? consumption.groupId,
      deadLetter: consumption.deadLetter,
      handler,
      consumer: null,
      running: false
    };
    this.subscribers.push(subscriber);
    if (this.started) void this.startConsumer(subscriber);
  }

  /**
   * Publica \`payload\` (JSON ya serializado con el contrato del cable) en \`topic\` con \`key\` como clave del
   * registro. Resuelve cuando el broker confirma; lanza BrokerUnavailableError si no salió.
   */
  async publish(topic: string, key: string | null, payload: string | Buffer, headers: Readonly<Record<string, string | Buffer>> = {}): Promise<void> {
    const producer = this.producer;
    if (producer == null || this.stopping) throw new BrokerUnavailableError('Kafka no está conectado');
    try {
      await producer.send({ topic, messages: [{ key, value: payload, headers: { ...headers } }] });
    } catch (error) {
      throw new BrokerUnavailableError(\`Kafka no confirmó la publicación en \${topic}: \${describe(error)}\`);
    }
  }

  private async connectProducer(): Promise<void> {
    while (!this.stopping) {
      const producer = this.kafka.producer({
        'delivery.timeout.ms': this.settings.deliveryTimeoutMs,
        'request.timeout.ms': this.settings.requestTimeoutMs,
        kafkaJS: { acks: -1, idempotent: true }
      });
      try {
        await producer.connect();
        if (this.stopping) {
          await producer.disconnect().catch(() => undefined);
          return;
        }
        this.producer = producer;
        this.logger.log('Kafka: productor conectado');
        return;
      } catch (error) {
        this.logger.warn(\`Kafka: no se pudo conectar el productor (\${describe(error)}); se reintenta\`);
        await producer.disconnect().catch(() => undefined);
        await sleep(this.settings.reconnectIntervalMs);
      }
    }
  }

  private async startConsumer(subscriber: Subscriber): Promise<void> {
    while (!this.stopping) {
      const consumer = this.kafka.consumer({
        'topic.metadata.refresh.interval.ms': this.settings.metadataRefreshIntervalMs,
        // earliest: un grupo nuevo lee lo publicado antes de unirse. Con latest, lo que llega mientras el grupo
        // se forma se pierde (y un escenario que entrega al abrir el flujo, también).
        kafkaJS: { groupId: subscriber.groupId, fromBeginning: true, autoCommit: true }
      });
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: [subscriber.topic] });
        await consumer.run({ eachMessage: (payload) => this.deliver(subscriber, payload) });
        subscriber.consumer = consumer;
        subscriber.running = true;
        this.logger.log(\`Kafka: consumidor de \${subscriber.subscription} en \${subscriber.topic} (grupo \${subscriber.groupId})\`);
        return;
      } catch (error) {
        this.logger.warn(\`Kafka: no se pudo arrancar el consumidor de \${subscriber.subscription} (\${describe(error)}); se reintenta\`);
        await consumer.disconnect().catch(() => undefined);
        await sleep(this.settings.reconnectIntervalMs);
      }
    }
  }

  /**
   * Lo que hace el DefaultErrorHandler de keel-spring con cada mensaje. Lanzar desde aquí deja el offset sin
   * avanzar y el cliente vuelve a entregar el MISMO mensaje: solo se hace cuando no hay desenlace posible
   * (apagándose, o el descarte no se pudo escribir), que es lo que hace Spring cuando su recuperador falla.
   */
  private async deliver(subscriber: Subscriber, payload: KafkaJS.EachMessagePayload): Promise<void> {
    const message = inbound(payload);
    const attempts = listenerAttempts();
    for (let attempt = 1; ; attempt++) {
      try {
        await subscriber.handler(message);
        return;
      } catch (error) {
        if (this.stopping) throw error;
        const reason = error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
        if (!isRetryable(error) || attempt >= attempts) {
          await this.recover(subscriber, payload, error, attempt, reason);
          return;
        }
        this.logger.warn(\`Kafka: fallo procesando un mensaje de \${payload.topic} (intento \${attempt}): \${reason}\`);
        await sleep(listenerBackoffMs(attempt));
      }
    }
  }

  /** El DeadLetterPublishingRecoverer de keel-spring: la clave, el valor y los headers originales, y los suyos. */
  private async recover(subscriber: Subscriber, payload: KafkaJS.EachMessagePayload, error: unknown, attempts: number, reason: string): Promise<void> {
    if (!subscriber.deadLetter) {
      this.logger.error(\`Kafka: mensaje de \${payload.topic} descartado tras \${attempts} intento(s); el diseño no declara dead-letter para esta suscripción: \${reason}\`);
      return;
    }
    const target = deadLetterTopic(payload.topic);
    const headers: Record<string, string | Buffer> = {};
    for (const [name, value] of Object.entries(payload.message.headers ?? {})) {
      if (value != null) headers[name] = Array.isArray(value) ? value[value.length - 1]! : value;
    }
    // Los headers de Spring Kafka, con su misma codificación (la partición en 4 bytes y el offset en 8, big-endian):
    // quien vigila los descartes de los dos servidores lee lo mismo.
    const partition = Buffer.alloc(4);
    partition.writeInt32BE(payload.partition);
    const offset = Buffer.alloc(8);
    offset.writeBigInt64BE(BigInt(payload.message.offset));
    Object.assign(headers, {
      'kafka_dlt-original-topic': payload.topic,
      'kafka_dlt-original-partition': partition,
      'kafka_dlt-original-offset': offset,
      'kafka_dlt-original-consumer-group': subscriber.groupId,
      'kafka_dlt-exception-fqcn': error instanceof Error ? error.name : 'Error',
      'kafka_dlt-exception-message': error instanceof Error ? error.message : String(error)
    });
    for (;;) {
      try {
        await this.publish(target, payload.message.key?.toString('utf8') ?? null, payload.message.value ?? Buffer.alloc(0), headers);
        this.logger.error(\`Kafka: mensaje de \${payload.topic} llevado a \${target} tras \${attempts} intento(s): \${reason}\`);
        return;
      } catch (failure) {
        // Sin descarte escrito no hay desenlace: se insiste, y al apagar se suelta sin confirmar.
        if (this.stopping) throw failure;
        this.logger.warn(\`Kafka: no se pudo publicar en \${target} (\${describe(failure)}); se reintenta\`);
        await sleep(this.settings.reconnectIntervalMs);
      }
    }
  }
}

function inbound(payload: KafkaJS.EachMessagePayload): InboundMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload.message.headers ?? {})) {
    if (value == null) continue;
    const last = Array.isArray(value) ? value[value.length - 1] : value;
    if (last != null) headers[name] = last.toString();
  }
  return {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    key: payload.message.key?.toString('utf8') ?? null,
    value: payload.message.value?.toString('utf8') ?? '',
    headers
  };
}

/**
 * El log del cliente, por el Logger de Nest. Lo informativo de librdkafka (cada reparto de particiones) va a
 * debug: en info ahogaría el log del servicio.
 */
function kafkaLogger(logger: Logger): KafkaJS.Logger {
  const adapter: KafkaJS.Logger = {
    info: (message: string) => logger.debug(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
    debug: () => undefined,
    namespace: () => adapter,
    setLogLevel: () => undefined
  };
  return adapter;
}`;
  return tsModule(
    KAFKA_CONNECTION_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'BeforeApplicationShutdown', from: '@nestjs/common', type: true },
      { symbol: 'OnApplicationBootstrap', from: '@nestjs/common', type: true },
      { symbol: 'KafkaJS', from: '@confluentinc/kafka-javascript' },
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: 'MESSAGING_SETTINGS', from: MESSAGING_SETTINGS_TS },
      { symbol: 'MessagingSettings', from: MESSAGING_SETTINGS_TS, type: true },
      { symbol: 'KAFKA_CONSUMPTION', from: KAFKA_CONSUMPTION_TS },
      { symbol: 'deadLetterTopic', from: KAFKA_CONSUMPTION_TS },
      { symbol: 'isRetryable', from: KAFKA_CONSUMPTION_TS },
      { symbol: 'listenerAttempts', from: KAFKA_CONSUMPTION_TS },
      { symbol: 'listenerBackoffMs', from: KAFKA_CONSUMPTION_TS }
    ],
    body
  );
}

// ─── La configuración ────────────────────────────────────────────────────────

// El gradiente de keel-spring: literal en local y test, `${VAR:default}` en develop y `${VAR}` sin default
// en production (un broker que nadie eligió no deja arrancar).
function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

function envWithDefault(profile, name, value) {
  return profile === 'local' || profile === 'test' ? String(value) : `\${${name}:${value}}`;
}

function kafkaYaml(profile) {
  const local = profile === 'local';
  const timeout = (p) => (local ? String(p.local) : `\${${p.env}:${p.default}}`);
  const lines = [
    'kafka:',
    ...(profile === 'test'
      ? ['  # Las pruebas de build arrancan sin broker: la conexión no se intenta.', '  enabled: false']
      : ['  enabled: true']),
    `  bootstrap-servers: ${envValue(profile, 'KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')}`,
    '  producer:',
    '    # Cuánto espera un envío sin confirmar antes de fallar (las mismas variables que keel-spring). El',
    '    # dispatcher del outbox no espera más que esto: con el broker caído, el intento falla en este plazo.',
    `    delivery-timeout-ms: ${timeout(KAFKA_PRODUCER_TIMEOUTS.delivery)}`,
    `    request-timeout-ms: ${timeout(KAFKA_PRODUCER_TIMEOUTS.request)}`,
    '  consumer:',
    '    # Cada cuánto se refrescan los metadatos de los topics: un topic creado después de suscribirse no se ve',
    '    # hasta el siguiente refresco (corto en local, donde los autocrea el primer mensaje).',
    `    metadata-refresh-interval-ms: ${local ? KAFKA_LOCAL_METADATA_REFRESH_MS : envWithDefault(profile, 'KAFKA_CONSUMER_METADATA_REFRESH_INTERVAL_MS', KAFKA_DEFAULT_METADATA_REFRESH_MS)}`,
    '  # La espera entre intentos de conexión mientras el broker no está.',
    `  reconnect-interval-ms: ${envWithDefault(profile, 'KAFKA_RECONNECT_INTERVAL_MS', KAFKA_RECONNECT_INTERVAL_MS)}`
  ];
  return `${lines.join('\n')}\n`;
}
