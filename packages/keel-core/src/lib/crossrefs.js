import { FRAMEWORK_ERRORS, overrideFor } from './framework-errors.js';

const BASE_TYPES = new Set(['string', 'text', 'int', 'long', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'json', 'file']);

// Statuses de éxito que por definición de HTTP no llevan cuerpo. El schema de api
// limita successStatus a 2xx, así que 304 no es alcanzable, pero se enumera igual:
// la regla es del protocolo, no del rango que hoy admita el schema.
const STATUSES_WITHOUT_BODY = new Set([204, 205, 304]);

/**
 * Validación mecánica de referencias cruzadas entre capas.
 * Recibe { layers } (ya validadas contra sus schemas) y devuelve { errors, warnings, pending }.
 * Con wip: true, las referencias hacia delante a una capa messaging aún no diseñada
 * (emits, cache.invalidatedBy) van a pending (diseño en progreso), no a errors.
 *
 * `scenarios` es el TEXTO de validation-scenarios.md, o null si no existe todavía. Se
 * recibe en vez de leerse: esta función es pura y no toca disco (lo lee validateService,
 * que es quien tiene el directorio). Solo hay una regla que lo mire —la obligación de los
 * dos escenarios de una compensación—, y existe porque ese documento es la única parte
 * del diseño que nada cruzaba con el resto: es prosa, y el gate conductual del generador
 * solo puntúa lo que el documento declara, así que un escenario que falta no lo echa de
 * menos nadie.
 *
 * La calidad semántica (invariantes ambiguas, mínimo privilegio...) es de la skill /keel-validate.
 */
