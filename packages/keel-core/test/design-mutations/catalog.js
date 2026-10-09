// El corpus de mutaciones de la puerta de diseño (R6 de recomendaciones-diseno.md).
//
// Cada mutación le hace al diseño BASE (./base) un cambio mínimo y afirma el conjunto EXACTO de
// ids que dispara, con repeticiones: ni uno de más, ni uno de menos, y ningún hallazgo anónimo
// que no declare con su motivo. Es la misma disciplina que keel-spring aplica a sus mecanismos
// —romper conservando la forma y mirar qué se pone rojo—, trasladada al diseño: hasta aquí nada
// medía si una regla de crossrefs.js detecta lo que dice detectar, ni si detecta la de al lado.
//
// Tres piezas:
//
//   - EXTENSIONS: añadidos LIMPIOS al base que algunas reglas necesitan para tener sujeto (una
//     activación reconciliada, su compensación). No viven en el base porque traen consigo
//     escenarios y capas que el resto de mutaciones no necesita; y como son limpios, el test
//     exige que el base extendido siga en silencio. Una mutación que parte de una extensión
//     mide su cambio, no el de la extensión.
//   - MUTATIONS: `{ id, title, extends?, mutate(d), expect, anonymous? }`. `mutate` recibe una
//     copia de `{ manifest, layers, scenarios }` y la cambia en sitio. `expect` es la lista de
//     ids (CHK-* y OBL-*). `anonymous` solo si el cambio dispara además una cadena sin id que
//     no se puede evitar: `{ errors, warnings, why }`, con cuántas y por qué.
//   - SIN_MUTACION: los ids del catálogo que este corpus no puede ver, con el motivo. No es un
//     olvido: es una declaración de alcance, y el test exige que todo id esté o aquí o falsado.
//
// Las ediciones del documento de escenarios van por `replaceIn`, que LANZA si el texto a
// sustituir ya no está: una mutación cuyo cambio dejó de aplicarse no puede pasar por buena.

import { FAILURE_REASONS } from '../../src/lib/payment-vocabulary.js';

// ─── Ayudas ─────────────────────────────────────────────────────────────────────────

const ops = (d) => d.layers['use-cases'].operations;
const entity = (d, name) => d.layers.domain.entities[name];

function replaceIn(d, from, to) {
  if (!d.scenarios.includes(from)) {
    throw new Error(`validation-scenarios.md del base ya no contiene «${from}»: la mutación no se aplica`);
  }
  d.scenarios = d.scenarios.replace(from, to);
}

/** Inserta un bloque de escenario justo antes del encabezado `anchor` (p. ej. '### FL-TCK-002'). */
function insertScenarioBefore(d, anchor, block) {
  replaceIn(d, anchor, `${block.trim()}\n\n${anchor}`);
}

function addMatrixRow(d, row) {
  replaceIn(d, '| noteEscalation |', `${row}\n| noteEscalation |`);
}

const TICKET_NOT_FOUND = { code: 'TICKET_NOT_FOUND', when: 'No existe un ticket con ese id.', http: 404 };

// ─── Extensiones limpias ────────────────────────────────────────────────────────────

/**
 * Una activación con reconciliación: `escalateTicket` avisa a la guardia (`pager.page`) y deja
 * el ticket en `awaitingAck`; si nadie contesta, el barrido `sweepPages` lo devuelve a `open`.
 * Es la silueta que necesitan las reglas de la marca de espera y de la compensación.
 */
function withEscalation(d) {
  const domain = d.layers.domain;
  domain.types.TicketStatus.values = ['open', 'awaitingAck', 'closed'];
  const ticket = entity(d, 'Ticket');
  ticket.fields.pageAwaitingSince = {
    type: 'timestamp',
    description: 'Cuándo se avisó a la guardia; la estampa escalateTicket y la mira el barrido.'
  };
  ticket.lifecycle.transitions = { open: ['awaitingAck', 'closed'], awaitingAck: ['open'], closed: [] };

  ops(d).escalateTicket = {
    description: 'Avisa a la guardia de un ticket urgente.',
    kind: 'command',
    input: { fields: { id: { type: 'uuid', required: true } } },
    output: { entity: 'Ticket' },
    errors: [TICKET_NOT_FOUND],
    transitions: [{ entity: 'Ticket', from: ['open'], to: 'awaitingAck' }]
  };
  ops(d).sweepPages = {
    description: 'Devuelve a la cola los tickets cuya guardia no contestó.',
    kind: 'command',
    input: 'void',
    output: 'void',
    schedule: { cron: '*/5 * * * *' },
    transitions: [{ entity: 'Ticket', from: ['awaitingAck'], to: 'open' }]
  };
  d.layers.api.endpoints.escalateTicket = { method: 'POST', path: '/tickets/{id}/escalate', successStatus: 200 };

  d.layers['http-clients'].clients.pager = {
    purpose: 'Avisar a la guardia de un ticket urgente.',
    calls: {
      page: {
        contract: 'POST /pages crea el aviso a la guardia.',
        method: 'POST',
        path: '/pages',
        request: { body: { ticketId: { type: 'uuid', required: true } } },
        timeoutMs: 2000
      }
    }
  };
  d.layers.dependencies.dependencies.pager = {
    description: 'Servicio de guardias, dueño de los avisos.',
    contract: { version: '1.0.0' },
    activations: {
      pageOncall: {
        description: 'Aviso a la guardia.',
        triggeredBy: ['escalateTicket'],
        via: { client: 'pager', call: 'page' },
        effect: 'La guardia recibe el aviso del ticket.',
        awaits: 'acknowledgement',
        onFailure: { action: 'ignore' },
        reconciledBy: 'sweepPages',
        unansweredAfterSeconds: 600,
        awaitingSince: 'pageAwaitingSince'
      }
    }
  };

  addMatrixRow(d, '| escalateTicket | FL-PAG-001 | usuarios |\n| sweepPages | FL-PAG-002 | programada |');
  insertScenarioBefore(
    d,
    '### FL-ESC-001',
    `### FL-PAG-001: aviso a la guardia

**Given** un ticket en \`open\`.
**When** se llama a \`escalateTicket\`.
**Then** queda en \`awaitingAck\` y la consulta devuelve la marca del aviso.

### FL-PAG-002: la guardia no contesta

**Given** un ticket esperando más de diez minutos sin respuesta de la guardia, con dos réplicas vivas.
**When** corre \`sweepPages\`.
**Then** el ticket vuelve a \`open\`, una sola vez aunque corran las dos réplicas.`
  );
}

/**
 * La compensación de la activación anterior: si la guardia rechaza el aviso (`PageRejected`),
 * `abandonEscalation` devuelve el ticket a `open`. Parte de `withEscalation`.
 */
function withCompensation(d) {
  d.layers.messaging.subscriptions.PageRejected = {
    description: 'La guardia rechaza el aviso de un ticket.',
    source: 'pager',
    channel: 'ticketEvents',
    payload: { ticketId: { type: 'uuid', required: true } },
    contract: { envelope: 'keel' },
    triggers: 'abandonEscalation',
    input: { ticketId: 'ticketId' },
    onFailure: {
      retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 500, maxDelayMs: 5000 },
      deadLetter: true
    }
  };
  ops(d).abandonEscalation = {
    description: 'Devuelve el ticket a la cola cuando la guardia rechaza el aviso.',
    kind: 'command',
    internal: true,
    input: { fields: { ticketId: { type: 'uuid', required: true } } },
    output: 'void',
    errors: [TICKET_NOT_FOUND],
    transitions: [{ entity: 'Ticket', from: ['awaitingAck'], to: 'open' }]
  };
  d.layers.dependencies.dependencies.pager.compensations = [
    { onEvent: 'PageRejected', undoes: 'pageOncall', description: 'La guardia rechazó el aviso; el ticket vuelve a la cola.' }
  ];

  addMatrixRow(d, '| abandonEscalation | FL-PAG-003, FL-PAG-003-B | suscripción (interna) |');
  insertScenarioBefore(
    d,
    '### FL-ESC-001',
    `### FL-PAG-003: la guardia rechaza el aviso

**Given** un ticket en \`awaitingAck\`.
**When** llega \`PageRejected\`.
**Then** el ticket vuelve a \`open\`.

#### FL-PAG-003-B: rechazo reentregado y simultáneo

**Given** el mismo \`PageRejected\` del flujo anterior.
**When** se reentrega el mismo mensaje y, en otra prueba, se entrega dos veces a la vez.
**Then** no hay segundo efecto.`
  );
}

/**
 * Clientes máquina: el bot de guardia consulta tickets con su credencial. `getTicket` pasa a
 * `audience: both` con una regla que exige el scope que el bot tiene, y la identidad del
 * llamante está decidida (`callerIdentity`), que es lo que calla `OBL-CALLER-IDENTITY`.
 */
function withM2m(d) {
  const security = d.layers.security;
  security.authentication.serviceAuth = {
    protocol: 'client-credentials',
    description: 'El bot de guardia consulta tickets por API.'
  };
  security.authentication.callerIdentity = { field: 'requestedBy', from: { source: 'serviceClient' } };
  security.serviceClients = {
    'oncall-bot': { description: 'Bot de guardia que consulta tickets.', scopes: ['ticket:read'] }
  };
  security.access.rules = { getTicket: { level: 'required', roles: ['agent'], scopes: ['ticket:read'] } };
  ops(d).getTicket.input.fields.requestedBy = { type: 'string' };
  d.layers.api.endpoints.getTicket.audience = 'both';
}

/**
 * Entrega garantizada: `publishing.reliability: outbox`, con los dos escenarios que la
 * distinguen de best-effort —el canal caído y el relay que se rinde—.
 */
function withOutbox(d) {
  d.layers.messaging.publishing.reliability = 'outbox';
  insertScenarioBefore(
    d,
    '### FL-ESC-001',
    `### FL-OBX-001: el canal cae durante un cierre

**Given** un ticket en \`open\` y el broker detenido.
**When** se llama a \`closeTicket\`.
**Then** responde 200 igual; al restablecerlo, \`TicketClosed\` llega una sola vez.

#### FL-OBX-001-B: el relay se rinde

**Given** un \`TicketClosed\` cuyos reintentos del relay están agotados.
**When** pasa el siguiente ciclo del relay.
**Then** el servidor informa del evento abandonado y \`TicketClosed\` no se publica.`
  );
  // Ojo con la redacción del segundo: «con el canal caído hasta que se agotan los reintentos»
  // es la forma natural de escribirlo, y casa con la señal del canal INDISPONIBLE — así que ese
  // escenario, por sí solo, callaría CHK-SCEN-OUTBOX-UNAVAILABLE sin afirmar lo que ese aviso
  // pide (que la mutación responde igual y el evento llega una vez). Lo destapó este corpus.
}

/**
 * Una copia local del dato ajeno: el perfil del solicitante replicado desde el directorio y
 * alimentado por `RequesterUpdated`, con su entidad persistida y su escenario de reentrega.
 */
function withReplica(d) {
  d.layers.domain.entities.Requester = {
    description: 'Copia local del perfil de un solicitante.',
    fields: {
      id: { type: 'uuid', id: true, generated: true },
      email: { type: 'string', required: true, unique: true },
      displayName: { type: 'string', required: true }
    }
  };
  d.layers.domain.aggregates.Requester = { root: 'Requester' };
  d.layers.persistence.entities.Requester = { indexes: [['displayName']] };
  ops(d).syncRequester = {
    description: 'Actualiza la copia local del perfil de un solicitante.',
    kind: 'command',
    internal: true,
    input: { entity: 'Requester' },
    output: 'void'
  };
  d.layers.messaging.subscriptions.RequesterUpdated = {
    description: 'El directorio cambió el perfil de un solicitante.',
    source: 'directory',
    channel: 'ticketEvents',
    payload: { email: { type: 'string', required: true }, displayName: { type: 'string', required: true } },
    contract: { envelope: 'keel' },
    triggers: 'syncRequester',
    onFailure: {
      retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 500, maxDelayMs: 5000 },
      deadLetter: true
    }
  };
  d.layers.dependencies.dependencies.directory.needs.requesterCopy = {
    description: 'Perfil del solicitante, leído de la copia local.',
    usedBy: ['getTicket'],
    strategy: 'replicated',
    replica: {
      entity: 'Requester',
      keyField: 'email',
      fedBy: ['RequesterUpdated'],
      onMiss: { action: 'fail', error: 'DIRECTORY_UNAVAILABLE' }
    }
  };
  addMatrixRow(d, '| syncRequester | FL-REQ-001 | suscripción (interna) |');
  insertScenarioBefore(
    d,
    '### FL-ESC-001',
    `### FL-REQ-001: el directorio cambia un perfil

**Given** la copia de un solicitante.
**When** llega \`RequesterUpdated\` con otro nombre, y después se reentrega el mismo mensaje.
**Then** la copia tiene el nombre nuevo y no hay segundo efecto.`
  );
}

/**
 * Cobro de una tarifa de soporte prioritario con la capa `payments`: autorización y captura,
 * devolución parcial, 3DS y cobro de un medio guardado. El cobro entra por dos puertas —el
 * endpoint y la suscripción `PriorityChargeRequested`—, que es la silueta que necesitan las
 * reglas de la puerta asíncrona. Cada desenlace es internal, mueve el lifecycle de `Payment`
 * y publica su hecho.
 */
