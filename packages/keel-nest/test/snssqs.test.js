// SNS/SQS en keel-nest (incremento 9g), EJECUTADO donde es TypeScript puro y comparado con lo que EMITE
// keel-spring del mismo diseño donde es contrato: las colas, sus DLQ y su maxReceiveCount (los de
// init-messaging.sh), la configuración (messaging.yaml, snssqs.yaml) y el propio script, que es neutral. La
// conexión la compila `npm run ts-check` y la juzga contra un LocalStack real `npm run broker-check -- --broker=snssqs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { MESSAGE_CONTRACT_TS, SNSSQS_CONSUMPTION_TS } from '../src/scaffold/messaging.js';
import { DOMAIN_EXCEPTION_TS } from '../src/scaffold/exceptions.js';

const SNSSQS = { broker: 'snssqs' };
const SUBJECT = 'stock-reservation-events';

function spring(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: SNSSQS }).files;
}

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

/** Lo que siembra el init-messaging.sh de keel-spring: cola → { maxReceive, dlq } (o sin DLQ). */
function springQueues(files) {
  const script = content(files, 'infra/init-messaging.sh');
  const queues = new Map();
  for (const [, name, max, dlq] of script.matchAll(/^create_queue_with_dlq '([^']+)' (\d+) '([^']+)'$/gm)) queues.set(name, { maxReceive: Number(max), dlq });
  for (const [, name] of script.matchAll(/^create_queue '([^']+)'$/gm)) if (!queues.has(name)) queues.set(name, { maxReceive: null, dlq: null });
  return queues;
}

test('el consumo: la cola, la DLQ y el maxReceiveCount de cada suscripción son los que siembra keel-spring', async () => {
  const { files } = planFixture(SUBJECT, { stack: SNSSQS });
  const { SNSSQS_CONSUMPTION } = await transpileTree(files).load(SNSSQS_CONSUMPTION_TS);
  const theirs = springQueues(spring(SUBJECT));
  const yaml = parseYaml(content(spring(SUBJECT), 'parameters/local/messaging.yaml')).messaging.subscriptions;
  assert.equal(SNSSQS_CONSUMPTION.length, Object.keys(yaml).length);
  for (const entry of SNSSQS_CONSUMPTION) {
    assert.ok(Object.values(yaml).some((sub) => sub.queue === entry.queue), `${entry.subscription}: su cola ${entry.queue} es la del messaging.yaml de keel-spring`);
    const seeded = theirs.get(entry.queue);
    assert.ok(seeded, `${entry.subscription}: init-messaging.sh siembra ${entry.queue}`);
    assert.equal(entry.deadLetterQueue, seeded.dlq, `${entry.subscription}: su DLQ`);
    if (seeded.dlq) assert.equal(entry.maxReceive, seeded.maxReceive, `${entry.subscription}: su maxReceiveCount`);
  }
});

test('el reintento: la visibilidad sigue la curva del diseño (×2, con techo, al segundo), y lo no reintentable no se reintenta', async () => {
  const { files, model } = planFixture(SUBJECT, { stack: SNSSQS });
  const tree = transpileTree(files);
  const { SNSSQS_CONSUMPTION, retryVisibilitySeconds, isRetryable } = await tree.load(SNSSQS_CONSUMPTION_TS);
  const entry = SNSSQS_CONSUMPTION.find((candidate) => candidate.subscription === 'StockReserved');
  const retry = model.subscriptions.find((sub) => sub.name === 'StockReserved').retry;
  assert.equal(retryVisibilitySeconds(entry, 1), Math.ceil(retry.initialDelayMs / 1000));
  // La cuarta recepción: ×8. Las anteriores redondean al mismo segundo con otro multiplicador (500 ms ×4 y ×2,25
  // dan los dos 2 s), y una aserción que no distingue la curva no la mide.
  assert.equal(retryVisibilitySeconds(entry, 4), Math.ceil(Math.min(retry.initialDelayMs * 8, retry.maxDelayMs ?? Infinity) / 1000));
  assert.equal(retryVisibilitySeconds(entry, 30), Math.ceil(retry.maxDelayMs / 1000), 'con su techo');
  assert.equal(retryVisibilitySeconds({ ...entry, multiplier: 1 }, 5), Math.ceil(retry.initialDelayMs / 1000), 'con backoff fixed, plano');
  const { DomainException } = await tree.load(DOMAIN_EXCEPTION_TS);
  const { MessageContractViolation } = await tree.load(MESSAGE_CONTRACT_TS);
  class Rejected extends DomainException {}
  assert.equal(isRetryable(new Error('la base no responde')), true);
  assert.equal(isRetryable(new Rejected('regla de negocio')), false);
  assert.equal(isRetryable(new MessageContractViolation('falta un campo')), false);
});

