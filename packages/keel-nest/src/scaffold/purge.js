// La purga POR LOTES de las tablas del generador en la rama relacional: `outbox_event`,
// `processed_event` e `idempotency_record` (incremento 10b).
//
// Las mismas que purga el servidor de keel-spring del mismo diseño, con la misma forma (keel-core/gen/
// scheduling.js, `BATCHED_PURGE`): un único DELETE sobre todo lo caducado es una transacción del tamaño
// del atraso —tras una caída del broker, millones de filas que retienen sus bloqueos, llenan el WAL y,
// con el tope de transacción del servicio, no terminan nunca—. El lote se acota por INSTANTE: se lee el
// de la fila que ocupa la posición N entre las que hay que purgar y se borra hasta él, cada lote en su
// propia transacción.
//
// Dos archivos: el bucle (`batched-purge.ts`, sin Nest ni TypeORM, para poder ejecutarlo contra la
// referencia de keel-core) y las tres purgas con su reloj y su configuración (`table-purges.ts`), con las
// mismas claves, variables y defaults que keel-spring.

import { BATCHED_PURGE, batchedPurgeParameters } from 'keel-core/gen';
import { OUTBOX_EVENT, OUTBOX_PURGE, PROCESSED_EVENT, PROCESSED_EVENT_PURGE } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD, IDEMPOTENCY_RECORD_PURGE } from 'keel-core/gen/request-idempotency';
import { tsModule, tsString } from './render.js';
import { usesPersistence, usesDocument } from './persistence-entities.js';
import { DOCUMENT_PURGE_PREDICATES, documentPurgeMethod } from './document-stores.js';
import { usesNestOutbox, usesProcessedEvents } from './messaging.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { TRANSACTION_CONTEXT_TS } from './repositories.js';
import { SCHEDULING_TS } from './scheduling.js';
import { reconciliationPurge } from './reconciliation-claim.js';
import { RECONCILIATION_CLAIM } from 'keel-core/gen/reconciliation-stores';

const PURGE_DIR = 'src/infrastructure/persistence/purge';
export const BATCHED_PURGE_TS = `${PURGE_DIR}/batched-purge.ts`;
export const TABLE_PURGES_TS = `${PURGE_DIR}/table-purges.ts`;
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';

/**
 * Las purgas de ESTE diseño, como datos: qué tabla, por qué columna se corta, qué condición propia lleva
 * (lo pendiente del outbox no se toca nunca), con qué retención y bajo qué prefijo de configuración.
 */
export function tablePurges(model) {
  if (!usesPersistence(model)) return [];
  const purges = [];
  if (usesNestOutbox(model)) {
    purges.push({
      key: 'outbox',
      what: 'outbox_event',
      method: 'purgeOutbox',
      table: OUTBOX_EVENT.table,
      column: 'published_at',
      predicate: 'published_at IS NOT NULL',
      prefix: 'outbox.purge',
      cron: OUTBOX_PURGE.cron,
      retentionDays: OUTBOX_PURGE.retentionDays,
      log: 'Outbox: purgadas ${deleted} filas publicadas antes de ${cutoff.toISOString()}'
    });
  }
  if (usesProcessedEvents(model)) {
    purges.push({
      key: 'processedEvent',
      what: 'processed_event',
      method: 'purgeProcessedEvents',
      table: PROCESSED_EVENT.table,
      column: 'processed_at',
      predicate: null,
      prefix: 'processed-event.purge',
      cron: PROCESSED_EVENT_PURGE.cron,
      retentionDays: PROCESSED_EVENT_PURGE.retentionDays,
      log: 'Idempotencia: purgados ${deleted} mensajes procesados antes de ${cutoff.toISOString()}'
    });
  }
  if (usesRequestIdempotency(model)) {
    purges.push({
      key: 'idempotencyRecord',
      what: 'idempotency_record',
      method: 'purgeIdempotencyRecords',
      table: IDEMPOTENCY_RECORD.table,
      column: 'expires_at',
      predicate: null,
      prefix: 'idempotency-record.purge',
      cron: IDEMPOTENCY_RECORD_PURGE.cron,
      // Sin retención: cada fila lleva su caducidad (expires_at), calculada con el ttlSeconds del diseño.
      retentionDays: null,
      log: 'Idempotencia HTTP: purgadas ${deleted} claves caducadas'
    });
  }
  // Las marcas del reclamo de reconciliación (incremento 11c), con la retención y el reloj de keel-spring.
  const reconciliation = reconciliationPurge(model);
  if (reconciliation) purges.push(reconciliation);
  // Las columnas que se nombran tienen que existir en los datos de la tabla: si keel-core renombrara una,
  // la purga borraría por una columna que no está y fallaría cada noche sin que nada lo dijera antes.
  for (const purge of purges) {
    const table = [OUTBOX_EVENT, PROCESSED_EVENT, IDEMPOTENCY_RECORD, RECONCILIATION_CLAIM].find((candidate) => candidate.table === purge.table);
    if (!table.columns.some((column) => column.name === purge.column)) {
      throw new Error(`La purga de ${purge.table} corta por ${purge.column}, que no es columna de la tabla en keel-core`);
    }
  }
  return purges;
}

