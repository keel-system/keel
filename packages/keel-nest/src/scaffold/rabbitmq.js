// RabbitMQ en keel-nest (incremento 9): lo que en el servidor de keel-spring ponen Spring Boot y build
// sin que el agente escriba nada, y que en Node no pone nadie.
//
//   · la TOPOLOGÍA de consumo (`rabbit-topology.ts`, TypeScript puro): por cola, el exchange topic del
//     canal de origen, la cola propia de este servicio enlazada con `#` y su DLQ por argumentos
//     `x-dead-letter-*` cuando alguna suscripción que la comparte declara `onFailure.deadLetter`. Es la
//     de `RabbitTopologyConfig` de keel-spring, con los mismos nombres (keel-core/gen/dead-letter.js);
//     y la política de REINTENTO del listener (`rabbitListenerRetry`, neutral), con lo que no se
//     reintenta: el rechazo de negocio (DomainException) y el contrato incumplido;
//   · la CONEXIÓN (`rabbit-connection.ts`): las mismas variables que keel-spring (RABBITMQ_HOST, _PORT,
//     _USERNAME, _PASSWORD, RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS), reconexión con amqplib 2 (que
//     vuelve a declarar la topología y a arrancar los consumidores en cada reconexión), publicación con
//     confirmación del broker y `mandatory` (lo que en Spring son `publisher-confirm-type: correlated` y
//     `template.mandatory`), y un consumo que hace lo que el contenedor de Spring: confirmar al terminar
//     bien, reintentar en memoria con la curva del diseño y, agotado o no reintentable, rechazar SIN
//     reencolar (`default-requeue-rejected: false`), que es lo que lleva el mensaje a su DLQ.
//
// Lo que escribe el agente (skill keel-nest-rabbitmq) es lo mismo que en keel-spring: el dispatcher del
// outbox o los publishers best-effort sobre `RabbitConnection.publish`, y los listeners sobre
// `RabbitConnection.consume`. No declara topología.

import { deadLetterName, rabbitListenerRetry, subscriptionDestination } from 'keel-core/gen';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';
import { tsModule, tsString } from './render.js';
import { MESSAGE_CONTRACT_TS, RABBIT_CONNECTION_TS, RABBIT_TOPOLOGY_TS, usesRabbitMq } from './messaging.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** El prefetch del contenedor de Spring Boot (`spring.rabbitmq.listener.simple.prefetch`, 250). */
export const RABBIT_PREFETCH = 250;
/** El intervalo de recuperación del listener: el de keel-spring (`rabbitmq.listener.recovery-interval-ms`). */
export const RABBIT_RECOVERY_INTERVAL_MS = 5000;
/**
 * Cuánto espera una publicación la confirmación del broker. Por ENCIMA del intervalo de recuperación:
 * un plazo más corto reinicia ese reloj en cada intento y la reconexión no converge (la regla que la
 * skill keel-spring-rabbitmq le da al dispatcher del outbox).
 */
export const RABBIT_CONFIRM_TIMEOUT_MS = 10000;

