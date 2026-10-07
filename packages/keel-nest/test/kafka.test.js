// Kafka en keel-nest (incremento 9f), EJECUTADO donde es TypeScript puro y comparado con lo que EMITE
// keel-spring del mismo diseño donde es contrato: los consumer groups, la curva del reintento, qué topics
// descartan en `<topic>.DLT`, y la configuración (messaging.yaml, kafka.yaml). La conexión la compila
// `npm run ts-check` y la juzga contra un Kafka real `npm run broker-check -- --broker=kafka`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { KAFKA_CONSUMPTION_TS, MESSAGE_CONTRACT_TS } from '../src/scaffold/messaging.js';
import { DOMAIN_EXCEPTION_TS } from '../src/scaffold/exceptions.js';

const KAFKA = { broker: 'kafka' };
const SUBJECT = 'stock-reservation-events';

function spring(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  if (mutate) mutate(layers);
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: KAFKA }).files;
}

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

/** Lo que el DeadLetterConfig de keel-spring fija: los topics con descarte y la curva del error handler. */
function springRetry(files) {
  const java = content(files, 'DeadLetterConfig.java');
  if (java == null) return null;
  const topics = [...(/Set\.of\(([^)]*)\)/.exec(java)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const fixed = /new FixedBackOff\((\d+)L, (\d+)L\)/.exec(java);
  if (fixed) return { topics, attempts: Number(fixed[2]) + 1, initialMs: Number(fixed[1]), multiplier: 1, maxDelayMs: null };
  return {
    topics,
    attempts: Number(/setMaxAttempts\((\d+)\)/.exec(java)[1]) + 1,
    initialMs: Number(/setInitialInterval\((\d+)L\)/.exec(java)[1]),
    multiplier: 1.5,
    maxDelayMs: Number(/setMaxInterval\((\d+)L\)/.exec(java)?.[1] ?? 30000)
  };
}

test('el consumo: un consumer group por suscripción, el mismo que keel-spring, y el descarte por topic', async () => {
  const { files } = planFixture(SUBJECT, { stack: KAFKA });
  const { KAFKA_CONSUMPTION } = await transpileTree(files).load(KAFKA_CONSUMPTION_TS);
  const theirs = spring(SUBJECT);
  const yaml = parseYaml(content(theirs, 'parameters/local/messaging.yaml')).messaging.subscriptions;
  const retry = springRetry(theirs);
  assert.equal(KAFKA_CONSUMPTION.length, Object.keys(yaml).length);
  for (const entry of KAFKA_CONSUMPTION) {
    const reference = Object.values(yaml).find((sub) => sub['group-id'] === entry.groupId);
    assert.ok(reference, `${entry.subscription}: el grupo ${entry.groupId} es el de keel-spring`);
    assert.equal(entry.topic, reference.topic, `${entry.subscription}: su topic`);
    assert.equal(entry.deadLetter, retry.topics.includes(entry.topic), `${entry.subscription}: descarta si su topic está en DEAD_LETTERED`);
  }
  // Las tres suscripciones comparten la fuente y aun así son tres grupos: cada una recibe el topic entero.
  assert.equal(new Set(KAFKA_CONSUMPTION.map((entry) => entry.groupId)).size, KAFKA_CONSUMPTION.length);
  assert.equal(new Set(KAFKA_CONSUMPTION.map((entry) => entry.topic)).size, 1);
});

test('el reintento: la curva del DeadLetterConfig de keel-spring, y sin reintento el rechazo de negocio ni el contrato', async () => {
  const { files } = planFixture(SUBJECT, { stack: KAFKA });
  const tree = transpileTree(files);
  const { LISTENER_RETRY, listenerAttempts, listenerBackoffMs, isRetryable, deadLetterTopic } = await tree.load(KAFKA_CONSUMPTION_TS);
  const reference = springRetry(spring(SUBJECT));
  assert.deepEqual(
    { attempts: LISTENER_RETRY.attempts, initialMs: LISTENER_RETRY.initialMs, multiplier: LISTENER_RETRY.multiplier, maxDelayMs: LISTENER_RETRY.maxDelayMs },
    { attempts: reference.attempts, initialMs: reference.initialMs, multiplier: reference.multiplier, maxDelayMs: reference.maxDelayMs }
  );
  assert.equal(listenerAttempts(), reference.attempts);
  assert.equal(listenerBackoffMs(1), reference.initialMs);
  assert.equal(listenerBackoffMs(2), reference.initialMs * 1.5);
  assert.equal(listenerBackoffMs(40), reference.maxDelayMs, 'con su techo');
  assert.equal(deadLetterTopic('inventory.events'), 'inventory.events.DLT');
  const { DomainException } = await tree.load(DOMAIN_EXCEPTION_TS);
  const { MessageContractViolation } = await tree.load(MESSAGE_CONTRACT_TS);
  class Rejected extends DomainException {}
  assert.equal(isRetryable(new Error('la base no responde')), true);
  assert.equal(isRetryable(new Rejected('regla de negocio')), false);
  assert.equal(isRetryable(new MessageContractViolation('falta un campo')), false);
});

test('sin ninguna suscripción con descarte: diez intentos sin espera (el DefaultErrorHandler por defecto) y nadie descarta', async () => {
  const mutate = (layers) => {
    for (const sub of Object.values(layers.messaging.subscriptions)) if (sub.onFailure) sub.onFailure.deadLetter = false;
  };
  const { files } = planFixture(SUBJECT, { stack: KAFKA, mutate });
  const { LISTENER_RETRY, KAFKA_CONSUMPTION, listenerBackoffMs } = await transpileTree(files).load(KAFKA_CONSUMPTION_TS);
  assert.equal(springRetry(spring(SUBJECT, mutate)), null, 'keel-spring no genera DeadLetterConfig');
  assert.equal(LISTENER_RETRY.attempts, 10);
  assert.equal(listenerBackoffMs(3), 0);
  assert.ok(KAFKA_CONSUMPTION.every((entry) => entry.deadLetter === false));
});

test('messaging.yaml dice lo mismo que el de keel-spring con Kafka, consumer groups incluidos', () => {
  const nest = planFixture(SUBJECT, { stack: KAFKA }).files;
  const theirs = spring(SUBJECT);
  for (const profile of ['local', 'develop', 'production']) {
    const ours = parseYaml(content(nest, `config/parameters/${profile}/messaging.yaml`));
    const reference = parseYaml(content(theirs, `parameters/${profile}/messaging.yaml`));
    assert.deepEqual(ours.messaging, reference.messaging, `${profile}: publicación y suscripciones`);
  }
});

test('kafka.yaml usa las mismas variables que keel-spring (servidores y plazos del productor) y apaga la conexión en test', () => {
  const nest = planFixture(SUBJECT, { stack: KAFKA }).files;
  const theirs = spring(SUBJECT);
  for (const profile of ['local', 'develop', 'production']) {
    const ours = parseYaml(content(nest, `config/parameters/${profile}/kafka.yaml`)).kafka;
    const reference = parseYaml(content(theirs, `parameters/${profile}/kafka.yaml`)).spring.kafka;
    assert.equal(String(ours['bootstrap-servers']), String(reference['bootstrap-servers']), `${profile}: bootstrap-servers`);
    assert.equal(String(ours.producer['delivery-timeout-ms']), String(reference.producer.properties['delivery.timeout.ms']), `${profile}: delivery`);
    assert.equal(String(ours.producer['request-timeout-ms']), String(reference.producer.properties['request.timeout.ms']), `${profile}: request`);
  }
  // El refresco de metadatos: corto donde los topics los crea el primer mensaje.
  assert.equal(parseYaml(content(nest, 'config/parameters/local/kafka.yaml')).kafka.consumer['metadata-refresh-interval-ms'], 2000);
  assert.equal(parseYaml(content(nest, 'config/parameters/test/kafka.yaml')).kafka.enabled, false);
});

test('el agente lee un listener por SUSCRIPCIÓN, con su consumer group, y que el descarte en .DLT ya lo hace build', () => {
  const { files, model } = planFixture(SUBJECT, { stack: KAFKA });
  const bindings = content(files, 'src/infrastructure/messaging/broker-bindings.ts');
  assert.match(bindings, /UNO POR SUSCRIPCIÓN/);
  for (const sub of model.subscriptions) {
    const group = `${model.service.artifactId}-${sub.topicProperty.split('.').slice(-2)[0]}`;
    assert.ok(bindings.includes(`uno para ${sub.name} (consumer group ${group})`), `${sub.name} en broker-bindings`);
    const message = content(files, `subscriptions/${sub.messageRecord.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.ts`);
    assert.ok(message.includes(`el listener de su consumer group (${group})`), `${sub.messageRecord}: su consumidor`);
    assert.ok(!message.includes('la cola'), `${sub.messageRecord}: en Kafka no hay cola`);
    if (sub.deadLetter) assert.ok(message.includes(`${sub.topicDefault}.DLT`), `${sub.messageRecord}: su descarte`);
  }
});

test('el proyecto Kafka trae su cliente, su skill, y ni amqplib ni la conexión de RabbitMQ', () => {
  const { files } = planFixture(SUBJECT, { stack: KAFKA });
  const pkg = JSON.parse(content(files, 'package.json'));
  assert.ok(pkg.dependencies['@confluentinc/kafka-javascript']);
  assert.equal(pkg.dependencies.amqplib, undefined);
  assert.ok(files.some((file) => file.path.includes('keel-nest-kafka/SKILL.md')));
  assert.ok(!files.some((file) => file.path.includes('/rabbitmq/')));
  const flow = content(files, 'test/integration/support/flow.ts');
  assert.match(flow, /function markChannels\(\)/);
  assert.match(flow, /currentApp\?\.get\(KafkaConnection\)/);
});
