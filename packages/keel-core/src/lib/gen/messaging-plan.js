// La mensajería del servicio como DATOS: lo que deciden por igual los servidores de keel-nest y keel-dotnet
// (y que en keel-spring pone su framework sin que nadie lo escriba) sin saber en qué lenguaje se escribe.
//
//   · los CONSUMIDORES (`consumerUnits`): a qué corresponde un listener según el broker;
//   · la topología RabbitMQ de consumo (`rabbitTopology`) y la de publicación (`publishedChannels`), la
//     MISMA que declara `RabbitTopologyConfig` en keel-spring;
//   · los fragmentos `messaging.yaml` y `rabbitmq.yaml` de cada perfil, con las MISMAS claves y variables
//     que keel-spring, y los números de la conexión (prefetch, recuperación, confirmación).
//
// Nació en keel-nest (incremento 9) y se sacó aquí al empezar keel-dotnet: escrita dos veces, la cola de
// una suscripción o la clave de un parámetro divergen al primer matiz.

import { kafkaListenerRetry, missingTargetRetryDestinations, deadLetterName, subscriptionDestination, subscriptionGroupId, subscriptionKey } from './dead-letter.js';
import { KAFKA_PRODUCER_TIMEOUTS } from './infra-catalog.js';
import { subscriptionQueues } from './messaging-provisioning.js';
import { OUTBOX_PURGE, OUTBOX_RELAY, PROCESSED_EVENT_PURGE, parameterValue } from './messaging-stores.js';
import { envWithDefault } from './profile-values.js';
import { envFor, runtimeDefault } from './runtime-env.js';

/** ¿Consume el servicio de una COLA propia? RabbitMQ (cuelga del exchange de la fuente) y SNS/SQS (del topic). */
export function consumesFromQueue(model) {
  return model.stack?.broker === 'rabbitmq' || model.stack?.broker === 'snssqs';
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
      const queue = consumesFromQueue(model) ? subscriptionDestination(model.stack.broker, model, sub) : sub.name;
      unit = { key: queue, label: `la cola ${queue}`, queue };
    }
    if (!units.has(unit.key)) units.set(unit.key, { ...unit, subscriptions: [] });
    units.get(unit.key).subscriptions.push(sub.name);
  }
  return [...units.values()];
}

// ─── RabbitMQ ────────────────────────────────────────────────────────────────

/** El prefetch del contenedor de listeners del servidor de keel-spring (250). */
export const RABBIT_PREFETCH = 250;
/** El intervalo de recuperación del listener (`rabbitmq.listener.recovery-interval-ms`; catálogo neutral). */
export const RABBIT_RECOVERY_INTERVAL_MS = runtimeDefault('RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS');
/**
 * Cuánto espera una publicación la confirmación del broker. Por ENCIMA del intervalo de recuperación:
 * un plazo más corto reinicia ese reloj en cada intento y la reconexión no converge (la regla que la
 * skill keel-spring-rabbitmq le da al dispatcher del outbox).
 */
export const RABBIT_CONFIRM_TIMEOUT_MS = 10000;

/** La topología de consumo como DATOS: una entrada por COLA (las suscripciones de un canal la comparten). */
export function rabbitTopology(model) {
  const queues = new Map();
  const missingTarget = missingTargetRetryDestinations(model, 'rabbitmq');
  for (const sub of model.subscriptions ?? []) {
    const queue = subscriptionDestination('rabbitmq', model, sub);
    if (!queues.has(queue)) {
      // Por COLA, como RETRIES_NOT_FOUND en keel-spring (keel-core decide cuáles).
      queues.set(queue, { source: sub.topicDefault, queue, deadLetter: null, retriesNotFound: missingTarget.includes(queue), subscriptions: [] });
    }
    const entry = queues.get(queue);
    entry.subscriptions.push(sub.name);
    // El descarte es propiedad de la COLA: basta con que una de las que la comparten lo declare.
    if (sub.deadLetter) entry.deadLetter = deadLetterName('rabbitmq', queue);
  }
  return [...queues.values()];
}

/** Los canales en los que publica el servicio, con sus eventos (messaging.publishChannels del modelo). */
export function publishedChannels(model) {
  const byChannel = model.messaging?.eventTypesByChannel ?? {};
  return (model.messaging?.publishChannels ?? []).map((channel) => ({ channel, events: byChannel[channel] ?? [] }));
}

