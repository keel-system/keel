// Huella de lo que genera keel-spring, para demostrar que un refactor no cambia nada.
//
// La mecánica (huella por archivo, comparación, el cuerpo del script) es neutral y vive en
// `@keel-system/keel-core/gen/golden-digest.js` desde el incremento 1 de PLAN-KEEL-DOTNET.md: la comparten los
// generadores. Aquí queda lo que es de keel-spring: su `planService`, sus combinaciones fixture × stack
// y dónde guarda su línea base.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOLDEN_FIXTURES_DIR,
  compareGolden,
  comboKey,
  computeGolden as computeNeutralGolden,
  listFixtures,
  normalizeCombos,
  serializeGolden
} from '@keel-system/keel-core/gen/golden-digest';
import { planService } from '../scaffold/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = GOLDEN_FIXTURES_DIR;
export const GOLDEN_FILE = path.join(here, '..', '..', 'test', 'golden', 'digests.json');

export { compareGolden, comboKey, listFixtures, serializeGolden };

const BROKERS = ['kafka', 'rabbitmq', 'snssqs'];

/**
 * Las combinaciones fixture × stack. Son las de `npm run compile-check` —cada eje que ahí
 * tiene Java propio (broker, motor, identidad, telemetría, pasarela)— más TODAS las fixtures con
 * el stack por defecto, para que ninguna quede fuera de la línea base.
 */
export function goldenCombos(fixtures = listFixtures()) {
  const combos = [];
  const add = (fixture, stack = {}) => combos.push({ fixture, stack });

  for (const fixture of fixtures) add(fixture);

  // compile-check sin --broker cruza los tres brokers y, si la fixture es relacional, MySQL.
  for (const fixture of ['catalog-extended', 'job-dispatch', 'payout-runs']) {
    for (const broker of BROKERS) add(fixture, { broker });
    add(fixture, { broker: 'kafka', database: 'mysql' });
  }
  for (const broker of BROKERS) add('job-dispatch', { broker, database: 'oracle' });

  add('asset-vault', { broker: 'snssqs' });
  add('asset-vault', { broker: 'kafka', auth: 'cognito' });
  add('asset-vault', { broker: 'snssqs', telemetry: 'otel' });
  add('notification-mailer', { broker: 'snssqs' });
  add('notification-mailer', { broker: 'kafka', auth: 'cognito' });
  add('notification-mailer', { broker: 'kafka', telemetry: 'otel' });
  add('notification-mailer-mongo', { broker: 'kafka' });
  add('job-dispatch-mongo', { broker: 'kafka' });
  add('stock-reservation', { broker: 'kafka' });
  add('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  add('metering-digest', { broker: 'kafka' });
  add('profile-directory', { broker: 'kafka' });
  add('payment-checkout', { broker: 'rabbitmq', paymentGateway: 'stripe' });
  add('payment-checkout', { broker: 'rabbitmq', paymentGateway: 'mercadopago' });

  return normalizeCombos(combos);
}

/** La línea base entera de keel-spring. */
export function computeGolden(combos = goldenCombos(), fixturesDir = FIXTURES_DIR) {
  return computeNeutralGolden(combos, { planService, fixturesDir });
}
