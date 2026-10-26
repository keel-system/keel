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
| `columns[].type`, `columns[].precision`/`columns[].scale` | el tipo del campo; la escala del dinero sale de `numeric(p,s)` | `measured` |
| `columns[].length` | **no** es una cota del dominio por sí sola: `varchar(255)` es el default de casi todos los ORM. Solo entra como `maxLength` si una sonda la ve rechazar (y con qué código) | `read` sin sonda |
| `columns[].nullable` | la obligatoriedad **no** sale de aquí: una columna NOT NULL puede deberse a un default del ORM, y una anulable ser obligatoria por la validación de la app (anotaciones que no llegan al DDL). Obligatorio es lo que una sonda ve rechazar ausente o vacío | `measured` con sonda; `read` sin ella |
| `columns[].default` | el valor inicial del campo, si el alta grabada lo deja (`'AVAILABLE'` es el estado de partida del `lifecycle`). Uno técnico (`CURRENT_TIMESTAMP`, `nextval(…)`) no es del dominio | `measured` con el alta |
| `primaryKey` con `columns[].default` `nextval(…)` o `columns[].autoIncrement` | el id lo genera la base. Su VALOR no es comparable: un intento fallido también consume el contador (`_sequences` o `_auto_increment` del diff). En `contract-map.yaml`, una diferencia declarada si el regenerado usa otro tipo de id | `measured` |
| `primaryKey` de texto que manda el cliente | id asignado por el cliente: es su clave natural | `measured` |
| `rows` | cuántas filas había al introspeccionar. Una tabla con filas que ninguna sonda crea es **seed**: sus datos son el estado de partida (`fixtures.yaml`), no algo que haga una operación | `measured` |
| `unique` | `naturalKey` o un índice `unique`, con el rechazo del duplicado grabado (status y cuerpo) | `measured` |
| `indexes` con `WHERE` | un índice con `when` (unicidad condicionada al estado) | `measured` |
| `indexes` sin `WHERE` ni `UNIQUE` | rendimiento del legacy, no contrato: no es un elemento del dominio. Si una búsqueda del diseño filtra u ordena por esas columnas, el generador ya lo indexa | — |
| `checks` de cota (`x >= 0`) | la cota del campo | `measured` |
| `checks` sobre una columna de estado, un tipo de `data.types` (ENUM de PostgreSQL) o `columns[].values` (ENUM de columna de MySQL) | los ESTADOS del `lifecycle`, con sus nombres. Las transiciones no: solo las que una sonda `lifecycle` recorre. El orden en que el ENUM declara sus valores no es un orden de transición | `measured` los estados; las transiciones, con sonda |
| `states` (columna de estado por su forma, sin CHECK ni ENUM) | los valores son `measured`; si son números, sus nombres salen del código (`read`) o de una pregunta | `measured` / `read` |
| `foreignKeys` | una relación. Si las filas se escriben juntas (diff de una sonda) y se borran en cascada, la hija es parte del agregado; si solo se referencia por id, son dos agregados. Sin diff que lo muestre, la frontera es `inferred` y no entra | `measured` con diff |
| una referencia por valor SIN clave ajena (un código en una columna de texto) | referencia entre agregados sin integridad: borrar el referido no toca a quien lo nombra. Grábalo con una sonda de borrado; es `keep` o `fix` a sabiendas | `measured` con diff |
| `onDelete: cascade`, `triggers`, `data.routines` | comportamiento que vive en la base. Una sonda de borrado (o la escritura que dispara el trigger) lo graba en el diff; si ningún flujo HTTP lo ve, el `fix` lleva `noFlow` con esa prueba. Una rutina que no aparece en ninguna grabación ni la llama el código es código muerto de la base: `read`, y fuera | `measured` con diff |
| `_sequences` o `_auto_increment` en el diff, `data.sequences` | no es un elemento del diseño: es un efecto técnico | — |

### MySQL

Lo que solo tiene MySQL, medido sobre MySQL 8.0. Las dos primeras filas piden una sonda de clase cada una, y `keel-recover status` no cierra la exploración sin ellas (`collation:<tabla>` y `overflow:<tabla>`; ver `exploration.md`).

| Evidencia | Elemento del DSL | Nivel |
|---|---|---|
| `columns[].collation` acabada en `_ci` en una columna de `unique` | `compare` en el campo del dominio: `ignore-case` (`utf8mb4_general_ci`), o `ignore-case-accents` con `_ai_ci` (`utf8mb4_0900_ai_ci`, el default de 8.0). Con `_ci`, «A» y «a» son la MISMA clave: el alta con otra caja es un 409, y la lectura por clave con otra caja encuentra la fila. Es contrato observable: sin `compare`, el regenerado los trataría como dos y la paridad lo cazaría. La sonda de clase `collation` lo graba; si los acentos cuentan, otra con «é» y «e» | `measured` con la sonda; `read` sin ella |
| `data.sqlMode` sin `STRICT_TRANS_TABLES` (ni `STRICT_ALL_TABLES`) | un texto más largo que su columna se TRUNCA y la escritura sale bien (la respuesta puede devolver el texto entero y la base guardar el corto); un número fuera de rango se recorta. Es comportamiento grabado: `keep` a sabiendas (sin `maxLength`, y el regenerado no trunca igual: diferencia declarada) o `fix` (`maxLength` = la longitud de la columna, y el 400 sustituye al truncado). El `sql_mode` leído es el del SERVIDOR: el driver de la app puede fijar otro en su sesión, así que lo que vale es la sonda de clase `overflow` | `measured` con la sonda; `read` sin ella |
| `columns[].type` `tinyint` | un número para la base. Booleano solo si el código lo trata como tal (el campo de la entidad, el mapeo del ORM). Sin eso, los valores grabados (0/1 en `states`) son un entero | `read` el booleano |
| `columns[].values` | los valores de un `ENUM` de columna: los estados (la fila de `checks` de arriba). Con `sql_mode` no estricto, un valor fuera del ENUM se guarda como `''` sin error: si una sonda lo provoca, es un `fix` | `measured` |
| `engine` `MyISAM` | sin transacciones y sin claves ajenas: MyISAM **no** guarda la FK que declara el DDL (no aparece en `foreignKeys`), así que es una referencia sin integridad (la fila de arriba), y una escritura a medias no se deshace. Lo que se graba sobre ella no se corrige: `keep` o `fix` a sabiendas | `measured` con diff |
| `columns[].onUpdate` | **no** es un campo que escriba el flujo: el motor lo reescribe en cada UPDATE y el diff lo graba como `<on-update>`. Si el diseño quiere «última modificación», es la auditoría (`audit.timestamps`, con `updatedAt` en `domain`), que estampa el generador, no un campo que escriba la operación | `measured` |
| `columns[].autoIncrement` | el id lo genera la base (la fila de `primaryKey`). Un alta rechazada también consume el contador (M-03): `_auto_increment` en el diff | `measured` |
| `columns[].unsigned` | un mínimo de 0 en la base. Como cota del dominio, solo con una sonda que mande un negativo: con modo estricto es un error del motor (un 500), sin él se guarda 0 | `read` sin sonda |

