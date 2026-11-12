// El ciclo de vida del dato (DSL 2.28: `deletion`, `restorableFor` y `retention` en persistence; `restores` en
// use-cases; `personal` en el campo), como decisiones neutrales.
//
// Tres preguntas que el diseño contesta y los cuatro generadores tienen que traducir igual: qué significa BORRAR una raíz
// (la fila desaparece, o se conserva oculta y su clave queda libre), CUÁNTO vive un agregado y qué pasa después (se borra
// o se anonimiza), y qué campos son DATOS PERSONALES. Todo lo que no depende del lenguaje se decide aquí, como datos:
// primero desde las capas (lo que leen las reglas de `crossrefs.js`), y desde el modelo lo que leen los generadores.
// Origen y decisiones: PLAN-DSL-228-CICLO-DE-VIDA.md.

import { operationTargetEntity } from './model.js';

/** Los modos de borrado. `physical` es el default del catálogo estructural. */
export const DELETION_MODES = Object.freeze(['physical', 'logical']);

/** Lo que pasa con un agregado cuando vence su retención. */
export const RETENTION_OUTCOMES = Object.freeze(['delete', 'anonymize']);

/** El `from` que cuenta desde el borrado lógico en vez de desde un campo de la raíz (D7). */
export const FROM_DELETED = 'deleted';

/** El campo de dominio que marca el borrado lógico. Lo pone el generador y NO está en el contrato (D1). */
export const DELETED_AT_FIELD = 'deletedAt';

/** Prefijo del sustituto con que `anonymize` rellena un campo personal obligatorio de texto (D9). */
export const ANONYMOUS_PREFIX = 'anon-';

// ─── Desde las capas ─────────────────────────────────────────────────────────

/** Entidad → nombre del agregado y su raíz. Las entidades sueltas (sin agregado) son raíz de sí mismas. */
export function aggregateIndex(layers) {
  const index = new Map();
  for (const [aggregateName, aggregate] of Object.entries(layers.domain?.aggregates ?? {})) {
    const root = aggregate?.root ?? aggregateName;
    index.set(root, { aggregate: aggregateName, root, isRoot: true });
    for (const member of aggregate?.entities ?? []) {
      if (member !== root) index.set(member, { aggregate: aggregateName, root, isRoot: false });
    }
  }
  for (const entityName of Object.keys(layers.domain?.entities ?? {})) {
    if (!index.has(entityName)) index.set(entityName, { aggregate: entityName, root: entityName, isRoot: true });
  }
  return index;
}

/** Las entidades internas del agregado de una raíz (sin la raíz). */
export function internalEntitiesOf(layers, rootName) {
  return [...aggregateIndex(layers)].filter(([, at]) => !at.isRoot && at.root === rootName).map(([name]) => name);
}

/**
 * Lo que el diseño declara del ciclo de vida, por entidad persistida que declare algo: `{ entity, isRoot, persisted,
 * deletion, restorableFor, retention }`. `deletion` vale el default (`physical`) cuando no se escribe.
 */
export function declaredLifecycles(layers) {
  const index = aggregateIndex(layers);
  return Object.entries(layers.persistence?.entities ?? {})
    .filter(([, entity]) => entity?.deletion !== undefined || entity?.restorableFor !== undefined || entity?.retention !== undefined)
    .map(([entityName, entity]) => ({
      entity: entityName,
      isRoot: index.get(entityName)?.isRoot ?? true,
      persisted: entity.persisted !== false,
      deletion: entity.deletion ?? 'physical',
      restorableFor: entity.restorableFor ?? null,
      retention: entity.retention ?? null
    }));
}

/** Las operaciones que declaran `restores`: `{ operation, op, root }`. */
export function restoringOperations(layers) {
  return Object.entries(layers['use-cases']?.operations ?? {})
    .filter(([, op]) => typeof op?.restores === 'string')
    .map(([operation, op]) => ({ operation, op, root: op.restores }));
}

/** ¿Es personal el campo? Se marca en el campo, no en el tipo: un mismo tipo (un email) puede ser de una persona o no. */
function isPersonalField(field) {
  return field?.personal === true;
}

