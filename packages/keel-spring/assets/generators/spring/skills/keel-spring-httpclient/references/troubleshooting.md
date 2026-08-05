# HTTP clients — troubleshooting

Síntoma → causa probable → arreglo. Antes de tocar nada confirma el diseño en
`specs/http-clients.keel.yaml`: el comportamiento correcto lo fija el diseño.

## La llamada agota timeout siempre

- **Causa**: `base-url` mal apuntado (env var vacía, stub caído) o read-timeout más
  corto que la latencia real del tercero.
- **Arreglo**: verifica `http-clients.<c>.base-url` del perfil activo y que el stub
  responde; sube el read-timeout en `<C>ClientConfig` solo si el diseño lo justifica.
  Un timeout dispara `ResourceAccessException` → lo reintenta `@Retry` y, agotado,
  el fallback.

## El circuito queda abierto permanentemente

- **Causa**: cada reintento cuenta como fallo y llena la ventana; o `base-url`
  inválida hace fallar el 100% de las llamadas.
- **Arreglo**: arregla primero la causa raíz (URL/stub). Revisa
  `failure-rate-threshold` y `sliding-window-size`: con la ventana llena de fallos
  reales, abrir es lo correcto. Tras `wait-duration-in-open-state` pasa a half-open;
  si el tercero sigue caído, vuelve a abrir — no lo fuerces con try/catch.

## Los 4xx se reintentan (no deberían)

- **Causa**: falta `ignore-exceptions: HttpClientErrorException` en la instancia, o
  el error del tercero llega envuelto en otra excepción que sí está en
  `retry-exceptions`.
- **Arreglo**: restablece el `ignore-exceptions` que genera build; si traduces el
  4xx a una excepción de dominio en `.onStatus(...)`, asegúrate de que esa excepción
  **no** esté en `retry-exceptions`.

## Error de deserialización del response

- **Causa**: los campos del record `<X>Response` no coinciden con el JSON real del
  tercero (nombres o tipos), típico cuando el `contract` era solo-prosa.
- **Arreglo**: ajusta `<X>Response` al contrato wire real (usa `@JsonProperty` si el
  nombre JSON no es un identificador Java válido). El record wire refleja al tercero,
  no al dominio; el mapeo al dominio va en el mapper.

## OAuth2: la llamada sale sin token / 401

- **Causa**: la registration `spring.security.oauth2.client.*` incompleta
  (`<C>_CLIENT_ID`/`<C>_CLIENT_SECRET`/`<C>_TOKEN_URL` sin valor) o scopes que el
  proveedor no concede.
- **Arreglo**: confirma las env vars del perfil y que `token-uri` apunta al emisor
  correcto. En `test`, usa el fragmento que deja build para no emitir tokens reales.

## El fallback no compila

- **Causa**: firma desalineada. resilience4j exige que el `fallbackMethod` tenga los
  **mismos parámetros** que el método anotado **más** un `Throwable` (o el tipo de
  excepción concreto) al final, y el mismo tipo de retorno.
- **Arreglo**: copia la firma del método y añade `Throwable t` al final. Si quieres
  varios fallbacks por tipo de excepción, declara uno por tipo.

## El adaptador filtra `HttpClientErrorException` a application

- **Causa**: la excepción de Spring web sube sin traducir; rompe la frontera
  hexagonal (application/domain no deben conocer tipos de Spring web).
- **Arreglo**: captura en el adaptador (`.onStatus(...)` o try/catch) y lanza la
  `DomainException` con el `code` declarado en use-cases. Solo `infrastructure/http`
  importa tipos de `org.springframework.web.client`.

  La traducción es **por status**, y el criterio no es de infraestructura sino del
  diseño: un `404` del proveedor suele ser "no existe" (el `onMiss`/`onFailure`
  declarado), un `409` un conflicto suyo que hay que propagar con significado, y un
  `5xx` o un timeout es indisponibilidad — ahí no traduzcas: deja que suban como
  `ResourceAccessException`/`HttpServerErrorException` para que `@Retry` y el
  circuit breaker hagan su trabajo. Capturarlas mata la resiliencia declarada.

## Conexión rechazada al ejecutar los flujos `FL-*`

- **Causa**: el proveedor real no está en `infra/`. En el perfil `local` las
  `base-url` apuntan al **WireMock** del compose (`http://localhost:8090`), y o no
  está levantado, o el escenario no programó ningún mapping para esa ruta.
- **Arreglo**: `bash infra/validate-infra.sh` (el humo `SMOKE-6` cubre el ciclo
  entero). Si el stub está en pie, el Given del escenario tiene que programar la
  respuesta con `stubFor(...)`; el log del contenedor —arranca con `--verbose`—
  dice qué petición no casó con ningún mapping. Detalle en
  `docs/keel/conventions/integration-tests.md § El proveedor de prueba`.
- **Ojo**: si el mapping existe pero el escenario falla igual, compara la ruta del
  patrón con la que arma el adaptador. `urlPathPattern` casa contra el path **sin**
  query: una `?` en el patrón nunca casa.
