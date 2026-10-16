// La copia local de un dato de otro servidor (`dependencies.needs` con `strategy: replicated`, incremento 13j). Las mismas
// dos clases que keel-spring y keel-nest, en Application/Projection:
//
//   <E>Projector  la ESCRITURA: upsert idempotente que invoca el handler de la operación de proyección (la que dispara la
//                 suscripción del `fedBy`). Una reentrega tardía —un hecho anterior o igual al guardado— no pisa nada.
//   <E>Reader     la LECTURA: aplica `onMiss` cuando la copia todavía no tiene el dato (pedirlo al proveedor, fallar con el
//                 error del diseño o devolver null para degradar), y lee por lote cuando la lee un listado.
//
// El cableado es el de keel-spring: listener → guarda de idempotencia → UseCaseMediator → handler → Projector → puerto del
// repositorio. La copia se guarda en su PROPIA transacción (el adaptador de una réplica la abre en un ámbito nuevo).
//
// Diferencia con keel-nest, a propósito: allí el proyector llama a dos métodos de dominio que escribe el agente
// (projectionOf/applySnapshot) por medio de un cast; en C# eso no compila, y una réplica no lleva invariantes del dominio
// propio —las garantiza su dueño—, así que el proyector construye la copia con el constructor de rehidratación del
// agregado. No queda TODO en la escritura.

import { occurredAtField } from 'keel-core/gen/replica';
import { csFile, csLocal, csMember, csString, declType, entityPlace, located, namespaceOf, typeUsings, xmlDoc } from './render.js';
import { domainMembers } from './entities.js';
import { naturalKeyBatchFinder, naturalKeyFinder, portClass, repositoriesNamespace } from './repositories.js';
import { clientPort, clientsNamespace } from './http-clients.js';

/** Las réplicas que el diseño declara, ya resueltas por el modelo, con su entidad. */
export function replicas(model) {
  const found = [];
  for (const dependency of model.dependencies ?? []) {
    for (const need of dependency.needs ?? []) {
      if (need.strategy !== 'replicated' || !need.replica) continue;
      const entity = (model.entities ?? []).find((candidate) => candidate.name === need.replica.entityName);
      if (entity && entity.persisted) found.push({ dependency, need, entity });
    }
  }
  return found;
}

export function projectionNamespace(model) {
  return namespaceOf(model, 'projection');
}

/** Las clases que UseCaseRegistration tiene que registrar: el proyector y el lector de cada réplica. */
export function projectionClasses(model) {
  return replicas(model).flatMap(({ need }) => [need.replica.projectorClass, need.replica.readerClass]);
}

/** La réplica que alimenta la suscripción que dispara esta operación (`fedBy`), si la hay. */
export function projectionsFedBy(model, operation) {
  const fed = (model.subscriptions ?? []).filter((sub) => sub.trigger === operation.name && sub.feedsReplica);
  return replicas(model).filter(({ entity }) => fed.some((sub) => sub.feedsReplica.entity === entity.name));
}

export function generate(model) {
  return replicas(model).flatMap(({ dependency, need, entity }) => [renderProjector(model, dependency, need, entity), renderReader(model, dependency, need, entity)]);
}

// Lo que la proyección mantiene: todo menos el id técnico y la clave de correlación, que identifican la fila.
function projectedFields(entity, replica) {
  return entity.fields.filter((field) => !field.isId && field.name !== replica.keyField && !field.generated);
}

/**
 * El estado de la copia, miembro a miembro: de la instantánea lo informado, y de la copia que ya había (o nuevo) lo que la
 * identifica. Null si el agregado tiene algo que la instantánea no informa y no se puede inventar (un hijo, una lista de
 * otro agregado): entonces la escritura la hace el agente.
 */
function stateAssignments(model, entity, replica, existing) {
  const projected = new Set(projectedFields(entity, replica).map((field) => field.name));
  const assignments = [];
  for (const member of domainMembers(model, entity)) {
    const name = csMember(member.name);
    if (member.field?.isId) {
      if (existing) assignments.push(`${name} = existing.${name}`);
      else if (member.field.initializer) assignments.push(`${name} = ${member.field.initializer}`);
      else return null;
    } else if (member.name === replica.keyField) {
      assignments.push(`${name} = ${existing ? 'existing' : 'snapshot'}.${name}`);
    } else if (projected.has(member.name)) {
      assignments.push(`${name} = snapshot.${name}`);
    } else {
      return null;
    }
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) assignments.push(`LockVersion = ${existing ? 'existing.LockVersion' : 'null'}`);
  return assignments;
}

