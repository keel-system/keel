// El reclamo del barrido de reconciliación: llevarse los encargos que llevan demasiado
// tiempo sin desenlace, de forma que dos réplicas no se lleven el mismo.
//
// Por qué NO es el mismo reclamo que el de una cola (scaffold/claim.js), aunque las dos
// cosas se llamen reclamar:
//
//   · En una cola la marca es el PROPIO estado de destino que el diseño declara: sacar la
//     fila de `queued` a `running` ya dice que alguien la tomó. Aquí no hay tal
//     transición — el estado de espera es justo lo que el barrido busca, y cambiarlo
//     antes de saber el desenlace sería mentir sobre lo que pasó.
//   · Y entre reclamar y actuar hay una llamada al proveedor, así que un lock no sirve:
//     solo aísla mientras dura su transacción. Sostenerla durante la llamada retiene una
//     conexión del pool por la latencia de un tercero, y soltarla antes deja la fila sin
//     nada que diga que alguien la tomó.
//
// De ahí la tabla propia `reconciliation_claim` (misma familia que `processed_event` o
// `idempotency_record`: mecánica del generador, no algo que el diseño declare) con una
// marca que SOBREVIVE AL COMMIT y CADUCA — sin plazo, una réplica que muera con el
// candidato en vuelo lo retendría para siempre.
//
// Lo que sigue dependiendo del dialecto es lo de siempre y solo eso: repartir los
// candidatos entre réplicas (`SKIP LOCKED`), que sale de lib/claim-sql.js. Sin él el
// reclamo sigue siendo correcto — lo garantiza la tabla, no la consulta.

import { javaFile, javaPath, subPackage } from './render.js';
import { screamingSnake } from '../lib/naming.js';
import { claimSelectionSnippet, claimTransaction } from '../lib/claim-sql.js';

const CLAIM_PKG = 'infrastructure.persistence.reconciliation';

/** Todos los reclamos de reconciliación que build pudo generar en este diseño. */
export function reconciliationClaims(model) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .flatMap((operation) => operation.reconciles ?? [])
    .map((reconcile) => reconcile.claim)
    .filter(Boolean);
}

/** Los que apuntan a esta entidad, que son los que le añaden métodos a su repositorio. */
export function claimsFor(model, entityName) {
  return reconciliationClaims(model).filter((claim) => claim.entity === entityName);
}

// ─── Piezas del adaptador (las consume repositories.js / document-repositories.js) ────

/** El colaborador que ejecuta el reclamo, inyectado solo en los adaptadores que reclaman. */
export function adapterCollaborator(model, entity) {
  if (claimsFor(model, entity.name).length === 0) return null;
  return { type: 'ReconciliationClaimStore', field: 'reconciliationClaims', pkg: CLAIM_PKG };
}

/**
 * Los tres números del barrido, leídos de `parameters/<perfil>/reconciliation.yaml` que
 * config.js ya emite. Van en el ADAPTADOR y no en el handler a propósito: el handler vive
 * en `application`, que por constitución no importa Spring, así que no puede leer
 * configuración — y por eso el método del puerto no recibe `batchSize`.
 *
 * El default de cada `@Value` repite el valor de config.js; el del umbral es el que
 * declara el diseño, o el binario diría un número distinto del que el diseñador decidió
 * en cuanto faltase el fichero.
 */
export function adapterValueFields(model, entity) {
  return claimsFor(model, entity.name).flatMap((claim) => [
    `    /** Umbral de silencio del proveedor: lo declara el diseño (${claim.dependency}.${claim.activation}). */
    @Value("\${reconciliation.${claim.configKey}.unanswered-after-seconds:${claim.unansweredAfterSeconds}}")
    private long ${claim.activation}UnansweredAfterSeconds;`,
    `    /** Caducidad del reclamo: lo que retiene un candidato la réplica que muera con él en vuelo. */
    @Value("\${reconciliation.${claim.configKey}.claim-timeout-ms:60000}")
    private long ${claim.activation}ClaimTimeoutMs;`,
    `    /** Cota del lote: sin ella, una tanda con 50.000 atascados son 50.000 llamadas al proveedor. */
    @Value("\${reconciliation.${claim.configKey}.batch-size:50}")
    private int ${claim.activation}BatchSize;
`
  ]);
}

