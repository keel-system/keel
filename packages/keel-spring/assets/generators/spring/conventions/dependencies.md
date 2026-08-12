# Convención: dependencias con otros servidores (capa `dependencies`)

Cómo se materializa en Spring la capa `dependencies` del diseño. Vocabulario: el DSL habla de
*necesidades* (`needs`) y *réplicas* (`replica`); aquí eso es un **read model** con su **projector** y su
**reader**, que es como se llama en esta arquitectura.

La capa tiene **dos mitades** y ninguna se puede ignorar:

| Mitad | Qué declara | Dónde aterriza |
|---|---|---|
| `needs` | **leo un dato** que es de otro servidor | read model (réplica) o llamada al puerto del cliente |
| `activations` | **le pido trabajo** a otro servidor | la llamada o el evento que el handler dispara |

`usedBy` (de un `need`) y `triggeredBy` (de una activación) son el **único enlace del DSL entre un
caso de uso y el trabajo que delega**. `build` los traduce a inyección + nota en el stub del handler:
si el stub de tu operación menciona una dependencia, es obligación tuya, no contexto.

## Qué genera `build` y qué escribe el agente

| Artefacto | Quién |
|---|---|
| `application/projection/<E>Projector.java` | **build** — esqueleto del upsert (búsqueda, ordenación, ramas, `save`) |
| `<E>.projectionOf(...)` y `<E>.applySnapshot(...)` | **agente** — el dominio no tiene setters; el Projector deja sus firmas exactas en un TODO |
| `application/projection/<E>Reader.java` | **build** — lectura con la política `onMiss` (con TODOs) |
| Entidad `<E>`, `<E>Jpa`, `<E>Repository` + adaptador | **build**, desde `domain`/`persistence` |
| Puerto `<C>Client`, adaptador RestClient, mapper ACL | **build**, desde `http-clients` |
| Inyección del `<C>Client` / `<E>Reader` en los handlers de `usedBy` y `triggeredBy` | **build** |
| Cuerpo del fallback del circuit breaker con `onFailure: fail` / `ignore` | **build**, desde la activación |
| `ProcessedEvent` + `IdempotencyGuard` | **build**, desde `messaging.subscriptions` |
| `<Evento>Listener` | **agente**, según la skill del broker |
| Cuerpo de `hydrate(...)` en el Reader | **agente** |
| La invocación en sí desde el handler (`on-demand`, activación) | **agente** — build inyecta y lo dice en la nota |
| El resultado degradado de `onMiss: degrade` / `onFailure: degrade` | **agente** (es lógica de negocio) |

Una necesidad con `strategy: on-demand` **no genera clases nuevas**: se resuelve invocando el puerto
`<C>Client` que ya existe —y que `build` ya inyectó en el handler— desde la operación que la declara
en `usedBy`.

## El cableado canónico (regla inviolable)

```
<Evento>Listener  →  IdempotencyGuard  →  UseCaseMediator
                                              ↓
                          handler de la operación de proyección (internal: true)
                                              ↓
                                       <E>Projector
                                              ↓
                                   <E>Repository (puerto)
```

**El listener nunca llama al Projector directamente.** Sería una segunda puerta de entrada al dominio
saltándose el mediator —que `constitution.md` prohíbe— y duplicaría la lógica de idempotencia. La
suscripción ya declara `triggers`, así que la operación de proyección existe: úsala.

## Reglas

1. **Una proyección solo se escribe desde su Projector.** Ningún handler de negocio la modifica. Si una
   operación propia necesita cambiar ese dato, el dato no era del proveedor: es un error de diseño y se
   corrige en el spec.
2. **Una proyección nunca es fuente de verdad.** No se expone tal cual en un DTO público, no se le
   aplican invariantes del dominio propio y no se valida contra reglas nuestras: sus invariantes las
   garantiza el proveedor. Si el cliente necesita esos datos, se le devuelven como parte de la
   **respuesta propia**, y eso ya no es una instrucción en prosa: el diseño lo declara con
   `needs.<n>.exposedAs`, y entonces `build` pone el campo en el `<Op>ResponseDto` y el
   `<Entidad>ApplicationMapper` lo exige **por parámetro** — el compilador no deja olvidarlo. Sin
   `exposedAs` el dato no sale del servicio, y pedirlo para descartarlo es un error de diseño.
3. **ACL siempre.** La respuesta del proveedor se mapea con el `<C>Mapper` del cliente a la entidad de
   dominio; el record wire nunca cruza a `domain` ni a `application`.
