# DSL 2.26 — los plazos de negocio sobre el estado y un solo cronómetro por servicio

Origen: R2 de `docs/evaluacion-dsl-2.24.md`. Este plan la lleva al DSL y a los cuatro generadores con la regla de
siempre: **el mismo diseño genera servidores equivalentes**. Cada pieza nueva tiene una red que la ejecuta y un
sabotaje que demuestra que esa red la ve.

Tiene dos mitades. La primera es el plazo de negocio (`lifecycle.deadlines`), que es lo que cambia en el DSL. La
segunda es el **cronómetro único**: una tabla de temporizadores con un sondeador por réplica, que dispara los plazos y
al que **migran todos los relojes que hoy emiten los generadores** (§ La migración de los relojes). La segunda no
cambia el DSL, pero sí el servidor generado de cualquier diseño con persistencia.

**Estado: aprobado (2026-11-07).** El usuario aceptó las ocho propuestas de § Decisiones tomadas. Fases B, C y C2
hechas el mismo día, la D (incremento 3, keel-spring) el 2026-11-08 y, de la fase E, la fase E entera ese mismo día
(incrementos 4, 5 y 6: keel-nest, keel-dotnet y keel-go); siguiente, la fase F (incrementos 7, 8 y 9). **Lo
que queda se termina sin subagentes, todo desde `main` y en secuencia** (§ Cómo se ejecuta).

## Por qué

Una reserva caduca a los 15 minutos si no se paga, una invitación a los 7 días, un código de verificación a los 10
minutos. El DSL tiene tres relojes, pero los tres son de **recuperación**: `stalledAfter` rescata una fila que una
réplica dejó en vuelo, `reconciledBy` detecta un proveedor que no contestó, y la caducidad del reclamo la pone el
generador. Ninguno modela que **el paso del tiempo sea la causa de una transición**.

Hoy eso se escribe como un `schedule` con `transitions` y una `rule` en prosa («expira las reservas pendientes con más
de 15 minutos»). Tiene dos defectos:

1. **El plazo vive en prosa.** Es el mismo problema que la 2.18 cerró para `stalledAfter`: el agente inventa la clave
   de configuración, el campo desde el que se cuenta y la consulta del barrido.
2. **La carrera entre el barrido y la acción tardía no la decide nadie.** En el minuto 15 y 30 segundos el barrido no
   ha pasado todavía y el cliente confirma. El guard del `lifecycle` ve `pending → awaitingStock` como legal y confirma
   una reserva que el negocio daba por caducada. Que el barrido corra cada minuto o cada hora cambia el contrato, y
   eso no lo ha decidido nadie.

## El DSL

```yaml
# domain.keel.yaml (stock-reservation)
lifecycle:
  field: status
  transitions:
    pending: [awaitingStock, expired]
    awaitingStock: [confirmed, released]
    confirmed: [released]
    released: []
    expired: []
  deadlines:
    pending:
      after: { parameter: holdMinutes, unit: minutes }   # o { seconds: 900 }: la forma de stalledAfter (2.18)
      since: createdAt                                   # campo timestamp de la entidad
      to: expired                                        # tiene que estar en transitions.pending
      by: expireReservation                              # la operación que caduca UNA reserva, declarada
      lateAction: { error: RESERVATION_EXPIRED }         # o: allow
```

- **`after`** tiene la misma forma que `stalledAfter`: segundos literales o un `service.parameters` con su unidad.
  Así el plazo es configurable por despliegue sin inventar una clave.
- **`since`** es el campo desde el que se cuenta. Tiene que ser un `timestamp` de la entidad, y una operación que
  lleve la entidad al estado (o la cree en él) tiene que estamparlo o ser `generated`.
- **`to`** es el destino de la caducidad y tiene que ser una arista declarada.
- **`by`** nombra la operación que ejecuta la caducidad de **una** entidad. Es un `command` `internal` cuya entrada
  identifica la entidad (su id) y que declara la transición `from → to`, **sin `schedule`**: no es un barrido, la
  despacha el cronómetro por cada temporizador vencido. Es una puerta de entrada más, «la disparó un plazo», junto a
  HTTP, el reloj, el despacho y la suscripción (`keel-core/gen/entry-gates.js`). Lo que hace además (emitir
  `ReservationExpired`, liberar algo) sigue siendo diseño, no mecánica: por eso se declara y no se deriva entera.
  (Corregido el 2026-11-07 al empezar el inc. 1: el borrador la hacía un `command` con `schedule`, lo que con el
  cronómetro no tiene sentido.)
- **`lateAction`** es la decisión que hoy no toma nadie:
  - `{ error: CODE }`: pasado el plazo, toda transición que salga del estado hacia un destino distinto de `to` se
    rechaza con ese error, haya pasado el barrido o no. La ventana deja de depender de la cadencia del cron.
  - `allow`: la acción tardía gana mientras el barrido no haya pasado. Es legítimo («el código vale hasta que lo
    borramos»), pero queda escrito.

## Decisiones

| # | Decisión | Por qué |
|---|---|---|
| D1 | `deadlines` vive en el `lifecycle`, indexado por el estado de origen. Un estado tiene como mucho un plazo | Lo que es legal vive en la máquina de estados. Dos plazos sobre el mismo estado (aviso a las 24 h, caducidad a los 7 días) son R2b, fuera de 2.26 |
| D2 | **El guard tardío lo genera build en el dominio**: el método de transición recibe el instante actual y rechaza con el `code` de `lateAction`. El handler no decide nada | Es la parte que cuesta dinero si falla, y así se mide con las pruebas emitidas del dominio sin corrida. El instante sale del reloj inyectable que ya emiten los cuatro (a verificar en el inc. 0) |
| D3 | La comparación es `since + after <= now`: el plazo vence **en** el instante, no después | Una sola regla para los cuatro, fijada en `keel-core/gen` con su caso de borde |
| D4 | Los plazos los dispara **un solo cronómetro por servicio**, la tabla de temporizadores del generador (§ El cronómetro), y no un cron por plazo | Un barrido por plazo son N consultas por tick y N relojes que afinar; el cronómetro es una consulta indexada para todos y sabe cuándo vence el siguiente |
| D5 | La operación `by` la escribe el agente, como cualquier handler, y recibe el temporizador ya reclamado; un gate comprueba que aplica `to` | Sus efectos son diseño. Dejarla al agente sin gate repetiría el «barrido que nunca reclama» de las corridas de 2.18 |
| D6 | La precisión del cronómetro, el tamaño del lote y el arriendo quedan **fuera del DSL** | Son mecánica del generador, la misma frontera que trazó 2.8. Y gracias a D2 no son contrato: el guard tardío rechaza en el instante exacto, tarde lo que tarde el cronómetro en disparar |
| D7 | El arnés gana `ageForDeadline(entidad, id, segundos)`: retrasa `since` **y** el vencimiento del temporizador, con las sentencias en `keel-core/gen` | Un escenario no puede esperar 15 minutos. Es el mismo patrón que `ageForReconciliation` |
| D8 | El `code` de `lateAction` se declara en `errors` de cada operación que saca la entidad del estado | Es contrato público, y así lo ven la matriz de cobertura y `CHK-SCEN-ERROR-UNCOVERED` sin regla nueva de escenarios |

## El cronómetro

Lo que hay hoy, medido en `keel-core/src/lib/gen/scheduling.js`: cada operación con `schedule` es un cron propio que
dispara **en todas las réplicas a la vez**, y lo que evita el doble trabajo es el reclamo por fila (SKIP LOCKED +
UPDATE condicional, o `findOneAndUpdate` en documentos). El relay del outbox, las purgas, el rescate de `stalledAfter`
y la reconciliación son otros tantos relojes, cada uno con su consulta. Sumar un barrido por plazo sería sumar más de
lo mismo.

### Opciones evaluadas

| Opción | Eficiencia | Varias réplicas | Veredicto |
|---|---|---|---|
| Un temporizador en memoria por fila (`setTimeout`, `time.AfterFunc`…) | Exacto y sin consultas | Se pierde al reiniciar, y cada réplica tendría el suyo o ninguno | **Descartada**: no sobrevive a un despliegue |
| Un barrido por plazo sobre la tabla de la entidad (el borrador anterior) | Sin escrituras de más, pero N consultas por tick y sin saber cuándo vence el siguiente: o se sondea a menudo, o se dispara tarde | Funciona con el reclamo por fila | Correcta, pero escala con el número de plazos |
| **Una tabla de temporizadores con un sondeador por réplica** | Una consulta indexada por `due_at` para todos los plazos, y el sondeador duerme hasta el siguiente vencimiento | Reclamo con arriendo: cada réplica toma un lote disjunto, y lo de una réplica caída lo retoma otra al vencer el arriendo | **Recomendada** |
| Mensajes retrasados del broker | Sin sondeo | Los reparte el broker | **Descartada**: no es uniforme (Kafka no los tiene, SQS los limita a 15 minutos, RabbitMQ pide un plugin) y exigiría mensajería a un servicio que no la tiene |
| Trabajos del motor (`pg_cron`, eventos de MySQL) | Sin sondeo | Los ejecuta el motor | **Descartada**: no existe en MongoDB ni es igual en los dos relacionales |
| Elección de líder (solo una réplica cronometra) | Un solo sondeador | Un punto único; el arriendo del líder necesita la misma tabla de todos modos | **Descartada**: el reclamo por lote reparte la carga y no tiene líder que perder |

