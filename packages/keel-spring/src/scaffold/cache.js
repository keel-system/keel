// Caché de lectura (`use-cases.<op>.cache`). Se genera siempre que alguna operación del diseño la
// declare, porque nada de esto depende del store elegido (redis y valkey hablan el mismo protocolo y
// usan el mismo starter):
//
//   · CacheConfig: el RedisCacheManager con el TTL de cada caché y la degradación a miss;
//   · el puerto OperationCache (application/port/out) y su adaptador RedisOperationCache: se cachea la
//     RESPUESTA de la operación como el JSON del contrato, escrita con el ObjectMapper de la aplicación,
//     igual que keel-nest. Es lo que escribieron los agentes de las dos corridas de keel-spring
//     (GetAssetCache, ResponseCache), cada uno con su nombre: @Cacheable no expresa ni la ficha degradada
//     que no se guarda ni el alcance que se comprueba también en el acierto;
//   · CachedOperations (application/support): el nombre de cada caché y cómo sale su clave del mensaje;
//   · la INVALIDACIÓN, en el UseCaseMediator (mediator.js): vacía la caché entera tras el commit de cada
//     operación que emite o consume uno de sus eventos. Es un hecho del diseño, no del agente.
//
// Lo que queda para el agente es DÓNDE se consulta: en el handler, después de lo que dependa de quién
// llama (skill keel-spring-redis).

import { cachedOperations, cacheInvalidations, CACHE_KEY_PART_SEPARATOR } from '@keel-system/keel-core/gen/cache-plan';
import { returnTypeOf, returnTypeImports, messagePackage } from './services.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { timestampModuleImport } from './jackson.js';
import { usesTelemetry } from '../lib/telemetry-probes.js';

const CACHE_PKG = 'infrastructure.configurations.cache';

// Operaciones con política de caché declarada, con el nombre de caché que las
// identifica: <servicio>:<operación>. RedisCacheManager le añade "::<clave>". Es
// neutral (keel-core/gen/cache-plan.js): keel-nest nombra sus cachés igual, y el
// reset de infra/ borra las de los dos servidores con la misma orden.
export { cachedOperations };

export const OPERATION_CACHE_PKG = 'application.port.out';
export const CACHED_OPERATIONS_PKG = 'application.support';

export function usesOperationCache(model) {
  return cachedOperations(model).length > 0;
}

export function generate(model) {
  const caches = cachedOperations(model);
  if (caches.length === 0) return [];

  return [
    {
      path: javaPath(model, CACHE_PKG, 'CacheConfig'),
      content: javaFile(subPackage(model, CACHE_PKG), imports(model), body(model, caches))
    },
    renderOperationCache(model),
    renderCachedOperations(model, caches),
    renderRedisOperationCache(model, caches)
  ];
}

function operationsByName(model) {
  return new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
}

/** Qué cachés vacía cada operación al confirmar, para el UseCaseMediator (keel-core/gen/cache-plan.js). */
export function mediatorCacheInvalidations(model) {
  const operations = operationsByName(model);
  return cacheInvalidations(model).map((entry) => {
    const operation = operations.get(entry.operation);
    return { ...entry, messageImport: `${subPackage(model, messagePackage(operation))}.${operation.messageClass}` };
  });
}

// ─── application/port/out/OperationCache ─────────────────────────────────────

