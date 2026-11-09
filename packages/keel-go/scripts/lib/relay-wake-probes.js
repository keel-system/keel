// El relay del outbox por réplica (DSL 2.26, inc. 9), EJECUTADO contra el motor real por db-check y doc-check: los casos
// RW de keel-core/gen/timer-plan.js (`RELAY_WAKE_CASES`), los mismos que miden store-check en keel-spring y db-check en
// keel-nest y keel-dotnet. El messaging.Relay EMITIDO corre de verdad (Run) con el sondeo de respaldo a 600 s, la fila la
// escribe appendOutbox en su transacción y el despertar lo da Transactions.relayWake, como en el Save de un adaptador; el
// dispatcher es un doble que apunta cada intento: todo lo que salga antes de 600 s lo ha hecho salir un despertar o un
// reintento.

import { RELAY_SABOTAGES, RELAY_WAKE_CASES } from '@keel-system/keel-core/gen/timer-plan';
import { GO_OUTBOX_WAKE_LINE } from '../../src/scaffold/messaging.js';

export const PROBE_POLL_MS = 600000;
export const PROBE_BACKOFF_MS = 300;
export const PROBE_WAIT_MS = 5000;

/** Los sabotajes, con la forma de los de db-check/doc-check: el despertar que no llega (RW-1) y el reintento olvidado (RW-3). */
export const RELAY_WAKE_SABOTAGES = Object.freeze({
  'relay-no-wake': {
    files: /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/\w+\.go$/,
    from: GO_OUTBOX_WAKE_LINE,
    to: '_ = t.outboxAppended',
    breaks: RELAY_SABOTAGES['relay-no-wake'],
    expect: /^TestRelayWake_RW1_/
  },
  'relay-no-retry': {
    files: /^internal\/infrastructure\/messaging\/outbox\.go$/,
    from: 'r.pendingRetry = earliest(remembered, retryAt)',
    to: 'r.pendingRetry, _ = time.Time{}, earliest(remembered, retryAt)',
    breaks: RELAY_SABOTAGES['relay-no-retry'],
    expect: /^TestRelayWake_RW3_/
  }
});

export const isRelayWakeSabotage = (id) => Boolean(id && RELAY_WAKE_SABOTAGES[id]);

/**
 * Las pruebas en Go, en el paquete del motor. `write` es la expresión que escribe una fila del outbox (`record`) en su
 * transacción (con la variable `ctx`), como la escribe el Save de un adaptador; `empty`, la sentencia que vacía el outbox.
 */
export function relayWakeProbes({ write, empty }) {
  const [rw1, rw2, rw3] = RELAY_WAKE_CASES;
  const ms = (value) => `${value} * time.Millisecond`;
  return `// wakeDispatcher es el dispatcher de la sonda del relay por réplica: apunta cada intento y falla los que le pidan.
type wakeDispatcher struct {
	mu       sync.Mutex
	attempts []time.Time
	failing  int
}

func (d *wakeDispatcher) Dispatch(context.Context, string, string, string, string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.attempts = append(d.attempts, time.Now())
	if d.failing > 0 {
		d.failing--
		return errors.New("el broker no contesta")
	}
	return nil
}

// await espera hasta tener count intentos o agotar el plazo, y devuelve los que hubo.
func (d *wakeDispatcher) await(count int) []time.Time {
	deadline := time.Now().Add(${ms(PROBE_WAIT_MS)})
	for {
		d.mu.Lock()
		seen := slices.Clone(d.attempts)
		d.mu.Unlock()
		if len(seen) >= count || time.Now().After(deadline) {
			return seen
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// startWakeRelay arranca el relay emitido con el sondeo de respaldo a ${PROBE_POLL_MS} ms sobre un outbox vacío, cableado
// como en main (OnOutboxAppended). Devuelve el relay y cómo pararlo.
func startWakeRelay(t *testing.T, dispatcher *wakeDispatcher) (*messaging.Relay, func()) {
	t.Helper()
	${empty}
	settings := messaging.OutboxRelaySettings{Poll: ${ms(PROBE_POLL_MS)}, BatchSize: 3, MaxAttempts: 5, BackoffInitial: ${ms(PROBE_BACKOFF_MS)}, BackoffMax: ${ms(PROBE_BACKOFF_MS)}, ClaimTimeout: time.Minute}
	relay := messaging.NewRelay(NewOutbox(probeTx), dispatcher, settings, slog.New(slog.DiscardHandler))
	probeTx.OnOutboxAppended(relay.Wake)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = relay.Run(ctx)
	}()
	// La pasada del arranque, con el outbox vacío: desde aquí solo un despertar o un reintento la hacen correr.
	time.Sleep(300 * time.Millisecond)
	return relay, func() {
		cancel()
		<-done
		probeTx.OnOutboxAppended(nil)
	}
}

// writeAndWake escribe una fila del outbox en su transacción y avisa al relay como el Save de un adaptador.
func writeAndWake(t *testing.T) {
	t.Helper()
	ctx := t.Context()
	record := messaging.OutboxRecord{Destination: "probe.events", RoutingKey: "probe.k", EventType: "Probe", Payload: \`{"metadata":{},"data":{}}\`}
	if err := ${write}; err != nil {
		t.Fatalf("appendOutbox: %v", err)
	}
	probeTx.relayWake(ctx)
}

// ${rw1.id}: ${rw1.what}.
func TestRelayWake_RW1_UnEventoConfirmadoSaleSinEsperarAlSondeo(t *testing.T) {
	dispatcher := &wakeDispatcher{}
	_, stop := startWakeRelay(t, dispatcher)
	defer stop()
	writeAndWake(t)
	if seen := dispatcher.await(1); len(seen) < 1 {
		t.Errorf("el evento no salió en ${PROBE_WAIT_MS} ms: sin despertar espera al sondeo de respaldo (${PROBE_POLL_MS} ms)")
	}
}

// ${rw2.id}: ${rw2.what}.
func TestRelayWake_RW2_EnReposoNoHayPasadasHastaElSondeo(t *testing.T) {
	relay, stop := startWakeRelay(t, &wakeDispatcher{})
	defer stop()
	time.Sleep(500 * time.Millisecond)
	before := relay.Passes()
	time.Sleep(3 * time.Second)
	if after := relay.Passes(); after != before {
		t.Errorf("el relay hizo %d pasadas en reposo: sondea por su cuenta", after-before)
	}
}

// ${rw3.id}: ${rw3.what}.
func TestRelayWake_RW3_UnFalloSeReintentaASuBackoffYNoAlSondeo(t *testing.T) {
	dispatcher := &wakeDispatcher{failing: 1}
	relay, stop := startWakeRelay(t, dispatcher)
	defer stop()
	writeAndWake(t)
	// El primer intento lo despierta el caso: RW-3 mide el reintento, y así el sabotaje del despertar no lo tumba.
	relay.Wake()
	seen := dispatcher.await(2)
	if len(seen) != 2 {
		t.Fatalf("la fila que falló no se reintentó en ${PROBE_WAIT_MS} ms (%d intentos): esperó al sondeo de respaldo y no a su backoff", len(seen))
	}
	if gap := seen[1].Sub(seen[0]); gap < ${ms(PROBE_BACKOFF_MS - 50)} {
		t.Errorf("el reintento llegó antes de su backoff: %s", gap)
	}
}`;
}
