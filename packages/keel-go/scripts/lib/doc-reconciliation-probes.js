// Las sondas del reclamo de RECONCILIACIÓN sobre documentos (tramo 13h-b) para doc-check: ejecutan contra un MongoDB real la
// marca emitida (`claimReconciliation`, en reconciliation.go) y el reclamo del adaptador de la raíz que espera, como los llama
// el barrido. Las mismas preguntas que las de la rama relacional (reconciliation-probes.js) y que el doc-check de keel-dotnet:
//
//   · la marca: sin marca inserta; con la marca VIVA no; la CADUCADA justo en el límite (`<=`) se renueva; es por activación;
//     tres réplicas a la vez a por el mismo candidato y gana una; y su documento es el del contrato (clave aplanada + campos);
//   · el reclamo: solo lo que pasó el umbral y está en su estado de espera, el que más lleva primero, con el estado intacto; la
//     pasada siguiente se lleva al de DETRÁS; lo caducado vuelve; dos réplicas a la vez no repiten; y se niega a correr dentro
//     de otra transacción.

import { RECONCILIATION_CLAIM, reconciliationClaims } from '@keel-system/keel-core/gen/reconciliation-stores';
import { storeDocumentKey } from '@keel-system/keel-core/gen/document';
import { snakeCase } from '@keel-system/keel-core/gen';
import { goExported } from '../../src/lib/go-projection.js';
import { goString } from '../../src/lib/go-source.js';
import { storedState } from '../../src/scaffold/claim.js';
import { reconciliationMethod, usesReconciliationClaims } from '../../src/scaffold/reconciliation-claim.js';

const SAMPLES = 400;
// El lote de las sondas: con tres candidatos, dos pasadas.
const BATCH = 2;

/** Los barridos de las sondas, que el adaptador de las sondas recibe (doc-probes.js: `repository`). */
export const PROBE_RECONCILIATION = 'probeReconciliation';

/** Las sondas del reclamo de reconciliación del sujeto, o null sin ninguno. `repo(root)` es el adaptador. */
export function docReconciliationProbes(model, repo) {
  if (!usesReconciliationClaims(model)) return null;
  const claims = reconciliationClaims(model);
  const parts = [prelude(claims), ...storeProbes(claims[0])];
  for (const claim of claims) {
    const root = model.entities.find((entity) => entity.name === claim.entity);
    parts.push(...claimProbes(model, root, claim, repo(root)));
  }
  return parts.join('\n\n');
}

function prelude(claims) {
  const windows = claims.map((claim) => `${goString(claim.activation)}: {UnansweredAfterSeconds: ${claim.parameters.unansweredAfterSeconds.default}, ClaimTimeoutMs: ${claim.parameters.claimTimeoutMs.default}, BatchSize: ${BATCH}}`);
  return `// ${PROBE_RECONCILIATION} son los barridos de reconciliación de las sondas: el umbral y la caducidad de los defaults, y lotes de
// ${BATCH} (con tres candidatos, dos pasadas).
var ${PROBE_RECONCILIATION} = ReconciliationSettings{Windows: map[string]ReconciliationWindow{${windows.join(', ')}}}

// reconMark reclama entityID para activation, como el adaptador.
func reconMark(t *testing.T, activation string, entityID uuid.UUID, now, expiredBefore time.Time) bool {
	t.Helper()
	won, err := claimReconciliation(t.Context(), probeTx, activation, entityID, now, expiredBefore)
	if err != nil {
		t.Fatalf("claimReconciliation: %v", err)
	}
	return won
}`;
}

