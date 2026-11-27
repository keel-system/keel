# Corrida de `payment` con keel-go en keel-registry (Stripe)

| Etiqueta | Valor |
|---|---|
| Papel | control |
| Diseño | `payment` v0.2.2 (DSL 2.33, relacional, capa `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-go@0.3.0` |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** |
| Huella del agente | **24** archivos, todos del agente |
| Huecos del diseño | 0 |
| Huecos del generador | 2, arreglados (uno solo en keel-go, el otro en los cuatro) |
| Agujeros de la puerta | 0 |
| Convertidos en id | `OBL-PAYMENTS-REFUND-REFERENCE` (no se puede aceptar por escrito) |

Proyecto en `C:\Users\antonio.suarez\proyectos\keel\keel-registry\services\payment-go`. Registro escrito a posteriori, al
cerrar la corrida de payment-spring.

## Huecos del generador

- **keel-go logueaba `invalid.Reason`** en `payment_notice.go` cuando un aviso de la pasarela no verificaba, y la regla
  `personal` del gate de logs lo cazaba. Ahora escribe `invalid.Error()` (commit `3db1f613`).
- **La clave de la devolución `<cobro>:refund` se repetía** con `partial-refund` en los cuatro generadores: la pasarela
  rechazaba la segunda devolución parcial (otro importe) o devolvía la respuesta de la primera sin devolver nada (el
  mismo). Nueva `payments.refund.reference` (sin subir el DSL), con `OBL-PAYMENTS-REFUND-REFERENCE`, y
  `refundIdempotencyKey` = `<cobro>:refund:<devolución>` (commit `70a2691f`). El diseño de keel-registry declara
  `reference: refundRequestId` desde la v0.2.3.

## designGaps

Ninguno.
