// Construye el modelo intermedio del scaffolding: un contexto plano derivado
// mecánicamente del diseño (manifest + capas parseadas). Los generadores de
// src/scaffold/ solo renderizan este modelo; aquí vive toda la interpretación
// del DSL (ver conventions/mapping.md).

import { pascalCase, camelCase, kebabCase, snakeCase, screamingSnake, pluralize, basePackage } from './naming.js';
import { resolveType, beanValidationAnnotations, columnAnnotations } from './type-mapper.js';

const CRUD_PREFIXES = ['create', 'get', 'list', 'update', 'delete'];

// http declarado en el diseño → excepción base de shared/exception que extiende
// el error generado; los status sin subclase dedicada extienden DomainException
// pasando el httpStatus por metadata.
const SHARED_EXCEPTION_BY_HTTP = {
  400: 'BadRequestException',
  401: 'UnauthorizedException',
  403: 'ForbiddenException',
  404: 'NotFoundException',
  409: 'ConflictException',
  422: 'BusinessException'
};

export function sharedExceptionFor(http) {
  return SHARED_EXCEPTION_BY_HTTP[http] ?? 'DomainException';
}

export function buildModel({ manifest, layers, stack = null }) {
  const warnings = [];
  const domain = layers.domain ?? { entities: {} };
  const domainTypes = domain.types ?? {};
  const persistence = layers.persistence ?? null;
  const hasPersistence = Boolean(persistence);

  const service = buildService(manifest, stack);
  service.basePath = layers.api?.basePath ?? null;
  const layersPresent = {
    api: Boolean(layers.api),
    persistence: hasPersistence,
    messaging: Boolean(layers.messaging),
    security: Boolean(layers.security),
    httpClients: Boolean(layers['http-clients']),
    storage: Boolean(layers.storage)
  };

  const enums = collectEnums(domain, layers['http-clients'], warnings);
  const inlineEnumName = buildInlineEnumIndex(enums);
  const valueObjects = collectValueObjects(domainTypes, domainTypes, inlineEnumName, hasPersistence);
  const entities = collectEntities(domain, persistence, domainTypes, inlineEnumName, hasPersistence, warnings);
  const { services, errors } = collectOperations(layers, domainTypes, inlineEnumName, service, warnings);
  const events = collectEvents(layers, domainTypes, inlineEnumName, warnings);
  const subscriptions = collectSubscriptions(layers, services, domainTypes, inlineEnumName, warnings);
  const pagination = layers.api?.pagination ?? null;

  // Base de rutas versionada (estilo del prototipo de referencia): el basePath
  // del diseño (o /api/<servicio>) + /v1, puesta en el @RequestMapping de cada
  // controller (no en server.servlet.context-path).
  const api = { routeBase: `${layers.api?.basePath ?? `/api/${kebabCase(service.name)}`}/v1` };

  const security = collectSecurity(layers, services, api.routeBase, warnings);
  const httpClients = collectHttpClients(layers, domainTypes, inlineEnumName, warnings);

  return { service, layersPresent, enums, valueObjects, entities, services, errors, events, subscriptions, pagination, api, security, httpClients, warnings };
}

function buildService(manifest, stack) {
  const meta = manifest?.service ?? {};
  const name = meta.name ?? 'service';
  return {
    name,
    version: meta.version ?? '0.0.1',
    description: meta.description ?? '',
    domain: meta.domain ?? null,
    basePackage: basePackage(manifest, stack?.group),
    artifactId: kebabCase(name),
    projectName: `${kebabCase(name)}-spring`,
    applicationClass: `${pascalCase(name)}Application`,
    basePath: null // se rellena desde la capa api
  };
}

// ─── Enums ───────────────────────────────────────────────────────────────────

