// Cobros con pasarela (capa payments, incremento 13b). La parte NEUTRA: lo que es igual sea cual sea la pasarela elegida;
// el adaptador y el verificador de cada una los emite su módulo en ./payment-gateways/. Es el reparto de keel-spring,
// keel-nest y keel-dotnet, y por el mismo criterio que el correo: build genera el puerto, el adaptador y el aviso enteros,
// porque lo que llevan dentro son defensas cuya ausencia no rompe ninguna prueba.
//
//   · `internal/domain/payment_gateway.go` — el vocabulario neutro del puerto (GatewayStatus, GatewayOutcome, PaymentSource,
//     ChargeRequest), sus dos errores (*PaymentGatewayUnavailableError: no se sabe qué hizo la pasarela;
//     *GatewayRejectedPaymentMethodError: contestó que no acepta el medio), el puerto PaymentGateway y el aviso tal como
//     llegó (PaymentNotice, el puerto PaymentNoticeVerifier y *InvalidPaymentNoticeError);
//   · `internal/application/payment_outcomes.go` — de un desenlace a la operación del diseño que lo aplica
//     (PaymentOutcomeApplier, sobre los propios UseCases), el aviso ya verificado (PaymentNotices: el aviso NO decide el
//     desenlace, se le pregunta a la pasarela) y la consulta del barrido (PaymentReconciliation);
//   · `internal/infrastructure/payment` — la configuración de payments.yaml (las claves y variables de los otros tres), el
//     cliente HTTP de la pasarela sin reintentos ni keep-alive (net/http reenvía por su cuenta una petición con
//     Idempotency-Key sobre una conexión reutilizada que se corta: aquí eso es cobrar dos veces), los importes con la tabla
//     de unidades menores de keel-core y la lectura de un campo JSON como la de los otros tres;
//   · `internal/httpapi/payment_notice.go` — la ruta del aviso, que lee el cuerpo como TEXTO (la firma es sobre los bytes
//     que llegaron) y responde 401 o 200 vacíos. La abre el plan de acceso neutral.
//
// Lo que NO genera: la lógica de los casos de uso (cuándo se llama al puerto y qué transición aplica cada handler), que es
// del diseño y la escribe el agente con la skill de la pasarela. Lo que sí hace es dársela al handler: el puerto y el
// aplicador a cada operación que llama a la pasarela, y la consulta al barrido (paymentDependencies).