function renderOperationCache(model) {
  const body = `/**
 * La caché de lectura del diseño (use-cases.<operación>.cache). Guarda la RESPUESTA de la operación, no el
 * agregado: lo que sale de aquí es, campo a campo, lo que habría servido el origen. Las cachés y sus claves
 * están en {@code CachedOperations}.
 *
 * <p>La consulta el HANDLER de la operación, después de todo lo que dependa de quién llama: la clave es la
 * entrada de la operación y no el llamante, así que una respuesta servida antes de comprobar el alcance se le
 * serviría a cualquiera.
 *
 * <p>Un store caído o una entrada ilegible no son errores: degradan a miss y la respuesta sale del origen.
 * Nada nulo se guarda.
 */
public interface OperationCache {

    /**
     * La respuesta cacheada en {@code cache} para {@code key}, o la que da {@code load}, que se guarda con el
     * TTL de la caché. Con varias peticiones a la vez sobre la misma entrada, carga UNA y las demás esperan.
     */
    <T> T getOrLoad(String cache, String key, Supplier<T> load);

    /**
     * Igual, pero solo guarda la respuesta si {@code cacheable} la acepta. Es para lo que el diseño no quiere
     * ver servido durante el TTL: una ficha DEGRADADA porque un proveedor no contestó se sirve y no se guarda.
     */
    <T> T getOrLoad(String cache, String key, Supplier<T> load, Predicate<? super T> cacheable);

    /** Desaloja una entrada. Tras el commit, si hay una transacción en curso. */
    void evict(String cache, String key);

    /**
     * Vacía la caché entera. Tras el commit, si hay una transacción en curso. No hace falta por los eventos de
     * invalidatedBy: eso ya lo hace el UseCaseMediator al confirmar cada operación que los emite o los consume.
     */
    void clear(String cache);
}`;
  return {
    path: javaPath(model, OPERATION_CACHE_PKG, 'OperationCache'),
    content: javaFile(subPackage(model, OPERATION_CACHE_PKG), ['java.util.function.Predicate', 'java.util.function.Supplier'], body)
  };
}

// ─── application/support/CachedOperations ────────────────────────────────────

function renderCachedOperations(model, caches) {
  const operations = operationsByName(model);
  const imports = new Set(['java.util.Arrays', 'java.util.stream.Collectors']);
  const invalidators = new Map();
  for (const entry of cacheInvalidations(model)) {
    for (const cache of entry.caches) {
      if (!invalidators.has(cache.cacheName)) invalidators.set(cache.cacheName, []);
      invalidators.get(cache.cacheName).push(entry.operation);
    }
  }
  const members = caches.map((cache) => {
    const operation = operations.get(cache.operation);
    imports.add(`${subPackage(model, messagePackage(operation))}.${operation.messageClass}`);
    const param = operation.messageKind === 'query' ? 'query' : 'command';
    const keyExpr = cache.keyFields.length > 0 ? `key(${cache.keyFields.map((field) => `${param}.${field}()`).join(', ')})` : '"all"';
    const by = invalidators.get(cache.cacheName) ?? [];
    const doc = [
      `Caché de ${cache.operation}: TTL ${cache.ttlSeconds} s, clave por ${cache.keyFields.join(', ') || 'ningún campo (una sola entrada)'}.`,
      cache.invalidatedBy.length > 0
        ? `La invalidan ${cache.invalidatedBy.join(', ')}: la vacían ENTERA, al confirmar, ${by.length > 0 ? by.join(', ') : 'ninguna operación de este servicio (solo caduca por su TTL)'} (lo hace el UseCaseMediator).`
        : 'Ningún evento la invalida: solo caduca por su TTL.'
    ];
    return `    /**
     * ${doc.join('\n     * ')}
     */
    public static final String ${cache.constant} = "${cache.cacheName}";

    /** La clave de una entrada de {@link #${cache.constant}}: los keyFields del diseño, en su orden. */
    public static String ${operation.name}Key(${operation.messageClass} ${cache.keyFields.length > 0 ? param : 'ignored'}) {
        return ${keyExpr};
    }`;
  });
  const body = `/**
 * Las cachés de lectura que declara use-cases.keel.yaml: el nombre de cada una en el store y cómo se compone
 * su clave desde el mensaje de la operación. El nombre y el TTL salen del diseño —cambiarlos a mano los
 * desalinea del contrato y del servidor de keel-nest del mismo diseño, que nombra igual sus cachés— y las
 * claves en el store son las de RedisCacheManager: {@code <caché>::<clave>}.
 */
public final class CachedOperations {

    private CachedOperations() {
    }

${members.join('\n\n')}

    /** Los componentes de una clave compuesta, en su orden, separados por '${CACHE_KEY_PART_SEPARATOR}' (la misma forma que keel-nest). */
    static String key(Object... parts) {
        return Arrays.stream(parts).map(String::valueOf).collect(Collectors.joining("${CACHE_KEY_PART_SEPARATOR}"));
    }
}`;
  return {
    path: javaPath(model, CACHED_OPERATIONS_PKG, 'CachedOperations'),
    content: javaFile(subPackage(model, CACHED_OPERATIONS_PKG), [...imports], body)
  };
}

