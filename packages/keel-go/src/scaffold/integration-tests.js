// El arnés de integración del proyecto generado: el paquete `tests/integration`, la base de la que cuelgan las pruebas
// de flujo (`<flujo>_flow_test.go`) que escribe el agente de pruebas a partir de specs/validation-scenarios.md, el humo
// que comprueba la fontanería, `infra/score-scenarios.sh`, que puntúa el XML JUnit, e `infra/check-flows.sh`, el gate
// de compilación del agente de pruebas.
//
// Es el equivalente de AbstractFlowIT + FailureCapture + HarnessSmokeIT de keel-spring, de `useFlow()` de keel-nest y
// de `FlowTest` de keel-dotnet, con las mismas promesas: el servidor REAL escuchando en un puerto libre contra la
// infraestructura de `infra/`, peticiones HTTP de verdad, el reset de estado por flujo con `infra/reset-db.sh`, y la
// evidencia de cada fallo volcada a `build/keel-failures/<FL-id>.json` con el último intercambio y el último sondeo,
// que es lo que lee el árbitro.
//
// Lo que en Go toma otra forma:
//   · **Una función `Test…` por flujo y un subtest por escenario** (PLAN-KEEL-GO.md § 3.7): Go ejecuta los subtests
//     en el orden en que se escriben, así que no hace falta un ordenador como el de xUnit. El título del subtest
//     (`FL-PRD-001-A: …`) es el `name` del XML de gotestsum, con los espacios como `_`, y keel-core/gen/junit-scoring
//     saca el id del último tramo de la ruta.
//   · **Tras la restricción `integration`**: `go test ./...` no ve el paquete (como el proyecto de flujos de keel-dotnet
//     queda fuera de `dotnet test`); lo ejecuta score-scenarios.sh con `-tags integration`.
//   · **Caja negra por comprobación, no por construcción**: dentro del módulo, `internal/` no protege a un paquete de
//     otro. El arnés solo usa la biblioteca estándar y arranca el servidor como PROCESO (`go build ./cmd/server`, el
//     mismo binario que se despliega), y check-flows.sh rechaza un import del propio módulo en las pruebas.
//   · **El escenario es un `*Scenario`** que envuelve el `*testing.T` de su subtest: apunta lo que se afirma con
//     `Errorf`/`Fatalf` para la evidencia, que el `testing` de Go no deja leer después.
//
// Aquí NO se genera ninguna prueba de flujo: eso es derivado del diseño y lo escribe el agente.

import { DATABASES, selectedInfra } from '@keel-system/keel-core/gen/infra-catalog';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK, SCENARIO_DOCUMENT_SCORING, FOREIGN_ROWS_PRINT, specsSealCheck } from '@keel-system/keel-core/gen/junit-scoring';
import { resetDbScript } from '@keel-system/keel-core/gen/infra-scripts';
import { usesApi, usesRelational } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { GO_INFRA } from './infra.js';
import { layout, packageFile } from './render.js';
import { CREDENTIALS_FILE, CREDENTIALS_IMPORTS, closingCredentialExpression, credentialsBody, smokeCredentialsCase } from './identity-harness.js';
import { MESSAGING_HARNESS_FILE, messagingHarnessBody, messagingHarnessImports, messagingSmokeCase, usesMessagingHarness } from './messaging-harness.js';

export const INTEGRATION_RESULTS = 'build/test-results/integration';
export const SCORE_SCENARIOS_SH = 'infra/score-scenarios.sh';
export const CHECK_FLOWS_SH = 'infra/check-flows.sh';
/** La restricción de compilación de las pruebas de flujo. */
export const INTEGRATION_TAG = 'integration';
/** La prueba del humo: el script la ejecuta sola, antes que la suite. */
export const HARNESS_SMOKE_TEST = 'TestHarnessSmoke';

export function generate(model) {
  const dir = layout(model).integration.dir;
  const credentials = credentialsBody(model);
  const messaging = messagingHarnessBody(model);
  return [
    { path: `${dir}/doc.go`, content: docGo(model) },
    { path: `${dir}/flow_test.go`, content: flowTestGo(model) },
    { path: `${dir}/server_test.go`, content: serverTestGo(model) },
    { path: `${dir}/harness_test.go`, content: harnessTestGo(model) },
    { path: `${dir}/failure_capture_test.go`, content: failureCaptureTestGo(model) },
    { path: `${dir}/json_shape_test.go`, content: jsonShapeTestGo(model) },
    { path: `${dir}/harness_smoke_test.go`, content: harnessSmokeTestGo(model) },
    ...(credentials ? [{ path: `${dir}/${CREDENTIALS_FILE}`, content: integrationFile(model, { imports: CREDENTIALS_IMPORTS, body: credentials }) }] : []),
    ...(messaging ? [{ path: `${dir}/${MESSAGING_HARNESS_FILE}`, content: integrationFile(model, { imports: messagingHarnessImports(model), body: messaging }) }] : []),
    { path: SCORE_SCENARIOS_SH, content: scoreScenariosScript(model) },
    { path: CHECK_FLOWS_SH, content: checkFlowsScript(model) }
  ];
}

/** ¿Hay `infra/reset-db.sh`? Las mismas condiciones con las que lo escribe infra-scripts.js. */
export function hasResetScript(model) {
  return resetDbScript(selectedInfra(model), model.service, model, GO_INFRA) !== null;
}

/** La base de prueba como contenedor al que se le pueden mandar sentencias (relacional con CLI). */
export function dbProbe(model) {
  if (!usesRelational(model)) return null;
  const entry = DATABASES[model.stack?.database ?? 'postgresql'];
  if (!entry?.cliQueryArgv || !entry.composeService) return null;
  const dbName = model.service.name.replaceAll('-', '_');
  return {
    container: `${model.service.name}-db`,
    argv: entry.cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName }),
    label: entry.label
  };
}

function integrationFile(model, { imports, body, generated = true }) {
  return packageFile(model, layout(model).integration, { imports, body, generated, build: INTEGRATION_TAG });
}

// ─── doc.go ──────────────────────────────────────────────────────────────────────────────────────

function docGo(model) {
  return packageFile(model, layout(model).integration, {
    build: INTEGRATION_TAG,
    doc: `Package integration ejecuta los escenarios FL-* de specs/validation-scenarios.md contra el servidor REAL —un
proceso aparte, el mismo binario que se despliega, escuchando en un puerto libre bajo el perfil local— y la
infraestructura de infra/docker-compose.yaml.

Va tras la restricción de compilación integration: go test ./... no lo ve, porque sus pruebas necesitan la
infraestructura arriba. Lo ejecuta infra/score-scenarios.sh, y infra/check-flows.sh lo compila sin ella.

Es de caja negra: los escenarios se expresan con HTTP y JSON, que es lo que exige la equivalencia con los servidores de
keel-spring, keel-nest y keel-dotnet del mismo diseño, así que ninguna prueba importa un paquete del servicio.`,
    body: ''
  });
}

// ─── flow_test.go ────────────────────────────────────────────────────────────────────────────────

