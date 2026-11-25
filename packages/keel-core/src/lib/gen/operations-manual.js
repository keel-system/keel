// El manual de OPERACIÓN del servicio generado (`docs/keel/operations.md`), NEUTRAL: lo escriben igual los cuatro
// generadores, con el patrón de `personal-data.js`. Es para quien despliega y está de guardia: qué hay que configurar,
// qué corre solo, qué se queda atascado y dónde, y qué significa cada alerta.
//
// No vive en el workspace de diseño porque depende del stack: la cola de descarte de RabbitMQ no se llama como la de
// Kafka, y las alertas solo existen con telemetría. Y no lo redacta un agente: cada fila sale de la misma fuente que el
// código que describe (los parámetros de `messaging-stores.js`, las purgas de `timer-plan.js`, los destinos de
// `dead-letter.js`, las alertas de `observability-assets.js`), así que no puede nombrar una variable o una alerta que
// el servidor no tiene. Lo único de la plataforma que entra es la que ya recibe `observabilityAssets`, porque de ella
// dependen tres alertas. Determinista: ningún timestamp.

import { AUTH, BROKERS, CACHES, DATABASES, PAYMENT_GATEWAYS, STORAGE, TELEMETRY, ALERTING } from './infra-catalog.js';
import { OUTBOX_PURGE, OUTBOX_RELAY, PROCESSED_EVENT_PURGE, usesOutbox, parameterValue } from './messaging-stores.js';
import { RECONCILIATION_PURGE, reconciledActivations } from './reconciliation-stores.js';
import { generatorPurges, generatorSchedules, usesTimer } from './timer-plan.js';
import { KEEL_TIMER, TIMER_PARAMETERS, TIMER_SWITCH } from './timer-store.js';
import { scheduledOperations } from './scheduling.js';
import { modelDeadlines } from './deadlines.js';
import { deadLetterDestination, deadLetterSubscriptions, subscriptionDestination } from './dead-letter.js';
import { alertRules } from './observability-assets.js';
import { usesTelemetry } from './telemetry-vocabulary.js';
import { identitySeedCommand } from './identity-provisioning.js';
import { identityContractFile } from './identity-support.js';
import { PERSONAL_DATA_FILE, usesPersonalData } from './personal-data.js';
import { IDEMPOTENCY_RECORD_PURGE } from './request-idempotency.js';
import { BATCH_PARAMETERS } from './batch-store.js';

/** Ruta del manual en el proyecto generado. */
export const OPERATIONS_MANUAL_FILE = 'docs/keel/operations.md';

/**
 * La retención que acompaña al cron de cada purga: las dos mitades de la misma decisión. La de idempotencia no tiene
 * variable propia: cada clave caduca con el `ttlSeconds` que declara su operación.
 */
const PURGE_RETENTION = new Map([
  [OUTBOX_PURGE.cron, OUTBOX_PURGE.retentionDays],
  [PROCESSED_EVENT_PURGE.cron, PROCESSED_EVENT_PURGE.retentionDays],
  [RECONCILIATION_PURGE.cron, RECONCILIATION_PURGE.retentionDays],
  [IDEMPOTENCY_RECORD_PURGE.cron, 'la caducidad de cada clave (`idempotency.ttlSeconds` de su operación)'],
  [BATCH_PARAMETERS.purgeCron, BATCH_PARAMETERS.retentionDays]
]);

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function code(text) {
  return `\`${text}\``;
}

/** Un parámetro del generador como fila: variable, default y, si difiere, el de `local`. */
function parameterRow(label, parameter) {
  const local = parameter.local !== undefined ? ` (en local, ${code(parameterValue(parameter, 'local'))})` : '';
  return `| ${label} | ${code(parameter.env)} | ${code(parameter.default)}${local} |`;
}

function stackSection(model) {
  const stack = model.stack ?? {};
  const rows = [
    ['Base de datos', stack.database && DATABASES[stack.database]?.label],
    ['Broker', stack.broker && BROKERS[stack.broker]?.label],
    ['Proveedor de identidad', stack.auth && AUTH[stack.auth]?.label],
    ['Caché', stack.cache && CACHES[stack.cache]?.label],
    ['Almacenamiento', stack.storage && STORAGE[stack.storage]?.label],
    ['Pasarela de pago', stack.paymentGateway && PAYMENT_GATEWAYS[stack.paymentGateway]?.label],
    ['Telemetría', TELEMETRY[stack.telemetry ?? 'none']?.label]
  ].filter(([, value]) => value);
  return ['## Stack', '', '| Pieza | Elegida al generar |', '|---|---|', ...rows.map(([piece, value]) => `| ${piece} | ${cell(value)} |`)];
}

