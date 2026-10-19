# Corrida de control `notification-mailer` — keel-spring (incremento 16 de keel-dotnet)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.0.2 (DSL 2.21, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-spring@0.1.6` (en `5a8143e`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (27 casos) |
| Huella del agente | 320 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` + 2 que quedaron como observación del informe o sin reportar (ver § designGaps) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Una de las seis corridas de control del par del MVP, todas desde el mismo commit. La comparación de las seis está en
`2026-10-18-notification-mailer-dotnet-control.md` § Paridad.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0 y sin `harnessPatches` ni `culprit: harness`. La primera
puntuación la paró Claude Code por falta de memoria del sistema, no por la suite; al relanzarla salió en 0.
`baselineTested: PENDING`, que en keel-spring le toca al diseñador a propósito. La huella es la del 2026-10-12, archivo
por archivo.

El informe trae dos observaciones que no pasaron a `design-gaps.yaml`:

- `FL-TPL-001` envía `description: null` en una variable y el contrato la declara `string`. El servidor lo acepta
  como opcional y el escenario pasa. Es una nota menor sobre el contrato derivado, no una decisión del agente.
- Un asunto interpolado de más de 200 se trunca. Este sí es un hueco: `rendered-subject-bound`.

## designGaps

- `rendered-subject-bound` (**repetido**) — el agente lo decidió (trunca a 200) y lo apuntó como observación, no como
  hueco. Es la segunda corrida que lo ve, así que es candidato obligatorio a id.
- `required-value-blank` — aquí solo cuenta como faltante el valor nulo: se aceptan `""` y `"  "`.
