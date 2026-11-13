// El CICLO DE VIDA DEL DATO (DSL 2.28: `deletion: logical`, `restorableFor`/`restores` y `retention`) en keel-nest:
// incremento 2 de PLAN-DSL-228-CICLO-DE-VIDA.md, con el reparto de keel-spring. Lo que decide QUÉ (qué raíces, la
// columna, las unicidades entre vivas, el sustituto, la aritmética de la ventana y del corte, los parámetros del barrido,
// las notas) es de keel-core (gen/data-lifecycle.js, gen/relational.js, gen/timer-plan.js); aquí solo se escribe en
// TypeScript:
//
//   · `deletedAt` (y `anonymizedAt`, D11) en la entidad ORM o en el documento: los pone el generador, no el dominio (D1).
//     En el documento, con el nombre del campo tal cual (`deletedAt`), que es la ruta que filtran los índices parciales y
//     la que escribe keel-spring.
//   · Las lecturas VIVAS del adaptador: cada carga y cada listado suma `deletedAt IS NULL` (o `deletedAt: null`), y los
//     finders de búsqueda lo suman a su where DETRÁS del alcance (D2). `findAllById`, la lectura por referencia, NO lo
//     lleva (D3).
//   · `deleteById` MARCA la fila (D1), y `restore`/`findDeletedBy<Clave>` la devuelven a la vida dentro de la ventana (D6).
//   · La retención: `<Raíz>Retention` (qué ha vencido, por lotes, y qué se hace con cada uno) y `<Raíz>RetentionTimer`, el
//     recurrente del cronómetro que la dispara en modo clúster (D8), con su lote y su cron en `retention.yaml`.

import { DELETED_AT, ANONYMIZED_AT, LOCK_VERSION, isLogicallyDeleted, persistedMembers } from '@keel-system/keel-core/gen/relational';
import { AGE_DELETION_ENGINES, AGE_DELETION_MISS, ANONYMOUS_PREFIX, ageDeletionStatement, deletedLookupOf, deletionAgingTargets, lifecycleRoots, retentionParameters } from '@keel-system/keel-core/gen/data-lifecycle';
import { ageDeletionScript } from '@keel-system/keel-core/gen/mongo-probes';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { documentShape, DOCUMENT_ID } from '@keel-system/keel-core/gen/document';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { snakeCase } from '@keel-system/keel-core/gen/naming';
import { DIRS, classPath, tsModule, tsString } from './render.js';

const RETENTION_DIR = 'infrastructure/persistence/retention';
const TIMER_DIR = 'infrastructure/timer';
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
export const RETENTION_SETTINGS_TS = classPath(RETENTION_DIR, 'RetentionSettings');
const PROFILES = ['local', 'develop', 'production', 'test'];

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** Lo que el modelo dice del ciclo de vida de una raíz (lifecycleRoots de keel-core), o null. */
export function lifecycleOf(model, entity) {
  return lifecycleRoots(model).find((root) => root.entity === entity?.name) ?? null;
}

/** Las raíces con retención: `[{ entity, root }]`. */
export function retentionRoots(model) {
  return lifecycleRoots(model)
    .filter((root) => root.retention)
    .map((root) => ({ entity: model.entities.find((candidate) => candidate.name === root.entity), root }));
}

export const retentionClass = (entityName) => `${entityName}Retention`;
export const retentionPath = (entityName) => classPath(RETENTION_DIR, retentionClass(entityName));
export const retentionTimerClass = (entityName) => `${entityName}RetentionTimer`;
export const retentionTimerPath = (entityName) => classPath(TIMER_DIR, retentionTimerClass(entityName));

