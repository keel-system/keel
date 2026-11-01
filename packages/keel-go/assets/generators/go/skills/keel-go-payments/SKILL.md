---
name: keel-go-payments
description: Guía de los cobros con pasarela (capa payments) en un proyecto generado por keel-go — qué generó build y qué te toca a ti, cómo se cobra sin cobrar dos veces, y las defensas que no puedes quitar. Es la misma con cualquier pasarela; lo propio de la elegida está en su skill (keel-go-stripe, keel-go-mercadopago). Usar cuando el diseño declara la capa payments.
---

# Cobros con pasarela (capa `payments`)

**Lee esto antes de escribir el primer handler que toque un cobro.** Igual que con el correo, build genera
**más** de lo habitual: el puerto, el adaptador de la pasarela elegida y el aviso con su firma ya están escritos,
con la cabecera de código generado. Lo que te queda es la lógica de los casos de uso, y en ella está lo único que
puede cobrar dos veces. Es el mismo servidor que el de keel-spring, keel-nest y keel-dotnet del diseño: misma clave
de idempotencia, mismas variables, mismo aviso.

## Antes de empezar

- Aplica solo si el diseño declara la capa `payments` (mira `specs/payments.keel.yaml`, entero).
- Sigue `{{keel:docs}}/architecture.md`: `internal/application` solo ve los puertos de `internal/domain`, y la prueba
  de arquitectura (`internal/architecture`) falla si importa un adaptador.
- La pasarela elegida está en `keel-stack.json` (`paymentGateway`). Sus particularidades —sandbox, lo que está sin
  verificar, cómo se ve un rechazo— están en su skill.

## Qué dejó listo build — y qué NO vas a escribir

| Ya está | Dónde |
|---|---|
| El vocabulario neutro: estado, desenlace, medio de pago, petición de cobro, el aviso | `internal/domain/payment_gateway.go` (`GatewayStatus`, `GatewayOutcome`, `PaymentSource`, `ChargeRequest`, `PaymentNotice`) |
| «No se sabe qué hizo la pasarela» y «la pasarela no acepta el medio» | `*domain.PaymentGatewayUnavailableError` y `*domain.GatewayRejectedPaymentMethodError`, en el mismo archivo |
| Los puertos de salida | `domain.PaymentGateway` y `domain.PaymentNoticeVerifier`, en el mismo archivo |
| **El adaptador de la pasarela elegida**, entero, y **la verificación de la firma de sus avisos** | `internal/infrastructure/payment/<pasarela>.go` (`NewGateway`, `NewNoticeVerifier`) |
| El cliente HTTP de la pasarela, sin reintentos y sin keep-alive | `internal/infrastructure/payment/http.go` |
| La clave de idempotencia y la referencia de un medio guardado | `internal/infrastructure/payment/keys.go` |
| La conversión de importes (la tabla de unidades menores de keel-core) | `internal/infrastructure/payment/money.go` |
| La ruta del aviso (`POST /webhooks/payments`, sin credencial, cuerpo leído como texto) | `internal/httpapi/payment_notice.go` |
| Aviso → consulta a la pasarela → desenlace | `application.PaymentNotices`, en `internal/application/payment_outcomes.go` |
| Desenlace → la operación del diseño que lo aplica | `application.PaymentOutcomeApplier`, en el mismo archivo |
| La consulta del barrido para un cobro, su umbral y su lote | `application.PaymentReconciliation` (`Consult`, `StaleBefore`, `BatchSize`), en el mismo archivo |
| Configuración por perfil, con la pasarela de prueba en local | `config/parameters/<perfil>/payments.yaml` y `internal/infrastructure/payment/settings.go` |
| El cableado | `cmd/server/main.go` (`payment.SettingsFrom`, `payment.NewGateway`, `payment.NewNoticeVerifier`) |
| Las pruebas del adaptador y del verificador | `internal/infrastructure/payment/<pasarela>_test.go` |
| El arnés de la pasarela de prueba | `tests/integration/payment_gateway_test.go` (`s.GatewayAuthorizes`, `s.SendGatewayNotice`…) |

> **No escribas otro adaptador, no toques la verificación de la firma, no leas el estado del cuerpo del aviso y no
> hagas que la ruta del aviso lea el cuerpo con el contrato del cable.** Las razones están en `references/security.md`,
> y quitar cualquiera de esas cosas no rompe ningún escenario: el servidor sigue cobrando, y cobra mal. Además, esos
> archivos llevan la cabecera de código generado: `build --refresh` los reescribe.

## Lo que sí te toca

Los handlers de las operaciones que nombra la capa. build ya les inyecta lo que usan —`paymentGateway`,
`paymentOutcomes` o `paymentReconciliation`, según la operación—: está en el struct de cada handler. Siempre en este
orden, y el orden es la defensa:

