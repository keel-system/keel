// Los diseños DERIVADOS con los que se miden los lotes (DSL 2.30: `use-cases.<op>.batch`) en los cuatro generadores, el
// mismo patrón que history-designs.js.
//
// Hasta el incremento 11 de PLAN-DSL-230-LOTES.md ninguna fixture los declara. Entonces product-catalog gana
// `importProducts` e `importCatalog`, y estos sujetos siguen midiendo lo que ella no tenga: la rama documental y el lote
// all-or-nothing.

/** Lo que hace falta para dar de alta un producto: el elemento del lote. */
const PRODUCT_DRAFT = {
  description: 'Lo que hace falta para dar de alta un producto.',
  fields: {
    sku: { type: 'SKU', required: true },
    name: { type: 'string', required: true, constraints: { maxLength: 120 } },
    price: { type: 'Money', required: true }
  }
};

/** product-catalog con `importProducts`, un lote de altas, sobre el modelo de persistencia `model`. */
function catalogBatch(layers, model, atomicity) {
  layers.persistence.default = { ...layers.persistence.default, model };
  layers.domain.types.ProductDraft = structuredClone(PRODUCT_DRAFT);
  layers['use-cases'].operations.importProducts = {
    description: 'Da de alta un lote de productos en estado draft.',
    kind: 'command',
    input: {
      fields: {
        items: { type: 'ProductDraft', list: true, required: true, constraints: { maxItems: 500 }, description: 'Los productos del lote.' }
      }
    },
    output: 'void',
    rules: ['Por cada elemento, verificar que el sku no existe antes de crear.'],
    errors: [{ code: 'SKU_ALREADY_EXISTS', when: 'Ya existe un producto con ese sku.', http: 409 }],
    batch: {
      over: 'items',
      atomicity,
      ...(atomicity === 'per-item' ? { itemErrors: ['SKU_ALREADY_EXISTS'] } : {}),
      output: { fields: { productId: { type: 'uuid', description: 'El producto que se dio de alta.' } } }
    }
  };
  layers.api.endpoints.importProducts = {
    method: 'POST',
    path: '/products/batch',
    ...(atomicity === 'per-item' ? {} : { successStatus: 200 })
  };
}

export const BATCH_DESIGNS = [
  { name: 'catalog-batch', from: 'product-catalog', mutate: (layers) => catalogBatch(layers, 'relational', 'per-item') },
  { name: 'catalog-batch-mongo', from: 'product-catalog', mutate: (layers) => catalogBatch(layers, 'document', 'per-item') },
  // El lote que se confirma entero o no se confirma (BA-6).
  { name: 'catalog-batch-atomic', from: 'product-catalog', mutate: (layers) => catalogBatch(layers, 'relational', 'all-or-nothing') }
];
