// Las pruebas emitidas de la API, en `internal/httpapi`:
//   · api_test.go (caja negra, `httpapi_test`): el enrutador REAL con los casos de uso recién generados, servido por
//     httptest, y lo que el contrato fija sin depender de la lógica que escribe el agente, igual que las de keel-nest y
//     keel-dotnet: una operación llega a su handler, un cuerpo que no es JSON, uno que incumple lo declarado, un uuid
//     de ruta mal formado, una ruta que no existe (404), una que existe con otro método (405), el tope del cuerpo
//     (413) y la correlación. Las peticiones las elige del DISEÑO keel-core/gen/api-cases.js: si un caso no tiene
//     operación que lo ejercite, no se emite.
//   · edge_test.go (interna): lo que no se alcanza desde fuera sin lógica del agente — un pánico, un error sin
//     traducir y un error del dominio con y sin mensaje.

import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW, DOMAIN_ERROR_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { apiCases as neutralApiCases, concretePath } from '@keel-system/keel-core/gen/api-cases';
import { requestShape } from '@keel-system/keel-core/gen/api-contract';
import { usesApi } from '@keel-system/keel-core/gen/features';
import { errorBaseFor } from '@keel-system/keel-core/gen/error-bases';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { messageComponents } from './services.js';
import { servedOperation } from './endpoints.js';
import { testHandler } from './httpapi.js';
import { frameworkSentinels, sentinelOf } from './errors.js';

export function generate(model) {
  if (!usesApi(model)) return [];
  const { httpapi } = layout(model);
  return [
    { path: `${httpapi.dir}/api_test.go`, content: apiTestGo(model) },
    { path: `${httpapi.dir}/edge_test.go`, content: edgeTestGo(model) }
  ];
}

/** Los casos que el diseño permite ejercitar, sobre las operaciones que keel-go sirve. */
export function apiCases(model) {
  const served = {
    ...model,
    services: (model.services ?? []).map((service) => ({ ...service, operations: (service.operations ?? []).filter((op) => !op.route || servedOperation(op)) }))
  };
  return neutralApiCases(served, { components: (operation) => messageComponents(operation, model) });
}

const send = (entry, body = '""') => `send(t, server, ${goString(entry.method)}, ${goString(entry.url)}, ${body}, nil)`;

/** Los argumentos de expectError para un fallo del framework (code "" es null). */
function expected(key, code = '') {
  return `${FW[key].status}, ${goString(FW[key].error)}, ${goString(code)}, ${goString(FW[key].message)}`;
}

