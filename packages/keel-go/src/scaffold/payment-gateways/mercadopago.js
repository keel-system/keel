// El adaptador de MercadoPago (API de Orders) y su verificador de avisos, para keel-go.
//
// Es la traducción del de keel-nest y keel-dotnet, caso por caso, y habla el MISMO contrato (keel-core/gen/payment-gateways.js):
//   * cuerpos JSON; credencial como Bearer con el access token;
//   * importe en unidades mayores con la escala exacta de la moneda (tabla de keel-core), sin redondear;
//   * X-Idempotency-Key en todo POST; un 5xx no se reintenta: queda en duda;
//   * x-signature: ts=…,v1=…: HMAC-SHA256 del MANIFIESTO `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, no del cuerpo;
//     un ts en milisegundos se normaliza a segundos, y se compara en tiempo constante (hmac.Equal).

import { gatewayTranslation } from '@keel-system/keel-core/gen/payment-gateways';
import { alignRows, goString } from '../../lib/go-source.js';
import { packageFile } from '../render.js';
import { reasonConstant } from '../payments.js';

const TRANSLATION = gatewayTranslation('mercadopago');

export function generate(model, infra) {
  return [
    {
      path: `${infra.dir}/mercadopago.go`,
      content: packageFile(model, infra, {
        imports: ['cmp', 'context', 'crypto/hmac', 'crypto/sha256', 'encoding/hex', 'fmt', 'net/http', 'net/url', 'strconv', 'strings', 'time', 'internal/domain', 'internal/platform/wire'],
        body: adapterBody(model) + verifierBody(model)
      })
    }
  ];
}

