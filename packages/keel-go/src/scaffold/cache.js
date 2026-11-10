// La caché de lectura del diseño (`use-cases.<op>.cache`, tramo 13e). Se genera siempre que alguna operación la declare,
// sobre Redis o Valkey (el mismo protocolo, el mismo cliente: solo cambia la imagen del compose).
//
// El reparto es el de keel-spring, keel-nest y keel-dotnet:
//   · QUÉ se cachea es la RESPUESTA de la operación, no el agregado, y con el contrato del cable (wire.Marshal y
//     wire.Unmarshal, lo mismo que escribe la respuesta HTTP): lo que sale de la caché es, campo a campo, lo que habría
//     servido el origen.
//   · DÓNDE se consulta lo decide el agente, en el handler, DESPUÉS de lo que dependa de quién llama (la clave es la
//     entrada de la operación, no el llamante): por eso la consulta es una función de internal/application.
//   · La INVALIDACIÓN la pone build: es un hecho del diseño (`invalidatedBy` + `emits` + las suscripciones), y
//     NewUseCases vacía la caché ENTERA tras el commit de cada operación que emite o consume uno de sus eventos
//     (keel-core/gen/cache-plan.js). Invalida de más, nunca de menos.
//
// Lo que Go cambia: una interfaz no puede tener métodos genéricos, así que la caché es un tipo concreto de
// internal/application (`OperationCache`) con la lógica entera —una carga por entrada, la generación que impide guardar
// una carga anterior al vaciado, la degradación a miss— y funciones genéricas (`GetOrLoad`); el PUERTO es lo que
// necesita de un store (`CacheStore`), y su adaptador sobre go-redis vive en internal/infrastructure/cache. Y application
// no puede importar golang.org/x/sync (la frontera hexagonal), así que la carga única es un mapa de cargas en vuelo
// propio. «Tras el commit» es el asentamiento por caso de uso de after-commit.js (`settle`): el caso de uso MÁS EXTERNO, el
// que abrió la transacción, ejecuta lo pendiente de los que despachó dentro de ella cuando termina bien; uno despachado con
// WithoutTransaction confirma lo suyo solo y lo ejecuta al terminar.
//
// Las claves en el store son las de RedisCacheManager de keel-spring (`<servicio>:<operación>::<clave>`): el mismo
// `infra/reset-db.sh` y el mismo `ClearCache()` del arnés las borran en los cuatro servidores.

import { usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { cachedOperations, cacheInvalidations, cacheNote, CACHE_ENTRY_SEPARATOR, CACHE_KEY_PART_SEPARATOR } from '@keel-system/keel-core/gen/cache-plan';
import { cacheYaml } from '@keel-system/keel-core/gen/cache-config';
import { CACHES, devtoolsContainer } from '@keel-system/keel-core/gen/infra-catalog';
import { cacheFlushCmd } from '@keel-system/keel-core/gen/infra-scripts';
import { alignRows, goString } from '../lib/go-source.js';
import { goExported } from '../lib/go-projection.js';
import { applicationPath, layout, packageFile } from './render.js';
import { usesAfterCommit } from './after-commit.js';
import { messageComponents, messageType, operations, resultType } from './services.js';
import { usesConditionalWrites } from './conditional-writes.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** El campo de Dependencies y el parámetro del handler que cachea. */
export const OPERATION_CACHE = { field: 'OperationCache', param: 'operationCache', type: '*OperationCache' };

/** El archivo del arnés con `ClearCache()`. */
export const CACHE_HARNESS_FILE = 'cache_test.go';

export function usesCache(model) {
  return operations(model).some((operation) => operation.cache);
}

/** La variable Go de la caché de una operación: `getProductBySlug` → `GetProductBySlugCache`. */
export function cacheVar(operationName) {
  return `${goExported(operationName)}Cache`;
}

/** ¿Lleva esta operación caché? Su handler recibe la caché. */
export function cachesOperation(model, operation) {
  return usesCache(model) && cachedOperations(model).some((cache) => cache.operation === operation.name);
}

/** Lo que recibe el handler de una operación con caché (la fila de handlerDependencies). */
export function cacheDependencies(model, operation) {
  if (!cachesOperation(model, operation)) return [];
  return [
    {
      name: OPERATION_CACHE.param,
      type: OPERATION_CACHE.type,
      doc: `${OPERATION_CACHE.param} es la caché de lectura de la operación (use-cases.${operation.name}.cache): GetOrLoad con ${cacheVar(operation.name)}.`,
      arg: `deps.${OPERATION_CACHE.field}`
    }
  ];
}

/** La fila de Dependencies. */
export function cacheDependencyRows(model) {
  if (!usesCache(model)) return [];
  return [
    { text: '\t// OperationCache es la caché de lectura del diseño (use-cases.<op>.cache); nil, ninguna (toda lectura va al origen).' },
    { indent: '\t', cells: [OPERATION_CACHE.field, OPERATION_CACHE.type] }
  ];
}

/**
 * Cómo cablea NewUseCases una operación: TODAS van dentro de `settle` (el asentamiento que ejecuta tras el commit lo
 * pendiente de su caso de uso y de los que despache), y la que invalida una caché le pasa su vaciado. Sin persistencia ni
 * caché no hay nada que esperar, y la línea es la de siempre.
 */
export function settlementWiring(model, operation, wired, { command }) {
  if (!usesAfterCommit(model)) return wired;
  const row = cacheInvalidations(model).find((entry) => entry.operation === operation.name);
  const caches = (row?.caches ?? []).map((cache) => cacheVar(cachedOperations(model).find((candidate) => candidate.cacheName === cache.cacheName).operation));
  const clearing = caches.length > 0 ? `, deps.${OPERATION_CACHE.field}.clearing(${caches.join(', ')})` : '';
  return `${command ? 'settleCommand' : 'settle'}(logger, ${wired}${clearing})`;
}

/** La nota del handler: la de keel-core, con la llamada en Go. */
export function cacheHandlerNote(model, operation) {
  if (!cachesOperation(model, operation)) return null;
  const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
  return cacheNote(model, operation, {
    call: `GetOrLoad(ctx, h.${OPERATION_CACHE.param}, ${cacheVar(operation.name)}, ${variable}, func(ctx context.Context) (${resultType(operation, model)}, error) { … }) (GetOrLoadIf para lo que no se guarda)`
  });
}

export function generate(model) {
  if (!usesCache(model)) return [];
  const { application, cache } = layout(model);
  return [
    {
      path: applicationPath(model, 'operation_cache'),
      content: packageFile(model, application, {
        imports: ['context', 'errors', 'fmt', 'log/slog', 'strconv', 'strings', 'sync', 'sync/atomic', 'time', 'internal/platform/wire'],
        body: operationCacheBody()
      })
    },
    { path: applicationPath(model, 'cached_operations'), content: packageFile(model, application, { imports: ['time'], body: cachedOperationsBody(model) }) },
    {
      path: applicationPath(model, 'operation_cache').replace(/\.go$/, '_test.go'),
      content: packageFile(model, application, {
        imports: [
          'bytes',
          'context',
          'encoding',
          'encoding/json/jsontext',
          'encoding/json/v2',
          'errors',
          'log/slog',
          'reflect',
          'strings',
          'sync',
          'sync/atomic',
          'testing',
          'testing/synctest',
          'time',
          'github.com/google/uuid',
          'internal/domain',
          'internal/platform/wire'
        ],
        body: operationCacheTest(model)
      })
    },
    {
      path: `${cache.dir}/doc.go`,
      content: packageFile(model, cache, {
        doc: `Package ${cache.name} es el store de la caché de lectura del servicio sobre Redis o Valkey (el mismo protocolo):\nel adaptador de application.CacheStore y su configuración (config/parameters/<perfil>/cache.yaml).`,
        body: ''
      })
    },
    { path: `${cache.dir}/settings.go`, content: packageFile(model, cache, { imports: ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], body: SETTINGS_BODY }) },
    {
      path: `${cache.dir}/store.go`,
      content: packageFile(model, cache, {
        imports: ['context', 'errors', 'fmt', 'log/slog', 'net', 'strconv', 'time', 'github.com/redis/go-redis/v9', 'github.com/redis/go-redis/v9/maintnotifications', 'internal/application'],
        body: STORE_BODY
      })
    },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/cache.yaml`, content: cacheYaml(profile) }))
  ];
}

// ─── internal/application/operation_cache.go ─────────────────────────────────────────────────────

function operationCacheBody() {
  return String.raw`
// CacheStore es lo que la caché de lectura necesita de un store clave-valor con caducidad: el puerto de Redis o Valkey,
// que implementa internal/infrastructure/cache. Un error es un store que no contesta: la caché lo degrada a miss.
type CacheStore interface {
	// Get devuelve el valor de key y si estaba.
	Get(ctx context.Context, key string) (value string, found bool, err error)
	// Set guarda value en key, que caduca a los ttl.
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	// Delete borra key.
	Delete(ctx context.Context, key string) error
	// DeleteMatching borra las claves que casan con un patrón con * y devuelve cuántas.
	DeleteMatching(ctx context.Context, pattern string) (int64, error)
}

// Cache es cualquier caché del diseño, para lo que no lee ni compone la clave (desalojar, vaciar).
type Cache interface {
	// CacheName es su nombre en el store: <servicio>:<operación>, como RedisCacheManager de keel-spring.
	CacheName() string
}

// CachedOperation es una caché de lectura del diseño (use-cases.<operación>.cache): su nombre, su TTL y cómo se compone
// la clave desde el mensaje M de la operación. Las del diseño están en cached_operations.go.
type CachedOperation[M any] struct {
	// Name es su nombre en el store.
	Name string
	// TTL es cuánto vive una entrada.
	TTL time.Duration
	// Key compone la clave de la entrada desde el mensaje (con CacheKey).
	Key func(msg M) string
}

// CacheName implementa Cache.
func (c CachedOperation[M]) CacheName() string {
	return c.Name
}

// OperationCache es la caché de lectura del servicio. Lo que la consulta es el HANDLER de la operación, después de todo
// lo que dependa de quién llama: la clave es la entrada de la operación y no el llamante, así que una respuesta servida
// antes de comprobar el alcance se le serviría a cualquiera.
//
// Cuatro reglas, las de keel-spring y keel-nest: el store caído DEGRADA A MISS (su CacheErrorHandler); lo nulo no se
// guarda (su disableCachingNullValues()); una carga por entrada a la vez (su sync = true); y una carga que empezó ANTES
// de vaciar la caché no guarda lo que leyó, porque pudo leerlo antes del commit que la vació y quedaría servido hasta el
// TTL. Esta última, solo dentro del proceso: entre réplicas no hay forma de saberlo.
//
// Un OperationCache nil, o sin store (el perfil test), no cachea: toda lectura va al origen.
type OperationCache struct {
	store  CacheStore
	logger *slog.Logger

	mu sync.Mutex
	// loading son las cargas en vuelo, por entrada.
	loading map[string]*cacheLoad
	// generations cuenta los vaciados de cada caché: una carga solo guarda si no cambió mientras cargaba.
	generations map[string]uint64
	// unavailable dice si la última orden al store falló: la caída se escribe una vez, no una por lectura.
	unavailable atomic.Bool
	// OnRead se entera de cada lectura de una entrada, acierto o fallo: la telemetría, si la hay. Se pone antes de usarla.
	OnRead func(cache string, hit bool)
}

// counted avisa de una lectura.
func (c *OperationCache) counted(name string, hit bool) {
	if c.OnRead != nil {
		c.OnRead(name, hit)
	}
}

// cacheLoad es una carga en vuelo: las lecturas de la misma entrada esperan a done y se llevan su resultado.
type cacheLoad struct {
	done  chan struct{}
	value any
	err   error
}

// errLoadAborted es lo que reciben las lecturas que esperaban a una carga que no terminó (su pánico sigue en quien la
// lanzó).
var errLoadAborted = errors.New("la carga de la entrada de la caché no terminó")

// NewOperationCache construye la caché sobre store; con store nil, toda lectura va al origen.
func NewOperationCache(store CacheStore, logger *slog.Logger) *OperationCache {
	return &OperationCache{store: store, logger: logger, loading: map[string]*cacheLoad{}, generations: map[string]uint64{}}
}

// GetOrLoad es la respuesta cacheada para msg, o la que da load, que se guarda con el TTL de la caché. Con varias
// lecturas a la vez sobre la misma entrada, carga UNA y las demás esperan a su resultado. Un error de load no se guarda
// y se devuelve tal cual.
func GetOrLoad[M, R any](ctx context.Context, cache *OperationCache, op CachedOperation[M], msg M, load func(ctx context.Context) (R, error)) (R, error) {
	return GetOrLoadIf(ctx, cache, op, msg, load, nil)
}

// GetOrLoadIf es GetOrLoad con cacheable, que dice si la respuesta recién cargada se puede guardar (nil: toda). Es para
// lo que el diseño no quiere ver servido durante el TTL: una respuesta DEGRADADA porque un proveedor no contestó se
// sirve y no se guarda.
func GetOrLoadIf[M, R any](ctx context.Context, cache *OperationCache, op CachedOperation[M], msg M, load func(ctx context.Context) (R, error), cacheable func(R) bool) (R, error) {
	if cache == nil || cache.store == nil {
		return load(ctx)
	}
	entry := EntryKey(op, op.Key(msg))
	var cached R
	if cache.read(ctx, op.Name, entry, &cached) {
		cache.counted(op.Name, true)
		return cached, nil
	}
	cache.counted(op.Name, false)
	cache.mu.Lock()
	if pending, ok := cache.loading[entry]; ok {
		cache.mu.Unlock()
		return awaitLoad[R](ctx, pending)
	}
	pending := &cacheLoad{done: make(chan struct{}), err: errLoadAborted}
	cache.loading[entry] = pending
	generation := cache.generations[op.Name]
	cache.mu.Unlock()
	defer func() {
		cache.mu.Lock()
		delete(cache.loading, entry)
		cache.mu.Unlock()
		close(pending.done)
	}()
	value, err := load(ctx)
	pending.value, pending.err = value, err
	if err == nil && (cacheable == nil || cacheable(value)) {
		cache.write(ctx, op.Name, entry, value, op.TTL, generation)
	}
	return value, err
}

// awaitLoad espera a la carga en vuelo de la misma entrada y se lleva su resultado.
func awaitLoad[R any](ctx context.Context, pending *cacheLoad) (R, error) {
	var zero R
	select {
	case <-pending.done:
	case <-ctx.Done():
		return zero, ctx.Err()
	}
	if pending.err != nil {
		return zero, pending.err
	}
	value, _ := pending.value.(R)
	return value, nil
}

// Evict desaloja una entrada (la clave como la compone Key, o CacheKey) cuando termina bien el caso de uso en curso: si
// revierte, no había nada que desalojar.
func (c *OperationCache) Evict(ctx context.Context, cache Cache, key string) {
	if c == nil {
		return
	}
	afterUseCase(ctx, func(ctx context.Context) {
		c.bump(cache)
		if c.store == nil {
			return
		}
		if err := c.store.Delete(ctx, EntryKey(cache, key)); err != nil {
			c.failed(ctx, cache.CacheName(), "desalojar", "la entrada caducará por su TTL", err)
		}
	})
}

// Clear vacía una caché entera cuando termina bien el caso de uso en curso. No hace falta llamarlo por los eventos de
// invalidatedBy: eso ya lo hace NewUseCases en cada operación que los emite o los consume.
func (c *OperationCache) Clear(ctx context.Context, cache Cache) {
	if c == nil {
		return
	}
	afterUseCase(ctx, func(ctx context.Context) {
		c.bump(cache)
		if c.store == nil {
			return
		}
		if _, err := c.store.DeleteMatching(ctx, cache.CacheName()+${goString(CACHE_ENTRY_SEPARATOR)}+"*"); err != nil {
			c.failed(ctx, cache.CacheName(), "vaciar", "sus entradas caducarán por su TTL", err)
		}
	})
}

// clearing es el vaciado de caches que NewUseCases le pasa a settle: lo que invalida una operación al confirmar.
func (c *OperationCache) clearing(caches ...Cache) func(context.Context) {
	return func(ctx context.Context) {
		for _, cache := range caches {
			c.Clear(ctx, cache)
		}
	}
}

func (c *OperationCache) bump(cache Cache) {
	c.mu.Lock()
	c.generations[cache.CacheName()]++
	c.mu.Unlock()
}

// read lee la entrada en out. Un miss es false; también lo son el store caído y la entrada ilegible, que no es
// indisponibilidad: si un escenario de retención falla sin ningún error en la respuesta, su aviso es la única evidencia.
func (c *OperationCache) read(ctx context.Context, name, entry string, out any) bool {
	text, found, err := c.store.Get(ctx, entry)
	if err != nil {
		c.failed(ctx, name, "leer", "se sirve desde el origen", err)
		return false
	}
	c.recovered(ctx)
	if !found {
		return false
	}
	if err := wire.Unmarshal([]byte(text), out); err != nil {
		c.logger.WarnContext(ctx, "caché: entrada ilegible, se sirve desde el origen", "cache", name, "error", err.Error())
		return false
	}
	return true
}

// write guarda value con el contrato del cable, salvo que sea nulo o que la caché se vaciara mientras se cargaba.
func (c *OperationCache) write(ctx context.Context, name, entry string, value any, ttl time.Duration, generation uint64) {
	text, err := wire.Marshal(value)
	if err != nil {
		c.logger.WarnContext(ctx, "caché: la respuesta no se pudo escribir, no se guarda", "cache", name, "error", err.Error())
		return
	}
	if string(text) == "null" {
		return
	}
	c.mu.Lock()
	stale := c.generations[name] != generation
	c.mu.Unlock()
	if stale {
		return
	}
	if err := c.store.Set(ctx, entry, string(text), ttl); err != nil {
		c.failed(ctx, name, "escribir", "se sigue sin caché", err)
		return
	}
	c.recovered(ctx)
}

// failed escribe la caída del store una vez, no una por orden.
func (c *OperationCache) failed(ctx context.Context, name, action, consequence string, err error) {
	if !c.unavailable.Swap(true) {
		c.logger.WarnContext(ctx, fmt.Sprintf("caché no disponible al %s: %s hasta que vuelva", action, consequence), "cache", name, "error", err.Error())
	}
}

func (c *OperationCache) recovered(ctx context.Context) {
	if c.unavailable.Swap(false) {
		c.logger.InfoContext(ctx, "caché disponible de nuevo")
	}
}

// EntryKey es la clave de una entrada en el store: <caché>${CACHE_ENTRY_SEPARATOR}<clave>, como RedisCacheManager.
func EntryKey(cache Cache, key string) string {
	return cache.CacheName() + ${goString(CACHE_ENTRY_SEPARATOR)} + key
}

// CacheKey compone la clave de una entrada con la forma de keel-spring, keel-nest y keel-dotnet: los componentes en su
// orden, separados por ${CACHE_KEY_PART_SEPARATOR}. Un instante va en el formato del cable (UTC, milisegundos y Z); un nulo, como null;
// un booleano, en minúsculas.
func CacheKey(parts ...any) string {
	texts := make([]string, len(parts))
	for i, part := range parts {
		texts[i] = cacheKeyPart(part)
	}
	return strings.Join(texts, ${goString(CACHE_KEY_PART_SEPARATOR)})
}

func cacheKeyPart(part any) string {
	switch value := part.(type) {
	case nil:
		return "null"
	case string:
		return value
	case bool:
		return strconv.FormatBool(value)
	case time.Time:
		return value.UTC().Format(wire.TimestampLayout)
	case fmt.Stringer:
		return value.String()
	default:
		return fmt.Sprint(value)
	}
}

`;
}

// ─── internal/application/cached_operations.go ───────────────────────────────────────────────────

function cachedOperationsBody(model) {
  const caches = cachedOperations(model);
  const byName = new Map(operations(model).map((operation) => [operation.name, operation]));
  const invalidators = new Map();
  for (const entry of cacheInvalidations(model)) {
    for (const cache of entry.caches) {
      if (!invalidators.has(cache.cacheName)) invalidators.set(cache.cacheName, []);
      invalidators.get(cache.cacheName).push(entry.operation);
    }
  }
  const vars = caches.map((cache) => {
    const operation = byName.get(cache.operation);
    const components = new Map(messageComponents(operation, model).map((component) => [component.name, component]));
    const missing = cache.keyFields.filter((field) => !components.has(field));
    if (missing.length > 0) {
      throw new Error(
        `use-cases.${cache.operation}.cache.keyFields: ${missing.join(', ')} no ${missing.length === 1 ? 'es un campo' : 'son campos'} del mensaje ${operation.messageClass}; la clave de la caché sale de la entrada de la operación.`
      );
    }
    const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
    // Con una lectura acotada (DSL 2.27, D6) el scope del llamante es parte de la clave, con la forma de keel-spring: si no,
    // la caché sirve a uno la fila de otro. Dos exentos comparten entrada (`all`).
    const parts = [...cache.keyFields.map((field) => `${variable}.${goExported(field)}`), ...(operation.readScope ? [`${variable}.ReadScope.CacheKey()`] : [])];
    const key = parts.length > 0 ? `CacheKey(${parts.join(', ')})` : 'CacheKey("all")';
    const by = invalidators.get(cache.cacheName) ?? [];
    const doc = [
      `${cacheVar(cache.operation)} es la caché de ${cache.operation}: TTL ${cache.ttlSeconds} s, clave por ${[...cache.keyFields, ...(operation.readScope ? ['el scope del llamante (lectura acotada)'] : [])].join(', ') || 'ningún campo (una sola entrada)'}.`,
      cache.invalidatedBy.length > 0
        ? `La invalidan ${cache.invalidatedBy.join(', ')}: la vacían ENTERA, al confirmar, ${by.length > 0 ? by.join(', ') : 'ninguna operación de este servicio (solo caduca por su TTL)'} (lo cablea NewUseCases).`
        : 'Ningún evento la invalida: solo caduca por su TTL.'
    ];
    return `${doc.map((line) => `// ${line}`).join('\n')}
var ${cacheVar(cache.operation)} = CachedOperation[${messageType(operation)}]{
	Name: ${goString(cache.cacheName)},
	TTL:  ${cache.ttlSeconds} * time.Second,
	Key: func(${parts.length > 0 ? variable : '_'} ${messageType(operation)}) string {
		return ${key}
	},
}`;
  });
  return `
// Las cachés de lectura que declara use-cases.keel.yaml. El nombre y el TTL salen del diseño (keel-core/gen/cache-plan.js):
// cambiarlos aquí a mano los desalinea del contrato, y de los servidores de keel-spring, keel-nest y keel-dotnet del mismo
// diseño, que nombran igual sus cachés.

${vars.join('\n\n')}
`;
}

// ─── internal/infrastructure/cache ───────────────────────────────────────────────────────────────

const SETTINGS_BODY = `
// Settings es lo que el store lee de config/parameters/<perfil>/cache.yaml (las variables de keel-spring: REDIS_HOST,
// REDIS_PORT).
type Settings struct {
	// Enabled es false en el perfil test: sin caché, toda lectura va al origen y no se abre ninguna conexión.
	Enabled bool
	// Host y Port son el store.
	Host string
	Port int
	// ConnectTimeout es cuánto espera una conexión antes de darla por fallida.
	ConnectTimeout time.Duration
	// CommandTimeout es cuánto espera una orden: un store que no contesta degrada a miss en este plazo.
	CommandTimeout time.Duration
}

// SettingsFrom lee cache.* de la configuración del perfil. Un número que no se entiende no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key, fallback string) string {
		if value, ok := cfg.Value(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}
	number := func(key string, fallback int) (int, error) {
		value := text(key, "")
		if value == "" {
			return fallback, nil
		}
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 {
			return 0, fmt.Errorf("%s tiene que ser un número no negativo: %q", key, value)
		}
		return parsed, nil
	}
	s := Settings{
		Enabled: !strings.EqualFold(text("cache.enabled", "true"), "false"),
		Host:    text("cache.redis.host", "localhost"),
	}
	var err error
	if s.Port, err = number("cache.redis.port", 6379); err != nil {
		return Settings{}, err
	}
	connect, err := number("cache.redis.connect-timeout-ms", 2000)
	if err != nil {
		return Settings{}, err
	}
	command, err := number("cache.redis.command-timeout-ms", 2000)
	if err != nil {
		return Settings{}, err
	}
	s.ConnectTimeout = time.Duration(connect) * time.Millisecond
	s.CommandTimeout = time.Duration(command) * time.Millisecond
	return s, nil
}
`;

const STORE_BODY = `
// scanBatch es cuántas claves pide cada SCAN del vaciado: KEYS bloquearía el servidor con muchas claves.
const scanBatch = 200

// Store es el store de la caché sobre Redis o Valkey, con go-redis: el adaptador de application.CacheStore.
//
// Tres decisiones que no son las del cliente por defecto, y las tres son para que una caché caída no pueda tumbar ni
// retener al servicio:
//   - el servicio ARRANCA sin el store: go-redis abre las conexiones al usarlas, no al construirse, y las reabre solo;
//   - sin reintentos (MaxRetries: -1): con el store caído, cada reintento esperaría otro plazo de conexión, y la lectura
//     tiene que ir al origen en el primero;
//   - cada orden tiene su plazo (los de cache.yaml): un store que no contesta degrada a miss, no retiene la petición.
type Store struct {
	client *redis.Client
}

var _ application.CacheStore = (*Store)(nil)

// NewStore construye el store; no abre ninguna conexión.
func NewStore(settings Settings, logger *slog.Logger) *Store {
	// go-redis escribe sus avisos internos (una conexión que no se pudo abrir) con un logger propio, en texto y a stderr:
	// aquí van al del servicio, en Debug. La caída la cuenta una vez la caché (application.OperationCache).
	redis.SetLogger(redisLogger{logger: logger})
	return &Store{client: redis.NewClient(&redis.Options{
		Addr:                  net.JoinHostPort(settings.Host, strconv.Itoa(settings.Port)),
		ClientName:            "keel-cache",
		DialTimeout:           settings.ConnectTimeout,
		ReadTimeout:           settings.CommandTimeout,
		WriteTimeout:          settings.CommandTimeout,
		PoolTimeout:           settings.CommandTimeout,
		ContextTimeoutEnabled: true,
		MaxRetries:            -1,
		// Ni CLIENT SETINFO ni CLIENT MAINT_NOTIFICATIONS al conectar: el mismo saludo con Redis y con Valkey.
		DisableIdentity:          true,
		MaintNotificationsConfig: &maintnotifications.Config{Mode: maintnotifications.ModeDisabled},
	})}
}

// Get implementa application.CacheStore.
func (s *Store) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("leer %s: %w", key, err)
	}
	return value, true, nil
}