Trampas de MySQL:

- **La fecha cero** (`0000-00-00`, `0000-00-00T00:00:00`) es el «sin fecha» del legacy, con un `sql_mode` que la admite. En el diseño es un campo opcional (ausente), y en `contract-map.yaml` una diferencia declarada: el regenerado devuelve `null` donde el legacy devolvía la fecha cero.
- **`TIMESTAMP` depende de la zona de la sesión.** La exportación lo lee en UTC; lo que devuelve la API del legacy sale de la zona de SU conexión. Una hora que no casa con la grabada es una zona, no un defecto.

Trampas de una base relacional:

- **El esquema puede crearlo la app al arrancar** (un ORM con `ddl-auto`, `synchronize` o equivalente): no hay migraciones que leer y reiniciar la app devuelve la base a su seed. El esquema del diseño sale de la introspección y de los flujos.
- **Una lista sin `ORDER BY` no tiene orden**, aunque dos grabaciones coincidan. Si repetir la misma sonda cambia el orden de una colección de la respuesta, compárala como conjunto y no afirmes orden.
- **El seed también es evidencia**: los datos de partida (un `import.sql`, un `data.sql`, unas migraciones con `INSERT`) son `read`, y lo que se ve de ellos en las grabaciones, `measured`.

## Base documental (`surface.yaml → data.collections`)

Lo que `introspect` lee de MongoDB es una MUESTRA de los documentos (hasta 5000 por colección), no un esquema: un campo que no sale en la muestra no existe para la superficie.

| Evidencia | Elemento del DSL | Nivel |
|---|---|---|
| `fields` (con los tipos que se ven en cada uno) | los campos de la entidad y su tipo. Un campo con varios tipos (`string` y `null`) o que falta en parte de los documentos es opcional, o el rastro de una forma vieja: lo dice el código (`read`) o una sonda que lo cree | `measured` el campo; `read` la forma |
| `count` | cuántos documentos había al introspeccionar. Una colección con documentos que ninguna sonda crea es **seed** (`fixtures.yaml`) | `measured` |
| `indexes`, `indexes[].key` | un índice sin `unique` es rendimiento del legacy, no contrato | — |
| `indexes[].unique` | `naturalKey` o un índice `unique`, con el rechazo del duplicado grabado | `measured` |
| `indexes[].sparse` | unicidad solo entre los documentos que tienen el campo: el campo único es opcional | `measured` |
| `indexes[].expireAfterSeconds` | la base BORRA los documentos pasado ese tiempo (TTL): comportamiento que vive en la base y que ninguna sonda espera. `read`, y a `unobserved.yaml` o a una pregunta | `read` |
| `enums` (valores de un campo de texto con pocos distintos) | los ESTADOS del `lifecycle`, si el campo es de estado; las transiciones, solo con sonda `lifecycle` | `measured` los estados |

## Trampas medidas en el incremento 1 (RealWorld y Sock Shop)

- **El framework añade superficie.** Spring Data REST expone `PUT`, `PATCH`, `DELETE` y búsquedas que nadie escribió; actuator abierto expone `POST /env`. Que una ruta exista no la hace operación del diseño: pregunta si es contrato o accidente, y si es accidente, es un `fix` (se elimina) con su flujo.
- **Una respuesta puede depender de la forma de una dependencia** (orders daba 200 o 500 según cómo viniera el cliente). Las dos formas se sondean y la que se asume va a `unobserved.yaml`.
- **El orden no se ve en una grabación de un elemento.** Una lista ordenada se afirma con al menos dos elementos que llegan en orden contrario al de inserción; si no, es `read` (el `sort` del código) o una pregunta.
- **Lo que el legacy NO comprueba** (un borrado sin dueño, un filtro que se ignora) también es comportamiento grabado: o `keep` a sabiendas, o `fix` decidido.
- **La concurrencia no tiene un desenlace sino una distribución** (`outcomes` de la sonda repetida, con el diff de cada desenlace en `outcomeEffects`; `effects` es solo el de la primera repetición, y en shop-api fue la minoritaria). Lo estable es el conjunto de desenlaces: si incluye un duplicado o un último-gana, la decisión §3.9 es `omitted` y se pregunta.
- **El contrato del cable lo fija el método** (`wire-contract.md`): envolturas, forma del error y paginación del legacy no se copian. Cada diferencia de forma es un `fix` declarado (paridad semántica, paso 7 del plan).
