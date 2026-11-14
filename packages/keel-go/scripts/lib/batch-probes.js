// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) contra lo emitido, para db-check y doc-check: BA-1 a BA-7
// de keel-core/gen/batch.js, con los ids que ejecutan keel-spring (batch-check), keel-nest y keel-dotnet (su
// scripts/lib/batch-probes.js) sobre los MISMOS diseños (keel-core/test/helpers/batch-designs.js). Dos cosas se escriben
// dentro del sujeto, y no forman parte del proyecto:
//
//   · el HANDLER de `importProducts`, en el lugar del stub (batchProbePatch): lo que escribiría el agente para UN
//     elemento —un nombre «BOOM» es un fallo que ningún diseño declara—. Como la de keel-nest y keel-dotnet, no busca el sku
//     antes de guardar: el duplicado lo rechaza la UNICIDAD del motor y lo traduce el adaptador al error que el diseño
//     declara;
//   · `batch_probe_test.go` en el paquete del almacén, una prueba por caso con el id en el nombre (`TestBatch_BA3_…`), como
//     las del historial: comparte la base con el resto de sondas, así que NO vacía nada. Cada caso usa sus propios sku (el
//     prefijo `ZZ<letra>`, que ninguna muestra genera) y lee solo esos.
//
// Lo que se mide es lo que build pone alrededor del handler: el sobre, el bucle, la transacción por elemento, la lectura de
// cada elemento y la respuesta, y lo que quedó en la base. La petición entra por el `http.Handler` ENTERO que construye
// httpapi.NewHandler —el borde, la tabla de rutas y writeError—, con los casos de uso de NewUseCases sobre las
// Transactions de la sonda, como los cablea el arranque.

