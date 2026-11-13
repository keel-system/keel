// Los diseños DERIVADOS con los que se mide el ciclo de vida del dato (DSL 2.28: `personal`, `deletion: logical`,
// `restorableFor`/`restores` y `retention`) en los cuatro generadores, el mismo patrón que read-scope-designs.js.
//
// Desde el incremento 6 de PLAN-DSL-228-CICLO-DE-VIDA.md las fixtures lo declaran: profile-directory v1.1.0 (email
// personal y único, borrado lógico, restauración y purga a los 30 días del borrado) y verification-codes[-mongo] v1.1.0
// (email personal, retención con `anonymize`). Estos sujetos miden lo que las fixtures no tienen: la rama documental de
// la ficha, la otra salida de la retención y la composición con la lectura acotada (LC-10).

import { withoutHistory } from './history-designs.js';

/**
 * La ficha tal como la declara profile-directory, sobre el modelo de persistencia `model`, sin el historial de la v1.2.0
 * (DSL 2.29): estos sujetos miden el ciclo de vida solo, y el historial con él lo miden los de history-designs.js.
 */
function cardsLogical(layers, model) {
  withoutHistory(layers);
  layers.persistence.default = { ...layers.persistence.default, model };
}

/** El código con email personal y su retención: 30 días desde que se emitió, y después `then` (la fixture, `anonymize`). */
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

/**
 * El sujeto de PD-3, la app ARRANCADA con telemetría: el código con email personal y ÚNICO, sin seguridad, para que dos
 * altas por HTTP con el mismo valor lleguen a violar la constraint en el motor. No está en DATA_LIFECYCLE_DESIGNS: las sondas
 * de los adaptadores no lo necesitan, y solo lo usan los `telemetry-check`. El handler de `issueCode` lo escribe la propia
 * sonda (es código del agente), así que lo que mide es lo que escribe build: los logs, los spans y la traducción del error.
 */
export const PERSONAL_TELEMETRY_DESIGN = {
  name: 'codes-personal',
  from: 'verification-codes',
  mutate(layers) {
    codesRetention(layers, 'anonymize');
    layers.domain.entities.VerificationCode.fields.email.unique = true;
    layers['use-cases'].operations.issueCode.errors = [
      { code: 'EMAIL_ALREADY_EXISTS', when: 'Ya hay un código emitido para esa dirección.', http: 409 }
    ];
  }
};

/** Un valor personal reconocible y distinto en cada corrida: lo que PD-3 busca en todo lo que sale de la app. */
export const personalSentinel = (suffix) => `pd3-${suffix}@example.com`;

/**
 * El diseño SIN nada de la 2.28: ningún campo `personal`, borrado físico escrito donde había `deletion`, y fuera
 * `restorableFor`, `retention` y las operaciones que restauran (con su endpoint y su regla de acceso). La base explícita de
 * «sin ciclo de vida» desde que las fixtures lo declaran: antes la daban profile-directory y verification-codes tal cual.
 */
export function withoutLifecycle(layers) {
  for (const entity of Object.values(layers.domain?.entities ?? {})) {
    for (const field of Object.values(entity.fields ?? {})) delete field.personal;
  }
  for (const entity of Object.values(layers.persistence?.entities ?? {})) {
    if (entity.deletion !== undefined) entity.deletion = 'physical';
    delete entity.restorableFor;
    delete entity.retention;
  }
  const operations = layers['use-cases']?.operations ?? {};
  for (const [name, operation] of Object.entries(operations)) {
    if (!operation.restores) continue;
    delete operations[name];
    delete layers.api?.endpoints?.[name];
    delete layers.security?.access?.rules?.[name];
  }
}