function describe(claim) {
  return `Reclama los ${claim.entity} que encargaron trabajo a ${claim.dependency}.${claim.activation} y
     * llevan demasiado tiempo sin desenlace.
     *
     * <p><b>Reclama, no lee.</b> Corre en TODAS las réplicas del servicio a la vez
     * ({@code @Scheduled} es «una vez por instancia», no «una vez en el clúster»). La lista
     * que devuelve son SOLO los candidatos que ESTA instancia se llevó: el reclamo es una
     * marca persistida en {@code reconciliation_claim} que se confirma antes de volver, así
     * que las demás réplicas dejan de verlos. Leerlos con un finder y actuar después haría
     * que las N llamaran al proveedor por el mismo encargo.
     *
     * <p>La marca CADUCA ({@code reconciliation.${claim.configKey}.claim-timeout-ms}): sobrevive
     * al commit, así que también sobreviviría a la réplica que muera con el candidato en
     * vuelo. Dimensiona el plazo por encima de lote × timeout de llamada.
     *
     * <p>No recibe el tamaño del lote: los tres números —umbral, caducidad y cota— salen de
     * {@code parameters/<perfil>/reconciliation.yaml}, y quien los lee es el adaptador.
     * Actúa sobre lo que devuelve FUERA de esta llamada.`;
}

/** Métodos del puerto <E>Repository. */
export function portMethods(model, entity, imports) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];
  imports.add('java.util.List');
  return claims.map(
    (claim) => `    /**
     * ${describe(claim)}
     */
    List<${entity.name}> ${claim.method}();`
  );
}

/** Métodos de la interfaz Spring Data <E>JpaRepository (modelo relacional). */
export function jpaRepositoryMethods(model, entity, imports) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType, field } = entity.lifecycle;
  const selection = claimSelectionSnippet({
    database: model.stack?.database,
    subject: 'el reclamo de la reconciliación'
  });

  imports.add('java.time.Instant');
  imports.add('java.util.List');
  imports.add('java.util.UUID');
  imports.add('org.springframework.data.domain.Pageable');
  imports.add('org.springframework.data.jpa.repository.Query');
  imports.add('org.springframework.data.repository.query.Param');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);
  for (const imported of selection.imports) imports.add(imported);

  return claims.map(
    (claim) => `    /**
     * Candidatos de ${claim.dependency}.${claim.activation}: siguen esperando y llevan más
     * de lo tolerado ahí. El orden es por la marca de espera —el que más lleva, primero—, y
     * quién se los queda lo decide el reclamo, no esta consulta.
     */
${selection.annotations}
    @Query("select e.id from ${entity.name}Jpa e where e.${field} in :states and e.${claim.awaitingField} < :staleBefore order by e.${claim.awaitingField} asc")
    List<UUID> candidatesFor${claim.suffix}(@Param("states") List<${enumType}> states, @Param("staleBefore") Instant staleBefore, Pageable pageable);`
  );
}

const stateList = (claim, enumType) =>
  claim.states.map((state) => `${enumType}.${screamingSnake(state)}`).join(', ');

