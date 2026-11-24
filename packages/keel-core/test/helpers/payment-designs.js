// Los diseños DERIVADOS de payment-checkout con los que se mide lo que ninguna fixture declara: los pagos sobre MongoDB.
// Sin ellos, la rama documental del reclamo del barrido de pagos (G11 de PLAN-CORRIDAS-GELSA.md, un findAndModify por
// candidato) no la ejecutaba ninguna red. Los comparten los generadores, para que sus redes midan el MISMO diseño: keel-spring
// en claim-check, y los otros tres en su doc-check.

export const PAYMENT_DOCUMENT_DESIGNS = [
  {
    name: 'payment-checkout-mongo',
    from: 'payment-checkout',
    mutate(layers, manifest) {
      if (manifest) manifest.service.name = 'payment-checkout-mongo';
      layers.persistence.default = { ...layers.persistence.default, model: 'document' };
    }
  }
];
