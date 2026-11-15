// Los LOTES ASÍNCRONOS (DSL 2.30: `use-cases.<op>.batch` con `execution: async`) en keel-nest: incremento 7 de
// PLAN-DSL-230-LOTES.md, el gemelo de batch-jobs.js de keel-spring. Lo que decide QUÉ (las tablas y sus sentencias por
// motor, los estados, el temporizador de cada trabajo, la firma de la petición, la forma del trabajo en el cable, los
// casos BJ-*) es de keel-core (gen/batch.js y gen/batch-store.js); aquí solo se escribe en TypeScript:
//
//   · el almacén (`BatchJobStore`): SQL a pelo con las sentencias de keel-core TAL CUAL, más las dos tablas mapeadas solo
//     para el esquema; o MongoDB con la forma documental de keel-core y sus índices en DOCUMENT_INDEXES. La purga de lo
//     terminado (D10) es un recurrente más del cronómetro (`BatchJobPurgeTimer`, en timer.js);
//   · `BatchJobs`: el alta (D8, D13) y las dos rutas del trabajo, que solo lee quien lo creó (D11). El alta lee el TEXTO
//     del cuerpo tal como llegó (el lector JSON de http-platform.ts lo guarda en la petición): lo firma, lo lee con el
//     MISMO lector de la operación que usa el borde —un sobre mal formado es un 400 sin crear ningún trabajo (BJ-9)—,
//     resuelve la clave del lote y crea el trabajo y su temporizador de una vez en UNA transacción: 202 + Location;
//   · `BatchJobRunner`: un disparo del temporizador (D9). Procesa un chunk desde el cursor; cada elemento con su efecto, el
//     avance del cursor (la valla, PRIMERO) y su resultado en UNA transacción. Corre fuera de la transacción del sondeador
//     (`TimerHandler.inTransaction = false`), y como el dueño del trabajo: es el actor de autoría de cada elemento;
//   · `<Op>BatchJob`: el `TimerHandler` de cada operación asíncrona, que sabe leer el sobre guardado y construir el
//     mensaje de UN elemento con el lector que exporta el controlador.
//
// El lote SÍNCRONO con clave (D15, incremento 10b) usa el mismo almacén, sin temporizador: `KeyedBatches` crea su trabajo,
// procesa cada elemento con el paso que comparte con el procesador (`BatchJobSteps`: efecto, valla y resultado en UNA
// transacción) y responde siempre lo guardado, así que la primera petición, la repetición y la que reanuda tras una
// muerte a mitad de lote responden lo mismo.
//
// Lo que no cambia respecto al lote síncrono: el handler procesa UN elemento, cada elemento se lee con el MISMO
// `read<Elemento>` del borde y su fallo se traduce con ApiExceptionFilter (batch.ts: `readBatchItem`, `itemFailure`), así
// que «falla solo su elemento» y «detiene el lote» significan lo mismo.
//
// Este módulo no importa a otros emisores (controllers.js, timer.js y application.js lo importan a él): las rutas de lo
// que importa lo emitido van escritas aquí.

import {
  asyncBatchOperations,
  batchJobStoreOperations,
  keyedSyncBatchOperations,
  batchJobPaths,
  BATCH_JOB_PARAM,
  BATCH_ACCEPTED_STATUS,
  BATCH_MULTI_STATUS
} from '@keel-system/keel-core/gen/batch';
import {
  BATCH_ANONYMOUS_OWNER,
  BATCH_JOB,
  BATCH_ITEM_RESULT,
  BATCH_JOB_COLLECTIONS,
  BATCH_JOB_STATUSES,
  BATCH_PARAMETERS,
  BATCH_STORE_ENGINES,
  BATCH_SYNC_STALE,
  batchKind,
  batchStatements,
  batchSyncStatements
} from '@keel-system/keel-core/gen/batch-store';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { idempotencyOutcomeCode } from '@keel-system/keel-core/gen/declared-errors';
import { IDEMPOTENCY_HEADER } from '@keel-system/keel-core/gen/request-idempotency';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { PAGEABLE_DEFAULT_SIZE, PAGEABLE_MAX_SIZE } from '@keel-system/keel-core/gen/pagination';
import { classPath, tsModule, tsString } from './render.js';
import { optionsLiteral, physicalColumn } from './persistence-entities.js';

const STORE_DIR = 'infrastructure/persistence/batch';
const REST_DIR = 'infrastructure/rest/batch';
export const BATCH_JOB_STORE_TS = classPath(STORE_DIR, 'BatchJobStore');
export const SQL_BATCH_JOB_STORE_TS = classPath(STORE_DIR, 'SqlBatchJobStore');
export const MONGO_BATCH_JOB_STORE_TS = classPath(STORE_DIR, 'MongoBatchJobStore');
export const BATCH_JOB_ORM_TS = classPath(STORE_DIR, 'BatchJobOrm');
export const BATCH_SETTINGS_TS = classPath(STORE_DIR, 'BatchSettings');
export const BATCH_JOBS_TS = classPath(REST_DIR, 'BatchJobs');
export const BATCH_JOB_RUNNER_TS = classPath(REST_DIR, 'BatchJobRunner');
export const BATCH_JOB_STEPS_TS = classPath(REST_DIR, 'BatchJobSteps');
export const KEYED_BATCHES_TS = classPath(REST_DIR, 'KeyedBatches');

// Las rutas de lo que importa lo emitido (ver la cabecera).
const BATCH_TS = 'src/infrastructure/rest/batch.ts';
const REQUEST_ERRORS_TS = 'src/infrastructure/rest/request-errors.ts';
const ROUTES_TS = 'src/infrastructure/rest/routes.ts';
const PAGEABLE_READING_TS = 'src/infrastructure/rest/pageable-reading.ts';
const PAGED_RESPONSE_TS = 'src/application/dtos/paged-response.ts';
const PAGE_TS = 'src/domain/repository/page.ts';
const WIRE_TS = 'src/application/support/wire.ts';
const UUIDS_TS = 'src/domain/identity/uuids.ts';
const ERRORS_DIR = 'domain/errors';
const DOMAIN_EXCEPTION_TS = classPath(ERRORS_DIR, 'DomainException');
const TRANSACTION_CONTEXT_TS = 'src/infrastructure/persistence/transaction-context.ts';
const AUDIT_ACTOR_TS = 'src/infrastructure/persistence/audit-actor.ts';
const SECURITY_CONTEXT_TS = 'src/infrastructure/security/security-context.ts';
const TIMER_STORE_TS = 'src/infrastructure/timer/timer-store.ts';
const TIMER_KINDS_TS = 'src/infrastructure/timer/timer-kinds.ts';
const MEDIATOR_TS = 'src/infrastructure/usecase/use-case-mediator.ts';
const VALUE_READERS_TS = 'src/infrastructure/rest/value-readers.ts';
const TRANSFORMERS_TS = 'src/infrastructure/persistence/column-transformers.ts';
const CONTROLLERS_DIR = 'infrastructure/rest/controllers';
const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const PROFILES = ['local', 'develop', 'production', 'test'];