// Set implementa application.CacheStore.
func (s *Store) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	if err := s.client.Set(ctx, key, value, ttl).Err(); err != nil {
		return fmt.Errorf("escribir %s: %w", key, err)
	}
	return nil
}

// Delete implementa application.CacheStore.
func (s *Store) Delete(ctx context.Context, key string) error {
	if err := s.client.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("borrar %s: %w", key, err)
	}
	return nil
}

// DeleteMatching implementa application.CacheStore: SCAN por lotes y DEL de cada lote.
func (s *Store) DeleteMatching(ctx context.Context, pattern string) (int64, error) {
	var deleted int64
	var cursor uint64
	for {
		keys, next, err := s.client.Scan(ctx, cursor, pattern, scanBatch).Result()
		if err != nil {
			return deleted, fmt.Errorf("recorrer %s: %w", pattern, err)
		}
		if len(keys) > 0 {
			count, err := s.client.Del(ctx, keys...).Result()
			if err != nil {
				return deleted, fmt.Errorf("borrar %s: %w", pattern, err)
			}
			deleted += count
		}
		if next == 0 {
			return deleted, nil
		}
		cursor = next
	}
}

// Close cierra las conexiones con el store.
func (s *Store) Close() error {
	return s.client.Close()
}

// redisLogger lleva los avisos internos de go-redis al logger del servicio.
type redisLogger struct {
	logger *slog.Logger
}

