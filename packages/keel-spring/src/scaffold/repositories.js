// Persistencia hexagonal completa (patrón del prototipo): por cada raíz de
// agregado persistida se generan (1) el puerto <E>Repository en
// domain/repository, (2) la interfaz Spring Data <E>JpaRepository y (3) el
// adaptador <E>RepositoryImpl con el mapeo domain↔JPA inline (toDomain/toJpa),
// derivado campo a campo de los mismos miembros que usan dominio y Jpa.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainMembers, domainSubPackage, capitalize } from './entities.js';
import { jpaMembers, JPA_PKG } from './persistence-entities.js';

const PORT_PKG = 'domain.repository';
const REPO_PKG = 'infrastructure.persistence.repositories';

export function generate(model) {
  if (!model.layersPresent.persistence) return [];

  const files = [];
  for (const entity of model.entities.filter((e) => e.persisted && e.isAggregateRoot)) {
    const paginated = model.services.some(
      (group) => group.entity === entity.name && group.operations.some((op) => op.paginated)
    );
    files.push(renderPort(model, entity, paginated));
    files.push(renderJpaRepository(model, entity));
    files.push(renderAdapter(model, entity, paginated));
  }
  return files;
}

function naturalKeyParams(entity) {
  return (entity.naturalKey ?? []).map((fieldName) => {
    const field = entity.fields.find((f) => f.name === fieldName);
    return { name: fieldName, javaType: field?.javaType ?? 'String', imports: field?.imports ?? [] };
  });
}

function naturalKeyFinder(entity) {
  const params = naturalKeyParams(entity);
  if (params.length === 0) return null;
  return {
    params,
    name: 'findBy' + params.map((p) => capitalize(p.name)).join('And'),
    signature: params.map((p) => `${p.javaType} ${p.name}`).join(', '),
    args: params.map((p) => p.name).join(', ')
  };
}

