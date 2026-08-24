// El reclamo de un barrido: llevarse un lote de filas pendientes de forma que dos
// réplicas nunca se lleven la misma.
//
// Por qué lo genera build y no el agente. Un `@Scheduled` corre en TODAS las réplicas
// —es «una vez por instancia», no «una vez en el clúster»—, así que el barrido que LEE
// su lote y lo marca después deja que las N instancias se lleven las mismas filas. El
// camino de menor resistencia para quien escribe el handler a mano es exactamente esa
// lectura (`findByStatusOrderBy…`), y sale verde en una máquina de desarrollo con una
// sola instancia: el fallo aparece en producción, multiplicado por réplicas, sobre
// efectos que no se pueden retirar. Con el método ya generado, no usarlo cuesta más que
// usarlo — el mismo argumento que sostiene el RefResolver.
//
// La forma tiene dos capas y conviene no confundirlas:
//
//   · Llevarse la fila: `UPDATE … SET estado = :to WHERE id = :id AND estado IN :from`.
//     Una fila afectada = es mía; cero = otra réplica llegó antes. Atómico en los seis
//     motores, sin ayuda de nadie. Y la marca es el PROPIO estado de destino que el
//     diseño declara, así que no hace falta inventar ninguna columna `claimed_at` en
//     paralelo al lifecycle: sobrevive al commit y es visible para las demás réplicas,
//     que es lo que exige un barrido con una llamada externa en medio.
//
//   · Elegir a qué filas tirarle: ahí entra SKIP LOCKED, por el lock pesimista con hint
//     `jakarta.persistence.lock.timeout = -2` (el mismo que ya usa OutboxRelay). Es una
//     OPTIMIZACIÓN: sin él el reclamo sigue siendo correcto, solo que las N réplicas
//     compiten por la misma página y N-1 tiran su ciclo. Ver lib/claim-sql.js.

import { subPackage } from './render.js';
import { screamingSnake } from '../lib/naming.js';
import { claimSelectionSnippet, supportsSkipLocked, unsupportedClaimWarning } from '../lib/claim-sql.js';
import { usesOutbox } from './outbox.js';

/** Todos los reclamos que apuntan a esta entidad, venga de la operación que venga. */
export function claimsFor(model, entityName) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .flatMap((operation) => operation.claim ?? [])
    .filter((claim) => claim.entity === entityName);
}

/**
 * El aviso de dialecto, una sola vez por build y para TODOS los mecanismos que leen
 * candidatos desde varias réplicas a la vez. Se emite aquí —y no en claim-sql.js—
 * porque es aquí donde se sabe qué hay generado de verdad en ESTE diseño, y va junto
 * porque repetir el mismo párrafo tres veces lo convierte en ruido que se salta.
 */
export function warnUnsupportedDialect(model) {
  if (model.persistenceKind === 'document') return;
  const database = model.stack?.database;
  if (!database || supportsSkipLocked(database)) return;

  const mechanisms = [
    ...(model.services ?? [])
      .flatMap((service) => service.operations ?? [])
      .flatMap((operation) => operation.claim ?? [])
      .map((claim) => `${claim.method}()`),
    ...reconciliationClaims(model).map((claim) => `${claim.method}()`),
    ...(usesOutbox(model) ? ['OutboxRelay.findPending()'] : []),
    // Y los barridos cuyo reclamo NO pudo generar build (rescatan filas EN VUELO, con una
    // cota temporal que vive en la prosa de `rules`). Son los que MÁS necesitan el aviso:
    // ahí el SELECT de candidatos lo escribe el agente, y nadie le va a decir que en SQL
    // Server el hint es otro ni que H2 acepta la sintaxis y la ignora. Antes quedaban fuera
    // porque esta lista solo miraba los reclamos generados, que es justo lo que no hay.
    ...unclaimedSweeps(model).map((operation) => `${operation.name} (barrido cuyo reclamo escribes tú)`)
  ];
  if (mechanisms.length === 0) return;
  model.warnings.push(unsupportedClaimWarning(database, mechanisms));
}

/**
 * Los barridos marcados como tales a los que build NO les generó reclamo.
 *
 * `model.js` marca `sweep` a toda operación con `schedule` que actúa sobre lo que encuentra,
 * pero solo emite `claim` cuando la transición sale de una COLA (un estado al que no llega
 * ninguna transición). Rescatar filas en vuelo no cumple eso, y entonces las DOS capas del
 * reclamo —la escritura condicional y la selección de candidatos— las escribe el agente.
 */