function collectEnums(domain, httpClients, warnings) {
  const enums = [];
  const byName = new Map();

  const add = (name, values, description, origin) => {
    const existing = byName.get(name);
    if (existing) {
      if (JSON.stringify(existing.values.map((v) => v.literal)) !== JSON.stringify(values)) {
        warnings.push(`Enum '${name}' (${origin}) colisiona con otro enum de valores distintos; revisa el diseño.`);
      }
      return existing;
    }
    const built = {
      name,
      description: description ?? null,
      values: values.map((literal) => ({ constant: screamingSnake(literal), literal }))
    };
    byName.set(name, built);
    enums.push(built);
    return built;
  };

  for (const [name, def] of Object.entries(domain.types ?? {})) {
    if (def?.values) add(name, def.values, def.description, 'types');
  }

  const addInline = (ownerName, fields) => {
    for (const [fieldName, field] of Object.entries(fields ?? {})) {
      if (field?.type === 'enum' && Array.isArray(field.values)) {
        const built = add(`${ownerName}${pascalCase(fieldName)}`, field.values, field.description, `${ownerName}.${fieldName}`);
        built.inlineOf = built.inlineOf ?? `${ownerName}.${fieldName}`;
      }
    }
  };

  for (const [name, def] of Object.entries(domain.types ?? {})) {
    if (def?.fields) addInline(name, def.fields);
  }
  for (const [name, def] of Object.entries(domain.entities ?? {})) {
    addInline(name, def.fields);
  }

  // Enums inline en requests/responses estructurados de http-clients: deben
  // existir como clase para que los records generados compilen.
  for (const client of Object.values(httpClients?.clients ?? {})) {
    for (const [callName, call] of Object.entries(client.calls ?? {})) {
      const requestOwner = `${pascalCase(callName)}Request`;
      for (const section of ['pathParams', 'queryParams', 'headers', 'body']) {
        addInline(requestOwner, call.request?.[section]);
      }
      addInline(`${pascalCase(callName)}Response`, call.response?.fields);
    }
  }

  return enums;
}

// Índice (owner, campo) → nombre del enum generado para campos enum inline.
function buildInlineEnumIndex(enums) {
  const index = new Map();
  for (const e of enums) {
    if (e.inlineOf) index.set(e.inlineOf, e.name);
  }
  return (ownerName, fieldName) => index.get(`${ownerName}.${fieldName}`) ?? `${ownerName}${pascalCase(fieldName)}`;
}

// ─── Campos ──────────────────────────────────────────────────────────────────

// Resuelve un campo del diseño al contexto que necesitan los renders:
// tipo Java, imports, anotaciones de validación y de columna, e inicialización.
function resolveField(ownerName, fieldName, field, domainTypes, inlineEnumName, { persisted }) {
  let resolved;
  if (field.type === 'enum') {
    resolved = { kind: 'enum', javaType: inlineEnumName(ownerName, fieldName), imports: [], constraints: {} };
  } else {
    resolved = resolveType(field.type, domainTypes);
  }

  return {
    name: fieldName,
    javaType: resolved.javaType,
    imports: [...resolved.imports],
    kind: resolved.kind,
    base: resolved.base ?? null,
    isId: Boolean(field.id),
    required: Boolean(field.required),
    unique: Boolean(field.unique),
    generated: Boolean(field.generated),
    computed: field.computed ?? null,
    sensitive: Boolean(field.sensitive),
    // Nombre real en el cable cuando la fuente externa no usa el nombre del DSL.
    wireName: field.wireName && field.wireName !== fieldName ? field.wireName : null,
    description: field.description ?? null,
    validation: beanValidationAnnotations(field, resolved),
    columns: persisted ? columnAnnotations(fieldName, field, resolved) : [],
    initializer: fieldInitializer(field, resolved)
  };
}

function fieldInitializer(field, resolved) {
  if (field.default !== undefined) {
    if (resolved.kind === 'enum' || field.type === 'enum') return `${resolved.javaType}.${screamingSnake(field.default)}`;
    if (resolved.javaType === 'String') return JSON.stringify(String(field.default));
    if (resolved.javaType === 'BigDecimal') return `new BigDecimal("${field.default}")`;
    return String(field.default);
  }
  if (field.generated) {
    if (resolved.base === 'uuid') return 'UUID.randomUUID()';
    if (resolved.base === 'timestamp') return 'Instant.now()';
  }
  return null;
}

// ─── Value objects compuestos ────────────────────────────────────────────────