/** Los campos `personal` de una entidad, por nombre: `[{ field, spec }]`. */
export function personalFieldsOfEntity(layers, entityName) {
  const entity = layers.domain?.entities?.[entityName];
  return Object.entries(entity?.fields ?? {})
    .filter(([, spec]) => isPersonalField(spec))
    .map(([field, spec]) => ({ field, spec }));
}

/** Los campos personales del agregado entero de una raíz, la raíz primero: `[{ entity, field, spec }]`. */
export function personalFieldsOfAggregate(layers, rootName) {
  return [rootName, ...internalEntitiesOf(layers, rootName)].flatMap((entity) =>
    personalFieldsOfEntity(layers, entity).map((personal) => ({ entity, ...personal }))
  );
}

/**
 * Las relaciones que llegan a una raíz desde OTRO agregado: `[{ entity, relation }]`. Son las FK que impiden borrarla
 * de verdad: la fila referenciada no se puede ir sin dejar la referencia colgando.
 */
export function incomingReferences(layers, rootName) {
  const index = aggregateIndex(layers);
  const own = index.get(rootName)?.aggregate;
  const out = [];
  for (const [entityName, entity] of Object.entries(layers.domain?.entities ?? {})) {
    if (index.get(entityName)?.aggregate === own) continue;
    for (const [relation, spec] of Object.entries(entity?.relations ?? {})) {
      if (spec?.entity === rootName) out.push({ entity: entityName, relation });
    }
  }
  return out;
}

// ─── El sustituto de `anonymize` (D9) ────────────────────────────────────────

/** Longitud máxima del texto de un id, por su tipo: lo que ocupa el sustituto en el peor caso. */
const ID_TEXT_LENGTH = Object.freeze({ uuid: 36, long: 19, int: 10, string: 64 });

/** El tipo base de un campo, siguiendo un tipo nominal hasta su base. */
function baseTypeOf(spec, domainTypes) {
  const type = spec?.type;
  return domainTypes?.[type]?.base ?? type;
}

/**
 * El sustituto con que `anonymize` rellena un campo personal OBLIGATORIO de texto: `anon-<id>`. Irreversible (no deriva
 * del valor), y único porque lo es el id, así que una unicidad sobre el campo sobrevive. Referencia ejecutable: los
 * cuatro generadores escriben exactamente este texto.
 */
export function anonymousSubstitute(id) {
  return `${ANONYMOUS_PREFIX}${id}`;
}

/** Lo que vale un campo personal al anonimizar: null si es opcional, el sustituto si es obligatorio. */
export function anonymizedValue({ required }, id) {
  return required ? anonymousSubstitute(id) : null;
}

/**
 * Por qué el sustituto NO sirve para un campo personal obligatorio, o null si sirve. No sirve si el campo no es de
 * texto, si su tipo o el campo restringen la forma (`pattern`, enum) o si `maxLength` no da para `anon-` más el id.
 */
export function substituteProblem(layers, entityName, field, spec) {
  if (spec?.required !== true) return null;
  const types = layers.domain?.types;
  const base = baseTypeOf(spec, types);
  if (types?.[base]?.values || types?.[spec?.type]?.values) return 'es un enum, y el sustituto no es ninguno de sus valores';
  if (base !== 'string' && base !== 'text') return `es ${spec.type}, y el sustituto es texto`;
  const constraints = { ...(types?.[spec.type]?.constraints ?? {}), ...(spec.constraints ?? {}) };
  if (constraints.pattern) return `su pattern (${constraints.pattern}) no admite el sustituto`;
  const idSpec = Object.values(layers.domain?.entities?.[entityName]?.fields ?? {}).find((candidate) => candidate?.id === true);
  const needed = ANONYMOUS_PREFIX.length + (ID_TEXT_LENGTH[baseTypeOf(idSpec, types)] ?? ID_TEXT_LENGTH.uuid);
  if (Number.isInteger(constraints.maxLength) && constraints.maxLength < needed) {
    return `su maxLength (${constraints.maxLength}) no da para el sustituto (${needed} caracteres)`;
  }
  return null;
}

// ─── La duración de una retención ────────────────────────────────────────────

