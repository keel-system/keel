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
| D4 | El reclamo del barrido lo genera build: candidatos `status = from AND since <= now - after`, con el reclamo de siempre (SKIP LOCKED + UPDATE condicional en relacional, `findOneAndUpdate` en documentos) | Es la misma pieza que `stalledAfter` y `reconciledBy`. El índice (estado primero, marca después) ya tiene su aviso en `persistence` |
| D5 | La operación `by` la escribe el agente, como cualquier handler, y un gate comprueba que usa el reclamo y aplica `to` | Sus efectos son diseño. Dejarla al agente sin gate repetiría el «barrido que nunca reclama» de las corridas de 2.18 |
| D6 | La cadencia del barrido, el tamaño del lote y temporizador por fila frente a barrido periódico quedan **fuera del DSL** | Son mecánica del generador, la misma frontera que trazó 2.8. La cadencia es un parámetro del generador (`deadline.<entidad>.<estado>.every`) |
| D7 | El arnés gana `ageForDeadline(entidad, id, segundos)`: retrasa `since` en la base, con las sentencias en `keel-core/gen` | Un escenario no puede esperar 15 minutos. Es el mismo patrón que `ageForReconciliation` |
| D8 | El `code` de `lateAction` se declara en `errors` de cada operación que saca la entidad del estado | Es contrato público, y así lo ven la matriz de cobertura y `CHK-SCEN-ERROR-UNCOVERED` sin regla nueva de escenarios |

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
| Reclamo de candidatos vencidos, en las dos ramas | build | `db-check` / `doc-check` (keel-spring: `claim-check`) (DL-4 a DL-6) |
| Clave del plazo con su gradiente por perfil, y la cadencia | build | pruebas de configuración (`service-parameters` ya lo tiene) |
| `ageForDeadline` en el arnés | build | `harness-check` / `doc-harness-check` |
| Handler de `by` (efectos, eventos) | agente | gate `infra/check-deadlines.sh` + escenarios |
| Nota del handler: qué reclama, qué aplica, qué no hacer | build (neutral) | `test/deadlines.test.js` en keel-core, la misma en los cuatro |

### Los casos que se miden

- **DL-1**: dentro del plazo, la transición sale. **DL-2**: en el instante exacto del vencimiento (D3), se rechaza con
  el `code`. **DL-3**: la transición hacia `to` pasado el plazo sale (es la del barrido).
- **DL-4**: el reclamo devuelve solo lo vencido y en el estado de origen. **DL-5**: dos réplicas no reclaman la misma
  fila. **DL-6**: una fila que salió del estado entre la lectura y el reclamo no se reclama.
- Con `allow`, DL-2 pasa a «sale», y se mide igual.

Sabotajes: `dl-boundary` (`<` en vez de `<=`), `dl-no-guard` (el guard no se emite), `dl-wrong-field` (cuenta desde
otra marca) y `dl-any-state` (el reclamo olvida el estado). Cada uno tiene que caer en exactamente sus casos.

## Incrementos

| # | Qué | Puerta |
|---|---|---|
| 0 | Medir: el reloj inyectable en el dominio de los cuatro (si un generador no lo tiene, se añade aquí), y cómo escribe hoy `stock-reservation` su caducidad | Nota en este plan con lo medido |
| 1 | keel-core: schema, `crossrefs.js`, `checks.js`, mutaciones, la clase de huecos, la revisión, `docs/dsl/domain.md` y el historial de `dsl-reference.md`. DSL 2.26 sustituye a 2.25 | `npm test` de keel-core y `design-matrix` sin ids sin mutación |
| 2 | `keel-core/gen/deadlines.js`: el guard como datos, el reclamo, las sentencias del arnés, la nota del handler, las filas del gate y los casos DL | Sus pruebas, y `buildModel` de todas las fixtures sin cambios |
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
