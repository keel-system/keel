// El CICLO DE VIDA DEL DATO (DSL 2.28) contra el adaptador emitido, para db-check y doc-check: LC-1 a LC-10, RT-1 a RT-4
// y PD-2 de keel-core/gen/data-lifecycle.js, con los ids que ejecutan keel-spring (lifecycle-check), keel-nest y
// keel-dotnet (su scripts/lib/lifecycle-probes.js) sobre los MISMOS diseños (keel-core/test/helpers/data-lifecycle-designs.js).
// Habla con el puerto, con la retención emitida (su Run y su Recurring) y con el almacén solo para lo que el puerto no
// enseña (la marca, retrasar un borrado): el mismo bloque vale para los dos almacenes.
//
// Una prueba por caso, con el id en el nombre (`TestContactCard_LC3_…`), en un archivo aparte del paquete del almacén
// (`lifecycle_probe_test.go`): comparte la base con el resto de sondas, así que NO vacía tablas. Cada caso siembra sus
// propias filas y afirma solo sobre ellas; el total de una página se mide como DIFERENCIA (antes y después de sembrar).
//
// Las etiquetas importan para el falsado, como en los otros tres: cada sabotaje tiene que caer en EXACTAMENTE sus casos.
// Por eso LC-10 no siembra ninguna fila borrada (mide que el alcance sobreviva al predicado de vida, no la vida, que es
// LC-1), LC-8 SUPONE que la clave de una borrada se puede reusar (si no, lo dice LC-5), RT-1 mira el lote y RT-4 lo que
// purga `from: deleted`. RT-3 monta dos réplicas con el Recurring EMITIDO, no con uno reconstruido aquí.
//
// PD-2 es relacional, como en keel-dotnet: en Go ni el caso de uso (solo registra el code) ni el borde (solo el catch-all
// 500) registran un error del contrato, así que lo que llegaría a un log es el texto del error que devuelve el adaptador;
// la sonda lo afirma, y además que la persistencia no escriba el valor en su logger. En MySQL el mensaje del motor lleva el
// valor (`Duplicate entry '…'`), en PostgreSQL no (va en el detalle). PD-1 (el gate de logs) lo ejecuta
// test/data-lifecycle-parity.test.js.

