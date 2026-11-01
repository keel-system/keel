// El gate de idempotencia y compensación de keel-go (tramo 10d), EJECUTADO con bash.
//
//   · las familias y los sujetos son los del gate de keel-nest para el mismo diseño (que son los de keel-spring), salvo
//     la escritura de los registros, que es la misma promesa con otra forma, y lo que keel-go todavía no genera;
//   · recién generado sale ROJO en cada familia que tiene trabajo del agente (un gate que nace verde no distingue
//     «correcto» de «no mira»), y la escritura de los registros, que es de build, nace verde;
//   · con el uso correcto sale VERDE, y un uso roto conservando la forma lo vuelve a poner rojo;
//   · el barrido que build no puede reclamar sigue rojo aunque su adaptador tenga el reclamo de OTRO barrido;
//   · varios listeners en cmd/server/broker.go: cada uno se juzga por su función, no por el archivo entero.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { relievingOperations } from '@keel-system/keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { CHECK_IDEMPOTENCY_SH } from '../src/scaffold/idempotency-check.js';
import { occupantFinders } from '../src/scaffold/repositories.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const gateOf = (files) => files.find((file) => file.path === CHECK_IDEMPOTENCY_SH)?.content;
const rows = (script) => [...(script ?? '').matchAll(/^(unit|impl|claim) '([^']*)' '([^']*)'/gm)].map((match) => `${match[2]} | ${match[3]}`);
// La escritura de los registros: en TypeORM, insert y no save; en Go, SQL literal. Sujetos con el nombre del archivo.
const isInsertSubject = (row) => /: la escritura es un (INSERT|InsertOne)/.test(row);
// Lo que keel-go todavía no genera no tiene familia aquí (el correo entró en el 12e-b: ya no queda ninguna).
const PENDING_FAMILIES = new Set();

for (const name of ['product-catalog', 'job-dispatch', 'job-dispatch-cycles', 'payout-runs', 'metering-digest', 'stock-reservation-events', 'stock-reservation', 'notification-mailer']) {
  for (const broker of ['rabbitmq', 'kafka', 'snssqs']) {
    test(`${name} [${broker}]: las familias y los sujetos del gate son los de keel-nest`, () => {
      const stack = { database: 'postgresql', broker };
      const ours = rows(gateOf(planService({ ...design(name), workspace: FIXTURES_DIR, stack }).files));
      const theirs = rows(gateOf(planNest({ ...design(name), workspace: FIXTURES_DIR, stack }).files)).filter((row) => !PENDING_FAMILIES.has(row.split(' | ')[0]));
      assert.ok(ours.length > 0);
      assert.deepEqual(ours.filter((row) => !isInsertSubject(row)).sort(), theirs.filter((row) => !isInsertSubject(row)).sort());
      // La escritura de los registros: los mismos registros vigilados, con el nombre de archivo de cada lenguaje.
      assert.deepEqual(ours.filter(isInsertSubject).map((row) => row.split(' | ')[0]).sort(), theirs.filter(isInsertSubject).map((row) => row.split(' | ')[0]).sort());
    });
  }
}

test('MySQL: la misma matriz que PostgreSQL (el SQL de cada motor vive en archivos con el mismo nombre)', () => {
  const of = (database) => rows(gateOf(planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack: { database, broker: 'rabbitmq' } }).files));
  assert.deepEqual(of('mysql'), of('postgresql'));
});

