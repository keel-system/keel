# Caché de lectura — patrones de implementación

Complementa «Lo que sí te toca» del SKILL.md. Todo lo que conoce Redis vive en `internal/infrastructure/cache` y lo
generó build; tú solo usas la caché que recibe el handler (`h.operationCache`).

## Qué se guarda: la RESPUESTA de la operación

La caché guarda lo que devuelve la operación —el DTO de respuesta, la lista o la página— escrito con el contrato del
cable (`wire.Marshal`, lo mismo que sale por HTTP) y vuelto a leer con él (`wire.Unmarshal`). Lo que sale de un acierto
es, campo a campo, lo que habría servido el origen: un decimal con su escala, un instante con sus tres decimales.
`operation_cache_test.go` lo comprueba para cada respuesta cacheada del diseño.

No caches el agregado ni una fila de persistencia: el valor de una caché de lectura es la respuesta que se ahorra.

**Qué entra en la respuesta cacheada lo decide el diseño.** Si la ficha lleva un dato de otro servicio (un `need` con
`exposedAs`), con `GetOrLoad` alrededor de todo se cachea también ese dato durante el TTL. Si el diseño quiere ese dato
fresco en cada lectura, deja fuera de la carga la llamada al proveedor y compón la respuesta después del acierto; si no,
déjalo dentro. Lo que no vale es elegirlo sin mirar `specs/`.

## La clave

`Key` ya compone la clave desde el mensaje con los `keyFields` del diseño, en su orden, separados por `:` —la forma de
keel-spring, keel-nest y keel-dotnet—: `GetOrLoad(ctx, h.operationCache, GetProductBySlugCache, query, …)` no necesita
nada más. En el store queda `<servicio>:<operación>::<clave>` (`catalog:get-product-by-slug::sillas`).

Para desalojar una entrada concreta desde otro handler, compón la misma clave con `CacheKey(...)`:

```go
h.operationCache.Evict(ctx, GetAssetCache, CacheKey(asset.ID()))
```

`CacheKey` escribe un instante en el formato del cable, un booleano en minúsculas y un `nil` como `null`; lo demás, con
su `String()` o `fmt.Sprint`.

## Invalidación: ya está hecha

`NewUseCases` (`internal/application/use_cases.go`) envuelve cada operación con `settle`, y a la que EMITE un evento del
`invalidatedBy` de una caché —o DISPARA la suscripción a uno— le pasa el vaciado de esa caché. Se ejecuta cuando el caso
de uso termina bien, después del commit: si la transacción revierte, no se vacía nada. Si la operación la despachó otra
dentro de su transacción (`useCases.<Op>.Handle(ctx, …)`), el vaciado espera al caso de uso de FUERA, que es quien
confirma; despachada con `WithoutTransaction(ctx)`, sus escrituras confirman solas y el vaciado va al terminar ella.

Con transacción o sin ella, el vaciado termina ANTES de devolver la respuesta: la lectura que llega después de la
respuesta de la mutación ya no ve el dato viejo. No es asíncrono ni tiene plazo que esperar; un escenario lo afirma con un
GET inmediato, sin esperar. Lo que sí llega tarde es la mutación que dispara una SUSCRIPCIÓN: el vaciado ocurre cuando el
listener la procesa, y esa espera es la del broker.

Se vacía la caché ENTERA porque la clave es la entrada de la lectura (el slug de la categoría, el id) y el evento no
tiene por qué llevarla: invalida de más, nunca de menos. El cableado lo genera build y no se edita: si una mutación deja
un dato viejo, falta su evento en el `invalidatedBy` del diseño, y eso es un `designGap`, no un desalojo a mano. Uno a
mano solo tiene sentido para una mutación que el diseño no modela como evento.

`Evict` y `Clear` a mano también esperan a que termine bien el caso de uso en curso: puedes llamarlos dentro del handler
sin pensar en el orden.

## Concurrencia

- **Una carga por entrada y proceso**: con la entrada caducada y diez lecturas a la vez, una va al origen y las nueve
  esperan su resultado (el `sync = true` de keel-spring). Si la carga devuelve un error, las diez lo reciben.
- **Una carga que empezó antes de vaciar la caché no guarda lo que leyó**: pudo leerlo antes del commit que la vació.
  Solo dentro de un proceso: entre réplicas queda una ventana —una lectura en curso en una réplica mientras otra confirma
  y vacía— que también tienen los otros tres servidores. Si el diseño no la tolera, el TTL es la cota.

## Checklist

- [ ] El handler de cada operación con `cache` consulta `GetOrLoad` (o `GetOrLoadIf`) con su variable de `cached_operations.go`.
- [ ] Lo que depende de quién llama (alcance, propiedad) se comprueba sobre cada respuesta de `GetOrLoad`, nunca solo dentro de la carga.
- [ ] Las respuestas degradadas o parciales que el diseño no quiere servir durante el TTL van con `GetOrLoadIf`.
- [ ] Ningún command usa la caché; ninguna idempotencia vive en Redis.
- [ ] Ningún desalojo a mano duplica lo que ya cablea `NewUseCases`.
- [ ] No hay un segundo cliente de Redis ni otra implementación de `CacheStore`.
