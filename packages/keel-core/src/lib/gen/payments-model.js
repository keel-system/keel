// La capa payments ya resuelta a la forma que consumen los generadores (src/scaffold/payments*.js).
//
// Vive aparte de model.js por tamaño, pero es parte del mismo modelo: lo cuelga buildModel en
// `model.payments`. Todo lo que dependa de la pasarela ELEGIDA sale del catálogo
// (PAYMENT_GATEWAYS); todo lo que dependa del DISEÑO, de la capa. Nada de una cosa se deduce de
// la otra, que es justo la promesa de la capa: un diseño, cualquier pasarela.

import { FAILURE_REASONS } from '../payment-vocabulary.js';
import { PAYMENT_GATEWAYS } from './infra-catalog.js';
import { pascalCase, screamingSnake } from './naming.js';
import { RECONCILIATION_BATCH_SIZE } from './reconciliation-stores.js';

// Los desenlaces neutros que puede devolver una pasarela. Es el vocabulario del puerto
// (GatewayStatus) y lo traduce cada adaptador; no depende del diseño.
export const GATEWAY_STATUSES = [
  'PENDING',
  'ACTION_REQUIRED',
  'AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'CANCELED',
  'FAILED',
  'NOT_FOUND'
];

// Qué GatewayStatus aplica cada desenlace declarado en `outcomes`.
export const OUTCOME_STATUS = {
  authorized: 'AUTHORIZED',
  actionRequired: 'ACTION_REQUIRED',
  captured: 'CAPTURED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  canceled: 'CANCELED'
};

/** Un decimal escalar (base o value type sobre `decimal`), no una colección de ellos. */
function isDecimalScalar(field) {
  return (field.kind === 'base' || field.kind === 'scalar-vt') && field.base === 'decimal' && !field.list;
}

/**
 * @param layers   las capas del diseño
 * @param stack    el stack resuelto (paymentGateway)
 * @param services los grupos de operaciones ya construidos por buildModel (para los mensajes CQRS)
 * @param entities las entidades ya construidas (para el tipo del motivo de fallo)
 */
export function collectPayments(layers, stack, services, entities, warnings, projection) {
  const payments = layers.payments;
  if (!payments) return null;
  const gateway = PAYMENT_GATEWAYS[stack?.paymentGateway];
  if (!gateway) return null;

  const operationsByName = new Map(services.flatMap((group) => group.operations.map((op) => [op.name, op])));
  const domainEntity = layers.domain?.entities?.[payments.record?.entity] ?? {};
  const recordFields = domainEntity.fields ?? {};
  const failureReasonType = recordFields[payments.record?.failureReason]?.type ?? null;
  const capabilities = payments.capabilities ?? [];

  const followUp = (spec) =>
    spec ? { operation: spec.operation, amount: spec.amount ?? null, inFlight: spec.inFlight ?? null } : null;

  // Las ranuras semánticas de la capa: el nombre que tiene cada dato EN ESTE DISEÑO. Es lo que
  // permite construir los comandos de desenlace sin adivinar —un componente que se llama como
  // `record.gatewayRef` es el id de la pasarela, y así con los demás—.
  const slots = {
    [payments.charge?.reference]: 'reference',
    [payments.record?.gatewayRef]: 'gatewayPaymentId',
    [payments.record?.failureReason]: 'failureReason',
    [payments.record?.customerAction]: 'customerAction'
  };

  // Cómo construye el código generado cada comando de desenlace: un argumento por componente, en
  // su orden. Lo que la capa no nombra (un motivo de anulación propio del diseño, un importe que
  // el desenlace de devolución llama a su manera) sale como TODO explícito en vez de adivinado.
  const outcomeCommands = Object.entries(payments.outcomes ?? {}).map(([outcome, opName]) => {
    const operation = operationsByName.get(opName);
    const components = operation ? [...(operation.pathParams ?? []), ...(operation.bodyFields ?? [])] : [];
    const args = components.map((component) => {
      const slot = slots[component.name];
      if (slot) return { name: component.name, slot, known: true };
      // La misma regla que CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED: en la devolución, el decimal es el
      // importe devuelto. Si las dos dijeran cosas distintas, el diseño que keel validate da por
      // bueno generaría un TODO, o al revés.
      if (outcome === 'refunded' && isDecimalScalar(component)) {
        return { name: component.name, slot: 'refundedAmount', known: true };
      }
      return { name: component.name, slot: null, known: false, ...projection.carryType(component) };
    });
    const unknown = args.filter((arg) => !arg.known).map((arg) => arg.name);
    if (unknown.length > 0) {
      warnings.push(
        `payments: outcomes.${outcome}: '${opName}' recibe ${unknown.join(', ')}, que la capa no nombra: build no sabe ` +
          'de dónde sale en el desenlace de la pasarela y lo deja como TODO en PaymentOutcomeApplier (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED).'
      );
    }
    return {
      outcome,
      status: OUTCOME_STATUS[outcome],
      operation: opName,
      messageClass: operation?.messageClass ?? `${pascalCase(opName)}Command`,
      messageKind: operation?.messageKind ?? 'command',
      args
    };
  });

  return {
    gateway: {
      ...gateway,
      className: `${pascalCase(gateway.id)}PaymentGateway`,
      subPackage: gateway.id
    },
    flow: payments.flow,
    captureLater: payments.flow === 'authorize-capture',
    capabilities,
    has: (capability) => capabilities.includes(capability),
    record: {
      entity: payments.record?.entity,
      gatewayRef: payments.record?.gatewayRef,
      awaitingSince: payments.record?.awaitingSince,
      failureReason: payments.record?.failureReason,
      failureReasonType,
      customerAction: payments.record?.customerAction ?? null
    },
    failureReasons: FAILURE_REASONS.map((literal) => ({ literal, constant: screamingSnake(literal) })),
    charge: {
      operation: payments.charge?.operation,
      reference: payments.charge?.reference,
      amount: payments.charge?.amount,
      currency: payments.charge?.currency ?? {},
      source: {
        token: payments.charge?.source?.token ?? null,
        saved: payments.charge?.source?.saved ?? null
      }
    },
    capture: followUp(payments.capture),
    void: followUp(payments.void),
    refund: followUp(payments.refund),
    savePaymentMethod: payments.savePaymentMethod
      ? { ...payments.savePaymentMethod }
      : null,
    outcomes: payments.outcomes ?? {},
    outcomeCommands,
    reconciliation: {
      sweep: payments.reconciliation?.sweep,
      unansweredAfterSeconds: payments.reconciliation?.unansweredAfterSeconds
    },
    // Los estados que esperan un desenlace de la pasarela: lo que el barrido mira.
    awaitingStates: awaitingStates(payments, entities)
  };
}

