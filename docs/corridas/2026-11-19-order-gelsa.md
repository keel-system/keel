# Corrida de `order` en prueba-gelsa (keel-spring 0.4.0)

| Etiqueta | Valor |
|---|---|
| Diseño | `order` v0.1.0 (DSL 2.32, relacional, 9 capas: api, dependencies, domain, http-clients, messaging, persistence, security, use-cases, service) |
| Stack | `postgresql · rabbitmq · keycloak · otel` |
| Generador | `keel-spring@0.4.0` |
| Diseño listo al generar | sí (los 13 criterios de `--ready` en verde, medido de nuevo el 2026-11-20) |
| Matriz final | **38/38 OK** tras tres pasadas (1.ª: 4 OK · 33 FALLO · 1 NO_EJERCITADO; 2.ª: 35 OK · 3 FALLO) |
| Huella del agente | 400 archivos registrados por `build`, 0 adoptados, **31 reescritos**, 0 borrados |
| Huecos del diseño | 7 en `design-gaps.yaml` (2 reclasificados como del generador) + 3 que no reportó nadie (D3, D4, D5) |
| Huecos del generador | 9: 3 del arnés (`harnessPatches`) + 6 del scaffolding (G1-G6, G8 de `PLAN-CORRIDAS-GELSA.md`) |
| Agujeros de la puerta | 5 (D2, D3, D4, D5 y D6: todo lo del diseño pasó `--ready`) |
| Convertidos en id | pendientes del inc. 1 y 4 del plan: `CHK-PERSIST-NATURALKEY-IS-ID`, `CHK-HTTPCLIENT-TOKENURL-PLACEHOLDER`, `CHK-DOCS-OPENAPI-DRIFT` sobre esquemas, `CHK-SCEN-PROJECTION-UNKNOWN-FIELD`, `CHK-DEPS-UNANSWERED-DUPLICATES-PARAMETER` |

Proyecto en `C:\Users\antonio.suarez\proyectos\asuridev\prueba-gelsa\services\order-spring` (commit `0b80c12`,
«Generado desde specs/order v0.1.0»). La corrida la lanzó el usuario fuera de un plan; se registra en el inc. 0 de
`PLAN-CORRIDAS-GELSA.md`, donde cada hallazgo está contrastado contra `specs/` y `packages/keel-spring/src`. La
huella no se clasificó archivo a archivo con un agente de contexto limpio.

## Lo que pasó

La primera pasada cayó casi entera por una causa sistémica: `tokenUrl: "${IDP_TOKEN_URL}"` en
`http-clients.keel.yaml` (D5) llegó tal cual a `parameters/local/http-clients.yaml`, nadie define esa variable y
todo `POST /orders` daba 500. Sobre eso, el arnés tenía tres defectos que el agente parcheó (`harnessPatches`):

1. `resetState()` no vacía `SEQUENCED` (G1): la segunda clase con `stubSequence` sobre `POST /payments` revienta en
   `@BeforeAll`.
2. Los helpers de métricas (`deadLetteredEvents`, `queryCount`, `queryExecutions`) dan 401 contra
   `/actuator/metrics/*`, y `/actuator/prometheus` no acepta el `Accept: application/json` de `exchange()` (G3, por
   reproducir).
3. Falta `stubForDelayed` (G2): FL-ORD-008 y FL-CAN-006 piden una respuesta válida con retardo.

Y en el scaffolding: no se emite el stub del token M2M (G4), `OrderLineDto` sin `orderId` (G7, que es D3: el campo
lo inventó el contrato), `findById` duplicado en `ProductRepository` (G6, lado generador de D4),
`reconciliation.yaml` muerto (G8, que es D2) y la frontera transaccional de `createOrder`/`cancelOrder` (G5: el
controller pasó a mano a `dispatchWithoutTransaction`).

## Reclasificados

Dos de los siete huecos de `design-gaps.yaml` no son del diseño:

- «Frontera transaccional de createOrder y cancelOrder» → **generador** (G5). La derivación ya está en el diseño
  (`awaitingSince` + `degrade` sobre una activación `via client`); hoy solo se hace para pagos
  (`callsPaymentGateway`).
- «claim-timeout-ms (760 s) frente a umbrales de 1 minuto» → **sin acción**: es el diseño del reclamo
  (`reconciliation-stores.js`); se documentará en la nota del handler.

## designGaps

- `dual-threshold-source` — `unansweredAfterSeconds` de `chargeOrder`/`captureOrderPayment`/`cancelOrderPayment` duplica los parámetros `paymentPendingTimeoutMinutes`/`paymentActionRetryMinutes` que usa el `reconciledBy`; el DSL no deja enlazar `unansweredAfter` a un parámetro (D2)
- `contract-phantom-field` — `openapi.yaml` y la proyección de los escenarios dan a `OrderLine` un `orderId` que el dominio no declara; `CHK-DOCS-OPENAPI-DRIFT` no compara esquemas (D3, no reportado)
- `naturalkey-is-id` — `Product` declara `naturalKey: [id]` sobre el propio id, y se emite un `findById` duplicado (D4, no reportado)
- `tokenurl-placeholder` — `auth.tokenUrl: "${IDP_TOKEN_URL}"` no es una URL; en `local` llega tal cual y todo alta da 500 (D5, no reportado)
- `given-unfixed-values` — FL-REC-002/004/005 afirman líneas y total que su Given no fija (D6)
- `then-incomplete` — FL-ORD-006 no dice si el pedido cancelado conserva `paymentId` (D6)
