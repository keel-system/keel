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

import { loadExpectingAdapter, loadsExpecting } from './conditional-writes.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { domainMembers, domainSubPackage, capitalize } from './entities.js';
import { persistedMembers, orderingFieldOf, usesAuditableEntity } from './persistence-members.js';
import { orderingTieBreakerOf } from '@keel-system/keel-core/gen/relational';
import {
  renderPort,
  naturalKeyFinder,
  occupantFinders,
  uniqueFieldFinders,
  credentialFinders,
  naturalKeyBatchFinder,
  collectInternalEntities,
  rootId,
  PORT_PKG,
  REPO_PKG
} from './repositories.js';
import * as claim from './claim.js';
import { adapterArming } from './timer.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import { DOC_PKG } from './document-entities.js';
import { documentValueObjects } from './document-embeddables.js';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { inverseFindersOf } from '@keel-system/keel-core/gen/inverse-collections';
import { inverseAdapterMethods } from './repositories.js';
import { refIdJava } from './persistence-members.js';
import { finderFields, mongoFinderMethods } from './finders.js';
import { readScopeMongoMethods } from './read-scope.js';
import { listsUnscoped } from '@keel-system/keel-core/gen/features';
import { textFoldImport } from './text-fold.js';
import * as lifecycle from './data-lifecycle.js';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];

  const files = [];
  for (const entity of model.entities.filter((e) => e.persisted && e.isAggregateRoot)) {
    const paginated = model.services.some(
      (group) => group.entity === entity.name && group.operations.some((op) => op.paginated)
    );
    // Un listado acotado (DSL 2.27) no da el list(pageable) sin scope: la única puerta paginada de esa raíz es su
    // finder, que exige el ReadScope. Dejar la otra al lado es dejar el camino que no filtra a un import de distancia.
    const listed = listsUnscoped(model, entity);
    const batchLookup = Boolean(idBatchReason(model, entity));
    files.push(renderPort(model, entity, listed, batchLookup));
    files.push(renderMongoRepository(model, entity));
    files.push(renderAdapter(model, entity, paginated, batchLookup, listed));
  }
  return files;
}

function renderMongoRepository(model, entity) {
  const imports = new Set([
    `${subPackage(model, DOC_PKG)}.${entity.name}Document`,
    'org.springframework.data.mongodb.repository.MongoRepository',
    'java.util.UUID'
  ]);
  const id = rootId(entity);
  for (const name of id.imports) imports.add(name);

  let methods = '';
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    imports.add('java.util.Optional');
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods = `\n\n    Optional<${entity.name}Document> ${lifecycle.liveFinder(entity, finder.store.name)}(${finder.store.signature});`;
  }
  // El puerto es el MISMO en las dos ramas (lo reexporta repositories.js), así que lo que
  // se declare allí hay que implementarlo aquí o el adaptador no compila.
  for (const occupant of occupantFinders(model, entity)) {
    imports.add('java.util.Optional');
    for (const param of occupant.params) for (const name of param.imports) imports.add(name);
    methods += `\n\n    Optional<${entity.name}Document> ${lifecycle.liveFinder(entity, occupant.store.name)}(${occupant.store.signature});`;
  }
  for (const unique of uniqueFieldFinders(model, entity)) {
    imports.add('java.util.Optional');
    for (const param of unique.params) for (const name of param.imports) imports.add(name);
    methods += `\n\n    Optional<${entity.name}Document> ${lifecycle.liveFinder(entity, unique.store.name)}(${unique.store.signature});`;
  }
  for (const credential of credentialFinders(model, entity)) {
    imports.add('java.util.Optional');
    // `Containing` sobre un array: Spring Data MongoDB lo deriva como un match de elemento, igual
    // que la rama relacional lo deriva sobre su @ElementCollection.
    methods += `

    Optional<${entity.name}Document> ${lifecycle.liveFinder(entity, credential.name)}(${credential.javaType} ${credential.field.replace(/s$/, '')});`;
  }
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    methods += `\n\n    List<${entity.name}Document> ${lifecycle.liveFinder(entity, batchFinder.name)}(${batchFinder.signature});`;
  }
  for (const inverse of inverseFindersOf(model, entity.name)) {
    const owner = refIdJava(model, inverse.owner);
    imports.add('java.util.List');
    for (const name of owner.imports) imports.add(name);
    methods += `\n\n    List<${entity.name}Document> ${lifecycle.liveFinder(entity, inverse.finder)}(${owner.javaType} ${inverse.relation}Id);`;
  }
  // El ciclo de vida del dato (DSL 2.28): la carga y el listado vivos y la carga de la borrada.
  const listed = listsUnscoped(model, entity) && model.services.some((group) => group.entity === entity.name && group.operations.some((op) => op.paginated));
  const lifecycleMethods = lifecycle.mongoRepositoryMethods(model, entity, id, finder, listed, imports);
  if (lifecycleMethods.length > 0) methods += `\n\n${lifecycleMethods.join('\n\n')}`;

  const body = `public interface ${entity.name}MongoRepository extends MongoRepository<${entity.name}Document, ${id.javaType}> {${methods}\n}`;

  return {
    path: javaPath(model, REPO_PKG, `${entity.name}MongoRepository`),
    content: javaFile(subPackage(model, REPO_PKG), [...imports], body)
  };
}

