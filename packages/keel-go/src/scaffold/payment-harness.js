// La pasarela de pago de prueba en el arnés de keel-go (incremento 13c): una API NEUTRA —los mismos helpers con cualquier
// pasarela, y los mismos nombres que el AbstractFlowIT de keel-spring, el payment-gateway.ts de keel-nest y el
// `Support/PaymentGateway.cs` de keel-dotnet, como métodos del `*Scenario`— para que los escenarios se traduzcan a pruebas
// una sola vez, igual que el diseño se escribe una sola vez. Por debajo, cada helper programa el WireMock de infra/ con la
// forma de la pasarela elegida (keel-core/gen/payment-probes.js) sobre los helpers de http_stub_test.go, y firma los
// avisos como los firmaría ella.
//
// No es un doble dentro del proceso: el servidor habla HTTP con WireMock por el mismo socket que con la pasarela real, con
// el mismo adaptador. Lo que se mide es el servidor. Lo que el stub ENTIENDE de lo que se programa aquí, y que lo que
// devuelve es lo que lee el adaptador emitido, lo mide `npm run stub-check` (scripts/probes/payment_probe_test.go).

import { paymentProbesFor } from '@keel-system/keel-core/gen/payment-probes';
import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS, gatewayTranslation } from '@keel-system/keel-core/gen/payment-gateways';
import { paymentTestCurrency } from '@keel-system/keel-core/gen/payments-config';
import { HTTP_STUB_ENDPOINTS } from '@keel-system/keel-core/gen/http-stub-probes';
import { alignRows, goString, keyedLiteral } from '../lib/go-source.js';

/** El archivo del arnés en tests/integration. */
export const PAYMENT_HARNESS_FILE = 'payment_gateway_test.go';

export const PAYMENT_HARNESS_IMPORTS = ['crypto/hmac', 'crypto/rand', 'crypto/sha256', 'encoding/hex', 'fmt', 'net/http', 'slices', 'strconv', 'strings', 'time'];

export function usesPaymentHarness(model) {
  return Boolean(model.payments);
}

/** La constante Go de una llamada a la pasarela (`SAVE_METHOD` → `CallSaveMethod`). */
export const gatewayCallConstant = (call) => `Call${call.toLowerCase().replace(/(^|_)([a-z])/g, (_, __, letter) => letter.toUpperCase())}`;

