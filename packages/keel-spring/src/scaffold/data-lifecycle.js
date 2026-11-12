// El CICLO DE VIDA DEL DATO (DSL 2.28: `deletion: logical`, `restorableFor`/`restores` y `retention`) en keel-spring:
// incremento 1 de PLAN-DSL-228-CICLO-DE-VIDA.md. Lo que decide QUÉ (qué raíces, la columna, las unicidades entre vivas,
// el sustituto, la aritmética de la ventana y del corte, los parámetros del barrido, las notas) es de keel-core
// (gen/data-lifecycle.js, gen/relational.js, gen/timer-plan.js); aquí solo se escribe en Java:
//
//   · `deletedAt` (y `anonymizedAt`, D11) en el espejo JPA o documental: los pone el generador, no el dominio (D1).
//   · Las lecturas VIVAS del adaptador: cada finder derivado del puerto gana `AndDeletedAtIsNull`, el listado entero es
//     `findAllByDeletedAtIsNull` y los finders de búsqueda suman el predicado a su Specification (D2). `findAllById`, la
//     lectura por referencia, NO lo lleva (D3).
//   · `deleteById` MARCA la fila (D1), y `restore`/`findDeletedBy<Clave>` la devuelven a la vida dentro de la ventana (D6).
//   · La retención: `<Raíz>Retention` (qué ha vencido, por lotes, y qué se hace con cada uno) y el recurrente del
//     cronómetro que la dispara en modo clúster (D8), en timer.js.

import { DELETED_AT, ANONYMIZED_AT, isLogicallyDeleted, persistedMembers, keyShadow } from '@keel-system/keel-core/gen/relational';
import { ANONYMOUS_PREFIX, deletedLookupOf, lifecycleRoots, retentionParameters } from '@keel-system/keel-core/gen/data-lifecycle';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { javaFile, javaPath, subPackage } from './render.js';

export const RETENTION_PKG = 'infrastructure.persistence.retention';

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** El sufijo de Spring Data que deja fuera lo borrado: `findBySubject` → `findBySubjectAndDeletedAtIsNull`. */
export const LIVE_SUFFIX = 'AndDeletedAtIsNull';

/** El nombre VIVO de un finder derivado: el mismo, con el sufijo si la raíz se borra lógicamente. */
export const liveFinder = (entity, name) => (isLogicallyDeleted(entity) ? `${name}${LIVE_SUFFIX}` : name);

/** La condición de vida en una consulta JPQL sobre el alias `alias`, o nada si la raíz se borra físicamente. */
export const jpqlLive = (entity, alias = 'e') => (isLogicallyDeleted(entity) ? ` and ${alias}.${DELETED_AT.field} is null` : '');

/** La línea que el finder relacional suma a su Specification (D2): lo borrado no se ve. */
export const JPA_LIVE_LINE = `            where.add(cb.isNull(root.get("${DELETED_AT.field}")));`;

/** La línea que el finder documental suma a su Criteria (D2). */
export const MONGO_LIVE_LINE = `        where.add(Criteria.where("${DELETED_AT.field}").is(null));`;

/** Lo que el modelo dice del ciclo de vida de una raíz (lifecycleRoots de keel-core), o null. */
export function lifecycleOf(model, entity) {
  return lifecycleRoots(model).find((root) => root.entity === entity.name) ?? null;
}

/** ¿Tiene alguna raíz del modelo retención? */
export const usesRetention = (model) => lifecycleRoots(model).some((root) => root.retention);

/** Las raíces con retención: `[{ entity, root }]`. */
export function retentionRoots(model) {
  return lifecycleRoots(model)
    .filter((root) => root.retention)
    .map((root) => ({ entity: model.entities.find((candidate) => candidate.name === root.entity), root }));
}

/** `VerificationCodeRetention`: el componente que sabe qué ha vencido y qué hacer con ello. */
export const retentionClass = (entityName) => `${entityName}Retention`;

/** `VerificationCodeRetentionTimer`: el recurrente del cronómetro que lo dispara. */
export const retentionTimerClass = (entityName) => `${entityName}RetentionTimer`;

