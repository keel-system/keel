// Cobros con pasarela (capa payments, DSL 2.19). La parte NEUTRA: lo que es igual sea cual sea la
// pasarela elegida. El adaptador de cada pasarela lo emite su módulo en ./payment-gateways/.
//
// Build genera el puerto, el adaptador y el aviso enteros, y no se los deja al agente, por el mismo
// criterio que el correo (constitution.md § Contenido de origen externo): lo que llevan dentro son
// defensas cuya ausencia no rompe ninguna prueba.
//
//   * La verificación de la FIRMA del aviso, sobre el cuerpo crudo y en tiempo constante. Sin ella,
//     cualquiera que conozca la URL marca un cobro como pagado; con ella mal hecha (sobre el JSON
//     re-serializado, o con equals), igual. El escenario feliz pasa en los dos casos.
//   * Que el aviso NO decida el desenlace: se le pregunta a la pasarela. En alguna pasarela la firma
//     no cubre el cuerpo, y quien lo altere en tránsito decidiría el estado del cobro.
//   * La clave de idempotencia hacia la pasarela, derivada de la referencia de negocio del cobro y
//     de la acción. Una clave aleatoria por llamada es lo que sale por defecto, y con ella un
//     reintento cobra dos veces.
//   * La conversión del importe a la unidad de cada pasarela, sin redondear en silencio.
//   * La traducción de los rechazos al vocabulario neutro (FAILURE_REASONS de keel-core).
//
// Lo que NO genera: la lógica de los casos de uso (cuándo se llama al puerto y qué transición
// aplica cada handler), que es del diseño y la escribe el agente con la skill de la pasarela.

import { javaFile, javaPath, subPackage } from './render.js';
import { pascalCase } from '../lib/naming.js';
import { PAYMENT_NOTICE_PATH } from 'keel-core/gen/payment-gateways';
import * as stripe from './payment-gateways/stripe.js';
import * as mercadopago from './payment-gateways/mercadopago.js';

export const DOMAIN_PKG = 'domain.payment';
export const PORT_PKG = 'application.port.out';
export const APP_PKG = 'application.payment';
export const INFRA_PKG = 'infrastructure.payment';
const ENUMS_PKG = 'domain.enums';

// La ruta del aviso de la pasarela es neutral: la seguridad de los dos generadores la deja pasar.
export { PAYMENT_NOTICE_PATH };

const GATEWAY_MODULES = { stripe, mercadopago };

export function generate(model) {
  const payments = model.payments;
  if (!payments) return [];
  const gatewayModule = GATEWAY_MODULES[payments.gateway.id];
  if (!gatewayModule) throw new Error(`payments: la pasarela '${payments.gateway.id}' no tiene módulo de generación`);
  return [
    renderGatewayStatus(model),
    renderGatewayOutcome(model),
    renderPaymentSource(model),
    renderChargeRequest(model),
    renderUnavailable(model),
    renderPort(model),
    renderOutcomeApplier(model),
    renderNotices(model),
    renderReconciliation(model),
    renderProperties(model),
    renderHttpConfig(model),
    renderMoneyAmounts(model),
    renderNoticeVerifierPort(model),
    renderInvalidNotice(model),
    renderNoticeController(model),
    ...gatewayModule.generate(model, context(model))
  ];
}

/** Lo que los módulos de cada pasarela necesitan saber de la parte neutra. */
export function context(model) {
  const base = model.service.basePackage;
  return {
    domainPkg: `${base}.${DOMAIN_PKG}`,
    portPkg: `${base}.${PORT_PKG}`,
    infraPkg: `${base}.${INFRA_PKG}`,
    failureEnum: `${base}.${ENUMS_PKG}.${model.payments.record.failureReasonType}`,
    failureEnumName: model.payments.record.failureReasonType,
    failureConstant: (literal) => model.payments.failureReasons.find((entry) => entry.literal === literal).constant
  };
}

// ─── Dominio: el vocabulario neutro del puerto ───────────────────────────────