### Cómo funciona

```
keel_timer
  id            uuid            PK
  kind          varchar         'deadline:<Entidad>.<estado>' | 'schedule:<operación>' | 'purge:<tabla>' | 'relay:outbox'
  entity_id     uuid NULL       la entidad de un plazo; NULL en un temporizador recurrente
  spec          varchar NULL    el cron o el periodo de un recurrente, para ver si cambió en un despliegue
  due_at        timestamp       índice (due_at)
  claimed_until timestamp NULL  arriendo
  attempts      int
  UNIQUE (kind, entity_id)
```

Hay dos clases de temporizador en la misma tabla. Un **plazo** es de una sola vez y lleva su entidad: se arma al entrar
en el estado y se borra al dispararse. Un **recurrente** es una fila por mecanismo, sin entidad, y al dispararse se
rearma para el siguiente tick (§ La migración de los relojes). Los pasos de abajo son los del plazo.

1. **Armar.** La operación que lleva la entidad al estado inserta el temporizador **en la misma transacción**, con
   `due_at = since + after`. Si la transacción revierte, no hay temporizador. Lo hace el adaptador generado al guardar
   una entidad que entra en un estado con plazo, no el handler.
2. **No desarmar.** Salir del estado **no** borra el temporizador: al dispararse se revalida (punto 4) y se descarta.
   Así cada entrada al estado cuesta una sola escritura, y una salida no cuesta ninguna.
3. **Reclamar.** Cada réplica tiene **un** sondeador. Reclama un lote con
   `due_at <= now() AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY due_at LIMIT n FOR UPDATE SKIP LOCKED`
   y le pone el arriendo. En MongoDB, `findOneAndUpdate` de uno en uno sobre el mismo filtro. Dos réplicas nunca
   toman el mismo temporizador mientras dure el arriendo.
4. **Revalidar y disparar.** Para cada temporizador se carga la entidad. Si ya no está en el estado de origen, o
   `since + after` (con el `after` de **ahora**) todavía no ha vencido, se descarta o se rearma con el `due_at` nuevo.
   Si sigue vencida, se despacha la operación `by`, y la transición `from → to` se confirma con el UPDATE condicional
   de siempre. El temporizador se borra en esa misma transacción.
5. **Dormir.** El sondeador duerme hasta el `due_at` más próximo, con un máximo (por defecto 30 s) para ver lo que
   arman otras réplicas. Si esta réplica arma uno que vence antes, despierta al suyo. Sin plazos pendientes, una
   consulta cada 30 s por réplica.

### Lo que decide el escalado horizontal

| # | Decisión | Por qué |
|---|---|---|
| T1 | **La hora es la de la base** en todo lo que compara el cronómetro (`now()` del motor, `$$NOW` en MongoDB), y `due_at` se calcula con ella al armar | Con varias instancias, sus relojes se desvían. Con una sola fuente de hora, ninguna réplica dispara antes que otra |
| T2 | El guard tardío del dominio (D2) usa el reloj de la instancia | Necesita la hora antes de escribir y no puede pedírsela a la base en cada transición. La desviación entre instancias mueve la frontera unos segundos y se documenta. Queda abierto si basta (pregunta 5) |
| T3 | **Al menos una vez**: si una réplica cae con un lote arrendado, otra lo retoma al vencer el arriendo. El efecto es una sola vez porque la transición es condicional (`WHERE status = from`) y los eventos salen por el outbox en la misma transacción | Es la garantía que ya dan el relay y los reclamos. La de «exactamente una vez» no la da nadie sin coordinación, y la revalidación la hace innecesaria |
| T4 | El arriendo es un parámetro del generador, con un default mayor que la duración del lote | Si fuera más corto que el lote, una réplica lenta vería cómo otra le quita lo que todavía está procesando |
| T5 | Un temporizador que falla `attempts` veces se aparca y lo cuenta una métrica, igual que el outbox que se rinde | Si no, un plazo cuyo handler siempre falla se reintenta para siempre y tapa a los demás del lote |
| T6 | Cambiar `after` en un despliegue no reescribe los temporizadores armados: los corrige la revalidación del punto 4, y el guard tardío usa siempre el `after` vigente | Ni el guard ni el cronómetro discrepan del parámetro de ahora, y no hace falta migrar nada |

### Por qué no basta un barrido sobre la tabla de la entidad

Con un plazo, las dos opciones cuestan parecido. Con varios (reserva, invitación, carrito), el barrido hace N consultas
por tick sobre N tablas y no sabe cuándo vence el siguiente: o sondea cada pocos segundos (N × réplicas consultas), o
dispara con minutos de retraso. El cronómetro hace una consulta por réplica, sobre un índice, y duerme hasta el
vencimiento. Su coste es una fila por cada entrada al estado y una tabla más del generador, como `outbox_event`.

## La migración de los relojes

Todo lo que hoy corre por reloj pasa al cronómetro. Inventario medido en el código (keel-spring como referencia; los
otros tres emiten los mismos mecanismos con las claves de `keel-core/gen`):

| Reloj de hoy | Dónde | Cadencia | Con varias réplicas, hoy |
|---|---|---|---|
| `schedule` de una operación (barridos, el rescate de `stalledAfter`, el `reconciledBy`, la reconciliación de pagos, el barrido de la guarda del correo) | `<Servicio>Scheduler`, `scheduleCron` de `gen/scheduling.js` | el cron del diseño, con el segundo repartido | corre en **todas**; cada una reclama su lote de filas |
| Relay del outbox | `outbox.js`, `OUTBOX_RELAY.fixedDelayMs` | cada 1 s | corre en **todas**; cada una reclama sus eventos |
| Purga de `outbox_event` | `OUTBOX_PURGE` | 03:00 | corre en **todas** a la vez |
| Purga de `processed_event` | `PROCESSED_EVENT_PURGE` | 04:00 | corre en **todas** a la vez |
| Purga de `idempotency_record` | `IDEMPOTENCY_RECORD_PURGE` | diaria | corre en **todas** a la vez |
| Purga de `reconciliation_claim` | `RECONCILIATION_PURGE` | 04:45 | corre en **todas** a la vez |
| Plazo de negocio (nuevo) | — | `since + after` | — |

Quedan fuera los relojes que no son nuestros, como el refresco de metadatos de Kafka o el TTL de Redis, y lo que no
dispara nada sino que compara una marca al leer: la caducidad de un reclamo, `lastKnown.maxAgeSeconds` o el arriendo
de una guarda.

### Dos modos

No todos los relojes quieren lo mismo con varias réplicas, así que cada `kind` declara su modo:

| Modo | Qué garantiza | Para |
|---|---|---|
| **clúster** | Cada tick lo ejecuta **una** réplica: la que gana el UPDATE condicional sobre la fila (compare-and-set sobre `due_at` y el arriendo) | `schedule` de operaciones, purgas, plazos |
| **por réplica** | Cada réplica tiene su tick, en su propio proceso. La tabla no interviene en la decisión, solo en la cadencia | el relay del outbox |

El relay va por réplica a propósito. Su trabajo ya se reparte fila a fila con su reclamo, y con varias réplicas
relayando a la vez el outbox se vacía más deprisa. Lo que gana con el cronómetro es otra cosa: **despertar al
confirmar**. La transacción que escribe en `outbox_event` despierta al sondeador de su propia réplica después del
commit, así que el evento sale al momento en vez de esperar hasta 1 s. El sondeo a intervalos queda solo de red de
seguridad, para lo que dejó una réplica caída, y puede pasar de cada segundo a cada 30 s.

### Lo que cambia y lo que no

- **No cambia lo que hace cada mecanismo.** El cronómetro decide **cuándo y en qué réplica** se ejecuta un tick. Qué
  hace el tick (el reclamo por fila, el despacho con o sin la transacción del caso de uso de `scheduleDispatch`, las
  purgas por lotes de `BATCHED_PURGE`) se queda como está. Por eso las redes de cada mecanismo siguen valiendo, y solo
  hay que añadir las del disparo.
- **Cambia el reparto de un barrido.** Hoy, con tres réplicas, un tick de un barrido reclama hasta tres lotes en
  paralelo. En modo clúster lo ejecuta una sola, y por eso el tick **drena**: reclama lotes hasta que no queden
  candidatos o hasta agotar su presupuesto de tiempo (el periodo del cron), y lo que quede pasa al siguiente tick. El
  rendimiento por tick se mantiene sin depender del número de réplicas (pregunta 7).
