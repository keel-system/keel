// Los LOTES ASÍNCRONOS (DSL 2.30, fase B) contra lo emitido, para db-check y doc-check: BJ-1 a BJ-10 de
// keel-core/gen/batch.js, con los ids que ejecutan keel-spring (batch-check), keel-nest y keel-dotnet (su
// scripts/lib/batch-job-probes.js) sobre los MISMOS diseños (BATCH_JOB_DESIGNS de keel-core/test/helpers/batch-designs.js).
// El handler de la sonda es el de batch-probes.js (batchProbePatch), con su gancho `ProbeAfterEffect`.
//
// `batch_job_probe_test.go`, en el paquete del almacén: una prueba por caso con el id en el nombre (`TestBatchJob_BJ4_…`).
// Comparte la base con el resto de sondas, así que NO vacía nada; cada caso usa sus propios sku (`J<letra><letra>-000n`) y sus
// propios trabajos. El alta y las dos rutas entran por el `http.Handler` ENTERO de httpapi.NewHandler —el borde, la seguridad
// con un JWKS de la prueba (securitytest), la tabla de rutas y writeError—, con un token cuyo sujeto es el dueño (lo que lee el
// actor de autoría). El temporizador de cada trabajo se dispara llamando al procesador emitido (httpapi.NewBatchJobRunner),
// así que la sonda decide cuándo corre cada chunk, con el chunk a 2. La caída de una réplica a mitad de chunk (BJ-4) es un
// almacén que lanza al escribir el resultado de un elemento (envuelve el emitido en las Dependencies); la réplica que le quita
// el trabajo (BJ-5) es el gancho del handler, que mueve el cursor FUERA de la transacción del elemento, tras el efecto.

import { BATCH_JOB_CASES, BATCH_JOB_SABOTAGES, BATCH_KEY_RACE_ROUNDS, batchJobPaths } from '@keel-system/keel-core/gen/batch';
import { BATCH_JOB, BATCH_ITEM_RESULT } from '@keel-system/keel-core/gen/batch-store';
import { KEEL_TIMER, KEEL_TIMER_DOCUMENT } from '@keel-system/keel-core/gen/timer-store';
import { goFile, goString } from '../../src/lib/go-source.js';
import { sqlDialect, storeDir } from '../../src/lib/relational-engine.js';
import { repositoryArgs, repositoryParam } from '../../src/scaffold/repositories.js';
import { fullAccessLiteral } from '../../src/scaffold/security.js';
import { goExported } from '../../src/lib/go-projection.js';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';
import { UNDECLARED_FAILURE_NAME, allBatchOperations } from './batch-probes.js';

/** El tamaño del chunk con el que corre la sonda: pequeño, para que un trabajo de cinco elementos dé tres disparos. */
export const PROBE_CHUNK_SIZE = 2;

/** Los sujetos por almacén: los de BATCH_JOB_DESIGNS. */
export const BATCH_JOB_SUBJECTS = { relational: ['catalog-batch-async'], document: ['catalog-batch-async-mongo'] };

/** La operación asíncrona del modelo, o undefined. */
export const asyncOperation = (model) => allBatchOperations(model).find((operation) => operation.batch.execution === 'async');

