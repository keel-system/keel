// El reclamo del barrido de pagos (`payments.reconciliation.sweep`), generado por build (corrida payment de
// prueba-gelsa, G11): el gemelo de `payment-sweep-claim.js` de keel-spring, keel-nest y keel-dotnet.
//
// Lo escribía el agente en los `<raíz>_queries.go` del registro, y un mecanismo de concurrencia que escribe el agente no lo
// mide nadie. Es la forma de un RESCATE —renovar el reloj con una escritura condicional que solo casa si la fila sigue
// atascada, sin mover el estado— con dos diferencias: varios estados en espera con UN solo reloj (`record.awaitingSince`),
// y el plazo y el lote son del barrido de pagos (`PaymentReconciliation.StaleBefore(now)` y `BatchSize()`, que el handler
// pasa). Por eso no va en `operation.claim` del modelo neutral. Las sentencias son las del rescate (`claimStatements`).
//
// El cobro reclamado se consulta FUERA de esta llamada: el reclamo confirma antes de volver (transacción propia), y la
// llamada a la pasarela no puede ir dentro de ninguna transacción.

import { scheduledByTimer } from '@keel-system/keel-core/gen/timer-plan';
import { snakeCase } from '@keel-system/keel-core/gen';
import { isLogicallyDeleted } from '@keel-system/keel-core/gen/relational';
import { goString } from '../lib/go-source.js';
import { claimStatements, storedState } from './claim.js';

const METHOD = 'ClaimForPaymentSweep';

/** El reclamo del barrido de pagos sobre esta entidad, o null si no es el registro de cobros. */
export function paymentSweepClaim(model, entity) {
  const payments = model.payments;
  if (!payments?.reconciliation?.sweep || payments.record?.entity !== entity.name || !entity.lifecycle) return null;
  return { sweep: payments.reconciliation.sweep, states: payments.awaitingStates, stampField: payments.record.awaitingSince };
}

/** ¿Emite algún adaptador este reclamo? (los ayudantes de claims.go). */
export function usesPaymentSweepClaim(model) {
  return (model.entities ?? []).some((entity) => paymentSweepClaim(model, entity));
}

/** El método del puerto `<Raíz>Repository`, como [doc, firma]. */
export function portMethods(model, entity) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const doc = [
    `reclama hasta batchSize ${entity.name} que esperan un desenlace de la pasarela (${claim.states.join(', ')}) con`,
    `${claim.stampField} anterior a staleBefore, y los devuelve SIGUIENDO en su estado con ${claim.stampField} renovado: es el`,
    `reclamo del barrido de pagos (${claim.sweep}). Reclama, no lee: el barrido puede correr en varias réplicas a la vez, y el`,
    'reclamo es una escritura condicional que solo casa si la fila sigue esperando y sigue rancia, así que lo que otra',
    'réplica reclamó antes no aparece aquí. Confirma en SU PROPIA transacción antes de volver (con una abierta devuelve un',
    'error): consulta la pasarela con PaymentReconciliation.Consult FUERA de esta llamada. Los dos números son del barrido',
    'de pagos y los pasa el handler: PaymentReconciliation.StaleBefore(now) (el umbral del diseño) y BatchSize().'
  ].join('\n');
  return [[doc, `${METHOD}(ctx context.Context, staleBefore time.Time, batchSize int) ([]*${entity.name}, error)`]];
}

/** La señal de lote lleno, si el barrido lo dispara el cronómetro (que repite la pasada). */
function passSignal(model, claim, size, indent) {
  if (!scheduledByTimer(model, claim.sweep)) return '';
  return `${indent}// Lote lleno: puede que queden candidatos, y el tick del cronómetro repite la pasada (drenaje).
${indent}application.SweepClaimed(ctx, ${size}, batch)
`;
}

/** Las sentencias: las del rescate, sobre los estados en espera y su único reloj. */
function statements(model, entity, claim) {
  return claimStatements(model, entity, { from: claim.states, stalled: { stampField: claim.stampField }, to: claim.states[0] });
}

