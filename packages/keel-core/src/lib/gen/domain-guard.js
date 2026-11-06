// ¿Hay una guarda EN EL DOMINIO detrás de una operación disparada por una suscripción?
//
// Lo preguntan dos sitios que tienen que contestar lo mismo: el modelo (`triggerHasDomainGuard` y
// `triggerGuardKind` de cada suscripción, que deciden el ORDEN del registro de idempotencia del
// listener y, con él, lo que prescribe el gate de `check-idempotency.sh`) y la validación
// (`crossrefs.js`, que avisa con CHK-MSG-RETRY-AFTER-CLAIM cuando una suscripción reintenta sobre una
// operación sin guarda). Escrito dos veces, el día que uno aprendiera una forma nueva de guarda y el
// otro no, `keel validate` avisaría de unos reintentos muertos que el generador ya no deja muertos.
//
// Con guarda, el listener procesa y LUEGO registra: un fallo pasajero no deja marca y se reintenta.
// Sin ella, la única forma de no repetir el efecto es reclamar ANTES (`tryRecord`), y entonces el
// reintento de un fallo posterior al reclamo ve el mensaje como procesado y no hace nada.

import { guardedByNaturalKey } from './natural-key-guard.js';

/**
 * Qué guarda frena la repetición de la operación `opName`, o `null` si ninguna:
 * - `transitions`: el lifecycle del agregado (la transición no se aplica dos veces);
 * - `natural-key`: la idempotencia `payload-field` cuyo campo guardado (`storedIn ?? keyField`)
 *   participa en `naturalKey`, la clave natural de la entidad que la operación escribe;
 * - `payment-reference`: la operación es el cobro de la capa payments, cuya referencia es clave natural
 *   del registro (CHK-PAYMENTS-REFERENCE-UNGUARDED lo exige).
 */
export function domainGuardKind(opName, op, naturalKey, layers) {
  if (!op) return null;
  if ((op.transitions ?? []).length > 0) return 'transitions';
  if (guardedByNaturalKey(op.idempotency, naturalKey)) return 'natural-key';
  if (Boolean(opName) && layers?.payments?.charge?.operation === opName) return 'payment-reference';
  return null;
}
