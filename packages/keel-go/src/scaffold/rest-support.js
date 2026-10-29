// La infraestructura REST de `internal/httpapi` que no depende de ninguna operación: el cuerpo de error, la lectura y
// la validación de una petición, la respuesta y el borde (correlación, tope del cuerpo, recover, 404 y 405). Los
// endpoints de cada operación los emite endpoints.js sobre esto.
//
// El contrato es el del servidor de keel-spring del mismo diseño, el mismo que cumplen keel-nest y keel-dotnet:
//   · la forma y el orden de ErrorResponse los fija keel-core (WIRE_SHAPES.errorResponse); un campo sin valor viaja
//     como null, nunca se omite (y `details` sin detalles es null, no `[]`: json/v2 escribe `[]` para un slice nil);
//   · el `error` y el `message` de cada fallo salen de keel-core/gen/api-errors.js, y el `code` de un fallo de forma
//     es VALIDATION_ERROR (FRAMEWORK_ERRORS.validation);
//   · `details` de una validación es «campo mensaje», con los mensajes por defecto de Hibernate Validator;
//   · una petición que no se puede LEER es 400 «Petición malformada» sin details: Spring no distingue la causa.
//
// Lo propio de Go: un endpoint DEVUELVE su error (§ 3.2) y un solo punto, `writeError`, lo traduce con `errors.As`; un
// `*domain.Error` responde con su status y su `code`, `ErrNotImplemented` (un handler sin escribir) cae en el
// catch-all 500, y solo el 500 se registra con el error entero. Un pánico se recupera en el borde (500, con su pila
// en el log), y el cuerpo tiene un tope explícito (MaxBodyBytes → 413): net/http no pone ninguno.
//
// Cada auxiliar de lectura y validación se emite solo si un lector lo usa (endpoints.js lo apunta en `plan.uses`).

import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW, domainErrorResponses } from '@keel-system/keel-core/gen/api-errors';
import { usesApi } from '@keel-system/keel-core/gen/features';
import { errorKindFor } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { formatString, layout, packageFile } from './render.js';
import { apiPlan, enumValues } from './endpoints.js';

export function generate(model) {
  if (!usesApi(model)) return [];
  const plan = apiPlan(model);
  const { httpapi } = layout(model);
  const file = (name, imports, body) => ({ path: `${httpapi.dir}/${name}.go`, content: packageFile(model, httpapi, { imports, body: `\n${body}\n` }) });
  const uses = closure(plan.uses);
  const files = [
    file('errors', ['errors', 'context', 'fmt', 'net/http', 'time', 'encoding/json/jsontext', 'encoding/json/v2', 'internal/domain', 'internal/platform/correlation'], errorsBody()),
    file('reply', ['fmt', 'net/http', 'net/url', 'strings', 'internal/platform/wire'], pick(REPLY, uses, ['writeJSON'])),
    file('middleware', ['fmt', 'log/slog', 'net/http', 'runtime/debug', 'strings', 'internal/platform/correlation'], MIDDLEWARE_BODY)
  ];
  const reading = [pick(READING, uses), ...[...plan.enums].sort().map((name) => enumReader(model, name))].filter(Boolean).join('\n\n');
  if (reading) {
    files.push(
      file(
        'reading',
        ['bytes', 'errors', 'io', 'net/http', 'regexp', 'strconv', 'strings', 'time', 'unicode', 'encoding/json/jsontext', 'encoding/json/v2', 'github.com/google/uuid', 'internal/domain', 'internal/platform/wire'],
        reading
      )
    );
  }
  const validation = [pick(VALIDATION, uses), patternsBlock(plan)].filter(Boolean).join('\n\n');
  if (validation) files.push(file('validation', ['fmt', 'regexp', 'strings', 'unicode/utf16', 'internal/platform/wire'], validation));
  return files;
}

/** Lo que piden los lectores, con sus dependencias. */
function closure(requested) {
  const all = { ...READING, ...VALIDATION, ...REPLY };
  const out = new Set();
  const visit = (name) => {
    if (out.has(name)) return;
    if (!all[name]) throw new Error(`rest-support: no hay auxiliar ${name}`);
    out.add(name);
    for (const dep of all[name].deps ?? []) visit(dep);
  };
  for (const name of requested) visit(name);
  return out;
}

