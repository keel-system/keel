// Las sondas del reclamo de RECONCILIACIÓN (tramo 11c) para db-check: ejecutan contra el motor real la marca emitida
// (`claimReconciliation`, en reconciliation.go) y el reclamo del adaptador de la raíz que espera, como los llama el
// barrido. Las de keel-dotnet en su 11c, con los nombres de Go:
//
//   · la tienda: sin marca inserta; con la marca VIVA no; la CADUCADA justo en el límite (`<=`) se renueva; la marca es
//     por activación; tres réplicas a la vez a por el mismo candidato y gana una;
//   · el reclamo: solo lo que pasó el umbral, el que más lleva primero, con el estado intacto y la marca puesta; la
//     pasada siguiente se lleva al de DETRÁS (la cabeza, marcada y sin resolver, no ocupa el lote); lo caducado vuelve;
//     dos réplicas a la vez no repiten ninguno; y se niega a correr dentro de otra transacción.
//
// El reclamo es de la tabla ENTERA: antes de cada sonda se APARCAN en un estado que el barrido no mira las filas que
// otras sondas dejaron esperando, y se borran las marcas de la activación. Cada sonda guarda sus propias muestras
// (números a partir de 400).

import { RECONCILIATION_CLAIM, reconciliationClaims } from '@keel-system/keel-core/gen/reconciliation-stores';
import { snakeCase, screamingSnake } from '@keel-system/keel-core/gen';
import { goExported } from '../../src/lib/go-projection.js';
import { goString } from '../../src/lib/go-source.js';
import { sqlDialect } from '../../src/lib/relational-engine.js';
import { reconciliationMethod, usesReconciliationClaims } from '../../src/scaffold/reconciliation-claim.js';

const SAMPLES = 400;
// El lote de las sondas: con tres candidatos, dos pasadas.
const BATCH = 2;

/** Los barridos de las sondas, que el adaptador de las sondas recibe (db-probes.js: `repository`). */
export const PROBE_RECONCILIATION = 'probeReconciliation';

/** Las sondas del reclamo de reconciliación del sujeto, o null si no tiene ninguno. `repo(root)` es el adaptador. */
export function reconciliationProbes(model, repo) {
  if (!usesReconciliationClaims(model)) return null;
  const claims = reconciliationClaims(model);
  const parts = [prelude(model, claims)];
  parts.push(...storeProbes(model, claims[0]));
  for (const claim of claims) {
    const root = model.entities.find((entity) => entity.name === claim.entity);
    parts.push(...claimProbes(model, root, claim, repo(root)));
  }
  return parts.join('\n\n');
}

function prelude(model, claims) {
  const d = sqlDialect(model);
  const p = d.param;
  const windows = claims.map((claim) => `${goString(claim.activation)}: {UnansweredAfterSeconds: ${claim.parameters.unansweredAfterSeconds.default}, ClaimTimeoutMs: ${claim.parameters.claimTimeoutMs.default}, BatchSize: ${BATCH}}`);
  return `// ${PROBE_RECONCILIATION} son los barridos de reconciliación de las sondas: el umbral y la caducidad de los defaults, y lotes de
// ${BATCH} (con tres candidatos, dos pasadas).
var ${PROBE_RECONCILIATION} = ReconciliationSettings{Windows: map[string]ReconciliationWindow{${windows.join(', ')}}}

// reconExec ejecuta una sentencia de las sondas de la reconciliación por la conexión de los repositorios (en MySQL
// escribe el uuid como sus 16 bytes).
func reconExec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := must(probeTx.conn(t.Context())).ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

// reconMark reclama entityID para activation en una transacción propia, como el adaptador.
func reconMark(t *testing.T, activation string, entityID uuid.UUID, now, expiredBefore time.Time) bool {
	t.Helper()
	var won bool
	if err := probeTx.fresh(t.Context(), claimOptions, func(ctx context.Context, q DBTX) error {
		var err error
		won, err = claimReconciliation(ctx, q, activation, entityID, now, expiredBefore)
		return err
	}); err != nil {
		t.Fatalf("claimReconciliation: %v", err)
	}
	return won
}

// reconMarkedAt es el claimed_at de la marca de entityID para activation, y false si no hay marca.
func reconMarkedAt(t *testing.T, activation string, entityID uuid.UUID) (time.Time, bool) {
	t.Helper()
	var at time.Time
	err := must(probeTx.conn(t.Context())).QueryRowContext(t.Context(), ${goString(`SELECT claimed_at FROM ${RECONCILIATION_CLAIM.table} WHERE activation = ${p(1)} AND entity_id = ${p(2)}`)}, activation, entityID).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return at, true
}`;
}

