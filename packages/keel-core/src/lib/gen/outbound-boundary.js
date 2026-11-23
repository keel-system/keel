// La frontera transaccional de una operación que encarga trabajo a otro servidor y lo deja esperando. Neutral: la
// comparten los cuatro generadores.
//
// La garantía de esas operaciones es un ORDEN de commits —dejar la entidad en su estado de espera con la marca
// `awaitingSince` y confirmar, llamar al proveedor fuera de toda transacción, aplicar la respuesta en otra escritura—
// y no una transacción única. Dentro de la del mediator, la espera no existe para el barrido hasta después de la
// llamada, y si la llamada va bien y el commit falla, el otro servidor trabajó y aquí no queda nada que reconciliar.
// La pasarela de pagos lo tenía desde sus dos corridas (`callsPaymentGateway`); la corrida order de prueba-gelsa
// (G5) lo encontró en una activación HTTP corriente: `createOrder` y `cancelOrder` disparan `chargeOrder` y
// `cancelOrderPayment`, con `awaitingSince` y `reconciledBy`, y el agente cambió el controller a mano. El diseño ya
// lo dice todo; no hace falta DSL.

import { callsPaymentGateway } from './payments-model.js';

/**
 * Las activaciones HTTP que la operación dispara y deja esperando: `awaitingSince` y `awaits: acknowledgement`. Con
 * `awaits: outcome` el veredicto del proveedor DECIDE la transición y no se escribe nada antes de llamar (la nota de
 * orden de cada generador), así que no hay espera que confirmar.
 */
export function awaitedOutboundActivations(operation) {
  return (operation?.dependencyActivations ?? []).filter(
    ({ activation }) => activation.http && activation.awaitingSince && activation.awaits === 'acknowledgement'
  );
}

/**
 * ¿Se despacha SIN transacción abarcadora? Las acciones de la pasarela y el barrido de pagos, y toda operación que
 * dispara una activación HTTP con `awaitingSince`. Los barridos de una activación (`reconciles`) ya iban sin ella por
 * su planificador (`scheduleDispatch`).
 */
export function commitsBeforeOutbound(model, operationName) {
  if (callsPaymentGateway(model, operationName)) return true;
  const operation = (model.services ?? []).flatMap((service) => service.operations ?? []).find((op) => op.name === operationName);
  return awaitedOutboundActivations(operation).length > 0;
}

/**
 * La nota del handler de una operación con activaciones esperadas, o null. La de pagos y la del barrido las escribe
 * cada generador con lo suyo; esta es la de una activación corriente.
 */
export function outboundBoundaryNote(model, operation) {
  if (callsPaymentGateway(model, operation.name) || (operation.reconciles ?? []).length > 0) return null;
  const awaited = awaitedOutboundActivations(operation);
  if (awaited.length === 0) return null;
  const list = awaited
    .map(({ dependency, activation }) => `${dependency}.${activation.name} (marca ${activation.awaitingSince})`)
    .join(', ');
  return (
    `SIN TRANSACCIÓN ABARCADORA: el mediator despacha este caso de uso sin transacción porque encarga ${list} y lo ` +
    'deja esperando. El orden es de commits: guarda la entidad en su estado de espera con la marca estampada y ' +
    'confírmalo; llama después, fuera de toda transacción; y aplica la respuesta en otra escritura. Cada escritura ' +
    'del repositorio confirma la suya. Dentro de una sola transacción la espera no existe para el barrido hasta ' +
    'después de la llamada, y si la llamada va bien y el commit falla, el otro servidor trabajó y aquí no queda nada ' +
    'que reconciliar'
  );
}
