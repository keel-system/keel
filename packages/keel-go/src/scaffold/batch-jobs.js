// Los LOTES ASÍNCRONOS (DSL 2.30: `use-cases.<op>.batch` con `execution: async`) en keel-go: incremento 9 de
// PLAN-DSL-230-LOTES.md, el gemelo de batch-jobs.js de keel-spring, keel-nest y keel-dotnet. Lo que decide QUÉ (las tablas
// y sus sentencias por motor, los estados, el temporizador de cada trabajo, la firma de la petición, la forma del trabajo
// en el cable, los casos BJ-*) es de keel-core (gen/batch.js y gen/batch-store.js); aquí solo se escribe en Go, con la
// frontera hexagonal de render.js (httpapi no ve la infraestructura):
//
//   · el puerto (`domain.BatchJobStore`, en internal/domain, como el registro de idempotencia) y su adaptador en el paquete
//     del motor (`<store>/batch_jobs.go`): las sentencias de keel-core TAL CUAL con el `timerSQL` del cronómetro, o MongoDB
//     con la forma documental de keel-core. El DUEÑO de un trabajo es el actor de autoría (`auditActor`, D11): el alta lo
//     guarda y las rutas solo leen los suyos. El alta arma en su misma transacción el temporizador de UNA vez del trabajo
//     (`armTimer`), y `BatchSettings` lee batch.yaml;
//   · `internal/httpapi/batch_jobs.go`: el alta (D8, D13), las dos rutas del trabajo y el procesador (`BatchJobRunner`). El
//     alta lee los BYTES del cuerpo, los firma, los vuelve a leer con el MISMO lector de la operación (un sobre mal formado es
//     un 400 sin trabajo, BJ-9), resuelve la clave del lote y crea el trabajo y su temporizador en UNA transacción: 202 con
//     Location. El procesador vuelve a leer el sobre guardado con ese lector y lleva cada elemento a UNA transacción con su
//     efecto, el avance del cursor (la valla, primero) y su resultado; corre como el dueño, que es el actor de autoría de
//     cada elemento;
//   · `internal/infrastructure/timer/batch_job.go`: el `timer.Handler` de los trabajos de una operación, con
//     `InTransaction() false`: el sondeador lo corre FUERA de su transacción y borra o rearma el temporizador después. Recibe
//     el disparo del procesador como una función: el cronómetro no ve la API.
//
// Lo que no cambia respecto al lote síncrono: el handler procesa UN elemento, cada elemento se lee con `readBatchItem` (el
// `wire.Unmarshal` del borde) y su fallo se traduce con `errorResponse` y `batchFailureOf` (batch.go), así que «falla solo su
// elemento» y «detiene el lote» significan lo mismo.
//
// El lote SÍNCRONO con clave (D15, incremento 10b) usa el mismo almacén, sin temporizador (`Insert` sin `Kind` no arma
// ninguno): `runKeyedPerItem` y `runKeyedAllOrNothing`, en el mismo batch_jobs.go de la API, crean su trabajo, procesan cada
// elemento con los mismos pasos que el procesador (`processBatchItem`: efecto, valla y resultado en UNA transacción) y
// responden lo guardado (`storedBatchResponse`, batchStoredBody de keel-core), así que la primera petición, la repetición y
// la que reanuda responden lo mismo. El umbral del lote muerto lo guarda el almacén (`batch.sync-stale-ms`), y el dueño sin
// capa security es el anónimo de keel-core (`batchJobOwner`).

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
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { idempotencyOutcomeCode } from '@keel-system/keel-core/gen/declared-errors';
import { IDEMPOTENCY_HEADER } from '@keel-system/keel-core/gen/request-idempotency';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { PAGEABLE_DEFAULT_SIZE, PAGEABLE_MAX_SIZE } from '@keel-system/keel-core/gen/pagination';
import { pascalCase } from '@keel-system/keel-core/gen';
import { usesHttpSecurity } from '@keel-system/keel-core/gen/features';
import { goExported, goUnexported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { relationalEngine, sqlDialect } from '../lib/relational-engine.js';
import { layout, packageFile } from './render.js';
import { messageType, useCaseField } from './services.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const isDocument = (model) => model.persistenceKind === 'document';

/** El campo de las Dependencies (y el método de UseCases) con el almacén de los trabajos. */
export const BATCH_JOBS = { field: 'BatchJobs', port: 'domain.BatchJobStore' };

/** La variable del arranque con el almacén de los trabajos (la comparten las Dependencies y la purga). */
export const BATCH_JOB_STORE_VAR = 'batchJobStore';

/** Las operaciones asíncronas del modelo, enteras (no solo su nombre). */
export const asyncOperations = (model) =>
  (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.batch?.execution === 'async');

/**
 * ¿Usa el servicio el almacén de trabajos? Con un lote asíncrono o un lote síncrono con clave (D15). Sin persistencia no hay
 * dónde guardar el trabajo (lo rechaza la frontera).
 */
export const usesBatchJobs = (model) => Boolean(model.layersPresent?.persistence) && batchJobStoreOperations(model).length > 0;

/** ¿Tiene el servicio algún lote asíncrono? El alta, el procesador, su temporizador y las dos rutas del trabajo. */
export const usesAsyncBatchJobs = (model) => usesBatchJobs(model) && asyncBatchOperations(model).length > 0;

/** ¿Tiene el servicio algún lote síncrono con clave (D15)? */
export const usesKeyedBatches = (model) => usesBatchJobs(model) && keyedSyncBatchOperations(model).length > 0;

/** ¿Es la operación un lote asíncrono que se genera? */
export const isAsyncBatch = (model, operation) => operation.batch?.execution === 'async' && usesAsyncBatchJobs(model);

/** ¿Es la operación un lote síncrono con clave que se genera (D15)? */
export const isKeyedBatch = (model, operation) =>
  Boolean(operation.batch && operation.batch.execution !== 'async' && operation.batch.idempotency) && usesKeyedBatches(model);

/** Las operaciones síncronas con clave del modelo, enteras. */
export const keyedOperations = (model) =>
  (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.batch && operation.batch.execution !== 'async' && operation.batch.idempotency);

/** ¿Procesa alguien elementos uno a uno sobre el almacén (el procesador asíncrono o un lote con clave per-item)? */
const usesItemSteps = (model) =>
  usesAsyncBatchJobs(model) || (usesKeyedBatches(model) && keyedOperations(model).some((operation) => operation.batch.atomicity === 'per-item'));

/** La constante del `kind` del temporizador de los trabajos de una operación, en kinds.go: `KindBatchImportProducts`. */
export const batchKindConstant = (operationName) => `KindBatch${pascalCase(operationName)}`;

/** El método del procesador que dispara un trabajo de una operación: `ImportProducts`. */
export const runnerMethod = (operation) => goExported(operation.name);

/** Los nombres de los endpoints del trabajo de una operación (métodos de `api`). */
export const jobEndpoint = (operation) => `${goUnexported(operation.name)}Job`;
export const jobResultsEndpoint = (operation) => `${goUnexported(operation.name)}JobResults`;

/**
 * Lo que un diseño con lotes asíncronos no puede generar con este stack, o []: las sentencias son las del cronómetro
 * (PostgreSQL y MySQL, medidas con timer-sql-check) y el documental es MongoDB; el sobre guardado es el CUERPO, así que lo
 * que el mensaje lea de la ruta o estampe de la petición no viajaría al trabajo. El mismo criterio que los otros tres.
 * `stamped(operation)` dice qué lleva el mensaje que estampa la petición (identidad, versiones, alcance).
 */
export function batchJobStackErrors(model, stamped) {
  if (batchJobStoreOperations(model).length === 0) return [];
  const errors = [];
  const what = asyncBatchOperations(model).length > 0 ? 'execution: async' : 'idempotency en un lote síncrono';
  if (!model.layersPresent?.persistence) {
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
    for (const name of stamped(operation)) {
      errors.push(
        `use-cases: ${operation.name}.batch (execution: async, DSL 2.30): el mensaje lleva '${name}', que estampa la ` +
          'petición, y el trabajo se procesa fuera de ella. Declara execution: sync.'
      );
    }
  }
  return errors;
}

// ─── Lo que enlazan los demás módulos ────────────────────────────────────────────────────────────

/** El code de la clave reutilizada de una operación: el que declara el diseño para ese desenlace, o el canónico. */
const reusedCode = (model, operation) => idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyReuse);

/** El centinela Go de un code (el de errors.js, sin importarlo: errors.js importa este módulo). */
const sentinel = (code) => `Err${goExported(String(code).toLowerCase())}`;

/** El code de la clave en curso de una operación (D15): el que declara el diseño para ese desenlace, o el canónico. */
const inProgressCode = (model, operation) => idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyRace);

/** Las operaciones que guardan su clave en el trabajo: las asíncronas y las síncronas con clave, enteras. */
const storedOperations = (model) => [...asyncOperations(model), ...keyedOperations(model)];

/** Los centinelas del dominio que pone el generador para los lotes con trabajo (errors.js los emite). */
export function batchJobSentinels(model) {
  if (!usesBatchJobs(model)) return [];
  const declared = new Set((model.errors ?? []).map((error) => error.code));
  const list = usesAsyncBatchJobs(model)
    ? [
        {
          name: sentinel(FRAMEWORK_ERRORS.batchJobNotFound.code),
          doc: 'el trabajo de un lote asíncrono no existe, ya se purgó o lo creó otro llamante (DSL 2.30, D11): los tres casos responden igual, para no decirle a nadie que un trabajo ajeno existe.',
          ...FRAMEWORK_ERRORS.batchJobNotFound
        }
      ]
    : [];
  const reuse = FRAMEWORK_ERRORS.idempotencyReuse;
  if (storedOperations(model).some((operation) => operation.batch.idempotency && !declared.has(reusedCode(model, operation)))) {
    list.push({
      name: sentinel(reuse.code),
      doc: 'la misma clave de idempotencia con un contenido distinto. Lo usa la operación que no declara un code propio para este conflicto.',
      ...reuse
    });
  }
  const race = FRAMEWORK_ERRORS.idempotencyRace;
  if (keyedOperations(model).some((operation) => !declared.has(inProgressCode(model, operation)))) {
    list.push({
      name: sentinel(race.code),
      doc: 'la misma clave de idempotencia mientras la primera petición sigue en marcha. Lo usa la operación que no declara un code propio para este conflicto.',
      ...race
    });
  }
  return list;
}

/** La fila de las Dependencies con el almacén de los trabajos (use-cases.js). */
export function batchJobDependencyRows(model) {
  if (!usesBatchJobs(model)) return [];
  return [
    { text: `\t// ${BATCH_JOBS.field} es el almacén de los trabajos de los lotes (DSL 2.30): los asíncronos y los síncronos con clave.` },
    { indent: '\t', cells: [BATCH_JOBS.field, BATCH_JOBS.port] }
  ];
}

/** El acceso de UseCases al almacén de los trabajos (use-cases.js). */
export const BATCH_JOBS_ACCESSOR = `
// ${BATCH_JOBS.field} es el almacén de los trabajos de los lotes (DSL 2.30): lo usan el alta, las rutas del trabajo y el
// procesador de los asíncronos, y los lotes síncronos con clave, que viven en la entrada HTTP.
func (uc *UseCases) ${BATCH_JOBS.field}() ${BATCH_JOBS.port} {
	return uc.batchJobs
}
`;

/** Las tablas del generador de los lotes asíncronos, para la baseline (persistence.js). */
export function batchJobTables(model) {
  return usesBatchJobs(model) && !isDocument(model) ? [BATCH_JOB, BATCH_ITEM_RESULT] : [];
}