/** El método del adaptador relacional: SKIP LOCKED + UPDATE condicional por fila, en una transacción nueva. */
export function adapterMethods(model, entity, type) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  const sql = statements(model, entity, claim);
  return [
    `// ${METHOD} implementa domain.${entity.name}Repository (barrido de pagos).
func (r *${type}) ${METHOD}(ctx context.Context, staleBefore time.Time, batchSize int) ([]*domain.${entity.name}, error) {
	if err := ownTransaction(ctx, ${goString(METHOD)}); err != nil {
		return nil, err
	}
	staleBefore = staleBefore.UTC()
	batch := batchSize
	// El reloj renovado, uno por tanda: el reclamo ARRIENDA la fila, no la mueve de estado.
	claimedAt := time.Now().UTC()
	var claimed []*domain.${entity.name}
	err := r.tx.fresh(ctx, claimOptions, func(ctx context.Context, q DBTX) error {
		// Un conflicto transitorio repite la transacción entera: lo reclamado en el intento fallido se revirtió.
		claimed = nil
		ids, err := claimCandidates[${idType}](ctx, q, ${goString(sql.candidates)}, ${sql.candidateArgs.join(', ')})
		if err != nil {
			return err
		}
		for _, id := range ids {
			// Renueva ${claim.stampField} SOLO si la fila sigue esperando y sigue rancia. 1 = es mía; 0 = otra réplica la
			// reclamó entre la lectura y esta escritura: esa comparación es toda la exclusión mutua.
			result, err := q.ExecContext(ctx, ${goString(sql.update)}, ${sql.updateArgs.join(', ')})
			if err != nil {
				return err
			}
			won, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if won != 1 {
				continue
			}
			found, err := r.load(ctx, ${goString(sql.reload)}, id)
			if err != nil {
				return err
			}
			claimed = append(claimed, found...)
		}
${passSignal(model, claim, 'len(ids)', '\t\t')}		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}`
  ];
}

/**
 * El método del adaptador documental: un FindOneAndUpdate por candidato, que filtra por esperando y rancio y renueva el
 * reloj en la MISMA operación atómica, sin la sesión del caso de uso.
 */
export function documentAdapterMethods(model, entity, type, constant, aliveFilter) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const stateKey = snakeCase(entity.lifecycle.field);
  const stamp = snakeCase(claim.stampField);
  const states = claim.states.map((state) => goString(storedState(model, entity, state))).join(', ');
  const filter = [
    `{Key: ${goString(stateKey)}, Value: bson.D{{Key: "$in", Value: bson.A{${states}}}}}`,
    `{Key: ${goString(stamp)}, Value: bson.D{{Key: "$lt", Value: instantValue(staleBefore)}}}`,
    ...(isLogicallyDeleted(entity) ? [aliveFilter] : [])
  ];
  return [
    `// ${METHOD} implementa domain.${entity.name}Repository (barrido de pagos).
func (r *${type}) ${METHOD}(ctx context.Context, staleBefore time.Time, batchSize int) ([]*domain.${entity.name}, error) {
	if openTx(ctx) != nil {
		return nil, fmt.Errorf("%s confirma por su cuenta y hay una transacción abierta: despacha la operación con application.WithoutTransaction (el reloj ya lo hace)", ${goString(METHOD)})
	}
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return nil, err
	}
	ctx = outside(ctx)
	batch := batchSize
	staleBefore = staleBefore.UTC()
	// El reloj renovado, uno por tanda: el reclamo ARRIENDA el documento, no lo mueve de estado.
	claimedAt := time.Now().UTC()
	filter := bson.D{${filter.join(', ')}}
	update := bson.D{{Key: "$set", Value: bson.D{{Key: ${goString(stamp)}, Value: instantValue(claimedAt)}}}}
	claim := options.FindOneAndUpdate().SetSort(bson.D{{Key: ${goString(stamp)}, Value: 1}, {Key: "_id", Value: 1}}).SetReturnDocument(options.After)
	var claimed []*domain.${entity.name}
	for range batch {
		// Renueva el reloj SOLO si sigue esperando y sigue rancio, en la misma operación que lo elige. Nada que casar = no
		// queda ninguno.
		raw, err := documents.FindOneAndUpdate(ctx, filter, update, claim).Raw()
		if errors.Is(err, mongodriver.ErrNoDocuments) {
			break
		}
		if err != nil {
			return claimed, translate(err)
		}
		aggregate, err := decode${entity.name}(raw)
		if err != nil {
			return claimed, fmt.Errorf("%s: %w", ${constant}, err)
		}
		claimed = append(claimed, aggregate)
	}
${passSignal(model, claim, 'len(claimed)', '\t')}	return claimed, nil
}`
  ];
}

