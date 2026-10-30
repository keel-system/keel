// El FINDER de una búsqueda (DSL 2.22) en Go: el struct de sus filtros junto al puerto (`internal/domain`), el método
// del puerto y el del adaptador de PostgreSQL. Qué restringe cada input, con qué operador y contra qué columna o sombra
// lo decide keel-core/gen/query-filters.js, el mismo para los cuatro generadores: aquí solo se escribe.
//
// El adaptador compone el WHERE con un `filters` (values.go) que pone cada valor como PARÁMETRO: nunca se concatena un
// dato de la petición en el SQL. Un filtro opcional a nil no restringe; el texto por patrón se busca LITERAL (con `%`,
// `_` y `\` escapados), sobre la sombra plegada si el diseño pide plegarlo.

import { findersOf } from '@keel-system/keel-core/gen';
import { persistedMembers, quoteIdentifierFor } from '@keel-system/keel-core/gen';
import { enumConstant, goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { docComment, localName } from './render.js';

const q = (name) => quoteIdentifierFor('postgresql', name);

/** Los finders de una raíz, en el orden de las operaciones. */
export function entityFinders(model, entity) {
  return findersOf(model, entity.name);
}

export const hasFilter = (finder) => finder.criteria.length > 0;
export const finderMethod = (finder) => goExported(finder.method);
export const filterTypeName = (finder) => goExported(finder.filterType);

/** El tipo de un filtro (en el dominio, o calificado fuera): un opcional es un puntero, y nil no restringe. */
function criterionType(criterion, { qualify = false } = {}) {
  const { input } = criterion;
  const named = input.kind === 'enum' || input.kind === 'composite';
  const type = qualify && named ? `domain.${input.goType}` : input.goType;
  return criterion.required ? type : `*${type}`;
}

const OPERATOR_DOC = { eq: 'igual a', gt: 'mayor que', gte: 'mayor o igual que', lt: 'menor que', lte: 'menor o igual que' };

function criterionDoc(criterion) {
  const subject = criterion.target.kind === 'relation' ? `el id de ${criterion.target.path}` : criterion.target.path;
  const folding = criterion.compare === 'ignore-case-accents' ? ', sin mayúsculas ni acentos' : criterion.compare === 'ignore-case' ? ', sin mayúsculas' : '';
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
function finderParams(finder, domain = '') {
  const params = [];
  if (hasFilter(finder)) params.push(`filter ${domain}${filterTypeName(finder)}`);
  if (finder.result === 'page') params.push(`pageable ${domain}Pageable`);
  return params;
}

function finderResult(finder, entity, domain = '') {
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
  if (criterion.shadow) return { column: q(criterion.shadow.column), field: null };
  const members = persistedMembers(model, entity);
  if (target.kind === 'relation') {
    const member = members.find((candidate) => candidate.kind === 'externalRef' && candidate.relation.name === target.relation.name);
    return { column: q(member?.column ?? `${target.relation.name}_id`), field: null };
  }
  if (target.kind === 'vo') {
    const member = members.find((candidate) => candidate.kind === 'vo' && candidate.name === target.field.name);
    const sub = member?.subs.find((candidate) => candidate.voAccessor === target.sub.name);
    return { column: q(sub?.column), field: target.sub };
  }
  return { column: q(target.field.columns.name), field: target.field };
}

const COMPARISON = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** El valor guardado de un `where` fijo: un enum por su CONSTANTE, como lo guarda el adaptador. */
function fixedArg(model, entry) {
  if (entry.field.kind === 'enum') {
    const enumDef = model.enums.find((candidate) => candidate.name === entry.field.namedType);
    const value = enumDef.values.find((candidate) => candidate.literal === entry.value || candidate.constant === entry.value);
    return goString(value?.constant ?? String(entry.value));
  }
  if (typeof entry.value === 'boolean' || typeof entry.value === 'number') return String(entry.value);
  return goString(String(entry.value));
}

/** Las líneas que añaden las condiciones de un finder a `f`. */
function filterLines(model, entity, finder, writeValue) {
  const lines = finder.fixed.map((entry) => `\tf.add(${goString(q(entry.field.columns.name))}, "=", ${fixedArg(model, entry)})`);
  for (const criterion of finder.criteria) {
    const { column, field } = columnOf(model, entity, criterion);
    const local = localName(criterion.name);
    let value = local;
    if (criterion.shadow) value = `${criterion.shadow.accents ? 'textfold.CaseAndAccents' : 'textfold.Case'}(${local})`;
    else if (field) value = writeValue(field, local, false);
    const call =
      criterion.match === 'contains'
        ? `f.contains(${goString(column)}, ${value})`
        : criterion.match === 'prefix'
          ? `f.prefix(${goString(column)}, ${value})`
          : `f.add(${goString(column)}, ${goString(COMPARISON[criterion.op])}, ${value})`;
    const member = `filter.${goExported(criterion.name)}`;
    if (criterion.required) lines.push(`\t${local} := ${member}`, `\t${call}`);
    else lines.push(`\tif ${member} != nil {`, `\t\t${local} := *${member}`, `\t\t${call}`, '\t}');
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
    const conditions = filterLines(model, entity, finder, writeValue);
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
      if (finder.fixed.length > 0 || finder.criteria.some((criterion) => criterion.match === 'exact')) uses.add('add');
      if (finder.criteria.some((criterion) => criterion.match === 'contains')) uses.add('contains');
      if (finder.criteria.some((criterion) => criterion.match === 'prefix')) uses.add('prefix');
      if (finder.result === 'page') uses.add('page');
    }
  }
  return uses;
}

/** Los bloques de values.go con los que los finders componen su WHERE, solo los que alguno usa. */
export function filtersBlocks(uses) {
  if (!uses.has('filters')) return [];
  const like = uses.has('contains') || uses.has('prefix');
  return [
    `// filters compone el WHERE de un finder: cada condición con su valor como PARÁMETRO ($n), nunca concatenado.
type filters struct {
	conditions []string
	args       []any
}`,
    uses.has('add') &&
      `// add restringe column con op contra value.
func (f *filters) add(column, op string, value any) {
	f.args = append(f.args, value)
	f.conditions = append(f.conditions, column+" "+op+" $"+strconv.Itoa(len(f.args)))
}`,
    uses.has('contains') &&
      `// contains restringe column a los textos que contienen text, LITERAL: sus comodines no lo son.
func (f *filters) contains(column, text string) {
	f.args = append(f.args, "%"+likeLiteral(text)+"%")
	f.conditions = append(f.conditions, column+" LIKE $"+strconv.Itoa(len(f.args))+\` ESCAPE '\\'\`)
}`,
    uses.has('prefix') &&
      `// prefix restringe column a los textos que empiezan por text, LITERAL.
func (f *filters) prefix(column, text string) {
	f.args = append(f.args, likeLiteral(text)+"%")
	f.conditions = append(f.conditions, column+" LIKE $"+strconv.Itoa(len(f.args))+\` ESCAPE '\\'\`)
}`,
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
	return " LIMIT $" + strconv.Itoa(len(f.args)-1) + " OFFSET $" + strconv.Itoa(len(f.args))
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
  return `h.${repository}.${finderMethod(finder)}(${args.join(', ')})`;
}
