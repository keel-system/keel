// Las sondas de la BÚSQUEDA de DSL 2.32 (in, ne, search y el ?sort= del cliente) para db-check y doc-check: los casos
// FS-* (keel-core/gen/query-filters.js) y SO-* (keel-core/gen/pagination.js) sobre el sujeto `catalog-search` y su gemelo
// documental (keel-core/test/helpers/finder-designs.js, SEARCH_DESIGNS), con los MISMOS ids que el finder-check de
// keel-spring y las sondas de keel-nest y keel-dotnet.
//
// Una prueba por caso, con el id en el nombre (`TestSearch_FS3_…`), en dos archivos. Los FS-* van en el paquete del almacén
// (`search_probe_test.go`): guardan las filas de FINDER_SEARCH_ROWS una sola vez por el ADAPTADOR emitido y llaman a su
// finder, así que lo que se mide es lo que emite build, también la collation del orden (FS-3 y FS-9 leen la página en el
// orden del diseño). Los SO-* van en internal/httpapi (`search_sort_probe_test.go`), porque `pageableParam` no se exporta:
// lo llaman con lo que el endpoint le pasa a esa operación (el orden del diseño y su sortable).
//
// El sujeto solo ejecuta sus casos (db-check y doc-check le pasan `-test.run`): FS-9 cuenta las filas de la tabla, y lo
// demás de product-catalog ya lo mide su sujeto.