/** Los casos de un lote ASÍNCRONO que ejecuta este diseño: todos, si declara uno. */
export function batchJobCases(model) {
  return asyncOperation(model) ? BATCH_JOB_CASES.map((entry) => entry.id) : [];
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────

const JOBS = /^internal\/httpapi\/batch_jobs\.go$/;
const STORE = /^internal\/infrastructure\/\w+\/batch_jobs\.go$/;
const TRANSACTIONS = /^internal\/infrastructure\/\w+\/transactions\.go$/;
const both = (entry) => ({ relational: { ...entry, expect: /_BJ\d+_/ }, document: { ...entry, expect: /_BJ\d+_/ } });

/**
 * Los sabotajes, por almacén, con la forma de db-sabotages.js y doc-sabotages.js (`files`, `from`, `to`): rompen lo emitido
 * CONSERVANDO LA FORMA (sigue compilando). El veredicto exacto lo da `batchJobSabotageVerdict`.
 */
export const BATCH_JOB_SABOTAGE_SPECS = {
  // Cada disparo empieza en el principio de su chunk y no en el cursor: tras una caída a mitad de chunk vuelve sobre lo ya
  // confirmado.
  'bj-no-resume': both({ files: JOBS, from: '	index := job.NextIndex\n', to: '	index := job.NextIndex - job.NextIndex%b.chunkSize\n' }),
  // El efecto en su transacción, y el cursor con el resultado en otra, después.
  'bj-cursor-outside-tx': both({
    files: JOBS,
    from: `	err := a.useCases.InTransaction(r.Context(), func(ctx context.Context) error {
		result, err := process(ctx, msg, item)
		if err != nil {
			return err
		}
		return keepBatchItem(ctx, store, jobID, batchSucceeded(index, result))
	})
`,
    to: `	var result any
	err := a.useCases.InTransaction(r.Context(), func(ctx context.Context) error {
		var err error
		result, err = process(ctx, msg, item)
		return err
	})
	if err == nil {
		err = a.useCases.InTransaction(r.Context(), func(ctx context.Context) error {
			return keepBatchItem(ctx, store, jobID, batchSucceeded(index, result))
		})
	}
`
  }),
  // Las rutas del trabajo no miran el dueño.
  'bj-foreign-reader': {
    relational: {
      files: STORE,
      from: 'return s.job(ctx, batchSQLOwnedJob, map[string]any{"id": id, "operation": operation, "owner": batchJobOwner(ctx)})',
      to: 'return s.job(ctx, batchSQLJob, map[string]any{"id": id})',
      expect: /_BJ\d+_/
    },
    document: {
      files: STORE,
      from: '{Key: "operation", Value: operation}, {Key: "owner", Value: batchJobOwner(ctx)}})',
      to: '{Key: "operation", Value: operation}})',
      expect: /_BJ\d+_/
    }
  },
  // El alta que el motor mata por interbloqueo no se repite (solo cae en MySQL: en PostgreSQL la carrera llega por la
  // unicidad). En keel-go la repetición NO es del alta sino de la transacción (fresh/within en transactions.go): el sabotaje
  // la apaga ahí, así que caen también las dos sondas de la transacción (`alsoFalls`), y ninguna otra.
  'bj-no-race-retry': {
    relational: {
      files: TRANSACTIONS,
      from: 'if err == nil || options.ReadOnly || !transient(err) {',
      to: 'if err == nil || options.ReadOnly || !transient(err) || attempt > 0 {',
      expect: /_BJ\d+_/,
      alsoFalls: /^TestTransaction_/
    },
    document: { files: TRANSACTIONS, from: 'if err == nil || readOnly || !transient(err) {', to: 'if err == nil || readOnly || !transient(err) || attempt > 0 {', expect: /_BJ\d+_/, alsoFalls: /^TestTransaction_/ }
  }
};

export const isBatchJobSabotage = (id) => Boolean(id && BATCH_JOB_SABOTAGE_SPECS[id]);

/** Lo que tiene que caer con un sabotaje en UN sujeto: sus casos BJ, y solo esos. */
export function batchJobSabotageVerdict(failures, id) {
  const want = [...BATCH_JOB_SABOTAGES[id]].sort();
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_BJ(\d+)_/g)].map((match) => `BJ-${match[1]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── Lo que la sonda lee y retoca de las tablas ──────────────────────────────────────────────────

function storage(model) {
  const job = BATCH_JOB.table;
  const result = BATCH_ITEM_RESULT.table;
  if (model.persistenceKind === 'document') {
    const collection = (name) => `jobMust(probeTx.collection(${goString(name)}))`;
    return `func jobCount(t *testing.T) int64 {
	t.Helper()
	return jobMust(${collection(job)}.CountDocuments(t.Context(), bson.D{}))
}

func jobCountOf(t *testing.T, key string) int64 {
	t.Helper()
	return jobMust(${collection(job)}.CountDocuments(t.Context(), bson.D{{Key: "idempotency_key", Value: key}}))
}

func jobArmed(t *testing.T, id uuid.UUID) int64 {
	t.Helper()
	return jobMust(${collection(KEEL_TIMER_DOCUMENT.collection)}.CountDocuments(t.Context(), bson.D{{Key: "kind", Value: jobKind}, {Key: "entity_id", Value: id.String()}}))
}

func jobCursor(t *testing.T, id uuid.UUID) int {
	t.Helper()
	raw, err := ${collection(job)}.FindOne(t.Context(), bson.D{{Key: "_id", Value: id.String()}}).Raw()
	if err != nil {
		t.Fatalf("leer el trabajo %s: %v", id, err)
	}
	n, _ := raw.Lookup("next_index").AsInt64OK()
	return int(n)
}

func jobResultCount(t *testing.T, id uuid.UUID) int64 {
	t.Helper()
	return jobMust(${collection(result)}.CountDocuments(t.Context(), bson.D{{Key: "job_id", Value: id.String()}}))
}

func jobExists(t *testing.T, id uuid.UUID) bool {
	t.Helper()
	return jobMust(${collection(job)}.CountDocuments(t.Context(), bson.D{{Key: "_id", Value: id.String()}})) == 1
}

// jobBumpCursor es otra réplica que se lleva el elemento: mueve el cursor en SU escritura (aquí, sin sesión).
func jobBumpCursor(ctx context.Context, id uuid.UUID) error {
	jobs, err := probeTx.collection(${goString(job)})
	if err != nil {
		return err
	}
	_, err = jobs.UpdateOne(outside(ctx), bson.D{{Key: "_id", Value: id.String()}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "next_index", Value: int32(1)}}}})
	return err
}