/** La constante del `kind` en TimerKinds. */
export const retentionKindConstant = (entityName) =>
  `RETENTION_${entityName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

// ─── Las columnas del espejo ─────────────────────────────────────────────────────────────────────────────────────

/** Las marcas del generador en el espejo: `[{ field, column }]`. Fuera del dominio y del contrato (D1, D11). */
export function lifecycleMarks(model, entity) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle) return [];
  const marks = [];
  if (lifecycle.logical) marks.push(DELETED_AT);
  if (lifecycle.retention?.then === 'anonymize') marks.push(ANONYMIZED_AT);
  return marks;
}

/** Las declaraciones JPA de las marcas, con su comentario. */
export function jpaMarkDeclarations(model, entity, imports) {
  const marks = lifecycleMarks(model, entity);
  if (marks.length === 0) return [];
  imports.add('jakarta.persistence.Column');
  imports.add('java.time.Instant');
  return marks.map((mark) =>
    mark === DELETED_AT
      ? `    // Borrado lógico (DSL 2.28): cuándo se borró, o null si está viva. La pone deleteById y la quita restore; no
    // está en el dominio ni en el contrato, y ninguna lectura del puerto ve una fila con ella puesta.
    @Column(name = "${DELETED_AT.column}")
    private Instant ${DELETED_AT.field};`
      : `    // Cuándo la anonimizó su retención (DSL 2.28, D11). Sin la marca, el barrido volvería a tomarla en cada pasada.
    @Column(name = "${ANONYMIZED_AT.column}")
    private Instant ${ANONYMIZED_AT.field};`
  );
}

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────────────────────

/** El finder de la borrada más reciente por la clave natural (D6): `{ name, store, params }`, o null. */
export function deletedFinder(entity, keyFinder) {
  if (!keyFinder || !deletedLookupOf(entity)) return null;
  return {
    name: keyFinder.name.replace(/^findBy/, 'findDeletedBy'),
    jpa: `${keyFinder.store.name.replace(/^findBy/, 'findFirstBy')}And${capital(DELETED_AT.field)}IsNotNullOrderBy${capital(DELETED_AT.field)}Desc`,
    finder: keyFinder
  };
}

/** La declaración de `deleteById` en el puerto: con borrado lógico dice que marca. */
export function deletePortMethod(model, entity, id) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return `    void deleteById(${id.javaType} ${id.name});`;
  return `    /**
     * Borrado LÓGICO (persistence.${entity.name}.deletion: logical, DSL 2.28): marca la fila y no la elimina. Desde ese
     * momento ninguna lectura de este puerto la ve —salvo findAllById, la lectura por referencia— y sus claves únicas
     * quedan libres. Sobre una fila ya borrada o inexistente no hace nada.
     */
    void deleteById(${id.javaType} ${id.name});`;
}

/** Los métodos de restauración del puerto (D6). */
export function restorePortMethods(model, entity, id, keyFinder, imports) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.restore) return [];
  const methods = [];
  const deleted = deletedFinder(entity, keyFinder);
  if (deleted) {
    for (const param of keyFinder.params) for (const name of param.imports) imports.add(name);
    methods.push(`    /**
     * La fila BORRADA más reciente con esta clave, la única que tiene sentido restaurar (la clave queda libre al
     * borrar, así que puede haber varias). Las cargas normales no la ven.
     */
    Optional<${entity.name}> ${deleted.name}(${keyFinder.signature});`);
  }
  methods.push(`    /**
     * Devuelve a la vida una fila borrada (restores: ${entity.name}). Vacío si no hay ninguna borrada con ese id. Fuera de
     * la ventana (${windowText(lifecycle.restore)} desde el borrado) lanza ${lifecycle.restore.error}; si otra fila viva
     * ocupa ya su clave única, la constraint salta al restaurarla, con el 409 de esa unicidad.
     */
    Optional<${entity.name}> restore(${id.javaType} ${id.name});`);
  return methods;
}

const windowText = (restore) => (Number.isInteger(restore.days) ? `${restore.days} días` : `los días del parámetro ${restore.parameter}`);

// ─── El adaptador JPA ────────────────────────────────────────────────────────────────────────────────────────────

/** Los métodos del JpaRepository que pide el ciclo de vida: el listado vivo, la carga viva por id y la de la borrada. */
export function jpaRepositoryMethods(model, entity, id, graph, keyFinder, listed, imports) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return [];
  imports.add('java.util.Optional');
  const methods = [`${graph}    Optional<${entity.name}Jpa> findById${LIVE_SUFFIX}(${id.javaType} ${id.name});`];
  if (listed) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    methods.push(`    Page<${entity.name}Jpa> findAllBy${capital(DELETED_AT.field)}IsNull(Pageable pageable);`);
  }
  if (lifecycle.restore) {
    methods.push(`${graph}    Optional<${entity.name}Jpa> findById${'And'}${capital(DELETED_AT.field)}IsNotNull(${id.javaType} ${id.name});`);
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) methods.push(`${graph}    Optional<${entity.name}Jpa> ${deleted.jpa}(${keyFinder.store.signature});`);
  }
  return methods;
}

/** La llamada del listado entero del adaptador. */
export function listCall(entity, jpaField) {
  return isLogicallyDeleted(entity)
    ? `${jpaField}.findAllBy${capital(DELETED_AT.field)}IsNull(withStableOrder(pageable))`
    : `${jpaField}.findAll(withStableOrder(pageable))`;
}

/** Los colaboradores del adaptador que pide el ciclo de vida: `[{ type, name, import }]`. */
export function adapterCollaborators(model, entity) {
  const restore = lifecycleOf(model, entity)?.restore;
  if (!restore?.parameter) return [];
  const type = `${model.service.className}Parameters`;
  return [{ type, name: 'parameters', import: `${subPackage(model, 'domain.parameters')}.${type}` }];
}

/** El adaptador: `deleteById` que marca, `restore` y la carga de la borrada por la clave. */
export function jpaAdapterMethods(model, entity, id, jpaField, keyFinder, imports) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  imports.add('java.time.Instant');
  const methods = [];
  methods.push(`    @Override
    @Transactional
    public void deleteById(${id.javaType} ${id.name}) {
        // Borrado lógico (DSL 2.28, D1): se marca y no se elimina. La fila deja de verse en toda lectura del puerto y
        // su clave única queda libre (los índices únicos de la tabla solo cuentan las filas vivas).
        ${jpaField}.findById${LIVE_SUFFIX}(${id.name}).ifPresent(jpa -> jpa.set${capital(DELETED_AT.field)}(Instant.now()));
    }`);
  if (lifecycle.restore) {
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) {
      if (keyFinder.store.folds) imports.add(`${subPackage(model, 'domain.text')}.TextFold`);
      methods.push(`    @Override
    public Optional<${entity.name}> ${deleted.name}(${keyFinder.signature}) {
        return ${jpaField}.${deleted.jpa}(${keyFinder.store.args}).map(this::toDomain);
    }`);
    }
    methods.push(restoreMethod(model, entity, id, lifecycle.restore, imports, (idName) => `${jpaField}.findByIdAnd${capital(DELETED_AT.field)}IsNotNull(${idName})`, (variable) => `${jpaField}.saveAndFlush(${variable})`));
  }
  return methods;
}

/**
 * `restore`, el mismo en las dos ramas salvo cómo se carga la borrada y cómo se guarda. La ventana es la de keel-core
 * (`isRestorable`): restaurable mientras `deletedAt + días > ahora`. El guardado se FUERZA aquí (flush) para que, si una
 * fila viva ocupa ya la clave, la unicidad salte dentro de esta llamada y no al commit.
 */
function restoreMethod(model, entity, id, restore, imports, loadDeleted, saveFlushed) {
  imports.add('java.time.Duration');
  imports.add('java.time.Instant');
  imports.add('org.springframework.transaction.annotation.Transactional');
  const error = operationError(model, restoringOperationOf(model, entity), restore.error);
  imports.add(`${subPackage(model, 'domain.errors')}.${error.exceptionClass}`);
  const days = Number.isInteger(restore.days) ? `${restore.days}L` : `parameters.${restore.parameter}().longValue()`;
  const message = JSON.stringify(`${entity.name} borrado hace más de ${windowText(restore)}: ya no se puede restaurar.`);
  const args = [message, ...(error.dynamicStatus ? [String(error.http ?? 409)] : [])];
  const mirror = model.persistenceKind === 'document' ? `${entity.name}Document` : `${entity.name}Jpa`;
  return `    @Override
    @Transactional
    public Optional<${entity.name}> restore(${id.javaType} ${id.name}) {
        Optional<${mirror}> deleted = ${loadDeleted(id.name)};
        if (deleted.isEmpty()) {
            return Optional.empty();
        }
        ${mirror} row = deleted.get();
        // La ventana (restorableFor, D6): restaurable mientras deletedAt + ${windowText(restore)} sea posterior a ahora.
        if (!row.get${capital(DELETED_AT.field)}().plus(Duration.ofDays(${days})).isAfter(Instant.now())) {
            throw new ${error.exceptionClass}(${args.join(', ')});
        }
        row.set${capital(DELETED_AT.field)}(null);
        return Optional.of(toDomain(${saveFlushed('row')}));
    }`;
}

/** La operación que restaura una raíz: la que declara `restores`. */
function restoringOperationOf(model, entity) {
  return (model.services ?? []).flatMap((group) => group.operations ?? []).find((operation) => operation.restores === entity.name)?.name;
}

// ─── La retención ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la anonimización toca, por miembro del espejo (D9): `{ root: [{ setter, value, shadow? }], children: [{
 * relation, jpa, sets }] }`. Un opcional va a null; un obligatorio, al sustituto `anon-<id>` de la RAÍZ. Una sombra
 * plegada (T7) se reescribe con el valor plegado del sustituto, o a null.
 */
export function anonymizePlan(model, root) {
  const entity = model.entities.find((candidate) => candidate.name === root.entity);
  const byEntity = new Map(root.retention.anonymize.map((member) => [member.entity, member.fields]));
  const setsOf = (owner) => {
    const fields = byEntity.get(owner.name) ?? [];
    const members = persistedMembers(model, owner);
    const sets = [];
    for (const { name, required } of fields) {
      const member = members.find((candidate) => candidate.name === name);
      if (member?.kind === 'vo') {
        for (const sub of member.subs) sets.push({ setter: `set${capital(sub.jpaField ?? `${name}${capital(sub.voAccessor)}`)}`, value: null });
        continue;
      }
      const field = owner.fields.find((candidate) => candidate.name === name);
      const shadow = field ? keyShadow(field) ?? (field.fold || field.filterFold ? { name: (field.fold ?? field.filterFold).shadow, accents: (field.fold ?? field.filterFold).accents } : null) : null;
      sets.push({ setter: `set${capital(name)}`, value: required ? 'substitute' : null, shadow: shadow ? { setter: `set${capital(shadow.name)}`, accents: Boolean(shadow.accents) } : null });
    }
    return sets;
  };
  const children = persistedMembers(model, entity)
    .filter((member) => member.kind === 'relationMany' && byEntity.has(member.relation.entity))
    .map((member) => {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      return { relation: member.name, jpa: `${child.name}Jpa`, sets: setsOf(child) };
    });
  return { entity, root: setsOf(entity), children };
}

/** Lo que la frontera de keel-spring no sabe anonimizar todavía (miembros que no son escalares ni value objects). */
export function anonymizeGaps(model) {
  const gaps = [];
  for (const { root, entity } of retentionRoots(model)) {
    if (root.retention.then !== 'anonymize') continue;
    const reachable = new Set([entity.name, ...persistedMembers(model, entity).filter((m) => m.kind === 'relationMany').map((m) => m.relation.entity)]);
    for (const member of root.retention.anonymize) {
      if (!reachable.has(member.entity)) gaps.push(`${member.entity} (no es la raíz ni una hija uno-a-muchos de ${entity.name})`);
      const owner = model.entities.find((candidate) => candidate.name === member.entity);
      const members = persistedMembers(model, owner);
      for (const field of member.fields) {
        const kind = members.find((candidate) => candidate.name === field.name)?.kind;
        if (kind !== 'scalar' && kind !== 'vo') gaps.push(`${member.entity}.${field.name} (${kind ?? 'sin columna'})`);
      }
    }
  }
  return gaps;
}

/** Los archivos de la retención: un componente por raíz con retención (la rama relacional; la documental, en document-lifecycle). */
export function generate(model) {
  const document = model.persistenceKind === 'document';
  return retentionRoots(model).map(({ entity, root }) => (document ? mongoRetention(model, entity, root) : jpaRetention(model, entity, root)));
}

function jpaRetention(model, entity, root) {
  const className = retentionClass(entity.name);
  const jpaRepository = `${entity.name}JpaRepository`;
  const field = decap(jpaRepository);
  const id = entity.idField;
  const imports = new Set([
    `${subPackage(model, 'infrastructure.persistence.repositories')}.${jpaRepository}`,
    'java.time.Instant',
    'java.util.List',
    'org.springframework.data.domain.PageRequest',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.annotation.Transactional',
    ...(id.imports ?? [])
  ]);
  const retention = root.retention;
  const outcome = retention.then === 'delete'
    ? `        // then: delete. Por el repositorio y no con un DELETE a mano: así JPA se lleva las hijas y las tablas de
        // elementos del agregado (T3).
        ${field}.deleteById(${id.name});`
    : (() => {
        const plan = anonymizePlan(model, root);
        imports.add(`${subPackage(model, 'infrastructure.persistence.entities')}.${entity.name}Jpa`);
        for (const child of plan.children) imports.add(`${subPackage(model, 'infrastructure.persistence.entities')}.${child.jpa}`);
        if ([...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.shadow)) imports.add(`${subPackage(model, 'domain.text')}.TextFold`);
        const body = anonymizeBody(plan, id);
        return `        // then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que
        // no deriva del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
        ${field}.findById(${id.name}).ifPresent(row -> {
${body}
            row.set${capital(ANONYMIZED_AT.field)}(Instant.now());
        });`;
      })();
  const fromField = retention.from;
  const body = `/**
 * La retención de ${entity.name} (persistence.${entity.name}.retention, DSL 2.28): ${retention.fromDeleted ? 'desde el borrado lógico' : `desde ${fromField}`}, ${spanText(retention.span)}, y
 * después ${retention.then === 'delete' ? 'se BORRA' : 'se ANONIMIZA'}. La dispara {@code ${retentionTimerClass(entity.name)}}, un recurrente del
 * cronómetro en modo clúster (D8): cada tick lo ejecuta UNA réplica.
 *
 * <p>Por lotes y cada uno en su transacción: una tabla grande no se recorre en un solo DELETE que bloquee la tabla y
 * reviente el tope de transacción. Una fila con {@code ${fromField}} nulo no vence nunca.
 */