function flowTestGo(model) {
  const api = usesApi(model);
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const helpers = [];
  if (reset) {
    helpers.push(String.raw`// ResetState deja el estado como recién arrancado: exactamente lo que enumera infra/reset-db.sh. StartFlow ya lo
// llama al empezar cada flujo; llamarlo a mano solo tiene sentido para un escenario que tenga que empezar de cero.
func (s *Scenario) ResetState() {
	s.Helper()
	if err := resetState(s.Context()); err != nil {
		s.Fatal(err)
	}
}`);
  }
  if (probe) {
    helpers.push(String.raw`// Db ejecuta una sentencia contra la base de prueba (${probe.label}) y devuelve su salida en crudo. Es para lo que
// no se ve por HTTP: que una escritura llegó de verdad al almacén, o la precondición de un escenario que ninguna
// operación del diseño puede fabricar. Si el servicio lo expone por su API, se comprueba por ahí.
func (s *Scenario) Db(sql string) string {
	s.Helper()
	out, err := db(s.Context(), sql)
	if err != nil {
		s.Fatal(err)
	}
	return out
}`);
  }
  return integrationFile(model, {
    imports: ['fmt', 'net/http', 'runtime/debug', 'strings', 'sync', 'testing', 'time'],
    body: String.raw`
${api ? `// RouteBase es el prefijo de todas las rutas del servicio (basePath del diseño + versión).
const RouteBase = ${goString(model.api.routeBase)}

` : ''}// Flow es un flujo de specs/validation-scenarios.md: una función Test… por flujo y un subtest por escenario, que Go
// ejecuta en el orden en que están ESCRITOS (dentro de un flujo, un escenario usa lo que dejó el anterior).
//
//	func TestProductCreation(t *testing.T) {
//		f := StartFlow(t, nil)
//		f.Scenario("FL-PRD-001-A: crea el producto", func(s *Scenario) {
//			got := s.Post(RouteBase+"/products", map[string]any{"sku": "A-1"})
//			s.ExpectStatus(got, 201)
//		})
//	}
//
// El título de cada escenario empieza por su id y dos puntos: de ahí sale la matriz de infra/score-scenarios.sh y el
// nombre del volcado de su evidencia.
type Flow struct {
	t       *testing.T
	failure string
}

// StartFlow prepara el flujo t: arranca el servidor (una vez por suite)${reset ? ', deja el estado como recién arrancado con\n// infra/reset-db.sh' : ''} y ejecuta given, el Given común a todo el flujo —lo que necesita antes de su primer
// escenario y ninguna operación del diseño fabrica—, que puede ser nil. Si algo de eso falla, los escenarios del flujo
// salen OMITIDOS y se vuelca build/keel-failures/<Flujo>-init.json: infra/score-scenarios.sh lo lee para decir que el
// arnés —no el servidor— está roto.
func StartFlow(t *testing.T, given func(s *Scenario)) *Flow {
	t.Helper()
	f := &Flow{t: t}
	capture.clear()
	if err := f.prepare(given); err != nil {
		f.failure = err.Error()
		capture.dumpInit(t.Name(), f.failure)
	}
	capture.clear()
	return f
}

func (f *Flow) prepare(given func(s *Scenario)) error {
	if err := server.ensureStarted(f.t.Context()); err != nil {
		return err
	}${reset ? `
	if err := resetState(f.t.Context()); err != nil {
		return err
	}` : ''}${usesMessagingHarness(model) ? `
	// El broker arriba (un flujo anterior pudo dejarlo parado) y el servidor conectado a él.
	if err := prepareBroker(f.t.Context()); err != nil {
		return err
	}` : ''}
	if given == nil {
		return nil
	}
	var messages []string
	passed := f.t.Run("Given", func(t *testing.T) {
		s := &Scenario{T: t}
		defer func() { messages = s.messages }()
		s.run(given)
	})
	if !passed {
		return fmt.Errorf("el Given del flujo falló: %s", strings.Join(messages, "; "))
	}
	return nil
}

// Scenario ejecuta el escenario title (su id delante de los dos puntos: «FL-PRD-001-A: crea el producto») como un
// subtest del flujo. Si el flujo no llegó a arrancar, sale OMITIDO; si falla, deja su evidencia en
// build/keel-failures/<id>.json con el último intercambio HTTP y el último comando.
func (f *Flow) Scenario(title string, body func(s *Scenario)) {
	f.t.Helper()
	f.t.Run(title, func(t *testing.T) {
		if f.failure != "" {
			t.Skipf("el flujo no llegó a arrancar: %s", f.failure)
		}
		s := &Scenario{T: t}
		capture.clear()
		defer func() {
			if t.Failed() {
				capture.dumpFailure(title, f.t.Name(), s.messages)
			}
			capture.clear()
		}()
		s.run(body)
	})
}

// Scenario es un escenario en curso: el *testing.T de su subtest, que apunta lo que el escenario afirma para la
// evidencia, con los ayudantes del arnés.
type Scenario struct {
	*testing.T
	messages []string
}

// run ejecuta body y convierte un pánico en un fallo del escenario: sin esto, uno solo tumbaría la suite entera y
// dejaría el servidor sin parar.
func (s *Scenario) run(body func(s *Scenario)) {
	defer func() {
		if r := recover(); r != nil {
			s.Errorf("pánico: %v\n%s", r, debug.Stack())
		}
	}()
	body(s)
}

// Error marca el escenario en rojo y apunta el motivo para la evidencia.
func (s *Scenario) Error(args ...any) {
	s.Helper()
	message := strings.TrimSuffix(fmt.Sprintln(args...), "\n")
	s.messages = append(s.messages, message)
	s.T.Error(message)
}

// Errorf marca el escenario en rojo y apunta el motivo para la evidencia.
func (s *Scenario) Errorf(format string, args ...any) {
	s.Helper()
	message := fmt.Sprintf(format, args...)
	s.messages = append(s.messages, message)
	s.T.Error(message)
}

// Fatal marca el escenario en rojo, apunta el motivo para la evidencia y lo termina.
func (s *Scenario) Fatal(args ...any) {
	s.Helper()
	message := strings.TrimSuffix(fmt.Sprintln(args...), "\n")
	s.messages = append(s.messages, message)
	s.T.Fatal(message)
}

// Fatalf marca el escenario en rojo, apunta el motivo para la evidencia y lo termina.
func (s *Scenario) Fatalf(format string, args ...any) {
	s.Helper()
	message := fmt.Sprintf(format, args...)
	s.messages = append(s.messages, message)
	s.T.Fatal(message)
}

// BaseURL es la URL del servidor arrancado (http://127.0.0.1:<puerto>).
func (s *Scenario) BaseURL() string {
	return server.url()
}

// Get pide path al servidor del flujo, con las cabeceras de headers si las hay (todas juntas): s.Get(ruta) o
// s.Get(ruta, Bearer(s.TokenFor("rol"))).
func (s *Scenario) Get(path string, headers ...http.Header) *Response {
	s.Helper()
	return s.Exchange(http.MethodGet, path, nil, joinHeaders(headers))
}

// Post manda body a path: el JSON ya escrito (string o []byte), tal cual viaja, o un valor que se serializa. Las
// cabeceras, como en Get.
func (s *Scenario) Post(path string, body any, headers ...http.Header) *Response {
	s.Helper()
	return s.Exchange(http.MethodPost, path, body, joinHeaders(headers))
}

// Put manda body a path, como Post.
func (s *Scenario) Put(path string, body any, headers ...http.Header) *Response {
	s.Helper()
	return s.Exchange(http.MethodPut, path, body, joinHeaders(headers))
}

// Patch manda body a path, como Post.
func (s *Scenario) Patch(path string, body any, headers ...http.Header) *Response {
	s.Helper()
	return s.Exchange(http.MethodPatch, path, body, joinHeaders(headers))
}

// Delete borra path, con las cabeceras como en Get.
func (s *Scenario) Delete(path string, headers ...http.Header) *Response {
	s.Helper()
	return s.Exchange(http.MethodDelete, path, nil, joinHeaders(headers))
}

// joinHeaders junta en una las cabeceras de headers; sin ninguna, nil.
func joinHeaders(headers []http.Header) http.Header {
	if len(headers) == 0 {
		return nil
	}
	joined := http.Header{}
	for _, header := range headers {
		for name, values := range header {
			joined[http.CanonicalHeaderKey(name)] = append(joined[http.CanonicalHeaderKey(name)], values...)
		}
	}
	return joined
}

// Exchange es una petición HTTP de verdad al servidor del flujo, con las cabeceras de headers (puede ser nil). Nunca
// falla por un 4xx o un 5xx: el status es una aserción del escenario.
func (s *Scenario) Exchange(method, path string, body any, headers http.Header) *Response {
	s.Helper()
	got, err := send(s.Context(), server.url(), method, path, body, headers)
	if err != nil {
		s.Fatalf("%s %s: %v", method, path, err)
	}
	return got
}

// Request es una petición de ExchangeAll: la de Exchange, como valor.
type Request struct {
	Method  string
	Path    string
	Body    any
	Headers http.Header
}

// ExchangeAll lanza requests A LA VEZ —ninguna espera a otra— y devuelve sus respuestas en el mismo orden. Es la forma
// de escribir un escenario de carrera (dos altas con la misma clave de idempotencia). Si alguna no llega, el escenario
// termina aquí, en su goroutine: un Fatal o un pánico desde la goroutine de una petición no lo pararía, y el
// segundo tumbaría la suite entera.
func (s *Scenario) ExchangeAll(requests ...Request) []*Response {
	s.Helper()
	baseURL := server.url()
	responses := make([]*Response, len(requests))
	errs := make([]error, len(requests))
	var wg sync.WaitGroup
	for i, request := range requests {
		wg.Go(func() {
			responses[i], errs[i] = send(s.Context(), baseURL, request.Method, request.Path, request.Body, request.Headers)
		})
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			s.Fatalf("%s %s: %v", requests[i].Method, requests[i].Path, err)
		}
	}
	return responses
}

// ExpectStatus marca el escenario en rojo si got no trae el status want, con el cuerpo en el motivo.
func (s *Scenario) ExpectStatus(got *Response, want int) {
	s.Helper()
	if got.Status != want {
		s.Errorf("status = %d, quiero %d; cuerpo: %s", got.Status, want, got.Body)
	}
}

// AssertJSON compara el cuerpo de got con el JSON expected, ESTRICTO: las mismas claves (ni una de más ni de menos),
// los números por su texto exacto (2.50 no es 2.5: la escala es contrato) y las listas en orden. Un valor "<uuid>",
// "<instant>" o "<any>" afirma solo la forma de lo que genera el servidor.
func (s *Scenario) AssertJSON(expected string, got *Response) {
	s.Helper()
	if problems := jsonMismatches(expected, got.Body); len(problems) > 0 {
		s.Errorf("el JSON no casa con el esperado:\n  %s\nrecibido: %s", strings.Join(problems, "\n  "), got.Body)
	}
}

// Eventually espera a que condition se cumpla, mirando cada 200 ms, o falla el escenario con message cuando pasa
// timeout (cero: 10 s).
func (s *Scenario) Eventually(condition func() bool, timeout time.Duration, message string) {
	s.Helper()
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for !condition() {
		select {
		case <-deadline.C:
			s.Fatalf("%s (tras %s)", message, timeout)
		case <-s.Context().Done():
			s.Fatalf("%s: la prueba terminó antes", message)
		case <-tick.C:
		}
	}
}

// Command ejecuta name con args desde la raíz del proyecto —los argumentos siempre como lista, nunca armados para un
// shell— y devuelve su salida; falla el escenario con sus últimas líneas si sale mal.
func (s *Scenario) Command(name string, args ...string) string {
	s.Helper()
	out, err := runCommand(s.Context(), name, args, "", "")
	if err != nil {
		s.Fatal(err)
	}
	return out
}
${helpers.length > 0 ? `\n${helpers.join('\n\n')}\n` : ''}`
  });
}