function unclaimedSweeps(model) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .filter((operation) => operation.sweep && (operation.claim ?? []).length === 0);
}

/** Los reclamos de reconciliación que build pudo generar, de todos los barridos. */
function reconciliationClaims(model) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .flatMap((operation) => operation.reconciles ?? [])
    .map((reconcile) => reconcile.claim)
    .filter(Boolean);
}

const enumConstant = (state) => screamingSnake(state);

const stateList = (claim, enumType) =>
  claim.from.map((state) => `${enumType}.${enumConstant(state)}`).join(', ');

function describe(claim, entityName) {
  return `Reclama hasta {@code batchSize} ${entityName} en estado ${claim.from.join(' o ')} y los pasa a ${claim.to}.
     *
     * <p><b>Reclama, no lee.</b> Corre en TODAS las réplicas del servicio a la vez
     * ({@code @Scheduled} es «una vez por instancia», no «una vez en el clúster»). La lista
     * que devuelve son SOLO las filas que ESTA instancia se llevó: el paso a ${claim.to} va
     * en un UPDATE condicional, así que la fila que otra réplica reclamó antes no aparece
     * aquí. Leer el lote con un finder normal y marcarlo después se lo daría entero a todas.
     *
     * <p>El reclamo se COMMITEA antes de volver (transacción propia): eso es lo que lo hace
     * visible a las demás. Actúa sobre lo que devuelve FUERA de esta llamada — sostener una
     * transacción durante un envío o una llamada a un proveedor es justo lo que este método
     * existe para evitar.`;
}

/** Métodos del puerto <E>Repository. */
export function portMethods(model, entity, imports) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];
  imports.add('java.util.List');
  return claims.map(
    (claim) => `    /**
     * ${describe(claim, entity.name)}
     */
    List<${entity.name}> ${claim.method}(int batchSize);`
  );
}

/**
 * El orden del barrido. Lo que no puede es quedarse sin ORDER BY: sin él el motor
 * devuelve las filas como le convenga y «el más antiguo primero», que es lo que casi
 * todo barrido promete, deja de cumplirse sin que nada falle.
 */
function orderFieldOf(entity) {
  for (const candidate of ['createdAt', 'requestedAt', 'updatedAt']) {
    if (entity.fields.some((field) => field.name === candidate)) return candidate;
  }
  return 'id';
}

/** Métodos de la interfaz Spring Data <E>JpaRepository (modelo relacional). */
export function jpaRepositoryMethods(model, entity, imports) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType, field } = entity.lifecycle;
  const orderField = orderFieldOf(entity);
  // La decisión de dialecto no se toma aquí: sale de lib/claim-sql.js, que es la misma
  // que consultan el relay del outbox y el reclamo de la reconciliación.
  const selection = claimSelectionSnippet({
    database: model.stack?.database,
    subject: 'el reclamo'
  });

  imports.add('java.util.List');
  imports.add('java.util.UUID');
  imports.add('org.springframework.data.domain.Pageable');
  imports.add('org.springframework.data.jpa.repository.Modifying');
  imports.add('org.springframework.data.jpa.repository.Query');
  imports.add('org.springframework.data.repository.query.Param');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);
  for (const imported of selection.imports) imports.add(imported);

  return claims.flatMap((claim) => [
    `${selection.annotations}
    @Query("select e.id from ${entity.name}Jpa e where e.${field} in :states order by e.${orderField} asc")
    List<UUID> candidatesFor${claim.suffix}(@Param("states") List<${enumType}> states, Pageable pageable);`,

    `    /**
     * El reclamo propiamente dicho: pasa la fila a ${claim.to} SOLO si sigue en su estado
     * de partida. Devuelve 1 si esta instancia se la llevó y 0 si otra llegó antes. Esa
     * comparación en el WHERE es toda la exclusión mutua, y no depende del motor.
     */
    @Modifying
    @Query("update ${entity.name}Jpa e set e.${field} = :to where e.id = :id and e.${field} in :states")
    int ${claim.method}(@Param("id") UUID id, @Param("states") List<${enumType}> states, @Param("to") ${enumType} to);`
  ]);
}