function renderGatewayStatus(model) {
  const body = `/**
 * El estado de un cobro tal como lo ve la pasarela, en un vocabulario que no depende de cuál sea.
 * Cada adaptador traduce a estos valores los estados de la suya.
 */
public enum GatewayStatus {
    /** La pasarela lo tiene, pero todavía no hay desenlace. */
    PENDING,
    /** Espera a que el cliente se autentique (3DS, redirección). */
    ACTION_REQUIRED,
    /** Importe retenido, pendiente de captura. */
    AUTHORIZED,
    /** Cobrado. */
    CAPTURED,
    /** Devuelto, todo o en parte. */
    REFUNDED,
    /** La autorización se anuló o caducó. */
    CANCELED,
    /** El cobro no se hizo. */
    FAILED,
    /** La pasarela no conoce el cobro: la petición no le llegó nunca. */
    NOT_FOUND
}`;
  return file(model, DOMAIN_PKG, 'GatewayStatus', [], body);
}

function renderGatewayOutcome(model) {
  const { failureReasonType } = model.payments.record;
  const failureEnum = `${model.service.basePackage}.${ENUMS_PKG}.${failureReasonType}`;
  const body = `/**
 * Lo que la pasarela dice de un cobro, ya traducido. Es la ÚNICA forma en que un desenlace entra
 * en el servicio, venga de la respuesta síncrona, del aviso o del barrido: el aviso no se lee,
 * se consulta.
 *
 * @param status           el estado neutro
 * @param reference        la referencia de negocio del cobro, que el adaptador manda a la pasarela
 *                         y la pasarela devuelve; es lo que identifica el cobro en este servicio
 * @param gatewayPaymentId el id que asignó la pasarela, o null si no llegó a asignarlo
 * @param failureReason    con FAILED, el motivo en el vocabulario neutro; null en otro caso
 * @param customerAction   con ACTION_REQUIRED, la acción del cliente, opaca (la consume el
 *                         componente de la pasarela en el navegador); null en otro caso
 * @param refundedAmount   con REFUNDED, lo devuelto en unidades mayores; null en otro caso
 */
public record GatewayOutcome(GatewayStatus status, String reference, String gatewayPaymentId,
        ${failureReasonType} failureReason, String customerAction, BigDecimal refundedAmount) {

    public GatewayOutcome {
        Objects.requireNonNull(status, "status");
    }

    public static GatewayOutcome of(GatewayStatus status, String reference, String gatewayPaymentId) {
        return new GatewayOutcome(status, reference, gatewayPaymentId, null, null, null);
    }

    public static GatewayOutcome failed(String reference, String gatewayPaymentId, ${failureReasonType} reason) {
        return new GatewayOutcome(GatewayStatus.FAILED, reference, gatewayPaymentId, reason, null, null);
    }

    public static GatewayOutcome actionRequired(String reference, String gatewayPaymentId, String customerAction) {
        return new GatewayOutcome(GatewayStatus.ACTION_REQUIRED, reference, gatewayPaymentId, null, customerAction, null);
    }

    public static GatewayOutcome refunded(String reference, String gatewayPaymentId, BigDecimal refundedAmount) {
        return new GatewayOutcome(GatewayStatus.REFUNDED, reference, gatewayPaymentId, null, null, refundedAmount);
    }

    /** La pasarela no conoce el cobro: la petición no le llegó nunca. */
    public static GatewayOutcome notFound(String reference) {
        return new GatewayOutcome(GatewayStatus.NOT_FOUND, reference, null, null, null, null);
    }
}`;
  return file(model, DOMAIN_PKG, 'GatewayOutcome', ['java.math.BigDecimal', 'java.util.Objects', failureEnum], body);
}

function renderPaymentSource(model) {
  const body = `/**
 * Con qué se paga, siempre como referencia OPACA de la pasarela. Nunca un dato de tarjeta.
 *
 * @param kind  TOKEN si lo produjo el componente de la pasarela con el cliente delante; SAVED si es
 *              la referencia de un medio guardado (cliente ausente)
 * @param value el token, o la referencia que devolvió {@link ${portRef(model)}#savePaymentMethod}
 */
public record PaymentSource(Kind kind, String value) {

    public enum Kind { TOKEN, SAVED }

    public PaymentSource {
        Objects.requireNonNull(kind, "kind");
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Un medio de pago necesita su referencia");
        }
    }

    public static PaymentSource token(String token) {
        return new PaymentSource(Kind.TOKEN, token);
    }

    public static PaymentSource saved(String gatewayReference) {
        return new PaymentSource(Kind.SAVED, gatewayReference);
    }
}`;
  return file(model, DOMAIN_PKG, 'PaymentSource', ['java.util.Objects'], body);
}