const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const isDocument = (model) => model.persistenceKind === 'document';
const nestPath = (path) => path.replace(/\{([^}]+)\}/g, ':$1').replace(/^\//, '');

/** Las operaciones asíncronas del modelo, enteras (no solo su nombre). */
const asyncOperations = (model) =>
  (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.batch?.execution === 'async');

/**
 * ¿Usa el servicio el almacén de trabajos? Con un lote asíncrono o un lote síncrono con clave (D15). Sin persistencia no
 * hay dónde guardar el trabajo (lo rechaza la frontera).
 */
export const usesBatchJobs = (model) => Boolean(model.layersPresent?.persistence) && batchJobStoreOperations(model).length > 0;

/** ¿Tiene el servicio algún lote asíncrono? El alta, el procesador y las dos rutas del trabajo. */
export const usesAsyncBatchJobs = (model) => usesBatchJobs(model) && asyncBatchOperations(model).length > 0;

/** ¿Tiene el servicio algún lote síncrono con clave (D15)? */
export const usesKeyedBatches = (model) => usesBatchJobs(model) && keyedSyncBatchOperations(model).length > 0;

/** Las operaciones síncronas con clave del modelo, enteras. */
const keyedOperations = (model) =>
  (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.batch && operation.batch.execution !== 'async' && operation.batch.idempotency);

/** La constante del `kind` del temporizador de los trabajos de una operación, en TimerKinds. */
export const batchKindConstant = (operationName) => `BATCH_${constantOf(operationName)}`;

/** Las líneas de TimerKinds de los lotes asíncronos (las llama timer.js). */
export function batchKindLines(model) {
  return asyncBatchOperations(model).map(
    ({ operation }) => `  /** Los trabajos del lote asíncrono ${operation} (DSL 2.30): un temporizador de UNA vez por trabajo. */
  ${batchKindConstant(operation)}: ${tsString(batchKind(operation))},`
  );
}

/** El handler del temporizador de los trabajos de una operación. */
export const batchJobClass = (operation) => `${capital(operation.name)}BatchJob`;
export const batchJobPath = (operation) => classPath(REST_DIR, batchJobClass(operation));

/** Los handlers de los trabajos, para TimerPollerModule: `{ symbol, from }`. */
export function batchJobHandlers(model) {
  if (!usesBatchJobs(model)) return [];
  return asyncOperations(model).map((operation) => ({ symbol: batchJobClass(operation), from: batchJobPath(operation) }));
}

/** El controlador de una operación (sin importar controllers.js: ver la cabecera). */
function controllerOf(model, operation) {
  const service = model.services.find((candidate) => candidate.operations.includes(operation));
  return { symbol: service.controllerClass, from: classPath(CONTROLLERS_DIR, service.controllerClass) };
}

/**
 * Lo que un diseño con lotes asíncronos o síncronos con clave no puede generar con este stack, o []: las sentencias son
 * las del cronómetro (PostgreSQL y MySQL, medidas con timer-sql-check) y el documental es MongoDB; el sobre guardado de un
 * lote asíncrono es el CUERPO, así que lo que el mensaje lea de la ruta o estampe de la petición no viajaría al trabajo.
 * El mismo criterio que keel-spring.
 */
export function batchJobStackErrors(model, messageComponents) {
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
  for (const operation of asyncOperations(model)) {
    if ((operation.pathParams ?? []).length > 0) {
      errors.push(
        `use-cases: ${operation.name}.batch (execution: async, DSL 2.30): el trabajo guarda el CUERPO de la petición, y su ruta ` +
          `(${operation.route.path}) lleva parámetros que no viajarían al procesarlo. Quita los parámetros de la ruta o declara execution: sync.`
      );
    }
    for (const component of messageComponents(model, operation)) {
      if (component.resolvedIdentity || component.expectedVersions || component.readScope) {
        errors.push(
          `use-cases: ${operation.name}.batch (execution: async, DSL 2.30): el mensaje lleva '${component.name}', que estampa la ` +
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
  return [
    { path: BATCH_JOB_STORE_TS, content: storeFile(model) },
    document ? { path: MONGO_BATCH_JOB_STORE_TS, content: mongoStoreFile(model) } : { path: SQL_BATCH_JOB_STORE_TS, content: sqlStoreFile(model) },
    ...(document ? [] : [{ path: BATCH_JOB_ORM_TS, content: ormFile(model) }]),
    { path: BATCH_SETTINGS_TS, content: settingsFile(model) },
    { path: BATCH_JOB_STEPS_TS, content: stepsFile(model) },
    ...(usesAsyncBatchJobs(model)
      ? [
          { path: BATCH_JOBS_TS, content: jobsFile(model) },
          { path: BATCH_JOB_RUNNER_TS, content: runnerFile(model) },
          ...asyncOperations(model).map((operation) => ({ path: batchJobPath(operation), content: jobHandlerFile(model, operation) }))
        ]
      : []),
    ...(usesKeyedBatches(model) ? [{ path: KEYED_BATCHES_TS, content: keyedFile(model) }] : []),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/batch.yaml`, content: batchYaml(model, profile) }))
  ];
}

// ─── Lo que enlazan los demás módulos ────────────────────────────────────────

/** Las tablas, para el DataSource (relacional). */
export function batchJobEntities(model) {
  if (!usesBatchJobs(model) || isDocument(model)) return [];
  return [
    { symbol: 'BatchJobOrm', from: BATCH_JOB_ORM_TS },
    { symbol: 'BatchItemResultOrm', from: BATCH_JOB_ORM_TS }
  ];
}

/** El almacén en el módulo de persistencia: `{ imports, bindings, exports }`. */
export function batchJobBindings(model) {
  if (!usesBatchJobs(model)) return { imports: [], bindings: [], exports: [] };
  const impl = isDocument(model) ? 'MongoBatchJobStore' : 'SqlBatchJobStore';
  return {
    imports: [
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS },
      { symbol: impl, from: isDocument(model) ? MONGO_BATCH_JOB_STORE_TS : SQL_BATCH_JOB_STORE_TS }
    ],
    bindings: [`    { provide: BatchJobStore, useClass: ${impl} }`],
    exports: ['BatchJobStore']
  };
}

/** Lo que el cronómetro ofrece además a los lotes (TimerModule, global): `{ imports, providers, exports }`. */
export function batchJobTimerProviders(model) {
  if (!usesBatchJobs(model)) return { imports: [], providers: [], exports: [] };
  const classes = [
    ...(usesAsyncBatchJobs(model) ? [{ symbol: 'BatchJobs', from: BATCH_JOBS_TS }, { symbol: 'BatchJobRunner', from: BATCH_JOB_RUNNER_TS }] : []),
    ...(usesKeyedBatches(model) ? [{ symbol: 'KeyedBatches', from: KEYED_BATCHES_TS }] : [])
  ];
  return {
    imports: [{ symbol: 'BATCH_SETTINGS', from: BATCH_SETTINGS_TS }, { symbol: 'batchSettings', from: BATCH_SETTINGS_TS }, ...classes],
    providers: ['{ provide: BATCH_SETTINGS, useValue: batchSettings(configuration) }', ...classes.map((entry) => entry.symbol)],
    exports: ['BATCH_SETTINGS', ...classes.map((entry) => entry.symbol)]
  };
}

/** Las colecciones y sus índices, para DOCUMENT_INDEXES (document-indexes.ts). */
export function batchJobDocumentIndexEntries(model) {
  if (!usesBatchJobs(model) || !isDocument(model)) return [];
  return Object.values(BATCH_JOB_COLLECTIONS).map(({ collection, indexes }) => {
    const lines = indexes.map((spec) => {
      const keys = spec.keys.map(([key, direction]) => `${tsString(key)}: ${direction}`).join(', ');
      const options = [`name: ${tsString(spec.name)}`];
      if (spec.unique) options.push('unique: true');
      if (spec.partialFilter) {
        const [field, condition] = Object.entries(spec.partialFilter)[0];
        options.push(`partialFilterExpression: { ${tsString(field)}: { $type: ${tsString(condition.$type)} } }`);
      }
      return `      { keys: { ${keys} }, options: { ${options.join(', ')} } }`;
    });
    return `  {\n    collection: ${tsString(collection)},\n    indexes: [\n${lines.join(',\n')}\n    ]\n  }`;
  });
}

/** La purga de `batch_job` como recurrente del cronómetro (la emite timer.js con su nombre de clase). */
export function batchPurgeTimerBody(className, kindConstant) {
  return {
    imports: [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
      { symbol: 'RecurringTimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'BATCH_SETTINGS', from: BATCH_SETTINGS_TS },
      { symbol: 'BatchSettings', from: BATCH_SETTINGS_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS }
    ],
    body: `/**
 * La purga de los trabajos terminados de los lotes asíncronos (DSL 2.30, D10): los que acabaron hace más de
 * \`${BATCH_PARAMETERS.retentionDays.key}\` días, con sus resultados. Un trabajo en marcha no se purga nunca. Es un recurrente
 * del cronómetro en modo clúster (\`${BATCH_PARAMETERS.purgeCron.key}\`): cada tick lo ejecuta UNA réplica.
 */
@Injectable()
export class ${className} implements RecurringTimerHandler {
  readonly kind = TimerKinds.${kindConstant};
  readonly spec: string;

  constructor(
    @Inject(BatchJobStore) private readonly store: BatchJobStore,
    @Inject(BATCH_SETTINGS) private readonly settings: BatchSettings
  ) {
    this.spec = settings.purgeCron;
  }

  async tick(): Promise<void> {
    await this.store.purge(this.settings.retentionDays);
  }
}`
  };
}

// ─── La configuración ────────────────────────────────────────────────────────

/**
 * config/parameters/<perfil>/batch.yaml: la mecánica de los lotes con trabajo (keel-core/gen/batch-store.js, la misma clave
 * y variable en los cuatro generadores). Es, línea a línea, el `batch.yaml` de keel-spring: el chunk solo con lotes
 * asíncronos; el umbral del lote muerto, solo con lotes síncronos con clave (D15).
 */
export function batchYaml(model, profile) {
  const asynchronous = asyncBatchOperations(model).length > 0;
  const keyed = usesKeyedBatches(model);
  const lines = asynchronous
    ? [
        '# Los lotes asíncronos (DSL 2.30): cuántos elementos procesa cada disparo y cuánto vive un trabajo terminado.',
        '# El chunk tiene que caber en el arriendo del cronómetro (timer.lease-ms): uno más lento lo tomaría otra réplica.'
      ]
    : ['# Los lotes con clave (DSL 2.30): cuánto vive un trabajo terminado.'];
  if (keyed) {
    lines.push('# Un lote síncrono con clave sin terminar que nadie escribe desde hace más de sync-stale-ms se da por muerto, y su repetición lo sigue desde el cursor.');
  }
  lines.push('batch:');
  const parameters = [
    ...Object.entries(BATCH_PARAMETERS).filter(([name]) => asynchronous || name !== 'chunkSize').map(([, parameter]) => parameter),
    ...(keyed ? [BATCH_SYNC_STALE] : [])
  ];
  let parent = null;
  for (const parameter of parameters) {
    const segments = parameter.key.split('.');
    if (segments.length === 3 && parent !== segments[1]) {
      parent = segments[1];
      lines.push(`  ${parent}:`);
    }
    const rendered = parameter.cron ? cronWithDefault(profile, parameter.env, parameter.default) : envWithDefault(profile, parameter.env, parameter.default);
    lines.push(`${'  '.repeat(segments.length - 1)}${segments.at(-1)}: ${rendered}`);
  }
  return `${lines.join('\n')}\n`;
}

function settingsFile(model) {
  const P = BATCH_PARAMETERS;
  const keyed = usesKeyedBatches(model);
  return tsModule(
    BATCH_SETTINGS_TS,
    [{ symbol: 'Configuration', from: CONFIG_TS, type: true }],
    `/** Token de la configuración de los lotes asíncronos ya resuelta. */
export const BATCH_SETTINGS = Symbol('BATCH_SETTINGS');

/** La mecánica de los lotes asíncronos: la de keel-core (BATCH_PARAMETERS), con las mismas claves y defaults en los cuatro. */
export interface BatchSettings {
  /** Cuántos elementos procesa cada disparo del temporizador de un trabajo (D9). Por debajo del arriendo del cronómetro. */
  readonly chunkSize: number;
  /** Cuántos días vive un trabajo TERMINADO con sus resultados (D10). */
  readonly retentionDays: number;
  /** El cron (seis campos, en UTC) de su purga. */
  readonly purgeCron: string;${
    keyed
      ? `
  /** Cuántos milisegundos sin escribir dan por muerto un lote síncrono con clave sin terminar (D15). */
  readonly syncStaleMs: number;`
      : ''
  }
}

/** Lee los lotes del perfil. Un valor que no es un entero positivo no deja arrancar. */
export function batchSettings(configuration: Configuration): BatchSettings {
  return {
    chunkSize: positive(configuration, ${tsString(P.chunkSize.key)}, ${P.chunkSize.default}),
    retentionDays: positive(configuration, ${tsString(P.retentionDays.key)}, ${P.retentionDays.default}),
    purgeCron: text(configuration, ${tsString(P.purgeCron.key)}, ${tsString(P.purgeCron.default)})${
      keyed ? `,\n    syncStaleMs: positive(configuration, ${tsString(BATCH_SYNC_STALE.key)}, ${BATCH_SYNC_STALE.default})` : ''
    }
  };
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = configuration.get(key);
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${String(value)}'\`);
  return parsed;
}

function text(configuration: Configuration, key: string, fallback: string): string {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}`
  );
}

// ─── El almacén ──────────────────────────────────────────────────────────────

function storeFile(model) {
  const keyed = usesKeyedBatches(model)
    ? `

  /**
   * La repetición de un lote síncrono con clave sin terminar (D15): lo toma si nadie lo escribe desde hace más de
   * \`staleMs\` (con la hora de la base). false: sigue en marcha.
   */
  abstract takeOver(id: string, staleMs: number): Promise<boolean>;

  /** El todo o nada con clave que falla: borra su trabajo sin terminar, y la repetición lo vuelve a procesar. */
  abstract discard(id: string): Promise<boolean>;`
    : '';
  return tsModule(
    BATCH_JOB_STORE_TS,
    [],
    `/** Un trabajo, como está en la tabla. \`nextIndex\` es el cursor: todo elemento por debajo tiene su resultado. */
export interface BatchJob {
  readonly id: string;
  readonly operation: string;
  readonly owner: string;
  readonly status: string;
  readonly input: string;
  readonly total: number;
  readonly nextIndex: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

/** El resultado de un elemento intentado, con \`result\` serializado con las reglas del cable. */
export interface BatchJobResult {
  readonly index: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly result: string | null;
}

/** El trabajo vivo de una clave de idempotencia (D13). */
export interface BatchJobKeyHit {
  readonly id: string;
  readonly signature: string | null;
}

/**
 * Los trabajos de los lotes asíncronos (DSL 2.30) y sus resultados (\`${BATCH_JOB.table}\` y \`${BATCH_ITEM_RESULT.table}\`),
 * detrás de un puerto: las sentencias son las de keel-core, iguales en los cuatro generadores, y toda hora es la de la base.
 *
 * Se une a la transacción en curso: el alta va con el temporizador del trabajo, y el resultado y el avance de cada elemento
 * con su efecto (D9).
 */
export abstract class BatchJobStore {
  /** El trabajo vivo de esa clave: el que la tiene y cuya ventana no pasó. */
  abstract byKey(operation: string, owner: string, key: string): Promise<BatchJobKeyHit | null>;

  /** Libera la clave si su ventana pasó: el alta siguiente la puede tomar, y el trabajo viejo sigue legible por su id. */
  abstract releaseKey(operation: string, owner: string, key: string): Promise<void>;

  /** Da de alta un trabajo en \`${BATCH_JOB_STATUSES.queued}\`, con el cursor en 0. \`ttlMs\` null: la clave no caduca. */
  abstract insert(id: string, operation: string, owner: string, key: string | null, signature: string | null, ttlMs: number | null, input: string, total: number): Promise<void>;

  /** Lo que lee el procesador. */
  abstract job(id: string): Promise<BatchJob | null>;

  /** Lo que leen las dos rutas (D11): de otro dueño u otra operación es como si no existiera. */
  abstract owned(id: string, operation: string, owner: string): Promise<BatchJob | null>;

  /** Avanza el cursor desde \`index\`, con los contadores. false: el cursor ya no estaba ahí (la valla, D9). */
  abstract advance(id: string, index: number, succeeded: number, failed: number): Promise<boolean>;

  /** El resultado de un elemento. */
  abstract insertResult(jobId: string, index: number, status: string, errorCode: string | null, message: string | null, result: string | null): Promise<void>;

  /** Cierra el trabajo (${BATCH_JOB_STATUSES.completed} o ${BATCH_JOB_STATUSES.aborted}), una sola vez. */
  abstract finish(id: string, status: string): Promise<boolean>;

  /** Los resultados, en orden de índice. */
  abstract results(jobId: string, limit: number, offset: number): Promise<BatchJobResult[]>;

  abstract resultsCount(jobId: string): Promise<number>;

  /** La purga (D10): los trabajos terminados hace más de \`retentionDays\`, con sus resultados. Nunca uno en marcha. */
  abstract purge(retentionDays: number): Promise<number>;${keyed}
}`
  );
}

const SQL_NAMES = ['insertJob', 'byKey', 'releaseKey', 'job', 'ownedJob', 'insertResult', 'advance', 'finish', 'resultsPage', 'resultsCount', 'purgeResults', 'purgeJobs'];

function sqlStoreFile(model) {
  const engine = model.stack.database;
  const mysql = engine === 'mysql';
  const keyed = usesKeyedBatches(model);
  const S = { ...batchStatements(engine), ...(keyed ? batchSyncStatements(engine) : {}) };
  const names = [...SQL_NAMES, ...(keyed ? ['takeOver', 'discardJob'] : [])];
  const keyedMethods = keyed
    ? `

  async takeOver(id: string, staleMs: number): Promise<boolean> {
    return (await this.exec(SQL.takeOver, { id: uuid(id), staleMs })).affected === 1;
  }

  async discard(id: string): Promise<boolean> {
    return (await this.exec(SQL.discardJob, { id: uuid(id) })).affected === 1;
  }`
    : '';
  const codec = mysql
    ? `// MySQL: el uuid es binary(16) (el orden de bytes de Hibernate y del UUID_BINARY de las entidades) y la hora un
// datetime(6) con la hora UTC; el driver convierte un Date en los dos sentidos con \`timezone: 'Z'\`.
function uuid(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function readUuid(value: unknown): string {
  const hex = Buffer.isBuffer(value) ? value.toString('hex') : String(value).replaceAll('-', '');
  return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
}

/** \`?\`: el estilo de mysql2. */
const marker = (_position: number): string => '?';`
    : `// PostgreSQL: uuid nativo y timestamp with time zone; el driver convierte un Date en los dos sentidos.
function uuid(value: string): string {
  return value;
}

function readUuid(value: unknown): string {
  return String(value);
}

/** \`$n\`: el estilo de node-postgres. */
const marker = (position: number): string => \`$\${position}\`;`;
  return tsModule(
    SQL_BATCH_JOB_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'EntityManager', from: 'typeorm', type: true },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'BatchJob', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobKeyHit', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobResult', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS }
    ],
    `/**
 * Las sentencias de los lotes asíncronos de keel-core (\`batch-store.js\`) para ${mysql ? 'MySQL' : 'PostgreSQL'}, TAL CUAL: son contrato
 * con los otros generadores, que comparten las tablas, y las mide \`timer-sql-check\` contra el motor. No las reescribas
 * aquí. Llevan marcadores nombrados (\`:id\`); \`bind\` los pasa al estilo del driver al ejecutar.
 */
const SQL = {
${names.map((name) => `  ${name}: ${tsString(S[name])}`).join(',\n')}
} as const;

${codec}

/** Los marcadores nombrados al estilo del driver, en orden de aparición (uno repetido se pasa dos veces). */
function bind(sql: string, values: Readonly<Record<string, unknown>>): [string, unknown[]] {
  const params: unknown[] = [];
  const text = sql.replace(/(?<![:\\w]):([a-zA-Z][a-zA-Z0-9]*)/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(\`Falta el valor de :\${name} en una sentencia de los lotes\`);
    params.push(values[name]);
    return marker(params.length);
  });
  return [text, params];
}

function readJob(row: Record<string, unknown>): BatchJob {
  return {
    id: readUuid(row['id']),
    operation: String(row['operation']),
    owner: String(row['owner']),
    status: String(row['status']),
    input: String(row['input']),
    total: Number(row['total']),
    nextIndex: Number(row['next_index']),
    succeeded: Number(row['succeeded']),
    failed: Number(row['failed']),
    createdAt: new Date(row['created_at'] as Date | string),
    finishedAt: row['finished_at'] == null ? null : new Date(row['finished_at'] as Date | string)
  };
}

/**
 * Los trabajos de los lotes asíncronos sobre ${mysql ? 'MySQL' : 'PostgreSQL'}: SQL a pelo por la transacción en curso
 * (TransactionContext), o por una propia si no la hay.
 */
@Injectable()
export class SqlBatchJobStore extends BatchJobStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }

  /** Ejecuta una sentencia en la transacción en curso: sus filas y cuántas tocó. */
  private async run(manager: EntityManager, sql: string, values: Readonly<Record<string, unknown>>): Promise<{ records: Record<string, unknown>[]; affected: number }> {
    const [text, params] = bind(sql, values);
    const runner = manager.queryRunner;
    if (runner == null) throw new Error('Los lotes ejecutan sus sentencias dentro de una transacción');
    const result = await runner.query(text, params, true);
    const records = Array.isArray(result.records) ? (result.records as Record<string, unknown>[]) : [];
    return { records, affected: Number(result.affected ?? 0) };
  }

  private exec(sql: string, values: Readonly<Record<string, unknown>>): Promise<{ records: Record<string, unknown>[]; affected: number }> {
    return this.transactions.inTransaction((manager) => this.run(manager, sql, values));
  }

  async byKey(operation: string, owner: string, key: string): Promise<BatchJobKeyHit | null> {
    const row = (await this.exec(SQL.byKey, { operation, owner, key })).records[0];
    return row == null ? null : { id: readUuid(row['id']), signature: row['signature'] == null ? null : String(row['signature']) };
  }

  async releaseKey(operation: string, owner: string, key: string): Promise<void> {
    await this.exec(SQL.releaseKey, { operation, owner, key });
  }

  async insert(id: string, operation: string, owner: string, key: string | null, signature: string | null, ttlMs: number | null, input: string, total: number): Promise<void> {
    await this.exec(SQL.insertJob, { id: uuid(id), operation, owner, key, signature, ttlMs, input, total });
  }

  async job(id: string): Promise<BatchJob | null> {
    const row = (await this.exec(SQL.job, { id: uuid(id) })).records[0];
    return row == null ? null : readJob(row);
  }

  async owned(id: string, operation: string, owner: string): Promise<BatchJob | null> {
    const row = (await this.exec(SQL.ownedJob, { id: uuid(id), operation, owner })).records[0];
    return row == null ? null : readJob(row);
  }

  async advance(id: string, index: number, succeeded: number, failed: number): Promise<boolean> {
    return (await this.exec(SQL.advance, { id: uuid(id), index, succeeded, failed })).affected === 1;
  }

  async insertResult(jobId: string, index: number, status: string, errorCode: string | null, message: string | null, result: string | null): Promise<void> {
    await this.exec(SQL.insertResult, { jobId: uuid(jobId), index, status, errorCode, message, result });
  }

  async finish(id: string, status: string): Promise<boolean> {
    return (await this.exec(SQL.finish, { id: uuid(id), status })).affected === 1;
  }

  async results(jobId: string, limit: number, offset: number): Promise<BatchJobResult[]> {
    const rows = (await this.exec(SQL.resultsPage, { jobId: uuid(jobId), limit, offset })).records;
    return rows.map((row) => ({
      index: Number(row['item_index']),
      status: String(row['status']),
      errorCode: row['error_code'] == null ? null : String(row['error_code']),
      message: row['message'] == null ? null : String(row['message']),
      result: row['result'] == null ? null : String(row['result'])
    }));
  }

  async resultsCount(jobId: string): Promise<number> {
    const row = (await this.exec(SQL.resultsCount, { jobId: uuid(jobId) })).records[0];
    return Number(Object.values(row ?? {})[0] ?? 0);
  }

  async purge(retentionDays: number): Promise<number> {
    return this.transactions.inTransaction(async (manager) => {
      await this.run(manager, SQL.purgeResults, { retentionDays });
      return (await this.run(manager, SQL.purgeJobs, { retentionDays })).affected;
    });
  }${keyedMethods}
}`
  );
}

/** Las dos tablas, mapeadas SOLO para el esquema (como keel_timer y el historial): las crea el ORM y entran en el baseline. */
function ormFile(model) {
  const engine = model.stack.database;
  const transformers = new Set();
  const types = { timestamp: 'Date', int: 'number' };
  const property = (name) => name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  const fieldsOf = (table) =>
    table.columns.map((column) => {
      const physical = physicalColumn(column, engine);
      for (const symbol of physical.imports ?? []) transformers.add(symbol);
      const options = { name: column.name, ...physical.options, nullable: column.nullable };
      if (physical.transformer) options.transformer = physical.transformer;
      if (column.primary) delete options.nullable;
      const type = types[column.base] ?? 'string';
      return `  @${column.primary ? 'PrimaryColumn' : 'Column'}(${optionsLiteral(options)})\n  ${property(column.name)}!: ${column.nullable ? `${type} | null` : type};`;
    });
  const unique = BATCH_JOB.uniques[0];
  const index = BATCH_JOB.indexes[0];
  const fk = BATCH_ITEM_RESULT.columns.find((column) => column.references).references;
  const jobFields = fieldsOf(BATCH_JOB);
  const resultFields = fieldsOf(BATCH_ITEM_RESULT);
  return tsModule(
    BATCH_JOB_ORM_TS,
    [
      { symbol: 'Column', from: 'typeorm' },
      { symbol: 'Entity', from: 'typeorm' },
      { symbol: 'Index', from: 'typeorm' },
      { symbol: 'JoinColumn', from: 'typeorm' },
      { symbol: 'ManyToOne', from: 'typeorm' },
      { symbol: 'PrimaryColumn', from: 'typeorm' },
      { symbol: 'Relation', from: 'typeorm', type: true },
      { symbol: 'Unique', from: 'typeorm' },
      ...[...transformers].map((symbol) => ({ symbol, from: TRANSFORMERS_TS }))
    ],
    `/**
 * Los trabajos de los lotes asíncronos, mapeados SOLO para el esquema: así los crea el ORM en \`local\` (synchronize),
 * entran en el baseline que exporta el pase de calidad y, en una base ya desplegada, en el paso de esquema de build. Nadie
 * los lee por el ORM: los usa SqlBatchJobStore, con las sentencias de keel-core. Columnas, unicidad e índice son los de
 * keel-core (\`BATCH_JOB\`): los comparten los cuatro generadores.
 */
@Entity({ name: '${BATCH_JOB.table}' })
@Unique(${tsString(unique.name)}, [${unique.columns.map((name) => tsString(property(name))).join(', ')}])
@Index(${tsString(index.name)}, [${index.columns.map((name) => tsString(property(name))).join(', ')}])
export class BatchJobOrm {
${jobFields.join('\n\n')}
}

/** Un resultado por elemento intentado; se va con su trabajo (ON DELETE CASCADE). Mapeada solo para el esquema. */
@Entity({ name: '${BATCH_ITEM_RESULT.table}' })
export class BatchItemResultOrm {
${resultFields.join('\n\n')}

  @ManyToOne(() => BatchJobOrm, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id', foreignKeyConstraintName: ${tsString(fk.name)} })
  job?: Relation<BatchJobOrm>;
}`
  );
}

function mongoStoreFile(model) {
  const { job, result } = BATCH_JOB_COLLECTIONS;
  const keyedMethods = usesKeyedBatches(model)
    ? `

  async takeOver(id: string, staleMs: number): Promise<boolean> {
    const now = await this.dbNow();
    const updated = await this.jobs.updateOne(
      { _id: id, finished_at: null, updated_at: { $lte: new Date(now.getTime() - staleMs) } },
      { $set: { updated_at: now } },
      { session: this.session }
    );
    return updated.modifiedCount === 1;
  }

  async discard(id: string): Promise<boolean> {
    return (await this.jobs.deleteOne({ _id: id, finished_at: null }, { session: this.session })).deletedCount === 1;
  }`
    : '';
  return tsModule(
    MONGO_BATCH_JOB_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'KeyedDocument', from: 'src/infrastructure/persistence/bson-values.ts', type: true },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'BatchJob', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobKeyHit', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobResult', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS }
    ],
    `const JOBS = ${tsString(job.collection)};
const RESULTS = ${tsString(result.collection)};
const DAY_MS = 24 * 60 * 60 * 1000;

function readJob(document: KeyedDocument<string>): BatchJob {
  return {
    id: String(document._id),
    operation: String(document['operation']),
    owner: String(document['owner']),
    status: String(document['status']),
    input: String(document['input']),
    total: Number(document['total']),
    nextIndex: Number(document['next_index']),
    succeeded: Number(document['succeeded']),
    failed: Number(document['failed']),
    createdAt: document['created_at'] as Date,
    finishedAt: (document['finished_at'] as Date | null | undefined) ?? null
  };
}

/**
 * Los trabajos de los lotes asíncronos sobre MongoDB, con la forma documental de keel-core (\`BATCH_JOB_COLLECTIONS\`): los
 * nombres de campo son los de las columnas, el trabajo lleva su id (texto) en \`_id\` y cada resultado la clave aplanada
 * \`<job>|<índice>\`, que hace que el motor rechace un segundo resultado del mismo elemento. La unicidad de la clave de
 * idempotencia es PARCIAL (document-indexes.ts): en MongoDB dos ausentes sí chocan.
 *
 * Por la sesión de la transacción en curso (TransactionContext). La hora es la del servidor ($$NOW), como la del
 * cronómetro.
 */
@Injectable()
export class MongoBatchJobStore extends BatchJobStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }

  /** La hora del servidor, sin la sesión de la transacción en curso (como MongoTimerStore.dbNow). */
  private async dbNow(): Promise<Date> {
    const now = await this.transactions.db().aggregate([{ $documents: [{ now: '$$NOW' }] }]).next();
    return now?.now as Date;
  }

  private get jobs(): Collection<KeyedDocument<string>> {
    return this.transactions.collection(JOBS);
  }

  private get itemResults(): Collection<KeyedDocument<string>> {
    return this.transactions.collection(RESULTS);
  }

  private get session() {
    return this.transactions.session();
  }

  async byKey(operation: string, owner: string, key: string): Promise<BatchJobKeyHit | null> {
    const now = await this.dbNow();
    const found = await this.jobs.findOne(
      { operation, owner, idempotency_key: key, $or: [{ key_expires_at: null }, { key_expires_at: { $gt: now } }] },
      { session: this.session }
    );
    return found == null ? null : { id: String(found._id), signature: (found['signature'] as string | null | undefined) ?? null };
  }

  async releaseKey(operation: string, owner: string, key: string): Promise<void> {
    const now = await this.dbNow();
    await this.jobs.updateMany({ operation, owner, idempotency_key: key, key_expires_at: { $lte: now } }, { $unset: { idempotency_key: '' } }, { session: this.session });
  }

  async insert(id: string, operation: string, owner: string, key: string | null, signature: string | null, ttlMs: number | null, input: string, total: number): Promise<void> {
    const now = await this.dbNow();
    await this.jobs.insertOne(
      {
        _id: id,
        operation,
        owner,
        status: '${BATCH_JOB_STATUSES.queued}',
        // Sin clave el campo no existe: el índice parcial solo mira los trabajos que tienen una.
        ...(key != null ? { idempotency_key: key } : {}),
        signature,
        key_expires_at: ttlMs == null ? null : new Date(now.getTime() + ttlMs),
        input,
        total,
        next_index: 0,
        succeeded: 0,
        failed: 0,
        created_at: now,
        updated_at: now,
        finished_at: null
      },
      { session: this.session }
    );
  }

  async job(id: string): Promise<BatchJob | null> {
    const found = await this.jobs.findOne({ _id: id }, { session: this.session });
    return found == null ? null : readJob(found);
  }

  async owned(id: string, operation: string, owner: string): Promise<BatchJob | null> {
    const found = await this.jobs.findOne({ _id: id, operation, owner }, { session: this.session });
    return found == null ? null : readJob(found);
  }

  async advance(id: string, index: number, succeeded: number, failed: number): Promise<boolean> {
    const now = await this.dbNow();
    const updated = await this.jobs.updateOne(
      { _id: id, next_index: index },
      { $inc: { next_index: 1, succeeded, failed }, $set: { status: '${BATCH_JOB_STATUSES.running}', updated_at: now } },
      { session: this.session }
    );
    return updated.modifiedCount === 1;
  }

  async insertResult(jobId: string, index: number, status: string, errorCode: string | null, message: string | null, result: string | null): Promise<void> {
    await this.itemResults.insertOne(
      { _id: \`\${jobId}|\${index}\`, job_id: jobId, item_index: index, status, error_code: errorCode, message, result },
      { session: this.session }
    );
  }

  async finish(id: string, status: string): Promise<boolean> {
    const now = await this.dbNow();
    const updated = await this.jobs.updateOne({ _id: id, finished_at: null }, { $set: { status, finished_at: now, updated_at: now } }, { session: this.session });
    return updated.modifiedCount === 1;
  }

  async results(jobId: string, limit: number, offset: number): Promise<BatchJobResult[]> {
    const documents = await this.itemResults.find({ job_id: jobId }, { session: this.session }).sort({ item_index: 1 }).skip(offset).limit(limit).toArray();
    return documents.map((document) => ({
      index: Number(document['item_index']),
      status: String(document['status']),
      errorCode: (document['error_code'] as string | null | undefined) ?? null,
      message: (document['message'] as string | null | undefined) ?? null,
      result: (document['result'] as string | null | undefined) ?? null
    }));
  }

  resultsCount(jobId: string): Promise<number> {
    return this.itemResults.countDocuments({ job_id: jobId }, { session: this.session });
  }

  async purge(retentionDays: number): Promise<number> {
    const before = new Date((await this.dbNow()).getTime() - retentionDays * DAY_MS);
    return this.transactions.inTransaction(async (session) => {
      const ids = (await this.jobs.find({ finished_at: { $ne: null, $lt: before } }, { session, projection: { _id: 1 } }).toArray()).map((document) => document._id);
      if (ids.length === 0) return 0;
      await this.itemResults.deleteMany({ job_id: { $in: ids } }, { session });
      return (await this.jobs.deleteMany({ _id: { $in: ids } }, { session })).deletedCount;
    });
  }${keyedMethods}
}`
  );
}

// ─── El alta y las dos rutas ─────────────────────────────────────────────────

function jobsFile(model) {
  const notFound = FRAMEWORK_ERRORS.batchJobNotFound;
  return tsModule(
    BATCH_JOBS_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'NotFoundException', from: classPath(ERRORS_DIR, 'NotFoundException') },
      { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
      { symbol: 'BatchItem', from: BATCH_TS, type: true },
      { symbol: 'BatchSummary', from: BATCH_TS },
      { symbol: 'PagedResponse', from: PAGED_RESPONSE_TS },
      { symbol: 'Pageable', from: PAGE_TS, type: true },
      { symbol: 'pageOf', from: PAGE_TS },
      { symbol: 'BatchJobKeyReusedException', from: BATCH_JOB_STEPS_TS },
      { symbol: 'storedItem', from: BATCH_JOB_STEPS_TS },
      { symbol: 'batchSignature', from: BATCH_JOB_STEPS_TS },
      { symbol: 'readBatchEnvelope', from: BATCH_JOB_STEPS_TS },
      { symbol: 'Uuids', from: UUIDS_TS },
      { symbol: 'currentActor', from: AUDIT_ACTOR_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'TimerStore', from: TIMER_STORE_TS },
      { symbol: 'BatchJob', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS }
    ],
    `/**
 * El trabajo de un lote asíncrono en el cable (DSL 2.30, wire-contract.md § Lotes asíncronos): su estado y su resumen.
 * \`notAttempted\` solo cuenta en un trabajo \`${BATCH_JOB_STATUSES.aborted}\`: lo que queda por procesar de uno en marcha no
 * se ha intentado todavía, pero tampoco se ha descartado (\`batchJobView\` de keel-core). Sus claves salen siempre.
 */
export class BatchJobView {
  private constructor(
    readonly id: string,
    readonly status: string,
    readonly summary: BatchSummary,
    readonly createdAt: Date,
    readonly finishedAt: Date | null
  ) {}

  static of(job: BatchJob): BatchJobView {
    const notAttempted = job.status === '${BATCH_JOB_STATUSES.aborted}' ? job.total - job.nextIndex : 0;
    return new BatchJobView(job.id, job.status, new BatchSummary(job.total, job.succeeded, job.failed, notAttempted), job.createdAt, job.finishedAt);
  }
}

/**
 * El trabajo de un lote asíncrono que no existe, que ya se purgó o que creó OTRO llamante (D11): los tres casos responden
 * igual, para no decirle a nadie que un trabajo ajeno existe. Su code es del framework (docs/framework-errors.md).
 */
export class BatchJobNotFoundException extends NotFoundException {
  constructor(jobId: string) {
    super(\`No hay ningún trabajo \${jobId}\`, { code: ${tsString(notFound.code)}, httpStatus: ${notFound.http}, args: [jobId] });
  }
}

/**
 * Los lotes asíncronos (DSL 2.30, fase B) vistos desde la API: el alta del trabajo y las dos rutas que lo leen.
 *
 * El alta (D8) no procesa nada: lee el sobre con el lector de la operación (un sobre mal formado es un 400 sin trabajo,
 * BJ-9), resuelve la clave del lote (D13) y crea el trabajo y su temporizador de una vez en UNA transacción. Responde
 * ${BATCH_ACCEPTED_STATUS} con el trabajo; el controlador pone su URL en Location.
 *
 * Solo lee un trabajo quien lo creó (D11): el dueño es el actor de autoría de la petición, y lo ajeno, lo purgado y lo
 * inexistente responden igual, ${notFound.code}.
 *
 * No lo edites: lo regenera build.
 */
@Injectable()
export class BatchJobs {
  constructor(
    @Inject(BatchJobStore) private readonly store: BatchJobStore,
    @Inject(TimerStore) private readonly timers: TimerStore,
    @Inject(TransactionContext) private readonly transactions: TransactionContext
  ) {}

  /**
   * El alta de un trabajo. \`body\` es el texto del cuerpo tal como llegó: su firma es la de la petición (D13) y el trabajo
   * lo guarda para leer cada elemento al procesarlo. \`clientKey\` es la cabecera ${IDEMPOTENCY_HEADER} (null si no llega o si la
   * clave es el contenido); \`ttlSeconds\`, la ventana de la clave.
   */
  async submit<E>(
    operation: string,
    kind: string,
    body: string,
    readEnvelope: (body: unknown) => E,
    itemsOf: (envelope: E) => readonly unknown[],
    keySource: string | null,
    clientKey: string | null,
    ttlSeconds: number | null
  ): Promise<BatchJobView> {
    const total = itemsOf(readBatchEnvelope(body, readEnvelope)).length;
    const owner = currentActor();
    const signature = batchSignature(body);
    const key = keySource === 'payload-hash' ? signature : keySource == null ? null : clientKey;
    const ttlMs = key == null || ttlSeconds == null ? null : ttlSeconds * 1000;
    let id: string;
    try {
      id = await this.transactions.inTransaction(() => this.accept(operation, kind, owner, key, signature, ttlMs, body, total));
    } catch (error) {
      if (error instanceof DomainException || key == null) throw error;
      // Dos altas con la misma clave a la vez: la que pierde choca con la unicidad del motor y responde el trabajo de la
      // ganadora, sin el 409 «en curso» (D13).
      const winner = await this.transactions.inTransaction(() => this.repeat(operation, owner, key, signature));
      if (winner == null) throw error;
      id = winner;
    }
    const job = await this.store.job(id);
    if (job == null) throw new BatchJobNotFoundException(id);
    return BatchJobView.of(job);
  }

  private async accept(operation: string, kind: string, owner: string, key: string | null, signature: string, ttlMs: number | null, input: string, total: number): Promise<string> {
    if (key != null) {
      await this.store.releaseKey(operation, owner, key);
      const same = await this.repeat(operation, owner, key, signature);
      if (same != null) return same;
    }
    const id = Uuids.v7();
    await this.store.insert(id, operation, owner, key, signature, ttlMs, input, total);
    // El temporizador de UNA vez del trabajo, para ya: lo reclama el cronómetro con su arriendo y su valla.
    await this.timers.arm(kind, id, await this.timers.dbNow());
    return id;
  }

  /** El trabajo vivo de la clave (D13): el mismo si la firma casa, la clave reutilizada si no. */
  private async repeat(operation: string, owner: string, key: string, signature: string): Promise<string | null> {
    const hit = await this.store.byKey(operation, owner, key);
    if (hit == null) return null;
    if (hit.signature !== signature) throw new BatchJobKeyReusedException(operation, key);
    return hit.id;
  }

  /** El trabajo, si es de quien llama. */
  async status(operation: string, jobId: string): Promise<BatchJobView> {
    return BatchJobView.of(await this.owned(operation, jobId));
  }

  /** Los resultados de los elementos intentados, en orden de índice, con el sobre de página del cable. */
  async results(operation: string, jobId: string, pageable: Pageable): Promise<PagedResponse<BatchItem>> {
    const job = await this.owned(operation, jobId);
    const rows = await this.store.results(job.id, pageable.size, pageable.page * pageable.size);
    const items = rows.map(storedItem);
    const page = pageOf(items, pageable, await this.store.resultsCount(job.id));
    return new PagedResponse(page.items, page.page, page.size, page.totalElements, page.totalPages);
  }

  private async owned(operation: string, jobId: string): Promise<BatchJob> {
    const job = await this.store.owned(jobId, operation, currentActor());
    if (job == null) throw new BatchJobNotFoundException(jobId);
    return job;
  }
}`
  );
}

// ─── El procesador ───────────────────────────────────────────────────────────

function runnerFile(model) {
  const { completed } = BATCH_JOB_STATUSES;
  const security = Boolean(model.layersPresent?.security);
  return tsModule(
    BATCH_JOB_RUNNER_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'parseWireJson', from: WIRE_TS },
      ...(security ? [{ symbol: 'SecurityContext', from: SECURITY_CONTEXT_TS }] : []),
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'BATCH_SETTINGS', from: BATCH_SETTINGS_TS },
      { symbol: 'BatchSettings', from: BATCH_SETTINGS_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS },
      { symbol: 'BatchJobSteps', from: BATCH_JOB_STEPS_TS },
      { symbol: 'ClaimedTimer', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerOutcome', from: TIMER_STORE_TS },
      { symbol: 'TimerStore', from: TIMER_STORE_TS }
    ],
    `/**
 * Un disparo del temporizador de un trabajo (DSL 2.30, D9): procesa un CHUNK desde el cursor y dice si queda trabajo
 * (rearmar para ya) o si terminó (borrar el temporizador). Es el *commit interval* y el *restart* de Spring Batch sobre el
 * cronómetro, sin la librería.
 *
 * Cada elemento lo procesa BatchJobSteps: su efecto, el avance del cursor (la valla) y su resultado en UNA transacción. Si
 * otra réplica le quitó el trabajo al vencer su arriendo, el elemento revierte entero y el disparo para. Si la réplica cae
 * a mitad de chunk, lo confirmado queda y el siguiente disparo sigue desde el cursor: ningún elemento se aplica dos veces
 * ni se queda sin resultado. Corre sin token: el actor de autoría de cada elemento es el dueño del trabajo.
 *
 * No lo edites: lo regenera build.
 */
@Injectable()
export class BatchJobRunner {
  private readonly steps: BatchJobSteps;

  constructor(
    @Inject(BatchJobStore) private readonly store: BatchJobStore,
    @Inject(TimerStore) private readonly timers: TimerStore,
    @Inject(TransactionContext) private readonly transactions: TransactionContext,
    @Inject(BATCH_SETTINGS) private readonly settings: BatchSettings
  ) {
    this.steps = new BatchJobSteps(store, transactions);
  }

  /**
   * Un disparo. \`readEnvelope\` vuelve a leer el sobre guardado con el lector de la operación e \`itemsOf\` saca de él la
   * lista que se recorre; \`process\` despacha UN elemento con el resto del sobre y devuelve su result (null si la
   * operación no declara batch.output).
   */
  async runChunk<E, T>(
    timer: ClaimedTimer,
    readEnvelope: (body: unknown) => E,
    itemsOf: (envelope: E) => readonly unknown[],
    readItem: (value: unknown) => T | null,
    itemErrors: ReadonlySet<string>,
    process: (envelope: E, item: T) => Promise<unknown>
  ): Promise<TimerOutcome> {
    const job = await this.store.job(timer.entityId);
    if (job == null || job.finishedAt != null) return TimerOutcome.finished();
    const envelope = readEnvelope(parseWireJson(job.input));
    const values = itemsOf(envelope);
    return asOwner(job.owner, async () => {
      let index = job.nextIndex;
      const end = Math.min(job.total, index + this.settings.chunkSize);
      for (; index < end; index++) {
        const step = await this.steps.process(job.id, index, values[index], readItem, itemErrors, (item) => process(envelope, item));
        // Terminado (D4), o el trabajo es de otra réplica (la valla): este disparo no tiene nada más que hacer.
        if (step !== 'next') return TimerOutcome.finished();
      }
      if (index >= job.total) {
        await this.transactions.inTransaction(() => this.store.finish(job.id, '${completed}'));
        return TimerOutcome.finished();
      }
      return TimerOutcome.rescheduleAt(await this.timers.dbNow());
    });
  }
}

/** El disparo corre como el dueño del trabajo: el actor de autoría de cada elemento (el trabajo no tiene token). */
function asOwner<T>(owner: string, work: () => Promise<T>): Promise<T> {
${
  security
    ? `  return SecurityContext.runWith({ kind: 'token', name: owner, authorities: new Set<string>(), claims: { sub: owner } }, work);`
    : `  void owner;
  return work();`
}
}`
  );
}

