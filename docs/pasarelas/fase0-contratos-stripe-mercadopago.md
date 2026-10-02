# Fase 0 — Contratos reales de Stripe y MercadoPago

Insumo de la capa `payments` (DSL 2.19) y de la matriz `keel-spring/src/lib/gateway-support.js`. Plan: pasarela de pago como stack.

Verificado el 2026-10-02 contra la documentación oficial. Lo marcado **a verificar en sandbox** no lo afirma la documentación consultada y no debe entrar como `supported` hasta que una red lo ejecute.

## Hallazgo que cambia el plan: MercadoPago va por la API de Orders

El cobro **off-session** (tarjeta guardada, sin CVV y sin token nuevo del frontend) en MercadoPago solo existe en la API de **Orders** (`/v1/orders`), con «pagos automáticos»:

- **Primer cobro**: `payer.customer_id` + token de tarjeta + `stored_credential { store_payment_method: true, first_payment: true, reason: recurring, payment_initiator: customer }`. Crea un `payment_profile`.
- **Siguientes cobros**: `customer_id` + `payment_profile_id`, **sin CVV ni token nuevo**.

La API clásica `/v1/payments` cobra con token de tarjeta, y el token lo genera el frontend. Por eso el adaptador de MercadoPago se construye **entero** sobre Orders y no sobre `/v1/payments`. Orders cubre:
- autorización/captura (`capture_mode: manual`, solo tarjeta de crédito);
- reembolso total y parcial;
- disponibilidad en AR, BR, CL, CO, MX, PE y UY.

Consecuencia para el diseño neutro: **guardar el medio de pago es una operación propia**, no un efecto lateral del cobro. En Stripe es un SetupIntent o `setup_future_usage`; en MercadoPago, el primer cobro con `stored_credential`. La capa `payments` tiene que nombrar esa referencia guardada de forma neutra (`savedPaymentMethodRef`) y el adaptador la traduce: `customer` + `payment_method` en Stripe, `customer_id` + `payment_profile_id` en MercadoPago.

## Matriz por eje

| Eje | Stripe | MercadoPago (Orders) |
|---|---|---|
| Autorización / captura | `capture_method=manual` → estado `requires_capture` → `POST /v1/payment_intents/{id}/capture` | `capture_mode: manual` (solo crédito) + operación de captura de la order |
| Captura parcial | `amount_to_capture`; el resto se **libera solo**; una sola captura (salvo multicapture) | `/v1/payments/{id}` admite `transaction_amount` en la captura. **En Orders: a verificar en sandbox** |
| Validez de la autorización (tarjeta, no presente) | 7 días (Visa MIT: 4 d 18 h). Al expirar → `canceled` | **A verificar** |
| Reembolso parcial | Sí | Sí (importe + id de transacción) |
| Idempotencia saliente | `Idempotency-Key`, ≤255 caracteres, en todo `POST`. Guarda **también los 500**. Las claves pueden purgarse **pasadas 24 h**. Parámetros distintos con la misma clave → error | `X-Idempotency-Key` |
| Importe | Entero en unidades menores (`1099`) | Decimal en unidades mayores (`75`) |
| Cobro off-session | `customer` + `payment_method` + `off_session=true` + `confirm=true`. Si el emisor exige autenticación: error con `decline_code: authentication_required` y el PaymentIntent queda en `requires_payment_method`; se trae al cliente con su `client_secret` | `customer_id` + `payment_profile_id` en `/v1/orders`. **Respuesta ante autenticación exigida: a verificar** |
| Acción del cliente (3DS) | `next_action` + `client_secret` (Stripe.js) | Propia de Orders. **Forma: a verificar** |
| Webhook: cabecera | `Stripe-Signature: t=…,v1=…[,v1=…][,v0=…]` | `x-signature: ts=…,v1=…` + `x-request-id` |
| Webhook: qué se firma | `"{t}.{cuerpo crudo}"`, HMAC-SHA256 con el secreto del endpoint (`whsec_…`). Solo vale `v1` (ignorar el resto contra downgrade). Varias `v1` durante la rotación del secreto (hasta 24 h) | Manifiesto `id:{data.id};request-id:{x-request-id};ts:{ts};`, HMAC-SHA256 con la clave secreta de la aplicación. `data.id` sale del **query param**, en minúsculas. Lo que falte se quita del manifiesto |
| Webhook: ¿cubre la firma el cuerpo? | **Sí** | **No**: solo id, request-id y ts |
| Webhook: anti-replay | Tolerancia de 5 min (default de las librerías); cada reintento trae timestamp nuevo; tolerancia 0 desactiva el chequeo | `ts` disponible; **ventana no documentada** → aplicar la misma tolerancia |
| Webhook: contenido | Snapshot (objeto completo en `data.object`) | Thin (solo el id del recurso) |
| Webhook: entrega | Reintentos hasta 3 días (sandbox: 3 en unas horas). Sin orden garantizado. Duplicados posibles → deduplicar por `event.id`. Hay que responder 2xx rápido | Reintentos con política propia. **A verificar** |
| Comparación de firma | Tiempo constante | Tiempo constante (`MessageDigest.isEqual` en su ejemplo Java) |
| Doble de prueba | WireMock (stripe-mock no tiene estado ni emite webhooks) | WireMock |