/** El fragmento `rabbitmq.yaml` de un perfil: las variables de keel-spring y la confirmación del publicador. */
export function rabbitYaml(profile) {
  const lines = [
    'rabbitmq:',
    ...(profile === 'test'
      ? ['  # Las pruebas de build arrancan sin broker: la conexión no se intenta.', '  enabled: false']
      : ['  enabled: true']),
    `  host: ${envFor('RABBITMQ_HOST', profile)}`,
    `  port: ${envFor('RABBITMQ_PORT', profile)}`,
    `  username: ${envFor('RABBITMQ_USERNAME', profile)}`,
    `  password: ${envFor('RABBITMQ_PASSWORD', profile)}`,
    '  listener:',
    '    # Techo de la espera entre reconexiones (la misma clave en los servidores de todos los generadores).',
    `    recovery-interval-ms: ${envFor('RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS', profile)}`
  ];
  // El reintento del listener NO va aquí: sale del diseño (onFailure.retry) y lo lleva la topología emitida.
  // Una clave que nadie lee sería una palanca que no mueve nada.
  lines.push(
    '  publisher:',
    '    # Cuánto espera una publicación la confirmación del broker: por encima de la recuperación.',
    `    confirm-timeout-ms: ${envWithDefault(profile, 'RABBITMQ_PUBLISHER_CONFIRM_TIMEOUT_MS', RABBIT_CONFIRM_TIMEOUT_MS)}`
  );
  return `${lines.join('\n')}\n`;
}

// ─── messaging.yaml ──────────────────────────────────────────────────────────

/** La clave de la routing key de un evento (`notification-sent`). */
export const routingKeyName = (event) => event.routingKeyProperty.split('.').pop();
export { subscriptionKey };
const topicEnv = (sub) => sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');
/** La variable de la cola propia de una suscripción (RabbitMQ y SNS/SQS). */
export const queueEnv = (sub) => `${topicEnv(sub).replace(/_TOPIC$/, '')}_QUEUE`;
/** La variable del consumer group de una suscripción (Kafka). */
export const groupEnv = (sub) => `${topicEnv(sub).replace(/_TOPIC$/, '')}_GROUP_ID`;
export { topicEnv };

/**
 * El mismo `messaging.yaml` que keel-spring, con las claves del relay de keel-core/gen/messaging-stores.js.
 * Si hay outbox y registro de procesados lo dice el generador (`outbox`, `processedEvents`): depende de la
 * persistencia que sepa emitir.
 */
