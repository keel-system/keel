// El vocabulario neutro de la capa payments: lo que el diseño puede saber de un cobro sin saber con
// qué pasarela se hizo.
//
// Existe porque el motivo de un fallo es lo único de un desenlace que la pasarela expresa con su
// propio idioma —códigos de rechazo del emisor, de la red, del antifraude—, y con texto libre cada
// adaptador escribiría el suyo: el mismo diseño se comportaría distinto según la pasarela, que es
// justo lo que la capa promete que no pasa. El diseño declara un enum con EXACTAMENTE estos valores
// (`record.failureReason`, CHK-PAYMENTS-FAILURE-VOCABULARY) y cada generador traduce a ellos los
// códigos de cada pasarela. Lista cerrada: un motivo nuevo es un cambio del DSL, no de un adaptador.

export const FAILURE_REASONS = Object.freeze([
  'declined', // el emisor rechazó sin dar motivo útil
  'insufficientFunds',
  'expiredCard',
  'authenticationFailed', // el cliente no completó o falló la autenticación (3DS)
  'fraudSuspected', // lo paró el antifraude de la pasarela o del emisor
  'invalidPaymentMethod', // el medio no sirve: token inválido o caducado, medio retirado, de otro titular
  'notReceived', // la pasarela no conoce el cobro: la petición no llegó nunca
  'processingError' // fallo de la pasarela o de la red de tarjetas, no del medio
]);
