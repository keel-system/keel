// La infraestructura REST que no depende de ninguna operación: la correlación, el cuerpo de error,
// la lectura y validación de una petición y el filtro que traduce cualquier fallo a ErrorResponse.
// Los controladores de cada operación los emite controllers.js sobre esto.
//
// El contrato es el del servidor de keel-spring del mismo diseño, y por eso se copian sus textos:
//   · la forma y el orden de ErrorResponse los fija keel-core (WIRE_SHAPES.errorResponse); un campo
//     sin valor viaja como null, nunca se omite;
//   · `error` es el de su ApiExceptionHandler ("Validation Error", "Bad Request"…), y el `code` de un
//     fallo de forma es VALIDATION_ERROR (FRAMEWORK_ERRORS.validation);
//   · `details` de una validación es «campo mensaje», con los mensajes por defecto de Hibernate
//     Validator en inglés, que es lo que imprime Bean Validation;
//   · una petición que no se puede LEER (JSON roto, un tipo que no encaja, un value object que su
//     constructor rechaza) es 400 «Petición malformada» sin details — en Spring eso es
//     HttpMessageNotReadableException, que no distingue la causa.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { tsModule } from './render.js';
import { DOMAIN_EXCEPTION_TS, BASE_SUBCLASSES } from './exceptions.js';
import { usesPersistence } from './persistence-entities.js';
import { PERSISTENCE_ERRORS_TS } from './repositories.js';
import { usesMessaging, usesSubscriptionMessages } from './messaging.js';

export const CORRELATION_TS = 'src/infrastructure/correlation/correlation-context.ts';
export const ERROR_RESPONSE_TS = 'src/infrastructure/rest/error-response.ts';
export const REQUEST_ERRORS_TS = 'src/infrastructure/rest/request-errors.ts';
export const REQUEST_READING_TS = 'src/infrastructure/rest/request-reading.ts';
export const EXCEPTION_FILTER_TS = 'src/infrastructure/rest/api-exception-filter.ts';
export const ROUTES_TS = 'src/infrastructure/rest/routes.ts';
const WIRE_TS = 'src/application/support/wire.ts';
const DECIMAL_TS = 'src/domain/support/decimal.ts';
const RAW_JSON_TS = 'src/domain/support/raw-json.ts';

/** ¿Expone el servicio una API? Sin capa api no hay nada de esto. */
export function usesApi(model) {
  return Boolean(model.layersPresent?.api) && (model.services ?? []).some((service) => (service.operations ?? []).some((op) => op.route));
}

/**
 * ¿Hace falta la correlación sin API? Sí con mensajería: los eventos la llevan en su metadata y los
 * listeners la abren con lo que trae cada mensaje.
 */
export function usesCorrelation(model) {
  return usesApi(model) || usesMessaging(model);
}

export function generate(model) {
  if (!usesApi(model)) {
    // Sin API, solo lo que la mensajería comparte con ella: la correlación y la lectura de valores del
    // cable (los mensajes de las suscripciones se leen con los mismos lectores y las mismas reglas).
    const files = [];
    if (usesCorrelation(model)) files.push(correlationFile());
    if (usesSubscriptionMessages(model)) files.push(requestErrorsFile(), requestReadingFile());
    return files;
  }
  return [
    correlationFile(),
    { path: ERROR_RESPONSE_TS, content: tsModule(ERROR_RESPONSE_TS, [{ symbol: 'CorrelationContext', from: CORRELATION_TS }], errorResponseBody()) },
    requestErrorsFile(),
    requestReadingFile(),
    {
      path: EXCEPTION_FILTER_TS,
      content: tsModule(
        EXCEPTION_FILTER_TS,
        [
          ...filterImports(),
          ...(usesPersistence(model)
            ? [
                { symbol: 'translatePersistenceError', from: PERSISTENCE_ERRORS_TS },
                { symbol: 'TRANSACTION_TIMEOUT', from: PERSISTENCE_ERRORS_TS },
                { symbol: 'UNKNOWN_INTEGRITY', from: PERSISTENCE_ERRORS_TS }
              ]
            : [])
        ],
        filterBody(usesPersistence(model))
      )
    }
  ];
}