/** Métodos del adaptador <E>RepositoryImpl (modelo relacional). */
export function adapterMethods(model, entity, imports, jpaField) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType } = entity.lifecycle;
  imports.add('java.time.Instant');
  imports.add('java.util.ArrayList');
  imports.add('java.util.List');
  imports.add('java.util.UUID');
  imports.add('org.springframework.beans.factory.annotation.Value');
  imports.add('org.springframework.data.domain.PageRequest');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);
  imports.add(`${subPackage(model, CLAIM_PKG)}.ReconciliationClaimStore`);
  // La transacción del barrido, con el aislamiento que pida el motor: este método escanea
  // candidatos con SKIP LOCKED igual que el reclamo de una cola, así que arrastra los mismos
  // gap locks. Sale del mismo módulo que decide el hint (lib/claim-sql.js).
  const claimTx = claimTransaction(model.stack?.database, { propagation: null });
  for (const imported of claimTx.imports) imports.add(imported);

  return claims.map(
    (claim) => `    /**
     * ${describe(claim)}
     */
    @Override
${claimTx.annotation}
    public List<${entity.name}> ${claim.method}() {
        Instant now = Instant.now();
        Instant staleBefore = now.minusSeconds(${claim.activation}UnansweredAfterSeconds);
        Instant claimExpiredBefore = now.minusMillis(${claim.activation}ClaimTimeoutMs);
        List<${enumType}> states = List.of(${stateList(claim, enumType)});
        List<UUID> candidates = ${jpaField}.candidatesFor${claim.suffix}(
                states, staleBefore, PageRequest.of(0, ${claim.activation}BatchSize));
        List<${entity.name}> claimed = new ArrayList<>();
        for (UUID id : candidates) {
            // true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
            if (reconciliationClaims.claim("${claim.activation}", id, now, claimExpiredBefore)) {
                ${jpaField}.findById(id).map(this::toDomain).ifPresent(claimed::add);
            }
        }
        return claimed;
    }`
  );
}

/**
 * Métodos del adaptador documental. El reparto de candidatos no depende del motor aquí
 * —no hay SKIP LOCKED ni hace falta—, pero el reclamo sí sigue siendo una marca aparte
 * con caducidad: el documento del agregado no puede llevar la marca sin cambiar lo que el
 * diseño declara, y la llamada al proveedor sigue yendo en medio.
 */
export function documentAdapterMethods(model, entity, imports) {
  const claims = claimsFor(model, entity.name);
  if (claims.length === 0) return [];

  const { enumType, field } = entity.lifecycle;
  imports.add('java.time.Instant');
  imports.add('java.util.ArrayList');
  imports.add('java.util.List');
  imports.add('java.util.UUID');
  imports.add('org.springframework.beans.factory.annotation.Value');
  imports.add('org.springframework.data.domain.Sort');
  imports.add('org.springframework.data.mongodb.core.query.Criteria');
  imports.add('org.springframework.data.mongodb.core.query.Query');
  imports.add(`${subPackage(model, 'domain.enums')}.${enumType}`);
  imports.add(`${subPackage(model, CLAIM_PKG)}.ReconciliationClaimStore`);

  return claims.map(
    (claim) => `    /**
     * ${describe(claim)}
     */
    @Override
    public List<${entity.name}> ${claim.method}() {
        Instant now = Instant.now();
        Instant staleBefore = now.minusSeconds(${claim.activation}UnansweredAfterSeconds);
        Instant claimExpiredBefore = now.minusMillis(${claim.activation}ClaimTimeoutMs);
        Query query = Query.query(new Criteria().andOperator(
                        Criteria.where("${field}").in(List.of(${stateList(claim, enumType)})),
                        Criteria.where("${claim.awaitingField}").lt(staleBefore)))
                .with(Sort.by(Sort.Direction.ASC, "${claim.awaitingField}"))
                .limit(${claim.activation}BatchSize);
        List<${entity.name}> claimed = new ArrayList<>();
        for (${entity.name}Document document : mongoTemplate.find(query, ${entity.name}Document.class)) {
            UUID id = document.getId();
            // true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
            if (reconciliationClaims.claim("${claim.activation}", id, now, claimExpiredBefore)) {
                claimed.add(toDomain(document));
            }
        }
        return claimed;
    }`
  );
}

// ─── La tabla del reclamo y su tienda ────────────────────────────────────────

export function generate(model) {
  if (reconciliationClaims(model).length === 0) return [];
  return model.persistenceKind !== 'document'
    ? [renderEntity(model), renderRepository(model), renderWriter(model), renderStore(model), renderPurge(model)]
    : [renderDocument(model), renderDocumentRepository(model), renderDocumentStore(model), renderDocumentPurge(model)];
}

