import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';

const manifest = { keel: '2.3', service: { name: 'demo', version: '0.1.0' } };

test('el camino relacional con token en cabecera no produce nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    persistence: { default: { model: 'relational' } },
    security: { authentication: { protocol: 'oidc', tokenLocation: 'header' } }
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('un diseño que no declara ninguna de las dos cosas tampoco produce nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, { persistence: {}, security: {} });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('key-value es error: es el único modelo de almacenamiento que no se genera', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    persistence: { default: { model: 'key-value' } }
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /persistence\.default\.model/);
  assert.match(errors[0], /key-value/);
  assert.deepEqual(warnings, []);
});

test('relational y document pasan la frontera: keel-spring genera los dos', () => {
  // El contrapunto del test anterior. Este módulo existe para que nada del DSL se
  // ignore en silencio, pero el error simétrico —rechazar algo que sí se genera— es
  // igual de caro: deja al diseñador sin camino con un mensaje que miente.
  for (const model of ['relational', 'document']) {
    const { errors, warnings } = checkSupportedFeatures(manifest, {
      persistence: { default: { model } }
    });

    assert.deepEqual(errors, [], `${model} no debería ser error`);
    assert.deepEqual(warnings, []);
  }
});

test('tokenLocation cookie es aviso, no error: se genera la cabecera y se dice', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    security: { authentication: { protocol: 'oidc', tokenLocation: 'cookie' } }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tokenLocation: cookie/);
  assert.match(warnings[0], /Authorization/);
});

// Las dos patas de la robustez que no aterrizan en una clase. El módulo existe para
// que nada del DSL se ignore en silencio, y estas dos eran justo eso: campos que el
// diseñador declara creyendo que se generan y que solo producen doctrina.

test('una compensación avisa de que no genera ninguna clase propia', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    dependencies: {
      dependencies: {
        payments: {
          activations: { chargeBooking: { triggeredBy: ['bookSeat'] } },
          compensations: [{ onEvent: 'PaymentFailed', undoes: 'chargeBooking' }]
        }
      }
    }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dependencies\.compensations \(payments\.PaymentFailed → chargeBooking\)/);
  assert.match(warnings[0], /suscripción normal/);
});

test('reconciledBy avisa de qué escribe el agente, y de cómo se alcanza el barrido', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    dependencies: {
      dependencies: {
        payments: {
          activations: { chargeBooking: { triggeredBy: ['bookSeat'], reconciledBy: 'sweepPendingCharges' } }
        }
      }
    }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /payments\.chargeBooking → sweepPendingCharges/);
  // Lo que el aviso tiene que decir en voz alta: cómo se alcanza el barrido desde un
  // escenario. El cron no se llama desde fuera, pero su condición de entrada se fabrica —y
  // fabricarla mal, bajando el umbral global, sabotea las filas de los demás escenarios.
  assert.match(warnings[0], /ageForReconciliation/);
  assert.match(warnings[0], /Se envejece LA FILA y no el umbral/);
  assert.match(warnings[0], /check-idempotency\.sh/);
});

test('una dependencia sin compensación ni reconciliación no dice nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    dependencies: { dependencies: { payments: { needs: { rate: { usedBy: ['bookSeat'] } } } } }
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('pagination.style: cursor avisa — keel-spring solo genera el sobre de offset', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    api: { pagination: { style: 'cursor', defaultSize: 20, maxSize: 100 } }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /api\.pagination\.style/);
  assert.match(warnings[0], /cursor/);
  // El aviso tiene que decir QUÉ se genera en su lugar, no solo que no se aplica: es lo
  // que permite escribir los escenarios contra el sobre real en vez de descubrirlo al
  // ejecutarlos.
  assert.match(warnings[0], /totalPages/);
});

test('pagination.style: offset (y su ausencia) no avisan de nada', () => {
  for (const pagination of [{ style: 'offset', defaultSize: 20 }, { defaultSize: 20 }]) {
    const { errors, warnings } = checkSupportedFeatures(manifest, { api: { pagination } });

    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [], `${JSON.stringify(pagination)} no debería avisar`);
  }
});

// ─── La operación interna a la que no llega ningún disparador generado ───────
//
// `internal: true` sin `schedule`, sin endpoint y sin ninguna suscripción que la dispare
// solo puede ejecutarla OTRO handler. Ese enlace vive hoy en la prosa de `rules`, así que
// build no lo ve — y de ahí salen tres cosas que no puede hacer por el llamante. La cara:
// en una corrida real el barrido que manda el correo quedó despachado con una transacción
// única sobre el lote entero, y con eso el reclamo (un UPDATE condicional impecable) dejó
// de ser un reclamo: no confirma hasta el final, ninguna réplica lo ve, los envíos SMTP
// caen dentro de la transacción y el estado `sending` no llega a existir para nadie.

const withMail = (extra = {}) => ({
  'use-cases': {
    operations: {
      dispatchQueued: { schedule: { cron: '* * * * *' }, transitions: [{ entity: 'Msg', from: ['sending'], to: 'failed' }] },
      sendQueued: { internal: true },
      ...(extra.operations ?? {})
    }
  },
  mail: { sentBy: ['sendQueued'] },
  ...extra.layers
});

test('la operación interna sin disparador se avisa, y con I/O externo se dice qué se pierde', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, withMail());
  const aviso = warnings.filter((w) => w.includes('sin ningún disparador generado'));

  assert.deepEqual(errors, []);
  assert.equal(aviso.length, 1, warnings.join('\n'));
  assert.match(aviso[0], /sendQueued/);
  // Las tres consecuencias, que son lo accionable: transacción, reclamo y dónde mirarlo.
  assert.match(aviso[0], /dispatchWithoutTransaction/);
  assert.match(aviso[0], /el reclamo NO confirma hasta el final/);
  assert.match(aviso[0], /concurrency\.md/);
});

test('sin I/O externo el aviso se queda en el enlace invisible, sin la parte de la transacción', () => {
  // Una interna que solo mueve datos propios no paga el precio caro: no hay llamada
  // externa dentro de la transacción ni estado intermedio que nadie pueda observar.
  const { warnings } = checkSupportedFeatures(manifest, {
    'use-cases': { operations: { recalcular: { internal: true } } }
  });
  const aviso = warnings.filter((w) => w.includes('sin ningún disparador generado'));

  assert.equal(aviso.length, 1);
  assert.ok(!aviso[0].includes('dispatchWithoutTransaction'), aviso[0]);
});

test('una interna que SÍ tiene disparador no se avisa', () => {
  // La simétrica, que es lo que impide que el aviso salga sobre media capa use-cases:
  // con `schedule` o con una suscripción que la dispare, build sí conoce su entrada.
  const conSchedule = checkSupportedFeatures(manifest, {
    'use-cases': { operations: { barrer: { internal: true, schedule: { cron: '* * * * *' } } } }
  });
  const porSuscripcion = checkSupportedFeatures(manifest, {
    'use-cases': { operations: { aplicar: { internal: true } } },
    messaging: { subscriptions: { AlgoPasó: { triggers: 'aplicar' } } }
  });

  for (const { warnings } of [conSchedule, porSuscripcion]) {
    assert.deepEqual(warnings.filter((w) => w.includes('sin ningún disparador generado')), []);
  }
});
