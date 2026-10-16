// El ADAPTADOR documental de cada raíz de agregado (incremento 12b): `<Raíz>Repository` sobre el driver oficial de
// MongoDB, con el mapeo dominio ↔ BsonDocument escrito campo a campo. El PUERTO es el mismo que en la rama relacional
// (repositories.js): el dominio no sabe qué almacén hay debajo.
//
// El documento es el de keel-core/gen/document.js, el mismo que escriben keel-spring y keel-nest: el agregado es el
// documento, las hijas van anidadas dentro de la raíz, un value object es un subdocumento y una referencia a otro
// agregado es su id. Cada valor pasa por BsonValues, con la representación física del contrato.
//
// Lo que aquí escribe el adaptador porque el driver no lo hace:
//   · el BLOQUEO OPTIMISTA: la versión va en el filtro del UPDATE; cero coincidencias es otra escritura que ganó (o un
//     borrado), y sale como conflicto. Un agregado nuevo se INSERTA con la versión 0;
//   · la AUDITORÍA: `created_*` no cambia después de nacer —`$setOnInsert` con la política `all`, la del dominio con
//     `declared`— y `updated_*` se estampa en cada escritura. Guardar es un `$set` del documento entero y no un
//     reemplazo, para que lo que el dominio no lleva (la auditoría de política) no se pierda.

import { persistedMembers, collectInternalEntities, LOCK_VERSION, orderingFieldOf, orderingTieBreakerOf, claimsForEntity } from 'keel-core/gen';
import { documentShape, DOCUMENT_ID } from 'keel-core/gen/document';
import { snakeCase } from 'keel-core/gen/naming';
import { csFile, csLocal, csMember, csString, isNullable, located, namespaceOf, entityPlace, typeUsings } from './render.js';
import { domainMembers } from './entities.js';
import { persistenceNamespace } from './persistence.js';
import { bridgeClass, messagingNamespace, usesBridge } from './messaging.js';
import { claimDependencies, guardClaimsFor } from './claim.js';
import { reconciliationDependencies } from './reconciliation-claim.js';
import { documentGuardMethods, documentOwnTransactionHelper, documentReconciliationMethods, documentSweepClaimMethods } from './document-stores.js';
import { adapterClass, portClass, repositoriesNamespace, isPaginated, naturalKeyFinder, occupantFinders, uniqueFieldFinders, emitsEvents, credentialFinders, replicaOwnTransaction, replicaDependencies, naturalKeyBatchFinder } from './repositories.js';

// ─── Valores ─────────────────────────────────────────────────────────────────────────────────────

/** La expresión C# que lleva un valor ESCALAR del dominio al documento (un BsonValue). */
function writeScalar(field, expr) {
  if (field.kind === 'enum') return `BsonValues.Enum(${expr}, EnumColumns.${field.namedType ?? field.csType}Constant)`;
  if (field.base === 'date') return `BsonValues.Day(${expr})`;
  if (field.base === 'json') return `BsonValues.Json(${expr})`;
  return `BsonValues.Of(${expr})`;
}

const READERS = {
  uuid: ['Uuid', 'UuidOrNull'],
  int: ['Int32', 'Int32OrNull'],
  long: ['Int64', 'Int64OrNull'],
  decimal: ['Decimal', 'DecimalOrNull'],
  boolean: ['Bool', 'BoolOrNull'],
  timestamp: ['Instant', 'InstantOrNull'],
  date: ['DayOf', 'DayOrNull'],
  json: ['JsonOf', 'JsonOrNull']
};

/** La expresión C# que lleva un valor ESCALAR del documento al dominio. `label` nombra el campo en el mensaje de un dato roto. */
function readScalar(field, expr, label, nullable) {
  if (field.kind === 'enum') {
    return `BsonValues.${nullable ? 'EnumOrNull' : 'EnumOf'}(${expr}, ${csString(label)}, EnumColumns.${field.namedType ?? field.csType}Of)`;
  }
  const [required, optional] = READERS[field.base] ?? ['Text', 'TextOrNull'];
  return `BsonValues.${nullable ? optional : required}(${expr}, ${csString(label)})`;
}

