// La mensajería del servicio (incremento 9): los contratos transversales al broker, como en keel-spring
// (`messaging.js` de keel-spring), y lo que allí pone Spring sin que nadie lo escriba.
//
// Build genera:
//   · la EventEnvelope (metadata + data) que viaja por el cable, con la EventMetadata que el agregado
//     estampó al emitir: el eventId es la clave de idempotencia del consumidor y no se regenera;
//   · por evento, el <Evento>IntegrationEvent: el gemelo de cable del evento de dominio, desacoplado de
//     él, cuya metadata NO se serializa en `data` (la autoritativa es la de la envoltura);
//   · el puente <Servicio>DomainEventBridge, al que los adaptadores de repositorio entregan los eventos
//     que drenan al guardar: con `reliability: outbox` escribe la fila del outbox DENTRO de la
//     transacción del cambio; con `best-effort` publica DESPUÉS del commit por el puerto
//     <Evento>Publisher (dominio), que mientras el agente no lo implemente es un stub que solo avisa;
//   · por suscripción, la clase del mensaje con su lector del cable y su `requireContract()`, y la
//     envoltura propia de la fuente cuando `envelope: wrapped`;
//   · la configuración (`config/parameters/<perfil>/messaging.yaml`, con las MISMAS claves y variables
//     que keel-spring) y los módulos que lo cablean.
//
// Lo único que depende del broker (`keel-stack.json`) es el ENVÍO y la RECEPCIÓN: la implementación de
// OutboxDispatcher (outbox) o de <Evento>Publisher (best-effort) y los listeners. Los escribe el agente
// siguiendo la skill keel-nest-<broker>, y los registra en UN solo archivo, `broker-bindings.ts`: es lo
// que en Spring hace el component-scan. La conexión con el broker y su topología de consumo sí son de
// build (`rabbitmq.js`, `kafka.js`), porque en Spring las pone Boot.
//
// Solo con persistencia RELACIONAL o sin persistencia: la documental llega con el incremento 12, y ahí
// el puente y el outbox son otra rama entera.

import { subscriptionDestination as destinationOf, subscriptionGroupId } from 'keel-core/gen';
import { OUTBOX_RELAY, parameterValue } from 'keel-core/gen/messaging-stores';
import { DIRS, classPath, fieldImports, tsModule, tsString, decapitalize } from './render.js';
import { DOMAIN_EVENT_TS, EVENT_METADATA_TS } from './events.js';
import { usesRelational } from './persistence-entities.js';
import { TRANSACTION_CONTEXT_TS } from './repositories.js';
import { CORRELATION_TS, REQUEST_READING_TS, REQUEST_ERRORS_TS, usesApi } from './rest-support.js';
import { readerOf, readerImports, valueReaders } from './controllers.js';
import { MODULE_TS as USE_CASE_MODULE_TS } from './mediator.js';

const MESSAGING_DIR = 'infrastructure/messaging';
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const WIRE_TS = 'src/application/support/wire.ts';

export const EVENT_ENVELOPE_TS = `src/${MESSAGING_DIR}/event-envelope.ts`;
export const MESSAGE_CONTRACT_TS = `src/${MESSAGING_DIR}/message-contract-violation.ts`;
export const MESSAGING_SETTINGS_TS = `src/${MESSAGING_DIR}/messaging-settings.ts`;
export const MESSAGING_MODULE_TS = `src/${MESSAGING_DIR}/messaging-module.ts`;
export const LISTENERS_MODULE_TS = `src/${MESSAGING_DIR}/message-listeners-module.ts`;
export const BROKER_BINDINGS_TS = `src/${MESSAGING_DIR}/broker-bindings.ts`;
export const OUTBOX_DIR = `${MESSAGING_DIR}/outbox`;
export const IDEMPOTENCY_DIR = `${MESSAGING_DIR}/idempotency`;

const PROFILES = ['local', 'develop', 'production', 'test'];

// ─── Qué se genera ───────────────────────────────────────────────────────────

/** ¿Hay mensajería que generar? Publica o consume, y su persistencia (si la tiene) es relacional. */
export function usesMessaging(model) {
  if (!model.layersPresent?.messaging) return false;
  if ((model.events ?? []).length === 0 && (model.subscriptions ?? []).length === 0) return false;
  return usesRelational(model) || !model.layersPresent?.persistence;
}

/** ¿Hay puente? Solo con persistencia relacional: los eventos salen del adaptador de repositorio. */
export function usesBridge(model) {
  return usesMessaging(model) && usesRelational(model) && (model.events ?? []).length > 0;
}

/** ¿Va por el outbox? Lo decide el diseño (`reliability: outbox`), y necesita la transacción del cambio. */
export function usesNestOutbox(model) {
  return usesBridge(model) && model.messaging?.reliability === 'outbox';
}

/** ¿Hay registro de mensajes procesados? Toda suscripción con persistencia relacional. */
export function usesProcessedEvents(model) {
  return usesMessaging(model) && usesRelational(model) && (model.subscriptions ?? []).length > 0;
}

/** ¿Hay mensajes que leer? Las suscripciones necesitan los lectores de valores del cable. */
export function usesSubscriptionMessages(model) {
  return usesMessaging(model) && (model.subscriptions ?? []).length > 0;
}

/** ¿El stack es RabbitMQ? */
export function usesRabbitMq(model) {
  return usesMessaging(model) && model.stack?.broker === 'rabbitmq';
}

/** ¿El stack es Kafka (incremento 9f)? */
export function usesKafka(model) {
  return usesMessaging(model) && model.stack?.broker === 'kafka';
}

export const bridgeClass = (model) => `${model.service.className}DomainEventBridge`;
export const bridgePath = (model) => classPath(MESSAGING_DIR, bridgeClass(model));
export const integrationPath = (event) => classPath(`${MESSAGING_DIR}/events`, event.integrationClass);
export const publisherPortPath = (event) => classPath(DIRS.events, event.publisherClass);
export const publisherStubPath = (event) => classPath(MESSAGING_DIR, `${event.publisherClass}Stub`);
export const messagePath = (sub) => classPath(`${MESSAGING_DIR}/subscriptions`, sub.messageRecord);
export const envelopePath = (sub) => classPath(`${MESSAGING_DIR}/subscriptions`, sub.envelopeRecord);

