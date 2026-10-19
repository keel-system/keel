# Corrida de control `notification-mailer` — keel-nest (incremento 16 de keel-dotnet)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.0.2 (DSL 2.21, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-nest@0.0.1` (en `5a8143e`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (79 casos) |
| Huella del agente | 304 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` + 2 que no reportó nadie (ver § designGaps) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Una de las seis corridas de control del par del MVP, todas desde el mismo commit. La comparación de las seis está en
`2026-10-18-notification-mailer-dotnet-control.md` § Paridad.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0. No hubo `harnessPatches`, ni fixes de `infra/`, ni
`culprit: harness`, ni falsos negativos. El 403 por audiencia ajena lo cubrió con `test-m2m-bad-aud`. La huella es la
del 2026-10-12, archivo por archivo.

## designGaps

Los dos de la comparación de las seis; aquí no los reportó nadie:

- `required-value-blank` — aquí solo cuenta como faltante que no venga el nombre: se aceptan `""` y `"  "`.
- `rendered-subject-bound` (**repetido**) — no hay desenlace declarado para el asunto interpolado de más de 200.
