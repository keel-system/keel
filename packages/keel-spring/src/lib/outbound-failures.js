/**
 * Qué significa «el proveedor no está» en una llamada saliente, en Java.
 *
 * Es UNA pregunta que se contesta en DOS sitios —las sobrecargas del fallback que emite
 * `scaffold/http-clients.js` y el `record-exceptions` del circuito que emite `scaffold/config.js`—,
 * más el `retry-exceptions`/`ignore-exceptions` del retry. La TABLA y su criterio (al fallback solo
 * llega lo que el proveedor ha hecho; un bug nuestro se propaga con su traza; un 4xx entra al
 * fallback y no cuenta para el circuito) son neutrales y viven en keel-core
 * (`gen/outbound-resilience.js`), porque el servidor de keel-nest del mismo diseño tiene que decir
 * lo mismo. Aquí queda solo la proyección de cada fallo a su excepción de Spring.
 */

import { fallbackFailures, neverRetriedFailures, recordedFailures as recordedFailureKinds, retriedFailures } from 'keel-core/gen/outbound-resilience';

/**
 * El nombre Java de cada fallo del proveedor. QUÉ fallos atiende el fallback, cuáles cuenta el
 * circuito y cuáles reintenta el retry lo decide keel-core (`gen/outbound-resilience.js`), igual
 * para keel-nest; aquí solo la excepción que lo realiza en Spring.
 *
 *   · transport — `ResourceAccessException`: conexión rechazada, timeout de lectura, DNS.
 *   · client-error — `HttpClientErrorException`: no se propaga como un bug, aunque a menudo lo
 *     sea, porque un rechazo tiene significado; traducirlo con `.onStatus(...)` es del agente.
 *   · circuit-open — `CallNotPermittedException`: resilience4j ya la excluye de su ventana.
 *   · auth-grant — el padre (`OAuth2AuthorizationException`) y no la
 *     `ClientAuthorizationException` que lanza el `OAuth2ClientHttpRequestInterceptor`: cubre las
 *     dos y no depende de por cuál de los dos caminos falló la autorización.
 */
const JAVA_EXCEPTIONS = {
  transport: 'org.springframework.web.client.ResourceAccessException',
  'server-error': 'org.springframework.web.client.HttpServerErrorException',
  'unknown-status': 'org.springframework.web.client.UnknownHttpStatusCodeException',
  'client-error': 'org.springframework.web.client.HttpClientErrorException',
  'circuit-open': 'io.github.resilience4j.circuitbreaker.CallNotPermittedException',
  'auth-grant': 'org.springframework.security.oauth2.core.OAuth2AuthorizationException'
};

/** El FQN de la excepción que realiza un fallo neutral. */
export function exceptionFor(kind) {
  const fqn = JAVA_EXCEPTIONS[kind];
  if (!fqn) throw new Error(`outbound-failures: fallo del proveedor sin excepción Java: ${kind}`);
  return fqn;
}

function project(failure) {
  const fqn = exceptionFor(failure.kind);
  return { ...failure, fqn, simple: fqn.slice(fqn.lastIndexOf('.') + 1) };
}

/**
 * Excepciones que el fallback de una llamada debe atender, en el orden en que se emiten las
 * sobrecargas. `circuitBreaker` gobierna si entra `CallNotPermittedException` (sin circuito
 * declararla dejaría un import de resilience4j sin motivo) y `oauth2` si entra
 * `OAuth2AuthorizationException` (sin esa auth el tipo ni está en el classpath).
 *
 * SIEMPRE devuelve dos o más. No es casual y no debe «optimizarse» a una: resilience4j comprueba
 * el tipo del último parámetro solo cuando hay VARIOS métodos de fallback; con uno solo lo invoca
 * sea cual sea la excepción, que es exactamente el embudo que esta tabla existe para cerrar.
 */
export function providerFailures(options = {}) {
  return fallbackFailures(options).map(project);
}

/**
 * FQN que llenan la ventana del circuito (`resilience4j.circuitbreaker.instances.<x>.record-exceptions`).
 * Es una whitelist a propósito; la contrapartida es que lo NO listado cuenta como éxito.
 */
export function recordedFailures() {
  return recordedFailureKinds().map((failure) => exceptionFor(failure.kind));
}

/** FQN que reintenta el retry de una llamada (`retry-exceptions`), desde su `retryOn`. */
export function retriedExceptions(retryOn) {
  return retriedFailures(retryOn).map((failure) => exceptionFor(failure.kind));
}

/** FQN que el retry nunca reintenta (`ignore-exceptions`): el 4xx. */
export function ignoredExceptions() {
  return neverRetriedFailures().map((failure) => exceptionFor(failure.kind));
}