/** La constante del `kind` en TimerKinds: el nombre de keel-spring. */
export const retentionKindConstant = (entityName) => `RETENTION_${entityName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

/** La clave de una raíz en RetentionSettings (`verificationCode`). */
const settingsKey = (entityName) => decap(entityName);

/** Las marcas del generador en el espejo: `[{ field, column }]`. Fuera del dominio y del contrato (D1, D11). */
export function lifecycleMarks(model, entity) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle) return [];
  return [...(lifecycle.logical ? [DELETED_AT] : []), ...(lifecycle.retention?.then === 'anonymize' ? [ANONYMIZED_AT] : [])];
}

/** El comentario de cada marca en la entidad ORM. */
export function markComment(mark) {
  return mark === DELETED_AT
    ? 'Borrado lógico (DSL 2.28): cuándo se borró, o null si está viva. La pone deleteById y la quita restore; ninguna lectura del puerto ve una fila con ella.'
    : 'Cuándo la anonimizó su retención (DSL 2.28, D11). Sin la marca, el barrido volvería a tomarla en cada pasada.';
}

/**
 * Con bloqueo optimista, marcar, restaurar o anonimizar SUBE la versión, como el @Version de JPA en keel-spring: una
 * escritura que leyó antes (un handler en vuelo) tiene que salir como conflicto y no reescribir lo que la marca cambió.
 */
const versionProperty = (entity) => (entity.declaresLockVersion ? 'lockVersion' : LOCK_VERSION.field);
const relationalBump = (entity) => (entity.usesOptimisticLocking ? `, ${versionProperty(entity)}: () => '${LOCK_VERSION.column} + 1'` : '');
const documentBump = (entity) => (entity.usesOptimisticLocking ? `, $inc: { ${LOCK_VERSION.column}: 1 }` : '');

const windowText = (restore) => (Number.isInteger(restore.days) ? `${restore.days} días` : `los días del parámetro ${restore.parameter}`);
const spanText = (span) => (span.days ? `${span.days} días` : span.years ? `${span.years} años` : `el parámetro ${span.parameter}`);

// ─── El predicado de vida ────────────────────────────────────────────────────────────────────────────────────────

/** Un where de TypeORM (`{ id }`) con la vida sumada si la raíz se borra lógicamente: `{ id, deletedAt: IsNull() }`. */
export function liveWhere(entity, where, imports) {
  if (!isLogicallyDeleted(entity)) return where;
  imports.push({ symbol: 'IsNull', from: 'typeorm' });
  return where === '{}' ? `{ ${DELETED_AT.field}: IsNull() }` : where.replace(/ \}$/, `, ${DELETED_AT.field}: IsNull() }`);
}

/** Un filtro del driver de MongoDB con la vida sumada: `{ _id: …, deletedAt: null }`. */
export function liveFilter(entity, filter) {
  if (!isLogicallyDeleted(entity)) return filter;
  return filter === '{}' ? `{ ${DELETED_AT.field}: null }` : filter.replace(/ \}$/, `, ${DELETED_AT.field}: null }`);
}

/** La línea que el finder relacional suma a su where (D2), DETRÁS del alcance. */
export const RELATIONAL_LIVE_LINE = `    and(${tsString(DELETED_AT.field)}, IsNull());`;

/** La línea que el finder documental suma a sus condiciones (D2), detrás del alcance. */
export const DOCUMENT_LIVE_LINE = `    conditions.push({ ${DELETED_AT.field}: null });`;

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────────────────────

/** El finder de la borrada más reciente por la clave natural (D6): `{ name, finder }`, o null. */
export function deletedFinder(entity, keyFinder) {
  if (!keyFinder || !deletedLookupOf(entity)) return null;
  return { name: keyFinder.name.replace(/^findBy/, 'findDeletedBy'), finder: keyFinder };
}

/** La declaración de `deleteById` en el puerto: con borrado lógico dice que marca. */
export function deletePortMethod(model, entity, idName, idType) {
  if (!lifecycleOf(model, entity)?.logical) return `  abstract deleteById(${idName}: ${idType}): Promise<void>;`;
  return `  /**
   * Borrado LÓGICO (persistence.${entity.name}.deletion: logical, DSL 2.28): marca la fila y no la elimina. Desde ese
   * momento ninguna lectura de este puerto la ve —salvo findAllById, la lectura por referencia— y sus claves únicas
   * quedan libres. Sobre una fila ya borrada o inexistente no hace nada.
   */
  abstract deleteById(${idName}: ${idType}): Promise<void>;`;
}

/** Los métodos de restauración del puerto (D6). */
export function restorePortMethods(model, entity, idName, idType, keyFinder, imports) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.restore) return [];
  const methods = [];
  const deleted = deletedFinder(entity, keyFinder);
  if (deleted) {
    for (const param of keyFinder.params) imports.push(...param.imports);
    methods.push(`  /**
   * La fila BORRADA más reciente con esta clave, la única que tiene sentido restaurar (la clave queda libre al borrar,
   * así que puede haber varias). Las cargas normales no la ven.
   */
  abstract ${deleted.name}(${keyFinder.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null>;`);
  }
  methods.push(`  /**
   * Devuelve a la vida una fila borrada (restores: ${entity.name}). Null si no hay ninguna borrada con ese id. Fuera de la
   * ventana (${windowText(lifecycle.restore)} desde el borrado) lanza ${lifecycle.restore.error}; si otra fila viva ocupa ya su
   * clave única, la constraint salta al restaurarla, con el 409 de esa unicidad.
   */
  abstract restore(${idName}: ${idType}): Promise<${entity.name} | null>;`);
  return methods;
}

/** La operación que restaura una raíz: la que declara `restores`. */
function restoringOperationOf(model, entity) {
  return (model.services ?? []).flatMap((group) => group.operations ?? []).find((operation) => operation.restores === entity.name)?.name;
}

/** La expresión de los días de la ventana: el literal o el parámetro del servicio. */
const windowDays = (restore) => (Number.isInteger(restore.days) ? String(restore.days) : `Number(this.parameters.${restore.parameter})`);

/** El lanzamiento del error de la ventana, con su import. */
function windowError(model, entity, restore, imports) {
  const error = operationError(model, restoringOperationOf(model, entity), restore.error);
  imports.push({ symbol: error.exceptionClass, from: classPath(DIRS.errors, error.exceptionClass) });
  const message = tsString(`${entity.name} borrado hace más de ${windowText(restore)}: ya no se puede restaurar.`);
  return `throw new ${error.exceptionClass}(${[message, ...(error.dynamicStatus ? [String(error.http ?? 409)] : [])].join(', ')});`;
}

/** Lo que el constructor del adaptador inyecta para el ciclo de vida: los parámetros, si la ventana los lee. */
export function lifecycleDependencies(model, entity, { parametersClass, parametersPath }) {
  const restore = lifecycleOf(model, entity)?.restore;
  if (!restore?.parameter) return [];
  return [{ token: parametersClass, name: 'parameters', type: parametersClass, imports: [{ symbol: parametersClass, from: parametersPath }] }];
}

// ─── El adaptador TypeORM ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `deleteById` que marca, `findDeletedBy<Clave>` y `restore` sobre TypeORM, o null si la raíz se borra físicamente.
 * `orm` es la clase ORM y `relations` el literal de las relaciones del agregado (o null).
 */
export function relationalAdapterMethods(model, entity, { idName, idType, orm, relations, keyFinder, imports, keyWhere }) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  imports.push({ symbol: 'IsNull', from: 'typeorm' });
  const withRelations = relations ? ', relations: RELATIONS' : '';
  const methods = [`  async deleteById(${idName}: ${idType}): Promise<void> {
    await this.transactions.inTransaction(async (manager) => {
      // Borrado lógico (DSL 2.28, D1): se marca y no se elimina. La fila deja de verse en toda lectura del puerto y su
      // clave única queda libre (los índices únicos de la tabla solo cuentan las filas vivas).
      await manager.update(${orm}, { ${idName}, ${DELETED_AT.field}: IsNull() }, { ${DELETED_AT.field}: new Date()${relationalBump(entity)} });
    });
  }`];
  if (lifecycle.restore) {
    imports.push({ symbol: 'Not', from: 'typeorm' });
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) {
      methods.push(`  async ${deleted.name}(${keyFinder.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null> {
    const found = await this.manager.findOne(${orm}, { where: ${keyWhere.replace(/ \}$/, `, ${DELETED_AT.field}: Not(IsNull()) }`)}${withRelations}, order: { ${DELETED_AT.field}: 'DESC' } });
    return found == null ? null : toDomain${entity.name}(found);
  }`);
    }
    methods.push(`  async restore(${idName}: ${idType}): Promise<${entity.name} | null> {
    return this.transactions.inTransaction(async (manager) => {
      const deleted = await manager.findOne(${orm}, { where: { ${idName}, ${DELETED_AT.field}: Not(IsNull()) } });
      if (deleted == null) return null;
      // La ventana (restorableFor, D6): restaurable mientras deletedAt + ${windowText(lifecycle.restore)} sea posterior a ahora.
      if (!(deleted.${DELETED_AT.field}!.getTime() + ${windowDays(lifecycle.restore)} * 86_400_000 > Date.now())) {
        ${windowError(model, entity, lifecycle.restore, imports)}
      }
      // Si una fila viva ocupa ya su clave, la unicidad entre vivas salta AQUÍ, con su nombre (el 409 que traduce el filtro).
      await manager.update(${orm}, { ${idName} }, { ${DELETED_AT.field}: null${relationalBump(entity)} });
      const restored = await manager.findOne(${orm}, { where: { ${idName} }${withRelations} });
      return restored == null ? null : toDomain${entity.name}(restored);
    });
  }`);
  }
  return methods;
}

// ─── El adaptador documental ─────────────────────────────────────────────────────────────────────────────────────

/** `deleteById` que marca, `findDeletedBy<Clave>` y `restore` sobre el driver de MongoDB, o null. */
export function documentAdapterMethods(model, entity, { idName, idType, idFilter, keyFilter, keyFinder, imports }) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  const methods = [`  async deleteById(${idName}: ${idType}): Promise<void> {
    // Borrado lógico (DSL 2.28, D1): se marca y no se elimina. El documento deja de verse en toda lectura del puerto y su
    // clave única queda libre (los índices únicos solo cuentan los documentos con deletedAt nulo).
    await this.transactions.inTransaction((session) =>
      this.collection.updateOne(${liveFilter(entity, idFilter)}, { $set: { ${DELETED_AT.field}: new Date() }${documentBump(entity)} }, { session })
    );
  }`];
  if (lifecycle.restore) {
    const deleted = deletedFinder(entity, keyFinder);
    const notNull = `{ $ne: null }`;
    if (deleted) {
      methods.push(`  async ${deleted.name}(${keyFinder.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null> {
    const found = await this.collection.findOne(${keyFilter.replace(/ \}$/, `, ${DELETED_AT.field}: ${notNull} }`)}, { sort: { ${DELETED_AT.field}: -1 }, session: this.session });
    return found == null ? null : toDomain${entity.name}(found);
  }`);
    }
    methods.push(`  async restore(${idName}: ${idType}): Promise<${entity.name} | null> {
    return this.transactions.inTransaction(async (session) => {
      const deleted = await this.collection.findOne(${idFilter.replace(/ \}$/, `, ${DELETED_AT.field}: ${notNull} }`)}, { session });
      if (deleted == null) return null;
      // La ventana (restorableFor, D6): restaurable mientras deletedAt + ${windowText(lifecycle.restore)} sea posterior a ahora.
      if (!((deleted.${DELETED_AT.field} as Date).getTime() + ${windowDays(lifecycle.restore)} * 86_400_000 > Date.now())) {
        ${windowError(model, entity, lifecycle.restore, imports)}
      }
      // Si un documento vivo ocupa ya su clave, el índice único parcial salta AQUÍ, con su nombre (E11000).
      await this.collection.updateOne(${idFilter}, { $set: { ${DELETED_AT.field}: null }${documentBump(entity)} }, { session });
      const restored = await this.collection.findOne(${idFilter}, { session });
      return restored == null ? null : toDomain${entity.name}(restored);
    });
  }`);
  }
  return methods;
}

/** El filtro parcial de un índice del documento: la condición del diseño y, con borrado lógico, la vida (T1). */
export function partialFilterLiteral(spec) {
  const entries = [
    ...(spec.partialFilter ? [`${tsString(spec.partialFilter.path)}: ${JSON.stringify(spec.partialFilter.equals)}`] : []),
    ...(spec.live ? [`${tsString(spec.live.path)}: null`] : [])
  ];
  return entries.length > 0 ? `{ ${entries.join(', ')} }` : null;
}

/** El mismo filtro como objeto, para las redes que lo comparan con el índice vivo. */
export function partialFilterObject(spec) {
  if (!spec.partialFilter && !spec.live) return undefined;
  return { ...(spec.partialFilter ? { [spec.partialFilter.path]: spec.partialFilter.equals } : {}), ...(spec.live ? { [spec.live.path]: null } : {}) };
}

// ─── La retención ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la anonimización toca, por miembro (D9): `{ root: [{ property, value, fold? }], children: [{ relation, sets }] }`.
 * Un opcional va a null; un obligatorio, al sustituto `anon-<id>` de la RAÍZ. Una sombra plegada (T7) se reescribe con el
 * valor plegado del sustituto, o a null. `property` es la propiedad ORM (relacional) o la clave del documento.
 */
export function anonymizePlan(model, root, { document }) {
  const entity = model.entities.find((candidate) => candidate.name === root.entity);
  const byEntity = new Map(root.retention.anonymize.map((member) => [member.entity, member.fields]));
  const keyOf = (owner, name) => documentShape(model, owner).find((entry) => entry.member === name)?.name ?? snakeCase(name);
  const setsOf = (owner) => {
    const members = persistedMembers(model, owner);
    const sets = [];
    for (const { name, required } of byEntity.get(owner.name) ?? []) {
      const member = members.find((candidate) => candidate.name === name);
      if (member?.kind === 'vo') {
        // Un value object personal: todas sus columnas (o el subdocumento entero) a null.
        if (document) sets.push({ property: keyOf(owner, name), value: null });
        else for (const sub of member.subs) sets.push({ property: sub.name, value: null });
        continue;
      }
      const folded = member?.folded;
      sets.push({
        property: document ? keyOf(owner, name) : name,
        value: required ? 'substitute' : null,
        fold: folded ? { property: document ? keyOf(owner, folded.name) : folded.name, accents: Boolean(folded.accents) } : null
      });
    }
    return sets;
  };
  const children = persistedMembers(model, entity)
    .filter((member) => member.kind === 'relationMany' && byEntity.has(member.relation.entity))
    .map((member) => ({
      relation: document ? keyOf(entity, member.name) : member.name,
      sets: setsOf(model.entities.find((candidate) => candidate.name === member.relation.entity))
    }));
  return { entity, root: setsOf(entity), children };
}

/**
 * Lo que la frontera de keel-nest no sabe anonimizar (miembros que no son escalares ni value objects, o entidades que no
 * son la raíz ni una hija uno-a-muchos): el mismo criterio que keel-spring.
 */
export function anonymizeGaps(model) {
  const gaps = [];
  for (const { root, entity } of retentionRoots(model)) {
    if (root.retention.then !== 'anonymize') continue;
    const reachable = new Set([entity.name, ...persistedMembers(model, entity).filter((m) => m.kind === 'relationMany').map((m) => m.relation.entity)]);
    for (const member of root.retention.anonymize) {
      if (!reachable.has(member.entity)) gaps.push(`${member.entity} (no es la raíz ni una hija uno-a-muchos de ${entity.name})`);
      const owner = model.entities.find((candidate) => candidate.name === member.entity);
      const members = persistedMembers(model, owner);
      for (const field of member.fields) {
        const kind = members.find((candidate) => candidate.name === field.name)?.kind;
        if (kind !== 'scalar' && kind !== 'vo') gaps.push(`${member.entity}.${field.name} (${kind ?? 'sin columna'})`);
      }
    }
  }
  return gaps;
}

/**
 * Lo que el ciclo de vida del dato no puede generar con este stack, o []. keel-nest solo genera motores con índice parcial
 * (PostgreSQL) o con la columna generada (MySQL), y MongoDB con el filtro parcial, así que la unicidad entre vivas siempre
 * tiene forma; lo que queda es lo que no sabe anonimizar. A medias, un dato personal sobreviviría a su retención sin que
 * nada lo dijera.
 */
export function lifecycleStackErrors(model) {
  return anonymizeGaps(model).map(
    (gap) => `persistence: retention con then: anonymize (DSL 2.28): keel-nest no sabe anonimizar ${gap}. Márcalo sin personal o usa then: delete.`
  );
}

/** Las líneas que anonimizan el agregado `target` (una entidad ORM o un documento). */
function anonymizeLines(plan, idExpr, target, indent, foldImport) {
  const lines = [];
  const write = (node, sets, pad) => {
    for (const set of sets) {
      const value = set.value === 'substitute' ? 'substitute' : 'null';
      lines.push(`${pad}${node}.${set.property} = ${value};`);
      if (set.fold) {
        foldImport();
        lines.push(`${pad}${node}.${set.fold.property} = ${set.value === 'substitute' ? `TextFold.${set.fold.accents ? 'foldCaseAndAccents' : 'foldCase'}(substitute)` : 'null'};`);
      }
    }
  };
  if ([...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.value === 'substitute')) {
    lines.push(`${indent}const substitute = ${tsString(ANONYMOUS_PREFIX)} + String(${idExpr});`);
  }
  write(target, plan.root, indent);
  for (const child of plan.children) {
    lines.push(`${indent}for (const child of (${target}.${child.relation} ?? []) as ${plan.childType}[]) {`);
    write('child', child.sets, `${indent}  `);
    lines.push(`${indent}}`);
  }
  return lines;
}

/** Los archivos de la retención: un `<Raíz>Retention` por raíz, su recurrente y la configuración de los barridos. */
export function generate(model) {
  const roots = retentionRoots(model);
  if (roots.length === 0) return [];
  const document = model.persistenceKind === 'document';
  return [
    ...roots.flatMap(({ entity, root }) => [
      document ? documentRetention(model, entity, root) : relationalRetention(model, entity, root),
      retentionTimer(model, entity, root)
    ]),
    { path: RETENTION_SETTINGS_TS, content: retentionSettingsFile(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/retention.yaml`, content: retentionYaml(model, profile) }))
  ];
}