// ─── infrastructure/configurations/cache/RedisOperationCache ──────────────────

function renderRedisOperationCache(model, caches) {
  const operations = operationsByName(model);
  const imports = new Set([
    `${subPackage(model, OPERATION_CACHE_PKG)}.OperationCache`,
    `${subPackage(model, CACHED_OPERATIONS_PKG)}.CachedOperations`,
    'tools.jackson.core.type.TypeReference',
    'tools.jackson.databind.JavaType',
    'tools.jackson.databind.ObjectMapper',
    'java.util.Map',
    'java.util.concurrent.ConcurrentHashMap',
    'java.util.concurrent.locks.ReentrantLock',
    'java.util.function.Predicate',
    'java.util.function.Supplier',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.cache.Cache',
    'org.springframework.cache.CacheManager',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.support.TransactionSynchronization',
    'org.springframework.transaction.support.TransactionSynchronizationManager'
  ]);
  const types = caches.map((cache) => {
    const operation = operations.get(cache.operation);
    returnTypeImports(model, operation, imports);
    return `                Map.entry(CachedOperations.${cache.constant}, mapper.getTypeFactory().constructType(new TypeReference<${returnTypeOf(operation)}>() {}))`;
  });
  const body = `/**
 * El adaptador de {@link OperationCache} sobre el {@code CacheManager} de {@link CacheConfig}.
 *
 * <p>La respuesta se guarda como su JSON de contrato, escrito con el {@code ObjectMapper} de la aplicación —el
 * mismo que la sirve por HTTP—, y se lee con su tipo: lo que vuelve de la caché es byte a byte lo que habría
 * servido el origen, instantes y decimales incluidos. Guardar el record con el serializador tipado de la caché
 * dependería de que Jackson sepa reconstruir colecciones inmutables.
 *
 * <p>Toda interacción con el store degrada a miss: una caché caída no tumba la lectura.
 */
@Component
public class RedisOperationCache implements OperationCache {

    private static final Logger log = LoggerFactory.getLogger(RedisOperationCache.class);

    private final CacheManager cacheManager;
    private final ObjectMapper mapper;
    /** El tipo de la respuesta de cada caché, para leer su JSON. Sale de la operación del diseño. */
    private final Map<String, JavaType> responseTypes;
    /** Una carga por entrada: las demás peticiones a la misma esperan a su resultado. */
    private final Map<String, ReentrantLock> loading = new ConcurrentHashMap<>();

    public RedisOperationCache(CacheManager cacheManager, ObjectMapper mapper) {
        this.cacheManager = cacheManager;
        this.mapper = mapper;
        this.responseTypes = Map.ofEntries(
${types.join(',\n')});
    }

    @Override
    public <T> T getOrLoad(String cache, String key, Supplier<T> load) {
        return getOrLoad(cache, key, load, value -> true);
    }

    @Override
    public <T> T getOrLoad(String cache, String key, Supplier<T> load, Predicate<? super T> cacheable) {
        T hit = read(cache, key);
        if (hit != null) {
            return hit;
        }
        String entry = cache + "::" + key;
        ReentrantLock lock = loading.computeIfAbsent(entry, ignored -> new ReentrantLock());
        lock.lock();
        try {
            hit = read(cache, key);
            if (hit != null) {
                return hit;
            }
            T value = load.get();
            if (value != null && cacheable.test(value)) {
                write(cache, key, value);
            }
            return value;
        } finally {
            lock.unlock();
            if (!lock.hasQueuedThreads()) {
                loading.remove(entry, lock);
            }
        }
    }

    @Override
    public void evict(String cache, String key) {
        afterCommit(() -> {
            Cache store = store(cache);
            if (store != null) {
                store.evict(key);
            }
        }, "invalidar", cache);
    }

    @Override
    public void clear(String cache) {
        afterCommit(() -> {
            Cache store = store(cache);
            if (store != null) {
                store.clear();
            }
        }, "vaciar", cache);
    }

    @SuppressWarnings("unchecked")
    private <T> T read(String cache, String key) {
        try {
            Cache store = store(cache);
            String json = store == null ? null : store.get(key, String.class);
            return json == null ? null : (T) mapper.readValue(json, typeOf(cache));
        } catch (Exception failure) {
            degraded("leer", cache, failure);
            return null;
        }
    }

    private void write(String cache, String key, Object value) {
        try {
            Cache store = store(cache);
            if (store != null) {
                store.put(key, mapper.writeValueAsString(value));
            }
        } catch (Exception failure) {
            degraded("escribir", cache, failure);
        }
    }

    private Cache store(String cache) {
        return cacheManager.getCache(cache);
    }

    private JavaType typeOf(String cache) {
        JavaType type = responseTypes.get(cache);
        if (type == null) {
            throw new IllegalArgumentException("'" + cache + "' no es una caché del diseño (CachedOperations)");
        }
        return type;
    }

    /** Lo que cambia el store va DESPUÉS del commit: un desalojo antes dejaría que otra lectura cachease lo viejo. */
    private void afterCommit(Runnable action, String verb, String cache) {
        Runnable guarded = () -> {
            try {
                action.run();
            } catch (RuntimeException failure) {
                degraded(verb, cache, failure);
            }
        };
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    guarded.run();
                }
            });
        } else {
            guarded.run();
        }
    }

    private static void degraded(String verb, String cache, Exception failure) {
        log.warn("Caché {} no disponible al {}: se sirve desde el origen", cache, verb, failure);
    }
}`;
  return {
    path: javaPath(model, CACHE_PKG, 'RedisOperationCache'),
    content: javaFile(subPackage(model, CACHE_PKG), [...imports], body)
  };
}