import { ANONYMOUS_PREFIX, DATA_LIFECYCLE_CASES, DATA_LIFECYCLE_SABOTAGES, lifecycleRoots } from '@keel-system/keel-core/gen/data-lifecycle';
import { DELETED_AT, ANONYMIZED_AT, findersOf } from '@keel-system/keel-core/gen';
import { listsUnscoped } from '@keel-system/keel-core/gen/features';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { timerStatements, KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { sqlDialect, storeDir } from '../../src/lib/relational-engine.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { filterTypeName, finderMethod } from '../../src/scaffold/finders.js';
import { keyFinders, naturalKeyFinder, occupantFinders, repositoryArgs } from '../../src/scaffold/repositories.js';
import { referenceMember } from '../../src/scaffold/read-scope.js';
import { deletedFinder, retentionKindConstant, retentionType } from '../../src/scaffold/data-lifecycle.js';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────

const RELATIONAL = /^internal\/infrastructure\/(?:postgres|mysql)\/\w+_repository\.go$/;
const DOCUMENT = /^internal\/infrastructure\/mongo\/\w+_repository\.go$/;
const RETENTION = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/\w+_retention\.go$/;
const LIVE_SUFFIX = / AND deleted_at IS NULL/;

/**
 * Los sabotajes, por almacén, con la forma de db-sabotages.js y doc-sabotages.js (`files`, `from`, `to`): rompen lo
 * emitido CONSERVANDO LA FORMA (sigue compilando). Null: el sabotaje no tiene qué romper en ese almacén. `expect` casa con
 * cualquier sonda del ciclo de vida: el veredicto exacto lo da `lifecycleSabotageVerdict`.
 */
const spec = (relational, document) => ({
  relational: relational && { ...relational, expect: /_(LC|RT|PD)\d+_/ },
  document: document && { ...document, expect: /_(LC|RT|PD)\d+_/ }
});

export const LIFECYCLE_SABOTAGE_SPECS = {
  // El listado y el finder dejan de filtrar lo borrado (filas y total).
  'lc-no-filter': spec(
    { files: RELATIONAL, from: /(count\(\*\) FROM \w+) WHERE deleted_at IS NULL"|"WHERE deleted_at IS NULL ORDER BY "|^\tf\.alive\(\)\n/gm, to: (match, count) => (count ? `${count}"` : match.startsWith('"') ? '"ORDER BY "' : '') },
    { files: DOCUMENT, from: /^\tall := bson\.D\{\{Key: "deletedAt", Value: nil\}\}\n|^\tconditions = append\(conditions, bson\.D\{bson\.E\{Key: "deletedAt", Value: nil\}\}\)\n/gm, to: (match) => (match.includes('all :=') ? '\tall := bson.D{}\n' : '') }
  ),
  // Solo el total cuenta las filas borradas.
  'lc-count': spec(
    {
      files: RELATIONAL,
      // El total del finder, sin su última condición (la vida, que f.alive() suma la última): solo donde el finder la lleva.
      from: /(count\(\*\) FROM \w+) WHERE deleted_at IS NULL"|("SELECT count\(\*\) FROM \w+ ")\+f\.where\(\), f\.args\.\.\./g,
      to: (match, list, finder, offset, whole) =>
        list ? `${list}"` : whole.includes('\tf.alive()\n') ? `${finder}+(&filters{conditions: f.conditions[:len(f.conditions)-1], args: f.args}).where(), f.args...` : match
    },
    { files: DOCUMENT, from: /documents\.CountDocuments\(ctx, (all|query)\)/g, to: 'documents.CountDocuments(ctx, bson.D{})' }
  ),
  // La carga por id y por clave ven las filas borradas.
  'lc-get-leak': spec(
    { files: RELATIONAL, from: /(r\.load\(ctx, "WHERE [^"]*?) AND deleted_at IS NULL", /g, to: '$1", ' },
    { files: DOCUMENT, from: /(found, err := r\.find\(ctx, (?:filter|bson\.D\{[^\n]*?)), \{Key: "deletedAt", Value: nil\}(\}, options\.Find\(\)\.SetLimit\(1\)\))/g, to: '$1$2' }
  ),
  // Las unicidades cuentan también las filas borradas: el índice sin el predicado de vida.
  'lc-unique-all-rows': spec(
    { files: /\/migrations\/00001_baseline\.sql$/, from: /deleted_at IS NULL/g, to: '1 = 1' },
    { files: /^internal\/infrastructure\/mongo\/indexes\.go$/, from: /, \{Key: "deletedAt", Value: nil\}\}\)|\.SetPartialFilterExpression\(bson\.D\{\{Key: "deletedAt", Value: nil\}\}\)/g, to: (match) => (match.startsWith(',') ? '})' : '') }
  ),
  // La ventana de la restauración, mil veces más larga.
  'lc-restore-window': spec(
    { files: RELATIONAL, from: /deletedAt\.Add\((\d+) \* 24 \* time\.Hour\)/g, to: 'deletedAt.Add($1 * 1000 * 24 * time.Hour)' },
    { files: DOCUMENT, from: /deletedAt\.Add\((\d+) \* 24 \* time\.Hour\)/g, to: 'deletedAt.Add($1 * 1000 * 24 * time.Hour)' }
  ),
  // La lectura por referencia deja fuera lo borrado.
  'lc-embed-hidden': spec({ files: RELATIONAL, from: /(r\.load\(ctx, "WHERE id (?:= ANY\(\$1::\w+\[\]\)|IN \("\+in\+"\)))"/g, to: '$1 AND deleted_at IS NULL"' }, null),
  // El predicado de vida SUSTITUYE a lo que el finder ya llevaba (el alcance) en vez de sumarse.
  'lc-implicit-replace': spec({ files: RELATIONAL, from: /^\tf\.alive\(\)\n/gm, to: '\tf = filters{}\n\tf.alive()\n' }, null),
  // La retención vence a mitad de su plazo.
  'rt-early': spec(
    { files: RETENTION, from: /cutoff := now\.Add\(-(\d+) \* 24 \* time\.Hour\)/g, to: 'cutoff := now.Add(-$1 * 12 * time.Hour)' },
    { files: RETENTION, from: /cutoff := now\.Add\(-(\d+) \* 24 \* time\.Hour\)/g, to: 'cutoff := now.Add(-$1 * 12 * time.Hour)' }
  ),
  // La anonimización marca el agregado pero no toca sus campos personales.
  'rt-anonymize-miss': spec(
    // Cada campo conserva su valor (COALESCE con el que había) y sigue recibiendo su parámetro: la sentencia no cambia de forma.
    { files: RETENTION, from: /("UPDATE \w+ SET )([^"]*?)(anonymized_at = )/g, to: (match, head, sets, tail) => `${head}${sets.replace(/(\w+) = (\$\d+|\?)/g, '$1 = COALESCE($1, $2)')}${tail}` },
    // Sin las escrituras de los campos personales; el sustituto se sigue calculando (y se descarta) para que compile.
    {
      files: RETENTION,
      from: /(substitute := [^\n]*\n)?([^\n]*\{Key: "\$set", Value: bson\.D\{)(?:\{Key: "[^"]+", Value: (?:substitute|nil|textfold\.\w+\(substitute\))\}, )+(\{Key: "anonymizedAt")/g,
      to: (match, substitute, head, tail) => `${substitute ? `${substitute}\t\t_ = substitute\n` : ''}${head}${tail}`
    }
  ),
  // Cada réplica tiene SU recurrente: el kind deja de ser el compartido y ninguna barre una sola vez.
  'rt-every-replica': spec(
    { files: RETENTION, from: /timer\.NewRecurring\(timer\.(KindRetention\w+), /g, to: 'timer.NewRecurring(timer.$1+"@"+uuid.NewString(), ' },
    { files: RETENTION, from: /timer\.NewRecurring\(timer\.(KindRetention\w+), /g, to: 'timer.NewRecurring(timer.$1+"@"+uuid.NewString(), ' }
  ),
  // El adaptador vuelve a llevar el mensaje del motor en el error de una unicidad conocida.
  // Solo la rama de translate (la del error del motor), no la búsqueda por nombre de constraintIn.
  'pd-log-value': spec({ files: /\/errors\.go$/, from: /(if known(?:, ok)? := [^\n]*\{\n\t+)return known\n/g, to: '$1return errors.Join(known, engine)\n' }, null)
};

export const isLifecycleSabotage = (id) => Boolean(LIFECYCLE_SABOTAGE_SPECS[id]);

/**
 * Las sondas de OTRA red que un sabotaje del ciclo de vida tumba con razón: `lc-implicit-replace` sustituye lo que el finder
 * acotado ya llevaba, y el alcance es justo lo que miden RS-1, RS-2, RS-6 y RS-8 de la lectura acotada sobre el mismo finder;
 * y `lc-unique-all-rows` sobre documentos cambia el índice, que la sonda general de los índices vivos compara con el contrato.
 */
export const LIFECYCLE_ALSO = { 'lc-implicit-replace': /_RS\d+_/, 'lc-unique-all-rows': /^TestIndexes_LiveAreTheContract$/ };

/** Los sujetos de los sabotajes por almacén: los de data-lifecycle-designs.js con esa rama. */
export const LIFECYCLE_SUBJECTS = { relational: ['cards-logical', 'codes-anonymize', 'codes-delete', 'vault-logical-scoped'], document: ['cards-logical-mongo', 'codes-anonymize-mongo'] };

// ─── Lo que se mide de cada diseño ───────────────────────────────────────────────────────────────

/** Los finders por clave de una raíz que mide la sonda: la natural y los campos únicos (no los ocupantes de un `when`). */
function measuredKeyFinders(model, entity) {
  const natural = naturalKeyFinder(model, entity)?.name;
  const occupants = new Set(occupantFinders(model, entity).map((finder) => finder.name));
  return keyFinders(model, entity).filter((finder) => finder.name === natural || !occupants.has(finder.name));
}

/** Lo que las sondas necesitan de cada raíz con ciclo de vida, como los otros tres. */
export function probedRoots(model) {
  return lifecycleRoots(model).map((root) => {
    const entity = model.entities.find((candidate) => candidate.name === root.entity);
    const keyFinder = naturalKeyFinder(model, entity);
    const paginated = model.services.some((group) => group.entity === entity.name && group.operations.some((op) => op.paginated));
    const finders = findersOf(model, entity.name).filter((finder) => finder.live);
    const scoped = scopedRootsOf(model).find((candidate) => candidate.entity?.name === entity.name) ?? null;
    return {
      root,
      entity,
      keyFinder,
      keyFinders: measuredKeyFinders(model, entity),
      listed: root.logical && listsUnscoped(model, entity) && paginated,
      finders,
      batch: root.logical && Boolean(idBatchReason(model, entity)),
      scoped,
      deleted: root.restore ? deletedFinder(entity, keyFinder) : null
    };
  });
}

/** Los campos personales con una unicidad propia: el sujeto de PD-2. */
function personalUniques(model, entity) {
  return (entity.fields ?? []).filter((field) => field.personal && field.unique && !field.list);
}

/** Los casos que ejecuta el bloque de este diseño. En documental, sin PD-2 (ver la cabecera). */
export function lifecycleCases(model, { document = model.persistenceKind === 'document' } = {}) {
  const cases = new Set();
  for (const probe of probedRoots(model)) {
    const { root, keyFinders, listed, finders, batch, scoped } = probe;
    if (root.logical) {
      cases.add('LC-3');
      if (keyFinders.length > 0) cases.add('LC-4').add('LC-5');
      if (listed || finders.length > 0) cases.add('LC-1');
      if (listed || finders.some((finder) => finder.result === 'page')) cases.add('LC-2');
      if (root.restore) {
        cases.add('LC-6');
        if (Number.isInteger(root.restore.days)) cases.add('LC-7');
        if (keyFinders.length > 0) cases.add('LC-8');
      }
      if (batch) cases.add('LC-9');
      if (scoped && finders.some((finder) => finder.scope)) cases.add('LC-10');
    }
    if (root.retention) {
      cases.add('RT-1').add('RT-3');
      if (root.retention.then === 'anonymize') cases.add('RT-2');
      if (root.retention.fromDeleted) cases.add('RT-4');
    }
    if (!document && personalUniques(model, probe.entity).length > 0) cases.add('PD-2');
  }
  const order = DATA_LIFECYCLE_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Lo que tiene que caer con un sabotaje en este diseño: sus casos que el bloque ejecuta. Con PostgreSQL, `pd-log-value` no
 * tiene nada que hacer caer: el mensaje del motor no lleva el valor (va en el detalle).
 */
export function lifecycleSabotageVerdict(failures, id, model, { engine }) {
  const cases = lifecycleCases(model);
  const falls = DATA_LIFECYCLE_SABOTAGES[id].filter(() => !(id === 'pd-log-value' && engine === 'postgresql'));
  const want = [...new Set(falls.filter((caseId) => cases.includes(caseId) && caseId !== 'PD-3'))].sort();
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_(LC|RT|PD)(\d+)_/g)].map((match) => `${match[1]}-${match[2]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El archivo de la sonda ──────────────────────────────────────────────────────────────────────

// La primera muestra de las filas del ciclo de vida: lejos de las de las otras sondas (hasta 241, el ensure desde 500 y las
// de la lectura acotada desde 740).
const SAMPLE_BASE = 800;

/** La expresión del repositorio de una raíz en la sonda, la misma de db-probes y doc-probes. */
function repository(model, root, tx = 'probeTx') {
  return `New${root.name}Repository(${repositoryArgs(model, root, tx, 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})`;
}

/** `lifecycle_probe_test.go` en el paquete del almacén, o null si el diseño no tiene ciclo de vida. */
export function lifecycleProbeFile(model) {
  const probes = probedRoots(model);
  if (probes.length === 0) return null;
  const document = model.persistenceKind === 'document';
  const d = document ? null : sqlDialect(model);
  const engine = document ? 'mongodb' : d.engine;
  let salt = SAMPLE_BASE;
  const tests = [];
  const helpers = [];
  for (const probe of probes) {
    const { root, entity, keyFinders, listed, finders, batch, scoped } = probe;
    const name = entity.name;
    const lower = `${name[0].toLowerCase()}${name.slice(1)}`;
    const id = goExported(entity.idField?.name ?? 'id');
    const members = domainMembers(model, entity);
    const memberOf = (field) => members.find((member) => member.name === field);
    const repo = `lc${name}Repo()`;
    helpers.push(`// lc${name}Repo es el adaptador de ${name} de la sonda.
func lc${name}Repo() *${name}Repository {
	return ${repository(model, entity)}
}`);
    const test = (caseId, title, lines) =>
      tests.push(`func Test${name}_${caseId.replace('-', '')}_${title}(t *testing.T) {
	ctx := t.Context()
${lines.join('\n')}
}`);
    // Una fila nueva: la muestra de la raíz con lo que se fuerce, guardada.
    const fresh = (variable, overrides = []) => [
      `	${variable} := sample${name}(t, ${salt++})`,
      ...overrides.map(([field, value]) => `	${variable}.${field} = ${value}`),
      `	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(${variable})); err != nil {`,
      `		t.Fatalf("guardar ${variable}: %v", err)`,
      '	}'
    ];
    // La misma fila, pero si no se puede guardar el caso no tiene qué medir: vuelve sin fallar (lo mide otro caso).
    const tryFresh = (variable, overrides = []) => [
      `	${variable} := sample${name}(t, ${salt++})`,
      ...overrides.map(([field, value]) => `	${variable}.${field} = ${value}`),
      `	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(${variable})); err != nil {`,
      '		return',
      '	}'
    ];
    const remove = (variable) => [`	if err := ${repo}.DeleteByID(ctx, ${variable}.${id}); err != nil {`, `		t.Fatalf("borrar ${variable}: %v", err)`, '	}'];
    const keyArgs = (finder, variable) =>
      finder.params.map((param) => `${memberOf(param.name)?.optional ? '*' : ''}${variable}.${goExported(param.name)}`).join(', ');
    const keyOverrides = (source) => [...new Set(keyFinders.flatMap((finder) => finder.params.map((param) => goExported(param.name))))].map((field) => [field, `${source}.${field}`]);
    const found = (call, what) => [`	if _, found, err := ${call}; err != nil || found {`, `		t.Errorf("${what}: found=%t err=%v", found, err)`, '	}'];
    const notFound = (call, what) => [`	if _, found, err := ${call}; err != nil || !found {`, `		t.Errorf("${what}: found=%t err=%v", found, err)`, '	}'];

    if (root.logical) {
      test('LC-3', 'LaCargaPorIdNoVeUnaFilaBorrada', [
        ...fresh('borrada'),
        ...fresh('viva'),
        ...remove('borrada'),
        ...found(`${repo}.FindByID(ctx, borrada.${id})`, 'una fila borrada sigue cargando por id'),
        ...notFound(`${repo}.FindByID(ctx, viva.${id})`, 'una fila viva no carga'),
        '	// D5: borrarla otra vez no la devuelve.',
        ...remove('borrada'),
        ...found(`${repo}.FindByID(ctx, borrada.${id})`, 'borrar dos veces la devolvió')
      ]);
      for (const finder of keyFinders) {
        test('LC-4', `${finder.name}NoVeUnaFilaBorrada`, [...fresh('borrada'), ...remove('borrada'), ...found(`${repo}.${finder.name}(ctx, ${keyArgs(finder, 'borrada')})`, `${finder.name} ve una fila borrada`)]);
      }
      if (keyFinders.length > 0) {
        test('LC-5', 'LaClaveDeUnaBorradaSePuedeVolverAUsar', [
          ...fresh('borrada'),
          ...remove('borrada'),
          '	// La clave de la borrada, en otra fila viva: el índice único solo cuenta las vivas (D4).',
          ...fresh('nueva', keyOverrides('borrada')),
          ...notFound(`${repo}.FindByID(ctx, nueva.${id})`, 'la nueva con la clave de la borrada no carga')
        ]);
      }
      const listings = [];
      if (listed) listings.push({ call: (size) => `${repo}.List(ctx, domain.Pageable{Size: ${size}})`, page: true, label: 'List' });
      for (const finder of finders) {
        if (finder.criteria.some((criterion) => criterion.required)) throw new Error(`lifecycle-probes: ${finder.method} tiene un filtro obligatorio; la sonda pide sin filtros`);
        const filter = finder.criteria.length > 0 ? `domain.${filterTypeName(finder)}{}` : null;
        listings.push({
          call: (size) => `${repo}.${finderMethod(finder)}(${['ctx', filter, finder.result === 'page' ? `domain.Pageable{Size: ${size}}` : null, finder.scope ? 'domain.UnrestrictedScope()' : null].filter(Boolean).join(', ')})`,
          page: finder.result === 'page',
          label: finderMethod(finder)
        });
      }
      for (const listing of listings) {
        const items = listing.page ? 'page.Items' : 'page';
        test('LC-1', `${listing.label}NoDevuelveUnaFilaBorrada`, [
          ...fresh('borrada'),
          ...fresh('viva'),
          ...remove('borrada'),
          `	page, err := ${listing.call(100_000)}`,
          '	if err != nil {',
          `		t.Fatalf("${listing.label}: %v", err)`,
          '	}',
          `	seen := map[${entity.idField?.goType ?? 'uuid.UUID'}]bool{}`,
          `	for _, item := range ${items} {`,
          `		seen[item.${id}()] = true`,
          '	}',
          `	if !seen[viva.${id}] || seen[borrada.${id}] {`,
          `		t.Errorf("${listing.label} ve la viva=%t y la borrada=%t; quiero solo la viva", seen[viva.${id}], seen[borrada.${id}])`,
          '	}'
        ]);
        if (listing.page) {
          test('LC-2', `${listing.label}ElTotalNoCuentaLasBorradas`, [
            `	before, err := ${listing.call(1)}`,
            '	if err != nil {',
            '		t.Fatal(err)',
            '	}',
            ...fresh('borrada'),
            ...fresh('viva'),
            ...remove('borrada'),
            `	after, err := ${listing.call(1)}`,
            '	if err != nil {',
            '		t.Fatal(err)',
            '	}',
            '	// Otras sondas guardan filas de la misma raíz: lo que se mide es la diferencia, una viva más.',
            '	if after.TotalElements != before.TotalElements+1 {',
            '		t.Errorf("el total pasó de %d a %d; quiero una más (la viva)", before.TotalElements, after.TotalElements)',
            '	}'
          ]);
        }
      }
      if (root.restore) {
        const deleted = probe.deleted;
        test('LC-6', 'RestaurarDentroDeLaVentanaLaDejaViva', [
          ...fresh('borrada'),
          ...remove('borrada'),
          ...notFound(`${repo}.Restore(ctx, borrada.${id})`, 'restaurar dentro de la ventana no la encuentra'),
          ...notFound(`${repo}.FindByID(ctx, borrada.${id})`, 'restaurada, no carga'),
          ...found(`${repo}.Restore(ctx, borrada.${id})`, 'restaurar una viva la encuentra'),
          ...(deleted
            ? [
                ...remove('borrada'),
                `	again, ok, err := ${repo}.${deleted.name}(ctx, ${keyArgs(probe.keyFinder, 'borrada')})`,
                `	if err != nil || !ok || again.${id}() != borrada.${id} {`,
                `		t.Errorf("${deleted.name} no da la borrada: ok=%t err=%v", ok, err)`,
                '	}'
              ]
            : [])
        ]);
        if (Number.isInteger(root.restore.days)) {
          test('LC-7', 'RestaurarFueraDeLaVentanaEsElErrorDeclarado', [
            ...fresh('borrada'),
            ...remove('borrada'),
            `	lc${name}Backdate(t, borrada.${id}, ${root.restore.days + 1})`,
            `	_, _, err := ${repo}.Restore(ctx, borrada.${id})`,
            `	if de := domainError(t, err); de.Code() != ${goString(root.restore.error)} {`,
            `		t.Errorf("fuera de la ventana sale %q; quiero ${root.restore.error}", de.Code())`,
            '	}',
            '	// Por el almacén y no por la carga del puerto, que es LC-3: el intento no le quitó la marca.',
            `	if !lc${name}Marked(t, borrada.${id}, ${goString(document ? DELETED_AT.field : DELETED_AT.column)}) {`,
            '		t.Error("el intento fuera de la ventana le quitó la marca de borrado")',
            '	}'
          ]);
        }
        if (keyFinders.length > 0) {
          test('LC-8', 'RestaurarConLaClaveOcupadaEsEl409DeSuUnicidad', [
            ...fresh('borrada'),
            ...remove('borrada'),
            '	// Supone LC-5: si la clave de una borrada no se puede reusar, lo dice LC-5 y este caso no tiene qué medir.',
            ...tryFresh('ocupante', keyOverrides('borrada')),
            `	_, _, err := ${repo}.Restore(ctx, borrada.${id})`,
            '	if de := domainError(t, err); de.Status() != 409 {',
            '		t.Errorf("restaurar con la clave ocupada sale %d %q; quiero el 409 de su unicidad", de.Status(), de.Code())',
            '	}'
          ]);
        }
      }
      if (batch) {
        test('LC-9', 'FindAllByIDVeLaRaizBorrada', [
          ...fresh('borrada'),
          ...remove('borrada'),
          `	all, err := ${repo}.FindAllByID(ctx, []${entity.idField?.goType ?? 'uuid.UUID'}{borrada.${id}})`,
          `	if err != nil || len(all) != 1 || all[0].${id}() != borrada.${id} {`,
          '		t.Errorf("la lectura por referencia no ve la raíz borrada: %d filas, err=%v", len(all), err)',
          '	}'
        ]);
      }
      const scopedFinder = scoped ? finders.find((finder) => finder.scope) : null;
      if (scopedFinder) {
        const path = readScopePath(model, scoped.read);
        if (path.hops.length > 1) throw new Error(`lifecycle-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
        const hop = path.hops[0] ?? null;
        const values = { a: goString(`lc-own-a-${engine}`), b: goString(`lc-own-b-${engine}`) };
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `domain.ScopeWithin([]string{${value}})` : `domain.ScopeOwnedBy(${value})`);
        const lines = ['	// Sin ninguna fila borrada: lo que se mide es que el alcance sobreviva al predicado de vida, no la vida (LC-1).'];
        if (hop) {
          const ownerRepo = repository(model, hop.entity);
          const ownerField = domainMembers(model, hop.entity).find((member) => member.name === scoped.read.field);
          for (const tag of ['a', 'b']) {
            const owner = `owner${tag.toUpperCase()}`;
            lines.push(
              `	${owner} := sample${hop.to}(t, ${salt++})`,
              `	${owner}.${goExported(scoped.read.field)} = ${ownerField?.optional ? `ptr(${values[tag]})` : values[tag]}`,
              `	if _, err := ${ownerRepo}.Save(ctx, domain.Rehydrate${hop.to}(${owner})); err != nil {`,
              `		t.Fatalf("guardar el ${hop.to} ${tag.toUpperCase()}: %v", err)`,
              '	}'
            );
          }
          const reference = referenceMember(model, entity, hop.relation);
          const ownerId = goExported(hop.entity.idField?.name ?? 'id');
          const set = (owner) => (reference.optional ? `ptr(${owner}.${ownerId})` : `${owner}.${ownerId}`);
          lines.push(...fresh('a1', [[goExported(reference.name), set('ownerA')]]), ...fresh('b1', [[goExported(reference.name), set('ownerB')]]));
        } else {
          const field = memberOf(scoped.read.field);
          const set = (value) => (field?.optional ? `ptr(${value})` : value);
          lines.push(...fresh('a1', [[goExported(scoped.read.field), set(values.a)]]), ...fresh('b1', [[goExported(scoped.read.field), set(values.b)]]));
        }
        const filter = scopedFinder.criteria.length > 0 ? `domain.${filterTypeName(scopedFinder)}{}` : null;
        const call = `${repo}.${finderMethod(scopedFinder)}(${['ctx', filter, scopedFinder.result === 'page' ? 'domain.Pageable{Size: 100000}' : null, scopeOf(values.a)].filter(Boolean).join(', ')})`;
        lines.push(
          `	page, err := ${call}`,
          '	if err != nil {',
          '		t.Fatal(err)',
          '	}',
          `	seen := map[${entity.idField?.goType ?? 'uuid.UUID'}]bool{}`,
          `	for _, item := range ${scopedFinder.result === 'page' ? 'page.Items' : 'page'} {`,
          `		seen[item.${id}()] = true`,
          '	}',
          `	if !seen[a1.${id}] || seen[b1.${id}] {`,
          `		t.Errorf("con el scope de A se ven A1=%t y B1=%t; quiero solo A1", seen[a1.${id}], seen[b1.${id}])`,
          '	}'
        );
        test('LC-10', `${finderMethod(scopedFinder)}ElPredicadoDeVidaNoSeComeElAlcance`, lines);
      }
    }

    // El almacén crudo: retrasar un borrado, si una fila está y si lleva una marca.
    helpers.push(...rawHelpers(model, entity, { document, d, logical: root.logical }));

    if (root.retention) {
      const retention = root.retention;
      const span = retention.span;
      if (!span.days) throw new Error('lifecycle-probes: una retención sin días literales no tiene sujeto todavía');
      const retentionArgs = ['probeTx', '2', ...(span.parameter ? ['probeParameters'] : []), ...(retentionCaches(model, name).length > 0 ? ['nil'] : [])];
      const run = [`	if err := New${retentionType(name)}(${retentionArgs.join(', ')}).Run(ctx); err != nil {`, '		t.Fatalf("la retención: %v", err)', '	}'];
      const present = (variable) => `lc${name}Present(t, ${variable}.${id})`;
      const marked = (variable) => `lc${name}Marked(t, ${variable}.${id}, ${goString(document ? ANONYMIZED_AT.field : ANONYMIZED_AT.column)})`;
      if (retention.fromDeleted) {
        test('RT-1', 'UnaFilaVivaOBorradaDentroDeLaRetencionNoVence', [
          ...fresh('viva'),
          ...fresh('reciente'),
          ...remove('reciente'),
          `	lc${name}Backdate(t, reciente.${id}, ${span.days - 1})`,
          ...run,
          `	if !${present('viva')} || !${present('reciente')} {`,
          `		t.Errorf("venció lo que no: viva=%t, borrada dentro de la retención=%t", ${present('viva')}, ${present('reciente')})`,
          '	}'
        ]);
        const old = ['vieja1', 'vieja2', 'vieja3'];
        // Lo que `from: deleted` hace con lo vencido es su `then`: purgarlo o, con anonymize, anonimizarlo (no lo borra).
        const anonymizes = retention.then === 'anonymize';
        test('RT-4', anonymizes ? 'LoBorradoHaceMasDeLaRetencionSeAnonimiza' : 'LoBorradoHaceMasDeLaRetencionSePurga', [
          '	// Tres, con el lote de dos: el tick repite mientras salga lleno.',
          ...old.flatMap((variable) => fresh(variable)),
          ...old.flatMap((variable) => [...remove(variable), `	lc${name}Backdate(t, ${variable}.${id}, ${span.days + 1})`]),
          ...run,
          ...old.flatMap((variable) =>
            anonymizes
              ? [`	if !${marked(variable)} {`, `		t.Error("${variable}: lo borrado hace más de la retención se anonimiza, también más allá del primer lote")`, '	}']
              : [`	if ${present(variable)} {`, `		t.Error("${variable}: lo borrado hace más de la retención se purga, también más allá del primer lote")`, '	}']
          )
        ]);
      } else {
        const from = memberOf(retention.from);
        const ago = (days) => (from?.optional ? `ptr(time.Now().UTC().Add(-${days} * 24 * time.Hour))` : `time.Now().UTC().Add(-${days} * 24 * time.Hour)`);
        const fromField = goExported(retention.from);
        const due = retention.then === 'delete' ? (variable) => `!${present(variable)}` : (variable) => marked(variable);
        const kept = retention.then === 'delete' ? (variable) => present(variable) : (variable) => `!${marked(variable)}`;
        test('RT-1', 'SoloVenceLoQuePasoLaRetencion', [
          ...fresh('vencida', [[fromField, ago(span.days + 1)]]),
          ...fresh('reciente', [[fromField, ago(span.days - 1)]]),
          ...run,
          `	if !(${due('vencida')}) {`,
          `		t.Error("lo vencido no se ${retention.then === 'delete' ? 'borró' : 'anonimizó'}")`,
          '	}',
          `	if !(${kept('reciente')}) {`,
          `		t.Error("lo que está dentro de la retención se ${retention.then === 'delete' ? 'borró' : 'anonimizó'}")`,
          '	}'
        ]);
        if (retention.then === 'anonymize') {
          const personal = retention.anonymize.find((member) => member.entity === name)?.fields ?? [];
          const checks = personal.flatMap((field) => {
            const accessor = `${goExported(field.name)}()`;
            const optional = memberOf(field.name)?.optional;
            return field.required
              ? [
                  `	if got := after.${accessor}; ${optional ? 'got == nil || *got' : 'got'} != ${goString(ANONYMOUS_PREFIX)}+vencida.${id}.String() {`,
                  `		t.Errorf("${field.name} anonimizado = %v; quiero el sustituto", show(got))`,
                  '	}',
                  '	// La otra lleva SU sustituto: la unicidad sobrevive.',
                  `	if got := other.${accessor}; ${optional ? 'got == nil || *got' : 'got'} != ${goString(ANONYMOUS_PREFIX)}+otra.${id}.String() {`,
                  `		t.Errorf("${field.name} de la otra = %v; quiero su sustituto", show(got))`,
                  '	}'
                ]
              : [`	if got := after.${accessor}; got != nil {`, `		t.Errorf("${field.name} anonimizado = %v; quiero nil", show(got))`, '	}'];
          });
          test('RT-2', 'AnonymizeVaciaLosOpcionalesYSustituyeLosObligatorios', [
            ...fresh('vencida', [[fromField, ago(span.days + 1)]]),
            ...fresh('otra', [[fromField, ago(span.days + 2)]]),
            ...run,
            `	after, ok, err := ${repo}.FindByID(ctx, vencida.${id})`,
            '	if err != nil || !ok {',
            '		t.Fatalf("la anonimizada no carga: %v", err)',
            '	}',
            `	other, ok, err := ${repo}.FindByID(ctx, otra.${id})`,
            '	if err != nil || !ok {',
            '		t.Fatalf("la otra anonimizada no carga: %v", err)',
            '	}',
            ...checks
          ]);
        }
      }
      tests.push(replicaProbe(model, entity, { document, d, retentionArgs }));
    }

    const personal = document ? [] : personalUniques(model, entity);
    if (personal.length > 0) {
      const field = goExported(personal[0].name);
      const value = goString(`pd2-${name.toLowerCase()}@valor.personal`);
      const set = memberOf(personal[0].name)?.optional ? `ptr(${value})` : value;
      test('PD-2', 'UnaUnicidadVioladaNoLlevaElValorAlLog', [
        '	// Lo que escribe la persistencia en su logger, capturado; y el error que devuelve el adaptador, que es lo que llegaría',
        '	// a un log si alguien lo registrara.',
        '	var logs strings.Builder',
        `	repo := ${repository(model, entity, `NewTransactions(probeDB, 5*time.Second, slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))`)}`,
        ...fresh('primera', [[field, set]]).map((line) => line.replace(repo, 'repo')),
        `	segunda := sample${name}(t, ${salt++})`,
        `	segunda.${field} = ${set}`,
        `	_, err := repo.Save(ctx, domain.Rehydrate${name}(segunda))`,
        '	if err == nil {',
        `		t.Fatal("la unicidad de ${personal[0].name} no saltó")`,
        '	}',
        `	if strings.Contains(err.Error(), ${value}) || strings.Contains(logs.String(), ${value}) {`,
        '		t.Errorf("el valor personal viaja en el error o en el log: %v | %s", err, logs.String())',
        '	}'
      ]);
    }
  }
  const imports = ['context', 'log/slog', 'strings', 'sync', 'testing', 'time', 'github.com/google/uuid', ...(document ? ['go.mongodb.org/mongo-driver/v2/bson'] : []), 'internal/domain', 'internal/infrastructure/timer'];
  const body = `
// La sonda del ciclo de vida del dato (scripts/lib/lifecycle-probes.js de keel-go): LC-*, RT-* y PD-2 contra el adaptador
// emitido. No es parte del proyecto generado.

${helpers.join('\n\n')}

${tests.join('\n\n')}
`;
  const dir = storeDir(model);
  return { path: `${dir}/lifecycle_probe_test.go`, content: goFile({ pkg: dir.split('/').pop(), imports, body, module: model.service.goModule, generated: false }) };
}

/** Los ayudantes del almacén crudo de una raíz: retrasar su borrado, si está y si lleva una marca. */
function rawHelpers(model, entity, { document, d, logical }) {
  const name = entity.name;
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  if (document) {
    const idValue = idType === 'uuid.UUID' ? 'uuidValue(id)' : 'id';
    const collection = `must(probeTx.collection(${goString(entity.collectionName)}))`;
    return [
      `// lc${name}Present dice si el documento de id está en la colección.
func lc${name}Present(t *testing.T, id ${idType}) bool {
	t.Helper()
	n, err := ${collection}.CountDocuments(t.Context(), bson.D{{Key: "_id", Value: ${idValue}}})
	if err != nil {
		t.Fatal(err)
	}
	return n > 0
}`,
      `// lc${name}Marked dice si el documento de id lleva la marca mark.
func lc${name}Marked(t *testing.T, id ${idType}, mark string) bool {
	t.Helper()
	n, err := ${collection}.CountDocuments(t.Context(), bson.D{{Key: "_id", Value: ${idValue}}, {Key: mark, Value: bson.D{{Key: "$ne", Value: nil}}}})
	if err != nil {
		t.Fatal(err)
	}
	return n > 0
}`,
      ...(logical
        ? [`// lc${name}Backdate retrasa days días el borrado de id.
func lc${name}Backdate(t *testing.T, id ${idType}, days int) {
	t.Helper()
	at := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
	if _, err := ${collection}.UpdateOne(t.Context(), bson.D{{Key: "_id", Value: ${idValue}}}, bson.D{{Key: "$set", Value: bson.D{{Key: ${goString(DELETED_AT.field)}, Value: instantValue(at)}}}}); err != nil {
		t.Fatal(err)
	}
}`]
        : [])
    ];
  }
  const q = (column) => d.quote(column);
  const table = q(entity.tableName);
  const idColumn = q(entity.idField?.columns?.name ?? 'id');
  // El SQL crudo de la sonda pasa el uuid como sus 16 bytes en MySQL (binary(16)); PostgreSQL lee el texto.
  const raw = d.mysql && idType === 'uuid.UUID' ? 'id[:]' : 'id';
  return [
    `// lc${name}Present dice si la fila de id está en la tabla.
func lc${name}Present(t *testing.T, id ${idType}) bool {
	t.Helper()
	var n int
	if err := probeDB.QueryRowContext(t.Context(), ${goString(`SELECT count(*) FROM ${table} WHERE ${idColumn} = ${d.param(1)}`)}, ${raw}).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}`,
    `// lc${name}Marked dice si la fila de id lleva la marca mark.
func lc${name}Marked(t *testing.T, id ${idType}, mark string) bool {
	t.Helper()
	var n int
	if err := probeDB.QueryRowContext(t.Context(), ${goString(`SELECT count(*) FROM ${table} WHERE ${idColumn} = ${d.param(1)} AND `)}+mark+" IS NOT NULL", ${raw}).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}`,
    ...(logical
      ? [`// lc${name}Backdate retrasa days días el borrado de id.
func lc${name}Backdate(t *testing.T, id ${idType}, days int) {
	t.Helper()
	at := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
	if _, err := probeDB.ExecContext(t.Context(), ${goString(`UPDATE ${table} SET ${q(DELETED_AT.column)} = ${d.param(1)} WHERE ${idColumn} = ${d.param(2)}`)}, at, ${raw}); err != nil {
		t.Fatal(err)
	}
}`]
      : [])
  ];
}

/** RT-3: dos réplicas con el Recurring EMITIDO, cada tick contado; uno solo por disparo. */
function replicaProbe(model, entity, { document, d, retentionArgs }) {
  const name = entity.name;
  const kind = `timer.${retentionKindConstant(name)}`;
  const clear = document
    ? `	if _, err := must(probeTx.collection(${goString(KEEL_TIMER.table)})).DeleteMany(t.Context(), bson.D{}); err != nil {
		t.Fatal(err)
	}`
    : `	if _, err := probeDB.ExecContext(t.Context(), ${goString(`DELETE FROM ${KEEL_TIMER.table}`)}); err != nil {
		t.Fatal(err)
	}`;
  const fire = document
    ? `	now, err := NewTimerStore(probeTx).DBNow(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := must(probeTx.collection(${goString(KEEL_TIMER.table)})).UpdateMany(t.Context(), bson.D{{Key: "kind", Value: ${kind}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "due_at", Value: bson.NewDateTimeFromTime(now)}, {Key: "claimed_until", Value: nil}, {Key: "claim_token", Value: nil}}}}); err != nil {
		t.Fatal(err)
	}`
    : `	query, args, err := timerSQL(${goString(timerStatements(d.engine).fire)}, map[string]any{"kind": ${kind}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := probeDB.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}`;
  return `// lc${name}Ticks cuenta los ticks de la retención de ${name} entre las réplicas de RT-3.
type lc${name}Ticks struct {
	timer.Recurring
	mu    *sync.Mutex
	ticks *int
}

// Tick ejecuta el de verdad y lo cuenta.
func (c lc${name}Ticks) Tick(ctx context.Context) error {
	c.mu.Lock()
	*c.ticks++
	c.mu.Unlock()
	return c.Recurring.Tick(ctx)
}

func Test${name}_RT3_ConDosReplicasCadaTickLoBarreUna(t *testing.T) {
${clear}
	var (
		mu    sync.Mutex
		ticks int
	)
	settings := timer.Settings{Enabled: true, MaxSleep: 30 * time.Second, BatchSize: 50, Lease: time.Minute, MaxAttempts: 10, DrainBudget: 50 * time.Second, RetentionDays: 7, PurgeCron: "0 30 5 * * *"}
	replica := func() *timer.Poller {
		recurring, err := New${retentionType(name)}(${retentionArgs.join(', ')}).Recurring("0 30 2 * * *")
		if err != nil {
			t.Fatal(err)
		}
		return must(timer.NewPoller(NewTimerStore(probeTx), nil, []timer.Recurring{lc${name}Ticks{Recurring: recurring, mu: &mu, ticks: &ticks}}, settings, slog.New(slog.DiscardHandler)))
	}
	a, b := replica(), replica()
	for _, poller := range []*timer.Poller{a, b} {
		if err := poller.EnsureRecurring(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
${fire}
	for _, poller := range []*timer.Poller{a, b} {
		if _, err := poller.PollOnce(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if ticks != 1 {
		t.Errorf("el tick de la retención de ${name} lo ejecutaron %d réplicas, no una", ticks)
	}
${clear}
}`;
}
