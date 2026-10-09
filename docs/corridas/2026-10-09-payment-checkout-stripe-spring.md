# Corrida `payment-checkout` — keel-spring con Stripe (incremento 13e, la gemela de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.1.0 (DSL 2.19, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-spring@0.1.6` (con `holdFromReconciliation`, propagado con `--refresh` antes de lanzarla) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** |
| Huella del agente | 325 archivos registrados por `build`, 0 adoptados, **20 reescritos**, 0 borrados |
| Huecos del diseño | 3 en design-gaps.yaml |
| Huecos del generador | 1: el lote del barrido sin clave (ver el registro de stripe-nest § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 17 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La gemela de keel-spring de `2026-10-09-payment-checkout-stripe-nest.md`, donde está el análisis común.

## Lo propio de esta

- **25/25**, sin `harnessPatches` ni falsos negativos de sondas. La suite tarda unos 19 minutos: los escenarios del
  barrido esperan al cron de 5 minutos del diseño.
- **`baselineTested: PENDING`**: la prueba en vivo del baseline de Flyway es del diseñador, como en las corridas de
  keel-spring anteriores (keel-nest la hace dentro del pipeline).
- **El lote del barrido**: el agente se escribió una `ReconciliationPolicy` propia con el umbral y el lote —la única
  de las cuatro que no lo dejó como constante—. Es el mismo hueco del generador, ya arreglado: ahora lo da
  `PaymentReconciliation.batchSize()`.
- El agente de pruebas contó «28 ids FL-*» porque sumó tres `CONSTRAINT-*`; la matriz puntúa 25.

## La huella, clasificada

Los trece handlers, los dos agregados, el README y el aplicador: TODO legítimo. `PaymentRepository`,
`PaymentRepositoryImpl` y `PaymentJpaRepository`: consulta de negocio (los candidatos del barrido y su reclamo).

## designGaps

- `notice-success-status` (api.gatewayNotice, FL-STL-004): el status del aviso válido. Los dos generadores responden
  200 vacío; se escribe en `docs/dsl/payments.md`.
- `status-queries-per-charge` (use-cases.sweepPendingPayments, FL-REC-002-B y FL-CLU-001): cuántas consultas de estado
  hace el barrido por cobro (por id y/o por referencia), que es lo que cuentan los dos escenarios.
- `gateway-given-per-charge` (validation-scenarios, FL-REC-002): los Given de «rechazar» o «no contestar» se programan
  por ruta, no por cobro. Es cierto también en el arnés de keel-nest (`gatewayDoesNotAnswer(call)`); hoy los
  escenarios dependen del orden de los stubs.
