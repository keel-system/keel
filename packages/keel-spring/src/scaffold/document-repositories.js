// Persistencia hexagonal del modelo documental: por cada raíz de agregado
// persistida se generan (1) el puerto <E>Repository —el MISMO que en la rama
// relacional, reutilizado literalmente desde repositories.js—, (2) la interfaz
// Spring Data <E>MongoRepository y (3) el adaptador <E>RepositoryImpl con el mapeo
// domain↔documento inline (toDomain/toDocument).
//
// El adaptador es notablemente más corto que su gemelo JPA, y conviene saber por
// qué: allí save() tiene que cargar la instancia GESTIONADA y reconciliar las
// colecciones hijas por identidad, porque guardar un grafo reconstruido a mano es un
// merge sobre entidades detached y con @Version eso falla sin que haya concurrencia
// ninguna. Aquí el agregado ES el documento: se escribe entero de una vez, la
// versión viaja dentro y no hay sesión, ni entidades gestionadas, ni orphanRemoval.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainMembers, domainSubPackage, capitalize } from './entities.js';
import { persistedMembers, orderingFieldOf, usesAuditableEntity } from './persistence-members.js';
import {
  renderPort,
  naturalKeyFinder,
  naturalKeyBatchFinder,
  collectInternalEntities,
  PORT_PKG,
  REPO_PKG
} from './repositories.js';
import * as claim from './claim.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import { DOC_PKG } from './document-entities.js';
import { documentValueObjects } from './document-embeddables.js';
import { isRefTarget } from './ref-resolvers.js';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];

  const files = [];
  for (const entity of model.entities.filter((e) => e.persisted && e.isAggregateRoot)) {
    const paginated = model.services.some(
      (group) => group.entity === entity.name && group.operations.some((op) => op.paginated)
    );
    const batchLookup = isRefTarget(model, entity.name);
    files.push(renderPort(model, entity, paginated, batchLookup));
    files.push(renderMongoRepository(model, entity));
    files.push(renderAdapter(model, entity, paginated, batchLookup));
  }
  return files;
}

function renderMongoRepository(model, entity) {
  const imports = new Set([
    `${subPackage(model, DOC_PKG)}.${entity.name}Document`,
    'org.springframework.data.mongodb.repository.MongoRepository',
    'java.util.UUID'
  ]);

  let methods = '';
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    imports.add('java.util.Optional');
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods = `\n\n    Optional<${entity.name}Document> ${finder.name}(${finder.signature});`;
  }
  // El puerto es el MISMO en las dos ramas (lo reexporta repositories.js), así que lo que
  // se declare allí hay que implementarlo aquí o el adaptador no compila.
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    methods += `\n\n    List<${entity.name}Document> ${batchFinder.name}(${batchFinder.signature});`;
  }

  const body = `public interface ${entity.name}MongoRepository extends MongoRepository<${entity.name}Document, UUID> {${methods}\n}`;

  return {
    path: javaPath(model, REPO_PKG, `${entity.name}MongoRepository`),
    content: javaFile(subPackage(model, REPO_PKG), [...imports], body)
  };
}

