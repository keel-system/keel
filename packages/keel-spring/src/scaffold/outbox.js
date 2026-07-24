// Patrón outbox (messaging.publishing.reliability: outbox): garantiza que
// ningún evento se pierde si la transacción confirma, y que ninguno sale si
// revierte. El bridge escribe la fila DENTRO de la transacción del cambio
// (messaging.js) y este relay la entrega después, fuera de ella.
//
// Todo lo de aquí es transversal al broker: la tabla, el repositorio, el
// polling, los reintentos y la purga. Lo único acoplado al broker es el ENVÍO,
// que sale por el puerto OutboxDispatcher; su implementación la escribe el
// agente siguiendo la skill .claude/skills/keel-spring-<broker>/.

import { javaFile, javaPath, subPackage } from './render.js';

const OUTBOX_PKG = 'infrastructure.messaging.outbox';

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

export function generate(model) {
  if (!usesOutbox(model)) return [];
  return [renderEntity(model), renderRepository(model), renderDispatcherPort(model), renderDispatcherStub(model), renderRelay(model)];
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
  const body = `public interface OutboxEventJpaRepository extends JpaRepository<OutboxEventJpa, UUID> {

    /**
     * Pendientes en orden de llegada que aún no agotaron los reintentos y cuyo
     * backoff ya venció (nextAttemptAt null = elegible ya). Toma un lock de
     * escritura con SKIP LOCKED (el hint de lock timeout -2): con varias réplicas
     * del relay, cada una se lleva un lote disjunto en vez de competir por las
     * mismas filas. El lock se sostiene hasta el fin de la transacción del relay.
     * En H2 (perfil test) SKIP LOCKED puede degradarse a lock normal; no afecta a
     * la validación, que corre contra la BD real de infra/.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
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
        'jakarta.persistence.LockModeType',
        'jakarta.persistence.QueryHint',
        'java.time.Instant',
        'java.util.List',
        'java.util.UUID',
        'org.springframework.data.domain.Pageable',
        'org.springframework.data.jpa.repository.JpaRepository',
        'org.springframework.data.jpa.repository.Lock',
        'org.springframework.data.jpa.repository.Modifying',
        'org.springframework.data.jpa.repository.Query',
        'org.springframework.data.jpa.repository.QueryHints',
        'org.springframework.data.repository.query.Param'
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
 * (skill .claude/skills/keel-spring-<broker>/).
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
// Deliberadamente NO lanza: el relay lo interpretaría como fallo de entrega y
// las filas se acumularían con attempts creciendo.
function renderDispatcherStub(model) {
  const body = `@Component
public class OutboxDispatcherStub implements OutboxDispatcher {

    private static final Logger log = LoggerFactory.getLogger(OutboxDispatcherStub.class);

    @Override
    public void dispatch(String destination, String routingKey, String eventType, String payload) {
        // TODO (agente): sustituir este stub por el dispatcher real del broker
        //   elegido en keel-stack.json (skill .claude/skills/keel-spring-<broker>/):
        //   enviar el payload tal cual (ya es la EventEnvelope serializada) al
        //   destino/routing key indicados, con content-type application/json.
        log.warn("OutboxDispatcher no implementado: {} no salió a {}/{}", eventType, destination, routingKey);
    }
}`;

  return {
    path: javaPath(model, 'infrastructure.messaging', 'OutboxDispatcherStub'),
    content: javaFile(
      subPackage(model, 'infrastructure.messaging'),
      [
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.stereotype.Component',
        `${subPackage(model, OUTBOX_PKG)}.OutboxDispatcher`
      ],
      body
    )
  };
}

function renderRelay(model) {
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
    @Transactional
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
    path: javaPath(model, OUTBOX_PKG, 'OutboxRelay'),
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
        'org.springframework.transaction.annotation.Transactional'
      ],
      body
    )
  };
}
