// Las sondas de doc-check (incremento 12): una prueba Go por sujeto, generada desde el modelo, que EJECUTA los adaptadores
// documentales emitidos contra un MongoDB real en replica set. Va en el paquete del adaptador
// (`internal/infrastructure/mongo/doc_probe_test.go`) para alcanzar lo no exportado (la transacción, `outside`,
// `appendOutbox`), y no es parte del proyecto generado.
//
// Lo que solo ve esta red:
//   · el documento CRUDO contra el contrato de keel-core (`documentShape`), a todo nivel: cada clave con su tipo BSON
//     (uuid binario de subtipo 4, Decimal128, fecha BSON, Int32/Int64) y ninguna de más. La ida y vuelta con el propio
//     adaptador sale verde con cualquier representación: solo el documento crudo dice si el otro servidor lo leería;
//   · los índices VIVOS contra `documentIndexes` (nombre, claves en orden, unicidad, filtro parcial, ninguno de más),
//     creados dos veces;
//   · la transacción: dos casos de uso a la vez sobre el mismo documento confirman los dos (el conflicto transitorio se
//     repite entero), y uno que choca siempre agota sus reintentos y sale con el 409 de concurrencia;
//   · los almacenes del generador (outbox, registro de procesados, registro de idempotencia, purgas) y los reclamos de
//     barrido, por su API.
// Lo que no depende del motor (las muestras, los volcados, la ida y vuelta, la versión, las unicidades con su code y su
// mensaje, la fusión de hijas, la página, los finders) es lo MISMO que mide db-check: sale de db-probes.js.

import { DOCUMENT_ID, documentShape, valueObjectShape } from '@keel-system/keel-core/gen/document';
import { claimsForEntity, snakeCase } from '@keel-system/keel-core/gen';
import { repositoryRoots } from '@keel-system/keel-core/gen/features';
import { goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { storeDir } from '../../src/lib/relational-engine.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { isOptional } from '../../src/scaffold/render.js';
import { claimMethod, storedState, usesSweepClaims } from '../../src/scaffold/claim.js';
import { usesGoOutbox, usesGoProcessedEvents } from '../../src/scaffold/messaging.js';
import { usesRequestIdempotency } from '../../src/scaffold/request-idempotency.js';
import { tablePurges } from '../../src/scaffold/purge.js';
import { indexEntries } from '../../src/scaffold/document-persistence.js';
import { sweepClaims, sweepConfig } from '@keel-system/keel-core/gen';
import { parametersType, usesServiceParameters } from '../../src/scaffold/service-parameters.js';
import { PROBE_HELPERS, concurrencyCode, dumpFunction, dumpValueObject, ensureFunction, patternTables, rootProbes, sampleFunction, usedValueObjects } from './db-probes.js';
import { repositoryArgs } from '../../src/scaffold/repositories.js';

const IMPORTS = [
  'context',
  'encoding/json/jsontext',
  'errors',
  'fmt',
  'log/slog',
  'os',
  'reflect',
  'slices',
  'strings',
  'sync',
  'sync/atomic',
  'testing',
  'time',
  'unicode',
  'unicode/utf8',
  'github.com/google/uuid',
  { path: 'go.mongodb.org/mongo-driver/v2/mongo', name: 'mongodriver' },
  'go.mongodb.org/mongo-driver/v2/bson',
  'go.mongodb.org/mongo-driver/v2/mongo/options',
  'internal/application',
  'internal/infrastructure/messaging',
  'internal/domain',
  'internal/platform/wire'
];

export function docProbePath(model) {
  return `${storeDir(model)}/doc_probe_test.go`;
}

/** El adaptador de una raíz en las sondas: sin puente (las muestras se rehidratan y no emiten). */
function repository(model, root) {
  return `New${root.name}Repository(${repositoryArgs(model, root, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters' })})`;
}

/** La sonda documental del sujeto: `{ path, content }`, o null sin raíces. */
export function docProbeFile(model) {
  const roots = repositoryRoots(model);
  if (roots.length === 0) return null;
  const ctx = { patterns: new Map(), unsampled: [] };
  const parts = [PRELUDE, PROBE_HELPERS, SHAPE_CHECKER];
  if (usesSweepClaims(model)) parts.push(sweepsVar(model));
  const sampled = new Set();
  const visit = (entity) => {
    if (sampled.has(entity.name)) return;
    sampled.add(entity.name);
    parts.push(sampleFunction(model, entity, ctx), dumpFunction(model, entity));
    for (const member of domainMembers(model, entity)) {
      if (member.kind === 'relationMany') visit(model.entities.find((candidate) => candidate.name === member.relation.entity));
    }
  };
  for (const root of roots) visit(root);
  for (const vo of usedValueObjects(model, [...sampled])) parts.push(dumpValueObject(model, vo));
  // ensure<R> llama al New<R>Repository de db-probes (con los nombres de las sondas): mismos argumentos aquí.
  for (const root of roots) parts.push(ensureFunction(model, root).replace(/New\w+Repository\([^)]*\)/, repository(model, root)));
  parts.push(indexProbe(model));
  for (const root of roots) {
    parts.push(shapeProbe(model, root));
    parts.push(...rootProbes(model, root, { document: true }).map((probe) => probe.replace(/New\w+Repository\(probeTx[^)]*\)/g, repository(model, root))));
  }
  parts.push(transactionProbes(model, roots.find((root) => root.usesOptimisticLocking) ?? roots[0]));
  if (usesRequestIdempotency(model)) parts.push(IDEMPOTENCY_PROBES);
  if (usesGoOutbox(model)) parts.push(OUTBOX_PROBES);
  if (usesGoProcessedEvents(model)) parts.push(PROCESSED_PROBES);
  if (tablePurges(model).length > 0) parts.push(purgeProbes(model));
  for (const root of roots) parts.push(...claimProbes(model, root));
  parts.push(patternTables(ctx));
  const content = goFile({ pkg: 'mongo', imports: IMPORTS, body: `\n${parts.filter(Boolean).join('\n\n')}\n`, module: model.service.goModule, generated: false });
  return { path: docProbePath(model), content, unsampled: ctx.unsampled };
}

