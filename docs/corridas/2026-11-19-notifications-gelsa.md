# Corrida de `notifications` en prueba-gelsa (keel-spring 0.4.0)

| Etiqueta | Valor |
|---|---|
| Diseño | `notifications` v0.3.0 (DSL 2.32, relacional, 8 capas: api, domain, mail, messaging, persistence, security, use-cases, service) |
| Stack | `postgresql · rabbitmq · keycloak · otel` |
| Generador | `keel-spring@0.4.0` |
| Diseño listo al generar | sí (los 13 criterios de `--ready` en verde, medido de nuevo el 2026-11-20) |
| Matriz final | **38/40, KO** (FL-TPL-030 y FL-SUP-003 en FALLO, los dos `culprit: design`); el pipeline paró en la fase 2b |
| Huella del agente | 430 archivos registrados por `build`, 0 adoptados, **41 reescritos**, 0 borrados |
| Huecos del diseño | 3 en `design-gaps.yaml`, los tres el mismo (la página fuera de rango) |
| Huecos del generador | 0 (sin `harnessPatches` ni fallos `culprit: harness`) |
| Agujeros de la puerta | 1 (D1) |
| Convertidos en id | `CHK-SCEN-PAGE-TOTALS`, pendiente del inc. 1 de `PLAN-CORRIDAS-GELSA.md` |

Proyecto en `C:\Users\antonio.suarez\proyectos\asuridev\prueba-gelsa\services\notifications-spring`. La corrida la
lanzó el usuario fuera de un plan; se registra en el inc. 0 de `PLAN-CORRIDAS-GELSA.md`. Sin la fase 3: ni calidad,
ni baseline de migraciones, ni gates de idempotencia, logging y telemetría, ni commit. La huella no se clasificó
archivo a archivo con un agente de contexto limpio.

## Lo que pasó

Los dos fallos son el mismo hueco. La convención de paginación de `validation-scenarios.md` (l. 51-53) condiciona
los ceros a «si no hay ningún elemento», y de ahí derivaron los dos `Then` de la página fuera de rango
(FL-TPL-030 Then 4, `?page=5`; FL-SUP-003 Then 3, `?page=4`), que esperan `totalElements: 3`. El servidor responde
ceros, como manda el contrato del cable, desde `PagedResponse.java` intacto de `build`. El agente de validación lo
arbitró bien y no tocó el código.

La guía canónica (`assets/core/docs/validation-scenarios.md:221`) dice «página vacía» pero no «fuera de rango»: el
diseñador no tenía dónde leerlo.

Desbloqueo pendiente de la decisión 2 del plan: corregir ahora con `/keel-evolve` (patch) o esperar a la corrida de
control del inc. 7.

## designGaps

- `page-out-of-range-totals` (**repetido**: catalog-nest-v2, payment FL-QRY-001) — la convención y FL-TPL-030/FL-SUP-003 esperan totales reales en la página fuera de rango; el contrato pone ceros (D1)
