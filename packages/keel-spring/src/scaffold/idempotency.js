// Idempotencia de consumo: la cara simétrica del outbox. El outbox garantiza
// que un evento no se pierde (a costa de poder entregarlo dos veces); esto
// garantiza que entregarlo dos veces no lo procese dos veces.
//
// Todo lo de aquí es transversal al broker — la tabla de procesados, la
// inserción atómica y la purga —, igual que en outbox.js. Lo único acoplado al
// broker es QUIÉN llama al guard: el listener, que escribe el agente siguiendo
// la skill keel-spring-<broker>.

import { javaFile, javaPath, subPackage } from './render.js';

const IDEMPOTENCY_PKG = 'infrastructure.messaging.idempotency';

// Sin suscripciones no hay consumo que deduplicar; sin persistencia no hay
// dónde registrar lo ya procesado de forma atómica.
export function usesIdempotency(model) {
  return Boolean(
    model.layersPresent.messaging && model.layersPresent.persistence && (model.subscriptions?.length ?? 0) > 0
  );
}

/** Nombres del espejo persistido del registro de procesados, por modelo. */
export function processedEventNames(model) {
  return model.persistenceKind === 'document'
    ? { entity: 'ProcessedEventDocument', repository: 'ProcessedEventMongoRepository' }
    : { entity: 'ProcessedEventJpa', repository: 'ProcessedEventJpaRepository' };
}

export function generate(model) {
  if (!usesIdempotency(model)) return [];
  const document = model.persistenceKind === 'document';
  return [
    document ? renderDocument(model) : renderEntity(model),
    document ? renderDocumentRepository(model) : renderRepository(model),
    renderGuard(model)
  ];
}

// ─── Espejo documental del registro de procesados ────────────────────────────
//
// La clave compuesta (handler, evento) sobrevive intacta: Mongo admite un _id que
// sea un subdocumento, y la unicidad del _id es la misma garantía que daba la clave
// primaria. Lo que cambia es CÓMO se escribe — ver la nota de insert() en el guard.

function renderDocument(model) {
  const body = `/**
 * Registro de lo ya procesado: un par (handler, evento) por cada mensaje que un
 * consumidor completó.
 *
 * La clave es compuesta a propósito: el mismo evento puede interesar a varios
 * listeners, y cada uno debe procesarlo exactamente una vez. La unicidad la impone
 * el _id del documento, no una consulta previa: es la base de datos la que arbitra
 * la carrera entre dos entregas simultáneas del mismo mensaje.
 */
@Document(collection = "processed_event")
public class ProcessedEventDocument {

    @Id
    private ProcessedEventId id;

    @Field(name = "processed_at")
    private Instant processedAt;

    protected ProcessedEventDocument() {
        // Requerido por el mapeo de Spring Data.
    }

    public ProcessedEventDocument(ProcessedEventId id, Instant processedAt) {
        this.id = id;
        this.processedAt = processedAt;
    }

    public ProcessedEventId getId() {
        return id;
    }

    public Instant getProcessedAt() {
        return processedAt;
    }

    /** Clave compuesta (handler, evento): va como subdocumento en el _id. */
    public static class ProcessedEventId implements Serializable {

        /** Identifica al consumidor; convención: nombre simple de la clase del listener. */
        @Field(name = "handler_id")
        private String handlerId;

        /** Identificador del mensaje: el messageId declarado en el diseño o metadata.eventId. */
        @Field(name = "event_id")
        private String eventId;

        protected ProcessedEventId() {
            // Requerido por el mapeo de Spring Data.
        }

        public ProcessedEventId(String handlerId, String eventId) {
            this.handlerId = handlerId;
            this.eventId = eventId;
        }

        public String getHandlerId() {
            return handlerId;
        }

        public String getEventId() {
            return eventId;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (other == null || getClass() != other.getClass()) {
                return false;
            }
            ProcessedEventId that = (ProcessedEventId) other;
            return Objects.equals(handlerId, that.handlerId) && Objects.equals(eventId, that.eventId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(handlerId, eventId);
        }
    }
}`;

  return {
    path: javaPath(model, IDEMPOTENCY_PKG, 'ProcessedEventDocument'),
    content: javaFile(
      subPackage(model, IDEMPOTENCY_PKG),
      [
        'java.io.Serializable',
        'java.time.Instant',
        'java.util.Objects',
        'org.springframework.data.annotation.Id',
        'org.springframework.data.mongodb.core.mapping.Document',
        'org.springframework.data.mongodb.core.mapping.Field'
      ],
      body
    )
  };
}

