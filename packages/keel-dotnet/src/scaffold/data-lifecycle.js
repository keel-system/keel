// El CICLO DE VIDA DEL DATO (DSL 2.28: `deletion: logical`, `restorableFor`/`restores` y `retention`) en keel-dotnet:
// incremento 3 de PLAN-DSL-228-CICLO-DE-VIDA.md, con el reparto de keel-spring y keel-nest. Lo que decide QUÉ (qué raíces,
// la columna, las unicidades entre vivas, el sustituto, la aritmética de la ventana y del corte, los parámetros del
// barrido, las notas) es de keel-core (gen/data-lifecycle.js, gen/relational.js, gen/timer-plan.js); aquí solo se escribe
// en C#:
//
//   · `DeletedAt` (y `AnonymizedAt`, D11) en la fila de EF o en el documento: los pone el generador, no el dominio (D1).
//     En el documento, con el nombre del campo tal cual (`deletedAt`), que es la ruta que filtran los índices parciales y
//     la que escriben keel-spring y keel-nest.
//   · Las lecturas VIVAS del adaptador: cada carga y cada listado suma `DeletedAt == null` (o `deletedAt: null`), y los
//     finders de búsqueda lo suman a su consulta DETRÁS del alcance (D2). `FindAllById`, la lectura por referencia, NO lo
//     lleva (D3).
//   · `DeleteById` MARCA la fila (D1), y `Restore`/`FindDeletedBy<Clave>` la devuelven a la vida dentro de la ventana (D6).
//     Con bloqueo optimista, marcar, restaurar y anonimizar SUBEN la versión, como el @Version de keel-spring: una escritura
//     que leyó antes (un handler en vuelo) sale como conflicto y no reescribe lo que la marca cambió.
//   · La retención: `<Raíz>Retention` (qué ha vencido, por lotes, y qué se hace con cada uno) y `<Raíz>RetentionTimer`, el
//     recurrente del cronómetro que la dispara en modo clúster (D8), con su lote y su cron en `retention.yaml`.

import { DELETED_AT, ANONYMIZED_AT, LOCK_VERSION, isLogicallyDeleted, persistedMembers } from '@keel-system/keel-core/gen/relational';
import { AGE_DELETION_ENGINES, AGE_DELETION_MISS, ANONYMOUS_PREFIX, ageDeletionStatement, deletedLookupOf, deletionAgingTargets, lifecycleRoots, retentionParameters } from '@keel-system/keel-core/gen/data-lifecycle';
import { ageDeletionScript } from '@keel-system/keel-core/gen/mongo-probes';
import { usesDocument, usesRelational } from '@keel-system/keel-core/gen/features';
import { usesMySql } from './relational-engine.js';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { documentShape, DOCUMENT_ID } from '@keel-system/keel-core/gen/document';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { snakeCase } from '@keel-system/keel-core/gen/naming';
import { csFile, csMember, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { parametersClass, parametersNamespace } from './service-parameters.js';
import { cacheMember } from './cache.js';
import { CHANGE_HISTORY_CLASS, historyInfraNamespace, historyRecordLine, recordsHistory, rootMember } from './history.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

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
export const retentionTimerClass = (entityName) => `${entityName}RetentionTimer`;
/** La constante de TimerKinds de una retención: `RetentionVerificationCode`, como `PurgeOutboxEvent`. */
export const retentionKindConstant = (entityName) => `Retention${entityName}`;
export const retentionNamespace = (model) => namespaceOf(model, 'retention');

/** Las marcas del generador en la fila o el documento: `[{ field, column }]`. Fuera del dominio y del contrato (D1, D11). */
export function lifecycleMarks(model, entity) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle) return [];
  return [...(lifecycle.logical ? [DELETED_AT] : []), ...(lifecycle.retention?.then === 'anonymize' ? [ANONYMIZED_AT] : [])];
}

/** El comentario de cada marca en la fila. */
export function markComment(mark) {
  return mark === DELETED_AT
    ? 'Borrado lógico (DSL 2.28): cuándo se borró, o null si está viva. La pone DeleteById y la quita Restore; ninguna lectura del puerto ve una fila con ella.'
    : 'Cuándo la anonimizó su retención (DSL 2.28, D11). Sin la marca, el barrido volvería a tomarla en cada pasada.';
}

const VERSION = csMember(LOCK_VERSION.field);
/** La línea que sube la versión de una fila de EF (el token de concurrencia: EF escribe `WHERE lock_version = @leída`). */
const rowBump = (entity, row, pad) => (entity.usesOptimisticLocking ? `\n${pad}${row}.${VERSION} = ${row}.${VERSION} + 1;` : '');
/** El `$inc` de la versión de un documento. */
const documentBump = (entity) => (entity.usesOptimisticLocking ? `, { "$inc", new BsonDocument(${csString(LOCK_VERSION.column)}, 1) }` : '');

const windowText = (restore) => (Number.isInteger(restore.days) ? `${restore.days} días` : `los días del parámetro ${restore.parameter}`);
const spanText = (span) => (span.days ? `${span.days} días` : span.years ? `${span.years} años` : `el parámetro ${span.parameter}`);

// ─── El predicado de vida ────────────────────────────────────────────────────────────────────────────────────────

/** La condición de vida sobre la fila de EF, para sumar con `&&` a la de una carga. */
export const ROW_ALIVE = `r.${csMember(DELETED_AT.field)} == null`;

