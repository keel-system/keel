// El reclamo del barrido de pagos (G11 de PLAN-CORRIDAS-GELSA.md, inc. 6c): build lo genera en el puerto y en el
// adaptador del registro de cobros, como los otros tres; antes lo escribía el agente en los `<raíz>_queries.go`. Lo que
// hace contra el motor lo mide db-check (`--only=payment-checkout`, PS1 a PS7, sabotajes `payment-sweep-no-lease` y
// `payment-sweep-cutoff`); aquí, la forma de las ramas —la documental no tiene sujeto: ninguna fixture lleva pagos sobre
// MongoDB—, los ayudantes de claims.go y lo que dicen la nota del handler y la consulta.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function plan(database) {
  const files = planService({ ...loadService(path.join(FIXTURES_DIR, 'payment-checkout')), workspace: FIXTURES_DIR, stack: { paymentGateway: 'stripe', broker: 'rabbitmq', database } }).files;
  return (suffix) => files.filter((file) => file.path.endsWith(suffix)).map((file) => file.content).join('\n');
}

for (const database of ['postgresql', 'mysql', 'mongodb']) {
  test(`${database}: el puerto y el adaptador del registro llevan ClaimForPaymentSweep(ctx, staleBefore, batchSize)`, () => {
    const read = plan(database);
    assert.match(read('internal/domain/payment_repository.go'), /ClaimForPaymentSweep\(ctx context\.Context, staleBefore time\.Time, batchSize int\) \(\[\]\*Payment, error\)/);
    const store = database === 'mongodb' ? 'mongo' : database === 'mysql' ? 'mysql' : 'postgres';
    const adapter = read(`internal/infrastructure/${store}/payment_repository.go`);
    assert.match(adapter, /func \(r \*PaymentRepository\) ClaimForPaymentSweep\(ctx context\.Context, staleBefore time\.Time, batchSize int\) \(\[\]\*domain\.Payment, error\) \{/);
    if (database === 'mongodb') {
      assert.match(adapter, /if openTx\(ctx\) != nil \{\n\t\treturn nil, fmt\.Errorf\("%s confirma por su cuenta/);
      assert.match(adapter, /\{Key: "awaiting_since", Value: bson\.D\{\{Key: "\$lt", Value: instantValue\(staleBefore\)\}\}\}/);
    } else {
      assert.match(adapter, /if err := ownTransaction\(ctx, "ClaimForPaymentSweep"\); err != nil \{/);
      assert.match(adapter, /FOR UPDATE SKIP LOCKED/);
      // Los ayudantes de claims.go se emiten aunque el registro no tenga otro reclamo.
      assert.match(read(`internal/infrastructure/${store}/claims.go`), /func claimCandidates\[ID any\]/);
    }
    assert.match(adapter, /application\.SweepClaimed\(ctx, /, 'con el cronómetro, el reclamo avisa del lote lleno');
  });
}

test('la nota del barrido y la consulta dicen que el reclamo ya está generado', () => {
  const read = plan('postgresql');
  const handler = read('sweep_pending_payments_command_handler.go').replace(/\s*\n\s*\/\/\s*/g, ' ');
  assert.match(handler, /BARRIDO DE PAGOS: los candidatos ya RECLAMADOS los da h\.paymentRepository\.ClaimForPaymentSweep\(ctx, /);
  const outcomes = read('internal/application/payment_outcomes.go').replace(/\s*\n\s*\/\/\s*/g, ' ');
  assert.match(outcomes, /PaymentRepository\.ClaimForPaymentSweep\(ctx, StaleBefore\(now\), BatchSize\(\)\), que build ya generó/);
  assert.doesNotMatch(outcomes, /el handler reclama cada uno/);
});
