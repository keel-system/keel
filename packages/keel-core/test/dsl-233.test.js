// DSL 2.33 (inc. 4 de PLAN-CORRIDAS-GELSA.md). D2: el umbral de silencio de una reconciliación enlazado a un
// service.parameters (`unansweredAfter`), excluyente con `unansweredAfterSeconds`, en la activación y en
// `payments.reconciliation`. D7: `savePaymentMethod.cardDetails`, el resumen de la tarjeta que informa la pasarela. Lo
// que se mide aquí es lo que el corpus de mutaciones no ve: que la forma BIEN escrita calle, que la mal escrita salga
// por su id, que el schema rechace los dos umbrales a la vez y que el modelo neutral lea el parámetro sin emitir la clave.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { paymentsYaml } from '../src/lib/gen/payments-config.js';
import { reconciliationParameters, reconciliationYaml } from '../src/lib/gen/reconciliation-stores.js';
import { SAVED_CARD_FIELDS } from '../src/lib/payment-vocabulary.js';
import { EXTENSIONS } from './design-mutations/catalog.js';
import { evaluate, freshBase } from './design-mutations/runner.js';
import { PROBE } from './helpers/probe-projection.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function design(extension, mutate) {
  const d = freshBase();
  EXTENSIONS[extension](d);
  mutate(d);
  return evaluate(d);
}

const PAGE_MINUTES = { type: 'int', description: 'Minutos sin respuesta de la guardia.', default: 10, testValue: 1, requiredInProduction: false };

test('D2: el umbral enlazado a un parámetro int calla, también con la regla del barrido que lo nombra', () => {
  const result = design('escalation', (d) => {
    d.manifest.parameters = { pageTimeoutMinutes: PAGE_MINUTES };
    const activation = d.layers.dependencies.dependencies.pager.activations.pageOncall;
    delete activation.unansweredAfterSeconds;
    activation.unansweredAfter = { parameter: 'pageTimeoutMinutes', unit: 'minutes' };
    d.layers['use-cases'].operations.sweepPages.rules = ['Un ticket en awaitingAck con pageAwaitingSince de más de pageTimeoutMinutes vuelve a la cola.'];
  });
  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.ids, []);
});

test('D2: el schema no admite los dos umbrales a la vez, ni unansweredAfter sin reconciledBy', () => {
  const both = design('escalation', (d) => {
    d.manifest.parameters = { pageTimeoutMinutes: PAGE_MINUTES };
    d.layers.dependencies.dependencies.pager.activations.pageOncall.unansweredAfter = { parameter: 'pageTimeoutMinutes', unit: 'minutes' };
  });
  assert.ok(both.schemaErrors.length > 0, 'los dos umbrales a la vez');
  const orphan = design('escalation', (d) => {
    const activation = d.layers.dependencies.dependencies.pager.activations.pageOncall;
    delete activation.unansweredAfterSeconds;
    delete activation.reconciledBy;
    activation.unansweredAfter = { parameter: 'x', unit: 'minutes' };
  });
  assert.ok(orphan.schemaErrors.some((message) => message.includes('reconciledBy')), orphan.schemaErrors.join('\n'));
});

test('D2: la regla del barrido que nombra la marca sin un parámetro, o un parámetro que no es int, no es un duplicado', () => {
  for (const [rule, parameters] of [
    ['Un ticket en awaitingAck con pageAwaitingSince de más de diez minutos vuelve a la cola.', { pageTimeoutMinutes: PAGE_MINUTES }],
    ['Un ticket en awaitingAck con pageAwaitingSince de más de pageTimeout vuelve a la cola.', { pageTimeout: { ...PAGE_MINUTES, type: 'string', default: 'x', testValue: 'x' } }],
    ['Un ticket en awaitingAck de más de pageTimeoutMinutes vuelve a la cola.', { pageTimeoutMinutes: PAGE_MINUTES }]
  ]) {
    const result = design('escalation', (d) => {
      d.manifest.parameters = parameters;
      d.layers['use-cases'].operations.sweepPages.rules = [rule];
    });
    assert.ok(!result.ids.includes('CHK-DEPS-UNANSWERED-DUPLICATES-PARAMETER'), rule);
  }
});

