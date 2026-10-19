# Corrida de control `notification-mailer-mongo` — keel-dotnet (incremento 16 de keel-dotnet)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.21, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-dotnet@0.0.1` (en `5a8143e`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (79 casos) |
| Huella del agente | 318 archivos registrados por `build`, 0 adoptados, **18 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` + 2 que no reportó nadie (ver § designGaps) |
| Huecos del generador | 1, la nota de `resolvedBy` con `undefined` (arreglada; ver la gemela relacional § Arreglos) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta, y 1 de entorno (el `.csproj` de los flujos) |
| Agujeros de la puerta | 0 |

Una de las seis corridas de control del par del MVP, todas desde el mismo commit. La comparación de las seis está en
`2026-10-18-notification-mailer-dotnet-control.md` § Paridad.

## Cómo terminó

23/23 tras dos ciclos de arreglo, con `score-scenarios.sh` en 0 y sin `harnessPatches` ni `culprit: harness`. Los dos
ciclos repiten tropiezos que ya tuvieron keel-spring y keel-nest el 2026-10-12:

- `FL-NTF-001-B` (`culprit: code`): la repetición idempotente devolvía el estado vivo en vez de `accepted`.
- `FL-DSP-001` (`culprit: test`): la prueba usaba `templateVersion = 2` con un Given que publica solo la v1.

El 403 por audiencia ajena lo cubrió con `test-m2m-bad-aud`, que encontró leyendo `infra/init-keycloak.sh`.

El reescrito 18 es el `.csproj` de `tests/NotificationMailerMongo.IntegrationTests`. El agente le puso un
`IntermediateOutputPath` corto porque, con las rutas largas deshabilitadas en Windows, MSBuild no escribía el
ensamblado intermedio bajo la ruta de `spring-live-test/` (`MSB3030`). Es de entorno, no del generador.

## designGaps

Los dos de la comparación de las seis; aquí no los reportó nadie (detalle en la gemela relacional):

- `required-value-blank` — aquí solo cuenta como faltante que no venga el nombre: se aceptan `""` y `"  "`.
- `rendered-subject-bound` (**repetido**) — el asunto interpolado de más de 200 se guarda entero.
