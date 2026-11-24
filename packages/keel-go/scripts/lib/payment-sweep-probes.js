// Las sondas del reclamo del BARRIDO DE PAGOS (G11 de PLAN-CORRIDAS-GELSA.md, inc. 6c) para db-check: ejecutan contra el
// motor real el `ClaimForPaymentSweep` que build genera en el adaptador del registro de cobros. Los casos de claim-check de
// keel-spring y de db-check de keel-nest y keel-dotnet, con los nombres de Go:
//
//   · PS1: lo rancio entra SIN mover el estado y con el reloj renovado, así que una segunda pasada inmediata no lo toma;
//   · PS2: lo recién puesto en espera no; PS3: lo de otro estado no;
//   · PS4: cada estado en espera entra; PS5: el lote va acotado por su argumento; PS6: una fila sin reloj no la toma nadie;
//   · PS7: dos réplicas a la vez no se llevan el mismo cobro, y con una pasada más (el filesort de MySQL bloquea más filas
//     de las que devuelve) se llevan todos. Esa pasada solo no repite lo reclamado si el reloj se renovó.
//
// El reclamo es de la tabla ENTERA: antes de cada sonda se APARCAN en un estado que el barrido no mira las filas que otras
// sondas dejaron esperando. Cada sonda guarda sus propias muestras (números a partir de 600).

import { snakeCase, screamingSnake } from '@keel-system/keel-core/gen';
import { goExported } from '../../src/lib/go-projection.js';
import { goString } from '../../src/lib/go-source.js';
import { sqlDialect } from '../../src/lib/relational-engine.js';
import { paymentSweepClaim } from '../../src/scaffold/payment-sweep-claim.js';

const SAMPLES = 600;

