// DSL 2.33 en keel-nest (inc. 6a de PLAN-CORRIDAS-GELSA.md), lo mismo que keel-spring en su inc. 5:
//   · D2: el umbral de silencio de una reconciliación enlazado a un service.parameters (`unansweredAfter`). Se lee de
//     la propiedad del parámetro en segundos —la forma de `stalledAfter`— y ningún yaml emite `unanswered-after-seconds`:
//     con las dos, el servicio tendría dos umbrales para la misma espera (corrida order de prueba-gelsa). Se EJECUTA el
//     lector de la configuración emitido, sobre el reclamo de stock-reservation y el barrido de pagos de payment-checkout.
//   · D7: la nota del handler de guardar un medio dice dónde va el resumen de la tarjeta, con los nombres de keel-nest.
//     Lo que el adaptador LEE de la respuesta lo ejecuta test/payments.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const MINUTES = { type: 'int', description: 'Minutos de silencio tolerados.', default: 30, testValue: 1, requiredInProduction: false };

function plan(fixture, mutate, stack = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(manifest, layers);
  const files = planService({ manifest, layers, workspace: FIXTURES_DIR, stack })
    .files.filter((f) => typeof f.content === 'string')
    .map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
  return { manifest, layers, files, read: (suffix) => files.filter((f) => f.path.endsWith(suffix)).map((f) => f.content).join('\n') };
}

const configuration = (values) => ({ get: (key) => values[key] });

const linkedReservation = (manifest, layers) => {
  manifest.parameters.reserveSilenceMinutes = MINUTES;
  const activation = layers.dependencies.dependencies.inventory.activations.reserveStock;
  delete activation.unansweredAfterSeconds;
  activation.unansweredAfter = { parameter: 'reserveSilenceMinutes', unit: 'minutes' };
};

const linkedSweep = (manifest, layers) => {
  manifest.parameters.sweepSilenceMinutes = MINUTES;
  delete layers.payments.reconciliation.unansweredAfterSeconds;
  layers.payments.reconciliation.unansweredAfter = { parameter: 'sweepSilenceMinutes', unit: 'minutes' };
};

test('el reclamo de reconciliación lee el parámetro en segundos, sin default propio, y reconciliation.yaml no emite la clave', async () => {
  const { manifest, layers, files } = plan('stock-reservation', linkedReservation);
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], 'keel-nest lo genera');
  const yamls = files.filter((f) => /parameters\/[^/]+\/reconciliation\.yaml$/.test(f.path));
  assert.ok(yamls.length > 0);
  for (const { path: file, content } of yamls) assert.doesNotMatch(content, /unanswered-after-seconds/, file);
  const settings = files.find((f) => f.path.endsWith('reconciliation-settings.ts'));
  const key = settings.content.match(/linked\(configuration, '([^']+)', 60\)/)?.[1];
  assert.ok(key?.endsWith('.reserve-silence-minutes'), String(key));
  const { reconciliationSettings } = await transpileTree(files).load(settings.path);
  assert.equal(reconciliationSettings(configuration({ [key]: '3' })).reserveStock.unansweredAfterSeconds, 180);
  assert.throws(() => reconciliationSettings(configuration({})), /es obligatorio/, 'sin el parámetro no arranca: no hay otro umbral');
});

test('sin el enlace nada cambia: la clave propia con el default del diseño', async () => {
  const { files } = plan('stock-reservation');
  const settings = files.find((f) => f.path.endsWith('reconciliation-settings.ts'));
  assert.doesNotMatch(settings.content, /function linked/);
  const { reconciliationSettings } = await transpileTree(files).load(settings.path);
  assert.equal(reconciliationSettings(configuration({})).reserveStock.unansweredAfterSeconds, 1800);
});

test('el barrido de pagos lee el parámetro en segundos y payments.yaml no emite la clave', async () => {
  const { manifest, layers, files } = plan('payment-checkout', linkedSweep, { paymentGateway: 'stripe', broker: 'rabbitmq' });
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  for (const { path: file, content } of files.filter((f) => /parameters\/[^/]+\/payments\.yaml$/.test(f.path))) {
    assert.doesNotMatch(content, /unanswered-after-seconds/, file);
  }
  const settings = files.find((f) => f.path.endsWith('payment-gateway-settings.ts'));
  const key = settings.content.match(/linked\(configuration, '([^']+)', 60\)/)?.[1];
  assert.ok(key?.endsWith('.sweep-silence-minutes'), String(key));
  const { paymentGatewaySettings } = await transpileTree(files).load(settings.path);
  const base = { 'payments.gateway.base-url': 'http://x', 'payments.gateway.api-key': 'k', 'payments.gateway.webhook-secret': 'w' };
  assert.equal(paymentGatewaySettings(configuration({ ...base, [key]: '2' })).unansweredAfterSeconds, 120);
  assert.throws(() => paymentGatewaySettings(configuration(base)), /es obligatorio/);
});

test('la nota de guardar un medio nombra los tipos de keel-nest y el campo de cardDetails', () => {
  const { manifest, layers, read } = plan(
    'payment-checkout',
    (_manifest, l) => {
      l.domain.types.SavedCardSummary = {
        description: 'Resumen visible de la tarjeta guardada.',
        fields: { brand: { type: 'string', required: true, constraints: { maxLength: 30 } }, last4: { type: 'string', required: true, constraints: { pattern: '^[0-9]{4}$' } } }
      };
      l.domain.entities.SavedPaymentMethod.fields.card = { type: 'SavedCardSummary', required: true };
      l.payments.savePaymentMethod.cardDetails = 'card';
    },
    { paymentGateway: 'stripe', broker: 'rabbitmq' }
  );
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  const handler = read(`${layers.payments.savePaymentMethod.operation.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-command-handler.ts`).replace(/\s*\n\s*(\*\s*)?/g, ' ');
  assert.match(handler, /GUARDAR EL MEDIO: la pasarela devuelve SavedPaymentMethod/);
  assert.match(handler, /guárdalo en el campo 'card'/);
  assert.match(handler, /PaymentMethodAuthenticationRequiredException/);
  assert.match(handler, /GatewayRejectedPaymentMethodException/);
});