// ─── server_test.go ──────────────────────────────────────────────────────────────────────────────

function serverTestGo(model) {
  return integrationFile(model, {
    imports: ['context', 'fmt', 'net', 'net/http', 'os', 'os/exec', 'path/filepath', 'runtime', 'strconv', 'strings', 'sync', 'testing', 'time'],
    body: String.raw`
// startTimeout es lo que espera el arnés a que el servidor responda /livez.
const startTimeout = 90 * time.Second

// flowServer es el servidor del servicio, arrancado UNA vez por suite como un proceso aparte: el mismo binario que se
// despliega (./cmd/server, compilado a build/keel-scenarios/), bajo el perfil local (o el de PROFILE), escuchando en
// 127.0.0.1 en un puerto libre. Su salida va a build/keel-scenarios/server.log: es la evidencia de un arranque que no
// llega o de un 500.
type flowServer struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	exited  chan struct{}
	log     *os.File
	baseURL string
	failure error
}

var server flowServer

// TestMain para el servidor al terminar la suite: un proceso que sobreviviera seguiría escuchando y escribiendo en la
// base de prueba.
func TestMain(m *testing.M) {
	code := m.Run()
	server.stop()
	os.Exit(code)
}

func (fs *flowServer) url() string {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.baseURL
}

func (fs *flowServer) ensureStarted(ctx context.Context) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if fs.failure != nil {
		return fs.failure
	}
	if fs.cmd != nil {
		select {
		case <-fs.exited:
			fs.failure = fmt.Errorf("el servidor terminó a mitad de la suite (código %d). Log: %s\n%s", fs.cmd.ProcessState.ExitCode(), fs.log.Name(), logTail(fs.log.Name(), 20))
			return fs.failure
		default:
			return nil
		}
	}
	if err := fs.start(ctx); err != nil {
		fs.failure = err
		fs.stopLocked()
		return err
	}
	return nil
}

// start compila el servidor (la caché de go build lo hace casi gratis si no cambió) y lo lanza. El proceso no
// cuelga del contexto de la prueba: vive toda la suite, y lo para TestMain.
func (fs *flowServer) start(ctx context.Context) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	dir := filepath.Join(root, "build", "keel-scenarios")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("crear %s: %w", dir, err)
	}
	binary := filepath.Join(dir, "server")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if _, err := runCommand(ctx, "go", []string{"build", "-o", binary, "./cmd/server"}, "El servidor no compila.", ""); err != nil {
		return err
	}
	port, err := freePort()
	if err != nil {
		return err
	}
	log, err := os.Create(filepath.Join(dir, "server.log"))
	if err != nil {
		return fmt.Errorf("crear el log del servidor: %w", err)
	}
	profile := os.Getenv("PROFILE")
	if profile == "" {
		profile = "local"
	}
	cmd := exec.Command(binary)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PROFILE="+profile, "SERVER_PORT="+strconv.Itoa(port), "SERVER_ADDRESS=127.0.0.1")
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		_ = log.Close() // El error que importa es el del arranque.
		return fmt.Errorf("lanzar el servidor: %w", err)
	}
	exited := make(chan struct{})
	go func() {
		// El código de salida lo lee ensureStarted de cmd.ProcessState, después de que se cierre exited.
		_ = cmd.Wait()
		close(exited)
	}()
	fs.cmd, fs.exited, fs.log = cmd, exited, log
	fs.baseURL = "http://127.0.0.1:" + strconv.Itoa(port)
	return waitLive(ctx, fs.baseURL, exited, log.Name())
}

// waitLive espera a que baseURL responda /livez, o falla con el final del log del servidor.
func waitLive(ctx context.Context, baseURL string, exited <-chan struct{}, logPath string) error {
	probe := &http.Client{Timeout: 5 * time.Second}
	deadline := time.NewTimer(startTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for !live(ctx, probe, baseURL) {
		select {
		case <-exited:
			return fmt.Errorf("el servidor no arrancó (terminó). Log: %s\n%s", logPath, logTail(logPath, 20))
		case <-deadline.C:
			return fmt.Errorf("el servidor no respondió /livez en %s. Log: %s\n%s", startTimeout, logPath, logTail(logPath, 20))
		case <-ctx.Done():
			return fmt.Errorf("esperar al servidor: %w", ctx.Err())
		case <-tick.C:
		}
	}
	return nil
}

func live(ctx context.Context, client *http.Client, baseURL string) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/livez", nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func (fs *flowServer) stop() {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.stopLocked()
}

func (fs *flowServer) stopLocked() {
	if fs.cmd != nil {
		select {
		case <-fs.exited:
		default:
			_ = fs.cmd.Process.Kill() // Si ya había terminado, Wait lo dice igual.
			<-fs.exited
		}
	}
	if fs.log != nil {
		_ = fs.log.Close() // Solo es el log: lo escrito ya está en el archivo.
	}
}

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("buscar un puerto libre: %w", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

// logTail son las últimas lines líneas de path, para el motivo de un arranque que falla.
func logTail(path string, lines int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "(sin log)"
	}
	all := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	return strings.Join(all[max(0, len(all)-lines):], "\n")
}
`
  });
}