const PRELUDE = String.raw`// La sonda de doc-check (scripts/lib/doc-probes.js de keel-go): ejecuta los adaptadores documentales emitidos contra un
// MongoDB real en replica set. No es parte del proyecto generado.

var (
	probeDB  *Database
	probeTx  *Transactions
	probeSeq atomic.Int64
)

func TestMain(m *testing.M) {
	os.Exit(runProbes(m))
}

// runProbes conecta como el servicio (Open + Migrate, que crea los índices) y ejecuta las sondas.
func runProbes(m *testing.M) int {
	ctx := context.Background()
	settings, err := settingsOf(os.Getenv("DOC_CHECK_URL"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	db, err := Open(ctx, settings)
	if err != nil {
		fmt.Fprintln(os.Stderr, "abrir la base:", err)
		return 2
	}
	defer db.Close(ctx)
	if err := Migrate(ctx, db, slog.New(slog.DiscardHandler)); err != nil {
		fmt.Fprintln(os.Stderr, "crear los índices:", err)
		return 2
	}
	probeDB = db
	probeTx = NewTransactions(db, slog.New(slog.DiscardHandler))
	return m.Run()
}

// settingsOf son los Settings de una URI, como los leería el servicio de su db.yaml.
func settingsOf(url string) (Settings, error) {
	if databaseOf(url) == "" {
		return Settings{}, fmt.Errorf("DOC_CHECK_URL sin base: %q", url)
	}
	return Settings{Enabled: true, URL: url, Database: databaseOf(url)}, nil
}

// rawOf es el documento crudo de id en collection.
func rawOf(t *testing.T, collection string, id any) bson.Raw {
	t.Helper()
	raw, err := probeDB.Collection(collection).FindOne(t.Context(), bson.D{{Key: "_id", Value: id}}).Raw()
	if err != nil {
		t.Fatalf("leer el documento crudo de %s: %v", collection, err)
	}
	return raw
}`;

