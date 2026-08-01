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
  const dependencies = layers['dependencies'];
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
  const emittedEvents = new Set(); // eventos citados por algún emits (para detectar publicados que nadie emite)
  const httpCallKeys = new Set(); // `${clientId}|${callName}` — lo llena el bloque http-clients
  const usedHttpCalls = new Set(); // clientes citados por algún need (para detectar clientes sin dependencia)

  // Códigos de error declarados: el catálogo completo y el subconjunto por operación.
  // Los consume dependencies (onMiss.action: fail exige un error que alguien declare).
  const declaredErrorCodes = new Set();
  const errorCodesByOp = new Map();
  for (const [opName, op] of Object.entries(useCases.operations ?? {})) {
    const codes = new Set((op.errors ?? []).map((error) => error?.code).filter(Boolean));
    errorCodesByOp.set(opName, codes);
    for (const code of codes) declaredErrorCodes.add(code);
  }

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
      // Un default que no es uno de los valores del enum es un estado inalcanzable:
      // el generador lo emite tal cual y la entidad nace en un valor que su propia
      // máquina de estados no conoce.
      if (field?.default !== undefined) {
        const values = enumValuesOf(field);
        if (values) {
          const defaults = field.list === true && Array.isArray(field.default) ? field.default : [field.default];
          for (const value of defaults) {
            if (!values.includes(value)) {
              errors.push(
                `${where}.${name}: default '${value}' no es un valor del enum (${values.join(', ')})`
              );
            }
          }
        }
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

  // ¿Puede el input de una operación resolver este nombre? Lo consultan las variables
  // de ruta de api y las keyFields de cache. Con input { entity: X } se admite además
  // una relación, por su nombre o con el sufijo del id, con la misma tolerancia que
  // aplica persistence a naturalKey/indexes.
  const inputAcceptsName = (op, name) => {
    const fields = inputFieldsOf(op?.input);
    if (fields && Object.hasOwn(fields, name)) return true;
    const entityName = op?.input?.entity;
    const relations = entityName ? domain.entities?.[entityName]?.relations ?? {} : {};
    if (Object.hasOwn(relations, name)) return true;
    return name.endsWith('Id') && Object.hasOwn(relations, name.slice(0, -2));
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

  // embed proyecta una relación hacia OTRO agregado como objeto anidado en vez de
  // como '<relación>Id'. Solo tiene sentido ahí: una entidad hija del propio
  // agregado ya entra anidada por defecto, y un campo no es una relación.
  const checkEmbed = (rootEntity, relName, where) => {
    const relation = domain.entities[rootEntity]?.relations?.[relName];
    if (!relation) {
      errors.push(`${where}.embed '${relName}': la entidad '${rootEntity}' no declara esa relación`);
      return;
    }
    if (!entities.has(relation.entity)) return; // relación rota: la reporta domain
    // El destino tiene que ser la RAÍZ de un agregado: es lo que se referencia
    // por id y, por tanto, lo único que embed puede sustituir por el objeto. Una
    // entidad interna del mismo agregado ya se proyecta anidada por defecto.
    // La auto-referencia (Category.parent → Category) sí es válida: apunta a
    // otra instancia, que es su propio agregado.
    // Una entidad que no figura en ningún agregado es un agregado propio de una sola
    // entidad (el bloque domain ya lo avisa), así que referenciarla es referenciar una raíz.
    const aggregateRoots = new Set(Object.values(domain.aggregates ?? {}).map((agg) => agg.root));
    const targetIsRoot =
      aggregateRoots.size === 0 || aggregateRoots.has(relation.entity) || !aggregateOf.has(relation.entity);
    if (!targetIsRoot) {
      errors.push(
        `${where}.embed '${relName}': '${relation.entity}' es una entidad interna del agregado '${aggregateOf.get(relation.entity)}' y ya se proyecta anidada; embed es para referencias a la raíz de otro agregado`
      );
      return;
    }
    if (
      relation.entity !== rootEntity &&
      aggregateOf.has(rootEntity) &&
      aggregateOf.get(rootEntity) === aggregateOf.get(relation.entity)
    ) {
      errors.push(
        `${where}.embed '${relName}': '${relation.entity}' pertenece al mismo agregado que '${rootEntity}'; embed es para referencias a otro agregado`
      );
      return;
    }
    if (relation.cardinality !== 'many-to-one' && relation.cardinality !== 'one-to-one') {
      errors.push(
        `${where}.embed '${relName}': solo se pueden embeber relaciones many-to-one/one-to-one hacia otro agregado (declarada '${relation.cardinality}')`
      );
    }
  };

  // sort declara el orden POR DEFECTO de una salida de varios elementos. Es
  // contrato —es lo que recibe quien no pide un orden concreto— y por eso solo
  // vive en el output y solo sobre campos que ese payload realmente proyecta.
  // El desempate por id lo añade el generador siempre, se declare o no: sin él
  // dos páginas consecutivas pueden repetir u omitir filas.
  const checkSort = (payload, where) => {
    const scalarField = (entityName, fieldName) => {
      const field = domain.entities[entityName]?.fields?.[fieldName];
      if (!field) return { ok: false, reason: 'missing' };
      // Una colección no tiene un orden por columna, y un value object compuesto
      // ordena por un subcampo suyo, no por el objeto entero.
      if (field.list === true) return { ok: false, reason: 'list' };
      if (typeof field.type === 'string' && domain.types?.[field.type]?.fields) {
        return { ok: false, reason: 'composite' };
      }
      return { ok: true };
    };

    const seen = new Set();
    for (const criterion of payload.sort ?? []) {
      const [path] = String(criterion).split(':');
      if (seen.has(path)) {
        errors.push(`${where}.sort '${criterion}': '${path}' ya está declarado; un criterio de orden no se repite`);
        continue;
      }
      seen.add(path);

      const [head, nested] = path.split('.');
      if (!nested) {
        // Una relación no se ordena como tal: o es otro agregado (y entonces se
        // ordena por uno de sus campos, con dot-path) o es una entidad hija.
        if (domain.entities[payload.entity]?.relations?.[head]) {
          errors.push(
            `${where}.sort '${criterion}': '${head}' es una relación, no un campo; para ordenar por el agregado referenciado usa '${head}.<campo>' y embébelo`
          );
          continue;
        }
        const check = scalarField(payload.entity, head);
        if (check.reason === 'missing') {
          errors.push(`${where}.sort '${criterion}': el campo '${head}' no existe en la entidad '${payload.entity}'`);
        } else if (check.reason === 'list') {
          errors.push(`${where}.sort '${criterion}': '${head}' es una colección y no define un orden; ordena por un campo escalar`);
        } else if (check.reason === 'composite') {
          errors.push(
            `${where}.sort '${criterion}': '${head}' es un value object compuesto; ordena por uno de sus subcampos ('${head}.<subcampo>')`
          );
        }
        continue;
      }

      // Dot-path: solo sobre una relación EMBEBIDA. Ordenar por algo que la
      // respuesta no devuelve rompe el contrato, y exigir el embed es lo que
      // hace que el generador pueda detectar que este listado necesita un join.
      const relation = domain.entities[payload.entity]?.relations?.[head];
      const composite = domain.entities[payload.entity]?.fields?.[head];
      if (relation) {
        if (!(payload.embed ?? []).includes(head)) {
          errors.push(
            `${where}.sort '${criterion}': ordena por un campo de '${relation.entity}', que este payload no proyecta; añade '${head}' a embed o ordena por un campo propio`
          );
          continue;
        }
        if (!entities.has(relation.entity)) continue; // relación rota: la reporta domain
        const check = scalarField(relation.entity, nested);
        if (check.reason === 'missing') {
          errors.push(`${where}.sort '${criterion}': el campo '${nested}' no existe en la entidad '${relation.entity}'`);
        } else if (check.reason !== undefined && check.ok !== true) {
          errors.push(`${where}.sort '${criterion}': '${nested}' no es un campo escalar de '${relation.entity}'`);
        }
      } else if (composite && typeof composite.type === 'string' && domain.types?.[composite.type]?.fields) {
        if (!domain.types[composite.type].fields[nested]) {
          errors.push(`${where}.sort '${criterion}': el value object '${composite.type}' no tiene el campo '${nested}'`);
        }
      } else {
        errors.push(
          `${where}.sort '${criterion}': '${head}' no es una relación ni un value object de '${payload.entity}'`
        );
      }
    }
  };

  const checkPayload = (payload, where, { direction = 'output' } = {}) => {
    if (!payload || payload === 'void') return;
    if (payload.entity && !entities.has(payload.entity)) {
      errors.push(`${where}: la entidad '${payload.entity}' no existe en domain: entities`);
    }
    // paginated ya implica la colección (el sobre { items, page, size, … } la envuelve),
    // pero sin la política de pagination de api el generador no tiene tamaño de página ni tope.
    if (direction === 'output' && payload.paginated === true && !api?.pagination) {
      warnings.push(
        `${where}: paginated: true pero api no declara pagination (style/defaultSize/maxSize) — el generador no tiene tamaño de página ni tope`
      );
    }
    if (payload.entity && entities.has(payload.entity)) {
      for (const path of payload.exclude ?? []) {
        checkExcludePath(payload.entity, path, where);
      }
      for (const relName of payload.embed ?? []) {
        if (direction === 'input') {
          errors.push(`${where}.embed '${relName}': embed solo aplica al output; en la entrada la referencia viaja por id`);
          continue;
        }
        checkEmbed(payload.entity, relName, where);
      }
      if ((payload.sort ?? []).length > 0) {
        if (direction === 'input') {
          errors.push(`${where}.sort: el orden es una decisión de la salida; en la entrada no tiene efecto`);
        } else if (payload.list !== true && payload.paginated !== true) {
          errors.push(`${where}.sort: solo tiene sentido en una salida de varios elementos (list o paginated)`);
        } else {
          checkSort(payload, where);
        }
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
    checkPayload(op.input, `use-cases: ${opName}.input`, { direction: 'input' });
    checkPayload(op.output, `use-cases: ${opName}.output`);
    for (const event of op.emits ?? []) {
      emittedEvents.add(event);
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
    // La clave de caché se compone con campos del input: un nombre que la operación no
    // recibe produce una clave que nunca varía por ese eje (o que el generador no puede
    // resolver), y el fallo es silencioso — se sirve la entrada equivocada.
    for (const keyField of op.cache?.keyFields ?? []) {
      if (!inputAcceptsName(op, keyField)) {
        errors.push(
          `use-cases: ${opName}.cache.keyFields: el campo '${keyField}' no está en el input de la operación`
        );
      }
    }
    if (op.cache && op.kind !== 'query') {
      warnings.push(`use-cases: ${opName}: tiene cache pero no es kind: query`);
    }
  }

  // use-cases: una caché que embebe otro agregado tiene que poder invalidarse cuando
  // cambia ESE agregado, no solo cuando cambia la entidad principal. `invalidatedBy`
  // se validaba solo en la dirección barata —que el nombre del evento exista—, que no
  // ve el fallo caro: una query que proyecta `brand` como objeto anidado y lista
  // únicamente eventos de producto sirve el nombre (o el estado) viejo de la marca
  // hasta que expire el TTL, y ninguna capa del diseño lo delata. Peor aún cuando la
  // entidad embebida no publica ningún evento: ahí la invalidación no es que se haya
  // olvidado, es que es MECÁNICAMENTE IMPOSIBLE, y eso solo se descubre con la suite
  // de integración y la infraestructura levantada.
  //
  // Qué muta una entidad: los eventos que emiten los commands que la devuelven. Es la
  // aproximación que el DSL permite, y basta para separar los dos casos.
  const mutationEvents = new Map();
  for (const op of Object.values(operations)) {
    if (op.kind !== 'command') continue;
    const mutated = op.output?.entity ?? op.input?.entity;
    if (!mutated || !entities.has(mutated)) continue;
    for (const event of op.emits ?? []) {
      if (!mutationEvents.has(mutated)) mutationEvents.set(mutated, new Set());
      mutationEvents.get(mutated).add(event);
    }
  }
  for (const [opName, op] of Object.entries(operations)) {
    // Sin capa messaging y con el diseño en progreso, los nombres de invalidatedBy ya
    // están en pending: no hay nada firme contra lo que contrastar todavía.
    if (!op.cache || (!messaging && wip)) continue;
    const output = op.output;
    if (!output || output === 'void' || !output.entity || !entities.has(output.entity)) continue;
    const where = `use-cases: ${opName}.cache`;
    const invalidatedBy = new Set(op.cache.invalidatedBy ?? []);
    const covers = (events) => [...events].some((event) => invalidatedBy.has(event));
    let ownReported = false;

    for (const relName of output.embed ?? []) {
      const target = domain.entities?.[output.entity]?.relations?.[relName]?.entity;
      if (!target || !entities.has(target)) continue; // relación rota: la reporta checkEmbed
      const mutators = mutationEvents.get(target) ?? new Set();
      if (covers(mutators)) continue;
      if (target === output.entity) ownReported = true;
      errors.push(
        mutators.size === 0
          ? `${where}: la caché proyecta '${target}' anidado (embed: [${relName}]) y ninguna operación publica eventos de '${target}': el objeto embebido no tiene forma de invalidarse antes del TTL — declara el evento en messaging y añádelo a invalidatedBy, o quita el embed`
          : `${where}: la caché proyecta '${target}' anidado (embed: [${relName}]) y invalidatedBy no incluye ninguno de los eventos que lo mutan [${[...mutators].sort().join(', ')}] — el objeto embebido queda rancio hasta el TTL`
      );
    }

    // La entidad cacheada en sí. Aviso y no error: aceptar staleness acotado por el TTL
    // en la entidad principal es una decisión legítima (y a veces el propósito de la
    // caché), mientras que un embed rancio suele sorprender a quien lee el contrato.
    const own = mutationEvents.get(output.entity) ?? new Set();
    const uncovered = [...own].filter((event) => !invalidatedBy.has(event)).sort();
    if (!ownReported && uncovered.length > 0) {
      warnings.push(
        `${where}: '${output.entity}' cambia con [${uncovered.join(', ')}], que invalidatedBy no lista — ` +
          'si el staleness hasta el TTL es deliberado, ignóralo; si no, la lectura sirve datos viejos'
      );
    }
  }

  // use-cases: consistencia de proyección — si la mayoría de las operaciones que
  // devuelven una entidad resuelven una referencia con `embed`, la que no lo hace
  // suele ser un olvido, no una decisión.
  //
  // Es la única forma MECÁNICA de ver un hueco que hoy solo aparece generando: los
  // escenarios de `validation-scenarios.md` son prosa y nada los cruza con los
  // artefactos, así que "cada elemento del listado trae brand y category como
  // objetos anidados" contra un `output` sin `embed` no se detecta hasta que la
  // suite de integración falla, con toda la infraestructura levantada — el punto
  // más caro posible. La señal no es el escenario: es la asimetría dentro del
  // propio DSL. Aviso y no error: proyectar distinto en un listado que en el
  // detalle es una decisión legítima (payload más liviano), solo que hay que
  // tomarla a propósito.
  const projections = new Map();
  for (const [opName, op] of Object.entries(operations)) {
    const output = op.output;
    if (!output || output === 'void' || !output.entity || !entities.has(output.entity)) continue;
    if (!projections.has(output.entity)) projections.set(output.entity, []);
    projections.get(output.entity).push({
      opName,
      embed: new Set(output.embed ?? []),
      // Un `exclude` deja la relación fuera del payload entero: no hay nada que
      // embeber y no es asimetría.
      exclude: new Set((output.exclude ?? []).map((path) => String(path).split('.')[0]))
    });
  }
  for (const [entityName, payloads] of projections) {
    if (payloads.length < 2) continue;
    const relations = Object.keys(domain.entities?.[entityName]?.relations ?? {});
    for (const relName of relations) {
      const embedders = payloads.filter((payload) => payload.embed.has(relName));
      if (embedders.length === 0) continue;
      const plain = payloads.filter((payload) => !payload.embed.has(relName) && !payload.exclude.has(relName));
      if (plain.length === 0) continue;
      warnings.push(
        `use-cases: ${plain.map((payload) => payload.opName).join(', ')}: ` +
          `devuelve${plain.length > 1 ? 'n' : ''} '${entityName}' con '${relName}Id' plano, ` +
          `mientras ${embedders.map((payload) => payload.opName).join(', ')} ` +
          `lo${embedders.length > 1 ? 's' : ''} resuelve${embedders.length > 1 ? 'n' : ''} con embed: [${relName}] — ` +
          'si es deliberado, ignóralo; si no, el consumidor recibe un id que le obliga a una segunda llamada'
      );
    }
  }

  // api: endpoints → operaciones, variables de ruta ↔ input, y coherencia con la operación
  for (const [opName, endpoint] of Object.entries(api?.endpoints ?? {})) {
    const where = `api: endpoints.${opName}`;
    if (!operationNames.has(opName)) {
      errors.push(`${where}: la operación no existe en use-cases`);
      continue;
    }
    const op = operations[opName];
    // internal: true declara que la operación no tiene superficie externa. Exponerla por
    // HTTP contradice esa declaración; el warning de operación huérfana cubre el caso opuesto.
    if (op.internal === true) {
      errors.push(
        `${where}: la operación está declarada internal: true — una operación interna no se expone por HTTP`
      );
    }
    // Cada {variable} de la ruta se convierte en un parámetro de ruta que el generador
    // tiene que bindear a un campo del input. La comprobación espejo existe desde 2.1
    // para http-clients (path ↔ request.pathParams); esta es la del lado servidor.
    for (const variable of [...(endpoint.path ?? '').matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1])) {
      if (!inputAcceptsName(op, variable)) {
        errors.push(
          `${where}.path: la variable '{${variable}}' no está en el input de la operación — el generador no tiene a qué bindear el parámetro de ruta`
        );
      }
    }
    // Aviso, no error: una búsqueda con criterios extensos por POST es legítima.
    if (op.kind === 'query' && endpoint.method !== undefined && endpoint.method !== 'GET') {
      warnings.push(
        `${where}.method: la operación es kind: query y se expone con ${endpoint.method} — una lectura se expone con GET salvo que la entrada no quepa en la URL`
      );
    }
    if (op.kind === 'command' && endpoint.method === 'GET') {
      warnings.push(
        `${where}.method: la operación es kind: command y se expone con GET — una escritura no debe viajar en un método idempotente y cacheable`
      );
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
    // protocol: none declara que el servicio no autentica a nadie. Una regla que exija
    // identidad (nivel por encima de public, roles, permisos o scopes) no tiene entonces
    // de dónde sacar el sujeto contra el que decidir: el diseño se contradice.
    if (security.authentication?.protocol === 'none') {
      const demandsIdentity = (rule) =>
        Boolean(rule) &&
        ((rule.level !== undefined && rule.level !== 'public') ||
          rule.roles !== undefined ||
          rule.permissions !== undefined ||
          rule.scopes !== undefined);
      const offending = [
        ...(demandsIdentity(security.access?.default) ? ['access.default'] : []),
        ...Object.entries(security.access?.rules ?? {})
          .filter(([, rule]) => demandsIdentity(rule))
          .map(([opName]) => `access.rules.${opName}`)
      ];
      if (offending.length > 0) {
        errors.push(
          `security: authentication.protocol: 'none' pero ${offending.join(', ')} exige identidad (level distinto de public, roles, permissions o scopes) — sin autenticación no hay sujeto contra el que decidir`
        );
      }
    }
    // cors: política del canal HTTP entrante, sin sentido sin capa api. Y con el
    // token en cookie, el navegador no la enviaría cross-origin sin credenciales.
    if (security.cors) {
      if (!api) {
        errors.push('security: cors declarado sin capa api — no hay endpoints HTTP a los que aplicar la política');
      }
      if (security.authentication?.tokenLocation === 'cookie' && security.cors.allowCredentials !== true) {
        errors.push(
          'security: cors.allowCredentials debe ser true con tokenLocation cookie — el navegador no enviaría la cookie cross-origin'
        );
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
      httpCallKeys.add(`${clientId}|${callName}`);
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

  // dependencies: la capa de síntesis — solo referencia a las demás, nunca las redeclara.
  // Todo el bloque (incluidas las reglas inversas del final) va dentro de este if: un diseño
  // que no declara la capa no puede ganar avisos nuevos.
  if (dependencies) {
    const subscriptions = messaging?.subscriptions ?? {};
    const replicaEntities = new Map(); // entidad → primer need que la replica

    // Una réplica es una entidad de dominio que hay que guardar: sin persistence no hay dónde.
    // Como el per-aggregate de persistence, es error también con --wip.
    const checkReplica = (replica, need, where) => {
      const entityName = replica.entity;
      const entity = domain.entities?.[entityName];
      if (!entity) {
        errors.push(`${where}.replica.entity: la entidad '${entityName}' no existe en domain: entities`);
      } else if (!(replica.keyField in (entity.fields ?? {}))) {
        errors.push(
          `${where}.replica.keyField: el campo '${replica.keyField}' no existe en la entidad '${entityName}'`
        );
      } else if (entity.fields[replica.keyField]?.unique !== true) {
        warnings.push(
          `${where}.replica.keyField: '${replica.keyField}' no es unique en '${entityName}' — la copia podría duplicarse ante reentregas`
        );
      }

      if (!persistence) {
        errors.push(`${where}.replica: una copia local exige capa persistence (no hay dónde guardarla)`);
      } else if (entity && !(entityName in (persistence.entities ?? {}))) {
        warnings.push(
          `${where}.replica.entity: '${entityName}' no aparece en persistence: entities — la copia local no se persistiría`
        );
      }

      if (entityName) {
        if (replicaEntities.has(entityName)) {
          warnings.push(
            `${where}.replica.entity: '${entityName}' ya la replica el need '${replicaEntities.get(entityName)}'`
          );
        } else {
          replicaEntities.set(entityName, need);
        }
      }
    };

    // Un evento consumido del proveedor: existe como suscripción y su source concuerda.
    const checkConsumedEvent = (event, where, depName, label) => {
      if (!consumedEvents.has(event)) {
        if (!messaging && wip) {
          pending.push(`${where}: el evento '${event}' está pendiente de definir en messaging: subscriptions`);
        } else {
          errors.push(
            `${where}: el evento '${event}' no está en messaging: subscriptions` +
              (messaging ? '' : ' (no hay capa messaging)')
          );
        }
        return;
      }
      const source = subscriptions[event]?.source;
      if (source && source !== depName) {
        warnings.push(
          `${where}: la ${label} '${event}' declara source '${source}', distinto de la dependencia '${depName}'`
        );
      }
    };

    for (const [depName, dep] of Object.entries(dependencies.dependencies ?? {})) {
      for (const [need, spec] of Object.entries(dep.needs ?? {})) {
        const where = `dependencies: ${depName}.needs.${need}`;

        for (const opName of spec.usedBy ?? []) {
          if (!operationNames.has(opName)) {
            errors.push(`${where}.usedBy: la operación '${opName}' no existe en use-cases`);
          }
        }

        if (spec.fetchedFrom) {
          const { client, call } = spec.fetchedFrom;
          usedHttpCalls.add(client);
          if (!httpClients) {
            if (wip) {
              pending.push(`${where}.fetchedFrom: el cliente '${client}' está pendiente de definir en http-clients`);
            } else {
              errors.push(
                `${where}.fetchedFrom: el cliente '${client}' no está en http-clients: clients (no hay capa http-clients)`
              );
            }
          } else if (!(client in (httpClients.clients ?? {}))) {
            errors.push(`${where}.fetchedFrom: el cliente '${client}' no está en http-clients: clients`);
          } else if (!httpCallKeys.has(`${client}|${call}`)) {
            errors.push(
              `${where}.fetchedFrom: la llamada '${call}' no existe en http-clients: clients.${client}.calls`
            );
          }
        }

        if (spec.replica) {
          checkReplica(spec.replica, need, where);
          for (const event of spec.replica.fedBy ?? []) {
            checkConsumedEvent(event, `${where}.replica.fedBy`, depName, 'suscripción');
          }

          // Que el error exista es error duro: el generador lanza esa excepción y solo
          // la genera si alguna operación la declaró en su catálogo.
          const code = spec.replica.onMiss?.error;
          if (code) {
            if (!declaredErrorCodes.has(code)) {
              errors.push(
                `${where}.replica.onMiss.error: el código '${code}' no lo declara ninguna operación de use-cases`
              );
            } else if (!(spec.usedBy ?? []).some((opName) => errorCodesByOp.get(opName)?.has(code))) {
              warnings.push(
                `${where}.replica.onMiss.error: '${code}' no lo declara ninguna de las operaciones de usedBy`
              );
            }
          }
        }
      }

      for (const [index, compensation] of (dep.compensations ?? []).entries()) {
        checkConsumedEvent(
          compensation.onEvent,
          `dependencies: ${depName}.compensations[${index}]`,
          depName,
          'suscripción'
        );
      }
    }

    // Inversas: todo canal de integración existe porque alguna dependencia lo justifica.
    const declaredDependencies = new Set(Object.keys(dependencies.dependencies ?? {}));
    for (const clientId of Object.keys(httpClients?.clients ?? {})) {
      if (!usedHttpCalls.has(clientId)) {
        warnings.push(
          `http-clients: clients.${clientId}: ningún need de dependencies lo usa — ¿de qué dependencia forma parte?`
        );
      }
    }
    for (const [event, sub] of Object.entries(subscriptions)) {
      if (sub.source && !declaredDependencies.has(sub.source)) {
        warnings.push(
          `messaging: subscriptions.${event}: su source '${sub.source}' no está declarado en dependencies`
        );
      }
    }
  }

  // Un miembro de naturalKey/indexes nombra un campo, una relación o el subcampo de un
  // value object. Una relación se admite por su nombre ('category') o con el sufijo del
  // id ('categoryId'): cuál de los dos usa el código generado depende de si la relación
  // cruza frontera de agregado, un detalle del generador ajeno al diseño.
  const checkPersistenceMember = (entityName, entity, member, key) => {
    const where = `persistence: entities.${entityName}.${key}`;
    const [head, ...rest] = String(member).split('.');
    const fields = entity.fields ?? {};
    const relations = entity.relations ?? {};
    const isRelation = head in relations || (head.endsWith('Id') && head.slice(0, -2) in relations);

    if (!(head in fields) && !isRelation) {
      errors.push(`${where}: '${member}' no es un campo ni una relación de la entidad '${entityName}'`);
      return;
    }
    if (rest.length === 0) return;

    // 'price.amount': el campo debe ser de un value type compuesto que declare ese subcampo.
    const subFields = domain.types?.[fields[head]?.type]?.fields;
    if (!subFields) {
      errors.push(`${where}: '${member}': '${head}' no es un value type compuesto de la entidad '${entityName}'`);
    } else if (!(rest[0] in subFields)) {
      errors.push(`${where}: '${member}': el tipo '${fields[head].type}' no declara el campo '${rest[0]}'`);
    }
  };

  // persistence: entidades → domain
  for (const [entityName, spec] of Object.entries(persistence?.entities ?? {})) {
    if (!entities.has(entityName)) {
      errors.push(`persistence: entities.${entityName}: la entidad no existe en domain: entities`);
      continue;
    }
    // naturalKey e indexes se declaran sobre miembros del dominio: un nombre que no
    // resuelve es un typo, y el generador solo puede avisarlo cuando ya está generando.
    const entity = domain.entities?.[entityName] ?? {};
    for (const member of spec?.naturalKey ?? []) {
      checkPersistenceMember(entityName, entity, member, 'naturalKey');
    }
    for (const index of spec?.indexes ?? []) {
      for (const member of index ?? []) {
        checkPersistenceMember(entityName, entity, member, 'indexes');
      }
    }

    // Una natural key (= constraint UNIQUE) sobre un campo `computed` de una entidad
    // hija es el patrón de la colección ordenada por posición: `(productId, position)`
    // con `position` recompactada al borrar y reasignada al reordenar. El agregado se
    // guarda entero, y cualquier orden de escritura que pase por un estado intermedio
    // —dos filas compartiendo posición a mitad del reparto— choca contra el índice
    // único, que es inmediato y no diferido, incluso sin concurrencia ninguna.
    // El diseño tiene ya toda la información para verlo; el generador solo lo descubre
    // con la base de datos delante y un fallo por cada fila afectada.
    const aggregate = aggregateOf.get(entityName);
    const isChild = aggregate !== undefined && aggregates[aggregate]?.root !== entityName;
    if (isChild) {
      const computed = (spec?.naturalKey ?? []).filter(
        (member) => entity.fields?.[String(member).split('.')[0]]?.computed
      );
      for (const member of computed) {
        warnings.push(
          `persistence: entities.${entityName}.naturalKey: '${member}' es un campo computed de una entidad interna del agregado '${aggregate}', y la natural key es una constraint UNIQUE — ` +
            'al recalcularlo para toda la colección el guardado debe evitar el estado intermedio en que dos filas comparten valor; si el recálculo no es masivo, ignóralo'
        );
      }
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
  // 'declared' delega el bloqueo optimista a las raíces que declaran el campo
  // reservado `lockVersion`. Si ninguna lo hace, la política es indistinguible de
  // 'none' y lo más probable es que el diseñador esperase lo contrario.
  if (persistence?.consistency?.optimisticLocking === 'declared') {
    const roots = Object.values(aggregates)
      .map((aggregate) => aggregate?.root)
      .filter(Boolean);
    const withVersion = roots.filter((root) =>
      Object.hasOwn(domain.entities?.[root]?.fields ?? {}, 'lockVersion')
    );
    if (withVersion.length === 0) {
      warnings.push(
        `persistence: consistency.optimisticLocking: 'declared' pero ninguna raíz de agregado declara el campo reservado 'lockVersion' en domain (p. ej. 'lockVersion: { type: int, generated: true }' en la raíz, ver docs/dsl/persistence.md) — tal como está equivale a 'none' (último escritor gana). Declara el campo donde el conflicto deba observarse, o usa 'all'/'none' explícitamente`
      );
    }
  }
  // Auditoría: cada eje ('timestamps', 'authorship') se declara de UNA sola forma.
  // Con 'all' las columnas las pone la infraestructura y no se nombran en domain; con
  // 'declared' se nombran ahí porque el diseño quiere proyectarlas en algún output.
  // Mezclar ambas cosas es justo lo que hacía el comportamiento implícito anterior,
  // donde declarar el campo desactivaba la política sin que nadie lo hubiese decidido.
  if (persistence) {
    const AUDIT_AXES = [
      { axis: 'timestamps', fields: ['createdAt', 'updatedAt'], type: 'timestamp', fallback: 'all' },
      { axis: 'authorship', fields: ['createdBy', 'updatedBy'], type: 'string', fallback: 'none' }
    ];
    for (const { axis, fields, type, fallback } of AUDIT_AXES) {
      const policy = persistence.audit?.[axis] ?? fallback;
      const declaredBy = [];
      for (const [entityName, entity] of Object.entries(domain.entities ?? {})) {
        for (const fieldName of fields) {
          const field = entity?.fields?.[fieldName];
          if (!field) continue;
          declaredBy.push(`${entityName}.${fieldName}`);
          if (policy !== 'declared') continue;
          // Sin `generated` el campo entra en el input de las operaciones que derivan
          // su payload de la entidad: el cliente podría mandar su propia auditoría.
          if (!field.generated) {
            errors.push(
              `domain: entities.${entityName}.fields.${fieldName}: campo reservado de auditoría declarado sin 'generated: true' — lo asigna la infraestructura y nunca puede venir del cliente (ver docs/dsl/persistence.md § audit)`
            );
          }
          if (field.type !== type) {
            errors.push(
              `domain: entities.${entityName}.fields.${fieldName}: campo reservado de auditoría de tipo '${field.type}'; persistence: audit.${axis} exige '${type}'`
            );
          }
        }
      }
      if (policy !== 'declared' && declaredBy.length > 0) {
        errors.push(
          `persistence: audit.${axis}: '${policy}' pero domain declara el campo reservado ${declaredBy.join(', ')} — con '${policy}' esas columnas las decide la política y no se nombran en domain. Usa 'declared' si el diseño necesita proyectarlas en algún output`
        );
      }
      if (policy === 'declared' && declaredBy.length === 0) {
        errors.push(
          `persistence: audit.${axis}: 'declared' pero ninguna entidad declara los campos reservados (${fields.join('/')}) en domain — tal como está equivale a 'none'. Decláralos donde deban registrarse, o usa 'all'/'none' explícitamente`
        );
      }
    }
    // La autoría sale del principal autenticado: sin capa security no hay actor y la
    // columna solo registraría el centinela del generador, que es trazabilidad
    // técnica (el correlation id), no autoría.
    const authorship = persistence.audit?.authorship ?? 'none';
    if (authorship !== 'none' && !security) {
      errors.push(
        `persistence: audit.authorship: '${authorship}' exige la capa security: sin principal autenticado no hay autor que registrar (declara la capa, o usa 'none' y confía la trazabilidad al correlation id)`
      );
    }
  }

  // storage: una operación que devuelve un archivo puede encontrarse con que la clave ya
  // no está en el bucket (objeto borrado, bucket migrado; la entidad conserva la key).
  // Sin un error declarado para esa ausencia, el adaptador propaga la excepción cruda del
  // SDK de storage y sale un 500 que no está en ningún contrato.
  for (const [opName, op] of Object.entries(useCases.operations ?? {})) {
    const outputFields = Object.values(op?.output?.fields ?? {});
    if (!outputFields.some((field) => field?.type === 'file')) continue;
    const coversAbsence = (op.errors ?? []).some(
      (error) => error?.http === 404 || /NOT_FOUND$/.test(error?.code ?? '')
    );
    if (!coversAbsence) {
      warnings.push(
        `use-cases: operations.${opName}: devuelve un archivo pero no declara ningún error para la clave inexistente (p. ej. FILE_NOT_FOUND con http: 404) — una lectura cuyo objeto ya no está en el bucket saldría como 500`
      );
    }
  }

  // storage: buckets declarados pero sin ningún campo file que los referencie
  for (const bucketName of buckets) {
    if (!referencedBuckets.has(bucketName)) {
      warnings.push(
        `storage: buckets.${bucketName}: bucket declarado pero sin ningún campo file que lo referencie`
      );
    }
  }

  // messaging: eventos publicados que ninguna operación emite. Nada los produciría en
  // ejecución: o falta el emits en la operación que causa el hecho, o el evento sobra.
  // Con use-cases aún en plantilla no hay nada que contrastar (el pending ya lo dice).
  for (const eventName of operationNames.size > 0 ? publishedEvents : []) {
    if (!emittedEvents.has(eventName)) {
      warnings.push(
        `messaging: publishing.events.${eventName}: evento declarado pero ninguna operación lo emite (use-cases: emits) — nada lo publicaría`
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
