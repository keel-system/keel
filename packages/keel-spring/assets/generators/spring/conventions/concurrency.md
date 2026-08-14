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
| Entrega del outbox | El lock de fila del reclamo (`SKIP LOCKED`) o la marca `claimed_at` con caducidad | Nada: el relay es de `build`. Solo implementas `OutboxDispatcher` |
| Reintento contra un proveedor (`OutboundIdempotency`) | El proveedor, con la clave que le mandamos | Pasar la cabecera que `build` ya cablea |
| Compensación | **Ninguno propio**: la toma prestada de la transición del agregado o del `processed_event` | Comprobar cuál de las dos te toca — está en la nota del stub |
| Reconciliación | **Ninguno**: el reclamo lo escribes tú | Ver `dependencies.md` |

Las dos últimas filas son las que hay que mirar dos veces: son los únicos mecanismos sin garantía propia.

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

**Cualquier `@Scheduled` que escribas tú no hereda nada de eso.** Si actúa sobre lo que encuentra, tiene
que reclamar. Está verificado por `infra/check-idempotency.sh`, familia `reconciliation`.

Lo que **sí** hace `build` por ti en el barrido de una reconciliación es sacarlo de la transacción: el
`<Servicio>Scheduler` lo despacha con `dispatchWithoutTransaction`, porque su garantía es un orden de
commits —reclamar y confirmar, llamar al proveedor fuera de toda transacción, confirmar el desenlace— y
una transacción abarcadora los funde en uno. Ver `dependencies.md § El orden dentro del barrido`.

Ojo al criterio, que sale del diseño y no de lo que hace el código: es barrido lo que alguna activación
declara como su `reconciledBy`. Una operación con `schedule` que actúe sobre lo que encuentra **sin**
estar declarada así sigue corriendo en una transacción única — si de verdad llama a un tercero en medio,
lo que falta es el `reconciledBy` en el diseño, y eso es un hallazgo para el reporte.

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