/** Los auxiliares de un archivo que se usan, en el orden en que están declarados. */
function pick(snippets, uses, always = []) {
  return Object.entries(snippets)
    .filter(([name]) => uses.has(name) || always.includes(name))
    .map(([, snippet]) => snippet.code.trim())
    .join('\n\n');
}

function enumReader(model, name) {
  return `// text${name} lee un ${name} de la ruta o de la query.
func text${name}(raw string) (domain.${name}, error) {
	return textEnum(raw, ${enumValues(model, name).join(', ')})
}`;
}

function patternsBlock(plan) {
  if (plan.patterns.size === 0) return '';
  // Como el matches() de Java: la expresión entera, sin el salto de línea final que admitiría un `$` suelto.
  const rows = [...plan.patterns].map(([regexp, name]) => ({ indent: '\t', cells: [name, `= regexp.MustCompile(${goString(`\\A(?:${regexp})\\z`)})`] }));
  return `// Las expresiones de las reglas pattern del diseño: la expresión entera, como el matches() de Java.
var (
${alignRows(rows).join('\n')}
)`;
}

// ─── errors.go ──────────────────────────────────────────────────────────────────────────────────

const ERROR_TYPES = {
  timestamp: 'time.Time',
  status: 'int',
  error: 'string',
  code: '*string',
  message: 'string',
  details: 'Details',
  correlationId: '*string'
};

