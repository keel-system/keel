---
name: keel-spring-redis
description: Guía de implementación de caché e idempotencia con Redis o Valkey (protocolo compatible) en un proyecto generado por keel-spring — caché de lectura con TTL del diseño, claves de idempotencia y validación. Usar cuando keel-stack.json declara cache "redis" o "valkey".
---

# Redis / Valkey (cache: `redis` o `valkey`)

Valkey es compatible con el protocolo Redis: mismo starter, mismo cliente, mismas
recetas; solo cambia la imagen del compose.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"cache": "redis"` o `"cache": "valkey"`.
- Lee `specs/use-cases.keel.yaml`: las operaciones con `cache` y/o `idempotency` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`; la estructura de paquetes está en `{{keel:docs}}/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil y compose (abajo); esta skill cubre solo el código que depende de Redis.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-data-redis`.
- `parameters/<perfil>/redis.yaml`: host/puerto por perfil (local apunta al contenedor del compose).
- `infra/docker-compose.yaml`: `redis:7-alpine` o `valkey:8-alpine` (puerto 6379).
- `infrastructure/configurations/cache/CacheConfig.java`: `@EnableCaching`, el
  `RedisCacheManager` con el TTL de cada caché del diseño y el `CacheErrorHandler` que degrada a miss.
- `application/port/out/OperationCache.java`: el puerto (`getOrLoad`, `evict`, `clear`).
- `application/support/CachedOperations.java`: una constante `<OPERACION>_CACHE` por caché del diseño y
  `<operacion>Key(mensaje)`, que compone la clave con los `keyFields` en su orden.
- `infrastructure/configurations/cache/RedisOperationCache.java`: el adaptador. Guarda la RESPUESTA de la
  operación como el JSON del contrato (el `ObjectMapper` de la aplicación), la lee con su tipo, no guarda nulos,
  carga una sola vez por entrada y degrada a miss si el store no responde.
- **La invalidación**: el `UseCaseMediator` vacía la caché entera tras el commit de cada operación que emite o
  consume un evento de su `invalidatedBy` (tabla `CACHE_INVALIDATIONS`).
- El handler de la operación con `cache` ya recibe `OperationCache` inyectado y una nota que te dice la llamada.
- `infra/reset-db.sh`: además de vaciar la BD, borra las claves `<servicio>:*`.

> **No escribas otro puerto ni otro adaptador de caché, no uses `@Cacheable`/`@CacheEvict` y no escribas
> desalojos para los eventos de `invalidatedBy`.** Es el mismo contrato que keel-nest: las dos corridas en que
> el agente lo escribió por su cuenta salieron con dos nombres y dos formas distintas.

## Qué implementa el agente

Solo DÓNDE se consulta: en el handler de la operación con `cache`, envuelve con `getOrLoad` la parte que produce
la respuesta.

```java
public GetAssetResponseDto handle(GetAssetQuery query) {
    GetAssetResponseDto card = operationCache.getOrLoad(
            CachedOperations.GET_ASSET_CACHE,
            CachedOperations.getAssetKey(query),
            () -> load(query),
            // Lo que el diseño no quiere ver servido durante el TTL se sirve y no se guarda.
            loaded -> loaded.thumbnail() != null);
    // Lo que depende de QUIÉN llama se comprueba sobre CADA respuesta, también la que sale de la caché.
    if (!callerScope.covers(card.ownerCode())) {
        throw new AssetOutOfScopeError(/* … */);
    }
    return card;
}
```

Tres reglas, y las tres se pagan con un dato que nadie ve fallar:

- **Lo que depende de quién llama se comprueba FUERA de la carga, sobre cada respuesta.** La clave son los
  `keyFields`, no el llamante: una comprobación de alcance dentro de `load` se saltaría en cada acierto.
- **Lo que no debe servirse durante el TTL no se guarda** (el `Predicate` de `getOrLoad`): la respuesta
  DEGRADADA porque un proveedor no contestó.
- **Solo en lecturas.** Ni en commands, ni como almacén de idempotencia (abajo).

- **Idempotencia** (`idempotency` en commands): **no es tuya**. La resuelve el
  `IdempotencyStore` que genera build, con una fila transaccional; tú solo lo usas
  en el handler siguiendo `conventions/mapping.md`. No la reimplementes aquí con
  `SET NX EX`: ese mecanismo guarda un flag, y el contrato exige **reproducir la
  respuesta original** (id del recurso incluido). El porqué, en
  `references/implementation.md`.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/redis.yaml` (timeouts, pool Lettuce, serialización, perfiles) |
| `references/implementation.md` | Al implementar la caché (`RedisCacheManager`, `sync`, evicción, `CacheErrorHandler`) o la idempotencia (`SET NX EX`) |
| `references/troubleshooting.md` | Si la caché sirve datos obsoletos, hay errores de serialización, claves sin TTL o timeouts |

## Validación

Desde devtools: `redis-cli -h redis PING` (o `-h valkey`); `redis-cli -h redis KEYS '*'`
y `TTL <clave>` para verificar entradas y expiraciones tras ejercitar los escenarios.
Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
