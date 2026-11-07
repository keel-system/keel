// La ESCRITURA CONDICIONAL (DSL 2.25, `api.concurrency`) en keel-go: incremento 3 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md,
// con el reparto de keel-dotnet y keel-nest. Lo que decide QUÉ (las escrituras listadas, las lecturas que dan el ETag, la
// cabecera, los errores, la nota y el gate) es de keel-core/gen/conditional-writes.js; aquí solo se escribe en Go:
//
//   · `application.Versioned[T]`: lo que devuelve el handler de una lectura derivada y de una escritura que devuelve su
//     raíz (D6). El compilador obliga al agente a dar la versión. Su lector exige la versión: una entrada de la caché sin
//     ella es ilegible (un miss), nunca un ETag inventado (CW-11).
//   · `domain.ErrPreconditionFailed` y `domain.ErrPreconditionRequired`: centinelas comparables con `errors.Is`, como todo
//     error del dominio (PLAN-KEEL-GO.md § 3.2), con su status propio (412 y 428: ninguna categoría los da).
//   · `domain.CheckVersion`: la comparación de `LoadExpecting` (D4), una sola para los dos adaptadores.
//   · `internal/httpapi/conditional.go`: lee If-Match a la lista de versiones que se estampa en el mensaje (D2, D5), da
//     el 428 y escribe el ETag (D1). El endpoint lo llama ANTES del lector: el 428 va antes que todo 400 (D3).
//   · `LoadExpecting` en el puerto de cada raíz escrita y en sus dos adaptadores.
//   · `infra/check-conditional-writes.sh` (CW-12), el gate neutral.
//
// La lista de versiones es un `[]int64` donde nil no compara (sin cabecera, '*' u otra puerta) y una lista vacía no casa
// con ninguna (un If-Match débil o ilegible): la distinción que en los otros tres es null frente a [].

