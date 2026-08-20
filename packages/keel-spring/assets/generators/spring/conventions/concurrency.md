# Este servicio corre con varias instancias

Nada del diseño lo dice, y por eso hay que decirlo aquí: el servidor generado se despliega **replicado**.
Todo lo que sigue vale también con una sola instancia —el servidor es multihilo—, pero con réplicas deja
de ser un caso raro y pasa a ser el normal: dos peticiones idénticas, dos entregas del mismo mensaje o
dos barridos coincidiendo en el tiempo, en procesos distintos que no comparten memoria.

Lo único que los coordina es el **almacén**. Ninguna guarda que viva en la JVM —un `synchronized`, un
`ConcurrentHashMap`, una comprobación en el handler— vale nada entre réplicas: la otra instancia no la ve.
Si escribes una, el código pasa las pruebas en tu máquina y falla en cuanto haya dos pods.

El barrido de reconciliación tiene su propia sección, más larga, en
[`dependencies.md` § El barrido corre en todas las réplicas](dependencies.md) — reclamar en vez de leer,
el orden dentro del barrido y la carrera con el camino feliz. No se repite aquí.

## Quién arbitra cada mecanismo

| Mecanismo | Árbitro | Qué tienes que hacer tú |
|---|---|---|
| Reentrega del broker (`processed_event`) | La clave primaria `(handler_id, event_id)` / el `_id` del documento | Llamar al `IdempotencyGuard` en el orden que dice el javadoc de tu listener. Nada más |
| Idempotencia de comando (`idempotency_record`) | La clave primaria `(operation_scope, idempotency_key)` | Consultar el store antes y guardarlo dentro de la misma transacción que el agregado |
| Entrega del outbox | El marcado de la fila entregada, dentro de la transacción del relay. El reparto entre réplicas lo añade `SKIP LOCKED` **donde el motor lo tiene** (con H2 no, y `build` lo avisa) | Nada: el relay es de `build`. Solo implementas `OutboxDispatcher` |
| Reintento contra un proveedor (`OutboundIdempotency`) | El proveedor, con la clave que le mandamos | Pasar la cabecera que `build` ya cablea |
| Compensación | **Ninguno propio**: la toma prestada de la transición del agregado o del `processed_event` | Comprobar cuál de las dos te toca — está en la nota del stub |
| Barrido de una cola | El **UPDATE condicional** que saca la fila del estado de partida: 1 fila afectada = es mía | Llamar a `claimFor<Operación>(batchSize)` del puerto, que `build` genera cuando el diseño declara el barrido |
| Reconciliación | La marca persistida en `reconciliation_claim`, que **caduca** | Llamar a `claimFor<Barrido><Activación>()` del puerto. Si `build` avisó de que no pudo generarlo, escribirlo con la misma forma — ver `dependencies.md` |
| Purga de lo caducado (`processed_event`, `idempotency_record`, `reconciliation_claim`) | **Ninguno, y no hace falta**: borrar dos veces la misma fila da el mismo resultado que borrarla una | Nada |

La fila de la compensación es la que hay que mirar dos veces: es el único mecanismo sin garantía propia.

**Por qué el reclamo cambia de forma entre esas filas, que no es capricho.** Reclamar son siempre dos
cosas: *llevarse* la fila —una escritura condicional, atómica en los seis motores— y *elegir* a cuáles
tirarle, que es lo único que depende del dialecto. Lo que decide cuál de las dos formas de marca se usa
no es el motor sino **si hay una llamada externa en medio**: el relay del outbox entrega al broker y su
transacción es corta, así que le basta el lock; el barrido de reconciliación llama a un proveedor, y un
lock solo aísla mientras dura su transacción — por eso su marca es una fila que sobrevive al commit y
caduca sola.

**Subir la concurrencia del listener no añade nada a esta tabla.** Con Kafka,
`spring.kafka.listener.concurrency` (parametrizada en `parameters/<perfil>/kafka.yaml`) multiplica los
hilos consumidores **dentro de una instancia**, así que dos entregas del mismo mensaje pueden coincidir
en el mismo proceso en vez de en dos pods. Cambia dónde ocurre la carrera, no quién la arbitra: sigue
siendo la clave primaria de `processed_event`. Que la concurrencia venga de más réplicas o de más hilos
es indistinguible para el store, que es justo la propiedad que hace que no haya código nuevo que
escribir — y la razón por la que un `synchronized` alrededor del listener sigue sin servir de nada:
protegería una de las instancias contra sí misma y ninguna contra las demás.

