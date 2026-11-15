// Los lotes SÍNCRONOS con clave (DSL 2.30, D15, incremento 10b) contra lo emitido, para db-check y doc-check: BK-1 a BK-5
// de keel-core/gen/batch.js, con los ids que ejecutan keel-spring (batch-check), keel-nest y keel-dotnet (su
// scripts/lib/batch-key-probes.js) sobre los MISMOS diseños (BATCH_KEY_DESIGNS de keel-core/test/helpers/batch-designs.js).
// El handler de la sonda es el de batch-probes.js (batchProbePatch).
//
// `batch_key_probe_test.go`, en el paquete del almacén: una prueba por caso con el id en el nombre (`TestBatchKey_BK4_…`).
// Comparte la base con el resto de sondas, así que NO vacía nada; cada caso usa sus propias claves y sus propios sku
// (`ZK<letra>-000n`), y cuenta trabajos y resultados como DIFERENCIA. La petición entra por el `http.Handler` ENTERO de
// httpapi.NewHandler. La que muere a mitad de lote (BK-3, BK-4) es un almacén que lanza al escribir el resultado del SEGUNDO
// elemento (envuelve el emitido en las Dependencies): en Go el fallo del handler sería el de su elemento; el del almacén
// vuelve a caer al escribir el resultado de fallo y escapa del lote sin mover el cursor, como el Error del gancho de
// keel-spring. Que lleve muerta más que `batch.sync-stale-ms` se simula envejeciendo su `updated_at`.

