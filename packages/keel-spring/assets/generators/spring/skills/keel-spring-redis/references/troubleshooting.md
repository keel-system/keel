# Redis/Valkey — troubleshooting

Síntoma → causa → arreglo. Sondeo básico en
`.claude/conventions/infra-validation.md`.

## `ClassCastException` / `SerializationException` al leer de la caché

Quedaron entradas escritas con otro serializador (p. ej. el default JDK antes
de configurar el JSON) o con una versión anterior de la clase. Limpia las
claves del servicio en local
(`redis-cli -h redis --scan --pattern '<servicio>:*' | xargs redis-cli -h redis del`)
y verifica que el `RedisCacheManager` fija el serializador JSON para **todas**
las cachés (la configuración base, no caché a caché).

## La caché sirve datos obsoletos

Falta un `@CacheEvict` en algún command que muta la entidad. Repasa el diseño:
lista los commands que tocan la entidad cacheada y comprueba que cada uno
evicta. Verifícalo con el escenario: mutación → lectura debe devolver lo nuevo
aunque el TTL no haya vencido.

## Claves sin TTL (`TTL <clave>` devuelve -1)

Alguien escribió con `opsForValue().set(k, v)` sin duración, o el
`RedisCacheConfiguration` de esa caché no fija `entryTtl`. Toda clave del
servicio debe tener TTL: una clave sin TTL es una fuga de memoria. Encuéntralas:
`redis-cli -h redis --scan --pattern '<servicio>:*' | while read k; do [ "$(redis-cli -h redis ttl "$k")" = "-1" ] && echo "$k"; done`.

## `500` en toda lectura cacheada: `A sync=true operation does not support the unless attribute`

`IllegalStateException` lanzada por Spring Cache al invocar el método: el
`@Cacheable` combina `sync = true` con `unless`, y son incompatibles. No hay
error de compilación — solo se ve al llamar al endpoint. Quita el `unless`: los
vacíos ya los descarta `disableCachingNullValues()` en la
`RedisCacheConfiguration` base. Ver `references/implementation.md`.

## El primer acceso tras expirar dispara N queries a la BD

Estampida: falta `sync = true` en el `@Cacheable` (o el equivalente con lock
si usas `RedisTemplate` directo). Ver `references/implementation.md`.

## `RedisCommandTimeoutException` / handlers lentos con Redis degradado

Sin `timeout` configurado, Lettuce espera indefinidamente. Fija
`spring.data.redis.timeout` corto (configuration.md) y registra el
`CacheErrorHandler`: la petición debe degradar a miss e ir a la BD, no fallar.

## `Connection refused`

Contenedor caído o host equivocado: desde la app en el host es
`localhost:6379`; desde devtools es `redis` (o `valkey` — el hostname es el
serviceKey del compose, revisa cuál declara tu `keel-stack.json`).
`redis-cli -h redis PING` / `redis-cli -h valkey PING`.

## La idempotencia «no funciona» en los escenarios

- El TTL venció entre las dos llamadas del escenario: compara el
  `idempotency.ttlSeconds` del diseño con los tiempos reales del flujo.
- La clave se libera al fallar la operación y el escenario esperaba el
  conflicto (o viceversa): es la decisión documentada en implementation.md —
  si contradice el escenario, el hueco es del diseño (`designGap`), no del
  código.
- Dos réplicas con `keySource` distinto (p. ej. header ausente en una): la
  clave debe derivar exactamente del `keySource` declarado.