- **Cambia el solapamiento.** Hoy dos ticks del mismo barrido pueden solaparse en réplicas distintas si uno tarda más
  que el periodo. Con el arriendo, el siguiente espera a que acabe el anterior.
- **El segundo repartido se conserva.** `scheduleSeconds` sigue calculando el `due_at` de cada recurrente, así que dos
  barridos con la misma cadencia siguen sin arrancar en el mismo segundo.

### Las decisiones de los recurrentes

| # | Decisión | Por qué |
|---|---|---|
| R1 | Cada réplica, al arrancar, **asegura** las filas de sus recurrentes: inserta la que falta y recalcula `due_at` si `spec` cambió (un cron nuevo por variable de entorno) | La tabla no se siembra en la migración del esquema: los recurrentes dependen de la configuración del despliegue, no del diseño |
| R2 | El siguiente tick se calcula **desde `now()`**, no desde el `due_at` anterior | Tras una caída de una hora no se ejecutan doce ticks seguidos: se ejecuta uno y se recupera la cadencia |
| R3 | Por defecto, **al menos una vez**: el arriendo se pone al reclamar, y `due_at` se adelanta al terminar. Si la réplica muere a mitad, otra repite el tick al vencer el arriendo | Los barridos y las purgas que generamos ya son idempotentes por construcción (reclamo por fila, purga por condición) |
| R4 | Una réplica solo reclama los `kind` que conoce (`WHERE kind IN (…)`). Una fila de un `kind` que ya no existe la borra la purga de la propia tabla tras N días sin reclamar | En un despliegue escalonado conviven dos versiones. Si la nueva borrara al arrancar lo que no conoce, quitaría el reloj a las réplicas viejas que siguen en marcha |
| R5 | Si dos versiones con distinto cron conviven en un despliegue escalonado, gana la última que asegura la fila | Dura lo que dura el despliegue. Coordinarlo exigiría saber qué versiones hay vivas, y no compensa |
| R6 | Un servicio **sin persistencia** no tiene tabla en la que arbitrar: sus recurrentes corren por réplica, como hoy, en el mismo sondeador | No hay nada que compartir entre réplicas. Hoy el único caso sería un `schedule` sin persistencia |
| R7 | La purga de `keel_timer` es, a su vez, un recurrente de la propia tabla | Así no hace falta otro reloj para limpiar el reloj |

### Lo que la migración obliga a tocar fuera del reloj

Lo saqué del código, y es lo que hace la migración más cara que el plazo:

- **El arnés de flujos.** Los helpers que paran y reanudan el relay durante la resiembra del broker (keel-spring:
  «Parar y reanudar el `@Scheduled` del relay»; lo mismo en los otros tres), `ageForReconciliation`, el rescate de
  `stalledAfter` y el humo, que hoy esperan a un tick del cron. Tienen que hablar con el cronómetro, por ejemplo
  adelantando el `due_at` del recurrente en vez de esperar a la cadencia.
- **Los gates.** `check-idempotency.sh` y sus familias buscan `@Scheduled` y sus equivalentes como señal de un barrido
  (`confirm: '@Scheduled'`). Tienen que buscar el registro en el cronómetro.
- **La telemetría.** Los puntos de paso de los barridos y del relay, y las métricas nuevas: temporizadores vencidos
  sin reclamar (el retraso del cronómetro), aparcados y duración del tick.
- **La evolución de un proyecto ya generado.** `keel_timer` es una tabla nueva en una base ya desplegada. En keel-go
  la baseline de goose reescrita no llega a una base desplegada (medido en el inc. 15), y en los demás pasa lo mismo
  con su herramienta: la tabla tiene que llegar como un **paso de migración nuevo**, y `EVOLUTION.md` lo tiene que
  decir. Es la primera vez que un cambio del generador, y no del diseño, añade una tabla a un proyecto desplegado.
- **Las matrices de paridad.** Una fila nueva, `timer`, con sus celdas por modelo (relacional y documental) en los
  cuatro generadores.

## Reglas mecánicas (keel-core)

Todas con su mutación en `test/design-mutations/catalog.js`.

| Id | Naturaleza | Qué ve |
|---|---|---|
| `CHK-DOMAIN-DEADLINE-TO-UNDECLARED` | error | `to` no es una arista de `transitions.<estado>` |
| `CHK-DOMAIN-DEADLINE-SINCE-INVALID` | error | `since` no existe o no es `timestamp` |
| `CHK-DOMAIN-DEADLINE-BY-INVALID` | error | `by` no existe, no es un `command` `internal`, declara `schedule`, su entrada no lleva el id de la entidad o no declara la transición `from → to` |
| `CHK-DOMAIN-DEADLINE-PARAM-UNKNOWN` | error | `after.parameter` no está en `service.parameters` |
| `CHK-DOMAIN-DEADLINE-LATE-UNDECIDED` | aviso, `undecided`, `waivable: false` | sin `lateAction`. No hay default seguro: rechazar rompe al cliente que paga en el segundo 901, y aceptar vende stock ya liberado. Se cierra con una línea del DSL, así que es CHK y no OBL |
| `CHK-DOMAIN-DEADLINE-ERROR-UNDECLARED` | error | `lateAction.error` no está en `errors` de una operación que saca la entidad del estado hacia otro destino |

**Descartada al empezar el inc. 1**: `CHK-USECASES-SCHEDULE-UNDECLARED-DEADLINE` (un `command` con `schedule` que mueve
un estado sin `deadlines`). El inventario del inc. 0 lo midió: los nueve `schedule` de las fixtures son de recuperación
(`stalledAfter`, `reconciledBy`, reconciliación de pagos), ninguno es un plazo de negocio escrito en prosa, así que el
detector solo daría falsos positivos. Si una corrida trae un plazo en prosa, entra entonces, como todo `designGap` que se
repite.

**También descartada al empezar el inc. 1**: `CHK-DOMAIN-DEADLINE-SINCE-UNSTAMPED`. Que una operación estampe `since`
al llevar la entidad al estado no tiene dónde declararse en el DSL (es prosa de las `rules`), así que la máquina no lo
puede ver: es la pregunta de `REV-DOMAIN-DEADLINE-SINCE`.

Más: una pregunta nueva en la **clase 1** del análisis de huecos («¿algún estado caduca por el paso del tiempo?»), y no
una clase propia con una unidad por estado: cambiar las unidades de una clase deja huérfano todo `gaps.yaml` escrito, y
la pregunta es de la alcanzabilidad del ciclo de vida. Y la revisión `REV-DOMAIN-DEADLINE-SINCE` («¿el reloj empieza
cuando el negocio dice?»), la que no puede ver la máquina: `createdAt` frente a «cuando entró en `pending`».

## Qué escribe build y qué escribe el agente

| Pieza | Quién | Red |
|---|---|---|
| Guard tardío en el método de transición del dominio | build | pruebas emitidas del dominio (DL-1 a DL-3) |
| Tabla `keel_timer`, armado en el adaptador, reclamo con arriendo y su purga, en las dos ramas | build | `db-check` / `doc-check` (keel-spring: `claim-check`) (DL-4 a DL-9) |
| El sondeador: un bucle por réplica que duerme hasta el siguiente vencimiento, con revalidación y despacho | build | prueba emitida con reloj falso (DL-10) |
| Clave del plazo con su gradiente por perfil; máximo de sueño, lote, arriendo e intentos | build | pruebas de configuración (`service-parameters` ya lo tiene) |
| `ageForDeadline` en el arnés | build | `harness-check` / `doc-harness-check` |
| Handler de `by` (efectos, eventos) | agente | gate `infra/check-deadlines.sh` + escenarios |
| Nota del handler: qué reclama, qué aplica, qué no hacer | build (neutral) | `test/deadlines.test.js` en keel-core, la misma en los cuatro |

### Los casos que se miden

- **DL-1**: dentro del plazo, la transición sale. **DL-2**: en el instante exacto del vencimiento (D3), se rechaza con
  el `code`. **DL-3**: la transición hacia `to` pasado el plazo sale (es la del barrido).
- **DL-4**: entrar en el estado arma el temporizador en la misma transacción, y si la transacción revierte no queda
  ninguno. **DL-5**: el reclamo devuelve solo lo vencido, en orden de `due_at`. **DL-6**: dos réplicas, cada una con
  su conexión y a la vez, no reclaman el mismo temporizador. **DL-7**: un arriendo vencido lo retoma otra réplica.
  **DL-8**: un temporizador de una entidad que ya salió del estado se descarta sin transición. **DL-9**: con `after`
  alargado después de armar, se rearma y no dispara.