import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, SAVED_METHOD_SEPARATOR, paymentIdempotencyKey, savedMethodIdempotencyKey } from '@keel-system/keel-core/gen/payment-gateways';
import { paymentsYaml } from '@keel-system/keel-core/gen/payments-config';
import { PAYMENT_SWEEP_PARAMETERS } from '@keel-system/keel-core/gen/payments-model';
import { usesPayments } from '@keel-system/keel-core/gen/features';
import { enumConstant, goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { applicationPath, domainPath, layout, packageFile } from './render.js';
import { componentType, contractOf, messageComponents, messageType, operations, useCaseField } from './services.js';
import { usesDependencies } from './use-cases.js';
import { portName, repositoryParam } from './repositories.js';
import { repositoryRoots } from '@keel-system/keel-core/gen/features';
import { scheduledByTimer } from '@keel-system/keel-core/gen/timer-plan';
import * as stripe from './payment-gateways/stripe.js';
import * as mercadopago from './payment-gateways/mercadopago.js';

export { usesPayments };

const PROFILES = ['local', 'develop', 'production', 'test'];
const GATEWAY_MODULES = { stripe, mercadopago };

/** El paquete de la infraestructura de la pasarela, relativo al módulo. */
export const PAYMENT_IMPORT = 'internal/infrastructure/payment';

/** ¿Se generan los pagos? Con la capa, una pasarela del stack y los casos de uso cableados. */
export function usesGoPayments(model) {
  return usesPayments(model) && usesDependencies(model);
}

/** El módulo de la pasarela del stack. */
export function gatewayModule(model) {
  const module = GATEWAY_MODULES[model.payments.gateway.id];
  if (!module) throw new Error(`payments: la pasarela '${model.payments.gateway.id}' no tiene módulo de generación en keel-go`);
  return module;
}

// ─── El cableado en los casos de uso ─────────────────────────────────────────────────────────────

/** Los campos de Dependencies que trae la capa. */
export const PAYMENT_DEPENDENCIES = [
  { field: 'PaymentGateway', type: 'domain.PaymentGateway', doc: 'PaymentGateway es la pasarela de pago del stack (payments): su adaptador, ya escrito.' },
  { field: 'PaymentNoticeVerifier', type: 'domain.PaymentNoticeVerifier', doc: 'PaymentNoticeVerifier verifica la firma de los avisos de la pasarela.' },
  { field: 'PaymentSweep', type: 'PaymentReconciliationSettings', doc: 'PaymentSweep son los números del barrido de pagos (payments.yaml).' }
];

/** Las operaciones de la capa que llaman a la pasarela con el cliente o el sistema delante (no el barrido). */
function gatewayActions(model) {
  const p = model.payments;
  return [p.charge?.operation, p.capture?.operation, p.void?.operation, p.refund?.operation].filter(Boolean);
}

/**
 * Lo que recibe el handler de una operación de la capa, en el formato de handlerDependencies (use-cases.js): el puerto y el
 * aplicador a las acciones sobre un cobro, el puerto solo a guardar un medio, y la consulta al barrido. En los otros tres
 * los pide el agente al constructor y se los da la inyección de dependencias; aquí el cableado es de build.
 */
export function paymentDependencies(model, operation) {
  if (!usesGoPayments(model)) return [];
  const p = model.payments;
  const deps = [];
  const gateway = { name: 'paymentGateway', type: 'domain.PaymentGateway', doc: 'paymentGateway es la pasarela de pago del stack (payments), con su adaptador ya escrito.', arg: 'deps.PaymentGateway' };
  if (gatewayActions(model).includes(operation.name)) {
    deps.push(gateway, {
      name: 'paymentOutcomes',
      type: '*PaymentOutcomeApplier',
      doc: 'paymentOutcomes aplica el desenlace de la pasarela con la operación del diseño que le corresponde (payments.outcomes).',
      arg: 'paymentOutcomes'
    });
  } else if (p.savePaymentMethod?.operation === operation.name) {
    deps.push(gateway);
  }
  if (p.reconciliation?.sweep === operation.name) {
    deps.push({
      name: 'paymentReconciliation',
      type: '*PaymentReconciliation',
      doc: `paymentReconciliation consulta a la pasarela un cobro que espera desenlace y aplica lo que diga (${p.reconciliation.sweep}).`,
      arg: 'paymentReconciliation'
    });
  }
  return deps;
}

/** Las filas de UseCases: el aviso, para la entrada HTTP. */
export function paymentUseCaseFields(model) {
  if (!usesGoPayments(model)) return [];
  return [
    { text: '\t// PaymentNotices atiende los avisos de la pasarela de pago (la ruta del aviso de httpapi).' },
    { indent: '\t', cells: ['PaymentNotices', '*PaymentNotices'] }
  ];
}

/** Las filas de Dependencies que trae la capa. */
export function paymentDependencyRows(model) {
  if (!usesGoPayments(model)) return [];
  return PAYMENT_DEPENDENCIES.flatMap((dep) => [{ text: `\t// ${dep.doc}` }, { indent: '\t', cells: [dep.field, dep.type] }]);
}

/** Lo que NewUseCases construye tras `uc` y antes de cablear los handlers. */
export function paymentWiring(model) {
  if (!usesGoPayments(model)) return '';
  const sweeps = operations(model).some((operation) => paymentDependencies(model, operation).some((dep) => dep.arg === 'paymentReconciliation'));
  const record = recordRepository(model);
  const lines = [`\tpaymentOutcomes := &PaymentOutcomeApplier{useCases: uc${record ? `, ${record.param}: deps.${goExported(record.param)}` : ''}}`];
  if (sweeps) lines.push('\tpaymentReconciliation := &PaymentReconciliation{gateway: deps.PaymentGateway, outcomes: paymentOutcomes, settings: deps.PaymentSweep}');
  lines.push('\tuc.PaymentNotices = &PaymentNotices{gateway: deps.PaymentGateway, verifier: deps.PaymentNoticeVerifier, outcomes: paymentOutcomes}');
  return `${lines.join('\n')}\n`;
}

/** Lo que el arranque (cmd/server) añade a Dependencies, y la configuración que lee antes. */
export function paymentServerRows(model) {
  if (!usesGoPayments(model)) return [];
  return [
    { indent: '\t\t', cells: ['PaymentGateway:', 'payment.NewGateway(paymentSettings),'] },
    { indent: '\t\t', cells: ['PaymentNoticeVerifier:', 'payment.NewNoticeVerifier(paymentSettings),'] },
    { indent: '\t\t', cells: ['PaymentSweep:', 'paymentSettings.Reconciliation(),'] }
  ];
}

export const PAYMENT_SERVER_WIRING = `	paymentSettings, err := payment.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la pasarela de pago: %w", err)
	}
`;

/** La línea de NewHandler que registra la ruta del aviso. */
export function paymentNoticeRoute(model) {
  return usesGoPayments(model) ? '\tmux.Handle(http.MethodPost+" "+paymentNoticePath, a.endpoint((*api).receivePaymentNotice))\n' : '';
}

// ─── Los archivos ────────────────────────────────────────────────────────────────────────────────

export function generate(model) {
  if (!usesGoPayments(model)) return [];
  const { domain, application, httpapi } = layout(model);
  const infra = { dir: PAYMENT_IMPORT, name: 'payment' };
  const gateway = gatewayModule(model);
  return [
    { path: domainPath(model, 'PaymentGateway'), content: packageFile(model, domain, { imports: ['context', 'errors', 'fmt', 'strings', 'internal/platform/wire'], body: domainBody(model) }) },
    {
      path: applicationPath(model, 'PaymentOutcomes'),
      content: packageFile(model, application, { imports: ['context', 'fmt', 'strings', 'time', 'encoding/json/jsontext', 'internal/domain', 'internal/platform/wire'], body: applicationBody(model) })
    },
    ...(outcomeChoices(model).length > 0
      ? [{ path: applicationPath(model, 'PaymentOutcomeChoices'), content: packageFile(model, application, { imports: ['context', 'fmt', 'internal/domain'], body: choicesBody(model), generated: false }) }]
      : []),
    { path: `${httpapi.dir}/payment_notice.go`, content: packageFile(model, httpapi, { imports: ['errors', 'io', 'net/http', 'internal/domain'], body: noticeEndpointBody() }) },
    { path: `${infra.dir}/doc.go`, content: packageFile(model, infra, { doc: PACKAGE_DOC(model), body: '' }) },
    { path: `${infra.dir}/settings.go`, content: packageFile(model, infra, { imports: ['fmt', 'regexp', 'strconv', 'strings', 'time', 'internal/application', 'internal/platform/config'], body: settingsBody() }) },
    { path: `${infra.dir}/http.go`, content: packageFile(model, infra, { imports: ['context', 'errors', 'fmt', 'io', 'net', 'net/http', 'strings'], body: HTTP_BODY }) },
    { path: `${infra.dir}/money.go`, content: packageFile(model, infra, { imports: ['fmt', 'strconv', 'strings', 'internal/platform/wire'], body: moneyBody() }) },
    { path: `${infra.dir}/json.go`, content: packageFile(model, infra, { imports: ['encoding/json/v2', 'fmt', 'strconv', 'strings'], body: JSON_BODY }) },
    { path: `${infra.dir}/keys.go`, content: packageFile(model, infra, { imports: ['encoding/json/v2', 'errors', 'fmt', 'net/url', 'strings', 'internal/domain'], body: keysBody() }) },
    ...gateway.generate(model, infra),
    gateway.testFile(model, infra),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/payments.yaml`, content: paymentsYaml(model, profile) }))
  ];
}

const PACKAGE_DOC = (model) => `Package payment es la pasarela de pago del stack (${model.payments.gateway.label}): el adaptador de domain.PaymentGateway, el
verificador de sus avisos y la configuración del perfil (config/parameters/<perfil>/payments.yaml). Cambiar de pasarela
es regenerar con otra en keel-stack.json, sin tocar el diseño.`;

// ─── El dominio ──────────────────────────────────────────────────────────────────────────────────

/** El motivo de fallo del registro: un enum del dominio. */
function failureReason(model) {
  return model.payments.record.failureReasonType;
}

/** La constante Go de un motivo neutro (`notReceived` → PaymentFailureReasonNotReceived). */
export function reasonConstant(model, literal) {
  return enumConstant(failureReason(model), literal);
}

const STATUSES = [
  ['PENDING', 'GatewayPending', 'es que la pasarela lo tiene, pero todavía no hay desenlace.'],
  ['ACTION_REQUIRED', 'GatewayActionRequired', 'es que espera a que el cliente se autentique (3DS, redirección).'],
  ['AUTHORIZED', 'GatewayAuthorized', 'es el importe retenido, pendiente de captura.'],
  ['CAPTURED', 'GatewayCaptured', 'es cobrado.'],
  ['REFUNDED', 'GatewayRefunded', 'es devuelto, todo o en parte.'],
  ['CANCELED', 'GatewayCanceled', 'es que la autorización se anuló o caducó.'],
  ['FAILED', 'GatewayFailed', 'es que el cobro no se hizo.'],
  ['NOT_FOUND', 'GatewayNotFound', 'es que la pasarela no conoce el cobro: la petición no le llegó nunca.']
];

/** La constante Go de un estado neutro (`AUTHORIZED` → GatewayAuthorized). */
export function statusConstant(status) {
  return STATUSES.find(([value]) => value === status)[1];
}

function domainBody(model) {
  const p = model.payments;
  const F = failureReason(model);
  const partialCapture = Boolean(p.capture?.amount);
  const partialRefund = Boolean(p.refund?.amount);
  const methods = [
    `	// Authorize pide el cobro (${p.captureLater ? 'solo lo AUTORIZA: flow authorize-capture' : 'autoriza y captura: flow single-step'}). El cobro tiene que estar
	// registrado ANTES de llamar: si devuelve un *PaymentGatewayUnavailableError, se queda en duda.
	Authorize(ctx context.Context, request ChargeRequest) (GatewayOutcome, error)`
  ];
  if (p.capture) {
    methods.push(`	// Capture captura lo autorizado${partialCapture ? '; con amount, solo esa parte (el resto se libera), en la moneda del cobro' : ''}. El cobro
	// tiene que estar ya en su estado en vuelo (${p.capture.inFlight}).
	Capture(ctx context.Context, reference, gatewayPaymentID string${partialCapture ? ', amount *wire.Decimal, currency string' : ''}) (GatewayOutcome, error)`);
  }
  if (p.void) {
    methods.push(`	// VoidAuthorization anula la autorización. El cobro tiene que estar ya en ${p.void.inFlight}.
	VoidAuthorization(ctx context.Context, reference, gatewayPaymentID string) (GatewayOutcome, error)`);
  }
  if (p.refund) {
    methods.push(`	// Refund devuelve lo cobrado${partialRefund ? '; con amount nil, todo. La moneda es la del cobro: la pasa quien llama, que la\n\t// conoce, en vez de pedírsela a la pasarela con una llamada más' : ''}. El cobro tiene que estar ya en ${p.refund.inFlight}. Si la
	// pasarela la rechaza, el resultado NO es GatewayRefunded.
	Refund(ctx context.Context, reference, gatewayPaymentID string${partialRefund ? ', amount *wire.Decimal, currency string' : ''}) (GatewayOutcome, error)`);
  }
  methods.push(`	// Status es el estado de un cobro según la pasarela. Con gatewayPaymentID vacío —la pasarela no llegó a contestar— se
	// busca por la referencia, que el adaptador le mandó al pedirlo.
	Status(ctx context.Context, reference, gatewayPaymentID string) (GatewayOutcome, error)`);
  if (p.savePaymentMethod) {
    methods.push(`	// SavePaymentMethod guarda un medio de pago para cobrarlo sin el cliente delante y devuelve la referencia opaca de la
	// pasarela, que no sale nunca del servicio. Un *GatewayRejectedPaymentMethodError si la pasarela no acepta el medio;
	// un *PaymentGatewayUnavailableError si no se sabe qué hizo.
	SavePaymentMethod(ctx context.Context, token, payerReference string) (string, error)`);
  }
  const statusConstants = STATUSES.map(([value, constant, doc]) => `	// ${constant} ${doc}\n	${constant} GatewayStatus = ${goString(value)}`).join('\n');
  return `
// GatewayStatus es el estado de un cobro tal como lo ve la pasarela, en un vocabulario que no depende de cuál sea. Cada
// adaptador traduce a estos valores los estados de la suya.
type GatewayStatus string

// Los estados neutros de un cobro.
const (
${statusConstants}
)

// GatewayOutcome es lo que la pasarela dice de un cobro, ya traducido. Es la ÚNICA forma en que un desenlace entra en el
// servicio, venga de la respuesta síncrona, del aviso o del barrido: el aviso no se lee, se consulta.
type GatewayOutcome struct {
	// Status es el estado neutro.
	Status GatewayStatus
	// Reference es la referencia de negocio del cobro (payments.charge.reference: ${p.charge.reference}), que el adaptador manda a la
	// pasarela y la pasarela devuelve; es lo que identifica el cobro en este servicio. Vacía si no se conoce.
	Reference string
	// GatewayPaymentID es el id que asignó la pasarela; vacío si no llegó a asignarlo.
	GatewayPaymentID string
	// FailureReason es, con GatewayFailed, el motivo en el vocabulario neutro; vacío en otro caso.
	FailureReason ${F}
	// CustomerAction es, con GatewayActionRequired, la acción del cliente como JSON opaco (la consume el componente de la
	// pasarela en el navegador); vacía en otro caso.
	CustomerAction string
	// RefundedAmount es, con GatewayRefunded, lo devuelto en unidades mayores; nil en otro caso.
	RefundedAmount *wire.Decimal
}

// NewGatewayOutcome es un desenlace sin más datos que el estado y los dos ids.
func NewGatewayOutcome(status GatewayStatus, reference, gatewayPaymentID string) GatewayOutcome {
	return GatewayOutcome{Status: status, Reference: reference, GatewayPaymentID: gatewayPaymentID}
}

// FailedOutcome es un cobro que no se hizo, con su motivo.
func FailedOutcome(reference, gatewayPaymentID string, reason ${F}) GatewayOutcome {
	return GatewayOutcome{Status: GatewayFailed, Reference: reference, GatewayPaymentID: gatewayPaymentID, FailureReason: reason}
}

// ActionRequiredOutcome es un cobro que espera una acción del cliente.
func ActionRequiredOutcome(reference, gatewayPaymentID, customerAction string) GatewayOutcome {
	return GatewayOutcome{Status: GatewayActionRequired, Reference: reference, GatewayPaymentID: gatewayPaymentID, CustomerAction: customerAction}
}

// RefundedOutcome es un cobro devuelto, con lo devuelto.
func RefundedOutcome(reference, gatewayPaymentID string, refunded wire.Decimal) GatewayOutcome {
	return GatewayOutcome{Status: GatewayRefunded, Reference: reference, GatewayPaymentID: gatewayPaymentID, RefundedAmount: &refunded}
}

// NotFoundOutcome es que la pasarela no conoce el cobro: la petición no le llegó nunca.
func NotFoundOutcome(reference string) GatewayOutcome {
	return GatewayOutcome{Status: GatewayNotFound, Reference: reference}
}

// PaymentSourceKind dice con qué se paga.
type PaymentSourceKind string

// Los medios de pago.
const (
	// PaymentSourceToken es un token que produjo el componente de la pasarela con el cliente delante.
	PaymentSourceToken PaymentSourceKind = "TOKEN"
	// PaymentSourceSaved es un medio guardado (PaymentGateway.SavePaymentMethod).
	PaymentSourceSaved PaymentSourceKind = "SAVED"
)

// PaymentSource es con qué se paga, siempre como referencia OPACA de la pasarela. Nunca un dato de tarjeta.
type PaymentSource struct {
	kind  PaymentSourceKind
	value string
}

// TokenSource es un medio de pago por su token.
func TokenSource(token string) (PaymentSource, error) {
	return newPaymentSource(PaymentSourceToken, token)
}

// SavedSource es un medio guardado, por la referencia que devolvió PaymentGateway.SavePaymentMethod.
func SavedSource(gatewayReference string) (PaymentSource, error) {
	return newPaymentSource(PaymentSourceSaved, gatewayReference)
}

func newPaymentSource(kind PaymentSourceKind, value string) (PaymentSource, error) {
	if strings.TrimSpace(value) == "" {
		return PaymentSource{}, errors.New("un medio de pago necesita su referencia")
	}
	return PaymentSource{kind: kind, value: value}, nil
}

// Kind es si es un token o un medio guardado.
func (s PaymentSource) Kind() PaymentSourceKind { return s.kind }

// Value es el token, o la referencia del medio guardado.
func (s PaymentSource) Value() string { return s.value }

// ChargeRequest es un cobro a pedir a la pasarela.
type ChargeRequest struct {
	reference string
	amount    wire.Decimal
	currency  string
	source    PaymentSource
}

// NewChargeRequest construye un cobro: reference es la referencia de negocio (payments.charge.reference: ${p.charge.reference}), de la que
// sale la clave de idempotencia hacia la pasarela; amount, el importe en unidades mayores (12.50: la conversión es del
// adaptador); currency, ISO 4217; source, con qué se paga.
func NewChargeRequest(reference string, amount wire.Decimal, currency string, source PaymentSource) (ChargeRequest, error) {
	if reference == "" || currency == "" || source.value == "" {
		return ChargeRequest{}, errors.New("un cobro necesita referencia, importe, moneda y medio de pago")
	}
	if amount.Sign() <= 0 {
		return ChargeRequest{}, errors.New("el importe de un cobro tiene que ser positivo")
	}
	return ChargeRequest{reference: reference, amount: amount, currency: currency, source: source}, nil
}

// Reference es la referencia de negocio del cobro.
func (r ChargeRequest) Reference() string { return r.reference }

// Amount es el importe en unidades mayores.
func (r ChargeRequest) Amount() wire.Decimal { return r.amount }

// Currency es la moneda, ISO 4217.
func (r ChargeRequest) Currency() string { return r.currency }

// Source es con qué se paga.
func (r ChargeRequest) Source() PaymentSource { return r.source }

// PaymentGatewayUnavailableError es que la pasarela no contestó, o contestó con un error suyo (5xx, plazo, conexión): NO se
// sabe si hizo lo que se le pidió. La acción se queda en su estado en vuelo y la resuelve el barrido de reconciliación. Lo
// que no se hace nunca es repetirla a ciegas: puede cobrar o devolver dos veces.
type PaymentGatewayUnavailableError struct {
	// Action es la acción que quedó en duda.
	Action string
	// Detail es lo que se sabe del fallo.
	Detail string
	// Cause es el fallo del transporte, si lo hubo.
	Cause error
}

// Error implementa error.
func (e *PaymentGatewayUnavailableError) Error() string {
	return fmt.Sprintf("la pasarela no contestó a %s (%s): la acción queda en duda", e.Action, e.Detail)
}

// Unwrap es el fallo del transporte.
func (e *PaymentGatewayUnavailableError) Unwrap() error { return e.Cause }
${
  p.savePaymentMethod
    ? `
// GatewayRejectedPaymentMethodError es que la pasarela CONTESTÓ y no acepta el medio de pago que se le pidió guardar (un 4xx).
// Es una respuesta, no una duda: el caso de uso la traduce al error que declare el diseño. Tiene su propio tipo para que el
// handler la reconozca a ella y solo a ella con errors.As: un fallo de programación saldría como el 500 que es.
type GatewayRejectedPaymentMethodError struct {
	// Status es el status HTTP con que contestó la pasarela.
	Status int
}

// Error implementa error.
func (e *GatewayRejectedPaymentMethodError) Error() string {
	return fmt.Sprintf("la pasarela no acepta el medio de pago: HTTP %d", e.Status)
}
`
    : ''
}
// PaymentGateway es la pasarela de pago, vista desde los casos de uso. No nombra ninguna: la implementación la eligió build
// con el stack (keel-stack.json → paymentGateway) y se cambia regenerando, sin tocar el diseño. Este archivo es idéntico con
// cualquier pasarela.
type PaymentGateway interface {
${methods.join('\n')}
}

// PaymentNotice es un aviso de la pasarela tal como llegó: el cuerpo como TEXTO (la firma se calcula sobre él, no sobre un
// JSON re-serializado), las cabeceras y los parámetros de la URL.
type PaymentNotice struct {
	body    string
	headers map[string]string
	query   map[string]string
}

// NewPaymentNotice construye el aviso con el primer valor de cada cabecera (sin distinguir mayúsculas, como HTTP) y de cada
// parámetro de la URL. Un http.Header y un url.Values valen tal cual.
func NewPaymentNotice(body string, headers, query map[string][]string) PaymentNotice {
	return PaymentNotice{body: body, headers: firstValues(headers, true), query: firstValues(query, false)}
}

func firstValues(values map[string][]string, lowerCase bool) map[string]string {
	first := make(map[string]string, len(values))
	for key, all := range values {
		if len(all) == 0 {
			continue
		}
		if lowerCase {
			key = strings.ToLower(key)
		}
		first[key] = all[0]
	}
	return first
}

// Body es el cuerpo tal como llegó.
func (n PaymentNotice) Body() string { return n.body }

// Header es una cabecera, sin distinguir mayúsculas; vacía si no vino.
func (n PaymentNotice) Header(name string) string { return n.headers[strings.ToLower(name)] }

// Param es un parámetro de la URL; vacío si no vino.
func (n PaymentNotice) Param(name string) string { return n.query[name] }

// PaymentNoticeVerifier verifica un aviso de la pasarela y dice de qué cobro habla. Cada pasarela firma a su manera; la
// implementación es la de la pasarela elegida.
type PaymentNoticeVerifier interface {
	// Verify devuelve el id de la pasarela del cobro del que habla el aviso, o vacío si es un aviso válido que no habla de
	// ningún cobro; un *InvalidPaymentNoticeError si la firma no verifica o el aviso es demasiado antiguo.
	Verify(notice PaymentNotice) (string, error)
}

// InvalidPaymentNoticeError es un aviso que no firma la pasarela, o que llega fuera de su ventana.
type InvalidPaymentNoticeError struct {
	// Reason es por qué no vale.
	Reason string
}

// Error implementa error.
func (e *InvalidPaymentNoticeError) Error() string {
	return "aviso de la pasarela no válido: " + e.Reason
}
`;
}

// ─── La aplicación ───────────────────────────────────────────────────────────────────────────────

/**
 * La expresión de un argumento del mensaje de desenlace, ajustada al tipo del componente: `required` apunta el que falta
 * (no se aplica nada a medias), un puntero es opcional. Devuelve null para un componente que la capa no nombra: lo decide
 * un método del agente (outcomeChoices).
 */
function argExpression(model, arg, type, uses) {
  if (!arg.known) return null;
  const F = `domain.${failureReason(model)}`;
  const raw = {
    reference: 'outcome.Reference',
    gatewayPaymentId: 'outcome.GatewayPaymentID',
    failureReason: 'outcome.FailureReason',
    customerAction: 'outcome.CustomerAction',
    refundedAmount: 'outcome.RefundedAmount'
  }[arg.slot];
  const scalar = arg.slot === 'failureReason' ? F : 'string';
  if (arg.slot === 'refundedAmount') {
    if (type === 'wire.Decimal') {
      uses.decimal = true;
      return `requiredDecimal(&missing, ${raw}, ${goString(arg.name)})`;
    }
    if (type === '*wire.Decimal') return raw;
  } else if (arg.slot === 'customerAction') {
    if (type === 'jsontext.Value') {
      uses.required = true;
      return `jsontext.Value(required(&missing, ${raw}, ${goString(arg.name)}))`;
    }
  } else if (type === scalar) {
    uses.required = true;
    return `required(&missing, ${raw}, ${goString(arg.name)})`;
  } else if (type === `*${scalar}`) {
    uses.optional = true;
    return `optional(${raw})`;
  }
  throw new Error(`payments: ${arg.name} es ${type} en el mensaje de desenlace, y keel-go no sabe llevar ahí la ranura ${arg.slot} de la pasarela`);
}

/**
 * Los componentes de un mensaje de desenlace que la capa payments no nombra (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED): build no
 * sabe de dónde salen, y el aplicador lleva la cabecera de código generado, así que cada uno lo decide un MÉTODO del agente
 * en `payment_outcome_choices.go` (sin la cabecera). En los otros tres es un TODO dentro del aplicador.
 */
export function outcomeChoices(model) {
  if (!usesGoPayments(model)) return [];
  const byName = new Map(operations(model).map((operation) => [operation.name, operation]));
  return model.payments.outcomeCommands.flatMap((command) => {
    const operation = byName.get(command.operation);
    const types = new Map(messageComponents(operation, model).map((component) => [component.name, componentType(operation, component)]));
    return command.args
      .filter((arg) => !arg.known)
      .map((arg) => ({ outcome: command.outcome, operation: command.operation, component: arg.name, type: types.get(arg.name), method: `${command.operation}${goExported(arg.name)}` }));
  });
}

function applierCases(model, uses) {
  const byName = new Map(operations(model).map((operation) => [operation.name, operation]));
  const choices = outcomeChoices(model);
  return model.payments.outcomeCommands.map((command) => {
    const operation = byName.get(command.operation);
    const types = new Map(messageComponents(operation, model).map((component) => [component.name, componentType(operation, component)]));
    const rows = [];
    const decided = [];
    for (const arg of command.args) {
      const expression = argExpression(model, arg, types.get(arg.name), uses);
      if (expression != null) {
        rows.push({ indent: '\t\t\t', cells: [`${goExported(arg.name)}:`, `${expression},`] });
        continue;
      }
      const choice = choices.find((candidate) => candidate.operation === command.operation && candidate.component === arg.name);
      decided.push(`\t\t${arg.name}, err := a.${choice.method}(ctx, outcome)\n\t\tif err != nil {\n\t\t\treturn err\n\t\t}\n`);
      rows.push({ indent: '\t\t\t', cells: [`${goExported(arg.name)}:`, `${arg.name},`] });
    }
    const literal = rows.length > 0 ? `${messageType(operation)}{\n${alignRows(rows).join('\n')}\n\t\t}` : `${messageType(operation)}{}`;
    const call = `a.useCases.${useCaseField(operation)}.Handle(ctx, cmd)`;
    const dispatch = contractOf(operation).kind === 'KindCommand' ? `\t\treturn ${call}` : `\t\t_, err := ${call}\n\t\treturn err`;
    return `	case domain.${statusConstant(command.status)}:
${decided.join('')}		cmd := ${literal}
		if err := missing.err(); err != nil {
			return err
		}
${dispatch}`;
  });
}

function applicationBody(model) {
  const p = model.payments;
  const notReceived = reasonConstant(model, 'notReceived');
  const uses = { required: false, optional: false, decimal: false };
  const cases = applierCases(model, uses);
  const helpers = [
    `// outcomeComponents apunta lo que un desenlace de la pasarela no trae y la operación que lo aplica exige.
type outcomeComponents struct {
	missing []string
}

// err es el desenlace que no se puede aplicar: no se aplica nada a medias.
func (c *outcomeComponents) err() error {
	if len(c.missing) > 0 {
		return fmt.Errorf("el desenlace de la pasarela no trae %s, que la operación exige", strings.Join(c.missing, ", "))
	}
	return nil
}`
  ];
  if (uses.required) {
    helpers.push(`// required es un componente obligatorio: si el desenlace no lo trae, se apunta.
func required[T comparable](c *outcomeComponents, value T, component string) T {
	var zero T
	if value == zero {
		c.missing = append(c.missing, component)
	}
	return value
}`);
  }
  if (uses.optional) {
    helpers.push(`// optional es un componente opcional: nil si el desenlace no lo trae.
func optional[T comparable](value T) *T {
	var zero T
	if value == zero {
		return nil
	}
	return &value
}`);
  }
  if (uses.decimal) {
    helpers.push(`// requiredDecimal es un importe obligatorio: si el desenlace no lo trae, se apunta.
func requiredDecimal(c *outcomeComponents, value *wire.Decimal, component string) wire.Decimal {
	if value == nil {
		c.missing = append(c.missing, component)
		return wire.Decimal{}
	}
	return *value
}`);
  }
  const sweep = p.reconciliation?.sweep;
  return `
// PaymentOutcomeApplier aplica un desenlace de la pasarela con la operación del diseño que le corresponde (payments.outcomes).
// Es el único sitio donde un GatewayOutcome se convierte en un cambio del registro, venga de la respuesta síncrona, del aviso
// o del barrido.
//
// Los handlers de esas operaciones tienen que ser IDEMPOTENTES: el mismo desenlace puede llegar por dos caminos, y uno tardío
// puede encontrar el cobro fuera del estado de origen. En los dos casos no se hace nada y no es un error
// (docs/dsl/payments.md § Los desenlaces). Dos desenlaces DISTINTOS a la vez los arbitra el bloqueo optimista.
type PaymentOutcomeApplier struct {
	useCases *UseCases${recordField(model)}
}

// Apply aplica outcome. GatewayPending y GatewayNotFound no son desenlaces: el llamante decide qué hacer con ellos.
//
// Cada desenlace se aplica en SU transacción, aunque llegue de un caso de uso despachado sin ella (las acciones de la capa y
// el barrido van con WithoutTransaction): el desenlace es un cambio del registro como cualquier otro.
func (a *PaymentOutcomeApplier) Apply(ctx context.Context, outcome domain.GatewayOutcome) error {
	ctx = context.WithValue(ctx, withoutTransactionKey{}, false)
	var missing outcomeComponents
	switch outcome.Status {
${cases.join('\n')}
	}
	// Sin desenlace que aplicar.
	return nil
}

${helpers.join('\n\n')}

// PaymentNotices es lo que se hace con un aviso de la pasarela: verificarlo, preguntarle a la pasarela el estado del cobro y
// aplicar el desenlace. El contenido del aviso no se usa para nada más que para saber de qué cobro habla.
type PaymentNotices struct {
	gateway  domain.PaymentGateway
	verifier domain.PaymentNoticeVerifier
	outcomes *PaymentOutcomeApplier
}

// Receive atiende un aviso. Uno que no verifica devuelve el *domain.InvalidPaymentNoticeError del verificador sin consultar
// nada; uno que verifica tampoco decide nada: el desenlace se le pregunta a la pasarela.
func (n *PaymentNotices) Receive(ctx context.Context, notice domain.PaymentNotice) error {
	gatewayPaymentID, err := n.verifier.Verify(notice)
	if err != nil || gatewayPaymentID == "" {
		return err
	}
	outcome, err := n.gateway.Status(ctx, "", gatewayPaymentID)
	if err != nil {
		return err
	}
	if outcome.Status == domain.GatewayPending || outcome.Status == domain.GatewayNotFound {
		return nil
	}
	return n.outcomes.Apply(ctx, outcome)
}

// PaymentReconciliationSettings son los dos números del barrido de pagos (${sweep}): el silencio tolerado antes de
// preguntar por un cobro que espera desenlace, que lo declara el diseño (payments.reconciliation.unansweredAfterSeconds;
// en local y test se acorta), y cuántos consulta una pasada (${PAYMENT_SWEEP_PARAMETERS.batchSize.key}): capacidad, no diseño.
type PaymentReconciliationSettings struct {
	// UnansweredAfter es el silencio tolerado.
	UnansweredAfter time.Duration
	// BatchSize es cuántos cobros consulta una pasada como máximo.
	BatchSize int
}

// PaymentReconciliation es la consulta del barrido de reconciliación (${sweep}) para UN cobro que espera desenlace: le
// pregunta a la pasarela y aplica lo que diga.
//
// Lo que no hace es elegir los candidatos ni reclamarlos: eso es del handler del barrido. Los candidatos son los cobros en
// ${p.awaitingStates.join(', ')} cuyo ${p.record.awaitingSince} es anterior a StaleBefore; y el handler reclama cada uno
// volviendo a estampar ${p.record.awaitingSince} ANTES de llamar aquí, para que otra réplica no lo consulte en la misma pasada.${
      scheduledByTimer(model, p.reconciliation.sweep)
        ? `
//
// El barrido lo dispara el cronómetro en una réplica por tick, y el tick DRENA: si el handler reclamó un lote lleno
// (BatchSize() cobros), que lo avise con SweepClaimed(ctx, reclamados, BatchSize()) —application.SweepClaimed desde el
// adaptador, donde va el reclamo— y el tick repetirá la pasada.`
        : ''
    }
type PaymentReconciliation struct {
	gateway  domain.PaymentGateway
	outcomes *PaymentOutcomeApplier
	settings PaymentReconciliationSettings
}

// StaleBefore es el corte del barrido: un cobro que espera desde antes de este instante lleva demasiado sin desenlace.
func (r *PaymentReconciliation) StaleBefore(now time.Time) time.Time {
	return now.Add(-r.settings.UnansweredAfter)
}

// BatchSize es cuántos cobros consulta una pasada como máximo. Sin cota, una tanda con miles de atascados son miles de
// llamadas a la pasarela en una sola pasada.
func (r *PaymentReconciliation) BatchSize() int {
	return r.settings.BatchSize
}

// Consult pregunta por un cobro y devuelve el estado que dio la pasarela. Con GatewayPending no se aplica nada: el cobro se
// queda para la siguiente pasada. Con el estado del que salió una acción de seguimiento (GatewayAuthorized tras capturing o
// canceling, GatewayCaptured tras refunding), la acción no llegó a hacerse y el handler devuelve el cobro a ese estado.
func (r *PaymentReconciliation) Consult(ctx context.Context, reference, gatewayPaymentID string) (domain.GatewayStatus, error) {
	outcome, err := r.gateway.Status(ctx, reference, gatewayPaymentID)
	if err != nil {
		return "", err
	}
	if outcome.Status == domain.GatewayNotFound {
		// La petición no llegó nunca a la pasarela: el cobro falló sin que nadie cobrara nada.
		return domain.GatewayNotFound, r.outcomes.Apply(ctx, domain.FailedOutcome(reference, "", domain.${notReceived}))
	}
	if outcome.Status != domain.GatewayPending {
		if err := r.outcomes.Apply(ctx, outcome); err != nil {
			return "", err
		}
	}
	return outcome.Status, nil
}
`;
}

/** El repositorio del registro (payments.record.entity), que reciben las decisiones del agente; null sin ninguna. */
function recordRepository(model) {
  if (outcomeChoices(model).length === 0) return null;
  const root = repositoryRoots(model).find((candidate) => candidate.name === model.payments.record.entity);
  return root ? { param: repositoryParam(root), type: `domain.${portName(root)}`, entity: root.name } : null;
}

function recordField(model) {
  const record = recordRepository(model);
  if (!record) return '';
  return `
	// ${record.param} es el repositorio del registro (${record.entity}): lo leen las decisiones de payment_outcome_choices.go, que
	// conocen el estado del que viene el cobro.
	//
	//lint:ignore U1000 lo usa la lógica que escribe el agente (payment_outcome_choices.go).
	${record.param} ${record.type}`;
}

/** payment_outcome_choices.go: lo que la capa no nombra, decidido por el agente (sin la cabecera de código generado). */
function choicesBody(model) {
  return outcomeChoices(model)
    .map(
      (choice) => `
// ${choice.method} decide el ${choice.component} del desenlace ${choice.outcome} (${choice.operation}), que la capa payments no nombra
// (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED): build no sabe de dónde sale. Lo dice el diseño en prosa —la decisión aceptada en
// decisions.yaml, o las reglas de ${choice.operation}—; el estado del que viene el cobro se lee con el repositorio del registro.
// Mientras no se decida, ese desenlace falla en voz alta en vez de aplicarse con un valor inventado.
func (a *PaymentOutcomeApplier) ${choice.method}(ctx context.Context, outcome domain.GatewayOutcome) (${choice.type}, error) {
	// TODO (agente): decidir ${choice.component} a partir del desenlace y del estado del cobro.
	var choice ${choice.type}
	return choice, fmt.Errorf("%w: %s", ErrNotImplemented, ${goString(`${choice.component} del desenlace ${choice.outcome}`)})
}
`
    )
    .join('');
}

// ─── La ruta del aviso ───────────────────────────────────────────────────────────────────────────

function noticeEndpointBody() {
  return `
// paymentNoticePath es la ruta del aviso de la pasarela: fuera de la API versionada, es la URL que se registra en su panel.
// La deja pasar sin credencial el plan de acceso neutral, porque la protege la firma.
const paymentNoticePath = ${goString(PAYMENT_NOTICE_PATH)}

// receivePaymentNotice es el aviso de la pasarela. Entra sin credencial —quien llama es la pasarela, que no tiene identidad
// aquí— y lo protege la FIRMA, que se verifica sobre el cuerpo tal como llegó, leído como texto y sin el contrato del cable.
// Uno que no verifica se responde con 401 vacío y no se consulta nada; uno que verifica tampoco decide nada: el desenlace se
// le pregunta a la pasarela (application.PaymentNotices).
func (a *api) receivePaymentNotice(w http.ResponseWriter, r *http.Request) error {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	err = a.useCases.PaymentNotices.Receive(r.Context(), domain.NewPaymentNotice(string(body), r.Header, r.URL.Query()))
	var invalid *domain.InvalidPaymentNoticeError
	if errors.As(err, &invalid) {
		a.logger.WarnContext(r.Context(), "aviso de la pasarela rechazado", "reason", invalid.Reason)
		w.WriteHeader(http.StatusUnauthorized)
		return nil
	}
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusOK)
	return nil
}
`;
}

// ─── La infraestructura común ────────────────────────────────────────────────────────────────────

function settingsBody() {
  const unanswered = PAYMENT_SWEEP_PARAMETERS.unansweredAfterSeconds;
  const batch = PAYMENT_SWEEP_PARAMETERS.batchSize;
  return `
// Settings es la configuración de la pasarela (config/parameters/<perfil>/payments.yaml, las MISMAS claves y variables que
// keel-spring, keel-nest y keel-dotnet). En producción la credencial y el secreto de firma vienen del entorno sin default; en
// local y test la URL apunta a la pasarela de prueba de infra/.
type Settings struct {
	// BaseURL es la URL de la API de la pasarela, sin barra final.
	BaseURL string
	// APIKey es la credencial con la que se le habla.
	APIKey string
	// WebhookSecret es el secreto con el que firma sus avisos.
	WebhookSecret string
	// ConnectTimeout es cuánto se espera para conectar.
	ConnectTimeout time.Duration
	// ReadTimeout es cuánto se espera la respuesta; superado, la acción queda EN DUDA.
	ReadTimeout time.Duration
	// NoticeTolerance es la antigüedad máxima de un aviso firmado (contra la repetición).
	NoticeTolerance time.Duration
	// UnansweredAfter es el silencio tolerado antes de que el barrido pregunte por un cobro.
	UnansweredAfter time.Duration
	// BatchSize es cuántos cobros consulta una pasada del barrido como máximo.
	BatchSize int
}

// SettingsFrom lee payments.* de la configuración del perfil. Sin la URL, la credencial o el secreto, o con un número o una
// duración que no se entiende, no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key string) string {
		value, _ := cfg.Value(key)
		return strings.TrimSpace(value)
	}
	required := func(key string) (string, error) {
		if value := text(key); value != "" {
			return value, nil
		}
		return "", fmt.Errorf("%s es obligatoria: sin ella no se le puede hablar a la pasarela", key)
	}
	positive := func(key string, fallback int) (int, error) {
		value := text(key)
		if value == "" {
			return fallback, nil
		}
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 {
			return 0, fmt.Errorf("%s tiene que ser un entero positivo: %q", key, value)
		}
		return parsed, nil
	}
	var s Settings
	var err error
	if s.BaseURL, err = required("payments.gateway.base-url"); err != nil {
		return Settings{}, err
	}
	s.BaseURL = strings.TrimRight(s.BaseURL, "/")
	if s.APIKey, err = required("payments.gateway.api-key"); err != nil {
		return Settings{}, err
	}
	if s.WebhookSecret, err = required("payments.gateway.webhook-secret"); err != nil {
		return Settings{}, err
	}
	if s.ConnectTimeout, err = duration("payments.gateway.connect-timeout", text("payments.gateway.connect-timeout"), 2*time.Second); err != nil {
		return Settings{}, err
	}
	if s.ReadTimeout, err = duration("payments.gateway.read-timeout", text("payments.gateway.read-timeout"), 10*time.Second); err != nil {
		return Settings{}, err
	}
	tolerance, err := positive("payments.gateway.notice-tolerance-seconds", 300)
	if err != nil {
		return Settings{}, err
	}
	s.NoticeTolerance = time.Duration(tolerance) * time.Second
	unanswered, err := positive(${goString(unanswered.key)}, 900)
	if err != nil {
		return Settings{}, err
	}
	s.UnansweredAfter = time.Duration(unanswered) * time.Second
	if s.BatchSize, err = positive(${goString(batch.key)}, ${batch.default}); err != nil {
		return Settings{}, err
	}
	return s, nil
}

