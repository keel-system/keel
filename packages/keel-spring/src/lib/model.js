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
    storage: Boolean(layers.storage)
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
  const httpClients = collectHttpClients(layers, domainTypes, inlineEnumName, warnings);
  const storage = collectStorage(layers);

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

  return { service, layersPresent, persistenceKind, enums, valueObjects, entities, services, errors, childDtos, refDtos, hasFileUploads, events, messaging, subscriptions, pagination, api, audit, security, httpClients, dependencies, storage, warnings };
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
    // type, que solo se cumple después de normalizar (ver type-mapper.js).
    inputValidation: beanValidationAnnotations(field, resolved, { inheritTypeFormat: false }),
    // Una colección no es una columna: su mapeo (@ElementCollection) lo pone la Jpa,
    // no columnAnnotations. Sin persistence o sin list, comportamiento previo.
    columns: persisted && !isList ? columnAnnotations(fieldName, field, resolved) : [],
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
// - internal: entidad hija del mismo agregado (con backReference si apunta a la raíz)
// - external: otro agregado, representado por su id
// - unsupported: colección hacia otro agregado, que el scaffolding no modela
function classifyRelation(entityName, rel, internalOf, hasPersistence) {
  const targetInternal = internalOf.get(rel.entity);
  const sameAggregate =
    (targetInternal && (targetInternal.root === entityName || internalOf.get(entityName)?.aggregate === targetInternal.aggregate)) ||
    internalOf.get(entityName)?.root === rel.entity;

  if (sameAggregate || !hasPersistence) {
    const backReference =
      internalOf.get(entityName)?.root === rel.entity &&
      (rel.cardinality === 'many-to-one' || rel.cardinality === 'one-to-one');
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
      indexes: persistenceMeta.indexes ?? []
    });
  }

  addImplicitAggregateRelations(entities, aggregates, warnings);
  warnMappingCycles(entities, warnings);
  return entities;
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
      // ella. La back-reference de la propia hija hacia la raíz no cuenta: es el
      // lado dueño de la FK, no la colección que el agregado necesita para
      // gobernar sus hijas.
      const reachable = members.some(
        (member) => member !== inner && (byName.get(member)?.relations ?? []).some((rel) => rel.entity === inner)
      );
      if (reachable) continue;

      const relName = camelCase(pluralize(inner));
      root.relations.push({
        name: relName,
        entity: inner,
        cardinality: 'one-to-many',
        required: false,
        internal: true,
        implicit: true
      });
      warnings.push(
        `Agregado ${aggName}: la entidad interna ${inner} no tiene relación declarada con ${agg.root}; se deriva ${agg.root}.${relName} (one-to-many). Decláralas en domain.entities.${agg.root}.relations si el nombre o la cardinalidad deben ser otros.`
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
    const bodyFields = inputFields.filter((f) => !pathParamNames.has(f.name));
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
      idempotency: op.idempotency ?? null,
      // Las transiciones del lifecycle que esta operación ejecuta (DSL 2.6). Aquí se
      // usan para el ORDEN de los efectos en el stub del handler; el TODO del método
      // semántico dentro del agregado lo cablea attachTransitionExecutors.
      transitions: op.transitions ?? [],
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

  return { services: [...groups.values()], errors: resolveErrorStatuses([...errorsByCode.values()], warnings) };
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
        fetch,
        replica
      };
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
        const waiting = [
          ...new Set(
            (activation.triggeredBy ?? [])
              .flatMap((opName) => opByName.get(opName)?.transitions ?? [])
              .map((transition) => `${transition.entity} en ${transition.to}`)
          )
        ];
        if (sweeper) (sweeper.reconciles ??= []).push({ dependency: depId, activation, waiting });
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
        if (undoOp) undoOp.compensates = { ...mark, event: item.onEvent, deduplicated: Boolean(sub.messageId) };
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
    resultType: call.resultType
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
      triggerHasDomainGuard: (triggerOp?.transitions ?? []).length > 0,
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

  const fields = [];
  for (const [fieldName, field] of Object.entries(entity.fields ?? {})) {
    if (exclude.has(fieldName)) continue;
    if (direction === 'input' && (field.id || field.generated || field.computed)) continue;
    if (direction === 'output' && field.sensitive) continue;
    fields.push(asPayloadField(resolveField(payload.entity, fieldName, field, domainTypes, inlineEnumName, { persisted: false }), direction));
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
    if (kind === 'unsupported' || backReference) continue;

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
function relationField({ name, javaType, elementJavaType = null, imports = [], kind, base = null, childEntity = null, refEntity = null, list = false, required = false, description = null }) {
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
    // @NotBlank es de String: sobre un record component FileUpload reventaría en runtime.
    validation: field.required ? ['@NotNull'] : []
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
function resolveRoute(opName, op, api, targetEntity, warnings) {
  if (op.internal || op.schedule || !api) return null;

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
  if (!api.auto) return null;

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
