# Corrida de `payment` con keel-dotnet en keel-registry (Stripe)

| Etiqueta | Valor |
|---|---|
| Papel | control |
| Diseño | `payment` v0.2.1 (DSL 2.33, relacional, capa `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-dotnet@0.3.0` |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** |
| Huella del agente | **28** archivos |
| Huecos del diseño | 2 (`markRefunded.amount`; `savePaymentMethod` sobre un medio borrado) → `/keel-evolve` |
| Huecos del generador | 2, arreglados en los cuatro generadores |
| Agujeros de la puerta | 0 |
| Convertidos en id | ninguno |

Proyecto en `C:\Users\antonio.suarez\proyectos\keel\keel-registry\services\payment-dotnet`, commit `8128a2d` («Generado
desde specs/payment v0.2.1»). Evaluada regenerando EN MEMORIA con `planService` y comparando archivo a archivo con el
proyecto. Registro escrito a posteriori, al cerrar la corrida de payment-spring.

## Huecos del generador

- **El umbral del barrido de pagos en local/test** era de 5 s, por debajo del read-timeout de 10 s de la pasarela: una
  consulta sin respuesta dejaba la marca renovada ya vencida al acabar, y FL-REC-005 era imposible. Ahora vale el del
  diseño en todos los perfiles (`unansweredAfterLines` en `keel-core/src/lib/gen/payments-config.js`).
- **Faltaba `existsBy<Campo>` para la clave única GLOBAL de una hija**, que se comprueba antes de un efecto irreversible
  (el agente la escribió a mano: `ExistsByRefundRequestId`). Ahora la emiten los cuatro (`keel-core/src/lib/gen/internal-unique.js`).

## designGaps

- `refund-amount-cumulative-or-single`: el diseño no decía si era lo devuelto en esa devolución o el acumulado. Lo cerró la v0.2.3 del
  diseño, con la regla de que es el de esa devolución y que convertirlo es del traductor de la pasarela.
- `save-method-after-removal`: `savePaymentMethod` sobre un medio ya borrado; pendiente de `/keel-evolve`.