function errorsBody() {
  const missing = WIRE_SHAPES.errorResponse.filter((name) => !ERROR_TYPES[name]);
  if (missing.length > 0) throw new Error(`ErrorResponse: el contrato del cable nombra ${missing.join(', ')} y keel-go no lo emite`);
  const goName = (name) => (name === 'correlationId' ? 'CorrelationID' : name[0].toUpperCase() + name.slice(1));
  const fields = alignRows(WIRE_SHAPES.errorResponse.map((name) => ({ indent: '\t', cells: [goName(name), ERROR_TYPES[name], `\`json:"${name}"\``] })));
  const kinds = domainErrorResponses()
    .map(({ http, error, fallback }) => `\tcase domain.${errorKindFor(http)}:\n\t\treturn ${goString(error)}, ${goString(fallback)}`)
    .join('\n');
  const targets = alignRows(
    [
      ['invalid', '*validationError'],
      ['missing', '*missingParameterError'],
      ['unread', '*malformedError'],
      ['tooLarge', '*http.MaxBytesError'],
      ['rejected', '*domain.Error']
    ].map((cells) => ({ indent: '\t\t', cells }))
  ).join('\n');
  const fw = (key) => `${FW[key].status}, ${goString(FW[key].error)}`;
  return `// validationCode es el code de un fallo de FORMA de la petición (FRAMEWORK_ERRORS.validation).
const validationCode = ${goString(FRAMEWORK_ERRORS.validation.code)}

// ErrorResponse es el cuerpo de todo fallo de la API, con la forma y el orden del cable (keel-core,
// WIRE_SHAPES.errorResponse). Los campos sin valor viajan como null: la forma del cuerpo de error es contrato.
type ErrorResponse struct {
${fields.join('\n')}
}

// Details son los detalles de una validación, «campo mensaje». Sin detalles viajan como null, no como [].
type Details []string

// MarshalJSONTo escribe null para unos detalles nil.
func (d Details) MarshalJSONTo(enc *jsontext.Encoder) error {
	if d == nil {
		return enc.WriteToken(jsontext.Null)
	}
	return json.MarshalEncode(enc, []string(d))
}

// malformedError es una petición que no se puede leer: JSON roto, un tipo que no encaja o un value object que su
// constructor rechaza. Spring no distingue la causa (HttpMessageNotReadableException), y la respuesta tampoco.
type malformedError struct {
	cause error
}

// Error dice que la petición no se puede leer, y por qué.
func (e *malformedError) Error() string {
	if e.cause == nil {
		return "petición malformada"
	}
	return "petición malformada: " + e.cause.Error()
}

// Unwrap es el motivo.
func (e *malformedError) Unwrap() error {
	return e.cause
}

// missingParameterError es un parámetro obligatorio de la query que no llegó.
type missingParameterError struct {
	name string
}

// Error nombra el parámetro.
func (e *missingParameterError) Error() string {
	return "falta el parámetro " + e.name
}

// validationError es una petición que se leyó pero incumple lo que el diseño declara. params distingue la ruta y la
// query del cuerpo: en keel-spring responden con mensajes distintos.
type validationError struct {
	params  bool
	details []string
}

// Error lleva los detalles.
func (e *validationError) Error() string {
	return "la petición no supera las validaciones: " + fmt.Sprint(e.details)
}

// newErrorResponse construye un ErrorResponse con la correlación de la petición.
func newErrorResponse(r *http.Request, status int, phrase string, code *string, message string, details Details) ErrorResponse {
	response := ErrorResponse{Timestamp: time.Now(), Status: status, Error: phrase, Code: code, Message: message, Details: details}
	if id, ok := correlation.ID(r.Context()); ok {
		response.CorrelationID = &id
	}
	return response
}

// writeErrorResponse escribe un ErrorResponse con su status.
func writeErrorResponse(w http.ResponseWriter, response ErrorResponse) {
	// ErrorResponse siempre se puede serializar; un fallo al escribir es que el cliente se fue.
	_ = writeJSON(w, response.Status, response)
}

// writeError traduce el error de un endpoint a su ErrorResponse. Es el único sitio que lo hace, con errors.As; el
// catch-all 500 es lo único que se registra con el error entero (el caso de uso ya dejó su resultado en el log).
func (a *api) writeError(w http.ResponseWriter, r *http.Request, err error) {
	// El cliente se fue: no queda a quién responder.
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return
	}
	// La respuesta ya empezó: el status no se puede cambiar.
	if tracked, ok := w.(*trackingWriter); ok && tracked.started {
		a.logger.ErrorContext(r.Context(), "error tras empezar la respuesta", "error", err)
		return
	}
	writeErrorResponse(w, a.errorResponse(r, err))
}

func (a *api) errorResponse(r *http.Request, err error) ErrorResponse {
	var (
${targets}
	)
	switch {
	// Validación: errores de FORMA de la petición, 400. El 422 queda para las reglas de negocio.
	case errors.As(err, &invalid):
		message := ${goString(FW.invalidBody.message)}
		if invalid.params {
			message = ${goString(FW.invalidParams.message)}
		}
		return newErrorResponse(r, ${fw('invalidBody')}, new(validationCode), message, invalid.details)
	case errors.As(err, &missing):
		return newErrorResponse(r, ${fw('missingParameter')}, new(validationCode), fmt.Sprintf(${formatString(FW.missingParameter.message).replace("'{name}'", "'%s'")}, missing.name), nil)
	case errors.As(err, &unread):
		return newErrorResponse(r, ${fw('malformed')}, new(validationCode), ${goString(FW.malformed.message)}, nil)
	case errors.As(err, &tooLarge):
		return newErrorResponse(r, ${fw('bodyTooLarge')}, nil, ${goString(FW.bodyTooLarge.message)}, nil)
	// Errores del dominio: su status y su code.
	case errors.As(err, &rejected):
		return domainResponse(r, rejected)
	}
	a.logger.ErrorContext(r.Context(), "error no controlado", "error", err)
	return newErrorResponse(r, ${fw('internal')}, nil, ${goString(FW.internal.message)}, nil)
}

// domainResponse responde un error del dominio con su status y su code, y el error y el mensaje por defecto de su
// categoría. Un status sin categoría propia (402, 429, 503…) lleva su frase HTTP.
func domainResponse(r *http.Request, rejected *domain.Error) ErrorResponse {
	status := rejected.Status()
	phrase, fallback := domainTexts(rejected.Kind())
	if phrase == "" {
		phrase = http.StatusText(status)
		if phrase == "" {
			phrase = "Error"
		}
		fallback = phrase
	}
	message := rejected.Message()
	if message == "" {
		message = fallback
	}
	code := rejected.Code()
	return newErrorResponse(r, status, phrase, &code, message, nil)
}

// domainTexts son el error y el mensaje por defecto de cada categoría (keel-core/gen/api-errors.js).
func domainTexts(kind domain.Kind) (phrase, fallback string) {
	switch kind {
${kinds}
	}
	return "", ""
}`;
}

