// SNS/SQS en keel-nest (incremento 9g): lo que en el servidor de keel-spring ponen Spring Cloud AWS, build y la
// skill keel-spring-snssqs, y que en Node no pone nadie.
//
//   · el CONSUMO como datos (`snssqs-consumption.ts`, TypeScript puro): por suscripción, su cola propia, su DLQ y
//     su `maxReceiveCount` — los MISMOS que siembra `infra/init-messaging.sh` (keel-core/gen/
//     messaging-provisioning.js, `subscriptionQueues`)—, y la curva del reintento, que en SQS no la aplica la
//     cola sino quien alarga la VISIBILIDAD del mensaje según cuántas veces lo ha recibido;
//   · la CONEXIÓN (`snssqs-connection.ts`) sobre el SDK v3 de AWS: las mismas variables que keel-spring
//     (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SNS_ENDPOINT, AWS_SQS_ENDPOINT); la publicación
//     en SNS con el tipo del evento como message attribute `eventType` (sobre él filtran las suscripciones) y con
//     el ARN resuelto LISTANDO y exigiendo un suscriptor confirmado —crear el topic al publicar, lo que hace el
//     resolutor por defecto de Spring, publica en un topic sin suscriptores, y SNS descarta sin error—; y un
//     consumidor por suscripción que sondea su cola: borra al terminar bien, alarga la visibilidad con la curva
//     del diseño lo que es transitorio (y al agotar `maxReceiveCount` la RedrivePolicy lo lleva a la DLQ), y lo
//     no reintentable lo lleva él mismo a la DLQ.
//
// En AWS real la topología la crea la plataforma (IaC), no la aplicación. Lo que escribe el agente (skill
// keel-nest-snssqs) es lo mismo que en keel-spring: el dispatcher del outbox o los publishers best-effort sobre
// `SnsSqsConnection.publish`, y un listener por suscripción sobre `SnsSqsConnection.consume`.

import { subscriptionQueues } from 'keel-core/gen/messaging-provisioning';
import { DOMAIN_EXCEPTION_TS } from './exceptions.js';
import { tsModule, tsString } from './render.js';
import { MESSAGE_CONTRACT_TS, MESSAGING_SETTINGS_TS, SNSSQS_CONNECTION_TS, SNSSQS_CONSUMPTION_TS, usesSnsSqs } from './messaging.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

/** La espera entre intentos mientras el broker o una cola no están: la de los demás brokers. */
export const SNSSQS_RECONNECT_INTERVAL_MS = 5000;
/** El sondeo largo de SQS: hasta 10 s esperando mensajes (el `poll-timeout` de la skill de keel-spring). */
export const SQS_POLL_WAIT_SECONDS = 10;
/** Mensajes por sondeo: el máximo de SQS. */
export const SQS_MAX_MESSAGES = 10;
/**
 * Los plazos de una llamada a SNS: los de la skill keel-spring-snssqs (`apiCallAttemptTimeout` 1,5 s, dos
 * intentos). Sin ellos el SDK reintenta puertas adentro con su propia política, y ese tiempo se suma al backoff
 * del relay en vez de estar gobernado por él: la fila se rinde dentro de la misma caída que causó el fallo.
 */
export const SNS_REQUEST_TIMEOUT_MS = 1500;
export const SNS_MAX_ATTEMPTS = 2;

