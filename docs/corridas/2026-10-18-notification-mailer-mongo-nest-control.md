# Corrida de control `notification-mailer-mongo` — keel-nest (incremento 16 de keel-dotnet)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.21, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-nest@0.0.1` (en `5a8143e`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (43 casos con los bordes `-X<n>`) |
| Huella del agente | 294 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` + 2 que no reportó nadie (ver § designGaps) |
| Huecos del generador | 1, la regla del cliente de audiencia ajena en el agente de pruebas (ver `2026-10-18-notification-mailer-dotnet-control.md` § Arreglos) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Una de las seis corridas de control del par del MVP, todas desde el mismo commit. La comparación de las seis está en
`2026-10-18-notification-mailer-dotnet-control.md` § Paridad.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0 y sin `harnessPatches` ni falsos negativos. El pase de calidad:
`indexes` e `indexesTested` OK (13 índices vivos en 6 colecciones) y 73 pruebas sin fallos.

El agente de pruebas dejó sin cubrir el 403 por audiencia ajena de `FL-NTF-001`, convencido de que el arnés no podía
pedir ese token. Sí podía, con `test-m2m-bad-aud`. Faltaba en `keel-nest-tests.md` la regla que se lo decía, y ya está
puesta.

## designGaps

Los dos de la comparación de las seis; aquí no los reportó nadie:

- `required-value-blank` — aquí solo cuenta como faltante que no venga el nombre: se aceptan `""` y `"  "`.
- `rendered-subject-bound` (**repetido**) — el asunto interpolado de más de 200 se guarda entero.
