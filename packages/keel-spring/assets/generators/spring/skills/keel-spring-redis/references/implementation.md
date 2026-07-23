# Redis/Valkey — patrones de implementación

Complementa «Qué implementa el agente» del SKILL.md. Todo vive en
`infrastructure` (la capa application no importa Spring ni Redis).

## Caché de lectura (`cache` en queries del diseño)

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration base = RedisCacheConfiguration.defaultCacheConfig()
                .prefixCacheNameWith("<servicio>:")
                .serializeValuesWith(RedisSerializationContext.SerializationPair
                        .fromSerializer(new GenericJackson2JsonRedisSerializer()))
                .disableCachingNullValues();
        return RedisCacheManager.builder(factory)
                // Una configuración por caché con el TTL del diseño (cache.ttlSeconds).
                .withCacheConfiguration("product-by-id", base.entryTtl(Duration.ofSeconds(300)))
                .build();
    }
}
```

- `@Cacheable` va en el **adaptador** del puerto (o un decorator del puerto),
  nunca en el handler: la caché es infraestructura.
- Clave = `keyFields` del diseño en el orden declarado
  (`key = "#id"` o SpEL compuesto `"#a + ':' + #b"`).
- **`sync = true`** en `@Cacheable`: ante expiración con concurrencia, un solo
  hilo repuebla y el resto espera (evita la estampida contra la BD).
- Invalidación: `@CacheEvict` en los adaptadores de los commands que mutan la
  misma entidad — repasa el diseño: cada command que toca la entidad cacheada
  debe evictar, o servirás datos obsoletos más allá del TTL.
- No caches nulls ni errores; no caches resultados de commands.

## Tolerancia a caída de Redis

La caché nunca puede tumbar la funcionalidad: si Redis cae, se degrada a miss
y se va a la BD. Registra un `CacheErrorHandler` que loguee y siga:

```java
@Bean
public CacheErrorHandler cacheErrorHandler() {
    return new LoggingCacheErrorHandler(); // get/put fallidos → log WARN, no excepción
}
```

(Si necesitas comportamiento distinto por operación, extiende
`CacheErrorHandler`; la regla es: error de caché ≠ error de negocio.)

## Idempotencia (`idempotency` en commands del diseño)

Esta es la idempotencia **del cliente HTTP**: la que evita que reintentar una
petición ejecute el comando dos veces. No la confundas con la idempotencia de
**consumo de mensajes**, que ya resuelve `IdempotencyGuard`
(`infrastructure/messaging/idempotency/`, tabla `processed_event`) y que los
listeners usan tal cual — no la reimplementes con Redis.

`SET NX EX` atómico sobre la clave derivada de `keySource`:

```java
Boolean first = redisTemplate.opsForValue()
        .setIfAbsent("<servicio>:idem:" + key, "1", Duration.ofSeconds(ttl));
if (Boolean.FALSE.equals(first)) {
    // Repetida dentro del TTL: devuelve el resultado previo o el conflicto
    // que dicte el diseño; NUNCA re-ejecutes la operación.
}
```

- La clave se marca **antes** de ejecutar; si la operación falla con error de
  negocio, decide según el diseño si liberas la clave (`DELETE`) para permitir
  reintento — y documenta la decisión.
- A diferencia de la caché, aquí un Redis caído sí es un dilema: aceptar la
  operación (riesgo de duplicado) o rechazarla (503). Si el diseño no lo dice,
  es un `designGap` — repórtalo.

## Naming de claves

`<servicio>:<uso>:<id>` — p. ej. `product-catalog:product-by-id:42`,
`product-catalog:idem:req-abc`. Prefijo de servicio siempre; minúsculas y
`:` como separador (así `redis-cli --scan --pattern 'product-catalog:*'`
inspecciona lo tuyo y solo lo tuyo).

## Estampida y TTLs

- `sync = true` cubre la estampida por expiración puntual.
- Si muchas claves se crean a la vez (p. ej. tras un reset de datos), añade
  jitter al TTL (±10%) al poblarlas por código para que no expiren en masa.

## Checklist

- [ ] Un `RedisCacheConfiguration` por caché, TTL = `cache.ttlSeconds` del diseño.
- [ ] `@Cacheable(sync = true)` en adaptador/decorator, nunca en el handler.
- [ ] `@CacheEvict` en todos los commands que mutan la entidad cacheada.
- [ ] `CacheErrorHandler` registrado: Redis caído degrada a miss.
- [ ] Claves de idempotencia con `SET NX EX` y TTL del diseño.
- [ ] Toda clave con TTL; prefijo `<servicio>:` en todas.