// ─── harness_test.go ─────────────────────────────────────────────────────────────────────────────

function harnessTestGo(model) {
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const sections = [];
  if (reset) {
    sections.push(String.raw`// resetState deja el estado como recién arrancado con infra/reset-db.sh.
func resetState(ctx context.Context) error {
	_, err := runCommand(ctx, bashExecutable(), []string{"infra/reset-db.sh"}, "¿Está la infraestructura arriba (bash infra/up.sh)?", "")
	return err
}

// bashExecutable es el bash con el que se invocan los scripts de infra/. En Windows, bash a secas puede resolver al
// lanzador de WSL (System32 va antes que el PATH), un Linux aislado que no ve el PATH ni las variables de Windows: se
// busca el de Git for Windows, con override por BASH_EXECUTABLE.
func bashExecutable() string {
	if configured := os.Getenv("BASH_EXECUTABLE"); configured != "" {
		return configured
	}
	if runtime.GOOS == "windows" {
		bases := []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")}
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			bases = append(bases, filepath.Join(local, "Programs"))
		}
		for _, base := range bases {
			if base == "" {
				continue
			}
			candidate := filepath.Join(base, "Git", "bin", "bash.exe")
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	return "bash"
}`);
  }
  if (probe) {
    sections.push(String.raw`// dbContainer es el contenedor de la base de prueba (${probe.label}).
const dbContainer = ${goString(probe.container)}

// dbQueryArgs es la invocación de su cliente sin la sentencia.
var dbQueryArgs = []string{${probe.argv.map(goString).join(', ')}}

// db ejecuta sql en la base de prueba: la sentencia viaja como UN argumento más, nunca armada para un shell.
func db(ctx context.Context, sql string) (string, error) {
	args := slices.Concat([]string{"exec", dbContainer}, dbQueryArgs, []string{sql})
	return runCommand(ctx, containerRuntime(), args, "¿Está la base arriba (bash infra/up.sh)?", "")
}`);
  }
  if (probe || usesMessagingHarness(model)) {
    sections.push(String.raw`// containerRuntime es el runtime de contenedores: CONTAINER_RUNTIME, o docker si está, o podman.
func containerRuntime() string {
	if configured := os.Getenv("CONTAINER_RUNTIME"); configured != "" {
		return configured
	}
	if _, err := exec.LookPath("docker"); err == nil {
		return "docker"
	}
	return "podman"
}`);
  }
  return integrationFile(model, {
    imports: ['bytes', 'context', 'encoding/json', 'errors', 'fmt', 'io', 'net/http', 'os', 'os/exec', 'path/filepath', 'runtime', 'slices', 'strings', 'sync', 'time'],
    body: String.raw`
// Response es un intercambio HTTP completo: lo que el escenario afirma.
type Response struct {
	Status int
	Header http.Header
	Body   string
}

// String resume la respuesta para el motivo de una aserción.
func (r *Response) String() string {
	return fmt.Sprintf("%d %s", r.Status, r.Body)
}

// JSON lee el cuerpo como JSON, con cada número como su TEXTO (json.Number): para afirmar la escala de un decimal,
// "2.50" no es "2.5".
func (r *Response) JSON() (any, error) {
	value, err := decodeJSON(r.Body)
	if err != nil {
		return nil, fmt.Errorf("la respuesta no es JSON (status %d): %w", r.Status, err)
	}
	return value, nil
}

// httpClient es el cliente de las peticiones de los escenarios, con su plazo: nunca http.DefaultClient.
var httpClient = &http.Client{Timeout: 30 * time.Second}

// projectRoot es la raíz del proyecto (donde está go.mod): todo lo de infra/ y build/ cuelga de ahí.
var projectRoot = sync.OnceValues(func() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("leer el directorio de trabajo: %w", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("no se encontró la raíz del proyecto (go.mod) por encima del directorio de trabajo")
		}
		dir = parent
	}
})

// send hace una petición a baseURL y apunta el intercambio para la evidencia.
func send(ctx context.Context, baseURL, method, path string, body any, headers http.Header) (*Response, error) {
	if baseURL == "" {
		return nil, errors.New("el servidor no está arrancado: la prueba de flujo empieza con StartFlow")
	}
	payload, err := encodeBody(body)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, reader)
	if err != nil {
		return nil, fmt.Errorf("armar la petición: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range headers {
		request.Header[http.CanonicalHeaderKey(name)] = values
	}
	sent := requestReport{Method: method, Path: path, Headers: flatten(request.Header, false)}
	if payload != nil {
		text := string(payload)
		sent.Body = &text
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("la petición no llegó: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("leer la respuesta: %w", err)
	}
	got := &Response{Status: response.StatusCode, Header: response.Header, Body: string(data)}
	capture.recordExchange(sent, responseReport{Status: got.Status, Headers: flatten(response.Header, true), Body: got.Body})
	return got, nil
}

// encodeBody es el cuerpo tal cual viaja: el JSON ya escrito, o el valor serializado.
func encodeBody(body any) ([]byte, error) {
	switch value := body.(type) {
	case nil:
		return nil, nil
	case string:
		return []byte(value), nil
	case []byte:
		return value, nil
	default:
		data, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("serializar el cuerpo: %w", err)
		}
		return data, nil
	}
}

// flatten es una cabecera por nombre, con sus valores separados por comas; en minúsculas con lower.
func flatten(header http.Header, lower bool) map[string]string {
	flat := make(map[string]string, len(header))
	for name, values := range header {
		if lower {
			name = strings.ToLower(name)
		}
		flat[name] = strings.Join(values, ", ")
	}
	return flat
}

// runCommand ejecuta name con args desde la raíz del proyecto, con input en la entrada estándar si no está vacío, y
// apunta el sondeo para la evidencia. Si sale mal, el error lleva hint y sus últimas líneas.
func runCommand(ctx context.Context, name string, args []string, hint, input string) (string, error) {
	root, err := projectRoot()
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = root
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	line := strings.Join(append([]string{name}, args...), " ")
	output := stdout.String() + stderr.String()
	var exitCode *int
	if cmd.ProcessState != nil {
		code := cmd.ProcessState.ExitCode()
		exitCode = &code
	}
	capture.recordProbe(probeReport{Command: line, ExitCode: exitCode, Output: output})
	if runErr != nil {
		tail := strings.TrimSpace(output)
		if tail == "" {
			tail = "(no escribió nada)"
		} else {
			lines := strings.Split(tail, "\n")
			tail = strings.Join(lines[max(0, len(lines)-12):], "\n")
		}
		return "", fmt.Errorf("%s falló: %w. %s\n%s", line, runErr, hint, tail)
	}
	return stdout.String(), nil
}
${sections.length > 0 ? `\n${sections.join('\n\n')}\n` : ''}`
  });
}