4. **Idempotencia por construcción.** El upsert por `keyField` hace que una reentrega no corrompa la
   copia. El `IdempotencyGuard` es la primera red; el upsert, la segunda. Y esa segunda red importa
   más de lo que parece: la primera **caduca**. El guard recuerda los mensajes procesados durante
   `processed-event.purge.retention-days` (default 14 días, en `parameters/`), y una reentrega
   posterior a ese plazo vuelve a pasar. Con un upsert eso es inocuo; en un handler que **suma** en
   vez de fijar, no lo sería — ahí la guarda que vale es la del dominio, que no tiene ventana.
   Como el dominio está encapsulado (sin setters, ver `domain-modeling.md`), el Projector no construye
   ni muta la entidad directamente: llama a `<E>.projectionOf(...)` para crearla y a
   `existing.applySnapshot(...)` para actualizarla. **Esos dos métodos los escribes tú**, con la firma
   exacta que el TODO del Projector indica. `applySnapshot` es un asignador plano: la copia no lleva
   invariantes propias, las suyas las garantiza el proveedor.
5. **Ordenación.** Si el payload trae un instante del hecho, el Projector lo compara antes de escribir
   para que un evento viejo no pise a uno nuevo. Esto es responsabilidad del generador: el DSL no
   declara umbrales de antigüedad a propósito.
6. **Cuidado con la transacción en la hidratación.** El `UseCaseMediator` abre la transacción al
   despachar (read-only en queries, escritura en commands), así que un `onMiss: fetch` invocado desde
   un handler ocurre **dentro** de ella y la mantiene abierta durante todo el timeout de la llamada.
   Desde una query es aceptable; desde un command que escribe, resuelve el dato **antes** de despachar
   el command. Si eso no es posible, la necesidad probablemente debería ser `strategy: on-demand` en el
   diseño: dilo en el reporte en vez de arreglarlo en el código.
7. **No dupliques resiliencia.** El retry y el circuit breaker viven en el adaptador del cliente
   (resilience4j, desde `http-clients`). El Reader no los repite.
8. **El encargo sale DESPUÉS de la guarda de estado.** Una activación por HTTP no participa de la
   transacción: si la llamada sale antes de que el agregado valide y la guarda del `lifecycle`
   rechaza el cambio, el rollback revierte la fila y **el trabajo queda encargado** en el otro
   servidor, donde nadie lo va a deshacer. El orden es cargar → aplicar la transición y las
   invariantes → llamar → confirmar. Build escribe la nota `ORDEN de los efectos` en el stub de
   todo handler que tenga transición declarada y activación saliente, precisamente porque el
   camino de menor resistencia es el contrario: llamar primero y mutar después «cuando ya se sabe
   que salió bien». Regla en `constitution.md` § Consistencia y transacciones.

   Con el orden correcto queda una ventana irreducible —transición aplicada, llamada hecha, commit
   que falla— y esa **no** se cierra con código: es exactamente lo que una `compensations` del
   diseño existe para cubrir. Si el diseño no la declara, es hueco de diseño y va al reporte, no
   un `try/catch` inventado en el handler.

## `onMiss` → código

| `action` | Qué genera build | Qué completa el agente |
|---|---|---|
| `fetch` | `byKey()` = repositorio `.or(() -> hydrate(...))` | El cuerpo de `hydrate`: invocar el puerto, mapear con el ACL, `save`, devolver |
| `fail` | `byKey()` = repositorio `.orElseThrow(new <Code>Error(...))` | Nada; la excepción ya existe (`exceptions.js` la genera del catálogo de `use-cases`) |
| `degrade` | `byKey()` devuelve `Optional<E>` | El resultado degradado en quien llama, siguiendo la prosa de `degradedTo` |

Con `fail`, si el mismo `code` se declara con `http` distinto en dos operaciones, la excepción recibe el
status por constructor: el Reader ya lo pasa.

Con `degrade`, el resultado debe ser **distinguible por el cliente** de una respuesta normal. Un dato
plausible pero falso es peor que fallar.

## `activations`: el trabajo que se delega

Una activación es una operación tuya pidiéndole a otro servidor que haga algo. El canal ya existe
(`via.client` → un puerto de `http-clients`; `via.publishes` → un evento propio de `messaging`), así
que lo único que hay que escribir es **la invocación**, en el handler de cada operación de
`triggeredBy`. El stub la lleva anotada con el `effect` textual del diseño.

### `via.publishes` — se delega publicando un evento