/** Los índices de las dos colecciones, para indexes.go (documental): la clave única y PARCIAL, y la purga. */
export function batchJobIndexEntries(model) {
  if (!usesBatchJobs(model) || !isDocument(model)) return [];
  return Object.values(BATCH_JOB_COLLECTIONS).map(({ collection, indexes }) => ({
    collection,
    specs: indexes.map((index) => ({
      name: index.name,
      paths: index.keys.map(([key]) => key),
      directions: index.keys.map(([, direction]) => direction),
      unique: Boolean(index.unique),
      ...(index.partialFilter ? { partialType: Object.entries(index.partialFilter).map(([path, condition]) => ({ path, type: condition.$type }))[0] } : {})
    }))
  }));
}

/** Las filas de kinds.go de los trabajos (timer.js). */
export function batchKindRows(model) {
  if (!usesBatchJobs(model)) return [];
  return asyncBatchOperations(model).flatMap(({ operation }) => [
    { text: `\t// ${batchKindConstant(operation)} son los trabajos del lote asíncrono ${operation}: un temporizador de UNA vez por trabajo.` },
    { indent: '\t', cells: [batchKindConstant(operation), `= ${goString(batchKind(operation))}`] }
  ]);
}

/**
 * Lo que el arranque añade al cronómetro con lotes asíncronos (timer.js, timerWiring): la configuración de batch.yaml, el
 * procesador (de la API) y su temporizador por operación, y la purga de los trabajos terminados (D10), un recurrente más.
 */
export function batchJobTimerWiring(model, purgeKind) {
  if (!usesBatchJobs(model)) return { code: '', handlers: [], recurrings: [] };
  // batchSettings ya lo leyó el arranque antes del almacén (batchJobStoreWiring).
  const runner = usesAsyncBatchJobs(model)
    ? `	// El procesador de los trabajos es de la API: vuelve a leer el sobre con el lector del endpoint y traduce el fallo de cada
	// elemento con su errorResponse.
	batchJobs := httpapi.NewBatchJobRunner(useCases, logger, batchSettings.ChunkSize)
`
    : '';
  return {
    code: `${runner}	// La purga de los trabajos terminados (D10): UNA réplica por tick, la que gana su fila.
	purgeBatchJob, err := timer.NewRecurring(timer.${purgeKind}, batchSettings.PurgeCron, func(ctx context.Context) error {
		_, err := ${BATCH_JOB_STORE_VAR}.Purge(ctx, batchSettings.RetentionDays)
		return err
	})
	if err != nil {
		return fmt.Errorf("la purga de ${BATCH_JOB.table}: %w", err)
	}
`,
    handlers: asyncOperations(model).map((operation) => `		timer.NewBatchJob(timer.${batchKindConstant(operation.name)}, batchJobs.${runnerMethod(operation)}),`),
    recurrings: ['purgeBatchJob']
  };
}

/**
 * La configuración de los lotes y la declaración del almacén en el arranque, antes de los casos de uso (server.js): la purga
 * y el procesador la leen después (batchJobTimerWiring), y el almacén guarda el umbral del lote muerto (D15).
 */
export function batchJobStoreWiring(model) {
  if (!usesBatchJobs(model)) return '';
  const { store } = layout(model);
  return `	batchSettings, err := ${store.name}.BatchSettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("la configuración de los lotes: %w", err)
	}
	${BATCH_JOB_STORE_VAR} := ${store.name}.NewBatchJobStore(transactions${usesKeyedBatches(model) ? ', batchSettings.SyncStaleMs' : ''})
`;
}

// ─── Lo que emite build ──────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesBatchJobs(model)) return [];
  const { domain, httpapi, store } = layout(model);
  const document = isDocument(model);
  const asynchronous = usesAsyncBatchJobs(model);
  const timerPkg = { dir: 'internal/infrastructure/timer', name: 'timer' };
  // El colector de imports de go-source.js deja solo los que el cuerpo usa: en Go uno sin usar no compila.
  return [
    { path: `${domain.dir}/batch_job.go`, content: packageFile(model, domain, { imports: ['context', 'time', 'github.com/google/uuid'], body: domainBody(model) }) },
    {
      path: `${store.dir}/batch_jobs.go`,
      content: packageFile(model, store, {
        imports: document
          ? ['context', 'errors', 'fmt', 'strconv', 'strings', 'time', 'github.com/google/uuid', 'go.mongodb.org/mongo-driver/v2/bson', { path: 'go.mongodb.org/mongo-driver/v2/mongo', name: 'mongodriver' }, 'go.mongodb.org/mongo-driver/v2/mongo/options', 'internal/domain', 'internal/platform/config']
          : ['context', 'database/sql', 'errors', 'fmt', 'strconv', 'strings', 'time', 'github.com/google/uuid', 'internal/domain', 'internal/platform/config'],
        body: `${document ? mongoStoreBody(model) : sqlStoreBody(model)}${ownerBody(model)}${settingsBody(model)}`
      })
    },
    {
      path: `${httpapi.dir}/batch_jobs.go`,
      content: packageFile(model, httpapi, {
        imports: [
          'bytes',
          'context',
          'crypto/sha256',
          'encoding/hex',
          'encoding/json/jsontext',
          'errors',
          'fmt',
          'io',
          'log/slog',
          'net/http',
          'strings',
          'time',
          'github.com/google/uuid',
          'internal/application',
          'internal/domain',
          'internal/platform/wire',
          ...(asynchronous && usesHttpSecurity(model) ? ['internal/platform/security'] : [])
        ],
        body: httpBody(model)
      })
    },
    ...(asynchronous ? [{ path: `${timerPkg.dir}/batch_job.go`, content: packageFile(model, timerPkg, { imports: ['context', 'time', 'github.com/google/uuid'], body: TIMER_HANDLER_BODY }) }] : []),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/batch.yaml`, content: batchYaml(model, profile) }))
  ];
}

// ─── La configuración ────────────────────────────────────────────────────────────────────────────

/**
 * config/parameters/<perfil>/batch.yaml: la mecánica de los lotes con trabajo (keel-core/gen/batch-store.js, la misma clave
 * y variable en los cuatro generadores). Es, línea a línea, el `batch.yaml` de los otros tres: el chunk solo con lotes
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

const P = BATCH_PARAMETERS;

/** El dueño de un trabajo (D11, D15): el actor de autoría con capa security; sin ella, el anónimo de keel-core. */
function ownerBody(model) {
  if (usesHttpSecurity(model)) {
    return `
// batchJobOwner es el dueño de un trabajo (D11): el actor de autoría de la petición que lo crea, y el único que lo ve.
func batchJobOwner(ctx context.Context) string {
	return auditActor(ctx)
}
`;
  }
  return `
// batchJobOwnerAnonymous es el dueño de un lote sin capa security (D15): no hay llamante, y la clave la acota solo la operación.
const batchJobOwnerAnonymous = ${goString(BATCH_ANONYMOUS_OWNER)}

// batchJobOwner es el dueño de un trabajo: sin capa security, siempre el mismo.
func batchJobOwner(context.Context) string {
	return batchJobOwnerAnonymous
}
`;
}

function settingsBody(model) {
  const keyed = usesKeyedBatches(model);
  const S = BATCH_SYNC_STALE;
  const fields = alignRows([
    { text: '\t// ChunkSize es cuántos elementos procesa cada disparo del temporizador de un trabajo (D9): por debajo del arriendo del' },
    { text: '\t// cronómetro.' },
    { indent: '\t', cells: ['ChunkSize', 'int'] },
    { text: '\t// RetentionDays es cuántos días vive un trabajo TERMINADO con sus resultados (D10).' },
    { indent: '\t', cells: ['RetentionDays', 'int'] },
    { text: '\t// PurgeCron es el cron (seis campos, en UTC) de su purga.' },
    { indent: '\t', cells: ['PurgeCron', 'string'] },
    ...(keyed
      ? [
          { text: '\t// SyncStaleMs es cuántos milisegundos sin escribirse hacen falta para dar por muerto un lote síncrono con clave sin' },
          { text: '\t// terminar (D15).' },
          { indent: '\t', cells: ['SyncStaleMs', 'int'] }
        ]
      : [])
  ]);
  const defaults = [
    `ChunkSize: ${P.chunkSize.default}`,
    `RetentionDays: ${P.retentionDays.default}`,
    `PurgeCron: ${goString(P.purgeCron.default)}`,
    ...(keyed ? [`SyncStaleMs: ${S.default}`] : [])
  ];
  const stale = keyed
    ? `
	if settings.SyncStaleMs, err = batchPositive(cfg, ${goString(S.key)}, settings.SyncStaleMs); err != nil {
		return BatchSettings{}, err
	}`
    : '';
  return `
// BatchSettings es la mecánica de los lotes con trabajo del perfil (config/parameters/<perfil>/batch.yaml), con las claves y
// los defaults de keel-core (BATCH_PARAMETERS${keyed ? ' y BATCH_SYNC_STALE' : ''}), los mismos en los cuatro generadores.
type BatchSettings struct {
${fields.join('\n')}
}

// BatchSettingsFrom lee la mecánica de los lotes al ARRANCAR: un número que no es un entero positivo no deja arrancar.
func BatchSettingsFrom(cfg *config.Config) (BatchSettings, error) {
	settings := BatchSettings{${defaults.join(', ')}}
	if value, ok := cfg.Value(${goString(P.purgeCron.key)}); ok && strings.TrimSpace(value) != "" {
		settings.PurgeCron = strings.TrimSpace(value)
	}
	var err error
	if settings.ChunkSize, err = batchPositive(cfg, ${goString(P.chunkSize.key)}, settings.ChunkSize); err != nil {
		return BatchSettings{}, err
	}
	if settings.RetentionDays, err = batchPositive(cfg, ${goString(P.retentionDays.key)}, settings.RetentionDays); err != nil {
		return BatchSettings{}, err
	}${stale}
	return settings, nil
}

// batchPositive es el entero positivo de key, o fallback si el perfil no lo declara.
func batchPositive(cfg *config.Config, key string, fallback int) (int, error) {
	value, ok := cfg.Value(key)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s tiene que ser un entero positivo: %q", key, value)
	}
	return n, nil
}
`;
}

// ─── El dominio ──────────────────────────────────────────────────────────────────────────────────

function domainBody(model) {
  const S = BATCH_JOB_STATUSES;
  const keyed = usesKeyedBatches(model);
  const job = alignRows([
    { indent: '\t', cells: ['ID', 'uuid.UUID'] },
    { indent: '\t', cells: ['Operation', 'string'] },
    { indent: '\t', cells: ['Owner', 'string'] },
    { indent: '\t', cells: ['Status', 'string'] },
    { indent: '\t', cells: ['Input', 'string'] },
    { indent: '\t', cells: ['Total', 'int'] },
    { indent: '\t', cells: ['NextIndex', 'int'] },
    { indent: '\t', cells: ['Succeeded', 'int'] },
    { indent: '\t', cells: ['Failed', 'int'] },
    { indent: '\t', cells: ['CreatedAt', 'time.Time'] },
    { indent: '\t', cells: ['FinishedAt', '*time.Time'] }
  ]);
  const draft = alignRows([
    { indent: '\t', cells: ['ID', 'uuid.UUID'] },
    { indent: '\t', cells: ['Operation', 'string'] },
    { text: '\t// Kind es el kind del temporizador de UNA vez que lo procesa (batch:<operación>); vacío, sin temporizador: lo' },
    { text: '\t// procesa la petición (un lote síncrono con clave, D15).' },
    { indent: '\t', cells: ['Kind', 'string'] },
    { text: '\t// Key es la clave de idempotencia del lote (D13); nil, sin clave.' },
    { indent: '\t', cells: ['Key', '*string'] },
    { text: '\t// Signature es el sha256 de los bytes del cuerpo: distingue el reintento de la clave reutilizada.' },
    { indent: '\t', cells: ['Signature', 'string'] },
    { text: '\t// KeyTTL es cuánto vale la clave; nil, sin ventana.' },
    { indent: '\t', cells: ['KeyTTL', '*time.Duration'] },
    { text: '\t// Input es el cuerpo de la petición tal como llegó: el procesador lo vuelve a leer con el lector del borde.' },
    { indent: '\t', cells: ['Input', 'string'] },
    { indent: '\t', cells: ['Total', 'int'] }
  ]);
  const result = alignRows([
    { indent: '\t', cells: ['Index', 'int'] },
    { indent: '\t', cells: ['Status', 'string'] },
    { indent: '\t', cells: ['ErrorCode', '*string'] },
    { indent: '\t', cells: ['Message', '*string'] },
    { text: '\t// Result es el result del elemento serializado con las reglas del cable; viaja tal cual.' },
    { indent: '\t', cells: ['Result', '*string'] }
  ]);
  return `