// ─── Lo que comparten el procesador y el lote síncrono con clave ─────────────

function stepsFile(model) {
  const { aborted } = BATCH_JOB_STATUSES;
  const canonical = FRAMEWORK_ERRORS.idempotencyReuse;
  const codes = batchJobStoreOperations(model).map(({ operation }) => `  ${tsString(operation)}: ${tsString(idempotencyOutcomeCode(model, operation, canonical))}`);
  return tsModule(
    BATCH_JOB_STEPS_TS,
    [
      { symbol: 'createHash', from: 'node:crypto' },
      { symbol: 'ConflictException', from: classPath(ERRORS_DIR, 'ConflictException') },
      { symbol: 'MalformedRequestError', from: REQUEST_ERRORS_TS },
      { symbol: 'RequestValidationError', from: REQUEST_ERRORS_TS },
      { symbol: 'BatchItem', from: BATCH_TS },
      { symbol: 'BatchResponse', from: BATCH_TS },
      { symbol: 'InvalidBatchItem', from: BATCH_TS },
      { symbol: 'VALIDATION_ERROR', from: BATCH_TS },
      { symbol: 'itemFailure', from: BATCH_TS },
      { symbol: 'readBatchItem', from: BATCH_TS },
      { symbol: 'RawJson', from: 'src/domain/support/raw-json.ts' },
      { symbol: 'parseWireJson', from: WIRE_TS },
      { symbol: 'toWireJson', from: WIRE_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS, type: true },
      { symbol: 'BatchJobResult', from: BATCH_JOB_STORE_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS, type: true }
    ],
    `/** El code de la clave reutilizada de cada operación: el que declara el diseño para ese desenlace, o el canónico. */
const KEY_REUSED_CODES: Readonly<Record<string, string>> = {
${codes.join(',\n')}
};

/**
 * La misma clave de idempotencia de un lote con un contenido DISTINTO (D13, D15): no es un reintento, y devolver el trabajo
 * de la primera petición contestaría a una pregunta que el cliente no hizo.
 */
export class BatchJobKeyReusedException extends ConflictException {
  constructor(operation: string, key: string) {
    super(\`La clave de idempotencia \${operation}/\${key} ya se usó con un contenido distinto\`, {
      code: KEY_REUSED_CODES[operation] ?? ${tsString(canonical.code)},
      httpStatus: ${canonical.http},
      args: [operation, key]
    });
  }
}

/** La firma de la petición (D13): el sha256 en hexadecimal de los bytes del cuerpo, como batchRequestSignature de keel-core. */
export function batchSignature(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * El TEXTO del cuerpo tal como llegó: lo guarda el lector JSON de http-platform.ts en la petición. Sin él no hay lote que
 * firmar ni guardar: la petición es malformada, como el @RequestBody byte[] obligatorio de keel-spring.
 */
export function rawBodyOf(request: object): string {
  const raw = (request as { readonly rawBody?: unknown }).rawBody;
  if (typeof raw !== 'string') throw new MalformedRequestError();
  return raw;
}

/** La cabecera ${IDEMPOTENCY_HEADER} de la petición, o null si no llega o va en blanco. */
export function idempotencyKeyOf(request: { readonly headers: Readonly<Record<string, unknown>> }): string | null {
  const value = request.headers[${tsString(IDEMPOTENCY_HEADER.toLowerCase())}];
  const key = Array.isArray(value) ? value[0] : value;
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
}

/**
 * El sobre como lo leería el borde: el JSON del cable y el lector de la operación, que valida la LISTA (presencia y
 * maxItems) y no sus elementos, que se validan uno a uno. Un cuerpo que no es JSON es malformado; una cota de la lista
 * incumplida, el ${FRAMEWORK_ERRORS.validation.code} del sobre con el mensaje de las restricciones declaradas (el de
 * keel-spring, que lo valida fuera del cuerpo de la petición).
 */
export function readBatchEnvelope<E>(body: string, readEnvelope: (body: unknown) => E): E {
  let parsed: unknown;
  try {
    parsed = parseWireJson(body);
  } catch {
    throw new MalformedRequestError();
  }
  try {
    return readEnvelope(parsed);
  } catch (error) {
    if (error instanceof RequestValidationError && error.source === 'body') throw new RequestValidationError(error.details, 'params');
    throw error;
  }
}

/** Un resultado guardado, como viaja en el cable. */
export function storedItem(row: BatchJobResult): BatchItem {
  return row.status === 'succeeded'
    ? BatchItem.succeeded(row.index, row.result == null ? null : RawJson.of(row.result))
    : BatchItem.failed(row.index, row.errorCode ?? '', row.message);
}

/** El cursor ya no estaba donde lo dejó quien procesa: otra réplica u otra petición se llevó el trabajo. */
export class FenceLost extends Error {
  constructor() {
    super('El trabajo lo procesa otro');
    this.name = 'FenceLost';
  }
}

/** Lo que deja un elemento: seguir, parar (el lote se detuvo, D4) o perder el trabajo (la valla). */
export type Step = 'next' | 'stop' | 'lost';

/**
 * Lo que comparten el procesador de los lotes asíncronos y los lotes síncronos con clave (DSL 2.30, D9 y D15): procesar UN
 * elemento y rehacer la respuesta desde lo guardado.
 *
 * Cada elemento va en UNA transacción con tres cosas: su efecto (el despacho por el mediator, que se une a ella), el avance
 * del cursor y su resultado. El avance es la VALLA: solo avanza si el cursor sigue donde lo dejó quien procesa, y si no
 * —otra réplica o la repetición de la petición se llevó el trabajo— el elemento revierte entero, efecto incluido.
 *
 * Fallan solo su elemento los codes de \`itemErrors\` y ${FRAMEWORK_ERRORS.validation.code}; cualquier otro fallo detiene el
 * lote (\`${aborted}\`, D4) con su code o ${FRAMEWORK_ERRORS.batchAborted.code}.
 *
 * No lo edites: lo regenera build.
 */
export class BatchJobSteps {
  constructor(
    private readonly store: BatchJobStore,
    private readonly transactions: TransactionContext
  ) {}

  /** Un elemento con su efecto, el avance del cursor y su resultado en UNA transacción. */
  async process<T>(
    jobId: string,
    index: number,
    value: unknown,
    readItem: (value: unknown) => T | null,
    itemErrors: ReadonlySet<string>,
    process: (item: T) => Promise<unknown>
  ): Promise<Step> {
    let item: T;
    try {
      item = readBatchItem(value, readItem);
    } catch (error) {
      if (!(error instanceof InvalidBatchItem)) throw error;
      return this.failed(jobId, index, VALIDATION_ERROR, error.message, false);
    }
    try {
      await this.transactions.inTransaction(async () => {
        const result = await process(item);
        await this.keep(jobId, index, BatchItem.succeeded(index, result));
      });
      return 'next';
    } catch (error) {
      if (error instanceof FenceLost) return 'lost';
      const failure = itemFailure(index, error, itemErrors);
      return this.failed(jobId, index, failure.item.error ?? '', failure.item.message, failure.stops);
    }
  }

  /** Un elemento que falla: su resultado y el avance, en su transacción; si detiene el lote, también el final (D4). */
  private async failed(jobId: string, index: number, code: string, message: string | null, stops: boolean): Promise<Step> {
    try {
      await this.transactions.inTransaction(async () => {
        await this.keep(jobId, index, BatchItem.failed(index, code, message));
        if (stops) await this.store.finish(jobId, '${aborted}');
      });
    } catch (error) {
      if (error instanceof FenceLost) return 'lost';
      throw error;
    }
    return stops ? 'stop' : 'next';
  }

  /**
   * La valla y el resultado de un elemento, en la transacción en curso: primero el avance del cursor, que toma la fila del
   * trabajo, y después el resultado. Si el cursor ya no estaba en \`index\`, lanza FenceLost y la transacción revierte entera.
   */
  async keep(jobId: string, index: number, item: BatchItem): Promise<void> {
    const ok = item.status === 'succeeded';
    if (!(await this.store.advance(jobId, index, ok ? 1 : 0, ok ? 0 : 1))) throw new FenceLost();
    await this.store.insertResult(jobId, index, item.status, item.error, item.message, item.result == null ? null : toWireJson(item.result));
  }

  /**
   * La respuesta de un lote síncrono con clave rehecha desde lo guardado (D15, batchStoredBody de keel-core): los
   * resultados en orden de índice y, si se detuvo, un \`notAttempted\` por cada elemento desde el cursor.
   */
  async stored(jobId: string): Promise<BatchResponse> {
    const job = await this.store.job(jobId);
    if (job == null) throw new Error(\`El trabajo \${jobId} desapareció mientras se respondía\`);
    const items = (await this.store.results(jobId, job.total, 0)).map(storedItem);
    if (job.status === '${aborted}') for (let index = job.nextIndex; index < job.total; index++) items.push(BatchItem.notAttempted(index));
    return BatchResponse.of(items);
  }
}`
  );
}

