---
name: keel-dotnet-payments
description: Guía de los cobros con pasarela (capa payments) en un proyecto generado por keel-dotnet — qué generó build y qué te toca a ti, cómo se cobra sin cobrar dos veces, y las defensas que no puedes quitar. Es la misma con cualquier pasarela; lo propio de la elegida está en su skill (keel-dotnet-stripe, keel-dotnet-mercadopago). Usar cuando el diseño declara la capa payments.
---

# Cobros con pasarela (capa `payments`)

**Lee esto antes de escribir el primer handler que toque un cobro.** Igual que con el correo, build genera
**más** de lo habitual: el puerto, el adaptador de la pasarela elegida y el aviso con su firma ya están escritos.
Lo que te queda es la lógica de los casos de uso, y en ella está lo único que puede cobrar dos veces. Es el mismo
servidor que el de keel-spring y keel-nest del diseño: misma clave de idempotencia, mismas variables, mismo aviso.

## Antes de empezar

- Aplica solo si el diseño declara la capa `payments` (mira `specs/payments.keel.yaml`, entero).
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: el proyecto
  Application solo ve los puertos (el compilador lo impide de otro modo).
- La pasarela elegida está en `keel-stack.json` (`paymentGateway`). Sus particularidades —sandbox, lo que está sin
  verificar, cómo se ve un rechazo— están en su skill.

## Qué dejó listo build — y qué NO vas a escribir

`<Raíz>` es el nombre de la solución (`PaymentCheckout`, por ejemplo).

| Ya está | Dónde |
|---|---|
| El vocabulario neutro: estado, desenlace, medio de pago, petición de cobro | `src/<Raíz>.Domain/Payment/GatewayStatus.cs`, `src/<Raíz>.Domain/Payment/GatewayOutcome.cs`, `src/<Raíz>.Domain/Payment/PaymentSource.cs`, `src/<Raíz>.Domain/Payment/ChargeRequest.cs` |
| «No se sabe qué hizo la pasarela» | `src/<Raíz>.Domain/Payment/PaymentGatewayUnavailableException.cs` |
| El puerto de salida | `src/<Raíz>.Application/Ports/IPaymentGateway.cs` |
| **El adaptador de la pasarela elegida**, entero, y **la verificación de la firma de sus avisos** | `src/<Raíz>.Infrastructure/Payment/<Pasarela>/` |
| El cliente HTTP de la pasarela, sin reintentos (tampoco por debajo) | `src/<Raíz>.Infrastructure/Payment/PaymentGatewayHttp.cs` |
| La clave de idempotencia y la referencia de un medio guardado | `src/<Raíz>.Infrastructure/Payment/GatewayKeys.cs` |
| La conversión de importes (la tabla de unidades menores de keel-core) | `src/<Raíz>.Infrastructure/Payment/MoneyAmounts.cs` |
| El endpoint del aviso (`POST /webhooks/payments`, sin credencial, cuerpo leído como texto) | `src/<Raíz>.Api/Rest/PaymentNoticeEndpoint.cs` |
| Aviso → consulta a la pasarela → desenlace | `src/<Raíz>.Application/Payment/PaymentNotices.cs` |
| Desenlace → la operación del diseño que lo aplica | `src/<Raíz>.Application/Payment/PaymentOutcomeApplier.cs` |
| La consulta del barrido para un cobro, su umbral y su lote | `src/<Raíz>.Application/Payment/PaymentReconciliation.cs` (`Consult`, `StaleBefore`, `BatchSize`) |
| Configuración por perfil, con la pasarela de prueba en local | `config/parameters/<perfil>/payments.yaml` y `src/<Raíz>.Infrastructure/Payment/PaymentGatewaySettings.cs` |
| El registro en el contenedor | `src/<Raíz>.Infrastructure/Payment/PaymentsRegistration.cs` (`AddPayments`, llamado desde `Program.cs`) |
| Las pruebas del adaptador y del aviso | `tests/<Raíz>.UnitTests/PaymentGatewayTests.cs`, `tests/<Raíz>.UnitTests/PaymentNoticeEndpointTests.cs` |
| El arnés de la pasarela de prueba | `tests/<Raíz>.IntegrationTests/Support/PaymentGateway.cs` (y `SendGatewayNotice` en `FlowTest`) |

> **No escribas otro adaptador, no toques la verificación de la firma, no leas el estado del cuerpo del aviso y no
> hagas que el endpoint del aviso lea el cuerpo con el contrato del cable.** Las razones están en
> `references/security.md`, y quitar cualquiera de esas cosas no rompe ningún escenario: el servidor sigue cobrando,
> y cobra mal.

## Lo que sí te toca

