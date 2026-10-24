// Persistencia hexagonal de cada raíz de agregado persistida, el mismo reparto que keel-spring y keel-nest:
//   · el PUERTO `I<Raíz>Repository` en Domain/Repository, que solo nombra el dominio y la página (Page.cs);
//   · el ADAPTADOR `<Raíz>Repository` en Infrastructure/Persistence/Repositories, sobre EF Core, con el mapeo
//     dominio ↔ fila escrito campo a campo (ToDomain/Apply), sin reflexión ni AutoMapper. Con persistencia
//     documental, el adaptador es otro (document-repositories.js, sobre el driver de MongoDB) y el puerto, el mismo.
//
// El adaptador usa el DbContext del ámbito, que es el de la transacción que abrió el mediator: los handlers no ven
// la transacción. Una escritura sin transacción abarcadora (un barrido despachado sin ella) abre la suya.
//
// Guardar es fusionar, como el merge de Hibernate con una entidad detached: se carga el grafo de filas y se le
// lleva el estado del agregado (RowSync), en vez de borrar e insertar. Con bloqueo optimista, la versión que leyó
// el agregado es el valor ORIGINAL del token de concurrencia y la fila sube a la siguiente: EF escribe
// `UPDATE … WHERE lock_version = @leída`, y cero filas es otra escritura que ganó (un 409).

import { inverseFindersOf } from 'keel-core/gen/inverse-collections';
import { bridgeClass, messagingNamespace, usesBridge } from './messaging.js';
import {
  persistedMembers,
  collectInternalEntities,
  orderingFieldOf,
  orderingTieBreakerOf,
  partialUniqueIndexes,
  uniqueFields,
  keyShadow,
  LOCK_VERSION,
  claimsForEntity,
  naturalKeyBatchReason
} from 'keel-core/gen';
import { idBatchReason } from 'keel-core/gen/ref-targets';
import { csFile, csLocal, csMember, csString, isNullable, located, namespaceOf, typeUsings, xmlDoc, entityPlace } from './render.js';
import { filterRecordFiles, finderEnums, needsOrdering, portFinderMethods, relationalFinderMethods, sortConstants } from './finders.js';
import { domainMembers } from './entities.js';
import { adapterClaimMethods, adapterGuardMethods, claimDependencies, claimUsings, guardDependencies, portClaimMethods, portGuardMethods } from './claim.js';
import { adapterReconciliationMethods, portReconciliationMethods, reconciliationDependencies } from './reconciliation-claim.js';
import { renderDocumentAdapter } from './document-repositories.js';
import {
  usesPersistence,
  usesDocument,
  rowClass,
  elementClass,
  dbContextClass,
  rowsNamespace,
  persistenceNamespace,
  auditColumns
} from './persistence.js';

/** ¿Emite eventos de dominio este agregado? */
export function emitsEvents(model, entity) {
  return (model.events ?? []).some((event) => event.aggregates.includes(entity.name));
}

export const portClass = (entity) => `I${entity.name}Repository`;
export const adapterClass = (entity) => `${entity.name}Repository`;

/** Las raíces que tienen repositorio: persistidas y raíz de su agregado. */
export function repositoryRoots(model) {
  if (!usesPersistence(model)) return [];
  return model.entities.filter((entity) => entity.persisted && entity.isAggregateRoot);
}

/** ¿Alguna operación de la raíz pagina? Entonces el puerto lleva `List(pageable)`. */
export function isPaginated(model, entity) {
  return (model.services ?? []).some((group) => group.entity === entity.name && (group.operations ?? []).some((op) => op.paginated));
}

/** La raíz persistida del grupo de una operación (la de su raíz si opera sobre una hija), o null. */
export function repositoryOf(model, operation) {
  const service = (model.services ?? []).find((group) => (group.operations ?? []).includes(operation));
  if (!service) return null;
  const target = model.entities.find((entity) => entity.name === service.entity);
  const rootName = target?.rootEntity ?? service.entity;
  return repositoryRoots(model).find((entity) => entity.name === rootName) ?? null;
}

export function repositoriesNamespace(model) {
  return namespaceOf(model, 'repositories');
}

export function generate(model) {
  const roots = repositoryRoots(model);
  if (roots.length === 0) return [];
  const { namespace, path } = located(model, 'repositories', 'Page');
  const files = [{ path, content: csFile({ namespace, body: pageBody() }) }];
  for (const entity of roots) {
    files.push(renderPort(model, entity));
    // Los filtros de cada búsqueda con finder (DSL 2.22), junto al puerto que los recibe.
    files.push(...filterRecordFiles(model, entity));
    // El adaptador, por modelo: el relacional sobre EF Core y el documental sobre el driver de MongoDB (incremento 12).
    files.push(usesDocument(model) ? renderDocumentAdapter(model, entity) : renderAdapter(model, entity));
  }
  return files;
}

/** ¿Llama algún adaptador relacional a RowValues.Unmapped (un value object que build no sabe mapear)? */
export function usesUnmapped(model) {
  if (usesDocument(model)) return false;
  return repositoryRoots(model).some((entity) => renderAdapter(model, entity).content.includes('RowValues.Unmapped<'));
}

// ─── La página ───────────────────────────────────────────────────────────────────────────────────

function pageBody() {
  return `/// <summary>El sentido de un criterio de orden.</summary>
public enum SortDirection
{
    Asc,
    Desc
}

/// <summary>
/// Un criterio de orden, como lo nombra el contrato: la propiedad de la columna (<c>name</c>, <c>createdAt</c>,
/// <c>priceAmount</c> para un value object aplanado), la misma que acepta el <c>?sort=</c> de keel-spring.
/// </summary>
public sealed record SortOrder(string Property, SortDirection Direction);

/// <summary>
/// La página pedida, sin framework: el dominio la nombra y el adaptador la resuelve. La misma semántica que el
/// Pageable de Spring Data que usa keel-spring: página desde 0, tamaño ya acotado al tope del diseño y el orden en
/// prioridad (vacío: el que decida el adaptador, el id). El desempate por id lo pone siempre el adaptador.
/// </summary>
public sealed record Pageable(int Page, int Size, IReadOnlyList<SortOrder> Sort);

/// <summary>Una página de resultados con sus totales.</summary>
public sealed record Page<T>(IReadOnlyList<T> Items, int Number, int Size, long TotalElements, int TotalPages)
{
    /// <summary>La misma página con sus elementos transformados (la del dominio → la del contrato).</summary>
    public Page<TResult> Map<TResult>(Func<T, TResult> map) => new([.. Items.Select(map)], Number, Size, TotalElements, TotalPages);
}`;
}