import { BATCH_KEY_CASES, BATCH_KEY_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { BATCH_JOB, BATCH_ITEM_RESULT, BATCH_SYNC_STALE } from '@keel-system/keel-core/gen/batch-store';
import { goFile, goString } from '../../src/lib/go-source.js';
import { sqlDialect, storeDir } from '../../src/lib/relational-engine.js';
import { repositoryArgs, repositoryParam } from '../../src/scaffold/repositories.js';
import { goExported } from '../../src/lib/go-projection.js';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';
import { batchOperations } from './batch-probes.js';

/** Los sujetos por almacén: los de BATCH_KEY_DESIGNS. */
export const BATCH_KEY_SUBJECTS = { relational: ['catalog-batch-keyed', 'catalog-batch-atomic-keyed'], document: ['catalog-batch-keyed-mongo'] };

/** Las operaciones síncronas con clave del modelo. */
export const keyedProbeOperations = (model) => batchOperations(model).filter((operation) => operation.batch.idempotency);

/** Los casos de un lote síncrono con clave que ejecuta este diseño: BK-1 a BK-4 con un per-item, BK-5 con un todo o nada. */
export function batchKeyCases(model) {
  const atomicities = new Set(keyedProbeOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BK-1', 'BK-2', 'BK-3', 'BK-4');
  if (atomicities.has('all-or-nothing')) ids.push('BK-5');
  return BATCH_KEY_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────

const JOBS = /^internal\/httpapi\/batch_jobs\.go$/;
const STORE = /^internal\/infrastructure\/\w+\/batch_jobs\.go$/;
const both = (entry) => ({ relational: { ...entry, expect: /_BK\d+_/ }, document: { ...entry, expect: /_BK\d+_/ } });

/**
 * Los sabotajes, por almacén, con la forma de los de db-check y doc-check (`files`, `from`, `to`): rompen lo emitido
 * CONSERVANDO LA FORMA (sigue compilando). El veredicto exacto lo da `batchKeySabotageVerdict`.
 */
export const BATCH_KEY_SABOTAGE_SPECS = {
  // La repetición de un lote terminado lo vuelve a procesar en vez de responder lo guardado.
  'bk-replay-reprocess': both({
    files: JOBS,
    from: `		// La repetición de un lote terminado: lo guardado, sin procesar nada.
		return storedBatchResponse(r.Context(), store, started.id)`,
    to: `		return runPerItem(a, r, items, itemErrors, each)`
  }),
  // Un lote en marcha se toma igual que uno muerto.
  'bk-steal-running': {
    relational: { files: STORE, from: '"staleMs": s.syncStaleMs}', to: '"staleMs": s.syncStaleMs * 0}', expect: /_BK\d+_/ },
    document: { files: STORE, from: 'now.Add(-time.Duration(s.syncStaleMs) * time.Millisecond)', to: 'now.Add(-time.Duration(s.syncStaleMs*0) * time.Millisecond)', expect: /_BK\d+_/ }
  },
  // La reanudación empieza en el principio y no en el cursor.
  'bk-no-resume': both({ files: JOBS, from: 'for index := started.from; index < len(items); index++ {', to: 'for index := 0; index < len(items); index++ {' }),
  // El todo o nada que falla deja su trabajo.
  'bk-keep-failed': both({
    files: JOBS,
    from: `		_, err := a.useCases.BatchJobs().Discard(ctx, id)
		return err`,
    to: `		return nil`
  })
};

export const isBatchKeySabotage = (id) => Boolean(id && BATCH_KEY_SABOTAGE_SPECS[id]);

/** Lo que tiene que caer con un sabotaje en este diseño: sus casos BK que la sonda ejecuta, y solo esos. */
export function batchKeySabotageVerdict(failures, id, model) {
  const cases = batchKeyCases(model);
  const want = BATCH_KEY_SABOTAGES[id].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_BK(\d+)_/g)].map((match) => `BK-${match[1]}`)))].sort();
  return { exact: want.length > 0 && failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** El sujeto de un sabotaje bk-*: el todo o nada para bk-keep-failed, el per-item para el resto. */
export const batchKeySabotageSubject = (id, document) => (document ? 'catalog-batch-keyed-mongo' : id === 'bk-keep-failed' ? 'catalog-batch-atomic-keyed' : 'catalog-batch-keyed');

// ─── Lo que la sonda lee y retoca de las tablas ──────────────────────────────────────────────────

function storage(model) {
  const job = BATCH_JOB.table;
  const result = BATCH_ITEM_RESULT.table;
  if (model.persistenceKind === 'document') {
    const collection = (name) => `keyMust(probeTx.collection(${goString(name)}))`;
    return `func keyJobCount(t *testing.T) int64 {
	t.Helper()
	return keyMust(${collection(job)}.CountDocuments(t.Context(), bson.D{}))
}

func keyResultCount(t *testing.T) int64 {
	t.Helper()
	return keyMust(${collection(result)}.CountDocuments(t.Context(), bson.D{}))
}

// keyAge retrasa a mano una hora del trabajo de esa clave.
func keyAge(t *testing.T, key, field string, ago time.Duration) {
	t.Helper()
	at := bson.NewDateTimeFromTime(time.Now().Add(-ago))
	if _, err := ${collection(job)}.UpdateOne(t.Context(), bson.D{{Key: "idempotency_key", Value: key}}, bson.D{{Key: "$set", Value: bson.D{{Key: field, Value: at}}}}); err != nil {
		t.Fatal(err)
	}
}`;
  }
  const p = sqlDialect(model).param;
  return `func keyScalar(t *testing.T, query string) int64 {
	t.Helper()
	var n int64
	if err := keyMust(probeTx.conn(t.Context())).QueryRowContext(t.Context(), query).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func keyJobCount(t *testing.T) int64 {
	t.Helper()
	return keyScalar(t, ${goString(`SELECT count(*) FROM ${job}`)})
}

func keyResultCount(t *testing.T) int64 {
	t.Helper()
	return keyScalar(t, ${goString(`SELECT count(*) FROM ${result}`)})
}

// keyAge retrasa a mano una hora del trabajo de esa clave: la columna es una de las de la tabla, nunca un valor de fuera.
func keyAge(t *testing.T, key, column string, ago time.Duration) {
	t.Helper()
	query := "UPDATE ${job} SET " + column + ${goString(` = ${p(1)} WHERE idempotency_key = ${p(2)}`)}
	if _, err := keyMust(probeTx.conn(t.Context())).ExecContext(t.Context(), query, time.Now().Add(-ago).UTC(), key); err != nil {
		t.Fatal(err)
	}
}`;
}

// ─── Los casos ───────────────────────────────────────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => goString(JSON.stringify({ items }));

/** `batch_key_probe_test.go` en el paquete del almacén, o null si el diseño no tiene un lote síncrono con clave. */
export function batchKeyProbeFile(model) {
  const operations = keyedProbeOperations(model);
  if (operations.length === 0) return null;
  const cases = new Set(batchKeyCases(model));
  const product = model.entities.find((entity) => entity.name === 'Product');
  const perItem = operations.find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const stale = BATCH_SYNC_STALE.default;
  const tests = [];
  const probe = (id, title, code) => {
    if (!cases.has(id)) return;
    const name = title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join('');
    tests.push(`// TestBatchKey_${id.replace('-', '')}_${name}: ${id}, ${title}.
func TestBatchKey_${id.replace('-', '')}_${name}(t *testing.T) {
${code}
}`);
  };
  if (perItem) {
    const path = goString(`${model.api.routeBase}${perItem.route.path}`);
    probe('BK-1', 'la repeticion devuelve el mismo 207', `	content := ${body(draft('ZKA-0001'), draft('ZKA-0002'))}
	jobs := keyJobCount(t)
	status, first, firstText := keyPost(t, ${path}, content, "clave-bk1")
	if status != http.StatusMultiStatus {
		t.Fatalf("el primero responde 207: %d %v", status, first)
	}
	keySummary(t, first, 2, 2, 0, 0)
	results := keyResultCount(t)
	status, repeated, repeatedText := keyPost(t, ${path}, content, "clave-bk1")
	if status != http.StatusMultiStatus {
		t.Fatalf("la repetición responde 207: %d %v", status, repeated)
	}
	if repeatedText != firstText {
		t.Fatalf("el MISMO 207: %s frente a %s", repeatedText, firstText)
	}
	if after := keyResultCount(t); after != results {
		t.Fatalf("sin resultados nuevos: %d → %d", results, after)
	}
	if after := keyJobCount(t); after != jobs+1 {
		t.Fatalf("un solo trabajo: %d → %d", jobs, after)
	}`);
    probe('BK-2', 'otra firma es la clave reutilizada', `	jobs := keyJobCount(t)
	if status, json, _ := keyPost(t, ${path}, ${body(draft('ZKB-0001'))}, "clave-bk2"); status != http.StatusMultiStatus {
		t.Fatalf("el primero: %d %v", status, json)
	}
	if status, reused, _ := keyPost(t, ${path}, ${body(draft('ZKB-0002'))}, "clave-bk2"); status != http.StatusConflict || reused["code"] != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatalf("la misma clave con otro cuerpo: %d %v", status, reused)
	}
	keyAbsent(t, "ZKB-0002")
	keyAge(t, "clave-bk2", "key_expires_at", time.Minute)
	if status, fresh, _ := keyPost(t, ${path}, ${body(draft('ZKB-0002'))}, "clave-bk2"); status != http.StatusMultiStatus {
		t.Fatalf("pasada su ventana, un lote nuevo: %d %v", status, fresh)
	}
	keyPresent(t, "ZKB-0002")
	if after := keyJobCount(t); after != jobs+2 {
		t.Fatalf("con su trabajo: %d → %d", jobs, after)
	}`);
    probe('BK-3', 'en marcha es 409', `	content := ${body(draft('ZKC-0001'), draft('ZKC-0002'), draft('ZKC-0003'))}
	results := keyResultCount(t)
	keyDies(t, ${path}, content, "clave-bk3")
	if status, running, _ := keyPost(t, ${path}, content, "clave-bk3"); status != http.StatusConflict || running["code"] != "IDEMPOTENCY_KEY_IN_PROGRESS" {
		t.Fatalf("el primero sigue en marcha: %d %v", status, running)
	}
	keyAbsent(t, "ZKC-0002")
	if after := keyResultCount(t); after != results+1 {
		t.Fatalf("solo el resultado del primero: %d → %d", results, after)
	}`);
    probe('BK-4', 'reanuda desde el cursor', `	content := ${body(draft('ZKD-0001'), draft('ZKD-0002'), draft('ZKD-0003'))}
	results := keyResultCount(t)
	keyDies(t, ${path}, content, "clave-bk4")
	keyPresent(t, "ZKD-0001")
	keyAge(t, "clave-bk4", "updated_at", ${stale * 2}*time.Millisecond)
	status, resumed, _ := keyPost(t, ${path}, content, "clave-bk4")
	if status != http.StatusMultiStatus {
		t.Fatalf("la repetición de un lote muerto lo sigue: %d %v", status, resumed)
	}
	keySummary(t, resumed, 3, 3, 0, 0)
	if after := keyResultCount(t); after != results+3 {
		t.Fatalf("un resultado por elemento, sin repetir ninguno: %d → %d", results, after)
	}
	keyPresent(t, "ZKD-0003")`);
  }
  if (atomic) {
    const path = goString(`${model.api.routeBase}${atomic.route.path}`);
    probe('BK-5', 'todo o nada con clave', `	jobs := keyJobCount(t)
	good := ${body(draft('ZKE-0001'), draft('ZKE-0002'))}
	status, first, firstText := keyPost(t, ${path}, good, "clave-bk5")
	if status != ${atomic.route.status} {
		t.Fatalf("el lote confirmado: %d %v", status, first)
	}
	status, repeated, repeatedText := keyPost(t, ${path}, good, "clave-bk5")
	if status != ${atomic.route.status} || repeatedText != firstText {
		t.Fatalf("se repite con la misma respuesta: %d %v", status, repeated)
	}
	if after := keyJobCount(t); after != jobs+1 {
		t.Fatalf("sin trabajo nuevo: %d → %d", jobs, after)
	}
	bad := ${body(draft('ZKE-0003'), draft('ZKE-0003'))}
	if status, failed, _ := keyPost(t, ${path}, bad, "clave-bk5b"); status != http.StatusConflict || failed["code"] != "SKU_ALREADY_EXISTS" {
		t.Fatalf("el que falla: %d %v", status, failed)
	}
	if after := keyJobCount(t); after != jobs+1 {
		t.Fatalf("el que falla no deja trabajo: %d → %d", jobs, after)
	}
	if status, again, _ := keyPost(t, ${path}, bad, "clave-bk5b"); again["code"] != "SKU_ALREADY_EXISTS" {
		t.Fatalf("repetirlo lo vuelve a procesar: %d %v", status, again)
	}
	keyAbsent(t, "ZKE-0003")`);
  }

  const repository = `New${product.name}Repository(${repositoryArgs(model, product, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})`;
  const helpers = `// keyMust es el valor, o un pánico si la lectura de la sonda falló.
func keyMust[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// keyCrashAt es el índice en el que la petición muere al escribir su resultado (BK-3, BK-4); -1, no muere.
var keyCrashAt = func() *atomic.Int64 {
	n := &atomic.Int64{}
	n.Store(-1)
	return n
}()

// keyCrashingStore es el almacén emitido de una petición que muere al escribir el resultado del elemento keyCrashAt.
type keyCrashingStore struct {
	domain.BatchJobStore
}

func (s keyCrashingStore) InsertResult(ctx context.Context, jobID uuid.UUID, result domain.BatchJobResult) error {
	if int64(result.Index) == keyCrashAt.Load() {
		return errors.New("sonda: la petición muere")
	}
	return s.BatchJobStore.InsertResult(ctx, jobID, result)
}

// keyHandler es el servicio como lo cablea el arranque: el http.Handler entero de httpapi, con los casos de uso sobre las
// Transactions de la sonda y el almacén de los trabajos con el umbral del lote muerto de keel-core.
func keyHandler() http.Handler {
	logger := slog.New(slog.DiscardHandler)
	useCases := application.NewUseCases(logger, application.Dependencies{Transactor: probeTx, ${goExported(repositoryParam(product))}: ${repository}, BatchJobs: keyCrashingStore{NewBatchJobStore(probeTx, ${stale})}})
	return httpapi.NewHandler(&health.Probes{}, useCases, logger)
}

// keyPost manda el lote con su clave y devuelve el status, la respuesta leída y su texto.
func keyPost(t *testing.T, path, body, key string) (int, map[string]any, string) {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	recorder := httptest.NewRecorder()
	keyHandler().ServeHTTP(recorder, request)
	var out map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &out); err != nil {
			t.Fatalf("la respuesta no es JSON (%d): %s", recorder.Code, recorder.Body.String())
		}
	}
	return recorder.Code, out, recorder.Body.String()
}

// keyDies es la petición que muere al escribir el resultado del SEGUNDO elemento: el primero queda confirmado y el trabajo,
// sin terminar.
func keyDies(t *testing.T, path, body, key string) {
	t.Helper()
	keyCrashAt.Store(1)
	status, json, _ := keyPost(t, path, body, key)
	keyCrashAt.Store(-1)
	if status != http.StatusInternalServerError {
		t.Fatalf("la sonda tenía que matar la petición: %d %v", status, json)
	}
}

func keyFind(t *testing.T, sku string) bool {
	t.Helper()
	_, found, err := ${repository}.FindBySku(t.Context(), sku)
	if err != nil {
		t.Fatalf("buscar %s: %v", sku, err)
	}
	return found
}

func keyPresent(t *testing.T, sku string) {
	t.Helper()
	if !keyFind(t, sku) {
		t.Fatalf("%s tendría que estar confirmado", sku)
	}
}

func keyAbsent(t *testing.T, sku string) {
	t.Helper()
	if keyFind(t, sku) {
		t.Fatalf("%s no tendría que estar en la base", sku)
	}
}

func keySummary(t *testing.T, json map[string]any, total, succeeded, failed, notAttempted int) {
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

${storage(model)}`;
  const document = model.persistenceKind === 'document';
  const dir = storeDir(model);
  const imports = [
    'context',
    'encoding/json',
    'errors',
    'log/slog',
    'net/http',
    'net/http/httptest',
    'strings',
    'sync/atomic',
    'testing',
    'time',
    'github.com/google/uuid',
    ...(document ? ['go.mongodb.org/mongo-driver/v2/bson'] : []),
    'internal/application',
    'internal/domain',
    'internal/httpapi',
    'internal/platform/health'
  ];
  const content = goFile({
    pkg: dir.split('/').pop(),
    imports,
    body: `// La sonda de los lotes síncronos con clave (DSL 2.30, D15) de db-check y doc-check (scripts/lib/batch-key-probes.js de
// keel-go): BK-1 a BK-5 por el http.Handler emitido, contra un ${document ? 'MongoDB' : 'motor relacional'} real. No es parte del proyecto generado.

${[...tests, helpers].join('\n\n')}
`,
    module: model.service.goModule,
    generated: false
  });
  return { path: `${dir}/batch_key_probe_test.go`, content };
}