function renderAdapter(model, entity, paginated, batchLookup) {
  const imports = new Set([
    `${subPackage(model, PORT_PKG)}.${entity.name}Repository`,
    `${subPackage(model, DOC_PKG)}.${entity.name}Document`,
    'java.util.Optional',
    'java.util.UUID',
    'org.springframework.stereotype.Component'
  ]);

  const involved = collectInternalEntities(model, entity);
  for (const involvedEntity of involved) {
    imports.add(`${subPackage(model, domainSubPackage(involvedEntity))}.${involvedEntity.name}`);
    if (involvedEntity !== entity) imports.add(`${subPackage(model, DOC_PKG)}.${involvedEntity.name}Document`);
  }

  const repoField = `${entity.name[0].toLowerCase()}${entity.name.slice(1)}MongoRepository`;

  const methods = [
    `    @Override
    public Optional<${entity.name}> findById(UUID id) {
        return ${repoField}.findById(id).map(this::toDomain);
    }`
  ];
  if (batchLookup) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    methods.push(`    @Override
    public List<${entity.name}> findAllById(Collection<UUID> ids) {
        return ${repoField}.findAllById(ids).stream().map(this::toDomain).toList();
    }`);
  }
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods.push(`    @Override
    public Optional<${entity.name}> ${finder.name}(${finder.signature}) {
        return ${repoField}.${finder.name}(${finder.args}).map(this::toDomain);
    }`);
  }
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    methods.push(`    @Override
    public List<${entity.name}> ${batchFinder.name}(${batchFinder.signature}) {
        return ${repoField}.${batchFinder.name}(${batchFinder.args}).stream().map(this::toDomain).toList();
    }`);
  }
  if (paginated) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    imports.add('org.springframework.data.domain.PageRequest');
    imports.add('org.springframework.data.domain.Sort');
    methods.push(`    @Override
    public Page<${entity.name}> list(Pageable pageable) {
        return ${repoField}.findAll(withStableOrder(pageable)).map(this::toDomain);
    }

    /**
     * Añade el id como último criterio de orden si no está ya. Sin desempate, dos
     * páginas consecutivas de la misma consulta pueden repetir un documento y omitir
     * otro: cuando el orden empata, la base de datos no garantiza un orden estable
     * entre consultas. Se aplica también al orden que pida el cliente, que es justo
     * el caso que un @PageableDefault no cubre.
     */
    private static Pageable withStableOrder(Pageable pageable) {
        Sort sort = pageable.getSort();
        if (sort.getOrderFor("${entity.idField?.name ?? 'id'}") != null) {
            return pageable;
        }
        return PageRequest.of(pageable.getPageNumber(), pageable.getPageSize(), sort.and(TIE_BREAKER));
    }`);
  }

  // Drenaje de eventos de dominio: save() es el único punto por el que pasa todo
  // cambio persistido del agregado. Va dentro de la transacción, que aquí es real
  // gracias al MongoTransactionManager: con reliability: outbox, el documento y su
  // outbox_event tienen que entrar en el mismo commit o en ninguno.
  const emitsEvents = model.events.some((event) => event.aggregate === entity.name);
  if (emitsEvents) {
    imports.add('org.springframework.context.ApplicationEventPublisher');
    imports.add('org.springframework.transaction.annotation.Transactional');
  }

  // Sin saveAndFlush: MongoRepository no lo tiene, y no hace falta. La auditoría de
  // Spring Data MongoDB corre en un callback ANTES de convertir el documento, no en
  // un flush diferido, así que el objeto que devuelve save() ya trae createdAt y
  // updatedAt puestos aunque el diseño los proyecte al dominio (audit: declared).
  //
  // Lo que sí hace falta es ARRASTRAR la auditoría de creación: `save` reemplaza el
  // documento entero por el que acaba de construir el mapper, y el callback solo
  // estampa @CreatedDate/@CreatedBy cuando el documento es nuevo. Sin releer el que
  // había, cada actualización dejaría la creación a null. No tiene equivalente
  // relacional: allí el merge de JPA conserva esas columnas solo.
  const carriesAudit = usesAuditableEntity(model);
  const carryAuditArgs = [
    model.audit?.timestamps === 'all' ? 'existing.getCreatedAt()' : null,
    model.audit?.authorship === 'all' ? 'existing.getCreatedBy()' : null
  ].filter(Boolean);
  const documentExpr = carriesAudit
    ? `${entity.name}Document document = toDocument(entity);
        ${repoField}
                .findById(entity.getId())
                .ifPresent(existing -> document.carryCreationAudit(${carryAuditArgs.join(', ')}));
        `
    : '';
  const savedExpr = carriesAudit ? `${repoField}.save(document)` : `${repoField}.save(toDocument(entity))`;

  const saveBody = emitsEvents
    ? `        ${documentExpr}${entity.name} saved = toDomain(${savedExpr});
        entity.pullDomainEvents().forEach(eventPublisher::publishEvent);
        return saved;`
    : `        ${documentExpr}return toDomain(${savedExpr});`;

  // Los reclamos: el del barrido de una cola (findAndModify sobre el propio documento) y
  // el de la reconciliación (marca aparte con caducidad). El puerto los declara para los
  // dos modelos de persistencia, así que aquí tienen que existir o el adaptador no
  // implementaría su interfaz.
  const claimMethods = [
    ...claim.documentAdapterMethods(model, entity, imports),
    ...claim.guardDocumentAdapterMethods(model, entity, imports),
    ...reconciliationClaim.documentAdapterMethods(model, entity, imports)
  ];
  methods.push(...claimMethods);

  methods.push(
    `    @Override${emitsEvents ? '\n    @Transactional' : ''}
    public ${entity.name} save(${entity.name} entity) {
${saveBody}
    }`,
    `    @Override
    public void deleteById(UUID id) {
        ${repoField}.deleteById(id);
    }`
  );

  const mappers = involved.flatMap((involvedEntity) => [
    renderToDomain(model, involvedEntity, imports),
    renderToDocument(model, involvedEntity, imports)
  ]);
  // Los value objects del agregado se mapean con el mismo par de métodos, resueltos
  // por sobrecarga: un VO es un subdocumento como cualquier otro, y por eso un VO
  // dentro de otro sale generado sin decisión que tomar.
  const voMappers = valueObjectsOf(model, involved).flatMap((vo) => [
    renderVoToDomain(model, vo, imports),
    renderVoToDocument(model, vo, imports)
  ]);

  const fields = [];
  if (paginated) {
    fields.push(
      `    private static final Sort TIE_BREAKER = Sort.by(Sort.Order.asc("${entity.idField?.name ?? 'id'}"));\n`
    );
  }
  fields.push(...claim.adapterValueFields(model, entity));
  fields.push(...reconciliationClaim.adapterValueFields(model, entity));
  fields.push(`    private final ${entity.name}MongoRepository ${repoField};`);
  const ctorParams = [`${entity.name}MongoRepository ${repoField}`];
  const ctorAssigns = [`        this.${repoField} = ${repoField};`];
  // MongoTemplate solo donde hay reclamo: los dos lo necesitan porque ni findAndModify ni
  // una consulta acotada por la marca de espera se expresan con un repositorio derivado.
  if (claimMethods.length > 0) {
    imports.add('org.springframework.data.mongodb.core.MongoTemplate');
    fields.push('    private final MongoTemplate mongoTemplate;');
    ctorParams.push('MongoTemplate mongoTemplate');
    ctorAssigns.push('        this.mongoTemplate = mongoTemplate;');
  }
  const claimStore = reconciliationClaim.adapterCollaborator(model, entity);
  if (claimStore) {
    fields.push(`    private final ${claimStore.type} ${claimStore.field};`);
    ctorParams.push(`${claimStore.type} ${claimStore.field}`);
    ctorAssigns.push(`        this.${claimStore.field} = ${claimStore.field};`);
  }
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

    // ── Mapeo domain ↔ documento ─────────────────────────────────────────────

