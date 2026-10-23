# De la evidencia al DSL (paso 3)

Qué grabación sostiene cada elemento del diseño, y con qué trampas. Una fila de `provenance.yaml` por elemento: si la columna «evidencia» no tiene nada para él, el elemento no entra.

| Evidencia | Elemento del DSL | Nivel |
|---|---|---|
| `surface.yaml → data.collections` (o tablas) e índices | `domain.entities` y sus campos; `persistence.entities` con `naturalKey` e `indexes` (un índice `unique` es una unicidad del dominio) | `measured` |
| Diff de la base de una sonda: filas que cambian juntas | `domain.aggregates` (lo que se escribe junto es un agregado) | `measured` |
| `surface.yaml → enums` (valores de una columna de estado) + las transiciones sondeadas (clase `lifecycle`) | `domain.entities.<E>.lifecycle` con sus estados y transiciones | `measured` |
| Rutas de `surface.yaml → http.routes` con su handler, y las respuestas grabadas | `use-cases.operations` (una por ruta con comportamiento propio) y `api.endpoints` | `measured` |
| 4xx grabados con su cuerpo | `use-cases.operations.<op>.errors` con su `code` y su `http` | `measured` |
| Mensajes publicados (`effects.messages`, origen `legacy`) | `emits` de la operación y los eventos de `messaging.publishing.events`, con el payload grabado | `measured` |
| `surface.yaml → broker` (colas con consumidor del legacy) + una sonda `publish` | `messaging.subscriptions` y la operación que dispara | `measured` |
| Llamadas salientes (`effects.outbound`) | `dependencies` y `http-clients`, en el modo degradado de `/keel-consume`: el contrato es el que se ve desde dentro (lo que manda y lo que lee) | `measured` el uso; **asunción** el comportamiento real del tercero (`unobserved.yaml`) |
| Correo (`effects.mail`) | `mail` (remitente, plantilla por operación) | `measured` |
| La misma sonda con cada rol y sin token (clase `authz`) | `security.access.rules`, `roles`, `permissions` | `measured` |
| Sondas de clase: concurrencia, repetición, broker caído, fallo saliente | decisiones estructurales (`decisions.yaml → structural`, con `origin`) | `measured` → `observed`/`omitted` |
| Lógica que el código tiene y el DSL solo dice en prosa | `rules` / `invariants`, con la referencia al código | `read` |
| Un `@Scheduled`, un cron, un trigger | `read` y a `unobserved.yaml`, salvo que el humano permita invocarlo | `read` |

## Base relacional (`surface.yaml → data.tables`)

El esquema que lee `introspect` es evidencia **de la base**, no del dominio: lo escribió un ORM, una migración o un DBA, con sus defaults. Cada columna dice qué guarda la base; qué exige el dominio lo dicen los flujos grabados.