import { BATCH_CASES, BATCH_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { goFile, goString } from '../../src/lib/go-source.js';
import { storeDir } from '../../src/lib/relational-engine.js';
import { repositoryArgs, repositoryParam } from '../../src/scaffold/repositories.js';
import { goExported } from '../../src/lib/go-projection.js';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';

/** Lo que el nombre de un elemento pide al handler de la sonda: fallar con algo que el diseño no declara (BA-4). */
export const UNDECLARED_FAILURE_NAME = 'BOOM';

/** Las operaciones por lotes del modelo. */
export const batchOperations = (model) => model.services.flatMap((service) => service.operations).filter((operation) => operation.batch);

/** Los sujetos por almacén: los de batch-designs.js. */
export const BATCH_SUBJECTS = { relational: ['catalog-batch', 'catalog-batch-atomic'], document: ['catalog-batch-mongo'] };

/** Los casos que ejecuta este diseño: los mismos que los otros tres (batch-parity.test.js lo compara). */
export function batchCases(model) {
  const atomicities = new Set(batchOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5');
  if (atomicities.has('all-or-nothing')) ids.push('BA-6');
  if (atomicities.size > 0) ids.push('BA-7');
  return BATCH_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────

const BATCH = /^internal\/httpapi\/batch\.go$/;
const ENDPOINTS = /^internal\/httpapi\/\w+_endpoints\.go$/;

const spec = (files, from, to) => {
  const entry = { files, from, to, expect: /_BA\d+_/ };
  return { relational: entry, document: entry };
};

/**
 * Los sabotajes, por almacén, con la forma de db-sabotages.js y doc-sabotages.js (`files`, `from`, `to`): rompen lo emitido
 * CONSERVANDO LA FORMA (sigue compilando). `expect` casa con cualquier sonda de los lotes: el veredicto exacto lo da
 * `batchSabotageVerdict`.
 */
export const BATCH_SABOTAGE_SPECS = {
  // El lote entero en UNA transacción: los casos de uso que despacha se unen a ella (no abren otra si hay una en curso).
  'ba-one-tx': spec(
    ENDPOINTS,
    /\tresponse, err := runPerItem\(a, r, ([\s\S]*?\n\t\}\))\n/,
    '\tvar response BatchResponse\n\terr = a.useCases.InTransaction(r.Context(), func(ctx context.Context) error {\n\t\tvar inner error\n\t\tresponse, inner = runPerItem(a, r.WithContext(ctx), $1\n\t\treturn inner\n\t})\n'
  ),
  // Un elemento mal formado tumba el lote entero con un 400, como si el borde validara el cuerpo completo.
  'ba-validate-whole': spec(BATCH, 'results = append(results, batchFailed(index, validationCode, problem))\n\t\t\tcontinue', 'return BatchResponse{}, malformed(nil)'),
  // Un fallo que no es de su elemento no detiene el lote.
  'ba-continue-on-undeclared': spec(BATCH, 'stopped = true', 'stopped = false'),
  // El lote por elemento responde 200: el status deja de ser el del método.
  'ba-status': spec(ENDPOINTS, 'return writeJSON(w, batchMultiStatus, response)', 'return writeJSON(w, http.StatusOK, response)'),
  // all-or-nothing sin la transacción que abarca el lote: cada elemento se confirma en la suya.
  'ba-atomic-no-tx': spec(ENDPOINTS, 'a.useCases.InTransaction,', 'func(ctx context.Context, fn func(context.Context) error) error { return fn(ctx) },')
};

export const isBatchSabotage = (id) => Boolean(BATCH_SABOTAGE_SPECS[id]);

/**
 * Dónde cae `ba-one-tx` en keel-go, por motor: MEDIDO, y no donde lo declara keel-core (el de keel-spring, BA-2, BA-4 y
 * BA-5). En database/sql un error que el bucle captura no marca la transacción para revertir, así que BA-4 no cae: lo
 * anterior al elemento que detiene el lote se confirma igual. Lo que delata la transacción única es el MOTOR: PostgreSQL
 * la aborta tras el duplicado, el elemento siguiente falla con «current transaction is aborted» (BA-2) y el commit del
 * lote entero revierte (BA-5), como en keel-nest. En MongoDB, lo mismo: el servidor aborta la transacción tras el duplicado y su
 * commit falla, como en keel-nest y keel-dotnet. MySQL no la aborta por un duplicado, así que ahí no es observable (`[]`: el
 * veredicto lo dice en voz alta en vez de pasar en verde).
 */
export const BATCH_ONE_TX = { postgresql: ['BA-2', 'BA-5'], mongodb: ['BA-2', 'BA-5'], mysql: [] };

/** Lo que tiene que caer con un sabotaje en este diseño y este motor: sus casos que la sonda ejecuta, y solo esos. */
export function batchSabotageVerdict(failures, id, model, engine) {
  const cases = batchCases(model);
  const declared = id === 'ba-one-tx' && BATCH_ONE_TX[engine] ? BATCH_ONE_TX[engine] : BATCH_SABOTAGES[id];
  const want = declared.filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_BA(\d+)_/g)].map((match) => `BA-${match[1]}`)))].sort();
  const unmeasured = want.length === 0 && cases.some((caseId) => BATCH_SABOTAGES[id].includes(caseId));
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want, unmeasured };
}

// ─── El handler de la sonda ──────────────────────────────────────────────────────────────────────