export function usesTablePurges(model) {
  return tablePurges(model).length > 0;
}

export function generate(model) {
  const purges = tablePurges(model);
  if (purges.length === 0) return [];
  const files = [
    { path: BATCHED_PURGE_TS, content: batchedPurgeFile() },
    { path: TABLE_PURGES_TS, content: tablePurgesFile(purges, usesDocument(model)) }
  ];
  // La cadencia de la purga del registro de idempotencia, en su propio fragmento como en keel-spring (las del
  // outbox y de processed_event van en messaging.yaml). El perfil test no lo lleva: allí no corre el reloj.
  if (purges.some((purge) => purge.key === 'idempotencyRecord')) {
    for (const profile of ['local', 'develop', 'production']) {
      files.push({ path: `config/parameters/${profile}/idempotency.yaml`, content: idempotencyYaml(profile) });
    }
  }
  return files;
}

function idempotencyYaml(profile) {
  const { cron } = IDEMPOTENCY_RECORD_PURGE;
  const value = profile === 'local' ? cron.default : `\${${cron.env}:${cron.default}}`;
  return [
    'idempotency-record:',
    '  purge:',
    '    # Borrado de las claves ya caducadas; la ventana de deduplicación la fija el ttlSeconds del diseño,',
    '    # no esta cadencia.',
    `    cron: "${value}"`
  ].join('\n') + '\n';
}

function batchedPurgeFile() {
  return tsModule(
    BATCHED_PURGE_TS,
    [],
    `/** Filas por lote y lotes por pasada: los del servidor de keel-spring del mismo diseño. */
export const PURGE_BATCH_SIZE = ${BATCHED_PURGE.batchSize};
export const PURGE_MAX_BATCHES = ${BATCHED_PURGE.maxBatches};

export interface BatchedPurgeRun {
  /** Nombre de la tabla, para el log. */
  readonly what: string;
  readonly batchSize: number;
  readonly maxBatches: number;
  /** El corte de retención: se purga lo anterior. */
  readonly cutoff: Date;
  /** El instante de la fila en esa POSICIÓN entre las que hay que purgar, o null si quedan menos. */
  readonly boundary: (position: number) => Promise<Date | null>;
  /** Borra lo anterior al corte hasta ese instante incluido, en SU PROPIA transacción; devuelve cuántas. */
  readonly deleteUpTo: (upTo: Date) => Promise<number>;
  /** Dónde se avisa de que la pasada llegó a su tope con filas pendientes. */
  readonly warn: (message: string) => void;
}

/**
 * Purga POR LOTES, cada lote en su propia transacción. Devuelve las filas borradas en total.
 *
 * Las filas que comparten instante con la frontera caen en el mismo lote, así que un lote puede pasar de
 * batchSize: la cota es aproximada a propósito. Alcanzado maxBatches, avisa y deja el resto a la
 * siguiente pasada: sin tope, un atraso enorme haría de la pasada nocturna un proceso de horas
 * compitiendo con el tráfico de la mañana.
 *
 * Corre en todas las réplicas a la vez y no se coordina: borrar es idempotente, y dos réplicas que se
 * solapan solo borran menos cada una.
 */
export async function batchedPurge(run: BatchedPurgeRun): Promise<number> {
  const { what, batchSize, maxBatches, cutoff, boundary, deleteUpTo, warn } = run;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error(\`\${what}: batch-size y max-batches tienen que ser enteros positivos\`);
  }
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const edge = await boundary(batchSize - 1);
    // Queda menos de un lote: el último, entero.
    if (edge == null) return total + (await deleteUpTo(cutoff));
    total += await deleteUpTo(edge);
  }
  warn(
    \`\${what}: la purga llegó a su tope de \${maxBatches} lotes de \${batchSize} filas y quedan filas por purgar; la siguiente pasada sigue\`
  );
  return total;
}`
  );
}

