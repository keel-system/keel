// Entidades de dominio PURAS (sin EF Core ni ASP.NET Core), con la misma forma que las de keel-spring y
// keel-nest: raíces de agregado en Domain/Aggregate, entidades internas en Domain/Entity. Modelo encapsulado:
//   · el estado entra por UN constructor de rehidratación, que usa el adaptador de persistencia (el estado
//     ya es válido y no se revalida). Recibe un `<Entidad>State` con propiedades `required`: el compilador
//     exige que esté completo, y no hay argumentos posicionales que se desordenen sin que nadie lo note;
//   · propiedades de solo lectura desde fuera (`private set`); las colecciones salen como vista de solo
//     lectura. La mutación es por métodos de negocio que escribe el agente;
//   · la guarda privada del lifecycle (`TransitionTo`) con las transiciones del diseño;
//   · el buffer de eventos de dominio en las raíces emisoras;
//   · TODOs guiados del factory, de los métodos semánticos y de los invariantes.
// La persistencia vive aparte (incremento 6): el dominio no sabe cómo se guarda.

import { LOCK_VERSION } from 'keel-core/gen';
import { memberOf } from './enums.js';
import { csFile, csLocal, csMember, declType, entityPlace, fieldUsings, located, namespaceOf, typeUsings, xmlDoc } from './render.js';

export function generate(model) {
  return (model.entities ?? []).map((entity) => renderEntity(model, entity));
}

/**
 * Los miembros del estado de la entidad: campos del diseño + relaciones (internas como entidad de dominio,
 * externas como el id de la otra raíz cuando hay persistencia). El mismo reparto que `domainMembers` de
 * keel-spring y keel-nest, con el tipo que se declara en C#.
 */
export function domainMembers(model, entity) {
  const members = entity.fields.map((field) =>
    isDeclaredLockVersion(entity, field)
      ? { kind: 'field', field, name: field.name, type: `${field.csType}?`, element: null, declaredLock: true }
      : { kind: 'field', field, name: field.name, type: declType(field), element: field.list ? field.elementCsType : null }
  );
  for (const relation of entity.relations ?? []) {
    // La referencia de vuelta a la raíz no es un miembro del dominio: dentro del agregado el contexto ya es
    // la raíz, y modelarla obligaría a recorrer el ciclo hija → padre → hija.
    if (relation.backReference) continue;
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal && model.layersPresent?.persistence) {
      const target = model.entities.find((e) => e.name === relation.entity);
      const idType = target?.fields.find((f) => f.isId)?.csType ?? 'Guid';
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, type: relation.required ? idType : `${idType}?` });
    } else if (toMany) {
      members.push({ kind: 'relationMany', relation, name: relation.name, type: `IReadOnlyList<${relation.entity}>`, element: relation.entity });
    } else {
      members.push({ kind: 'relationOne', relation, name: relation.name, type: relation.required ? relation.entity : `${relation.entity}?` });
    }
  }
  return members;
}

/**
 * ¿Es el `lockVersion` que el diseño DECLARA para portar el bloqueo optimista (`optimisticLocking: declared`)? Lo lleva
 * la persistencia igual que el que añade build: null hasta la primera escritura, que es como el adaptador sabe que el
 * agregado es nuevo. Declarado `int` a secas, el `expected is null` del Save no compilaba (corrida catalog-dotnet).
 */
export function isDeclaredLockVersion(entity, field) {
  return Boolean(entity.declaresLockVersion && entity.usesOptimisticLocking && field?.name === LOCK_VERSION.field);
}