/**
 * La duración de `retention.keep`, resuelta: `{ days }` o `{ years }` literales, o `{ parameter, unit }`. Los años son de
 * calendario (seis años fiscales no son 2190 días), así que el corte lo calcula el servidor con su reloj y no el motor.
 */
export function retentionSpan(retention) {
  const keep = retention?.keep ?? {};
  if (Number.isInteger(keep.days)) return Object.freeze({ days: keep.days });
  if (Number.isInteger(keep.years)) return Object.freeze({ years: keep.years });
  return Object.freeze({ parameter: keep.parameter, unit: keep.unit });
}

/**
 * El instante de corte de una retención: lo que se contó desde antes de este instante ha vencido. Referencia ejecutable
 * de la aritmética, igual en los cuatro: los días son de 24 h y los años de calendario en UTC (un 29 de febrero sin
 * equivalente cae en el 28). Todo en milisegundos desde la época.
 */
export function retentionCutoffMs({ nowMs, days, years }) {
  if (Number.isInteger(days)) return nowMs - days * 86_400_000;
  const now = new Date(nowMs);
  const target = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), 1, now.getUTCHours(),
    now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return target.getTime();
}

/** ¿Ha vencido una fila? Vence EN el corte, como un plazo; una fila sin `from` no vence nunca (D8). */
export function isRetentionDue({ fromMs, cutoffMs }) {
  return fromMs !== null && fromMs !== undefined && fromMs <= cutoffMs;
}

/** ¿Se puede restaurar aún? Dentro de la ventana, también en su último milisegundo. */
export function isRestorable({ deletedAtMs, days, nowMs }) {
  return deletedAtMs + days * 86_400_000 > nowMs;
}

/** El `kind` del recurrente de una retención en `keel_timer`, con los nombres del diseño. */
export function retentionKind(entityName) {
  return `retention:${entityName}`;
}

/** Un nombre de entidad en kebab (`VerificationCode` → `verification-code`) y en mayúsculas (`VERIFICATION_CODE`). */
const kebabOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * Los parámetros del barrido de una retención (D8), con la forma de los de las purgas del generador: clave, variable y
 * default, los mismos en los cuatro servidores. El cron corre en modo CLÚSTER sobre el cronómetro (una réplica por tick);
 * el lote acota cada transacción, y el tick repite mientras el lote salga lleno.
 */
export function retentionParameters(entityName) {
  const kebab = kebabOf(entityName);
  const env = kebab.replaceAll('-', '_').toUpperCase();
  return Object.freeze({
    cron: Object.freeze({ key: `retention.${kebab}.cron`, env: `RETENTION_${env}_CRON`, default: '0 30 2 * * *', cron: true }),
    batchSize: Object.freeze({ key: `retention.${kebab}.batch-size`, env: `RETENTION_${env}_BATCH_SIZE`, default: 500 })
  });
}

/**
 * Las raíces persistidas de las que el diseño ya dice algo del ciclo de vida (un campo personal en su agregado, un
 * deletion, un restorableFor o una retention): las unidades de la clase 19 del análisis de huecos. Cadenas estables, que
 * el diseñador copia tal cual a gaps.yaml.
 */
export function dataLifecycleRoots(layers) {
  const declared = new Set(declaredLifecycles(layers).filter((lifecycle) => lifecycle.isRoot).map((lifecycle) => lifecycle.entity));
  const roots = [];
  for (const [entityName, at] of aggregateIndex(layers)) {
    const persisted = layers.persistence?.entities?.[entityName];
    if (!at.isRoot || persisted === undefined || persisted?.persisted === false) continue;
    if (declared.has(entityName) || personalFieldsOfAggregate(layers, entityName).length > 0) roots.push(entityName);
  }
  return roots;
}

/**
 * Las raíces persistidas que alguna operación expuesta BORRA (un endpoint DELETE, o un `deleteX` con `api.auto`): las
 * unidades de la entrada 3.13 del catálogo estructural, donde `deletion` tiene que estar escrito aunque sea `physical`.
 */