@Component
public class ${className} {

    private final ${jpaRepository} ${field};

    public ${className}(${jpaRepository} ${field}) {
        this.${field} = ${field};
    }

    /** Los ids que han vencido en {@code cutoff} (vence EN el corte), los más antiguos primero, como mucho {@code limit}. */
    @Transactional(readOnly = true)
    public List<${id.javaType}> due(Instant cutoff, int limit) {
        return ${field}.dueForRetention(cutoff, PageRequest.of(0, limit));
    }

    /** Lo que la retención hace con un agregado vencido, en su propia transacción. */
    @Transactional
    public void apply(${id.javaType} ${id.name}) {
${outcome}
    }
}`;
  return { path: javaPath(model, RETENTION_PKG, className), content: javaFile(subPackage(model, RETENTION_PKG), [...imports], body) };
}

function anonymizeBody(plan, id, variable = 'row') {
  const lines = [];
  const indent = '            ';
  const write = (target, sets, pad) => {
    for (const set of sets) {
      const value = set.value === 'substitute' ? `"${ANONYMOUS_PREFIX}" + ${id.name}` : 'null';
      lines.push(`${pad}${target}.${set.setter}(${value});`);
      if (set.shadow) {
        const folded = set.value === 'substitute' ? `TextFold.${set.shadow.accents ? 'foldCaseAndAccents' : 'foldCase'}(${value})` : 'null';
        lines.push(`${pad}${target}.${set.shadow.setter}(${folded});`);
      }
    }
  };
  write(variable, plan.root, indent);
  for (const child of plan.children) {
    lines.push(`${indent}for (${child.jpa} child : ${variable}.get${capital(child.relation)}()) {`);
    write('child', child.sets, `${indent}    `);
    lines.push(`${indent}}`);
  }
  return lines.join('\n');
}

const spanText = (span) => (span.days ? `${span.days} días` : span.years ? `${span.years} años` : `el parámetro ${span.parameter}`);

/** La consulta de lo vencido en el JpaRepository (JPQL): los ids con `from <= corte`, sin anonimizar aún. */
export function dueQueryMethod(model, entity, imports) {
  const root = lifecycleOf(model, entity)?.retention;
  if (!root) return [];
  imports.add('java.time.Instant');
  imports.add('java.util.List');
  imports.add('org.springframework.data.domain.Pageable');
  imports.add('org.springframework.data.jpa.repository.Query');
  imports.add('org.springframework.data.repository.query.Param');
  const from = root.from;
  const pending = root.then === 'anonymize' ? ` and e.${ANONYMIZED_AT.field} is null` : '';
  return [
    `    /** Lo que ha vencido su retención (DSL 2.28): ${from} en o antes del corte. Una fila con ${from} nulo no vence. */
    @Query("select e.${entity.idField.name} from ${entity.name}Jpa e where e.${from} <= :cutoff${pending} order by e.${from} asc")
    List<${entity.idField.javaType}> dueForRetention(@Param("cutoff") Instant cutoff, Pageable page);`
  ];
}

/** El recurrente del cronómetro que dispara una retención (D8), en el paquete del cronómetro. */
export function retentionTimer(model, entity, root, { pkg, kindsClass = 'TimerKinds' }) {
  const className = retentionTimerClass(entity.name);
  const target = retentionClass(entity.name);
  const field = decap(target);
  const parameters = retentionParameters(entity.name);
  const span = root.retention.span;
  const cutoff = span.days
    ? `now.minus(Duration.ofDays(${span.days}))`
    : span.years
      ? `now.atZone(ZoneOffset.UTC).minusYears(${span.years}).toInstant()`
      : span.unit === 'years'
        ? `now.atZone(ZoneOffset.UTC).minusYears(parameters.${span.parameter}().longValue()).toInstant()`
        : `now.minus(Duration.ofDays(parameters.${span.parameter}().longValue()))`;
  const usesParameters = Boolean(span.parameter);
  // Las cachés de las lecturas de esta raíz (T5): el barrido no pasa por el mediator, así que las vacía él.
  const caches = retentionCaches(model, entity.name);
  const imports = [
    ...(caches.length > 0
      ? [`${subPackage(model, 'application.port.out')}.OperationCache`, `${subPackage(model, 'application.support')}.CachedOperations`]
      : []),
    `${subPackage(model, RETENTION_PKG)}.${target}`,
    ...(cutoff.includes('Duration') ? ['java.time.Duration'] : []),
    'java.time.Instant',
    ...(cutoff.includes('ZoneOffset') ? ['java.time.ZoneOffset'] : []),
    'java.util.List',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.stereotype.Component',
    ...(entity.idField.imports ?? []),
    ...(usesParameters ? [`${subPackage(model, 'domain.parameters')}.${model.service.className}Parameters`] : [])
  ];
  const value = ({ key, default: fallback }) => `@Value("\${${key}:${fallback}}")`;
  const body = `/**
 * La retención de ${entity.name} como recurrente del cronómetro en modo clúster (DSL 2.28, D8): cada tick lo ejecuta UNA
 * réplica, la que gana su fila en keel_timer. Corre FUERA de la transacción del sondeador, y cada lote en la suya.
 *
 * <p>El corte lo calcula el servidor: ${spanText(span)} antes de ahora${span.years || span.unit === 'years' ? ', en años de calendario UTC (un 29 de febrero sin equivalente cae en el 28)' : ''}.
 * Lo que venció EN el corte también se va. El tick repite el lote mientras salga lleno.
 */
