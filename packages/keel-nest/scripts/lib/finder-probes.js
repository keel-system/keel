// Los FINDERS de las búsquedas (DSL 2.22) contra el motor, para db-check y doc-check: la misma sonda que la de
// keel-dotnet (scripts/lib/db-probes.js), con el vocabulario de keel-core/gen/query-filters.js. Por cada finder, una
// fila que cumple su `where` (releída tras guardarla: la precisión con que el motor guarda un instante no es la de la
// muestra) y otra que no; por cada criterio, un valor que la encuentra y otros que no —los extremos de gte/lte
// incluidos, los de gt/lt fuera, y el texto como literal—. Solo habla con el puerto: vale para los dos almacenes.

import { findersOf, FINDER_PROBE_TEXT, finderTextProbes } from 'keel-core/gen';
import { screamingSnake } from 'keel-core/gen/naming';
import { classPath, DIRS } from '../../src/scaffold/render.js';

const js = (value) => JSON.stringify(value);

/** El bloque de la raíz, con `repository`, `stateOf` y `check` del script de la sonda. */
export function finderBlock(model, root, index, ctx, { sampleEntity }) {
  const idName = root.idField?.name ?? 'id';
  const finders = findersOf(model, root.name);
  return finders
    .map((finder, position) => {
      const enumOf = (field) => {
        ctx.imports.add(`${field.namedType}|${classPath(DIRS.enums, field.namedType)}`);
        return field.namedType;
      };
      const fixedLiteral = (entry) => (entry.field.kind === 'enum' ? `${enumOf(entry.field)}.${screamingSnake(String(entry.value))}` : js(entry.value));
      const otherThan = (field, expr) =>
        field.kind === 'enum' ? `Object.values(${enumOf(field)}).find((value) => value !== ${expr})` : field.base === 'boolean' ? `!${expr}` : field.base === 'long' ? `${expr} + 1n` : field.base === 'int' ? `${expr} + 1` : `${expr} + '-otro'`;
      const textCriteria = finder.criteria.filter((criterion) => criterion.match !== 'exact' && (criterion.target.field.textMaxLength ?? Infinity) > FINDER_PROBE_TEXT.length);
      const overrides = (entries, text) => [...textCriteria.map((criterion) => `${criterion.target.field.name}: ${js(text)}`), ...entries].join(', ');
      const inside = overrides(finder.fixed.map((entry) => `${entry.name}: ${fixedLiteral(entry)}`), FINDER_PROBE_TEXT);
      // La de fuera lleva otro texto: si el campo es único (una clave natural), el mismo chocaría al guardarla.
      const outside = overrides(finder.fixed.map((entry) => `${entry.name}: ${otherThan(entry.field, fixedLiteral(entry))}`), `${FINDER_PROBE_TEXT}2`);

      const stored = (criterion) => {
        const { target } = criterion;
        if (target.kind === 'relation') return `s.${target.relation.name}Id`;
        if (target.kind === 'vo') return `s.${target.field.name}.${target.sub.name}`;
        return `s.${target.field.name}`;
      };
      const base = (criterion) => (criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field)?.base;
      const shift = (criterion, value, sign) => {
        const kind = base(criterion);
        if (kind === 'timestamp') return `new Date(${value}.getTime() ${sign > 0 ? '+' : '-'} 86400000)`;
        if (kind === 'decimal') return `${value}.${sign > 0 ? 'plus' : 'minus'}(Decimal.of(1))`;
        if (kind === 'long') return `${value} ${sign > 0 ? '+' : '-'} 1n`;
        return `${value} ${sign > 0 ? '+' : '-'} 1`;
      };
      const locals = [];
      const cases = finder.criteria
        .map((criterion, at) => {
          if (criterion.match !== 'exact') {
            if (!textCriteria.includes(criterion)) return null;
            const { hit, misses } = finderTextProbes(criterion);
            return { criterion, hits: [js(hit)], misses: misses.map(js) };
          }
          const local = `v${at}`;
          locals.push(`    const ${local} = ${stored(criterion)};`);
          const field = criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field;
          // El id que no existe, del tipo del id de la raíz a la que apunta (un legacy trae ids long).
          const pointsTo = criterion.target.kind === 'relation' ? model.entities.find((entity) => entity.name === criterion.target.relation.entity)?.idField?.base ?? 'uuid' : field?.base === 'uuid' ? 'uuid' : null;
          if (pointsTo) return { criterion, hits: [local], misses: [pointsTo === 'long' ? `${local} + 1n` : pointsTo === 'int' ? `${local} + 1` : 'randomUUID()'] };
          if (criterion.op === 'eq') {
            const textual = ['string', 'text'].includes(field?.base);
            return { criterion, hits: [textual && criterion.compare !== 'exact' ? `${local}.toUpperCase()` : local], misses: [otherThan(field, local)] };
          }
          if (base(criterion) === 'decimal') ctx.imports.add('Decimal|src/domain/support/decimal.ts');
          const plus = shift(criterion, local, 1);
          const minus = shift(criterion, local, -1);
          const table = { gte: [[local], [plus]], gt: [[minus], [local]], lte: [[local], [minus]], lt: [[plus], [local]] };
          const [hits, misses] = table[criterion.op];
          return { criterion, hits, misses };
        })
        .filter(Boolean);

      const filterOf = (probed, value) =>
        `{ ${finder.criteria.map((criterion, at) => `${criterion.name}: ${criterion === probed ? value : criterion.required ? `v${at}` : 'null'}`).join(', ')} }`;
      const call = (filter) =>
        finder.result === 'page'
          ? `(await repository.${finder.method}(${filter ? `${filter}, ` : ''}{ page: 0, size: 1000, sort: [] })).items`
          : `(await repository.${finder.method}(${filter ?? ''}))`;
      const finds = (filter, target) => `${call(filter)}.some((found) => found.${idName} === ${target}.${idName})`;
      const noFilter = finder.criteria.length > 0 ? filterOf(null, null) : null;
      const label = `${root.name}.${finder.method}`;
      const checks = [`    check(${js(`${label}: sin filtros encuentra la fila`)}, ${finds(noFilter, 's')});`];
      for (const { criterion, hits, misses } of cases) {
        for (const hit of hits) checks.push(`    check(${js(`${label}: ${criterion.name} = ${hit} la encuentra`)}, ${finds(filterOf(criterion, hit), 's')});`);
        for (const miss of misses) checks.push(`    check(${js(`${label}: ${criterion.name} = ${miss} no la encuentra`)}, !${finds(filterOf(criterion, miss), 's')});`);
      }
      // El where: la fila que no lo cumple no sale. Con un filtro obligatorio, lo aislaría también ese filtro: no se afirma.
      if (finder.fixed.length > 0 && !finder.criteria.some((criterion) => criterion.required)) {
        checks.push(`    check(${js(`${label}: la fila que no cumple el where no sale`)}, !${finds(noFilter, 'outside')});`);
      }
      return `  {
    // El finder de ${finder.operation} (DSL 2.22).
    const inside = new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}q${position}`)}), ${inside} });
    const outside = new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}r${position}`)}), ${outside} });
    await repository.save(inside);
    await repository.save(outside);
    const s = await repository.findById(inside.${idName});
${locals.join('\n')}${locals.length > 0 ? '\n' : ''}${checks.join('\n')}
    await repository.deleteById(inside.${idName});
    await repository.deleteById(outside.${idName});
  }`;
    })
    .join('\n');
}
