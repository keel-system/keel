---
name: keel-go-mercadopago
description: Lo propio de MercadoPago en un proyecto keel-go con capa payments — cómo habla el adaptador generado con la API de Orders, qué está SIN VERIFICAR y cómo se verifica en el sandbox. La lógica de los cobros es la de keel-go-payments, igual con cualquier pasarela. Usar cuando keel-stack.json tiene paymentGateway mercadopago.
---

# MercadoPago

**Primero `keel-go-payments`**: ahí está lo que te toca y lo que no. Esto es solo lo que cambia por ser MercadoPago. El
adaptador y el verificador de avisos (`internal/infrastructure/payment/mercadopago.go`, con sus pruebas en
`mercadopago_test.go`) ya están generados, con la cabecera de código generado, y no se tocan. No hay SDK de MercadoPago
en `go.mod`: el adaptador habla HTTP con la biblioteca estándar.

## Cómo habla el adaptador

- **API de Orders** (`/v1/orders`), no la clásica de pagos: es la única con cobro sin el cliente delante. JSON,
  credencial `Bearer` (`MERCADOPAGO_ACCESS_TOKEN`).
- Importe **decimal en la unidad mayor** con la escala exacta de la moneda (`money.go`, con la tabla de keel-core).
- `capture_mode: manual` con `flow: authorize-capture` (solo tarjeta de crédito).
- La referencia del cobro viaja como `external_reference`.
- `X-Idempotency-Key: <referencia>:<acción>` en las escrituras (en los flujos, `request.Header("X-Idempotency-Key")`).

## El aviso

`x-signature: ts=…,v1=…` con `x-request-id`. La firma es del **manifiesto**
(`id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) y **no cubre el cuerpo**: por eso el aviso solo da el id de la order
y el estado se consulta. El secreto (`MERCADOPAGO_WEBHOOK_SECRET`) es la clave secreta de la aplicación en el panel de
notificaciones.

## Lo que está SIN VERIFICAR

La matriz neutral de keel-core marca `unverified` dos capacidades, y build avisa al generar (`keel-go check` las lista
bajo «Pasarelas de pago»). Están marcadas `VERIFICAR EN SANDBOX` en el adaptador, y `references/sandbox.md` dice cómo
confirmarlas:

- **off-session**: los pagos automáticos con medio guardado (credencial almacenada) y qué responde la order cuando el
  emisor exige autenticar.
- **customer-action**: la forma exacta de la acción del cliente en una order `action_required` (el adaptador la toma de
  `payment_method`; si no viene, la acción queda vacía).

Y la búsqueda de una order por `external_reference` (`/v1/orders/search`), que usa el barrido cuando la pasarela no llegó
a contestar.

## Referencias

| Archivo | Cuándo leerlo |
|---|---|
| `references/sandbox.md` | Para verificar lo que la matriz marca sin verificar |

## Validación

- Los escenarios `FL-*` corren contra la pasarela de prueba de `infra/`: no necesitan credenciales.
- La verificación contra la pasarela real es manual, con el perfil `develop` y el sandbox (`references/sandbox.md`). No
  forma parte del pipeline de generación.
