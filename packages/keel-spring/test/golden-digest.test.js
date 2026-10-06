// La línea base solo sirve de puerta si la generación es DETERMINISTA y si la comparación
// distingue de verdad un cambio. Este test no compara contra test/golden/digests.json —eso lo
// hace `npm run golden -- --check` a propósito, fuera de la suite—: comprueba las dos
// propiedades de las que depende ese check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGolden, computeGolden, goldenCombos, comboKey } from '../src/lib/golden-digest.js';

test('las combinaciones cubren todas las fixtures y no se repiten', () => {
  const combos = goldenCombos();
  const keys = combos.map((combo) => combo.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const fixture of new Set(combos.map((combo) => combo.fixture))) {
    assert.ok(keys.includes(`${fixture} [default]`), `${fixture} sin su combinación por defecto`);
  }
  assert.ok(keys.includes('payment-checkout [broker=rabbitmq,paymentGateway=mercadopago]'));
});

test('la clave no depende del orden de los ejes del stack', () => {
  assert.equal(
    comboKey({ fixture: 'x', stack: { telemetry: 'otel', broker: 'kafka' } }),
    comboKey({ fixture: 'x', stack: { broker: 'kafka', telemetry: 'otel' } })
  );
});

test('dos pasadas sobre las mismas combinaciones dan la misma huella', () => {
  const combos = goldenCombos().filter((combo) =>
    ['notification-mailer [default]', 'notification-mailer-mongo [broker=kafka]', 'job-dispatch [broker=snssqs,database=oracle]'].includes(combo.key)
  );
  assert.equal(combos.length, 3);
  const first = computeGolden(combos);
  const second = computeGolden(combos);
  assert.deepEqual(compareGolden(first, second), []);
  assert.ok(Object.keys(first.combos['notification-mailer [default]']).length > 50);
});

test('la comparación detecta archivo cambiado, nuevo, retirado y combinación ausente', () => {
  const base = { schema: 1, combos: { a: { 'x.java': '1', 'y.java': '2' }, b: { 'z.java': '3' } } };
  const next = { schema: 1, combos: { a: { 'x.java': '9', 'w.java': '4' } } };
  assert.deepEqual(compareGolden(base, next), [
    'a: nuevo w.java',
    'a: cambiado x.java',
    'a: retirado y.java',
    'b: combinación retirada'
  ]);
});