/** La línea que el finder relacional suma a su consulta (D2), DETRÁS del alcance. */
export const RELATIONAL_LIVE_LINE = `        query = query.Where(r => ${ROW_ALIVE});`;

/** La línea que el finder documental suma a su filtro (D2), detrás del alcance. */
export const DOCUMENT_LIVE_LINE = '        query = Live(query);';

/** Los miembros del adaptador documental que componen la vida: el filtro y el que lo suma a otro. */
export function documentLiveMembers(entity) {
  if (!isLogicallyDeleted(entity)) return '';
  return `

    /// <summary>
    /// Vivo (DSL 2.28, D2): sin marca de borrado. <c>deletedAt: null</c> casa con el campo nulo y con el ausente, que es como
    /// están los documentos que nunca se borraron.
    /// </summary>
    private static readonly FilterDefinition<BsonDocument> NotDeleted = new BsonDocument(${csString(DELETED_AT.field)}, BsonNull.Value);

    /// <summary>Un filtro con la vida sumada: toda carga y todo listado del puerto, salvo la lectura por referencia (D3).</summary>
    private static FilterDefinition<BsonDocument> Live(FilterDefinition<BsonDocument> filter) => Builders<BsonDocument>.Filter.And(filter, NotDeleted);`;
}

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────────────────────

/** El finder de la borrada más reciente por la clave natural (D6): `{ name, finder }`, o null. */
export function deletedFinder(entity, keyFinder) {
  if (!keyFinder || !deletedLookupOf(entity)) return null;
  return { name: keyFinder.name.replace(/^FindBy/, 'FindDeletedBy'), finder: keyFinder };
}

const signatureOf = (finder) => finder.params.map((p) => `${p.type} ${p.local}`).join(', ');

/** La declaración de `DeleteById` en el puerto: con borrado lógico dice que marca. */
export function deletePortMethod(model, entity, idType, idName) {
  const declaration = `    Task DeleteById(${idType} ${idName}, CancellationToken cancellationToken = default);`;
  if (!lifecycleOf(model, entity)?.logical) return declaration;
  return `    /// <summary>
    /// Borrado LÓGICO (persistence.${entity.name}.deletion: logical, DSL 2.28): marca la fila y no la elimina. Desde ese
    /// momento ninguna lectura de este puerto la ve —salvo FindAllById, la lectura por referencia— y sus claves únicas
    /// quedan libres. Sobre una fila ya borrada o inexistente no hace nada.
    /// </summary>
${declaration}`;
}

/** Los métodos de restauración del puerto (D6). `keyFinder` lleva `params` con `type` y `local`. */
export function restorePortMethods(model, entity, idType, idName, keyFinder) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.restore) return [];
  const methods = [];
  const deleted = deletedFinder(entity, keyFinder);
  if (deleted) {
    methods.push(`    /// <summary>
    /// La fila BORRADA más reciente con esta clave, la única que tiene sentido restaurar (la clave queda libre al borrar, así
    /// que puede haber varias). Las cargas normales no la ven.
    /// </summary>
    Task<${entity.name}?> ${deleted.name}(${signatureOf(keyFinder)}, CancellationToken cancellationToken = default);`);
  }
  methods.push(`    /// <summary>
    /// Devuelve a la vida una fila borrada (restores: ${entity.name}). Null si no hay ninguna borrada con ese id. Fuera de la
    /// ventana (${windowText(lifecycle.restore)} desde el borrado) lanza ${lifecycle.restore.error}; si otra fila viva ocupa ya su clave
    /// única, la constraint salta al restaurarla, con el 409 de esa unicidad.
    /// </summary>
    Task<${entity.name}?> Restore(${idType} ${idName}, CancellationToken cancellationToken = default);`);
  return methods;
}

/** La operación que restaura una raíz: la que declara `restores`. */
function restoringOperationOf(model, entity) {
  return (model.services ?? []).flatMap((group) => group.operations ?? []).find((operation) => operation.restores === entity.name)?.name;
}

/** Los días de la ventana: el literal o el parámetro del servicio. */
const windowDays = (restore) => (Number.isInteger(restore.days) ? String(restore.days) : `parameters.${csMember(restore.parameter)}`);

/** El lanzamiento del error de la ventana. */
function windowError(model, entity, restore) {
  const error = operationError(model, restoringOperationOf(model, entity), restore.error);
  const message = csString(`${entity.name} borrado hace más de ${windowText(restore)}: ya no se puede restaurar.`);
  return `throw new ${error.exceptionClass}(${[message, ...(error.dynamicStatus ? [String(error.http ?? 409)] : [])].join(', ')});`;
}

/** Lo que el constructor del adaptador recibe para el ciclo de vida: los parámetros, si la ventana los lee. */
export function lifecycleDependencies(model, entity) {
  const restore = lifecycleOf(model, entity)?.restore;
  if (!restore?.parameter) return [];
  return [{ type: parametersClass(model), name: 'parameters', usings: [parametersNamespace(model)] }];
}

/** ¿Lanza el adaptador el error de la ventana? Entonces usa el namespace de los errores. */
export const throwsWindowError = (model, entity) => Boolean(lifecycleOf(model, entity)?.restore);

