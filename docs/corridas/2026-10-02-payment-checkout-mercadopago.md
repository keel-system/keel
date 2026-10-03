# Corrida 2026-10-02 — `payment-checkout` con MercadoPago

Segunda corrida del par. Usa el mismo `specs/` que la de Stripe
([`2026-10-02-payment-checkout-stripe.md`](2026-10-02-payment-checkout-stripe.md)); solo cambia la
pasarela.

| | |
|---|---|
| Diseño | `payment-checkout` v1.0.0 (DSL 2.19, relacional, 7 capas con `payments`) |
| Stack | postgresql · kafka · keycloak · mercadopago |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 319 archivos registrados por `build`, 0 adoptados, **30 reescritos**, 0 borrados |
| Huecos del diseño | 2 en `design-gaps.yaml` (uno, `charge-dedupe-before-effect`, es en realidad del generador) |
| Huecos del generador | 6: F1, F3 y F4 compartidos con Stripe; F5, F6 y F7 propios de esta pasarela |
| Agujeros de la puerta | 0 |
| Convertidos en id | `REV-PAYMENTS-FAILED-RECORD` (cerrado el 2026-10-02 en la v1.1.0) |

La huella coincide archivo por archivo con la de Stripe. Lo que es propio de MercadoPago (que use
Orders, la firma por manifiesto y la consulta obligatoria tras cada aviso) se quedó en el adaptador
y en el verificador, y el agente no los tocó.

Esta corrida **no verifica** lo que la matriz marca como `unverified` (`off-session` y
`customer-action`): la pasarela de prueba habla la forma que espera el adaptador. Esa verificación
necesita el sandbox real.

## Hallazgos del generador (arreglados en keel-spring)

Para F1, F3 y F4, ver el registro de Stripe. En MercadoPago, F3 consistía en leer la order antes de
una devolución parcial (`fetch`) fuera del `try`. Ahora la lectura va dentro del mismo tratamiento
de «sin respuesta», y el importe usa la moneda que pasa quien llama.

- **F5 `refund-stub-status`**. `gatewayRefunds` no programaba la consulta de la order que hace una
  devolución parcial antes de ejecutarse. Ahora la programa.
- **F6 `charge-dedupe-before-effect`**. La suscripción `ChargeRequested` usaba la marca genérica de
  `processed_event` (`tryRecord`). Si había un fallo transitorio entre la marca y el despacho, el
  reintento se tomaba por un duplicado y el cobro se perdía. El agente lo reportó como un
  `designGap`, pero el diseño ya fija la guarda: `chargeRequestId` participa en la `naturalKey`.
  Ahora la suscripción reconoce esa guarda (`triggerGuardKind: 'payment-reference'` en `model.js`)
  y ya no pone la marca previa.
- **F7**: el javadoc del listener dejaba un `TODO` sobre `paymentToken`, que por evento siempre es
  nulo. Ahora explica por qué.

## designGaps

- `charge-dedupe-before-effect`: era el hueco F6 del generador. No requiere cambios en el diseño.
- `failed-saved-method`: es la misma clave que en Stripe. Las dos corridas lo reportan, así que es
  candidato obligatorio a id. Falta fijar qué conservan `gatewayPaymentId` y `savedPaymentMethodId`
  en un cobro `failed`, y hay que reescribir la regla de anotación de FL-EVT-003 en la próxima minor.

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
