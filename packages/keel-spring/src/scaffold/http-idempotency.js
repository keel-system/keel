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

/** Operaciones con `idempotency`, filtrables por `keySource`. */
export function idempotentOperations(model, keySource = null) {
  return (model.services ?? []).flatMap((group) =>
    group.operations.filter(
      (operation) => operation.idempotency && (!keySource || operation.idempotency.keySource === keySource)
    )
  );
}

// Sin persistencia no hay dónde registrar la clave de forma transaccional, que
// es justamente lo que distingue a este mecanismo.
export function usesHttpIdempotency(model) {
  return Boolean(model.layersPresent.persistence && declaresIdempotency(model));
}

/** Llamadas salientes que mandan clave de idempotencia al proveedor. */
export function outboundIdempotentCalls(model) {
  return (model.httpClients ?? []).flatMap((client) =>
    client.calls.filter((call) => call.idempotency).map((call) => ({ client, call }))
  );
}

// La firma también la usa la cara SALIENTE (la clave que mandamos al proveedor),
// que puede existir sin que ninguna operación propia declare `idempotency`.
export function usesCommandSignature(model) {
  return usesHttpIdempotency(model) || outboundIdempotentCalls(model).length > 0;
}

export function generate(model) {
  if (!usesCommandSignature(model)) return [];
  // La firma del contenido es del mecanismo, no del handler: con `client-key`
  // es lo que distingue una repetición legítima de una clave reutilizada con
  // otro cuerpo, y con `payload-hash` ES la clave. Describirla en prosa dejaba
  // que dos handlers del mismo servicio la calculasen distinto.
  const files = [renderSignature(model)];
  if (!usesHttpIdempotency(model)) return files;

  const document = model.persistenceKind === 'document';
  files.push(
    renderPort(model),
    document ? renderDocument(model) : renderEntity(model),
    document ? renderDocumentRepository(model) : renderRepository(model),
    document ? renderMongoStore(model) : renderStore(model)
  );
  // El contexto y el filtro son el camino de la CABECERA: solo existen si alguna
  // operación declara `client-key`. Con `payload-hash` la clave no viaja por
  // transporte —sale del propio contenido—, así que no hay nada que transportar.
  if (idempotentOperations(model, 'client-key').length > 0) {
    files.push(renderContext(model));
    // El filtro es el puente cabecera HTTP → contexto: sin capa api no hay cabecera.
    if (model.layersPresent.api) files.push(renderFilter(model));
  }
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
     * @param idempotencyKey la clave: el valor de la cabecera Idempotency-Key con
     *                       {@code keySource: client-key}, o CommandSignature.of(command)
     *                       con {@code payload-hash} — ahí no hay cabecera
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

function renderSignature(model) {
  const body = `/**
 * Firma determinista del contenido de un Command.
 *
 * Dos usos, según el {@code keySource} que declare la operación:
 * <ul>
 *   <li>{@code client-key}: es la FIRMA que se guarda junto a la clave del cliente.
 *       Sirve para detectar que alguien reutilizó su Idempotency-Key con otro cuerpo.</li>
 *   <li>{@code payload-hash}: es la CLAVE misma. No hay cabecera que leer — el diseño
 *       dice que el mismo contenido significa la misma intención.</li>
 * </ul>
 *
 * <p>Por qué está generada y no la escribe cada handler: la firma se compara contra
 * una guardada en otro despliegue. Si dos handlers la calculan distinto —o el mismo
 * la calcula distinto tras un refactor— la comparación deja de significar nada y no
 * hay nada que lo delate: el sistema simplemente deja de deduplicar.
 *
 * <p>Canónica quiere decir: componentes de record ordenados por nombre, cada escalar
 * precedido de su longitud (así ningún contenido puede imitar un separador) y el
 * orden de una lista conservado, porque es parte del contenido. Un null se codifica
 * como marca propia en vez de omitirse: "ausencia vs. nulo" es una convención de
 * determinación del diseño, y colapsarlos daría la misma firma a dos peticiones que
 * el contrato distingue. Un binario entra por su digest, nunca por su identidad de
 * objeto.
 *
 * <p>No usa Jackson a propósito: el ObjectMapper de la aplicación lo configuran la
 * serialización de la API y el broker, y un cambio ahí —una precisión temporal, un
 * @JsonInclude— movería en silencio firmas ya almacenadas.
 */
public final class CommandSignature {

    private CommandSignature() {
        // Clase de utilidad.
    }

    /** @return SHA-256 en hexadecimal de la forma canónica del command */
    public static String of(Object command) {
        return HexFormat.of().formatHex(sha256(canonical(command).getBytes(StandardCharsets.UTF_8)));
    }

    /** Forma canónica: visible para poder verificarla en una prueba. */
    static String canonical(Object value) {
        if (value == null) {
            return "~";
        }
        if (value instanceof Optional<?> optional) {
            return optional.map(CommandSignature::canonical).orElse("~");
        }
        // La escala forma parte del valor en BigDecimal: 1.50 y 1.5 son el mismo
        // importe y deben dar la misma firma.
        if (value instanceof BigDecimal number) {
            return scalar(number.stripTrailingZeros().toPlainString());
        }
        // Un binario (el contenido de un FileUpload) puede pesar megas: lo que entra
        // en la firma es su digest. Lo que NUNCA puede entrar es lo que devolvería
        // String.valueOf de un array — la identidad del objeto, distinta en cada
        // ejecución: la operación dejaría de deduplicar y nada lo delataría.
        if (value instanceof byte[] bytes) {
            return scalar(HexFormat.of().formatHex(sha256(bytes)));
        }
        if (value.getClass().isArray()) {
            return IntStream.range(0, Array.getLength(value))
                    .mapToObj(index -> canonical(Array.get(value, index)))
                    .collect(Collectors.joining(",", "[", "]"));
        }
        if (value instanceof Map<?, ?> map) {
            return map.entrySet().stream()
                    .map(entry -> scalar(String.valueOf(entry.getKey())) + canonical(entry.getValue()))
                    .sorted()
                    .collect(Collectors.joining(",", "{", "}"));
        }
        if (value instanceof Collection<?> items) {
            // El orden SÍ cuenta: dos listas con los mismos elementos en distinto
            // orden son dos peticiones distintas para cualquier lector del diseño.
            return items.stream().map(CommandSignature::canonical).collect(Collectors.joining(",", "[", "]"));
        }
        if (value.getClass().isRecord()) {
            return Arrays.stream(value.getClass().getRecordComponents())
                    .sorted(Comparator.comparing(RecordComponent::getName))
                    .map(component -> scalar(component.getName()) + canonical(read(component, value)))
                    .collect(Collectors.joining(",", "{", "}"));
        }
        return scalar(String.valueOf(value));
    }

    private static Object read(RecordComponent component, Object owner) {
        try {
            return component.getAccessor().invoke(owner);
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("No se pudo leer el componente " + component.getName(), failure);
        }
    }

    /** Prefijo de longitud: hace imposible que un contenido imite un separador. */
    private static String scalar(String raw) {
        return raw.length() + ":" + raw;
    }

    private static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("SHA-256 no disponible en esta JVM", unavailable);
        }
    }
}`;

  return {
    path: javaPath(model, SUPPORT_PKG, 'CommandSignature'),
    content: javaFile(
      subPackage(model, SUPPORT_PKG),
      [
        'java.lang.reflect.Array',
        'java.lang.reflect.RecordComponent',
        'java.math.BigDecimal',
        'java.nio.charset.StandardCharsets',
        'java.security.MessageDigest',
        'java.security.NoSuchAlgorithmException',
        'java.util.Arrays',
        'java.util.Collection',
        'java.util.Comparator',
        'java.util.HexFormat',
        'java.util.Map',
        'java.util.Optional',
        'java.util.stream.Collectors',
        'java.util.stream.IntStream'
      ],
      body
    )
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

    /**
     * Id del recurso resultante; null si la operación no crea ninguno.
     *
     * <p>255 y no 64: un id de dominio no siempre es un uuid, y quedarse corto no
     * falla al validar sino al guardar — con la operación ya ejecutada.
     */
    @Column(name = "resource_id", length = 255)
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

// ─── Espejo documental del registro de idempotencia HTTP ─────────────────────

function renderDocument(model) {
  const body = `/**
 * Registro de una petición ya atendida, por clave de idempotencia.
 *
 * La clave es compuesta (operación, clave del cliente) y va como _id: la unicidad
 * del _id es la que arbitra la carrera entre dos reintentos simultáneos, y quien la
 * pierde revierte.
 *
 * La caducidad se guarda calculada (expires_at) en vez de deducirla del TTL al
 * consultar: el ttlSeconds del diseño puede cambiar entre despliegues y los
 * registros ya escritos conservan la ventana con la que se registraron.
 */
@Document(collection = "idempotency_record")
public class IdempotencyRecordDocument {

    @Id
    private IdempotencyRecordId id;

    /** Representación determinista del contenido con el que se usó la clave. */
    @Field(name = "signature")
    private String signature;

    /** Id del recurso resultante; null si la operación no crea ninguno. */
    @Field(name = "resource_id")
    private String resourceId;

    @Field(name = "created_at")
    private Instant createdAt;

    @Field(name = "expires_at")
    private Instant expiresAt;

    protected IdempotencyRecordDocument() {
        // Requerido por el mapeo de Spring Data.
    }

    public IdempotencyRecordDocument(IdempotencyRecordId id, String signature, String resourceId, Instant createdAt, Instant expiresAt) {
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

    /** Clave compuesta (operación, clave de idempotencia): subdocumento del _id. */
    public static class IdempotencyRecordId implements Serializable {

        /** Nombre de la operación del diseño. */
        @Field(name = "operation_scope")
        private String scope;

        @Field(name = "idempotency_key")
        private String idempotencyKey;

        protected IdempotencyRecordId() {
            // Requerido por el mapeo de Spring Data.
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
    path: javaPath(model, ADAPTER_PKG, 'IdempotencyRecordDocument'),
    content: javaFile(
      subPackage(model, ADAPTER_PKG),
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
  const body = `public interface IdempotencyRecordMongoRepository
        extends MongoRepository<IdempotencyRecordDocument, IdempotencyRecordDocument.IdempotencyRecordId> {

    long deleteByExpiresAtBefore(Instant now);
}`;

  return {
    path: javaPath(model, ADAPTER_PKG, 'IdempotencyRecordMongoRepository'),
    content: javaFile(
      subPackage(model, ADAPTER_PKG),
      ['java.time.Instant', 'org.springframework.data.mongodb.repository.MongoRepository'],
      body
    )
  };
}

function renderMongoStore(model) {
  const body = `/**
 * Adaptador MongoDB del registro de idempotencia.
 *
 * <p><b>Transaccionalidad</b>: {@code save} usa la propagación por defecto
 * (REQUIRED), es decir, se une a la transacción del caso de uso — al revés que
 * IdempotencyGuard, que registra en REQUIRES_NEW. La diferencia es deliberada:
 * allí el registro debe sobrevivir al fallo del handler (el mensaje ya se
 * consumió); aquí el registro y el recurso creado tienen que commitear juntos,
 * porque una clave marcada sin recurso detrás haría que el reintento de una
 * operación fallida devolviese una respuesta que nunca existió. Esa atomicidad
 * entre dos colecciones es lo que exige el replica set.
 *
 * <p><b>Carreras</b>: se usa {@code insert} y no {@code save} a propósito. En Mongo
 * un save con el _id ya presente REEMPLAZA en silencio, y la segunda petición
 * pisaría el registro de la primera en vez de perder la carrera. Con insert, el _id
 * arbitra igual que la clave primaria en la rama relacional: quien pierde recibe
 * DuplicateKeyException —una DataIntegrityViolationException— que ApiExceptionHandler
 * traduce a conflicto. De dos peticiones idénticas, exactamente una se ejecutó.
 *
 * <p>La cadencia de la purga sale de parameters/, nunca del código.
 */
@Component
public class MongoIdempotencyStore implements IdempotencyStore {

    private static final Logger log = LoggerFactory.getLogger(MongoIdempotencyStore.class);

    private final IdempotencyRecordMongoRepository repository;

    public MongoIdempotencyStore(IdempotencyRecordMongoRepository repository) {
        this.repository = repository;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<StoredRequest> find(String scope, String idempotencyKey) {
        Instant now = Instant.now();
        return repository
                .findById(new IdempotencyRecordDocument.IdempotencyRecordId(scope, idempotencyKey))
                // Un registro caducado es como si no estuviera: la ventana de
                // deduplicación la fija el diseño, no la purga (que va por lotes).
                .filter(stored -> stored.getExpiresAt().isAfter(now))
                .map(stored -> new StoredRequest(stored.getSignature(), stored.getResourceId()));
    }

    @Override
    @Transactional
    public void save(String scope, String idempotencyKey, String signature, String resourceId, long ttlSeconds) {
        Instant now = Instant.now();
        repository.insert(new IdempotencyRecordDocument(
                new IdempotencyRecordDocument.IdempotencyRecordId(scope, idempotencyKey),
                signature,
                resourceId,
                now,
                now.plusSeconds(ttlSeconds)));
    }

    @Scheduled(cron = "\${idempotency-record.purge.cron:0 30 4 * * *}")
    public void purge() {
        long deleted = repository.deleteByExpiresAtBefore(Instant.now());
        if (deleted > 0) {
            log.info("Idempotencia HTTP: purgadas {} claves caducadas", deleted);
        }
    }
}`;

  return {
    path: javaPath(model, ADAPTER_PKG, 'MongoIdempotencyStore'),
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
