// Entidades de dominio PURAS (sin JPA, patrón del prototipo de referencia):
// raíces de agregado en domain/aggregate, entidades internas en domain/entity.
// Modelo encapsulado (conventions/domain-modeling.md): constructor completo solo
// para rehidratar desde persistencia, getters (colecciones como vista inmutable),
// guard privado de lifecycle (transitionTo) y TODOs guiados de factory, métodos
// semánticos e invariantes. Sin setters: la mutación es por métodos de negocio
// que escribe el agente. La persistencia vive aparte en
// infrastructure/persistence (XxxJpa + adaptador).

import { javaFile, javaPath, subPackage, javadoc } from './render.js';

// Subpaquete de una entidad de dominio según su rol en el agregado.
export function domainSubPackage(entity) {
  return entity.isAggregateRoot ? 'domain.aggregate' : 'domain.entity';
}

// Import del tipo de dominio de un campo resuelto (enum/VO), si aplica.
export function domainTypeImport(model, field) {
  // En un campo colección el tipo importable es el del elemento, no el List<>.
  const typeName = field.elementJavaType ?? field.javaType;
  if (field.kind === 'enum') return `${subPackage(model, 'domain.enums')}.${typeName}`;
  if (field.kind === 'composite') return `${subPackage(model, 'domain.valueobject')}.${typeName}`;
  return null;
}

export function generate(model) {
  return model.entities.map((entity) => renderEntity(model, entity));
}

// Campos "planos" de la entidad de dominio: fields del diseño + relaciones
// (internas como tipo de dominio, externas como UUID id con persistence).
export function domainMembers(model, entity) {
  const members = entity.fields.map((field) => ({
    kind: 'field',
    field,
    name: field.name,
    javaType: field.javaType
  }));

  for (const relation of entity.relations) {
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal && model.layersPresent.persistence) {
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, javaType: 'UUID' });
    } else {
      members.push({
        kind: toMany ? 'relationMany' : 'relationOne',
        relation,
        name: relation.name,
        javaType: toMany ? `List<${relation.entity}>` : relation.entity
      });
    }
  }
  return members;
}

function renderEntity(model, entity) {
  const imports = new Set();
  const members = domainMembers(model, entity);
  const declarations = [];

  for (const member of members) {
    const lines = [];
    if (member.kind === 'field') {
      const { field } = member;
      for (const name of field.imports) imports.add(name);
      const typeImport = domainTypeImport(model, field);
      if (typeImport) imports.add(typeImport);
      if (field.description) lines.push(`    // ${field.description}`);
      if (field.computed) lines.push(`    // TODO computed: ${field.computed}`);
      if (field.list) {
        // Colección de valores sin identidad (list): lista mutable internamente,
        // expuesta como vista inmutable; la altera solo la raíz por métodos de negocio.
        imports.add('java.util.List');
        imports.add('java.util.ArrayList');
        lines.push(`    private ${field.javaType} ${field.name} = new ArrayList<>();`);
      } else {
        const init = field.initializer ? ` = ${field.initializer}` : '';
        lines.push(`    private ${field.javaType} ${field.name}${init};`);
      }
    } else if (member.kind === 'externalRef') {
      imports.add('java.util.UUID');
      lines.push(`    // Referencia a la raíz del agregado ${member.relation.entity} (otro agregado: solo el id).`);
      lines.push(`    private UUID ${member.name};`);
    } else {
      imports.add(relatedImport(model, member.relation.entity));
      if (member.kind === 'relationMany') {
        imports.add('java.util.List');
        imports.add('java.util.ArrayList');
        lines.push(`    private ${member.javaType} ${member.name} = new ArrayList<>();`);
      } else {
        lines.push(`    private ${member.javaType} ${member.name};`);
      }
    }
    declarations.push(lines.join('\n'));
  }

  const header = [];
  if (entity.description) header.push(javadoc(entity.description).trimEnd());
  for (const invariant of entity.invariants) {
    header.push(`// TODO invariante (guarda en el factory y en cada método mutador, ver conventions/domain-modeling.md): ${invariant}`);
  }

  const bodyParts = [];

  // Buffer de eventos: solo en las raíces que el diseño declara emisoras.
  const emitted = model.events.filter((event) => event.aggregate === entity.name);
  if (emitted.length > 0) {
    imports.add('java.util.Collections');
    imports.add('java.util.List');
    imports.add('java.util.ArrayList');
    imports.add(`${subPackage(model, 'domain.events')}.DomainEvent`);
    for (const event of emitted) imports.add(`${subPackage(model, 'domain.events')}.${event.className}`);
    bodyParts.push(renderDomainEvents(emitted));
  }

  bodyParts.push(declarations.join('\n\n'));

  bodyParts.push(`    // TODO (agente): factory de creación create(...) que aplique los invariantes,
    // derive los campos generated/computed y fije el estado inicial del lifecycle
    // (conventions/domain-modeling.md). La mutación va por métodos de negocio, no por setters.`);

  if (members.length > 0) {
    const ctorParams = members.map((m) => `${m.javaType} ${m.name}`).join(', ');
    // Copia defensiva de las colecciones: el toDomain del adaptador entrega una
    // lista inmutable y la raíz debe poder mutarla desde sus métodos de negocio.
    const ctorAssigns = members
      .map((m) => {
        const isCollection = m.kind === 'relationMany' || m.field?.list;
        return `        this.${m.name} = ${isCollection ? `new ArrayList<>(${m.name})` : m.name};`;
      })
      .join('\n');
    bodyParts.push(`    // Rehidratación desde persistencia (lo usa el toDomain del adaptador de repositorio):
    // el estado ya es válido y no se revalida. La creación de negocio va por el factory.
    public ${entity.name}(${ctorParams}) {
${ctorAssigns}
    }`);
  }

  if (entity.lifecycle) {
    imports.add(`${subPackage(model, 'domain.errors')}.InvalidStateTransitionException`);
    bodyParts.push(renderLifecycle(entity, imports));
  }
  bodyParts.push(renderAccessors(members));

  const body = `${header.join('\n')}
public class ${entity.name} {

${bodyParts.join('\n\n')}
}`;

  const pkg = domainSubPackage(entity);
  return {
    path: javaPath(model, pkg, entity.name),
    content: javaFile(subPackage(model, pkg), [...imports], body)
  };

  function relatedImport(model, entityName) {
    const related = model.entities.find((e) => e.name === entityName);
    const relatedPkg = related ? domainSubPackage(related) : 'domain.entity';
    return `${subPackage(model, relatedPkg)}.${entityName}`;
  }
}