// ─── El adaptador EF Core ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `DeleteById` que marca, `FindDeletedBy<Clave>` y `Restore` sobre EF Core, o null si la raíz se borra físicamente.
 * `keyFinder` lleva los `params` (con `type` y `local`) y `keyQuery`, `{ locals, conditions }` de la carga por la clave.
 */
export function relationalAdapterMethods(model, entity, { idType, idName, keyFinder, keyQuery }) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  const id = csMember(entity.idField?.name ?? 'id');
  const deletedAt = csMember(DELETED_AT.field);
  const methods = [`    public async Task DeleteById(${idType} ${idName}, CancellationToken cancellationToken = default)
    {
        await transactions.InTransaction(
            async () =>
            {
                // Borrado lógico (DSL 2.28, D1): se marca y no se elimina. La fila deja de verse en toda lectura del puerto y
                // su clave única queda libre (los índices únicos de la tabla solo cuentan las filas vivas). Una ya borrada no
                // se vuelve a marcar: la ventana de restauración cuenta desde el primer borrado.
                var found = await db.Set<${rowName(entity)}>().SingleOrDefaultAsync(r => r.${id} == ${idName}, cancellationToken);
                if (found is { ${deletedAt}: null })
                {
                    found.${deletedAt} = DateTimeOffset.UtcNow;${rowBump(entity, 'found', '                    ')}
                    await db.SaveChangesAsync(cancellationToken);
${historyRecordLine(entity, 'deleted', idName, '                    ')}                }
                return true;
            },
            readOnly: false,
            cancellationToken);
    }`];
  if (lifecycle.restore) {
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) {
      methods.push(`    public async Task<${entity.name}?> ${deleted.name}(${signatureOf(keyFinder)}, CancellationToken cancellationToken = default)
    {
${keyQuery.locals.map((line) => `${line}\n`).join('')}        var found = await Graph().AsNoTracking()
            .Where(r => ${[...keyQuery.conditions, `r.${deletedAt} != null`].join(' && ')})
            .OrderByDescending(r => r.${deletedAt})
            .FirstOrDefaultAsync(cancellationToken);
        return found is null ? null : ToDomain(found);
    }`);
    }
    methods.push(`    public async Task<${entity.name}?> Restore(${idType} ${idName}, CancellationToken cancellationToken = default) =>
        await transactions.InTransaction<${entity.name}?>(
            async () =>
            {
                var deleted = await Graph().SingleOrDefaultAsync(r => r.${id} == ${idName} && r.${deletedAt} != null, cancellationToken);
                if (deleted is null)
                {
                    return null;
                }
                // La ventana (restorableFor, D6): restaurable mientras ${DELETED_AT.field} + ${windowText(lifecycle.restore)} sea posterior a ahora.
                if (!(deleted.${deletedAt}!.Value.AddDays(${windowDays(lifecycle.restore)}) > DateTimeOffset.UtcNow))
                {
                    ${windowError(model, entity, lifecycle.restore)}
                }
                // Si una fila viva ocupa ya su clave, la unicidad entre vivas salta AQUÍ, con su nombre: el 409 que la traduce.
                deleted.${deletedAt} = null;${rowBump(entity, 'deleted', '                ')}
                await db.SaveChangesAsync(cancellationToken);
${historyRecordLine(entity, 'restored', idName, '                ')}                return ToDomain(deleted);
            },
            readOnly: false,
            cancellationToken);`);
  }
  return methods;
}

const rowName = (entity) => `${entity.name}Row`;

// ─── El adaptador documental ─────────────────────────────────────────────────────────────────────────────────────

/** `DeleteById` que marca, `FindDeletedBy<Clave>` y `Restore` sobre el driver de MongoDB, o null. */
export function documentAdapterMethods(model, entity, { idType, idName, idFilter, keyFilter, keyFinder }) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  const field = csString(DELETED_AT.field);
  const notNull = `new BsonDocument(${field}, new BsonDocument("$ne", BsonNull.Value))`;
  const methods = [`    public async Task DeleteById(${idType} ${idName}, CancellationToken cancellationToken = default)
    {
        // Borrado lógico (DSL 2.28, D1): se marca y no se elimina. El documento deja de verse en toda lectura del puerto y su
        // clave única queda libre (los índices únicos solo cuentan los documentos con deletedAt nulo). Uno ya borrado no se
        // vuelve a marcar: la ventana de restauración cuenta desde el primer borrado.
        await transactions.InTransaction(
            async () =>
            {
                ${recordsHistory(entity) ? 'var marked = ' : ''}await Collection.UpdateOneAsync(
                    transactions.Session!,
                    Builders<BsonDocument>.Filter.And(${idFilter}, NotDeleted),
                    new BsonDocument { { "$set", new BsonDocument(${field}, BsonValues.Of(DateTimeOffset.UtcNow)) }${documentBump(entity)} },
                    cancellationToken: cancellationToken);${recordsHistory(entity) ? `
                if (marked.ModifiedCount > 0)
                {
${historyRecordLine(entity, 'deleted', idName, '                    ')}                }` : ''}
                return true;
            },
            readOnly: false,
            cancellationToken);
    }`];
  if (lifecycle.restore) {
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) {
      methods.push(`    public async Task<${entity.name}?> ${deleted.name}(${signatureOf(keyFinder)}, CancellationToken cancellationToken = default)
    {
        var found = await Find(Builders<BsonDocument>.Filter.And(${keyFilter}, ${notNull}))
            .Sort(new BsonDocument(${field}, -1))
            .FirstOrDefaultAsync(cancellationToken);
        return found is null ? null : ToDomain${entity.name}(found);
    }`);
    }
    methods.push(`    public async Task<${entity.name}?> Restore(${idType} ${idName}, CancellationToken cancellationToken = default) =>
        await transactions.InTransaction<${entity.name}?>(
            async () =>
            {
                var session = transactions.Session!;
                var deleted = await Collection.Find(session, Builders<BsonDocument>.Filter.And(${idFilter}, ${notNull})).FirstOrDefaultAsync(cancellationToken);
                if (deleted is null)
                {
                    return null;
                }
                // La ventana (restorableFor, D6): restaurable mientras ${DELETED_AT.field} + ${windowText(lifecycle.restore)} sea posterior a ahora.
                if (!(deleted[${field}].ToUniversalTime().AddDays(${windowDays(lifecycle.restore)}) > DateTime.UtcNow))
                {
                    ${windowError(model, entity, lifecycle.restore)}
                }
                // Si un documento vivo ocupa ya su clave, el índice único parcial salta AQUÍ, con su nombre (E11000).
                await Collection.UpdateOneAsync(
                    session,
                    ${idFilter},
                    new BsonDocument { { "$set", new BsonDocument(${field}, BsonNull.Value) }${documentBump(entity)} },
                    cancellationToken: cancellationToken);
${historyRecordLine(entity, 'restored', idName, '                ')}                var restored = await Collection.Find(session, ${idFilter}).FirstOrDefaultAsync(cancellationToken);
                return restored is null ? null : ToDomain${entity.name}(restored);
            },
            readOnly: false,
            cancellationToken);`);
  }
  return methods;
}