// ─── El lote síncrono con clave (D15) ────────────────────────────────────────

function keyedFile(model) {
  const secured = Boolean(model.layersPresent?.security);
  const { completed } = BATCH_JOB_STATUSES;
  const canonical = FRAMEWORK_ERRORS.idempotencyRace;
  const operations = keyedOperations(model);
  const codes = operations.map((operation) => `  ${tsString(operation.name)}: ${tsString(idempotencyOutcomeCode(model, operation.name, canonical))}`);
  const atomic = operations.some((operation) => operation.batch.atomicity === 'all-or-nothing');
  const perItem = operations.some((operation) => operation.batch.atomicity === 'per-item');
  const perItemMethod = `

  /**
   * Un lote \`per-item\` con clave: como \`perItem\` de batch.ts, con cada elemento confirmado junto a su resultado y el
   * avance del cursor, y la respuesta rehecha de lo guardado. Sin clave, el lote de siempre.
   */
  async perItem<T>(
    operation: string,
    body: string,
    keySource: string,
    clientKey: string | null,
    ttlSeconds: number | null,
    items: readonly unknown[],
    readItem: (value: unknown) => T | null,
    itemErrors: ReadonlySet<string>,
    process: (item: T) => Promise<unknown>
  ): Promise<BatchResponse> {
    const signature = batchSignature(body);
    const key = keyOf(keySource, clientKey, signature);
    if (key == null) return perItem(items, readItem, itemErrors, process);
    const started = await this.start(operation, key, signature, ttlSeconds, body, items.length);
    if (started.replay) return this.steps.stored(started.id);
    for (let index = started.from; index < items.length; index++) {
      const step = await this.steps.process(started.id, index, items[index], readItem, itemErrors, process);
      // Otra petición con la misma clave tomó el trabajo (D15): lo termina ella.
      if (step === 'lost') throw new BatchKeyInProgressException(operation, key);
      if (step === 'stop') return this.steps.stored(started.id);
    }
    await this.transactions.inTransaction(() => this.store.finish(started.id, '${completed}'));
    return this.steps.stored(started.id);
  }`;
  const atomicMethod = `

  /**
   * Un lote \`all-or-nothing\` con clave: como \`allOrNothing\` de batch.ts, con los resultados, el cursor y el final del
   * trabajo en la transacción del lote. Si falla no queda nada confirmado, y su trabajo se descarta en otra: la repetición
   * lo vuelve a procesar en vez de devolver un lote que nunca se confirmó.
   */
  async allOrNothing<T>(
    operation: string,
    over: string,
    body: string,
    keySource: string,
    clientKey: string | null,
    ttlSeconds: number | null,
    items: readonly unknown[],
    readItem: (value: unknown) => T | null,
    process: (item: T) => Promise<unknown>
  ): Promise<AtomicOutcome> {
    const signature = batchSignature(body);
    const key = keyOf(keySource, clientKey, signature);
    if (key == null) return allOrNothing(over, items, readItem, this.transactions, process);
    const started = await this.start(operation, key, signature, ttlSeconds, body, items.length);
    if (started.replay) return { ok: true, body: await this.steps.stored(started.id) };
    const id = started.id;
    let outcome: AtomicOutcome;
    try {
      outcome = await allOrNothing(over, items, readItem, this.transactions, process, {
        kept: (item) => this.steps.keep(id, item.index, item),
        completed: async () => {
          await this.store.finish(id, '${completed}');
        }
      });
    } catch (error) {
      if (error instanceof FenceLost) throw new BatchKeyInProgressException(operation, key);
      // Un fallo al confirmar no es de ningún elemento, y el lote tampoco quedó confirmado: su trabajo se descarta igual.
      await this.discard(id);
      throw error;
    }
    if (!outcome.ok) {
      await this.discard(id);
      return outcome;
    }
    return { ok: true, body: await this.steps.stored(id) };
  }

  /** El trabajo de un todo o nada que no se confirmó, fuera: libera la clave. */
  private async discard(id: string): Promise<void> {
    await this.transactions.inTransaction(() => this.store.discard(id));
  }`;
  return tsModule(
    KEYED_BATCHES_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'ConflictException', from: classPath(ERRORS_DIR, 'ConflictException') },
      { symbol: 'DomainException', from: DOMAIN_EXCEPTION_TS },
      { symbol: 'BatchResponse', from: BATCH_TS, type: true },
      ...(perItem ? [{ symbol: 'perItem', from: BATCH_TS }] : []),
      ...(atomic ? [{ symbol: 'allOrNothing', from: BATCH_TS }, { symbol: 'AtomicOutcome', from: BATCH_TS, type: true }] : []),
      { symbol: 'Uuids', from: UUIDS_TS },
      ...(secured ? [{ symbol: 'currentActor', from: AUDIT_ACTOR_TS }] : []),
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'BATCH_SETTINGS', from: BATCH_SETTINGS_TS },
      { symbol: 'BatchSettings', from: BATCH_SETTINGS_TS, type: true },
      { symbol: 'BatchJobStore', from: BATCH_JOB_STORE_TS },
      { symbol: 'BatchJobKeyReusedException', from: BATCH_JOB_STEPS_TS },
      { symbol: 'BatchJobSteps', from: BATCH_JOB_STEPS_TS },
      { symbol: 'FenceLost', from: BATCH_JOB_STEPS_TS },
      { symbol: 'batchSignature', from: BATCH_JOB_STEPS_TS },
      { symbol: 'readBatchEnvelope', from: BATCH_JOB_STEPS_TS }
    ],
    `/** El code de la clave en curso de cada operación: el que declara el diseño para ese desenlace, o el canónico. */
const IN_PROGRESS_CODES: Readonly<Record<string, string>> = {
${codes.join(',\n')}
};

/**
 * La repetición de un lote síncrono con clave mientras el primero sigue en marcha (DSL 2.30, D15): todavía no hay respuesta
 * que devolver, y procesarlo a la vez lo repartiría entre dos peticiones. Es la semántica de una operación sola con clave.
 * El code es el que declara cada operación para este desenlace, o el canónico (docs/framework-errors.md).
 */
export class BatchKeyInProgressException extends ConflictException {
  constructor(operation: string, key: string) {
    super(\`Otra petición con la clave de idempotencia \${operation}/\${key} está procesando el lote\`, {
      code: IN_PROGRESS_CODES[operation] ?? ${tsString(canonical.code)},
      httpStatus: ${canonical.http},
      args: [operation, key]
    });
  }
}
${
  secured
    ? ''
    : `
