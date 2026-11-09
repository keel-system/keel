// El arnés del PROVEEDOR DE PRUEBA en keel-go (incremento 11d): los helpers con los que un flujo programa qué responde el
// WireMock de infra/ y lee lo que el servidor le mandó, y `AgeForReconciliation`/`HoldFromReconciliation`, que fabrican
// la precondición de un barrido de reconciliación. Los mismos que el AbstractFlowIT de keel-spring, el flow.ts de
// keel-nest y el `Support/HttpStub.cs` de keel-dotnet (`StubFor`, `StubFailure`, `StubConnectionFault`, `StubTimeout`,
// `StubSequence`, `StubCallCount`, `StubRequests`, `ResetStubs`), como métodos del `*Scenario`, con el vocabulario del
// stub de keel-core (`gen/http-stub-probes.js`): los cuatro hablan con el mismo contenedor.

import { HTTP_STUB_ADMIN, HTTP_STUB_ENDPOINTS, HTTP_STUB_FAULT, HTTP_STUB_INITIAL_STATE } from '@keel-system/keel-core/gen/http-stub-probes';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { snakeCase } from '@keel-system/keel-core/gen';
import { usesHttpStub } from '@keel-system/keel-core/gen/features';
import { relationalAgingTargets } from '@keel-system/keel-core/gen/aging-targets';
import { alignRows, goString } from '../lib/go-source.js';
import { fireAgedCall, fireAgedMember } from './timer.js';
import { usesRelational } from '@keel-system/keel-core/gen/features';
export { usesHttpStub };

/** El archivo del arnés en tests/integration. */
export const HTTP_STUB_HARNESS_FILE = 'http_stub_test.go';

export const HTTP_STUB_HARNESS_IMPORTS = ['bytes', 'context', 'encoding/json', 'fmt', 'io', 'maps', 'net/http', 'os', 'strconv', 'sync', 'time', 'unicode/utf16'];

/** El caso del humo: el mismo SMOKE-6 que los otros tres, que el stub ACEPTE un mapping, lo sirva y lo cuente. */
export function httpStubSmokeCase(model) {
  if (!usesHttpStub(model)) return null;
  return String.raw`	f.Scenario("SMOKE-6: el proveedor de prueba se deja programar", func(s *Scenario) {
		// Sin él, los flujos de las llamadas salientes fallarían por el stub, no por el servidor.
		s.StubFor("GET", "/keel-smoke/.*", 200, map[string]any{"ok": true})
		if got := s.StubCallCount("GET", "/keel-smoke/.*"); got != 0 {
			s.Errorf("el proveedor de prueba cuenta %d llamadas que nadie hizo", got)
		}
		s.ResetStubs()
	})`;
}

