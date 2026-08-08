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
2. **Una proyección nunca es fuente de verdad.** No se expone tal cual en un DTO público (si el cliente
   necesita esos datos, se le devuelven como parte de la respuesta propia, no como recurso), no se le
   aplican invariantes del dominio propio y no se valida contra reglas nuestras: sus invariantes las
   garantiza el proveedor.
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
- Ignorar el cuerpo de la respuesta en una activación `awaits: outcome`.
