# Robustez del servidor generado por `keel-spring`

Este documento describe, punto por punto, los problemas de robustez detectados en el
**scaffolding transversal al stack** que `keel-spring build` genera para el servidor Spring, y qué
resuelve cada uno. **Todos los puntos accionables están subsanados** (1-4, 6 y 7, implementados en
`packages/keel-spring/src/scaffold/`); el punto 5 queda fuera de alcance (lo resuelve el API gateway).

> **Alcance.** Todo lo que sigue vive en el código *transversal al stack* — el que `build` escribe
> igual sea cual sea la BD, el broker o el proveedor de auth. No afecta a la frontera que completa el
> agente (envío al broker, adaptador de storage).

---

## Resumen

| # | Problema | Severidad | Estado |
|---|----------|-----------|--------|
| 1 | Sin Actuator: no hay probes ni métricas | Alta | ✅ Subsanado |
| 2 | Sin bloqueo optimista: *lost update* silencioso | Alta | ✅ Subsanado |
| 3 | `OutboxRelay` no seguro multi-instancia + sin tope de intentos | Alta | ✅ Subsanado |
| 4 | Sin graceful shutdown | Media | ✅ Subsanado |
| 5 | Sin protección de sobrecarga entrante | Media | 🚫 Fuera de alcance (lo resuelve el API gateway) |
| 6 | Reintento del outbox sin backoff | Media | ✅ Subsanado |
| 7 | Pool de conexiones (Hikari) sin tuning expuesto | Baja | ✅ Subsanado |

---

## ✅ 1. Sin Actuator — no había probes ni métricas

### El problema

`SecurityConfig` permitía el acceso público a `/actuator/health/**`, pero **la dependencia
`spring-boot-starter-actuator` no estaba en `build.gradle`**. El resultado: la regla de seguridad
apuntaba a un endpoint que **no existía**.

Consecuencias en un despliegue real (Kubernetes u orquestador equivalente):

- **Sin liveness probe**: el orquestador no puede saber si el proceso está *vivo* (colgado, deadlock,
  memoria agotada) para reiniciarlo.
- **Sin readiness probe**: no puede saber si el pod está *listo para recibir tráfico* (BD conectada,
  migraciones aplicadas, broker accesible). Sin esto, el balanceador enruta peticiones a un pod que
  aún no puede atenderlas → errores durante cada arranque/rollout.
- **Sin métricas**: no hay endpoint para observabilidad operacional (latencias, uso de pool, GC…).

### Qué resuelve

Un servidor con Actuator publica health checks que el orquestador consume para tomar decisiones de
routing y reinicio. Es la pieza mínima de observabilidad operacional que separa "el proceso arranca"
de "el servicio está sano y sirviendo".

### Cómo se subsanó

- **`gradle.js`**: se añade siempre `implementation 'org.springframework.boot:spring-boot-starter-actuator'`.
- **`config.js`**: nuevo fragmento `management` por perfil que:
  - expone `health,info,metrics`;
  - activa los grupos de probes → `/actuator/health/liveness` y `/actuator/health/readiness`;
  - `show-details: never` en production (no filtrar internals) y `always` en el resto.
- Los health indicators de BD/broker/redis los **autoconfiguran los starters ya presentes**, así que
  el readiness refleja el estado de las dependencias sin código extra.

---

## ✅ 2. Sin bloqueo optimista — *lost update* silencioso

### El problema

Ninguna entidad JPA llevaba `@Version`. En un modelo de escritura CQRS con agregados, esto abre la
puerta al **lost update** (actualización perdida):

1. La petición A lee el agregado `Product{stock: 10}`.
2. La petición B lee el mismo agregado `Product{stock: 10}`.
3. A descuenta 3 y guarda → `stock: 7`.
4. B descuenta 5 sobre *su* copia (que aún cree que hay 10) y guarda → `stock: 5`.

El descuento de A **se pierde sin ningún error**. El sistema queda en un estado incorrecto y nadie se
entera. Es uno de los bugs de concurrencia más difíciles de diagnosticar porque no deja rastro.