/** El dueño de un lote sin capa security: no hay llamante, y la clave la acota solo la operación. */
const OWNER = ${tsString(BATCH_ANONYMOUS_OWNER)};
`
}
/** El trabajo de la petición: su id, desde qué elemento sigue y si ya terminó (la repetición responde lo guardado). */
interface Started {
  readonly id: string;
  readonly from: number;
  readonly replay: boolean;
}

/** La clave del lote: la cabecera, o la firma del cuerpo si la clave es el contenido. null: sin clave. */
function keyOf(keySource: string, clientKey: string | null, signature: string): string | null {
  return keySource === 'payload-hash' ? signature : clientKey;
}

/**
 * Los lotes SÍNCRONOS con clave de idempotencia (DSL 2.30, D15): la clave la guarda el TRABAJO (\`${BATCH_JOB.table}\`), como
 * en un lote asíncrono, sin temporizador. La petición crea su trabajo en una transacción propia y procesa cada elemento con
 * BatchJobSteps; la respuesta se rehace siempre de lo guardado, así que es la misma para la primera petición, la repetición
 * y la que reanuda.
 *
 * La repetición: con la misma firma y el trabajo terminado, la respuesta guardada sin procesar nada; con otra firma, el
 * error de la clave reutilizada; sin terminar y escrito hace menos de \`${BATCH_SYNC_STALE.key}\`, el error de la clave en
 * curso (409); sin terminar y más viejo, quien lo procesaba murió: lo toma y sigue desde el cursor.
 *
 * No lo edites: lo regenera build.
 */
@Injectable()
export class KeyedBatches {
  private readonly steps: BatchJobSteps;

  constructor(
    @Inject(BatchJobStore) private readonly store: BatchJobStore,
    @Inject(TransactionContext) private readonly transactions: TransactionContext,
    @Inject(BATCH_SETTINGS) private readonly settings: BatchSettings
  ) {
    this.steps = new BatchJobSteps(store, transactions);
  }

  /** El sobre del lote como lo leería el borde: uno mal formado es un 400 sin trabajo. */
  read<E>(body: string, readEnvelope: (body: unknown) => E): E {
    return readBatchEnvelope(body, readEnvelope);
  }${perItem ? perItemMethod : ''}${atomic ? atomicMethod : ''}

  /** El trabajo de la petición: el de la clave, si lo hay, o uno nuevo, en una transacción propia. */
  private async start(operation: string, key: string, signature: string, ttlSeconds: number | null, body: string, total: number): Promise<Started> {
    const owner = ${secured ? 'currentActor()' : 'OWNER'};
    const ttlMs = ttlSeconds == null ? null : ttlSeconds * 1000;
    try {
      return await this.transactions.inTransaction(async () => {
        await this.store.releaseKey(operation, owner, key);
        const found = await this.repeat(operation, owner, key, signature);
        if (found != null) return found;
        const id = Uuids.v7();
        await this.store.insert(id, operation, owner, key, signature, ttlMs, body, total);
        return { id, from: 0, replay: false };
      });
    } catch (error) {
      if (error instanceof DomainException) throw error;
      // Dos peticiones con la misma clave a la vez: la que pierde choca con la unicidad del motor y encuentra el trabajo de
      // la ganadora, en marcha.
      const found = await this.transactions.inTransaction(() => this.repeat(operation, owner, key, signature));
      if (found == null) throw error;
      return found;
    }
  }

  /** El trabajo vivo de la clave (D15, batchSyncRepeat de keel-core). */
  private async repeat(operation: string, owner: string, key: string, signature: string): Promise<Started | null> {
    const hit = await this.store.byKey(operation, owner, key);
    if (hit == null) return null;
    if (hit.signature !== signature) throw new BatchJobKeyReusedException(operation, key);
    const job = await this.store.job(hit.id);
    if (job == null) return null;
    if (job.finishedAt != null) return { id: job.id, from: job.total, replay: true };
    if (!(await this.store.takeOver(job.id, this.settings.syncStaleMs))) throw new BatchKeyInProgressException(operation, key);
    return { id: job.id, from: job.nextIndex, replay: false };
  }
}`
  );
}