// Reconciliation son los números del barrido de pagos, para los casos de uso.
func (s Settings) Reconciliation() application.PaymentReconciliationSettings {
	return application.PaymentReconciliationSettings{UnansweredAfter: s.UnansweredAfter, BatchSize: s.BatchSize}
}

// simpleDuration es una duración con la sintaxis de keel-spring: un número con unidad o a secas (milisegundos).
var simpleDuration = regexp.MustCompile(\`^(\\d+)(ns|us|ms|s|m|h|d)?$\`)

// isoDuration es una duración ISO-8601 de horas, minutos y segundos (PT10S).
var isoDuration = regexp.MustCompile(\`(?i)^PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?$\`)

// duration lee una duración con la sintaxis de keel-spring, para que el mismo .env valga para los cuatro servidores: \`2s\`,
// \`500ms\`, un número a secas (milisegundos) o ISO-8601 (\`PT10S\`).
func duration(key, value string, fallback time.Duration) (time.Duration, error) {
	if value == "" {
		return fallback, nil
	}
	if match := simpleDuration.FindStringSubmatch(value); match != nil {
		amount, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%s no es una duración: %q", key, value)
		}
		unit := map[string]time.Duration{"": time.Millisecond, "ns": time.Nanosecond, "us": time.Microsecond, "ms": time.Millisecond, "s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[match[2]]
		return time.Duration(amount) * unit, nil
	}
	if match := isoDuration.FindStringSubmatch(value); match != nil && len(value) > 2 {
		var total time.Duration
		for index, unit := range []time.Duration{time.Hour, time.Minute} {
			if match[index+1] != "" {
				amount, err := strconv.ParseInt(match[index+1], 10, 64)
				if err != nil {
					return 0, fmt.Errorf("%s no es una duración: %q", key, value)
				}
				total += time.Duration(amount) * unit
			}
		}
		if match[3] != "" {
			seconds, err := strconv.ParseFloat(match[3], 64)
			if err != nil {
				return 0, fmt.Errorf("%s no es una duración: %q", key, value)
			}
			total += time.Duration(seconds * float64(time.Second))
		}
		return total, nil
	}
	return 0, fmt.Errorf("%s no es una duración: %q", key, value)
}
`;
}

