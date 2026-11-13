// El HISTORIAL DE CAMBIOS consultable (DSL 2.29: `persistence.audit.history` y la query de `output: { history }`) en
// keel-spring: incremento 1 de PLAN-DSL-229-HISTORIAL.md. Lo que decide QUÉ (qué raíces, qué rutas registra cada una,
// cuáles son personales, el diff, el orden, los filtros, las tablas y sus sentencias, la nota) es de keel-core
// (gen/history.js, gen/history-store.js); aquí solo se escribe en Java:
//
//   · `domain.history`: el puerto `ChangeHistory`, la entrada y el cambio del cable, el filtro, el diff (D2) y la
//     reescritura de lo personal (D8), y las constantes de cada raíz (`HistoryRoots`: su tipo y sus rutas personales).
//   · El almacén (D6, D11): `JdbcChangeHistory` con las sentencias de keel-core TAL CUAL, más las dos tablas mapeadas solo
//     para el esquema; o `MongoChangeHistory`, un documento por entrada.
//   · El ADAPTADOR de la raíz escribe la entrada en su `save`/`deleteById`/`restore` (D1), con la instantánea «antes»
//     tomada al CARGAR la fila gestionada y no al guardar (T1), y lee el historial con `historyOf`, que carga la raíz
//     con la misma lectura que su ficha (D7).
//   · La retención se lleva el historial (`then: delete`) o lo anonimiza (`then: anonymize`), en data-lifecycle.js.

import { usesHistory, historyRootNames, historyPersonalPatterns, historyNote } from '@keel-system/keel-core/gen/history';
import {
  CHANGE_HISTORY,
  CHANGE_HISTORY_FIELD,
  CHANGE_HISTORY_COLLECTION,
  HISTORY_ENGINES,
  HISTORY_FILTER_ORDER,
  historyStatements
} from '@keel-system/keel-core/gen/history-store';
import { scopedLoadOf } from '@keel-system/keel-core/gen/read-scope';
import { javaFile, javaPath, subPackage } from './render.js';
import { readScopeImport } from './read-scope.js';
import { domainSubPackage } from './entities.js';

export const HISTORY_PKG = 'domain.history';
export const HISTORY_STORE_PKG = 'infrastructure.persistence.history';

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const javaText = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const isDocument = (model) => model.persistenceKind === 'document';

export { usesHistory };

/** ¿Lleva historial esta raíz? */
export const recordsHistory = (entity) => Boolean(entity?.history && entity.historyShape);

export const historyImport = (model, name) => `${subPackage(model, HISTORY_PKG)}.${name}`;

/** La constante del tipo de una raíz en `HistoryRoots`: `CONTACT_CARD`. */
export const rootTypeConstant = (entity) => `HistoryRoots.${constantOf(entity.name)}`;

/**
 * Lo que el historial no puede generar con este stack, o []: las sentencias son de PostgreSQL y MySQL (las mide
 * timer-sql-check) y el documental es MongoDB. Una réplica (`replicated`) no es un agregado de este servicio.
 */
export function historyStackErrors(model) {
  if (!usesHistory(model)) return [];
  const errors = [];
  if (!isDocument(model) && !HISTORY_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `persistence: audit.history (DSL 2.29): el almacén del historial tiene sentencias medidas para ${HISTORY_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores.`
    );
  }
  for (const entity of model.entities.filter((candidate) => candidate.history)) {
    if (entity.replicaOf) errors.push(`persistence: audit.history: ${entity.name} es la copia local de otro servicio, no un agregado de este.`);
    if ((entity.historyShape?.paths ?? []).some((path) => path.split('.').length > 3)) {
      errors.push(`persistence: audit.history: ${entity.name} tiene un value object anidado a más de dos niveles, y keel-spring no lo recorre todavía.`);
    }
  }
  return errors;
}

// ─── El dominio: el puerto y lo que viaja ────────────────────────────────────────────────────────────────────────