// Los estados de un trabajo de un lote (DSL 2.30, keel-core/gen/batch-store.js). Un lote asíncrono es per-item (D14), y el
// todo o nada con clave que falla borra su trabajo, así que no hay «revertido».
const (
	// BatchJobQueued es un trabajo creado: nada procesado todavía.
	BatchJobQueued = ${goString(S.queued)}
	// BatchJobRunning es un trabajo con al menos un elemento con su resultado.
	BatchJobRunning = ${goString(S.running)}
	// BatchJobCompleted es un trabajo con todos sus elementos intentados.
	BatchJobCompleted = ${goString(S.completed)}
	// BatchJobAborted es un trabajo detenido por un elemento que no falla solo él (D4): lo que queda es notAttempted.
	BatchJobAborted = ${goString(S.aborted)}
)

// BatchJob es un trabajo de un lote asíncrono como está en el almacén. NextIndex es el cursor: todo elemento por debajo
// tiene su resultado guardado.
type BatchJob struct {
${job.join('\n')}
}

// NewBatchJob es el alta de un trabajo.
type NewBatchJob struct {
${draft.join('\n')}
}

// BatchJobKey es el trabajo vivo de una clave de idempotencia (D13), con la firma de la petición que lo creó.
type BatchJobKey struct {
	ID        uuid.UUID
	Signature string
}

// BatchJobResult es el resultado de un elemento intentado, con las claves del cable.
type BatchJobResult struct {
${result.join('\n')}
}

// BatchJobStore son los trabajos de los lotes asíncronos (DSL 2.30) y sus resultados (${BATCH_JOB.table} y ${BATCH_ITEM_RESULT.table}): las
// sentencias son las de keel-core, iguales en los cuatro generadores, y toda hora es la de la base. Se une a la
// transacción abierta en el contexto: el alta va con el temporizador del trabajo, y el avance y el resultado de cada
// elemento con su efecto (D9). El dueño de un trabajo es el actor de autoría del contexto (D11): lo guarda el alta, y la
// clave y las dos rutas solo ven los suyos.
type BatchJobStore interface {
	// ByKey es el trabajo vivo de esa clave del llamante: el que la tiene y cuya ventana no pasó.
	ByKey(ctx context.Context, operation, key string) (BatchJobKey, bool, error)
	// ReleaseKey libera la clave del llamante si su ventana pasó: el alta siguiente la puede tomar, y el trabajo viejo sigue
	// legible por su id.
	ReleaseKey(ctx context.Context, operation, key string) error
	// Insert da de alta un trabajo en ${BATCH_JOB_STATUSES.queued}, con el cursor en 0, y arma su temporizador para ya.
	Insert(ctx context.Context, job NewBatchJob) error
	// Job es lo que lee el procesador.
	Job(ctx context.Context, id uuid.UUID) (BatchJob, bool, error)
	// Owned es lo que leen las dos rutas (D11): de otro dueño u otra operación es como si no existiera.
	Owned(ctx context.Context, id uuid.UUID, operation string) (BatchJob, bool, error)
	// Advance avanza el cursor desde index, con su contador. false: el cursor ya no estaba ahí (la valla, D9).
	Advance(ctx context.Context, id uuid.UUID, index int, succeeded bool) (bool, error)
	// InsertResult guarda el resultado de un elemento.
	InsertResult(ctx context.Context, jobID uuid.UUID, result BatchJobResult) error
	// Finish cierra el trabajo (${BATCH_JOB_STATUSES.completed} o ${BATCH_JOB_STATUSES.aborted}), una sola vez.
	Finish(ctx context.Context, id uuid.UUID, status string) (bool, error)
	// Results son los resultados de una página, en orden de índice.
	Results(ctx context.Context, jobID uuid.UUID, pageable Pageable) (Page[BatchJobResult], error)
	// Purge borra los trabajos terminados hace más de retentionDays, con sus resultados (D10). Nunca uno en marcha.
	Purge(ctx context.Context, retentionDays int) (int64, error)${
    keyed
      ? `
	// TakeOver toma un lote síncrono con clave sin terminar que nadie escribe desde hace más de batch.sync-stale-ms (D15), con
	// la hora de la base. false: sigue en marcha.
	TakeOver(ctx context.Context, id uuid.UUID) (bool, error)
	// Discard borra el trabajo de un todo o nada con clave que no se confirmó (D15): libera la clave. Nunca uno terminado.
	Discard(ctx context.Context, id uuid.UUID) (bool, error)`
      : ''
  }
}
`;
}

// ─── El almacén relacional ───────────────────────────────────────────────────────────────────────

const SQL_NAMES = ['insertJob', 'byKey', 'releaseKey', 'job', 'ownedJob', 'insertResult', 'advance', 'finish', 'resultsPage', 'resultsCount', 'purgeResults', 'purgeJobs'];

/** La constante Go de una sentencia de los lotes: `batchSQLInsertJob`. */
export const batchStatementConstant = (name) => `batchSQL${name[0].toUpperCase()}${name.slice(1)}`;

/** Las sentencias del almacén del modelo: las del lote síncrono con clave (D15), solo si lo hay. */
export function batchStatementsOf(model) {
  const engine = relationalEngine(model);
  const keyed = usesKeyedBatches(model);
  const S = { ...batchStatements(engine), ...(keyed ? batchSyncStatements(engine) : {}) };
  return [...SQL_NAMES, ...(keyed ? ['takeOver', 'discardJob'] : [])].map((name) => ({ name, sql: S[name] }));
}

function sqlStoreBody(model) {
  const S = Object.fromEntries(batchStatementsOf(model).map(({ name, sql }) => [name, sql]));
  const d = sqlDialect(model);
  const keyed = usesKeyedBatches(model);
  const constants = Object.keys(S).flatMap((name) => [
    { text: `\t// ${batchStatementConstant(name)} es la sentencia «${name}» de keel-core.` },
    { indent: '\t', cells: [batchStatementConstant(name), `= ${goString(S[name])}`] }
  ]);
  const c = batchStatementConstant;
  return `
// Las sentencias de los lotes asíncronos sobre ${d.label}, de keel-core (gen/batch-store.js) TAL CUAL, con sus marcadores
// nombrados (los pasa al estilo del driver timerSQL, el del cronómetro): son contrato con los otros generadores, que comparten
// las tablas, y las mide timer-sql-check contra el motor. No las reescribas aquí.
const (
${alignRows(constants).join('\n')}
)

// BatchJobStore son los trabajos de los lotes sobre ${d.label}: implementa domain.BatchJobStore por la transacción abierta en el
// contexto, como el cronómetro y el historial. El dueño es batchJobOwner.
type BatchJobStore struct {
	tx *Transactions${
    keyed
      ? `
	// syncStaleMs es el umbral del lote síncrono con clave muerto (batch.sync-stale-ms, D15).
	syncStaleMs int`
      : ''
  }
}

var _ domain.BatchJobStore = (*BatchJobStore)(nil)

// NewBatchJobStore construye el almacén sobre las transacciones del servicio${keyed ? ', con el umbral del lote muerto' : ''}.
func NewBatchJobStore(tx *Transactions${keyed ? ', syncStaleMs int' : ''}) *BatchJobStore {
	return &BatchJobStore{tx: tx${keyed ? ', syncStaleMs: syncStaleMs' : ''}}
}

// ByKey implementa domain.BatchJobStore.
func (s *BatchJobStore) ByKey(ctx context.Context, operation, key string) (domain.BatchJobKey, bool, error) {
	var hit domain.BatchJobKey
	var signature sql.NullString
	found, err := s.row(ctx, ${c('byKey')}, map[string]any{"operation": operation, "owner": batchJobOwner(ctx), "key": key}, &hit.ID, &signature)
	hit.Signature = signature.String
	return hit, found, err
}

// ReleaseKey implementa domain.BatchJobStore.
func (s *BatchJobStore) ReleaseKey(ctx context.Context, operation, key string) error {
	_, err := s.write(ctx, ${c('releaseKey')}, map[string]any{"operation": operation, "owner": batchJobOwner(ctx), "key": key})
	return err
}

// Insert implementa domain.BatchJobStore: el trabajo y su temporizador de UNA vez, para ya, en la misma transacción (D9).
func (s *BatchJobStore) Insert(ctx context.Context, job domain.NewBatchJob) error {
	var key, ttl any
	if job.Key != nil {
		key = *job.Key
	}
	if job.KeyTTL != nil {
		ttl = job.KeyTTL.Milliseconds()
	}
	return s.tx.write(ctx, func(q DBTX) error {
		values := map[string]any{"id": job.ID, "operation": job.Operation, "owner": batchJobOwner(ctx), "key": key, "signature": job.Signature, "ttlMs": ttl, "input": job.Input, "total": job.Total}
		if _, err := timerExec(ctx, q, ${c('insertJob')}, values); err != nil {
			return err
		}${
      keyed
        ? `
		if job.Kind == "" {
			// Un lote síncrono con clave (D15): sin temporizador, lo procesa la petición.
			return nil
		}`
        : ''
    }
		var now time.Time
		if err := q.QueryRowContext(ctx, timerDBNow).Scan(&now); err != nil {
			return err
		}
		return s.tx.armTimer(ctx, q, job.Kind, job.ID, now.UTC())
	})
}

// Job implementa domain.BatchJobStore.
func (s *BatchJobStore) Job(ctx context.Context, id uuid.UUID) (domain.BatchJob, bool, error) {
	return s.job(ctx, ${c('job')}, map[string]any{"id": id})
}

// Owned implementa domain.BatchJobStore: solo un trabajo de esa operación y del llamante.
func (s *BatchJobStore) Owned(ctx context.Context, id uuid.UUID, operation string) (domain.BatchJob, bool, error) {
	return s.job(ctx, ${c('ownedJob')}, map[string]any{"id": id, "operation": operation, "owner": batchJobOwner(ctx)})
}

// Advance implementa domain.BatchJobStore: la valla del elemento.
func (s *BatchJobStore) Advance(ctx context.Context, id uuid.UUID, index int, succeeded bool) (bool, error) {
	ok, failed := 1, 0
	if !succeeded {
		ok, failed = 0, 1
	}
	touched, err := s.write(ctx, ${c('advance')}, map[string]any{"succeeded": ok, "failed": failed, "id": id, "index": index})
	return touched == 1, err
}

// InsertResult implementa domain.BatchJobStore.
func (s *BatchJobStore) InsertResult(ctx context.Context, jobID uuid.UUID, result domain.BatchJobResult) error {
	values := map[string]any{"jobId": jobID, "index": result.Index, "status": result.Status, "errorCode": nullText(result.ErrorCode), "message": nullText(result.Message), "result": nullText(result.Result)}
	_, err := s.write(ctx, ${c('insertResult')}, values)
	return err
}

// Finish implementa domain.BatchJobStore.
func (s *BatchJobStore) Finish(ctx context.Context, id uuid.UUID, status string) (bool, error) {
	touched, err := s.write(ctx, ${c('finish')}, map[string]any{"status": status, "id": id})
	return touched == 1, err
}

// Results implementa domain.BatchJobStore.
func (s *BatchJobStore) Results(ctx context.Context, jobID uuid.UUID, pageable domain.Pageable) (domain.Page[domain.BatchJobResult], error) {
	q, err := s.tx.conn(ctx)
	if err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	query, args, err := timerSQL(${c('resultsPage')}, map[string]any{"jobId": jobID, "limit": pageable.Size, "offset": pageable.Offset()})
	if err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	var results []domain.BatchJobResult
	for rows.Next() {
		var result domain.BatchJobResult
		var code, message, value sql.NullString
		if err := rows.Scan(&result.Index, &result.Status, &code, &message, &value); err != nil {
			return domain.Page[domain.BatchJobResult]{}, errors.Join(err, rows.Close())
		}
		result.ErrorCode, result.Message, result.Result = textOf(code), textOf(message), textOf(value)
		results = append(results, result)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	var total int64
	if _, err := s.row(ctx, ${c('resultsCount')}, map[string]any{"jobId": jobID}, &total); err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	return domain.NewPage(results, pageable, total), nil
}

// Purge implementa domain.BatchJobStore: primero los resultados (la FK ya borra en cascada, pero no se depende de ella).
func (s *BatchJobStore) Purge(ctx context.Context, retentionDays int) (int64, error) {
	var purged int64
	err := s.tx.write(ctx, func(q DBTX) error {
		if _, err := timerExec(ctx, q, ${c('purgeResults')}, map[string]any{"retentionDays": retentionDays}); err != nil {
			return err
		}
		var err error
		purged, err = timerExec(ctx, q, ${c('purgeJobs')}, map[string]any{"retentionDays": retentionDays})
		return err
	})
	return purged, err
}
${
  keyed
    ? `