function renderProjector(model, dependency, need, entity) {
  const { replica } = need;
  const { namespace, path } = located(model, 'projection', replica.projectorClass);
  const fields = projectedFields(entity, replica);
  const keyField = entity.fields.find((field) => field.name === replica.keyField);
  const snapshotFields = [keyField, ...fields].filter(Boolean);
  const usings = [namespaceOf(model, entityPlace(entity)), repositoriesNamespace(model), ...snapshotFields.flatMap((field) => typeUsings(model, [field.elementCsType ?? field.csType]))];
  const ordering = occurredAtField(entity);
  const finder = naturalKeyFinder(model, entity);
  const created = stateAssignments(model, entity, replica, false);
  const updated = stateAssignments(model, entity, replica, true);
  const state = (assignments, pad) => `new ${entity.name}(new ${entity.name}State\n${pad}{\n${assignments.map((a) => `${pad}    ${a},`).join('\n')}\n${pad}})`;
  const guard = ordering
    ? `
            // Reentrega o hecho viejo: uno anterior O IGUAL al guardado se confirma sin efecto. Con el mismo instante no hay
            // orden que decida, y aplicarlo dejaría ganar al último en llegar.
            if (${ordering.required ? '' : `snapshot.${csMember(ordering.name)} is not null && existing.${csMember(ordering.name)} is not null && `}snapshot.${csMember(ordering.name)} <= existing.${csMember(ordering.name)})
            {
                return;
            }`
    : `
            // TODO (agente): el payload no trae ningún instante del hecho, así que dos entregas desordenadas dejarían el valor
            // viejo. Si el proveedor expone uno, añádelo al payload en el diseño y compáralo aquí.`;
  const write =
    created && updated && finder
      ? `        var existing = await repository.${finder.name}(snapshot.${csMember(replica.keyField)}, cancellationToken);
        if (existing is not null)
        {${guard}
            await repository.Save(${state(updated, '            ')}, cancellationToken);
            return;
        }
        await repository.Save(${state(created, '        ')}, cancellationToken);`
      : `        // TODO (agente): ${entity.name} tiene miembros que la instantánea no informa; construye la copia (nueva o actualizada)
        // y guárdala con repository.Save(...). Un hecho anterior o igual al guardado no la pisa.
        _ = repository;
        await Task.CompletedTask;
        throw new NotImplementedException(${csString(`TODO: ${replica.projectorClass}.Apply`)});`;
  const body = `${xmlDoc(`El estado que informa ${dependency.id} de un ${entity.name}.`)}public sealed record ${entity.name}Snapshot(${snapshotFields.map((field) => `${declType(field)} ${csMember(field.name)}`).join(', ')});

/// <summary>
/// Mantiene al día la copia local de ${entity.name}, propiedad de ${dependency.id}. Es una PROYECCIÓN, no una fuente de verdad:
/// solo se escribe desde aquí, nunca desde un handler de negocio, y no se le aplican invariantes del dominio propio —las suyas
/// las garantiza ${dependency.id}—. El upsert es idempotente: una reentrega no corrompe la copia (la deduplicación estricta la
/// hace antes la guarda del listener; esto es la segunda red).
/// </summary>
/// <remarks>Necesidad que la justifica: ${dependency.id}.${need.name}${need.description ? ` — ${need.description}` : ''}</remarks>
public sealed class ${replica.projectorClass}(${portClass(entity)} repository)
{
    private readonly ${portClass(entity)} repository = repository;

    /// <summary>
    /// Aplica el estado que informa ${dependency.id}: actualiza la copia si ya existe, la crea si es la primera noticia de
    /// este ${replica.keyField}. La copia se guarda en su propia transacción.
    /// </summary>
    public async Task Apply(${entity.name}Snapshot snapshot, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
${write}
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function renderReader(model, dependency, need, entity) {
  const { replica } = need;
  const { onMiss } = replica;
  const { namespace, path } = located(model, 'projection', replica.readerClass);
  const keyField = entity.fields.find((field) => field.name === replica.keyField);
  const keyType = keyField?.csType ?? 'string';
  const key = csLocal(replica.keyField);
  const usings = [namespaceOf(model, entityPlace(entity)), repositoriesNamespace(model), ...typeUsings(model, [keyType])];
  const deps = [{ type: portClass(entity), name: 'repository' }];
  const client = onMiss.action === 'fetch' && need.fetch ? (model.httpClients ?? []).find((candidate) => candidate.clientClass === need.fetch.clientClass) : null;
  if (client) {
    usings.push(clientsNamespace(model));
    const port = clientPort(client);
    deps.push({ type: port, name: `${port.slice(1, 2).toLowerCase()}${port.slice(2)}` });
  }
  const finder = naturalKeyFinder(model, entity);
  const find = `await repository.${finder?.name ?? `FindBy${csMember(replica.keyField)}`}(${key}, cancellationToken)`;
  let method;
  if (onMiss.action === 'fetch' && client) {
    const local = deps[1].name;
    method = `    /// <summary>
    /// La copia local y, si aún no la tenemos, la pide a ${dependency.id} y la guarda. La copia se guarda en su PROPIA transacción
    /// (el adaptador del repositorio de una réplica la abre aparte): aquí se llega desde una consulta, de solo lectura. Desde un
    /// command que escribe, la llamada de red alarga su transacción: resuelve el dato antes.
    /// </summary>
    public async Task<${entity.name}?> ByKey(${keyType} ${key}, CancellationToken cancellationToken = default) =>
        ${find} ?? await Hydrate(${key}, cancellationToken);

    private Task<${entity.name}?> Hydrate(${keyType} ${key}, CancellationToken cancellationToken)
    {
        // TODO (agente): invoca await ${local}.${csMember(need.fetch.call)}(..., cancellationToken) —ya devuelve el resultado de
        // dominio (${need.fetch.resultType})—, construye la copia de ${entity.name} y guárdala con repository.Save(...), y
        // devuélvela. El retry y el circuito ya están en el adaptador: no los repitas.
        _ = (${local}, ${key}, cancellationToken);
        return Task.FromResult<${entity.name}?>(null);
    }`;
  } else if (onMiss.action === 'fail') {
    const message = `$"No se conoce ${replica.entityName} {${key}} (dato de ${dependency.id} aún no replicado)"`;
    if (onMiss.exceptionClass) usings.push(namespaceOf(model, 'errors'));
    const exception = onMiss.exceptionClass ? `new ${onMiss.exceptionClass}(${message}${onMiss.dynamicStatus ? `, ${onMiss.httpStatus}` : ''})` : `new InvalidOperationException(${message})`;
    method = `    /// <summary>
    /// La copia local, o falla con ${onMiss.error ?? 'el error de onMiss'} si ${dependency.id} todavía no nos ha informado de ese
    /// ${replica.keyField}: sin el dato no se puede decidir bien, y así lo declara el diseño.${onMiss.exceptionClass ? '' : `\n    /// TODO (agente): el diseño declara onMiss.error = ${onMiss.error}, pero ninguna operación lo declara: su clase no existe.`}
    /// </summary>
    public async Task<${entity.name}> ByKey(${keyType} ${key}, CancellationToken cancellationToken = default) =>
        ${find} ?? throw ${exception};`;
  } else {
    method = `    /// <summary>
    /// La copia local, o null si ${dependency.id} todavía no nos ha informado de ese ${replica.keyField}. El diseño declara que
    /// entonces el servicio DEGRADA: ${onMiss.degradedTo ?? '(sin describir)'}. El resultado degradado lo escribe quien llama,
    /// distinguible por el cliente de una respuesta normal.
    /// </summary>
    public async Task<${entity.name}?> ByKey(${keyType} ${key}, CancellationToken cancellationToken = default) =>
        ${find};`;
  }
  const batch = naturalKeyBatchFinder(model, entity);
  const byKeys =
    batch?.reason === 'replica-listing'
      ? `

    /// <summary>
    /// Las copias locales de varios ${replica.keyField} en UNA consulta, indexadas por ${replica.keyField}. Es lo que lee una
    /// operación de listado: un ByKey(...) por elemento serían N consultas por página. Solo devuelve lo ya replicado: una
    /// clave que falte NO está en el diccionario, y a cada una de esas se le aplica la política declarada pasándola por
    /// ByKey(...). No la des por inexistente.
    /// </summary>
    public async Task<IReadOnlyDictionary<${keyType}, ${entity.name}>> ByKeys(IReadOnlyCollection<${keyType}> ${batch.plural}, CancellationToken cancellationToken = default)
    {
        var copies = await repository.${batch.name}(${batch.plural}, cancellationToken);
        return copies.ToDictionary(copy => copy.${csMember(replica.keyField)});
    }`
      : '';
  const freshness = replica.freshness ? ` Tolerancia declarada en el diseño: ${replica.freshness}` : '';
  const users = need.usedBy.length > 0 ? ` Lo usan: ${need.usedBy.join(', ')}.` : '';
  const body = `/// <summary>
/// Lectura de la copia local de ${replica.entityName} (propiedad de ${dependency.id}), con la política declarada para cuando el
/// dato todavía no está: ${onMiss.action}. La copia es eventualmente consistente —la mantiene ${replica.projectorClass} al ritmo de
/// los eventos de ${dependency.id}—: nunca la expongas como recurso propio.${freshness}${users}
/// </summary>
public sealed class ${replica.readerClass}(${deps.map((dep) => `${dep.type} ${dep.name}`).join(', ')})
{
${deps.map((dep) => `    private readonly ${dep.type} ${dep.name} = ${dep.name};`).join('\n')}

${method}${byKeys}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** La nota del handler de la operación de proyección: aplica con el proyector. */
export function projectionNotes(model, operation) {
  return projectionsFedBy(model, operation).map(
    ({ need }) =>
      `Proyección de ${need.replica.entityName}: aplica el estado que informa el evento con await ${projectorLocal(need.replica)}.Apply(new ${need.replica.entityName}Snapshot(...), cancellationToken) ` +
      '—upsert idempotente que ya descarta la reentrega tardía y guarda en su propia transacción—. Es la ÚNICA escritura de la copia: no la guardes por el repositorio.'
  );
}

export function projectorLocal(replica) {
  return `${replica.projectorClass[0].toLowerCase()}${replica.projectorClass.slice(1)}`;
}

export function readerLocal(replica) {
  return `${replica.readerClass[0].toLowerCase()}${replica.readerClass.slice(1)}`;
}
