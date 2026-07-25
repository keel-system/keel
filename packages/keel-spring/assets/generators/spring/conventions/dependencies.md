# Convención: dependencias con otros servidores (capa `dependencies`)

Cómo se materializa en Spring la capa `dependencies` del diseño. Vocabulario: el DSL habla de
*necesidades* (`needs`) y *réplicas* (`replica`); aquí eso es un **read model** con su **projector** y su
**reader**, que es como se llama en esta arquitectura.

## Qué genera `build` y qué escribe el agente

| Artefacto | Quién |
|---|---|
| `application/projection/<E>Projector.java` | **build** — esqueleto del upsert (búsqueda, ordenación, ramas, `save`) |
| `<E>.projectionOf(...)` y `<E>.applySnapshot(...)` | **agente** — el dominio no tiene setters; el Projector deja sus firmas exactas en un TODO |
| `application/projection/<E>Reader.java` | **build** — lectura con la política `onMiss` (con TODOs) |
| Entidad `<E>`, `<E>Jpa`, `<E>Repository` + adaptador | **build**, desde `domain`/`persistence` |
| Puerto `<C>Client`, adaptador RestClient, mapper ACL | **build**, desde `http-clients` |
| `ProcessedEvent` + `IdempotencyGuard` | **build**, desde `messaging.subscriptions` |
| `<Evento>Listener` | **agente**, según la skill del broker |
| Cuerpo de `hydrate(...)` en el Reader | **agente** |
| El resultado degradado de `onMiss: degrade` | **agente** (es lógica de negocio) |

Una necesidad con `strategy: on-demand` **no genera nada nuevo**: se resuelve invocando el puerto
`<C>Client` que ya existe, desde el handler de la operación que la declara en `usedBy`.

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
   copia. El `IdempotencyGuard` es la primera red; el upsert, la segunda.
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

## Antipatrones

- Llamar al Projector desde el listener (salta el mediator y el guard).
- Hacer la llamada HTTP de hidratación dentro de la transacción de escritura de un command.
- Reintentar respuestas `4xx` del proveedor: un `404` significa que el recurso no existe, no que haya que
  insistir.
- Rehidratar en bucle ante `degrade`: si la política es degradar, no se llama al proveedor.
- Escribir la proyección desde un handler de negocio "porque es más rápido".
- Copiar campos del proveedor que ninguna operación de `usedBy` lee.
- Exponer la entidad réplica como un recurso REST propio.
