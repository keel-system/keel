// Rasgos del DOMINIO que emite keel-nest, juzgados EJECUTANDO el código emitido (transpilado, sin
// instalar el proyecto): lo que hace un value object con un valor fuera de su tipo, cómo normaliza
// una escala, qué transición niega un agregado y con qué `code`. Cada caso nombra su rasgo y sale de
// una fixture compartida con keel-spring (o de una variante derivada de ella en memoria).
//
// Y la mitad de PARIDAD que se puede medir sin levantar nada: los errores que el dominio puede lanzar
// —clase, `code` y status— son los mismos que emite keel-spring para el mismo diseño.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService, FRAMEWORK_ERRORS } from 'keel-core';
import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const catalog = transpileTree(planFixture('product-catalog').files);
const { Decimal } = await catalog.load('src/domain/support/decimal.ts');

async function rejects(fn, { code = FRAMEWORK_ERRORS.validation.code, httpStatus = 400, message } = {}) {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'se esperaba un rechazo');
  assert.equal(error.code, code);
  assert.equal(error.httpStatus, httpStatus);
  if (message) assert.match(error.message, message);
  return error;
}

test('un value object compuesto NORMALIZA la escala que declara su tipo (12.5 → 12.50)', async () => {
  const { Money } = await catalog.load('src/domain/valueobject/money.ts');
  const money = new Money(Decimal.parse('12.5'), 'EUR');
  assert.equal(money.amount.toString(), '12.50');
  // Y por eso dos importes iguales con distinta escala de entrada son el mismo valor.
  assert.ok(money.equals(new Money(Decimal.parse('12.500'), 'EUR')));
  assert.ok(!money.equals(new Money(Decimal.parse('12.51'), 'EUR')));
});

test('un value object compuesto rechaza con 400 VALIDATION_ERROR lo que su tipo prohíbe', async () => {
  const { Money } = await catalog.load('src/domain/valueobject/money.ts');
  await rejects(() => new Money(null, 'EUR'), { message: /Money\.amount es obligatorio/ });
  await rejects(() => new Money(Decimal.parse('-0.01'), 'EUR'), { message: /menor que el mínimo/ });
  await rejects(() => new Money(Decimal.parse('1'), 'EU'), { message: /más corto/ });
  await rejects(() => new Money(Decimal.parse('1'), 'EURO'), { message: /más largo/ });
});

test('un value object anidado compara por valor a través de su contenedor', async () => {
  const reports = transpileTree(planFixture('inspection-reports').files);
  const { Decimal: D } = await reports.load('src/domain/support/decimal.ts');
  const { GeoPoint } = await reports.load('src/domain/valueobject/geo-point.ts');
  const { Location } = await reports.load('src/domain/valueobject/location.ts');
  const here = new Location(new GeoPoint(D.parse('40.4168'), D.parse('-3.7038')), 'Madrid');
  assert.equal(here.coords.latitude.toString(), '40.416800');
  assert.ok(here.equals(new Location(new GeoPoint(D.parse('40.416800'), D.parse('-3.7038')), 'Madrid')));
  assert.ok(!here.equals(new Location(new GeoPoint(D.parse('40.4168'), D.parse('-3.7038')), 'Toledo')));
  await rejects(() => new GeoPoint(D.parse('90.000001'), D.parse('0')), { message: /mayor que el máximo declarado por su tipo \(90\)/ });
});

test('con scalePolicy: reject el value object rechaza los decimales de más en vez de redondear', async () => {
  // Ninguna fixture lo declara dentro de un value object (solo en entradas): se deriva de una real.
  const { files } = planFixture('inspection-reports', {
    mutate: (layers) => {
      layers.domain.types.GeoPoint.fields.latitude.constraints.scalePolicy = 'reject';
    }
  });
  const reports = transpileTree(files);
  const { Decimal: D } = await reports.load('src/domain/support/decimal.ts');
  const { GeoPoint } = await reports.load('src/domain/valueobject/geo-point.ts');
  assert.equal(new GeoPoint(D.parse('40.4168000'), D.parse('0')).latitude.toString(), '40.416800', 'ceros de más no son decimales de más');
  await rejects(() => new GeoPoint(D.parse('40.1234567'), D.parse('0')), { message: /como mucho 6 decimales/ });
  // La longitud sigue con round: la política es del campo.
  assert.equal(new GeoPoint(D.parse('1'), D.parse('-3.12345678')).longitude.toString(), '-3.123457');
});

test('la clase <Tipo>Format de un escalar juzga el valor ENTERO y tolera el vacío', async () => {
  const { SKUFormat } = await catalog.load('src/domain/valueobject/sku-format.ts');
  assert.equal(SKUFormat.matches('ABC-1234'), true);
  assert.equal(SKUFormat.matches('abc-1234'), false);
  assert.equal(SKUFormat.matches('XABC-1234'), false);
  assert.equal(SKUFormat.matches(null), true);
  assert.equal(SKUFormat.matches('  '), true);
  await rejects(() => SKUFormat.validate('ABC-12'), { message: /formato declarado por SKU/ });
});

test('un enum viaja por el literal del diseño, no por el nombre de la constante', async () => {
  const { ProductStatus } = await catalog.load('src/domain/enums/product-status.ts');
  assert.equal(JSON.stringify({ status: ProductStatus.DRAFT }), '{"status":"draft"}');
});