${[...mappers, ...voMappers].join('\n\n')}
}`;

  return {
    path: javaPath(model, REPO_PKG, `${entity.name}RepositoryImpl`),
    content: javaFile(subPackage(model, REPO_PKG), [...imports], body)
  };
}

/** Value objects que aparecen en las entidades de este agregado, transitivamente. */
function valueObjectsOf(model, involved) {
  const all = [...documentValueObjects(model)];
  const byName = new Map(all.map((vo) => [vo.name, vo]));
  const reached = new Set();
  const visit = (name) => {
    const vo = byName.get(name);
    if (!vo || reached.has(vo)) return;
    reached.add(vo);
    for (const sub of vo.fields) if (sub.kind === 'composite') visit(sub.javaType);
  };
  for (const entity of involved) {
    for (const field of entity.fields) {
      if (field.kind !== 'composite') continue;
      visit(field.list ? field.elementJavaType : field.javaType);
    }
  }
  return all.filter((vo) => reached.has(vo));
}

function renderToDomain(model, entity, imports) {
  const args = domainMembers(model, entity).map((member) => {
    const getter = `doc.get${capitalize(member.name)}()`;
    if (member.kind === 'field' && member.field.list) {
      if (member.field.kind !== 'composite') return getter;
      imports.add(`${subPackage(model, 'domain.valueobject')}.${member.field.elementJavaType}`);
      return `${getter}.stream().map(this::toDomain).toList()`;
    }
    if (member.kind === 'field' && member.field.kind === 'composite') {
      imports.add(`${subPackage(model, 'domain.valueobject')}.${member.field.javaType}`);
      return `toDomain(${getter})`;
    }
    if (member.kind === 'relationMany') {
      // El orden de un array de Mongo es el de INSERCIÓN, que tras un reorder ya no
      // es el del diseño: donde JPA ponía @OrderBy (lo aplicaba la consulta), aquí
      // el orden lo restablece el mapeo. Sin esto, la colección se devolvería en el
      // orden en que se guardó y no en el que el dominio declara.
      const ordering = orderingFieldOf(model, member.relation.entity);
      if (ordering) {
        imports.add('java.util.Comparator');
        return `${getter}.stream()
                        .sorted(Comparator.comparing(${member.relation.entity}Document::get${capitalize(ordering.name)}))
                        .map(this::toDomain)
                        .toList()`;
      }
      return `${getter}.stream().map(this::toDomain).toList()`;
    }
    if (member.kind === 'relationOne') {
      return `${getter} != null ? toDomain(${getter}) : null`;
    }
    return getter;
  });

  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) args.push('doc.getLockVersion()');

  return `    private ${entity.name} toDomain(${entity.name}Document doc) {
        return new ${entity.name}(
                ${args.join(',\n                ')});
    }`;
}

function renderToDocument(model, entity, imports) {
  const lines = [];
  for (const member of persistedMembers(model, entity)) {
    const setter = `doc.set${capitalize(member.name)}`;
    const getter = `domain.get${capitalize(member.name)}()`;

    if (member.kind === 'vo') {
      lines.push(`        ${setter}(toDocument(${getter}));`);
    } else if (member.kind === 'elementCollection') {
      imports.add('java.util.ArrayList');
      if (member.element.kind === 'vo') {
        lines.push(`        ${setter}(new ArrayList<>(${getter}.stream().map(this::toDocument).toList()));`);
      } else {
        lines.push(`        ${setter}(new ArrayList<>(${getter}));`);
      }
    } else if (member.kind === 'relationMany') {
      imports.add('java.util.ArrayList');
      lines.push(`        ${setter}(new ArrayList<>(${getter}.stream().map(this::toDocument).toList()));`);
    } else if (member.kind === 'relationOne' && member.relation?.backReference) {
      lines.push(
        `        // ${member.name}: ${entity.name} va anidada dentro de ${member.relation.entity}Document; no hay referencia de vuelta que escribir.`
      );
    } else if (member.kind === 'relationOne') {
      lines.push(`        ${setter}(${getter} != null ? toDocument(${getter}) : null);`);
    } else {
      lines.push(`        ${setter}(${getter});`);
    }
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    // La versión viaja dentro del documento: es lo que compara el update para
    // detectar que otro escribió por medio.
    lines.push('        doc.setLockVersion(domain.getLockVersion());');
  }

  return `    private ${entity.name}Document toDocument(${entity.name} domain) {
        ${entity.name}Document doc = new ${entity.name}Document();
${lines.join('\n')}
        return doc;
    }`;
}

