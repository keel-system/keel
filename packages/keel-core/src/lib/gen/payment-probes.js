// Cómo se imita cada pasarela de pago en la infraestructura de prueba: qué rutas tiene, qué devuelve
// para cada estado neutro y cómo firma sus avisos. Fuente ÚNICA, como broker-probes.js para los
// brokers: el arnés (payments-harness.js) y payment-check la leen de aquí, nunca escriben un literal.
//
// Tiene que decir lo mismo que el adaptador generado (payment-gateways/*.js): si el doble devuelve
// una forma que el adaptador no lee, los escenarios miden el doble y no el servidor. Por eso cada
// forma de aquí cita el campo del adaptador que la consume.
//
// NEUTRAL (keel-core/gen): la consumen todos los generadores, porque es contrato con la
// imagen o con la pasarela, no con un lenguaje. Los comentarios cuentan cómo la usa keel-spring,
// que es la implementación de referencia; un arnés de otro lenguaje la renderiza igual.

import { gatewayTranslation } from './payment-gateways.js';

export const PAYMENT_PROBES = {
  stripe: {
    // pi_<referencia sin símbolos>: determinista, para que el escenario sepa el id antes de pedir.
    idPrefix: 'pi_',
    calls: {
      CHARGE: { method: 'POST', path: '/v1/payment_intents' },
      CAPTURE: { method: 'POST', path: '/v1/payment_intents/[^/]+/capture' },
      CANCEL: { method: 'POST', path: '/v1/payment_intents/[^/]+/cancel' },
      REFUND: { method: 'POST', path: '/v1/refunds' },
      STATUS: { method: 'GET', path: '/v1/payment_intents/[^/]+' },
      SEARCH: { method: 'GET', path: '/v1/payment_intents/search', query: 'query' },
      SAVE_METHOD: { method: 'POST', path: '/v1/customers' },
      ATTACH_METHOD: { method: 'POST', path: '/v1/payment_methods/[^/]+/attach' }
    },
    // El estado neutro → status del PaymentIntent (StripePaymentGateway.outcomeOf).
    statuses: {
      PENDING: 'processing',
      ACTION_REQUIRED: 'requires_action',
      AUTHORIZED: 'requires_capture',
      CAPTURED: 'succeeded',
      CANCELED: 'canceled',
      FAILED: 'requires_payment_method',
      REFUNDED: 'succeeded'
    },
    // El motivo neutro → decline_code (StripePaymentGateway.reasonOf).
    declines: {
      declined: 'generic_decline',
      insufficientFunds: 'insufficient_funds',
      expiredCard: 'expired_card',
      fraudSuspected: 'fraudulent',
      authenticationFailed: 'authentication_required',
      invalidPaymentMethod: 'incorrect_number',
      notReceived: 'generic_decline',
      processingError: 'processing_error'
    },
    notice: {
      signatureHeader: 'Stripe-Signature',
      // HMAC-SHA256 de `${t}.${cuerpo}` (StripeNoticeVerifier).
      scheme: 'stripe-v1'
    }
  },
  mercadopago: {
    idPrefix: 'ORD',
    calls: {
      CHARGE: { method: 'POST', path: '/v1/orders' },
      CAPTURE: { method: 'POST', path: '/v1/orders/[^/]+/capture' },
      CANCEL: { method: 'POST', path: '/v1/orders/[^/]+/cancel' },
      REFUND: { method: 'POST', path: '/v1/orders/[^/]+/refund' },
      STATUS: { method: 'GET', path: '/v1/orders/(?!search)[^/]+' },
      SEARCH: { method: 'GET', path: '/v1/orders/search', query: 'external_reference' },
      SAVE_METHOD: { method: 'POST', path: '/v1/customers' },
      ATTACH_METHOD: { method: 'POST', path: '/v1/customers/[^/]+/cards' }
    },
    // El estado neutro → [status, status_detail] de la order (MercadopagoPaymentGateway.outcomeOf).
    statuses: {
      PENDING: ['processing', 'in_process'],
      ACTION_REQUIRED: ['action_required', 'pending_challenge'],
      AUTHORIZED: ['processed', 'waiting_capture'],
      CAPTURED: ['processed', 'accredited'],
      CANCELED: ['canceled', 'canceled'],
      FAILED: ['failed', 'rejected'],
      REFUNDED: ['refunded', 'refunded']
    },
    // El motivo neutro → status_detail (MercadopagoPaymentGateway.reasonOf).
    declines: {
      declined: 'cc_rejected_other_reason',
      insufficientFunds: 'cc_rejected_insufficient_amount',
      expiredCard: 'cc_rejected_bad_filled_date',
      fraudSuspected: 'cc_rejected_high_risk',
      authenticationFailed: 'cc_rejected_3ds_challenge',
      invalidPaymentMethod: 'cc_rejected_bad_filled_card_number',
      notReceived: 'cc_rejected_other_reason',
      processingError: 'cc_rejected_card_error'
    },
    notice: {
      signatureHeader: 'x-signature',
      // HMAC-SHA256 del manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (MercadopagoNoticeVerifier).
      scheme: 'mercadopago-manifest'
    }
  }
};

export function paymentProbesFor(gatewayId) {
  const probes = PAYMENT_PROBES[gatewayId];
  if (!probes) throw new Error(`payment-probes: la pasarela '${gatewayId}' no tiene doble de prueba`);
  return probes;
}

// ─── Guardar un medio de pago (DSL 2.33: el resumen de la tarjeta y el 3DS) ──────────────────────────────────────

/** La tarjeta con la que el doble guarda un medio si el escenario no pide otra. */
export const DEFAULT_SAVED_CARD = Object.freeze({ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });

/**
 * La respuesta del último paso de guardar (el attach de Stripe, la tarjeta del cliente de MercadoPago), con el resumen
 * en las rutas que lee el adaptador (`savedCard` de payment-gateways.js). Un doble con el resumen en otra ruta haría que
 * el escenario midiera el doble y no el servidor.
 */
export function savedCardResponse(gatewayId, card = DEFAULT_SAVED_CARD, id = 'card_keel_test') {
  const paths = gatewayTranslation(gatewayId).savedCard;
  const body = { id };
  for (const [field, route] of Object.entries(paths)) {
    if (card[field] === undefined) continue;
    const keys = route.split('.');
    let node = body;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    node[keys.at(-1)] = card[field];
  }
  return body;
}

/**
 * El 4xx con el que la pasarela dice que guardar la tarjeta exige autenticar (3DS), o null si esa pasarela no lo pide
 * al guardar (MercadoPago: la autenticación es del cobro).
 */
export function saveAuthenticationRejection(gatewayId) {
  const [code] = gatewayTranslation(gatewayId).saveAuthenticationCodes;
  return code ? { status: 402, body: { error: { type: 'card_error', code, decline_code: code } } } : null;
}
