// Fuente única de la API con la que se consulta el buzón de prueba (Mailpit).
//
// Mismo papel que broker-probes.js y por el mismo motivo: estas rutas acaban
// incrustadas como literales en el Java del arnés, y son la clase de cosa que
// ningún test de cadenas puede juzgar. Un endpoint mal escrito, un parámetro de
// búsqueda que la versión de la imagen no acepta o un campo de la respuesta que se
// llama de otra forma pasan todos los `includes(...)` y solo se ven contra un
// Mailpit de verdad — al precio de una corrida entera del pipeline.
//
// Con una definición sola, el runner de conformidad (`scripts/mail-check.js`)
// ejercita EXACTAMENTE las rutas que el generador emite. Si construyera las suyas
// comprobaría que Mailpit responde, que no es lo mismo que comprobar que el
// generador acierta.
//
// Dos vistas del mismo servicio, y la diferencia es de RED, no de contrato:
//   * el arnés corre en el host y habla con el puerto publicado (localhost:8025),
//     igual que ya hace con WireMock en localhost:8090;
//   * reset-db.sh corre dentro del contenedor devtools y habla por el nombre de
//     servicio de la red del compose (mailpit:8025).

/** Puerto HTTP de la API y de la interfaz web; el 1025 es el SMTP al que apunta la app. */
export const HTTP_PORT = 8025;
export const SMTP_PORT = 1025;

/** Nombre del servicio en infra/docker-compose.yaml (el hostname dentro de la red). */
export const SERVICE = 'mailpit';

/** Base de la API desde el host (arnés) y desde la red del compose (devtools). */
export const HOST_BASE = `http://localhost:${HTTP_PORT}/api/v1`;
export const NETWORK_BASE = `http://${SERVICE}:${HTTP_PORT}/api/v1`;

/**
 * Rutas de la API, relativas a una de las dos bases.
 *
 * `search` es la que hace el trabajo del arnés: filtra por destinatario sin traerse
 * el buzón entero. La sintaxis del término (`to:<dirección>`) es de Mailpit y va
 * aquí y no en el Java por lo mismo que todo lo demás: es lo que hay que cambiar si
 * cambia la imagen, y tiene que cambiar en un solo sitio.
 *
 * `message` devuelve el mensaje COMPLETO —las dos partes del cuerpo, las cabeceras—
 * que la búsqueda no trae: el listado solo lleva el resumen. Sin esa segunda
 * llamada no se puede afirmar sobre el HTML ni sobre la alternativa textual, que es
 * justo lo que separa «ha salido un correo» de «ha salido el correo correcto».
 */
export const ROUTES = {
  /** Sondeo: responde en cuanto la API está en pie. */
  info: () => '/info',
  /** Mensajes que casan con un término de búsqueda, más recientes primero. */
  search: (query, limit = SEARCH_LIMIT) => `/search?query=${encodeURIComponent(query)}${searchSuffix(limit)}`,
  /** Un mensaje completo por su id. */
  message: (id) => `/message/${id}`,
  /** Vacía el buzón entero (DELETE). */
  messages: () => '/messages'
};

/** Término de búsqueda por destinatario, tal como lo entiende Mailpit. */
export function toQuery(address) {
  return `to:${address}`;
}

// La búsqueda partida en dos mitades, para quien compone la URL EN EJECUCIÓN: el
// Java del arnés no puede usar ROUTES.search() —la dirección la aporta cada
// escenario y hay que codificarla allí—, así que concatena prefijo + término
// codificado + sufijo. Sale de aquí y no de dos literales en el Java por lo mismo
// que todo lo demás de este módulo: si el parámetro cambia de nombre, cambia una vez.
export const SEARCH_PREFIX = '/search?query=';
export const SEARCH_LIMIT_PARAM = '&limit=';

/**
 * Techo de una búsqueda, y a la vez el punto donde el arnés decide repaginar.
 *
 * No es una preferencia: `limit` recorta la lista de mensajes de la respuesta, así que
 * un escenario de volumen que mande más correos que este número a la misma dirección
 * ve un conteo plano y ningún cambio en el servidor lo arregla. Quien lea la búsqueda
 * tiene que mirar además `FIELDS.searchTotal` —el conteo de los que CASAN, sin
 * recortar— y volver a pedir con ese total si lo supera. Ocurrió tal cual en una
 * corrida real con el valor anterior, 50.
 */
export const SEARCH_LIMIT = 200;
export const searchSuffix = (limit = SEARCH_LIMIT) => `${SEARCH_LIMIT_PARAM}${limit}`;

/** Comando de sondeo desde devtools (curl dentro de la red del compose). */
export function validateCommand() {
  return `curl -sf -o /dev/null ${NETWORK_BASE}${ROUTES.info()}`;
}

/** Comando de purga desde devtools: deja el buzón como recién arrancado. */
export function resetCommand() {
  return `curl -sf -o /dev/null -XDELETE ${NETWORK_BASE}${ROUTES.messages()}`;
}

/**
 * Campos de la respuesta que el arnés lee, con su ruta JSONPath.
 *
 * Están aquí y no dispersos por el Java porque son contrato con la imagen: el día
 * que Mailpit renombre `Snippet` o mueva `HTML`, el arnés deja de encontrar lo que
 * busca y el síntoma es un `Then` que falla por un motivo que no tiene que ver con
 * el servicio. `mail-check.js` los verifica contra un mensaje real.
 */
export const FIELDS = {
  /** Del listado de búsqueda. */
  searchTotal: '$.messages_count',
  searchIds: '$.messages[*].ID',
  searchFirstId: '$.messages[0].ID',
  /** Del mensaje completo. */
  subject: '$.Subject',
  html: '$.HTML',
  text: '$.Text',
  from: '$.From.Address',
  to: '$.To[*].Address'
};
