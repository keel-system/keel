// El adaptador de Stripe (Payment Intents) y su verificador de avisos, para keel-go.
//
// Es la traducción del de keel-nest y keel-dotnet, caso por caso, y habla el MISMO contrato (keel-core/gen/payment-gateways.js:
// la clave de idempotencia, las claves de metadata, los rechazos, la marca de la captura caducada):
//   * cuerpos application/x-www-form-urlencoded, con los campos en el orden de los otros tres; credencial como Bearer;
//   * importe entero en la unidad menor, con la tabla de keel-core;
//   * Idempotency-Key en todo POST; un 5xx no se reintenta: queda en duda;
//   * Stripe-Signature: t=…,v1=…[,v1=…]: HMAC-SHA256 de `${t}.${cuerpo}`; solo cuenta v1, puede haber varias durante la
//     rotación del secreto, y se compara en tiempo constante (hmac.Equal).

import { gatewayTranslation } from '@keel-system/keel-core/gen/payment-gateways';
import { goString } from '../../lib/go-source.js';
import { alignRows } from '../../lib/go-source.js';
import { packageFile } from '../render.js';
import { reasonConstant } from '../payments.js';

const TRANSLATION = gatewayTranslation('stripe');

export function generate(model, infra) {
  return [
    {
      path: `${infra.dir}/stripe.go`,
      content: packageFile(model, infra, {
        imports: ['cmp', 'context', 'crypto/hmac', 'crypto/sha256', 'encoding/hex', 'net/http', 'net/url', 'strconv', 'strings', 'time', 'internal/domain', 'internal/platform/wire'],
        body: adapterBody(model) + verifierBody(model)
      })
    }
  ];
}