function renderEntity(model) {
  const body = `/**
 * Marca de que una réplica se llevó un candidato del barrido de reconciliación.
 *
 * <p>La clave es compuesta —activación + entidad— porque una misma entidad puede estar
 * esperando el desenlace de VARIAS activaciones a la vez, y cada barrido reclama la suya.
 * Con una marca compartida, el segundo encargo pisaría el reclamo del primero.
 *
 * <p><b>La marca caduca</b>, y por eso {@code claimed_at} es un instante y no un booleano:
 * un lock de base de datos se suelta cuando muere la conexión, pero una fila no. Sin plazo,
 * la réplica que muera entre el reclamo y el desenlace retendría el candidato para siempre.
 *
 * <p><b>Implementa {@link Persistable}</b>, y de eso depende que el reclamo funcione. Con la
 * clave ASIGNADA y sin esto, {@code SimpleJpaRepository.isNew()} ve el id no nulo, deduce
 * {@code merge()} —SELECT + UPDATE— y la inserción NUNCA viola la clave primaria: las dos
 * réplicas creerían haber reclamado, en silencio.
 */
@Entity
@Table(name = "reconciliation_claim", indexes = {
        @Index(name = "ix_reconciliation_claim_claimed_at", columnList = "claimed_at")
})
public class ReconciliationClaimJpa implements Persistable<ReconciliationClaimJpa.ReconciliationClaimId> {

    @EmbeddedId
    private ReconciliationClaimId id;

    @Column(name = "claimed_at", nullable = false)
    private Instant claimedAt;

    /** Se pone a true al leer la fila de la base ({@code @PostLoad}). */
    @Transient
    private boolean persisted;

    protected ReconciliationClaimJpa() {
    }

    public ReconciliationClaimJpa(ReconciliationClaimId id, Instant claimedAt) {
        this.id = id;
        this.claimedAt = claimedAt;
    }

    @Override
    public ReconciliationClaimId getId() {
        return id;
    }

    public Instant getClaimedAt() {
        return claimedAt;
    }

    @Override
    public boolean isNew() {
        return !persisted;
    }

    @PostLoad
    void markPersisted() {
        this.persisted = true;
    }

    @Embeddable
    public static class ReconciliationClaimId implements Serializable {

        @Column(name = "activation", nullable = false, length = 120)
        private String activation;

        @Column(name = "entity_id", nullable = false)
        private UUID entityId;

        protected ReconciliationClaimId() {
        }

        public ReconciliationClaimId(String activation, UUID entityId) {
            this.activation = activation;
            this.entityId = entityId;
        }

        public String getActivation() {
            return activation;
        }

        public UUID getEntityId() {
            return entityId;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof ReconciliationClaimId that)) {
                return false;
            }
            return Objects.equals(activation, that.activation) && Objects.equals(entityId, that.entityId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(activation, entityId);
        }
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimJpa'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'jakarta.persistence.Column',
        'jakarta.persistence.Embeddable',
        'jakarta.persistence.EmbeddedId',
        'jakarta.persistence.Entity',
        'jakarta.persistence.Index',
        'jakarta.persistence.PostLoad',
        'jakarta.persistence.Table',
        'jakarta.persistence.Transient',
        'java.io.Serializable',
        'java.time.Instant',
        'java.util.Objects',
        'java.util.UUID',
        'org.springframework.data.domain.Persistable'
      ],
      body
    )
  };
}

function renderRepository(model) {
  const body = `public interface ReconciliationClaimJpaRepository
        extends JpaRepository<ReconciliationClaimJpa, ReconciliationClaimJpa.ReconciliationClaimId> {

    /**
     * Se lleva un candidato cuyo reclamo YA CADUCÓ. Devuelve 1 si la marca es de esta
     * instancia y 0 si otra la tiene todavía viva — esa comparación en el WHERE es toda la
     * exclusión mutua, y no depende del motor.
     */
    @Modifying
    @Query("update ReconciliationClaimJpa c set c.claimedAt = :now where c.id.activation = :activation and c.id.entityId = :entityId and c.claimedAt <= :expiredBefore")
    int claimIfExpired(@Param("activation") String activation, @Param("entityId") UUID entityId,
            @Param("now") Instant now, @Param("expiredBefore") Instant expiredBefore);

    @Modifying
    @Query("delete from ReconciliationClaimJpa c where c.claimedAt < :cutoff")
    int deleteClaimedBefore(@Param("cutoff") Instant cutoff);
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimJpaRepository'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'java.util.UUID',
        'org.springframework.data.jpa.repository.JpaRepository',
        'org.springframework.data.jpa.repository.Modifying',
        'org.springframework.data.jpa.repository.Query',
        'org.springframework.data.repository.query.Param'
      ],
      body
    )
  };
}