const SHAPE_CHECKER = String.raw`// bsonShape es la forma que el contrato pide a un documento: por clave, su tipo BSON.
type bsonShape map[string]bsonField

// bsonField es el tipo de una clave: el BSON (y el subtipo de un binario), si admite null, y la forma de un subdocumento
// o de los elementos de un array.
type bsonField struct {
	kind     bson.Type
	subtype  byte
	nullable bool
	element  *bsonField
	shape    bsonShape
}

// checkShape compara un documento crudo con su forma: cada clave con su tipo, ninguna de más y ninguna que falte.
func checkShape(t *testing.T, path string, doc bson.Raw, want bsonShape) {
	t.Helper()
	elements, err := doc.Elements()
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	seen := map[string]bool{}
	for _, element := range elements {
		key := element.Key()
		seen[key] = true
		field, ok := want[key]
		if !ok {
			t.Errorf("%s.%s: el documento lleva una clave que el contrato no tiene", path, key)
			continue
		}
		checkValue(t, path+"."+key, element.Value(), field)
	}
	for key := range want {
		if !seen[key] {
			t.Errorf("%s.%s: falta en el documento", path, key)
		}
	}
}

func checkValue(t *testing.T, path string, v bson.RawValue, want bsonField) {
	t.Helper()
	if v.Type == bson.TypeNull {
		if !want.nullable {
			t.Errorf("%s: es null y el contrato no lo admite", path)
		}
		return
	}
	if v.Type != want.kind {
		t.Errorf("%s: guarda %s y el contrato pide %s", path, v.Type, want.kind)
		return
	}
	switch want.kind {
	case bson.TypeBinary:
		if subtype, _ := v.Binary(); subtype != want.subtype {
			t.Errorf("%s: binario de subtipo %d, el contrato pide %d", path, subtype, want.subtype)
		}
	case bson.TypeEmbeddedDocument:
		checkShape(t, path, v.Document(), want.shape)
	case bson.TypeArray:
		values, err := v.Array().Values()
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if len(values) == 0 {
			t.Errorf("%s: el array de la muestra está vacío: no mide nada", path)
		}
		for i, element := range values {
			checkValue(t, fmt.Sprintf("%s[%d]", path, i), element, *want.element)
		}
	}
}`;

function sweepsVar(model) {
  const batches = sweepConfig(model)
    .flatMap(({ key, entries }) => entries.filter((entry) => entry.kind === 'batch').map(() => `${goString(key)}: 2`))
    .join(', ');
  // Los parámetros con su valor de prueba, si un rescate lee su plazo de uno (los de claim-probes.js).
  const needsParameters = sweepClaims(model).some(({ claim }) => claim.stalled?.parameter) && usesServiceParameters(model);
  const parameters = needsParameters
    ? `

// probeParameters son los parámetros de despliegue con su valor de prueba: el plazo del rescate sale de ahí.
var probeParameters = must(domain.New${parametersType(model)}(${model.service.parameters
        .map((parameter) => `ptr(${parameter.goType === 'string' ? goString(String(parameter.testValue)) : `${parameter.goType}(${parameter.testValue})`})`)
        .join(', ')}))`
    : '';
  return `// probeSweeps son los barridos de las sondas: lotes de DOS y los plazos de los defaults.
var probeSweeps = SweepSettings{BatchSize: map[string]int{${batches}}, StalledAfterSeconds: DefaultSweepSettings().StalledAfterSeconds}${parameters}`;
}

// ─── La forma del documento ──────────────────────────────────────────────────────────────────────

const STORAGE_TYPES = {
  string: 'bson.TypeString',
  int: 'bson.TypeInt32',
  long: 'bson.TypeInt64',
  decimal128: 'bson.TypeDecimal128',
  bool: 'bson.TypeBoolean',
  uuid: 'bson.TypeBinary, subtype: bson.TypeBinaryUUID',
  date: 'bson.TypeDateTime'
};

const scalarField = (storage, nullable) => `{kind: ${STORAGE_TYPES[storage] ?? 'bson.TypeString'}${nullable ? ', nullable: true' : ''}}`;

function voShapeLiteral(model, voName, seen = new Set()) {
  const vo = model.valueObjects.find((candidate) => candidate.name === voName);
  if (!vo || seen.has(voName)) return 'bsonShape{}';
  const entries = valueObjectShape(vo).map((entry) => {
    const nullable = isOptional(entry.field);
    if (entry.kind === 'subdocument') return `${goString(entry.name)}: ${subdocumentField(model, entry.valueObject, nullable, new Set([...seen, voName]), entry.field.list)}`;
    if (entry.field.list) return `${goString(entry.name)}: {kind: bson.TypeArray, element: &bsonField${scalarField(entry.storage, false)}}`;
    return `${goString(entry.name)}: ${scalarField(entry.storage, nullable)}`;
  });
  return `bsonShape{${entries.join(', ')}}`;
}

function subdocumentField(model, voName, nullable, seen, list = false) {
  const shape = voShapeLiteral(model, voName, seen);
  if (list) return `{kind: bson.TypeArray, element: &bsonField{kind: bson.TypeEmbeddedDocument, shape: ${shape}}}`;
  return `{kind: bson.TypeEmbeddedDocument${nullable ? ', nullable: true' : ''}, shape: ${shape}}`;
}

