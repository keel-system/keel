//go:build integration

// La pasarela de pago de prueba de keel-go contra un WireMock REAL (incremento 13c), con las dos pasarelas.
//
// Lo que la prueba emitida <pasarela>_test.go no puede juzgar —allí la pasarela es un httptest con las formas del doble—:
// que lo que programan los métodos de tests/integration/payment_gateway_test.go lo ENTIENDA el stub de verdad y que lo
// que el stub devuelve sea lo que lee el adaptador emitido. Cada helper, su desenlace: el cobro casado por la referencia
// en el cuerpo, la consulta por id y por referencia, la captura, la anulación, la devolución, guardar un medio, el corte,
// el rechazo; y el aviso que firma el arnés lo acepta el verificador emitido, y el falsificado no. Los mismos casos que
// las PaymentProbes de keel-dotnet.
//
// Es NEUTRAL: el mismo archivo para las dos pasarelas (stub-check lo copia a un payment-checkout generado con cada una), y
// la pasarela la elige lo emitido (payment.NewGateway). No es una prueba del proyecto generado: la copia a
// tests/integration y la ejecuta `npm run stub-check`. Construye el escenario sin StartFlow, así que el servidor del
// servicio no arranca: solo hablan el arnés, el adaptador y el stub.

package integration

import (
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"__MODULE__/internal/domain"
	"__MODULE__/internal/infrastructure/payment"
	"__MODULE__/internal/platform/wire"
)

// paymentProbe es un escenario sin servidor, con el stub vacío, y la pasarela emitida apuntando a este WireMock con el
// secreto con el que firma el arnés.
func paymentProbe(t *testing.T) (*Scenario, domain.PaymentGateway, payment.Settings) {
	t.Helper()
	s := &Scenario{T: t}
	s.ResetStubs()
	baseURL := os.Getenv("STUB_CHECK_BASE_URL")
	if baseURL == "" {
		t.Fatal("STUB_CHECK_BASE_URL: la URL del WireMock")
	}
	settings := payment.Settings{
		BaseURL:         baseURL,
		APIKey:          "keel-test-api-key",
		WebhookSecret:   paymentWebhookSecret,
		ConnectTimeout:  2 * time.Second,
		ReadTimeout:     5 * time.Second,
		NoticeTolerance: 300 * time.Second,
		UnansweredAfter: 900 * time.Second,
		BatchSize:       50,
	}
	return s, payment.NewGateway(settings), settings
}

