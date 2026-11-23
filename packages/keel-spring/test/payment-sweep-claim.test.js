// G11 (corrida payment de prueba-gelsa): el reclamo del barrido de pagos lo genera build. Lo escribía el agente, y un
// `@Modifying` bajo el `@Transactional(readOnly = true)` de clase del adaptador fallaba en ejecución (`claimAwaiting`).
// Es un rescate con varios estados en espera y un solo reloj (`record.awaitingSince`), con el plazo y el lote del
// barrido de pagos, que pasa el handler.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function plan(mutate) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payment-checkout'));
  if (mutate) mutate(layers);
  const { model, files } = planService({ manifest, layers, workspace: FIXTURES_DIR });
  const texts = files.filter((f) => typeof f.content === 'string').map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
  return { model, read: (suffix) => texts.filter((f) => f.path.endsWith(suffix)).map((f) => f.content).join('\n') };
}

const flat = (text) => text.replace(/\s*\n\s*(\*\s*|\/\/\s*)?/g, ' ');

test('relacional: el puerto, las dos consultas con la cota y una transacción propia en el método', () => {
  const { model, read } = plan();
  const states = model.payments.awaitingStates.map((state) => state.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase());
  assert.match(read('/domain/repository/PaymentRepository.java'), /List<Payment> claimForPaymentSweep\(Instant staleBefore, int batchSize\);/);
  const jpa = read('PaymentJpaRepository.java');
  assert.match(jpa, /select e\.id from PaymentJpa e where e\.status in :states and e\.awaitingSince < :staleBefore[^"]* order by e\.awaitingSince asc/);
  assert.match(jpa, /@Modifying\s+@Query\("update PaymentJpa e set e\.awaitingSince = :leasedAt where e\.id = :id and e\.status in :states and e\.awaitingSince < :staleBefore"\)/);
  const impl = read('PaymentRepositoryImpl.java');
  const method = impl.slice(impl.lastIndexOf('/**', impl.indexOf('public List<Payment> claimForPaymentSweep')), impl.indexOf('return claimed;', impl.indexOf('public List<Payment> claimForPaymentSweep')));
  assert.match(method, /@Transactional\(propagation = Propagation\.REQUIRES_NEW[^)]*\)\s+public List<Payment> claimForPaymentSweep/);
  assert.ok(method.includes(`List.of(${states.map((state) => `PaymentStatus.${state}`).join(', ')})`), method);
});

test('documental: un findAndModify por candidato, con la cota y el orden dentro', () => {
  const { read } = plan((layers) => {
    layers.persistence.default.model = 'document';
  });
  const impl = read('PaymentRepositoryImpl.java');
  assert.match(impl, /public List<Payment> claimForPaymentSweep\(Instant staleBefore, int batchSize\) \{/);
  assert.match(impl, /\.and\("awaitingSince"\)\.lt\(staleBefore\)\)\s+\.with\(Sort\.by\(Sort\.Direction\.ASC, "awaitingSince"\)\)/);
  assert.match(impl, /mongoTemplate\.findAndModify\(query, new Update\(\)\.set\("awaitingSince", leasedAt\), options, PaymentDocument\.class\)/);
});

test('el handler del barrido y PaymentReconciliation dicen que el reclamo ya está generado', () => {
  const { read } = plan();
  const note = flat(read('/SweepPendingPaymentsCommandHandler.java'));
  assert.match(note, /paymentRepository\.claimForPaymentSweep\(paymentReconciliation\.staleBefore\(Instant\.now\(\)\), paymentReconciliation\.batchSize\(\)\)/);
  assert.match(note, /No escribas otro reclamo/);
  assert.match(flat(read('/PaymentReconciliation.java')), /PaymentRepository\.claimForPaymentSweep\(staleBefore\(now\), batchSize\(\)\)\}, que build ya generó/);
});

test('claim-check lo reconoce como sujeto y lo ejecuta con sus seis casos', async () => {
  const { claimScenarios, claimTestClass, PAYMENT_SWEEP_SABOTAGE_CASES } = await import('../src/lib/claim-probes.js');
  const { model } = plan();
  model.stack = { database: 'postgresql', paymentGateway: 'stripe' };
  const scenarios = claimScenarios(model);
  assert.equal(scenarios.paymentSweep?.method, 'claimForPaymentSweep');
  assert.equal(scenarios.entity.name, 'Payment');
  const packages = { enums: 'x.enums', port: 'x.port', entities: 'x.entities', repositories: 'x.repositories' };
  const java = claimTestClass(model, scenarios, { datasource: { url: 'jdbc:postgresql://h/db', username: 'u' }, packages, database: 'postgresql' });
  const cases = [...java.matchAll(/void (elBarridoDePagos\w+|unCobroEnEspera\w+)\(\)/g)].map((match) => match[1]);
  assert.equal(cases.length, 6, cases.join(', '));
  for (const expected of Object.values(PAYMENT_SWEEP_SABOTAGE_CASES).flat()) assert.ok(cases.includes(expected), expected);
});