/** El cuerpo de tests/integration/http_stub_test.go, o null sin proveedor de prueba. */
export function httpStubHarnessBody(model) {
  if (!usesHttpStub(model)) return null;
  const clients = [...(model.httpClients ?? []).map((client) => client.id), ...(model.payments ? ['la pasarela de pago'] : [])].join(', ');
  return String.raw`
// El proveedor de prueba es el WireMock de infra/docker-compose.yaml, al que apuntan las base-url de los clientes
// salientes en el perfil local (${clients}). Cada flujo programa en su Given lo que responde, y el reset de estado (al
// empezar cada flujo) lo deja como recién arrancado: un mapping que sobreviviera a su escenario sería estado global, y el
// orden de ejecución decidiría el resultado.

// StubResponse es una respuesta programada del proveedor, para StubSequence. Las cuatro formas son las de los helpers
// de un disparo: RespondOK, RespondFailure, RespondTimeout y RespondConnectionFault.
type StubResponse map[string]any

// RespondOK es una respuesta normal con su cuerpo: un string viaja tal cual; cualquier otro valor, como su JSON.
func RespondOK(status int, body any) StubResponse {
	return StubResponse{"status": status, "headers": map[string]string{"Content-Type": "application/json"}, "body": body}
}

// RespondFailure es un fallo sin cuerpo útil: un 5xx se reintenta si el diseño lo dice; un 4xx, nunca.
func RespondFailure(status int) StubResponse {
	return RespondOK(status, map[string]any{})
}

// RespondTimeout es una respuesta que no llega a tiempo: delay tiene que superar el timeoutMs de la llamada.
func RespondTimeout(delay time.Duration) StubResponse {
	response := RespondOK(200, "{}")
	response["fixedDelayMilliseconds"] = delay.Milliseconds()
	return response
}

// RespondConnectionFault corta la conexión antes de responder: el servidor lo ve como un fallo del transporte.
func RespondConnectionFault() StubResponse {
	return StubResponse{"fault": ${goString(HTTP_STUB_FAULT)}}
}

// StubRequest es una petición que recibió el proveedor, tal como la registra.
type StubRequest struct {
	URL     string
	Method  string
	Headers map[string]string
	Body    string
}

// Header es la cabecera name de la petición, sin distinguir mayúsculas (el caso lo decide el cliente HTTP); "" si no la
// llevaba.
func (r StubRequest) Header(name string) string {
	return r.Headers[http.CanonicalHeaderKey(name)]
}

// JSON es el cuerpo de la petición leído como JSON, con cada número como su texto (json.Number); nil si no llevaba.
func (r StubRequest) JSON() (any, error) {
	if r.Body == "" {
		return nil, nil
	}
	return decodeJSON(r.Body)
}

// StubFor programa qué responde el proveedor en ESTE escenario: método, ruta (regex sobre el path, sin query) y la
// respuesta que verá el servidor.
func (s *Scenario) StubFor(method, pathPattern string, status int, body any) {
	s.Helper()
	s.stub(method, pathPattern, RespondOK(status, body))
}

// StubFailure es un fallo del proveedor sin cuerpo útil: lo que ejercita el fallback declarado y el circuito.
func (s *Scenario) StubFailure(method, pathPattern string, status int) {
	s.Helper()
	s.stub(method, pathPattern, RespondFailure(status))
}

// StubConnectionFault hace que el proveedor NO conteste: corta la conexión. No es un 5xx, y la diferencia la declara el
// diseño: una llamada con retryOn: [timeout, connection] no reintenta un 500 y sí reintenta esto.
func (s *Scenario) StubConnectionFault(method, pathPattern string) {
	s.Helper()
	s.stub(method, pathPattern, RespondConnectionFault())
}

// StubTimeout hace que el proveedor tarde más de lo tolerado (retryOn: [timeout]): delay por encima del timeoutMs de la
// llamada.
func (s *Scenario) StubTimeout(method, pathPattern string, delay time.Duration) {
	s.Helper()
	s.stub(method, pathPattern, RespondTimeout(delay))
}

// StubSequence programa respuestas DISTINTAS para llamadas sucesivas a la misma ruta: lo que hace escribible un
// escenario de REINTENTO («falla la primera, responde la segunda, y las dos llevan la misma clave de idempotencia»). La
// última se queda pegada. Una ruta admite UNA secuencia por flujo: la segunda encadenaría desde un estado que la
// primera dejó atrás.
//
//	s.StubSequence("DELETE", "/stock/reservations/.*", RespondConnectionFault(), RespondOK(200, map[string]any{"cancelled": true}))
//	// …la acción que dispara la llamada…
//	requests := s.StubRequests("DELETE", "/stock/reservations/.*")
//	if len(requests) != 2 || requests[0].Header("Idempotency-Key") != requests[1].Header("Idempotency-Key") {
//		s.Errorf("quiero dos intentos con la misma clave: %v", requests)
//	}
func (s *Scenario) StubSequence(method, pathPattern string, responses ...StubResponse) {
	s.Helper()
	if len(responses) < 2 {
		s.Fatal("StubSequence con menos de dos respuestas no es una secuencia: para una sola usa StubFor, StubFailure, StubTimeout o StubConnectionFault")
	}
	key := method + " " + pathPattern
	if !stubSequences.claim(key) {
		s.Fatalf("ya hay una secuencia programada para %s en este flujo: la segunda encadenaría desde un estado que la primera dejó atrás. Programa una sola", key)
	}
	scenario := "seq-" + stubHash(key)
	state := ${goString(HTTP_STUB_INITIAL_STATE)}
	for i, response := range responses {
		wire, err := response.wire()
		if err != nil {
			s.Fatal(err)
		}
		mapping := map[string]any{"scenarioName": scenario, "requiredScenarioState": state, "request": stubCriterion(method, pathPattern), "response": wire}
		if i < len(responses)-1 {
			state = scenario + "-" + strconv.Itoa(i+1)
			mapping["newScenarioState"] = state
		}
		if _, err := stubAdmin(s.Context(), ${goString(HTTP_STUB_ENDPOINTS.mappings)}, mapping); err != nil {
			s.Fatal(err)
		}
	}
}

// StubCallCount es cuántas veces llamó el servidor al proveedor a esa ruta.
func (s *Scenario) StubCallCount(method, pathPattern string) int {
	s.Helper()
	response, err := stubAdmin(s.Context(), ${goString(HTTP_STUB_ENDPOINTS.count)}, stubCriterion(method, pathPattern))
	if err != nil {
		s.Fatal(err)
	}
	count, ok := response["count"].(json.Number)
	if !ok {
		s.Fatalf("el proveedor de prueba no dijo cuántas: %v", response)
	}
	n, err := strconv.Atoi(count.String())
	if err != nil {
		s.Fatalf("la cuenta del proveedor de prueba no es un entero: %v", count)
	}
	return n
}

// StubRequests son las peticiones que recibió el proveedor a esa ruta: QUÉ se le mandó, no solo cuántas veces.
func (s *Scenario) StubRequests(method, pathPattern string) []StubRequest {
	s.Helper()
	response, err := stubAdmin(s.Context(), ${goString(HTTP_STUB_ENDPOINTS.find)}, stubCriterion(method, pathPattern))
	if err != nil {
		s.Fatal(err)
	}
	found, _ := response["requests"].([]any)
	requests := make([]StubRequest, 0, len(found))
	for _, entry := range found {
		logged, _ := entry.(map[string]any)
		request := StubRequest{Headers: map[string]string{}}
		request.URL, _ = logged["url"].(string)
		request.Method, _ = logged["method"].(string)
		request.Body, _ = logged["body"].(string)
		headers, _ := logged["headers"].(map[string]any)
		for name, value := range headers {
			request.Headers[http.CanonicalHeaderKey(name)] = stubHeaderValue(value)
		}
		requests = append(requests, request)
	}
	return requests
}

// ResetStubs borra los mappings, el log de peticiones y las secuencias. Ya lo hace el reset de cada flujo.
func (s *Scenario) ResetStubs() {
	s.Helper()
	stubSequences.forget()
	if _, err := stubAdmin(s.Context(), ${goString(HTTP_STUB_ENDPOINTS.reset)}, map[string]any{}); err != nil {
		s.Fatal(err)
	}
}

func (s *Scenario) stub(method, pathPattern string, response StubResponse) {
	s.Helper()
	wire, err := response.wire()
	if err != nil {
		s.Fatal(err)
	}
	if _, err := stubAdmin(s.Context(), ${goString(HTTP_STUB_ENDPOINTS.mappings)}, map[string]any{"request": stubCriterion(method, pathPattern), "response": wire}); err != nil {
		s.Fatal(err)
	}
}

// wire es la respuesta en el vocabulario del stub, con el cuerpo siempre como TEXTO: el stub no interpreta el JSON.
func (r StubResponse) wire() (map[string]any, error) {
	wire := maps.Clone(map[string]any(r))
	body, ok := r["body"]
	if !ok {
		return wire, nil
	}
	switch value := body.(type) {
	case nil:
		wire["body"] = ""
	case string:
		wire["body"] = value
	default:
		data, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("el cuerpo del stub no se puede escribir como JSON: %w", err)
		}
		wire["body"] = string(data)
	}
	return wire, nil
}

// sequenceRoutes son las rutas con una secuencia programada en el flujo en curso.
type sequenceRoutes struct {
	mu     sync.Mutex
	routes map[string]bool
}

var stubSequences sequenceRoutes

// claim apunta la ruta key; false si ya tenía una secuencia.
func (q *sequenceRoutes) claim(key string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.routes[key] {
		return false
	}
	if q.routes == nil {
		q.routes = map[string]bool{}
	}
	q.routes[key] = true
	return true
}

// forget olvida las secuencias del flujo anterior: el stub ya lo vació infra/reset-db.sh.
func (q *sequenceRoutes) forget() {
	q.mu.Lock()
	defer q.mu.Unlock()
	clear(q.routes)
}

// stubAdminURL es el admin API del stub, o HTTP_STUB_ADMIN del entorno.
func stubAdminURL() string {
	if configured := os.Getenv("HTTP_STUB_ADMIN"); configured != "" {
		return configured
	}
	return ${goString(HTTP_STUB_ADMIN)}
}

// stubAdmin manda body a un recurso del admin API (todos van por POST) y devuelve su respuesta leída como JSON.
func stubAdmin(ctx context.Context, resource string, body any) (map[string]any, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("el cuerpo para el proveedor de prueba no se puede escribir: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, stubAdminURL()+resource, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("armar la petición al proveedor de prueba: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("no se pudo hablar con el proveedor de prueba en %s. ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh): %w", stubAdminURL(), err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("leer la respuesta del proveedor de prueba: %w", err)
	}
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("el proveedor de prueba rechazó %s (HTTP %d): %s", resource, response.StatusCode, data)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]any{}, nil
	}
	value, err := decodeJSON(string(data))
	if err != nil {
		return nil, fmt.Errorf("la respuesta del proveedor de prueba a %s no es JSON: %w", resource, err)
	}
	object, _ := value.(map[string]any)
	return object, nil
}

func stubCriterion(method, pathPattern string) map[string]any {
	return map[string]any{"method": method, "urlPathPattern": pathPattern}
}

// stubHeaderValue es el valor de una cabecera registrada: el stub da una lista cuando llegó repetida.
func stubHeaderValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		var joined bytes.Buffer
		for i, entry := range typed {
			if i > 0 {
				joined.WriteString(", ")
			}
			fmt.Fprint(&joined, entry)
		}
		return joined.String()
	default:
		return fmt.Sprint(typed)
	}
}

// stubHash es el nombre del escenario de una secuencia: el mismo hash que los arneses de keel-nest y keel-dotnet (el
// de un String de Java sobre sus unidades UTF-16, en hexadecimal sin signo).
func stubHash(text string) string {
	var value int32
	for _, unit := range utf16.Encode([]rune(text)) {
		value = value*31 + int32(unit)
	}
	return strconv.FormatUint(uint64(uint32(value)), 16)
}
`;
}