function withPayments(d) {
  d.manifest.layers.payments = 'payments.keel.yaml';
  const domain = d.layers.domain;
  domain.types.PaymentStatus = {
    description: 'Estados de un cobro frente a la pasarela.',
    values: ['pending', 'actionRequired', 'authorized', 'capturing', 'captured', 'refunding', 'failed', 'refunded', 'canceled']
  };
  domain.types.PaymentFailureReason = {
    description: 'Por qué falló un cobro, en el vocabulario neutro de la capa payments.',
    values: [...FAILURE_REASONS]
  };
  domain.entities.Payment = {
    description: 'Cobro de la tarifa de soporte prioritario.',
    fields: {
      id: { type: 'uuid', id: true, generated: true },
      chargeRequestId: { type: 'string', required: true, constraints: { maxLength: 64 } },
      amount: { type: 'decimal', required: true },
      currency: { type: 'string', required: true, constraints: { maxLength: 3 } },
      status: { type: 'PaymentStatus', required: true, default: 'pending' },
      gatewayPaymentId: { type: 'string', constraints: { maxLength: 128 } },
      failureReason: { type: 'PaymentFailureReason' },
      customerAction: { type: 'json' },
      requestedAt: { type: 'timestamp', required: true }
    },
    lifecycle: {
      field: 'status',
      transitions: {
        pending: ['actionRequired', 'authorized', 'failed'],
        actionRequired: ['authorized', 'failed'],
        authorized: ['capturing', 'canceled'],
        capturing: ['captured'],
        captured: ['refunding'],
        refunding: ['refunded'],
        failed: [],
        refunded: [],
        canceled: []
      }
    }
  };
  domain.aggregates.Payment = { root: 'Payment' };
  d.layers.persistence.entities.Payment = { naturalKey: ['chargeRequestId'], naturalKeyError: 'CHARGE_ALREADY_REQUESTED', indexes: [['status']] };

  const paymentInput = (fields) => ({
    fields: { chargeRequestId: { type: 'string', required: true, constraints: { maxLength: 64 } }, ...fields }
  });
  const PAYMENT_NOT_FOUND = { code: 'PAYMENT_NOT_FOUND', when: 'No hay cobro con esa referencia.', http: 404 };
  const outcome = (description, from, to, event) => ({
    description,
    kind: 'command',
    internal: true,
    input: paymentInput({}),
    output: 'void',
    emits: [event],
    transitions: [{ entity: 'Payment', from, to }]
  });
  Object.assign(ops(d), {
    requestPriorityCharge: {
      description: 'Pide el cobro de la tarifa de soporte prioritario.',
      kind: 'command',
      input: paymentInput({
        amount: { type: 'decimal', required: true },
        currency: { type: 'string', required: true, constraints: { maxLength: 3 } },
        paymentToken: { type: 'string', constraints: { maxLength: 255 } },
        paymentMethodRef: { type: 'string', constraints: { maxLength: 255 } }
      }),
      output: { entity: 'Payment' },
      errors: [
        { code: 'PAYMENT_SOURCE_MISSING', when: 'No llega ni token ni medio guardado.', http: 422 },
        { code: 'CHARGE_ALREADY_REQUESTED', when: 'La referencia ya tiene cobro.', http: 409 }
      ]
    },
    capturePriorityCharge: {
      description: 'Captura lo autorizado al dar el soporte prioritario.',
      kind: 'command',
      input: paymentInput({}),
      output: { entity: 'Payment' },
      errors: [PAYMENT_NOT_FOUND],
      transitions: [{ entity: 'Payment', from: ['authorized'], to: 'capturing' }]
    },
    refundPriorityCharge: {
      description: 'Devuelve todo o parte de lo cobrado.',
      kind: 'command',
      input: paymentInput({ amount: { type: 'decimal' } }),
      output: { entity: 'Payment' },
      errors: [PAYMENT_NOT_FOUND],
      transitions: [{ entity: 'Payment', from: ['captured'], to: 'refunding' }]
    },
    savePaymentMethod: {
      description: 'Guarda un medio de pago para cobrar después sin el solicitante.',
      kind: 'command',
      input: { fields: { paymentToken: { type: 'string', required: true, constraints: { maxLength: 255 } } } },
      output: { fields: { paymentMethodRef: { type: 'string' } } },
      errors: [{ code: 'PAYMENT_METHOD_REJECTED', when: 'La pasarela no acepta el medio de pago.', http: 422 }]
    },
    markAuthorized: outcome('Registra que el importe quedó retenido.', ['pending', 'actionRequired'], 'authorized', 'PriorityChargeAuthorized'),
    markCaptured: outcome('Registra que el cobro se completó.', ['capturing'], 'captured', 'PriorityChargeCaptured'),
    markFailed: outcome('Registra que el cobro no se pudo hacer.', ['pending', 'actionRequired'], 'failed', 'PriorityChargeFailed'),
    markActionRequired: outcome('Registra que el cobro espera al solicitante.', ['pending'], 'actionRequired', 'PriorityChargeActionRequired'),
    markRefunded: outcome('Registra que la devolución se completó.', ['refunding'], 'refunded', 'PriorityChargeRefunded'),
    markCanceled: outcome('Registra que la autorización se anuló o caducó.', ['authorized'], 'canceled', 'PriorityChargeCanceled'),
    sweepPendingCharges: {
      description: 'Consulta a la pasarela los cobros que llevan demasiado esperando desenlace.',
      kind: 'command',
      input: 'void',
      output: 'void',
      schedule: { cron: '*/5 * * * *' },
      transitions: [{ entity: 'Payment', from: ['pending'], to: 'failed' }]
    }
  });
  Object.assign(d.layers.api.endpoints, {
    requestPriorityCharge: { method: 'POST', path: '/priority-charges', successStatus: 200 },
    capturePriorityCharge: { method: 'POST', path: '/priority-charges/{chargeRequestId}/capture', successStatus: 200 },
    refundPriorityCharge: { method: 'POST', path: '/priority-charges/{chargeRequestId}/refund', successStatus: 200 },
    savePaymentMethod: { method: 'POST', path: '/payment-methods', successStatus: 200 }
  });

  const messaging = d.layers.messaging;
  for (const event of ['Authorized', 'Captured', 'Failed', 'ActionRequired', 'Refunded', 'Canceled']) {
    messaging.publishing.events[`PriorityCharge${event}`] = {
      channel: 'ticketEvents',
      description: `Desenlace del cobro prioritario: ${event}.`,
      payload: { chargeRequestId: { type: 'string', required: true } }
    };
  }
  messaging.subscriptions.PriorityChargeRequested = {
    description: 'Otro servicio pide cobrar la tarifa prioritaria con un medio guardado.',
    source: 'billing',
    nature: 'request',
    channel: 'ticketEvents',
    payload: {
      chargeRequestId: { type: 'string', required: true },
      amount: { type: 'decimal', required: true },
      currency: { type: 'string', required: true },
      paymentMethodRef: { type: 'string', required: true }
    },
    contract: { envelope: 'keel' },
    triggers: 'requestPriorityCharge',
    onFailure: {
      retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 500, maxDelayMs: 5000 },
      deadLetter: true,
      acknowledgeOn: ['CHARGE_ALREADY_REQUESTED']
    }
  };

  d.layers.payments = {
    description: 'Cobra la tarifa de soporte prioritario, en el acto o con un medio guardado.',
    flow: 'authorize-capture',
    capabilities: ['partial-refund', 'customer-action', 'off-session'],
    record: {
      entity: 'Payment',
      gatewayRef: 'gatewayPaymentId',
      awaitingSince: 'requestedAt',
      failureReason: 'failureReason',
      customerAction: 'customerAction'
    },
    charge: {
      operation: 'requestPriorityCharge',
      reference: 'chargeRequestId',
      amount: 'amount',
      currency: { input: 'currency' },
      source: { token: 'paymentToken', saved: 'paymentMethodRef' }
    },
    capture: { operation: 'capturePriorityCharge', inFlight: 'capturing', onRejected: 'reconcile' },
    refund: { operation: 'refundPriorityCharge', amount: 'amount', inFlight: 'refunding', onRejected: 'reconcile' },
    savePaymentMethod: { operation: 'savePaymentMethod', token: 'paymentToken', exposedAs: 'paymentMethodRef' },
    outcomes: {
      authorized: 'markAuthorized',
      captured: 'markCaptured',
      failed: 'markFailed',
      actionRequired: 'markActionRequired',
      refunded: 'markRefunded',
      canceled: 'markCanceled'
    },
    reconciliation: { sweep: 'sweepPendingCharges', unansweredAfterSeconds: 900 }
  };

  addMatrixRow(
    d,
    [
      '| requestPriorityCharge | FL-PAY-001, FL-PAY-001-B, FL-PAY-002 | usuarios, suscripción |',
      '| capturePriorityCharge | FL-PAY-003 | usuarios |',
      '| refundPriorityCharge | FL-PAY-004 | usuarios |',
      '| savePaymentMethod | FL-PAY-005 | usuarios |',
      '| markAuthorized | FL-PAY-001 | pasarela (interna) |',
      '| markCaptured | FL-PAY-003 | pasarela (interna) |',
      '| markFailed | FL-PAY-002-B | pasarela (interna) |',
      '| markActionRequired | FL-PAY-001-B | pasarela (interna) |',
      '| markRefunded | FL-PAY-004 | pasarela (interna) |',
      '| markCanceled | FL-PAY-006 | pasarela (interna) |',
      '| sweepPendingCharges | FL-PAY-007 | programada |'
    ].join('\n')
  );
  insertScenarioBefore(
    d,
    '### FL-ESC-001',
    `### FL-PAY-001: cobro con el solicitante presente

**Given** un solicitante con un token de la pasarela.
**When** se llama a \`requestPriorityCharge\` y la pasarela autoriza.
**Then** responde 200, el cobro nace en \`pending\`, \`markAuthorized\` lo deja en \`authorized\` y se publica \`PriorityChargeAuthorized\`.

#### FL-PAY-001-B: la pasarela pide 3DS

**Given** un token cuya tarjeta exige autenticación.
**When** se llama a \`requestPriorityCharge\`.
**Then** la respuesta lleva la acción del cliente y \`markActionRequired\` deja el cobro en \`actionRequired\`.

### FL-PAY-002: cobro pedido por evento

**Given** un medio guardado.
**When** llega \`PriorityChargeRequested\`, y después se reentrega el mismo mensaje.
**Then** hay un solo cobro y no hay segundo efecto; un mensaje distinto con la misma referencia se confirma sin efecto, y por HTTP la misma referencia responde 409 con \`CHARGE_ALREADY_REQUESTED\`.

#### FL-PAY-002-B: la pasarela rechaza

**Given** un medio guardado sin fondos.
**When** llega \`PriorityChargeRequested\`.
**Then** \`markFailed\` deja el cobro en \`failed\` y se publica \`PriorityChargeFailed\`.

### FL-PAY-003: captura

**Given** un cobro en \`authorized\`.
**When** se llama a \`capturePriorityCharge\`.
**Then** el cobro pasa por \`capturing\` y \`markCaptured\` lo deja en \`captured\`; con una referencia que no existe, 404 con \`PAYMENT_NOT_FOUND\`.

### FL-PAY-004: devolución parcial

**Given** un cobro en \`captured\`.
**When** se llama a \`refundPriorityCharge\` con la mitad del importe.
**Then** el cobro pasa por \`refunding\` y \`markRefunded\` lo deja en \`refunded\`; con una referencia que no existe, 404 con \`PAYMENT_NOT_FOUND\`.

### FL-PAY-005: guardar un medio de pago

**Given** un token válido, y otro que la pasarela rechaza.
**When** se llama a \`savePaymentMethod\` con cada uno.
**Then** responde 200 con la referencia guardada, y 422 con \`PAYMENT_METHOD_REJECTED\`; sin token ni medio, \`requestPriorityCharge\` responde 422 con \`PAYMENT_SOURCE_MISSING\`.

### FL-PAY-006: la autorización caduca

**Given** un cobro en \`authorized\` que nadie captura.
**When** la pasarela avisa de que la autorización caducó.
**Then** \`markCanceled\` lo deja en \`canceled\`.

### FL-PAY-007: cobros en duda

**Given** varios cobros en \`pending\` sin respuesta de la pasarela, con dos réplicas vivas.
**When** corre \`sweepPendingCharges\`.
**Then** cada cobro se consulta exactamente una vez y el que la pasarela no conoce queda en \`failed\`.`
  );
}

export const EXTENSIONS = {
  payments: withPayments,
  m2m: withM2m,
  replica: withReplica,
  outbox: withOutbox,
  escalation: withEscalation,
  compensation: (d) => {
    withEscalation(d);
    withCompensation(d);
  }
};

// ─── Idempotencia: un escenario de carrera, para que el aviso anónimo de la carrera no salte ──

function withClientKey(d, codes) {
  ops(d).createTicket.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  const catalog = {
    required: { code: 'IDEMPOTENCY_KEY_REQUIRED', when: 'La petición no trae Idempotency-Key.', http: 400 },
    race: { code: 'IDEMPOTENCY_KEY_IN_PROGRESS', when: 'Otra petición con la misma clave está en curso.', http: 409 },
    reuse: { code: 'IDEMPOTENCY_KEY_REUSED', when: 'La clave ya se usó con otro cuerpo.', http: 409 }
  };
  ops(d).createTicket.errors.push(...codes.map((name) => catalog[name]));
  insertScenarioBefore(
    d,
    '### FL-TCK-002',
    `#### FL-TCK-001-C: dos altas a la vez con la misma clave

**Given** una \`Idempotency-Key\` nueva.
**When** se llama a \`createTicket\` dos veces a la vez con esa clave.
**Then** se crea un solo ticket; los rechazos posibles son \`IDEMPOTENCY_KEY_IN_PROGRESS\`, \`IDEMPOTENCY_KEY_REUSED\` e \`IDEMPOTENCY_KEY_REQUIRED\`.`
  );
}

// ─── El catálogo ────────────────────────────────────────────────────────────────────