/** Métodos del adaptador <E>RepositoryImpl (modelo relacional). */
export function adapterMethods(model, entity, imports, jpaField) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType } = entity.lifecycle;
  imports.add('java.util.ArrayList');
  imports.add('java.util.List');
  imports.add('java.util.UUID');
  imports.add('org.springframework.data.domain.PageRequest');
  imports.add('org.springframework.transaction.annotation.Propagation');
  imports.add('org.springframework.transaction.annotation.Transactional');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);

  return claims.map(
    (claim) => `    /**
     * ${describe(claim, entity.name)}
     */
    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<${entity.name}> ${claim.method}(int batchSize) {
        List<${enumType}> states = List.of(${stateList(claim, enumType)});
        List<UUID> candidates = ${jpaField}.candidatesFor${claim.suffix}(states, PageRequest.of(0, batchSize));
        List<${entity.name}> claimed = new ArrayList<>();
        for (UUID id : candidates) {
            // 1 = la fila era mía; 0 = otra réplica la reclamó entre el select y el update.
            if (${jpaField}.${claim.method}(id, states, ${enumType}.${enumConstant(claim.to)}) == 1) {
                ${jpaField}.findById(id).map(this::toDomain).ifPresent(claimed::add);
            }
        }
        return claimed;
    }`
  );
}

/**
 * Métodos del adaptador documental. En MongoDB no hay SKIP LOCKED y no hace falta:
 * `findAndModify` filtra y marca en la MISMA operación atómica sobre el documento, así
 * que dos réplicas no pueden llevarse el mismo. Es la forma que ya usa el relay
 * documental del outbox.
 */
export function documentAdapterMethods(model, entity, imports) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType, field } = entity.lifecycle;
  imports.add('java.util.ArrayList');
  imports.add('java.util.List');
  imports.add('org.springframework.data.mongodb.core.FindAndModifyOptions');
  imports.add('org.springframework.data.mongodb.core.query.Criteria');
  imports.add('org.springframework.data.mongodb.core.query.Query');
  imports.add('org.springframework.data.mongodb.core.query.Update');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);

  return claims.map(
    (claim) => `    /**
     * ${describe(claim, entity.name)}
     */
    @Override
    public List<${entity.name}> ${claim.method}(int batchSize) {
        List<${entity.name}> claimed = new ArrayList<>();
        FindAndModifyOptions options = FindAndModifyOptions.options().returnNew(true);
        for (int i = 0; i < batchSize; i++) {
            Query query = Query.query(Criteria.where("${field}").in(List.of(${stateList(claim, enumType)})));
            Update update = new Update().set("${field}", ${enumType}.${enumConstant(claim.to)});
            ${entity.name}Document document = mongoTemplate.findAndModify(query, update, options, ${entity.name}Document.class);
            // Sin candidatos el lote se acaba antes que el batchSize, que es lo normal.
            if (document == null) {
                break;
            }
            claimed.add(toDomain(document));
        }
        return claimed;
    }`
  );
}

// ─── La guarda de una fila con un efecto externo irreversible ────────────────
//
// Otro reclamo, y no una variante del anterior: aquí no se elige un lote, se asegura
// UNA fila que el llamante ya eligió. Lo que comparten es lo único que importa —una
// escritura condicional que dice cuántas filas se llevó, y un commit propio— y lo que
// los separa es que este existe porque después viene un correo, que no lo deshace
// ningún rollback. Ver classifyGuardClaims() en lib/model.js.

/** El reclamo de guarda que apunta a esta entidad, si alguna operación lo declara. */
export function guardClaimsFor(model, entityName) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .map((operation) => operation.guardClaim)
    .filter((claim) => claim && claim.entity === entityName);
}

function describeGuard(claim, entityName) {
  return `Reclama ESTE ${entityName} para ${claim.operation}: lo pasa a ${claim.to} solo si sigue
     * en ${claim.from.join(' o ')}${claim.stampField ? `, y estampa ${claim.stampField}` : ''}. Devuelve
     * el agregado ya reclamado, o vacío si otra ejecución llegó antes.
     *
     * <p><b>Y confirma antes de volver</b> (transacción propia). Eso es lo que lo hace una
     * guarda y no una anotación en memoria: ${claim.operation} produce un efecto externo que
     * NO se deshace, así que la marca tiene que existir para todo el mundo ANTES de
     * producirlo. Si el proceso cae después del efecto y antes del commit final, la fila se
     * queda en ${claim.to} —que es justo lo que busca el rescate del barrido— en vez de volver
     * a ${claim.from.join(' o ')} y repetirse.
     *
     * <p>El vacío es la carrera perdida, y se traduce al error que el diseño declare para
     * «ya no está disponible». No es un caso excepcional: es el caso normal cuando dos
     * ejecuciones coinciden.`;
}