/** La forma de una entidad como literal Go, desde documentShape de keel-core (nunca desde lo emitido). */
function entityShapeLiteral(model, entity, seen = new Set()) {
  const entries = [];
  for (const entry of documentShape(model, entity)) {
    const key = goString(entry.name);
    if (entry.kind === 'id' || entry.kind === 'version' || entry.kind === 'audit') entries.push(`${key}: ${scalarField(entry.storage, false)}`);
    else if (entry.kind === 'scalar') {
      const declaredLock = entity.declaresLockVersion && entity.usesOptimisticLocking && entry.field.name === 'lockVersion';
      entries.push(`${key}: ${scalarField(entry.storage, !declaredLock && isOptional(entry.field))}`);
    } else if (entry.kind === 'folded' || entry.kind === 'rank') {
      const source = entity.fields.find((field) => field.name === entry.of);
      entries.push(`${key}: ${scalarField(entry.storage, source ? isOptional(source) : true)}`);
    } else if (entry.kind === 'ref') entries.push(`${key}: ${scalarField(entry.storage, !entry.relation.required)}`);
    else if (entry.kind === 'subdocument' && entry.valueObject) entries.push(`${key}: ${subdocumentField(model, entry.valueObject, !entry.field.required, new Set())}`);
    else if (entry.kind === 'subdocument' && entry.entity) {
      const child = model.entities.find((candidate) => candidate.name === entry.entity);
      entries.push(`${key}: {kind: bson.TypeEmbeddedDocument, nullable: true, shape: ${seen.has(child.name) ? 'bsonShape{}' : entityShapeLiteral(model, child, new Set([...seen, entity.name]))}}`);
    } else if (entry.kind === 'array' && entry.element.entity) {
      const child = model.entities.find((candidate) => candidate.name === entry.element.entity);
      entries.push(`${key}: {kind: bson.TypeArray, element: &bsonField{kind: bson.TypeEmbeddedDocument, shape: ${entityShapeLiteral(model, child, new Set([...seen, entity.name]))}}}`);
    } else if (entry.kind === 'array' && entry.element.valueObject) {
      entries.push(`${key}: ${subdocumentField(model, entry.element.valueObject, false, new Set(), true)}`);
    } else if (entry.kind === 'array') entries.push(`${key}: {kind: bson.TypeArray, element: &bsonField${scalarField(entry.element.storage, false)}}`);
  }
  return `bsonShape{\n\t\t${entries.join(',\n\t\t')},\n\t}`;
}

function shapeProbe(model, root) {
  const id = goExported(root.idField?.name ?? 'id');
  return `// Test${root.name}_RawDocumentIsTheContract mira el documento CRUDO: la ida y vuelta con el propio adaptador sale verde con
// cualquier representación, y solo esto dice si el servidor de keel-spring, keel-nest o keel-dotnet lo leería.
func Test${root.name}_RawDocumentIsTheContract(t *testing.T) {
	state := sample${root.name}(t, 140)
	if _, err := ${repository(model, root)}.Save(t.Context(), domain.Rehydrate${root.name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	checkShape(t, ${goString(root.collectionName)}, rawOf(t, ${goString(root.collectionName)}, ${root.idField?.goType === 'uuid.UUID' || !root.idField ? `uuidValue(state.${id})` : `state.${id}`}), ${entityShapeLiteral(model, root)})
}`;
}

// ─── Los índices vivos ───────────────────────────────────────────────────────────────────────────

function indexProbe(model) {
  const rows = indexEntries(model).map(({ collection, specs }) => {
    const items = specs.map((spec) => {
      const filter = spec.partialFilter ? JSON.stringify({ [spec.partialFilter.path]: spec.partialFilter.equals }) : '';
      return `{name: ${goString(spec.name)}, keys: []string{${spec.paths.map(goString).join(', ')}}, unique: ${Boolean(spec.unique)}, filter: ${goString(filter)}}`;
    });
    return `\t${goString(collection)}: {${items.join(', ')}},`;
  });
  return `// wantIndex es un índice del contrato (keel-core/gen/document.js, documentIndexes).
type wantIndex struct {
	name   string
	keys   []string
	unique bool
	filter string
}

// wantIndexes son los índices de cada colección, como los pide el contrato.
var wantIndexes = map[string][]wantIndex{
${rows.join('\n')}
}

// TestIndexes_LiveAreTheContract crea los índices otra vez (el arranque los creó: crearlos de nuevo no hace nada) y compara
// los VIVOS con el contrato: nombre, claves en orden, unicidad, filtro parcial y ninguno de más.
func TestIndexes_LiveAreTheContract(t *testing.T) {
	ctx := t.Context()
	if err := EnsureIndexes(ctx, probeDB, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("crear los índices por segunda vez: %v", err)
	}
	for collection, want := range wantIndexes {
		cursor, err := probeDB.Collection(collection).Indexes().List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		live := map[string]wantIndex{}
		for cursor.Next(ctx) {
			name := cursor.Current.Lookup("name").StringValue()
			if name == "_id_" {
				continue
			}
			index := wantIndex{name: name}
			keys, _ := cursor.Current.Lookup("key").Document().Elements()
			for _, key := range keys {
				index.keys = append(index.keys, key.Key())
			}
			index.unique, _ = cursor.Current.Lookup("unique").BooleanOK()
			if filter, ok := cursor.Current.Lookup("partialFilterExpression").DocumentOK(); ok {
				text, err := bson.MarshalExtJSON(filter, false, false)
				if err != nil {
					t.Fatal(err)
				}
				index.filter = string(text)
			}
			live[name] = index
		}
		if err := cursor.Close(ctx); err != nil {
			t.Fatal(err)
		}
		for _, expected := range want {
			got, ok := live[expected.name]
			if !ok {
				t.Errorf("%s: falta el índice %s", collection, expected.name)
				continue
			}
			if !reflect.DeepEqual(got, expected) {
				t.Errorf("%s: el índice vivo es %+v, el contrato pide %+v", collection, got, expected)
			}
			delete(live, expected.name)
		}
		for name := range live {
			t.Errorf("%s: el índice %s no lo pide el contrato", collection, name)
		}
	}
}`;
}

