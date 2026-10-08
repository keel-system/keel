---
name: keel-nest-mercadopago
description: Lo propio de MercadoPago en un proyecto keel-nest con capa payments — cómo habla el adaptador generado con la API de Orders, qué está SIN VERIFICAR y cómo se verifica en el sandbox. La lógica de los cobros es la de keel-nest-payments, igual con cualquier pasarela. Usar cuando keel-stack.json tiene paymentGateway mercadopago.
---

# MercadoPago

**Primero `keel-nest-payments`**: ahí está lo que te toca y lo que no. Esto es solo lo que cambia por ser
MercadoPago. El adaptador (`src/infrastructure/payment/mercadopago/mercadopago-payment-gateway.ts`) y el
verificador (`src/infrastructure/payment/mercadopago/mercadopago-notice-verifier.ts`) ya están generados.

## Cómo habla el adaptador

- **API de Orders** (`/v1/orders`), no la clásica de pagos: es la única con cobro sin el cliente delante. JSON,
  credencial `Bearer` (`MERCADOPAGO_ACCESS_TOKEN`).
- Importe **decimal en la unidad mayor** con la escala exacta de la moneda (`MoneyAmounts.toMajorUnits`).
- `capture_mode: manual` con `flow: authorize-capture` (solo tarjeta de crédito).
- La referencia del cobro viaja como `external_reference`.
- `X-Idempotency-Key: <referencia>:<acción>` en las escrituras.

## El aviso

`x-signature: ts=…,v1=…` con `x-request-id`. La firma es del **manifiesto**
(`id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) y **no cubre el cuerpo**: por eso el aviso solo da el id de la
order y el estado se consulta. El secreto (`MERCADOPAGO_WEBHOOK_SECRET`) es la clave secreta de la aplicación en el
panel de notificaciones.

## Lo que está SIN VERIFICAR

La matriz neutral de keel-core marca `unverified` dos capacidades, y build avisa al generar. Están marcadas
`VERIFICAR EN SANDBOX` en el adaptador, y `references/sandbox.md` dice cómo confirmarlas:

- **off-session**: los pagos automáticos con medio guardado (credencial almacenada) y qué responde la order cuando
  el emisor exige autenticar.
- **customer-action**: la forma exacta de la acción del cliente en una order `action_required` (el adaptador la
  toma de `payment_method`; si no viene, la acción es null).

Y la búsqueda de una order por `external_reference` (`/v1/orders/search`), que usa el barrido cuando la pasarela no
llegó a contestar.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/sandbox.md` | Para verificar lo que la matriz marca sin verificar |

## Validación

- Los escenarios `FL-*` corren contra la pasarela de prueba de `infra/`: no necesitan credenciales.
- La verificación contra la pasarela real es manual, con el perfil `develop` y el sandbox (`references/sandbox.md`).
  No forma parte del pipeline de generación.