function storeProbes(claim) {
  const activation = goString(claim.activation);
  const collection = goString(RECONCILIATION_CLAIM.table);
  const key = storeDocumentKey(RECONCILIATION_CLAIM);
  const [activationField, entityField] = key.columns;
  return [
    `func TestReconciliationStore_InsertsTheContractDocumentAndRespectsTheLiveMark(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC().Truncate(time.Millisecond)
	expired := now.Add(-time.Minute)
	if !reconMark(t, ${activation}, id, now, expired) {
		t.Fatal("sin marca, la inserción es el reclamo: quiero true")
	}
	// El documento del contrato: la clave aplanada en el _id y las dos columnas además como campos, con la marca como fecha.
	raw, err := probeDB.Collection(${collection}).FindOne(t.Context(), bson.D{{Key: "_id", Value: ${activation} + ${goString(key.separator)} + id.String()}}).Raw()
	if err != nil {
		t.Fatalf("el reclamo no dejó su marca en ${RECONCILIATION_CLAIM.table}: %v", err)
	}
	if got := raw.Lookup(${goString(activationField)}).StringValue(); got != ${activation} {
		t.Errorf("${activationField} = %q", got)
	}
	if got, err := get(raw, ${goString(entityField)}, asUUID); err != nil || got != id {
		t.Errorf("${entityField} = %v (%v), quiero %v como uuid binario", got, err, id)
	}
	if got, err := get(raw, "claimed_at", asInstant); err != nil || !got.Equal(now) {
		t.Errorf("claimed_at = %v (%v), quiero %v", got, err, now)
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
	raw, err := probeDB.Collection(${collection}).FindOne(t.Context(), bson.D{{Key: "_id", Value: ${activation} + ${goString(key.separator)} + id.String()}}).Raw()
	if err != nil {
		t.Fatal(err)
	}
	if at, err := get(raw, "claimed_at", asInstant); err != nil || !at.Equal(now) {
		t.Errorf("la marca renovada dice %v (%v), quiero %v", at, err, now)
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
			won, err := claimReconciliation(t.Context(), probeTx, ${activation}, id, now, now.Add(-time.Minute))
			if err != nil {
				t.Errorf("claimReconciliation: %v", err)
			}
			if won {
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

function claimProbes(model, root, claim, repo) {
  const name = root.name;
  const method = reconciliationMethod(claim);
  const call = `${repo}.${method}(t.Context())`;
  const id = goExported(root.idField?.name ?? 'id');
  const collection = goString(root.collectionName);
  const marks = goString(RECONCILIATION_CLAIM.table);
  const stateKey = goString(snakeCase(root.lifecycle.field));
  const awaiting = goString(snakeCase(claim.awaitingField));
  const waiting = goString(storedState(model, root, claim.states[0]));
  const activation = goString(claim.activation);
  const key = storeDocumentKey(RECONCILIATION_CLAIM);
  return [
    `// reconClean${method} vacía la colección y las marcas de la activación: el reclamo es de la colección entera.
func reconClean${method}(t *testing.T) {
	t.Helper()
	if _, err := probeDB.Collection(${collection}).DeleteMany(t.Context(), bson.D{}); err != nil {
		t.Fatal(err)
	}
	if _, err := probeDB.Collection(${marks}).DeleteMany(t.Context(), bson.D{{Key: ${goString(key.columns[0])}, Value: ${activation}}}); err != nil {
		t.Fatal(err)
	}
}

// reconSeed${method} guarda una muestra por número, esperando el desenlace desde el instante que le toca, y devuelve sus ids.
func reconSeed${method}(t *testing.T, first int, since []time.Time) []uuid.UUID {
	t.Helper()
	ids := make([]uuid.UUID, 0, len(since))
	for i, at := range since {
		state := sample${name}(t, first+i)
		if _, err := ${repo}.Save(t.Context(), domain.Rehydrate${name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
		update := bson.D{{Key: "$set", Value: bson.D{{Key: ${stateKey}, Value: ${waiting}}, {Key: ${awaiting}, Value: instantValue(at)}}}}
		if _, err := probeDB.Collection(${collection}).UpdateOne(t.Context(), bson.D{{Key: "_id", Value: uuidValue(state.${id})}}, update); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, state.${id})
	}
	return ids
}

// reconIDs${method} son los ids de lo reclamado, en el orden en que llegó.
func reconIDs${method}(claimed []*domain.${name}) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(claimed))
	for _, aggregate := range claimed {
		ids = append(ids, aggregate.${id}())
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
    `func Test${name}_${method}_TakesOnlyWhatOutlivedTheThresholdAndLeavesTheState(t *testing.T) {
	reconClean${method}(t)
	ids := reconSeed${method}(t, ${SAMPLES}, []time.Time{reconStale${method}(1)[0], time.Now().UTC(), reconStale${method}(1)[0]})
	// El tercero salió de la espera: tampoco es candidato, aunque su marca lleve horas.
	if _, err := probeDB.Collection(${collection}).UpdateOne(t.Context(), bson.D{{Key: "_id", Value: uuidValue(ids[2])}}, bson.D{{Key: "$set", Value: bson.D{{Key: ${stateKey}, Value: "PROBE_PARKED"}}}}); err != nil {
		t.Fatal(err)
	}
	claimed, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if got := reconIDs${method}(claimed); !slices.Equal(got, ids[:1]) {
		t.Fatalf("${method} se lleva %v, quiero solo el rancio en espera %v", got, ids[0])
	}
	raw, err := probeDB.Collection(${collection}).FindOne(t.Context(), bson.D{{Key: "_id", Value: uuidValue(ids[0])}}).Raw()
	if err != nil {
		t.Fatal(err)
	}
	if got := raw.Lookup(${stateKey}).StringValue(); got != ${waiting} {
		t.Errorf("el reclamo cambió el estado a %q: el estado de espera es justo lo que el barrido busca", got)
	}
}`,
    `func Test${name}_${method}_TheNextPassTakesWhatIsBehindAndTheExpiredComesBack(t *testing.T) {
	reconClean${method}(t)
	ids := reconSeed${method}(t, ${SAMPLES + 10}, reconStale${method}(3))
	first, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if got := reconIDs${method}(first); !slices.Equal(got, ids[:2]) {
		t.Fatalf("la primera pasada se lleva %v, quiero los dos que más llevan %v", got, ids[:2])
	}
	// La cabeza, marcada y sin resolver, no ocupa el lote: la pasada siguiente se lleva al de detrás.
	second, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if got := reconIDs${method}(second); !slices.Equal(got, ids[2:]) {
		t.Fatalf("la segunda pasada se lleva %v, quiero el de detrás %v", got, ids[2:])
	}
	third, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if len(third) != 0 {
		t.Fatalf("con todas las marcas vivas, la tercera pasada se lleva %v", reconIDs${method}(third))
	}
	// La réplica murió con el candidato en vuelo: su marca caduca y otra lo recoge.
	window := ${PROBE_RECONCILIATION}.Windows[${activation}]
	expired := time.Now().UTC().Add(-window.ClaimTimeout() - time.Minute)
	if _, err := probeDB.Collection(${marks}).UpdateOne(t.Context(), bson.D{{Key: "_id", Value: ${activation} + ${goString(key.separator)} + ids[1].String()}}, bson.D{{Key: "$set", Value: bson.D{{Key: "claimed_at", Value: instantValue(expired)}}}}); err != nil {
		t.Fatal(err)
	}
	back, err := ${call}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if got := reconIDs${method}(back); !slices.Equal(got, ids[1:2]) {
		t.Fatalf("tras caducar se lleva %v, quiero %v", got, ids[1])
	}
}`,
    `func Test${name}_${method}_TwoReplicasAtOnceDoNotRepeat(t *testing.T) {
	reconClean${method}(t)
	reconSeed${method}(t, ${SAMPLES + 20}, reconStale${method}(4))
	batches := make(chan []uuid.UUID, 2)
	var replicas sync.WaitGroup
	for range 2 {
		replicas.Go(func() {
			claimed, err := ${call}
			if err != nil {
				t.Errorf("${method}: %v", err)
			}
			batches <- reconIDs${method}(claimed)
		})
	}
	replicas.Wait()
	close(batches)
	seen := map[uuid.UUID]bool{}
	for batch := range batches {
		for _, id := range batch {
			if seen[id] {
				t.Errorf("dos réplicas se llevaron %s", id)
			}
			seen[id] = true
		}
	}
}`,
    `func Test${name}_${method}_RefusesToRunInsideATransaction(t *testing.T) {
	reconClean${method}(t)
	err := probeTx.Within(t.Context(), application.KindCommand, func(ctx context.Context) error {
		_, err := ${repo}.${method}(ctx)
		return err
	})
	if err == nil {
		t.Error("${method} dentro de una transacción abierta no es un error: su marca no existiría para las demás réplicas hasta el commit")
	}
}`
  ];
}
