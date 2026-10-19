// El despacho de un caso de uso desde otro: cuándo hace falta el puerto `CommandDispatcher` y qué le dice al
// handler que despacha. Neutral: keel-spring y keel-nest emiten el mismo puerto y la misma nota.
//
// Hasta el DSL 2.21 el puerto se emitía solo para las operaciones internas que NADIE dispara (ni schedule, ni
// endpoint, ni suscripción): build sabía que alguien tenía que llamarlas, pero no quién. El caso que eso dejaba
// fuera es el de una operación que SÍ tiene su propio disparador y además la despacha otra —el barrido de
// asset-vault pone en cuarentena con la misma operación que dispara la suscripción—: lo decía una regla en
// prosa, y en las cuatro corridas del incremento 13 el agente escribió y cableó el despachador a mano.
// `operations.<op>.dispatches` es ese enlace.

import { scheduleDispatch } from './scheduling.js';
import { ENTRY_GATE_FIELD, carriesEntryGate } from './entry-gates.js';

/** Las operaciones internas a las que no llega ningún disparador generado ni nadie declara despachar. */
export function orphanInternalOperations(model) {
  const bySubscription = new Set((model.subscriptions ?? []).map((subscription) => subscription.trigger).filter(Boolean));
  const dispatched = new Set(allOperations(model).flatMap((operation) => operation.dispatches ?? []));
  return allOperations(model).filter(
    (operation) => operation.internal && !operation.schedule && !bySubscription.has(operation.name) && !dispatched.has(operation.name)
  );
}

/** Las operaciones que declaran `dispatches`. */
export function dispatchingOperations(model) {
  return allOperations(model).filter((operation) => (operation.dispatches ?? []).length > 0);
}

/**
 * ¿Hace falta el puerto CommandDispatcher? Para las operaciones internas huérfanas, para las que declaran
 * `dispatches`, y con la capa payments (el aplicador de desenlaces despacha la operación que aplica cada uno).
 */
export function usesCommandDispatcher(model) {
  return orphanInternalOperations(model).length > 0 || dispatchingOperations(model).length > 0 || Boolean(model.payments);
}

/**
 * La nota del handler que despacha. `call` es cómo se escribe la llamada en el lenguaje del generador, con
 * `{variant}` y `{message}` por sustituir (`commandDispatcher.{variant}(new {message}(...))`).
 */
export function dispatchNote(model, operation, { call }) {
  const targets = (operation.dispatches ?? [])
    .map((name) => allOperations(model).find((candidate) => candidate.name === name))
    .filter(Boolean);
  if (targets.length === 0) return null;
  const render = (variant, target) => call.replace('{variant}', variant).replace('{message}', target.messageClass);
  // Un invocado que también entra por HTTP lleva su puerta en el mensaje (entry-gates.js): aquí es DISPATCH.
  const gate = (target) => (carriesEntryGate(model, target) ? `, con ${ENTRY_GATE_FIELD} DISPATCH` : '');
  const listed = targets.map((target) => `${target.name} (${render('dispatch', target)}${gate(target)})`).join(', ');
  const transaction =
    operation.schedule && scheduleDispatch(model, operation).withoutTransaction
      ? 'Esta operación es un barrido que corre SIN transacción abarcadora: cada dispatch(...) abre y confirma la del invocado, así que un candidato que falla no deshace los demás.'
      : 'dispatch(...) une el invocado a la transacción de esta operación: atómico con su trabajo, y si una de las dos falla, revierten las dos.';
  return (
    `Despacha (use-cases.dispatches): ${listed}. Construye su mensaje y pásalo por el CommandDispatcher, que ya está inyectado; ` +
    'nunca llames a su handler directamente ni repitas aquí su lógica: sus guardas, su idempotencia y los eventos que emite son suyos. ' +
    `${transaction} Usa dispatchWithoutTransaction(...) cuando el invocado haga I/O externo (un correo, una llamada a un proveedor) ` +
    'y no deba retener la transacción ni la conexión durante esa latencia. Cuándo despachar y con qué datos lo dicen las reglas.'
  );
}

function allOperations(model) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []);
}