function renderEntity(model, entity) {
  const { namespace, path } = located(model, entityPlace(entity), entity.name);
  const usings = [];
  const members = domainMembers(model, entity);
  for (const member of members) {
    if (member.kind === 'field') usings.push(...fieldUsings(model, member.field));
    else if (member.kind !== 'externalRef') usings.push(...typeUsings(model, [member.relation.entity]));
  }

  // Concurrencia optimista: la raíz porta la versión que gestiona la persistencia. Viaja por el estado para
  // que la ida y vuelta dominio ↔ persistencia no la pierda; nadie la cambia a mano.
  const lockVersion = entity.usesOptimisticLocking && !entity.declaresLockVersion;
  const stateMembers = lockVersion
    ? [...members, { kind: 'lockVersion', name: 'lockVersion', type: 'long?', doc: 'Versión de concurrencia optimista; la gestiona la persistencia. Null hasta la primera escritura.' }]
    : members;

  // Los TODO de invariantes van ANTES del comentario de documentación: entre él y su clase no puede haber
  // nada, o el editor deja de asociarlos.
  const header = (entity.invariants ?? []).map((invariant) => `// TODO invariante (guarda en el factory y en cada método mutador): ${invariant}`);
  if (entity.description) header.push(xmlDoc(entity.description).trimEnd());

  const parts = [];
  if (entity.lifecycle) {
    usings.push(namespaceOf(model, 'errors'));
    parts.push(renderTransitions(model, entity));
  }
  const emitted = (model.events ?? []).filter((event) => event.aggregates.includes(entity.name));
  if (emitted.length > 0) {
    usings.push(namespaceOf(model, 'events'));
    parts.push(renderDomainEvents(emitted, entity.name));
  }

  // Las colecciones, en una lista privada: los métodos de negocio la cambian, y desde fuera solo se ve.
  const collections = stateMembers.filter((member) => member.element);
  if (collections.length > 0) parts.push(collections.map((member) => `    private readonly List<${member.element}> ${backingField(member)};`).join('\n'));

  const formatGuards = entity.fields.filter((field) => field.inheritedPattern && field.typeName && model.formatTypes?.some((t) => t.name === field.typeName));
  const guardTodo = formatGuards.length
    ? [
        '',
        '    // TODO (agente): formato de los value types, tras normalizar, en el factory y en TODO método que',
        '    // asigne el campo:',
        ...formatGuards.map((field) => `    //   ${field.typeName}Format.Validate(${field.list ? `cada elemento de ${csMember(field.name)}` : csMember(field.name)});`)
      ].join('\n')
    : '';
  if (formatGuards.length > 0) usings.push(namespaceOf(model, 'valueObjects'));
  const initial = entity.fields.filter((field) => field.initializer);
  const longIds = initial.some((field) => field.initializer.includes('LongIds.Next()'))
    ? `\n    // LongIds.Next() está en ${namespaceOf(model, 'domainSupport')}: un id long lo crea la aplicación al nacer la raíz.`
    : '';
  const initialTodo = initial.length ? `\n    // Valores iniciales del diseño: ${initial.map((field) => `${csMember(field.name)} = ${field.initializer}`).join(', ')}.${longIds}` : '';
  parts.push(`    // TODO (agente): factory \`public static ${entity.name} Create(...)\` que aplique los invariantes, derive los
    // campos generated/computed y fije el estado inicial del lifecycle. La mutación va por métodos de
    // negocio, no por setters.${initialTodo}${guardTodo}`);

  const assigns = stateMembers.map((member) =>
    member.element ? `        ${backingField(member)} = [.. state.${csMember(member.name)}];` : `        ${csMember(member.name)} = state.${csMember(member.name)};`
  );
  parts.push(`    /// <summary>
    /// Rehidratación desde persistencia: el estado ya es válido y no se revalida. La creación de negocio va
    /// por el factory. Las colecciones se copian: quien entrega el estado no puede cambiarlas después por la
    /// espalda del agregado.
    /// </summary>
    public ${entity.name}(${entity.name}State state)
    {
        ArgumentNullException.ThrowIfNull(state);
${assigns.join('\n')}
    }`);

  parts.push(
    stateMembers
      .map((member) => {
        const doc = xmlDoc(memberDoc(member), '    ');
        return member.element
          ? `${doc}    public ${member.type} ${csMember(member.name)} => ${backingField(member)}.AsReadOnly();`
          : `${doc}    public ${member.type} ${csMember(member.name)} { get; private set; }`;
      })
      .join('\n\n')
  );

  if (entity.lifecycle) parts.push(renderTransitionTo(entity));

  const state = stateMembers.map((member) => `${xmlDoc(memberDoc(member), '    ')}    public required ${member.type} ${csMember(member.name)} { get; init; }`);
  const body = `${xmlDoc(`El estado completo de ${entity.name}, tal como lo rehidrata la persistencia.`)}public sealed class ${entity.name}State
{
${state.join('\n\n')}
}

${header.length > 0 ? `${header.join('\n')}\n` : ''}public class ${entity.name}
{
${parts.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function backingField(member) {
  return csLocal(member.name).replace(/^@/, '');
}

function memberDoc(member) {
  const description =
    member.field?.description ??
    member.doc ??
    (member.declaredLock ? 'Versión de concurrencia optimista; la gestiona la persistencia. Null hasta la primera escritura.' : null) ?? (member.kind === 'externalRef' ? `Id de la raíz del agregado ${member.relation.entity} (otro agregado: solo el id).` : null);
  return [description, member.field?.computed ? `TODO computed: ${member.field.computed}` : null];
}

// Acumulación de eventos en la raíz: el método de negocio que provoca el cambio hace Raise(...); el adaptador
// de repositorio drena el buffer al persistir. El agregado no conoce el broker.
function renderDomainEvents(emitted, entityName) {
  const pending = emitted
    .map((event) => {
      const args = event.fields.map((f) => csMember(f.name)).join(', ');
      // Solo las operaciones de ESTE agregado: un evento que emiten dos raíces se genera en las dos, y
      // citarle a cada una las operaciones de la otra manda el Raise() al sitio equivocado.
      const origin = event.emittedBy
        .filter((e) => e.aggregate === entityName)
        .map((e) => e.operation)
        .join(', ');
      return `    // TODO (agente): emitir ${event.name} en el método de negocio de ${origin || 'la operación que lo declara'}:
    //   Raise(${event.className}.Of(${args}));`;
    })
    .join('\n');
  // Una sobrecarga por evento del diseño: el agregado solo puede acumular los suyos.
  const raises = emitted.map((event) => `    protected void Raise(${event.className} domainEvent) => domainEvents.Add(domainEvent);`).join('\n\n');
  return `    // ─── Eventos de dominio ──────────────────────────────────────────────────────
    // Se acumulan aquí y salen por PullDomainEvents() al persistir; nadie más construye eventos de este
    // agregado.
    private readonly List<IDomainEvent> domainEvents = [];

${pending}

${raises}

    /// <summary>Vacía el buffer y devuelve lo acumulado; lo llama el adaptador de repositorio.</summary>
    public IReadOnlyList<IDomainEvent> PullDomainEvents()
    {
        var pending = domainEvents.ToArray();
        domainEvents.Clear();
        return pending;
    }`;
}