const HTTP_BODY = `
// gatewayRequest es una petición a la pasarela.
type gatewayRequest struct {
	method string
	// path es la ruta con su query ya codificada.
	path string
	// contentType y body son el cuerpo ya escrito; vacíos en un GET.
	contentType string
	body        string
	// idempotencyHeader e idempotencyKey son la cabecera de idempotencia de la pasarela y su clave, en las escrituras.
	idempotencyHeader string
	idempotencyKey    string
}

// gatewayAnswer es lo que contestó la pasarela: el status y el cuerpo como texto, sin interpretar.
type gatewayAnswer struct {
	status int
	text   string
}

// errNoAnswer es que la pasarela no contestó: no se pudo conectar, se cortó la respuesta a medias o venció el plazo. NO se
// sabe qué hizo, y quien llama lo convierte en un *domain.PaymentGatewayUnavailableError (la acción queda en duda).
var errNoAnswer = errors.New("la pasarela no contestó")

// gatewayHTTP es el cliente HTTP de la pasarela, sobre net/http. Sin reintentos A PROPÓSITO: reintentar una escritura que
// la pasarela pudo haber hecho es cobrar dos veces. Una respuesta que no llega deja la acción en duda, y eso lo resuelve el
// barrido preguntando.
//
// Y sin keep-alive: net/http reenvía POR SU CUENTA una petición con Idempotency-Key (o X-Idempotency-Key) cuando la conexión
// reutilizada se corta antes de la respuesta, y aquí eso es una segunda escritura que nadie pidió. Con una conexión por
// petición no hay conexión reutilizada que se corte. El plazo total es el de conexión más el de lectura, el mismo tope que
// el de los otros servidores.
type gatewayHTTP struct {
	settings Settings
	client   *http.Client
}

func newGatewayHTTP(settings Settings) *gatewayHTTP {
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: settings.ConnectTimeout}).DialContext,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: settings.ReadTimeout,
	}
	return &gatewayHTTP{
		settings: settings,
		client: &http.Client{
			Transport: transport,
			Timeout:   settings.ConnectTimeout + settings.ReadTimeout,
			// Una redirección no se sigue: la pasarela no la usa, y seguirla repetiría una escritura en otra URL.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// send manda la petición y devuelve cualquier status, también 4xx y 5xx, como respuesta; errNoAnswer (envuelto) si no llegó
// una respuesta entera.
func (h *gatewayHTTP) send(ctx context.Context, request gatewayRequest) (gatewayAnswer, error) {
	var body io.Reader
	if request.body != "" {
		body = strings.NewReader(request.body)
	}
	req, err := http.NewRequestWithContext(ctx, request.method, h.settings.BaseURL+request.path, body)
	if err != nil {
		return gatewayAnswer{}, fmt.Errorf("petición a la pasarela: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+h.settings.APIKey)
	req.Header.Set("Accept", "application/json")
	if request.contentType != "" {
		req.Header.Set("Content-Type", request.contentType)
	}
	if request.idempotencyKey != "" {
		req.Header.Set(request.idempotencyHeader, request.idempotencyKey)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return gatewayAnswer{}, fmt.Errorf("%w: %w", errNoAnswer, err)
	}
	defer resp.Body.Close()
	// El cuerpo se lee aquí: un corte a mitad de la respuesta también es «no contestó».
	text, err := io.ReadAll(resp.Body)
	if err != nil {
		return gatewayAnswer{}, fmt.Errorf("%w: %w", errNoAnswer, err)
	}
	return gatewayAnswer{status: resp.StatusCode, text: string(text)}, nil
}
`;