// ─── La transacción ──────────────────────────────────────────────────────────────────────────────

function transactionProbes(model, root) {
  const name = root.name;
  const repo = repository(model, root);
  const id = goExported(root.idField?.name ?? 'id');
  const idValue = root.idField?.goType === 'uuid.UUID' || !root.idField ? `uuidValue(state.${id})` : `state.${id}`;
  const versioned = Boolean(root.usesOptimisticLocking && !root.declaresLockVersion) || Boolean(root.declaresLockVersion);
  return `// TestTransaction_ConcurrentWritersBothCommit: dos casos de uso a la vez sobre el MISMO documento no se esperan; el motor
// aborta a uno con un conflicto transitorio, y la transacción se repite entera y confirma sobre lo que el otro dejó.
func TestTransaction_ConcurrentWritersBothCommit(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, 140+1)
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	var ready sync.WaitGroup
	ready.Add(2)
	release := make(chan struct{})
	writer := func() error {
		var once sync.Once
		return probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
			read, found, err := ${repo}.FindByID(ctx, state.${id})
			if err != nil || !found {
				return fmt.Errorf("FindByID: found=%v err=%w", found, err)
			}
			once.Do(func() {
				ready.Done()
				<-release
			})
			_, err = ${repo}.Save(ctx, read)
			return err
		})
	}
	results := make(chan error, 2)
	go func() { results <- writer() }()
	go func() { results <- writer() }()
	ready.Wait()
	close(release)
	for range 2 {
		if err := <-results; err != nil {
			t.Errorf("un escritor concurrente falla: %v", err)
		}
	}${versioned ? `
	read, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}
	if v := read.LockVersion(); v == nil || *v != 2 {
		t.Errorf("tras dos guardados confirmados la versión es %s, no 2", show(v))
	}` : ''}
}

// TestTransaction_ConflictExhaustedIs409: con otra transacción reteniendo el documento, cada intento choca; agotados los
// reintentos, el error es el 409 de concurrencia del contrato.
func TestTransaction_ConflictExhaustedIs409(t *testing.T) {
	ctx := t.Context()
	state := sample${name}(t, 142)
	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	holder, err := probeDB.client.StartSession()
	if err != nil {
		t.Fatal(err)
	}
	defer holder.EndSession(context.WithoutCancel(ctx))
	if err := holder.StartTransaction(); err != nil {
		t.Fatal(err)
	}
	held := mongodriver.NewSessionContext(ctx, holder)
	if result, err := probeDB.Collection(${goString(root.collectionName)}).UpdateOne(held, bson.D{{Key: "_id", Value: ${idValue}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "keel_probe_hold", Value: true}}}}); err != nil || result.ModifiedCount != 1 {
		t.Fatalf("retener el documento: %+v %v", result, err)
	}
	defer func() { _ = holder.AbortTransaction(context.WithoutCancel(ctx)) }()
	// Un estado DISTINTO con el mismo id: un $set que no cambia nada no escribe, y no chocaría con nadie.
	changed := sample${name}(t, 143)
	changed.${id} = state.${id}
	err = probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		read, _, err := ${repo}.FindByID(ctx, state.${id})
		if err != nil {
			return err
		}${versioned ? `
		changed.LockVersion = read.LockVersion()` : `
		_ = read // la lectura abre la instantánea de la transacción`}
		_, err = ${repo}.Save(ctx, domain.Rehydrate${name}(changed))
		return err
	})
	de := domainError(t, err)
	if de.Code() != ${goString(concurrencyCode(model))} || de.Status() != 409 {
		t.Errorf("el conflicto agotado sale %q/%d, no ${concurrencyCode(model)}/409", de.Code(), de.Status())
	}
}`;
}

// ─── Los almacenes ───────────────────────────────────────────────────────────────────────────────

const IDEMPOTENCY_PROBES = String.raw`// TestIdempotencyStore_RecordConflictAndRollback: el registro se guarda y se lee por su _id; la misma clave otra vez es el
// conflicto del contrato; y abortado el caso de uso, el registro no queda.
func TestIdempotencyStore_RecordConflictAndRollback(t *testing.T) {
	ctx := t.Context()
	store := NewIdempotencyStore(probeTx)
	scope, key := "doc-check", uuid.NewString()
	resource := "recurso-1"
	if err := store.Save(ctx, scope, key, "firma-1", &resource, 60); err != nil {
		t.Fatalf("Save: %v", err)
	}
	stored, found, err := store.Find(ctx, scope, key)
	if err != nil || !found || stored.Signature != "firma-1" || stored.ResourceID == nil || *stored.ResourceID != resource {
		t.Fatalf("Find: %+v found=%v err=%v", stored, found, err)
	}
	var de *domain.Error
	if err := store.Save(ctx, scope, key, "firma-2", nil, 60); !errors.As(err, &de) {
		t.Errorf("la misma clave otra vez sale %v, no el conflicto del contrato", err)
	}
	rolledBack := uuid.NewString()
	failure := errors.New("el caso de uso falla")
	err = probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		if err := store.Save(ctx, scope, rolledBack, "firma", nil, 60); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("Within: %v", err)
	}
	if _, found, _ := store.Find(ctx, scope, rolledBack); found {
		t.Error("el registro de un caso de uso abortado sobrevive: la clave quedaría marcada sin recurso detrás")
	}
	expired := uuid.NewString()
	if err := store.Save(ctx, scope, expired, "firma", nil, -1); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := store.Find(ctx, scope, expired); found {
		t.Error("un registro caducado se sigue encontrando")
	}
	if err := store.Save(ctx, scope, expired, "firma-nueva", nil, 60); err != nil {
		t.Errorf("una clave caducada no se puede volver a usar: %v", err)
	}
}`;

const OUTBOX_PROBES = String.raw`// outboxRecords son n eventos de prueba para un destino propio de la sonda.
func outboxRecords(destination string, n int) []messaging.OutboxRecord {
	records := make([]messaging.OutboxRecord, n)
	for i := range records {
		records[i] = messaging.OutboxRecord{Destination: destination, RoutingKey: "rk", EventType: "DocCheckEvent", Payload: fmt.Sprintf("{\"n\":%d}", i)}
	}
	return records
}

