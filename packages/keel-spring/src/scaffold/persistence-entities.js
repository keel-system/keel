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
import {
  persistedMembers,
  orderingFieldOf,
  backReferenceTo,
  uniqueFields,
  uniqueConstraints,
  usesAuditableEntity,
  indexName,
  partialUniqueIndexes
} from './persistence-members.js';

export const JPA_PKG = 'infrastructure.persistence.entities';

// La taxonomía de miembros y las utilidades de clave/índice viven en
// persistence-members.js, compartidas con la rama documental. Se reexportan aquí
// porque este módulo era su origen y sigue siendo por donde entran sus consumidores.
export { orderingFieldOf, backReferenceTo, uniqueFields, uniqueConstraints, usesAuditableEntity, indexName, partialUniqueIndexes };
export const jpaMembers = persistedMembers;

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind === 'document') return [];
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
        // Las anotaciones salen RESUELTAS del modelo (persistence-members.js), no
        // compuestas aquí: escrita a mano, la columna se quedaba en el nombre y perdía
        // `nullable`, `length`, `precision/scale` y `columnDefinition` — lo único que
        // llega al DDL. Y el comentario nombra el SUB-campo, no el campo: con Money las
        // dos columnas se anunciaban las dos como "Money.amount aplanado".
        declarations.push(
          [
            `    // ${member.field.javaType}.${sub.voAccessor} aplanado.`,
            ...sub.columns.map((annotation) => `    ${annotation}`),
            `    private ${sub.javaType} ${sub.name};`
          ].join(String.fromCharCode(10))
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
      const joinColumn = `${snakeCase(entity.name)}_id`;
      const collTableAttrs = [`name = "${table}"`, `joinColumns = @JoinColumn(name = "${joinColumn}")`];
      // El índice que el diseño declara sobre esta lista. La columna del ELEMENTO va
      // primero: el filtro es una igualdad sobre el valor («¿a esta dirección le llegó
      // algo?»), y la FK detrás para que el salto a la raíz no vuelva a la tabla.
      const collectionIndexes = collectionIndexesOf(entity, members).byMember.get(member.name) ?? [];
      if (collectionIndexes.length > 0) {
        imports.add('jakarta.persistence.Index');
        const rendered = collectionIndexes
          .map((index) => {
            const unique = index.unique ? ', unique = true' : '';
            return (
              `@Index(name = "${indexName(entity, index)}", ` +
              `columnList = "${quoteIdentifier(snakeCase(member.name))}, ${quoteIdentifier(joinColumn)}"${unique})`
            );
          })
          .join(', ');
        collTableAttrs.push(collectionIndexes.length === 1 ? `indexes = ${rendered}` : `indexes = { ${rendered} }`);
      }
      const collAnnotations = ['@ElementCollection', `@CollectionTable(${collTableAttrs.join(', ')})`];
      const { element } = member;
      if (element.kind === 'vo') {
        // Elemento value object: su espejo @Embeddable XxxJpa (embeddables.js),
        // en este mismo paquete (JPA_PKG): sin import.
      } else if (element.kind === 'enum') {
        imports.add('jakarta.persistence.Enumerated');
        imports.add('jakarta.persistence.EnumType');
        imports.add('jakarta.persistence.Column');
        imports.add(`${subPackage(model, 'domain.enums')}.${element.javaType}`);
        // Las mismas anotaciones que tendría suelto (elementColumns): la columna del
        // elemento vive en la tabla hija, pero sigue siendo una columna.
        collAnnotations.push(...member.field.elementColumns);
      } else {
        // Escalar: columna directa en la tabla de elementos, con las constraints de
        // su value type. Componerla a mano aquí perdía el `length` del tipo, y con él
        // la única cota que llega al DDL de la tabla que crece con cada elemento.
        for (const name of member.field.imports) imports.add(name);
        imports.add('jakarta.persistence.Column');
        collAnnotations.push(...member.field.elementColumns);
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
      // Y el N+1 que ninguna aserción funcional ve: sin lote, recorrer esta colección
      // desde el mapper cuesta UNA consulta POR ELEMENTO de la página. La respuesta es
      // idéntica —por eso no lo caza ningún Then—, solo que un listado de 20 productos
      // hace 20 consultas de más. Con el lote, Hibernate agrupa las cargas pendientes
      // en un WHERE <fk> IN (...).
      //
      // Va en el mapeo además de en la propiedad global porque el tamaño es una decisión
      // POR COLECCIÓN —se elige por encima de cualquier page.size() razonable— y porque
      // aquí se lee junto al modelo, no en un YAML que nadie abre al revisar entidades.
      imports.add('org.hibernate.annotations.BatchSize');
      annotation += '\n    @BatchSize(size = 50)';
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
export function columnsFor(model, entity, members, logicalName, warnings) {
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

/**
 * Índices declarados sobre un campo de COLECCIÓN, agrupados por el miembro al que
 * pertenecen.
 *
 * No caben en el `@Table` de la entidad —una lista vive en su tabla hija, y un
 * `@Index` sobre una columna que esa tabla no tiene rompe el DDL— pero sí en la
 * hija, que la genera build entera: nombre de tabla, columna del elemento y FK a la
 * raíz salen todos de aquí, así que materializarlo es exacto y no hay nada que
 * inventar. Descartarlo con un aviso dejaba el índice declarado sin existir en
 * ninguna parte: ni en la entidad, ni en el appendix de migrations.js (que solo
 * cubre los CONDICIONADOS), y el filtro que el diseño quería acotar recorría entera
 * una tabla que crece con cada elemento.
 *
 * Dos casos se quedan fuera a propósito, y los dos siguen avisando:
 *  - el compuesto que mezcla la lista con columnas del padre: sus columnas no viven
 *    en la misma tabla, así que ningún índice de un motor relacional las cubre;
 *  - el elemento value object: su espejo @Embeddable aporta VARIAS columnas y el
 *    índice, que nombra solo la lista, no dice sobre cuál va.
 */
export function collectionIndexesOf(entity, members) {
  const byMember = new Map();
  const handled = new Set();
  for (const index of entity.indexes ?? []) {
    if (index.when || index.fields.length !== 1) continue;
    const member = members.find((m) => m.kind === 'elementCollection' && m.name === index.fields[0]);
    if (!member || member.element.kind === 'vo') continue;
    byMember.set(member.name, [...(byMember.get(member.name) ?? []), index]);
    handled.add(index);
  }
  return { byMember, handled };
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
  // Los índices CONDICIONADOS no salen por aquí: `@Index` no tiene predicado y
  // ningún JPA lo tiene, así que anotarlos crearía un índice único sobre todas las
  // filas — que es exactamente lo contrario del invariante («como máximo una
  // activa» pasaría a ser «como máximo una, activa o no»). Van al appendix de SQL
  // que escribe migrations.js, que es el único sitio donde el predicado existe.
  // Y tampoco sale por aquí el índice sobre un campo que NO es columna de esta tabla: una lista
  // (`@ElementCollection`) vive en su tabla hija, así que anotarlo en el padre produce un `@Index`
  // sobre una columna inexistente. Compila, y revienta al aplicar el DDL contra el motor — o peor,
  // se cuela en el baseline y hay que corregirlo a mano, que es lo que pasó en una corrida real.
  // El resolutor se usa como sonda: si avisa, es que no supo resolverlo, y ahí no se inventa.
  const { handled: inCollectionTable } = collectionIndexesOf(entity, members);
  const resolves = (index) => {
    // Lo que se materializa en la tabla de elementos no es un índice perdido: sale
    // por el @CollectionTable de su colección, y avisar de él sería pedir que se
    // retire del diseño algo que build sí genera.
    if (inCollectionTable.has(index)) return false;
    const probe = [];
    for (const field of index.fields) columnsFor(model, entity, members, field, probe);
    if (probe.length === 0) return true;
    model.warnings?.push(
      `persistence.entities.${entity.name}: el índice '${index.name ?? index.fields.join('+')}' declara ` +
        `"${index.fields.join(', ')}", que no es columna de '${entity.tableName}' (una lista vive en su tabla ` +
        `hija). NO se anota: un @Index sobre una columna inexistente rompe el DDL. Declara el índice sobre ` +
        `la tabla que de verdad tiene el dato, o retíralo de persistence.keel.yaml.`
    );
    return false;
  };

  const annotatable = entity.indexes.filter((index) => !index.when).filter(resolves);
  if (annotatable.length > 0) {
    imports.add('jakarta.persistence.Index');
    const indexes = annotatable
      .map((index) => {
        // El nombre del índice conserva el nombre lógico del diseño (es su
        // identidad en persistence.keel.yaml); la columnList usa la columna real.
        const columns = index.fields
          .flatMap((f) => columnsFor(model, entity, members, f, model.warnings))
          .map((c) => column(c))
          .join(', ');
        const unique = index.unique ? ', unique = true' : '';
        return `@Index(name = "${indexName(entity, index)}", columnList = "${columns}"${unique})`;
      })
      .join(', ');
    attrs.push(`indexes = { ${indexes} }`);
  }

  return `@Table(${attrs.join(', ')})`;
}