/** El cuerpo de tests/integration/payment_gateway_test.go, o null sin capa payments. */
export function paymentHarnessBody(model) {
  if (!usesPaymentHarness(model)) return null;
  const gateway = model.payments.gateway;
  const probes = paymentProbesFor(gateway.id);
  const currency = paymentTestCurrency(model);
  const digits = CURRENCY_MINOR_UNITS[currency] ?? 2;
  const calls = Object.entries(probes.calls);
  const constants = alignRows(calls.map(([call]) => ({ indent: '\t', cells: [gatewayCallConstant(call), `GatewayCall = ${goString(call)}`] }))).join('\n');
  const routes = keyedLiteral(calls.map(([call, route]) => [gatewayCallConstant(call), `{${goString(route.method)}, ${goString(route.path)}}`])).join('\n');
  const specific = gateway.id === 'stripe' ? stripeSpecific(probes) : mercadopagoSpecific(probes);
  return String.raw`
// La pasarela de pago de prueba (capa payments, ${gateway.label}) es el WireMock de infra/docker-compose.yaml hablando el
// protocolo de la pasarela elegida, al que apunta payments.gateway.base-url en el perfil local. La API es NEUTRA —los
// mismos helpers con cualquier pasarela, porque los escenarios no nombran ninguna— y la pasarela de prueba NO tiene
// respuesta por defecto: lo que un escenario no programa en su Given, el stub lo contesta con un 404.

// GatewayCall es una de las llamadas que el servidor le hace a la pasarela de pago.
type GatewayCall string

// Las llamadas a la pasarela.
const (
${constants}
)

// gatewayRoute es el método y la ruta (regex sobre el path, como en StubFor) de una llamada.
type gatewayRoute struct {
	method string
	path   string
}

var gatewayRoutes = map[GatewayCall]gatewayRoute{
${routes}
}

// GatewayNotice es un aviso de la pasarela ya firmado: la ruta (con su query), el cuerpo tal cual viaja y las cabeceras.
type GatewayNotice struct {
	Path   string
	Body   string
	Header http.Header
}

const (
	// paymentWebhookSecret es el secreto con el que el perfil local verifica los avisos (config/parameters/local/payments.yaml).
	paymentWebhookSecret = ${goString(PAYMENT_TEST_SECRETS.webhookSecret)}
	// paymentNoticePath es la ruta del aviso en el servidor.
	paymentNoticePath = ${goString(PAYMENT_NOTICE_PATH)}
	// paymentCurrency es la moneda de los escenarios (el testValue del parámetro de despliegue, o EUR).
	paymentCurrency = ${goString(currency)}
	// paymentCurrencyDigits son los decimales de su unidad menor (la tabla de keel-core).
	paymentCurrencyDigits = ${digits}
)

// GatewayIDFor es el id que la pasarela de prueba asigna al cobro de esa referencia. Es determinista para que el
// escenario pueda nombrarlo antes de pedir el cobro (para un aviso, por ejemplo).
func (s *Scenario) GatewayIDFor(reference string) string {
	return gatewayIDFor(reference)
}

// GatewayAuthorizes hace que el siguiente cobro con esa referencia quede autorizado (importe retenido).
func (s *Scenario) GatewayAuthorizes(reference string) {
	s.Helper()
	s.gatewayAnswers(reference, "AUTHORIZED")
}

// GatewayCharges hace que el siguiente cobro con esa referencia quede cobrado en el acto.
func (s *Scenario) GatewayCharges(reference string) {
	s.Helper()
	s.gatewayAnswers(reference, "CAPTURED")
}

// GatewayRequiresAction hace que el siguiente cobro con esa referencia exija que el cliente se autentique (3DS).
func (s *Scenario) GatewayRequiresAction(reference string) {
	s.Helper()
	s.gatewayAnswers(reference, "ACTION_REQUIRED")
}

// GatewayDeclines hace que el siguiente cobro con esa referencia se rechace, con un motivo del vocabulario neutro
// (declined, insufficientFunds, expiredCard, authenticationFailed, fraudSuspected, invalidPaymentMethod,
// processingError).
func (s *Scenario) GatewayDeclines(reference, reason string) {
	s.Helper()
	if err := s.gatewayDeclines(reference, reason); err != nil {
		s.Fatal(err)
	}
}

// GatewayDoesNotAnswer hace que la pasarela no conteste a esa llamada: corta la conexión. La acción queda EN DUDA.
func (s *Scenario) GatewayDoesNotAnswer(call GatewayCall) {
	s.Helper()
	route := s.gatewayRoute(call)
	s.StubConnectionFault(route.method, route.path)
}

// GatewayReports programa lo que responde la pasarela cuando se le pregunta por el cobro de esa referencia, por su id y
// por la referencia. Con "NOT_FOUND" no lo conoce: la petición no le llegó nunca.
func (s *Scenario) GatewayReports(reference, status string) {
	s.Helper()
	if status == "NOT_FOUND" {
		s.gatewayStubPath(CallStatus, gatewayIDFor(reference), 404, map[string]any{})
		s.gatewayStub(CallSearch, reference, "", 200, map[string]any{"data": []any{}})
		return
	}
	refunded := ""
	if status == "REFUNDED" {
		refunded = "10.00"
	}
	object := s.gatewayObject(reference, status, "", refunded)
	s.gatewayStubPath(CallStatus, gatewayIDFor(reference), 200, object)
	s.gatewayStub(CallSearch, reference, "", 200, map[string]any{"data": []any{object}})
}

// GatewayCaptures hace que la pasarela capture el cobro de esa referencia en el acto.
func (s *Scenario) GatewayCaptures(reference string) {
	s.Helper()
	s.gatewayStubPath(CallCapture, gatewayIDFor(reference), 200, s.gatewayObject(reference, "CAPTURED", "", ""))
}

// GatewayCancels hace que la pasarela anule la autorización del cobro de esa referencia en el acto.
func (s *Scenario) GatewayCancels(reference string) {
	s.Helper()
	s.gatewayStubPath(CallCancel, gatewayIDFor(reference), 200, s.gatewayObject(reference, "CANCELED", "", ""))
}

// GatewayExpiresAuthorization hace que la autorización del cobro de esa referencia haya caducado antes de capturarse:
// la captura se rechaza y, preguntada, la pasarela lo da por anulado. Es el desenlace que la pasarela impone sola
// pasado su plazo (unos días), y ningún escenario puede esperarlo.
func (s *Scenario) GatewayExpiresAuthorization(reference string) {
	s.Helper()
	s.gatewayStubPath(CallCapture, gatewayIDFor(reference), 400, expiredCapture())
	s.GatewayReports(reference, "CANCELED")
}

// GatewayRejects hace que la pasarela rechace esa llamada (4xx): la acción no se hizo. Tras rechazar una captura, una
// anulación o una devolución, el servidor le PREGUNTA a la pasarela el estado real del cobro (el rechazo no lo dice):
// programa también s.GatewayReports(referencia, "AUTHORIZED") —o "CAPTURED" para una devolución—. Sin él la consulta no
// lo encuentra (NOT_FOUND), y un rechazo no se distingue de un cobro que la pasarela no conoce.
func (s *Scenario) GatewayRejects(call GatewayCall) {
	s.Helper()
	route := s.gatewayRoute(call)
	s.StubFor(route.method, route.path, 400, map[string]any{"error": map[string]any{"code": "rejected_by_test"}})
}

// GatewaySavesPaymentMethod hace que la pasarela guarde el medio de pago que se le pase.
func (s *Scenario) GatewaySavesPaymentMethod() {
	s.Helper()
	save, attach := s.gatewayRoute(CallSaveMethod), s.gatewayRoute(CallAttachMethod)
	s.StubFor(save.method, save.path, 200, map[string]any{"id": "cus_keel_test"})
	s.StubFor(attach.method, attach.path, 200, map[string]any{"id": "card_keel_test"})
}

// GatewayRefunds hace que la devolución del cobro de esa referencia se complete por ese importe ("5.00").
func (s *Scenario) GatewayRefunds(reference, amount string) {
	s.Helper()
	if err := s.gatewayRefunds(reference, amount); err != nil {
		s.Fatal(err)
	}
}

// GatewayCallCount es cuántas veces llamó el servidor a la pasarela por esa llamada.
func (s *Scenario) GatewayCallCount(call GatewayCall) int {
	s.Helper()
	route := s.gatewayRoute(call)
	return s.StubCallCount(route.method, route.path)
}

// GatewayRequests son las peticiones que recibió la pasarela por esa llamada (para afirmar cabeceras y cuerpos).
func (s *Scenario) GatewayRequests(call GatewayCall) []StubRequest {
	s.Helper()
	route := s.gatewayRoute(call)
	return s.StubRequests(route.method, route.path)
}

// SendGatewayNotice hace que la pasarela avise de que algo cambió en el cobro de esa referencia, firmado como lo firma
// ella. El servidor no se fía del aviso: le pregunta el estado a la pasarela (programa antes lo que responde con
// s.GatewayReports).
func (s *Scenario) SendGatewayNotice(reference string) *Response {
	s.Helper()
	notice := gatewayNotice(reference, false)
	return s.Post(notice.Path, notice.Body, notice.Header)
}

// SendForgedGatewayNotice manda un aviso con la firma ALTERADA: el servidor tiene que rechazarlo (401) sin consultar
// nada.
func (s *Scenario) SendForgedGatewayNotice(reference string) *Response {
	s.Helper()
	notice := gatewayNotice(reference, true)
	return s.Post(notice.Path, notice.Body, notice.Header)
}

// ─── Lo que hay debajo de los helpers ────────────────────────────────────────────────────────────

func gatewayIDFor(reference string) string {
	return ${goString(probes.idPrefix)} + strings.Map(func(r rune) rune {
		if ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9') {
			return r
		}
		return -1
	}, reference)
}

func (s *Scenario) gatewayRoute(call GatewayCall) gatewayRoute {
	s.Helper()
	route, ok := gatewayRoutes[call]
	if !ok {
		s.Fatalf("llamada a la pasarela desconocida: %q", call)
	}
	return route
}

func (s *Scenario) gatewayAnswers(reference, status string) {
	s.Helper()
	s.gatewayStub(CallCharge, "", reference, 200, s.gatewayObject(reference, status, "", ""))
}

func (s *Scenario) gatewayObject(reference, status, detail, refunded string) map[string]any {
	s.Helper()
	object, err := gatewayObject(reference, status, detail, refunded)
	if err != nil {
		s.Fatal(err)
	}
	return object
}

// gatewayStub programa una llamada: con bodyContains solo casa la petición cuyo cuerpo lo lleve (la referencia), con
// queryContains la que lo lleve en su parámetro de búsqueda. Así conviven varios cobros en el mismo flujo.
func (s *Scenario) gatewayStub(call GatewayCall, queryContains, bodyContains string, status int, body any) {
	s.Helper()
	route := s.gatewayRoute(call)
	s.gatewayMapping(route.method, route.path, queryContains, bodyContains, status, body)
}

// gatewayStubPath programa la ruta concreta de un id (la de captura, anulación o consulta de ESE cobro).
func (s *Scenario) gatewayStubPath(call GatewayCall, gatewayID string, status int, body any) {
	s.Helper()
	route := s.gatewayRoute(call)
	concrete := strings.ReplaceAll(strings.ReplaceAll(route.path, "(?!search)[^/]+", gatewayID), "[^/]+", gatewayID)
	s.gatewayMapping(route.method, concrete, "", "", status, body)
}

func (s *Scenario) gatewayMapping(method, pathPattern, queryContains, bodyContains string, status int, body any) {
	s.Helper()
	request := stubCriterion(method, pathPattern)
	if queryContains != "" {
		request["queryParameters"] = map[string]any{${goString(probes.calls.SEARCH.query)}: map[string]any{"contains": queryContains}}
	}
	if bodyContains != "" {
		request["bodyPatterns"] = []any{map[string]any{"contains": bodyContains}}
	}
	wire, err := RespondOK(status, body).wire()
	if err != nil {
		s.Fatal(err)
	}
	if _, err := stubAdmin(s.Context(), ${goString(HTTP_STUB_ENDPOINTS.mappings)}, map[string]any{"request": request, "response": wire}); err != nil {
		s.Fatal(err)
	}
}

func gatewayHMAC(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func gatewaySecret(forged bool) string {
	if forged {
		return paymentWebhookSecret + "-falso"
	}
	return paymentWebhookSecret
}

func gatewayNow() string {
	return strconv.FormatInt(time.Now().Unix(), 10)
}

// minorUnits es un importe decimal ("10.00") en la unidad menor de la moneda de los escenarios, sin redondear.
func minorUnits(amount string) (int64, error) {
	whole, fraction, _ := strings.Cut(amount, ".")
	if len(fraction) > paymentCurrencyDigits {
		return 0, fmt.Errorf("el importe %s tiene más decimales de los que admite %s", amount, paymentCurrency)
	}
	return strconv.ParseInt(whole+fraction+strings.Repeat("0", paymentCurrencyDigits-len(fraction)), 10, 64)
}

// majorUnits es un importe decimal ("10") con la escala de la moneda de los escenarios ("10.00").
func majorUnits(amount string) string {
	whole, fraction, _ := strings.Cut(amount, ".")
	if paymentCurrencyDigits == 0 {
		return whole
	}
	return whole + "." + fraction + strings.Repeat("0", max(0, paymentCurrencyDigits-len(fraction)))
}

// known es table[key], o un error que dice cuáles hay.
func known[T any](table map[string]T, key, what string) (T, error) {
	value, ok := table[key]
	if !ok {
		keys := make([]string, 0, len(table))
		for name := range table {
			keys = append(keys, name)
		}
		slices.Sort(keys)
		return value, fmt.Errorf("%s desconocido: %q. Los hay: %s", what, key, strings.Join(keys, ", "))
	}
	return value, nil
}
${specific}`;
}

