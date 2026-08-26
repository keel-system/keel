// Patrón outbox (messaging.publishing.reliability: outbox): garantiza que
// ningún evento se pierde si la transacción confirma, y que ninguno sale si
// revierte. El bridge escribe la fila DENTRO de la transacción del cambio
// (messaging.js) y este relay la entrega después, fuera de ella.
//
// Todo lo de aquí es transversal al broker: la tabla, el repositorio, el
// polling, los reintentos y la purga. Lo único acoplado al broker es el ENVÍO,
// que sale por el puerto OutboxDispatcher; su implementación la escribe el
// agente siguiendo la skill keel-spring-<broker>.

import { javaFile, javaPath, subPackage } from './render.js';
import { claimSelectionSnippet, claimTransaction, supportsSkipLocked } from '../lib/claim-sql.js';

const OUTBOX_PKG = 'infrastructure.messaging.outbox';

/** La clase del relay. Se nombra aquí una vez porque más de uno la referencia. */
export const OUTBOX_RELAY_CLASS = 'OutboxRelay';

/**
 * El nombre con el que el relay vive en el contexto de Spring: el de su clase con la
 * inicial en minúscula, que es la convención de `@Component` sin valor explícito.
 *
 * Existe como función exportada, y no como literal en quien lo necesite, por lo mismo que
 * `harnessQueueName` o `publishedDestination`: el arnés de integración tiene que pausar
 * este bean durante la resiembra de la topología y lo resuelve POR NOMBRE —no puede
 * importar su clase, que vive en `main` y está fuera de su compileClasspath—, así que si
 * el nombre se escribiera a mano en la plantilla del arnés, renombrar la clase aquí
 * dejaría la pausa sin efecto y en silencio.
 */
export function outboxRelayBeanName() {
  return `${OUTBOX_RELAY_CLASS.charAt(0).toLowerCase()}${OUTBOX_RELAY_CLASS.slice(1)}`;
}

// El outbox necesita una transacción de BD que compartir con el cambio del
// agregado: sin capa persistence no hay nada que hacer atómico.
export function usesOutbox(model) {
  return Boolean(
    model.layersPresent.messaging &&
      model.layersPresent.persistence &&
      model.messaging?.reliability === 'outbox' &&
      model.events.length > 0
  );
}

/**
 * Nombres del espejo persistido del outbox, que cambian con el modelo pero no su
 * papel. Se centralizan aquí para que el relay —cuya lógica de backoff,
 * dead-letter y purga es idéntica— no los repita.
 */
export function outboxNames(model) {
  return model.persistenceKind === 'document'
    ? { entity: 'OutboxEventDocument', repository: 'OutboxEventMongoRepository' }
    : { entity: 'OutboxEventJpa', repository: 'OutboxEventJpaRepository' };
}

export function generate(model) {
  if (!usesOutbox(model)) return [];
  const document = model.persistenceKind === 'document';
  return [
    document ? renderDocument(model) : renderEntity(model),
    document ? renderDocumentRepository(model) : renderRepository(model),
    renderDispatcherPort(model),
    renderDispatcherStub(model),
    document ? renderDocumentRelay(model) : renderRelay(model)
  ];
}