function collectValueObjects(types, domainTypes, inlineEnumName, hasPersistence) {
  const valueObjects = [];
  for (const [name, def] of Object.entries(types ?? {})) {
    if (!def?.fields) continue;
    valueObjects.push({
      name,
      description: def.description ?? null,
      fields: Object.entries(def.fields).map(([fieldName, field]) =>
        resolveField(name, fieldName, field, domainTypes, inlineEnumName, { persisted: false })
      ),
      embeddable: hasPersistence
    });
  }
  return valueObjects;
}

// ─── Entidades ───────────────────────────────────────────────────────────────

function collectEntities(domain, persistence, domainTypes, inlineEnumName, hasPersistence, warnings) {
  const aggregates = domain.aggregates ?? {};
  const internalOf = new Map();
  for (const [aggName, agg] of Object.entries(aggregates)) {
    for (const inner of agg.entities ?? []) internalOf.set(inner, { aggregate: aggName, root: agg.root });
  }

  const entities = [];
  for (const [name, def] of Object.entries(domain.entities ?? {})) {
    const persisted = hasPersistence && (persistence?.entities?.[name]?.persisted ?? true);
    const persistenceMeta = persistence?.entities?.[name] ?? {};
    const fields = Object.entries(def.fields ?? {}).map(([fieldName, field]) =>
      resolveField(name, fieldName, field, domainTypes, inlineEnumName, { persisted })
    );

    const relations = [];
    for (const [relName, rel] of Object.entries(def.relations ?? {})) {
      const targetInternal = internalOf.get(rel.entity);
      const sameAggregate =
        (targetInternal && (targetInternal.root === name || internalOf.get(name)?.aggregate === targetInternal.aggregate)) ||
        internalOf.get(name)?.root === rel.entity;
      if (sameAggregate || !hasPersistence) {
        relations.push({ name: relName, entity: rel.entity, cardinality: rel.cardinality, required: Boolean(rel.required), internal: true });
      } else if (rel.cardinality === 'many-to-one' || rel.cardinality === 'one-to-one') {
        relations.push({ name: relName, entity: rel.entity, cardinality: rel.cardinality, required: Boolean(rel.required), internal: false });
      } else {
        warnings.push(
          `Relación ${name}.${relName} (${rel.cardinality} hacia ${rel.entity}, otro agregado): no se genera campo; el agente debe modelarla.`
        );
      }
    }

    const lifecycle = def.lifecycle
      ? {
          field: def.lifecycle.field,
          enumType: fields.find((f) => f.name === def.lifecycle.field)?.javaType ?? inlineEnumName(name, def.lifecycle.field),
          transitions: Object.entries(def.lifecycle.transitions).map(([from, to]) => ({
            from: screamingSnake(from),
            to: to.map((state) => screamingSnake(state))
          }))
        }
      : null;

    entities.push({
      name,
      description: def.description ?? null,
      tableName: snakeCase(pluralize(name)),
      persisted,
      fields,
      idField: fields.find((f) => f.isId) ?? null,
      relations,
      lifecycle,
      invariants: def.invariants ?? [],
      isAggregateRoot: !internalOf.has(name),
      internalOf: internalOf.get(name)?.aggregate ?? null,
      naturalKey: persistenceMeta.naturalKey ?? null,
      indexes: persistenceMeta.indexes ?? []
    });
  }
  return entities;
}

// ─── Operaciones, servicios, controllers y errores ───────────────────────────

