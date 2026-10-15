# Corrida `payment-checkout` con Stripe — keel-dotnet (incremento 13e)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.2.0 (DSL 2.21, relacional, con `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-dotnet@0.0.1` (incremento 13a–13d más los arreglos de la corrida de MercadoPago, `492b743`; proyecto puesto al día con `build --refresh`) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** (primera pasada 21/25: los cuatro `FL-EVT-*`, ver § Arreglos) |
| Huella del agente | 322 archivos registrados por `build`, 0 adoptados, **21 reescritos**, 0 borrados |
| Huecos del diseño | 1 en `design-gaps.yaml` (`cancelPayment`, el motivo de la anulación), el mismo que la corrida de MercadoPago señaló como limitación |
| Huecos del generador | 1 arreglado (una divergencia del servidor de keel-dotnet) + 1 que repite en las seis corridas de pagos |
| Convertidos en id | — |
| Clasificación de la huella | 18 TODO · 2 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo |

La segunda corrida del incremento 13 de `PLAN-KEEL-DOTNET.md`, sobre el mismo diseño que la de MercadoPago y **con sus dos
arreglos ya dentro** (el proyecto se puso al día con `build --refresh` antes de lanzar el pipeline; el refresh tocó solo
los cinco archivos de esos arreglos). Por eso mide también si los arreglos funcionan.

## Cómo terminó

**25/25**, con `score-scenarios.sh` en 0, 164/164 pruebas unitarias, `check-idempotency.sh` en verde y la línea base de
migraciones verificada (51 elementos). La primera pasada dio 21/25: los cuatro escenarios de la suscripción cayeron
porque el servidor descartaba el mensaje (§ Arreglos), y el agente lo resolvió con un `harnessPatch` sobre
`Support/Messaging.cs`.

**Los dos arreglos de la corrida de MercadoPago, confirmados**: el agente no tocó `UseCasesTests.cs` (el contenedor de
prueba ya registra `AddPayments`) ni el adaptador de Stripe (programó la captura y la anulación rechazadas con
`GatewayRejects` + `GatewayReports`, como enseña ahora `flows.md`).

## Comparación

| | keel-dotnet Stripe | keel-dotnet MercadoPago | keel-nest Stripe (2026-10-09, v1.1.0) | keel-spring Stripe (2026-10-09, v1.1.0) |
|---|---|---|---|---|
| Matriz | 25/25 (21 en la primera pasada) | 25/25 a la primera | 25/25 | 25/25 |
| Reescritos | **21** | 22 | 20 | 20 |
| Del generador | 1 (`Messaging.cs`) | 2 (`UseCasesTests.cs`, el adaptador) | — | — |

Quitando el del generador, **20**: la huella de las gemelas, archivo por archivo.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los trece handlers de `Application/UseCases/` | TODO legítimo |
| `Domain/Aggregate/{Payment,SavedPaymentMethod}.cs` | TODO legítimo |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo |
| `README.md` | TODO legítimo |
| `Application/Payment/PaymentOutcomeApplier.cs` | TODO legítimo: el `cancelReason` que la capa no nombra (el aceptado en `decisions.yaml`) |
| `Domain/Repository/IPaymentRepository.cs` y `Persistence/Repositories/PaymentRepository.cs` | Consulta de negocio: el reclamo y los candidatos del barrido, los de `references/reconciliation.md` |
| `tests/PaymentCheckout.IntegrationTests/Support/Messaging.cs` | **Generador** (arreglado en el servidor, no en el arnés) |

## Arreglos

- **El `eventId` de la envoltura Keel: keel-dotnet lo exigía uuid** (divergencia del servidor). El helper
  `DeliverChargeRequested` del arnés escribe el `messageId` del escenario (`evt-ch-010`) en `metadata.eventId`, y el
  lector de la envoltura de keel-dotnet lo rechazaba (`MessageContractViolation: metadata.eventId no es un uuid`) y el
  mensaje iba al descarte. El agente lo resolvió **en el arnés**, convirtiendo el id en un uuid determinista. Pero el
  arnés es el mismo en los tres generadores, y en keel-spring y keel-nest `EventMetadata.eventId` es **texto**: los otros
  dos servidores procesan ese mismo mensaje. El defecto era del servidor de keel-dotnet, que era más estricto que sus
  hermanos con un mensaje ajeno. Ahora `EventMetadata.EventId` es `string` (el emisor lo sigue estampando como uuid), el
  lector no le exige forma, y la prueba emitida `MessagingTests` lleva el caso (`UnEventIdQueNoEsUuidSeLeeTalCual`) en
  lugar del rechazo. La corrida de MercadoPago no lo vio porque su agente escribió ids de mensaje con forma de uuid.
- **El origen del cobro, sexta vez** (de los tres generadores, sin arreglar): `ChargeOrigin`, otro `AsyncLocal`. Ver la
  corrida de MercadoPago; candidato a pieza neutral.

## designGaps

- `payments-cancel-reason`: `cancelPayment` no distingue una anulación confirmada de una autorización que la pasarela da
  por caducada al rechazar la anulación; las dos llegan como `Canceled` y el `cancelReason` sale de lo que el aplicador
  deduce del estado previo. La corrida de MercadoPago lo señaló como limitación del adaptador; esta, como hueco del
  diseño. **Dos corridas distintas, el mismo hueco**: por la regla de `docs/corridas/README.md`, candidato obligatorio a
  id. Es de la capa (`GatewayOutcome` no lleva el motivo de la anulación, y `payments.outcomes.canceled` no puede
  declararlo), así que se decide en la próxima minor de la capa, no en el generador.

Observación del agente sin escenario detrás: el handler del barrido no tiene logger (la capa Application no lo inyecta), y
traga por cobro la `PaymentGatewayUnavailableException` sin registrarla.
