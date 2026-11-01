# El sandbox de Stripe

Con claves `sk_test_…` (y el `whsec_…` de un endpoint de test), en el perfil `develop`:
`STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`, con `STRIPE_BASE_URL` sin tocar.

## Tarjetas que fuerzan cada desenlace

Como `payment_method` (tokens de test de Stripe, sin componente de navegador):

| Desenlace | payment_method |
|---|---|
| Autorizado | `pm_card_visa` |
| Rechazo genérico (`declined`) | `pm_card_chargeDeclined` |
| Sin fondos (`insufficientFunds`) | `pm_card_chargeDeclinedInsufficientFunds` |
| Caducada (`expiredCard`) | `pm_card_chargeDeclinedExpiredCard` |
| Antifraude (`fraudSuspected`) | `pm_card_chargeDeclinedFraudulent` |
| Exige 3DS (`ACTION_REQUIRED`) | `pm_card_threeDSecure2Required` |

## Qué comprobar

- Cada fila de arriba acaba en el estado y el motivo que dice la tabla.
- Un cobro repetido con la misma referencia no crea un segundo PaymentIntent.
- `stripe trigger payment_intent.succeeded` llega como aviso, verifica y se consulta.
- Un aviso con el secreto equivocado responde 401.