Los handlers de las operaciones que nombra la capa. build **no** les inyecta los puertos de la pasarela: añade tú
`IPaymentGateway`, `PaymentOutcomeApplier` o `PaymentReconciliation` a su constructor primario (el contenedor ya los
tiene registrados). Siempre en este orden, y el orden es la defensa:

1. **Cobro** (`charge.operation`): comprueba las precondiciones, **registra el cobro en `pending` con
   `AwaitingSince` y guárdalo** (`await paymentRepository.Save(payment, cancellationToken)`), y solo entonces llama a
   `paymentGateway.Authorize(new ChargeRequest(...), cancellationToken)`. Con la respuesta, aplica el desenlace con
   `paymentOutcomeApplier.Apply(outcome, cancellationToken)` (o directamente la transición, si estás en la misma
   operación).
   - La operación la despacha el endpoint **sin transacción abarcadora** (`DispatchWithoutTransaction`), así que ese
     `Save` **confirma** antes de la llamada. No la envuelvas en una transacción tuya.
   - Si `Authorize` lanza `PaymentGatewayUnavailableException`: **no reintentes**. El cobro se queda en `pending` y
     respondes con él; lo resolverá el barrido.
   - La referencia de la `ChargeRequest` es `charge.reference`: de ella sale la clave de idempotencia hacia la
     pasarela. Nunca otra.
2. **Captura, anulación, devolución**: pasa el cobro a su estado en vuelo (`inFlight`) **y guárdalo**, después llama
   al puerto, después aplica el resultado. Sin respuesta: el cobro se queda en vuelo y respondes con él. Con un
   resultado que no es el esperado (una devolución que vuelve como `Captured`), la pasarela la rechazó: aplica lo que
   declare el diseño en `onRejected` (la nota del handler lo dice).
   - Un importe parcial viaja **con la moneda del cobro**, que ya tienes en el registro: no le preguntes la moneda a
     la pasarela.
   - **Guardar un medio** (`savePaymentMethod`): la pasarela que lo rechaza lanza
     `GatewayRejectedPaymentMethodException` (`src/<Raíz>.Domain/Payment/GatewayRejectedPaymentMethodException.cs`), y la
     que no contesta, `PaymentGatewayUnavailableException`. Captura **esas dos** y tradúcelas a los errores que declare
     el diseño; cualquier otra excepción se deja pasar, porque es un fallo de programación y tiene que salir como 500.
3. **Desenlaces** (`outcomes.*`): **idempotentes**. Si el cobro ya no está en el estado de origen —lo aplicó otro
   camino—, no hagas nada y no lances. Ver `references/outcomes.md`.
   - Al salir de un estado de espera, **vacía `AwaitingSince`** (y `CustomerAction` fuera de `actionRequired`).
   - Un cobro que rechazas **antes** de llamar a la pasarela nace sin el medio y sin `GatewayPaymentId`: lo que no
     llegó a existir no se anota.
4. **Barrido** (`reconciliation.sweep`): candidatos en los estados que esperan desenlace con `AwaitingSince`
   anterior a `paymentReconciliation.StaleBefore()`, como mucho `paymentReconciliation.BatchSize()`; **reclama** cada
   uno volviendo a estampar `AwaitingSince` en una escritura condicional con su propia transacción, y llama a
   `paymentReconciliation.Consult(reference, gatewayPaymentId, cancellationToken)`. Ver `references/reconciliation.md`.

## Lo que nunca

- Datos de tarjeta en ningún sitio: solo tokens y referencias opacas.
- Un `Guid.NewGuid()` como clave de idempotencia.
- Decidir un desenlace leyendo el cuerpo del aviso.
- Reintentar una escritura a la pasarela tras un timeout o un 5xx.
- `RegionInfo`/`CultureInfo` para saber los decimales de una moneda: usa `MoneyAmounts`, la tabla que comparten los
  tres servidores del diseño.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | Antes de tocar nada del aviso, del adaptador o de la idempotencia |
| `references/outcomes.md` | Al escribir los handlers de los desenlaces y al completar el TODO del aplicador |
| `references/reconciliation.md` | Al escribir el handler del barrido |
| `references/flows.md` | Al escribir los flujos `FL-*` que tocan la pasarela |
| `references/troubleshooting.md` | Cuando un escenario de pagos falla |

## Validación

- `dotnet build` sin warnings, `dotnet test` (incluye `PaymentGatewayTests` y `PaymentNoticeEndpointTests`: si una cae,
  tocaste una defensa) y los flujos `FL-*` (`bash infra/score-scenarios.sh`) contra la pasarela de prueba de `infra/`
  (WireMock hablando el protocolo de la elegida).
- `references/troubleshooting.md` para lo que suele fallar.