function imports(model) {
  return [
    timestampModuleImport(model),
    'com.fasterxml.jackson.annotation.JsonAutoDetect',
    'com.fasterxml.jackson.annotation.PropertyAccessor',
    'tools.jackson.databind.MapperFeature',
    'tools.jackson.databind.cfg.ConstructorDetector',
    'tools.jackson.databind.cfg.DateTimeFeature',
    'tools.jackson.databind.json.JsonMapper',
    'java.time.Duration',
    'java.util.LinkedHashMap',
    'java.util.Map',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.cache.Cache',
    'org.springframework.cache.annotation.CachingConfigurer',
    'org.springframework.cache.annotation.EnableCaching',
    'org.springframework.cache.interceptor.CacheErrorHandler',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.data.redis.cache.RedisCacheConfiguration',
    'org.springframework.data.redis.cache.RedisCacheManager',
    'org.springframework.data.redis.cache.RedisCacheWriter',
    'org.springframework.data.redis.connection.RedisConnectionFactory',
    'org.springframework.data.redis.serializer.GenericJacksonJsonRedisSerializer',
    'org.springframework.data.redis.serializer.RedisSerializationContext',
    'org.springframework.data.redis.serializer.StringRedisSerializer'
  ];
}

/**
 * Las estadísticas de acierto de la caché, que solo se piden con telemetría.
 *
 * Van AQUÍ y no en un `RedisCacheManagerBuilderCustomizer` de la configuración de telemetría
 * porque esos los aplica la autoconfiguración de Boot, y esa se retira en cuanto la aplicación
 * declara su propio `CacheManager` —que es justo lo que hace esta clase—: el bean existiría, no
 * fallaría y no haría nada.
 *
 * Sin ellas no hay error: hay AUSENCIA. `cache.gets{result=hit|miss}` no se publica, y el ratio
 * de acierto —lo único que dice si la caché sirve para algo— no se puede calcular ni en el panel
 * ni a mano.
 */