@Component
public class ${className} implements RecurringTimerHandler {

    private final ${target} ${field};${usesParameters ? `\n\n    private final ${model.service.className}Parameters parameters;` : ''}${caches.length > 0 ? '\n\n    private final OperationCache operationCache;' : ''}

    ${value(parameters.cron)}
    private String cron;

    ${value(parameters.batchSize)}
    private int batchSize;

    public ${className}(${target} ${field}${usesParameters ? `, ${model.service.className}Parameters parameters` : ''}${caches.length > 0 ? ', OperationCache operationCache' : ''}) {
        this.${field} = ${field};${usesParameters ? '\n        this.parameters = parameters;' : ''}${caches.length > 0 ? '\n        this.operationCache = operationCache;' : ''}
    }

    @Override
    public String kind() {
        return ${kindsClass}.${retentionKindConstant(entity.name)};
    }

    @Override
    public String spec() {
        return cron;
    }

    @Override
    public void tick() {
        Instant now = Instant.now();
        Instant cutoff = ${cutoff};
        int processed = 0;
        while (true) {
            List<${entity.idField.javaType}> due = ${field}.due(cutoff, batchSize);
            for (${entity.idField.javaType} id : due) {
                ${field}.apply(id);
            }
            processed += due.size();
            if (due.size() < batchSize) {
                break;
            }
        }${caches.length > 0
          ? `
        // Lo vencido ya no es lo que guardan las lecturas de ${entity.name} en la caché (T5): se vacían, como al borrar.
        if (processed > 0) {
${caches.map((cache) => `            operationCache.clear(CachedOperations.${cache.constant});`).join('\n')}
        }`
          : ''}
    }
}`;
  return { path: javaPath(model, pkg, className), content: javaFile(subPackage(model, pkg), imports, body) };
}

/**
 * Lo que el ciclo de vida del dato no puede generar con este stack, o []: la unicidad entre vivas (D4) necesita un motor
 * con índices parciales (o la columna generada de MySQL), y la anonimización solo sabe vaciar escalares y value objects
 * de la raíz y de sus hijas uno-a-muchos. A medias, la clave de quien se borró no se liberaría, o un dato personal
 * sobreviviría a su retención, sin que nada lo dijera.
 */
export function lifecycleStackErrors(model, partialIndexEngines) {
  const errors = [];
  if (model.persistenceKind !== 'document' && !partialIndexEngines.includes(model.stack?.database)) {
    for (const entity of model.entities.filter((candidate) => candidate.persisted && isLogicallyDeleted(candidate))) {
      const uniques = (entity.naturalKey ?? []).length > 0 || entity.fields.some((field) => field.unique && !field.isId) || (entity.indexes ?? []).some((index) => index.unique);
      if (uniques) {
        errors.push(
          `persistence: ${entity.name}.deletion: logical (DSL 2.28): sus unicidades solo pueden contar las filas vivas con un ` +
            `índice parcial, y '${model.stack?.database}' no lo tiene (sí ${partialIndexEngines.join(', ')}). Elige uno de esos motores.`
        );
      }
    }
  }
  for (const gap of anonymizeGaps(model)) {
    errors.push(`persistence: retention con then: anonymize (DSL 2.28): keel-spring no sabe anonimizar ${gap}. Márcalo sin personal o usa then: delete.`);
  }
  return errors;
}

// ─── La rama documental ──────────────────────────────────────────────────────────────────────────────────────────

/** Los métodos del MongoRepository que pide el ciclo de vida, con la misma forma que los de JPA. */
export function mongoRepositoryMethods(model, entity, id, keyFinder, listed, imports) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return [];
  imports.add('java.util.Optional');
  const doc = `${entity.name}Document`;
  const methods = [`    Optional<${doc}> findById${LIVE_SUFFIX}(${id.javaType} ${id.name});`];
  if (listed) {
    imports.add('org.springframework.data.domain.Page');
    imports.add('org.springframework.data.domain.Pageable');
    methods.push(`    Page<${doc}> findAllBy${capital(DELETED_AT.field)}IsNull(Pageable pageable);`);
  }
  if (lifecycle.restore) {
    methods.push(`    Optional<${doc}> findByIdAnd${capital(DELETED_AT.field)}IsNotNull(${id.javaType} ${id.name});`);
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) methods.push(`    Optional<${doc}> ${deleted.jpa}(${keyFinder.store.signature});`);
  }
  return methods;
}

/** El adaptador documental: `deleteById` que marca, `restore` y la carga de la borrada por la clave. */
export function mongoAdapterMethods(model, entity, id, repoField, keyFinder, imports) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  imports.add('java.time.Instant');
  imports.add('org.springframework.transaction.annotation.Transactional');
  const methods = [`    @Override
    @Transactional
    public void deleteById(${id.javaType} ${id.name}) {
        // Borrado lógico (DSL 2.28, D1): se marca y no se elimina. El documento deja de verse en toda lectura del puerto
        // y su clave única queda libre (los índices únicos solo cuentan los documentos con deletedAt nulo).
        ${repoField}.findById${LIVE_SUFFIX}(${id.name}).ifPresent(document -> {
            document.set${capital(DELETED_AT.field)}(Instant.now());
            ${repoField}.save(document);
        });
    }`];
  if (lifecycle.restore) {
    const deleted = deletedFinder(entity, keyFinder);
    if (deleted) {
      if (keyFinder.store.folds) imports.add(`${subPackage(model, 'domain.text')}.TextFold`);
      methods.push(`    @Override
    public Optional<${entity.name}> ${deleted.name}(${keyFinder.signature}) {
        return ${repoField}.${deleted.jpa}(${keyFinder.store.args}).map(this::toDomain);
    }`);
    }
    methods.push(restoreMethod(model, entity, id, lifecycle.restore, imports, (idName) => `${repoField}.findByIdAnd${capital(DELETED_AT.field)}IsNotNull(${idName})`, (variable) => `${repoField}.save(${variable})`));
  }
  return methods;
}

/**
 * Lo que `save` tiene que ARRASTRAR del documento que reemplaza (la rama documental reescribe el documento entero desde
 * el dominio, que no conoce las marcas): `anonymizedAt`, o la retención volvería a tomar el agregado en cada pasada.
 * `deletedAt` no, porque solo se guarda un agregado vivo.
 */
export const carriedMarks = (model, entity) => lifecycleMarks(model, entity).filter((mark) => mark === ANONYMIZED_AT);

/** La retención documental: lo vencido con MongoTemplate y lo que se hace con cada uno por el repositorio. */
export function mongoRetention(model, entity, root) {
  const className = retentionClass(entity.name);
  const doc = `${entity.name}Document`;
  const repository = `${entity.name}MongoRepository`;
  const field = decap(repository);
  const id = entity.idField;
  const retention = root.retention;
  const imports = new Set([
    `${subPackage(model, 'infrastructure.persistence.repositories')}.${repository}`,
    `${subPackage(model, 'infrastructure.persistence.documents')}.${doc}`,
    'java.time.Instant',
    'java.util.List',
    'org.springframework.data.domain.Sort',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'org.springframework.data.mongodb.core.query.Criteria',
    'org.springframework.data.mongodb.core.query.Query',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.annotation.Transactional',
    ...(id.imports ?? [])
  ]);
  let outcome;
  if (retention.then === 'delete') {
    outcome = `        // then: delete. El agregado es el documento: sus hijas se van con él.
        ${field}.deleteById(${id.name});`;
  } else {
    const plan = anonymizePlan(model, root);
    const children = plan.children.map((child) => ({ ...child, jpa: child.jpa.replace(/Jpa$/, 'Document') }));
    for (const child of children) imports.add(`${subPackage(model, 'infrastructure.persistence.documents')}.${child.jpa}`);
    if ([...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.shadow)) imports.add(`${subPackage(model, 'domain.text')}.TextFold`);
    const body = anonymizeBody({ ...plan, children }, id, 'document');
    outcome = `        // then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que
        // no deriva del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
        ${field}.findById(${id.name}).ifPresent(document -> {
${body}
            document.set${capital(ANONYMIZED_AT.field)}(Instant.now());
            ${field}.save(document);
        });`;
  }
  const pending = retention.then === 'anonymize' ? `.and("${ANONYMIZED_AT.field}").is(null)` : '';
  const body = `/**
 * La retención de ${entity.name} (persistence.${entity.name}.retention, DSL 2.28): ${retention.fromDeleted ? 'desde el borrado lógico' : `desde ${retention.from}`}, ${spanText(retention.span)}, y
 * después ${retention.then === 'delete' ? 'se BORRA' : 'se ANONIMIZA'}. La dispara {@code ${retentionTimerClass(entity.name)}}, un recurrente del
 * cronómetro en modo clúster (D8): cada tick lo ejecuta UNA réplica. Por lotes, cada documento en su transacción. Un
 * documento sin {@code ${retention.from}} no vence nunca.
 */
@Component
public class ${className} {

    private final MongoTemplate mongoTemplate;

    private final ${repository} ${field};

    public ${className}(MongoTemplate mongoTemplate, ${repository} ${field}) {
        this.mongoTemplate = mongoTemplate;
        this.${field} = ${field};
    }

    /** Los ids que han vencido en {@code cutoff} (vence EN el corte), los más antiguos primero, como mucho {@code limit}. */
    public List<${id.javaType}> due(Instant cutoff, int limit) {
        Query query = new Query(Criteria.where("${retention.from}").lte(cutoff)${pending})
                .with(Sort.by(Sort.Order.asc("${retention.from}")))
                .limit(limit);
        query.fields().include("${id.name}");
        return mongoTemplate.find(query, ${doc}.class).stream().map(${doc}::get${capital(id.name)}).toList();
    }

    /** Lo que la retención hace con un agregado vencido, en su propia transacción. */
    @Transactional
    public void apply(${id.javaType} ${id.name}) {
${outcome}
    }
}`;
  return { path: javaPath(model, RETENTION_PKG, className), content: javaFile(subPackage(model, RETENTION_PKG), [...imports], body) };
}