// ─── El temporizador de cada operación ───────────────────────────────────────

function jobHandlerFile(model, operation) {
  const batch = operation.batch;
  const className = batchJobClass(operation);
  const controller = controllerOf(model, operation);
  const reader = `read${operation.messageClass}`;
  const itemReader = `read${batch.itemType}`;
  const dispatch =
    batch.resultFields.length > 0
      ? '(envelope, item) => this.mediator.dispatch(envelope.message(item))'
      : 'async (envelope, item) => {\n        await this.mediator.dispatch(envelope.message(item));\n        return null;\n      }';
  return tsModule(
    batchJobPath(operation),
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'UseCaseMediator', from: MEDIATOR_TS },
      { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
      { symbol: 'ClaimedTimer', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerHandler', from: TIMER_STORE_TS, type: true },
      { symbol: 'TimerOutcome', from: TIMER_STORE_TS, type: true },
      { symbol: itemReader, from: VALUE_READERS_TS },
      { symbol: reader, from: controller.from },
      { symbol: 'BatchJobRunner', from: BATCH_JOB_RUNNER_TS }
    ],
    `/**
 * Los trabajos del lote asíncrono ${operation.name} (DSL 2.30): un temporizador de UNA vez por trabajo
 * (\`${batchKind(operation.name)}\`), y cada disparo procesa un chunk (BatchJobRunner). Corre FUERA de la transacción del
 * sondeador: cada elemento abre la suya. El sobre guardado se vuelve a leer con el MISMO lector de la operación que usa el
 * borde.
 *
 * No lo edites: lo regenera build.
 */
@Injectable()
export class ${className} implements TimerHandler {
  readonly kind = TimerKinds.${batchKindConstant(operation.name)};
  readonly inTransaction = false;

  constructor(
    @Inject(BatchJobRunner) private readonly runner: BatchJobRunner,
    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator
  ) {}

  handle(timer: ClaimedTimer): Promise<TimerOutcome> {
    return this.runner.runChunk(
      timer,
      (body) => ${reader}({}, {}, body),
      (envelope) => envelope.${batch.over},
      ${itemReader},
      new Set<string>([${batch.itemErrors.map(tsString).join(', ')}]),
      ${dispatch}
    );
  }
}`
  );
}

