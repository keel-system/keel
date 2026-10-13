// Huella de lo que genera keel-nest, para demostrar que un refactor no cambia nada.
//
// La mecánica es neutral (`keel-core/gen/golden-digest.js`, la misma que usa keel-spring). Nació aquí en
// el incremento 1 de PLAN-KEEL-DOTNET.md: sacar a keel-core lo que keel-nest todavía duplica con
// keel-spring solo es medible si la salida de keel-nest tiene línea base, como la tuvo keel-spring
// antes de su propia extracción.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFixtures, normalizeCombos } from 'keel-core/gen/golden-digest';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_FILE = path.join(here, '..', '..', 'test', 'golden', 'digests.json');

const BROKERS = ['kafka', 'rabbitmq', 'snssqs'];

/**
 * Las combinaciones fixture × stack: TODAS las fixtures con el stack por defecto y cada eje que
 * cambia lo que se emite (broker, motor, identidad, telemetría, pasarela). Son las de keel-spring
 * salvo Oracle, que keel-nest rechaza con su motivo (`supported-features.js`): así las dos líneas
 * base se leen una al lado de la otra.
 */
export function goldenCombos(fixtures = listFixtures()) {
  const combos = [];
  const add = (fixture, stack = {}) => combos.push({ fixture, stack });

  for (const fixture of fixtures) add(fixture);

  for (const fixture of ['catalog-extended', 'job-dispatch', 'payout-runs']) {
    for (const broker of BROKERS) add(fixture, { broker });
    add(fixture, { broker: 'kafka', database: 'mysql' });
  }

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
