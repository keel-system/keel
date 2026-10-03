# Corrida 2026-10-02 — `payment-checkout` con Stripe

Es la primera corrida de un par. Las dos generan `payment-checkout` v1.0.0 a partir de un
`specs/` idéntico byte a byte, y lo único que cambia es `paymentGateway` en `keel-stack.json`. La
otra es [`2026-10-02-payment-checkout-mercadopago.md`](2026-10-02-payment-checkout-mercadopago.md).
Lo que se mide es la promesa de la capa `payments`: un solo diseño que sirve para cualquier
pasarela, comprobado esta vez con agentes y no solo con `test/payment-parity.test.js`.

| | |
|---|---|
| Diseño | `payment-checkout` v1.0.0 (DSL 2.19, relacional, 7 capas con `payments`) |
| Stack | postgresql · kafka · keycloak · stripe |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 319 archivos registrados por `build`, 0 adoptados, **30 reescritos**, 0 borrados |
| Huecos del diseño | 4 en `design-gaps.yaml` (uno, `customer-action-json`, es en realidad del generador) |
| Huecos del generador | 5 (F1–F5), compartidos con MercadoPago salvo F2 |
| Agujeros de la puerta | 0 |
| Convertidos en id | `REV-PAYMENTS-FAILED-RECORD` (cerrado el 2026-10-02 en la v1.1.0) |

Los 30 reescritos son los mismos archivos que en la corrida de MercadoPago. Ninguno pertenece al
adaptador ni al verificador de la pasarela: el agente no tocó lo que es propio de la pasarela. Es
la medición de la promesa, y sale bien. Tampoco se ha hecho la clasificación uno a uno con el
agente de contexto limpio, así que falta la fila `Clasificación de la huella`.

## Hallazgos del generador (arreglados en keel-spring)

- **F1 `payment-call-in-tx`** (las dos pasarelas). El controlador y el scheduler despachaban las
  operaciones que llaman a la pasarela dentro de la transacción del mediator. Eso contradice la
  defensa que la skill exige, que es registrar el cobro y confirmarlo antes de llamar. El agente lo
  sorteó en cada handler. Ahora `callsPaymentGateway()` (`payments-model.js`) hace que esas
  operaciones y el barrido se despachen sin transacción.
- **F2 `json-column-varchar`**. Un campo `json` del dominio se mapeaba a `varchar(255)`, y
  `customerAction` no cabía. Ahora sale como `columnDefinition = "text"`, igual que `text`
  (`type-mapper.js`). Este es el `designGap` `customer-action-json` de abajo: el agente lo
  diagnosticó como un problema del diseño, pero era del generador.
- **F3 `prefetch-outside-try`** (las dos pasarelas). Antes de una devolución parcial, Stripe
  consultaba la moneda (`currencyOf`) fuera del `try`. Si la pasarela no contestaba, salía un 500
  y el cobro quedaba atascado en `refunding`. Ahora el puerto recibe la moneda junto con el importe
  parcial. Además, una captura que Stripe rechaza con `charge_expired_for_capture` se traduce a
  `CANCELED` sin otra consulta. Se falsa con `payment-check --sabotage=prefetch|expired`.
- **F4 `harness-expiry-aging`** (las dos pasarelas). El arnés no podía expresar que la
  autorización había caducado ni envejecer un cobro para el barrido, y el agente escribió el
  UPDATE a mano para FL-REC-002-B. Ahora existen `gatewayExpiresAuthorization(referencia)` y la
  rama del barrido de pagos en `ageForReconciliation("sweepPendingPayments", id)`.
- **F5**: solo afecta a MercadoPago, ver su registro.

## Fuera de la capa: Kafka

Hay dos hallazgos que no tienen que ver con pagos. Se repitieron en las dos corridas y quedan
pendientes, porque necesitan `broker-check` con podman:

- **K1**: la primera entrega a un topic recién creado tarda, porque se suman la creación
  automática del topic y la asignación del consumidor. El arnés no espera a que el consumidor esté
  listo.
- **K2**: `abandonOutboxEvent` compite con el buffer del productor de Kafka
  (`delivery.timeout.ms` = 120 s). El escenario de canal indisponible puede ver el evento entregado
  después de haberlo dado por abandonado.

## designGaps

Para la próxima minor del diseño. Se resuelven en un mismo lote y vuelven a pasar por los
revisores.

- `customer-action-json`: lo reportó el agente, pero era el hueco F2 del generador. Lo que sí queda
  abierto es si el evento `PaymentActionRequired` lleva la acción como objeto o como cadena.
- `awaiting-since-on-exit`: el diseño no dice si `awaitingSince` se anula al salir de los estados
  en vuelo o se conserva.
- `sweep-not-stoppable`: el Given de FL-REC-002-B no tiene forma de alcanzarse. Se resuelve con el
  helper del arnés (F4) y no hace falta tocar el diseño.
- `failed-saved-method`: no está fijado qué conserva `savedPaymentMethodId` en un cobro que termina
  en `failed` (FL-EVT-003). Es el pendiente que se aceptó en la Fase 2 y que también reporta la
  corrida de MercadoPago.

## Cierre de los pendientes (2026-10-02)

Se cerraron en la minor **v1.1.0** del diseño y en keel-spring:

- `failed-saved-method` → **`REV-PAYMENTS-FAILED-RECORD`**. Al repetirse en las dos corridas, era
  candidato obligatorio a id. Es revisión y no `CHK` porque lo que choca son dos frases: la rule
  que anota el medio y el invariante que lo ata a su titular. La doctrina está en
  `docs/dsl/payments.md` § Lo que conserva un cobro `failed`: un cobro conserva lo que llegó a
  existir. FL-EVT-003 afirma ahora `savedPaymentMethodId: null` y `gatewayPaymentId: null`.
- `awaiting-since-on-exit` → cada desenlace vacía `awaitingSince` al salir de los estados de espera,
  y también lo vacían el barrido y la acción rechazada que devuelven el cobro a su estado de origen.
  El campo pasa a significar «desde cuándo espera sin respuesta», porque el barrido lo renueva al
  reclamar el cobro.
- `customer-action-json` → un campo `json` viaja **embebido como objeto** en todo registro del cable
  (`@JsonRawValue` + `RawJsonDeserializer`). `payment-check` lo mide en ejecución, con el sabotaje `raw-json`.
- **K1** → el arnés espera a los grupos de consumo de Kafka una vez por JVM, antes del primer
  escenario, y ya no solo alrededor de la réplica.
- **K2** → el productor de Kafka tiene en `local` un `delivery.timeout.ms` de 15 s, y
  `abandonOutboxEvent` espera a que caduque el envío en vuelo. **No está medido en vivo**:
  `broker-check` no arranca la aplicación, y K1 y K2 viven en sus clientes. Lo comprueban los tests
  de cadena y `compile-check`; la medición es la próxima corrida con Kafka.

La minor rehízo el careo, la revisión y el barrido de huecos con los agentes de contexto limpio. Del
barrido salieron cinco preguntas nuevas, decididas en esta minor: `CAPTURE_REJECTED` (422) para una
captura que la pasarela rechaza por otro motivo que la caducidad; la redefinición de
`awaitingSince`; y tres aceptadas por escrito (un `ChargeRequested` que rompe el contrato va a la
DLQ, la moneda es única por despliegue, y las acciones hechas desde el panel de la pasarela quedan
fuera).
