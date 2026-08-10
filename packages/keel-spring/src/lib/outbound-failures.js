/**
 * Qué significa «el proveedor no está» en una llamada saliente.
 *
 * Es UNA pregunta que se contesta en DOS sitios —las sobrecargas del fallback que
 * emite `scaffold/http-clients.js` y el `record-exceptions` del circuito que emite
 * `scaffold/config.js`—, así que la tabla vive aquí y no duplicada en cada emisor.
 * Si divergieran, el circuito se abriría por excepciones que el fallback ya no ve
 * (o al revés), y las dos mitades dirían cosas distintas del mismo suceso.
 *
 * El criterio de la tabla, que es lo que este módulo defiende: al fallback solo
 * llega lo que el proveedor ha hecho —no responder, responder mal, rechazarnos—.
 * Un bug NUESTRO —un NPE, un cast, un cuerpo que no deserializa— NO tiene
 * sobrecarga: resilience4j relanza el original cuando ninguna casa, así que se
 * propaga con su traza en vez de disfrazarse de caída ajena. Ese disfraz es el que
 * mantuvo un defecto de código meses sin diagnosticar (INFORME-CORRIDA-OUTBOX.md,
 * punto 7).
 *
 * Las dos columnas NO son la misma lista, y la asimetría es deliberada: «esto lo
 * atiende la política del diseño» y «esto describe la salud del proveedor» son
 * preguntas distintas. Un 4xx entra al fallback (el proveedor contestó: hay que
 * decidir qué hacer) y no cuenta para el circuito (contestar no es estar caído: un
 * 401 por credencial caducada abriría el circuito culpándole de lo nuestro). El
 * circuito abierto entra al fallback y tampoco cuenta, porque lo lanza el propio
 * circuito y contarlo lo realimentaría consigo mismo.
 *
 * Es el mismo criterio que `retry` ya aplicaba en su `retry-exceptions` /
 * `ignore-exceptions`: aquí solo se unifica y se extiende al circuito y al fallback.
 */

/**
 * Fallo del transporte: connect/read timeout, conexión rechazada, socket roto.
 * Es la señal más limpia de «no hay nadie al otro lado».
 */
const RESOURCE_ACCESS = {
  fqn: 'org.springframework.web.client.ResourceAccessException',
  simple: 'ResourceAccessException',
  reason: 'Fallo de transporte: conexión rechazada, timeout de lectura, DNS.',
  recorded: true
};

/** 5xx: el proveedor contesta, y lo que contesta es que él está roto. */
const SERVER_ERROR = {
  fqn: 'org.springframework.web.client.HttpServerErrorException',
  simple: 'HttpServerErrorException',
  reason: 'El proveedor contestó 5xx.',
  recorded: true
};

/**
 * Status fuera del catálogo estándar. No es un 5xx, pero tampoco es una respuesta
 * que ningún contrato pueda declarar: el proveedor está devolviendo cualquier cosa.
 */
const UNKNOWN_STATUS = {
  fqn: 'org.springframework.web.client.UnknownHttpStatusCodeException',
  simple: 'UnknownHttpStatusCodeException',
  reason: 'El proveedor contestó un status que no existe en el estándar.',
  recorded: true
};

/**
 * 4xx: el proveedor RECHAZA la petición. Entra al fallback —hay que decidir qué
 * hacer y esa decisión es la del diseño— pero NO cuenta para el circuito: contestar
 * no es estar caído, y un 4xx sistemático (una credencial caducada) es nuestro.
 *
 * No se propaga como un bug, aunque a menudo lo sea, porque un rechazo tiene
 * significado: un 404 es «no existe» y un 409 un conflicto suyo. Traducir eso a la
 * excepción de dominio que dicte el diseño es trabajo del agente con `.onStatus(...)`
 * en el adaptador, y adelantarlo aquí sería inventar contrato.
 */
const CLIENT_ERROR = {
  fqn: 'org.springframework.web.client.HttpClientErrorException',
  simple: 'HttpClientErrorException',
  reason: 'El proveedor RECHAZA la petición (4xx): contestó, no está caído.',
  // Registra su propia línea antes de delegar: llamarlo «no disponible» a secas sería
  // el mismo error de diagnóstico, más pequeño, que el que esta tabla corrige.
  rejection: true,
  recorded: false
};

/**
 * Circuito abierto. Va al fallback pero NO a `record-exceptions`: resilience4j ya
 * la excluye de su propia ventana (contarla realimentaría el circuito consigo
 * mismo). Sin esta sobrecarga, abrir el circuito le estampa al llamante una
 * excepción cruda de resilience4j en vez de la política que declaró el diseño.
 */
const CALL_NOT_PERMITTED = {
  fqn: 'io.github.resilience4j.circuitbreaker.CallNotPermittedException',
  simple: 'CallNotPermittedException',
  reason: 'El circuito está abierto: la llamada ni se intentó.',
  recorded: false
};

/**
 * Excepciones que el fallback de una llamada debe atender, en el orden en que se
 * emiten las sobrecargas.
 *
 * `circuitBreaker` gobierna si entra `CallNotPermittedException`: sin circuito no
 * puede lanzarse, y declararla dejaría un import de resilience4j sin motivo.
 *
 * SIEMPRE devuelve dos o más. No es casual y no debe «optimizarse» a una:
 * resilience4j comprueba el tipo del último parámetro solo cuando hay VARIOS
 * métodos de fallback; con uno solo lo invoca sea cual sea la excepción, que es
 * exactamente el embudo que esta tabla existe para cerrar.
 */
export function providerFailures({ circuitBreaker = false } = {}) {
  const failures = [RESOURCE_ACCESS, SERVER_ERROR, UNKNOWN_STATUS, CLIENT_ERROR];
  return circuitBreaker ? [CALL_NOT_PERMITTED, ...failures] : failures;
}

/**
 * FQN que llenan la ventana del circuito (`resilience4j.circuitbreaker.instances.
 * <x>.record-exceptions`).
 *
 * Es una whitelist a propósito: la pregunta es «qué cuenta como fallo del
 * proveedor», y esa lista es cerrada, mientras que la de los bugs posibles no lo
 * es. La contrapartida de `record-exceptions` es que lo NO listado cuenta como
 * éxito —un NPE recurrente no abre el circuito—, y es aceptable justo porque ese
 * NPE ya no se lo traga nadie: sin sobrecarga en el fallback, propaga y se ve.
 */
export function recordedFailures() {
  return providerFailures({ circuitBreaker: true })
    .filter((failure) => failure.recorded)
    .map((failure) => failure.fqn);
}
