// Las sondas de los FINDERS de las búsquedas (DSL 2.22) en db-check: el mismo recorrido que las de keel-dotnet y
// keel-nest, con el vocabulario de keel-core/gen/query-filters.js. Por finder, una fila que cumple su `where` (releída
// tras guardarla: la precisión con que el motor guarda un instante no es la de la muestra) y otra que no; y por cada
// criterio, valores que la encuentran y valores que no —los extremos de gte/lte dentro, los de gt/lt fuera, el texto
// como LITERAL—. La fila que no cumple el `where` no sale nunca.

import { FINDER_PROBE_TEXT, findersOf, finderTextProbes } from '@keel-system/keel-core/gen/query-filters';
import { enumConstant, goExported } from '../../src/lib/go-projection.js';
import { goString } from '../../src/lib/go-source.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { filterTypeName, finderMethod, hasFilter } from '../../src/scaffold/finders.js';

/** Los números de muestra de los finders: por encima de los de las demás sondas. */
const FIRST = 120;

export function finderProbes(model, root, { repo, id }) {
  const name = root.name;
  const members = domainMembers(model, root);
  const memberOf = (fieldName) => members.find((member) => member.name === fieldName);
  const enumValues = (enumName) => model.enums.find((candidate) => candidate.name === enumName).values.map((value) => `domain.${enumConstant(enumName, value.literal)}`);
  // Un valor distinto de expr, del tipo del campo.
  const otherThan = (field, expr) => {
    if (field.kind === 'enum') return `other(${expr}, ${enumValues(field.namedType).join(', ')})`;
    switch (field.goType) {
      case 'bool':
        return `!${expr}`;
      case 'int32':
      case 'int64':
        return `${expr} + 1`;
      case 'wire.Decimal':
        return `${expr}.Add(wire.MustDecimal("1"))`;
      case 'time.Time':
        return `${expr}.Add(24 * time.Hour)`;
      case 'uuid.UUID':
        return 'uuid.Must(uuid.NewV7())';
      default:
        return `${expr} + "-otro"`;
    }
  };
  const shift = (field, expr, sign) => {
    switch (field.goType) {
      case 'wire.Decimal':
        return `${expr}.${sign > 0 ? 'Add' : 'Sub'}(wire.MustDecimal("1"))`;
      case 'time.Time':
        return `${expr}.Add(${sign > 0 ? '' : '-'}24 * time.Hour)`;
      default:
        return `${expr} ${sign > 0 ? '+' : '-'} 1`;
    }
  };

  return findersOf(model, root.name).map((finder, index) => {
    const method = finderMethod(finder);
    const textCriteria = finder.criteria.filter((criterion) => criterion.match !== 'exact' && (criterion.target.field.text?.maxLength ?? Infinity) > FINDER_PROBE_TEXT.length);
    // Las dos filas: dentro del where y con el texto de la sonda; fuera, con otro texto (si el campo es único, el mismo
    // chocaría al guardarla).
    const set = (target, field, value) => `\t${target}.${goExported(field.name)} = ${memberOf(field.name)?.optional ? `ptr(${value})` : value}`;
    const prepare = [];
    for (const criterion of textCriteria) {
      prepare.push(set('inside', criterion.target.field, goString(FINDER_PROBE_TEXT)), set('outside', criterion.target.field, goString(`${FINDER_PROBE_TEXT}2`)));
    }
    for (const entry of finder.fixed) {
      const value = entry.field.kind === 'enum' ? `domain.${enumConstant(entry.field.namedType, entry.value)}` : typeof entry.value === 'string' ? goString(entry.value) : String(entry.value);
      prepare.push(`\tinsideFixed${goExported(entry.name)} := ${value}`);
      prepare.push(set('inside', entry.field, `insideFixed${goExported(entry.name)}`), set('outside', entry.field, otherThan(entry.field, `insideFixed${goExported(entry.name)}`)));
    }

    // El valor guardado de lo que restringe un criterio, leído de la fila releída.
    const locals = [];
    const cases = [];
    finder.criteria.forEach((criterion, position) => {
      const local = `v${position}`;
      if (criterion.match !== 'exact') {
        if (!textCriteria.includes(criterion)) return;
        const { hit, misses } = finderTextProbes(criterion);
        cases.push({ criterion, hits: [goString(hit)], misses: misses.map(goString) });
        // Un obligatorio lleva este valor en los filtros de los demás criterios; uno opcional no lo usa (Go no admite un
        // local sin usar).
        if (criterion.required) locals.push(`\t${local} := ${goString(FINDER_PROBE_TEXT)}`);
        return;
      }
      const { target } = criterion;
      if (target.kind === 'relation') {
        const member = members.find((candidate) => candidate.kind === 'externalRef' && candidate.relation.name === target.relation.name);
        const read = `s.${goExported(member.name)}()`;
        locals.push(`\t${local} := ${member.optional ? `deref(t, ${read})` : read}`);
        const idType = model.entities.find((entity) => entity.name === target.relation.entity)?.idField?.goType ?? 'uuid.UUID';
        cases.push({ criterion, hits: [local], misses: [idType === 'uuid.UUID' ? 'uuid.Must(uuid.NewV7())' : `${local} + 1`] });
        return;
      }
      const field = target.kind === 'vo' ? target.sub : target.field;
      if (target.kind === 'vo') {
        const vo = memberOf(target.field.name);
        const read = vo.optional ? `deref(t, s.${goExported(target.field.name)}())` : `s.${goExported(target.field.name)}()`;
        locals.push(`\t${local} := ${read}.${goExported(target.sub.name)}()`);
      } else {
        const read = `s.${goExported(target.field.name)}()`;
        locals.push(`\t${local} := ${memberOf(target.field.name)?.optional ? `deref(t, ${read})` : read}`);
      }
      if (criterion.op === 'eq') {
        const hit = field.goType === 'string' && criterion.compare !== 'exact' ? `strings.ToUpper(${local})` : local;
        cases.push({ criterion, hits: [hit], misses: [otherThan(field, local)] });
        return;
      }
      const plus = shift(field, local, 1);
      const minus = shift(field, local, -1);
      const table = { gte: [[local], [plus]], gt: [[minus], [local]], lte: [[local], [minus]], lt: [[plus], [local]] };
      const [hits, misses] = table[criterion.op];
      cases.push({ criterion, hits, misses });
    });

    // El filtro con un solo criterio puesto; los obligatorios llevan siempre el valor que encuentra la fila.
    const filterOf = (probed, value) => {
      if (!hasFilter(finder)) return 'struct{}{}';
      const fields = finder.criteria
        .map((criterion, position) => {
          const raw = criterion === probed ? value : criterion.required ? `v${position}` : null;
          if (raw == null) return null;
          return `${goExported(criterion.name)}: ${criterion.required ? raw : `ptr(${raw})`}`;
        })
        .filter(Boolean);
      return `domain.${filterTypeName(finder)}{${fields.join(', ')}}`;
    };
    const call = (filter) => {
      const args = ['ctx', ...(hasFilter(finder) ? [filter] : []), ...(finder.result === 'page' ? ['domain.Pageable{Size: 1000}'] : [])];
      return `${repo}.${method}(${args.join(', ')})`;
    };
    const items = finder.result === 'page' ? 'page.Items' : 'page';
    const noFilter = filterOf(null, null);
    const assertions = [`\tif !finds(${noFilter}, s.${id}()) {\n\t\tt.Error("sin filtros no encuentra la fila")\n\t}`];
    for (const { criterion, hits, misses } of cases) {
      for (const hit of hits) assertions.push(`\tif !finds(${filterOf(criterion, hit)}, s.${id}()) {\n\t\tt.Error(${goString(`${criterion.name} = ${hit} no la encuentra`)})\n\t}`);
      for (const miss of misses) assertions.push(`\tif finds(${filterOf(criterion, miss)}, s.${id}()) {\n\t\tt.Error(${goString(`${criterion.name} = ${miss} la encuentra`)})\n\t}`);
    }
    // El where: la fila que no lo cumple no sale. Con un filtro obligatorio la aislaría también ese filtro: no se afirma.
    if (finder.fixed.length > 0 && !finder.criteria.some((criterion) => criterion.required)) {
      assertions.push(`\tif finds(${noFilter}, outside.${id}) {\n\t\tt.Error("la fila que no cumple el where sale")\n\t}`);
    }
    const filterParam = hasFilter(finder) ? `filter domain.${filterTypeName(finder)}` : '_ struct{}';
    return `func Test${name}_Finder${method}(t *testing.T) {
	ctx := t.Context()
	inside := sample${name}(t, ${FIRST + index * 2})
	outside := sample${name}(t, ${FIRST + index * 2 + 1})
${prepare.join('\n')}
	for _, state := range []domain.${name}State{inside, outside} {
		if _, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state)); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	s, found, err := ${repo}.FindByID(ctx, inside.${id})
	if err != nil || !found {
		t.Fatalf("la fila guardada no se relee: %v", err)
	}
	finds := func(${filterParam}, target ${root.idField?.goType ?? 'uuid.UUID'}) bool {
		t.Helper()
		page, err := ${call('filter')}
		if err != nil {
			t.Fatalf("${method}: %v", err)
		}
		for _, item := range ${items} {
			if item.${id}() == target {
				return true
			}
		}
		return false
	}
${locals.join('\n')}
${assertions.join('\n')}
}`.replace(/\n\n+/g, '\n');
  });
}