export function deletedRoots(layers) {
  const operations = layers['use-cases']?.operations ?? {};
  const endpoints = layers.api?.endpoints ?? {};
  const deleting = Object.keys(operations).filter((name) =>
    endpoints[name] ? String(endpoints[name].method).toUpperCase() === 'DELETE' : layers.api?.auto === true && /^delete[A-Z]/.test(name)
  );
  const index = aggregateIndex(layers);
  // Una operación sin entidad en el payload y con un nombre que no la dice (`deleteMyCard`) borra la única raíz
  // persistida del servicio, si solo hay una; con varias no se adivina.
  const persistedRoots = [...index].filter(([name, at]) => at.isRoot && layers.persistence?.entities?.[name] !== undefined
    && layers.persistence.entities[name]?.persisted !== false).map(([name]) => name);
  const roots = new Set();
  for (const name of deleting) {
    const target = operationTargetEntity(name, operations[name] ?? {}, layers.domain?.entities ?? {});
    const root = index.get(target)?.root ?? (persistedRoots.length === 1 ? persistedRoots[0] : undefined);
    const persisted = layers.persistence?.entities?.[root];
    if (root && persisted !== undefined && persisted?.persisted !== false) roots.add(root);
  }
  return [...roots];
}

// ─── La frontera de los generadores ──────────────────────────────────────────

/**
 * Lo que un generador todavía no emite del ciclo de vida, con el mismo mensaje en los cuatro: lo llama cada
 * `supported-features.js` hasta su incremento de PLAN-DSL-228-CICLO-DE-VIDA.md. `deletion: physical` no se rechaza: es
 * lo que ya generan todos. A medias, cada pieza falla en silencio —la fila borrada que sigue en el listado, la clave que
 * no se libera, el email en un log—, y por eso se rechaza entera.
 */
export function dataLifecyclePendingErrors(layers, generator, increment) {
  const pending = (what, fix) =>
    `${what} (DSL 2.28): ${generator} todavía no lo genera — llega en el incremento ${increment} de ` +
    `PLAN-DSL-228-CICLO-DE-VIDA.md, y a medias fallaría en silencio. ${fix} para generar este diseño.`;
  const errors = [];
  for (const [entityName, entity] of Object.entries(layers.domain?.entities ?? {})) {
    const personal = Object.entries(entity?.fields ?? {}).filter(([, spec]) => spec?.personal === true).map(([name]) => name);
    if (personal.length > 0) {
      errors.push(pending(`domain: ${entityName}: ${personal.join(', ')} personal`, 'Quita personal'));
    }
  }
  for (const lifecycle of declaredLifecycles(layers)) {
    if (lifecycle.deletion === 'logical') {
      errors.push(pending(`persistence: ${lifecycle.entity}.deletion: logical`, 'Declara deletion: physical'));
    }
    if (lifecycle.restorableFor) {
      errors.push(pending(`persistence: ${lifecycle.entity}.restorableFor`, 'Quita restorableFor y restores'));
    }
    if (lifecycle.retention) {
      errors.push(pending(`persistence: ${lifecycle.entity}.retention`, 'Quita retention'));
    }
  }
  return errors;
}

// ─── Lo que emite cada generador, desde el modelo ────────────────────────────

/**
 * Las raíces del modelo con algo del ciclo de vida, ya resuelto para emitir: `{ entity, logical, restore, retention }`.
 * `restore` es `{ operation, error, days | parameter }` o null; `retention`, `{ kind, from, fromDeleted, span, then,
 * anonymize }` o null, donde `anonymize` lista por entidad del agregado sus campos personales (D9: los opcionales van a
 * null y los obligatorios al sustituto).
 */