// TakeOver implementa domain.BatchJobStore: toma el lote muerto con la hora de la base.
func (s *BatchJobStore) TakeOver(ctx context.Context, id uuid.UUID) (bool, error) {
	touched, err := s.write(ctx, ${c('takeOver')}, map[string]any{"id": id, "staleMs": s.syncStaleMs})
	return touched == 1, err
}

// Discard implementa domain.BatchJobStore.
func (s *BatchJobStore) Discard(ctx context.Context, id uuid.UUID) (bool, error) {
	touched, err := s.write(ctx, ${c('discardJob')}, map[string]any{"id": id})
	return touched == 1, err
}
`
    : ''
}
// job lee un trabajo con una de las dos sentencias que lo leen entero.
func (s *BatchJobStore) job(ctx context.Context, statement string, values map[string]any) (domain.BatchJob, bool, error) {
	var job domain.BatchJob
	var key, signature sql.NullString
	var keyExpiresAt, finishedAt sql.NullTime
	var updatedAt time.Time
	found, err := s.row(ctx, statement, values, &job.ID, &job.Operation, &job.Owner, &job.Status, &key, &signature, &keyExpiresAt, &job.Input, &job.Total, &job.NextIndex, &job.Succeeded, &job.Failed, &job.CreatedAt, &updatedAt, &finishedAt)
	if err != nil || !found {
		return domain.BatchJob{}, found, err
	}
	job.CreatedAt = job.CreatedAt.UTC()
	if finishedAt.Valid {
		finished := finishedAt.Time.UTC()
		job.FinishedAt = &finished
	}
	return job, true, nil
}

// row lee una fila de una sentencia de los lotes, en la transacción abierta si la hay; false si no hay ninguna.
func (s *BatchJobStore) row(ctx context.Context, statement string, values map[string]any, dest ...any) (bool, error) {
	q, err := s.tx.conn(ctx)
	if err != nil {
		return false, err
	}
	query, args, err := timerSQL(statement, values)
	if err != nil {
		return false, err
	}
	err = q.QueryRowContext(ctx, query, args...).Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// write ejecuta una escritura de los lotes en la transacción abierta o, sin ella, en una suya: las filas que tocó.
func (s *BatchJobStore) write(ctx context.Context, statement string, values map[string]any) (int64, error) {
	var touched int64
	err := s.tx.write(ctx, func(q DBTX) error {
		var err error
		touched, err = timerExec(ctx, q, statement, values)
		return err
	})
	return touched, err
}

// nullText es un texto opcional como argumento: nil es NULL.
func nullText(text *string) any {
	if text == nil {
		return nil
	}
	return *text
}

// textOf es un texto opcional leído de la base.
func textOf(text sql.NullString) *string {
	if !text.Valid {
		return nil
	}
	return &text.String
}
`;
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────

function mongoStoreBody(model) {
  const { job, result } = BATCH_JOB_COLLECTIONS;
  const keyed = usesKeyedBatches(model);
  const collections = alignRows([
    { indent: '\t', cells: ['batchJobCollection', `= ${goString(job.collection)}`] },
    { indent: '\t', cells: ['batchResultCollection', `= ${goString(result.collection)}`] }
  ]);
  return `
// Las colecciones de los lotes asíncronos (keel-core, BATCH_JOB_COLLECTIONS): los nombres de campo son los de las columnas,
// el trabajo lleva su id (texto) en _id y cada resultado la clave aplanada <job>|<índice>, que hace que el motor rechace un
// segundo resultado del mismo elemento. La unicidad de la clave de idempotencia es PARCIAL (indexes.go): en MongoDB dos
// ausentes sí chocan.
const (
${collections.join('\n')}
)

// BatchJobStore son los trabajos de los lotes sobre MongoDB: implementa domain.BatchJobStore por la sesión de la transacción
// abierta en el contexto. La hora es la del servidor ($$NOW, la del cronómetro). El dueño es batchJobOwner.
type BatchJobStore struct {
	tx *Transactions${
    keyed
      ? `
	// syncStaleMs es el umbral del lote síncrono con clave muerto (batch.sync-stale-ms, D15).
	syncStaleMs int`
      : ''
  }
}

var _ domain.BatchJobStore = (*BatchJobStore)(nil)

// NewBatchJobStore construye el almacén sobre las transacciones del servicio${keyed ? ', con el umbral del lote muerto' : ''}.
func NewBatchJobStore(tx *Transactions${keyed ? ', syncStaleMs int' : ''}) *BatchJobStore {
	return &BatchJobStore{tx: tx${keyed ? ', syncStaleMs: syncStaleMs' : ''}}
}

// ByKey implementa domain.BatchJobStore.
func (s *BatchJobStore) ByKey(ctx context.Context, operation, key string) (domain.BatchJobKey, bool, error) {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return domain.BatchJobKey{}, false, err
	}
	live := bson.A{bson.D{{Key: "key_expires_at", Value: nil}}, bson.D{{Key: "key_expires_at", Value: bson.D{{Key: "$gt", Value: bson.NewDateTimeFromTime(now)}}}}}
	filter := bson.D{{Key: "operation", Value: operation}, {Key: "owner", Value: batchJobOwner(ctx)}, {Key: "idempotency_key", Value: key}, {Key: "$or", Value: live}}
	raw, err := jobs.FindOne(ctx, filter).Raw()
	if errors.Is(err, mongodriver.ErrNoDocuments) {
		return domain.BatchJobKey{}, false, nil
	}
	if err != nil {
		return domain.BatchJobKey{}, false, err
	}
	text, _ := raw.Lookup("_id").StringValueOK()
	id, err := uuid.Parse(text)
	if err != nil {
		return domain.BatchJobKey{}, false, err
	}
	signature, _ := raw.Lookup("signature").StringValueOK()
	return domain.BatchJobKey{ID: id, Signature: signature}, true, nil
}

// ReleaseKey implementa domain.BatchJobStore.
func (s *BatchJobStore) ReleaseKey(ctx context.Context, operation, key string) error {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return err
	}
	filter := bson.D{{Key: "operation", Value: operation}, {Key: "owner", Value: batchJobOwner(ctx)}, {Key: "idempotency_key", Value: key}, {Key: "key_expires_at", Value: bson.D{{Key: "$lte", Value: bson.NewDateTimeFromTime(now)}}}}
	return s.tx.write(ctx, func(ctx context.Context) error {
		_, err := jobs.UpdateMany(ctx, filter, bson.D{{Key: "$unset", Value: bson.D{{Key: "idempotency_key", Value: ""}}}})
		return err
	})
}

// Insert implementa domain.BatchJobStore: el trabajo y su temporizador de UNA vez, para ya, en la misma transacción (D9).
func (s *BatchJobStore) Insert(ctx context.Context, job domain.NewBatchJob) error {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return err
	}
	document := bson.D{{Key: "_id", Value: job.ID.String()}, {Key: "operation", Value: job.Operation}, {Key: "owner", Value: batchJobOwner(ctx)}, {Key: "status", Value: domain.BatchJobQueued}}
	// Sin clave el campo no existe: el índice parcial solo mira los trabajos que tienen una.
	if job.Key != nil {
		document = append(document, bson.E{Key: "idempotency_key", Value: *job.Key})
	}
	var expires any
	if job.KeyTTL != nil {
		expires = bson.NewDateTimeFromTime(now.Add(*job.KeyTTL))
	}
	at := bson.NewDateTimeFromTime(now)
	document = append(document,
		bson.E{Key: "signature", Value: job.Signature},
		bson.E{Key: "key_expires_at", Value: expires},
		bson.E{Key: "input", Value: job.Input},
		bson.E{Key: "total", Value: int32(job.Total)},
		bson.E{Key: "next_index", Value: int32(0)},
		bson.E{Key: "succeeded", Value: int32(0)},
		bson.E{Key: "failed", Value: int32(0)},
		bson.E{Key: "created_at", Value: at},
		bson.E{Key: "updated_at", Value: at},
		bson.E{Key: "finished_at", Value: nil},
	)
	return s.tx.write(ctx, func(ctx context.Context) error {
		if _, err := jobs.InsertOne(ctx, document); err != nil {
			return err
		}${
      keyed
        ? `
		if job.Kind == "" {
			// Un lote síncrono con clave (D15): sin temporizador, lo procesa la petición.
			return nil
		}`
        : ''
    }
		return s.tx.armTimer(ctx, job.Kind, job.ID, now)
	})
}

// Job implementa domain.BatchJobStore.
func (s *BatchJobStore) Job(ctx context.Context, id uuid.UUID) (domain.BatchJob, bool, error) {
	return s.find(ctx, bson.D{{Key: "_id", Value: id.String()}})
}

// Owned implementa domain.BatchJobStore: solo un trabajo de esa operación y del llamante.
func (s *BatchJobStore) Owned(ctx context.Context, id uuid.UUID, operation string) (domain.BatchJob, bool, error) {
	return s.find(ctx, bson.D{{Key: "_id", Value: id.String()}, {Key: "operation", Value: operation}, {Key: "owner", Value: batchJobOwner(ctx)}})
}

// Advance implementa domain.BatchJobStore: la valla del elemento.
func (s *BatchJobStore) Advance(ctx context.Context, id uuid.UUID, index int, succeeded bool) (bool, error) {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return false, err
	}
	ok, failed := int32(1), int32(0)
	if !succeeded {
		ok, failed = 0, 1
	}
	update := bson.D{
		{Key: "$inc", Value: bson.D{{Key: "next_index", Value: int32(1)}, {Key: "succeeded", Value: ok}, {Key: "failed", Value: failed}}},
		{Key: "$set", Value: bson.D{{Key: "status", Value: domain.BatchJobRunning}, {Key: "updated_at", Value: bson.NewDateTimeFromTime(now)}}},
	}
	var matched int64
	err = s.tx.write(ctx, func(ctx context.Context) error {
		result, err := jobs.UpdateOne(ctx, bson.D{{Key: "_id", Value: id.String()}, {Key: "next_index", Value: index}}, update)
		if err == nil {
			matched = result.MatchedCount
		}
		return err
	})
	return matched == 1, err
}

// InsertResult implementa domain.BatchJobStore.
func (s *BatchJobStore) InsertResult(ctx context.Context, jobID uuid.UUID, result domain.BatchJobResult) error {
	results, err := s.tx.collection(batchResultCollection)
	if err != nil {
		return err
	}
	job := jobID.String()
	document := bson.D{
		{Key: "_id", Value: job + "|" + strconv.Itoa(result.Index)},
		{Key: "job_id", Value: job},
		{Key: "item_index", Value: int32(result.Index)},
		{Key: "status", Value: result.Status},
		{Key: "error_code", Value: nullText(result.ErrorCode)},
		{Key: "message", Value: nullText(result.Message)},
		{Key: "result", Value: nullText(result.Result)},
	}
	return s.tx.write(ctx, func(ctx context.Context) error {
		_, err := results.InsertOne(ctx, document)
		return err
	})
}

// Finish implementa domain.BatchJobStore.
func (s *BatchJobStore) Finish(ctx context.Context, id uuid.UUID, status string) (bool, error) {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return false, err
	}
	at := bson.NewDateTimeFromTime(now)
	var matched int64
	err = s.tx.write(ctx, func(ctx context.Context) error {
		result, err := jobs.UpdateOne(ctx, bson.D{{Key: "_id", Value: id.String()}, {Key: "finished_at", Value: nil}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: status}, {Key: "finished_at", Value: at}, {Key: "updated_at", Value: at}}}})
		if err == nil {
			matched = result.MatchedCount
		}
		return err
	})
	return matched == 1, err
}

// Results implementa domain.BatchJobStore.
func (s *BatchJobStore) Results(ctx context.Context, jobID uuid.UUID, pageable domain.Pageable) (domain.Page[domain.BatchJobResult], error) {
	results, err := s.tx.collection(batchResultCollection)
	if err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	filter := bson.D{{Key: "job_id", Value: jobID.String()}}
	total, err := results.CountDocuments(ctx, filter)
	if err != nil {
		return domain.Page[domain.BatchJobResult]{}, err
	}
	var page []domain.BatchJobResult
	// Un límite 0 en MongoDB es «sin límite»: una página de tamaño 0 no lee nada.
	if pageable.Size > 0 {
		cursor, err := results.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "item_index", Value: 1}}).SetSkip(pageable.Offset()).SetLimit(int64(pageable.Size)))
		if err != nil {
			return domain.Page[domain.BatchJobResult]{}, err
		}
		for cursor.Next(ctx) {
			index, _ := cursor.Current.Lookup("item_index").AsInt64OK()
			status, _ := cursor.Current.Lookup("status").StringValueOK()
			page = append(page, domain.BatchJobResult{Index: int(index), Status: status, ErrorCode: rawText(cursor.Current, "error_code"), Message: rawText(cursor.Current, "message"), Result: rawText(cursor.Current, "result")})
		}
		if err := errors.Join(cursor.Err(), cursor.Close(ctx)); err != nil {
			return domain.Page[domain.BatchJobResult]{}, err
		}
	}
	return domain.NewPage(page, pageable, total), nil
}

// Purge implementa domain.BatchJobStore: los trabajos terminados hace más de la retención, primero sus resultados.
func (s *BatchJobStore) Purge(ctx context.Context, retentionDays int) (int64, error) {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return 0, err
	}
	results, err := s.tx.collection(batchResultCollection)
	if err != nil {
		return 0, err
	}
	before := bson.NewDateTimeFromTime(now.AddDate(0, 0, -retentionDays))
	var purged int64
	err = s.tx.write(outside(ctx), func(ctx context.Context) error {
		cursor, err := jobs.Find(ctx, bson.D{{Key: "finished_at", Value: bson.D{{Key: "$ne", Value: nil}, {Key: "$lt", Value: before}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
		if err != nil {
			return err
		}
		var ids bson.A
		for cursor.Next(ctx) {
			ids = append(ids, cursor.Current.Lookup("_id"))
		}
		if err := errors.Join(cursor.Err(), cursor.Close(ctx)); err != nil || len(ids) == 0 {
			return err
		}
		if _, err := results.DeleteMany(ctx, bson.D{{Key: "job_id", Value: bson.D{{Key: "$in", Value: ids}}}}); err != nil {
			return err
		}
		deleted, err := jobs.DeleteMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err == nil {
			purged = deleted.DeletedCount
		}
		return err
	})
	return purged, err
}
${
  keyed
    ? `
// TakeOver implementa domain.BatchJobStore: toma el lote muerto con la hora del servidor.
func (s *BatchJobStore) TakeOver(ctx context.Context, id uuid.UUID) (bool, error) {
	now, jobs, err := s.prepare(ctx)
	if err != nil {
		return false, err
	}
	stale := bson.NewDateTimeFromTime(now.Add(-time.Duration(s.syncStaleMs) * time.Millisecond))
	filter := bson.D{{Key: "_id", Value: id.String()}, {Key: "finished_at", Value: nil}, {Key: "updated_at", Value: bson.D{{Key: "$lte", Value: stale}}}}
	var matched int64
	err = s.tx.write(ctx, func(ctx context.Context) error {
		result, err := jobs.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: bson.D{{Key: "updated_at", Value: bson.NewDateTimeFromTime(now)}}}})
		if err == nil {
			matched = result.MatchedCount
		}
		return err
	})
	return matched == 1, err
}

