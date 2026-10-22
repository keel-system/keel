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

## Trampas medidas en el incremento 1 (RealWorld y Sock Shop)

- **El framework añade superficie.** Spring Data REST expone `PUT`, `PATCH`, `DELETE` y búsquedas que nadie escribió; actuator abierto expone `POST /env`. Que una ruta exista no la hace operación del diseño: pregunta si es contrato o accidente, y si es accidente, es un `fix` (se elimina) con su flujo.
- **Una respuesta puede depender de la forma de una dependencia** (orders daba 200 o 500 según cómo viniera el cliente). Las dos formas se sondean y la que se asume va a `unobserved.yaml`.
- **El orden no se ve en una grabación de un elemento.** Una lista ordenada se afirma con al menos dos elementos que llegan en orden contrario al de inserción; si no, es `read` (el `sort` del código) o una pregunta.
- **Lo que el legacy NO comprueba** (un borrado sin dueño, un filtro que se ignora) también es comportamiento grabado: o `keep` a sabiendas, o `fix` decidido.
- **La concurrencia no tiene un desenlace sino una distribución** (`outcomes` de la sonda repetida). Lo estable es el conjunto de desenlaces: si incluye un duplicado o un último-gana, la decisión §3.9 es `omitted` y se pregunta.
- **El contrato del cable lo fija el método** (`wire-contract.md`): envolturas, forma del error y paginación del legacy no se copian. Cada diferencia de forma es un `fix` declarado (paridad semántica, paso 7 del plan).
