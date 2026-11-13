// Los diseños DERIVADOS con los que se mide el historial de cambios (DSL 2.29: `audit.history` y la query de
// `output: { history }`) en los cuatro generadores, el mismo patrón que data-lifecycle-designs.js.
//
// Hasta el incremento 6 de PLAN-DSL-229-HISTORIAL.md ninguna fixture lo declara. Entonces profile-directory v1.2.0 guarda
// el de la ficha, y estos sujetos siguen midiendo lo que ella no tiene: la rama documental, la retención que anonimiza y
// un agregado con hijas cuya lectura va acotada (HI-3 y HI-7).

/** La query de historial de una raíz, con los tres filtros; `locate` son los campos que localizan la raíz. */
function historyQuery(root, locate, errors) {
  return {
    description: `Devuelve el historial de cambios de ${root}, el más reciente primero.`,
    kind: 'query',
    input: {
      fields: {
        ...locate,
        field: { type: 'string', historyFilter: 'field', description: 'Solo las entradas que cambiaron este campo.' },
        from: { type: 'timestamp', historyFilter: 'from', description: 'Solo las confirmadas desde este instante.' },
        to: { type: 'timestamp', historyFilter: 'to', description: 'Solo las confirmadas hasta este instante.' }
      }
    },
    output: { history: root, paginated: true },
    errors
  };
}

/** La ficha de profile-directory con su historial, sobre el modelo de persistencia `model`. */
function cardsHistory(layers, model) {
  layers.persistence.default = { ...layers.persistence.default, model };
  layers.persistence.audit = { ...layers.persistence.audit, history: ['ContactCard'] };
  layers['use-cases'].operations.getMyCardHistory = historyQuery(
    'ContactCard',
    { callerSubject: { type: 'string', required: true, description: 'Claim sub del token.' } },
    [{ code: 'CARD_NOT_FOUND', when: 'El titular no tiene ficha viva.', http: 404 }]
  );
  layers.api.endpoints.getMyCardHistory = { method: 'GET', path: '/me/card/history' };
  layers.api.pagination ??= { style: 'offset', defaultSize: 20, maxSize: 100 };
  layers.security.access.rules.getMyCardHistory = { level: 'required', permissions: ['card:self'] };
}

export const HISTORY_DESIGNS = [
  { name: 'cards-history', from: 'profile-directory', mutate: (layers) => cardsHistory(layers, 'relational') },
  { name: 'cards-history-mongo', from: 'profile-directory', mutate: (layers) => cardsHistory(layers, 'document') },
  // La retención que anonimiza (HI-8): los valores personales del historial se reescriben con el mismo sustituto. En los
  // dos modelos: el almacén documental reescribe su `changes` de texto por su cuenta.
  ...['relational', 'document'].map((model) => ({
    name: model === 'relational' ? 'cards-history-anonymize' : 'cards-history-anonymize-mongo',
    from: 'profile-directory',
    mutate(layers) {
      cardsHistory(layers, model);
      layers.persistence.entities.ContactCard.retention = { from: 'deleted', keep: { days: 30 }, then: 'anonymize' };
    }
  })),
  // Un agregado con hijas (las revisiones del archivo, HI-3) cuya lectura por id va acotada por el alcance (HI-7), en sus
  // dos modelos: la fixture es documental.
  ...['relational', 'document'].map((model) => ({
    name: model === 'relational' ? 'vault-history-scoped' : 'vault-history-scoped-mongo',
    from: 'asset-vault',
    mutate(layers) {
      layers.persistence.default = { ...layers.persistence.default, model };
      layers.persistence.audit = { ...layers.persistence.audit, history: ['Asset'] };
      layers['use-cases'].operations.getAssetHistory = historyQuery(
        'Asset',
        { id: { type: 'uuid', required: true } },
        [
          { code: 'ASSET_NOT_FOUND', when: 'No existe un archivo con ese id.', http: 404 },
          { code: 'ASSET_OUT_OF_SCOPE', when: 'El archivo es de un propietario fuera del alcance del custodio.', http: 403 }
        ]
      );
      const { audience } = layers.api.endpoints.getAsset;
      layers.api.endpoints.getAssetHistory = { method: 'GET', path: '/assets/{id}/history', ...(audience ? { audience } : {}) };
      layers.security.authentication.scoping.reads.push('getAssetHistory');
      layers.security.access.rules.getAssetHistory = { ...layers.security.access.rules.getAsset };
    }
  }))
];