// TestOutbox_ClaimOrderLeaseFailureAndPublish: el relay se lleva lo pendiente en orden de llegada (con el índice retirado,
// que regalaría el orden), no vuelve a ver lo reclamado hasta que caduca la marca, un fallo incrementa el intento y
// aplaza, y lo publicado no sale más. El outbox se escribe en la transacción del cambio: fuera de una, es un error.
func TestOutbox_ClaimOrderLeaseFailureAndPublish(t *testing.T) {
	ctx := t.Context()
	documents := probeDB.Collection(outboxCollection)
	if _, err := documents.DeleteMany(ctx, bson.D{}); err != nil {
		t.Fatal(err)
	}
	if err := documents.Indexes().DropOne(ctx, "ix_outbox_event_pending"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := EnsureIndexes(context.WithoutCancel(ctx), probeDB, slog.New(slog.DiscardHandler)); err != nil {
			t.Error(err)
		}
	}()
	if err := appendOutbox(ctx, probeTx, outboxRecords("doc-check", 1)); err == nil {
		t.Error("appendOutbox fuera de una transacción no es un error")
	}
	// Tres eventos insertados del más nuevo al más viejo: el orden natural no es el de llegada.
	for i, age := range []time.Duration{time.Minute, 2 * time.Minute, 3 * time.Minute} {
		if err := probeTx.write(ctx, func(ctx context.Context) error { return appendOutbox(ctx, probeTx, outboxRecords("doc-check", 1)) }); err != nil {
			t.Fatal(err)
		}
		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "payload", Value: "{\"n\":0}"}, {Key: "created_at", Value: bson.D{{Key: "$gt", Value: instantValue(time.Now().Add(-10 * time.Second))}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "created_at", Value: instantValue(time.Now().UTC().Add(-age))}, {Key: "payload", Value: fmt.Sprintf("{\"age\":%d}", i)}}}}); err != nil {
			t.Fatal(err)
		}
	}
	outbox := NewOutbox(probeTx)
	first, err := outbox.ClaimBatch(ctx, 5, 2, time.Minute)
	if err != nil || len(first) != 2 {
		t.Fatalf("ClaimBatch: %d eventos, err=%v", len(first), err)
	}
	if first[0].Payload != "{\"age\":2}" || first[1].Payload != "{\"age\":1}" {
		t.Errorf("el lote no sale en orden de llegada: %s, %s", first[0].Payload, first[1].Payload)
	}
	second, err := outbox.ClaimBatch(ctx, 5, 5, time.Minute)
	if err != nil || len(second) != 1 || second[0].Payload != "{\"age\":0}" {
		t.Fatalf("la segunda pasada se lleva %d (lo reclamado con la marca viva no vuelve), err=%v", len(second), err)
	}
	outcome, err := outbox.MarkFailed(ctx, first[0].ID, "$set roto", 5, time.Hour, time.Hour)
	if err != nil || outcome.Attempts != 1 || outcome.DeadLettered {
		t.Errorf("MarkFailed: %+v err=%v", outcome, err)
	}
	if err := outbox.MarkPublished(ctx, first[1].ID); err != nil {
		t.Fatal(err)
	}
	// Una marca más vieja que el lease ya caducó: con un lease de 1 ms, la del segundo evento.
	time.Sleep(20 * time.Millisecond)
	expired, err := outbox.ClaimBatch(ctx, 5, 5, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 1 || expired[0].ID != second[0].ID {
		t.Errorf("con la marca caducada vuelve %d eventos; quiero solo el que no se publicó ni se aplazó", len(expired))
	}
	if outcome, err := outbox.MarkFailed(ctx, second[0].ID, "otra vez", 1, time.Hour, time.Hour); err != nil || !outcome.DeadLettered {
		t.Errorf("con el intento agotado no se rinde: %+v err=%v", outcome, err)
	}
	// Con un tope de un intento, los dos que fallaron una vez están rendidos; el publicado no cuenta.
	if count, err := outbox.CountDeadLettered(ctx, 1); err != nil || count != 2 {
		t.Errorf("CountDeadLettered = %d, err=%v; quiero 2", count, err)
	}
}`;

const PROCESSED_PROBES = String.raw`// TestProcessedEvents_RecordSurvivesTheHandler: el registro va por su _id {handler_id, event_id}, la segunda vez es false,
// y sobrevive al caso de uso que aborta (va fuera de su transacción).
func TestProcessedEvents_RecordSurvivesTheHandler(t *testing.T) {
	ctx := t.Context()
	registry := NewProcessedEvents(probeTx)
	eventID := uuid.NewString()
	failure := errors.New("el handler falla")
	err := probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		if inserted, err := registry.Insert(ctx, "doc-check", eventID); err != nil || !inserted {
			return fmt.Errorf("Insert: %v %w", inserted, err)
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("Within: %v", err)
	}
	if seen, err := registry.Exists(ctx, "doc-check", eventID); err != nil || !seen {
		t.Errorf("el registro no sobrevive al handler que falla: seen=%v err=%v", seen, err)
	}
	if inserted, err := registry.Insert(ctx, "doc-check", eventID); err != nil || inserted {
		t.Errorf("la segunda vez Insert = %v, err=%v; quiero false", inserted, err)
	}
	raw, err := probeDB.Collection(processedCollection).FindOne(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "handler_id", Value: "doc-check"}, {Key: "event_id", Value: eventID}}}}).Raw()
	if err != nil {
		t.Fatalf("el _id no es el subdocumento {handler_id, event_id} en ese orden: %v", err)
	}
	if _, err := raw.LookupErr("processed_at"); err != nil {
		t.Error("el registro no lleva processed_at")
	}
}`;

function purgeProbes(model) {
  const purge = tablePurges(model)[0];
  return `// TestPurge_BatchesUpToTheBoundary: la frontera del lote es la posición N de lo anterior al corte, y el borrado llega hasta
