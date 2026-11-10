// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss`) contra el adaptador emitido, para db-check y doc-check: RS-1 a RS-8
// de keel-core/gen/read-scope.js, con los ids de los casos que ejecutan keel-spring (read-scope-check), keel-nest y
// keel-dotnet (su scripts/lib/read-scope-probes.js) sobre los MISMOS diseños (keel-core/test/helpers/read-scope-designs.js).
// Solo habla con el puerto: el mismo texto vale para los dos almacenes, cada uno con su repositorio (`repoOf`). RS-9 a RS-11
// (la clave de caché, el scope del borde y el 403 del cable) no necesitan base: son pruebas emitidas, que ejecuta go-check.
//
// Una función de prueba por caso, con el id en el nombre (`TestAsset_RS8_…`): así cada sabotaje se juzga por los casos que
// caen. Las filas se siembran UNA vez por raíz (una variable del paquete de la sonda): tres de dos dueños, A y B.
//
// Las etiquetas importan para el falsado, como en los otros tres: en una raíz cuyo campo acotado está al otro lado de una
// relación, lo que solo es verdad si el camino es el correcto (la fila propia se ve, la ajena no, el total, within con
// varios valores, la carga propia) es RS-8; lo que sigue siendo verdad con el camino roto conserva su caso.