function apiTestGo(model) {
  const { httpapi } = layout(model);
  const cases = apiCases(model);
  const validation = FRAMEWORK_ERRORS.validation.code;
  const tests = [];
  if (cases.reachesHandler) {
    // No afirma QUÉ responde el handler, solo que la ruta llega a él: así sigue en verde cuando el agente lo
    // implementa (recién generado, su ErrNotImplemented sale como 500).
    tests.push(`func TestUnaOperacionLlegaASuHandlerNiAlDe404NiAlDe405(t *testing.T) {
	server := newServer(t)
	got := ${send(cases.reachesHandler)}
	if got.status == http.StatusMethodNotAllowed {
		t.Fatalf("${cases.reachesHandler.method} ${cases.reachesHandler.url} = 405: la ruta no está registrada con su método")
	}
	if got.status >= 400 {
		body := decodeError(t, got)
		if body.Message == ${goString(FW.notFound.message)} {
			t.Fatalf("${cases.reachesHandler.method} ${cases.reachesHandler.url} no llegó a su handler: %s", got.body)
		}
	}
}`);
  }
  if (cases.malformedBody) {
    tests.push(`func TestUnCuerpoQueNoEsJSONEs400PeticionMalformadaSinDetails(t *testing.T) {
	server := newServer(t)
	got := ${send(cases.malformedBody, '`{"roto":`')}
	body := expectError(t, got, ${expected('malformed', validation)})
	if string(body.Details) != "null" {
		t.Errorf("details = %s, quiero null", body.Details)
	}
}`);
    tests.push(`func TestUnCuerpoPorEncimaDelTopeEs413(t *testing.T) {
	server := newServer(t)
	got := ${send(cases.malformedBody, `\`{"x":"\`+strings.Repeat("a", httpapi.MaxBodyBytes)+\`"}\``)}
	expectError(t, got, ${expected('bodyTooLarge')})
}`);
  }
  if (cases.invalidBody) {
    // Un campo notBlank va EN BLANCO, no ausente: ausente lo rechaza también la rama del null, y la prueba no
    // distinguiría una regla que deja pasar los espacios.
    const payload = cases.invalidBody.message === 'must not be blank' ? JSON.stringify({ [cases.invalidBody.field]: '  ' }) : '{}';
    tests.push(`func TestUnCuerpoQueIncumpleLoDeclaradoEs400ValidationErrorConElCampoEnDetails(t *testing.T) {
	server := newServer(t)
	got := ${send(cases.invalidBody, `\`${payload}\``)}
	body := expectError(t, got, ${expected('invalidBody', validation)})
	var details []string
	if err := json.Unmarshal(body.Details, &details); err != nil || !slices.Contains(details, ${goString(`${cases.invalidBody.field} ${cases.invalidBody.message}`)}) {
		t.Errorf("details = %s, quiero que incluya %q", body.Details, ${goString(`${cases.invalidBody.field} ${cases.invalidBody.message}`)})
	}
}`);
  }
  const nullComposite = nullCompositeCase(model);
  if (nullComposite) {
    // Lo propio de Go: encoding/json/v2 llama a UnmarshalJSONFrom también con null, así que leer el cuerpo de golpe
    // haría pasar el null por el constructor del value object (malformada). keel-spring dice «must not be null».
    tests.push(`func TestUnValueObjectObligatorioANullEsMustNotBeNullYNoMalformada(t *testing.T) {
	server := newServer(t)
	got := ${send(nullComposite, `\`${JSON.stringify({ [nullComposite.field]: null })}\``)}
	body := expectError(t, got, ${expected('invalidBody', validation)})
	var details []string
	if err := json.Unmarshal(body.Details, &details); err != nil || !slices.Contains(details, ${goString(`${nullComposite.field} must not be null`)}) {
		t.Errorf("details = %s, quiero que incluya %q", body.Details, ${goString(`${nullComposite.field} must not be null`)})
	}
}`);
  }
  if (cases.malformedPath) {
    tests.push(`func TestUnUUIDDeRutaMalFormadoEs400PeticionMalformada(t *testing.T) {
	server := newServer(t)
	got := ${send(cases.malformedPath, '`{}`')}
	expectError(t, got, ${expected('malformed', validation)})
}`);
  }
  if (cases.wrongMethod) {
    tests.push(`func TestUnCaminoQueExisteConOtroMetodoEs405ConAllow(t *testing.T) {
	server := newServer(t)
	got := ${send(cases.wrongMethod)}
	expectError(t, got, ${expected('methodNotAllowed')})
	if got.header.Get("Allow") == "" {
		t.Error("un 405 sin cabecera Allow")
	}
}`);
  }
  const notFound = `${model.api.routeBase}/keel-ruta-que-no-existe`;
  const shape = WIRE_SHAPES.errorResponse.map(goString).join(', ');
  const body = `
// El contrato HTTP del servidor sobre el enrutador real: lo que fija el diseño sin depender de la lógica del agente.
// Las peticiones salen del diseño (keel-core/gen/api-cases.js), las mismas que piden las pruebas de keel-nest y
// keel-dotnet.

// errorShape es el orden de las claves de ErrorResponse: el del cable (keel-core, WIRE_SHAPES.errorResponse).
var errorShape = []string{${shape}}

var generatedID = regexp.MustCompile(\`^[0-9a-f-]{36}$\`)

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(${testHandler(model)})
	t.Cleanup(server.Close)
	return server
}

type reply struct {
	status int
	header http.Header
	body   []byte
}

func send(t *testing.T, server *httptest.Server, method, url, body string, header http.Header) reply {
	t.Helper()
	var content io.Reader
	if body != "" {
		content = strings.NewReader(body)
	}
	request, err := http.NewRequestWithContext(t.Context(), method, server.URL+url, content)
	if err != nil {
		t.Fatalf("petición %s %s: %v", method, url, err)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range header {
		request.Header[name] = values
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("leer %s %s: %v", method, url, err)
	}
	return reply{status: response.StatusCode, header: response.Header, body: data}
}

type errorBody struct {
	Timestamp     string         \`json:"timestamp"\`
	Status        int            \`json:"status"\`
	Error         string         \`json:"error"\`
	Code          *string        \`json:"code"\`
	Message       string         \`json:"message"\`
	Details       jsontext.Value \`json:"details"\`
	CorrelationID *string        \`json:"correlationId"\`
}

// keysOf son las claves del objeto JSON de primer nivel, en orden.
func keysOf(t *testing.T, data []byte) []string {
	t.Helper()
	dec := jsontext.NewDecoder(bytes.NewReader(data))
	if token, err := dec.ReadToken(); err != nil || token.Kind() != '{' {
		t.Fatalf("el cuerpo no es un objeto JSON: %s", data)
	}
	var keys []string
	for dec.PeekKind() != '}' {
		name, err := dec.ReadToken()
		if err != nil {
			t.Fatalf("leer el cuerpo: %v", err)
		}
		keys = append(keys, name.String())
		if err := dec.SkipValue(); err != nil {
			t.Fatalf("leer el cuerpo: %v", err)
		}
	}
	return keys
}

func decodeError(t *testing.T, got reply) errorBody {
	t.Helper()
	if keys := keysOf(t, got.body); !slices.Equal(keys, errorShape) {
		t.Fatalf("claves de ErrorResponse = %v, quiero %v", keys, errorShape)
	}
	var body errorBody
	if err := json.Unmarshal(got.body, &body); err != nil {
		t.Fatalf("leer ErrorResponse: %v", err)
	}
	return body
}

// expectError comprueba un ErrorResponse con la forma del contrato y la correlación de la propia respuesta. Un code
// "" es null.
func expectError(t *testing.T, got reply, status int, phrase, code, message string) errorBody {
	t.Helper()
	if got.status != status {
		t.Fatalf("status = %d, quiero %d: %s", got.status, status, got.body)
	}
	body := decodeError(t, got)
	if body.Status != status || body.Error != phrase || body.Message != message {
		t.Errorf("status, error y message = %d %q %q; quiero %d %q %q", body.Status, body.Error, body.Message, status, phrase, message)
	}
	if (code == "" && body.Code != nil) || (code != "" && (body.Code == nil || *body.Code != code)) {
		t.Errorf("code = %v, quiero %q", body.Code, code)
	}
	if !timestampPattern.MatchString(body.Timestamp) {
		t.Errorf("timestamp = %q, quiero un instante UTC con milisegundos", body.Timestamp)
	}
	if body.CorrelationID == nil || *body.CorrelationID != got.header.Get("X-Correlation-Id") {
		t.Errorf("correlationId = %v, quiero el de la cabecera %q", body.CorrelationID, got.header.Get("X-Correlation-Id"))
	}
	return body
}

var timestampPattern = regexp.MustCompile(\`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$\`)

func TestUnaRutaQueNoExisteEs404ConErrorResponse(t *testing.T) {
	server := newServer(t)
	got := send(t, server, "GET", ${goString(notFound)}, "", nil)
	expectError(t, got, ${expected('notFound')})
}

func TestLaCorrelacionRecibidaVuelveYUnaQueNoCumpleElFormatoSeSustituye(t *testing.T) {
	server := newServer(t)
	kept := send(t, server, "GET", "/livez", "", http.Header{"X-Correlation-Id": {"pedido-42"}})
	if got := kept.header.Get("X-Correlation-Id"); got != "pedido-42" {
		t.Errorf("correlación recibida = %q, quiero pedido-42", got)
	}
	replaced := send(t, server, "GET", "/livez", "", http.Header{"X-Correlation-Id": {"con espacios"}})
	if got := replaced.header.Get("X-Correlation-Id"); !generatedID.MatchString(got) {
		t.Errorf("correlación inválida sustituida por %q, quiero un uuid", got)
	}
	generated := send(t, server, "GET", "/livez", "", nil)
	if got := generated.header.Get("X-Correlation-Id"); !generatedID.MatchString(got) {
		t.Errorf("correlación generada = %q, quiero un uuid", got)
	}
}

func TestLaTablaDeRutasNoRepiteOperacionNiRuta(t *testing.T) {
	operations := map[string]bool{}
	patterns := map[string]bool{}
	for _, route := range httpapi.Routes() {
		pattern := route.Method + " " + route.Path
		if operations[route.Operation] || patterns[pattern] {
			t.Errorf("fila repetida: %s %s", route.Operation, pattern)
		}
		operations[route.Operation], patterns[pattern] = true, true
	}
}
${tests.map((test) => `\n${test}`).join('\n')}
`;
  return packageFile(model, httpapi, {
    test: true,
    imports: [
      'bytes',
      'encoding/json/jsontext',
      'encoding/json/v2',
      'io',
      'log/slog',
      'net/http',
      'net/http/httptest',
      'regexp',
      'slices',
      'strings',
      'testing',
      'internal/application',
      'internal/httpapi',
      'internal/platform/health'
    ],
    body
  });
}

/**
 * La primera operación servida con cuerpo obligatorio que exige un value object (notNull), con URL concreta: para
 * mandarle ese campo a null. null si el diseño no tiene ninguna.
 */
function nullCompositeCase(model) {
  for (const service of model.services ?? []) {
    for (const operation of (service.operations ?? []).filter(servedOperation)) {
      const { asBody, bodyRequired } = requestShape(operation);
      const url = concretePath(model, operation);
      const field = (operation.bodyFields ?? []).find(
        (f) => f.kind === 'composite' && !f.list && !f.resolvedIdentity && (f.inputValidation ?? []).some((rule) => rule.rule === 'notNull')
      );
      if (asBody && bodyRequired && url && field) return { method: operation.route.method, url, field: field.name };
    }
  }
  return null;
}

/** Un error del dominio con el que probar la respuesta: el centinela y lo que la API responde con él. */
function sampleDomainError(model) {
  const declared = (model.errors ?? []).find((error) => !error.dynamicStatus && error.sharedException !== 'DomainException');
  if (declared) {
    const texts = DOMAIN_ERROR_RESPONSES[errorBaseFor(declared.http)];
    return { sentinel: sentinelOf(declared.code), status: declared.http, code: declared.code, ...texts };
  }
  const framework = frameworkSentinels(model)[0];
  if (!framework) return null;
  return { sentinel: framework.name, status: framework.http, code: framework.code, ...DOMAIN_ERROR_RESPONSES[errorBaseFor(framework.http)] };
}

function edgeTestGo(model) {
  const { httpapi } = layout(model);
  const sample = sampleDomainError(model);
  const domainTests = sample
    ? `

func TestUnErrorDelDominioRespondeConSuStatusSuCodeYSuMensaje(t *testing.T) {
	a, _ := newEdge()
	failing := a.edge(a.endpoint(func(*api, http.ResponseWriter, *http.Request) error {
		return fmt.Errorf("en el handler: %w", domain.Errorf(domain.${sample.sentinel}, "lo que dijo el dominio"))
	}))
	got := serve(failing)
	expectEdgeError(t, got, ${sample.status}, ${goString(sample.error)}, ${goString(sample.code)}, "lo que dijo el dominio")
}

func TestUnErrorDelDominioSinMensajeRespondeConElDeSuCategoria(t *testing.T) {
	a, _ := newEdge()
	failing := a.edge(a.endpoint(func(*api, http.ResponseWriter, *http.Request) error {
		return domain.${sample.sentinel}
	}))
	got := serve(failing)
	expectEdgeError(t, got, ${sample.status}, ${goString(sample.error)}, ${goString(sample.code)}, ${goString(sample.fallback)})
}`
    : '';
  const body = `
// El borde por dentro: lo que no se alcanza desde fuera sin la lógica del agente.

func newEdge() (*api, *bytes.Buffer) {
	var logs bytes.Buffer
	return &api{logger: slog.New(slog.NewJSONHandler(&logs, nil))}, &logs
}

func serve(handler http.Handler) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/x", nil))
	return recorder
}

func expectEdgeError(t *testing.T, got *httptest.ResponseRecorder, status int, phrase, code, message string) {
	t.Helper()
	var body ErrorResponse
	if err := wire.Unmarshal(got.Body.Bytes(), &body); err != nil {
		t.Fatalf("leer ErrorResponse: %v: %s", err, got.Body)
	}
	gotCode := ""
	if body.Code != nil {
		gotCode = *body.Code
	}
	if got.Code != status || body.Status != status || body.Error != phrase || gotCode != code || body.Message != message {
		t.Errorf("respuesta = %d %s, quiero %d %q %q %q", got.Code, got.Body, status, phrase, code, message)
	}
}

func TestUnPanicoEnUnHandlerEs500YSeRegistraConSuPila(t *testing.T) {
	a, logs := newEdge()
	panicking := a.edge(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("roto a propósito")
	}))
	got := serve(panicking)
	expectEdgeError(t, got, ${expected('internal')})
	if !strings.Contains(logs.String(), "roto a propósito") || !strings.Contains(logs.String(), "goroutine") {
		t.Errorf("el pánico no quedó en el log con su pila: %s", logs)
	}
}

func TestUnErrorSinTraducirEs500YSeRegistra(t *testing.T) {
	a, logs := newEdge()
	failing := a.edge(a.endpoint(func(*api, http.ResponseWriter, *http.Request) error {
		return fmt.Errorf("%w: %s", application.ErrNotImplemented, "unaOperacion")
	}))
	got := serve(failing)
	expectEdgeError(t, got, ${expected('internal')})
	if !strings.Contains(logs.String(), "unaOperacion") {
		t.Errorf("el 500 no quedó en el log con su error: %s", logs)
	}
}${domainTests}
`;
  return packageFile(model, httpapi, {
    imports: ['bytes', 'fmt', 'log/slog', 'net/http', 'net/http/httptest', 'strings', 'testing', 'internal/application', 'internal/domain', 'internal/platform/wire'],
    body
  });
}