// Printf implementa el logger de go-redis.
func (l redisLogger) Printf(ctx context.Context, format string, v ...any) {
	l.logger.DebugContext(ctx, "redis: "+fmt.Sprintf(format, v...))
}
`;

// ─── La prueba emitida ───────────────────────────────────────────────────────────────────────────

/**
 * `operation_cache_test.go`: la caché EJECUTADA contra un store en memoria (acierto con su clave, su TTL y el JSON del
 * cable, lo nulo y lo que no se guarda, el error de la carga, el store caído, la entrada ilegible, diez lecturas a la vez,
 * el vaciado de una caché sin tocar otras con la carga anterior a él, sin store, el vaciado que espera al caso de uso de
 * fuera y no ocurre si falla) y, por cada caché del diseño, la IDA Y VUELTA de su respuesta por el store: una muestra del
 * tipo se guarda y la segunda lectura, que acierta, la devuelve igual en el cable. Lo que dice un Redis o un Valkey DE
 * VERDAD lo mide la red del generador (cache-check).
 */
function operationCacheTest(model) {
  const caches = cachedOperations(model);
  // Versioned (api.concurrency) tiene su lector, que exige la versión, pero su muestra sí se construye campo a campo.
  const versionedGuard = usesConditionalWrites(model) ? ' && !isVersioned(typ)' : '';
  const versionedHelper = usesConditionalWrites(model)
    ? `// isVersioned dice si el tipo es un Versioned (api.concurrency): lee su versión y su valor, que sí tienen muestra.