export function generate(model) {
  if (!usesRabbitMq(model)) return [];
  return [
    { path: RABBIT_TOPOLOGY_TS, content: topologyFile(model) },
    { path: RABBIT_CONNECTION_TS, content: connectionFile() },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/rabbitmq.yaml`, content: rabbitYaml(model, profile) }))
  ];
}

/** La topología de consumo como DATOS: una entrada por COLA (las suscripciones de un canal la comparten). */
export function rabbitTopology(model) {
  const queues = new Map();
  for (const sub of model.subscriptions ?? []) {
    const queue = subscriptionDestination('rabbitmq', model, sub);
    if (!queues.has(queue)) queues.set(queue, { source: sub.topicDefault, queue, deadLetter: null, subscriptions: [] });
    const entry = queues.get(queue);
    entry.subscriptions.push(sub.name);
    // El descarte es propiedad de la COLA: basta con que una de las que la comparten lo declare.
    if (sub.deadLetter) entry.deadLetter = deadLetterName('rabbitmq', queue);
  }
  return [...queues.values()];
}

// ─── La topología y el reintento (TypeScript puro) ───────────────────────────

function topologyFile(model) {
  const topology = rabbitTopology(model);
  const retry = rabbitListenerRetry(model);
  const entries = topology
    .map(
      (entry) => `  {
    source: ${tsString(entry.source)},
    queue: ${tsString(entry.queue)},
    deadLetter: ${entry.deadLetter ? tsString(entry.deadLetter) : 'null'},
    subscriptions: [${entry.subscriptions.map(tsString).join(', ')}]
  }`
    )
    .join(',\n');
  const retryLiteral = retry
    ? `{ attempts: ${retry.attempts}, initialMs: ${retry.initialMs}, multiplier: ${retry.multiplier}, maxDelayMs: ${retry.maxDelayMs ?? 'null'} }`
    : 'null';
  const body = `/** La topología de consumo de una cola de este servicio. */
export interface QueueTopology {
  /** El exchange (topic) del canal de origen, el del emisor. */
  readonly source: string;
  /** La cola PROPIA de este servicio, enlazada al exchange con '#'. */
  readonly queue: string;
  /** Su descarte, enlazado por argumentos x-dead-letter-*; null si ninguna suscripción lo declara. */
  readonly deadLetter: string | null;
  /** Las suscripciones del diseño que consumen de ella. */
  readonly subscriptions: readonly string[];
}

/**
 * La topología RabbitMQ de las suscripciones: la MISMA que declara RabbitTopologyConfig en el servidor de
 * keel-spring del diseño. El canal que nombra el diseño es el exchange del emisor, y de un exchange no se
 * consume: cuelga de él una cola propia de este servicio (dos servicios en el mismo canal necesitan colas
 * distintas, o el broker les repartiría los mensajes). El binding es '#' porque el canal transporta todo
 * lo que publica su emisor: el filtro por tipo va en el listener.
 *
 * Es de BUILD: no la redeclares en un listener. Dos declaraciones de la misma cola con argumentos
 * distintos hacen que RabbitMQ rechace la segunda con PRECONDITION_FAILED.
 */
export const RABBIT_TOPOLOGY: readonly QueueTopology[] = [
${entries}
];

/** Lo que una declaración de topología necesita del canal (lo cumple el Channel de amqplib). */
export interface TopologyChannel {
  assertExchange(exchange: string, type: string, options?: { durable?: boolean; autoDelete?: boolean }): Promise<unknown>;
  assertQueue(queue: string, options?: { durable?: boolean; arguments?: Record<string, unknown> }): Promise<unknown>;
  bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;
}

/** Declara la topología: idempotente, se repite en cada (re)conexión. */
export async function assertTopology(channel: TopologyChannel, topology: readonly QueueTopology[] = RABBIT_TOPOLOGY): Promise<void> {
  for (const entry of topology) {
    await channel.assertExchange(entry.source, 'topic', { durable: true, autoDelete: false });
    if (entry.deadLetter != null) await channel.assertQueue(entry.deadLetter, { durable: true });
    await channel.assertQueue(entry.queue, {
      durable: true,
      arguments: entry.deadLetter == null ? {} : { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': entry.deadLetter }
    });
    await channel.bindQueue(entry.queue, entry.source, '#');
  }
}

/** El reintento del listener, de onFailure.retry (keel-core, rabbitListenerRetry). */
export interface ListenerRetry {
  readonly attempts: number;
  readonly initialMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number | null;
}

/**
 * El reintento ${retry ? `que declaran ${retry.subscriptions.join(', ')}` : 'de las suscripciones: ninguna lo declara, así que un fallo va al descarte al primer intento'}. Uno para todo el contenedor, como en
 * keel-spring: con varias políticas gana la más paciente.
 */
export const LISTENER_RETRY: ListenerRetry | null = ${retryLiteral};

/** Los intentos de una entrega, el primero incluido. */
export function listenerAttempts(retry: ListenerRetry | null = LISTENER_RETRY): number {
  return retry?.attempts ?? 1;
}

/** La espera antes del intento \`attempt + 1\`: initial·multiplier^(attempt-1), con su techo. */
export function listenerBackoffMs(attempt: number, retry: ListenerRetry | null = LISTENER_RETRY): number {
  if (retry == null) return 0;
  const delay = retry.initialMs * retry.multiplier ** Math.max(attempt - 1, 0);
  return retry.maxDelayMs != null ? Math.min(delay, retry.maxDelayMs) : delay;
}

/**
 * ¿Se reintenta este fallo? No el rechazo de negocio (DomainException): no se resuelve mejor dentro de un
 * segundo, y peor, el reintento en memoria repite la MISMA entrega, así que un guard que reclama antes
 * (tryRecord) encontraría el evento ya marcado y lo confirmaría sin que llegara nunca al descarte. Ni el
 * contrato incumplido (MessageContractViolation): un mensaje mal formado no se vuelve válido.
 */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof DomainException) && !(error instanceof MessageContractViolation);
}`;
  return tsModule(
    RABBIT_TOPOLOGY_TS,
    [
      { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
      { symbol: 'MessageContractViolation', from: MESSAGE_CONTRACT_TS }
    ],
    body
  );
}

// ─── La conexión ─────────────────────────────────────────────────────────────

function connectionFile() {
  const body = `/** Token de la conexión con RabbitMQ ya resuelta para el perfil. */
export const RABBITMQ_SETTINGS = Symbol('RABBITMQ_SETTINGS');

export interface RabbitMqSettings {
  /** false en el perfil test: las pruebas de build arrancan sin broker. */
  readonly enabled: boolean;
  readonly url: string;
  /** El techo de la espera entre reconexiones (la recuperación del listener de keel-spring). */
  readonly recoveryIntervalMs: number;
  /** Cuánto espera una publicación la confirmación del broker. */
  readonly confirmTimeoutMs: number;
}

/** La conexión del perfil activo, con las mismas variables que keel-spring. */
export function rabbitMqSettings(configuration: Configuration): RabbitMqSettings {
  const get = (key: string): string => String(configuration.get(key) ?? '');
  const host = get('rabbitmq.host') || 'localhost';
  const port = Number(get('rabbitmq.port') || 5672);
  const credentials = \`\${encodeURIComponent(get('rabbitmq.username') || 'guest')}:\${encodeURIComponent(get('rabbitmq.password') || 'guest')}\`;
  return {
    enabled: configuration.get('rabbitmq.enabled') !== false && configuration.get('rabbitmq.enabled') !== 'false',
    url: \`amqp://\${credentials}@\${host}:\${port}\`,
    recoveryIntervalMs: positive(configuration.get('rabbitmq.listener.recovery-interval-ms'), ${RABBIT_RECOVERY_INTERVAL_MS}),
    confirmTimeoutMs: positive(configuration.get('rabbitmq.publisher.confirm-timeout-ms'), ${RABBIT_CONFIRM_TIMEOUT_MS})
  };
}

function positive(value: unknown, fallback: number): number {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`RabbitMQ: '\${String(value)}' no es un entero positivo\`);
  return parsed;
}

/** Lo que un listener hace con un mensaje. Lanzar es fallar: se reintenta o va al descarte. */
export type MessageHandler = (message: ConsumeMessage) => Promise<void>;

/** El broker no está disponible ahora: la publicación no salió y hay que reintentarla. */
export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}

/**
 * La conexión con RabbitMQ: una por proceso, con reconexión. En cada (re)conexión declara la topología
 * de build (RABBIT_TOPOLOGY) y vuelve a arrancar los consumidores registrados. El servicio arranca SIN
 * broker —como el de keel-spring—: la conexión se intenta en segundo plano y se reintenta sin fin.
 *
 * Lo que escribe el agente usa dos métodos:
 *   · publish: con confirmación del broker y \`mandatory\`. Resuelve cuando el broker CONFIRMA; falla si
 *     no hay conexión, si lo rechaza, si el mensaje no tenía cola a la que ir o si vence el plazo. Es lo
 *     que necesita el dispatcher del outbox: marcar como publicado lo que el broker descartó es lo que
 *     el outbox existe para impedir;
 *   · consume: registra un consumidor de una cola de la topología. Confirma al terminar bien, reintenta
 *     en memoria con la curva del diseño lo que es transitorio y rechaza sin reencolar el resto (va a la
 *     DLQ si la cola la tiene).
 */
@Injectable()
export class RabbitConnection implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('RabbitConnection');
  private readonly consumers: Array<{ readonly queue: string; readonly handler: MessageHandler }> = [];
  private connection: RecoveringChannelModel | null = null;
  private live: ChannelModel | null = null;
  private confirm: Promise<ConfirmChannel> | null = null;
  private stopping = false;

  constructor(@Inject(RABBITMQ_SETTINGS) private readonly settings: RabbitMqSettings) {}

  /** ¿Hay conexión ahora mismo? */
  get connected(): boolean {
    return this.live != null;
  }

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) return;
    connect(this.settings.url, {
      recovery: {
        initialDelay: 200,
        maxDelay: this.settings.recoveryIntervalMs,
        maxRetries: Infinity,
        setup: (model: ChannelModel) => this.onConnected(model)
      }
    })
      .then((connection) => {
        this.connection = connection;
        connection.on('reconnect-scheduled', ({ attempt, delay, error }: { attempt: number; delay: number; error: Error }) =>
          this.logger.warn(\`RabbitMQ: reconexión \${attempt} en \${delay} ms (\${error.message})\`)
        );
        connection.on('error', (error: Error) => this.logger.error(\`RabbitMQ: \${error.message}\`));
      })
      .catch((error: unknown) => this.logger.error(\`RabbitMQ: no se pudo conectar: \${error instanceof Error ? error.message : String(error)}\`));
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.connection?.close().catch(() => undefined);
  }

  /** Registra el consumidor de \`queue\`: arranca con la conexión y tras cada reconexión. */
  consume(queue: string, handler: MessageHandler): void {
    this.consumers.push({ queue, handler });
    if (this.live != null) void this.startConsumer(this.live, queue, handler);
  }

  /**
   * Publica \`payload\` (JSON ya serializado con el contrato del cable) en \`exchange\` con \`routingKey\`,
   * con \`type\` como tipo nativo del mensaje (sobre él filtran los consumidores). Resuelve cuando el
   * broker confirma; lanza BrokerUnavailableError si no salió.
   */
  async publish(exchange: string, routingKey: string, payload: string, type: string, headers: Record<string, unknown> = {}): Promise<void> {
    if (this.live == null || this.confirm == null) throw new BrokerUnavailableError('RabbitMQ no está conectado');
    const channel = await this.confirm;
    const messageId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let returned = false;
      const onReturn = (message: Message): void => {
        if (message.properties.messageId === messageId) returned = true;
      };
      const timer = setTimeout(() => {
        channel.off('return', onReturn);
        reject(new BrokerUnavailableError(\`RabbitMQ no confirmó la publicación en \${this.settings.confirmTimeoutMs} ms\`));
      }, this.settings.confirmTimeoutMs);
      channel.on('return', onReturn);
      try {
        channel.publish(
          exchange,
          routingKey,
          Buffer.from(payload, 'utf8'),
          { persistent: true, mandatory: true, contentType: 'application/json', type, messageId, headers },
          (error: unknown) => {
            clearTimeout(timer);
            channel.off('return', onReturn);
            // El 'return' de un mensaje sin cola llega ANTES de su confirmación.
            if (error) reject(new BrokerUnavailableError('RabbitMQ rechazó la publicación'));
            else if (returned) reject(new BrokerUnavailableError(\`El mensaje no tenía cola en \${exchange} con \${routingKey}\`));
            else resolve();
          }
        );
      } catch (error) {
        clearTimeout(timer);
        channel.off('return', onReturn);
        reject(error);
      }
    });
  }

  private async onConnected(model: ChannelModel): Promise<void> {
    const channel = await model.createChannel();
    try {
      await assertTopology(channel);
    } finally {
      await channel.close().catch(() => undefined);
    }
    this.live = model;
    this.confirm = model.createConfirmChannel();
    // Un canal que el broker cierra (una publicación a un exchange que no existe lo hace) se reabre en la
    // siguiente publicación, no se queda muerto hasta la próxima reconexión.
    void this.confirm.then((confirm) => confirm.on('close', () => {
      if (this.live === model && !this.stopping) this.confirm = model.createConfirmChannel();
    }));
    model.on('close', () => {
      if (this.live === model) {
        this.live = null;
        this.confirm = null;
      }
    });
    for (const { queue, handler } of this.consumers) await this.startConsumer(model, queue, handler);
    this.logger.log('RabbitMQ: conectado, topología declarada');
  }

  private async startConsumer(model: ChannelModel, queue: string, handler: MessageHandler): Promise<void> {
    const channel = await model.createChannel();
    await channel.prefetch(${RABBIT_PREFETCH});
    await channel.consume(queue, (message) => {
      if (message != null) void this.deliver(channel, message, handler);
    });
  }

  /** Lo que hace el contenedor de listeners de Spring con cada entrega. */
  private async deliver(channel: Channel, message: ConsumeMessage, handler: MessageHandler): Promise<void> {
    const attempts = listenerAttempts();
    for (let attempt = 1; ; attempt++) {
      try {
        await handler(message);
        channel.ack(message);
        return;
      } catch (error) {
        const reason = error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
        if (!isRetryable(error) || attempt >= attempts) {
          // Rechazo SIN reencolar: con DLQ declarada, el broker lo lleva al descarte.
          this.logger.error(\`RabbitMQ: mensaje de \${message.fields.routingKey} descartado tras \${attempt} intento(s): \${reason}\`);
          channel.nack(message, false, false);
          return;
        }
        this.logger.warn(\`RabbitMQ: fallo procesando un mensaje (intento \${attempt}): \${reason}\`);
        await new Promise((resolve) => setTimeout(resolve, listenerBackoffMs(attempt)));
      }
    }
  }
}`;
  return tsModule(
    RABBIT_CONNECTION_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'BeforeApplicationShutdown', from: '@nestjs/common', type: true },
      { symbol: 'OnApplicationBootstrap', from: '@nestjs/common', type: true },
      { symbol: 'connect', from: 'amqplib' },
      { symbol: 'Channel', from: 'amqplib', type: true },
      { symbol: 'ChannelModel', from: 'amqplib', type: true },
      { symbol: 'ConfirmChannel', from: 'amqplib', type: true },
      { symbol: 'ConsumeMessage', from: 'amqplib', type: true },
      { symbol: 'Message', from: 'amqplib', type: true },
      { symbol: 'RecoveringChannelModel', from: 'amqplib', type: true },
      { symbol: 'randomUUID', from: 'node:crypto' },
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: 'assertTopology', from: RABBIT_TOPOLOGY_TS },
      { symbol: 'isRetryable', from: RABBIT_TOPOLOGY_TS },
      { symbol: 'listenerAttempts', from: RABBIT_TOPOLOGY_TS },
      { symbol: 'listenerBackoffMs', from: RABBIT_TOPOLOGY_TS }
    ],
    body
  );
}

