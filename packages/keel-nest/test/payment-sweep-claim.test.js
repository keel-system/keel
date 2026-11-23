// El reclamo del barrido de pagos (G11 de PLAN-CORRIDAS-GELSA.md, inc. 6a): build lo genera en el puerto y en el
// adaptador del registro de cobros, como keel-spring. Lo que hace contra el motor lo mide db-check (`--subject=
// payment-checkout`, casos PS-1 a PS-7, sabotajes `payment-sweep-no-lease` y `payment-sweep-cutoff`); aquí, la forma
// de las dos ramas —la documental no tiene sujeto: ninguna fixture lleva pagos sobre MongoDB— y lo que dicen la nota
// del handler y la consulta.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/emitted.js';
import { checkTree } from './helpers/ts-tree.js';

const read = (files, suffix) => files.filter((file) => file.path.endsWith(suffix)).map((file) => file.content).join('\n');

for (const database of ['postgresql', 'mongodb']) {
  test(`${database}: el puerto y el adaptador del registro llevan claimForPaymentSweep(staleBefore, batchSize)`, () => {
    const { files } = planFixture('payment-checkout', { stack: { paymentGateway: 'stripe', broker: 'rabbitmq', database } });
    assert.deepEqual(checkTree(files), []);
    assert.match(read(files, 'domain/repository/payment-repository.ts'), /abstract claimForPaymentSweep\(staleBefore: Date, batchSize: number\): Promise<Payment\[\]>;/);
    const adapter = read(files, 'payment-repository-impl.ts');
    assert.match(adapter, /async claimForPaymentSweep\(staleBefore: Date, batchSize: number\): Promise<Payment\[\]> \{/);
    if (database === 'mongodb') {
      // Filtrar y renovar en la MISMA operación atómica, el más antiguo primero.
      assert.match(adapter, /findOneAndUpdate\(\s*\{ 'status': \{ \$in: \[[^\]]+\] \}, 'awaiting_since': \{ \$lt: staleBefore \} \},\s*\{ \$set: \{ 'awaiting_since': leasedAt \} \},\s*\{ sort: \{ 'awaiting_since': 1 \}/);
    } else {
      assert.match(adapter, /\.setOnLocked\('skip_locked'\)/);
      assert.match(adapter, /\.set\(\{ awaitingSince: leasedAt \}\)\s*\.where\(states\.map\(\(state\) => \(\{ id, status: state, awaitingSince: LessThan\(staleBefore\) \}\)\)\)/);
    }
    // Con el cronómetro, el reclamo avisa él del lote lleno.
    assert.match(adapter, /SweepPass\.claimed\(/);
  });
}

test('la nota del barrido y la consulta dicen que el reclamo ya está generado', () => {
  const { files, model } = planFixture('payment-checkout', { stack: { paymentGateway: 'stripe', broker: 'rabbitmq' } });
  const sweep = model.payments.reconciliation.sweep.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const handler = read(files, `${sweep}-command-handler.ts`).replace(/\s*\n\s*(\*\s*|\/\/\s*)?/g, ' ');
  assert.match(handler, /BARRIDO DE PAGOS: los candidatos ya RECLAMADOS los da this\.paymentRepository\.claimForPaymentSweep\(/);
  const reconciliation = read(files, 'payment-reconciliation.ts').replace(/\s*\n\s*(\*\s*)?/g, ' ');
  assert.match(reconciliation, /PaymentRepository\.claimForPaymentSweep\(staleBefore\(now\), batchSize\(\)\)`, que build ya generó/);
  assert.doesNotMatch(reconciliation, /el handler reclama cada uno/);
});

test('sin capa payments no hay reclamo del barrido de pagos', () => {
  const { files } = planFixture('stock-reservation');
  assert.ok(files.every((file) => typeof file.content !== 'string' || !file.content.includes('claimForPaymentSweep')));
});
