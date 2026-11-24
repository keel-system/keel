// DSL 2.33 (PLAN-CORRIDAS-GELSA.md): el umbral de silencio enlazado a un parámetro (activations.*.unansweredAfter y
// reconciliation.unansweredAfter) se lee de la propiedad del parámetro en segundos, sin clave propia en los yaml; y la nota
// de guardar un medio dice dónde va el resumen de la tarjeta (savePaymentMethod.cardDetails). Lo declaran las fixtures
// stock-reservation y payment-checkout, así que cs-check las compila con las demás.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

test('stock-reservation: el reclamo de reconciliación lee el parámetro (activations.*.unansweredAfter)', async () => {
  const { files } = await planFixture('stock-reservation');
  const settings = files.find((file) => file.path.endsWith('ReconciliationSettings.cs'));
  assert.match(settings.content, /Linked\(configuration, "[^"]+:reserve-stock-silence-minutes", 60, 30\)/);
  for (const file of files.filter((candidate) => /parameters\/[^/]+\/reconciliation\.yaml$/.test(candidate.path))) assert.doesNotMatch(file.content, /unanswered-after-seconds/, file.path);
});

test('payment-checkout: el barrido lee el parámetro (reconciliation.unansweredAfter) y la nota guarda la tarjeta (savePaymentMethod.cardDetails)', async () => {
  const { files } = await planFixture('payment-checkout', { stack: { paymentGateway: 'stripe' } });
  assert.match(files.find((file) => file.path.endsWith('PaymentGatewaySettings.cs')).content, /Linked\(configuration, "[^"]+:sweep-silence-minutes", 60\)/);
  for (const file of files.filter((candidate) => /parameters\/[^/]+\/payments\.yaml$/.test(candidate.path))) assert.doesNotMatch(file.content, /unanswered-after-seconds/, file.path);
  const handler = files.find((file) => file.path.endsWith('SavePaymentMethodCommandHandler.cs')).content.replace(/\s*\n\s*\/\/\s*/g, ' ');
  assert.match(handler, /GUARDAR EL MEDIO: la pasarela devuelve SavedPaymentMethod/);
  assert.match(handler, /guárdalo en el campo 'card'/);
});
