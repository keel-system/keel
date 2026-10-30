// Las sondas de db-check de los almacenes de la mensajería (incremento 9): lo que solo juzga el motor del relay del
// outbox y de la guarda de los mensajes procesados, EJECUTANDO lo emitido (appendOutbox, Outbox, ProcessedEvents, y el
// messaging.Relay y la messaging.IdempotencyGuard por encima). Son las de keel-dotnet, en Go:
//
//   · el reclamo en orden de llegada con su LEASE: lo reclamado no vuelve a salir mientras dura;
//   · SKIP LOCKED: el reclamo se salta la fila que otra transacción retiene, sin esperarla;
//   · el fallo cuenta con su backoff, y agotados los intentos la fila se rinde y se cuenta;
//   · la publicada no se vuelve a reclamar, ni con su lease caducado;
//   · el relay entero sobre un dispatcher falso: lo que sale se marca publicado y lo que falla cuenta un intento;
//   · la guarda: el par (consumidor, mensaje), el registro que sobrevive al rollback del caso de uso y la carrera de
//     cuatro entregas que gana una.
//
// Cada sonda del outbox vacía la tabla al empezar: el reclamo es de la tabla entera, y las sondas no corren en paralelo.

import { OUTBOX_EVENT, PROCESSED_EVENT } from '@keel-system/keel-core/gen/messaging-stores';
import { goString } from '../../src/lib/go-source.js';
import { sqlDialect } from '../../src/lib/relational-engine.js';
import { usesBestEffort, usesGoOutbox, usesGoProcessedEvents } from '../../src/scaffold/messaging.js';

export function messagingProbes(model) {
  const d = sqlDialect(model);
  const parts = [];
  if (usesGoOutbox(model)) parts.push(outboxProbes(d));
  if (usesGoProcessedEvents(model)) parts.push(processedProbes(d));
  if (usesBestEffort(model)) parts.push(AFTER_COMMIT_PROBE);
  return parts.join('\n\n');
}

