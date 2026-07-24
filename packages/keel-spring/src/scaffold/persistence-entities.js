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
    if (field.list) {
      // Colección de valores sin identidad (DSL 2.1 list): tabla de elementos
      // (@ElementCollection). El elemento es escalar/enum (columna directa) o un
      // value object (su espejo @Embeddable XxxJpa, generado por embeddables.js).
      members.push({
        kind: 'elementCollection',
        field,
        name: field.name,
        element: field.kind === 'composite' ? { kind: 'vo', javaType: `${field.elementJavaType}Jpa` } : { kind: field.kind, javaType: field.elementJavaType }
      });
    } else if (field.kind === 'composite') {
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

// Campos que llevan constraint única propia: los unique del diseño, salvo el id
// (ya es clave primaria), los value objects compuestos (no son una sola columna)
// y los que la clave natural ya cubre por sí sola.
export function uniqueFields(entity) {
  const naturalKeyAlone = entity.naturalKey?.length === 1 ? entity.naturalKey[0] : null;
  return entity.fields.filter(
    (field) => field.unique && !field.isId && field.kind !== 'composite' && field.name !== naturalKeyAlone
  );
}

// Nombre de constraint → entidad y campo que la originan. Lo consume el
// ApiExceptionHandler para traducir una violación de integridad al error
// declarado del diseño en vez de a un 409 genérico.
export function uniqueConstraints(model) {
  const entries = [];
  for (const entity of model.entities.filter((e) => e.persisted)) {
    if (entity.naturalKey?.length > 0) {
      entries.push({
        constraint: `uk_${entity.tableName}_natural`,
        entity: entity.name,
        fields: entity.naturalKey
      });
    }
    for (const field of uniqueFields(entity)) {
      entries.push({
        constraint: `uk_${entity.tableName}_${snakeCase(field.name)}`,
        entity: entity.name,
        fields: [field.name]
      });
    }
  }
  return entries;
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

  // Auditoría automática, salvo que el diseño ya declare sus propios timestamps:
  // en ese caso no se hereda AuditableEntity (evita campos duplicados) pero los
  // campos declarados se anotan igualmente como managed (ver bucle scalar).
  const audited = !entity.fields.some((field) => field.name === 'createdAt' || field.name === 'updatedAt');

  // Autoría declarada por el diseño (createdBy/updatedBy): build anota los campos,
  // pero quien los puebla es un AuditorAware que solo el agente puede escribir (de
  // dónde sale el actor depende del diseño). El TODO se emite una vez por entidad.
  let pendingAuditorTodo = entity.fields.some((field) => field.name === 'createdBy' || field.name === 'updatedBy');

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
      // Timestamps de auditoría declarados por el diseño: se auto-pueblan vía el
      // AuditingEntityListener del @EntityListeners de la clase (no se pierden).
      if (!audited && field.name === 'createdAt') {
        imports.add('org.springframework.data.annotation.CreatedDate');
        lines.push('    @CreatedDate');
      }
      if (!audited && field.name === 'updatedAt') {
        imports.add('org.springframework.data.annotation.LastModifiedDate');
        lines.push('    @LastModifiedDate');
      }
      // Autoría: la puebla el mismo AuditingEntityListener (heredado de
      // AuditableEntity o puesto en la clase), pero solo si hay un AuditorAware
      // registrado; sin él estas columnas quedarían a null en silencio.
      if (field.name === 'createdBy' || field.name === 'updatedBy') {
        if (pendingAuditorTodo) {
          lines.push(
            '    // TODO (agente): provee un AuditorAware<String> (el actor del SecurityContext, o el',
            '    // correlation id si no hay usuario) y regístralo con @EnableJpaAuditing(auditorAwareRef = "...")',
            '    // en la clase Application — ver la skill keel-spring-database.'
          );
          pendingAuditorTodo = false;
        }
        const annotation = field.name === 'createdBy' ? 'CreatedBy' : 'LastModifiedBy';
        imports.add(`org.springframework.data.annotation.${annotation}`);
        lines.push(`    @${annotation}`);
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
        // Value object anidado (sub compuesto): no se puede aplanar a una columna;
        // lo completa el agente (@Embedded o columnas) — ver skill keel-spring-database.
        if (sub.subKind === 'composite') {
          declarations.push(
            `    // TODO (agente): ${member.field.javaType}.${sub.voAccessor} es un value object anidado; mapéalo con @Embedded o columnas (ver skill keel-spring-database).`
          );
          continue;
        }
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
    } else if (member.kind === 'elementCollection') {
      // Tabla de elementos: <entidad>_<campo>, FK <entidad>_id a la raíz.
      imports.add('jakarta.persistence.ElementCollection');
      imports.add('jakarta.persistence.CollectionTable');
      imports.add('jakarta.persistence.JoinColumn');
      imports.add('java.util.List');
      imports.add('java.util.ArrayList');
      const table = `${snakeCase(entity.name)}_${snakeCase(member.name)}`;
      const collAnnotations = [
        '@ElementCollection',
        `@CollectionTable(name = "${table}", joinColumns = @JoinColumn(name = "${snakeCase(entity.name)}_id"))`
      ];
      const { element } = member;
      if (element.kind === 'vo') {
        // Elemento value object: su espejo @Embeddable XxxJpa (embeddables.js),
        // en este mismo paquete (JPA_PKG): sin import.
      } else if (element.kind === 'enum') {
        imports.add('jakarta.persistence.Enumerated');
        imports.add('jakarta.persistence.EnumType');
        imports.add('jakarta.persistence.Column');
        imports.add(`${subPackage(model, 'domain.enums')}.${element.javaType}`);
        collAnnotations.push('@Enumerated(EnumType.STRING)');
        collAnnotations.push(`@Column(name = "${snakeCase(member.name)}")`);
      } else {
        // Escalar: columna directa en la tabla de elementos.
        for (const name of member.field.imports) imports.add(name);
        imports.add('jakarta.persistence.Column');
        collAnnotations.push(`@Column(name = "${snakeCase(member.name)}")`);
      }
      declarations.push(
        `    ${collAnnotations.join('\n    ')}\n    private List<${element.javaType}> ${member.name} = new ArrayList<>();`
      );
      pushAccessor(member.name, `List<${element.javaType}>`);
    } else if (member.kind === 'relationMany') {
      const childJpa = `${member.relation.entity}Jpa`;
      let annotation;
      if (member.relation.cardinality === 'many-to-many') {
        imports.add('jakarta.persistence.ManyToMany');
        annotation = '@ManyToMany';
      } else {
        imports.add('jakarta.persistence.OneToMany');
        imports.add('jakarta.persistence.CascadeType');
        imports.add('jakarta.persistence.JoinColumn');
        // FK en la tabla hija (unidireccional CON @JoinColumn: sin join table).
        annotation = `@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)\n    @JoinColumn(name = "${snakeCase(entity.name)}_id")`;
      }
      imports.add('java.util.List');
      imports.add('java.util.ArrayList');
      declarations.push(`    ${annotation}\n    private List<${childJpa}> ${member.name} = new ArrayList<>();`);
      pushAccessor(member.name, `List<${childJpa}>`);
    } else {
      const childJpa = `${member.relation.entity}Jpa`;
      const optional = member.relation.required ? 'false' : 'true';
      // FK en esta tabla (lado dueño): columna <relación>_id.
      imports.add('jakarta.persistence.JoinColumn');
      const joinNullable = member.relation.required ? ', nullable = false' : '';
      const joinColumn = `\n    @JoinColumn(name = "${snakeCase(member.relation.name)}_id"${joinNullable})`;
      let annotation;
      if (member.relation.cardinality === 'many-to-one') {
        imports.add('jakarta.persistence.ManyToOne');
        annotation = `@ManyToOne(optional = ${optional})${joinColumn}`;
      } else {
        imports.add('jakarta.persistence.OneToOne');
        imports.add('jakarta.persistence.CascadeType');
        annotation = `@OneToOne(cascade = CascadeType.ALL, orphanRemoval = true, optional = ${optional})${joinColumn}`;
      }
      declarations.push(`    ${annotation}\n    private ${childJpa} ${member.name};`);
      pushAccessor(member.name, childJpa);
    }
  }

  // Concurrencia optimista: solo la raíz de agregado porta la versión (es la
  // frontera de consistencia). La gestiona Hibernate, que la comprueba e
  // incrementa en cada flush; una escritura sobre una versión obsoleta lanza
  // OptimisticLockException (la traduce el ApiExceptionHandler).
  if (entity.isAggregateRoot) {
    imports.add('jakarta.persistence.Column');
    imports.add('jakarta.persistence.Version');
    declarations.push('    @Version\n    @Column(name = "version")\n    private Long version;');
    pushAccessor('version', 'Long');
  }

  const header = ['@Entity'];
  if (!audited) {
    // Auditoría sobre timestamps declarados por el diseño: la entidad no hereda
    // AuditableEntity pero sí escucha el listener que puebla @CreatedDate/@LastModifiedDate.
    imports.add('jakarta.persistence.EntityListeners');
    imports.add('org.springframework.data.jpa.domain.support.AuditingEntityListener');
    header.push('@EntityListeners(AuditingEntityListener.class)');
  }
  header.push(renderTableAnnotation(entity, imports));
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
  const uniqueConstraints = [];

  if (entity.naturalKey && entity.naturalKey.length > 0) {
    const columns = entity.naturalKey.map((f) => `"${snakeCase(f)}"`).join(', ');
    uniqueConstraints.push(`@UniqueConstraint(name = "uk_${entity.tableName}_natural", columnNames = { ${columns} })`);
  }

  // Un campo unique del diseño es una garantía, no una expectativa: la
  // comprobación previa en el handler produce el error de negocio en el caso
  // normal, pero solo la constraint impide que dos peticiones simultáneas la
  // sorteen. Su violación la traduce al mismo error el ApiExceptionHandler.
  for (const field of uniqueFields(entity)) {
    uniqueConstraints.push(
      `@UniqueConstraint(name = "uk_${entity.tableName}_${snakeCase(field.name)}", columnNames = { "${snakeCase(field.name)}" })`
    );
  }

  if (uniqueConstraints.length > 0) {
    imports.add('jakarta.persistence.UniqueConstraint');
    attrs.push(
      uniqueConstraints.length === 1
        ? `uniqueConstraints = ${uniqueConstraints[0]}`
        : `uniqueConstraints = {\n        ${uniqueConstraints.join(',\n        ')}\n}`
    );
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