export const OUTBOX_ORM_TS = 'src/infrastructure/persistence/entities/outbox-event-orm.ts';
export const PROCESSED_EVENT_ORM_TS = 'src/infrastructure/persistence/entities/processed-event-orm.ts';
export const OUTBOX_DISPATCHER_TS = classPath(OUTBOX_DIR, 'OutboxDispatcher');
export const OUTBOX_DISPATCHER_FALLBACK_TS = classPath(OUTBOX_DIR, 'OutboxDispatcherFallback');
export const OUTBOX_RELAY_STORE_TS = classPath(OUTBOX_DIR, 'OutboxRelayStore');
export const OUTBOX_RELAY_TS = classPath(OUTBOX_DIR, 'OutboxRelay');
export const OUTBOX_BACKOFF_TS = classPath(OUTBOX_DIR, 'OutboxBackoff');
export const IDEMPOTENCY_GUARD_TS = classPath(IDEMPOTENCY_DIR, 'IdempotencyGuard');
export const RABBIT_TOPOLOGY_TS = `src/${MESSAGING_DIR}/rabbitmq/rabbit-topology.ts`;
export const RABBIT_CONNECTION_TS = `src/${MESSAGING_DIR}/rabbitmq/rabbit-connection.ts`;
export const KAFKA_CONSUMPTION_TS = `src/${MESSAGING_DIR}/kafka/kafka-consumption.ts`;
export const KAFKA_CONNECTION_TS = `src/${MESSAGING_DIR}/kafka/kafka-connection.ts`;