function renderEntity(model) {
  const body = `/**
 * Fila del outbox: un evento pendiente de entregar al broker.
 *
 * Se escribe en la misma transacción que el cambio del agregado que lo provocó
 * (por eso la atomicidad) y el relay la marca publicada cuando sale.
 */
@Entity
@Table(name = "outbox_event", indexes = {
        @Index(name = "ix_outbox_event_pending", columnList = "published_at, created_at")
})
public class OutboxEventJpa {

    @Id
    private UUID id;

    /** Exchange / topic destino, tal como lo resolvió el bridge. */
    @Column(name = "destination", nullable = false)
    private String destination;

    /** Clave de enrutado dentro del destino. */
    @Column(name = "routing_key", nullable = false)
    private String routingKey;

    /** Tipo del evento de integración serializado (trazabilidad y filtros). */
    @Column(name = "event_type", nullable = false)
    private String eventType;

    /** EventEnvelope serializada a JSON: lo que viaja tal cual al broker. */
    @Column(name = "payload", nullable = false, columnDefinition = "text")
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** Null mientras esté pendiente; es lo que distingue una fila por entregar. */
    @Column(name = "published_at")
    private Instant publishedAt;

    @Column(name = "attempts", nullable = false)
    private int attempts;

    /** Momento a partir del cual la fila vuelve a ser elegible; null = ya. */
    @Column(name = "next_attempt_at")
    private Instant nextAttemptAt;

    @Column(name = "last_error", length = 1024)
    private String lastError;

    protected OutboxEventJpa() {
        // Requerido por JPA.
    }

    public OutboxEventJpa(
            UUID id,
            String destination,
            String routingKey,
            String eventType,
            String payload,
            Instant createdAt,
            Instant publishedAt,
            int attempts,
            String lastError,
            Instant nextAttemptAt) {
        this.id = id;
        this.destination = destination;
        this.routingKey = routingKey;
        this.eventType = eventType;
        this.payload = payload;
        this.createdAt = createdAt;
        this.publishedAt = publishedAt;
        this.attempts = attempts;
        this.lastError = lastError;
        this.nextAttemptAt = nextAttemptAt;
    }

    public UUID getId() {
        return id;
    }

    public String getDestination() {
        return destination;
    }

    public String getRoutingKey() {
        return routingKey;
    }

    public String getEventType() {
        return eventType;
    }

    public String getPayload() {
        return payload;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getPublishedAt() {
        return publishedAt;
    }

    public int getAttempts() {
        return attempts;
    }

    public Instant getNextAttemptAt() {
        return nextAttemptAt;
    }

    public String getLastError() {
        return lastError;
    }

    public void markPublished(Instant publishedAt) {
        this.publishedAt = publishedAt;
    }

    public void markFailed(String error) {
        this.attempts = this.attempts + 1;
        this.lastError = error;
    }

    /** Aplaza la próxima elegibilidad de la fila (backoff calculado por el relay). */
    public void scheduleNextAttempt(Instant nextAttemptAt) {
        this.nextAttemptAt = nextAttemptAt;
    }
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, 'OutboxEventJpa'),
    content: javaFile(
      subPackage(model, OUTBOX_PKG),
      [
        'jakarta.persistence.Column',
        'jakarta.persistence.Entity',
        'jakarta.persistence.Id',
        'jakarta.persistence.Index',
        'jakarta.persistence.Table',
        'java.time.Instant',
        'java.util.UUID'
      ],
      body
    )
  };
}

function renderRepository(model) {
  // De qué motor se trata lo decide lib/claim-sql.js, igual que en el reclamo de un
  // barrido: emitir el hint donde el motor no lo entiende no es inocuo — en H2 se acepta
  // y se IGNORA (las réplicas siguen compitiendo, pero el javadoc promete lo contrario) y
  // en MySQL <8.0, MariaDB <10.6 u Oracle 11 la consulta falla por sintaxis.
  const skipLocked = supportsSkipLocked(model.stack?.database);
  const selection = claimSelectionSnippet({
    database: model.stack?.database,
    subject: 'la entrega'
  });
  const body = `public interface OutboxEventJpaRepository extends JpaRepository<OutboxEventJpa, UUID> {

    /**
     * Pendientes en orden de llegada que aún no agotaron los reintentos y cuyo
     * backoff ya venció (nextAttemptAt null = elegible ya). ${
       skipLocked
         ? `Toma un lock de
     * escritura con SKIP LOCKED (el hint de lock timeout -2): con varias réplicas
     * del relay, cada una se lleva un lote disjunto en vez de competir por las
     * mismas filas. El lock se sostiene hasta el fin de la transacción del relay,
     * que es corta: lo que envuelve es la entrega al broker, no una llamada a un
     * proveedor.`
         : `El motor elegido no reparte
     * candidatos entre réplicas, así que todas ven la misma página: la entrega
     * sigue sin duplicarse —lo impide el marcado de la fila, que va en la misma
     * transacción— pero N-1 réplicas tiran su ciclo.`
     }
     */
${selection.annotations}
    @Query("select o from OutboxEventJpa o where o.publishedAt is null and o.attempts < :maxAttempts and (o.nextAttemptAt is null or o.nextAttemptAt <= :now) order by o.createdAt asc")
    List<OutboxEventJpa> findPending(@Param("maxAttempts") int maxAttempts, @Param("now") Instant now, Pageable pageable);

    @Modifying
    @Query("delete from OutboxEventJpa o where o.publishedAt is not null and o.publishedAt < :cutoff")
    int deletePublishedBefore(@Param("cutoff") Instant cutoff);
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, 'OutboxEventJpaRepository'),
    content: javaFile(
      subPackage(model, OUTBOX_PKG),
      [
        'java.time.Instant',
        'java.util.List',
        'java.util.UUID',
        'org.springframework.data.domain.Pageable',
        'org.springframework.data.jpa.repository.JpaRepository',
        'org.springframework.data.jpa.repository.Modifying',
        'org.springframework.data.jpa.repository.Query',
        'org.springframework.data.repository.query.Param',
        // Solo los arrastra el motor que reparte candidatos: pedirlos siempre dejaría
        // imports sin usar en el que no.
        ...selection.imports
      ],
      body
    )
  };
}

