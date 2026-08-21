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

/**
 * El error que el diseño declara para la UNICIDAD de una clave natural concreta.
 *
 * Se busca SOLO entre los errores de las operaciones que escriben esa entidad, y ese
 * acotado es el punto entero de esta función. Buscar por nombre en todo el servicio —lo
 * que se hacía antes— no es que fallara por defecto: fallaba por exceso. La familia sale
 * de los CAMPOS de la clave, y el diseñador nombra sus errores por la ENTIDAD, así que la
 * clave natural (application, code) de EmailTemplate casaba con el
 * APPLICATION_CODE_ALREADY_EXISTS de Application —el error de OTRA entidad— y el
 * conflicto de una plantilla duplicada salía por el cable con el código de una aplicación
 * duplicada. Un fallo silencioso y con toda la pinta de estar bien.
 *
 * Dos pasadas, de más precisa a menos, y las dos dentro del acotado:
 *   1. la familia derivada de los campos, por si el diseño nombra el error por ellos;
 *   2. cualquier error 409 de esa entidad cuyo código diga «ya existe» — y esta SOLO si la
 *      entidad tiene una única clave con unicidad (`soleConstraint`). Con dos, «el error de
 *      ya existe de esta entidad» deja de ser una descripción y pasa a ser una apuesta: una
 *      Product con clave natural `sku` y un `slug` único también acabaría mandando el
 *      conflicto del slug por el código del sku. Ahí no se elige.
 * Con cero o con más de uno no se elige: el emisor deja su TODO, que es lo honesto
 * cuando el diseño no lo dijo o dijo algo ambiguo.
 */
export function declaredUniquenessErrorFor(model, entry, entity, fields, { soleConstraint = false } = {}) {
  const scoped = errorsWrittenBy(model, entity);
  if (scoped.length === 0) return null;
  const byFields = pickOne(scoped, entry, entry.familyFor(screamingSnake(fields.join('_'))));
  if (byFields || !soleConstraint) return byFields;
  return pickOne(scoped, entry, /(^|_)ALREADY_EXISTS$/);
}

/** Los errores declarados por las operaciones cuyo grupo es esa entidad. */
function errorsWrittenBy(model, entity) {
  const codes = new Set(
    (model.services ?? [])
      .filter((service) => service.entity === entity)
      .flatMap((service) => service.operations.flatMap((operation) => operation.errors ?? []))
      .map((code) => screamingSnake(code))
  );
  return (model.errors ?? []).filter((error) => codes.has(screamingSnake(error.code)));
}

function pickOne(errors, entry, family) {
  const normalized = errors.map((error) => ({ ...error, code: screamingSnake(error.code) }));
  const match = overrideFor(normalized, entry, family);
  return match ? errors[normalized.indexOf(match)] : null;
}