function adapterBody(model) {
  const p = model.payments;
  const F = `domain.${p.record.failureReasonType}`;
  const ref = TRANSLATION.referenceKey;
  const details = alignRows(TRANSLATION.declines.map(([code, literal]) => ({ indent: '\t', cells: [`${goString(code)}:`, `domain.${reasonConstant(model, literal)},`] })));
  const partialRefund = Boolean(p.refund?.amount);
  const orderRows = alignRows(
    [
      ['"type"', '"online"'],
      ['"processing_mode"', '"automatic"'],
      ['"capture_mode"', goString(p.captureLater ? 'manual' : 'automatic')],
      [goString(ref), 'request.Reference()'],
      ['"total_amount"', 'amount'],
      ['"transactions"', 'jsonObject{"payments": []any{payment}}']
    ].map(([key, value]) => ({ indent: '\t\t', cells: [`${key}:`, `${value},`] }))
  ).join('\n');
  const methods = [];
  methods.push(`// Authorize implementa domain.PaymentGateway.
func (g *mercadopagoGateway) Authorize(ctx context.Context, request domain.ChargeRequest) (domain.GatewayOutcome, error) {
	amount, err := toMajorUnits(request.Amount(), request.Currency())
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	paymentMethod := jsonObject{"type": "credit_card", "installments": 1}
	payment := jsonObject{"amount": amount, "payment_method": paymentMethod}
	order := jsonObject{
${orderRows}
	}
	if request.Source().Kind() == domain.PaymentSourceSaved {
		// VERIFICAR EN SANDBOX (off-session sin verificar). La referencia guardada es <cliente>|<tarjeta> (SavePaymentMethod);
		// los pagos automáticos de Orders cobran con el perfil guardado y la credencial almacenada, sin CVV ni token nuevo.
		customerID, cardID, err := splitSaved(request.Source().Value())
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		order["payer"] = jsonObject{"customer_id": customerID}
		paymentMethod["id"] = cardID
		payment["stored_credential"] = jsonObject{"payment_initiator": "merchant", "reason": "unscheduled", "first_payment": false}
	} else {
		paymentMethod["token"] = request.Source().Value()
	}
	answer, err := g.send(ctx, "authorize", http.MethodPost, "/v1/orders", order, idempotencyKey(request.Reference(), "authorize"))
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 500 {
		return domain.GatewayOutcome{}, unavailableAnswer("MercadoPago", "authorize", answer)
	}
	body, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 400 {
		// Un 4xx al crear la order: el token o el medio no sirven.
		return domain.FailedOutcome(request.Reference(), "", mercadopagoReason(body)), nil
	}
	return mercadopagoOutcome(body, request.Reference())
}`);
  if (p.capture) {
    methods.push(`// Capture implementa domain.PaymentGateway.${p.capture.amount ? ' La captura parcial no la cubre MercadoPago: la matriz de la pasarela no deja\n// generar un diseño que la exija, y el importe no se manda.' : ''}
func (g *mercadopagoGateway) Capture(ctx context.Context, reference, gatewayPaymentID string${p.capture.amount ? ', _ *wire.Decimal, _ string' : ''}) (domain.GatewayOutcome, error) {
	return g.followUp(ctx, "/v1/orders/"+url.PathEscape(gatewayPaymentID)+"/capture", jsonObject{}, reference, gatewayPaymentID, "capture")
}`);
  }
  if (p.void) {
    methods.push(`// VoidAuthorization implementa domain.PaymentGateway.
func (g *mercadopagoGateway) VoidAuthorization(ctx context.Context, reference, gatewayPaymentID string) (domain.GatewayOutcome, error) {
	return g.followUp(ctx, "/v1/orders/"+url.PathEscape(gatewayPaymentID)+"/cancel", jsonObject{}, reference, gatewayPaymentID, "void")
}`);
  }
  if (p.refund) {
    const partial = partialRefund
      ? `
	if amount != nil {
		// La devolución parcial nombra la transacción de pago de la order: hay que leerla, y esa lectura falla igual que la
		// devolución —dentro del mismo tratamiento, o un 5xx aquí sale como un 500 con el cobro atascado en refunding—.
		current, err := g.send(ctx, "refund", http.MethodGet, "/v1/orders/"+url.PathEscape(gatewayPaymentID), nil, "")
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		if current.status >= 400 {
			return domain.GatewayOutcome{}, unavailableAnswer("MercadoPago", "refund", current)
		}
		order, err := decodeObject(current.text)
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		major, err := toMajorUnits(*amount, currency)
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		body["transactions"] = []any{jsonObject{"id": textOf(mercadopagoPayment(order)["id"]), "amount": major}}
	}`
      : '';
    methods.push(`// Refund implementa domain.PaymentGateway.
func (g *mercadopagoGateway) Refund(ctx context.Context, reference, gatewayPaymentID string${partialRefund ? ', amount *wire.Decimal, currency string' : ''}) (domain.GatewayOutcome, error) {
	body := jsonObject{}${partial}
	return g.followUp(ctx, "/v1/orders/"+url.PathEscape(gatewayPaymentID)+"/refund", body, reference, gatewayPaymentID, "refund")
}`);
  }
  methods.push(`// Status implementa domain.PaymentGateway.
func (g *mercadopagoGateway) Status(ctx context.Context, reference, gatewayPaymentID string) (domain.GatewayOutcome, error) {
	path := "/v1/orders/" + url.PathEscape(gatewayPaymentID)
	if gatewayPaymentID == "" {
		// Sin id: la pasarela no llegó a contestar. Se busca por ${ref}.
		// VERIFICAR EN SANDBOX: la búsqueda de orders por referencia externa.
		query := &formBody{}
		query.add(${goString(ref)}, reference)
		path = "/v1/orders/search?" + query.encode()
	}
	answer, err := g.send(ctx, "status", http.MethodGet, path, nil, "")
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status == http.StatusNotFound {
		return domain.NotFoundOutcome(reference), nil
	}
	if answer.status >= 400 {
		return domain.GatewayOutcome{}, unavailableAnswer("MercadoPago", "status", answer)
	}
	body, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if gatewayPaymentID != "" {
		return mercadopagoOutcome(body, reference)
	}
	if list, ok := body["data"].([]any); ok && len(list) > 0 && isObject(list[0]) {
		return mercadopagoOutcome(objectOf(list[0]), reference)
	}
	return domain.NotFoundOutcome(reference), nil
}`);
  if (p.savePaymentMethod) {
    const [customerStep, cardStep] = TRANSLATION.savedMethodSteps;
    methods.push(`// SavePaymentMethod implementa domain.PaymentGateway: el cliente de MercadoPago y la tarjeta guardada en él.
func (g *mercadopagoGateway) SavePaymentMethod(ctx context.Context, token, payerReference string) (string, error) {
	customer, err := g.send(ctx, "savePaymentMethod", http.MethodPost, "/v1/customers", jsonObject{"description": payerReference}, savedKey(token, ${goString(customerStep)}))
	if err := rejectedMethod(customer, err); err != nil {
		return "", err
	}
	created, err := decodeObject(customer.text)
	if err != nil {
		return "", err
	}
	customerID := textOf(created["id"])
	card, err := g.send(ctx, "savePaymentMethod", http.MethodPost, "/v1/customers/"+url.PathEscape(customerID)+"/cards", jsonObject{"token": token}, savedKey(token, ${goString(cardStep)}))
	if err := rejectedMethod(card, err); err != nil {
		return "", err
	}
	saved, err := decodeObject(card.text)
	if err != nil {
		return "", err
	}
	return customerID + savedMethodSeparator + textOf(saved["id"]), nil
}`);
  }
  return `
// mercadopagoIdempotencyHeader es la cabecera con la que MercadoPago recibe la clave de idempotencia.
const mercadopagoIdempotencyHeader = ${goString(p.gateway.idempotencyHeader)}

// mercadopagoDetails traduce el status_detail de un pago al motivo neutro (keel-core/gen/payment-gateways.js); lo que no está
// aquí es un rechazo sin más.
var mercadopagoDetails = map[string]${F}{
${details.join('\n')}
}

// mercadopagoGateway es la pasarela de pago sobre MercadoPago (API de Orders), por HTTP plano. Lo que lleva dentro y no puede
// faltar:
//   - la clave de idempotencia sale de la referencia de negocio y la acción (<referencia>:authorize…), nunca de un
//     aleatorio;
//   - un 5xx o un plazo vencido NO se reintenta: devuelve un *domain.PaymentGatewayUnavailableError y la acción queda en
//     duda para el barrido;
//   - el importe viaja en unidades mayores con la escala exacta de la moneda, sin redondear;
//   - los rechazos se traducen al vocabulario neutro de ${p.record.failureReasonType}.
type mercadopagoGateway struct {
	http *gatewayHTTP
}

var _ domain.PaymentGateway = (*mercadopagoGateway)(nil)

// NewGateway es el adaptador de domain.PaymentGateway de la pasarela del stack (MercadoPago).
func NewGateway(settings Settings) domain.PaymentGateway {
	return &mercadopagoGateway{http: newGatewayHTTP(settings)}
}

${methods.join('\n\n')}

// send manda una petición a MercadoPago; «no contestó» sale como la duda del dominio.
func (g *mercadopagoGateway) send(ctx context.Context, action, method, path string, body jsonObject, key string) (gatewayAnswer, error) {
	request := gatewayRequest{method: method, path: path}
	if body != nil {
		text, err := encodeJSON(body)
		if err != nil {
			return gatewayAnswer{}, err
		}
		request.contentType, request.body = jsonContentType, text
	}
	if key != "" {
		request.idempotencyHeader, request.idempotencyKey = mercadopagoIdempotencyHeader, key
	}
	answer, err := g.http.send(ctx, request)
	return answer, noAnswer("MercadoPago", action, err)
}

// followUp es la captura, la anulación y la devolución: si MercadoPago la rechaza, se devuelve el estado real de la order.
func (g *mercadopagoGateway) followUp(ctx context.Context, path string, body jsonObject, reference, gatewayPaymentID, action string) (domain.GatewayOutcome, error) {
	answer, err := g.send(ctx, action, http.MethodPost, path, body, idempotencyKey(reference, action))
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	if answer.status >= 500 {
		return domain.GatewayOutcome{}, unavailableAnswer("MercadoPago", action, answer)
	}
	if answer.status >= 400 {
		return g.Status(ctx, reference, gatewayPaymentID)
	}
	order, err := decodeObject(answer.text)
	if err != nil {
		return domain.GatewayOutcome{}, err
	}
	return mercadopagoOutcome(order, reference)
}

// mercadopagoOutcome traduce una order al desenlace neutro.
func mercadopagoOutcome(order jsonObject, reference string) (domain.GatewayOutcome, error) {
	id := textOf(order["id"])
	ref := cmp.Or(textOf(order[${goString(ref)}]), reference)
	payment := mercadopagoPayment(order)
	detail := cmp.Or(textOf(order["status_detail"]), textOf(payment["status_detail"]))
	status := textOf(order["status"])
	if status == "refunded" || detail == "refunded" || detail == "partially_refunded" {
		refunded := wire.NewDecimal(0, 0)
		refunds, _ := objectOf(order["transactions"])["refunds"].([]any)
		for _, refund := range refunds {
			amount, err := wire.ParseDecimal(cmp.Or(textOf(objectOf(refund)["amount"]), "0"))
			if err != nil {
				return domain.GatewayOutcome{}, fmt.Errorf("MercadoPago devolvió un importe ilegible: %w", err)
			}
			refunded = refunded.Add(amount)
		}
		return domain.RefundedOutcome(ref, id, refunded), nil
	}
	switch status {
	case "action_required":
		action, err := mercadopagoCustomerAction(payment)
		if err != nil {
			return domain.GatewayOutcome{}, err
		}
		return domain.ActionRequiredOutcome(ref, id, action), nil
	case "processed":
		if detail == "waiting_capture" {
			return domain.NewGatewayOutcome(domain.GatewayAuthorized, ref, id), nil
		}
		return domain.NewGatewayOutcome(domain.GatewayCaptured, ref, id), nil
	case "failed":
		return domain.FailedOutcome(ref, id, mercadopagoReason(payment)), nil
	case "canceled", "expired":
		return domain.NewGatewayOutcome(domain.GatewayCanceled, ref, id), nil
	}
	return domain.NewGatewayOutcome(domain.GatewayPending, ref, id), nil
}

// mercadopagoCustomerAction es la acción del cliente, opaca. VERIFICAR EN SANDBOX (customer-action sin verificar). Sin medio
// de pago, no hay acción que dar.
func mercadopagoCustomerAction(payment jsonObject) (string, error) {
	method, ok := payment["payment_method"]
	if !ok {
		return "", nil
	}
	return encodeJSON(method)
}

func mercadopagoReason(node jsonObject) ${F} {
	cause := firstObject(node["cause"])
	if reason, ok := mercadopagoDetails[cmp.Or(textOf(node["status_detail"]), textOf(cause["code"]))]; ok {
		return reason
	}
	return domain.${reasonConstant(model, 'declined')}
}

// mercadopagoPayment es el primer pago de la order.
func mercadopagoPayment(order jsonObject) jsonObject {
	return firstObject(objectOf(order["transactions"])["payments"])
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
		return unavailableAnswer("MercadoPago", "savePaymentMethod", answer)
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
// mercadopagoNoticeVerifier verifica la cabecera ${header} de MercadoPago: \`${notice.timestampField}=<timestamp>,${notice.signatureField}=<firma>\`.
//
// La firma es HMAC-SHA256 del manifiesto \`id:<data.id>;request-id:<${notice.requestIdHeader}>;ts:<ts>;\`, con data.id sacado de la URL y
// en minúsculas; lo que falte se quita del manifiesto. Se compara en tiempo constante y un ts fuera de la tolerancia se
// rechaza. LA FIRMA NO CUBRE EL CUERPO: por eso de aquí solo sale el id de la order, y su estado se le pregunta a la pasarela.
type mercadopagoNoticeVerifier struct {
	secret    string
	tolerance time.Duration
	// now es el reloj: una prueba lo sustituye para medir la ventana.
	now func() time.Time
}

var _ domain.PaymentNoticeVerifier = (*mercadopagoNoticeVerifier)(nil)

// NewNoticeVerifier es el verificador de los avisos de la pasarela del stack (MercadoPago).
func NewNoticeVerifier(settings Settings) domain.PaymentNoticeVerifier {
	return &mercadopagoNoticeVerifier{secret: settings.WebhookSecret, tolerance: settings.NoticeTolerance, now: time.Now}
}

// Verify implementa domain.PaymentNoticeVerifier.
func (v *mercadopagoNoticeVerifier) Verify(notice domain.PaymentNotice) (string, error) {
	header := notice.Header(${goString(header)})
	if strings.TrimSpace(header) == "" {
		return "", invalidNotice("sin cabecera de firma")
	}
	var ts, signature string
	for part := range strings.SplitSeq(header, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch name {
		case ${goString(notice.timestampField)}:
			ts = value
		case ${goString(notice.signatureField)}:
			signature = value
		}
	}
	if ts == "" || signature == "" {
		return "", invalidNotice("cabecera de firma incompleta")
	}
	raw, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return "", invalidNotice("timestamp ilegible")
	}
	// El ts puede venir en milisegundos: se normaliza antes de comparar con la ventana.
	seconds := raw
	if raw > ${notice.millisecondsAbove} {
		seconds = raw / 1000
	}
	if elapsed := v.now().Unix() - seconds; elapsed > int64(v.tolerance/time.Second) || -elapsed > int64(v.tolerance/time.Second) {
		return "", invalidNotice("aviso fuera de la ventana de tolerancia")
	}
	dataID := notice.Param(${goString(notice.dataIdQuery)})
	requestID := notice.Header(${goString(notice.requestIdHeader)})
	var manifest strings.Builder
	if strings.TrimSpace(dataID) != "" {
		manifest.WriteString("id:" + strings.ToLower(dataID) + ";")
	}
	if strings.TrimSpace(requestID) != "" {
		manifest.WriteString("request-id:" + requestID + ";")
	}
	manifest.WriteString("ts:" + ts + ";")
	mac := hmac.New(sha256.New, []byte(v.secret))
	mac.Write([]byte(manifest.String()))
	if !hmac.Equal([]byte(signature), []byte(hex.EncodeToString(mac.Sum(nil)))) {
		return "", invalidNotice("la firma no verifica")
	}
	if strings.TrimSpace(dataID) == "" {
		return "", nil
	}
	return dataID, nil
}
`;
}