/** El filtro parcial de un índice del documento: la condición del diseño y, con borrado lógico, la vida (T1). */
export function partialFilterLiteral(spec, literal) {
  const entries = [
    ...(spec.partialFilter ? [[csString(spec.partialFilter.path), literal(spec.partialFilter.equals)]] : []),
    ...(spec.live ? [[csString(spec.live.path), 'BsonNull.Value']] : [])
  ];
  if (entries.length === 0) return null;
  if (entries.length === 1) return `new BsonDocument(${entries[0].join(', ')})`;
  return `new BsonDocument { ${entries.map(([key, value]) => `{ ${key}, ${value} }`).join(', ')} }`;
}

// ─── La retención ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la anonimización toca, por miembro (D9): `{ root: [{ property, value, fold? }], children: [{ relation, sets }] }`.
 * Un opcional va a null; un obligatorio, al sustituto `anon-<id>` de la RAÍZ. Una sombra plegada (T7) se reescribe con el
 * valor plegado del sustituto, o a null. `property` es la propiedad de la fila (relacional) o la clave del documento.
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
        else for (const sub of member.subs) sets.push({ property: csMember(sub.name), value: null });
        continue;
      }
      const folded = member?.folded;
      sets.push({
        property: document ? keyOf(owner, name) : csMember(name),
        value: required ? 'substitute' : null,
        fold: folded ? { property: document ? keyOf(owner, folded.name) : csMember(folded.name), accents: Boolean(folded.accents) } : null
      });
    }
    return sets;
  };
  const children = persistedMembers(model, entity)
    .filter((member) => member.kind === 'relationMany' && byEntity.has(member.relation.entity))
    .map((member) => ({
      relation: document ? keyOf(entity, member.name) : csMember(member.name),
      sets: setsOf(model.entities.find((candidate) => candidate.name === member.relation.entity))
    }));
  return { entity, root: setsOf(entity), children };
}

/**
 * Lo que keel-dotnet no sabe anonimizar (miembros que no son escalares ni value objects, o entidades que no son la raíz ni
 * una hija uno-a-muchos): el mismo criterio que keel-spring y keel-nest.
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
 * Lo que el ciclo de vida del dato no puede generar con este stack, o []. keel-dotnet solo genera motores con índice parcial
 * (PostgreSQL) o con la columna generada (MySQL), y MongoDB con el filtro parcial, así que la unicidad entre vivas siempre
 * tiene forma; lo que queda es lo que no sabe anonimizar. A medias, un dato personal sobreviviría a su retención sin que
 * nada lo dijera.
 */
export function lifecycleStackErrors(model) {
  return anonymizeGaps(model).map(
    (gap) => `persistence: retention con then: anonymize (DSL 2.28): keel-dotnet no sabe anonimizar ${gap}. Márcalo sin personal o usa then: delete.`
  );
}

