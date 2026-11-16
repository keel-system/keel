// El sujeto con el que se miden las invariantes que se hacen cumplir y los derivados (DSL 2.31: `checks` y `computed`
// estructurado) en los cuatro generadores, y los vectores que sus redes ejecutan contra lo que emite build.
//
// M4 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md: ninguna fixture tiene un `sum` natural, así que el sujeto es
// catalog-extended con campos sintéticos. Cada check está escrito para que cada sabotaje de la referencia caiga en
// exactamente sus casos (keel-core/test/entity-checks.test.js lo comprueba): por eso el campo contra campo de IC-3 es un
// instante con condición y no el descuento, que lleva su propio error (IC-11).

/** catalog-extended con las invariantes y los derivados del sujeto, sobre el modelo de persistencia `model`. */
function withInvariants(layers, model) {
  layers.persistence.default = { ...layers.persistence.default, model };
  const product = layers.domain.entities.Product;
  Object.assign(product.fields, {
    publishedAt: { type: 'timestamp', description: 'Cuándo se publicó.' },
    retiredAt: { type: 'timestamp', description: 'Cuándo se retiró.' },
    listPrice: { type: 'decimal', constraints: { scale: 2 }, description: 'Precio de lista.' },
    discount: { type: 'decimal', constraints: { scale: 2 }, description: 'Descuento sobre el precio de lista.' },
    ean: { type: 'string', constraints: { maxLength: 13 }, description: 'Código de barras, si lo tiene.' },
    internalCode: { type: 'string', constraints: { maxLength: 20 }, description: 'Código interno, si no tiene código de barras.' },
    attributes: { type: 'json', description: 'Atributos libres que define el proveedor.' },
    stockCount: { type: 'int', constraints: { min: 0, max: 1000 }, description: 'Unidades en almacén; las suma el servidor.' },
    printTotal: {
      type: 'decimal',
      constraints: { scale: 2 },
      computed: { sum: 'images.printPrice', times: 'copies' },
      description: 'Lo que cuesta imprimir todas las copias de sus imágenes.'
    },
    imageCount: { type: 'int', computed: { count: 'images' }, description: 'Cuántas imágenes tiene.' }
  });
  product.checks = [
    { requires: 'publishedAt', when: { field: 'status', in: ['active'] } },
    { forbids: 'retiredAt', unless: { field: 'status', in: ['retired'] } },
    { field: 'retiredAt', op: 'gte', than: 'publishedAt', when: { field: 'status', in: ['retired'] } },
    { field: 'discount', op: 'lte', than: 'listPrice', error: 'DISCOUNT_EXCEEDS_PRICE' },
    { field: 'listPrice', op: 'gt', value: 0, when: { field: 'status', in: ['active'] } },
    { exactlyOne: ['ean', 'internalCode'] },
    { requires: 'attributes', when: { field: 'status', equals: 'active' } }
  ];
  const image = layers.domain.entities.ProductImage;
  Object.assign(image.fields, {
    printPrice: { type: 'decimal', constraints: { scale: 4 }, description: 'Lo que cuesta imprimir una copia.' },
    copies: { type: 'int', description: 'Cuántas copias se imprimen.' }
  });
  image.checks = [{ field: 'position', op: 'gte', value: 0 }];
  layers['use-cases'].operations.updateProduct.errors.push({
    code: 'DISCOUNT_EXCEEDS_PRICE',
    when: 'El descuento supera el precio de lista.',
    http: 422
  });
}

export const ENTITY_CHECK_DESIGNS = [
  { name: 'catalog-invariants', from: 'catalog-extended', mutate: (layers) => withInvariants(layers, 'relational') },
  { name: 'catalog-invariants-mongo', from: 'catalog-extended', mutate: (layers) => withInvariants(layers, 'document') }
];

// ─── Los vectores ────────────────────────────────────────────────────────────
//
// Cada uno es un estado del agregado Product con los nombres del diseño (los decimales como texto, los instantes en ISO,
// las imágenes como lista) y lo que la guarda tiene que responder al guardarlo: el `code` de la primera invariante rota,
// o null, y los derivados recalculados (`derived`). Los ejecuta la referencia (evaluateInvariants) y, desde A3, la red
// de cada generador contra la entidad y el save que emite build.

const BASE = Object.freeze({
  sku: 'ACME-1',
  name: 'Lámpara',
  status: 'draft',
  publishedAt: null,
  retiredAt: null,
  listPrice: '10.00',
  discount: '0.00',
  ean: '8410000000001',
  internalCode: null,
  attributes: null,
  stockCount: 5,
  images: []
});