No hay nada que llamar: el agregado emite el evento con `raise(...)` dentro de su método de negocio
y el adaptador de repositorio lo drena al persistir. **El handler no publica nada** y no espera
respuesta —publicar no devuelve resultado—, así que estas activaciones nunca declaran `onFailure`.
Que llegue al proveedor es cosa de la garantía de entrega (`reliability: outbox`), no tuya.

### `via.client` — se delega llamando

El handler invoca el puerto que `build` ya le inyectó. `awaits` dice qué hacer con lo que vuelve:

| `awaits` | Qué significa en el código |
|---|---|
| `outcome` | El resultado condiciona el desenlace de tu operación: **usa el cuerpo de la respuesta**. Que la llamada no falle no basta |
| `acknowledgement` | Basta con que el proveedor acuse recibo; no interpretes el cuerpo |
| `nothing` | No se espera nada de vuelta — pero la llamada **sigue siendo síncrona** y ocurre dentro de la transacción (ver la regla 6) |

### `onFailure` → código

Es la simétrica de `onMiss`, y vive en el **fallback del adaptador**, no en el handler:

| `action` | Qué genera build | Qué completa el agente |
|---|---|---|
| `ignore` | Cuerpo del fallback: `log.warn` + resultado neutro | Nada. No lo reintentes ni lo captures en el handler |
| `fail` | Cuerpo del fallback: `throw new <Code>Error(...)` | Nada; la excepción ya existe. **No la conviertas en otra cosa** en el handler |
| `degrade` | TODO con la prosa de `degradedTo` citada | El resultado degradado, distinguible por el cliente |

Si **varias** activaciones salen por la misma llamada, build no elige por ti: deja el TODO
enumerándolas. Dos políticas de fallo sobre un único método es un conflicto del diseño — dilo en el
reporte en vez de inventarte una.

El cuerpo vive en `<call>Unavailable(..., Throwable)`, y lo que llega ahí está **acotado**: el
circuito abierto, un fallo de transporte, un 5xx, un status desconocido y un 4xx. Cada uno entra
por su sobrecarga `<call>Fallback(..., <Excepción>)`, y lo que ninguna acepta —un NPE, un
`ClassCastException`, un cuerpo que no deserializa— resilience4j lo **relanza**. Eso no es un
hueco: es la función. Un fallback que declaraba `Throwable` registraba cualquier defecto propio
como «el proveedor no está disponible», y con `onFailure: fail` lo convertía en el error de
indisponibilidad del diseño — el síntoma acusaba al tercero y la causa estaba en casa.

## El barrido corre en todas las réplicas

`@Scheduled` no es «una vez en el clúster», es **«una vez por instancia»**. Con N réplicas, el barrido de
una reconciliación consulta «los atascados», las N obtienen **las mismas filas** y cada una actúa sobre
ellas. Lo mismo vale para cualquier operación con `schedule` que *haga* algo con lo que encuentra; las
purgas que genera `build` quedan fuera porque borrar lo caducado es idempotente por forma.

Lo que engaña es que parece que ya hay protección, y solo la hay a medias:

| Qué se repite | ¿Lo frena algo? |
|---|---|
| La transición del agregado | **Es una carrera, no una serialización.** Las N leen antes de que ninguna confirme, así que todas pasan el guard y todas actúan. Con `@Version` solo una escribe — pero las demás ya hicieron su trabajo externo |
| La llamada al proveedor | Sí: la **idempotencia saliente** (`OutboundIdempotency`), si el diseño la declara. Es la red real |
| Reencargar **publicando un evento** | **Nada.** Cada réplica hace su propio `raise` y estampa un `metadata.eventId` distinto: para el consumidor son N hechos y su `processed_event` no los deduplica |

**La regla: reclamar, no leer.** La consulta del barrido no pide los candidatos, se los **lleva**, en
lotes acotados, de modo que cada réplica trabaja sobre un conjunto disjunto y el paralelismo pasa de
problema a ventaja. No hace falta infraestructura nueva.

Pero *cómo* se los lleva no es indiferente, porque la llamada al proveedor va **en medio** (ver el orden,
abajo). Hay dos formas de reclamar y aquí solo sirve una:

| Forma | Qué aísla a las réplicas | ¿Sirve para el barrido? |
|---|---|---|
| **Lock pesimista** — `SELECT … FOR UPDATE SKIP LOCKED` | El lock de fila, que **vive lo que vive la transacción** | **No.** Obligaría a sostener la transacción durante la llamada al proveedor: una conexión del pool retenida por la latencia de un tercero |
| **Marca persistida** — `UPDATE … SET <marca>` o `findAndModify` | La marca, que **sobrevive al commit** | **Sí.** La transacción del reclamo dura lo que dura un `UPDATE` y la llamada va fuera |