// ─── middleware.go ──────────────────────────────────────────────────────────────────────────────

const MIDDLEWARE_BODY = `
// MaxBodyBytes es el tope del cuerpo de una petición: net/http no pone ninguno, y un cliente podría mandar uno sin
// fin. Es el de Kestrel; lo que lo supera es un 413.
const MaxBodyBytes = 30_000_000

// edge es el borde por el que pasa toda petición: abre la correlación (la recibida si cumple el formato, o una nueva;
// vuelve en la cabecera y en el cuerpo de error), pone el tope del cuerpo y recupera un pánico como un 500.
func (a *api) edge(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := correlation.Accept(r.Header.Get(correlation.Header))
		w.Header().Set(correlation.Header, id)
		r = r.WithContext(correlation.WithID(r.Context(), id))
		r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
		tracked := &trackingWriter{ResponseWriter: w}
		defer a.recoverPanic(tracked, r)
		next.ServeHTTP(tracked, r)
	})
}

// recoverPanic convierte un pánico de un handler en un 500 con ErrorResponse y lo registra con su pila: un pánico
// es un defecto, no un error esperado. http.ErrAbortHandler sigue su camino (corta la respuesta a propósito).
func (a *api) recoverPanic(w *trackingWriter, r *http.Request) {
	recovered := recover()
	if recovered == nil {
		return
	}
	if recovered == http.ErrAbortHandler {
		panic(recovered)
	}
	a.logger.ErrorContext(r.Context(), "pánico en un handler", slog.String("panic", fmt.Sprint(recovered)), slog.String("stack", string(debug.Stack())))
	if !w.started {
		writeErrorResponse(w, newErrorResponse(r, ${FW.internal.status}, ${goString(FW.internal.error)}, nil, ${goString(FW.internal.message)}, nil))
	}
}

// trackingWriter recuerda si la respuesta ya empezó: después, el status ya no se puede cambiar.
type trackingWriter struct {
	http.ResponseWriter
	started bool
}

// WriteHeader empieza la respuesta.
func (t *trackingWriter) WriteHeader(code int) {
	t.started = true
	t.ResponseWriter.WriteHeader(code)
}

// Write empieza la respuesta, si no había empezado.
func (t *trackingWriter) Write(data []byte) (int, error) {
	t.started = true
	return t.ResponseWriter.Write(data)
}

// Unwrap da el ResponseWriter de debajo a http.ResponseController.
func (t *trackingWriter) Unwrap() http.ResponseWriter {
	return t.ResponseWriter
}

// endpoint adapta un endpoint que devuelve su error a un http.Handler: el error lo traduce writeError.
func (a *api) endpoint(handle func(*api, http.ResponseWriter, *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := handle(a, w, r); err != nil {
			a.writeError(w, r, err)
		}
	})
}

// unrouted responde lo que ninguna ruta atiende, con ErrorResponse: 405 si el camino existe con otro método (con su
// cabecera Allow), 404 si no existe. Lo que net/http respondería es texto plano.
func unrouted(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if allowed := allowedMethods(mux, r); len(allowed) > 0 {
			w.Header().Set("Allow", strings.Join(allowed, ", "))
			writeErrorResponse(w, newErrorResponse(r, ${FW.methodNotAllowed.status}, ${goString(FW.methodNotAllowed.error)}, nil, ${goString(FW.methodNotAllowed.message)}, nil))
			return
		}
		writeErrorResponse(w, newErrorResponse(r, ${FW.notFound.status}, ${goString(FW.notFound.error)}, nil, ${goString(FW.notFound.message)}, nil))
	})
}

// allowedMethods son los métodos con los que el camino de r sí tiene ruta.
func allowedMethods(mux *http.ServeMux, r *http.Request) []string {
	var allowed []string
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		probe := r.Clone(r.Context())
		probe.Method = method
		if _, pattern := mux.Handler(probe); pattern != "/" {
			allowed = append(allowed, method)
		}
	}
	return allowed
}
`;

// ─── reply.go ───────────────────────────────────────────────────────────────────────────────────