// ─── Espejo documental del outbox ────────────────────────────────────────────
//
// Mismo papel, misma tabla de campos y mismos nombres lógicos que la versión JPA;
// dos diferencias de fondo, y ambas vienen de que en Mongo no hay lock de fila:
//
//  1. El reclamo del lote no puede ser `SELECT … FOR UPDATE SKIP LOCKED`. Se hace
//     con findAndModify, que es atómico por documento: quien gana la operación se
//     lleva la fila estampándole `claimed_at`, y el resto de réplicas dejan de
//     verla. Es el equivalente exacto del SKIP LOCKED, con el mismo efecto (lotes
//     disjuntos) y sin transacción larga.
//  2. `claimed_at` caduca. Un lock de base de datos se suelta solo cuando muere la
//     conexión; una marca en un documento no, así que una réplica que muera entre
//     el reclamo y la entrega dejaría la fila retenida para siempre. Pasado
//     `outbox.relay.claim-timeout-ms` la fila vuelve a ser elegible.

function renderDocument(model) {
  const body = `/**
 * Documento del outbox: un evento pendiente de entregar al broker.
 *
 * Se escribe en la misma transacción que el cambio del agregado que lo provocó —de
 * ahí que la infraestructura arranque como replica set— y el relay lo marca
 * publicado cuando sale.
 */
@Document(collection = "outbox_event")
public class OutboxEventDocument {

    @Id
    private UUID id;

    /** Exchange / topic destino, tal como lo resolvió el bridge. */
    @Field(name = "destination")
    private String destination;

    /** Clave de enrutado dentro del destino. */
    @Field(name = "routing_key")
    private String routingKey;

    /** Tipo del evento de integración serializado (trazabilidad y filtros). */
    @Field(name = "event_type")
    private String eventType;

    /** EventEnvelope serializada a JSON: lo que viaja tal cual al broker. */
    @Field(name = "payload")
    private String payload;

    @Field(name = "created_at")
    private Instant createdAt;

    /** Null mientras esté pendiente; es lo que distingue una fila por entregar. */
    @Field(name = "published_at")
    private Instant publishedAt;

    @Field(name = "attempts")
    private int attempts;

    /** Momento a partir del cual la fila vuelve a ser elegible; null = ya. */
    @Field(name = "next_attempt_at")
    private Instant nextAttemptAt;

    /**
     * Marca de reclamo: la estampa el relay que se lleva la fila, y es lo que evita
     * que dos réplicas entreguen el mismo evento. Caduca (ver la cabecera del
     * generador): una réplica que muera con filas reclamadas no las retiene.
     */
    @Field(name = "claimed_at")
    private Instant claimedAt;

    @Field(name = "last_error")
    private String lastError;

    protected OutboxEventDocument() {
        // Requerido por el mapeo de Spring Data.
    }

    public OutboxEventDocument(
            UUID id,
            String destination,
            String routingKey,
            String eventType,
            String payload,
            Instant createdAt,
            Instant publishedAt,
            int attempts,
            String lastError,
            Instant nextAttemptAt) {
        this.id = id;
        this.destination = destination;
        this.routingKey = routingKey;
        this.eventType = eventType;
        this.payload = payload;
        this.createdAt = createdAt;
        this.publishedAt = publishedAt;
        this.attempts = attempts;
        this.lastError = lastError;
        this.nextAttemptAt = nextAttemptAt;
    }

    public UUID getId() {
        return id;
    }

    public String getDestination() {
        return destination;
    }

    public String getRoutingKey() {
        return routingKey;
    }

    public String getEventType() {
        return eventType;
    }

    public String getPayload() {
        return payload;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getPublishedAt() {
        return publishedAt;
    }

    public int getAttempts() {
        return attempts;
    }

    public Instant getNextAttemptAt() {
        return nextAttemptAt;
    }

    public Instant getClaimedAt() {
        return claimedAt;
    }

    public String getLastError() {
        return lastError;
    }

    public void markPublished(Instant publishedAt) {
        this.publishedAt = publishedAt;
    }

    public void markFailed(String error) {
        this.attempts = this.attempts + 1;
        this.lastError = error;
    }

    /** Aplaza la próxima elegibilidad de la fila (backoff calculado por el relay). */
    public void scheduleNextAttempt(Instant nextAttemptAt) {
        this.nextAttemptAt = nextAttemptAt;
    }

    /** Libera el reclamo para que la fila vuelva al polling sin esperar a que caduque. */
    public void releaseClaim() {
        this.claimedAt = null;
    }
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, 'OutboxEventDocument'),
    content: javaFile(
      subPackage(model, OUTBOX_PKG),
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
  const body = `public interface OutboxEventMongoRepository extends MongoRepository<OutboxEventDocument, UUID> {

    /**
     * Purga de lo ya entregado. El reclamo del lote pendiente NO está aquí: necesita
     * findAndModify (atómico por documento) y lo hace el relay con MongoTemplate.
     */
    long deleteByPublishedAtNotNullAndPublishedAtBefore(Instant cutoff);
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, 'OutboxEventMongoRepository'),
    content: javaFile(
      subPackage(model, OUTBOX_PKG),
      ['java.time.Instant', 'java.util.UUID', 'org.springframework.data.mongodb.repository.MongoRepository'],
      body
    )
  };
}

