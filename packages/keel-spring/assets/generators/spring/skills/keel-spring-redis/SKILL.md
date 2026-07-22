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
- Sigue estrictamente `.claude/skills/keel-generate-spring/conventions/mapping.md`; la estructura de paquetes está en `conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil y compose (abajo); esta skill cubre solo el código que depende de Redis.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-data-redis`.
- `parameters/<perfil>/redis.yaml`: host/puerto por perfil (local apunta al contenedor del compose).
- `infra/docker-compose.yaml`: `redis:7-alpine` o `valkey:8-alpine` (puerto 6379).

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
Recetas completas en `.claude/skills/keel-generate-spring/conventions/infra-validation.md`.
