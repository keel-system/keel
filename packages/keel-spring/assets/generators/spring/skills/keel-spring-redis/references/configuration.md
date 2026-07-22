# Redis/Valkey — configuración y tuning

Propiedades `spring.data.redis.*` que el agente puede necesitar en
`parameters/<perfil>/redis.yaml`. Build ya dejó `host`/`port` con el gradiente
por perfil: **no las toques**; añade el resto solo si hace falta.

## Timeouts (siempre recomendable fijarlos)

```yaml
spring:
  data:
    redis:
      # Timeout de comando: sin él, un Redis colgado bloquea el handler
      # indefinidamente. La caché nunca debe ser más lenta que ir a la BD.
      timeout: 500ms
      connect-timeout: 2s
```

## Pool de conexiones (Lettuce)

Lettuce multiplexa sobre **una** conexión compartida: para caché con
`RedisTemplate`/`RedisCacheManager` **no necesitas pool** — no lo añadas por
inercia. Actívalo solo si usas comandos bloqueantes o transacciones Redis:

```yaml
spring:
  data:
    redis:
      lettuce:
        pool:
          enabled: true
          max-active: 8
          max-idle: 8
          min-idle: 0
          max-wait: 500ms   # -1 (default) espera indefinidamente: acótalo
```

El pool exige `org.apache.commons:commons-pool2` en `build.gradle`
(añádelo tú: build no lo incluye porque el caso base no lo usa).

## TTLs y serialización (van en código, no en YAML)

- Los TTL por caché salen del **diseño** (`cache.ttlSeconds` de cada
  operación) y se fijan en el `RedisCacheConfiguration` de cada caché — no
  inventes TTLs ni los pongas en YAML desconectados del diseño.
- Serialización de valores: `GenericJackson2JsonRedisSerializer` (legible,
  tolera evolución de clases). El default JDK acopla los bytes a la clase
  Java: un refactor invalida la caché entera o revienta al leer.
- Claves siempre `StringRedisSerializer` con prefijo del servicio
  (`<servicio>:...`): inspeccionables con `redis-cli` y sin colisiones si el
  Redis se comparte.

## Por perfil

- **local**: contenedor del compose (`localhost:6379`), sin password.
- **develop/production**: host por env var (ya en el gradiente); si el Redis
  real exige auth/TLS añade `password: ${REDIS_PASSWORD}` y `ssl.enabled: true`
  siguiendo el gradiente (nunca literal fuera de local).
- Valkey: idénticas propiedades (protocolo Redis); solo cambia la imagen.

## Qué no hacer

- No configures Redis como si fuera un almacén durable: aquí es caché e
  idempotencia; la fuente de verdad es siempre la BD. Toda clave debe tener
  TTL (una clave sin TTL es una fuga de memoria en Redis).
- No compartas una misma caché entre operaciones con TTLs distintos: una
  caché por política del diseño.
- No apuntes tests unitarios a Redis: el perfil test no lo configura; la
  caché se ejercita en los escenarios contra la infra real.
