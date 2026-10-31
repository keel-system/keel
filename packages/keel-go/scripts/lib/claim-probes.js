// Las sondas de los RECLAMOS de barrido (tramo 10c) para db-check: ejecutan contra el motor real los métodos de reclamo
// que emite el adaptador de cada raíz (claim.js), como los llama el handler del barrido:
//
//   · la cola: se lleva el lote en orden, lo pasa a su destino con el reloj estampado en el MISMO UPDATE, y la pasada
//     siguiente sigue donde se quedó;
//   · dos réplicas a la vez se reparten las filas sin repetir ninguna;
//   · con otra réplica reteniendo una fila, se lleva las demás sin esperar (SKIP LOCKED);
//   · en MySQL, el lote se bloquea sin tomar los huecos entre claves (READ COMMITTED);
//   · el rescate se lleva solo lo abandonado, el más atascado primero, y lo ARRIENDA sin cambiar su estado;
//   · las sentencias del arnés EMITIDO (StallInFlight, PutInFlight, InFlightWithoutClock, leídas de
//     tests/integration/flow_test.go y no recalculadas desde keel-core: la lección del 16e de keel-dotnet) fabrican la
//     precondición que el rescate busca;
//   · el reclamo se niega a correr dentro de otra transacción.
//
// El reclamo es de la tabla ENTERA: antes de cada sonda se APARCAN en un estado que ningún reclamo mira las filas que
// otras sondas dejaron en un estado de partida. Cada sonda guarda sus propias muestras (números a partir de 300).

import { claimOrderField, claimsForEntity, rescueProbes, snakeCase, sweepClaims, sweepConfig } from '@keel-system/keel-core/gen';
import { goExported } from '../../src/lib/go-projection.js';
import { goString } from '../../src/lib/go-source.js';
import { sqlDialect } from '../../src/lib/relational-engine.js';
import { claimMethod, claimStatements, storedState, usesSweepClaims } from '../../src/scaffold/claim.js';
import { parametersType, usesServiceParameters } from '../../src/scaffold/service-parameters.js';

const CLAIM_SAMPLES = 300;

/** Las sentencias del rescate y el literal del id TAL COMO LOS EMITE el arnés de flujos, o null si no los trae. */
export function emittedRescues(files) {
  const flow = files.find((file) => file.path === 'tests/integration/flow_test.go')?.content;
  if (!flow) return null;
  const rescues = new Map();
  const block = flow.match(/var rescues = map\[string\]rescue\{\n([\s\S]*?)\n\}/);
  for (const line of block?.[1].split('\n') ?? []) {
    const entry = line.match(/^\t("(?:[^"\\]|\\.)*"):\s+\{("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\},$/);
    if (entry) rescues.set(JSON.parse(entry[1]), { stall: JSON.parse(entry[2]), put: JSON.parse(entry[3]), missing: JSON.parse(entry[4]) });
  }
  const literal = flow.match(/func idLiteral\(id string\) string \{\n\treturn ("(?:[^"\\]|\\.)*") \+ id \+ ("(?:[^"\\]|\\.)*")\n\}/);
  return { rescues, idLiteral: literal ? { prefix: JSON.parse(literal[1]), suffix: JSON.parse(literal[2]) } : null };
}

/** Las sondas de los reclamos del sujeto, o null si no tiene ninguno. `repo(root)` es el adaptador de las sondas. */
export function claimProbes(model, files, repo) {
  if (!usesSweepClaims(model)) return null;
  const harness = emittedRescues(files);
  const roots = [...new Set(sweepClaims(model).map(({ claim }) => claim.entity))].map((name) => model.entities.find((entity) => entity.name === name));
  return [prelude(model), ...roots.flatMap((root) => rootClaimProbes(model, root, repo(root), harness))].join('\n\n');
}