// Sobre documentos (incremento 12), las mismas familias y sujetos que keel-nest sobre documentos: sin el relevo del índice
// condicionado, que ninguno de los otros tres emite sobre documentos.
for (const name of ['job-dispatch-mongo', 'inspection-reports', 'notification-mailer-mongo']) {
  test(`${name} [mongodb]: las familias y los sujetos del gate son los de keel-nest`, () => {
    const stack = { database: 'mongodb', broker: 'kafka' };
    const ours = rows(gateOf(planService({ ...design(name), workspace: FIXTURES_DIR, stack }).files));
    const theirs = rows(gateOf(planNest({ ...design(name), workspace: FIXTURES_DIR, stack }).files)).filter((row) => !PENDING_FAMILIES.has(row.split(' | ')[0]));
    assert.ok(ours.length > 0);
    assert.deepEqual(ours.filter((row) => !isInsertSubject(row)).sort(), theirs.filter((row) => !isInsertSubject(row)).sort());
    assert.deepEqual(ours.filter(isInsertSubject).map((row) => row.split(' | ')[0]).sort(), theirs.filter(isInsertSubject).map((row) => row.split(' | ')[0]).sort());
  });
}

/** Escribe el árbol emitido (con cambios del «agente») y ejecuta el gate. null sin bash. */
function runGate(name, edits = {}, { broker = 'rabbitmq', database = 'postgresql' } = {}) {
  const { files } = planService({ ...design(name), workspace: FIXTURES_DIR, stack: { database, broker } });
  const dir = tmpDir('keel-go-gate-');
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  for (const [suffix, edit] of Object.entries(edits)) {
    const file = files.find((candidate) => candidate.path.endsWith(suffix));
    assert.ok(file, `no hay ${suffix}`);
    const target = path.join(dir, file.path);
    const before = fs.readFileSync(target, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, `el cambio de ${suffix} no se aplicó`);
    fs.writeFileSync(target, after);
  }
  try {
    return { code: 0, out: execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { code: error.status, out: error.stdout };
  }
}

const verdicts = (out) => Object.fromEntries([...out.matchAll(/^\s+(\w+)\s+(OK|KO)$/gm)].map((match) => [match[1], match[2]]));

test('recién generado, el gate sale ROJO en cada familia con trabajo del agente', (t) => {
  const events = runGate('stock-reservation-events');
  if (events === null) return t.skip('sin bash en el PATH');
  assert.equal(events.code, 1);
  assert.deepEqual(verdicts(events.out), {
    dedupe: 'KO',
    payloadContract: 'KO',
    commandIdempotency: 'KO',
    domainEvent: 'KO',
    outboxDelivery: 'KO'
  });
  // La escritura de los registros la emite build: nace sin hallazgos, en los dos motores.
  assert.doesNotMatch(events.out, /la escritura es un INSERT/);
  assert.doesNotMatch(runGate('stock-reservation-events', {}, { database: 'mysql' }).out, /la escritura es un INSERT/);
  const payouts = runGate('payout-runs');
  assert.equal(payouts.code, 1);
  assert.match(payouts.out, /\[sweepClaim\] sendPayouts .*ClaimForSendPayouts/);
  // El barrido que build NO puede reclamar: el reclamo generado para sendPayouts, en el mismo adaptador, no lo satisface.
  assert.match(payouts.out, /\[sweepClaim\] closePayoutRuns: /);
});

test('fuera de la raíz del módulo, el gate se niega', (t) => {
  if (runGate('payout-runs') === null) return t.skip('sin bash en el PATH');
  const { files } = planService({ ...design('payout-runs'), workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  const dir = tmpDir('keel-go-gate-root-');
  fs.mkdirSync(path.join(dir, 'infra'));
  fs.writeFileSync(path.join(dir, CHECK_IDEMPOTENCY_SH), gateOf(files));
  assert.throws(() => execFileSync('bash', [CHECK_IDEMPOTENCY_SH], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /no se encontró go\.mod/);
});

test('el INSERT de un registro convertido en upsert pone su familia en rojo', (t) => {
  const upsert = runGate('stock-reservation-events', {
    'postgres/processed_events.go': (source) => source.replace('VALUES ($1, $2, $3)', 'VALUES ($1, $2, $3) ON CONFLICT DO NOTHING')
  });
  if (upsert === null) return t.skip('sin bash en el PATH');
  assert.match(upsert.out, /\[dedupe\] processed_events: la escritura es un INSERT .*ON CONFLICT/);
  const mysql = runGate('stock-reservation-events', { 'mysql/idempotency_store.go': (source) => source.replace('INSERT INTO idempotency_record', 'INSERT IGNORE INTO idempotency_record') }, { database: 'mysql' });
  assert.match(mysql.out, /\[commandIdempotency\] idempotency_store: la escritura es un INSERT/);
});

// El uso correcto de payout-runs: el barrido de cola llama al reclamo generado, y el de los dos estados en vuelo tiene
// su escritura condicional (con su cota) en el adaptador de Payout, junto al reclamo de build.
const SEND = 'application/send_payouts_command_handler.go';
const ADAPTER = 'postgres/payout_repository.go';
const STUB = 'return fmt.Errorf("%w: %s", ErrNotImplemented, "sendPayouts")';
const sendClaims = (source) =>
  source.replace(
    STUB,
    `payouts, err := h.payoutRepository.ClaimForSendPayouts(ctx)
	if err != nil {
		return err
	}
	for _, payout := range payouts {
		if _, err := h.payoutRepository.Save(ctx, payout); err != nil {
			return err
		}
	}
	return nil`
  );
const closeClaims = (source) =>
  source.replace(
    '// Save implementa domain.PayoutRepository',
    `// ClaimStalledForClose pasa a FAILED lo que lleva en SENDING más que su plazo.
func (r *PayoutRepository) ClaimStalledForClose(ctx context.Context, staleBefore time.Time) (int64, error) {
	q, err := r.tx.conn(ctx)
	if err != nil {
		return 0, err
	}
	result, err := q.ExecContext(ctx, "UPDATE payouts SET status = 'FAILED' WHERE status = 'SENDING' AND sending_since < $1", staleBefore)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// Save implementa domain.PayoutRepository`
  );

test('con el uso correcto sale VERDE; leer el lote con un finder lo vuelve a poner rojo', (t) => {
  const correct = runGate('payout-runs', { [SEND]: sendClaims, [ADAPTER]: closeClaims });
  if (correct === null) return t.skip('sin bash en el PATH');
  assert.equal(correct.code, 0, correct.out);
  assert.deepEqual(verdicts(correct.out), { sweepClaim: 'OK' });

  const reading = runGate('payout-runs', {
    [SEND]: (source) => sendClaims(source).replace('payouts, err := h.payoutRepository.ClaimForSendPayouts(ctx)', 'payouts, err := h.payoutRepository.FindByStatus(ctx, domain.PayoutStatusRequested)'),
    [ADAPTER]: closeClaims
  });
  assert.equal(reading.code, 1);
  assert.match(reading.out, /\[sweepClaim\] sendPayouts .*NO debe aparecer/);
  // La nota del stub nombra el reclamo: si el gate leyera comentarios, saldría verde por su propia prosa.
  const noteOnly = runGate('payout-runs', { [SEND]: (source) => source.replace(STUB, 'return errors.New("pendiente")'), [ADAPTER]: closeClaims });
  assert.match(noteOnly.out, /\[sweepClaim\] sendPayouts .*falta/);
  // El reclamo del agente añadido solo al PUERTO, sin implementarlo, no cuenta: el puerto nombra la entidad y el reclamo.
  const portOnly = runGate('payout-runs', {
    [SEND]: sendClaims,
    'domain/payout_repository.go': (source) => source.replace(/(\tSave\(ctx)/, '\tClaimStalledForClose(ctx context.Context, staleBefore time.Time) (int64, error)\n\n$1')
  });
  assert.match(portOnly.out, /\[sweepClaim\] closePayoutRuns: /);
});

// stock-reservation-events: un listener por cola (la de inventory) en cmd/server/broker.go, que enruta por el tipo, y el
// dispatcher del outbox en brokerAdapters.
const BROKER = 'cmd/server/broker.go';
const inventoryListener = `
// inventoryEvents consume la cola de inventory.events.
func inventoryEvents(deps inbound) func(ctx context.Context, eventType, eventID string, data jsontext.Value) error {
	return func(ctx context.Context, eventType, eventID string, data jsontext.Value) error {
		switch eventType {
		case "StockReserved", "StockRejected":
			reserved, err := messaging.ReadStockReservedMessage(data)
			if err != nil {
				return err
			}
			if err := reserved.RequireContract(); err != nil {
				return err
			}
			done, err := deps.Guard.AlreadyProcessed(ctx, "inventory-events", eventID)
			if err != nil || done {
				return err
			}
			_ = messaging.StockRejectedMessage{}
			return deps.Guard.Record(ctx, "inventory-events", eventID)
		case "StockCountAdjusted":
			claimed, err := deps.Guard.TryRecord(ctx, "inventory-events", eventID)
			if err != nil || !claimed {
				return err
			}
			_ = messaging.StockCountAdjustedMessage{}
			return nil
		default:
			return nil
		}
	}
}
`;
const withDispatcher = (source) => source.replace('return outbound{}, nil', 'return outbound{Dispatcher: newRabbitDispatcher(rabbit)}, nil');

test('stock-reservation-events: con el uso correcto del listener, la guarda y el dispatcher, esas familias salen VERDES', (t) => {
  const correct = runGate('stock-reservation-events', { [BROKER]: (source) => withDispatcher(source) + inventoryListener });
  if (correct === null) return t.skip('sin bash en el PATH');
  const found = verdicts(correct.out);
  assert.equal(found.dedupe, 'OK', correct.out);
  assert.equal(found.payloadContract, 'OK', correct.out);
  assert.equal(found.outboxDelivery, 'OK', correct.out);
  // Una clave inventada en el listener lo pone rojo.
  const invented = runGate('stock-reservation-events', { [BROKER]: (source) => withDispatcher(source) + inventoryListener.replace('"inventory-events", eventID)\n\t\t\tif err != nil || done', '"inventory-events", uuid.NewString())\n\t\t\tif err != nil || done') });
  assert.equal(verdicts(invented.out).dedupe, 'KO', invented.out);
  // La respuesta de la guarda descartada con `_`: compila, y la reentrega se procesa otra vez.
  const ignored = runGate('stock-reservation-events', { [BROKER]: (source) => withDispatcher(source) + inventoryListener.replace('done, err := deps.Guard.AlreadyProcessed', '_, err = deps.Guard.AlreadyProcessed') });
  assert.equal(verdicts(ignored.out).dedupe, 'KO', ignored.out);
  assert.match(ignored.out, /NO debe aparecer '_/);
  // El dispatcher a nil explícito es el respaldo de build.
  const nilDispatcher = runGate('stock-reservation-events', { [BROKER]: (source) => source.replace('return outbound{}, nil', 'return outbound{Dispatcher: nil}, nil') + inventoryListener });
  assert.equal(verdicts(nilDispatcher.out).outboxDelivery, 'KO', nilDispatcher.out);
});

// Kafka y SNS/SQS: un listener por suscripción, los tres en cmd/server/broker.go. Cada uno se juzga por su función: con
// el archivo entero, cada listener «prohibiría» el orden del vecino (la corrida SNS/SQS de keel-dotnet, correcta y en rojo).
test('kafka: tres listeners en broker.go salen VERDES; uno con el orden cruzado, ROJO solo él', (t) => {
  const listener = (name, message, order) => `
func ${name}(deps inbound) func(ctx context.Context, eventID string, data jsontext.Value) error {
	return func(ctx context.Context, eventID string, data jsontext.Value) error {
		payload, err := messaging.Read${message}(data)
		if err != nil {
			return err
		}
		if err := payload.RequireContract(); err != nil {
			return err
		}
${order}
	}
}
`;
  const guarded = (name) => `		done, err := deps.Guard.AlreadyProcessed(ctx, "${name}", eventID)
		if err != nil || done {
			return err
		}
		return deps.Guard.Record(ctx, "${name}", eventID)`;
  const unguarded = (name) => `		claimed, err := deps.Guard.TryRecord(ctx, "${name}", eventID)
		if err != nil || !claimed {
			return err
		}
		return nil`;
  const write = (reservedOrder) =>
    runGate(
      'stock-reservation-events',
      {
        [BROKER]: (source) =>
          source.replace('return outbound{}, nil', 'return outbound{Dispatcher: newKafkaDispatcher(kafka)}, nil') +
          listener('stockReserved', 'StockReservedMessage', reservedOrder) +
          listener('stockRejected', 'StockRejectedMessage', guarded('stockRejected')) +
          listener('stockCountAdjusted', 'StockCountAdjustedMessage', unguarded('stockCountAdjusted'))
      },
      { broker: 'kafka' }
    );
  const correct = write(guarded('stockReserved'));
  if (correct === null) return t.skip('sin bash en el PATH');
  assert.equal(verdicts(correct.out).dedupe, 'OK', correct.out);
  assert.equal(verdicts(correct.out).payloadContract, 'OK', correct.out);
  const crossed = write(unguarded('stockReserved'));
  assert.equal(verdicts(crossed.out).dedupe, 'KO', crossed.out);
  const findings = crossed.out.split('\n').filter((line) => line.includes('[dedupe]'));
  assert.ok(findings.length > 0 && findings.every((line) => line.includes('StockReserved (')), crossed.out);
});

test('conditionalUniqueness: recién generado sale rojo; con la ocupante buscada antes, verde', (t) => {
  const fresh = runGate('notification-mailer');
  if (fresh === null) return t.skip('sin bash en el PATH');
  assert.equal(verdicts(fresh.out).conditionalUniqueness, 'KO', fresh.out);
  const { model } = planService({ ...design('notification-mailer'), workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const [relief] = relievingOperations(model);
  const root = model.entities.find((candidate) => candidate.name === relief.entity.rootEntity) ?? relief.entity;
  const finder = occupantFinders(model, root).find((candidate) => candidate.state === relief.state);
  assert.ok(finder);
  const file = `${relief.operation.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_command_handler.go`;
  const relieved = runGate('notification-mailer', {
    [`application/${file}`]: (source) =>
      source.replace(`fmt.Errorf("%w: %s", ErrNotImplemented, "${relief.operation.name}")`, `h.${root.name[0].toLowerCase()}${root.name.slice(1)}Repository.${finder.name}(ctx)`)
  });
  assert.equal(verdicts(relieved.out).conditionalUniqueness, 'OK', relieved.out);
});

// stock-reservation (tramo 11c): la compensación de StockRejected, el barrido de reconciliación y la clave saliente de
// cancelStock. El uso correcto: el barrido toma el lote con el reclamo generado, deshace en el almacén y libera,
// reconociendo la carrera con errors.Is; la compensación libera la reserva en el AGREGADO.
const RECONCILE = 'application/reconcile_reservations_command_handler.go';
const RELEASE = 'application/release_reservation_command_handler.go';
const BEHAVIOR = 'domain/reservation_behavior.go';
const reconciles = (source) =>
  source.replace(
    'return fmt.Errorf("%w: %s", ErrNotImplemented, "reconcileReservations")',
    `reservations, err := h.reservationRepository.ClaimForReconcileReservationsReserveStock(ctx)
	if err != nil {
		return err
	}
	for _, reservation := range reservations {
		if err := reservation.Release("sin respuesta del almacén"); err != nil {
			if errors.Is(err, domain.ErrInvalidStateTransition) {
				continue
			}
			return err
		}
		if _, err := h.reservationRepository.Save(ctx, reservation); err != nil {
			if errors.Is(err, domain.ErrConcurrentModification) {
				continue
			}
			return err
		}
		if _, err := h.inventoryClient.CancelStock(ctx, reservation.OrderID()); err != nil {
			return err
		}
	}
	return nil`
  );
const releases = (source) => source.replace('return fmt.Errorf("%w: %s", ErrNotImplemented, "releaseReservation")', 'return h.release(ctx, cmd)');
const behaves = (source) =>
  `${source}
// Release libera la reserva y dice por qué.
func (r *Reservation) Release(reason string) error {
	if err := r.transitionTo(ReservationStatusReleased); err != nil {
		return err
	}
	r.releaseReason = &reason
	return nil
}
`;

test('stock-reservation: recién generado, la compensación y la reconciliación salen ROJAS y la clave saliente VERDE (build la deja puesta)', (t) => {
  const fresh = runGate('stock-reservation');
  if (fresh === null) return t.skip('sin bash en el PATH');
  const found = verdicts(fresh.out);
  assert.equal(found.compensation, 'KO', fresh.out);
  assert.equal(found.reconciliation, 'KO', fresh.out);
  assert.equal(found.outboundIdempotency, 'OK', fresh.out);
  // La nota del handler nombra el reclamo: leída como código, el gate saldría verde por su propia prosa.
  assert.match(fresh.out, /\[reconciliation\] reconcileReservations · reclamo de inventory\.reserveStock/);
  assert.match(fresh.out, /\[compensation\] releaseReservation · estado de Reservation/);
});

test('stock-reservation: con el uso correcto, VERDE; un finder, un error descartado o la clave saliente quitada lo ponen rojo', (t) => {
  const edits = { [RECONCILE]: reconciles, [RELEASE]: releases, [BEHAVIOR]: behaves };
  const correct = runGate('stock-reservation', edits);
  if (correct === null) return t.skip('sin bash en el PATH');
  const found = verdicts(correct.out);
  assert.equal(found.compensation, 'OK', correct.out);
  assert.equal(found.reconciliation, 'OK', correct.out);
  assert.equal(found.outboundIdempotency, 'OK', correct.out);

  const finder = runGate('stock-reservation', {
    ...edits,
    [RECONCILE]: (source) => reconciles(source).replace('reservations, err := h.reservationRepository.ClaimForReconcileReservationsReserveStock(ctx)', 'reservations, err := h.reservationRepository.FindByStatus(ctx, domain.ReservationStatusAwaitingStock)')
  });
  assert.equal(verdicts(finder.out).reconciliation, 'KO', finder.out);
  assert.match(finder.out, /\[reconciliation\] reconcileReservations · reclamo .*NO debe aparecer/);

  const swallowed = runGate('stock-reservation', {
    ...edits,
    [RECONCILE]: (source) => reconciles(source).replace('if _, err := h.inventoryClient.CancelStock(ctx, reservation.OrderID()); err != nil {\n\t\t\treturn err\n\t\t}', '_, _ = h.inventoryClient.CancelStock(ctx, reservation.OrderID())')
  });
  assert.equal(verdicts(swallowed.out).reconciliation, 'KO', swallowed.out);

  const keyless = runGate('stock-reservation', { ...edits, 'clients/inventory_adapter.go': (source) => source.replaceAll('outboundKey("cancelStock", ', 'outboundKey(randomCall(), ') });
  assert.equal(verdicts(keyless.out).outboundIdempotency, 'KO', keyless.out);

  const unrestored = runGate('stock-reservation', { ...edits, [BEHAVIOR]: (source) => behaves(source).replace('if err := r.transitionTo(ReservationStatusReleased); err', 'if err := r.transitionTo(ReservationStatusConfirmed); err') });
  assert.equal(verdicts(unrestored.out).compensation, 'KO', unrestored.out);
});
