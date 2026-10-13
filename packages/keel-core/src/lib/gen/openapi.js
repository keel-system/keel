// El CONTRATO FORMAL de la API (`openapi.yaml`), derivado del modelo neutral: el mismo documento para el servidor de
// keel-spring y el de keel-nest del mismo diseño, porque los dos sirven ese contrato.
//
// Hasta aquí el `openapi.yaml` solo existía si el diseñador pasaba `/keel-docs`, que lo escribe un LLM siguiendo una
// guía; sin él, el agente de pruebas deducía la forma de cada respuesta del DSL y de `mapping.md` y no podía asertar
// en STRICT. Lo pidieron tres corridas seguidas (asset-vault y catalog de keel-spring, catalog de keel-nest), y el
// primer ciclo de asset-vault en keel-nest fueron once rojos por un `revisions: []` que nadie esperaba.
//
// Todo sale de lo que ya deciden los módulos neutrales: la ruta, el status y dónde viaja la entrada (`api-contract`),
// las cotas de cada campo (`validationRules`), el cable de cada tipo y la forma del error y de la página (`wire`), el
// acceso de cada ruta (`access-plan`). Nada de un lenguaje: lo vigila `gen-neutral.test.js`.

import YAML from 'yaml';
import { requestShape, returnsLocation, locationTarget } from './api-contract.js';
import { accessRequirement, usesTokenProtocol } from './access-plan.js';
import { isPublicBucket } from './buckets.js';
import { IDEMPOTENCY_HEADER } from './request-idempotency.js';
import { WIRE_SHAPES } from './wire.js';
import { FRAMEWORK_ERRORS } from '../framework-errors.js';
import { effectiveErrorCode, idempotencyOutcomeCodes } from './declared-errors.js';

const API_KEY_HEADER = 'X-API-Key';
const OPENAPI_VERSION = '3.1.0';

/** ¿Hay contrato HTTP que derivar? Una capa api con alguna operación con ruta. */
export function usesOpenapi(model) {
  return Boolean(model.layersPresent?.api) && operationsWithRoute(model).length > 0;
}

function operationsWithRoute(model) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.route);
}

/** El documento como objeto (para los tests) — el orden de las claves es el que se escribe. */
export function openapiDocument(model) {
  const components = new Map();
  const schema = (name, build) => {
    if (!components.has(name)) {
      components.set(name, null);
      components.set(name, build());
    }
    return { $ref: `#/components/schemas/${name}` };
  };
  const context = { model, schema };

  const paths = {};
  for (const operation of operationsWithRoute(model)) {
    const full = `${model.api.routeBase}${operation.route.path}`;
    paths[full] ??= {};
    paths[full][operation.route.method.toLowerCase()] = operationObject(context, operation);
  }

  schema('ErrorResponse', () => errorResponseSchema());
  const document = {
    openapi: OPENAPI_VERSION,
    info: {
      title: model.service.name,
      version: model.service.version,
      description: `${model.service.description ?? ''}`.trim() || undefined,
      'x-keel-derived': 'Derivado del diseño por el generador (keel-core/gen/openapi.js). No se edita: se regenera con build.'
    },
    // El host y el puerto son parámetro de despliegue, nunca dato de diseño (`SERVER_PORT`, 8080 por defecto en los dos).
    servers: [
      {
        url: '{baseUrl}',
        description: 'El host y el puerto son parámetro de despliegue, nunca dato de diseño.',
        variables: { baseUrl: { default: 'http://localhost:8080', description: 'Raíz del servicio desplegado.' } }
      }
    ],
    paths,
    components: { schemas: Object.fromEntries([...components.entries()].sort(([a], [b]) => a.localeCompare(b))) }
  };
  const schemes = securitySchemes(model);
  if (schemes) document.components.securitySchemes = schemes;
  // Sin capa security la API es abierta, y se dice: un documento sin `security` no distingue «abierta» de «nadie lo miró».
  else document.security = [];
  return prune(document);
}