function prelude(model) {
  const batches = sweepConfig(model)
    .flatMap(({ key, entries }) => entries.filter((entry) => entry.kind === 'batch').map(() => `${goString(key)}: 2`))
    .join(', ');
  const needsParameters = sweepClaims(model).some(({ claim }) => claim.stalled?.parameter);
  const parameters =
    needsParameters && usesServiceParameters(model)
      ? `

// probeParameters son los parámetros de despliegue con su valor de prueba: el plazo del rescate sale de ahí.
var probeParameters = must(domain.New${parametersType(model)}(${model.service.parameters
          .map((parameter) => `ptr(${parameter.goType === 'string' ? goString(String(parameter.testValue)) : `${parameter.goType}(${parameter.testValue})`})`)
          .join(', ')}))`
      : '';
  return `// probeSweeps son los barridos de las sondas: lotes de DOS (con tres filas, dos pasadas) y los plazos de los defaults.
var probeSweeps = SweepSettings{BatchSize: map[string]int{${batches}}, StalledAfterSeconds: DefaultSweepSettings().StalledAfterSeconds}${parameters}

// claimExec ejecuta una sentencia de las sondas del reclamo por la conexión de los repositorios (en MySQL escribe el
// uuid como sus 16 bytes).
func claimExec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := must(probeTx.conn(t.Context())).ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

// instants son n instantes de hace una hora, un segundo entre cada uno: el orden de llegada de las muestras.
func instants(n int) []time.Time {
	origin := time.Now().UTC().Add(-time.Hour)
	out := make([]time.Time, n)
	for i := range out {
		out[i] = origin.Add(time.Duration(i) * time.Second)
	}
	return out
}`;
}