// ella incluida; lo posterior al corte no se toca.
func TestPurge_BatchesUpToTheBoundary(t *testing.T) {
	ctx := t.Context()
	documents := probeDB.Collection(${goString(purge.table)})
	if _, err := documents.DeleteMany(ctx, bson.D{}); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Millisecond)
	for i := range 5 {
		if _, err := documents.InsertOne(ctx, bson.D{{Key: "_id", Value: uuidValue(uuid.New())}, {Key: ${goString(purge.column)}, Value: instantValue(base.Add(time.Duration(i) * time.Minute))}}); err != nil {
			t.Fatal(err)
		}
	}
	purge := ${purge.constructor}(probeTx)
	cutoff := base.Add(150 * time.Second)
	edge, found, err := purge.Boundary(ctx, cutoff, 1)
	if err != nil || !found || !edge.Equal(base.Add(time.Minute)) {
		t.Fatalf("Boundary = %v %v %v; quiero el segundo instante", edge, found, err)
	}
	deleted, err := purge.DeleteUpTo(ctx, cutoff, edge)
	if err != nil || deleted != 2 {
		t.Fatalf("DeleteUpTo = %d %v; quiero 2", deleted, err)
	}
	if _, found, err := purge.Boundary(ctx, cutoff, 1); err != nil || found {
		t.Errorf("queda más de un documento anterior al corte: found=%v err=%v", found, err)
	}
	if remaining, _ := documents.CountDocuments(ctx, bson.D{}); remaining != 3 {
		t.Errorf("quedan %d documentos; quiero 3 (uno antes del corte y dos después)", remaining)
	}
}`;
}

// ─── Los reclamos de barrido ─────────────────────────────────────────────────────────────────────

function claimProbes(model, root) {
  if (!usesSweepClaims(model)) return [];
  const repo = repository(model, root);
  const id = goExported(root.idField?.name ?? 'id');
  const stateKey = snakeCase(root.lifecycle?.field ?? 'status');
  const collection = goString(root.collectionName);
  return claimsForEntity(model, root.name).map((claim) => {
    const method = claimMethod(claim);
    const from = claim.stalled ? claim.stalled.state : claim.from[0];
    const set = [`{Key: ${goString(stateKey)}, Value: ${goString(storedState(model, root, from))}}`];
    if (claim.stalled) set.push(`{Key: ${goString(snakeCase(claim.stalled.stampField))}, Value: instantValue(clock)}`);
    if (claim.due) set.push(`{Key: ${goString(snakeCase(claim.due.field))}, Value: instantValue(time.Now().UTC().Add(-time.Minute))}`);
    const other = claim.stalled ? 'time.Now().UTC()' : null;
    return `// Test${root.name}_${method}TakesEachDocumentOnce: el reclamo se lleva lo que está en su estado de partida${claim.stalled ? ' y ATASCADO (no lo que acaba de entrar en vuelo)' : ''}, uno por documento hasta el lote, y la pasada siguiente no vuelve a llevárselo: dos réplicas no actúan sobre el mismo. Dentro de una transacción abierta se niega.