### Qué resuelve

El bloqueo optimista hace que la base de datos **detecte** la escritura sobre una versión obsoleta y
la rechace, en vez de sobrescribir en silencio. La operación perdedora recibe un error explícito
(que se traduce a **409 Conflict**) y el cliente puede releer y reintentar con el estado actual.
Convierte una corrupción silenciosa en un conflicto visible y recuperable.

### Cómo se subsanó (Opción A: versión en la raíz de agregado)

El reto técnico: el adaptador de repositorio **construye una `XxxJpa` nueva en cada `save()`**, así
que `@Version` solo en la entidad JPA no bastaría — Hibernate perdería la versión en el ida-y-vuelta.
Por eso la versión **viaja por el dominio**:

- **`persistence-entities.js`**: `@Version @Column(name = "version") private Long version;` en la
  raíz de agregado (JPA).
- **`entities.js`**: la raíz de dominio porta `version`, que entra como **último parámetro del
  constructor de rehidratación** y expone `getVersion()`.
- **`repositories.js`**: el mapeo la propaga en ambos sentidos (`toDomain` → `new Product(..., jpa.getVersion())`;
  `toJpa` → `jpa.setVersion(domain.getVersion())`).
- **`controllers.js`**: nuevo handler que traduce `ObjectOptimisticLockingFailureException` a
  **409 `OPTIMISTIC_LOCK_CONFLICT`**, para que un conflicto no caiga en el catch-all como 500.

Todo gateado por `isAggregateRoot`: la **raíz es la frontera de consistencia** (DDD), las entidades
hijas no llevan versión propia.

> **Limitación conocida.** El `@Version` de la raíz protege el caso común. Si dos peticiones modifican
> **solo hijas distintas** del agregado sin tocar la raíz, JPA no incrementa la versión de la raíz
> automáticamente. Cubrirlo requiere `LockModeType.OPTIMISTIC_FORCE_INCREMENT` — refinamiento futuro.

---

## ✅ 3. `OutboxRelay` no seguro multi-instancia + sin tope de intentos

### El problema

El relay del outbox seleccionaba las filas pendientes con un simple
`select … where published_at is null order by created_at` **sin ningún lock**. Dos problemas:

1. **No es seguro con varias réplicas.** Con el servicio escalado horizontalmente (lo normal en
   producción), *cada* réplica corre su propio relay. Sin lock, todas leen las **mismas** filas
   pendientes y las publican → **eventos duplicados** en el broker, más carreras al escribir
   `published_at`/`attempts` sobre la misma fila. La idempotencia del consumidor mitiga el duplicado,
   pero es trabajo desperdiciado y comportamiento no determinista.
2. **Sin tope de reintentos.** Una fila que falla siempre (un "mensaje venenoso": payload corrupto,
   destino inexistente) se reintentaba **cada segundo, para siempre**, con `attempts` creciendo sin
   límite. Un solo evento defectuoso podía saturar el relay y el log.

### Qué resuelve

- El **lock con SKIP LOCKED** hace que, con N réplicas, cada relay se lleve un lote **disjunto** de
  filas: se paraleliza la entrega sin duplicar ni competir. Es el patrón estándar de cola sobre tabla
  relacional.
- El **tope de intentos (dead-letter)** aísla los mensajes venenosos: tras agotar los reintentos, la
  fila se aparta del flujo normal y se reporta para inspección, sin bloquear al resto ni hot-loopear.

### Cómo se subsanó

- **`outbox.js` — `findPending`**: ahora toma `@Lock(PESSIMISTIC_WRITE)` con
  `@QueryHints(lock.timeout = -2)` (el código de Hibernate para **SKIP LOCKED**), y excluye las filas
  agotadas con `and o.attempts < :maxAttempts`. El lock se sostiene durante la transacción del relay.
- **`outbox.js` — `relay()`**: parámetro `outbox.relay.max-attempts` (default 10). Al fallar, si la
  fila alcanza el tope, se reporta a **`ERROR`** como *dead-letter* (queda parada, fuera de futuros
  polls, sin borrarse) en vez de reintentar indefinidamente.
