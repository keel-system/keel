# DSL 2.26 — los plazos de negocio sobre el estado (`lifecycle.deadlines`)

Origen: R2 de `docs/evaluacion-dsl-2.24.md`. Este plan la lleva al DSL y a los cuatro generadores con la regla de
siempre: **el mismo diseño genera servidores equivalentes**. Cada pieza nueva tiene una red que la ejecuta y un
sabotaje que demuestra que esa red la ve.

**Estado: borrador para revisión.** Nada está implementado. Las decisiones marcadas «a confirmar» (§ Preguntas
abiertas) son las que cambian el contrato y no quiero tomar sin ti.

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
      by: expireReservations                             # la operación del barrido, declarada
      lateAction: { error: RESERVATION_EXPIRED }         # o: allow
```

- **`after`** tiene la misma forma que `stalledAfter`: segundos literales o un `service.parameters` con su unidad.
  Así el plazo es configurable por despliegue sin inventar una clave.
- **`since`** es el campo desde el que se cuenta. Tiene que ser un `timestamp` de la entidad, y una operación que
  lleve la entidad al estado (o la cree en él) tiene que estamparlo o ser `generated`.
- **`to`** es el destino de la caducidad y tiene que ser una arista declarada.
- **`by`** nombra la operación que ejecuta la caducidad, igual que `reconciledBy`. Es un `command` con `schedule` y la
  transición `from → to`. Lo que hace además (emitir `ReservationExpired`, liberar algo) sigue siendo diseño, no
  mecánica: por eso se declara y no se deriva entera.
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
  kind          varchar         'deadline:<Entidad>.<estado>'
  entity_id     uuid
  due_at        timestamp       índice (due_at)
  claimed_until timestamp NULL  arriendo
  attempts      int
  UNIQUE (kind, entity_id)
```

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

### Alcance: ¿todo lo temporizado, o solo los plazos?

Hoy cronometran por su cuenta el `schedule` de las operaciones, el relay del outbox, las purgas, el rescate de
`stalledAfter` y la reconciliación, en los cuatro generadores, y todo eso está medido. El cronómetro podría absorberlos.
Un `schedule` sería un temporizador recurrente, y de paso cada tick lo ejecutaría **una** réplica y no todas. Pero
cambiaría mecanismos que ya tienen redes y sabotajes.

**Propuesta:** en 2.26 el cronómetro nace **solo para los plazos**, con una interfaz que admita después otros `kind`.
La migración del resto va en un plan aparte (pregunta 6), uno por uno y con su red.

## Reglas mecánicas (keel-core)

Todas con su mutación en `test/design-mutations/catalog.js`.

| Id | Naturaleza | Qué ve |
|---|---|---|
| `CHK-DOMAIN-DEADLINE-TO-UNDECLARED` | error | `to` no es una arista de `transitions.<estado>` |
| `CHK-DOMAIN-DEADLINE-SINCE-INVALID` | error | `since` no existe o no es `timestamp` |
| `CHK-DOMAIN-DEADLINE-SINCE-UNSTAMPED` | aviso, incoherencia | ninguna operación que lleva la entidad al estado estampa `since`, y no es `generated` |
| `CHK-DOMAIN-DEADLINE-BY-INVALID` | error | `by` no existe, no es `command`, no tiene `schedule` o no declara la transición `from → to` |
| `CHK-DOMAIN-DEADLINE-PARAM-UNKNOWN` | error | `after.parameter` no está en `service.parameters` |
| `CHK-DOMAIN-DEADLINE-LATE-UNDECIDED` | aviso, `undecided`, `waivable: false` | sin `lateAction`. No hay default seguro: rechazar rompe al cliente que paga en el segundo 901, y aceptar vende stock ya liberado. Se cierra con una línea del DSL, así que es CHK y no OBL |
| `CHK-DOMAIN-DEADLINE-ERROR-UNDECLARED` | error | `lateAction.error` no está en `errors` de una operación que saca la entidad del estado hacia otro destino |
| `CHK-USECASES-SCHEDULE-UNDECLARED-DEADLINE` | aviso, `undecided` | un `command` con `schedule` que mueve un estado a otro sin `deadlines` que lo nombre en `by`: el plazo sigue en prosa (el detector de los diseños de hoy) |

Más: la clase del análisis de huecos que pregunta por los plazos, con una unidad por estado no terminal
(`gap-classes.js` + `gap-analysis.md`), y una pregunta de revisión `REV-DOMAIN-DEADLINE-SINCE` («¿el reloj empieza
cuando el negocio dice?»), que es la que no puede ver la máquina: `createdAt` frente a «cuando entró en `pending`».

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

## Incrementos

| # | Qué | Puerta |
|---|---|---|
| 0 | Medir: el reloj inyectable en el dominio de los cuatro (si un generador no lo tiene, se añade aquí), y cómo escribe hoy `stock-reservation` su caducidad | Nota en este plan con lo medido |
| 1 | keel-core: schema, `crossrefs.js`, `checks.js`, mutaciones, la clase de huecos, la revisión, `docs/dsl/domain.md` y el historial de `dsl-reference.md`. DSL 2.26 sustituye a 2.25 | `npm test` de keel-core y `design-matrix` sin ids sin mutación |
| 2 | `keel-core/gen/deadlines.js` y `keel-core/gen/timer-store.js`: el guard como datos, la tabla `keel_timer` (como `messaging-stores.js`: columnas, índice, sentencias de armado, reclamo, revalidación y purga por motor, con la hora de la base), el algoritmo del sondeador como referencia ejecutable, las sentencias del arnés, la nota del handler, las filas del gate y los casos DL | Sus pruebas (la referencia del sondeador EJECUTADA con un reloj falso), y `buildModel` de todas las fixtures sin cambios |
| 3 | keel-spring | `compile-check`, `claim-check` con los sabotajes `dl-*`, `harness`; matriz con la fila `deadline` |
| 4 | keel-nest | `ts-check`, `db-check`, `doc-check`, `harness-check` |
| 5 | keel-dotnet | `cs-check`, `db-check`, `doc-check`, `harness-check` |
| 6 | keel-go | `go-check`, `db-check`, `doc-check`, `harness-check` |
| 7 | Fixture `stock-reservation` con el plazo (versión nueva, escenarios con `ageForDeadline`) y su gemela documental si la hay | `--ready` en verde y las redes que la tienen de sujeto |
| 8 | Corrida de control en los cuatro sobre `stock-reservation` | Mismo resultado en los cuatro y el guard tardío en el dominio, no en el handler |

## Preguntas abiertas (a confirmar)

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
6. **El alcance del cronómetro.** ¿Nace solo para los plazos (propuesta) o se migran ya el `schedule`, el relay del
   outbox, las purgas, el rescate y la reconciliación? Migrarlos ahorraría consultas y haría que cada tick de un
   `schedule` lo ejecute una sola réplica. Pero rehace mecanismos medidos en los cuatro generadores, y propongo
   hacerlo en un plan aparte.