const REPLY = {
  writeJSON: {
    code: `
// writeJSON responde con status y body escrito con el contrato del cable. Se serializa antes de escribir nada: un
// fallo al serializar todavía puede responderse como un 500.
func writeJSON(w http.ResponseWriter, status int, body any) error {
	data, err := wire.Marshal(body)
	if err != nil {
		return fmt.Errorf("serializar la respuesta: %w", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// Un fallo al escribir es que el cliente se fue: no hay a quién decírselo.
	_, _ = w.Write(data)
	return nil
}`
  },
  location: {
    code: `
// location es la URL absoluta de Location: el esquema y el host de la petición y la plantilla de la ruta que LEE el
// recurso con su parámetro sustituido (ServletUriComponentsBuilder.fromCurrentContextPath en keel-spring).
func location(r *http.Request, template, value string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	start, end := strings.Index(template, "{"), strings.Index(template, "}")
	return scheme + "://" + r.Host + template[:start] + url.PathEscape(value) + template[end+1:]
}`
  }
};

// ─── reading.go ─────────────────────────────────────────────────────────────────────────────────

const READING = {
  malformed: {
    code: `
// malformed es una petición que no se puede leer, con su motivo.
func malformed(cause error) error {
	return &malformedError{cause: cause}
}`
  },
  readObject: {
    deps: ['malformed'],
    code: `
// readObject lee el cuerpo como objeto JSON y devuelve sus miembros: qué llegó, y qué llegó a null. Sin cuerpo (o con
// null) es nil si el cuerpo es opcional y una petición malformada si es obligatorio; lo que no es un objeto,
// malformada. Un cuerpo por encima de MaxBodyBytes devuelve el *http.MaxBytesError (413).
func readObject(r *http.Request, required bool) (map[string]jsontext.Value, error) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, err
		}
		return nil, malformed(err)
	}
	var fields map[string]jsontext.Value
	if len(bytes.TrimSpace(data)) > 0 {
		// El objeto, sin las opciones del cable: esas convierten cada valor a su tipo, y aquí los miembros se guardan
		// tal cual llegaron (los convierte member). Un nombre repetido gana el último, como en el cable.
		if err := json.Unmarshal(data, &fields, jsontext.AllowDuplicateNames(true)); err != nil {
			return nil, malformed(err)
		}
	}
	if fields == nil && required {
		return nil, malformed(nil)
	}
	return fields, nil
}`
  },
  has: {
    code: `
// has dice si el miembro llegó con un valor: ausente y null son lo mismo para todo salvo un PATCH.
func has(fields map[string]jsontext.Value, name string) bool {
	raw, ok := fields[name]
	return ok && raw.Kind() != 'n'
}`
  },
  member: {
    deps: ['has', 'malformed'],
    code: `
// member lee el miembro name sobre out con el contrato del cable, si llegó con valor; ausente o null lo deja como
// está. Un value object pasa por su constructor: si lo rechaza, la petición es malformada.
func member[T any](fields map[string]jsontext.Value, name string, out *T) error {
	if !has(fields, name) {
		return nil
	}
	if err := wire.Unmarshal(fields[name], out); err != nil {
		return malformed(err)
	}
	return nil
}`
  },
  optionalMember: {
    deps: ['malformed'],
    code: `
// optionalMember lee un opcional de tres estados (PATCH): ausente no lo toca; null o un valor, sí.
func optionalMember[T any](fields map[string]jsontext.Value, name string, out *wire.Optional[T]) error {
	raw, ok := fields[name]
	if !ok {
		return nil
	}
	if err := wire.Unmarshal(raw, out); err != nil {
		return malformed(err)
	}
	return nil
}`
  },
  integerText: {
    code: `
// integerText es lo que admite Integer.valueOf de Java: un signo opcional y dígitos.
var integerText = regexp.MustCompile(\`^[+-]?[0-9]+$\`)`
  },
  textInt32: {
    deps: ['integerText', 'malformed'],
    code: `
// textInt32 lee un int de la ruta o de la query.
func textInt32(raw string) (int32, error) {
	if !integerText.MatchString(raw) {
		return 0, malformed(nil)
	}
	value, err := strconv.ParseInt(raw, 10, 32)
	if err != nil {
		return 0, malformed(err)
	}
	return int32(value), nil
}`
  },
  textInt64: {
    deps: ['integerText', 'malformed'],
    code: `
// textInt64 lee un long de la ruta o de la query.
func textInt64(raw string) (int64, error) {
	if !integerText.MatchString(raw) {
		return 0, malformed(nil)
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, malformed(err)
	}
	return value, nil
}`
  },
  textDecimal: {
    deps: ['malformed'],
    code: `
// textDecimal lee un decimal exacto con el contrato del cable.
func textDecimal(raw string) (wire.Decimal, error) {
	value, err := wire.ParseDecimal(raw)
	if err != nil {
		return wire.Decimal{}, malformed(err)
	}
	return value, nil
}`
  },
  textDate: {
    deps: ['malformed'],
    code: `
// textDate lee una fecha con el contrato del cable.
func textDate(raw string) (wire.Date, error) {
	value, err := wire.ParseDate(raw)
	if err != nil {
		return wire.Date{}, malformed(err)
	}
	return value, nil
}`
  },
  textTimestamp: {
    deps: ['malformed'],
    code: `
// textTimestamp lee un instante con zona con el contrato del cable.
func textTimestamp(raw string) (time.Time, error) {
	value, err := wire.ParseTimestamp(raw)
	if err != nil {
		return time.Time{}, malformed(err)
	}
	return value, nil
}`
  },
  textBool: {
    deps: ['malformed'],
    code: `
// textBool lee un booleano como Spring: true/false, on/off, yes/no y 1/0, sin distinguir mayúsculas.
func textBool(raw string) (bool, error) {
	switch strings.ToLower(raw) {
	case "true", "on", "yes", "1":
		return true, nil
	case "false", "off", "no", "0":
		return false, nil
	}
	return false, malformed(nil)
}`
  },
  hexText: {
    code: `
// hexText son los dígitos de un grupo de un uuid.
var hexText = regexp.MustCompile(\`^[0-9a-fA-F]+$\`)`
  },
  textUUID: {
    deps: ['hexText', 'malformed'],
    code: `
// textUUID lee un uuid como UUID.fromString de Java: cinco grupos hexadecimales que caben en 8-4-4-4-12, que se
// completan con ceros a la izquierda. Sale en su forma canónica.
func textUUID(raw string) (uuid.UUID, error) {
	parts := strings.Split(raw, "-")
	if len(raw) > 36 || len(parts) != 5 {
		return uuid.UUID{}, malformed(nil)
	}
	widths := [5]int{8, 4, 4, 4, 12}
	for i, part := range parts {
		if !hexText.MatchString(part) || len(part) > widths[i] {
			return uuid.UUID{}, malformed(nil)
		}
		parts[i] = strings.Repeat("0", widths[i]-len(part)) + part
	}
	value, err := uuid.Parse(strings.Join(parts, "-"))
	if err != nil {
		return uuid.UUID{}, malformed(err)
	}
	return value, nil
}`
  },
  textJSON: {
    deps: ['malformed'],
    code: `
// textJSON lee un documento JSON de un texto.
func textJSON(raw string) (jsontext.Value, error) {
	value := jsontext.Value(raw)
	if !value.IsValid() {
		return nil, malformed(nil)
	}
	return value, nil
}`
  },
  textString: {
    code: `
// textString lee un texto tal cual: es el lector de los elementos de una lista de textos.
func textString(raw string) (string, error) {
	return raw, nil
}`
  },
  canonical: {
    code: `
// canonical es un nombre comparado como lo hace Spring Boot: en minúsculas y sin lo que no es letra ni dígito.
func canonical(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}`
  },
  textEnum: {
    deps: ['canonical', 'malformed'],
    code: `
// textEnum lee un enum por su literal o, como Spring Boot, por su nombre sin distinguir mayúsculas e ignorando lo que
// no es letra ni dígito (IN_PROGRESS e in-progress son el mismo).
func textEnum[T ~string](raw string, values ...T) (T, error) {
	raw = strings.TrimSpace(raw)
	for _, value := range values {
		if string(value) == raw {
			return value, nil
		}
	}
	for _, value := range values {
		if canonical(string(value)) == canonical(raw) {
			return value, nil
		}
	}
	var zero T
	return zero, malformed(nil)
}`
  },
  queryValue: {
    code: `
// queryValue es el primer valor de un parámetro de la query (Spring toma el primero) y si vino.
func queryValue(r *http.Request, name string) (string, bool) {
	values := r.URL.Query()[name]
	if len(values) == 0 {
		return "", false
	}
	return values[0], true
}`
  },
  requireParam: {
    code: `
// requireParam exige un parámetro obligatorio de la query. Vacío cuenta como presente: lo juzgan sus reglas.
func requireParam(r *http.Request, name string) error {
	if !r.URL.Query().Has(name) {
		return &missingParameterError{name: name}
	}
	return nil
}`
  },
  requiredParam: {
    deps: ['queryValue', 'malformed'],
    code: `
// requiredParam lee un parámetro obligatorio ya exigido con requireParam: en blanco, no se puede convertir.
func requiredParam[T any](r *http.Request, name string, parse func(string) (T, error)) (T, error) {
	raw, _ := queryValue(r, name)
	if strings.TrimSpace(raw) == "" {
		var zero T
		return zero, malformed(nil)
	}
	return parse(raw)
}`
  },
  optionalParam: {
    deps: ['queryValue'],
    code: `
// optionalParam lee un parámetro opcional: ausente o en blanco, nil.
func optionalParam[T any](r *http.Request, name string, parse func(string) (T, error)) (*T, error) {
	raw, ok := queryValue(r, name)
	if !ok || strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	value, err := parse(raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}`
  },
  optionalText: {
    deps: ['queryValue'],
    code: `
// optionalText lee un texto opcional de la query: vacío es un valor, no su ausencia.
func optionalText(r *http.Request, name string) *string {
	raw, ok := queryValue(r, name)
	if !ok {
		return nil
	}
	return &raw
}`
  },
  listParam: {
    code: `
// listParam lee una lista de la query: el parámetro repetido o separado por comas.
func listParam[T any](r *http.Request, name string, parse func(string) (T, error)) ([]T, error) {
	values := r.URL.Query()[name]
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) == 1 {
		values = strings.Split(values[0], ",")
	}
	list := make([]T, 0, len(values))
	for _, raw := range values {
		value, err := parse(raw)
		if err != nil {
			return nil, err
		}
		list = append(list, value)
	}
	return list, nil
}`
  },
  unreadableParam: {
    deps: ['malformed'],
    code: `
// unreadableParam: un value object no se lee de un texto. Si llega, la petición es malformada.
func unreadableParam(r *http.Request, name string) error {
	if r.URL.Query().Has(name) {
		return malformed(nil)
	}
	return nil
}`
  },
  pageParam: {
    deps: ['queryValue', 'textInt32'],
    code: `
// pageParam lee la página o el tamaño de un listado, con su valor por defecto si no viene o viene en blanco.
func pageParam(r *http.Request, name string, fallback int32) (int32, error) {
	raw, ok := queryValue(r, name)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	return textInt32(raw)
}`
  }
};

