---
name: keel-spring-stripe
description: Lo propio de Stripe en un proyecto keel-spring con capa payments — cómo habla el adaptador generado con Payment Intents, cómo se prueba en el sandbox de Stripe y cómo se lee un rechazo. La lógica de los cobros es la de keel-spring-payments, igual con cualquier pasarela. Usar cuando keel-stack.json tiene paymentGateway stripe.
---

# Stripe

**Primero `keel-spring-payments`**: ahí está lo que te toca y lo que no. Esto es solo lo que
cambia por ser Stripe. El adaptador (`StripePaymentGateway`) y el verificador
(`StripeNoticeVerifier`) ya están generados y no se tocan.

## Cómo habla el adaptador

- **Payment Intents**, cuerpos `application/x-www-form-urlencoded`, credencial `Bearer` con la
  clave secreta (`STRIPE_SECRET_KEY`).
- Importe **entero en la unidad menor** (`MoneyAmounts.toMinorUnits`).
- `capture_method=manual` con `flow: authorize-capture`; `confirm=true` y `payment_method_types[]=card`.
- La referencia del cobro viaja en `metadata[keel_reference]`: es lo que permite buscarlo cuando
  no llegó a contestar (`/v1/payment_intents/search`, eventualmente consistente).
- Medio guardado: `customer|payment_method` como referencia opaca; el cobro va con
  `off_session=true`. Si el emisor exige autenticar, Stripe responde 402 con
  `authentication_required` y el adaptador lo devuelve como `ACTION_REQUIRED` con el `client_secret`.
- `Idempotency-Key: <referencia>:<acción>` en todo POST.

## El aviso

`Stripe-Signature: t=…,v1=…`. El secreto (`STRIPE_WEBHOOK_SECRET`) es **el del endpoint**, no la
clave de la API, y es distinto en test y en live. Para probar en local contra el sandbox,
`stripe listen --forward-to localhost:<puerto>/webhooks/payments` imprime su propio secreto.

## Probar contra el sandbox

Ver `references/sandbox.md`: claves de test, tarjetas que fuerzan cada desenlace y qué comprobar.
La pasarela de prueba de `infra/` (WireMock) es lo que usan los escenarios; el sandbox es la
verificación contra la pasarela real.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/sandbox.md` | Para probar contra el sandbox de Stripe |

## Validación

- Los escenarios `FL-*` corren contra la pasarela de prueba de `infra/`: no necesitan credenciales.
- La verificación contra la pasarela real es manual, con el perfil `develop` y el sandbox
  (`references/sandbox.md`). No forma parte del pipeline de generación.
