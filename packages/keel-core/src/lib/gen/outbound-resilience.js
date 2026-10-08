// La resiliencia de una llamada saliente (`http-clients.<cliente>.calls.<llamada>`), como DATOS: qué
// significa «el proveedor no está», qué reintenta el retry, qué llena la ventana del circuito y con qué
// números se gobierna cada mecanismo cuando el diseño no los escribe.
//
// Es lo mismo en los dos generadores —el servidor de keel-spring (resilience4j) y el de keel-nest
// (cockatiel) del mismo diseño tienen que reintentar lo mismo, abrir el circuito por lo mismo y caer
// al fallback por lo mismo—, así que se decide aquí y no en cada emisor. Lo que cambia entre lenguajes
// es solo el NOMBRE de cada fallo (la excepción de Spring, el error de `fetch`): cada generador lo
// proyecta desde el `kind`.

// ─── Qué significa «el proveedor no está» ────────────────────────────────────
//
// Es UNA pregunta que se contesta en DOS sitios de cada servidor —las ramas del fallback y lo que
// cuenta el circuito—, y si divergieran el circuito se abriría por fallos que el fallback ya no ve (o
// al revés). El criterio: al fallback solo llega lo que el proveedor ha hecho —no responder, responder
// mal, rechazarnos—. Un bug NUESTRO (un null, un cuerpo que no deserializa) NO tiene rama: se propaga
// con su traza en vez de disfrazarse de caída ajena. Ese disfraz es el que mantuvo un defecto de
// código meses sin diagnosticar (INFORME-CORRIDA-OUTBOX.md, punto 7).
//
// Las dos columnas NO son la misma lista, y la asimetría es deliberada: «esto lo atiende la política
// del diseño» y «esto describe la salud del proveedor» son preguntas distintas. Un 4xx entra al
// fallback (el proveedor contestó: hay que decidir qué hacer) y no cuenta para el circuito (contestar
// no es estar caído: un 401 por credencial caducada abriría el circuito culpándole de lo nuestro). El
// circuito abierto entra al fallback y tampoco cuenta, porque lo lanza el propio circuito y contarlo
// lo realimentaría consigo mismo.

/** Fallo del transporte: conexión rechazada, timeout de lectura, DNS. La señal más limpia de «no hay nadie». */
const TRANSPORT = Object.freeze({
  kind: 'transport',
  reason: 'Fallo de transporte: conexión rechazada, timeout de lectura, DNS.',
  recorded: true
});

/** 5xx: el proveedor contesta, y lo que contesta es que él está roto. */
const SERVER_ERROR = Object.freeze({
  kind: 'server-error',
  reason: 'El proveedor contestó 5xx.',
  recorded: true
});

/**
 * Status fuera del catálogo estándar. No es un 5xx, pero tampoco una respuesta que ningún contrato
 * pueda declarar: el proveedor está devolviendo cualquier cosa.
 */
const UNKNOWN_STATUS = Object.freeze({
  kind: 'unknown-status',
  reason: 'El proveedor contestó un status que no existe en el estándar.',
  recorded: true
});

/**
 * 4xx: el proveedor RECHAZA la petición. Entra al fallback —hay que decidir qué hacer, y esa decisión
 * es la del diseño— pero NO cuenta para el circuito: un 4xx sistemático (una credencial caducada) es
 * nuestro. Su rama registra su propia línea antes de delegar (`rejection`): llamarlo «no disponible» a
 * secas sería el mismo error de diagnóstico, más pequeño, que el que esta tabla corrige. Traducir un
 * 404 o un 409 a la excepción de dominio que dicte el diseño es trabajo del agente en el adaptador.
 */
const CLIENT_ERROR = Object.freeze({
  kind: 'client-error',
  reason: 'El proveedor RECHAZA la petición (4xx): contestó, no está caído.',
  rejection: true,
  recorded: false
});

/**
 * Circuito abierto: la llamada ni se intentó. Va al fallback —sin esa rama, abrir el circuito le
 * estampa al llamante un error crudo de la librería en vez de la política del diseño— y no cuenta.
 */
const CIRCUIT_OPEN = Object.freeze({
  kind: 'circuit-open',
  reason: 'El circuito está abierto: la llamada ni se intentó.',
  recorded: false
});

/**
 * La concesión del token no se pudo obtener (`oauth2-client-credentials`). El único fallo de la tabla
 * que ocurre ANTES de que salga la petición, así que ninguna de las otras ramas llega a verlo: sin la
 * suya, un proveedor de identidad caído sale como 500 sin traducir. No cuenta para el circuito, por el
 * mismo criterio que el 4xx: quien no contesta es el emisor del token, no el proveedor de negocio. Lo
 * destapó `FL-AUT-004` en la corrida de autenticación saliente.
 */
const AUTH_GRANT = Object.freeze({
  kind: 'auth-grant',
  reason: 'No se pudo obtener el token: el proveedor de identidad no responde o nos rechaza.',
  recorded: false
});