// ─── AgeForReconciliation y HoldFromReconciliation ───────────────────────────────────────────────

/**
 * Los métodos del escenario que envejecen (o retienen) la marca de espera de un barrido de reconciliación. El mismo
 * criterio que los otros tres: sin los literales del motor (`staleTimestamp`, `uuidLiteral`) no se emiten —un UPDATE que
 * no casa dejaría el escenario verde sin haber envejecido nada—. Usan `Db` e `idLiteral`, que emite el arnés con base
 * relacional.
 */
export function reconciliationAgingMembers(model) {
  if (!usesRelational(model)) return [];
  const entry = DATABASES[model.stack?.database ?? 'postgresql'];
  if (!entry?.staleTimestamp || !entry?.uuidLiteral) return [];
  const targets = relationalAgingTargets(model);
  if (targets.size === 0) return [];
  const known = [...targets.keys()].join(', ');
  const first = [...targets.keys()][0];
  const table = (name, clock) =>
    `var ${name} = map[string][]string{\n${alignRows(
      [...targets].map(([activation, list]) => ({
        indent: '\t',
        cells: [`${goString(activation)}:`, `{${list.map((target) => goString(`UPDATE ${target.table} SET ${snakeCase(target.awaitingField)} = ${clock} WHERE id = `)).join(', ')}},`]
      }))
    ).join('\n')}\n}`;
  const members = [
    String.raw`// reconciliationAging son las sentencias que envejecen la marca de espera de cada barrido, por activación: ${known}.
// Acaban en «WHERE id = »: el id lo pone idLiteral.
${table('reconciliationAging', entry.staleTimestamp)}

// AgeForReconciliation deja la marca de espera de activation infinitamente rancia para la fila id, de modo que el
// barrido la tome en SU PRÓXIMA PASADA. No dispara el barrido —lo dispara su cron, como en producción—: crea la
// condición que busca («lleva esperando más de lo tolerado») sin esperar el plazo real, y solo para esta fila. Bajar el
// umbral por configuración sería global y se llevaría las filas de los demás escenarios. Deja margen para un tick del
// cron:
//
//	s.AgeForReconciliation(${goString(first)}, id)
//	s.Eventually(func() bool { … }, 90*time.Second, "el barrido no tomó la fila")
func (s *Scenario) AgeForReconciliation(activation, id string) {
	s.Helper()
	s.reconciliationClock(reconciliationAging, activation, id)
${fireAgedCall(model, 'activation')}}`,
    ...fireAgedMember(model)
  ];
  if (entry.heldTimestamp) {
    members.push(String.raw`// reconciliationHolding son las sentencias que dejan la marca de espera de cada barrido en el FUTURO.
${table('reconciliationHolding', entry.heldTimestamp)}

// HoldFromReconciliation es el inverso de AgeForReconciliation: deja la marca de espera de activation en el FUTURO para
// la fila id, de modo que el barrido NO la tome aunque pasen sus ciclos. Es la palanca de un escenario que pide «lo que
// acaba de encargarse no se toca».
func (s *Scenario) HoldFromReconciliation(activation, id string) {
	s.Helper()
	s.reconciliationClock(reconciliationHolding, activation, id)
}`);
  }
  members.push(String.raw`func (s *Scenario) reconciliationClock(statements map[string][]string, activation, id string) {
	s.Helper()
	list, ok := statements[activation]
	if !ok {
		s.Fatalf("no hay barrido para la activación %q. Las que lo tienen: ${known}", activation)
	}
	for _, statement := range list {
		s.Db(statement + idLiteral(id))
	}
}`);
  return members;
}
