// DSL 2.33, D7 + G9 (corrida payment de prueba-gelsa): guardar un medio devuelve la referencia Y el resumen de la
// tarjeta, y distingue el 3DS del rechazo. Antes el puerto devolvía un String: el resumen que la entidad exigía no lo
// informaba nadie, y «la pasarela exige autenticar» salía como un rechazo más. Lo que se mide aquí es la forma; lo que
// el adaptador LEE de la respuesta lo ejecuta payment-check (con su sabotaje `saved-card`).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { gatewayTranslation } from '@keel-system/keel-core/gen/payment-gateways';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function plan(gateway, mutate) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payment-checkout'));
  if (mutate) mutate(manifest, layers);
  const files = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { paymentGateway: gateway } })
    .files.filter((f) => typeof f.content === 'string')
    .map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
  return { manifest, layers, read: (suffix) => files.filter((f) => f.path.endsWith(suffix)).map((f) => f.content).join('\n') };
}

const flat = (text) => text.replace(/\s*\n\s*(\*\s*|\/\/\s*)?/g, ' ');

// payment-checkout no tiene un resumen en la entidad guardada: se le añade, con cardDetails.
const withCard = (manifest, layers) => {
  layers.domain.types.SavedCardSummary = {
    description: 'Resumen visible de la tarjeta guardada.',
    fields: {
      brand: { type: 'string', required: true, constraints: { maxLength: 30 } },
      last4: { type: 'string', required: true, constraints: { pattern: '^[0-9]{4}$' } }
    }
  };
  layers.domain.entities.SavedPaymentMethod.fields.card = { type: 'SavedCardSummary', required: true };
  layers.payments.savePaymentMethod.cardDetails = 'card';
};

for (const gateway of ['stripe', 'mercadopago']) {
  test(`${gateway}: el puerto devuelve SavedPaymentMethod y el adaptador lee el resumen de las rutas de keel-core`, () => {
    const { read } = plan(gateway);
    assert.match(read('/PaymentGateway.java'), /SavedPaymentMethod savePaymentMethod\(String token, String payerReference\);/);
    assert.match(read('/SavedPaymentMethod.java'), /public record SavedPaymentMethod\(String reference, SavedCard card\)/);
    assert.match(read('/SavedCard.java'), /public record SavedCard\(String brand, String last4, Integer expMonth, Integer expYear\)/);
    const adapter = read('PaymentGateway.java').split('public interface PaymentGateway').join('');
    assert.match(adapter, /return new SavedPaymentMethod\(/);
    for (const route of Object.values(gatewayTranslation(gateway).savedCard)) {
      assert.ok(adapter.includes(`saved${route.split('.').map((key) => `.path("${key}")`).join('')}`), `${gateway}: ${route}`);
    }
    assert.match(adapter, /throw new PaymentMethodRejectedException\(/);
    assert.doesNotMatch(adapter, /IllegalArgumentException\("La pasarela no acepta el medio/);
  });
}

test('el 3DS al guardar solo se distingue donde la pasarela lo pide (Stripe), con sus códigos de keel-core', () => {
  const stripe = plan('stripe').read('PaymentGateway.java');
  assert.match(stripe, /if \(asksAuthentication\(rejected\)\) \{\n\s+throw new PaymentMethodAuthenticationRequiredException\(/);
  for (const code of gatewayTranslation('stripe').saveAuthenticationCodes) assert.ok(stripe.includes(`"${code}".equals(code)`), code);
  assert.doesNotMatch(plan('mercadopago').read('PaymentGateway.java'), /asksAuthentication/);
});

test('el arnés guarda con un resumen, deja elegirlo y pide el 3DS donde existe', () => {
  const stripe = plan('stripe').read('AbstractFlowIT.java');
  assert.match(stripe, /protected static void gatewaySavesCard\(String brand, String last4, int expMonth, int expYear\)/);
  assert.match(stripe, /stubFor\(attach\[0\], attach\[1\], 402, /);
  assert.match(plan('mercadopago').read('AbstractFlowIT.java'), /protected static void gatewayRequiresAuthenticationToSave\(\) \{\n\s+throw new UnsupportedOperationException\(/);
});

test('con cardDetails el handler sabe dónde va el resumen, y keel-spring lo genera', () => {
  const { manifest, layers, read } = plan('stripe', withCard);
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  const note = flat(read('/SavePaymentMethodCommandHandler.java'));
  assert.match(note, /guárdalo en el campo 'card' \(payments\.savePaymentMethod\.cardDetails\)/);
  assert.match(note, /PaymentMethodAuthenticationRequiredException \(la pasarela exige autenticar al cliente, 3DS/);
  // Sin cardDetails, la nota dice que el diseño no lo decidió.
  assert.match(flat(plan('stripe').read('/SavePaymentMethodCommandHandler.java')), /el diseño no dice dónde guardarlo/);
});