/** El handler de la sonda en el lugar del stub de `importProducts`; el resto de archivos, tal cual. */
export function batchProbePatch(model, file) {
  const operation = batchOperations(model)[0];
  if (!operation || typeof file.content !== 'string' || !/^internal\/application\/import_products_command_handler\.go$/.test(file.path)) return file;
  const product = model.entities.find((entity) => entity.name === 'Product');
  const repo = repositoryParam(product);
  const message = `${goExported(operation.name)}Command`;
  const result = operation.responseDto?.name ?? null;
  const returns = result ? `(${result}, error)` : 'error';
  const fail = (error) => (result ? `return ${result}{}, ${error}` : `return ${error}`);
  return {
    ...file,
    content: goFile({
      pkg: 'application',
      module: model.service.goModule,
      generated: false,
      imports: ['context', 'errors', 'github.com/google/uuid', 'internal/domain'],
      body: `
// ${message}Handler es la sonda de db-check y doc-check: lo que escribiría el agente para UN elemento.
type ${message}Handler struct {
	${repo} domain.ProductRepository
}

// New${message}Handler construye el caso de uso ${operation.name}.
func New${message}Handler(${repo} domain.ProductRepository) *${message}Handler {
	return &${message}Handler{${repo}: ${repo}}
}

// Handle guarda un producto en borrador por elemento. Sin buscar el sku antes: el duplicado lo rechaza la unicidad del
// motor, y el adaptador lo traduce al error declarado.
func (h *${message}Handler) Handle(ctx context.Context, cmd ${message}) ${returns} {
	draft := cmd.Item
	if draft.Name() == ${goString(UNDECLARED_FAILURE_NAME)} {
		${fail('errors.New("sonda: un fallo que el diseño no declara")')}
	}
	id := uuid.Must(uuid.NewV7())
	token := "sonda"
	state := domain.ProductState{ID: id, Sku: draft.Sku(), Name: draft.Name(), Price: draft.Price(), APIToken: &token, Status: domain.ProductStatusDraft}
	if _, err := h.${repo}.Save(ctx, domain.RehydrateProduct(state)); err != nil {
		${fail('err')}
	}
	${result ? `return ${result}{ProductID: &id}, nil` : 'return nil'}
}
`
    })
  };
}

// ─── El archivo de la sonda ──────────────────────────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => goString(JSON.stringify({ items }));

