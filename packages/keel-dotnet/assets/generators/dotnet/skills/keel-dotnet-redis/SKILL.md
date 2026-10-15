---
name: keel-dotnet-redis
description: Guía de la caché de lectura con Redis o Valkey (protocolo compatible) en un proyecto generado por keel-dotnet — qué generó build, dónde se consulta la caché desde el handler, qué no se guarda y por qué la invalidación ya está hecha. Usar cuando keel-stack.json declara cache "redis" o "valkey".
---

# Redis / Valkey (cache: `redis` o `valkey`)

Valkey habla el protocolo de Redis: el mismo cliente (StackExchange.Redis), el mismo código; solo cambia la imagen del
compose. Es el mismo servidor que el de keel-spring y keel-nest del diseño: las cachés se llaman igual en el store
(`<servicio>:<operación>::<clave>`), con el mismo TTL, y `infra/reset-db.sh` las borra con la misma orden.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"cache": "redis"` o `"cache": "valkey"`.
- Lee en `specs/use-cases.keel.yaml` las operaciones con `cache` (`ttlSeconds`, `keyFields`, `invalidatedBy`): el
  diseño es la única fuente de verdad funcional.
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: el proyecto Application
  no conoce Redis (el compilador lo impide: no lo referencia); usa el puerto.

## Qué dejó listo build — y qué NO vas a escribir

`<Raíz>` es el nombre de la solución (`AssetVault`, por ejemplo).

| Pieza (build) | Dónde |
|---|---|
| El puerto | `src/<Raíz>.Application/Ports/IOperationCache.cs` — `IOperationCache` (`GetOrLoad`, `Evict`, `Clear`), `CachedOperation<T, TMessage>` y `CacheKey.Of(...)` |
| Las cachés del diseño | `src/<Raíz>.Application/Support/CachedOperations.cs` — un miembro por operación, con su nombre, su TTL y su clave (`KeyOf`, de los `keyFields`) |
| El adaptador sobre Redis/Valkey | `src/<Raíz>.Infrastructure/Cache/RedisOperationCache.cs` — degrada a miss, no guarda nulos, una carga por entrada a la vez; guarda y lee la respuesta con el contrato del cable (`WireJson`) |
| La conexión | `src/<Raíz>.Infrastructure/Cache/RedisCacheStore.cs` — arranca sin el store, falla en el acto sin conexión (`BacklogPolicy.FailFast`) y reconecta sin fin |
| **La invalidación** | `src/<Raíz>.Infrastructure/Cache/CacheInvalidations.cs`, que aplica el `UseCaseMediator` tras el commit |
| Configuración y registro | `config/parameters/<perfil>/cache.yaml`, `src/<Raíz>.Infrastructure/Cache/CacheSettings.cs` (`REDIS_HOST`, `REDIS_PORT`, las de keel-spring) y `src/<Raíz>.Infrastructure/Cache/CacheRegistration.cs`; en el perfil `test` no hay caché |
| Las pruebas del adaptador | `tests/<Raíz>.UnitTests/OperationCacheTests.cs` (con la ida y vuelta de cada respuesta cacheada) |
| Redis/Valkey en `infra/`, su sondeo y su vaciado | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El vaciado a mitad de flujo | `ClearCache()` en `FlowTest` |

> **No escribas otro adaptador ni otro cliente de Redis, y no escribas desalojos para los eventos de `invalidatedBy`**:
> el mediator ya vacía la caché entera, tras el commit, en cada operación que emite o consume uno de ellos. Un desalojo
> tuyo por clave al lado no añade nada y, si se adelanta al commit, sirve el dato viejo.

## Lo que sí te toca: consultar la caché desde el handler

El handler de la operación con `cache` ya recibe `IOperationCache` en su constructor primario y una nota con la llamada.
Envuelve con `GetOrLoad` la parte que produce la respuesta:

```csharp
public async Task<GetAssetResponseDto> Handle(GetAssetQuery query, CancellationToken cancellationToken)
{
    var card = await operationCache.GetOrLoad(
        CachedOperations.GetAsset,
        query,
        ct => Load(query, ct),
        // Lo que el diseño no quiere ver servido durante el TTL se sirve y no se guarda.
        new CacheLoadOptions<GetAssetResponseDto> { Cacheable = card => card.Thumbnail is not null },
        cancellationToken);
    // Lo que depende de QUIÉN llama se comprueba sobre CADA respuesta, también la que sale de la caché.
    if (!callerScope.Covers(card.OwnerCode)) throw new AssetOutOfScopeError(/* … */);
    return card;
}
```

Tres reglas, y las tres se pagan con un dato que nadie ve fallar:

- **Lo que depende de quién llama se comprueba FUERA de la carga, sobre cada respuesta.** La clave son los `keyFields`
  (la entrada de la operación), no el llamante: una comprobación de alcance o de propiedad dentro de la carga se
  saltaría en cada acierto, y la ficha de un propietario le llegaría a otro. Si la comprobación necesita el recurso,
  hazla sobre lo que devuelve `GetOrLoad` (la respuesta lleva el dato con el que decidir); si no, antes.
- **Lo que no debe servirse durante el TTL no se guarda** (`Cacheable`). El caso típico es la respuesta DEGRADADA porque
  un proveedor no contestó (`onUnavailable` de un `need`): servirla cinco minutos convierte una caída de un segundo en
  cinco minutos de ficha incompleta.
- **Solo en lecturas.** Ni en commands, ni como almacén de idempotencia: la idempotencia es el registro transaccional que
  genera build (`conventions/mapping.md`), porque una repetición no se rechaza, se **reproduce**, y Redis no confirma en
  la transacción del agregado.

Lo demás ya lo hace el adaptador y no lo repitas: un error de la carga (un 404 del dominio) no se guarda, un `null`
tampoco, y el store caído o una entrada ilegible van al origen con un aviso en el log. Detalle, la clave compuesta y el
desalojo a mano en `references/implementation.md`.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al escribir el handler: la clave, qué entra en la respuesta cacheada, `Evict`/`Clear` a mano, la ventana entre réplicas |
| `references/troubleshooting.md` | Si la caché sirve datos viejos, no cachea nada, o un escenario de retención falla sin ningún error |

## Validación

`dotnet test` (incluye `OperationCacheTests`: si cae, tocaste el adaptador). Desde el contenedor devtools de `infra/`:
`redis-cli -h redis PING` (o `-h valkey`), `redis-cli -h redis --scan --pattern '<servicio>:*'` y `TTL <clave>` para ver
las entradas y su caducidad tras ejercitar los escenarios. En un flujo, `ClearCache()` mide un MISS a mitad de escenario.
