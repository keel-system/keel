// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss`) contra el adaptador emitido, para db-check y doc-check: RS-1 a RS-8
// de keel-core/gen/read-scope.js, con los ids de los casos que ejecuta keel-spring (read-scope-check) sobre los MISMOS
// diseños (keel-core/test/helpers/read-scope-designs.js). Solo habla con el puerto: vale para los dos almacenes.
// RS-9 a RS-11 (la clave de caché, ReadScopes desde un principal y el 403 del cable) no necesitan base: los ejecuta
// test/read-scope.test.js sobre lo emitido.
//
// Las etiquetas importan para el falsado, como en keel-spring: en una raíz cuyo campo acotado está al otro lado de una
// relación, lo que solo es verdad si el camino es el correcto (la fila propia se ve, la ajena no, el total, within con
// varios valores, la carga propia) es RS-8; lo que sigue siendo verdad con el camino roto conserva su caso.

import { findersOf } from '@keel-system/keel-core/gen';
import { READ_SCOPE_SABOTAGES, readScopePath, scopedReadsOf, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { READ_SCOPE_TS, scopedLoadsOf } from '../../src/scaffold/read-scope.js';
import { classPath, DIRS } from '../../src/scaffold/render.js';

const js = (value) => JSON.stringify(value);

/** El texto que se busca y se sustituye en lo emitido, por sabotaje y por almacén (relational | document). */
export const READ_SCOPE_SABOTAGE_SPECS = {
  'rs-no-filter': {
    relational: [/-repository-impl\.ts$/, /^ {4}for \(const \[property, condition\] of Object\.entries\(this\.readScopeWhere\(scope\)\)\) and\(property, condition\);\n/m, ''],
    document: [/-repository-impl\.ts$/, /^ {4}if \(scope\.kind !== 'unrestricted'\) conditions\.push\(await this\.readScopeFilter\(scope\)\);\n/m, '']
  },
  'rs-count-unscoped': {
    relational: [/-repository-impl\.ts$/, /return pageOf\(rows\.map\(toDomain(\w+)\), pageable, total\);(?=\n {2}\}\n\n {2}async loadScoped|\n {2}\}\n\n {2}\/\*\* El desenlace)/, 'return pageOf(rows.map(toDomain$1), pageable, await this.manager.count($1Orm));'],
    document: [/-repository-impl\.ts$/, /const total = await this\.collection\.countDocuments\(query, \{ session: this\.session \}\);(?=\n {4}return pageOf\(documents\.map\(toDomain\w+\), pageable, total\);\n {2}\}\n\n {2}async loadScoped)/, 'const total = await this.collection.countDocuments({}, { session: this.session });']
  },
  'rs-get-leak': {
    relational: [/-repository-impl\.ts$/, '    if (admitted) return found;', '    if (admitted || true) return found;'],
    document: [/-repository-impl\.ts$/, '    if (admitted) return found;', '    if (admitted || true) return found;']
  },
  'rs-empty-is-all': {
    relational: [/-repository-impl\.ts$/, /'1 = 0'/g, "'1 = 1'"],
    document: [/-repository-impl\.ts$/, 'return { [key]: { $in: [] } };', 'return {};']
  },
  'rs-finder-replace': {
    relational: [/-repository-impl\.ts$/, '    for (const [property, condition] of Object.entries(this.readScopeWhere(scope))) and(property, condition);', '    for (const property of Object.keys(where)) delete where[property];\n    for (const [property, condition] of Object.entries(this.readScopeWhere(scope))) and(property, condition);'],
    document: [/-repository-impl\.ts$/, "    if (scope.kind !== 'unrestricted') conditions.push(await this.readScopeFilter(scope));", "    conditions.length = 0;\n    if (scope.kind !== 'unrestricted') conditions.push(await this.readScopeFilter(scope));"]
  },
  // Compara otro campo de texto de la raíz del otro lado del camino (Owner.displayName, Profile.username).
  'rs-path': {
    relational: [/-repository-impl\.ts$/, "scopedSql('hop1.code', scope)", "scopedSql('hop1.displayName', scope)"],
    document: [/-repository-impl\.ts$/, /scopedFilter\('(code|subject)', scope\)/, (_, field) => `scopedFilter('${field === 'code' ? 'display_name' : 'username'}', scope)`]
  }
};

export const isReadScopeSabotage = (id) => Boolean(READ_SCOPE_SABOTAGE_SPECS[id]);

/** Los casos que ejecuta el bloque de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. */
export function readScopeCases(model) {
  const cases = new Set();
  for (const { entity, read } of scopedRootsOf(model)) {
    const hop = readScopePath(model, read).hops.length > 0;
    const finders = findersOf(model, entity.name).filter((finder) => finder.scope);
    if (finders.length > 0) {
      cases.add(hop ? 'RS-8' : 'RS-1').add('RS-3').add('RS-6');
      if (finders.some((finder) => finder.result === 'page')) cases.add(hop ? 'RS-8' : 'RS-2');
      if (read.kind === 'scoping') cases.add(hop ? 'RS-8' : 'RS-6');
      if (finders.some((finder) => compositionFilter(finder))) cases.add('RS-7');
    }
    if (scopedLoadsOf(model, entity).length > 0) cases.add(hop ? 'RS-8' : read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4').add(read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4').add('RS-3');
  }
  return [...cases];
}

