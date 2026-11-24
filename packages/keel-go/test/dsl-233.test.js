// DSL 2.33 (PLAN-CORRIDAS-GELSA.md): el umbral de silencio enlazado a un parámetro (activations.*.unansweredAfter y
// reconciliation.unansweredAfter) se lee de la propiedad del parámetro en segundos, sin clave propia en los yaml; y la nota
// de guardar un medio dice dónde va el resumen de la tarjeta (savePaymentMethod.cardDetails). Lo declaran las fixtures
// stock-reservation y payment-checkout, así que go-check las compila con las demás.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function emitted(name, stack = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
}

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

test('stock-reservation: el reclamo de reconciliación lee el parámetro (activations.*.unansweredAfter)', () => {
  const files = emitted('stock-reservation');
  assert.match(content(files, '/reconciliation.go'), /"reserveStock": \{key: "stock-reservation\.reserve-stock-silence-minutes", unitSeconds: 60\},/);
  for (const file of files.filter((candidate) => /parameters\/[^/]+\/reconciliation\.yaml$/.test(candidate.path))) assert.doesNotMatch(file.content, /unanswered-after-seconds/, file.path);
});

test('payment-checkout: el barrido lee el parámetro (reconciliation.unansweredAfter) y la nota guarda la tarjeta (savePaymentMethod.cardDetails)', () => {
  const files = emitted('payment-checkout', { paymentGateway: 'stripe' });
  assert.match(content(files, 'payment/settings.go'), /positive\("payment-checkout\.sweep-silence-minutes", 0\)/);
  for (const file of files.filter((candidate) => /parameters\/[^/]+\/payments\.yaml$/.test(candidate.path))) assert.doesNotMatch(file.content, /unanswered-after-seconds/, file.path);
  const handler = content(files, 'save_payment_method_command_handler.go').replace(/\s*\n\s*\/\/\s*/g, ' ');
  assert.match(handler, /GUARDAR EL MEDIO: la pasarela devuelve domain\.GatewaySavedMethod/);
  assert.match(handler, /guárdalo en el campo 'card'/);
});
