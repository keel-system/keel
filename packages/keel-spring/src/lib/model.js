// Construye el modelo intermedio del scaffolding: un contexto plano derivado
// mecánicamente del diseño (manifest + capas parseadas). Los generadores de
// src/scaffold/ solo renderizan este modelo; aquí vive toda la interpretación
// del DSL (ver conventions/mapping.md).

import {
  pascalCase,
  camelCase,
  kebabCase,
  snakeCase,
  screamingSnake,
  pluralize,
  basePackage,
  brokerSafeName
} from './naming.js';
import { resolveType, beanValidationAnnotations, columnAnnotations } from './type-mapper.js';
import { DATABASES } from './stack-catalog.js';

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
  413: 'PayloadTooLargeException',
  422: 'BusinessException'
};

export function sharedExceptionFor(http) {
  return SHARED_EXCEPTION_BY_HTTP[http] ?? 'DomainException';
}

// Base de rutas del servicio: el basePath del diseño (o /api/<servicio>) más la
// versión. Si el diseño ya versiona el basePath (/api/v1, /api/v2) se respeta
// tal cual: volver a añadir /v1 produciría /api/v1/v1 en los @RequestMapping y
// en los matchers de seguridad a la vez.
export function versionedRouteBase(basePath, serviceName) {
  const base = basePath ?? `/api/${kebabCase(serviceName)}`;
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

export function buildModel({ manifest, layers, stack = null }) {
  const warnings = [];
  const domain = layers.domain ?? { entities: {} };
  const domainTypes = domain.types ?? {};
  const persistence = layers.persistence ?? null;
  const hasPersistence = Boolean(persistence);
  // Modelo de persistencia que gobierna el scaffolding. Se lee del catálogo y no
  // del diseño para que haya UNA fuente: el motor elegido y el modelo declarado no
  // pueden discrepar, porque el cuestionario solo ofrece motores del modelo que el
  // diseño declara. Sin persistencia da igual el valor: nadie lo consulta.
  const persistenceKind = DATABASES[stack?.database]?.kind ?? 'relational';

  const service = buildService(manifest, stack);
  service.basePath = layers.api?.basePath ?? null;
  const layersPresent = {
    api: Boolean(layers.api),
    persistence: hasPersistence,
    messaging: Boolean(layers.messaging),
    security: Boolean(layers.security),
    httpClients: Boolean(layers['http-clients']),
    dependencies: Boolean(layers.dependencies),
    storage: Boolean(layers.storage),
    mail: Boolean(layers.mail)
  };

  const enums = collectEnums(domain, layers['http-clients'], warnings);
  const inlineEnumName = buildInlineEnumIndex(enums);
  const valueObjects = collectValueObjects(domainTypes, domainTypes, inlineEnumName, hasPersistence);
  const entities = collectEntities(domain, persistence, domainTypes, inlineEnumName, hasPersistence, warnings);
  attachTransitionExecutors(entities, layers['use-cases']?.operations ?? {});

  // Un VO usado en un campo colección (list) de una entidad persistida necesita
  // su espejo @Embeddable (XxxJpa): @ElementCollection<List<XxxJpa>>. Se marca
  // aquí, cuando ya conocemos entidades y VOs, y lo consumen embeddables.js y la Jpa.
  if (hasPersistence) {
    const collectionVoNames = new Set();
    for (const entity of entities) {
      if (!entity.persisted) continue;
      for (const field of entity.fields) {
        if (field.list && field.kind === 'composite') collectionVoNames.add(field.elementJavaType);
      }
    }
    for (const vo of valueObjects) vo.usedInCollection = collectionVoNames.has(vo.name);
  }
  const { services, errors } = collectOperations(layers, domainTypes, inlineEnumName, service, warnings, persistenceKind);
  // DTOs de las entidades hijas proyectadas en algún payload de salida.
  const childDtos = collectChildDtos(layers, services, domainTypes, inlineEnumName, warnings);
  // DTOs de referencia de las relaciones que el diseño marca con embed.
  const refDtos = collectRefDtos(layers, services, domainTypes, inlineEnumName, childDtos, warnings);
  const events = collectEvents(layers, services, service, domainTypes, inlineEnumName, warnings, stack);
  // Garantía de entrega declarada en el diseño: decide cómo se materializa la
  // publicación (outbox transaccional vs. envío directo tras commit).
  const channels = layers.messaging ? collectChannels(layers, service, stack) : null;
  const messaging = layers.messaging
    ? {
        reliability: layers.messaging.publishing?.reliability ?? 'best-effort',
        // Destinos a purgar entre flujos, y el subconjunto que publica el servicio.
        channels: channels.all,
        publishChannels: channels.publish,
        // Topología FÍSICA de la publicación: un solo destino por servicio con una
        // routing key por evento (mapping.md § messaging). El canal del diseño es
        // una agrupación lógica, NO el nombre del topic: quien sondee el broker
        // tiene que leer `destination` y discriminar por evento.
        destinationDefault: channels.destinationDefault,
        destinationEnv: 'MESSAGING_DESTINATION',
        eventTypesByChannel: channels.eventTypesByChannel
      }
    : null;
  classifyClaims(services, entities, layers, warnings);
  classifyGuardClaims(services, entities, layers);
  const subscriptions = collectSubscriptions(layers, services, domainTypes, inlineEnumName, warnings, stack);
  const pagination = layers.api?.pagination ?? null;

  // Base de rutas versionada (estilo del prototipo de referencia): el basePath
  // del diseño (o /api/<servicio>) + /v1, puesta en el @RequestMapping de cada
  // controller (no en server.servlet.context-path).
  const api = { routeBase: versionedRouteBase(layers.api?.basePath, service.name) };

  // Política de auditoría del diseño. La consumen persistence-entities (qué lleva
  // AuditableEntity) y auditing (si hace falta el AuditorAware que puebla la autoría).
  const audit = auditPolicies(persistence);

  const security = collectSecurity(layers, services, api.routeBase, warnings);
  // Qué se emula en local con Cognito, dicho ANTES de que nadie lea una matriz en
  // verde. No va en supported-features.js porque aquello corre antes de conocer el
  // stack: allí solo se sabe qué declara el diseño, y esto depende del proveedor
  // elegido en el cuestionario.
  if (stack?.auth === 'cognito' && (security?.protocol === 'oidc' || security?.protocol === 'jwt')) {
    warnings.push(
      'stack auth: cognito — en local se emula el CONTRATO del token (un servidor OAuth2 que emite la forma de Cognito: cognito:groups, scopes prefijados por el resource server y tokens de máquina SIN aud), no Amazon Cognito. Eso permite ejercitar el diseño entero, superficie M2M incluida, que ningún emulador libre de la API de Cognito cubre. Lo que NO queda probado ahí: que el proveedor autentique de verdad (el emulador no valida contraseñas) y el alta de user pool, grupos y usuarios. Las dos se verifican contra Cognito real siguiendo la skill keel-spring-cognito.'
    );
  }
  const httpClients = collectHttpClients(layers, domainTypes, inlineEnumName, warnings);
  const storage = collectStorage(layers);
  const mail = collectMail(layers);

  const hasFileUploads = services.some((group) => group.operations.some((operation) => operation.multipart));

  // Dependencias con otros servidores. Va al final: sintetiza entidades, clientes
  // y suscripciones ya resueltos, y les cuelga los retro-enlaces que consumen los scaffolds.
  const dependencies = collectDependencies(
    layers,
    entities,
    httpClients,
    subscriptions,
    errors,
    events,
    services,
    warnings
  );

  // Los `need` que el diseño expone (`exposedAs`) pasan a ser un campo más de la
  // respuesta de cada operación que los usa. Va después de collectDependencies porque
  // es quien resuelve la forma del dato, y después de los refDtos porque es el mismo
  // tipo de campo: uno que NO se deriva de la entidad y que por eso tiene que entrar
  // al mapper por parámetro (ver mappers.js).
  const needDtos = collectNeedDtos(layers, dependencies, services, domainTypes, inlineEnumName, warnings);

  return { service, layersPresent, persistenceKind, enums, valueObjects, entities, services, errors, childDtos, refDtos, needDtos, hasFileUploads, events, messaging, subscriptions, pagination, api, audit, security, httpClients, dependencies, storage, mail, warnings };
}

// El DTO de un dato ajeno expuesto, y su campo en la respuesta.
//
// La forma sale de donde ya está declarada —`response.fields` de la llamada con
// on-demand, la entidad réplica con replicated—, nunca de `dependencies`: declararla
// dos veces es invitar a que diverjan, y la que manda es la del proveedor.
//
// El campo es SIEMPRE opcional en el contrato. La llamada puede declarar `fallback` y
// la réplica `onMiss: degrade`: el propio diseño ya dice que el dato puede faltar, así
// que presentarlo como obligatorio prometería lo que él mismo desmiente.
function collectNeedDtos(layers, dependencies, services, domainTypes, inlineEnumName, warnings) {
  if (!dependencies) return [];
  const domainEntities = layers.domain?.entities ?? {};
  const built = [];
  const seen = new Map(); // dtoName → fields ya resueltos
  const opByName = new Map();
  for (const group of services ?? []) {
    for (const operation of group.operations) opByName.set(operation.name, operation);
  }

  // El campo se inyecta AQUÍ y no en payloadFields porque no sale de la entidad: sale
  // de la capa dependencies, que se resuelve al final. Y se inyecta solo si el DTO se
  // llegó a construir — un campo cuyo tipo no existe no compila.
  const expose = (need, fields) => {
    for (const opName of need.usedBy) {
      const operation = opByName.get(opName);
      if (!operation?.responseDto) continue;
      if (operation.responseDto.fields.some((field) => field.name === need.exposedAs)) continue;
      operation.responseDto.fields.push({
        name: need.exposedAs,
        javaType: need.dtoName,
        imports: [],
        kind: 'needDto',
        need: need.name,
        needFields: fields
      });
    }
  };

  for (const dependency of dependencies) {
    for (const need of dependency.needs ?? []) {
      if (!need.exposedAs) continue;
      if (seen.has(need.dtoName)) {
        expose(need, seen.get(need.dtoName));
        continue;
      }

      let fields = [];
      if (need.strategy === 'replicated' && need.replica?.entity) {
        // La copia local ya es una entidad de dominio: se proyecta como cualquier otra.
        if (!domainEntities[need.replica.entity]) continue;
        fields = payloadFields(need.replica.entity, { entity: need.replica.entity }, {
          direction: 'output',
          domainEntities,
          domainTypes,
          inlineEnumName,
          relations: null,
          warnings
        });
      } else {
        fields = need.fetch?.responseFields ?? [];
      }

      // Un DTO sin campos no se puede renderizar (un record vacío no tiene sentido) y
      // además significa que el contrato del que sale no está tipado: el agente tiene
      // que completarlo antes, y avisarlo aquí es más barato que un error de compilación.
      if (fields.length === 0) {
        warnings.push(
          `Necesidad '${dependency.id}.${need.name}' (dependencies): declara exposedAs pero su origen no tiene campos tipados; el agente tiene que completar el contrato antes de poder exponerlo.`
        );
        continue;
      }
      seen.set(need.dtoName, fields);
      built.push({ name: need.dtoName, fields });
      expose(need, fields);
    }
  }
  return built;
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
    className: pascalCase(name),
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

  // Campo colección (DSL 2.1 list): el tipo del elemento se envuelve en List<>.
  // Todo render interpola javaType, así que basta con envolverlo aquí.
  const isList = Boolean(field.list);
  const javaType = isList ? `List<${resolved.javaType}>` : resolved.javaType;
  const imports = [...resolved.imports];
  if (isList) imports.push('java.util.List');

  return {
    name: fieldName,
    javaType,
    imports,
    list: isList,
    elementJavaType: resolved.javaType,
    kind: resolved.kind,
    base: resolved.base ?? null,
    // El nombre del tipo TAL COMO lo escribe el diseño (`SKU`, `Email`), que
    // `resolved` ya no conserva porque lo ha aplanado a su primitivo. Solo lo usa
    // la nota del command cuando build deja fuera el formato heredado del tipo:
    // sin el nombre, la nota no dice a qué declaración ir a mirar.
    typeName: typeof field.type === 'string' ? field.type : null,
    // Bucket lógico de un campo `file`. Sin él, aguas abajo nadie puede decidir
    // por visibilidad: el DTO de salida de un bucket público expone la URL y el
    // de uno privado la key, y esa decisión se toma en el mapper.
    bucket: field.bucket ?? null,
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
    // La misma lista para un DTO de entrada: sin el formato heredado del value
    // type, que solo se cumple después de normalizar, y sin la anotación de
    // presencia de un campo con `default`, que por definición el cliente puede
    // omitir (ver type-mapper.js). Las dos diferencias son del lado de ENTRADA:
    // `validation` describe el valor ya formado y aquí se describe lo que llega
    // por el cable, que es antes de que el dominio ponga nada.
    inputValidation: beanValidationAnnotations(field, resolved, { inheritTypeFormat: false, honourDefault: true }),
    // Una colección no es una columna: su mapeo (@ElementCollection) lo pone la Jpa,
    // no columnAnnotations. Sin persistence o sin list, comportamiento previo.
    columns: persisted && !isList ? columnAnnotations(fieldName, field, resolved) : [],
    // Pero cada ELEMENTO de esa colección sí es una columna: vive en la tabla hija
    // que genera @CollectionTable, y ahí es donde tienen que aterrizar las
    // constraints de su value type. Sin esto, un `EmailAddress` con maxLength 254
    // sale `varchar(255)` dentro de la lista mientras el mismo tipo, usado suelto,
    // sale `varchar(254)`: la única cota que llega al DDL se pierde justo en la
    // tabla que crece. El elemento compuesto no entra aquí — su espejo @Embeddable
    // pone sus propias columnas (embeddables.js).
    //
    // El `field` va vacío a propósito: `required`, `id` y `unique` son de la LISTA,
    // no de sus elementos, y sus constraints son de cardinalidad (maxItems).
    elementColumns:
      persisted && isList && resolved.kind !== 'composite' ? columnAnnotations(fieldName, {}, resolved) : [],
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
      // `persisted` sigue al diseño y no es siempre false: un VO usado en una
      // colección se materializa como @Embeddable con columnas propias
      // (embeddables.js), y sin esto sus campos salen sin `length` ni `nullable`
      // —las constraints del value type no llegan al DDL de la tabla de elementos—.
      // Cuando el VO se aplana con prefijo en la entidad, quien manda es `subs[]`
      // de persistence-members.js y estas columnas no se consultan.
      fields: Object.entries(def.fields).map(([fieldName, field]) =>
        resolveField(name, fieldName, field, domainTypes, inlineEnumName, { persisted: hasPersistence })
      ),
      embeddable: hasPersistence
    });
  }
  return valueObjects;
}