## Consecuencias para la capa neutra y para build

1. **El desenlace nunca se toma del cuerpo del webhook: se consulta.** En MercadoPago es obligatorio, porque la firma no cubre el cuerpo y quien lo altere en tránsito controla el estado. En Stripe es opcional, porque el cuerpo está firmado. Build genera las dos ramas, pero el **contrato neutro es el mismo**: el webhook solo *avisa* de que algo cambió en el pago X, y la verdad sale de `getStatus(X)`. Además:
   - simplifica la paridad: la misma lógica de reconciliación sirve para el webhook y para el barrido;
   - neutraliza el desorden de entrega: se consulta el estado actual, no se aplica el evento.
2. **La clave de idempotencia no basta sola contra el doble cobro.** Stripe guarda el 500 con su clave, así que reintentar un 500 con la misma clave devuelve el mismo 500. Y la purga a las 24 h abre la puerta a un segundo cargo. La guarda permanente es la nuestra: la `naturalKey` sobre `chargeRequestId` más un pago «en duda» que se resuelve con el barrido de reconciliación (`getStatus`), nunca reintentando la creación a ciegas. Consecuencias:
   - `reconciledBy` **no puede ser opcional** en la capa `payments`: la obligación del plan pasa a ser `waivable: false`;
   - el adaptador no reintenta la creación tras un 5xx o un timeout: la marca en duda y la deja al barrido.
3. **El importe en el diseño es decimal con moneda (`Money`).** La conversión a unidades menores es del adaptador de Stripe. Además, la escala de cada moneda (JPY 0, USD 2, KWD 3) es dato del adaptador, no del diseño.
4. **Captura parcial**: `supported` en Stripe; en MercadoPago queda `unsupported` en la matriz hasta verificarla en Orders. Un diseño que la declare se generará solo con Stripe, y esa es exactamente la señal que la matriz tiene que dar.
5. **Off-session y guardar el medio de pago**: capacidad `off-session` en las dos, con dos operaciones neutras más en la capa (`savePaymentMethod` / referencia guardada). La forma exacta en que MercadoPago pide autenticación en un cobro off-session queda **a verificar en sandbox** antes de marcar `PaymentActionRequired` como `supported` en esa pasarela.
6. **Secretos por pasarela**: Stripe usa `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` (uno por endpoint, y se rota). MercadoPago usa `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_WEBHOOK_SECRET`. Durante la rotación de Stripe puede haber dos secretos activos, así que el verificador acepta **cualquiera** de las `v1`.

## Pendientes de verificar en sandbox (antes de marcar `supported`)

- Captura parcial en Orders de MercadoPago.
- Validez de la autorización en MercadoPago.
- Respuesta de Orders ante un cobro off-session que exige autenticación, y forma de su acción del cliente.
- Política de reintentos del webhook de MercadoPago.
- Países donde están disponibles los pagos automáticos (`payment_profile`) de MercadoPago; la documentación consultada solo muestra ejemplos de BR.

## Fuentes

- Stripe — webhooks y verificación manual: https://docs.stripe.com/webhooks
- Stripe — autorización y captura: https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
- Stripe — guardar y cobrar después (off-session): https://docs.stripe.com/payments/save-and-reuse
- Stripe — peticiones idempotentes: https://docs.stripe.com/api/idempotent_requests
- MercadoPago — webhooks y validación de `x-signature`: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
- MercadoPago — capturar pago autorizado: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/payment-management/capture-authorized-payment
- MercadoPago — pagos automáticos (Orders, primer cobro y siguientes): https://www.mercadopago.com.br/developers/pt/docs/automatic-payments-orders/register-first-payment
- MercadoPago — Checkout API vía Orders: https://www.mercadopago.com.mx/developers/en/docs/checkout-api-orders/integration-model
- MercadoPago — reembolsos y cancelaciones (Orders): https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/payment-management/refunds-cancellations