// ─── Finders ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Un finder por unas claves del diseño, resuelto contra los MIEMBROS del dominio: una clave que atraviesa otro
 * agregado (`naturalKey: [owner, slug]`) se busca por `ownerId`, que es lo que el agregado guarda. Cada parámetro
 * dice su tipo y las condiciones que pone sobre la fila.
 */
function keyFinder(model, entity, keys) {
  if (keys.length === 0) return null;
  const members = domainMembers(model, entity);
  const persisted = persistedMembers(model, entity);
  const params = keys.map((key) => {
    const member = members.find((m) => m.name === key || m.relation?.name === key);
    if (!member) return { name: key, type: 'string', where: [[csMember(key), csLocal(key)]], usings: [] };
    if (member.kind === 'externalRef') return { name: member.name, type: member.type.replace(/\?$/, ''), where: [[csMember(member.name), csLocal(member.name)]], usings: [] };
    const field = member.field;
    if (field?.kind === 'composite') {
      const vo = persisted.find((m) => m.kind === 'vo' && m.name === field.name);
      return {
        name: field.name,
        type: field.csType,
        where: (vo?.subs ?? []).map((sub) => [csMember(sub.name), `${csLocal(field.name)}.${csMember(sub.voAccessor)}`]),
        usings: typeUsings(model, [field.csType])
      };
    }
    // Un campo con `compare: ignore-case` se busca por su SOMBRA plegada, que es lo que la unicidad indexa: por el
    // valor crudo, «Tools» no encontraría la categoría «tools» que el índice dice que ya existe.
    const shadow = keyShadow(field);
    const usings = typeUsings(model, [field.csType]);
    if (shadow) return { name: field.name, type: field.csType, where: [[csMember(shadow.name), `TextFold.${shadow.accents ? 'FoldCaseAndAccents' : 'FoldCase'}(${csLocal(field.name)})`]], usings, fold: true };
    return { name: field.name, type: field.csType, where: [[csMember(field.name), csLocal(field.name)]], usings };
  });
  return { name: `FindBy${params.map((p) => csMember(p.name)).join('And')}`, params };
}

/** El finder de la clave natural (`FindBySku`), o null. */
export function naturalKeyFinder(model, entity) {
  return keyFinder(model, entity, entity.naturalKey ?? []);
}

// Las bases que se buscan por lote con un IN sobre el valor tal cual: un value object compuesto, un enum o una clave con
// su sombra plegada necesitarían traducir cada valor, y una consulta que no casara nada sin error sería peor que no tener lote.
const BATCHABLE_BASES = new Set(['string', 'text', 'int', 'long']);

/**
 * El finder por LOTE de la clave natural (`FindAllBySkuIn`), cuando keel-core dice que hace falta (`naturalKeyBatchReason`:
 * la réplica que lee un listado, la clave que es el `over` del alcance, una entrada que lista la clave). El mismo criterio
 * que keel-spring y keel-nest; sin él, el camino de menor resistencia es una consulta por elemento de la página.
 */
export function naturalKeyBatchFinder(model, entity) {
  const reason = naturalKeyBatchReason(model, entity);
  if (!reason) return null;
  const finder = naturalKeyFinder(model, entity);
  if (!finder || finder.params.length !== 1) return null;
  const [param] = finder.params;
  const field = entity.fields.find((candidate) => candidate.name === param.name);
  if (!field || param.fold || field.kind === 'composite' || field.kind === 'enum' || !BATCHABLE_BASES.has(field.base)) return null;
  const plural = `${csLocal(param.name).replace(/^@/, '')}${param.name.endsWith('s') ? 'es' : 's'}`;
  return { reason, name: `FindAllBy${csMember(param.name)}In`, field, param, plural, type: param.type };
}

/**
 * Los finders de la fila que OCUPA cada índice único condicionado (`indexes` con `when` sobre un campo directo):
 * como mucho una por clave. La operación que releva la busca aquí para retirarla antes de activar la nueva. El
 * mismo criterio que keel-spring y keel-nest.
 */
export function occupantFinders(model, entity) {
  const seen = new Set([naturalKeyFinder(model, entity)?.name].filter(Boolean));
  const finders = [];
  for (const index of partialUniqueIndexes(entity)) {
    if (!index.when?.field || index.when.field.includes('.')) continue;
    const finder = keyFinder(model, entity, [...index.fields, index.when.field]);
    if (!finder || seen.has(finder.name)) continue;
    seen.add(finder.name);
    finders.push({ ...finder, state: index.when.equals });
  }
  return finders;
}

/** El finder de cada campo `unique` suelto de la raíz: para comprobar la unicidad ANTES de un efecto irreversible. */
export function uniqueFieldFinders(model, entity) {
  const seen = new Set([naturalKeyFinder(model, entity)?.name, ...occupantFinders(model, entity).map((f) => f.name)].filter(Boolean));
  const finders = [];
  for (const field of uniqueFields(entity)) {
    if (field.list) continue;
    const finder = keyFinder(model, entity, [field.name]);
    if (!finder || seen.has(finder.name)) continue;
    seen.add(finder.name);
    finders.push({ ...finder, field: field.name });
  }
  return finders;
}

const signature = (finder) => finder.params.map((p) => `${p.type} ${csLocal(p.name)}`).join(', ');

// ─── La credencial que resuelve al agregado (resolvedBy) ─────────────────────────────────────────

/**
 * Los finders por ELEMENTO de una colección, cuando el diseño declara que un recurso tiene varias credenciales: por HTTP
 * (`security.authentication.callerIdentity.from.resolvedBy`) o por el broker (`messaging.subscriptions.<E>.identity.resolvedBy`,
 * DSL 2.17). La misma decisión que keel-spring y keel-nest: uno por `Entidad.campo` distinto que nombre el diseño para ESTA
 * entidad. Sin él, el finder de la clave natural resuelve solo la credencial que casualmente coincide con la clave, y las
 * demás acaban en un 403 en el camino feliz (corrida notification-mailer de keel-spring).
 */