function stripeSpecific(probes) {
  const translation = gatewayTranslation('stripe');
  const statuses = keyedLiteral(Object.entries(probes.statuses).map(([key, value]) => [goString(key), goString(value)])).join('\n');
  const declines = keyedLiteral(Object.entries(probes.declines).map(([key, value]) => [goString(key), goString(value)])).join('\n');
  const intent = keyedLiteral(
    [
      ['"id"', 'id'],
      ['"object"', '"payment_intent"'],
      ['"currency"', 'strings.ToLower(paymentCurrency)'],
      ['"status"', 'state'],
      ['"metadata"', `map[string]any{${goString(translation.referenceKey)}: reference}`],
      ['"client_secret"', 'id + "_secret_test"']
    ],
    '\t\t'
  ).join('\n');
  return String.raw`
var gatewayStatuses = map[string]string{
${statuses}
}

var gatewayDeclineCodes = map[string]string{
${declines}
}

// gatewayObject es un PaymentIntent con la forma que lee el adaptador de Stripe.
func gatewayObject(reference, status, declineCode, refunded string) (map[string]any, error) {
	state, err := known(gatewayStatuses, status, "Estado")
	if err != nil {
		return nil, err
	}
	id := gatewayIDFor(reference)
	intent := map[string]any{
${intent}
	}
	if status == "ACTION_REQUIRED" {
		intent["next_action"] = map[string]any{"type": "use_stripe_sdk"}
	}
	if status == "FAILED" {
		if declineCode == "" {
			declineCode = "generic_decline"
		}
		intent["last_payment_error"] = map[string]any{"code": "card_declined", "decline_code": declineCode}
	}
	if refunded != "" {
		minor, err := minorUnits(refunded)
		if err != nil {
			return nil, err
		}
		intent["latest_charge"] = map[string]any{"amount_refunded": minor, "currency": strings.ToLower(paymentCurrency)}
	}
	return intent, nil
}

// gatewayDeclines programa el rechazo: Stripe rechaza un cobro confirmado con un 402 y el PaymentIntent dentro del
// error. El de autenticación no: un 402 authentication_required es una ACCIÓN del cliente pendiente, así que ese motivo
// llega como el PaymentIntent fallido.
func (s *Scenario) gatewayDeclines(reference, reason string) error {
	s.Helper()
	code, err := known(gatewayDeclineCodes, reason, "Motivo")
	if err != nil {
		return err
	}
	failed, err := gatewayObject(reference, "FAILED", code, "")
	if err != nil {
		return err
	}
	if reason == "authenticationFailed" {
		s.gatewayStub(CallCharge, "", reference, 200, failed)
		return nil
	}
	s.gatewayStub(CallCharge, "", reference, 402, map[string]any{
		"error": map[string]any{"type": "card_error", "code": "card_declined", "decline_code": code, "payment_intent": failed},
	})
	return nil
}

// expiredCapture es lo que contesta Stripe a capturar una autorización caducada: el adaptador lee ese código.
func expiredCapture() map[string]any {
	return map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": ${goString(translation.expiredCaptureMarker)}}}
}

func (s *Scenario) gatewayRefunds(reference, amount string) error {
	s.Helper()
	minor, err := minorUnits(amount)
	if err != nil {
		return err
	}
	id := gatewayIDFor(reference)
	s.gatewayStub(CallRefund, "", id, 200, map[string]any{
		"id":             "re_" + id,
		"status":         "succeeded",
		"amount":         minor,
		"currency":       strings.ToLower(paymentCurrency),
		"payment_intent": id,
	})
	return nil
}

// gatewayNotice es un aviso firmado como Stripe: ${probes.notice.signatureHeader}: t=…,v1=HMAC(t.cuerpo).
func gatewayNotice(reference string, forged bool) GatewayNotice {
	id := gatewayIDFor(reference)
	body := fmt.Sprintf(` + '`' + String.raw`{"id":%q,"type":"payment_intent.updated","data":{"object":{"id":%q,"object":"payment_intent"}}}` + '`' + String.raw`, "evt_"+id, id)
	t := gatewayNow()
	header := http.Header{}
	header.Set(${goString(probes.notice.signatureHeader)}, "t="+t+",v1="+gatewayHMAC(gatewaySecret(forged), t+"."+body))
	return GatewayNotice{Path: paymentNoticePath, Body: body, Header: header}
}

`;
}

