# Corrida `payment-checkout` con MercadoPago — keel-dotnet (incremento 13e)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.2.0 (DSL 2.21, relacional, con `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · mercadopago` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 13a–13d, `f2aaa81`) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 322 archivos registrados por `build`, 0 adoptados, **22 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no se escribió `design-gaps.yaml`) |
| Huecos del generador | 2 arreglados (uno de keel-dotnet, otro de los tres generadores) + 1 que repite en las cinco corridas de pagos (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 18 TODO · 2 consulta · 2 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo |

La corrida del incremento 13 de `PLAN-KEEL-DOTNET.md` con la pasarela que la matriz marca con capacidades SIN verificar
(customer-action, off-session). Es también **la primera corrida de `payment-checkout` v1.2.0** en cualquier generador: las
gemelas de keel-nest y keel-spring del 2026-10-09 fueron sobre la v1.1.0, antes de `onRejected`. Por eso es la primera
vez que un agente escribe los escenarios de una captura, una anulación o una devolución que la pasarela RECHAZA.

## Cómo terminó

**25/25 a la primera** con `score-scenarios.sh` en 0, 162/162 pruebas unitarias y la línea base de migraciones
verificada (51 elementos). Sin `harnessPatches` ni falsos negativos. Nada del verificador del aviso, del cliente HTTP,
de `MoneyAmounts`, del arnés de la pasarela ni del endpoint del aviso se tocó. Sí se tocaron dos archivos de build que
no debían: los dos son los huecos del generador de § Arreglos.

## Comparación

| | keel-dotnet (MercadoPago) | keel-nest (MercadoPago, 2026-10-09) | keel-spring (MercadoPago, 2026-10-09) |
|---|---|---|---|
| Diseño | v1.2.0 | v1.1.0 | v1.1.0 |
| Matriz | **25/25 a la primera** | 25/25 | 25/25 |
| Registrados por build | 322 | 294 | 325 |
| Reescritos | **22** | 20 | 21 |

Quitando los dos huecos del generador, la huella es **20**, la de las gemelas: los trece handlers, los dos agregados,
`BrokerBindings.cs`, el `README.md`, el `TODO` del aplicador y la consulta de negocio del barrido en el puerto y en su
adaptador.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los trece handlers de `Application/UseCases/` | TODO legítimo |
| `Domain/Aggregate/{Payment,SavedPaymentMethod}.cs` | TODO legítimo: creación y transiciones |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo: el dispatcher del outbox y el listener de RabbitMQ |
| `README.md` | TODO legítimo |
| `Application/Payment/PaymentOutcomeApplier.cs` | TODO legítimo: el `cancelReason` que la capa no nombra (aceptado en `decisions.yaml`: `canceling` → `requested`; lo demás, `expired`). Además, una decisión sin escenario: un `refundedAmount` que no llega se toma del importe del cobro |
| `Domain/Repository/IPaymentRepository.cs` y `Persistence/Repositories/PaymentRepository.cs` | Consulta de negocio: `FindAwaitingBefore` y `ClaimForReconciliation`, los que enseña `references/reconciliation.md` |
| `tests/PaymentCheckout.UnitTests/UseCasesTests.cs` | **Generador** (arreglado) |
| `Infrastructure/Payment/Mercadopago/MercadopagoPaymentGateway.cs` | **Generador** (arreglado en el arnés de los tres, no en el adaptador) |

**Archivos nuevos del agente**: `Application/Support/ChargeRequestOrigin.cs` (el origen del cobro, ver § Arreglos),
`Messaging/RabbitMq/{ChargeRequestedListener,RabbitOutboxDispatcher}.cs`, el baseline de `dotnet ef` y los ocho
archivos de flujos.

## Arreglos

- **`UseCasesTests` sin la pasarela** (keel-dotnet). La prueba del contenedor que emite build no registraba
  `AddPayments`, y en cuanto el agente añadió `IPaymentGateway` a los handlers sus 15 filas cayeron: `ValidateOnBuild`
  no encontraba el puerto. El orquestador lo arregló a mano. Ahora build registra
  `services.AddPayments(PaymentGatewaySettings.Unreachable)` (una pasarela que no responde, como `HttpClientsSettings.Unreachable`).
  **Medido**: con un handler que recibe el puerto y el aplicador, 15/15 en rojo con lo emitido antes y 15/15 en verde
  con el arreglo; lo fija `test/payments.test.js`.
- **El rechazo de una acción de seguimiento en el arnés** (de los tres generadores). El escenario de la captura
  rechazada se programó solo con `GatewayRejects(Capture)`. Los adaptadores de los tres generadores, tras un 4xx en una
  captura, anulación o devolución, le preguntan a la pasarela el estado real; el doble no tenía nada programado para esa
  consulta, contestó 404 y el cobro salió `NotFound`, que el handler no puede distinguir del cobro que la pasarela no
  conoce. El agente lo resolvió **cambiando el adaptador** (`NotFound` tras un 4xx de captura o anulación → `Authorized`).
  En la devolución sí programó las dos cosas (`GatewayRejects` + `GatewayReports`), y por eso pasó sin tocar nada. El
  adaptador es correcto (la pasarela real conoce el cobro) y es el mismo servidor que el de los otros dos, así que el
  arreglo es decirlo donde lo lee el agente: el comentario de `GatewayRejects` en los tres arneses (keel-spring:
  `AbstractFlowIT`, línea base regenerada; keel-nest: `payment-gateway.ts`; keel-dotnet: `PaymentGateway.cs`) y
  `references/flows.md` de keel-nest y keel-dotnet, con el ejemplo y «no lo arregles en el adaptador». No lo había visto
  ninguna corrida: hasta la v1.2.0 ningún escenario rechazaba una acción de seguimiento.
- **El origen del cobro, quinta vez** (de los tres generadores, sin arreglar). `requestCharge` se trata distinto si
  llega por HTTP (precondición incumplida → 422) o por la suscripción (→ cobro `failed` y evento), y el comando no lo
  dice. Este agente lo resolvió con un `AsyncLocal` (`ChargeRequestOrigin`); en las gemelas, `fromSubscription` en el
  comando (keel-nest Stripe), un contexto propio (keel-nest MercadoPago) y el listener (keel-spring). Cinco corridas,
  cinco soluciones a mano: es candidato a una pieza neutral (la puerta por la que entra la operación, sabida por el
  mensaje) en `keel-core/gen` y en los tres generadores. Queda anotado en `PLAN-KEEL-DOTNET.md`.

Y una limitación que el agente señaló sin escenario que la ejerza: `GatewayStatus.Canceled` junta `canceled` y
`expired`, así que el `cancelReason` lo deduce el aplicador del estado previo del cobro y no de la pasarela. Es la
misma en los tres generadores.

## designGaps

Ninguno.