// ─── Entidades ───────────────────────────────────────────────────────────────

// Índice entidad interna → su agregado y su raíz, derivado de domain.aggregates.
// Es lo que permite distinguir una entidad hija (parte del agregado, se mapea y
// se proyecta anidada) de una referencia a otro agregado (solo su id).
function aggregateIndex(domain) {
  const internalOf = new Map();
  for (const [aggName, agg] of Object.entries(domain.aggregates ?? {})) {
    for (const inner of agg.entities ?? []) internalOf.set(inner, { aggregate: aggName, root: agg.root });
  }
  return internalOf;
}

// Clasifica una relación del diseño desde la entidad que la declara:
// - internal: entidad hija del mismo agregado (con backReference si apunta a su padre)
// - external: otro agregado, representado por su id
// - unsupported: colección hacia otro agregado, que el scaffolding no modela
function classifyRelation(entityName, rel, internalOf, hasPersistence) {
  const targetInternal = internalOf.get(rel.entity);
  const sameAggregate =
    (targetInternal && (targetInternal.root === entityName || internalOf.get(entityName)?.aggregate === targetInternal.aggregate)) ||
    internalOf.get(entityName)?.root === rel.entity;

  if (sameAggregate || !hasPersistence) {
    // El padre de una entidad interna NO es necesariamente la raíz del agregado:
    // en Raíz → Hija → Nieta, la nieta apunta a la hija. Mirar solo a la raíz
    // dejaba la relación intermedia sin back-reference, y entonces el padre emite
    // un @OneToMany unidireccional con su propio @JoinColumn mientras el hijo
    // conserva el suyo — DOS columnas de FK físicas para una sola relación, cada
    // una rellenada por un lado distinto del mapeo.
    const self = internalOf.get(entityName);
    const pointsAtOwnParent =
      Boolean(self) && (rel.entity === self.root || internalOf.get(rel.entity)?.aggregate === self.aggregate);
    const backReference =
      pointsAtOwnParent && (rel.cardinality === 'many-to-one' || rel.cardinality === 'one-to-one');
    return { kind: 'internal', backReference };
  }
  if (rel.cardinality === 'many-to-one' || rel.cardinality === 'one-to-one') return { kind: 'external', backReference: false };
  return { kind: 'unsupported', backReference: false };
}

// Política de concurrencia optimista (persistence.consistency.optimisticLocking).
// El default es 'all' — toda raíz de agregado protegida — porque perder una
// escritura en silencio es el fallo caro; 'none' es una decisión explícita del
// diseño ("último escritor gana") y 'declared' delega en el campo reservado
// lockVersion, entidad a entidad.
function locksEntity(policy, isAggregateRoot, declaresLockVersion) {
  if (!isAggregateRoot) return false;
  if (policy === 'none') return false;
  if (policy === 'declared') return declaresLockVersion;
  return true;
}

// Auditoría (persistence.audit), dos ejes independientes con el mismo enum que el
// bloqueo optimista. Los defectos son los del schema: registrar CUÁNDO cambió una
// fila es sano por defecto ('all'); registrar QUIÉN exige capa security, así que
// se pide explícitamente ('none'). `keel validate` ya garantiza que los campos
// reservados solo aparezcan con 'declared', de modo que aquí no hay que arbitrar
// entre la política y lo que el dominio nombra.
const AUDIT_FIELDS = {
  timestamps: ['createdAt', 'updatedAt'],
  authorship: ['createdBy', 'updatedBy']
};

export function auditPolicies(persistence) {
  return {
    timestamps: persistence?.audit?.timestamps ?? 'all',
    authorship: persistence?.audit?.authorship ?? 'none'
  };
}

// Política EFECTIVA de un eje para una entidad concreta: 'all' la lleva por
// herencia de AuditableEntity (columna invisible al contrato), 'declared' solo si
// esta entidad nombra alguno de los campos reservados (y entonces el campo es del
// dominio, proyectable en un output).
function auditsEntity(policy, persisted, fieldNames, axis) {
  if (!persisted || policy === 'none') return 'none';
  if (policy === 'declared') return AUDIT_FIELDS[axis].some((name) => fieldNames.has(name)) ? 'declared' : 'none';
  return 'all';
}

function collectEntities(domain, persistence, domainTypes, inlineEnumName, hasPersistence, warnings) {
  const aggregates = domain.aggregates ?? {};
  const internalOf = aggregateIndex(domain);
  const lockingPolicy = persistence?.consistency?.optimisticLocking ?? 'all';
  const auditPolicy = auditPolicies(persistence);

  const entities = [];
  for (const [name, def] of Object.entries(domain.entities ?? {})) {
    const persisted = hasPersistence && (persistence?.entities?.[name]?.persisted ?? true);
    const persistenceMeta = persistence?.entities?.[name] ?? {};
    const fields = Object.entries(def.fields ?? {}).map(([fieldName, field]) =>
      resolveField(name, fieldName, field, domainTypes, inlineEnumName, { persisted })
    );
    const fieldNames = new Set(fields.map((field) => field.name));

    const relations = [];
    for (const [relName, rel] of Object.entries(def.relations ?? {})) {
      // La back-reference (hija → raíz de su agregado) es la FK del lado dueño en
      // JPA, pero no un miembro del modelo de dominio (el agregado ya es el
      // contexto) y sobre todo no puede entrar en el mapeo: toJpa(hija) →
      // toJpa(raíz) → toJpa(hija) es recursión infinita.
      const { kind, backReference } = classifyRelation(name, rel, internalOf, hasPersistence);
      if (kind === 'unsupported') {
        warnings.push(
          `Relación ${name}.${relName} (${rel.cardinality} hacia ${rel.entity}, otro agregado): no se genera campo; el agente debe modelarla.`
        );
        continue;
      }
      relations.push({
        name: relName,
        entity: rel.entity,
        cardinality: rel.cardinality,
        required: Boolean(rel.required),
        internal: kind === 'internal',
        backReference
      });
    }

    // `lockVersion` es el campo que build reserva para el @Version de JPA en toda
    // raíz de agregado: es un valor opaco de infraestructura, distinto de un
    // `version` que el diseño declare (contador de dominio que viaja en la API y en
    // los eventos, y que incrementa el agregado). Si el diseño usa ese nombre,
    // generar el propio duplicaría campo y accesores — no compila: se avisa y se
    // deja el declarado, que pasa a portar el bloqueo optimista.
    const declaresLockVersion = fields.some((f) => f.name === 'lockVersion');
    // Con la política 'declared' el diseño usa ese campo a propósito: es la forma
    // de decir "esta raíz sí protege la concurrencia", y avisar sobraría.
    if (declaresLockVersion && !internalOf.has(name) && lockingPolicy !== 'declared') {
      warnings.push(
        `Entidad ${name}: el diseño declara el campo lockVersion, nombre que build reserva para el @Version de JPA (concurrencia optimista). Se anota el declarado en vez de generar uno propio; renombra el campo del diseño si su semántica es de negocio.`
      );
    }

    const auditTimestamps = auditsEntity(auditPolicy.timestamps, persisted, fieldNames, 'timestamps');
    const auditAuthorship = auditsEntity(auditPolicy.authorship, persisted, fieldNames, 'authorship');

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
      // Alias de tableName, no un nombre distinto: es el MISMO identificador, y
      // tiene que serlo porque de él salen los nombres de constraint/índice
      // (`uk_<tabla>_natural`) que el ApiExceptionHandler busca en el mensaje de la
      // violación. Existe para que la rama documental no tenga que decir «tabla».
      collectionName: snakeCase(pluralize(name)),
      persisted,
      fields,
      idField: fields.find((f) => f.isId) ?? null,
      relations,
      lifecycle,
      invariants: def.invariants ?? [],
      isAggregateRoot: !internalOf.has(name),
      internalOf: internalOf.get(name)?.aggregate ?? null,
      rootEntity: internalOf.get(name)?.root ?? name,
      declaresLockVersion,
      // Política de concurrencia declarada en persistence.consistency: decide si
      // esta raíz porta control de versión y, con ello, si dos escrituras
      // concurrentes producen un conflicto observable o gana la última.
      usesOptimisticLocking: locksEntity(lockingPolicy, !internalOf.has(name), declaresLockVersion),
      // Auditoría efectiva de esta entidad, eje a eje ('all' | 'declared' | 'none').
      // 'all' la resuelve la herencia de AuditableEntity; 'declared' anota los
      // campos que el dominio ya nombra. Y si la entidad proyecta alguno de esos
      // campos al dominio, su repositorio tiene que hacer flush al guardar: el
      // listener de auditoría escribe en el flush, no en el save.
      auditTimestamps,
      auditAuthorship,
      projectsManagedAudit: auditTimestamps === 'declared' || auditAuthorship === 'declared',
      naturalKey: persistenceMeta.naturalKey ?? null,
      indexes: normalizeIndexes(persistenceMeta.indexes)
    });
  }

  addImplicitAggregateRelations(entities, aggregates, warnings);
  warnMappingCycles(entities, warnings);
  return entities;
}

/**
 * Los índices del diseño, en una sola forma. El DSL admite dos —la lista de
 * campos a secas y el objeto con `unique`/`when`— porque la corta cubre el caso
 * habitual y obligar al objeto habría reescrito todos los diseños existentes.
 * Todo lo que consume índices (el espejo relacional, el config de Mongo, el
 * appendix de migraciones) trabaja contra ESTA forma y no vuelve a mirar cuál
 * de las dos escribió el diseñador.
 */
export function normalizeIndexes(declared) {
  return (declared ?? []).map((index) =>
    Array.isArray(index)
      ? { fields: index, unique: false, when: null }
      : { fields: index.fields, unique: index.unique === true, when: index.when ?? null }
  );
}

