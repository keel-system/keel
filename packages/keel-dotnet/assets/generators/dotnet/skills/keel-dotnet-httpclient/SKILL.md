---
name: keel-dotnet-httpclient
description: Guía de las integraciones HTTP salientes (capa http-clients) en un proyecto generado por keel-dotnet — usar el puerto desde el handler, traducir los rechazos con significado, completar lo que el contrato en prosa no dice, escribir el barrido de reconciliación y la compensación, y los flujos contra el proveedor de prueba; el adaptador sobre HttpClient, el retry, el circuito, el fallback y el reclamo de reconciliación ya los genera build. Usar cuando el diseño declara la capa http-clients.
---

# Clientes HTTP salientes (capa `http-clients`)

Casi todo lo saliente sale **de build**, y es el mismo servidor que los de keel-spring y keel-nest del diseño:
misma ruta, misma cabecera de idempotencia, mismos reintentos, mismo circuito y mismo fallback. Lo tuyo es poco y
concreto: **llamar al puerto** desde el handler, **traducir** los rechazos que significan algo, completar lo que el
contrato solo dice en prosa, **escribir** el barrido y la compensación, y **probarlo** contra el proveedor de prueba.
No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Puerto | `I<Cliente>Client.cs` en `src/<Raíz>.Domain/Clients/` | Una llamada por `calls.<c>`; devuelve `<Llamada>Result` (en términos del dominio, todo campo admite su ausencia) |
| Adaptador | `src/<Raíz>.Infrastructure/Clients/<Cliente>HttpAdapter.cs` | La llamada sobre HttpClient (`<Llamada>Once`), la política del diseño (`<Llamada>Policy`) y el fallback (`<Llamada>Unavailable`) |
| Resiliencia | `src/<Raíz>.Infrastructure/Clients/OutboundResilience.cs`, `src/<Raíz>.Infrastructure/Clients/CircuitBreaker.cs` | Retry por fuera y circuito por dentro, el orden de resilience4j; el circuito tiene SU semántica (un 4xx es un éxito para él). Sin Polly |
| Fallos del proveedor | `src/<Raíz>.Infrastructure/Clients/ProviderFailures.cs` | `ProviderTransportException` (sin respuesta, timeout), `ProviderStatusException` (con su `Status`, su `Kind` y su `Body`), `CallNotPermittedException` (circuito abierto) |
| Un intento | `src/<Raíz>.Infrastructure/Clients/HttpExchange.cs` | La petición con su timeout, sin redirecciones y SIN los reintentos propios del transporte de .NET |
| Lectura | `src/<Raíz>.Infrastructure/Clients/ResponseReading.cs` | El cuerpo con el contrato del cable (`WireJson`), y `OutboundContractException` para lo que lo viola |
| DTOs y mapper | `<Llamada>Request.cs`, `<Llamada>Response.cs`, `<Cliente>Mapper.cs` en `Infrastructure/Clients` | El contrato del tercero tal cual, con la guarda de los obligatorios, y la anticorrupción hacia el dominio |
| Clave saliente | `src/<Raíz>.Infrastructure/Clients/OutboundIdempotency.cs` | `OutboundIdempotency.FromPayload/Correlated`, ya cableada en el intento de cada llamada que la declara |
| Configuración | `config/parameters/<perfil>/http-clients.yaml`, `src/<Raíz>.Infrastructure/Clients/HttpClientsSettings.cs` | La `base-url` (obligatoria fuera de `local`, que apunta al WireMock de `infra/`) y las credenciales |
| Registro | `src/<Raíz>.Infrastructure/Clients/HttpClientsRegistration.cs` | `AddOutboundClients`, en `Program.cs`: los handlers reciben el puerto por su constructor |
| Reconciliación | `src/<Raíz>.Infrastructure/Persistence/ReconciliationClaimStore.cs`, `ReconciliationSettings.cs` | La marca de `reconciliation_claim` y los tres números de cada barrido; el reclamo, en el repositorio de la raíz que espera |

## Antes de empezar

- Aplica solo si el diseño declara la capa `http-clients`.
- Lee `specs/http-clients.keel.yaml` y `specs/dependencies.keel.yaml` (la `onFailure` de cada activación y la
  `onUnavailable` de cada `need` son la política del fallback, y ya están escritas en `<Llamada>Unavailable`).
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: el puerto y los
  resultados son DOMINIO; el adaptador, los DTOs del cable y el mapper, infraestructura. **Application y Domain no
  ven nada de `Infrastructure/Clients`**, ni un fallo del proveedor: lo impide el compilador.