/** El documento como YAML, determinista (sin timestamps): build lo escribe y un test lo compara. */
export function openapiYaml(model) {
  return YAML.stringify(openapiDocument(model), { lineWidth: 0 });
}

// ─── Operaciones ─────────────────────────────────────────────────────────────

function operationObject(context, operation) {
  const { model } = context;
  const shape = requestShape(operation);
  const inputs = (operation.bodyFields ?? []).filter((field) => !field.resolvedIdentity);
  const parameters = [];
  for (const param of operation.pathParams ?? []) {
    parameters.push({ name: param.name, in: 'path', required: true, schema: fieldSchema(context, param, { input: true }) });
  }
  if (!shape.asBody && !operation.multipart) {
    for (const field of inputs) {
      parameters.push({ name: field.name, in: 'query', required: Boolean(field.required), schema: fieldSchema(context, field, { input: true }), description: field.description ?? undefined });
    }
  }
  if (operation.paginated) {
    const pagination = model.pagination ?? {};
    parameters.push(
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'size', in: 'query', required: false, schema: { type: 'integer', minimum: 1, ...(pagination.maxSize ? { maximum: pagination.maxSize } : {}), ...(pagination.defaultSize ? { default: pagination.defaultSize } : {}) } },
      { name: 'sort', in: 'query', required: false, schema: { type: 'array', items: { type: 'string' } }, description: '`campo,asc|desc`; sin él, el orden que declara el diseño.' }
    );
  }
  if (operation.idempotency?.keySource === 'client-key') {
    parameters.push({ name: IDEMPOTENCY_HEADER, in: 'header', required: false, schema: { type: 'string' }, description: 'Clave de idempotencia: repetir la petición con la misma clave no la ejecuta dos veces.' });
  }

  const result = {
    operationId: operation.name,
    summary: operation.description ?? undefined,
    tags: [tagOf(model, operation)],
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody: requestBody(context, operation, inputs, shape),
    responses: responses(context, operation, inputs),
    security: operationSecurity(model, operation)
  };
  return result;
}

function tagOf(model, operation) {
  return (model.services ?? []).find((service) => service.operations.includes(operation))?.entity ?? model.service.name;
}

function requestBody(context, operation, inputs, shape) {
  if (operation.multipart) {
    return {
      required: true,
      content: { 'multipart/form-data': { schema: objectSchema(context, inputs, { input: true }) } }
    };
  }
  if (!shape.asBody) return undefined;
  const name = `${capitalize(operation.name)}Request`;
  return {
    required: shape.bodyRequired,
    content: { 'application/json': { schema: context.schema(name, () => objectSchema(context, inputs, { input: true })) } }
  };
}