function renderDocumentRelay(model) {
  const body = `/**
 * Reenvía al broker los documentos pendientes del outbox, ya fuera de la
 * transacción que los creó.
 *
 * Un fallo de entrega no revierte nada: incrementa el contador de intentos y la
 * fila se reintenta en la pasada siguiente (entrega at-least-once — el consumidor
 * deduplica por metadata.eventId). Una fila que agota maxAttempts queda como
 * dead-letter: deja de reclamarse y se reporta a ERROR, sin borrarse, para
 * inspección. Un cron diario purga lo ya publicado. Cadencias, retención y tope de
 * intentos salen de parameters/, nunca del código.
 *
 * Sin @Transactional, y a propósito: en la versión JPA la transacción existe para
 * sostener el lock pesimista del lote hasta el commit. Aquí el reclamo ya es atómico
 * por documento (findAndModify) y cada actualización también lo es, así que abrir
 * una transacción solo serviría para mantenerla abierta durante la entrega al
 * broker — I/O externo dentro de una transacción de base de datos.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxEventMongoRepository outboxRepository;
    private final MongoTemplate mongoTemplate;
    private final OutboxDispatcher dispatcher;

    @Value("\${outbox.relay.batch-size:100}")
    private int batchSize;

    @Value("\${outbox.relay.max-attempts:10}")
    private int maxAttempts;

    @Value("\${outbox.relay.backoff.initial-ms:1000}")
    private long backoffInitialMs;

    @Value("\${outbox.relay.backoff.max-ms:60000}")
    private long backoffMaxMs;

    /** Cuánto retiene un reclamo antes de que la fila vuelva a ser elegible. */
    @Value("\${outbox.relay.claim-timeout-ms:60000}")
    private long claimTimeoutMs;

    @Value("\${outbox.purge.retention-days:7}")
    private int retentionDays;

    public OutboxRelay(
            OutboxEventMongoRepository outboxRepository,
            MongoTemplate mongoTemplate,
            OutboxDispatcher dispatcher) {
        this.outboxRepository = outboxRepository;
        this.mongoTemplate = mongoTemplate;
        this.dispatcher = dispatcher;
    }

    @Scheduled(fixedDelayString = "\${outbox.relay.fixed-delay-ms:1000}")
    public void relay() {
        for (OutboxEventDocument row : claimPending()) {
            try {
                dispatcher.dispatch(row.getDestination(), row.getRoutingKey(), row.getEventType(), row.getPayload());
                row.markPublished(Instant.now());
                row.releaseClaim();
            } catch (RuntimeException ex) {
                row.markFailed(truncate(ex.getMessage()));
                row.releaseClaim();
                if (row.getAttempts() >= maxAttempts) {
                    // Dead-letter: agotó los reintentos. Queda parada (fuera de futuros
                    // reclamos) para inspección manual; no se borra ni bloquea al resto.
                    log.error("Outbox: {} agotó {} reintentos y queda como dead-letter: {}",
                            row.getId(), maxAttempts, ex.getMessage());
                } else {
                    // Backoff: aplaza el próximo intento crecientemente para no
                    // reintentar en bucle apretado si el broker está caído.
                    row.scheduleNextAttempt(Instant.now().plusMillis(backoffDelayMs(row.getAttempts())));
                    log.warn("Outbox: fallo entregando {} (intento {}): {}", row.getId(), row.getAttempts(), ex.getMessage());
                }
            }
            outboxRepository.save(row);
        }
    }

    /**
     * Reclama hasta batchSize pendientes, en orden de llegada. Cada findAndModify es
     * atómico: con varias réplicas del relay, cada una se lleva un lote disjunto en
     * vez de entregar todas el mismo evento. Es el equivalente del SKIP LOCKED de la
     * rama relacional.
     */
    private List<OutboxEventDocument> claimPending() {
        Instant now = Instant.now();
        Instant claimCutoff = now.minusMillis(claimTimeoutMs);
        Query query = new Query(new Criteria().andOperator(
                        Criteria.where("published_at").is(null),
                        Criteria.where("attempts").lt(maxAttempts),
                        new Criteria().orOperator(
                                Criteria.where("next_attempt_at").is(null),
                                Criteria.where("next_attempt_at").lte(now)),
                        new Criteria().orOperator(
                                Criteria.where("claimed_at").is(null),
                                Criteria.where("claimed_at").lte(claimCutoff))))
                .with(Sort.by(Sort.Direction.ASC, "created_at"));
        Update claim = new Update().set("claimed_at", now);
        FindAndModifyOptions options = FindAndModifyOptions.options().returnNew(true);

        List<OutboxEventDocument> claimed = new ArrayList<>();
        for (int i = 0; i < batchSize; i++) {
            OutboxEventDocument row = mongoTemplate.findAndModify(query, claim, options, OutboxEventDocument.class);
            if (row == null) {
                break;
            }
            claimed.add(row);
        }
        return claimed;
    }

    // Backoff exponencial (multiplicador 2) con tope: initial * 2^(attempts-1),
    // saturado en max. En long y con guarda del desplazamiento para no desbordar.
    private long backoffDelayMs(int attempts) {
        int shift = Math.min(attempts - 1, 62);
        long delay = backoffInitialMs << shift;
        if (delay < 0 || delay > backoffMaxMs) {
            return backoffMaxMs;
        }
        return delay;
    }

    @Scheduled(cron = "\${outbox.purge.cron:0 0 3 * * *}")
    public void purge() {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        long deleted = outboxRepository.deleteByPublishedAtNotNullAndPublishedAtBefore(cutoff);
        if (deleted > 0) {
            log.info("Outbox: purgados {} documentos publicados antes de {}", deleted, cutoff);
        }
    }

    private static String truncate(String message) {
        if (message == null) {
            return null;
        }
        return message.length() <= 1024 ? message : message.substring(0, 1024);
    }
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, OUTBOX_RELAY_CLASS),
    content: javaFile(
      subPackage(model, OUTBOX_PKG),
      [
        'java.time.Instant',
        'java.time.temporal.ChronoUnit',
        'java.util.ArrayList',
        'java.util.List',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.data.domain.Sort',
        'org.springframework.data.mongodb.core.FindAndModifyOptions',
        'org.springframework.data.mongodb.core.MongoTemplate',
        'org.springframework.data.mongodb.core.query.Criteria',
        'org.springframework.data.mongodb.core.query.Query',
        'org.springframework.data.mongodb.core.query.Update',
        'org.springframework.scheduling.annotation.Scheduled',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}

// Única frontera con el broker en todo el patrón outbox.
function renderDispatcherPort(model) {
  const body = `/**
 * Puerto de salida del outbox: entrega al broker una fila ya serializada.
 *
 * Es lo ÚNICO acoplado al broker en todo el patrón; la implementación vive en
 * infrastructure/messaging y la escribe el agente según keel-stack.json
 * (skill keel-spring-<broker>).
 */
public interface OutboxDispatcher {

    /**
     * Envía el payload al destino indicado. Debe lanzar excepción si la entrega
     * no se confirma: el relay cuenta el intento y reintenta en la pasada siguiente.
     */
    void dispatch(String destination, String routingKey, String eventType, String payload);
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, 'OutboxDispatcher'),
    content: javaFile(subPackage(model, OUTBOX_PKG), [], body)
  };
}

