// Entidades JPA separadas del dominio (XxxJpa, patrón del prototipo): viven en
// infrastructure/persistence/entities y solo existen con capa persistence.
// Los value objects compuestos se aplanan a columnas con prefijo; las
// relaciones internas son asociaciones a la Jpa hija; las externas, columna id.
// El mapeo domain↔JPA lo hace el adaptador (repositories.js) con estos mismos
// miembros (jpaMembers) para mantener ambos lados en sincronía.

import { snakeCase } from '../lib/naming.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { capitalize } from './entities.js';

export const JPA_PKG = 'infrastructure.persistence.entities';

// Miembros de la entidad JPA, alineados con domainMembers() del dominio:
// - scalar: campo directo (incluye enums)
// - vo: value object aplanado en subs[]
// - externalRef: UUID <relación>Id
// - relationOne / relationMany: asociación a la Jpa hija
export function jpaMembers(model, entity) {
  const members = [];
  for (const field of entity.fields) {
    if (field.kind === 'composite') {
      const vo = model.valueObjects.find((v) => v.name === field.javaType);
      members.push({
        kind: 'vo',
        field,
        vo,
        name: field.name,
        subs: (vo?.fields ?? []).map((sub) => ({
          name: `${field.name}${capitalize(sub.name)}`,
          voAccessor: sub.name,
          javaType: sub.javaType,
          imports: sub.imports,
          subKind: sub.kind,
          column: `${snakeCase(field.name)}_${snakeCase(sub.name)}`
        }))
      });
    } else {
      members.push({ kind: 'scalar', field, name: field.name, javaType: field.javaType });
    }
  }
  for (const relation of entity.relations) {
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal) {
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, javaType: 'UUID' });
    } else {
      members.push({ kind: toMany ? 'relationMany' : 'relationOne', relation, name: relation.name });
    }
  }
  return members;
}

export function generate(model) {
  if (!model.layersPresent.persistence) return [];
  return [
    renderAuditableEntity(model),
    ...model.entities.filter((entity) => entity.persisted).map((entity) => renderJpaEntity(model, entity))
  ];
}

// Base de auditoría (portada del shared del prototipo): createdAt/updatedAt
// automáticos vía Spring Data JPA auditing (@EnableJpaAuditing en la
// Application). Soft-delete queda como decisión del agente (el DSL no lo declara).
function renderAuditableEntity(model) {
  const body = `/**
 * Base de las entidades JPA auditables: createdAt/updatedAt automáticos vía
 * Spring Data JPA auditing. Timestamps en Instant (UTC).
 */
@MappedSuperclass
@EntityListeners(AuditingEntityListener.class)
public abstract class AuditableEntity {

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}`;

  return {
    path: javaPath(model, JPA_PKG, 'AuditableEntity'),
    content: javaFile(
      subPackage(model, JPA_PKG),
      [
        'jakarta.persistence.Column',
        'jakarta.persistence.EntityListeners',
        'jakarta.persistence.MappedSuperclass',
        'java.time.Instant',
        'org.springframework.data.annotation.CreatedDate',
        'org.springframework.data.annotation.LastModifiedDate',
        'org.springframework.data.jpa.domain.support.AuditingEntityListener'
      ],
      body
    )
  };
}