import { findersOf } from '@keel-system/keel-core/gen';
import { READ_SCOPE_SABOTAGES, readScopePath, scopedReadsOf, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { enumConstant, goExported } from '../../src/lib/go-projection.js';
import { goString } from '../../src/lib/go-source.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { filterTypeName, finderMethod } from '../../src/scaffold/finders.js';
import { referenceMember, scopedLoadsOf } from '../../src/scaffold/read-scope.js';

// Los archivos de los adaptadores de cada almacén.
const RELATIONAL = /^internal\/infrastructure\/(?:postgres|mysql)\/\w+_repository\.go$/;
const DOCUMENT = /^internal\/infrastructure\/mongo\/\w+_repository\.go$/;

/**
 * Los sabotajes, por almacén, con la forma de db-sabotages.js y doc-sabotages.js (`files`, `from`, `to`): rompen lo
 * emitido CONSERVANDO LA FORMA (sigue compilando), y cada uno tiene que caer en exactamente sus casos. `expect` casa con
 * cualquier sonda RS: el veredicto exacto lo da `readScopeSabotageVerdict`.
 */
const spec = (relational, document) => ({
  relational: { files: RELATIONAL, ...relational, expect: /_RS\d+_/ },
  document: { files: DOCUMENT, ...document, expect: /_RS\d+_/ }
});

export const READ_SCOPE_SABOTAGE_SPECS = {
  'rs-no-filter': spec(
    { from: /^\tr\.scoped\(&f, scope\)\n/gm, to: '' },
    { from: /^\tconditions, err := r\.scoped\(ctx, conditions, scope\)\n\tif err != nil \{\n\t\treturn [^\n]*\n\t\}\n/gm, to: '' }
  ),
  // El total se cuenta ANTES de sumar el alcance: las filas salen bien y el total cuenta las de todos.
  'rs-count-unscoped': spec(
    { from: /(\tr\.scoped\(&f, scope\)\n)([\s\S]*?\.Scan\(&total\); err != nil \{\n\t\treturn [^\n]*\n\t\}\n)/g, to: '$2$1' },
    {
      from: /(\tconditions, err := r\.scoped\(ctx, conditions, scope\)\n[\s\S]*?\tquery := matching\(conditions\)\n\ttotal, err := documents\.CountDocuments\(ctx, )query\)/g,
      to: '\tunscoped := matching(conditions)\n$1unscoped)'
    }
  ),
  'rs-get-leak': spec({ from: '\tif count > 0 {', to: '\tif count >= 0 {' }, { from: '\tif count > 0 {', to: '\tif count >= 0 {' }),
  // El conjunto vacío (un claim ausente, un dueño vacío) se trata como sin filtro. La mitad del borde la mide la prueba
  // emitida (test/helpers/read-scope-sabotages.js, en go-check).
  'rs-empty-is-all': spec(
    { from: '\tif scope.Kind() == domain.ReadScopeUnrestricted {\n\t\treturn\n\t}', to: '\tif scope.Kind() == domain.ReadScopeUnrestricted || len(scope.Values()) == 0 {\n\t\treturn\n\t}' },
    { from: '\tif scope.Kind() == domain.ReadScopeUnrestricted {\n\t\treturn conditions, nil\n\t}', to: '\tif scope.Kind() == domain.ReadScopeUnrestricted || len(scope.Values()) == 0 {\n\t\treturn conditions, nil\n\t}' }
  ),
  // Con un scope, el predicado sustituye a los criterios en vez de sumarse (sin él, los criterios siguen: eso lo miden las
  // sondas de los finders, que piden con UnrestrictedScope).
  'rs-finder-replace': spec(
    { from: '\tr.scoped(&f, scope)\n', to: '\tif scope.Kind() != domain.ReadScopeUnrestricted {\n\t\tf = filters{}\n\t}\n\tr.scoped(&f, scope)\n' },
    {
      from: '\tconditions, err := r.scoped(ctx, conditions, scope)\n',
      to: '\tif scope.Kind() != domain.ReadScopeUnrestricted {\n\t\tconditions = nil\n\t}\n\tconditions, err := r.scoped(ctx, conditions, scope)\n'
    }
  ),
  // Compara otro campo de texto de la raíz del otro lado del camino (Owner.displayName, Profile.username).
  'rs-path': spec(
    { from: /( IN \(SELECT \S+ FROM \S+ WHERE )code"/g, to: '$1display_name"' },
    { from: /bson\.D\{\{Key: "(code|subject)", Value: bson\.D\{\{Key: "\$in", Value: allowed\}\}\}\}/g, to: (_, field) => `bson.D{{Key: "${field === 'code' ? 'display_name' : 'username'}", Value: bson.D{{Key: "$in", Value: allowed}}}}` }
  )
};

export const isReadScopeSabotage = (id) => Boolean(READ_SCOPE_SABOTAGE_SPECS[id]);

/** Los sujetos de los sabotajes por almacén: los de read-scope-designs.js con esa rama. */
export const READ_SCOPE_SUBJECTS = { relational: ['vault-scoped', 'shop-scoped'], document: ['vault-scoped-mongo', 'conduit-scoped'] };

/** El primer criterio del finder con el que se puede pedir algo que ninguna fila cumple, o el enum por valor (RS-7). */
function compositionFilter(finder) {
  return finder.criteria.find((criterion) => criterion.op === 'eq' && criterion.match === 'exact' && (criterion.input.kind === 'enum' || criterion.input.goType === 'string')) ?? null;
}

/** Los casos que ejecuta el bloque de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. */
export function readScopeCases(model) {
  const cases = new Set();
  for (const { entity, read } of scopedRootsOf(model)) {
    const hop = readScopePath(model, read).hops.length > 0;
    const finders = findersOf(model, entity.name).filter((finder) => finder.scope);
    if (finders.length > 0) {
      cases.add(hop ? 'RS-8' : 'RS-1').add('RS-3').add('RS-6');
      if (finders.some((finder) => finder.result === 'page')) cases.add(hop ? 'RS-8' : 'RS-2');
      if (finders.some((finder) => compositionFilter(finder))) cases.add('RS-7');
    }
    const miss = read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4';
    if (scopedLoadsOf(model, entity).length > 0) cases.add(hop ? 'RS-8' : miss).add(miss).add('RS-3');
  }
  return [...cases];
}

/** Lo que tiene que caer con un sabotaje: sus casos que el diseño ejecuta, con RS-1/RS-2 como RS-8 en un camino. */
export function readScopeSabotageVerdict(failures, id, model) {
  const cases = readScopeCases(model);
  // RS-1/RS-2 son RS-8 solo si hay un listado acotado por un camino: sin listado (conduit-scoped), no hay qué traducir.
  const listing = scopedRootsOf(model).some(({ entity }) => findersOf(model, entity.name).some((finder) => finder.scope));
  const onPath = listing && !cases.includes('RS-1') && cases.includes('RS-8');
  const located = READ_SCOPE_SABOTAGES.find((entry) => entry.id === id).falls.map((caseId) => (onPath && (caseId === 'RS-1' || caseId === 'RS-2') ? 'RS-8' : caseId));
  const want = [...new Set(located)].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((name) => [...name.matchAll(/_RS(\d+)_/g)].map((match) => `RS-${match[1]}`)))].sort();
  // Un sujeto al que el sabotaje no toca (rs-path sin salto) no tiene que caer en nada; otro sujeto lo caza.
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// La primera muestra de cada raíz acotada: lejos de las de las otras sondas (que llegan a 241, y 900 en los patrones).
const SAMPLE_BASE = 740;

/** El valor de un campo del estado (`state.X` o, si es opcional, `ptr(...)`). */
function stateValue(member, value) {
  return member?.optional ? `ptr(${value})` : value;
}

/**
 * Las pruebas de RS-1 a RS-8 de una raíz acotada, y la siembra que comparten. `repoOf(entity)` es la expresión del
 * repositorio de una raíz en la sonda del almacén, `index` distingue los valores entre raíces.
 */
export function readScopeProbes(model, root, { repoOf, index }) {
  const found = scopedRootsOf(model).find((candidate) => candidate.entity?.name === root.name);
  if (!found) return [];
  const { read } = found;
  const name = root.name;
  const repo = repoOf(root);
  const path = readScopePath(model, read);
  if (path.hops.length > 1) throw new Error(`read-scope-probes: ${name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
  const hop = path.hops[0] ?? null;
  const finders = findersOf(model, name).filter((finder) => finder.scope);
  const loads = scopedLoadsOf(model, root);
  const rows = finders.length > 0 ? ['A1', 'A2', 'B1'] : ['A1', 'B1'];
  const base = SAMPLE_BASE + 10 * index;
  const id = goExported(root.idField?.name ?? 'id');
  const idType = root.idField?.goType ?? 'uuid.UUID';
  const seed = `${name[0].toLowerCase()}${name.slice(1)}ScopeSeed`;
  const scopeOf = (value) => (read.kind === 'scoping' ? `domain.ScopeWithin([]string{${value}})` : `domain.ScopeOwnedBy(${value})`);
  const empty = read.kind === 'scoping' ? 'domain.ScopeWithin(nil)' : 'domain.ScopeOwnedBy("")';
  const members = domainMembers(model, root);

  // La siembra: dos dueños (A y B) y filas de A y de B. El campo acotado lleva un valor que NINGÚN otro campo de texto del
  // dueño repite: si coincidieran, comparar el campo equivocado del camino daría lo mismo y RS-8 no lo vería.
  const lines = [];
  if (hop) {
    const field = goExported(read.field);
    const ownerField = domainMembers(model, hop.entity).find((member) => member.name === read.field);
    ['a', 'b'].forEach((tag, k) => {
      const owner = `owner${tag.toUpperCase()}`;
      lines.push(
        `	${owner} := sample${hop.to}(t, ${base + k})`,
        `	${owner}.${field} = ${stateValue(ownerField, goString(`rs-own-${index}-${tag}`))}`,
        `	if _, err := ${repoOf(hop.entity)}.Save(ctx, domain.Rehydrate${hop.to}(${owner})); err != nil {`,
        `		t.Fatalf("guardar el ${hop.to} ${tag.toUpperCase()}: %v", err)`,
        '	}'
      );
    });
    lines.push(`	seed := &${seed}Rows{valueA: "rs-own-${index}-a", valueB: "rs-own-${index}-b"}`);
  } else {
    lines.push(`	seed := &${seed}Rows{valueA: ${goString(`rs-${index}-a@x.io`)}, valueB: ${goString(`rs-${index}-b@x.io`)}}`);
  }
  const reference = hop ? referenceMember(model, root, hop.relation) : null;
  const scopedMember = members.find((member) => member.name === (hop ? reference.name : read.field));
  rows.forEach((row, k) => {
    const local = row.toLowerCase();
    const value = hop ? `owner${row[0]}.${goExported(hop.entity.idField?.name ?? 'id')}` : `seed.value${row[0]}`;
    lines.push(
      `	${local} := sample${name}(t, ${base + 2 + k})`,
      `	${local}.${goExported(scopedMember.name)} = ${stateValue(scopedMember, value)}`,
      `	if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(${local})); err != nil {`,
      `		t.Fatalf("guardar la fila ${row}: %v", err)`,
      '	}',
      `	seed.${local} = ${local}`
    );
  });
  const tests = [
    `// ${seed}Rows son las filas de la lectura acotada de ${name} (${read.block}.reads), sembradas una vez.
type ${seed}Rows struct {
	valueA, valueB string
	${rows.map((row) => row.toLowerCase()).join(', ')}  domain.${name}State
}

var ${seed} *${seed}Rows

// seed${name}Scope siembra las filas de A y de B la primera vez, y las devuelve.
func seed${name}Scope(t *testing.T) *${seed}Rows {
	t.Helper()
	if ${seed} != nil {
		return ${seed}
	}
	ctx := t.Context()
${lines.join('\n')}
	${seed} = seed
	return seed
}`
  ];
  const probe = (caseId, title, body) =>
    tests.push(`func Test${name}_${caseId.replace('-', '')}_${title}(t *testing.T) {
	${/\bs\./.test(body) ? 's := ' : ''}seed${name}Scope(t)
	ctx := t.Context()
${body}
}`);
  const tag = (caseId) => (hop ? 'RS-8' : caseId);
  for (const finder of finders) {
    if (finder.criteria.some((criterion) => criterion.required)) throw new Error(`read-scope-probes: ${finder.method} tiene un filtro obligatorio; la sonda pide sin filtros`);
    const method = finderMethod(finder);
    const filter = (fields = '') => (finder.criteria.length > 0 ? `domain.${filterTypeName(finder)}{${fields}}` : null);
    const call = (scope, { size = 1000, fields = '' } = {}) =>
      `${repo}.${method}(${['ctx', filter(fields), finder.result === 'page' ? `domain.Pageable{Size: ${size}}` : null, scope].filter(Boolean).join(', ')})`;
    const items = finder.result === 'page' ? 'found.Items' : 'found';
    // Los ids que devuelve una llamada, en un conjunto.
    const seen = (scope, options) => `	found, err := ${call(scope, options)}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	seen := map[${idType}]bool{}
	for _, item := range ${items} {
		seen[item.${id}()] = true
	}`;
    probe(
      tag('RS-1'),
      `${method}_ElListadoVeSoloLasFilasDelScope`,
      `${seen(scopeOf('s.valueA'))}
	if !seen[s.a1.${id}] || !seen[s.a2.${id}] || seen[s.b1.${id}] {
		t.Errorf("con el scope de A se ven A1=%t, A2=%t, B1=%t; quiero solo las de A", seen[s.a1.${id}], seen[s.a2.${id}], seen[s.b1.${id}])
	}`
    );
    if (finder.result === 'page') {
      probe(
        tag('RS-2'),
        `${method}_ElTotalYLasPaginasSonLosDelScope`,
        `	found, err := ${call(scopeOf('s.valueA'), { size: 1 })}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if found.TotalElements != 2 || found.TotalPages != 2 {
		t.Errorf("la página del scope de A cuenta %d filas en %d páginas; quiero 2 en 2", found.TotalElements, found.TotalPages)
	}`
      );
    }
    probe(
      'RS-3',
      `${method}_UnrestrictedLoVeTodo`,
      `${seen('domain.UnrestrictedScope()')}
	if !seen[s.a1.${id}] || !seen[s.a2.${id}] || !seen[s.b1.${id}] {
		t.Error("sin restricción no se ven todas las filas sembradas")
	}`
    );
    probe(
      'RS-6',
      `${method}_ElScopeVacioNoVeNada`,
      `	found, err := ${call(empty)}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if len(${items}) != 0 {
		t.Errorf("el scope vacío ve %d filas; quiero ninguna", len(${items}))
	}`
    );
    if (read.kind === 'scoping') {
      probe(
        tag('RS-6'),
        `${method}_WithinConDosValoresVeLasDeLosDos`,
        `${seen('domain.ScopeWithin([]string{s.valueA, s.valueB})')}
	if !seen[s.a1.${id}] || !seen[s.a2.${id}] || !seen[s.b1.${id}] {
		t.Error("con los dos valores no se ven las filas de los dos")
	}`
      );
    }
    const composed = compositionFilter(finder);
    if (!composed) continue;
    const field = goExported(composed.name);
    if (composed.input.kind === 'enum') {
      // Para CADA valor, todo lo que sale lo lleva: si el predicado sustituye a los criterios, salen las de A con otro. No
      // «un valor que ninguna fila tiene»: otras sondas mueven el estado de las filas (medido en MySQL con keel-dotnet).
      const enumName = composed.input.goType;
      const enumDef = model.enums.find((candidate) => candidate.name === enumName);
      const target = members.find((member) => member.name === composed.target.field.name);
      const stored = target?.optional ? 'row.' + goExported(composed.target.field.name) + '()' : `ptr(row.${goExported(composed.target.field.name)}())`;
      probe(
        'RS-7',
        `${method}_ElScopeSeSumaALosCriterios`,
        `	for _, value := range []domain.${enumName}{${enumDef.values.map((value) => `domain.${enumConstant(enumName, value.literal)}`).join(', ')}} {
		found, err := ${call(scopeOf('s.valueA'), { fields: `${field}: &value` })}
		if err != nil {
			t.Fatalf("${method}: %v", err)
		}
		for _, row := range ${items} {
			if got := ${stored}; got == nil || *got != value {
				t.Errorf("con ${field} = %v sale una fila con %v", value, show(got))
			}
		}
	}`
      );
    } else {
      // Un texto que ninguna fila tiene: vacío. Si el predicado sustituye a los criterios, salen las de A.
      probe(
        'RS-7',
        `${method}_ElScopeSeSumaALosCriterios`,
        `	found, err := ${call(scopeOf('s.valueA'), { fields: `${field}: ptr("rs7-ninguna-fila-lo-tiene")` })}
	if err != nil {
		t.Fatalf("${method}: %v", err)
	}
	if len(${items}) != 0 {
		t.Errorf("con un ${field} que ninguna fila tiene salen %d filas", len(${items}))
	}`
      );
    }
  }
  if (loads.length > 0) {
    const missCase = read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4';
    const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.root === name && candidate.readScope.shape === 'single');
    for (const load of loads) {
      const keyMember = load.by === 'id' ? null : members.find((member) => member.name === load.field);
      // La clave natural puede ser opcional en el dominio (Article.Slug); la sembrada la lleva.
      const key = (row) => (load.by === 'id' ? `s.${row}.${id}` : keyMember?.optional ? `*s.${row}.${goExported(load.field)}` : `s.${row}.${goExported(load.field)}`);
      const nonexistent = load.param.type === 'int64' ? '987654321987' : load.param.type === 'int32' ? '987654321' : load.param.type === 'uuid.UUID' ? 'uuid.Must(uuid.NewV7())' : '"rs-no-existe"';
      const loadCall = (value, scope) => `${repo}.${load.method}(ctx, ${value}, ${scope})`;
      // Con el camino roto la fila propia sale como ajena, y con forbidden eso es un error: no cargó.
      probe(
        tag(missCase),
        `${load.method}_CargaLaFilaPropia`,
        `	mine, found, err := ${loadCall(key('a1'), scopeOf('s.valueA'))}
	if err != nil || !found || mine == nil {
		t.Errorf("la fila propia no carga: found=%t err=%v", found, err)
	}`
      );
      probe(
        missCase,
        `${load.method}_UnaFilaAjenaEsElReadMissDelDiseno`,
        read.readMiss === 'forbidden'
          ? `	_, _, err := ${loadCall(key('b1'), scopeOf('s.valueA'))}
	de := domainError(t, err)
	if de.Status() != 403 || de.Code() != ${goString(read.error)} {
		t.Errorf("una fila ajena sale %d %q; quiero 403 ${read.error} (${operation.name})", de.Status(), de.Code())
	}`
          : `	other, found, err := ${loadCall(key('b1'), scopeOf('s.valueA'))}
	if err != nil || found || other != nil {
		t.Errorf("una fila ajena no es «no encontrada»: found=%t err=%v", found, err)
	}`
      );
      // Orden de la 2.25 (D5): lo que no existe es «no encontrado» —su 404— antes que el 403 de lo ajeno.
      probe(
        missCase,
        `${load.method}_UnaFilaQueNoExisteNoSeEncuentra`,
        `	missing, found, err := ${loadCall(nonexistent, scopeOf('s.valueA'))}
	if err != nil || found || missing != nil {
		t.Errorf("una fila que no existe: found=%t err=%v; quiero «no encontrada» sin error", found, err)
	}`
      );
      probe(
        'RS-3',
        `${load.method}_UnrestrictedCargaCualquiera`,
        `	other, found, err := ${loadCall(key('b1'), 'domain.UnrestrictedScope()')}
	if err != nil || !found || other == nil {
		t.Errorf("sin restricción la fila de B no carga: found=%t err=%v", found, err)
	}`
      );
    }
  }
  return tests;
}
