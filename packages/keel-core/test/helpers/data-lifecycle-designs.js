// Los diseños DERIVADOS con los que se mide el ciclo de vida del dato (DSL 2.28: `personal`, `deletion: logical`,
// `restorableFor`/`restores` y `retention`) en los cuatro generadores, el mismo patrón que read-scope-designs.js.
//
// Ninguna fixture lo declara hasta el incremento 6 de PLAN-DSL-228-CICLO-DE-VIDA.md: los generadores que todavía no lo
// emiten lo rechazarían. Entonces profile-directory y verification-codes lo declaran, y estos sujetos siguen midiendo
// lo que las fixtures no tienen: las dos ramas de persistencia de cada una, las dos salidas de una retención y la
// composición con la lectura acotada (LC-10).

/** La ficha con email personal y único, borrado lógico y restauración durante 30 días; purgada a los 30 del borrado. */
function cardsLogical(layers, model) {
  layers.persistence.default = { ...layers.persistence.default, model };
  const card = layers.domain.entities.ContactCard;
  card.fields.email = {
    type: 'string',
    unique: true,
    personal: true,
    constraints: { maxLength: 254 },
    description: 'Correo de contacto del titular; dos fichas vivas no lo comparten.'
  };
  card.fields.displayName.personal = true;
  Object.assign(layers.persistence.entities.ContactCard, {
    deletion: 'logical',
    restorableFor: { days: 30, error: 'CARD_NOT_RESTORABLE' },
    retention: { from: 'deleted', keep: { days: 30 }, then: 'delete' }
  });
  const operations = layers['use-cases'].operations;
  operations.saveMyCard.input.fields.email = { type: 'string', constraints: { maxLength: 254 } };
  operations.saveMyCard.errors = [
    { code: 'EMAIL_ALREADY_EXISTS', when: 'Otra ficha viva ya usa ese correo.', http: 409 }
  ];
  operations.deleteMyCard = {
    description: 'Borra la ficha del titular del token; se puede restaurar durante 30 días.',
    kind: 'command',
    input: { fields: { callerSubject: { type: 'string', required: true, description: 'Claim sub del token.' } } },
    output: 'void',
    errors: [{ code: 'CARD_NOT_FOUND', when: 'El titular no tiene ficha.', http: 404 }]
  };
  operations.restoreMyCard = {
    description: 'Deshace el borrado de la ficha del titular durante los 30 días siguientes.',
    kind: 'command',
    restores: 'ContactCard',
    input: { fields: { callerSubject: { type: 'string', required: true, description: 'Claim sub del token.' } } },
    output: 'void',
    errors: [
      { code: 'CARD_NOT_FOUND', when: 'El titular no tiene ninguna ficha borrada.', http: 404 },
      { code: 'CARD_NOT_RESTORABLE', when: 'La ficha se borró hace más de 30 días.', http: 409 },
      { code: 'EMAIL_ALREADY_EXISTS', when: 'Otra ficha viva ocupa ya su correo.', http: 409 }
    ]
  };
  layers.api.endpoints.deleteMyCard = { method: 'DELETE', path: '/me/card', successStatus: 204 };
  layers.api.endpoints.restoreMyCard = { method: 'POST', path: '/me/card/restore', successStatus: 204 };
  for (const name of ['deleteMyCard', 'restoreMyCard']) {
    layers.security.access.rules[name] = { level: 'required', permissions: ['card:self'] };
  }
}

/** El código con email personal y su retención: 30 días desde que se emitió, y después `then`. */
function codesRetention(layers, then) {
  layers.domain.entities.VerificationCode.fields.email.personal = true;
  layers.persistence.entities.VerificationCode.retention = { from: 'issuedAt', keep: { days: 30 }, then };
}

export const DATA_LIFECYCLE_DESIGNS = [
  { name: 'cards-logical', from: 'profile-directory', mutate: (layers) => cardsLogical(layers, 'relational') },
  { name: 'cards-logical-mongo', from: 'profile-directory', mutate: (layers) => cardsLogical(layers, 'document') },
  { name: 'codes-anonymize', from: 'verification-codes', mutate: (layers) => codesRetention(layers, 'anonymize') },
  { name: 'codes-anonymize-mongo', from: 'verification-codes-mongo', mutate: (layers) => codesRetention(layers, 'anonymize') },
  { name: 'codes-delete', from: 'verification-codes', mutate: (layers) => codesRetention(layers, 'delete') },
  // La vida de la fila compuesta con la lectura acotada (LC-10): los archivos se borran lógicamente y sus lecturas se acotan.
  // Los dueños también, y son los que el listado de archivos EMBEBE: la lectura por referencia que ve lo borrado (LC-9).
  {
    name: 'vault-logical-scoped',
    from: 'asset-vault',
    mutate(layers) {
      layers.persistence.default = { ...layers.persistence.default, model: 'relational' };
      layers.persistence.entities.Asset.deletion = 'logical';
      layers.persistence.entities.Asset.retention = { from: 'deleted', keep: { days: 90 }, then: 'delete' };
      layers.persistence.entities.Owner.deletion = 'logical';
    }
  }
];