function correlationFile() {
  return {
    path: CORRELATION_TS,
    content: tsModule(CORRELATION_TS, [
      { symbol: 'AsyncLocalStorage', from: 'node:async_hooks' },
      { symbol: 'randomUUID', from: 'node:crypto' }
    ], correlationBody())
  };
}

function requestErrorsFile() {
  return { path: REQUEST_ERRORS_TS, content: tsModule(REQUEST_ERRORS_TS, [], requestErrorsBody()) };
}

function requestReadingFile() {
  return { path: REQUEST_READING_TS, content: tsModule(REQUEST_READING_TS, [
      { symbol: 'Decimal', from: DECIMAL_TS },
      { symbol: 'RawJson', from: RAW_JSON_TS },
      { symbol: 'toDecimal', from: WIRE_TS },
      { symbol: 'toInt', from: WIRE_TS },
      { symbol: 'toLong', from: WIRE_TS },
      { symbol: 'toTimestamp', from: WIRE_TS },
      { symbol: 'toDate', from: WIRE_TS },
      { symbol: 'toJson', from: WIRE_TS },
      { symbol: 'MalformedRequestError', from: REQUEST_ERRORS_TS },
      { symbol: 'MissingParameterError', from: REQUEST_ERRORS_TS },
      { symbol: 'RequestValidationError', from: REQUEST_ERRORS_TS }
    ], requestReadingBody()) };
}

function correlationBody() {
  return `/**
 * Contexto de correlación de la petición o del mensaje en curso: el hilo que une petición HTTP →
 * caso de uso → evento → mensaje saliente, y el valor que lleva ErrorResponse.
 *
 * Vive en un AsyncLocalStorage, que es lo que en Node sigue a una petición a través de sus awaits
 * (en Java, el ThreadLocal + MDC de CorrelationContext). Lo abre el hook de entrada HTTP
 * (http-platform.ts) con runWith, que también lo cierra: no hay set/clear que olvidar.
 */
export const CORRELATION_HEADER = 'X-Correlation-Id';

/**
 * Lo que se acepta como correlationId. El valor llega de FUERA y acaba en logs, cabeceras y
 * eventos: sin cota, un cliente podría meter saltos de línea o kilobytes en cada registro.
 */
const ACCEPTED = /^[A-Za-z0-9._-]{1,64}$/;

const storage = new AsyncLocalStorage<string>();

export const CorrelationContext = {
  /**
   * El correlationId EFECTIVO para un valor recibido: el mismo si cumple el formato; uno nuevo si
   * no llegó o no lo cumple. No se trunca: produciría ids que se confunden entre sí.
   */
  accept(received: unknown): string {
    return typeof received === 'string' && ACCEPTED.test(received) ? received : randomUUID();
  },

  /** La correlación en curso, o null si no hay ninguna abierta. */
  get(): string | null {
    return storage.getStore() ?? null;
  },

  /** Ejecuta la acción con la correlación indicada (sin valor, sin abrir ninguna). */
  runWith<T>(correlationId: string | null | undefined, action: () => T): T {
    if (correlationId == null || correlationId.trim() === '') return action();
    return storage.run(CorrelationContext.accept(correlationId), action);
  }
};`;
}

function errorResponseBody() {
  const types = {
    timestamp: 'Date',
    status: 'number',
    error: 'string',
    code: 'string | null',
    message: 'string',
    details: 'readonly string[] | null',
    correlationId: 'string | null'
  };
  const missing = WIRE_SHAPES.errorResponse.filter((name) => !types[name]);
  if (missing.length > 0) throw new Error(`ErrorResponse: el contrato del cable nombra ${missing.join(', ')} y keel-nest no lo emite`);
  return `/**
 * Contrato de error de la API: el cuerpo uniforme de todo fallo, con la forma y el orden del cable
 * (keel-core, WIRE_SHAPES.errorResponse).
 *
 * Los campos sin valor viajan como null (details fuera de una validación, code en un fallo sin
 * código): no se omiten, porque la forma del cuerpo de error es contrato estable.
 */
export class ErrorResponse {
  constructor(
${WIRE_SHAPES.errorResponse.map((name) => `    readonly ${name}: ${types[name]}`).join(',\n')}
  ) {}

  static of(status: number, error: string, code: string | null, message: string, details: readonly string[] | null = null): ErrorResponse {
    return new ErrorResponse(new Date(), status, error, code, message, details, CorrelationContext.get());
  }
}`;
}