function renderVoToDomain(model, vo, imports) {
  imports.add(`${subPackage(model, 'domain.valueobject')}.${vo.name}`);
  imports.add(`${subPackage(model, DOC_PKG)}.${vo.name}Document`);
  const args = vo.fields.map((sub) =>
    sub.kind === 'composite' ? `toDomain(doc.get${capitalize(sub.name)}())` : `doc.get${capitalize(sub.name)}()`
  );
  return `    private ${vo.name} toDomain(${vo.name}Document doc) {
        return doc == null ? null : new ${vo.name}(${args.join(', ')});
    }`;
}

function renderVoToDocument(model, vo, imports) {
  imports.add(`${subPackage(model, 'domain.valueobject')}.${vo.name}`);
  imports.add(`${subPackage(model, DOC_PKG)}.${vo.name}Document`);
  const lines = vo.fields.map((sub) => {
    const accessor = `value.${sub.name}()`;
    return sub.kind === 'composite'
      ? `        doc.set${capitalize(sub.name)}(toDocument(${accessor}));`
      : `        doc.set${capitalize(sub.name)}(${accessor});`;
  });
  return `    private ${vo.name}Document toDocument(${vo.name} value) {
        if (value == null) return null;
        ${vo.name}Document doc = new ${vo.name}Document();
${lines.join('\n')}
        return doc;
    }`;
}