func jobSetTime(t *testing.T, id uuid.UUID, field string, value time.Time) {
	t.Helper()
	if _, err := ${collection(job)}.UpdateOne(t.Context(), bson.D{{Key: "_id", Value: id.String()}}, bson.D{{Key: "$set", Value: bson.D{{Key: field, Value: bson.NewDateTimeFromTime(value)}}}}); err != nil {
		t.Fatal(err)
	}
}`;
  }
  const p = sqlDialect(model).param;
  return `func jobScalar(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := jobMust(probeTx.conn(t.Context())).QueryRowContext(t.Context(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func jobCount(t *testing.T) int64 {
	t.Helper()
	return jobScalar(t, ${goString(`SELECT count(*) FROM ${job}`)})
}

func jobCountOf(t *testing.T, key string) int64 {
	t.Helper()
	return jobScalar(t, ${goString(`SELECT count(*) FROM ${job} WHERE idempotency_key = ${p(1)}`)}, key)
}

func jobArmed(t *testing.T, id uuid.UUID) int64 {
	t.Helper()
	return jobScalar(t, ${goString(`SELECT count(*) FROM ${KEEL_TIMER.table} WHERE kind = ${p(1)} AND entity_id = ${p(2)}`)}, jobKind, id)
}

func jobCursor(t *testing.T, id uuid.UUID) int {
	t.Helper()
	return int(jobScalar(t, ${goString(`SELECT next_index FROM ${job} WHERE id = ${p(1)}`)}, id))
}

func jobResultCount(t *testing.T, id uuid.UUID) int64 {
	t.Helper()
	return jobScalar(t, ${goString(`SELECT count(*) FROM ${result} WHERE job_id = ${p(1)}`)}, id)
}

func jobExists(t *testing.T, id uuid.UUID) bool {
	t.Helper()
	return jobScalar(t, ${goString(`SELECT count(*) FROM ${job} WHERE id = ${p(1)}`)}, id) == 1
}

// jobBumpCursor es otra réplica que se lleva el elemento: mueve el cursor en SU transacción (aquí, otra conexión del pool,
// en autocommit).
func jobBumpCursor(ctx context.Context, id uuid.UUID) error {
	q, err := probeTx.conn(context.Background())
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, ${goString(`UPDATE ${job} SET next_index = next_index + 1 WHERE id = ${p(1)}`)}, id)
	return err
}

// jobSetTime retrasa a mano una hora del trabajo: la columna es una de las de la tabla, nunca un valor de fuera.
func jobSetTime(t *testing.T, id uuid.UUID, column string, value time.Time) {
	t.Helper()
	query := "UPDATE ${job} SET " + column + ${goString(` = ${p(1)} WHERE id = ${p(2)}`)}
	if _, err := jobMust(probeTx.conn(t.Context())).ExecContext(t.Context(), query, value.UTC(), id); err != nil {
		t.Fatal(err)
	}
}`;
}

// ─── Los casos ───────────────────────────────────────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => goString(JSON.stringify({ items }));
const skus = (prefix, count) => Array.from({ length: count }, (_, n) => draft(`${prefix}-000${n}`));

/** `batch_job_probe_test.go` en el paquete del almacén, o null si el diseño no tiene un lote asíncrono. */
export function batchJobProbeFile(model) {
  const operation = asyncOperation(model);
  if (!operation) return null;
  const product = model.entities.find((entity) => entity.name === 'Product');
  const path = `${model.api.routeBase}${operation.route.path}`;
  const paths = batchJobPaths(path);
  const location = `${path}/jobs/`;
  const maxItems = operation.batch.maxItems;
  const tests = [];
  const probe = (id, title, code) => {
    const name = title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join('');
    tests.push(`// TestBatchJob_${id.replace('-', '')}_${name}: ${id}, ${title}.
func TestBatchJob_${id.replace('-', '')}_${name}(t *testing.T) {
${code}
}`);
  };
  probe('BJ-1', 'el alta responde 202 sin procesar nada', `	status, json, where := jobPost(t, ${body(...skus('JAA', 2))}, "", "alice")
	if status != http.StatusAccepted {
		t.Fatalf("el alta responde 202: %d %v", status, json)
	}
	id := jobID(t, json)
	if !strings.HasSuffix(where, ${goString(location)}+id.String()) {
		t.Fatalf("Location del trabajo: %q", where)
	}
	if json["status"] != "queued" {
		t.Fatalf("el trabajo nace queued: %v", json)
	}
	jobSummary(t, json, 2, 0, 0, 0)
	if finished, ok := json["finishedAt"]; !ok || finished != nil {
		t.Fatalf("finishedAt sale, y null: %v", json)
	}
	if armed := jobArmed(t, id); armed != 1 {
		t.Fatalf("el trabajo arma su temporizador en la misma transacción: %d", armed)
	}
	jobAbsent(t, "JAA-0000")`);
  probe('BJ-2', 'por chunks hasta completed con los resultados paginados', `	id := jobSubmit(t, ${body(...skus('JBB', 5))})
	if !jobFire(t, id) {
		t.Fatal("el primer chunk deja trabajo")
	}
	if cursor := jobCursor(t, id); cursor != ${PROBE_CHUNK_SIZE} {
		t.Fatalf("el cursor tras el primer chunk: %d", cursor)
	}
	if !jobFire(t, id) {
		t.Fatal("el segundo también")
	}
	if jobFire(t, id) {
		t.Fatal("el tercero termina")
	}
	_, job, _ := jobGet(t, id, "alice")
	if job["status"] != "completed" || job["finishedAt"] == nil {
		t.Fatalf("el trabajo terminado: %v", job)
	}
	jobSummary(t, job, 5, 5, 0, 0)
	_, page, _ := jobResults(t, id, "?page=1&size=2", "alice")
	items := jobItems(t, page)
	if page["totalElements"] != float64(5) || len(items) != 2 || items[0]["index"] != float64(2) || items[1]["index"] != float64(3) {
		t.Fatalf("la segunda página de dos: %v", page)
	}
	if result, _ := items[0]["result"].(map[string]any); result == nil || result["productId"] == nil {
		t.Fatalf("el result del elemento: %v", items[0])
	}
	jobPresent(t, "JBB-0004")`);
  probe('BJ-3', 'un itemError falla solo su elemento y uno no declarado detiene el trabajo', `	jobRun(t, jobSubmit(t, ${body(draft('JCC-0009'))}))
	id := jobSubmit(t, ${body(draft('JCC-0001'), draft('JCC-0009'), draft('mal'), draft('JCC-0003'), draft('JCC-0004', UNDECLARED_FAILURE_NAME), draft('JCC-0005'))})
	jobRun(t, id)
	_, job, _ := jobGet(t, id, "alice")
	if job["status"] != "aborted" {
		t.Fatalf("el trabajo detenido: %v", job)
	}
	jobSummary(t, job, 6, 2, 3, 1)
	_, page, _ := jobResults(t, id, "?size=50", "alice")
	if page["totalElements"] != float64(5) {
		t.Fatalf("los resultados son los de los elementos intentados: %v", page)
	}
	jobResult(t, page, 1, "failed", "SKU_ALREADY_EXISTS")
	jobResult(t, page, 2, "failed", "VALIDATION_ERROR")
	jobResult(t, page, 3, "succeeded", "")
	jobResult(t, page, 4, "failed", "BATCH_ABORTED")
	jobAbsent(t, "JCC-0005")`);
  probe('BJ-4', 'reanuda desde el cursor tras caer a mitad de chunk', `	id := jobSubmit(t, ${body(...skus('JDD', 5))})
	if !jobFire(t, id) {
		t.Fatal("el primer chunk")
	}
	// La réplica cae al escribir el resultado del elemento 3, a mitad del segundo chunk: el 2 ya está confirmado.
	jobCrashAt.Store(3)
	_, err := httpapi.NewBatchJobRunner(jobUseCases(), slog.New(slog.DiscardHandler), ${PROBE_CHUNK_SIZE}).${goExported(operation.name)}(t.Context(), id)
	jobCrashAt.Store(-1)
	if err == nil {
		t.Fatal("la sonda simula la caída")
	}
	if cursor := jobCursor(t, id); cursor != 3 {
		t.Fatalf("lo confirmado queda, el resto no: cursor %d", cursor)
	}
	jobRun(t, id)
	_, job, _ := jobGet(t, id, "alice")
	if job["status"] != "completed" {
		t.Fatalf("el trabajo reanudado termina: %v", job)
	}
	jobSummary(t, job, 5, 5, 0, 0)
	if results := jobResultCount(t, id); results != 5 {
		t.Fatalf("un resultado por elemento, ninguno repetido: %d", results)
	}
	jobPresent(t, "JDD-0003")`);
  probe('BJ-5', 'la valla revierte al que pierde el trabajo', `	id := jobSubmit(t, ${body(draft('JEE-0001'))})
	var bumped atomic.Bool
	application.ProbeAfterEffect = func(ctx context.Context) error {
		if bumped.Swap(true) {
			return nil
		}
		return jobBumpCursor(ctx, id)
	}
	defer func() { application.ProbeAfterEffect = nil }()
	jobFire(t, id)
	application.ProbeAfterEffect = nil
	jobAbsent(t, "JEE-0001")
	if results := jobResultCount(t, id); results != 0 {
		t.Fatalf("el elemento revierte entero, resultado incluido: %d", results)
	}
	if cursor := jobCursor(t, id); cursor != 1 {
		t.Fatalf("el cursor es el de la otra réplica: %d", cursor)
	}`);
  probe('BJ-6', 'solo lo lee quien lo creó', `	id := jobSubmit(t, ${body(draft('JFF-0001'))})
	if status, json, _ := jobGet(t, id, "bob"); status != http.StatusNotFound || json["code"] != "BATCH_JOB_NOT_FOUND" {
		t.Fatalf("un trabajo ajeno es un 404: %d %v", status, json)
	}
	if status, json, _ := jobResults(t, id, "", "bob"); status != http.StatusNotFound || json["code"] != "BATCH_JOB_NOT_FOUND" {
		t.Fatalf("también sus resultados: %d %v", status, json)
	}
	if status, _, _ := jobGet(t, uuid.New(), "alice"); status != http.StatusNotFound {
		t.Fatalf("un trabajo que no existe: %d", status)
	}
	if status, _, _ := jobGet(t, id, "alice"); status != http.StatusOK {
		t.Fatalf("su dueño lo lee: %d", status)
	}
	if status, _, _ := jobResults(t, id, "", "alice"); status != http.StatusOK {
		t.Fatalf("y sus resultados: %d", status)
	}`);
  probe('BJ-7', 'la clave del lote', `	first := ${body(draft('JGG-0001'))}
	status, created, where := jobPost(t, first, "clave-bj7", "alice")
	if status != http.StatusAccepted {
		t.Fatalf("el alta con clave: %d %v", status, created)
	}
	id := jobID(t, created)
	jobRun(t, id)
	status, repeated, again := jobPost(t, first, "clave-bj7", "alice")
	if status != http.StatusAccepted || again != where || repeated["status"] != "completed" {
		t.Fatalf("la misma clave: el mismo trabajo, en su estado: %d %q %v", status, again, repeated)
	}
	if status, reused, _ := jobPost(t, ${body(draft('JGG-0002'))}, "clave-bj7", "alice"); status != http.StatusConflict || reused["code"] != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatalf("la misma clave con otro contenido: %d %v", status, reused)
	}
	if _, other, _ := jobPost(t, first, "clave-bj7", "bob"); jobID(t, other) == id {
		t.Fatal("la clave es de cada dueño")
	}
	jobSetTime(t, id, "key_expires_at", time.Now().Add(-time.Minute))
	status, fresh, _ := jobPost(t, ${body(draft('JGG-0002'))}, "clave-bj7", "alice")
	if status != http.StatusAccepted || jobID(t, fresh) == id {
		t.Fatalf("pasada su ventana, la clave se libera: %d %v", status, fresh)
	}`);
  probe('BJ-8', 'la purga se lleva lo terminado viejo y nunca lo que está en marcha', `	old := jobSubmit(t, ${body(draft('JHH-0001'))})
	jobRun(t, old)
	recent := jobSubmit(t, ${body(draft('JHH-0002'))})
	jobRun(t, recent)
	running := jobSubmit(t, ${body(draft('JHH-0003'))})
	jobSetTime(t, old, "finished_at", time.Now().AddDate(0, 0, -8))
	jobSetTime(t, running, "created_at", time.Now().AddDate(0, 0, -30))
	if _, err := NewBatchJobStore(probeTx).Purge(t.Context(), 7); err != nil {
		t.Fatal(err)
	}
	if jobExists(t, old) || jobResultCount(t, old) != 0 {
		t.Fatal("el terminado hace más de la retención se va, con sus resultados")
	}
	if !jobExists(t, recent) {
		t.Fatal("el terminado reciente se queda")
	}
	if !jobExists(t, running) {
		t.Fatal("uno en marcha no se purga nunca")
	}`);
  probe('BJ-9', 'el sobre es un 400 sin trabajo', `	before := jobCount(t)
	if status, json, _ := jobPost(t, "{}", "", "alice"); status != http.StatusBadRequest {
		t.Fatalf("el campo over ausente: %d %v", status, json)
	}
	many := make([]map[string]any, ${maxItems + 1})
	for i := range many {
		many[i] = map[string]any{}
	}
	text, err := json.Marshal(map[string]any{"items": many})
	if err != nil {
		t.Fatal(err)
	}
	if status, json, _ := jobPost(t, string(text), "", "alice"); status != http.StatusBadRequest {
		t.Fatalf("más elementos que maxItems: %d %v", status, json)
	}
	if status, json, _ := jobPost(t, "{\\"items\\":", "", "alice"); status != http.StatusBadRequest {
		t.Fatalf("un cuerpo que no es JSON: %d %v", status, json)
	}
	if after := jobCount(t); after != before {
		t.Fatalf("ningún trabajo: %d → %d", before, after)
	}`);
  const contents = Array.from({ length: BATCH_KEY_RACE_ROUNDS }, (_, round) => body(draft(`JKK-${String(round).padStart(4, '0')}`)));
  probe('BJ-10', 'la carrera de la clave', `	contents := []string{
${contents.map((content) => `		${content},`).join('\n')}
	}
	var wrong []string
	for round, content := range contents {
		key := "carrera-bj10-" + strconv.Itoa(round)
		var statuses [2]int
		var locations [2]string
		var wg sync.WaitGroup
		for n := range statuses {
			wg.Go(func() {
				statuses[n], _, locations[n] = jobPost(t, content, key, "alice")
			})
		}
		wg.Wait()
		for _, status := range statuses {
			if status != http.StatusAccepted {
				wrong = append(wrong, strconv.Itoa(round)+": "+strconv.Itoa(status))
			}
		}
		if locations[0] != locations[1] {
			wrong = append(wrong, strconv.Itoa(round)+": dos Location, "+locations[0]+" y "+locations[1])
		}
		if jobs := jobCountOf(t, key); jobs != 1 {
			wrong = append(wrong, strconv.Itoa(round)+": "+strconv.FormatInt(jobs, 10)+" trabajos con la clave")
		}
	}
	if len(wrong) > 0 {
		t.Fatalf("las dos responden 202 con el mismo Location (D13), y un solo trabajo por clave: %s", strings.Join(wrong, " | "))
	}`);

  const repository = `New${product.name}Repository(${repositoryArgs(model, product, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})`;
  const helpers = `// jobMust es el valor, o un pánico si la lectura de la sonda falló.
func jobMust[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// jobKind es el temporizador de los trabajos de la operación.
const jobKind = ${goString(`batch:${operation.name}`)}

// jobCrashAt es el índice en el que la réplica cae al escribir su resultado (BJ-4); -1, no cae.
var jobCrashAt = func() *atomic.Int64 {
	n := &atomic.Int64{}
	n.Store(-1)
	return n
}()

// crashingBatchJobStore es el almacén emitido de una réplica que cae al escribir el resultado del elemento jobCrashAt.
type crashingBatchJobStore struct {
	domain.BatchJobStore
}

func (s crashingBatchJobStore) InsertResult(ctx context.Context, jobID uuid.UUID, result domain.BatchJobResult) error {
	if int64(result.Index) == jobCrashAt.Load() {
		return errors.New("sonda: la réplica cae")
	}
	return s.BatchJobStore.InsertResult(ctx, jobID, result)
}

// jobIssuer firma los tokens de la sonda; el handler acepta su JWKS.
var jobIssuer = sync.OnceValues(securitytest.NewIssuer)

// jobUseCases son los casos de uso como los cablea el arranque, sobre las Transactions de la sonda.
func jobUseCases() *application.UseCases {
	return application.NewUseCases(slog.New(slog.DiscardHandler), application.Dependencies{Transactor: probeTx, ${goExported(repositoryParam(product))}: ${repository}, BatchJobs: crashingBatchJobStore{NewBatchJobStore(probeTx)}})
}

// jobCall llama a la API emitida entera, con el token de subject.
func jobCall(t *testing.T, method, path, body, key, subject string) (int, map[string]any, string) {
	t.Helper()
	issuer, err := jobIssuer()
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := issuer.JWKS()
	if err != nil {
		t.Fatal(err)
	}
	claims := ${fullAccessLiteral(model)}
	claims["sub"] = subject
	token, err := issuer.Token(claims)
	if err != nil {
		t.Fatal(err)
	}
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequestWithContext(t.Context(), method, path, reader)
	request.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	recorder := httptest.NewRecorder()
	httpapi.NewHandler(&health.Probes{}, jobUseCases(), slog.New(slog.DiscardHandler), security.Settings{JWKS: jwks}).ServeHTTP(recorder, request)
	var out map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &out); err != nil {
			t.Fatalf("la respuesta no es JSON (%d): %s", recorder.Code, recorder.Body.String())
		}
	}
	return recorder.Code, out, recorder.Header().Get("Location")
}

func jobPost(t *testing.T, body, key, subject string) (int, map[string]any, string) {
	t.Helper()
	return jobCall(t, http.MethodPost, ${goString(path)}, body, key, subject)
}

func jobGet(t *testing.T, id uuid.UUID, subject string) (int, map[string]any, string) {
	t.Helper()
	return jobCall(t, http.MethodGet, strings.Replace(${goString(paths.status)}, "{jobId}", id.String(), 1), "", "", subject)
}

func jobResults(t *testing.T, id uuid.UUID, query, subject string) (int, map[string]any, string) {
	t.Helper()
	return jobCall(t, http.MethodGet, strings.Replace(${goString(paths.results)}, "{jobId}", id.String(), 1)+query, "", "", subject)
}

func jobID(t *testing.T, json map[string]any) uuid.UUID {
	t.Helper()
	text, _ := json["id"].(string)
	id, err := uuid.Parse(text)
	if err != nil {
		t.Fatalf("sin id del trabajo: %v", json)
	}
	return id
}

func jobSubmit(t *testing.T, body string) uuid.UUID {
	t.Helper()
	status, json, _ := jobPost(t, body, "", "alice")
	if status != http.StatusAccepted {
		t.Fatalf("el alta: %d %v", status, json)
	}
	return jobID(t, json)
}

// jobFire es un disparo del temporizador del trabajo: el procesador emitido, con el chunk de la sonda. true si queda trabajo.
func jobFire(t *testing.T, id uuid.UUID) bool {
	t.Helper()
	more, err := httpapi.NewBatchJobRunner(jobUseCases(), slog.New(slog.DiscardHandler), ${PROBE_CHUNK_SIZE}).${goExported(operation.name)}(t.Context(), id)
	if err != nil {
		t.Fatalf("el disparo del trabajo %s: %v", id, err)
	}
	return more
}

func jobRun(t *testing.T, id uuid.UUID) {
	t.Helper()
	for range 100 {
		if !jobFire(t, id) {
			return
		}
	}
	t.Fatal("el trabajo no termina")
}

func jobFind(t *testing.T, sku string) bool {
	t.Helper()
	_, found, err := ${repository}.FindBySku(t.Context(), sku)
	if err != nil {
		t.Fatalf("buscar %s: %v", sku, err)
	}
	return found
}

func jobPresent(t *testing.T, sku string) {
	t.Helper()
	if !jobFind(t, sku) {
		t.Fatalf("%s tendría que estar confirmado", sku)
	}
}

func jobAbsent(t *testing.T, sku string) {
	t.Helper()
	if jobFind(t, sku) {
		t.Fatalf("%s no tendría que estar en la base", sku)
	}
}

func jobSummary(t *testing.T, json map[string]any, total, succeeded, failed, notAttempted int) {
	t.Helper()
	summary, ok := json["summary"].(map[string]any)
	if !ok {
		t.Fatalf("sin summary: %v", json)
	}
	got := []any{summary["total"], summary["succeeded"], summary["failed"], summary["notAttempted"]}
	want := []any{float64(total), float64(succeeded), float64(failed), float64(notAttempted)}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("el resumen: %v, se esperaba %v", got, want)
		}
	}
}