function requestErrorsBody() {
  return `/**
 * Los fallos de LECTURA de una petición, antes de que llegue a ningún caso de uso. Los traduce
 * ApiExceptionFilter; no son errores de dominio.
 */

/** La petición no se puede leer: JSON roto, un tipo que no encaja, un value object inválido. */
export class MalformedRequestError extends Error {
  constructor(reason = 'Petición malformada') {
    super(reason);
    this.name = 'MalformedRequestError';
  }
}

/** Falta un parámetro obligatorio de la query. */
export class MissingParameterError extends Error {
  constructor(readonly parameter: string) {
    super(\`Falta el parámetro '\${parameter}' en la petición\`);
    this.name = 'MissingParameterError';
  }
}

/** Falta la parte binaria obligatoria de una subida multipart. */
export class MissingPartError extends Error {
  constructor(readonly part: string) {
    super(\`Falta la parte '\${part}' en la petición multipart\`);
    this.name = 'MissingPartError';
  }
}

/** Una operación de subida recibió un cuerpo que no es multipart/form-data. */
export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super('La operación espera multipart/form-data');
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * La petición se leyó pero incumple lo que el diseño declara. \`source\` distingue el cuerpo de los
 * parámetros sueltos (ruta y query), que en keel-spring salen con mensajes distintos.
 */
export class RequestValidationError extends Error {
  constructor(
    readonly details: readonly string[],
    readonly source: 'body' | 'params'
  ) {
    super('La petición no supera las validaciones');
    this.name = 'RequestValidationError';
  }
}`;
}