/** Todos los fallos del proveedor, por `kind`. */
export const PROVIDER_FAILURES = Object.freeze({
  transport: TRANSPORT,
  serverError: SERVER_ERROR,
  unknownStatus: UNKNOWN_STATUS,
  clientError: CLIENT_ERROR,
  circuitOpen: CIRCUIT_OPEN,
  authGrant: AUTH_GRANT
});

/**
 * Los fallos que el fallback de una llamada atiende, en el orden de sus ramas. El circuito abierto
 * solo existe con circuito, y la concesión del token solo con `oauth2-client-credentials`: declararlos
 * sin ellos dejaría una rama que nada puede alcanzar.
 */
export function fallbackFailures({ circuitBreaker = false, oauth2 = false } = {}) {
  const failures = [TRANSPORT, SERVER_ERROR, UNKNOWN_STATUS, CLIENT_ERROR];
  if (oauth2) failures.push(AUTH_GRANT);
  return circuitBreaker ? [CIRCUIT_OPEN, ...failures] : failures;
}

/**
 * Lo que llena la ventana del circuito. Es una lista CERRADA a propósito: la pregunta es «qué cuenta
 * como fallo del proveedor», y la de los bugs posibles no lo es. Lo no listado cuenta como éxito —un
 * error nuestro recurrente no abre el circuito—, y es aceptable justo porque ese error ya no se lo
 * traga nadie: sin rama en el fallback, se propaga y se ve.
 */
export function recordedFailures() {
  return fallbackFailures({ circuitBreaker: true }).filter((failure) => failure.recorded);
}

/** Lo que reintenta el retry cuando el diseño no declara `retryOn`: las tres condiciones. */
export const DEFAULT_RETRY_ON = Object.freeze(['timeout', '5xx', 'connection']);

/**
 * Los fallos que reintenta el retry de una llamada, desde su `retryOn`. Un 4xx no se reintenta NUNCA
 * (regla del DSL `http-clients`): el proveedor contestó, y repetir la misma petición obtiene la misma
 * respuesta. `timeout` y `connection` son el mismo fallo del transporte; el orden es fijo.
 */
export function retriedFailures(retryOn = DEFAULT_RETRY_ON) {
  const failures = [];
  if (retryOn.includes('5xx')) failures.push(SERVER_ERROR);
  if (retryOn.includes('timeout') || retryOn.includes('connection')) failures.push(TRANSPORT);
  return failures;
}

/** Los fallos que el retry deja pasar sin reintentar aunque el resto de la política diga lo contrario. */
export function neverRetriedFailures() {
  return [CLIENT_ERROR];
}

// ─── Los números, cuando el diseño no los escribe ────────────────────────────

export const RESILIENCE_DEFAULTS = Object.freeze({
  /** El timeout de una llamada sin `timeoutMs`, y el de lectura de un cliente sin ninguno. */
  timeoutMs: 5000,
  /** El de establecer la conexión: fijo, no lo declara el diseño. */
  connectTimeoutMs: 5000,
  retry: Object.freeze({ initialDelayMs: 500, backoff: 'exponential', multiplier: 2 }),
  circuitBreaker: Object.freeze({
    failureRateThreshold: 50,
    slidingWindowSize: 20,
    waitDurationMs: 30000,
    // Los dos que el diseño no puede declarar y que tampoco escribe keel-spring: son los defaults de
    // resilience4j, y se fijan aquí para que el otro servidor no dependa de los de SU librería.
    //   · Llamadas antes de evaluar la ventana: 100, acotado al tamaño de la ventana por conteo (con
    //     una ventana de 10 no habría nunca 100 llamadas que contar).
    //   · Llamadas de prueba en semiabierto: 10, y su tasa decide si cierra o vuelve a abrir.
    minimumNumberOfCalls: 100,
    halfOpenCalls: 10
  })
});

/**
 * La política de UNA llamada, ya resuelta: cada número con su default, y `null` donde el diseño no
 * declara el mecanismo. `call` es la del modelo (`model.httpClients[].calls[]`).
 */