function moneyBody() {
  const entries = Object.entries(CURRENCY_MINOR_UNITS);
  const lines = [];
  for (let index = 0; index < entries.length; index += 10) {
    lines.push(`\t${entries.slice(index, index + 10).map(([code, digits]) => `${goString(code)}: ${digits},`).join(' ')}`);
  }
  return `
// minorUnits son los decimales de la unidad menor de cada moneda ISO 4217. Es la tabla de keel-core (la del JDK, la que usa el
// servidor de keel-spring), escrita aquí tal cual a propósito: los cuatro servidores del diseño tienen que convertir el mismo
// importe a la misma unidad, y una tabla de otra fuente (CLDR) discrepa en 25 monedas —IQD da 0 decimales en vez de 3—.
var minorUnits = map[string]int32{
${lines.join('\n')}
}

// digitsOf son los decimales de la moneda; una que no está en la tabla no se cobra.
func digitsOf(currency string) (int32, error) {
	digits, ok := minorUnits[currency]
	if !ok {
		return 0, fmt.Errorf("moneda desconocida: %q", currency)
	}
	return digits, nil
}

// exactAmount es el importe con la escala exacta de la moneda, o un error si para eso hubiera que redondear: un importe con
// más decimales de los que admite la moneda es un error, no un céntimo que se pierde.
func exactAmount(amount wire.Decimal, currency string) (wire.Decimal, error) {
	digits, err := digitsOf(currency)
	if err != nil {
		return wire.Decimal{}, err
	}
	scaled := amount.Rescale(digits, wire.RoundDown)
	if scaled.Cmp(amount) != 0 {
		return wire.Decimal{}, fmt.Errorf("el importe %s tiene más decimales de los que admite %s", amount, currency)
	}
	return scaled, nil
}

// toMinorUnits es 12.50 EUR → "1250".
func toMinorUnits(amount wire.Decimal, currency string) (string, error) {
	scaled, err := exactAmount(amount, currency)
	if err != nil {
		return "", err
	}
	minor, err := strconv.ParseInt(strings.Replace(scaled.String(), ".", "", 1), 10, 64)
	if err != nil {
		return "", fmt.Errorf("el importe %s no cabe en la unidad menor de %s: %w", amount, currency, err)
	}
	return strconv.FormatInt(minor, 10), nil
}

// fromMinorUnits es 1250 EUR → 12.50.
func fromMinorUnits(minor int64, currency string) (wire.Decimal, error) {
	digits, err := digitsOf(currency)
	if err != nil {
		return wire.Decimal{}, err
	}
	return wire.NewDecimal(minor, digits), nil
}

// toMajorUnits es el importe como lo escribe una pasarela que trabaja en unidades mayores: "12.50".
func toMajorUnits(amount wire.Decimal, currency string) (string, error) {
	scaled, err := exactAmount(amount, currency)
	if err != nil {
		return "", err
	}
	return scaled.String(), nil
}
`;
}