function renderChargeRequest(model) {
  const body = `/**
 * Un cobro a pedir a la pasarela.
 *
 * @param reference   la referencia de negocio del cobro (payments.charge.reference: ${model.payments.charge.reference}).
 *                    De ella sale la clave de idempotencia hacia la pasarela, y la pasarela la
 *                    devuelve en cada consulta: es lo que permite reconciliar un cobro sin respuesta
 * @param amount      el importe en unidades mayores (12.50); la conversión es del adaptador
 * @param currency    ISO 4217
 * @param source      con qué se paga
 */
public record ChargeRequest(String reference, BigDecimal amount, String currency, PaymentSource source) {

    public ChargeRequest {
        Objects.requireNonNull(reference, "reference");
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(currency, "currency");
        Objects.requireNonNull(source, "source");
        if (amount.signum() <= 0) {
            throw new IllegalArgumentException("El importe de un cobro tiene que ser positivo");
        }
    }
}`;
  return file(model, DOMAIN_PKG, 'ChargeRequest', ['java.math.BigDecimal', 'java.util.Objects'], body);
}

function renderUnavailable(model) {
  const body = `/**
 * La pasarela no contestó, o contestó con un error suyo (5xx, timeout, conexión): NO se sabe si
 * hizo lo que se le pidió. La acción se queda en su estado en vuelo y la resuelve el barrido de
 * reconciliación. Lo que no se hace nunca es repetirla a ciegas: puede cobrar o devolver dos veces.
 */
public class PaymentGatewayUnavailableException extends RuntimeException {

    public PaymentGatewayUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}`;
  return file(model, DOMAIN_PKG, 'PaymentGatewayUnavailableException', [], body);
}

// ─── Puerto ──────────────────────────────────────────────────────────────────

function portRef(model) {
  return `${model.service.basePackage}.${PORT_PKG}.PaymentGateway`;
}

function renderPort(model) {
  const payments = model.payments;
  const domain = `${model.service.basePackage}.${DOMAIN_PKG}`;
  const methods = [
    `    /**
     * Pide el cobro (${payments.captureLater ? 'solo lo AUTORIZA: flow authorize-capture' : 'autoriza y captura: flow single-step'}).
     * El cobro tiene que estar registrado ANTES de llamar: si esto lanza, se queda en duda.
     *
     * @throws PaymentGatewayUnavailableException si no se sabe qué hizo la pasarela
     */
    GatewayOutcome authorize(ChargeRequest request);`
  ];
  if (payments.capture) {
    methods.push(`    /**
     * Captura lo autorizado${payments.capture.amount ? '; con amount, solo esa parte (el resto se libera), en la moneda del cobro' : ''}.
     * El cobro tiene que estar ya en su estado en vuelo (${payments.capture.inFlight}).
     */
    GatewayOutcome capture(String reference, String gatewayPaymentId${payments.capture.amount ? ', BigDecimal amount, String currency' : ''});`);
  }
  if (payments.void) {
    methods.push(`    /** Anula la autorización. El cobro tiene que estar ya en ${payments.void.inFlight}. */
    GatewayOutcome voidAuthorization(String reference, String gatewayPaymentId);`);
  }
  if (payments.refund) {
    methods.push(`    /**
     * Devuelve lo cobrado${payments.refund.amount ? '; con amount null, todo. La moneda es la del cobro: la pasa quien llama,\n     * que la conoce, en vez de pedírsela a la pasarela con una llamada más' : ''}. El cobro tiene que estar ya en
     * ${payments.refund.inFlight}. Si la pasarela la rechaza, el resultado NO es REFUNDED.
     */
    GatewayOutcome refund(String reference, String gatewayPaymentId${payments.refund.amount ? ', BigDecimal amount, String currency' : ''});`);
  }
  methods.push(`    /**
     * El estado de un cobro según la pasarela. Con gatewayPaymentId null —la pasarela no llegó a
     * contestar— se busca por la referencia, que el adaptador le mandó al pedirlo.
     */
    GatewayOutcome status(String reference, String gatewayPaymentId);`);
  if (payments.savePaymentMethod) {
    methods.push(`    /**
     * Guarda un medio de pago para cobrarlo sin el cliente delante.
     *
     * @return la referencia opaca de la pasarela; no sale nunca del servicio
     */
    String savePaymentMethod(String token, String payerReference);`);
  }
  const body = `/**
 * La pasarela de pago, vista desde los casos de uso. No nombra ninguna: la implementación la eligió
 * build con el stack (keel-stack.json → paymentGateway) y se cambia regenerando, sin tocar el diseño.
 * Este archivo es idéntico con cualquier pasarela (test/payment-parity.test.js).
 */
public interface PaymentGateway {

${methods.join('\n\n')}
}`;
  const imports = [`${domain}.ChargeRequest`, `${domain}.GatewayOutcome`, `${domain}.PaymentGatewayUnavailableException`];
  if (payments.capture?.amount || payments.refund?.amount) imports.push('java.math.BigDecimal');
  return file(model, PORT_PKG, 'PaymentGateway', imports, body);
}