// ─── La configuración ────────────────────────────────────────────────────────

// El gradiente de keel-spring: literal en local y test, `${VAR:default}` en develop y `${VAR}` sin
// default en production (un broker que nadie eligió no deja arrancar).
function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

function envWithDefault(profile, name, value) {
  return profile === 'local' || profile === 'test' ? String(value) : `\${${name}:${value}}`;
}

function rabbitYaml(_model, profile) {
  const lines = [
    'rabbitmq:',
    ...(profile === 'test'
      ? ['  # Las pruebas de build arrancan sin broker: la conexión no se intenta.', '  enabled: false']
      : ['  enabled: true']),
    `  host: ${envValue(profile, 'RABBITMQ_HOST', 'localhost')}`,
    `  port: ${envValue(profile, 'RABBITMQ_PORT', 5672)}`,
    `  username: ${envValue(profile, 'RABBITMQ_USERNAME', 'guest')}`,
    `  password: ${envValue(profile, 'RABBITMQ_PASSWORD', 'guest')}`,
    '  listener:',
    '    # Techo de la espera entre reconexiones (la misma clave que keel-spring).',
    `    recovery-interval-ms: ${envWithDefault(profile, 'RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS', RABBIT_RECOVERY_INTERVAL_MS)}`
  ];
  // El reintento del listener NO va aquí: sale del diseño (onFailure.retry) y lo lleva rabbit-topology.ts.
  // Una clave que nadie lee sería una palanca que no mueve nada.
  lines.push(
    '  publisher:',
    '    # Cuánto espera una publicación la confirmación del broker: por encima de la recuperación.',
    `    confirm-timeout-ms: ${envWithDefault(profile, 'RABBITMQ_PUBLISHER_CONFIRM_TIMEOUT_MS', RABBIT_CONFIRM_TIMEOUT_MS)}`
  );
  return `${lines.join('\n')}\n`;
}