function statisticsLine(model) {
  if (!usesTelemetry(model)) return '';
  return `
                // Publica cache.gets{result=hit|miss}, cache.puts y cache.removals, etiquetadas
                // por el NOMBRE de la caché (del diseño: conjunto cerrado, cardinalidad baja).
                .enableStatistics()`;
}

function body(model, caches) {
  const constants = caches
    .map(
      (cache) => `    /**
     * Caché de ${cache.operation} (TTL ${cache.ttlSeconds}s, clave por ${cache.keyFields.join(', ') || 'la entrada de la operación'}${
        cache.invalidatedBy.length > 0 ? `; la invalidan ${cache.invalidatedBy.join(', ')}` : ''
      }).
     */
    public static final String ${cache.constant} = "${cache.cacheName}";`
    )
    .join('\n\n');

  const ttlEntries = caches
    .map((cache) => `        ttls.put(${cache.constant}, Duration.ofSeconds(${cache.ttlSeconds}));`)
    .join('\n');

  return `/**
 * Caché de lectura declarada en use-cases.keel.yaml.
 *
 * El TTL de cada caché sale del diseño, no del código: cambiarlo aquí a mano lo
 * desalinea del contrato. Los valores se serializan en JSON con soporte de
 * java.time — casi todo agregado trae timestamps de auditoría, y el mapper por
 * defecto los rompería al escribir en el store.
 *
 * Lo usa RedisOperationCache, el adaptador del puerto OperationCache: el handler
 * consulta la caché por el puerto (nada de @Cacheable/@CacheEvict) y la invalida
 * el UseCaseMediator. Las constantes de aquí repiten las de CachedOperations.
 */
@Configuration
@EnableCaching
public class CacheConfig implements CachingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(CacheConfig.class);

${constants}

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        RedisCacheConfiguration defaults = RedisCacheConfiguration.defaultCacheConfig()
                // Un null cacheado responde "no existe" hasta que vence el TTL.
                .disableCachingNullValues()
                .serializeKeysWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        new StringRedisSerializer()))
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        GenericJacksonJsonRedisSerializer.builder(CacheConfig::cacheMapperBuilder)
                                // Deja que el serializador instale su propia información
                                // de tipo: sin ella la lectura devolvería un LinkedHashMap
                                // en vez del agregado (o del record) que se cacheó. Es el
                                // mismo tipado sin validador que defaultTyping(true) del
                                // serializador de Jackson 2.
                                .enableUnsafeDefaultTyping()
                                .build()));

        Map<String, RedisCacheConfiguration> configurations = new LinkedHashMap<>();
        for (Map.Entry<String, Duration> ttl : ttlByCache().entrySet()) {
            configurations.put(ttl.getKey(), defaults.entryTtl(ttl.getValue()));
        }

        return RedisCacheManager.builder(connectionFactory)
                // Escrituras INMEDIATAS: con Lettuce, Spring Data Redis 4 puede escribir en la caché
                // de forma asíncrona, y entonces un put no está en Redis cuando vuelve — la lectura
                // que va detrás falla y la caché acierta menos sin que nada lo diga. En Boot 3 el put
                // era síncrono; esto lo mantiene (lo mide TEL-8 de telemetry-check).
                .cacheWriter(RedisCacheWriter.create(connectionFactory, writer -> writer.immediateWrites()))
                .cacheDefaults(defaults)
                .withInitialCacheConfigurations(configurations)${statisticsLine(model)}
                .build();
    }

    /**
     * Mapper propio de la caché: java.time (en Jackson 3 viene de serie) y fechas
     * en ISO-8601, sobre los defaults de Jackson 2 —los mismos que el mapper de la
     * aplicación, por {@code spring.jackson.use-jackson2-defaults}—.
     *
     * <p>TimestampModule es el mismo que instala JacksonConfig en el mapper de la
     * aplicación: un valor servido desde la caché tiene que ser byte a byte el
     * que habría servido la base de datos, y eso incluye la precisión de los
     * instantes.
     *
     * <p><b>Las tres líneas de visibilidad no son opcionales</b>: lo que se cachea
     * son agregados de dominio, que por convención no tienen setters ni
     * constructor sin argumentos (conventions/domain-modeling.md).
     * <ol>
     *   <li>ALL/NONE apaga la detección por getters y setters, que expondría
     *       propiedades derivadas que no forman parte del estado.</li>
     *   <li>FIELD/ANY es lo que permite leer y reconstruir el estado real.</li>
     *   <li>CREATOR/ANY hay que restaurarla <b>explícitamente</b>: el ALL/NONE
     *       anterior también apaga la detección del constructor, y sin ella
     *       Jackson no encuentra por dónde reconstruir el agregado.</li>
     * </ol>
     * DETECT_PARAMETER_NAMES y el detector de constructores PROPERTIES cierran el
     * círculo —en Jackson 2 era el ParameterNamesModule en modo PROPERTIES—:
     * reconocen el constructor de reconstrucción como creator usando los nombres
     * reales de los parámetros (el plugin de Spring Boot ya compila con
     * <code>-parameters</code>).
     *
     * <p>Sin esto la caché <b>no falla</b>: el CacheErrorHandler de abajo degrada
     * el error de (de)serialización a un miss y el servicio sirve siempre desde la
     * base de datos. Es decir, una caché que no cachea nada, indistinguible de una
     * sana en cualquier escenario que solo compruebe que los cambios se reflejan.
     */
    private static JsonMapper.Builder cacheMapperBuilder() {
        return JsonMapper.builder()
                .configureForJackson2()
                .disable(DateTimeFeature.WRITE_DATES_AS_TIMESTAMPS)
                .addModule(new TimestampModule())
                .enable(MapperFeature.DETECT_PARAMETER_NAMES)
                .constructorDetector(ConstructorDetector.USE_PROPERTIES_BASED)
                .changeDefaultVisibility(visibility -> visibility
                        .withVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.NONE)
                        .withVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)
                        .withVisibility(PropertyAccessor.CREATOR, JsonAutoDetect.Visibility.ANY));
    }

    private static Map<String, Duration> ttlByCache() {
        Map<String, Duration> ttls = new LinkedHashMap<>();
${ttlEntries}
        return ttls;
    }

    /**
     * El store caído degrada a miss: la petición va a la base de datos en vez de
     * fallar. Una caché no disponible no puede tumbar el servicio.
     *
     * <p>Ojo al diagnosticar: por aquí pasa <b>también</b> el fallo de
     * (de)serialización del valor, que no es indisponibilidad. Si un escenario de
     * retención falla —el valor viejo no sobrevive dentro del TTL— y no hay ningún
     * error en la respuesta, el WARN de estos métodos es la única evidencia: revisa
     * {@link #cacheMapperBuilder()} antes que la infraestructura.
     */
    @Override
    @Bean
    public CacheErrorHandler errorHandler() {
        return new CacheErrorHandler() {

            @Override
            public void handleCacheGetError(RuntimeException exception, Cache cache, Object key) {
                log.warn("Caché {} no disponible al leer {}: se sirve desde el origen", cache.getName(), key, exception);
            }

            @Override
            public void handleCachePutError(RuntimeException exception, Cache cache, Object key, Object value) {
                log.warn("Caché {} no disponible al escribir {}", cache.getName(), key, exception);
            }

            @Override
            public void handleCacheEvictError(RuntimeException exception, Cache cache, Object key) {
                log.warn("Caché {} no disponible al invalidar {}", cache.getName(), key, exception);
            }

            @Override
            public void handleCacheClearError(RuntimeException exception, Cache cache) {
                log.warn("Caché {} no disponible al vaciar", cache.getName(), exception);
            }
        };
    }
}`;
}
