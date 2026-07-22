# Redis / Valkey (cache: `redis` o `valkey`)

Valkey es compatible con el protocolo Redis: mismo starter, mismo cliente, mismas
recetas; solo cambia la imagen del compose.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-data-redis`.
- `parameters/<perfil>/redis.yaml`: host/puerto por perfil (local apunta al contenedor del compose).
- `docker-compose.yaml`: `redis:7-alpine` o `valkey:8-alpine` (puerto 6379).

## Qué implementa el agente

La caché se activa porque alguna operación del diseño declara `cache`
(`ttlSeconds`, `keyFields`) y/o `idempotency` (`keySource`, `ttlSeconds`).

- **Caché de lectura** (`cache` en queries): impleméntala en infraestructura —
  la capa application no importa Spring. Opciones: `@EnableCaching` +
  `RedisCacheManager` con un `RedisCacheConfiguration` por caché fijando el TTL
  del diseño, aplicando `@Cacheable` en el adaptador o en un decorator del
  puerto (clave = `keyFields` en el orden declarado); o `RedisTemplate` directo
  si necesitas control fino. Invalida (`@CacheEvict` o `delete`) en los commands
  que mutan la misma entidad.
- **Idempotencia** (`idempotency` en commands): guarda la clave
  (`keySource`, p. ej. el header del cliente) con `SET NX EX <ttlSeconds>`;
  si ya existe, devuelve el resultado previo o el conflicto que dicte el diseño,
  sin re-ejecutar la operación.

## Validación

Desde devtools: `redis-cli -h redis PING` (o `-h valkey`); `redis-cli -h redis KEYS '*'`
y `TTL <clave>` para verificar entradas y expiraciones tras ejercitar los escenarios.
Ver `conventions/infra-validation.md`.