- **DL-10**: el sondeador duerme hasta el siguiente vencimiento, despierta antes si esta réplica arma uno más próximo,
  y aparca tras `attempts` fallos.
- Con `allow`, DL-2 pasa a «sale», y se mide igual.

Sabotajes: `dl-boundary` (`<` en vez de `<=`), `dl-no-guard` (el guard no se emite), `dl-wrong-field` (cuenta desde
otra marca), `dl-no-revalidate` (dispara sin mirar el estado), `dl-no-lease` (reclama sin arriendo: DL-6 en rojo),
`dl-app-clock` (compara con la hora de la instancia en vez de la de la base) y `dl-outside-tx` (arma fuera de la
transacción). Cada uno tiene que caer en exactamente sus casos.

Y los de los recurrentes, que entran con la migración:

- **RC-1**: con dos réplicas sondeando a la vez, cada tick de un recurrente en modo clúster lo ejecuta exactamente
  una. **RC-2**: un tick que dura más que el periodo no se solapa con el siguiente. **RC-3**: tras una parada más
  larga que varios periodos, se ejecuta un solo tick. **RC-4**: un `spec` cambiado al arrancar recalcula `due_at`.
  **RC-5**: una réplica ignora un `kind` que no conoce, y no lo borra. **RC-6**: una réplica que muere a mitad de un
  tick deja que otra lo repita al vencer el arriendo. **RC-7**: el relay despierta al confirmar la transacción que
  escribe en el outbox, sin esperar al sondeo.

Sabotajes: `timer-every-replica` (el recurrente se ejecuta en todas: RC-1 en rojo), `timer-no-lease` (RC-2),
`timer-catch-up` (el siguiente tick se calcula desde el `due_at` anterior: RC-3), `timer-forget-unknown` (la réplica
borra lo que no conoce: RC-5) y `relay-no-wake` (RC-7).

## Incrementos

| # | Qué | Puerta |
|---|---|---|
| 0 | **Hecho (2026-11-07)**, § Incremento 0: lo medido. Medir: el reloj inyectable en el dominio de los cuatro (si un generador no lo tiene, se añade aquí), cómo escribe hoy `stock-reservation` su caducidad, el inventario de los relojes y de lo que depende de ellos en cada generador, y la **carga de partida**: consultas por minuto a la base, en reposo y con carga, con 1 y 3 réplicas, sobre `catalog-extended` | Nota en este plan con lo medido. La carga se vuelve a medir al cerrar cada migración (7, 8 y 9), y la puerta de cada una incluye que baje donde § La migración de los relojes dice que baja |
| 0b | **Hecho (2026-11-07, `e1710ba6`).** Los dos defectos anteriores al plan que destapó el 0, en keel-go: un `schedule` sin persistencia se rechaza con motivo en `supported-features.js` (hoy se descarta en silencio) y el relay drena al apagar como dicen `architecture.md` y `concurrency.md` (o la documentación dice lo que hace) | `test/supported-features.test.js` y la prueba emitida del apagado; `go-check` |
| 1 | **Hecho (2026-11-07, `2924f0d0`).** keel-core: schema, `crossrefs.js`, `checks.js`, mutaciones, la clase de huecos, la revisión, `docs/dsl/domain.md` y el historial de `dsl-reference.md`. DSL 2.26 sustituye a 2.25 | `npm test` de keel-core y `design-matrix` sin ids sin mutación |
| 2 | **Hecho (2026-11-07)**, ver la nota de abajo. `keel-core/gen/deadlines.js` y `keel-core/gen/timer-store.js`: el guard como datos, **el reloj inyectable** del dominio y la aplicación (qué recibe el dominio y cómo lo sustituyen las pruebas emitidas; solo lo usa lo nuevo), la regla de T1 acotado (la hora de la base solo en `keel_timer`, y ninguna comparación que cruce de una fuente a otra), el cron en UTC (T7), la tabla `keel_timer` (como `messaging-stores.js`: columnas, índice, sentencias de armado, reclamo, revalidación y purga por motor, con la hora de la base), el algoritmo del sondeador como referencia ejecutable, las sentencias del arnés, la nota del handler, las filas del gate y los casos DL | Sus pruebas (la referencia del sondeador EJECUTADA con un reloj falso), y `buildModel` de todas las fixtures sin cambios |
| 2b | **Hecho y medido en los cuatro (2026-11-07)**, ver la nota de abajo. **El paso de migración del generador**: un mecanismo para que build emita su propio paso de esquema en una base ya desplegada (Flyway `V<n>` en keel-spring, migración de TypeORM en keel-nest, migración de EF en keel-dotnet, paso de goose en keel-go), con un número que no choque con los pasos del agente, y su línea en `EVOLUTION.md`. En MongoDB no hace falta: los índices se aseguran al arrancar. Antes estaba en el 10; sin él, nada de lo que añade `keel_timer` se puede publicar | `test/design-evolution.test.js` de los cuatro y, en las redes de base, un proyecto con base desplegada que recibe la tabla por el paso: `db-check` de keel-go (como en el inc. 15), y el arranque en `develop` de los otros tres |
| 3 | **Hecho (2026-11-08)**, ver la nota de abajo. El cronómetro con los plazos en keel-spring: la tabla, el sondeador (los dos modos), el armado, el guard tardío, el reloj inyectable y el interruptor `scheduling.enabled` (keel-spring no tenía ninguno: `contextLoads` con H2 arranca con el cronómetro apagado). Ningún reloj existente cambia todavía | `compile-check`, `claim-check` con los sabotajes `dl-*`, `harness`; matriz con las filas `deadline` y `timer` |
| 4 | Lo mismo en keel-nest | `ts-check`, `db-check`, `doc-check`, `harness-check` |
| 5 | Lo mismo en keel-dotnet | `cs-check`, `db-check`, `doc-check`, `harness-check` |
| 6 | Lo mismo en keel-go | `go-check`, `db-check`, `doc-check`, `harness-check` |
| 7 | **En curso (2026-11-08)**: lo neutral y keel-spring hechos, ver la nota de abajo; siguen keel-nest, keel-dotnet y keel-go. **Migrar las purgas** (las cuatro tablas) al modo clúster, en los cuatro | `store-check` en keel-spring y `db-check`/`doc-check` en los otros tres, con un sabotaje nuevo `timer-every-replica` (la purga vuelve a correr en todas: la sonda de dos réplicas la ve dos veces) |
| 8 | **Migrar el `schedule` de las operaciones** al modo clúster, con el drenaje, en los cuatro. Incluye `fireTimer(kind)` en el arnés de los cuatro (los flujos de rescate y reconciliación dejan de esperar un tick del cron), el rescate, la reconciliación, los pagos y la guarda del correo, que van montados en él | `claim-check` en keel-spring, `db-check`/`doc-check`, `harness-check` (el rescate y `ageForReconciliation` sobre el cronómetro) y `stub-check` (reconciliación de pagos); el gate de idempotencia con el registro nuevo, falsado |
| 9 | **Migrar el relay del outbox** al modo por réplica, con despertar al confirmar, en los cuatro, conservando la pausa del arnés con la misma API (en keel-spring ya no puede depender de `ScheduledAnnotationBeanPostProcessor`, y la purga del outbox sale del bean del relay) | `broker-check` contra los tres brokers en los cuatro generadores (el relay es lo que más redes toca), con un sabotaje `relay-no-wake` (sin despertar, la latencia vuelve al sondeo y la sonda de latencia lo ve). Y `clock-load.js`: en reposo, menos de 10 transacciones/min por réplica (hoy 122), y la salida de un evento en milisegundos (hoy media 0,5 s, p95 0,94 s) |
| 10 | ~~Evolución~~: pasa al **2b** (§ Incremento 0: lo medido, punto 4) | — |
| 11 | Telemetría del cronómetro (vencidos sin reclamar, aparcados, duración del tick) y su entrada en el panel y las alertas | `telemetry-check` en los cuatro |
| 12 | Fixture `stock-reservation` con el plazo (versión nueva, escenarios con `ageForDeadline`) y su gemela documental si la hay | `--ready` en verde y las redes que la tienen de sujeto |
| 13 | Corrida de control en los cuatro sobre `stock-reservation` **y** repetición de la serie de `catalog-extended` (outbox, purgas, barridos y reconciliación, todo sobre el cronómetro) | Mismo resultado en los cuatro, el guard tardío en el dominio, y la serie de `catalog-extended` igual que la de 2.25 (55/55) |