// ─── La tienda de la marca ───────────────────────────────────────────────────────────────────────

function storeProbes(model, claim) {
  const activation = goString(claim.activation);
  return [
    `func TestReconciliationStore_InsertsAndRespectsTheLiveMark(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC().Truncate(time.Millisecond)
	expired := now.Add(-time.Minute)
	if !reconMark(t, ${activation}, id, now, expired) {
		t.Fatal("sin marca, la inserción es el reclamo: quiero true")
	}
	if _, ok := reconMarkedAt(t, ${activation}, id); !ok {
		t.Fatal("el reclamo no dejó su marca en ${RECONCILIATION_CLAIM.table}")
	}
	// Otra réplica, un segundo después: la marca sigue viva.
	if reconMark(t, ${activation}, id, now.Add(time.Second), expired.Add(time.Second)) {
		t.Error("con la marca viva otra réplica se llevó el candidato")
	}
}`,
    `func TestReconciliationStore_RenewsTheExpiredMarkAtTheLimit(t *testing.T) {
	id := uuid.New()
	marked := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
	if !reconMark(t, ${activation}, id, marked, marked.Add(-time.Minute)) {
		t.Fatal("la primera marca: quiero true")
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	// Un milisegundo antes del límite, la marca todavía vale.
	if reconMark(t, ${activation}, id, now, marked.Add(-time.Millisecond)) {
		t.Error("la marca aún no había caducado y se renovó")
	}
	// Justo en el límite (claimed_at <= caducidad) ya caducó: se renueva con el instante nuevo.
	if !reconMark(t, ${activation}, id, now, marked) {
		t.Fatal("la marca caducada justo en el límite no se renovó")
	}
	if at, _ := reconMarkedAt(t, ${activation}, id); !at.Equal(now) {
		t.Errorf("la marca renovada dice %v, quiero %v", at, now)
	}
}`,
    `func TestReconciliationStore_TheMarkIsPerActivation(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC()
	if !reconMark(t, ${activation}, id, now, now.Add(-time.Minute)) {
		t.Fatal("la primera marca: quiero true")
	}
	// La misma entidad puede esperar el desenlace de otra activación a la vez.
	if !reconMark(t, "probe-other-activation", id, now, now.Add(-time.Minute)) {
		t.Error("la marca de una activación bloqueó a otra")
	}
}`,
    `func TestReconciliationStore_ThreeReplicasAtOnceAndOneWins(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC()
	var wins atomic.Int32
	var replicas sync.WaitGroup
	for range 3 {
		replicas.Go(func() {
			if reconMark(t, ${activation}, id, now, now.Add(-time.Minute)) {
				wins.Add(1)
			}
		})
	}
	replicas.Wait()
	if got := wins.Load(); got != 1 {
		t.Errorf("se llevaron el candidato %d réplicas, quiero 1", got)
	}
}`
  ];
}

// ─── El reclamo del adaptador ────────────────────────────────────────────────────────────────────

