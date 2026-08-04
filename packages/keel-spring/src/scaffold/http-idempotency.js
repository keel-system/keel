// Idempotencia de comando (HTTP): la que evita que reintentar una petición
// ejecute el caso de uso dos veces. No confundir con idempotency.js, que es la
// de CONSUMO (mensajes reentregados por el broker).
//
// Por qué una fila y no una clave en la caché distribuida: el contrato no es
// "rechazar el duplicado" sino "reproducir la respuesta original" — hace falta
// guardar el id del recurso creado y una firma de la petición, no un flag. Y
// sobre todo, el registro tiene que commitear en la MISMA transacción que el
// agregado y que la fila del outbox: con dos almacenes, marcar antes de ejecutar
// deja la clave envenenada durante todo el TTL si la transacción revierte, y
// marcar después abre la ventana para que dos reintentos ejecuten ambos. Es la
// misma razón por la que el método genera el outbox en vez de publicar directo.
// Además la caché es opcional en el stack (solo se resuelve si alguna query
// declara `cache`) y esto no puede serlo.
//
// Todo lo de aquí es transversal: la tabla, el puerto, el adaptador JPA y la
// entrega de la cabecera al handler. Lo que escribe el agente es el uso dentro
// del handler, guiado por conventions/mapping.md.

import { javaFile, javaPath, subPackage } from './render.js';

const PORT_PKG = 'domain.idempotency';
const SUPPORT_PKG = 'application.support';
const ADAPTER_PKG = 'infrastructure.persistence.idempotency';
const WEB_PKG = 'infrastructure.web';

/** ¿Alguna operación del diseño declara `idempotency`? (independiente del stack) */
export function declaresIdempotency(model) {
  return (model.services ?? []).some((group) => group.operations.some((operation) => operation.idempotency));
}

// Sin persistencia no hay dónde registrar la clave de forma transaccional, que
// es justamente lo que distingue a este mecanismo.
export function usesHttpIdempotency(model) {
  return Boolean(model.layersPresent.persistence && declaresIdempotency(model));
}

export function generate(model) {
  if (!usesHttpIdempotency(model)) return [];
  const files = [renderPort(model), renderContext(model), renderEntity(model), renderRepository(model), renderStore(model)];
  // El filtro es el puente cabecera HTTP → contexto: sin capa api no hay cabecera.
  if (model.layersPresent.api) files.push(renderFilter(model));
  return files;
}

function renderPort(model) {
  const body = `/**
 * Registro de peticiones ya atendidas, por clave de idempotencia.
 *
 * No confundir con IdempotencyGuard (infrastructure/messaging/idempotency): aquel
 * deduplica MENSAJES reentregados por el broker; este deduplica PETICIONES HTTP
 * repetidas por el cliente, identificadas por la cabecera Idempotency-Key.
 *
 * El contrato que impone el diseño no es rechazar la repetición, sino
 * reproducirla: la segunda llamada con la misma clave y el mismo contenido
 * devuelve la respuesta de la primera, sin volver a ejecutar nada. Por eso se
 * guarda el id del recurso resultante (para reconstruir la respuesta) y una
 * firma del contenido (para detectar la reutilización de la clave con otro
 * cuerpo, que el diseño resuelve con su propio error).
 */
public interface IdempotencyStore {

    /**
     * @param scope clave de agrupación: el nombre de la operación del diseño, para
     *              que la misma cabecera en dos operaciones distintas no colisione
     * @param idempotencyKey valor de la cabecera Idempotency-Key
     * @return el registro previo, si esa clave ya se usó y no ha expirado
     */
    Optional<StoredRequest> find(String scope, String idempotencyKey);

    /**
     * Registra la primera ejecución. Participa en la transacción del caso de uso:
     * si el comando revierte, el registro revierte con él y un reintento posterior
     * vuelve a ejecutarse con normalidad.
     *
     * @param signature  representación determinista del contenido de la petición
     * @param resourceId id del recurso resultante, con el que el handler reconstruye
     *                   la respuesta en una repetición (null si la operación no crea nada)
     * @param ttlSeconds ventana de deduplicación declarada por el diseño
     */
    void save(String scope, String idempotencyKey, String signature, String resourceId, long ttlSeconds);

    /** Lo guardado de la primera ejecución. */
    record StoredRequest(String signature, String resourceId) {
    }
}`;

  return {
    path: javaPath(model, PORT_PKG, 'IdempotencyStore'),
    content: javaFile(subPackage(model, PORT_PKG), ['java.util.Optional'], body)
  };
}