// ─── failure_capture_test.go ─────────────────────────────────────────────────────────────────────

// Con las etiquetas de los structs: plantilla normal (String.raw dejaría la barra de cada `\``).
function failureCaptureTestGo(model) {
  return integrationFile(model, {
    imports: ['encoding/json', 'fmt', 'os', 'path/filepath', 'strings', 'sync'],
    body: `
// requestReport es la petición tal como viajó.
type requestReport struct {
	Method  string            \`json:"method"\`
	Path    string            \`json:"path"\`
	Headers map[string]string \`json:"headers"\`
	Body    *string           \`json:"body"\`
}

// responseReport es la respuesta tal como llegó.
type responseReport struct {
	Status  int               \`json:"status"\`
	Headers map[string]string \`json:"headers"\`
	Body    string            \`json:"body"\`
}

// probeReport es un comando que no es HTTP (la base, el reset): lo que se ejecutó, cómo salió y qué escribió.
type probeReport struct {
	Command  string \`json:"command"\`
	ExitCode *int   \`json:"exitCode"\`
	Output   string \`json:"output"\`
}

// failureReport es la evidencia de un fallo, con el formato de la de keel-spring, keel-nest y keel-dotnet.
type failureReport struct {
	Scenario    string          \`json:"scenario"\`
	DisplayName string          \`json:"displayName"\`
	TestClass   string          \`json:"testClass"\`
	Phase       string          \`json:"phase,omitempty"\`
	Assertion   string          \`json:"assertion"\`
	Request     *requestReport  \`json:"request,omitempty"\`
	Response    *responseReport \`json:"response,omitempty"\`
	Probe       *probeReport    \`json:"probe,omitempty"\`
}

// failureCapture guarda el último intercambio y el último sondeo, y los vuelca a build/keel-failures/<escenario>.json
// cuando un escenario falla: es lo que lee el árbitro junto al XML para decidir culprit: code | test | design. Los
// flujos corren en serie, así que basta con lo último; el cerrojo es para las peticiones a la vez de ExchangeAll.
type failureCapture struct {
	mu       sync.Mutex
	request  *requestReport
	response *responseReport
	probe    *probeReport
}

var capture failureCapture

func (c *failureCapture) recordExchange(request requestReport, response responseReport) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.request, c.response = &request, &response
}

func (c *failureCapture) recordProbe(probe probeReport) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.probe = &probe
}

func (c *failureCapture) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.request, c.response, c.probe = nil, nil, nil
}

// dumpFailure vuelca el fallo de un escenario: su id es lo que va delante de los dos puntos de su título.
func (c *failureCapture) dumpFailure(title, flow string, messages []string) {
	scenario, _, _ := strings.Cut(title, ":")
	c.dump(failureReport{Scenario: strings.TrimSpace(scenario), DisplayName: title, TestClass: flow, Assertion: strings.Join(messages, "\\n")})
}

// dumpInit vuelca un flujo que no llegó a arrancar: <Flujo>-init.json.
func (c *failureCapture) dumpInit(flow, failure string) {
	c.dump(failureReport{Scenario: flow + "-init", DisplayName: flow, TestClass: flow, Phase: "init", Assertion: failure})
}

func (c *failureCapture) dump(report failureReport) {
	c.mu.Lock()
	report.Request, report.Response, report.Probe = c.request, c.response, c.probe
	c.mu.Unlock()
	c.clear()
	if err := writeReport(report); err != nil {
		fmt.Fprintf(os.Stderr, "no se pudo volcar la evidencia de %s: %v\\n", report.Scenario, err)
	}
}

func writeReport(report failureReport) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	dir := filepath.Join(root, "build", "keel-failures")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("crear %s: %w", dir, err)
	}
	var out strings.Builder
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		return fmt.Errorf("serializar la evidencia: %w", err)
	}
	return os.WriteFile(filepath.Join(dir, fileName(report.Scenario)+".json"), []byte(out.String()), 0o644)
}

// fileName deja en el nombre del volcado solo letras y dígitos ASCII, '_', '.' y '-'.
func fileName(scenario string) string {
	name := strings.Map(func(r rune) rune {
		if r < 128 && (r == '_' || r == '.' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return r
		}
		return '_'
	}, scenario)
	if name == "" {
		return "unnamed"
	}
	return name
}
`
  });
}

// ─── json_shape_test.go ──────────────────────────────────────────────────────────────────────────

