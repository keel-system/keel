// Por qué puerta entra una operación: neutral, la misma decisión en keel-spring, keel-nest y keel-dotnet.
//
// Una operación puede tener varias puertas: su endpoint (HTTP), una suscripción que la dispara, otra operación que la
// despacha (`dispatches`) y su reloj (`schedule`). Casi siempre da igual por cuál llegó. Pero HTTP es la ÚNICA puerta
// que puede responder un error a quien la llamó: por las demás no hay nadie esperando la respuesta, y lo que por HTTP
// es un 422 tiene que quedar en el estado (un cobro `failed` y su evento). El diseño lo dice en sus reglas («por
// HTTP…», «por la suscripción…»), y el handler no tenía cómo saberlo: el mensaje no decía por dónde había llegado.
// Cinco corridas de payment-checkout (`requestCharge`) lo resolvieron a mano de cinco formas —un campo añadido al
// mensaje, un contexto propio, un AsyncLocal, el listener— en los tres generadores.
//
// La pieza: cuando una operación entra por HTTP Y por alguna otra puerta, su mensaje lleva `entryGate`, obligatorio, que
// el endpoint generado fija a HTTP y que la nota de la suscripción (o del despacho) dicta con su valor. Obligatorio en
// los tres lenguajes: quien construya el mensaje sin decir su puerta no compila. Sin HTTP entre sus puertas no se emite:
// ninguna puerta puede responder, así que el handler no tiene nada que distinguir (`quarantineAsset` de asset-vault,
// suscripción y despacho, se comporta igual por las dos).

/** El nombre del campo del mensaje (camelCase; cada generador lo proyecta a su convención). */
export const ENTRY_GATE_FIELD = 'entryGate';

/** Los valores del enum `EntryGate`, como constantes del cable de los tres lenguajes. */
export const ENTRY_GATES = ['HTTP', 'SUBSCRIPTION', 'DISPATCH', 'SCHEDULE'];

/** Las puertas por las que entra una operación: `{ gate, by }`, con `by` el nombre de la suscripción o de quien despacha. */
export function entryGates(model, operation) {
  const gates = [];
  if (operation.route) gates.push({ gate: 'HTTP', by: null });
  for (const subscription of model.subscriptions ?? []) {
    if (subscription.trigger === operation.name) gates.push({ gate: 'SUBSCRIPTION', by: subscription.name });
  }
  for (const other of allOperations(model)) {
    if ((other.dispatches ?? []).includes(operation.name)) gates.push({ gate: 'DISPATCH', by: other.name });
  }
  if (operation.schedule) gates.push({ gate: 'SCHEDULE', by: null });
  return gates;
}

/** ¿Lleva el mensaje de esta operación su puerta? Con HTTP y alguna otra: es la única puerta que responde. */
export function carriesEntryGate(model, operation) {
  const gates = entryGates(model, operation);
  return gates.some((entry) => entry.gate === 'HTTP') && gates.length > 1;
}

/** ¿Emite el servicio el enum `EntryGate`? Cuando algún mensaje lo lleva. */
export function usesEntryGate(model) {
  return allOperations(model).some((operation) => carriesEntryGate(model, operation));
}

/**
 * La nota del handler de una operación que lleva su puerta, o null. `read` es cómo se lee en el lenguaje del generador
 * (`command.entryGate()`, `command.entryGate`, `command.EntryGate`) y `value(gate)` cómo se escribe una constante.
 */
export function entryGateNote(model, operation, { read, value }) {
  if (!carriesEntryGate(model, operation)) return null;
  const others = entryGates(model, operation)
    .filter((entry) => entry.gate !== 'HTTP')
    .map((entry) => `${value(entry.gate)}${entry.by ? ` (${entry.by})` : ''}`);
  return (
    `Esta operación entra por HTTP y por ${others.join(', ')}: ${read} dice por cuál llegó este mensaje (lo fija quien lo ` +
    `construye: el endpoint generado pone ${value('HTTP')}). Las reglas del diseño que distinguen las puertas («por HTTP…», ` +
    '«por la suscripción…») se deciden con él, nunca deduciéndolo de otra cosa: HTTP es la única puerta que puede responder ' +
    'un error a quien llamó, y por las demás el desenlace tiene que quedar en el estado.'
  );
}

/** El valor que dicta la nota de una suscripción o de un despacho, o null si el mensaje no lleva su puerta. */
export function entryGateFor(model, operation, gate) {
  return carriesEntryGate(model, operation) ? gate : null;
}

function allOperations(model) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []);
}