export function credentialFinders(model, entity) {
  const declared = [model.security?.callerIdentity?.resolvedBy, ...(model.subscriptions ?? []).map((sub) => resolvedByOf(sub.identity?.resolvedBy))].filter(
    (resolved) => resolved && resolved.entity === entity.name
  );
  const seen = new Set();
  const finders = [];
  for (const resolved of declared) {
    if (seen.has(resolved.field)) continue;
    seen.add(resolved.field);
    const field = entity.fields.find((candidate) => candidate.name === resolved.field);
    if (!field || !field.list) continue;
    finders.push({ name: credentialFinderName(resolved.field), field, param: resolved.field.replace(/s$/, '') });
  }
  return finders;
}

/** El nombre del finder de `Entidad.campo`: el de keel-spring y keel-nest, en PascalCase (`FindByCredentialKeysContaining`). */
export function credentialFinderName(field) {
  return `FindBy${csMember(field)}Containing`;
}

/** `resolvedBy` como `{ entity, field }`: el diseño lo escribe `Entidad.campo`, y una prueba puede pasarlo ya partido. */
export function resolvedByOf(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const [entity, field] = String(raw).split('.');
  return { entity, field };
}

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────

function renderPort(model, entity) {
  const { namespace, path } = located(model, 'repositories', portClass(entity));
  const usings = [namespaceOf(model, entityPlace(entity))];
  const idType = entity.idField?.csType ?? 'Guid';
  const idName = csLocal(entity.idField?.name ?? 'id');
  const methods = [`    Task<${entity.name}?> FindById(${idType} ${idName}, CancellationToken cancellationToken = default);`];
  // La lectura POR LOTE por id (keel-core/gen/ref-targets.js): la raíz que embebe una página, o la que devuelve una query que
  // recibe la lista de sus ids. Sin ella, el camino de menor resistencia es un FindById por elemento.
  if (idBatchReason(model, entity)) {
    methods.push(`${xmlDoc('Los agregados de varios id en UNA consulta; los que no existen no están. El orden no está garantizado.', '    ')}    Task<IReadOnlyList<${entity.name}>> FindAllById(IReadOnlyCollection<${idType}> ids, CancellationToken cancellationToken = default);`);
  }
  for (const inverse of inverseFindersOf(model, entity.name)) {
    const ownerId = model.entities.find((candidate) => candidate.name === inverse.owner)?.idField;
    const ownerType = ownerId?.csType ?? 'Guid';
    const param = csLocal(`${inverse.relation}Id`);
    const finder = `${inverse.finder[0].toUpperCase()}${inverse.finder.slice(1)}`;
    methods.push(`${xmlDoc(`Los ${entity.name} cuya relación ${inverse.relation} apunta a ese ${inverse.owner}: la colección que su respuesta lleva y que el agregado ${inverse.owner} no guarda. Una consulta, sea cual sea el número de filas.`, '    ')}    Task<IReadOnlyList<${entity.name}>> ${finder}(${ownerType} ${param}, CancellationToken cancellationToken = default);`);
  }
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) usings.push(...param.usings);
    methods.push(
      `${xmlDoc(`El agregado por su clave natural (${entity.naturalKey.join(', ')}), o null.`, '    ')}    Task<${entity.name}?> ${finder.name}(${signature(finder)}, CancellationToken cancellationToken = default);`
    );
  }
  const batch = naturalKeyBatchFinder(model, entity);
  if (batch) {
    methods.push(
      `${xmlDoc([`Los agregados de varias ${batch.param.name} en UNA consulta; los que no existen no están. Es la lectura por lote que pide`, `un listado: un ${finder.name} por elemento serían N consultas por página.`], '    ')}    Task<IReadOnlyList<${entity.name}>> ${batch.name}(IReadOnlyCollection<${batch.type}> ${batch.plural}, CancellationToken cancellationToken = default);`
    );
  }
  for (const occupant of occupantFinders(model, entity)) {
    for (const param of occupant.params) usings.push(...param.usings);
    methods.push(
      `${xmlDoc(
        [
          `La fila que OCUPA el índice único condicionado sobre '${occupant.state}': como mucho una por clave.`,
          'La operación que releva la busca aquí para retirarla antes de activar la nueva.'
        ],
        '    '
      )}    Task<${entity.name}?> ${occupant.name}(${signature(occupant)}, CancellationToken cancellationToken = default);`
    );
  }
  for (const unique of uniqueFieldFinders(model, entity)) {
    for (const param of unique.params) usings.push(...param.usings);
    methods.push(
      `${xmlDoc(
        [
          `El ${entity.name} que ya tiene este ${unique.field}, que es único: para comprobarlo antes de un efecto que la`,
          'transacción no deshace. La carrera la sigue arbitrando la constraint.'
        ],
        '    '
      )}    Task<${entity.name}?> ${unique.name}(${signature(unique)}, CancellationToken cancellationToken = default);`
    );
  }
  for (const credential of credentialFinders(model, entity)) {
    methods.push(
      `${xmlDoc(
        [
          `Resuelve el agregado a partir de UNA de sus credenciales: el diseño declara que un mismo ${entity.name} tiene varias`,
          `(resolvedBy: ${entity.name}.${credential.field.name}), así que la del token o la del mensaje no tiene por qué ser su clave`,
          'natural. Buscar por la clave natural resolvería solo una de ellas: un 403 en el camino feliz.'
        ],
        '    '
      )}    Task<${entity.name}?> ${credential.name}(string ${csLocal(credential.param)}, CancellationToken cancellationToken = default);`
    );
  }
  if (isPaginated(model, entity)) {
    methods.push(
      `${xmlDoc('Una página de agregados, en el orden pedido y con el id como desempate.', '    ')}    Task<Page<${entity.name}>> List(Pageable pageable, CancellationToken cancellationToken = default);`
    );
  }
  // Los finders de las búsquedas con todos sus inputs enlazados (DSL 2.22, keel-core/gen/query-filters.js).
  methods.push(...portFinderMethods(model, entity));
  // Los reclamos de barrido que el modelo decide para esta raíz (incremento 10c).
  methods.push(...portClaimMethods(model, entity));
  // Las guardas de un efecto que no se deshace (mail.sentBy).
  methods.push(...portGuardMethods(model, entity));
  // Y los de reconciliación (incremento 11c).
  methods.push(...portReconciliationMethods(model, entity));
  methods.push(
    `${xmlDoc(
      [
        'Guarda el agregado entero (sus entidades internas y sus listas) y devuelve lo guardado. Con bloqueo',
        'optimista, una versión obsoleta sale como conflicto de concurrencia.'
      ],
      '    '
    )}    Task<${entity.name}> Save(${entity.name} entity, CancellationToken cancellationToken = default);`,
    `    Task DeleteById(${idType} ${idName}, CancellationToken cancellationToken = default);`
  );
  const body = `${xmlDoc(['Puerto de persistencia del agregado ' + entity.name + '. El dominio solo ve esto; el adaptador vive en', 'Infrastructure/Persistence/Repositories.'])}public interface ${portClass(entity)}
{
${methods.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

/** Las rutas de navegación que se cargan con la raíz: el árbol del agregado, listas incluidas (`Images.Tags`). */
export function includePaths(model, entity, prefix = '', seen = new Set([entity.name])) {
  const paths = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'elementCollection') paths.push(`${prefix}${csMember(member.name)}`);
    else if (member.kind === 'relationMany' && member.relation.cardinality !== 'many-to-many') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      if (!child || seen.has(child.name)) continue;
      const here = `${prefix}${csMember(member.name)}`;
      const nested = includePaths(model, child, `${here}.`, new Set([...seen, child.name]));
      paths.push(...(nested.length > 0 ? nested : [here]));
    }
  }
  return paths;
}

/** Las propiedades por las que se puede ordenar un listado: las de la fila, con el nombre del contrato (camelCase). */
function sortableProperties(model, entity) {
  const props = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      props.push(member.name);
      if (member.folded) props.push(member.folded.name);
      if (member.ranked) props.push(member.ranked.name);
    } else if (member.kind === 'externalRef') props.push(member.name);
    else if (member.kind === 'vo') for (const sub of member.subs) if (sub.subKind !== 'composite' && sub.sub.columns) props.push(sub.name);
  }
  for (const column of auditColumns(entity)) props.push(column.field);
  return props;
}

function renderAdapter(model, entity) {
  const { namespace, path } = located(model, 'repositoryAdapters', adapterClass(entity));
  const involved = collectInternalEntities(model, entity).filter((candidate) => candidate.persisted);
  const usings = [
    'Microsoft.EntityFrameworkCore',
    repositoriesNamespace(model),
    persistenceNamespace(model),
    rowsNamespace(model),
    namespaceOf(model, 'useCaseInfra')
  ];
  for (const candidate of involved) usings.push(namespaceOf(model, entityPlace(candidate)));
  const helpers = { usings, now: false, actor: false };
  const mappers = involved.flatMap((candidate) => [toDomainMethod(model, candidate, helpers), applyMethod(model, candidate, entity, helpers)]);

  const idType = entity.idField?.csType ?? 'Guid';
  const idName = csLocal(entity.idField?.name ?? 'id');
  const idProp = csMember(entity.idField?.name ?? 'id');
  const row = rowClass(entity.name);
  const methods = [];

  methods.push(`    public async Task<${entity.name}?> FindById(${idType} ${idName}, CancellationToken cancellationToken = default)
    {
        var found = await Graph().AsNoTracking().SingleOrDefaultAsync(r => r.${idProp} == ${idName}, cancellationToken);
        return found is null ? null : ToDomain(found);
    }`);
  if (idBatchReason(model, entity)) {
    methods.push(`    public async Task<IReadOnlyList<${entity.name}>> FindAllById(IReadOnlyCollection<${idType}> ids, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(ids);
        var keys = ids.Distinct().ToList();
        if (keys.Count == 0)
        {
            return [];
        }
        var found = await Graph().AsNoTracking().Where(r => keys.Contains(r.${idProp})).ToListAsync(cancellationToken);
        return [.. found.Select(ToDomain)];
    }`);
  }
  // La FK inversa es la columna de la referencia (`<Relación>Id` en la fila).
  for (const inverse of inverseFindersOf(model, entity.name)) {
    const ownerId = model.entities.find((candidate) => candidate.name === inverse.owner)?.idField;
    const ownerType = ownerId?.csType ?? 'Guid';
    const param = csLocal(`${inverse.relation}Id`);
    const finder = `${inverse.finder[0].toUpperCase()}${inverse.finder.slice(1)}`;
    methods.push(`    public async Task<IReadOnlyList<${entity.name}>> ${finder}(${ownerType} ${param}, CancellationToken cancellationToken = default)
    {
        var found = await Graph().AsNoTracking().Where(r => r.${csMember(`${inverse.relation}Id`)} == ${param}).ToListAsync(cancellationToken);
        return [.. found.Select(ToDomain)];
    }`);
  }

  for (const finder of [naturalKeyFinder(model, entity), ...occupantFinders(model, entity), ...uniqueFieldFinders(model, entity)].filter(Boolean)) {
    for (const param of finder.params) usings.push(...param.usings);
    // El valor plegado se calcula fuera de la expresión: EF traduce la comparación, no la llamada.
    const locals = [];
    const conditions = finder.params.flatMap((param) =>
      param.where.map(([property, expression], index) => {
        if (!param.fold) return `r.${property} == ${expression}`;
        const local = `${csLocal(param.name).replace(/^@/, '')}Folded${index > 0 ? index : ''}`;
        locals.push(`        var ${local} = ${expression};`);
        return `r.${property} == ${local}`;
      })
    );
    methods.push(`    public async Task<${entity.name}?> ${finder.name}(${signature(finder)}, CancellationToken cancellationToken = default)
    {
${locals.length > 0 ? `${locals.join('\n')}\n` : ''}        var found = await Graph().AsNoTracking().SingleOrDefaultAsync(r => ${conditions.join(' && ')}, cancellationToken);
        return found is null ? null : ToDomain(found);
    }`);
  }

  const batch = naturalKeyBatchFinder(model, entity);
  if (batch) {
    const [[property]] = batch.param.where;
    methods.push(`    public async Task<IReadOnlyList<${entity.name}>> ${batch.name}(IReadOnlyCollection<${batch.type}> ${batch.plural}, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(${batch.plural});
        var keys = ${batch.plural}.Distinct().ToList();
        if (keys.Count == 0)
        {
            return [];
        }
        var found = await Graph().AsNoTracking().Where(r => keys.Contains(r.${property})).ToListAsync(cancellationToken);
        return [.. found.Select(ToDomain)];
    }`);
  }

  for (const credential of credentialFinders(model, entity)) {
    const member = persistedMembers(model, entity).find((m) => m.kind === 'elementCollection' && m.name === credential.field.name);
    const element = elementClass(entity, member);
    const local = csLocal(credential.param);
    methods.push(`    public async Task<${entity.name}?> ${credential.name}(string ${local}, CancellationToken cancellationToken = default)
    {
        // La credencial vive en la tabla de elementos de la lista: se busca ahí al dueño y se carga el agregado ENTERO por
        // su id (filtrar la raíz por un elemento cargaría la lista recortada a ese elemento).
        var owner = await db.Set<${element}>().AsNoTracking().Where(element => element.Value == ${local}).Select(element => (${idType}?)element.OwnerId).FirstOrDefaultAsync(cancellationToken);
        return owner is { } id ? await FindById(id, cancellationToken) : null;
    }`);
  }

  if (isPaginated(model, entity)) {
    methods.push(`    public async Task<Page<${entity.name}>> List(Pageable pageable, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(pageable);
        var total = await db.Set<${row}>().LongCountAsync(cancellationToken);
        var offset = (int)Math.Min((long)pageable.Page * pageable.Size, int.MaxValue);
        var rows = await Ordered(Graph().AsNoTracking(), pageable.Sort).Skip(offset).Take(pageable.Size).ToListAsync(cancellationToken);
        var pages = pageable.Size == 0 ? 1 : (int)Math.Ceiling(total / (double)pageable.Size);
        return new Page<${entity.name}>([.. rows.Select(ToDomain)], pageable.Page, pageable.Size, total, pages);
    }`);
  }
  // Los finders de las búsquedas (DSL 2.22): los filtros del diseño sobre la fila, y solo esos.
  methods.push(...relationalFinderMethods(model, entity));
  if (finderEnums(model, entity)) usings.push(namespaceOf(model, 'enums'));

  // Los reclamos de barrido (incremento 10c): SKIP LOCKED + UPDATE condicional por fila, en su propia transacción.
  methods.push(...adapterClaimMethods(model, entity));
  methods.push(...adapterGuardMethods(model, entity, dbContextClass(model)));
  // Los de reconciliación: la marca de reconciliation_claim. El ayudante RequireOwnTransaction lo emite claim.js si la raíz
  // tiene además un reclamo de barrido.
  methods.push(...adapterReconciliationMethods(model, entity, { ownTransactionHelper: claimsForEntity(model, entity.name).length === 0 }));
  usings.push(...claimUsings(model, entity));
  for (const dep of adapterExtras(model, entity)) usings.push(...dep.usings);
  methods.push(saveMethod(model, entity, helpers));
  methods.push(`    public async Task DeleteById(${idType} ${idName}, CancellationToken cancellationToken = default)
    {
        await transactions.InTransaction(
            async () =>
            {
                // Se carga y se borra el GRAFO: las filas de las hijas y de las listas van antes que la raíz.
                var found = await Graph().SingleOrDefaultAsync(r => r.${idProp} == ${idName}, cancellationToken);
                if (found is not null)
                {
                    db.Remove(found);
                    await db.SaveChangesAsync(cancellationToken);
                }
                return true;
            },
            readOnly: false,
            cancellationToken);
    }`);

  const includes = includePaths(model, entity).map((pathName) => `.Include(${csString(pathName)})`).join('');
  const sortable = isPaginated(model, entity) || needsOrdering(model, entity) ? sortableBlock(model, entity) : '';
  const fields = [
    ...sortConstants(model, entity),
    '    // El agregado entero: lo que se carga con la raíz y se borra con ella. Las colecciones van en consultas',
    '    // aparte (QuerySplittingBehavior.SplitQuery): con un JOIN, cada hija multiplicaría las filas de la página.',
    `    private IQueryable<${row}> Graph() => db.Set<${row}>()${includes};`
  ];
  const body = `${xmlDoc([
    `Adaptador del puerto ${portClass(entity)} sobre EF Core. Usa el DbContext del ámbito, el de la transacción que abrió`,
    'el UseCaseMediator; sin ella, cada lectura va sola y cada escritura abre la suya.'
  ])}public sealed class ${adapterClass(entity)}(${dbContextClass(model)} db, PersistenceTransactions transactions${usesBridge(model) && emitsEvents(model, entity) ? `, ${bridgeClass(model)} events` : ''}${adapterExtras(model, entity).map((dep) => `, ${dep.type} ${dep.name}`).join('')}) : ${portClass(entity)}
{
${fields.join('\n')}${sortable}

${methods.join('\n\n')}

    // ─── Mapeo dominio ↔ fila ───────────────────────────────────────────────────────────────────

${mappers.join('\n\n')}
}`;
  if (sortable) usings.push('System.Linq.Expressions');
  if (usesBridge(model) && emitsEvents(model, entity)) usings.push(messagingNamespace(model));
  return { path, content: csFile({ namespace, usings, body }) };
}

function sortableBlock(model, entity) {
  const row = rowClass(entity.name);
  const idProp = csMember(entity.idField?.name ?? 'id');
  const entries = sortableProperties(model, entity).map((name) => `        [${csString(name)}] = r => r.${csMember(name)},`);
  return `

    /// <summary>
    /// Las propiedades por las que se puede ordenar, con el nombre del contrato: las de la fila, como las de la entidad
    /// JPA que ordena keel-spring. Una que no existe es un error, como la PropertyReferenceException de Spring Data.
    /// </summary>
    private static readonly Dictionary<string, Expression<Func<${row}, object?>>> Sortable = new(StringComparer.Ordinal)
    {
${entries.join('\n')}
    };

    /// <summary>
    /// El orden pedido más el id como último criterio si no está ya: sin desempate, dos páginas consecutivas pueden
    /// repetir una fila y omitir otra, porque cuando el ORDER BY empata el motor no promete un orden estable.
    /// </summary>
    private static IQueryable<${row}> Ordered(IQueryable<${row}> query, IReadOnlyList<SortOrder> sort)
    {
        IOrderedQueryable<${row}>? ordered = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var order in sort)
        {
            if (!Sortable.TryGetValue(order.Property, out var key))
            {
                throw new InvalidOperationException($"No existe la propiedad '{order.Property}' para ordenar ${entity.name}");
            }
            if (!seen.Add(order.Property))
            {
                continue;
            }
            var descending = order.Direction == SortDirection.Desc;
            ordered = ordered is null
                ? (descending ? query.OrderByDescending(key) : query.OrderBy(key))
                : (descending ? ordered.ThenByDescending(key) : ordered.ThenBy(key));
        }
        if (seen.Contains(${csString(entity.idField?.name ?? 'id')}))
        {
            return ordered ?? query;
        }
        return ordered is null ? query.OrderBy(r => r.${idProp}) : ordered.ThenBy(r => r.${idProp});
    }`;
}

/** Lo que recibe el adaptador relacional además del contexto y la transacción. */
function adapterExtras(model, entity) {
  const others = [...claimDependencies(model, entity), ...reconciliationDependencies(model, entity), ...guardDependencies(model, entity)];
  return [...others, ...replicaDependencies(entity, others)];
}

function saveMethod(model, entity, helpers) {
  return replicaOwnTransaction(model, entity, saveMethodBody(model, entity, helpers));
}

function saveMethodBody(model, entity, helpers) {
  const row = rowClass(entity.name);
  const idProp = csMember(entity.idField?.name ?? 'id');
  const versioned = entity.usesOptimisticLocking;
  const versionProp = csMember(LOCK_VERSION.field);
  const stamps = auditStamps(model, entity, helpers);
  const lines = [];
  if (versioned) {
    lines.push(`                ${row} row;
                var expected = entity.${versionProp};
                if (expected is null)
                {
                    // Agregado nuevo: nace con la versión 0, como el @Version de JPA al persistir.
                    row = new ${row} { ${idProp} = entity.${idProp} };
                    Apply(row, entity);
                    row.${versionProp} = 0;
                    db.Add(row);
                }
                else
                {
                    // La versión que el agregado LEYÓ es el valor original del token: EF escribe
                    // UPDATE … WHERE lock_version = @leída, y cero filas es otra escritura que ganó (o la borró).
                    row = await Graph().SingleOrDefaultAsync(r => r.${idProp} == entity.${idProp}, cancellationToken)
                        ?? throw new OptimisticLockConflict(${csString(entity.name)}, entity.${idProp}.ToString());
                    Apply(row, entity);
                    db.Entry(row).Property(r => r.${versionProp}).OriginalValue = expected;
                    row.${versionProp} = expected + 1;
                }`);
  } else {
    lines.push(`                var row = await Graph().SingleOrDefaultAsync(r => r.${idProp} == entity.${idProp}, cancellationToken);
                if (row is null)
                {
                    row = new ${row} { ${idProp} = entity.${idProp} };
                    db.Add(row);
                }
                Apply(row, entity);`);
  }
  if (helpers.now) lines.push('                var now = DateTimeOffset.UtcNow;');
  if (helpers.actor) lines.push('                var actor = AuditActor.Current();');
  lines.push(...stamps.map((line) => `                ${line}`));
  // Los eventos que la raíz acumuló salen por el puente ANTES de SaveChanges: con outbox, la fila del evento se confirma
  // con el cambio en el MISMO SaveChanges; con best-effort, el puente los deja para después del commit. Sin mensajería
  // nadie los escucha, pero se vacían igual para que el buffer no crezca con cada escritura.
  if (emitsEvents(model, entity)) {
    lines.push(
      usesBridge(model)
        ? '                events.Publish(entity.PullDomainEvents());'
        : '                entity.PullDomainEvents();'
    );
  }
  lines.push('                await db.SaveChangesAsync(cancellationToken);');
  lines.push('                return ToDomain(row);');
  return `    public async Task<${entity.name}> Save(${entity.name} entity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(entity);
        return await transactions.InTransaction(
            async () =>
            {
${lines.join('\n')}
            },
            readOnly: false,
            cancellationToken);
    }`;
}


/**
 * La copia local de una dependencia replicada (`needs` con `strategy: replicated`, 13j) se guarda en su PROPIA
 * transacción, el REQUIRES_NEW de keel-spring y el inNewTransaction de keel-nest: la escribe el proyector (desde la
 * operación de proyección) y el lector cuando la hidrata desde una consulta, de solo lectura. Un ámbito de DI nuevo es un
 * contexto y una transacción nuevos: `Save` delega en `SaveHere` del adaptador de ese ámbito.
 */
export function replicaOwnTransaction(model, entity, saveMethodText) {
  if (!entity.replicaOf) return saveMethodText;
  const here = saveMethodText.replace(`public async Task<${entity.name}> Save(`, `internal async Task<${entity.name}> SaveHere(`);
  return `    /// <summary>
    /// La copia local de ${entity.name} (réplica de ${entity.replicaOf.dependency}.${entity.replicaOf.need}) se guarda en su PROPIA
    /// transacción, la de un ámbito nuevo: el REQUIRES_NEW de keel-spring. Quien la escribe no la ata a la suya.
    /// </summary>
    public async Task<${entity.name}> Save(${entity.name} entity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(entity);
        await using var scope = scopes.CreateAsyncScope();
        var own = (${adapterClass(entity)})scope.ServiceProvider.GetRequiredService<${portClass(entity)}>();
        return await own.SaveHere(entity, cancellationToken);
    }

${here}`;
}

/** Lo que recibe el adaptador de una réplica para su transacción propia (si no lo recibe ya por otra razón). */
export function replicaDependencies(entity, others) {
  if (!entity.replicaOf || others.some((dep) => dep.name === 'scopes')) return [];
  return [{ type: 'IServiceScopeFactory', name: 'scopes', usings: ['Microsoft.Extensions.DependencyInjection'] }];
}

/**
 * Lo que la auditoría estampa en una entidad: las columnas de la política `all` (que el dominio no nombra) y los
 * campos DECLARADOS (`declared`: son del dominio, y se estampan igual, como @CreatedDate sobre un campo propio).
 */
function auditTargets(entity) {
  const targets = auditColumns(entity).map((column) => ({
    property: csMember(column.field),
    value: column.field.endsWith('At') ? 'now' : 'actor',
    updatable: column.updatable,
    nullable: false
  }));
  const declared = [
    ...(entity.auditTimestamps === 'declared' ? ['createdAt', 'updatedAt'] : []),
    ...(entity.auditAuthorship === 'declared' ? ['createdBy', 'updatedBy'] : [])
  ];
  for (const name of declared) {
    const field = entity.fields.find((candidate) => candidate.name === name);
    if (!field) continue;
    targets.push({ property: csMember(name), value: name.endsWith('At') ? 'now' : 'actor', updatable: name.startsWith('updated'), nullable: Boolean(field.columns?.nullable) });
  }
  return targets;
}

/** Las líneas que estampan la auditoría de la raíz y sus hijas al guardar (después de llevarles el dominio). */
function auditStamps(model, entity, helpers) {
  const lines = [];
  for (const candidate of collectInternalEntities(model, entity).filter((c) => c.persisted)) {
    const targets = auditTargets(candidate);
    if (targets.length === 0) continue;
    const parts = targets.map(({ property, value, updatable, nullable }) => {
      if (value === 'now') helpers.now = true;
      else helpers.actor = true;
      // updated_* en cada escritura; created_* no cambia después de nacer (el listener de Spring Data).
      if (updatable) return `{target}.${property} = ${value};`;
      // La autoría vacía es AUSENTE, sea nula o no la columna: el dominio no conoce al llamante y en el alta la deja
      // en `string.Empty` (domain-modeling.md). Un `??=` guardaba ese "" en lugar del actor (corrida catalog-dotnet).
      if (value === 'actor') return `if (string.IsNullOrEmpty({target}.${property})) { {target}.${property} = ${value}; }`;
      return nullable
        ? `{target}.${property} ??= ${value};`
        : `if ({target}.${property} == default) { {target}.${property} = ${value}; }`;
    });
    if (candidate === entity) {
      lines.push(...parts.map((part) => part.replaceAll('{target}', 'row')));
    } else {
      const walk = walkTo(model, entity, candidate);
      if (walk) lines.push(`foreach (var child in ${walk}) { ${parts.map((part) => part.replaceAll('{target}', 'child')).join(' ')} }`);
    }
  }
  return lines;
}

/** La expresión que recorre las filas de una entidad interna desde la raíz (`row.Images`). */
function walkTo(model, from, target, source = 'row', seen = new Set()) {
  for (const relation of from.relations ?? []) {
    if (!relation.internal || relation.backReference || seen.has(relation.entity)) continue;
    if (relation.cardinality !== 'one-to-many') continue;
    const next = model.entities.find((candidate) => candidate.name === relation.entity);
    if (!next) continue;
    const here = `${source}.${csMember(relation.name)}`;
    if (next === target) return here;
    const rest = walkTo(model, next, target, 'node', new Set([...seen, from.name]));
    if (rest) return `${here}.SelectMany(node => ${rest})`;
  }
  return null;
}

// ─── ToDomain ────────────────────────────────────────────────────────────────────────────────────

/** La columna con su tabla, para el mensaje de un dato roto. */
const columnLabel = (entity, column) => csString(`${entity.tableName}.${column}`);

function toDomainMethod(model, entity, helpers) {
  const persisted = persistedMembers(model, entity);
  const state = [];
  for (const member of domainMembers(model, entity)) {
    state.push(`            ${csMember(member.name)} = ${domainValue(model, entity, member, persisted, helpers)},`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) state.push(`            ${csMember(LOCK_VERSION.field)} = row.${csMember(LOCK_VERSION.field)},`);
  return `    private static ${entity.name} ToDomain(${rowClass(entity.name)} row) =>
        new(new ${entity.name}State
        {
${state.join('\n')}
        });`;
}

/** Una columna leída para un miembro del dominio: si la columna admite null y el dominio no, se exige. */
function readColumn(expression, csType, spec, domainNullable, entity) {
  if (spec?.base === 'json') {
    return domainNullable ? `RowValues.JsonOrNull(${expression})` : `RowValues.Json(${expression}, ${columnLabel(entity, spec.name)})`;
  }
  if (spec?.nullable && !domainNullable) return `RowValues.Required(${expression}, ${columnLabel(entity, spec.name)})`;
  return expression;
}

function domainValue(model, entity, member, persisted, helpers) {
  if (member.kind === 'externalRef') return `row.${csMember(member.name)}`;
  if (member.kind === 'relationMany') {
    const child = member.relation.entity;
    const ordering = orderingFieldOf(model, child);
    const tie = csMember(orderingTieBreakerOf(model, child));
    // El orden propio de la colección (su campo de posición) con el id como desempate, comparado como texto: el
    // orden de bytes del uuid, el mismo en los tres servidores.
    const sorted = ordering
      ? `row.${csMember(member.name)}.OrderBy(child => child.${csMember(ordering.name)}).ThenBy(child => child.${tie}.ToString(), StringComparer.Ordinal)`
      : `row.${csMember(member.name)}`;
    return `[.. ${sorted}.Select(ToDomain)]`;
  }
  if (member.kind === 'relationOne') return `RowValues.Unmapped<${member.type.replace(/\?$/, '')}>(${csString(`${entity.name}.${member.name}`)})`;
  const field = member.field;
  if (field.list) {
    const elements = `row.${csMember(field.name)}.OrderBy(element => element.Position)`;
    if (field.kind === 'composite') {
      const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
      if (!vo || vo.fields.some((sub) => sub.kind === 'composite' || !sub.columns)) return `RowValues.Unmapped<${field.csType}>(${csString(`${entity.name}.${field.name}`)})`;
      helpers.usings.push(...typeUsings(model, [vo.name]));
      const args = vo.fields.map((sub) => `${csLocal(sub.name)}: ${readColumn(`element.${csMember(sub.name)}`, sub.csType, sub.columns, isNullable(sub), entity)}`);
      return `[.. ${elements}.Select(element => new ${vo.name}(${args.join(', ')}))]`;
    }
    return `[.. ${elements}.Select(element => ${readColumn('element.Value', field.elementCsType, field.elementColumns, false, entity)})]`;
  }
  if (field.kind === 'composite') {
    const vo = persisted.find((m) => m.kind === 'vo' && m.name === field.name);
    const voDef = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    if (!vo || !voDef || vo.subs.length === 0 || vo.subs.some((sub) => sub.subKind === 'composite' || !sub.sub.columns)) {
      return `RowValues.Unmapped<${field.csType}>(${csString(`${entity.name}.${field.name}`)})`;
    }
    helpers.usings.push(...typeUsings(model, [voDef.name]));
    const args = vo.subs.map((sub) => {
      const spec = { ...sub.sub.columns, name: sub.column, nullable: !(sub.ownerRequired && !sub.sub.columns.nullable) };
      return `${csLocal(sub.voAccessor)}: ${readColumn(`row.${csMember(sub.name)}`, sub.sub.csType, spec, isNullable(sub.sub), entity)}`;
    });
    const build = `new ${voDef.name}(${args.join(', ')})`;
    // Un value object OPCIONAL ausente es null, no un objeto con todo a null: la marca de presencia es un campo
    // obligatorio del propio value object.
    const marker = voDef.fields.find((sub) => sub.required);
    if (!field.required && marker) return `row.${csMember(field.name)}${csMember(marker.name)} is null ? null : ${build}`;
    return build;
  }
  return readColumn(`row.${csMember(field.name)}`, field.csType, field.columns, isNullable(field), entity);
}

// ─── Apply ───────────────────────────────────────────────────────────────────────────────────────

/** El valor de dominio como columna: el json como su texto, el instante en UTC (timestamptz lo exige). */
function writeColumn(expression, spec, domainNullable) {
  if (spec?.base === 'json') return domainNullable ? `${expression}?.GetRawText()` : `${expression}.GetRawText()`;
  if (spec?.base === 'timestamp') return domainNullable ? `${expression}?.ToUniversalTime()` : `${expression}.ToUniversalTime()`;
  return expression;
}

function applyMethod(model, entity, root, helpers) {
  const lines = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      const field = member.field;
      // El id es la clave: lo pone quien crea la fila, y una clave ya guardada no se reescribe.
      if (field.isId) continue;
      lines.push(`        row.${csMember(field.name)} = ${writeColumn(`entity.${csMember(field.name)}`, field.columns, isNullable(field))};`);
      if (member.folded) {
        helpers.usings.push(persistenceNamespace(model));
        lines.push(`        row.${csMember(member.folded.name)} = TextFold.${member.folded.accents ? 'FoldCaseAndAccents' : 'FoldCase'}(entity.${csMember(field.name)});`);
      }
      // La posición del enum es su valor entero: los miembros se declaran en el orden del diseño y sin valores explícitos.
      if (member.ranked) lines.push(`        row.${csMember(member.ranked.name)} = ${member.ranked.required ? `(int)entity.${csMember(field.name)}` : `(int?)entity.${csMember(field.name)}`};`);
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) {
        if (sub.subKind === 'composite' || !sub.sub.columns) {
          lines.push(`        // TODO (agente): mapear ${member.field.namedType}.${sub.voAccessor} (value object anidado).`);
          continue;
        }
        const source = member.field.required ? `entity.${csMember(member.name)}.${csMember(sub.voAccessor)}` : `entity.${csMember(member.name)}?.${csMember(sub.voAccessor)}`;
        lines.push(`        row.${csMember(sub.name)} = ${writeColumn(source, sub.sub.columns, !member.field.required || isNullable(sub.sub))};`);
      }
    } else if (member.kind === 'externalRef') {
      lines.push(`        row.${csMember(member.name)} = entity.${csMember(member.name)};`);
    } else if (member.kind === 'elementCollection') {
      const element = elementClass(entity, member);
      const idProp = csMember(entity.idField?.name ?? 'id');
      let apply;
      if (member.element.kind === 'vo') {
        const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
        const copies = (vo?.fields ?? [])
          .filter((sub) => sub.kind !== 'composite' && sub.columns)
          .map((sub) => `element.${csMember(sub.name)} = ${writeColumn(`value.${csMember(sub.name)}`, sub.columns, isNullable(sub))};`);
        apply = `(element, value) =>\n            {\n${copies.map((copy) => `                ${copy}`).join('\n')}\n            }`;
      } else {
        apply = `(element, value) => element.Value = ${writeColumn('value', member.field.elementColumns, false)}`;
      }
      lines.push(
        `        RowSync.Elements(\n            db,\n            row.${csMember(member.name)},\n            entity.${csMember(member.name)},\n` +
          `            position => new ${element} { OwnerId = entity.${idProp}, Position = position },\n            ${apply});`
      );
    } else if (member.kind === 'relationMany') {
      if (member.relation.cardinality === 'many-to-many') {
        lines.push(`        // TODO (agente): mapear ${member.name} (many-to-many dentro del agregado).`);
        continue;
      }
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      const childId = csMember(child?.idField?.name ?? 'id');
      lines.push(
        `        RowSync.Children(\n            db,\n            row.${csMember(member.name)},\n            entity.${csMember(member.name)},\n` +
          `            child => child.${childId},\n            child => child.${childId},\n` +
          `            child => new ${rowClass(child.name)} { ${childId} = child.${childId} },\n            Apply);`
      );
    } else if (member.kind === 'relationOne' && !member.relation.backReference) {
      lines.push(`        // TODO (agente): mapear ${member.name} (relación a-uno dentro del agregado, skill keel-dotnet-database).`);
    }
  }
  // La FK de vuelta al padre (declarada o la de un one-to-many unidireccional) la pone EF al añadir la fila a la
  // colección de su padre: el dominio no la nombra.
  return `    private void Apply(${rowClass(entity.name)} row, ${entity.name} entity)
    {
${lines.length > 0 ? lines.join('\n') : '        // Nada que copiar más allá de la clave.'}
    }`;
}