export function resiliencePolicy(call) {
  const retry = call.retry
    ? {
        maxAttempts: call.retry.maxAttempts,
        backoff: call.retry.backoff ?? RESILIENCE_DEFAULTS.retry.backoff,
        initialDelayMs: call.retry.initialDelayMs ?? RESILIENCE_DEFAULTS.retry.initialDelayMs,
        // El multiplicador y el techo solo existen con backoff exponencial; con `fixed` la espera es
        // siempre la inicial.
        multiplier: (call.retry.backoff ?? RESILIENCE_DEFAULTS.retry.backoff) === 'exponential' ? RESILIENCE_DEFAULTS.retry.multiplier : null,
        maxDelayMs: (call.retry.backoff ?? RESILIENCE_DEFAULTS.retry.backoff) === 'exponential' ? (call.retry.maxDelayMs ?? null) : null,
        retries: retriedFailures(call.retry.retryOn ?? DEFAULT_RETRY_ON).map((failure) => failure.kind)
      }
    : null;
  const slidingWindowSize = call.circuitBreaker?.slidingWindowSize ?? RESILIENCE_DEFAULTS.circuitBreaker.slidingWindowSize;
  const circuitBreaker = call.circuitBreaker
    ? {
        failureRateThreshold: call.circuitBreaker.failureRateThreshold ?? RESILIENCE_DEFAULTS.circuitBreaker.failureRateThreshold,
        slidingWindowSize,
        waitDurationMs: call.circuitBreaker.waitDurationMs ?? RESILIENCE_DEFAULTS.circuitBreaker.waitDurationMs,
        minimumNumberOfCalls: Math.min(RESILIENCE_DEFAULTS.circuitBreaker.minimumNumberOfCalls, slidingWindowSize),
        halfOpenCalls: RESILIENCE_DEFAULTS.circuitBreaker.halfOpenCalls,
        records: recordedFailures().map((failure) => failure.kind)
      }
    : null;
  return {
    instance: call.instanceName,
    timeoutMs: call.timeoutMs ?? RESILIENCE_DEFAULTS.timeoutMs,
    retry,
    circuitBreaker,
    fallback: call.fallback ?? null
  };
}

/**
 * La espera ANTES del intento `attempt + 1` (1 = la que sigue al primer fallo): la inicial con
 * `fixed`; `initial · multiplier^(attempt-1)` con `exponential`, saturada en `maxDelayMs` si lo hay.
 * Es la REFERENCIA ejecutable: cada generador la configura en su librería y sus pruebas comparan.
 */
export function retryWaitMs(attempt, retry) {
  if (!retry.multiplier) return retry.initialDelayMs;
  const wait = retry.initialDelayMs * retry.multiplier ** Math.max(attempt - 1, 0);
  if (retry.maxDelayMs == null) return wait;
  return Number.isFinite(wait) && wait <= retry.maxDelayMs ? wait : retry.maxDelayMs;
}

// ─── La REFERENCIA ejecutable del circuito ───────────────────────────────────
//
// La semántica de resilience4j con ventana por CONTEO, que es la que ya tiene el servidor de keel-spring.
// No se delega en la librería del otro lenguaje porque ninguna medida dice lo mismo: el `CountBreaker` de
// cockatiel solo evalúa la ventana al registrar un FALLO (con fallo, fallo, éxito, éxito resilience4j abre
// al 50 % y él no), no cuenta lo que su política no maneja (para resilience4j un 4xx es un ÉXITO que llena
// la ventana) y en semiabierto reabre al primer fallo en vez de muestrear. Medido el 2026-10-07.
//
//   · cerrado: cada llamada que sale cuenta —fallo si su fallo está en `records`, éxito si no—; con al
//     menos `minimumNumberOfCalls` en la ventana, una tasa de fallo >= umbral abre;
//   · abierto: rechaza sin intentar hasta `waitDurationMs`; la primera llamada después pasa a semiabierto
//     (sin transición automática: el reloj solo se mira cuando alguien llama);
//   · semiabierto: deja pasar `halfOpenCalls` llamadas; con todas registradas, tasa >= umbral reabre y si
//     no, cierra con la ventana vacía.
//
// Cada generador escribe esto en su lenguaje y sus pruebas recorren las mismas secuencias contra esta.

/**
 * @param cb  el `circuitBreaker` de `resiliencePolicy`
 * @param now el reloj en milisegundos
 */
export function circuitBreakerReference(cb, now = () => Date.now()) {
  let state = 'closed';
  let window = [];
  let openedAt = 0;
  let permitted = 0;
  let trial = [];
  const tripped = (outcomes) => (outcomes.filter(Boolean).length * 100) / outcomes.length >= cb.failureRateThreshold;
  const open = () => {
    state = 'open';
    openedAt = now();
    window = [];
  };
  return {
    get state() {
      return state;
    },
    /** ¿Puede salir esta llamada? Si no, el llamante ve el circuito abierto (`circuit-open`). */
    tryAcquire() {
      if (state === 'open') {
        if (now() - openedAt < cb.waitDurationMs) return false;
        state = 'half-open';
        permitted = 0;
        trial = [];
      }
      if (state === 'half-open') {
        if (permitted >= cb.halfOpenCalls) return false;
        permitted++;
      }
      return true;
    },
    /** El desenlace de una llamada que salió: `failed` si su fallo cuenta para el circuito. */
    record(failed) {
      if (state === 'half-open') {
        trial.push(failed);
        if (trial.length >= cb.halfOpenCalls) {
          if (tripped(trial)) open();
          else {
            state = 'closed';
            window = [];
          }
        }
        return;
      }
      if (state !== 'closed') return;
      window.push(failed);
      if (window.length > cb.slidingWindowSize) window.shift();
      if (window.length >= cb.minimumNumberOfCalls && tripped(window)) open();
    }
  };
}
