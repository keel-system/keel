// Los LOTES ASÍNCRONOS (DSL 2.30: `use-cases.<op>.batch` con `execution: async`) en keel-spring: incremento 6 de
// PLAN-DSL-230-LOTES.md. Lo que decide QUÉ (las tablas y sus sentencias por motor, los estados, el temporizador de cada
// trabajo, la firma de la petición, la forma del trabajo en el cable, los casos BJ-*) es de keel-core (gen/batch.js y
// gen/batch-store.js); aquí solo se escribe en Java:
//
//   · el almacén (`BatchJobStore`): JDBC con las sentencias de keel-core TAL CUAL, más las dos tablas mapeadas solo para
//     el esquema; o MongoDB con la forma documental de keel-core. La purga de lo terminado (D10) es un recurrente más del
//     cronómetro (`BatchJobPurge`, que dispara su `<Tabla>PurgeTimer`);
//   · `BatchJobs`: el alta (D8, D13) y las dos rutas del trabajo, que solo lee quien lo creó (D11). El alta lee el sobre con
//     el MISMO ObjectMapper y el MISMO Validator que el borde —un 400 sin crear ningún trabajo (BJ-9)—, firma los BYTES del
//     cuerpo, resuelve la clave del lote, y crea el trabajo y su temporizador de una vez en UNA transacción: 202 + Location;
//   · `BatchJobRunner`: un disparo del temporizador (D9). Procesa un chunk desde el cursor; cada elemento con su efecto, el
//     avance del cursor (la valla, PRIMERO) y su resultado en UNA transacción. Corre fuera de la transacción del sondeador
//     (`TimerHandler.inTransaction()`), y como el dueño del trabajo: es el actor de autoría de cada elemento;
//   · `<Op>BatchJob`: el `TimerHandler` de cada operación asíncrona, que sabe construir el mensaje de UN elemento.
//
// Lo que no cambia respecto al lote síncrono: el handler procesa UN elemento, cada elemento se lee y valida con BatchRunner
// y su fallo se traduce con ApiExceptionHandler, así que «falla solo su elemento» y «detiene el lote» significan lo mismo.
//
// El lote SÍNCRONO con clave (D15, incremento 10b) usa el mismo almacén, sin temporizador: `KeyedBatches` crea su trabajo,
// procesa cada elemento con los mismos pasos que el procesador (`BatchJobSteps`: efecto, valla y resultado en UNA
// transacción) y responde lo guardado (`batchStoredBody`), así que la primera petición, la repetición y la que reanuda
// responden lo mismo.

import {
  asyncBatchOperations,
  batchJobStoreOperations,
  keyedSyncBatchOperations,
  batchJobPaths,
  BATCH_JOB_PARAM,
  BATCH_ACCEPTED_STATUS
} from '@keel-system/keel-core/gen/batch';
import {
  BATCH_JOB,
  BATCH_ITEM_RESULT,
  BATCH_JOB_COLLECTIONS,
  BATCH_JOB_STATUSES,
  BATCH_PARAMETERS,
  BATCH_STORE_ENGINES,
  BATCH_SYNC_STALE,
  BATCH_ANONYMOUS_OWNER,
  batchKind,
  batchStatements,
  batchSyncStatements
} from '@keel-system/keel-core/gen/batch-store';
import { WRITE_CONFLICT_ATTEMPTS } from '@keel-system/keel-core/gen/transactions';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { idempotencyOutcomeCode } from '@keel-system/keel-core/gen/declared-errors';
import { FRAMEWORK_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { IDEMPOTENCY_HEADER } from '@keel-system/keel-core/gen/request-idempotency';
import { javaFile, javaPath, subPackage } from './render.js';
import { messageComponents, messagePackage } from './services.js';
import { MEDIATOR_PKG, INTERFACES_PKG } from './mediator.js';
import { BATCH_PKG, batchRequestClass, batchDispatch } from './batch.js';
import { domainTypeImport } from './entities.js';

export const BATCH_STORE_PKG = 'infrastructure.persistence.batch';
const TIMER_PKG = 'infrastructure.timer';
const DTO_PKG = 'application.dtos';

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const javaText = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const isDocument = (model) => model.persistenceKind === 'document';
const value = ({ key, default: fallback }) => `@Value("\${${key}:${fallback}}")`;

/** ¿Usa el servicio el almacén de trabajos? Con un lote asíncrono o un lote síncrono con clave (D15). */
export const usesBatchJobs = (model) => Boolean(model.layersPresent?.persistence) && batchJobStoreOperations(model).length > 0;

/** ¿Tiene el servicio algún lote asíncrono? El alta, el procesador y las dos rutas del trabajo. */
const usesAsyncBatchJobs = (model) => usesBatchJobs(model) && asyncBatchOperations(model).length > 0;

/** ¿Tiene el servicio algún lote síncrono con clave (D15)? */
export const usesKeyedBatches = (model) => usesBatchJobs(model) && keyedSyncBatchOperations(model).length > 0;

/** La constante del `kind` del temporizador de los trabajos de una operación, en `TimerKinds`. */
export const batchKindConstant = (operationName) => `BATCH_${constantOf(operationName)}`;

/** Las constantes de `TimerKinds` de los lotes asíncronos (las llama timer.js). */
export function batchTimerKinds(model) {
  return asyncBatchOperations(model).map(
    ({ operation }) => `    /** Los trabajos del lote asíncrono ${operation} (DSL 2.30): un temporizador de UNA VEZ por trabajo. */
    public static final String ${batchKindConstant(operation)} = "${batchKind(operation)}";`
  );
}

/** El bean que purga \`batch_job\` (timer.js lo dispara como recurrente del cronómetro). */
export const BATCH_PURGE_TARGET = { pkg: BATCH_STORE_PKG, className: 'BatchJobPurge' };

/** El `TimerHandler` de los trabajos de una operación. */
export const batchJobClass = (operation) => `${capital(operation.name)}BatchJob`;

/**
 * Lo que un diseño con lotes asíncronos o síncronos con clave no puede generar con este stack, o []: las sentencias son
 * las del cronómetro (PostgreSQL y MySQL, medidas con timer-sql-check) y el documental es MongoDB; el sobre guardado de un
 * lote asíncrono es el CUERPO, así que lo que el mensaje lea de la ruta no viajaría al trabajo.
 */
export function batchJobStackErrors(model) {
  if (batchJobStoreOperations(model).length === 0) return [];
  const errors = [];
  const what = asyncBatchOperations(model).length > 0 ? 'execution: async' : 'idempotency en un lote síncrono';
  if (!model.layersPresent.persistence) {
    errors.push(`use-cases: batch (${what}, DSL 2.30): el trabajo vive en la base del servicio, y este diseño no tiene capa persistence.`);
  } else if (!isDocument(model) && !BATCH_STORE_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `use-cases: batch (${what}, DSL 2.30): el almacén de los trabajos tiene sentencias medidas para ${BATCH_STORE_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores, o declara execution: sync sin idempotency.`
    );
  }
  for (const { operation } of asyncBatchOperations(model)) {
    const op = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === operation);
    if ((op?.pathParams ?? []).length > 0) {
      errors.push(
        `use-cases: ${operation}.batch (execution: async, DSL 2.30): el trabajo guarda el CUERPO de la petición, y su ruta ` +
          `(${op.route.path}) lleva parámetros que no viajarían al procesarlo. Quita los parámetros de la ruta o declara execution: sync.`
      );
    }
    for (const component of messageComponents(model, op ?? { name: operation })) {
      if (component.resolvedIdentity || component.expectedVersions || component.readScope) {
        errors.push(
          `use-cases: ${operation}.batch (execution: async, DSL 2.30): el mensaje lleva '${component.name}', que estampa la ` +
            'petición, y el trabajo se procesa fuera de ella. Declara execution: sync.'
        );
      }
    }
  }
  return errors;
}

export function generate(model) {
  if (!usesBatchJobs(model)) return [];
  const document = isDocument(model);
  const all = model.services.flatMap((service) => service.operations);
  const stored = new Set(batchJobStoreOperations(model).map(({ operation }) => operation));
  const operations = all.filter((operation) => operation.batch?.execution === 'async');
  const files = [
    storeInterface(model),
    document ? mongoStore(model) : jdbcStore(model),
    ...(document ? [] : schemaEntities(model)),
    purge(model),
    steps(model),
    keyReused(model, all.filter((operation) => stored.has(operation.name)))
  ];
  if (usesAsyncBatchJobs(model)) {
    files.push(jobView(model), notFound(model), jobs(model), runner(model), ...operations.map((operation) => jobHandler(model, operation)));
  }
  if (usesKeyedBatches(model)) files.push(inProgress(model, all.filter((operation) => operation.batch && operation.batch.execution !== 'async' && operation.batch.idempotency)), keyedBatches(model));
  return files;
}

// ─── El almacén ──────────────────────────────────────────────────────────────