export function generate(model) {
  if (!usesSnsSqs(model)) return [];
  return [
    { path: SNSSQS_CONSUMPTION_TS, content: consumptionFile(model) },
    { path: SNSSQS_CONNECTION_TS, content: connectionFile() },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/snssqs.yaml`, content: snssqsYaml(profile) }))
  ];
}

/** El consumo como DATOS: una entrada por SUSCRIPCIÓN, cada una con su cola (la de init-messaging.sh). */
export function snsSqsConsumption(model) {
  const queues = subscriptionQueues(model);
  return (model.subscriptions ?? []).map((sub, index) => ({
    subscription: sub.name,
    queue: queues[index].name,
    deadLetterQueue: queues[index].deadLetter ? queues[index].deadLetterName : null,
    maxReceive: queues[index].maxReceive,
    initialMs: sub.retry?.initialDelayMs ?? 1000,
    multiplier: (sub.retry?.backoff ?? 'exponential') === 'exponential' ? 2 : 1,
    maxDelayMs: sub.retry?.maxDelayMs ?? null
  }));
}

// ─── El consumo y el reintento (TypeScript puro) ─────────────────────────────

function consumptionFile(model) {
  const entries = snsSqsConsumption(model)
    .map(
      (entry) => `  {
    subscription: ${tsString(entry.subscription)},
    queue: ${tsString(entry.queue)},
    deadLetterQueue: ${entry.deadLetterQueue ? tsString(entry.deadLetterQueue) : 'null'},
    maxReceive: ${entry.maxReceive},
    initialMs: ${entry.initialMs},
    multiplier: ${entry.multiplier},
    maxDelayMs: ${entry.maxDelayMs ?? 'null'}
  }`
    )
    .join(',\n');
  const body = `/** Cómo consume una suscripción: su cola, su descarte y su reintento (los defaults del diseño). */
export interface SubscriptionConsumption {
  readonly subscription: string;
  /** La cola PROPIA de este servicio, suscrita al topic de la fuente con filtro por eventType. */
  readonly queue: string;
  /** Su DLQ (RedrivePolicy de infra/init-messaging.sh); null si la suscripción no declara onFailure.deadLetter. */
  readonly deadLetterQueue: string | null;
  /** Recepciones antes del descarte: onFailure.retry.maxAttempts (uno sin retry). Lo cuenta SQS. */
  readonly maxReceive: number;
  readonly initialMs: number;
  /** 2 con backoff exponential (la curva de la skill keel-spring-snssqs); 1 con fixed. */
  readonly multiplier: number;
  readonly maxDelayMs: number | null;
}

/**
 * El consumo de este servicio: las MISMAS colas, DLQ y recepciones que siembra infra/init-messaging.sh y que
 * consume el servidor de keel-spring del diseño. El perfil puede renombrar la cola
 * (messaging.subscriptions.<e>.queue).
 */
export const SNSSQS_CONSUMPTION: readonly SubscriptionConsumption[] = [
${entries}
];

/**
 * Cuántos segundos queda oculto un mensaje tras su recepción \`received\` fallida: initial·multiplier^(n-1), con
 * su techo, redondeado hacia arriba al segundo (SQS no admite menos). Es el backoff del diseño: SQS no tiene
 * otro, y sin alargar la visibilidad el mensaje volvería a los 30 s fijos de la cola.
 */
export function retryVisibilitySeconds(consumption: SubscriptionConsumption, received: number): number {
  const delay = consumption.initialMs * consumption.multiplier ** Math.max(received - 1, 0);
  const capped = consumption.maxDelayMs != null ? Math.min(delay, consumption.maxDelayMs) : delay;
  return Math.min(Math.max(Math.ceil(capped / 1000), 0), 43_200);
}

/**
 * ¿Se reintenta este fallo? No el rechazo de negocio (DomainException) ni el contrato incumplido
 * (MessageContractViolation): no mejoran con otra recepción, y repetirlos con un guard que reclama antes
 * (tryRecord) haría que la segunda recepción encontrara el mensaje marcado y lo borrara sin que llegara nunca a la
 * DLQ. SQS no distingue tipos de excepción: lo lleva a la DLQ la conexión (la salida que la skill keel-spring-snssqs
 * da para los errores que el diseño no quiere reintentar).
 */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof DomainException) && !(error instanceof MessageContractViolation);
}`;
  return tsModule(
    SNSSQS_CONSUMPTION_TS,
    [
      { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
      { symbol: 'MessageContractViolation', from: MESSAGE_CONTRACT_TS }
    ],
    body
  );
}

// ─── La conexión ─────────────────────────────────────────────────────────────

function connectionFile() {
  const body = `/** Token de la conexión con SNS/SQS ya resuelta para el perfil. */
