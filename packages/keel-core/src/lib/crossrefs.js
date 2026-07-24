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
  const httpClients = layers['http-clients'];
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

  // allowWireName: solo los contratos de sistemas externos (messaging.subscriptions,
  // http-clients) pueden renombrar campos al nombre real del cable.
  // listRejection: un campo colección (list) se admite en casi todas partes; los dos
  // sitios donde no tiene mapeo posible pasan aquí el motivo concreto.
  const checkFieldMap = (fieldMap, where, { allowWireName = false, listRejection = null } = {}) => {
    for (const [name, field] of Object.entries(fieldMap ?? {})) {
      const type = field?.type;
      if (field?.wireName !== undefined && !allowWireName) {
        errors.push(
          `${where}.${name}: wireName solo es válido en contratos de sistemas externos (messaging: subscriptions, http-clients)`
        );
      }
      if (field?.list === true && listRejection) {
        errors.push(`${where}.${name}: ${listRejection}`);
      }
      const { minItems, maxItems } = field?.constraints ?? {};
      if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
        errors.push(`${where}.${name}: minItems (${minItems}) no puede ser mayor que maxItems (${maxItems})`);
      }
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

  // Un item de exclude puede ser un dot-path que entra en entidades hijas (relaciones) o en
  // value objects compuestos: cada segmento no terminal debe permitir descender y el terminal
  // debe existir. Cruzar a otro agregado (relación serializada por id, no anidada) es warning:
  // no hay campos anidados que excluir. Ruta plana (un solo segmento) = comportamiento previo.
  const checkExcludePath = (rootEntity, rawPath, where) => {
    const segments = rawPath.split('.');
    let ctx = { kind: 'entity', name: rootEntity };
    let crossedAggregate = false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const label = ctx.kind === 'entity' ? `la entidad '${ctx.name}'` : `el value object '${ctx.name}'`;
      const container = ctx.kind === 'entity' ? domain.entities[ctx.name] : domain.types[ctx.name];
      const field = container?.fields?.[seg];
      const relation = ctx.kind === 'entity' ? container?.relations?.[seg] : undefined;

      if (i === segments.length - 1) {
        if (!field && !relation) {
          errors.push(`${where}.exclude '${rawPath}': el campo '${seg}' no existe en ${label}`);
        }
        return;
      }

      // Segmento no terminal: tiene que permitir descender.
      if (relation) {
        if (!entities.has(relation.entity)) return; // relación rota: ya la reporta la validación de domain
        if (!crossedAggregate && ctx.kind === 'entity') {
          const from = aggregateOf.get(ctx.name);
          const to = aggregateOf.get(relation.entity);
          if (from !== undefined && to !== undefined && from !== to) {
            warnings.push(
              `${where}.exclude '${rawPath}': la relación '${seg}' apunta al agregado '${to}', que se serializa por id — no hay campos anidados que excluir`
            );
            crossedAggregate = true;
          }
        }
        ctx = { kind: 'entity', name: relation.entity };
      } else if (field && typeof field.type === 'string' && domain.types?.[field.type]?.fields) {
        ctx = { kind: 'type', name: field.type };
      } else {
        errors.push(
          field
            ? `${where}.exclude '${rawPath}': el campo '${seg}' de ${label} no es una relación ni un value object anidable`
            : `${where}.exclude '${rawPath}': el campo '${seg}' no existe en ${label}`
        );
        return;
      }
    }
  };

  const checkPayload = (payload, where) => {
    if (!payload || payload === 'void') return;
    if (payload.entity && !entities.has(payload.entity)) {
      errors.push(`${where}: la entidad '${payload.entity}' no existe en domain: entities`);
    }
    if (payload.entity && entities.has(payload.entity)) {
      for (const path of payload.exclude ?? []) {
        checkExcludePath(payload.entity, path, where);
      }
    }
    if (payload.fields) checkFieldMap(payload.fields, where);
  };

  // domain: campos internos de value objects compuestos
  for (const [typeName, typeDef] of Object.entries(domain.types ?? {})) {
    if (typeDef?.fields) {
      checkFieldMap(typeDef.fields, `domain: types.${typeName}.fields`, {
        // Colección dentro de un value object = colección anidada, sin mapeo relacional limpio.
        listRejection:
          'list no es válido dentro de un value object (sería una colección anidada); declara la colección como campo de la entidad'
      });
    }
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

  // security: reglas → operaciones, roles, permisos y scopes → catálogos
  if (security) {
    const checkAccessRule = (rule, where) => {
      for (const role of rule?.roles ?? []) {
        if (!roles.has(role)) errors.push(`${where}: el rol '${role}' no existe en security: roles`);
      }
      for (const perm of rule?.permissions ?? []) {
        if (!permissions.has(perm)) errors.push(`${where}: el permiso '${perm}' no existe en security: permissions`);
      }
      for (const scope of rule?.scopes ?? []) {
        if (!permissions.has(scope)) errors.push(`${where}: el scope '${scope}' no existe en security: permissions`);
      }
      if (rule?.level === 'service' && rule?.roles) {
        errors.push(`${where}: level 'service' no admite roles (los roles son de usuarios humanos)`);
      }
      if (rule?.level === 'service' && !rule?.scopes) {
        warnings.push(`${where}: level 'service' sin scopes — cualquier cliente autenticado podrá invocar la operación`);
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
    for (const [client, def] of Object.entries(security.serviceClients ?? {})) {
      for (const scope of def?.scopes ?? []) {
        if (!permissions.has(scope)) {
          errors.push(`security: serviceClients.${client}: el scope '${scope}' no existe en security: permissions`);
        }
      }
    }
  }

  // auto: true solo deriva rutas por convención para operaciones con nombre CRUD
  const autoCoversOp = (name) => api?.auto === true && /^(create|get|list|update|delete)[A-Z]/.test(name);

  // M2M: coherencia entre la audiencia de los endpoints y las reglas de acceso
  if (api && security) {
    const defaultAudience = api.defaultAudience ?? 'users';
    const audienceOf = (opName) => api.endpoints?.[opName]?.audience ?? defaultAudience;
    const exposedOps = new Set(
      [...Object.keys(api.endpoints ?? {}), ...Object.keys(operations).filter(autoCoversOp)].filter((op) =>
        operationNames.has(op)
      )
    );
    const serviceAuth = security.authentication?.serviceAuth;
    const serviceClients = security.serviceClients ?? {};

    let hasMachineEndpoint = false;
    for (const opName of exposedOps) {
      const aud = audienceOf(opName);
      if (aud !== 'users') hasMachineEndpoint = true;
      const namedRule = security.access?.rules?.[opName];
      const rule = namedRule ?? security.access?.default;
      if (!rule) continue;
      const where = namedRule
        ? `security: access.rules.${opName}`
        : `security: access.default (operación ${opName})`;
      if (rule.level === 'service' && aud === 'users') {
        errors.push(
          `${where}: level 'service' pero el endpoint de la operación es audience 'users' — decláralo audience: services (o both con required + scopes)`
        );
      }
      if (rule.level === 'service' && aud === 'both') {
        errors.push(
          `${where}: level 'service' en un endpoint audience 'both' excluiría a los usuarios — usa level required con scopes y roles/permissions`
        );
      }
      if (aud === 'services' && (rule.level === 'required' || rule.level === 'admin')) {
        errors.push(
          `api: endpoints.${opName}: audience 'services' pero su regla de acceso (${namedRule ? `access.rules.${opName}` : 'access.default'}) es level '${rule.level}' (audiencia humana) — usa level service`
        );
      }
      if (aud === 'services' && rule.level === 'public') {
        warnings.push(
          `api: endpoints.${opName}: audience 'services' con level 'public' — ¿de verdad no requiere credencial de máquina?`
        );
      }
      if (rule.scopes && rule.level !== 'service' && aud !== 'both') {
        errors.push(
          `${where}: declara scopes pero ni es level 'service' ni su endpoint es audience 'both'`
        );
      }
    }

    if (hasMachineEndpoint && !serviceAuth) {
      errors.push(
        `api: hay endpoints con audience 'services' o 'both' pero security: authentication no declara serviceAuth`
      );
    }
    if (Object.keys(serviceClients).length > 0 && !serviceAuth) {
      errors.push('security: serviceClients declarado sin authentication.serviceAuth');
    }
    if (Object.keys(serviceClients).length > 0 && !hasMachineEndpoint) {
      warnings.push(
        `security: serviceClients declarado pero ningún endpoint es audience 'services' ni 'both'`
      );
    }

    // mínimo privilegio: scopes concedidos vs scopes exigidos
    if (Object.keys(serviceClients).length > 0) {
      const requiredScopes = new Set();
      const effectiveRules = [
        security.access?.default,
        ...Object.values(security.access?.rules ?? {}),
      ];
      for (const rule of effectiveRules) {
        for (const scope of rule?.scopes ?? []) requiredScopes.add(scope);
      }
      const grantedScopes = new Set();
      for (const [client, def] of Object.entries(serviceClients)) {
        for (const scope of def?.scopes ?? []) {
          grantedScopes.add(scope);
          if (!requiredScopes.has(scope)) {
            warnings.push(
              `security: serviceClients.${client}: el scope '${scope}' no lo exige ninguna regla de acceso`
            );
          }
        }
      }
      for (const scope of requiredScopes) {
        if (!grantedScopes.has(scope)) {
          warnings.push(
            `security: el scope '${scope}' exigido por las reglas de acceso no está concedido a ningún serviceClient — ningún cliente podría invocar esas operaciones`
          );
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
    if (event.channel && messaging?.channels?.[event.channel]?.external === true) {
      warnings.push(
        `messaging: publishing.events.${eventName}.channel: '${event.channel}' está marcado external (lo posee otro sistema) — publicar ahí exige acuerdo con su dueño`
      );
    }
  }
  // Campos que el input de una operación espera recibir de fuera: los generated
  // (id, timestamps de auditoría) y los computed nunca vienen en el mensaje.
  const inputFieldsOf = (input) => {
    if (!input || input === 'void') return null;
    if (input.fields) return input.fields;
    if (input.entity && entities.has(input.entity)) {
      const excluded = new Set(input.exclude ?? []);
      return Object.fromEntries(
        Object.entries(domain.entities[input.entity].fields ?? {}).filter(([name]) => !excluded.has(name))
      );
    }
    return null;
  };

  for (const [eventName, sub] of Object.entries(messaging?.subscriptions ?? {})) {
    const where = `messaging: subscriptions.${eventName}`;
    checkFieldMap(sub.payload, `${where}.payload`, { allowWireName: true });
    checkChannel(sub.channel, `${where}.channel`);
    const externalChannel = sub.channel ? messaging?.channels?.[sub.channel]?.external === true : false;
    const payloadFields = new Set(Object.keys(sub.payload ?? {}));

    // Contrato de recepción: sin él, el generador tiene que suponer la forma del mensaje.
    if (externalChannel && !sub.contract) {
      warnings.push(
        `${where}: consume del canal externo '${sub.channel}' sin contract — el generador tendría que suponer la forma del mensaje (envoltura, formato, discriminador, id de deduplicación)`
      );
    }
    const wrapped = sub.contract?.envelope === 'wrapped';
    for (const key of ['discriminator', 'messageId']) {
      const ref = sub.contract?.[key];
      if (ref?.location !== 'field') continue;
      const root = ref.name.split('.')[0];
      if (payloadFields.has(root)) continue;
      if (wrapped) {
        warnings.push(`${where}.contract.${key}: el campo '${ref.name}' no está en payload — se asume que vive en la envoltura de la fuente`);
      } else {
        errors.push(`${where}.contract.${key}: el campo '${ref.name}' no existe en el payload de la suscripción`);
      }
    }

    // triggers + cobertura del input de la operación disparada
    if (!operationNames.has(sub.triggers)) {
      errors.push(`${where}.triggers: la operación '${sub.triggers}' no existe en use-cases`);
      continue;
    }
    const mapping = sub.input ?? {};
    for (const [inputField, payloadField] of Object.entries(mapping)) {
      if (!payloadFields.has(payloadField)) {
        errors.push(`${where}.input.${inputField}: el campo '${payloadField}' no existe en el payload de la suscripción`);
      }
    }
    const opInput = inputFieldsOf(operations[sub.triggers].input);
    if (!opInput) continue;
    for (const inputField of Object.keys(mapping)) {
      if (!(inputField in opInput)) {
        errors.push(
          `${where}.input.${inputField}: la operación '${sub.triggers}' no declara ese campo en su input`
        );
      }
    }
    const covered = new Set(Object.keys(mapping));
    const usedPayloadFields = new Set(Object.values(mapping));
    for (const [inputField, def] of Object.entries(opInput)) {
      if (covered.has(inputField)) continue;
      if (def?.generated === true || def?.computed !== undefined) continue;
      if (payloadFields.has(inputField)) {
        usedPayloadFields.add(inputField); // identidad por nombre
        continue;
      }
      if (def?.required === true) {
        errors.push(
          `${where}: el campo requerido '${inputField}' del input de '${sub.triggers}' no llega en el payload — declara el campo o mapéalo en input`
        );
      }
    }
    for (const field of payloadFields) {
      if (!usedPayloadFields.has(field)) {
        warnings.push(`${where}.payload.${field}: no alimenta ningún campo del input de '${sub.triggers}'`);
      }
    }
  }

  // http-clients: tipado de requests/responses y coherencia path ↔ pathParams.
  // (method↔path juntos, request→method, GET/DELETE sin body y retryOn sin 4xx los cubre ya el schema.)
  for (const [clientId, client] of Object.entries(httpClients?.clients ?? {})) {
    for (const [callName, call] of Object.entries(client.calls ?? {})) {
      const where = `http-clients: clients.${clientId}.calls.${callName}`;
      for (const section of ['pathParams', 'queryParams', 'headers', 'body']) {
        checkFieldMap(call.request?.[section], `${where}.request.${section}`, {
          allowWireName: true,
          // Una variable de ruta es un solo valor: no hay forma de interpolar una colección.
          listRejection:
            section === 'pathParams' ? 'list no es válido en pathParams: una variable de ruta es un solo valor' : null
        });
      }
      checkFieldMap(call.response?.fields, `${where}.response.fields`, { allowWireName: true });

      if (call.path) {
        const pathVars = [...call.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]);
        const declared = Object.keys(call.request?.pathParams ?? {});
        if (call.request?.pathParams) {
          for (const variable of pathVars) {
            if (!declared.includes(variable)) {
              errors.push(`${where}.request.pathParams: la variable '{${variable}}' de path no está declarada`);
            }
          }
        } else if (pathVars.length > 0) {
          warnings.push(
            `${where}: path con variables {…} sin request.pathParams — el generador no podrá tipar los parámetros`
          );
        }
        for (const param of declared) {
          if (!pathVars.includes(param)) {
            errors.push(`${where}.request.pathParams.${param}: no aparece como '{${param}}' en path`);
          }
        }
      } else if (call.request || call.response) {
        warnings.push(
          `${where}: declara request/response tipados pero no method+path — el generador seguirá parseando la prosa del contract`
        );
      }

      if (call.circuitBreaker && !call.fallback) {
        warnings.push(`${where}: circuitBreaker sin fallback — define qué hace el servicio con el circuito abierto`);
      }
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
