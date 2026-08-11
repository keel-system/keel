// Puente entre el catálogo de errores del framework (keel-core) y el modelo de este
// generador.
//
// El catálogo dice qué código emite cada mecanismo cuando el diseño no nombra su conflicto,
// y `overrideFor` resuelve cuándo el diseño sí lo nombra: familia, status y un solo
// candidato. Lo que falta a este lado es la traducción —normalizar la caja del `code`, que
// el diseño escribe como quiera, y devolver el error del MODELO, que es el que lleva la
// `exceptionClass` con la que se construye el Java—.
//
// Vive aparte porque lo consumen dos emisores (`controllers.js` y `http-idempotency.js`) y
// escrito dos veces se separa al primer matiz: qué status cuenta, qué hacer con dos
// candidatos. Es el mismo criterio que `broker-probes.js` aplica a los comandos de broker.

import { overrideFor } from 'keel-core';
import { screamingSnake } from './naming.js';

/**
 * El error del diseño que sustituye a un código canónico, o `null` si no lo hay.
 *
 * @param {object} model modelo del servicio (usa `model.errors`)
 * @param {object} entry entrada de FRAMEWORK_ERRORS
 * @param {RegExp} [family] familia explícita, para los canónicos derivados (la unicidad)
 */
export function declaredErrorFor(model, entry, family) {
  const errors = model.errors ?? [];
  const normalized = errors.map((error) => ({ ...error, code: screamingSnake(error.code) }));
  const match = overrideFor(normalized, entry, family);
  return match ? errors[normalized.indexOf(match)] : null;
}

/** El `code` que va a salir por el cable: el del diseño si lo hay, y si no el canónico. */
export function effectiveErrorCode(model, entry, family) {
  return declaredErrorFor(model, entry, family)?.code ?? entry.code;
}
