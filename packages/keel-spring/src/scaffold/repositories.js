// Persistencia hexagonal completa (patrón del prototipo): por cada raíz de
// agregado persistida se generan (1) el puerto <E>Repository en
// domain/repository, (2) la interfaz Spring Data <E>JpaRepository y (3) el
// adaptador <E>RepositoryImpl con el mapeo domain↔JPA inline (toDomain/toJpa),
// derivado campo a campo de los mismos miembros que usan dominio y Jpa.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainMembers, domainSubPackage, capitalize } from './entities.js';
import { jpaMembers, backReferenceTo, JPA_PKG } from './persistence-entities.js';
import { isRefTarget } from './ref-resolvers.js';

const PORT_PKG = 'domain.repository';
const REPO_PKG = 'infrastructure.persistence.repositories';

export function generate(model) {
  if (!model.layersPresent.persistence) return [];

  const files = [];
  for (const entity of model.entities.filter((e) => e.persisted && e.isAggregateRoot)) {
    const paginated = model.services.some(
      (group) => group.entity === entity.name && group.operations.some((op) => op.paginated)
    );
    // Lectura por lote: solo las raíces que algún payload embebe (`embed`) la
    // necesitan, y solo ellas la reciben — un puerto no se ensancha con métodos
    // que nadie llama. Es lo que permite resolver los embeds de una página con
    // una consulta por agregado en vez de una por elemento (N+1).
    const batchLookup = isRefTarget(model, entity.name);
    files.push(renderPort(model, entity, paginated, batchLookup));
    files.push(renderJpaRepository(model, entity));
    files.push(renderAdapter(model, entity, paginated, batchLookup));
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
function renderPort(model, entity, paginated, batchLookup) {
  const imports = new Set([
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`,
    'java.util.Optional',
    'java.util.UUID'
  ]);

  const methods = [`    Optional<${entity.name}> findById(UUID id);`];
  if (batchLookup) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    methods.push(`    /**
     * Carga en UNA consulta las raíces de la colección de ids. El orden de salida
     * NO está garantizado y los ids inexistentes simplemente no aparecen: quien
     * llama indexa por id (ver ${entity.name}RefResolver).
     */
    List<${entity.name}> findAllById(Collection<UUID> ids);`);
  }
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
function renderAdapter(model, entity, paginated, batchLookup) {
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
  if (batchLookup) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    methods.push(`    @Override
    public List<${entity.name}> findAllById(Collection<UUID> ids) {
        return ${jpaField}.findAllById(ids).stream().map(this::toDomain).toList();
    }`);
  }
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
  // Se parte de la instancia GESTIONADA cuando el agregado ya existe: guardar un
  // grafo reconstruido a mano es un merge sobre entidades detached, y con @Version
  // eso falla con ObjectOptimisticLockingFailureException aunque no haya
  // concurrencia ninguna. Cargarla también es lo que permite reconciliar las
  // colecciones hijas por identidad en vez de recrearlas (ver applyToJpa).
  const loadManaged = `        ${entity.name}Jpa jpa = entity.getId() != null
                ? ${jpaField}.findById(entity.getId()).orElseGet(${entity.name}Jpa::new)
                : new ${entity.name}Jpa();
        applyToJpa(entity, jpa);`;
  // El listener de auditoría escribe @LastModifiedDate/@LastModifiedBy en el FLUSH,
  // no en el save: sobre una instancia gestionada, save() no fuerza flush y el
  // toDomain() de vuelta devolvería los valores anteriores. Solo importa cuando el
  // diseño proyecta esos campos al dominio ('declared'), que es justo cuando pueden
  // acabar en la respuesta de la operación.
  const save = entity.projectsManagedAudit ? 'saveAndFlush' : 'save';
  const saveBody = emitsEvents
    ? `${loadManaged}
        ${entity.name} saved = toDomain(${jpaField}.${save}(jpa));
        entity.pullDomainEvents().forEach(eventPublisher::publishEvent);
        return saved;`
    : `${loadManaged}
        return toDomain(${jpaField}.${save}(jpa));`;

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

  // Entidades que alguien construye desde cero al mapear (relación one-to-one
  // interna): solo esas necesitan el atajo `toJpa`. El resto se vuelca sobre una
  // instancia existente con `applyToJpa`, y emitir la fábrica igualmente dejaría un
  // método privado sin usar en cada adaptador.
  const builtFresh = new Set(
    involved.flatMap((involvedEntity) =>
      jpaMembers(model, involvedEntity)
        .filter((member) => member.kind === 'relationOne' && !member.relation?.backReference)
        .map((member) => member.relation.entity)
    )
  );

  const mappers = involved.flatMap((involvedEntity) => [
    renderToDomain(model, involvedEntity, imports),
    renderToJpa(model, involvedEntity, imports, builtFresh.has(involvedEntity.name))
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
    if (member.kind === 'field' && member.field.list) {
      // Colección (list): escalar/enum copia directa; VO reconstruido desde su XxxJpa.
      const getter = `jpa.get${capitalize(member.name)}()`;
      if (member.field.kind !== 'composite') return getter;
      const vo = model.valueObjects.find((v) => v.name === member.field.elementJavaType);
      if (!vo || vo.fields.some((sub) => sub.kind === 'composite')) {
        return `${getter}.stream().map(e -> null /* TODO (agente): reconstruir ${member.field.elementJavaType} (value object anidado) */).toList()`;
      }
      imports.add(`${subPackage(model, 'domain.valueobject')}.${vo.name}`);
      const subs = vo.fields.map((sub) => `e.get${capitalize(sub.name)}()`);
      return `${getter}.stream().map(e -> new ${vo.name}(${subs.join(', ')})).toList()`;
    }
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

  // Versión de concurrencia optimista: último arg del constructor (solo raíz; si el
  // diseño declara el nombre lockVersion, ya viene entre los args).
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) args.push('jpa.getLockVersion()');

  return `    private ${entity.name} toDomain(${entity.name}Jpa jpa) {
        return new ${entity.name}(
                ${args.join(',\n                ')});
    }`;
}

function renderToJpa(model, entity, imports, needsFactory = false) {
  const lines = [];
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
    } else if (member.kind === 'elementCollection') {
      imports.add('java.util.ArrayList');
      const getter = `domain.get${capitalize(member.name)}()`;
      if (member.element.kind === 'vo') {
        // VO → su espejo XxxJpa (setters); un VO anidado deja el elemento a medias para el agente.
        imports.add(`${subPackage(model, JPA_PKG)}.${member.element.javaType}`);
        const vo = model.valueObjects.find((v) => v.name === member.field.elementJavaType);
        const nested = !vo || vo.fields.some((sub) => sub.kind === 'composite');
        const jpaType = member.element.javaType;
        const mapping = nested
          ? `${jpaType} e = new ${jpaType}(); /* TODO (agente): copiar campos de ${member.field.elementJavaType} (value object anidado) */ return e;`
          : vo.fields
              .map((sub) => `                    e.set${capitalize(sub.name)}(v.${sub.name}());`)
              .join('\n');
        const lambda = nested
          ? `v -> { ${mapping} }`
          : `v -> {\n                    ${jpaType} e = new ${jpaType}();\n${mapping}\n                    return e;\n                }`;
        // Tipo explícito en ArrayList: el diamante no infiere a través del
        // stream().map(lambda de bloque).toList() encadenado.
        lines.push(
          `        jpa.set${capitalize(member.name)}(new ArrayList<${jpaType}>(${getter}.stream().map(${lambda}).toList()));`
        );
      } else {
        // Escalar/enum: copia directa de la lista.
        lines.push(`        jpa.set${capitalize(member.name)}(new ArrayList<>(${getter}));`);
      }
    } else if (member.kind === 'relationMany') {
      // Lista mutable: Hibernate gestiona la colección.
      imports.add('java.util.ArrayList');
      const inverse = backReferenceTo(model, member.relation.entity, entity.name);
      const childJpa = `${member.relation.entity}Jpa`;
      const getter = `domain.get${capitalize(member.name)}()`;
      const accessor = `jpa.get${capitalize(member.name)}()`;
      imports.add('java.util.List');
      imports.add('java.util.Map');
      imports.add('java.util.HashMap');
      const local = `${member.name}Reconciled`;
      // Reconciliación por identidad sobre la colección GESTIONADA, no un grafo
      // nuevo. Construir hijas con `new` en cada guardado convierte el save() en un
      // merge sobre entidades detached: con @Version, Hibernate ve la versión que
      // trae el grafo recién armado y lanza ObjectOptimisticLockingFailureException
      // (409 CONCURRENT_MODIFICATION) hasta en flujos secuenciales de un solo
      // actor. Se reutiliza la instancia gestionada de cada hija que ya existía y
      // solo son nuevas las que el dominio acaba de añadir; clear()+addAll sobre la
      // colección gestionada deja que orphanRemoval borre las que se fueron.
      lines.push(
        `        Map<UUID, ${childJpa}> ${member.name}Managed = new HashMap<>();`,
        `        for (${childJpa} child : ${accessor}) ${member.name}Managed.put(child.getId(), child);`,
        `        List<${childJpa}> ${local} = new ArrayList<>();`,
        `        for (${member.relation.entity} child : ${getter}) {`,
        `            ${childJpa} childJpa = child.getId() != null ? ${member.name}Managed.get(child.getId()) : null;`,
        `            if (childJpa == null) childJpa = new ${childJpa}();`,
        `            applyToJpa(child, childJpa);`
      );
      if (inverse) {
        // Bidireccional: la hija es dueña de la FK, así que hay que estampar el
        // padre en cada hija. El mapeo de la hija nunca vuelve al padre (sería
        // recursión infinita): el vínculo se cierra aquí, en un solo sentido.
        lines.push(`            childJpa.set${capitalize(inverse)}(jpa);`);
      }
      lines.push(
        `            ${local}.add(childJpa);`,
        '        }',
        `        ${accessor}.clear();`,
        `        ${accessor}.addAll(${local});`
      );
    } else if (member.kind === 'relationOne' && member.relation?.backReference) {
      // La back-reference la estampa el padre al mapear su colección.
      lines.push(`        // ${member.name}: lo estampa ${member.relation.entity}RepositoryImpl al mapear su colección.`);
    } else if (member.kind === 'relationOne') {
      const getter = `domain.get${capitalize(member.name)}()`;
      lines.push(`        jpa.set${capitalize(member.name)}(${getter} != null ? toJpa(${getter}) : null);`);
    } else {
      lines.push(`        jpa.set${capitalize(member.name)}(domain.get${capitalize(member.name)}());`);
    }
  }
  // Devuelve la versión al espejo JPA para que Hibernate compruebe la concurrencia
  // optimista al persistir (solo raíz de agregado).
  // (si el diseño declara el nombre lockVersion, el bucle de members ya la copió).
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    lines.push('        jpa.setLockVersion(domain.getLockVersion());');
  }

  // `applyToJpa` vuelca el dominio sobre una instancia que puede estar GESTIONADA
  // (la que save() cargó, o la hija reutilizada al reconciliar). `toJpa` es solo el
  // atajo para cuando de verdad hace falta una nueva.
  const factory = needsFactory
    ? `    private ${entity.name}Jpa toJpa(${entity.name} domain) {
        ${entity.name}Jpa jpa = new ${entity.name}Jpa();
        applyToJpa(domain, jpa);
        return jpa;
    }

`
    : '';
  return `${factory}    private void applyToJpa(${entity.name} domain, ${entity.name}Jpa jpa) {
${lines.join('\n')}
    }`;
}