- **`config.js`**: `outbox.relay.max-attempts` parametrizado en `parameters/<perfil>/messaging.yaml`.

> **Nota H2.** En el perfil `test` (H2) SKIP LOCKED puede degradarse a lock normal; no afecta al gate,
> porque los escenarios `FL-*` se validan contra la BD real de `infra/`.

---

## ✅ 4. Sin graceful shutdown

### El problema

No se configuraba `server.shutdown=graceful` ni `spring.lifecycle.timeout-per-shutdown-phase`. Cuando el
orquestador envía `SIGTERM` (cada deploy, rollout o reescalado), el proceso terminaba de inmediato:

- las **peticiones HTTP en vuelo se cortan** → el cliente recibe errores/timeouts durante cada release;
- el **batch del relay del outbox queda a medias**.

### Qué resuelve

Un apagado ordenado deja de aceptar conexiones nuevas pero **espera** (hasta un timeout) a que las
peticiones en curso terminen antes de morir. Los despliegues dejan de producir errores transitorios.

### Cómo se subsanó

- **`config.js` — `baseYaml`** (transversal, va en el `application.yaml` base porque no varía por
  ambiente):
  - `server.shutdown: graceful` — deja de aceptar conexiones nuevas al recibir `SIGTERM` y drena las
    peticiones en vuelo.
  - `spring.lifecycle.timeout-per-shutdown-phase: ${SHUTDOWN_TIMEOUT:30s}` — margen máximo de espera,
    parametrizado con el gradiente habitual (env var con default 30s, el de Spring), como el `SERVER_PORT`.
- **Sinergia con el punto 1 (Actuator/probes):** con los probes de health ya activos, Spring Boot marca
  automáticamente el readiness como `OUT_OF_SERVICE` en cuanto arranca el apagado, así el balanceador
  deja de enrutar tráfico nuevo mientras el proceso drena. Sin código extra.

---

## 🚫 5. Sin protección de sobrecarga entrante — fuera de alcance

### El problema

resilience4j solo se aplica hoy a los **clientes salientes** (`http-clients.js`, con `@Retry`/`@CircuitBreaker`).
No hay rate limiting, bulkhead ni TimeLimiter en la **entrada**.

### Por qué queda fuera de alcance

En una arquitectura de microservicios típica, el servicio vive **detrás de un API gateway** (o
ingress / service mesh) que ya resuelve la protección de borde: **rate limiting por cliente**,
**DDoS/WAF** y buena parte de los ataques, antes de que el tráfico llegue al servicio. Meter esa misma
protección dentro de cada microservicio sería **redundante** y crearía una segunda fuente de verdad
para las políticas de tasa. Con **virtual threads** ya activados en el proyecto generado y un gateway
delante, el valor marginal de añadirlo al scaffolding es bajo. Por eso **se trata como responsabilidad
de la infraestructura, no del código del servicio**.

### Matices donde el gateway no llega (opcional, no default)

- **Bulkhead entre endpoints del propio servicio**: aislar que un endpoint lento no agote los recursos
  que necesitan los demás. Depende de la capacidad *de esa instancia*, no del borde.
- **Backpressure hacia un downstream lento concreto** (una BD o dependencia puntual).

Si un servicio concreto lo necesitara, el agente puede añadirlo puntualmente; no forma parte del
scaffolding transversal por defecto.

---

## ✅ 6. Reintento del outbox sin backoff

### El problema

El relay reintentaba las filas pendientes cada `fixed-delay-ms` (1s) **sin backoff exponencial**. Ante
una caída del broker, todas las filas fallan y se reintentan cada segundo en bucle apretado
(*hot-looping*): consumo inútil de CPU/BD y log ruidoso justo cuando el sistema ya está degradado.

> El tope de intentos del punto 3 acota el daño (una fila deja de reintentarse tras N fallos), pero no
> espacia los reintentos mientras tanto.

