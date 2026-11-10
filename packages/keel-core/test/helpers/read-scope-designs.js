// Los diseños DERIVADOS con los que se mide la lectura acotada (DSL 2.27, `reads` y `readMiss`) y la identidad opcional
// (`level: optional`) en los cuatro generadores, el mismo patrón que finder-designs.js y conditional-write-designs.js.
//
// Ninguna fixture declara `reads` ni `optional` hasta el incremento 7 de PLAN-DSL-227-LECTURA-ACOTADA.md: los
// generadores que todavía no lo emiten la rechazarían. Hasta entonces, estos son los sujetos.

const required = { level: 'required' };

export const READ_SCOPE_DESIGNS = [
  // El alcance por claim (`within`), con un rol y un cliente exentos, la caché de la ficha y el camino Asset.owner → Owner.code.
  {
    name: 'vault-scoped',
    from: 'asset-vault',
    mutate(layers) {
      Object.assign(layers.security.authentication.scoping, { reads: ['getAsset', 'listAssets'], readMiss: 'forbidden' });
    }
  },
  // Lo mismo sobre documentos.
  {
    name: 'vault-scoped-mongo',
    from: 'asset-vault',
    mutate(layers) {
      Object.assign(layers.security.authentication.scoping, { reads: ['getAsset', 'listAssets'], readMiss: 'forbidden' });
      layers.persistence.default = { ...layers.persistence.default, model: 'document' };
    }
  },
  // La propiedad (`ownedBy`) con roles exentos, `forbidden` y un listado paginado. El input callerEmail de las lecturas
  // sobra (T6): el predicado sale del scope, no de un campo que el handler compare.
  {
    name: 'shop-scoped',
    from: 'shop-api',
    mutate(layers) {
      const { OrderMain, User } = layers.security.ownership;
      Object.assign(OrderMain, { operations: ['cancelOrder'], reads: ['getOrder', 'listOrders'], readMiss: 'forbidden' });
      Object.assign(User, { operations: ['updateProfile'], reads: ['getProfile'], readMiss: 'forbidden' });
      const operations = layers['use-cases'].operations;
      delete operations.listOrders.input.fields.callerEmail;
      delete operations.getOrder.input.fields.callerEmail;
      delete operations.getProfile.input.fields.callerEmail;
      operations.getOrder.errors = [
        ...(operations.getOrder.errors ?? []),
        ...((operations.getOrder.errors ?? []).some((e) => e.code === 'ORDER_NOT_OWNED')
          ? []
          : [{ code: 'ORDER_NOT_OWNED', when: 'El pedido no es del usuario autenticado.', http: 403 }])
      ];
    }
  },
  // El dueño a través de una relación (Article.author → Profile.subject) con `not-found`. Las lecturas pasan a required
  // para tener a quién acotar (D8).
  {
    name: 'conduit-scoped',
    from: 'conduit',
    mutate(layers) {
      Object.assign(layers.security.ownership.Article, { reads: ['getArticle', 'listArticles'], readMiss: 'not-found' });
      layers.security.access.rules.getArticle = { ...required };
      layers.security.access.rules.listArticles = { ...required };
    }
  },
  // R3c: las cuatro lecturas que el legacy personaliza si llega un token, con el campo de la identidad opcional.
  {
    name: 'conduit-optional',
    from: 'conduit',
    mutate(layers) {
      const caller = layers.security.authentication.callerIdentity.field;
      for (const opName of ['getProfile', 'listArticles', 'getArticle', 'listComments']) {
        layers.security.access.rules[opName] = { level: 'optional' };
        const op = layers['use-cases'].operations[opName];
        op.input = op.input && typeof op.input === 'object' ? op.input : { fields: {} };
        op.input.fields = { ...(op.input.fields ?? {}), [caller]: { type: 'string', description: 'Claim sub del token, si llega uno.' } };
      }
    }
  }
];