// ─── Aplicación: de un desenlace a la operación del diseño que lo aplica ─────

function argExpression(arg) {
  switch (arg.slot) {
    case 'reference':
      return 'outcome.reference()';
    case 'gatewayPaymentId':
      return 'outcome.gatewayPaymentId()';
    case 'failureReason':
      return 'outcome.failureReason()';
    case 'customerAction':
      return 'outcome.customerAction()';
    case 'refundedAmount':
      return 'outcome.refundedAmount()';
    default:
      return `null /* TODO(keel): '${arg.name}' no lo nombra la capa payments (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED): decídelo aquí */`;
  }
}

function renderOutcomeApplier(model) {
  const payments = model.payments;
  const base = model.service.basePackage;
  const imports = [
    `${base}.${DOMAIN_PKG}.GatewayOutcome`,
    `${base}.${PORT_PKG}.CommandDispatcher`,
    'org.springframework.stereotype.Component'
  ];
  const cases = payments.outcomeCommands.map((command) => {
    const pkg = command.messageKind === 'query' ? 'application.queries' : 'application.commands';
    imports.push(`${base}.${pkg}.${command.messageClass}`);
    const args = command.args.map(argExpression).join(',\n                    ');
    return `            case ${command.status} -> dispatcher.dispatch(new ${command.messageClass}(
                    ${args}));`;
  });
  const body = `/**
 * Aplica un desenlace de la pasarela con la operación del diseño que le corresponde
 * (payments.outcomes). Es el único sitio donde un {@link GatewayOutcome} se convierte en un cambio
 * del registro, venga de la respuesta síncrona, del aviso o del barrido.
 *
 * <p>Los handlers de esas operaciones tienen que ser <b>idempotentes</b>: el mismo desenlace puede
 * llegar por dos caminos, y uno tardío puede encontrar el cobro fuera del estado de origen. En los dos
 * casos no se hace nada y no es un error (docs/dsl/payments.md § Los desenlaces). Dos desenlaces
 * DISTINTOS a la vez los arbitra el bloqueo optimista.
 */
@Component
public class PaymentOutcomeApplier {

    private final CommandDispatcher dispatcher;

    public PaymentOutcomeApplier(CommandDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    /** PENDING y NOT_FOUND no son desenlaces: el llamante decide qué hacer con ellos. */
    public void apply(GatewayOutcome outcome) {
        switch (outcome.status()) {
${cases.join('\n')}
            default -> {
                // Sin desenlace que aplicar.
            }
        }
    }
}`;
  return file(model, APP_PKG, 'PaymentOutcomeApplier', imports, body);
}