func isVersioned(typ reflect.Type) bool {
	_, ok := reflect.Zero(typ).Interface().(interface{ versioned() })
	return ok
}

`
    : '';
  const byName = new Map(operations(model).map((operation) => [operation.name, operation]));
  const roundTrips = caches.map((cache) => {
    const operation = byName.get(cache.operation);
    return `func TestLaRespuestaDe${goExported(cache.operation)}VuelveIgualDeLaCache(t *testing.T) {
	assertCacheRoundTrip[${messageType(operation)}, ${resultType(operation, model)}](t, ${cacheVar(cache.operation)})
}`;
  });
  const samples = alignRows([
    { indent: '\t', cells: ['reflect.TypeFor[uuid.UUID]():', '`"0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f61"`,'] },
    { indent: '\t', cells: ['reflect.TypeFor[time.Time]():', '`"2026-01-02T03:04:05.006Z"`,'] },
    { indent: '\t', cells: ['reflect.TypeFor[wire.Decimal]():', '`12.50`,'] },
    { indent: '\t', cells: ['reflect.TypeFor[wire.Date]():', '`"2026-01-02"`,'] },
    { indent: '\t', cells: ['reflect.TypeFor[jsontext.Value]():', '`{"a":1}`,'] },
    ...(model.enums ?? []).map((enumDef) => ({ indent: '\t', cells: [`reflect.TypeFor[domain.${enumDef.name}]():`, `\`${JSON.stringify(enumDef.values[0].literal)}\`,`] }))
  ]);
  return String.raw`
// La caché de lectura EJECUTADA sin red: la caché contra un store en memoria, y la ida y vuelta de cada respuesta cacheada
// del diseño por el store con el contrato del cable. Lo que dice un Redis o un Valkey de verdad lo mide cache-check.

type probeAnswer struct {
	Value string ${'`json:"value"`'}
}

var probeCache = CachedOperation[string]{Name: "servicio:prueba", TTL: time.Minute, Key: func(msg string) string { return CacheKey(msg) }}

var otherCache = CachedOperation[string]{Name: "servicio:otra", TTL: time.Minute, Key: func(msg string) string { return CacheKey(msg) }}

// memoryStore es un store en memoria que apunta lo que le piden y puede caerse.
type memoryStore struct {
	mu      sync.Mutex
	entries map[string]memoryEntry
	down    bool
}

type memoryEntry struct {
	value string
	ttl   time.Duration
}

var errStoreDown = errors.New("store caído")

func newMemoryStore() *memoryStore {
	return &memoryStore{entries: map[string]memoryEntry{}}
}

func (s *memoryStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		return "", false, errStoreDown
	}
	entry, ok := s.entries[key]
	return entry.value, ok, nil
}

func (s *memoryStore) Set(_ context.Context, key, value string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		return errStoreDown
	}
	s.entries[key] = memoryEntry{value: value, ttl: ttl}
	return nil
}

func (s *memoryStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, key)
	return nil
}

func (s *memoryStore) DeleteMatching(_ context.Context, pattern string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := strings.TrimSuffix(pattern, "*")
	var deleted int64
	for key := range s.entries {
		if strings.HasPrefix(key, prefix) {
			delete(s.entries, key)
			deleted++
		}
	}
	return deleted, nil
}

func (s *memoryStore) keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0, len(s.entries))
	for key := range s.entries {
		keys = append(keys, key)
	}
	return keys
}

func newProbeCache(store CacheStore) *OperationCache {
	return NewOperationCache(store, slog.New(slog.DiscardHandler))
}

func answer(text string, loads *atomic.Int32) func(context.Context) (probeAnswer, error) {
	return func(context.Context) (probeAnswer, error) {
		loads.Add(1)
		return probeAnswer{Value: text}, nil
	}
}

func TestUnFalloCargaYGuardaConSuTTLYUnAciertoNoVuelveAlOrigen(t *testing.T) {
	store := newMemoryStore()
	cache := newProbeCache(store)
	var loads atomic.Int32
	first, err := GetOrLoad(t.Context(), cache, probeCache, "a", answer("uno", &loads))
	if err != nil {
		t.Fatal(err)
	}
	second, err := GetOrLoad(t.Context(), cache, probeCache, "a", answer("dos", &loads))
	if err != nil {
		t.Fatal(err)
	}
	if first.Value != "uno" || second.Value != "uno" || loads.Load() != 1 {
		t.Fatalf("lecturas %q y %q con %d cargas; quería uno, uno y una carga", first.Value, second.Value, loads.Load())
	}
	entry, ok := store.entries["servicio:prueba::a"]
	if !ok || entry.ttl != time.Minute || entry.value != ${'`{"value":"uno"}`'} {
		t.Fatalf("entrada %v (%t); quería servicio:prueba::a con {\"value\":\"uno\"} y un minuto", store.entries, ok)
	}
}

func TestLoNuloYLoQueNoSePuedeGuardarSeSirvenSinGuardarse(t *testing.T) {
	store := newMemoryStore()
	cache := newProbeCache(store)
	nothing, err := GetOrLoad(t.Context(), cache, probeCache, "a", func(context.Context) (*probeAnswer, error) { return nil, nil })
	if err != nil || nothing != nil {
		t.Fatalf("nil = %v, %v", nothing, err)
	}
	degraded, err := GetOrLoadIf(t.Context(), cache, probeCache, "b", func(context.Context) (probeAnswer, error) {
		return probeAnswer{Value: "degradada"}, nil
	}, func(a probeAnswer) bool { return a.Value != "degradada" })
	if err != nil || degraded.Value != "degradada" {
		t.Fatalf("degradada = %v, %v", degraded, err)
	}
	if keys := store.keys(); len(keys) != 0 {
		t.Fatalf("se guardó %v", keys)
	}
}

func TestUnErrorDeLaCargaNoSeGuardaYSeDevuelve(t *testing.T) {
	store := newMemoryStore()
	broken := errors.New("origen")
	_, err := GetOrLoad(t.Context(), newProbeCache(store), probeCache, "a", func(context.Context) (probeAnswer, error) { return probeAnswer{}, broken })
	if !errors.Is(err, broken) {
		t.Fatalf("err = %v; quería el de la carga", err)
	}
	if keys := store.keys(); len(keys) != 0 {
		t.Fatalf("se guardó %v", keys)
	}
}

func TestElStoreCaidoDegradaAMissYLaLecturaVaAlOrigen(t *testing.T) {
	store := newMemoryStore()
	store.down = true
	var loads atomic.Int32
	got, err := GetOrLoad(t.Context(), newProbeCache(store), probeCache, "a", answer("origen", &loads))
	if err != nil || got.Value != "origen" {
		t.Fatalf("got = %v, %v; quería la del origen", got, err)
	}
}

func TestUnaEntradaIlegibleEsUnMiss(t *testing.T) {
	store := newMemoryStore()
	store.entries["servicio:prueba::a"] = memoryEntry{value: "no es json", ttl: time.Minute}
	var loads atomic.Int32
	got, err := GetOrLoad(t.Context(), newProbeCache(store), probeCache, "a", answer("origen", &loads))
	if err != nil || got.Value != "origen" {
		t.Fatalf("got = %v, %v; quería la del origen", got, err)
	}
	if entry := store.entries["servicio:prueba::a"]; entry.value != ${'`{"value":"origen"}`'} {
		t.Fatalf("la entrada ilegible no se reescribió: %q", entry.value)
	}
}

func TestDiezLecturasALaVezCarganUnaVez(t *testing.T) {
	// En una burbuja de synctest: Wait devuelve cuando las diez esperan (una a la puerta, nueve a su carga), así que
	// ninguna llega tarde y acierta por la entrada ya guardada.
	synctest.Test(t, func(t *testing.T) {
		cache := newProbeCache(newMemoryStore())
		gate := make(chan struct{})
		var loads atomic.Int32
		var wg sync.WaitGroup
		answers := make([]probeAnswer, 10)
		for i := range answers {
			wg.Go(func() {
				got, err := GetOrLoad(t.Context(), cache, probeCache, "a", func(context.Context) (probeAnswer, error) {
					loads.Add(1)
					<-gate
					return probeAnswer{Value: "una"}, nil
				})
				if err != nil {
					t.Error(err)
				}
				answers[i] = got
			})
		}
		synctest.Wait()
		close(gate)
		wg.Wait()
		if loads.Load() != 1 {
			t.Fatalf("%d cargas; quería una", loads.Load())
		}
		for _, got := range answers {
			if got.Value != "una" {
				t.Fatalf("una lectura devolvió %q", got.Value)
			}
		}
	})
}

func TestVaciarBorraSoloSuCacheYUnaCargaAnteriorNoGuardaLoQueLeyo(t *testing.T) {
	store := newMemoryStore()
	store.entries["servicio:prueba::x"] = memoryEntry{value: ${'`{"value":"vieja"}`'}, ttl: time.Minute}
	store.entries["servicio:otra::x"] = memoryEntry{value: ${'`{"value":"otra"}`'}, ttl: time.Minute}
	cache := newProbeCache(store)
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan probeAnswer)
	go func() {
		got, _ := GetOrLoad(t.Context(), cache, probeCache, "a", func(context.Context) (probeAnswer, error) {
			close(started)
			<-release
			return probeAnswer{Value: "leída antes del vaciado"}, nil
		})
		done <- got
	}()
	<-started
	cache.Clear(t.Context(), probeCache)
	close(release)
	if got := <-done; got.Value != "leída antes del vaciado" {
		t.Fatalf("got = %q", got.Value)
	}
	if keys := store.keys(); len(keys) != 1 || keys[0] != "servicio:otra::x" {
		t.Fatalf("quedan %v; quería solo servicio:otra::x", keys)
	}
}

func TestSinStoreTodaLecturaVaAlOrigen(t *testing.T) {
	var loads atomic.Int32
	for _, cache := range []*OperationCache{nil, newProbeCache(nil)} {
		for range 2 {
			if _, err := GetOrLoad(t.Context(), cache, probeCache, "a", answer("uno", &loads)); err != nil {
				t.Fatal(err)
			}
		}
		cache.Clear(t.Context(), probeCache)
	}
	if loads.Load() != 4 {
		t.Fatalf("%d cargas; quería cuatro", loads.Load())
	}
}

func TestLaClaveTieneLaFormaDeLosOtrosTresServidores(t *testing.T) {
	instant := time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC)
	if got := CacheKey("a", 7, true, nil, instant); got != "a:7:true:null:2026-01-02T03:04:05.006Z" {
		t.Fatalf("CacheKey = %q", got)
	}
	if got := EntryKey(probeCache, "k"); got != "servicio:prueba::k" {
		t.Fatalf("EntryKey = %q", got)
	}
}

func TestElVaciadoEsperaAlCasoDeUsoDeFueraYNoOcurreSiFalla(t *testing.T) {
	store := newMemoryStore()
	cache := newProbeCache(store)
	seed := func() {
		store.entries["servicio:prueba::a"] = memoryEntry{value: ${'`{"value":"vieja"}`'}, ttl: time.Minute}
	}
	present := func() bool {
		_, ok := store.entries["servicio:prueba::a"]
		return ok
	}
	inner := settleCommand(slog.New(slog.DiscardHandler), CommandHandlerFunc[string](func(context.Context, string) error { return nil }), cache.clearing(probeCache))
	var duringOuter bool
	outer := settleCommand(slog.New(slog.DiscardHandler), CommandHandlerFunc[string](func(ctx context.Context, cmd string) error {
		if err := inner.Handle(ctx, cmd); err != nil {
			return err
		}
		duringOuter = present()
		if cmd == "falla" {
			return errors.New("revierte")
		}
		return nil
	}))
	seed()
	if err := outer.Handle(t.Context(), "bien"); err != nil {
		t.Fatal(err)
	}
	if !duringOuter || present() {
		t.Fatalf("durante el caso de uso de fuera la entrada estaba: %t; después: %t (quería true y false)", duringOuter, present())
	}
	seed()
	if err := outer.Handle(t.Context(), "falla"); err == nil {
		t.Fatal("el caso de uso de fuera tenía que fallar")
	}
	if !present() {
		t.Fatal("un caso de uso que revierte vació la caché")
	}
	// Despachado sin transacción abarcadora, confirma solo: su vaciado no espera al de fuera.
	seed()
	detached := settleCommand(slog.New(slog.DiscardHandler), CommandHandlerFunc[string](func(ctx context.Context, cmd string) error {
		if err := inner.Handle(WithoutTransaction(ctx), cmd); err != nil {
			return err
		}
		duringOuter = present()
		return nil
	}))
	if err := detached.Handle(t.Context(), "bien"); err != nil || duringOuter {
		t.Fatalf("despachado con WithoutTransaction, la entrada seguía: %t (%v)", duringOuter, err)
	}
}

${roundTrips.join('\n\n')}

// cacheSamples son los valores del cable de los tipos que se leen con su propio lector: el uuid, el instante, los de wire
// y los enums del diseño (su primer valor).
var cacheSamples = map[reflect.Type]string{
${samples.join('\n')}
}

// assertCacheRoundTrip guarda una muestra de la respuesta R por la caché y la vuelve a leer: la segunda lectura tiene que
// acertar (si la entrada no se pudiera leer, volvería al origen) y salir IDÉNTICA en el cable. Dos veces: con un valor en
// cada campo y con los opcionales nulos, que una respuesta con nulls: omit escribe sin ellos.
func assertCacheRoundTrip[M, R any](t *testing.T, op CachedOperation[M]) {
	t.Helper()
	for _, nulls := range []bool{false, true} {
		var sample R
		reflect.ValueOf(&sample).Elem().Set(cacheSample(t, reflect.TypeFor[R](), nulls, 0))
		cache := newProbeCache(newMemoryStore())
		var msg M
		var loads atomic.Int32
		load := func(context.Context) (R, error) {
			loads.Add(1)
			return sample, nil
		}
		first, err := GetOrLoad(t.Context(), cache, op, msg, load)
		if err != nil {
			t.Fatal(err)
		}
		second, err := GetOrLoad(t.Context(), cache, op, msg, load)
		if err != nil {
			t.Fatal(err)
		}
		if loads.Load() != 1 {
			t.Fatalf("nulos %t: la segunda lectura volvió al origen; la entrada guardada no se pudo leer", nulls)
		}
		want, err := wire.Marshal(first)
		if err != nil {
			t.Fatal(err)
		}
		got, err := wire.Marshal(second)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(want, got) {
			t.Fatalf("nulos %t: la respuesta de la caché no es la del origen:\n origen %s\n caché  %s", nulls, want, got)
		}
	}
}

// cacheSample es un valor del tipo con cada campo puesto (los punteros, nil con nulls) y cada lista con un elemento.
func cacheSample(t *testing.T, typ reflect.Type, nulls bool, depth int) reflect.Value {
	t.Helper()
	value := reflect.New(typ).Elem()
	if sample, ok := cacheSamples[typ]; ok {
		if err := wire.Unmarshal([]byte(sample), value.Addr().Interface()); err != nil {
			t.Fatalf("la muestra de %v no se lee: %v", typ, err)
		}
		return value
	}
	if depth > 8 {
		t.Fatalf("%v: demasiado anidado para una muestra", typ)
	}
	if readsItself(typ) && typ.Kind() != reflect.Pointer${versionedGuard} {
		t.Fatalf("%v se lee con su propio lector y no tiene muestra en cacheSamples", typ)
	}
	switch typ.Kind() {
	case reflect.String:
		value.SetString("texto-1")
	case reflect.Bool:
		value.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		value.SetInt(7)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		value.SetUint(7)
	case reflect.Float32, reflect.Float64:
		value.SetFloat(1.5)
	case reflect.Pointer:
		if !nulls {
			value.Set(cacheSample(t, typ.Elem(), nulls, depth+1).Addr())
		}
	case reflect.Slice:
		value.Set(reflect.Append(reflect.MakeSlice(typ, 0, 1), cacheSample(t, typ.Elem(), nulls, depth+1)))
	case reflect.Map:
		// Vacío: se escribe como {} y se lee igual.
	case reflect.Struct:
		for i := range typ.NumField() {
			field := typ.Field(i)
			if !field.IsExported() || field.Tag.Get("json") == "-" {
				continue
			}
			value.Field(i).Set(cacheSample(t, field.Type, nulls, depth+1))
		}
	default:
		t.Fatalf("%v: sin muestra", typ)
	}
	return value
}

${versionedHelper}// readsItself dice si el tipo tiene su propio lector JSON: entonces su muestra no se puede inventar campo a campo.
func readsItself(typ reflect.Type) bool {
	pointer := reflect.PointerTo(typ)
	return pointer.Implements(reflect.TypeFor[json.UnmarshalerFrom]()) ||
		pointer.Implements(reflect.TypeFor[json.Unmarshaler]()) ||
		pointer.Implements(reflect.TypeFor[encoding.TextUnmarshaler]())
}
`;
}