function tablePurgesFile(purges, document = false) {
  const settingsType = (purge) =>
    `{ readonly cron: string;${purge.retentionDays ? ' readonly retentionDays: number;' : ''} readonly batchSize: number; readonly maxBatches: number }`;
  const settingsValue = (purge) => {
    const batch = batchedPurgeParameters(purge.prefix);
    return `    ${purge.key}: {
      cron: text(configuration, ${tsString(purge.cron.key)}, ${tsString(purge.cron.default)}),${
        purge.retentionDays ? `\n      retentionDays: positive(configuration, ${tsString(purge.retentionDays.key)}, ${purge.retentionDays.default}),` : ''
      }
      batchSize: positive(configuration, ${tsString(batch.batchSize.key)}, ${batch.batchSize.default}),
      maxBatches: positive(configuration, ${tsString(batch.maxBatches.key)}, ${batch.maxBatches.default})
    }`;
  };
  const registrations = purges
    .map((purge) => `    this.scheduling.register({ name: ${tsString(`purge:${purge.what}`)}, cron: this.settings.${purge.key}.cron, run: () => this.${purge.method}() });`)
    .join('\n');
  const methods = purges
    .map((purge) => {
      const cutoff = purge.retentionDays
        ? `new Date(now.getTime() - this.settings.${purge.key}.retentionDays * DAY_MS)`
        : 'now';
      return `  /** La purga de ${purge.what}${purge.predicate ? ` (solo ${purge.predicate})` : ''}. Devuelve las filas borradas. */
  async ${purge.method}(now: Date = new Date()): Promise<number> {
    const cutoff = ${cutoff};
    const deleted = await this.purge(${tsString(purge.what)}, ${tsString(purge.table)}, ${tsString(purge.column)}, ${document ? DOCUMENT_PURGE_PREDICATES[purge.table] ?? 'null' : purge.predicate ? tsString(purge.predicate) : 'null'}, cutoff, this.settings.${purge.key});
    if (deleted > 0) this.logger.log(\`${purge.log}\`);
    return deleted;
  }`;
    })
    .join('\n\n');
  const anyRetention = purges.some((purge) => purge.retentionDays);
  return tsModule(
    TABLE_PURGES_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'OnModuleInit', from: '@nestjs/common', type: true },
      ...(document
        ? [{ symbol: 'Document', from: 'mongodb', type: true }, { symbol: 'MongoClient', from: 'mongodb', type: true }]
        : [{ symbol: 'DataSource', from: 'typeorm', type: true }]),
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: 'DATA_SOURCE', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'Scheduling', from: SCHEDULING_TS },
      { symbol: 'batchedPurge', from: BATCHED_PURGE_TS }
    ],
    `/** Token de la configuración de las purgas ya resuelta. */
export const PURGE_SETTINGS = Symbol('PURGE_SETTINGS');
${anyRetention ? '\nconst DAY_MS = 86_400_000;\n' : ''}
export interface PurgeSettings {
${purges.map((purge) => `  readonly ${purge.key}: ${settingsType(purge)};`).join('\n')}
}

/**
 * Las purgas del perfil activo, con las claves y los defaults del servidor de keel-spring: el cron (seis
 * campos, con segundos), la retención en días donde la hay, y el tamaño y el tope de los lotes. Un valor
 * que no es un entero positivo no deja arrancar.
 */
export function purgeSettings(configuration: Configuration): PurgeSettings {
  return {
${purges.map(settingsValue).join(',\n')}
  };
}

/**
 * Las purgas de las tablas del generador, cada una con su reloj. Por lotes y SIN transacción abarcadora:
 * cada lote confirma en la suya (batchedPurge). Una sola transacción alrededor de todo volvería a ser el
 * DELETE único que esto sustituye. Sin base de datos (el perfil test) no se registran.
 */
@Injectable()
export class TablePurges implements OnModuleInit {
  private readonly logger = new Logger('TablePurges');

  constructor(
    @Inject(Scheduling) private readonly scheduling: Scheduling,
    @Inject(PURGE_SETTINGS) private readonly settings: PurgeSettings,
    @Inject(DATA_SOURCE) private readonly dataSource: ${document ? 'MongoClient' : 'DataSource'} | null,
    @Inject(TransactionContext) private readonly transactions: TransactionContext
  ) {}

  onModuleInit(): void {
    if (this.dataSource == null) return;
${registrations}
  }

${methods}

${document ? documentPurgeMethod() : `  private purge(
    what: string,
    table: string,
    column: string,
    predicate: string | null,
    cutoff: Date,
    batch: { readonly batchSize: number; readonly maxBatches: number }
  ): Promise<number> {
    const dataSource = this.source();
    // La frontera y el borrado llevan la MISMA condición: la frontera tiene que contar las filas que el
    // borrado se lleva, o el lote deja de medir lo que dice.
    const where = [predicate, \`\${column} < :cutoff\`].filter(Boolean).join(' AND ');
    return batchedPurge({
      what,
      batchSize: batch.batchSize,
      maxBatches: batch.maxBatches,
      cutoff,
      boundary: async (position) => {
        const row = await dataSource
          .createQueryBuilder()
          .select(\`purged.\${column}\`, 'edge')
          .from(table, 'purged')
          .where(where.replaceAll(column, \`purged.\${column}\`), { cutoff })
          .orderBy(\`purged.\${column}\`, 'ASC')
          .offset(position)
          .limit(1)
          .getRawOne<{ edge: Date | string | null }>();
        return row?.edge == null ? null : new Date(row.edge);
      },
      // Cada lote en una transacción NUEVA, con el tope de transacción del servicio: confirma y suelta sus
      // bloqueos antes del siguiente.
      deleteUpTo: (upTo) =>
        this.transactions.inNewTransaction(async (manager) => {
          const result = await manager
            .createQueryBuilder()
            .delete()
            .from(table)
            .where(\`\${where} AND \${column} <= :upTo\`, { cutoff, upTo })
            .execute();
          return result.affected ?? 0;
        }),
      warn: (message) => this.logger.warn(message)
    });
  }

  private source(): DataSource {
    if (this.dataSource == null) throw new Error('Sin base de datos en este perfil: las purgas no corren.');
    return this.dataSource;
  }`}
}

function text(configuration: Configuration, key: string, fallback: string): string {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}`
  );
}
