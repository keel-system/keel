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
  declaredChecks, declaredComputed, checkKind, checkCondition, checkErrorCode, resolveCheckPath,
  INVARIANT_VIOLATED, invariantPlan, evaluateInvariants, guardsAggregate, boundGuards, isAbsentValue, invariantsHandlerNote,
  INVARIANT_CASES, INVARIANT_SABOTAGES
} from '../src/lib/gen/entity-checks.js';
import { COMPUTED_CASES, COMPUTED_SABOTAGES } from '../src/lib/gen/computed.js';
import { ENTITY_CHECK_DESIGNS, INVARIANT_VECTORS } from './helpers/entity-check-designs.js';
import { evaluate } from './design-mutations/runner.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { PROBE } from './helpers/probe-projection.js';
import { openapiDocument } from '../src/lib/gen/openapi.js';

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

// ─── La referencia ejecutable (A2) ───────────────────────────────────────────

/** Las capas del sujeto de entity-check-designs.js. */
function subject(name = 'catalog-invariants') {
  const design = ENTITY_CHECK_DESIGNS.find((candidate) => candidate.name === name);
  const loaded = loadService(path.join(FIXTURES, design.from));
  design.mutate(loaded.layers);
  return loaded;
}

/** ¿Responde la guarda lo que el vector espera? */
function vectorHolds(plan, entry, sabotage = null) {
  const { violation, state } = evaluateInvariants(plan, entry.state, { sabotage });
  if ((violation?.code ?? null) !== entry.expect) return false;
  return Object.entries(entry.derived ?? {}).every(([field, value]) => state[field] === value);
}

test('el sujeto valida: schema limpio y ningún hallazgo de checks ni de computed', () => {
  for (const design of ENTITY_CHECK_DESIGNS) {
    const { manifest, layers } = subject(design.name);
    const result = evaluate({ manifest, layers, scenarios: '' });
    assert.deepEqual(result.schemaErrors, [], design.name);
    assert.deepEqual(result.ids.filter((id) => /CHK-DOMAIN-(CHECK|COMPUTED)/.test(id)), [], design.name);
  }
});

test('cada vector del sujeto responde lo que espera la referencia', () => {
  const plan = invariantPlan(subject().layers, 'Product');
  for (const entry of INVARIANT_VECTORS) {
    assert.ok(vectorHolds(plan, entry), `${entry.case} «${entry.title}»: ${JSON.stringify(evaluateInvariants(plan, entry.state).violation)}`);
  }
});

test('todo caso tiene vectores, y todo vector nombra un caso', () => {
  const ids = [...INVARIANT_CASES, ...COMPUTED_CASES].map(({ id }) => id);
  assert.deepEqual([...new Set(INVARIANT_VECTORS.map((entry) => entry.case))].sort(), [...ids].sort());
});

test('cada sabotaje de la referencia cae en exactamente sus casos', () => {
  const plan = invariantPlan(subject().layers, 'Product');
  const sabotages = { ...INVARIANT_SABOTAGES, ...COMPUTED_SABOTAGES };
  for (const [id, sabotage] of Object.entries(sabotages)) {
    if (!sabotage.reference) continue;
    const broken = [...new Set(INVARIANT_VECTORS.filter((entry) => !vectorHolds(plan, entry, id)).map((entry) => entry.case))];
    assert.deepEqual(broken.sort(), [...sabotage.breaks].sort(), id);
  }
});

test('los sabotajes que solo ve un generador nombran casos que existen', () => {
  const ids = new Set([...INVARIANT_CASES, ...COMPUTED_CASES].map(({ id }) => id));
  for (const [id, sabotage] of Object.entries({ ...INVARIANT_SABOTAGES, ...COMPUTED_SABOTAGES })) {
    assert.ok(sabotage.breaks.length > 0 && sabotage.breaks.every((caseId) => ids.has(caseId)), id);
  }
});

test('el plan: las cotas sin presencia ni escala, las hijas del agregado y el orden de los checks', () => {
  const { layers } = subject();
  const plan = invariantPlan(layers, 'Product');
  assert.deepEqual(plan.bounds.map((guard) => guard.field), ['sku', 'ean', 'internalCode', 'stockCount']);
  assert.deepEqual(plan.bounds.find((guard) => guard.field === 'stockCount').rules, [
    { rule: 'min', value: 0, decimal: false },
    { rule: 'max', value: 1000, decimal: false }
  ]);
  assert.deepEqual(plan.children.map((child) => [child.relation, child.toMany, child.plan.entity]), [['images', true, 'ProductImage']]);
  assert.deepEqual(plan.computed.map(({ fieldName }) => fieldName), ['printTotal', 'imageCount']);
  assert.equal(plan.checks[3].error, 'DISCOUNT_EXCEEDS_PRICE');
  assert.equal(plan.checks[0].error, INVARIANT_VIOLATED);
  assert.ok(guardsAggregate(plan));
  // Una hija se guarda con su agregado: su propio plan no baja a la raíz.
  assert.deepEqual(invariantPlan(layers, 'ProductImage').children, []);
  // Un agregado sin nada que guardar no emite ensureInvariants().
  const plain = loadService(path.join(FIXTURES, 'job-dispatch')).layers;
  assert.equal(guardsAggregate(invariantPlan(plain, 'Job')), boundGuards(plain.domain, 'Job').length > 0);
});

