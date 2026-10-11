// Dónde se reintenta el «no existe» de una suscripción (keel-core/gen/dead-letter.js): lo que tienen que hacer
// igual keel-spring (RETRIES_NOT_FOUND) y keel-nest (retriesNotFound en cada entrada de consumo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retriesMissingTarget, missingTargetRetryDestinations } from '../src/lib/gen/dead-letter.js';

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