func Test${root.name}_${method}TakesEachDocumentOnce(t *testing.T) {
	ctx := t.Context()
	documents := probeDB.Collection(${collection})
	if _, err := documents.DeleteMany(ctx, bson.D{}); err != nil {
		t.Fatal(err)
	}
	place := func(n int, clock time.Time) uuid.UUID {
		state := sample${root.name}(t, n)
		if _, err := ${repo}.Save(ctx, domain.Rehydrate${root.name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: uuidValue(state.${id})}}, bson.D{{Key: "$set", Value: bson.D{${set.join(', ')}}}}); err != nil {
			t.Fatal(err)
		}
		return state.${id}
	}
	stale := time.Now().UTC().Add(-240 * time.Hour)
	candidates := []uuid.UUID{place(160, stale), place(161, stale.Add(time.Second))}${other ? `
	fresh := place(162, ${other})` : ''}
	claimed, err := ${repo}.${method}(ctx)
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if len(claimed) != 2 || claimed[0].${id}() != candidates[0] || claimed[1].${id}() != candidates[1] {
		t.Fatalf("${method} se lleva %d documentos; quiero los dos candidatos, en su orden", len(claimed))
	}
	again, err := ${repo}.${method}(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, aggregate := range again {
		if slices.Contains(candidates, aggregate.${id}()) {
			t.Errorf("la pasada siguiente vuelve a llevarse %s", aggregate.${id}())
		}${other ? `
		if aggregate.${id}() == fresh {
			t.Errorf("el rescate se lleva lo que acaba de entrar en vuelo")
		}` : ''}
	}
	err = probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		_, err := ${repo}.${method}(ctx)
		return err
	})
	if err == nil {
		t.Error("${method} dentro de una transacción abierta no es un error")
	}
}`;
  });
}