const JSON_BODY = `
// jsonObject es un objeto JSON de la pasarela, leído sin tipos: cada adaptador mira solo los campos que traduce.
type jsonObject = map[string]any

// decodeObject lee el cuerpo de una respuesta; uno vacío es un objeto vacío.
func decodeObject(text string) (jsonObject, error) {
	if strings.TrimSpace(text) == "" {
		return jsonObject{}, nil
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, fmt.Errorf("la pasarela devolvió un cuerpo que no es JSON: %w", err)
	}
	if object, ok := value.(jsonObject); ok {
		return object, nil
	}
	return jsonObject{}, nil
}

// objectOf es el objeto de un campo, o uno vacío si falta o no es un objeto.
func objectOf(value any) jsonObject {
	if object, ok := value.(jsonObject); ok {
		return object
	}
	return jsonObject{}
}

// isObject dice si el campo es un objeto.
func isObject(value any) bool {
	_, ok := value.(jsonObject)
	return ok
}

// firstObject es el primer elemento de un array si es un objeto; si no, uno vacío.
func firstObject(value any) jsonObject {
	if list, ok := value.([]any); ok && len(list) > 0 {
		return objectOf(list[0])
	}
	return jsonObject{}
}

// textOf es el texto de un campo escalar, como la lectura de los otros tres servidores: falta, null o no escalar es vacío;
// un número vale su texto.
func textOf(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

// minorOf es un importe entero de la pasarela (unidad menor). Uno que falta o no es entero es 0, como el asLong() de
// keel-spring.
func minorOf(value any) int64 {
	parsed, err := strconv.ParseInt(textOf(value), 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}
`;

