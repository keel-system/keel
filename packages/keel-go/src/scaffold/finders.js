// El FINDER de una búsqueda (DSL 2.22) en Go: el struct de sus filtros junto al puerto (`internal/domain`), el método
// del puerto y el del adaptador relacional. Qué restringe cada input, con qué operador y contra qué columna o sombra
// lo decide keel-core/gen/query-filters.js, el mismo para los cuatro generadores: aquí solo se escribe.
//
// El adaptador compone el WHERE con un `filters` (values.go) que pone cada valor como PARÁMETRO: nunca se concatena un
// dato de la petición en el SQL. Un filtro opcional a nil no restringe; el texto por patrón se busca LITERAL (con `%`,
// `_` y `\` escapados), sobre la sombra plegada si el diseño pide plegarlo. Los de 2.32: `in` (uno de la lista, cada
// elemento plegado si el input pliega), `ne` (la fila sin valor también es distinta, D11) y la búsqueda libre (un OR del
// patrón sobre la columna o la sombra de cada campo de `over`, D13).

import { findersOf } from '@keel-system/keel-core/gen';
import { persistedMembers } from '@keel-system/keel-core/gen';
import { enumConstant, goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { docComment, localName } from './render.js';
import { READ_SCOPE_FIELD, RELATIONAL_SCOPE_LINE, isScopedRoot } from './read-scope.js';
import { RELATIONAL_LIVE_LINE, aliveFilterBlock } from './data-lifecycle.js';

// Las columnas se citan como en el baseline del motor; `qFor` las cita para el modelo que se escribe.
const qFor = (model) => (name) => sqlDialect(model).quote(name);

/** Los finders de una raíz, en el orden de las operaciones. */
export function entityFinders(model, entity) {
  return findersOf(model, entity.name);
}

export const hasFilter = (finder) => finder.criteria.length > 0;
export const finderMethod = (finder) => goExported(finder.method);
export const filterTypeName = (finder) => goExported(finder.filterType);

/** El tipo de un filtro (en el dominio, o calificado fuera): un opcional es un puntero, y nil no restringe; una lista (`in`) ya lo es. */
function criterionType(criterion, { qualify = false } = {}) {
  const { input } = criterion;
  const named = input.kind === 'enum' || input.kind === 'composite';
  const list = input.goType.startsWith('[]');
  const element = list ? input.goType.slice(2) : input.goType;
  const type = `${list ? '[]' : ''}${qualify && named ? `domain.${element}` : element}`;
  return criterion.required || list ? type : `*${type}`;
}

/** ¿El filtro es una lista (`in`)? Entonces nil no restringe y no se desreferencia. */
export const isListCriterion = (criterion) => criterion.input.goType.startsWith('[]');

const OPERATOR_DOC = { eq: 'igual a', gt: 'mayor que', gte: 'mayor o igual que', lt: 'menor que', lte: 'menor o igual que' };

function criterionDoc(criterion) {
  const folding = criterion.compare === 'ignore-case-accents' ? ', sin mayúsculas ni acentos' : criterion.compare === 'ignore-case' ? ', sin mayúsculas' : '';
  // La búsqueda libre (DSL 2.32, D13): un OR sobre los campos de over.
  if (criterion.op === 'search') {
    const over = criterion.targets.map((entry) => entry.target.path).join(' o ');
    return criterion.match === 'contains' ? `${over} lo contiene${folding}` : criterion.match === 'prefix' ? `${over} empieza por él${folding}` : `${over} es igual a él${folding}`;
  }
  const subject = criterion.target.kind === 'relation' ? `el id de ${criterion.target.path}` : criterion.target.path;
  if (criterion.op === 'in') return `${subject} es uno de ellos${folding} (la lista vacía es 400 en el borde)`;
  if (criterion.op === 'ne') return `${subject} distinto de él, también sin valor`;
  if (criterion.match === 'contains') return `${subject} lo contiene${folding}`;
  if (criterion.match === 'prefix') return `${subject} empieza por él${folding}`;
  return `${subject} ${OPERATOR_DOC[criterion.op]} él${folding}`;
}

/** Los structs `<Op>Filter` del dominio, uno por finder con filtros del input. */
export function filterStructs(model, entity) {
  return entityFinders(model, entity)
    .filter(hasFilter)
    .map((finder) => {
      const fields = finder.criteria.map(
        (criterion) => `\t// ${goExported(criterion.name)}: ${criterionDoc(criterion)}.${criterion.required ? '' : ' nil no restringe.'}\n\t${goExported(criterion.name)} ${criterionType(criterion)}`
      );
      return `${docComment(filterTypeName(finder), `los filtros de ${finder.operation}, como los declara el diseño (DSL 2.22).`)}type ${filterTypeName(finder)} struct {
${fields.join('\n')}
}`;
    });
}

/** Los parámetros de un finder después de ctx; `domain` es el prefijo de los tipos del dominio fuera de él. */
export function finderParams(finder, domain = '') {
  const params = [];
  if (hasFilter(finder)) params.push(`filter ${domain}${filterTypeName(finder)}`);
  if (finder.result === 'page') params.push(`pageable ${domain}Pageable`);
  // En una lectura acotada (DSL 2.27, D2) el scope es OBLIGATORIO: el compilador obliga al handler a pasarlo.
  if (finder.scope) params.push(`scope ${domain}ReadScope`);
  return params;
}

export function finderResult(finder, entity, domain = '') {
  return finder.result === 'page' ? `(${domain}Page[*${domain}${entity.name}], error)` : `([]*${domain}${entity.name}, error)`;
}

/** Las firmas del puerto: `[doc, firma]` por finder. */
export function portFinderMethods(model, entity) {
  return entityFinders(model, entity).map((finder) => {
    const fixed = finder.fixed.length > 0 ? ` (siempre: ${finder.fixed.map((entry) => `${entry.name} = ${entry.value}`).join(', ')})` : '';
    const order = finder.result === 'page' ? 'Una página, en el orden pedido y con el id como desempate.' : 'Todas, en el orden del diseño y con el id como desempate.';
    return [`la búsqueda de ${finder.operation} con los filtros del diseño y solo esos${fixed}. ${order}`, `${finderMethod(finder)}(${['ctx context.Context', ...finderParams(finder)].join(', ')}) ${finderResult(finder, entity)}`];
  });
}

/** La columna que restringe un criterio, y el campo con cuyo códec viaja su valor. */
function columnOf(model, entity, criterion) {
  const { target } = criterion;
  if (criterion.shadow) return { column: qFor(model)(criterion.shadow.column), field: null };
  const members = persistedMembers(model, entity);
  if (target.kind === 'relation') {
    const member = members.find((candidate) => candidate.kind === 'externalRef' && candidate.relation.name === target.relation.name);
    return { column: qFor(model)(member?.column ?? `${target.relation.name}_id`), field: null };
  }
  if (target.kind === 'vo') {
    const member = members.find((candidate) => candidate.kind === 'vo' && candidate.name === target.field.name);
    const sub = member?.subs.find((candidate) => candidate.voAccessor === target.sub.name);
    return { column: qFor(model)(sub?.column), field: target.sub };
  }
  return { column: qFor(model)(target.field.columns.name), field: target.field };
}

const COMPARISON = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** El valor guardado de un `where` fijo: un enum por su CONSTANTE, como lo guarda el adaptador. */
export function fixedArg(model, entry) {
  if (entry.field.kind === 'enum') {
    const enumDef = model.enums.find((candidate) => candidate.name === entry.field.namedType);
    const value = enumDef.values.find((candidate) => candidate.literal === entry.value || candidate.constant === entry.value);
    return goString(value?.constant ?? String(entry.value));
  }
  if (typeof entry.value === 'boolean' || typeof entry.value === 'number') return String(entry.value);
  return goString(String(entry.value));
}

const foldCall = (shadow) => (shadow.accents ? 'textfold.CaseAndAccents' : 'textfold.Case');

/** El patrón de LIKE de un texto buscado, LITERAL: sus comodines no lo son. */
const likePattern = (match, value) => (match === 'contains' ? `"%"+likeLiteral(${value})+"%"` : match === 'prefix' ? `likeLiteral(${value})+"%"` : `likeLiteral(${value})`);

/** Las líneas que restringen `f` con un criterio cuyo valor es `local` (ya desreferenciado). */
function criterionLines(model, entity, criterion, local, writeValue) {
  // La búsqueda libre (DSL 2.32, D13): el texto, plegado una vez, contra la columna o la sombra de cada campo de over.
  if (criterion.op === 'search') {
    const columns = criterion.targets.map((entry) => goString(columnOf(model, entity, { target: entry.target, shadow: entry.shadow }).column));
    const shadow = criterion.targets[0]?.shadow;
    const value = shadow ? `${foldCall(shadow)}(${local})` : local;
    return [`f.anyLike([]string{${columns.join(', ')}}, ${likePattern(criterion.match, value)})`];
  }
  const { column, field } = columnOf(model, entity, criterion);
  // `in` (D12): uno de la lista, con cada elemento escrito (o plegado) como lo guarda la columna.
  if (criterion.op === 'in') {
    const item = criterion.shadow ? `${foldCall(criterion.shadow)}(item)` : field ? writeValue(field, 'item', false) : 'item';
    return [
      `${local}Values := make([]any, 0, len(${local}))`,
      `for _, item := range ${local} {`,
      `\t${local}Values = append(${local}Values, ${item})`,
      '}',
      `f.oneOf(${goString(column)}, ${local}Values)`
    ];
  }
  let value = local;
  if (criterion.shadow) value = `${foldCall(criterion.shadow)}(${local})`;
  else if (field) value = writeValue(field, local, false);
  // Distinto, y la fila sin valor también lo es (D11): el <> de SQL a pelo la dejaría fuera.
  if (criterion.op === 'ne') return [`f.distinct(${goString(column)}, ${value})`];
  if (criterion.match === 'contains') return [`f.contains(${goString(column)}, ${value})`];
  if (criterion.match === 'prefix') return [`f.prefix(${goString(column)}, ${value})`];
  return [`f.add(${goString(column)}, ${goString(COMPARISON[criterion.op])}, ${value})`];
}

/** Las líneas que añaden las condiciones de un finder a `f`. */
function filterLines(model, entity, finder, writeValue) {
  const lines = finder.fixed.map((entry) => `\tf.add(${goString(qFor(model)(entry.field.columns.name))}, "=", ${fixedArg(model, entry)})`);
  for (const criterion of finder.criteria) {
    const local = localName(criterion.name);
    const calls = criterionLines(model, entity, criterion, local, writeValue);
    const member = `filter.${goExported(criterion.name)}`;
    if (isListCriterion(criterion)) {
      // Una lista ya es nil cuando no llega: no se desreferencia.
      if (criterion.required) lines.push(`\t${local} := ${member}`, ...calls.map((line) => `\t${line}`));
      else lines.push(`\tif ${local} := ${member}; ${local} != nil {`, ...calls.map((line) => `\t\t${line}`), '\t}');
    } else if (criterion.required) lines.push(`\t${local} := ${member}`, ...calls.map((line) => `\t${line}`));
    else lines.push(`\tif ${member} != nil {`, `\t\t${local} := *${member}`, ...calls.map((line) => `\t\t${line}`), '\t}');
  }
  return lines;
}

/**
 * Los métodos del adaptador. `sortable` es el nombre del mapa de orden de la raíz; `writeValue`, el códec del adaptador
 * (repositories.js), para que el valor de un filtro viaje como el de la columna que compara.
 */
export function adapterFinderMethods(model, entity, { type, root, sortable, writeValue }) {
  const idName = entity.idField?.name ?? 'id';
  return entityFinders(model, entity).map((finder) => {
    const name = finderMethod(finder);
    const signature = `func (r *${type}) ${name}(${['ctx context.Context', ...finderParams(finder, 'domain.')].join(', ')}) ${finderResult(finder, entity, 'domain.')}`;
    // El alcance de una lectura acotada (DSL 2.27) se SUMA a los criterios (D4): la misma consulta da las filas y el total.
    // Lo borrado (DSL 2.28, D2) se SUMA detrás del alcance: sustituir en vez de sumar (lc-implicit-replace) se lleva todo lo
    // de antes y se ve.
    const conditions = [...filterLines(model, entity, finder, writeValue), ...(finder.scope ? [RELATIONAL_SCOPE_LINE] : []), ...(finder.live ? [RELATIONAL_LIVE_LINE] : [])];
    if (finder.result === 'page') {
      const zero = `domain.Page[*domain.${entity.name}]{}`;
      return `// ${name} implementa domain.${entity.name}Repository.
${signature} {
	var f filters
${conditions.join('\n')}
	order, err := orderBy(pageable.Sort, ${sortable}, ${goString(idName)}, ${goString(root.idColumn)})
	if err != nil {
		return ${zero}, fmt.Errorf("${root.table}: %w", err)
	}
	q, err := r.tx.conn(ctx)
	if err != nil {
		return ${zero}, err
	}
	var total int64
	if err := q.QueryRowContext(ctx, ${goString(`SELECT count(*) FROM ${root.table} `)}+f.where(), f.args...).Scan(&total); err != nil {
		return ${zero}, translate(err)
	}
	// En dos sentencias: page añade sus dos parámetros, y leer f.args en la misma llamada no tiene orden garantizado.
	tail := " ORDER BY " + order + f.page(pageable)
	found, err := r.load(ctx, f.where()+tail, f.args...)
	if err != nil {
		return ${zero}, err
	}
	return domain.NewPage(found, pageable, total), nil
}`;
    }
    const sort = finder.sort.map((criterion) => `{Property: ${goString(criterion.property)}, Direction: domain.${criterion.direction === 'desc' ? 'SortDesc' : 'SortAsc'}}`);
    return `// ${name} implementa domain.${entity.name}Repository.
${signature} {
	var f filters
${conditions.join('\n')}
	order, err := orderBy([]domain.SortOrder{${sort.join(', ')}}, ${sortable}, ${goString(idName)}, ${goString(root.idColumn)})
	if err != nil {
		return nil, fmt.Errorf("${root.table}: %w", err)
	}
	return r.load(ctx, f.where()+" ORDER BY "+order, f.args...)
}`;
  });
}

/** Lo que los finders de un modelo piden de `filters` (values.go): staticcheck (U1000) rechaza lo que nadie usa. */
export function filtersUses(model, roots) {
  const uses = new Set();
  for (const entity of roots) {
    for (const finder of entityFinders(model, entity)) {
      uses.add('filters');
      const plain = finder.criteria.filter((criterion) => !['in', 'ne', 'search'].includes(criterion.op));
      if (finder.fixed.length > 0 || plain.some((criterion) => criterion.match === 'exact')) uses.add('add');
      if (plain.some((criterion) => criterion.match === 'contains')) uses.add('contains');
      if (plain.some((criterion) => criterion.match === 'prefix')) uses.add('prefix');
      // Los de 2.32: la lista, el distinto y la búsqueda libre.
      if (finder.criteria.some((criterion) => criterion.op === 'in')) uses.add('oneOf');
      if (finder.criteria.some((criterion) => criterion.op === 'ne')) uses.add('distinct');
      if (finder.criteria.some((criterion) => criterion.op === 'search')) uses.add('anyLike');
      if (finder.result === 'page') uses.add('page');
      if (finder.live) uses.add('alive');
    }
    // La lectura acotada (DSL 2.27): el predicado de la raíz con su IN, y la carga, que compara el id.
    if (isScopedRoot(model, entity)) {
      uses.add('filters');
      uses.add('add');
      uses.add('in');
    }
  }
  return uses;
}

/** Los bloques de values.go con los que los finders componen su WHERE, solo los que alguno usa. */
export function filtersBlocks(uses, d) {
  if (!uses.has('filters')) return [];
  const like = uses.has('contains') || uses.has('prefix') || uses.has('anyLike');
  // El parámetro que acaba de añadirse: `$n` en PostgreSQL, `?` en MySQL. Y el escape de LIKE: en una cadena de MySQL
  // la barra ya escapa, así que el carácter de escape se escribe doblado.
  const param = d.mysql ? '" ?"' : '" $"+strconv.Itoa(len(f.args))';
  const likeTail = d.mysql ? `\` LIKE ? ESCAPE '\\\\'\`` : `" LIKE $"+strconv.Itoa(len(f.args))+\` ESCAPE '\\'\``;
  // La misma cola en una asignación, donde gofmt pone espacios alrededor del +.
  const likeTailSpaced = likeTail.replace(/\+/g, ' + ');
  return [
    `// filters compone el WHERE de un finder: cada condición con su valor como PARÁMETRO (${d.mysql ? '?' : '$n'}), nunca concatenado.
type filters struct {
	conditions []string
	args       []any
}`,
    uses.has('add') &&
      `// add restringe column con op contra value.
func (f *filters) add(column, op string, value any) {
	f.args = append(f.args, value)
	f.conditions = append(f.conditions, column+" "+op+${param})
}`,
    uses.has('in') &&
      `// in restringe a que head esté entre values, y cierra con tail (los paréntesis de las subconsultas). Sin valores, ninguna
// fila: un IN vacío no es SQL, y «nada» nunca puede volverse «todo».
func (f *filters) in(head string, values []string, tail string) {
	if len(values) == 0 {
		f.conditions = append(f.conditions, "1 = 0")
		return
	}
	marks := make([]string, len(values))
	for i, value := range values {
		f.args = append(f.args, value)
		marks[i] = ${d.mysql ? '"?"' : '"$" + strconv.Itoa(len(f.args))'}
	}
	f.conditions = append(f.conditions, head+" IN ("+strings.Join(marks, ", ")+")"+tail)
}`,
    uses.has('oneOf') &&
      `// oneOf restringe column a uno de values (op: in, DSL 2.32). Sin valores, ninguna fila: una lista vacía no llega
// (es 400 en el borde), y «nada» nunca puede volverse «todo».
func (f *filters) oneOf(column string, values []any) {
	if len(values) == 0 {
		f.conditions = append(f.conditions, "1 = 0")
		return
	}
	marks := make([]string, len(values))
	for i, value := range values {
		f.args = append(f.args, value)
		marks[i] = ${d.mysql ? '"?"' : '"$" + strconv.Itoa(len(f.args))'}
	}
	f.conditions = append(f.conditions, column+" IN ("+strings.Join(marks, ", ")+")")
}`,
    uses.has('distinct') &&
      `// distinct restringe column a lo distinto de value (op: ne, DSL 2.32, D11): la fila sin valor también lo es.
func (f *filters) distinct(column string, value any) {
	f.args = append(f.args, value)
	f.conditions = append(f.conditions, "("+column+" IS NULL OR "+column+" <>"+${param}+")")
}`,
    uses.has('anyLike') &&
      `// anyLike restringe a las filas en las que ALGUNA de columns casa con pattern (la búsqueda libre, DSL 2.32, D13): un
// OR dentro de sus paréntesis, sumado con AND a lo demás.
func (f *filters) anyLike(columns []string, pattern string) {
	branches := make([]string, len(columns))
	for i, column := range columns {
		f.args = append(f.args, pattern)
		branches[i] = column + ${likeTailSpaced}
	}
	f.conditions = append(f.conditions, "("+strings.Join(branches, " OR ")+")")
}`,
    uses.has('contains') &&
      `// contains restringe column a los textos que contienen text, LITERAL: sus comodines no lo son.
func (f *filters) contains(column, text string) {
	f.args = append(f.args, "%"+likeLiteral(text)+"%")
	f.conditions = append(f.conditions, column+${likeTail})
}`,
    uses.has('prefix') &&
      `// prefix restringe column a los textos que empiezan por text, LITERAL.
func (f *filters) prefix(column, text string) {
	f.args = append(f.args, likeLiteral(text)+"%")
	f.conditions = append(f.conditions, column+${likeTail})
}`,
    uses.has('alive') && aliveFilterBlock(d),
    `// where es la cláusula entera, o "" sin condiciones.
func (f *filters) where() string {
	if len(f.conditions) == 0 {
		return ""
	}
	return "WHERE " + strings.Join(f.conditions, " AND ")
}`,
    uses.has('page') &&
      `// page añade el LIMIT y el OFFSET de una página como parámetros: después del count, que no los lleva.
func (f *filters) page(pageable domain.Pageable) string {
	f.args = append(f.args, pageable.Size, pageable.Offset())
	return ${d.mysql ? '" LIMIT ? OFFSET ?"' : '" LIMIT $" + strconv.Itoa(len(f.args)-1) + " OFFSET $" + strconv.Itoa(len(f.args))'}
}`,
    like &&
      `// likeEscaper escapa los comodines de LIKE (y el propio escape) de un texto buscado.
var likeEscaper = strings.NewReplacer(\`\\\`, \`\\\\\`, "%", \`\\%\`, "_", \`\\_\`)

// likeLiteral es text con sus comodines de LIKE escapados.
func likeLiteral(text string) string {
	return likeEscaper.Replace(text)
}`
  ].filter(Boolean);
}

/** La llamada que nombra la nota del handler, en la grafía de Go. */
export function finderCall(finder, repository) {
  const args = ['ctx'];
  if (hasFilter(finder)) args.push(`domain.${filterTypeName(finder)}{${finder.criteria.map((criterion) => `${goExported(criterion.name)}: msg.${goExported(criterion.name)}`).join(', ')}}`);
  if (finder.result === 'page') args.push('msg.Pageable');
  if (finder.scope) args.push(`msg.${READ_SCOPE_FIELD}`);
  return `h.${repository}.${finderMethod(finder)}(${args.join(', ')})`;
}