## Lo que escribes

1. **La llamada desde el handler.** El puerto ya está en su constructor (`inventoryClient`) cuando una activación
   del diseño sale por esta llamada, o cuando la operación PIDE un dato bajo demanda (`needs` con `usedBy`), y la nota
   del handler dice el ORDEN de los efectos o qué hacer con el dato. Se llama con `await` y
   **sin** retry, try/catch ni circuito alrededor: eso ya está en el adaptador, y repetirlo multiplica los intentos.
2. **Los rechazos con significado.** Un 4xx llega al fallback con su línea de log y NO cuenta para el circuito.
   Si el diseño le da significado (un 404 es «no existe», un 409 un conflicto suyo), tradúcelo en `<Llamada>Once`,
   antes de que llegue al fallback — `references/implementation.md` § Rechazos.
3. **El contrato en prosa.** Sin `request`/`response` estructurados, build deja los DTOs y el mapper con
   `TODO (agente)`; sin `method`/`path`, la llamada entera. Complétalos desde la frase `contract`; si la prosa es
   ambigua, es un hueco del diseño: dilo en el reporte, no inventes la ruta.
4. **El fallback que build no pudo escribir.** Con `onFailure: ignore` o `fail` (o `onUnavailable: fail` de un `need`)
   ya está escrito: el error del diseño sale del adaptador y el handler **no lo captura**. Con `degrade`, o sin política
   que lo declare, queda un `TODO` con la prosa del diseño (`degradedTo`). Un resultado degradado tiene que ser
   distinguible por el cliente de uno normal.
5. **El dato que sale en la respuesta** (`needs.<n>.exposedAs`). El mapper pide su DTO por parámetro: pásale lo que
   devolvió el puerto, o null si el proveedor no respondió y la política degrada — es lo que el contrato admite.
6. **El barrido de reconciliación y la compensación.** El reclamo ya está generado en el repositorio; su nota dice
   cómo se llama y el ORDEN de los commits — `references/implementation.md` § Reconciliación.

**Lo que ya viene escrito y no repites:**

- `onUnavailable: lastKnown`: el adaptador recuerda cada respuesta en `LastKnownValues` (por llamada y parámetros) y su
  fallback sirve la última dentro de `maxAgeSeconds`, marcada (`Stale`), o lanza el error del diseño. Una respuesta que
  lleve un valor `Stale` no se cachea (`Cacheable` de la caché, si la hay).
- `auth: oauth2-client-credentials`: `ClientCredentials` pide el token, lo reutiliza hasta su caducidad y lo pone en cada
  intento; sin token la llamada no sale y el fallo es `AuthGrant`, que atiende el fallback. Las credenciales salen de
  `http-clients.yaml` (`<CLIENTE>_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN_URL`).
- La réplica (`needs` con `strategy: replicated`): en `src/<Raíz>.Application/Projection/`, `<E>Projector` (el upsert de la
  copia, que descarta la reentrega tardía y guarda en su PROPIA transacción) y `<E>Reader` (aplica `onMiss`, y `ByKeys` en
  los listados). El handler de la operación de proyección recibe el proyector; el del `usedBy`, el lector. Con `onMiss:
  fetch` el `Hydrate` del lector es tuyo (su TODO dice cómo). La copia NUNCA se escribe desde otro sitio.

**No ensanches el fallback.** El `catch (ProviderFailureException failure) when (...)` deja pasar solo los fallos
del proveedor; un bug del adaptador o un `OutboundContractException` se propagan con su traza sin que nadie los
capture. Capturar cualquier excepción ahí registró durante meses un defecto propio como «el proveedor está caído»
(en keel-spring, INFORME-CORRIDA-OUTBOX.md).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al traducir un rechazo, completar una llamada o un mapper, escribir un fallback `degrade`, el barrido de reconciliación o la compensación |
| `references/flows.md` | Al escribir los flujos `FL-*` que tocan una llamada saliente o un barrido de reconciliación |

## Validación

- `dotnet build` sin warnings y `dotnet test` (la prueba emitida `OutboundClientsTests` ejecuta el circuito, la
  clasificación de cada desenlace y cada llamada resiliente contra un proveedor falso: no la toques).
- `bash infra/check-idempotency.sh`: la familia `outboundIdempotency` exige la clave en cada llamada que la
  declara; `compensation` y `reconciliation`, lo que el diseño pide de las llamadas que deshacen o reconcilian.
- Los flujos, contra el WireMock de `infra/` (`references/flows.md`).