function requestReadingBody() {
  return `// Lectura de una petición: convertir lo que llega por el cable al tipo del diseño, y validar lo que
// el diseño declara. Lo usan los lectores que genera build para cada operación (controllers/).

/** Un lector convierte un valor del cable al tipo del diseño, o lanza MalformedRequestError. */
export type Reader<T> = (value: unknown) => T | null;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INTEGER = /^[+-]?\\d+$/;

function malformed(): never {
  throw new MalformedRequestError();
}

/** Convierte con un conversor del contrato del cable: lo que no encaja es una petición malformada. */
function wire<T>(convert: (value: unknown) => T): Reader<T> {
  return (value) => {
    if (value == null) return null;
    try {
      return convert(value);
    } catch {
      return malformed();
    }
  };
}

type EnumLike = Record<string, string>;

/** Lectores de valores dentro de un cuerpo JSON (ya leído por el contrato del cable). */
export const json = {
  string: ((value) => (value == null ? null : typeof value === 'string' ? value : malformed())) as Reader<string>,
  boolean: ((value) => (value == null ? null : typeof value === 'boolean' ? value : malformed())) as Reader<boolean>,
  int: wire(toInt),
  long: wire(toLong),
  decimal: wire(toDecimal),
  timestamp: wire(toTimestamp),
  date: wire(toDate),
  json: wire(toJson),
  /** Un uuid en su forma canónica de 36 caracteres; sale en minúsculas. */
  uuid: ((value) => {
    if (value == null) return null;
    return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : malformed();
  }) as Reader<string>,
  /** Un enum por el LITERAL del diseño, exacto: es lo que escribe el cable. */
  enumOf<E extends EnumLike>(type: E): Reader<E[keyof E]> {
    const literals = new Set<string>(Object.values(type));
    return (value) => (value == null ? null : typeof value === 'string' && literals.has(value) ? (value as E[keyof E]) : malformed());
  },
  listOf<T>(element: Reader<T>): Reader<T[]> {
    return (value) => (value == null ? null : Array.isArray(value) ? value.map((item) => element(item) as T) : malformed());
  }
};

/**
 * Lectores de un valor de TEXTO (ruta y query), con las conversiones de Spring: un booleano admite
 * true/false, yes/no, on/off y 1/0; un enum, su literal o el nombre de la constante sin distinguir
 * mayúsculas; un uuid, lo que admite UUID.fromString. Vacío es «sin valor».
 */
export const text = {
  string: ((value) => (value == null ? null : String(value))) as Reader<string>,
  int: ((value) => {
    const raw = blankToNull(value);
    if (raw == null) return null;
    const parsed = INTEGER.test(raw) ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : malformed();
  }) as Reader<number>,
  long: ((value) => {
    const raw = blankToNull(value);
    if (raw == null) return null;
    if (!INTEGER.test(raw)) return malformed();
    const parsed = BigInt(raw);
    return parsed >= -(2n ** 63n) && parsed < 2n ** 63n ? parsed : malformed();
  }) as Reader<bigint>,
  decimal: ((value) => {
    const raw = blankToNull(value);
    if (raw == null) return null;
    try {
      return Decimal.parse(raw);
    } catch {
      return malformed();
    }
  }) as Reader<Decimal>,
  boolean: ((value) => {
    const raw = blankToNull(value)?.toLowerCase();
    if (raw == null) return null;
    if (['true', 'on', 'yes', '1'].includes(raw)) return true;
    if (['false', 'off', 'no', '0'].includes(raw)) return false;
    return malformed();
  }) as Reader<boolean>,
  uuid: ((value) => {
    const raw = blankToNull(value);
    return raw == null ? null : javaUuid(raw);
  }) as Reader<string>,
  timestamp: ((value) => wire(toTimestamp)(blankToNull(value))) as Reader<Date>,
  date: ((value) => wire(toDate)(blankToNull(value))) as Reader<string>,
  json: ((value) => {
    const raw = blankToNull(value);
    if (raw == null) return null;
    try {
      return RawJson.of(raw);
    } catch {
      return malformed();
    }
  }) as Reader<RawJson>,
  enumOf<E extends EnumLike>(type: E): Reader<E[keyof E]> {
    const entries = Object.entries(type);
    return (value) => {
      const raw = blankToNull(value)?.trim();
      if (raw == null || raw === '') return null;
      const found = entries.find(([name, literal]) => literal === raw || name.toLowerCase() === raw.toLowerCase());
      return found ? (found[1] as E[keyof E]) : malformed();
    };
  },
  /** Una lista en la query: el parámetro repetido o separado por comas. */
  listOf<T>(element: Reader<T>): Reader<T[]> {
    return (value) => {
      if (value == null) return null;
      const items = Array.isArray(value) ? value.map(String) : String(value).split(',');
      return items.map((item) => element(item) as T);
    };
  }
};

function blankToNull(value: unknown): string | null {
  if (value == null) return null;
  // Un parámetro repetido donde se espera uno solo: Spring toma el primero.
  const raw = Array.isArray(value) ? String(value[0]) : String(value);
  return raw.trim() === '' ? null : raw;
}

/** UUID.fromString de Java: cinco grupos hexadecimales que caben en 8-4-4-4-12; sale canónico. */
function javaUuid(raw: string): string {
  const parts = raw.split('-');
  const widths = [8, 4, 4, 4, 12];
  if (raw.length > 36 || parts.length !== 5) return malformed();
  const canonical = parts.map((part, index) => {
    if (!/^[0-9a-fA-F]+$/.test(part) || part.length > widths[index]!) malformed();
    return part.toLowerCase().padStart(widths[index]!, '0');
  });
  return canonical.join('-');
}

/** Un value object no se lee de un texto (ruta o query): si llega, la petición es malformada. */
export const unreadableAsText: Reader<never> = (value) => (value == null ? null : malformed());

/** Un parámetro obligatorio de la query tiene que venir; vacío cuenta como presente (lo juzga su regla). */
export function requireParameter(query: Record<string, unknown>, name: string): void {
  if (query[name] === undefined) throw new MissingParameterError(name);
}

/** Lo que esta versión de keel-nest todavía no sabe leer: falla en ejecución, nombrándolo. */
export function unsupported(what: string): never {
  throw new Error(\`TODO: \${what}\`);
}

/** El cuerpo de la petición como objeto: sin cuerpo, solo si es opcional. */
export function bodyObject(body: unknown, required: boolean): Record<string, unknown> {
  if (body == null) return required ? malformed() : {};
  return typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : malformed();
}

/** Un value object del cuerpo: un objeto JSON; si su constructor lo rechaza, la petición es malformada. */
export function valueObject<T>(value: unknown, build: (fields: Record<string, unknown>) => T): T | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return malformed();
  try {
    return build(value as Record<string, unknown>);
  } catch (error) {
    if (error instanceof MalformedRequestError) throw error;
    // El constructor del value object rechazó el valor: en keel-spring eso pasa dentro de Jackson,
    // y sale como petición malformada.
    return malformed();
  }
}

// ─── Validación ──────────────────────────────────────────────────────────────

/** Una regla de validación del diseño (keel-core/gen/constraints.js, validationRules). */
export type Rule =
  | { readonly rule: 'notBlank' | 'notNull' | 'notEmpty' }
  | { readonly rule: 'size'; readonly min: number | null; readonly max: number | null }
  | { readonly rule: 'pattern'; readonly regexp: string }
  | { readonly rule: 'min' | 'max'; readonly value: number | string; readonly decimal: boolean }
  | { readonly rule: 'digits'; readonly integer: number; readonly fraction: number };

/**
 * Acumula las violaciones de una petición y lanza UNA vez con todas, como Bean Validation. Cada una
 * es «campo mensaje», con el mensaje por defecto de Hibernate Validator.
 */
export class Violations {
  private readonly details: string[] = [];

  constructor(private readonly source: 'body' | 'params') {}

  check(path: string, value: unknown, rules: readonly Rule[]): this {
    for (const rule of rules) {
      const message = violation(rule, value);
      if (message) this.details.push(\`\${path} \${message}\`);
    }
    return this;
  }

  throwIfAny(): void {
    if (this.details.length > 0) throw new RequestValidationError([...this.details], this.source);
  }
}

function violation(rule: Rule, value: unknown): string | null {
  switch (rule.rule) {
    case 'notNull':
      return value == null ? 'must not be null' : null;
    case 'notBlank':
      return value == null || (typeof value === 'string' && value.trim() === '') ? 'must not be blank' : null;
    case 'notEmpty':
      return value == null || (Array.isArray(value) && value.length === 0) || value === '' ? 'must not be empty' : null;
    case 'size': {
      if (value == null) return null;
      const length = typeof value === 'string' || Array.isArray(value) ? value.length : null;
      if (length == null) return null;
      const min = rule.min ?? 0;
      const max = rule.max ?? 2147483647;
      return length < min || length > max ? \`size must be between \${min} and \${max}\` : null;
    }
    case 'pattern':
      if (typeof value !== 'string') return null;
      return new RegExp(\`^(?:\${rule.regexp})$\`).test(value) ? null : \`must match "\${rule.regexp}"\`;
    case 'min':
    case 'max': {
      const comparison = compare(value, rule.value);
      if (comparison == null) return null;
      if (rule.rule === 'min') return comparison < 0 ? \`must be greater than or equal to \${rule.value}\` : null;
      return comparison > 0 ? \`must be less than or equal to \${rule.value}\` : null;
    }
    case 'digits': {
      if (!(value instanceof Decimal)) return null;
      const [integer = '', fraction = ''] = value.toString().replace('-', '').split('.');
      const significant = integer.replace(/^0+/, '');
      return significant.length > rule.integer || fraction.replace(/0+$/, '').length > rule.fraction
        ? \`numeric value out of bounds (<\${rule.integer} digits>.<\${rule.fraction} digits> expected)\`
        : null;
    }
  }
}

function compare(value: unknown, bound: number | string): number | null {
  if (value instanceof Decimal) return value.compareTo(Decimal.parse(String(bound)));
  if (typeof value === 'bigint') return value < BigInt(bound) ? -1 : value > BigInt(bound) ? 1 : 0;
  if (typeof value === 'number') return Math.sign(value - Number(bound));
  return null;
}`;
}