function renderWriter(model) {
  const body = `/**
 * Inserción de la marca, en un bean aparte y con transacción propia.
 *
 * <p>Las dos cosas son la misma vista dos veces: el proxy de Spring. Un
 * {@code REQUIRES_NEW} invocado desde otro método de la MISMA clase no pasa por el proxy y
 * no se aplica; y la violación de clave —que aquí es el resultado ESPERADO de una carrera—
 * deja la transacción marcada rollback-only, así que capturarla dentro acabaría en
 * {@code UnexpectedRollbackException} al commitear. Aquí se LANZA, y quien la interpreta
 * está fuera con su transacción ya revertida.
 */
@Component
class ReconciliationClaimWriter {

    private final ReconciliationClaimJpaRepository repository;

    ReconciliationClaimWriter(ReconciliationClaimJpaRepository repository) {
        this.repository = repository;
    }

    /** Inserta o lanza. {@code saveAndFlush} porque JPA diferiría el INSERT hasta el commit. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    void insert(ReconciliationClaimJpa.ReconciliationClaimId key, Instant now) {
        repository.saveAndFlush(new ReconciliationClaimJpa(key, now));
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimWriter'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'org.springframework.stereotype.Component',
        'org.springframework.transaction.annotation.Propagation',
        'org.springframework.transaction.annotation.Transactional'
      ],
      body
    )
  };
}

function renderStore(model) {
  const body = `/**
 * Quién se lleva cada candidato del barrido de reconciliación.
 *
 * <p>Dos caminos y ninguno sobra, porque la fila puede no existir todavía:
 *
 * <ol>
 *   <li>Si existe y su marca caducó, un UPDATE condicional la renueva: 1 fila afectada = es
 *       mía.</li>
 *   <li>Si no existe, se INSERTA y la clave primaria arbitra la carrera entre dos réplicas
 *       que la insertan a la vez: la que pierde recibe la violación de clave, que aquí no es
 *       un error sino el desenlace normal.</li>
 * </ol>
 *
 * <p>Y si existe con la marca VIVA, el UPDATE no toca nada y el INSERT choca: las dos vías
 * dicen que no, que es lo que se quiere.
 */
@Component
public class ReconciliationClaimStore {

    private final ReconciliationClaimJpaRepository repository;
    private final ReconciliationClaimWriter writer;

    ReconciliationClaimStore(ReconciliationClaimJpaRepository repository, ReconciliationClaimWriter writer) {
        this.repository = repository;
        this.writer = writer;
    }

    /**
     * @param activation qué encargo se reclama (una entidad puede esperar varios)
     * @param entityId cuál de ellos
     * @param now marca que se estampa
     * @param expiredBefore instante por debajo del cual un reclamo ajeno ya caducó
     * @return true si el candidato es de esta instancia
     */
    public boolean claim(String activation, UUID entityId, Instant now, Instant expiredBefore) {
        if (repository.claimIfExpired(activation, entityId, now, expiredBefore) == 1) {
            return true;
        }
        try {
            writer.insert(new ReconciliationClaimJpa.ReconciliationClaimId(activation, entityId), now);
            return true;
        } catch (DataIntegrityViolationException
                | PessimisticLockingFailureException
                | TransactionSystemException race) {
            // Otra réplica insertó la marca entre el UPDATE y el INSERT: suya es.
            //
            // Las DOS familias, y la segunda no es defensiva. Dos INSERT concurrentes con la
            // misma clave no siempre acaban en violación de restricción: InnoDB hace esperar
            // al segundo sobre el lock del primero, y si el desenlace tarda sale por
            // lock-wait timeout o deadlock — que Spring traduce a PessimisticLockingFailure,
            // no a DataIntegrityViolation. Capturando solo la primera, el barrido revienta
            // con una excepción en vez de ceder el candidato, y lo hace justo cuando hay
            // competencia, que es cuando este código existe para funcionar.
            //
            // Y la TERCERA, que llega por otro camino: el insert corre en su propia
            // transacción (REQUIRES_NEW), y esa transacción CONFIRMA al volver del proxy —
            // o sea, aquí dentro. Un fallo en ese commit no viaja como excepción de acceso a
            // datos sino como TransactionSystemException, que no es DataAccessException y se
            // escaparía de las dos anteriores. Significa lo mismo: la marca no quedó
            // confirmada, luego el candidato no es de esta instancia.
            //
            // Ceder de más es benigno: si el timeout viniera de otra cosa, esta pasada no se
            // lleva el candidato y la siguiente lo recoge. Lo caro es lo contrario.
            return false;
        }
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimStore'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'java.util.UUID',
        'org.springframework.dao.DataIntegrityViolationException',
        'org.springframework.dao.PessimisticLockingFailureException',
        'org.springframework.stereotype.Component',
        'org.springframework.transaction.TransactionSystemException'
      ],
      body
    )
  };
}