function outboxProbes(d) {
  const table = OUTBOX_EVENT.table;
  const p = d.param;
  // Un id en el SQL crudo de la sonda: en MySQL la columna es binary(16) con los bytes del uuid (los que escribe `bound`
  // en el adaptador); como texto no casaría con ninguna fila.
  const idArg = (expr) => (d.mysql ? `${expr}[:]` : expr);
  return `// emptyOutbox vacía el outbox: el reclamo es de la tabla entera.
func emptyOutbox(t *testing.T) {
	t.Helper()
	if _, err := probeDB.ExecContext(t.Context(), ${goString(`DELETE FROM ${table}`)}); err != nil {
		t.Fatalf("vaciar el outbox: %v", err)
	}
}

// appendRecords escribe las filas como lo hace el adaptador de repositorio, en una transacción propia, una a una para
// que su orden de llegada sea el de la lista.
func appendRecords(t *testing.T, eventTypes ...string) {
	t.Helper()
	for _, eventType := range eventTypes {
		record := messaging.OutboxRecord{Destination: "probe.events", RoutingKey: "probe." + eventType, EventType: eventType, Payload: \`{"metadata":{},"data":{}}\`}
		if err := probeTx.write(t.Context(), func(q DBTX) error {
			return appendOutbox(t.Context(), q, []messaging.OutboxRecord{record})
		}); err != nil {
			t.Fatalf("appendOutbox: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func claimedTypes(events []messaging.OutboxEvent) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.EventType)
	}
	return types
}

func TestOutbox_ClaimsInArrivalOrderWithLease(t *testing.T) {
	emptyOutbox(t)
	appendRecords(t, "A", "B", "C")
	outbox := NewOutbox(probeTx)
	first, err := outbox.ClaimBatch(t.Context(), 10, 2, time.Minute)
	if err != nil {
		t.Fatalf("ClaimBatch: %v", err)
	}
	if got := claimedTypes(first); !slices.Equal(got, []string{"A", "B"}) {
		t.Errorf("el primer lote es %v, quiero [A B] (orden de llegada, tope del lote)", got)
	}
	if first[0].Destination != "probe.events" || first[0].RoutingKey != "probe.A" || first[0].Payload == "" {
		t.Errorf("la fila reclamada no es la escrita: %+v", first[0])
	}
	// Lo reclamado lleva su lease: la pasada siguiente solo ve lo que queda.
	second, err := outbox.ClaimBatch(t.Context(), 10, 10, time.Minute)
	if err != nil {
		t.Fatalf("ClaimBatch: %v", err)
	}
	if got := claimedTypes(second); !slices.Equal(got, []string{"C"}) {
		t.Errorf("con A y B en vuelo, el lote es %v, quiero [C]", got)
	}
}

func TestOutbox_SkipLockedSkipsHeldRows(t *testing.T) {
	emptyOutbox(t)
	appendRecords(t, "Held", "Free")
	// Se retiene por su clave primaria: un FOR UPDATE por otra columna sin índice bloquearía en MySQL (REPEATABLE READ)
	// todas las filas que examina, también la libre.
	var id uuid.UUID
	if err := probeDB.QueryRowContext(t.Context(), ${goString(`SELECT id FROM ${table} WHERE event_type = ${p(1)}`)}, "Held").Scan(&id); err != nil {
		t.Fatal(err)
	}
	held, err := probeDB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Rollback() }()
	var one int
	if err := held.QueryRowContext(t.Context(), ${goString(`SELECT 1 FROM ${table} WHERE id = ${p(1)} FOR UPDATE`)}, ${idArg('id')}).Scan(&one); err != nil {
		t.Fatalf("retener la fila: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	started := time.Now()
	claimed, err := NewOutbox(probeTx).ClaimBatch(ctx, 10, 10, time.Minute)
	if err != nil {
		t.Fatalf("ClaimBatch con una fila retenida: %v (tras %v): el reclamo esperó en vez de saltarla", err, time.Since(started))
	}
	if got := claimedTypes(claimed); !slices.Equal(got, []string{"Free"}) {
		t.Errorf("con Held retenida, el lote es %v, quiero [Free]", got)
	}
}

func TestOutbox_FailureBacksOffAndDeadLetters(t *testing.T) {
	emptyOutbox(t)
	appendRecords(t, "Failing")
	outbox := NewOutbox(probeTx)
	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		// El backoff de verdad se pisa en cada vuelta: la fila vuelve a ser elegible ya.
		if _, err := probeDB.ExecContext(t.Context(), ${goString(`UPDATE ${table} SET next_attempt_at = NULL`)}); err != nil {
			t.Fatal(err)
		}
		claimed, err := outbox.ClaimBatch(t.Context(), maxAttempts, 10, time.Minute)
		if err != nil || len(claimed) != 1 {
			t.Fatalf("intento %d: ClaimBatch = %v, %v; quiero la fila", attempt, claimedTypes(claimed), err)
		}
		before := time.Now().UTC()
		outcome, err := outbox.MarkFailed(t.Context(), claimed[0].ID, "broker caído", maxAttempts, time.Second, 2*time.Second)
		if err != nil {
			t.Fatalf("MarkFailed: %v", err)
		}
		if outcome.Attempts != attempt || outcome.DeadLettered != (attempt == maxAttempts) {
			t.Errorf("intento %d: el desenlace es %+v", attempt, outcome)
		}
		var next sql.NullTime
		var reason sql.NullString
		failing := claimed[0].ID
		if err := probeDB.QueryRowContext(t.Context(), ${goString(`SELECT next_attempt_at, last_error FROM ${table} WHERE id = ${p(1)}`)}, ${idArg('failing')}).Scan(&next, &reason); err != nil {
			t.Fatal(err)
		}
		if reason.String != "broker caído" {
			t.Errorf("last_error = %q", reason.String)
		}
		if attempt < maxAttempts {
			want := messaging.BackoffDelay(attempt, time.Second, 2*time.Second)
			if !next.Valid || next.Time.Before(before.Add(want-time.Second)) {
				t.Errorf("intento %d: next_attempt_at = %v, quiero ~%v después", attempt, next, want)
			}
			// Aplazada: la pasada siguiente no la ve.
			if again, err := outbox.ClaimBatch(t.Context(), maxAttempts, 10, time.Minute); err != nil || len(again) != 0 {
				t.Errorf("intento %d: la fila aplazada se volvió a reclamar (%v, %v)", attempt, claimedTypes(again), err)
			}
		}
	}
	// Rendida: no se reclama nunca más y se cuenta.
	if _, err := probeDB.ExecContext(t.Context(), ${goString(`UPDATE ${table} SET next_attempt_at = NULL`)}); err != nil {
		t.Fatal(err)
	}
	if again, err := outbox.ClaimBatch(t.Context(), maxAttempts, 10, time.Minute); err != nil || len(again) != 0 {
		t.Errorf("la fila rendida se volvió a reclamar (%v, %v)", claimedTypes(again), err)
	}
	if count, err := outbox.CountDeadLettered(t.Context(), maxAttempts); err != nil || count != 1 {
		t.Errorf("CountDeadLettered = %d, %v; quiero 1", count, err)
	}
}

func TestOutbox_PublishedIsNotClaimedAgain(t *testing.T) {
	emptyOutbox(t)
	appendRecords(t, "Published")
	outbox := NewOutbox(probeTx)
	claimed, err := outbox.ClaimBatch(t.Context(), 10, 10, time.Minute)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("ClaimBatch = %v, %v", claimedTypes(claimed), err)
	}
	if err := outbox.MarkPublished(t.Context(), claimed[0].ID); err != nil {
		t.Fatalf("MarkPublished: %v", err)
	}
	// Con el lease caducado: lo publicado sigue sin salir.
	if _, err := probeDB.ExecContext(t.Context(), ${goString(`UPDATE ${table} SET next_attempt_at = NULL`)}); err != nil {
		t.Fatal(err)
	}
	if again, err := outbox.ClaimBatch(t.Context(), 10, 10, time.Minute); err != nil || len(again) != 0 {
		t.Errorf("lo publicado se volvió a reclamar (%v, %v)", claimedTypes(again), err)
	}
}

// probeDispatcher entrega todo salvo los tipos de failing, y apunta lo que entregó.
type probeDispatcher struct {
	failing   map[string]bool
	delivered []string
}

func (d *probeDispatcher) Dispatch(_ context.Context, _, _, eventType, _ string) error {
	if d.failing[eventType] {
		return errors.New("el broker no confirmó")
	}
	d.delivered = append(d.delivered, eventType)
	return nil
}

func TestOutbox_RelayPublishesAndCountsFailures(t *testing.T) {
	emptyOutbox(t)
	appendRecords(t, "Ok", "Ko")
	dispatcher := &probeDispatcher{failing: map[string]bool{"Ko": true}}
	settings := messaging.OutboxRelaySettings{FixedDelay: time.Second, BatchSize: 10, MaxAttempts: 5, BackoffInitial: time.Second, BackoffMax: time.Minute, ClaimTimeout: time.Minute}
	relay := messaging.NewRelay(NewOutbox(probeTx), dispatcher, settings, slog.New(slog.DiscardHandler))
	if n, err := relay.RelayOnce(t.Context()); err != nil || n != 2 {
		t.Fatalf("RelayOnce = %d, %v; quiero 2", n, err)
	}
	if !slices.Equal(dispatcher.delivered, []string{"Ok"}) {
		t.Errorf("entregado %v, quiero [Ok]", dispatcher.delivered)
	}
	rows, err := probeDB.QueryContext(t.Context(), ${goString(`SELECT event_type, published_at IS NOT NULL, attempts FROM ${table}`)})
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	state := map[string]string{}
	for rows.Next() {
		var eventType string
		var published bool
		var attempts int
		if err := rows.Scan(&eventType, &published, &attempts); err != nil {
			t.Fatal(err)
		}
		state[eventType] = fmt.Sprintf("published=%v attempts=%d", published, attempts)
	}
	if state["Ok"] != "published=true attempts=0" || state["Ko"] != "published=false attempts=1" {
		t.Errorf("tras la pasada: %v", state)
	}
}`;
}