test('el agregado rehidrata su estado, lo expone sin setters y niega la transición no declarada (409)', async () => {
  const { Product } = await catalog.load('src/domain/aggregate/product.ts');
  const { Money } = await catalog.load('src/domain/valueobject/money.ts');
  const { ProductStatus } = await catalog.load('src/domain/enums/product-status.ts');
  const state = {
    id: '0192f1d2-0000-7000-8000-000000000001',
    sku: 'ABC-1234',
    name: 'Lámpara',
    notes: null,
    price: new Money(Decimal.parse('10'), 'EUR'),
    apiToken: null,
    status: ProductStatus.DRAFT,
    lockVersion: null
  };
  const product = new Product(state);
  assert.equal(product.sku, 'ABC-1234');
  assert.equal(product.status, ProductStatus.DRAFT);
  assert.throws(() => {
    product.status = ProductStatus.ACTIVE;
  }, TypeError, 'sin setter, asignar el estado desde fuera no puede colar');
  // transitionTo es privada en TypeScript; en ejecución es un método más.
  product.transitionTo(ProductStatus.RETIRED);
  assert.equal(product.status, ProductStatus.RETIRED);
  await rejects(() => product.transitionTo(ProductStatus.ACTIVE), {
    code: FRAMEWORK_ERRORS.invalidTransition.code,
    httpStatus: FRAMEWORK_ERRORS.invalidTransition.http,
    message: /retired -> active/
  });
});

test('las colecciones del agregado salen como copia: mutarlas fuera no cambia el agregado', async () => {
  const { files } = planFixture('catalog-extended');
  const tree = transpileTree(files);
  const { Product } = await tree.load('src/domain/aggregate/product.ts');
  const product = new Product({ images: [] });
  product.images.push('intruso');
  assert.equal(product.images.length, 0);
});

test('la EventMetadata estampada al emitir lleva las claves en el orden del cable', async () => {
  const tree = transpileTree(planFixture('stock-reservation').files);
  const { EventMetadata } = await tree.load('src/domain/events/event-metadata.ts');
  const metadata = EventMetadata.now('StockReserved');
  assert.deepEqual(Object.keys(metadata), WIRE_SHAPES.eventMetadata);
  assert.equal(metadata.source, 'stock-reservation');
  assert.equal(metadata.withCorrelationId('c-1').eventId, metadata.eventId, 'la correlación no regenera el id');
});

test('la página de resultados lleva las claves en el orden del cable', async () => {
  const { PagedResponse } = await catalog.load('src/application/dtos/paged-response.ts');
  assert.deepEqual(Object.keys(new PagedResponse([], 0, 20, 0, 0)), WIRE_SHAPES.pagedResponse);
});

// ─── Paridad con keel-spring ─────────────────────────────────────────────────────────────────────

/** Los errores de dominio que emite keel-spring para un diseño: clase → { code, http }. */
function springErrors(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const { files } = planSpring({ manifest, layers, workspace: FIXTURES_DIR });
  const errors = new Map();
  for (const file of files) {
    if (!/\/domain\/errors\/\w+\.java$/.test(file.path)) continue;
    const name = path.basename(file.path, '.java');
    const fixed = /super\(message, "([A-Z0-9_]+)", (\d+), null\)/.exec(file.content);
    const dynamic = /super\(message, "([A-Z0-9_]+)", httpStatus, null\)/.exec(file.content);
    const transition = /"(INVALID_STATE_TRANSITION)", (\d+), null\)/.exec(file.content);
    if (fixed) errors.set(name, { code: fixed[1], http: Number(fixed[2]) });
    else if (dynamic) errors.set(name, { code: dynamic[1], http: 'dinámico' });
    else if (transition) errors.set(name, { code: transition[1], http: Number(transition[2]) });
  }
  return errors;
}

/** Los mismos, de lo que emite keel-nest. */
function nestErrors(files) {
  const errors = new Map();
  for (const file of files) {
    if (!/^src\/domain\/errors\/.+\.ts$/.test(file.path)) continue;
    const name = /export (?:abstract )?class (\w+)/.exec(file.content)?.[1];
    const code = /code: '([A-Z0-9_]+)'/.exec(file.content)?.[1];
    if (!name || !code) continue;
    const http = /httpStatus: (\d+)/.exec(file.content)?.[1];
    errors.set(name, { code, http: http ? Number(http) : 'dinámico' });
  }
  return errors;
}

for (const name of ['product-catalog', 'stock-reservation', 'notification-mailer', 'payment-checkout', 'asset-vault']) {
  test(`${name}: los errores del dominio (clase, code y status) son los de keel-spring`, () => {
    const spring = springErrors(name);
    const nest = nestErrors(planFixture(name).files);
    // InvalidValueException es la traducción explícita de la IllegalArgumentException de los
    // constructores compactos de Java, que keel-spring convierte en 400 VALIDATION_ERROR en su API.
    nest.delete('InvalidValueException');
    assert.ok(spring.size > 0, 'keel-spring emite errores para este diseño');
    assert.deepEqual(Object.fromEntries([...nest].sort()), Object.fromEntries([...spring].sort()));
  });
}