function storeInterface(model) {
  const keyed = usesKeyedBatches(model)
    ? `

    /**
     * Toma un lote síncrono con clave sin terminar que nadie escribe desde hace más de {@code staleMs} (D15), con la hora
     * de la base. false: sigue en marcha.
     */
    boolean takeOver(UUID id, long staleMs);

    /** Borra un trabajo sin terminar: el de un lote todo o nada con clave que falló, para liberar su clave (D15). */
    boolean discard(UUID id);`
    : '';
  const body = `/**
 * Los trabajos de los lotes (DSL 2.30: los asíncronos y los síncronos con clave) y sus resultados (\`${BATCH_JOB.table}\` y \`${BATCH_ITEM_RESULT.table}\`),
 * detrás de un puerto: las sentencias son las de keel-core, iguales en los cuatro generadores, y toda hora es la de la base.
 *
 * <p>Se une a la transacción en curso: el alta va con el temporizador del trabajo, y el resultado y el avance de cada
 * elemento con su efecto (D9).
 */
public interface BatchJobStore {

    /** Un trabajo, como está en la tabla. {@code nextIndex} es el cursor: todo elemento por debajo tiene su resultado. */
    record Job(UUID id, String operation, String owner, String status, String input, int total, int nextIndex,
            int succeeded, int failed, Instant createdAt, Instant finishedAt) {
    }

    /** El resultado de un elemento intentado, con {@code result} serializado con las reglas del cable. */
    record Result(int index, String status, String errorCode, String message, String result) {
    }

    /** El trabajo vivo de una clave de idempotencia (D13). */
    record KeyHit(UUID id, String signature) {
    }

    /** El trabajo vivo de esa clave: el que la tiene y cuya ventana no pasó. */
    Optional<KeyHit> byKey(String operation, String owner, String key);

    /** Libera la clave si su ventana pasó: el alta siguiente la puede tomar, y el trabajo viejo sigue legible por su id. */
    void releaseKey(String operation, String owner, String key);

    /** Da de alta un trabajo en {@code ${BATCH_JOB_STATUSES.queued}}, con el cursor en 0. {@code ttlMs} null: la clave no caduca. */
    void insert(UUID id, String operation, String owner, String key, String signature, Long ttlMs, String input, int total);

    /** Lo que lee el procesador. */
    Optional<Job> job(UUID id);

    /** Lo que leen las dos rutas (D11): de otro dueño u otra operación es como si no existiera. */
    Optional<Job> owned(UUID id, String operation, String owner);

    /** Avanza el cursor desde {@code index}, con los contadores. false: el cursor ya no estaba ahí (la valla, D9). */
    boolean advance(UUID id, int index, int succeeded, int failed);

    /** El resultado de un elemento. */
    void insertResult(UUID jobId, int index, String status, String errorCode, String message, String result);

    /** Cierra el trabajo (completed o aborted), una sola vez. */
    boolean finish(UUID id, String status);

    /** Los resultados, en orden de índice. */
    List<Result> results(UUID jobId, int limit, long offset);

    long resultsCount(UUID jobId);

    /** La purga (D10): los trabajos terminados hace más de {@code retentionDays}, con sus resultados. Nunca uno en marcha. */
    int purge(int retentionDays);${keyed}
}`;
  return {
    path: javaPath(model, BATCH_STORE_PKG, 'BatchJobStore'),
    content: javaFile(subPackage(model, BATCH_STORE_PKG), ['java.time.Instant', 'java.util.List', 'java.util.Optional', 'java.util.UUID'], body)
  };
}

function jdbcStore(model) {
  const engine = model.stack.database;
  const mysql = engine === 'mysql';
  const keyed = usesKeyedBatches(model);
  const S = { ...batchStatements(engine), ...(keyed ? batchSyncStatements(engine) : {}) };
  const names = ['insertJob', 'byKey', 'releaseKey', 'job', 'ownedJob', 'insertResult', 'advance', 'finish', 'resultsPage', 'resultsCount', 'purgeResults', 'purgeJobs', ...(keyed ? ['takeOver', 'discardJob'] : [])];
  const keyedMethods = keyed
    ? `

    @Override
    public boolean takeOver(UUID id, long staleMs) {
        return jdbc.sql(TAKE_OVER).param("id", uuid(id)).param("staleMs", staleMs).update() == 1;
    }

    @Override
    public boolean discard(UUID id) {
        return jdbc.sql(DISCARD_JOB).param("id", uuid(id)).update() == 1;
    }`
    : '';
  const constants = names.map((name) => `    private static final String ${constantOf(name)} = ${javaText(S[name])};`).join('\n');
  const binding = mysql
    ? `    // MySQL: el uuid es binary(16) (el orden de bytes de Hibernate) y la hora un datetime(6) con la hora UTC.
    private static Object uuid(UUID value) {
        return ByteBuffer.allocate(16).putLong(value.getMostSignificantBits()).putLong(value.getLeastSignificantBits()).array();
    }

    private static UUID readUuid(ResultSet rs, String column) throws SQLException {
        ByteBuffer buffer = ByteBuffer.wrap(rs.getBytes(column));
        return new UUID(buffer.getLong(), buffer.getLong());
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

    private static Instant readTime(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }`;
  const imports = [
    'java.sql.ResultSet',
    'java.sql.SQLException',
    'java.sql.Types',
    'java.time.Instant',
    'java.time.ZoneOffset',
    mysql ? 'java.nio.ByteBuffer' : null,
    mysql ? 'java.time.LocalDateTime' : 'java.time.OffsetDateTime',
    'java.util.List',
    'java.util.Optional',
    'java.util.UUID',
    'javax.sql.DataSource',
    'org.springframework.jdbc.core.SqlParameterValue',
    'org.springframework.jdbc.core.simple.JdbcClient',
    'org.springframework.stereotype.Component'
  ];
  const body = `/**
 * Los trabajos de los lotes sobre ${mysql ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core
 * ({@code batch-store.js}) TAL CUAL: son contrato con los otros generadores, que comparten las tablas, y las mide
 * {@code timer-sql-check} contra el motor. No las reescribas aquí.
 *
 * <p>Va por JDBC sobre el mismo {@code DataSource} que JPA, así que entra en la transacción en curso
 * ({@code JpaTransactionManager} expone su conexión a JDBC): el resultado de un elemento revierte con su efecto.
 */
@Component
public class JdbcBatchJobStore implements BatchJobStore {

${constants}

    private final JdbcClient jdbc;

    public JdbcBatchJobStore(DataSource dataSource) {
        this.jdbc = JdbcClient.create(dataSource);
    }

    @Override
    public Optional<KeyHit> byKey(String operation, String owner, String key) {
        return jdbc.sql(BY_KEY).param("operation", operation).param("owner", owner).param("key", key)
                .query((rs, row) -> new KeyHit(readUuid(rs, "id"), rs.getString("signature")))
                .optional();
    }

    @Override
    public void releaseKey(String operation, String owner, String key) {
        jdbc.sql(RELEASE_KEY).param("operation", operation).param("owner", owner).param("key", key).update();
    }

    @Override
    public void insert(UUID id, String operation, String owner, String key, String signature, Long ttlMs, String input, int total) {
        jdbc.sql(INSERT_JOB)
                .param("id", uuid(id))
                .param("operation", operation)
                .param("owner", owner)
                .param("key", new SqlParameterValue(Types.VARCHAR, key))
                .param("signature", new SqlParameterValue(Types.VARCHAR, signature))
                .param("ttlMs", new SqlParameterValue(Types.BIGINT, ttlMs))
                .param("input", input)
                .param("total", total)
                .update();
    }

    @Override
    public Optional<Job> job(UUID id) {
        return jdbc.sql(JOB).param("id", uuid(id)).query((rs, row) -> readJob(rs)).optional();
    }

    @Override
    public Optional<Job> owned(UUID id, String operation, String owner) {
        return jdbc.sql(OWNED_JOB).param("id", uuid(id)).param("operation", operation).param("owner", owner)
                .query((rs, row) -> readJob(rs))
                .optional();
    }

    @Override
    public boolean advance(UUID id, int index, int succeeded, int failed) {
        return jdbc.sql(ADVANCE).param("id", uuid(id)).param("index", index).param("succeeded", succeeded).param("failed", failed)
                .update() == 1;
    }

    @Override
    public void insertResult(UUID jobId, int index, String status, String errorCode, String message, String result) {
        jdbc.sql(INSERT_RESULT)
                .param("jobId", uuid(jobId))
                .param("index", index)
                .param("status", status)
                .param("errorCode", new SqlParameterValue(Types.VARCHAR, errorCode))
                .param("message", new SqlParameterValue(Types.VARCHAR, message))
                .param("result", new SqlParameterValue(Types.VARCHAR, result))
                .update();
    }

    @Override
    public boolean finish(UUID id, String status) {
        return jdbc.sql(FINISH).param("id", uuid(id)).param("status", status).update() == 1;
    }

    @Override
    public List<Result> results(UUID jobId, int limit, long offset) {
        return jdbc.sql(RESULTS_PAGE).param("jobId", uuid(jobId)).param("limit", limit).param("offset", offset)
                .query((rs, row) -> new Result(rs.getInt("item_index"), rs.getString("status"), rs.getString("error_code"),
                        rs.getString("message"), rs.getString("result")))
                .list();
    }

    @Override
    public long resultsCount(UUID jobId) {
        return jdbc.sql(RESULTS_COUNT).param("jobId", uuid(jobId)).query(Long.class).single();
    }

    @Override
    public int purge(int retentionDays) {
        jdbc.sql(PURGE_RESULTS).param("retentionDays", retentionDays).update();
        return jdbc.sql(PURGE_JOBS).param("retentionDays", retentionDays).update();
    }${keyedMethods}

    /** Una fila del trabajo, con las columnas que leen el procesador y las rutas. */
    private static Job readJob(ResultSet rs) throws SQLException {
        return new Job(readUuid(rs, "id"), rs.getString("operation"), rs.getString("owner"), rs.getString("status"),
                rs.getString("input"), rs.getInt("total"), rs.getInt("next_index"), rs.getInt("succeeded"), rs.getInt("failed"),
                readTime(rs, "created_at"), readTime(rs, "finished_at"));
    }

${binding}
}`;
  return { path: javaPath(model, BATCH_STORE_PKG, 'JdbcBatchJobStore'), content: javaFile(subPackage(model, BATCH_STORE_PKG), imports, body) };
}

const lengthOf = (table, name) => table.columns.find((column) => column.name === name).length;