function renderNotices(model) {
  const base = model.service.basePackage;
  const body = `/**
 * Lo que se hace con un aviso de la pasarela YA VERIFICADO: preguntarle el estado del cobro y aplicar
 * el desenlace. El contenido del aviso no se usa para nada más que para saber de qué cobro habla.
 */
@Component
public class PaymentNotices {

    private final PaymentGateway gateway;
    private final PaymentOutcomeApplier applier;

    public PaymentNotices(PaymentGateway gateway, PaymentOutcomeApplier applier) {
        this.gateway = gateway;
        this.applier = applier;
    }

    public void onNotice(String gatewayPaymentId) {
        GatewayOutcome outcome = gateway.status(null, gatewayPaymentId);
        if (outcome.status() == GatewayStatus.PENDING || outcome.status() == GatewayStatus.NOT_FOUND) {
            return;
        }
        applier.apply(outcome);
    }
}`;
  return file(
    model,
    APP_PKG,
    'PaymentNotices',
    [
      `${base}.${DOMAIN_PKG}.GatewayOutcome`,
      `${base}.${DOMAIN_PKG}.GatewayStatus`,
      `${base}.${PORT_PKG}.PaymentGateway`,
      'org.springframework.stereotype.Component'
    ],
    body
  );
}

function renderReconciliation(model) {
  const payments = model.payments;
  const base = model.service.basePackage;
  const notReceived = payments.failureReasons.find((entry) => entry.literal === 'notReceived').constant;
  const body = `/**
 * La consulta del barrido de reconciliación (${payments.reconciliation.sweep}) para UN cobro que espera
 * desenlace: le pregunta a la pasarela y aplica lo que diga.
 *
 * <p>Lo que no hace es elegir los candidatos ni reclamarlos: eso es del handler del barrido. Los
 * candidatos son los cobros en ${payments.awaitingStates.join(', ')} cuyo ${payments.record.awaitingSince} es
 * más antiguo que {@code payments.reconciliation.unanswered-after-seconds}; y el handler reclama cada uno
 * volviendo a estampar ${payments.record.awaitingSince} ANTES de llamar aquí, para que otra réplica no lo
 * consulte en la misma pasada.
 */
@Component
public class PaymentReconciliation {

    private final PaymentGateway gateway;
    private final PaymentOutcomeApplier applier;

    public PaymentReconciliation(PaymentGateway gateway, PaymentOutcomeApplier applier) {
        this.gateway = gateway;
        this.applier = applier;
    }

    /**
     * @return el estado que dio la pasarela. Con PENDING no se aplica nada: el cobro se queda para la
     *         siguiente pasada. Con el estado del que salió una acción de seguimiento (AUTHORIZED tras
     *         capturing o canceling, CAPTURED tras refunding), la acción no llegó a hacerse y el
     *         handler devuelve el cobro a ese estado.
     */
    public GatewayStatus consult(String reference, String gatewayPaymentId) {
        GatewayOutcome outcome = gateway.status(reference, gatewayPaymentId);
        if (outcome.status() == GatewayStatus.NOT_FOUND) {
            // La petición no llegó nunca a la pasarela: el cobro falló sin que nadie cobrara nada.
            applier.apply(GatewayOutcome.failed(reference, null, ${payments.record.failureReasonType}.${notReceived}));
            return GatewayStatus.NOT_FOUND;
        }
        if (outcome.status() != GatewayStatus.PENDING) {
            applier.apply(outcome);
        }
        return outcome.status();
    }
}`;
  return file(
    model,
    APP_PKG,
    'PaymentReconciliation',
    [
      `${base}.${DOMAIN_PKG}.GatewayOutcome`,
      `${base}.${DOMAIN_PKG}.GatewayStatus`,
      `${base}.${ENUMS_PKG}.${payments.record.failureReasonType}`,
      `${base}.${PORT_PKG}.PaymentGateway`,
      'org.springframework.stereotype.Component'
    ],
    body
  );
}

// ─── Infraestructura común ───────────────────────────────────────────────────