function renderTransitions(model, entity) {
  const { enumType, transitions } = entity.lifecycle;
  const member = (constant) => `${enumType}.${memberOf(model, enumType, constant)}`;
  const entries = transitions.map(({ from, to }) => `        [${member(from)}] = [${to.map(member).join(', ')}],`).join('\n');
  // El diseño dice qué operación ejecuta cada transición: nombrarla aquí ata el método semántico a su
  // handler. Sin ella el TODO queda sin destinatario y el estado acaba cambiándose desde fuera.
  const executedBy = entity.lifecycle.executedBy ?? {};
  const todos = transitions
    .flatMap(({ from, to }) =>
      to.map((state) => {
        const ops = executedBy[`${from}|${state}`] ?? [];
        const origin = ops.length ? ` (lo ejecuta ${ops.join(', ')})` : '';
        return `    // TODO (agente): método semántico ${from} → ${state}${origin} que valide la regla del diseño y llame a TransitionTo(${member(state)}).`;
      })
    )
    .join('\n');
  return `    // Transiciones válidas del lifecycle del diseño; un estado sin destinos es terminal.
    private static readonly IReadOnlyDictionary<${enumType}, ${enumType}[]> Transitions = new Dictionary<${enumType}, ${enumType}[]>
    {
${entries}
    };

${todos}`;
}

function renderTransitionTo(entity) {
  const { field, enumType } = entity.lifecycle;
  const fieldDef = entity.fields.find((f) => f.name === field);
  const nullable = fieldDef && !(fieldDef.required || fieldDef.isId || fieldDef.generated);
  const property = csMember(field);
  const guard = nullable
    ? `if (current is null || !Transitions.TryGetValue(current.Value, out var allowed) || !allowed.Contains(target))
        {
            throw new InvalidStateTransitionException(current?.ToString() ?? "null", target.ToString());
        }`
    : `if (!Transitions.TryGetValue(current, out var allowed) || !allowed.Contains(target))
        {
            throw new InvalidStateTransitionException(current.ToString(), target.ToString());
        }`;
  return `    // Guarda interna del lifecycle: la llaman los métodos semánticos, nunca un handler.
    private void TransitionTo(${enumType} target)
    {
        var current = ${property};
        ${guard}
        ${property} = target;
    }`;
}