| Evidencia | Elemento del DSL | Nivel |
|---|---|---|
| `columns[].type`, `precision`/`scale` | el tipo del campo; la escala del dinero sale de `numeric(p,s)` | `measured` |
| `columns[].length` | **no** es una cota del dominio por sí sola: `varchar(255)` es el default de casi todos los ORM. Solo entra como `maxLength` si una sonda la ve rechazar (y con qué código) | `read` sin sonda |
| `columns[].nullable` | la obligatoriedad **no** sale de aquí: una columna NOT NULL puede deberse a un default del ORM, y una anulable ser obligatoria por la validación de la app (anotaciones que no llegan al DDL). Obligatorio es lo que una sonda ve rechazar ausente o vacío | `measured` con sonda; `read` sin ella |
| `primaryKey` con `default nextval(…)` | el id lo genera la base. Su VALOR no es comparable: un intento fallido también consume la secuencia (se ve en `_sequences` del diff). En `contract-map.yaml`, una diferencia declarada si el regenerado usa otro tipo de id | `measured` |
| `primaryKey` de texto que manda el cliente | id asignado por el cliente: es su clave natural | `measured` |
| `unique` | `naturalKey` o un índice `unique`, con el rechazo del duplicado grabado (status y cuerpo) | `measured` |
| `indexes` con `WHERE` | un índice con `when` (unicidad condicionada al estado) | `measured` |
| `checks` de cota (`x >= 0`) | la cota del campo | `measured` |
| `checks` sobre una columna de estado, o un tipo de `types` (ENUM) | los ESTADOS del `lifecycle`, con sus nombres. Las transiciones no: solo las que una sonda `lifecycle` recorre | `measured` los estados; las transiciones, con sonda |
| `states` (columna de estado por su forma, sin CHECK ni ENUM) | los valores son `measured`; si son números, sus nombres salen del código (`read`) o de una pregunta | `measured` / `read` |
| `foreignKeys` | una relación. Si las filas se escriben juntas (diff de una sonda) y se borran en cascada, la hija es parte del agregado; si solo se referencia por id, son dos agregados. Sin diff que lo muestre, la frontera es `inferred` y no entra | `measured` con diff |
| una referencia por valor SIN clave ajena (un código en una columna de texto) | referencia entre agregados sin integridad: borrar el referido no toca a quien lo nombra. Grábalo con una sonda de borrado; es `keep` o `fix` a sabiendas | `measured` con diff |
| `onDelete: cascade`, un trigger, un procedimiento | comportamiento que vive en la base. Una sonda de borrado lo graba en el diff; si ningún flujo HTTP lo ve, el `fix` lleva `noFlow` con esa prueba | `measured` con diff |
| `_sequences` en el diff | no es un elemento del diseño: es un efecto técnico | — |

Trampas de una base relacional:

- **El esquema puede crearlo la app al arrancar** (un ORM con `ddl-auto`, `synchronize` o equivalente): no hay migraciones que leer y reiniciar la app devuelve la base a su seed. El esquema del diseño sale de la introspección y de los flujos.
- **Una lista sin `ORDER BY` no tiene orden**, aunque dos grabaciones coincidan. Si repetir la misma sonda cambia el orden de una colección de la respuesta, compárala como conjunto y no afirmes orden.
- **El seed también es evidencia**: los datos de partida (un `import.sql`, un `data.sql`, unas migraciones con `INSERT`) son `read`, y lo que se ve de ellos en las grabaciones, `measured`.

## Trampas medidas en el incremento 1 (RealWorld y Sock Shop)

- **El framework añade superficie.** Spring Data REST expone `PUT`, `PATCH`, `DELETE` y búsquedas que nadie escribió; actuator abierto expone `POST /env`. Que una ruta exista no la hace operación del diseño: pregunta si es contrato o accidente, y si es accidente, es un `fix` (se elimina) con su flujo.
- **Una respuesta puede depender de la forma de una dependencia** (orders daba 200 o 500 según cómo viniera el cliente). Las dos formas se sondean y la que se asume va a `unobserved.yaml`.
- **El orden no se ve en una grabación de un elemento.** Una lista ordenada se afirma con al menos dos elementos que llegan en orden contrario al de inserción; si no, es `read` (el `sort` del código) o una pregunta.
- **Lo que el legacy NO comprueba** (un borrado sin dueño, un filtro que se ignora) también es comportamiento grabado: o `keep` a sabiendas, o `fix` decidido.
- **La concurrencia no tiene un desenlace sino una distribución** (`outcomes` de la sonda repetida, con el diff de cada desenlace en `outcomeEffects`; `effects` es solo el de la primera repetición, y en shop-api fue la minoritaria). Lo estable es el conjunto de desenlaces: si incluye un duplicado o un último-gana, la decisión §3.9 es `omitted` y se pregunta.
- **El contrato del cable lo fija el método** (`wire-contract.md`): envolturas, forma del error y paginación del legacy no se copian. Cada diferencia de forma es un `fix` declarado (paridad semántica, paso 7 del plan).
