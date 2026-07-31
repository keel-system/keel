// Entidades JPA separadas del dominio (XxxJpa, patrón del prototipo): viven en
// infrastructure/persistence/entities y solo existen con capa persistence.
// Los value objects compuestos se aplanan a columnas con prefijo; las
// relaciones internas son asociaciones a la Jpa hija; las externas, columna id.
// El mapeo domain↔JPA lo hace el adaptador (repositories.js) con estos mismos
// miembros (jpaMembers) para mantener ambos lados en sincronía.

import { snakeCase } from '../lib/naming.js';
import { quoteIdentifier } from '../lib/sql-reserved.js';
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
          column: quoteIdentifier(`${snakeCase(field.name)}_${snakeCase(sub.name)}`)
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

// Campos por los que una colección hija tiene un orden PROPIO del diseño: un
// número de posición explícito. No es cosmético — cuando el dominio expone
// `position`, el orden es contrato observable (la galería de un producto se
// devuelve en su orden), y una colección `@OneToMany` sin `@OrderBy` la entrega en
// el orden que decida la base de datos. Tras un reorder eso significa que la
// colección en memoria no refleja el orden recién guardado salvo que cada
// adaptador se acuerde de reordenarla al mapear.
const ORDERING_FIELDS = ['position', 'order', 'sortOrder', 'sequence'];
const ORDERING_KINDS = new Set(['int', 'integer', 'long', 'short', 'number', 'decimal']);

/** Campo de orden explícito de la entidad hija, o null si no lo declara. */
export function orderingFieldOf(model, entityName) {
  const child = model.entities.find((e) => e.name === entityName);
  if (!child) return null;
  return (
    child.fields.find(
      (field) =>
        !field.list && ORDERING_FIELDS.includes(field.name) && (!field.base || ORDERING_KINDS.has(field.base))
    ) ?? null
  );
}