**Lo que dejó el incremento 2.** `gen/deadlines.js` (los plazos del modelo, la duración, `isDeadlineDue` con D3, `lateGuards`, `CLOCK_PORT`, las dos notas del handler, los casos DL y los sabotajes), `gen/timer-store.js` (`KEEL_TIMER` con la valla `claim_token` y el uuid nulo de los recurrentes, `TIMER_PARAMETERS`, los `kind`, las sentencias de PostgreSQL y MySQL con `bindNamed`/`expandList`, la forma documental y `CRON_UTC_CASES`, verificados contra la librería `cron`), `gen/timer-poller.js` (la referencia ejecutable: almacén en memoria con la semántica de las sentencias, `pollOnce`, `deadlineTick`, `recurringTick`) y la puerta `DEADLINE` de `entry-gates.js`, que no entra en el enum porque `by` es `internal`. Las pruebas: `test/timer-poller.test.js` (RC-1 a RC-6 y DL-5 a DL-10 con dos réplicas), `test/timer-store.test.js` y la red nueva `npm run timer-sql-check`, verde en los dos motores y falsada con tres sabotajes (`no-skip-locked`, `no-fence` y `park-order`, este solo en MySQL). Esa red destapó un defecto antes de que llegara a ningún generador: en MySQL, el upsert del recurrente con el alias de fila `new` dejaba `spec` ambigua (ERROR 1052). **Pasan al incremento 3**, porque dependen de cómo escribe cada generador: las filas del gate de la operación `by` (son patrones de cada lenguaje), los helpers documentales del arnés (scripts de `mongo-probes.js`) y la fila `timer` de `mechanisms.js`.

**Lo que dejó el incremento 2b.** Lo neutral en `keel-core/gen/schema-steps.js`. Qué tiene la base desplegada se lee de las migraciones de disco ANTES de escribir; sin baseline no hay paso. El SQL es idempotente (`IF NOT EXISTS`), y el mismo en los cuatro servidores. La numeración va tras el último paso, y un paso ya emitido se vuelve a emitir tal cual: no se reescribe nunca. `EVOLUTION.md` gana `schemaSteps` (informativo) y `schemaWork` (pendiente, «Esquema pendiente»). `timer-sql-check` crea sus tablas con ese paso, dos veces.

Cada generador lo emite como un paso de su herramienta. keel-spring escribe `V<n>__keel_*.sql` de Flyway; keel-nest, una migración de TypeORM con una sentencia por llamada; keel-dotnet, una migración de EF con `migrationBuilder.Sql`; keel-go, `0000N_keel_*.sql` de goose, con su `Down`. En keel-go la pregunta del inc. 15 ya no sale cuando lo único que cambia en la baseline son tablas que cubre un paso de build.

Las redes:
- keel-spring tiene una red nueva, `npm run schema-step-check`. Exporta el DDL de Hibernate, le quita las tablas del generador, deja que `build --refresh` escriba el paso y arranca el perfil `migrations` emitido con Flyway y `validate`, dos veces. Está en verde en PostgreSQL y MySQL sobre `notification-mailer`, y falsado con `--sabotage=no-step`. Destapó un defecto anterior al plan: `PROFILE=local,migrations` no arrancaba con índices condicionados, por la dependencia circular de `defer-datasource-initialization` con Flyway. Está arreglado.
- `db-check` de keel-go gana el caso del paso de build sobre `product-catalog`: 23/23 en los dos motores, falsado.
- `db-check` de keel-nest gana el bloque del paso de build sobre `notification-mailer`, con el exportador y el `verify` emitidos: 36/36 en los dos motores, falsado.

**En keel-dotnet**, además, EF compara el modelo con el `ModelSnapshot`, que es del agente. El agente lo sincroniza con una migración vacía (`Sync<Tabla>Snapshot`), y build lo vigila: `schemaWork` y `--check` siguen en rojo hasta que el snapshot nombra la tabla.

Lo mide el caso nuevo de `harness-check`: una base desplegada con una baseline de `dotnet ef` sin la tabla recibe el paso. Sin sincronizar, `has-pending-model-changes` ve cambios pendientes; sincronizado, la tabla llega y `verify-baseline.sh` da OK. Sin el paso, sale KO. 45/45 en PostgreSQL y en MySQL.

Lo que destapó: `dotnet ef database update` con el snapshot atrasado sale en rojo en PostgreSQL, pero en MySQL avisa y aplica. La puerta, por tanto, es `has-pending-model-changes` y no el arranque. Así lo dicen ya la nota y la skill.

**Lo que dejó el incremento 3.** El sujeto es la fixture nueva de la decisión 4, el par `verification-codes` /
`verification-codes-mongo`: un código de verificación caduca a los `codeTtlMinutes` de `issuedAt`, `expireCode` lo caduca
y verificarlo tarde es `CODE_EXPIRED` (410). keel-spring lo genera entero en `src/scaffold/timer.js`:

- En el dominio, `<Servicio>Deadlines` (la duración vigente de cada plazo, poblada desde `<Servicio>Parameters`) y el
  rechazo tardío en `transitionTo(target, now, deadlines)`. El `transitionTo` de un argumento se niega a salir de un
  estado con plazo hacia otro destino.
- El reloj inyectable es `java.time.Clock` (`TimerConfig`, `Clock.systemUTC()`), inyectado con los plazos en los
  handlers que salen del estado.
- El armado va en el `save` del adaptador, solo al ENTRAR en el estado. En relacional se ve por el estado de la fila
  gestionada; en documental, leyendo el documento antes de reemplazarlo.
- El almacén: `JdbcTimerStore` usa `JdbcClient` con las sentencias de keel-core tal cual, y `KeelTimerJpa` existe solo
  para el esquema (así entra en el baseline y en el paso de build del 2b). `MongoTimerStore` usa la forma documental.
- `TimerPoller`: un hilo de plataforma por réplica, apagable con `scheduling.enabled` (en `test` va apagado). Trae un
  handler por plazo (`<Entidad><Estado>Deadline`, que revalida y despacha `by`) y la purga de la tabla como primer
  recurrente (R7).
- El gate `infra/check-deadlines.sh`, `ageForDeadline` en el arnés y las notas neutrales en los handlers.

La operación `by` deja de contar como interna huérfana (`orphanInternalOperations`), y la matriz gana las filas
`deadline` y `timer` (pendientes en los otros tres, con su incremento).

La red es nueva: `npm run timer-check` (`src/lib/timer-probes.js`). Escribe un JUnit en el proyecto generado y ejecuta
DL-1 a DL-10 y R1 contra el motor: 13/13 en PostgreSQL, MySQL y MongoDB. Está falsada con cinco sabotajes en PostgreSQL
(`dl-boundary`, `dl-no-guard`, `dl-no-revalidate`, `dl-no-lease` y `dl-outside-tx`) y cuatro en MongoDB, cada uno en
exactamente sus casos. `schema-step-check` sobre `verification-codes` da 4/4 en PostgreSQL y MySQL: el `keel_timer` que
crea el paso de build del 2b es el que valida Hibernate contra `KeelTimerJpa`.

Lo que destapó:

- La hora de MySQL pasa a `UTC_TIMESTAMP(6)` en lo neutral. `datetime` no guarda zona, y `current_timestamp` es la de la
  sesión.
- En MongoDB, `hello` no se admite dentro de una transacción (error 263), así que la hora sale de un `$documents` sobre
  la base sin la sesión. Y `List.of` no admite el null de BSON.
- Sin arriendo, el reclamo documental vuelve a llevarse en el mismo lote lo que acaba de reclamar. Por eso
  `dl-no-lease` cae allí también en DL-5. En lo neutral, `dl-no-lease` rompe DL-6 y DL-7, no solo DL-6.
- Un defecto anterior al plan: el arnés no compilaba con ejecución en contenedor y sin broker (faltaban los imports de
  `copyIntoContainer`).

Lo que no entra, con su motivo:

- El modo por réplica no se emite: su único usuario es el relay (inc. 9), y un modo sin sujeto no lo ejecuta ninguna
  red.
- `dl-wrong-field` y `dl-app-clock` no tienen sujeto en esta fixture: hay una sola marca de tiempo, y la red corre con la
  instancia y la base en la misma máquina.
- `ageForDeadline` está emitido y compilado en las tres ramas, pero no se ha ejecutado: lo ejecutarán los escenarios de
  la fixture del inc. 12.
- `claim-check` no cambia: el cronómetro tiene su propia red.

**Lo que dejó el incremento 4.** keel-nest genera el cronómetro y los plazos en `src/scaffold/timer.js`, con la misma
forma que keel-spring: plazos poblados desde los parámetros, el rechazo tardío en el dominio, el reloj inyectable, el
armado en el `save` del adaptador (relacional y documental), el almacén con las sentencias de keel-core tal cual, el
sondeador con su interruptor, un handler por plazo, la purga de `keel_timer`, el gate `infra/check-deadlines.sh` y
`ageForDeadline` en el arnés. `deadlinesPendingErrors` sale de su frontera, y las filas `deadline` y `timer` de su
matriz pasan a verificadas y falsadas.