function collectOperations(layers, domainTypes, inlineEnumName, service, warnings) {
  const operations = layers['use-cases']?.operations ?? {};
  const api = layers.api ?? null;
  const domainEntities = layers.domain?.entities ?? {};
  const errorsByCode = new Map();
  const groups = new Map();

  for (const [opName, op] of Object.entries(operations)) {
    const targetEntity =
      payloadEntity(op.output) ?? payloadEntity(op.input) ?? entityFromOperationName(opName, domainEntities);
    const groupName = targetEntity ?? pascalCase(service.name);
    const route = resolveRoute(opName, op, api, targetEntity, warnings);

    const inputFields = payloadFields(opName, op.input, { direction: 'input', domainEntities, domainTypes, inlineEnumName, warnings });
    const hasIdParam = Boolean(route && route.path.includes('{id}'));
    const bodyFields = hasIdParam ? inputFields.filter((f) => f.name !== 'id') : inputFields;
    const outputFields = payloadFields(opName, op.output, { direction: 'output', domainEntities, domainTypes, inlineEnumName, warnings });

    for (const error of op.errors ?? []) {
      if (!errorsByCode.has(error.code)) {
        const http = error.http ?? 400;
        errorsByCode.set(error.code, {
          code: error.code,
          // Naming del prototipo de referencia: <PascalCode>Error.
          exceptionClass: `${pascalCase(error.code.toLowerCase())}Error`,
          http,
          sharedException: sharedExceptionFor(http),
          when: error.when ?? null
        });
      }
    }

    // Mensaje CQRS de la operación (patrón mediator): las queries con respuesta
    // son Query<R>; los commands con respuesta ReturningCommand<R>; el resto Command.
    const hasResponse = outputFields.length > 0;
    const kind = op.kind ?? 'command';
    const messageKind = kind === 'query' && hasResponse ? 'query' : hasResponse ? 'returningCommand' : 'command';
    const messageClass = `${pascalCase(opName)}${messageKind === 'query' ? 'Query' : 'Command'}`;

    const operation = {
      name: opName,
      description: op.description ?? '',
      kind,
      messageKind,
      messageClass,
      handlerClass: `${messageClass}Handler`,
      internal: Boolean(op.internal),
      route,
      hasIdParam,
      // Sin XxxRequest (estilo prototipo): el Command es el body HTTP y sus
      // componentes llevan la Bean Validation del diseño.
      bodyFields,
      responseDto:
        outputFields.length > 0
          ? { name: `${pascalCase(opName)}ResponseDto`, fields: outputFields, entity: payloadEntity(op.output) }
          : null,
      returnsList: Boolean(typeof op.output === 'object' && op.output?.list),
      paginated: Boolean(typeof op.output === 'object' && op.output?.paginated),
      preconditions: op.preconditions ?? [],
      rules: op.rules ?? [],
      errors: (op.errors ?? []).map((e) => e.code),
      emits: op.emits ?? [],
      idempotency: op.idempotency ?? null,
      cache: op.cache ?? null,
      schedule: op.schedule ?? null
    };

    if (!groups.has(groupName)) {
      groups.set(groupName, {
        entity: targetEntity,
        className: `${groupName}Service`,
        controllerClass: `${groupName}V1Controller`,
        // Subpaquete versionado del controller (estilo prototipo).
        controllerPackage: `infrastructure.rest.controllers.${groupName.toLowerCase()}.v1`,
        operations: []
      });
    }
    groups.get(groupName).operations.push(operation);
  }

  return { services: [...groups.values()], errors: [...errorsByCode.values()] };
}

// ─── Eventos de dominio (messaging.publishing.events) ────────────────────────

function collectEvents(layers, domainTypes, inlineEnumName, warnings) {
  const events = layers.messaging?.publishing?.events ?? {};
  const domainEntities = layers.domain?.entities ?? {};
  return Object.entries(events).map(([name, def]) => ({
    name,
    className: `${pascalCase(name)}Event`,
    publisherClass: `${pascalCase(name)}Publisher`,
    description: def?.description ?? null,
    fields: payloadFields(name, def?.payload, { direction: 'output', domainEntities, domainTypes, inlineEnumName, warnings })
  }));
}

// ─── Seguridad (security.access → matchers del SecurityFilterChain) ──────────

