# Corrida de control de `notifications` en prueba-gelsa (keel-spring 0.4.0)

| Etiqueta | Valor |
|---|---|
| Papel | control |
| Diseño | `notifications` v0.3.1 (DSL 2.33, relacional, 8 capas: api, domain, mail, messaging, persistence, security, use-cases, service) |
| Stack | `postgresql · rabbitmq · keycloak · otel` |
| Generador | `keel-spring@0.4.0` |
| Diseño listo al generar | sí (13/13 de `--ready`) |
| Matriz final | **40/40 OK** |
| Huella del agente | 430 archivos registrados por `build`, 0 adoptados, **41 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml` nuevo; el que queda en el proyecto es el de la v0.3.0 y `keel-spring check` lo marca como de otra versión) |
| Huecos del generador | 0 (sin `harnessPatches` ni fallos `culprit: harness`) |
| Agujeros de la puerta | 0 |
| Convertidos en id | ninguno nuevo; `CHK-SCEN-PAGE-TOTALS` (inc. 1) cazó en diseño el hueco D1 de la corrida anterior |
| Coste del diseño | careo 0 (pasada 3, completa por cambio de convenciones) |

Proyecto en `C:\Users\antonio.suarez\proyectos\asuridev\prueba-gelsa\services\notifications-spring`, commit
`267ef28` («Evolucionado desde specs/notifications v0.3.0 → v0.3.1»). Inc. 7 de `PLAN-CORRIDAS-GELSA.md`.

## Lo que pasó

Es una **evolución** del proyecto de la corrida del 2026-11-19 (`build --refresh` + `/keel-generate-spring`), no una
generación desde cero. `/keel-evolve` subió el diseño a la DSL 2.33 y cerró los tres `CHK-SCEN-PAGE-TOTALS` que la
puerta daba en rojo: la convención de paginación y los `Then` de FL-TPL-030 (`?page=5`) y FL-SUP-003 (`?page=4`) piden
ahora `totalElements: 0` y `totalPages: 0` fuera de rango. Es exactamente el hueco D1 que paró la corrida anterior en
38/40, cazado esta vez antes de generar.

El delta del agente: reescribió `SuppressionListingFlowIT` y `TemplateListingFlowIT` y no tocó código de producción
(`PagedResponse.from`, intacto de `build`, ya respondía ceros). Esta vez sí corrió la fase 3, que faltó en la corrida
anterior, y añadió `V1__baseline_schema.sql` (`baselineTested: PENDING`). La no-regresión del pase de calidad tardó
46 min 54 s (45 tests, 0 fallos).

La huella es la misma que la de la corrida anterior (41 reescritos, los mismos archivos): son los handlers, agregados,
puertos y adaptadores que el agente escribió entonces. La evolución no reescribió ningún archivo más de los que
registró `build`.

## Observaciones fuera de la matriz

- `keel-spring check specs/notifications` avisa dos veces de que la clave natural de `EmailTemplateVersion` nombra
  `emailTemplate`, «que no es un campo ni una relación del agregado» y que Spring Data rechazará al arrancar. No pasa:
  la aplicación arranca y es 40/40. `emailTemplate` es la relación con la raíz de una entidad HIJA, que no tiene
  repositorio ni finder derivado (`naturalKeyParams` de `keel-spring/src/scaffold/repositories.js`). El aviso es un
  falso positivo, y además sale duplicado. Ya estaba en la corrida anterior.

## designGaps

Ninguno.