function domainFiles(model) {
  const file = (name, imports, body) => ({ path: javaPath(model, HISTORY_PKG, name), content: javaFile(subPackage(model, HISTORY_PKG), imports, body) });
  const fieldChange = file('FieldChange', ['com.fasterxml.jackson.annotation.JsonInclude', 'tools.jackson.databind.JsonNode'], `/**
 * Un campo que cambió en una escritura (wire-contract.md § Historial): su ruta del contrato y sus valores antes y después,
 * con las reglas del cable. {@code null} cuando no había o ya no hay, y se escribe aunque la convención de nulos del
 * servicio los omita: un historial que calla el {@code before} no dice desde qué valor cambió.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record FieldChange(String field, JsonNode before, JsonNode after) {
}`);
  const entry = file('HistoryEntry', ['com.fasterxml.jackson.annotation.JsonInclude', 'java.time.Instant', 'java.util.List'], `/**
 * Una entrada del historial: una escritura confirmada sobre el agregado (D2). {@code change} es {@code created},
 * {@code updated}, {@code deleted}, {@code restored} o {@code anonymized}; {@code author} es el actor de la autoría, o el
 * centinela {@code system} fuera de una petición.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record HistoryEntry(Instant at, String author, String change, List<FieldChange> changes) {
}`);
  const filter = file('HistoryFilter', ['java.time.Instant'], `/**
 * Los filtros de una lectura del historial (D10), los tres opcionales y combinados con AND: {@code field} casa la ruta
 * entera o el campo de la raíz que la contiene ({@code price} casa {@code price.amount}); {@code from} y {@code to}
 * incluyen su extremo.
 */
public record HistoryFilter(String field, Instant from, Instant to) {

    /** Sin filtros: el historial entero. */
    public static HistoryFilter none() {
        return new HistoryFilter(null, null, null);
    }
}`);
  const personal = file('PersonalPath', ['java.util.regex.Pattern'], `/**
 * Una ruta personal del historial de una raíz (DSL 2.28): el patrón de keel-core ({@code historyPersonalPatterns}) y si
 * el campo es obligatorio, que decide qué vale al anonimizar: el sustituto {@code anon-<id>} o null.
 */
public record PersonalPath(Pattern pattern, boolean required) {

    public static PersonalPath of(String regex, boolean required) {
        return new PersonalPath(Pattern.compile(regex), required);
    }

    public boolean matches(String field) {
        return pattern.matcher(field).matches();
    }
}`);
  const port = file('ChangeHistory', ['java.util.List', 'org.springframework.data.domain.Page', 'org.springframework.data.domain.Pageable', 'tools.jackson.databind.JsonNode'], `/**
 * El almacén del historial de cambios (DSL 2.29). Lo escriben los adaptadores de las raíces con historial, en la MISMA
 * transacción que la escritura (D1): una escritura que revierte no deja entrada. Ningún handler lo usa: la lectura entra
 * por el {@code historyOf} del puerto de la raíz, que antes la carga como su ficha (D7).
 */
public interface ChangeHistory {

    String CREATED = "created";
    String UPDATED = "updated";
    String DELETED = "deleted";
    String RESTORED = "restored";
    String ANONYMIZED = "anonymized";

    /** Escribe una entrada con el autor de la escritura en curso. */
    void record(String rootType, String rootId, String change, List<FieldChange> changes);

    /** Una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor. */
    Page<HistoryEntry> page(String rootType, String rootId, HistoryFilter filter, Pageable pageable);

    /** Reescribe los valores personales de todas las entradas de la raíz y deja la entrada {@code anonymized} (D8). */
    void anonymize(String rootType, String rootId, List<PersonalPath> personal);

    /** Borra el historial de la raíz: su retención con {@code then: delete} o la purga de lo borrado (D8). */
    void purge(String rootType, String rootId);

    /** El valor de un dato del dominio como lo escribe el cable (el ObjectMapper de la aplicación). */
    JsonNode value(Object value);
}`);
  const diff = file('HistoryDiff', ['java.util.ArrayList', 'java.util.LinkedHashMap', 'java.util.List', 'java.util.Map', 'java.util.TreeSet', 'java.util.function.Function', 'tools.jackson.databind.JsonNode', 'tools.jackson.databind.node.NullNode'], `/**
 * El diff de dos instantáneas de un agregado (D2, D3): la referencia ejecutable es {@code historyDiff} de keel-core, y
 * los cuatro generadores comparan lo mismo. Una instantánea es ruta del contrato → valor del cable; {@code before} null
 * es un alta. Devuelve solo lo que cambió, ordenado por ruta.
 */
public final class HistoryDiff {

    private HistoryDiff() {
    }

    public static List<FieldChange> diff(Map<String, JsonNode> before, Map<String, JsonNode> after) {
        TreeSet<String> paths = new TreeSet<>(after.keySet());
        if (before != null) {
            paths.addAll(before.keySet());
        }
        List<FieldChange> changes = new ArrayList<>();
        for (String path : paths) {
            JsonNode was = valueAt(before, path);
            JsonNode is = valueAt(after, path);
            if (!was.equals(is)) {
                changes.add(new FieldChange(path, was, is));
            }
        }
        return changes;
    }

    private static JsonNode valueAt(Map<String, JsonNode> snapshot, String path) {
        JsonNode value = snapshot == null ? null : snapshot.get(path);
        return value == null ? NullNode.getInstance() : value;
    }

    /** Un paso de una ruta con dot-path, sin reventar en un value object ausente. */
    public static <A, B> B at(A value, Function<A, B> step) {
        return value == null ? null : step.apply(value);
    }

    /** Las filas del filtro por campo de una entrada: su ruta y el campo de la raíz que la contiene, sin repetir. */
    public static Map<String, String> fieldRows(List<FieldChange> changes) {
        Map<String, String> rows = new LinkedHashMap<>();
        for (FieldChange change : changes) {
            rows.putIfAbsent(change.field(), change.field().split("[.\\\\[]", 2)[0]);
        }
        return rows;
    }
}`);
  const anonymization = file('HistoryAnonymization', ['java.util.ArrayList', 'java.util.List', 'java.util.TreeMap', 'tools.jackson.databind.JsonNode', 'tools.jackson.databind.node.NullNode', 'tools.jackson.databind.node.StringNode'], `/**
 * La anonimización del historial (D8): las referencias ejecutables son {@code anonymizeHistoryChanges} y
 * {@code anonymizedEntryChanges} de keel-core. Un valor personal pasa a {@code anon-<id de la raíz>} si el campo es
 * obligatorio y a null si no, en {@code before} y en {@code after}: el anterior ya no existe en ninguna parte.
 */
public final class HistoryAnonymization {

    private HistoryAnonymization() {
    }

    /** Los cambios de una entrada, reescritos, y si alguno cambió. */
    public record Rewrite(List<FieldChange> changes, boolean touched) {
    }

    public static Rewrite rewrite(List<FieldChange> changes, List<PersonalPath> personal, String rootId) {
        boolean touched = false;
        List<FieldChange> out = new ArrayList<>();
        for (FieldChange change : changes) {
            PersonalPath match = match(personal, change.field());
            if (match == null) {
                out.add(change);
                continue;
            }
            JsonNode value = value(match, rootId);
            if (!value.equals(nullSafe(change.before())) || !value.equals(nullSafe(change.after()))) {
                touched = true;
            }
            out.add(new FieldChange(change.field(), value, value));
        }
        return new Rewrite(out, touched);
    }

    /** Los cambios de la entrada {@code anonymized}: una por ruta personal que aparece en el historial, por ruta. */
    public static List<FieldChange> anonymizedEntry(List<List<FieldChange>> entries, List<PersonalPath> personal, String rootId) {
        TreeMap<String, JsonNode> seen = new TreeMap<>();
        for (List<FieldChange> changes : entries) {
            for (FieldChange change : changes) {
                PersonalPath match = match(personal, change.field());
                if (match != null) {
                    seen.putIfAbsent(change.field(), value(match, rootId));
                }
            }
        }
        List<FieldChange> out = new ArrayList<>();
        seen.forEach((field, value) -> out.add(new FieldChange(field, value, value)));
        return out;
    }

    private static PersonalPath match(List<PersonalPath> personal, String field) {
        for (PersonalPath path : personal) {
            if (path.matches(field)) {
                return path;
            }
        }
        return null;
    }

    private static JsonNode value(PersonalPath path, String rootId) {
        return path.required() ? StringNode.valueOf("anon-" + rootId) : NullNode.getInstance();
    }

    private static JsonNode nullSafe(JsonNode value) {
        return value == null ? NullNode.getInstance() : value;
    }
}`);
  const roots = model.entities.filter(recordsHistory);
  const rootsFile = file('HistoryRoots', ['java.util.List'], `/**
 * Las raíces con historial (persistence.audit.history): el tipo con que se guardan sus entradas —el nombre del diseño,
 * contrato con los otros generadores— y sus rutas personales, con los patrones de keel-core.
 */
public final class HistoryRoots {

${roots
  .map((entity) => {
    const patterns = historyPersonalPatterns(entity.historyShape);
    return `    public static final String ${constantOf(entity.name)} = "${entity.name}";

    public static final List<PersonalPath> ${constantOf(entity.name)}_PERSONAL = List.of(${patterns.length > 0 ? `\n${patterns.map((entry) => `            PersonalPath.of(${javaText(entry.pattern)}, ${entry.required})`).join(',\n')})` : ')'};`;
  })
  .join('\n\n')}

    private HistoryRoots() {
    }
}`);
  return [fieldChange, entry, filter, personal, port, diff, anonymization, rootsFile];
}

// ─── El almacén relacional ───────────────────────────────────────────────────────────────────────────────────────

function jdbcStore(model) {
  const engine = model.stack.database;
  const S = historyStatements(engine);
  const mysql = engine === 'mysql';
  const constant = (name, sql) => `    private static final String ${name} = ${javaText(sql)};`;
  const constants = [
    constant('INSERT_ENTRY', S.insertEntry),
    constant('INSERT_FIELD', S.insertField),
    constant('PAGE_HEAD', S.pageHead),
    constant('COUNT_HEAD', S.countHead),
    ...HISTORY_FILTER_ORDER.map((name) => constant(`FILTER_${name.toUpperCase()}`, S.filters[name])),
    constant('PAGE_TAIL', S.pageTail),
    constant('ENTRIES_OF_ROOT', S.entriesOfRoot),
    constant('UPDATE_CHANGES', S.updateChanges),
    constant('DELETE_FIELDS', S.deleteFields),
    constant('DELETE_ENTRIES', S.deleteEntries)
  ].join('\n');
  const binding = mysql
    ? `    // MySQL: el uuid es binary(16) (el orden de bytes de Hibernate) y la hora un datetime(6) con la hora UTC.
    private static Object uuid(UUID value) {
        return ByteBuffer.allocate(16).putLong(value.getMostSignificantBits()).putLong(value.getLeastSignificantBits()).array();
    }

    private static UUID readUuid(ResultSet rs, String column) throws SQLException {
        ByteBuffer buffer = ByteBuffer.wrap(rs.getBytes(column));
        return new UUID(buffer.getLong(), buffer.getLong());
    }

    private static Object time(Instant value) {
        return value == null ? null : LocalDateTime.ofInstant(value, ZoneOffset.UTC);
    }

    private static Instant readTime(ResultSet rs, String column) throws SQLException {
        LocalDateTime value = rs.getObject(column, LocalDateTime.class);
        return value == null ? null : value.toInstant(ZoneOffset.UTC);
    }`
    : `    // PostgreSQL: uuid nativo y timestamp with time zone.
    private static Object uuid(UUID value) {
        return value;
    }

    private static UUID readUuid(ResultSet rs, String column) throws SQLException {
        return rs.getObject(column, UUID.class);
    }

    private static Object time(Instant value) {
        return value == null ? null : OffsetDateTime.ofInstant(value, ZoneOffset.UTC);
    }

    private static Instant readTime(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }`;
  const imports = [
    ...['ChangeHistory', 'FieldChange', 'HistoryAnonymization', 'HistoryDiff', 'HistoryEntry', 'HistoryFilter', 'PersonalPath'].map((name) => historyImport(model, name)),
    `${subPackage(model, 'domain.identity')}.Uuids`,
    'java.sql.ResultSet',
    'java.sql.SQLException',
    'java.time.Instant',
    'java.time.ZoneOffset',
    mysql ? 'java.nio.ByteBuffer' : null,
    mysql ? 'java.time.LocalDateTime' : 'java.time.OffsetDateTime',
    'java.util.ArrayList',
    'java.util.List',
    'java.util.Map',
    'java.util.UUID',
    'javax.sql.DataSource',
    'org.springframework.data.domain.AuditorAware',
    'org.springframework.data.domain.Page',
    'org.springframework.data.domain.PageImpl',
    'org.springframework.data.domain.Pageable',
    'org.springframework.jdbc.core.simple.JdbcClient',
    'org.springframework.stereotype.Component',
    'tools.jackson.core.type.TypeReference',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper',
    'tools.jackson.databind.node.NullNode'
  ];
  const body = `/**
 * El historial de cambios sobre ${mysql ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core ({@code history-store.js})
 * TAL CUAL: son contrato con los otros generadores, que comparten las tablas, y las mide {@code timer-sql-check} contra el
 * motor. No las reescribas aquí.
 *
 * <p>Va por JDBC sobre el mismo {@code DataSource} que JPA, así que la entrada entra en la transacción de la escritura que
 * la origina ({@code JpaTransactionManager} expone su conexión a JDBC): si la escritura revierte, la entrada también (D1).
 * La hora es la del motor; a igual hora desempata el id, un UUID versión 7.
 */
@Component
public class JdbcChangeHistory implements ChangeHistory {

${constants}

    private static final TypeReference<List<FieldChange>> CHANGES = new TypeReference<>() {
    };

    private final JdbcClient jdbc;
    private final ObjectMapper mapper;
    private final AuditorAware<String> auditor;

    public JdbcChangeHistory(DataSource dataSource, ObjectMapper mapper, AuditorAware<String> auditor) {
        this.jdbc = JdbcClient.create(dataSource);
        this.mapper = mapper;
        this.auditor = auditor;
    }

    @Override
    public void record(String rootType, String rootId, String change, List<FieldChange> changes) {
        UUID id = Uuids.v7();
        jdbc.sql(INSERT_ENTRY)
                .param("id", uuid(id))
                .param("rootType", rootType)
                .param("rootId", rootId)
                .param("author", auditor.getCurrentAuditor().orElse("system"))
                .param("change", change)
                .param("changes", mapper.writeValueAsString(changes))
                .update();
        for (Map.Entry<String, String> row : HistoryDiff.fieldRows(changes).entrySet()) {
            jdbc.sql(INSERT_FIELD).param("entryId", uuid(id)).param("path", row.getKey()).param("top", row.getValue()).update();
        }
    }

    @Override
    public Page<HistoryEntry> page(String rootType, String rootId, HistoryFilter filter, Pageable pageable) {
        // Los filtros presentes, en el orden de keel-core (historyPageSql): uno que no llega no se escribe.
        String filters = (filter.field() != null ? FILTER_FIELD : "") + (filter.from() != null ? FILTER_FROM : "") + (filter.to() != null ? FILTER_TO : "");
        JdbcClient.StatementSpec rows = bind(jdbc.sql(PAGE_HEAD + filters + PAGE_TAIL), rootType, rootId, filter)
                .param("limit", pageable.getPageSize())
                .param("offset", pageable.getOffset());
        List<HistoryEntry> entries = rows
                .query((rs, row) -> new HistoryEntry(readTime(rs, "at"), rs.getString("author"), rs.getString("change_kind"), read(rs.getString("changes"))))
                .list();
        long total = bind(jdbc.sql(COUNT_HEAD + filters), rootType, rootId, filter).query(Long.class).single();
        return new PageImpl<>(entries, pageable, total);
    }

    private static JdbcClient.StatementSpec bind(JdbcClient.StatementSpec spec, String rootType, String rootId, HistoryFilter filter) {
        JdbcClient.StatementSpec bound = spec.param("rootType", rootType).param("rootId", rootId);
        if (filter.field() != null) {
            bound = bound.param("field", filter.field());
        }
        if (filter.from() != null) {
            bound = bound.param("from", time(filter.from()));
        }
        if (filter.to() != null) {
            bound = bound.param("to", time(filter.to()));
        }
        return bound;
    }

    @Override
    public void anonymize(String rootType, String rootId, List<PersonalPath> personal) {
        List<List<FieldChange>> all = new ArrayList<>();
        List<Map.Entry<UUID, List<FieldChange>>> stored = jdbc.sql(ENTRIES_OF_ROOT)
                .param("rootType", rootType)
                .param("rootId", rootId)
                .query((rs, row) -> Map.entry(readUuid(rs, "id"), read(rs.getString("changes"))))
                .list();
        for (Map.Entry<UUID, List<FieldChange>> entry : stored) {
            HistoryAnonymization.Rewrite rewrite = HistoryAnonymization.rewrite(entry.getValue(), personal, rootId);
            all.add(rewrite.changes());
            if (rewrite.touched()) {
                jdbc.sql(UPDATE_CHANGES).param("changes", mapper.writeValueAsString(rewrite.changes())).param("id", uuid(entry.getKey())).update();
            }
        }
        record(rootType, rootId, ANONYMIZED, HistoryAnonymization.anonymizedEntry(all, personal, rootId));
    }

    @Override
    public void purge(String rootType, String rootId) {
        jdbc.sql(DELETE_FIELDS).param("rootType", rootType).param("rootId", rootId).update();
        jdbc.sql(DELETE_ENTRIES).param("rootType", rootType).param("rootId", rootId).update();
    }

    @Override
    public JsonNode value(Object value) {
        return value == null ? NullNode.getInstance() : mapper.valueToTree(value);
    }

    private List<FieldChange> read(String changes) {
        return mapper.readValue(changes, CHANGES);
    }

${binding}
}`;
  return { path: javaPath(model, HISTORY_STORE_PKG, 'JdbcChangeHistory'), content: javaFile(subPackage(model, HISTORY_STORE_PKG), imports, body) };
}

const lengthOf = (table, name) => table.columns.find((column) => column.name === name).length;

function schemaEntities(model) {
  const index = CHANGE_HISTORY.indexes[0];
  const entry = `/**
 * La tabla del historial, mapeada SOLO para el esquema: así la crea Hibernate en \`local\` y \`test\`, la valida en
 * \`develop\` y \`production\`, y entra en el baseline que exporta el agente (o en el paso de esquema de build, si la base
 * ya está desplegada). Nadie la lee por JPA: la usa {@code JdbcChangeHistory}, con las sentencias de keel-core.
 *
 * <p>Columnas e índice son los de keel-core ({@code CHANGE_HISTORY}): los comparten los cuatro generadores.
 */
@Entity
@Table(name = "${CHANGE_HISTORY.table}", indexes = @Index(name = "${index.name}", columnList = "${index.columns.join(', ')}"))
public class ChangeHistoryJpa {

    @Id
    @Column(name = "id", nullable = false)
    private UUID id;

    @Column(name = "root_type", nullable = false, length = ${lengthOf(CHANGE_HISTORY, 'root_type')})
    private String rootType;

    @Column(name = "root_id", nullable = false, length = ${lengthOf(CHANGE_HISTORY, 'root_id')})
    private String rootId;

    @Column(name = "at", nullable = false)
    private Instant at;

    @Column(name = "author", nullable = false, length = ${lengthOf(CHANGE_HISTORY, 'author')})
    private String author;

    @Column(name = "change_kind", nullable = false, length = ${lengthOf(CHANGE_HISTORY, 'change_kind')})
    private String changeKind;

    @Column(name = "changes", nullable = false, columnDefinition = "text")
    private String changes;

    protected ChangeHistoryJpa() {
    }
}`;
  const fk = CHANGE_HISTORY_FIELD.columns.find((column) => column.references).references;
  const field = `/**
 * Los campos que tocó cada entrada, para el filtro por campo sin operadores JSON del motor (D11): su ruta y el campo de la
 * raíz que la contiene. Mapeada solo para el esquema, como {@link ChangeHistoryJpa}; se va con su entrada (ON DELETE
 * CASCADE).
 */
@Entity
@Table(name = "${CHANGE_HISTORY_FIELD.table}")
@IdClass(ChangeHistoryFieldJpa.Key.class)
public class ChangeHistoryFieldJpa {

    @Id
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "entry_id", nullable = false, foreignKey = @ForeignKey(name = "${fk.name}"))
    @OnDelete(action = OnDeleteAction.CASCADE)
    private ChangeHistoryJpa entry;

    @Id
    @Column(name = "path", nullable = false, length = ${lengthOf(CHANGE_HISTORY_FIELD, 'path')})
    private String path;

    @Column(name = "top", nullable = false, length = ${lengthOf(CHANGE_HISTORY_FIELD, 'top')})
    private String top;

    protected ChangeHistoryFieldJpa() {
    }

    /** La clave compuesta (entry_id, path). */
    public static class Key implements Serializable {

        private UUID entry;
        private String path;

        public Key() {
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Key key && Objects.equals(entry, key.entry) && Objects.equals(path, key.path);
        }

        @Override
        public int hashCode() {
            return Objects.hash(entry, path);
        }
    }
}`;
  const pkg = subPackage(model, HISTORY_STORE_PKG);
  return [
    {
      path: javaPath(model, HISTORY_STORE_PKG, 'ChangeHistoryJpa'),
      content: javaFile(pkg, ['jakarta.persistence.Column', 'jakarta.persistence.Entity', 'jakarta.persistence.Id', 'jakarta.persistence.Index', 'jakarta.persistence.Table', 'java.time.Instant', 'java.util.UUID'], entry)
    },
    {
      path: javaPath(model, HISTORY_STORE_PKG, 'ChangeHistoryFieldJpa'),
      content: javaFile(
        pkg,
        [
          'jakarta.persistence.Column',
          'jakarta.persistence.Entity',
          'jakarta.persistence.FetchType',
          'jakarta.persistence.ForeignKey',
          'jakarta.persistence.Id',
          'jakarta.persistence.IdClass',
          'jakarta.persistence.JoinColumn',
          'jakarta.persistence.ManyToOne',
          'jakarta.persistence.Table',
          'java.io.Serializable',
          'java.util.Objects',
          'java.util.UUID',
          'org.hibernate.annotations.OnDelete',
          'org.hibernate.annotations.OnDeleteAction'
        ],
        field
      )
    }
  ];
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────────────────────

function mongoStore(model) {
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  const imports = [
    ...['ChangeHistory', 'FieldChange', 'HistoryAnonymization', 'HistoryDiff', 'HistoryEntry', 'HistoryFilter', 'PersonalPath'].map((name) => historyImport(model, name)),
    `${subPackage(model, 'domain.identity')}.Uuids`,
    'jakarta.annotation.PostConstruct',
    'java.time.Instant',
    'java.util.ArrayList',
    'java.util.Date',
    'java.util.List',
    'org.bson.Document',
    'org.springframework.data.domain.AuditorAware',
    'org.springframework.data.domain.Page',
    'org.springframework.data.domain.PageImpl',
    'org.springframework.data.domain.Pageable',
    'org.springframework.data.domain.Sort',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'org.springframework.data.mongodb.core.index.Index',
    'org.springframework.data.mongodb.core.query.Criteria',
    'org.springframework.data.mongodb.core.query.Query',
    'org.springframework.data.mongodb.core.query.Update',
    'org.springframework.stereotype.Component',
    'tools.jackson.core.type.TypeReference',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper',
    'tools.jackson.databind.node.NullNode'
  ];
  const keys = index.keys.map(([key, direction]) => `\n                .on("${key}", Sort.Direction.${direction > 0 ? 'ASC' : 'DESC'})`).join('');
  const body = `/**
 * El historial de cambios sobre MongoDB, con la forma documental de keel-core ({@code CHANGE_HISTORY_COLLECTION}): un
 * documento por entrada con los nombres de las columnas, {@code _id} el id como texto y, en vez de la segunda tabla,
 * {@code fields} con la ruta y el campo de la raíz de cada cambio. {@code changes} va como TEXTO, igual que en el
 * relacional: un decimal o un número grande del cable no sobreviven a pasar por BSON y volver.
 *
 * <p>Va por {@link MongoTemplate}, que se une a la transacción de la escritura ({@code MongoTransactionManager}): si la
 * escritura revierte, la entrada también (D1). A igual instante desempata el id, un UUID versión 7.
 */
@Component
public class MongoChangeHistory implements ChangeHistory {

    private static final String COLLECTION = "${CHANGE_HISTORY_COLLECTION.collection}";

    private static final TypeReference<List<FieldChange>> CHANGES = new TypeReference<>() {
    };

    private final MongoTemplate mongo;
    private final ObjectMapper mapper;
    private final AuditorAware<String> auditor;

    public MongoChangeHistory(MongoTemplate mongo, ObjectMapper mapper, AuditorAware<String> auditor) {
        this.mongo = mongo;
        this.mapper = mapper;
        this.auditor = auditor;
    }

    /** El índice de la lectura: una raíz, del más reciente al más antiguo. Idempotente en cada arranque. */
    @PostConstruct
    void ensureIndex() {
        mongo.indexOps(COLLECTION).createIndex(new Index()${keys}
                .named("${index.name}"));
    }

    @Override
    public void record(String rootType, String rootId, String change, List<FieldChange> changes) {
        List<Document> fields = new ArrayList<>();
        HistoryDiff.fieldRows(changes).forEach((path, top) -> fields.add(new Document("path", path).append("top", top)));
        Document entry = new Document("_id", Uuids.v7().toString())
                .append("root_type", rootType)
                .append("root_id", rootId)
                .append("at", Date.from(Instant.now()))
                .append("author", auditor.getCurrentAuditor().orElse("system"))
                .append("change_kind", change)
                .append("changes", mapper.writeValueAsString(changes))
                .append("${CHANGE_HISTORY_COLLECTION.fields}", fields);
        mongo.insert(entry, COLLECTION);
    }

    @Override
    public Page<HistoryEntry> page(String rootType, String rootId, HistoryFilter filter, Pageable pageable) {
        Criteria criteria = Criteria.where("root_type").is(rootType).and("root_id").is(rootId);
        if (filter.field() != null) {
            // La ruta entera o el campo de la raíz que la contiene (historyMatches de keel-core).
            criteria = criteria.orOperator(Criteria.where("fields.path").is(filter.field()), Criteria.where("fields.top").is(filter.field()));
        }
        if (filter.from() != null || filter.to() != null) {
            Criteria at = criteria.and("at");
            if (filter.from() != null) {
                at = at.gte(Date.from(filter.from()));
            }
            if (filter.to() != null) {
                at.lte(Date.from(filter.to()));
            }
        }
        Query query = new Query(criteria)
                .with(Sort.by(Sort.Order.desc("at"), Sort.Order.desc("_id")))
                .skip(pageable.getOffset())
                .limit(pageable.getPageSize());
        List<HistoryEntry> entries = mongo.find(query, Document.class, COLLECTION).stream()
                .map(document -> new HistoryEntry(document.getDate("at").toInstant(), document.getString("author"),
                        document.getString("change_kind"), read(document.getString("changes"))))
                .toList();
        long total = mongo.count(new Query(criteria), COLLECTION);
        return new PageImpl<>(entries, pageable, total);
    }

    @Override
    public void anonymize(String rootType, String rootId, List<PersonalPath> personal) {
        Query ofRoot = new Query(Criteria.where("root_type").is(rootType).and("root_id").is(rootId));
        List<List<FieldChange>> all = new ArrayList<>();
        for (Document stored : mongo.find(ofRoot, Document.class, COLLECTION)) {
            HistoryAnonymization.Rewrite rewrite = HistoryAnonymization.rewrite(read(stored.getString("changes")), personal, rootId);
            all.add(rewrite.changes());
            if (rewrite.touched()) {
                mongo.updateFirst(new Query(Criteria.where("_id").is(stored.get("_id"))),
                        new Update().set("changes", mapper.writeValueAsString(rewrite.changes())), COLLECTION);
            }
        }
        record(rootType, rootId, ANONYMIZED, HistoryAnonymization.anonymizedEntry(all, personal, rootId));
    }

    @Override
    public void purge(String rootType, String rootId) {
        mongo.remove(new Query(Criteria.where("root_type").is(rootType).and("root_id").is(rootId)), COLLECTION);
    }

    @Override
    public JsonNode value(Object value) {
        return value == null ? NullNode.getInstance() : mapper.valueToTree(value);
    }

    private List<FieldChange> read(String changes) {
        return mapper.readValue(changes, CHANGES);
    }
}`;
  return { path: javaPath(model, HISTORY_STORE_PKG, 'MongoChangeHistory'), content: javaFile(subPackage(model, HISTORY_STORE_PKG), imports, body) };
}

export function generate(model) {
  if (!model.layersPresent.persistence || !usesHistory(model)) return [];
  return [...domainFiles(model), ...(isDocument(model) ? [mongoStore(model)] : [jdbcStore(model), ...schemaEntities(model)])];
}

// ─── Lo que gana el adaptador de cada raíz ───────────────────────────────────────────────────────────────────────

/** La expresión Java de una ruta del contrato sobre `variable` (`price.amount` → `HistoryDiff.at(entity.getPrice(), v -> v.amount())`). */
function pathExpression(variable, path) {
  const [head, ...rest] = path.split('.');
  let expression = `${variable}.get${capital(head)}()`;
  for (const segment of rest) expression = `HistoryDiff.at(${expression}, v -> v.${segment}())`;
  return expression;
}

/**
 * La instantánea de un agregado del dominio (D3): ruta del contrato → valor del cable. La forma la da keel-core
 * (`historyShape`); las hijas de una lista van por su id.
 */
function snapshotMethod(model, entity, imports) {
  const shape = entity.historyShape;
  for (const name of ['java.util.Map', 'java.util.TreeMap', 'tools.jackson.databind.JsonNode', historyImport(model, 'HistoryDiff')]) imports.add(name);
  const lines = shape.paths.map((path) => `        snapshot.put("${path}", changeHistory.value(${pathExpression('entity', path)}));`);
  for (const child of shape.children) {
    const childEntity = model.entities.find((candidate) => candidate.name === child.entity);
    imports.add(`${subPackage(model, domainSubPackage(childEntity))}.${child.entity}`);
    const childLines = (indent) => child.paths.map((path) => `${indent}snapshot.put(prefix + "${path}", changeHistory.value(${pathExpression('child', path)}));`).join('\n');
    if (child.list) {
      lines.push(`        if (entity.get${capital(child.relation)}() != null) {
            for (${child.entity} child : entity.get${capital(child.relation)}()) {
                String prefix = "${child.relation}[" + child.get${capital(child.idField)}() + "].";
${childLines('                ')}
            }
        }`);
    } else {
      lines.push(`        ${child.entity} ${child.relation}Child = entity.get${capital(child.relation)}();
        if (${child.relation}Child != null) {
            ${child.entity} child = ${child.relation}Child;
            String prefix = "${child.relation}.";
${childLines('            ')}
        }`);
    }
  }
  return `    /** Lo que registra el historial de ${entity.name} (DSL 2.29): ruta del contrato → valor del cable. */
    private Map<String, JsonNode> historySnapshot(${entity.name} entity) {
        Map<String, JsonNode> snapshot = new TreeMap<>();
${lines.join('\n')}
        return snapshot;
    }`;
}

/** La línea que escribe una entrada sin cambios (`deleted`, `restored`) para el id `idExpr`. */
export function historyRecordLine(model, entity, change, idExpr, imports, indent = '        ') {
  if (!recordsHistory(entity)) return '';
  imports.add(historyImport(model, 'ChangeHistory'));
  imports.add(historyImport(model, 'HistoryRoots'));
  imports.add('java.util.List');
  return `${indent}changeHistory.record(${rootTypeConstant(entity)}, String.valueOf(${idExpr}), ChangeHistory.${change.toUpperCase()}, List.of());\n`;
}

/** El colaborador que gana el adaptador: `{ field, param, assign }`, o null. */
export function adapterCollaborator(model, entity, imports) {
  if (!recordsHistory(entity)) return null;
  imports.add(historyImport(model, 'ChangeHistory'));
  return { field: '    private final ChangeHistory changeHistory;', param: 'ChangeHistory changeHistory', assign: '        this.changeHistory = changeHistory;' };
}

/**
 * El `save` con historial: la instantánea «antes» se toma de la fila que había, cargada ANTES de que el cuerpo original
 * vuelque el agregado sobre ella (T1: en JPA es la instancia gestionada, la misma que reutiliza el cuerpo), y la entrada
 * se escribe con lo que quedó guardado. `loadPrevious` es la expresión que devuelve el `Optional` del dominio que había.
 */
export function wrapSave(model, entity, { annotations, signature, body, loadPrevious }, imports) {
  const id = entity.idField;
  for (const name of ['java.util.List', 'java.util.Map', 'tools.jackson.databind.JsonNode', historyImport(model, 'ChangeHistory'), historyImport(model, 'FieldChange'), historyImport(model, 'HistoryDiff'), historyImport(model, 'HistoryRoots')]) imports.add(name);
  return [
    `${annotations}
    ${signature} {
        // El historial (DSL 2.29, D1 y T1): lo que había, leído ANTES de volcar el agregado, y lo que quedó guardado.
        Map<String, JsonNode> historyBefore = entity.get${capital(id.name)}() == null ? null : ${loadPrevious}.map(this::historySnapshot).orElse(null);
        ${entity.name} saved = saveUnrecorded(entity);
        recordSave(historyBefore, saved);
        return saved;
    }`,
    `    /** El guardado sin el historial: lo que hacía save antes de la 2.29. Solo lo llama save. */
    private ${entity.name} saveUnrecorded(${entity.name} entity) {
${body}
    }`,
    `    /** La entrada de un guardado (D2): created si no había nada; updated solo si algo cambió. */
    private void recordSave(Map<String, JsonNode> before, ${entity.name} saved) {
        List<FieldChange> changes = HistoryDiff.diff(before, historySnapshot(saved));
        if (before == null) {
            changeHistory.record(${rootTypeConstant(entity)}, String.valueOf(saved.get${capital(id.name)}()), ChangeHistory.CREATED, changes);
        } else if (!changes.isEmpty()) {
            changeHistory.record(${rootTypeConstant(entity)}, String.valueOf(saved.get${capital(id.name)}()), ChangeHistory.UPDATED, changes);
        }
    }`,
    snapshotMethod(model, entity, imports)
  ];
}

// ─── La lectura (D7) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las lecturas del historial de una raíz: una por forma de cargarla. `{ method, by, param, scoped }`: por id (la carga
 * viva del puerto) o, si la query va acotada, por la carga acotada de la ficha (`loadScoped`/`loadScopedBy<Clave>`).
 */
export function historyReadsOf(model, entity) {
  const reads = new Map();
  for (const operation of model.services.flatMap((group) => group.operations)) {
    if (operation.historyOf !== entity.name) continue;
    const load = operation.readScope ? scopedLoadOf(model, operation) : null;
    const by = load?.by === 'key' ? 'key' : 'id';
    const method = by === 'id' ? 'historyOf' : `historyOfBy${capital(load.field)}`;
    if (reads.has(method)) continue;
    const field = by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    reads.set(method, { method, by, load: load?.method ?? 'findById', scoped: Boolean(operation.readScope), param: { name: field.name, javaType: field.javaType, imports: field.imports ?? [] } });
  }
  return [...reads.values()];
}

const readParams = (read) => [`${read.param.javaType} ${read.param.name}`, ...(read.scoped ? ['ReadScope scope'] : []), 'HistoryFilter filter', 'Pageable pageable'].join(', ');

export function historyPortMethods(model, entity, imports) {
  const reads = historyReadsOf(model, entity);
  if (reads.length === 0) return [];
  for (const name of ['java.util.Optional', 'org.springframework.data.domain.Page', 'org.springframework.data.domain.Pageable', historyImport(model, 'HistoryEntry'), historyImport(model, 'HistoryFilter')]) imports.add(name);
  return reads.map((read) => {
    for (const name of read.param.imports) imports.add(name);
    if (read.scoped) imports.add(readScopeImport(model));
    return `    /**
     * El historial de cambios de ${entity.name} (DSL 2.29), la entrada más reciente primero: carga la raíz con la misma
     * lectura que su ficha —viva${read.scoped ? ' y con el alcance del llamante' : ''}— y vacío si no la ve. El filtro y la página
     * los aplica el almacén.
     */
    Optional<Page<HistoryEntry>> ${read.method}(${readParams(read)});`;
  });
}

export function historyAdapterMethods(model, entity, imports) {
  const reads = historyReadsOf(model, entity);
  for (const name of ['java.util.Optional', 'org.springframework.data.domain.Page', 'org.springframework.data.domain.Pageable', historyImport(model, 'HistoryEntry'), historyImport(model, 'HistoryFilter'), historyImport(model, 'HistoryRoots')]) {
    if (reads.length > 0) imports.add(name);
  }
  return reads.map((read) => {
    for (const name of read.param.imports) imports.add(name);
    if (read.scoped) imports.add(readScopeImport(model));
    const load = `${read.load}(${read.param.name}${read.scoped ? ', scope' : ''})`;
    return `    @Override
    public Optional<Page<HistoryEntry>> ${read.method}(${readParams(read)}) {
        // D7: la misma lectura que la ficha; lo que ella no ve, el historial tampoco.
        return ${load}
                .map(root -> changeHistory.page(${rootTypeConstant(entity)}, String.valueOf(root.get${capital(entity.idField.name)}()), filter, pageable));
    }`;
  });
}

// ─── La query ────────────────────────────────────────────────────────────────────────────────────────────────────

/** El tipo que devuelve una query de historial: la página del contrato. */
export const HISTORY_RESPONSE = 'PagedResponse<HistoryEntry>';

/** La nota del handler (la neutral de keel-core), con la llamada en Java. */
export function handlerNote(model, operation) {
  const root = model.entities.find((entity) => entity.name === operation.historyOf);
  if (!root) return null;
  const read = historyReadsOf(model, root).find((candidate) => (operation.readScope ? candidate.scoped : !candidate.scoped)) ?? historyReadsOf(model, root)[0];
  const filters = HISTORY_FILTER_ORDER.map((role) => operation.historyFilters?.[role] ? `query.${operation.historyFilters[role]}()` : 'null');
  const call = `${root.name[0].toLowerCase()}${root.name.slice(1)}Repository.${read.method}(<${read.by === 'id' ? 'su id' : `su ${read.param.name}`}>${read.scoped ? ', query.readScope()' : ''}, new HistoryFilter(${filters.join(', ')}), query.pageable())`;
  return historyNote(operation, { historyCall: call });
}
