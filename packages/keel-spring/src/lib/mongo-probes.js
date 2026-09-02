// Fuente única de los scripts de `mongosh` que el arnés ejecuta contra la base de prueba.
//
// Mismo papel que broker-probes.js y mail-probes.js, pero por un motivo MÁS fuerte que el de
// aquellos, y conviene tenerlo claro antes de tocar nada de aquí.
//
// En los otros ejes del generador hay una red debajo: `compile-check` compila el arnés con
// javac, así que un paréntesis de más o un tipo que no existe salen ahí. Con un script de
// mongosh **javac no puede ayudar**. El script viaja dentro de un literal Java que compone
// `javaString()`, y esa función escapa siempre: un `updateOne` con las comillas mal, un `$set`
// sobre un campo que en el documento se llama de otra forma, o un `countDocuments` con un
// predicado que no casa nada salen como literal Java perfectamente válido con el script roto
// dentro. Está comprobado rompiéndolo a propósito: compila.
//
// Y lo que un script así produce no es un error, es algo peor: un escenario que pasa en verde
// sin haber probado nada. Un `inFlightWithoutClock` que devuelve siempre cero, un
// `stallInFlight` que no atasca ninguna fila, una espera al drenaje del outbox que vuelve al
// instante porque cuenta cero.
//
// De ahí las dos reglas:
//
//   1. Un script de mongosh **no se escribe en `integration-tests.js`**: se pide aquí. Con una
//      definición sola, el runner de conformidad (`scripts/mongo-check.js`) ejercita
//      EXACTAMENTE lo que el generador emite; si construyera los suyos comprobaría que Mongo
//      responde, que no es lo mismo que comprobar que el generador acierta.
//   2. Tras tocar cualquier cosa de aquí, `npm run mongo-check`. Es lo único que juzga si el
//      script es correcto, no solo si está bien escrito.
//
// **El texto sale CRUDO, sin escapar.** Escapar es trabajo de `javaString()` al componer el
// literal Java, y el runner usa estas cadenas tal cual. Pre-escaparlas aquí produciría el
// doble escape que ya se coló una vez y que solo se ve leyendo el Java generado.

/**
 * Nombres de almacenamiento del outbox, los mismos en los dos modelos de persistencia
 * (los escribe `outbox.js`). Van aquí porque son la mitad del predicado: un script correcto
 * sobre un campo que se llama de otra forma no falla, cuenta cero.
 */
export const OUTBOX = {
  collection: 'outbox_event',
  destination: 'destination',
  eventType: 'event_type',
  publishedAt: 'published_at',
  attempts: 'attempts'
};

/**
 * Los dos relojes del rescate. `new Date(0)` es la época —infinitamente rancio— y `new Date()`
 * el instante de la escritura; la diferencia entre los dos es lo que separa rescatar una fila
 * abandonada de arrancarle el trabajo de las manos a quien lo está haciendo.
 */
export const CLOCK = {
  stale: 'new Date(0)',
  now: 'new Date()'
};

/**
 * Un script partido en dos mitades, para quien lo compone EN EJECUCIÓN.
 *
 * El Java del arnés no puede recibir una cadena cerrada cuando el script lleva dentro un valor
 * que aporta cada escenario (el id de la fila, el tipo de evento): concatena prefijo + valor +
 * sufijo. Es la misma forma que `SEARCH_PREFIX`/`searchSuffix()` en mail-probes.js, y existe
 * por lo mismo — que las dos mitades salgan del mismo sitio que el resto.
 */
const split = (prefix, suffix) => ({ prefix, suffix });

/** Une las dos mitades con el valor de en medio. Lo usa el runner; el generador las escapa. */
export const fill = ({ prefix, suffix }, value) => `${prefix}${value}${suffix}`;

/**
 * Mueve un documento a un estado y le estampa su reloj, en la misma escritura.
 *
 * El id va como `UUID("…")` y no como cadena: el `_id` es un binario, y un literal que no case
 * deja el `updateOne` en cero modificados **sin fallar** — el análogo exacto del `Data too long
 * for column 'id'` que reventó una corrida en la rama relacional, pero silencioso.
 */
export function setStateScript({ collection, stateField, state, clockField, clock }) {
  return split(
    `db.getCollection("${collection}").updateOne({ _id: UUID("`,
    `") }, { $set: { ${stateField}: "${state}", ${clockField}: ${clock} } })`
  );
}

/**
 * Cuántos documentos quedaron en un estado con el reloj SIN estampar.
 *
 * Tiene que discriminar de verdad: un predicado que devolviera siempre cero pasaría el
 * escenario del rescate sin ver el defecto para el que existe.
 */
export function missingClockCountScript({ collection, stateField, state, clockField }) {
  return `db.getCollection("${collection}").countDocuments({ ${stateField}: "${state}", ${clockField}: null })`;
}

/**
 * Cuántos eventos siguen pendientes de entregar para un destino.
 *
 * Se cuenta por el destino FÍSICO que escribe el publicador, no por el canal lógico del
 * diseño: consultar por el canal daba cero siempre, y la espera al drenaje volvía al instante
 * sin esperar a nada.
 */
export function outboxPendingScript() {
  return split(
    `db.getCollection("${OUTBOX.collection}").countDocuments({ ${OUTBOX.destination}: "`,
    `", ${OUTBOX.publishedAt}: null })`
  );
}

/** Agota el presupuesto de reintentos de los eventos pendientes de ese tipo. */
export function abandonOutboxScript(attempts) {
  return split(
    `db.getCollection("${OUTBOX.collection}").updateMany({ ${OUTBOX.eventType}: "`,
    `", ${OUTBOX.publishedAt}: null }, { $set: { ${OUTBOX.attempts}: ${attempts} } })`
  );
}

/**
 * Retira lo abandonado y **solo** lo abandonado: lo pendiente con presupuesto se queda. Si se
 * llevara eso por delante, limpiar el contador de un escenario borraría el trabajo del
 * siguiente.
 */
export function clearAbandonedScript(attempts) {
  return `db.getCollection("${OUTBOX.collection}").deleteMany({ ${OUTBOX.publishedAt}: null, ${OUTBOX.attempts}: { $gte: ${attempts} } })`;
}