function adapterBody(model) {
  const p = model.payments;
  const F = `domain.${p.record.failureReasonType}`;
  const declines = alignRows(TRANSLATION.declines.map(([code, literal]) => ({ indent: '\t', cells: [`${goString(code)}:`, `domain.${reasonConstant(model, literal)},`] })));
  const partialCapture = Boolean(p.capture?.amount);
  const partialRefund = Boolean(p.refund?.amount);
  const amountLine = (field) => `
	if amount != nil {
		minor, err := toMinorUnits(*amount, currency)
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		form.add(${goString(field)}, minor)
	}`;
  const methods = [];
  methods.push(`// Authorize implementa domain.PaymentGateway.
func (g *stripeGateway) Authorize(ctx context.Context, request domain.ChargeRequest) (domain.GatewayOutcome, error) {
	amount, err := toMinorUnits(request.Amount(), request.Currency())
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	form := &formBody{}
	form.add("amount", amount)
	form.add("currency", strings.ToLower(request.Currency()))
	form.add("capture_method", ${goString(p.captureLater ? 'manual' : 'automatic')})
	form.add("confirm", "true")
	form.add("payment_method_types[]", "card")
	form.add("metadata["+stripeReferenceKey+"]", request.Reference())
	if request.Source().Kind() == domain.PaymentSourceSaved {
		// La referencia guardada es <cliente>|<medio> (SavePaymentMethod).
		customer, paymentMethod, err := splitSaved(request.Source().Value())
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		form.add("customer", customer)
		form.add("payment_method", paymentMethod)
		form.add("off_session", "true")
	} else {
		form.add("payment_method", request.Source().Value())
	}
	answer, err := g.send(ctx, "authorize", http.MethodPost, "/v1/payment_intents", form, idempotencyKey(request.Reference(), "authorize"))
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 500 {
		return domain.GatewayOutcome{}, unavailableAnswer("Stripe", "authorize", answer)
	}
	body, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 400 {
		return stripeDeclined(body, request.Reference())
	}
	return stripeOutcome(body, request.Reference())
}`);
  if (p.capture) {
    methods.push(`// Capture implementa domain.PaymentGateway.
func (g *stripeGateway) Capture(ctx context.Context, reference, gatewayPaymentID string${partialCapture ? ', amount *wire.Decimal, currency string' : ''}) (domain.GatewayOutcome, error) {
	form := &formBody{}${partialCapture ? amountLine('amount_to_capture') : ''}
	return g.followUp(ctx, "/v1/payment_intents/"+url.PathEscape(gatewayPaymentID)+"/capture", form, reference, gatewayPaymentID, "capture")
}`);
  }
  if (p.void) {
    methods.push(`// VoidAuthorization implementa domain.PaymentGateway.
func (g *stripeGateway) VoidAuthorization(ctx context.Context, reference, gatewayPaymentID string) (domain.GatewayOutcome, error) {
	return g.followUp(ctx, "/v1/payment_intents/"+url.PathEscape(gatewayPaymentID)+"/cancel", &formBody{}, reference, gatewayPaymentID, "void")
}`);
  }
  if (p.refund) {
    methods.push(`// Refund implementa domain.PaymentGateway.
func (g *stripeGateway) Refund(ctx context.Context, reference, gatewayPaymentID string${partialRefund ? ', amount *wire.Decimal, currency string' : ''}) (domain.GatewayOutcome, error) {
	form := &formBody{}
	form.add("payment_intent", gatewayPaymentID)${partialRefund ? amountLine('amount') : ''}
	answer, err := g.send(ctx, "refund", http.MethodPost, "/v1/refunds", form, idempotencyKey(reference, "refund"))
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 500 {
		return domain.GatewayOutcome{}, unavailableAnswer("Stripe", "refund", answer)
	}
	if answer.status >= 400 {
		// Rechazada: el cobro sigue capturado.
		return domain.NewGatewayOutcome(domain.GatewayCaptured, reference, gatewayPaymentID), nil
	}
	refund, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	switch textOf(refund["status"]) {
	case "succeeded":
		refunded, err := fromMinorUnits(minorOf(refund["amount"]), strings.ToUpper(textOf(refund["currency"])))
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		return domain.RefundedOutcome(reference, gatewayPaymentID, refunded), nil
	case "pending", "requires_action":
		return domain.NewGatewayOutcome(domain.GatewayPending, reference, gatewayPaymentID), nil
	}
	return domain.NewGatewayOutcome(domain.GatewayCaptured, reference, gatewayPaymentID), nil
}`);
  }
  methods.push(`// Status implementa domain.PaymentGateway.
func (g *stripeGateway) Status(ctx context.Context, reference, gatewayPaymentID string) (domain.GatewayOutcome, error) {
	path := "/v1/payment_intents/" + url.PathEscape(gatewayPaymentID) + "?expand[]=latest_charge"
	if gatewayPaymentID == "" {
		// Sin id: la pasarela no llegó a contestar. Se busca por la referencia que se le mandó en metadata. La búsqueda de
		// Stripe es eventualmente consistente (puede tardar un minuto en ver un PaymentIntent recién creado): por eso el
		// barrido solo mira lo que lleva más del umbral esperando, y un GatewayNotFound aquí significa que no llegó.
		query := &formBody{}
		query.add("query", "metadata['"+stripeReferenceKey+"']:'"+reference+"'")
		query.add("expand[]", "data.latest_charge")
		path = "/v1/payment_intents/search?" + query.encode()
	}
	answer, err := g.send(ctx, "status", http.MethodGet, path, nil, "")
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status == http.StatusNotFound {
		return domain.NotFoundOutcome(reference), nil
	}
	if answer.status >= 400 {
		return domain.GatewayOutcome{}, unavailableAnswer("Stripe", "status", answer)
	}
	body, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if gatewayPaymentID != "" {
		return stripeOutcome(body, reference)
	}
	if list, ok := body["data"].([]any); ok && len(list) > 0 && isObject(list[0]) {
		return stripeOutcome(objectOf(list[0]), reference)
	}
	return domain.NotFoundOutcome(reference), nil
}`);
  if (p.savePaymentMethod) {
    const [customerStep, attachStep] = TRANSLATION.savedMethodSteps;
    methods.push(`// SavePaymentMethod implementa domain.PaymentGateway: el cliente de Stripe y el medio adjunto a él.
func (g *stripeGateway) SavePaymentMethod(ctx context.Context, token, payerReference string) (string, error) {
	customerForm := &formBody{}
	customerForm.add(${goString(`metadata[${TRANSLATION.payerKey}]`)}, payerReference)
	customer, err := g.send(ctx, "savePaymentMethod", http.MethodPost, "/v1/customers", customerForm, savedKey(token, ${goString(customerStep)}))
	if err := rejectedMethod(customer, err); err != nil {
		return "", err
	}
	created, err := decodeObject(customer.text)
	if err != nil {
		return "", err
	}
	customerID := textOf(created["id"])
	attachForm := &formBody{}
	attachForm.add("customer", customerID)
	attach, err := g.send(ctx, "savePaymentMethod", http.MethodPost, "/v1/payment_methods/"+url.PathEscape(token)+"/attach", attachForm, savedKey(token, ${goString(attachStep)}))
	if err := rejectedMethod(attach, err); err != nil {
		return "", err
	}
	return customerID + savedMethodSeparator + token, nil
}`);
  }
  return `
// stripeReferenceKey es la clave de metadata con la que viaja la referencia del cobro; es lo que permite buscarlo.
const stripeReferenceKey = ${goString(TRANSLATION.referenceKey)}

// stripeIdempotencyHeader es la cabecera con la que Stripe recibe la clave de idempotencia.
const stripeIdempotencyHeader = ${goString(p.gateway.idempotencyHeader)}

// stripeDeclines traduce el decline_code (o el code si no hay) al motivo neutro (keel-core/gen/payment-gateways.js); lo que no
// está aquí es un rechazo sin más.
var stripeDeclines = map[string]${F}{
${declines.join('\n')}
}

// stripeGateway es la pasarela de pago sobre Stripe (Payment Intents), por HTTP plano. Lo que lleva dentro y no puede faltar:
//   - la clave de idempotencia sale de la referencia de negocio y la acción (<referencia>:authorize…), nunca de un
//     aleatorio: un reintento repite la clave;
//   - un 5xx o un plazo vencido NO se reintenta: devuelve un *domain.PaymentGatewayUnavailableError y la acción queda en
//     duda para el barrido (Stripe guarda también los 500 con su clave);
//   - el importe se convierte a la unidad menor sin redondear;
//   - los rechazos se traducen al vocabulario neutro de ${p.record.failureReasonType}.
type stripeGateway struct {
	http *gatewayHTTP
}

var _ domain.PaymentGateway = (*stripeGateway)(nil)

// NewGateway es el adaptador de domain.PaymentGateway de la pasarela del stack (Stripe).
func NewGateway(settings Settings) domain.PaymentGateway {
	return &stripeGateway{http: newGatewayHTTP(settings)}
}

${methods.join('\n\n')}

// send manda una petición a Stripe; «no contestó» sale como la duda del dominio.
func (g *stripeGateway) send(ctx context.Context, action, method, path string, form *formBody, key string) (gatewayAnswer, error) {
	request := gatewayRequest{method: method, path: path}
	if form != nil {
		request.contentType, request.body = formContentType, form.encode()
	}
	if key != "" {
		request.idempotencyHeader, request.idempotencyKey = stripeIdempotencyHeader, key
	}
	answer, err := g.http.send(ctx, request)
	return answer, noAnswer("Stripe", action, err)
}

// followUp es la captura y la anulación: si Stripe la rechaza por el estado del cobro, se devuelve el estado real.
func (g *stripeGateway) followUp(ctx context.Context, path string, form *formBody, reference, gatewayPaymentID, action string) (domain.GatewayOutcome, error) {
	answer, err := g.send(ctx, action, http.MethodPost, path, form, idempotencyKey(reference, action))
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 500 {
		return domain.GatewayOutcome{}, unavailableAnswer("Stripe", action, answer)
	}
	if answer.status >= 400 {
		// La autorización caducó: es la respuesta de la pasarela y no hace falta preguntarle. Se busca en el texto y no se
		// lee como JSON: un 4xx con un cuerpo que no lo es no puede convertir una respuesta en un error.
		if strings.Contains(answer.text, ${goString(TRANSLATION.expiredCaptureMarker)}) {
			return domain.NewGatewayOutcome(domain.GatewayCanceled, reference, gatewayPaymentID), nil
		}
		// payment_intent_unexpected_state y compañía (ya se capturó…): el estado real se consulta.
		return g.Status(ctx, reference, gatewayPaymentID)
	}
	body, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	return stripeOutcome(body, reference)
}

// stripeOutcome traduce un PaymentIntent al desenlace neutro.
func stripeOutcome(intent jsonObject, reference string) (domain.GatewayOutcome, error) {
	id := textOf(intent["id"])
	ref := cmp.Or(textOf(objectOf(intent["metadata"])[stripeReferenceKey]), reference)
	if charge := objectOf(intent["latest_charge"]); minorOf(charge["amount_refunded"]) > 0 {
		refunded, err := fromMinorUnits(minorOf(charge["amount_refunded"]), strings.ToUpper(textOf(charge["currency"])))
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		return domain.RefundedOutcome(ref, id, refunded), nil
	}
	switch textOf(intent["status"]) {
	case "requires_capture":
		return domain.NewGatewayOutcome(domain.GatewayAuthorized, ref, id), nil
	case "succeeded":
		return domain.NewGatewayOutcome(domain.GatewayCaptured, ref, id), nil
	case "requires_action":
		action, err := stripeCustomerAction(intent)
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		return domain.ActionRequiredOutcome(ref, id, action), nil
	case "canceled":
		return domain.NewGatewayOutcome(domain.GatewayCanceled, ref, id), nil
	case "requires_payment_method":
		if failure := intent["last_payment_error"]; isObject(failure) {
			return domain.FailedOutcome(ref, id, stripeReason(objectOf(failure))), nil
		}
	}
	return domain.NewGatewayOutcome(domain.GatewayPending, ref, id), nil
}

// stripeDeclined es un 4xx al pedir el cobro: un rechazo del emisor (402) o un medio que no sirve (400).
func stripeDeclined(body jsonObject, reference string) (domain.GatewayOutcome, error) {
	failure := objectOf(body["error"])
	intent := failure["payment_intent"]
	id := textOf(objectOf(intent)["id"])
	if stripeCode(failure) == "authentication_required" && isObject(intent) {
		// Un cobro sin el cliente delante que el emisor quiere autenticar: no es un fallo, es una acción del cliente
		// pendiente (docs/dsl/payments.md § Dos puertas).
		action, err := stripeCustomerAction(objectOf(intent))
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		return domain.ActionRequiredOutcome(reference, id, action), nil
	}
	return domain.FailedOutcome(reference, id, stripeReason(failure)), nil
}

// stripeCustomerAction es la acción del cliente, opaca: el client_secret y el next_action del PaymentIntent.
func stripeCustomerAction(intent jsonObject) (string, error) {
	var secret *string
	if value := textOf(intent["client_secret"]); value != "" {
		secret = &value
	}
	return encodeJSON(struct {
		ClientSecret *string \`json:"clientSecret"\`
		NextAction   any     \`json:"nextAction"\`
	}{secret, intent["next_action"]})
}

func stripeCode(failure jsonObject) string {
	return cmp.Or(textOf(failure["decline_code"]), textOf(failure["code"]))
}

func stripeReason(failure jsonObject) ${F} {
	if reason, ok := stripeDeclines[stripeCode(failure)]; ok {
		return reason
	}
	return domain.${reasonConstant(model, 'declined')}
}
${
  p.savePaymentMethod
    ? `
// rejectedMethod es guardar un medio: un 5xx deja la operación en duda; un 4xx es que la pasarela no acepta el medio.
func rejectedMethod(answer gatewayAnswer, err error) error {
	switch {
	case err != nil:
		return err
	case answer.status >= 500:
		return unavailableAnswer("Stripe", "savePaymentMethod", answer)
	case answer.status >= 400:
		return &domain.GatewayRejectedPaymentMethodError{Status: answer.status}
	}
	return nil
}
`
    : ''
}`;
}