## La ventana de la clave de idempotencia

El contrato del reintento normal es *reproducir*, no rechazar: la segunda petición con la misma clave
encuentra el registro ya commiteado y devuelve la respuesta de la primera sin ejecutar nada.

Hay una ventana estrecha en la que eso no se puede cumplir: la primera petición **aún no ha commiteado**
—y con réplicas, normalmente ni siquiera está en este proceso—. Ahí la segunda pierde la carrera de la
clave primaria y recibe **`409 IDEMPOTENCY_KEY_IN_PROGRESS`**. No es un error de nadie: su transacción
revierte entera, así que de las dos peticiones idénticas se ejecutó exactamente una, y el cliente
reintenta. Ese `code` es contrato público: aparece en los escenarios y no se cambia.

**El registro guarda `resource_id`, no el cuerpo de la respuesta**, y eso tiene una consecuencia que te
toca a ti: reproducir la respuesta del reintento es **releer el recurso** por su id, no devolver una copia
congelada. Si el recurso cambió entre la primera petición y el reintento, la respuesta reproducida refleja
el estado actual. Es deliberado —congelar el cuerpo obligaría a versionar una representación que el
contrato dice que se lee por la API—, pero no lo descubras en producción.

## Los `@Scheduled`

Cada método `@Scheduled` corre **en todas las réplicas**, a la vez. Los que genera `build` están
preparados para eso:

- Las purgas (`processed_event`, `idempotency_record`, `outbox_event`) borran por rango de fecha: N
  réplicas ejecutando el mismo `DELETE` es ruido, no daño. Y cada tabla lleva su índice sobre la columna
  del barrido, así que no son recorridos completos compitiendo entre sí.
- El `OutboxRelay` **reclama** su lote (lock de fila con `SKIP LOCKED` en el modelo relacional; marca
  `claimed_at` con caducidad en el documental), así que las réplicas trabajan sobre conjuntos disjuntos.
  El `SKIP LOCKED` solo se emite **donde el motor lo tiene** —con H2 no, y `build` lo dice en un aviso—:
  sin él la entrega sigue sin duplicarse, porque quien lo impide es el marcado de la fila dentro de la
  misma transacción, pero las réplicas compiten por la misma página en vez de repartírsela.
- El barrido de reconciliación reclama con `reconciliation_claim`, una marca que sobrevive al commit y
  caduca. `build` genera la tabla, su tienda y el método del puerto — ver más abajo.

**Cualquier `@Scheduled` que escribas tú no hereda nada de eso.** Si actúa sobre lo que encuentra, tiene
que reclamar. Y no es una recomendación: correr replicado no es una decisión de despliegue que el diseño
pueda declinar, así que **todo barrido se escribe multi-instancia o está mal**.

`build` ayuda hasta donde puede. Cuando el diseño declara un barrido que saca filas de una **cola** —el
estado inicial de la entidad, al que ninguna transición lleva—, el puerto del repositorio trae ya el
método de reclamo:

```java
List<Job> claimForDrainJobs(int batchSize);   // UPDATE condicional; devuelve SOLO lo que se llevó ESTA réplica
```

Llámalo y actúa sobre lo que devuelve, **fuera** de su transacción. Lo que no vale es leer con un finder
y marcar después: entre la lectura y la marca las N réplicas ya se llevaron las mismas filas, y con un
efecto que no se puede retirar —un correo, un cobro— eso son N efectos.

Y cuando el barrido es el `reconciledBy` de una activación, el reclamo también viene generado, pero con
**otra forma**, porque ahí la llamada al proveedor va entre reclamar y actuar:

```java
List<Reservation> claimForReconcileReservationsReserveStock();  // sin batchSize: los tres números salen de parameters/
```

