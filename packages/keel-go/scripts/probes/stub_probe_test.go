//go:build integration

// El arnés del proveedor de prueba y el adaptador saliente de keel-go contra un WireMock REAL (incremento 11d).
//
// Lo que la prueba emitida clients_test.go no puede juzgar —allí el proveedor es un RoundTripper falso—: que lo que
// programan los métodos de tests/integration/http_stub_test.go lo ENTIENDA el stub de verdad (un mapping mal formado lo
// rechaza; uno bien formado que no casa no falla nada), y que el corte de conexión, el retraso y la secuencia de WireMock
// lleguen a net/http como el arnés promete: transporte, timeout, la segunda respuesta. Los mismos casos que el
// stub-check de keel-nest y el de keel-dotnet, sobre stock-reservation.
//
// No es una prueba del proyecto generado: la copia a tests/integration y la ejecuta `npm run stub-check`. Construye el
// escenario sin StartFlow, así que el servidor del servicio no arranca: solo hablan el arnés, el adaptador y el stub.

package integration

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	configfiles "__MODULE__/config"
	"__MODULE__/internal/infrastructure/clients"
	"__MODULE__/internal/platform/config"
)

const probeRoute = "/stock/reservations/.*"

// probe es un escenario sin servidor, con el stub vacío y un adaptador nuevo: el circuito vive lo que su adaptador, y un
// caso no hereda el del anterior.
func probe(t *testing.T) (*Scenario, *clients.InventoryHTTPAdapter) {
	t.Helper()
	s := &Scenario{T: t}
	s.ResetStubs()
	baseURL := os.Getenv("STUB_CHECK_BASE_URL")
	if baseURL == "" {
		t.Fatal("STUB_CHECK_BASE_URL: la URL del WireMock")
	}
	// La configuración del perfil develop, apuntando a este WireMock: la base-url que lee el servidor desplegado.
	cfg, err := config.Load(configfiles.Files, func(name string) string {
		switch name {
		case "PROFILE":
			return "develop"
		case "INVENTORY_BASE_URL":
			return baseURL
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	settings, err := clients.SettingsFrom(cfg)
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := clients.NewInventoryHTTPAdapter(settings, clients.NewExchange(nil), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	return s, adapter
}

func keys(s *Scenario) []string {
	var keys []string
	for _, request := range s.StubRequests("DELETE", probeRoute) {
		keys = append(keys, request.Header("idempotency-key"))
	}
	return keys
}

func distinct(values []string) int {
	seen := map[string]bool{}
	for _, value := range values {
		seen[value] = true
	}
	return len(seen)
}

func TestStubProbeLoProgramadoLlegaAlAdaptadorYElProveedorRegistraLaPeticion(t *testing.T) {
	s, inventory := probe(t)
	s.StubFor("DELETE", probeRoute, 200, map[string]any{"cancelled": true})
	result, err := inventory.CancelStock(t.Context(), uuid.New())
	if err != nil || result.Cancelled == nil || !*result.Cancelled {
		t.Fatalf("CancelStock = %+v, %v; quiero cancelled true", result, err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 1 {
		t.Fatalf("%d llamadas, quiero 1", got)
	}
	requests := s.StubRequests("DELETE", probeRoute)
	if len(requests) != 1 {
		t.Fatalf("%d peticiones registradas, quiero 1", len(requests))
	}
	request := requests[0]
	if request.Method != "DELETE" || !strings.HasPrefix(request.URL, "/stock/reservations/") {
		t.Errorf("petición %s %s", request.Method, request.URL)
	}
	// La cabecera, sin distinguir mayúsculas: el caso lo decide el cliente HTTP.
	if strings.TrimSpace(request.Header("IDEMPOTENCY-KEY")) == "" {
		t.Error("la petición no lleva Idempotency-Key")
	}
	if body, err := request.JSON(); body != nil || err != nil {
		t.Errorf("un DELETE sin cuerpo: %v, %v", body, err)
	}
}

func TestStubProbeElCorteDeConexionEsTransporteYSeReintentaConLaMismaClave(t *testing.T) {
	s, inventory := probe(t)
	s.StubConnectionFault("DELETE", probeRoute)
	result, err := inventory.CancelStock(t.Context(), uuid.New())
	// onFailure: ignore — el fallback devuelve el resultado neutro.
	if err != nil || result.Cancelled != nil {
		t.Fatalf("CancelStock = %+v, %v; quiero el resultado vacío del fallback", result, err)
	}
	if got := keys(s); len(got) != 3 || distinct(got) != 1 {
		t.Fatalf("claves %v: quiero 3 intentos con la MISMA", got)
	}
}

// net/http reenvía por su cuenta una petición idempotente (un DELETE con Idempotency-Key lo es) cuya conexión
// REUTILIZADA se corta antes de la respuesta. Tras una llamada buena, el corte siguiente tiene que llegar al proveedor
// exactamente tantas veces como intentos declara la política: ni una más por debajo del retry del diseño.
func TestStubProbeUnaConexionQueSeCortaNoSeReenviaPorDebajoDelRetry(t *testing.T) {
	s, inventory := probe(t)
	s.StubFor("DELETE", probeRoute, 200, map[string]any{"cancelled": true})
	if result, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil || result.Cancelled == nil {
		t.Fatalf("la llamada buena: %+v, %v", result, err)
	}
	s.ResetStubs()
	s.StubConnectionFault("DELETE", probeRoute)
	if _, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 3 {
		t.Fatalf("%d peticiones al proveedor, quiero 3 (los intentos de la política)", got)
	}
}

func TestStubProbeElRetrasoPorEncimaDelTimeoutEsTransporteYSeReintenta(t *testing.T) {
	s, inventory := probe(t)
	// 3,5 s sobre el timeoutMs de 3000 de cancelStock.
	s.StubTimeout("DELETE", probeRoute, 3500*time.Millisecond)
	result, err := inventory.CancelStock(t.Context(), uuid.New())
	if err != nil || result.Cancelled != nil {
		t.Fatalf("CancelStock = %+v, %v; quiero el resultado vacío del fallback", result, err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 3 {
		t.Fatalf("%d intentos, quiero 3", got)
	}
}

func TestStubProbeLaSecuenciaEntregaLaSegundaRespuestaConLaMismaClaveYSeQuedaPegada(t *testing.T) {
	s, inventory := probe(t)
	s.StubSequence("DELETE", probeRoute, RespondConnectionFault(), RespondOK(200, map[string]any{"cancelled": true}))
	order := uuid.New()
	if result, err := inventory.CancelStock(t.Context(), order); err != nil || result.Cancelled == nil || !*result.Cancelled {
		t.Fatalf("CancelStock = %+v, %v; quiero la segunda respuesta", result, err)
	}
	if got := keys(s); len(got) != 2 || distinct(got) != 1 {
		t.Fatalf("claves %v: quiero 2 intentos con la MISMA", got)
	}
	// La última se queda pegada: una llamada de más vuelve a recibirla.
	if result, err := inventory.CancelStock(t.Context(), order); err != nil || result.Cancelled == nil || !*result.Cancelled {
		t.Fatalf("la llamada de más: %+v, %v", result, err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 3 {
		t.Fatalf("%d llamadas, quiero 3", got)
	}
	// Una ruta admite UNA secuencia por flujo: la guarda ya la tiene apuntada (StubSequence haría Fatal con la segunda).
	if stubSequences.claim("DELETE " + probeRoute) {
		t.Fatal("la segunda secuencia sobre la misma ruta no se rechazaría")
	}
}

func TestStubProbeDiezFallosAbrenElCircuitoYLaSiguienteNiSale(t *testing.T) {
	s, inventory := probe(t)
	s.StubFailure("DELETE", probeRoute, 503)
	// El 5xx no se reintenta (retryOn: [timeout, connection]): diez llamadas, diez peticiones, y el circuito se abre.
	for range 10 {
		if result, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil || result.Cancelled != nil {
			t.Fatalf("CancelStock = %+v, %v; quiero el resultado vacío del fallback", result, err)
		}
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 10 {
		t.Fatalf("%d peticiones, quiero 10", got)
	}
	if result, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil || result.Cancelled != nil {
		t.Fatalf("con el circuito abierto: %+v, %v", result, err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 10 {
		t.Fatalf("con el circuito abierto salió la petición (%d)", got)
	}
}

func TestStubProbeUnRechazoNoSeReintentaYCaeAlFallback(t *testing.T) {
	s, inventory := probe(t)
	s.StubFailure("DELETE", probeRoute, 404)
	if result, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil || result.Cancelled != nil {
		t.Fatalf("CancelStock = %+v, %v; quiero el resultado vacío del fallback", result, err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 1 {
		t.Fatalf("%d peticiones, quiero 1", got)
	}
}

func TestStubProbeUnCuerpoQueViolaElContratoSePropagaYNoEsUnaCaida(t *testing.T) {
	s, inventory := probe(t)
	var contract *clients.ContractError
	s.StubFor("DELETE", probeRoute, 200, "<html>")
	if _, err := inventory.CancelStock(t.Context(), uuid.New()); !errors.As(err, &contract) {
		t.Fatalf("un cuerpo que no es JSON: %v, quiero un *ContractError", err)
	}
	s.ResetStubs()
	s.StubFor("DELETE", probeRoute, 200, map[string]any{"cancelled": "sí"})
	if _, err := inventory.CancelStock(t.Context(), uuid.New()); !errors.As(err, &contract) {
		t.Fatalf("cancelled con otro tipo: %v, quiero un *ContractError", err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 1 {
		t.Fatalf("%d peticiones, quiero 1: un contrato roto no se reintenta", got)
	}
}

func TestStubProbeElResetVaciaLosMappingsYElLog(t *testing.T) {
	s, inventory := probe(t)
	s.StubFor("DELETE", probeRoute, 200, map[string]any{"cancelled": true})
	if _, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	if got := s.StubCallCount("DELETE", probeRoute); got != 1 {
		t.Fatalf("%d llamadas, quiero 1", got)
	}
	s.ResetStubs()
	if got := s.StubCallCount("DELETE", probeRoute); got != 0 {
		t.Fatalf("tras el reset quedan %d llamadas", got)
	}
	// Sin mapping, el stub contesta 404: el adaptador lo trata como rechazo.
	if result, err := inventory.CancelStock(t.Context(), uuid.New()); err != nil || result.Cancelled != nil {
		t.Fatalf("sin mapping: %+v, %v", result, err)
	}
}

func TestStubProbeElCuerpoDeUnaPeticionSeLeeComoJSON(t *testing.T) {
	request := StubRequest{Body: `{"a":1}`}
	body, err := request.JSON()
	object, _ := body.(map[string]any)
	if number, ok := object["a"].(json.Number); err != nil || !ok || number != "1" {
		t.Fatalf("JSON() = %v, %v; quiero {a: 1} con el número como texto", body, err)
	}
}
