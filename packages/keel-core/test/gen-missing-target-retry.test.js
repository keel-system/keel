// Dónde se reintenta el «no existe» de una suscripción (keel-core/gen/dead-letter.js): lo que tienen que hacer
// igual keel-spring (RETRIES_NOT_FOUND) y keel-nest (retriesNotFound en cada entrada de consumo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retriesMissingTarget, missingTargetRetryDestinations, subscriptionDestination } from '../src/lib/gen/dead-letter.js';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

const RETRY = { maxAttempts: 5, initialDelayMs: 500 };
const sub = (name, topic, extra = {}) => ({ name, topicDefault: topic, queueDefault: `svc.${topic}`, ...extra });
const model = (subscriptions) => ({ service: { artifactId: 'svc' }, subscriptions });

test('solo con guarda de dominio y un retry declarado', () => {
  assert.equal(retriesMissingTarget(sub('A', 't', { triggerHasDomainGuard: true, retry: RETRY })), true);
  // tryRecord: el primer intento ya marcó el evento, y el reintento lo confirmaría sin efecto.
  assert.equal(retriesMissingTarget(sub('A', 't', { triggerHasDomainGuard: false, retry: RETRY })), false);
  // Sin retry, o con un solo intento, no hay reintento que alargar.
  assert.equal(retriesMissingTarget(sub('A', 't', { triggerHasDomainGuard: true })), false);
  assert.equal(retriesMissingTarget(sub('A', 't', { triggerHasDomainGuard: true, retry: { maxAttempts: 1 } })), false);
});

test('por destino: dos suscripciones que lo comparten lo reintentan solo si las dos pueden', () => {
  const subs = [
    sub('Guarded', 'shared', { triggerHasDomainGuard: true, retry: RETRY }),
    sub('Unguarded', 'shared', { triggerHasDomainGuard: false, retry: RETRY }),
    sub('Alone', 'alone', { triggerHasDomainGuard: true, retry: RETRY })
  ];
  assert.deepEqual(missingTargetRetryDestinations(model(subs), 'kafka'), ['alone']);
  assert.deepEqual(missingTargetRetryDestinations(model(subs), 'rabbitmq'), ['svc.alone']);
  // Con SNS/SQS cada suscripción tiene su cola: la guardada no comparte destino con la que no lo está.
  assert.deepEqual(missingTargetRetryDestinations(model(subs), 'snssqs'), ['svc-alone', 'svc-guarded']);
});

test('sin suscripciones, nada', () => {
  assert.deepEqual(missingTargetRetryDestinations(model([]), 'kafka'), []);
});

// DSL 2.24: la operación disparada que declara con OTRO `http` un `code` de la clase 404. La clase la fija la
// primera declaración del servicio; el contrato de ESTA operación es un rechazo a la primera, y reintentarlo
// cinco veces lo contradiría. El caso real es el par del MVP: TEMPLATE_NOT_FOUND es 404 en otra operación y 422
// en acceptNotificationRequest (FL-EVT-002, «al descarte a la primera»).

const guardedModel = (http) => ({
  service: { artifactId: 'svc' },
  errors: [
    {
      code: 'TEMPLATE_NOT_FOUND',
      http: 404,
      statuses: new Map(http === 404 ? [[404, ['getTemplate', 'accept']]] : [[404, ['getTemplate']], [http, ['accept']]])
    }
  ],
  services: [{ operations: [{ name: 'getTemplate', errors: ['TEMPLATE_NOT_FOUND'] }, { name: 'accept', errors: ['TEMPLATE_NOT_FOUND'] }] }],
  subscriptions: [sub('Requested', 'requested', { trigger: 'accept', triggerHasDomainGuard: true, retry: RETRY })]
});

test('un code de la clase 404 que la operación disparada declara con otro http no se reintenta', () => {
  assert.deepEqual(missingTargetRetryDestinations(guardedModel(422), 'kafka'), []);
  assert.equal(retriesMissingTarget(guardedModel(422).subscriptions[0], guardedModel(422)), false);
});

test('si la operación lo declara 404 también, se reintenta como siempre', () => {
  assert.deepEqual(missingTargetRetryDestinations(guardedModel(404), 'kafka'), ['requested']);
});

for (const fixture of ['notification-mailer', 'notification-mailer-mongo']) {
  test(`${fixture}: con la guarda declarada (storedIn), la cola de NotificationRequested no reintenta el «no existe»`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
    const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model) };
    const plain = buildModel({ manifest, layers, stack, projection: PROBE });
    const accept = layers['use-cases'].operations.acceptNotificationRequest;
    const guarded = structuredClone(layers);
    guarded['use-cases'].operations.acceptNotificationRequest.idempotency = accept.idempotency ?? {
      keySource: 'payload-field',
      keyField: 'eventId',
      storedIn: 'dedupeKey'
    };
    const model = buildModel({ manifest, layers: guarded, stack, projection: PROBE });
    const subscription = model.subscriptions.find((candidate) => candidate.trigger === 'acceptNotificationRequest');
    assert.equal(subscription.triggerHasDomainGuard, true);
    assert.equal(subscription.triggerGuardKind, 'natural-key');
    for (const broker of ['rabbitmq', 'kafka', 'snssqs']) {
      const destination = subscriptionDestination(broker, model, subscription);
      assert.ok(!missingTargetRetryDestinations(model, broker).includes(destination), `${broker}: ${destination}`);
      // Sin la guarda no cambia nada: tryRecord ya lo dejaba fuera.
      const before = missingTargetRetryDestinations(plain, broker);
      assert.ok(!before.includes(subscriptionDestination(broker, plain, subscription)), broker);
    }
  });
}