/** Las sondas del reclamo del barrido de pagos del sujeto, o null si no lo tiene. `repo(root)` es el adaptador. */
export function paymentSweepProbes(model, repo) {
  const root = (model.entities ?? []).find((entity) => paymentSweepClaim(model, entity));
  if (!root) return null;
  const claim = paymentSweepClaim(model, root);
  const d = sqlDialect(model);
  const p = d.param;
  const name = root.name;
  const id = goExported(root.idField?.name ?? 'id');
  const table = d.quote(root.tableName);
  const stateColumn = d.quote(snakeCase(root.lifecycle.field));
  const stamp = d.quote(snakeCase(claim.stampField));
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const stored = (state) => enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
  const waiting = claim.states.map(stored);
  const other = enumDef.values.map((value) => value.literal).find((literal) => !claim.states.includes(literal));
  if (!other) throw new Error(`payment-sweep-probes: ${name} no tiene un estado fuera de la espera donde aparcar las filas`);
  let next = SAMPLES;
  const call = (cutoff, batch) => `${repo(root)}.ClaimForPaymentSweep(t.Context(), ${cutoff}, ${batch})`;
  const seed = (variable, state, at) => `	${variable} ${variable === '_' ? '=' : ':='} paySweepSeed(t, ${next++}, ${goString(state)}, ${at})`;
  const ago = (minutes) => `time.Now().UTC().Add(-${minutes} * time.Minute)`;
  const parts = [
    `// paySweepPark aparca lo que otras sondas dejaron esperando: el reclamo del barrido de pagos es de la tabla entera.
func paySweepPark(t *testing.T) {
	t.Helper()
	if _, err := must(probeTx.conn(t.Context())).ExecContext(t.Context(), ${goString(`UPDATE ${table} SET ${stateColumn} = '${stored(other)}' WHERE ${stateColumn} IN (${waiting.map((state) => `'${state}'`).join(', ')})`)}); err != nil {
		t.Fatal(err)
	}
}

// paySweepSeed guarda la muestra n y la deja en ese estado con ese reloj (nil: sin reloj), y devuelve su id.
func paySweepSeed(t *testing.T, n int, state string, at any) uuid.UUID {
	t.Helper()
	sample := sample${name}(t, n)
	if _, err := ${repo(root)}.Save(t.Context(), domain.Rehydrate${name}(sample)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := must(probeTx.conn(t.Context())).ExecContext(t.Context(), ${goString(`UPDATE ${table} SET ${stateColumn} = ${p(1)}, ${stamp} = ${p(2)} WHERE id = ${p(3)}`)}, state, at, sample.${id}); err != nil {
		t.Fatal(err)
	}
	return sample.${id}
}

// paySweepIDs son los ids de lo reclamado.
func paySweepIDs(claimed []*domain.${name}) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(claimed))
	for _, row := range claimed {
		ids = append(ids, row.${id}())
	}
	return ids
}`
  ];
  parts.push(`func TestPaymentSweep_PS1_TakesTheStaleWithoutMovingTheStateAndRenewsTheClock(t *testing.T) {
	paySweepPark(t)
${seed('stale', waiting[0], ago(60))}
	cutoff := ${ago(10)}
	claimed, err := ${call('cutoff', 10)}
	if err != nil || !slices.Equal(paySweepIDs(claimed), []uuid.UUID{stale}) {
		t.Fatalf("ClaimForPaymentSweep = %v, %v; quiero solo el rancio %v", paySweepIDs(claimed), err, stale)
	}
	var state string
	var clock time.Time
	if err := must(probeTx.conn(t.Context())).QueryRowContext(t.Context(), ${goString(`SELECT ${stateColumn}, ${stamp} FROM ${table} WHERE id = ${p(1)}`)}, stale).Scan(&state, &clock); err != nil {
		t.Fatal(err)
	}
	if state != ${goString(waiting[0])} || !clock.After(cutoff) {
		t.Errorf("tras el reclamo: estado %q y reloj %v; quiero el estado intacto y el reloj renovado (después de %v)", state, clock, cutoff)
	}
	if again, err := ${call('cutoff', 10)}; err != nil || len(again) != 0 {
		t.Errorf("una segunda pasada inmediata = %v, %v; quiero nada: el reclamo renovó el reloj", paySweepIDs(again), err)
	}
}`);
  parts.push(`func TestPaymentSweep_PS2_LeavesTheFreshlyAwaiting(t *testing.T) {
	paySweepPark(t)
${seed('_', waiting[0], 'time.Now().UTC()')}
	if claimed, err := ${call(ago(10), 10)}; err != nil || len(claimed) != 0 {
		t.Errorf("ClaimForPaymentSweep = %v, %v; quiero nada: acaba de entrar en espera", paySweepIDs(claimed), err)
	}
}`);
  parts.push(`func TestPaymentSweep_PS3_LeavesOtherStates(t *testing.T) {
	paySweepPark(t)
${seed('_', stored(other), ago(60))}
	if claimed, err := ${call(ago(10), 10)}; err != nil || len(claimed) != 0 {
		t.Errorf("ClaimForPaymentSweep = %v, %v; quiero nada: no espera a la pasarela", paySweepIDs(claimed), err)
	}
}`);
  parts.push(`func TestPaymentSweep_PS4_CoversEveryAwaitingState(t *testing.T) {
	paySweepPark(t)
${waiting.map((state) => seed('_', state, ago(60))).join('\n')}
	if claimed, err := ${call(ago(10), 50)}; err != nil || len(claimed) != ${waiting.length} {
		t.Errorf("ClaimForPaymentSweep = %d, %v; quiero los ${waiting.length} estados en espera", len(claimed), err)
	}
}`);
  parts.push(`func TestPaymentSweep_PS5_BoundsTheBatch(t *testing.T) {
	paySweepPark(t)
${[0, 1, 2].map((i) => seed('_', waiting[0], ago(60 + i))).join('\n')}
	if claimed, err := ${call(ago(10), 2)}; err != nil || len(claimed) != 2 {
		t.Errorf("ClaimForPaymentSweep = %d, %v; quiero 2: el lote va acotado", len(claimed), err)
	}
}`);
  parts.push(`func TestPaymentSweep_PS6_LeavesARowWithoutClock(t *testing.T) {
	paySweepPark(t)
	// NULL < staleBefore no es falso, es UNKNOWN: la fila no entra en ningún lote.
${seed('_', waiting[0], 'nil')}
	if claimed, err := ${call(ago(10), 10)}; err != nil || len(claimed) != 0 {
		t.Errorf("ClaimForPaymentSweep = %v, %v; quiero nada: sin reloj", paySweepIDs(claimed), err)
	}
}`);
  parts.push(`func TestPaymentSweep_PS7_TwoReplicasDoNotTakeTheSamePayment(t *testing.T) {
	paySweepPark(t)
	var raced []uuid.UUID
${[0, 1, 2, 3, 4, 5].map((i) => `${seed(`raced${i}`, waiting[0], ago(60 + i))}\n	raced = append(raced, raced${i})`).join('\n')}
	cutoff := ${ago(10)}
	batches := make(chan []uuid.UUID, 2)
	errs := make(chan error, 2)
	var replicas sync.WaitGroup
	for range 2 {
		replicas.Go(func() {
			claimed, err := ${call('cutoff', 6)}
			errs <- err
			batches <- paySweepIDs(claimed)
		})
	}
	replicas.Wait()
	close(batches)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var taken []uuid.UUID
	for batch := range batches {
		taken = append(taken, batch...)
	}
	rest, err := ${call('cutoff', 6)}
	if err != nil {
		t.Fatal(err)
	}
	taken = append(taken, paySweepIDs(rest)...)
	slices.SortFunc(taken, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	slices.SortFunc(raced, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	if !slices.Equal(taken, raced) {
		t.Errorf("entre las dos réplicas y la pasada siguiente = %v; quiero cada cobro una vez %v", taken, raced)
	}
}`);
  return parts.join('\n\n');
}