// ─── El arnés: ClearCache() ──────────────────────────────────────────────────────────────────────

/**
 * El vaciado de la caché a mitad de escenario. La orden es literalmente la que ejecuta `infra/reset-db.sh` (`cacheFlushCmd`,
 * neutral): un helper que borrase otro conjunto dejaría al escenario midiendo un estado que ningún flujo puede reproducir.
 * El mismo helper que el `clearCache()` de keel-spring y keel-nest y el `ClearCache()` de keel-dotnet.
 */
export function cacheHarnessBody(model) {
  const entry = usesCache(model) && model.stack?.cache ? CACHES[model.stack.cache] : null;
  if (!entry) return null;
  return `
// cacheDevtools es el contenedor de infra/ desde el que se habla con la caché, en la red del compose.
const cacheDevtools = ${goString(devtoolsContainer(model.service.name))}

// cacheFlush es la orden de infra/reset-db.sh que vacía las claves de este servicio.
const cacheFlush = ${goString(cacheFlushCmd(entry, model.service))}

// ClearCache vacía las claves ${model.service.artifactId}:* de la caché: las entradas cacheadas de cada operación. Es el subconjunto de
// caché del reset de cada flujo, con su misma orden. Vale para el Then que necesita medir un MISS a mitad de flujo —que un
// dato se volvió a pedir al origen tras invalidarse— sin llevarse por delante los datos de los escenarios anteriores.
func (s *Scenario) ClearCache() {
	s.Helper()
	if _, err := runCommand(s.Context(), containerRuntime(), []string{"exec", cacheDevtools, "sh", "-c", cacheFlush}, "¿Está la infraestructura arriba (bash infra/up.sh)?", ""); err != nil {
		s.Fatal(err)
	}
}
`;
}

