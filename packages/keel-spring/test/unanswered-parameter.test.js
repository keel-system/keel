// DSL 2.33, D2 (corrida order de prueba-gelsa): el umbral de silencio de una reconciliación enlazado a un
// service.parameters (`unansweredAfter`). keel-spring lo lee de la propiedad del parámetro en segundos —la forma de
// `stalledAfter`— y deja de emitir `unanswered-after-seconds`: con las dos, el servicio tendría dos umbrales para la
// misma espera y el agente leería uno. Siluetas: el reclamo que build genera en stock-reservation, el barrido que
// escribe el agente en catalog-extended y el de pagos de payment-checkout, con el umbral pasado a un parámetro.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const MINUTES = { type: 'int', description: 'Minutos de silencio tolerados.', default: 30, testValue: 1, requiredInProduction: false };

function plan(fixture, mutate) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(manifest, layers);
  const files = planService({ manifest, layers, workspace: FIXTURES_DIR })
    .files.filter((f) => typeof f.content === 'string')
    .map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
  return { manifest, layers, files, read: (suffix) => files.filter((f) => f.path.endsWith(suffix)).map((f) => f.content).join('\n') };
}

const flat = (text) => text.replace(/\s*\n\s*(\*\s*|\/\/\s*)?/g, ' ');

const linkedReservation = (manifest, layers) => {
  manifest.parameters.reserveSilenceMinutes = MINUTES;
  const activation = layers.dependencies.dependencies.inventory.activations.reserveStock;
  delete activation.unansweredAfterSeconds;
  activation.unansweredAfter = { parameter: 'reserveSilenceMinutes', unit: 'minutes' };
};

const linkedWithdrawal = (manifest, layers) => {
  manifest.parameters = { ...(manifest.parameters ?? {}), withdrawalSilenceMinutes: MINUTES };
  const activation = layers.dependencies.dependencies.compliance.activations.recordWithdrawal;
  delete activation.unansweredAfterSeconds;
  activation.unansweredAfter = { parameter: 'withdrawalSilenceMinutes', unit: 'minutes' };
};

test('el reclamo de reconciliación lee el parámetro en segundos y reconciliation.yaml no emite la clave', () => {
  const { manifest, layers, files, read } = plan('stock-reservation', linkedReservation);
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], 'keel-spring lo genera');
  const yamls = files.filter((f) => /parameters\/[^/]+\/reconciliation\.yaml$/.test(f.path));
  assert.ok(yamls.length > 0);
  for (const { path: file, content } of yamls) {
    const start = content.indexOf('  reserve-stock:');
    const block = content.slice(start, content.indexOf('batch-size', start));
    assert.doesNotMatch(block, /unanswered-after-seconds/, file);
    assert.match(block, /reserveSilenceMinutes \(en minutes\)/, file);
  }
  const value = read('RepositoryImpl.java').match(/@Value\("#\{\$\{([^}]+)\} \* 60\}"\)\s+private long reserveStockUnansweredAfterSeconds;/);
  assert.ok(value, 'el adaptador lee la propiedad del parámetro por 60');
  assert.match(value[1], /reserve-silence-minutes$/);
});

// El gate del umbral (`idempotency-check.js`) y la nota del barrido (`services.js`) solo se emiten para un barrido que
// escribe el agente, y en las fixtures todos los reclamos los genera build: esa rama del enlace no tiene sujeto todavía.
test('el javadoc del reclamo nombra el parámetro, no una clave que ya no existe', () => {
  const { manifest, layers, read } = plan('catalog-extended', linkedWithdrawal);
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  assert.match(flat(read('/ProductRepository.java')), /el umbral es el parámetro \{@code withdrawalSilenceMinutes\}, en minutes/);
  assert.doesNotMatch(read('infra/check-idempotency.sh'), /record-withdrawal\[\.\]unanswered-after-seconds/);
});

test('sin el enlace nada cambia: la clave propia y su @Value', () => {
  const { read } = plan('stock-reservation');
  assert.match(read('parameters/production/reconciliation.yaml'), /reserve-stock:\n[^\n]*\n[^\n]*\n\s+unanswered-after-seconds: /);
  assert.match(read('RepositoryImpl.java'), /@Value\("\$\{reconciliation\.reserve-stock\.unanswered-after-seconds:1800\}"\)/);
});

test('el barrido de pagos lee el parámetro en segundos y payments.yaml no emite la clave', () => {
  const { manifest, layers, files, read } = plan('payment-checkout', (m, l) => {
    m.parameters.sweepSilenceMinutes = MINUTES;
    delete l.payments.reconciliation.unansweredAfterSeconds;
    l.payments.reconciliation.unansweredAfter = { parameter: 'sweepSilenceMinutes', unit: 'minutes' };
  });
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  const yamls = files.filter((f) => /parameters\/[^/]+\/payments\.yaml$/.test(f.path));
  assert.ok(yamls.length > 0);
  for (const { path: file, content } of yamls) assert.doesNotMatch(content, /unanswered-after-seconds/, file);
  assert.match(read('/PaymentReconciliation.java'), /@Value\("#\{\$\{[^}]+sweep-silence-minutes\} \* 60\}"\) long unansweredAfterSeconds,/);
});