function retentionDoc(entity, retention) {
  return `/**
 * La retención de ${entity.name} (persistence.${entity.name}.retention, DSL 2.28): ${retention.fromDeleted ? 'desde el borrado lógico' : `desde ${retention.from}`}, ${spanText(retention.span)}, y
 * después ${retention.then === 'delete' ? 'se BORRA' : 'se ANONIMIZA'}. La dispara ${retentionTimerClass(entity.name)}, un recurrente del cronómetro en modo clúster
 * (D8): cada tick lo ejecuta UNA réplica.
 *
 * Por lotes y cada agregado en su transacción: una tabla grande no se recorre en un solo DELETE que bloquee la tabla y
 * reviente el tope de transacción. Una fila con ${retention.from} nulo no vence nunca.
 */`;
}

function relationalRetention(model, entity, root, { relationsLiteral } = {}) {
  const className = retentionClass(entity.name);
  const file = retentionPath(entity.name);
  const orm = `${entity.name}Orm`;
  const ormFile = classPath('infrastructure/persistence/entities', orm);
  const id = entity.idField;
  const idName = id?.name ?? 'id';
  const idType = id?.tsType ?? 'string';
  const retention = root.retention;
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'IsNull', from: 'typeorm' },
    { symbol: 'LessThanOrEqual', from: 'typeorm' },
    { symbol: 'TransactionContext', from: 'src/infrastructure/persistence/transaction-context.ts' },
    { symbol: orm, from: ormFile }
  ];
  const relations = relationsLiteral ?? retentionRelations(model, entity);
  let outcome;
  if (retention.then === 'delete') {
    outcome = `      // then: delete. Se carga y se borra el GRAFO, como deleteById: las hijas y las listas van con la raíz (T3).
      const found = await manager.findOne(${orm}, { where: { ${idName} }${relations ? `, relations: ${relations}` : ''} });
      if (found != null) await manager.remove(found);`;
  } else {
    const plan = { ...anonymizePlan(model, root, { document: false }), childType: 'any' };
    const lines = anonymizeLines(plan, idName, 'found', '      ', () => imports.push({ symbol: 'TextFold', from: 'src/infrastructure/persistence/text-fold.ts' }));
    outcome = `      // then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que no
      // deriva del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
      const found = await manager.findOne(${orm}, { where: { ${idName} }${relations ? `, relations: ${relations}` : ''} });
      if (found == null) return;
${lines.join('\n')}
      found.${ANONYMIZED_AT.field} = new Date();${entity.usesOptimisticLocking ? `\n      found.${versionProperty(entity)} = Number(found.${versionProperty(entity)} ?? 0) + 1;` : ''}
      await manager.save(${orm}, found);`;
  }
  const pending = retention.then === 'anonymize' ? `, ${ANONYMIZED_AT.field}: IsNull()` : '';
  const body = `${retentionDoc(entity, retention)}
@Injectable()
export class ${className} {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  /** Los ids que han vencido en \`cutoff\` (vence EN el corte), los más antiguos primero, como mucho \`limit\`. */
  async due(cutoff: Date, limit: number): Promise<${idType}[]> {
    const rows = await this.transactions.inNewTransaction((manager) =>
      manager.find(${orm}, {
        select: { ${idName}: true },
        where: { ${retention.from}: LessThanOrEqual(cutoff)${pending} },
        order: { ${retention.from}: 'ASC' },
        take: limit
      })
    );
    return rows.map((row) => row.${idName});
  }

  /** Lo que la retención hace con un agregado vencido, en su propia transacción. */
  async apply(${idName}: ${idType}): Promise<void> {
    await this.transactions.inNewTransaction(async (manager) => {
${outcome}
    });
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/** Las relaciones del agregado como literal (`{ items: true }`), o null: lo que se carga y se borra con la raíz. */
function retentionRelations(model, entity) {
  const tree = {};
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'elementCollection') tree[member.name] = true;
    else if (member.kind === 'relationMany' && !member.relation.backReference && member.relation.cardinality !== 'many-to-many') tree[member.name] = true;
    else if (member.kind === 'relationOne' && !member.relation.backReference) tree[member.name] = true;
  }
  const entries = Object.keys(tree);
  return entries.length > 0 ? `{ ${entries.map((key) => `${key}: true`).join(', ')} }` : null;
}

function documentRetention(model, entity, root) {
  const className = retentionClass(entity.name);
  const file = retentionPath(entity.name);
  const id = entity.idField;
  const idName = id?.name ?? 'id';
  const idType = id?.tsType ?? 'string';
  const retention = root.retention;
  const uuid = (id?.base ?? 'uuid') === 'uuid';
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'Collection', from: 'mongodb', type: true },
    { symbol: 'Document', from: 'mongodb', type: true },
    { symbol: 'StoredDocument', from: 'src/infrastructure/persistence/bson-values.ts', type: true },
    { symbol: 'TransactionContext', from: 'src/infrastructure/persistence/transaction-context.ts' },
    ...(uuid ? [{ symbol: 'toUuid', from: 'src/infrastructure/persistence/bson-values.ts' }, { symbol: 'fromUuid', from: 'src/infrastructure/persistence/bson-values.ts' }] : [])
  ];
  const write = uuid ? `toUuid(${idName})` : idName;
  const read = uuid ? `fromUuid(document.${DOCUMENT_ID})` : `document.${DOCUMENT_ID} as ${idType}`;
  const fromKey = retention.fromDeleted ? DELETED_AT.field : documentShape(model, entity).find((entry) => entry.member === retention.from)?.name ?? snakeCase(retention.from);
  let outcome;
  if (retention.then === 'delete') {
    outcome = `      // then: delete. El agregado es el documento: sus hijas se van con él.
      await this.collection.deleteOne({ ${DOCUMENT_ID}: ${write} }, { session });`;
  } else {
    const plan = { ...anonymizePlan(model, root, { document: true }), childType: 'Document' };
    const lines = anonymizeLines(plan, idName, 'found', '      ', () => imports.push({ symbol: 'TextFold', from: 'src/infrastructure/persistence/text-fold.ts' }));
    outcome = `      // then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que no
      // deriva del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
      const found = await this.collection.findOne({ ${DOCUMENT_ID}: ${write} }, { session });
      if (found == null) return;