function mercadopagoSpecific(probes) {
  const translation = gatewayTranslation('mercadopago');
  const statuses = keyedLiteral(Object.entries(probes.statuses).map(([key, [status, detail]]) => [goString(key), `{${goString(status)}, ${goString(detail)}}`])).join('\n');
  const declines = keyedLiteral(Object.entries(probes.declines).map(([key, value]) => [goString(key), goString(value)])).join('\n');
  const order = keyedLiteral(
    [
      ['"id"', 'id'],
      ['"status"', 'state.status'],
      ['"status_detail"', 'detail'],
      [goString(translation.referenceKey), 'reference'],
      ['"currency"', 'paymentCurrency'],
      ['"transactions"', 'transactions']
    ],
    '\t\t'
  ).join('\n');
  return String.raw`
// gatewayState es el status y el status_detail de una order.
type gatewayState struct {
	status string
	detail string
}

var gatewayStatuses = map[string]gatewayState{
${statuses}
}

var gatewayDeclineDetails = map[string]string{
${declines}
}

// gatewayObject es una order con la forma que lee el adaptador de MercadoPago.
func gatewayObject(reference, status, detail, refunded string) (map[string]any, error) {
	state, err := known(gatewayStatuses, status, "Estado")
	if err != nil {
		return nil, err
	}
	if detail == "" {
		detail = state.detail
	}
	id := gatewayIDFor(reference)
	transactions := map[string]any{
		"payments": []any{map[string]any{
			"id":             "PAY" + id,
			"status_detail":  detail,
			"payment_method": map[string]any{"type": "credit_card", "url": "https://pasarela.test/3ds/" + id},
		}},
	}
	if refunded != "" {
		transactions["refunds"] = []any{map[string]any{"amount": majorUnits(refunded)}}
	}
	return map[string]any{
${order}
	}, nil
}

func (s *Scenario) gatewayDeclines(reference, reason string) error {
	s.Helper()
	detail, err := known(gatewayDeclineDetails, reason, "Motivo")
	if err != nil {
		return err
	}
	failed, err := gatewayObject(reference, "FAILED", detail, "")
	if err != nil {
		return err
	}
	s.gatewayStub(CallCharge, "", reference, 200, failed)
	return nil
}

// expiredCapture: MercadoPago no documenta un código para la captura caducada, así que el adaptador consulta el estado.
func expiredCapture() map[string]any {
	return map[string]any{"errors": []any{map[string]any{"code": "order_expired"}}}
}

// gatewayRefunds programa también la consulta de la order (capturada), porque una devolución parcial la lee antes para
// nombrar la transacción.
func (s *Scenario) gatewayRefunds(reference, amount string) error {
	s.Helper()
	captured, err := gatewayObject(reference, "CAPTURED", "", "")
	if err != nil {
		return err
	}
	refunded, err := gatewayObject(reference, "REFUNDED", "", amount)
	if err != nil {
		return err
	}
	s.gatewayStubPath(CallStatus, gatewayIDFor(reference), 200, captured)
	s.gatewayStubPath(CallRefund, gatewayIDFor(reference), 200, refunded)
	return nil
}

// gatewayNotice es un aviso firmado como MercadoPago: la firma es del manifiesto
// id:<data.id>;request-id:<x-request-id>;ts:<ts>; —no del cuerpo— y el id viaja en la query.
func gatewayNotice(reference string, forged bool) GatewayNotice {
	id := gatewayIDFor(reference)
	requestID := rand.Text()
	ts := gatewayNow()
	manifest := "id:" + strings.ToLower(id) + ";request-id:" + requestID + ";ts:" + ts + ";"
	body := fmt.Sprintf(` + '`' + String.raw`{"action":"order.updated","type":"order","data":{"id":%q}}` + '`' + String.raw`, id)
	header := http.Header{}
	header.Set(${goString(probes.notice.signatureHeader)}, "ts="+ts+",v1="+gatewayHMAC(gatewaySecret(forged), manifest))
	header.Set(${goString(translation.notice.requestIdHeader)}, requestID)
	return GatewayNotice{Path: paymentNoticePath + "?${translation.notice.dataIdQuery}=" + id + "&type=order", Body: body, Header: header}
}
`;
}
