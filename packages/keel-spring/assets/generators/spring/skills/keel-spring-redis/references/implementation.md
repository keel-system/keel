# Redis/Valkey — patrones de implementación

Complementa «Qué implementa el agente» del SKILL.md. Todo vive en
`infrastructure` (la capa application no importa Spring ni Redis).

## Caché de lectura (`cache` en queries del diseño)

**`CacheConfig` ya existe**: build lo genera en
`infrastructure/configurations/cache/` con `@EnableCaching`, el `RedisCacheManager`,
una constante `public static final String <OPERACION>_CACHE` por operación con
`cache` en el diseño, su TTL (`cache.ttlSeconds`), `disableCachingNullValues()`,
el `CacheErrorHandler` que degrada a miss y el `ObjectMapper` de la caché con
`JavaTimeModule` registrado. **No lo reescribas ni añadas otro `CacheManager`**:
tu trabajo es anotar los adaptadores usando esas constantes.

```java
@Cacheable(cacheNames = CacheConfig.GET_PRODUCT_BY_SLUG_CACHE, key = "#slug", sync = true)
public Optional<Product> findBySlug(String slug) { … }
```

El serializador es JSON con soporte `java.time`: **cualquier configuración
adicional que serialice valores debe registrar `JavaTimeModule` igual**. Un
`ObjectMapper` por defecto revienta con `Instant`/`LocalDate` — y casi todo
agregado del DSL trae timestamps de auditoría, así que el fallo aparece en la
primera lectura cacheada, en runtime, contra el servidor real.

- `@Cacheable` va en el **adaptador** del puerto (o un decorator del puerto),
  nunca en el handler: la caché es infraestructura.
- Clave = `keyFields` del diseño en el orden declarado
  (`key = "#id"` o SpEL compuesto `"#a + ':' + #b"`).
- **`sync = true`** en `@Cacheable`: ante expiración con concurrencia, un solo
  hilo repuebla y el resto espera (evita la estampida contra la BD).
- **Nunca `unless` junto a `sync = true`**: Spring rechaza la combinación en
  tiempo de ejecución con
  `IllegalStateException: A sync=true operation does not support the unless attribute`,
  así que la primera lectura cacheada devuelve `500`. No compila-y-falla: falla
  en runtime, contra el servidor real.
- **Un solo caché por método con `sync = true`**: la restricción no es evidente
  por el nombre de la anotación, pero Spring solo admite un `cacheNames` cuando
  `sync = true`, y tampoco admite dos `@Cacheable(sync = true)` combinados en un
  `@Caching`. Falla con
  `IllegalStateException: @Cacheable(sync=true) only allows a single cache on ...`
  en **cada** invocación, no al arrancar. Si dos operaciones del diseño declaran
  `cache` con la misma clave (p. ej. `getProduct` y `lookupProduct`, ambas por
  `productId`), **no** las cachees en un método con dos `cacheNames`: usa un
  método por caché, o comparte una sola entrada si el valor devuelto es idéntico.
- Para no cachear vacíos, **`disableCachingNullValues()`** en la
  `RedisCacheConfiguration` base (ya está en el `CacheConfig` que genera build):
  es compatible con `sync = true` y cubre el caso sin `unless`. Si lo que quieres
  descartar es un `Optional.empty()` o una lista vacía, devuelve `null` desde el
  adaptador y deja que esa opción decida.
- Invalidación: `@CacheEvict` en los adaptadores de los commands que mutan la
  misma entidad — repasa el diseño: cada command que toca la entidad cacheada
  debe evictar, o servirás datos obsoletos más allá del TTL.
- No caches nulls ni errores; no caches resultados de commands.

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

- `sync = true` cubre la estampida por expiración puntual.
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

- [ ] `CacheConfig` generado por build usado tal cual (no hay un segundo `CacheManager`).
- [ ] Toda config que serialice valores registra `JavaTimeModule`.
- [ ] `@Cacheable(sync = true)` en adaptador/decorator, nunca en el handler.
- [ ] Ningún `@Cacheable` combina `unless` con `sync = true` (los vacíos los
      descarta `disableCachingNullValues()`).
- [ ] Ningún `@Cacheable(sync = true)` declara más de un `cacheNames`, y ningún
      `@Caching` combina dos entradas con `sync = true`.
- [ ] `@CacheEvict` en todos los commands que mutan la entidad cacheada.
- [ ] Claves de idempotencia con `SET NX EX` y TTL del diseño.
- [ ] Toda clave con TTL; prefijo `<servicio>:` en todas.