// Traduce una regla de acceso del diseño a la llamada terminal de autorización
// de Spring (permitAll / authenticated / hasAnyRole / hasAnyAuthority). Los
// nombres de rol se pasan verbatim (hasRole antepone ROLE_, que es lo que emite
// el JwtAuthConverter); los permisos recurso:accion van como authority sin
// prefijo. Con roles y permisos a la vez se combinan en un único hasAnyAuthority
// (roles prefijados ROLE_), semántica "cualquiera de".
export function accessAuthority(rule) {
  if (rule.level === 'public') return 'permitAll()';
  const roles = rule.roles ?? [];
  const perms = rule.permissions ?? [];
  // Los scopes del diseño llegan como authorities SCOPE_<scope> (prefijo estándar
  // del resource server de Spring para el claim scope).
  const scopes = (rule.scopes ?? []).map((s) => `SCOPE_${s}`);
  const quote = (v) => JSON.stringify(v);
  const mixed = [...roles.map((r) => `ROLE_${r}`), ...perms, ...scopes];
  if ((roles.length > 0 ? 1 : 0) + (perms.length > 0 ? 1 : 0) + (scopes.length > 0 ? 1 : 0) > 1) {
    return `hasAnyAuthority(${mixed.map(quote).join(', ')})`;
  }
  if (scopes.length > 0) return `hasAnyAuthority(${scopes.map(quote).join(', ')})`;
  if (perms.length > 0) return `hasAnyAuthority(${perms.map(quote).join(', ')})`;
  if (roles.length > 0) return `hasAnyRole(${roles.map(quote).join(', ')})`;
  if (rule.level === 'admin') return 'hasRole("admin")';
  return 'authenticated()';
}

function collectSecurity(layers, services, routeBase, warnings) {
  const sec = layers.security;
  if (!sec) return null;

  const protocol = sec.authentication?.protocol ?? 'none';
  const defaultRule = sec.access?.default ?? { level: 'required' };
  const rules = sec.access?.rules ?? {};

  // Índice operación → ruta (solo las expuestas por REST), fuente única con los
  // controllers para que los matchers no se desincronicen de los endpoints.
  const routeByOp = new Map();
  for (const svc of services) {
    for (const op of svc.operations) {
      if (op.route) routeByOp.set(op.name, op.route);
    }
  }

  const matchers = [];
  for (const [opName, rule] of Object.entries(rules)) {
    const route = routeByOp.get(opName);
    if (!route) {
      warnings.push(
        `Regla de acceso '${opName}' (security) no corresponde a ninguna operación con endpoint REST; se ignora en el SecurityFilterChain.`
      );
      continue;
    }
    matchers.push({ method: route.method, path: `${routeBase}${route.path}`, authority: accessAuthority(rule) });
  }

  const allRules = [defaultRule, ...Object.values(rules)];
  const usesAuthorities = allRules.some(
    (r) =>
      (r.roles?.length ?? 0) > 0 ||
      (r.permissions?.length ?? 0) > 0 ||
      (r.scopes?.length ?? 0) > 0 ||
      r.level === 'admin'
  );

  // Autenticación de clientes máquina (endpoints audience services/both).
  const rawServiceAuth = sec.authentication?.serviceAuth ?? null;
  const serviceAuth = rawServiceAuth
    ? {
        protocol: rawServiceAuth.protocol,
        validateAudience: rawServiceAuth.validateAudience === true,
        audience: rawServiceAuth.audience ?? null // null → el scaffolding usa el nombre del servicio
      }
    : null;
  const serviceClients = Object.entries(sec.serviceClients ?? {}).map(([name, def]) => ({
    name,
    description: def?.description ?? null,
    scopes: def?.scopes ?? []
  }));

  return {
    protocol,
    matchers,
    defaultAuthority: accessAuthority(defaultRule),
    usesAuthorities,
    serviceAuth,
    serviceClients
  };
}

// ─── HTTP clients salientes (http-clients → puerto + adaptador RestClient) ───