function schemaEntities(model) {
  const unique = BATCH_JOB.uniques[0];
  const index = BATCH_JOB.indexes[0];
  const column = (table, spec) => {
    const type = { uuid: 'UUID', string: 'String', text: 'String', int: 'Integer', timestamp: 'Instant' }[spec.base];
    const attributes = [`name = "${spec.name}"`];
    if (!spec.nullable) attributes.push('nullable = false');
    if (spec.base === 'string') attributes.push(`length = ${lengthOf(table, spec.name)}`);
    if (spec.base === 'text') attributes.push('columnDefinition = "text"');
    const field = spec.name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    return `${spec.primary ? '    @Id\n' : ''}    @Column(${attributes.join(', ')})\n    private ${type} ${field};`;
  };
  const job = `/**
 * La tabla de los trabajos de los lotes asíncronos (DSL 2.30), mapeada SOLO para el esquema: así la crea Hibernate en
 * \`local\` y \`test\`, la valida en \`develop\` y \`production\`, y entra en el baseline que exporta el agente (o en el paso
 * de esquema de build, si la base ya está desplegada). Nadie la lee por JPA: la usa {@code JdbcBatchJobStore}, con las
 * sentencias de keel-core.
 *
 * <p>Columnas, unicidad e índice son los de keel-core ({@code BATCH_JOB}): los comparten los cuatro generadores.
 */
@Entity
@Table(name = "${BATCH_JOB.table}",
        uniqueConstraints = @UniqueConstraint(name = "${unique.name}", columnNames = {${unique.columns.map((name) => `"${name}"`).join(', ')}}),
        indexes = @Index(name = "${index.name}", columnList = "${index.columns.join(', ')}"))
public class BatchJobJpa {

${BATCH_JOB.columns.map((spec) => column(BATCH_JOB, spec)).join('\n\n')}

    protected BatchJobJpa() {
    }
}`;
  const fk = BATCH_ITEM_RESULT.columns.find((spec) => spec.references).references;
  const result = `/**
 * Un resultado por elemento intentado de un trabajo (DSL 2.30, D10), mapeado solo para el esquema, como
 * {@link BatchJobJpa}; se va con su trabajo (ON DELETE CASCADE).
 */
@Entity
@Table(name = "${BATCH_ITEM_RESULT.table}")
@IdClass(BatchItemResultJpa.Key.class)
public class BatchItemResultJpa {

    @Id
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "job_id", nullable = false, foreignKey = @ForeignKey(name = "${fk.name}"))
    @OnDelete(action = OnDeleteAction.CASCADE)
    private BatchJobJpa job;

${BATCH_ITEM_RESULT.columns.filter((spec) => spec.name !== 'job_id').map((spec) => column(BATCH_ITEM_RESULT, spec)).join('\n\n')}

    protected BatchItemResultJpa() {
    }

    /** La clave compuesta (job_id, item_index). */
    public static class Key implements Serializable {

        private UUID job;
        private Integer itemIndex;

        public Key() {
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Key key && Objects.equals(job, key.job) && Objects.equals(itemIndex, key.itemIndex);
        }

        @Override
        public int hashCode() {
            return Objects.hash(job, itemIndex);
        }
    }
}`;
  const pkg = subPackage(model, BATCH_STORE_PKG);
  return [
    {
      path: javaPath(model, BATCH_STORE_PKG, 'BatchJobJpa'),
      content: javaFile(
        pkg,
        ['jakarta.persistence.Column', 'jakarta.persistence.Entity', 'jakarta.persistence.Id', 'jakarta.persistence.Index', 'jakarta.persistence.Table', 'jakarta.persistence.UniqueConstraint', 'java.time.Instant', 'java.util.UUID'],
        job
      )
    },
    {
      path: javaPath(model, BATCH_STORE_PKG, 'BatchItemResultJpa'),
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
        result
      )
    }
  ];
}

function mongoStore(model) {
  const { job, result } = BATCH_JOB_COLLECTIONS;
  const keyedMethods = usesKeyedBatches(model)
    ? `

    @Override
    public boolean takeOver(UUID id, long staleMs) {
        Instant now = timers.dbNow();
        Query dead = new Query(Criteria.where("_id").is(id.toString()).and("finished_at").is(null).and("updated_at").lte(Date.from(now.minusMillis(staleMs))));
        return mongo.updateFirst(dead, new Update().set("updated_at", Date.from(now)), JOBS).getModifiedCount() == 1;
    }

    @Override
    public boolean discard(UUID id) {
        Query open = new Query(Criteria.where("_id").is(id.toString()).and("finished_at").is(null));
        if (mongo.remove(open, JOBS).getDeletedCount() != 1) {
            return false;
        }
        mongo.remove(new Query(Criteria.where("job_id").is(id.toString())), RESULTS);
        return true;
    }`
    : '';
  const indexLine = (collection, spec) => {
    const keys = spec.keys.map(([key, direction]) => `\n                .on("${key}", Sort.Direction.${direction > 0 ? 'ASC' : 'DESC'})`).join('');
    const unique = spec.unique ? '\n                .unique()' : '';
    const partial = spec.partialFilter
      ? `\n                .partial(PartialIndexFilter.of(new Document("${Object.keys(spec.partialFilter)[0]}", new Document("$type", "${Object.values(spec.partialFilter)[0].$type}"))))`
      : '';
    return `        mongo.indexOps(${collection}).createIndex(new Index()${keys}${unique}${partial}
                .named("${spec.name}"));`;
  };
  const imports = [
    'jakarta.annotation.PostConstruct',
    'java.time.Instant',
    'java.time.temporal.ChronoUnit',
    'java.util.Date',
    'java.util.List',
    'java.util.Optional',
    'java.util.UUID',
    'org.bson.Document',
    'org.springframework.data.domain.Sort',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'org.springframework.data.mongodb.core.index.Index',
    'org.springframework.data.mongodb.core.index.PartialIndexFilter',
    'org.springframework.data.mongodb.core.query.Criteria',
    'org.springframework.data.mongodb.core.query.Query',
    'org.springframework.data.mongodb.core.query.Update',
    'org.springframework.stereotype.Component',
    `${subPackage(model, TIMER_PKG)}.TimerStore`
  ];
  const body = `/**
 * Los trabajos de los lotes sobre MongoDB, con la forma documental de keel-core
 * ({@code BATCH_JOB_COLLECTIONS}): los nombres de campo son los de las columnas, el trabajo lleva su id (texto) en
 * {@code _id} y cada resultado la clave aplanada {@code <job>|<índice>}, que hace que el motor rechace un segundo resultado
 * del mismo elemento. La unicidad de la clave de idempotencia es PARCIAL: en MongoDB dos ausentes sí chocan.
 *
 * <p>Va por {@link MongoTemplate}, que se une a la transacción en curso ({@code MongoTransactionManager}). La hora es la
 * del cronómetro ({@link TimerStore#dbNow()}), la misma que compara el resto del servicio.
 */
@Component
public class MongoBatchJobStore implements BatchJobStore {

    private static final String JOBS = "${job.collection}";

    private static final String RESULTS = "${result.collection}";

    private final MongoTemplate mongo;
    private final TimerStore timers;

    public MongoBatchJobStore(MongoTemplate mongo, TimerStore timers) {
        this.mongo = mongo;
        this.timers = timers;
    }

    /** Los índices de keel-core, idempotentes en cada arranque. */
    @PostConstruct
    void ensureIndexes() {
${job.indexes.map((spec) => indexLine('JOBS', spec)).join('\n')}
${result.indexes.map((spec) => indexLine('RESULTS', spec)).join('\n')}
    }

    private Criteria ofKey(String operation, String owner, String key) {
        return Criteria.where("operation").is(operation).and("owner").is(owner).and("idempotency_key").is(key);
    }

    @Override
    public Optional<KeyHit> byKey(String operation, String owner, String key) {
        Date now = Date.from(timers.dbNow());
        Criteria live = new Criteria().orOperator(Criteria.where("key_expires_at").is(null), Criteria.where("key_expires_at").gt(now));
        Document found = mongo.findOne(new Query(new Criteria().andOperator(ofKey(operation, owner, key), live)), Document.class, JOBS);
        return Optional.ofNullable(found).map(document -> new KeyHit(UUID.fromString(document.getString("_id")), document.getString("signature")));
    }

    @Override
    public void releaseKey(String operation, String owner, String key) {
        Date now = Date.from(timers.dbNow());
        mongo.updateMulti(new Query(ofKey(operation, owner, key).and("key_expires_at").lte(now)), new Update().unset("idempotency_key"), JOBS);
    }

    @Override
    public void insert(UUID id, String operation, String owner, String key, String signature, Long ttlMs, String input, int total) {
        Instant now = timers.dbNow();
        Document document = new Document("_id", id.toString())
                .append("operation", operation)
                .append("owner", owner)
                .append("status", "${BATCH_JOB_STATUSES.queued}")
                .append("signature", signature)
                .append("key_expires_at", ttlMs == null ? null : Date.from(now.plusMillis(ttlMs)))
                .append("input", input)
                .append("total", total)
                .append("next_index", 0)
                .append("succeeded", 0)
                .append("failed", 0)
                .append("created_at", Date.from(now))
                .append("updated_at", Date.from(now))
                .append("finished_at", null);
        // Sin clave el campo no existe: el índice parcial solo mira los trabajos que tienen una.
        if (key != null) {
            document.append("idempotency_key", key);
        }
        mongo.insert(document, JOBS);
    }

    @Override
    public Optional<Job> job(UUID id) {
        return Optional.ofNullable(mongo.findOne(new Query(Criteria.where("_id").is(id.toString())), Document.class, JOBS)).map(MongoBatchJobStore::readJob);
    }

    @Override
    public Optional<Job> owned(UUID id, String operation, String owner) {
        Query query = new Query(Criteria.where("_id").is(id.toString()).and("operation").is(operation).and("owner").is(owner));
        return Optional.ofNullable(mongo.findOne(query, Document.class, JOBS)).map(MongoBatchJobStore::readJob);
    }

    @Override
    public boolean advance(UUID id, int index, int succeeded, int failed) {
        Query fence = new Query(Criteria.where("_id").is(id.toString()).and("next_index").is(index));
        Update update = new Update().inc("next_index", 1).inc("succeeded", succeeded).inc("failed", failed)
                .set("status", "${BATCH_JOB_STATUSES.running}").set("updated_at", Date.from(timers.dbNow()));
        return mongo.updateFirst(fence, update, JOBS).getModifiedCount() == 1;
    }

    @Override
    public void insertResult(UUID jobId, int index, String status, String errorCode, String message, String result) {
        mongo.insert(new Document("_id", jobId + "|" + index)
                .append("job_id", jobId.toString())
                .append("item_index", index)
                .append("status", status)
                .append("error_code", errorCode)
                .append("message", message)
                .append("result", result), RESULTS);
    }

    @Override
    public boolean finish(UUID id, String status) {
        Date now = Date.from(timers.dbNow());
        Query open = new Query(Criteria.where("_id").is(id.toString()).and("finished_at").is(null));
        return mongo.updateFirst(open, new Update().set("status", status).set("finished_at", now).set("updated_at", now), JOBS).getModifiedCount() == 1;
    }

    @Override
    public List<Result> results(UUID jobId, int limit, long offset) {
        Query query = new Query(Criteria.where("job_id").is(jobId.toString())).with(Sort.by("item_index")).skip(offset).limit(limit);
        return mongo.find(query, Document.class, RESULTS).stream()
                .map(document -> new Result(document.getInteger("item_index"), document.getString("status"), document.getString("error_code"),
                        document.getString("message"), document.getString("result")))
                .toList();
    }

    @Override
    public long resultsCount(UUID jobId) {
        return mongo.count(new Query(Criteria.where("job_id").is(jobId.toString())), RESULTS);
    }

    @Override
    public int purge(int retentionDays) {
        Date before = Date.from(timers.dbNow().minus(retentionDays, ChronoUnit.DAYS));
        Query finished = new Query(Criteria.where("finished_at").ne(null).lt(before));
        List<String> ids = mongo.find(finished, Document.class, JOBS).stream().map(document -> document.getString("_id")).toList();
        if (ids.isEmpty()) {
            return 0;
        }
        mongo.remove(new Query(Criteria.where("job_id").in(ids)), RESULTS);
        return (int) mongo.remove(new Query(Criteria.where("_id").in(ids)), JOBS).getDeletedCount();
    }${keyedMethods}

    private static Job readJob(Document document) {
        Date finished = document.getDate("finished_at");
        return new Job(UUID.fromString(document.getString("_id")), document.getString("operation"), document.getString("owner"),
                document.getString("status"), document.getString("input"), document.getInteger("total"), document.getInteger("next_index"),
                document.getInteger("succeeded"), document.getInteger("failed"), document.getDate("created_at").toInstant(),
                finished == null ? null : finished.toInstant());
    }
}`;
  return { path: javaPath(model, BATCH_STORE_PKG, 'MongoBatchJobStore'), content: javaFile(subPackage(model, BATCH_STORE_PKG), imports, body) };
}

