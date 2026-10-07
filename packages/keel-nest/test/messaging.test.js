// La mensajería de keel-nest (incremento 9), EJECUTADA: se transpila lo que emite build y se usa. Lo que
// importa Nest, TypeORM o amqplib (el puente, el relay, la conexión) lo compila `npm run ts-check` y lo
// juzga contra un broker real el arnés; aquí, lo que es TypeScript puro y decide el contrato:
//   · la envoltura en el cable (metadata en su orden, nulos de la metadata, `data` sin la metadata) y su
//     lectura, con lo que incumple el contrato;
//   · los mensajes de suscripción: los nombres de la fuente (wireName), el contrato (presencia y cotas)
//     con los mensajes de keel-spring, y la envoltura propia de una fuente ajena;
//   · el backoff del relay contra la referencia de keel-core;
//   · la topología de RabbitMQ y la configuración (messaging.yaml, rabbitmq.yaml) contra lo que EMITE
//     keel-spring del mismo diseño, y el reintento del listener.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { outboxBackoffMs as referenceBackoff, OUTBOX_RELAY, parameterValue } from 'keel-core/gen/messaging-stores';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import {
  EVENT_ENVELOPE_TS,
  MESSAGE_CONTRACT_TS,
  OUTBOX_BACKOFF_TS,
  RABBIT_TOPOLOGY_TS,
  integrationPath,
  messagePath,
  envelopePath
} from '../src/scaffold/messaging.js';
import { EVENT_METADATA_TS } from '../src/scaffold/events.js';
import { DOMAIN_EXCEPTION_TS } from '../src/scaffold/exceptions.js';

const RABBIT = { broker: 'rabbitmq' };

function emitted(name) {
  const plan = planFixture(name, { stack: RABBIT });
  return { ...plan, tree: transpileTree(plan.files) };
}

function spring(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: RABBIT }).files;
}

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

// ─── La envoltura ────────────────────────────────────────────────────────────

test('la envoltura sale con la metadata en el orden del cable, con sus nulos, y sin la metadata en data', async () => {
  const { model, tree } = emitted('stock-reservation');
  const event = model.events[0];
  const { EventMetadata } = await tree.load(EVENT_METADATA_TS);
  const { EventEnvelope } = await tree.load(EVENT_ENVELOPE_TS);
  const { toWireJson } = await tree.load('src/application/support/wire.ts');
  const Integration = (await tree.load(integrationPath(event)))[event.integrationClass];
  const metadata = new EventMetadata('e-1', event.name, 1, new Date('2026-10-07T10:00:00.5Z'), 'stock-reservation', null, null);
  const values = event.fields.map((field) => (field.list ? [] : `v-${field.name}`));
  const integration = new Integration(metadata, ...values);
  const json = JSON.parse(toWireJson(EventEnvelope.of(metadata, integration, 'corr-1')));
  assert.deepEqual(Object.keys(json), ['metadata', 'data']);
  assert.deepEqual(Object.keys(json.metadata), ['eventId', 'eventType', 'eventVersion', 'occurredAt', 'source', 'correlationId', 'traceparent']);
  assert.equal(json.metadata.occurredAt, '2026-10-07T10:00:00.500Z');
  assert.equal(json.metadata.correlationId, 'corr-1');
  assert.equal(json.metadata.traceparent, null, 'sin telemetría el traceparent viaja a null, no se omite');
  assert.deepEqual(Object.keys(json.data), event.fields.map((field) => field.name), 'data: solo el payload, en su orden');
  assert.equal(integration.metadata, metadata, 'la metadata se conserva para el puente');
});