export function checkCrossRefs({ layers, wip = false, scenarios = null }) {
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
  // Operaciones que encargan trabajo a otro servidor. `triggeredBy` es el único enlace del
  // DSL entre un caso de uso y el trabajo que delega, así que es también la única forma de
  // saber que repetir esa operación repite un efecto fuera de este proceso.
  const activatesProvider = new Set(
    Object.values(dependencies?.dependencies ?? {}).flatMap((dep) =>
      Object.values(dep.activations ?? {}).flatMap((spec) => spec.triggeredBy ?? [])
    )
  );
  const httpCallKeys = new Set(); // `${clientId}|${callName}` — lo llena el bloque http-clients
  const usedHttpCalls = new Set(); // clientes citados por algún need o activación (para detectar clientes sin dependencia)

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
      } else if (direction === 'output' && (payload.list === true || payload.paginated === true)) {
        // La simetría que faltaba. Un `sort` declarado se vigila con once reglas; su
        // AUSENCIA no se vigilaba con ninguna, y es el caso que esconde una decisión
        // en vez de una errata: hay un default correcto (orden por id, con su
        // desempate), así que nada se rompe y nada avisa.
        //
        // El problema no es el default: es que el orden es CONTRATO, y cuando el
        // diseño calla, la decisión se acaba tomando fuera del diseño — en la prosa de
        // validation-scenarios.md, que ningún schema contrasta, o en el adaptador que
        // el agente improvisa porque tiene que escribir algo. Las dos veces el
        // artefacto promete una cosa y el servicio hace otra, sin que nada lo cruce.
        // Por eso es aviso y no error: aceptar el orden por id es una decisión legítima
        // — lo que no es legítimo es no haberla tomado.
        warnings.push(
          `${where}: devuelve varios elementos y no declara 'sort' — el orden será por id del agregado. ` +
            (payload.paginated === true
              ? `Es contrato: es lo que recibe quien no pide un '?sort='. `
              : `Es contrato: es el orden en el que el consumidor recibe la colección. `) +
            `Si los escenarios o el consumidor asumen otro (más reciente primero, alfabético…), decláralo aquí en vez de darlo por hecho fuera del diseño`
        );
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

  // use-cases: transiciones de lifecycle que ejecuta cada operación. Es el único enlace
  // del DSL entre un caso de uso y la máquina de estados de domain, y lo que hace
  // verificable que la transición existe de verdad: el generador deriva un guard que
  // rechaza cualquier destino no declarado, así que una operación que pide una arista
  // que el lifecycle no tiene no falla al generar — falla en cada ejecución, en runtime.
  const executedTransitions = new Set(); // `${entidad}|${from}|${to}` (para la inversa)
  for (const [opName, op] of Object.entries(operations)) {
    if (!op.transitions) continue;
    // Una query no cambia de estado: si declara transiciones, una de las dos cosas miente.
    if (op.kind === 'query') {
      errors.push(`use-cases: ${opName}.transitions: una operación kind: query no cambia de estado`);
    }
    for (const [index, transition] of op.transitions.entries()) {
      const where = `use-cases: ${opName}.transitions[${index}]`;
      const entity = domain.entities?.[transition.entity];
      if (!entity) {
        errors.push(`${where}.entity: la entidad '${transition.entity}' no existe en domain: entities`);
        continue;
      }
      const lifecycle = entity.lifecycle;
      if (!lifecycle) {
        errors.push(
          `${where}.entity: la entidad '${transition.entity}' no declara lifecycle — sin máquina de estados no hay transición que ejecutar`
        );
        continue;
      }
      const values = enumValuesOf(entity.fields?.[lifecycle.field]);
      // Si el lifecycle está mal formado, el bloque de domain ya lo reportó: no se duplica.
      if (!values) continue;
      const valueSet = new Set(values);
      if (!valueSet.has(transition.to)) {
        errors.push(
          `${where}.to: el estado '${transition.to}' no es un valor del enum '${lifecycle.field}' de ${transition.entity}`
        );
        continue;
      }
      for (const from of transition.from ?? []) {
        if (!valueSet.has(from)) {
          errors.push(
            `${where}.from: el estado '${from}' no es un valor del enum '${lifecycle.field}' de ${transition.entity}`
          );
          continue;
        }
        if (!(lifecycle.transitions?.[from] ?? []).includes(transition.to)) {
          errors.push(
            `${where}: la transición '${from}' → '${transition.to}' no está declarada en ` +
              `domain: ${transition.entity}.lifecycle.transitions.${from} — el guard del generador la rechazaría siempre`
          );
          continue;
        }
        executedTransitions.add(`${transition.entity}|${from}|${transition.to}`);
      }
    }
  }

  // Inversa: una transición que ninguna operación ejecuta no es contrato, es intención.
  for (const [entityName, entity] of Object.entries(domain.entities ?? {})) {
    for (const [from, targets] of Object.entries(entity.lifecycle?.transitions ?? {})) {
      for (const to of targets ?? []) {
        if (!executedTransitions.has(`${entityName}|${from}|${to}`)) {
          warnings.push(
            `domain: ${entityName}.lifecycle.transitions.${from}: ninguna operación de use-cases declara ejecutar '${from}' → '${to}'`
          );
        }
      }
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
    // El status y el cuerpo son las dos mitades de la misma respuesta, y viven en capas
    // distintas: nada las cruzaba, así que un 204 con output entity llegaba intacto al
    // controller generado (build combina ambos tal cual vienen del diseño) y producía una
    // respuesta que ningún cliente HTTP puede consumir.
    const voidOutput = op.output === 'void';
    if (STATUSES_WITHOUT_BODY.has(endpoint.successStatus) && !voidOutput) {
      errors.push(
        `${where}.successStatus: ${endpoint.successStatus} es un status sin cuerpo y la operación declara output — sube el status a uno que admita cuerpo (200) o pon output: "void" en use-cases`
      );
    }
    if (endpoint.successStatus !== undefined && !STATUSES_WITHOUT_BODY.has(endpoint.successStatus) && voidOutput) {
      warnings.push(
        `${where}.successStatus: ${endpoint.successStatus} admite cuerpo y la operación declara output: "void" — la respuesta irá vacía; 204 describe mejor ese contrato`
      );
    }
    // DELETE sin successStatus: el generador asume 204 (no hay dónde declararlo si no).
    if (endpoint.successStatus === undefined && endpoint.method === 'DELETE' && !voidOutput) {
      warnings.push(
        `${where}: DELETE sin successStatus se genera como 204 (sin cuerpo) y la operación declara output — declara el successStatus que quieres o pon output: "void"`
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
  const apiEndpoints = new Set(Object.keys(api?.endpoints ?? {}));

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
  // Un consumidor de eventos recibe at-least-once: el mismo mensaje puede llegar dos veces
  // (reintento, redespliegue, fallo del ack). Dos mecanismos impiden que el efecto se
  // aplique dos veces, y basta con uno.
  //
  // `use-cases.<op>.idempotency` NO es uno de ellos, aunque lo parezca: es el otro eje de
  // repetición —el reintento de un llamante HTTP, identificado por la clave que manda en
  // una cabecera—. El broker no manda esa cabecera, así que en el camino de eventos esa
  // clave no existe y declararla no impide nada. Son dos mecanismos distintos incluso en
  // el código generado (`processed_event` frente a `idempotency_record`), y confundirlos
  // es peor que no tener la regla: da por protegida una operación que no lo está.
  // La envoltura efectiva, con el default que documenta docs/dsl/messaging.md: keel si el
  // canal no es external, none si lo es.
  const envelopeOf = (sub) => {
    const external = sub?.channel ? messaging?.channels?.[sub.channel]?.external === true : false;
    return sub?.contract?.envelope ?? (external ? 'none' : 'keel');
  };
  // La clave con la que el listener deduplica antes de llegar al dominio. Puede declararla
  // el contrato —una fuente ajena que la publica en un metadato del broker o en un campo—,
  // pero con la envoltura Keel existe sin declarar nada: `metadata.eventId`, estampado una
  // vez en el `raise`. Las dos alimentan el mismo `processed_event`, así que valen igual
  // como guarda; lo que no vale igual es exigir la declarada cuando ya hay envoltura, que
  // sería pedir un dato que ningún emisor Keel escribe.
  const listenerDedupeKeyOf = (sub) => Boolean(sub?.contract?.messageId) || envelopeOf(sub) === 'keel';
  // Una transición cuyo destino no está entre sus propios orígenes es irrepetible por
  // construcción: al segundo intento la entidad ya está en `to` y el guard la rechaza.
  // Es la única guarda que vive en el DOMINIO y no en un borde, así que vale para los
  // dos ejes de repetición —la reentrega del broker y el reintento del llamante HTTP—:
  // de ahí que la usen las dos reglas y no una copia cada una.
  const hasIrrepeatableTransition = (op) => (op?.transitions ?? []).some((t) => !(t.from ?? []).includes(t.to));

  // Los escenarios de un evento, troceados por su encabezado `### FL-XXX-NNN: …`. Se
  // busca el nombre del evento —un token PascalCase, inconfundible en prosa— y dentro de
  // los bloques que lo mencionan, la señal de que uno de ellos lo REENTREGA. Es una
  // lectura de texto, con lo que eso implica: puede no reconocer una redacción rara, así
  // que lo que produce es un aviso que dice «no encuentro», nunca un error que afirme que
  // no existe. El coste de equivocarse en esa dirección es una frase; en la contraria,
  // una compensación que deshace dos veces y ningún escenario que lo note.
  const REDELIVERY = /reentrega|reentregad|reentregar|mismo mensaje|mismo messageId|segundo efecto|dos veces|duplicad/i;
  // Señal de que el escenario ejercita la repetición SIMULTÁNEA, que no es la
  // secuencial con otras palabras: la de después encuentra la marca ya commiteada y
  // la resuelve una lectura; la de a la vez cae en la ventana en la que todavía no lo
  // está, que es donde vive el fallo y donde un servicio replicado pasa la mayor
  // parte de su vida. Por eso `dos veces` NO entra aquí aunque esté en REDELIVERY:
  // describe igual de bien las dos, y admitirla dejaría pasar el secuencial como si
  // fuera el simultáneo — que es exactamente el escenario que falta.
  const CONCURRENT = /simult[áa]ne|a la vez|al mismo tiempo|en paralelo|concurrent|carrera/i;
  const scenarioBlocks = (scenarios ?? '')
    .split(/^#{2,4}\s+(?=FL-)/m)
    .slice(1)
    .filter((block) => /^FL-[A-Za-z0-9-]+/.test(block));
  const scenariosMentioning = (eventName) => {
    const mention = new RegExp(`\\b${eventName}\\b`);
    return scenarioBlocks.filter((block) => mention.test(block));
  };
  const redeliveryGuardsOf = (eventName) => {
    const sub = messaging?.subscriptions?.[eventName];
    const op = operations[sub?.triggers];
    const guards = [];
    if (sub && listenerDedupeKeyOf(sub)) guards.push('messageId'); // deduplicación antes del dominio
    if (hasIrrepeatableTransition(op)) guards.push('transitions');
    return guards;
  };

  // El outbox es una tabla: la fila del evento se escribe en la MISMA transacción que el
  // cambio de estado y un relay la publica después. Sin capa `persistence` no hay dónde
  // escribirla, así que no hay nada que generar — y el generador no lo avisa, porque la
  // ausencia de una capa entera no es un campo que él mire: `keel-spring` simplemente no
  // genera outbox y publica en el acto. El diseño declara entrega garantizada y lo que se
  // construye es best-effort, que es la peor forma de equivocarse: la promesa sobrevive en
  // el documento y desaparece del servidor.
  if (messaging?.publishing?.reliability === 'outbox' && !persistence) {
    errors.push(
      `messaging: publishing.reliability: 'outbox' exige capa persistence — la fila del evento se escribe en la misma ` +
        `transacción que el cambio de estado, y sin almacén no hay dónde ponerla. Declara la capa persistence o baja a ` +
        `best-effort, que es lo que de verdad se generaría`
    );
  }

  // Escenario del outbox. La misma lectura de texto que la compensación, y por el
  // mismo motivo: el gate del generador solo puntúa lo que validation-scenarios.md
  // declara, así que un `reliability: outbox` sin escenario no lo echaba de menos
  // nadie — y es el mecanismo cuyo escenario decorativo es más fácil de escribir sin
  // darse cuenta. «El evento acaba llegando al canal» lo cumple igual un servicio que
  // publica en línea dentro de la transacción; lo que separa a los dos es la mitad
  // negativa (con el canal caído, la API responde igual y el canal sigue vacío), y por
  // eso lo que se busca aquí es la señal de la INDISPONIBILIDAD, no la del evento.
  if (scenarios !== null && messaging?.publishing?.reliability === 'outbox' && persistence) {
    const UNAVAILABLE = /(canal|broker|mensajer[íi]a)[^.]{0,60}(indisponible|no disponible|ca[íi]d|detenid|apagad|parad|fuera de servicio)/i;
    if (!scenarioBlocks.some((block) => UNAVAILABLE.test(block))) {
      warnings.push(
        `messaging: publishing.reliability: 'outbox' no tiene escenario que lo distinga de best-effort — no encuentro ` +
          `ninguno en validation-scenarios.md con el canal INDISPONIBLE. Un escenario que solo afirme que el evento ` +
          `acaba publicado lo pasa igual un servidor que publica en línea dentro de la operación, así que la garantía ` +
          `que compra este campo queda sin verificar. Añade uno que, con el canal caído, afirme que la mutación responde ` +
          `igual y que el canal sigue vacío, y que restablecido el evento llega exactamente una vez`
      );
    }
  }

  // Escenario de carrera de la clave de idempotencia, uno por operación que la
  // declare. La señal se busca solo entre los escenarios que mencionan la operación:
  // un servicio puede tener carreras de otras cosas, y encontrarlas no dice nada de
  // esta. Misma asimetría que en la compensación — el reintento secuencial encuentra
  // el registro de la clave ya commiteado y lo resuelve una lectura.
  if (scenarios !== null) {
    for (const [opName, op] of Object.entries(operations)) {
      if (!op?.idempotency) continue;
      const mentions = scenariosMentioning(opName);
      if (mentions.length > 0 && !mentions.some((block) => CONCURRENT.test(block))) {
        warnings.push(
          `use-cases: operations.${opName} declara idempotency pero sus escenarios no cubren la CARRERA — dos peticiones ` +
            `con la misma clave a la vez. El reintento secuencial encuentra el registro de la clave ya escrito, así que ` +
            `pasa aunque no haya nada que arbitre la ventana previa al commit, que es la que un cliente con reintentos ` +
            `automáticos golpea de verdad. El 'Then' es disyunción cerrada más un conteo por la API que afirme un solo recurso`
        );
      }
    }
  }

  for (const [eventName, event] of Object.entries(messaging?.publishing?.events ?? {})) {
    checkFieldMap(event.payload, `messaging: publishing.events.${eventName}.payload`);
    checkChannel(event.channel, `messaging: publishing.events.${eventName}.channel`);
    if (event.channel && messaging?.channels?.[event.channel]?.external === true) {
      warnings.push(
        `messaging: publishing.events.${eventName}.channel: '${event.channel}' está marcado external (lo posee otro sistema) — publicar ahí exige acuerdo con su dueño`
      );
    }
  }
  // Varias suscripciones sobre el MISMO canal: cada listener ve el destino entero y
  // tiene que saber qué mensajes son suyos. Con envoltura Keel eso ya está resuelto
  // —`metadata.eventType` lo estampa el emisor—, y exigir que se declare sería pedir
  // el mismo dato dos veces, igual que con `messageId`. Sin envoltura no lo está: los
  // payloads llegan crudos y sin discriminador el listener deserializa el mensaje de
  // otro, que según la forma del JSON falla con un error de parseo o —peor— cuela
  // campos a null y procesa un evento que no era el suyo.
  const subsByChannel = new Map();
  for (const [eventName, sub] of Object.entries(messaging?.subscriptions ?? {})) {
    if (!sub.channel) continue;
    if (!subsByChannel.has(sub.channel)) subsByChannel.set(sub.channel, []);
    subsByChannel.get(sub.channel).push([eventName, sub]);
  }
  for (const [channel, subs] of subsByChannel) {
    if (subs.length < 2) continue;
    const undiscriminated = subs.filter(
      ([, sub]) => envelopeOf(sub) !== 'keel' && !sub.contract?.discriminator
    );
    for (const [eventName] of undiscriminated) {
      warnings.push(
        `messaging: subscriptions.${eventName}.contract.discriminator: el canal '${channel}' lo comparten ${subs.length} suscripciones y esta no declara ` +
          `con qué distinguir sus mensajes de los demás. Sin envoltura Keel no hay 'metadata.eventType' que lo resuelva solo, así que el listener recibirá ` +
          `también los ajenos y los deserializará como propios`
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
    // Con la envoltura Keel la identidad del mensaje YA existe: `metadata.eventId`, que el
    // emisor estampa una vez en el `raise` y viaja intacta hasta el cable. Un `messageId`
    // propio no añade nada y sí quita: un emisor Keel no escribe metadatos nativos del
    // broker —la envoltura entera va en el cuerpo—, así que el listener leería vacío el
    // dato que el diseño le manda usar para deduplicar.
    if (envelopeOf(sub) === 'keel' && sub.contract?.messageId) {
      warnings.push(
        `${where}.contract.messageId: con envelope keel la identidad del mensaje ya es metadata.eventId (lo estampa el emisor en el raise y viaja intacto) — ` +
          `declararlo aparte apunta a un dato que ningún emisor Keel escribe y el listener lo leería vacío. Este campo es para envelope none/wrapped, canales external ` +
          `o fuentes que usan una propiedad nativa del broker`
      );
    }
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

    // Reintentar es pedir explícitamente que el mismo mensaje se entregue más de una vez.
    // Sin nada que lo impida, el efecto se aplica tantas veces como intentos haya.
    const maxAttempts = sub.onFailure?.retry?.maxAttempts ?? 1;
    if (maxAttempts > 1 && redeliveryGuardsOf(eventName).length === 0) {
      errors.push(
        `${where}: reintenta (maxAttempts: ${maxAttempts}) y nada impide que '${sub.triggers}' se aplique dos veces — ` +
          `la fuente no trae envoltura Keel, así que no hay metadata.eventId del que deduplicar: declara contract.messageId ` +
          `(el id que sí publique la fuente) o la transición de lifecycle que hace irrepetible la operación. La idempotency ` +
          `de la operación no vale aquí: su clave llega por cabecera HTTP y el broker no la manda`
      );
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

      // Reintentar una escritura ajena la ejecuta dos veces al otro lado. Nuestra
      // `idempotency` de use-cases protege de que un cliente nos repita a nosotros;
      // no protege de que nosotros repitamos al proveedor, y un timeout no dice si
      // el trabajo se hizo. Es además la deuda que las compensaciones intentan
      // arreglar después, cuando ya hay dos cobros. GET es seguro por definición.
      const unsafe = call.method && !['GET'].includes(call.method);
      if (call.retry && (call.retry.maxAttempts ?? 1) > 1 && unsafe && !call.idempotency) {
        warnings.push(
          `${where}: reintenta un ${call.method} sin declarar 'idempotency' — cada reintento vuelve a ejecutar el ` +
            `trabajo en el proveedor, y un timeout no distingue "no llegó" de "llegó y se hizo". Declara la clave que ` +
            `le mandas (idempotency.keyFrom) o, si el proveedor no la honra, deja escrito en 'contract' que reintentar ` +
            `duplica`
        );
      }
      // Al revés: prometer una clave sin decir cómo se llama la cabecera es del
      // schema; prometerla sin reintentos ni circuito no es un error, pero sí un
      // dato del contrato del proveedor que conviene que se lea.
      if (call.idempotency && call.method === 'GET') {
        warnings.push(
          `${where}: 'idempotency' en un GET no aporta nada — una lectura repetida no duplica ningún efecto`
        );
      }
    }
  }

  // dependencies: la capa de síntesis — solo referencia a las demás, nunca las redeclara.
  // Todo el bloque (incluidas las reglas inversas del final) va dentro de este if: un diseño
  // que no declara la capa no puede ganar avisos nuevos.
  if (dependencies) {
    const subscriptions = messaging?.subscriptions ?? {};
    const replicaEntities = new Map(); // entidad → primer need que la replica

    // `exposedAs` dice que el dato ajeno, además de servir para DECIDIR, viaja en la
    // salida de las operaciones que lo usan. Es el hermano de `embed` para datos que
    // no están en nuestra base, y se valida por lo mismo: que quepa donde dice que va.
    //
    // Sin este campo el dato se pedía, atravesaba el anticorrupción y se descartaba, y
    // no había forma de expresar otra cosa —la forma `{entity: X}` de un payload no
    // admite campos extra—. Tres diseños llegaron a producción así.
    const checkExposedAs = (spec, where) => {
      const field = spec.exposedAs;
      for (const opName of spec.usedBy ?? []) {
        const op = operations[opName];
        if (!op) continue; // el usedBy roto ya lo reporta su propia regla

        // Sin salida no hay dónde aterrizar, y el diseño se está contradiciendo:
        // declara que el dato se devuelve por una operación que no devuelve nada.
        if (op.output === 'void' || op.output == null) {
          errors.push(
            `${where}.exposedAs: '${opName}' no devuelve nada (output: void), así que el dato no tiene dónde viajar`
          );
          continue;
        }

        // Colisión con la entidad que se proyecta: el DTO tendría dos campos con el
        // mismo nombre, y el que gana lo decide el orden en que se generan.
        const entityName = op.output.entity;
        const entity = entityName ? domain.entities?.[entityName] : null;
        if (entity && (entity.fields?.[field] || entity.relations?.[field])) {
          errors.push(
            `${where}.exposedAs '${field}': '${entityName}' ya declara un campo o relación con ese nombre (output de '${opName}')`
          );
        }
        // Y con los campos que el propio payload declara a mano.
        if (op.output.fields?.[field]) {
          errors.push(
            `${where}.exposedAs '${field}': el output de '${opName}' ya declara un campo con ese nombre`
          );
        }

        // Una llamada al proveedor POR ELEMENTO. No es un error —el diseño puede
        // asumirlo a sabiendas— pero casi nunca es lo que se quiere, y el propio DSL
        // ofrece la salida: `replicated` mantiene la copia local y la lectura del
        // listado no sale del proceso. Es la misma clase de señal que la asimetría de
        // proyección de `embed`: no hace falta un escenario para verla, basta con
        // cruzar dos declaraciones del diseño.
        if (spec.strategy === 'on-demand' && (op.output.list || op.output.paginated)) {
          warnings.push(
            `${where}.exposedAs: '${opName}' devuelve varios elementos y la estrategia es on-demand, así que el proveedor recibe una llamada por elemento — si el dato se expone en un listado, la estrategia que lo evita es 'replicated'`
          );
        }
      }
    };

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

    // Una llamada saliente citada por un need (fetchedFrom) o por una activación (via).
    // Citarla es lo que justifica que el cliente exista: alimenta usedHttpCalls.
    const checkHttpCallRef = (ref, where) => {
      const { client, call } = ref;
      usedHttpCalls.add(client);
      if (!httpClients) {
        if (wip) {
          pending.push(`${where}: el cliente '${client}' está pendiente de definir en http-clients`);
        } else {
          errors.push(`${where}: el cliente '${client}' no está en http-clients: clients (no hay capa http-clients)`);
        }
      } else if (!(client in (httpClients.clients ?? {}))) {
        errors.push(`${where}: el cliente '${client}' no está en http-clients: clients`);
      } else if (!httpCallKeys.has(`${client}|${call}`)) {
        errors.push(`${where}: la llamada '${call}' no existe en http-clients: clients.${client}.calls`);
      }
    };

    // Un error de negocio citado por un need (onMiss) o por una activación (onFailure):
    // el generador solo lo genera si alguna operación lo declaró en su catálogo.
    const checkDeclaredError = (code, where, ops, opsField) => {
      if (!code) return;
      if (!declaredErrorCodes.has(code)) {
        errors.push(`${where}: el código '${code}' no lo declara ninguna operación de use-cases`);
      } else if (!(ops ?? []).some((opName) => errorCodesByOp.get(opName)?.has(code))) {
        warnings.push(`${where}: '${code}' no lo declara ninguna de las operaciones de ${opsField}`);
      }
    };

    // Un evento consumido del proveedor: existe como suscripción y su source concuerda.
    // `anySource`: si el evento consumido puede venir legítimamente de un servicio
    // distinto del proveedor. Los dos sitios que llaman aquí no quieren lo mismo, y la
    // asimetría es de fondo:
    //
    //   - `replica.fedBy` → NO. Una copia de un proveedor se alimenta de SUS eventos; que
    //     la alimente un tercero es casi siempre un error de referencia.
    //   - `compensations.onEvent` → SÍ. Que el fallo lo publique un tercero es la forma
    //     más común de saga —encargamos stock a inventory y lo que falla después es el
    //     pago, en payments— y avisar ahí empuja al diseño equivocado: la salida obvia
    //     para quitarse el aviso es mover la suscripción al proveedor, que es justo lo que
    //     no hay que hacer (quien encarga el trabajo es quien lo deshace). Lo que SÍ hay
    //     que comprobar en ese caso ya lo cubre la regla del alcance al proveedor, más
    //     abajo: sin evento suyo, el proveedor sigue creyendo que su encargo está en pie,
    //     así que exige la activación de vuelta.
    const checkConsumedEvent = (event, where, depName, label, { anySource = false } = {}) => {
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
      if (!anySource && source && source !== depName) {
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

        if (spec.exposedAs) {
          checkExposedAs(spec, where);
        }

        if (spec.fetchedFrom) {
          checkHttpCallRef(spec.fetchedFrom, `${where}.fetchedFrom`);

          // Qué ve el cliente cuando el proveedor no contesta. Es la mitad que le
          // faltaba a esta capa: la activación lo declara en `onFailure` y la réplica
          // en `onMiss`, pero el dato que se PIDE al proveedor no tenía dónde, así que
          // la respuesta acababa en la prosa del `fallback` de la llamada — capa
          // técnica, y prosa que ningún generador puede aplicar. Aviso y no error
          // porque el diseño sigue siendo legible sin ello; lo que no queda es
          // construible sin que alguien invente la política.
          if (!spec.onUnavailable) {
            const call = `${spec.fetchedFrom.client}.${spec.fetchedFrom.call}`;
            warnings.push(
              `${where}: no declara 'onUnavailable': si ${call} falla, el diseño no dice qué ve el cliente ` +
                `—fallar con un error propio, degradar, o servir el último valor conocido con su edad máxima—. ` +
                `El 'fallback' de la llamada es prosa en la capa técnica: describe el mecanismo, no la política, ` +
                `y quien construya elegirá por su cuenta`
            );
          } else {
            // Mismo trato que `onMiss.error` y `onFailure.error`: el generador lanza esa
            // excepción y solo existe si alguna operación la declaró en su catálogo.
            checkDeclaredError(spec.onUnavailable.error, `${where}.onUnavailable.error`, spec.usedBy, 'usedBy');
          }
        }

        if (spec.replica) {
          checkReplica(spec.replica, need, where);
          for (const event of spec.replica.fedBy ?? []) {
            checkConsumedEvent(event, `${where}.replica.fedBy`, depName, 'suscripción');
          }

          // Que el error exista es error duro: el generador lanza esa excepción y solo
          // la genera si alguna operación la declaró en su catálogo.
          checkDeclaredError(spec.replica.onMiss?.error, `${where}.replica.onMiss.error`, spec.usedBy, 'usedBy');
        }
      }

      // Activaciones: la otra forma de depender. Se le pide trabajo al proveedor, así que
      // lo que se comprueba no es de dónde se lee un dato, sino que el canal por el que se
      // le pide exista de verdad y que la operación propia sepa qué hacer si no sale.
      for (const [action, spec] of Object.entries(dep.activations ?? {})) {
        const where = `dependencies: ${depName}.activations.${action}`;

        for (const opName of spec.triggeredBy ?? []) {
          if (!operationNames.has(opName)) {
            errors.push(`${where}.triggeredBy: la operación '${opName}' no existe en use-cases`);
          }
        }

        const via = spec.via ?? {};
        if (via.client) {
          checkHttpCallRef(via, `${where}.via`);
        } else if (via.publishes) {
          if (!publishedEvents.has(via.publishes)) {
            if (!messaging && wip) {
              pending.push(`${where}.via: el evento '${via.publishes}' está pendiente de definir en messaging: publishing`);
            } else {
              errors.push(
                `${where}.via: el evento '${via.publishes}' no está en messaging: publishing.events` +
                  (messaging ? '' : ' (no hay capa messaging)')
              );
            }
          }
          // Encargar trabajo publicando se apoya en que el evento salga sí o sí: por eso el
          // schema prohíbe `onFailure` en esta rama —no hay fallo que capturar— y por eso no
          // hay reintento que declarar. Pero esa garantía no la da publicar, la da el outbox:
          // con `best-effort` el evento se manda y punto, y si el broker no está el encargo se
          // pierde sin dejar rastro ni aquí ni en el proveedor. Y no hay compensación que
          // valga para un trabajo que nunca llegó a encargarse: no hay nada que deshacer y
          // nadie que publique el fallo. Es el único sitio donde `reliability` deja de ser una
          // preferencia de entrega y pasa a sostener una dependencia.
          if (publishedEvents.has(via.publishes) && (messaging?.publishing?.reliability ?? 'best-effort') !== 'outbox') {
            warnings.push(
              `${where}.via: el encargo a '${depName}' viaja publicando '${via.publishes}', pero messaging declara ` +
                `reliability: ${messaging?.publishing?.reliability ?? 'best-effort'} — si el broker no está en ese instante ` +
                `el encargo se pierde en silencio, y no hay compensación posible de un trabajo que nunca se pidió. ` +
                `Declara publishing.reliability: outbox`
            );
          }
          // Publicar no devuelve resultado: si la operación necesita el desenlace para
          // continuar, el canal tiene que ser síncrono. Es una contradicción del diseño,
          // no una preferencia de implementación.
          if (spec.awaits === 'outcome') {
            errors.push(
              `${where}.awaits: 'outcome' exige un canal síncrono — publicar '${via.publishes}' no devuelve el resultado del trabajo`
            );
          }
        }

        checkDeclaredError(spec.onFailure?.error, `${where}.onFailure.error`, spec.triggeredBy, 'triggeredBy');

        // La reconciliación es un barrido, no una reacción: si no corre sola, no
        // corre. Una operación sin `schedule` que se declare aquí es una promesa
        // que nadie cumple — y justo la que se cumple sola cuando todo va bien.
        if (spec.reconciledBy) {
          // Cuánto silencio se tolera. El barrido no puede escribirse sin este número, así
          // que no declararlo no lo elimina: lo traslada a quien construya, y ahí queda
          // fuera del diseño y de su revisión. Los dos lados duelen —por debajo el barrido
          // insiste antes de que al proveedor le haya dado tiempo a contestar, y cada
          // insistencia es trabajo repetido contra él; por encima, un encargo perdido tarda
          // de más en detectarse— y cuál es el correcto depende del proveedor, que es justo
          // lo que el diseñador sabe y el generador no.
          if (spec.unansweredAfterSeconds == null) {
            warnings.push(
              `${where}.reconciledBy: no declara 'unansweredAfterSeconds', así que el diseño no dice cuánto ` +
                `silencio de ${depName} se tolera antes de volver a insistir. El barrido necesita ese umbral para ` +
                `elegir candidatos: sin declararlo lo fija quien construya, y deja de ser una decisión revisable`
            );
          }
          const sweeper = operations[spec.reconciledBy];
          if (!sweeper) {
            errors.push(`${where}.reconciledBy: la operación '${spec.reconciledBy}' no existe en use-cases`);
          } else if (!sweeper.schedule) {
            errors.push(
              `${where}.reconciledBy: '${spec.reconciledBy}' no declara 'schedule' — la reconciliación detecta lo que ` +
                `NO ha pasado (un desenlace que no llegó), así que nada la dispara salvo el reloj`
            );
          } else if (sweeper.kind === 'query') {
            errors.push(
              `${where}.reconciledBy: '${spec.reconciledBy}' es kind: query — reconciliar es corregir el estado, no leerlo`
            );
          } else {
            // Hasta aquí solo se ha comprobado la FORMA del barrido: que exista, que lo
            // dispare el reloj y que no sea una lectura. Falta lo que lo hace un barrido
            // de ESTO: un `schedule` que no toca nada de esta activación cumple las tres
            // condiciones y no reconcilia nada — y como es la pata del silencio, nadie se
            // entera nunca. Son las MISMAS dos salidas que §3.11 le pregunta al diseñador
            // —«¿qué hace con lo que encuentra: reintentar el encargo o compensarlo?»— más
            // la de rendirse, y basta con una:
            //
            //   - mueve el lifecycle de alguna entidad que dejó esperando el encargo
            //     (se rinde y la saca de ahí), o
            //   - encarga algo a ESTE MISMO proveedor: reintentar el encargo (aparece en
            //     el `triggeredBy` de esta activación) o compensarlo (en el de la
            //     activación de vuelta). Las dos son un `triggeredBy` de la dependencia,
            //     y por eso no se distinguen aquí: distinguirlas obligaría a adivinar
            //     cuál de las activaciones deshace a cuál, que es lo que `undoes` declara
            //     en `compensations` y no en este lado.
            //
            // Sin ninguna de las dos, el generador tampoco tiene por dónde: `triggeredBy`
            // y `transitions` son el único enlace del DSL entre una operación y lo que
            // hace, así que el stub del barrido nace sin cliente que llamar ni estado que
            // mover. Aviso y no error: el desenlace puede ser solo avisar a un operador,
            // pero entonces se dice, no se deja implícito.
            const waiting = new Set(
              (spec.triggeredBy ?? [])
                .flatMap((name) => operations[name]?.transitions ?? [])
                .map((transition) => transition.entity)
            );
            // Antes que el enlace, el requisito. Reconciliar es barrer lo que se quedó
            // ESPERANDO, así que hace falta un estado del lifecycle que signifique eso —y
            // lo crea la operación que encarga, moviendo la entidad al pedir el trabajo—.
            // Si ninguna de las que disparan esta activación mueve ningún lifecycle, no
            // hay nada parado que encontrar: el barrido correría cada N minutos sobre una
            // consulta que no puede escribirse. Va aparte del enlace de abajo porque un
            // barrido que reencarga lo enmascara: cumpliría esa comprobación y seguiría
            // sin tener qué barrer.
            if (waiting.size === 0) {
              warnings.push(
                `${where}.reconciledBy: ninguna de las operaciones que encargan '${action}' mueve el lifecycle de nada, ` +
                  `así que no hay un estado que signifique «esperando» y el barrido no tiene qué buscar. Reconciliar es ` +
                  `sacar de la espera lo que se quedó ahí: o la operación que encarga deja la entidad en ese estado ` +
                  `—declarando su 'transitions'— o, si el desenlace se conoce en el acto, lo que sobra es 'reconciledBy'`
              );
            } else {
              // Y con el estado de espera ya declarado, el enlace: qué hace el barrido con
              // lo que encuentra.
              const movesWaiting = (sweeper.transitions ?? []).some((transition) => waiting.has(transition.entity));
              const encargaAlProveedor = Object.values(dep.activations ?? {}).some((activation) =>
                (activation.triggeredBy ?? []).includes(spec.reconciledBy)
              );
              if (!movesWaiting && !encargaAlProveedor) {
                warnings.push(
                  `${where}.reconciledBy: '${spec.reconciledBy}' corre por el reloj, pero nada en el diseño lo enlaza con ` +
                    `lo que tiene que reconciliar: no declara ninguna transición sobre ${[...waiting].join(', ')} —las ` +
                    `entidades que este encargo dejó esperando— ni aparece en el triggeredBy de ninguna activación de ` +
                    `'${depName}' para reintentar el encargo o compensarlo. Un barrido que no toca lo que barre pasa esta ` +
                    `validación y no reconcilia nada, y es justo el camino que nadie ejercita: declara la transición de ` +
                    `salida, el reintento del encargo o la activación de vuelta`
                );
              }

              // Y lo que cuesta barrer. La consulta del barrido filtra por el estado de
              // espera y corre cada N minutos EN CADA RÉPLICA; sin un índice que empiece
              // por ese campo es un recorrido completo de la tabla, repetido para siempre.
              // No lo delata nada —el barrido es correcto, solo caro— y a escala se lleva
              // por delante la caché de la base que sirve al camino feliz, así que el
              // síntoma aparece lejos de la causa. Es lo único de este bloque que el
              // diseño puede cerrar por sí solo: el campo lo nombra el lifecycle y el
              // índice se declara en persistence.
              //
              // «Que EMPIECE por el campo» y no «que lo contenga»: un índice (customerId,
              // status) no sirve para filtrar por status. Aviso y no error —un índice no
              // es corrección— y redactado como el hecho que es, porque un orden distinto
              // puede ser deliberado.
              for (const waitingEntity of waiting) {
                // `persistence` puede no estar declarada (no es capa requerida): sin ella
                // no hay tabla de la que hablar, y el aviso no aplica.
                const stored = persistence?.entities?.[waitingEntity];
                const stateField = domain.entities?.[waitingEntity]?.lifecycle?.field;
                if (!stored || stored.persisted === false || !stateField) continue;
                if ((stored.indexes ?? []).some((index) => index[0] === stateField)) continue;
                warnings.push(
                  `${where}.reconciledBy: el barrido '${spec.reconciledBy}' busca ${waitingEntity} por su estado de espera, ` +
                    `pero ningún índice de persistence.entities.${waitingEntity} empieza por '${stateField}' — esa consulta ` +
                    `recorre la tabla entera cada vez que corre el schedule, y en cada réplica. Nada más lo va a señalar: ` +
                    `el barrido sigue siendo correcto, solo caro. Declara ` +
                    `persistence.entities.${waitingEntity}.indexes: [[${stateField}, <campo de la marca de espera>]]`
                );
              }
            }
          }
        }
      }

      // Compensaciones. Hasta aquí solo se comprobaba que las referencias existieran, que
      // es tratarlas como un hecho de topología. Pero una compensación es el punto del
      // diseño donde un fallo silencioso cuesta más caro: se ejecuta ante un evento de
      // fallo, por un canal at-least-once, y deshace trabajo real. Aplicarla dos veces
      // libera el stock dos veces o reembolsa dos veces, y dejar la entidad propia en el
      // estado que le puso el trabajo que se acaba de deshacer es una inconsistencia que
      // ninguna otra capa ve.
      const activationNames = new Set(Object.keys(dep.activations ?? {}));
      for (const [index, compensation] of (dep.compensations ?? []).entries()) {
        const where = `dependencies: ${depName}.compensations[${index}]`;
        // anySource: el fallo que dispara una compensación lo puede publicar el proveedor
        // (ya sabe que su trabajo no vale) o un tercero (no lo sabe, y hay que decírselo).
        // Las dos son formas legítimas y se distinguen más abajo, no aquí.
        checkConsumedEvent(compensation.onEvent, where, depName, 'suscripción', { anySource: true });
        if (compensation.undoes && !activationNames.has(compensation.undoes)) {
          errors.push(`${where}.undoes: la activación '${compensation.undoes}' no existe en ${depName}.activations`);
        }
        // Sin `undoes` el par hacer/deshacer no es verificable: nada puede contrastar que la
        // compensación devuelva el estado que movió el trabajo encargado, ni saber qué encargo
        // se queda sin deshacer si esta compensación desaparece. Y no es una comprobación
        // menos: su ausencia apaga en cascada las CUATRO reglas que hacen que una compensación
        // sea algo más que una suscripción con buen nombre. Un aviso que desactiva media
        // sección de validación no está proporcionado al daño, así que es error mientras haya
        // activaciones — sin ellas, lo que se deshace es otra cosa y el campo no tendría a qué
        // apuntar.
        if (!compensation.undoes && activationNames.size > 0) {
          errors.push(
            `${where}: no declara 'undoes' habiendo activaciones en '${depName}' (${[...activationNames].join(', ')}) — ` +
              `sin él el par hacer/deshacer no es verificable y quedan sin evaluar las cuatro comprobaciones que dependen ` +
              `de saber qué encargo se deshace: el estado de vuelta, el alcance al proveedor, la reconciliación del ` +
              `desenlace silencioso y la saga incompleta. Declara cuál de esas activaciones deshace`
          );
        }

        // Los tres escenarios obligatorios. La regla la escribe docs/validation-scenarios.md
        // § Reglas de cobertura, pero hasta ahora vivía solo ahí: el documento es prosa y
        // el gate conductual del generador puntúa lo declarado contra lo ejercitado, así
        // que una compensación sin escenario de reentrega salía verde por los dos lados —
        // el diseño no lo exigía y el generador no lo echaba de menos. Y es exactamente el
        // camino que menos se prueba a mano: solo se ejecuta cuando algo ya salió mal.
        if (scenarios !== null) {
          const mentions = scenariosMentioning(compensation.onEvent);
          if (mentions.length === 0) {
            warnings.push(
              `${where}: no encuentro ningún escenario de validation-scenarios.md que mencione '${compensation.onEvent}' — ` +
                `una compensación necesita tres: el efecto completo (llega el evento, el trabajo se deshace y el estado ` +
                `propio vuelve, leído por la API), la reentrega del mismo evento sin segundo efecto, y la entrega del ` +
                `mismo evento dos veces A LA VEZ`
            );
          } else {
            if (!mentions.some((block) => REDELIVERY.test(block))) {
              warnings.push(
                `${where}: los escenarios de '${compensation.onEvent}' cubren el efecto pero no encuentro el de REENTREGA — ` +
                  `deshacer dos veces el mismo trabajo no es deshacerlo, y es lo único que prueba que la guarda declarada ` +
                  `funciona de verdad. Añade un escenario que entregue el mismo mensaje otra vez y afirme que no hay ` +
                  `segundo efecto`
              );
            }
            // La tercera comprobación, y la que más se confunde con la anterior: un
            // escenario que reentrega DESPUÉS encuentra la marca de procesado ya
            // escrita y pasa aunque la guarda no cubra la ventana previa al commit —
            // que con varias réplicas es el caso frecuente. Se pide por separado
            // porque prueba algo distinto, no porque sea más exhaustivo.
            if (!mentions.some((block) => CONCURRENT.test(block))) {
              warnings.push(
                `${where}: los escenarios de '${compensation.onEvent}' no cubren la DOBLE ENTREGA SIMULTÁNEA — la ` +
                  `reentrega secuencial encuentra la marca de procesado ya escrita, así que pasa aunque la guarda no ` +
                  `cubra la ventana en la que aún no lo está, que es donde el fallo ocurre de verdad. Añade un escenario ` +
                  `que entregue el mismo mensaje dos veces a la vez y afirme el mismo efecto único`
              );
            }
          }
        }

        const sub = subscriptions[compensation.onEvent];
        const undoOpName = sub?.triggers;
        const undoOp = operations[undoOpName];
        if (!undoOp) continue; // suscripción o triggers inexistentes: ya está reportado

        if (undoOp.kind === 'query') {
          errors.push(
            `${where}: la operación '${undoOpName}' que dispara la compensación es kind: query — una lectura no deshace nada`
          );
        }

        const guards = redeliveryGuardsOf(compensation.onEvent);
        if (guards.length === 0) {
          errors.push(
            `${where}: la compensación se ejecuta ante un evento que puede reentregarse y nada impide que '${undoOpName}' ` +
              `se aplique dos veces (deshacer dos veces el mismo trabajo no es deshacerlo) — la fuente no trae envoltura Keel, ` +
              `así que no hay metadata.eventId del que deduplicar: declara contract.messageId en ` +
              `messaging: subscriptions.${compensation.onEvent} o la transición de lifecycle que la hace irrepetible. ` +
              `La idempotency de la operación no vale aquí: su clave llega por cabecera HTTP y el broker no la manda`
          );
        } else if (
          guards.length === 1 &&
          guards[0] === 'transitions' &&
          sub.channel &&
          messaging?.channels?.[sub.channel]?.external === true
        ) {
          // Sin envoltura Keel el consumidor no tiene un id de mensaje por defecto con el
          // que deduplicar antes: la reentrega llega al dominio y sale rechazada por el
          // guard. Es correcto, pero cada reentrega normal acaba en la cola de descartes.
          warnings.push(
            `${where}: sobre el canal externo '${sub.channel}' la reentrega solo la frena el guard de lifecycle de '${undoOpName}' — ` +
              `declara contract.messageId para deduplicar antes de llegar al dominio y no mandar a la DLQ una reentrega normal`
          );
        }

        // Llegar fuera de orden. Entre que este servicio confirma su trabajo y que el
        // proveedor publica su fallo no hay ninguna garantía de orden: el evento de
        // compensación puede llegar ANTES del hecho que compensa. Y entonces se rechaza
        // —el guard de lifecycle no admite la transición desde un estado al que aún no se
        // ha llegado, y sin guard el handler no encuentra qué deshacer—, así que lo que
        // decide el desenlace es la política de la suscripción: sin reintentos el mensaje
        // se pierde, y lo que se pierde es lo que deshace trabajo real contra otro
        // servidor. No es un caso exótico; es el orden normal de dos hechos concurrentes.
        const attempts = sub.onFailure?.retry?.maxAttempts ?? 1;
        if (attempts <= 1 && !sub.onFailure?.deadLetter) {
          errors.push(
            `${where}: la suscripción a '${compensation.onEvent}' no reintenta ni tiene deadLetter — un evento de ` +
              `compensación que llegue antes del hecho que compensa se rechaza y se pierde en silencio, y con él el ` +
              `trabajo que nadie deshará. Declara onFailure.retry (absorbe la carrera sin intervención) o, como mínimo, deadLetter`
          );
        } else if (attempts <= 1) {
          warnings.push(
            `${where}: la suscripción a '${compensation.onEvent}' no reintenta, así que una llegada fuera de orden ` +
              `acaba en la DLQ al primer intento — se salva el mensaje, pero exige intervención manual para una carrera ` +
              `que unos reintentos con backoff resolverían solos`
          );
        }

        // Guarda de puerta frente a guarda de dominio. `contract.messageId` deduplica en
        // el listener y la `idempotency` HTTP en el filtro: cada uno cierra SU puerta y no
        // sabe de la otra — son dos tablas con espacios de clave distintos (processed_event,
        // por listener y id de mensaje; idempotency_record, por operación y clave del
        // cliente). Si la compensación además se puede invocar por HTTP, una guarda de
        // puerta deja el otro camino abierto; y ese llamante —el operador que la reejecuta
        // a mano— es justo el que no manda cabecera, así que añadir `idempotency` tampoco
        // lo cierra. Lo único que protege por debajo de las dos puertas es el guard del
        // agregado, porque vive en el dominio y no en el borde.
        const undone = compensation.undoes ? (dep.activations?.[compensation.undoes] ?? null) : null;
        const reachableByHttp = Boolean(api && (autoCoversOp(undoOpName) || apiEndpoints.has(undoOpName)));

        // El silencio. Toda esta compensación cuelga de que llegue un evento, y hay
        // un desenlace en el que no llega ninguno: el proveedor cae, pierde el
        // mensaje, o ni siquiera sabe que su trabajo hay que deshacerlo. Entonces el
        // encargo queda hecho, nuestro estado queda donde lo dejó, y no hay ningún
        // hecho que dispare nada — el sistema no está roto, está callado, que es
        // peor. Lo único que detecta lo que NO pasa es un barrido.
        if (undone && !undone.reconciledBy) {
          warnings.push(
            `${where}: la compensación solo se dispara si llega '${compensation.onEvent}'. Si ese evento no llega nunca ` +
              `—el proveedor cae, el mensaje se pierde, o el fallo ni se publica— el encargo de '${compensation.undoes}' ` +
              `queda hecho y nadie lo deshace. Declara ${depName}.activations.${compensation.undoes}.reconciledBy con una ` +
              `operación programada que barra los encargos sin desenlace`
          );
        }

        // Y el otro final silencioso: la DLQ. Es la red que exige la regla de arriba,
        // pero un mensaje ahí es trabajo que nadie deshizo esperando a que alguien
        // lo mire. Si el diseño no dice por dónde se reejecuta —ni endpoint ni
        // barrido— ese alguien tendrá que abrir la base de datos a mano.
        if (sub.onFailure?.deadLetter && !reachableByHttp && !undone?.reconciledBy) {
          warnings.push(
            `${where}: la suscripción manda a la DLQ lo que no logra procesar, y lo que caiga ahí no tiene forma declarada ` +
              `de reejecutarse: '${undoOpName}' no se expone por HTTP ni hay reconciliación que lo barra. Un mensaje en la ` +
              `DLQ es trabajo sin deshacer esperando a que alguien lo note`
          );
        }

        if (reachableByHttp && !guards.includes('transitions')) {
          errors.push(
            `${where}: '${undoOpName}' se puede ejecutar por dos caminos (la suscripción a '${compensation.onEvent}' y su ` +
              `endpoint HTTP), y lo declarado solo protege el de eventos — deduplicar el mensaje no impide una segunda ` +
              `ejecución por HTTP. Declara la transición de lifecycle que la hace irrepetible: es la única guarda que vive ` +
              `en el dominio y cubre los dos caminos. Añadir idempotency no basta: sin cabecera se ejecuta sin deduplicar, ` +
              `y quien la reejecuta a mano no la manda`
          );
        }

        // El par hacer/deshacer completo: si el trabajo que se encargó movió el estado
        // propio, deshacerlo contra el proveedor sin devolver ese estado deja la entidad
        // donde la dejó un trabajo que ya no existe.
        if (compensation.undoes && activationNames.has(compensation.undoes)) {
          const movedEntities = new Set(
            (dep.activations[compensation.undoes].triggeredBy ?? [])
              .flatMap((name) => operations[name]?.transitions ?? [])
              .map((transition) => transition.entity)
          );
          const restoredEntities = new Set((undoOp.transitions ?? []).map((transition) => transition.entity));
          for (const entityName of movedEntities) {
            if (!restoredEntities.has(entityName)) {
              warnings.push(
                `${where}: la activación '${compensation.undoes}' se dispara desde operaciones que mueven el lifecycle de ` +
                  `'${entityName}', y '${undoOpName}' no declara ninguna transición sobre esa entidad — ¿a qué estado vuelve?`
              );
            }
          }

          // Y el destino de la vuelta. Devolver el estado no basta si de ese estado no sale
          // ninguna transición: la entidad queda parada para siempre donde la dejó una
          // compensación, y el trabajo que se acaba de deshacer no se puede volver a
          // encargar. A veces es exactamente lo correcto —`cancelled` y `refunded` son
          // desenlaces, no callejones—, y distinguir un desenlace de un callejón es juicio
          // semántico, de /keel-validate. Lo mecánico es el dato: aquí se pone encima de la
          // mesa que la máquina de estados no deja salir de ahí.
          for (const transition of undoOp.transitions ?? []) {
            if (!movedEntities.has(transition.entity)) continue;
            const outgoing = domain.entities?.[transition.entity]?.lifecycle?.transitions?.[transition.to];
            if (Array.isArray(outgoing) && outgoing.length === 0) {
              warnings.push(
                `${where}: '${undoOpName}' devuelve '${transition.entity}' a '${transition.to}', que es un estado terminal ` +
                  `de su lifecycle — de ahí no sale ninguna transición, así que el trabajo que se acaba de deshacer no se ` +
                  `puede volver a encargar. Si '${transition.to}' es el desenlace definitivo, correcto; si se esperaba ` +
                  `reintentar, el destino de la compensación es otro`
              );
            }
          }

          // La otra mitad. Deshacer el estado propio es la parte que se ve al probar; el
          // trabajo encargado vive en el proveedor, y ahí solo hay dos desenlaces buenos:
          // o el proveedor ya sabe que aquello no vale, o alguien se lo dice.
          //
          // Lo sabe cuando el evento que dispara la compensación lo publica ÉL: rechazar
          // el trabajo y avisar es la misma acción, y pedirle además que lo deshaga sería
          // hablar de más. Cuando el disparo viene de otro sitio —un fallo nuestro
          // posterior, un tercero— el proveedor sigue creyendo que su encargo está en pie,
          // y quien tiene que sacarlo de ese error es este servicio. Si la operación
          // compensadora no aparece en ningún `triggeredBy` ni `usedBy` de la dependencia,
          // no tiene por dónde: `triggeredBy` y `usedBy` son el único enlace del DSL entre
          // un caso de uso y el trabajo que delega, así que el generador no le inyecta
          // cliente alguno y el camino de menor resistencia del agente es no llamar a
          // nadie. Aviso y no error: la deuda puede ser tolerable (un correo que ya se
          // envió no se desenvía), pero se decide, no se olvida.
          const fromProvider = !sub.source || sub.source === depName;
          const reachesProvider =
            Object.values(dep.activations ?? {}).some((spec) => (spec.triggeredBy ?? []).includes(undoOpName)) ||
            Object.values(dep.needs ?? {}).some((spec) => (spec.usedBy ?? []).includes(undoOpName));
          if (undone.via?.client && !fromProvider && !reachesProvider) {
            warnings.push(
              `${where}: '${undoOpName}' devuelve el estado propio, pero '${compensation.onEvent}' lo publica '${sub.source}' ` +
                `y no '${depName}' — para '${depName}' el trabajo de '${compensation.undoes}' sigue en pie, y nada en el diseño ` +
                `se lo desmiente: '${undoOpName}' no aparece en ningún 'triggeredBy' ni 'usedBy' suyo, así que tampoco recibe su ` +
                `cliente. Declara la activación de vuelta con triggeredBy: [${undoOpName}], o deja escrito por qué la deuda con ` +
                `'${depName}' es tolerable`
            );
          }
        }
      }
    }

    // La saga incompleta. Una operación que encarga trabajo a DOS proveedores tiene un
    // punto intermedio: el primero ya está hecho y el segundo aún no. Si el diseño
    // declara cómo deshacer uno de esos encargos, está admitiendo que ese punto
    // intermedio existe y que hay que salir de él — y entonces callar sobre el otro
    // encargo no es una decisión, es un olvido. Es la deuda que menos se ve, porque
    // cada dependencia se lee por separado y el hueco solo aparece al cruzarlas.
    const encargosPorOperacion = new Map();
    const compensadas = new Set();
    for (const [depName, dep] of Object.entries(dependencies.dependencies ?? {})) {
      for (const [action, spec] of Object.entries(dep.activations ?? {})) {
        for (const opName of spec.triggeredBy ?? []) {
          if (!encargosPorOperacion.has(opName)) encargosPorOperacion.set(opName, []);
          encargosPorOperacion.get(opName).push({ depName, action });
        }
      }
      for (const compensation of dep.compensations ?? []) {
        if (compensation.undoes) compensadas.add(`${depName}|${compensation.undoes}`);
      }
    }
    for (const [opName, encargos] of encargosPorOperacion) {
      if (new Set(encargos.map((e) => e.depName)).size < 2) continue;
      const conVuelta = encargos.filter((e) => compensadas.has(`${e.depName}|${e.action}`));
      const sinVuelta = encargos.filter((e) => !compensadas.has(`${e.depName}|${e.action}`));
      // Sin ninguna compensación no hay contradicción que señalar: el diseño no ha
      // admitido todavía que el encargo pueda tener que deshacerse.
      if (conVuelta.length === 0 || sinVuelta.length === 0) continue;
      warnings.push(
        `dependencies: la operación '${opName}' encarga trabajo a varios proveedores y solo declara cómo deshacer el de ` +
          `${conVuelta.map((e) => `${e.depName}.${e.action}`).join(', ')} — si falla después de haber encargado los dos, ` +
          `${sinVuelta.map((e) => `${e.depName}.${e.action}`).join(', ')} queda hecho y nadie lo deshace. Declara su ` +
          `compensación o deja escrito por qué esa deuda es tolerable`
      );
    }

    // Inversas: todo canal de integración existe porque alguna dependencia lo justifica.
    const declaredDependencies = new Set(Object.keys(dependencies.dependencies ?? {}));
    for (const clientId of Object.keys(httpClients?.clients ?? {})) {
      if (!usedHttpCalls.has(clientId)) {
        warnings.push(
          `http-clients: clients.${clientId}: ningún need ni activación de dependencies lo usa — ¿de qué dependencia forma parte?`
        );
      }
    }
    for (const [event, sub] of Object.entries(subscriptions)) {
      // Una suscripción `request` es una puerta de entrada nuestra, no una dependencia:
      // quien la emite se acopla a nosotros, y exigirle un bloque en dependencies
      // invertiría el sentido del acoplamiento.
      if (sub.nature === 'request') continue;
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

    // Dot-path sobre una relación a una entidad del MISMO agregado. Solo tiene
    // sentido con `model: document`: ahí la hija va anidada dentro del documento de
    // su raíz, así que 'sections.status' es una ruta real del mismo registro. En el
    // modelo relacional la hija vive en otra tabla y un índice no la alcanza.
    const relationTarget = relations[head]?.entity ?? relations[head.replace(/Id$/, '')]?.entity;
    if (relationTarget) {
      if (persistence?.default?.model !== 'document') {
        errors.push(
          `${where}: '${member}': '${head}' es una relación, y solo se puede indexar por un campo suyo con 'default.model: document' (ahí la entidad va anidada en el mismo registro); en el modelo relacional vive en otra tabla`
        );
        return;
      }
      if (!aggregateMembers(entityName).has(relationTarget)) {
        errors.push(
          `${where}: '${member}': '${relationTarget}' es otro agregado, del que este solo guarda el id; indexa por '${head}Id' o por un campo propio`
        );
        return;
      }
      const targetFields = domain.entities?.[relationTarget]?.fields ?? {};
      if (!(rest[0] in targetFields)) {
        errors.push(`${where}: '${member}': la entidad '${relationTarget}' no declara el campo '${rest[0]}'`);
      }
      return;
    }

    // 'price.amount': el campo debe ser de un value type compuesto que declare ese subcampo.
    const subFields = domain.types?.[fields[head]?.type]?.fields;
    if (!subFields) {
      errors.push(`${where}: '${member}': '${head}' no es un value type compuesto de la entidad '${entityName}'`);
    } else if (!(rest[0] in subFields)) {
      errors.push(`${where}: '${member}': el tipo '${fields[head].type}' no declara el campo '${rest[0]}'`);
    }
  };

  // Entidades que comparten agregado con `entityName` (la raíz y sus internas).
  // Es lo que distingue "va anidada en el mismo registro" de "es otro agregado, del
  // que solo se guarda el id" — la frontera que ningún índice puede cruzar.
  const aggregateMembers = (entityName) => {
    for (const agg of Object.values(domain.aggregates ?? {})) {
      const members = new Set([agg.root, ...(agg.entities ?? [])]);
      if (members.has(entityName)) return members;
    }
    return new Set([entityName]);
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
  // Los DOS desenlaces de conflicto que trae encender `idempotency`, y que el diseño casi
  // nunca nombra porque no los provoca su lógica: los provoca el mecanismo. El generador
  // los emite con el código canónico del catálogo —si no, cada generación elegiría el suyo,
  // que es lo que pasó en tres corridas seguidas—, pero el diseñador no se entera de que
  // ese contrato existe salvo leyendo el código generado.
  //
  // Se mira el catálogo de errores del DISEÑO ENTERO y se avisa una vez, no por operación:
  // los `errors` se agregan por servicio, así que un code declarado en una operación es el
  // que sale también por las demás. Un aviso por operación prometería el canónico en la que
  // no lo declara mientras el generador emite el de al lado — un aviso que miente.
  {
    const idempotentOps = Object.entries(useCases.operations ?? {})
      .filter(([, op]) => op?.idempotency)
      .map(([name]) => name);
    if (idempotentOps.length > 0) {
      const declared = Object.values(useCases.operations ?? {}).flatMap((op) =>
        (op.errors ?? []).map((error) => ({ code: error.code, http: error.http }))
      );
      const sinNombrar = [FRAMEWORK_ERRORS.idempotencyRace, FRAMEWORK_ERRORS.idempotencyReuse].filter(
        (entry) => !overrideFor(declared, entry)
      );
      if (sinNombrar.length > 0) {
        warnings.push(
          `use-cases: ${idempotentOps.join(', ')} declara${idempotentOps.length > 1 ? 'n' : ''} idempotency y el diseño no ` +
            `nombra ${sinNombrar.length > 1 ? 'sus desenlaces de conflicto' : 'uno de sus desenlaces de conflicto'}. ` +
            `Se usarán los códigos canónicos ${sinNombrar.map((entry) => `${entry.http} ${entry.code}`).join(' y ')} ` +
            `(${sinNombrar.map((entry) => entry.when.split(/[.:]/)[0]).join('; ')}). ` +
            `Son contrato público: los ven los integradores y los afirman los escenarios. Si este servicio usa otros codes, ` +
            `decláralos en errors con el mismo status — ver docs/framework-errors.md`
        );
      }
    }
  }

  // El conflicto del bloqueo optimista es OBSERVABLE por la API —el cliente recibe un 409—,
  // así que tiene un `code` que forma parte del contrato. Se avisa una vez por diseño y no
  // por operación: la política es del servicio entero, y repetirlo en cada command sería
  // ruido en el sitio donde menos ayuda.
  //
  // Se exige que el diseño se haya PRONUNCIADO (que `consistency.optimisticLocking` esté
  // escrito), no que la política resulte de aplicar el default del schema. La diferencia no es
  // de rigor sino de a quién le sirve el aviso: quien eligió la política está decidiendo sobre
  // concurrencia y quiere saber qué ve el cliente; a quien no ha llegado ahí, el mismo aviso en
  // todos sus diseños solo le enseña a ignorar los avisos. El código canónico se aplica igual, y
  // eso es lo que garantiza que el contrato exista: el catálogo, no este recordatorio.
  if (['all', 'declared'].includes(persistence?.consistency?.optimisticLocking) && useCases.operations) {
    const declared = Object.values(useCases.operations).flatMap((op) =>
      (op.errors ?? []).map((error) => ({ code: error.code, http: error.http }))
    );
    if (!overrideFor(declared, FRAMEWORK_ERRORS.concurrency)) {
      warnings.push(
        `persistence: consistency.optimisticLocking: dos escrituras concurrentes sobre la misma raíz devuelven un ` +
          `${FRAMEWORK_ERRORS.concurrency.http} al cliente y ninguna operación nombra ese error. Se usará el código canónico ` +
          `'${FRAMEWORK_ERRORS.concurrency.code}'. Es contrato público: si este servicio usa otro, decláralo en los errors de ` +
          `la operación donde el conflicto se observe, con status ${FRAMEWORK_ERRORS.concurrency.http} — ver docs/framework-errors.md`
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
    // Y cuánto vale el enlace con el que se lee lo que no es público. `private` significa
    // que la lectura pasa por una firma que caduca, y esa caducidad es contrato con quien
    // recibe el enlace: cuánto tiempo tiene para descargar, y durante cuánto le sirve a
    // quien se lo reenvíe. Sin declararla, la ventana la elige quien construya y no queda
    // en ninguna parte del diseño — que es como un enlace pensado para minutos acaba
    // durando días sin que nadie lo haya decidido.
    const bucket = storage?.buckets?.[bucketName] ?? {};
    if ((bucket.visibility ?? 'private') === 'private' && bucket.signedUrlTtlSeconds == null) {
      warnings.push(
        `storage: buckets.${bucketName}: es private y no declara 'signedUrlTtlSeconds': la URL firmada con la ` +
          `que se lee su contenido caduca, pero el diseño no dice cuándo`
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
  for (const [opName, op] of Object.entries(operations)) {
    const reachableByHttp = Boolean(api && (autoCoversOp(opName) || apiEndpoints.has(opName)));
    const exposed =
      op.internal === true || op.schedule !== undefined || reachableByHttp || triggeredBySubscription.has(opName);
    if (!exposed) {
      warnings.push(
        `use-cases: ${opName}: operación huérfana — sin endpoint, sin subscription, sin schedule y sin internal: true`
      );
    }

    // `idempotency` deduplica el reintento de un llamante que reenvía su clave por la
    // cabecera Idempotency-Key. Sin endpoint HTTP esa cabecera no llega nunca, y lo que
    // se genera es un almacén que nadie puebla: el bloque promete una garantía que nada
    // implementa, y nadie vuelve a mirarlo. El mecanismo correcto depende del disparador.
    if (op.idempotency && !reachableByHttp) {
      const alternativa = triggeredBySubscription.has(opName)
        ? `la dispara una suscripción: la reentrega se ataja con contract.messageId en messaging`
        : `no la invoca ningún cliente externo: lo que evita el efecto doble es la clave natural en persistence o una transición de lifecycle irrepetible`;
      errors.push(
        `use-cases: ${opName}.idempotency: la clave llega por la cabecera Idempotency-Key y esta operación no tiene endpoint HTTP que la reciba — ${alternativa}`
      );
    }

    // El contrato de la idempotencia no es rechazar la repetición: es DEVOLVER la
    // respuesta original. Y lo que se guarda de la primera ejecución es el id del
    // recurso creado — con eso se reconstruye la ficha de una entidad, pero no una
    // lista ni una página: esas dependen del estado del resto del sistema en el
    // momento de responder, y para entonces ya cambió. La repetición devolvería algo
    // distinto de lo que devolvió la primera llamada, que es justo lo que promete no
    // hacer. Void no entra: no devolver nada se reproduce solo.
    const output = op.output;
    if (op.idempotency && output && typeof output === 'object' && (output.list || output.paginated)) {
      warnings.push(
        `use-cases: ${opName}.idempotency: la respuesta es ${output.paginated ? 'paginada' : 'una lista'} y de la primera ` +
          `ejecución solo se guarda el id del recurso — una repetición no puede devolver la MISMA respuesta, que es lo que ` +
          `la idempotencia promete. O la operación devuelve el recurso creado, o lo que hace falta declarar es que la ` +
          `repetición devuelve el estado actual`
      );
    }

    // El reintento del llamante. Un command expuesto por HTTP lo reenvía cualquiera sin
    // pedir permiso —el móvil que perdió la respuesta, el proxy, el botón pulsado dos
    // veces— y nada del protocolo distingue ese reenvío de una segunda intención. Dos
    // cosas lo atajan y basta con una: `idempotency`, que deduplica en la puerta por la
    // clave del cliente, o una transición irrepetible, que lo rechaza en el dominio. Es el
    // simétrico del aviso de http-clients sobre `retry` sin `idempotency`: allí repetimos
    // nosotros contra un proveedor, aquí nos repiten a nosotros.
    //
    // Dos recortes, y ninguno es por comodidad. El primero es del protocolo: PUT y DELETE
    // son idempotentes por definición —repetirlos converge al mismo estado—, así que la
    // repetición que hace daño llega por POST o PATCH. El segundo separa el daño
    // recuperable del que no: dentro del servicio, un segundo insert lo puede frenar una
    // clave natural en persistence, que es una salida legítima y el DSL no la ve; lo que
    // ninguna clave natural desanda es un evento ya publicado o un encargo ya hecho a otro
    // servidor. Se avisa de eso, que es donde la repetición sale del proceso y ya no vuelve.
    const endpointMethod = api?.endpoints?.[opName]?.method;
    const repeatableMethod = endpointMethod
      ? endpointMethod === 'POST' || endpointMethod === 'PATCH'
      : /^create[A-Z]/.test(opName); // auto: true deriva POST solo del prefijo create
    const escapes = (op.emits ?? []).length > 0 || activatesProvider.has(opName);
    if (
      op.kind === 'command' &&
      reachableByHttp &&
      repeatableMethod &&
      escapes &&
      !op.idempotency &&
      !hasIrrepeatableTransition(op)
    ) {
      const efecto = (op.emits ?? []).length > 0 ? `publica ${op.emits.join(', ')}` : 'encarga trabajo a otro servidor';
      warnings.push(
        `use-cases: ${opName}: es un command ${endpointMethod ?? 'POST'} que ${efecto}, y no declara ni 'idempotency' ni ` +
          `una transición de lifecycle irrepetible — un reenvío del llamante (timeout, reintento del cliente, doble ` +
          `pulsación) lo hace dos veces, y eso ya salió del servicio: ninguna clave natural lo desanda. Declara ` +
          `idempotency para deduplicar en la puerta, o la transición que lo hace irrepetible en el dominio`
      );
    }
  }

  return { errors, warnings, pending };
}
