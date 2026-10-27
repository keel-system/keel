// La línea base solo sirve de puerta si la generación es DETERMINISTA y si la comparación distingue de
// verdad un cambio. Este test no compara contra test/golden/digests.json —eso lo hace `npm run golden --
// --check` a propósito, fuera de la suite—: comprueba las dos propiedades de las que depende ese check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGolden, computeGolden, listFixtures } from '@keel-system/keel-core/gen/golden-digest';
import { goldenCombos } from '../src/lib/golden-digest.js';
import { planService } from '../src/scaffold/index.js';

test('las combinaciones cubren todas las fixtures y no se repiten', () => {
  const keys = goldenCombos().map((combo) => combo.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const fixture of listFixtures()) assert.ok(keys.includes(`${fixture} [default]`), `${fixture} sin su combinación por defecto`);
  assert.ok(keys.includes('payment-checkout [broker=rabbitmq,paymentGateway=mercadopago]'));
  assert.ok(!keys.some((key) => key.includes('database=oracle')), 'Oracle lo rechaza la frontera de keel-nest');
});

test('dos pasadas sobre las mismas combinaciones dan la misma huella', () => {
  const combos = goldenCombos().filter((combo) =>
    ['notification-mailer [default]', 'notification-mailer-mongo [broker=kafka]', 'job-dispatch [broker=kafka,database=mysql]'].includes(combo.key)
  );
  assert.equal(combos.length, 3);
  const first = computeGolden(combos, { planService });
  const second = computeGolden(combos, { planService });
  assert.deepEqual(compareGolden(first, second), []);
  assert.ok(Object.keys(first.combos['notification-mailer [default]']).length > 50);
});