export const MUTATIONS = [
  // ── domain ──
  {
    id: 'M-DOMAIN-NO-ID',
    title: 'una entidad sin ningún campo id: true',
    mutate: (d) => {
      delete entity(d, 'TicketNote').fields.id.id;
    },
    expect: ['CHK-DOMAIN-SINGLE-ID']
  },
  {
    id: 'M-DOMAIN-TWO-IDS',
    title: 'una entidad con dos campos id: true',
    mutate: (d) => {
      entity(d, 'Queue').fields.name.id = true;
    },
    expect: ['CHK-DOMAIN-SINGLE-ID']
  },
  {
    id: 'M-DOMAIN-COLLECTION-CROSSES',
    title: 'una colección one-to-many hacia la raíz de otro agregado',
    mutate: (d) => {
      entity(d, 'Queue').relations = { tickets: { entity: 'Ticket', cardinality: 'one-to-many' } };
    },
    expect: ['CHK-DOMAIN-COLLECTION-CROSSES-AGGREGATE']
  },
  {
    id: 'M-DOMAIN-INNER-LIFECYCLE',
    title: 'una entidad interna declara máquina de estados propia',
    mutate: (d) => {
      const note = entity(d, 'TicketNote');
      // `open` a propósito: es un estado que los escenarios ya nombran, así que la regla de
      // estados sin escenario no tiene nada que decir y la mutación mide solo esta.
      note.fields.state = { type: 'enum', values: ['open'], required: true, default: 'open' };
      note.lifecycle = { field: 'state', transitions: { open: [] } };
    },
    expect: ['CHK-DOMAIN-INNER-LIFECYCLE']
  },
  {
    id: 'M-DOMAIN-SCALE-POLICY-NO-SCALE',
    title: 'scalePolicy en un decimal sin scale',
    mutate: (d) => {
      entity(d, 'Ticket').fields.budget = { type: 'decimal', constraints: { scalePolicy: 'reject' } };
    },
    expect: ['CHK-DOMAIN-SCALE-POLICY-WITHOUT-SCALE']
  },
  {
    id: 'M-FIELD-COMPARE-NOT-TEXT',
    title: 'compare sobre un campo que no es texto',
    mutate: (d) => {
      entity(d, 'Ticket').fields.escalationLevel.compare = 'ignore-case';
    },
    expect: ['CHK-FIELD-COMPARE-NOT-TEXT']
  },
  {
    id: 'M-OBL-DECIMAL-SCALE-POLICY',
    title: 'un decimal con escala en la entrada sin scalePolicy',
    mutate: (d) => {
      ops(d).createTicket.input.fields.budget = { type: 'decimal', constraints: { scale: 2 } };
    },
    expect: ['OBL-DECIMAL-SCALE-POLICY']
  },

  // ── service ──
  {
    id: 'M-SERVICE-PARAM-UNBACKED',
    title: 'una invariante del dominio habla de un parámetro de despliegue que el manifiesto no declara',
    mutate: (d) => {
      entity(d, 'Ticket').invariants = ['El plazo máximo de respuesta es un parámetro de despliegue del servicio.'];
    },
    expect: ['CHK-SERVICE-PARAM-UNBACKED']
  },

  // ── use-cases ──
  {
    id: 'M-USECASES-QUERY-EMITS',
    title: 'una query publica un evento',
    mutate: (d) => {
      ops(d).getTicket.emits = ['TicketClosed'];
    },
    expect: ['CHK-USECASES-QUERY-EMITS']
  },
  {
    id: 'M-USECASES-INPUT-GENERATED',
    title: 'un campo generated en el input de una operación',
    mutate: (d) => {
      ops(d).createTicket.input.fields.openedAt = { type: 'timestamp', generated: true };
    },
    expect: ['CHK-USECASES-INPUT-GENERATED']
  },
  {
    id: 'M-USECASES-COMMAND-NO-ERRORS',
    title: 'un command expuesto sin ningún error declarado',
    mutate: (d) => {
      delete ops(d).createTicket.errors;
    },
    expect: ['CHK-USECASES-COMMAND-NO-ERRORS']
  },
  {
    id: 'M-USECASES-MULTI-AGGREGATE',
    title: 'una operación mueve el estado de dos agregados',
    mutate: (d) => {
      ops(d).closeTicket.transitions.push({ entity: 'Queue', from: ['active'], to: 'archived' });
    },
    expect: ['CHK-USECASES-MULTI-AGGREGATE']
  },
  {
    id: 'M-USECASES-MULTI-AGGREGATE-TX',
    title: 'una operación mueve dos agregados con la frontera por operación',
    mutate: (d) => {
      d.layers.persistence.consistency.transactionalBoundary = 'per-operation';
      ops(d).closeTicket.transitions.push({ entity: 'Queue', from: ['active'], to: 'archived' });
    },
    // Co-disparado a propósito: la frontera por operación con agregados declarados ES la
    // decisión que pregunta CHK-PERSIST-BOUNDARY-DEFAULT, así que las dos salen siempre juntas.
    expect: ['CHK-PERSIST-BOUNDARY-DEFAULT', 'CHK-USECASES-MULTI-AGGREGATE-TX']
  },
  {
    id: 'M-MODEL-SENSITIVE-PROJECTED',
    title: 'un campo sensitive que proyectan las cuatro salidas de la entidad',
    mutate: (d) => {
      entity(d, 'Ticket').fields.requesterEmail.sensitive = true;
    },
    // Uno por salida: es una decisión por unidad (cada salida se cierra o se acepta aparte).
    expect: Array(4).fill('CHK-MODEL-SENSITIVE-PROJECTED')
  },
  {
    id: 'M-USECASES-REPEATABLE-ESCAPES',
    title: 'un POST que publica sin idempotencia ni transición irrepetible',
    mutate: (d) => {
      ops(d).createTicket.emits = ['TicketClosed'];
    },
    expect: ['CHK-USECASES-REPEATABLE-ESCAPES']
  },
  {
    id: 'M-USECASES-CHILD-NOT-IN-INPUT',
    title: 'un command cuyo input deriva de una entidad con colección de hijas',
    mutate: (d) => {
      ops(d).createTicket.input = { entity: 'Ticket' };
    },
    expect: ['CHK-USECASES-CHILD-NOT-IN-INPUT']
  },
  {
    id: 'M-USECASES-CODE-MULTI-STATUS',
    title: 'el mismo code con dos status',
    mutate: (d) => {
      ops(d).noteEscalation.errors[0].http = 422;
    },
    expect: ['CHK-USECASES-CODE-MULTI-STATUS']
  },
  {
    id: 'M-USECASES-COLLECTION-NO-SORT',
    title: 'una salida list sin sort',
    mutate: (d) => {
      delete ops(d).listTickets.output.sort;
    },
    expect: ['CHK-USECASES-COLLECTION-NO-SORT']
  },
  {
    id: 'M-USECASES-MATCH-OUTSIDE-QUERY',
    title: 'match en el input de un command',
    mutate: (d) => {
      ops(d).createTicket.input.fields.subject.match = 'contains';
    },
    expect: ['CHK-USECASES-MATCH-OUTSIDE-QUERY']
  },
  {
    id: 'M-OBL-IDEM-UNNAMED',
    title: 'idempotency client-key sin nombrar ninguno de sus tres desenlaces',
    mutate: (d) => withClientKey(d, []),
    expect: ['OBL-IDEM-KEY-REQUIRED', 'OBL-IDEM-RACE-CODE', 'OBL-IDEM-REUSE-CODE']
  },
  {
    id: 'M-OBL-IDEM-KEY-REQUIRED',
    title: 'idempotency client-key que nombra la carrera y la reutilización, no la ausencia de clave',
    mutate: (d) => withClientKey(d, ['race', 'reuse']),
    expect: ['OBL-IDEM-KEY-REQUIRED']
  },
  {
    id: 'M-OBL-IDEM-RACE-CODE',
    title: 'idempotency client-key sin code para la carrera',
    mutate: (d) => withClientKey(d, ['required', 'reuse']),
    expect: ['OBL-IDEM-RACE-CODE']
  },
  {
    id: 'M-OBL-IDEM-REUSE-CODE',
    title: 'idempotency client-key sin code para la reutilización',
    mutate: (d) => withClientKey(d, ['required', 'race']),
    expect: ['OBL-IDEM-REUSE-CODE']
  },

  // ── api ──
  {
    id: 'M-API-POST-NO-STATUS',
    title: 'un POST sin successStatus',
    mutate: (d) => {
      delete d.layers.api.endpoints.createTicket.successStatus;
    },
    expect: ['CHK-API-POST-NO-STATUS']
  },
  {
    id: 'M-API-CREATED-NO-READ',
    title: 'un alta 201 cuyo recurso ya no se lee por id',
    mutate: (d) => {
      d.layers.api.endpoints.getTicket.path = '/tickets/{id}/as/{format}';
      d.layers['use-cases'].operations.getTicket.input.fields.format = { type: 'string', required: true };
    },
    expect: ['CHK-API-CREATED-NO-READ']
  },
  {
    id: 'M-API-NO-SECURITY',
    title: 'capa api sin capa security',
    mutate: (d) => {
      delete d.layers.security;
    },
    expect: ['CHK-API-NO-SECURITY']
  },

  // ── security ──
  {
    id: 'M-SEC-UNUSED-ROLE',
    title: 'un rol que ninguna regla exige',
    mutate: (d) => {
      d.layers.security.roles.auditor = { description: 'Revisa tickets cerrados.' };
    },
    expect: ['CHK-SEC-UNUSED-ROLE']
  },
  {
    id: 'M-SEC-ORPHAN-PERMISSION',
    title: 'un permiso que nadie concede ni exige',
    mutate: (d) => {
      d.layers.security.permissions['ticket:export'] = { description: 'Exportar tickets.' };
    },
    expect: ['CHK-SEC-ORPHAN-PERMISSION']
  },
  {
    id: 'M-SEC-PUBLIC-COMMAND',
    title: 'una escritura con level: public',
    mutate: (d) => {
      d.layers.security.access.rules = { createTicket: { level: 'public' } };
    },
    expect: ['CHK-SEC-PUBLIC-COMMAND']
  },
  {
    id: 'M-OBL-RESOURCE-SCOPE',
    title: 'un 403 que ningún rol ni permiso global puede producir',
    mutate: (d) => {
      ops(d).getTicket.errors.push({ code: 'TICKET_FORBIDDEN', when: 'El agente no atiende la cola del ticket.', http: 403 });
      // Nombrarlo en un escenario: si no, el code sin escenario dispararía su propio aviso.
      replaceIn(d, '503 con `DIRECTORY_UNAVAILABLE`.', '503 con `DIRECTORY_UNAVAILABLE`; fuera de su cola, 403 con `TICKET_FORBIDDEN`.');
    },
    expect: ['OBL-RESOURCE-SCOPE']
  },
  {
    id: 'M-OBL-CALLER-IDENTITY',
    title: 'clientes máquina declarados sin decir si la identidad del llamante entra en el trabajo',
    mutate: (d) => {
      d.layers.security.authentication.serviceAuth = {
        protocol: 'client-credentials',
        description: 'La guardia anota escaladas por API.'
      };
    },
    expect: ['OBL-CALLER-IDENTITY']
  },

  // ── messaging ──
  {
    id: 'M-MSG-CHANNEL-TECH-NAME',
    title: 'un canal que nombra la tecnología del broker',
    mutate: (d) => {
      const messaging = d.layers.messaging;
      messaging.channels.ticketTopic = messaging.channels.ticketEvents;
      delete messaging.channels.ticketEvents;
      messaging.publishing.events.TicketClosed.channel = 'ticketTopic';
      messaging.subscriptions.TicketEscalated.channel = 'ticketTopic';
    },
    expect: ['CHK-MSG-CHANNEL-TECH-NAME']
  },
  {
    id: 'M-MSG-SUB-NO-ONFAILURE',
    title: 'una suscripción sin onFailure',
    mutate: (d) => {
      delete d.layers.messaging.subscriptions.TicketEscalated.onFailure;
    },
    expect: ['CHK-MSG-SUB-NO-ONFAILURE']
  },
  {
    id: 'M-MSG-NO-SCHEMAREF',
    title: 'formato avro sin schemaRef',
    mutate: (d) => {
      d.layers.messaging.subscriptions.TicketEscalated.contract.format = 'avro';
    },
    expect: ['CHK-MSG-NO-SCHEMAREF']
  },
  {
    id: 'M-MSG-KEEL-ENVELOPE-EXTERNAL',
    title: 'envoltura keel sobre un canal que posee otro sistema',
    mutate: (d) => {
      const messaging = d.layers.messaging;
      messaging.channels.oncallRequests = { description: 'Peticiones del equipo de guardia.', external: true };
      messaging.subscriptions.TicketEscalated.channel = 'oncallRequests';
    },
    expect: ['CHK-MSG-KEEL-ENVELOPE-EXTERNAL']
  },
  {
    id: 'M-MSG-INPUT-ENVELOPE-FIELD',
    title: 'el input de una suscripción lee metadata.eventId sobre un campo que no es texto',
    mutate: (d) => {
      ops(d).noteEscalation.input.fields.escalationRef = { type: 'int' };
      d.layers.messaging.subscriptions.TicketEscalated.input.escalationRef = 'metadata.eventId';
    },
    expect: ['CHK-MSG-INPUT-ENVELOPE-FIELD']
  },

  // ── http-clients ──
  {
    id: 'M-HTTP-NO-TIMEOUT',
    title: 'una llamada saliente sin timeoutMs',
    mutate: (d) => {
      delete d.layers['http-clients'].clients.directory.calls.getProfile.timeoutMs;
    },
    expect: ['CHK-HTTP-NO-TIMEOUT']
  },

  // ── dependencies ──
  {
    id: 'M-DEPS-NEED-NO-ONUNAVAILABLE',
    title: 'un dato pedido al proveedor sin onUnavailable',
    mutate: (d) => {
      delete d.layers.dependencies.dependencies.directory.needs.requesterProfile.onUnavailable;
    },
    expect: ['CHK-DEPS-NEED-NO-ONUNAVAILABLE']
  },
  {
    id: 'M-DEPS-CLOCK-NOT-OBSERVABLE',
    title: 'todas las salidas excluyen la marca de la que depende el barrido',
    extends: 'escalation',
    mutate: (d) => {
      for (const op of Object.values(ops(d))) {
        if (op.output?.entity === 'Ticket') op.output.exclude = ['pageAwaitingSince'];
      }
    },
    expect: ['CHK-DEPS-CLOCK-NOT-OBSERVABLE']
  },
  {
    id: 'M-DEPS-COMPENSATION-DEAD-END',
    title: 'la compensación devuelve la entidad a un estado terminal',
    extends: 'compensation',
    mutate: (d) => {
      entity(d, 'Ticket').lifecycle.transitions.awaitingAck = ['open', 'closed'];
      ops(d).abandonEscalation.transitions[0].to = 'closed';
    },
    expect: ['CHK-DEPS-COMPENSATION-DEAD-END']
  },
  {
    id: 'M-OBL-OUTCOME-NEGATIVE',
    title: 'una activación awaits: outcome cuya respuesta es un booleano sin decidir el false',
    mutate: (d) => {
      d.layers['http-clients'].clients.directory.calls.notifyClosure = {
        contract: 'POST /closures registra el cierre y devuelve { accepted }.',
        method: 'POST',
        path: '/closures',
        request: { body: { ticketId: { type: 'uuid', required: true } } },
        response: { fields: { accepted: { type: 'boolean', required: true } } },
        timeoutMs: 2000
      };
      d.layers.dependencies.dependencies.directory.activations = {
        announceClosure: {
          description: 'Registro del cierre en el directorio.',
          triggeredBy: ['closeTicket'],
          via: { client: 'directory', call: 'notifyClosure' },
          effect: 'El directorio sabe que el ticket del solicitante está cerrado.',
          awaits: 'outcome',
          onFailure: { action: 'ignore' }
        }
      };
    },
    expect: ['OBL-OUTCOME-NEGATIVE-UNDECIDED']
  },

  // ── persistence ──
  {
    id: 'M-PERSIST-ROOT-UNMAPPED',
    title: 'una raíz de agregado que persistence no menciona',
    mutate: (d) => {
      delete d.layers.persistence.entities.Queue;
    },
    expect: ['CHK-PERSIST-ROOT-UNMAPPED']
  },
  {
    id: 'M-PERSIST-BOUNDARY-DEFAULT',
    title: 'transacción por operación (el default) habiendo agregados',
    mutate: (d) => {
      delete d.layers.persistence.consistency.transactionalBoundary;
    },
    expect: ['CHK-PERSIST-BOUNDARY-DEFAULT']
  },
  // ── defaults tácitos del catálogo estructural (una por fila de STRUCTURAL_DEFAULTS) ──
  {
    id: 'M-MODEL-IMPLICIT-DEFAULT-LOCKING',
    title: 'optimisticLocking sin escribir: se aplicaría all sin que nadie lo decidiera',
    mutate: (d) => {
      delete d.layers.persistence.consistency.optimisticLocking;
    },
    expect: ['CHK-MODEL-IMPLICIT-DEFAULT']
  },
  {
    id: 'M-MODEL-IMPLICIT-DEFAULT-TIMESTAMPS',
    title: 'audit.timestamps sin escribir',
    mutate: (d) => {
      delete d.layers.persistence.audit.timestamps;
    },
    expect: ['CHK-MODEL-IMPLICIT-DEFAULT']
  },
  {
    id: 'M-MODEL-IMPLICIT-DEFAULT-AUTHORSHIP',
    title: 'audit.authorship sin escribir',
    mutate: (d) => {
      delete d.layers.persistence.audit.authorship;
    },
    expect: ['CHK-MODEL-IMPLICIT-DEFAULT']
  },
  {
    id: 'M-MODEL-IMPLICIT-DEFAULT-RELIABILITY',
    title: 'publishing.reliability sin escribir',
    mutate: (d) => {
      delete d.layers.messaging.publishing.reliability;
    },
    expect: ['CHK-MODEL-IMPLICIT-DEFAULT']
  },
  {
    id: 'M-MODEL-IMPLICIT-DEFAULT-VISIBILITY',
    title: 'la visibility de un bucket sin escribir',
    mutate: (d) => {
      delete d.layers.storage.buckets.ticketAttachments.visibility;
    },
    expect: ['CHK-MODEL-IMPLICIT-DEFAULT']
  },
  {
    id: 'M-PERSIST-AUDIT-NESTED',
    title: 'auditoría automática con modelo documental y una entidad anidada',
    mutate: (d) => {
      d.layers.persistence.default.model = 'document';
    },
    expect: ['CHK-PERSIST-AUDIT-NESTED']
  },
  {
    id: 'M-PERSIST-CONDITIONAL-UNIQUE-CODE',
    title: 'un índice único condicionado sin code que lo nombre',
    mutate: (d) => {
      d.layers.persistence.entities.Queue.indexes.push({
        fields: ['name'],
        unique: true,
        when: { field: 'status', equals: 'active' }
      });
    },
    expect: ['CHK-PERSIST-CONDITIONAL-UNIQUE-CODE']
  },
  {
    id: 'M-PERSIST-CHILD-UNIQUE-CODE',
    title: 'un índice único de una hija acotado a su raíz sin code que lo nombre',
    mutate: (d) => {
      const note = entity(d, 'TicketNote');
      note.fields.position = { type: 'int', required: true };
      note.relations = { ticket: { entity: 'Ticket', cardinality: 'many-to-one' } };
      d.layers.persistence.entities.TicketNote = { indexes: [{ fields: ['ticketId', 'position'], unique: true }] };
    },
    expect: ['CHK-PERSIST-CHILD-UNIQUE-CODE']
  },
  {
    id: 'M-PERSIST-UNIQUE-ERROR-UNDECLARED',
    title: 'dos unicidades en la misma entidad y ninguna nombra su error',
    mutate: (d) => {
      d.layers.persistence.entities.Queue.naturalKey = ['name'];
      d.layers.persistence.entities.Queue.indexes.push({ fields: ['status'], unique: true });
    },
    // Una por unicidad: con dos, ninguna de las dos se deja deducir.
    expect: ['CHK-PERSIST-UNIQUE-ERROR-UNDECLARED', 'CHK-PERSIST-UNIQUE-ERROR-UNDECLARED']
  },
  {
    id: 'M-PERSIST-NATURAL-KEY-ERROR-UNNAMED',
    title: 'la única unicidad sin nombrar su error, con un 409 de la entidad que no tiene la forma deducible',
    mutate: (d) => {
      // La corrida job-dispatch-cycles: el duplicado declarado con otra forma (JOB_ALREADY_ENQUEUED).
      d.layers.persistence.entities.Queue.naturalKey = ['name'];
      // Un 409 que la entidad ya tiene cubierto por escenarios (QUEUE_NOT_FOUND, aquí como 409): un code nuevo
      // dispararía además su falta de escenario, y la mutación tiene que medir solo esta regla.
      ops(d).archiveQueue.errors[0].http = 409;
    },
    expect: ['CHK-PERSIST-NATURAL-KEY-ERROR-UNNAMED']
  },
  {
    id: 'M-SCEN-ROUTE-UNSERVED',
    title: 'un escenario llama a la ruta sin la versión que el generador añade al basePath',
    mutate: (d) => {
      // La corrida job-dispatch-cycles: basePath /api y el documento escrito con /api/jobs.
      replaceIn(d, '**When** se llama a `getTicket`.', '**When** `GET /api/tickets/{id}`.');
    },
    expect: ['CHK-SCEN-ROUTE-UNSERVED']
  },
  {
    id: 'M-PERSIST-UNIQUE-ERROR-UNKNOWN',
    title: 'un índice único que nombra un error que ninguna operación declara',
    mutate: (d) => {
      d.layers.persistence.entities.Queue.indexes.push({ fields: ['name'], unique: true, error: 'QUEUE_NAME_TAKEN' });
    },
    expect: ['CHK-PERSIST-UNIQUE-ERROR-UNKNOWN']
  },
  {
    id: 'M-OBL-CONCURRENCY-CODE',
    title: 'bloqueo optimista sin nombrar el code del conflicto',
    mutate: (d) => {
      d.layers.persistence.consistency.optimisticLocking = 'all';
    },
    expect: ['OBL-CONCURRENCY-CODE']
  },
  {
    id: 'M-OBL-ENTITY-UNREACHABLE',
    title: 'una raíz persistida que ninguna operación nombra',
    mutate: (d) => {
      d.layers.domain.entities.Tag = {
        description: 'Etiqueta de clasificación.',
        fields: { id: { type: 'uuid', id: true, generated: true }, label: { type: 'string', required: true } }
      };
      d.layers.domain.aggregates.Tag = { root: 'Tag' };
      d.layers.persistence.entities.Tag = { indexes: [['label']] };
    },
    expect: ['OBL-ENTITY-UNREACHABLE']
  },

  // ── storage ──
  {
    id: 'M-STORAGE-NO-MAXSIZE',
    title: 'un bucket sin maxSizeMb',
    mutate: (d) => {
      delete d.layers.storage.buckets.ticketAttachments.maxSizeMb;
    },
    expect: ['CHK-STORAGE-NO-MAXSIZE']
  },

  // ── mail ──
  {
    id: 'M-OBL-GUARD-UNOBSERVABLE',
    title: 'una operación que manda correo con estado en vuelo y sin puerta propia',
    mutate: (d) => {
      d.layers.domain.types.QueueStatus.values = ['active', 'archiving', 'archived'];
      entity(d, 'Queue').lifecycle.transitions = { active: ['archiving'], archiving: ['archived'], archived: [] };
      const archive = ops(d).archiveQueue;
      archive.transitions = [
        { entity: 'Queue', from: ['active'], to: 'archiving' },
        { entity: 'Queue', from: ['archiving'], to: 'archived' }
      ];
      archive.internal = true;
      delete d.layers.api.endpoints.archiveQueue;
      d.layers.mail.sentBy.push('archiveQueue');
      replaceIn(d, 'la primera queda en `archived`', 'la primera pasa por `archiving` y queda en `archived`');
    },
    expect: ['OBL-GUARD-UNOBSERVABLE']
  },

  // ── validation-scenarios.md ──
  {
    id: 'M-SCEN-MATRIX-MISSING-OP',
    title: 'una operación sin fila en la matriz de cobertura',
    mutate: (d) => replaceIn(d, '| listTickets | FL-TCK-003 | usuarios |\n', ''),
    expect: ['CHK-SCEN-MATRIX-MISSING-OP']
  },
  {
    id: 'M-SCEN-MATRIX-UNKNOWN-OP',
    title: 'la matriz nombra una operación que no existe',
    mutate: (d) => addMatrixRow(d, '| reopenTicket | FL-TCK-004 | usuarios |'),
    expect: ['CHK-SCEN-MATRIX-UNKNOWN-OP']
  },
  {
    id: 'M-SCEN-MATRIX-DANGLING-FL',
    title: 'la matriz cita un flujo que no está escrito',
    mutate: (d) => replaceIn(d, '| listTickets | FL-TCK-003 |', '| listTickets | FL-TCK-009 |'),
    expect: ['CHK-SCEN-MATRIX-DANGLING-FL']
  },
  {
    id: 'M-SCEN-ERROR-UNCOVERED',
    title: 'un code declarado que ningún escenario provoca',
    mutate: (d) => replaceIn(d, 'responde 422 con `REQUESTER_BLOCKED`.', 'responde 422.'),
    expect: ['CHK-SCEN-ERROR-UNCOVERED']
  },
  {
    // «Provocado» es dentro de un FL-: nombrarlo en una nota fuera de los flujos no cuenta.
    id: 'M-SCEN-ERROR-ONLY-IN-NOTE',
    title: 'un code que solo se nombra en una nota, fuera de los escenarios',
    mutate: (d) => {
      replaceIn(d, 'responde 422 con `REQUESTER_BLOCKED`.', 'responde 422.');
      replaceIn(d, '## Flujos\n', '> Pendiente: el caso de `REQUESTER_BLOCKED`.\n\n## Flujos\n');
    },
    expect: ['CHK-SCEN-ERROR-UNCOVERED']
  },
  {
    id: 'M-SCEN-MATRIX-EMPTY-ROW',
    title: 'una fila de la matriz que no cita ningún flujo',
    mutate: (d) => replaceIn(d, '| listTickets | FL-TCK-003 |', '| listTickets | todos |'),
    expect: ['CHK-SCEN-MATRIX-EMPTY-ROW']
  },
  {
    id: 'M-SCEN-UNOBSERVABLE-RETRY',
    title: 'un Then que afirma que no hubo reintentos',
    mutate: (d) =>
      replaceIn(d, '**Then** no hay segundo efecto: el nivel', '**Then** no hay segundo efecto ni reintentos: el nivel'),
    expect: ['CHK-SCEN-UNOBSERVABLE-RETRY']
  },
  {
    id: 'M-SCEN-STATE-UNREACHED',
    title: 'un estado del lifecycle que ningún escenario nombra',
    mutate: (d) => replaceIn(d, 'la primera queda en `archived` (204)', 'la primera queda archivada (204)'),
    expect: ['CHK-SCEN-STATE-UNREACHED']
  },
  {
    id: 'M-SCEN-OP-COUNT',
    title: 'un Then que cuenta mal las operaciones de una ruta',
    mutate: (d) =>
      replaceIn(
        d,
        '**Then** llegan ordenados por asunto.',
        '**Then** llegan ordenados por asunto, y las 3 operaciones de `/api/tickets` exigen el mismo token.'
      ),
    expect: ['CHK-SCEN-OP-COUNT']
  },
  {
    id: 'M-SCEN-EVENT-PAYLOAD-PARTIAL',
    title: 'un Then que enumera el payload de un evento y se deja un campo',
    mutate: (d) => {
      Object.assign(d.layers.messaging.publishing.events.TicketClosed.payload, {
        subject: { type: 'string', required: true },
        requesterEmail: { type: 'string', required: true },
        closedAt: { type: 'timestamp', required: true }
      });
      replaceIn(
        d,
        'se publica `TicketClosed` y sale un correo al solicitante.',
        'sale un correo al solicitante y:\n\n1. se publica `TicketClosed` con `ticketId`, `subject` y `requesterEmail`.'
      );
    },
    expect: ['CHK-SCEN-EVENT-PAYLOAD-PARTIAL']
  },
  {
    id: 'M-SCEN-ORDER-BY-MUTATED',
    title: 'un Then que afirma posición en un listado ordenado por updatedAt tras mover filas',
    mutate: (d) => {
      entity(d, 'Ticket').fields.updatedAt = { type: 'timestamp', generated: true };
      d.layers.persistence.audit.timestamps = 'declared';
      ops(d).listTickets.output.sort = ['updatedAt:desc'];
      replaceIn(d, '**Given** tres tickets con asuntos distintos.', '**Given** tres tickets, y el segundo ya en `closed`.');
      replaceIn(d, '**Then** llegan ordenados por asunto.', '**Then** el primero de la lista es el que se cerró.');
    },
    expect: ['CHK-SCEN-ORDER-BY-MUTATED']
  },
  {
    id: 'M-SCEN-CONVENTION-UNBACKED',
    title: 'una convención de ausencia dicha en prosa que el manifiesto no declara',
    mutate: (d) =>
      replaceIn(
        d,
        '## Matriz de cobertura',
        '## Convenciones de determinación\n\n**Ausencia.** Un campo sin valor no aparece en el cuerpo JSON.\n\n## Matriz de cobertura'
      ),
    expect: ['CHK-SCEN-CONVENTION-UNBACKED']
  },
  {
    id: 'M-SCEN-AUDIT-NOT-EXPOSED',
    title: 'un Then que afirma createdAt en la respuesta con audit.timestamps: all',
    mutate: (d) =>
      replaceIn(
        d,
        '**Then** responde 201 y el ticket nace en `open`.',
        '**Then** responde 201 con `createdAt` con forma de instante, y el ticket nace en `open`.'
      ),
    expect: ['CHK-SCEN-AUDIT-NOT-EXPOSED']
  },
  {
    id: 'M-SCEN-NEED-NOT-EXPOSED',
    title: 'un Then que repite en la respuesta lo que devolvió el proveedor de un need sin exposedAs',
    mutate: (d) => {
      replaceIn(
        d,
        '**Given** un ticket existente y el directorio contestando.',
        '**Given** un ticket existente y `directory.getProfile` responde `{displayName: "Ana Ruiz"}`.'
      );
      replaceIn(d, '**Then** responde 200 con el ticket.', '**Then** responde 200 con el ticket y el solicitante "Ana Ruiz".');
    },
    expect: ['CHK-SCEN-NEED-NOT-EXPOSED']
  },

  // ─── R5, tanda A: los avisos de domain, use-cases y api que eran anónimos ────
  {
    id: 'M-USECASES-EXCLUDE-CROSSES-AGGREGATE',
    title: 'un exclude con dot-path que entra en otro agregado',
    mutate: (d) => {
      entity(d, 'Ticket').relations.queue = { entity: 'Queue', cardinality: 'many-to-one' };
      ops(d).getTicket.output.exclude = ['queue.name'];
    },
    expect: ['CHK-USECASES-EXCLUDE-CROSSES-AGGREGATE']
  },
  {
    id: 'M-USECASES-PAGINATED-NO-POLICY',
    title: 'una salida paginated sin api.pagination',
    mutate: (d) => {
      const output = ops(d).listTickets.output;
      delete output.list;
      output.paginated = true;
    },
    expect: ['CHK-USECASES-PAGINATED-NO-POLICY']
  },
  {
    id: 'M-DOMAIN-STATE-NO-TRANSITIONS',
    title: 'un estado del enum que no aparece en transitions',
    mutate: (d) => {
      delete entity(d, 'Ticket').lifecycle.transitions.closed;
    },
    expect: ['CHK-DOMAIN-STATE-NO-TRANSITIONS']
  },
  {
    id: 'M-DOMAIN-ENTITY-NO-AGGREGATE',
    title: 'una entidad fuera de todo agregado habiendo agregados',
    mutate: (d) => {
      delete d.layers.domain.aggregates.Queue;
    },
    expect: ['CHK-DOMAIN-ENTITY-NO-AGGREGATE']
  },
  {
    id: 'M-DOMAIN-RELATION-TO-INNER',
    title: 'una relación hacia la entidad interna de otro agregado',
    mutate: (d) => {
      entity(d, 'Queue').relations = { lastNote: { entity: 'TicketNote', cardinality: 'many-to-one' } };
    },
    expect: ['CHK-DOMAIN-RELATION-TO-INNER']
  },
  {
    id: 'M-USECASES-INPUT-UNBOUNDED',
    title: 'el input con fields pierde la cota que el dominio declara',
    mutate: (d) => {
      delete ops(d).createTicket.input.fields.subject.constraints;
    },
    expect: ['CHK-USECASES-INPUT-UNBOUNDED']
  },
  {
    id: 'M-USECASES-CACHE-ON-COMMAND',
    title: 'cache sobre un command',
    mutate: (d) => {
      ops(d).archiveQueue.cache = { ttlSeconds: 60, keyFields: ['id'] };
    },
    expect: ['CHK-USECASES-CACHE-ON-COMMAND']
  },
  {
    id: 'M-DOMAIN-TRANSITION-UNEXECUTED',
    title: 'una transición del lifecycle que ninguna operación ejecuta',
    mutate: (d) => {
      entity(d, 'Ticket').lifecycle.transitions.closed = ['open'];
    },
    expect: ['CHK-DOMAIN-TRANSITION-UNEXECUTED']
  },
  {
    id: 'M-USECASES-CACHE-STALE-OWN',
    title: 'una lectura cacheada que no se invalida con el evento que cambia su entidad',
    mutate: (d) => {
      ops(d).getTicket.cache = { ttlSeconds: 60, keyFields: ['id'] };
    },
    expect: ['CHK-USECASES-CACHE-STALE-OWN']
  },
  {
    id: 'M-USECASES-EMBED-ASYMMETRY',
    title: 'una salida embebe una relación que las demás devuelven como id plano',
    mutate: (d) => {
      entity(d, 'Ticket').relations.queue = { entity: 'Queue', cardinality: 'many-to-one' };
      ops(d).getTicket.output.embed = ['queue'];
    },
    expect: ['CHK-USECASES-EMBED-ASYMMETRY']
  },
  {
    id: 'M-API-QUERY-NOT-GET',
    title: 'una query expuesta por POST',
    mutate: (d) => {
      // Con su successStatus, para no disparar además el POST sin status. Sobre el listado y no
      // sobre getTicket: sin la lectura por id, el alta de createTicket se queda sin Location y
      // dispararía también CHK-API-CREATED-NO-READ.
      Object.assign(d.layers.api.endpoints.listTickets, { method: 'POST', successStatus: 200 });
    },
    expect: ['CHK-API-QUERY-NOT-GET']
  },
  {
    id: 'M-API-COMMAND-GET',
    title: 'un command expuesto por GET',
    mutate: (d) => {
      d.layers.api.endpoints.closeTicket.method = 'GET';
    },
    expect: ['CHK-API-COMMAND-GET']
  },
  {
    id: 'M-API-BODY-STATUS-ON-VOID',
    title: 'un 200 sobre una operación sin output',
    mutate: (d) => {
      d.layers.api.endpoints.archiveQueue.successStatus = 200;
    },
    expect: ['CHK-API-BODY-STATUS-ON-VOID']
  },
  {
    id: 'M-API-DELETE-NO-STATUS',
    title: 'un DELETE con output y sin successStatus',
    mutate: (d) => {
      const endpoint = d.layers.api.endpoints.closeTicket;
      endpoint.method = 'DELETE';
      delete endpoint.successStatus;
    },
    expect: ['CHK-API-DELETE-NO-STATUS']
  },
  {
    id: 'M-USECASES-FILE-NO-NOT-FOUND',
    title: 'una operación que devuelve un archivo sin error para la clave inexistente',
    mutate: (d) => {
      ops(d).createTicket.output = { fields: { receipt: { type: 'file', bucket: 'ticketAttachments' } } };
    },
    expect: ['CHK-USECASES-FILE-NO-NOT-FOUND']
  },
  {
    id: 'M-USECASES-ORPHAN-OP',
    title: 'una operación que se queda sin ninguna puerta',
    mutate: (d) => {
      delete d.layers.api.endpoints.listTickets;
    },
    expect: ['CHK-USECASES-ORPHAN-OP']
  },
  {
    id: 'M-USECASES-SCHEDULE-NO-EFFECT',
    title: 'un barrido programado sin efecto declarado',
    mutate: (d) => {
      ops(d).refreshStats = {
        description: 'Recalcula las estadísticas de la cola.',
        kind: 'command',
        input: 'void',
        output: 'void',
        schedule: { cron: '0 * * * *' }
      };
      addMatrixRow(d, '| refreshStats | FL-TCK-003 | programada |');
    },
    expect: ['CHK-USECASES-SCHEDULE-NO-EFFECT']
  },
  {
    id: 'M-USECASES-IDEMPOTENT-LIST',
    title: 'una operación idempotente que responde con una lista',
    mutate: (d) => {
      withClientKey(d, ['required', 'race', 'reuse']);
      ops(d).createTicket.output = { entity: 'Ticket', list: true, sort: ['subject'] };
    },
    expect: ['CHK-USECASES-IDEMPOTENT-LIST']
  },

  // ─── R5, tanda B: security ──────────────────────────────────────────────────
  // Las tres primeras le quitan además el scope al bot: si no, el scope concedido que ninguna
  // regla exige dispararía su propio aviso (CHK-SEC-CLIENT-SCOPE-UNUSED), que se mide aparte.
  {
    id: 'M-USECASES-IDEM-SCOPE-UNDECIDED',
    title: 'una clave client-key en un servicio que distingue llamantes, sin ámbito',
    extends: 'm2m',
    mutate: (d) => withClientKey(d, ['required', 'race', 'reuse']),
    expect: ['CHK-USECASES-IDEM-SCOPE-UNDECIDED']
  },
  // La clave en el cuerpo frente a la clave natural: el generador compara por NOMBRE, así que un
  // keyField que no está en la naturalKey cae a un almacén de claves sin decirlo (corrida
  // user-profile, 2026-10-01). Con `keyField: subject` la misma mutación queda en silencio: lo
  // fija su caso en crossrefs.test.js.
  {
    id: 'M-USECASES-IDEM-KEYFIELD-NOT-NATURAL',
    title: 'una clave payload-field que no participa en la naturalKey de la entidad que se crea',
    mutate: (d) => {
      // Con guarda de almacén el diseño tiene que nombrar los desenlaces del almacén (carrera y
      // reutilización) y su escenario: se los da el mismo andamiaje que a la clave client-key, para
      // que la mutación mida solo la regla nueva.
      withClientKey(d, ['race', 'reuse']);
      d.layers.persistence.entities.Ticket.naturalKey = ['subject'];
      ops(d).createTicket.idempotency = { keySource: 'payload-field', keyField: 'requesterEmail' };
    },
    expect: ['CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL']
  },
  // ─── DSL 2.18: el plazo de un rescate, enlazado a un parámetro ────────────────
  // El base no tiene barridos: closeTicket no declara schedule, así que cada mutación dispara ese
  // motivo una vez, más el suyo propio si lo tiene (de ahí las repeticiones).
  {
    id: 'M-USECASES-STALLED-AFTER-NO-SWEEP',
    title: 'un plazo de rescate en una operación que no es un barrido',
    mutate: (d) => {
      d.manifest.parameters = {
        closeAfterMinutes: { type: 'int', description: 'Minutos hasta cerrar.', default: 15, testValue: 15, requiredInProduction: false }
      };
      ops(d).closeTicket.transitions[0].stalledAfter = { parameter: 'closeAfterMinutes', unit: 'minutes' };
    },
    expect: ['CHK-USECASES-STALLED-AFTER-INVALID']
  },
  {
    id: 'M-USECASES-STALLED-AFTER-UNKNOWN-PARAM',
    title: 'el plazo de un rescate nombra un parámetro que el manifiesto no declara',
    mutate: (d) => {
      ops(d).closeTicket.transitions[0].stalledAfter = { parameter: 'noExiste', unit: 'minutes' };
    },
    expect: ['CHK-USECASES-STALLED-AFTER-INVALID', 'CHK-USECASES-STALLED-AFTER-INVALID']
  },
  {
    id: 'M-USECASES-STALLED-AFTER-NOT-INT',
    title: 'el plazo de un rescate nombra un parámetro que no es entero',
    mutate: (d) => {
      d.manifest.parameters = {
        closeAfter: { type: 'string', description: 'Un texto cualquiera.', default: 'x', testValue: 'x', requiredInProduction: false }
      };
      ops(d).closeTicket.transitions[0].stalledAfter = { parameter: 'closeAfter', unit: 'minutes' };
    },
    expect: ['CHK-USECASES-STALLED-AFTER-INVALID', 'CHK-USECASES-STALLED-AFTER-INVALID']
  },
  {
    id: 'M-USECASES-IDEM-PARTITION-UNKNOWN',
    title: 'el ámbito de la clave nombra un campo que la operación no recibe',
    mutate: (d) => {
      withClientKey(d, ['required', 'race', 'reuse']);
      ops(d).createTicket.idempotency.partitionBy = ['tenantId'];
    },
    expect: ['CHK-USECASES-IDEM-PARTITION-UNKNOWN']
  },
  {
    id: 'M-MSG-IDENTITY-RESOLVEDBY-UNDECIDED',
    title: 'HTTP resuelve la identidad 1:N y la suscripción no dice contra qué',
    extends: 'm2m',
    mutate: (d) => {
      // La credencial de un bot es una de varias de su cola: resolvedBy por HTTP.
      entity(d, 'Queue').fields.botKeys = { type: 'string', list: true, description: 'Credenciales de los bots de la cola.' };
      d.layers.security.authentication.callerIdentity.from.resolvedBy = 'Queue.botKeys';
      // Y la misma identidad llega por el broker, leída de la envoltura, sin resolvedBy.
      ops(d).noteEscalation.input.fields.requestedBy = { type: 'string' };
      d.layers.messaging.subscriptions.TicketEscalated.identity = {
        field: 'requestedBy',
        from: { location: 'field', name: 'metadata.source' },
        onUnresolved: 'deadLetter',
        trustedPublishers: 'Solo publica el equipo de guardia, autenticado ante el broker.'
      };
    },
    expect: ['CHK-MSG-IDENTITY-RESOLVEDBY-UNDECIDED']
  },
  {
    id: 'M-SEC-SERVICE-NO-SCOPES',
    title: 'una regla level: service sin scopes',
    extends: 'm2m',
    mutate: (d) => {
      d.layers.api.endpoints.getTicket.audience = 'services';
      d.layers.security.access.rules.getTicket = { level: 'service' };
      delete d.layers.security.serviceClients['oncall-bot'].scopes;
    },
    expect: ['CHK-SEC-SERVICE-NO-SCOPES']
  },
  {
    id: 'M-SEC-SERVICES-PUBLIC',
    title: 'un endpoint para máquinas con una regla pública',
    extends: 'm2m',
    mutate: (d) => {
      d.layers.api.endpoints.getTicket.audience = 'services';
      d.layers.security.access.rules.getTicket = { level: 'public' };
      delete d.layers.security.serviceClients['oncall-bot'].scopes;
    },
    expect: ['CHK-SEC-SERVICES-PUBLIC']
  },
  {
    id: 'M-SEC-CLIENTS-NO-MACHINE-ENDPOINT',
    title: 'clientes máquina declarados y ningún endpoint para ellos',
    extends: 'm2m',
    mutate: (d) => {
      delete d.layers.api.endpoints.getTicket.audience;
      delete d.layers.security.access.rules.getTicket.scopes;
      delete d.layers.security.serviceClients['oncall-bot'].scopes;
    },
    expect: ['CHK-SEC-CLIENTS-NO-MACHINE-ENDPOINT']
  },
  {
    id: 'M-SEC-CLIENT-SCOPE-UNUSED',
    title: 'un cliente máquina con un scope que ninguna regla exige',
    extends: 'm2m',
    mutate: (d) => {
      d.layers.security.permissions['ticket:export'] = { description: 'Exportar tickets.' };
      d.layers.security.serviceClients['oncall-bot'].scopes.push('ticket:export');
    },
    expect: ['CHK-SEC-CLIENT-SCOPE-UNUSED']
  },
  {
    id: 'M-SEC-SCOPE-UNGRANTED',
    title: 'un scope exigido que no tiene ningún cliente',
    extends: 'm2m',
    mutate: (d) => {
      delete d.layers.security.serviceClients['oncall-bot'].scopes;
    },
    expect: ['CHK-SEC-SCOPE-UNGRANTED']
  },
  {
    id: 'M-SCEN-UNDECLARED-CLIENT',
    title: 'un escenario nombra un cliente máquina que no existe',
    mutate: (d) =>
      replaceIn(d, '**Then** responde 200 con el ticket.', '**Then** responde 200 con el ticket, también con la credencial de máquina del cliente `billing`.'),
    expect: ['CHK-SCEN-UNDECLARED-CLIENT']
  },
  {
    id: 'M-SCEN-UNDECLARED-ROLE',
    title: 'un escenario nombra un rol que no existe',
    mutate: (d) =>
      replaceIn(d, '**Then** llegan ordenados por asunto.', '**Then** llegan ordenados por asunto, también para el rol `supervisor`.'),
    expect: ['CHK-SCEN-UNDECLARED-ROLE']
  },

  // ─── R5, tanda C: persistence, storage y mail ───────────────────────────────
  {
    id: 'M-PERSIST-COMPUTED-NATURAL-KEY',
    title: 'la naturalKey de una hija sobre un campo computed',
    mutate: (d) => {
      entity(d, 'TicketNote').fields.position = { type: 'int', computed: 'posición de la nota en la colección' };
      d.layers.persistence.entities.TicketNote = { naturalKey: ['position'] };
    },
    expect: ['CHK-PERSIST-COMPUTED-NATURAL-KEY']
  },
  {
    id: 'M-PERSIST-DECLARED-NO-LOCKVERSION',
    title: "optimisticLocking: declared sin ninguna raíz con lockVersion",
    mutate: (d) => {
      d.layers.persistence.consistency.optimisticLocking = 'declared';
      // El code del conflicto nombrado (y con escenario): si no, se abriría OBL-CONCURRENCY-CODE.
      ops(d).closeTicket.errors.push({ code: 'CONCURRENT_MODIFICATION', when: 'Otro agente cerró el ticket a la vez.', http: 409 });
      replaceIn(d, 'y sale un correo al solicitante.', 'y sale un correo al solicitante; un cierre simultáneo da 409 con `CONCURRENT_MODIFICATION`.');
    },
    expect: ['CHK-PERSIST-DECLARED-NO-LOCKVERSION']
  },
  {
    id: 'M-STORAGE-BUCKET-UNUSED',
    title: 'un bucket que ningún campo file usa',
    mutate: (d) => {
      d.layers.storage.buckets.exports = {
        visibility: 'private',
        allowedContentTypes: ['text/csv'],
        maxSizeMb: 5,
        signedUrlTtlSeconds: 300,
        description: 'Exportaciones de tickets.'
      };
    },
    expect: ['CHK-STORAGE-BUCKET-UNUSED']
  },
  {
    id: 'M-STORAGE-NO-SIGNED-TTL',
    title: 'un bucket private sin caducidad del enlace firmado',
    mutate: (d) => {
      delete d.layers.storage.buckets.ticketAttachments.signedUrlTtlSeconds;
    },
    expect: ['CHK-STORAGE-NO-SIGNED-TTL']
  },
  {
    id: 'M-MAIL-OP-UNGUARDED',
    title: 'una operación sin guarda que manda correo',
    mutate: (d) => {
      d.layers.mail.sentBy.push('createTicket');
    },
    expect: ['CHK-MAIL-OP-UNGUARDED']
  },
  {
    id: 'M-MAIL-SENDER-NO-FALLBACK',
    title: 'remitente sacado de un dato y sin respaldo',
    mutate: (d) => {
      d.layers.mail.sender = { source: 'data', description: 'Cada cola tiene su remitente.' };
    },
    expect: ['CHK-MAIL-SENDER-NO-FALLBACK']
  },
  {
    id: 'M-MAIL-HTML-NO-TEXT',
    title: 'correo html sin alternativa de texto',
    mutate: (d) => {
      d.layers.mail.delivery.parts = ['html'];
    },
    expect: ['CHK-MAIL-HTML-NO-TEXT']
  },
  {
    id: 'M-MAIL-NO-DECLARED-VARIABLES',
    title: 'plantillas como dato sin variables declaradas',
    mutate: (d) => {
      d.layers.mail.templating = { source: 'data' };
    },
    expect: ['CHK-MAIL-NO-DECLARED-VARIABLES']
  },

  // ─── R5, tanda D: messaging y las señales de mecanismo en los escenarios ──────
  {
    id: 'M-SCEN-OUTBOX-UNAVAILABLE',
    title: 'outbox sin el escenario del canal caído',
    extends: 'outbox',
    mutate: (d) => replaceIn(d, '**Given** un ticket en `open` y el broker detenido.', '**Given** un ticket en `open`.'),
    expect: ['CHK-SCEN-OUTBOX-UNAVAILABLE']
  },
  {
    id: 'M-SCEN-OUTBOX-EXHAUSTED',
    title: 'outbox sin el escenario del relay que se rinde',
    extends: 'outbox',
    mutate: (d) => {
      replaceIn(d, '#### FL-OBX-001-B: el relay se rinde', '#### FL-OBX-001-B: el relay publica');
      replaceIn(d, 'cuyos reintentos del relay están agotados.', 'pendiente de publicar.');
      replaceIn(d, 'informa del evento abandonado y `TicketClosed` no se publica.', 'publica `TicketClosed` una vez.');
    },
    expect: ['CHK-SCEN-OUTBOX-EXHAUSTED']
  },
  {
    id: 'M-SCEN-RESCUE-UNCOVERED',
    title: 'un barrido que saca filas de un estado en vuelo sin escenario de rescate',
    extends: 'escalation',
    mutate: (d) => {
      // Un segundo barrido sobre `awaitingAck` que NO es la reconciliación de la activación: esa
      // queda fuera de la regla, porque espera a un tercero y no a otra réplica nuestra.
      ops(d).expirePages = {
        description: 'Devuelve a la cola los avisos caducados.',
        kind: 'command',
        input: 'void',
        output: 'void',
        schedule: { cron: '0 * * * *' },
        transitions: [{ entity: 'Ticket', from: ['awaitingAck'], to: 'open' }]
      };
      addMatrixRow(d, '| expirePages | FL-PAG-004 | programada |');
      // Nombrado, y con sus dos réplicas: si no, saltaría también el aviso de clúster.
      insertScenarioBefore(
        d,
        '### FL-ESC-001',
        '### FL-PAG-004: caducidad de avisos\n\n**Given** un ticket en `awaitingAck`, con dos réplicas vivas.\n**When** corre `expirePages`.\n**Then** vuelve a `open` una sola vez.'
      );
    },
    expect: ['CHK-SCEN-RESCUE-UNCOVERED']
  },
  {
    id: 'M-SCEN-RECONCILE-EXPIRED',
    title: 'una reconciliación sin el escenario de la espera agotada',
    extends: 'escalation',
    mutate: (d) =>
      replaceIn(
        d,
        '**Given** un ticket esperando más de diez minutos sin respuesta de la guardia, con dos réplicas vivas.',
        '**Given** un ticket en `awaitingAck`, con dos réplicas vivas.'
      ),
    expect: ['CHK-SCEN-RECONCILE-EXPIRED']
  },
  {
    id: 'M-SCEN-IDEM-RACE',
    title: 'una operación idempotente sin el escenario de la carrera',
    mutate: (d) => {
      withClientKey(d, ['required', 'race', 'reuse']);
      // El título también da la señal («a la vez»): la regla lee el bloque entero.
      replaceIn(d, 'dos altas a la vez con la misma clave', 'dos altas seguidas con la misma clave');
      replaceIn(d, 'dos veces a la vez con esa clave', 'dos veces seguidas con esa clave');
    },
    expect: ['CHK-SCEN-IDEM-RACE']
  },
  {
    id: 'M-SCEN-CLUSTER-UNCOVERED',
    title: 'un barrido cuyo duplicado se vería sin escenario con dos instancias',
    extends: 'escalation',
    mutate: (d) => {
      replaceIn(d, 'sin respuesta de la guardia, con dos réplicas vivas.', 'sin respuesta de la guardia.');
      replaceIn(d, ', una sola vez aunque corran las dos réplicas.', '.');
    },
    expect: ['CHK-SCEN-CLUSTER-UNCOVERED']
  },
  {
    id: 'M-SCEN-REDELIVERY-UNCOVERED',
    title: 'una suscripción con guarda sin el escenario de reentrega',
    mutate: (d) => {
      replaceIn(d, '#### FL-ESC-001-B: reentrega de la escalada', '#### FL-ESC-001-B: segunda escalada');
      replaceIn(d, '**When** se reentrega el mismo mensaje.', '**When** llega otra escalada del ticket.');
      replaceIn(d, '**Then** no hay segundo efecto: el nivel de escalada no cambia.', '**Then** el nivel de escalada sube.');
    },
    expect: ['CHK-SCEN-REDELIVERY-UNCOVERED']
  },
  {
    id: 'M-MSG-PUBLISH-EXTERNAL',
    title: 'se publica en un canal que posee otro sistema',
    mutate: (d) => {
      const messaging = d.layers.messaging;
      messaging.channels.directoryFeed = { description: 'Canal del directorio corporativo.', external: true };
      messaging.publishing.events.TicketClosed.channel = 'directoryFeed';
    },
    expect: ['CHK-MSG-PUBLISH-EXTERNAL']
  },
  {
    id: 'M-MSG-SHARED-CHANNEL-NO-DISCRIMINATOR',
    title: 'dos suscripciones en un canal y una sin envoltura ni discriminator',
    mutate: (d) => {
      d.layers.messaging.subscriptions.TicketPriorityRaised = {
        description: 'Un sistema externo sube la prioridad de un ticket.',
        source: 'oncall',
        nature: 'request',
        channel: 'ticketEvents',
        payload: { ticketId: { type: 'uuid', required: true }, level: { type: 'int', required: true } },
        contract: { envelope: 'none' },
        triggers: 'noteEscalation',
        input: { ticketId: 'ticketId', level: 'level' },
        // Sin reintentos: sin envoltura ni messageId no hay guarda, y reintentar sería error.
        onFailure: { deadLetter: true }
      };
    },
    expect: ['CHK-MSG-SHARED-CHANNEL-NO-DISCRIMINATOR']
  },
  {
    id: 'M-MSG-EXTERNAL-NO-CONTRACT',
    title: 'una suscripción a un canal external sin contract',
    mutate: (d) => {
      const messaging = d.layers.messaging;
      messaging.channels.oncallRequests = { description: 'Peticiones del equipo de guardia.', external: true };
      const sub = messaging.subscriptions.TicketEscalated;
      sub.channel = 'oncallRequests';
      delete sub.contract;
      sub.onFailure = { deadLetter: true };
    },
    expect: ['CHK-MSG-EXTERNAL-NO-CONTRACT']
  },
  {
    id: 'M-MSG-KEEL-MESSAGEID',
    title: 'contract.messageId con envoltura keel',
    mutate: (d) => {
      d.layers.messaging.subscriptions.TicketEscalated.contract.messageId = { location: 'field', name: 'ticketId' };
    },
    expect: ['CHK-MSG-KEEL-MESSAGEID']
  },
  {
    id: 'M-MSG-CONTRACT-FIELD-ASSUMED',
    title: 'un discriminator de campo que no está en el payload de una envoltura propia',
    mutate: (d) => {
      const sub = d.layers.messaging.subscriptions.TicketEscalated;
      sub.contract = {
        envelope: 'wrapped',
        payloadPath: 'data',
        discriminator: { location: 'field', name: 'meta.type', value: 'ticket.escalated' }
      };
      sub.onFailure = { deadLetter: true };
    },
    expect: ['CHK-MSG-CONTRACT-FIELD-ASSUMED']
  },
  {
    id: 'M-MSG-PAYLOAD-FIELD-UNUSED',
    title: 'un campo del payload que no alimenta el input',
    mutate: (d) => {
      d.layers.messaging.subscriptions.TicketEscalated.payload.note = { type: 'string' };
    },
    expect: ['CHK-MSG-PAYLOAD-FIELD-UNUSED']
  },
  {
    id: 'M-MSG-EVENT-NOT-EMITTED',
    title: 'un evento publicado que nadie emite',
    mutate: (d) => {
      d.layers.messaging.publishing.events.TicketReopened = {
        channel: 'ticketEvents',
        description: 'Un ticket se reabrió.',
        payload: { ticketId: { type: 'uuid', required: true } }
      };
    },
    expect: ['CHK-MSG-EVENT-NOT-EMITTED']
  },
  {
    id: 'M-MSG-CHANNEL-UNUSED',
    title: 'un canal que nadie referencia',
    mutate: (d) => {
      d.layers.messaging.channels.auditTrail = { description: 'Rastro de auditoría.' };
    },
    expect: ['CHK-MSG-CHANNEL-UNUSED']
  },

  // ─── R5, tanda E: http-clients y dependencies ───────────────────────────────
  {
    id: 'M-HTTP-PATH-NO-PARAMS',
    title: 'un path con variables sin request.pathParams',
    mutate: (d) => {
      delete d.layers['http-clients'].clients.directory.calls.getProfile.request;
    },
    expect: ['CHK-HTTP-PATH-NO-PARAMS']
  },
  {
    id: 'M-HTTP-TYPED-NO-ROUTE',
    title: 'una respuesta tipada sin method ni path',
    mutate: (d) => {
      const call = d.layers['http-clients'].clients.directory.calls.getProfile;
      delete call.request;
      delete call.method;
      delete call.path;
    },
    expect: ['CHK-HTTP-TYPED-NO-ROUTE']
  },
  {
    id: 'M-HTTP-BREAKER-NO-FALLBACK',
    title: 'un circuitBreaker sin fallback',
    mutate: (d) => {
      d.layers['http-clients'].clients.directory.calls.getProfile.circuitBreaker = {
        failureRateThreshold: 50,
        slidingWindowSize: 10,
        waitDurationMs: 20000
      };
    },
    expect: ['CHK-HTTP-BREAKER-NO-FALLBACK']
  },
  {
    id: 'M-HTTP-RETRY-UNSAFE',
    title: 'se reintenta un POST ajeno sin idempotency',
    extends: 'escalation',
    mutate: (d) => {
      d.layers['http-clients'].clients.pager.calls.page.retry = {
        maxAttempts: 3,
        backoff: 'exponential',
        initialDelayMs: 200,
        retryOn: ['timeout']
      };
    },
    expect: ['CHK-HTTP-RETRY-UNSAFE']
  },
  {
    id: 'M-HTTP-IDEMPOTENCY-ON-GET',
    title: 'idempotency en una llamada GET',
    mutate: (d) => {
      d.layers['http-clients'].clients.directory.calls.getProfile.idempotency = { keyFrom: 'payload-hash' };
    },
    expect: ['CHK-HTTP-IDEMPOTENCY-ON-GET']
  },
  {
    id: 'M-HTTP-CLIENT-UNUSED',
    title: 'un cliente HTTP que ninguna dependencia usa',
    mutate: (d) => {
      d.layers['http-clients'].clients.billing = {
        purpose: 'Consultar facturas.',
        calls: { getInvoice: { contract: 'GET /invoices devuelve las facturas.', method: 'GET', path: '/invoices', timeoutMs: 1000 } }
      };
    },
    expect: ['CHK-HTTP-CLIENT-UNUSED']
  },
  {
    id: 'M-DEPS-EXPOSED-ON-DEMAND-LIST',
    title: 'un dato on-demand expuesto en un listado',
    mutate: (d) => {
      const need = d.layers.dependencies.dependencies.directory.needs.requesterProfile;
      need.usedBy = ['getTicket', 'listTickets'];
      need.exposedAs = 'requesterName';
    },
    expect: ['CHK-DEPS-EXPOSED-ON-DEMAND-LIST']
  },
  {
    id: 'M-DEPS-REPLICA-KEY-NOT-UNIQUE',
    title: 'el keyField de una réplica no es unique',
    extends: 'replica',
    mutate: (d) => {
      delete entity(d, 'Requester').fields.email.unique;
    },
    expect: ['CHK-DEPS-REPLICA-KEY-NOT-UNIQUE']
  },
  {
    id: 'M-DEPS-REPLICA-UNPERSISTED',
    title: 'la entidad de una réplica sin persistencia',
    extends: 'replica',
    mutate: (d) => {
      delete d.layers.persistence.entities.Requester;
    },
    // Co-disparado a propósito: una réplica es la raíz de su agregado, y una raíz sin almacén es
    // también CHK-PERSIST-ROOT-UNMAPPED. Aislarlo exigiría hacer de la réplica una entidad
    // interna de otro agregado, que es retorcer el diseño para contentar al corpus.
    expect: ['CHK-DEPS-REPLICA-UNPERSISTED', 'CHK-PERSIST-ROOT-UNMAPPED']
  },
  {
    id: 'M-DEPS-REPLICA-DUPLICATED',
    title: 'dos needs replican la misma entidad',
    extends: 'replica',
    mutate: (d) => {
      const needs = d.layers.dependencies.dependencies.directory.needs;
      needs.requesterMirror = structuredClone(needs.requesterCopy);
    },
    expect: ['CHK-DEPS-REPLICA-DUPLICATED']
  },
  {
    id: 'M-DEPS-ERROR-NOT-IN-OPS',
    title: 'el error de un need que no declara ninguna de sus operaciones',
    mutate: (d) => {
      d.layers.dependencies.dependencies.directory.needs.requesterProfile.onUnavailable.error = 'QUEUE_NOT_FOUND';
    },
    expect: ['CHK-DEPS-ERROR-NOT-IN-OPS']
  },
  {
    id: 'M-DEPS-SOURCE-MISMATCH',
    title: 'una réplica alimentada por un evento de otro source',
    extends: 'replica',
    mutate: (d) => {
      Object.assign(d.layers.messaging.subscriptions.RequesterUpdated, { source: 'oncall', nature: 'request' });
    },
    expect: ['CHK-DEPS-SOURCE-MISMATCH']
  },
  {
    id: 'M-DEPS-PUBLISH-WITHOUT-OUTBOX',
    title: 'un encargo publicado con reliability best-effort',
    mutate: (d) => {
      d.layers.dependencies.dependencies.directory.activations = {
        announceClosure: {
          description: 'Aviso del cierre al directorio.',
          triggeredBy: ['closeTicket'],
          via: { publishes: 'TicketClosed' },
          effect: 'El directorio sabe que el ticket del solicitante está cerrado.',
          awaits: 'acknowledgement'
        }
      };
    },
    expect: ['CHK-DEPS-PUBLISH-WITHOUT-OUTBOX']
  },
  {
    id: 'M-DEPS-NO-UNANSWERED-AFTER',
    title: 'una reconciliación sin umbral de silencio',
    extends: 'escalation',
    mutate: (d) => {
      delete d.layers.dependencies.dependencies.pager.activations.pageOncall.unansweredAfterSeconds;
    },
    expect: ['CHK-DEPS-NO-UNANSWERED-AFTER']
  },
  {
    id: 'M-DEPS-RECONCILE-NO-WAIT-STATE',
    title: 'una reconciliación de un encargo que no deja nada esperando',
    extends: 'escalation',
    mutate: (d) => {
      d.layers.dependencies.dependencies.pager.activations.pageOncall.triggeredBy = ['getTicket'];
    },
    expect: ['CHK-DEPS-RECONCILE-NO-WAIT-STATE']
  },
  {
    id: 'M-DEPS-AWAITING-CREATEDAT',
    title: 'la marca de espera es createdAt',
    extends: 'escalation',
    mutate: (d) => {
      entity(d, 'Ticket').fields.createdAt = { type: 'timestamp', generated: true };
      d.layers.persistence.audit.timestamps = 'declared';
      d.layers.dependencies.dependencies.pager.activations.pageOncall.awaitingSince = 'createdAt';
    },
    expect: ['CHK-DEPS-AWAITING-CREATEDAT']
  },
  {
    id: 'M-DEPS-RECONCILE-UNLINKED',
    title: 'un barrido de reconciliación que no toca lo que reconcilia',
    // Con la compensación: su `abandonEscalation` sigue ejecutando awaitingAck → open, así que
    // quitarle la transición al barrido no deja la arista sin nadie que la recorra.
    extends: 'compensation',
    mutate: (d) => {
      const sweep = ops(d).sweepPages;
      delete sweep.transitions;
      sweep.emits = ['TicketClosed'];
    },
    expect: ['CHK-DEPS-RECONCILE-UNLINKED']
  },
  {
    id: 'M-DEPS-RECONCILE-NO-INDEX',
    title: 'el barrido busca por un estado que ningún índice encabeza',
    extends: 'escalation',
    mutate: (d) => {
      d.layers.persistence.entities.Ticket.indexes = [['requesterEmail', 'status']];
    },
    expect: ['CHK-DEPS-RECONCILE-NO-INDEX']
  },
  {
    id: 'M-SCEN-COMPENSATION-UNCOVERED',
    title: 'una compensación cuyo evento no nombra ningún escenario',
    extends: 'compensation',
    mutate: (d) => {
      replaceIn(d, '**When** llega `PageRejected`.', '**When** llega el rechazo de la guardia.');
      replaceIn(d, '**Given** el mismo `PageRejected` del flujo anterior.', '**Given** el mismo rechazo del flujo anterior.');
    },
    expect: ['CHK-SCEN-COMPENSATION-UNCOVERED']
  },
  {
    id: 'M-SCEN-COMPENSATION-NO-REDELIVERY',
    title: 'una compensación sin el escenario de reentrega',
    extends: 'compensation',
    mutate: (d) => {
      replaceIn(d, '#### FL-PAG-003-B: rechazo reentregado y simultáneo', '#### FL-PAG-003-B: rechazo simultáneo');
      replaceIn(d, '**When** se reentrega el mismo mensaje y, en otra prueba, se entrega dos veces a la vez.', '**When** llegan dos rechazos a la vez.');
      replaceIn(d, '**Then** no hay segundo efecto.', '**Then** el ticket queda en `open`.');
    },
    expect: ['CHK-SCEN-COMPENSATION-NO-REDELIVERY']
  },
  {
    id: 'M-SCEN-COMPENSATION-NO-CONCURRENT',
    title: 'una compensación sin el escenario de la doble entrega simultánea',
    extends: 'compensation',
    mutate: (d) => {
      replaceIn(d, '#### FL-PAG-003-B: rechazo reentregado y simultáneo', '#### FL-PAG-003-B: rechazo reentregado');
      replaceIn(d, '**When** se reentrega el mismo mensaje y, en otra prueba, se entrega dos veces a la vez.', '**When** se reentrega el mismo mensaje.');
    },
    expect: ['CHK-SCEN-COMPENSATION-NO-CONCURRENT']
  },
  {
    id: 'M-DEPS-COMPENSATION-EXTERNAL-NO-MESSAGEID',
    title: 'una compensación sobre canal externo guardada solo por el lifecycle',
    extends: 'compensation',
    mutate: (d) => {
      const messaging = d.layers.messaging;
      messaging.channels.pagerEvents = { description: 'Canal del servicio de guardias.', external: true };
      Object.assign(messaging.subscriptions.PageRejected, { channel: 'pagerEvents', contract: { envelope: 'none' } });
    },
    expect: ['CHK-DEPS-COMPENSATION-EXTERNAL-NO-MESSAGEID']
  },
  {
    id: 'M-DEPS-COMPENSATION-NO-RETRY',
    title: 'la suscripción de una compensación sin reintentos',
    extends: 'compensation',
    mutate: (d) => {
      d.layers.messaging.subscriptions.PageRejected.onFailure = { deadLetter: true };
    },
    expect: ['CHK-DEPS-COMPENSATION-NO-RETRY']
  },
  {
    id: 'M-DEPS-COMPENSATION-SILENCE',
    title: 'un encargo compensado sin reconciliación',
    extends: 'compensation',
    mutate: (d) => {
      const activation = d.layers.dependencies.dependencies.pager.activations.pageOncall;
      delete activation.reconciledBy;
      delete activation.unansweredAfterSeconds;
      delete activation.awaitingSince;
      // Sin DLQ: si no, saltaría también el aviso de la DLQ sin reejecución, que se mide aparte.
      d.layers.messaging.subscriptions.PageRejected.onFailure.deadLetter = false;
      // `sweepPages` deja de ser la reconciliación y pasa a ser un rescate: que lo diga.
      replaceIn(d, 'un ticket esperando más de diez minutos', 'un ticket atascado esperando más de diez minutos');
    },
    expect: ['CHK-DEPS-COMPENSATION-SILENCE']
  },
  {
    id: 'M-DEPS-COMPENSATION-DLQ-NO-RERUN',
    title: 'lo que una compensación manda a la DLQ no tiene cómo reejecutarse',
    extends: 'compensation',
    mutate: (d) => {
      // Una compensación sin `undoes`, en una dependencia sin activaciones: el único sitio donde
      // este aviso no llega acompañado del de la reconciliación que falta.
      const deps = d.layers.dependencies.dependencies;
      deps.directory.compensations = deps.pager.compensations.map(({ onEvent, description }) => ({ onEvent, description }));
      delete deps.pager.compensations;
    },
    expect: ['CHK-DEPS-COMPENSATION-DLQ-NO-RERUN']
  },
  {
    id: 'M-DEPS-COMPENSATION-NO-RESTORE',
    title: 'una compensación que no devuelve el estado que movió el encargo',
    extends: 'compensation',
    mutate: (d) => {
      delete ops(d).abandonEscalation.transitions;
    },
    expect: ['CHK-DEPS-COMPENSATION-NO-RESTORE']
  },
  {
    id: 'M-DEPS-COMPENSATION-PROVIDER-UNTOLD',
    title: 'el fallo lo publica un tercero y nadie se lo dice al proveedor',
    extends: 'compensation',
    mutate: (d) => {
      Object.assign(d.layers.messaging.subscriptions.PageRejected, { source: 'oncall', nature: 'request' });
    },
    expect: ['CHK-DEPS-COMPENSATION-PROVIDER-UNTOLD']
  },
  {
    id: 'M-DEPS-SAGA-INCOMPLETE',
    title: 'una operación que encarga a dos proveedores y solo compensa uno',
    extends: 'compensation',
    mutate: (d) => {
      d.layers.dependencies.dependencies.directory.activations = {
        flagRequester: {
          description: 'Marca al solicitante como escalado en el directorio.',
          triggeredBy: ['escalateTicket'],
          via: { client: 'directory', call: 'getProfile' },
          effect: 'El directorio sabe que el solicitante tiene un ticket escalado.',
          awaits: 'acknowledgement',
          onFailure: { action: 'ignore' }
        }
      };
    },
    expect: ['CHK-DEPS-SAGA-INCOMPLETE']
  },
  {
    id: 'M-MSG-SOURCE-UNDECLARED',
    title: 'una suscripción fact cuyo source no es una dependencia',
    mutate: (d) => {
      delete d.layers.messaging.subscriptions.TicketEscalated.nature;
    },
    expect: ['CHK-MSG-SOURCE-UNDECLARED']
  },

  // ─── payments ────────────────────────────────────────────────────────────────────
  {
    id: 'M-PAYMENTS-OP-UNKNOWN',
    title: 'la operación de captura de la capa payments no existe',
    extends: 'payments',
    mutate: (d) => {
      d.layers.payments.capture.operation = 'capturePriorityChargeLater';
    },
    expect: ['CHK-PAYMENTS-OP-UNKNOWN']
  },
  {
    id: 'M-PAYMENTS-FLOW-MISMATCH',
    title: 'authorize-capture sin operación de captura',
    extends: 'payments',
    mutate: (d) => {
      delete d.layers.payments.capture;
      // La operación sigue existiendo con su endpoint: solo se le quita su papel en la capa.
    },
    expect: ['CHK-PAYMENTS-FLOW-MISMATCH']
  },
  {
    id: 'M-PAYMENTS-CAPABILITY-UNBACKED',
    title: 'una devolución parcial sin declarar la capacidad partial-refund',
    extends: 'payments',
    mutate: (d) => {
      d.layers.payments.capabilities = ['customer-action', 'off-session'];
    },
    expect: ['CHK-PAYMENTS-CAPABILITY-UNBACKED']
  },
  {
    id: 'M-PAYMENTS-FIELD-UNKNOWN',
    title: 'el importe del cobro es un entero, no un decimal',
    extends: 'payments',
    mutate: (d) => {
      ops(d).requestPriorityCharge.input.fields.amount.type = 'long';
      d.layers.messaging.subscriptions.PriorityChargeRequested.payload.amount.type = 'long';
    },
    expect: ['CHK-PAYMENTS-FIELD-UNKNOWN']
  },
  {
    id: 'M-PAYMENTS-RECORD-UNKNOWN',
    title: 'la marca de espera del registro no es una marca de tiempo',
    extends: 'payments',
    mutate: (d) => {
      d.layers.payments.record.awaitingSince = 'currency';
    },
    expect: ['CHK-PAYMENTS-RECORD-UNKNOWN']
  },
  {
    id: 'M-PAYMENTS-FAILURE-VOCABULARY',
    title: 'el motivo de fallo con un valor propio en vez del vocabulario neutro',
    extends: 'payments',
    mutate: (d) => {
      d.layers.domain.types.PaymentFailureReason.values.push('cardBlockedByIssuer');
    },
    expect: ['CHK-PAYMENTS-FAILURE-VOCABULARY']
  },
  {
    id: 'M-PAYMENTS-INFLIGHT-INVALID',
    title: 'la captura declara como suyo el estado en vuelo de la devolución',
    extends: 'payments',
    mutate: (d) => {
      // Apunta al estado en vuelo de OTRA acción: la captura no entra en él y su desenlace no
      // sale de él, así que una captura cuya respuesta se pierda no la encuentra el barrido.
      d.layers.payments.capture.inFlight = 'refunding';
    },
    expect: ['CHK-PAYMENTS-INFLIGHT-INVALID', 'CHK-PAYMENTS-INFLIGHT-INVALID']
  },
  {
    id: 'M-PAYMENTS-REFERENCE-UNGUARDED',
    title: 'la referencia del cobro fuera de la clave natural del registro',
    extends: 'payments',
    mutate: (d) => {
      delete d.layers.persistence.entities.Payment.naturalKey;
    },
    expect: ['CHK-PAYMENTS-REFERENCE-UNGUARDED']
  },
  {
    id: 'M-PAYMENTS-ASYNC-NEEDS-OFF-SESSION',
    title: 'el cobro entra por evento y la capa no puede cobrar sin el cliente',
    extends: 'payments',
    mutate: (d) => {
      const payments = d.layers.payments;
      payments.capabilities = ['partial-refund', 'customer-action'];
      delete payments.savePaymentMethod;
      delete payments.charge.source.saved;
      // `savePaymentMethod` deja de ser pieza de la capa pero sigue siendo una operación con endpoint.
    },
    expect: ['CHK-PAYMENTS-ASYNC-NEEDS-OFF-SESSION']
  },
  {
    id: 'M-PAYMENTS-OUTCOME-SILENT',
    title: 'el cobro se pide por evento y su rechazo no se publica',
    extends: 'payments',
    mutate: (d) => {
      delete ops(d).markFailed.emits;
      delete d.layers.messaging.publishing.events.PriorityChargeFailed;
      replaceIn(d, ' y se publica `PriorityChargeFailed`', '');
    },
    expect: ['CHK-PAYMENTS-OUTCOME-SILENT']
  },
  {
    id: 'M-PAYMENTS-OUTCOME-NO-TRANSITION',
    title: 'la operación de un desenlace no mueve el lifecycle del registro',
    extends: 'payments',
    mutate: (d) => {
      // Mueve otra cosa: la cola del ticket. Sin transiciones dispararía también el aviso de la
      // operación que no deja rastro; y la transición a `canceled` la sigue ejecutando alguien
      // (la captura, aquí), o saltaría el de la transición del lifecycle que nadie ejecuta.
      ops(d).markCanceled.transitions = [{ entity: 'Queue', from: ['active'], to: 'archived' }];
      ops(d).capturePriorityCharge.transitions.push({ entity: 'Payment', from: ['authorized'], to: 'canceled' });
    },
    expect: ['CHK-PAYMENTS-OUTCOME-NO-TRANSITION']
  },
  {
    id: 'M-PAYMENTS-OUTCOME-EXPOSED',
    title: 'la operación que registra la captura tiene puerta propia',
    extends: 'payments',
    mutate: (d) => {
      delete ops(d).markCaptured.internal;
      ops(d).markCaptured.errors = [{ code: 'PAYMENT_NOT_FOUND', when: 'No hay cobro con esa referencia.', http: 404 }];
      d.layers.api.endpoints.markCaptured = {
        method: 'POST',
        path: '/priority-charges/{chargeRequestId}/captured',
        successStatus: 204
      };
    },
    expect: ['CHK-PAYMENTS-OUTCOME-EXPOSED']
  },
  {
    id: 'M-PAYMENTS-OUTCOME-INPUT-UNBACKED',
    title: 'el desenlace de la anulación recibe un motivo que la capa no nombra',
    extends: 'payments',
    mutate: (d) => {
      ops(d).markCanceled.input.fields.cancelNote = { type: 'string', constraints: { maxLength: 200 } };
    },
    expect: ['CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED']
  },
  {
    id: 'M-PAYMENTS-OUTCOME-MISSING',
    title: 'una devolución sin la operación que registra su desenlace',
    extends: 'payments',
    mutate: (d) => {
      delete d.layers.payments.outcomes.refunded;
      // `markRefunded` sigue siendo internal y con escenario: solo deja de estar enlazada.
    },
    expect: ['CHK-PAYMENTS-OUTCOME-MISSING']
  },
  {
    id: 'M-PAYMENTS-SWEEP-INVALID',
    title: 'el barrido de los cobros en duda no lo dispara el reloj',
    extends: 'payments',
    mutate: (d) => {
      delete ops(d).sweepPendingCharges.schedule;
      ops(d).sweepPendingCharges.internal = true;
    },
    expect: ['CHK-PAYMENTS-SWEEP-INVALID']
  },
  {
    id: 'M-PAYMENTS-FOLLOWUP-REJECTED',
    title: 'la captura no dice qué pasa cuando la pasarela contesta que no',
    extends: 'payments',
    mutate: (d) => {
      delete d.layers.payments.capture.onRejected;
    },
    expect: ['OBL-PAYMENTS-FOLLOWUP-REJECTED']
  },
  {
    id: 'M-PAYMENTS-REJECTED-ERROR-UNKNOWN',
    title: 'el rechazo de la captura responde con un error que la operación no declara',
    extends: 'payments',
    mutate: (d) => {
      d.layers.payments.capture.onRejected = { error: 'CAPTURE_REJECTED' };
    },
    expect: ['CHK-PAYMENTS-REJECTED-ERROR-UNKNOWN']
  },
  {
    id: 'M-PAYMENTS-REFERENCE-REUSED',
    title: 'el cobro por evento no dice qué se hace con un mensaje distinto de la misma referencia',
    extends: 'payments',
    mutate: (d) => {
      delete d.layers.messaging.subscriptions.PriorityChargeRequested.onFailure.acknowledgeOn;
    },
    expect: ['OBL-PAYMENTS-REFERENCE-REUSED']
  },
  {
    id: 'M-MSG-ACK-CODE-UNKNOWN',
    title: 'la suscripción confirma un error que la operación disparada no puede dar',
    extends: 'payments',
    mutate: (d) => {
      d.layers.messaging.subscriptions.PriorityChargeRequested.onFailure.acknowledgeOn = ['CHARGE_DUPLICATED'];
    },
    expect: ['CHK-MSG-ACK-CODE-UNKNOWN']
  }
];