// Acumulación de eventos de dominio en la raíz: el método de negocio que
// provoca el cambio hace raise(...); el adaptador de repositorio drena el
// buffer al persistir (conventions/domain-modeling.md). El agregado no conoce
// Spring ni el broker: solo registra lo que ocurrió.
function renderDomainEvents(emitted) {
  const pending = emitted
    .map((event) => {
      const args = event.fields.map((f) => f.name).join(', ');
      const origin = event.emittedBy.map((e) => e.operation).join(', ');
      return `    // TODO (agente): emitir ${event.name} en el método de negocio de ${origin || 'la operación que lo declara'}:
    //   raise(${event.className}.of(${args}));`;
    })
    .join('\n');

  return `    // ─── Eventos de dominio ───────────────────────────────────────────────────
    // Se acumulan aquí y salen por pullDomainEvents() al persistir; nadie más
    // construye eventos de este agregado.
    private final List<DomainEvent> domainEvents = new ArrayList<>();

${pending}

    protected void raise(DomainEvent event) {
        domainEvents.add(event);
    }

    /** Vacía el buffer y devuelve lo acumulado; lo llama el adaptador de repositorio. */
    public List<DomainEvent> pullDomainEvents() {
        List<DomainEvent> pending = Collections.unmodifiableList(new ArrayList<>(domainEvents));
        domainEvents.clear();
        return pending;
    }`;
}

function renderLifecycle(entity, imports) {
  imports.add('java.util.Map');
  imports.add('java.util.Set');
  const { field, enumType, transitions } = entity.lifecycle;
  const entries = transitions
    .map(({ from, to }) => {
      const targets = to.map((state) => `${enumType}.${state}`).join(', ');
      return `        ${enumType}.${from}, Set.of(${targets})`;
    })
    .join(',\n');

  const semanticTodos = transitions
    .flatMap(({ from, to }) => to.map((state) => `    // TODO (agente): método semántico ${from} → ${state} que valide la regla del diseño y llame a transitionTo(${enumType}.${state}).`))
    .join('\n');

  return `    // Transiciones válidas del lifecycle del diseño; un estado con Set.of() es terminal.
    private static final Map<${enumType}, Set<${enumType}>> TRANSITIONS = Map.of(
${entries}
    );

${semanticTodos}

    // Guard interno del lifecycle: lo llaman los métodos semánticos, nunca un handler.
    private void transitionTo(${enumType} target) {
        if (!TRANSITIONS.getOrDefault(${field}, Set.of()).contains(target)) {
            throw new InvalidStateTransitionException(${field}.name(), target.name());
        }
        this.${field} = target;
    }`;
}

// Solo getters: el dominio no expone setters (conventions/domain-modeling.md).
// Las colecciones salen como vista inmutable; el alta/baja de hijas la gobiernan
// métodos de negocio de la raíz que escribe el agente.
function renderAccessors(members) {
  const accessors = [];
  for (const { kind, name, javaType, field } of members) {
    const isCollection = kind === 'relationMany' || field?.list;
    const value = isCollection ? `List.copyOf(${name})` : name;
    accessors.push(`    public ${javaType} get${capitalize(name)}() {\n        return ${value};\n    }`);
  }
  return accessors.join('\n\n');
}

export function capitalize(name) {
  return name[0].toUpperCase() + name.slice(1);
}
