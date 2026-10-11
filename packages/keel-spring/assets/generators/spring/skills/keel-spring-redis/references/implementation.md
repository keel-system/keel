# Redis/Valkey — patrones de implementación

Complementa «Qué implementa el agente» del SKILL.md. Todo vive en
`infrastructure` (la capa application no importa Spring ni Redis).

## Caché de lectura (`cache` en queries del diseño)

**Todo el mecanismo ya existe y es de build**: `CacheConfig` (el `RedisCacheManager` con el TTL de cada caché),
el puerto `OperationCache` (`application/port/out`), `CachedOperations` (`application/support`: la constante de
cada caché y su `<operacion>Key(mensaje)`), el adaptador `RedisOperationCache` y la invalidación en el
`UseCaseMediator`. El handler de la operación con `cache` ya recibe el puerto inyectado. **No escribas otro
puerto, otro adaptador ni otro `CacheManager`, y no uses `@Cacheable`/`@CacheEvict`.**

Por qué no `@Cacheable`, que fue la receta anterior de esta skill:

- **No expresa lo que el diseño pide.** Una respuesta DEGRADADA (un proveedor no contestó) se sirve y no se
  guarda, y el alcance del llamante se comprueba también sobre el acierto. Con `sync = true` no hay `unless`
  —Spring lo rechaza en runtime con un `500` en cada lectura cacheada— y la anotación va en un método, no
  alrededor de la parte del handler que produce la respuesta.
- **Cacheaba el agregado, no la respuesta.** El serializador tipado de la caché tiene que reconstruir el
  agregado, sus colecciones inmutables y sus instantes; un fallo ahí no se ve —el `CacheErrorHandler` lo degrada
  a miss— y la caché queda sin cachear nada.
- **Dos corridas lo esquivaron igual y con nombres distintos** (`GetAssetCache`, `ResponseCache`): guardando la
  respuesta como el JSON del contrato. Es lo que hace ahora `RedisOperationCache`, igual que keel-nest.

Lo que hace el adaptador y no tienes que repetir: guarda la respuesta con el `ObjectMapper` de la aplicación
(lo que vuelve es byte a byte lo que habría servido el origen), no guarda nulos ni los errores de la carga, carga
UNA vez por entrada con varias peticiones a la vez, y un store caído o una entrada ilegible van al origen con un
WARN.

Tu parte, en el handler:

```java
GetAssetResponseDto card = operationCache.getOrLoad(
        CachedOperations.GET_ASSET_CACHE,
        CachedOperations.getAssetKey(query),
        () -> load(query),
        loaded -> loaded.thumbnail() != null);   // la degradada no se guarda
if (!callerScope.covers(card.ownerCode())) {      // el alcance, sobre CADA respuesta
    throw new AssetOutOfScopeError(/* … */);
}
```

- La clave sale de `CachedOperations.<operacion>Key(...)`: los `keyFields` del diseño en su orden, separados por
  `:`. No la compongas a mano.
- Desalojar a mano (`evict`, `clear`) solo hace falta para algo que el diseño no declara en `invalidatedBy`; los
  dos lo hacen tras el commit si hay una transacción abierta.
- No caches resultados de commands.

## Tolerancia a caída de Redis

La caché nunca puede tumbar la funcionalidad: si Redis cae, se degrada a miss y
se va a la BD. El `CacheErrorHandler` que lo garantiza **ya viene en el
`CacheConfig` generado** (loguea WARN y sigue). Si necesitas comportamiento
distinto por operación, ajústalo ahí; la regla es: error de caché ≠ error de negocio.

## Idempotencia (`idempotency` en commands del diseño): no va en Redis

Ninguna de las dos idempotencias del método se implementa aquí:

- La de **consumo de mensajes** la resuelve `IdempotencyGuard`
  (`infrastructure/messaging/idempotency/`, tabla `processed_event`), que los
  listeners usan tal cual.
- La de **comando HTTP** la resuelve el puerto `IdempotencyStore` y su adaptador
  JPA (tabla `idempotency_record`), que build genera junto con el filtro de la
  cabecera. Cómo usarlo en el handler: `conventions/mapping.md`.

Un `SET NX EX` guardando un flag **no puede** cumplir el contrato, y por eso se
descartó: la repetición no se rechaza, se **reproduce** — hay que devolver la
respuesta original, con el id del recurso creado, así que hace falta guardar ese
id y una firma del contenido. Y sobre todo, el registro tiene que commitear en la
misma transacción que el agregado: con Redis y la BD como dos almacenes, marcar
antes de ejecutar deja la clave envenenada durante todo el TTL si la transacción
revierte, y marcar después abre la ventana para que dos reintentos ejecuten
ambos. Es la misma razón por la que el método genera el outbox en vez de publicar
directo al broker.

Redis en este servicio es **caché**, y ahí sí puede degradar a miss sin
consecuencias. Una idempotencia degradada es un alta duplicada.

## Naming de claves

`<servicio>:<uso>:<id>` — p. ej. `product-catalog:product-by-id:42`,
`product-catalog:idem:req-abc`. Prefijo de servicio siempre; minúsculas y
`:` como separador (así `redis-cli --scan --pattern 'product-catalog:*'`
inspecciona lo tuyo y solo lo tuyo).

## Estampida y TTLs

- La carga única por entrada de `RedisOperationCache` cubre la estampida por expiración puntual (en el proceso).
- Si muchas claves se crean a la vez (p. ej. tras un reset de datos), añade
  jitter al TTL (±10%) al poblarlas por código para que no expiren en masa.

## Estado entre flujos de validación

`infra/reset-db.sh` borra las claves `<servicio>:*` además de vaciar la BD, así
que cachés y claves de idempotencia no sobreviven al reset. Aun así, en los
escenarios usa un `Idempotency-Key` **único por request** (un uuid) salvo cuando
el escenario prueba justamente la deduplicación: reutilizar la misma clave entre
flujos devuelve la respuesta del flujo anterior mientras dure el TTL declarado
(a menudo horas) y parece un bug del código que no existe.

## Checklist

- [ ] `CacheConfig`, `OperationCache`, `CachedOperations` y `RedisOperationCache` generados por build, usados tal
      cual (ni un segundo `CacheManager`, ni otro puerto, ni `@Cacheable`/`@CacheEvict`).
- [ ] La consulta va en el handler con `operationCache.getOrLoad(...)`, y la clave sale de `CachedOperations`.
- [ ] Lo que depende de quién llama se comprueba FUERA de la carga, sobre cada respuesta.
- [ ] La respuesta degradada no se guarda (el `Predicate` de `getOrLoad`).
- [ ] Ningún desalojo propio por los eventos de `invalidatedBy`: los aplica el `UseCaseMediator`.
- [ ] La idempotencia NO va en Redis (la resuelve `IdempotencyStore`).