test('D2 en pagos: el umbral del barrido enlazado calla, con un parámetro que falta es FIELD-UNKNOWN, y los dos a la vez no', () => {
  const link = (parameters, unanswered) =>
    design('payments', (d) => {
      Object.assign((d.manifest.parameters ??= {}), parameters);
      const reconciliation = d.layers.payments.reconciliation;
      delete reconciliation.unansweredAfterSeconds;
      Object.assign(reconciliation, unanswered);
    });
  const good = link({ sweepAfterMinutes: { ...PAGE_MINUTES, description: 'Minutos de silencio de la pasarela.' } }, { unansweredAfter: { parameter: 'sweepAfterMinutes', unit: 'minutes' } });
  assert.deepEqual(good.schemaErrors, []);
  assert.deepEqual(good.ids, []);
  const unknown = link({}, { unansweredAfter: { parameter: 'noExiste', unit: 'minutes' } });
  assert.deepEqual(unknown.ids, ['CHK-PAYMENTS-FIELD-UNKNOWN']);
  const both = link({}, { unansweredAfterSeconds: 900, unansweredAfter: { parameter: 'noExiste', unit: 'minutes' } });
  assert.ok(both.schemaErrors.length > 0);
});

function withSavedCard(d, typeFields, cardDetails) {
  d.layers.domain.types.CardSummary = { description: 'Resumen visible de una tarjeta guardada.', fields: typeFields };
  d.layers.domain.entities.Payment.fields.card = { type: 'CardSummary', required: true };
  d.layers['use-cases'].operations.savePaymentMethod.output = { entity: 'Payment' };
  if (cardDetails) d.layers.payments.savePaymentMethod.cardDetails = cardDetails;
}

const CARD = {
  brand: { type: 'string', required: true, constraints: { maxLength: 30 } },
  last4: { type: 'string', required: true, constraints: { pattern: '^[0-9]{4}$' } }
};

test('D7: con cardDetails el resumen lo informa la pasarela y la regla calla', () => {
  const result = design('payments', (d) => withSavedCard(d, CARD, 'card'));
  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.ids, []);
});

test('D7: cardDetails que no es un compuesto, o con un campo que la pasarela no informa, es FIELD-UNKNOWN', () => {
  const notComposite = design('payments', (d) => withSavedCard(d, CARD, 'currency'));
  assert.ok(notComposite.ids.includes('CHK-PAYMENTS-FIELD-UNKNOWN'), notComposite.ids.join(', '));
  const unreported = design('payments', (d) => withSavedCard(d, { ...CARD, holderName: { type: 'string', required: true } }, 'card'));
  assert.deepEqual(unreported.ids, ['CHK-PAYMENTS-FIELD-UNKNOWN']);
  assert.deepEqual(SAVED_CARD_FIELDS, ['brand', 'last4', 'expMonth', 'expYear']);
});

test('D7: un compuesto opcional, o uno que trae el input, no es un resumen sin fuente', () => {
  const optional = design('payments', (d) => {
    withSavedCard(d, CARD, null);
    d.layers.domain.entities.Payment.fields.card.required = false;
  });
  assert.ok(!optional.ids.includes('CHK-PAYMENTS-SAVED-CARD-UNSOURCED'));
  const fromInput = design('payments', (d) => {
    withSavedCard(d, CARD, null);
    d.layers['use-cases'].operations.savePaymentMethod.input.fields.card = { type: 'CardSummary', required: true };
  });
  assert.ok(!fromInput.ids.includes('CHK-PAYMENTS-SAVED-CARD-UNSOURCED'));
});

function model(fixture, mutate = () => {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  mutate(manifest, layers);
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model) };
  return buildModel({ manifest, layers, stack, projection: PROBE });
}

