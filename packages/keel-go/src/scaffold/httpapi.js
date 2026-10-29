// La entrada HTTP: el enrutador del servicio y el `http.Server` con sus límites.
//
// net/http sin framework (PLAN-KEEL-GO.md § 2): desde Go 1.22 el enrutador entiende método y patrón
// (`GET /livez`, `POST /api/v1/products/{id}/activate`). Con la capa api, `NewHandler` registra cada fila de la tabla
// `routes` (endpoints.js), un último patrón `/` que responde el 404 y el 405 con ErrorResponse, y envuelve todo con
// el borde (rest-support.js): correlación, tope del cuerpo y recover.
//
// Los límites del servidor (§ 3.6) los fija el código y no la configuración: los otros tres servidores no los
// declaran en su application.yaml —se quedan con los defaults de Tomcat, Node y Kestrel—, así que añadir
// claves aquí rompería la igualdad del archivo. Lo que no se puede hacer es dejar los de net/http, que son
// «sin límite»: un cliente lento retendría la conexión para siempre.

import { usesApi } from '@keel-system/keel-core/gen/features';
import { layout, packageFile } from './render.js';

export function generate(model) {
  const { httpapi } = layout(model);
  return [
    { path: `${httpapi.dir}/server.go`, content: serverGo(model) },
    { path: `${httpapi.dir}/server_test.go`, content: serverTestGo(model) }
  ];
}

function serverGo(model) {
  const { httpapi } = layout(model);
  return packageFile(model, httpapi, {
    doc: 'Package httpapi es la entrada HTTP del servicio: el enrutador con sus rutas y el servidor con sus\nlímites.',
    imports: ['log/slog', 'net', 'net/http', 'strconv', 'time', 'internal/application', 'internal/platform/config', 'internal/platform/health'],
    body: `
// Los límites del servidor. Sin ellos, net/http no corta nunca a un cliente lento.
const (
	// ReadHeaderTimeout es lo que puede tardar en llegar la cabecera de una petición.
	ReadHeaderTimeout = 10 * time.Second
	// ReadTimeout es lo que puede tardar en llegar la petición entera, cuerpo incluido.
	ReadTimeout = 30 * time.Second
	// WriteTimeout es lo que puede tardar la respuesta desde que se terminó de leer la cabecera.
	WriteTimeout = 60 * time.Second
	// IdleTimeout es lo que una conexión keep-alive puede esperar a la petición siguiente.
	IdleTimeout = 120 * time.Second
	// MaxHeaderBytes es el tamaño máximo de las cabeceras: los 8 KiB de keel-spring (Tomcat).
	MaxHeaderBytes = 8 << 10
)

${usesApi(model) ? API_HANDLER : PROBES_HANDLER}

// NewServer devuelve el servidor HTTP del servicio, con sus límites, escuchando en la dirección de la
// configuración.
func NewServer(settings config.Server, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              net.JoinHostPort(settings.Address, strconv.Itoa(settings.Port)),
		Handler:           handler,
		ReadHeaderTimeout: ReadHeaderTimeout,
		ReadTimeout:       ReadTimeout,
		WriteTimeout:      WriteTimeout,
		IdleTimeout:       IdleTimeout,
		MaxHeaderBytes:    MaxHeaderBytes,
	}
}
`
  });
}

const PROBES_HANDLER = `// NewHandler devuelve el enrutador del servicio.
func NewHandler(probes *health.Probes) http.Handler {
	mux := http.NewServeMux()
	probes.Register(mux)
	return mux
}`;

const API_HANDLER = `// api es la entrada HTTP de las operaciones: los casos de uso a los que despacha y el logger del borde.
type api struct {
	useCases *application.UseCases
	logger   *slog.Logger
}

// NewHandler devuelve la entrada HTTP del servicio: las sondas y una ruta por operación del diseño, detrás del borde
// (correlación, tope del cuerpo y recover). Lo que ninguna ruta atiende responde 404 o 405 con ErrorResponse.
func NewHandler(probes *health.Probes, useCases *application.UseCases, logger *slog.Logger) http.Handler {
	a := &api{useCases: useCases, logger: logger}
	mux := http.NewServeMux()
	probes.Register(mux)
	for _, route := range routes {
		mux.Handle(route.Method+" "+route.Path, a.endpoint(route.handle))
	}
	mux.Handle("/", unrouted(mux))
	return a.edge(mux)
}`;

/** La llamada a NewHandler con la que lo construyen las pruebas. */
export function testHandler(model) {
  return usesApi(model)
    ? 'httpapi.NewHandler(&health.Probes{}, application.NewUseCases(slog.New(slog.DiscardHandler)), slog.New(slog.DiscardHandler))'
    : 'httpapi.NewHandler(&health.Probes{})';
}

function serverTestGo(model) {
  const { httpapi } = layout(model);
  return packageFile(model, httpapi, {
    test: true,
    imports: ['log/slog', 'testing', 'time', 'internal/application', 'internal/httpapi', 'internal/platform/config', 'internal/platform/health'],
    body: `
func TestNewServerHasLimits(t *testing.T) {
	srv := httpapi.NewServer(config.Server{Port: 8080, Address: "0.0.0.0", ShutdownTimeout: time.Second}, ${testHandler(model)})
	if srv.Addr != "0.0.0.0:8080" {
		t.Errorf("Addr = %q, quiero 0.0.0.0:8080", srv.Addr)
	}
	for name, limit := range map[string]time.Duration{
		"ReadHeaderTimeout": srv.ReadHeaderTimeout,
		"ReadTimeout":       srv.ReadTimeout,
		"WriteTimeout":      srv.WriteTimeout,
		"IdleTimeout":       srv.IdleTimeout,
	} {
		if limit <= 0 {
			t.Errorf("%s = %v: sin límite, un cliente lento retiene la conexión", name, limit)
		}
	}
	if srv.MaxHeaderBytes <= 0 {
		t.Errorf("MaxHeaderBytes = %d: sin límite propio", srv.MaxHeaderBytes)
	}
}
`
  });
}