function claimProbes(model, root, claim, repo) {
  const d = sqlDialect(model);
  const p = d.param;
  const name = root.name;
  const method = reconciliationMethod(claim);
  const call = `${repo}.${method}(t.Context())`;
  const id = goExported(root.idField?.name ?? 'id');
  const table = d.quote(root.tableName);
  const stateColumn = d.quote(snakeCase(root.lifecycle.field));
  const awaiting = d.quote(snakeCase(claim.awaitingField));
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const stored = (state) => enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
  const park = enumDef.values.map((value) => value.literal).find((literal) => !claim.states.includes(literal));
  if (!park) throw new Error(`reconciliation-probes: ${name} no tiene un estado fuera de la espera donde aparcar las filas`);
  const waitingState = stored(claim.states[0]);
  const activation = goString(claim.activation);
  let next = SAMPLES;
  const take = (count) => Array.from({ length: count }, () => next++);
  const numbers = (list) => `[]int{${list.join(', ')}}`;
  const clean = `reconClean${method}(t)`;
  return [
    `// reconClean${method} aparca lo que otras sondas dejaron esperando y borra las marcas de la activación: el reclamo es de
// la tabla entera.
func reconClean${method}(t *testing.T) {
	t.Helper()
	reconExec(t, ${goString(`UPDATE ${table} SET ${stateColumn} = '${stored(park)}' WHERE ${stateColumn} IN (${claim.states.map((state) => `'${stored(state)}'`).join(', ')})`)})
	reconExec(t, ${goString(`DELETE FROM ${RECONCILIATION_CLAIM.table} WHERE activation = ${p(1)}`)}, ${activation})
}

// reconSeed${method} guarda una muestra por número, esperando el desenlace desde el instante que le toca, y devuelve sus ids.
func reconSeed${method}(t *testing.T, numbers []int, since []time.Time) []uuid.UUID {
	t.Helper()
	ids := make([]uuid.UUID, 0, len(numbers))
	for i, n := range numbers {
		state := sample${name}(t, n)
		if _, err := ${repo}.Save(t.Context(), domain.Rehydrate${name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
		reconExec(t, ${goString(`UPDATE ${table} SET ${stateColumn} = '${waitingState}', ${awaiting} = ${p(1)} WHERE id = ${p(2)}`)}, since[i], state.${id})
		ids = append(ids, state.${id})
	}
	return ids
}

// reconIDs${method} son los ids de lo reclamado, en el orden en que llegó.
func reconIDs${method}(claimed []*domain.${name}) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(claimed))
	for _, row := range claimed {
		ids = append(ids, row.${id}())
	}
	return ids
}

// reconStale${method} son n instantes de hace tres horas, un segundo entre cada uno: más que cualquier umbral de los defaults.
func reconStale${method}(n int) []time.Time {
	origin := time.Now().UTC().Add(-3 * time.Hour)
	out := make([]time.Time, n)
	for i := range out {
		out[i] = origin.Add(time.Duration(i) * time.Second)
	}
	return out
}`,
    (() => {
      const [stale, fresh] = take(2);
      return `func TestReconcile_${method}_TakesOnlyWhatOutlivedTheThresholdAndLeavesTheState(t *testing.T) {
	${clean}
	ids := reconSeed${method}(t, ${numbers([stale, fresh])}, []time.Time{reconStale${method}(1)[0], time.Now().UTC()})
	claimed, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if got := reconIDs${method}(claimed); !slices.Equal(got, ids[:1]) {
		t.Errorf("reclamados %v, quiero solo el que pasó el umbral %v", got, ids[:1])
	}
	var state string
	if err := must(probeTx.conn(t.Context())).QueryRowContext(t.Context(), ${goString(`SELECT ${stateColumn} FROM ${table} WHERE id = ${p(1)}`)}, ids[0]).Scan(&state); err != nil || state != ${goString(waitingState)} {
		t.Errorf("el reclamado está en %q (%v): el reclamo no cambia el estado", state, err)
	}
	if _, ok := reconMarkedAt(t, ${activation}, ids[0]); !ok {
		t.Error("el reclamado no tiene su marca")
	}
	if _, ok := reconMarkedAt(t, ${activation}, ids[1]); ok {
		t.Error("el que no pasó el umbral quedó marcado")
	}
}`;
    })(),
    (() => {
      const list = take(3);
      return `func TestReconcile_${method}_TheNextPassTakesTheOnesBehind(t *testing.T) {
	${clean}
	ids := reconSeed${method}(t, ${numbers(list)}, reconStale${method}(3))
	first, err := ${call}
	if err != nil || !slices.Equal(reconIDs${method}(first), ids[:2]) {
		t.Fatalf("la primera pasada = %v, %v; quiero los dos que más llevan %v", reconIDs${method}(first), err, ids[:2])
	}
	// La cabeza sigue esperando y marcada: no ocupa el lote de la pasada siguiente.
	if second, err := ${call}; err != nil || !slices.Equal(reconIDs${method}(second), ids[2:]) {
		t.Errorf("la segunda pasada = %v, %v; quiero el de detrás %v", reconIDs${method}(second), err, ids[2:])
	}
	if third, err := ${call}; err != nil || len(third) != 0 {
		t.Errorf("la tercera pasada = %v, %v; quiero nada: todo está marcado", reconIDs${method}(third), err)
	}
}`;
    })(),
    (() => {
      const [one] = take(1);
      return `func TestReconcile_${method}_WhatExpiredComesBack(t *testing.T) {
	${clean}
	ids := reconSeed${method}(t, ${numbers([one])}, reconStale${method}(1))
	if first, err := ${call}; err != nil || len(first) != 1 {
		t.Fatalf("la primera pasada = %v, %v; quiero el candidato", reconIDs${method}(first), err)
	}
	// La réplica que lo reclamó murió: pasada la caducidad, otra se lo lleva.
	expired := time.Now().UTC().Add(-${PROBE_RECONCILIATION}.Windows[${activation}].ClaimTimeout() - time.Second)
	reconExec(t, ${goString(`UPDATE ${RECONCILIATION_CLAIM.table} SET claimed_at = ${p(1)} WHERE activation = ${p(2)} AND entity_id = ${p(3)}`)}, expired, ${activation}, ids[0])
	if again, err := ${call}; err != nil || !slices.Equal(reconIDs${method}(again), ids) {
		t.Errorf("tras caducar = %v, %v; quiero %v otra vez", reconIDs${method}(again), err, ids)
	}
}`;
    })(),
    (() => {
      const list = take(4);
      return `func TestReconcile_${method}_TwoReplicasDoNotRepeat(t *testing.T) {
	${clean}
	ids := reconSeed${method}(t, ${numbers(list)}, reconStale${method}(4))
	batches := make(chan []uuid.UUID, 2)
	errs := make(chan error, 2)
	var replicas sync.WaitGroup
	for range 2 {
		replicas.Go(func() {
			claimed, err := ${call}
			errs <- err
			batches <- reconIDs${method}(claimed)
		})
	}
	replicas.Wait()
	close(batches)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("${method}: %v", err)
		}
	}
	var taken []uuid.UUID
	for batch := range batches {
		taken = append(taken, batch...)
	}
	// Las pasadas siguientes recogen lo que no cupo (en MySQL, con filesort, dos réplicas pueden llevarse menos que dos lotes).
	for range len(ids) {
		rest, err := ${call}
		if err != nil {
			t.Fatalf("${method}: %v", err)
		}
		if len(rest) == 0 {
			break
		}
		taken = append(taken, reconIDs${method}(rest)...)
	}
	seen := map[uuid.UUID]bool{}
	for _, row := range taken {
		if seen[row] {
			t.Errorf("el candidato %v lo reclamaron dos veces", row)
		}
		seen[row] = true
	}
	for _, row := range ids {
		if !seen[row] {
			t.Errorf("el candidato %v no lo reclamó nadie", row)
		}
	}
}`;
    })(),
    `func TestReconcile_${method}_RefusesToRunInsideAnotherTransaction(t *testing.T) {
	err := probeTx.Within(t.Context(), application.KindCommand, func(ctx context.Context) error {
		_, err := ${repo}.${method}(ctx)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "WithoutTransaction") {
		t.Errorf("${method} dentro de otra transacción = %v, quiero que se niegue", err)
	}
}`
  ];
}