// ─── validation.go ──────────────────────────────────────────────────────────────────────────────

const VALIDATION = {
  violations: {
    code: `
// violations acumula lo que una petición incumple y lo devuelve de una vez, como Bean Validation: cada detalle es
// «campo mensaje».
type violations struct {
	params  bool
	details []string
}

func (v *violations) add(path, message string) {
	v.details = append(v.details, path+" "+message)
}

// err es el error con todos los detalles, o nil si no hay ninguno.
func (v *violations) err() error {
	if len(v.details) == 0 {
		return nil
	}
	return &validationError{params: v.params, details: v.details}
}`
  },
  textLength: {
    code: `
// textLength es la longitud de un texto como la cuenta Java (String.length): en unidades UTF-16, no en bytes.
func textLength(text string) int {
	n := 0
	for _, r := range text {
		n += utf16.RuneLen(r)
	}
	return n
}`
  },
  exceedsDigits: {
    code: `
// exceedsDigits dice si value tiene más dígitos enteros o decimales de los que admite @Digits(integer, fraction).
func exceedsDigits(value wire.Decimal, integer, fraction int) bool {
	whole, decimals, _ := strings.Cut(strings.TrimPrefix(value.String(), "-"), ".")
	return len(strings.TrimLeft(whole, "0")) > integer || len(strings.TrimRight(decimals, "0")) > fraction
}`
  }
};
