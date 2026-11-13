// El HISTORIAL DE CAMBIOS (DSL 2.29) contra lo emitido, para db-check y doc-check: HI-1 a HI-10 de keel-core/gen/history.js,
// con los ids que ejecutan keel-spring (history-check), keel-nest y keel-dotnet (su scripts/lib/history-probes.js) sobre los
// MISMOS diseños (keel-core/test/helpers/history-designs.js). Habla con el puerto de la raíz, con las funciones del almacén
// del historial (están en el mismo paquete que la sonda) y con la retención; con la base cruda solo para lo que el puerto no
// enseña (retrasar un borrado, mover la hora de una entrada). Vale para los dos almacenes. HI-11 (logs y spans) no se mide
// aquí: es de telemetry-check, como PD-3.
//
// Una prueba por caso, con el id en el nombre (`TestContactCard_HI6_…`), en un archivo aparte del paquete del almacén
// (`history_probe_test.go`), como las del ciclo de vida: comparte la base con el resto de sondas, así que NO vacía tablas.
// Cada caso siembra sus propias raíces y lee solo su historial (el de su id); HI-6 escribe por el almacén con una raíz
// inventada.
//
// Las etiquetas importan para el falsado, como en los otros tres: cada sabotaje tiene que caer en EXACTAMENTE sus casos. Por
// eso HI-6 no escribe por el adaptador sino por el almacén (un diff roto no puede tumbar el orden ni el filtro), HI-3 solo
// afirma que las rutas de las hijas ESTÁN y son las de su forma (el diff que lo lista todo es HI-2) y HI-4 mira la entrada
// del alta.

import { lifecycleRoots } from '@keel-system/keel-core/gen/data-lifecycle';
import { HISTORY_CASES, HISTORY_SABOTAGES } from '@keel-system/keel-core/gen/history';
import { CHANGE_HISTORY, CHANGE_HISTORY_FIELD, CHANGE_HISTORY_COLLECTION } from '@keel-system/keel-core/gen/history-store';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { DELETED_AT, LOCK_VERSION } from '@keel-system/keel-core/gen/relational';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { sqlDialect, storeDir } from '../../src/lib/relational-engine.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { repositoryArgs } from '../../src/scaffold/repositories.js';
import { referenceMember } from '../../src/scaffold/read-scope.js';
import { retentionType } from '../../src/scaffold/data-lifecycle.js';
import { historyReadsOf, recordsHistory, rootVariable } from '../../src/scaffold/history.js';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────

const STORE = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/history\.go$/;
const RELATIONAL_WRITES = /^internal\/infrastructure\/(?:postgres|mysql)\/\w+_repository\.go$/;
const ADAPTER = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/\w+_repository\.go$/;
const RETENTION = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/\w+_retention\.go$/;

const spec = (relational, document) => ({
  relational: relational && { ...relational, expect: /_HI\d+_/ },
  document: document && { ...document, expect: /_HI\d+_/ }
});

/** La carga de D7 quitada: el historial se lee por el id que se pide, sin mirar si la ficha lo ve. */
const UNSCOPED = {
  files: ADAPTER,
  from: /root, found, err := r\.\w+\(ctx, (\w+)(?:, scope)?\)([\s\S]*?)fmt\.Sprint\(root\.\w+\(\)\)/g,
  to: '_, found, err := any(nil), true, error(nil)$2fmt.Sprint($1)'
};

/**
 * Los sabotajes, por almacén, con la forma de db-sabotages.js y doc-sabotages.js (`files`, `from`, `to`): rompen lo emitido
 * CONSERVANDO LA FORMA (sigue compilando). `expect` casa con cualquier sonda del historial: el veredicto exacto lo da
 * `historySabotageVerdict`.
 */
