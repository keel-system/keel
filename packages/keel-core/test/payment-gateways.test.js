// Lo que cada pasarela exige al adaptador, como datos neutrales (keel-core/gen/payment-gateways.js):
// la matriz de paridad, la traducción de los rechazos, las claves que viajan a la pasarela y las
// unidades menores de cada moneda. Lo consumen keel-spring y keel-nest; si uno de los dos lo
// escribiera por su cuenta, un reintento por el otro servidor no repetiría la clave.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { schemaPathFor } from '../src/index.js';
import { FAILURE_REASONS } from '../src/lib/payment-vocabulary.js';
import { PAYMENT_GATEWAYS } from '../src/lib/gen/infra-catalog.js';
import { paymentProbesFor } from '../src/lib/gen/payment-probes.js';
import {
  CURRENCY_MINOR_UNITS,
  GATEWAY_REQUIREMENTS,
  GATEWAY_STATES,
  GATEWAY_TRANSLATIONS,
  checkGatewaySupport,
  gatewayCoverage,
  gatewayRequirements,
  gatewayTranslation,
  paymentIdempotencyKey,
  savedMethodIdempotencyKey
} from '../src/lib/gen/payment-gateways.js';

const payments = (extra = {}) => ({ flow: 'authorize-capture', capabilities: [], ...extra });
const gatewayIds = Object.keys(PAYMENT_GATEWAYS);

test('toda celda de la matriz existe para TODAS las pasarelas del catálogo, con estado y porqué', () => {
  // Una pasarela nueva sin su columna entera sería una pasarela que genera sin que nadie haya
  // dicho qué cubre: la forma exacta del fallo que la matriz existe para impedir.
  for (const [key, row] of Object.entries(GATEWAY_REQUIREMENTS)) {
    for (const id of gatewayIds) {
      const cell = row[id];
      assert.ok(cell, `${key}: sin celda para ${id}`);
      assert.ok(GATEWAY_STATES.includes(cell.state), `${key}/${id}: estado desconocido`);
      assert.ok(cell.why?.length > 10, `${key}/${id}: el porqué tiene que decir algo`);
    }
  }
});

test('la matriz cubre todo lo que la capa puede exigir', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPathFor('payments'), 'utf8'));
  const declarable = [...schema.properties.flow.enum.map((flow) => `flow:${flow}`), ...schema.properties.capabilities.items.enum];
  assert.deepEqual(declarable.filter((key) => !GATEWAY_REQUIREMENTS[key]), []);
});

test('lo que exige un diseño son su flujo y sus capacidades', () => {
  assert.deepEqual(gatewayRequirements(payments({ capabilities: ['partial-refund'] })), ['flow:authorize-capture', 'partial-refund']);
  assert.deepEqual(gatewayRequirements(undefined), []);
});

test('una capacidad no cubierta es error, una sin verificar es aviso', () => {
  const layers = { payments: payments({ capabilities: ['partial-capture', 'off-session'] }) };
  assert.deepEqual(checkGatewaySupport(layers, 'stripe'), { errors: [], warnings: [] });
  const mp = checkGatewaySupport(layers, 'mercadopago');
  assert.equal(mp.errors.length, 1);
  assert.match(mp.errors[0], /partial-capture/);
  assert.equal(mp.warnings.length, 1);
  assert.match(mp.warnings[0], /off-session/);
});

test('la cobertura dice qué pasarelas pueden servir el diseño', () => {
  const coverage = gatewayCoverage({ payments: payments({ capabilities: ['partial-capture'] }) }, gatewayIds);
  assert.deepEqual(coverage.filter((entry) => entry.errors.length === 0).map((entry) => entry.id), ['stripe']);
});

test('toda pasarela del catálogo tiene su traducción, y cada rechazo cae en un motivo del vocabulario neutro', () => {
  for (const id of gatewayIds) {
    const translation = gatewayTranslation(id);
    assert.ok(translation.referenceKey, `${id}: sin clave de la referencia`);
    assert.ok(translation.savedMethodSteps.length === 2, `${id}: guardar un medio son dos pasos`);
    for (const [code, reason] of translation.declines) {
      assert.ok(FAILURE_REASONS.includes(reason), `${id}: ${code} → ${reason}, que no es del vocabulario`);
    }
    const codes = translation.declines.map(([code]) => code);
    assert.equal(new Set(codes).size, codes.length, `${id}: un código de rechazo repetido`);
  }
  assert.throws(() => gatewayTranslation('paypal'), /no tiene traducción/);
  assert.deepEqual(Object.keys(GATEWAY_TRANSLATIONS).sort(), [...gatewayIds].sort());
});

test('el doble de prueba de cada pasarela habla con los mismos códigos que traduce el adaptador', () => {
  // payment-probes.js dice qué código devuelve el doble para cada motivo; si el adaptador no lo
  // tradujera a ESE motivo, los escenarios medirían el doble y no el servidor.
  for (const id of gatewayIds) {
    const declines = new Map(gatewayTranslation(id).declines);
    for (const [reason, code] of Object.entries(paymentProbesFor(id).declines)) {
      const translated = declines.get(code) ?? 'declined';
      // notReceived no lo produce un rechazo: lo pone el barrido cuando la pasarela no conoce el cobro.
      if (reason === 'notReceived') continue;
      assert.equal(translated, reason, `${id}: el doble manda ${code} para ${reason} y el adaptador lo lee como ${translated}`);
    }
  }
});

test('la clave de idempotencia sale de la referencia de negocio y de la acción, nunca de un aleatorio', () => {
  assert.equal(paymentIdempotencyKey('ch-1', 'authorize'), 'ch-1:authorize');
  assert.equal(paymentIdempotencyKey('ch-1', 'authorize'), paymentIdempotencyKey('ch-1', 'authorize'));
  assert.equal(savedMethodIdempotencyKey('tok_1', 'customer'), 'save:tok_1:customer');
});

test('las unidades menores son las de ISO 4217 (la tabla del JDK), no las de Intl', () => {
  assert.equal(CURRENCY_MINOR_UNITS.EUR, 2);
  assert.equal(CURRENCY_MINOR_UNITS.JPY, 0);
  assert.equal(CURRENCY_MINOR_UNITS.IQD, 3);
  assert.equal(CURRENCY_MINOR_UNITS.CLF, 4);
  assert.equal(CURRENCY_MINOR_UNITS.XAU, undefined, 'el oro no tiene unidad menor: no se cobra');
  assert.equal(Object.keys(CURRENCY_MINOR_UNITS).length, 218);
  assert.deepEqual(Object.keys(CURRENCY_MINOR_UNITS), [...Object.keys(CURRENCY_MINOR_UNITS)].sort());
  for (const [code, digits] of Object.entries(CURRENCY_MINOR_UNITS)) {
    assert.match(code, /^[A-Z]{3}$/);
    assert.ok([0, 2, 3, 4].includes(digits), `${code}: ${digits}`);
  }
  // El motivo de que sea tabla y no plataforma: Intl (CLDR) no dice lo mismo. Si un día coincidiera
  // en todas, la tabla seguiría siendo la fuente; este caso solo documenta que hoy no.
  const intl = (code) => new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  assert.notEqual(intl('IQD'), CURRENCY_MINOR_UNITS.IQD);
});
