# job-dispatch-cycles — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/job-dispatch-cycles v1.0.1. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la variante de `job-dispatch` hecha para medir el **reloj** de
> los dos generadores con el mismo diseño: un barrido por cron que reclama la cola, rescata lo que una
> réplica dejó a medias y lee el plazo del rescate de un parámetro de despliegue. Cada flujo pone a
> prueba un mecanismo, y ninguno está de adorno.

> **Los caminos caros.** `FL-RSC-001` y `FL-RSC-002` no describen casos de negocio distintos: describen
> el **mismo** barrido en las dos condiciones que separan un rescate de un robo — la fila que una réplica
> muerta dejó a medias, y la que el ejecutor está trabajando ahora mismo. Un rescate sin cota temporal
> pasa el primero y falla el segundo.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos (`2026-01-15T10:30:00.000Z`).
  `createdAt`, `runningSince`, `completedAt` y `abandonedAt` se verifican **por forma**, nunca por valor.
- **Identificadores**: `uuid` canónico. Se verifican por forma y por reutilización simbólica dentro del
  flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se omite.
  `runningSince`, `completedAt` y `abandonedAt` son nulos hasta que algo los escribe.
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details}` más
  `correlationId`. Los escenarios fijan solo el `code` y el status HTTP.
- **Texto**: `reference` se guarda tal cual llega y su unicidad **distingue mayúsculas**.
- **El reloj**: `dispatchJobs` corre cada minuto. Lo que afirma su efecto **espera** a que pase un ciclo,
  con un techo de **90 segundos** (el periodo más el desfase del arranque); nunca llama a nada para
  dispararlo. Una aserción **negativa** sobre el barrido («no lo toca») espera también un ciclo entero
  antes de afirmar: con menos, saldría verde siempre.
- **Precondición del rescate**: el plazo (`abandonAfterMinutes`, 5 minutos en el perfil de prueba) es
  más de lo que una suite espera, así que «un trabajo que una réplica dejó a medias» se **fabrica**: se
  toma un trabajo creado por la API y se deja en `running` con el reloj **infinitamente rancio**
  (`stallInFlight` del arnés). «Recién tomado» es lo mismo con el reloj **a ahora** (`putInFlight`).
  Nada más se siembra por la base.
- **Estado entre flujos**: el arnés deja el estado como recién arrancado al empezar cada flujo
  (`### FL-*`), nunca entre los escenarios de un mismo flujo (`#### FL-*-B`…). Por eso cada `Given` de un
  flujo fabrica su trabajo por el camino declarado, y solo los escenarios de dentro de un flujo usan lo
  que dejó el anterior.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| enqueueJob | FL-JOB-001, FL-JOB-001-B, FL-JOB-001-C, FL-JOB-001-D | usuarios |
| getJob | FL-JOB-001, FL-JOB-002, FL-DSP-001, FL-JOB-003 | usuarios |
| completeJob | FL-JOB-003, FL-JOB-003-B, FL-JOB-003-C, **FL-RSC-001-B** | usuarios |
| dispatchJobs | FL-DSP-001, **FL-RSC-001**, **FL-RSC-002** | reloj (interna) |

Y la misma matriz leída por **mecanismo**, que es como se decide si falta algo:

| Mecanismo | Camino feliz | Camino caro |
|---|---|---|
| Reclamo de la cola (queued → running, con el reloj estampado) | FL-DSP-001 | — (dos réplicas: lo miden los checks de los generadores contra el motor) |
| Rescate de lo que quedó en vuelo (running → abandoned) | **FL-RSC-001** | **FL-RSC-002** (lo recién tomado no se rescata) |
| Desenlace tardío sobre un rescatado | — | **FL-RSC-001-B** (la confirmación llega tarde) |
| Unicidad de la referencia | FL-JOB-001-B | FL-JOB-001-D (mayúsculas) |

## Encolar y consultar

### FL-JOB-001: se encola un trabajo

**When**: `POST /api/v1/jobs` con `{reference: "JOB-1", priority: "high", payload: "hola"}`.
**Then**:
1. Status `201`.
2. El cuerpo trae `id` (uuid), `reference` = `"JOB-1"`, `priority` = `"high"`, `payload` = `"hola"`,
   `status` = `"queued"`, `runningSince` = `null`, `completedAt` = `null`, `abandonedAt` = `null` y
   `createdAt` con forma de instante.
3. `GET /api/v1/jobs/{id}` devuelve lo mismo.

#### FL-JOB-001-B: la misma referencia otra vez

**Given**: el trabajo de FL-JOB-001.
**When**: `POST /api/v1/jobs` con `{reference: "JOB-1", priority: "normal"}`.
**Then**:
1. Status `409`, `code` = `"JOB_ALREADY_ENQUEUED"`.