function jsonShapeTestGo(model) {
  return integrationFile(model, {
    imports: ['encoding/json', 'errors', 'fmt', 'io', 'maps', 'regexp', 'slices', 'strings'],
    body: String.raw`
// Las formas que afirman los comodines: un uuid en minúsculas y el instante del contrato del cable (UTC, tres
// decimales y Z).
var (
	uuidShape    = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
	instantShape = regexp.MustCompile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$")
)

// jsonMismatches compara actual con expected, el toStrictEqual de keel-nest: las mismas claves, los números por su
// TEXTO, las listas en orden y tres comodines de forma. Devuelve un problema por línea, vacío si casan.
func jsonMismatches(expected, actual string) []string {
	want, err := decodeJSON(expected)
	if err != nil {
		return []string{fmt.Sprintf("el JSON esperado no es JSON: %v", err)}
	}
	got, err := decodeJSON(actual)
	if err != nil {
		return []string{fmt.Sprintf("la respuesta no es JSON: %v", err)}
	}
	var problems []string
	compareJSON(want, got, "$", &problems)
	return problems
}

// decodeJSON lee un documento JSON entero, con cada número como su texto (json.Number).
func decodeJSON(text string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("sobra algo detrás del documento")
	}
	return value, nil
}

func compareJSON(want, got any, path string, problems *[]string) {
	if shape, ok := want.(string); ok && (shape == "<uuid>" || shape == "<instant>" || shape == "<any>") {
		if shape == "<any>" {
			return
		}
		pattern := uuidShape
		if shape == "<instant>" {
			pattern = instantShape
		}
		if text, isText := got.(string); !isText || !pattern.MatchString(text) {
			*problems = append(*problems, fmt.Sprintf("%s: se esperaba la forma %s y llegó %s", path, shape, render(got)))
		}
		return
	}
	switch expected := want.(type) {
	case map[string]any:
		actual, ok := got.(map[string]any)
		if !ok {
			*problems = append(*problems, fmt.Sprintf("%s: se esperaba %s y llegó %s", path, render(want), render(got)))
			return
		}
		for _, name := range slices.Sorted(maps.Keys(actual)) {
			if _, declared := expected[name]; !declared {
				*problems = append(*problems, fmt.Sprintf("%s.%s: sobra (llegó %s)", path, name, render(actual[name])))
			}
		}
		for _, name := range slices.Sorted(maps.Keys(expected)) {
			value, present := actual[name]
			if !present {
				*problems = append(*problems, fmt.Sprintf("%s.%s: falta", path, name))
				continue
			}
			compareJSON(expected[name], value, path+"."+name, problems)
		}
	case []any:
		actual, ok := got.([]any)
		if !ok {
			*problems = append(*problems, fmt.Sprintf("%s: se esperaba %s y llegó %s", path, render(want), render(got)))
			return
		}
		if len(expected) != len(actual) {
			*problems = append(*problems, fmt.Sprintf("%s: se esperaban %d elemento(s) y llegaron %d", path, len(expected), len(actual)))
		}
		for i := range min(len(expected), len(actual)) {
			compareJSON(expected[i], actual[i], fmt.Sprintf("%s[%d]", path, i), problems)
		}
	default:
		// Números por su texto exacto (json.Number: 2.50 no es 2.5), cadenas por su valor DECODIFICADO (el escape no
		// es contrato), y booleanos y null por su valor. Un número nunca es igual a una cadena: son tipos distintos.
		if want != got {
			*problems = append(*problems, fmt.Sprintf("%s: se esperaba %s y llegó %s", path, render(want), render(got)))
		}
	}
}

// render es un valor como JSON, para el motivo.
func render(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(data)
}
`
  });
}

// ─── harness_smoke_test.go ───────────────────────────────────────────────────────────────────────

function harnessSmokeTestGo(model) {
  const api = usesApi(model);
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const cases = [];
  if (reset) {
    cases.push(String.raw`	f.Scenario("SMOKE-1: el reset de estado se ejecuta sin error", func(s *Scenario) {
		// Sin él, ningún flujo arranca con el Given que declara.
		s.ResetState()
	})`);
  }
  cases.push(String.raw`	f.Scenario("SMOKE-2: el servidor responde", func(s *Scenario) {
		s.ExpectStatus(s.Get("/livez"), http.StatusOK)
	})`);
  if (probe) {
    cases.push(String.raw`	f.Scenario("SMOKE-3: la base de prueba responde a una sentencia", func(s *Scenario) {
		// Es la vía de los Then que miran el almacén: si no responde, fallarían por la fontanería.
		if got := strings.TrimSpace(s.Db("SELECT 1")); got != "1" {
			s.Errorf("SELECT 1 = %q, quiero \"1\"", got)
		}
	})`);
  }
  if (api) {
    // Con seguridad, con la credencial que satisface la regla de cierre: sin ella, un camino que no existe es 401 (se
    // decide antes de enrutar) y el humo mediría la autorización, no la API.
    const credential = closingCredentialExpression(model);
    const headers = credential ? `${credential}, http.Header{"X-Correlation-Id": {"keel-smoke"}}` : 'http.Header{"X-Correlation-Id": {"keel-smoke"}}';
    cases.push(String.raw`	f.Scenario("SMOKE-4: la API responde con ErrorResponse y correlación", func(s *Scenario) {
		got := s.Get(RouteBase+"/keel-smoke-ruta-inexistente", ${headers})
		s.ExpectStatus(got, http.StatusNotFound)
		body, err := got.JSON()
		if err != nil {
			s.Fatal(err)
		}
		if object, ok := body.(map[string]any); !ok || object["status"] != json.Number("404") {
			s.Errorf("el cuerpo no es un ErrorResponse con status 404: %s", got.Body)
		}
		if correlation := got.Header.Get("X-Correlation-Id"); correlation != "keel-smoke" {
			s.Errorf("X-Correlation-Id = %q, quiero el de la petición", correlation)
		}
	})`);
  }
  const identity = smokeCredentialsCase(model);
  if (identity) cases.push(identity);
  const broker = messagingSmokeCase(model);
  if (broker) cases.push(broker);
  const plumbing = [reset ? 'reset' : null, probe ? 'base de prueba' : null, api ? 'API' : null, identity ? 'proveedor de identidad' : null, broker ? 'broker' : null].filter(Boolean);
  return integrationFile(model, {
    imports: ['encoding/json', 'net/http', 'strings', 'testing'],
    body: String.raw`
// ${HARNESS_SMOKE_TEST} es el humo del arnés: la fontanería de la que dependen TODOS los flujos (servidor vivo${plumbing.length > 0 ? `, ${plumbing.join(', ')}` : ''}).
// infra/score-scenarios.sh lo ejecuta ANTES que la suite: correrla sobre una fontanería rota produce decenas de fallos
// que parecen de negocio y no lo son.
func ${HARNESS_SMOKE_TEST}(t *testing.T) {
	f := StartFlow(t, nil)
${cases.join('\n')}
}
`
  });
}

