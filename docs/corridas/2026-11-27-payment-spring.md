# Corrida de `payment` con keel-spring en keel-registry (Stripe)

| Etiqueta | Valor |
|---|---|
| Papel | control |
| Diseño | `payment` v0.2.3 (DSL 2.33, relacional, capa `payments` con `partial-refund`, `customer-action` y `off-session`, y `refund.reference`) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-spring@0.4.0` |
| Diseño listo al generar | sí |
| Matriz final | **72/72 OK** (primera pasada 71/72: FL-REC-005-A, árbitro `culprit: test`, sin consumir cupo) |
| Huella del agente | 420 archivos registrados por `build`, 0 adoptados, **22 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 2: G1 (el desenlace de la devolución en vuelo era el acumulado, en los cuatro generadores) y G2 (el «no contesta» del arnés lo repetía el cliente del JDK) |
| Agujeros de la puerta | 0 |
| Convertidos en id | ninguno: los dos son del generador |
| Coste del diseño | — |

Proyecto en `C:\Users\antonio.suarez\proyectos\keel\keel-registry\services\payment-spring`, commit `1863f56` («Generado
desde specs/payment v0.2.3»). Tercera generación del diseño `payment` tras payment-dotnet y payment-go (inc. 7 de
`PLAN-CORRIDAS-GELSA.md`).

## Lo que pasó

La huella son los 18 handlers de `application/usecases/` y las entidades `Payment`, `Wallet`, `PaymentMethod` y `Refund`:
los TODO del agente. Ningún archivo del arnés ni de la infraestructura parcheado.

El informe del pipeline dejaba dos cosas, y contrastadas con el generador las dos eran suyas:

- **G1, el desenlace de la devolución en vuelo era el acumulado.** El agente lo vio leyendo el adaptador de Stripe:
  `status()` informaba `latest_charge.amount_refunded`, el acumulado del cobro, y el diseño dice que `markRefunded.amount`
  es lo devuelto en ESTA devolución y que convertirlo es de quien traduce la respuesta. Era peor de lo que contaba el
  informe: con una devolución previa, una segunda que **no llegó** a la pasarela, o que la pasarela rechazó, el barrido
  la daba por hecha (el acumulado era > 0). Con MercadoPago fallaba también la respuesta síncrona de la segunda devolución
  parcial (la order trae todas las devoluciones y el adaptador las sumaba). Estaba en los cuatro generadores y en las dos
  pasarelas, y ningún escenario lo veía: el doble del arnés también modelaba el total.
- **G2, el «no contesta» del arnés.** FL-REC-005 pide «exactamente una» consulta a una pasarela que no contesta.
  `gatewayDoesNotAnswer` cortaba la conexión, y el `HttpClient` del JDK reintenta un GET cuando la conexión del pool
  aparece cerrada antes de recibir nada: la pasarela contaba dos. Medido en `payment-check` (2 peticiones en las dos
  pasarelas). Los otros tres generadores no reintentan, por eso payment-dotnet y payment-go pasaron ese escenario. Es
  el G10 del inc. 5 de `PLAN-CORRIDAS-GELSA.md`: entonces el usuario aceptó el GET repetido en producción, sin tocar la
  propiedad global del JDK, y eso no cambia. Lo que faltaba era que el arnés pudiera imitar «no contesta» sin provocarlo.

## Qué se cambió

- G1, en keel-core: `REFUND_TRANSLATIONS`, `refundOutcome`, `refundResponseOutcome`, los casos RF-1 a RF-9,
  `tracksRefundInFlight` y `refundSweepNote` (`src/lib/gen/payment-gateways.js`). Con `refund.reference`, el puerto gana
  `refundStatus(reference, refundReference, gatewayPaymentId, alreadyRefunded)`, la reconciliación gana `consultRefund` y
  la nota del barrido lo dice; la consulta del cobro deja de deducir la devolución del acumulado. Stripe localiza la
  devolución por su metadata (`keel_refund_reference`, que ahora viaja al pedirla). MercadoPago, que no admite referencia
  propia en una devolución, la localiza por lo procesado por encima de lo ya registrado, y en la respuesta síncrona toma
  solo la devolución que no estaba en la lectura previa. El arnés gana `gatewayReportsRefund(referencia, devolución,
  desenlace, importe, devueltoAntes)` en los cuatro.
- G2, en keel-spring: `gatewayDoesNotAnswer` corta la respuesta A MITAD (`stubBrokenResponse`, el fault
  `MALFORMED_RESPONSE_CHUNK`), que el cliente del JDK no repite.

## Redes

- keel-spring: `payment-check` en verde con RF-1 a RF-9 y la consulta cortada a mitad, en las dos pasarelas. Los
  sabotajes caen en exactamente sus casos: `rf-not-mine` en RF-1 a RF-4, `rf-cumulative` en RF-5 y RF-6, `rf-known` en
  RF-8 y RF-9, `transport-retry` en la consulta cortada (con las dos pasarelas) y `prefetch` sigue en el suyo.
  `compile-check` de payment-checkout en verde con las dos pasarelas (rabbitmq, kafka, snssqs y kafka sobre MySQL).
- keel-nest: RF-1 a RF-9 ejecutados contra el adaptador emitido (`test/payments.test.js`), falsado a mano (RF-1 a RF-4 y
  RF-5/RF-6); `stub-check` contra un WireMock real en verde.
- keel-dotnet: RF-1 a RF-9 como pruebas emitidas en `PaymentGatewayTests`; `stub-check` contra un WireMock real en verde.
  Las pruebas emitidas no se han ejecutado con `cs-check`.
- keel-go: RF-1 a RF-9 como pruebas emitidas, con tidy, gofmt, vet, staticcheck y `go test` sobre payment-checkout con
  las dos pasarelas, falsadas a mano (RF-1 a RF-4 y RF-5/RF-6); `stub-check` contra un WireMock real en verde.

## designGaps

Ninguno.