/** `batch_probe_test.go` en el paquete del almacén, o null si el diseño no tiene lotes. */
export function batchProbeFile(model) {
  const operations = batchOperations(model);
  if (operations.length === 0) return null;
  const cases = new Set(batchCases(model));
  const product = model.entities.find((entity) => entity.name === 'Product');
  const base = model.api.routeBase;
  const perItem = operations.find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const tests = [];
  const probe = (id, title, code) => {
    if (!cases.has(id)) return;
    const name = title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join('');
    tests.push(`// TestBatch_${id.replace('-', '')}_${name}: ${id}, ${title}.
func TestBatch_${id.replace('-', '')}_${name}(t *testing.T) {
${code}
}`);
  };
  const envelope = (operation, prefix) => {
    const path = goString(`${base}${operation.route.path}`);
    const many = (operation.batch.maxItems ?? 0) + 1;
    return `	if status, _ := batchPost(t, ${path}, "{}"); status != http.StatusBadRequest {
		t.Fatalf("el campo over ausente es un 400 del lote: %d", status)
	}
	var many []map[string]any
	for n := range ${many} {
		many = append(many, map[string]any{"sku": fmt.Sprintf("${prefix}-%04d", n), "name": "Producto", "price": map[string]any{"amount": "10.00", "currency": "EUR"}})
	}
	if status, _ := batchPost(t, ${path}, string(must(json.Marshal(map[string]any{"items": many})))); status != http.StatusBadRequest {
		t.Fatalf("exceder maxItems es un 400 del lote: %d", status)
	}
	// Un 400 del sobre no procesa ningún elemento: ni el primero, ni el último.
	batchAbsent(t, "${prefix}-0000")
	batchAbsent(t, ${goString(`${prefix}-${String(many - 1).padStart(4, '0')}`)})`;
  };
  if (perItem) {
    const path = goString(`${base}${perItem.route.path}`);
    probe('BA-1', 'sin fallos 207 con todos succeeded y su result en orden', `	status, json := batchPost(t, ${path}, ${body(draft('ZZA-9001'), draft('ZZA-9002'), draft('ZZA-9003'))})
	if status != 207 {
		t.Fatalf("un lote per-item responde 207 también si todo salió bien: %d %v", status, json)
	}
	batchSummary(t, json, 3, 3, 0, 0)
	for index, element := range batchItems(t, json) {
		batchStable(t, element)
		if element["index"] != float64(index) || element["status"] != "succeeded" {
			t.Fatalf("el elemento %d: %v", index, element)
		}
		if result, _ := element["result"].(map[string]any); result == nil || result["productId"] == nil {
			t.Fatalf("el elemento %d sin su result: %v", index, element)
		}
	}`);
    probe('BA-2', 'un error de itemErrors falla solo su elemento', `	batchPost(t, ${path}, ${body(draft('ZZB-9001'))})
	batchPresent(t, "ZZB-9001")
	_, json := batchPost(t, ${path}, ${body(draft('ZZB-9001'), draft('ZZB-9002'))})
	batchSummary(t, json, 2, 1, 1, 0)
	items := batchItems(t, json)
	batchFailedWith(t, items[0], "SKU_ALREADY_EXISTS")
	if items[1]["status"] != "succeeded" {
		t.Fatalf("el siguiente se confirma: %v", items[1])
	}
	batchPresent(t, "ZZB-9002")`);
    probe('BA-3', 'un elemento mal formado es su failed con VALIDATION_ERROR', `	status, json := batchPost(t, ${path}, ${goString(JSON.stringify({ items: [draft('ZZC-9001'), draft('mal'), draft('ZZC-9003', 'x'.repeat(121)), null, draft('ZZC-9005')] }))})
	if status == http.StatusBadRequest {
		t.Fatalf("un elemento mal formado no es un 400 del lote: %v", json)
	}
	batchSummary(t, json, 5, 2, 3, 0)
	items := batchItems(t, json)
	for _, index := range []int{1, 2, 3} {
		batchFailedWith(t, items[index], "VALIDATION_ERROR")
	}
	if message, _ := items[1]["message"].(string); !strings.Contains(message, "sku") {
		t.Fatalf("el mensaje es el de la guarda: %v", items[1])
	}
	batchPresent(t, "ZZC-9005")`);
    probe('BA-4', 'un error no declarado detiene el lote', `	_, json := batchPost(t, ${path}, ${body(draft('ZZD-9001'), draft('ZZD-9002', UNDECLARED_FAILURE_NAME), draft('ZZD-9003'))})
	batchSummary(t, json, 3, 1, 1, 1)
	items := batchItems(t, json)
	batchFailedWith(t, items[1], "BATCH_ABORTED")
	batchStable(t, items[2])
	if items[2]["status"] != "notAttempted" {
		t.Fatalf("lo siguiente sale notAttempted: %v", items[2])
	}
	batchPresent(t, "ZZD-9001")
	batchAbsent(t, "ZZD-9003")`);
    probe('BA-5', 'la misma clave dos veces en el lote falla en el segundo', `	_, json := batchPost(t, ${path}, ${body(draft('ZZE-9001'), draft('ZZE-9001'))})
	items := batchItems(t, json)
	if items[0]["status"] != "succeeded" {
		t.Fatalf("el primero se confirma: %v", items[0])
	}
	batchFailedWith(t, items[1], "SKU_ALREADY_EXISTS")
	batchPresent(t, "ZZE-9001")`);
    probe('BA-7', 'el sobre el campo ausente y exceder maxItems son un 400 del lote', envelope(perItem, 'ZZG'));
  }
  if (atomic) {
    const path = goString(`${base}${atomic.route.path}`);
    probe('BA-6', 'all-or-nothing revierte entero y responde el error del culpable', `	status, json := batchPost(t, ${path}, ${body(draft('ZZF-9001'), draft('ZZF-9002'), draft('ZZF-9001'))})
	if status != http.StatusConflict || json["code"] != "SKU_ALREADY_EXISTS" {
		t.Fatalf("el error del elemento culpable: %d %v", status, json)
	}
	if details, _ := json["details"].([]any); len(details) != 1 || details[0] != "items[2]" {
		t.Fatalf("el índice del culpable en details: %v", json)
	}
	batchAbsent(t, "ZZF-9001")
	batchAbsent(t, "ZZF-9002")
	invalidStatus, invalid := batchPost(t, ${path}, ${body(draft('ZZF-9003'), draft('mal'))})
	if details, _ := invalid["details"].([]any); invalidStatus != http.StatusBadRequest || len(details) != 1 || details[0] != "items[1]" {
		t.Fatalf("un elemento mal formado es el 400 del culpable: %d %v", invalidStatus, invalid)
	}
	batchAbsent(t, "ZZF-9003")
	goodStatus, good := batchPost(t, ${path}, ${body(draft('ZZF-9004'), draft('ZZF-9005'))})
	if goodStatus != ${atomic.route.status} {
		t.Fatalf("sin fallos, el successStatus del endpoint: %d %v", goodStatus, good)
	}
	batchSummary(t, good, 2, 2, 0, 0)`);
    if (!perItem) probe('BA-7', 'el sobre el campo ausente y exceder maxItems son un 400 del lote', envelope(atomic, 'ZZH'));
  }

  const document = model.persistenceKind === 'document';
  const repository = `New${product.name}Repository(${repositoryArgs(model, product, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})`;
  const helpers = `// batchHandler es el servicio como lo cablea el arranque: el http.Handler entero de httpapi, con los casos de uso sobre
// las Transactions de la sonda.
func batchHandler() http.Handler {
	logger := slog.New(slog.DiscardHandler)
	useCases := application.NewUseCases(logger, application.Dependencies{Transactor: probeTx, ${repositoryParam(product)[0].toUpperCase() + repositoryParam(product).slice(1)}: ${repository}})
	return httpapi.NewHandler(&health.Probes{}, useCases, logger)
}

// batchPost manda el cuerpo al lote y devuelve el status y la respuesta leída.
func batchPost(t *testing.T, path, body string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	batchHandler().ServeHTTP(recorder, request)
	var out map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &out); err != nil {
		t.Fatalf("la respuesta no es JSON (%d): %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Code, out
}

// batchFind dice si hay un producto con ese sku.
func batchFind(t *testing.T, sku string) bool {
	t.Helper()
	_, found, err := ${repository}.FindBySku(t.Context(), sku)
	if err != nil {
		t.Fatalf("buscar %s: %v", sku, err)
	}
	return found
}

func batchPresent(t *testing.T, sku string) {
	t.Helper()
	if !batchFind(t, sku) {
		t.Fatalf("%s tendría que estar confirmado", sku)
	}
}

func batchAbsent(t *testing.T, sku string) {
	t.Helper()
	if batchFind(t, sku) {
		t.Fatalf("%s no tendría que estar en la base", sku)
	}
}

// batchItems son los elementos de la respuesta.
func batchItems(t *testing.T, json map[string]any) []map[string]any {
	t.Helper()
	raw, ok := json["items"].([]any)
	if !ok {
		t.Fatalf("sin items: %v", json)
	}
	items := make([]map[string]any, 0, len(raw))
	for _, element := range raw {
		item, _ := element.(map[string]any)
		items = append(items, item)
	}
	return items
}

func batchSummary(t *testing.T, json map[string]any, total, succeeded, failed, notAttempted int) {
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

// batchStable comprueba las cinco claves de un elemento, siempre.
func batchStable(t *testing.T, element map[string]any) {
	t.Helper()
	if len(element) != 5 {
		t.Fatalf("un elemento lleva sus cinco claves: %v", element)
	}
	for _, key := range []string{"index", "status", "result", "error", "message"} {
		if _, ok := element[key]; !ok {
			t.Fatalf("falta %s en %v", key, element)
		}
	}
}

func batchFailedWith(t *testing.T, element map[string]any, code string) {
	t.Helper()
	batchStable(t, element)
	if element["status"] != "failed" || element["error"] != code || element["result"] != nil {
		t.Fatalf("se esperaba failed con %s: %v", code, element)
	}
}`;
  const dir = storeDir(model);
  const imports = ['encoding/json', 'fmt', 'log/slog', 'net/http', 'net/http/httptest', 'strings', 'testing', 'internal/application', 'internal/httpapi', 'internal/platform/health'];
  const content = goFile({
    pkg: dir.split('/').pop(),
    imports,
    body: `// La sonda de los lotes (DSL 2.30) de db-check y doc-check (scripts/lib/batch-probes.js de keel-go): BA-1 a BA-7 por el
// http.Handler emitido, contra un ${document ? 'MongoDB' : 'motor relacional'} real. No es parte del proyecto generado.

${[...tests, helpers].join('\n\n')}
`,
    module: model.service.goModule,
    generated: false
  });
  return { path: `${dir}/batch_probe_test.go`, content };
}