test('con conventions.nulls: omit, el evento de integración no escribe sus campos sin valor', async () => {
  // Ninguna fixture con omit publica un campo opcional: se deriva de catalog-extended en memoria.
  const plan = planFixture('catalog-extended', {
    stack: RABBIT,
    mutate: (layers) => {
      layers.messaging.publishing.events.ProductCreated.payload.sku.required = false;
    }
  });
  const { model } = plan;
  const tree = transpileTree(plan.files);
  const event = model.events.find((candidate) => candidate.name === 'ProductCreated');
  const { EventMetadata } = await tree.load(EVENT_METADATA_TS);
  const { toWireJson } = await tree.load('src/application/support/wire.ts');
  const Integration = (await tree.load(integrationPath(event)))[event.integrationClass];
  const values = event.fields.map((field) => (field.list ? [] : field.required ? `v-${field.name}` : null));
  const json = JSON.parse(toWireJson(new Integration(EventMetadata.now(event.name), ...values)));
  for (const field of event.fields.filter((candidate) => !candidate.required && !candidate.list)) {
    assert.ok(!(field.name in json), `${field.name} no viaja`);
  }
});

test('EventEnvelope.parse lee una envoltura Keel y rechaza lo que no lo es como contrato incumplido', async () => {
  const { tree } = emitted('stock-reservation');
  const { EventEnvelope } = await tree.load(EVENT_ENVELOPE_TS);
  const { MessageContractViolation } = await tree.load(MESSAGE_CONTRACT_TS);
  const envelope = EventEnvelope.parse(
    '{"metadata":{"eventId":"e-9","eventType":"StockReserved","eventVersion":1,"occurredAt":"2026-10-07T10:00:00.000Z","source":"inventory","correlationId":null,"traceparent":null},"data":{"orderId":"o-1","quantity":2.50}}'
  );
  assert.equal(envelope.metadata.eventId, 'e-9');
  assert.equal(envelope.metadata.eventType, 'StockReserved');
  assert.equal(envelope.metadata.occurredAt.toISOString(), '2026-10-07T10:00:00.000Z');
  assert.equal(envelope.metadata.correlationId, null);
  assert.equal(envelope.data.quantity.source, '2.50', 'los números del data conservan su texto exacto');
  for (const bad of ['no es json', '{"data":{}}', '{"metadata":{"eventType":"X"},"data":{}}', '{"metadata":{"eventId":"e","eventType":"X","eventVersion":"uno","occurredAt":"ayer","source":"s"},"data":{}}']) {
    assert.throws(() => EventEnvelope.parse(bad), MessageContractViolation, bad);
  }
});

// ─── Los mensajes de suscripción ─────────────────────────────────────────────

