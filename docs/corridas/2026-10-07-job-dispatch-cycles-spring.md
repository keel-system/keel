# Corrida `job-dispatch-cycles` — keel-spring (gemela de la del incremento 10 de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `job-dispatch-cycles` v1.0.0 (DSL 2.19, relacional, 5 capas) |
| Stack | `postgresql` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **12/12 OK** |
| Huella del agente | 177 archivos registrados por `build`, 0 adoptados, **5 reescritos**, 0 borrados |
| Huecos del diseño | 2 que no reportó nadie (`natural-key-error-unnamed`, `route-version-implicit`) |
| Huecos del generador | 0 |
| Convertidos en id | `CHK-PERSIST-NATURAL-KEY-ERROR-UNNAMED`, `CHK-SCEN-ROUTE-UNSERVED` |
| Clasificación de la huella | 5 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 2 |
| Coste del diseño | careo 1; barrido 15; revisión 6; 4 aceptadas / 12 cerradas |

La gemela de `2026-10-07-job-dispatch-cycles-nest.md`: el mismo diseño con keel-spring, para comparar los dos
servidores del incremento 10 de `PLAN-KEEL-NEST.md`. Mismo stack.

## Cómo terminó

**12/12**, sin ciclos de arbitraje. El informe dice «sin hallazgos»: ningún `harnessPatches`, ningún `culprit:
harness`, ningún `designGap`. `check-idempotency.sh` en verde sobre el proyecto terminado (`sweepClaim` OK).

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los cuatro handlers de `application/usecases/` | TODO legítimo: la lógica de cada caso de uso |
| `domain/aggregate/Job.java` | TODO legítimo: `create`, `complete`, `abandon` y las guardas |

Una huella menos que keel-nest: el README, que el agente de keel-nest reescribió y el de keel-spring no. El handler
del barrido usa los dos reclamos generados, como en keel-nest, pero **no aísla el fallo de cada fila del rescate**: un
conflicto de versión en una fila (la confirmación del ejecutor ganó) corta el bucle, y las filas que quedaban, ya
arrendadas con el reloj renovado, esperan otro plazo entero antes de volver a rescatarse. Es código del agente y
ningún escenario lo ve; se anota para la skill.

## Lo que el informe no dijo

El informe de keel-spring no tiene hallazgos, y el proyecto sí tiene uno: `ApiExceptionHandler` traduce
`uk_jobs_natural` a `409 JOB_REFERENCE_ALREADY_EXISTS`, igual que keel-nest, en vez del `JOB_ALREADY_ENQUEUED` que el
diseño declara para ese caso. La causa es del diseño (no nombraba `naturalKeyError`) y está en la gemela. Lo vio
el agente de keel-nest, no este: contrastar los dos proyectos es lo que lo hizo visible en los dos.

## designGaps

- `natural-key-error-unnamed` — ver la gemela de keel-nest.
- `route-version-implicit` — el informe lo anota como «nota menor»: los escenarios dicen `/api/jobs` y build sirve
  `/api/v1/jobs`. Ver la gemela.