Las redes son las que ya tenía, con el sujeto nuevo: `db-check --subject=verification-codes` da 62/62 en PostgreSQL y en
MySQL; `doc-check --subject=verification-codes-mongo`, 40/40. Los cinco sabotajes `dl-*` caen en exactamente sus casos en
las dos (en documental, `dl-no-lease` también en DL-5, como en keel-spring). `ts-check` da 13/13, y la suite 969/969.
Sin red, `test/deadlines.test.js` ejecuta el gate (nace rojo, el parche del agente lo pone verde y la hora de la
instancia lo vuelve rojo), compara las sentencias y el `timer.yaml` de los cuatro perfiles con keel-spring y la nota del
handler con la neutral.

Lo que destapó: a la colección `keelTimer` le faltaba su índice por `due_at` en los índices documentales, que consumen
los cuatro generadores. Ahora lo añade lo neutral (`storeDocumentIndexes` de `gen/document.js`), y `timer-check` de
keel-spring sigue en 13/13 sobre `verification-codes-mongo`. Y en TypeScript strict, el marcador de MySQL necesita su
parámetro aunque no lo use (TS2554).

**Lo que dejó el incremento 5.** keel-dotnet genera el cronómetro y los plazos en `src/scaffold/timer.js`, con la forma de
keel-spring en C#:

- En el dominio, `<Servicio>Deadlines` y el rechazo tardío en `TransitionTo(target, now, deadlines)`. El reloj
  inyectable es `TimeProvider`, del BCL.
- El armado va en el `Save` de los dos adaptadores. El almacén `TimerStore` corre sobre la conexión y la transacción del
  DbContext, con las sentencias de keel-core tal cual y los marcadores traducidos a los del driver, o sobre la forma
  documental. `KeelTimerRow` existe solo para el esquema de EF.
- `TimerPoller` es un `BackgroundService`, con un handler por plazo, la purga de la tabla y `TimerRegistration`.
- El gate es `infra/check-deadlines.sh`, y `AgeForDeadline` entra en `FlowTest.cs` en las dos ramas.

`deadlinesPendingErrors` sale de su frontera, y la matriz queda sin filas pendientes.

Las redes son las de siempre, con el sujeto nuevo y una sonda C# por caso (`scripts/lib/timer-probes.js`, métodos
`DL<n>_…` dentro de la clase de sondas del sujeto). `db-check` da 6/6 en PostgreSQL (19 sondas) y en MySQL (20).
`doc-check` da 6/6 (17 sondas). Los cinco sabotajes `dl-*` caen en exactamente sus casos en las dos ramas (en documental,
`dl-no-lease` también en DL-5). `cs-check --fixtures` compila sin warnings las 19 fixtures y 41 variantes y pasa 8598
pruebas emitidas, `TimerTests` incluida. Sin SDK, `test/deadlines.test.js` hace lo mismo que el de keel-nest.

Lo que destapó: un namespace `…Infrastructure.Timer` habría tapado `System.Threading.Timer` en toda la infraestructura,
así que se llama `Timers`. Y los casos no pueden ir en una clase de pruebas propia: xUnit ejecuta las clases a la vez,
y las dos compartirían la base y `keel_timer`.

**Lo que dejó el incremento 6.** keel-go genera el cronómetro y los plazos en `src/scaffold/timer.js`:

- En el dominio, `<Servicio>Deadlines` y el rechazo tardío en `transitionAt(target, now, deadlines)`. El reloj inyectable
  es `application.Clock` (`time.Now` en el arranque).
- El armado va en el `Save` de los dos adaptadores. El paquete `internal/infrastructure/timer` lleva `Store`, `Poller`,
  la purga y un handler por plazo; `timers.go`, en el paquete del motor, lleva las sentencias de keel-core tal cual con
  sus marcadores traducidos en tiempo de ejecución, o la forma documental. `main.go` lo cablea en el errgroup.
- El gate es `infra/check-deadlines.sh`, y `AgeForDeadline` entra en el arnés.

La frontera ya no rechaza el plazo: solo las formas que el handler generado del plazo no sabe despachar (una entidad que
no es raíz con uuid, o un `by` cuyo mensaje lleva más que el id), con su fila en el README. La matriz queda sin filas
pendientes. La exclusión temporal de `keel_timer` en las paridades de esquema se retira: la tabla es la de keel-spring.

Las redes son las de siempre, con el sujeto nuevo y una sonda Go (`scripts/lib/timer-probes.js`, `timer_probe_test.go`
en el paquete del motor, con pruebas `TestTimer_DL<n>_…`). `db-check` da 8/8 en PostgreSQL (20 sondas) y 7/7 en MySQL.
`doc-check` da 5/5 (20 sondas). Los cinco sabotajes `dl-*` caen en todos sus casos y solo en ellos en las dos ramas (en
documental, `dl-no-lease` también en DL-5). Sin Go, `test/deadlines.test.js` hace lo mismo que el de los otros dos, y
además comprueba que los sabotajes se siguen aplicando.

Lo que destapó:

- keel-go lleva `scheduling.enabled` en su `scheduling.yaml`, porque su lector de configuración no admite una clave en
  dos archivos. Su `timer.yaml` no es el de keel-spring byte a byte, así que la prueba compara la mecánica y el valor
  efectivo de cada clave.
- El falsado «sin un índice de FK» de `db-check` elegía `ix_keel_timer_due_at`, que no es de una FK. Se excluye como los
  de las otras tablas del generador.
- La prueba emitida del sondeador (`poller_test.go`) no compilaba: declaraba el paquete externo `timer_test` y usaba los
  tipos de `timer` sin calificar. Las redes sin Go no lo ven; lo vio `go-check --fixtures` en las tres ramas del par. Ahora
  es una prueba interna del paquete.

**Lo que dejó el incremento 7, en lo neutral y en keel-spring.** Lo neutral es `keel-core/gen/timer-plan.js`. Dice
CUÁNDO existe el cronómetro: con plazos, o con alguna purga de una tabla del generador sobre un motor que lo tiene
(`usesTimer`). Y dice QUÉ recurrentes monta: la purga de `keel_timer` y una por tabla, con el cron de siempre
(`timerPurges`, `purgedByTimer`). Un motor sin sentencias del cronómetro (MariaDB, SQL Server, Oracle: solo los genera
keel-spring) no tiene cronómetro, y sus purgas conservan su `@Scheduled` por réplica. El índice documental de
`keelTimer` sigue a `usesTimer`.

En keel-spring:

- Cada purga pierde su `@Scheduled` (`purgeSchedule` de `purge.js`) y gana un `<Tabla>PurgeTimer`, un recurrente que
  llama al `purge()` de siempre. La purga no cambia: sus lotes, su retención y sus transacciones son las mismas.
- `RecurringTimerHandler` deja de ser un `TimerHandler`: es `kind`, `spec` y `tick()`. El sondeador lo ejecuta FUERA de su
  transacción y lo rearma con el siguiente cron desde la hora de la base (R2). Dentro de una transacción, la purga por
  lotes volvería a ser el DELETE único que sustituye.
- El sondeador recibe sus handlers por `ObjectProvider`, porque sin plazos no hay ningún `TimerHandler`.
- El cronómetro llega a todo diseño con purgas, y con él `KeelTimerJpa` y su paso de esquema del 2b. Un proyecto
  desplegado de `product-catalog` recibe `idempotency_record` y `keel_timer` en el mismo paso.

La red es la sonda nueva de `store-check` (`src/lib/purge-timer-probes.js`). Simula dos réplicas: dos `TimerPoller`, cada
uno con sus propias instancias de cada recurrente, y el bean que purga doblado por Mockito, que cuenta las ejecuciones.
Mide R1 (una fila por purga), RC-1 (un solo tick ejecutado) y R2 (el rearme). Da 27/27 en PostgreSQL y en MySQL sobre
`notification-mailer`, y 21/21 en MongoDB sobre `notification-mailer-mongo`. El sabotaje `timer-every-replica` (un `kind`
por instancia, así que cada réplica arbitra con su propia fila) cae en exactamente R1 y RC-1 en las dos ramas.
`compile-check` está en verde sobre el par del MVP, `stock-reservation`, `asset-vault` y Oracle (sin cronómetro), y
`timer-check` da 13/13.

Lo que destapó: el gate de la reconciliación (`lote del barrido`) daba verde con el `LIMIT` del reclamo de
`JdbcTimerStore`, que es código de build. No se había visto porque ninguna fixture con `reconciledBy` tenía cronómetro, y
`catalog-extended` lo gana con sus purgas. Ahora las clases `*Timer*` quedan excluidas, como las demás del generador.
Mientras keel-nest, keel-dotnet y keel-go no hacen su parte, hay tres concesiones temporales, y cada una se retira en el
commit de ese generador:

- sus paridades de esquema solo comparan `keel_timer` donde ellos ya lo emiten (los plazos);
- su prueba de paridad del paso de esquema con keel-spring queda como `todo`;
- su fila `timer-purge` de la matriz queda pendiente (con su excepción en la prueba que prohíbe pendientes en dotnet y
  go).