function renderProperties(model) {
  const body = `/**
 * La configuración de la pasarela. Los valores son dato de despliegue: en producción la credencial y
 * el secreto de firma vienen del entorno sin default (las variables están en
 * parameters/production/payments.yaml), y en local la URL apunta a la pasarela de prueba de infra/.
 *
 * @param baseUrl                 la URL de la API de la pasarela
 * @param apiKey                  la credencial con la que se le habla
 * @param webhookSecret           el secreto con el que firma sus avisos
 * @param connectTimeout          cuánto se espera para conectar
 * @param readTimeout             cuánto se espera la respuesta; superado, la acción queda EN DUDA
 * @param noticeToleranceSeconds  la antigüedad máxima de un aviso firmado (contra la repetición)
 */
@ConfigurationProperties(prefix = "payments.gateway")
public record PaymentGatewayProperties(String baseUrl, String apiKey, String webhookSecret, Duration connectTimeout,
        Duration readTimeout, long noticeToleranceSeconds) {
}`;
  return file(model, INFRA_PKG, 'PaymentGatewayProperties', ['java.time.Duration', 'org.springframework.boot.context.properties.ConfigurationProperties'], body);
}

function renderHttpConfig(model) {
  const body = `/**
 * El cliente HTTP de la pasarela. Sin reintentos a propósito: reintentar una escritura que la
 * pasarela pudo haber hecho es cobrar dos veces. Una respuesta que no llega deja la acción en duda,
 * y eso lo resuelve el barrido preguntando.
 */
@Configuration
@EnableConfigurationProperties(PaymentGatewayProperties.class)
public class PaymentGatewayHttpConfig {

    @Bean
    public RestClient paymentGatewayRestClient(PaymentGatewayProperties properties) {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        return RestClient.builder()
                .baseUrl(properties.baseUrl())
                .requestFactory(requestFactory)
                .build();
    }
}`;
  return file(
    model,
    INFRA_PKG,
    'PaymentGatewayHttpConfig',
    [
      'org.springframework.boot.context.properties.EnableConfigurationProperties',
      'org.springframework.context.annotation.Bean',
      'org.springframework.context.annotation.Configuration',
      'org.springframework.http.client.SimpleClientHttpRequestFactory',
      'org.springframework.web.client.RestClient'
    ],
    body
  );
}

function renderMoneyAmounts(model) {
  const body = `/**
 * La conversión entre el importe del diseño (decimal en unidades mayores) y el de la pasarela.
 * Nunca redondea: un importe con más decimales de los que admite la moneda es un error, no un
 * céntimo que se pierde.
 */
public final class MoneyAmounts {

    private MoneyAmounts() {
    }

    /** 12.50 EUR → 1250. */
    public static long toMinorUnits(BigDecimal amount, String currency) {
        int digits = Currency.getInstance(currency).getDefaultFractionDigits();
        try {
            return amount.setScale(digits, RoundingMode.UNNECESSARY).movePointRight(digits).longValueExact();
        } catch (ArithmeticException tooPrecise) {
            throw new IllegalArgumentException(
                    "El importe " + amount + " tiene más decimales de los que admite " + currency, tooPrecise);
        }
    }

    /** 1250 EUR → 12.50. */
    public static BigDecimal fromMinorUnits(long minor, String currency) {
        int digits = Currency.getInstance(currency).getDefaultFractionDigits();
        return BigDecimal.valueOf(minor, digits);
    }

    /** El importe como lo escribe una pasarela que trabaja en unidades mayores: "12.50". */
    public static String toMajorUnits(BigDecimal amount, String currency) {
        int digits = Currency.getInstance(currency).getDefaultFractionDigits();
        try {
            return amount.setScale(digits, RoundingMode.UNNECESSARY).toPlainString();
        } catch (ArithmeticException tooPrecise) {
            throw new IllegalArgumentException(
                    "El importe " + amount + " tiene más decimales de los que admite " + currency, tooPrecise);
        }
    }
}`;
  return file(model, INFRA_PKG, 'MoneyAmounts', ['java.math.BigDecimal', 'java.math.RoundingMode', 'java.util.Currency'], body);
}