// stock-reservation y payment-checkout declaran el enlace; el contraste se lo quita en memoria.
test('el modelo: el umbral enlazado se resuelve al parámetro y reconciliation.yaml no emite su clave', () => {
  const linked = model('stock-reservation');
  const activation = linked.dependencies.flatMap((dependency) => dependency.activations).find((candidate) => candidate.name === 'reserveStock');
  assert.equal(activation.unansweredParameter.name, 'reserveStockSilenceMinutes');
  assert.equal(activation.unansweredParameter.unitSeconds, 60);
  const parameters = reconciliationParameters(activation, null);
  assert.equal(parameters.unansweredAfterSeconds.key, null);
  assert.equal(parameters.unansweredAfterSeconds.parameter, activation.unansweredParameter);
  const yaml = reconciliationYaml(linked, 'production');
  const section = yaml.slice(yaml.indexOf('  reserve-stock:'), yaml.indexOf('batch-size', yaml.indexOf('  reserve-stock:')));
  assert.doesNotMatch(section, /unanswered-after-seconds/);
  assert.match(section, /reserveStockSilenceMinutes \(en minutes\)/);
  const claim = linked.services.flatMap((service) => service.operations).flatMap((operation) => operation.reconciles ?? []).find((r) => r.claim?.activation === 'reserveStock')?.claim;
  if (claim) {
    assert.equal(claim.unansweredAfterSeconds, null);
    assert.equal(claim.unansweredParameter.name, 'reserveStockSilenceMinutes');
  }

  // Sin el enlace, nada cambia: la clave y su default.
  const plain = reconciliationYaml(model('stock-reservation', (manifest, layers) => {
    delete manifest.parameters.reserveStockSilenceMinutes;
    const reserveStock = layers.dependencies.dependencies.inventory.activations.reserveStock;
    delete reserveStock.unansweredAfter;
    reserveStock.unansweredAfterSeconds = 1800;
  }), 'production');
  assert.match(plain, /unanswered-after-seconds: \$\{RECONCILIATION_RESERVE_STOCK_UNANSWERED_AFTER_SECONDS:1800\}/);
});

test('el modelo de pagos: el umbral enlazado se resuelve y payments.yaml no emite su clave', () => {
  const linked = model('payment-checkout');
  assert.equal(linked.payments.reconciliation.unansweredParameter.name, 'sweepSilenceMinutes');
  for (const profile of ['local', 'production']) {
    const yaml = paymentsYaml(linked, profile);
    assert.doesNotMatch(yaml, /unanswered-after-seconds/, profile);
    assert.match(yaml, /sweepSilenceMinutes \(en minutes\)/, profile);
  }
  const plain = model('payment-checkout', (manifest, layers) => {
    delete manifest.parameters.sweepSilenceMinutes;
    delete layers.payments.reconciliation.unansweredAfter;
    layers.payments.reconciliation.unansweredAfterSeconds = 900;
  });
  assert.match(paymentsYaml(plain, 'production'), /unanswered-after-seconds: /);
});

// payment-dotnet (2026-11-27): en local y test el umbral salía a 5 s mientras el read-timeout de la pasarela es 10 s. La
// consulta que no contesta dura el timeout entero, así que al acabar la marca renovada ya había vencido y el ciclo
// siguiente volvía a preguntar (FL-REC-005). El arnés envejece la marca a mano: el umbral es el del diseño en todo perfil.
test('el umbral del barrido de pagos es el del diseño en todos los perfiles y nunca menor que el read-timeout', () => {
  const plain = model('payment-checkout', (manifest, layers) => {
    delete manifest.parameters.sweepSilenceMinutes;
    delete layers.payments.reconciliation.unansweredAfter;
    layers.payments.reconciliation.unansweredAfterSeconds = 900;
  });
  const seconds = (text) => {
    const match = /^\s*(\d+)s$/.exec(String(text).replace(/^\$\{[A-Z_]+:(.*)\}$/, '$1'));
    return match ? Number(match[1]) : NaN;
  };
  for (const profile of ['local', 'test', 'develop', 'production']) {
    const yaml = paymentsYaml(plain, profile);
    const threshold = /unanswered-after-seconds: (?:\$\{PAYMENT_UNANSWERED_AFTER_SECONDS:)?(\d+)\}?/.exec(yaml);
    assert.ok(threshold, `${profile}: sin umbral\n${yaml}`);
    assert.equal(Number(threshold[1]), 900, profile);
    const readTimeout = seconds(/read-timeout: (.*)/.exec(yaml)[1]);
    assert.ok(Number(threshold[1]) > readTimeout, `${profile}: el umbral (${threshold[1]} s) no supera el read-timeout (${readTimeout} s)`);
  }
});
