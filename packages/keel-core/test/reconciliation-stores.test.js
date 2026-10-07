// El almacén del barrido de reconciliación como datos (keel-core/gen/reconciliation-stores.js): la tabla
// del reclamo, su purga, los tres números de cada barrido y la referencia ejecutable de la decisión.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UNANSWERED_AFTER_SECONDS,
  RECONCILIATION_BATCH_SIZE,
  RECONCILIATION_CLAIM,
  RECONCILIATION_PURGE,
  reconciledActivations,
  reconciliationClaimDocumentId,
  reconciliationClaimReference,
  reconciliationClaimTimeoutMs,
  reconciliationClaims,
  reconciliationParameters,
  reconciliationWindow
} from '../src/lib/gen/reconciliation-stores.js';

test('la tabla: clave compuesta (activación, entidad) y el índice de la purga sobre claimed_at', () => {
  assert.equal(RECONCILIATION_CLAIM.table, 'reconciliation_claim');
  assert.deepEqual(
    RECONCILIATION_CLAIM.columns.filter((c) => c.primary).map((c) => c.name),
    ['activation', 'entity_id']
  );
  assert.ok(RECONCILIATION_CLAIM.columns.every((c) => c.nullable === false));
  assert.deepEqual(RECONCILIATION_CLAIM.indexes, [{ name: 'ix_reconciliation_claim_claimed_at', columns: ['claimed_at'] }]);
  assert.equal(reconciliationClaimDocumentId('cancelStock', 'abc'), 'cancelStock|abc');
});

test('la purga tiene clave, variable y default para su reloj y su retención', () => {
  for (const parameter of Object.values(RECONCILIATION_PURGE)) {
    assert.match(parameter.key, /^reconciliation\.purge\./);
    assert.match(parameter.env, /^RECONCILIATION_PURGE_/);
    assert.ok(parameter.default !== undefined);
  }
  assert.equal(RECONCILIATION_PURGE.cron.cron, true);
});

test('los parámetros de un barrido: el umbral del diseño, la caducidad y el lote del generador', () => {
  const activation = { name: 'reserveStock', unansweredAfterSeconds: 1800 };
  const parameters = reconciliationParameters(activation, { schedule: { cron: '*/5 * * * *' } });
  assert.deepEqual(parameters.unansweredAfterSeconds, {
    key: 'reconciliation.reserve-stock.unanswered-after-seconds',
    env: 'RECONCILIATION_RESERVE_STOCK_UNANSWERED_AFTER_SECONDS',
    default: 1800
  });
  assert.equal(parameters.claimTimeoutMs.key, 'reconciliation.reserve-stock.claim-timeout-ms');
  assert.equal(parameters.claimTimeoutMs.default, reconciliationClaimTimeoutMs(activation, { schedule: { cron: '*/5 * * * *' } }));
  assert.deepEqual(parameters.batchSize, {
    key: 'reconciliation.reserve-stock.batch-size',
    env: 'RECONCILIATION_RESERVE_STOCK_BATCH_SIZE',
    default: RECONCILIATION_BATCH_SIZE
  });
  assert.equal(reconciliationParameters({ name: 'x' }, null).unansweredAfterSeconds.default, DEFAULT_UNANSWERED_AFTER_SECONDS);
});

test('la caducidad del reclamo cubre el lote entero y al menos dos ticks del cron', () => {
  // Lote × (timeout × intentos) + margen…
  const slow = { name: 'a', http: { callRef: { timeoutMs: 2000, retry: { maxAttempts: 3 } } } };
  assert.equal(reconciliationClaimTimeoutMs(slow, { schedule: { cron: '* * * * *' } }), 50 * 6000 + 10000);
  // …salvo que dos ticks sean más.
  assert.equal(reconciliationClaimTimeoutMs({ name: 'b' }, { schedule: { cron: '0 3 * * *' } }), 2 * 24 * 3600 * 1000);
});

test('las activaciones con barrido y los reclamos generados se leen del modelo, con la operación que barre', () => {
  const sweep = { name: 'reconcileReservations', reconciles: [{ claim: { activation: 'reserveStock' } }, { claim: null }] };
  const model = {
    services: [{ operations: [sweep, { name: 'other' }] }],
    dependencies: [{ id: 'inventory', activations: [{ name: 'reserveStock', reconciledBy: 'reconcileReservations' }, { name: 'cancelStock' }] }]
  };
  assert.deepEqual(reconciledActivations(model), [
    { dependency: 'inventory', activation: model.dependencies[0].activations[0], sweeper: sweep }
  ]);
  assert.deepEqual(reconciliationClaims(model), [{ activation: 'reserveStock' }]);
  assert.deepEqual(reconciledActivations({}), []);
});

test('la referencia del reclamo: sin marca o con la marca caducada, es mío; viva, de otro', () => {
  const now = new Date('2026-10-07T12:00:00.000Z');
  const { staleBefore, claimExpiredBefore } = reconciliationWindow({ now, unansweredAfterSeconds: 1800, claimTimeoutMs: 60000 });
  assert.equal(staleBefore.toISOString(), '2026-10-07T11:30:00.000Z');
  assert.equal(claimExpiredBefore.toISOString(), '2026-10-07T11:59:00.000Z');
  assert.equal(reconciliationClaimReference(null, claimExpiredBefore), true);
  assert.equal(reconciliationClaimReference(new Date('2026-10-07T11:58:00.000Z'), claimExpiredBefore), true);
  // El mismo `<=` que el UPDATE condicional: justo en el corte, caducada.
  assert.equal(reconciliationClaimReference(claimExpiredBefore, claimExpiredBefore), true);
  assert.equal(reconciliationClaimReference(new Date('2026-10-07T11:59:30.000Z'), claimExpiredBefore), false);
});