function purge(model) {
  const body = `/**
 * La purga de los trabajos terminados de los lotes asíncronos (DSL 2.30, D10): los que acabaron hace más de
 * {@code ${BATCH_PARAMETERS.retentionDays.key}} días, con sus resultados. Un trabajo en marcha no se purga nunca. La
 * dispara el cronómetro como recurrente en modo clúster ({@code ${BATCH_PARAMETERS.purgeCron.key}}).
 */
@Component
public class BatchJobPurge {

    private final BatchJobStore store;

    ${value(BATCH_PARAMETERS.retentionDays)}
    private int retentionDays;

    public BatchJobPurge(BatchJobStore store) {
        this.store = store;
    }

    public int purge() {
        return store.purge(retentionDays);
    }
}`;
  return {
    path: javaPath(model, BATCH_STORE_PKG, 'BatchJobPurge'),
    content: javaFile(subPackage(model, BATCH_STORE_PKG), ['org.springframework.beans.factory.annotation.Value', 'org.springframework.stereotype.Component'], body)
  };
}

// ─── El trabajo en el cable y sus errores ────────────────────────────────────

function jobView(model) {
  const body = `/**
 * El trabajo de un lote asíncrono en el cable (DSL 2.30, wire-contract.md § Lotes asíncronos): su estado y su resumen.
 * {@code notAttempted} solo cuenta en un trabajo {@code ${BATCH_JOB_STATUSES.aborted}}: lo que queda por procesar de uno en
 * marcha no se ha intentado todavía, pero tampoco se ha descartado ({@code batchJobView} de keel-core).
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record BatchJobView(UUID id, String status, BatchResponse.Summary summary, Instant createdAt, Instant finishedAt) {

    public static BatchJobView of(BatchJobStore.Job job) {
        int notAttempted = "${BATCH_JOB_STATUSES.aborted}".equals(job.status()) ? job.total() - job.nextIndex() : 0;
        return new BatchJobView(job.id(), job.status(),
                new BatchResponse.Summary(job.total(), job.succeeded(), job.failed(), notAttempted), job.createdAt(), job.finishedAt());
    }
}`;
  return {
    path: javaPath(model, BATCH_PKG, 'BatchJobView'),
    content: javaFile(
      subPackage(model, BATCH_PKG),
      ['com.fasterxml.jackson.annotation.JsonInclude', 'java.time.Instant', 'java.util.UUID', `${subPackage(model, BATCH_STORE_PKG)}.BatchJobStore`],
      body
    )
  };
}

function notFound(model) {
  const { code, http } = FRAMEWORK_ERRORS.batchJobNotFound;
  const body = `/**
 * El trabajo de un lote asíncrono que no existe, que ya se purgó o que creó OTRO llamante (DSL 2.30, D11): los tres casos
 * responden igual, para no decirle a nadie que un trabajo ajeno existe. Su code es del framework
 * (docs/framework-errors.md) y no se sustituye.
 */
public class BatchJobNotFoundException extends NotFoundException {

    public BatchJobNotFoundException(UUID jobId) {
        super("No hay ningún trabajo " + jobId, "${code}", ${http}, new Object[] {jobId});
    }
}`;
  return {
    path: javaPath(model, BATCH_PKG, 'BatchJobNotFoundException'),
    content: javaFile(subPackage(model, BATCH_PKG), ['java.util.UUID', `${subPackage(model, 'domain.errors')}.NotFoundException`], body)
  };
}

function keyReused(model, operations) {
  const canonical = FRAMEWORK_ERRORS.idempotencyReuse;
  const codes = operations.map((operation) => `"${operation.name}", "${idempotencyOutcomeCode(model, operation.name, canonical)}"`);
  const body = `/**
 * La misma clave de idempotencia de un lote con un contenido DISTINTO (DSL 2.30, D13 y D15): no es un reintento, y
 * devolver la respuesta de la primera petición contestaría a una pregunta que el cliente no hizo. El code es el que declara
 * cada operación para este desenlace, o el canónico (docs/framework-errors.md).
 */
public class BatchJobKeyReusedException extends ConflictException {

    private static final Map<String, String> CODES = Map.of(${codes.join(', ')});

    public BatchJobKeyReusedException(String operation, String key) {
        super("La clave de idempotencia " + operation + "/" + key + " ya se usó con un contenido distinto",
                CODES.getOrDefault(operation, "${canonical.code}"), ${canonical.http}, new Object[] {operation, key});
    }
}`;
  return {
    path: javaPath(model, BATCH_PKG, 'BatchJobKeyReusedException'),
    content: javaFile(subPackage(model, BATCH_PKG), ['java.util.Map', `${subPackage(model, 'domain.errors')}.ConflictException`], body)
  };
}

// ─── El alta y las dos rutas ─────────────────────────────────────────────────