// Puerto de salida del dominio: interfaz sin dependencia de JPA (usa
// Page/Pageable de Spring Data como pragmatismo, igual que el prototipo).
function renderPort(model, entity, paginated) {
  const imports = new Set([
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`,
    'java.util.Optional',
    'java.util.UUID'
  ]);

  const methods = [`    Optional<${entity.name}> findById(UUID id);`];
  const finder = naturalKeyFinder(entity);
  if (finder) {
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods.push(`    Optional<${entity.name}> ${finder.name}(${finder.signature});`);
  }
  if (paginated) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    methods.push(`    Page<${entity.name}> list(Pageable pageable);`);
  }
  methods.push(`    ${entity.name} save(${entity.name} entity);`, '    void deleteById(UUID id);');

  const body = `/**
 * Puerto de persistencia del agregado ${entity.name}; el adaptador JPA vive en
 * infrastructure/persistence/repositories.
 */
public interface ${entity.name}Repository {

${methods.join('\n\n')}
}`;

  return {
    path: javaPath(model, PORT_PKG, `${entity.name}Repository`),
    content: javaFile(subPackage(model, PORT_PKG), [...imports], body)
  };
}

function renderJpaRepository(model, entity) {
  const imports = new Set([
    `${subPackage(model, JPA_PKG)}.${entity.name}Jpa`,
    'org.springframework.data.jpa.repository.JpaRepository',
    'java.util.UUID'
  ]);

  let methods = '';
  const finder = naturalKeyFinder(entity);
  if (finder) {
    imports.add('java.util.Optional');
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods = `\n\n    Optional<${entity.name}Jpa> ${finder.name}(${finder.signature});`;
  }

  const body = `public interface ${entity.name}JpaRepository extends JpaRepository<${entity.name}Jpa, UUID> {${methods}\n}`;

  return {
    path: javaPath(model, REPO_PKG, `${entity.name}JpaRepository`),
    content: javaFile(subPackage(model, REPO_PKG), [...imports], body)
  };
}

// Adaptador: implementa el puerto delegando en Spring Data y mapeando
// domain↔JPA de forma explícita (sin reflexión ni mappers externos).
function renderAdapter(model, entity, paginated) {
  const imports = new Set([
    `${subPackage(model, PORT_PKG)}.${entity.name}Repository`,
    `${subPackage(model, JPA_PKG)}.${entity.name}Jpa`,
    'java.util.Optional',
    'java.util.UUID',
    'org.springframework.stereotype.Component'
  ]);

  // Entidades involucradas: la raíz + sus entidades internas (transitivo).
  const involved = collectInternalEntities(model, entity);
  for (const involvedEntity of involved) {
    imports.add(`${subPackage(model, domainSubPackage(involvedEntity))}.${involvedEntity.name}`);
    if (involvedEntity !== entity) imports.add(`${subPackage(model, JPA_PKG)}.${involvedEntity.name}Jpa`);
  }

  const jpaField = `${entity.name[0].toLowerCase()}${entity.name.slice(1)}JpaRepository`;

  const methods = [
    `    @Override
    public Optional<${entity.name}> findById(UUID id) {
        return ${jpaField}.findById(id).map(this::toDomain);
    }`
  ];
  const finder = naturalKeyFinder(entity);
  if (finder) {
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods.push(`    @Override
    public Optional<${entity.name}> ${finder.name}(${finder.signature}) {
        return ${jpaField}.${finder.name}(${finder.args}).map(this::toDomain);
    }`);
  }
  if (paginated) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    methods.push(`    @Override
    public Page<${entity.name}> list(Pageable pageable) {
        return ${jpaField}.findAll(pageable).map(this::toDomain);
    }`);
  }
  // Drenaje de eventos de dominio: save() es el único punto por el que pasa
  // todo cambio persistido del agregado, así que aquí se publican los eventos
  // que la raíz acumuló. Va dentro de la transacción: el bridge decide después
  // si se escriben al outbox (misma transacción) o se envían tras el commit.
  const emitsEvents = model.events.some((event) => event.aggregate === entity.name);
  if (emitsEvents) {
    imports.add('org.springframework.context.ApplicationEventPublisher');
    imports.add('org.springframework.transaction.annotation.Transactional');
  }
  const saveBody = emitsEvents
    ? `        ${entity.name} saved = toDomain(${jpaField}.save(toJpa(entity)));
        entity.pullDomainEvents().forEach(eventPublisher::publishEvent);
        return saved;`
    : `        return toDomain(${jpaField}.save(toJpa(entity)));`;

  methods.push(
    `    @Override${emitsEvents ? '\n    @Transactional' : ''}
    public ${entity.name} save(${entity.name} entity) {
${saveBody}
    }`,
    `    @Override
    public void deleteById(UUID id) {
        ${jpaField}.deleteById(id);
    }`
  );

  const mappers = involved.flatMap((involvedEntity) => [
    renderToDomain(model, involvedEntity, imports),
    renderToJpa(model, involvedEntity, imports)
  ]);

  const fields = [`    private final ${entity.name}JpaRepository ${jpaField};`];
  const ctorParams = [`${entity.name}JpaRepository ${jpaField}`];
  const ctorAssigns = [`        this.${jpaField} = ${jpaField};`];
  if (emitsEvents) {
    fields.push('    private final ApplicationEventPublisher eventPublisher;');
    ctorParams.push('ApplicationEventPublisher eventPublisher');
    ctorAssigns.push('        this.eventPublisher = eventPublisher;');
  }

  const body = `@Component
public class ${entity.name}RepositoryImpl implements ${entity.name}Repository {

${fields.join('\n')}

    public ${entity.name}RepositoryImpl(${ctorParams.join(', ')}) {
${ctorAssigns.join('\n')}
    }

${methods.join('\n\n')}

    // ── Mapeo domain ↔ JPA ───────────────────────────────────────────────────

${mappers.join('\n\n')}
}`;

  return {
    path: javaPath(model, REPO_PKG, `${entity.name}RepositoryImpl`),
    content: javaFile(subPackage(model, REPO_PKG), [...imports], body)
  };
}

function collectInternalEntities(model, root) {
  const involved = [];
  const visit = (entity) => {
    if (!entity || involved.includes(entity)) return;
    involved.push(entity);
    for (const relation of entity.relations) {
      if (relation.internal) visit(model.entities.find((e) => e.name === relation.entity));
    }
  };
  visit(root);
  return involved;
}

function renderToDomain(model, entity, imports) {
  const args = domainMembers(model, entity).map((member) => {
    if (member.kind === 'field' && member.field.kind === 'composite') {
      const vo = model.valueObjects.find((v) => v.name === member.field.javaType);
      if (!vo) return `null /* TODO (agente): mapear ${member.field.javaType} */`;
      // Con un value object anidado, la Jpa dejó un TODO en vez de columnas: no hay
      // getters de subcampos que reconstruir aquí; lo completa el agente.
      if (vo.fields.some((sub) => sub.kind === 'composite')) {
        return `null /* TODO (agente): reconstruir ${member.field.javaType} (value object anidado, ver skill keel-spring-database) */`;
      }
      imports.add(`${subPackage(model, 'domain.valueobject')}.${vo.name}`);
      const jpaSubs = vo.fields.map((sub) => `jpa.get${capitalize(member.name)}${capitalize(sub.name)}()`);
      return `new ${vo.name}(${jpaSubs.join(', ')})`;
    }
    if (member.kind === 'relationMany') {
      return `jpa.get${capitalize(member.name)}().stream().map(this::toDomain).toList()`;
    }
    if (member.kind === 'relationOne') {
      return `jpa.get${capitalize(member.name)}() != null ? toDomain(jpa.get${capitalize(member.name)}()) : null`;
    }
    return `jpa.get${capitalize(member.name)}()`;
  });

  return `    private ${entity.name} toDomain(${entity.name}Jpa jpa) {
        return new ${entity.name}(
                ${args.join(',\n                ')});
    }`;
}

function renderToJpa(model, entity, imports) {
  const lines = [`        ${entity.name}Jpa jpa = new ${entity.name}Jpa();`];
  for (const member of jpaMembers(model, entity)) {
    if (member.kind === 'vo') {
      const getter = `domain.get${capitalize(member.name)}()`;
      for (const sub of member.subs) {
        // Sub compuesto (value object anidado): sin columna aplanada en la Jpa.
        if (sub.subKind === 'composite') {
          lines.push(`        // TODO (agente): mapear ${member.field.javaType}.${sub.voAccessor} (value object anidado).`);
          continue;
        }
        lines.push(`        jpa.set${capitalize(sub.name)}(${getter} != null ? ${getter}.${sub.voAccessor}() : null);`);
      }
      if (member.subs.length === 0) {
        lines.push(`        // TODO (agente): mapear el value object ${member.field.javaType}.`);
      }
    } else if (member.kind === 'relationMany') {
      // Lista mutable: Hibernate gestiona la colección.
      imports.add('java.util.ArrayList');
      lines.push(
        `        jpa.set${capitalize(member.name)}(new ArrayList<>(domain.get${capitalize(member.name)}().stream().map(this::toJpa).toList()));`
      );
    } else if (member.kind === 'relationOne') {
      const getter = `domain.get${capitalize(member.name)}()`;
      lines.push(`        jpa.set${capitalize(member.name)}(${getter} != null ? toJpa(${getter}) : null);`);
    } else {
      lines.push(`        jpa.set${capitalize(member.name)}(domain.get${capitalize(member.name)}());`);
    }
  }
  lines.push('        return jpa;');

  return `    private ${entity.name}Jpa toJpa(${entity.name} domain) {
${lines.join('\n')}
    }`;
}