test('messaging.yaml dice lo mismo que el de keel-spring con SNS/SQS, colas incluidas', () => {
  const nest = planFixture(SUBJECT, { stack: SNSSQS }).files;
  const theirs = spring(SUBJECT);
  for (const profile of ['local', 'develop', 'production']) {
    const ours = parseYaml(content(nest, `config/parameters/${profile}/messaging.yaml`));
    const reference = parseYaml(content(theirs, `parameters/${profile}/messaging.yaml`));
    assert.deepEqual(ours.messaging, reference.messaging, `${profile}: publicación y suscripciones`);
  }
});

test('snssqs.yaml usa las mismas variables que keel-spring (región, credenciales, endpoints) y apaga la conexión en test', () => {
  const nest = planFixture(SUBJECT, { stack: SNSSQS }).files;
  const theirs = spring(SUBJECT);
  for (const profile of ['local', 'develop', 'production']) {
    const ours = parseYaml(content(nest, `config/parameters/${profile}/snssqs.yaml`)).aws;
    const reference = parseYaml(content(theirs, `parameters/${profile}/snssqs.yaml`)).spring.cloud.aws;
    assert.equal(String(ours.region), String(reference.region.static), `${profile}: región`);
    assert.equal(String(ours.credentials['access-key']), String(reference.credentials['access-key']), `${profile}: access-key`);
    assert.equal(String(ours.credentials['secret-key']), String(reference.credentials['secret-key']), `${profile}: secret-key`);
    assert.equal(String(ours.sns?.endpoint), String(reference.sns?.endpoint), `${profile}: endpoint de SNS`);
    assert.equal(String(ours.sqs?.endpoint), String(reference.sqs?.endpoint), `${profile}: endpoint de SQS`);
  }
  assert.equal(parseYaml(content(nest, 'config/parameters/test/snssqs.yaml')).aws.enabled, false);
});

test('init-messaging.sh es el de keel-spring salvo las líneas que nombran a cada generador', () => {
  const ours = content(planFixture(SUBJECT, { stack: SNSSQS }).files, 'infra/init-messaging.sh').split('\n');
  const theirs = content(spring(SUBJECT), 'infra/init-messaging.sh').split('\n');
  assert.equal(ours.length, theirs.length);
  const differing = ours.filter((line, index) => line !== theirs[index]);
  assert.ok(differing.length <= 5, `solo los textos de cada generador: ${differing.join(' | ')}`);
  for (const line of differing) assert.match(line, /^#/, `solo comentarios: ${line}`);
});

test('el agente lee un listener por suscripción sobre su cola, y que la DLQ y la visibilidad ya las pone build', () => {
  const { files, model } = planFixture(SUBJECT, { stack: SNSSQS });
  const bindings = content(files, 'src/infrastructure/messaging/broker-bindings.ts');
  for (const sub of model.subscriptions) {
    const queue = `${model.service.artifactId}-${sub.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
    assert.ok(bindings.includes(`uno para la cola ${queue} (${sub.name})`), `${sub.name} en broker-bindings`);
    const message = content(files, `subscriptions/${sub.messageRecord.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.ts`);
    if (sub.deadLetter) assert.ok(message.includes(`${queue}-dlq por la RedrivePolicy`), `${sub.messageRecord}: su DLQ`);
  }
});

test('el proyecto SNS/SQS trae los clientes de AWS, su skill, init-messaging.sh y el arnés con la resiembra', () => {
  const { files } = planFixture(SUBJECT, { stack: SNSSQS });
  const pkg = JSON.parse(content(files, 'package.json'));
  assert.ok(pkg.dependencies['@aws-sdk/client-sns']);
  assert.ok(pkg.dependencies['@aws-sdk/client-sqs']);
  assert.equal(pkg.dependencies.amqplib, undefined);
  assert.ok(files.some((file) => file.path.includes('keel-nest-snssqs/SKILL.md')));
  assert.ok(files.some((file) => file.path === 'infra/init-messaging.sh'));
  const flow = content(files, 'test/integration/support/flow.ts');
  assert.match(flow, /async function reseedTopology\(\)/);
  assert.match(flow, /async function awaitTopologyWired\(\)/);
  assert.match(flow, /currentApp\?\.get\(SnsSqsConnection\)/);
  assert.match(content(files, 'infra/validate-infra.sh'), /sqs get-queue-url --queue-name/);
});