function jobs(model) {
  const imports = [
    `${subPackage(model, BATCH_STORE_PKG)}.BatchJobStore`,
    `${subPackage(model, TIMER_PKG)}.TimerStore`,
    `${subPackage(model, 'domain.identity')}.Uuids`,
    `${subPackage(model, DTO_PKG)}.PagedResponse`,
    'java.net.URI',
    'java.nio.charset.StandardCharsets',
    'java.util.List',
    'java.util.Optional',
    'java.util.UUID',
    'org.springframework.dao.DataIntegrityViolationException',
    'org.springframework.data.domain.AuditorAware',
    'org.springframework.data.domain.PageImpl',
    'org.springframework.data.domain.Pageable',
    'org.springframework.http.ResponseEntity',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.support.TransactionTemplate',
    'org.springframework.web.servlet.support.ServletUriComponentsBuilder',
    'tools.jackson.databind.JsonNode'
  ];
  const body = `/**
 * Los lotes asíncronos (DSL 2.30, fase B) vistos desde la API: el alta del trabajo y las dos rutas que lo leen.
 *
 * <p>El alta (D8) no procesa nada: lee el sobre con el ObjectMapper y el Validator del borde (un sobre mal formado es un
 * 400 sin trabajo, BJ-9), resuelve la clave del lote (D13) y crea el trabajo y su temporizador de una vez en UNA
 * transacción. Responde ${BATCH_ACCEPTED_STATUS} con el trabajo y su URL en Location.
 *
 * <p>Solo lee un trabajo quien lo creó (D11): el dueño es el actor de autoría de la petición, y lo ajeno, lo purgado y lo
 * inexistente responden igual, ${FRAMEWORK_ERRORS.batchJobNotFound.code}.
 *
 * <p>No lo edites: lo regenera build.
 */
@Component
public class BatchJobs {

    /**
     * Intentos del alta cuando el motor la mata por INTERBLOQUEO. En MySQL (InnoDB), el UPDATE de releaseKey sobre una clave
     * que aún no existe toma un bloqueo de hueco en el índice único: dos altas con la misma clave lo toman las dos, el
     * INSERT de cada una espera al de la otra y el motor aborta a una. Repetida, su releaseKey espera al registro de la
     * ganadora hasta que confirma y la encuentra, como la que pierde en PostgreSQL por la unicidad.
     */
    private static final int KEY_RACE_ATTEMPTS = ${WRITE_CONFLICT_ATTEMPTS};

    /** El alta: el trabajo, recién creado o el de la misma clave, y si hay que arrancarlo. */
    private record Accepted(UUID id) {
    }

    private final BatchJobStore store;
    private final TimerStore timers;
    private final BatchJobSteps steps;
    private final AuditorAware<String> auditor;
    private final TransactionTemplate transaction;

    public BatchJobs(BatchJobStore store, TimerStore timers, BatchJobSteps steps, AuditorAware<String> auditor,
            PlatformTransactionManager transactionManager) {
        this.store = store;
        this.timers = timers;
        this.steps = steps;
        this.auditor = auditor;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /**
     * El alta de un trabajo. {@code body} son los BYTES del cuerpo tal como llegaron: la firma de la petición es su sha256
     * (D13) y el trabajo los guarda para leer cada elemento al procesarlo. {@code clientKey} es la cabecera
     * ${IDEMPOTENCY_HEADER} (null si no llega o si la clave es el contenido); {@code ttlSeconds}, la ventana de la clave.
     */
    public <R> ResponseEntity<BatchJobView> submit(String operation, String kind, byte[] body, Class<R> requestType,
            java.util.function.Function<R, List<JsonNode>> itemsOf, String keySource, String clientKey, Long ttlSeconds) {
        R request = steps.readEnvelope(body, requestType);
        int total = itemsOf.apply(request).size();
        String owner = owner();
        String signature = BatchJobSteps.signature(body);
        String key = "payload-hash".equals(keySource) ? signature : clientKey;
        Long ttlMs = key == null || ttlSeconds == null ? null : ttlSeconds * 1000L;
        String input = new String(body, StandardCharsets.UTF_8);
        Accepted accepted = null;
        for (int attempt = 1; accepted == null; attempt++) {
            try {
                accepted = transaction.execute(status -> accept(operation, kind, owner, key, signature, ttlMs, input, total));
            } catch (DataIntegrityViolationException race) {
                // Dos altas con la misma clave a la vez: la que pierde espera a la ganadora en la unicidad del motor y responde
                // su trabajo, sin el 409 «en curso» (D13).
                accepted = transaction.execute(status -> repeat(operation, owner, key, signature).orElseThrow(() -> race));
            } catch (RuntimeException conflict) {
                // Perdió la carrera de la clave sin llegar a la unicidad (el interbloqueo de MySQL): se repite el alta entera,
                // que ahora espera a la otra y responde su trabajo.
                if (key == null || !BatchJobSteps.lostKeyRace(conflict) || attempt >= KEY_RACE_ATTEMPTS) {
                    throw conflict;
                }
            }
        }
        BatchJobView view = BatchJobView.of(store.job(accepted.id()).orElseThrow());
        URI location = ServletUriComponentsBuilder.fromCurrentRequest().path("/jobs/{${BATCH_JOB_PARAM}}").buildAndExpand(accepted.id()).toUri();
        return ResponseEntity.accepted().location(location).body(view);
    }

    private Accepted accept(String operation, String kind, String owner, String key, String signature, Long ttlMs, String input, int total) {
        if (key != null) {
            store.releaseKey(operation, owner, key);
            Optional<Accepted> same = repeat(operation, owner, key, signature);
            if (same.isPresent()) {
                return same.get();
            }
        }
        UUID id = Uuids.v7();
        store.insert(id, operation, owner, key, signature, ttlMs, input, total);
        // El temporizador de UNA vez del trabajo, para ya: lo reclama el cronómetro con su arriendo y su valla.
        timers.arm(kind, id, timers.dbNow());
        return new Accepted(id);
    }

    /** El trabajo vivo de la clave (D13): el mismo si la firma casa, IDEMPOTENCY_KEY_REUSED si no. */
    private Optional<Accepted> repeat(String operation, String owner, String key, String signature) {
        if (key == null) {
            return Optional.empty();
        }
        return store.byKey(operation, owner, key).map(hit -> {
            if (!hit.signature().equals(signature)) {
                throw new BatchJobKeyReusedException(operation, key);
            }
            return new Accepted(hit.id());
        });
    }

    /** El trabajo, si es de quien llama. */
    public BatchJobView status(String operation, UUID jobId) {
        return BatchJobView.of(owned(operation, jobId));
    }

    /** Los resultados de los elementos intentados, en orden de índice, con el sobre de página del cable. */
    public PagedResponse<BatchResponse.Item> results(String operation, UUID jobId, Pageable pageable) {
        BatchJobStore.Job job = owned(operation, jobId);
        List<BatchResponse.Item> items = store.results(job.id(), pageable.getPageSize(), pageable.getOffset()).stream()
                .map(steps::item)
                .toList();
        return PagedResponse.from(new PageImpl<>(items, pageable, store.resultsCount(job.id())));
    }

    private BatchJobStore.Job owned(String operation, UUID jobId) {
        return store.owned(jobId, operation, owner()).orElseThrow(() -> new BatchJobNotFoundException(jobId));
    }

    /** El dueño: el actor de autoría de la petición (el sujeto del token). */
    private String owner() {
        return auditor.getCurrentAuditor().orElseThrow();
    }
}`;
  return { path: javaPath(model, BATCH_PKG, 'BatchJobs'), content: javaFile(subPackage(model, BATCH_PKG), imports, body) };
}

// ─── El procesador ───────────────────────────────────────────────────────────

/** Cómo se pone el dueño del trabajo como actor de las escrituras, según el protocolo de la capa security. */
function ownerAuthentication(model) {
  const jwt = model.security?.protocol === 'oidc' || model.security?.protocol === 'jwt';
  return jwt
    ? {
        imports: ['org.springframework.security.oauth2.jwt.Jwt', 'org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken'],
        expr: 'new JwtAuthenticationToken(Jwt.withTokenValue("batch-job").header("alg", "none").subject(owner).build())'
      }
    : {
        imports: ['org.springframework.security.authentication.UsernamePasswordAuthenticationToken'],
        expr: 'UsernamePasswordAuthenticationToken.authenticated(owner, null, List.of())'
      };
}

function runner(model) {
  const auth = ownerAuthentication(model);
  const { completed, aborted } = BATCH_JOB_STATUSES;
  const imports = [
    `${subPackage(model, BATCH_STORE_PKG)}.BatchJobStore`,
    `${subPackage(model, TIMER_PKG)}.ClaimedTimer`,
    `${subPackage(model, TIMER_PKG)}.TimerOutcome`,
    `${subPackage(model, TIMER_PKG)}.TimerStore`,
    ...auth.imports,
    'java.util.List',
    'java.util.Set',
    'java.util.function.Function',
    'java.util.function.Supplier',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.security.core.context.SecurityContext',
    'org.springframework.security.core.context.SecurityContextHolder',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.support.TransactionTemplate',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper'
  ];
  const body = `/**
 * Un disparo del temporizador de un trabajo (DSL 2.30, D9): procesa un CHUNK desde el cursor y dice si queda trabajo
 * (rearmar para ya) o si terminó (borrar el temporizador). Es el *commit interval* y el *restart* de Spring Batch sobre el
 * cronómetro, sin la librería.
 *
 * <p>Cada elemento va en UNA transacción con tres cosas: su efecto (el despacho por el mediator, que se une a ella), el
 * avance del cursor y su resultado. El avance es la VALLA: solo avanza si el cursor sigue donde lo dejó este disparo, y si
 * no —otra réplica le quitó el trabajo al vencer su arriendo— el elemento revierte entero, efecto incluido. Si la réplica
 * cae a mitad de chunk, lo confirmado queda y el siguiente disparo sigue desde el cursor: ningún elemento se aplica dos
 * veces ni se queda sin resultado.
 *
 * <p>Fallan solo su elemento los codes de {@code itemErrors} y ${FRAMEWORK_ERRORS.validation.code}; cualquier otro fallo
 * detiene el trabajo ({@code ${aborted}}, D4) con su code o ${FRAMEWORK_ERRORS.batchAborted.code}. Corre sin token: el
 * actor de autoría de cada elemento es el dueño del trabajo.
 *
 * <p>No lo edites: lo regenera build.
 */
@Component
public class BatchJobRunner {

    private final BatchJobStore store;
    private final TimerStore timers;
    private final BatchJobSteps steps;
    private final ObjectMapper mapper;
    private final TransactionTemplate transaction;
    private final int chunkSize;

    @Autowired
    public BatchJobRunner(BatchJobStore store, TimerStore timers, BatchJobSteps steps, ObjectMapper mapper,
            PlatformTransactionManager transactionManager, ${value(BATCH_PARAMETERS.chunkSize)} int chunkSize) {
        this.store = store;
        this.timers = timers;
        this.steps = steps;
        this.mapper = mapper;
        this.transaction = new TransactionTemplate(transactionManager);
        this.chunkSize = chunkSize;
    }

    /**
     * Un disparo. {@code itemsOf} saca del sobre guardado la lista que se recorre; {@code process} despacha UN elemento con
     * el resto del sobre y devuelve su result (null si la operación no declara batch.output).
     */
    public <R, T> TimerOutcome runChunk(ClaimedTimer timer, Class<R> requestType, Function<R, List<JsonNode>> itemsOf, Class<T> itemType,
            Set<String> itemErrors, java.util.function.BiFunction<R, T, Object> process) {
        BatchJobStore.Job job = store.job(timer.entityId()).orElse(null);
        if (job == null || job.finishedAt() != null) {
            return TimerOutcome.finished();
        }
        R request = mapper.readValue(job.input(), requestType);
        List<JsonNode> nodes = itemsOf.apply(request);
        return asOwner(job.owner(), () -> {
            int index = job.nextIndex();
            int end = Math.min(job.total(), index + chunkSize);
            for (; index < end; index++) {
                if (steps.process(job.id(), index, nodes.get(index), itemType, itemErrors, item -> process.apply(request, item)) != BatchJobSteps.Step.NEXT) {
                    return TimerOutcome.finished();
                }
            }
            if (index >= job.total()) {
                transaction.executeWithoutResult(status -> store.finish(job.id(), "${completed}"));
                return TimerOutcome.finished();
            }
            return TimerOutcome.rescheduleAt(timers.dbNow());
        });
    }

    /** El disparo corre como el dueño del trabajo: el actor de autoría de cada elemento (el trabajo no tiene token). */
    private static TimerOutcome asOwner(String owner, Supplier<TimerOutcome> work) {
        SecurityContext previous = SecurityContextHolder.getContext();
        SecurityContext context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(${auth.expr});
        SecurityContextHolder.setContext(context);
        try {
            return work.get();
        } finally {
            SecurityContextHolder.setContext(previous);
        }
    }
}`;
  return { path: javaPath(model, BATCH_PKG, 'BatchJobRunner'), content: javaFile(subPackage(model, BATCH_PKG), imports, body) };
}