const ACTIVE = { status: 'active', publishedAt: '2026-01-02T00:00:00Z', attributes: { color: 'red' } };
const image = (position, printPrice, copies) => ({ storageKey: `img-${position}.png`, position, primary: false, printPrice, copies });

const vector = (caseId, title, overrides, expect, derived) =>
  Object.freeze({ case: caseId, title, state: { ...BASE, ...overrides }, expect, ...(derived ? { derived } : {}) });

export const INVARIANT_VECTORS = Object.freeze([
  vector('IC-1', 'activo sin publishedAt', { ...ACTIVE, publishedAt: null }, 'INVARIANT_VIOLATED'),
  vector('IC-1', 'activo con publishedAt', ACTIVE, null),
  vector('IC-1', 'borrador sin publishedAt', {}, null),
  vector('IC-2', 'borrador con retiredAt', { retiredAt: '2026-02-01T00:00:00Z' }, 'INVARIANT_VIOLATED'),
  vector('IC-2', 'retirado con retiredAt', { status: 'retired', publishedAt: '2026-01-02T00:00:00Z', retiredAt: '2026-02-01T00:00:00Z' }, null),
  vector('IC-3', 'retirado el mismo instante en que se publicó', { status: 'retired', publishedAt: '2026-01-02T00:00:00Z', retiredAt: '2026-01-02T00:00:00Z' }, null),
  vector('IC-3', 'retirado antes de publicarse', { status: 'retired', publishedAt: '2026-01-02T00:00:00Z', retiredAt: '2026-01-01T00:00:00Z' }, 'INVARIANT_VIOLATED'),
  // El descuento por debajo del precio, y no igual: con el descuento en la igualdad, ic-boundary caería también aquí.
  vector('IC-4', 'activo con precio cero', { ...ACTIVE, listPrice: '0.00', discount: '-1.00' }, 'INVARIANT_VIOLATED'),
  vector('IC-4', 'borrador con precio cero', { listPrice: '0.00', discount: '-1.00' }, null),
  vector('IC-5', 'descuento sin precio de lista', { listPrice: null, discount: '5.00' }, null),
  vector('IC-5', 'retirado sin publishedAt', { status: 'retired', retiredAt: '2026-02-01T00:00:00Z' }, null),
  vector('IC-6', 'sin ningún código', { ean: null }, 'INVARIANT_VIOLATED'),
  vector('IC-6', 'con los dos códigos', { internalCode: 'X-1' }, 'INVARIANT_VIOLATED'),
  vector('IC-6', 'solo el interno', { ean: null, internalCode: 'X-1' }, null),
  vector('IC-7', 'ean vacío y código interno', { ean: '', internalCode: 'X-1' }, null),
  vector('IC-7', 'activo con atributos {}', { ...ACTIVE, attributes: {} }, null),
  vector('IC-8', 'stock por encima del máximo', { stockCount: 1001 }, 'INVARIANT_VIOLATED'),
  vector('IC-8', 'stock en el máximo', { stockCount: 1000 }, null),
  vector('IC-8', 'sku fuera de su formato', { sku: 'a' }, 'INVARIANT_VIOLATED'),
  vector('IC-9', 'una imagen en posición negativa', { images: [image(-1, null, null)] }, 'INVARIANT_VIOLATED'),
  vector('IC-10', 'activo sin publishedAt, sobre una fila que ya existía', { ...ACTIVE, publishedAt: null }, 'INVARIANT_VIOLATED'),
  vector('IC-11', 'descuento por encima del precio', { discount: '10.01' }, 'DISCOUNT_EXCEEDS_PRICE'),
  vector('IC-11', 'descuento por debajo del precio', { discount: '9.99' }, null),
  vector('CP-1', 'sin imágenes', {}, null, { imageCount: 0, printTotal: '0.00' }),
  vector('CP-1', 'tres imágenes', { images: [image(1, null, null), image(2, null, null), image(3, null, null)] }, null, { imageCount: 3 }),
  vector('CP-2', 'una sola vez al final', { images: [image(1, '1.2345', 2), image(2, '0.0025', 2)] }, null, { printTotal: '2.47' }),
  vector('CP-2', 'la mitad se aleja del cero', { images: [image(1, '1.2325', 2)] }, null, { printTotal: '2.47' }),
  vector('CP-3', 'sumandos y factores ausentes', { images: [image(1, null, 3), image(2, '1.0000', null), image(3, '2.0000', 1)] }, null, { printTotal: '2.00' }),
  vector('CP-4', 'no cabe en la columna', { images: [image(1, '999999999999999.9999', 1000)] }, 'INVARIANT_VIOLATED'),
  vector('CP-5', 'tras quitar una imagen', { images: [image(1, '1.0000', 1)] }, null, { imageCount: 1, printTotal: '1.00' })
]);
