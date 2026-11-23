# Corrida de `payment` en prueba-gelsa (keel-spring 0.4.0)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment` v0.1.4 (DSL 2.32, relacional, 8 capas: api, domain, messaging, payments, persistence, security, use-cases, service) |
| Stack | `postgresql · rabbitmq · keycloak · stripe · otel` |
| Generador | `keel-spring@0.4.0` |
| Diseño listo al generar | sí (los 13 criterios de `--ready` en verde, medido de nuevo el 2026-11-20) |
| Matriz final | **31/31 OK** (v0.1.3: 24/31 a la primera y 30/31 tras el barrido; el diseñador corrigió FL-QRY-001 y la v0.1.4 cerró 31/31) |
| Huella del agente | 434 archivos registrados por `build`, 0 adoptados, **33 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` (no se escribió) + 2 que corrigió o no reportó nadie (FL-QRY-001, D7) |
| Huecos del generador | 5 (G9-G13 de `PLAN-CORRIDAS-GELSA.md`; G13 pasa a pregunta de revisión) |
| Agujeros de la puerta | 2 (D1 en FL-QRY-001 y D7) |
| Convertidos en id | pendientes del plan: `CHK-SCEN-PAGE-TOTALS` (inc. 1), `REV-PAYMENTS-RECONCILE-INFLIGHT-NOTFOUND` (inc. 1), `CHK-PAYMENTS-SAVED-CARD-UNSOURCED` (inc. 4, si se decide DSL 2.33) |

Proyecto en `C:\Users\antonio.suarez\proyectos\asuridev\prueba-gelsa\services\payment-spring`. La corrida la lanzó
el usuario fuera de un plan; se registra en el inc. 0 de `PLAN-CORRIDAS-GELSA.md`. La huella no se clasificó archivo
a archivo con un agente de contexto limpio.

## Lo que pasó

Dos pasadas. En la v0.1.3, el único fallo que quedó tras corregir el barrido fue FL-QRY-001: su `Then` de la página
fuera de rango (`page=5&size=2`) afirmaba los totales reales y no los ceros del contrato del cable. Lo corrigió el
diseñador (v0.1.4) y no llegó a `design-gaps.yaml`.

Del generador, que el agente rodeó en el proyecto:

1. `PaymentGateway.savePaymentMethod` devuelve `String` (G9): se pierde `card` y no se distingue el rechazo del 3DS.
   El agente amplió el puerto (`SavedPaymentMethod`, `PaymentMethodNotAcceptedException`) en un archivo generado.
2. El `HttpClient` del JDK reintenta un GET sin respuesta (G10): fijado como propiedad global del proceso. Por medir.
3. `claimAwaiting` (`@Modifying`) hereda el `@Transactional(readOnly = true)` de clase del adaptador (G11).
4. Faltan primitivas del arnés de pagos (G12): tarjeta al guardar, 3DS al guardar, devolución de un importe,
   anulación con autenticación fallida y pasarela que retiene la respuesta hasta el aviso (FL-STL-009).
5. `NOT_FOUND` en la reconciliación de un cobro en `capturing`/`refunding` no tiene desenlace (G13): caso anómalo,
   va como pregunta de revisión.

## designGaps

- `page-out-of-range-totals` (**repetido**) — FL-QRY-001 esperaba los totales reales en una página fuera de rango; el contrato pone ceros (D1, corregido por el diseñador en la v0.1.4)
- `saved-card-unsourced` — `savePaymentMethod` solo declara `token`/`exposedAs`, y `PaymentMethod.card` (obligatorio, `personal`) solo lo puede informar la pasarela; el diseño no dice de dónde sale (D7, no reportado)
