// Lo que cada pasarela de pago del catálogo exige al ADAPTADOR, como datos: la matriz de paridad
// (qué capacidad del diseño cubre cada una), la traducción de sus rechazos al vocabulario neutro,
// las claves con que viaja la referencia del cobro, la clave de idempotencia de cada acción, la
// ruta del aviso y las unidades menores de cada moneda.
//
// NEUTRAL (keel-core/gen): son contrato con la PASARELA, no con un lenguaje. Dos generadores del
// mismo diseño tienen que mandar la misma clave de idempotencia (o un reintento por el otro
// servidor cobra dos veces), leer el mismo rechazo como el mismo motivo y convertir 12.50 IQD a la
// misma unidad menor. Escrita dos veces, cualquiera de esas decisiones diverge al primer matiz.
//
// Lo que NO está aquí: cómo se habla HTTP con cada pasarela en un lenguaje (eso es del adaptador de
// cada generador) ni cómo se IMITA en la infraestructura de prueba (payment-probes.js).

// ─── La matriz de paridad ────────────────────────────────────────────────────
//
// Por qué existe. La promesa de la capa es UN diseño que genera el mismo servidor con cualquier
// pasarela del menú. Esa promesa solo es honesta si una pasarela que no puede cumplir algo que el
// diseño exige NO genera: lo contrario —generar y que el adaptador lo cumpla a medias— es un
// servidor que acepta una devolución parcial y devuelve el importe entero, en silencio. Es la
// misma razón que `engine-support.js` para los motores de base de datos, en el eje de la pasarela.
//
// Tres estados por celda, y el tercero es el importante:
//
//   - `supported`: la pasarela lo hace y el contrato está contrastado con su documentación.
//   - `unsupported`: no lo hace, o no hay forma verificada de hacerlo. build se NIEGA.
//   - `unverified`: la documentación dice que sí pero hay una parte del contrato que no aclara
//     (qué responde exactamente, en qué países). build genera y AVISA, y el aviso nombra lo que
//     falta. Se convierte en `supported` cuando una red lo ejecuta contra la pasarela real
//     (la verificación en el sandbox de la skill de la pasarela), nunca porque alguien lo dé por bueno leyendo.
//
// La fuente de cada `why` es docs/pasarelas/fase0-contratos-stripe-mercadopago.md. La matriz es la
// misma para todos los generadores: lo que una pasarela cubre no depende del lenguaje del servidor.

export const GATEWAY_STATES = ['supported', 'unverified', 'unsupported'];

/** Lo que el diseño puede exigir: el flujo y las capacidades de la capa payments. */
export const GATEWAY_REQUIREMENTS = {
  'flow:authorize-capture': {
    stripe: { state: 'supported', why: 'PaymentIntent con capture_method=manual; captura con /capture.' },
    mercadopago: {
      state: 'supported',
      why: 'Orders con capture_mode manual, solo con tarjeta de crédito: la capa payments es solo tarjeta.'
    }
  },
  'flow:single-step': {
    stripe: { state: 'supported', why: 'PaymentIntent con captura automática.' },
    mercadopago: { state: 'supported', why: 'Orders con captura automática (el default).' }
  },
  'partial-capture': {
    stripe: { state: 'supported', why: 'amount_to_capture; el resto se libera solo.' },
    mercadopago: {
      state: 'unsupported',
      why:
        'La API clásica de pagos admite transaction_amount en la captura, pero la de Orders —la única con ' +
        'cobro sin el cliente— no documenta la captura parcial. Hasta verificarla en el sandbox, un diseño ' +
        'que la exija no se genera con MercadoPago.'
    }
  },
  'partial-refund': {
    stripe: { state: 'supported', why: 'Refund con amount.' },
    mercadopago: { state: 'supported', why: 'Reembolso de la order con importe e id de transacción.' }
  },
  'customer-action': {
    stripe: { state: 'supported', why: 'Estado requires_action con next_action; la acción la consume Stripe.js.' },
    mercadopago: {
      state: 'unverified',
      why:
        'Orders admite 3DS, pero la documentación consultada no fija la forma exacta de la acción que devuelve: ' +
        'el adaptador la guarda opaca, y la verificación en el sandbox (la skill de MercadoPago del generador) tiene que confirmar de dónde sale.'
    }
  },
  'off-session': {
    stripe: {
      state: 'supported',
      why: 'customer + payment_method + off_session=true; si el emisor exige autenticación, decline_code authentication_required.'
    },
    mercadopago: {
      state: 'unverified',
      why:
        'Pagos automáticos de Orders (payment_profile_id, sin CVV ni token nuevo). Sin documentar: qué responde ' +
        'cuando el emisor exige autenticación a un cobro sin cliente, y en qué países está disponible.'
    }
  }
};