/** La expresión Go de una plantilla de clave de keel-core: `${reference}:${action}` → `reference + ":" + action`. */
export function goConcat(template, names) {
  const parts = [];
  let rest = template;
  const markers = Object.keys(names);
  while (rest.length > 0) {
    const next = markers.map((marker) => [marker, rest.indexOf(marker)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1])[0];
    if (!next) {
      parts.push(goString(rest));
      break;
    }
    if (next[1] > 0) parts.push(goString(rest.slice(0, next[1])));
    parts.push(names[next[0]]);
    rest = rest.slice(next[1] + next[0].length);
  }
  return parts.join(' + ');
}

function keysBody() {
  return `
// idempotencyKey es la clave de una acción sobre un cobro (keel-core/gen/payment-gateways.js): sale de la referencia de
// NEGOCIO, nunca de un aleatorio, para que un reintento —por cualquiera de las dos puertas y por cualquiera de los cuatro
// servidores del diseño— repita la clave.
func idempotencyKey(reference, action string) string {
	return ${goConcat(paymentIdempotencyKey('R', 'A'), { 'R': 'reference', 'A': 'action' })}
}

// savedKey es la clave de cada paso de guardar un medio de pago.
func savedKey(token, step string) string {
	return ${goConcat(savedMethodIdempotencyKey('T', 'S'), { 'T': 'token', 'S': 'step' })}
}

// savedMethodSeparator junta los dos ids de la pasarela de un medio guardado (\`<cliente>${SAVED_METHOD_SEPARATOR}<medio>\`): si un servidor lo
// escribiera con otro, un medio guardado por uno no lo podría cobrar el otro.
const savedMethodSeparator = ${goString(SAVED_METHOD_SEPARATOR)}

// splitSaved parte la referencia de un medio guardado en sus dos ids.
func splitSaved(value string) (string, string, error) {
	customer, method, ok := strings.Cut(value, savedMethodSeparator)
	if !ok {
		return "", "", fmt.Errorf("un medio guardado es <cliente>%s<medio>: esta referencia no lo es", savedMethodSeparator)
	}
	return customer, method, nil
}

// formContentType y jsonContentType son los dos cuerpos que se mandan a una pasarela.
const (
	// formContentType es el de un formulario (Stripe).
	formContentType = "application/x-www-form-urlencoded"
	// jsonContentType es el de un documento JSON (MercadoPago).
	jsonContentType = "application/json"
)

// formBody es un formulario en el orden en que se escriben sus campos, como lo escriben los otros servidores (url.Values
// los ordena por nombre).
type formBody struct {
	pairs []string
}

// add añade un campo.
func (f *formBody) add(name, value string) {
	f.pairs = append(f.pairs, url.QueryEscape(name)+"="+url.QueryEscape(value))
}

// encode es el formulario escrito.
func (f *formBody) encode() string {
	return strings.Join(f.pairs, "&")
}

// encodeJSON escribe un cuerpo JSON con las claves en orden (determinista).
func encodeJSON(value any) (string, error) {
	text, err := json.Marshal(value, json.Deterministic(true))
	if err != nil {
		return "", fmt.Errorf("escribir el cuerpo para la pasarela: %w", err)
	}
	return string(text), nil
}

// invalidNotice es un aviso que no vale, con su motivo.
func invalidNotice(reason string) error {
	return &domain.InvalidPaymentNoticeError{Reason: reason}
}

// unavailableAnswer es la duda de una respuesta 5xx (o la de una lectura que no se entiende): no se sabe qué hizo.
func unavailableAnswer(gateway, action string, answer gatewayAnswer) error {
	return &domain.PaymentGatewayUnavailableError{Action: action, Detail: fmt.Sprintf("%s: HTTP %d", gateway, answer.status)}
}

// noAnswer convierte el «no contestó» del cliente HTTP en la duda del dominio; otro error pasa tal cual.
func noAnswer(gateway, action string, err error) error {
	if errors.Is(err, errNoAnswer) {
		return &domain.PaymentGatewayUnavailableError{Action: action, Detail: gateway + " no contestó", Cause: err}
	}
	return err
}
`;
}
