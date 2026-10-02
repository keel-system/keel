---
name: keel-spring-payments
description: Guía de los cobros con pasarela (capa payments) en un proyecto generado por keel-spring — qué generó build y qué te toca a ti, cómo se cobra sin cobrar dos veces, y las defensas que no puedes quitar. Es la misma con cualquier pasarela; lo propio de la elegida está en su skill (keel-spring-stripe, keel-spring-mercadopago). Usar cuando el diseño declara la capa payments.
---

# Cobros con pasarela (capa `payments`)

**Lee esto antes de escribir el primer handler que toque un cobro.** Igual que con el correo,
build genera **más** de lo habitual: el puerto, el adaptador de la pasarela elegida y el aviso
con su firma ya están escritos. Lo que te queda es la lógica de los casos de uso, y en ella está
lo único que puede cobrar dos veces.

## Antes de empezar

- Aplica solo si el diseño declara la capa `payments` (mira `specs/payments.keel.yaml`).
- Lee ese artefacto entero, y `{{keel:docs}}/conventions/mapping.md`.
- La pasarela elegida está en `keel-stack.json` (`paymentGateway`). Sus particularidades —sandbox,
  lo que está sin verificar, cómo se ve un rechazo— están en su skill.

## Qué dejó listo build — y qué NO vas a escribir

| Ya está | Dónde |
|---|---|
| El vocabulario neutro: estado, desenlace, medio de pago, petición de cobro | `domain/payment/` |
| El puerto de salida | `application/port/out/PaymentGateway` |
| **El adaptador de la pasarela elegida**, entero | `infrastructure/payment/<pasarela>/<Pasarela>PaymentGateway` |
| **La verificación de la firma de sus avisos** | `infrastructure/payment/<pasarela>/<Pasarela>NoticeVerifier` |
| El endpoint del aviso (`POST /webhooks/payments`, sin credencial) | `infrastructure/payment/PaymentNoticeController` |
| Aviso → consulta a la pasarela → desenlace | `application/payment/PaymentNotices` |
| Desenlace → la operación del diseño que lo aplica | `application/payment/PaymentOutcomeApplier` |
| La consulta del barrido para un cobro | `application/payment/PaymentReconciliation` |
| Configuración por perfil, con la pasarela de prueba en local | `parameters/<perfil>/payments.yaml` |

> **No escribas otro adaptador, no toques la verificación de la firma y no leas el estado del
> cuerpo del aviso.** Las razones están en `references/security.md`, y quitar cualquiera de esas
> cosas no rompe ningún escenario: el servidor sigue cobrando, y cobra mal.

## Lo que sí te toca

Los handlers de las operaciones que nombra la capa. Siempre en este orden, y el orden es la
defensa:

1. **Cobro** (`charge.operation`): comprueba las precondiciones, **registra el cobro en `pending`
   con `awaitingSince` y confirma la transacción**, y solo entonces llama a
   `paymentGateway.authorize(...)`. Con la respuesta, aplica el desenlace con
   `PaymentOutcomeApplier` (o directamente la transición, si estás en la misma operación).
   - Si `authorize` lanza `PaymentGatewayUnavailableException`: **no reintentes**. El cobro se
     queda en `pending` y respondes con él; lo resolverá el barrido.
   - La referencia de la `ChargeRequest` es `charge.reference`: de ella sale la clave de
     idempotencia hacia la pasarela. Nunca otra.
2. **Captura, anulación, devolución**: pasa el cobro a su estado en vuelo (`inFlight`) **y
   confirma**, después llama al puerto, después aplica el resultado. Sin respuesta: el cobro se
   queda en vuelo y respondes con él. Con un resultado que no es el esperado (una devolución que
   vuelve como `CAPTURED`), la pasarela la rechazó: aplica el error que declara el diseño.
   - Un importe parcial viaja **con la moneda del cobro**, que ya tienes en el registro: no le
     preguntes la moneda a la pasarela. Cualquier llamada extra antes de la acción tendría que ir
     dentro del mismo tratamiento de «sin respuesta», y es mejor que no exista.
3. **Desenlaces** (`outcomes.*`): **idempotentes**. Si el cobro ya no está en el estado de origen
   —lo aplicó otro camino—, no hagas nada y no lances. Ver `references/outcomes.md`.
4. **Barrido** (`reconciliation.sweep`): candidatos en los estados que esperan desenlace con
   `awaitingSince` más antiguo que `payments.reconciliation.unanswered-after-seconds`; **reclama**
   cada uno volviendo a estampar `awaitingSince` en una actualización condicional, y llama a
   `paymentReconciliation.consult(reference, gatewayPaymentId)`. Ver `references/reconciliation.md`.

En los escenarios, `gatewayExpiresAuthorization(referencia)` simula la autorización que caducó
antes de capturarse, y `ageForReconciliation("<barrido>", id)` deja rancia la marca de espera de
un cobro para que lo tome la próxima pasada del barrido. No escribas un UPDATE a mano para eso.

Por qué el registro va **antes** y en su propia transacción: si la llamada a la pasarela va dentro
de una transacción que después se deshace, la pasarela cobró y aquí no queda nada que reconciliar.

## Lo que nunca

- Datos de tarjeta en ningún sitio: solo tokens y referencias opacas.
- Un `UUID.randomUUID()` como clave de idempotencia.
- Decidir un desenlace leyendo el cuerpo del aviso.
- Reintentar una escritura a la pasarela tras un timeout o un 5xx.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/security.md` | Antes de tocar nada del aviso, del adaptador o de la idempotencia |
| `references/outcomes.md` | Al escribir los handlers de los desenlaces |
| `references/reconciliation.md` | Al escribir el handler del barrido |
| `references/troubleshooting.md` | Cuando un escenario de pagos falla |

## Validación

- `./gradlew compileJava` y el `integrationTest` de los escenarios `FL-*`, contra la pasarela de
  prueba de `infra/` (WireMock hablando el protocolo de la elegida).
- `references/troubleshooting.md` para lo que suele fallar.
