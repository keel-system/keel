# Corrida `payment-checkout` — keel-spring con MercadoPago (incremento 13e, la gemela de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.1.0 (DSL 2.19, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak · mercadopago` |
| Generador | `keel-spring@0.1.6` (con `holdFromReconciliation`, propagado con `--refresh` antes de lanzarla) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 325 archivos registrados por `build`, 0 adoptados, **20 reescritos**, 0 borrados |
| Huecos del diseño | 3 en design-gaps.yaml |
| Huecos del generador | 1: el lote del barrido sin clave (ver el registro de stripe-nest § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 17 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La gemela de keel-spring de `2026-10-09-payment-checkout-mercadopago-nest.md`; el análisis común está en
`2026-10-09-payment-checkout-stripe-nest.md`.

## Lo propio de esta

- **25/25**, sin `harnessPatches` ni falsos negativos de sondas. `baselineTested: PENDING`, como en keel-spring de
  siempre.
- **El lote del barrido** como constante (`BATCH_SIZE = 100`): el hueco del generador común a las cuatro, arreglado.
- **La anulación rechazada por la pasarela**: el agente devuelve el cobro a `authorized` y responde 409
  `PAYMENT_NOT_CANCELABLE`. Los de keel-nest lo dejan en `canceling` con un 200: divergencia entre servidores, vuelve al
  diseño (ver el registro de stripe-nest).
- **La referencia reutilizada por otro `ChargeRequested`**: el listener la confirma como duplicado
  (`ChargeAlreadyRequestedError` o la violación de la clave natural), sin DLQ. Los de keel-nest la descartan a la DLQ:
  segunda divergencia, vuelve al diseño.

## La huella, clasificada

Los trece handlers, los dos agregados, el README y el aplicador: TODO legítimo. `PaymentRepository`,
`PaymentRepositoryImpl` y `PaymentJpaRepository`: consulta de negocio.

## designGaps

- `cancel-gateway-rejected` (use-cases.cancelPayment, FL-STL-002-B): repetido en tres corridas.
- `notice-success-status` (api, FL-STL-004): repetido en las dos de keel-spring.
- `charge-reference-reused` (use-cases.requestCharge, FL-EVT-001-B): repetido en dos corridas.