/** Las líneas que anonimizan el agregado (una fila de EF o un documento) cuya raíz es `target`. */
function anonymizeLines(plan, idExpression, target, pad, { document }) {
  const lines = [];
  const value = (set) => (set.value === 'substitute' ? (document ? 'new BsonString(substitute)' : 'substitute') : document ? 'BsonNull.Value' : 'null');
  const folded = (set) =>
    set.value === 'substitute'
      ? `${document ? 'new BsonString(' : ''}TextFold.${set.fold.accents ? 'FoldCaseAndAccents' : 'FoldCase'}(substitute)${document ? ')' : ''}`
      : document
        ? 'BsonNull.Value'
        : 'null';
  const write = (node, sets, indent) => {
    for (const set of sets) {
      lines.push(document ? `${indent}${node}[${csString(set.property)}] = ${value(set)};` : `${indent}${node}.${set.property} = ${value(set)};`);
      if (set.fold) lines.push(document ? `${indent}${node}[${csString(set.fold.property)}] = ${folded(set)};` : `${indent}${node}.${set.fold.property} = ${folded(set)};`);
    }
  };
  if ([...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.value === 'substitute')) {
    lines.push(`${pad}var substitute = ${csString(ANONYMOUS_PREFIX)} + Convert.ToString(${idExpression}, CultureInfo.InvariantCulture);`);
  }
  write(target, plan.root, pad);
  for (const child of plan.children) {
    const source = document
      ? `${target}.GetValue(${csString(child.relation)}, BsonNull.Value) is BsonArray ${child.relation.replace(/\W/g, '')} ? ${child.relation.replace(/\W/g, '')}.OfType<BsonDocument>() : Enumerable.Empty<BsonDocument>()`
      : `${target}.${child.relation}`;
    lines.push(`${pad}foreach (var child in ${source})`, `${pad}{`);
    write('child', child.sets, `${pad}    `);
    lines.push(`${pad}}`);
  }
  return lines;
}

/** Los usings de la anonimización: la cultura del sustituto y, con una sombra plegada, TextFold. */
const anonymizeUsings = (plan) => [
  ...([...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.value === 'substitute') ? ['System.Globalization'] : [])
];

/** Los archivos de la retención: un `<Raíz>Retention` por raíz, su recurrente, la configuración de los barridos y su yaml. */
export function generate(model) {
  const roots = retentionRoots(model);
  if (roots.length === 0) return [];
  const document = model.persistenceKind === 'document';
  const settings = located(model, 'retention', 'RetentionSettings');
  return [
    ...roots.flatMap(({ entity, root }) => [document ? documentRetention(model, entity, root) : relationalRetention(model, entity, root), retentionTimer(model, entity, root)]),
    { path: settings.path, content: csFile({ namespace: settings.namespace, usings: ['System.Globalization', configNamespace(model)], body: retentionSettingsBody(model) }) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/retention.yaml`, content: retentionYaml(model, profile) }))
  ];
}

function retentionDoc(entity, retention) {
  return `/// <summary>
/// La retención de ${entity.name} (persistence.${entity.name}.retention, DSL 2.28): ${retention.fromDeleted ? 'desde el borrado lógico' : `desde ${retention.from}`}, ${spanText(retention.span)}, y
/// después ${retention.then === 'delete' ? 'se BORRA' : 'se ANONIMIZA'}. La dispara ${retentionTimerClass(entity.name)}, un recurrente del cronómetro en modo clúster
/// (D8): cada tick lo ejecuta UNA réplica.
/// </summary>
/// <remarks>
/// Por lotes y cada agregado en su transacción (un ámbito propio por agregado): una tabla grande no se recorre en un solo
/// DELETE que bloquee la tabla y reviente el tope de transacción. Una fila con ${retention.from} nulo no vence nunca.
/// </remarks>`;
}

function relationalRetention(model, entity, root) {
  const { namespace, path } = located(model, 'retention', retentionClass(entity.name));
  const row = rowName(entity);
  const context = `${model.service.rootNamespace}DbContext`;
  const id = csMember(entity.idField?.name ?? 'id');
  const idType = entity.idField?.csType ?? 'Guid';
  const retention = root.retention;
  const from = csMember(retention.from);
  const includes = includeTree(model, entity).map((pathName) => `.Include(${csString(pathName)})`).join('');
  const usings = ['Microsoft.EntityFrameworkCore', 'Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'persistence'), namespaceOf(model, 'rows')];
  let outcome;
  if (retention.then === 'delete') {
    outcome = `                // then: delete. Se carga y se borra el GRAFO, como DeleteById: las hijas y las listas van con la raíz (T3).
                var found = await db.Set<${row}>()${includes}.SingleOrDefaultAsync(r => r.${id} == id, cancellationToken);
                if (found is not null)
                {
                    db.Remove(found);
                    await db.SaveChangesAsync(cancellationToken);${retentionHistory(model, entity, retention, usings, '                    ')}
                }`;
  } else {
    const plan = anonymizePlan(model, root, { document: false });
    usings.push(...anonymizeUsings(plan));
    const lines = anonymizeLines(plan, 'id', 'found', '                ', { document: false });
    outcome = `                // then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que no
                // deriva del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
                var found = await db.Set<${row}>()${includes}.SingleOrDefaultAsync(r => r.${id} == id, cancellationToken);
                if (found is null)
                {
                    return true;
                }
${lines.join('\n')}
                found.${csMember(ANONYMIZED_AT.field)} = DateTimeOffset.UtcNow;${rowBump(entity, 'found', '                ')}
                await db.SaveChangesAsync(cancellationToken);${retentionHistory(model, entity, retention, usings, '                ')}`;
  }
  const pending = retention.then === 'anonymize' ? ` && r.${csMember(ANONYMIZED_AT.field)} == null` : '';
  const body = `${retentionDoc(entity, retention)}
public sealed class ${retentionClass(entity.name)}(IServiceScopeFactory scopes)
{
    /// <summary>Los ids que han vencido en <paramref name="cutoff"/> (vence EN el corte), los más antiguos primero, como mucho <paramref name="limit"/>.</summary>
    public async Task<IReadOnlyList<${idType}>> Due(DateTimeOffset cutoff, int limit, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<${context}>();
        return await db.Set<${row}>().AsNoTracking()
            .Where(r => r.${from} <= cutoff${pending})
            .OrderBy(r => r.${from})
            .Select(r => r.${id})
            .Take(limit)
            .ToListAsync(cancellationToken);
    }

    /// <summary>Lo que la retención hace con un agregado vencido, en su propia transacción.</summary>
    public async Task Apply(${idType} id, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<${context}>();
        await scope.ServiceProvider.GetRequiredService<PersistenceTransactions>().InTransaction(
            async () =>
            {
${outcome}
                return true;
            },
            readOnly: false,
            cancellationToken);
    }
}`;
  if (body.includes('TextFold.')) usings.push(namespaceOf(model, 'persistence'));
  return { path, content: csFile({ namespace, usings, body }) };
}

/**
 * Lo que la retención le hace al historial de la raíz (DSL 2.29, D8): `then: delete` se lo lleva y `then: anonymize`
 * reescribe sus valores personales y deja la entrada `anonymized`, en la misma transacción (el almacén del ámbito de la
 * pasada usa su contexto o su sesión). Las líneas a continuación de lo que hace la retención, o '' sin historial.
 */
function retentionHistory(model, entity, retention, usings, pad) {
  if (!recordsHistory(entity)) return '';
  usings.push(historyInfraNamespace(model));
  const call = retention.then === 'delete'
    ? `Purge(${rootMember(entity)}.Type, HistorySupport.Key(id), cancellationToken)`
    : `Anonymize(${rootMember(entity)}.Type, HistorySupport.Key(id), ${rootMember(entity)}.Personal, cancellationToken)`;
  return `\n${pad}// El historial de la raíz sigue su régimen (DSL 2.29, D8), en la misma transacción.\n${pad}await scope.ServiceProvider.GetRequiredService<${CHANGE_HISTORY_CLASS}>().${call};`;
}

/** Las rutas de navegación del agregado (las del Graph() del adaptador): lo que se carga y se borra con la raíz. */
function includeTree(model, entity, prefix = '', seen = new Set([entity.name])) {
  const paths = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'elementCollection') paths.push(`${prefix}${csMember(member.name)}`);
    else if (member.kind === 'relationMany' && member.relation.cardinality !== 'many-to-many') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      if (!child || seen.has(child.name)) continue;
      const here = `${prefix}${csMember(member.name)}`;
      const nested = includeTree(model, child, `${here}.`, new Set([...seen, child.name]));
      paths.push(...(nested.length > 0 ? nested : [here]));
    }
  }
  return paths;
}