// Fallback legacy para llamadas solo-prosa: si el contract empieza por
// "MÉTODO /ruta" se parsean método, ruta y path vars para armar el esqueleto;
// con method/path estructurados en el diseño este parseo no se usa.
function parseContract(contract) {
  const match = /^\s*([A-Z]+)\s+(\S+)/.exec(contract ?? '');
  if (!match) return { method: null, path: null, pathVars: [] };
  const pathVars = [...match[2].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return { method: match[1], path: match[2], pathVars };
}

function collectHttpClients(layers, domainTypes, inlineEnumName, warnings) {
  const clients = layers['http-clients']?.clients;
  if (!clients) return null;

  const result = [];
  for (const [clientId, def] of Object.entries(clients)) {
    const base = pascalCase(clientId);
    const calls = Object.entries(def.calls ?? {}).map(([callName, call]) => {
      // Método/ruta: preferir los campos estructurados del diseño; la prosa del
      // contract queda como fallback legacy.
      const parsed = parseContract(call.contract);
      const method = call.method ?? parsed.method;
      const path = call.path ?? parsed.path;
      const pathVars = call.path ? [...call.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]) : parsed.pathVars;
      if (!method) {
        warnings.push(
          `Llamada '${clientId}.${callName}' (http-clients): sin method/path estructurados y el contract '${call.contract}' no empieza por 'MÉTODO /ruta'; el agente debe completar el método/ruta.`
        );
      }

      const callPascal = pascalCase(callName);
      const requestOwner = `${callPascal}Request`;
      const resolveMap = (owner, fieldMap) =>
        Object.entries(fieldMap ?? {}).map(([fieldName, field]) =>
          resolveField(owner, fieldName, field, domainTypes, inlineEnumName, { persisted: false })
        );

      // Path params en el orden de aparición en la ruta; tipados si el diseño
      // los declara, String legacy si no.
      const declaredPathParams = call.request?.pathParams ?? null;
      const pathParams = pathVars.map((v) =>
        declaredPathParams?.[v]
          ? resolveField(requestOwner, v, declaredPathParams[v], domainTypes, inlineEnumName, { persisted: false })
          : { name: v, javaType: 'String', imports: [], kind: 'base' }
      );
      const queryParams = resolveMap(requestOwner, call.request?.queryParams);
      const headerParams = resolveMap(requestOwner, call.request?.headers);
      const bodyFields = resolveMap(requestOwner, call.request?.body);
      const responseFields = resolveMap(`${callPascal}Response`, call.response?.fields);

      const typed = Boolean(call.request || call.response);
      const hasBody = bodyFields.length > 0 || (!call.request && (method === 'POST' || method === 'PUT' || method === 'PATCH'));
      return {
        name: callName,
        method,
        path,
        pathVars,
        hasBody,
        typed,
        requestType: bodyFields.length > 0 ? requestOwner : null,
        responseType: `${callPascal}Response`,
        resultType: `${callPascal}Result`,
        pathParams,
        queryParams,
        headerParams,
        bodyFields,
        responseFields,
        contract: call.contract ?? '',
        timeoutMs: call.timeoutMs ?? null,
        retry: call.retry ?? null,
        circuitBreaker: call.circuitBreaker ?? null,
        fallback: call.fallback ?? null,
        instanceName: `${clientId}-${kebabCase(callName)}`,
        fallbackMethod: `${callName}Fallback`
      };
    });

    // Autenticación saliente declarada en el diseño (las credenciales llegan
    // por configuración; aquí solo el mecanismo y los nombres de propiedad).
    const rawAuth = def.auth ?? null;
    const auth =
      rawAuth && rawAuth.type !== 'none'
        ? {
            type: rawAuth.type,
            headerName: rawAuth.headerName ?? 'X-Api-Key',
            tokenUrl: rawAuth.tokenUrl ?? null,
            scopes: rawAuth.scopes ?? [],
            propertyPrefix: `http-clients.${clientId}.auth`,
            registrationId: clientId
          }
        : null;

    const timeouts = calls.map((c) => c.timeoutMs).filter((t) => typeof t === 'number');
    result.push({
      id: clientId,
      purpose: def.purpose ?? '',
      clientClass: `${base}Client`,
      adapterClass: `${base}HttpAdapter`,
      mapperClass: `${base}Mapper`,
      configClass: `${base}ClientConfig`,
      beanName: `${camelCase(clientId)}RestClient`,
      baseUrlProperty: `http-clients.${clientId}.base-url`,
      envPrefix: clientId.toUpperCase().replace(/-/g, '_'),
      auth,
      readTimeoutMs: timeouts.length > 0 ? Math.max(...timeouts) : 5000,
      calls
    });
  }
  return result;
}