// ─── El temporizador de cada operación ───────────────────────────────────────

function jobHandler(model, operation) {
  const batch = operation.batch;
  const className = batchJobClass(operation);
  const imports = new Set([
    `${subPackage(model, TIMER_PKG)}.ClaimedTimer`,
    `${subPackage(model, TIMER_PKG)}.TimerHandler`,
    `${subPackage(model, TIMER_PKG)}.TimerKinds`,
    `${subPackage(model, TIMER_PKG)}.TimerOutcome`,
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`,
    `${subPackage(model, messagePackage(operation))}.${operation.messageClass}`,
    'java.time.Instant',
    'java.util.Set',
    'org.springframework.stereotype.Component'
  ]);
  const itemField = operation.bodyFields.find((field) => field.name === batch.over);
  const typeImport = domainTypeImport(model, itemField);
  if (typeImport) imports.add(typeImport);
  const args = messageComponents(model, operation).map((component) => {
    if (component.batchItem) return 'item';
    if (component.entryGate) {
      imports.add(`${subPackage(model, INTERFACES_PKG)}.EntryGate`);
      return 'EntryGate.HTTP';
    }
    return `request.${component.name}()`;
  });
  const message = `new ${operation.messageClass}(${args.join(', ')})`;
  const dispatch =
    batch.resultFields.length > 0
      ? `(request, item) -> mediator.dispatch(${message})`
      : `(request, item) -> {\n                    mediator.dispatch(${message});\n                    return null;\n                }`;
  const errors = batch.itemErrors.map(javaText).join(', ');
  const body = `/**
 * Los trabajos del lote asíncrono ${operation.name} (DSL 2.30): un temporizador de UNA vez por trabajo
 * ({@code ${batchKind(operation.name)}}), y cada disparo procesa un chunk ({@link BatchJobRunner}). Corre FUERA de la
 * transacción del sondeador: cada elemento abre la suya.
 *
 * <p>No lo edites: lo regenera build.
 */
@Component
public class ${className} implements TimerHandler {

    private final BatchJobRunner runner;
    private final UseCaseMediator mediator;

    public ${className}(BatchJobRunner runner, UseCaseMediator mediator) {
        this.runner = runner;
        this.mediator = mediator;
    }

    @Override
    public String kind() {
        return TimerKinds.${batchKindConstant(operation.name)};
    }

    @Override
    public boolean inTransaction() {
        return false;
    }

    @Override
    public TimerOutcome handle(ClaimedTimer timer, Instant dbNow) {
        return runner.runChunk(timer, ${batchRequestClass(operation)}.class, ${batchRequestClass(operation)}::${batch.over}, ${batch.itemType}.class,
                Set.of(${errors}),
                ${dispatch});
    }
}`;
  return { path: javaPath(model, BATCH_PKG, className), content: javaFile(subPackage(model, BATCH_PKG), [...imports], body) };
}

// ─── Los pasos de un elemento ────────────────────────────────────────────────

function steps(model) {
  const { aborted } = BATCH_JOB_STATUSES;
  const document = isDocument(model);
  const imports = [
    document ? 'com.mongodb.MongoException' : 'org.springframework.dao.PessimisticLockingFailureException',
    `${subPackage(model, BATCH_STORE_PKG)}.BatchJobStore`,
    'jakarta.validation.ConstraintViolation',
    'jakarta.validation.ConstraintViolationException',
    'jakarta.validation.Validator',
    'java.io.ByteArrayInputStream',
    'java.io.InputStream',
    'java.security.MessageDigest',
    'java.security.NoSuchAlgorithmException',
    'java.util.ArrayList',
    'java.util.HexFormat',
    'java.util.List',
    'java.util.Set',
    'java.util.UUID',
    'java.util.function.Function',
    'org.springframework.http.HttpHeaders',
    'org.springframework.http.HttpInputMessage',
    'org.springframework.http.converter.HttpMessageNotReadableException',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.TransactionStatus',
    'org.springframework.transaction.support.TransactionTemplate',
    'tools.jackson.core.JacksonException',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.ObjectMapper'
  ];
  const body = `/**
 * Lo que comparten el procesador de los lotes asíncronos y los lotes síncronos con clave (DSL 2.30, D9 y D15): leer el
 * sobre como el borde, firmarlo, procesar UN elemento y rehacer la respuesta desde lo guardado.
 *
 * <p>Cada elemento va en UNA transacción con tres cosas: su efecto (el despacho por el mediator, que se une a ella), el
 * avance del cursor y su resultado. El avance es la VALLA: solo avanza si el cursor sigue donde lo dejó quien procesa, y si
 * no —otra réplica o la repetición de la petición se llevó el trabajo— el elemento revierte entero, efecto incluido.
 *
 * <p>No lo edites: lo regenera build.
 */
@Component
public class BatchJobSteps {

    /** Lo que deja un elemento: seguir, parar (el lote se detuvo, D4) o perder el trabajo (la valla). */
    public enum Step {
        NEXT, STOP, LOST
    }

    /** La valla perdida dentro de una transacción que abarca el lote (el todo o nada con clave): la revierte entera. */
    static final class FenceLost extends RuntimeException {

        FenceLost() {
            super(null, null, false, false);
        }
    }

    /**
     * Si el alta de un trabajo perdió la carrera de su clave con un conflicto TRANSITORIO, que se arregla repitiéndola:
     * ${document
       ? 'el WriteConflict de MongoDB (código 112, etiqueta TransientTransactionError), que aborta a la que llega segunda en vez\n     * de hacerla esperar'
       : 'el interbloqueo (PessimisticLockingFailureException). En MySQL, el releaseKey de dos altas con la misma clave toma un\n     * bloqueo de hueco en el índice único, el INSERT de cada una espera al de la otra y el motor aborta a una'}. Se busca en la
     * CADENA de causas, como en el mediator. Lo usan BatchJobs y KeyedBatches.
     */
    static boolean lostKeyRace(Throwable ex) {
        for (Throwable cause = ex; cause != null; cause = cause.getCause() == cause ? null : cause.getCause()) {
            if (${document
              ? 'cause instanceof MongoException mongo\n                    && (mongo.hasErrorLabel(MongoException.TRANSIENT_TRANSACTION_ERROR_LABEL) || mongo.getCode() == 112)'
              : 'cause instanceof PessimisticLockingFailureException'}) {
                return true;
            }
        }
        return false;
    }

    private final BatchJobStore store;
    private final BatchRunner runner;
    private final ObjectMapper mapper;
    private final Validator validator;
    private final TransactionTemplate transaction;

    public BatchJobSteps(BatchJobStore store, BatchRunner runner, ObjectMapper mapper, Validator validator,
            PlatformTransactionManager transactionManager) {
        this.store = store;
        this.runner = runner;
        this.mapper = mapper;
        this.validator = validator;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /**
     * Un elemento con su efecto, el avance del cursor y su resultado en UNA transacción. Fallan solo su elemento los codes
     * de {@code itemErrors} y ${FRAMEWORK_ERRORS.validation.code}; cualquier otro fallo detiene el lote ({@code ${aborted}},
     * D4) con su code o ${FRAMEWORK_ERRORS.batchAborted.code}.
     */
    public <T> Step process(UUID jobId, int index, JsonNode node, Class<T> itemType, Set<String> itemErrors, Function<T, Object> process) {
        T item;
        try {
            item = runner.read(node, itemType);
        } catch (BatchRunner.InvalidItem invalid) {
            return failed(jobId, index, BatchRunner.VALIDATION_ERROR, invalid.getMessage(), false);
        }
        try {
            Boolean kept = transaction.execute(status -> {
                Object result = process.apply(item);
                return keep(status, jobId, index, BatchResponse.Item.succeeded(index, result));
            });
            return Boolean.TRUE.equals(kept) ? Step.NEXT : Step.LOST;
        } catch (RuntimeException ex) {
            BatchRunner.Failure failure = runner.failureOf(index, ex, itemErrors);
            return failed(jobId, index, failure.item().error(), failure.item().message(), failure.stops());
        }
    }

    /** Un elemento que falla: su resultado y el avance, en su transacción; si detiene el lote, también el final (D4). */
    private Step failed(UUID jobId, int index, String code, String message, boolean stops) {
        Boolean kept = transaction.execute(status -> {
            if (!keep(status, jobId, index, BatchResponse.Item.failed(index, code, message))) {
                return false;
            }
            if (stops) {
                store.finish(jobId, "${aborted}");
            }
            return true;
        });
        if (!Boolean.TRUE.equals(kept)) {
            return Step.LOST;
        }
        return stops ? Step.STOP : Step.NEXT;
    }

    /**
     * La valla y el resultado de un elemento, en la transacción en curso: primero el avance del cursor, que toma la fila del
     * trabajo, y después el resultado. false (y la transacción marcada para revertir): el cursor ya no estaba en
     * {@code index}, así que el trabajo lo procesa otro.
     */
    private boolean keep(TransactionStatus status, UUID jobId, int index, BatchResponse.Item item) {
        if (!advance(jobId, item)) {
            status.setRollbackOnly();
            return false;
        }
        return true;
    }

    /** La valla y el resultado de un elemento dentro de la transacción del lote todo o nada con clave: perderla la revierte. */
    void keepInLot(UUID jobId, BatchResponse.Item item) {
        if (!advance(jobId, item)) {
            throw new FenceLost();
        }
    }

    private boolean advance(UUID jobId, BatchResponse.Item item) {
        boolean ok = "succeeded".equals(item.status());
        if (!store.advance(jobId, item.index(), ok ? 1 : 0, ok ? 0 : 1)) {
            return false;
        }
        String result = item.result() == null ? null : mapper.writeValueAsString(item.result());
        store.insertResult(jobId, item.index(), item.status(), item.error(), item.message(), result);
        return true;
    }

    /**
     * La respuesta de un lote síncrono con clave rehecha desde lo guardado (D15, batchStoredBody de keel-core): los
     * resultados en orden de índice y, si se detuvo, un {@code notAttempted} por cada elemento desde el cursor.
     */
    public BatchResponse stored(UUID jobId) {
        BatchJobStore.Job job = store.job(jobId).orElseThrow();
        List<BatchResponse.Item> items = new ArrayList<>(store.results(jobId, job.total(), 0).stream().map(this::item).toList());
        if ("${aborted}".equals(job.status())) {
            for (int index = job.nextIndex(); index < job.total(); index++) {
                items.add(BatchResponse.Item.notAttempted(index));
            }
        }
        return BatchResponse.of(items);
    }

    /** Un resultado guardado, como viaja en el cable. */
    public BatchResponse.Item item(BatchJobStore.Result result) {
        JsonNode value = result.result() == null ? null : mapper.readTree(result.result());
        return new BatchResponse.Item(result.index(), result.status(), value, result.errorCode(), result.message());
    }

    /**
     * El sobre como lo leería el borde: Jackson con el ObjectMapper de la aplicación y después Bean Validation sobre la
     * LISTA (presencia y maxItems), no sobre sus elementos, que se validan uno a uno. Un sobre mal formado es un 400 sin
     * trabajo.
     */
    public <R> R readEnvelope(byte[] body, Class<R> requestType) {
        R request;
        try {
            request = mapper.readValue(body, requestType);
        } catch (JacksonException malformed) {
            throw new HttpMessageNotReadableException(${javaText(FRAMEWORK_RESPONSES.malformed.message)}, malformed, new HttpInputMessage() {
                @Override
                public InputStream getBody() {
                    return new ByteArrayInputStream(body);
                }

                @Override
                public HttpHeaders getHeaders() {
                    return new HttpHeaders();
                }
            });
        }
        if (request == null) {
            throw new ConstraintViolationException("El cuerpo del lote es obligatorio", Set.of());
        }
        Set<ConstraintViolation<R>> violations = validator.validate(request);
        if (!violations.isEmpty()) {
            throw new ConstraintViolationException(violations);
        }
        return request;
    }

    /** La firma de la petición (D13): el sha256 en hexadecimal de los bytes del cuerpo, como batchRequestSignature de keel-core. */
    public static String signature(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (NoSuchAlgorithmException unreachable) {
            throw new IllegalStateException(unreachable);
        }
    }
}`;
  return { path: javaPath(model, BATCH_PKG, 'BatchJobSteps'), content: javaFile(subPackage(model, BATCH_PKG), imports, body) };
}

// ─── El lote síncrono con clave (D15) ────────────────────────────────────────

function inProgress(model, operations) {
  const canonical = FRAMEWORK_ERRORS.idempotencyRace;
  const codes = operations.map((operation) => `"${operation.name}", "${idempotencyOutcomeCode(model, operation.name, canonical)}"`);
  const body = `/**
 * La repetición de un lote síncrono con clave mientras el primero sigue en marcha (DSL 2.30, D15): todavía no hay respuesta
 * que devolver, y procesarlo a la vez lo repartiría entre dos peticiones. Es la semántica de una operación sola con clave.
 * El code es el que declara cada operación para este desenlace, o el canónico (docs/framework-errors.md).
 */
public class BatchKeyInProgressException extends ConflictException {

    private static final Map<String, String> CODES = Map.of(${codes.join(', ')});

    public BatchKeyInProgressException(String operation, String key) {
        super("Otra petición con la clave de idempotencia " + operation + "/" + key + " está procesando el lote",
                CODES.getOrDefault(operation, "${canonical.code}"), ${canonical.http}, new Object[] {operation, key});
    }
}`;
  return {
    path: javaPath(model, BATCH_PKG, 'BatchKeyInProgressException'),
    content: javaFile(subPackage(model, BATCH_PKG), ['java.util.Map', `${subPackage(model, 'domain.errors')}.ConflictException`], body)
  };
}

function keyedBatches(model) {
  const secured = Boolean(model.layersPresent.security);
  const { completed } = BATCH_JOB_STATUSES;
  const imports = [
    `${subPackage(model, BATCH_STORE_PKG)}.BatchJobStore`,
    `${subPackage(model, 'domain.identity')}.Uuids`,
    'java.nio.charset.StandardCharsets',
    'java.util.List',
    'java.util.Optional',
    'java.util.Set',
    'java.util.UUID',
    'java.util.function.Function',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.dao.DataIntegrityViolationException',
    'org.springframework.http.HttpStatus',
    'org.springframework.http.ResponseEntity',
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.support.TransactionTemplate',
    'tools.jackson.databind.JsonNode',
    ...(secured ? ['org.springframework.data.domain.AuditorAware'] : [])
  ];
  const atomic = keyedSyncBatchOperations(model).some(({ batch }) => batch.atomicity === 'all-or-nothing');
  const perItem = keyedSyncBatchOperations(model).some(({ batch }) => batch.atomicity === 'per-item');
  const perItemMethod = `

    /**
     * Un lote {@code per-item} con clave: como {@link BatchRunner#perItem}, con cada elemento confirmado junto a su resultado
     * y el avance del cursor, y la respuesta rehecha de lo guardado. Sin clave, el lote de siempre.
     */
    public <T> ResponseEntity<BatchResponse> perItem(String operation, byte[] body, String keySource, String clientKey, Long ttlSeconds,
            List<JsonNode> items, Class<T> itemType, Set<String> itemErrors, Function<T, Object> process) {
        String signature = BatchJobSteps.signature(body);
        String key = keyOf(keySource, clientKey, signature);
        if (key == null) {
            return runner.perItem(items, itemType, itemErrors, process);
        }
        Started started = start(operation, key, signature, ttlSeconds, body, items.size());
        if (started.replay()) {
            return ResponseEntity.status(HttpStatus.MULTI_STATUS).body(steps.stored(started.id()));
        }
        for (int index = started.from(); index < items.size(); index++) {
            BatchJobSteps.Step step = steps.process(started.id(), index, items.get(index), itemType, itemErrors, process);
            if (step == BatchJobSteps.Step.LOST) {
                // Otra petición con la misma clave tomó el trabajo (D15): lo termina ella.
                throw new BatchKeyInProgressException(operation, key);
            }
            if (step == BatchJobSteps.Step.STOP) {
                return ResponseEntity.status(HttpStatus.MULTI_STATUS).body(steps.stored(started.id()));
            }
        }
        transaction.executeWithoutResult(status -> store.finish(started.id(), "${completed}"));
        return ResponseEntity.status(HttpStatus.MULTI_STATUS).body(steps.stored(started.id()));
    }`;
  const atomicMethod = `

    /**
     * Un lote {@code all-or-nothing} con clave: como {@link BatchRunner#allOrNothing}, con los resultados, el cursor y el
     * final del trabajo en la transacción del lote. Si falla no queda nada confirmado, y su trabajo se descarta en otra:
     * la repetición lo vuelve a procesar en vez de devolver un lote que nunca se confirmó.
     */
    public <T> ResponseEntity<?> allOrNothing(String operation, String over, byte[] body, String keySource, String clientKey,
            Long ttlSeconds, List<JsonNode> items, Class<T> itemType, HttpStatus successStatus, Function<T, Object> process) {
        String signature = BatchJobSteps.signature(body);
        String key = keyOf(keySource, clientKey, signature);
        if (key == null) {
            return runner.allOrNothing(over, items, itemType, successStatus, process);
        }
        Started started = start(operation, key, signature, ttlSeconds, body, items.size());
        if (started.replay()) {
            return ResponseEntity.status(successStatus).body(steps.stored(started.id()));
        }
        UUID id = started.id();
        try {
            return runner.allOrNothing(over, items, itemType, successStatus, process, new BatchRunner.Sink() {
                @Override
                public void kept(BatchResponse.Item item) {
                    steps.keepInLot(id, item);
                }

                @Override
                public void completed() {
                    store.finish(id, "${completed}");
                }

                @Override
                public void discarded() {
                    transaction.executeWithoutResult(status -> store.discard(id));
                }
            });
        } catch (BatchJobSteps.FenceLost lost) {
            throw new BatchKeyInProgressException(operation, key);
        } catch (RuntimeException failed) {
            // Un fallo al confirmar no es de ningún elemento, y el lote tampoco quedó confirmado: su trabajo se descarta igual.
            transaction.executeWithoutResult(status -> store.discard(id));
            throw failed;
        }
    }`;
  const body = `/**
 * Los lotes SÍNCRONOS con clave de idempotencia (DSL 2.30, D15): la clave la guarda el TRABAJO ({@code ${BATCH_JOB.table}}),
 * como en un lote asíncrono, sin temporizador. La petición crea su trabajo en una transacción propia y procesa cada
 * elemento con {@link BatchJobSteps}; la respuesta se rehace siempre de lo guardado, así que es la misma para la primera
 * petición, la repetición y la que reanuda.
 *
 * <p>La repetición: con la misma firma y el trabajo terminado, la respuesta guardada sin procesar nada; con otra firma,
 * el error de la clave reutilizada; sin terminar y escrito hace menos de {@code ${BATCH_SYNC_STALE.key}}, el error de la
 * clave en curso (409); sin terminar y más viejo, quien lo procesaba murió: lo toma y sigue desde el cursor.
 *
 * <p>No lo edites: lo regenera build.
 */
@Component
public class KeyedBatches {

    /**
     * Intentos del alta cuando el motor la mata por INTERBLOQUEO. En MySQL (InnoDB), el UPDATE de releaseKey sobre una clave
     * que aún no existe toma un bloqueo de hueco en el índice único: dos altas con la misma clave lo toman las dos, el
     * INSERT de cada una espera al de la otra y el motor aborta a una. Repetida, su releaseKey espera al registro de la
     * ganadora hasta que confirma y la encuentra, como la que pierde en PostgreSQL por la unicidad.
     */
    private static final int KEY_RACE_ATTEMPTS = ${WRITE_CONFLICT_ATTEMPTS};
${secured ? '' : `
    /** El dueño de un lote sin capa security: no hay llamante, y la clave la acota solo la operación. */
    private static final String OWNER = "${BATCH_ANONYMOUS_OWNER}";
`}
    /** El trabajo de la petición: su id, desde qué elemento sigue y si ya terminó (la repetición responde lo guardado). */
    private record Started(UUID id, int from, boolean replay) {
    }

    private final BatchJobStore store;
    private final BatchJobSteps steps;
    private final BatchRunner runner;${secured ? '\n    private final AuditorAware<String> auditor;' : ''}
    private final TransactionTemplate transaction;
    private final long staleMs;

    public KeyedBatches(BatchJobStore store, BatchJobSteps steps, BatchRunner runner, ${secured ? 'AuditorAware<String> auditor, ' : ''}PlatformTransactionManager transactionManager,
            ${value(BATCH_SYNC_STALE)} long staleMs) {
        this.store = store;
        this.steps = steps;
        this.runner = runner;${secured ? '\n        this.auditor = auditor;' : ''}
        this.transaction = new TransactionTemplate(transactionManager);
        this.staleMs = staleMs;
    }

    /** El sobre del lote como lo leería el borde: uno mal formado es un 400 sin trabajo. */
    public <R> R read(byte[] body, Class<R> requestType) {
        return steps.readEnvelope(body, requestType);
    }${perItem ? perItemMethod : ''}${atomic ? atomicMethod : ''}

    /** La clave del lote: la cabecera, o la firma del cuerpo si la clave es el contenido. null: sin clave. */
    private static String keyOf(String keySource, String clientKey, String signature) {
        return "payload-hash".equals(keySource) ? signature : clientKey;
    }

    /** El trabajo de la petición: el de la clave, si lo hay, o uno nuevo, en una transacción propia. */
    private Started start(String operation, String key, String signature, Long ttlSeconds, byte[] body, int total) {
        String owner = owner();
        Long ttlMs = ttlSeconds == null ? null : ttlSeconds * 1000L;
        String input = new String(body, StandardCharsets.UTF_8);
        for (int attempt = 1; ; attempt++) {
            try {
                return transaction.execute(status -> {
                    store.releaseKey(operation, owner, key);
                    return repeat(operation, owner, key, signature).orElseGet(() -> {
                        UUID id = Uuids.v7();
                        store.insert(id, operation, owner, key, signature, ttlMs, input, total);
                        return new Started(id, 0, false);
                    });
                });
            } catch (DataIntegrityViolationException race) {
                // Dos peticiones con la misma clave a la vez: la que pierde espera a la ganadora en la unicidad del motor y
                // encuentra su trabajo, en marcha.
                return transaction.execute(status -> repeat(operation, owner, key, signature).orElseThrow(() -> race));
            } catch (RuntimeException conflict) {
                // Perdió la carrera de la clave sin llegar a la unicidad (el interbloqueo de MySQL): se repite el alta entera,
                // que ahora espera a la otra y encuentra su trabajo.
                if (!BatchJobSteps.lostKeyRace(conflict) || attempt >= KEY_RACE_ATTEMPTS) {
                    throw conflict;
                }
            }
        }
    }

    /** El trabajo vivo de la clave (D15, batchSyncRepeat de keel-core). */
    private Optional<Started> repeat(String operation, String owner, String key, String signature) {
        return store.byKey(operation, owner, key).map(hit -> {
            if (!hit.signature().equals(signature)) {
                throw new BatchJobKeyReusedException(operation, key);
            }
            BatchJobStore.Job job = store.job(hit.id()).orElseThrow();
            if (job.finishedAt() != null) {
                return new Started(job.id(), job.total(), true);
            }
            if (!store.takeOver(job.id(), staleMs)) {
                throw new BatchKeyInProgressException(operation, key);
            }
            return new Started(job.id(), job.nextIndex(), false);
        });
    }

    /** El dueño del trabajo: ${secured ? 'el actor de autoría de la petición (el sujeto del token)' : 'sin capa security, la operación sola acota la clave'}. */
    private String owner() {
        return ${secured ? 'auditor.getCurrentAuditor().orElseThrow()' : 'OWNER'};
    }
}`;
  return { path: javaPath(model, BATCH_PKG, 'KeyedBatches'), content: javaFile(subPackage(model, BATCH_PKG), imports, body) };
}

/**
 * La llamada del controller a KeyedBatches para un lote síncrono con clave: el cuerpo llega en BYTES (su firma es la de la
 * petición, D13) y el sobre lo lee KeyedBatches como el borde. `args` es la lista de argumentos del mensaje de UN elemento.
 */
export function controllerKeyedBatchCall(model, operation, { args, imports }) {
  const batch = operation.batch;
  imports.add(`${subPackage(model, BATCH_PKG)}.KeyedBatches`);
  imports.add(`${subPackage(model, BATCH_PKG)}.${batchRequestClass(operation)}`);
  imports.add('org.springframework.web.bind.annotation.RequestBody');
  const itemField = operation.bodyFields.find((field) => field.name === batch.over);
  const typeImport = domainTypeImport(model, itemField);
  if (typeImport) imports.add(typeImport);
  const clientKey = batch.idempotency.keySource === 'client-key';
  if (clientKey) imports.add('org.springframework.web.bind.annotation.RequestHeader');
  const params = ['@RequestBody byte[] body', ...(clientKey ? [`@RequestHeader(value = "${IDEMPOTENCY_HEADER}", required = false) String idempotencyKey`] : [])];
  const key = `${javaText(batch.idempotency.keySource)}, ${clientKey ? 'idempotencyKey' : 'null'}, ${batch.idempotency.ttlSeconds ? `${batch.idempotency.ttlSeconds}L` : 'null'}`;
  const dispatch = batchDispatch(operation, args);
  const read = `${batchRequestClass(operation)} request = keyedBatches.read(body, ${batchRequestClass(operation)}.class);`;
  const op = javaText(operation.name);
  if (batch.atomicity === 'per-item') {
    imports.add('java.util.Set');
    return {
      params,
      returnType: 'ResponseEntity<BatchResponse>',
      responseImports: [`${subPackage(model, BATCH_PKG)}.BatchResponse`, 'org.springframework.http.ResponseEntity'],
      call: `// Lote con clave (DSL 2.30, D15): la repetición responde lo guardado en su trabajo.
        ${read}
        return keyedBatches.perItem(${op}, body, ${key}, request.${batch.over}(), ${batch.itemType}.class,
                Set.of(${batch.itemErrors.map(javaText).join(', ')}),
                ${dispatch});`
    };
  }
  imports.add('org.springframework.http.HttpStatus');
  return {
    params,
    returnType: 'ResponseEntity<?>',
    responseImports: ['org.springframework.http.ResponseEntity'],
    call: `// Lote con clave (DSL 2.30, D15): la repetición responde lo guardado en su trabajo.
        ${read}
        return keyedBatches.allOrNothing(${op}, ${javaText(batch.over)}, body, ${key}, request.${batch.over}(), ${batch.itemType}.class,
                HttpStatus.valueOf(${operation.route.status}),
                ${dispatch});`
  };
}

// ─── El controller ───────────────────────────────────────────────────────────

/**
 * Los métodos del controller de una operación asíncrona: el alta (el cuerpo en bytes, la cabecera de la clave) y las dos
 * rutas del trabajo. `imports` es el set del controller.
 */
export function controllerBatchJobMethods(model, operation, { annotations, mappingImport }) {
  const batch = operation.batch;
  const imports = [
    `${subPackage(model, BATCH_PKG)}.BatchJobs`,
    `${subPackage(model, BATCH_PKG)}.BatchJobView`,
    `${subPackage(model, BATCH_PKG)}.BatchResponse`,
    `${subPackage(model, BATCH_PKG)}.${batchRequestClass(operation)}`,
    `${subPackage(model, TIMER_PKG)}.TimerKinds`,
    `${subPackage(model, DTO_PKG)}.PagedResponse`,
    'java.util.UUID',
    'org.springframework.data.domain.Pageable',
    'org.springframework.data.web.PageableDefault',
    'org.springframework.http.ResponseEntity',
    'org.springframework.web.bind.annotation.GetMapping',
    'org.springframework.web.bind.annotation.PathVariable',
    'org.springframework.web.bind.annotation.RequestBody',
    mappingImport
  ];
  const idempotency = batch.idempotency;
  const clientKey = idempotency?.keySource === 'client-key';
  if (clientKey) imports.push('org.springframework.web.bind.annotation.RequestHeader');
  const paths = batchJobPaths(operation.route.path);
  const size = model.pagination?.defaultSize ? `(size = ${model.pagination.defaultSize})` : '';
  const params = ['@RequestBody byte[] body', ...(clientKey ? [`@RequestHeader(value = "${IDEMPOTENCY_HEADER}", required = false) String idempotencyKey`] : [])];
  const keySource = idempotency ? javaText(idempotency.keySource) : 'null';
  const ttl = idempotency?.ttlSeconds ? `${idempotency.ttlSeconds}L` : 'null';
  const op = javaText(operation.name);
  const methods = `${annotations.join('\n')}
    public ResponseEntity<BatchJobView> ${operation.name}(${params.join(', ')}) {
        // Lote asíncrono (DSL 2.30): ${BATCH_ACCEPTED_STATUS} con el trabajo; lo procesa el cronómetro por partes.
        return batchJobs.submit(${op}, TimerKinds.${batchKindConstant(operation.name)}, body, ${batchRequestClass(operation)}.class,
                ${batchRequestClass(operation)}::${batch.over}, ${keySource}, ${clientKey ? 'idempotencyKey' : 'null'}, ${ttl});
    }

    /** El trabajo de ${operation.name}: su estado y su resumen. Solo lo lee quien lo creó. */
    @GetMapping("${paths.status}")
    public BatchJobView ${operation.name}Job(@PathVariable UUID ${BATCH_JOB_PARAM}) {
        return batchJobs.status(${op}, ${BATCH_JOB_PARAM});
    }

    /** Los resultados de los elementos intentados del trabajo de ${operation.name}, en orden de índice. */
    @GetMapping("${paths.results}")
    public PagedResponse<BatchResponse.Item> ${operation.name}JobResults(@PathVariable UUID ${BATCH_JOB_PARAM}, @PageableDefault${size} Pageable pageable) {
        return batchJobs.results(${op}, ${BATCH_JOB_PARAM}, pageable);
    }`;
  return { imports, methods };
}