export const HISTORY_SABOTAGE_SPECS = {
  // La entrada se escribe por OTRA conexión, fuera de la transacción de la escritura: sobrevive a la que revierte. En
  // MongoDB, fuera de la sesión.
  'hi-outside-tx': spec(
    { files: RELATIONAL_WRITES, from: /(record(?:Save|History))\(ctx, q, /g, to: '$1(ctx, func() DBTX { outside, _ := r.tx.conn(context.Background()); return outside }(), ' },
    { files: STORE, from: /documents\.InsertOne\(ctx, bson\.D\{/g, to: 'documents.InsertOne(outside(ctx), bson.D{' }
  ),
  // Una actualización registra la instantánea entera, cambie o no.
  'hi-full-snapshot': spec({ files: STORE, from: 'if was != is {', to: 'if was != is || before != nil {' }, { files: STORE, from: 'if was != is {', to: 'if was != is || before != nil {' }),
  // La instantánea guarda el id, que el historial no registra (D4).
  'hi-sensitive': spec(
    { files: STORE, from: /(func \w+HistorySnapshot\(e \*domain\.\w+\) \(historySnapshot, error\) \{\n\ts := historySnapshot\{\}\n)/g, to: '$1\t_ = s.put("id", e.ID())\n' },
    { files: STORE, from: /(func \w+HistorySnapshot\(e \*domain\.\w+\) \(historySnapshot, error\) \{\n\ts := historySnapshot\{\}\n)/g, to: '$1\t_ = s.put("id", e.ID())\n' }
  ),
  // El autor es siempre el centinela.
  'hi-author': spec({ files: STORE, from: '"author": auditActor(ctx)', to: '"author": systemActor' }, { files: STORE, from: '{Key: "author", Value: auditActor(ctx)}', to: '{Key: "author", Value: systemActor}' }),
  // A igual instante desempata el id MENOR: el orden deja de ser estable de más reciente a más antiguo.
  'hi-order': spec(
    { files: STORE, from: 'ORDER BY h.at DESC, h.id DESC', to: 'ORDER BY h.at DESC, h.id ASC' },
    { files: STORE, from: '{Key: "at", Value: -1}, {Key: "_id", Value: -1}', to: '{Key: "at", Value: -1}, {Key: "_id", Value: 1}' }
  ),
  // La lectura del historial no carga la raíz como su ficha: ve lo ajeno y lo borrado.
  'hi-unscoped': spec(UNSCOPED, UNSCOPED),
  // La retención anonimiza la ficha y deja el historial como estaba.
  'hi-anonymize-miss': spec(
    { files: RETENTION, from: /if err := anonymizeHistory\([^\n]*; err != nil \{/g, to: 'if err := error(nil); err != nil {' },
    { files: RETENTION, from: /if err := anonymizeHistory\([^\n]*; err != nil \{/g, to: 'if err := error(nil); err != nil {' }
  ),
  // La purga de lo borrado se deja el historial.
  'hi-purge-miss': spec(
    { files: RETENTION, from: /if err := purgeHistory\([^\n]*; err != nil \{/g, to: 'if err := error(nil); err != nil {' },
    { files: RETENTION, from: /if err := purgeHistory\([^\n]*; err != nil \{/g, to: 'if err := error(nil); err != nil {' }
  )
};

export const isHistorySabotage = (id) => Boolean(HISTORY_SABOTAGE_SPECS[id]);

/**
 * Las pruebas de OTRA red que un sabotaje del historial tumba con razón: `hi-full-snapshot` rompe el diff común, y la prueba
 * emitida history_test.go, que vive en el mismo paquete que la sonda, lo ejecuta contra keel-core (go-check --history).
 */
export const HISTORY_ALSO = { 'hi-full-snapshot': /^TestHistoryDiff/ };

/** Los sujetos por almacén: los de history-designs.js. */
export const HISTORY_SUBJECTS = {
  relational: ['cards-history', 'cards-history-anonymize', 'vault-history-scoped'],
  document: ['cards-history-mongo', 'cards-history-anonymize-mongo', 'vault-history-scoped-mongo']
};

// ─── Lo que se mide de cada diseño ───────────────────────────────────────────────────────────────

/** Lo que las sondas necesitan de cada raíz con historial, como los otros tres. */
export function probedRoots(model) {
  return model.entities.filter(recordsHistory).map((entity) => {
    const lifecycle = lifecycleRoots(model).find((root) => root.entity === entity.name) ?? null;
    const reads = historyReadsOf(model, entity);
    const scoped = reads.some((read) => read.scoped) ? scopedRootsOf(model).find((candidate) => candidate.entity?.name === entity.name) ?? null : null;
    // El campo que cambia una actualización: texto libre de la raíz, sin clave, sin unicidad y sin formato.
    const editable = entity.fields.find(
      (field) =>
        field.base === 'string' && !field.list && field.kind !== 'composite' && field.kind !== 'enum' && !field.isId && !field.unique &&
        !field.inheritedPattern && !(entity.naturalKey ?? []).includes(field.name) && entity.historyShape.paths.includes(field.name)
    );
    if (!editable) throw new Error(`history-probes: ${entity.name} no tiene un campo de texto libre que editar`);
    return { entity, lifecycle, reads, scoped, editable };
  });
}

/** Los casos que ejecuta el bloque de este diseño (los mismos que los otros tres: history-parity.test.js lo compara). */
export function historyCases(model) {
  const cases = new Set();
  for (const { entity, lifecycle, reads } of probedRoots(model)) {
    cases.add('HI-1').add('HI-2').add('HI-4').add('HI-5').add('HI-6');
    if (entity.historyShape.children.length > 0 || entity.historyShape.paths.some((path) => path.includes('.'))) cases.add('HI-3');
    if (reads.length > 0 && (lifecycle?.logical || reads.some((read) => read.scoped))) cases.add('HI-7');
    if (lifecycle?.restore) cases.add('HI-10');
    if (lifecycle?.retention?.fromDeleted) cases.add(lifecycle.retention.then === 'anonymize' ? 'HI-8' : 'HI-9');
  }
  const order = HISTORY_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Lo que tiene que caer con un sabotaje en este diseño: sus casos que el bloque ejecuta. */
export function historySabotageVerdict(failures, id, model) {
  const cases = historyCases(model);
  const want = HISTORY_SABOTAGES[id].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_HI(\d+)_/g)].map((match) => `HI-${match[1]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El archivo de la sonda ──────────────────────────────────────────────────────────────────────

// La primera muestra de las filas del historial: lejos de las de las otras sondas (hasta 241, el ensure desde 500, las de la
// lectura acotada desde 740 y las del ciclo de vida desde 800).
const SAMPLE_BASE = 950;

/** La expresión del repositorio de una raíz en la sonda, la misma de db-probes y doc-probes. */
function repository(model, root) {
  return `New${root.name}Repository(${repositoryArgs(model, root, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})`;
}

/** `history_probe_test.go` en el paquete del almacén, o null si el diseño no tiene historial. */
export function historyProbeFile(model) {
  const probes = probedRoots(model);
  if (probes.length === 0) return null;
  const document = model.persistenceKind === 'document';
  const d = document ? null : sqlDialect(model);
  const store = document ? 'probeTx' : 'must(probeTx.conn(ctx))';
  let salt = SAMPLE_BASE;
  const tests = [];
  const helpers = [];
  for (const probe of probes) {
    const { entity, lifecycle, reads, scoped, editable } = probe;
    const name = entity.name;
    const id = goExported(entity.idField?.name ?? 'id');
    const idType = entity.idField?.goType ?? 'uuid.UUID';
    const shape = entity.historyShape;
    const root = rootVariable(entity);
    const members = domainMembers(model, entity);
    const memberOf = (field) => members.find((member) => member.name === field);
    const repo = `hi${name}Repo()`;
    const key = (variable) => `fmt.Sprint(${variable}.${id})`;
    const lock = entity.usesOptimisticLocking ? goExported(members.find((member) => member.declaredLock)?.name ?? LOCK_VERSION.field) : null;
    const editableField = goExported(editable.name);
    const editedValue = (text) => (memberOf(editable.name)?.optional ? `ptr(${goString(text)})` : goString(text));
    helpers.push(`// hi${name}Repo es el adaptador de ${name} de la sonda.
func hi${name}Repo() *${name}Repository {
	return ${repository(model, entity)}
}

// hi${name}Save guarda el estado: un alta, o una actualización sobre la versión vigente (la carga viva del puerto).
func hi${name}Save(t *testing.T, state *domain.${name}State) {
	t.Helper()
	ctx := t.Context()
	repo := ${repo}${lock ? `
	if current, found, err := repo.FindByID(ctx, state.${id}); err != nil {
		t.Fatalf("cargar %v: %v", state.${id}, err)
	} else if found {
		state.${lock} = current.${lock}()
	}` : ''}
	if _, err := repo.Save(ctx, domain.Rehydrate${name}(*state)); err != nil {
		t.Fatalf("guardar %v: %v", state.${id}, err)
	}
}`);
    const test = (caseId, title, lines) =>
      tests.push(`func Test${name}_${caseId.replace('-', '')}_${title}(t *testing.T) {
${/\bctx\b/.test(lines.join('\n')) ? '\tctx := t.Context()\n' : ''}${lines.join('\n')}
}`);
    // Una raíz nueva: la muestra con lo que se fuerce, guardada.
    const fresh = (variable, overrides = []) => [
      `	${variable} := sample${name}(t, ${salt++})`,
      ...overrides.map(([field, value]) => `	${variable}.${field} = ${value}`),
      `	hi${name}Save(t, &${variable})`
    ];
    const update = (variable, overrides) => [...overrides.map(([field, value]) => `	${variable}.${field} = ${value}`), `	hi${name}Save(t, &${variable})`];
    const remove = (variable) => [`	if err := ${repo}.DeleteByID(ctx, ${variable}.${id}); err != nil {`, `		t.Fatalf("borrar ${variable}: %v", err)`, '	}'];
    const kinds = (variable, want, what) => [`	if got := hiKinds(t, ${root}, ${key(variable)}); got != ${goString(want)} {`, `		t.Errorf("${what}: las entradas son %q; quiero %q", got, ${goString(want)})`, '	}'];

    test('HI-1', 'AltaCambioYBajaDejanUnaEntradaCadaUnoEnSuTransaccion', [
      ...fresh('fila'),
      ...update('fila', [[editableField, editedValue(`hi1-${salt}`)]]),
      ...remove('fila'),
      ...kinds('fila', 'deleted,updated,created', 'alta, cambio y baja'),
      `	revertida := sample${name}(t, ${salt++})`,
      '	// Una escritura que revierte (la transacción del caso de uso) no deja entrada.',
      '	errRevierte := errors.New("revierte")',
      '	err := probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {',
      `		if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(revertida)); err != nil {`,
      '			return err',
      '		}',
      '		return errRevierte',
      '	})',
      '	if !errors.Is(err, errRevierte) {',
      '		t.Fatalf("la transacción no revirtió por la sonda: %v", err)',
      '	}',
      `	if entries := hiEntries(t, ${root}, ${key('revertida')}); len(entries) != 0 {`,
      '		t.Errorf("una escritura que revierte dejó %d entradas", len(entries))',
      '	}'
    ]);

    test('HI-2', 'SoloLoQueCambioConSuAntesYSuDespues', [
      ...fresh('fila'),
      '	// Un guardado sin cambios no escribe.',
      `	hi${name}Save(t, &fila)`,
      ...kinds('fila', 'created', 'un guardado sin cambios'),
      `	antes := string(must(wire.Marshal(fila.${editableField})))`,
      ...update('fila', [[editableField, editedValue(`hi2-${salt}`)]]),
      `	despues := string(must(wire.Marshal(fila.${editableField})))`,
      `	last := hiEntries(t, ${root}, ${key('fila')})[0]`,
      '	var fields []string',
      '	for _, change := range last.Changes {',
      '		fields = append(fields, change.Field)',
      '	}',
      `	if strings.Join(fields, ",") != ${goString(editable.name)} {`,
      `		t.Fatalf("la actualización registró %v; quiero solo ${editable.name}", fields)`,
      '	}',
      '	if string(last.Changes[0].Before) != antes || string(last.Changes[0].After) != despues {',
      '		t.Errorf("antes %s y después %s; quiero %s y %s", last.Changes[0].Before, last.Changes[0].After, antes, despues)',
      '	}'
    ]);

    const listChild = shape.children.find((candidate) => candidate.list);
    if (listChild) {
      const relation = goExported(listChild.relation);
      const childId = goExported(listChild.idField);
      const prefix = (variable) => `${goString(`${listChild.relation}[`)} + fmt.Sprint(${variable}.${childId}) + "]."`;
      const known = `map[string]bool{${listChild.paths.map((path) => `${goString(path)}: true`).join(', ')}}`;
      const ofChild = (variable, entries, onlyAdded) => [
        `	known${variable} := ${known}`,
        `	seen${variable} := 0`,
        `	for _, change := range ${entries}.Changes {`,
        ...(onlyAdded ? ['		if string(change.Before) != "null" {', '			continue', '		}'] : []),
        `		rest, ok := strings.CutPrefix(change.Field, ${prefix(variable)})`,
        '		if !ok {',
        '			continue',
        '		}',
        `		seen${variable}++`,
        `		if !known${variable}[rest] {`,
        `			t.Errorf("la ruta %s de la hija no es de su forma", change.Field)`,
        '		}',
        '	}',
        `	if seen${variable} == 0 {`,
        `		t.Errorf("la entrada no lleva las rutas de la hija ${variable}")`,
        '	}'
      ];
      test('HI-3', `${relation}AparecenConSuRuta`, [
        `	primera := sample${listChild.entity}(t, ${10 * salt + 7})`,
        ...fresh('fila', [[relation, `[]*domain.${listChild.entity}{domain.Rehydrate${listChild.entity}(primera)}`]]),
        '	// El alta lleva las rutas de la hija, y solo las de su forma.',
        `	created := hiEntries(t, ${root}, ${key('fila')})[0]`,
        ...ofChild('primera', 'created', false),
        `	segunda := sample${listChild.entity}(t, ${10 * salt + 8})`,
        ...update('fila', [[relation, `append(fila.${relation}, domain.Rehydrate${listChild.entity}(segunda))`]]),
        `	added := hiEntries(t, ${root}, ${key('fila')})[0]`,
        ...ofChild('segunda', 'added', true)
      ]);
    } else if (shape.paths.some((path) => path.includes('.'))) {
      const dotted = shape.paths.filter((path) => path.includes('.'));
      test('HI-3', 'LosValueObjectsAparecenConSuRuta', [
        ...fresh('fila'),
        `	dotted := map[string]bool{${dotted.map((path) => `${goString(path)}: true`).join(', ')}}`,
        '	seen := false',
        `	for _, change := range hiEntries(t, ${root}, ${key('fila')})[0].Changes {`,
        '		seen = seen || dotted[change.Field]',
        '	}',
        '	if !seen {',
        '		t.Error("el alta no lleva ninguna ruta de un value object")',
        '	}'
      ]);
    }

    {
      const excluded = [
        entity.idField?.name ?? 'id',
        ...entity.fields.filter((field) => field.sensitive || field.generated).map((field) => field.name),
        ...(entity.usesOptimisticLocking ? [LOCK_VERSION.field] : [])
      ];
      test('HI-4', 'NiSensitiveNiGeneratedEntranEnElHistorial', [
        ...fresh('fila'),
        `	recorded := hiEntries(t, ${root}, ${key('fila')})[0].Changes`,
        '	// La sonda mide: el alta registró algo.',
        '	if len(recorded) == 0 {',
        '		t.Fatal("el alta no registró nada")',
        '	}',
        `	excluded := map[string]bool{${[...new Set(excluded)].map((field) => `${goString(field)}: true`).join(', ')}}`,
        '	for _, change := range recorded {',
        '		if excluded[change.Field] {',
        '			t.Errorf("el historial registra %s", change.Field)',
        '		}',
        '	}'
      ]);
    }

    test('HI-5', 'ElAutorEsElSujetoDelTokenYFueraDeUnaPeticionElCentinela', [
      `	conToken := sample${name}(t, ${salt++})`,
      '	principal := &security.Principal{Kind: security.TokenPrincipal, Name: "nombre-hi5", Claims: map[string]jsontext.Value{"sub": jsontext.Value(`"sub-hi5"`)}}',
      `	if _, err := ${repo}.Save(security.WithPrincipal(ctx, principal), domain.Rehydrate${name}(conToken)); err != nil {`,
      '		t.Fatal(err)',
      '	}',
      `	if got := hiEntries(t, ${root}, ${key('conToken')})[0].Author; got != "sub-hi5" {`,
      '		t.Errorf("con token el autor es %q; quiero el sub", got)',
      '	}',
      ...fresh('sinToken'),
      `	if got := hiEntries(t, ${root}, ${key('sinToken')})[0].Author; got != "system" && !strings.HasPrefix(got, "system:") {`,
      '		t.Errorf("fuera de una petición el autor es %q; quiero el centinela", got)',
      '	}'
    ]);

    test('HI-6', 'LaPaginaVaDelMasRecienteConDesempateEstableYFiltra', [
      '	// Por el almacén: lo que se mide es su orden y sus filtros, no el diff del adaptador.',
      '	root6 := "hi6-" + uuid.NewString()',
      '	t0 := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)',
      '	for _, path := range []string{"a.x", "b", "c", "d"} {',
      `		if err := recordHistory(ctx, ${store}, ${root}, root6, domain.HistoryUpdated, []domain.FieldChange{{Field: path, Before: jsontext.Value("null"), After: jsontext.Value(strconv.Quote(path))}}); err != nil {`,
      '			t.Fatal(err)',
      '		}',
      '	}',
      '	hiSetAt(t, root6, "a.x", t0)',
      '	hiSetAt(t, root6, "b", t0.Add(5*time.Minute))',
      '	hiSetAt(t, root6, "c", t0.Add(5*time.Minute))',
      '	hiSetAt(t, root6, "d", t0.Add(9*time.Minute))',
      '	fields := func(filter domain.HistoryFilter, page, size int32) string {',
      `		var out []string`,
      `		for _, entry := range hiPage(t, ${root}, root6, filter, page, size).Items {`,
      '			out = append(out, entry.Changes[0].Field)',
      '		}',
      '		return strings.Join(out, ",")',
      '	}',
      '	expect := func(got, want, what string) {',
      '		if got != want {',
      '			t.Errorf("%s: %q; quiero %q", what, got, want)',
      '		}',
      '	}',
      '	expect(fields(domain.HistoryFilter{}, 0, 10), "d,c,b,a.x", "el orden")',
      '	expect(fields(domain.HistoryFilter{}, 1, 2), "b,a.x", "la segunda página")',
      `	if total := hiPage(t, ${root}, root6, domain.HistoryFilter{}, 0, 1).TotalElements; total != 4 {`,
      '		t.Errorf("el total es %d; quiero 4", total)',
      '	}',
      '	expect(fields(domain.HistoryFilter{Field: ptr("a")}, 0, 10), "a.x", "el campo de la raíz")',
      '	expect(fields(domain.HistoryFilter{Field: ptr("a.x")}, 0, 10), "a.x", "la ruta entera")',
      '	expect(fields(domain.HistoryFilter{Field: ptr("x")}, 0, 10), "", "una hoja no es un campo de la raíz")',
      '	ranged := strings.Split(fields(domain.HistoryFilter{From: ptr(t0.Add(5 * time.Minute)), To: ptr(t0.Add(9 * time.Minute))}, 0, 10), ",")',
      '	slices.Sort(ranged)',
      '	expect(strings.Join(ranged, ","), "b,c,d", "las fechas, extremos incluidos")'
    ]);

    if (historyCases(model).includes('HI-7') && reads.length > 0) {
      const read = reads.find((candidate) => candidate.scoped) ?? reads[0];
      const locator = goExported(read.field);
      const call = (variable) => `${repo}.${read.method}(ctx, ${variable}.${locator}${read.scoped ? ', scope' : ''}, domain.HistoryFilter{}, domain.Pageable{Size: 10})`;
      const body = [];
      let ownerOverrides = [];
      if (read.scoped && scoped) {
        const path = readScopePath(model, scoped.read);
        if (path.hops.length > 1) throw new Error(`history-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
        const hop = path.hops[0] ?? null;
        const values = { a: goString(`hi-own-a-${salt}`), b: goString(`hi-own-b-${salt}`) };
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `domain.ScopeWithin([]string{${value}})` : `domain.ScopeOwnedBy(${value})`);
        if (hop) {
          const ownerField = domainMembers(model, hop.entity).find((member) => member.name === scoped.read.field);
          for (const tag of ['a', 'b']) {
            const owner = `owner${tag.toUpperCase()}`;
            body.push(
              `	${owner} := sample${hop.to}(t, ${salt++})`,
              `	${owner}.${goExported(scoped.read.field)} = ${ownerField?.optional ? `ptr(${values[tag]})` : values[tag]}`,
              `	if _, err := ${repository(model, hop.entity)}.Save(ctx, domain.Rehydrate${hop.to}(${owner})); err != nil {`,
              `		t.Fatalf("guardar el ${hop.to} ${tag.toUpperCase()}: %v", err)`,
              '	}'
            );
          }
          const reference = referenceMember(model, entity, hop.relation);
          const ownerId = goExported(hop.entity.idField?.name ?? 'id');
          const set = (owner) => (reference.optional ? `ptr(${owner}.${ownerId})` : `${owner}.${ownerId}`);
          ownerOverrides = [[goExported(reference.name), set('ownerA')]];
          body.push(...fresh('propia', ownerOverrides), ...fresh('ajena', [[goExported(reference.name), set('ownerB')]]));
        } else {
          const field = memberOf(scoped.read.field);
          const set = (value) => (field?.optional ? `ptr(${value})` : value);
          ownerOverrides = [[goExported(scoped.read.field), set(values.a)]];
          body.push(...fresh('propia', ownerOverrides), ...fresh('ajena', [[goExported(scoped.read.field), set(values.b)]]));
        }
        body.push(
          `	scope := ${scopeOf(values.a)}`,
          `	if _, found, err := ${call('propia')}; err != nil || !found {`,
          '		t.Errorf("el historial de una raíz propia no se ve: found=%t err=%v", found, err)',
          '	}',
          `	if _, found, err := ${call('ajena')}; err == nil && found {`,
          '		t.Error("el historial de una raíz ajena se ve")',
          '	}'
        );
      }
      if (lifecycle?.logical) {
        if (!read.scoped) body.push(...fresh('propia'));
        body.push(
          ...fresh('borrada', read.scoped ? ownerOverrides : []),
          ...remove('borrada'),
          `	if _, found, err := ${call('propia')}; err != nil || !found {`,
          '		t.Errorf("el historial de una raíz viva no se ve: found=%t err=%v", found, err)',
          '	}',
          `	if _, found, err := ${call('borrada')}; err == nil && found {`,
          '		t.Error("el historial de una raíz borrada se ve")',
          '	}'
        );
      }
      test('HI-7', 'UnaRaizAjenaOBorradaDaElErrorDeSuLecturaPorId', body);
    }

    if (lifecycle?.restore) {
      test('HI-10', 'RestaurarDejaLaEntradaRestored', [
        ...fresh('fila'),
        ...remove('fila'),
        `	if _, _, err := ${repo}.Restore(ctx, fila.${id}); err != nil {`,
        '		t.Fatal(err)',
        '	}',
        ...kinds('fila', 'restored,deleted,created', 'alta, baja y restauración')
      ]);
    }

    if (lifecycle?.retention?.fromDeleted) {
      const retention = lifecycle.retention;
      const span = retention.span;
      if (!span.days) throw new Error('history-probes: una retención que no es en días no tiene sujeto todavía');
      helpers.push(...rawHelpers(entity, { document, d }));
      const retentionArgs = ['probeTx', '100', ...(span.parameter ? ['probeParameters'] : []), ...(retentionCaches(model, name).length > 0 ? ['nil'] : [])];
      const expire = [
        ...fresh('fila'),
        ...update('fila', [[editableField, editedValue(`hi-ret-${salt}`)]]),
        ...remove('fila'),
        `	hi${name}Backdate(t, fila.${id}, ${span.days + 1})`,
        `	if err := New${retentionType(name)}(${retentionArgs.join(', ')}).Run(ctx); err != nil {`,
        '		t.Fatalf("la retención: %v", err)',
        '	}'
      ];
      if (retention.then === 'delete') {
        test('HI-9', 'LaPurgaDeLoBorradoSeLlevaElHistorial', [
          ...expire,
          '	// La sonda mide: la retención purgó la fila.',
          `	if hi${name}Present(t, fila.${id}) {`,
          '		t.Fatal("la retención no purgó la fila")',
          '	}',
          `	if entries := hiEntries(t, ${root}, ${key('fila')}); len(entries) != 0 {`,
          '		t.Errorf("la purga dejó %d entradas del historial", len(entries))',
          '	}'
        ]);
      } else {
        const personal = shape.personal.map(({ path, required }) => `${goString(path)}: ${required}`);
        test('HI-8', 'AnonymizeReescribeLosPersonalesYDejaLaEntradaAnonymized', [
          ...expire,
          `	all := hiEntries(t, ${root}, ${key('fila')})`,
          '	if all[0].Change != domain.HistoryAnonymized {',
          '		t.Fatalf("la última entrada es %s; quiero anonymized", all[0].Change)',
          '	}',
          `	personal := map[string]bool{${personal.join(', ')}}`,
          `	substitute := string(must(wire.Marshal("anon-" + ${key('fila')})))`,
          '	seen := 0',
          '	for _, entry := range all {',
          '		for _, change := range entry.Changes {',
          '			required, ok := personal[change.Field]',
          '			if !ok {',
          '				continue',
          '			}',
          '			seen++',
          '			want := "null"',
          '			if required {',
          '				want = substitute',
          '			}',
          '			if string(change.Before) != want || string(change.After) != want {',
          '				t.Errorf("%s %s: %s → %s; quiero %s", entry.Change, change.Field, change.Before, change.After, want)',
          '			}',
          '		}',
          '	}',
          '	// La sonda mide: el historial tenía algún campo personal.',
          '	if seen == 0 {',
          '		t.Error("el historial no tenía ningún campo personal que anonimizar")',
          '	}'
        ]);
      }
    }
    void idType;
  }

  // HI-6 mueve la hora de las entradas de una raíz que tocaron una ruta, para medir el orden y las fechas sin esperar.
  const setAt = document
    ? `	if _, err := must(probeTx.collection(${goString(CHANGE_HISTORY_COLLECTION.collection)})).UpdateMany(t.Context(), bson.D{{Key: "root_id", Value: rootID}, {Key: ${goString(`${CHANGE_HISTORY_COLLECTION.fields}.path`)}, Value: path}}, bson.D{{Key: "$set", Value: bson.D{{Key: "at", Value: instantValue(at)}}}}); err != nil {
		t.Fatal(err)
	}`
    : `	if _, err := probeDB.ExecContext(t.Context(), ${goString(`UPDATE ${CHANGE_HISTORY.table} SET at = ${d.param(1)} WHERE root_id = ${d.param(2)} AND id IN (SELECT entry_id FROM ${CHANGE_HISTORY_FIELD.table} WHERE path = ${d.param(3)})`)}, at.UTC(), rootID, path); err != nil {
		t.Fatal(err)
	}`;
  helpers.push(`// hiPage es una página del historial de una raíz, leída por el almacén.
func hiPage(t *testing.T, root historyRoot, rootID string, filter domain.HistoryFilter, page, size int32) domain.Page[domain.HistoryEntry] {
	t.Helper()
	ctx := t.Context()
	out, err := historyPage(ctx, ${store}, root, rootID, filter, domain.Pageable{Page: page, Size: size})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// hiEntries son las entradas de una raíz, la más reciente primero.
func hiEntries(t *testing.T, root historyRoot, rootID string) []domain.HistoryEntry {
	t.Helper()
	return hiPage(t, root, rootID, domain.HistoryFilter{}, 0, 100).Items
}

// hiKinds son los cambios de las entradas de una raíz, la más reciente primero, separados por comas.
func hiKinds(t *testing.T, root historyRoot, rootID string) string {
	t.Helper()
	var kinds []string
	for _, entry := range hiEntries(t, root, rootID) {
		kinds = append(kinds, string(entry.Change))
	}
	return strings.Join(kinds, ",")
}

// hiSetAt mueve la hora de las entradas de rootID que tocaron path.
func hiSetAt(t *testing.T, rootID, path string, at time.Time) {
	t.Helper()
${setAt}
}`);
  const imports = [
    'context',
    'encoding/json/jsontext',
    'errors',
    'fmt',
    'slices',
    'strconv',
    'strings',
    'testing',
    'time',
    'github.com/google/uuid',
    ...(document ? ['go.mongodb.org/mongo-driver/v2/bson'] : []),
    'internal/application',
    'internal/domain',
    'internal/platform/security',
    'internal/platform/wire'
  ];
  const body = `
// La sonda del historial de cambios (scripts/lib/history-probes.js de keel-go): HI-1 a HI-10 contra el adaptador y el
// almacén emitidos. No es parte del proyecto generado.

${helpers.join('\n\n')}

${tests.join('\n\n')}
`;
  const dir = storeDir(model);
  return { path: `${dir}/history_probe_test.go`, content: goFile({ pkg: dir.split('/').pop(), imports, body, module: model.service.goModule, generated: false }) };
}

/** Los ayudantes del almacén crudo de una raíz: retrasar su borrado y si está. */
function rawHelpers(entity, { document, d }) {
  const name = entity.name;
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  if (document) {
    const idValue = idType === 'uuid.UUID' ? 'uuidValue(id)' : 'id';
    const collection = `must(probeTx.collection(${goString(entity.collectionName)}))`;
    return [
      `// hi${name}Present dice si el documento de id está en la colección.
func hi${name}Present(t *testing.T, id ${idType}) bool {
	t.Helper()
	n, err := ${collection}.CountDocuments(t.Context(), bson.D{{Key: "_id", Value: ${idValue}}})
	if err != nil {
		t.Fatal(err)
	}
	return n > 0
}`,
      `// hi${name}Backdate retrasa days días el borrado de id.
func hi${name}Backdate(t *testing.T, id ${idType}, days int) {
	t.Helper()
	at := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
	if _, err := ${collection}.UpdateOne(t.Context(), bson.D{{Key: "_id", Value: ${idValue}}}, bson.D{{Key: "$set", Value: bson.D{{Key: ${goString(DELETED_AT.field)}, Value: instantValue(at)}}}}); err != nil {
		t.Fatal(err)
	}
}`
    ];
  }
  const q = (column) => d.quote(column);
  const table = q(entity.tableName);
  const idColumn = q(entity.idField?.columns?.name ?? 'id');
  // El SQL crudo de la sonda pasa el uuid como sus 16 bytes en MySQL (binary(16)); PostgreSQL lee el texto.
  const raw = d.mysql && idType === 'uuid.UUID' ? 'id[:]' : 'id';
  return [
    `// hi${name}Present dice si la fila de id está en la tabla.
func hi${name}Present(t *testing.T, id ${idType}) bool {
	t.Helper()
	var n int
	if err := probeDB.QueryRowContext(t.Context(), ${goString(`SELECT count(*) FROM ${table} WHERE ${idColumn} = ${d.param(1)}`)}, ${raw}).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}`,
    `// hi${name}Backdate retrasa days días el borrado de id.
func hi${name}Backdate(t *testing.T, id ${idType}, days int) {
	t.Helper()
	at := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
	if _, err := probeDB.ExecContext(t.Context(), ${goString(`UPDATE ${table} SET ${q(DELETED_AT.column)} = ${d.param(1)} WHERE ${idColumn} = ${d.param(2)}`)}, at, ${raw}); err != nil {
		t.Fatal(err)
	}
}`
  ];
}
