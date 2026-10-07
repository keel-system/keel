// La purga POR LOTES de las tablas del generador en la rama relacional: `outbox_event`,
// `processed_event`, `idempotency_record` y `reconciliation_claim`.
//
// Hasta aquí cada una se purgaba con UN `DELETE` sobre todo lo caducado, o sea una transacción
// del tamaño del atraso. En el día a día no se nota; tras una caída del broker o una semana sin
// cron son millones de filas, y entonces: la transacción retiene sus bloqueos hasta el final —en
// SQL Server, pasadas unas miles de filas, ESCALA a bloqueo de tabla, y sobre `outbox_event` eso
// detiene cualquier comando que emita un evento—, llena el undo o el WAL, y con el timeout de
// transacción del servicio (`spring.transaction.default-timeout`) no termina nunca: muere cada
// noche sin haber borrado nada, y el atraso crece.
//
// Este módulo es la FUENTE ÚNICA de la forma: la clase `BatchedPurge` (el bucle), las dos
// consultas que cada repositorio aporta y la llamada. Cuatro copias del mismo bucle divergirían a
// la primera, y la que se queda atrás no la nota nadie hasta la noche que hace falta.
//
// La rama documental no pasa por aquí, y no es asimetría: el `deleteMany` de Mongo no abre
// transacción, va documento a documento y no retiene bloqueos que escalen.

import { BATCHED_PURGE } from 'keel-core/gen';
import { javaFile, javaPath, subPackage } from './render.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';
import { usesHttpIdempotency } from './http-idempotency.js';
import { reconciliationClaims } from './reconciliation-claim.js';

export const PURGE_PKG = 'infrastructure.persistence.purge';
export const PURGE_CLASS = 'BatchedPurge';

/** Filas por lote y lotes por pasada: los mismos que la purga de keel-nest (keel-core/gen/scheduling.js). */
export const PURGE_BATCH_SIZE = BATCHED_PURGE.batchSize;
export const PURGE_MAX_BATCHES = BATCHED_PURGE.maxBatches;

/** ¿Hay alguna purga relacional en este servicio? */
export function usesBatchedPurge(model) {
  if (!model.layersPresent?.persistence || model.persistenceKind === 'document') return false;
  return (
    usesOutbox(model) || usesIdempotency(model) || usesHttpIdempotency(model) || reconciliationClaims(model).length > 0
  );
}

export function generate(model) {
  if (!usesBatchedPurge(model)) return [];
  return [renderBatchedPurge(model)];
}

/** El import de la clase, para quien la llama. */
export function batchedPurgeImport(model) {
  return `${subPackage(model, PURGE_PKG)}.${PURGE_CLASS}`;
}

/**
 * Las dos consultas que un repositorio aporta a la purga por lotes.
 *
 * `predicate` es la condición PROPIA de la tabla además del corte (la del outbox, que lo pendiente
 * no se toca), o null. Las dos consultas la llevan entera: la frontera tiene que contar las MISMAS
 * filas que el borrado se lleva, o el lote deja de medir lo que dice.
 */
export function purgeQueries({ entity, alias, field, predicate = null, deleteMethod }) {
  const where = [predicate, `${alias}.${field} < :cutoff`].filter(Boolean).join(' and ');
  return `    /**
     * Purga por lotes (${PURGE_CLASS}): el instante de la fila que ocupa esa POSICIÓN entre las que
     * hay que purgar, o vacío si quedan menos. Es la frontera del lote siguiente.
     */
    @Query("select ${alias}.${field} from ${entity} ${alias} where ${where} order by ${alias}.${field} asc")
    List<Instant> findPurgeBoundary(@Param("cutoff") Instant cutoff, Pageable position);

    /**
     * Un lote de la purga: lo anterior al corte hasta {@code upTo} incluido, en SU PROPIA
     * transacción —que es lo que hace que cada lote confirme y suelte sus bloqueos—.
     */
    @Modifying
    @Transactional
    @Query("delete from ${entity} ${alias} where ${where} and ${alias}.${field} <= :upTo")
    int ${deleteMethod}(@Param("cutoff") Instant cutoff, @Param("upTo") Instant upTo);`;
}

/** Los imports que `purgeQueries` necesita en el repositorio. */
export const PURGE_QUERY_IMPORTS = [
  'java.time.Instant',
  'java.util.List',
  'org.springframework.data.domain.Pageable',
  'org.springframework.data.jpa.repository.Modifying',
  'org.springframework.data.jpa.repository.Query',
  'org.springframework.data.repository.query.Param',
  'org.springframework.transaction.annotation.Transactional'
];