func probeCharge(t *testing.T, reference string) domain.ChargeRequest {
	t.Helper()
	source, err := domain.TokenSource("tok_keel")
	if err != nil {
		t.Fatal(err)
	}
	request, err := domain.NewChargeRequest(reference, wire.MustDecimal("25.90"), paymentCurrency, source)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func TestPaymentProbeCadaCobroCasaPorSuReferenciaYLlevaSuClave(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewayAuthorizes("ch-a")
	s.GatewayDeclines("ch-b", "insufficientFunds")
	authorized, err := gateway.Authorize(t.Context(), probeCharge(t, "ch-a"))
	if err != nil {
		t.Fatal(err)
	}
	if authorized.Status != domain.GatewayAuthorized || authorized.GatewayPaymentID != s.GatewayIDFor("ch-a") || authorized.Reference != "ch-a" {
		t.Errorf("Authorize(ch-a) = %+v, quiero autorizado con el id %s y su referencia", authorized, s.GatewayIDFor("ch-a"))
	}
	declined, err := gateway.Authorize(t.Context(), probeCharge(t, "ch-b"))
	if err != nil {
		t.Fatal(err)
	}
	if declined.Status != domain.GatewayFailed || declined.FailureReason != domain.PaymentFailureReasonInsufficientFunds {
		t.Errorf("Authorize(ch-b) = %+v, quiero fallido por insufficientFunds", declined)
	}
	requests := s.GatewayRequests(CallCharge)
	if len(requests) != 2 {
		t.Fatalf("la pasarela recibió %d cobros, quiero 2", len(requests))
	}
	keyed := false
	for _, request := range requests {
		if request.Header("Idempotency-Key") == "ch-a:authorize" || request.Header("X-Idempotency-Key") == "ch-a:authorize" {
			keyed = true
		}
	}
	if !keyed {
		t.Errorf("ningún cobro lleva la clave ch-a:authorize: %+v", requests)
	}
}

func TestPaymentProbeElCobroInmediatoYLaAccionDelCliente(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewayCharges("ch-c")
	s.GatewayRequiresAction("ch-d")
	captured, err := gateway.Authorize(t.Context(), probeCharge(t, "ch-c"))
	if err != nil || captured.Status != domain.GatewayCaptured {
		t.Errorf("Authorize(ch-c) = %+v, %v; quiero cobrado en el acto", captured, err)
	}
	action, err := gateway.Authorize(t.Context(), probeCharge(t, "ch-d"))
	if err != nil || action.Status != domain.GatewayActionRequired || action.CustomerAction == "" {
		t.Errorf("Authorize(ch-d) = %+v, %v; quiero una acción del cliente con su contenido", action, err)
	}
}

func TestPaymentProbeCadaMotivoDelArnesVuelveComoEseMotivo(t *testing.T) {
	for reason, want := range map[string]domain.PaymentFailureReason{
		"declined":             domain.PaymentFailureReasonDeclined,
		"expiredCard":          domain.PaymentFailureReasonExpiredCard,
		"authenticationFailed": domain.PaymentFailureReasonAuthenticationFailed,
		"fraudSuspected":       domain.PaymentFailureReasonFraudSuspected,
		"invalidPaymentMethod": domain.PaymentFailureReasonInvalidPaymentMethod,
		"processingError":      domain.PaymentFailureReasonProcessingError,
	} {
		t.Run(reason, func(t *testing.T) {
			s, gateway, _ := paymentProbe(t)
			s.GatewayDeclines("ch-r", reason)
			outcome, err := gateway.Authorize(t.Context(), probeCharge(t, "ch-r"))
			if err != nil || outcome.Status != domain.GatewayFailed || outcome.FailureReason != want {
				t.Errorf("Authorize = %+v, %v; quiero fallido por %s", outcome, err, want)
			}
		})
	}
}

func TestPaymentProbeSinRespuestaLaAccionQuedaEnDudaYNoSeRepite(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewayDoesNotAnswer(CallCharge)
	_, err := gateway.Authorize(t.Context(), probeCharge(t, "ch-e"))
	var unavailable *domain.PaymentGatewayUnavailableError
	if !errors.As(err, &unavailable) {
		t.Errorf("Authorize = %v, quiero un *domain.PaymentGatewayUnavailableError", err)
	}
	if got := s.GatewayCallCount(CallCharge); got != 1 {
		t.Errorf("la pasarela recibió %d cobros: una escritura en duda no se repite", got)
	}
}

func TestPaymentProbeLaConsultaPorIdYPorReferenciaDicenLoProgramado(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	ctx := t.Context()
	s.GatewayReports("ch-f", "CAPTURED")
	if got, err := gateway.Status(ctx, "", s.GatewayIDFor("ch-f")); err != nil || got.Status != domain.GatewayCaptured {
		t.Errorf("Status por id = %+v, %v; quiero cobrado", got, err)
	}
	if got, err := gateway.Status(ctx, "ch-f", ""); err != nil || got.Status != domain.GatewayCaptured || got.GatewayPaymentID != s.GatewayIDFor("ch-f") {
		t.Errorf("Status por referencia = %+v, %v; quiero cobrado con su id", got, err)
	}
	s.GatewayReports("ch-g", "NOT_FOUND")
	if got, err := gateway.Status(ctx, "", s.GatewayIDFor("ch-g")); err != nil || got.Status != domain.GatewayNotFound {
		t.Errorf("Status por id de uno desconocido = %+v, %v; quiero NOT_FOUND", got, err)
	}
	if got, err := gateway.Status(ctx, "ch-g", ""); err != nil || got.Status != domain.GatewayNotFound {
		t.Errorf("Status por referencia de uno desconocido = %+v, %v; quiero NOT_FOUND", got, err)
	}
	s.GatewayReports("ch-h", "REFUNDED")
	refunded, err := gateway.Status(ctx, "", s.GatewayIDFor("ch-h"))
	if err != nil || refunded.Status != domain.GatewayRefunded || refunded.RefundedAmount == nil || refunded.RefundedAmount.Cmp(wire.MustDecimal("10.00")) != 0 {
		t.Errorf("Status de uno devuelto = %+v, %v; quiero devuelto por 10.00", refunded, err)
	}
}

func TestPaymentProbeCapturaAnulacionYAutorizacionCaducada(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	ctx := t.Context()
	s.GatewayCaptures("ch-i")
	if got, err := gateway.Capture(ctx, "ch-i", s.GatewayIDFor("ch-i")); err != nil || got.Status != domain.GatewayCaptured {
		t.Errorf("Capture = %+v, %v; quiero cobrado", got, err)
	}
	s.GatewayCancels("ch-j")
	if got, err := gateway.VoidAuthorization(ctx, "ch-j", s.GatewayIDFor("ch-j")); err != nil || got.Status != domain.GatewayCanceled {
		t.Errorf("VoidAuthorization = %+v, %v; quiero anulado", got, err)
	}
	s.GatewayExpiresAuthorization("ch-k")
	if got, err := gateway.Capture(ctx, "ch-k", s.GatewayIDFor("ch-k")); err != nil || got.Status != domain.GatewayCanceled {
		t.Errorf("Capture de una autorización caducada = %+v, %v; quiero anulado", got, err)
	}
}

func TestPaymentProbeLaDevolucionParcialSeCompletaPorSuImporte(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewayRefunds("ch-l", "5.00")
	amount := wire.MustDecimal("5.00")
	outcome, err := gateway.Refund(t.Context(), "ch-l", s.GatewayIDFor("ch-l"), &amount, paymentCurrency)
	if err != nil || outcome.Status != domain.GatewayRefunded || outcome.RefundedAmount == nil || outcome.RefundedAmount.Cmp(amount) != 0 {
		t.Errorf("Refund = %+v, %v; quiero devuelto por 5.00", outcome, err)
	}
}

func TestPaymentProbeGuardarUnMedioYSuRechazo(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewaySavesPaymentMethod()
	saved, err := gateway.SavePaymentMethod(t.Context(), "tok_keel", "payer-1")
	if err != nil || !strings.HasPrefix(saved, "cus_keel_test|") {
		t.Errorf("SavePaymentMethod = %q, %v; quiero la referencia opaca cus_keel_test|…", saved, err)
	}
	s.ResetStubs()
	s.GatewayRejects(CallSaveMethod)
	_, err = gateway.SavePaymentMethod(t.Context(), "tok_keel", "payer-1")
	var rejected *domain.GatewayRejectedPaymentMethodError
	if !errors.As(err, &rejected) {
		t.Errorf("SavePaymentMethod rechazado = %v, quiero un *domain.GatewayRejectedPaymentMethodError", err)
	}
}

func TestPaymentProbeElAvisoQueFirmaElArnesLoAceptaElVerificadorYElFalsificadoNo(t *testing.T) {
	s, _, settings := paymentProbe(t)
	verifier := payment.NewNoticeVerifier(settings)
	if got, err := verifier.Verify(received(t, gatewayNotice("ch-m", false))); err != nil || got != s.GatewayIDFor("ch-m") {
		t.Errorf("Verify del aviso del arnés = %q, %v; quiero %s", got, err, s.GatewayIDFor("ch-m"))
	}
	_, err := verifier.Verify(received(t, gatewayNotice("ch-m", true)))
	var invalid *domain.InvalidPaymentNoticeError
	if !errors.As(err, &invalid) {
		t.Errorf("Verify del aviso falsificado = %v, quiero un *domain.InvalidPaymentNoticeError", err)
	}
}

// received es el aviso como lo recibe el endpoint: el cuerpo, las cabeceras y los parámetros de la URL.
func received(t *testing.T, notice GatewayNotice) domain.PaymentNotice {
	t.Helper()
	target, err := url.Parse(notice.Path)
	if err != nil {
		t.Fatal(err)
	}
	return domain.NewPaymentNotice(notice.Body, notice.Header, target.Query())
}