function rootClaimProbes(model, root, repo, harness) {
  const d = sqlDialect(model);
  const p = (n) => d.param(n);
  const name = root.name;
  const claims = claimsForEntity(model, name);
  const id = goExported(root.idField?.name ?? 'id');
  const idType = root.idField?.goType ?? 'uuid.UUID';
  const table = d.quote(root.tableName);
  const stateColumn = d.quote(snakeCase(root.lifecycle.field));
  const stored = (state) => storedState(model, root, state);
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const touched = new Set(claims.flatMap((claim) => [...claim.from, ...(claim.stalled ? [claim.stalled.state] : [])]));
  // El aparcamiento: un estado que ningún reclamo mira.
  const park = enumDef.values.map((value) => value.literal).find((literal) => !touched.has(literal));
  if (!park) throw new Error(`claim-probes: ${name} no tiene un estado que ningún reclamo mire donde aparcar las filas`);
  const parkSql = (states) => `UPDATE ${table} SET ${stateColumn} = '${stored(park)}' WHERE ${stateColumn} IN (${states.map((state) => `'${stored(state)}'`).join(', ')})`;
  const idArg = (expr) => (d.mysql ? `${expr}[:]` : expr);
  let next = CLAIM_SAMPLES;
  const take = (count) => Array.from({ length: count }, () => next++);
  const numbers = (list) => `[]int{${list.join(', ')}}`;
  // Deja cada muestra en `state` y, si se da `column`, con su instante (y el vencimiento, si el reclamo lo mira).
  const placeSql = (state, columns) => `UPDATE ${table} SET ${[`${stateColumn} = '${stored(state)}'`, ...columns.map((column, i) => `${d.quote(column)} = ${p(i + 1)}`)].join(', ')} WHERE id = ${p(columns.length + 1)}`;
  const parts = [];

  parts.push(`// seed${name}Claims guarda una muestra por número y la deja como dice place: con el instante de cada una en cada columna
// que place fija (instants vacío: solo el estado). Devuelve los ids en el orden de los números.
func seed${name}Claims(t *testing.T, numbers []int, place string, instants []time.Time, columns int) []${idType} {
	t.Helper()
	ids := make([]${idType}, 0, len(numbers))
	for i, n := range numbers {
		state := sample${name}(t, n)
		if _, err := ${repo}.Save(t.Context(), domain.Rehydrate${name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
		args := make([]any, 0, columns+1)
		for range columns {
			args = append(args, instants[i])
		}
		claimExec(t, place, append(args, state.${id})...)
		ids = append(ids, state.${id})
	}
	return ids
}

// stateOf${name} es el estado guardado (la constante de su enum) de la fila id.
func stateOf${name}(t *testing.T, id ${idType}) string {
	t.Helper()
	var state string
	if err := must(probeTx.conn(t.Context())).QueryRowContext(t.Context(), ${goString(`SELECT ${stateColumn} FROM ${table} WHERE id = ${p(1)}`)}, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

// ids${name} son los ids de lo reclamado, en el orden en que llegó.
func ids${name}(claimed []*domain.${name}) []${idType} {
	ids := make([]${idType}, 0, len(claimed))
	for _, row := range claimed {
		ids = append(ids, row.${id}())
	}
	return ids
}`);

  for (const claim of claims) {
    const method = claimMethod(claim);
    const call = `${repo}.${method}(t.Context())`;
    if (claim.stalled) {
      const clock = snakeCase(claim.stalled.stampField);
      const place = placeSql(claim.stalled.state, [clock]);
      const [stale1, stale2, fresh] = take(3);
      parts.push(`func TestRescue_${method}_OnlyWhatIsAbandonedAndLeasesItWithoutChangingTheState(t *testing.T) {
	claimExec(t, ${goString(parkSql([claim.stalled.state]))})
	now := time.Now().UTC()
	ids := seed${name}Claims(t, ${numbers([stale1, stale2, fresh])}, ${goString(place)}, []time.Time{now.AddDate(0, 0, -10), now.AddDate(0, 0, -10).Add(time.Second), now}, 1)
	rescued, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	// Solo los abandonados, el más atascado primero; el recién entrado en vuelo no se toca.
	if got := ids${name}(rescued); !slices.Equal(got, ids[:2]) {
		t.Errorf("rescatados %v, quiero los dos abandonados %v", got, ids[:2])
	}
	for _, row := range ids {
		if got := stateOf${name}(t, row); got != ${goString(stored(claim.stalled.state))} {
			t.Errorf("la fila %v está en %s: el rescate no cambia el estado", row, got)
		}
	}
	clockOf := func(row ${idType}) time.Time {
		var at time.Time
		if err := must(probeTx.conn(t.Context())).QueryRowContext(t.Context(), ${goString(`SELECT ${d.quote(clock)} FROM ${table} WHERE id = ${p(1)}`)}, row).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	if at := clockOf(ids[2]); at.Sub(now).Abs() > time.Second {
		t.Errorf("el fresco tiene el reloj en %v, quiero el suyo (%v)", at, now)
	}
	if at := clockOf(ids[0]); at.Before(now.Add(-time.Second)) {
		t.Errorf("el rescatado tiene el reloj en %v: tenía que quedar renovado (arrendado)", at)
	}
	// Arrendado: la pasada siguiente no vuelve a llevárselo.
	if again, err := ${call}; err != nil || len(again) != 0 {
		t.Errorf("la pasada siguiente = %v, %v; quiero nada", ids${name}(again), err)
	}
}`);
      const rescue = rescueProbes(model).find((probe) => probe.operation === sweepClaims(model).find((entry) => entry.claim === claim)?.operation.name);
      if (!rescue) continue;
      const emitted = harness?.rescues.get(rescue.operation);
      if (!emitted || !harness.idLiteral) {
        parts.push(`func TestRescue_${method}_TheHarnessEmitsItsStatements(t *testing.T) {
	t.Fatal(${goString(`el arnés emitido no trae ${emitted ? 'idLiteral' : `el rescate de ${rescue.operation}`} en tests/integration/flow_test.go`)})
}`);
        continue;
      }
      const [stalled, put] = take(2);
      const literal = (variable) => `${goString(harness.idLiteral.prefix)} + ${variable}.String() + ${goString(harness.idLiteral.suffix)}`;
      parts.push(`func TestRescue_${method}_TheHarnessStatementsBuildItsPrecondition(t *testing.T) {
	claimExec(t, ${goString(parkSql([claim.stalled.state]))})
	ids := seed${name}Claims(t, ${numbers([stalled, put])}, ${goString(placeSql(park, []))}, nil, 0)
	// Las sentencias que StallInFlight y PutInFlight del arnés EMITIDO ejecutan, montadas como las monta su idLiteral, y la
	// de InFlightWithoutClock: ninguna fila en vuelo sin reloj.
	for _, statement := range []string{${goString(emitted.stall)} + ${literal('ids[0]')}, ${goString(emitted.put)} + ${literal('ids[1]')}} {
		if _, err := probeDB.ExecContext(t.Context(), statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	var missing int64
	if err := probeDB.QueryRowContext(t.Context(), ${goString(emitted.missing)}).Scan(&missing); err != nil || missing != 0 {
		t.Errorf("InFlightWithoutClock = %d, %v; quiero 0", missing, err)
	}
	rescued, err := ${call}
	if got := ids${name}(rescued); err != nil || !slices.Equal(got, ids[:1]) {
		t.Errorf("${method} = %v, %v; quiero solo la atascada por StallInFlight %v", got, err, ids[:1])
	}
}`);
      continue;
    }
    const order = snakeCase(claimOrderField(root, claim));
    const columns = [...(order === 'id' ? [] : [order]), ...(claim.due ? [snakeCase(claim.due.field)] : [])];
    const place = placeSql(claim.from[0], columns);
    const sql = claimStatements(model, root, claim);
    const seed = (list) => `seed${name}Claims(t, ${numbers(list)}, ${goString(place)}, instants(${list.length}), ${columns.length})`;
    const stamp = claim.stamps
      ? `
	// El reloj que vigila el rescate, estampado en el MISMO UPDATE que el cambio de estado.
	for _, row := range first {
		var stamped bool
		if err := must(probeTx.conn(t.Context())).QueryRowContext(t.Context(), ${goString(`SELECT ${d.quote(snakeCase(claim.stamps.field))} IS NOT NULL FROM ${table} WHERE id = ${p(1)}`)}, row.${id}()).Scan(&stamped); err != nil || !stamped {
			t.Errorf("la fila %v quedó en ${claim.to} sin ${claim.stamps.field}: %v", row.${id}(), err)
		}
	}`
      : '';
    const [a, b, c] = take(3);
    parts.push(`func TestClaim_${method}_TakesTheBatchInOrderAndTheNextPassContinues(t *testing.T) {
	claimExec(t, ${goString(parkSql(claim.from))})
	ids := ${seed([a, b, c])}
	first, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if got := ids${name}(first); !slices.Equal(got, ids[:2]) {
		t.Errorf("el lote es %v, quiero los dos más antiguos %v", got, ids[:2])
	}
	if got := stateOf${name}(t, ids[0]); got != ${goString(stored(claim.to))} {
		t.Errorf("lo reclamado está en %s, quiero ${stored(claim.to)}", got)
	}
	if got := stateOf${name}(t, ids[2]); got != ${goString(stored(claim.from[0]))} {
		t.Errorf("lo que no cupo en el lote está en %s, quiero ${stored(claim.from[0])}", got)
	}${stamp}
	if second, err := ${call}; err != nil || !slices.Equal(ids${name}(second), ids[2:]) {
		t.Errorf("la pasada siguiente = %v, %v; quiero %v", ids${name}(second), err, ids[2:])
	}
	if third, err := ${call}; err != nil || len(third) != 0 {
		t.Errorf("la tercera pasada = %v, %v; quiero nada", ids${name}(third), err)
	}
}`);
    const race = take(4);
    parts.push(`func TestClaim_${method}_TwoReplicasShareTheRowsWithoutRepeating(t *testing.T) {
	claimExec(t, ${goString(parkSql(claim.from))})
	ids := ${seed(race)}
	batches := make(chan []${idType}, 2)
	errs := make(chan error, 2)
	var replicas sync.WaitGroup
	for range 2 {
		replicas.Go(func() {
			claimed, err := ${call}
			errs <- err
			batches <- ids${name}(claimed)
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
	var taken []${idType}
	for batch := range batches {
		taken = append(taken, batch...)
	}
	// En MySQL, con filesort, InnoDB bloquea todas las filas que examina y no solo las del LIMIT: dos réplicas a la vez
	// pueden llevarse menos que dos lotes. Lo que importa es que no se repita ninguna: las pasadas siguientes recogen el resto.
	for range len(ids) {
		rest, err := ${call}
		if err != nil {
			t.Fatalf("${method}: %v", err)
		}
		if len(rest) == 0 {
			break
		}
		taken = append(taken, ids${name}(rest)...)
	}
	seen := map[${idType}]bool{}
	for _, row := range taken {
		if seen[row] {
			t.Errorf("la fila %v la reclamaron dos veces", row)
		}
		seen[row] = true
	}
	for _, row := range ids {
		if !seen[row] {
			t.Errorf("la fila %v no la reclamó nadie", row)
		}
	}
}`);
    const [held, free] = take(2);
    parts.push(`func TestClaim_${method}_SkipsARowHeldByAnotherReplica(t *testing.T) {
	claimExec(t, ${goString(parkSql(claim.from))})
	ids := ${seed([held, free])}
	holder, err := probeDB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback() }()
	var one int
	if err := holder.QueryRowContext(t.Context(), ${goString(`SELECT 1 FROM ${table} WHERE id = ${p(1)} FOR UPDATE`)}, ${idArg('ids[0]')}).Scan(&one); err != nil {
		t.Fatalf("retener la fila: %v", err)
	}
	// SKIP LOCKED: se lleva la otra al momento en vez de esperar al lock (con FOR UPDATE a secas, esperaría).
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	started := time.Now()
	claimed, err := ${repo}.${method}(ctx)
	if err != nil {
		t.Fatalf("${method} con una fila retenida: %v (tras %v): el reclamo esperó en vez de saltarla", err, time.Since(started))
	}
	if got := ids${name}(claimed); !slices.Equal(got, ids[1:]) {
		t.Errorf("con la primera retenida, el lote es %v, quiero %v", got, ids[1:])
	}
}`);
    if (d.mysql) {
      const [pending] = take(1);
      // El AISLAMIENTO del reclamo: en el REPEATABLE READ por defecto la lectura con bloqueo toma los HUECOS entre claves
      // (next-key y gap locks), y un INSERT cuya clave caiga en uno espera al lock wait timeout. Se mira la causa: los
      // bloqueos de ESTA transacción, abierta con las opciones de los reclamos emitidos, son todos de registro.
      parts.push(`func TestClaim_${method}_LocksTheBatchWithoutGaps(t *testing.T) {
	claimExec(t, ${goString(parkSql(claim.from))})
	${seed([pending])}
	tx, err := probeDB.BeginTx(t.Context(), &claimOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(t.Context(), ${goString(sql.candidates)}, ${sql.candidateArgs.map((arg) => (arg === 'batch' ? '2' : 'time.Now().UTC()')).join(', ')})
	if err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	locks, err := tx.QueryContext(t.Context(), "SELECT LOCK_MODE FROM performance_schema.data_locks WHERE THREAD_ID = PS_CURRENT_THREAD_ID() AND LOCK_TYPE = 'RECORD'")
	if err != nil {
		t.Fatal(err)
	}
	defer locks.Close()
	var modes []string
	for locks.Next() {
		var mode string
		if err := locks.Scan(&mode); err != nil {
			t.Fatal(err)
		}
		modes = append(modes, mode)
	}
	if len(modes) == 0 {
		t.Fatal("la lectura del lote no bloqueó nada")
	}
	for _, mode := range modes {
		if !strings.Contains(mode, "REC_NOT_GAP") {
			t.Errorf("bloqueos %v: la lectura del lote toma huecos entre claves (%s)", modes, mode)
		}
	}
}`);
    }
  }
  const first = claimMethod(claims[0]);
  parts.push(`func TestClaim_${name}_RefusesToRunInsideAnotherTransaction(t *testing.T) {
	err := probeTx.Within(t.Context(), application.KindCommand, func(ctx context.Context) error {
		_, err := ${repo}.${first}(ctx)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "WithoutTransaction") {
		t.Errorf("${first} dentro de otra transacción = %v, quiero que se niegue", err)
	}
}`);
  return parts;
}
