// El reclamo del barrido de pagos (G11 de PLAN-CORRIDAS-GELSA.md, inc. 6b): build lo genera en el puerto y en el
// adaptador del registro de cobros, como keel-spring y keel-nest. Lo que hace contra el motor lo mide db-check
// (`--only=payment-checkout`, casos PS-1 a PS-7 y los sabotajes `payment-sweep-no-lease` y `payment-sweep-cutoff`); aquí,
// la forma de las dos ramas —la documental no tiene sujeto: ninguna fixture lleva pagos sobre MongoDB— y lo que dicen la
// nota del handler y la consulta.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

const read = (files, suffix) => files.filter((file) => file.path.endsWith(suffix)).map((file) => file.content).join('\n');
const flat = (text) => text.replace(/\s*\n\s*(\/\/\/?\s*)?/g, ' ');

for (const database of ['postgresql', 'mysql', 'mongodb']) {
  test(`${database}: el puerto y el adaptador del registro llevan ClaimForPaymentSweep(staleBefore, batchSize)`, async () => {
    const { files } = await planFixture('payment-checkout', { stack: { paymentGateway: 'stripe', broker: 'rabbitmq', database } });
    assert.match(read(files, 'Repository/IPaymentRepository.cs'), /Task<IReadOnlyList<Payment>> ClaimForPaymentSweep\(DateTimeOffset staleBefore, int batchSize, CancellationToken cancellationToken = default\);/);
    const adapter = read(files, 'Repositories/PaymentRepository.cs');
    assert.match(adapter, /RequireOwnTransaction\("ClaimForPaymentSweep"\);/);
    assert.equal((adapter.match(/private void RequireOwnTransaction\(string method\)/g) ?? []).length, 1, 'el ayudante, una sola vez');
    if (database === 'mongodb') {
      assert.match(adapter, /new BsonDocument \{ \{ "status", new BsonDocument\("\$in", new BsonArray \{ "PENDING", [^}]+\}\) \}, \{ "awaiting_since", new BsonDocument\("\$lt", BsonValues\.Of\(staleBefore\)\) \} \}/);
      assert.match(adapter, /new BsonDocument\("\$set", new BsonDocument\("awaiting_since", leasedAt\)\)/);
    } else {
      assert.match(adapter, /FOR UPDATE SKIP LOCKED/);
      assert.match(adapter, /UPDATE payments SET awaiting_since = \{leasedAt\} WHERE id = \{id\} AND status IN \([^)]+\) AND awaiting_since < \{staleBefore\}/);
      assert.match(adapter, /PersistenceTransactions\.ClaimIsolation\);/);
    }
    assert.match(adapter, /SweepPass\.Claimed\(/, 'con el cronómetro, el reclamo avisa del lote lleno');
  });
}

test('la nota del barrido y la consulta dicen que el reclamo ya está generado', async () => {
  const { files } = await planFixture('payment-checkout', { stack: { paymentGateway: 'stripe', broker: 'rabbitmq' } });
  assert.match(flat(read(files, 'SweepPendingPaymentsCommandHandler.cs')), /BARRIDO DE PAGOS: los candidatos ya RECLAMADOS los da await paymentRepository\.ClaimForPaymentSweep\(/);
  const reconciliation = flat(read(files, 'Payment/PaymentReconciliation.cs'));
  assert.match(reconciliation, /IPaymentRepository\.ClaimForPaymentSweep\(StaleBefore\(now\), BatchSize\(\), …\)<\/c>, que build ya generó/);
  assert.doesNotMatch(reconciliation, /el handler reclama cada uno/);
});

test('sin capa payments no hay reclamo del barrido de pagos', async () => {
  const { files } = await planFixture('stock-reservation');
  assert.ok(files.every((file) => typeof file.content !== 'string' || !file.content.includes('ClaimForPaymentSweep')));
});