/** Lo que exige este diseño, como claves de la matriz. */
export function gatewayRequirements(payments) {
  if (!payments) return [];
  return [`flow:${payments.flow}`, ...(payments.capabilities ?? [])].filter((key) => GATEWAY_REQUIREMENTS[key]);
}

/**
 * El veredicto de una pasarela sobre un diseño: `errors` (lo que no cubre: no se genera) y
 * `warnings` (lo que cubre sin verificar contra la pasarela real), ya redactados para consola.
 */
export function checkGatewaySupport(layers, gatewayId) {
  const errors = [];
  const warnings = [];
  for (const key of gatewayRequirements(layers?.payments)) {
    const cell = GATEWAY_REQUIREMENTS[key][gatewayId];
    if (!cell || cell.state === 'unsupported') {
      errors.push(`payments: ${key}: la pasarela '${gatewayId}' no lo cubre — ${cell?.why ?? 'sin celda en la matriz'}`);
    } else if (cell.state === 'unverified') {
      warnings.push(`payments: ${key}: la pasarela '${gatewayId}' lo cubre SIN verificar contra la real — ${cell.why}`);
    }
  }
  return { errors, warnings };
}

/** Qué pasarelas del catálogo pueden servir este diseño: la portabilidad del diseño, de un vistazo. */
export function gatewayCoverage(layers, gatewayIds) {
  return gatewayIds.map((id) => ({ id, ...checkGatewaySupport(layers, id) }));
}

// ─── El aviso ────────────────────────────────────────────────────────────────

/**
 * La ruta del aviso de la pasarela. Fuera de la API versionada: no es contrato con ningún cliente,
 * pero sí con la pasarela (es la URL que se registra en su panel) y con la seguridad de los dos
 * servidores, que la dejan pasar sin credencial porque la protege la firma.
 */
export const PAYMENT_NOTICE_PATH = '/webhooks/payments';

/**
 * La credencial y el secreto de firma de la pasarela de PRUEBA (perfiles local y test): el arnés firma
 * con este secreto los avisos de los escenarios, y el doble de infra/ acepta esta credencial. Son los
 * mismos para los dos generadores, así que un mismo .env sirve para el servidor de cualquiera.
 */
export const PAYMENT_TEST_SECRETS = Object.freeze({ apiKey: 'keel-test-api-key', webhookSecret: 'keel-test-webhook-secret' });

// ─── Las claves que viajan a la pasarela ─────────────────────────────────────

/**
 * La clave de idempotencia de una acción sobre un cobro: `<referencia>:<acción>`. Sale de la
 * referencia de NEGOCIO, nunca de un aleatorio, para que un reintento —por cualquiera de las dos
 * puertas, y por cualquiera de los dos servidores— repita la clave.
 */
export function paymentIdempotencyKey(reference, action) {
  return `${reference}:${action}`;
}

/** Las acciones con clave propia. Son las del puerto `PaymentGateway`. */
export const PAYMENT_ACTIONS = ['authorize', 'capture', 'void', 'refund'];

/** La clave de cada paso de guardar un medio de pago: `save:<token>:<paso>`. */
export function savedMethodIdempotencyKey(token, step) {
  return `save:${token}:${step}`;
}

