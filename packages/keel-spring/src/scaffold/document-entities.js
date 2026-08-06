// Espejos documentales del dominio (XxxDocument), separados del dominio igual que
// las Jpa: viven en infrastructure/persistence/documents y solo existen con capa
// persistence sobre un motor documental.
//
// La diferencia de fondo con la rama relacional cabe en una frase: **el agregado es
// el documento**. La raíz lleva @Document y es una colección; sus entidades internas
// NO son colecciones, van anidadas dentro de ella como objetos y listas. De ahí que
// aquí no haya mappedBy, ni cascade, ni orphanRemoval, ni tabla de elementos: lo que
// en JPA eran tres tablas y dos claves ajenas, aquí es un objeto con un array
// dentro. Lo que sí se conserva es la frontera: una relación a OTRO agregado sigue
// siendo un UUID y nunca un @DBRef (ver la skill keel-spring-mongodb).

import { snakeCase } from '../lib/naming.js';
import { documentAnnotations, needsFieldType } from '../lib/type-mapper.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { capitalize } from './entities.js';
import { persistedMembers, usesAuditableEntity } from './persistence-members.js';

export const DOC_PKG = 'infrastructure.persistence.documents';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];
  warnAboutNestedAudit(model);
  return [
    ...(usesAuditableEntity(model) ? [renderAuditableDocument(model)] : []),
    ...model.entities.filter((entity) => entity.persisted).map((entity) => renderDocument(model, entity))
  ];
}

/**
 * En el modelo relacional, `audit: all` pone columnas en CADA tabla, hijas
 * incluidas. Aquí no puede: el callback de auditoría de Spring Data MongoDB actúa
 * sobre el objeto que se persiste —la raíz—, no sobre lo que va anidado dentro. Se
 * dice en voz alta en vez de generar campos que nadie poblaría.
 */
function warnAboutNestedAudit(model) {
  if (!usesAuditableEntity(model)) return;
  const nested = model.entities.filter((e) => e.persisted && !e.isAggregateRoot).map((e) => e.name);
  if (nested.length === 0) return;
  model.warnings.push(
    `persistence.audit: la política 'all' se aplica a las raíces de agregado (${nested.join(', ')} va anidada dentro de su raíz). La auditoría de Spring Data MongoDB puebla el objeto que se guarda, no lo anidado: si el diseño necesita saber cuándo cambió una hija, ese campo es del dominio (audit: declared), no de la política.`
  );
}

/**
 * Base de los documentos auditables. A diferencia de AuditableEntity no lleva
 * anotaciones de clase: en Mongo la auditoría no va por @EntityListeners sino por el
 * callback que activa @EnableMongoAuditing, y le basta con encontrar las
 * anotaciones de campo. Las anotaciones de campo, en cambio, son LAS MISMAS
 * (org.springframework.data.annotation): son de Spring Data, no de JPA.
 */