// Stub del puerto: el contexto arranca (y el relay corre) sin broker todavía.
//
// Tres decisiones, y ninguna es de estilo:
//
// 1. `dispatch` NO lanza. El relay lo interpretaría como fallo de entrega y las filas
//    se acumularían con `attempts` creciendo hasta la dead-letter.
// 2. Va como @Bean con @ConditionalOnMissingBean, no como @Component. El agente
//    escribe el dispatcher real y este se aparta solo: sin la condición serían dos
//    beans del mismo puerto y el contexto no arrancaría, así que el camino de menor
//    resistencia sería BORRAR este archivo — y entonces nada quedaría avisando.
//    Sobre un @Component la condición no es fiable: depende del orden del scan.
// 3. Falla al arrancar fuera de `local`/`test`. Que `dispatch` no lance tiene un
//    precio: el relay marca como publicadas filas que nunca salieron, y `reliability:
//    outbox` —que el diseño eligió para que ningún evento se perdiera— se convierte en
//    perder todos los eventos sin un solo error. En local eso es justo lo que se quiere
//    (arrancar sin broker); en cualquier otro perfil es la peor forma de fallar.
function renderDispatcherStub(model) {
  const body = `/**
 * Fallback del puerto de salida del outbox mientras no hay dispatcher real.
 *
 * Cede el sitio en cuanto exista otro bean de {@link OutboxDispatcher}: no hay que
 * borrar este archivo, hay que escribir el de verdad.
 */
@Configuration
public class OutboxDispatcherFallbackConfig {

    private static final Logger log = LoggerFactory.getLogger(OutboxDispatcherFallbackConfig.class);

    /** Perfiles en los que arrancar sin broker es legítimo. */
    private static final Set<String> TOLERATED = Set.of("local", "test");

    @Bean
    @ConditionalOnMissingBean(OutboxDispatcher.class)
    public OutboxDispatcher outboxDispatcherStub(Environment environment) {
        List<String> active = List.of(environment.getActiveProfiles());
        if (!active.isEmpty() && active.stream().noneMatch(TOLERATED::contains)) {
            // El relay daría por publicada cada fila que le pase por aquí. Con
            // reliability: outbox eso no es degradarse, es perderlo todo en silencio.
            throw new IllegalStateException(
                "No hay implementación de OutboxDispatcher y el perfil activo es " + active
                    + ": el relay marcaría como publicados eventos que nunca salen del proceso. "
                    + "Impleméntalo con la skill keel-spring-<broker> del stack elegido en keel-stack.json.");
        }
        log.warn("OutboxDispatcher sin implementar: los eventos NO salen del proceso (perfil {})", active);
        return (destination, routingKey, eventType, payload) -> {
            // TODO (agente): sustituir este stub por el dispatcher real del broker
            //   elegido en keel-stack.json (skill keel-spring-<broker>):
            //   enviar el payload tal cual (ya es la EventEnvelope serializada) al
            //   destino/routing key indicados, con content-type application/json.
            log.warn("OutboxDispatcher no implementado: {} no salió a {}/{}", eventType, destination, routingKey);
        };
    }
}`;

  return {
    path: javaPath(model, 'infrastructure.messaging', 'OutboxDispatcherFallbackConfig'),
    content: javaFile(
      subPackage(model, 'infrastructure.messaging'),
      [
        'java.util.List',
        'java.util.Set',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean',
        'org.springframework.context.annotation.Bean',
        'org.springframework.context.annotation.Configuration',
        'org.springframework.core.env.Environment',
        `${subPackage(model, OUTBOX_PKG)}.OutboxDispatcher`
      ],
      body
    )
  };
}