function verifierBody(model) {
  const notice = TRANSLATION.notice;
  const header = model.payments.gateway.webhook.signatureHeader;
  return `
// stripeNoticeVerifier verifica la cabecera ${header}: \`${notice.timestampField}=<timestamp>,${notice.signatureField}=<firma>[,${notice.signatureField}=<firma>]\`.
//
// La firma es HMAC-SHA256 de \`<t>.<cuerpo>\` con el secreto del endpoint. Solo cuenta \`${notice.signatureField}\` (el resto se ignora,
// contra el downgrade); puede haber varias durante la rotación del secreto y basta con que verifique una; se compara en tiempo
// constante; y un \`t\` más antiguo que la tolerancia se rechaza aunque la firma sea buena, porque es un aviso repetido.
type stripeNoticeVerifier struct {
	secret    string
	tolerance time.Duration
	// now es el reloj: una prueba lo sustituye para medir la ventana.
	now func() time.Time
}

var _ domain.PaymentNoticeVerifier = (*stripeNoticeVerifier)(nil)

// NewNoticeVerifier es el verificador de los avisos de la pasarela del stack (Stripe).
func NewNoticeVerifier(settings Settings) domain.PaymentNoticeVerifier {
	return &stripeNoticeVerifier{secret: settings.WebhookSecret, tolerance: settings.NoticeTolerance, now: time.Now}
}

// Verify implementa domain.PaymentNoticeVerifier.
func (v *stripeNoticeVerifier) Verify(notice domain.PaymentNotice) (string, error) {
	header := notice.Header(${goString(header)})
	if strings.TrimSpace(header) == "" {
		return "", invalidNotice("sin cabecera de firma")
	}
	var timestamp int64
	seen := false
	var signatures []string
	for part := range strings.SplitSeq(header, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch name {
		case ${goString(notice.timestampField)}:
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return "", invalidNotice("timestamp ilegible")
			}
			timestamp, seen = parsed, true
		case ${goString(notice.signatureField)}:
			signatures = append(signatures, value)
		}
	}
	if !seen || len(signatures) == 0 {
		return "", invalidNotice("cabecera de firma incompleta")
	}
	if elapsed := v.now().Unix() - timestamp; elapsed > int64(v.tolerance/time.Second) || -elapsed > int64(v.tolerance/time.Second) {
		return "", invalidNotice("aviso fuera de la ventana de tolerancia")
	}
	mac := hmac.New(sha256.New, []byte(v.secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "." + notice.Body()))
	expected := []byte(hex.EncodeToString(mac.Sum(nil)))
	valid := false
	for _, signature := range signatures {
		if hmac.Equal([]byte(signature), expected) {
			valid = true
		}
	}
	if !valid {
		return "", invalidNotice("la firma no verifica")
	}
	return stripePaymentIntentOf(notice.Body())
}

// stripePaymentIntentOf es el PaymentIntent del que habla el evento: el propio objeto, o el payment_intent de un cargo o una
// devolución.
func stripePaymentIntentOf(body string) (string, error) {
	event, err := decodeObject(body)
	if err != nil {
		return "", invalidNotice("el cuerpo no es JSON")
	}
	data, ok := objectOf(event["data"])["object"].(jsonObject)
	if !ok {
		return "", nil
	}
	field := "payment_intent"
	if data["object"] == "payment_intent" {
		field = "id"
	}
	id, _ := data[field].(string)
	return id, nil
}
`;
}