function processedProbes(d) {
  const table = PROCESSED_EVENT.table;
  return `// probeGuard es la guarda de los mensajes procesados sobre las transacciones de la sonda.
func probeGuard() *messaging.IdempotencyGuard {
	return messaging.NewIdempotencyGuard(NewProcessedEvents(probeTx), slog.New(slog.DiscardHandler))
}

func TestProcessed_RecordIsKeyedByHandlerAndEvent(t *testing.T) {
	ctx := t.Context()
	guard := probeGuard()
	event := uuid.NewString()
	if seen, err := guard.AlreadyProcessed(ctx, "ProbeListener", event); err != nil || seen {
		t.Fatalf("antes de registrar: %v, %v", seen, err)
	}
	if err := guard.Record(ctx, "ProbeListener", event); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if seen, err := guard.AlreadyProcessed(ctx, "ProbeListener", event); err != nil || !seen {
		t.Errorf("después de registrar: %v, %v; quiero visto", seen, err)
	}
	// Otro consumidor del mismo mensaje no se deduplica con este.
	if seen, err := guard.AlreadyProcessed(ctx, "OtherListener", event); err != nil || seen {
		t.Errorf("otro consumidor ve el mensaje como procesado (%v)", err)
	}
	// Registrar dos veces no es un error: el mensaje ya estaba atendido.
	if err := guard.Record(ctx, "ProbeListener", event); err != nil {
		t.Errorf("el segundo Record falló: %v", err)
	}
	if claimed, err := guard.TryRecord(ctx, "ProbeListener", event); err != nil || claimed {
		t.Errorf("TryRecord sobre lo ya registrado = %v, %v; quiero false", claimed, err)
	}
}

func TestProcessed_SurvivesTheCallerRollback(t *testing.T) {
	ctx := t.Context()
	guard := probeGuard()
	event := uuid.NewString()
	failed := errors.New("el handler falló")
	err := probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		if claimed, err := guard.TryRecord(ctx, "ProbeListener", event); err != nil || !claimed {
			t.Errorf("TryRecord = %v, %v", claimed, err)
		}
		return failed
	})
	if !errors.Is(err, failed) {
		t.Fatalf("Within = %v", err)
	}
	// El registro va en su propia transacción: el rollback del caso de uso no lo deshace.
	if seen, err := guard.AlreadyProcessed(ctx, "ProbeListener", event); err != nil || !seen {
		t.Errorf("el rollback del caso de uso deshizo el registro (%v)", err)
	}
}

func TestProcessed_ConcurrentDeliveriesOneWins(t *testing.T) {
	guard := probeGuard()
	event := uuid.NewString()
	var wins atomic.Int32
	var group sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		group.Go(func() {
			claimed, err := guard.TryRecord(t.Context(), "ProbeListener", event)
			if err != nil {
				errs <- err
				return
			}
			if claimed {
				wins.Add(1)
			}
		})
	}
	group.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("una entrega falló en vez de perder la carrera: %v", err)
	}
	if wins.Load() != 1 {
		t.Errorf("ganaron %d entregas, quiero 1", wins.Load())
	}
	var count int
	if err := probeDB.QueryRowContext(t.Context(), ${goString(`SELECT COUNT(*) FROM ${table} WHERE event_id = ${d.param(1)}`)}, event).Scan(&count); err != nil || count != 1 {
		t.Errorf("filas del mensaje: %d, %v; quiero 1", count, err)
	}
}`;
}


// best-effort: lo que espera al commit (la publicación de los eventos) se ejecuta al confirmar, una vez, y nunca si la
// transacción revierte; sin transacción abierta, ya.
const AFTER_COMMIT_PROBE = `func TestTransaction_AfterCommitRunsOnlyOnCommit(t *testing.T) {
	ctx := t.Context()
	var ran []string
	if err := probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		probeTx.afterCommit(ctx, func(context.Context) { ran = append(ran, "confirmada") })
		if len(ran) != 0 {
			t.Error("se ejecutó antes del commit")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	failed := errors.New("el caso de uso falló")
	if err := probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		probeTx.afterCommit(ctx, func(context.Context) { ran = append(ran, "revertida") })
		return failed
	}); !errors.Is(err, failed) {
		t.Fatal(err)
	}
	probeTx.afterCommit(ctx, func(context.Context) { ran = append(ran, "sin transacción") })
	if !slices.Equal(ran, []string{"confirmada", "sin transacción"}) {
		t.Errorf("se ejecutó %v, quiero [confirmada sin transacción]", ran)
	}
}`;
