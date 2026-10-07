# job-dispatch-cycles — Documento de diseño

> specs/job-dispatch-cycles v1.0.1. Diseño cerrado al preparar la corrida del incremento 10 de keel-nest
> (2026-10-07); las decisiones las tomó quien la preparaba, por delegación del diseñador.

## 1. Propósito y alcance

Una **cola de trabajos con despacho por ciclos**: el llamante encola un trabajo, un ciclo del despachador
(cada minuto) se lo entrega al ejecutor, y el ejecutor confirma cuando termina. Si una réplica tomó un
trabajo y nadie lo confirma en `abandonAfterMinutes`, el siguiente ciclo lo da por **abandonado**. Es la
variante de `job-dispatch` que mide el **reloj** de los generadores: el barrido por cron que reclama su
lote, el rescate de lo que quedó en vuelo y el parámetro de despliegue que fija su plazo.

Queda fuera, a propósito: un canal de entrega al ejecutor (el ejecutor consulta el trabajo que encoló), la
autenticación (API interna), el borrado y la retención. Motivos en § 6.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `Job` | raíz | Un trabajo con su `reference` (única), su `priority`, un `payload` opaco y su desenlace. |

Ciclo de vida: `queued` → `running` (entregado al ejecutor, con `runningSince`) → `done` (el ejecutor lo
confirmó, con `completedAt`) o `abandoned` (nadie lo confirmó a tiempo, con `abandonedAt`). Los dos
desenlaces son terminales.

## 3. Invariantes y reglas clave

- Una referencia, un trabajo; la unicidad distingue mayúsculas.
- Un trabajo en `running` tiene siempre `runningSince`, estampado en el mismo cambio de estado.
- Un trabajo lo toma un solo ciclo aunque el despachador corra en varias réplicas.
- Lo que lleva en `running` más de `abandonAfterMinutes` se abandona; lo recién tomado, no.
- La confirmación solo vale sobre un trabajo en `running`.

## 4. Qué hace

| Operación | Puerta | Éxito | Errores |
|---|---|---|---|
| `enqueueJob` | `POST /api/v1/jobs` | `201` con el trabajo en `queued` | `409 JOB_ALREADY_ENQUEUED`, `400 VALIDATION_ERROR` |
| `getJob` | `GET /api/v1/jobs/{id}` | `200` con el trabajo | `404 JOB_NOT_FOUND` |
| `completeJob` | `POST /api/v1/jobs/{id}/completion` | `200`, trabajo en `done` | `404 JOB_NOT_FOUND`, `409 JOB_NOT_RUNNING` |
| `dispatchJobs` | reloj, cada minuto | entrega lo encolado y abandona lo atascado | — |

## 5. Fronteras e integraciones

Ninguna: no publica ni consume eventos y no llama a nadie. La configuración de despliegue tiene un
parámetro, `abandonAfterMinutes` (5 por defecto, opcional en producción).

## 6. Decisiones de diseño (qué / por qué)

- **El rescate cierra en `abandoned`, no en `done`**: el llamante tiene que distinguir un trabajo que
  terminó de uno que nadie terminó.
- **El plazo es un parámetro del diseño**: dar un trabajo por abandonado es una consecuencia de negocio
  que el llamante ve, no la caducidad mecánica de un reclamo.
- **Bloqueo optimista en la raíz**: la confirmación y el rescate pueden coincidir; gana una y la otra es
  un conflicto, en vez de que decida el último en escribir.
- **Sin idempotencia de petición**: la referencia única ya frena el duplicado, y la confirmación la frena
  su transición.
- **Sin autenticación**: la API es interna y la llaman el sistema que encola y el ejecutor, detrás de su red.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

Estable: las tres rutas, la forma del trabajo con `null` explícito, los `code`, el ciclo de vida y su
regla de abandono.
Adaptable: el motor de base de datos (se elige al generar), la cadencia del ciclo y el plazo de abandono.

### Supuestos y limitaciones

- El ejecutor conoce el id del trabajo que encoló y lo consulta: no hay canal de entrega.
- No hay borrado ni retención.
- Sin autenticación ni `cors`.

### Cómo reutilizarlo

Para una cola con entrega por eventos, añadir la capa de mensajería y publicar el trabajo al despacharlo;
el barrido, el rescate y su plazo se mantienen.