// Discard implementa domain.BatchJobStore.
func (s *BatchJobStore) Discard(ctx context.Context, id uuid.UUID) (bool, error) {
	jobs, err := s.tx.collection(batchJobCollection)
	if err != nil {
		return false, err
	}
	var deleted int64
	err = s.tx.write(ctx, func(ctx context.Context) error {
		result, err := jobs.DeleteOne(ctx, bson.D{{Key: "_id", Value: id.String()}, {Key: "finished_at", Value: nil}})
		if err == nil {
			deleted = result.DeletedCount
		}
		return err
	})
	return deleted == 1, err
}
`
    : ''
}
// prepare es la hora del servidor y la colección de los trabajos.
func (s *BatchJobStore) prepare(ctx context.Context) (time.Time, *mongodriver.Collection, error) {
	jobs, err := s.tx.collection(batchJobCollection)
	if err != nil {
		return time.Time{}, nil, err
	}
	now, err := NewTimerStore(s.tx).DBNow(ctx)
	return now, jobs, err
}

// find lee un trabajo, en la sesión abierta si la hay.
func (s *BatchJobStore) find(ctx context.Context, filter bson.D) (domain.BatchJob, bool, error) {
	jobs, err := s.tx.collection(batchJobCollection)
	if err != nil {
		return domain.BatchJob{}, false, err
	}
	raw, err := jobs.FindOne(ctx, filter).Raw()
	if errors.Is(err, mongodriver.ErrNoDocuments) {
		return domain.BatchJob{}, false, nil
	}
	if err != nil {
		return domain.BatchJob{}, false, err
	}
	text, _ := raw.Lookup("_id").StringValueOK()
	id, err := uuid.Parse(text)
	if err != nil {
		return domain.BatchJob{}, false, fmt.Errorf("un trabajo con un _id que no es un uuid (%q): %w", text, err)
	}
	job := domain.BatchJob{ID: id, Total: rawInt(raw, "total"), NextIndex: rawInt(raw, "next_index"), Succeeded: rawInt(raw, "succeeded"), Failed: rawInt(raw, "failed")}
	job.Operation, _ = raw.Lookup("operation").StringValueOK()
	job.Owner, _ = raw.Lookup("owner").StringValueOK()
	job.Status, _ = raw.Lookup("status").StringValueOK()
	job.Input, _ = raw.Lookup("input").StringValueOK()
	if created, ok := raw.Lookup("created_at").DateTimeOK(); ok {
		job.CreatedAt = time.UnixMilli(created).UTC()
	}
	if finished, ok := raw.Lookup("finished_at").DateTimeOK(); ok {
		at := time.UnixMilli(finished).UTC()
		job.FinishedAt = &at
	}
	return job, true, nil
}

// rawInt es un entero del documento, se guardara como int32 o como int64 (los cuatro servidores comparten la colección).
func rawInt(raw bson.Raw, key string) int {
	n, _ := raw.Lookup(key).AsInt64OK()
	return int(n)
}

// rawText es un texto opcional del documento.
func rawText(raw bson.Raw, key string) *string {
	text, ok := raw.Lookup(key).StringValueOK()
	if !ok {
		return nil
	}
	return &text
}

// nullText es un texto opcional como valor: nil es null.
func nullText(text *string) any {
	if text == nil {
		return nil
	}
	return *text
}
`;
}

// ─── La entrada HTTP: el alta, las dos rutas y el procesador ─────────────────────────────────────

function httpBody(model) {
  const asynchronous = usesAsyncBatchJobs(model);
  const keyed = usesKeyedBatches(model);
  const steps = usesItemSteps(model);
  return `
// Los lotes con trabajo (DSL 2.30; wire-contract.md § Lotes): ${[
    ...(asynchronous ? ['los asíncronos (el trabajo en el cable, el alta, las dos rutas que lo leen y el procesador que lo recorre por partes sobre el cronómetro)'] : []),
    ...(keyed ? ['los síncronos con clave (D15: su clave y su respuesta las guarda el trabajo, sin temporizador)'] : [])
  ].join(', y ')}.
${sharedHttpBody(model, steps)}${asynchronous ? asyncHttpBody(model) : ''}${keyed ? keyedHttpBody(model) : ''}`;
}

