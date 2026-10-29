// Sondas de vida y de disponibilidad, y el estado del apagado ordenado.
//
// El contrato es el de los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño: `GET /livez`
// y `GET /readyz` en el puerto principal, con cuerpo `{"status":"UP"}`; mientras el servicio drena tras un
// SIGTERM, `/readyz` responde 503 con `{"status":"OUT_OF_SERVICE"}`, que es lo que saca la instancia del
// balanceador antes de que deje de aceptar conexiones. Un orquestador o un HEALTHCHECK escritos contra uno de
// los cuatro servidores sirven para los otros.

import { layout, packageFile } from './render.js';

export function generate(model) {
  const { health } = layout(model);
  return [
    { path: `${health.dir}/health.go`, content: healthGo(model) },
    { path: `${health.dir}/health_test.go`, content: healthTestGo(model) }
  ];
}

function healthGo(model) {
  const { health } = layout(model);
  return packageFile(model, health, {
    doc: 'Package health sirve las sondas de vida y de disponibilidad del servicio y guarda el estado del\napagado ordenado.',
    imports: ['net/http', 'sync/atomic'],
    body: `
// Probes son las sondas del servicio. El valor cero está listo para usarse.
type Probes struct {
	draining atomic.Bool
}

// StartDraining deja de aceptar tráfico: /readyz pasa a 503. Está separado de la señal para poder
// probarlo sin ella.
func (p *Probes) StartDraining() {
	p.draining.Store(true)
}

// Draining dice si ha empezado el apagado ordenado.
func (p *Probes) Draining() bool {
	return p.draining.Load()
}

// Register añade las dos sondas al enrutador.
func (p *Probes) Register(mux *http.ServeMux) {
	// El proceso está vivo. No consulta dependencias: si fallara por ellas, el orquestador lo reiniciaría
	// sin motivo.
	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, _ *http.Request) {
		writeStatus(w, http.StatusOK, "UP")
	})
	// El proceso acepta tráfico. Deja de hacerlo en cuanto empieza el apagado ordenado.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if p.Draining() {
			writeStatus(w, http.StatusServiceUnavailable, "OUT_OF_SERVICE")
			return
		}
		writeStatus(w, http.StatusOK, "UP")
	})
}

// writeStatus escribe el cuerpo de las sondas. Es un texto fijo: no hay nada que serializar.
func writeStatus(w http.ResponseWriter, code int, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	// Un fallo al escribir es que el cliente se fue: no hay a quién decírselo.
	_, _ = w.Write([]byte(\`{"status":"\` + status + \`"}\`))
}
`
  });
}

function healthTestGo(model) {
  const { health } = layout(model);
  return packageFile(model, health, {
    test: true,
    imports: ['io', 'net/http', 'net/http/httptest', 'testing', 'internal/platform/health'],
    body: `
func get(t *testing.T, mux *http.ServeMux, path string) (int, string) {
	t.Helper()
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
	body, err := io.ReadAll(recorder.Result().Body)
	if err != nil {
		t.Fatalf("leer el cuerpo de %s: %v", path, err)
	}
	return recorder.Code, string(body)
}

func TestProbes(t *testing.T) {
	probes := &health.Probes{}
	mux := http.NewServeMux()
	probes.Register(mux)

	tests := []struct {
		name     string
		draining bool
		path     string
		code     int
		body     string
	}{
		{name: "vivo", path: "/livez", code: http.StatusOK, body: \`{"status":"UP"}\`},
		{name: "disponible", path: "/readyz", code: http.StatusOK, body: \`{"status":"UP"}\`},
		{name: "vivo mientras drena", draining: true, path: "/livez", code: http.StatusOK, body: \`{"status":"UP"}\`},
		{name: "fuera de servicio mientras drena", draining: true, path: "/readyz", code: http.StatusServiceUnavailable, body: \`{"status":"OUT_OF_SERVICE"}\`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.draining {
				probes.StartDraining()
			}
			code, body := get(t, mux, tt.path)
			if code != tt.code || body != tt.body {
				t.Errorf("GET %s = %d %s, quiero %d %s", tt.path, code, body, tt.code, tt.body)
			}
		})
	}
}
`
  });
}
