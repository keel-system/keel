// Entidades de dominio PURAS (sin JPA, patrón del prototipo de referencia):
// raíces de agregado en domain/aggregate, entidades internas en domain/entity.
// Constructor completo (reconstrucción desde persistencia) + getters/setters,
// guard genérico de lifecycle (transitionTo) y TODO de invariantes. La
// persistencia vive aparte en infrastructure/persistence (XxxJpa + adaptador).

import { javaFile, javaPath, subPackage, javadoc } from './render.js';

// Subpaquete de una entidad de dominio según su rol en el agregado.
export function domainSubPackage(entity) {
  return entity.isAggregateRoot ? 'domain.aggregate' : 'domain.entity';
}

// Import del tipo de dominio de un campo resuelto (enum/VO), si aplica.
export function domainTypeImport(model, field) {
  if (field.kind === 'enum') return `${subPackage(model, 'domain.enums')}.${field.javaType}`;
  if (field.kind === 'composite') return `${subPackage(model, 'domain.valueobject')}.${field.javaType}`;
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
    javaType: field.javaType,
    readOnly: field.isId || field.name === (entity.lifecycle?.field ?? null)
  }));

  for (const relation of entity.relations) {
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal && model.layersPresent.persistence) {
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, javaType: 'UUID', readOnly: false });
    } else {
      members.push({
        kind: toMany ? 'relationMany' : 'relationOne',
        relation,
        name: relation.name,
        javaType: toMany ? `List<${relation.entity}>` : relation.entity,
        readOnly: toMany
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
      const init = field.initializer ? ` = ${field.initializer}` : '';
      lines.push(`    private ${field.javaType} ${field.name}${init};`);
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
    header.push(`// TODO invariante (proteger en dominio + test): ${invariant}`);
  }

  const bodyParts = [declarations.join('\n\n')];

  bodyParts.push(`    public ${entity.name}() {\n    }`);
  if (members.length > 0) {
    const ctorParams = members.map((m) => `${m.javaType} ${m.name}`).join(', ');
    const ctorAssigns = members.map((m) => `        this.${m.name} = ${m.name};`).join('\n');
    bodyParts.push(`    // Constructor completo: reconstrucción desde persistencia.
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

  return `    // Transiciones válidas del lifecycle del diseño; un estado con Set.of() es terminal.
    private static final Map<${enumType}, Set<${enumType}>> TRANSITIONS = Map.of(
${entries}
    );

    public void transitionTo(${enumType} target) {
        if (!TRANSITIONS.getOrDefault(${field}, Set.of()).contains(target)) {
            throw new InvalidStateTransitionException(${field}.name(), target.name());
        }
        this.${field} = target;
    }`;
}

function renderAccessors(members) {
  const accessors = [];
  for (const { name, javaType, readOnly } of members) {
    accessors.push(`    public ${javaType} get${capitalize(name)}() {\n        return ${name};\n    }`);
    if (!readOnly) {
      accessors.push(`    public void set${capitalize(name)}(${javaType} ${name}) {\n        this.${name} = ${name};\n    }`);
    }
  }
  return accessors.join('\n\n');
}

export function capitalize(name) {
  return name[0].toUpperCase() + name.slice(1);
}
