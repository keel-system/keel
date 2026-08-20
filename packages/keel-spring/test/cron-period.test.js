import test from 'node:test';
import assert from 'node:assert/strict';

import { cronPeriodSeconds, fastestSchedulePeriod } from '../src/lib/cron-period.js';

// Lo que se está midiendo no es "cuándo corre" sino "cuánto puede tardar en volver a
// correr": es una cota superior, y de ahí que los casos comprueben el hueco MAYOR.

test('el cron de cinco campos se resuelve a la cota del intervalo entre ejecuciones', () => {
  assert.equal(cronPeriodSeconds('* * * * *'), 60);
  assert.equal(cronPeriodSeconds('*/5 * * * *'), 300);
  assert.equal(cronPeriodSeconds('0 * * * *'), 3600);
  assert.equal(cronPeriodSeconds('0 3 * * *'), 86400);
});

test('una lista de minutos se cota por la hora, no por cuántos son', () => {
  // `0,1,2 * * * *` corre tres veces seguidas y luego espera 58 minutos: dividir la
  // hora entre tres daría 20 minutos y la espera se quedaría corta justo en el hueco
  // grande, que es el único que importa.
  assert.equal(cronPeriodSeconds('0,1,2 * * * *'), 3600);
  assert.equal(cronPeriodSeconds('30 */2 * * *'), 3600);
});

test('lo que no es un cron no inventa un periodo', () => {
  assert.equal(cronPeriodSeconds(undefined), null);
  assert.equal(cronPeriodSeconds(''), null);
  assert.equal(cronPeriodSeconds(null), null);
});

test('la cadencia del servicio es la MÁS RÁPIDA, no la más lenta', () => {
  // Con el máximo, una purga diaria pondría el techo de cualquier espera en 24 h y
  // ninguna volvería a fallar por nada. El barrido que empuja el trabajo es el que
  // corre a menudo.
  const model = {
    services: [
      {
        operations: [
          { name: 'dispatchQueued', schedule: { cron: '* * * * *' } },
          { name: 'purgePersonalData', schedule: { cron: '0 3 * * *' } },
          { name: 'registerApplication' }
        ]
      }
    ]
  };
  assert.equal(fastestSchedulePeriod(model), 60);
});

test('sin ningún schedule no hay cadencia que derivar', () => {
  assert.equal(fastestSchedulePeriod({ services: [{ operations: [{ name: 'x' }] }] }), null);
  assert.equal(fastestSchedulePeriod({}), null);
});