export function generate(model) {
  if (!usesMessaging(model)) return [];
  const files = [
    { path: EVENT_ENVELOPE_TS, content: envelopeFile(model) },
    { path: MESSAGE_CONTRACT_TS, content: contractViolationFile() },
    { path: MESSAGING_SETTINGS_TS, content: settingsFile(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/messaging.yaml`, content: messagingYaml(model, profile) }))
  ];
  const outbox = usesNestOutbox(model);
  for (const event of model.events ?? []) {
    files.push({ path: integrationPath(event), content: integrationEventFile(model, event) });
    if (usesBridge(model) && !outbox) {
      files.push({ path: publisherPortPath(event), content: publisherPortFile(event) });
      files.push({ path: publisherStubPath(event), content: publisherStubFile(event) });
    }
  }
  if (usesBridge(model)) files.push({ path: bridgePath(model), content: bridgeFile(model) });
  for (const sub of model.subscriptions ?? []) {
    files.push({ path: messagePath(sub), content: messageFile(model, sub) });
    if (sub.envelopeRecord) files.push({ path: envelopePath(sub), content: wrappedEnvelopeFile(sub) });
  }
  // Los lectores de value objects los emite la API; sin ella, los mensajes los necesitan igual.
  if (!usesApi(model) && (model.valueObjects ?? []).length > 0 && usesSubscriptionMessages(model)) files.push(valueReaders(model));
  if (usesRelational(model)) {
    files.push({ path: BROKER_BINDINGS_TS, content: bindingsFile(model) });
    files.push({ path: MESSAGING_MODULE_TS, content: moduleFile(model) });
    files.push({ path: LISTENERS_MODULE_TS, content: listenersModuleFile() });
  }
  return files;
}

// ─── La envoltura ────────────────────────────────────────────────────────────

function envelopeFile(model) {
  const body = `/**
 * Envoltura estándar de los eventos: metadata + payload, en el orden del cable (keel-core,
 * WIRE_SHAPES.eventEnvelope). Es la misma que publica y consume el servidor de keel-spring del diseño.
 *
 * La metadata es la que el agregado estampó al emitir el evento de dominio: conserva el eventId, que es
 * la clave de idempotencia del consumidor. Aquí solo se le añaden la correlación y el contexto de traza
 * de la petición, que el dominio no conoce (este servicio no tiene telemetría: el traceparent viaja a
 * null).
 */
export class EventEnvelope<T> {
  constructor(
    readonly metadata: EventMetadata,
    readonly data: T
  ) {}

  static of<T>(metadata: EventMetadata, data: T, correlationId: string | null): EventEnvelope<T> {
    return new EventEnvelope(metadata.withContext(correlationId, null), data);
  }

  /**
   * Lee una envoltura Keel del cable (lo que llega a una suscripción con \`envelope: keel\`). El \`data\`
   * queda sin leer: se lee DESPUÉS de filtrar por \`metadata.eventType\`, con la clase del mensaje de la
   * suscripción, porque el canal transporta también eventos que no son de este servicio.
   * Una envoltura que no lo es incumple el contrato y no se reintenta (MessageContractViolation).
   */
  static parse(text: string): EventEnvelope<unknown> {
    let raw: unknown;
    try {
      raw = parseWireJson(text);
    } catch {
      throw new MessageContractViolation('El mensaje no es JSON válido');
    }
    const envelope = raw as { metadata?: Record<string, unknown>; data?: unknown } | null;
    const metadata = envelope?.metadata;
    if (metadata == null || typeof metadata !== 'object' || !('data' in (envelope as object))) {
      throw new MessageContractViolation('El mensaje no trae la envoltura Keel (metadata + data)');
    }
    const text_ = (name: string, required: boolean): string | null => {
      const value = metadata[name];
      if (value == null) {
        if (required) throw new MessageContractViolation(\`La envoltura no trae metadata.\${name}\`);
        return null;
      }
      if (typeof value !== 'string') throw new MessageContractViolation(\`metadata.\${name} no es texto\`);
      return value;
    };
    let occurredAt: Date;
    let eventVersion: number;
    try {
      occurredAt = toTimestamp(metadata['occurredAt']);
      eventVersion = toInt(metadata['eventVersion']);
    } catch {
      throw new MessageContractViolation('metadata.occurredAt o metadata.eventVersion no cumplen el contrato del cable');
    }
    return new EventEnvelope(
      new EventMetadata(text_('eventId', true)!, text_('eventType', true)!, eventVersion, occurredAt, text_('source', true)!, text_('correlationId', false), text_('traceparent', false)),
      envelope!.data
    );
  }
}`;
  return tsModule(
    EVENT_ENVELOPE_TS,
    [
      { symbol: 'EventMetadata', from: EVENT_METADATA_TS },
      { symbol: 'parseWireJson', from: WIRE_TS },
      { symbol: 'toInt', from: WIRE_TS },
      { symbol: 'toTimestamp', from: WIRE_TS },
      { symbol: 'MessageContractViolation', from: MESSAGE_CONTRACT_TS }
    ],
    body
  );
}

function contractViolationFile() {
  return tsModule(
    MESSAGE_CONTRACT_TS,
    [],
    `/**
 * Un mensaje que incumple el contrato de su suscripción: un campo obligatorio que falta, uno fuera de su
 * cota o de su tipo, una envoltura que no lo es. Es el IllegalArgumentException del servidor de
 * keel-spring, y como él NO se reintenta: un mensaje mal formado no se vuelve válido dentro de un
 * segundo, así que va directo al descarte (la DLQ, si la suscripción la declara).
 */
export class MessageContractViolation extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MessageContractViolation';
  }
}`
  );
}

// ─── Eventos de integración ──────────────────────────────────────────────────

function integrationEventFile(model, event) {
  const file = integrationPath(event);
  const imports = [
    { symbol: 'EventMetadata', from: EVENT_METADATA_TS, type: true },
    { symbol: event.className, from: classPath(DIRS.events, event.className), type: true }
  ];
  for (const field of event.fields) imports.push(...fieldImports(model, field).map((imp) => ({ ...imp, type: true })));
  const omit = Boolean(model.service?.omitNulls);
  if (omit) imports.push({ symbol: 'OmitNulls', from: WIRE_TS });
  const params = event.fields.map((field) => `    readonly ${field.name}: ${declTypeOf(field)}`);
  const args = event.fields.map((field) => `event.${field.name}`).join(', ');
  const body = `/**
 * Evento de integración ${event.name}: la proyección de cable del evento de dominio ${event.className}${event.channel ? `, publicado en el canal '${event.channel}'` : ''}.
 *
 * Desacoplado del dominio a propósito: cambiar el broker o la serialización no alcanza a domain/events.
 * La metadata se conserva (el puente la necesita para la envoltura) pero NO se serializa: no es
 * enumerable, así que JSON.stringify no la ve. La autoritativa es la de la envoltura, y duplicarla en
 * \`data\` confundiría al consumidor.
 */
${omit ? '// conventions.nulls: omit — un campo sin valor no viaja (service.keel.yaml).\n@OmitNulls()\n' : ''}export class ${event.integrationClass} {
  declare readonly metadata: EventMetadata;

  constructor(
    metadata: EventMetadata${params.length > 0 ? `,\n${params.join(',\n')}` : ''}
  ) {
    Object.defineProperty(this, 'metadata', { value: metadata, enumerable: false });
  }

  static from(event: ${event.className}): ${event.integrationClass} {
    return new ${event.integrationClass}(event.metadata${args ? `, ${args}` : ''});
  }
}`;
  return tsModule(file, imports, body);
}

/** El tipo con el que se declara un campo de un evento o un mensaje (una lista, `readonly T[]`). */
function declTypeOf(field) {
  if (field.list) return `readonly ${field.elementTsType ?? String(field.tsType).replace(/\[\]$/, '')}[]`;
  return field.required ? field.tsType : `${field.tsType} | null`;
}

// ─── Best-effort: el puerto de publicación y su stub ─────────────────────────

function publisherPortFile(event) {
  const file = publisherPortPath(event);
  return tsModule(
    file,
    [{ symbol: event.integrationClass, from: integrationPath(event), type: true }],
    `/**
 * Puerto de publicación del evento de integración ${event.name} (reliability: best-effort). La
 * implementación del broker del stack la escribe el agente (skill keel-nest-<broker>) y la registra en
 * broker-bindings.ts; el único que lo invoca es el puente de eventos, DESPUÉS del commit.
 *
 * Es una clase abstracta y no una interfaz porque sirve también de token de inyección.
 */
export abstract class ${event.publisherClass} {
  abstract publish(event: ${event.integrationClass}, correlationId: string | null): Promise<void>;
}`
  );
}

function publisherStubFile(event) {
  const file = publisherStubPath(event);
  const stub = `${event.publisherClass}Stub`;
  return tsModule(
    file,
    [
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: event.publisherClass, from: publisherPortPath(event) },
      { symbol: event.integrationClass, from: integrationPath(event), type: true }
    ],
    `/**
 * Respaldo del puerto ${event.publisherClass} mientras no hay publisher real: satisface la inyección para
 * que el servicio arranque sin broker. Cede el sitio en cuanto broker-bindings.ts registre otro: no hay
 * que borrar este archivo.
 */
@Injectable()
export class ${stub} extends ${event.publisherClass} {
  private readonly logger = new Logger(${tsString(stub)});

  async publish(_event: ${event.integrationClass}, correlationId: string | null): Promise<void> {
    // TODO (agente): sustituir por el publisher real del broker de keel-stack.json (skill
    //   keel-nest-<broker>): envolver con EventEnvelope.of(event.metadata, event, correlationId),
    //   serializar con toWireJson y publicar en el destino y la routing key de MessagingSettings.
    this.logger.warn(\`Publisher no implementado: ${event.name} no salió del servicio (correlationId=\${correlationId})\`);
  }
}`
  );
}

// ─── El puente ───────────────────────────────────────────────────────────────

function bridgeFile(model) {
  const file = bridgePath(model);
  const outbox = usesNestOutbox(model);
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'randomUUID', from: 'node:crypto' },
    { symbol: 'DomainEvent', from: DOMAIN_EVENT_TS, type: true },
    { symbol: 'CorrelationContext', from: CORRELATION_TS },
    { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
    { symbol: 'MESSAGING_SETTINGS', from: MESSAGING_SETTINGS_TS },
    { symbol: 'MessagingSettings', from: MESSAGING_SETTINGS_TS, type: true }
  ];
  if (outbox) {
    imports.push(
      { symbol: 'EventEnvelope', from: EVENT_ENVELOPE_TS },
      { symbol: 'OutboxEventOrm', from: OUTBOX_ORM_TS },
      { symbol: 'toWireJson', from: WIRE_TS }
    );
  }
  const ctor = [
    '    @Inject(TransactionContext) private readonly transactions: TransactionContext',
    '    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings'
  ];
  for (const event of model.events) {
    imports.push({ symbol: event.className, from: classPath(DIRS.events, event.className) });
    imports.push({ symbol: event.integrationClass, from: integrationPath(event) });
    if (!outbox) {
      imports.push({ symbol: event.publisherClass, from: publisherPortPath(event) });
      ctor.push(`    @Inject(${event.publisherClass}) private readonly ${decapitalize(event.publisherClass)}: ${event.publisherClass}`);
    }
  }
  // La etiqueta del sobre (`eventType` de la fila) es el NOMBRE del evento en el diseño, el mismo literal
  // que estampa EventMetadata.now(...): es sobre ese valor que filtran los consumidores (y la
  // FilterPolicy de SNS). Con el nombre de la clase, el filtro no casa y el evento no llega.
  const branches = model.events
    .map((event) => {
      const delivery = outbox
        ? `      await this.append(this.settings.routingKeys[${tsString(event.name)}]!, ${tsString(event.name)}, EventEnvelope.of(event.metadata, integration, correlationId));`
        : `      await this.transactions.afterCommit(() => this.${decapitalize(event.publisherClass)}.publish(integration, correlationId));`;
      return `    if (event instanceof ${event.className}) {
      const integration = ${event.integrationClass}.from(event);
${delivery}
      return;
    }`;
    })
    .join('\n');
  const append = outbox
    ? `

  /** La fila del outbox, en la transacción del cambio: el evento y el cambio confirman o revierten juntos. */
  private async append(routingKey: string, eventType: string, envelope: EventEnvelope<unknown>): Promise<void> {
    await this.transactions.manager().insert(OutboxEventOrm, {
      id: randomUUID(),
      destination: this.settings.destination,
      routingKey,
      eventType,
      payload: toWireJson(envelope),
      createdAt: new Date(),
      publishedAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null
    });
  }`
    : '';
  const body = `/**
 * ${bridgeClass(model)} — traduce cada evento de dominio a su evento de integración y lo entrega ${
   outbox
     ? 'al\n * outbox DENTRO de la transacción que provocó el cambio: la fila y el cambio del agregado confirman o\n * revierten juntos (reliability: outbox). El relay la publica después, fuera de ella.'
     : 'tras\n * confirmar la transacción (reliability: best-effort): un rollback no publica nada, pero un fallo del\n * broker sí pierde el evento.'
 }
 *
 * Los eventos llegan aquí porque los adaptadores de repositorio drenan pullDomainEvents() al guardar el
 * agregado. Nadie más publica eventos.
 */
@Injectable()
export class ${bridgeClass(model)} {
  constructor(
${ctor.join(',\n')}
  ) {}

  /** Lo llama el adaptador de repositorio al guardar, dentro de la transacción del caso de uso. */
  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) await this.route(event);
  }

  private async route(event: DomainEvent): Promise<void> {
    const correlationId = CorrelationContext.get();
${branches}
    // Un evento de dominio sin evento de integración es un hueco del scaffolding: que no pase en silencio.
    throw new Error(\`El evento \${event.metadata.eventType} no tiene ruta de integración\`);
  }${append}
}`;
  // randomUUID solo lo usa el append del outbox.
  return tsModule(file, outbox ? imports : imports.filter((imp) => imp.symbol !== 'randomUUID'), body);
}

// ─── Mensajes de suscripción ─────────────────────────────────────────────────

const PRESENCE_RULES = new Set(['notNull', 'notBlank', 'notEmpty']);

function rulesLiteral(rules) {
  const value = (v) => (typeof v === 'string' ? tsString(v) : JSON.stringify(v));
  return `[${rules.map((rule) => `{ ${Object.entries(rule).map(([key, v]) => `${key}: ${value(v)}`).join(', ')} }`).join(', ')}]`;
}

function messageFile(model, sub) {
  const file = messagePath(sub);
  const imports = [
    { symbol: 'MessageContractViolation', from: MESSAGE_CONTRACT_TS },
    { symbol: 'bodyObject', from: REQUEST_READING_TS },
    { symbol: 'json', from: REQUEST_READING_TS }
  ];
  for (const field of sub.fields) imports.push(...readerImports(model, field));
  const required = sub.fields.filter((field) => field.required);
  // Las cotas del diseño (no la presencia, que se comprueba aparte y con su propio mensaje), como en
  // keel-spring: `validation` del campo sin NotNull/NotBlank/NotEmpty.
  const bounded = sub.fields
    .map((field) => ({ field, rules: (field.validation ?? []).filter((rule) => !PRESENCE_RULES.has(rule.rule)) }))
    .filter(({ rules }) => rules.length > 0);
  if (bounded.length > 0) {
    imports.push({ symbol: 'Violations', from: REQUEST_READING_TS }, { symbol: 'RequestValidationError', from: REQUEST_ERRORS_TS });
  }
  const params = sub.fields.map((field) => `    readonly ${field.name}: ${field.list ? declTypeOf(field) : `${field.tsType} | null`}`);
  const reads = sub.fields.map((field) => {
    const key = field.wireName ?? field.name;
    const read = `${readerOf(field, 'json')}(fields[${tsString(key)}])`;
    return `        ${field.list ? `${read} ?? []` : read}`;
  });
  const known = sub.fields.map((field) => tsString(field.wireName ?? field.name));
  const unknownCheck =
    sub.unknownFields === 'fail'
      ? `
      // unknownFields: fail — un campo que el contrato no conoce rechaza el mensaje.
      const known = new Set<string>([${known.join(', ')}]);
      const extra = Object.keys(fields).find((key) => !known.has(key));
      if (extra !== undefined) throw new MessageContractViolation(\`${sub.name}: el mensaje trae '\${extra}', que el contrato no declara\`);`
      : '';
  const presence = required
    .map(
      (field) => `    if (this.${field.name} == null) {
      throw new MessageContractViolation(${tsString(`${sub.name}: el mensaje no trae '${field.name}', que el contrato declara obligatorio`)});
    }`
    )
    .join('\n');
  const bounds =
    bounded.length > 0
      ? `
    try {
      new Violations('body')
${bounded.map(({ field, rules }) => `        .check(${tsString(field.name)}, this.${field.name}, ${rulesLiteral(rules)})`).join('\n')}
        .throwIfAny();
    } catch (error) {
      if (!(error instanceof RequestValidationError)) throw error;
      const [first = ''] = error.details;
      const space = first.indexOf(' ');
      throw new MessageContractViolation(
        \`${sub.name}: el mensaje incumple el contrato en '\${first.slice(0, space)}': \${first.slice(space + 1)}\`
      );
    }`
      : '';
  const requireContract =
    presence || bounds
      ? `

  /**
   * El contrato de la fuente: los campos que el diseño declara obligatorios tienen que venir, y dentro de
   * sus cotas. Llámalo DESPUÉS de filtrar por el tipo del mensaje — uno ajeno del canal compartido se
   * descarta SIN lanzar, y lanzar aquí lo mandaría al descarte. Lo que incumple el contrato lanza
   * MessageContractViolation, que va al descarte SIN reintentos.
   */
  requireContract(): void {
${[presence, bounds].filter(Boolean).join('\n')}
  }`
      : '';
  const body = `/**
 * Payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.
${contractDoc(model, sub)} */
export class ${sub.messageRecord} {
  constructor(
${params.join(',\n')}
  ) {}

  /**
   * Lee el payload del cable${sub.fields.some((f) => f.wireName) ? ' (con los nombres de la fuente: wireName)' : ''}. Un valor que no es de su tipo incumple el contrato y no
   * se reintenta. ${sub.unknownFields === 'fail' ? 'Un campo de más también (unknownFields: fail).' : 'Los campos de más se ignoran (unknownFields: ignore).'} La PRESENCIA no se comprueba aquí:
   * la comprueba requireContract(), después de filtrar.
   */
  static fromWire(data: unknown): ${sub.messageRecord} {
    try {
      const fields = bodyObject(data, true);${unknownCheck}
      return new ${sub.messageRecord}(
${reads.join(',\n')}
      );
    } catch (error) {
      if (error instanceof MessageContractViolation) throw error;
      throw new MessageContractViolation(${tsString(`${sub.name}: el payload no cumple el contrato del cable`)}, { cause: error });
    }
  }${requireContract}
}`;
  return tsModule(file, imports, body);
}

function wrappedEnvelopeFile(sub) {
  const file = envelopePath(sub);
  const path = sub.payloadPath.split('.');
  const fields = [`    readonly ${path[0]}: unknown`];
  const reads = [`      object[${tsString(path[0])}]`];
  for (const part of [sub.discriminator, sub.messageId]) {
    if (part?.location === 'field' && !part.name.includes('.')) {
      fields.push(`    readonly ${part.name}: string | null`);
      reads.push(`      typeof object[${tsString(part.name)}] === 'string' ? (object[${tsString(part.name)}] as string) : null`);
    }
  }
  const nested = path.length > 1;
  return tsModule(
    file,
    [
      { symbol: 'MessageContractViolation', from: MESSAGE_CONTRACT_TS },
      { symbol: 'parseWireJson', from: WIRE_TS },
      { symbol: sub.messageRecord, from: messagePath(sub) }
    ],
    `/**
 * Envoltura con la que ${sub.source ?? 'la fuente'} publica ${sub.name}: el payload cuelga de '${sub.payloadPath}'.
 * Los campos que no se nombran se ignoran.
 */
export class ${sub.envelopeRecord} {
  constructor(
${fields.join(',\n')}
  ) {}

  /** Lee la envoltura del cable; el payload queda sin leer hasta que se sepa que el mensaje es nuestro. */
  static parse(text: string): ${sub.envelopeRecord} {
    let object: Record<string, unknown>;
    try {
      const raw = parseWireJson(text);
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('no es un objeto');
      object = raw as Record<string, unknown>;
    } catch {
      throw new MessageContractViolation(${tsString(`${sub.name}: el mensaje no es la envoltura de la fuente`)});
    }
    return new ${sub.envelopeRecord}(
${reads.join(',\n')}
    );
  }

  /** El payload, leído con el contrato de ${sub.messageRecord}. */
  message(): ${sub.messageRecord} {
${
  nested
    ? `    // payloadPath anidado: se desciende por '${sub.payloadPath}'.
    let node: unknown = this.${path[0]};
    for (const key of ${JSON.stringify(path.slice(1))}) {
      node = node != null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    }
    return ${sub.messageRecord}.fromWire(node);`
    : `    return ${sub.messageRecord}.fromWire(this.${path[0]});`
}
  }
}`
  );
}

/**
 * Los CONSUMIDORES del servicio, que es a lo que corresponde un listener, con las suscripciones de cada uno.
 * No es lo mismo en los dos brokers, y confundirlos pierde mensajes:
 *
 *   · RabbitMQ — un consumidor por COLA. La cola sale de la fuente (keel-core/gen/dead-letter.js) y varias
 *     suscripciones la comparten: dos consumidores de la misma cola competirían y cada mensaje llegaría a
 *     uno solo, así que el listener es uno y enruta por el tipo.
 *   · Kafka — un consumidor por SUSCRIPCIÓN, cada uno con su consumer group (`<servicio>-<evento>`). Cada
 *     grupo recibe el topic ENTERO: dos suscripciones de la misma fuente leen el mismo topic y cada una
 *     descarta lo que no es suyo. Con un solo grupo, Kafka les repartiría las particiones.
 */
export function consumerUnits(model) {
  const units = new Map();
  for (const sub of model.subscriptions ?? []) {
    let unit;
    if (model.stack?.broker === 'kafka') {
      const group = subscriptionGroupId(model, sub);
      unit = { key: group, label: `el consumer group ${group} sobre ${sub.topicDefault}`, group, topic: sub.topicDefault };
    } else {
      const queue = model.stack?.broker === 'rabbitmq' ? destinationOf('rabbitmq', model, sub) : sub.name;
      unit = { key: queue, label: `la cola ${queue}`, queue };
    }
    if (!units.has(unit.key)) units.set(unit.key, { ...unit, subscriptions: [] });
    units.get(unit.key).subscriptions.push(sub.name);
  }
  return [...units.values()];
}

// El contrato de recepción, escrito donde lo va a leer el agente al escribir el listener. Es el de
// keel-spring (`contractJavadoc`), con los nombres de keel-nest.
function contractDoc(model, sub) {
  const lines = [];
  if (sub.envelope === 'wrapped') {
    lines.push(`Llega envuelto en ${sub.envelopeRecord} (${sub.envelopeRecord}.parse); el payload cuelga de '${sub.payloadPath}'.`);
  } else if (sub.envelope === 'keel') {
    lines.push('Llega en la EventEnvelope estándar de Keel (metadata + data): EventEnvelope.parse, y después fromWire(envelope.data).');
  } else {
    lines.push('Llega plano: el mensaje es este payload (fromWire sobre el cuerpo ya leído con parseWireJson).');
  }
  if (sub.format !== 'json') lines.push(`Formato: ${sub.format}${sub.schemaRef ? ` (schema '${sub.schemaRef}')` : ''}.`);
  if (sub.discriminator) {
    lines.push(
      `Se reconoce por ${sub.discriminator.location} '${sub.discriminator.name}' == '${sub.discriminator.value}': el canal transporta más tipos, descarta el resto SIN lanzar.`
    );
  } else if (sub.envelope === 'keel') {
    const shared = (model.subscriptions ?? [])
      .filter((other) => other.name !== sub.name && other.topicDefault === sub.topicDefault)
      .map((other) => other.name);
    lines.push(
      `Se reconoce por metadata.eventType == '${sub.name}': '${sub.topicDefault}' transporta todos los eventos de ${sub.source ?? 'la fuente'}, ` +
        'así que descarta el resto SIN lanzar (una excepción dispara el reintento y acaba mandando al descarte un mensaje válido que no era para ti).' +
        (shared.length > 0 ? ` En este diseño el destino lo comparten ${shared.join(', ')}.` : '')
    );
  }
  const dedupeKey = sub.messageId
    ? `${sub.messageId.location} '${sub.messageId.name}'`
    : sub.envelope === 'keel'
      ? 'metadata.eventId de la envoltura (lo estampa el emisor en el raise y viaja intacto)'
      : null;
  if (dedupeKey) {
    lines.push(`Deduplica por ${dedupeKey} antes de despachar (la entrega es at-least-once).`);
    const guardReason =
      sub.triggerGuardKind === 'natural-key'
        ? 'la clave de idempotencia participa en la clave natural del agregado, así que esa constraint ES la guarda'
        : 'la operación declara transiciones, así que la repetición la frena el agregado';
    lines.push(
      sub.triggerHasDomainGuard
        ? `Orden: IdempotencyGuard.alreadyProcessed(...) antes de despachar y record(...) DESPUÉS de que el handler termine bien: ${guardReason}, y lo que no puede perderse es el mensaje — registrar ANTES haría que un fallo terminal se viera como «ya procesado» y su reintento no llegara nunca al descarte.`
        : 'Orden: IdempotencyGuard.tryRecord(...) antes de despachar — la operación no declara ninguna guarda de dominio que frene la repetición, así que la ventana se cierra reclamando antes. Un fallo del handler deja el mensaje marcado y perdido; si eso no es tolerable, lo que falta es la guarda de dominio en el diseño.'
    );
    lines.push(
      'La deduplicación tiene VENTANA: el registro se purgará a los processed-event.purge.retention-days (default 14; la purga llega con el incremento 10), así que una reentrega posterior se procesa como nueva.' +
        (sub.triggerHasDomainGuard ? ' Aquí es inocuo: la guarda de dominio sigue rechazándola, y esa no caduca.' : ' Aquí NO es inocuo: sin guarda de dominio, pasada la retención el efecto se vuelve a aplicar.')
    );
  }
  if (sub.identity) {
    lines.push(
      `Identidad del emisor: resuelve ${sub.identity.field} desde ${sub.identity.from.location === 'header' ? `el header '${sub.identity.from.name}'` : `el campo '${sub.identity.from.name}' del mensaje`}, y pásala YA RESUELTA a la operación. No la leas del payload.` +
        (sub.identity.resolvedBy ? '' : ' Se resuelve 1:1: el valor leído ES la clave natural del recurso que identifica.')
    );
    lines.push(
      sub.identity.onUnresolved === 'deadLetter'
        ? 'Un emisor que no corresponda a nadie registrado va al descarte (onUnresolved: deadLetter): NO lo proceses y NO lo confirmes en silencio.'
        : 'Un emisor que no corresponda a nadie registrado se descarta (onUnresolved: discard): confirma el mensaje y déjalo en el log. Es un fallo PERMANENTE.'
    );
  }
  if ((sub.triggerRaces ?? []).length > 0) {
    lines.push(
      `Compite con ${sub.triggerRaces.join(', ')}: sacan la entidad del mismo estado. Si al despachar la transición se rechaza porque otro llegó antes, es la carrera resuelta y NO un fallo — confirma el mensaje y no lo reintentes.`,
      'Se rechaza de DOS formas y las dos son esta carrera: InvalidStateTransitionException (otro camino ya movió el estado) y el 409 de concurrencia (llegasteis a la vez y perdió el commit) — trátalas juntas.'
    );
    if (sub.triggerHasDomainGuard) lines.push('Esa rama termina igualmente en IdempotencyGuard.record(...): el mensaje quedó atendido, por el otro camino.');
  }
  if (sub.deadLetter) {
    lines.push(
      model.stack?.broker === 'kafka'
        ? `Con onFailure.deadLetter: tras agotar los reintentos —o al primer fallo no reintentable— la conexión de build lo publica en ${sub.topicDefault}.DLT con su clave, su valor y sus headers. NO lo publiques tú ni crees otra cadena de reintento.`
        : `Con onFailure.deadLetter: tras agotar los reintentos el broker lo mueve al descarte de su cola. La topología la genera build — NO la declares tú.`
    );
  }
  // El listener es el de su CONSUMIDOR (consumerUnits): en RabbitMQ la cola, que pueden compartir varias
  // suscripciones; en Kafka el consumer group de la suscripción. La corrida stock-reservation-events vio
  // este texto decir «Lo consume StockReservedListener» con tres suscripciones en una sola cola.
  const unit = consumerUnits(model).find((entry) => entry.subscriptions.includes(sub.name));
  let consumer;
  if (unit?.group) consumer = `el listener de su consumer group (${unit.group}), que recibe el topic ${unit.topic} entero`;
  else if (unit && unit.subscriptions.length > 1)
    consumer = `el listener de la cola ${unit.queue}, que comparte con ${unit.subscriptions.filter((name) => name !== sub.name).join(', ')} y enruta por el tipo del mensaje`;
  else consumer = `el listener de su cola${unit ? ` (${unit.queue})` : ''}`;
  if (sub.trigger) {
    const argument = (a) =>
      a.from === 'envelope' ? `envelope.metadata.${a.source}` : a.from === 'identity' ? 'la identidad resuelta' : a.source ? `payload.${a.source}` : 'TODO (agente)';
    const args = sub.triggerArguments.map((a) => `${a.component} = ${argument(a)}`).join(', ');
    lines.push(
      `Lo consume ${consumer} (lo escribe el agente y lo registra en broker-bindings.ts), despachando ${sub.triggerMessageClass ?? sub.trigger}${args ? `(${args})` : ''} por el UseCaseMediator.`
    );
  } else {
    lines.push(`Lo consume ${consumer} (lo escribe el agente y lo registra en broker-bindings.ts).`);
  }
  return lines.map((line) => ` * ${line}\n`).join('');
}

// ─── La configuración ────────────────────────────────────────────────────────

// El gradiente de keel-spring para lo que tiene default en todos los perfiles: literal en local (y en
// test, que en Nest es un perfil más de config/), `${VAR:default}` en los demás.
function envWithDefault(profile, name, value) {
  return profile === 'local' || profile === 'test' ? String(value) : `\${${name}:${value}}`;
}

/** La clave de la routing key de un evento (`notification-sent`) y la de una suscripción. */
export const routingKeyName = (event) => event.routingKeyProperty.split('.').pop();
export const subscriptionKey = (sub) => sub.topicProperty.split('.').slice(-2)[0];
const topicEnv = (sub) => sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');
const queueEnv = (sub) => `${topicEnv(sub).replace(/_TOPIC$/, '')}_QUEUE`;
const groupEnv = (sub) => `${topicEnv(sub).replace(/_TOPIC$/, '')}_GROUP_ID`;


/** El mismo `messaging.yaml` que keel-spring, con las claves del relay de keel-core/gen/messaging-stores.js. */
export function messagingYaml(model, profile) {
  const lines = ['messaging:'];
  const events = model.events ?? [];
  const subscriptions = model.subscriptions ?? [];
  if (events.length > 0) {
    lines.push('  publishing:', `    destination: ${envWithDefault(profile, 'MESSAGING_DESTINATION', events[0].destinationDefault)}`, '    routing-keys:');
    for (const event of events) lines.push(`      ${routingKeyName(event)}: ${event.routingKeyDefault}`);
  }
  if (subscriptions.length > 0) {
    lines.push('  subscriptions:');
    for (const sub of subscriptions) {
      lines.push(`    ${subscriptionKey(sub)}:`, `      topic: ${envWithDefault(profile, topicEnv(sub), sub.topicDefault)}`);
      // Con RabbitMQ se consume de una COLA propia de este servicio que cuelga del exchange del canal:
      // su nombre lo declara aquí build, el mismo que crea la topología y al que entrega el arnés.
      if (model.stack?.broker === 'rabbitmq') {
        lines.push(`      queue: ${envWithDefault(profile, queueEnv(sub), destinationOf('rabbitmq', model, sub))}`);
      }
      // Con Kafka, el consumer group de la suscripción: la misma clave y el mismo default que keel-spring.
      if (model.stack?.broker === 'kafka') {
        lines.push(`      group-id: ${envWithDefault(profile, groupEnv(sub), subscriptionGroupId(model, sub))}`);
      }
    }
  }
  if (usesNestOutbox(model)) {
    const line = (parameter, comment) => {
      const leaf = parameter.key.split('.');
      const out = comment ? [`${'  '.repeat(leaf.length - 1)}# ${comment}`] : [];
      out.push(`${'  '.repeat(leaf.length - 1)}${leaf.at(-1)}: ${envWithDefault(profile, parameter.env, parameterValue(parameter, profile))}`);
      return out;
    };
    lines.push(
      'outbox:',
      '  relay:',
      ...line(OUTBOX_RELAY.fixedDelayMs, 'Cada cuánto el relay busca filas pendientes y las entrega al broker.'),
      ...line(OUTBOX_RELAY.batchSize),
      ...line(OUTBOX_RELAY.maxAttempts, 'Tras agotar los reintentos la fila queda como dead-letter: no se reintenta ni se borra.'),
      '    backoff:',
      ...line(OUTBOX_RELAY.backoffInitialMs, 'Backoff exponencial entre reintentos de una fila (initial·2^(n-1), con tope max-ms).'),
      ...line(OUTBOX_RELAY.backoffMaxMs),
      ...line(OUTBOX_RELAY.claimTimeoutMs, 'Lease de una fila reclamada mientras su publicación está en vuelo; si la réplica muere, caduca.')
    );
  }
  return `${lines.join('\n')}\n`;
}

function settingsFile(model) {
  const outbox = usesNestOutbox(model);
  const events = model.events ?? [];
  const subscriptions = model.subscriptions ?? [];
  const relay = outbox
    ? Object.entries(OUTBOX_RELAY)
        .map(([name, parameter]) => `      ${name}: positive(configuration, ${tsString(parameter.key)}, ${parameter.default})`)
        .join(',\n')
    : '';
  const body = `/** Token de la configuración de mensajería ya resuelta. */
export const MESSAGING_SETTINGS = Symbol('MESSAGING_SETTINGS');

export interface SubscriptionSettings {
  /** El canal (exchange o topic) de la fuente. */
  readonly topic: string;
  /** La cola propia de la que consume este servicio (RabbitMQ); null en un broker que consume del topic. */
  readonly queue: string | null;
  /** El consumer group de la suscripción (Kafka); null en los demás brokers. */
  readonly groupId: string | null;
}

export interface OutboxRelaySettings {
  readonly fixedDelayMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  readonly claimTimeoutMs: number;
}

/** La mensajería del perfil activo: lo que el código lee, con las claves de config/parameters/<perfil>/messaging.yaml. */
export interface MessagingSettings {
  /** El destino (exchange o topic) donde se publican los eventos de este servicio. */
  readonly destination: string;
  /** La routing key de cada evento, por su NOMBRE en el diseño. */
  readonly routingKeys: Readonly<Record<string, string>>;
  /** Cada suscripción, por su NOMBRE en el diseño. */
  readonly subscriptions: Readonly<Record<string, SubscriptionSettings>>;
  /** El relay del outbox (reliability: outbox); null si los eventos salen best-effort. */
  readonly outboxRelay: OutboxRelaySettings | null;
}

/**
 * Lee y valida la mensajería del perfil al ARRANCAR: un valor que no es un entero positivo no deja
 * arrancar, en vez de dejar el relay parado o en bucle apretado. Lo que el perfil no declara toma el
 * default de keel-core (el mismo que el servidor de keel-spring).
 */
export function messagingSettings(configuration: Configuration): MessagingSettings {
  return {
    destination: text(configuration, 'messaging.publishing.destination', ${tsString(events[0]?.destinationDefault ?? '')}),
    routingKeys: {
${events.map((event) => `      ${tsString(event.name)}: text(configuration, ${tsString(`messaging.publishing.routing-keys.${routingKeyName(event)}`)}, ${tsString(event.routingKeyDefault)})`).join(',\n')}
    },
    subscriptions: {
${subscriptions
  .map(
    (sub) => `      ${tsString(sub.name)}: {
        topic: text(configuration, ${tsString(`messaging.subscriptions.${subscriptionKey(sub)}.topic`)}, ${tsString(sub.topicDefault)}),
        queue: ${model.stack?.broker === 'rabbitmq' ? `text(configuration, ${tsString(`messaging.subscriptions.${subscriptionKey(sub)}.queue`)}, ${tsString(destinationOf('rabbitmq', model, sub))})` : 'null'},
        groupId: ${model.stack?.broker === 'kafka' ? `text(configuration, ${tsString(`messaging.subscriptions.${subscriptionKey(sub)}.group-id`)}, ${tsString(subscriptionGroupId(model, sub))})` : 'null'}
      }`
  )
  .join(',\n')}
    },
    outboxRelay: ${outbox ? `{\n${relay}\n    }` : 'null'}
  };
}

function text(configuration: Configuration, key: string, fallback: string): string {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? fallback : String(value);
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}`;
  return tsModule(MESSAGING_SETTINGS_TS, [{ symbol: 'Configuration', from: CONFIG_TS, type: true }], body);
}

// ─── El cableado ─────────────────────────────────────────────────────────────

function bindingsFile(model) {
  const outbox = usesNestOutbox(model);
  const ports = [];
  if (outbox) ports.push('OutboxDispatcher (el envío de cada fila del outbox al broker)');
  if (usesBridge(model) && !outbox) for (const event of model.events) ports.push(`${event.publisherClass} (best-effort)`);
  const kafka = model.stack?.broker === 'kafka';
  const listeners = consumerUnits(model).map((unit) =>
    unit.group ? `uno para ${unit.subscriptions[0]} (consumer group ${unit.group})` : `uno para la cola ${unit.queue} (${unit.subscriptions.join(', ')})`
  );
  const listenerRule = kafka
    ? ` * Cada suscripción tiene su consumer group, que recibe el topic entero: dos de la misma fuente leen el mismo
 * topic y cada una descarta lo que no es suyo por el tipo del mensaje. Cada clase se registra a sí misma en la
 * conexión al arrancar. Viven en un módulo que importa el de casos de uso, porque despachan por el UseCaseMediator.`
    : ` * Dos consumidores de la misma cola compiten y cada mensaje llega a uno solo: el de una cola compartida
 * enruta por el tipo del mensaje. Cada clase se registra a sí misma en la conexión al arrancar. Viven en un
 * módulo que importa el de casos de uso, porque despachan por el UseCaseMediator.`;
  return tsModule(
    BROKER_BINDINGS_TS,
    [{ symbol: 'Provider', from: '@nestjs/common', type: true }],
    `// EL ÚNICO SITIO donde se registra lo que escribe el agente para el broker de keel-stack.json (skill
// keel-nest-<broker>). Build lo genera vacío una vez y no lo pisa: es el equivalente del component-scan
// de Spring, que en keel-spring recoge esas clases sin que nadie las nombre.

/**
 * Las implementaciones de los puertos de salida del broker${ports.length > 0 ? `:\n *   · ${ports.join('\n *   · ')}` : ' (este diseño no publica nada)'}.
 * Cada una como \`{ provide: <Puerto>, useClass: <Implementación> }\`: sustituye al respaldo que build
 * registra antes (el stub que avisa, o el que no deja arrancar fuera de local y test).
 */
export const BROKER_ADAPTERS: Provider[] = [];

/**
 * Los listeners de las suscripciones, ${kafka ? 'UNO POR SUSCRIPCIÓN' : 'UNO POR COLA y no uno por suscripción'}${listeners.length > 0 ? `:\n *   · ${listeners.join('\n *   · ')}` : ' (este diseño no consume nada)'}.
${listenerRule}
 */
export const MESSAGE_LISTENERS: Provider[] = [];`
  );
}

function moduleFile(model) {
  const outbox = usesNestOutbox(model);
  const bridge = usesBridge(model);
  const processed = usesProcessedEvents(model);
  const rabbit = usesRabbitMq(model);
  const kafka = usesKafka(model);
  const imports = [
    { symbol: 'Global', from: '@nestjs/common' },
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: CONFIG_TS, type: true },
    { symbol: 'MESSAGING_SETTINGS', from: MESSAGING_SETTINGS_TS },
    { symbol: 'messagingSettings', from: MESSAGING_SETTINGS_TS },
    { symbol: 'BROKER_ADAPTERS', from: BROKER_BINDINGS_TS }
  ];
  const providers = ['{ provide: MESSAGING_SETTINGS, useValue: messagingSettings(configuration) }'];
  const exportsList = ['MESSAGING_SETTINGS'];
  if (bridge) {
    imports.push({ symbol: bridgeClass(model), from: bridgePath(model) });
    providers.push(bridgeClass(model));
    exportsList.push(bridgeClass(model));
  }
  if (bridge && !outbox) {
    for (const event of model.events) {
      imports.push({ symbol: event.publisherClass, from: publisherPortPath(event) }, { symbol: `${event.publisherClass}Stub`, from: publisherStubPath(event) });
      providers.push(`{ provide: ${event.publisherClass}, useClass: ${event.publisherClass}Stub }`);
      exportsList.push(event.publisherClass);
    }
  }
  if (outbox) {
    imports.push(
      { symbol: 'OutboxDispatcher', from: OUTBOX_DISPATCHER_TS },
      { symbol: 'outboxDispatcherFallback', from: OUTBOX_DISPATCHER_FALLBACK_TS },
      { symbol: 'OutboxRelayStore', from: OUTBOX_RELAY_STORE_TS },
      { symbol: 'OutboxRelay', from: OUTBOX_RELAY_TS }
    );
    providers.push(
      '{ provide: OutboxDispatcher, useFactory: () => outboxDispatcherFallback(configuration.profiles) }',
      'OutboxRelayStore',
      'OutboxRelay'
    );
    exportsList.push('OutboxDispatcher', 'OutboxRelay');
  }
  if (processed) {
    imports.push({ symbol: 'IdempotencyGuard', from: IDEMPOTENCY_GUARD_TS });
    providers.push('IdempotencyGuard');
    exportsList.push('IdempotencyGuard');
  }
  if (rabbit) {
    imports.push({ symbol: 'RABBITMQ_SETTINGS', from: RABBIT_CONNECTION_TS }, { symbol: 'rabbitMqSettings', from: RABBIT_CONNECTION_TS }, { symbol: 'RabbitConnection', from: RABBIT_CONNECTION_TS });
    providers.push('{ provide: RABBITMQ_SETTINGS, useValue: rabbitMqSettings(configuration) }', 'RabbitConnection');
    exportsList.push('RabbitConnection');
  }
  if (kafka) {
    imports.push({ symbol: 'KAFKA_SETTINGS', from: KAFKA_CONNECTION_TS }, { symbol: 'kafkaSettings', from: KAFKA_CONNECTION_TS }, { symbol: 'KafkaConnection', from: KAFKA_CONNECTION_TS });
    providers.push('{ provide: KAFKA_SETTINGS, useValue: kafkaSettings(configuration) }', 'KafkaConnection');
    exportsList.push('KafkaConnection');
  }
  const body = `/**
 * La mensajería: la configuración del perfil, el puente de eventos${outbox ? ', el outbox con su relay' : ''}${processed ? ', el registro de mensajes procesados' : ''}${rabbit ? ' y la conexión con RabbitMQ' : ''}${kafka ? ' y la conexión con Kafka' : ''}.
 * Global: los adaptadores de repositorio entregan al puente sin importarla.
 *
 * Lo que escribe el agente para el broker entra por BROKER_ADAPTERS (broker-bindings.ts), DESPUÉS de los
 * respaldos de build: con el mismo token, el último registrado es el que se inyecta.
 */
@Global()
@Module({})
export class MessagingModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        ${providers.join(',\n        ')},
        ...BROKER_ADAPTERS
      ],
      exports: [${exportsList.join(', ')}, ...BROKER_ADAPTERS]
    };
  }
}`;
  return tsModule(MESSAGING_MODULE_TS, imports, body);
}

function listenersModuleFile() {
  return tsModule(
    LISTENERS_MODULE_TS,
    [
      { symbol: 'Module', from: '@nestjs/common' },
      { symbol: 'MESSAGE_LISTENERS', from: BROKER_BINDINGS_TS },
      { symbol: 'UseCaseModule', from: USE_CASE_MODULE_TS }
    ],
    `/**
 * Los listeners de las suscripciones (MESSAGE_LISTENERS, broker-bindings.ts). Aparte del módulo de
 * mensajería porque despachan por el UseCaseMediator: importan el módulo de casos de uso, cuyos handlers
 * a su vez dependen del puente — en un solo módulo sería un ciclo.
 */
@Module({
  imports: [UseCaseModule],
  providers: [...MESSAGE_LISTENERS]
})
export class MessageListenersModule {}`
  );
}