export function lifecycleRoots(model) {
  const entities = model.entities ?? [];
  const operations = (model.services ?? []).flatMap((group) => group.operations ?? []);
  const out = [];
  for (const entity of entities.filter((candidate) => candidate.persisted)) {
    const logical = entity.deletion === 'logical';
    if (!logical && !entity.retention) continue;
    const restorer = operations.find((operation) => operation.restores === entity.name);
    const restore = entity.restorableFor && restorer
      ? Object.freeze({
          operation: restorer.name,
          error: entity.restorableFor.error,
          ...(Number.isInteger(entity.restorableFor.days)
            ? { days: entity.restorableFor.days }
            : { parameter: entity.restorableFor.parameter })
        })
      : null;
    let retention = null;
    if (entity.retention) {
      const members = [entity, ...entities.filter((candidate) => candidate !== entity && candidate.aggregateRoot === entity.name)];
      retention = Object.freeze({
        kind: retentionKind(entity.name),
        from: entity.retention.from === FROM_DELETED ? DELETED_AT_FIELD : entity.retention.from,
        fromDeleted: entity.retention.from === FROM_DELETED,
        span: retentionSpan(entity.retention),
        then: entity.retention.then,
        anonymize: entity.retention.then === 'anonymize'
          ? members
              .map((member) => ({
                entity: member.name,
                fields: (member.fields ?? []).filter((field) => field.personal).map((field) => ({ name: field.name, required: field.required }))
              }))
              .filter((member) => member.fields.length > 0)
          : []
      });
    }
    out.push(Object.freeze({ entity: entity.name, logical, restore, retention }));
  }
  return out;
}

/**
 * La raíz que BORRA una operación expuesta con DELETE, desde el modelo: la de su payload, o la única raíz persistida del
 * servicio si el nombre no la dice (`deleteMyCard`), igual que `deletedRoots` desde las capas. Null si no borra nada.
 */
export function deletedRootOf(model, operation) {
  if (String(operation?.route?.method ?? '').toUpperCase() !== 'DELETE') return null;
  const roots = (model.entities ?? []).filter((entity) => entity.persisted && entity.isAggregateRoot);
  const target = (model.entities ?? []).find((entity) => entity.name === operation.targetEntity);
  const root = target ? roots.find((entity) => entity.name === (target.aggregateRoot ?? target.name)) : roots.length === 1 ? roots[0] : null;
  return root ?? null;
}

/**
 * Cómo encuentra el handler de una restauración la fila borrada (D6): por id siempre, y por la clave natural si la raíz la
 * tiene, porque una operación del titular (`restoreMyCard`) no conoce el id. Varias borradas pueden compartir la clave
 * (D4 la libera al borrar): se devuelve la borrada MÁS RECIENTE, la única que tiene sentido deshacer.
 */
export function deletedLookupOf(entity) {
  const key = entity?.naturalKey ?? [];
  return key.length > 0 ? Object.freeze({ fields: [...key] }) : null;
}

/** La ventana de una restauración, en texto: `30 días` o `el parámetro p (días)`. */
function windowText(restore) {
  return Number.isInteger(restore.days) ? `${restore.days} días` : `los días del parámetro ${restore.parameter}`;
}

/**
 * La nota del handler de una operación que BORRA una raíz con borrado lógico, la misma en los cuatro generadores.
 * `deleteCall` es la llamada al puerto en el lenguaje del generador.
 */
export function logicalDeletionNote(model, operation, { deleteCall }) {
  const root = deletedRootOf(model, operation);
  if (!root || root.deletion !== 'logical') return null;
  const restorer = lifecycleRoots(model).find((entry) => entry.entity === root.name)?.restore;
  return (
    `Borrado lógico (persistence.${root.name}.deletion: logical, DSL 2.28): ${deleteCall} MARCA la fila y no la elimina. ` +
    'Desde ese momento ninguna lectura del puerto la ve —carga por id o por clave, listados y su total— y sus claves únicas ' +
    'quedan libres; solo la siguen viendo las referencias desde otro agregado. No filtres lo borrado a mano: lo hace el ' +
    'adaptador. Borrar una ya borrada no la encuentra la carga, así que responde el error de no encontrado, nunca 410.' +
    (restorer ? ` Se puede deshacer con ${restorer.operation} durante ${windowText(restorer)}.` : '')
  );
}

/**
 * La nota del handler de la operación que RESTAURA (`restores`), la misma en los cuatro. `findCall` y `restoreCall` son
 * las llamadas al puerto en el lenguaje del generador (la carga de la borrada y la restauración).
 */