/**
 * Los ids que este corpus NO puede ver, y por qué. El runner evalúa `checkCrossRefs` en
 * memoria; estos los emite `validateService` fuera de ese módulo, a partir de archivos que un
 * diseño en memoria no tiene (los contratos derivados de `docs/`, el `flow-review.yaml`). Los
 * falsa su propio test, con un derivado saboteado por id.
 */
export const SIN_MUTACION = {
  'CHK-DOCS-OPENAPI-DRIFT': 'lo emite derived-coherence.js contra docs/<servicio>/; lo falsa test/derived-coherence.test.js',
  'CHK-DOCS-ASYNCAPI-DRIFT': 'lo emite derived-coherence.js contra docs/<servicio>/; lo falsa test/derived-coherence.test.js',
  'CHK-DOCS-POSTMAN-DRIFT': 'lo emite derived-coherence.js contra docs/<servicio>/; lo falsa test/derived-coherence.test.js',
  'CHK-SCEN-FLOW-REVIEW-STALE': 'lo emite validate-service.js desde flow-review.yaml; lo falsa test/flow-review.test.js',
  'CHK-SCEN-FLOW-REVIEW-EXHAUSTED': 'lo emite validate-service.js desde flow-review.yaml; lo falsa test/flow-review.test.js'
};
