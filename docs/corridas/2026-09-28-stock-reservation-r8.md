# Corrida 2026-09-28 — `stock-reservation` v1.1.0, el antes y el después de la puerta

Corrida 1 de R8. Es el mismo servicio que la corrida del 2026-09-20, que dejó **10 huecos del diseño**
sin la puerta. Esta vez el diseño se llevó a `--ready` 10/10 antes de generar.

| | |
|---|---|
| Diseño | `stock-reservation` v1.1.0 (DSL 2.17, relacional) |
| Stack | postgresql · kafka · keycloak |
| Generador | `keel-spring@0.1.5` |
| Diseño listo al generar | sí |
| Matriz final | **27/27 OK** |
| Huella del agente | 277 archivos registrados por `build`, 0 adoptados, **14 reescritos**, 0 borrados |
| Clasificación de la huella | 7 TODO · 4 consulta · 3 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`; 0 que no reportara nadie) |
| Huecos del generador | 4 (3 en la huella + los puertos fijos del compose) |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 11→1; barrido 40→7→3; revisión 4→2 |
| Convertidos en id | ninguno |

## Lectura

**De 10 huecos del diseño a 0.** El agente generador no tuvo que elegir nada que el YAML,
`decisions.yaml` o las skills no fijaran. El clasificador de contexto limpio lo confirma archivo a
archivo, y además destapa tres huecos del generador que el informe no recogía.

Huecos del generador:

- `replica-consumer-group-stable` — `AbstractFlowIT.stopReplica()` no espera a que los consumer
  groups vuelvan a `STABLE`, y la clase siguiente de la suite agota su `await`. Los group-id se
  derivan de las suscripciones. El agente lo parcheó con un `localhost:9092` fijo.
- `listener-bound-not-dlq` — `DeadLetterConfig` y `<Evento>Message`. El diseño decide que un payload
  fuera de cota va a la DLQ sin reintentos (decisión §3.5), pero build falla por tres lados: el
  `requireContract()` solo mira `required`; lanza `IllegalStateException`, que se reintenta; y su skill
  manda `IllegalArgumentException`, que `DeadLetterConfig` tampoco excluye.
- `sweep-todo-order` — el TODO que build deja en `ReconcileReservationsCommandHandler` prescribe el
  orden genérico (llamar al proveedor antes de la transición), el contrario al que declara el diseño.
  El agente siguió al diseño; uno que obedeciera al TODO habría producido el huérfano del que avisa la
  regla. El mismo TODO sugiere «usa el cuerpo de la respuesta» sin mirar la decisión aceptada
  `OBL-OUTCOME-NEGATIVE-UNDECIDED`.
- `compose-fixed-host-ports` — `infra/docker-compose.yaml` fija `8180`, `5432` y `9092` en el host.
  Dos proyectos hermanos arriba a la vez chocan; aquí chocó con el control.

**Un defecto del agente que ningún escenario caza.** `Reservation.release()` fusiona las cinco aristas
que build pidió por separado y solo valida el ciclo de vida de la entidad. Así, un `StockRejected`
sobre una reserva `pending` la liberaría, cuando la operación declara `from: [awaitingStock,
confirmed]`. No es hueco del diseño ni cuenta en la rúbrica, pero `score-scenarios` salió verde con
él. build podría cerrarlo generando la guarda por operación a partir de `transitions[].from`.

## Arbitraje

Acepto la clasificación sin cambios.

## designGaps

Ninguno.