// ─── El controlador ──────────────────────────────────────────────────────────

/**
 * Los métodos del controlador de una operación asíncrona: el alta (el texto del cuerpo, la cabecera de la clave) y las
 * dos rutas del trabajo. `imports` es la lista del controlador; `readerName`, el lector del sobre de la operación.
 */
export function controllerBatchJobMethods(model, operation, { decorator, readerName, imports, doc }) {
  const batch = operation.batch;
  const paths = batchJobPaths(operation.route.path);
  const idempotency = batch.idempotency;
  imports.push(
    { symbol: 'Get', from: '@nestjs/common' },
    { symbol: 'Req', from: '@nestjs/common' },
    { symbol: 'Res', from: '@nestjs/common' },
    { symbol: 'FastifyRequest', from: 'fastify', type: true },
    { symbol: 'FastifyReply', from: 'fastify', type: true },
    { symbol: 'BatchJobs', from: BATCH_JOBS_TS },
    { symbol: 'BatchJobView', from: BATCH_JOBS_TS, type: true },
    { symbol: 'rawBodyOf', from: BATCH_JOB_STEPS_TS },
    { symbol: 'BatchItem', from: BATCH_TS, type: true },
    { symbol: 'PagedResponse', from: PAGED_RESPONSE_TS, type: true },
    { symbol: 'TimerKinds', from: TIMER_KINDS_TS },
    { symbol: 'locationOf', from: ROUTES_TS },
    { symbol: 'readPageable', from: PAGEABLE_READING_TS },
    { symbol: 'text', from: 'src/infrastructure/rest/request-reading.ts' }
  );
  if (idempotency?.keySource === 'client-key') imports.push({ symbol: 'idempotencyKeyOf', from: BATCH_JOB_STEPS_TS });
  const keySource = idempotency ? tsString(idempotency.keySource) : 'null';
  const clientKey = idempotency?.keySource === 'client-key' ? 'idempotencyKeyOf(request)' : 'null';
  const ttl = idempotency?.ttlSeconds ?? 'null';
  const op = tsString(operation.name);
  const pagination = model.pagination ?? {};
  const defaults = `{ defaultSize: ${pagination.defaultSize ?? PAGEABLE_DEFAULT_SIZE}, maxSize: ${pagination.maxSize ?? PAGEABLE_MAX_SIZE} }`;
  const jobId = `text.uuid(params[${tsString(BATCH_JOB_PARAM)}])!`;
  return `${doc}  @${decorator}(${tsString(nestPath(operation.route.path))})
  @HttpCode(${BATCH_ACCEPTED_STATUS})
  async ${operation.name}(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<BatchJobView> {
    // Lote asíncrono (DSL 2.30): ${BATCH_ACCEPTED_STATUS} con el trabajo; lo procesa el cronómetro por partes.
    const job = await this.batchJobs.submit(
      ${op},
      TimerKinds.${batchKindConstant(operation.name)},
      rawBodyOf(request),
      (body) => ${readerName}({}, {}, body),
      (envelope) => envelope.${batch.over},
      ${keySource},
      ${clientKey},
      ${ttl}
    );
    void reply.header('Location', locationOf(request, ${tsString(`${model.api.routeBase}${paths.status}`)}, job.id));
    return job;
  }

  /** El trabajo de ${operation.name}: su estado y su resumen. Solo lo lee quien lo creó. */
  @Get(${tsString(nestPath(paths.status))})
  @HttpCode(200)
  async ${operation.name}Job(@Param() params: Record<string, string>): Promise<BatchJobView> {
    return this.batchJobs.status(${op}, ${jobId});
  }

  /** Los resultados de los elementos intentados del trabajo de ${operation.name}, en orden de índice. */
  @Get(${tsString(nestPath(paths.results))})
  @HttpCode(200)
  async ${operation.name}JobResults(@Param() params: Record<string, string>, @Query() query: Record<string, unknown>): Promise<PagedResponse<BatchItem>> {
    return this.batchJobs.results(${op}, ${jobId}, readPageable(query, ${defaults}));
  }`;
}

