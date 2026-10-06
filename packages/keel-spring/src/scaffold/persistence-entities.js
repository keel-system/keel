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
  partialUniqueIndexes,
  foreignKeyName,
  crossAggregateForeignKeys
} from './persistence-members.js';
import {
  collectionBatchSize,
  columnsFor,
  collectionIndexesOf,
  foreignKeyIndexName,
  foreignKeyIndexColumns as neutralForeignKeyIndexColumns,
  tableOf
} from 'keel-core/gen/relational';

export const JPA_PKG = 'infrastructure.persistence.entities';

// La taxonomía de miembros y las utilidades de clave/índice viven en
// persistence-members.js, compartidas con la rama documental. Se reexportan aquí
// porque este módulo era su origen y sigue siendo por donde entran sus consumidores.
export { orderingFieldOf, backReferenceTo, uniqueFields, uniqueConstraints, usesAuditableEntity, indexName, partialUniqueIndexes, foreignKeyName };
export const jpaMembers = persistedMembers;

// El tamaño del lote, la columna real de un nombre lógico, los índices de una lista y las FK que se
// indexan son lectura del diseño (keel-core/gen/relational.js): keel-nest los escribe igual.
export { collectionBatchSize, columnsFor, collectionIndexesOf, foreignKeyIndexName };

