---
name: keel-nest-payments
description: Guía de los cobros con pasarela (capa payments) en un proyecto generado por keel-nest — qué generó build y qué te toca a ti, cómo se cobra sin cobrar dos veces, y las defensas que no puedes quitar. Es la misma con cualquier pasarela; lo propio de la elegida está en su skill (keel-nest-stripe, keel-nest-mercadopago). Usar cuando el diseño declara la capa payments.
---

# Cobros con pasarela (capa `payments`)

**Lee esto antes de escribir el primer handler que toque un cobro.** Igual que con el correo, build genera
**más** de lo habitual: el puerto, el adaptador de la pasarela elegida y el aviso con su firma ya están escritos.
Lo que te queda es la lógica de los casos de uso, y en ella está lo único que puede cobrar dos veces. Es el mismo
servidor que el de keel-spring del diseño: misma clave de idempotencia, mismas variables, mismo aviso.

## Antes de empezar

- Aplica solo si el diseño declara la capa `payments` (mira `specs/payments.keel.yaml`, entero).
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: `src/application`
  no importa Nest; usa los puertos.
- La pasarela elegida está en `keel-stack.json` (`paymentGateway`). Sus particularidades —sandbox, lo que está sin
  verificar, cómo se ve un rechazo— están en su skill.

## Qué dejó listo build — y qué NO vas a escribir

| Ya está | Dónde |
|---|---|
| El vocabulario neutro: estado, desenlace, medio de pago, petición de cobro | `src/domain/payment/gateway-status.ts`, `src/domain/payment/gateway-outcome.ts`, `src/domain/payment/payment-source.ts`, `src/domain/payment/charge-request.ts` |
| «No se sabe qué hizo la pasarela» | `src/domain/payment/payment-gateway-unavailable-exception.ts` |
| El puerto de salida | `src/application/port/out/payment-gateway.ts` — `PaymentGateway` |
| **El adaptador de la pasarela elegida**, entero, y **la verificación de la firma de sus avisos** | `src/infrastructure/payment/<pasarela>/` |
| El cliente HTTP de la pasarela, sin reintentos | `src/infrastructure/payment/payment-gateway-http.ts` |
| La conversión de importes (la tabla de unidades menores de keel-core, no `Intl`) | `src/infrastructure/payment/money-amounts.ts` |
| El endpoint del aviso (`POST /webhooks/payments`, sin credencial, cuerpo sin leer) | `src/infrastructure/payment/payment-notice-controller.ts` |
| Aviso → consulta a la pasarela → desenlace | `src/application/payment/payment-notices.ts` — `PaymentNotices` |
| Desenlace → la operación del diseño que lo aplica | `src/application/payment/payment-outcome-applier.ts` — `PaymentOutcomeApplier` |
| La consulta del barrido para un cobro, y su umbral | `src/application/payment/payment-reconciliation.ts` — `PaymentReconciliation` (`consult`, `staleBefore`) |
| Configuración por perfil, con la pasarela de prueba en local | `config/parameters/<perfil>/payments.yaml` y `src/infrastructure/payment/payment-gateway-settings.ts` |
| Módulo (global) | `src/infrastructure/payment/payments-module.ts` |
| El arnés de la pasarela de prueba | `test/integration/support/payment-gateway.ts`, reexportado por `flow.ts` |

> **No escribas otro adaptador, no toques la verificación de la firma, no leas el estado del cuerpo del aviso y no
> quites la excepción del lector JSON para `/webhooks/payments` en `src/infrastructure/http/http-platform.ts`.** Las
> razones están en `references/security.md`, y quitar cualquiera de esas cosas no rompe ningún escenario: el
> servidor sigue cobrando, y cobra mal.

## Lo que sí te toca

Los handlers de las operaciones que nombra la capa. build **no** les inyecta los puertos de la pasarela: añade tú
`PaymentGateway`, `PaymentOutcomeApplier` o `PaymentReconciliation` a su `static readonly inject` y a su
constructor, en el mismo orden. Siempre en este orden, y el orden es la defensa:

1. **Cobro** (`charge.operation`): comprueba las precondiciones, **registra el cobro en `pending` con
   `awaitingSince` y guárdalo** (`await this.paymentRepository.save(payment)`), y solo entonces llama a
   `this.paymentGateway.authorize(new ChargeRequest(...))`. Con la respuesta, aplica el desenlace con
   `this.paymentOutcomeApplier.apply(outcome)` (o directamente la transición, si estás en la misma operación).
   - La operación la despacha el controlador **sin transacción abarcadora** (`dispatchWithoutTransaction`), así
     que ese `save` **confirma** antes de la llamada. No la envuelvas en una transacción tuya.
   - Si `authorize` lanza `PaymentGatewayUnavailableException`: **no reintentes**. El cobro se queda en `pending`
     y respondes con él; lo resolverá el barrido.
   - La referencia de la `ChargeRequest` es `charge.reference`: de ella sale la clave de idempotencia hacia la
     pasarela. Nunca otra.
2. **Captura, anulación, devolución**: pasa el cobro a su estado en vuelo (`inFlight`) **y guárdalo**, después
   llama al puerto, después aplica el resultado. Sin respuesta: el cobro se queda en vuelo y respondes con él. Con
   un resultado que no es el esperado (una devolución que vuelve como `CAPTURED`), la pasarela la rechazó: aplica el
   error que declara el diseño.
   - Un importe parcial viaja **con la moneda del cobro**, que ya tienes en el registro: no le preguntes la moneda
     a la pasarela.
3. **Desenlaces** (`outcomes.*`): **idempotentes**. Si el cobro ya no está en el estado de origen —lo aplicó otro
   camino—, no hagas nada y no lances. Ver `references/outcomes.md`.
   - Al salir de un estado de espera, **vacía `awaitingSince`** (y `customerAction` fuera de `actionRequired`).
   - Un cobro que rechazas **antes** de llamar a la pasarela nace sin el medio y sin `gatewayPaymentId`: lo que no
     llegó a existir no se anota.
4. **Barrido** (`reconciliation.sweep`): candidatos en los estados que esperan desenlace con `awaitingSince`
   anterior a `this.paymentReconciliation.staleBefore()`; **reclama** cada uno volviendo a estampar
   `awaitingSince` en una escritura condicional con su propia transacción, y llama a
   `this.paymentReconciliation.consult(reference, gatewayPaymentId)`. Ver `references/reconciliation.md`.

## Lo que nunca

- Datos de tarjeta en ningún sitio: solo tokens y referencias opacas.
- Un `randomUUID()` como clave de idempotencia.
- Decidir un desenlace leyendo el cuerpo del aviso.
- Reintentar una escritura a la pasarela tras un timeout o un 5xx.
- `Intl.NumberFormat` para saber los decimales de una moneda: discrepa del servidor de keel-spring en 25 monedas.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | Antes de tocar nada del aviso, del adaptador o de la idempotencia |
| `references/outcomes.md` | Al escribir los handlers de los desenlaces y al completar el TODO del aplicador |
| `references/reconciliation.md` | Al escribir el handler del barrido |
| `references/flows.md` | Al escribir los flujos `FL-*` que tocan la pasarela |
| `references/troubleshooting.md` | Cuando un escenario de pagos falla |

## Validación

- `npm run typecheck` y los flujos `FL-*` (`bash infra/score-scenarios.sh`) contra la pasarela de prueba de
  `infra/` (WireMock hablando el protocolo de la elegida).
- `references/troubleshooting.md` para lo que suele fallar.