/** Lo que comparten el alta asíncrona, el procesador y los lotes con clave: el cuerpo, su firma, el paso de un elemento. */
function sharedHttpBody(model, steps) {
  const { aborted } = BATCH_JOB_STATUSES;
  const stepsCode = steps
    ? `
// errBatchFenceLost es el cursor que ya no está donde lo dejó quien procesa: otra réplica, o la repetición de la petición, se
// llevó el trabajo. Revierte el elemento entero, efecto incluido.
var errBatchFenceLost = errors.New("el trabajo lo procesa otro")

// batchStep es lo que deja un elemento: seguir, parar (el lote se detuvo, D4) o perder el trabajo (la valla).
type batchStep int

const (
	batchNext batchStep = iota
	batchStop
	batchLost
)

// processBatchItem es un elemento de un lote con trabajo (D9, D15), en UNA transacción con su efecto (el despacho por su
// caso de uso, que se une a ella), el avance del cursor y su resultado. El avance es la VALLA: solo avanza si el cursor sigue
// donde lo dejó quien procesa, y si no —otra réplica, o la repetición de la petición, se llevó el trabajo— el elemento
// revierte entero. Fallan solo su elemento los codes de itemErrors y ${FRAMEWORK_ERRORS.validation.code}; cualquier otro fallo detiene el
// lote (${aborted}, D4).
func processBatchItem[T, M any](r *http.Request, a *api, store domain.BatchJobStore, jobID uuid.UUID, index int, raw jsontext.Value, msg M, itemErrors []string, process func(context.Context, M, T) (any, error)) (batchStep, error) {
	item, problem := readBatchItem[T](raw)
	if problem != "" {
		return a.failedBatchItem(r.Context(), store, jobID, batchFailed(index, validationCode, problem), false)
	}
	err := a.useCases.InTransaction(r.Context(), func(ctx context.Context) error {
		result, err := process(ctx, msg, item)
		if err != nil {
			return err
		}
		return keepBatchItem(ctx, store, jobID, batchSucceeded(index, result))
	})
	switch {
	case err == nil:
		return batchNext, nil
	case errors.Is(err, errBatchFenceLost):
		return batchLost, nil
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil:
		return batchStop, err
	}
	failure, stops := batchFailureOf(index, a.errorResponse(r, err), itemErrors)
	return a.failedBatchItem(r.Context(), store, jobID, failure, stops)
}

// failedBatchItem guarda el resultado de un elemento que falló y avanza el cursor, en su transacción; si detiene el lote,
// también el final (${aborted}, D4).
func (a *api) failedBatchItem(ctx context.Context, store domain.BatchJobStore, jobID uuid.UUID, item BatchItem, stops bool) (batchStep, error) {
	err := a.useCases.InTransaction(ctx, func(ctx context.Context) error {
		if err := keepBatchItem(ctx, store, jobID, item); err != nil {
			return err
		}
		if stops {
			_, err := store.Finish(ctx, jobID, domain.BatchJobAborted)
			return err
		}
		return nil
	})
	switch {
	case errors.Is(err, errBatchFenceLost):
		return batchLost, nil
	case err != nil:
		return batchStop, err
	case stops:
		return batchStop, nil
	}
	return batchNext, nil
}
`
    : `
// errBatchFenceLost es el cursor que ya no está donde lo dejó quien procesa: la repetición de la petición se llevó el trabajo.
// Revierte el lote entero.
var errBatchFenceLost = errors.New("el trabajo lo procesa otro")
`;
  return `
// readBatchBody lee los BYTES del cuerpo tal como llegaron (su firma es la de la petición, D13) y los vuelve a poner en un
// clon de la petición, para el lector de la operación.
func readBatchBody(r *http.Request) ([]byte, *http.Request, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, nil, err
		}
		return nil, nil, malformed(err)
	}
	envelope := r.Clone(r.Context())
	envelope.Body = io.NopCloser(bytes.NewReader(body))
	return body, envelope, nil
}

// batchSignature es la firma de la petición (D13): el sha256 de los bytes del cuerpo, como batchRequestSignature de keel-core.
func batchSignature(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

// batchItemOf es un resultado guardado, como viaja en el cable.
func batchItemOf(row domain.BatchJobResult) BatchItem {
	item := BatchItem{Index: row.Index, Status: row.Status, Error: row.ErrorCode, Message: row.Message}
	if row.Result != nil {
		item.Result = jsontext.Value(*row.Result)
	}
	return item
}
${stepsCode}
// keepBatchItem es la valla y el resultado de un elemento, en la transacción en curso: primero el avance del cursor, que
// toma la fila del trabajo, y después el resultado (con el resultado primero, un elemento que ya escribió otro chocaría en la
// clave primaria antes de llegar a la valla). Si el cursor ya no estaba en su índice, la transacción revierte entera.
func keepBatchItem(ctx context.Context, store domain.BatchJobStore, jobID uuid.UUID, item BatchItem) error {
	advanced, err := store.Advance(ctx, jobID, item.Index, item.Status == "succeeded")
	if err != nil {
		return err
	}
	if !advanced {
		return errBatchFenceLost
	}
	result := domain.BatchJobResult{Index: item.Index, Status: item.Status, ErrorCode: item.Error, Message: item.Message}
	if item.Result != nil {
		data, err := wire.Marshal(item.Result)
		if err != nil {
			return err
		}
		text := string(data)
		result.Result = &text
	}
	return store.InsertResult(ctx, jobID, result)
}
`;
}

/** El alta, las dos rutas y el procesador de los lotes asíncronos. */
function asyncHttpBody(model) {
  const { aborted } = BATCH_JOB_STATUSES;
  const security = usesHttpSecurity(model);
  const view = alignRows([
    { indent: '\t', cells: ['ID', 'uuid.UUID', '`json:"id"`'] },
    { indent: '\t', cells: ['Status', 'string', '`json:"status"`'] },
    { indent: '\t', cells: ['Summary', 'BatchSummary', '`json:"summary"`'] },
    { indent: '\t', cells: ['CreatedAt', 'time.Time', '`json:"createdAt"`'] },
    { indent: '\t', cells: ['FinishedAt', '*time.Time', '`json:"finishedAt"`'] }
  ]);
  const spec = alignRows([
    { indent: '\t', cells: ['operation', 'string'] },
    { text: '\t// kind es el del temporizador de UNA vez de cada trabajo (batch:<operación>).' },
    { indent: '\t', cells: ['kind', 'string'] },
    { text: '\t// keySource es de dónde sale la clave del lote (client-key o payload-hash), o "" sin idempotency.' },
    { indent: '\t', cells: ['keySource', 'string'] },
    { text: '\t// ttlSeconds es cuánto vale la clave; 0, sin ventana.' },
    { indent: '\t', cells: ['ttlSeconds', 'int'] },
    { text: '\t// statusPath es la ruta del trabajo, con su parámetro: la de Location.' },
    { indent: '\t', cells: ['statusPath', 'string'] },
    { text: '\t// reused es el error de la misma clave con otro contenido (D13).' },
    { indent: '\t', cells: ['reused', '*domain.Error'] }
  ]);
  const owner = security
    ? `// asBatchJobOwner es el contexto del dueño del trabajo: un principal de token cuyo sujeto es él, que es el actor de
// autoría de cada elemento. El trabajo se procesa sin token.
func asBatchJobOwner(ctx context.Context, owner string) context.Context {
	subject, err := jsontext.AppendQuote(nil, owner)
	if err != nil {
		subject = []byte(\`""\`)
	}
	return security.WithPrincipal(ctx, &security.Principal{Kind: security.TokenPrincipal, Name: owner, Claims: map[string]jsontext.Value{"sub": jsontext.Value(subject)}})
}`
    : `// asBatchJobOwner es el contexto del dueño del trabajo. Sin capa de seguridad no hay principal que poner.
func asBatchJobOwner(ctx context.Context, _ string) context.Context {
	return ctx
}`;
  const runners = asyncOperations(model).map((operation) => runnerBody(model, operation));
  return `
// BatchJobView es el trabajo de un lote asíncrono en el cable: su estado y su resumen. notAttempted solo cuenta en un
// trabajo ${aborted}: lo que queda por procesar de uno en marcha no se ha intentado todavía, pero tampoco se ha descartado
// (batchJobView de keel-core). Sus claves salen siempre, null donde no aplica.
type BatchJobView struct {
${view.join('\n')}
}

// batchJobView es el trabajo en el cable desde su fila.
func batchJobView(job domain.BatchJob) BatchJobView {
	notAttempted := 0
	if job.Status == domain.BatchJobAborted {
		notAttempted = job.Total - job.NextIndex
	}
	summary := BatchSummary{Total: job.Total, Succeeded: job.Succeeded, Failed: job.Failed, NotAttempted: notAttempted}
	return BatchJobView{ID: job.ID, Status: job.Status, Summary: summary, CreatedAt: job.CreatedAt, FinishedAt: job.FinishedAt}
}

// batchJobSpec es lo que el alta y las rutas saben de una operación asíncrona.
type batchJobSpec struct {
${spec.join('\n')}
}

// submitBatchJob es el alta de un trabajo (D8): no procesa nada. Lee los BYTES del cuerpo, los vuelve a leer con el lector
// de la operación (read, que da cuántos elementos trae: un sobre mal formado es un 400 sin trabajo, BJ-9), resuelve la
// clave del lote (D13) y crea el trabajo y su temporizador de una vez en UNA transacción. Responde ${BATCH_ACCEPTED_STATUS} con el trabajo y
// su URL en Location.
func (a *api) submitBatchJob(w http.ResponseWriter, r *http.Request, spec batchJobSpec, read func(*http.Request) (int, error)) error {
	body, envelope, err := readBatchBody(r)
	if err != nil {
		return err
	}
	total, err := read(envelope)
	if err != nil {
		return err
	}
	job := domain.NewBatchJob{Operation: spec.operation, Kind: spec.kind, Signature: batchSignature(body), Input: string(body), Total: total}
	switch spec.keySource {
	case "payload-hash":
		job.Key = &job.Signature
	case "client-key":
		if key := strings.TrimSpace(r.Header.Get(${goString(IDEMPOTENCY_HEADER)})); key != "" {
			job.Key = &key
		}
	}
	if job.Key != nil && spec.ttlSeconds > 0 {
		ttl := time.Duration(spec.ttlSeconds) * time.Second
		job.KeyTTL = &ttl
	}
	id, err := a.acceptBatchJob(r.Context(), spec, job)
	if err != nil {
		return err
	}
	created, found, err := a.useCases.${BATCH_JOBS.field}().Job(r.Context(), id)
	if err != nil {
		return err
	}
	if !found {
		return batchJobNotFound(id)
	}
	w.Header().Set("Location", location(r, spec.statusPath, id.String()))
	return writeJSON(w, http.StatusAccepted, batchJobView(created))
}

// acceptBatchJob crea el trabajo y su temporizador en UNA transacción, o devuelve el vivo de la misma clave. Dos altas con
// la misma clave a la vez: la que pierde choca con la unicidad del motor y responde el trabajo de la ganadora, sin el 409
// «en curso» (D13).
func (a *api) acceptBatchJob(ctx context.Context, spec batchJobSpec, job domain.NewBatchJob) (uuid.UUID, error) {
	store := a.useCases.${BATCH_JOBS.field}()
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	job.ID = id
	err = a.useCases.InTransaction(ctx, func(ctx context.Context) error {
		if job.Key != nil {
			if err := store.ReleaseKey(ctx, spec.operation, *job.Key); err != nil {
				return err
			}
			same, found, err := repeatBatchJob(ctx, store, spec, job)
			if err != nil || found {
				id = same
				return err
			}
		}
		return store.Insert(ctx, job)
	})
	if err == nil || job.Key == nil || errors.Is(err, spec.reused) || errors.Is(err, context.Canceled) {
		return id, err
	}
	var winner uuid.UUID
	found := false
	retry := a.useCases.InTransaction(ctx, func(ctx context.Context) error {
		var err error
		winner, found, err = repeatBatchJob(ctx, store, spec, job)
		return err
	})
	if retry != nil {
		return uuid.Nil, retry
	}
	if !found {
		return uuid.Nil, err
	}
	return winner, nil
}

// repeatBatchJob es el trabajo vivo de la clave (D13): el mismo si la firma casa, la clave reutilizada si no.
func repeatBatchJob(ctx context.Context, store domain.BatchJobStore, spec batchJobSpec, job domain.NewBatchJob) (uuid.UUID, bool, error) {
	hit, found, err := store.ByKey(ctx, spec.operation, *job.Key)
	if err != nil || !found {
		return uuid.Nil, false, err
	}
	if hit.Signature != job.Signature {
		return uuid.Nil, false, domain.Errorf(spec.reused, "La clave de idempotencia %s/%s ya se usó con un contenido distinto", spec.operation, *job.Key)
	}
	return hit.ID, true, nil
}

// batchJobStatus atiende la ruta del trabajo: su estado y su resumen, si es de quien llama.
func (a *api) batchJobStatus(w http.ResponseWriter, r *http.Request, operation string) error {
	job, err := a.ownedBatchJob(r, operation)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, batchJobView(job))
}

// batchJobResults atiende la ruta de los resultados: los de los elementos intentados, en orden de índice, con el sobre de
// página del cable. Los notAttempted de un trabajo ${aborted} no se escriben fila a fila: los cuenta su resumen.
func (a *api) batchJobResults(w http.ResponseWriter, r *http.Request, operation string, defaultSize, maxSize int32) error {
	job, err := a.ownedBatchJob(r, operation)
	if err != nil {
		return err
	}
	// Los resultados no ofrecen orden (DSL 2.32, U3): todo ?sort= es 400.
	pageable, err := pageableParam(r, defaultSize, maxSize, nil, nil)
	if err != nil {
		return err
	}
	page, err := a.useCases.${BATCH_JOBS.field}().Results(r.Context(), job.ID, pageable)
	if err != nil {
		return err
	}
	items := make([]BatchItem, len(page.Items))
	for i, row := range page.Items {
		items[i] = batchItemOf(row)
	}
	return writeJSON(w, http.StatusOK, application.PagedResponse[BatchItem]{Items: items, Page: page.Number, Size: page.Size, TotalElements: page.TotalElements, TotalPages: page.TotalPages})
}

// ownedBatchJob es el trabajo de la ruta si es de quien llama (D11): lo ajeno, lo purgado y lo inexistente responden igual.
func (a *api) ownedBatchJob(r *http.Request, operation string) (domain.BatchJob, error) {
	id, err := uuid.Parse(r.PathValue(${goString(BATCH_JOB_PARAM)}))
	if err != nil {
		return domain.BatchJob{}, malformed(err)
	}
	job, found, err := a.useCases.${BATCH_JOBS.field}().Owned(r.Context(), id, operation)
	if err == nil && !found {
		err = batchJobNotFound(id)
	}
	return job, err
}

// batchJobNotFound es el trabajo que no hay, o que no es de quien llama (docs/framework-errors.md).
func batchJobNotFound(id uuid.UUID) error {
	return domain.Errorf(domain.${sentinel(FRAMEWORK_ERRORS.batchJobNotFound.code)}, "No hay ningún trabajo %s", id)
}

// BatchJobRunner es el procesador de los trabajos de los lotes asíncronos (DSL 2.30, D9): un disparo del temporizador de un
// trabajo procesa un CHUNK desde el cursor y dice si queda trabajo (rearmar para ya) o si terminó (borrar el
// temporizador). Es el commit interval y el restart de Spring Batch sobre el cronómetro, sin la librería.
//
// Cada elemento lo procesa processBatchItem: su efecto, el avance del cursor (la valla) y su resultado en UNA transacción.
// Si la réplica cae a mitad de chunk, lo confirmado queda y el siguiente disparo sigue desde el cursor: ningún elemento se
// aplica dos veces ni se queda sin resultado. Corre sin token: el actor de autoría de cada elemento es el dueño del trabajo.
type BatchJobRunner struct {
	api       *api
	chunkSize int
}

// NewBatchJobRunner construye el procesador con los casos de uso a los que despacha y el chunk del perfil (batch.yaml).
func NewBatchJobRunner(useCases *application.UseCases, logger *slog.Logger, chunkSize int) *BatchJobRunner {
	return &BatchJobRunner{api: &api{useCases: useCases, logger: logger}, chunkSize: chunkSize}
}
${runners.join('')}
// runBatchChunk es un disparo: lee el trabajo, vuelve a leer su sobre con el lector de la operación y procesa hasta
// chunkSize elementos desde el cursor. Devuelve true si queda trabajo; un error cuenta como un fallo del temporizador, que
// se reintenta desde el cursor.
func runBatchChunk[T, M any](ctx context.Context, b *BatchJobRunner, jobID uuid.UUID, read func(*http.Request) (M, []jsontext.Value, error), itemErrors []string, process func(context.Context, M, T) (any, error)) (bool, error) {
	store := b.api.useCases.${BATCH_JOBS.field}()
	job, found, err := store.Job(ctx, jobID)
	if err != nil || !found || job.FinishedAt != nil {
		return false, err
	}
	ctx = asBatchJobOwner(ctx, job.Owner)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "/", strings.NewReader(job.Input))
	if err != nil {
		return false, err
	}
	msg, items, err := read(request)
	if err != nil {
		return false, fmt.Errorf("el sobre guardado del trabajo %s no se lee: %w", job.ID, err)
	}
	if len(items) != job.Total {
		return false, fmt.Errorf("el sobre guardado del trabajo %s trae %d elementos y el trabajo %d", job.ID, len(items), job.Total)
	}
	index := job.NextIndex
	end := min(job.Total, index+b.chunkSize)
	for ; index < end; index++ {
		// Parar (el lote se detuvo) o perder la valla (el trabajo es de otra réplica) acaban el disparo.
		step, err := processBatchItem(request, b.api, store, job.ID, index, items[index], msg, itemErrors, process)
		if err != nil || step != batchNext {
			return false, err
		}
	}
	if index >= job.Total {
		_, err := store.Finish(ctx, job.ID, domain.BatchJobCompleted)
		return false, err
	}
	return true, nil
}

${owner}
`;
}

