// Persistencia hexagonal completa (patrón del prototipo): por cada raíz de
// agregado persistida se generan (1) el puerto <E>Repository en
// domain/repository, (2) la interfaz Spring Data <E>JpaRepository y (3) el
// adaptador <E>RepositoryImpl con el mapeo domain↔JPA inline (toDomain/toJpa),
// derivado campo a campo de los mismos miembros que usan dominio y Jpa.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainMembers, domainSubPackage, capitalize } from './entities.js';
import { jpaMembers, backReferenceTo, JPA_PKG } from './persistence-entities.js';
import { isRefTarget } from './ref-resolvers.js';
import { isBaseType } from '../lib/type-mapper.js';
import { pluralize } from '../lib/naming.js';
import * as claim from './claim.js';
import * as reconciliationClaim from './reconciliation-claim.js';

export const PORT_PKG = 'domain.repository';
export const REPO_PKG = 'infrastructure.persistence.repositories';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind === 'document') return [];

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

/**
 * Parámetros del finder de la clave natural, resueltos contra los MIEMBROS del
 * agregado y no contra sus campos escalares.
 *
 * La diferencia la marca una clave natural que atraviesa una referencia a otro
 * agregado (`naturalKey: [owner, slug]`): el diseño la nombra `owner`, pero ni el
 * dominio ni el espejo tienen esa propiedad — guardan `ownerId`, un `UUID`. Spring
 * Data valida los finders derivados al construir el contexto, así que un
 * `findByOwnerAndSlug(String, …)` no falla al compilar: **tumba el arranque** con
 * PropertyReferenceException, y solo se ve al levantar la aplicación.
 */
export function naturalKeyParams(model, entity) {
  const members = domainMembers(model, entity);
  return (entity.naturalKey ?? []).map((fieldName) => {
    // Por nombre propio (campo escalar) o por el nombre de la relación que el
    // diseño usa (`owner` → miembro `ownerId`).
    const member = members.find((m) => m.name === fieldName || m.relation?.name === fieldName);
    if (member) {
      // Un miembro escalar ENVUELVE al campo resuelto, y los imports del tipo
      // (java.time.LocalDate, java.math.BigDecimal…) viven ahí dentro: tomarlos
      // solo del miembro deja el finder citando un tipo que nadie importa.
      return {
        name: member.name,
        javaType: member.javaType,
        imports: member.imports ?? member.field?.imports ?? []
      };
    }

    const field = entity.fields.find((f) => f.name === fieldName);
    if (!field) {
      model.warnings.push(
        `persistence.entities.${entity.name}: la clave natural nombra "${fieldName}", que no es un campo ni una relación del agregado; el finder derivado se genera con ese nombre tal cual y Spring Data lo rechazará al arrancar.`
      );
    }
    return { name: fieldName, javaType: field?.javaType ?? 'String', imports: field?.imports ?? [] };
  });
}

/**
 * El finder de la clave natural, POR LOTE.
 *
 * Existe por el caso simétrico al del `embed`: un command cuya entrada trae una lista
 * acotada (`maxItems`) y cuyo handler tiene que consultar algo una vez por elemento. Los
 * resolvers por lote salen de un `embed` en la SALIDA; aquí la lista está en la ENTRADA,
 * así que el puerto solo traía el finder de un elemento y el camino de menor resistencia
 * era el bucle. Ocurrió tal cual: un handler comprobando la lista de supresión con un
 * `findByApplicationIdAndAddress(...)` por destinatario, hasta 20 consultas por petición
 * (`conventions/read-composition.md`). Añadir el método era territorio del agente de
 * código; el pase de calidad, que tiene prohibido cambiar firmas, solo pudo reportarlo.
 *
 * El enlace es mecánico y no una corazonada: el último componente de la clave natural y
 * los elementos de esa lista son **el mismo value type declarado** (`EmailAddress`), que
 * es precisamente lo que el diseño dice al ponerle nombre. Dos `string` no se atarían —
 * por eso se exige un tipo con nombre y no un primitivo.
 */
