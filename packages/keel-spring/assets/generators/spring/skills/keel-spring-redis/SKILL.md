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
- Sigue estrictamente `.claude/conventions/mapping.md`; la estructura de paquetes está en `.claude/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil y compose (abajo); esta skill cubre solo el código que depende de Redis.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-data-redis`.
- `parameters/<perfil>/redis.yaml`: host/puerto por perfil (local apunta al contenedor del compose).
- `infra/docker-compose.yaml`: `redis:7-alpine` o `valkey:8-alpine` (puerto 6379).
- `infrastructure/configurations/cache/CacheConfig.java`: `@EnableCaching`, el
  `RedisCacheManager`, una constante por caché del diseño con su TTL, el
  serializador JSON con `JavaTimeModule` (obligatorio: los agregados traen
  timestamps) y el `CacheErrorHandler` que degrada a miss. **Úsalo tal cual.**
- `infra/reset-db.sh`: además de vaciar la BD, borra las claves `<servicio>:*`.

## Qué implementa el agente

La caché se activa porque alguna operación del diseño declara `cache`
(`ttlSeconds`, `keyFields`) y/o `idempotency` (`keySource`, `ttlSeconds`).

- **Caché de lectura** (`cache` en queries): anota el adaptador (o un decorator
  del puerto) con `@Cacheable(cacheNames = CacheConfig.<OPERACION>_CACHE, …)` —
  la capa application no importa Spring, y el `CacheManager` ya está generado.
  Clave = `keyFields` en el orden declarado. Invalida (`@CacheEvict`) en los
  commands que mutan la misma entidad.
- **Idempotencia** (`idempotency` en commands): guarda la clave
  (`keySource`, p. ej. el header del cliente) con `SET NX EX <ttlSeconds>`;
  si ya existe, devuelve el resultado previo o el conflicto que dicte el diseño,
  sin re-ejecutar la operación.

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
Recetas completas en `.claude/conventions/infra-validation.md`.