function parametersSection(model) {
  const parameters = model.service?.parameters ?? [];
  if (parameters.length === 0) return [];
  return [
    '## Parámetros del servicio',
    '',
    'Valores de despliegue que decide el diseño (`service.parameters`). Uno obligatorio en producción hace que el servicio',
    'no arranque si falta: un default silencioso haría operar al servicio con un valor que nadie eligió.',
    '',
    '| Parámetro | Variable | Default | Obligatorio en producción | Qué es |',
    '|---|---|---|---|---|',
    ...parameters.map(
      (p) =>
        `| ${p.name} | ${code(p.envVar)} | ${p.default === null ? '—' : code(p.default)} | ${p.requiredInProduction ? 'sí' : 'no'} | ${cell(p.description) || '—'} |`
    )
  ];
}

function scheduledSection(model) {
  const operations = scheduledOperations(model);
  const deadlines = modelDeadlines(model);
  const purges = generatorPurges(model);
  if (operations.length === 0 && deadlines.length === 0 && purges.length === 0) return [];
  const timer = usesTimer(model);
  const out = ['## Lo que corre solo', ''];
  out.push(
    timer
      ? `Lo dispara el cronómetro del servicio (${code(KEEL_TIMER.table)}): con varias réplicas, cada disparo lo ejecuta UNA sola. ` +
          `Una réplica deja de sondear con ${code(TIMER_SWITCH.env)} = \`false\`, y un disparo que falla ${code(TIMER_PARAMETERS.maxAttempts.env)} ` +
          `veces (${TIMER_PARAMETERS.maxAttempts.default} por defecto) queda aparcado: no se vuelve a intentar solo.`
      : 'Cada réplica lleva su propio reloj: con varias réplicas, cada una dispara lo suyo.',
    ''
  );
  if (operations.length > 0) {
    const crons = new Map(generatorSchedules(model).map((schedule) => [schedule.operation, schedule.cron]));
    out.push('| Operación programada | Cron | Qué hace |', '|---|---|---|');
    for (const operation of operations) {
      out.push(`| ${operation.name} | ${code(crons.get(operation.name) ?? operation.schedule.cron)} | ${cell(operation.description) || '—'} |`);
    }
    out.push('');
  }
  if (deadlines.length > 0) {
    out.push('| Plazo | Vence tras | Lo cumple |', '|---|---|---|');
    for (const { entity, deadline, duration } of deadlines) {
      const after = duration.parameter ? `el parámetro ${duration.parameter} (${duration.unit})` : `${duration.seconds} s`;
      out.push(`| ${entity.name}: ${deadline.stateName} → ${deadline.toName} | ${after}, desde ${deadline.since} | ${deadline.by} |`);
    }
    out.push('');
  }
  if (purges.length > 0) {
    out.push('Las tablas del generador se purgan solas; lo pendiente no se toca nunca.', '', '| Tabla | Cron | Retención |', '|---|---|---|');
    for (const purge of purges) {
      const retention = PURGE_RETENTION.get(purge.cron);
      const kept = typeof retention === 'string' ? retention : `${code(retention.env)} = ${code(retention.default)} días`;
      out.push(`| ${code(purge.table)} | ${code(purge.cron.env)} = ${code(purge.cron.default)} | ${kept} |`);
    }
    out.push('');
  }
  return out.slice(0, -1);
}