### Qué resuelve

Un backoff espacia los reintentos crecientemente (1s, 2s, 4s…, con tope), aliviando la presión sobre un
broker que se recupera y reduciendo el ruido operacional.

### Cómo se subsanó

La política de backoff vive en el **relay** (que ya tiene la config vía `@Value`), no en la entidad JPA:
el relay calcula el `Instant` del próximo intento y se lo pasa a la fila por un setter.

- **`outbox.js` — `OutboxEventJpa`**: nueva columna nullable `next_attempt_at` (momento a partir del
  cual la fila vuelve a ser elegible; `null` = elegible ya) + setter `scheduleNextAttempt(Instant)`.
- **`outbox.js` — `findPending`**: el `@Query` añade `and (o.nextAttemptAt is null or o.nextAttemptAt
  <= :now)`; el relay pasa `Instant.now()`. Así el relay sigue despertando cada segundo, pero devuelve
  vacío mientras las filas esperan su turno → se corta el hot-looping sin tocar la cadencia del `@Scheduled`.
- **`outbox.js` — `OutboxRelay`**: al fallar una entrega que aún no agotó los reintentos, fija
  `now + backoffDelayMs(attempts)`, donde `backoffDelayMs = min(max-ms, initial-ms · 2^(attempts-1))`
  (en `long`, con guarda de desplazamiento para no desbordar). Multiplicador 2, igual que el retry
  saliente de resilience4j en `http-clients.js`.
- **`config.js`**: `outbox.relay.backoff.initial-ms` (1000) y `outbox.relay.backoff.max-ms` (60000)
  parametrizados en `parameters/<perfil>/messaging.yaml` con el gradiente habitual.

> **Compatibilidad hacia atrás.** La columna es nullable y las filas antiguas con `next_attempt_at =
> null` se tratan como elegibles. En `local` la crea `ddl-auto: update`; el baseline de `db/migration/`
> lo exporta el agente de calidad desde las entidades finales, así que la columna fluye sola.

---

## ✅ 7. Pool de conexiones (Hikari) sin tuning expuesto

### El problema

El pool de conexiones quedaba con los valores por defecto de Hikari; `maximum-pool-size` y
`connection-timeout` no se parametrizaban en `parameters/`. Bajo carga, el sizing del pool es
determinante (un pool corto serializa las peticiones; uno largo puede saturar la BD), y no se podía
ajustar por ambiente sin editar el proyecto a mano.

### Qué resuelve

Exponer el tuning del pool por variable de entorno permite dimensionarlo por ambiente (más en
production, menos en local) sin tocar código, que es la premisa del gradiente de configuración de Keel.

### Cómo se subsanó

- **`config.js` — `dbYaml`**: nuevo bloque `spring.datasource.hikari` con `maximum-pool-size` y
  `connection-timeout`, parametrizados con el helper `envWithDefault` (literal en local → env var con
  default en develop/production), el mismo gradiente que `LOG_LEVEL_*` y `MANAGEMENT_*`:
  - `maximum-pool-size` → env var `DB_POOL_MAX_SIZE` (default 10).
  - `connection-timeout` → env var `DB_POOL_CONNECTION_TIMEOUT_MS` (default 30000 ms).
- Los defaults coinciden con los de Hikari, así que **el comportamiento no cambia** salvo override
  explícito por ambiente. El perfil `test` (H2) arma su propio fragmento `db` y no lleva este bloque.

---

## Verificación de los puntos subsanados

- **Tests del generador** (`npm test --workspace packages/keel-spring`): en verde, con aserciones que
  fijan actuator/management, `@Version` en JPA/dominio/adaptador, handler 409, y el repositorio/relay
  del outbox (lock, SKIP LOCKED, `max-attempts`, dead-letter).
- **En el proyecto generado**: `./gradlew build -x test` en verde; arrancar `PROFILE=local` y
  comprobar `/actuator/health/{liveness,readiness}` = `UP`; la validación en vivo de los escenarios
  `FL-*` corre contra la BD/broker reales de `infra/`.