// ─── infra/score-scenarios.sh ────────────────────────────────────────────────────────────────────
//
// Puntuación MECÁNICA de la matriz de escenarios: «FL-x → OK | FALLO | NO_EJERCITADO» sale del XML de JUnit, sin
// criterio de por medio. Mismo contrato de salida y de códigos que el de keel-spring, keel-nest y keel-dotnet, para que
// el orquestador sea el mismo: la causa de un rojo llega por stdout y la salida de go test va entera a un log.

function scoreScenariosScript(model) {
  const pkg = `./${layout(model).integration.dir}/`;
  return `#!/usr/bin/env bash
# score-scenarios.sh — compila el servicio y las pruebas de flujo de ${model.service.name},
# las ejecuta y puntúa los escenarios FL-* contra specs/validation-scenarios.md.
#
# La matriz sale del XML JUnit que escribe gotestsum, sin criterio de por medio: cada flujo es
# una función Test… y cada escenario un subtest cuyo título (f.Scenario("FL-PRD-001-A: …"))
# lleva el id delante de los dos puntos. Arbitrar de quién es la culpa de un fallo NO es
# trabajo de este script — para eso está el agente de validación, que se invoca solo si aquí
# sale algo en rojo.
#
# Uso (desde la raíz del proyecto, con la infraestructura arriba):
#   bash infra/score-scenarios.sh           # compila + humo del arnés + suite + matriz
#   bash infra/score-scenarios.sh --score   # solo re-puntúa el XML ya existente
#
# Salida: la matriz por stdout (la de go test va al log). Código de salida:
#   0  todos los escenarios en OK
#   1  hay FALLO o NO_EJERCITADO → hay algo que arbitrar
#   2  precondición o arnés roto Y NADA QUE ARBITRAR: el servicio o las pruebas no compilan,
#      la suite no se ejecutó, o un flujo no llegó a arrancar sin dejar ni un FL-* en FALLO.
#      Si además hay escenarios en FALLO, sale 1: esos se arbitran.
#   (3, entorno bloqueado, es del script de keel-spring: go test no deja workers que sostengan
#   el directorio de resultados entre corridas.)
set -u

RESULTS="${INTEGRATION_RESULTS}"
LOG_DIR="build/keel-scenarios"
LOG="$LOG_DIR/run.log"
EVIDENCE="build/keel-failures"
SCENARIOS="specs/validation-scenarios.md"
FLOWS="${pkg}"

if [ ! -f go.mod ] || [ ! -d "$FLOWS" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró go.mod o $FLOWS)." >&2
  exit 2
fi
mkdir -p "$LOG_DIR"

# La evidencia de la corrida ANTERIOR se borra antes de empezar: un volcado que sobrevive a
# una corrida verde se lee igual que uno recién escrito, y engaña.
rm -rf "$EVIDENCE"

${specsSealCheck('keel-go')}

score_only=0
[ "\${1:-}" = "--score" ] && score_only=1
suite_failed=0

# Las pruebas de flujo con su reporte JUnit: gotestsum (la herramienta del go.mod) sobre go test,
# con la restricción ${INTEGRATION_TAG}, sin la caché de resultados (-count=1: el estado está fuera
# del proceso) y con el nombre corto del paquete como classname.
flows() {
  local report="$1"
  shift
  mkdir -p "$RESULTS"
  go tool gotestsum --format standard-verbose --junitfile "$RESULTS/$report" \\
    --junitfile-testcase-classname short -- \\
    -tags ${INTEGRATION_TAG} -count=1 -timeout 30m "$@" "$FLOWS"
}

if [ "$score_only" -eq 0 ]; then
  # Re-puntuar (--score) solo lee XML; compilar y ejecutar sí necesita Go.
  if ! command -v go >/dev/null 2>&1; then
    echo "No está Go en el PATH: instálalo (go.mod dice qué toolchain)." >&2
    exit 2
  fi
  rm -rf "$RESULTS"
  echo "Compilando el servicio y las pruebas de flujo…"
  # Las pruebas se compilan sin ejecutar ninguna (-run '^$'): un flujo que no compila es un
  # BUILD KO, no un arnés roto.
  if ! { go build ./... && go test -tags ${INTEGRATION_TAG} -count=1 -run '^$' "$FLOWS"; } >"$LOG" 2>&1; then
    echo ""
    echo "BUILD: KO — el servicio o las pruebas de flujo no compilan; la suite NO se ejecutó."
    grep -E '\\.go:[0-9]+(:[0-9]+)?: ' "$LOG" | sed 's/^/  /' | sort -u | head -20
    echo "  log: $LOG"
    exit 2
  fi
  # Humo del arnés primero: son segundos y comprueba la fontanería de la que dependen
  # TODOS los flujos. En rojo no se ejecuta la suite.
  echo "Humo del arnés (${HARNESS_SMOKE_TEST})…"
  if ! flows smoke.xml -run '^${HARNESS_SMOKE_TEST}$' >>"$LOG" 2>&1 \\
     || grep -qE '<(failure|error|skipped)[ />]' "$RESULTS/smoke.xml" 2>/dev/null; then
    echo ""
    echo "HARNESS: KO — la suite NO se ejecutó."
    echo "  El defecto está en el andamiaje que generó build (${pkg}, sus archivos"
    echo "  con la cabecera de código generado) o falta infraestructura (bash infra/up.sh && bash infra/validate-infra.sh)."
    if ls "$EVIDENCE"/*.json >/dev/null 2>&1; then
      echo "  evidencia: $EVIDENCE/"
    fi
    echo "  log del servidor: build/keel-scenarios/server.log"
    echo "  log: $LOG"
    exit 2
  fi
  echo "Humo del arnés: OK."
  rm -rf "$EVIDENCE" "$RESULTS"
  echo "Ejecutando la suite completa…"
  # El código de salida se GUARDA: la matriz solo mira los FL-*, y una prueba en rojo que no
  # sea un escenario no aparecería en ninguna fila.
  flows junit.xml >>"$LOG" 2>&1 || suite_failed=1
fi

if ! ls "$RESULTS"/*.xml >/dev/null 2>&1; then
  echo ""
  echo "No hay resultados en $RESULTS: la suite no llegó a ejecutarse."
  echo "  log: $LOG"
  exit 2
fi

# Matriz desde el XML de JUnit (los mismos programas que puntúan el de keel-spring, keel-nest y keel-dotnet).
matrix="$(awk '
${JUNIT_MATRIX_AWK}
' "$RESULTS"/*.xml 2>/dev/null | sort -k2,2)"

# Escenarios que el documento declara y ninguna prueba ejercita (cobertura que falta), y pruebas
# FL-* que el documento no declara (no puntúan): keel-core/gen/junit-scoring, el mismo cruce que en
# keel-spring.
${SCENARIO_DOCUMENT_SCORING}

echo ""
echo "MATRIZ"
printf '%s\\n' "$matrix" | while IFS="$(printf '\\t')" read -r result id cls; do
  [ -n "\${id:-}" ] || continue
  if [ "$result" = "FALLO" ]; then
    printf '  %-8s %-20s %-28s %s\\n' "$result" "$id" "$cls" "$EVIDENCE/$id.json"
  else
    printf '  %-8s %-20s %s\\n' "$result" "$id" "$cls"
  fi
done
for id in $uncovered; do
  printf '  %-8s %s\\n' "NO_EJERC" "$id"
done
${FOREIGN_ROWS_PRINT}

ok=$(printf '%s\\n' "$matrix" | grep -c '^OK')
ko=$(printf '%s\\n' "$matrix" | grep -c '^FALLO')
sk=$(printf '%s\\n' "$matrix" | grep -c '^OMITIDO')
nc=0
for id in $uncovered; do nc=$((nc + 1)); done

# Las pruebas en rojo que NO son escenarios: la matriz solo conoce los FL-*.
non_scenario_failures() {
  awk '
${JUNIT_NON_SCENARIO_AWK}
  ' "$RESULTS"/*.xml 2>/dev/null
}

# Los flujos que no llegaron a arrancar. StartFlow da sus escenarios por OMITIDOS, no por
# fallidos —el gemelo del initializationError de JUnit—, y deja el volcado <Flujo>-init.json.
# Sin esto, «omitido» diría «alguien lo saltó» cuando lo que hubo fue un rojo del arranque.
init_failures() {
  for file in "$EVIDENCE"/*-init.json; do
    [ -f "$file" ] || continue
    flow="$(basename "$file" -init.json)"
    msg="$(sed -n 's/^  "assertion": "\\(.*\\)",\\{0,1\\}$/\\1/p' "$file" | sed 's/\\\\n/ /g' | cut -c1-400)"
    echo "    $flow  (arranque del flujo)"
    [ -n "$msg" ] && echo "      $msg"
  done
}

broken="$(non_scenario_failures)$(init_failures)"
# Las pruebas en rojo con un id FL-* que el documento no declara tampoco salen en la matriz.
if [ -n "$foreign_failures" ]; then broken="$(printf '%s\\n%s' "$broken" "$foreign_failures")"; fi

echo ""
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ] && [ "$ok" -gt 0 ]; then
  if [ "$suite_failed" -ne 0 ]; then
    echo "RESULTADO: KO — los $ok escenario(s) FL-* están en OK, pero la suite falló."
    echo "  Hay pruebas en rojo que NO son escenarios y por eso no salen en la matriz:"
    printf '%s\\n' "$broken"
    echo "  log completo de go test: $LOG"
    echo "  Son del agente de pruebas, no del diseño: o las arregla o las retira."
    echo "  Sale con 2 y NO con 1: no hay ningún FL-* en FALLO, así que no hay ningún Then"
    echo "  que arbitrar."
    exit 2
  fi
  echo "RESULTADO: OK — $ok escenario(s) al 100%."
  exit 0
fi

echo "RESULTADO: KO — $ok OK · $ko FALLO · $sk omitido(s) · $nc no ejercitado(s)."
echo "  evidencia por fallo: $EVIDENCE/<FL-id>.json (request, response y aserción)"
echo "  log del servidor: build/keel-scenarios/server.log"
echo "  log completo de go test: $LOG"
if [ -n "$broken" ]; then
  echo ""
  echo "  ARNÉS: hay pruebas en rojo que NO son escenarios, o flujos que no llegaron a arrancar."
  printf '%s\\n' "$broken"
  echo "  Un flujo que no arrancó deja sus FL-* como OMITIDO: no es falta de cobertura ni un"
  echo "  salto. La causa va debajo de cada uno; el volcado, en $EVIDENCE/<Flujo>-init.json."
  if [ "$ko" -eq 0 ]; then
    echo "  No hay ningún escenario en FALLO: no hay nada que arbitrar, así que esto sale"
    echo "  con 2 (arnés roto) y no con 1: se arregla el flujo y se vuelve a puntuar."
    exit 2
  fi
  echo "  PERO hay $ko escenario(s) FL-* en FALLO, y eso SÍ se arbitra: esto sale con 1."
fi

# La matriz VACÍA no es un rojo que arbitrar: la suite corrió y no ejercitó ni un FL-*.
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ]; then
  echo ""
  echo "  ARNÉS: la matriz está VACÍA — la suite no ejercitó ni un escenario FL-*."
  echo "  No hay nada que arbitrar: sale con 2 y vuelve al agente de pruebas."
  exit 2
fi
exit 1
`;
}

