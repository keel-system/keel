// Caché de lectura (`use-cases.<op>.cache`, incremento 13f). Se genera siempre que alguna operación del diseño
// la declare, sobre Redis o Valkey (el mismo protocolo, el mismo cliente: solo cambia la imagen del compose).
//
// QUÉ se cachea es la RESPUESTA de la operación, no el agregado: es lo que cachearon los agentes de keel-spring
// en sus corridas (la ficha de getAsset como JSON, la respuesta del controlador de getProductBySlug), y en
// TypeScript es además lo único que se puede reconstruir con tipos sin reflexión. Se guarda con el contrato del
// cable (`toWireJson`) y se lee con un lector por DTO que genera build: lo que sale de la caché es, campo a
// campo, lo que habría servido el origen —decimales con su escala, instantes con sus tres decimales—.
//
// DÓNDE se consulta lo decide el agente, como en keel-spring: en el handler, DESPUÉS de lo que dependa de quién
// llama (el alcance por recurso de asset-vault: la clave es el id, y servir la ficha antes de comprobarlo se la
// daría a cualquiera). Por eso el puerto vive en application y la consulta es `getOrLoad`.
//
// La INVALIDACIÓN, en cambio, la pone build: es un hecho del diseño (`invalidatedBy` + `emits` + las
// suscripciones) y el UseCaseMediator vacía la caché entera tras el commit de cada operación que emite o consume
// uno de sus eventos (keel-core/gen/cache-plan.js). Invalida de más, nunca de menos.
//
// Las claves en el store son las de RedisCacheManager de keel-spring (`<servicio>:<operación>::<clave>`): el
// mismo `infra/reset-db.sh` y el mismo `clearCache()` del arnés las borran en los dos servidores.

import {
  cachedOperations,
  cacheInvalidations,
  CACHE_ENTRY_SEPARATOR,
  CACHE_KEY_PART_SEPARATOR
} from 'keel-core/gen/cache-plan';
import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { CACHES, devtoolsContainer } from 'keel-core/gen/infra-catalog';
import { cacheFlushCmd } from 'keel-core/gen/infra-scripts';
import { DIRS, classPath, fieldImports, isNullable, tsModule, tsString } from './render.js';
import { messageComponents, messagePath, returnTypeOf } from './services.js';
import { PAGED_RESPONSE_TS } from './dtos.js';
import { usesPersistence } from './persistence-entities.js';
import { TRANSACTION_CONTEXT_TS } from './repositories.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const WIRE_TS = 'src/application/support/wire.ts';
const INFRA_DIR = 'src/infrastructure/cache';
const PROFILES = ['local', 'develop', 'production', 'test'];

export const OPERATION_CACHE_TS = classPath(DIRS.portOut, 'OperationCache');
export const CACHED_OPERATIONS_TS = `src/${DIRS.appSupport}/cached-operations.ts`;
export const CACHE_SETTINGS_TS = `${INFRA_DIR}/cache-settings.ts`;
export const CACHED_RESPONSES_TS = `${INFRA_DIR}/cached-responses.ts`;
export const CACHE_INVALIDATIONS_TS = `${INFRA_DIR}/cache-invalidations.ts`;
export const REDIS_OPERATION_CACHE_TS = `${INFRA_DIR}/redis-operation-cache.ts`;
export const REDIS_CACHE_STORE_TS = `${INFRA_DIR}/redis-cache-store.ts`;
export const CACHE_MODULE_TS = `${INFRA_DIR}/cache-module.ts`;

export function usesCache(model) {
  return cachedOperations(model).length > 0;
}

