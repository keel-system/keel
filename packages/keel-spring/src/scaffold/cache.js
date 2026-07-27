// Configuración de caché (infrastructure/configurations/cache). Se genera
// siempre que alguna operación del diseño declare `cache:`, porque la parte
// mecánica no depende del store elegido (redis y valkey hablan el mismo
// protocolo y usan el mismo starter): el serializador JSON con soporte
// java.time, el TTL declarado por operación y la degradación a miss si el store
// no responde. Lo que sí queda para el agente son las anotaciones @Cacheable /
// @CacheEvict sobre los adaptadores (ver skill keel-spring-redis).

import { kebabCase, screamingSnake } from '../lib/naming.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { timestampModuleImport } from './jackson.js';

const CACHE_PKG = 'infrastructure.configurations.cache';

// Operaciones con política de caché declarada, con el nombre de caché que las
// identifica: <servicio>:<operación>. RedisCacheManager le añade "::<clave>".
export function cachedOperations(model) {
  const slug = model.service.artifactId;
  const entries = [];
  for (const service of model.services) {
    for (const operation of service.operations) {
      if (!operation.cache) continue;
      entries.push({
        operation: operation.name,
        constant: `${screamingSnake(operation.name)}_CACHE`,
        cacheName: `${slug}:${kebabCase(operation.name)}`,
        ttlSeconds: operation.cache.ttlSeconds,
        keyFields: operation.cache.keyFields ?? [],
        invalidatedBy: operation.cache.invalidatedBy ?? []
      });
    }
  }
  return entries;
}

export function generate(model) {
  const caches = cachedOperations(model);
  if (caches.length === 0) return [];

  return [
    {
      path: javaPath(model, CACHE_PKG, 'CacheConfig'),
      content: javaFile(subPackage(model, CACHE_PKG), imports(model), body(model, caches))
    }
  ];
}

function imports(model) {
  return [
    timestampModuleImport(model),
    'com.fasterxml.jackson.databind.ObjectMapper',
    'com.fasterxml.jackson.databind.SerializationFeature',
    'com.fasterxml.jackson.datatype.jsr310.JavaTimeModule',
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
    'org.springframework.data.redis.connection.RedisConnectionFactory',
    'org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer',
    'org.springframework.data.redis.serializer.RedisSerializationContext',
    'org.springframework.data.redis.serializer.StringRedisSerializer'
  ];
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
 * Las anotaciones @Cacheable/@CacheEvict van en los adaptadores (nunca en los
 * handlers) referenciando las constantes de esta clase.
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
                        GenericJackson2JsonRedisSerializer.builder()
                                .objectMapper(cacheObjectMapper())
                                // Deja que el serializador instale su propia información
                                // de tipo: los DTO son records (clases final) y sin ella
                                // la lectura devolvería mapas en vez del DTO.
                                .defaultTyping(true)
                                .build()));

        Map<String, RedisCacheConfiguration> configurations = new LinkedHashMap<>();
        for (Map.Entry<String, Duration> ttl : ttlByCache().entrySet()) {
            configurations.put(ttl.getKey(), defaults.entryTtl(ttl.getValue()));
        }

        return RedisCacheManager.builder(connectionFactory)
                .cacheDefaults(defaults)
                .withInitialCacheConfigurations(configurations)
                .build();
    }

    /**
     * ObjectMapper propio de la caché: JSR-310 registrado (Instant, LocalDate…)
     * y fechas en ISO-8601. Sin este módulo, cachear cualquier respuesta con un
     * timestamp de auditoría falla al serializar.
     *
     * TimestampModule es el mismo que instala JacksonConfig en el mapper de la
     * aplicación: un valor servido desde la caché tiene que ser byte a byte el
     * que habría servido la base de datos, y eso incluye la precisión de los
     * instantes.
     */
    private static ObjectMapper cacheObjectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.registerModule(new TimestampModule());
        mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        return mapper;
    }

    private static Map<String, Duration> ttlByCache() {
        Map<String, Duration> ttls = new LinkedHashMap<>();
${ttlEntries}
        return ttls;
    }

    /**
     * El store caído degrada a miss: la petición va a la base de datos en vez de
     * fallar. Una caché no disponible no puede tumbar el servicio.
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