/** Las columnas FK de esta tabla que llevan índice propio; ver keel-core/gen/relational.js. */
export function foreignKeyIndexColumns(model, entity, members = jpaMembers(model, entity)) {
  return neutralForeignKeyIndexColumns(model, entity, members);
}

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
      if (member.folded) {
        const shadow = member.folded;
        imports.add('jakarta.persistence.Column');
        const attrs = [`name = "${shadow.column}"`];
        if (shadow.required) attrs.push('nullable = false');
        if (shadow.maxLength != null) attrs.push(`length = ${shadow.maxLength}`);
        declarations.push(
          [
            `    // ${field.name} plegado (compare: ${field.compare}): lo estampa el adaptador con TextFold al guardar.`,
            `    @Column(${attrs.join(', ')})`,
            `    private String ${shadow.name};`
          ].join('\n')
        );
        pushAccessor(shadow.name, 'String');
      }
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
      imports.add('jakarta.persistence.ForeignKey');
      // El nombre de la FK, explícito: ver foreignKeyName (persistence-members.js).
      const collFk = foreignKeyName(table, entity.name);
      const collTableAttrs = [
        `name = "${table}"`,
        `joinColumns = @JoinColumn(name = "${joinColumn}", foreignKey = @ForeignKey(name = "${collFk}"))`
      ];
      // El índice que el diseño declara sobre esta lista. La columna del ELEMENTO va
      // primero: el filtro es una igualdad sobre el valor («¿a esta dirección le llegó
      // algo?»), y la FK detrás para que el salto a la raíz no vuelva a la tabla.
      const collectionIndexes = collectionIndexesOf(entity, members).byMember.get(member.name) ?? [];
      imports.add('jakarta.persistence.Index');
      const rendered = collectionIndexes.map((index) => {
        const unique = index.unique ? ', unique = true' : '';
        return (
          `@Index(name = "${indexName(entity, index)}", ` +
          `columnList = "${quoteIdentifier(snakeCase(member.name))}, ${quoteIdentifier(joinColumn)}"${unique})`
        );
      });
      // Y el de la FK a la raíz, SIEMPRE: cargar la lista de una raíz es un WHERE sobre esta
      // columna. La PK de la tabla no basta, y el motivo es sutil: Hibernate (Boot 3.5.3) la
      // escribe en ORDEN DISTINTO según la vía — `ddl-auto: update` crea
      // `(<entidad>_id, <campo>_order)`, con la raíz delante, pero el exportador que produce el V1
      // de producción escribe `(<campo>_order, <entidad>_id)`, con el ORDEN delante. Medido sobre
      // notification-mailer el 2026-10-05. O sea que en local la FK parece cubierta y en
      // producción no lo está, y mapping-check —que corre con `update`— no puede verlo: la única
      // red de esta mitad es el test de cadenas (fk-index.test.js).
      rendered.push(`@Index(name = "${foreignKeyIndexName(table, joinColumn)}", columnList = "${quoteIdentifier(joinColumn)}")`);
      collTableAttrs.push(rendered.length === 1 ? `indexes = ${rendered[0]}` : `indexes = { ${rendered.join(', ')} }`);
      // El ORDEN es parte del valor: el dominio la modela como `List`, y sin columna de orden
      // Hibernate la trata como una bolsa —ni el SELECT promete el orden en que se guardó, ni
      // una modificación hace otra cosa que borrar y reinsertar todo—. El diseño de la corrida
      // notifications lo pedía en voz alta («las variables, en el orden en que se publicó») y
      // el agente lo añadió a mano en un archivo de build.
      // Y el lote, como en las colecciones de entidades (rama `relationMany`): con una página
      // de raíces, cargar la lista de cada una por separado es el N+1 que ningún Then ve.
      imports.add('jakarta.persistence.OrderColumn');
      imports.add('org.hibernate.annotations.BatchSize');
      const collAnnotations = [
        '@ElementCollection',
        `@CollectionTable(${collTableAttrs.join(', ')})`,
        `@OrderColumn(name = "${snakeCase(member.name)}_order")`,
        `@BatchSize(size = ${collectionBatchSize(model)})`
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
          imports.add('jakarta.persistence.ForeignKey');
          annotation =
            `@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)\n` +
            `    @JoinColumn(name = "${snakeCase(entity.name)}_id", ` +
            `foreignKey = @ForeignKey(name = "${foreignKeyName(tableOf(model, member.relation.entity), entity.name)}"))`;
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
      // Nunca por debajo del tope de página del diseño (api.pagination.maxSize): con un
      // lote de 50 y páginas de 100, el coste vuelve a crecer con el tamaño de la página,
      // que es justo lo que este lote existe para evitar (corrida catalog, 2026-09-29).
      imports.add('org.hibernate.annotations.BatchSize');
      annotation += `\n    @BatchSize(size = ${collectionBatchSize(model)})`;
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
      imports.add('jakarta.persistence.ForeignKey');
      const ownFk = foreignKeyName(entity.tableName ?? snakeCase(entity.name), member.relation.name);
      const joinColumn =
        `\n    @JoinColumn(name = "${quoteIdentifier(`${snakeCase(member.relation.name)}_id`)}"${joinNullable}` +
        `, foreignKey = @ForeignKey(name = "${ownFk}"))`;
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

function renderTableAnnotation(model, entity, members, imports) {
  const attrs = [`name = "${quoteIdentifier(entity.tableName)}"`];
  const uniqueConstraints = [];
  const column = (name) => quoteIdentifier(name);

  if (entity.naturalKey && entity.naturalKey.length > 0) {
    // Un miembro de la clave que pliega (`compare`, DSL 2.14) entra por su SOMBRA: la clave
    // natural es una unicidad como cualquier otra, y solo la columna plegada sabe que `ACME`
    // y `acme` son la misma.
    const shadowOf = (f) => members.find((m) => m.kind === 'scalar' && m.name === f)?.folded;
    const columns = entity.naturalKey
      .flatMap((f) => (shadowOf(f) ? [shadowOf(f).column.replace(/`/g, '')] : columnsFor(model, entity, members, f, model.warnings)))
      .map((c) => `"${column(c)}"`)
      .join(', ');
    uniqueConstraints.push(`@UniqueConstraint(name = "uk_${entity.tableName}_natural", columnNames = { ${columns} })`);
  }

  // Un campo unique del diseño es una garantía, no una expectativa: la
  // comprobación previa en el handler produce el error de negocio en el caso
  // normal, pero solo la constraint impide que dos peticiones simultáneas la
  // sorteen. Su violación la traduce al mismo error el ApiExceptionHandler.
  //
  // Con `compare` distinto de exact la constraint va sobre la SOMBRA plegada: `ACME` y `acme`
  // son el mismo nombre para el diseño, y solo la columna plegada lo sabe. El nombre de la
  // constraint no cambia —el ApiExceptionHandler la traduce por nombre—.
  for (const field of uniqueFields(entity)) {
    const shadow = members.find((m) => m.kind === 'scalar' && m.name === field.name)?.folded;
    const target = shadow ? shadow.column.replace(/`/g, '') : snakeCase(field.name);
    uniqueConstraints.push(
      `@UniqueConstraint(name = "uk_${entity.tableName}_${snakeCase(field.name)}", columnNames = { "${column(target)}" })`
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
  const indexes = annotatable.map((index) => {
    // El nombre del índice conserva el nombre lógico del diseño (es su
    // identidad en persistence.keel.yaml); la columnList usa la columna real.
    const columns = index.fields
      .flatMap((f) => columnsFor(model, entity, members, f, model.warnings))
      .map((c) => column(c))
      .join(', ');
    const unique = index.unique ? ', unique = true' : '';
    return `@Index(name = "${indexName(entity, index)}", columnList = "${columns}"${unique})`;
  });
  for (const fkColumn of foreignKeyIndexColumns(model, entity, members)) {
    indexes.push(`@Index(name = "${foreignKeyIndexName(entity.tableName, fkColumn)}", columnList = "${column(fkColumn)}")`);
  }
  if (indexes.length > 0) {
    imports.add('jakarta.persistence.Index');
    attrs.push(`indexes = { ${indexes.join(', ')} }`);
  }

  return `@Table(${attrs.join(', ')})`;
}
