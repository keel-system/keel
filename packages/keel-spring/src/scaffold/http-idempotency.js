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

import { FRAMEWORK_ERRORS } from 'keel-core';
import { declaredErrorFor } from '../lib/declared-errors.js';
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
    renderConflict(model),
    renderReuse(model),
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

// El desenlace de la carrera necesita un `code` propio, y no es un capricho de
// forma: sin él, la petición que pierde llega al ApiExceptionHandler como una
// violación de integridad cualquiera y el cliente recibe un 409 anónimo,
// indistinguible del conflicto de negocio que la misma operación puede devolver.
// Un escenario no puede afirmar sobre eso —validation-scenarios.md exige code y
// status—, así que la carrera quedaba sin poder probarse.
function renderConflict(model) {
  const body = `/**
 * Dos peticiones con la misma clave de idempotencia, a la vez.
 *
 * <p>No es el reintento normal: ese encuentra el registro ya commiteado y reproduce
 * la respuesta sin ejecutar nada. Esto es la ventana estrecha en la que la primera
 * petición aún no ha commiteado —y con varias réplicas, normalmente ni siquiera está
 * en este proceso—, así que no hay respuesta que reproducir todavía. La única
 * contestación honesta es «vuelve a intentarlo»: el registro guarda el id del recurso,
 * no el cuerpo, y hasta que la ganadora no commitee ese id no existe.
 *
 * <p>Lo que sí queda garantizado es lo importante: la transacción de quien pierde
 * revierte entera, así que de dos peticiones idénticas se ejecutó exactamente una.
 */
public class IdempotencyConflictException extends ConflictException {

    public IdempotencyConflictException(String scope, String idempotencyKey, Throwable cause) {
        // El constructor con metadata no acepta causa (DomainException guarda code y
        // status en campos finales), así que la causa se encadena aparte: perderla
        // dejaría el log sin el motivo real —qué constraint violó— justo en el fallo
        // que solo se reproduce bajo carga.
        super(
                "Otra petición con la misma clave de idempotencia está en curso: " + scope + "/" + idempotencyKey,
                "IDEMPOTENCY_KEY_IN_PROGRESS",
                409,
                new Object[] {scope, idempotencyKey});
        initCause(cause);
    }
}`;

  return {
    path: javaPath(model, PORT_PKG, 'IdempotencyConflictException'),
    content: javaFile(
      subPackage(model, PORT_PKG),
      [`${subPackage(model, 'domain.errors')}.ConflictException`],
      body
    )
  };
}