function renderDocumentRepository(model) {
  const body = `public interface ProcessedEventMongoRepository
        extends MongoRepository<ProcessedEventDocument, ProcessedEventDocument.ProcessedEventId> {

    long deleteByProcessedAtBefore(Instant cutoff);
}`;

  return {
    path: javaPath(model, IDEMPOTENCY_PKG, 'ProcessedEventMongoRepository'),
    content: javaFile(
      subPackage(model, IDEMPOTENCY_PKG),
      ['java.time.Instant', 'org.springframework.data.mongodb.repository.MongoRepository'],
      body
    )
  };
}

function renderEntity(model) {
  const body = `/**
 * Registro de lo ya procesado: un par (handler, evento) por cada mensaje que un
 * consumidor completó.
 *
 * La clave es compuesta a propósito: el mismo evento puede interesar a varios
 * listeners, y cada uno debe procesarlo exactamente una vez. La unicidad la
 * impone la clave primaria, no una consulta previa: es la BD la que arbitra la
 * carrera entre dos entregas simultáneas del mismo mensaje.
 */
@Entity
@Table(name = "processed_event")
public class ProcessedEventJpa {

    @EmbeddedId
    private ProcessedEventId id;

    @Column(name = "processed_at", nullable = false)
    private Instant processedAt;

    protected ProcessedEventJpa() {
        // Requerido por JPA.
    }

    public ProcessedEventJpa(ProcessedEventId id, Instant processedAt) {
        this.id = id;
        this.processedAt = processedAt;
    }

    public ProcessedEventId getId() {
        return id;
    }

    public Instant getProcessedAt() {
        return processedAt;
    }

    /** Clave compuesta (handler, evento). */
    @Embeddable
    public static class ProcessedEventId implements Serializable {

        /** Identifica al consumidor; convención: nombre simple de la clase del listener. */
        @Column(name = "handler_id", nullable = false, length = 512)
        private String handlerId;

        /** Identificador del mensaje: el messageId declarado en el diseño o metadata.eventId. */
        @Column(name = "event_id", nullable = false, length = 64)
        private String eventId;

        protected ProcessedEventId() {
            // Requerido por JPA.
        }

        public ProcessedEventId(String handlerId, String eventId) {
            this.handlerId = handlerId;
            this.eventId = eventId;
        }

        public String getHandlerId() {
            return handlerId;
        }

        public String getEventId() {
            return eventId;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (other == null || getClass() != other.getClass()) {
                return false;
            }
            ProcessedEventId that = (ProcessedEventId) other;
            return Objects.equals(handlerId, that.handlerId) && Objects.equals(eventId, that.eventId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(handlerId, eventId);
        }
    }
}`;

  return {
    path: javaPath(model, IDEMPOTENCY_PKG, 'ProcessedEventJpa'),
    content: javaFile(
      subPackage(model, IDEMPOTENCY_PKG),
      [
        'jakarta.persistence.Column',
        'jakarta.persistence.Embeddable',
        'jakarta.persistence.EmbeddedId',
        'jakarta.persistence.Entity',
        'jakarta.persistence.Table',
        'java.io.Serializable',
        'java.time.Instant',
        'java.util.Objects'
      ],
      body
    )
  };
}

function renderRepository(model) {
  const body = `public interface ProcessedEventJpaRepository
        extends JpaRepository<ProcessedEventJpa, ProcessedEventJpa.ProcessedEventId> {

    @Modifying
    @Query("delete from ProcessedEventJpa p where p.processedAt < :cutoff")
    int deleteProcessedBefore(@Param("cutoff") Instant cutoff);
}`;

  return {
    path: javaPath(model, IDEMPOTENCY_PKG, 'ProcessedEventJpaRepository'),
    content: javaFile(
      subPackage(model, IDEMPOTENCY_PKG),
      [
        'java.time.Instant',
        'org.springframework.data.jpa.repository.JpaRepository',
        'org.springframework.data.jpa.repository.Modifying',
        'org.springframework.data.jpa.repository.Query',
        'org.springframework.data.repository.query.Param'
      ],
      body
    )
  };
}