/** Un campo del dominio (escalar, value object, o lista de ellos) → BsonValue. */
function writeField(field, expr) {
  if (field.list) {
    const element = field.kind === 'composite' ? `ToDocument${field.namedType}(element)` : writeScalar(field, 'element');
    return `BsonValues.Array(${expr}, element => ${element})`;
  }
  if (field.kind === 'composite') {
    return isNullable(field) ? `BsonValues.Optional(${expr}, ToDocument${field.namedType})` : `ToDocument${field.namedType}(${expr})`;
  }
  return writeScalar(field, expr);
}

/** BsonValue → un campo del dominio. */
function readField(field, expr, label) {
  if (field.list) {
    const element =
      field.kind === 'composite' ? `ToDomain${field.namedType}(BsonValues.Document(element, ${csString(label)}))` : readScalar(field, 'element', label, false);
    return `BsonValues.List(${expr}, ${csString(label)}, element => ${element})`;
  }
  if (field.kind === 'composite') {
    return isNullable(field)
      ? `BsonValues.OptionalOf(${expr}, ${csString(label)}, ToDomain${field.namedType})`
      : `BsonValues.Required(${expr}, ${csString(label)}, ToDomain${field.namedType})`;
  }
  return readScalar(field, expr, label, isNullable(field));
}

const fieldOf = (document, key) => `BsonValues.Field(${document}, ${csString(key)})`;

// ─── Value objects ───────────────────────────────────────────────────────────────────────────────

/** El par de funciones de un value object: a subdocumento y de vuelta. Los anidados, por recursión. */
function valueObjectFunctions(model, voName, collection, usings, done) {
  if (done.has(voName)) return [];
  done.add(voName);
  const vo = model.valueObjects.find((candidate) => candidate.name === voName);
  if (!vo) return [];
  usings.push(...typeUsings(model, [vo.name]));
  const out = [];
  const writes = [];
  const reads = [];
  for (const sub of vo.fields) {
    if (sub.kind === 'composite') out.push(...valueObjectFunctions(model, sub.namedType, collection, usings, done));
    const key = snakeCase(sub.name);
    writes.push(`            { ${csString(key)}, ${writeField(sub, `value.${csMember(sub.name)}`)} },`);
    reads.push(`${csLocal(sub.name)}: ${readField(sub, fieldOf('document', key), `${collection}…${vo.name}.${key}`)}`);
  }
  out.push(`    /// <summary>${vo.name} → su subdocumento.</summary>
    private static BsonDocument ToDocument${vo.name}(${vo.name} value) =>
        new()
        {
${writes.join('\n')}
        };

    /// <summary>Su subdocumento → ${vo.name}.</summary>
    private static ${vo.name} ToDomain${vo.name}(BsonDocument document) =>
        new(${reads.join(', ')});`);
  return out;
}

/** Los value objects que alcanzan los campos de una entidad (incluidas sus listas). */
function valueObjectsOf(entity) {
  return entity.fields.filter((field) => field.kind === 'composite').map((field) => field.namedType);
}

// ─── Entidades ───────────────────────────────────────────────────────────────────────────────────

/** La clave del documento de un miembro del dominio, leída de la forma neutral. */
function keyOf(model, entity, memberName) {
  return documentShape(model, entity).find((entry) => entry.member === memberName)?.name ?? snakeCase(memberName);
}

/** El campo id de la raíz de OTRO agregado, para escribir y leer la referencia con su tipo. */
function targetIdField(model, relation) {
  const target = model.entities.find((candidate) => candidate.name === relation.entity);
  return target?.idField ?? { base: 'uuid', kind: 'scalar', csType: 'Guid' };
}