/**
 * La referencia opaca de un medio guardado junta dos ids de la pasarela (`<cliente>|<medio>`): es lo
 * que devuelve `savePaymentMethod` y lo que un cobro sin el cliente delante parte en dos. Si un
 * servidor la escribiera con otro separador, un medio guardado por uno no lo podría cobrar el otro.
 */
export const SAVED_METHOD_SEPARATOR = '|';

// ─── Lo propio de cada pasarela ──────────────────────────────────────────────
//
// `declines`: el código de rechazo de la pasarela → el motivo NEUTRO (FAILURE_REASONS de
// payment-vocabulary.js). En orden; lo que no está aquí es `declined`.

export const GATEWAY_TRANSLATIONS = {
  stripe: {
    // La clave de metadata con la que viaja la referencia del cobro; es lo que permite buscarlo.
    referenceKey: 'keel_reference',
    // La de metadata con la que se guarda el pagador de un medio guardado.
    payerKey: 'keel_payer',
    // Los pasos de guardar un medio: el cliente y adjuntarle el medio.
    savedMethodSteps: ['customer', 'attach'],
    // Un 4xx a la captura con este código es una autorización caducada: el cobro está anulado y no
    // hace falta preguntarle a la pasarela.
    expiredCaptureMarker: 'charge_expired_for_capture',
    // decline_code (o code si no hay) → motivo neutro.
    declines: [
      ['insufficient_funds', 'insufficientFunds'],
      ['expired_card', 'expiredCard'],
      ['fraudulent', 'fraudSuspected'],
      ['stolen_card', 'fraudSuspected'],
      ['lost_card', 'fraudSuspected'],
      ['pickup_card', 'fraudSuspected'],
      ['merchant_blacklist', 'fraudSuspected'],
      ['authentication_required', 'authenticationFailed'],
      ['incorrect_cvc', 'invalidPaymentMethod'],
      ['incorrect_number', 'invalidPaymentMethod'],
      ['invalid_cvc', 'invalidPaymentMethod'],
      ['invalid_expiry_month', 'invalidPaymentMethod'],
      ['invalid_expiry_year', 'invalidPaymentMethod'],
      ['invalid_number', 'invalidPaymentMethod'],
      ['card_not_supported', 'invalidPaymentMethod'],
      ['resource_missing', 'invalidPaymentMethod'],
      ['processing_error', 'processingError'],
      ['try_again_later', 'processingError'],
      ['issuer_not_available', 'processingError']
    ],
    notice: {
      // Stripe-Signature: t=<segundos>,v1=<firma>[,v1=<firma>]. Solo cuenta v1 (contra el downgrade).
      timestampField: 't',
      signatureField: 'v1'
    }
  },
  mercadopago: {
    referenceKey: 'external_reference',
    savedMethodSteps: ['customer', 'card'],
    expiredCaptureMarker: null,
    // status_detail de un pago → motivo neutro.
    declines: [
      ['cc_rejected_insufficient_amount', 'insufficientFunds'],
      ['insufficient_amount', 'insufficientFunds'],
      ['cc_rejected_bad_filled_date', 'expiredCard'],
      ['expired_card', 'expiredCard'],
      ['cc_rejected_high_risk', 'fraudSuspected'],
      ['cc_rejected_blacklist', 'fraudSuspected'],
      ['high_risk', 'fraudSuspected'],
      ['cc_rejected_3ds_challenge', 'authenticationFailed'],
      ['cc_rejected_3ds_mandatory', 'authenticationFailed'],
      ['cc_rejected_bad_filled_security_code', 'invalidPaymentMethod'],
      ['cc_rejected_bad_filled_card_number', 'invalidPaymentMethod'],
      ['cc_rejected_bad_filled_other', 'invalidPaymentMethod'],
      ['cc_rejected_card_disabled', 'invalidPaymentMethod'],
      ['invalid_card_token', 'invalidPaymentMethod'],
      ['cc_rejected_card_error', 'processingError'],
      ['processing_error', 'processingError']
    ],
    notice: {
      // x-signature: ts=<segundos o milisegundos>,v1=<firma>. La firma es del manifiesto
      // `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, NO del cuerpo.
      timestampField: 'ts',
      signatureField: 'v1',
      requestIdHeader: 'x-request-id',
      dataIdQuery: 'data.id',
      // Un ts por encima de esto viene en milisegundos y se normaliza a segundos antes de comparar.
      millisecondsAbove: 100_000_000_000
    }
  }
};