/** Los lotes síncronos con clave (D15): el trabajo de la petición, la repetición y el bucle sobre lo guardado. */
function keyedHttpBody(model) {
  const operations = keyedOperations(model);
  const perItem = operations.some((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.some((operation) => operation.batch.atomicity === 'all-or-nothing');
  const spec = alignRows([
    { indent: '\t', cells: ['operation', 'string'] },
    { text: '\t// keySource es de dónde sale la clave del lote: client-key o payload-hash.' },
    { indent: '\t', cells: ['keySource', 'string'] },
    { text: '\t// ttlSeconds es cuánto vale la clave; 0, sin ventana.' },
    { indent: '\t', cells: ['ttlSeconds', 'int'] },
    { text: '\t// reused es el error de la misma clave con otro contenido.' },
    { indent: '\t', cells: ['reused', '*domain.Error'] },
    { text: '\t// inProgress es el error de la misma clave mientras la primera petición sigue en marcha.' },
    { indent: '\t', cells: ['inProgress', '*domain.Error'] }
  ]);
  const started = alignRows([
    { indent: '\t', cells: ['id', 'uuid.UUID'] },
    { indent: '\t', cells: ['from', 'int'] },
    { indent: '\t', cells: ['replay', 'bool'] }
  ]);
  const perItemCode = perItem
    ? `
// runKeyedPerItem es un lote per-item con clave: como runPerItem, con cada elemento confirmado junto a su resultado y el
// avance del cursor, y la respuesta rehecha de lo guardado. Sin clave, el lote de siempre.
func runKeyedPerItem[T, M any](a *api, r *http.Request, spec keyedBatchSpec, body []byte, msg M, items []jsontext.Value, itemErrors []string, process func(context.Context, M, T) (any, error)) (BatchResponse, error) {
	each := func(ctx context.Context, item T) (any, error) {
		return process(ctx, msg, item)
	}
	signature := batchSignature(body)
	key := keyedBatchKey(r, spec, signature)
	if key == "" {
		// Sin la cabecera de la clave: el lote de siempre, sin trabajo.
		return runPerItem(a, r, items, itemErrors, each)
	}
	started, err := a.startKeyedBatch(r.Context(), spec, key, signature, body, len(items))
	if err != nil {
		return BatchResponse{}, err
	}
	store := a.useCases.${BATCH_JOBS.field}()
	if started.replay {
		// La repetición de un lote terminado: lo guardado, sin procesar nada.
		return storedBatchResponse(r.Context(), store, started.id)
	}
	for index := started.from; index < len(items); index++ {
		step, err := processBatchItem(r, a, store, started.id, index, items[index], msg, itemErrors, process)
		if err != nil {
			return BatchResponse{}, err
		}
		if step == batchLost {
			// Otra petición con la misma clave tomó el trabajo (D15): lo termina ella.
			return BatchResponse{}, keyedBatchInProgress(spec, key)
		}
		if step == batchStop {
			return storedBatchResponse(r.Context(), store, started.id)
		}
	}
	err = a.useCases.InTransaction(r.Context(), func(ctx context.Context) error {
		_, err := store.Finish(ctx, started.id, domain.BatchJobCompleted)
		return err
	})
	if err != nil {
		return BatchResponse{}, err
	}
	return storedBatchResponse(r.Context(), store, started.id)
}
`
    : '';
  const atomicCode = atomic
    ? `
// runKeyedAllOrNothing es un lote all-or-nothing con clave: como runAllOrNothing, con los resultados, el cursor y el final
// del trabajo en la transacción del lote. Si no se confirma no queda nada, y su trabajo se descarta en otra: la repetición
// lo vuelve a procesar en vez de devolver un lote que nunca se confirmó.
func runKeyedAllOrNothing[T, M any](a *api, r *http.Request, spec keyedBatchSpec, over string, body []byte, msg M, items []jsontext.Value, process func(context.Context, M, T) (any, error)) (*BatchResponse, *ErrorResponse, error) {
	each := func(ctx context.Context, item T) (any, error) {
		return process(ctx, msg, item)
	}
	signature := batchSignature(body)
	key := keyedBatchKey(r, spec, signature)
	if key == "" {
		// Sin la cabecera de la clave: el lote de siempre, sin trabajo.
		return runAllOrNothing(a, r, over, items, a.useCases.InTransaction, each, nil)
	}
	started, err := a.startKeyedBatch(r.Context(), spec, key, signature, body, len(items))
	if err != nil {
		return nil, nil, err
	}
	store := a.useCases.${BATCH_JOBS.field}()
	if started.replay {
		// La repetición de un todo o nada confirmado: la respuesta guardada, sin procesar nada.
		stored, err := storedBatchResponse(r.Context(), store, started.id)
		return &stored, nil, err
	}
	id := started.id
	sink := &batchSink{
		kept: func(ctx context.Context, item BatchItem) error {
			return keepBatchItem(ctx, store, id, item)
		},
		completed: func(ctx context.Context) error {
			_, err := store.Finish(ctx, id, domain.BatchJobCompleted)
			return err
		},
	}
	_, failed, err := runAllOrNothing(a, r, over, items, a.useCases.InTransaction, each, sink)
	if errors.Is(err, errBatchFenceLost) {
		// Otra petición con la misma clave tomó el trabajo (D15): lo termina ella.
		return nil, nil, keyedBatchInProgress(spec, key)
	}
	if err != nil || failed != nil {
		// No quedó confirmado (un elemento falló, o el commit): su trabajo se descarta.
		if discard := a.discardKeyedBatch(r.Context(), id); discard != nil {
			return nil, nil, errors.Join(err, discard)
		}
		return nil, failed, err
	}
	stored, err := storedBatchResponse(r.Context(), store, id)
	return &stored, nil, err
}

// discardKeyedBatch borra el trabajo de un todo o nada con clave que no se confirmó, en su transacción y sin la cancelación
// de la petición: libera la clave.
func (a *api) discardKeyedBatch(ctx context.Context, id uuid.UUID) error {
	return a.useCases.InTransaction(context.WithoutCancel(ctx), func(ctx context.Context) error {
		_, err := a.useCases.${BATCH_JOBS.field}().Discard(ctx, id)
		return err
	})
}
`
    : '';
  return `
// keyedBatchSpec es lo que un lote síncrono con clave sabe de su operación (D15).
type keyedBatchSpec struct {
${spec.join('\n')}
}

// keyedBatchStart es el trabajo de la petición: su id, desde qué elemento sigue y si ya terminó (la repetición responde lo
// guardado).
type keyedBatchStart struct {
${started.join('\n')}
}

// keyedBatchKey es la clave del lote: la cabecera, o la firma del cuerpo si la clave es el contenido. "" sin clave.
func keyedBatchKey(r *http.Request, spec keyedBatchSpec, signature string) string {
	if spec.keySource == "payload-hash" {
		return signature
	}
	return strings.TrimSpace(r.Header.Get(${goString(IDEMPOTENCY_HEADER)}))
}

// keyedBatchInProgress es la repetición de un lote con clave mientras el primero sigue en marcha (D15): todavía no hay
// respuesta que devolver, y procesarlo a la vez lo repartiría entre dos peticiones.
func keyedBatchInProgress(spec keyedBatchSpec, key string) error {
	return domain.Errorf(spec.inProgress, "Otra petición con la clave de idempotencia %s/%s está procesando el lote", spec.operation, key)
}

// startKeyedBatch es el trabajo de la petición, en una transacción propia: el de la clave, si lo hay, o uno nuevo, sin
// temporizador. Dos peticiones con la misma clave a la vez: la que pierde choca con la unicidad del motor y encuentra el
// trabajo de la ganadora, en marcha.
func (a *api) startKeyedBatch(ctx context.Context, spec keyedBatchSpec, key, signature string, body []byte, total int) (keyedBatchStart, error) {
	store := a.useCases.${BATCH_JOBS.field}()
	id, err := uuid.NewV7()
	if err != nil {
		return keyedBatchStart{}, err
	}
	job := domain.NewBatchJob{ID: id, Operation: spec.operation, Key: &key, Signature: signature, Input: string(body), Total: total}
	if spec.ttlSeconds > 0 {
		ttl := time.Duration(spec.ttlSeconds) * time.Second
		job.KeyTTL = &ttl
	}
	var started keyedBatchStart
	err = a.useCases.InTransaction(ctx, func(ctx context.Context) error {
		if err := store.ReleaseKey(ctx, spec.operation, key); err != nil {
			return err
		}
		found, ok, err := repeatKeyedBatch(ctx, store, spec, key, signature)
		if err != nil || ok {
			started = found
			return err
		}
		started = keyedBatchStart{id: id}
		return store.Insert(ctx, job)
	})
	if err == nil || errors.Is(err, spec.reused) || errors.Is(err, spec.inProgress) || errors.Is(err, context.Canceled) {
		return started, err
	}
	var winner keyedBatchStart
	found := false
	retry := a.useCases.InTransaction(ctx, func(ctx context.Context) error {
		var err error
		winner, found, err = repeatKeyedBatch(ctx, store, spec, key, signature)
		return err
	})
	if retry != nil {
		return keyedBatchStart{}, retry
	}
	if !found {
		return keyedBatchStart{}, err
	}
	return winner, nil
}

// repeatKeyedBatch es el trabajo vivo de la clave (D15, batchSyncRepeat de keel-core): terminado, la respuesta guardada; con
// otra firma, la clave reutilizada; sin terminar y escrito hace poco, la clave en curso; sin terminar y más viejo, quien lo
// procesaba murió: lo toma y sigue desde el cursor.
func repeatKeyedBatch(ctx context.Context, store domain.BatchJobStore, spec keyedBatchSpec, key, signature string) (keyedBatchStart, bool, error) {
	hit, found, err := store.ByKey(ctx, spec.operation, key)
	if err != nil || !found {
		return keyedBatchStart{}, false, err
	}
	if hit.Signature != signature {
		return keyedBatchStart{}, false, domain.Errorf(spec.reused, "La clave de idempotencia %s/%s ya se usó con un contenido distinto", spec.operation, key)
	}
	job, found, err := store.Job(ctx, hit.ID)
	if err != nil || !found {
		return keyedBatchStart{}, false, err
	}
	if job.FinishedAt != nil {
		return keyedBatchStart{id: job.ID, from: job.Total, replay: true}, true, nil
	}
	taken, err := store.TakeOver(ctx, job.ID)
	if err != nil {
		return keyedBatchStart{}, false, err
	}
	if !taken {
		return keyedBatchStart{}, false, keyedBatchInProgress(spec, key)
	}
	return keyedBatchStart{id: job.ID, from: job.NextIndex}, true, nil
}

// storedBatchResponse es la respuesta de un lote con clave rehecha desde lo guardado (D15, batchStoredBody de keel-core):
// los resultados en orden de índice y, si se detuvo, un notAttempted por cada elemento desde el cursor.
func storedBatchResponse(ctx context.Context, store domain.BatchJobStore, jobID uuid.UUID) (BatchResponse, error) {
	job, found, err := store.Job(ctx, jobID)
	if err != nil {
		return BatchResponse{}, err
	}
	if !found {
		return BatchResponse{}, fmt.Errorf("el trabajo %s no existe", jobID)
	}
	page, err := store.Results(ctx, jobID, domain.Pageable{Size: int32(job.Total)})
	if err != nil {
		return BatchResponse{}, err
	}
	items := make([]BatchItem, 0, job.Total)
	for _, row := range page.Items {
		items = append(items, batchItemOf(row))
	}
	if job.Status == domain.BatchJobAborted {
		for index := job.NextIndex; index < job.Total; index++ {
			items = append(items, BatchItem{Index: index, Status: "notAttempted"})
		}
	}
	return newBatchResponse(items), nil
}
${perItemCode}${atomicCode}`;
}

/** La literal de keyedBatchSpec de una operación síncrona con clave (la escribe su endpoint, en endpoints.js). */
export function keyedBatchSpecLiteral(model, operation) {
  const idempotency = operation.batch.idempotency;
  const fields = [
    `operation: ${goString(operation.name)}`,
    `keySource: ${goString(idempotency.keySource)}`,
    ...(idempotency.ttlSeconds ? [`ttlSeconds: ${idempotency.ttlSeconds}`] : []),
    `reused: domain.${sentinel(reusedCode(model, operation))}`,
    `inProgress: domain.${sentinel(inProgressCode(model, operation))}`
  ];
  return `keyedBatchSpec{${fields.join(', ')}}`;
}

/** El disparo de los trabajos de una operación: el lector, los itemErrors y el despacho de UN elemento. */
function runnerBody(model, operation) {
  const batch = operation.batch;
  const message = messageType(operation);
  const itemErrors = batch.itemErrors.length > 0 ? `[]string{${batch.itemErrors.map(goString).join(', ')}}` : 'nil';
  const call = `b.api.useCases.${useCaseField(operation)}.Handle(ctx, msg)`;
  const returning = operation.messageKind !== 'command';
  return `
// ${runnerMethod(operation)} es un disparo del temporizador de un trabajo de ${operation.name}: true si queda trabajo. Lo llama
// timer.NewBatchJob con el id del trabajo.
func (b *BatchJobRunner) ${runnerMethod(operation)}(ctx context.Context, jobID uuid.UUID) (bool, error) {
	return runBatchChunk(ctx, b, jobID, ${readerOf(operation)}, ${itemErrors}, func(ctx context.Context, msg application.${message}, item domain.${batch.itemType}) (any, error) {
		msg.Item = item
		return ${returning ? call : `nil, ${call}`}
	})
}
`;
}

const readerOf = (operation) => `read${goExported(operation.name)}`;

/**
 * Los tres endpoints de una operación asíncrona (métodos de `api`): el alta y las dos rutas del trabajo. Los emite
 * endpoints.js en el archivo de su grupo.
 */
export function batchJobEndpoints(model, operation, plan) {
  const batch = operation.batch;
  const paths = batchJobPaths(operation.route.path);
  const base = model.api.routeBase;
  const idempotency = batch.idempotency;
  const pagination = model.pagination ?? {};
  plan.uses.add('location');
  plan.uses.add('pageableParam');
  plan.uses.add('malformed');
  const spec = [
    `operation: ${goString(operation.name)}`,
    `kind: ${goString(batchKind(operation.name))}`,
    ...(idempotency ? [`keySource: ${goString(idempotency.keySource)}`] : []),
    ...(idempotency?.ttlSeconds ? [`ttlSeconds: ${idempotency.ttlSeconds}`] : []),
    `statusPath: ${goString(`${base}${paths.status}`)}`,
    `reused: domain.${sentinel(reusedCode(model, operation))}`
  ];
  const op = goString(operation.name);
  return `// ${goUnexported(operation.name)} atiende ${operation.route.method} ${base}${operation.route.path} (${operation.name}), un lote asíncrono: ${BATCH_ACCEPTED_STATUS} con
// el trabajo, sin procesar nada en la petición. Lo procesa el cronómetro por partes (BatchJobRunner).
func (a *api) ${goUnexported(operation.name)}(w http.ResponseWriter, r *http.Request) error {
	return a.submitBatchJob(w, r, batchJobSpec{${spec.join(', ')}}, func(r *http.Request) (int, error) {
		_, items, err := ${readerOf(operation)}(r)
		return len(items), err
	})
}

// ${jobEndpoint(operation)} atiende GET ${base}${paths.status} (${operation.name}): el trabajo, su estado y su resumen. Solo lo lee
// quien lo creó.
func (a *api) ${jobEndpoint(operation)}(w http.ResponseWriter, r *http.Request) error {
	return a.batchJobStatus(w, r, ${op})
}

// ${jobResultsEndpoint(operation)} atiende GET ${base}${paths.results} (${operation.name}): los resultados de los elementos
// intentados, en orden de índice.
func (a *api) ${jobResultsEndpoint(operation)}(w http.ResponseWriter, r *http.Request) error {
	return a.batchJobResults(w, r, ${op}, ${pagination.defaultSize ?? PAGEABLE_DEFAULT_SIZE}, ${pagination.maxSize ?? PAGEABLE_MAX_SIZE})
}`;
}

/** Las dos filas de la tabla de rutas del trabajo de una operación asíncrona, como las de routeRow. */
export function batchJobRouteRows(model, operation) {
  const paths = batchJobPaths(operation.route.path);
  return [
    { operation: `${operation.name}Job`, method: 'GET', path: `${model.api.routeBase}${paths.status}`, status: 200, location: false, query: [], body: null, handle: jobEndpoint(operation) },
    { operation: `${operation.name}JobResults`, method: 'GET', path: `${model.api.routeBase}${paths.results}`, status: 200, location: false, query: ['page', 'size'], body: null, handle: jobResultsEndpoint(operation) }
  ];
}

// ─── El temporizador ─────────────────────────────────────────────────────────────────────────────

const TIMER_HANDLER_BODY = `
// BatchJob es el temporizador de UNA vez de los trabajos de un lote asíncrono (DSL 2.30, D9): cada trabajo arma el suyo al
// crearse, y cada disparo procesa un chunk. Si queda trabajo se rearma para ya; si no, se borra. El disparo lo hace el
// procesador de la API (httpapi.BatchJobRunner), que el cronómetro recibe como función: no ve la API.
//
// Corre FUERA de la transacción del sondeador (InTransaction): cada elemento abre la suya, con su efecto, el avance del
// cursor y su resultado, y el sondeador borra o rearma el temporizador después, con la valla. Un fallo cuenta y aparca como
// el de un plazo, y el siguiente disparo sigue desde el cursor.
type BatchJob struct {
	kind string
	run  func(ctx context.Context, jobID uuid.UUID) (bool, error)
}

// NewBatchJob es el temporizador de los trabajos de un kind (batch:<operación>), con el disparo del procesador.
func NewBatchJob(kind string, run func(ctx context.Context, jobID uuid.UUID) (bool, error)) *BatchJob {
	return &BatchJob{kind: kind, run: run}
}

// Kind implementa Handler.
func (b *BatchJob) Kind() string {
	return b.kind
}

// InTransaction dice que el sondeador no lo envuelve en su transacción: un chunk no cabe en una sola (D14).
func (b *BatchJob) InTransaction() bool {
	return false
}

// Handle implementa Handler: un chunk del trabajo cuyo id es el entity_id del temporizador.
func (b *BatchJob) Handle(ctx context.Context, claimed Claimed, dbNow time.Time) (Outcome, error) {
	more, err := b.run(ctx, claimed.EntityID)
	if err != nil {
		return Outcome{}, err
	}
	if more {
		return RescheduleAt(dbNow), nil
	}
	return Finished(), nil
}
`;
