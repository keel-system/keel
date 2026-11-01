# Corrida `payment-checkout` con MercadoPago — keel-go (incremento 13d)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.2.0 (DSL 2.21, relacional, con `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · mercadopago` |
| Generador | `keel-go@0.1.0` (`87457af1`, incrementos 13b y 13c) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** a la primera (59 casos, sin arbitraje) |
| Huella del agente | 274 archivos registrados por `build`, 0 adoptados, **20 reescritos**, 0 borrados |
| Clasificación de la huella | 18 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 1 en `design-gaps.yaml` (`payments-cancel-reason`, repetido) |
| Huecos del generador | 1, el mismo que la corrida de Stripe: la puerta por la que entra `requestCharge` |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo |

La gemela de `2026-11-01-payment-checkout-stripe-go.md`, lanzada a la vez en su propio workspace
(`spring-live-test/corrida-payment-checkout-mercadopago-go`). Lo común a las dos (antes del pipeline, la comparación con las
gemelas de los otros tres generadores y el arreglo) está allí.

## Cómo terminó

**25/25** en la primera puntuación, sin `harnessPatches`, sin `culprit: harness`, sin falsos negativos y sin fixes de
`infra/` ni de `go.mod`. La primera puntuación de `keel-go-quality` se solapó con otra y falló por compartir servidor y
base; relanzada sola, 25/25.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integration/junit.xml`: 59 casos, 0 `<failure>` y 0 `<skipped>`, en 1400 s.
- gofmt vacío; `go vet` y staticcheck limpios con y sin `-tags integration`; `go mod tidy -diff` sin cambios.
- `check-idempotency.sh` en VERDE.
- `specs.sha256` intacto y `keel-go build --check` al día.

## La huella

Los mismos 20 archivos que la corrida de Stripe, con la misma clasificación (los trece handlers, los dos `_behavior.go`,
`payment_outcome_choices.go`, `broker.go` y el README como TODO; los dos `payment_queries.go` como consulta de negocio). El
código de los handlers difiere de una corrida a otra (dos agentes, dos redacciones), pero ninguno de los dos nombra la
pasarela en `internal/application` ni en el dominio: la pasarela no se cuela en lo que escribe el agente, que es lo que
pide la capa neutra. El reclamo del barrido es el mismo, con `ORDER BY awaiting_since, id` (desempate estable que la de
Stripe no puso) y el `cancelReason` la misma regla.

**Archivos nuevos del agente**: `internal/application/payment_support.go`, `internal/application/channel.go` (el marcador
`ViaSubscription(ctx)`: la puerta de `requestCharge` reinventada, ver el arreglo en la corrida de Stripe) y los siete de
flujos de `tests/integration/`.

## designGaps

- `payments-cancel-reason` (payments, `cancelPayment`): `cancelPayment` no distingue una anulación confirmada de una que la
  pasarela rechaza porque la autorización ya caducó. Las dos llegan como `GatewayCanceled` (el adaptador que genera build
  las traduce así, en las dos pasarelas y en los cuatro generadores), y el aplicador, que ve el cobro en `canceling`, elige
  `requested` donde la decisión aceptada pide `expired`. Ningún `FL-*` lo cubre. Es la misma clave que la corrida
  `2026-10-15-payment-checkout-stripe-dotnet.md` (y la limitación que señaló su gemela de MercadoPago); la de Stripe de
  keel-go lo vio y lo dio por cubierto con la decisión. **Ya repetido en dos generadores**: es de la capa —
  `GatewayOutcome` no lleva el motivo de la anulación y `payments.outcomes.canceled` no puede declararlo—, así que se
  decide en la próxima minor de la capa `payments`, no en un generador.