function renderAdapter(model, entity, paginated, batchLookup, listed = paginated) {
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
  const id = rootId(entity);
  for (const name of id.imports) imports.add(name);

  const methods = [
    `    @Override
    public Optional<${entity.name}> findById(${id.javaType} ${id.name}) {
        return ${repoField}.${lifecycle.liveFinder(entity, 'findById')}(${id.name}).map(this::toDomain);
    }`
  ];
  // La carga que compara la versión (api.concurrency, D4), la misma que la del adaptador relacional.
  if (loadsExpecting(model, entity)) methods.push(loadExpectingAdapter(model, entity, id, imports));
  if (batchLookup) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    methods.push(`    @Override
    public List<${entity.name}> findAllById(Collection<${id.javaType}> ids) {
        return ${repoField}.findAllById(ids).stream().map(this::toDomain).toList();
    }`);
  }
  methods.push(...inverseAdapterMethods(model, entity, repoField, imports, lifecycle.liveFinder(entity, '')));
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    if (finder.store.folds) imports.add(textFoldImport(model));
    methods.push(`    @Override
    public Optional<${entity.name}> ${finder.name}(${finder.signature}) {
        return ${repoField}.${lifecycle.liveFinder(entity, finder.store.name)}(${finder.store.args}).map(this::toDomain);
    }`);
  }
  for (const occupant of occupantFinders(model, entity)) {
    for (const param of occupant.params) for (const name of param.imports) imports.add(name);
    if (occupant.store.folds) imports.add(textFoldImport(model));
    methods.push(`    @Override
    public Optional<${entity.name}> ${occupant.name}(${occupant.signature}) {
        return ${repoField}.${lifecycle.liveFinder(entity, occupant.store.name)}(${occupant.store.args}).map(this::toDomain);
    }`);
  }
  for (const unique of uniqueFieldFinders(model, entity)) {
    for (const param of unique.params) for (const name of param.imports) imports.add(name);
    if (unique.store.folds) imports.add(textFoldImport(model));
    methods.push(`    @Override
    public Optional<${entity.name}> ${unique.name}(${unique.signature}) {
        return ${repoField}.${lifecycle.liveFinder(entity, unique.store.name)}(${unique.store.args}).map(this::toDomain);
    }`);
  }
  for (const credentialAdapter of credentialFinders(model, entity)) {
    const arg = credentialAdapter.field.replace(/s$/, '');
    methods.push(`    @Override
    public Optional<${entity.name}> ${credentialAdapter.name}(${credentialAdapter.javaType} ${arg}) {
        return ${repoField}.${lifecycle.liveFinder(entity, credentialAdapter.name)}(${arg}).map(this::toDomain);
    }`);
  }
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    methods.push(`    @Override
    public List<${entity.name}> ${batchFinder.name}(${batchFinder.signature}) {
        return ${repoField}.${lifecycle.liveFinder(entity, batchFinder.name)}(${batchFinder.args}).stream().map(this::toDomain).toList();
    }`);
  }
  if (paginated) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    imports.add('org.springframework.data.domain.PageRequest');
    imports.add('org.springframework.data.domain.Sort');
    if (listed) {
      methods.push(`    @Override
    public Page<${entity.name}> list(Pageable pageable) {
        return ${lifecycle.listCall(entity, repoField)}.map(this::toDomain);
    }`);
    }
    methods.push(`    /**
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
  // Los finders de las búsquedas (DSL 2.22): los filtros del diseño sobre el documento, con MongoTemplate.
  const searchFinders = mongoFinderMethods(model, entity, imports);
  methods.push(...searchFinders);
  // La lectura acotada (DSL 2.27): las cargas y el predicado que los finders acotados suman a su Criteria.
  const scopedReads = readScopeMongoMethods(model, entity, imports);
  methods.push(...scopedReads);

  // Drenaje de eventos de dominio: save() es el único punto por el que pasa todo
  // cambio persistido del agregado. Va dentro de la transacción, que aquí es real
  // gracias al MongoTransactionManager: con reliability: outbox, el documento y su
  // outbox_event tienen que entrar en el mismo commit o en ninguno.
  const emitsEvents = model.events.some((event) => event.aggregates.includes(entity.name));
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
  // Y las marcas del ciclo de vida del dato (DSL 2.28) que el dominio no conoce: la de la anonimización.
  const carried = lifecycle.carriedMarks(model, entity);
  const carryAuditArgs = [
    model.audit?.timestamps === 'all' ? 'existing.getCreatedAt()' : null,
    model.audit?.authorship === 'all' ? 'existing.getCreatedBy()' : null
  ].filter(Boolean);
  const carryCalls = [
    ...(carriesAudit ? [`document.carryCreationAudit(${carryAuditArgs.join(', ')});`] : []),
    ...carried.map((mark) => `document.set${capitalize(mark.field)}(existing.get${capitalize(mark.field)}());`)
  ];
  const carryBody = carryCalls.length === 1
    ? `existing -> ${carryCalls[0].replace(/;$/, '')}`
    : `existing -> {\n${carryCalls.map((call) => `                    ${call}`).join('\n')}\n                }`;
  const documentExpr = carryCalls.length > 0
    ? `${entity.name}Document document = toDocument(entity);
        ${repoField}
                .findById(entity.${id.getter}())
                .ifPresent(${carryBody});
        `
    : '';
  const savedExpr = carryCalls.length > 0 ? `${repoField}.save(document)` : `${repoField}.save(toDocument(entity))`;

  // El armado del plazo (DSL 2.26): el estado que el documento tenía en la base dice si la entidad ENTRA en el estado.
  // Se lee antes de reemplazarlo, dentro de la transacción del caso de uso (MongoTransactionManager).
  const lifecycleField = entity.lifecycle ? capitalize(entity.lifecycle.field) : null;
  const arming = entity.lifecycle ? adapterArming(model, entity, imports, `previous${lifecycleField}`) : null;
  if (arming) {
    imports.add(`${subPackage(model, 'domain.enums')}.${entity.lifecycle.enumType}`);
    imports.add('org.springframework.transaction.annotation.Transactional');
  }
  const previousRead = arming
    ? `        ${entity.lifecycle.enumType} previous${lifecycleField} = entity.${id.getter}() == null ? null
                : ${repoField}.findById(entity.${id.getter}()).map(${entity.name}Document::get${lifecycleField}).orElse(null);
${arming.before}\n`
    : '';
  const saveBody = emitsEvents || arming
    ? `${previousRead}        ${documentExpr}${entity.name} saved = toDomain(${savedExpr});
${arming ? `${arming.after}\n` : ''}${emitsEvents ? '        entity.pullDomainEvents().forEach(eventPublisher::publishEvent);\n' : ''}        return saved;`
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
    `    @Override${emitsEvents || arming ? '\n    @Transactional' : ''}
    public ${entity.name} save(${entity.name} entity) {
${saveBody}
    }`,
    ...(lifecycle.mongoAdapterMethods(model, entity, id, repoField, finder, imports) ?? [
      `    @Override
    public void deleteById(${id.javaType} ${id.name}) {
        ${repoField}.deleteById(${id.name});
    }`
    ])
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
  fields.push(...finderFields(model, entity));
  fields.push(...claim.adapterValueFields(model, entity));
  fields.push(...reconciliationClaim.adapterValueFields(model, entity));
  fields.push(`    private final ${entity.name}MongoRepository ${repoField};`);
  const ctorParams = [`${entity.name}MongoRepository ${repoField}`];
  const ctorAssigns = [`        this.${repoField} = ${repoField};`];
  if (arming) {
    fields.push(...arming.fields);
    ctorParams.push(...arming.params);
    ctorAssigns.push(...arming.assigns);
  }
  // MongoTemplate solo donde hay reclamo o búsqueda: ni findAndModify, ni una consulta acotada por la marca de espera,
  // ni los filtros de un finder (DSL 2.22) se expresan con un repositorio derivado.
  if (claimMethods.length > 0 || searchFinders.length > 0 || scopedReads.length > 0) {
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
                        .sorted(Comparator.comparing(${member.relation.entity}Document::get${capitalize(ordering.name)})
                                .thenComparing(child -> String.valueOf(child.get${capitalize(orderingTieBreakerOf(model, member.relation.entity))}())))
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
      if (member.folded) {
        imports.add(textFoldImport(model));
        lines.push(
          `        doc.set${capitalize(member.folded.name)}(TextFold.${member.folded.accents ? 'foldCaseAndAccents' : 'foldCase'}(${getter}));`
        );
      }
      if (member.ranked) lines.push(`        doc.set${capitalize(member.ranked.name)}(${getter} != null ? ${getter}.ordinal() : null);`);
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
