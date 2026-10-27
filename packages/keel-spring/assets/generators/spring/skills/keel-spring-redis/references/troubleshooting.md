# Redis/Valkey — troubleshooting

Síntoma → causa → arreglo. Sondeo básico en
`{{keel:docs}}/conventions/infra-validation.md`.

## `SerializationException` al cachear algo con fecha/hora

`Java 8 date/time type ... not supported by default` al escribir en la caché un
DTO con `Instant`, `LocalDate` u `OffsetDateTime`: el serializador de los valores
no usa el mapper de la caché (en Jackson 3 java.time viene de serie, pero el
formato de los instantes lo fija `TimestampModule`). El `CacheConfig` generado
por build lo configura — el fallo aparece cuando alguien añade **otro**
`CacheManager`, `RedisTemplate` o serializador con un `ObjectMapper` propio.
Reutiliza el de `CacheConfig` en vez de construir uno nuevo.

## `ClassCastException` / `SerializationException` al leer de la caché

Quedaron entradas escritas con otro serializador (p. ej. el default JDK antes
de configurar el JSON) o con una versión anterior de la clase. Limpia las
claves del servicio en local (`bash infra/reset-db.sh`, que ya borra
`<servicio>:*`) y verifica que no hay un segundo `CacheManager` compitiendo con
el generado.

## La caché sirve datos obsoletos

La invalidación la aplica el `UseCaseMediator` con su tabla `CACHE_INVALIDATIONS`, que sale de
`invalidatedBy` + `emits` + las suscripciones del diseño. Si un command que cambia lo cacheado no está en ella,
el command no emite ni consume ninguno de los eventos de `invalidatedBy`: es un hueco del diseño (añade el evento
a `invalidatedBy` o a lo que emite el command), no un desalojo que escribir a mano. Verifícalo con el escenario:
mutación → lectura debe devolver lo nuevo aunque el TTL no haya vencido.

## Claves sin TTL (`TTL <clave>` devuelve -1)

Alguien escribió con `opsForValue().set(k, v)` sin duración, o el
`RedisCacheConfiguration` de esa caché no fija `entryTtl`. Toda clave del
servicio debe tener TTL: una clave sin TTL es una fuga de memoria. Encuéntralas:
`redis-cli -h redis --scan --pattern '<servicio>:*' | while read k; do [ "$(redis-cli -h redis ttl "$k")" = "-1" ] && echo "$k"; done`.

## La caché no guarda nada (cada lectura va al origen)

`RedisOperationCache` degrada a miss cualquier error del store o de la lectura del JSON, con un WARN
`Caché <nombre> no disponible al leer/escribir`. Búscalo en el log: un tipo de respuesta que no se puede leer
con el `ObjectMapper` de la aplicación sale ahí, no como error de la petición. Y comprueba que el `Predicate`
de `getOrLoad` no rechaza la respuesta normal.

## `RedisCommandTimeoutException` / handlers lentos con Redis degradado

Sin `timeout` configurado, Lettuce espera indefinidamente. Fija
`spring.data.redis.timeout` corto (configuration.md) y registra el
`CacheErrorHandler`: la petición debe degradar a miss e ir a la BD, no fallar.

## `Connection refused`

Contenedor caído o host equivocado: desde la app en el host es
`localhost:6379`; desde devtools es `redis` (o `valkey` — el hostname es el
serviceKey del compose, revisa cuál declara tu `keel-stack.json`).
`redis-cli -h redis PING` / `redis-cli -h valkey PING`.

## Un escenario recibe la respuesta de otro flujo anterior

Estado sobreviviente en Redis, no un bug del código:

- **Clave de idempotencia reutilizada**: el mismo `Idempotency-Key` en dos
  flujos distintos devuelve la respuesta cacheada del primero mientras dure el
  TTL declarado (con `ttlSeconds: 86400`, un día entero). Usa un uuid nuevo por
  request salvo en el escenario que prueba la deduplicación.
- **Entrada de caché anterior al reset**: `bash infra/reset-db.sh` borra las
  claves `<servicio>:*` además de vaciar la BD; si se reseteó la BD por otra vía,
  la caché conserva el recurso que la BD ya no tiene.

## La idempotencia «no funciona» en los escenarios

- El TTL venció entre las dos llamadas del escenario: compara el
  `idempotency.ttlSeconds` del diseño con los tiempos reales del flujo.
- La clave se libera al fallar la operación y el escenario esperaba el
  conflicto (o viceversa): es la decisión documentada en implementation.md —
  si contradice el escenario, el hueco es del diseño (`designGap`), no del
  código.
- Dos réplicas con `keySource` distinto (p. ej. header ausente en una): la
  clave debe derivar exactamente del `keySource` declarado.