func jobItems(t *testing.T, page map[string]any) []map[string]any {
	t.Helper()
	raw, ok := page["items"].([]any)
	if !ok {
		t.Fatalf("sin items: %v", page)
	}
	items := make([]map[string]any, 0, len(raw))
	for _, element := range raw {
		item, _ := element.(map[string]any)
		items = append(items, item)
	}
	return items
}

func jobResult(t *testing.T, page map[string]any, index int, status, code string) {
	t.Helper()
	for _, item := range jobItems(t, page) {
		if item["index"] != float64(index) {
			continue
		}
		if item["status"] != status || (code != "" && item["error"] != code) {
			t.Fatalf("el resultado %d: %v, se esperaba %s %s", index, item, status, code)
		}
		return
	}
	t.Fatalf("sin el resultado %d: %v", index, page)
}

${storage(model)}`;
  const document = model.persistenceKind === 'document';
  const dir = storeDir(model);
  const imports = [
    'context',
    'encoding/json',
    'errors',
    'io',
    'log/slog',
    'net/http',
    'net/http/httptest',
    'strconv',
    'strings',
    'sync',
    'sync/atomic',
    'testing',
    'time',
    'github.com/google/uuid',
    ...(document ? ['go.mongodb.org/mongo-driver/v2/bson'] : []),
    'internal/application',
    'internal/domain',
    'internal/httpapi',
    'internal/platform/health',
    'internal/platform/security',
    'internal/platform/security/securitytest'
  ];
  const content = goFile({
    pkg: dir.split('/').pop(),
    imports,
    body: `// La sonda de los lotes asíncronos (DSL 2.30, fase B) de db-check y doc-check (scripts/lib/batch-job-probes.js de keel-go):
// BJ-1 a BJ-10 por el http.Handler y el procesador emitidos, contra un ${document ? 'MongoDB' : 'motor relacional'} real. No es parte del proyecto
// generado.

${[...tests, helpers].join('\n\n')}
`,
    module: model.service.goModule,
    generated: false
  });
  return { path: `${dir}/batch_job_probe_test.go`, content };
}