import {
  CHECK_CONDITIONAL_WRITES_SH,
  VERSION_FIELD,
  conditionalWrite,
  conditionalWriteErrors,
  conditionalWriteNote,
  conditionalWritePolicy,
  conditionalWritesGateScript,
  conditionalWritesOf,
  returnsVersioned,
  usesConditionalWrites
} from '@keel-system/keel-core/gen/conditional-writes';
import { idParamNames } from '@keel-system/keel-core/gen/api-contract';
import { conditionalWriteCases } from '@keel-system/keel-core/gen/api-cases';
import { WIRE_ETAG_CASES } from '@keel-system/keel-core/gen/wire';
import { goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { applicationPath, domainPath, layout, packageFile } from './render.js';

export const LOAD_EXPECTING = 'LoadExpecting';
export const EXPECTED_VERSIONS = 'ExpectedVersions';
export const CONDITIONAL_GO = 'conditional.go';

export { usesConditionalWrites, returnsVersioned };

/** El tipo de retorno de un handler que devuelve la versión: `Versioned[ProductResponseDto]`. */
export function versionedType(result) {
  return `Versioned[${result}]`;
}

/** ¿Lleva el mensaje de esta operación la versión esperada? Solo las escrituras condicionales. */
export function carriesExpectedVersions(model, operation) {
  return Boolean(conditionalWrite(model, operation));
}

/** Las raíces que una escritura condicional carga: su puerto y sus adaptadores ganan `LoadExpecting`. */
export function loadsExpecting(model, entity) {
  return (conditionalWritesOf(model)?.writes ?? []).some((write) => write.root === entity.name);
}

/** Los dos centinelas, con el code efectivo (el del diseño si nombra uno de su familia) y el nombre de Go de ese code. */
export function preconditionSentinels(model) {
  const { failed, required } = conditionalWriteErrors(model);
  const sentinel = (code) => `Err${goExported(String(code).toLowerCase())}`;
  return {
    failed: { ...failed, name: sentinel(failed.code) },
    required: { ...required, name: sentinel(required.code) }
  };
}

/**
 * Los centinelas que añade la escritura condicional al catálogo del dominio (errors.js), salvo el que el diseño ya declara
 * con su code: entonces el centinela es el suyo. Su status es propio (412 y 428 no tienen categoría).
 */
export function conditionalWriteSentinels(model) {
  if (!usesConditionalWrites(model)) return [];
  const declared = new Set((model.errors ?? []).map((error) => error.code));
  const { failed, required } = preconditionSentinels(model);
  return [
    { ...failed, http: failed.status, doc: 'la versión que el cliente leyó (If-Match) ya no es la vigente: otro escribió entre su lectura y su escritura. No se escribe nada; el cliente vuelve a leer.' },
    { ...required, http: required.status, doc: 'la escritura exige If-Match (api.concurrency.conditionalWrites: required) y la petición no lo trae. Se responde en el borde, sin cargar nada.' }
  ].filter((entry) => !declared.has(entry.code));
}

/** El método del puerto. */
export function loadExpectingPort(entity, id) {
  return [
    `carga el ${entity.name} comparando su versión con la que el cliente leyó (If-Match, api.concurrency): si no es ninguna de expected devuelve la precondición (412) sin tocar nada; con expected nil no compara. found es false si no existe: el NOT_FOUND del diseño va antes que el 412.`,
    `${LOAD_EXPECTING}(ctx context.Context, ${id.name} ${id.type}, expected []int64) (*${entity.name}, bool, error)`
  ];
}

/**
 * El método de los dos adaptadores: carga con su FindByID y compara con `domain.CheckVersion`. La escritura que siga guarda
 * con la versión LEÍDA, así que otra escritura entre la carga y el commit sigue siendo el 409 de concurrencia y no el 412
 * (CW-5).
 */
export function loadExpectingAdapter(entity, type, port, id) {
  return `// ${LOAD_EXPECTING} implementa domain.${port}.
func (r *${type}) ${LOAD_EXPECTING}(ctx context.Context, ${id.name} ${id.type}, expected []int64) (*domain.${entity.name}, bool, error) {
	loaded, found, err := r.FindByID(ctx, ${id.name})
	if err != nil || !found {
		return nil, found, err
	}
	if err := domain.CheckVersion(expected, loaded.${goExported(VERSION_FIELD)}()); err != nil {
		return nil, false, err
	}
	return loaded, true, nil
}`;
}

/** La nota del handler, la de keel-core, con los nombres de Go. */
export function conditionalHandlerNote(model, operation, variable, repository) {
  const write = conditionalWrite(model, operation);
  const owns = idParamNames(write?.root ?? operation.responseDto?.entity ?? 'Raiz');
  const id = (operation.pathParams ?? []).find((pathParam) => owns.has(pathParam.name))?.name ?? 'id';
  return conditionalWriteNote(model, operation, {
    read: `${variable}.${EXPECTED_VERSIONS}`,
    load: `h.${repository}.${LOAD_EXPECTING}(ctx, ${variable}.${goExported(id)}, ${variable}.${EXPECTED_VERSIONS})`,
    versioned: versionedType(goExported(operation.responseDto?.name ?? 'T'))
  });
}

/** Las líneas del endpoint que leen If-Match, ANTES del lector (D3). */
export function endpointPrelude(model) {
  return [
    `\texpected, err := expectedVersions(r, ${conditionalWritePolicy(model) === 'required'})`,
    '\tif err != nil {',
    '\t\treturn err',
    '\t}'
  ];
}

export function generate(model) {
  if (!usesConditionalWrites(model)) return [];
  const { application, domain, httpapi } = layout(model);
  const files = [
    { path: applicationPath(model, 'Versioned'), content: packageFile(model, application, { imports: ['encoding/json/jsontext', 'encoding/json/v2', 'errors'], body: VERSIONED_GO }) },
    { path: domainPath(model, 'Versions'), content: packageFile(model, domain, { imports: ['slices'], body: versionsGo(model) }) },
    { path: `${httpapi.dir}/${CONDITIONAL_GO}`, content: packageFile(model, httpapi, { imports: ['net/http', 'regexp', 'strconv', 'strings', 'internal/domain'], body: conditionalGo(model) }) },
    { path: `${httpapi.dir}/conditional_test.go`, content: conditionalTestGo(model) },
    { path: `${application.dir}/versioned_test.go`, content: versionedTestGo(model) }
  ];
  const gate = conditionalWritesGateScript(model, { handlerPath: (row) => applicationPath(model, goExported(row.handlerClass)), call: LOAD_EXPECTING });
  if (gate) files.push({ path: CHECK_CONDITIONAL_WRITES_SH, content: gate });
  return files;
}

const VERSIONED_GO = `
// Versioned es una respuesta con la versión de su raíz (api.concurrency): el endpoint la escribe en la cabecera ETag y el
// valor en el cuerpo. La versión es la PERSISTIDA —la del agregado que devuelve Save, o la del leído—, nunca la que el
// handler tenía antes del commit: con esa, el ETag va un número por detrás y la siguiente edición encadenada da 412 sin
// conflicto.
type Versioned[T any] struct {
	Version int64 \`json:"version"\`
	Value   T     \`json:"value"\`
}

// errUnversioned es una entrada que no lleva su versión.
var errUnversioned = errors.New("Versioned: la entrada no lleva su versión")

// UnmarshalJSONFrom lee la versión y el valor, y exige la versión: una entrada de la caché que solo guarda el cuerpo es
// ilegible (se sirve desde el origen), nunca una respuesta con un ETag inventado. La versión 0 es legítima: es la primera.
func (v *Versioned[T]) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	var entry struct {
		Version *int64 \`json:"version"\`
		Value   T      \`json:"value"\`
	}
	if err := json.UnmarshalDecode(dec, &entry); err != nil {
		return err
	}
	if entry.Version == nil {
		return errUnversioned
	}
	v.Version, v.Value = *entry.Version, entry.Value
	return nil
}

// versioned marca el tipo para la muestra de la prueba de la caché: se construye campo a campo aunque tenga su lector.
func (Versioned[T]) versioned() {}
`;

function versionsGo(model) {
  const { failed } = preconditionSentinels(model);
  return `
// CheckVersion es la comparación de LoadExpecting (api.concurrency): nil si current es una de las versiones de expected,
// o si expected es nil (sin If-Match, '*' u otra puerta: no se compara). Si no, la precondición (412). Una lista vacía
// —un If-Match débil o ilegible— no casa con ninguna, y un agregado sin versión todavía tampoco.
func CheckVersion[V ~int32 | ~int64](expected []int64, current *V) error {
	if expected == nil {
		return nil
	}
	if current != nil && slices.Contains(expected, int64(*current)) {
		return nil
	}
	return Errorf(${failed.name}, ${goString(failed.message)})
}
`;
}

function conditionalGo(model) {
  const { required } = preconditionSentinels(model);
  return `
// La escritura condicional en el borde (api.concurrency; los casos, en keel-core/gen/wire.js). El ETag es la versión entre
// comillas, fuerte y opaco; If-Match se compara en fuerte: '*' se cumple si el recurso existe (no compara), una lista si
// coincide cualquiera, y un W/"…", un valor sin comillas o ilegible no coincide con nada (412, no 400).

// strongVersion es un elemento de If-Match que nombra una versión: entre comillas, sin ceros a la izquierda.
var strongVersion = regexp.MustCompile(\`^"(0|[1-9][0-9]*)"$\`)

// expectedVersions es lo que se estampa en el mensaje: nil si no se compara (sin cabecera, vacía o '*') y si no las
// versiones fuertes que trae, quizá ninguna. Sin cabecera y con required, el 428, antes de leer nada más.
func expectedVersions(r *http.Request, required bool) ([]int64, error) {
	value := strings.TrimSpace(strings.Join(r.Header.Values("If-Match"), ","))
	if value == "" {
		if required {
			return nil, domain.Errorf(domain.${required.name}, ${goString(required.message)})
		}
		return nil, nil
	}
	if value == "*" {
		return nil, nil
	}
	versions := []int64{}
	for element := range strings.SplitSeq(value, ",") {
		match := strongVersion.FindStringSubmatch(strings.TrimSpace(element))
		if match == nil {
			continue
		}
		if version, err := strconv.ParseInt(match[1], 10, 64); err == nil {
			versions = append(versions, version)
		}
	}
	return versions, nil
}

// etagOf es el ETag de una versión: entre comillas, fuerte.
func etagOf(version int64) string {
	return \`"\` + strconv.FormatInt(version, 10) + \`"\`
}
`;
}

// ─── Las pruebas emitidas (CW-6 a CW-11) ─────────────────────────────────────────────────────────────────────────

/**
 * CW-6, dentro de la prueba de la API (el servidor real, sin base): una escritura condicional sin If-Match con `required`
 * da 428 con la forma de error del cable. Que no llegó al caso de uso lo dice el propio 428: sin base, uno que empieza
 * responde 500.
 */
export function conditionalApiTests(model) {
  const cases = conditionalWriteCases(model);
  if (!cases?.required || !cases.write) return [];
  const { required } = cases.errors;
  return [
    `func TestCW6UnaEscrituraCondicionalSinIfMatchEs428YNoLlegaAlCasoDeUso(t *testing.T) {
	server := newServer(t)
	got := send(t, server, ${goString(cases.write.method)}, ${goString(cases.write.url)}, \`{}\`, nil)
	expectError(t, got, ${required.status}, ${goString(required.error)}, ${goString(required.code)}, ${goString(required.message)})
}`
  ];
}

/**
 * `internal/httpapi/conditional_test.go`: CW-7 (los casos de la cabecera de keel-core/gen/wire.js, leídos por el borde y
 * comparados como compara LoadExpecting), CW-8 (la precondición sale del borde como 412 con su code y su texto), CW-9 (CORS
 * expone el ETag, si el diseño declara CORS) y CW-10 (el formato del ETag).
 */
function conditionalTestGo(model) {
  const { httpapi } = layout(model);
  const cases = conditionalWriteCases(model);
  const cors = Boolean(model.security?.cors);
  const versions = (list) => (list == null ? 'nil' : `[]int64{${list.join(', ')}}`);
  const rows = cases.headerCases.map(
    (entry) => `\t{${goString(entry.id)}, ${entry.header == null ? 'nil' : `[]string{${goString(entry.header)}}`}, ${versions(entry.expected)}, ${goString(entry.outcome)}, ${entry.current}},`
  );
  const { failed } = cases.errors;
  const etags = WIRE_ETAG_CASES.map((entry) => `\t{${entry.version}, ${goString(entry.etag)}},`);
  const corsTest = cors
    ? `

func TestCW9CORSExponeElETag(t *testing.T) {
	policy := security.NewCORSPolicy([]string{"http://localhost:5173"})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://localhost/x", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	if outcome := policy.Apply(recorder, request); outcome != security.CORSAllowed {
		t.Fatalf("la petición CORS de la prueba no se permite: %v", outcome)
	}
	exposed := strings.Split(recorder.Header().Get("Access-Control-Expose-Headers"), ",")
	for i := range exposed {
		exposed[i] = strings.TrimSpace(exposed[i])
	}
	if !slices.Contains(exposed, ${goString(cases.exposedHeader)}) {
		t.Errorf("Access-Control-Expose-Headers = %v, quiero que incluya ${cases.exposedHeader}", exposed)
	}
}`
    : '';
  const body = `
// La escritura condicional en el borde (api.concurrency): los casos de la cabecera y del ETag son los de keel-core/gen/wire.js,
// los mismos que ejecutan los otros generadores. La comparación con la versión la hace el adaptador (LoadExpecting), y la
// miden db-check y doc-check.

var ifMatchCases = []struct {
	id       string
	header   []string
	expected []int64
	outcome  string
	current  int64
}{
${rows.join('\n')}
}

func TestCW7IfMatchSeLeeComoDicenLosCasosDelCable(t *testing.T) {
	for _, c := range ifMatchCases {
		t.Run(c.id, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPatch, "/x", nil)
			for _, value := range c.header {
				request.Header.Add("If-Match", value)
			}
			stamped, err := expectedVersions(request, false)
			if err != nil {
				t.Fatalf("expectedVersions: %v", err)
			}
			if (stamped == nil) != (c.expected == nil) || !slices.Equal(stamped, c.expected) {
				t.Fatalf("estampa %#v, quiero %#v", stamped, c.expected)
			}
			// Ausente es el 428 con required, y eso lo afirma CW-6 en el servidor: aquí solo que no se compara.
			if c.outcome == "absent" {
				return
			}
			// Lo mismo que compara LoadExpecting.
			current := c.current
			if matched := domain.CheckVersion(stamped, &current) == nil; matched != (c.outcome == "match") {
				t.Errorf("con la versión %d, casa = %t; quiero %s", c.current, matched, c.outcome)
			}
		})
	}
}

func TestCW8LaPrecondicionSaleDelBordeComo412ConSuCodeYSuTexto(t *testing.T) {
	a, _ := newEdge()
	current := int64(7)
	failing := a.edge(a.endpoint(func(*api, http.ResponseWriter, *http.Request) error {
		return domain.CheckVersion([]int64{6}, &current)
	}))
	got := serve(failing)
	expectEdgeError(t, got, ${failed.status}, ${goString(failed.error)}, ${goString(failed.code)}, ${goString(failed.message)})
}

var etagCases = []struct {
	version int64
	etag    string
}{
${etags.join('\n')}
}

func TestCW10ElETagEsLaVersionEntreComillas(t *testing.T) {
	for _, c := range etagCases {
		if got := etagOf(c.version); got != c.etag {
			t.Errorf("etagOf(%d) = %s, quiero %s", c.version, got, c.etag)
		}
	}
}${corsTest}
`;
  return packageFile(model, httpapi, {
    imports: ['net/http', 'net/http/httptest', 'slices', 'strings', 'testing', 'internal/domain', ...(cors ? ['internal/platform/security'] : [])],
    body
  });
}

/**
 * `internal/application/versioned_test.go` (CW-11): la entrada de la caché de una lectura que da el ETag guarda la versión
 * con el cuerpo, en el orden del cable, y vuelve con la MISMA versión; una entrada sin versión no se lee (un miss).
 */
function versionedTestGo(model) {
  const { application } = layout(model);
  return packageFile(model, application, {
    imports: ['strings', 'testing', 'internal/platform/wire'],
    body: `
// La entrada de la caché de una lectura que da el ETag (api.concurrency): la versión viaja con el cuerpo, así que un acierto
// devuelve el MISMO ETag que la lectura que la llenó. Lo que dice un Redis de verdad lo mide cache-check.

type versionedProbe struct {
	Name string \`json:"name"\`
}

func TestCW11LaEntradaGuardaLaVersionConElCuerpoYVuelveIgual(t *testing.T) {
	entry, err := wire.Marshal(Versioned[versionedProbe]{Version: 7, Value: versionedProbe{Name: "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(entry), \`{"version":7,"value":{\`) {
		t.Fatalf("la entrada no empieza por la versión, en el orden del cable: %s", entry)
	}
	var hit Versioned[versionedProbe]
	if err := wire.Unmarshal(entry, &hit); err != nil || hit.Version != 7 || hit.Value.Name != "x" {
		t.Fatalf("la entrada vuelve como %#v (%v), quiero la versión 7", hit, err)
	}
	var first Versioned[versionedProbe]
	if err := wire.Unmarshal([]byte(\`{"version":0,"value":{"name":"x"}}\`), &first); err != nil || first.Version != 0 {
		t.Fatalf("la versión 0 es la primera, y se lee: %#v (%v)", first, err)
	}
}

func TestCW11UnaEntradaSinVersionNoSeLee(t *testing.T) {
	var stale Versioned[versionedProbe]
	if err := wire.Unmarshal([]byte(\`{"value":{"name":"x"}}\`), &stale); err == nil {
		t.Fatalf("una entrada sin versión se leyó como %#v: el acierto saldría con un ETag inventado", stale)
	}
}
`
  });
}