function renderPurge(model) {
  const body = `/**
 * Barrido de limpieza de la tabla de reclamos.
 *
 * <p>Corre en todas las réplicas y NO reclama nada, a diferencia del barrido al que sirve:
 * borrar lo caducado es idempotente por forma —borrar dos veces la misma fila da el mismo
 * resultado que borrarla una—, así que solaparse no produce ningún efecto doble.
 *
 * <p>La retención es de días, muy por encima de la caducidad del reclamo (segundos): lo que
 * borra son marcas de encargos ya resueltos. Si borrase una viva, tampoco se rompería nada
 * —el siguiente reclamo la vuelve a insertar—, pero dos réplicas podrían llevarse el mismo
 * candidato en esa pasada.
 */
@Component
public class ReconciliationClaimPurge {

    private static final Logger log = LoggerFactory.getLogger(ReconciliationClaimPurge.class);

    private final ReconciliationClaimJpaRepository repository;

    @Value("\${reconciliation.purge.retention-days:7}")
    private int retentionDays;

    ReconciliationClaimPurge(ReconciliationClaimJpaRepository repository) {
        this.repository = repository;
    }

    @Scheduled(cron = "\${reconciliation.purge.cron:0 45 4 * * *}")
    @Transactional
    public void purge() {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        int deleted = repository.deleteClaimedBefore(cutoff);
        if (deleted > 0) {
            log.info("Reconciliación: {} reclamos purgados antes de {}", deleted, cutoff);
        }
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimPurge'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'java.time.temporal.ChronoUnit',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.scheduling.annotation.Scheduled',
        'org.springframework.stereotype.Component',
        'org.springframework.transaction.annotation.Transactional'
      ],
      body
    )
  };
}

// ─── Espejo documental ───────────────────────────────────────────────────────

function renderDocument(model) {
  const body = `/**
 * Marca de que una réplica se llevó un candidato del barrido de reconciliación.
 *
 * <p>El {@code _id} es la clave compuesta aplanada ({@code <activación>|<id>}): una misma
 * entidad puede esperar el desenlace de varias activaciones, y cada barrido reclama la suya.
 * Que la unicidad la dé el {@code _id} es lo que hace que Mongo arbitre la carrera sin
 * transacción ninguna.
 */
@Document(collection = "reconciliation_claim")
public class ReconciliationClaimDocument {

    @Id
    private String id;

    @Field(name = "activation")
    private String activation;

    @Field(name = "entity_id")
    private UUID entityId;

    /** Cuándo se reclamó. Caduca: ver ReconciliationClaimStore. */
    @Field(name = "claimed_at")
    private Instant claimedAt;

    protected ReconciliationClaimDocument() {
    }

    public ReconciliationClaimDocument(String activation, UUID entityId, Instant claimedAt) {
        this.id = key(activation, entityId);
        this.activation = activation;
        this.entityId = entityId;
        this.claimedAt = claimedAt;
    }

    public static String key(String activation, UUID entityId) {
        return activation + "|" + entityId;
    }

    public String getId() {
        return id;
    }

    public String getActivation() {
        return activation;
    }

    public UUID getEntityId() {
        return entityId;
    }

    public Instant getClaimedAt() {
        return claimedAt;
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimDocument'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'java.util.UUID',
        'org.springframework.data.annotation.Id',
        'org.springframework.data.mongodb.core.mapping.Document',
        'org.springframework.data.mongodb.core.mapping.Field'
      ],
      body
    )
  };
}