function renderContext(model) {
  const body = `/**
 * Clave de idempotencia de la petición en curso.
 *
 * La cabecera es transporte, así que no viaja dentro del Command: el Command es
 * el cuerpo HTTP y Jackson lo deserializa entero desde ahí — un componente más
 * sería settable desde el cuerpo. Se resuelve como el contexto de correlación:
 * un ThreadLocal que abre el filtro de entrada y lee el handler.
 *
 * Los hilos son de un pool y se reutilizan: quien abre el contexto SIEMPRE debe
 * cerrarlo, o la siguiente petición atendida por ese hilo heredaría una clave
 * ajena y se saltaría su propia ejecución.
 *
 * La cabecera es OPCIONAL: si el cliente no la manda, get() devuelve un Optional
 * vacío y la operación se ejecuta sin deduplicar (ver conventions/mapping.md).
 */
public final class IdempotencyContext {

    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private IdempotencyContext() {
        // Clase de utilidad.
    }

    /** Fija la clave del hilo actual; no hace nada si viene nula o en blanco. */
    public static void set(String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return;
        }
        CURRENT.set(idempotencyKey);
    }

    /** @return la clave de la petición en curso, vacío si el cliente no la envió. */
    public static Optional<String> get() {
        return Optional.ofNullable(CURRENT.get());
    }

    /** Cierra el contexto. Va siempre en un finally. */
    public static void clear() {
        CURRENT.remove();
    }
}`;

  return {
    path: javaPath(model, SUPPORT_PKG, 'IdempotencyContext'),
    content: javaFile(subPackage(model, SUPPORT_PKG), ['java.util.Optional'], body)
  };
}

