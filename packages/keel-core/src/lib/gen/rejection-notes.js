// Las notas que los handlers y los listeners llevan sobre los dos «no» del DSL 2.20, como TEXTO NEUTRAL:
// las emiten igual keel-spring y keel-nest en el stub de cada operación y en la documentación de cada
// mensaje de suscripción. Escritas en cada generador divergirían, que es justo lo que las corridas
// payment-checkout del 2026-10-09 midieron: con la decisión fuera de la nota, cada agente eligió la suya.

/** La acción de la capa payments que ejecuta esta operación, o null. */
function followUpOf(payments, operationName) {
  if (!payments) return null;
  for (const action of ['capture', 'void', 'refund']) {
    if (payments[action]?.operation === operationName) return { action, spec: payments[action] };
  }
  return null;
}

/**
 * Qué hace el handler de una acción de seguimiento cuando la pasarela CONTESTA QUE NO
 * (`payments.<acción>.onRejected`), o null si la operación no es una acción de seguimiento o el diseño no lo
 * decidió (entonces lo dice la obligación OBL-PAYMENTS-FOLLOWUP-REJECTED, no una nota).
 */
export function followUpRejectionNote(payments, operationName) {
  const found = followUpOf(payments, operationName);
  if (!found || found.spec.onRejected == null) return null;
  const { action, spec } = found;
  const where = `payments.${action}.onRejected`;
  if (spec.onRejected === 'reconcile') {
    return (
      `Si la pasarela CONTESTA QUE NO (${where}: reconcile): el cobro se queda en ${spec.inFlight}, la operación ` +
      'responde con él y el barrido lo devuelve a su estado al consultar. No lo devuelvas tú ni respondas un error.'
    );
  }
  const origin = spec.origin?.length ? spec.origin.join(' o ') : 'el estado del que salió';
  return (
    `Si la pasarela CONTESTA QUE NO (${where}): el cobro sale de ${spec.inFlight} y vuelve a ${origin}, con su ` +
    `marca de espera vacía, y la operación responde ${spec.onRejected.error}. Es distinto de que no conteste ` +
    '(PaymentGatewayUnavailableException: se queda en vuelo para el barrido) y de que la pasarela dé el cobro ' +
    'en otro desenlace al rechazar (capturado, anulado): entonces se aplica ESE desenlace, no la vuelta.'
  );
}

/**
 * Qué hace el listener con los rechazos de negocio que el diseño declara como «atendido»
 * (`onFailure.acknowledgeOn`), o null si no declara ninguno.
 */
export function acknowledgeNote(subscription) {
  const codes = subscription?.acknowledgeOn ?? [];
  if (codes.length === 0) return null;
  return (
    `Con onFailure.acknowledgeOn (${codes.join(', ')}): si la operación disparada rechaza el mensaje con ` +
    `${codes.length === 1 ? 'ese error' : 'uno de esos errores'}, el mensaje queda ATENDIDO — confírmalo sin ` +
    'efecto, sin reintentarlo y sin mandarlo al descarte: es un resultado ya conocido (un duplicado ya ' +
    'resuelto), no un fallo que alguien tenga que mirar. Cualquier otro rechazo de negocio no se reintenta y ' +
    'va al descarte.'
  );
}