import { FINDER_SABOTAGES, FINDER_SEARCH_CASES, FINDER_SEARCH_ROWS, findersOf } from '@keel-system/keel-core/gen/query-filters';
import { SO_CASES, SO_SABOTAGES, pageableDefaults } from '@keel-system/keel-core/gen/pagination';
import { enumConstant, goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { storeDir } from '../../src/lib/relational-engine.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { filterTypeName, finderMethod } from '../../src/scaffold/finders.js';
import { repositoryArgs } from '../../src/scaffold/repositories.js';
import { PROBE_RECONCILIATION } from './reconciliation-probes.js';

/** La query del sujeto, sobre la que están escritos los casos. */
export const SUBJECT_OPERATION = 'searchCatalog';

/** El `-test.run` con el que db-check y doc-check ejecutan solo los casos en el sujeto. */
export const SEARCH_RUN = '^TestSearch_';

/** El paquete de las sondas del orden del cliente, relativo al módulo. */
export const SEARCH_SORT_PACKAGE = 'internal/httpapi';

/** Los sujetos por almacén: los de finder-designs.js. */
export const SEARCH_SUBJECTS = { relational: ['catalog-search'], document: ['catalog-search-mongo'] };

const ADAPTER = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/\w+_repository\.go$/;
const VALUES = /^internal\/infrastructure\/(?:postgres|mysql)\/values\.go$/;
const READING = /^internal\/httpapi\/reading\.go$/;
const BASELINE = /^internal\/infrastructure\/(?:postgres|mysql)\/migrations\/00001_baseline\.sql$/;
const EXPECT = /_(FS|SO)\d+_/;

/** Cada sabotaje del orden del cliente, con la forma de db-sabotages.js. Todos compilan: lo que se mide es la sonda. */
const so = {
  // Acepta cualquier campo: lo que sortable ofrece se sigue traduciendo, y lo demás pasa tal cual.
  'so-open': {
    files: READING,
    from: '\t\tproperty, ok := sortable[parts[0]]\n',
    to: '\t\tproperty, ok := sortable[parts[0]]\n\t\tif !ok {\n\t\t\tproperty, ok = parts[0], parts[0] != ""\n\t\t}\n'
  },
  'so-case': { files: READING, from: '\t\t\tdirection = parts[1]\n', to: '\t\t\tdirection = strings.ToLower(parts[1])\n' },
  'so-duplicate': { files: READING, from: '\t\tseen[parts[0]] = true\n', to: '\t\tseen[parts[0]] = false\n' },
  // El orden del cliente se SUMA al del diseño: los criterios del diseño que no pidió, delante.
  'so-append': {
    files: READING,
    from: '\tif sort == nil {\n\t\tsort = defaultSort\n\t}\n',
    to:
      '\tvar extra []domain.SortOrder\n\tfor _, order := range defaultSort {\n\t\tasked := false\n\t\tfor _, mine := range sort {\n\t\t\tasked = asked || mine.Property == order.Property\n\t\t}\n\t\tif !asked {\n\t\t\textra = append(extra, order)\n\t\t}\n\t}\n\tif sort == nil {\n\t\tsort = defaultSort\n\t} else {\n\t\tsort = append(extra, sort...)\n\t}\n'
  }
};

export const SEARCH_SABOTAGE_SPECS = {
  // in compara solo con el primer elemento de la lista.
  'finder-in': {
    relational: { files: ADAPTER, from: /f\.oneOf\(("[^"]+"), (\w+)\)/g, to: 'f.oneOf($1, $2[:1])' },
    document: { files: ADAPTER, from: /\{Key: "\$in", Value: (\w+)\}/g, to: '{Key: "$in", Value: $1[:1]}' }
  },
  // La lista vacía de un `in` vuelve a restringir: el `IN ()` que vacía el listado cuando la lista no viene (FS-11).
  'finder-in-empty': {
    relational: { files: ADAPTER, from: /; len\((\w+)\) > 0 \{/g, to: '; $1 != nil {' },
    document: { files: ADAPTER, from: /; len\((\w+)\) > 0 \{/g, to: '; $1 != nil {' }
  },
  // ne deja fuera la fila sin valor: el <> de SQL a pelo, y $nin con el nulo en Mongo.
  'finder-ne-null': {
    relational: { files: VALUES, from: '"("+column+" IS NULL OR "+column+" <>"', to: '"("+column+" <>"' },
    document: { files: ADAPTER, from: /\{Key: "\$ne", Value: (\w+)\}/g, to: '{Key: "$nin", Value: bson.A{nil, $1}}' }
  },
  // Uno por modelo: en Mongo `%` y `_` no son comodines (FS-7 no ve nada) y el `.` sí (FS-10).
  'finder-search-literal': { relational: { files: ADAPTER, from: /^(\t+f\.anyLike\(.*)likeLiteral\((.*)\)\+"%"\)$/gm, to: '$1($2)+"%")' } },
  // El regexp sigue en uso (QuoteMeta de nada): el texto entra sin citar.
  'finder-search-regex': { document: { files: ADAPTER, from: /bson\.Regex\{Pattern: regexp\.QuoteMeta\((\w+Folded)\)\}/g, to: 'bson.Regex{Pattern: $1 + regexp.QuoteMeta("")}' } },
  ...Object.fromEntries(Object.entries(so).map(([id, spec]) => [id, { relational: spec, document: spec }])),
  // La collation del orden (U7, D17): `name` vuelve a la de por defecto del motor. Solo la ven FS-3 y FS-9 en MySQL, que
  // ordena 'Ñandú' junto a la N con utf8mb4_0900_ai_ci; PostgreSQL alpine compara bytes igualmente (B0, M11). En los dos
  // motores la ve la comparación del esquema contra el diseño (orderCollationDifferences de db-check).
  'order-collation': { relational: { files: BASELINE, from: /^(\s+name\s+varchar\(\d+\)) COLLATE (?:"C"|utf8mb4_bin)/m, to: '$1' } }
};

for (const spec of Object.values(SEARCH_SABOTAGE_SPECS)) {
  for (const branch of Object.values(spec)) branch.expect = EXPECT;
}

const BREAKS = Object.fromEntries([...Object.entries(FINDER_SABOTAGES), ...Object.entries(SO_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

export const isSearchSabotage = (id) => Boolean(SEARCH_SABOTAGE_SPECS[id]);

/** La query del sujeto si este modelo es el de los casos (su finder con una búsqueda libre y su sortable), o null. */
export function searchSubject(model) {
  const operation = (model.services ?? []).flatMap((group) => group.operations).find((candidate) => candidate.name === SUBJECT_OPERATION);
  return operation?.finder?.criteria.some((criterion) => criterion.op === 'search') && (operation.sortable ?? []).length > 0 ? operation : null;
}

/** Los casos que ejecuta el bloque de este diseño. */
export function searchCases(model) {
  return searchSubject(model) ? [...FINDER_SEARCH_CASES.map((entry) => entry.id), ...SO_CASES.map((entry) => entry.id)] : [];
}

/** Lo que tiene que caer con un sabotaje: sus casos, y solo esos (`order-collation`: FS-3 y FS-9 solo en MySQL). */
export function searchSabotageVerdict(failures, id, model, { engine = null } = {}) {
  const cases = searchCases(model);
  const breaks = id === 'order-collation' ? (engine === 'mysql' ? ['FS-3', 'FS-9', 'FS-11'] : []) : BREAKS[id] ?? [];
  const want = breaks.filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/_(FS|SO)(\d+)_/g)].map((match) => `${match[1]}-${match[2]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

const pascal = (text) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('');

/** Los dos archivos de la sonda, o [] si el modelo no es el del sujeto. */
export function searchProbeFiles(model) {
  const operation = searchSubject(model);
  if (!operation) return [];
  const finder = findersOf(model, operation.finder.entity).find((candidate) => candidate.operation === SUBJECT_OPERATION);
  const root = model.entities.find((entity) => entity.name === operation.finder.entity);
  const name = root.name;
  const members = domainMembers(model, root);
  const statusField = root.fields.find((field) => field.name === 'status');
  const statusOf = (literal) => `domain.${enumConstant(statusField.namedType, literal)}`;
  const { defaultSize, maxSize, defaultSort } = pageableDefaults(model, operation);
  const sortLiteral = `[]domain.SortOrder{${defaultSort.map((entry) => `{Property: ${goString(entry.property)}, Direction: domain.${entry.direction === 'desc' ? 'SortDesc' : 'SortAsc'}}`).join(', ')}}`;
  const property = new Map([...defaultSort, ...operation.sortable].map((entry) => [entry.path, entry.property]));

  // ─── FS-*: el finder, en el paquete del almacén ───
  const valueOf = (field, value) => {
    const member = members.find((candidate) => candidate.name === field && candidate.kind === 'field');
    const expr = value === null ? 'nil' : field === 'status' ? statusOf(value) : goString(value);
    return member?.optional && value !== null ? `ptr(${expr})` : expr;
  };
  const rows = FINDER_SEARCH_ROWS.map(
    (row, at) => `	row${at} := sample${name}(t, ${1500 + at})
${['sku', 'name', 'notes', 'status'].map((field) => `	row${at}.${goExported(field)} = ${valueOf(field, row[field])}`).join('\n')}
	if _, err := repo.Save(ctx, domain.Rehydrate${name}(row${at})); err != nil {
		t.Fatalf("guardar %s: %v", ${goString(row.sku)}, err)
	}`
  );
  const filterOf = (inputs) =>
    `domain.${filterTypeName(finder)}{${finder.criteria
      .filter((criterion) => inputs[criterion.name] !== undefined)
      .map((criterion) => {
        const value = inputs[criterion.name];
        if (criterion.op === 'in') return `${goExported(criterion.name)}: []domain.${statusField.namedType}{${value.map(statusOf).join(', ')}}`;
        return `${goExported(criterion.name)}: ptr(${goString(value)})`;
      })
      .join(', ')}}`;
  const finderTests = FINDER_SEARCH_CASES.map(
    (entry) => `// TestSearch_${entry.id.replace('-', '')}_${pascal(entry.what)}: ${entry.id}, ${entry.what}.
func TestSearch_${entry.id.replace('-', '')}_${pascal(entry.what)}(t *testing.T) {
	if got := searched(t, ${filterOf(entry.inputs)}); got != ${goString(entry.expect.join(','))} {
		t.Errorf("el finder devolvió [%s]; quiero [${entry.expect.join(',')}]", got)
	}
}`
  );
  const repo = `New${name}Repository(${repositoryArgs(model, root, 'probeTx', 'nil', { sweeps: 'probeSweeps', parameters: 'probeParameters', reconciliation: PROBE_RECONCILIATION })})`;
  const finderBody = `
// La sonda de la búsqueda (scripts/lib/search-probes.js de keel-go): FS-1 a FS-10 contra el finder emitido de
// ${SUBJECT_OPERATION}. No es parte del proyecto generado.

var searchSeeded bool

// seedSearch guarda las filas de los casos una sola vez: las pruebas comparten la base y corren una tras otra.
func seedSearch(t *testing.T) {
	t.Helper()
	if searchSeeded {
		return
	}
	ctx := t.Context()
	repo := ${repo}
${rows.join('\n')}
	searchSeeded = true
}

// searched son los sku que devuelve el finder, en el orden del diseño (${defaultSort.map((entry) => `${entry.path}:${entry.direction}`).join(', ')} y el id de desempate), solo los de los casos.
func searched(t *testing.T, filter domain.${filterTypeName(finder)}) string {
	t.Helper()
	seedSearch(t)
	page, err := ${repo}.${finderMethod(finder)}(t.Context(), filter, domain.Pageable{Size: 100, Sort: ${sortLiteral}})
	if err != nil {
		t.Fatalf("${finderMethod(finder)}: %v", err)
	}
	known := []string{${FINDER_SEARCH_ROWS.map((row) => goString(row.sku)).join(', ')}}
	var found []string
	for _, item := range page.Items {
		if sku := fmt.Sprint(item.Sku()); slices.Contains(known, sku) {
			found = append(found, sku)
		}
	}
	return strings.Join(found, ",")
}

${finderTests.join('\n\n')}
`;
  const dir = storeDir(model);
  const finderFile = {
    path: `${dir}/search_probe_test.go`,
    content: goFile({ pkg: dir.split('/').pop(), imports: ['fmt', 'slices', 'strings', 'testing', 'internal/domain'], body: finderBody, module: model.service.goModule, generated: false })
  };

  // ─── SO-*: el ?sort= del cliente, en internal/httpapi ───
  const sortableOf = (paths) => (paths.length === 0 ? 'nil' : `map[string]string{${paths.map((path) => `${goString(path)}: ${goString(property.get(path))}`).join(', ')}}`);
  const sortTests = SO_CASES.map((entry) => {
    const sortable = entry.sortable ?? operation.sortable.map((item) => item.path);
    const query = entry.values === null ? '""' : `url.Values{"sort": {${entry.values.map(goString).join(', ')}}}.Encode()`;
    const read = `pageableParam(httptest.NewRequest(http.MethodGet, "/?"+${query}, nil), ${defaultSize}, ${maxSize}, ${sortLiteral}, ${sortableOf(sortable)})`;
    const body =
      entry.expect === 400
        ? `	_, err := ${read}
	var invalid *invalidSortError
	if !errors.As(err, &invalid) {
		t.Fatalf("se esperaba el 400 de un orden que no se ofrece, llegó %v", err)
	}`
        : `	pageable, err := ${read}
	if err != nil {
		t.Fatalf("pageableParam: %v", err)
	}
	if got := sortText(pageable.Sort); got != ${goString(entry.expect.map(([path, dir]) => `${property.get(path)},${dir}`).join(';'))} {
		t.Errorf("orden leído %q; quiero ${entry.expect.map(([path, dir]) => `${property.get(path)},${dir}`).join(';')}", got)
	}`;
    return `// TestSearch_${entry.id.replace('-', '')}_${pascal(entry.what)}: ${entry.id}, ${entry.what}.
func TestSearch_${entry.id.replace('-', '')}_${pascal(entry.what)}(t *testing.T) {
${body}
}`;
  });
  const sortBody = `
// La sonda del orden del cliente (scripts/lib/search-probes.js de keel-go): SO-1 a SO-11 contra el pageableParam emitido,
// con lo que el endpoint de ${SUBJECT_OPERATION} le pasa. No es parte del proyecto generado.

// sortText es un orden como «propiedad,dirección», separados por ;.
func sortText(sort []domain.SortOrder) string {
	parts := make([]string, len(sort))
	for i, order := range sort {
		parts[i] = order.Property + "," + strings.ToLower(string(order.Direction))
	}
	return strings.Join(parts, ";")
}

${sortTests.join('\n\n')}
`;
  const sortFile = {
    path: `${SEARCH_SORT_PACKAGE}/search_sort_probe_test.go`,
    content: goFile({ pkg: 'httpapi', imports: ['errors', 'net/http', 'net/http/httptest', 'net/url', 'strings', 'testing', 'internal/domain'], body: sortBody, module: model.service.goModule, generated: false })
  };
  return [finderFile, sortFile];
}