/** stripe_test.go: el adaptador y el verificador contra una pasarela falsa (httptest), con las formas del doble. */
export function testFile(model, infra) {
  const declined = `domain.${reasonConstant(model, 'insufficientFunds')}`;
  const header = model.payments.gateway.webhook.signatureHeader;
  return {
    path: `${infra.dir}/stripe_test.go`,
    content: packageFile(model, infra, {
      imports: ['context', 'crypto/hmac', 'crypto/sha256', 'encoding/hex', 'errors', 'io', 'net/http', 'net/http/httptest', 'strconv', 'strings', 'sync/atomic', 'testing', 'time', 'internal/domain', 'internal/platform/wire'],
      body: `
func fakeStripe(t *testing.T, status int, body string) (*stripeGateway, *atomic.Int32, *http.Request, *string) {
	t.Helper()
	var calls atomic.Int32
	seen := &http.Request{}
	sent := new(string)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		text, _ := io.ReadAll(r.Body)
		*seen, *sent = *r.Clone(context.WithoutCancel(r.Context())), string(text)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	settings := Settings{BaseURL: server.URL, APIKey: "key", WebhookSecret: "secret", ConnectTimeout: time.Second, ReadTimeout: time.Second, NoticeTolerance: 300 * time.Second}
	return NewGateway(settings).(*stripeGateway), &calls, seen, sent
}

func charge(t *testing.T, amount string) domain.ChargeRequest {
	t.Helper()
	source, err := domain.TokenSource("tok_1")
	if err != nil {
		t.Fatal(err)
	}
	request, err := domain.NewChargeRequest("ref-1", wire.MustDecimal(amount), "EUR", source)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func TestAuthorizeSendsTheKeyOfTheReferenceAndTheMinorUnits(t *testing.T) {
	gateway, _, seen, sent := fakeStripe(t, http.StatusOK, \`{"id":"pi_1","status":"requires_capture","metadata":{"keel_reference":"ref-1"}}\`)
	outcome, err := gateway.Authorize(t.Context(), charge(t, "12.50"))
	if err != nil {
		t.Fatalf("Authorize = %v", err)
	}
	if got := seen.Header.Get(${goString(model.payments.gateway.idempotencyHeader)}); got != "ref-1:authorize" {
		t.Errorf("la clave de idempotencia es %q, quiero ref-1:authorize (de la referencia, nunca aleatoria)", got)
	}
	if !strings.Contains(*sent, "amount=1250&currency=eur") {
		t.Errorf("el cuerpo %q no lleva el importe en la unidad menor", *sent)
	}
	if outcome.Status != domain.GatewayAuthorized || outcome.GatewayPaymentID != "pi_1" || outcome.Reference != "ref-1" {
		t.Errorf("Authorize = %+v, quiero GatewayAuthorized de pi_1 con su referencia", outcome)
	}
}

func TestAServerErrorLeavesTheChargeInDoubtAndIsNotRetried(t *testing.T) {
	gateway, calls, _, _ := fakeStripe(t, http.StatusServiceUnavailable, \`{}\`)
	_, err := gateway.Authorize(t.Context(), charge(t, "12.50"))
	var unavailable *domain.PaymentGatewayUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("Authorize = %v, quiero un *domain.PaymentGatewayUnavailableError", err)
	}
	if calls.Load() != 1 {
		t.Errorf("la pasarela recibió %d peticiones: un 5xx no se reintenta (puede cobrar dos veces)", calls.Load())
	}
}

func TestADeclineIsItsNeutralReason(t *testing.T) {
	gateway, _, _, _ := fakeStripe(t, http.StatusPaymentRequired, \`{"error":{"decline_code":"insufficient_funds","payment_intent":{"id":"pi_1"}}}\`)
	outcome, err := gateway.Authorize(t.Context(), charge(t, "12.50"))
	if err != nil {
		t.Fatalf("Authorize = %v", err)
	}
	if outcome.Status != domain.GatewayFailed || outcome.FailureReason != ${declined} || outcome.GatewayPaymentID != "pi_1" {
		t.Errorf("Authorize = %+v, quiero GatewayFailed con ${declined}", outcome)
	}
}

func TestAnAmountWithMoreDecimalsThanTheCurrencyIsNotSent(t *testing.T) {
	gateway, calls, _, _ := fakeStripe(t, http.StatusOK, \`{}\`)
	if _, err := gateway.Authorize(t.Context(), charge(t, "12.505")); err == nil {
		t.Fatal("Authorize = nil, quiero el error del importe que habría que redondear")
	}
	if calls.Load() != 0 {
		t.Errorf("la pasarela recibió %d peticiones: el importe sin redondear no se manda", calls.Load())
	}
}

func signedNotice(secret string, at int64, body string) domain.PaymentNotice {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(at, 10) + "." + body))
	header := "t=" + strconv.FormatInt(at, 10) + ",v1=bad,v1=" + hex.EncodeToString(mac.Sum(nil))
	return domain.NewPaymentNotice(body, map[string][]string{${goString(header)}: {header}}, nil)
}

func TestTheNoticeVerifiesItsSignatureAndItsWindow(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	verifier := &stripeNoticeVerifier{secret: "secret", tolerance: 300 * time.Second, now: func() time.Time { return now }}
	body := \`{"data":{"object":{"object":"payment_intent","id":"pi_1"}}}\`
	id, err := verifier.Verify(signedNotice("secret", now.Unix(), body))
	if err != nil || id != "pi_1" {
		t.Fatalf("Verify = %q, %v; quiero pi_1 (basta con que verifique una v1)", id, err)
	}
	var invalid *domain.InvalidPaymentNoticeError
	if _, err := verifier.Verify(signedNotice("other", now.Unix(), body)); !errors.As(err, &invalid) {
		t.Errorf("Verify con otro secreto = %v, quiero *domain.InvalidPaymentNoticeError", err)
	}
	if _, err := verifier.Verify(signedNotice("secret", now.Unix()-301, body)); !errors.As(err, &invalid) {
		t.Errorf("Verify de un aviso viejo = %v, quiero *domain.InvalidPaymentNoticeError (es un aviso repetido)", err)
	}
	if _, err := verifier.Verify(domain.NewPaymentNotice(body, nil, nil)); !errors.As(err, &invalid) {
		t.Errorf("Verify sin cabecera = %v, quiero *domain.InvalidPaymentNoticeError", err)
	}
}
`
    })
  };
}
