# Corrida `payment-checkout` — keel-nest con Stripe (incremento 13e: los cobros con pasarela)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.1.0 (DSL 2.19, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-nest@0.0.1` (incremento 13d, más `holdFromReconciliation` propagado con `--refresh` a mitad de la fase 1) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 294 archivos registrados por `build`, 0 adoptados, **21 reescritos**, 0 borrados |
| Huecos del diseño | 6 en design-gaps.yaml (1 era del generador: el lote del barrido) |
| Huecos del generador | 2: el arnés sin forma de retener una fila fuera del barrido (bloqueó la fase 1) y el lote del barrido sin clave de configuración (ver § Arreglos) |
| Convertidos en id | — (propuestos, ver § Lo que vuelve al diseño) |
| Clasificación de la huella | 17 TODO · 3 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Es una de las cuatro corridas que miden el incremento 13 de `PLAN-KEEL-NEST.md`: el mismo diseño con las dos
pasarelas del catálogo y los dos generadores. Las otras tres son `2026-10-09-payment-checkout-mercadopago-nest.md`,
`2026-10-09-payment-checkout-stripe-spring.md` y `2026-10-09-payment-checkout-mercadopago-spring.md`. **Este registro
lleva el análisis común de las cuatro**; los otros, lo propio de cada una.

## Las cuatro, de un vistazo

| Corrida | Matriz | Reescritos | `harnessPatches` | Huecos reportados |
|---|---|---|---|---|
| stripe · keel-nest | 25/25 | 21 | 0 | 6 |
| mercadopago · keel-nest | 25/25 | 20 | 0 | 3 |
| stripe · keel-spring | 25/25 | 20 | 0 | 3 |
| mercadopago · keel-spring | 25/25 | 20 | 0 | 3 |

**La promesa de la capa se cumple en los dos ejes a la vez**: el mismo diseño con las dos pasarelas y con los dos
generadores sale al 100% de `FL-*`, con la huella prácticamente idéntica, y **ningún agente tocó el adaptador, el
verificador, el aviso, el aplicador de desenlaces ni el arnés de la pasarela**. Los reescritos son los mismos en las
cuatro: los trece handlers, los dos agregados, el puerto y el adaptador del repositorio del cobro (el finder de los
candidatos del barrido y su reclamo), el aplicador de desenlaces (el `cancelReason` que la capa no nombra), el README y
—solo en keel-nest— `broker-bindings.ts`, donde va el listener que en keel-spring es un archivo nuevo. Esta corrida
lleva uno más: el mensaje `RequestChargeCommand` (ver § La huella).

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los trece handlers de `src/application/usecases/` | TODO legítimo |
| `src/domain/aggregate/{payment,saved-payment-method}.ts` | TODO legítimo: los métodos semánticos |
| `src/infrastructure/messaging/broker-bindings.ts` | TODO legítimo: el dispatcher del outbox y el listener de `ChargeRequested` |
| `README.md` | TODO legítimo |
| `src/application/payment/payment-outcome-applier.ts` | TODO legítimo: el `todo<CancelReason>()` que deja build (`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED`, aceptado en el diseño) |
| `src/domain/repository/payment-repository.ts` y su adaptador | Consulta de negocio: `findAwaitingBefore(corte, lote)` y el reclamo que re-estampa `awaitingSince`, que es lo que pide la skill |
| `src/application/commands/request-charge-command.ts` | Consulta de negocio: el campo `fromSubscription`, para distinguir la puerta (por HTTP, una precondición incumplida es un 422; por evento, un cobro `failed`). La corrida gemela de MercadoPago hizo lo mismo sin tocar build (`RequestOrigin`, un contexto propio); keel-spring lo resuelve en el listener |
| el lote del barrido (`SWEEP_BATCH_LIMIT = 100`, dentro del handler) | **Hueco del generador** (ver § Arreglos) |

## Lo que dijo el informe y lo que resultó ser

1. **El blocker de la fase 1 era del arnés, y de los dos generadores.** FL-REC-002-B pide que el barrido no toque un
   cobro que acaba de entrar en vuelo. Con el umbral local en 5 s y el cron cada 5 min, ese cobro también está rancio
   cuando llega el ciclo. La corrida de keel-spring del 2026-10-02 lo había resuelto con dos UPDATE a mano —uno al
   pasado, otro al FUTURO— y el arreglo de entonces solo convirtió en helper la primera mitad (`ageForReconciliation`).
   Se paró la corrida, se añadió `holdFromReconciliation` a los dos arneses (commit `c2df5f4`), se propagó con
   `build --refresh` (solo `flow.ts` y la skill de flujos, ninguno tocado por el agente) y la corrida siguió hasta
   25/25. El agente lo anota como «más débil que pausar el barrido si recorre las filas en varios ciclos»: es cierto
   para un lote que no cabe en una pasada, que aquí no es el caso.
2. **El lote del barrido sin clave**: cierto, y de los dos generadores — los cuatro agentes lo resolvieron con una
   constante o una política propia. Arreglado (§ Arreglos).