function responses(context, operation, inputs) {
  const { model } = context;
  const result = {};
  const status = String(operation.route.status);
  const success = { description: operation.description ?? 'Éxito' };
  const dto = operation.responseDto;
  if (dto && operation.route.status !== 204) {
    const item = context.schema(dto.name, () => dtoSchema(context, dto.fields));
    const body = operation.paginated ? pagedSchema(context, dto.name, item) : operation.returnsList ? { type: 'array', items: item } : item;
    success.content = { 'application/json': { schema: body } };
  }
  if (returnsLocation(model, operation)) {
    const target = locationTarget(model, operation);
    success.headers = { Location: { description: `URL del recurso: ${target.path}`, schema: { type: 'string' } } };
  }
  result[status] = success;

  const errors = new Map();
  const add = (http, code, description) => {
    const key = String(http);
    if (!errors.has(key)) errors.set(key, []);
    errors.get(key).push(code ? `\`${code}\`: ${description ?? ''}`.trim() : description);
  };
  const validated = inputs.length > 0 || (operation.pathParams ?? []).length > 0;
  if (validated) add(400, 'VALIDATION_ERROR', 'la entrada no cumple el contrato.');
  if (operationSecurity(model, operation)?.length) {
    add(401, 'UNAUTHENTICATED', 'sin credencial, o la credencial no valida.');
    add(403, 'ACCESS_DENIED', 'la credencial no tiene el permiso de esta operación.');
  }
  // Lo que el servidor responde sin que el diseño lo declare (framework-errors.md), con el code de ESTA operación.
  if (operation.multipart) {
    add(FRAMEWORK_ERRORS.fileTooLarge.http, effectiveErrorCode(model, FRAMEWORK_ERRORS.fileTooLarge), 'el archivo supera el tamaño máximo de su bucket.');
  }
  if (operation.idempotency && operation.idempotency.guard !== 'natural-key') {
    for (const [entry, what] of [[FRAMEWORK_ERRORS.idempotencyRace, 'otra petición con la misma clave está en curso.'], [FRAMEWORK_ERRORS.idempotencyReuse, 'la misma clave con otro contenido.']]) {
      const row = idempotencyOutcomeCodes(model, entry).find((candidate) => candidate.operation === operation.name);
      if (row) add(entry.http, row.code, what);
    }
  }
  for (const code of operation.errors ?? []) {
    const error = (model.errors ?? []).find((candidate) => candidate.code === code);
    if (!error) continue;
    add(statusIn(error, operation.name), code, error.whenByOperation?.get(operation.name) ?? error.when);
  }
  for (const [http, lines] of [...errors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (result[http]) continue;
    result[http] = {
      description: lines.join('\n'),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
    };
  }
  return result;
}

/**
 * El status con el que ESTA operación declara un code. El mismo code puede ir con status distintos según la
 * operación (`statuses` es un Map status → operaciones); leerlo como un objeto por operación devolvía siempre
 * undefined y el contrato heredaba el status de la primera declaración (corrida de control del incremento 16:
 * TEMPLATE_NOT_FOUND salía 404 en requestNotification, que lo declara 422).
 */
function statusIn(error, operationName) {
  for (const [http, operations] of error.statuses ?? []) if (operations.includes(operationName)) return http;
  return error.http;
}

// ─── Esquemas ────────────────────────────────────────────────────────────────

/** Un objeto de entrada: las cotas del diseño, y obligatorio lo que declara presencia. */
function objectSchema(context, fields, { input }) {
  const properties = {};
  const required = [];
  for (const field of fields) {
    properties[field.wireName ?? field.name] = fieldSchema(context, field, { input });
    if (field.required) required.push(field.wireName ?? field.name);
  }
  return { type: 'object', properties, required: required.length > 0 ? required : undefined };
}

/**
 * Un DTO de respuesta, en el orden de sus campos. Con nulos incluidos (lo de defecto) TODOS los campos viajan, así
 * que todos son `required` y los que pueden faltar admiten null; con `conventions.nulls: omit` solo son `required`
 * los que nunca faltan. Una lista nunca es null (`list-never-null`).
 */
function dtoSchema(context, fields) {
  const omitNulls = Boolean(context.model.service.omitNulls);
  const properties = {};
  const required = [];
  for (const field of fields) {
    const name = field.wireName ?? field.name;
    const nullable = mayBeNull(field);
    const schema = fieldSchema(context, field, { input: false });
    properties[name] = nullable && !omitNulls ? orNull(schema) : schema;
    if (!omitNulls || !nullable) required.push(name);
  }
  return { type: 'object', properties, required: required.length > 0 ? required : undefined, additionalProperties: false };
}

function mayBeNull(field) {
  if (field.list) return false;
  if (field.kind === 'needDto') return true; // el dato ajeno puede faltar: lo dice el propio diseño (fallback, onMiss)
  return !(field.required || field.isId || field.generated);
}

function pagedSchema(context, dtoName, item) {
  return context.schema(`Paged${dtoName}`, () => {
    const types = { items: { type: 'array', items: item }, page: { type: 'integer' }, size: { type: 'integer' }, totalElements: { type: 'integer', format: 'int64' }, totalPages: { type: 'integer' } };
    return {
      type: 'object',
      properties: Object.fromEntries(WIRE_SHAPES.pagedResponse.map((name) => [name, types[name]])),
      required: [...WIRE_SHAPES.pagedResponse],
      additionalProperties: false
    };
  });
}

function errorResponseSchema() {
  const types = {
    timestamp: { type: 'string', format: 'date-time' },
    status: { type: 'integer' },
    error: { type: 'string' },
    code: { type: ['string', 'null'] },
    message: { type: 'string' },
    details: { type: ['array', 'null'], items: { type: 'string' } },
    correlationId: { type: ['string', 'null'] }
  };
  return {
    type: 'object',
    description: 'El cuerpo de error del contrato del cable: lleva siempre todos sus campos.',
    properties: Object.fromEntries(WIRE_SHAPES.errorResponse.map((name) => [name, types[name]])),
    required: [...WIRE_SHAPES.errorResponse]
  };
}

/** El esquema de un campo: el tipo como viaja por el cable y, en la entrada, sus cotas. */
function fieldSchema(context, field, { input }) {
  const element = elementSchema(context, field, { input });
  const described = field.description && !element.$ref ? { ...element, description: field.description } : element;
  if (field.list) {
    const items = input ? withRules(described, field.elementInputRules ?? []) : described;
    const array = { type: 'array', items };
    return input ? withRules(array, field.inputRules ?? [], { list: true }) : array;
  }
  return input ? withRules(described, field.inputRules ?? []) : described;
}

function elementSchema(context, field, { input }) {
  const { model } = context;
  switch (field.kind) {
    case 'enum': {
      const enumeration = (model.enums ?? []).find((candidate) => candidate.name === field.namedType);
      return enumeration
        ? context.schema(enumeration.name, () => ({ type: 'string', enum: enumeration.values.map((value) => value.literal), description: enumeration.description ?? undefined }))
        : { type: 'string' };
    }
    case 'composite': {
      const vo = (model.valueObjects ?? []).find((candidate) => candidate.name === field.namedType);
      return vo ? context.schema(vo.name, () => objectSchema(context, vo.fields, { input: false })) : { type: 'object' };
    }
    case 'childDto': {
      const child = (model.childDtos ?? []).find((candidate) => candidate.entity === field.childEntity);
      return child ? context.schema(child.name, () => dtoSchema(context, child.fields)) : { type: 'object' };
    }
    case 'refDto': {
      const ref = refDtoOf(model, field);
      return ref ? context.schema(ref.name, () => dtoSchema(context, ref.fields)) : { type: 'object' };
    }
    case 'needDto':
      return dtoSchema(context, field.needFields ?? []);
    case 'fileUpload':
      return { type: 'string', format: 'binary' };
    default:
      return baseSchema(model, field, { input });
  }
}

/** La RefDto de un campo embebido: la variante recortada si el campo excluye algo, la completa si no. */
function refDtoOf(model, field) {
  const full = (model.refDtos ?? []).find((candidate) => candidate.entity === field.refEntity);
  const excluded = field.refExclude ?? [];
  if (excluded.length === 0 || !full) return full;
  const wanted = full.fields.filter((candidate) => !excluded.includes(candidate.name)).map((candidate) => candidate.name).join(',');
  return (model.refVariants ?? []).find((variant) => variant.entity === field.refEntity && variant.fields.map((candidate) => candidate.name).join(',') === wanted) ?? full;
}

/** El cable de cada tipo base (`WIRE_RULES`). */
function baseSchema(model, field, { input }) {
  switch (field.base) {
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'int':
      return { type: 'integer', format: 'int32' };
    case 'long':
      return { type: 'integer', format: 'int64' };
    case 'decimal':
      return { type: 'number', description: 'Decimal exacto: viaja con su escala y en notación plana (2.50, nunca 2.5 ni 1E-7).' };
    case 'boolean':
      return { type: 'boolean' };
    case 'timestamp':
      return { type: 'string', format: 'date-time', description: 'ISO-8601 en UTC con tres decimales y sufijo Z.' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'json':
      return { description: 'Valor JSON embebido (no una cadena escapada).' };
    case 'file':
      if (input) return { type: 'string', format: 'binary' };
      return isPublicBucket(model, field.bucket)
        ? { type: 'string', format: 'uri', description: `URL absoluta del objeto en el bucket público ${field.bucket}.` }
        : { type: 'string', description: `Referencia al objeto en el bucket ${field.bucket}.` };
    default:
      return { type: 'string' };
  }
}

/** Las reglas neutrales de entrada (`validationRules`) como palabras de JSON Schema. */
function withRules(schema, rules, { list = false } = {}) {
  if (schema.$ref) return schema;
  const out = { ...schema };
  for (const rule of rules) {
    if (rule.rule === 'notBlank') {
      out.minLength = Math.max(out.minLength ?? 0, 1);
      out.pattern ??= '\\S';
    } else if (rule.rule === 'notEmpty') {
      out.minItems = Math.max(out.minItems ?? 0, 1);
    } else if (rule.rule === 'size') {
      if (list) {
        if (rule.min != null) out.minItems = rule.min;
        if (rule.max != null) out.maxItems = rule.max;
      } else {
        if (rule.min != null) out.minLength = rule.min;
        if (rule.max != null) out.maxLength = rule.max;
      }
    } else if (rule.rule === 'pattern') {
      out.pattern = rule.regexp;
    } else if (rule.rule === 'min') {
      out.minimum = Number(rule.value);
    } else if (rule.rule === 'max') {
      out.maximum = Number(rule.value);
    } else if (rule.rule === 'digits') {
      out['x-keel-digits'] = { integer: rule.integer, fraction: rule.fraction };
    }
  }
  return out;
}

function orNull(schema) {
  if (schema.$ref) return { anyOf: [schema, { type: 'null' }] };
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] };
  if (schema.type === undefined && !schema.enum) return schema; // sin tipo (json): ya admite null
  return { anyOf: [schema, { type: 'null' }] };
}