// Nombre de la relación con la que `childName` apunta de vuelta a `parentName`
// (back-reference declarada en el diseño), o null si la relación es unidireccional.
// Es el mappedBy del @OneToMany del padre y el setter que el mapeo debe rellenar.
export function backReferenceTo(model, childName, parentName) {
  const child = model.entities.find((e) => e.name === childName);
  return child?.relations.find((rel) => rel.backReference && rel.entity === parentName)?.name ?? null;
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

// AuditableEntity solo existe si algún eje de persistence.audit vale 'all': es la
// política que pone columnas que el dominio no nombra. Con 'declared' los campos
// son del diseño y se anotan en su propia Jpa; con 'none' no hay nada que heredar.
export function usesAuditableEntity(model) {
  return model.audit?.timestamps === 'all' || model.audit?.authorship === 'all';
}

export function generate(model) {
  if (!model.layersPresent.persistence) return [];
  return [
    ...(usesAuditableEntity(model) ? [renderAuditableEntity(model)] : []),
    ...model.entities.filter((entity) => entity.persisted).map((entity) => renderJpaEntity(model, entity))
  ];
}

// Base de auditoría (portada del shared del prototipo): las columnas que el diseño
// delega en la política vía Spring Data JPA auditing (@EnableJpaAuditing en la
// Application). Soft-delete queda como decisión del agente (el DSL no lo declara).
function renderAuditableEntity(model) {
  const timestamps = model.audit?.timestamps === 'all';
  const authorship = model.audit?.authorship === 'all';
  const imports = [
    'jakarta.persistence.Column',
    'jakarta.persistence.EntityListeners',
    'jakarta.persistence.MappedSuperclass',
    'org.springframework.data.jpa.domain.support.AuditingEntityListener'
  ];
  const members = [];
  const accessors = [];
  if (timestamps) {
    imports.push('java.time.Instant', 'org.springframework.data.annotation.CreatedDate', 'org.springframework.data.annotation.LastModifiedDate');
    members.push(
      `    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;`,
      `    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;`
    );
    accessors.push(
      `    public Instant getCreatedAt() {
        return createdAt;
    }`,
      `    public Instant getUpdatedAt() {
        return updatedAt;
    }`
    );
  }
  if (authorship) {
    imports.push('org.springframework.data.annotation.CreatedBy', 'org.springframework.data.annotation.LastModifiedBy');
    members.push(
      `    @CreatedBy
    @Column(name = "created_by", nullable = false, updatable = false)
    private String createdBy;`,
      `    @LastModifiedBy
    @Column(name = "updated_by", nullable = false)
    private String updatedBy;`
    );
    accessors.push(
      `    public String getCreatedBy() {
        return createdBy;
    }`,
      `    public String getUpdatedBy() {
        return updatedBy;
    }`
    );
  }

  const registers = [timestamps ? 'cuándo' : null, authorship ? 'quién' : null].filter(Boolean).join(' y ');
  const body = `/**
 * Base de las entidades JPA auditables: registra ${registers} vía Spring Data JPA
 * auditing, sin que el dominio nombre estas columnas (persistence.audit).
 */
@MappedSuperclass
@EntityListeners(AuditingEntityListener.class)
public abstract class AuditableEntity {

${[...members, ...accessors].join('\n\n')}
}`;

  return {
    path: javaPath(model, JPA_PKG, 'AuditableEntity'),
    content: javaFile(subPackage(model, JPA_PKG), imports.sort(), body)
  };
}

function renderJpaEntity(model, entity) {
  const imports = new Set(['jakarta.persistence.Entity', 'jakarta.persistence.Table']);
  const members = jpaMembers(model, entity);
  const declarations = [];
  const accessors = [];

  // Auditoría: la política decide dónde vive cada columna. Con 'all' la hereda de
  // AuditableEntity y el dominio ni la nombra; con 'declared' el campo ES del
  // dominio y aquí solo se anota para que el listener lo pueble.
  const inheritsAuditable = entity.auditTimestamps === 'all' || entity.auditAuthorship === 'all';
  const declaredAudit = new Map();
  if (entity.auditTimestamps === 'declared') {
    declaredAudit.set('createdAt', 'CreatedDate').set('updatedAt', 'LastModifiedDate');
  }
  if (entity.auditAuthorship === 'declared') {
    declaredAudit.set('createdBy', 'CreatedBy').set('updatedBy', 'LastModifiedBy');
  }

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
      // Caso borde: el diseño declara un campo llamado lockVersion, el nombre que
      // build reserva para el @Version. Se anota el declarado en vez de generar un
      // segundo campo (ver el aviso de model.js).
      if (entity.declaresLockVersion && entity.usesOptimisticLocking && field.name === 'lockVersion') {
        imports.add('jakarta.persistence.Version');
        lines.push('    @Version');
      }
      // Campos de auditoría que el diseño declara ('declared'): los puebla el
      // AuditingEntityListener del @EntityListeners de la clase, con el actor que
      // resuelve AuditorAwareConfig en el caso de la autoría.
      const auditAnnotation = declaredAudit.get(field.name);
      if (auditAnnotation) {
        imports.add(`org.springframework.data.annotation.${auditAnnotation}`);
        lines.push(`    @${auditAnnotation}`);
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
        `    @Column(name = "${quoteIdentifier(`${snakeCase(member.relation.name)}_id`)}"${nullable})\n    private UUID ${member.name};`
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
        const inverse = backReferenceTo(model, member.relation.entity, entity.name);
        if (inverse) {
          // Bidireccional: la hija es dueña de la FK (@ManyToOne). Con mappedBy la
          // columna se mapea una sola vez; con @JoinColumn quedaría mapeada dos veces.
          annotation = `@OneToMany(mappedBy = "${inverse}", cascade = CascadeType.ALL, orphanRemoval = true)`;
        } else {
          imports.add('jakarta.persistence.JoinColumn');
          // FK en la tabla hija (unidireccional CON @JoinColumn: sin join table).
          annotation = `@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)\n    @JoinColumn(name = "${snakeCase(entity.name)}_id")`;
        }
      }
      // Orden declarado por el diseño: lo aplica la propia consulta, no el mapeo.
      const ordering = orderingFieldOf(model, member.relation.entity);
      if (ordering) {
        imports.add('jakarta.persistence.OrderBy');
        annotation += `\n    @OrderBy("${ordering.name} ASC")`;
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
      const joinColumn = `\n    @JoinColumn(name = "${quoteIdentifier(`${snakeCase(member.relation.name)}_id`)}"${joinNullable})`;
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

  // Concurrencia optimista: solo la raíz de agregado porta lockVersion (es la
  // frontera de consistencia), y solo si la política del diseño lo pide
  // (persistence.consistency.optimisticLocking; ver locksEntity en model.js).
  // Con 'none' no se genera: el diseño ha declarado "último escritor gana" y una
  // escritura concurrente no debe producir conflicto.
  // La gestiona Hibernate, que la comprueba e incrementa en cada flush; una
  // escritura sobre una versión obsoleta lanza OptimisticLockException (la
  // traduce el ApiExceptionHandler).
  // Es infraestructura pura y nunca sale al contrato: un `version` que el diseño
  // declare es otra cosa (contador de dominio, campo escalar corriente) y convive
  // con este en la misma tabla.
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    imports.add('jakarta.persistence.Column');
    imports.add('jakarta.persistence.Version');
    declarations.push('    @Version\n    @Column(name = "lock_version")\n    private Long lockVersion;');
    pushAccessor('lockVersion', 'Long');
  }

  const header = ['@Entity'];
  if (!inheritsAuditable && declaredAudit.size > 0) {
    // Auditoría sobre campos declarados por el diseño: la entidad no hereda
    // AuditableEntity (sus columnas son miembros propios) pero sí necesita el
    // listener que las puebla.
    imports.add('jakarta.persistence.EntityListeners');
    imports.add('org.springframework.data.jpa.domain.support.AuditingEntityListener');
    header.push('@EntityListeners(AuditingEntityListener.class)');
  }
  header.push(renderTableAnnotation(model, entity, members, imports));
  const body = `${header.join('\n')}
public class ${entity.name}Jpa${inheritsAuditable ? ' extends AuditableEntity' : ''} {

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

/**
 * Nombre real de columna de un nombre lógico del diseño (campo, relación o
 * value object). Sin esto, un índice declarado sobre la relación `parent`
 * generaría columnList="parent" cuando la columna es `parent_id`: Hibernate no
 * puede crear el índice y el arranque lo reporta sin romper nada — un fallo de
 * rendimiento silencioso.
 *
 * Una relación se admite por su nombre (`product`) o con el sufijo del id
 * (`productId`), indistintamente: cuál de los dos nombra al miembro Java depende
 * de si la relación cruza frontera de agregado (externalRef vs. relationOne), y
 * esa es una decisión del generador que el diseño no tiene por qué conocer.
 */
function columnsFor(model, entity, members, logicalName, warnings) {
  const [head, ...rest] = String(logicalName).split('.');
  const member = members.find(
    (m) => m.name === head || m.relation?.name === head || (m.relation && `${m.relation.name}Id` === head)
  );

  if (member?.kind === 'scalar') return [snakeCase(member.name)];
  if (member?.kind === 'externalRef' || member?.kind === 'relationOne') {
    return [`${snakeCase(member.relation.name)}_id`];
  }
  if (member?.kind === 'vo') {
    // vo.sub → una columna; el vo entero → todas sus columnas aplanadas.
    if (rest.length > 0) {
      const sub = member.subs.find((s) => s.voAccessor === rest[0]);
      if (sub) return [sub.column.replace(/`/g, '')];
    } else if (member.subs.length > 0) {
      return member.subs.map((sub) => sub.column.replace(/`/g, ''));
    }
  }

  warnings?.push(
    `persistence.entities.${entity.name}: el índice declara "${logicalName}", que no es un campo ni una relación de la entidad; se usa "${snakeCase(head)}" tal cual y el índice puede no crearse.`
  );
  return [snakeCase(head)];
}

function renderTableAnnotation(model, entity, members, imports) {
  const attrs = [`name = "${quoteIdentifier(entity.tableName)}"`];
  const uniqueConstraints = [];
  const column = (name) => quoteIdentifier(name);

  if (entity.naturalKey && entity.naturalKey.length > 0) {
    const columns = entity.naturalKey
      .flatMap((f) => columnsFor(model, entity, members, f, model.warnings))
      .map((c) => `"${column(c)}"`)
      .join(', ');
    uniqueConstraints.push(`@UniqueConstraint(name = "uk_${entity.tableName}_natural", columnNames = { ${columns} })`);
  }

  // Un campo unique del diseño es una garantía, no una expectativa: la
  // comprobación previa en el handler produce el error de negocio en el caso
  // normal, pero solo la constraint impide que dos peticiones simultáneas la
  // sorteen. Su violación la traduce al mismo error el ApiExceptionHandler.
  for (const field of uniqueFields(entity)) {
    uniqueConstraints.push(
      `@UniqueConstraint(name = "uk_${entity.tableName}_${snakeCase(field.name)}", columnNames = { "${column(snakeCase(field.name))}" })`
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
        // El nombre del índice conserva el nombre lógico del diseño (es su
        // identidad en persistence.keel.yaml); la columnList usa la columna real.
        const suffix = fields.map((f) => snakeCase(f.replace('.', '_'))).join('_');
        const columns = fields
          .flatMap((f) => columnsFor(model, entity, members, f, model.warnings))
          .map((c) => column(c))
          .join(', ');
        return `@Index(name = "idx_${entity.tableName}_${suffix}", columnList = "${columns}")`;
      })
      .join(', ');
    attrs.push(`indexes = { ${indexes} }`);
  }

  return `@Table(${attrs.join(', ')})`;
}
