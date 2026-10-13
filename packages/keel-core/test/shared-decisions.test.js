// Las decisiones que keel-spring y keel-nest tenían copiadas y que pasaron a keel-core/gen en el incremento 1d
// de PLAN-KEEL-DOTNET.md. Los dos generadores salen idénticos con ellas (sus líneas base lo miden sobre todas
// las fixtures); esto fija cada regla por su cuenta, también en las ramas que ninguna fixture recorre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_BASES, errorBaseFor, DOMAIN_EXCEPTION } from '../src/lib/gen/error-bases.js';
import { usesClusterScenarios } from '../src/lib/gen/cluster-scenarios.js';
import { hasCallFallback } from '../src/lib/gen/outbound-resilience.js';
import { occurredAtField } from '../src/lib/gen/replica.js';
import { needsReadCommitted, DATABASES } from '../src/lib/gen/infra-catalog.js';
import { MAIL_AWAIT, mailAwaitSeconds } from '../src/lib/gen/mail-probes.js';
import { HTML_ESCAPES, RESERVED_MAIL_HEADERS, MAIL_HEADER_NAME_CLASS } from '../src/lib/gen/mail-message.js';

test('cada status con clase base propia la tiene, y el resto cae en la raíz', () => {
  for (const { name, http } of ERROR_BASES) assert.equal(errorBaseFor(http), name);
  assert.equal(errorBaseFor(429), DOMAIN_EXCEPTION);
  assert.equal(new Set(ERROR_BASES.map((base) => base.http)).size, ERROR_BASES.length);
});

const operation = (extra = {}) => ({ name: 'op', ...extra });
const model = ({ operations = [], ...rest } = {}) => ({ services: [{ operations }], layersPresent: {}, ...rest });

test('escenarios de clúster: outbox, un barrido por reloj o el registro de idempotencia, y nada más', () => {
  assert.equal(usesClusterScenarios(model()), false);
  assert.equal(usesClusterScenarios(model({ operations: [operation({ schedule: { cron: '*/5 * * * *' } })] })), true);
  assert.equal(usesClusterScenarios(model({ operations: [operation({ idempotency: { keySource: 'client-key' } })] })), true);
  // La clave natural ES la guarda: no hay registro que repartir entre réplicas.
  assert.equal(usesClusterScenarios(model({ operations: [operation({ idempotency: { guard: 'natural-key' } })] })), false);
  const outbox = model({ layersPresent: { messaging: true, persistence: true }, messaging: { reliability: 'outbox' }, events: [{ name: 'E' }] });
  assert.equal(usesClusterScenarios(outbox), true);
  // Suscripciones con persistencia y nada más: la purga de processed_event es limpieza, no una garantía.
  const onlySubscriptions = model({ layersPresent: { messaging: true, persistence: true }, messaging: { reliability: 'best-effort', subscriptions: [{}] } });
  assert.equal(usesClusterScenarios(onlySubscriptions), false);
});

test('el fallback de una llamada necesita una razón y algo que lo dispare', () => {
  assert.equal(hasCallFallback({ fallback: 'cached', retry: { maxAttempts: 3 } }), true);
  assert.equal(hasCallFallback({ circuitBreaker: {} }), true);
  assert.equal(hasCallFallback({ needs: [{ need: { onUnavailable: { action: 'fail' } } }], retry: {} }), true);
  assert.equal(hasCallFallback({ fallback: 'cached' }), false, 'sin retry ni circuito nadie lo llamaría');
  assert.equal(hasCallFallback({ retry: {} }), false, 'sin razón no hay nada que devolver');
});

test('el instante del hecho de una réplica, por su nombre', () => {
  const entity = (...names) => ({ fields: names.map((name) => ({ name })) });
  assert.equal(occurredAtField(entity('id', 'eventTime')).name, 'eventTime');
  assert.equal(occurredAtField(entity('id', 'createdAt')), null, 'cuándo nació la fila no es cuándo pasó el hecho');
});

test('solo los motores con gap locks por defecto fijan READ COMMITTED en el reclamo', () => {
  assert.deepEqual(Object.keys(DATABASES).filter(needsReadCommitted).sort(), ['mariadb', 'mysql']);
});

test('la espera del buzón: el suelo sin barrido, el periodo más el margen con él, y nunca más que el techo', () => {
  const sentBy = (schedule) => ({
    mail: { sentBy: ['send'] },
    services: [{ operations: [{ name: 'send', ...(schedule ? { schedule: { cron: schedule } } : {}) }] }]
  });
  assert.deepEqual(mailAwaitSeconds(sentBy(null)), { seconds: MAIL_AWAIT.floorSeconds, period: null });
  // El cron del DSL tiene cinco campos, sin segundos.
  assert.deepEqual(mailAwaitSeconds(sentBy('*/2 * * * *')), { seconds: 120 + MAIL_AWAIT.marginSeconds, period: 120 });
  assert.equal(mailAwaitSeconds(sentBy('0 * * * *')).seconds, MAIL_AWAIT.capSeconds);
});

test('las defensas del correo: el & se escapa primero y las cabeceras reservadas van en minúsculas', () => {
  assert.equal(HTML_ESCAPES[0][0], '&');
  for (const header of RESERVED_MAIL_HEADERS) assert.equal(header, header.toLowerCase());
  const name = new RegExp(`^${MAIL_HEADER_NAME_CLASS}$`);
  assert.ok(name.test('X-Order-Id'));
  assert.ok(!name.test('X Order') && !name.test('X:Order'));
});
