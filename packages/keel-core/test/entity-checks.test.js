// Las invariantes que se hacen cumplir (DSL 2.31, `checks`) y los derivados estructurados. Las cinco reglas mecánicas las
// falsa el corpus de mutaciones (extensión `checks` de test/design-mutations/catalog.js) en una dirección; aquí, la otra:
// las formas reales del inventario (M5 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md), escritas sobre sus fixtures, no
// disparan nada. Y la frontera de los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/lib/loader.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import {
  declaredChecks, declaredComputed, checkKind, checkCondition, checkErrorCode, resolveCheckPath, entityChecksPendingErrors,
  INVARIANT_VIOLATED
} from '../src/lib/gen/entity-checks.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

/** Los hallazgos de checks y computed de una fixture tras `mutate` sobre sus capas. */
function checkFindings(fixture, mutate) {
  const { layers, manifest } = loadService(path.join(FIXTURES, fixture));
  mutate(layers);
  const result = checkCrossRefs({ layers, manifest });
  return result.findings
    .map((finding) => finding.id)
    .filter((id) => /CHK-DOMAIN-(CHECK|COMPUTED)/.test(id));
}

test('las «en X tiene Y» del inventario caben en requires + when', () => {
  assert.deepEqual(checkFindings('job-dispatch-cycles', (layers) => {
    layers.domain.entities.Job.checks = [
      { requires: 'runningSince', when: { field: 'status', in: ['running'] } },
      { requires: 'completedAt', when: { field: 'status', equals: 'done' } },
      { requires: 'abandonedAt', when: { field: 'status', in: ['abandoned'] } }
    ];
  }), []);
});

test('las de payment-checkout caben: forbids + unless, y una comparación campo contra campo con un operando opcional', () => {
  assert.deepEqual(checkFindings('payment-checkout', (layers) => {
    layers.domain.entities.Payment.checks = [
      { field: 'refundedAmount', op: 'lte', than: 'amount' },
      { forbids: 'customerAction', unless: { field: 'status', in: ['actionRequired'] } },
      { forbids: 'awaitingSince', unless: { field: 'status', in: ['pending', 'actionRequired', 'capturing', 'canceling', 'refunding'] } }
    ];
  }), []);
});

test('la de product-catalog cabe: un subcampo de value object contra un literal, en un estado', () => {
  assert.deepEqual(checkFindings('product-catalog', (layers) => {
    layers.domain.entities.Product.checks = [{ field: 'price.amount', op: 'gt', value: 0, when: { field: 'status', in: ['active'] } }];
  }), []);
});

test('exactlyOne sobre dos relaciones a-uno de la propia entidad (la línea de shop-api)', () => {
  assert.deepEqual(checkFindings('shop-api', (layers) => {
    layers.domain.entities.ProductInOrder.checks = [{ exactlyOne: ['cart', 'order'] }];
  }), []);
});

test('el orderAmount de shop-api no cabe en computed: OrderMain.products es una colección hacia otro agregado (U5)', () => {
  assert.deepEqual(checkFindings('shop-api', (layers) => {
    layers.domain.entities.OrderMain.fields.orderAmount.computed = { sum: 'products.productPrice', times: 'count' };
  }), ['CHK-DOMAIN-COMPUTED-PATH']);
});

test('un count sobre una hija interna del agregado cabe (catalog-extended)', () => {
  assert.deepEqual(checkFindings('catalog-extended', (layers) => {
    layers.domain.entities.Product.fields.imageCount = { type: 'int', computed: { count: 'images' } };
  }), []);
});

test('una comparación sin tipo común, o con un literal de otro tipo, es CHK-DOMAIN-CHECK-OP-TYPE', () => {
  assert.deepEqual(checkFindings('payment-checkout', (layers) => {
    layers.domain.entities.Payment.checks = [
      { field: 'refundedAmount', op: 'lte', than: 'requestedAt' },
      { field: 'amount', op: 'gt', value: 'cero' },
      { field: 'status', op: 'eq', value: 'lost' }
    ];
  }), ['CHK-DOMAIN-CHECK-OP-TYPE', 'CHK-DOMAIN-CHECK-OP-TYPE', 'CHK-DOMAIN-CHECK-OP-TYPE']);
});

test('una condición sobre un campo que no es enum ni boolean es CHK-DOMAIN-CHECK-WHEN-STATE', () => {
  assert.deepEqual(checkFindings('payment-checkout', (layers) => {
    layers.domain.entities.Payment.checks = [{ requires: 'gatewayPaymentId', when: { field: 'payerId', equals: 'x' } }];
  }), ['CHK-DOMAIN-CHECK-WHEN-STATE']);
});

test('el inventario: forma, condición y code de cada check', () => {
  const layers = {
    domain: {
      entities: {
        Job: {
          fields: { id: { type: 'uuid', id: true }, status: { type: 'enum', values: ['a', 'b'] }, at: { type: 'timestamp' } },
          checks: [
            { requires: 'at', when: { field: 'status', in: ['b'] } },
            { forbids: 'at', unless: { field: 'status', equals: 'b' }, error: 'AT_OUT_OF_PLACE' }
          ]
        }
      }
    }
  };
  const [first, second] = declaredChecks(layers);
  assert.equal(first.kind, 'requires');
  assert.equal(second.kind, 'forbids');
  assert.deepEqual(checkCondition(first.check), { field: 'status', values: ['b'], negated: false });
  assert.deepEqual(checkCondition(second.check), { field: 'status', values: ['b'], negated: true });
  assert.equal(checkErrorCode(first.check), INVARIANT_VIOLATED);
  assert.equal(INVARIANT_VIOLATED, 'INVARIANT_VIOLATED');
  assert.equal(checkErrorCode(second.check), 'AT_OUT_OF_PLACE');
  assert.equal(checkKind({ exactlyOne: ['a', 'b'] }), 'exactlyOne');
  assert.equal(checkKind({ field: 'a', op: 'eq', value: 1 }), 'compare');
});

test('resolveCheckPath distingue campo, subcampo de value object y relación, y deja fuera lo que no existe', () => {
  const { layers } = loadService(path.join(FIXTURES, 'product-catalog'));
  assert.equal(resolveCheckPath(layers, 'Product', 'price.amount').type.category, 'numeric');
  assert.equal(resolveCheckPath(layers, 'Product', 'price.nothing'), null);
  assert.equal(resolveCheckPath(layers, 'Product', 'nothing'), null);
  assert.equal(resolveCheckPath(layers, 'Product', 'status').type.category, 'enum');
});

test('la frontera de los generadores rechaza checks y computed estructurado, y deja pasar la prosa', () => {
  const { layers } = loadService(path.join(FIXTURES, 'product-catalog'));
  assert.deepEqual(entityChecksPendingErrors(layers, 'keel-x', 3), []);
  layers.domain.entities.Product.checks = [{ field: 'price.amount', op: 'gt', value: 0 }];
  layers.domain.entities.Product.fields.imageCount = { type: 'int', computed: { count: 'images' } };
  const errors = entityChecksPendingErrors(layers, 'keel-x', 3);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /domain: checks \[Product\] \(DSL 2\.31\): keel-x todavía no lo genera — llega en el incremento 3/);
  assert.match(errors[1], /Product\.imageCount\.computed estructurado/);
  assert.equal(declaredComputed(layers).length, 1);
});
