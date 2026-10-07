// El reintento del consumidor de Kafka (keel-core/gen/dead-letter.js, kafkaListenerRetry): lo que tienen
// que hacer igual keel-spring (DeadLetterConfig) y keel-nest (kafka-consumption.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kafkaListenerRetry } from '../src/lib/gen/dead-letter.js';

const sub = (name, topic, extra = {}) => ({ name, topicDefault: topic, ...extra });

test('sin descarte declarado rige el DefaultErrorHandler por defecto de Spring Kafka: diez intentos sin espera', () => {
  const retry = kafkaListenerRetry({ subscriptions: [sub('A', 'src.events', { retry: { maxAttempts: 3, initialDelayMs: 500 } })] });
  assert.deepEqual(retry, { attempts: 10, initialMs: 0, multiplier: 1.0, maxDelayMs: null, deadLetteredTopics: [] });
});

test('la curva sale SOLO de las suscripciones con descarte, y gana la más paciente', () => {
  const retry = kafkaListenerRetry({
    subscriptions: [
      sub('A', 'src.events', { deadLetter: true, retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 4000 } }),
      sub('B', 'src.events', { deadLetter: true, retry: { maxAttempts: 5, initialDelayMs: 200 } }),
      // Sin descarte: su retry no cuenta, como en DeadLetterConfig.
      sub('C', 'other.events', { retry: { maxAttempts: 9, initialDelayMs: 9000 } })
    ]
  });
  assert.equal(retry.attempts, 5);
  assert.equal(retry.initialMs, 500);
  assert.equal(retry.multiplier, 1.5);
  assert.equal(retry.maxDelayMs, 4000);
  // Por TOPIC: A y B comparten el de su fuente.
  assert.deepEqual(retry.deadLetteredTopics, ['src.events']);
});

test('con backoff fixed no hay curva ni techo', () => {
  const retry = kafkaListenerRetry({ subscriptions: [sub('A', 'src.events', { deadLetter: true, retry: { maxAttempts: 4, initialDelayMs: 300, backoff: 'fixed' } })] });
  assert.equal(retry.multiplier, 1.0);
  assert.equal(retry.maxDelayMs, null);
});

test('exponential sin maxDelayMs toma el techo de ExponentialBackOff (30 s)', () => {
  const retry = kafkaListenerRetry({ subscriptions: [sub('A', 'src.events', { deadLetter: true, retry: { maxAttempts: 4 } })] });
  assert.equal(retry.maxDelayMs, 30000);
  assert.equal(retry.initialMs, 1000);
});