// ─── infra/check-flows.sh ────────────────────────────────────────────────────────────────────────
//
// El gate de compilación del agente de PRUEBAS. Como en keel-spring, las pruebas de flujo compilan SIN el código del
// servicio: no importan ningún paquete suyo, así que un internal/ a medio escribir (el agente de código trabajando en
// paralelo) no pone rojo a quien no lo escribe. Y como dentro del módulo nada impide ese import, aquí se comprueba.

function checkFlowsScript(model) {
  const { module, integration } = layout(model);
  const ownPattern = module.replace(/[.[\]\\^$*+?(){}|]/g, '\\$&');
  return `#!/usr/bin/env bash
# check-flows.sh — compila y revisa las pruebas de flujo (${integration.dir}/) sin el código del servicio.
#
# Las pruebas de flujo son de caja negra: no importan ningún paquete del servicio, así que
# compilan solas y un internal/ a medio escribir no las pone en rojo. Dentro del módulo nada
# impide ese import, así que aquí se comprueba, y después se compilan y se revisan con go vet.
#
# Uso (desde la raíz; no necesita infraestructura):
#   bash infra/check-flows.sh
# Sale con 0 si las pruebas de flujo compilan y respetan la caja negra, y con 1 si no.
set -u
cd "$(dirname "$0")/.."
mkdir -p build

FLOWS="./${integration.dir}/"
LOG=build/keel-flows-build.log
fail=0

# La caja negra: ningún paquete del propio módulo entre las dependencias de las pruebas,
# salvo el de las pruebas mismo.
if ! deps="$(go list -tags ${INTEGRATION_TAG} -test -deps -f '{{.ImportPath}}' "$FLOWS" 2>"$LOG")"; then
  echo "No se pudieron listar los imports de las pruebas de flujo:"
  sed 's/^/  /' "$LOG" | head -30
  exit 1
fi
visible="$(printf '%s\\n' "$deps" | grep -E '^${ownPattern}/' | grep -vE '^${ownPattern}/${integration.dir}([ .]|$)' || true)"
if [ -n "$visible" ]; then
  echo "Caja negra rota: las pruebas de flujo importan paquetes del servicio y ven sus tipos:"
  printf '%s\\n' "$visible" | sed 's/^/  /'
  fail=1
fi

if ! go vet -tags ${INTEGRATION_TAG} "$FLOWS" >"$LOG" 2>&1; then
  echo "Las pruebas de flujo no compilan o go vet las rechaza:"
  grep -E '\\.go:[0-9]+(:[0-9]+)?: ' "$LOG" | sed 's/^/  /' | sort -u | head -30
  fail=1
fi
[ "$fail" -eq 0 ] && echo "Pruebas de flujo: compilan y respetan la caja negra."
exit "$fail"
`;
}