function renderNoticeVerifierPort(model) {
  const body = `/**
 * Verifica un aviso de la pasarela y dice de qué cobro habla. Cada pasarela firma a su manera; la
 * implementación es la de la pasarela elegida.
 */
public interface PaymentNoticeVerifier {

    /**
     * @param body    el cuerpo CRUDO, tal como llegó: la firma se calcula sobre estos bytes, no sobre
     *                un JSON re-serializado
     * @param headers las cabeceras de la petición
     * @param query   los parámetros de la URL
     * @return el id de la pasarela del cobro del que habla el aviso, o vacío si es un aviso válido que
     *         no habla de ningún cobro
     * @throws InvalidPaymentNoticeException si la firma no verifica o el aviso es demasiado antiguo
     */
    Optional<String> verify(byte[] body, HttpHeaders headers, Map<String, String> query);
}`;
  return file(model, INFRA_PKG, 'PaymentNoticeVerifier', ['java.util.Map', 'java.util.Optional', 'org.springframework.http.HttpHeaders'], body);
}

function renderInvalidNotice(model) {
  const body = `/** Un aviso que no firma la pasarela, o que llega fuera de su ventana. */
public class InvalidPaymentNoticeException extends RuntimeException {

    public InvalidPaymentNoticeException(String message) {
        super(message);
    }
}`;
  return file(model, INFRA_PKG, 'InvalidPaymentNoticeException', [], body);
}

function renderNoticeController(model) {
  const base = model.service.basePackage;
  const body = `/**
 * El aviso de la pasarela. Entra sin credencial —quien llama es la pasarela, que no tiene identidad
 * aquí— y lo protege la FIRMA: se verifica sobre el cuerpo crudo antes de hacer nada. Un aviso que
 * no verifica se responde con 401 y no se consulta nada; uno que verifica tampoco decide nada: el
 * desenlace se le pregunta a la pasarela (PaymentNotices).
 */
@RestController
@RequestMapping("${PAYMENT_NOTICE_PATH}")
public class PaymentNoticeController {

    private static final Logger log = LoggerFactory.getLogger(PaymentNoticeController.class);

    private final PaymentNoticeVerifier verifier;
    private final PaymentNotices notices;

    public PaymentNoticeController(PaymentNoticeVerifier verifier, PaymentNotices notices) {
        this.verifier = verifier;
        this.notices = notices;
    }

    @PostMapping
    public ResponseEntity<Void> receive(@RequestBody(required = false) byte[] body, @RequestHeader HttpHeaders headers,
            @RequestParam Map<String, String> query) {
        Optional<String> gatewayPaymentId;
        try {
            gatewayPaymentId = verifier.verify(body == null ? new byte[0] : body, headers, query);
        } catch (InvalidPaymentNoticeException invalid) {
            log.warn("Aviso de la pasarela rechazado: {}", invalid.getMessage());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        gatewayPaymentId.ifPresent(notices::onNotice);
        return ResponseEntity.ok().build();
    }
}`;
  return file(
    model,
    INFRA_PKG,
    'PaymentNoticeController',
    [
      `${base}.${APP_PKG}.PaymentNotices`,
      'java.util.Map',
      'java.util.Optional',
      'org.slf4j.Logger',
      'org.slf4j.LoggerFactory',
      'org.springframework.http.HttpHeaders',
      'org.springframework.http.HttpStatus',
      'org.springframework.http.ResponseEntity',
      'org.springframework.web.bind.annotation.PostMapping',
      'org.springframework.web.bind.annotation.RequestBody',
      'org.springframework.web.bind.annotation.RequestHeader',
      'org.springframework.web.bind.annotation.RequestMapping',
      'org.springframework.web.bind.annotation.RequestParam',
      'org.springframework.web.bind.annotation.RestController'
    ],
    body
  );
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function file(model, subpackage, className, imports, body) {
  return { path: javaPath(model, subpackage, className), content: javaFile(subPackage(model, subpackage), imports, body) };
}

/** El nombre de la clase del adaptador de la pasarela elegida (lo usan readme, skills y tests). */
export function adapterClass(model) {
  return `${pascalCase(model.payments.gateway.id)}PaymentGateway`;
}