**El barrido reclama con marca persistida.** Y precisamente porque la marca sobrevive al commit,
sobrevive también a la muerte de la réplica que la puso: necesita **caducidad**, o un proceso que muera
entre el reclamo y la llamada retiene el candidato para siempre. Pasado el plazo, vuelve a ser elegible.
Regla para dimensionarlo: **`claim-timeout` > tamaño del lote × timeout de la llamada**, con holgura; por
debajo, dos réplicas actúan sobre el mismo candidato, que es lo que el reclamo venía a evitar.

El ejemplo vivo está en este mismo proyecto y es exactamente esta forma: la rama **documental** de
`OutboxRelay` (`claimPending()`, con `outbox.relay.claim-timeout-ms`). La rama **relacional** del relay
usa lock pesimista y **no es el modelo a copiar aquí**: allí lo que ocurre dentro de la transacción es la
entrega al broker, que es corta y local; en el barrido es una llamada a otro servidor. La técnica
concreta de tu motor está en la skill `keel-spring-database` o `keel-spring-mongodb`,
`references/read-queries.md`.

Un **lock distribuido** (ShedLock, un advisory lock) solo compensa cuando el barrido tiene que ser único
por negocio —consolidar un informe, emitir un fichero—: serializa a una instancia y desperdicia el resto.
Para un barrido de reconciliación es la respuesta equivocada a la pregunta correcta.

### El orden dentro del barrido

Con marca persistida hay **dos** commits, y confundirlos es de donde sale el error más caro de esta
página. En orden:

1. `UPDATE … SET <marca> = now WHERE <candidato>` + **commit**. Este commit no es opcional ni prematuro:
   es lo que hace el reclamo visible a las demás réplicas. Sin él no aísla nada.
2. La llamada al proveedor, **fuera de toda transacción**.
3. La transición del agregado a su estado final + **commit**.

El orden de 2 y 3 no es preferencia: decide si hay red.

| Orden | Si el proceso muere en medio |
|---|---|
| Reclamar, **actuar**, confirmar el desenlace | La entidad sigue reclamada y, al caducar la marca, la siguiente pasada repite la llamada. La absorbe la **idempotencia saliente**. Tiene red |
| Reclamar, confirmar el desenlace, **actuar** | La entidad queda resuelta y el trabajo vivo en el proveedor: un huérfano que no detecta nadie. **No tiene red** |

Es el mismo razonamiento que decide los dos órdenes del `IdempotencyGuard` (`alreadyProcessed`+`record`
frente a `tryRecord`), aplicado a otro sitio: se prefiere repetir algo absorbible a perder algo que nadie
va a echar de menos.

#### El híbrido que hay que evitar

Reclamar con `SKIP LOCKED` y **commitear antes** de llamar al proveedor. Parece la forma (1)(2)(3) de
arriba, y no lo es: al confirmar, el lock se suelta y no queda nada en la fila que diga que alguien la
tomó. Las N réplicas vuelven a verla en la pasada siguiente —o en la misma, si sus relojes coinciden— y
todas actúan. Es el fallo exacto que el reclamo venía a evitar, con la apariencia de estar resuelto.

Merece nombre propio porque es el único de los tres caminos que **ningún gate distingue solo**:
`infra/check-idempotency.sh` ve el patrón del reclamo y su cota, no dónde cae el commit. Que el barrido
sea correcto en este punto depende de quien lo escribe y de quien lo revisa.

### Varios barridos en el mismo proceso

El eje anterior es entre réplicas; este es dentro de una. Con hilos virtuales activados, los `@Scheduled`
corren en un `SimpleAsyncTaskScheduler` de **concurrencia no acotada**: nada los serializa, así que los
que compartan cadencia se disparan a la vez. Y compartirla es lo natural — «cada cinco minutos» es la
declaración obvia para todos.

Lo que se amontona cuando coinciden **no es la base de datos**: con reclamo persistido cada uno toma su
conexión para un `UPDATE` y la suelta. Son las **llamadas salientes**, todas empujando a sus proveedores
en el mismo segundo.

Por eso `build` reparte el **campo de segundos** del cron, que es suyo: el diseño declara cinco campos y
Spring quiere seis. Con tres barridos declarados «cada cinco minutos» salen en los segundos 0, 20 y 40 de
ese minuto. La cadencia declarada no cambia, solo la fase. **Igualarlos a 0 «por limpieza» deshace el
reparto** — el javadoc del `<Servicio>Scheduler` lo advierte donde se ve.