function awaitingStates(payments, entities) {
  const states = ['pending'];
  if ((payments.capabilities ?? []).includes('customer-action')) states.push('actionRequired');
  for (const action of ['capture', 'void', 'refund']) {
    if (payments[action]?.inFlight) states.push(payments[action].inFlight);
  }
  return states;
}

/**
 * Los dos números del barrido de pagos (`payments.reconciliation.sweep`), con su clave, su variable y su default, para
 * que los dos generadores escriban la MISMA configuración. Son de distinta clase, como los de un `reconciledBy`
 * (reconciliation-stores.js): el silencio tolerado lo declara el diseño; el lote por pasada es capacidad, y lo pone el
 * generador. Sin el segundo, los cuatro agentes de las corridas payment-checkout escribieron una constante a mano.
 */
export const PAYMENT_SWEEP_PARAMETERS = Object.freeze({
  unansweredAfterSeconds: Object.freeze({
    key: 'payments.reconciliation.unanswered-after-seconds',
    env: 'PAYMENT_UNANSWERED_AFTER_SECONDS',
    // En local y test se acorta, para que los escenarios del barrido no esperen el plazo real.
    local: 5
  }),
  batchSize: Object.freeze({
    key: 'payments.reconciliation.batch-size',
    env: 'PAYMENT_RECONCILIATION_BATCH_SIZE',
    default: RECONCILIATION_BATCH_SIZE
  })
});

/**
 * Las operaciones que llaman a la pasarela EN MEDIO de su trabajo: las acciones de la capa y el
 * barrido. Se despachan SIN transacción abarcadora, porque su garantía es un orden de commits
 * —registrar el cobro (o su estado en vuelo) y confirmar, llamar a la pasarela fuera de toda
 * transacción, aplicar el desenlace— y no una transacción única: dentro de la del mediator, el
 * `pending` no existe para nadie hasta después de la llamada, y si esta va bien pero el commit
 * falla, la pasarela cobró y aquí no queda nada que reconciliar. Las dos corridas de la fixture
 * (Stripe y MercadoPago) lo cambiaron a mano en los controllers y el scheduler.
 */
export function callsPaymentGateway(model, operationName) {
  const payments = model.payments;
  if (!payments) return false;
  const names = [
    payments.charge?.operation,
    payments.capture?.operation,
    payments.void?.operation,
    payments.refund?.operation,
    payments.savePaymentMethod?.operation,
    payments.reconciliation?.sweep
  ];
  return names.includes(operationName);
}