function renderDocumentRepository(model) {
  const body = `public interface ReconciliationClaimMongoRepository
        extends MongoRepository<ReconciliationClaimDocument, String> {

    long deleteByClaimedAtBefore(Instant cutoff);
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimMongoRepository'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      ['java.time.Instant', 'org.springframework.data.mongodb.repository.MongoRepository'],
      body
    )
  };
}

function renderDocumentStore(model) {
  const body = `/**
 * Quién se lleva cada candidato del barrido de reconciliación.
 *
 * <p>Un solo {@code upsert} hace las dos mitades, y es atómico por documento: el filtro pide
 * el reclamo CADUCADO, así que si la marca está viva no casa con nada y Mongo intenta
 * insertar — choca con el {@code _id} y la clave duplicada dice que el candidato es de otra
 * réplica. Si no existía, la inserción es el reclamo. Sin transacción ninguna: el equivalente
 * exacto del UPDATE condicional de la rama relacional.
 */
@Component
public class ReconciliationClaimStore {

    private final MongoTemplate mongoTemplate;

    ReconciliationClaimStore(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * @param activation qué encargo se reclama (una entidad puede esperar varios)
     * @param entityId cuál de ellos
     * @param now marca que se estampa
     * @param expiredBefore instante por debajo del cual un reclamo ajeno ya caducó
     * @return true si el candidato es de esta instancia
     */
    public boolean claim(String activation, UUID entityId, Instant now, Instant expiredBefore) {
        String key = ReconciliationClaimDocument.key(activation, entityId);
        Query query = Query.query(new Criteria().andOperator(
                Criteria.where("_id").is(key),
                Criteria.where("claimed_at").lte(expiredBefore)));
        Update update = new Update()
                .set("claimed_at", now)
                .setOnInsert("activation", activation)
                .setOnInsert("entity_id", entityId);
        try {
            mongoTemplate.upsert(query, update, ReconciliationClaimDocument.class);
            return true;
        } catch (DuplicateKeyException race) {
            // La marca sigue viva y es de otra réplica.
            return false;
        }
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimStore'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'java.util.UUID',
        'org.springframework.dao.DuplicateKeyException',
        'org.springframework.data.mongodb.core.MongoTemplate',
        'org.springframework.data.mongodb.core.query.Criteria',
        'org.springframework.data.mongodb.core.query.Query',
        'org.springframework.data.mongodb.core.query.Update',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}

function renderDocumentPurge(model) {
  const body = `/**
 * Barrido de limpieza de la colección de reclamos.
 *
 * <p>Corre en todas las réplicas y NO reclama nada, a diferencia del barrido al que sirve:
 * borrar lo caducado es idempotente por forma, así que solaparse no produce ningún efecto
 * doble.
 */
@Component
public class ReconciliationClaimPurge {

    private static final Logger log = LoggerFactory.getLogger(ReconciliationClaimPurge.class);

    private final ReconciliationClaimMongoRepository repository;

    @Value("\${reconciliation.purge.retention-days:7}")
    private int retentionDays;

    ReconciliationClaimPurge(ReconciliationClaimMongoRepository repository) {
        this.repository = repository;
    }

    @Scheduled(cron = "\${reconciliation.purge.cron:0 45 4 * * *}")
    public void purge() {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        long deleted = repository.deleteByClaimedAtBefore(cutoff);
        if (deleted > 0) {
            log.info("Reconciliación: {} reclamos purgados antes de {}", deleted, cutoff);
        }
    }
}`;

  return {
    path: javaPath(model, CLAIM_PKG, 'ReconciliationClaimPurge'),
    content: javaFile(
      subPackage(model, CLAIM_PKG),
      [
        'java.time.Instant',
        'java.time.temporal.ChronoUnit',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.scheduling.annotation.Scheduled',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}