function renderEntity(model) {
  const body = `/**
 * Petición ya atendida: un par (operación, clave de idempotencia).
 *
 * La clave es compuesta a propósito: la misma cabecera puede llegar a dos
 * operaciones distintas y cada una deduplica por su cuenta. La unicidad la
 * impone la clave primaria, no una consulta previa: es la BD la que arbitra la
 * carrera entre dos reintentos simultáneos, y quien la pierde revierte.
 *
 * La caducidad se guarda calculada (expires_at) en vez de deducirla del TTL al
 * consultar: el ttlSeconds del diseño puede cambiar entre despliegues y las
 * filas ya escritas conservan la ventana con la que se registraron.
 */
@Entity
@Table(name = "idempotency_record")
public class IdempotencyRecordJpa {

    @EmbeddedId
    private IdempotencyRecordId id;

    /** Representación determinista del contenido con el que se usó la clave. */
    @Column(name = "signature", nullable = false, length = 128)
    private String signature;

    /** Id del recurso resultante; null si la operación no crea ninguno. */
    @Column(name = "resource_id", length = 64)
    private String resourceId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    protected IdempotencyRecordJpa() {
        // Requerido por JPA.
    }

    public IdempotencyRecordJpa(IdempotencyRecordId id, String signature, String resourceId, Instant createdAt, Instant expiresAt) {
        this.id = id;
        this.signature = signature;
        this.resourceId = resourceId;
        this.createdAt = createdAt;
        this.expiresAt = expiresAt;
    }

    public IdempotencyRecordId getId() {
        return id;
    }

    public String getSignature() {
        return signature;
    }

    public String getResourceId() {
        return resourceId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    /** Clave compuesta (operación, clave de idempotencia). */
    @Embeddable
    public static class IdempotencyRecordId implements Serializable {

        /** Nombre de la operación del diseño. La columna no se llama "scope": lo es en SQL estándar. */
        @Column(name = "operation_scope", nullable = false, length = 128)
        private String scope;

        @Column(name = "idempotency_key", nullable = false, length = 255)
        private String idempotencyKey;

        protected IdempotencyRecordId() {
            // Requerido por JPA.
        }

        public IdempotencyRecordId(String scope, String idempotencyKey) {
            this.scope = scope;
            this.idempotencyKey = idempotencyKey;
        }

        public String getScope() {
            return scope;
        }

        public String getIdempotencyKey() {
            return idempotencyKey;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (other == null || getClass() != other.getClass()) {
                return false;
            }
            IdempotencyRecordId that = (IdempotencyRecordId) other;
            return Objects.equals(scope, that.scope) && Objects.equals(idempotencyKey, that.idempotencyKey);
        }

        @Override
        public int hashCode() {
            return Objects.hash(scope, idempotencyKey);
        }
    }
}`;

  return {
    path: javaPath(model, ADAPTER_PKG, 'IdempotencyRecordJpa'),
    content: javaFile(
      subPackage(model, ADAPTER_PKG),
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
  const body = `public interface IdempotencyRecordJpaRepository
        extends JpaRepository<IdempotencyRecordJpa, IdempotencyRecordJpa.IdempotencyRecordId> {

    @Modifying
    @Query("delete from IdempotencyRecordJpa r where r.expiresAt < :now")
    int deleteExpiredBefore(@Param("now") Instant now);
}`;

  return {
    path: javaPath(model, ADAPTER_PKG, 'IdempotencyRecordJpaRepository'),
    content: javaFile(
      subPackage(model, ADAPTER_PKG),
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

function renderStore(model) {
  const body = `/**
 * Adaptador JPA del registro de idempotencia.
 *
 * <p><b>Transaccionalidad</b>: {@code save} usa la propagación por defecto
 * (REQUIRED), es decir, se une a la transacción del caso de uso — al revés que
 * IdempotencyGuard, que registra en REQUIRES_NEW. La diferencia es deliberada:
 * allí el registro debe sobrevivir al fallo del handler (el mensaje ya se
 * consumió); aquí el registro y el recurso creado tienen que commitear juntos,
 * porque una clave marcada sin recurso detrás haría que el reintento de una
 * operación fallida devolviese una respuesta que nunca existió.
 *
 * <p><b>Carreras</b>: dos peticiones simultáneas con la misma clave insertan la
 * misma PK y la BD arbitra; la que pierde revierte con violación de integridad,
 * que ApiExceptionHandler traduce a conflicto. Es el mismo desenlace que
 * cualquier otra carrera de escritura del diseño, y es el correcto: de las dos
 * peticiones idénticas, exactamente una se ejecutó.
 *
 * <p>La cadencia de la purga sale de parameters/, nunca del código.
 */
@Component
public class JpaIdempotencyStore implements IdempotencyStore {

    private static final Logger log = LoggerFactory.getLogger(JpaIdempotencyStore.class);

    private final IdempotencyRecordJpaRepository repository;

    public JpaIdempotencyStore(IdempotencyRecordJpaRepository repository) {
        this.repository = repository;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<StoredRequest> find(String scope, String idempotencyKey) {
        Instant now = Instant.now();
        return repository
                .findById(new IdempotencyRecordJpa.IdempotencyRecordId(scope, idempotencyKey))
                // Una fila caducada es como si no estuviera: la ventana de
                // deduplicación la fija el diseño, no la purga (que va por lotes).
                .filter(stored -> stored.getExpiresAt().isAfter(now))
                .map(stored -> new StoredRequest(stored.getSignature(), stored.getResourceId()));
    }

    @Override
    @Transactional
    public void save(String scope, String idempotencyKey, String signature, String resourceId, long ttlSeconds) {
        Instant now = Instant.now();
        repository.save(new IdempotencyRecordJpa(
                new IdempotencyRecordJpa.IdempotencyRecordId(scope, idempotencyKey),
                signature,
                resourceId,
                now,
                now.plusSeconds(ttlSeconds)));
    }

    @Scheduled(cron = "\${idempotency-record.purge.cron:0 30 4 * * *}")
    @Transactional
    public void purge() {
        int deleted = repository.deleteExpiredBefore(Instant.now());
        if (deleted > 0) {
            log.info("Idempotencia HTTP: purgadas {} claves caducadas", deleted);
        }
    }
}`;

  return {
    path: javaPath(model, ADAPTER_PKG, 'JpaIdempotencyStore'),
    content: javaFile(
      subPackage(model, ADAPTER_PKG),
      [
        `${subPackage(model, PORT_PKG)}.IdempotencyStore`,
        'java.time.Instant',
        'java.util.Optional',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.scheduling.annotation.Scheduled',
        'org.springframework.stereotype.Component',
        'org.springframework.transaction.annotation.Transactional'
      ],
      body
    )
  };
}

function renderFilter(model) {
  const body = `/**
 * Lleva la cabecera Idempotency-Key al contexto de la petición.
 *
 * Se ordena justo detrás del filtro de correlación y por delante de la
 * seguridad: el contexto tiene que estar abierto antes de que el controller
 * construya el Command, y cerrado pase lo que pase (los hilos se reutilizan).
 *
 * No valida ni exige la cabecera: {@code keySource: client-key} dice de dónde
 * sale la clave, no que sea obligatoria. Sin cabecera, la operación se ejecuta
 * sin deduplicar (conventions/mapping.md).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 11)
public class IdempotencyKeyFilter extends OncePerRequestFilter {

    public static final String HEADER = "Idempotency-Key";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        try {
            IdempotencyContext.set(request.getHeader(HEADER));
            chain.doFilter(request, response);
        } finally {
            IdempotencyContext.clear();
        }
    }
}`;

  return {
    path: javaPath(model, WEB_PKG, 'IdempotencyKeyFilter'),
    content: javaFile(
      subPackage(model, WEB_PKG),
      [
        `${subPackage(model, SUPPORT_PKG)}.IdempotencyContext`,
        'jakarta.servlet.FilterChain',
        'jakarta.servlet.ServletException',
        'jakarta.servlet.http.HttpServletRequest',
        'jakarta.servlet.http.HttpServletResponse',
        'java.io.IOException',
        'org.springframework.core.Ordered',
        'org.springframework.core.annotation.Order',
        'org.springframework.stereotype.Component',
        'org.springframework.web.filter.OncePerRequestFilter'
      ],
      body
    )
  };
}