Marca una fila en `reconciliation_claim` —activación + entidad— que **sobrevive al commit y caduca**, en
vez de mover el lifecycle: el estado de espera es justo lo que el barrido busca, y cambiarlo antes de
saber el desenlace sería mentir sobre lo que pasó. Nada de eso se inventa: la cota temporal sale del
`unansweredAfterSeconds` que declara el diseño y el candidato se elige por el campo que la activación
declara en `awaitingSince` — el que dice desde cuándo espera.

Cuando el barrido saca filas de un estado **en vuelo** sin ser una reconciliación declarada (rescatar lo
que otra réplica dejó a medias), `build` **no** genera el reclamo y lo dice en un aviso: un rescate
necesita una cota temporal —«lleva más de N minutos ahí»— que vive en la prosa de `rules` y que `build`
no puede inventar. Sin esa cota, «rescatar» es arrancarle el trabajo de las manos a quien lo está
haciendo ahora mismo. Ese lo escribes tú, con la cota. Lo mismo si el aviso dice que no pudo generar el
reclamo de una reconciliación (falta la marca de espera, o hay dos entidades esperando).

Verificado por `infra/check-idempotency.sh`: familia `reconciliation` para los barridos declarados como
`reconciledBy`, y familia `sweepClaim` para todos los demás.

Lo que **sí** hace `build` por ti en el barrido de una reconciliación es sacarlo de la transacción: el
`<Servicio>Scheduler` lo despacha con `dispatchWithoutTransaction`, porque su garantía es un orden de
commits —reclamar y confirmar, llamar al proveedor fuera de toda transacción, confirmar el desenlace— y
una transacción abarcadora los funde en uno. Ver `dependencies.md § El orden dentro del barrido`.

Ojo a la diferencia, que ya no es «tiene gate o no lo tiene» sino cuánto hace `build`: el barrido
declarado como `reconciledBy` de una activación sale además de la transacción (`dispatchWithoutTransaction`)
porque su garantía es un orden de commits. El barrido que solo despacha una cola sigue corriendo en una
transacción única: si de verdad llama a un tercero en medio, eso es lo que falta declarar en el diseño, y
es un hallazgo para el reporte. Lo que **no** cambia entre los dos es el reclamo — los dos lo necesitan, y
los dos lo tienen verificado.

## El outbox entrega al menos una vez

No es un defecto del relay: si el proceso muere entre la entrega al broker y el commit que marca la fila,
la siguiente pasada la entrega otra vez. **El duplicado lo absorbe el `processed_event` del consumidor**,
que muy probablemente sea otro servicio. Por eso el `messageId` que estampas es contrato, no un detalle
de implementación: es lo único con lo que el de enfrente puede deduplicar.

En el modelo documental hay una segunda fuente de duplicados, y es configurable: si
`outbox.relay.claim-timeout-ms` queda por debajo de la latencia peor del broker, una réplica lenta ve
caducar su reclamo mientras sigue entregando y otra se lleva la misma fila. Sale de `parameters/`.

## Lo que ningún gate cubre

Sé honesto sobre el borde de la red:

- Los escenarios `FL-*` ejercitan carreras **dentro de una instancia** (dos peticiones, dos entregas). Es
  representativo porque el árbitro es el mismo, pero no es lo mismo.
- Las carreras **entre schedulers de réplicas distintas** —relay contra relay, barrido contra barrido— no
  las ejercita nada: dentro de una instancia, `@Scheduled` con `fixedDelay` y el pool por defecto las
  serializa por construcción. Su único gate es `infra/check-idempotency.sh`, que es **estructural**:
  comprueba que el patrón esté escrito, no que el algoritmo sea correcto.

Lo que **sí** ejercita un escenario, y conviene no confundirlo con lo anterior: que el outbox no pierde
el evento cuando el broker no está. El flujo detiene el broker, comprueba que la mutación responde igual
y que el canal sigue vacío, y al levantarlo afirma que el evento llega exactamente una vez
(`conventions/integration-tests.md § Outbox: el canal indisponible`). Eso cubre la entrega y el marcado
de la fila. Lo que sigue sin cubrir es el **reclamo concurrente de la misma fila entre dos relays**, que
es carrera entre réplicas y cae en el punto de arriba.

Ahí, la revisión humana del reclamo es la última línea. Si dudas de uno, dilo en `remaining` en vez de
darlo por bueno porque el script salió verde.