test('un mensaje de una fuente ajena se lee por sus nombres (wireName) y cumple el contrato', async () => {
  const { model, tree } = emitted('metering-digest');
  const sub = model.subscriptions.find((candidate) => candidate.name === 'MeterReadingCaptured');
  const Message = (await tree.load(messagePath(sub)))[sub.messageRecord];
  const { parseWireJson } = await tree.load('src/application/support/wire.ts');
  const message = Message.fromWire(parseWireJson('{"meter_id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b","read_at":"2026-10-07T10:00:00Z","consumption_kwh":12.500,"source":"smart-meter","extra":"se ignora"}'));
  assert.equal(message.meterId, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
  assert.equal(message.readAt.toISOString(), '2026-10-07T10:00:00.000Z');
  assert.equal(String(message.consumptionKwh), '12.500', 'el decimal conserva la escala del cable');
  message.requireContract();
});

test('el contrato: el obligatorio que falta y el valor fuera de su tipo se rechazan sin reintento, con el mensaje de keel-spring', async () => {
  const { model, tree } = emitted('metering-digest');
  const sub = model.subscriptions.find((candidate) => candidate.name === 'MeterReadingCaptured');
  const Message = (await tree.load(messagePath(sub)))[sub.messageRecord];
  const { MessageContractViolation } = await tree.load(MESSAGE_CONTRACT_TS);
  // La presencia no se mira al leer (un mensaje ajeno se descarta antes de exigirla)…
  const incomplete = Message.fromWire({ meter_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' });
  // …sino en requireContract, con la frase de keel-spring.
  assert.throws(() => incomplete.requireContract(), (error) => error instanceof MessageContractViolation && error.message === "MeterReadingCaptured: el mensaje no trae 'readAt', que el contrato declara obligatorio");
  assert.throws(() => Message.fromWire({ meter_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', read_at: 'ayer' }), MessageContractViolation);
  assert.throws(() => Message.fromWire({ meter_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', source: 'no-es-del-enum' }), MessageContractViolation);
  assert.throws(() => Message.fromWire('no es un objeto'), MessageContractViolation);
});

test('las cotas del payload se comprueban en requireContract, con la ruta y el mensaje de la regla', async () => {
  // notification-mailer: templateKey lleva cota de longitud en el dominio.
  const { model, tree } = emitted('notification-mailer');
  const sub = model.subscriptions[0];
  const bounded = sub.fields.find((field) => (field.validation ?? []).some((rule) => rule.rule === 'size' && rule.max != null));
  assert.ok(bounded, 'notification-mailer tiene un campo acotado en su suscripción');
  const Message = (await tree.load(messagePath(sub)))[sub.messageRecord];
  const { MessageContractViolation } = await tree.load(MESSAGE_CONTRACT_TS);
  const max = bounded.validation.find((rule) => rule.rule === 'size').max;
  const message = new Message(...sub.fields.map((field) => (field.list ? [] : field.name === bounded.name ? 'x'.repeat(max + 1) : 'v@example.com')));
  assert.throws(
    () => message.requireContract(),
    (error) => error instanceof MessageContractViolation && error.message.startsWith(`${sub.name}: el mensaje incumple el contrato en '${bounded.name}': size must be between`)
  );
});

test('la envoltura propia de una fuente ajena se lee sin tocar el payload, y el payload después', async () => {
  const { model, tree } = emitted('metering-digest');
  const sub = model.subscriptions.find((candidate) => candidate.name === 'MeterDecommissioned');
  const Envelope = (await tree.load(envelopePath(sub)))[sub.envelopeRecord];
  const envelope = Envelope.parse('{"data":{"serial_number":"S-1","decommissioned_at":"2026-10-07T10:00:00Z"},"otro":1}');
  const message = envelope.message();
  assert.equal(message.serialNumber, 'S-1');
  message.requireContract();
});

// ─── El relay ────────────────────────────────────────────────────────────────

test('el backoff del relay es la fórmula de keel-core, y la rendición llega al alcanzar el máximo', async () => {
  const { tree } = emitted('stock-reservation');
  const { outboxBackoffMs, outboxDeadLettered, truncateError } = await tree.load(OUTBOX_BACKOFF_TS);
  for (const [initial, max] of [[1000, 60000], [1000, 2000], [250, 7000]]) {
    for (let attempts = 1; attempts <= 70; attempts++) {
      assert.equal(outboxBackoffMs(attempts, initial, max), referenceBackoff(attempts, initial, max), `${attempts}·${initial}·${max}`);
    }
  }
  assert.equal(outboxDeadLettered(9, 10), false);
  assert.equal(outboxDeadLettered(10, 10), true);
  assert.equal(truncateError(new Error('x'.repeat(2000))).length, 1024);
});

// ─── RabbitMQ ────────────────────────────────────────────────────────────────

/** La topología que declara RabbitTopologyConfig de keel-spring: una entrada por @Bean. */
function springTopology(files) {
  const java = content(files, '/RabbitTopologyConfig.java') ?? '';
  return java
    .split('@Bean')
    .slice(1)
    .filter((block) => block.includes('new TopicExchange('))
    .map((block) => ({
      source: /new TopicExchange\("([^"]+)"/.exec(block)[1],
      queue: /QueueBuilder\.durable\("([^"]+)"\)/.exec(block)[1],
      deadLetter: /"x-dead-letter-routing-key", "([^"]+)"/.exec(block)?.[1] ?? null
    }));
}

for (const name of ['metering-digest', 'notification-mailer', 'stock-reservation', 'catalog-extended']) {
  test(`${name}: la topología de RabbitMQ es la de keel-spring, y se declara entera`, async () => {
    const { tree } = emitted(name);
    const { RABBIT_TOPOLOGY, assertTopology } = await tree.load(RABBIT_TOPOLOGY_TS);
    const ours = RABBIT_TOPOLOGY.map(({ source, queue, deadLetter }) => ({ source, queue, deadLetter }));
    assert.deepEqual(ours, springTopology(spring(name)));
    const calls = [];
    const channel = {
      assertExchange: async (...args) => calls.push(['exchange', ...args]),
      assertQueue: async (...args) => calls.push(['queue', ...args]),
      bindQueue: async (...args) => calls.push(['bind', ...args])
    };
    await assertTopology(channel);
    for (const entry of RABBIT_TOPOLOGY) {
      assert.ok(calls.some((call) => call[0] === 'exchange' && call[1] === entry.source && call[2] === 'topic'));
      const queue = calls.find((call) => call[0] === 'queue' && call[1] === entry.queue);
      assert.deepEqual(queue[2].arguments, entry.deadLetter ? { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': entry.deadLetter } : {});
      if (entry.deadLetter) assert.ok(calls.some((call) => call[0] === 'queue' && call[1] === entry.deadLetter), 'la DLQ existe');
      assert.ok(calls.some((call) => call[0] === 'bind' && call[1] === entry.queue && call[2] === entry.source && call[3] === '#'));
    }
  });
}

test('la topología de publicación: el exchange del servicio y una cola por canal, enlazada con la routing key de cada evento', async () => {
  const { tree, model } = emitted('stock-reservation');
  const { PUBLISHED_CHANNELS, assertTopology } = await tree.load(RABBIT_TOPOLOGY_TS);
  assert.deepEqual(
    PUBLISHED_CHANNELS.map((entry) => entry.channel),
    model.messaging.publishChannels,
    'una cola por canal publicado, nombrada como el canal: de ahí lee el arnés'
  );
  const calls = [];
  const channel = {
    assertExchange: async (...args) => calls.push(['exchange', ...args]),
    assertQueue: async (...args) => calls.push(['queue', ...args]),
    bindQueue: async (...args) => calls.push(['bind', ...args])
  };
  const routingKeys = Object.fromEntries(model.events.map((event) => [event.name, event.routingKeyDefault]));
  const destination = model.messaging.destinationDefault;
  await assertTopology(channel, { destination, routingKeys });
  assert.ok(calls.some((call) => call[0] === 'exchange' && call[1] === destination && call[2] === 'topic'), 'el exchange del servicio');
  for (const entry of PUBLISHED_CHANNELS) {
    assert.ok(calls.some((call) => call[0] === 'queue' && call[1] === entry.channel));
    for (const event of entry.events) {
      assert.ok(calls.some((call) => call[0] === 'bind' && call[1] === entry.channel && call[2] === destination && call[3] === routingKeys[event]), `${entry.channel} ← ${event}`);
    }
  }
  // Sin una routing key para un evento publicado, no arranca: publicaría a un binding inexistente.
  await assert.rejects(() => assertTopology(channel, { destination, routingKeys: {} }), /Sin routing key/);
});

test('el reintento del listener: la curva del diseño, y sin reintento el rechazo de negocio ni el contrato incumplido', async () => {
  const { tree, model } = emitted('notification-mailer');
  const { LISTENER_RETRY, listenerAttempts, listenerBackoffMs, isRetryable } = await tree.load(RABBIT_TOPOLOGY_TS);
  const retry = model.subscriptions[0].retry;
  assert.equal(listenerAttempts(), retry.maxAttempts);
  assert.equal(LISTENER_RETRY.multiplier, 1.5);
  assert.equal(listenerBackoffMs(1), retry.initialDelayMs);
  assert.equal(listenerBackoffMs(2), retry.initialDelayMs * 1.5);
  assert.equal(listenerBackoffMs(30), retry.maxDelayMs, 'con su techo');
  assert.equal(listenerAttempts(null), 1, 'sin onFailure.retry, un solo intento');
  const { DomainException } = await tree.load(DOMAIN_EXCEPTION_TS);
  const { MessageContractViolation } = await tree.load(MESSAGE_CONTRACT_TS);
  class Rejected extends DomainException {}
  assert.equal(isRetryable(new Error('la base no responde')), true);
  assert.equal(isRetryable(new Rejected('regla de negocio')), false);
  assert.equal(isRetryable(new MessageContractViolation('falta un campo')), false);
});

// ─── La configuración ────────────────────────────────────────────────────────

for (const name of ['notification-mailer', 'metering-digest']) {
  test(`${name}: messaging.yaml dice lo mismo que el de keel-spring en cada perfil`, () => {
    const nest = planFixture(name, { stack: RABBIT }).files;
    const theirs = spring(name);
    for (const profile of ['local', 'develop', 'production']) {
      const ours = parseYaml(content(nest, `config/parameters/${profile}/messaging.yaml`));
      const reference = parseYaml(content(theirs, `parameters/${profile}/messaging.yaml`));
      assert.deepEqual(ours.messaging, reference.messaging, `${profile}: publicación y suscripciones`);
      // El relay y su purga, y la del registro de mensajes procesados (incremento 10b).
      assert.deepEqual(ours.outbox, reference.outbox, `${profile}: el relay y la purga del outbox`);
      assert.deepEqual(ours['processed-event'], reference['processed-event'], `${profile}: la purga de processed_event`);
    }
  });
}

test('el relay toma de keel-core su default en el perfil local (40 intentos, 2 s de tope)', () => {
  const yaml = parseYaml(content(planFixture('notification-mailer', { stack: RABBIT }).files, 'config/parameters/local/messaging.yaml'));
  assert.equal(yaml.outbox.relay['max-attempts'], parameterValue(OUTBOX_RELAY.maxAttempts, 'local'));
  assert.equal(yaml.outbox.relay.backoff['max-ms'], parameterValue(OUTBOX_RELAY.backoffMaxMs, 'local'));
});

test('rabbitmq.yaml usa las mismas variables que keel-spring y apaga la conexión en el perfil test', () => {
  const nest = planFixture('notification-mailer', { stack: RABBIT }).files;
  const theirs = spring('notification-mailer');
  for (const profile of ['local', 'develop', 'production']) {
    const ours = parseYaml(content(nest, `config/parameters/${profile}/rabbitmq.yaml`)).rabbitmq;
    const reference = parseYaml(content(theirs, `parameters/${profile}/broker.yaml`) ?? content(theirs, `parameters/${profile}/rabbitmq.yaml`));
    for (const key of ['host', 'port', 'username', 'password']) assert.equal(String(ours[key]), String(reference.spring.rabbitmq[key]), `${profile}: ${key}`);
    assert.equal(String(ours.listener['recovery-interval-ms']), String(reference.rabbitmq.listener['recovery-interval-ms']), `${profile}: recovery-interval-ms`);
  }
  assert.equal(parseYaml(content(nest, 'config/parameters/test/rabbitmq.yaml')).rabbitmq.enabled, false);
});

// Corrida stock-reservation-events (2026-10-07): el comentario de broker-bindings.ts y el de cada mensaje
// nombraban un listener POR SUSCRIPCIÓN, y las tres comparten cola: tres consumidores competirían por
// cada mensaje. El agente acertó a pesar del texto; el texto no puede empujar al error.
test('los listeners se nombran por COLA: con la cola compartida, uno que enruta por el tipo', () => {
  const { files, model } = planFixture('stock-reservation-events', { stack: RABBIT });
  const bindings = content(files, 'src/infrastructure/messaging/broker-bindings.ts');
  const queue = 'stock-reservation-events.inventory';
  assert.ok(bindings.includes(`uno para la cola ${queue} (StockReserved, StockCountAdjusted, StockRejected)`), bindings);
  for (const sub of model.subscriptions) {
    assert.ok(!bindings.includes(sub.listenerClass), `broker-bindings no nombra ${sub.listenerClass}`);
    const message = content(files, `subscriptions/${sub.messageRecord.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.ts`);
    assert.ok(!message.includes(sub.listenerClass), `${sub.messageRecord} no nombra ${sub.listenerClass}`);
    assert.match(message, /el listener de la cola stock-reservation-events\.inventory, que comparte con/);
  }
});
