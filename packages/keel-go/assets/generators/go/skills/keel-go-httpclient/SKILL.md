---
name: keel-go-httpclient
description: Guía de las integraciones HTTP salientes (capa http-clients) en un proyecto generado por keel-go — usar el puerto desde el handler, traducir los rechazos con significado, escribir el fallback que el diseño no decide, el barrido de reconciliación y la compensación, y los flujos contra el proveedor de prueba; el adaptador sobre net/http, el retry, el circuito, la clave saliente y el reclamo de reconciliación ya los genera build. Usar cuando el diseño declara la capa http-clients.
---

# Clientes HTTP salientes (capa `http-clients`)

Casi todo lo saliente sale **de build**, y es el mismo servidor que los de keel-spring, keel-nest y keel-dotnet del
diseño: misma ruta, misma cabecera de idempotencia, mismos reintentos, mismo circuito y mismo fallback. Lo tuyo es poco y
concreto: **llamar al puerto** desde el handler, **traducir** los rechazos que significan algo, escribir el fallback que
el diseño no decide, **escribir** el barrido y la compensación, y **probarlo** contra el proveedor de prueba. No
reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Puerto | `internal/domain/<cliente>_client.go` | `<Cliente>Client`, una llamada por `calls.<c>`; devuelve `<Llamada>Result` en términos del dominio (campos puntero: todo admite su ausencia) |
| Adaptador | `internal/infrastructure/clients/<cliente>_adapter.go` | `<Cliente>HTTPAdapter`: la llamada (`<Llamada>`), UN intento (`<llamada>Once`), la política del diseño (`<cliente><Llamada>Policy`) y los fallos que atiende el fallback (`<cliente><Llamada>Fallback`) |
| Resiliencia | `internal/infrastructure/clients/resilience.go`, `circuit.go` | `Run`: retry por fuera y circuito por dentro, el orden de resilience4j; el `Circuit` tiene SU semántica (un 4xx es un éxito para él) |
| Fallos del proveedor | `internal/infrastructure/clients/failures.go` | `*ProviderFailure` con su `Kind` (`KindTransport`, `KindServerError`, `KindClientError`, `KindCircuitOpen`…), su `Status` y su `Body`; `AsProviderFailure`; y `*ContractError`, que NO es un fallo del proveedor |
| Un intento | `internal/infrastructure/clients/exchange.go` | `Exchange.Send`: la petición con su plazo, sin redirecciones y SIN keep-alive (`DefaultTransport`: net/http reenvía por su cuenta una petición idempotente cuya conexión reutilizada se corta) |
| Lectura | `internal/infrastructure/clients/reading.go` | El cuerpo campo a campo (`required`, `optional`, `list`); lo que viola el contrato es un `*ContractError` |
| Clave saliente | `internal/infrastructure/clients/idempotency.go` | `outboundKey`: el sha256 de lo que viaja, IGUAL en cada intento; ya cableada en el intento de cada llamada que la declara |
| Configuración | `config/parameters/<perfil>/http-clients.yaml`, `internal/infrastructure/clients/settings.go` | La `base-url` (obligatoria fuera de `local`, que apunta al WireMock de `infra/`) y las cabeceras; `SettingsFrom` |
| Cableado | `cmd/server/main.go` | El adaptador se construye al arrancar y los handlers reciben el puerto por su constructor |
| Reconciliación | `reconciliation.go` del paquete del motor (`internal/infrastructure/postgres`, `mysql` o `mongo`), más `claims.go` en los relacionales | La marca de `reconciliation_claim` y los tres números de cada barrido (`config/parameters/<perfil>/reconciliation.yaml`); el reclamo, en el repositorio de la raíz que espera |

## Antes de empezar

- Aplica solo si el diseño declara la capa `http-clients`.
- Lee `specs/http-clients.keel.yaml` y `specs/dependencies.keel.yaml`: la `onFailure` de cada activación es la política
  del fallback.
- Sigue `{{keel:docs}}/conventions/errors.md` y la frontera de `{{keel:docs}}/architecture.md`: el puerto y los
  resultados son DOMINIO; el adaptador, los tipos del cable y el mapeo, infraestructura. **`internal/domain` e
  `internal/application` no importan `internal/infrastructure/clients`**, ni ven un `*ProviderFailure`: lo comprueba la
  prueba de arquitectura.

## Lo que escribes

