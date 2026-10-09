# Corrida `payment-checkout` — keel-nest con MercadoPago (incremento 13e)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.1.0 (DSL 2.19, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak · mercadopago` |
| Generador | `keel-nest@0.0.1` (incremento 13d con `holdFromReconciliation`, propagado con `--refresh` antes de lanzarla) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 294 archivos registrados por `build`, 0 adoptados, **20 reescritos**, 0 borrados |
| Huecos del diseño | 3 en design-gaps.yaml |
| Huecos del generador | 2: el rechazo al guardar un medio sin tipo y el lote del barrido sin clave (ver el registro de stripe-nest § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 17 TODO · 2 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

El análisis común de las cuatro corridas de pagos está en `2026-10-09-payment-checkout-stripe-nest.md`.

## Lo propio de esta

- **25/25** a la primera puntuación, sin `harnessPatches` ni `culprit: harness`. El agente de calidad volvió a puntuar
  25/25 tras instalar el baseline (`baseline: OK`, `baselineTested: OK`); una puntuación posterior con la
  infraestructura ya bajada salió con 2, que no es una puntuación válida.
- **La puerta de la petición sin tocar build**: el agente marcó el origen de `requestCharge` (HTTP → 422; suscripción →
  cobro `failed` con `invalidPaymentMethod`) con un contexto propio, `src/application/support/request-origin.ts`, en vez
  de añadir un campo al mensaje generado (lo que hizo la corrida de Stripe).
- **Defecto del generador, confirmado y arreglado**: `rejectedMethod` del adaptador lanzaba un `Error` sin tipo, y el
  handler de `savePaymentMethod` tuvo que capturar cualquier `Error` como rechazo del medio. Los dos agentes de
  keel-nest lo hicieron así; los de keel-spring capturan solo la `IllegalArgumentException` del adaptador. Ahora es
  `GatewayRejectedPaymentMethodException`.
- **El lote del barrido** como constante (`BATCH_SIZE = 100`): el mismo hueco del generador que las otras tres.
- **Residuo**: `outbox-dispatcher-fallback.ts` conserva su comentario `TODO (agente)`, aunque el dispatcher real ya lo
  sustituye. Es build: el fallback se queda a propósito y el comentario podría decirlo mejor.
- Lo que deja «pendiente de confirmar» (`Number()` en `wire.ts` y `decimal.ts`) es la lectura de fechas y del exponente
  de la escala, no de importes: correcto.

## La huella, clasificada

Los trece handlers, los dos agregados, `broker-bindings.ts`, el README y el aplicador de desenlaces: TODO legítimo. El
puerto y el adaptador del repositorio del cobro: consulta de negocio (los candidatos del barrido y su reclamo). El lote
como constante dentro del handler del barrido: hueco del generador.

## designGaps

- `cancel-gateway-rejected` (use-cases.cancelPayment): repetido en tres corridas; ver el registro de stripe-nest.
- `requestcharge-location` (api.requestCharge): a qué ruta apunta `Location` del 201. Ninguno de los dos generadores la
  emite hoy: los dos servidores coinciden, pero el contrato no lo dice.
- `sweep-not-stoppable` (use-cases.sweepPendingPayments, FL-REC-002-B): el Given habla de «barrido detenido»; se alcanza
  con `holdFromReconciliation` y el Given se reescribe así en la próxima minor.