/** Los dos `@Value` del tamaño y del tope, bajo el prefijo de configuración de esa purga. */
export function purgeSettings(prefix) {
  return `    @Value("\${${prefix}.batch-size:${PURGE_BATCH_SIZE}}")
    private int purgeBatchSize;

    @Value("\${${prefix}.max-batches:${PURGE_MAX_BATCHES}}")
    private int purgeMaxBatches;`;
}

/**
 * La llamada, como expresión `long`. `cutoff` tiene que ser una variable ya declarada: la usan la
 * frontera y el borrado, y las dos tienen que ver el MISMO instante.
 */
export function purgeCall({ what, repository, deleteMethod, cutoff = 'cutoff' }) {
  return `${PURGE_CLASS}.run("${what}", purgeBatchSize, purgeMaxBatches,
                position -> ${repository}.findPurgeBoundary(${cutoff}, PageRequest.of(position, 1)),
                upTo -> ${repository}.${deleteMethod}(${cutoff}, upTo), ${cutoff})`;
}

/** Los imports que `purgeCall` necesita en quien la hace. */
export function purgeCallImports(model) {
  return [batchedPurgeImport(model), 'org.springframework.data.domain.PageRequest'];
}

function renderBatchedPurge(model) {
  const body = `/**
 * Purga POR LOTES de las tablas del generador, cada lote en su propia transacción.
 *
 * <p>Un único DELETE sobre todo lo caducado es una transacción del tamaño del atraso: tras una
 * caída, millones de filas. Retiene sus bloqueos hasta el final —en SQL Server, pasadas unas miles
 * de filas, escala a bloqueo de TABLA y detiene toda escritura en ella—, llena el undo o el WAL, y
 * con el timeout de transacción del servicio no termina nunca: muere cada noche sin avanzar.
 *
 * <p>El lote se acota por INSTANTE y no por id: se lee el instante de la fila que ocupa la posición
 * N entre las que hay que purgar y se borra hasta él. Así vale igual para las claves compuestas,
 * recorre el índice que la tabla ya tiene sobre ese campo y es JPQL, el mismo en todos los motores.
 * Las filas que comparten instante con la frontera caen en el mismo lote, así que un lote puede
 * pasar de N: la cota es aproximada a propósito.
 *
 * <p>Corre en todas las réplicas a la vez y no se coordina: borrar es idempotente, y dos réplicas
 * que se solapan solo borran menos cada una.
 */
public final class ${PURGE_CLASS} {

    private static final Logger log = LoggerFactory.getLogger(${PURGE_CLASS}.class);

    private ${PURGE_CLASS}() {
    }

    /**
     * @param what       nombre de la tabla para el log
     * @param batchSize  filas por lote
     * @param maxBatches lotes por pasada; alcanzado, avisa y deja el resto a la siguiente
     * @param boundary   dada una posición, el instante de esa fila entre las que hay que purgar, o vacío
     * @param deleteUpTo borra lo anterior al corte hasta ese instante incluido, en su propia transacción
     * @param cutoff     el corte de retención
     * @return filas borradas en total
     */
    public static long run(String what, int batchSize, int maxBatches,
            IntFunction<List<Instant>> boundary, Function<Instant, Integer> deleteUpTo, Instant cutoff) {
        if (batchSize < 1 || maxBatches < 1) {
            throw new IllegalArgumentException(what + ": batch-size y max-batches tienen que ser positivos");
        }
        long total = 0;
        for (int batch = 0; batch < maxBatches; batch++) {
            List<Instant> edge = boundary.apply(batchSize - 1);
            if (edge.isEmpty()) {
                // Queda menos de un lote: el último, entero.
                return total + deleteUpTo.apply(cutoff);
            }
            total += deleteUpTo.apply(edge.get(0));
        }
        log.atWarn()
                .addKeyValue("keel.purge.table", what)
                .log("{}: la purga llegó a su tope de {} lotes de {} filas y quedan filas por purgar; "
                        + "la siguiente pasada sigue", what, maxBatches, batchSize);
        return total;
    }
}`;

  return {
    path: javaPath(model, PURGE_PKG, PURGE_CLASS),
    content: javaFile(
      subPackage(model, PURGE_PKG),
      [
        'java.time.Instant',
        'java.util.List',
        'java.util.function.Function',
        'java.util.function.IntFunction',
        'org.slf4j.Logger',
        'org.slf4j.LoggerFactory'
      ],
      body
    )
  };
}