// El OTRO desenlace del mecanismo, y el que faltaba. El javadoc de IdempotencyStore decía
// que la reutilización de la clave con otro cuerpo «el diseño la resuelve con su propio
// error», y el diseño no tenía dónde ponerlo: tres corridas completas del pipeline
// improvisaron tres codes distintos para esto. Ahora sale del catálogo de keel-core, y el
// diseño lo sustituye declarando uno de su familia.
function renderReuse(model) {
  const canonical = FRAMEWORK_ERRORS.idempotencyReuse;
  const declared = declaredErrorFor(model, canonical);
  const code = declared?.code ?? canonical.code;
  const body = `/**
 * La misma clave de idempotencia con un contenido DISTINTO.
 *
 * <p>No es la carrera ({@link IdempotencyConflictException}) ni el reintento normal. El
 * cliente prometió, al mandar la clave, que dos peticiones con ella son la misma petición;
 * esta no lo es. Las dos salidas posibles son deshonestas: reproducir la respuesta de la
 * primera contesta a una pregunta que este cliente no hizo, y ejecutar la segunda rompe la
 * promesa de la clave. Lo que queda es decírselo.
 *
 * <p>Se detecta comparando la firma del contenido (CommandSignature) con la que se guardó
 * junto a la clave — por eso el registro guarda una firma y no un flag.${
   declared
     ? `\n *\n * <p>El code sale del error que el diseño declara para este conflicto.`
     : `\n *\n * <p>El code es el CANÓNICO del framework (docs/framework-errors.md): el diseño no declara
 * uno propio, y eso es una respuesta legítima, no un hueco. Para cambiarlo, declara en los
 * errors de la operación un code de su familia con status ${canonical.http}.`
 }
 */
public class IdempotencyReuseException extends ConflictException {

    public IdempotencyReuseException(String scope, String idempotencyKey) {
        super(
                "La clave de idempotencia " + scope + "/" + idempotencyKey
                        + " ya se usó con un contenido distinto",
                "${code}",
                ${canonical.http},
                new Object[] {scope, idempotencyKey});
    }
}`;

  return {
    path: javaPath(model, PORT_PKG, 'IdempotencyReuseException'),
    content: javaFile(
      subPackage(model, PORT_PKG),
      [`${subPackage(model, 'domain.errors')}.ConflictException`],
      body
    )
  };
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
 *
 * <p>El índice sobre expires_at es de la purga, no de la lectura (que va por clave
 * primaria): el barrido borra por rango y sin él cada réplica recorre la tabla
 * entera. Mismo nombre que su equivalente documental, para que las dos ramas se
 * comparen.
 */
@Entity
@Table(name = "idempotency_record", indexes = {
        @Index(name = "ix_idempotency_record_expires_at", columnList = "expires_at")
})
public class IdempotencyRecordJpa implements Persistable<IdempotencyRecordJpa.IdempotencyRecordId> {

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

    /** Se pone a true al leer la fila de la base ({@code @PostLoad}). */
    @Transient
    private boolean persisted;

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

    @Override
    public IdempotencyRecordId getId() {
        return id;
    }

    /**
     * Nueva mientras no se haya leido de la base. NO es constante, y el matiz es el
     * que hace que esto funcione: {@code SimpleJpaRepository.delete(...)} empieza con
     * {@code if (isNew(entity)) return;}, asi que un {@code isNew()} que devuelva
     * siempre {@code true} convierte el borrado en un NO-OP SILENCIOSO — y este
     * adaptador necesita borrar, para retirar un registro caducado.
     *
     * <p>Con el flag por {@code @PostLoad}: una fila recien construida es nueva
     * —{@code persist}, y la clave primaria arbitra la carrera entre dos peticiones
     * simultaneas— y una fila leida de la base no lo es, asi que se puede borrar.
     */
    @Override
    @Transient
    public boolean isNew() {
        return !persisted;
    }

    @PostLoad
    @PostPersist
    void markPersisted() {
        this.persisted = true;
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
        'jakarta.persistence.Index',
        'jakarta.persistence.PostLoad',
        'jakarta.persistence.PostPersist',
        'jakarta.persistence.Table',
        'jakarta.persistence.Transient',
        'java.io.Serializable',
        'java.time.Instant',
        'java.util.Objects',
        'org.springframework.data.domain.Persistable'
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
 * misma PK y la BD arbitra; la que pierde revierte entera, así que de las dos
 * peticiones idénticas se ejecutó exactamente una. Con varias réplicas esto deja
 * de ser un caso raro: las dos peticiones ni siquiera están en el mismo proceso, y
 * nada salvo la clave primaria las coordina.
 *
 * <p>El desenlace se traduce a {@link IdempotencyConflictException} en vez de
 * dejarlo subir crudo: sin code propio, el cliente recibiría un 409 indistinguible
 * de un conflicto de negocio de la misma operación.
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
        IdempotencyRecordJpa.IdempotencyRecordId key =
                new IdempotencyRecordJpa.IdempotencyRecordId(scope, idempotencyKey);
        // Una fila CADUCADA es como si no estuviera —es lo que ya asume find(...)—, y
        // tiene que serlo también aquí. Si no, la clave queda inutilizable entre su
        // caducidad y la purga: find la ignora, el handler ejecuta, y la inserción
        // choca con una fila que ya no protege nada. El cliente recibiría un 409
        // IDEMPOTENCY_KEY_IN_PROGRESS durante casi un día, y la ventana real de
        // deduplicación la fijaría la cadencia de la purga en vez del ttlSeconds del
        // diseño, que es justo lo que ese campo compra.
        //
        // Se retira por el repositorio y no con un borrado masivo a propósito:
        // find(...) acaba de cargar esa fila en ESTE contexto de persistencia, y un
        // delete masivo no la desasocia — la inserción siguiente chocaría contra la
        // copia gestionada en memoria en vez de contra la base.
        repository.findById(key)
                .filter(stored -> !stored.getExpiresAt().isAfter(now))
                .ifPresent(expired -> {
                    repository.delete(expired);
                    // Antes del INSERT, y en esta transacción: si no, JPA reordena y la
                    // inserción sale primero, contra la fila que aún está.
                    repository.flush();
                });
        try {
            // saveAndFlush del REPOSITORIO, no entityManager.persist a mano: la
            // traduccion de excepciones de Spring ocurre al salir de un metodo
            // proxeado, y el proxy de Spring Data convierte la violacion de Hibernate
            // en DataIntegrityViolationException — que es lo que captura el catch de
            // abajo. Con el EntityManager compartido dentro de un @Component no hay
            // proxy que traduzca, sale un ConstraintViolationException crudo que
            // ningun catch reconoce, y la carrera acaba en 500 en vez de en su code.
            // El INSERT lo fuerza Persistable.isNew() en la entidad, no este metodo.
            // Y saveAndFlush y no save porque JPA difiere el INSERT hasta el commit:
            // sin el flush la violacion saldria por el commit del UseCaseMediator,
            // donde ya nadie puede distinguirla ni traducirla.
            repository.saveAndFlush(new IdempotencyRecordJpa(
                    key,
                    signature,
                    resourceId,
                    now,
                    now.plusSeconds(ttlSeconds)));
        } catch (DataIntegrityViolationException concurrent) {
            throw new IdempotencyConflictException(scope, idempotencyKey, concurrent);
        }
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
        `${subPackage(model, PORT_PKG)}.IdempotencyConflictException`,
        `${subPackage(model, PORT_PKG)}.IdempotencyStore`,
        'java.time.Instant',
        'java.util.Optional',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.dao.DataIntegrityViolationException',
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
 * DuplicateKeyException —una DataIntegrityViolationException— que aquí se traduce a
 * {@link IdempotencyConflictException} para que el cliente reciba un 409 con code
 * propio, distinguible de un conflicto de negocio. De dos peticiones idénticas,
 * exactamente una se ejecutó. Con varias réplicas, las dos ni siquiera están en el
 * mismo proceso: el _id es lo único que las coordina.
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
        IdempotencyRecordDocument.IdempotencyRecordId key =
                new IdempotencyRecordDocument.IdempotencyRecordId(scope, idempotencyKey);
        // Un documento CADUCADO es como si no estuviera —es lo que ya asume find(...)—,
        // y tiene que serlo también aquí: si no, la clave queda inutilizable entre su
        // caducidad y la purga (que va por lotes, una vez al día). El insert chocaría
        // con un documento que ya no protege nada y el cliente recibiría un 409 por una
        // ventana que el diseño dio por cerrada hace horas.
        repository.findById(key)
                .filter(stored -> !stored.getExpiresAt().isAfter(now))
                .ifPresent(expired -> repository.deleteById(key));
        try {
            repository.insert(new IdempotencyRecordDocument(
                    key,
                    signature,
                    resourceId,
                    now,
                    now.plusSeconds(ttlSeconds)));
        } catch (DataIntegrityViolationException concurrent) {
            throw new IdempotencyConflictException(scope, idempotencyKey, concurrent);
        }
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
        `${subPackage(model, PORT_PKG)}.IdempotencyConflictException`,
        `${subPackage(model, PORT_PKG)}.IdempotencyStore`,
        'java.time.Instant',
        'java.util.Optional',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory',
        'org.springframework.dao.DataIntegrityViolationException',
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