/** Método del puerto <E>Repository para el reclamo de guarda. */
export function guardPortMethods(model, entity, imports) {
  const claims = guardClaimsFor(model, entity.name);
  if (claims.length === 0) return [];
  imports.add('java.util.Optional');
  imports.add('java.util.UUID');
  return claims.map(
    (claim) => `    /**
     * ${describeGuard(claim, entity.name)}
     */
    Optional<${entity.name}> ${claim.method}(UUID id);`
  );
}

/** Métodos de la interfaz Spring Data <E>JpaRepository para el reclamo de guarda. */
export function guardJpaRepositoryMethods(model, entity, imports) {
  const claims = guardClaimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType, field } = entity.lifecycle;
  imports.add('java.util.List');
  imports.add('java.util.UUID');
  imports.add('org.springframework.data.jpa.repository.Modifying');
  imports.add('org.springframework.data.jpa.repository.Query');
  imports.add('org.springframework.data.repository.query.Param');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);

  return claims.map((claim) => {
    const stamp = claim.stampField ? `, e.${claim.stampField} = :now` : '';
    const stampParam = claim.stampField ? `, @Param("now") Instant now` : '';
    if (claim.stampField) imports.add('java.time.Instant');
    return `    /**
     * La guarda de ${claim.operation}: pasa la fila a ${claim.to} SOLO si sigue en su estado
     * de partida. Devuelve 1 si esta ejecución se la llevó y 0 si otra llegó antes. Esa
     * comparación en el WHERE es toda la exclusión mutua, y no depende del motor.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update ${entity.name}Jpa e set e.${field} = :to${stamp} where e.id = :id and e.${field} in :states")
    int ${claim.method}(@Param("id") UUID id, @Param("states") List<${enumType}> states, @Param("to") ${enumType} to${stampParam});`;
  });
}

/** Métodos del adaptador <E>RepositoryImpl para el reclamo de guarda (relacional). */
export function guardAdapterMethods(model, entity, imports, jpaField) {
  const claims = guardClaimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType } = entity.lifecycle;
  imports.add('java.util.List');
  imports.add('java.util.Optional');
  imports.add('java.util.UUID');
  imports.add('org.springframework.transaction.annotation.Propagation');
  imports.add('org.springframework.transaction.annotation.Transactional');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);

  return claims.map((claim) => {
    const stampArg = claim.stampField ? ', Instant.now()' : '';
    if (claim.stampField) imports.add('java.time.Instant');
    return `    /**
     * ${describeGuard(claim, entity.name)}
     */
    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Optional<${entity.name}> ${claim.method}(UUID id) {
        // REQUIRES_NEW, y no la transacción del llamante: si la marca esperase al commit de
        // aquella, no existiría para nadie durante el efecto externo, que es cuando hace falta.
        int claimed = ${jpaField}.${claim.method}(
                id, List.of(${stateList(claim, enumType)}), ${enumType}.${enumConstant(claim.to)}${stampArg});
        if (claimed == 0) {
            return Optional.empty();
        }
        return ${jpaField}.findById(id).map(this::toDomain);
    }`;
  });
}

/** Métodos del adaptador documental para el reclamo de guarda. */
export function guardDocumentAdapterMethods(model, entity, imports) {
  const claims = guardClaimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType, field } = entity.lifecycle;
  imports.add('java.util.List');
  imports.add('java.util.Optional');
  imports.add('java.util.UUID');
  imports.add('org.springframework.data.mongodb.core.FindAndModifyOptions');
  imports.add('org.springframework.data.mongodb.core.query.Criteria');
  imports.add('org.springframework.data.mongodb.core.query.Query');
  imports.add('org.springframework.data.mongodb.core.query.Update');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);

  return claims.map((claim) => {
    const stamp = claim.stampField ? `.set("${claim.stampField}", Instant.now())` : '';
    if (claim.stampField) imports.add('java.time.Instant');
    return `    /**
     * ${describeGuard(claim, entity.name)}
     */
    @Override
    public Optional<${entity.name}> ${claim.method}(UUID id) {
        // findAndModify filtra y marca en la MISMA operación atómica sobre el documento: no
        // hay ventana entre comprobar el estado y llevárselo, y tampoco hace falta abrir
        // transacción para que la marca sea visible.
        Query query = Query.query(Criteria.where("_id").is(id)
                .and("${field}").in(List.of(${stateList(claim, enumType)})));
        Update update = new Update().set("${field}", ${enumType}.${enumConstant(claim.to)})${stamp};
        ${entity.name}Document document = mongoTemplate.findAndModify(
                query, update, FindAndModifyOptions.options().returnNew(true), ${entity.name}Document.class);
        return Optional.ofNullable(document).map(this::toDomain);
    }`;
  });
}
