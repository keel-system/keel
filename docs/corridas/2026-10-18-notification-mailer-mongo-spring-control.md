# Corrida de control `notification-mailer-mongo` — keel-spring (incremento 16 de keel-dotnet)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.21, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-spring@0.1.6` (en `5a8143e`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (34 casos) |
| Huella del agente | 305 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 2 en `design-gaps.yaml`: 1 real (`required-value-blank`) y 1 ya aceptado en el careo; + 1 sin reportar (`rendered-subject-bound`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Una de las seis corridas de control del par del MVP, todas desde el mismo commit. La comparación de las seis está en
`2026-10-18-notification-mailer-dotnet-control.md` § Paridad.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0 y sin `harnessPatches` ni falsos negativos.

Hubo una incidencia de proceso: `keel-spring-code` siguió trabajando en segundo plano después de reportar
`status: OK`. Se paró a mano, se liberó Gradle y se puntuó, sin efecto en el resultado.

Python no abría archivos bajo la ruta tan profunda de `spring-live-test/`, y el agente usó Edit/Write en su lugar. Es
de entorno, como el `.csproj` de keel-dotnet documental.

## designGaps

- `required-value-blank` — **el único de los seis agentes que lo reportó**. Lo implementa como faltante también con
  `"  "` (`isBlank`), un contrato distinto del de los otros cinco (ver la comparación en
  `2026-10-18-notification-mailer-dotnet-control.md`).
- `dsp-then3-unobservable` — el Then 3 de `FL-DSP-001` («un segundo ciclo no lo vuelve a intentar») no se puede
  observar sin reactivar el relay. No es nuevo:
  - es el Then que el careo de R9 dejó `accepted`, con la reescritura pendiente para la próxima minor del par;
  - vuelve porque la regla de los huecos ya aceptados mira `gaps.yaml` y `decisions.yaml`, no `flow-review.yaml`.
- `rendered-subject-bound` (**repetido**) — no lo reportó; el asunto interpolado de más de 200 se guarda entero.