${lines.join('\n')}
      found.${ANONYMIZED_AT.field} = new Date();${entity.usesOptimisticLocking ? `\n      found.${LOCK_VERSION.column} = BigInt(Number(found.${LOCK_VERSION.column} ?? 0) + 1);` : ''}
      await this.collection.replaceOne({ ${DOCUMENT_ID}: ${write} }, found, { session });`;
  }
  const pending = retention.then === 'anonymize' ? `, ${ANONYMIZED_AT.field}: null` : '';
  const body = `${retentionDoc(entity, retention)}
@Injectable()
export class ${className} {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  private get collection(): Collection<StoredDocument> {
    return this.transactions.collection(${tsString(entity.collectionName)});
  }

  /** Los ids que han vencido en \`cutoff\` (vence EN el corte), los más antiguos primero, como mucho \`limit\`. */
  async due(cutoff: Date, limit: number): Promise<${idType}[]> {
    const documents = await this.collection
      .find({ ${tsString(fromKey)}: { $lte: cutoff }${pending} }, { projection: { ${DOCUMENT_ID}: 1 } })
      .sort({ ${tsString(fromKey)}: 1 })
      .limit(limit)
      .toArray();
    return documents.map((document: Document) => ${read});
  }

  /** Lo que la retención hace con un agregado vencido, en su propia transacción. */
  async apply(${idName}: ${idType}): Promise<void> {
    await this.transactions.inNewTransaction(async (session) => {
${outcome}
    });
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/** El corte de una retención en TypeScript, la aritmética de `retentionCutoffMs` de keel-core. */
function cutoffExpression(span) {
  if (span.days) return `new Date(now.getTime() - ${span.days} * 86_400_000)`;
  if (span.years) return `yearsBefore(now, ${span.years})`;
  return span.unit === 'years' ? `yearsBefore(now, Number(this.parameters.${span.parameter}))` : `new Date(now.getTime() - Number(this.parameters.${span.parameter}) * 86_400_000)`;
}

const YEARS_BEFORE = `/** \`years\` años de calendario antes de \`now\`, en UTC: un 29 de febrero sin equivalente cae en el 28 (retentionCutoffMs). */
function yearsBefore(now: Date, years: number): Date {
  const target = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), 1, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return target;
}

`;

function retentionTimer(model, entity, root) {
  const className = retentionTimerClass(entity.name);
  const file = retentionTimerPath(entity.name);
  const target = retentionClass(entity.name);
  const span = root.retention.span;
  const caches = retentionCaches(model, entity.name);
  const usesParameters = Boolean(span.parameter);
  const parameters = `${model.service.className}Parameters`;
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'TimerKinds', from: classPath(TIMER_DIR, 'TimerKinds') },
    { symbol: 'RecurringTimerHandler', from: classPath(TIMER_DIR, 'TimerStore'), type: true },
    { symbol: 'RETENTION_SETTINGS', from: RETENTION_SETTINGS_TS },
    { symbol: 'RetentionSettings', from: RETENTION_SETTINGS_TS, type: true },
    { symbol: target, from: retentionPath(entity.name) },
    ...(usesParameters ? [{ symbol: parameters, from: classPath('domain/parameters', parameters) }] : []),
    ...(caches.length > 0
      ? [
          { symbol: 'OperationCache', from: classPath(DIRS.portOut, 'OperationCache') },
          ...caches.map((cache) => ({ symbol: cache.constant, from: `src/${DIRS.appSupport}/cached-operations.ts` }))
        ]
      : [])
  ];
  const deps = [
    `    @Inject(${target}) private readonly retention: ${target}`,
    `    @Inject(RETENTION_SETTINGS) settings: RetentionSettings`,
    ...(usesParameters ? [`    @Inject(${parameters}) private readonly parameters: ${parameters}`] : []),
    ...(caches.length > 0 ? ['    @Inject(OperationCache) private readonly operationCache: OperationCache'] : [])
  ];
  const years = Boolean(span.years) || span.unit === 'years';
  const body = `${years ? YEARS_BEFORE : ''}/**
 * La retención de ${entity.name} como recurrente del cronómetro en modo clúster (DSL 2.28, D8): cada tick lo ejecuta UNA
 * réplica, la que gana su fila en keel_timer. Corre FUERA de la transacción del sondeador, y cada agregado en la suya.
 *
 * El corte lo calcula el servidor: ${spanText(span)} antes de ahora${years ? ', en años de calendario UTC' : ''}. Lo que venció EN el corte
 * también se va. El tick repite el lote mientras salga lleno.
 */
@Injectable()
export class ${className} implements RecurringTimerHandler {
  readonly kind = TimerKinds.${retentionKindConstant(entity.name)};
  readonly spec: string;
  private readonly batchSize: number;

  constructor(
${deps.join(',\n')}
  ) {
    this.spec = settings.${settingsKey(entity.name)}.cron;
    this.batchSize = settings.${settingsKey(entity.name)}.batchSize;
  }

  async tick(): Promise<void> {
    const now = new Date();
    const cutoff = ${cutoffExpression(span)};
${caches.length > 0 ? '    let processed = 0;\n' : ''}    for (;;) {
      const due = await this.retention.due(cutoff, this.batchSize);
      for (const id of due) await this.retention.apply(id);${caches.length > 0 ? '\n      processed += due.length;' : ''}
      if (due.length < this.batchSize) break;
    }${caches.length > 0
      ? `
    // Lo vencido ya no es lo que guardan las lecturas de ${entity.name} en la caché (T5): se vacían, como al borrar.
    if (processed > 0) {
${caches.map((cache) => `      await this.operationCache.clear(${cache.constant});`).join('\n')}
    }`
      : ''}
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/** La configuración de los barridos: el cron y el lote de cada raíz, con las claves y los defaults de keel-core. */
function retentionSettingsFile(model) {
  const roots = retentionRoots(model);
  const body = `/** Token de la configuración de las retenciones ya resuelta. */
export const RETENTION_SETTINGS = Symbol('RETENTION_SETTINGS');

export interface RetentionSweep {
  /** El cron (seis campos, en UTC) del barrido: un recurrente del cronómetro en modo clúster. */
  readonly cron: string;
  /** Agregados por lote: el tick repite mientras salga lleno. */
  readonly batchSize: number;
}

/** Los barridos de retención (DSL 2.28), con las claves y los defaults de keel-core (retentionParameters). */
export interface RetentionSettings {
${roots.map(({ entity }) => `  readonly ${settingsKey(entity.name)}: RetentionSweep;`).join('\n')}
}

/** Lee los barridos del perfil. Un lote que no es un entero positivo no deja arrancar. */
export function retentionSettings(configuration: Configuration): RetentionSettings {
  return {
${roots
  .map(({ entity }) => {
    const parameters = retentionParameters(entity.name);
    return `    ${settingsKey(entity.name)}: {
      cron: text(configuration, ${tsString(parameters.cron.key)}, ${tsString(parameters.cron.default)}),
      batchSize: positive(configuration, ${tsString(parameters.batchSize.key)}, ${parameters.batchSize.default})
    }`;
  })
  .join(',\n')}
  };
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}

function text(configuration: Configuration, key: string, fallback: string): string {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}`;
  return tsModule(RETENTION_SETTINGS_TS, [{ symbol: 'Configuration', from: CONFIG_TS, type: true }], body);
}

/** `config/parameters/<perfil>/retention.yaml`: las claves y variables de keel-core, las mismas en los cuatro. */
function retentionYaml(model, profile) {
  const lines = ['# Los barridos de retención (DSL 2.28): un recurrente del cronómetro por raíz, en modo clúster.', 'retention:'];
  for (const { entity } of retentionRoots(model)) {
    const parameters = retentionParameters(entity.name);
    const [, kebab] = parameters.cron.key.split('.');
    lines.push(
      `  ${kebab}:`,
      `    cron: ${cronWithDefault(profile, parameters.cron.env, parameters.cron.default)}`,
      `    batch-size: ${envWithDefault(profile, parameters.batchSize.env, parameters.batchSize.default)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Los recurrentes y los componentes que el módulo del sondeador registra: `[{ symbol, from }]`. */
export function retentionProviders(model) {
  return retentionRoots(model).flatMap(({ entity }) => [
    { symbol: retentionClass(entity.name), from: retentionPath(entity.name), recurring: false },
    { symbol: retentionTimerClass(entity.name), from: retentionTimerPath(entity.name), recurring: true }
  ]);
}

/** Las constantes de TimerKinds de las retenciones. */
export function retentionKindLines(model) {
  return retentionRoots(model).map(
    ({ entity, root }) => `  /** La retención de ${entity.name} (DSL 2.28): un recurrente en modo clúster. */
  ${retentionKindConstant(entity.name)}: ${tsString(root.retention.kind)},`
  );
}

// ─── El arnés: ageDeletion ───────────────────────────────────────────────────

/**
 * `ageDeletion(entidad, id, días)` en `test/integration/support/flow.ts`: un escenario de la ventana de restauración o de
 * la purga desde el borrado no puede esperar 30 días. Retrasa la marca de borrado de una fila YA borrada y exige que haya
 * envejecido una. La sentencia es la de keel-core (`ageDeletionStatement`) y el script documental, `ageDeletionScript`:
 * la tabla sale del modelo. Relacional: sobre `db()`; documental: sobre `mongoEval()`. '' si no hay borrado lógico o el
 * arnés no tiene con qué.
 */
export function deletionAgingSection(model, { relational = false, document = false, uuidLiteral = null } = {}) {
  const targets = deletionAgingTargets(model);
  if (targets.length === 0) return '';
  const engine = model.stack?.database;
  if (relational && (!AGE_DELETION_ENGINES.includes(engine) || !uuidLiteral)) return '';
  if (!relational && !document) return '';
  const arms = targets
    .map((target) => {
      if (!relational) {
        const script = ageDeletionScript({ collection: target.collection });
        return `      case ${tsString(target.entity)}:
        return mongoEval(${tsString(script)}.replaceAll('{id}', deletionId(id)).replaceAll('{ms}', String(days * 86_400_000)));`;
      }
      const literal = `${uuidLiteral.prefix}\${deletionId(id)}${uuidLiteral.suffix}`;
      const sql = ageDeletionStatement(engine, target).replace(':days', '${days}').replace(':entityId', literal);
      return `      case ${tsString(target.entity)}:
        return db(\`${sql}\`);`;
    })
    .join('\n');
  const known = targets.map((target) => target.entity).join(', ');
  return `
/** Un id para la sentencia de ageDeletion: valida la forma antes de meterlo en el literal. */
function deletionId(id: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(\`No es un id: '\${id}'\`);
  return id;
}

/**
 * Envejece el borrado lógico de la fila \`id\` de \`entity\` (DSL 2.28): retrasa su marca de borrado \`days\` días, para que
 * un escenario de la ventana de restauración o de la purga no espere a que pase el tiempo. Solo envejece una fila YA
 * borrada, y falla si no envejeció ninguna: un id equivocado, o la llamada antes del DELETE. La tabla y la columna salen
 * del modelo, no de un SQL escrito a mano.
 *
 * No purga nada: la purga la hace el barrido de la retención en su próxima pasada, que se adelanta con \`fireTimer\`.
 *
 *   ageDeletion('${targets[0].entity}', id, 31);
 *
 * Entidades con borrado lógico en este diseño: ${known}.
 */
export function ageDeletion(entity: string, id: string, days: number): void {
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error(\`Los días tienen que ser un entero positivo: \${days}\`);
  const aged = ((): string => {
    switch (entity) {
${arms}
      default:
        throw new Error(\`No hay borrado lógico en la entidad '\${entity}'. Las que lo tienen: ${known}\`);
    }
  })();
  if (aged.trim().split('\\n').at(-1)?.trim() !== '1') {
    throw new Error(\`ageDeletion: \${entity} \${id} ${AGE_DELETION_MISS}.\`);
  }
}
`;
}

export { capital };