**Lo que dejó el incremento 7 en keel-nest.** Cada purga es un `<Tabla>PurgeTimer` que llama al método de siempre de
`TablePurges`. `TablePurges` ya no recibe `Scheduling` cuando todo va por el cronómetro, y `SchedulingModule` pasa a ser
global y exporta `PURGE_SETTINGS`. `RecurringTimerHandler` es `kind`, `spec` y `tick()`, con su propio token
(`TIMER_RECURRINGS`), y el sondeador lo ejecuta fuera de la transacción.

La red es el bloque de dos réplicas de `db-check` y `doc-check` (`purgeTimerBlock`): dos `TimerPoller` con sus propias
instancias y `TablePurges` doblado, con los mismos casos que keel-spring. `db-check` da 116/116 en PostgreSQL y MySQL, y
`doc-check` 21/21. El sabotaje `timer-every-replica` (un `kind` por instancia) cae en exactamente R1 y RC-1 en los tres
motores. Sin red, `test/purge-timer.test.js` cubre los recurrentes emitidos, la paridad de nombres con keel-spring y que
el sabotaje se sigue aplicando.

Lo que destapó `ts-check`: el arranque en `develop` sobre una base sin migrar hace que el sondeador consulte `keel_timer`,
y TypeORM, con su logger por defecto, escribía la consulta fallida en crudo, fuera del JSON ECS. No es del cronómetro: le
pasaba a toda consulta que falla, también a la violación de unicidad que el servicio traduce a 409 en uso normal. Ahora
TypeORM escribe por el `Logger` de Nest (`NestTypeOrmLogger`, en `data-source-options.ts`), y una consulta fallida es un
aviso, como en keel-spring.

El orden va del menor al mayor riesgo. Los incrementos 3-6 añaden un mecanismo sin tocar nada medido. Después se migra
lo que menos redes toca (las purgas) y al final el relay, que toca los tres brokers en los cuatro generadores. Cada
migración es un incremento propio con su puerta, y entre una y otra el servidor generado sigue en verde.

## Cómo se ejecuta

**Lo que queda del plan se hace entero desde `main`, sin lanzar subagentes.** Desde el incremento 4 hasta el 13, el
orquestador hace cada incremento él mismo, en `main`, uno detrás de otro: sin agentes, sin worktrees y sin ramas por
incremento. Lo decidió el usuario el 2026-11-08. La fase E se había lanzado con tres agentes en paralelo y los tres
agotaron dos veces su límite de sesión sin terminar: el paralelismo gastaba el presupuesto entero y ni siquiera ahorraba
tiempo de reloj.

Cómo se trabaja cada incremento:

1. **En secuencia y en el orden de la tabla de abajo.** keel-spring va siempre primero, porque las pruebas de paridad de
   los otros tres comparan con lo que EMITE keel-spring.
2. **Primero lo neutral** de `keel-core/gen` que el incremento necesite, y después cada generador.
3. **Cada generador se cierra antes de empezar el siguiente:** sus pruebas sin red, sus redes en vivo con sus
   sabotajes, su suite y su commit en `main`.
4. **Las redes en vivo van de una en una:** dos procesos pesados a la vez agotan la memoria de la máquina.

| Fase | Incrementos | Cómo |
|---|---|---|
| A-D | Preguntas, 0, 0b, 1, 2, 2b y 3 | Hechas |
| E | 4 (keel-nest), 5 (keel-dotnet) y 6 (keel-go) | En secuencia, desde `main` |
| F | 7, 8 y 9 | Cada migración en secuencia. Dentro de cada una, lo neutral, keel-spring, keel-nest, keel-dotnet y keel-go, uno detrás de otro |
| G | 10 y 11 | En secuencia, generador por generador |
| H | 12 | La fixture |
| I | 13 | Las corridas de control las lanza el usuario, dos a la vez como mucho |

**El trabajo parcial de los agentes cortados** quedó como un commit WIP en las ramas `inc4-6-keel-{nest,dotnet,go}`. Cada
incremento de la fase E empieza recuperando el suyo (`git checkout inc4-6-keel-<tech> -- packages/keel-<tech>`), lo
revisa contra keel-spring y lo termina en `main`. Cerrado el 6 (2026-11-08), esas tres ramas se borraron.

**Histórico:** las fases B y C2 sí usaron agentes (solo lectura en la B; en la C2, paralelos y en worktrees, tras
keel-spring). Ese método queda retirado.

## Incremento 0: lo medido (2026-11-07)

Cuatro agentes de solo lectura, uno por generador, hicieron el inventario. Esto es lo que cambia el plan; el detalle,
con `archivo:línea`, está en sus informes (resumidos aquí, no guardados aparte).

### Lo mismo en los cuatro

- **Los mismos relojes**: un registro de tareas por cron (`@Scheduled` en keel-spring, `cron` 4 en keel-nest,
  `BackgroundService` con Cronos en keel-dotnet, robfig/cron con temporizadores propios en keel-go) para los `schedule`
  y las cuatro purgas, y un bucle aparte para el relay del outbox, con retardo fijo de 1 s. **Todo corre en todas las
  réplicas**, y el doble trabajo lo evita solo el reclamo por fila. Las purgas no lo evitan: corren a la vez en todas,
  y no rompen nada porque borrar es idempotente.
- **No hay reloj inyectable en el dominio ni en los handlers de ninguno.** Usan `Instant.now()`, `new Date()`,
  `DateTimeOffset.UtcNow` o `time.Now()` de la instancia. Solo los pagos (keel-spring, keel-dotnet) y algunas piezas
  de los clientes HTTP (keel-dotnet, keel-go) reciben un reloj. **Ninguna consulta usa la hora de la base**: los
  reclamos, el arriendo del relay y los cortes de las purgas reciben la hora de la instancia como parámetro.
- **El cron de un `schedule` va literal en el código** generado, sin clave ni variable de entorno. Lo configurable son
  el relay y las purgas.
- **Ningún generador sabe llevar una tabla suya nueva a una base ya desplegada.** El baseline lo exporta el agente
  (Flyway en keel-spring, TypeORM en keel-nest, `dotnet ef` en keel-dotnet) o lo escribe build (goose en keel-go), y la
  evolución de `keel-core/gen/evolution.js` no tiene ningún paso de esquema. Con `build --refresh` la entidad nueva
  llega, pero en `develop` y `production` el arranque cae: `validate` de Hibernate, `MigrateAsync` de EF con cambios
  pendientes o la tabla ausente en keel-nest y keel-go. En MongoDB no hay problema: los índices se aseguran al arrancar
  en los cuatro.
- **Ningún helper del arnés adelanta un tick.** Los flujos de rescate y reconciliación fabrican el estado en la base y
  esperan al cron real, con márgenes de 10 a 90 s. El relay se pausa de dos formas: en el proceso
  (`ScheduledAnnotationBeanPostProcessor` en keel-spring, `OutboxRelay.pause()` en keel-nest) o aparcando las filas con
  `next_attempt_at = 2999` (keel-dotnet y keel-go, cuyo servidor es otro proceso).
- **Los gates y las notas al agente nombran el reloj**: `confirm: '@Scheduled'` en keel-spring, la clase
  `<Grupo>Scheduler` o `<Owner>Tasks` en los otros tres, y «corre en TODAS las réplicas» en las notas del handler y en
  las skills de pagos y reconciliación.
- **No hay telemetría del disparo**: ni span ni métrica de la pasada de un barrido o de una purga, solo logs. El relay
  sí tiene su span y su gauge de descartados.

### Lo que difiere

| Qué | keel-spring | keel-nest | keel-dotnet | keel-go |
|---|---|---|---|---|
| Interruptor de los relojes | **ninguno**: el perfil `test` arranca el relay contra H2 | `scheduling.enabled` (no apaga el relay) | `scheduling.enabled` (el relay lo apaga `database.Enabled`) | `scheduling.enabled` (el relay, `database.Enabled`) |
| Un `schedule` sin persistencia | se emite y corre por réplica | ídem | ídem | **se descarta en silencio** (defecto anterior al plan) |
| Zona horaria del cron | la de la JVM | la del proceso | `TimeZoneInfo.Local` | la del proceso |
| Relay al apagar | espera 30 s a la tarea | espera la pasada en vuelo | deja el lote a medias con su arriendo | **no drena**, aunque `architecture.md` y `concurrency.md` dicen que sí (defecto de documentación anterior al plan) |
| Purga del outbox | en el MISMO bean que el relay: pausar el relay pausa la purga | aparte | aparte | aparte |

### Lo que cambia en el plan

1. **El reloj inyectable no existe: hay que crearlo** en los cuatro, en el dominio y la aplicación, antes del guard
   tardío (D2). Pasa a ser parte del incremento 2 (la forma neutral: qué recibe el dominio, cómo lo sustituyen las
   pruebas emitidas) y de los 3-6. Solo lo usa lo nuevo: migrar todo `now()` existente a ese reloj queda fuera, porque
   no lo pide ninguna decisión y tocaría todo el código emitido.