export function generate(model) {
  if (!usesCache(model)) return [];
  return [
    { path: OPERATION_CACHE_TS, content: operationCacheTs() },
    { path: CACHED_OPERATIONS_TS, content: cachedOperationsTs(model) },
    { path: CACHE_SETTINGS_TS, content: cacheSettingsTs() },
    { path: CACHED_RESPONSES_TS, content: cachedResponsesTs(model) },
    { path: CACHE_INVALIDATIONS_TS, content: cacheInvalidationsTs(model) },
    { path: REDIS_OPERATION_CACHE_TS, content: redisOperationCacheTs(model) },
    { path: REDIS_CACHE_STORE_TS, content: redisCacheStoreTs() },
    { path: CACHE_MODULE_TS, content: cacheModuleTs(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/cache.yaml`, content: cacheYaml(profile) }))
  ];
}

// ─── application/port/out/operation-cache.ts ─────────────────────────────────

function operationCacheTs() {
  const body = `/**
 * Una caché de lectura del diseño (\`use-cases.<operación>.cache\`): su nombre en el store, su TTL y cómo se
 * compone la clave desde el mensaje de la operación. \`T\` es lo que guarda —la respuesta de la operación— y
 * \`M\` el mensaje del que sale la clave. Las del diseño están en application/support/cached-operations.ts.
 */
export interface CachedOperation<T, M> {
  readonly name: string;
  readonly ttlSeconds: number;
  /** La clave de la entrada: los \`keyFields\` del diseño, en su orden. */
  readonly keyOf: (message: M) => string;
  /** Solo de tipo: ata la caché a lo que guarda. */
  readonly __value?: T;
}

/** Cualquier caché del diseño, para lo que no lee ni compone la clave (desalojar, vaciar). */
export type AnyCachedOperation = CachedOperation<unknown, never>;

export interface CacheLoadOptions<T> {
  /**
   * Si la respuesta recién cargada se puede guardar. Por defecto, toda la que no es nula. Es para lo que el
   * diseño no quiere ver servido durante el TTL: una ficha DEGRADADA porque un proveedor no contestó, por
   * ejemplo, se sirve y no se guarda.
   */
  readonly cacheable?: (value: T) => boolean;
}

/**
 * La caché de lectura. Lo que la consulta es el HANDLER de la operación, después de todo lo que dependa de
 * quién llama: la clave es la entrada de la operación y no el llamante, así que una respuesta servida antes de
 * comprobar el alcance se le serviría a cualquiera.
 *
 * Un store caído o una entrada ilegible no son errores: degradan a miss y la respuesta sale del origen.
 */
export abstract class OperationCache {
  /**
   * La respuesta cacheada para el mensaje, o la que da \`load\` —que se guarda con el TTL de la caché—. Con
   * varias peticiones a la vez sobre la misma entrada, carga UNA y las demás esperan a su resultado.
   */
  abstract getOrLoad<T, M>(cache: CachedOperation<T, M>, message: M, load: () => Promise<T>, options?: CacheLoadOptions<T>): Promise<T>;

  /** Desaloja una entrada (la clave como la compone \`keyOf\`, o \`cacheKey(...)\`). Tras el commit, si lo hay. */
  abstract evict(cache: AnyCachedOperation, key: string): Promise<void>;

  /**
   * Vacía la caché entera. Tras el commit, si lo hay. No hace falta llamarlo por los eventos de
   * \`invalidatedBy\`: eso ya lo hace el UseCaseMediator al confirmar cada operación que los emite o los consume.
   */
  abstract clear(cache: AnyCachedOperation): Promise<void>;
}

/** Un componente de una clave de caché. */
export type CacheKeyPart = string | number | bigint | boolean | Date | { toString(): string } | null | undefined;

/**
 * La clave de una entrada: los componentes en su orden, separados por \`${CACHE_KEY_PART_SEPARATOR}\` —la forma con la que keel-spring
 * compone una clave compuesta—. Un instante va en ISO-8601; un nulo, como \`null\`.
 */
export function cacheKey(...parts: readonly CacheKeyPart[]): string {
  return parts.map((part) => (part instanceof Date ? part.toISOString() : String(part))).join(${tsString(CACHE_KEY_PART_SEPARATOR)});
}`;
  return tsModule(OPERATION_CACHE_TS, [], body);
}

// ─── application/support/cached-operations.ts ────────────────────────────────

function cachedOperationsTs(model) {
  const caches = cachedOperations(model);
  const operations = new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
  const imports = [
    { symbol: 'CachedOperation', from: OPERATION_CACHE_TS, type: true },
    { symbol: 'cacheKey', from: OPERATION_CACHE_TS }
  ];
  const invalidators = new Map();
  for (const entry of cacheInvalidations(model)) {
    for (const cache of entry.caches) {
      if (!invalidators.has(cache.cacheName)) invalidators.set(cache.cacheName, []);
      invalidators.get(cache.cacheName).push(entry.operation);
    }
  }
  const constants = caches.map((cache) => {
    const operation = operations.get(cache.operation);
    imports.push({ symbol: operation.messageClass, from: messagePath(operation), type: true });
    imports.push(...resultImports(operation));
    const components = new Set(messageComponents(model, operation).map((component) => component.name));
    const missing = cache.keyFields.filter((field) => !components.has(field));
    if (missing.length > 0) {
      throw new Error(
        `use-cases.${cache.operation}.cache.keyFields: ${missing.join(', ')} no ${missing.length === 1 ? 'es un campo' : 'son campos'} del mensaje ${operation.messageClass}; la clave de la caché sale de la entrada de la operación.`
      );
    }
    const key = cache.keyFields.length > 0 ? `cacheKey(${cache.keyFields.map((field) => `message.${field}`).join(', ')})` : "cacheKey('all')";
    const by = invalidators.get(cache.cacheName) ?? [];
    const doc = [
      `Caché de ${cache.operation}: TTL ${cache.ttlSeconds} s, clave por ${cache.keyFields.join(', ') || 'ningún campo (una sola entrada)'}.`,
      cache.invalidatedBy.length > 0
        ? `La invalidan ${cache.invalidatedBy.join(', ')}: la vacían ENTERA, al confirmar, ${by.length > 0 ? by.join(', ') : 'ninguna operación de este servicio (solo caduca por su TTL)'} (lo hace el UseCaseMediator).`
        : 'Ningún evento la invalida: solo caduca por su TTL.'
    ];
    return `/**
 * ${doc.join('\n * ')}
 */
export const ${cache.constant}: CachedOperation<${returnTypeOf(operation)}, ${operation.messageClass}> = {
  name: ${tsString(cache.cacheName)},
  ttlSeconds: ${cache.ttlSeconds},
  keyOf: (${cache.keyFields.length > 0 ? 'message' : '_message'}) => ${key}
};`;
  });
  const body = `// Las cachés de lectura que declara use-cases.keel.yaml. El nombre y el TTL salen del diseño: cambiarlos aquí
// a mano los desalinea del contrato —y del servidor de keel-spring del mismo diseño, que nombra igual sus cachés—.
// Lo generó keel-nest build: no se edita.

${constants.join('\n\n')}`;
  return tsModule(CACHED_OPERATIONS_TS, imports, body);
}

function resultImports(operation) {
  const imports = [{ symbol: operation.responseDto.name, from: classPath(DIRS.dtos, operation.responseDto.name), type: true }];
  if (operation.paginated) imports.push({ symbol: 'PagedResponse', from: PAGED_RESPONSE_TS, type: true });
  return imports;
}

// ─── infrastructure/cache/cache-settings.ts ──────────────────────────────────

function cacheSettingsTs() {
  const body = `export const CACHE_SETTINGS = Symbol('CACHE_SETTINGS');

/** Lo que la caché lee de config/parameters/<perfil>/cache.yaml (las variables de keel-spring: REDIS_HOST, REDIS_PORT). */
export interface CacheSettings {
  /** Sin caché (perfil test): toda lectura va al origen y no se abre ninguna conexión. */
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  /** Cuánto espera una conexión al store antes de darla por fallida (y reintentar en segundo plano). */
  readonly connectTimeoutMs: number;
  /** Cuánto espera una orden: un store que no contesta degrada a miss en este plazo, no retiene la petición. */
  readonly commandTimeoutMs: number;
}

export function cacheSettings(configuration: Configuration): CacheSettings {
  return {
    enabled: flag(configuration, 'cache.enabled', true),
    host: text(configuration, 'cache.redis.host') ?? 'localhost',
    port: number(configuration, 'cache.redis.port', 6379),
    connectTimeoutMs: number(configuration, 'cache.redis.connect-timeout-ms', 2000),
    commandTimeoutMs: number(configuration, 'cache.redis.command-timeout-ms', 2000)
  };
}

function text(configuration: Configuration, key: string): string | null {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? null : String(value);
}

function number(configuration: Configuration, key: string, fallback: number): number {
  const value = text(configuration, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(\`\${key} tiene que ser un número no negativo: '\${value}'\`);
  return parsed;
}

function flag(configuration: Configuration, key: string, fallback: boolean): boolean {
  const value = text(configuration, key);
  return value == null ? fallback : value.toLowerCase() === 'true';
}`;
  return tsModule(CACHE_SETTINGS_TS, [{ symbol: 'Configuration', from: CONFIG_TS, type: true }], body);
}

/** config/parameters/<perfil>/cache.yaml: las mismas variables y defaults que el redis.yaml de keel-spring. */
function cacheYaml(profile) {
  const lines = ['cache:'];
  if (profile === 'test') {
    lines.push('  # Las pruebas del perfil test no levantan infraestructura: sin caché, toda lectura va al origen.', '  enabled: false');
  } else {
    lines.push('  enabled: true');
  }
  lines.push(
    '  redis:',
    `    host: ${envValue(profile, 'REDIS_HOST', 'localhost')}`,
    `    port: ${envValue(profile, 'REDIS_PORT', 6379)}`,
    '    # Una caché caída no puede retener a quien lee: pasado el plazo, la lectura va al origen.',
    '    connect-timeout-ms: 2000',
    '    command-timeout-ms: 2000'
  );
  return `${lines.join('\n')}\n`;
}

function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

// ─── infrastructure/cache/cached-responses.ts ────────────────────────────────

/** Todos los DTO que el modelo conoce, por nombre. */
function dtoIndex(model) {
  const index = new Map();
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) if (operation.responseDto) index.set(operation.responseDto.name, operation.responseDto);
  }
  for (const list of [model.childDtos, model.refDtos, model.refVariants, model.needDtos]) for (const dto of list ?? []) index.set(dto.name, dto);
  return index;
}

const BASE_DECODERS = {
  string: 'text',
  text: 'text',
  file: 'text',
  uuid: 'text',
  date: 'toDate',
  int: 'toInt',
  long: 'toLong',
  decimal: 'toDecimal',
  boolean: 'flag',
  timestamp: 'toTimestamp',
  json: 'toJson'
};

/**
 * Los lectores de las respuestas cacheadas, como DATOS para quien los quiera ejecutar sin el resto del
 * proyecto: `operations` son las operaciones cuyas respuestas se leen (por defecto, las que cachean).
 */
export function cachedResponsesTs(model, operations = null) {
  const byName = new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
  const targets = operations ?? cachedOperations(model).map((cache) => byName.get(cache.operation));
  const caches = new Map(cachedOperations(model).map((cache) => [cache.operation, cache]));
  const dtos = dtoIndex(model);
  const vos = new Map((model.valueObjects ?? []).map((vo) => [vo.name, vo]));
  const imports = [
    { symbol: 'parseWireJson', from: WIRE_TS },
    { symbol: 'toWireJson', from: WIRE_TS }
  ];
  const decoders = new Map();
  const wireHelpers = new Set();

  const elementName = (field) => String(field.elementTsType ?? field.tsType).replace(/\[\]$/, '');
  const elementDecoder = (field) => {
    if (field.kind === 'enum') {
      imports.push(...fieldImports(model, field));
      return `literal(${elementName(field)})`;
    }
    if (field.kind === 'composite') {
      imports.push(...fieldImports(model, field));
      requireDecoder(elementName(field), 'vo');
      return `decode${elementName(field)}`;
    }
    if (field.kind === 'childDto' || field.kind === 'refDto' || field.kind === 'needDto') {
      requireDecoder(elementName(field), 'dto');
      return `decode${elementName(field)}`;
    }
    const helper = BASE_DECODERS[field.base] ?? 'text';
    if (helper.startsWith('to')) wireHelpers.add(helper);
    return helper;
  };
  const fieldExpression = (field, source) => {
    const decoder = elementDecoder(field);
    if (field.list) return `list(${source}, ${decoder})`;
    return isNullable(field) ? `optional(${source}, ${decoder})` : `required(${source}, ${decoder})`;
  };
  function requireDecoder(name, kind) {
    if (decoders.has(name)) return;
    decoders.set(name, null);
    if (kind === 'vo') {
      const vo = vos.get(name);
      if (!vo) throw new Error(`caché: el value object ${name} no está en el modelo`);
      imports.push({ symbol: name, from: classPath(DIRS.valueObjects, name) });
      const args = vo.fields.map((field) => fieldExpression(field, `fields[${tsString(field.name)}]`));
      decoders.set(
        name,
        `function decode${name}(value: unknown): ${name} {
  const fields = object(value);
  return new ${name}(${args.join(', ')});
}`
      );
      return;
    }
    const dto = dtos.get(name);
    if (!dto) throw new Error(`caché: el DTO ${name} no está en el modelo`);
    imports.push({ symbol: name, from: classPath(DIRS.dtos, name) });
    const props = dto.fields.map((field) => `    ${field.name}: ${fieldExpression(field, `fields[${tsString(field.name)}]`)}`);
    decoders.set(
      name,
      `function decode${name}(value: unknown): ${name} {
  const fields = object(value);
  return new ${name}({
${props.join(',\n')}
  });
}`
    );
  }

  const entries = targets.map((operation) => {
    requireDecoder(operation.responseDto.name, 'dto');
    const item = `decode${operation.responseDto.name}`;
    let decode;
    if (operation.paginated) {
      imports.push({ symbol: 'PagedResponse', from: PAGED_RESPONSE_TS });
      const parts = WIRE_SHAPES.pagedResponse.map((key) => (key === 'items' ? `list(page[${tsString(key)}], ${item})` : `required(page[${tsString(key)}], count)`));
      decode = `(value) => {
    const page = object(value);
    return new PagedResponse(${parts.join(', ')});
  }`;
    } else if (operation.returnsList) {
      decode = `(value) => list(value, ${item})`;
    } else {
      decode = `(value) => ${item}(value)`;
    }
    const name = caches.get(operation.name)?.cacheName ?? operation.name;
    return `  [${tsString(name)}, codec(${decode})]`;
  });
  // Solo los lectores de base que algo usa: con `noUnusedLocals`, una función muerta no compila.
  const used = `${[...decoders.values()].join('\n')}\n${entries.join('\n')}`;
  const helpers = Object.entries(VALUE_HELPERS).filter(([name]) => new RegExp(`\\b${name}\\b`).test(used));
  if (helpers.some(([name]) => name === 'count')) wireHelpers.add('toInt');
  imports.push(...[...wireHelpers].map((helper) => ({ symbol: helper, from: WIRE_TS })));
  const typed = helpers.some(([name]) => ['required', 'optional', 'list', 'literal'].includes(name));

  const body = `// Cómo se guarda y se vuelve a leer la respuesta de cada caché: con el contrato del cable. Al escribir,
// \`toWireJson\` —lo mismo que sale por HTTP—; al leer, el texto con \`parseWireJson\` (los números con su texto
// exacto: un decimal no pierde su escala ni un long sus dígitos) y un lector por DTO que lo reconstruye con sus
// tipos. Una entrada que no se puede leer —de una versión anterior del servicio, a medias— no es un error: el
// adaptador la trata como un miss y la respuesta sale del origen.
// Lo generó keel-nest build: no se edita.

/** Escribe y lee la respuesta de una caché. */
export interface ResponseCodec {
  encode(value: unknown): string;
  decode(text: string): unknown;
}

/** El valor de una entrada que no tiene la forma que esta versión del servicio escribe. */
export class UnreadableCacheEntry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableCacheEntry';
  }
}

/** Los lectores, por nombre de caché. */
export const RESPONSE_CODECS: ReadonlyMap<string, ResponseCodec> = new Map<string, ResponseCodec>([
${entries.join(',\n')}
]);

function codec(decode: (value: unknown) => unknown): ResponseCodec {
  return {
    encode: (value) => toWireJson(value),
    decode: (text) => decode(parseWireJson(text))
  };
}

${[...decoders.values()].join('\n\n')}

// ── Lectores de valores ───────────────────────────────────────────────────────
${typed ? '\ntype Decoder<T> = (value: unknown) => T;\n' : ''}
function unreadable(what: string): never {
  throw new UnreadableCacheEntry(\`la entrada no tiene la forma de la respuesta (\${what})\`);
}
${helpers.map(([, source]) => `\n${source}`).join('\n')}`;
  return tsModule(CACHED_RESPONSES_TS, imports, body);
}

/** Los lectores de base del archivo de respuestas, por nombre: se emiten solo los que algo usa. */
const VALUE_HELPERS = {
  object: `function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : unreadable('se esperaba un objeto');
}`,
  required: `function required<T>(value: unknown, decode: Decoder<T>): T {
  return value == null ? unreadable('falta un campo obligatorio') : decode(value);
}`,
  optional: `function optional<T>(value: unknown, decode: Decoder<T>): T | null {
  return value == null ? null : decode(value);
}`,
  list: `function list<T>(value: unknown, decode: Decoder<T>): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.map((item) => decode(item)) : unreadable('se esperaba una lista');
}`,
  text: `function text(value: unknown): string {
  return typeof value === 'string' ? value : unreadable('se esperaba un texto');
}`,
  flag: `function flag(value: unknown): boolean {
  return typeof value === 'boolean' ? value : unreadable('se esperaba un booleano');
}`,
  count: `/** Un contador de la página (número de página, tamaño, totales): un entero no negativo. */
function count(value: unknown): number {
  const result = toInt(value);
  return result >= 0 ? result : unreadable('se esperaba un contador');
}`,
  literal: `function literal<E extends Record<string, string>>(type: E): Decoder<E[keyof E]> {
  const literals = new Set<string>(Object.values(type));
  return (value) => (typeof value === 'string' && literals.has(value) ? (value as E[keyof E]) : unreadable('literal desconocido'));
}`
};

// ─── infrastructure/cache/cache-invalidations.ts ─────────────────────────────

function cacheInvalidationsTs(model) {
  const operations = new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
  const entries = cacheInvalidations(model);
  const imports = [{ symbol: 'AnyCachedOperation', from: OPERATION_CACHE_TS, type: true }];
  const rows = entries.map((entry) => {
    const operation = operations.get(entry.operation);
    imports.push({ symbol: operation.messageClass, from: messagePath(operation) });
    for (const cache of entry.caches) imports.push({ symbol: cache.constant, from: CACHED_OPERATIONS_TS });
    const why = entry.caches.map((cache) => `${cache.constant} por ${cache.events.join(', ')}`).join('; ');
    return `  // ${entry.operation}: ${why}.\n  [${operation.messageClass}, [${entry.caches.map((cache) => cache.constant).join(', ')}]]`;
  });
  const body = `/**
 * Qué cachés vacía cada operación al confirmar: la que EMITE un evento de su \`invalidatedBy\` y la que DISPARA
 * la suscripción a uno de ellos. Sale del diseño (keel-core/gen/cache-plan.js) y lo aplica el UseCaseMediator,
 * así que ningún handler tiene que acordarse.
 *
 * Se vacía la caché ENTERA: la clave es la entrada de la lectura (un slug, un id) y el evento no tiene por qué
 * llevarla. Invalida de más, nunca de menos —que es el error que no se ve: datos viejos hasta el TTL—.
 */
export const CACHE_INVALIDATIONS: ReadonlyMap<object, readonly AnyCachedOperation[]> = new Map<object, readonly AnyCachedOperation[]>([
${rows.join(',\n')}
]);`;
  return tsModule(CACHE_INVALIDATIONS_TS, imports, body);
}

// ─── infrastructure/cache/redis-operation-cache.ts ───────────────────────────

function redisOperationCacheTs(model) {
  const transactional = usesPersistence(model);
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'Logger', from: '@nestjs/common' },
    { symbol: 'Optional', from: '@nestjs/common' },
    { symbol: 'AnyCachedOperation', from: OPERATION_CACHE_TS, type: true },
    { symbol: 'CacheLoadOptions', from: OPERATION_CACHE_TS, type: true },
    { symbol: 'CachedOperation', from: OPERATION_CACHE_TS, type: true },
    { symbol: 'OperationCache', from: OPERATION_CACHE_TS },
    { symbol: 'RESPONSE_CODECS', from: CACHED_RESPONSES_TS },
    { symbol: 'ResponseCodec', from: CACHED_RESPONSES_TS, type: true },
    ...(transactional ? [{ symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS }] : [])
  ];
  const afterCommit = transactional
    ? `
  /** Lo que cambia el store va DESPUÉS del commit: si la transacción revierte, no había nada que desalojar. */
  private async afterCommit(work: () => Promise<void>): Promise<void> {
    if (this.transactions == null) return work();
    await this.transactions.afterCommit(work);
  }`
    : `
  /** Sin persistencia no hay commit que esperar. */
  private async afterCommit(work: () => Promise<void>): Promise<void> {
    await work();
  }`;
  const ctorTransactions = transactional
    ? `,
    @Optional() @Inject(TransactionContext) private readonly transactions: TransactionContext | null = null`
    : '';
  const body = `/** El token del store (null en el perfil test: sin caché). */
export const CACHE_STORE = Symbol('CACHE_STORE');

/** Lo que la caché necesita de un store clave-valor con caducidad. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Borra las claves que casan con un patrón \`*\` y devuelve cuántas. */
  deleteMatching(pattern: string): Promise<number>;
}

const MISS = Symbol('miss');

/**
 * La caché de lectura sobre Redis/Valkey, con las claves de RedisCacheManager de keel-spring:
 * \`<caché>${CACHE_ENTRY_SEPARATOR}<clave>\`.
 *
 * Tres reglas, las tres de keel-spring:
 *   · el store caído DEGRADA A MISS —el CacheErrorHandler de keel-spring—: la lectura va al origen;
 *   · lo nulo no se guarda —su \`disableCachingNullValues()\`—: un null cacheado diría «no existe» hasta el TTL;
 *   · una carga por entrada a la vez —su \`sync = true\`—: con la entrada caducada y muchas lecturas, una sola
 *     va al origen y las demás esperan su resultado.
 *
 * Y una que keel-spring no tiene: una carga que empezó ANTES de vaciar la caché no guarda lo que leyó, porque
 * pudo leerlo antes del commit que la vació —y quedaría servido hasta el TTL—. Solo dentro de este proceso:
 * entre réplicas no hay forma de saberlo, y queda la ventana que tiene keel-spring.
 */
@Injectable()
export class RedisOperationCache extends OperationCache {
  private readonly log = new Logger('OperationCache');
  private readonly loading = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();

  constructor(
    @Inject(CACHE_STORE) private readonly store: CacheStore | null${ctorTransactions}
  ) {
    super();
  }

  async getOrLoad<T, M>(cache: CachedOperation<T, M>, message: M, load: () => Promise<T>, options: CacheLoadOptions<T> = {}): Promise<T> {
    if (this.store == null) return load();
    const codec = codecOf(cache);
    const entry = entryKey(cache, cache.keyOf(message));
    const hit = await this.read(cache, entry, codec);
    if (hit !== MISS) return hit as T;
    const pending = this.loading.get(entry);
    if (pending) return pending as Promise<T>;
    const generation = this.generation(cache);
    const loaded = (async () => {
      const value = await load();
      const keep = value != null && (options.cacheable?.(value) ?? true);
      if (keep && this.generation(cache) === generation) await this.write(cache, entry, codec, value);
      return value;
    })();
    this.loading.set(entry, loaded);
    try {
      return await loaded;
    } finally {
      this.loading.delete(entry);
    }
  }

  async evict(cache: AnyCachedOperation, key: string): Promise<void> {
    await this.afterCommit(async () => {
      this.bump(cache);
      if (this.store == null) return;
      try {
        await this.store.delete(entryKey(cache, key));
      } catch (error) {
        this.log.warn(\`Caché \${cache.name} no disponible al desalojar: la entrada caducará por su TTL (\${describe(error)})\`);
      }
    });
  }

  async clear(cache: AnyCachedOperation): Promise<void> {
    await this.afterCommit(async () => {
      this.bump(cache);
      if (this.store == null) return;
      try {
        await this.store.deleteMatching(\`\${cache.name}${CACHE_ENTRY_SEPARATOR}*\`);
      } catch (error) {
        this.log.warn(\`Caché \${cache.name} no disponible al vaciar: sus entradas caducarán por su TTL (\${describe(error)})\`);
      }
    });
  }

  /**
   * Una entrada leída, o MISS. Por aquí pasa también la entrada ilegible, que no es indisponibilidad: si un
   * escenario de retención falla sin ningún error en la respuesta, este WARN es la única evidencia.
   */
  private async read(cache: AnyCachedOperation, entry: string, codec: ResponseCodec): Promise<unknown> {
    let text: string | null;
    try {
      text = await this.store!.get(entry);
    } catch (error) {
      this.log.warn(\`Caché \${cache.name} no disponible al leer: se sirve desde el origen (\${describe(error)})\`);
      return MISS;
    }
    if (text == null) return MISS;
    try {
      return codec.decode(text);
    } catch (error) {
      this.log.warn(\`Caché \${cache.name}: entrada ilegible, se sirve desde el origen (\${describe(error)})\`);
      return MISS;
    }
  }

  private async write(cache: AnyCachedOperation, entry: string, codec: ResponseCodec, value: unknown): Promise<void> {
    try {
      await this.store!.set(entry, codec.encode(value), cache.ttlSeconds);
    } catch (error) {
      this.log.warn(\`Caché \${cache.name} no disponible al escribir: se sigue sin caché (\${describe(error)})\`);
    }
  }

  private generation(cache: AnyCachedOperation): number {
    return this.generations.get(cache.name) ?? 0;
  }

  private bump(cache: AnyCachedOperation): void {
    this.generations.set(cache.name, this.generation(cache) + 1);
  }
${afterCommit}
}

/** La clave en el store: \`<caché>${CACHE_ENTRY_SEPARATOR}<clave>\`, como RedisCacheManager. */
export function entryKey(cache: AnyCachedOperation, key: string): string {
  return \`\${cache.name}${CACHE_ENTRY_SEPARATOR}\${key}\`;
}

function codecOf(cache: AnyCachedOperation): ResponseCodec {
  const codec = RESPONSE_CODECS.get(cache.name);
  if (codec == null) throw new Error(\`La caché \${cache.name} no está en el diseño: no hay con qué leer sus entradas\`);
  return codec;
}

function describe(error: unknown): string {
  return error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
}`;
  return tsModule(REDIS_OPERATION_CACHE_TS, imports, body);
}

// ─── infrastructure/cache/redis-cache-store.ts ───────────────────────────────

function redisCacheStoreTs() {
  const imports = [
    { symbol: 'createClient', from: '@redis/client' },
    { symbol: 'Logger', from: '@nestjs/common' },
    { symbol: 'OnApplicationShutdown', from: '@nestjs/common', type: true },
    { symbol: 'CacheSettings', from: CACHE_SETTINGS_TS, type: true },
    { symbol: 'CacheStore', from: REDIS_OPERATION_CACHE_TS, type: true }
  ];
  const body = `/**
 * El store de la caché sobre Redis o Valkey (el mismo protocolo), con el cliente oficial.
 *
 * Tres decisiones que no son las del cliente por defecto, y las tres son para que una caché caída no pueda
 * tumbar ni retener al servicio:
 *   · el servicio ARRANCA sin el store: la conexión se abre en segundo plano y se reintenta sin fin;
 *   · \`disableOfflineQueue\`: sin conexión, una orden falla en el acto —y la lectura va al origen— en vez de
 *     quedarse en cola hasta que vuelva el store;
 *   · el reintento NO se rinde: el del cliente deja de reconectar tras un plazo de conexión agotado, y la caché
 *     quedaría muerta hasta reiniciar el servicio.
 */
export class RedisCacheStore implements CacheStore, OnApplicationShutdown {
  private readonly log = new Logger('RedisCacheStore');
  private readonly client;
  private available = true;

  constructor(settings: CacheSettings) {
    this.client = createClient({
      socket: {
        host: settings.host,
        port: settings.port,
        connectTimeout: settings.connectTimeoutMs,
        reconnectStrategy: (retries: number) => Math.min(2 ** retries * 50, 2000) + Math.floor(Math.random() * 200)
      },
      disableOfflineQueue: true,
      commandOptions: { timeout: settings.commandTimeoutMs }
    });
    // Sin oyente de 'error', el primer fallo de red tumbaría el proceso. Se escribe una vez por caída, no una
    // por reintento.
    this.client.on('error', (error: Error) => {
      if (!this.available) return;
      this.available = false;
      this.log.warn(\`Caché no disponible (\${settings.host}:\${settings.port}): las lecturas van al origen hasta que vuelva (\${error.message})\`);
    });
    this.client.on('ready', () => {
      if (!this.available) this.log.log('Caché disponible de nuevo');
      this.available = true;
    });
    this.client.connect().catch(() => undefined);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, { expiration: { type: 'EX', value: ttlSeconds } });
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async deleteMatching(pattern: string): Promise<number> {
    let deleted = 0;
    for await (const keys of this.client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      if (keys.length > 0) deleted += await this.client.del(keys);
    }
    return deleted;
  }

  onApplicationShutdown(): void {
    // destroy y no close: close esperaría a las órdenes pendientes contra un store que puede no estar.
    this.client.destroy();
  }
}`;
  return tsModule(REDIS_CACHE_STORE_TS, imports, body);
}

// ─── infrastructure/cache/cache-module.ts ────────────────────────────────────

function cacheModuleTs() {
  const imports = [
    { symbol: 'Global', from: '@nestjs/common' },
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: CONFIG_TS, type: true },
    { symbol: 'OperationCache', from: OPERATION_CACHE_TS },
    { symbol: 'CACHE_SETTINGS', from: CACHE_SETTINGS_TS },
    { symbol: 'cacheSettings', from: CACHE_SETTINGS_TS },
    { symbol: 'CacheSettings', from: CACHE_SETTINGS_TS, type: true },
    { symbol: 'CACHE_STORE', from: REDIS_OPERATION_CACHE_TS },
    { symbol: 'RedisOperationCache', from: REDIS_OPERATION_CACHE_TS },
    { symbol: 'RedisCacheStore', from: REDIS_CACHE_STORE_TS }
  ];
  const body = `/**
 * La caché de lectura del diseño. Global: los handlers inyectan el puerto OperationCache sin importarlo, y el
 * UseCaseMediator lo usa para vaciar lo que cada operación invalida. En el perfil test no hay store y toda
 * lectura va al origen.
 */
@Global()
@Module({})
export class CacheModule {
  static register(configuration: Configuration): DynamicModule {
    const settings = cacheSettings(configuration);
    return {
      module: CacheModule,
      providers: [
        { provide: CACHE_SETTINGS, useValue: settings },
        {
          provide: CACHE_STORE,
          useFactory: (resolved: CacheSettings) => (resolved.enabled ? new RedisCacheStore(resolved) : null),
          inject: [CACHE_SETTINGS]
        },
        { provide: OperationCache, useClass: RedisOperationCache }
      ],
      exports: [OperationCache]
    };
  }
}`;
  return tsModule(CACHE_MODULE_TS, imports, body);
}

// ─── El arnés: clearCache() en test/integration/support/flow.ts ──────────────

/**
 * Vaciado de la caché a mitad de escenario. La orden es literalmente la que ejecuta `infra/reset-db.sh`
 * (`cacheFlushCmd`, neutral): un helper que borrase otro conjunto dejaría al escenario midiendo un estado que
 * ningún flujo puede reproducir. El mismo helper que el `clearCache()` del AbstractFlowIT de keel-spring.
 */
export function cacheHarnessSection(model) {
  const entry = usesCache(model) && model.stack?.cache ? CACHES[model.stack.cache] : null;
  if (!entry) return '';
  return `
const CACHE_DEVTOOLS = ${tsString(devtoolsContainer(model.service.name))};

/**
 * Vacía las claves \`${model.service.artifactId}:*\` de la caché: las entradas cacheadas de cada operación.
 *
 * Es el subconjunto de caché de \`resetState()\`, con su misma orden. Vale para el Then que necesita medir un
 * MISS a mitad de flujo —que un dato se volvió a pedir al origen o al proveedor tras invalidarse— sin llevarse
 * por delante los datos que dejaron los escenarios anteriores del mismo flujo.
 */
export function clearCache(): void {
  run(containerRuntime(), ['exec', CACHE_DEVTOOLS, 'sh', '-c', ${tsString(cacheFlushCmd(entry, model.service))}], '¿Está la infraestructura arriba (bash infra/up.sh)?');
}
`;
}

// ─── Para quien compone otros archivos ───────────────────────────────────────

/** Las líneas del mediator: el import de las invalidaciones y del puerto. */
export function mediatorCacheImports(model) {
  if (!usesCache(model)) return [];
  return [
    { symbol: 'OperationCache', from: OPERATION_CACHE_TS },
    { symbol: 'CACHE_INVALIDATIONS', from: CACHE_INVALIDATIONS_TS }
  ];
}