/** Lo que el arranque (cmd/server) añade con la caché: la configuración y el store, que se cierra al apagar. */
// Con telemetría, cada lectura cuenta en cache_gets_total{cache,result}, la serie del ratio de acierto del panel.
const CACHE_OBSERVED = `	operationCache := application.NewOperationCache(cacheStore, logger)
	if observability.Instrumented("cache") {
		operationCache.OnRead = observability.CacheGet
	}
`;

export function cacheServerWiring(model) {
  if (!usesCache(model)) return '';
  const { cache } = layout(model);
  return `	cacheSettings, err := ${cache.name}.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la caché: %w", err)
	}
	// Sin caché (perfil test) no hay store: toda lectura va al origen. El servicio arranca aunque el store no conteste.
	var cacheStore application.CacheStore
	if cacheSettings.Enabled {
		store := ${cache.name}.NewStore(cacheSettings, logger)
		defer func() {
			if err := store.Close(); err != nil {
				logger.ErrorContext(ctx, "cerrar la caché", "error", err)
			}
		}()
		cacheStore = store
	}
${usesTelemetry(model) ? CACHE_OBSERVED : ''}`;
}

/** La fila de Dependencies que pone el arranque. */
export function cacheServerRows(model) {
  if (!usesCache(model)) return [];
  return [{ indent: '\t\t', cells: [`${OPERATION_CACHE.field}:`, usesTelemetry(model) ? 'operationCache,' : 'application.NewOperationCache(cacheStore, logger),'] }];
}