/** Lo que tiene que caer con un sabotaje en este diseño: sus casos que el bloque ejecuta, con RS-1/RS-2 como RS-8 en un camino. */
export function readScopeSabotageVerdict(checks, id, model) {
  const cases = readScopeCases(model);
  const onPath = !cases.includes('RS-1') && cases.includes('RS-8');
  const located = READ_SCOPE_SABOTAGES.find((entry) => entry.id === id).falls.map((caseId) => (onPath && (caseId === 'RS-1' || caseId === 'RS-2') ? 'RS-8' : caseId));
  const want = [...new Set(located)].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(checks.filter((check) => !check.ok && /^RS-\d+:/.test(check.name)).map((check) => /^(RS-\d+):/.exec(check.name)[1]))].sort();
  return { exact: want.length > 0 && failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** El primer criterio del finder con el que se puede pedir algo que ninguna fila sembrada cumple (RS-7). */
function compositionFilter(finder) {
  return finder.criteria.find((criterion) => criterion.op === 'eq' && criterion.match === 'exact' && (criterion.input.kind === 'enum' || criterion.input.tsType === 'string')) ?? null;
}

/**
 * El bloque de una raíz acotada, con `repository`, `stateOf`, `check` y `randomUUID` del script de la sonda.
 * `sampleEntity` da el agregado de muestra y `adapterOf(entity)` el adaptador de otra raíz (la del otro lado del camino).
 */
export function readScopeBlock(model, root, index, ctx, { sampleEntity, adapterOf }) {
  const found = scopedRootsOf(model).find((candidate) => candidate.entity?.name === root.name);
  if (!found) return '';
  const { read } = found;
  ctx.imports.add(`ReadScope|${READ_SCOPE_TS}`);
  const path = readScopePath(model, read);
  if (path.hops.length > 1) throw new Error(`read-scope-probes: ${root.name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
  const hop = path.hops[0] ?? null;
  const idName = root.idField?.name ?? 'id';
  const finders = findersOf(model, root.name).filter((finder) => finder.scope);
  const loads = scopedLoadsOf(model, root);
  const scopeOf = (value) => (read.kind === 'scoping' ? `ReadScope.within([${value}])` : `ReadScope.ownedBy(${value})`);
  const empty = read.kind === 'scoping' ? 'ReadScope.within([])' : 'ReadScope.ownedBy(null)';
  const rows = finders.length > 0 ? ['a1', 'a2', 'b1'] : ['a1', 'b1'];
  const sample = (entity, tag) => sampleEntity(model, entity, ctx, `${index}rs${tag}`);

  // La siembra: dos dueños (A y B) y filas de A y de B. El campo acotado lleva un valor que NINGÚN otro campo de texto del
  // dueño repite: si coincidieran, comparar el campo equivocado del camino daría lo mismo y RS-8 no lo vería.
  const seed = [];
  if (hop) {
    ctx.imports.add(`${hop.to}|${classPath(DIRS.aggregates, hop.to)}`);
    seed.push(
      `    const owners = ${adapterOf(hop.entity)};`,
      `    const ownerA = new ${hop.to}({ ...stateOf(${sample(hop.entity, 'oa')}), ${read.field}: ${js(`rs-own-${index}-a`)} });`,
      `    const ownerB = new ${hop.to}({ ...stateOf(${sample(hop.entity, 'ob')}), ${read.field}: ${js(`rs-own-${index}-b`)} });`,
      '    await owners.save(ownerA);',
      '    await owners.save(ownerB);',
      `    const valueA = ownerA.${read.field};`,
      `    const valueB = ownerB.${read.field};`
    );
    for (const row of rows) seed.push(`    const ${row} = new ${root.name}({ ...stateOf(${sample(root, row)}), ${hop.relation}Id: ${row.startsWith('a') ? 'ownerA' : 'ownerB'}.${hop.entity.idField?.name ?? 'id'} });`);
  } else {
    seed.push(`    const valueA = ${js(`rs-${index}-a@x.io`)};`, `    const valueB = ${js(`rs-${index}-b@x.io`)};`);
    for (const row of rows) seed.push(`    const ${row} = new ${root.name}({ ...stateOf(${sample(root, row)}), ${read.field}: ${row.startsWith('a') ? 'valueA' : 'valueB'} });`);
  }
  for (const row of rows) seed.push(`    await repository.save(${row});`);

  const label = (caseId, text) => js(`${caseId}: ${root.name} ${text}`);
  const checks = [];
  const tag = (base) => (hop ? 'RS-8' : base);
  for (const finder of finders) {
    const nulls = finder.criteria.length > 0 ? `{ ${finder.criteria.map((criterion) => `${criterion.name}: null`).join(', ')} }` : null;
    const call = (scope, { size = 1000, filter = nulls } = {}) =>
      `(await repository.${finder.method}(${[filter, finder.result === 'page' ? `{ page: 0, size: ${size}, sort: [] }` : null, scope].filter(Boolean).join(', ')}))`;
    const ids = (scope, options) => `${call(scope, options)}${finder.result === 'page' ? '.items' : ''}.map((row) => String(row.${idName}))`;
    const has = (row) => `String(${row}.${idName})`;
    checks.push(
      `    {
      const seen = ${ids(scopeOf('valueA'))};
      check(${label(tag('RS-1'), `${finder.method}: el listado ve las filas del scope`)}, seen.includes(${has('a1')}) && seen.includes(${has('a2')}), seen.join(', '));
      check(${label(tag('RS-1'), `${finder.method}: el listado no ve una fila ajena`)}, !seen.includes(${has('b1')}));
    }`
    );
    if (finder.result === 'page') {
      checks.push(
        `    {
      const page = ${call(scopeOf('valueA'), { size: 1 })};
      check(${label(tag('RS-2'), `${finder.method}: el total y las páginas son los del scope`)}, page.totalElements === 2 && page.totalPages === 2, \`\${page.totalElements} / \${page.totalPages}\`);
    }`
      );
    }
    checks.push(
      `    {
      const seen = ${ids('ReadScope.unrestricted()')};
      check(${label('RS-3', `${finder.method}: unrestricted lo ve todo`)}, [${['a1', 'a2', 'b1'].map(has).join(', ')}].every((id) => seen.includes(id)));
      const none = ${ids(empty)};
      check(${label('RS-6', `${finder.method}: el scope vacío no ve nada`)}, none.length === 0, none.join(', '));
    }`
    );
    if (read.kind === 'scoping') {
      checks.push(
        `    {
      const seen = ${ids('ReadScope.within([valueA, valueB])')};
      check(${label(tag('RS-6'), `${finder.method}: within con dos valores ve las de los dos`)}, [${['a1', 'a2', 'b1'].map(has).join(', ')}].every((id) => seen.includes(id)));
    }`
      );
    }
    const composed = compositionFilter(finder);
    if (composed) {
      let value = js('rs7-ninguna-fila-lo-tiene');
      if (composed.input.kind === 'enum') {
        ctx.imports.add(`${composed.input.namedType}|${classPath(DIRS.enums, composed.input.namedType)}`);
        value = `Object.values(${composed.input.namedType}).find((candidate) => candidate !== a1.${composed.target.field.name})`;
      }
      const filter = `{ ${finder.criteria.map((criterion) => `${criterion.name}: ${criterion === composed ? value : 'null'}`).join(', ')} }`;
      // Un filtro que no cumple ninguna fila del scope: vacío. Si el predicado sustituye a los criterios, salen las de A.
      checks.push(
        `    {
      const seen = ${ids(scopeOf('valueA'), { filter })};
      check(${label('RS-7', `${finder.method}: el scope se suma a los criterios`)}, seen.length === 0, seen.join(', '));
    }`
      );
    }
  }
  if (loads.length > 0) {
    const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.root === root.name && candidate.readScope.shape === 'single');
    const error = read.readMiss === 'forbidden' ? operationError(model, operation.name, read.error) : null;
    if (error) ctx.imports.add(`${error.exceptionClass}|${classPath(DIRS.errors, error.exceptionClass)}`);
    const missCase = read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4';
    for (const load of loads) {
      const key = (row) => `${row}.${load.param.name}`;
      const nonexistent = load.param.tsType === 'bigint' ? '987654321987n' : load.param.tsType === 'number' ? '987654321' : load.by === 'id' ? 'randomUUID()' : js('rs-no-existe');
      const miss = error
        ? `      try {
        await repository.${load.method}(${key('b1')}, ${scopeOf('valueA')});
        check(${label(missCase, `${load.method}: una fila ajena da ${read.error}`)}, false, 'se cargó');
      } catch (error) {
        check(${label(missCase, `${load.method}: una fila ajena da ${read.error}`)}, error instanceof ${error.exceptionClass}, error?.message);
      }`
        : `      check(${label(missCase, `${load.method}: una fila ajena es null, como si no existiera`)}, (await repository.${load.method}(${key('b1')}, ${scopeOf('valueA')})) == null);`;
      checks.push(
        `    {
      // Con el camino roto la fila propia sale como ajena, y con forbidden eso lanza: no cargó.
      check(${label(tag(missCase), `${load.method}: carga la fila propia`)}, (await repository.${load.method}(${key('a1')}, ${scopeOf('valueA')}).catch(() => null)) != null);
${miss}
      // Orden de la 2.25 (D5): lo que no existe es null —su 404— antes que el 403 de lo ajeno.
      check(${label(missCase, `${load.method}: una fila que no existe es null`)}, (await repository.${load.method}(${nonexistent}, ${scopeOf('valueA')})) == null);
      check(${label('RS-3', `${load.method}: unrestricted carga cualquiera`)}, (await repository.${load.method}(${key('b1')}, ReadScope.unrestricted())) != null);
    }`
      );
    }
  }
  return `
  // ─── La lectura acotada (DSL 2.27): ${read.block}.reads, RS-1 a RS-8 ───
  {
${seed.join('\n')}
${checks.join('\n')}
  }`;
}
