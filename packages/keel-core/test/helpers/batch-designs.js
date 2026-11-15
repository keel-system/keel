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

/**
 * product-catalog con `importProducts` asíncrono (fase B): el trabajo por chunks, con la clave de idempotencia del lote
 * (D13). Un trabajo se ata a quien lo crea (D11), así que el servicio gana una capa security con token.
 */
function catalogBatchAsync(layers, model) {
  catalogBatch(layers, model, 'per-item');
  const operation = layers['use-cases'].operations.importProducts;
  operation.batch.execution = 'async';
  operation.input.fields.items.constraints.maxItems = 5000;
  operation.idempotency = { keySource: 'client-key', ttlSeconds: 86400 };
  layers.security = {
    authentication: { protocol: 'oidc', tokenLocation: 'header' },
    access: { default: { level: 'required', description: 'Toda la API exige un token válido.' } }
  };
}

export const BATCH_DESIGNS = [
  { name: 'catalog-batch', from: 'product-catalog', mutate: (layers) => catalogBatch(layers, 'relational', 'per-item') },
  { name: 'catalog-batch-mongo', from: 'product-catalog', mutate: (layers) => catalogBatch(layers, 'document', 'per-item') },
  // El lote que se confirma entero o no se confirma (BA-6).
  { name: 'catalog-batch-atomic', from: 'product-catalog', mutate: (layers) => catalogBatch(layers, 'relational', 'all-or-nothing') }
];

/** Los sujetos de la fase B (lotes asíncronos): no entran en BATCH_DESIGNS hasta que algún generador los genere. */
export const BATCH_JOB_DESIGNS = [
  { name: 'catalog-batch-async', from: 'product-catalog', mutate: (layers) => catalogBatchAsync(layers, 'relational') },
  { name: 'catalog-batch-async-mongo', from: 'product-catalog', mutate: (layers) => catalogBatchAsync(layers, 'document') }
];

/**
 * product-catalog con `importProducts` SÍNCRONO y con clave (D15, inc. 10b): la repetición devuelve la respuesta guardada
 * en el trabajo. Sin capa security, como product-catalog: la clave se acota solo por la operación (BATCH_ANONYMOUS_OWNER).
 */
function catalogBatchKeyed(layers, model, atomicity) {
  catalogBatch(layers, model, atomicity);
  layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 86400 };
}

/** Los sujetos del lote síncrono con clave: no entran en BATCH_DESIGNS hasta que los cuatro generadores los generen. */
export const BATCH_KEY_DESIGNS = [
  { name: 'catalog-batch-keyed', from: 'product-catalog', mutate: (layers) => catalogBatchKeyed(layers, 'relational', 'per-item') },
  { name: 'catalog-batch-keyed-mongo', from: 'product-catalog', mutate: (layers) => catalogBatchKeyed(layers, 'document', 'per-item') },
  // El todo o nada con clave (BK-5): uno que falla no deja trabajo.
  { name: 'catalog-batch-atomic-keyed', from: 'product-catalog', mutate: (layers) => catalogBatchKeyed(layers, 'relational', 'all-or-nothing') }
];