function messagingSection(model) {
  const outbox = usesOutbox(model);
  const deadLetters = model.stack?.broker ? deadLetterSubscriptions(model) : [];
  if (!outbox && deadLetters.length === 0) return [];
  const out = ['## Mensajería', ''];
  if (outbox) {
    out.push(
      '### Outbox',
      '',
      'Los eventos se escriben en `outbox_event` en la misma transacción que el cambio, y un relay los publica después.',
      `Una fila que falla ${code(OUTBOX_RELAY.maxAttempts.env)} veces se RINDE: deja de reintentarse y se queda en la tabla con`,
      'su `last_error`, sin borrarse. Eso es pérdida de entrega: el cambio está guardado y el evento no salió.',
      '',
      '| Ajuste | Variable | Default |',
      '|---|---|---|',
      parameterRow('Sondeo de respaldo (ms)', OUTBOX_RELAY.pollMs),
      parameterRow('Filas por pasada', OUTBOX_RELAY.batchSize),
      parameterRow('Intentos antes de rendirse', OUTBOX_RELAY.maxAttempts),
      parameterRow('Primer aplazamiento (ms)', OUTBOX_RELAY.backoffInitialMs),
      parameterRow('Tope del aplazamiento (ms)', OUTBOX_RELAY.backoffMaxMs),
      parameterRow('Retención de una fila reclamada (ms)', OUTBOX_RELAY.claimTimeoutMs),
      ''
    );
  }
  if (deadLetters.length > 0) {
    const broker = model.stack.broker;
    out.push(
      '### Mensajes descartados',
      '',
      'Un mensaje que agota sus reintentos, o que el servicio rechaza por su contenido, no se pierde: va a su destino de',
      'descarte, donde espera a que alguien lo mire. Ningún proceso lo reintenta solo.',
      '',
      '| Suscripción | Se consume de | Descarte | Intentos |',
      '|---|---|---|---|',
      ...deadLetters.map(
        (sub) =>
          `| ${sub.name} | ${code(subscriptionDestination(broker, model, sub))} | ${code(deadLetterDestination(broker, model, sub))} | ${sub.retry?.maxAttempts ?? 1} |`
      ),
      ''
    );
  }
  return out.slice(0, -1);
}

function reconciliationSection(model) {
  const activations = reconciledActivations(model);
  if (activations.length === 0) return [];
  return [
    '## Reconciliación',
    '',
    'Un encargo a otro servicio que no contesta no lo detecta ningún evento: lo encuentra un barrido periódico.',
    '',
    '| Encargo | Proveedor | Silencio tolerado | Lo barre |',
    '|---|---|---|---|',
    ...activations.map(({ dependency, activation, sweeper }) => {
      const silence = activation.unansweredParameter
        ? `el parámetro ${activation.unansweredParameter}`
        : `${activation.unansweredAfterSeconds} s`;
      return `| ${activation.name} | ${dependency} | ${silence} | ${sweeper?.name ?? activation.reconciledBy} |`;
    })
  ];
}

function alertsSection(model, platform) {
  if (!usesTelemetry(model)) return [];
  const rules = alertRules(model, platform);
  return [
    '## Alertas',
    '',
    `Provisionadas en el Grafana de \`deploy/\`; avisan al contacto de la variable ${code(ALERTING.webhookVar)}. Cada una`,
    'existe solo si su subsistema existe en el diseño.',
    '',
    '| Alerta | Severidad | Dispara | Qué significa y qué mirar |',
    '|---|---|---|---|',
    ...rules.map(
      (rule) => `| ${rule.title} | ${rule.severity} | ${rule.threshold !== undefined ? `> ${rule.threshold}` : '> 0'} durante ${rule.forDuration} | ${cell(rule.summary)} |`
    )
  ];
}

function identitySection(model) {
  const seed = identitySeedCommand(model);
  if (!seed) return [];
  const contract = identityContractFile(model);
  return [
    '## Identidad',
    '',
    `El proveedor de prueba arranca sin realm: hasta sembrarlo con ${code(seed)} no sale ningún token. Las credenciales de`,
    'prueba están en `infra/test-credentials.env`.' +
      (contract ? ` Lo que un proveedor real tiene que traer para este diseño, en ${code(contract.path)}.` : '')
  ];
}

function personalSection(model) {
  if (!usesPersonalData(model)) return [];
  return ['## Datos personales', '', `Qué guarda el servicio, cuánto vive y qué garantiza sobre ello: [${PERSONAL_DATA_FILE}](personal-data.md).`];
}

/**
 * El manual de operación como archivo: `{ path, content }`. `platform` es la de `observabilityAssets` del generador,
 * y solo cuenta para las alertas.
 */
export function operationsManual(model, platform) {
  const sections = [
    stackSection(model),
    parametersSection(model),
    scheduledSection(model),
    messagingSection(model),
    reconciliationSection(model),
    alertsSection(model, platform),
    identitySection(model),
    personalSection(model)
  ].filter((section) => section.length > 0);
  const lines = [
    `# Manual de operación de ${model.service.name}`,
    '',
    `Generado por build desde el diseño (v${model.service.version}) y el stack elegido. No se edita: cambia el diseño o el stack y vuelve a generar.`,
    ...sections.flatMap((section) => ['', ...section])
  ];
  return { path: OPERATIONS_MANUAL_FILE, content: `${lines.join('\n')}\n` };
}