2. **T1 se acota.** La hora de la base es la del cronómetro (`due_at`, reclamo y arriendo de `keel_timer`). Los reclamos
   por fila de cada mecanismo siguen con la hora de la instancia, como hoy. Mezclar las dos fuentes solo es seguro si
   ninguna comparación cruza de una a otra, y así se escribe en `deadlines.js` como regla, con su prueba.
3. **Nueva decisión T7: el cron se evalúa en UTC.** Hoy cada generador usa la zona del proceso, y dos réplicas con
   zonas distintas dispararían a horas distintas. Cambia la hora real de las purgas (las 03:00 pasan a ser UTC), y se
   documenta en `EVOLUTION.md`.
4. **La evolución deja de ser el incremento 10 y pasa a ser el primero de los generadores.** Ningún proyecto ya
   desplegado puede recibir `keel_timer` hasta que exista un mecanismo para que el generador emita su propio paso de
   migración, en los cuatro y con número que no choque con los pasos del agente. Es un mecanismo nuevo y no solo una
   línea en `EVOLUTION.md`, y sin él los incrementos 3-6 no se pueden publicar. Nuevo incremento **2b**, entre lo
   neutral y keel-spring.
5. **Un solo interruptor**: el cronómetro se apaga con `scheduling.enabled` en los cuatro (keel-spring lo gana), y
   apaga también el relay. En el perfil `test` sin base, apagado. En keel-spring, `contextLoads` con H2 tiene que poder
   arrancar con el cronómetro apagado.
6. **El arnés gana `fireTimer(kind)`**, que adelanta el `due_at` de un recurrente. Los flujos de rescate y
   reconciliación dejan de esperar un tick del cron. La pausa del relay se conserva con la misma API en los cuatro
   (keel-spring: la pausa ya no puede depender de `ScheduledAnnotationBeanPostProcessor`). Va con la migración 8 y 9.
7. **Dos defectos anteriores al plan**, que se arreglan aparte y antes: keel-go descarta en silencio un `schedule` sin
   persistencia (se rechaza con motivo en `supported-features.js`, como el resto de su frontera), y su relay no drena
   al apagar aunque la documentación dice que sí.
8. **Lo que hay que conservar al migrar**, sacado de las pruebas que ya lo afirman: que una pasada en vuelo no se solape
   con la siguiente, que el apagado espere a la pasada, la correlación nueva por pasada, la divergencia documental de
   keel-spring (purgas de Mongo sin `BatchedPurge`), los hilos de plataforma de `SchedulingConfig` y la regla de
   `logging-check` que prohíbe los executors programados de `Executors`.
9. **Las pruebas de paridad comparan con keel-spring y keel-nest** (`scheduling.test.js` de keel-dotnet y keel-go). Si
   keel-spring cambia su reloj primero, se rompen: en cada migración, keel-spring y los otros tres se cierran juntos,
   aunque se escriban por separado.

### La carga de partida

Medida con `scripts/clock-load.js` sobre el proyecto de keel-go de la corrida de control de la 2.25
(`catalog-extended`, PostgreSQL y RabbitMQ). La ventana es de 5 minutos tras 1 de calentamiento, y los contadores son
los de `pg_stat_database` y `pg_stat_user_tables`. Los JSON quedan en `D:\keel-tmp\clock-load\`.

| Medida | Transacciones/min | Recorridos de `outbox_event`/min | Salida de un evento |
|---|---|---|---|
| 1 réplica, en reposo | **122** | 60 | — |
| 3 réplicas, en reposo | **362** | 179 | — |
| 1 réplica, 5 altas/s (1.490 × 201) | 888 | 651 | media 0,5 s · p95 0,94 s |
| 3 réplicas, 5 altas/s (1.490 × 201) | 898 | 770 | — |

Lo que dicen:

- **En reposo, toda la carga es el relay del outbox.** Ninguna otra tabla tiene un solo recorrido: unas 120
  transacciones y 60 recorridos por minuto y réplica. Escala lineal con las réplicas: tres réplicas, el triple. Es lo
  que tiene que bajar con la migración 9. Con el despertar al confirmar y un sondeo de respaldo cada 30 s, el objetivo
  es **menos de 10 transacciones por minuto y réplica** (−95 %).
- **Con carga, los relojes son una parte pequeña.** Pasar de 1 a 3 réplicas añade 120 recorridos del outbox (dos
  relays más en vacío), pero apenas cambia las transacciones. Lo que cuesta es atender las altas: idempotencia, alta
  del producto, outbox y las lecturas de la categoría. Ahí la migración no gana casi nada.
- **La salida de un evento tarda de media 0,5 s, y 0,94 s el p95**: es el sondeo de 1 s. El despertar al confirmar
  tiene que dejarla en milisegundos. Es la segunda puerta de la migración 9, y el script ya la imprime.
- **Lo que esta medida no ve**: el `schedule` de `catalog-extended` es horario y las purgas son diarias, así que no caen
  en una ventana de 5 minutos. Su ganancia es no correr en las tres réplicas a la vez (migraciones 7 y 8), y se mide con
  el sabotaje `timer-every-replica`, no con este script.

Para repetirla tras cada migración: levantar la `infra/` del proyecto (`bash infra/up.sh && bash infra/validate-infra.sh`)
y pasar `node scripts/clock-load.js <proyecto> --replicas=1|3 [--load=5] --label=<…>`. Hoy el script solo sabe
arrancar keel-go (`LAUNCHERS`): un binario, así que tres réplicas caben en esta máquina.

## Decisiones tomadas (antes preguntas abiertas)

Todas con la propuesta, aceptada por el usuario el 2026-11-07.

1. **La lectura antes del barrido.** Pasado el plazo y antes del barrido, `getReservation` devuelve `pending`. Hay
   dos salidas: (a) se devuelve el estado guardado, y el contrato dice que `expired` llega con el barrido; (b) se
   devuelve el estado **efectivo** (`expired`) calculado al leer. La (b) es más honesta para el cliente, pero obliga a
   que los filtros por estado de listados y finders digan lo mismo, y eso toca la 2.22 en los cuatro. **Propuesta:
   (a) en 2.26**, con la nota en `docs/dsl/domain.md`, y la (b) como R2b si un diseño real la pide.
2. **`by` declarada o derivada.** La evaluación decía «el barrido se deriva». Propongo declararla (D5), porque la
   caducidad casi siempre tiene efectos (liberar stock, emitir un evento) y esos son diseño. Derivarla entera
   obligaría a que el generador escribiera lógica de negocio.
3. **`since` por defecto.** ¿Se permite omitirlo y usar `createdAt`? Propongo que no: es justo la elección que el
   `REV-DOMAIN-DEADLINE-SINCE` quiere hacer visible, y `stock-reservation` ya enseña por qué `createdAt` engaña.
4. **El sujeto.** `stock-reservation` hoy no tiene estado `expired`. Añadirlo cambia su `lifecycle` y sus escenarios
   (y la serie de corridas que la tiene de sujeto). La alternativa es una fixture nueva y pequeña (un código de
   verificación, que caduca y se rechaza tarde), que no toca nada medido. **Propuesta: la fixture nueva para los
   incrementos 3-6 y `stock-reservation` en el 7**, cuando el mecanismo ya esté medido.
5. **La hora del guard tardío** (T2). El cronómetro usa la hora de la base y el guard la de la instancia. Con relojes
   sincronizados por NTP la diferencia es de milisegundos, pero no está garantizada. La alternativa es que el UPDATE
   condicional de la transición lleve también `since + after > now()` de la base. Es exacto, pero mueve el guard del
   dominio al adaptador, y entonces ya no lo miden las pruebas del dominio sino `db-check`. **Propuesta: el reloj de
   la instancia**, documentado, y la alternativa si un diseño la pide.
6. ~~**El alcance del cronómetro.**~~ **Decidido (2026-11-07)**: entran todos los relojes en 2.26 (§ La migración de
   los relojes, incrementos 7-11).
7. **El drenaje de un barrido en modo clúster.** Con una réplica por tick, ¿basta drenar en serie hasta vaciar o hasta
   agotar el periodo, o hace falta repartir un tick grande entre réplicas (un temporizador hijo por lote)? **Propuesta:
   drenar en serie en 2.26.** Los barridos de las fixtures caben de sobra en un periodo, y repartirlo se puede medir
   después si un diseño real lo pide.
8. **El relay por réplica.** Propongo dejarlo por réplica y ganar el despertar al confirmar. La alternativa (modo
   clúster, una réplica relaya cada vez) ahorraría consultas en reposo, pero limitaría el ritmo de salida de eventos a
   una réplica.
