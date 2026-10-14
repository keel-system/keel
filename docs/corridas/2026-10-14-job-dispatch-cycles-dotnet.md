# Corrida `job-dispatch-cycles` — keel-dotnet (incremento 10e)

| Etiqueta | Valor |
|---|---|
| Diseño | `job-dispatch-cycles` v1.0.1 (DSL 2.21, relacional, 5 capas) |
| Stack | `postgresql` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 10: 10b–10d, `1af50d2`…`3d13555`) |
| Diseño listo al generar | sí |
| Matriz final | **12/12 OK** |
| Huella del agente | 167 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 1 (la nota del rescate no decía que un fallo en una fila no corta el lote, ver § Arreglos) |
| Convertidos en id | |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-07 |

La corrida del incremento 10 de `PLAN-KEEL-DOTNET.md`, sobre el MISMO diseño y el mismo stack que sus gemelas de
keel-nest y keel-spring (`2026-10-07-job-dispatch-cycles-{nest,spring}.md`). Mide lo que ninguna red mide: que un tick
del reloj dispare de verdad el handler, que el reclamo de la cola y el rescate generados se usen tal cual, y que el arnés
del rescate (`StallInFlight`, `PutInFlight`, `InFlightWithoutClock`) aguante un pipeline real.

## Cómo terminó

**12/12 a la primera**, con `score-scenarios.sh` en 0, sin ronda de arbitraje, sin `harnessPatches`, sin
`culprit: harness` y sin fixes de `infra/` ni de la solución. Pruebas de build 77/77, el baseline de `dotnet ef`
verificado en vivo y `check-idempotency.sh` en verde (había nacido rojo en `sweepClaim`). Los escenarios del reloj
(`FL-DSP-001`, `FL-RSC-001`) esperan al cron real con techo de 90 s; los del rescate fabrican su precondición con
`StallInFlight` y `PutInFlight` y comprueban que `InFlightWithoutClock` vale cero, sin una línea de SQL a mano.

## Comparación

| | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|
| Matriz | **12/12** a la primera | 12/12, una ronda de arbitraje | 12/12 |
| Registrados por build | 167 | 148 | 177 |
| Reescritos | **6** | 6 | 5 |
| Reescritos por un hueco del generador | 0 | 0 | 0 |
| Huecos del generador | 1 (la nota del rescate) | 1 (la regex de `inFlightWithoutClock`) | 0 |

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los cuatro handlers de `Application/UseCases/` | TODO legítimo: la lógica de cada caso de uso |
| `Domain/Aggregate/Job.cs` | TODO legítimo: la creación y las transiciones (`Complete`, `Abandon`) |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

Los mismos seis que keel-nest; keel-spring no reescribió el README. **Archivos nuevos del agente**: los seis flujos de
`tests/JobDispatchCycles.IntegrationTests/` y el baseline de migraciones. Nada del reloj, del reclamo, de la persistencia
ni del arnés tocado: el barrido (`DispatchJobsCommandHandler`) llama a `ClaimForDispatchJobsRunning` y a
`ClaimForStalledDispatchJobsAbandoned` tal cual, y la transición del rescatado la hace el dominio (`Abandon`).

## Arreglos

- **El rescate cortaba el lote al primer fallo.** El handler guarda cada rescatado en un bucle sin aislar las filas: si
  un `Save` lanza —el caso típico es el conflicto de versión cuando el ejecutor confirma a la vez que el rescate—, la
  pasada entera se corta y el resto de las filas, ya arrendadas, esperan otro plazo completo. Ningún escenario lo ve
  (`FL-RSC-001-B` es la confirmación TARDÍA, no la simultánea). El agente de keel-nest sí lo aisló (un `try` por fila y
  un `AggregateError` al final); la diferencia venía de la nota: la de la cola decía «un fallo en una no revierte las
  demás» y la del rescate no. Arreglado en la nota del rescate de keel-dotnet (`services.js`), con su aserción en
  `test/claim.test.js`. keel-nest y keel-spring llevaban la misma nota sin esa frase: arreglada también en los dos.

## designGaps

Ninguno (sin `design-gaps.yaml`).