// Salvaguarda del mapeo domain↔JPA: el adaptador mapea cada relación interna
// invocando el mapper de la entidad destino, así que un ciclo que la
// back-reference no rompa (A → B → A entre hijas, p. ej.) se traduce en un
// StackOverflowError al guardar. Se avisa en build, que es cuando se puede
// corregir el diseño; el síntoma en runtime no señala a nada.
// Quién ejecuta cada transición: lo declara `use-cases.<op>.transitions` desde 2.6, y es
// lo que convierte el TODO del guard en una instrucción con destinatario. Sin el nombre de
// la operación, el agente lee «método semántico ACTIVE → RETIRED» y tiene que deducir a qué
// handler pertenece; el camino de menor resistencia es no cablearlo y mutar el estado desde
// fuera, que es justo lo que el guard privado existe para impedir.
// `crossrefs` ya garantizó que la transición existe en el lifecycle: aquí solo se indexa.
function attachTransitionExecutors(entities, operations) {
  const byEntity = new Map(); // entidad → Map<`FROM|TO`, [operaciones]>
  for (const [opName, op] of Object.entries(operations)) {
    for (const transition of op.transitions ?? []) {
      if (!byEntity.has(transition.entity)) byEntity.set(transition.entity, new Map());
      const index = byEntity.get(transition.entity);
      for (const from of transition.from ?? []) {
        const key = `${screamingSnake(from)}|${screamingSnake(transition.to)}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(opName);
      }
    }
  }
  for (const entity of entities) {
    if (!entity.lifecycle) continue;
    const index = byEntity.get(entity.name) ?? new Map();
    entity.lifecycle.executedBy = Object.fromEntries(index);
  }
}

function warnMappingCycles(entities, warnings) {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  const done = new Set();
  const reported = new Set();

  const visit = (name, stack) => {
    if (stack.includes(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ');
      if (!reported.has(cycle)) {
        reported.add(cycle);
        warnings.push(
          `Ciclo de mapeo entre entidades internas (${cycle}): toDomain/toJpa se llamarían a sí mismos. Declara la relación de vuelta hacia la raíz del agregado (back-reference) o rompe el ciclo en el diseño.`
        );
      }
      return;
    }
    if (done.has(name)) return;
    for (const relation of byName.get(name)?.relations ?? []) {
      if (!relation.internal || relation.backReference) continue;
      if (byName.has(relation.entity)) visit(relation.entity, [...stack, name]);
    }
    done.add(name);
  };

  for (const entity of entities) visit(entity.name, []);
}

// Una entidad interna de un agregado pertenece a su raíz por definición: es lo
// que declara `aggregates.<A>.entities`. Si el diseño no la ata además con una
// `relations` explícita, la relación se deriva aquí (raíz → colección de hijas),
// para que el agregado tenga su campo de colección y la Jpa su @OneToMany en vez
// de que el agente tenga que modelarlo de cero.
function addImplicitAggregateRelations(entities, aggregates, warnings) {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));

  for (const [aggName, agg] of Object.entries(aggregates)) {
    const root = byName.get(agg.root);
    if (!root) continue;
    const members = [agg.root, ...(agg.entities ?? [])];

    for (const inner of agg.entities ?? []) {
      if (!byName.has(inner)) continue;
      // Ya alcanzada: algún otro miembro del agregado declara una relación hacia
      // ella. NINGUNA back-reference cuenta, venga de quien venga: es el lado dueño
      // de la FK, no la colección que el agregado necesita para gobernar sus hijas.
      // Mirar solo la de la propia hija no bastaba — en Raíz → Hija → Nieta, la
      // back-reference de la NIETA apunta a la hija, y contarla daba por alcanzada a
      // la hija sin que nadie declarase la colección que la raíz necesita: el
      // agregado quedaba sin forma de gobernar sus hijas desde la raíz.
      const reachable = members.some(
        (member) =>
          member !== inner &&
          (byName.get(member)?.relations ?? []).some((rel) => rel.entity === inner && !rel.backReference)
      );
      if (reachable) continue;

      // Dónde cuelga la colección derivada. Por defecto la raíz, pero si la hija ya
      // declara ella misma hacia quién apunta DENTRO del agregado, es ese su padre y
      // ahí va: derivarla en la raíz emitiría un @OneToMany con su propio @JoinColumn
      // mientras la hija conserva el de su back-reference, que son dos FK para una
      // sola relación (el mismo fallo que classifyRelation evita en el otro lado).
      const owner =
        byName.get(
          (byName.get(inner)?.relations ?? []).find((rel) => rel.backReference)?.entity ?? agg.root
        ) ?? root;

      const relName = camelCase(pluralize(inner));
      owner.relations.push({
        name: relName,
        entity: inner,
        cardinality: 'one-to-many',
        required: false,
        internal: true,
        implicit: true
      });
      warnings.push(
        `Agregado ${aggName}: la entidad interna ${inner} no tiene relación declarada con ${owner.name}; se deriva ${owner.name}.${relName} (one-to-many). Decláralas en domain.entities.${owner.name}.relations si el nombre o la cardinalidad deben ser otros.`
      );
    }
  }
}

// ─── Operaciones, servicios, controllers y errores ───────────────────────────

// Orden por defecto de una salida de varios elementos (`sort` del DSL). Solo el
// orden DECLARADO: el desempate por id lo añade el adaptador de repositorio, que
// es el único punto por el que pasa toda consulta paginada del agregado — y que
// tiene que aplicarlo también cuando el cliente manda su propio ?sort=.
//
// Un criterio sobre un agregado embebido (`brand.name`) NO se puede traducir a una
// property path de Spring Data, y da igual el motor: lo que este agregado guarda
// del ajeno es su id, no una referencia navegable —una columna UUID en relacional,
// un campo UUID en el documento—. Se marca `embedded` para que build avise y el
// agente lo resuelva con un join proyectado (conventions/read-composition.md).
function resolveSort(opName, op, domainEntities, warnings, persistenceKind = 'relational') {
  const output = typeof op.output === 'object' ? op.output : null;
  const declared = output?.sort ?? [];
  if (declared.length === 0) return [];

  const entityName = payloadEntity(op.output);
  const embedded = new Set(output?.embed ?? []);
  const readQueriesRef =
    persistenceKind === 'document'
      ? 'skills/keel-spring-mongodb/references/read-queries.md'
      : 'skills/keel-spring-database/references/read-queries.md';

  return declared.map((criterion) => {
    const [path, direction = 'asc'] = String(criterion).split(':');
    const [head, nested] = path.split('.');
    const relation = nested ? domainEntities[entityName]?.relations?.[head] : null;

    if (relation && embedded.has(head)) {
      warnings.push(
        `Operación '${opName}': ordena por '${path}', un campo del agregado embebido '${relation.entity}'. La resolución por lote no puede ordenar por él (de ese agregado solo se guarda su id): hace falta un adaptador de lectura con join proyectado — ${readQueriesRef}`
      );
      return { path, direction, embedded: true, relation: head, field: nested, property: null };
    }

    // En el modelo documental el dot-path es literal: un value object es un
    // subdocumento y una entidad hija va anidada DENTRO del documento raíz, así que
    // `price.amount` y `sections.status` son las dos rutas reales del documento.
    // En el relacional un VO se aplana a columna con prefijo, y la property path de
    // JPA es el nombre compuesto.
    const property = !nested
      ? head
      : persistenceKind === 'document'
        ? `${head}.${nested}`
        : `${head}${nested[0].toUpperCase()}${nested.slice(1)}`;
    return { path, direction, embedded: false, relation: null, field: nested ?? head, property };
  });
}

function collectOperations(layers, domainTypes, inlineEnumName, service, warnings, persistenceKind) {
  const operations = layers['use-cases']?.operations ?? {};
  const api = layers.api ?? null;
  const domainEntities = layers.domain?.entities ?? {};
  const relations = {
    internalOf: aggregateIndex(layers.domain ?? {}),
    hasPersistence: Boolean(layers.persistence)
  };
  const errorsByCode = new Map();
  const groups = new Map();

  for (const [opName, op] of Object.entries(operations)) {
    const targetEntity =
      payloadEntity(op.output) ?? payloadEntity(op.input) ?? entityFromOperationName(opName, domainEntities);
    const groupName = targetEntity ?? pascalCase(service.name);
    const route = resolveRoute(opName, op, api, targetEntity, warnings);

    const inputFields = payloadFields(opName, op.input, { direction: 'input', domainEntities, domainTypes, inlineEnumName, relations, warnings });
    // Los parámetros de ruta salen de la propia ruta ({id}, {productId}, {slug}…),
    // no del nombre del campo: es lo único que garantiza un @PathVariable por
    // segmento y con el tipo declarado en el diseño.
    const pathParams = resolvePathParams(opName, route, inputFields, warnings);
    const pathParamNames = new Set(pathParams.map((p) => p.name));
    // El campo que recibe la identidad del llamante sigue EN el mensaje —el handler la necesita—
    // pero no se acepta del cuerpo: lo estampa el servidor desde la credencial. Se marca en vez de
    // filtrarse porque el record del comando ES el cuerpo HTTP, y quitarlo de la lista lo quitaría
    // también del mensaje, dejando al handler sin la identidad.
    const identityField = layers.security?.authentication?.callerIdentity?.field ?? null;
    const bodyFields = inputFields
      .filter((f) => !pathParamNames.has(f.name))
      .map((f) => (f.name === identityField ? { ...f, resolvedIdentity: true } : f));
    const outputFields = payloadFields(opName, op.output, { direction: 'output', domainEntities, domainTypes, inlineEnumName, relations, warnings });

    for (const error of op.errors ?? []) {
      const http = error.http ?? 400;
      const existing = errorsByCode.get(error.code);
      if (!existing) {
        errorsByCode.set(error.code, {
          code: error.code,
          // Naming del prototipo de referencia: <PascalCode>Error.
          exceptionClass: `${pascalCase(error.code.toLowerCase())}Error`,
          http,
          sharedException: sharedExceptionFor(http),
          when: error.when ?? null,
          // Rastro de dónde se declara: si el mismo code aparece con http
          // distinto en dos operaciones, el status no puede quemarse en la clase.
          statuses: new Map([[http, [opName]]])
        });
      } else {
        if (!existing.statuses.has(http)) existing.statuses.set(http, []);
        existing.statuses.get(http).push(opName);
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
      pathParams,
      hasIdParam: pathParams.length > 0,
      // Sin XxxRequest (estilo prototipo): el Command es el body HTTP y sus
      // componentes llevan la Bean Validation del diseño.
      bodyFields,
      // Con un campo binario en la entrada el endpoint deja de ser JSON (solo
      // tiene sentido en los verbos que llevan cuerpo).
      multipart: bodyFields.some((field) => field.file) && ['POST', 'PUT', 'PATCH'].includes(route?.method),
      responseDto:
        outputFields.length > 0
          ? { name: `${pascalCase(opName)}ResponseDto`, fields: outputFields, entity: payloadEntity(op.output) }
          : null,
      returnsList: Boolean(typeof op.output === 'object' && op.output?.list),
      paginated: Boolean(typeof op.output === 'object' && op.output?.paginated),
      sort: resolveSort(opName, op, domainEntities, warnings, persistenceKind),
      preconditions: op.preconditions ?? [],
      rules: op.rules ?? [],
      errors: (op.errors ?? []).map((e) => e.code),
      emits: op.emits ?? [],
      // La guarda de la idempotencia NO se declara: se deriva, y solo de hechos del diseño.
      // Con `payload-field`, si el campo de la clave participa en la `naturalKey` de la entidad
      // que la operación escribe, esa constraint YA es la guarda —permanente y común a todas las
      // puertas por las que entre la operación—, así que un almacén aparte sería un segundo
      // registro de lo mismo que además caduca. Es el mismo tipo de derivación que hace
      // `soleConstraint` en declared-errors.js, no una adivinanza.
      idempotency: resolveIdempotency(op, targetEntity, layers),
      // Las transiciones del lifecycle que esta operación ejecuta (DSL 2.6). Aquí se
      // usan para el ORDEN de los efectos en el stub del handler; el TODO del método
      // semántico dentro del agregado lo cablea attachTransitionExecutors.
      transitions: op.transitions ?? [],
      cache: op.cache ?? null,
      schedule: op.schedule ?? null,
      // Relay: un barrido que RECLAMA trabajo pendiente. Se deduce, no se declara —
      // correr replicado no es una decisión del diseño sino una restricción del
      // despliegue, así que no hay campo del DSL que ponerle.
      //
      // La señal es `schedule` + `transitions`: sacar filas de un estado ES
      // reclamarlas, y `@Scheduled` corre en TODAS las réplicas a la vez. Sin reclamo
      // atómico las N instancias se llevan las mismas filas y todas actúan sobre ellas.
      //
      // Las purgas quedan fuera a propósito, y no por descuido: un barrido que solo
      // borra lo caducado es idempotente por forma —borrar dos veces la misma fila da
      // el mismo resultado que borrarla una—, así que solaparse no produce ningún
      // efecto doble. El razonamiento largo está en conventions/dependencies.md
      // § El barrido corre en todas las réplicas.
      claim: null
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

  return { services: [...groups.values()], errors: resolveErrorStatuses([...errorsByCode.values()], warnings) };
}

/**
 * Qué barrido reclama trabajo, y qué reclama exactamente.
 *
 * Correr replicado no es una decisión del diseño sino una restricción del despliegue:
 * `@Scheduled` es «una vez por instancia», no «una vez en el clúster», así que un
 * barrido que LEA su lote se lo da entero a las N réplicas. Por eso no hay campo del
 * DSL que declarar — se deduce — y por eso el reclamo lo genera build.
 *
 * Es barrido la operación que (a) tiene `schedule`, (b) NO recibe el id de lo que
 * procesa —si el llamante ya eligió la fila, quien tuvo que reclamarla es él— y (c)
 * declara `transitions`, que es lo que dice sobre qué entidad trabaja. Quedan fuera las
 * disparadas por una suscripción (procesan el mensaje que les llega, no un lote) y las
 * purgas sin transiciones (borrar lo caducado es idempotente por forma: solaparse no
 * produce ningún efecto doble).
 *
 * Y lo que reclama sale del LIFECYCLE, no de las transiciones que el barrido declare:
 * la cola es el estado inicial de la entidad —aquel al que ninguna transición lleva—,
 * y su sucesor es la marca de que alguien la tomó. Esa marca es persistida y sobrevive
 * al commit, que es lo que hace falta cuando entre reclamar y actuar hay una llamada
 * externa. Mirar solo las transiciones del barrido no vale: en el diseño de referencia
 * el paso `queued → sending` lo declara la operación interna que el barrido invoca, no
 * el barrido.
 */
function classifyClaims(services, entities, layers, warnings) {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  const bySubscription = new Set(
    Object.values(layers.messaging?.subscriptions ?? {})
      .map((sub) => sub?.triggers)
      .filter(Boolean)
  );
  // Los barridos de reconciliación tienen su propio reclamo, y NO es este: sacan filas de
  // un estado de espera —que por definición está «en vuelo»— con la cota temporal que el
  // diseño declara (unansweredAfterSeconds) y una marca persistida que sobrevive al
  // commit, porque la llamada al proveedor va en medio. Lo resuelve `reconciliationClaim`
  // al recorrer las dependencias. Tratarlos aquí sería a la vez generar dos reclamos
  // distintos para el mismo barrido y avisar de una cota que el diseño sí dio.
  const byReconciliation = new Set(
    Object.values(layers.dependencies?.dependencies ?? {})
      .flatMap((dependency) => Object.values(dependency?.activations ?? {}))
      .map((activation) => activation?.reconciledBy)
      .filter(Boolean)
  );

  for (const service of services) {
    for (const operation of service.operations) {
      if (!operation.schedule) continue;
      if (bySubscription.has(operation.name)) continue;
      if (byReconciliation.has(operation.name)) continue;
      // El llamante ya eligió la fila: reclamarla era cosa suya.
      if (operation.hasIdParam || operation.bodyFields.length > 0) continue;

      const transitions = operation.transitions ?? [];
      if (transitions.length === 0) continue;

      // Marca de barrido: vale aunque build no pueda generarle el reclamo. La nota al
      // agente y el gate de calidad cuelgan de ESTO, no de que el reclamo exista.
      operation.sweep = true;

      const claims = [];
      for (const transition of transitions) {
        const entity = byName.get(transition.entity);
        const lifecycle = entity?.lifecycle;
        if (!lifecycle) continue;
        const reached = new Set((lifecycle.transitions ?? []).flatMap((t) => t.to ?? []));

        // Una COLA es un estado al que ninguna transición lleva: las filas se acumulan
        // ahí esperando a que alguien las tome, y tomarlas todas es lo que el barrido
        // quiere. Un estado al que sí se llega está EN VUELO: hay una instancia
        // trabajando en esas filas ahora mismo, y reclamarlas le arrancaría el trabajo
        // de las manos. El rescate legítimo de eso necesita una cota temporal («lleva
        // más de N minutos ahí») que vive en la prosa de `rules` y que build no puede
        // inventar — así que no se genera, y se dice en voz alta.
        const queues = (transition.from ?? []).filter((state) => !reached.has(screamingSnake(state)));
        const inFlight = (transition.from ?? []).filter((state) => reached.has(screamingSnake(state)));

        if (inFlight.length > 0) {
          warnings.push(
            `use-cases: ${operation.name} saca ${transition.entity} de ${inFlight.join(', ')}, que es un estado EN ` +
              `VUELO: otra réplica puede estar trabajando en esas filas ahora mismo. build NO genera ese reclamo, ` +
              `porque un rescate necesita una cota temporal («lleva más de N minutos ahí») que el DSL no declara y ` +
              `que build no puede inventar. Recláma­lo tú con esa cota — el gate de calidad comprueba que el barrido ` +
              `reclame en vez de leer.`
          );
        }
        if (queues.length === 0) continue;

        const suffix = `${pascalCase(operation.name)}${transitions.length > 1 ? pascalCase(transition.to) : ''}`;
        claims.push({
          entity: transition.entity,
          from: queues,
          to: transition.to,
          suffix,
          method: `claimFor${suffix}`
        });
      }

      if (claims.length > 0) operation.claim = claims;
    }
  }
}

/**
 * La guarda de una operación que produce un efecto externo IRREVERSIBLE sobre una fila
 * concreta: un correo que sale no lo deshace ningún rollback.
 *
 * La forma es reconocible sin adivinar nada. La operación declara `A → B` y, en la misma
 * lista, `B → C`: ese `B` intermedio no es un estado en el que la fila se quede, es la
 * marca de que ESTA ejecución se llevó el trabajo. El diseño de referencia lo escribe
 * así — `queued → sending`, `sending → sent`, `sending → failed` — y su prosa lo llama
 * por su nombre: «la transición de queued a sending es la guarda contra el doble envío».
 *
 * Y no basta con hacer esa transición en memoria antes de enviar. El handler corre
 * dentro de la transacción que abre el mediator, así que la marca no existe para nadie
 * hasta el commit final, que llega DESPUÉS del envío: si el proceso cae entre el relay
 * aceptando el correo y ese commit, la transacción revierte, la fila vuelve a estar
 * disponible y el ciclo siguiente manda un SEGUNDO correo a una persona real. Ocurrió
 * tal cual en una corrida. Por eso la marca se persiste en una transacción PROPIA
 * (REQUIRES_NEW) antes de enviar: a partir de ahí, una caída deja la fila en `B`, que es
 * exactamente el estado que el rescate del barrido busca — y el rescate no reenvía.
 *
 * `classifyClaims` no lo cubre y no es un olvido: allí el sujeto es un barrido que elige
 * su lote, y esta operación recibe el id ya elegido. Quien se lo pasa tampoco lo reclamó
 * —su propia transición sale de un estado EN VUELO, así que build no le generó reclamo—,
 * de modo que sin esto la fila no la reclama nadie.
 */
function classifyGuardClaims(services, entities, layers) {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  // Hoy el único efecto externo irreversible que build sabe atribuir a una operación es
  // el correo (`mail.sentBy`): es el diseño quien lo dice, no una inferencia. Una llamada
  // saliente no entra —el DSL declara su compensación aparte— y una subida a un bucket
  // tampoco: sobrescribir la misma key es idempotente.
  const irreversible = new Set(layers.mail?.sentBy ?? []);
  if (irreversible.size === 0) return;

  for (const service of services) {
    for (const operation of service.operations) {
      if (!irreversible.has(operation.name)) continue;
      // Un barrido elige su propio lote, y su reclamo es el de `classifyClaims`: por
      // lote y no por fila. Aquí el sujeto es la operación que trabaja sobre UNA, con el
      // id ya elegido por quien la invoca.
      if (operation.schedule) continue;

      const transitions = operation.transitions ?? [];
      // El estado intermedio: destino de una transición y origen de otra, en la MISMA
      // operación. Es lo que lo distingue de un desenlace.
      const departures = new Set(transitions.flatMap((t) => t.from ?? []));
      const guard = transitions.find((t) => departures.has(t.to));
      if (!guard) continue;

      const entity = byName.get(guard.entity);
      if (!entity?.lifecycle) continue;

      // La marca de tiempo del estado intermedio, si la entidad la declara. El rescate
      // mide sobre ella («lleva más de N minutos en B»), así que estamparla es parte del
      // reclamo y no del trabajo posterior: una fila marcada sin instante es una fila que
      // el rescate no encuentra nunca. El nombre se deriva del estado, y si la entidad no
      // declara ninguno el reclamo solo cambia el estado.
      const stampNames = [`${guard.to}Since`, `${guard.to}At`];
      const stamp = entity.fields.find((field) => stampNames.includes(field.name) && field.base === 'timestamp');

      operation.guardClaim = {
        entity: guard.entity,
        from: guard.from ?? [],
        to: guard.to,
        suffix: pascalCase(operation.name),
        method: `claimFor${pascalCase(operation.name)}`,
        stampField: stamp?.name ?? null,
        operation: operation.name
      };
    }
  }
}

// Un mismo `code` declarado con `http` distinto en dos operaciones no puede
// generar una clase con el status quemado: la primera operación se llevaría el
// status de la otra. En ese caso la excepción extiende DomainException directamente
// y recibe el status por constructor, que es lo que ApiExceptionHandler lee de la
// metadata (onDomainException).
function resolveErrorStatuses(errors, warnings) {
  return errors.map((error) => {
    const statuses = [...error.statuses.keys()];
    if (statuses.length < 2) return { ...error, dynamicStatus: false, usages: [] };

    const usages = [...error.statuses.entries()].map(([http, operations]) => ({ http, operations }));
    warnings.push(
      `Nota: '${error.code}' se declara con status distintos según la operación (${usages
        .map((u) => `${u.http} en ${u.operations.join(', ')}`)
        .join('; ')}) — diseño válido y soportado. ${error.exceptionClass} recibe el status por constructor; pásalo en cada handler.`
    );
    return { ...error, sharedException: 'DomainException', dynamicStatus: true, usages };
  });
}

// ─── DTOs de entidades hijas ─────────────────────────────────────────────────

// Una entidad hija proyectada en un payload de salida necesita su propio record
// (<Hija>Dto) para que la respuesta lleve la colección completa y no una lista de
// nulls. Se resuelven en cascada: una hija puede proyectar a su vez sus hijas.
function collectChildDtos(layers, services, domainTypes, inlineEnumName, warnings) {
  const domainEntities = layers.domain?.entities ?? {};
  const relations = {
    internalOf: aggregateIndex(layers.domain ?? {}),
    hasPersistence: Boolean(layers.persistence)
  };

  const pending = [];
  for (const group of services) {
    for (const operation of group.operations) {
      for (const field of operation.responseDto?.fields ?? []) {
        if (field.kind === 'childDto') pending.push(field.childEntity);
      }
    }
  }

  const built = new Map();
  while (pending.length > 0) {
    const entityName = pending.shift();
    if (built.has(entityName) || !domainEntities[entityName]) continue;
    const fields = payloadFields(entityName, { entity: entityName }, {
      direction: 'output',
      domainEntities,
      domainTypes,
      inlineEnumName,
      relations,
      warnings
    });
    built.set(entityName, { name: `${entityName}Dto`, entity: entityName, fields });
    for (const field of fields) {
      if (field.kind === 'childDto') pending.push(field.childEntity);
    }
  }
  return [...built.values()];
}

// DTOs de referencia de los payloads con embed: los campos propios del agregado
// referenciado, SIN sus relaciones (relations: null) — la proyección se corta a
// profundidad 1 para que embebir una categoría no arrastre su árbol entero.
function collectRefDtos(layers, services, domainTypes, inlineEnumName, childDtos, warnings) {
  const domainEntities = layers.domain?.entities ?? {};
  const referenced = new Set();

  const scan = (fields) => {
    for (const field of fields ?? []) {
      if (field.kind === 'refDto') referenced.add(field.refEntity);
    }
  };
  for (const group of services) {
    for (const operation of group.operations) scan(operation.responseDto?.fields);
  }
  for (const child of childDtos) scan(child.fields);

  const built = [];
  for (const entityName of referenced) {
    if (!domainEntities[entityName]) continue;
    const fields = payloadFields(entityName, { entity: entityName }, {
      direction: 'output',
      domainEntities,
      domainTypes,
      inlineEnumName,
      relations: null,
      warnings
    });
    built.push({ name: `${entityName}RefDto`, entity: entityName, fields });
  }
  return built;
}

// ─── Eventos de dominio (messaging.publishing.events) ────────────────────────

// Destinos de mensajería que la validación funcional debe dejar limpios entre
// flujos: los canales declarados (`messaging.channels`) más los destinos por
// convención de lo que no declara canal — el exchange/topic del servicio para la
// publicación, y `<origen>.events` por suscripción. Sin esta lista el reset deja
// en la cola los mensajes de la corrida anterior y un escenario acaba leyendo un
// evento que no publicó (rompe por igual las aserciones de "último evento" y las
// de "ningún evento").
// `all` es lo que hay que dejar limpio; `publish` son los canales **declarados**
// a los que publica este servicio. Solo esos tienen nombre fijado por el diseño en
// todos los brokers, así que solo esos puede exigir la prueba de humo del arnés:
// sin `channels`, el destino por convención es el exchange/topic del servicio, que
// en un broker direccionado por cola (RabbitMQ) no es un destino legible.
function collectChannels(layers, service, stack) {
  const serviceSlug = kebabCase(service.name);
  // Nombre FÍSICO del destino: el del diseño saneado para el broker elegido.
  // Se aplica a todo lo que sale de aquí porque estos nombres acaban siendo
  // recursos reales (topic, cola, exchange) y la URL de cola del arnés.
  const safe = (name) => brokerSafeName(name, stack?.broker);
  const declared = Object.keys(layers.messaging?.channels ?? {}).map(safe);
  const events = Object.entries(layers.messaging?.publishing?.events ?? {});
  const publish = new Set();
  const all = new Set(declared);
  // Canal lógico → nombres de evento que caen en él. Es lo que permite discriminar
  // dentro del destino único: el nombre del evento es literalmente el
  // `metadata.eventType` que estampa EventMetadata.now(...) al emitirlo.
  const eventTypesByChannel = {};
  for (const [name, def] of events) {
    const channel = safe(def?.channel ?? `${serviceSlug}.events`);
    // Declarado o implícito, es un canal por el que este servicio PUBLICA, y de
    // eso cuelga todo lo que hay que sembrar y sondear: la cola de arnés de
    // snssqs y el humo SMOKE-4. Mientras el implícito no contó, un diseño que no
    // declarase `channel:` en sus eventos —el caso normal— generaba un arnés que
    // leía una cola que nadie creaba: NonExistentQueue en el primer escenario que
    // afirmara un evento publicado.
    publish.add(channel);
    if (!def?.channel) all.add(channel);
    (eventTypesByChannel[channel] ??= []).push(name);
  }
  for (const [name, def] of Object.entries(layers.messaging?.subscriptions ?? {})) {
    if (!def?.channel) all.add(safe(`${def?.source ? kebabCase(def.source) : kebabCase(name)}.events`));
  }
  return {
    all: [...all],
    publish: [...publish],
    eventTypesByChannel,
    // Mismo default que emite config.js en `messaging.publishing.destination`.
    destinationDefault: safe(`${serviceSlug}.events`)
  };
}

function collectEvents(layers, services, service, domainTypes, inlineEnumName, warnings, stack) {
  const events = layers.messaging?.publishing?.events ?? {};
  const domainEntities = layers.domain?.entities ?? {};
  const emitters = emittersByEvent(services);
  const serviceSlug = kebabCase(service.name);
  const safe = (name) => brokerSafeName(name, stack?.broker);

  return Object.entries(events).map(([name, def]) => {
    const emitted = emitters.get(name) ?? [];
    return {
      name,
      className: `${pascalCase(name)}Event`,
      integrationClass: `${pascalCase(name)}IntegrationEvent`,
      publisherClass: `${pascalCase(name)}Publisher`,
      description: def?.description ?? null,
      channel: def?.channel ?? null,
      // Enrutado por convención: exchange/topic del servicio + clave por evento.
      // Ambos salen a parameters/ y llegan al código por @Value (nunca literales).
      destinationProperty: 'messaging.publishing.destination',
      destinationDefault: safe(`${serviceSlug}.events`),
      routingKeyProperty: `messaging.publishing.routing-keys.${kebabCase(name)}`,
      // La routing key NO se sanea: no es el nombre de un recurso, es un atributo
      // del mensaje (clave de enrutado en RabbitMQ, message attribute en SNS).
      routingKeyDefault: `${serviceSlug}.${kebabCase(name)}`,
      // Quién lo emite: la raíz de agregado del grupo cuya operación lo declara
      // en `emits`. Es lo que permite sembrar el raise(...) donde corresponde.
      aggregate: emitted[0]?.aggregate ?? null,
      emittedBy: emitted,
      // messaging declara el payload como fieldMap directo (campo → field), no
      // como el payload de use-cases: se envuelve para reutilizar la resolución
      // de tipos. Sin esto el evento saldría solo con metadata, sin datos.
      fields: payloadFields(name, def?.payload ? { fields: def.payload } : null, {
        direction: 'output',
        domainEntities,
        domainTypes,
        inlineEnumName,
        warnings
      })
    };
  });
}

// Índice evento → operaciones que lo declaran en `emits` (con su agregado).
function emittersByEvent(services) {
  const index = new Map();
  for (const group of services) {
    for (const operation of group.operations) {
      for (const eventName of operation.emits) {
        if (!index.has(eventName)) index.set(eventName, []);
        index.get(eventName).push({ aggregate: group.entity, operation: operation.name });
      }
    }
  }
  return index;
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
    matchers.push({
      method: route.method,
      path: `${routeBase}${route.path}`,
      authority: accessAuthority(rule),
      audience: route.audience ?? 'users'
    });
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

  // Alcance por recurso (security.authentication.scoping). Roles, permissions y scopes son
  // globales, así que sin este bloque no hay nada declarado que distinga a un solicitante
  // permitido de uno prohibido sobre UN recurso concreto. Lo que el generador necesita de él
  // es el nombre del claim y a quién NO se acota: con eso aprovisiona el proveedor de
  // identidad, que es la mitad que antes había que parchear a mano en cada proyecto.
  // La identidad del llamante por HTTP. El campo que la recibe deja de viajar en el cuerpo: lo
  // estampa el servidor desde la credencial, igual que el listener lo estampa desde el mensaje.
  // Sin esto, el campo llegaba del cuerpo —que lo elige el llamante— y la resolución acababa en un
  // segundo campo sintético que alguien tenía que reconciliar a mano.
  const rawCallerIdentity = sec.authentication?.callerIdentity ?? null;
  const callerIdentity = rawCallerIdentity
    ? { field: rawCallerIdentity.field, source: rawCallerIdentity.from.source, claim: rawCallerIdentity.from.name ?? null }
    : null;

  const rawScoping = sec.authentication?.scoping ?? null;
  const scoping = rawScoping
    ? {
        claim: rawScoping.claim,
        over: rawScoping.over,
        error: rawScoping.error,
        exemptRoles: rawScoping.exemptRoles ?? [],
        // El recurso con el que se siembran los usuarios de prueba no exentos. Se deriva aquí y no
        // en el emisor porque lo consumen DOS —el script que siembra el realm y el arnés que pide
        // los tokens—, y cuando cada uno lo resolvía por su cuenta el desajuste tumbaba clases
        // enteras con un 403 en su `@BeforeAll`.
        //
        // Es el PRIMER `serviceClient` declarado: en un diseño con superficie M2M es el único
        // candidato que puede originar tráfico, que es lo que el escenario del alcance necesita
        // ejercitar. Sin `serviceClients` no hay nada que originar y basta un literal.
        testResource: Object.keys(sec.serviceClients ?? {})[0] ?? 'keel-scoped-resource'
      }
    : null;

  // Permisos que otorga cada rol (security.roleGrants): derivable al 100% del
  // diseño, se materializa como mapa estático en el JwtAuthConverter para que
  // hasAnyAuthority("<recurso>:<accion>") funcione con IdPs que solo emiten roles.
  const roleGrants = Object.entries(sec.roleGrants ?? {})
    .map(([role, permissions]) => ({ role, permissions: permissions ?? [] }))
    .filter((grant) => grant.permissions.length > 0);

  // Roles y scopes que el diseño nombra en alguna parte: es lo que el proveedor
  // de identidad de prueba tiene que existir para poder ejercitar los escenarios
  // (un usuario por rol, un client scope por scope). Ver scaffold/auth-provisioning.js.
  const roles = [
    ...new Set([...allRules.flatMap((r) => r.roles ?? []), ...Object.keys(sec.roleGrants ?? {})])
  ].sort();
  const scopes = [
    ...new Set([...allRules.flatMap((r) => r.scopes ?? []), ...serviceClients.flatMap((c) => c.scopes)])
  ].sort();

  return {
    protocol,
    matchers,
    defaultAuthority: accessAuthority(defaultRule),
    usesAuthorities,
    serviceAuth,
    callerIdentity,
    scoping,
    serviceClients,
    roleGrants,
    roles,
    scopes,
    cors: collectCors(sec.cors, routeByOp)
  };
}

// Política CORS (security.cors). El diseño declara la política; los orígenes son
// dato de despliegue y salen por configuración. Los métodos se derivan de los
// endpoints reales (mismo routeByOp que los matchers) más OPTIONS del preflight.
function collectCors(cors, routeByOp) {
  if (!cors) return null;
  const methods = [...new Set([...[...routeByOp.values()].map((route) => route.method), 'OPTIONS'])].sort();
  return {
    allowCredentials: cors.allowCredentials === true,
    allowedHeaders: cors.allowedHeaders ?? ['*'],
    exposedHeaders: cors.exposedHeaders ?? [],
    maxAgeSeconds: cors.maxAgeSeconds ?? 3600,
    methods
  };
}

// ─── Object storage (storage.buckets → política por bucket) ──────────────────

// La política de cada bucket (visibilidad, tamaño máximo, tipos permitidos) es
// del diseño, no del proveedor: viaja al fragmento de configuración para que el
// adaptador que escribe el agente la aplique sin reinventarla, y fija el límite
// de multipart de Spring.
function collectStorage(layers) {
  const storage = layers.storage;
  if (!storage) return null;
  const buckets = Object.entries(storage.buckets ?? {}).map(([name, def]) => ({
    name,
    visibility: def?.visibility ?? 'private',
    // Cuánto vale la URL firmada de este bucket. Solo tiene sentido en los privados,
    // que son los únicos que se leen por firma; el schema lo veta en los públicos.
    signedUrlTtlSeconds: def?.signedUrlTtlSeconds ?? null,
    maxSizeMb: def?.maxSizeMb ?? null,
    allowedContentTypes: def?.allowedContentTypes ?? [],
    description: def?.description ?? null
  }));
  const sizes = buckets.map((b) => b.maxSizeMb).filter((mb) => typeof mb === 'number');
  return {
    buckets,
    // Límite de subida del servlet: el mayor de los declarados (cada bucket
    // aplica además el suyo). Sin ninguno, se deja el default de Spring.
    maxSizeMb: sizes.length > 0 ? Math.max(...sizes) : null,
    hasPublicBucket: buckets.some((b) => b.visibility === 'public'),
    // Decide si el puerto FileStorage declara download: un bucket público se lee
    // del borde y el servicio nunca intermedia el binario, así que ahí el método
    // no lo invoca nadie y solo obliga al agente a implementar un camino
    // inalcanzable (ver storage.js § renderPort).
    hasPrivateBucket: buckets.some((b) => b.visibility === 'private')
  };
}

// ─── Correo saliente (mail → puerto MailSender + adaptador SMTP) ─────────────

// Lo que el diseño decide sobre el correo, ya resuelto a la forma que consumen el
// scaffolding y el fragmento de configuración. Nada de proveedor: el servidor SMTP
// y sus credenciales son dato de despliegue y viven en parameters/<perfil>/mail.yaml.
function collectMail(layers) {
  const mail = layers.mail;
  if (!mail) return null;
  const parts = mail.delivery?.parts ?? [];
  return {
    transport: mail.delivery?.transport ?? 'smtp',
    parts,
    hasHtml: parts.includes('html'),
    hasText: parts.includes('text'),
    // Las dos partes ⇒ multipart/alternative. Con una sola el mensaje es simple, y
    // la diferencia la ve el adaptador: componer un multipart de una parte es un
    // sobre vacío alrededor del mismo cuerpo.
    multipart: parts.includes('html') && parts.includes('text'),
    attachments: mail.delivery?.attachments === true,
    sentBy: mail.sentBy ?? [],
    sender: addressSource(mail.sender),
    replyTo: addressSource(mail.replyTo),
    templating: mail.templating
      ? {
          source: mail.templating.source,
          // El cuerpo lo escribe alguien de fuera del equipo: el motor no puede
          // evaluar expresiones arbitrarias. No es un campo del DSL —sería una
          // capacidad que nada comprueba— sino la consecuencia de source: data,
          // y aquí es donde el scaffolding la lee.
          externalContent: mail.templating.source === 'data',
          declaredVariables: mail.templating.declaredVariables === true
        }
      : null,
    description: mail.description ?? null
  };
}

function addressSource(spec) {
  if (!spec) return null;
  return {
    source: spec.source,
    address: spec.address ?? null,
    fallback: spec.fallback ?? null,
    description: spec.description ?? null
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

function resolveOutboundIdempotency(clientId, callName, call, layers, warnings) {
  const header = call.idempotency.header ?? 'Idempotency-Key';
  const hasCorrelation = Boolean(layers.api || layers.messaging);
  if (call.idempotency.keyFrom === 'correlation' && !hasCorrelation) {
    warnings.push(
      `http-clients ${clientId}.${callName}: idempotency.keyFrom 'correlation' sin capa api ni messaging — nadie abre el contexto de correlación, así que la clave sale del contenido de la petición.`
    );
    return { keyFrom: 'payload-hash', header };
  }
  return { keyFrom: call.idempotency.keyFrom, header };
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
        // La cara saliente de la idempotencia: la clave que le mandamos al proveedor
        // para que NUESTRO reintento no ejecute su trabajo dos veces. `correlation`
        // exige que haya correlación que leer: sin api ni messaging nadie abre el
        // contexto, así que se degrada al contenido y se dice — una clave nula o
        // aleatoria pediría una ejecución nueva en cada intento.
        idempotency: call.idempotency ? resolveOutboundIdempotency(clientId, callName, call, layers, warnings) : null,
        retry: call.retry ?? null,
        circuitBreaker: call.circuitBreaker ?? null,
        fallback: call.fallback ?? null,
        instanceName: `${clientId}-${kebabCase(callName)}`,
        fallbackMethod: `${callName}Fallback`,
        // El fallback son varias sobrecargas tipadas —una por excepción que de verdad
        // significa que el proveedor no está— y todas delegan aquí, que es donde vive
        // la política. Una sola: si el cuerpo se duplicara por sobrecarga, las ramas
        // podrían divergir y el llamante no distingue por cuál entró.
        unavailableMethod: `${callName}Unavailable`
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

// ─── Dependencias con otros servidores (dependencies) ────────────────────────
//
// Capa de síntesis: no crea clientes ni listeners (ya salen de http-clients y
// messaging), solo declara por qué existen y qué hay que materializar además.
// Lo único que exige código propio es `replica`: la copia local y su política
// de lectura cuando el dato falta (onMiss).
//
// Las dos mitades del DSL —`needs` (leo un dato del proveedor) y `activations`
// (le pido trabajo)— acaban aquí como retro-enlaces colgados de las piezas ya
// resueltas, igual que `entity.replicaOf` o `sub.feedsReplica`:
//
//   operation.dependencyNeeds       ← needs cuyo `usedBy` cita la operación
//   operation.dependencyActivations ← activaciones cuyo `triggeredBy` la cita
//   call.activations                ← activaciones que salen por esa llamada HTTP
//
// `usedBy` y `triggeredBy` son el único enlace del DSL entre un caso de uso y el
// trabajo que delega: si no aterrizan en el stub del handler, el diseño declara
// una obligación que nadie ve al escribir el código.

/**
 * El reclamo del barrido de reconciliación, cuando build puede generarlo.
 *
 * Aquí el reclamo NO puede ser un lock: entre reclamar y actuar hay una llamada al
 * proveedor, y un lock solo aísla mientras dura su transacción. Hace falta una marca
 * PERSISTIDA con caducidad, y por eso el reclamo se apoya en una tabla propia del
 * generador (`reconciliation_claim`) en vez de en el lifecycle: el estado de espera no
 * puede cambiar —es justo lo que el barrido busca— así que no hay transición con la que
 * marcar. La misma familia que `processed_event` o `idempotency_record`, y por el mismo
 * motivo: es mecánica del generador, no algo que el diseño declare.
 *
 * Tres cosas tienen que salir del diseño, y si falta alguna build NO inventa nada: se
 * queda sin reclamo generado, lo dice, y el barrido vuelve a ser entero del agente.
 *
 *   · UNA sola entidad en espera. Con dos, el barrido reclama dos cosas distintas y qué
 *     significa «el lote» deja de estar definido.
 *   · Su lifecycle, que es de donde salen los estados de espera.
 *   · La MARCA TEMPORAL de la espera, que el diseño declara en `awaitingSince`. Sin ella
 *     no hay «lleva demasiado tiempo»: el estado dice que espera, no cuánto lleva. Es
 *     obligatoria junto a `reconciledBy`, así que aquí solo falta con `--wip`.
 */
function reconciliationClaim({ depId, activation, sweeper, waitingByEntity, entityByName, warnings }) {
  const gap = (reason) => {
    warnings.push(
      `dependencies: ${depId}.${activation.name} declara reconciledBy: ${sweeper.name}, pero build no puede ` +
        `generarle el reclamo — ${reason}. El barrido corre en TODAS las réplicas, así que el reclamo tiene que ` +
        `existir igual: lo escribe el agente, y el gate de calidad (familia reconciliation) lo comprueba.`
    );
    return null;
  };

  if (waitingByEntity.size === 0) return gap('ninguna operación de triggeredBy declara transitions, así que no se sabe qué entidad queda esperando');
  if (waitingByEntity.size > 1) {
    return gap(`las operaciones que la disparan dejan esperando a ${[...waitingByEntity.keys()].join(' y ')}, y un reclamo sobre dos entidades no define qué es «el lote»`);
  }

  const [entityName, states] = [...waitingByEntity][0];
  const entity = entityByName.get(entityName);
  if (!entity?.lifecycle) return gap(`${entityName} no declara lifecycle, y los candidatos se eligen por su estado de espera`);

  // La marca sale del diseño, no de una convención de nombre: `awaitingSince` es
  // obligatorio junto a `reconciledBy` y `keel validate` ya comprobó que existe, que es
  // timestamp y que no la gestiona la auditoría. La guarda que queda es defensiva —
  // `build --wip` no exige diseño válido— y no el camino normal.
  const awaitingField = activation.awaitingSince;
  if (!awaitingField || !(entity.fields ?? []).some((field) => field.name === awaitingField)) {
    return gap(
      awaitingField
        ? `${entityName} no declara el campo ${awaitingField} que nombra su awaitingSince`
        : `la activación no declara 'awaitingSince', la marca de CUÁNDO empezó la espera (obligatoria con ` +
          `reconciledBy desde el DSL 2.10: 'keel validate' lo dice como error, esto solo se alcanza con --wip)`
    );
  }

  const suffix = `${pascalCase(sweeper.name)}${pascalCase(activation.name)}`;
  return {
    dependency: depId,
    activation: activation.name,
    entity: entityName,
    states: [...states],
    awaitingField,
    // El umbral que declara el diseño. Viaja en el descriptor porque es el DEFAULT del
    // @Value del adaptador: el valor vive en parameters/<perfil>/reconciliation.yaml, y
    // el default tiene que ser el mismo número o el diseño diría una cosa y el binario
    // otra en cuanto falte el fichero.
    unansweredAfterSeconds: activation.unansweredAfterSeconds ?? 3600,
    suffix,
    method: `claimFor${suffix}`,
    // La rama de `parameters/<perfil>/reconciliation.yaml` que config.js ya emite para
    // esta activación: umbral del diseño, caducidad del reclamo y cota del lote.
    configKey: kebabCase(activation.name)
  };
}

function collectDependencies(layers, entities, httpClients, subscriptions, errors, events, services, warnings) {
  const declared = layers.dependencies?.dependencies;
  if (!declared) return null;

  const entityByName = new Map(entities.map((entity) => [entity.name, entity]));
  const clientById = new Map((httpClients ?? []).map((client) => [client.id, client]));
  const subscriptionByEvent = new Map((subscriptions ?? []).map((sub) => [sub.name, sub]));
  const errorByCode = new Map((errors ?? []).map((error) => [error.code, error]));
  const eventByName = new Map((events ?? []).map((event) => [event.name, event]));
  const opByName = new Map();
  for (const group of services ?? []) {
    for (const operation of group.operations) opByName.set(operation.name, operation);
  }

  const result = [];
  for (const [depId, dep] of Object.entries(declared)) {
    const needs = [];
    for (const [needName, spec] of Object.entries(dep.needs ?? {})) {
      const fetch = resolveFetch(depId, needName, spec.fetchedFrom, clientById, warnings);
      const replica = spec.replica
        ? resolveReplica(depId, needName, spec.replica, entityByName, subscriptionByEvent, errorByCode, warnings)
        : null;
      const need = {
        name: needName,
        description: spec.description ?? '',
        strategy: spec.strategy,
        usedBy: spec.usedBy ?? [],
        // El campo con el que el dato viaja en la salida, si el diseño lo declara.
        // Sin él, el dato solo sirve para decidir y no sale del servicio.
        exposedAs: spec.exposedAs ?? null,
        dtoName: spec.exposedAs ? `${pascalCase(needName)}Dto` : null,
        fetch,
        // Qué ve el cliente cuando el proveedor no da el dato. Es lo que permite a
        // http-clients.js escribir el cuerpo del fallback en vez de dejar un TODO con la
        // prosa del `fallback` de la llamada, que es lo que hacía que la política la
        // eligiera quien construía.
        onUnavailable: resolveOnUnavailable(depId, needName, spec.onUnavailable, errorByCode, warnings),
        replica
      };
      // Retro-enlace hacia la llamada, hermano del de las activaciones: sin él la
      // política del need no llega al sitio donde se escribe el fallback.
      if (need.onUnavailable && fetch?.callRef) {
        (fetch.callRef.needs ??= []).push({ dependency: depId, need });
      }
      needs.push(need);
      for (const opName of need.usedBy) {
        const operation = opByName.get(opName);
        if (!operation) continue;
        (operation.dependencyNeeds ??= []).push({ dependency: depId, need });
      }
    }

    const activations = [];
    for (const [name, spec] of Object.entries(dep.activations ?? {})) {
      const via = spec.via ?? {};
      const activation = {
        name,
        description: spec.description ?? '',
        triggeredBy: spec.triggeredBy ?? [],
        effect: spec.effect ?? '',
        // El default del schema: pedir el trabajo y esperar solo el acuse.
        awaits: spec.awaits ?? 'acknowledgement',
        onFailure: resolveOnFailure(depId, name, spec.onFailure, errorByCode, warnings),
        // La pata del silencio: qué operación programada barre los encargos que
        // nunca recibieron desenlace. Sin ella, un encargo perdido no tiene final.
        reconciledBy: spec.reconciledBy ?? null,
        // Cuánto silencio de ESTE proveedor se tolera antes de volver a insistir: es lo
        // que el barrido usa para elegir candidatos. Va por activación porque un mismo
        // barrido puede reconciliar varias y cada proveedor tarda lo suyo.
        unansweredAfterSeconds: spec.unansweredAfterSeconds ?? null,
        // Y desde cuándo se cuenta ese silencio: el campo de la entidad que estampa la
        // operación que encarga. Lo declara el diseño (DSL 2.10) porque el nombre depende
        // de lo que la marca signifique —una espera o la última revalidación— y adivinarlo
        // por convención acusaba de hueco a diseños que sí la declaraban.
        awaitingSince: spec.awaitingSince ?? null,
        http: via.client ? resolveActivationCall(depId, name, via, clientById, warnings) : null,
        // Evento propio del servicio: lo emite el agregado con raise(...), no el
        // handler. Aquí solo se resuelve su clase para poder citarla en el stub.
        event: via.publishes ? (eventByName.get(via.publishes) ?? { name: via.publishes, className: null }) : null
      };
      activations.push(activation);

      for (const opName of activation.triggeredBy) {
        const operation = opByName.get(opName);
        if (!operation) continue;
        (operation.dependencyActivations ??= []).push({ dependency: depId, activation });
      }
      // La operación que reconcilia no aparece en ningún triggeredBy —no la dispara
      // un caso de uso, la dispara el reloj—, así que sin este enlace su stub sería
      // un @Scheduled vacío sin ninguna pista de qué tiene que barrer.
      if (activation.reconciledBy) {
        const sweeper = opByName.get(activation.reconciledBy);
        // Qué queda esperando: el estado en el que dejaron la entidad las
        // operaciones que encargaron el trabajo. Es por dónde empieza el barrido.
        const waitingByEntity = new Map();
        for (const opName of activation.triggeredBy ?? []) {
          for (const transition of opByName.get(opName)?.transitions ?? []) {
            if (!waitingByEntity.has(transition.entity)) waitingByEntity.set(transition.entity, new Set());
            waitingByEntity.get(transition.entity).add(transition.to);
          }
        }
        const waiting = [...waitingByEntity].flatMap(([entity, states]) =>
          [...states].map((state) => `${entity} en ${state}`)
        );
        if (sweeper) {
          (sweeper.reconciles ??= []).push({
            dependency: depId,
            activation,
            waiting,
            // El reclamo que build puede generarle, o null cuando el diseño no da lo
            // que hace falta para generarlo sin inventar nada.
            claim: reconciliationClaim({ depId, activation, sweeper, waitingByEntity, entityByName, warnings })
          });
        }
      }
      // Retro-enlace hacia la llamada: es lo que permite a http-clients.js
      // escribir el cuerpo del fallback del circuit breaker con la política que
      // el diseño ya declaró en onFailure, en vez de dejar un TODO.
      if (activation.http?.callRef) {
        (activation.http.callRef.activations ??= []).push({ dependency: depId, activation });
      }
    }

    // Compensaciones. No generan código propio —son una suscripción normal—, pero sí
    // cambian lo que el agente tiene que escribir en el handler que dispara la
    // suscripción: deshacer trabajo encargado no es aplicar un cambio más. `undoes`
    // es el único dato que dice QUÉ encargo se deshace, y con él, qué entidades movió
    // ese encargo y por tanto a qué estado hay que devolverlas. Sin llevarlo hasta el
    // stub, el agente lee un handler indistinguible de cualquier otro.
    const compensations = (dep.compensations ?? []).map((item) => {
      const sub = subscriptionByEvent.get(item.onEvent);
      const undone = item.undoes ? (activations.find((a) => a.name === item.undoes) ?? null) : null;
      // Las entidades cuyo lifecycle movieron las operaciones que encargaron el
      // trabajo: son las que la compensación tiene que devolver a su sitio.
      const moves = [
        ...new Set(
          (undone?.triggeredBy ?? [])
            .flatMap((opName) => opByName.get(opName)?.transitions ?? [])
            .map((transition) => transition.entity)
        )
      ];
      const mark = { dependency: depId, description: item.description ?? '', undoes: item.undoes ?? null, moves };
      if (sub) {
        sub.compensates = mark;
        const undoOp = sub.trigger ? opByName.get(sub.trigger) : null;
        // Hay clave de deduplicación en el listener si la declara el contrato o si la pone
        // la envoltura Keel (`metadata.eventId`): las dos alimentan el mismo
        // `processed_event`, así que las dos valen como guarda de puerta.
        const deduplicated = Boolean(sub.messageId) || sub.envelope === 'keel';
        if (undoOp) undoOp.compensates = { ...mark, event: item.onEvent, deduplicated };
      }
      return {
        event: item.onEvent,
        description: item.description ?? '',
        undoes: item.undoes ?? null,
        subscription: sub ?? null
      };
    });

    result.push({
      id: depId,
      className: pascalCase(depId),
      description: dep.description ?? '',
      contractVersion: dep.contract?.version ?? null,
      contractSource: dep.contract?.source ?? null,
      needs,
      activations,
      compensations
    });
  }
  return result;
}

function resolveFetch(depId, needName, fetchedFrom, clientById, warnings) {
  if (!fetchedFrom) return null;
  const client = clientById.get(fetchedFrom.client);
  const call = client?.calls.find((c) => c.name === fetchedFrom.call) ?? null;
  if (!call) return null;
  if (!call.method) {
    warnings.push(
      `Necesidad '${depId}.${needName}' (dependencies): la llamada '${fetchedFrom.client}.${fetchedFrom.call}' no tiene method/path estructurados; el agente debe completar la hidratación a mano.`
    );
  }
  return {
    clientId: client.id,
    clientClass: client.clientClass,
    mapperClass: client.mapperClass,
    call: call.name,
    resultType: call.resultType,
    // La forma del dato, para el DTO de `exposedAs`: sale del contrato de la llamada
    // y no se vuelve a declarar en `dependencies`. Dos declaraciones de lo mismo
    // pueden divergir, y la que manda es la del proveedor.
    responseFields: call.responseFields ?? [],
    // La llamada viva, para colgarle el retro-enlace que lee http-clients.js al
    // escribir el fallback. Igual que en resolveActivationCall, y por lo mismo.
    callRef: call
  };
}

// Canal síncrono de una activación. Mismo shape que resolveFetch más `callRef`:
// la llamada viva, para colgarle el retro-enlace que lee http-clients.js.
function resolveActivationCall(depId, name, via, clientById, warnings) {
  const client = clientById.get(via.client);
  const call = client?.calls.find((c) => c.name === via.call) ?? null;
  if (!call) {
    warnings.push(
      `Activación '${depId}.${name}' (dependencies): la llamada '${via.client}.${via.call}' no existe en http-clients; el stub del handler no podrá citarla.`
    );
    return null;
  }
  return {
    clientId: client.id,
    clientClass: client.clientClass,
    mapperClass: client.mapperClass,
    call: call.name,
    resultType: call.resultType,
    instanceName: call.instanceName,
    callRef: call
  };
}

// Política declarada para cuando el proveedor no responde. Se resuelve igual que
// `onMiss` de una réplica —misma tabla de errores, mismo status por constructor—
// porque es la misma decisión en el otro lado del acoplamiento.
function resolveOnFailure(depId, name, onFailure, errorByCode, warnings) {
  if (!onFailure) return null;
  const error = onFailure.error ? errorByCode.get(onFailure.error) : null;
  if (onFailure.error && !error) {
    warnings.push(
      `Activación '${depId}.${name}' (dependencies): el error '${onFailure.error}' de onFailure no está en el catálogo de use-cases; su clase no existe todavía.`
    );
  }
  return {
    action: onFailure.action,
    error: onFailure.error ?? null,
    exceptionClass: error?.exceptionClass ?? null,
    dynamicStatus: error?.dynamicStatus ?? false,
    httpStatus: error?.http ?? 502,
    degradedTo: onFailure.degradedTo ?? null
  };
}

// Política de indisponibilidad de un need, hermana de resolveOnFailure. La acción
// `lastKnown` es la única con mecanismo propio: un almacén del último valor leído,
// acotado por `maxAgeSeconds` — y el error es lo que pasa cuando ya no queda nada lo
// bastante fresco, no un adorno.
function resolveOnUnavailable(depId, needName, onUnavailable, errorByCode, warnings) {
  if (!onUnavailable) return null;
  const error = onUnavailable.error ? errorByCode.get(onUnavailable.error) : null;
  if (onUnavailable.error && !error) {
    warnings.push(
      `Need '${depId}.${needName}' (dependencies): el error '${onUnavailable.error}' de onUnavailable no está en el catálogo de use-cases; su clase no existe todavía.`
    );
  }
  return {
    action: onUnavailable.action,
    error: onUnavailable.error ?? null,
    exceptionClass: error?.exceptionClass ?? null,
    dynamicStatus: error?.dynamicStatus ?? false,
    httpStatus: error?.http ?? 502,
    degradedTo: onUnavailable.degradedTo ?? null,
    maxAgeSeconds: onUnavailable.maxAgeSeconds ?? null
  };
}

function resolveReplica(depId, needName, replica, entityByName, subscriptionByEvent, errorByCode, warnings) {
  const entity = entityByName.get(replica.entity);
  if (!entity) return null;
  if (!entity.persisted) {
    warnings.push(
      `Réplica '${replica.entity}' (dependencies: ${depId}.${needName}): la entidad no está persistida; sin repositorio no hay dónde materializar la copia.`
    );
    return null;
  }

  // La clave con la que el proveedor identifica el recurso es, por definición, la
  // clave natural de la copia: garantiza el finder findBy<KeyField> del repositorio.
  if (!(entity.naturalKey ?? []).includes(replica.keyField)) {
    entity.naturalKey = [replica.keyField, ...(entity.naturalKey ?? [])];
  }

  const keyField = entity.fields.find((field) => field.name === replica.keyField) ?? null;
  const fedBy = (replica.fedBy ?? []).map((event) => {
    const sub = subscriptionByEvent.get(event);
    if (sub) sub.feedsReplica = { dependency: depId, entity: entity.name, projectorClass: `${entity.name}Projector` };
    return { event, subscription: sub ?? null };
  });

  const onMissError = replica.onMiss?.error ? errorByCode.get(replica.onMiss.error) : null;
  if (replica.onMiss?.error && !onMissError) {
    warnings.push(
      `Réplica '${replica.entity}' (dependencies: ${depId}.${needName}): el error '${replica.onMiss.error}' de onMiss no está en el catálogo de use-cases; el Reader no compilará hasta declararlo.`
    );
  }

  entity.replicaOf = { dependency: depId, need: needName };

  return {
    entityName: entity.name,
    keyField: replica.keyField,
    keyGetter: `get${capitalizeName(replica.keyField)}`,
    keyFieldJavaType: keyField?.javaType ?? 'UUID',
    keyFieldImports: keyField?.imports ?? [],
    fedBy,
    freshness: replica.freshness ?? null,
    projectorClass: `${entity.name}Projector`,
    readerClass: `${entity.name}Reader`,
    repositoryPort: `${entity.name}Repository`,
    onMiss: {
      action: replica.onMiss?.action ?? 'fail',
      error: replica.onMiss?.error ?? null,
      exceptionClass: onMissError?.exceptionClass ?? null,
      dynamicStatus: onMissError?.dynamicStatus ?? false,
      httpStatus: onMissError?.http ?? 409,
      degradedTo: replica.onMiss?.degradedTo ?? null
    }
  };
}

function capitalizeName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── Suscripciones de mensajería (messaging.subscriptions → consumers) ───────

/**
 * Operaciones que sacan a la misma entidad del mismo estado de partida que `op`. Son las
 * que compiten con ella: el barrido que se rinde frente al evento que confirma, dos
 * desenlaces del mismo encargo. Devuelve los nombres, para poder citarlos.
 */
function racingOperations(op, opByName) {
  if (!op) return [];
  const origins = new Set(
    (op.transitions ?? []).flatMap((t) => (t.from ?? []).map((from) => `${t.entity}|${from}`))
  );
  if (origins.size === 0) return [];
  const racing = [];
  for (const other of opByName.values()) {
    if (other.name === op.name) continue;
    const competes = (other.transitions ?? []).some((t) =>
      (t.from ?? []).some((from) => origins.has(`${t.entity}|${from}`))
    );
    if (competes) racing.push(other.name);
  }
  return racing;
}

function collectSubscriptions(layers, services, domainTypes, inlineEnumName, warnings, stack) {
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
      // ¿Hay una guarda EN EL DOMINIO detrás de este listener? Es lo que decide el
      // orden del registro de idempotencia: con ella, procesar y luego registrar (un
      // fallo transitorio se reintenta); sin ella, la única forma de no repetir el
      // efecto es reclamar antes, al precio de perder el mensaje si el handler falla.
      //
      // Son DOS formas, no una. La transición del agregado es la evidente. La otra la trajo
      // el DSL 2.12: con `keySource: payload-field` cuyo `keyField` participa en la clave
      // natural, la constraint del agregado ES la guarda —permanente y común a todas las
      // puertas—, y `resolveIdempotency` ya la resolvió como `guard: 'natural-key'`. Mirar
      // solo las transiciones prescribía `tryRecord` sobre una operación que sí está
      // guardada, y eso no es un matiz de estilo: introduce la carrera que se quería evitar
      // —el fallo terminal marca el evento como procesado y su reintento no llega nunca al
      // descarte—, y el gate de `check-idempotency.sh`, construido desde esta misma bandera,
      // acababa cantando KO sobre el listener correcto.
      triggerHasDomainGuard:
        (triggerOp?.transitions ?? []).length > 0 || triggerOp?.idempotency?.guard === 'natural-key',
      // Cuál de las dos formas, que no es lo mismo a la hora de explicarla: el javadoc del
      // <Evento>Message tiene que nombrar la que de verdad frena la repetición.
      triggerGuardKind:
        (triggerOp?.transitions ?? []).length > 0
          ? 'transitions'
          : triggerOp?.idempotency?.guard === 'natural-key'
            ? 'natural-key'
            : null,
      // ¿Hay OTRO camino que saque a la entidad del mismo estado del que la saca este
      // listener? Si lo hay, los dos compiten y el guard del agregado arbitra: al perdedor
      // se le rechaza la transición, y eso es la carrera resuelta, no un fallo. Importa
      // decirlo porque tratarlo como error manda a la DLQ un mensaje perfectamente válido.
      // Se precomputa aquí —y no en el javadoc— porque contractJavadoc solo recibe `sub`.
      triggerRaces: racingOperations(triggerOp, opByName),
      // Cómo se construye el mensaje CQRS desde el payload: componente del
      // command → campo del payload que lo alimenta (null = el agente decide).
      triggerArguments: triggerArguments(def, triggerOp, fields),
      messageRecord: `${pascalCase(name)}Message`,
      listenerClass: `${pascalCase(name)}Listener`,
      topicProperty: `messaging.subscriptions.${kebabCase(name)}.topic`,
      // Nombre físico de la cola/topic de origen: saneado para el broker, igual
      // que los destinos de publicación (naming.js § brokerSafeName).
      topicDefault: brokerSafeName(
        `${def.source ? kebabCase(def.source) : kebabCase(name)}.events`,
        stack?.broker
      ),
      // Contrato de recepción: sin él se asume la envoltura de Keel salvo que el
      // canal sea ajeno, donde el mensaje llega plano.
      envelope: contract.envelope ?? (external ? 'none' : 'keel'),
      payloadPath: contract.payloadPath ?? null,
      format: contract.format ?? 'json',
      schemaRef: contract.schemaRef ?? null,
      discriminator: contract.discriminator ?? null,
      messageId: contract.messageId ?? null,
      unknownFields: contract.unknownFields ?? 'ignore',
      // De dónde sale la identidad de quien pide el trabajo cuando el camino es un
      // broker y no llega ningún token. El dato lo declara y lo valida el DSL, pero
      // si no llega hasta aquí no lo conoce nadie: ni el javadoc del listener, que es
      // donde el agente lee qué resolver, ni el arnés, que es quien tiene que poder
      // variarlo para escribir dos inquilinos distintos.
      identity: def.identity ?? null,
      identityDelivery: identityDelivery(name, def.identity, contract, external, warnings),
      envelopeRecord: contract.envelope === 'wrapped' ? `${pascalCase(name)}Envelope` : null,
      fields,
      retry: def.onFailure?.retry ?? null,
      deadLetter: Boolean(def.onFailure?.deadLetter)
    };
  });
}

/**
 * Dónde tiene que escribir el arnés la identidad del emisor para que el consumidor la
 * lea por donde el contrato dice que viaja. No es una preferencia de estilo: si el
 * escenario no puede variar ese valor, todos los mensajes que entrega pertenecen al
 * mismo inquilino y el flujo multi-aplicación no es escribible.
 *
 * Devuelve null cuando el contrato no deja ningún hueco donde ponerla, avisando: el
 * caso existe (`envelope: none` es el mensaje pelado) y callarlo dejaría al diseñador
 * creyendo que su escenario discrimina emisores cuando no puede.
 */
function identityDelivery(name, identity, contract, external, warnings) {
  if (!identity?.from) return null;
  const { location, name: path } = identity.from;
  const envelope = contract.envelope ?? (external ? 'none' : 'keel');

  // Cabecera: la estampa el broker y el arnés la añade al mapa que ya compone.
  // Es la única opción que no depende de cómo se envuelva el payload.
  if (location === 'header') return { placement: 'header', name: path };

  if (envelope === 'keel') {
    // La envoltura Keel solo tiene dos ramas, y `data` la aporta el escenario en su
    // payload: lo colocable aquí es `metadata.<algo>`.
    const key = path.startsWith('metadata.') ? path.slice('metadata.'.length) : null;
    if (key && !key.includes('.')) return { placement: 'metadata', name: key };
    warnings.push(
      `Suscripción ${name}: identity.from.name '${path}' no es un campo de metadata de la envoltura Keel, así que el arnés no puede variarlo. Decláralo como 'metadata.<campo>' o como location: header.`
    );
    return null;
  }

  if (envelope === 'wrapped') {
    if (!path.includes('.')) return { placement: 'envelopeField', name: path };
    warnings.push(
      `Suscripción ${name}: identity.from.name '${path}' está anidado y el arnés solo compone campos del primer nivel de la envoltura. Aplánalo o decláralo como location: header.`
    );
    return null;
  }

  warnings.push(
    `Suscripción ${name}: con envelope 'none' el mensaje ES el payload y no hay dónde poner la identidad, que el DSL prohíbe llevar en el payload. Los escenarios de esta suscripción no podrán variar el emisor: decláralo como location: header.`
  );
  return null;
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
function payloadFields(opName, payload, { direction, domainEntities, domainTypes, inlineEnumName, relations: relationCtx = null, warnings = [] }) {
  if (!payload || payload === 'void') return [];

  if (payload.fields) {
    return Object.entries(payload.fields).map(([fieldName, field]) =>
      asPayloadField(
        resolveField(pascalCase(opName), fieldName, field, domainTypes, inlineEnumName, { persisted: false }),
        direction
      )
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

  // El campo de estado del `lifecycle` NO entra en una entrada derivada, aunque no esté
  // marcado `generated`: quien lo mueve es la máquina de estados que el propio dominio
  // declara —`createProduct` lo pone en su `default`, `retireProduct` lo mueve por su
  // `transitions`—, nunca el cliente. Colarlo en el DTO no era ruido inofensivo: con
  // `required: true` en el dominio, el DTO salía con `@NotNull` y el camino feliz de la
  // creación respondía 400 hasta que el agente lo quitaba a mano. Dos generaciones
  // seguidas lo reportaron y lo corrigieron igual, que es la señal de que le toca a build.
  // Una operación que SÍ quiera recibir el estado lo declara en `input.fields`, y ese
  // camino no pasa por aquí.
  const lifecycleField = direction === 'input' ? entity.lifecycle?.field : null;

  const fields = [];
  const defaulted = [];
  for (const [fieldName, field] of Object.entries(entity.fields ?? {})) {
    if (exclude.has(fieldName)) continue;
    if (direction === 'input' && (field.id || field.generated || field.computed)) continue;
    if (fieldName === lifecycleField) continue;
    if (direction === 'output' && field.sensitive) continue;
    // Lo que no se puede decidir mecánicamente: un campo con `default` puede ser una
    // preferencia que el cliente sobreescribe (`currency: EUR`) o estado interno que
    // decide el dominio (un contador de intentos). Build no lo adivina —lo pone en la
    // entrada, que es lo que dice el diseño— pero lo enumera: si el diseñador quería lo
    // segundo, la respuesta está en el DSL (`input.exclude`) y no en el código.
    if (direction === 'input' && field.default !== undefined) defaulted.push(fieldName);
    fields.push(asPayloadField(resolveField(payload.entity, fieldName, field, domainTypes, inlineEnumName, { persisted: false }), direction));
  }
  if (defaulted.length > 0) {
    warnings.push(
      `Operación '${opName}': la entrada derivada de '${payload.entity}' incluye ${defaulted.map((name) => `'${name}'`).join(', ')}, ` +
        `con 'default' declarado en domain. El cliente puede mandarlos y sobreescribir el valor del dominio; si son estado interno, ` +
        `sácalos con 'input.exclude' en use-cases.keel.yaml en vez de dejar que el handler los ignore.`
    );
  }

  // Las relaciones son parte del recurso, no un detalle de persistencia: una
  // referencia a otro agregado se proyecta como su id y una entidad hija como su
  // propio DTO. Omitirlas por defecto dejaba payloads incompletos (sin categoryId,
  // sin images) sin que el diseño hubiera declarado ningún exclude.
  fields.push(
    ...relationPayloadFields(opName, payload, entity, { direction, relations: relationCtx, exclude, warnings })
  );
  return fields;
}

// Proyección de las relaciones de la entidad sobre el payload.
function relationPayloadFields(opName, payload, entity, { direction, relations: relationCtx, exclude, warnings }) {
  if (!relationCtx) return [];
  const { internalOf, hasPersistence } = relationCtx;
  const embed = new Set(payload.embed ?? []);
  const projected = [];

  for (const [relName, rel] of Object.entries(entity.relations ?? {})) {
    if (exclude.has(relName)) continue;
    const { kind, backReference } = classifyRelation(payload.entity, rel, internalOf, hasPersistence);
    if (kind === 'unsupported') continue;
    if (backReference) {
      // Apuntar al padre no se proyecta como objeto —eso encadenaría hija → raíz → hijas
      // y devolvería el agregado entero dos veces—, pero SU ID sí es parte del recurso.
      // Una entidad hija se proyecta de dos formas y las dos pasan por aquí: anidada en el
      // payload de su raíz, y SUELTA cuando una operación la declara como su `output`
      // (`output: { entity: <Hija> }`). En el segundo caso, un DTO sin el id del padre no
      // dice a qué padre pertenece y el consumidor no tiene forma de recomponerlo; en el
      // primero es una redundancia inofensiva, y es el mismo record en los dos sitios.
      // No entra en el input: quien crea la hija ya nombra al padre en la ruta.
      if (direction !== 'output') continue;
      const parentId = `${relName}Id`;
      if (exclude.has(parentId)) continue;
      projected.push(
        relationField({
          name: parentId,
          javaType: 'UUID',
          imports: ['java.util.UUID'],
          // `parentId` y no `base`: el mapper no puede derivarlo de la entidad —el dominio
          // es puro y una hija no guarda un puntero a su raíz, la FK vive en persistencia—,
          // así que entra como PARÁMETRO del método, igual que un `refDto`. Es lo que hace
          // que el compilador no deje olvidarlo en vez de dejar un TODO que sale a null.
          kind: 'parentId',
          base: 'uuid',
          parentEntity: rel.entity,
          required: Boolean(rel.required),
          description: rel.description
        })
      );
      continue;
    }

    if (kind === 'external') {
      // embed: el diseño pide el objeto anidado en vez del id (p. ej. 'category'
      // en vez de 'categoryId'). Es su propio DTO de referencia, sin relaciones,
      // para que la proyección no encadene agregado tras agregado.
      if (embed.has(relName) && direction === 'output') {
        const dtoName = `${rel.entity}RefDto`;
        projected.push(
          relationField({
            name: relName,
            javaType: dtoName,
            elementJavaType: dtoName,
            imports: [],
            kind: 'refDto',
            refEntity: rel.entity,
            required: Boolean(rel.required),
            description: rel.description
          })
        );
        continue;
      }
      const name = `${relName}Id`;
      if (exclude.has(name)) continue;
      projected.push(relationField({ name, javaType: 'UUID', imports: ['java.util.UUID'], kind: 'base', base: 'uuid', required: Boolean(rel.required), description: rel.description }));
      continue;
    }

    // Entidad hija del agregado.
    const toMany = rel.cardinality === 'one-to-many' || rel.cardinality === 'many-to-many';
    if (direction === 'input') {
      warnings.push(
        `Operación '${opName}': la entidad hija ${rel.entity} (${relName}) no entra en el input; si el flujo la recibe anidada, el agente debe modelarla (conventions/mapping.md).`
      );
      continue;
    }
    const dtoName = `${rel.entity}Dto`;
    projected.push(
      relationField({
        name: relName,
        javaType: toMany ? `List<${dtoName}>` : dtoName,
        elementJavaType: dtoName,
        imports: toMany ? ['java.util.List'] : [],
        kind: 'childDto',
        childEntity: rel.entity,
        list: toMany,
        required: Boolean(rel.required),
        description: rel.description
      })
    );
  }
  return projected;
}

// Campo de payload derivado de una relación, con la misma forma que los campos
// resueltos por resolveField (todo render interpola estas propiedades).
function relationField({ name, javaType, elementJavaType = null, imports = [], kind, base = null, childEntity = null, refEntity = null, parentEntity = null, list = false, required = false, description = null }) {
  return {
    name,
    javaType,
    imports,
    list,
    elementJavaType: elementJavaType ?? javaType,
    kind,
    base,
    bucket: null,
    childEntity,
    refEntity,
    parentEntity,
    isId: false,
    required,
    unique: false,
    generated: false,
    computed: null,
    sensitive: false,
    wireName: null,
    description: description ?? null,
    validation: [],
    columns: [],
    initializer: null
  };
}

// Ajuste de un campo resuelto al entrar en un payload. Un campo `file` en la
// entrada es una subida binaria, no una cadena: el mensaje lo transporta como
// FileUpload y el endpoint se expone multipart. En la salida sigue siendo la
// clave del objeto en su bucket (String), que es lo que guarda el dominio.
function asPayloadField(field, direction) {
  if (direction !== 'input' || field.base !== 'file' || field.list) return field;
  return {
    ...field,
    javaType: 'FileUpload',
    elementJavaType: 'FileUpload',
    imports: [],
    kind: 'fileUpload',
    file: true,
    // @NotBlank es de String: sobre un record component FileUpload reventaría en
    // runtime. Hay que corregir las DOS listas: el DTO de entrada se anota desde
    // `validation` y el command desde `inputValidation` (services.js), así que
    // arreglar solo una deja la anotación inválida en el otro lado.
    validation: field.required ? ['@NotNull'] : [],
    inputValidation: field.required ? ['@NotNull'] : []
  };
}

// Mensaje del dot-path de exclude que el scaffolding no puede aplicar sobre su DTO plano:
// dice qué falta y quién lo completa, para que el hueco sea visible en la salida de build.
function nestedExcludeWarning(opName, entityName, path, entity, domainTypes) {
  const [head, ...rest] = path.split('.');
  const nested = rest.join('.');
  const prefix = `Operación '${opName}': exclude '${path}' de ${entityName}`;

  if (entity.relations?.[head]) {
    return `${prefix}: el DTO anidado de la relación '${head}' se genera completo — el agente debe quitarle '${nested}' (conventions/mapping.md).`;
  }
  const type = entity.fields?.[head]?.type;
  if (type && domainTypes?.[type]?.fields) {
    return `${prefix}: el value object '${type}' sale entero en el DTO — el agente debe recortar '${nested}' al escribir el DTO de respuesta (conventions/mapping.md).`;
  }
  return `${prefix}: build no puede aplicarlo a su DTO plano — revísalo al escribir el DTO de respuesta (conventions/mapping.md).`;
}

// Parámetros de ruta de una operación, en orden de aparición en el path. Cada
// {segmento} se resuelve contra el input del diseño para heredar su tipo; si no
// hay campo homónimo se asume el id del agregado (UUID) y se avisa, porque el
// contrato HTTP queda a medias sin él.
function resolvePathParams(opName, route, inputFields, warnings) {
  if (!route) return [];
  const names = [...String(route.path).matchAll(/\{(\w+)\}/g)].map((match) => match[1]);

  return names.map((name) => {
    const field = inputFields.find((f) => f.name === name);
    if (field) return { ...field, fromPath: true };
    if (name !== 'id') {
      warnings.push(
        `Operación '${opName}': la ruta ${route.path} declara {${name}} pero el input no tiene ese campo; se expone como @PathVariable UUID ${name}. Declara el campo en use-cases.keel.yaml o renombra el segmento.`
      );
    }
    return {
      name,
      javaType: 'UUID',
      imports: ['java.util.UUID'],
      list: false,
      elementJavaType: 'UUID',
      kind: 'base',
      base: 'uuid',
      isId: name === 'id',
      required: true,
      validation: [],
      columns: [],
      initializer: null,
      fromPath: true
    };
  });
}

// Ruta de una operación: endpoint explícito > convención CRUD (auto) > fallback POST.
//
// `schedule` NO entra en esta guarda, y la diferencia costó cuatro escenarios en una corrida.
// Un barrido puede tener DOS disparadores —el reloj y una llamada manual—, y el diseño lo dice
// declarando las dos cosas: `schedule` en use-cases y su entrada en `api.endpoints`, con su regla
// de acceso. Descartar la ruta por tener `schedule` dejaba la operación sin controller, la
// petición caía en el patrón hermano (`GET /messages/{id}` para un `POST /messages/purge`) y
// respondía 405 — con el agravante de que build no avisaba de nada, así que el agente de código
// acababa escribiendo el mapping a mano y el siguiente `build --force` se lo llevaba por delante.
// Lo que sí sigue sin exponerse es el barrido que NO declara endpoint: ver más abajo.
/**
 * La política de idempotencia de una operación, con su guarda ya resuelta.
 *
 * `guard` es `natural-key` cuando la clave es un campo del input que participa en la clave natural
 * de la entidad que la operación escribe: ahí la constraint de la base es la guarda, cubre todas
 * las puertas por igual y no caduca. En cualquier otro caso es `store`, y el generador emite el
 * registro de claves.
 */
function resolveIdempotency(op, targetEntity, layers) {
  const idempotency = op.idempotency ?? null;
  if (!idempotency) return null;
  if (idempotency.keySource !== 'payload-field') return { ...idempotency, guard: 'store' };

  const naturalKey = layers?.persistence?.entities?.[targetEntity]?.naturalKey ?? [];
  const guard = naturalKey.includes(idempotency.keyField) ? 'natural-key' : 'store';
  // La entidad viaja con la política: quien la consume (el gate) necesita resolver el finder de
  // la clave natural, y la operación no lleva su entidad objetivo por ningún otro sitio.
  return {
    ...idempotency,
    guard,
    entity: guard === 'natural-key' ? targetEntity : null,
    naturalKey: guard === 'natural-key' ? naturalKey : null
  };
}

function resolveRoute(opName, op, api, targetEntity, warnings) {
  if (op.internal || !api) return null;

  // Público del endpoint (users | services | both): el propio, el default de la
  // capa api o users. Decide en qué SecurityFilterChain cae la ruta cuando el
  // diseño valida la audiencia de los tokens M2M (ver collectSecurity).
  const defaultAudience = api.defaultAudience ?? 'users';

  const explicit = api.endpoints?.[opName];
  if (explicit) {
    if (explicit.method === 'POST' && explicit.successStatus == null) {
      warnings.push(
        `Operación '${opName}': endpoint POST sin successStatus; se asume ${defaultStatus('POST', opName)}. Decláralo en api.keel.yaml si el contrato es otro.`
      );
    }
    return {
      method: explicit.method,
      path: explicit.path,
      status: explicit.successStatus ?? defaultStatus(explicit.method, opName),
      audience: explicit.audience ?? defaultAudience
    };
  }
  // Sin endpoint declarado, un barrido no se expone: su disparador es el reloj y nadie ha decidido
  // que además tenga puerta. Inferirle una por convención CRUD —o peor, por el fallback POST— le
  // abriría al mundo una operación que el diseño no publicó, y rompería la doctrina que sostienen
  // el aviso de `crossrefs.js` sobre el schedule sin efecto declarado y § Lo que no tiene escenario
  // de validation-scenarios.md, que dan por hecho que un barrido no se alcanza desde fuera.
  if (op.schedule || !api.auto) return null;

  const prefix = CRUD_PREFIXES.find((p) => opName.startsWith(p) && opName.length > p.length);
  if (prefix) {
    const rest = opName.slice(prefix.length);
    const collection = `/${kebabCase(prefix === 'list' ? rest : pluralize(rest))}`;
    switch (prefix) {
      case 'create':
        return { method: 'POST', path: collection, status: 201, audience: defaultAudience };
      case 'list':
        return { method: 'GET', path: collection, status: 200, audience: defaultAudience };
      case 'get':
        return { method: 'GET', path: `${collection}/{id}`, status: 200, audience: defaultAudience };
      case 'update':
        return { method: 'PUT', path: `${collection}/{id}`, status: 200, audience: defaultAudience };
      case 'delete':
        return { method: 'DELETE', path: `${collection}/{id}`, status: 204, audience: defaultAudience };
    }
  }

  warnings.push(`Operación '${opName}' sin endpoint explícito ni patrón CRUD: se expone como POST /${kebabCase(opName)} (revísala).`);
  return { method: 'POST', path: `/${kebabCase(opName)}`, status: 200, fallback: true, audience: defaultAudience };
}

// 201 solo cuando la operación crea un recurso nuevo. Un POST de transición de
// estado (/products/{id}/retire) o de consulta en lote responde 200: asumir 201
// por el verbo rompe el contrato declarado en los escenarios de validación.
function defaultStatus(method, opName = '') {
  if (method === 'POST') return opName.startsWith('create') ? 201 : 200;
  if (method === 'DELETE') return 204;
  return 200;
}