// ─── Suscripciones de mensajería (messaging.subscriptions → consumers) ───────

function collectSubscriptions(layers, services, domainTypes, inlineEnumName, warnings) {
  const subs = layers.messaging?.subscriptions ?? {};
  const domainEntities = layers.domain?.entities ?? {};

  // Lookup operación → operación CQRS (para citar el destino del dispatch y sus componentes).
  const opByName = new Map();
  for (const svc of services) {
    for (const op of svc.operations) opByName.set(op.name, op);
  }

  return Object.entries(subs).map(([name, def]) => {
    const trigger = def.triggers ?? null;
    if (trigger && !opByName.has(trigger)) {
      warnings.push(`Suscripción '${name}': triggers '${trigger}' no corresponde a ninguna operación de use-cases.`);
    }
    const triggerOp = trigger ? opByName.get(trigger) ?? null : null;
    const contract = def.contract ?? {};
    const external = def.channel ? layers.messaging?.channels?.[def.channel]?.external === true : false;
    const fields = payloadFields(name, { fields: def.payload }, {
      direction: 'output',
      domainEntities,
      domainTypes,
      inlineEnumName,
      warnings
    });

    return {
      name,
      source: def.source ?? null,
      channel: def.channel ?? null,
      externalChannel: external,
      trigger,
      triggerMessageClass: triggerOp?.messageClass ?? null,
      // Cómo se construye el mensaje CQRS desde el payload: componente del
      // command → campo del payload que lo alimenta (null = el agente decide).
      triggerArguments: triggerArguments(def, triggerOp, fields),
      messageRecord: `${pascalCase(name)}Message`,
      listenerClass: `${pascalCase(name)}Listener`,
      topicProperty: `messaging.subscriptions.${kebabCase(name)}.topic`,
      topicDefault: `${def.source ? kebabCase(def.source) : kebabCase(name)}.events`,
      // Contrato de recepción: sin él se asume la envoltura de Keel salvo que el
      // canal sea ajeno, donde el mensaje llega plano.
      envelope: contract.envelope ?? (external ? 'none' : 'keel'),
      payloadPath: contract.payloadPath ?? null,
      format: contract.format ?? 'json',
      schemaRef: contract.schemaRef ?? null,
      discriminator: contract.discriminator ?? null,
      messageId: contract.messageId ?? null,
      unknownFields: contract.unknownFields ?? 'ignore',
      envelopeRecord: contract.envelope === 'wrapped' ? `${pascalCase(name)}Envelope` : null,
      fields,
      retry: def.onFailure?.retry ?? null,
      deadLetter: Boolean(def.onFailure?.deadLetter)
    };
  });
}

// Mapeo declarado (input) o identidad por nombre, sobre los componentes del
// command/query que dispara la suscripción.
function triggerArguments(def, triggerOp, fields) {
  if (!triggerOp) return [];
  const mapping = def.input ?? {};
  const payloadNames = new Set(fields.map((f) => f.name));
  const components = triggerOp.hasIdParam ? ['id', ...triggerOp.bodyFields.map((f) => f.name)] : triggerOp.bodyFields.map((f) => f.name);
  return components.map((component) => {
    const source = mapping[component] ?? (payloadNames.has(component) ? component : null);
    return { component, source };
  });
}

function payloadEntity(payload) {
  return typeof payload === 'object' && payload?.entity ? payload.entity : null;
}

// Operaciones sin entidad en el payload (ej. retireProduct con input { id } y
// output void): se agrupan por la entidad cuyo nombre cierra el de la operación.
function entityFromOperationName(opName, domainEntities) {
  const pascal = pascalCase(opName);
  for (const entityName of Object.keys(domainEntities)) {
    if (pascal.endsWith(entityName) || pascal.endsWith(pluralize(entityName))) return entityName;
  }
  return null;
}