test('ausente: nulo, cadena vacía y lista vacía; un json solo si es nulo', () => {
  assert.equal(isAbsentValue(null, 'text'), true);
  assert.equal(isAbsentValue('', 'text'), true);
  assert.equal(isAbsentValue([], 'text'), true);
  assert.equal(isAbsentValue({}, 'json'), false);
  assert.equal(isAbsentValue([], 'json'), false);
  assert.equal(isAbsentValue(0, 'numeric'), false);
  assert.equal(isAbsentValue(false, 'boolean'), false);
});

test('la nota del handler nombra la guarda y el error propio, desde la raíz o desde una hija', () => {
  const { layers } = subject();
  const note = invariantsHandlerNote(layers, 'ProductImage');
  assert.match(note, /^El agregado de Product se guarda con ensureInvariants\(\)/);
  assert.match(note, /DISCOUNT_EXCEEDS_PRICE/);
  assert.equal(invariantsHandlerNote(layers, 'ProductImage'), invariantsHandlerNote(layers, 'Product'));
});

test('el modelo lleva la guarda: los checks y las cotas de cada entidad, el plan en la raíz y el derivado en su campo', () => {
  for (const design of ENTITY_CHECK_DESIGNS) {
    const { manifest, layers } = subject(design.name);
    const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence.default.model) };
    const model = buildModel({ manifest, layers, stack, projection: PROBE });
    const product = model.entities.find((entity) => entity.name === 'Product');
    const image = model.entities.find((entity) => entity.name === 'ProductImage');
    assert.equal(product.checks.length, 7, design.name);
    assert.deepEqual(product.invariantPlan, invariantPlan(layers, 'Product'), design.name);
    assert.equal(product.guardsInvariants, true);
    assert.equal(image.invariantPlan, null);
    assert.equal(image.guardsInvariants, false);
    assert.deepEqual(image.checks.map((check) => check.op), ['gte']);
    assert.equal(product.fields.find((field) => field.name === 'printTotal').computedSpec.kind, 'sum');
    assert.equal(product.fields.find((field) => field.name === 'name').computedSpec, null);
  }
});

test('el contrato: el 422 de la guarda en las escrituras del agregado guardado, y el derivado readOnly', () => {
  const { manifest, layers } = subject();
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor('relational') };
  const document = openapiDocument(buildModel({ manifest, layers, stack, projection: PROBE }));
  const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  // updateProduct declara DISCOUNT_EXCEEDS_PRICE con 422: comparten la respuesta, el de framework delante como los demás.
  assert.match(byId.get('updateProduct').responses['422'].description, /^`INVARIANT_VIOLATED`: una invariante de la entidad[^\n]*\n`CATEGORY_NOT_FOUND`[^\n]*\n`DISCOUNT_EXCEEDS_PRICE`/);
  assert.match(byId.get('addProductImage').responses['422'].description, /`INVARIANT_VIOLATED`/);
  for (const query of ['listProducts', 'getProductBySlug']) {
    assert.doesNotMatch(JSON.stringify(byId.get(query).responses), /INVARIANT_VIOLATED/, query);
  }
  const product = document.components.schemas.CreateProductResponse ?? Object.entries(document.components.schemas).find(([name, schema]) => schema.properties?.printTotal)?.[1];
  assert.equal(product.properties.printTotal.readOnly, true);
  assert.equal(product.properties.name.readOnly, undefined);
  // Sin guarda en el agregado no hay 422 de framework: el contrato de las fixtures no cambia por la puerta de atrás.
  const plain = loadService(path.join(FIXTURES, 'catalog-extended'));
  const plainDoc = openapiDocument(buildModel({ manifest: plain.manifest, layers: plain.layers, stack, projection: PROBE }));
  assert.equal(JSON.stringify(plainDoc).includes('INVARIANT_VIOLATED'), invariantPlan(plain.layers, 'Product').bounds.length > 0);
});