1. **La llamada desde el handler.** El puerto ya está en el handler (`h.inventoryClient`) cuando una activación del
   diseño sale por esta llamada, o cuando la operación PIDE un dato bajo demanda (`needs` con `usedBy`), y su nota dice
   el ORDEN de los efectos. Se llama tal cual, **sin** retry, bucle ni
   circuito alrededor: eso ya está en el adaptador, y repetirlo multiplica los intentos. El error que devuelve se
   devuelve (con `fmt.Errorf("…: %w", err)` si añades contexto), nunca se descarta con `_`.
2. **Los rechazos con significado.** Un 4xx llega al fallback con su línea de log y NO cuenta para el circuito. Si el
   diseño le da significado (un 404 es «no existe», un 409 un conflicto suyo), tradúcelo en `<llamada>Once`, antes de
   que llegue al fallback — `references/implementation.md` § Rechazos. Ese es un archivo de build: el cambio es
   pequeño y en un solo sitio, y lo dices en el reporte.
3. **El fallback que build no pudo escribir** (`<cliente>_fallback.go`, sin la cabecera de código generado: es tuyo).
   Con `onFailure: ignore` o `fail` ya nace escrito: no lo toques. Con `degrade`, o sin política que lo declare, queda
   un `TODO (agente)` con la prosa del diseño. Un resultado degradado tiene que ser distinguible de uno normal.
4. **El barrido de reconciliación y la compensación.** El reclamo ya está generado en el repositorio; la nota del
   handler dice cómo se llama y el ORDEN de los commits — `references/implementation.md` § Reconciliación.

5. **El dato que sale en la respuesta** (`needs.<n>.exposedAs`). La función `To<Dto>` pide su DTO por parámetro: pásale lo
   que devolvió la llamada, o nil si el contrato admite que falte.

Lo que build ya escribe de los `needs` y de la autenticación, y no se reescribe:

- `onUnavailable: fail`: el fallback devuelve el error del diseño. `degrade`: un `TODO (agente)` en el fallback, con el
  `degradedTo`.
- `onUnavailable: lastKnown`: el adaptador recuerda cada respuesta en `LastKnownValues` (`last_known.go`, por llamada y
  parámetros) y su fallback la sirve dentro de `maxAgeSeconds`, con `Stale` a true; fuera de la ventana devuelve el error
  declarado. Una respuesta que lleve un valor `Stale` no se cachea (`GetOrLoadIf` de la caché, si la hay).
- `auth: oauth2-client-credentials`: `ClientCredentials` (`client_credentials.go`) pide el token, lo reutiliza hasta su
  caducidad y lo pone en cada intento; sin token la llamada no sale y el fallo es `KindAuthGrant`, que atiende el fallback y
  no cuenta para el circuito. Las credenciales salen de `http-clients.yaml` (`<CLIENTE>_CLIENT_ID`, `_CLIENT_SECRET`,
  `_TOKEN_URL`). En `local` el token se pide al WireMock, en la ruta de `tokenUrl`: el flujo la programa como cualquier otra.
- La réplica (`needs` con `strategy: replicated`): en `internal/application`, `<E>Projector` (el upsert de la copia, que
  descarta la reentrega tardía y guarda en su PROPIA transacción) y `<E>Reader` (aplica `onMiss`, y `ByKeys` en los
  listados). El handler de la operación de proyección recibe el proyector; el del `usedBy`, el lector, y ninguno de los demás
  el repositorio de la copia. Con `onMiss: fetch` la `hydrate` del lector es tuya (`<e>_hydrate.go`, sin la cabecera: su
  TODO dice cómo). La copia NUNCA se escribe desde otro sitio.

**No ensanches el fallback.** El adaptador solo lo alcanza con un `*ProviderFailure` cuyo `Kind` está en
`<cliente><Llamada>Fallback`; un error del adaptador o un `*ContractError` se devuelven con su causa sin que nadie los
capture. Atender ahí cualquier error registró durante meses un defecto propio como «el proveedor está caído» (en
keel-spring, INFORME-CORRIDA-OUTBOX.md).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al traducir un rechazo, escribir un fallback `degrade`, el barrido de reconciliación o la compensación |
| `references/flows.md` | Al escribir los flujos `FL-*` que tocan una llamada saliente o un barrido de reconciliación |

## Validación

- `go vet ./...`, `go tool staticcheck ./...` y `go test ./...` (la prueba emitida `clients_test.go` ejecuta el
  circuito contra la referencia de resilience4j, la clasificación de cada desenlace y cada llamada resiliente contra un
  proveedor falso: no la toques).
- `bash infra/check-idempotency.sh`: la familia `outboundIdempotency` exige la clave en cada llamada que la declara;
  `compensation` y `reconciliation`, lo que el diseño pide de las llamadas que deshacen o reconcilian.
- Los flujos, contra el WireMock de `infra/` (`references/flows.md`).