export const SNSSQS_SETTINGS = Symbol('SNSSQS_SETTINGS');

export interface SnsSqsSettings {
  /** false en el perfil test: las pruebas de build arrancan sin broker. */
  readonly enabled: boolean;
  readonly region: string;
  /** Credenciales estáticas; null para la cadena por defecto del SDK (un rol IAM en producción). */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
  /** El endpoint de SNS y el de SQS: LocalStack fuera de producción; null para el de AWS de la región. */
  readonly snsEndpoint: string | null;
  readonly sqsEndpoint: string | null;
  /** El sondeo largo de SQS y cuántos mensajes trae cada uno. */
  readonly pollWaitSeconds: number;
  readonly maxMessagesPerPoll: number;
  /** La espera entre intentos mientras el broker o una cola no están. */
  readonly reconnectIntervalMs: number;
}

/** La conexión del perfil activo, con las mismas variables que keel-spring. */
export function snsSqsSettings(configuration: Configuration): SnsSqsSettings {
  const get = (key: string): string => String(configuration.get(key) ?? '').trim();
  const accessKeyId = get('aws.credentials.access-key');
  const secretAccessKey = get('aws.credentials.secret-key');
  return {
    enabled: configuration.get('aws.enabled') !== false && configuration.get('aws.enabled') !== 'false',
    region: get('aws.region') || 'us-east-1',
    credentials: accessKeyId !== '' && secretAccessKey !== '' ? { accessKeyId, secretAccessKey } : null,
    snsEndpoint: get('aws.sns.endpoint') || null,
    sqsEndpoint: get('aws.sqs.endpoint') || null,
    pollWaitSeconds: bounded(configuration.get('aws.sqs.listener.poll-timeout-seconds'), ${SQS_POLL_WAIT_SECONDS}, 0, 20),
    maxMessagesPerPoll: bounded(configuration.get('aws.sqs.listener.max-messages-per-poll'), ${SQS_MAX_MESSAGES}, 1, 10),
    reconnectIntervalMs: bounded(configuration.get('aws.reconnect-interval-ms'), ${SNSSQS_RECONNECT_INTERVAL_MS}, 1, Number.MAX_SAFE_INTEGER)
  };
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(\`SNS/SQS: '\${String(value)}' tiene que ser un entero entre \${min} y \${max}\`);
  return parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Un mensaje recibido de la cola: su cuerpo, sus message attributes y cuántas veces se ha recibido. */
export interface InboundMessage {
  /** El MessageId de SQS: cambia en cada reenvío a la cola, NO sirve para deduplicar. */
  readonly messageId: string;
  /** El cuerpo tal cual viajó (con raw delivery, el JSON de la envoltura si lo publicó un servicio Keel). */
  readonly body: string;
  /** Los message attributes (eventType y los que declare el contrato), como cadenas. */
  readonly attributes: Readonly<Record<string, string>>;
  /** ApproximateReceiveCount: 1 en la primera entrega. */
  readonly receiveCount: number;
}

/** Lo que un listener hace con un mensaje. Lanzar es fallar: se reintenta o va a la DLQ. */
export type MessageHandler = (message: InboundMessage) => Promise<void>;

/** El broker no está disponible ahora: la publicación no salió y hay que reintentarla. */
export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}

interface Subscriber {
  readonly consumption: SubscriptionConsumption;
  readonly queue: string;
  readonly handler: MessageHandler;
  queueUrl: string | null;
  deadLetterUrl: string | null;
  /** ¿Ha completado ya algún sondeo? Es lo que el arnés espera antes de entregar. */
  polling: boolean;
}

/**
 * La conexión con SNS/SQS: un cliente de cada, y un bucle de sondeo por suscripción. El servicio arranca SIN
 * broker —como el de keel-spring—: el sondeo reintenta mientras la cola no existe o LocalStack no responde.
 *
 * Lo que escribe el agente usa dos métodos:
 *   · publish: publica en el topic con sus message attributes y resuelve cuando SNS lo acepta; lanza
 *     BrokerUnavailableError si el topic no existe, no tiene ningún suscriptor confirmado o SNS no responde. Es
 *     lo que necesita el dispatcher del outbox: dar por publicado lo que SNS descartó por no tener a quién
 *     entregar es lo que el outbox existe para impedir;
 *   · consume: registra el consumidor de una suscripción (su cola). Borra el mensaje al terminar bien; alarga su
 *     visibilidad con la curva del diseño si el fallo es transitorio (al agotar maxReceiveCount, la RedrivePolicy
 *     lo lleva a la DLQ); y lo no reintentable lo lleva directamente a la DLQ si la hay, o lo registra y lo borra.
 */
@Injectable()
export class SnsSqsConnection implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('SnsSqsConnection');
  private readonly subscribers: Subscriber[] = [];
  private readonly sns: SNSClient;
  private readonly sqs: SQSClient;
  /** El ARN de cada topic, solo cuando ya se vio con un suscriptor confirmado. */
  private readonly topicArns = new Map<string, string>();
  private readonly polls: Array<Promise<void>> = [];
  private readonly abort = new AbortController();
  private started = false;
  private stopping = false;

  constructor(
    @Inject(SNSSQS_SETTINGS) private readonly settings: SnsSqsSettings,
    @Inject(MESSAGING_SETTINGS) private readonly messaging: MessagingSettings
  ) {
    const common = {
      region: settings.region,
      ...(settings.credentials ? { credentials: settings.credentials } : {})
    };
    this.sns = new SNSClient({
      ...common,
      ...(settings.snsEndpoint ? { endpoint: settings.snsEndpoint } : {}),
      maxAttempts: ${SNS_MAX_ATTEMPTS},
      requestHandler: { requestTimeout: ${SNS_REQUEST_TIMEOUT_MS}, connectionTimeout: ${SNS_REQUEST_TIMEOUT_MS}, throwOnRequestTimeout: true }
    });
    // El plazo de una recepción tiene que pasar del sondeo largo, o cada sondeo vacío sería un error.
    const pollTimeoutMs = (settings.pollWaitSeconds + 10) * 1000;
    this.sqs = new SQSClient({
      ...common,
      ...(settings.sqsEndpoint ? { endpoint: settings.sqsEndpoint } : {}),
      requestHandler: { requestTimeout: pollTimeoutMs, connectionTimeout: 5000, throwOnRequestTimeout: true }
    });
  }

  /** ¿Ha sondeado ya cada consumidor su cola al menos una vez? */
  get connected(): boolean {
    return this.subscribers.every((subscriber) => subscriber.polling);
  }

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) return;
    this.started = true;
    for (const subscriber of this.subscribers) this.polls.push(this.poll(subscriber));
  }

  /** Para los sondeos (corta el que esté esperando) y cierra los clientes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await Promise.race([Promise.allSettled(this.polls), sleep(5000)]);
    this.sns.destroy();
    this.sqs.destroy();
  }

  /** Registra el consumidor de la suscripción \`subscription\` (su NOMBRE en el diseño): arranca con la conexión. */
  consume(subscription: string, handler: MessageHandler): void {
    const settings = this.messaging.subscriptions[subscription];
    const consumption = SNSSQS_CONSUMPTION.find((entry) => entry.subscription === subscription);
    if (settings == null || consumption == null) {
      throw new Error(\`'\${subscription}' no es una suscripción de este servicio. Declaradas: \${SNSSQS_CONSUMPTION.map((entry) => entry.subscription).join(', ')}\`);
    }
    const subscriber: Subscriber = { consumption, queue: settings.queue ?? consumption.queue, handler, queueUrl: null, deadLetterUrl: null, polling: false };
    this.subscribers.push(subscriber);
    if (this.started) this.polls.push(this.poll(subscriber));
  }

  /**
   * Publica \`payload\` (JSON ya serializado con el contrato del cable) en el topic \`topic\` (su NOMBRE), con
   * \`attributes\` como message attributes —\`eventType\` es obligatorio: sobre él filtran las suscripciones—.
   * Resuelve cuando SNS lo acepta; lanza BrokerUnavailableError si no salió.
   */
  async publish(topic: string, payload: string, attributes: Readonly<Record<string, string>>): Promise<void> {
    if (this.stopping) throw new BrokerUnavailableError('SNS/SQS: la conexión se está cerrando');
    if (!attributes['eventType']) throw new Error('SNS: falta el message attribute eventType, y sin él ninguna suscripción recibe el mensaje');
    const arn = await this.topicArn(topic);
    const MessageAttributes: Record<string, { DataType: string; StringValue: string }> = {};
    for (const [name, value] of Object.entries(attributes)) MessageAttributes[name] = { DataType: 'String', StringValue: value };
    try {
      await this.sns.send(new PublishCommand({ TopicArn: arn, Message: payload, MessageAttributes }));
    } catch (error) {
      // Un topic que desapareció (LocalStack reiniciado sin resembrar) obliga a resolverlo de nuevo.
      this.topicArns.delete(topic);
      throw new BrokerUnavailableError(\`SNS no aceptó la publicación en \${topic}: \${describe(error)}\`);
    }
  }

  /**
   * El ARN de un topic que EXISTE y tiene al menos un suscriptor confirmado. Nunca se crea: SNS entrega en el
   * momento, y un topic sin suscriptores descarta lo publicado sin decir nada.
   */
  private async topicArn(topic: string): Promise<string> {
    const cached = this.topicArns.get(topic);
    if (cached != null) return cached;
    try {
      let arn: string | null = null;
      let next: string | undefined;
      do {
        const page = await this.sns.send(new ListTopicsCommand({ NextToken: next }));
        arn = page.Topics?.find((candidate) => candidate.TopicArn?.endsWith(\`:\${topic}\`))?.TopicArn ?? null;
        next = page.NextToken;
      } while (arn == null && next != null);
      if (arn == null) throw new BrokerUnavailableError(\`SNS: el topic \${topic} no existe\`);
      const subscriptions = await this.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn }));
      const confirmed = (subscriptions.Subscriptions ?? []).some((subscription) => subscription.SubscriptionArn && subscription.SubscriptionArn !== 'PendingConfirmation');
      if (!confirmed) throw new BrokerUnavailableError(\`SNS: el topic \${topic} todavía no tiene ningún suscriptor confirmado\`);
      this.topicArns.set(topic, arn);
      return arn;
    } catch (error) {
      if (error instanceof BrokerUnavailableError) throw error;
      throw new BrokerUnavailableError(\`SNS no resolvió el topic \${topic}: \${describe(error)}\`);
    }
  }

  private async queueUrl(name: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: this.abort.signal });
    if (QueueUrl == null) throw new Error(\`SQS no devolvió la URL de \${name}\`);
    return QueueUrl;
  }

  private async poll(subscriber: Subscriber): Promise<void> {
    while (!this.stopping) {
      try {
        subscriber.queueUrl ??= await this.queueUrl(subscriber.queue);
        if (subscriber.consumption.deadLetterQueue != null) subscriber.deadLetterUrl ??= await this.queueUrl(subscriber.consumption.deadLetterQueue);
        const received = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: subscriber.queueUrl,
            MaxNumberOfMessages: this.settings.maxMessagesPerPoll,
            WaitTimeSeconds: this.settings.pollWaitSeconds,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['ApproximateReceiveCount']
          }),
          { abortSignal: this.abort.signal }
        );
        if (!subscriber.polling) {
          subscriber.polling = true;
          this.logger.log(\`SQS: consumidor de \${subscriber.consumption.subscription} en \${subscriber.queue}\`);
        }
        for (const message of received.Messages ?? []) {
          if (this.stopping) break;
          await this.deliver(subscriber, message);
        }
      } catch (error) {
        if (this.stopping) return;
        // La cola o el broker no están (LocalStack reiniciado, la topología sin sembrar): se resuelve otra vez, y el
        // consumidor deja de contar como conectado hasta que vuelva a sondear.
        subscriber.polling = false;
        subscriber.queueUrl = null;
        subscriber.deadLetterUrl = null;
        this.logger.warn(\`SQS: no se pudo sondear \${subscriber.queue} (\${describe(error)}); se reintenta\`);
        await sleep(this.settings.reconnectIntervalMs);
      }
    }
  }

  /** Lo que hacen Spring Cloud AWS (ack ON_SUCCESS) y el ErrorHandler de la skill keel-spring-snssqs con cada mensaje. */
  private async deliver(subscriber: Subscriber, message: Message): Promise<void> {
    const queueUrl = subscriber.queueUrl!;
    const receipt = message.ReceiptHandle!;
    const inbound = toInbound(message);
    const { consumption } = subscriber;
    try {
      await subscriber.handler(inbound);
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
      return;
    } catch (error) {
      if (this.stopping) return; // sin desenlace: vuelve a la cola al vencer su visibilidad
      const reason = describe(error);
      if (!isRetryable(error)) {
        if (subscriber.deadLetterUrl != null) {
          await this.sqs.send(new SendMessageCommand({ QueueUrl: subscriber.deadLetterUrl, MessageBody: message.Body ?? '', MessageAttributes: message.MessageAttributes }));
          this.logger.error(\`SQS: mensaje de \${subscriber.queue} llevado a \${consumption.deadLetterQueue} sin reintento: \${reason}\`);
        } else {
          this.logger.error(\`SQS: mensaje de \${subscriber.queue} descartado sin reintento; la suscripción no declara dead-letter: \${reason}\`);
        }
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
        return;
      }
      if (inbound.receiveCount >= consumption.maxReceive) {
        if (subscriber.deadLetterUrl == null) {
          // Sin RedrivePolicy volvería para siempre: se registra y se borra, como en los demás brokers.
          this.logger.error(\`SQS: mensaje de \${subscriber.queue} descartado tras \${inbound.receiveCount} recepción(es); la suscripción no declara dead-letter: \${reason}\`);
          await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
          return;
        }
        // Agotado: visible ya, y la RedrivePolicy lo lleva a la DLQ en la próxima recepción.
        this.logger.error(\`SQS: mensaje de \${subscriber.queue} agotó sus \${consumption.maxReceive} recepción(es); va a \${consumption.deadLetterQueue}: \${reason}\`);
        await this.changeVisibility(queueUrl, receipt, 0);
        return;
      }
      this.logger.warn(\`SQS: fallo procesando un mensaje de \${subscriber.queue} (recepción \${inbound.receiveCount}): \${reason}\`);
      await this.changeVisibility(queueUrl, receipt, retryVisibilitySeconds(consumption, inbound.receiveCount));
    }
  }

  private async changeVisibility(queueUrl: string, receipt: string, seconds: number): Promise<void> {
    try {
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt, VisibilityTimeout: seconds }));
    } catch (error) {
      // Si no se pudo alargar, vuelve al vencer la visibilidad de la cola: más tarde, pero vuelve.
      this.logger.warn(\`SQS: no se pudo cambiar la visibilidad de un mensaje (\${describe(error)})\`);
    }
  }
}

function toInbound(message: Message): InboundMessage {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
    if (value.StringValue != null) attributes[name] = value.StringValue;
  }
  return {
    messageId: message.MessageId ?? '',
    body: message.Body ?? '',
    attributes,
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1)
  };
}`;
  return tsModule(
    SNSSQS_CONNECTION_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'BeforeApplicationShutdown', from: '@nestjs/common', type: true },
      { symbol: 'OnApplicationBootstrap', from: '@nestjs/common', type: true },
      { symbol: 'ListSubscriptionsByTopicCommand', from: '@aws-sdk/client-sns' },
      { symbol: 'ListTopicsCommand', from: '@aws-sdk/client-sns' },
      { symbol: 'PublishCommand', from: '@aws-sdk/client-sns' },
      { symbol: 'SNSClient', from: '@aws-sdk/client-sns' },
      { symbol: 'ChangeMessageVisibilityCommand', from: '@aws-sdk/client-sqs' },
      { symbol: 'DeleteMessageCommand', from: '@aws-sdk/client-sqs' },
      { symbol: 'GetQueueUrlCommand', from: '@aws-sdk/client-sqs' },
      { symbol: 'ReceiveMessageCommand', from: '@aws-sdk/client-sqs' },
      { symbol: 'SendMessageCommand', from: '@aws-sdk/client-sqs' },
      { symbol: 'SQSClient', from: '@aws-sdk/client-sqs' },
      { symbol: 'Message', from: '@aws-sdk/client-sqs', type: true },
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: 'MESSAGING_SETTINGS', from: MESSAGING_SETTINGS_TS },
      { symbol: 'MessagingSettings', from: MESSAGING_SETTINGS_TS, type: true },
      { symbol: 'SNSSQS_CONSUMPTION', from: SNSSQS_CONSUMPTION_TS },
      { symbol: 'SubscriptionConsumption', from: SNSSQS_CONSUMPTION_TS, type: true },
      { symbol: 'isRetryable', from: SNSSQS_CONSUMPTION_TS },
      { symbol: 'retryVisibilitySeconds', from: SNSSQS_CONSUMPTION_TS }
    ],
    body
  );
}