// Textos y status de ApiExceptionHandler de keel-spring, por subclase de DomainException.
const DOMAIN_RESPONSES = {
  BadRequestException: ['Bad Request', 'Petición inválida'],
  UnauthorizedException: ['Unauthorized', 'Autenticación requerida'],
  ForbiddenException: ['Forbidden', 'Acceso denegado'],
  NotFoundException: ['Not Found', 'Recurso no encontrado'],
  ConflictException: ['Conflict', 'Conflicto con el estado actual del recurso'],
  PayloadTooLargeException: ['Payload Too Large', 'El contenido enviado supera el tamaño permitido'],
  BusinessException: ['Business Rule Violation', 'Se violó una regla de negocio']
};

function filterImports() {
  return [
    { symbol: 'Catch', from: '@nestjs/common' },
    { symbol: 'HttpException', from: '@nestjs/common' },
    { symbol: 'Logger', from: '@nestjs/common' },
    // El de Nest (ninguna ruta casa) se llama igual que el del dominio: va con alias.
    { symbol: 'NotFoundException as RouteNotFound', from: '@nestjs/common' },
    { symbol: 'ArgumentsHost', from: '@nestjs/common', type: true },
    { symbol: 'ExceptionFilter', from: '@nestjs/common', type: true },
    { symbol: 'FastifyReply', from: 'fastify', type: true },
    { symbol: 'FastifyRequest', from: 'fastify', type: true },
    { symbol: 'STATUS_CODES', from: 'node:http' },
    { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
    ...BASE_SUBCLASSES.map(({ name }) => ({ symbol: name, from: `src/domain/errors/${fileOfError(name)}.ts` })),
    { symbol: 'ErrorResponse', from: ERROR_RESPONSE_TS },
    { symbol: 'MalformedRequestError', from: REQUEST_ERRORS_TS },
    { symbol: 'MissingParameterError', from: REQUEST_ERRORS_TS },
    { symbol: 'MissingPartError', from: REQUEST_ERRORS_TS },
    { symbol: 'UnsupportedMediaTypeError', from: REQUEST_ERRORS_TS },
    { symbol: 'RequestValidationError', from: REQUEST_ERRORS_TS },
    { symbol: 'allowsOtherMethod', from: ROUTES_TS }
  ];
}

function fileOfError(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Los fallos de la persistencia, en el orden del ApiExceptionHandler de keel-spring: la violación de
// una constraint con nombre es el error que el diseño declara para ella, el conflicto de versión (o el
// interbloqueo agotado) el de concurrencia, y el tope de transacción un 503 transitorio.
const PERSISTENCE_BRANCH = `    // ── Persistencia
    const persisted = translatePersistenceError(exception);
    if (persisted === 'timeout') {
      // Sin pila: el motivo va en el mensaje, y una ráfaga de esperas de bloqueo llenaría el log.
      this.log.warn(\`Transacción cancelada por tiempo: \${exception instanceof Error ? exception.message : String(exception)}\`);
      return ErrorResponse.of(TRANSACTION_TIMEOUT.status, 'Service Unavailable', TRANSACTION_TIMEOUT.code, TRANSACTION_TIMEOUT.message, []);
    }
    if (persisted === 'integrity') {
      this.log.warn('Violación de integridad no asociada a ninguna constraint conocida', exception instanceof Error ? exception.stack : String(exception));
      return ErrorResponse.of(UNKNOWN_INTEGRITY.status, 'Conflict', null, UNKNOWN_INTEGRITY.message);
    }
    if (persisted != null) return this.fromDomain(persisted);
`;

function filterBody(persistence = false) {
  const validation = FRAMEWORK_ERRORS.validation.code;
  const domainBranches = BASE_SUBCLASSES.map(({ name, http }) => {
    const [error, fallback] = DOMAIN_RESPONSES[name];
    return `    if (exception instanceof ${name}) return this.domain(${http}, '${error}', exception, '${fallback}');`;
  }).join('\n');
  return `/**
 * Traduce CUALQUIER fallo a ErrorResponse, con el status, el \`error\` y el \`code\` que da el
 * ApiExceptionHandler de keel-spring para el mismo caso. Se registra global en http-platform.ts.
 *
 * Orden: los fallos de lectura de la petición, las rutas que no existen, la jerarquía de
 * DomainException (cada subclase con su status fijo; un error con status propio lo lleva en su
 * metadata) y el catch-all 500.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const body = this.toResponse(exception, http.getRequest<FastifyRequest>());
    if (body instanceof HttpException) {
      void reply.status(body.getStatus()).send(body.getResponse());
      return;
    }
    // El tope de transacción es transitorio: el cliente puede reintentar, y se lo dice la cabecera.
    if (body.status === 503 && body.code === '${FRAMEWORK_ERRORS.transactionTimeout.code}') void reply.header('Retry-After', '1');
    void reply.status(body.status).send(body);
  }

  private toResponse(exception: unknown, request: FastifyRequest): ErrorResponse | HttpException {
    // ── Validación: errores de FORMA de la petición, 400. El 422 queda para las reglas de negocio.
    if (exception instanceof RequestValidationError) {
      const message = exception.source === 'body' ? 'La petición no supera las validaciones' : 'La petición viola restricciones declaradas';
      return ErrorResponse.of(400, 'Validation Error', '${validation}', message, exception.details);
    }
    // ── Errores de framework
    if (exception instanceof MissingParameterError) {
      return ErrorResponse.of(400, 'Bad Request', '${validation}', exception.message);
    }
    if (exception instanceof MalformedRequestError) {
      return ErrorResponse.of(400, 'Bad Request', '${validation}', 'Petición malformada');
    }
    // La subida multipart: la parte que falta, sin code (el MissingServletRequestPartException de keel-spring), y
    // un cuerpo que no es multipart.
    if (exception instanceof MissingPartError) {
      return ErrorResponse.of(400, 'Bad Request', null, exception.message);
    }
    if (exception instanceof UnsupportedMediaTypeError) {
      return ErrorResponse.of(415, 'Unsupported Media Type', null, exception.message);
    }
    if (exception instanceof RouteNotFound) {
      // Ninguna ruta casa con método y camino. Si el camino existe con otro método, es un 405.
      if (allowsOtherMethod(request.method, request.url)) {
        return ErrorResponse.of(405, 'Method Not Allowed', null, 'Método HTTP no soportado');
      }
      return ErrorResponse.of(404, 'Not Found', null, 'Recurso no encontrado');
    }
${persistence ? PERSISTENCE_BRANCH : ''}    // ── Errores de dominio (jerarquía DomainException)
    if (exception instanceof DomainException) return this.fromDomain(exception);
    // Una excepción HTTP del propio framework: un 400 es el lector JSON de http-platform (petición
    // malformada); cualquier otra trae su propio cuerpo y sale con él — es lo que hacen las sondas
    // /livez y /readyz, que no son API del diseño (en keel-spring las sirve el actuator, fuera de
    // ApiExceptionHandler).
    if (exception instanceof HttpException) {
      if (exception.getStatus() === 400) return ErrorResponse.of(400, 'Bad Request', '${validation}', 'Petición malformada');
      return exception;
    }
    // ── Catch-all
    this.log.error('Excepción no controlada', exception instanceof Error ? exception.stack : String(exception));
    return ErrorResponse.of(500, 'Internal Server Error', null, 'Ocurrió un error inesperado');
  }

  private fromDomain(exception: DomainException): ErrorResponse {
${domainBranches}
    // Errores con status extendido (402, 429, 503…): extienden DomainException y lo llevan en la metadata.
    const status = exception.httpStatus ?? 422;
    const phrase = STATUS_CODES[status] ?? 'Error';
    return ErrorResponse.of(status, phrase, exception.code, exception.message || phrase, exception.details);
  }

  private domain(status: number, error: string, exception: DomainException, fallback: string): ErrorResponse {
    return ErrorResponse.of(status, error, exception.code, exception.message || fallback, exception.details);
  }
}`;
}