function documentRetention(model, entity, root) {
  const { namespace, path } = located(model, 'retention', retentionClass(entity.name));
  const idField = entity.idField;
  const idType = idField?.csType ?? 'Guid';
  const retention = root.retention;
  const uuid = idType === 'Guid';
  const usings = ['MongoDB.Bson', 'MongoDB.Driver', 'Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'persistence')];
  const write = 'BsonValues.Of(id)';
  const read = uuid ? `document[${csString(DOCUMENT_ID)}].AsGuid` : idType === 'long' ? `document[${csString(DOCUMENT_ID)}].ToInt64()` : idType === 'int' ? `document[${csString(DOCUMENT_ID)}].ToInt32()` : `document[${csString(DOCUMENT_ID)}].AsString`;
  const fromKey = retention.fromDeleted ? DELETED_AT.field : documentShape(model, entity).find((entry) => entry.member === retention.from)?.name ?? snakeCase(retention.from);
  let outcome;
  if (retention.then === 'delete') {
    outcome = `                // then: delete. El agregado es el documento: sus hijas se van con él.
                await collection.DeleteOneAsync(transactions.Session!, new BsonDocument(${csString(DOCUMENT_ID)}, ${write}), cancellationToken: cancellationToken);${retentionHistory(model, entity, retention, usings, '                ')}`;
  } else {
    const plan = anonymizePlan(model, root, { document: true });
    usings.push(...anonymizeUsings(plan));
    const lines = anonymizeLines(plan, 'id', 'found', '                ', { document: true });
    outcome = `                // then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que no
                // deriva del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
                var session = transactions.Session!;
                var filter = new BsonDocument(${csString(DOCUMENT_ID)}, ${write});
                var found = await collection.Find(session, filter).FirstOrDefaultAsync(cancellationToken);
                if (found is null)
                {
                    return true;
                }
${lines.join('\n')}
                found[${csString(ANONYMIZED_AT.field)}] = BsonValues.Of(DateTimeOffset.UtcNow);${entity.usesOptimisticLocking ? `\n                found[${csString(LOCK_VERSION.column)}] = found[${csString(LOCK_VERSION.column)}].IsInt32 ? new BsonInt32(found[${csString(LOCK_VERSION.column)}].AsInt32 + 1) : new BsonInt64(found[${csString(LOCK_VERSION.column)}].ToInt64() + 1);` : ''}
                await collection.ReplaceOneAsync(session, filter, found, cancellationToken: cancellationToken);${retentionHistory(model, entity, retention, usings, '                ')}`;
  }
  const pending = retention.then === 'anonymize' ? `, { ${csString(ANONYMIZED_AT.field)}, BsonNull.Value }` : '';
  const body = `${retentionDoc(entity, retention)}
public sealed class ${retentionClass(entity.name)}(IServiceScopeFactory scopes)
{
    private const string CollectionName = ${csString(entity.collectionName)};

    /// <summary>Los ids que han vencido en <paramref name="cutoff"/> (vence EN el corte), los más antiguos primero, como mucho <paramref name="limit"/>.</summary>
    public async Task<IReadOnlyList<${idType}>> Due(DateTimeOffset cutoff, int limit, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var collection = scope.ServiceProvider.GetRequiredService<PersistenceTransactions>().Collection(CollectionName);
        var documents = await collection
            .Find(new BsonDocument { { ${csString(fromKey)}, new BsonDocument("$lte", BsonValues.Of(cutoff)) }${pending} })
            .Project(Builders<BsonDocument>.Projection.Include(${csString(DOCUMENT_ID)}))
            .Sort(new BsonDocument(${csString(fromKey)}, 1))
            .Limit(limit)
            .ToListAsync(cancellationToken);
        return [.. documents.Select(document => ${read})];
    }

    /// <summary>Lo que la retención hace con un agregado vencido, en su propia transacción.</summary>
    public async Task Apply(${idType} id, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var transactions = scope.ServiceProvider.GetRequiredService<PersistenceTransactions>();
        var collection = transactions.Collection(CollectionName);
        await transactions.InTransaction(
            async () =>
            {
${outcome}
                return true;
            },
            readOnly: false,
            cancellationToken);
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** El corte de una retención en C#: la aritmética de `retentionCutoffMs` de keel-core (AddYears ya lleva el 29 de febrero al 28). */
function cutoffExpression(model, span) {
  if (span.days) return `now.AddDays(-${span.days})`;
  if (span.years) return `now.AddYears(-${span.years})`;
  const value = `parameters.${csMember(span.parameter)}`;
  return span.unit === 'years' ? `now.AddYears(-${value})` : `now.AddDays(-${value})`;
}

function retentionTimer(model, entity, root) {
  const { namespace, path } = located(model, 'timer', retentionTimerClass(entity.name));
  const span = root.retention.span;
  const caches = retentionCaches(model, entity.name);
  const usesParameters = Boolean(span.parameter);
  const deps = [
    `${retentionClass(entity.name)} retention`,
    'RetentionSettings settings',
    ...(usesParameters ? [`${parametersClass(model)} parameters`] : []),
    ...(caches.length > 0 ? ['IOperationCache operationCache'] : [])
  ];
  const usings = [
    retentionNamespace(model),
    ...(usesParameters ? [parametersNamespace(model)] : []),
    ...(caches.length > 0 ? [namespaceOf(model, 'ports'), namespaceOf(model, 'appSupport')] : [])
  ];
  const sweep = csMember(settingsKey(entity.name));
  const years = Boolean(span.years) || span.unit === 'years';
  const body = `/// <summary>
/// La retención de ${entity.name} como recurrente del cronómetro en modo clúster (DSL 2.28, D8): cada tick lo ejecuta UNA
/// réplica, la que gana su fila en keel_timer. Corre FUERA de toda transacción, y cada agregado en la suya.
/// </summary>
/// <remarks>
/// El corte lo calcula el servidor: ${spanText(span)} antes de ahora${years ? ', en años de calendario UTC' : ''}. Lo que venció EN el corte
/// también se va. El tick repite el lote mientras salga lleno.
/// </remarks>
public sealed class ${retentionTimerClass(entity.name)}(${deps.join(', ')}) : IRecurringTimerHandler
{
    public string Kind => TimerKinds.${retentionKindConstant(entity.name)};

    public string Spec => settings.${sweep}.Cron;

    public async Task Tick(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var cutoff = ${cutoffExpression(model, span)};${caches.length > 0 ? '\n        var processed = 0;' : ''}
        while (true)
        {
            var due = await retention.Due(cutoff, settings.${sweep}.BatchSize, cancellationToken);
            foreach (var id in due)
            {
                await retention.Apply(id, cancellationToken);
            }${caches.length > 0 ? '\n            processed += due.Count;' : ''}
            if (due.Count < settings.${sweep}.BatchSize)
            {
                break;
            }
        }${caches.length > 0
          ? `
        // Lo vencido ya no es lo que guardan las lecturas de ${entity.name} en la caché (T5): se vacían, como al borrar.
        if (processed > 0)
        {
${caches.map((cache) => `            await operationCache.Clear(CachedOperations.${cacheMember(cache.operation)}, cancellationToken);`).join('\n')}
        }`
          : ''}
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** La propiedad de una raíz en RetentionSettings (`VerificationCode`). */
const settingsKey = (entityName) => entityName;
const configKey = (key) => key.replaceAll('.', ':');

/** La configuración de los barridos: el cron y el lote de cada raíz, con las claves y los defaults de keel-core. */
function retentionSettingsBody(model) {
  const roots = retentionRoots(model);
  const reads = roots.map(({ entity }) => {
    const parameters = retentionParameters(entity.name);
    return `            new RetentionSweep(
                Text(configuration, ${csString(configKey(parameters.cron.key))}, ${csString(parameters.cron.default)}),
                Positive(configuration, ${csString(configKey(parameters.batchSize.key))}, ${parameters.batchSize.default}))`;
  });
  return `/// <summary>Un barrido de retención: su cron (seis campos, con segundos, en UTC) y los agregados por lote.</summary>
public sealed record RetentionSweep(string Cron, int BatchSize);

/// <summary>
/// Los barridos de retención (DSL 2.28) del perfil activo, con las claves y los defaults de keel-core (retentionParameters),
/// los mismos que leen keel-spring y keel-nest. Un lote que no es un entero positivo no deja arrancar.
/// </summary>
public sealed record RetentionSettings(${roots.map(({ entity }) => `RetentionSweep ${csMember(settingsKey(entity.name))}`).join(', ')})
{
    public static RetentionSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new RetentionSettings(
${reads.join(',\n')});
    }

    private static string Text(ServiceConfiguration configuration, string key, string fallback) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : fallback;

    private static int Positive(ServiceConfiguration configuration, string key, int fallback)
    {
        var value = configuration.Get(key);
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un entero positivo: '{value}'");
    }
}`;
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

/** Lo que AddTimer registra de las retenciones: el componente que barre y su recurrente. */
export function retentionRegistrations(model) {
  return retentionRoots(model).flatMap(({ entity }) => [
    `        services.AddScoped<${retentionClass(entity.name)}>();`,
    `        services.AddScoped<IRecurringTimerHandler, ${retentionTimerClass(entity.name)}>();`
  ]);
}

/** Las constantes de TimerKinds de las retenciones. */
export function retentionKindLines(model) {
  return retentionRoots(model).map(
    ({ entity, root }) => `    /// <summary>La retención de ${entity.name} (DSL 2.28): un recurrente en modo clúster.</summary>
    public const string ${retentionKindConstant(entity.name)} = ${csString(root.retention.kind)};`
  );
}

// ─── El arnés de flujos: AgeDeletion ─────────────────────────────────────────────────────────────

const AGE_DELETION_DOC = (example) => `    /// <summary>
    /// Envejece el borrado lógico de la fila <paramref name="id"/> de <paramref name="entity"/>: retrasa su marca de borrado
    /// <paramref name="days"/> días, para que un escenario de la ventana de restauración o de la purga no espere a que pase el
    /// tiempo. Solo envejece una fila YA borrada, y falla si no envejeció ninguna: un id equivocado, o la llamada antes del
    /// DELETE. La tabla y la columna salen del modelo, no de un SQL escrito a mano.
    /// </summary>
    /// <remarks>
    /// No purga nada: la purga la hace el barrido de la retención en su próxima pasada, que se adelanta con <c>FireTimer</c>.
    /// <code>
    /// AgeDeletion(${csString(example)}, id, 31);
    /// </code>
    /// </remarks>`;

/** La firma y el cuerpo de AgeDeletion con un brazo por raíz; `call` da la expresión que envejece una. */
function ageDeletionMember(targets, call) {
  const known = targets.map((target) => target.entity).join(', ');
  const arms = targets.map((target) => `            ${csString(target.entity)} => ${call(target)},`);
  return `${AGE_DELETION_DOC(targets[0].entity)}
    protected static void AgeDeletion(string entity, string id, int days)
    {
        if (days <= 0) throw new ArgumentOutOfRangeException(nameof(days), days, "Los días tienen que ser un entero positivo.");
        var aged = entity switch
        {
${arms.join('\n')}
            _ => throw new ArgumentException($"No hay borrado lógico en la entidad '{entity}'. Las que lo tienen: ${known}", nameof(entity)),
        };
        if (aged.Trim().Split('\\n')[^1].Trim() != "1")
            throw new InvalidOperationException($"AgeDeletion: {entity} {id} ${AGE_DELETION_MISS}.");
    }`;
}

const invariant = (expression) => `${expression}.ToString(System.Globalization.CultureInfo.InvariantCulture)`;

/**
 * `AgeDeletion(entidad, id, días)` en FlowTest sobre una base relacional, o []: la sentencia es la de keel-core
 * (`ageDeletionStatement`) con sus marcadores puestos, y el id va por el `IdLiteral` del arnés.
 */
export function relationalDeletionAgingMembers(model) {
  if (!usesRelational(model)) return [];
  const engine = usesMySql(model) ? 'mysql' : 'postgresql';
  const targets = deletionAgingTargets(model);
  if (targets.length === 0 || !AGE_DELETION_ENGINES.includes(engine)) return [];
  const values = { ':days': invariant('days'), ':entityId': 'IdLiteral(id)' };
  return [
    ageDeletionMember(targets, (target) => {
      const sql = ageDeletionStatement(engine, target)
        .split(/(:days|:entityId)/)
        .filter((piece) => piece !== '')
        .map((piece) => values[piece] ?? csString(piece))
        .join(' + ');
      return `Db(${sql})`;
    })
  ];
}

/** `AgeDeletion` sobre documentos: el script de keel-core (`ageDeletionScript`) con sus marcadores. */
export function documentDeletionAgingMembers(model) {
  if (!usesDocument(model)) return [];
  const targets = deletionAgingTargets(model);
  if (targets.length === 0) return [];
  return [
    ageDeletionMember(
      targets,
      (target) =>
        `MongoEval(${csString(ageDeletionScript({ collection: target.collection }))}.Replace("{id}", DocumentId(id), StringComparison.Ordinal).Replace("{ms}", ${invariant('(days * 86_400_000L)')}, StringComparison.Ordinal))`
    )
  ];
}