Es una mitigación, no una garantía: reparte el arranque. Dos barridos que duren más que su separación se
solapan igual, y contra eso el segundo inicial no puede nada. Acotar la concurrencia del scheduler
(`concurrency-limit`) sí los serializaría, pero es **global**: se lo aplicaría también al `OutboxRelay`,
que corre cada segundo, y un barrido largo pasaría a retrasar la entrega de eventos.

### La carrera con el camino feliz

Mientras el barrido reclama y actúa, puede llegar el evento de desenlace. Los dos van a mover la misma
entidad, y **el guard del agregado es el árbitro**:

- Gana el barrido → el listener intenta su transición y la entidad ya salió de ese estado: se rechaza.
- Gana el listener → el barrido encuentra el candidato ya resuelto: se rechaza.

**En los dos sentidos el rechazo es el desenlace normal, no un fallo.** El coste de confundirlo es
concreto y confuso de diagnosticar: si el listener lanza excepción, `onFailure.retry` lo reintenta y
acaba en la DLQ un mensaje perfectamente válido, por una carrera que se resolvió **bien**. Alguien lo
leerá como un incidente. El listener confirma el mensaje sin reintentar; el barrido pasa al siguiente
candidato sin registrarlo como error.

Queda una ventana que ningún mecanismo propio cierra: que el proveedor confirme y procese la cancelación
en orden inverso. Eso se acota con un umbral generoso, no con código.

## La deduplicación de consumo tiene ventana

Vale para **toda** suscripción, no solo para las que alimentan una réplica (donde ya lo dice
la regla 4). El `IdempotencyGuard` recuerda los mensajes procesados durante
`processed-event.purge.retention-days` —14 días por defecto, en `parameters/`—, y la purga
retira lo anterior. La garantía real es **«no se procesa dos veces dentro de la retención»**,
no «nunca jamás».

Cuál es su consecuencia depende de lo que haya debajo, y es la misma línea que separa los dos
órdenes del guard:

- **Con guarda de dominio** (la operación declara `transitions`): inocuo. La transición
  rechaza la repetición y el agregado no caduca; la deduplicación solo ahorra trabajo.
- **Sin ella** (`tryRecord`, un contador o un asignador): pasada la retención, el efecto se
  vuelve a aplicar. Ninguna configuración lo arregla — subir la retención mueve la fecha, no
  la quita.

Por eso, cuando el negocio necesita que un hecho **no** pueda repetirse por muy tarde que
reaparezca, el mecanismo correcto no es esta deduplicación sino una **guarda de dominio**: un
estado, una marca o una clave natural que haga la segunda aplicación imposible por sí sola.
Eso se decide en el diseño (`transitions` en la operación disparada, o un invariante del
agregado), no en el listener. Si al escribirlo ves que hace falta y no está, es un
`designGap`, no algo que se resuelva con un parámetro.

## Antipatrones

- Llamar al Projector desde el listener (salta el mediator y el guard).
- Hacer la llamada HTTP de hidratación dentro de la transacción de escritura de un command.
- Reintentar respuestas `4xx` del proveedor: un `404` significa que el recurso no existe, no que haya que
  insistir.
- Rehidratar en bucle ante `degrade`: si la política es degradar, no se llama al proveedor.
- Escribir la proyección desde un handler de negocio "porque es más rápido".
- Copiar campos del proveedor que ninguna operación de `usedBy` lee.
- Exponer la entidad réplica como un recurso REST propio.
- Publicar el evento de una activación desde el handler en vez de con `raise(...)` en el agregado.
- Capturar en el handler la excepción que lanza un fallback `onFailure: fail` para "seguir igual":
  el diseño dice que la operación falla si el proveedor no responde.
- Reintentar en el handler una activación `onFailure: ignore` — el fallback ya la absorbió.
- Añadir una sobrecarga `Throwable` o `Exception` al fallback para "que no se escape nada": lo que
  se escapa es tu bug, y taparlo ahí es lo que mantuvo uno meses disfrazado de caída ajena.
- Mover el `fallbackMethod` del `@Retry` al `@CircuitBreaker`: el retry es el aspecto externo, y
  con el fallback dentro no reintenta nunca (el circuito le devuelve un valor normal).
- Ignorar el cuerpo de la respuesta en una activación `awaits: outcome`.
