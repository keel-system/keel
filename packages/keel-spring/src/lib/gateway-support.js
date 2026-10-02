// La matriz de paridad de las pasarelas de pago: qué exige el diseño (capa payments) y qué cubre
// cada pasarela del catálogo.
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
// La fuente de cada `why` es docs/pasarelas/fase0-contratos-stripe-mercadopago.md.

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
        'el adaptador la guarda opaca, y la verificación en el sandbox (skill keel-spring-mercadopago) tiene que confirmar de dónde sale.'
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