#### FL-JOB-001-C: lo que el contrato no admite

**When**: `POST /api/v1/jobs` con `{reference: <65 caracteres>, priority: "normal"}`, y aparte con
`{reference: "JOB-2"}` (sin `priority`).
**Then**:
1. Las dos responden `400` con `code` = `"VALIDATION_ERROR"`.
2. Ninguna crea un trabajo: `POST /api/v1/jobs` con `{reference: "JOB-2", priority: "normal"}` responde `201`.

#### FL-JOB-001-D: la referencia distingue mayúsculas

**Given**: el trabajo de FL-JOB-001 (`"JOB-1"`).
**When**: `POST /api/v1/jobs` con `{reference: "job-1", priority: "normal"}`.
**Then**:
1. Status `201`: es otro trabajo, con su propio `id`.

### FL-JOB-002: se consulta un trabajo que no existe

**When**: `GET /api/v1/jobs/{id}` con un uuid que no se ha usado.
**Then**:
1. Status `404`, `code` = `"JOB_NOT_FOUND"`.

## El ciclo del despachador

### FL-DSP-001: el ciclo entrega el trabajo encolado

**Given**: `POST /api/v1/jobs` con `{reference: "DSP-1", priority: "normal"}` responde `201` con su `id`.
**When**: pasa un ciclo de `dispatchJobs`.
**Then**:
1. En menos de 90 segundos, `GET /api/v1/jobs/{id}` devuelve `status` = `"running"` y `runningSince` con
   forma de instante; `completedAt` y `abandonedAt` siguen en `null`.
2. Ningún trabajo quedó en `running` sin reloj (`inFlightWithoutClock("dispatchJobs")` = 0): el reloj se
   estampa en el mismo cambio de estado.

### FL-JOB-003: el ejecutor confirma un trabajo entregado

**Given**: un trabajo encolado con `{reference: "CMP-1", priority: "normal"}` que el ciclo ya entregó
(`GET /api/v1/jobs/{id}` devuelve `status` = `"running"`, esperado como en FL-DSP-001).
**When**: `POST /api/v1/jobs/{id}/completion`.
**Then**:
1. Status `200`, con `status` = `"done"`, `completedAt` con forma de instante, `runningSince` el mismo
   que antes y `abandonedAt` = `null`.
2. `GET /api/v1/jobs/{id}` devuelve lo mismo.

#### FL-JOB-003-B: confirmarlo otra vez

**Given**: el trabajo terminado de FL-JOB-003.
**When**: `POST /api/v1/jobs/{id}/completion`.
**Then**:
1. Status `409`, `code` = `"JOB_NOT_RUNNING"`.
2. `GET /api/v1/jobs/{id}` sigue en `done` con el mismo `completedAt`.

#### FL-JOB-003-C: confirmar un trabajo que no existe

**When**: `POST /api/v1/jobs/{id}/completion` con un uuid que no se ha usado.
**Then**:
1. Status `404`, `code` = `"JOB_NOT_FOUND"`.

## El rescate

### FL-RSC-001: un trabajo que una réplica dejó a medias se da por abandonado

**Given**: un trabajo encolado con `{reference: "RSC-1", priority: "normal"}`, dejado en `running` con el
reloj rancio (`stallInFlight("dispatchJobs", id)`): el estado en el que lo deja una réplica que murió con
él.
**When**: pasa un ciclo de `dispatchJobs`.
**Then**:
1. En menos de 90 segundos, `GET /api/v1/jobs/{id}` devuelve `status` = `"abandoned"` y `abandonedAt` con
   forma de instante; `completedAt` sigue en `null`.
2. `inFlightWithoutClock("dispatchJobs")` = 0.

#### FL-RSC-001-B: la confirmación llega tarde

**Given**: el trabajo abandonado de FL-RSC-001.
**When**: `POST /api/v1/jobs/{id}/completion`.
**Then**:
1. Status `409`, `code` = `"JOB_NOT_RUNNING"`.
2. `GET /api/v1/jobs/{id}` sigue en `abandoned`, con `completedAt` = `null`.

### FL-RSC-002: lo que se acaba de tomar no se rescata

**Given**: un trabajo encolado con `{reference: "RSC-2", priority: "normal"}`, dejado en `running` con el
reloj a ahora (`putInFlight("dispatchJobs", id)`): hay un ejecutor trabajando en él.
**When**: pasa un ciclo entero de `dispatchJobs` (se espera 75 segundos antes de afirmar).
**Then**:
1. `GET /api/v1/jobs/{id}` sigue en `running`, con `abandonedAt` = `null`.
2. `POST /api/v1/jobs/{id}/completion` responde `200` con `status` = `"done"`: el trabajo seguía siendo del
   ejecutor.