/** mercadopago_test.go: el adaptador y el verificador contra una pasarela falsa (httptest), con las formas del doble. */
export function testFile(model, infra) {
  const declined = `domain.${reasonConstant(model, 'insufficientFunds')}`;
  const header = model.payments.gateway.webhook.signatureHeader;
  return {
    path: `${infra.dir}/mercadopago_test.go`,
    content: packageFile(model, infra, {
      imports: ['context', 'crypto/hmac', 'crypto/sha256', 'encoding/hex', 'errors', 'io', 'net/http', 'net/http/httptest', 'strconv', 'strings', 'sync/atomic', 'testing', 'time', 'internal/domain', 'internal/platform/wire'],
      body: `
func fakeMercadopago(t *testing.T, status int, body string) (*mercadopagoGateway, *atomic.Int32, *http.Request, *string) {
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
	return NewGateway(settings).(*mercadopagoGateway), &calls, seen, sent
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

func TestAuthorizeSendsTheKeyOfTheReferenceAndTheMajorUnits(t *testing.T) {
	gateway, _, seen, sent := fakeMercadopago(t, http.StatusCreated, \`{"id":"ORD1","status":"processed","status_detail":"waiting_capture","external_reference":"ref-1"}\`)
	outcome, err := gateway.Authorize(t.Context(), charge(t, "12.5"))
	if err != nil {
		t.Fatalf("Authorize = %v", err)
	}
	if got := seen.Header.Get(${goString(model.payments.gateway.idempotencyHeader)}); got != "ref-1:authorize" {
		t.Errorf("la clave de idempotencia es %q, quiero ref-1:authorize (de la referencia, nunca aleatoria)", got)
	}
	if !strings.Contains(*sent, \`"total_amount":"12.50"\`) {
		t.Errorf("el cuerpo %q no lleva el importe con la escala de la moneda", *sent)
	}
	if outcome.Status != domain.GatewayAuthorized || outcome.GatewayPaymentID != "ORD1" || outcome.Reference != "ref-1" {
		t.Errorf("Authorize = %+v, quiero GatewayAuthorized de ORD1 con su referencia", outcome)
	}
}

func TestAServerErrorLeavesTheChargeInDoubtAndIsNotRetried(t *testing.T) {
	gateway, calls, _, _ := fakeMercadopago(t, http.StatusBadGateway, \`{}\`)
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
	gateway, _, _, _ := fakeMercadopago(t, http.StatusCreated, \`{"id":"ORD1","status":"failed","transactions":{"payments":[{"status_detail":"cc_rejected_insufficient_amount"}]}}\`)
	outcome, err := gateway.Authorize(t.Context(), charge(t, "12.50"))
	if err != nil {
		t.Fatalf("Authorize = %v", err)
	}
	if outcome.Status != domain.GatewayFailed || outcome.FailureReason != ${declined} {
		t.Errorf("Authorize = %+v, quiero GatewayFailed con ${declined}", outcome)
	}
}

func TestAnAmountWithMoreDecimalsThanTheCurrencyIsNotSent(t *testing.T) {
	gateway, calls, _, _ := fakeMercadopago(t, http.StatusOK, \`{}\`)
	if _, err := gateway.Authorize(t.Context(), charge(t, "12.505")); err == nil {
		t.Fatal("Authorize = nil, quiero el error del importe que habría que redondear")
	}
	if calls.Load() != 0 {
		t.Errorf("la pasarela recibió %d peticiones: el importe sin redondear no se manda", calls.Load())
	}
}

func signedNotice(secret, ts, dataID string) domain.PaymentNotice {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("id:" + strings.ToLower(dataID) + ";request-id:req-1;ts:" + ts + ";"))
	header := "ts=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
	return domain.NewPaymentNotice("{}", map[string][]string{${goString(header)}: {header}, "X-Request-Id": {"req-1"}}, map[string][]string{"data.id": {dataID}})
}

func TestTheNoticeVerifiesTheManifestAndItsWindow(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	verifier := &mercadopagoNoticeVerifier{secret: "secret", tolerance: 300 * time.Second, now: func() time.Time { return now }}
	seconds := strconv.FormatInt(now.Unix(), 10)
	id, err := verifier.Verify(signedNotice("secret", seconds, "ORD1"))
	if err != nil || id != "ORD1" {
		t.Fatalf("Verify = %q, %v; quiero ORD1", id, err)
	}
	if id, err := verifier.Verify(signedNotice("secret", strconv.FormatInt(now.UnixMilli(), 10), "ORD1")); err != nil || id != "ORD1" {
		t.Errorf("Verify con el ts en milisegundos = %q, %v; quiero ORD1 (se normaliza a segundos)", id, err)
	}
	var invalid *domain.InvalidPaymentNoticeError
	if _, err := verifier.Verify(signedNotice("other", seconds, "ORD1")); !errors.As(err, &invalid) {
		t.Errorf("Verify con otro secreto = %v, quiero *domain.InvalidPaymentNoticeError", err)
	}
	if _, err := verifier.Verify(signedNotice("secret", strconv.FormatInt(now.Unix()-301, 10), "ORD1")); !errors.As(err, &invalid) {
		t.Errorf("Verify de un aviso viejo = %v, quiero *domain.InvalidPaymentNoticeError (es un aviso repetido)", err)
	}
}
`
    })
  };
}
