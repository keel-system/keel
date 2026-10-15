# Caché de lectura — patrones de implementación

Complementa «Lo que sí te toca» del SKILL.md. Todo lo que conoce Redis vive en `src/<Raíz>.Infrastructure/Cache/` y lo
generó build; tú solo usas el puerto `IOperationCache` desde el handler.

## Qué se guarda: la RESPUESTA de la operación

La caché guarda lo que devuelve la operación —el DTO de respuesta, la lista o la página— escrito con el contrato del
cable (`WireJson.Options`, lo mismo que sale por HTTP) y vuelto a leer con él. Lo que sale de un acierto es, campo a
campo, lo que habría servido el origen: un decimal con su escala, un instante con sus tres decimales, un `long` con todos
sus dígitos. `OperationCacheTests` lo comprueba para cada respuesta cacheada del diseño.

No caches el agregado ni una fila de persistencia: el valor de una caché de lectura es la respuesta que se ahorra.

**Qué entra en la respuesta cacheada lo decide el diseño.** Si la ficha lleva un dato de otro servicio (un `need` con
`exposedAs`), con `GetOrLoad` alrededor de todo se cachea también ese dato durante el TTL. Si el diseño quiere ese dato
fresco en cada lectura, deja fuera de la carga la llamada al proveedor y compón la respuesta después del acierto; si no,
déjalo dentro. Lo que no vale es elegirlo sin mirar `specs/`.

## La clave

`KeyOf` ya compone la clave desde el mensaje con los `keyFields` del diseño, en su orden, separados por `:` —la forma de
keel-spring y keel-nest—: `GetOrLoad(CachedOperations.GetProductBySlug, query, …)` no necesita nada más. En el store
queda `<servicio>:<operación>::<clave>` (`catalog:get-product-by-slug::sillas`).

Para desalojar una entrada concreta desde otro handler, compón la misma clave con `CacheKey.Of(...)`:

```csharp
await operationCache.Evict(CachedOperations.GetAsset, CacheKey.Of(asset.Id), cancellationToken);
```

## Invalidación: ya está hecha

`src/<Raíz>.Infrastructure/Cache/CacheInvalidations.cs` dice qué cachés vacía cada operación: la que EMITE un evento de
su `invalidatedBy` y la que DISPARA la suscripción a uno de ellos. El `UseCaseMediator` las vacía enteras al terminar el
handler, y el vaciado espera al COMMIT (si la transacción revierte, no se vacía nada; con un reintento por interbloqueo,
se programa otra vez). Sin transacción abierta, el vaciado ocurre antes de devolver la respuesta.

Se vacía la caché ENTERA porque la clave es la entrada de la lectura (el slug de la categoría, el id) y el evento no
tiene por qué llevarla: invalida de más, nunca de menos. La tabla la genera build y no se edita: si una mutación deja un
dato viejo, falta su evento en el `invalidatedBy` del diseño, y eso es un `designGap`, no un desalojo a mano. Uno a mano
solo tiene sentido para una mutación que el diseño no modela como evento.

`Evict` y `Clear` a mano también esperan al commit: puedes llamarlos dentro del handler sin pensar en el orden.

## Concurrencia

- **Una carga por entrada y proceso**: con la entrada caducada y diez lecturas a la vez, una va al origen y las nueve
  esperan su resultado (el `sync = true` de keel-spring). Si la carga lanza, las diez reciben el error.
- **Una carga que empezó antes de vaciar la caché no guarda lo que leyó**: pudo leerlo antes del commit que la vació.
  Solo dentro de un proceso: entre réplicas queda una ventana —una lectura en curso en una réplica mientras otra confirma
  y vacía— que también tienen keel-spring y keel-nest. Si el diseño no la tolera, el TTL es la cota.

## Checklist

- [ ] El handler de cada operación con `cache` consulta `GetOrLoad` con su miembro de `CachedOperations`.
- [ ] Lo que depende de quién llama (alcance, propiedad) se comprueba sobre cada respuesta de `GetOrLoad`, nunca solo dentro de la carga.
- [ ] Las respuestas degradadas o parciales que el diseño no quiere servir durante el TTL llevan `Cacheable`.
- [ ] Ningún command usa la caché; ninguna idempotencia vive en Redis.
- [ ] Ningún desalojo a mano duplica lo que ya hace `CacheInvalidations.cs`.
- [ ] No hay un segundo cliente de Redis ni un segundo adaptador del puerto.