3. **El «default» de la pasarela de prueba que «anuncian las convenciones»**: lo anuncia el DISEÑO, no el generador
   (`validation-scenarios.md` § Convenciones: «autoriza, captura, anula y devuelve por defecto»). Ningún arnés lo da
   —tampoco el de keel-spring— y la skill de flujos ya dice que cada escenario programa su referencia. Vuelve al
   diseño.
4. **La reentrega de `ChargeRequested` con otro `eventId` acaba en la DLQ**: cierto, y es una **divergencia entre los
   dos servidores** que ningún escenario mide — los dos listeners de keel-spring la tratan como duplicado y la
   confirman; los dos de keel-nest la dejan en el descarte. FL-EVT-001-B solo exige que no haya segundo cobro ni
   segundo desenlace, y las dos formas lo cumplen. Vuelve al diseño.

## Arreglos

- **`holdFromReconciliation`** (los dos generadores, commit `c2df5f4`): el inverso de `ageForReconciliation`, con
  `heldTimestamp` por motor en el catálogo de keel-core (2037-12-31: el `TIMESTAMP` de MySQL acaba en 2038; medido
  contra PostgreSQL y MySQL reales) y `holdClockScript` en `mongo-probes.js` (`mongo-check` MONGO-11).
- **El lote del barrido de pagos** (los dos generadores): `PAYMENT_SWEEP_PARAMETERS` en `keel-core/gen/payments-model.js`
  —`payments.reconciliation.batch-size`, `PAYMENT_RECONCILIATION_BATCH_SIZE`, 50 por defecto como los de
  `reconciledBy`—; los dos `payments.yaml` lo llevan (siguen idénticos), y `PaymentReconciliation` expone `batchSize()`
  y `staleBefore()` en los dos lenguajes. Las skills de pagos de los dos dicen que no se escribe como constante.
- **El rechazo al guardar un medio, con tipo** (keel-nest, de la corrida de MercadoPago):
  `GatewayRejectedPaymentMethodException` en `domain/payment`; antes los dos adaptadores lanzaban un `Error` sin tipo,
  y los dos agentes capturaron cualquier error como rechazo del medio — un fallo de programación habría salido como
  422 en vez de 500. keel-spring lanzaba ya una `IllegalArgumentException` y sus agentes capturaban solo esa.

Medido: keel-nest `payments.test.js` (el caso nuevo del rechazo y el lote de la configuración), `ts-check` 12/12;
keel-spring `compile-check` de `payment-checkout` con las dos pasarelas sobre PostgreSQL y MySQL y `payment-check` en
verde. Línea base de keel-spring regenerada en su propio commit.

## Lo que vuelve al diseño

Los huecos repetidos entre las cuatro corridas, que por la regla de `docs/corridas` son candidatos a id:

| Clave | Corridas | Qué falta | Divergencia entre servidores |
|---|---|---|---|
| `cancel-gateway-rejected` | stripe-nest, mercadopago-nest, mercadopago-spring | La regla de `cancelPayment` dice qué pasa si la pasarela confirma o no contesta, no si contesta que NO | **Sí**: keel-spring devuelve el cobro a `authorized` y responde 409 `PAYMENT_NOT_CANCELABLE`; keel-nest lo deja en `canceling` con un 200 y espera al barrido |
| `charge-reference-reused` | stripe-nest, mercadopago-spring | El desenlace de un `ChargeRequested` distinto con un `chargeRequestId` que ya tiene cobro | **Sí**: keel-spring lo confirma como duplicado; keel-nest lo descarta a la DLQ |
| `notice-success-status` | stripe-spring, mercadopago-spring | El status del aviso válido | No: los dos generadores responden 200 vacío (lo fija build). Basta con escribirlo en `docs/dsl/payments.md` |
| `sweep-not-stoppable` | mercadopago-nest (y la del 2026-10-02) | El Given de FL-REC-002-B habla de «barrido detenido» | No: ya se alcanza con `holdFromReconciliation`; el Given se reescribe en esos términos |

Las dos primeras son la misma pregunta que la capa todavía no hace: **qué pasa cuando la pasarela, o el emisor,
contesta que no a una acción de seguimiento o a una referencia ya usada**. Propuesta: una comprobación de la capa
`payments` (un `OBL-` sin default seguro, porque las dos respuestas son defendibles y lo único inaceptable es que cada
servidor elija la suya) y un escenario por cada una en la próxima minor de `payment-checkout`.

## designGaps

Copiado de `design-gaps.yaml` del proyecto (claves estables para `series`):

- `sweep-batch-size` (payments.reconciliation): el lote del barrido como constante. **Era del generador**: arreglado.
- `payment-state-inconsistent` (domain.Payment): si un desenlace sin `gatewayPaymentId` o sin un componente debe ser un
  error de contrato. Hoy el aplicador lanza en voz alta (`required(...)`); vuelve al diseño para decidir si se declara.
- `cancel-gateway-rejected` (use-cases.cancelPayment): ver § Lo que vuelve al diseño.
- `save-method-rejections` (use-cases.savePaymentMethod): distinguir los rechazos de la pasarela al guardar un medio.
- `charge-reference-reused` (messaging.ChargeRequested): ver § Lo que vuelve al diseño.
- `gateway-default-response` (validation-scenarios): la convención de una pasarela de prueba que contesta por defecto.