1. **Cobro** (`charge.operation`): comprueba las precondiciones, **registra el cobro en `pending` con
   `AwaitingSince` y guárdalo** (`h.paymentRepository.Save(ctx, payment)`), y solo entonces llama a
   `h.paymentGateway.Authorize(ctx, request)` con un `domain.NewChargeRequest(...)`. Con la respuesta, aplica el
   desenlace con `h.paymentOutcomes.Apply(ctx, outcome)`.
   - La operación la despacha la ruta **sin transacción abarcadora** (`application.WithoutTransaction`), así que ese
     `Save` **confirma** antes de la llamada. No abras una transacción tuya alrededor.
   - Si `Authorize` devuelve un `*domain.PaymentGatewayUnavailableError` (míralo con `errors.As`): **no reintentes**.
     El cobro se queda en `pending` y respondes con él; lo resolverá el barrido.
   - La referencia de la `ChargeRequest` es `charge.reference`: de ella sale la clave de idempotencia hacia la
     pasarela. Nunca otra.
2. **Captura, anulación, devolución**: pasa el cobro a su estado en vuelo **y guárdalo**, después llama al puerto,
   después aplica el resultado. Sin respuesta: el cobro se queda en vuelo y respondes con él. Con un resultado que no
   es el esperado (una devolución que vuelve como `GatewayCaptured`), la pasarela la rechazó: aplica lo que declare el
   diseño en `onRejected` (la nota del handler lo dice).
   - Un importe parcial viaja **con la moneda del cobro**, que ya tienes en el registro: no se la preguntes a la
     pasarela.
   - **Guardar un medio** (`savePaymentMethod`): la pasarela que lo rechaza devuelve un
     `*domain.GatewayRejectedPaymentMethodError`, y la que no contesta, un `*domain.PaymentGatewayUnavailableError`.
     Tradúcelos **esos dos** a los errores que declare el diseño; cualquier otro error se devuelve tal cual, porque es
     un fallo de programación y tiene que salir como 500.
3. **Desenlaces** (`outcomes.*`): **idempotentes**. Si el cobro ya no está en el estado de origen —lo aplicó otro
   camino—, no hagas nada y no devuelvas error. Ver `references/outcomes.md`.
   - Al salir de un estado de espera, **vacía `AwaitingSince`** (y `CustomerAction` fuera de `actionRequired`).
   - Un cobro que rechazas **antes** de llamar a la pasarela nace sin el medio y sin `GatewayPaymentID`: lo que no
     llegó a existir no se anota.
   - Un dato del desenlace que la capa no nombra se decide en `internal/application/payment_outcome_choices.go`, sin la
     cabecera (`references/outcomes.md`).
4. **Barrido** (`reconciliation.sweep`): candidatos en los estados que esperan desenlace con `AwaitingSince`
   anterior a `h.paymentReconciliation.StaleBefore(now)`, como mucho `h.paymentReconciliation.BatchSize()`;
   **reclama** cada uno volviendo a estampar `AwaitingSince` con una escritura condicional que confirma sola, y llama a
   `h.paymentReconciliation.Consult(ctx, reference, gatewayPaymentID)`. Las dos consultas —candidatos y reclamo— van en
   los `<raíz>_queries.go` del registro. Ver `references/reconciliation.md`.

## Lo que nunca

- Datos de tarjeta en ningún sitio: solo tokens y referencias opacas.
- Un `uuid.New()` o un `rand` como clave de idempotencia.
- Decidir un desenlace leyendo el cuerpo del aviso.
- Reintentar una escritura a la pasarela tras un timeout o un 5xx.
- `float64` para un importe, o decidir los decimales de una moneda por tu cuenta: los importes son `wire.Decimal`, y la
  conversión la hace `money.go` con la tabla que comparten los cuatro servidores del diseño.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | Antes de tocar nada del aviso, del adaptador o de la idempotencia |
| `references/outcomes.md` | Al escribir los handlers de los desenlaces y al decidir lo de `payment_outcome_choices.go` |
| `references/reconciliation.md` | Al escribir el handler del barrido y su reclamo |
| `references/flows.md` | Al escribir los flujos `FL-*` que tocan la pasarela |
| `references/troubleshooting.md` | Cuando un escenario de pagos falla |

## Validación

- `go vet ./...`, `go tool staticcheck ./...` y `go test ./...` (incluye `<pasarela>_test.go`: si cae, tocaste una
  defensa), y los flujos `FL-*` (`bash infra/score-scenarios.sh`) contra la pasarela de prueba de `infra/` (WireMock
  hablando el protocolo de la elegida).
- `references/troubleshooting.md` para lo que suele fallar.
