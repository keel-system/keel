const BASE_TYPES = new Set(['string', 'text', 'int', 'long', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'json', 'file']);

/**
 * Validación mecánica de referencias cruzadas entre capas.
 * Recibe { layers } (ya validadas contra sus schemas) y devuelve { errors, warnings, pending }.
 * Con wip: true, las referencias hacia delante a una capa messaging aún no diseñada
 * (emits, cache.invalidatedBy) van a pending (diseño en progreso), no a errors.
 * La calidad semántica (invariantes ambiguas, mínimo privilegio...) es de la skill /keel-validate.
 */
export function checkCrossRefs({ layers, wip = false }) {
  const errors = [];
  const warnings = [];
  const pending = [];

  const domain = layers['domain'] ?? {};
  const useCases = layers['use-cases'] ?? {};
  const api = layers['api'];
  const security = layers['security'];
  const messaging = layers['messaging'];
  const persistence = layers['persistence'];
  const storage = layers['storage'];

  const types = new Set(Object.keys(domain.types ?? {}));
  const entities = new Set(Object.keys(domain.entities ?? {}));
  const operations = useCases.operations ?? {};
  const operationNames = new Set(Object.keys(operations));
  const publishedEvents = new Set(Object.keys(messaging?.publishing?.events ?? {}));
  const consumedEvents = new Set(Object.keys(messaging?.subscriptions ?? {}));
  const roles = new Set(Object.keys(security?.roles ?? {}));
  const permissions = new Set(Object.keys(security?.permissions ?? {}));
  const buckets = new Set(Object.keys(storage?.buckets ?? {}));
  const referencedBuckets = new Set(); // buckets citados por algún campo file (para detectar huérfanos)
  const channels = new Set(Object.keys(messaging?.channels ?? {}));
  const referencedChannels = new Set(); // canales citados por eventos/suscripciones (para detectar huérfanos)

  const checkFieldMap = (fieldMap, where) => {
    for (const [name, field] of Object.entries(fieldMap ?? {})) {
      const type = field?.type;
      if (typeof type === 'string' && /^[A-Z]/.test(type) && !types.has(type)) {
        errors.push(`${where}.${name}: el tipo '${type}' no existe en domain: types`);
      }
      // Campo file: su bucket debe existir en la capa storage (que se diseña al final).
      if (type === 'file' && field?.bucket) {
        referencedBuckets.add(field.bucket);
        if (!buckets.has(field.bucket)) {
          if (!storage && wip) {
            pending.push(`${where}.${name}: el bucket '${field.bucket}' está pendiente de definir en storage`);
          } else {
            errors.push(
              `${where}.${name}: el bucket '${field.bucket}' no está en storage: buckets` +
                (storage ? '' : ' (no hay capa storage)')
            );
          }
        }
      }
    }
  };

  // Valores de un campo enum: inline (values) o vía enum nominal declarado en types.
  const enumValuesOf = (field) => {
    if (!field) return null;
    if (field.type === 'enum') return field.values ?? null;
    const named = domain.types?.[field.type];
    return Array.isArray(named?.values) ? named.values : null;
  };

  const checkPayload = (payload, where) => {
    if (!payload || payload === 'void') return;
    if (payload.entity && !entities.has(payload.entity)) {
      errors.push(`${where}: la entidad '${payload.entity}' no existe en domain: entities`);
    }
    if (payload.entity && entities.has(payload.entity)) {
      const entity = domain.entities[payload.entity];
      for (const name of payload.exclude ?? []) {
        if (!(name in (entity.fields ?? {})) && !(name in (entity.relations ?? {}))) {
          errors.push(`${where}.exclude: el campo '${name}' no existe en la entidad '${payload.entity}'`);
        }
      }
    }
    if (payload.fields) checkFieldMap(payload.fields, where);
  };

  // domain: campos internos de value objects compuestos
  for (const [typeName, typeDef] of Object.entries(domain.types ?? {})) {
    if (typeDef?.fields) checkFieldMap(typeDef.fields, `domain: types.${typeName}.fields`);
  }

  // domain: tipos en fields, entidades en relations y lifecycle
  for (const [entityName, entity] of Object.entries(domain.entities ?? {})) {
    checkFieldMap(entity.fields, `domain: ${entityName}.fields`);
    for (const [relName, rel] of Object.entries(entity.relations ?? {})) {
      if (!entities.has(rel.entity)) {
        errors.push(`domain: ${entityName}.relations.${relName}: la entidad '${rel.entity}' no existe`);
      }
    }
    if (entity.lifecycle) {
      const where = `domain: ${entityName}.lifecycle`;
      const stateField = entity.fields?.[entity.lifecycle.field];
      if (!stateField) {
        errors.push(`${where}: el campo '${entity.lifecycle.field}' no existe en la entidad`);
      } else {
        const values = enumValuesOf(stateField);
        if (!values) {
          errors.push(`${where}: el campo '${entity.lifecycle.field}' no es un enum (inline o nominal)`);
        } else {
          const valueSet = new Set(values);
          for (const [from, targets] of Object.entries(entity.lifecycle.transitions ?? {})) {
            if (!valueSet.has(from)) {
              errors.push(`${where}.transitions: el estado '${from}' no es un valor del enum`);
            }
            for (const to of targets ?? []) {
              if (!valueSet.has(to)) {
                errors.push(`${where}.transitions.${from}: el estado destino '${to}' no es un valor del enum`);
              }
            }
          }
          for (const value of values) {
            if (!(value in (entity.lifecycle.transitions ?? {}))) {
              warnings.push(`${where}.transitions: el estado '${value}' no declara transiciones (¿terminal? decláralo con [])`);
            }
          }
        }
      }
    }
  }

  // domain: agregados — raíz y miembros existen, pertenencia sin solapes
  const aggregates = domain.aggregates ?? {};
  const aggregateOf = new Map(); // entidad → nombre del agregado al que pertenece
  for (const [aggName, agg] of Object.entries(aggregates)) {
    const where = `domain: aggregates.${aggName}`;
    if (!entities.has(agg.root)) {
      errors.push(`${where}.root: la entidad '${agg.root}' no existe en domain: entities`);
    }
    const members = [agg.root, ...(agg.entities ?? [])];
    if ((agg.entities ?? []).includes(agg.root)) {
      errors.push(`${where}.entities: la raíz '${agg.root}' es miembro implícito, no se repite como entidad interna`);
    }
    for (const member of members) {
      if (member !== agg.root && !entities.has(member)) {
        errors.push(`${where}.entities: la entidad '${member}' no existe en domain: entities`);
      }
      if (aggregateOf.has(member) && aggregateOf.get(member) !== aggName) {
        errors.push(
          `domain: aggregates: la entidad '${member}' pertenece a más de un agregado ('${aggregateOf.get(member)}' y '${aggName}')`
        );
      } else {
        aggregateOf.set(member, aggName);
      }
    }
  }
  if (Object.keys(aggregates).length > 0) {
    const roots = new Set(Object.values(aggregates).map((agg) => agg.root));
    for (const entityName of entities) {
      if (!aggregateOf.has(entityName)) {
        warnings.push(
          `domain: la entidad '${entityName}' no pertenece a ningún agregado (¿es un agregado propio de una sola entidad?)`
        );
      }
    }
    // referencias hacia entidades internas de otro agregado: deberían apuntar a la raíz (por id)
    for (const [entityName, entity] of Object.entries(domain.entities ?? {})) {
      for (const [relName, rel] of Object.entries(entity.relations ?? {})) {
        const targetAgg = aggregateOf.get(rel.entity);
        if (
          targetAgg !== undefined &&
          !roots.has(rel.entity) &&
          aggregateOf.get(entityName) !== targetAgg
        ) {
          warnings.push(
            `domain: ${entityName}.relations.${relName}: apunta a '${rel.entity}', entidad interna del agregado '${targetAgg}' — referencia la raíz '${aggregates[targetAgg].root}' por id`
          );
        }
      }
    }
  }

  // use-cases: payloads, emits, cache
  for (const [opName, op] of Object.entries(operations)) {
    checkPayload(op.input, `use-cases: ${opName}.input`);
    checkPayload(op.output, `use-cases: ${opName}.output`);
    for (const event of op.emits ?? []) {
      if (!publishedEvents.has(event)) {
        if (!messaging && wip) {
          pending.push(`use-cases: ${opName}.emits: el evento '${event}' está pendiente de definir en messaging`);
        } else {
          errors.push(
            `use-cases: ${opName}.emits: el evento '${event}' no está en messaging: publishing.events` +
              (messaging ? '' : ' (no hay capa messaging)')
          );
        }
      }
    }
    for (const event of op.cache?.invalidatedBy ?? []) {
      if (!publishedEvents.has(event) && !consumedEvents.has(event)) {
        if (!messaging && wip) {
          pending.push(
            `use-cases: ${opName}.cache.invalidatedBy: el evento '${event}' está pendiente de definir en messaging`
          );
        } else {
          errors.push(`use-cases: ${opName}.cache.invalidatedBy: el evento '${event}' no existe en messaging`);
        }
      }
    }
    if (op.cache && op.kind !== 'query') {
      warnings.push(`use-cases: ${opName}: tiene cache pero no es kind: query`);
    }
  }

  // api: endpoints → operaciones
  for (const opName of Object.keys(api?.endpoints ?? {})) {
    if (!operationNames.has(opName)) {
      errors.push(`api: endpoints.${opName}: la operación no existe en use-cases`);
    }
  }

  // security: reglas → operaciones, roles y permisos → catálogos
  if (security) {
    const checkAccessRule = (rule, where) => {
      for (const role of rule?.roles ?? []) {
        if (!roles.has(role)) errors.push(`${where}: el rol '${role}' no existe en security: roles`);
      }
      for (const perm of rule?.permissions ?? []) {
        if (!permissions.has(perm)) errors.push(`${where}: el permiso '${perm}' no existe en security: permissions`);
      }
    };
    checkAccessRule(security.access?.default, 'security: access.default');
    for (const [opName, rule] of Object.entries(security.access?.rules ?? {})) {
      if (!operationNames.has(opName)) {
        errors.push(`security: access.rules.${opName}: la operación no existe en use-cases`);
      }
      checkAccessRule(rule, `security: access.rules.${opName}`);
    }
    for (const [role, grants] of Object.entries(security.roleGrants ?? {})) {
      if (!roles.has(role)) errors.push(`security: roleGrants.${role}: el rol no existe en security: roles`);
      for (const perm of grants ?? []) {
        if (!permissions.has(perm)) {
          errors.push(`security: roleGrants.${role}: el permiso '${perm}' no existe en security: permissions`);
        }
      }
    }
  }

  // messaging: canales, payloads y triggers
  const checkChannel = (channel, where) => {
    if (!channel) return;
    referencedChannels.add(channel);
    if (!channels.has(channel)) {
      errors.push(`${where}: el canal '${channel}' no está en messaging: channels`);
    }
  };
  for (const [eventName, event] of Object.entries(messaging?.publishing?.events ?? {})) {
    checkFieldMap(event.payload, `messaging: publishing.events.${eventName}.payload`);
    checkChannel(event.channel, `messaging: publishing.events.${eventName}.channel`);
  }
  for (const [eventName, sub] of Object.entries(messaging?.subscriptions ?? {})) {
    checkFieldMap(sub.payload, `messaging: subscriptions.${eventName}.payload`);
    checkChannel(sub.channel, `messaging: subscriptions.${eventName}.channel`);
    if (!operationNames.has(sub.triggers)) {
      errors.push(`messaging: subscriptions.${eventName}.triggers: la operación '${sub.triggers}' no existe en use-cases`);
    }
  }

  // persistence: entidades → domain
  for (const entityName of Object.keys(persistence?.entities ?? {})) {
    if (!entities.has(entityName)) {
      errors.push(`persistence: entities.${entityName}: la entidad no existe en domain: entities`);
    }
  }
  if (
    persistence?.consistency?.transactionalBoundary === 'per-aggregate' &&
    Object.keys(aggregates).length === 0
  ) {
    // persistence se diseña después de domain: error también con --wip
    errors.push(
      `persistence: consistency.transactionalBoundary: 'per-aggregate' exige que domain declare aggregates`
    );
  }

  // storage: buckets declarados pero sin ningún campo file que los referencie
  for (const bucketName of buckets) {
    if (!referencedBuckets.has(bucketName)) {
      warnings.push(
        `storage: buckets.${bucketName}: bucket declarado pero sin ningún campo file que lo referencie`
      );
    }
  }

  // messaging: canales declarados pero sin ningún evento/suscripción que los referencie
  for (const channelName of channels) {
    if (!referencedChannels.has(channelName)) {
      warnings.push(
        `messaging: channels.${channelName}: canal declarado pero sin ningún evento o suscripción que lo referencie`
      );
    }
  }

  // warnings de cobertura
  if (api && !security) {
    warnings.push('Hay capa api pero no capa security: todos los endpoints quedarían sin regla de acceso explícita');
  }

  const triggeredBySubscription = new Set(
    Object.values(messaging?.subscriptions ?? {}).map((sub) => sub.triggers)
  );
  // auto: true solo deriva rutas por convención para operaciones con nombre CRUD
  const autoCoversOp = (name) => api?.auto === true && /^(create|get|list|update|delete)[A-Z]/.test(name);
  const apiEndpoints = new Set(Object.keys(api?.endpoints ?? {}));
  for (const [opName, op] of Object.entries(operations)) {
    const exposed =
      op.internal === true ||
      op.schedule !== undefined ||
      (api && (autoCoversOp(opName) || apiEndpoints.has(opName))) ||
      triggeredBySubscription.has(opName);
    if (!exposed) {
      warnings.push(
        `use-cases: ${opName}: operación huérfana — sin endpoint, sin subscription, sin schedule y sin internal: true`
      );
    }
  }

  return { errors, warnings, pending };
}