export function messagingYaml(model, profile, { outbox = false, processedEvents = false } = {}) {
  const lines = ['messaging:'];
  const events = model.events ?? [];
  const subscriptions = model.subscriptions ?? [];
  if (events.length > 0) {
    lines.push('  publishing:', `    destination: ${envFor('MESSAGING_DESTINATION', profile, events[0].destinationDefault)}`, '    routing-keys:');
    for (const event of events) lines.push(`      ${routingKeyName(event)}: ${event.routingKeyDefault}`);
  }
  if (subscriptions.length > 0) {
    lines.push('  subscriptions:');
    for (const sub of subscriptions) {
      lines.push(`    ${subscriptionKey(sub)}:`, `      topic: ${envWithDefault(profile, topicEnv(sub), sub.topicDefault)}`);
      // Con RabbitMQ se consume de una COLA propia de este servicio que cuelga del exchange del canal:
      // su nombre lo declara aquí build, el mismo que crea la topología y al que entrega el arnés.
      if (consumesFromQueue(model)) {
        lines.push(`      queue: ${envWithDefault(profile, queueEnv(sub), subscriptionDestination(model.stack.broker, model, sub))}`);
      }
      // Con Kafka, el consumer group de la suscripción: la misma clave y el mismo default que keel-spring.
      if (model.stack?.broker === 'kafka') {
        lines.push(`      group-id: ${envWithDefault(profile, groupEnv(sub), subscriptionGroupId(model, sub))}`);
      }
    }
  }
  // La línea de un parámetro del catálogo neutral: la hoja de su clave con el gradiente de su variable. Un
  // cron va entrecomillado ENTERO (empieza por dígito y lleva `*`), con el default desnudo dentro.
  const line = (parameter, comment) => {
    const leaf = parameter.key.split('.');
    const out = comment ? [`${'  '.repeat(leaf.length - 1)}# ${comment}`] : [];
    const value = envWithDefault(profile, parameter.env, parameterValue(parameter, profile));
    out.push(`${'  '.repeat(leaf.length - 1)}${leaf.at(-1)}: ${parameter.cron ? `"${value}"` : value}`);
    return out;
  };
  if (processedEvents) {
    lines.push(
      'processed-event:',
      '  purge:',
      ...line(PROCESSED_EVENT_PURGE.cron, 'Borrado del registro de mensajes procesados; la retención solo tiene que cubrir la ventana de reentrega del broker.'),
      ...line(PROCESSED_EVENT_PURGE.retentionDays)
    );
  }
  if (outbox) {
    lines.push(
      'outbox:',
      '  relay:',
      ...line(OUTBOX_RELAY.fixedDelayMs, 'Cada cuánto el relay busca filas pendientes y las entrega al broker.'),
      ...line(OUTBOX_RELAY.batchSize),
      ...line(OUTBOX_RELAY.maxAttempts, 'Tras agotar los reintentos la fila queda como dead-letter: no se reintenta ni se borra.'),
      '    backoff:',
      ...line(OUTBOX_RELAY.backoffInitialMs, 'Backoff exponencial entre reintentos de una fila (initial·2^(n-1), con tope max-ms).'),
      ...line(OUTBOX_RELAY.backoffMaxMs),
      ...line(OUTBOX_RELAY.claimTimeoutMs, 'Lease de una fila reclamada mientras su publicación está en vuelo; si la réplica muere, caduca.'),
      '  purge:',
      ...line(OUTBOX_PURGE.cron, 'Borrado diario de lo ya publicado (lo pendiente no se toca nunca); la tabla no es un histórico.'),
      ...line(OUTBOX_PURGE.retentionDays)
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── Kafka ───────────────────────────────────────────────────────────────────

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

/** El consumo como DATOS: una entrada por SUSCRIPCIÓN (cada una con su consumer group). */
export function kafkaConsumption(model) {
  const retry = kafkaListenerRetry(model);
  const missingTarget = missingTargetRetryDestinations(model, 'kafka');
  return (model.subscriptions ?? []).map((sub) => {
    const topic = subscriptionDestination('kafka', model, sub);
    return {
      subscription: sub.name,
      topic,
      groupId: subscriptionGroupId(model, sub),
      // Por TOPIC, como DEAD_LETTERED en keel-spring: basta con que una suscripción del topic lo declare.
      deadLetter: retry.deadLetteredTopics.includes(topic),
      // Por TOPIC también, como RETRIES_NOT_FOUND en keel-spring (keel-core decide cuáles).
      retriesNotFound: missingTarget.includes(topic)
    };
  });
}

/** El fragmento `kafka.yaml` de un perfil: las variables de keel-spring y los plazos del productor de keel-core. */
export function kafkaYaml(profile) {
  const local = profile === 'local';
  const timeout = (p) => (local ? String(p.local) : `\${${p.env}:${p.default}}`);
  const lines = [
    'kafka:',
    ...(profile === 'test'
      ? ['  # Las pruebas de build arrancan sin broker: la conexión no se intenta.', '  enabled: false']
      : ['  enabled: true']),
    `  bootstrap-servers: ${envFor('KAFKA_BOOTSTRAP_SERVERS', profile)}`,
    '  producer:',
    '    # Cuánto espera un envío sin confirmar antes de fallar (las mismas variables en todos los servidores). El',
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

// ─── SNS/SQS ─────────────────────────────────────────────────────────────────

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

/** El consumo como DATOS: una entrada por SUSCRIPCIÓN, cada una con su cola (la de init-messaging.sh). */
export function snsSqsConsumption(model) {
  const queues = subscriptionQueues(model);
  const missingTarget = missingTargetRetryDestinations(model, 'snssqs');
  return (model.subscriptions ?? []).map((sub, index) => ({
    subscription: sub.name,
    queue: queues[index].name,
    // Por COLA, que aquí es una por suscripción (keel-core decide cuáles).
    retriesNotFound: missingTarget.includes(queues[index].name),
    deadLetterQueue: queues[index].deadLetter ? queues[index].deadLetterName : null,
    maxReceive: queues[index].maxReceive,
    initialMs: sub.retry?.initialDelayMs ?? 1000,
    multiplier: (sub.retry?.backoff ?? 'exponential') === 'exponential' ? 2 : 1,
    maxDelayMs: sub.retry?.maxDelayMs ?? null
  }));
}

/** El fragmento `snssqs.yaml` de un perfil: las variables de keel-spring (aws.*) y el sondeo de SQS. */
export function snssqsYaml(profile) {
  const lines = [
    'aws:',
    ...(profile === 'test'
      ? ['  # Las pruebas de build arrancan sin broker: la conexión no se intenta.', '  enabled: false']
      : ['  enabled: true']),
    `  region: ${envFor('AWS_REGION', profile)}`,
    '  credentials:',
    '    # En producción, si la plataforma da un rol IAM, vacía las dos y el SDK usa su cadena por defecto.',
    `    access-key: ${envFor('AWS_ACCESS_KEY_ID', profile)}`,
    `    secret-key: ${envFor('AWS_SECRET_ACCESS_KEY', profile)}`
  ];
  // En local y develop, LocalStack; en production el SDK resuelve el endpoint real de AWS (no se fija).
  if (profile !== 'production') lines.push('  sns:', `    endpoint: ${envFor('AWS_SNS_ENDPOINT', profile)}`);
  lines.push('  sqs:');
  if (profile !== 'production') lines.push(`    endpoint: ${envFor('AWS_SQS_ENDPOINT', profile)}`);
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
