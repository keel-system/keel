# Corrida `job-dispatch-cycles` — keel-nest (incremento 10: el reloj)

| Etiqueta | Valor |
|---|---|
| Diseño | `job-dispatch-cycles` v1.0.0 (DSL 2.19, relacional, 5 capas) |
| Stack | `postgresql` |
| Generador | `keel-nest@0.0.1` (con el incremento 10: 10b–10d) |
| Diseño listo al generar | sí |
| Matriz final | **12/12 OK** |
| Huella del agente | 148 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Huecos del diseño | 2 que la puerta debía haber cazado (`natural-key-error-unnamed`, `route-version-implicit`) + 1 en design-gaps.yaml, descartado |
| Huecos del generador | 1 (la regex de `inFlightWithoutClock`, ver § Arreglos) |
| Convertidos en id | `CHK-PERSIST-NATURAL-KEY-ERROR-UNNAMED`, `CHK-SCEN-ROUTE-UNSERVED` |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 2 |
| Coste del diseño | careo 1; barrido 15; revisión 6; 4 aceptadas / 12 cerradas |

La corrida que mide el incremento 10 de `PLAN-KEEL-NEST.md`: el reloj (`dispatchJobs` cada minuto, sin transacción
abarcadora), el reclamo de la cola con el reloj del rescate estampado en el mismo UPDATE, el rescate a `abandoned`
con su plazo leído del parámetro de despliegue `abandonAfterMinutes`, y el gate `check-idempotency.sh` con el motor
compartido. Su gemela de keel-spring es `2026-10-07-job-dispatch-cycles-spring.md`. La fixture es la variante de
`job-dispatch` con el ciclo de vida completo, preparada para esta corrida (11/11 en `--ready`).

## Cómo terminó

**12/12**, con una ronda de arbitraje: la primera pasada dio 10/12 y los dos rojos (`FL-JOB-001-B`, `FL-JOB-001-D`)
eran de la prueba (`culprit: test`): `toMatch(UUID_SHAPE)` con un comparador de forma en vez de una RegExp. 0 de 3
ciclos `scoped`. Sin `harnessPatches`, sin fixes de `infra/` ni `culprit: harness`; `npm test` 64/64; baseline de
migraciones exportado y verificado en vivo; `check-idempotency.sh` en verde (`sweepClaim` OK, comprobado después
sobre el proyecto terminado). Los dos escenarios caros del rescate —`FL-RSC-001` con el reloj rancio y `FL-RSC-002`
con el reloj a ahora— salieron con `stallInFlight`/`putInFlight` del arnés, sin SQL a mano.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los cuatro handlers de `src/application/usecases/` | TODO legítimo: la lógica de cada caso de uso |
| `src/domain/aggregate/job.ts` | TODO legítimo: `create`, `complete`, `abandon` y las guardas de los invariantes |
| `README.md` | TODO legítimo: la guía de despliegue, paso del orquestador |

Ningún archivo del reloj, del reclamo, de la persistencia ni del arnés tocado. El handler del barrido usa los DOS
reclamos generados (`claimForDispatchJobsRunning` y `claimForStalledDispatchJobsAbandoned`) sin escribir uno propio,
y aísla el fallo de cada fila del rescate (`AggregateError` al final): una confirmación que gana la carrera no corta
el resto del lote.

## Lo que dijo el informe y lo que resultó ser

El informe atribuye cuatro hallazgos al generador. Verificados contra los dos proyectos:

1. **`uk_jobs_natural` → `409 JOB_REFERENCE_ALREADY_EXISTS`**, un code que el diseño no declara: el que declara
   `enqueueJob` para ese caso es `JOB_ALREADY_ENQUEUED`. Cierto, y en **los dos** servidores (el informe de
   keel-spring no lo vio). No es del generador: el DSL tiene dónde nombrarlo
   (`persistence.entities.Job.naturalKeyError`, DSL 2.16) y la fixture no lo hizo; sin él, la deducción no reconoce
   `JOB_ALREADY_ENQUEUED` (no tiene la forma `*_ALREADY_EXISTS` ni la de los campos) y los dos generadores ponen el
   canónico de la familia. El duplicado secuencial sale bien porque lo para la precondición del handler; la CARRERA
   sale con otro code, y ningún escenario la ejerce. **Agujero de la puerta**: `keel validate` no avisa de una
   operación que escribe la clave natural, declara un 409 de «ya existe» y deja la unicidad al canónico.
2. **`/api/v1` frente a `basePath: /api`**. No es del generador: `docs/dsl/api.md` dice que con un `basePath` sin
   versión el generador añade `/v1`. Lo que estaba mal era la fixture: sus escenarios usan `/api/jobs` y su
   `gaps.yaml` afirmaba «sin versión en la ruta». Los dos agentes lo resolvieron usando la ruta servida.
   **Agujero de la puerta**: ni el careo ni ninguna comprobación de escenarios contrasta sus rutas con las
   efectivas.
3. **`split(/s+/)` en `inFlightWithoutClock`**. Cierto y del generador: ver § Arreglos.
4. **`UUID_SHAPE` usado con `toMatch`**. La convención ya lo enseñaba dentro de un `toStrictEqual`; el agente lo usó
   con `toMatch` y le costó la única ronda. Ver § Arreglos.

## Arreglos

- **La regex de `inFlightWithoutClock`** (`src/scaffold/integration-tests.js`, incremento 10c): dentro de una
  plantilla, `\s` pierde la barra y el arnés emitía `split(/s+/)`. Funcionaba porque psql devuelve el número solo.
  Ahora se escribe `\\s` y un test lo fija sobre lo emitido.
- **`integration-tests.md`** dice que `UUID_SHAPE`/`INSTANT_SHAPE` son comparadores de `expect`, no RegExp: van
  dentro de `toEqual`/`toStrictEqual`, nunca en `toMatch`.
- **La fixture** pasa a nombrar `naturalKeyError: JOB_ALREADY_ENQUEUED` y a usar la ruta servida en sus escenarios.

## designGaps

- `natural-key-error-unnamed` — la unicidad de la clave natural sin `naturalKeyError`, con un 409 de «ya existe»
  declarado en la operación que la escribe: los dos generadores ponen el code canónico y la carrera sale con un code
  que no es el del diseño. No lo reportó keel-spring; lo vio keel-nest. Candidato a `CHK-*`: la decisión se cierra
  con una línea del DSL.
- `route-version-implicit` — los escenarios usan rutas sin la versión que el generador añade al `basePath`. Los dos
  agentes lo resolvieron solos, pero el contrato del documento no era el servido. Candidato a comprobación de
  `validation-scenarios.md` (aviso, como todas las `CHK-SCEN-*`).
- El `design-gaps.yaml` de la corrida propone declarar que violar un invariante de reloj de `Job` es un defecto
  interno (500 sin code). **Descartado**: un invariante es una garantía del propio dominio, y romperlo es un defecto
  del servidor, no un desenlace del contrato; no hay nada que decidir en el diseño.