export function naturalKeyBatchFinder(model, entity) {
  const finder = naturalKeyFinder(model, entity);
  if (!finder) return null;

  const last = entity.naturalKey[entity.naturalKey.length - 1];
  const field = entity.fields.find((f) => f.name === last);
  // Un tipo con nombre, no un primitivo: `string` no ata nada con `string`.
  if (!field || field.list || !field.typeName || isBaseType(field.typeName)) return null;

  const listed = (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .flatMap((operation) => operation.bodyFields ?? [])
    .some((input) => input.list && input.typeName === field.typeName);
  if (!listed) return null;

  const leading = finder.params.slice(0, -1);
  const tail = finder.params[finder.params.length - 1];
  // `address` → `addresses`, no `addresss`: el parámetro se lee en el handler y un plural
  // mal formado es la clase de detalle que se copia de una operación a la siguiente.
  const plural = pluralize(tail.name);
  return {
    typeName: field.typeName,
    elementType: field.javaType,
    name: 'findAllBy' + finder.params.map((p) => capitalize(p.name)).join('And') + 'In',
    signature: [...leading.map((p) => `${p.javaType} ${p.name}`), `Collection<${field.javaType}> ${plural}`].join(', '),
    args: [...leading.map((p) => p.name), plural].join(', '),
    imports: finder.params.flatMap((p) => p.imports ?? [])
  };
}

export function naturalKeyFinder(model, entity) {
  const params = naturalKeyParams(model, entity);
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
//
// Es agnóstico del motor por construcción —nombra el dominio y Page/Pageable, nada
// más—, así que la rama documental lo REUTILIZA en vez de tener uno propio: el
// contrato que ve el dominio no puede depender de dónde se guarda el agregado.
export function renderPort(model, entity, paginated, batchLookup) {
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
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods.push(`    Optional<${entity.name}> ${finder.name}(${finder.signature});`);
  }
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    methods.push(`    /**
     * El mismo finder, para una colección de ${batchFinder.typeName}: UNA consulta en vez
     * de una por elemento. Alguna operación recibe esos valores en una lista acotada de su
     * entrada, y comprobarlos en un bucle es N consultas por petición.
     *
     * <p>El orden de salida NO está garantizado y lo que no exista simplemente no aparece:
     * quien llama indexa por ${batchFinder.typeName} lo que le vuelve.
     */
    List<${entity.name}> ${batchFinder.name}(${batchFinder.signature});`);
  }
  if (paginated) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    methods.push(`    Page<${entity.name}> list(Pageable pageable);`);
  }
  // El reclamo de los barridos. Va en el puerto —y no en un servicio aparte— porque es
  // una consulta de persistencia como las demás, y porque su forma correcta depende del
  // motor: dejarla fuera es dejar que la escriba quien no sabe contra qué corre.
  methods.push(...claim.portMethods(model, entity, imports));
  // Y la guarda de una fila con un efecto externo irreversible detrás: mismo argumento,
  // sujeto distinto (una fila que el llamante ya eligió, no un lote que se elige aquí).
  methods.push(...claim.guardPortMethods(model, entity, imports));
  // El del barrido de reconciliación es otro reclamo distinto —marca persistida con
  // caducidad, no transición del lifecycle— y por eso vive en su propio módulo.
  methods.push(...reconciliationClaim.portMethods(model, entity, imports));
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

  // Colecciones hijas del agregado: se traen EN LA MISMA consulta al leer UN solo
  // agregado. Con @BatchSize costarían una consulta extra por colección; con el grafo,
  // ninguna.
  //
  // Y solo aquí: un @EntityGraph sobre una consulta PAGINADA obliga a Hibernate a traer
  // todas las filas y paginar EN MEMORIA (HHH000104), que es cambiar dos consultas
  // acotadas por una que crece con la tabla. Para el listado, el lote.
  const childCollections = jpaMembers(model, entity)
    .filter((member) => member.kind === 'relationMany')
    .map((member) => member.name);
  let graph = '';
  if (childCollections.length > 0) {
    imports.add('org.springframework.data.jpa.repository.EntityGraph');
    const paths = childCollections.map((name) => JSON.stringify(name)).join(", ");
    graph = `    @EntityGraph(attributePaths = { ${paths} })` + String.fromCharCode(10);
  }

  let methods = '';
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    imports.add('java.util.Optional');
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    // La clave natural es la otra lectura de UN agregado: mismo grafo, misma razón.
    methods = `\n\n${graph}    Optional<${entity.name}Jpa> ${finder.name}(${finder.signature});`;
  }
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    // Derivado por Spring Data igual que el unitario: el sufijo `In` sobre el último
    // componente de la clave es lo único que cambia.
    methods += `\n\n${graph}    List<${entity.name}Jpa> ${batchFinder.name}(${batchFinder.signature});`;
  }

  // findById lo hereda de JpaRepository: su grafo hay que declararlo sobrescribiendo la
  // firma, y es la lectura de un agregado más frecuente de todas.
  if (graph) {
    imports.add('java.util.Optional');
    methods += `

${graph}    @Override
    Optional<${entity.name}Jpa> findById(UUID id);`;
  }

  const claimMethods = [
    ...claim.jpaRepositoryMethods(model, entity, imports),
    ...claim.guardJpaRepositoryMethods(model, entity, imports),
    ...reconciliationClaim.jpaRepositoryMethods(model, entity, imports)
  ];
  if (claimMethods.length > 0) methods += `\n\n${claimMethods.join('\n\n')}`;

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
  const finder = naturalKeyFinder(model, entity);
  if (finder) {
    for (const param of finder.params) for (const name of param.imports) imports.add(name);
    methods.push(`    @Override
    public Optional<${entity.name}> ${finder.name}(${finder.signature}) {
        return ${jpaField}.${finder.name}(${finder.args}).map(this::toDomain);
    }`);
  }
  const batchFinder = naturalKeyBatchFinder(model, entity);
  if (batchFinder) {
    imports.add('java.util.Collection');
    imports.add('java.util.List');
    for (const name of batchFinder.imports) imports.add(name);
    methods.push(`    @Override
    public List<${entity.name}> ${batchFinder.name}(${batchFinder.signature}) {
        return ${jpaField}.${batchFinder.name}(${batchFinder.args}).stream().map(this::toDomain).toList();
    }`);
  }
  if (paginated) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    imports.add('org.springframework.data.domain.PageRequest');
    imports.add('org.springframework.data.domain.Sort');
    methods.push(`    @Override
    public Page<${entity.name}> list(Pageable pageable) {
        return ${jpaField}.findAll(withStableOrder(pageable)).map(this::toDomain);
    }

    /**
     * Añade el id como último criterio de orden si no está ya. Sin desempate, dos
     * páginas consecutivas de la misma consulta pueden repetir una fila y omitir
     * otra: cuando el ORDER BY empata, la base de datos no garantiza un orden
     * estable entre consultas. Se aplica también al orden que pida el cliente,
     * que es justo el caso que un @PageableDefault no cubre.
     */
    private static Pageable withStableOrder(Pageable pageable) {
        Sort sort = pageable.getSort();
        if (sort.getOrderFor("${entity.idField?.name ?? 'id'}") != null) {
            return pageable;
        }
        return PageRequest.of(pageable.getPageNumber(), pageable.getPageSize(), sort.and(TIE_BREAKER));
    }`);
  }
  methods.push(...claim.adapterMethods(model, entity, imports, jpaField));
  methods.push(...claim.guardAdapterMethods(model, entity, imports, jpaField));
  methods.push(...reconciliationClaim.adapterMethods(model, entity, imports, jpaField));
  // Drenaje de eventos de dominio: save() es el único punto por el que pasa
  // todo cambio persistido del agregado, así que aquí se publican los eventos
  // que la raíz acumuló. Va dentro de la transacción: el bridge decide después
  // si se escriben al outbox (misma transacción) o se envían tras el commit.
  const emitsEvents = model.events.some((event) => event.aggregates.includes(entity.name));
  if (emitsEvents) {
    imports.add('org.springframework.context.ApplicationEventPublisher');
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

  // Las escrituras llevan @Transactional SIEMPRE, no solo cuando drenan eventos: la clase
  // es readOnly y sin la anotación de método una escritura sin transacción ambiente iría
  // contra una transacción de solo lectura. Con transacción ambiente (el caso normal) la
  // propagación por defecto se une a ella y no cambia nada.
  imports.add('org.springframework.transaction.annotation.Transactional');
  // Menos en UN caso, y es el de la copia local de una dependencia `replicated`: ahí el
  // save() se invoca desde la HIDRATACIÓN (onMiss), que ocurre dentro del camino de
  // LECTURA — el query handler ya abrió su transacción como readOnly=true, y unirse a ella
  // es escribir dentro de una transacción física de solo lectura. Es genérico del patrón
  // `replicated`, no de un dominio concreto: donde hay onMiss hay escritura en la lectura.
  const isReplica = Boolean(entity.replicaOf);
  if (isReplica) {
    imports.add('org.springframework.transaction.annotation.Propagation');
  }
  const saveTransaction = isReplica
    ? `    /**
     * Guarda la copia local en su PROPIA transacción.
     *
     * <p>{@code REQUIRES_NEW} no es decoración: a este método se llega también desde la
     * hidratación de la réplica ({@code onMiss}), que corre dentro de una consulta — y esa
     * transacción es {@code readOnly = true}. Unirse a ella con la propagación por defecto
     * sería escribir en una transacción física de solo lectura. Suspenderla y abrir una
     * propia es lo único que hace la escritura posible ahí.
     *
     * <p>Contrapartida deliberada: la copia queda commiteada aunque la lectura que la
     * provocó falle después. Es lo que se quiere — la réplica es un dato cacheado de otro
     * servicio, no parte del resultado de esta consulta.
     */
    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)`
    : `    @Override
    @Transactional`;
  methods.push(
    `${saveTransaction}
    public ${entity.name} save(${entity.name} entity) {
${saveBody}
    }`,
    `    @Override
    @Transactional
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

  const fields = [];
  if (paginated) {
    // Desempate universal del agregado: el orden declarado en el diseño es por
    // operación (lo aplica el controller), pero esto vale para toda consulta
    // paginada de esta raíz, venga el orden de donde venga.
    fields.push(
      `    private static final Sort TIE_BREAKER = Sort.by(Sort.Order.asc("${entity.idField?.name ?? 'id'}"));\n`
    );
  }
  fields.push(...claim.adapterValueFields(model, entity));
  fields.push(...reconciliationClaim.adapterValueFields(model, entity));
  fields.push(`    private final ${entity.name}JpaRepository ${jpaField};`);
  const ctorParams = [`${entity.name}JpaRepository ${jpaField}`];
  const ctorAssigns = [`        this.${jpaField} = ${jpaField};`];
  // La tienda del reclamo de reconciliación, solo donde hay uno: es la que arbitra qué
  // réplica se lleva cada candidato.
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

  const body = `/**
 * Adaptador del puerto ${entity.name}Repository.
 *
 * <p>El {@code @Transactional(readOnly = true)} de clase hace que este adaptador se baste solo.
 * Casi siempre es un no-op: los caminos normales (REST, listeners) llegan aquí dentro de la
 * transacción que abrió el {@code UseCaseMediator}, y la propagación por defecto se une a ella
 * ignorando el flag. Importa en el único camino que NO trae transacción: el barrido de
 * reconciliación, que se despacha con {@code dispatchWithoutTransaction} justo para poder colocar
 * sus commits. Sin esto, una consulta que devuelva un agregado con colecciones LAZY reventaría
 * ahí con {@code LazyInitializationException}.
 *
 * <p>Por eso mismo, <b>toda escritura lleva su {@code @Transactional} de método</b>: sin él
 * heredaría el {@code readOnly} de la clase. Si añades una consulta de escritura a este
 * adaptador, anótala — el fallo es en caliente y no silencioso, que es lo que se busca.
 */
@Component
@Transactional(readOnly = true)
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

export function collectInternalEntities(model, root) {
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
      // Un value object OPCIONAL ausente se devuelve como null, no como un objeto con todo a
      // null. La diferencia no es estética: `producto.precio()` devolviendo un Money vacío
      // hace que cualquier `!= null` del dominio mienta, y desde que el constructor compacto
      // exige los campos `required` del tipo, construirlo ahí directamente lanza.
      //
      // La marca de presencia es un campo REQUIRED del propio value object: si el objeto
      // está, ese campo está, porque es su invariante. Sin ninguno no hay marca posible —y
      // tampoco hace falta: un value object sin campos obligatorios tolera los nulls—.
      // La rama documental ya lo hacía (`doc == null ? null : ...`); esta era la que faltaba.
      const marca = vo.fields.find((sub) => sub.required);
      if (member.field.required || !marca) {
        return `new ${vo.name}(${jpaSubs.join(', ')})`;
      }
      const presente = `jpa.get${capitalize(member.name)}${capitalize(marca.name)}()`;
      return `${presente} == null ? null : new ${vo.name}(${jpaSubs.join(', ')})`;
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