// Deriva los campos de un payload: explícitos (fields) o desde la entidad,
// aplicando las exclusiones de mapping.md según la dirección.
function payloadFields(opName, payload, { direction, domainEntities, domainTypes, inlineEnumName, warnings = [] }) {
  if (!payload || payload === 'void') return [];

  if (payload.fields) {
    return Object.entries(payload.fields).map(([fieldName, field]) =>
      resolveField(pascalCase(opName), fieldName, field, domainTypes, inlineEnumName, { persisted: false })
    );
  }

  const entity = domainEntities[payload.entity];
  if (!entity) return [];

  // exclude admite dot-paths hacia una entidad hija o un value object. El scaffolding solo
  // puede aplicar los planos: su DTO es un record plano de los campos de la entidad (las
  // relaciones no entran, y un value object entra como su record completo). Los anidados se
  // avisan para que el agente los recorte al escribir el DTO — nunca se ignoran en silencio.
  // La ruta ya viene validada por `keel validate` (crossrefs), aquí no se revalida.
  const excludePaths = payload.exclude ?? [];
  const exclude = new Set(excludePaths.filter((path) => !path.includes('.')));
  for (const path of excludePaths) {
    if (path.includes('.')) warnings.push(nestedExcludeWarning(opName, payload.entity, path, entity, domainTypes));
  }

  const fields = [];
  for (const [fieldName, field] of Object.entries(entity.fields ?? {})) {
    if (exclude.has(fieldName)) continue;
    if (direction === 'input' && (field.id || field.generated || field.computed)) continue;
    if (direction === 'output' && field.sensitive) continue;
    fields.push(resolveField(payload.entity, fieldName, field, domainTypes, inlineEnumName, { persisted: false }));
  }
  return fields;
}

// Mensaje del dot-path de exclude que el scaffolding no puede aplicar sobre su DTO plano:
// dice qué falta y quién lo completa, para que el hueco sea visible en la salida de build.
function nestedExcludeWarning(opName, entityName, path, entity, domainTypes) {
  const [head, ...rest] = path.split('.');
  const nested = rest.join('.');
  const prefix = `Operación '${opName}': exclude '${path}' de ${entityName}`;

  if (entity.relations?.[head]) {
    return `${prefix}: build no genera el DTO anidado de la relación '${head}' — el agente debe escribirlo sin '${nested}' (conventions/mapping.md).`;
  }
  const type = entity.fields?.[head]?.type;
  if (type && domainTypes?.[type]?.fields) {
    return `${prefix}: el value object '${type}' sale entero en el DTO — el agente debe recortar '${nested}' al escribir el DTO de respuesta (conventions/mapping.md).`;
  }
  return `${prefix}: build no puede aplicarlo a su DTO plano — revísalo al escribir el DTO de respuesta (conventions/mapping.md).`;
}

// Ruta de una operación: endpoint explícito > convención CRUD (auto) > fallback POST.
function resolveRoute(opName, op, api, targetEntity, warnings) {
  if (op.internal || op.schedule || !api) return null;

  const explicit = api.endpoints?.[opName];
  if (explicit) {
    return { method: explicit.method, path: explicit.path, status: explicit.successStatus ?? defaultStatus(explicit.method) };
  }
  if (!api.auto) return null;

  const prefix = CRUD_PREFIXES.find((p) => opName.startsWith(p) && opName.length > p.length);
  if (prefix) {
    const rest = opName.slice(prefix.length);
    const collection = `/${kebabCase(prefix === 'list' ? rest : pluralize(rest))}`;
    switch (prefix) {
      case 'create':
        return { method: 'POST', path: collection, status: 201 };
      case 'list':
        return { method: 'GET', path: collection, status: 200 };
      case 'get':
        return { method: 'GET', path: `${collection}/{id}`, status: 200 };
      case 'update':
        return { method: 'PUT', path: `${collection}/{id}`, status: 200 };
      case 'delete':
        return { method: 'DELETE', path: `${collection}/{id}`, status: 204 };
    }
  }

  warnings.push(`Operación '${opName}' sin endpoint explícito ni patrón CRUD: se expone como POST /${kebabCase(opName)} (revísala).`);
  return { method: 'POST', path: `/${kebabCase(opName)}`, status: 200, fallback: true };
}

function defaultStatus(method) {
  if (method === 'POST') return 201;
  if (method === 'DELETE') return 204;
  return 200;
}