function renderAuditableDocument(model) {
  const timestamps = model.audit?.timestamps === 'all';
  const authorship = model.audit?.authorship === 'all';
  const imports = ['org.springframework.data.mongodb.core.mapping.Field'];
  const members = [];
  const accessors = [];

  if (timestamps) {
    imports.push(
      'java.time.Instant',
      'org.springframework.data.annotation.CreatedDate',
      'org.springframework.data.annotation.LastModifiedDate'
    );
    members.push(
      `    @CreatedDate
    @Field(name = "created_at")
    private Instant createdAt;`,
      `    @LastModifiedDate
    @Field(name = "updated_at")
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
    @Field(name = "created_by")
    private String createdBy;`,
      `    @LastModifiedBy
    @Field(name = "updated_by")
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
 * Base de los documentos auditables: registra ${registers} vía el auditing de Spring
 * Data MongoDB, sin que el dominio nombre estos campos (persistence.audit).
 */
public abstract class AuditableDocument {

${[...members, ...accessors].join('\n\n')}
}`;

  return {
    path: javaPath(model, DOC_PKG, 'AuditableDocument'),
    content: javaFile(subPackage(model, DOC_PKG), imports.sort(), body)
  };
}

function renderDocument(model, entity) {
  const imports = new Set(['org.springframework.data.mongodb.core.mapping.Field']);
  const members = persistedMembers(model, entity);
  const declarations = [];
  const accessors = [];

  const pushAccessor = (name, javaType) => {
    accessors.push(
      `    public ${javaType} get${capitalize(name)}() {\n        return ${name};\n    }`,
      `    public void set${capitalize(name)}(${javaType} ${name}) {\n        this.${name} = ${name};\n    }`
    );
  };

  // La auditoría por política solo la hereda la raíz: lo anidado no pasa por el
  // callback (ver warnAboutNestedAudit).
  const inheritsAuditable = entity.isAggregateRoot && usesAuditableEntity(model);
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
        // @Id de Spring Data, no de JPA: se proyecta sobre el _id del documento, así
        // que no lleva @Field (ese nombre no es negociable en Mongo).
        imports.add('org.springframework.data.annotation.Id');
        lines.push('    @Id');
        lines.push(`    private ${field.javaType} ${field.name};`);
        declarations.push(lines.join('\n'));
        pushAccessor(member.name, field.javaType);
        continue;
      }
      // Caso borde idéntico al relacional: el diseño declara un campo llamado
      // lockVersion, el nombre que build reserva para el @Version.
      if (entity.declaresLockVersion && entity.usesOptimisticLocking && field.name === 'lockVersion') {
        imports.add('org.springframework.data.annotation.Version');
        lines.push('    @Version');
      }
      const auditAnnotation = declaredAudit.get(field.name);
      if (auditAnnotation) {
        imports.add(`org.springframework.data.annotation.${auditAnnotation}`);
        lines.push(`    @${auditAnnotation}`);
      }
      if (needsFieldType(field.base)) imports.add('org.springframework.data.mongodb.core.mapping.FieldType');
      for (const annotation of documentAnnotations(field.name, field.base)) lines.push(`    ${annotation}`);
      lines.push(`    private ${field.javaType} ${field.name};`);
      declarations.push(lines.join('\n'));
      pushAccessor(member.name, field.javaType);
    } else if (member.kind === 'vo') {
      // Value object: subdocumento anidado, no columnas con prefijo. Y como es un
      // objeto de verdad, un value object DENTRO de otro no tiene nada de especial:
      // es el caso que en JPA deja un TODO para el agente y aquí sale generado.
      const voDoc = `${member.field.javaType}Document`;
      declarations.push(
        `    // ${member.field.javaType} anidado como subdocumento.\n    @Field(name = "${snakeCase(member.name)}")\n    private ${voDoc} ${member.name};`
      );
      pushAccessor(member.name, voDoc);
    } else if (member.kind === 'externalRef') {
      // Frontera del agregado: el id del otro, nunca una referencia navegable.
      // @DBRef parecería un join y no lo es (el driver hace una consulta por
      // documento), además de romper la frontera — ver la skill.
      imports.add('java.util.UUID');
      declarations.push(
        `    @Field(name = "${snakeCase(member.relation.name)}_id")\n    private UUID ${member.name};`
      );
      pushAccessor(member.name, 'UUID');
    } else if (member.kind === 'elementCollection') {
      imports.add('java.util.List');
      imports.add('java.util.ArrayList');
      const { element } = member;
      const javaType = element.kind === 'vo' ? `${element.typeName}Document` : element.javaType;
      if (element.kind === 'enum') imports.add(`${subPackage(model, 'domain.enums')}.${element.javaType}`);
      if (element.kind !== 'vo' && element.kind !== 'enum') {
        for (const name of member.field.imports) imports.add(name);
      }
      // Array del propio documento: aquí no hay tabla de elementos ni clave ajena.
      declarations.push(
        `    @Field(name = "${snakeCase(member.name)}")\n    private List<${javaType}> ${member.name} = new ArrayList<>();`
      );
      pushAccessor(member.name, `List<${javaType}>`);
    } else if (member.kind === 'relationMany') {
      imports.add('java.util.List');
      imports.add('java.util.ArrayList');
      const childDoc = `${member.relation.entity}Document`;
      declarations.push(
        `    @Field(name = "${snakeCase(member.name)}")\n    private List<${childDoc}> ${member.name} = new ArrayList<>();`
      );
      pushAccessor(member.name, `List<${childDoc}>`);
    } else if (member.relation?.backReference) {
      // La hija va DENTRO del padre: el puntero de vuelta era un artefacto de la
      // clave ajena y aquí no tiene nada que apuntar. El mapeo a dominio lo pasa
      // como null (ver document-repositories.js).
      declarations.push(
        `    // ${member.name}: en el modelo documental ${entity.name} va anidada dentro de ${member.relation.entity}; no hay referencia de vuelta que guardar.`
      );
    } else {
      const childDoc = `${member.relation.entity}Document`;
      declarations.push(
        `    @Field(name = "${snakeCase(member.name)}")\n    private ${childDoc} ${member.name};`
      );
      pushAccessor(member.name, childDoc);
    }
  }

  // Concurrencia optimista: igual que en relacional, solo la raíz (es la frontera de
  // consistencia). La @Version es la de Spring Data, y la comprueba el propio
  // update: una escritura sobre una versión obsoleta lanza
  // OptimisticLockingFailureException, que traduce el ApiExceptionHandler.
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    imports.add('org.springframework.data.annotation.Version');
    declarations.push('    @Version\n    @Field(name = "lock_version")\n    private Long lockVersion;');
    pushAccessor('lockVersion', 'Long');
  }

  const header = [];
  if (entity.isAggregateRoot) {
    imports.add('org.springframework.data.mongodb.core.mapping.Document');
    header.push(`@Document(collection = "${entity.collectionName}")`);
  } else {
    // Sin @Document a propósito: esta entidad no es una colección, va anidada dentro
    // del documento de su raíz.
    header.push(`// Anidada dentro de ${entity.rootEntity}Document: no es una colección propia.`);
  }
  const extendsClause = inheritsAuditable ? ' extends AuditableDocument' : '';

  const body = `${header.join('\n')}
public class ${entity.name}Document${extendsClause} {

${declarations.join('\n\n')}

${accessors.join('\n\n')}
}`;

  return {
    path: javaPath(model, DOC_PKG, `${entity.name}Document`),
    content: javaFile(subPackage(model, DOC_PKG), [...imports], body)
  };
}