function renderJpaEntity(model, entity) {
  const imports = new Set(['jakarta.persistence.Entity', 'jakarta.persistence.Table']);
  const members = jpaMembers(model, entity);
  const declarations = [];
  const accessors = [];

  for (const member of members) {
    if (member.kind === 'scalar') {
      const { field } = member;
      for (const name of field.imports) imports.add(name);
      if (field.kind === 'enum') imports.add(`${subPackage(model, 'domain.enums')}.${field.javaType}`);
      const lines = [];
      if (field.isId) {
        imports.add('jakarta.persistence.Id');
        lines.push('    @Id');
      }
      for (const annotation of field.columns) {
        if (annotation.startsWith('@Enumerated')) {
          imports.add('jakarta.persistence.Enumerated');
          imports.add('jakarta.persistence.EnumType');
        } else {
          imports.add('jakarta.persistence.Column');
        }
        lines.push(`    ${annotation}`);
      }
      lines.push(`    private ${field.javaType} ${field.name};`);
      declarations.push(lines.join('\n'));
      pushAccessor(member.name, field.javaType);
    } else if (member.kind === 'vo') {
      if (member.subs.length === 0) {
        declarations.push(`    // TODO (agente): mapear el value object ${member.field.javaType} a columnas.`);
        continue;
      }
      for (const sub of member.subs) {
        for (const name of sub.imports) imports.add(name);
        if (sub.subKind === 'enum') imports.add(`${subPackage(model, 'domain.enums')}.${sub.javaType}`);
        imports.add('jakarta.persistence.Column');
        declarations.push(
          `    // ${member.field.javaType}.${member.field.name} aplanado.\n    @Column(name = "${sub.column}")\n    private ${sub.javaType} ${sub.name};`
        );
        pushAccessor(sub.name, sub.javaType);
      }
    } else if (member.kind === 'externalRef') {
      imports.add('jakarta.persistence.Column');
      imports.add('java.util.UUID');
      const nullable = member.relation.required ? ', nullable = false' : '';
      declarations.push(
        `    @Column(name = "${snakeCase(member.relation.name)}_id"${nullable})\n    private UUID ${member.name};`
      );
      pushAccessor(member.name, 'UUID');
    } else if (member.kind === 'relationMany') {
      const childJpa = `${member.relation.entity}Jpa`;
      const annotation =
        member.relation.cardinality === 'many-to-many'
          ? '@ManyToMany'
          : '@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)';
      if (member.relation.cardinality === 'many-to-many') {
        imports.add('jakarta.persistence.ManyToMany');
      } else {
        imports.add('jakarta.persistence.OneToMany');
        imports.add('jakarta.persistence.CascadeType');
      }
      imports.add('java.util.List');
      imports.add('java.util.ArrayList');
      declarations.push(`    ${annotation}\n    private List<${childJpa}> ${member.name} = new ArrayList<>();`);
      pushAccessor(member.name, `List<${childJpa}>`);
    } else {
      const childJpa = `${member.relation.entity}Jpa`;
      const optional = member.relation.required ? 'false' : 'true';
      let annotation;
      if (member.relation.cardinality === 'many-to-one') {
        imports.add('jakarta.persistence.ManyToOne');
        annotation = `@ManyToOne(optional = ${optional})`;
      } else {
        imports.add('jakarta.persistence.OneToOne');
        imports.add('jakarta.persistence.CascadeType');
        annotation = `@OneToOne(cascade = CascadeType.ALL, orphanRemoval = true, optional = ${optional})`;
      }
      declarations.push(`    ${annotation}\n    private ${childJpa} ${member.name};`);
      pushAccessor(member.name, childJpa);
    }
  }

  // Auditoría automática, salvo que el diseño ya declare sus propios timestamps.
  const audited = !entity.fields.some((field) => field.name === 'createdAt' || field.name === 'updatedAt');
  const header = ['@Entity', renderTableAnnotation(entity, imports)];
  const body = `${header.join('\n')}
public class ${entity.name}Jpa${audited ? ' extends AuditableEntity' : ''} {

${declarations.join('\n\n')}

${accessors.join('\n\n')}
}`;

  return {
    path: javaPath(model, JPA_PKG, `${entity.name}Jpa`),
    content: javaFile(subPackage(model, JPA_PKG), [...imports], body)
  };

  function pushAccessor(name, javaType) {
    accessors.push(
      `    public ${javaType} get${capitalize(name)}() {\n        return ${name};\n    }`,
      `    public void set${capitalize(name)}(${javaType} ${name}) {\n        this.${name} = ${name};\n    }`
    );
  }
}

function renderTableAnnotation(entity, imports) {
  const attrs = [`name = "${entity.tableName}"`];

  if (entity.naturalKey && entity.naturalKey.length > 0) {
    imports.add('jakarta.persistence.UniqueConstraint');
    const columns = entity.naturalKey.map((f) => `"${snakeCase(f)}"`).join(', ');
    attrs.push(`uniqueConstraints = @UniqueConstraint(name = "uk_${entity.tableName}_natural", columnNames = { ${columns} })`);
  }
  if (entity.indexes.length > 0) {
    imports.add('jakarta.persistence.Index');
    const indexes = entity.indexes
      .map((fields) => {
        const suffix = fields.map((f) => snakeCase(f)).join('_');
        return `@Index(name = "idx_${entity.tableName}_${suffix}", columnList = "${fields.map((f) => snakeCase(f)).join(', ')}")`;
      })
      .join(', ');
    attrs.push(`indexes = { ${indexes} }`);
  }

  return `@Table(${attrs.join(', ')})`;
}
