// Los diseños DERIVADOS con los que se mide la escritura condicional (DSL 2.25, api.concurrency) en los cuatro
// generadores, el mismo patrón que finder-designs.js. Sujeto: catalog-extended, cuya raíz Product tiene versión (el
// default `all`), una lectura que da el ETag (getProductBySlug) y dos escrituras que la devuelven (updateProduct por
// PATCH y retireProduct, una transición). En relacional y en documental, para que db-check y doc-check midan el MISMO
// diseño (CW-1 a CW-5 en las dos ramas).
//
// Mientras la fixture no declare `concurrency` (los generadores la rechazan en su frontera hasta su incremento), estos
// son los sujetos.

const withConcurrency = (layers) => {
  layers.api.concurrency = { conditionalWrites: 'required', operations: ['updateProduct', 'retireProduct'] };
};

export const CONDITIONAL_WRITE_DESIGNS = [
  { name: 'catalog-conditional', from: 'catalog-extended', mutate: withConcurrency },
  // Con seguridad y CORS (CW-9: ETag expuesto) y un id de texto: updateProduct sobre ProductInfo, leído por getProduct.
  {
    name: 'shop-conditional',
    from: 'shop-api',
    mutate(layers) {
      layers.api.concurrency = { conditionalWrites: 'required', operations: ['updateProduct'] };
    }
  },
  {
    name: 'catalog-conditional-mongo',
    from: 'catalog-extended',
    mutate(layers) {
      withConcurrency(layers);
      layers.persistence.default = { ...layers.persistence.default, model: 'document' };
    }
  }
];