/**
 * El método del controlador de un lote SÍNCRONO con clave (D15): el cuerpo llega como TEXTO (su firma es la de la petición,
 * como en el alta asíncrona) y el sobre lo lee KeyedBatches con el lector de la operación. `imports` es la lista del
 * controlador; `readerName`, el lector del sobre; `itemReader`, el del elemento; `dispatch`, el despacho de UNO.
 */
export function controllerKeyedBatchMethod(model, operation, { decorator, readerName, itemReader, dispatch, imports, doc }) {
  const batch = operation.batch;
  const idempotency = batch.idempotency;
  imports.push(
    { symbol: 'Req', from: '@nestjs/common' },
    { symbol: 'Res', from: '@nestjs/common' },
    { symbol: 'FastifyRequest', from: 'fastify', type: true },
    { symbol: 'FastifyReply', from: 'fastify', type: true },
    { symbol: 'KeyedBatches', from: KEYED_BATCHES_TS },
    { symbol: 'rawBodyOf', from: BATCH_JOB_STEPS_TS },
    { symbol: 'BatchResponse', from: BATCH_TS, type: true }
  );
  const clientKey = idempotency.keySource === 'client-key';
  if (clientKey) imports.push({ symbol: 'idempotencyKeyOf', from: BATCH_JOB_STEPS_TS });
  const key = `${tsString(idempotency.keySource)}, ${clientKey ? 'idempotencyKeyOf(request)' : 'null'}, ${idempotency.ttlSeconds ?? 'null'}`;
  const op = tsString(operation.name);
  const read = `    // Lote con clave (DSL 2.30, D15): la repetición responde lo guardado en su trabajo.
    const body = rawBodyOf(request);
    const envelope = this.keyedBatches.read(body, (parsed) => ${readerName}(params, query, parsed));`;
  const params = '@Param() params: Record<string, string>, @Query() query: Record<string, unknown>, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply';
  if (batch.atomicity === 'per-item') {
    return `${doc}  @${decorator}(${tsString(nestPath(operation.route.path))})
  @HttpCode(${BATCH_MULTI_STATUS})
  async ${operation.name}(${params}): Promise<BatchResponse> {
${read}
    void reply;
    return this.keyedBatches.perItem(${op}, body, ${key}, envelope.${batch.over}, ${itemReader}, new Set<string>([${batch.itemErrors.map(tsString).join(', ')}]), ${dispatch});
  }`;
  }
  imports.push({ symbol: 'ErrorResponse', from: 'src/infrastructure/rest/error-response.ts', type: true });
  return `${doc}  @${decorator}(${tsString(nestPath(operation.route.path))})
  @HttpCode(${operation.route.status})
  async ${operation.name}(${params}): Promise<BatchResponse | ErrorResponse> {
${read}
    const outcome = await this.keyedBatches.allOrNothing(${op}, ${tsString(batch.over)}, body, ${key}, envelope.${batch.over}, ${itemReader}, ${dispatch});
    if (outcome.ok) return outcome.body;
    void reply.status(outcome.error.status);
    return outcome.error;
  }`;
}