export function restoreNote(model, operation, { findCall, restoreCall }) {
  if (!operation?.restores) return null;
  const restore = lifecycleRoots(model).find((entry) => entry.entity === operation.restores)?.restore;
  if (!restore) return null;
  return (
    `Restauración (restores: ${operation.restores}, DSL 2.28): encuentra la fila BORRADA con ${findCall} —las cargas ` +
    `normales no la ven— y llama a ${restoreCall}, que la deja viva. Sin fila borrada, el error de no encontrado. Fuera de ` +
    `la ventana (${windowText(restore)} desde el borrado) el adaptador lanza ${restore.error}, y si otra fila viva ocupa ya ` +
    'su clave única, la constraint responde con el 409 de esa unicidad. No compruebes la ventana ni la clave a mano.'
  );
}

/** Los campos personales del modelo, por entidad: lo que el gate de logs del agente veta y lo que lista el inventario. */
export function personalFields(model) {
  return (model.entities ?? [])
    .map((entity) => ({ entity: entity.name, fields: (entity.fields ?? []).filter((field) => field.personal).map((field) => field.name) }))
    .filter((entry) => entry.fields.length > 0);
}

// ─── La medición ─────────────────────────────────────────────────────────────

/** Los casos que los cuatro generadores ejecutan con el mismo id, y en qué red. */
export const DATA_LIFECYCLE_CASES = Object.freeze([
  { id: 'LC-1', level: 'adapter', asserts: 'un listado o un finder no devuelve filas borradas' },
  { id: 'LC-2', level: 'adapter', asserts: 'el total de la página no cuenta las filas borradas' },
  { id: 'LC-3', level: 'adapter', asserts: 'la carga por id de una fila borrada es no encontrado' },
  { id: 'LC-4', level: 'adapter', asserts: 'la carga por clave natural ignora las filas borradas' },
  { id: 'LC-5', level: 'adapter', asserts: 'la clave de una fila borrada se puede volver a usar, también con when' },
  { id: 'LC-6', level: 'adapter', asserts: 'restaurar dentro de la ventana deja la fila viva' },
  { id: 'LC-7', level: 'adapter', asserts: 'restaurar fuera de la ventana da el error declarado' },
  { id: 'LC-8', level: 'adapter', asserts: 'restaurar con la clave ocupada por una fila viva da el 409 de su unicidad' },
  { id: 'LC-9', level: 'adapter', asserts: 'embed y findAllById ven la raíz borrada' },
  { id: 'LC-10', level: 'adapter', asserts: 'el predicado de vida se compone con el alcance y con el where: ninguno se cae' },
  { id: 'RT-1', level: 'timer', asserts: 'el barrido borra solo lo vencido, y una fila sin from nunca vence' },
  { id: 'RT-2', level: 'timer', asserts: 'anonymize deja a null los opcionales y el sustituto en los obligatorios, raíz e hijas, y la unicidad sobrevive' },
  { id: 'RT-3', level: 'timer', asserts: 'con dos réplicas, un solo barrido' },
  { id: 'RT-4', level: 'timer', asserts: 'from: deleted purga lo borrado pasada la ventana' },
  { id: 'PD-1', level: 'gate', asserts: 'el gate de logs sale rojo con el accesor de un campo personal' },
  { id: 'PD-2', level: 'adapter', asserts: 'al violar una unicidad sobre un campo personal, ningún log generado lleva el valor' },
  { id: 'PD-3', level: 'telemetry', asserts: 'ni las trazas ni los logs que recoge el colector llevan un valor personal sembrado' }
]);

/** Los sabotajes y los casos en los que tiene que caer cada uno: exactamente esos. */
export const DATA_LIFECYCLE_SABOTAGES = Object.freeze({
  'lc-no-filter': ['LC-1', 'LC-2'],
  'lc-count': ['LC-2'],
  'lc-get-leak': ['LC-3', 'LC-4'],
  'lc-unique-all-rows': ['LC-5'],
  'lc-restore-window': ['LC-7'],
  'lc-embed-hidden': ['LC-9'],
  'lc-implicit-replace': ['LC-10'],
  'rt-early': ['RT-1'],
  'rt-anonymize-miss': ['RT-2'],
  'rt-every-replica': ['RT-3'],
  'pd-log-value': ['PD-2', 'PD-3']
});
