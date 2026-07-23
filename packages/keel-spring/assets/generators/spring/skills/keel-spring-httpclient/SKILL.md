---
name: keel-spring-httpclient
description: Guía de implementación de integraciones HTTP salientes (capa http-clients) con RestClient y resilience4j en un proyecto generado por keel-spring — completar la anticorrupción wire↔dominio, las llamadas sin method/path, el fallback y la traducción de errores. Usar cuando el diseño declara la capa http-clients.
---

# HTTP clients salientes (capa `http-clients`)

Integraciones HTTP con terceros u otros servicios. `keel-spring build` ya dejó
el andamiaje hexagonal completo (puerto, adaptador RestClient, mapper de
anticorrupción, DTOs wire, config del bean y resilience4j); esta skill cubre lo
que build deja como `// TODO (agente)` porque no es derivable del diseño.

## Antes de empezar

- Aplica solo si el diseño declara la capa `http-clients`.
- Lee `specs/http-clients.keel.yaml`: cada `clients.<c>` con su `purpose`, `auth`
  y sus `calls` (`contract`, y opcionalmente `method`/`path`/`request`/`response`,
  `retry`, `circuitBreaker`, `fallback`) — el diseño es la única fuente de verdad.
- Sigue estrictamente `.claude/conventions/mapping.md` §`http-clients` (mapeo
  normativo DSL → código); la estructura de paquetes está en
  `.claude/conventions/project-layout.md`.
- **Frontera hexagonal** (inviolable): el puerto `<C>Client` y los records de
  resultado `<X>Result` viven en `domain/clients`; el adaptador `<C>HttpAdapter`,
  los DTOs wire (`<X>Request`/`<X>Response`, el contrato del tercero tal cual) y
  el mapper `<C>Mapper` viven en `infrastructure/http`. **application y domain
  jamás importan RestClient, `HttpStatusCode` ni una excepción de Spring web.**
  Si el tercero cambia su contrato, solo cambian wire DTOs + adaptador + mapper.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-web` (RestClient) + `resilience4j-spring-boot3`
  (y oauth2 client si algún cliente usa `oauth2-client-credentials`).
- `infrastructure/http/<C>ClientConfig`: bean `RestClient` con `base-url`, timeouts
  (connect 5s, read = mayor `timeoutMs` del cliente) y la auth saliente declarada
  (`api-key`/`bearer-static`/`basic`/oauth2 interceptor). Credenciales por
  configuración, **nunca** del diseño.
- `domain/clients/<C>Client` (puerto) + `<C>HttpAdapter` (adaptador con las
  llamadas RestClient) + `<C>Mapper` (anticorrupción) + records `<X>Result` /
  DTOs wire `<X>Response` (y `<X>Request` si hay body).
- Anotaciones resilience4j `@Retry` / `@CircuitBreaker` sobre los métodos que las
  declaran, con método `<call>Fallback` stub.
- `parameters/<perfil>/http-clients.yaml`: `base-url` por env var, credenciales,
  registrations oauth2 e instancias `resilience4j.retry`/`.circuitbreaker`
  (con `ignore-exceptions` para **no** reintentar 4xx).

## Qué implementa el agente

1. **Contrato solo-prosa → tipar.** Si una `call` no trae `request`/`response`
   estructurados, build deja los records `<X>Response`/`<X>Result` **vacíos** y el
   mapper con `// TODO (agente)`. Lee la frase `contract`, declara los campos wire
   en `<X>Response` (nombres y tipos del tercero) y los del dominio en `<X>Result`,
   y completa el mapeo campo a campo en `to<X>Result(...)` (y `to<X>Request(...)`
   si hay body). El wire refleja al tercero; el resultado, al dominio.
2. **Sin `method`/`path` → completar la llamada.** Si el diseño no los declara,
   build deja `throw new UnsupportedOperationException("TODO: ...")`. Deriva verbo,
   URI, params y body de la frase `contract` y arma la llamada RestClient (patrón
   en `references/implementation.md`).
3. **Fallback.** El stub `<call>Fallback(..., Throwable)` implementa la frase
   `fallback` del diseño. Si el diseño dice que un fallo dispara un error de
   negocio, lanza la `DomainException` con el **`code` exacto** declarado en
   use-cases; si dice devolver un valor degradado (cache, default), constrúyelo.
   Nunca dejes el `UnsupportedOperationException`.
4. **Traducción de errores wire → dominio.** El adaptador no filtra
   `HttpClientErrorException`/`HttpServerErrorException` hacia application: usa
   `.onStatus(...)` (o captura en el adaptador) y traduce a la excepción de dominio
   que dicte el diseño. Un 4xx del tercero suele ser input a corregir; un
   5xx/timeout es reintentable (ya lo cubre `@Retry`).

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al completar llamadas RestClient (URI/query/headers/body), `.onStatus(...)`, mapeo de anticorrupción, integración con `@Retry`/`@CircuitBreaker` y diseño del fallback |
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/http-clients.yaml` (base-url, auth, instancias resilience4j) — qué toca el agente y qué NO |
| `references/troubleshooting.md` | Si hay timeouts, circuito abierto permanente, 4xx reintentados, errores de deserialización wire o oauth2 sin token |

## Validación

El tercero es una dependencia **externa**: en la validación local no está el
servicio real. Según lo que fije el diseño y los escenarios `FL-*` de
`specs/validation-scenarios.md`, apunta `http-clients.<c>.base-url` (perfil
`local`/`test`) a un stub/mock HTTP levantado en `infra/` o ejercita solo los
caminos que no dependan de la llamada. Recetas de sondeo en
`.claude/conventions/infra-validation.md`.