function renderRelay(model) {
  // El aislamiento del relay, y aquí importa más que en ningún otro reclamo: esta
  // transacción no dura lo que un UPDATE, dura lo que la ENTREGA AL BROKER de todo el lote
  // —su javadoc explica por qué tiene que sostener el lock hasta el commit—. Con los gap
  // locks de REPEATABLE READ puestos durante esos segundos, y una pasada cada segundo, las
  // altas de la API se quedan esperando casi todo el tiempo.
  const claimTx = claimTransaction(model.stack?.database, { propagation: null });
  const body = `/**
 * Reenvía al broker las filas pendientes del outbox, ya fuera de la transacción
 * que las creó.
 *
 * Un fallo de entrega no revierte nada: incrementa el contador de intentos y la
 * fila se reintenta en la pasada siguiente (entrega at-least-once — el
 * consumidor deduplica por metadata.eventId). Una fila que agota maxAttempts
 * queda como dead-letter: se excluye de findPending y se reporta a ERROR, sin
 * borrarse, para inspección. Un cron diario purga lo ya publicado. Cadencias,
 * retención y tope de intentos salen de parameters/, nunca del código.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxEventJpaRepository outboxRepository;
    private final OutboxDispatcher dispatcher;

    @Value("\${outbox.relay.batch-size:100}")
    private int batchSize;

    @Value("\${outbox.relay.max-attempts:10}")
    private int maxAttempts;

    @Value("\${outbox.relay.backoff.initial-ms:1000}")
    private long backoffInitialMs;

    @Value("\${outbox.relay.backoff.max-ms:60000}")
    private long backoffMaxMs;

    @Value("\${outbox.purge.retention-days:7}")
    private int retentionDays;

    public OutboxRelay(OutboxEventJpaRepository outboxRepository, OutboxDispatcher dispatcher) {
        this.outboxRepository = outboxRepository;
        this.dispatcher = dispatcher;
    }

    @Scheduled(fixedDelayString = "\${outbox.relay.fixed-delay-ms:1000}")
${claimTx.annotation}
    public void relay() {
        List<OutboxEventJpa> pending = outboxRepository.findPending(maxAttempts, Instant.now(), PageRequest.of(0, batchSize));
        for (OutboxEventJpa row : pending) {
            try {
                dispatcher.dispatch(row.getDestination(), row.getRoutingKey(), row.getEventType(), row.getPayload());
                row.markPublished(Instant.now());
            } catch (RuntimeException ex) {
                row.markFailed(truncate(ex.getMessage()));
                if (row.getAttempts() >= maxAttempts) {
                    // Dead-letter: agotó los reintentos. Queda parada (fuera de futuros
                    // polls) para inspección manual; no se borra ni bloquea al resto.
                    log.error("Outbox: {} agotó {} reintentos y queda como dead-letter: {}",
                            row.getId(), maxAttempts, ex.getMessage());
                } else {
                    // Backoff: aplaza el próximo intento crecientemente para no
                    // reintentar en bucle apretado si el broker está caído.
                    row.scheduleNextAttempt(Instant.now().plusMillis(backoffDelayMs(row.getAttempts())));
                    log.warn("Outbox: fallo entregando {} (intento {}): {}", row.getId(), row.getAttempts(), ex.getMessage());
                }
            }
        }
    }

    // Backoff exponencial (multiplicador 2) con tope: initial * 2^(attempts-1),
    // saturado en max. En long y con guarda del desplazamiento para no desbordar.
    private long backoffDelayMs(int attempts) {
        int shift = Math.min(attempts - 1, 62);
        long delay = backoffInitialMs << shift;
        if (delay < 0 || delay > backoffMaxMs) {
            return backoffMaxMs;
        }
        return delay;
    }

    @Scheduled(cron = "\${outbox.purge.cron:0 0 3 * * *}")
    @Transactional
    public void purge() {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        int deleted = outboxRepository.deletePublishedBefore(cutoff);
        if (deleted > 0) {
            log.info("Outbox: purgadas {} filas publicadas antes de {}", deleted, cutoff);
        }
    }

    private static String truncate(String message) {
        if (message == null) {
            return null;
        }
        return message.length() <= 1024 ? message : message.substring(0, 1024);
    }
}`;

  return {
    path: javaPath(model, OUTBOX_PKG, OUTBOX_RELAY_CLASS),
    content: javaFile(
      subPackage(model, OUTBOX_PKG),
      [
        'java.time.Instant',
        'java.time.temporal.ChronoUnit',
        'java.util.List',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.data.domain.PageRequest',
        'org.springframework.scheduling.annotation.Scheduled',
        'org.springframework.stereotype.Component',
        ...claimTx.imports
      ],
      body
    )
  };
}