// ─── Seguridad ───────────────────────────────────────────────────────────────

function securitySchemes(model) {
  const security = model.layersPresent?.security ? model.security : null;
  if (!security || security.protocol === 'none') return null;
  if (usesTokenProtocol(security)) return { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } };
  if (security.protocol === 'api-key') return { apiKeyAuth: { type: 'apiKey', in: 'header', name: API_KEY_HEADER } };
  return null;
}

/** Lo que exige la regla de la ruta (o la de por defecto): público → sin seguridad; si no, el esquema del protocolo. */
function operationSecurity(model, operation) {
  const schemes = securitySchemes(model);
  if (!schemes) return undefined;
  const full = `${model.api.routeBase}${operation.route.path}`;
  const matcher = (model.security.matchers ?? []).find((candidate) => candidate.path === full && (!candidate.method || candidate.method === operation.route.method));
  const requirement = accessRequirement(matcher?.access ?? model.security.defaultRule);
  if (requirement.kind === 'public') return [];
  return [Object.fromEntries(Object.keys(schemes).map((name) => [name, []]))];
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function capitalize(name) {
  return `${name[0].toUpperCase()}${name.slice(1)}`;
}

/** Sin claves `undefined`: el YAML no las escribe, pero un deepEqual sí las ve. */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, prune(item)]));
  }
  return value;
}

/**
 * El archivo que escribe build: `docs/openapi.yaml`, salvo que el diseñador haya pasado `/keel-docs` y el workspace
 * traiga el suyo (entonces build copia ese, que puede llevar ejemplos y prosa que este no tiene).
 */
export function derivedOpenapiFiles(model) {
  if (!usesOpenapi(model)) return [];
  if ((model.docs?.files ?? []).some((file) => file.path === 'openapi.yaml')) return [];
  return [{ path: 'docs/openapi.yaml', content: openapiYaml(model) }];
}