function entityFunctions(model, entity, collection) {
  const members = persistedMembers(model, entity);
  const writes = [];
  for (const entry of documentShape(model, entity)) {
    const value = `entity.${csMember(entry.member)}`;
    let expression = null;
    if (entry.kind === 'id' || entry.kind === 'scalar') expression = writeField(entry.field, value);
    else if (entry.kind === 'folded') {
      const folded = members.find((m) => m.kind === 'scalar' && m.name === entry.of)?.folded;
      expression = `BsonValues.Of(TextFold.${folded?.accents ? 'FoldCaseAndAccents' : 'FoldCase'}(entity.${csMember(entry.of)}))`;
    } else if (entry.kind === 'ref') expression = writeScalar(targetIdField(model, entry.relation), value);
    else if (entry.kind === 'subdocument' && entry.valueObject) expression = writeField(entry.field, value);
    else if (entry.kind === 'subdocument' && entry.entity) {
      expression = entry.relation?.required ? `ToDocument${entry.entity}(${value})` : `BsonValues.Optional(${value}, ToDocument${entry.entity})`;
    } else if (entry.kind === 'array' && entry.element.entity) expression = `BsonValues.Array(${value}, child => ToDocument${entry.element.entity}(child))`;
    else if (entry.kind === 'array') expression = writeField(entry.field, value);
    // `version` y `audit` no salen del dominio: los pone Save.
    if (expression) writes.push(`            { ${csString(entry.name)}, ${expression} },`);
  }

  const label = (key) => `${collection}${entity.isAggregateRoot ? '' : `…${entity.name}`}.${key}`;
  const state = [];
  for (const member of domainMembers(model, entity)) {
    const key = keyOf(model, entity, member.name);
    const source = fieldOf('document', key);
    let expression;
    if (member.kind === 'externalRef') {
      expression = readScalar(targetIdField(model, member.relation), source, label(key), !member.relation.required);
    } else if (member.kind === 'relationMany') {
      // El orden de un array de Mongo es el de inserción, que tras reordenar ya no es el del diseño: con un campo de
      // posición, el mapeo lo restablece —y desempata por id, comparado como texto—, como la consulta relacional.
      const child = member.relation.entity;
      const ordering = orderingFieldOf(model, child);
      const tie = csMember(orderingTieBreakerOf(model, child));
      const list = `BsonValues.List(${source}, ${csString(label(key))}, element => ToDomain${child}(BsonValues.Document(element, ${csString(label(key))})))`;
      expression = ordering ? `[.. ${list}.OrderBy(child => child.${csMember(ordering.name)}).ThenBy(child => child.${tie}.ToString(), StringComparer.Ordinal)]` : list;
    } else if (member.kind === 'relationOne') {
      expression = member.relation.required
        ? `BsonValues.Required(${source}, ${csString(label(key))}, ToDomain${member.relation.entity})`
        : `BsonValues.OptionalOf(${source}, ${csString(label(key))}, ToDomain${member.relation.entity})`;
    } else {
      expression = readField(member.field, source, label(key));
    }
    state.push(`            ${csMember(member.name)} = ${expression},`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion && entity.isAggregateRoot) {
    state.push(`            ${csMember(LOCK_VERSION.field)} = BsonValues.Int64OrNull(${fieldOf('document', LOCK_VERSION.column)}, ${csString(label(LOCK_VERSION.column))}),`);
  }
  return `    /// <summary>${entity.name} → su documento${entity.isAggregateRoot ? '' : ' (anidado dentro del de su raíz)'}.</summary>
    private static BsonDocument ToDocument${entity.name}(${entity.name} entity) =>
        new()
        {
${writes.join('\n')}
        };

    /// <summary>Su documento → ${entity.name}.</summary>
    private static ${entity.name} ToDomain${entity.name}(BsonDocument document) =>
        new(new ${entity.name}State
        {
${state.join('\n')}
        });`;
}

// ─── Consultas ───────────────────────────────────────────────────────────────────────────────────

/**
 * El filtro de un finder por clave (la clave natural, la de un índice condicionado o un campo único) en rutas del
 * documento, con cada valor convertido como se guarda. Los parámetros son los del PUERTO (repositories.js): mismo
 * nombre, mismo tipo.
 */
function keyFilter(model, entity, finder) {
  const members = persistedMembers(model, entity);
  const conditions = [];
  for (const param of finder.params) {
    const local = csLocal(param.name);
    const member = members.find((m) => m.name === param.name || m.relation?.name === param.name);
    if (member?.kind === 'externalRef') {
      conditions.push([`${snakeCase(member.relation.name)}_id`, writeScalar(targetIdField(model, member.relation), local)]);
    } else if (member?.kind === 'vo') {
      for (const sub of member.vo?.fields ?? []) {
        if (sub.kind === 'composite' || sub.list) continue;
        conditions.push([`${snakeCase(member.name)}.${snakeCase(sub.name)}`, writeScalar(sub, `${local}.${csMember(sub.name)}`)]);
      }
    } else if (member?.kind === 'scalar' && member.folded && !member.folded.filterOnly) {
      // Un campo con `compare: ignore-case` se busca por su SOMBRA plegada, que es lo que la unicidad indexa: por el valor
      // crudo, «Tools» no encontraría la categoría «tools» que el índice dice que ya existe.
      conditions.push([keyOf(model, entity, member.folded.name), `BsonValues.Of(TextFold.${member.folded.accents ? 'FoldCaseAndAccents' : 'FoldCase'}(${local}))`]);
    } else if (member?.kind === 'scalar') {
      conditions.push([keyOf(model, entity, member.name), writeScalar(member.field, local)]);
    } else {
      conditions.push([snakeCase(param.name), `BsonValues.Of(${local})`]);
    }
  }
  return `new BsonDocument { ${conditions.map(([key, value]) => `{ ${csString(key)}, ${value} }`).join(', ')} }`;
}

/**
 * Las propiedades por las que se puede ordenar un listado, con su ruta en el documento. En el modelo documental la
 * propiedad es la RUTA del espejo, la que acepta el `?sort=` de keel-spring sobre su `XxxDocument` y la que el modelo
 * neutral pone en el orden por defecto del diseño: un value object es `location.label` (no el `locationLabel` aplanado
 * de la rama relacional) y una hija anidada también se puede recorrer (`sections.status`). Cada segmento va a su clave
 * del documento: `sections.id` es `sections._id`. El mismo recorrido que keel-nest.
 */
export function sortablePaths(model, entity) {
  const paths = [];
  const visitValueObject = (voName, property, path, seen) => {
    const vo = model.valueObjects.find((candidate) => candidate.name === voName);
    if (!vo || seen.has(voName)) return;
    for (const sub of vo.fields) {
      const subProperty = `${property}.${sub.name}`;
      const subPath = `${path}.${snakeCase(sub.name)}`;
      if (sub.kind === 'composite') visitValueObject(sub.namedType, subProperty, subPath, new Set([...seen, voName]));
      else paths.push([subProperty, subPath]);
    }
  };
  const visit = (current, prefix, pathPrefix, seen) => {
    for (const entry of documentShape(model, current)) {
      if (entry.kind === 'audit' && entry.role !== 'createdDate' && entry.role !== 'lastModifiedDate') continue;
      const property = prefix ? `${prefix}.${entry.member}` : entry.member;
      const path = pathPrefix ? `${pathPrefix}.${entry.name}` : entry.name;
      if (entry.kind === 'subdocument' && entry.valueObject) visitValueObject(entry.valueObject, property, path, new Set());
      else if ((entry.kind === 'subdocument' || entry.kind === 'array') && (entry.entity ?? entry.element?.entity)) {
        const child = model.entities.find((candidate) => candidate.name === (entry.entity ?? entry.element.entity));
        if (child && !seen.has(child.name)) visit(child, property, path, new Set([...seen, child.name]));
      } else if (entry.kind !== 'array' && entry.kind !== 'version') paths.push([property, path]);
    }
  };
  visit(entity, '', '', new Set([entity.name]));
  return paths;
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

/** El camino de una hija dentro del documento de la raíz: las claves de los campos que la anidan. */
function nestedPath(model, from, target, seen = new Set()) {
  for (const relation of from.relations ?? []) {
    if (!relation.internal || relation.backReference || seen.has(relation.entity)) continue;
    const next = model.entities.find((candidate) => candidate.name === relation.entity);
    if (!next) continue;
    if (next === target) return [snakeCase(relation.name)];
    const rest = nestedPath(model, next, target, new Set([...seen, from.name]));
    if (rest) return [snakeCase(relation.name), ...rest];
  }
  return null;
}

/** Las líneas que estampan la auditoría DECLARADA (campos del dominio) en la raíz y sus hijas, sobre el documento. */
function declaredAuditStamps(model, entity, needs) {
  const lines = [];
  for (const candidate of collectInternalEntities(model, entity).filter((c) => c.persisted)) {
    const declaredTs = candidate.auditTimestamps === 'declared';
    const declaredBy = candidate.auditAuthorship === 'declared';
    if (!declaredTs && !declaredBy) continue;
    const has = (name) => candidate.fields.some((field) => field.name === name);
    const stamps = [
      declaredTs && has('createdAt') ? 'BsonValues.StampCreated(node, "created_at", now);' : null,
      declaredTs && has('updatedAt') ? 'node["updated_at"] = now;' : null,
      declaredBy && has('createdBy') ? 'BsonValues.StampCreated(node, "created_by", actor);' : null,
      declaredBy && has('updatedBy') ? 'node["updated_by"] = actor;' : null
    ].filter(Boolean);
    if (stamps.length === 0) continue;
    if (stamps.some((line) => line.includes('now'))) needs.now = true;
    if (stamps.some((line) => line.includes('actor'))) needs.actor = true;
    const path = candidate === entity ? [] : nestedPath(model, entity, candidate);
    if (!path) continue;
    const nodes = `BsonValues.Nodes(document${path.map((key) => `, ${csString(key)}`).join('')})`;
    lines.push(`foreach (var node in ${nodes})`, '{', ...stamps.map((stamp) => `    ${stamp}`), '}');
  }
  return lines;
}

function saveMethod(model, entity) {
  return replicaOwnTransaction(model, entity, saveMethodBody(model, entity));
}

function saveMethodBody(model, entity) {
  const idProp = csMember(entity.idField?.name ?? 'id');
  const versioned = entity.usesOptimisticLocking;
  const policyTimestamps = entity.auditTimestamps === 'all' && documentShape(model, entity).some((entry) => entry.kind === 'audit' && entry.name === 'created_at');
  const policyAuthorship = entity.auditAuthorship === 'all' && documentShape(model, entity).some((entry) => entry.kind === 'audit' && entry.name === 'created_by');
  const needs = { now: policyTimestamps, actor: policyAuthorship };
  const declared = declaredAuditStamps(model, entity, needs);
  const lines = [`var document = ToDocument${entity.name}(entity);`];
  if (needs.now) lines.push('var now = BsonValues.Of(DateTimeOffset.UtcNow);');
  if (needs.actor) lines.push('var actor = BsonValues.Of(AuditActor.Current());');
  lines.push(...declared);
  lines.push(`var id = document[${csString(DOCUMENT_ID)}];`, `var fields = new BsonDocument(document.Where(element => element.Name != ${csString(DOCUMENT_ID)}));`);
  if (policyTimestamps) lines.push('// La auditoría de política: updated_at en cada escritura, created_at solo al nacer.', 'fields["updated_at"] = now;');
  if (policyAuthorship) lines.push('// La autoría de política: updated_by en cada escritura, created_by solo al nacer.', 'fields["updated_by"] = actor;');
  const onInsert = [policyTimestamps ? '{ "created_at", now }' : null, policyAuthorship ? '{ "created_by", actor }' : null].filter(Boolean);
  const column = LOCK_VERSION.column;
  if (versioned) {
    const created = [policyTimestamps ? 'fields["created_at"] = now;' : null, policyAuthorship ? 'fields["created_by"] = actor;' : null].filter(Boolean);
    lines.push(
      `var expected = entity.${csMember(LOCK_VERSION.field)};`,
      'if (expected is null)',
      '{',
      '    // Agregado nuevo: nace con la versión 0, como el @Version de Spring Data al insertar. Un id que ya existe es una',
      '    // violación del _id, que sale como conflicto de integridad.',
      `    fields[${csString(column)}] = new BsonInt64(0);`,
      ...created.map((line) => `    ${line}`),
      `    await Collection.InsertOneAsync(session, new BsonDocument(${csString(DOCUMENT_ID)}, id).AddRange(fields), cancellationToken: cancellationToken);`,
      '}',
      'else',
      '{',
      '    // La versión va en el FILTRO: si otra escritura la subió (o borró el documento) no casa nada, y reaplicar esta',
      '    // reharía en silencio una intención obsoleta.',
      `    fields[${csString(column)}] = new BsonInt64(expected.Value + 1);`,
      '    var updated = await Collection.UpdateOneAsync(',
      '        session,',
      `        new BsonDocument { { ${csString(DOCUMENT_ID)}, id }, { ${csString(column)}, new BsonInt64(expected.Value) } },`,
      '        new BsonDocument("$set", fields),',
      '        cancellationToken: cancellationToken);',
      '    if (updated.MatchedCount == 0)',
      '    {',
      `        throw new OptimisticLockConflict(${csString(entity.name)}, entity.${idProp}.ToString());`,
      '    }',
      '}'
    );
  } else {
    const update = onInsert.length > 0 ? `new BsonDocument { { "$set", fields }, { "$setOnInsert", new BsonDocument { ${onInsert.join(', ')} } } }` : 'new BsonDocument("$set", fields)';
    lines.push(
      `await Collection.UpdateOneAsync(session, new BsonDocument(${csString(DOCUMENT_ID)}, id), ${update}, new UpdateOptions { IsUpsert = true }, cancellationToken);`
    );
  }
  // Los eventos que la raíz acumuló salen por el puente DENTRO de esta transacción: con outbox, el documento del outbox y
  // el cambio confirman o abortan juntos; con best-effort, se publican tras el commit. Sin mensajería nadie los escucha,
  // pero se vacían igual para que el buffer no crezca con cada escritura.
  if (emitsEvents(model, entity)) {
    lines.push(usesBridge(model) ? 'await events.Publish(entity.PullDomainEvents(), cancellationToken);' : 'entity.PullDomainEvents();');
  }
  lines.push(`return ToDomain${entity.name}(new BsonDocument(${csString(DOCUMENT_ID)}, id).AddRange(fields));`);
  return `    public async Task<${entity.name}> Save(${entity.name} entity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(entity);
        return await transactions.InTransaction(
            async () =>
            {
                var session = transactions.Session!;
${lines.map((line) => (line === '' ? '' : `                ${line}`)).join('\n')}
            },
            readOnly: false,
            cancellationToken);
    }`;
}

/** El adaptador documental de una raíz. Lo llama repositories.js con el modelo `document`. */
export function renderDocumentAdapter(model, entity) {
  const { namespace, path } = located(model, 'repositoryAdapters', adapterClass(entity));
  const collection = entity.collectionName;
  const usings = ['MongoDB.Bson', 'MongoDB.Driver', repositoriesNamespace(model), persistenceNamespace(model), namespaceOf(model, 'useCaseInfra')];
  const involved = collectInternalEntities(model, entity).filter((candidate) => candidate.persisted);
  for (const candidate of involved) usings.push(namespaceOf(model, entityPlace(candidate)));
  for (const candidate of involved) for (const field of candidate.fields) if (field.kind === 'enum') usings.push(...typeUsings(model, [field.namedType ?? field.csType]));

  const entityFns = involved.map((candidate) => entityFunctions(model, candidate, collection));
  const voFns = [];
  const done = new Set();
  for (const candidate of involved) for (const vo of valueObjectsOf(candidate)) voFns.push(...valueObjectFunctions(model, vo, collection, usings, done));
  // Los enums de los value objects: sus campos también se guardan por la constante.
  for (const name of done) {
    const vo = model.valueObjects.find((candidate) => candidate.name === name);
    for (const field of vo?.fields ?? []) if (field.kind === 'enum') usings.push(...typeUsings(model, [field.namedType ?? field.csType]));
  }

  const idField = entity.idField;
  const idType = idField?.csType ?? 'Guid';
  const idName = csLocal(idField?.name ?? 'id');
  const idFilter = `new BsonDocument(${csString(DOCUMENT_ID)}, ${idField ? writeScalar(idField, idName) : `BsonValues.Of(${idName})`})`;
  const methods = [];
  methods.push(`    public async Task<${entity.name}?> FindById(${idType} ${idName}, CancellationToken cancellationToken = default)
    {
        var found = await Find(${idFilter}).FirstOrDefaultAsync(cancellationToken);
        return found is null ? null : ToDomain${entity.name}(found);
    }`);

  for (const finder of [naturalKeyFinder(model, entity), ...occupantFinders(model, entity), ...uniqueFieldFinders(model, entity)].filter(Boolean)) {
    for (const param of finder.params) usings.push(...param.usings);
    const signature = finder.params.map((p) => `${p.type} ${csLocal(p.name)}`).join(', ');
    methods.push(`    public async Task<${entity.name}?> ${finder.name}(${signature}, CancellationToken cancellationToken = default)
    {
        var found = await Find(${keyFilter(model, entity, finder)}).FirstOrDefaultAsync(cancellationToken);
        return found is null ? null : ToDomain${entity.name}(found);
    }`);
  }

  const batch = naturalKeyBatchFinder(model, entity);
  if (batch) {
    methods.push(`    public async Task<IReadOnlyList<${entity.name}>> ${batch.name}(IReadOnlyCollection<${batch.type}> ${batch.plural}, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(${batch.plural});
        var keys = ${batch.plural}.Distinct().ToList();
        if (keys.Count == 0)
        {
            return [];
        }
        var filter = new BsonDocument(${csString(keyOf(model, entity, batch.field.name))}, new BsonDocument("$in", new BsonArray(keys.Select(key => ${writeScalar(batch.field, 'key')}))));
        var found = await Find(filter).ToListAsync(cancellationToken);
        return [.. found.Select(ToDomain${entity.name})];
    }`);
  }

  for (const credential of credentialFinders(model, entity)) {
    const local = csLocal(credential.param);
    methods.push(`    public async Task<${entity.name}?> ${credential.name}(string ${local}, CancellationToken cancellationToken = default)
    {
        // La lista es un array del propio documento: MongoDB casa un array con uno de sus elementos.
        var found = await Find(new BsonDocument(${csString(keyOf(model, entity, credential.field.name))}, ${writeScalar(credential.field, local)})).FirstOrDefaultAsync(cancellationToken);
        return found is null ? null : ToDomain${entity.name}(found);
    }`);
  }

  if (isPaginated(model, entity)) {
    methods.push(`    public async Task<Page<${entity.name}>> List(Pageable pageable, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(pageable);
        var all = FilterDefinition<BsonDocument>.Empty;
        // Una tras otra y no en paralelo: dentro de una transacción la sesión no admite operaciones concurrentes.
        var total = transactions.Session is { } session
            ? await Collection.CountDocumentsAsync(session, all, cancellationToken: cancellationToken)
            : await Collection.CountDocumentsAsync(all, cancellationToken: cancellationToken);
        var offset = (int)Math.Min((long)pageable.Page * pageable.Size, int.MaxValue);
        // Un límite 0 en MongoDB es «sin límite»: una página de tamaño 0 no lee nada.
        var documents = pageable.Size == 0 ? new List<BsonDocument>() : await Find(all).Sort(Ordered(pageable.Sort)).Skip(offset).Limit(pageable.Size).ToListAsync(cancellationToken);
        var pages = pageable.Size == 0 ? 1 : (int)Math.Ceiling(total / (double)pageable.Size);
        return new Page<${entity.name}>([.. documents.Select(ToDomain${entity.name})], pageable.Page, pageable.Size, total, pages);
    }`);
  }

  // Los reclamos de barrido y de reconciliación (incremento 12c): el puerto es el mismo en los dos modelos.
  const sweeps = documentSweepClaimMethods(model, entity);
  const reconciliations = documentReconciliationMethods(model, entity);
  methods.push(...sweeps, ...reconciliations);
  // Las guardas de un efecto que no se deshace (mail.sentBy).
  methods.push(...documentGuardMethods(model, entity, guardClaimsFor(model, entity.name)));
  if (sweeps.length + reconciliations.length > 0) methods.push(documentOwnTransactionHelper());
  methods.push(saveMethod(model, entity));
  methods.push(`    public async Task DeleteById(${idType} ${idName}, CancellationToken cancellationToken = default)
    {
        // El agregado es el documento: borrarlo borra también sus hijas, que van dentro.
        await transactions.InTransaction(
            async () =>
            {
                await Collection.DeleteOneAsync(transactions.Session!, ${idFilter}, cancellationToken: cancellationToken);
                return true;
            },
            readOnly: false,
            cancellationToken);
    }`);

  // Lo que recibe el constructor: la transacción, el puente si la raíz emite eventos, y lo de sus reclamos.
  const ctor = ['PersistenceTransactions transactions'];
  if (usesBridge(model) && emitsEvents(model, entity)) {
    ctor.push(`${bridgeClass(model)} events`);
    usings.push(messagingNamespace(model));
  }
  const others = [...claimDependencies(model, entity), ...reconciliationDependencies(model, entity)];
  for (const dep of [...others, ...replicaDependencies(entity, others)]) {
    ctor.push(`${dep.type} ${dep.name}`);
    usings.push(...dep.usings);
  }
  const sortable = isPaginated(model, entity) ? sortableBlock(model, entity) : '';
  const body = `/// <summary>
/// Adaptador del puerto ${portClass(entity)} sobre el driver de MongoDB. Toma la sesión de la transacción abierta (la abre
/// el UseCaseMediator); sin ella, cada lectura va sola y cada escritura abre la suya.
/// </summary>
public sealed class ${adapterClass(entity)}(${ctor.join(', ')}) : ${portClass(entity)}
{
    /// <summary>La colección del agregado: el documento de la raíz, con sus hijas dentro.</summary>
    private const string CollectionName = ${csString(collection)};

    private IMongoCollection<BsonDocument> Collection => transactions.Collection(CollectionName);${sortable}

    /// <summary>Una búsqueda en la sesión de la transacción abierta, si la hay.</summary>
    private IFindFluent<BsonDocument, BsonDocument> Find(FilterDefinition<BsonDocument> filter) =>
        transactions.Session is { } session ? Collection.Find(session, filter) : Collection.Find(filter);

${methods.join('\n\n')}

    // ─── Mapeo dominio ↔ documento ──────────────────────────────────────────────────────────────

${[...entityFns, ...voFns].join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function sortableBlock(model, entity) {
  const entries = sortablePaths(model, entity).map(([property, path]) => `        [${csString(property)}] = ${csString(path)},`);
  return `

    /// <summary>
    /// Las propiedades por las que se puede ordenar, con su ruta en el documento: la ruta del espejo, la misma que acepta
    /// el <c>?sort=</c> de keel-spring documental. Una que no existe es un error, como la PropertyReferenceException de
    /// Spring Data.
    /// </summary>
    private static readonly Dictionary<string, string> Sortable = new(StringComparer.Ordinal)
    {
${entries.join('\n')}
    };

    /// <summary>
    /// El orden pedido más el <c>_id</c> como último criterio si no está ya: sin desempate, dos páginas consecutivas
    /// pueden repetir un documento y omitir otro.
    /// </summary>
    private static BsonDocument Ordered(IReadOnlyList<SortOrder> sort)
    {
        var order = new BsonDocument();
        foreach (var criterion in sort)
        {
            if (!Sortable.TryGetValue(criterion.Property, out var path))
            {
                throw new InvalidOperationException($"No existe la propiedad '{criterion.Property}' para ordenar ${entity.name}");
            }
            if (!order.Contains(path))
            {
                // Calificado: MongoDB.Driver tiene también un SortDirection.
                order.Add(path, criterion.Direction == ${repositoriesNamespace(model)}.SortDirection.Desc ? -1 : 1);
            }
        }
        if (!order.Contains(${csString(DOCUMENT_ID)}))
        {
            order.Add(${csString(DOCUMENT_ID)}, 1);
        }
        return order;
    }`;
}
