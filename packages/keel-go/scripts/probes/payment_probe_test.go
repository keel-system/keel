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
	// payment-checkout sigue cada devolución (refund.reference): la consulta del cobro no dice nada de devoluciones, y
	// GatewayReports(…, "REFUNDED") lo dice en vez de programar otra cosa.
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
	outcome, err := gateway.Refund(t.Context(), "ch-l", "rf-l", s.GatewayIDFor("ch-l"), &amount, paymentCurrency)
	if err != nil || outcome.Status != domain.GatewayRefunded || outcome.RefundedAmount == nil || outcome.RefundedAmount.Cmp(amount) != 0 {
		t.Errorf("Refund = %+v, %v; quiero devuelto por 5.00", outcome, err)
	}
}

// Corrida payment-go: con la clave del cobro, la segunda devolución parcial reutilizaba la de la primera y la pasarela la
// rechazaba (otro importe) o devolvía la respuesta guardada de la primera sin devolver nada (el mismo).
func TestPaymentProbeDosDevolucionesDelMismoCobroLlevanCadaUnaSuClave(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewayRefunds("ch-m", "2.00")
	amount := wire.MustDecimal("2.00")
	for _, refundReference := range []string{"rf-1", "rf-2"} {
		if _, err := gateway.Refund(t.Context(), "ch-m", refundReference, s.GatewayIDFor("ch-m"), &amount, paymentCurrency); err != nil {
			t.Fatal(err)
		}
	}
	var keys []string
	for _, request := range s.GatewayRequests(CallRefund) {
		key := request.Header("Idempotency-Key")
		if key == "" {
			key = request.Header("X-Idempotency-Key")
		}
		keys = append(keys, key)
	}
	if len(keys) != 2 || keys[0] != "ch-m:refund:rf-1" || keys[1] != "ch-m:refund:rf-2" {
		t.Errorf("claves de las dos devoluciones = %v; quiero [ch-m:refund:rf-1 ch-m:refund:rf-2]", keys)
	}
}

func TestPaymentProbeGuardarUnMedioYSuRechazo(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewaySavesPaymentMethod()
	saved, err := gateway.SavePaymentMethod(t.Context(), "tok_keel", "payer-1")
	if err != nil || !strings.HasPrefix(saved.Reference, "cus_keel_test|") {
		t.Errorf("SavePaymentMethod = %+v, %v; quiero la referencia opaca cus_keel_test|…", saved, err)
	}
	s.ResetStubs()
	s.GatewayRejects(CallSaveMethod)
	_, err = gateway.SavePaymentMethod(t.Context(), "tok_keel", "payer-1")
	var rejected *domain.GatewayRejectedPaymentMethodError
	if !errors.As(err, &rejected) {
		t.Errorf("SavePaymentMethod rechazado = %v, quiero un *domain.GatewayRejectedPaymentMethodError", err)
	}
}

// DSL 2.33 y G12 (inc. 6c de PLAN-CORRIDAS-GELSA.md): lo que programan los helpers nuevos, leído por el adaptador emitido.
func TestPaymentProbeGuardarConUnaTarjetaConcretaYEl3DSDondeLaPasarelaLoPide(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	s.GatewaySavesCard("amex", "0005", 3, 2029)
	saved, err := gateway.SavePaymentMethod(t.Context(), "tok_keel", "payer-2")
	want := domain.GatewaySavedCard{Brand: "amex", Last4: "0005", ExpMonth: 3, ExpYear: 2029}
	if err != nil || saved.Card != want {
		t.Errorf("SavePaymentMethod = %+v, %v; quiero la tarjeta %+v", saved, err, want)
	}
	// Solo Stripe pide 3DS al guardar (la ruta del último paso es la del attach); con MercadoPago el helper para el escenario.
	if !strings.HasSuffix(gatewayRoutes[CallAttachMethod].path, "/attach") {
		return
	}
	s.GatewayRequiresAuthenticationToSave()
	_, err = gateway.SavePaymentMethod(t.Context(), "tok_3ds", "payer-3")
	var asked *domain.PaymentMethodAuthenticationRequiredError
	if !errors.As(err, &asked) {
		t.Errorf("SavePaymentMethod con 3DS = %v, quiero un *domain.PaymentMethodAuthenticationRequiredError", err)
	}
}

func TestPaymentProbeLaDevolucionEnVueloLlevaSuImporteYAnulacionQueFallaConSuMotivo(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	ctx := t.Context()
	// Corrida payment-spring: el importe es el de ESTA devolución (2.50), no el acumulado (7.50), y una devolución que no
	// llegó no está hecha aunque hubiera otra antes.
	s.GatewayReportsRefund("ch-n", "rf-n", "REFUNDED", "2.50", "5.00")
	refunded, err := gateway.RefundStatus(ctx, "ch-n", "rf-n", s.GatewayIDFor("ch-n"), wire.MustDecimal("5.00"))
	if err != nil || refunded.Status != domain.GatewayRefunded || refunded.RefundedAmount == nil || refunded.RefundedAmount.Cmp(wire.MustDecimal("2.50")) != 0 {
		t.Errorf("RefundStatus = %+v, %v; quiero devuelto por 2.50", refunded, err)
	}
	s.GatewayReportsRefund("ch-q", "rf-q", "MISSING", "2.50", "5.00")
	if missing, err := gateway.RefundStatus(ctx, "ch-q", "rf-q", s.GatewayIDFor("ch-q"), wire.MustDecimal("5.00")); err != nil || missing.Status != domain.GatewayCaptured {
		t.Errorf("RefundStatus de una que no llegó = %+v, %v; quiero GatewayCaptured", missing, err)
	}
	s.GatewayCancelFails("ch-o", "authenticationFailed")
	failed, err := gateway.VoidAuthorization(ctx, "ch-o", s.GatewayIDFor("ch-o"))
	if err != nil || failed.Status != domain.GatewayFailed || failed.FailureReason != domain.PaymentFailureReasonAuthenticationFailed {
		t.Errorf("VoidAuthorization = %+v, %v; quiero fallido por authenticationFailed", failed, err)
	}
}

func TestPaymentProbeLaPasarelaRetieneSuRespuestaYDespuesContesta(t *testing.T) {
	s, gateway, _ := paymentProbe(t)
	ctx := t.Context()
	s.GatewayAnswersLate(CallCharge, "ch-p", "AUTHORIZED", 400*time.Millisecond)
	started := time.Now()
	if got, err := gateway.Authorize(ctx, probeCharge(t, "ch-p")); err != nil || got.Status != domain.GatewayAuthorized {
		t.Errorf("Authorize = %+v, %v; quiero autorizado", got, err)
	}
	if elapsed := time.Since(started); elapsed < 350*time.Millisecond {
		t.Errorf("la respuesta llegó en %v: quiero que la pasarela la retenga", elapsed)
	}
	s.GatewayAnswersLate(CallCapture, "ch-q", "CAPTURED", 50*time.Millisecond)
	if got, err := gateway.Capture(ctx, "ch-q", s.GatewayIDFor("ch-q")); err != nil || got.Status != domain.GatewayCaptured {
		t.Errorf("Capture = %+v, %v; quiero cobrado", got, err)
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