function renderGuard(model) {
  const { entity, repository } = processedEventNames(model);
  const field = 'processedEventRepository';
  // En el modelo documental, save() con un _id ya presente es un REEMPLAZO, no un
  // error: la carrera se resolvería sobrescribiendo y el duplicado se procesaría
  // otra vez. insert() fuerza la inserción y deja que el _id arbitre, que es
  // exactamente lo que hacía la clave primaria en la rama relacional.
  const write =
    model.persistenceKind === 'document'
      ? `            ${field}.insert(new ${entity}(key, Instant.now()));`
      : `            ${field}.save(new ${entity}(key, Instant.now()));`;
  // El sustantivo del log sigue al motor: en el relacional son filas de una tabla y
  // en el documental, documentos de una colección. Es lo que verá quien lea el log.
  // Quién arbitra la carrera: la clave primaria de la tabla o el _id del documento.
  // La excepción es la misma en los dos casos — en Mongo llega como
  // DuplicateKeyException, que es una DataIntegrityViolationException.
  const arbiter =
    model.persistenceKind === 'document'
      ? 'el _id del documento es el árbitro y esta pierde.'
      : 'la clave primaria es el árbitro y esta pierde.';
  const purgedNoun =
    model.persistenceKind === 'document' ? 'purgados {} documentos procesados' : 'purgadas {} filas procesadas';
  const purgeCall =
    model.persistenceKind === 'document'
      ? `long deleted = ${field}.deleteByProcessedAtBefore(cutoff);`
      : `int deleted = ${field}.deleteProcessedBefore(cutoff);`;
  const body = `/**
 * Guarda de idempotencia del consumidor.
 *
 * Los listeners llaman a {@link #tryRecord(String, String)} ANTES de despachar
 * el mensaje: si devuelve false, el mensaje ya se procesó y hay que confirmarlo
 * (ack) sin volver a ejecutarlo. La entrega de cualquier broker es at-least-once
 * y el relay del outbox reintenta, así que la reentrega no es un caso raro: es
 * el comportamiento normal ante cualquier corte.
 *
 * El registro va en su PROPIA transacción (REQUIRES_NEW) para que quede escrito
 * aunque la del handler revierta... y precisamente por eso el orden importa: si
 * la operación de negocio puede fallar y debe reintentarse, registra DESPUÉS de
 * procesar. Registrar antes convierte un fallo transitorio en un mensaje
 * perdido.
 *
 * Cadencia y retención de la purga salen de parameters/, nunca del código.
 */
@Component
public class IdempotencyGuard {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyGuard.class);

    private final ${repository} ${field};

    @Value("\${processed-event.purge.retention-days:14}")
    private int retentionDays;

    public IdempotencyGuard(${repository} ${field}) {
        this.${field} = ${field};
    }

    /**
     * @param handlerId identificador del consumidor (nombre simple del listener)
     * @param eventId   identificador del mensaje (messageId del diseño o metadata.eventId)
     * @return true si es la primera vez y hay que procesar; false si es un duplicado
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean tryRecord(String handlerId, String eventId) {
        ${entity}.ProcessedEventId key = new ${entity}.ProcessedEventId(handlerId, eventId);
        if (${field}.existsById(key)) {
            return false;
        }
        try {
${write}
            return true;
        } catch (DataIntegrityViolationException duplicate) {
            // Otra entrega del mismo mensaje ganó la carrera entre el existsById
            // y el insert: ${arbiter}
            log.debug("Idempotencia: {} ya procesado por {} (carrera resuelta en la PK)", eventId, handlerId);
            return false;
        }
    }

    @Scheduled(cron = "\${processed-event.purge.cron:0 0 4 * * *}")
    @Transactional
    public void purge() {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        ${purgeCall}
        if (deleted > 0) {
            log.info("Idempotencia: ${purgedNoun} antes de {}", deleted, cutoff);
        }
    }
}`;

  return {
    path: javaPath(model, IDEMPOTENCY_PKG, 'IdempotencyGuard'),
    content: javaFile(
      subPackage(model, IDEMPOTENCY_PKG),
      [
        'java.time.Instant',
        'java.time.temporal.ChronoUnit',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.beans.factory.annotation.Value',
        'org.springframework.dao.DataIntegrityViolationException',
        'org.springframework.scheduling.annotation.Scheduled',
        'org.springframework.stereotype.Component',
        'org.springframework.transaction.annotation.Propagation',
        'org.springframework.transaction.annotation.Transactional'
      ],
      body
    )
  };
}