// ─── La configuración ────────────────────────────────────────────────────────

// El gradiente de keel-spring: literal en local y test, `${VAR:default}` en develop y `${VAR}` sin default en
// production (una credencial que nadie eligió no deja arrancar).
function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

function envWithDefault(profile, name, value) {
  return profile === 'local' || profile === 'test' ? String(value) : `\${${name}:${value}}`;
}

function snssqsYaml(profile) {
  const lines = [
    'aws:',
    ...(profile === 'test'
      ? ['  # Las pruebas de build arrancan sin broker: la conexión no se intenta.', '  enabled: false']
      : ['  enabled: true']),
    `  region: ${envValue(profile, 'AWS_REGION', 'us-east-1')}`,
    '  credentials:',
    '    # En producción, si la plataforma da un rol IAM, vacía las dos y el SDK usa su cadena por defecto.',
    `    access-key: ${envValue(profile, 'AWS_ACCESS_KEY_ID', 'test')}`,
    `    secret-key: ${envValue(profile, 'AWS_SECRET_ACCESS_KEY', 'test')}`
  ];
  // En local y develop, LocalStack; en production el SDK resuelve el endpoint real de AWS (no se fija).
  if (profile !== 'production') lines.push('  sns:', `    endpoint: ${envValue(profile, 'AWS_SNS_ENDPOINT', 'http://localhost:4566')}`);
  lines.push('  sqs:');
  if (profile !== 'production') lines.push(`    endpoint: ${envValue(profile, 'AWS_SQS_ENDPOINT', 'http://localhost:4566')}`);
  lines.push(
    '    listener:',
    '      # Sondeo largo: hasta estos segundos esperando mensajes (el máximo de SQS es 20).',
    `      poll-timeout-seconds: ${envWithDefault(profile, 'SQS_LISTENER_POLL_TIMEOUT_SECONDS', SQS_POLL_WAIT_SECONDS)}`,
    `      max-messages-per-poll: ${envWithDefault(profile, 'SQS_LISTENER_MAX_MESSAGES_PER_POLL', SQS_MAX_MESSAGES)}`,
    '  # La espera entre intentos mientras el broker o una cola no están.',
    `  reconnect-interval-ms: ${envWithDefault(profile, 'AWS_RECONNECT_INTERVAL_MS', SNSSQS_RECONNECT_INTERVAL_MS)}`
  );
  return `${lines.join('\n')}\n`;
}