export function gatewayTranslation(gatewayId) {
  const translation = GATEWAY_TRANSLATIONS[gatewayId];
  if (!translation) throw new Error(`payment-gateways: la pasarela '${gatewayId}' no tiene traducción`);
  return translation;
}

// ─── Las unidades menores de cada moneda ─────────────────────────────────────
//
// Cuántos decimales tiene la unidad menor de cada moneda ISO 4217: 12.50 EUR son 1250 céntimos y
// 12.500 IQD son 12500 fils. Es la tabla de `java.util.Currency` (JDK 21), y keel-spring la usa a
// través del JDK; payment-check comprueba en cada pasada que el JDK sigue diciendo lo mismo que esta
// tabla. Un generador que no corre sobre el JDK la emite TAL CUAL en vez de preguntarle a su
// plataforma: `Intl` de JavaScript (CLDR) discrepa en 25 monedas, IQD entre ellas (0 decimales en
// vez de 3), y con él un cobro de 12.500 IQD saldría como 13 en la unidad de la pasarela.
//
// Una moneda que no está aquí no se cobra: el adaptador lo rechaza, como el JDK.

const MINOR_UNIT_EXCEPTIONS = {
  0: 'ADP BEF BIF BYB BYR CLP DJF ESP GNF GRD ISK ITL JPY KMF KRW LUF MGF PTE PYG ROL RWF TPE TRL UGX UYI VND VUV XAF XOF XPF',
  3: 'BHD IQD JOD KWD LYD OMR TND',
  4: 'CLF'
};

const TWO_DIGIT_CURRENCIES =
  'AED AFA AFN ALL AMD ANG AOA ARS ATS AUD AWG AYM AZM AZN BAM BBD BDT BGL BGN BMD BND BOB BOV BRL BSD BTN BWP ' +
  'BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CSD CUC CUP CVE CYP CZK DEM DKK DOP DZD EEK EGP ERN ETB EUR FIM FJD ' +
  'FKP FRF GBP GEL GHC GHS GIP GMD GTQ GWP GYD HKD HNL HRK HTG HUF IDR IEP ILS INR IRR JMD KES KGS KHR KPW KYD KZT ' +
  'LAK LBP LKR LRD LSL LTL LVL MAD MDL MGA MKD MMK MNT MOP MRO MRU MTL MUR MVR MWK MXN MXV MYR MZM MZN NAD NGN NIO ' +
  'NLG NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB RUR SAR SBD SCR SDD SDG SEK SGD SHP SIT SKK SLE SLL SOS ' +
  'SRD SRG SSP STD STN SVC SYP SZL THB TJS TMM TMT TOP TRY TTD TWD TZS UAH USD USN USS UYU UZS VEB VED VEF VES WST ' +
  'XAD XCD XCG YER YUM ZAR ZMK ZMW ZWD ZWG ZWL ZWN ZWR';

/** Código ISO 4217 → decimales de su unidad menor. Ordenado por código. */
export const CURRENCY_MINOR_UNITS = Object.freeze(
  Object.fromEntries(
    [
      ...TWO_DIGIT_CURRENCIES.split(' ').map((code) => [code, 2]),
      ...Object.entries(MINOR_UNIT_EXCEPTIONS).flatMap(([digits, codes]) => codes.split(' ').map((code) => [code, Number(digits)]))
    ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
);
