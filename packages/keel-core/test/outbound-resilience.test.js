// La resiliencia saliente como datos (keel-core/gen/outbound-resilience.js): la tabla de los fallos del
// proveedor y la política de una llamada. Los dos generadores la proyectan; aquí se fijan sus invariantes,
// que son los que hacen que el fallback, el circuito y el retry digan lo mismo del mismo suceso.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_ON,
  PROVIDER_FAILURES,
  RESILIENCE_DEFAULTS,
  fallbackFailures,
  neverRetriedFailures,
  recordedFailures,
  resiliencePolicy,
  retriedFailures,
  retryWaitMs
} from '../src/lib/gen/outbound-resilience.js';

const kinds = (failures) => failures.map((failure) => failure.kind);

test('el fallback atiende siempre DOS o más fallos, y el circuito abierto y el token solo cuando existen', () => {
  assert.deepEqual(kinds(fallbackFailures()), ['transport', 'server-error', 'unknown-status', 'client-error']);
  assert.deepEqual(kinds(fallbackFailures({ circuitBreaker: true }))[0], 'circuit-open');
  assert.ok(kinds(fallbackFailures({ oauth2: true })).includes('auth-grant'));
  assert.ok(!kinds(fallbackFailures()).includes('auth-grant'));
  for (const options of [{}, { circuitBreaker: true }, { oauth2: true }, { circuitBreaker: true, oauth2: true }]) {
    assert.ok(fallbackFailures(options).length >= 2, JSON.stringify(options));
  }
});

test('el circuito cuenta solo lo que describe la salud del proveedor: ni el 4xx, ni su propia apertura, ni el token', () => {
  assert.deepEqual(kinds(recordedFailures()), ['transport', 'server-error', 'unknown-status']);
  for (const kind of ['client-error', 'circuit-open', 'auth-grant']) {
    assert.ok(!kinds(recordedFailures()).includes(kind), kind);
  }
  // Todo lo que el circuito cuenta, el fallback lo atiende: si no, el circuito se abriría por fallos que nadie traduce.
  const handled = kinds(fallbackFailures({ circuitBreaker: true }));
  for (const kind of kinds(recordedFailures())) assert.ok(handled.includes(kind), kind);
});

test('el 4xx es un rechazo, entra al fallback y nunca se reintenta', () => {
  assert.equal(PROVIDER_FAILURES.clientError.rejection, true);
  assert.deepEqual(kinds(neverRetriedFailures()), ['client-error']);
  for (const retryOn of [DEFAULT_RETRY_ON, ['5xx'], ['timeout'], ['connection'], ['timeout', 'connection']]) {
    assert.ok(!kinds(retriedFailures(retryOn)).includes('client-error'), retryOn.join(','));
  }
});

test('retryOn: timeout y connection son el mismo fallo del transporte; 5xx es el del servidor', () => {
  assert.deepEqual(kinds(retriedFailures()), ['server-error', 'transport']);
  assert.deepEqual(kinds(retriedFailures(['5xx'])), ['server-error']);
  assert.deepEqual(kinds(retriedFailures(['timeout'])), ['transport']);
  assert.deepEqual(kinds(retriedFailures(['connection', 'timeout'])), ['transport']);
});

test('resiliencePolicy: los defaults donde el diseño calla, y null donde no declara el mecanismo', () => {
  const bare = resiliencePolicy({ instanceName: 'inventory-cancel-stock' });
  assert.deepEqual(bare, {
    instance: 'inventory-cancel-stock',
    timeoutMs: RESILIENCE_DEFAULTS.timeoutMs,
    retry: null,
    circuitBreaker: null,
    fallback: null
  });

  const full = resiliencePolicy({
    instanceName: 'x',
    timeoutMs: 2000,
    retry: { maxAttempts: 3 },
    circuitBreaker: {},
    fallback: { onFailure: 'throw' }
  });
  assert.deepEqual(full.retry, {
    maxAttempts: 3,
    backoff: 'exponential',
    initialDelayMs: 500,
    multiplier: 2,
    maxDelayMs: null,
    retries: ['server-error', 'transport']
  });
  assert.deepEqual(full.circuitBreaker, {
    failureRateThreshold: 50,
    slidingWindowSize: 20,
    waitDurationMs: 30000,
    records: ['transport', 'server-error', 'unknown-status']
  });
  assert.equal(full.timeoutMs, 2000);
});

test('resiliencePolicy: con backoff fijo no hay multiplicador ni techo, aunque el diseño escriba maxDelayMs', () => {
  const { retry } = resiliencePolicy({ instanceName: 'x', retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 100, maxDelayMs: 900 } });
  assert.equal(retry.multiplier, null);
  assert.equal(retry.maxDelayMs, null);
});

test('retryWaitMs: la referencia ejecutable de la espera entre intentos', () => {
  const exponential = resiliencePolicy({ instanceName: 'x', retry: { maxAttempts: 5, initialDelayMs: 200, maxDelayMs: 1000 } }).retry;
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryWaitMs(n, exponential)), [200, 400, 800, 1000, 1000]);
  const unbounded = resiliencePolicy({ instanceName: 'x', retry: { maxAttempts: 4 } }).retry;
  assert.deepEqual([1, 2, 3].map((n) => retryWaitMs(n, unbounded)), [500, 1000, 2000]);
  const fixed = resiliencePolicy({ instanceName: 'x', retry: { maxAttempts: 3, backoff: 'fixed', initialDelayMs: 300 } }).retry;
  assert.deepEqual([1, 2, 3].map((n) => retryWaitMs(n, fixed)), [300, 300, 300]);
});
