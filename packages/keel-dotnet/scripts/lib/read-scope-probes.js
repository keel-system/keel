// La LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss`) contra el adaptador emitido, para db-check y doc-check: RS-1 a RS-8
// de keel-core/gen/read-scope.js, con los ids de los casos que ejecutan keel-spring (read-scope-check) y keel-nest
// (scripts/lib/read-scope-probes.js) sobre los MISMOS diseños (keel-core/test/helpers/read-scope-designs.js). Solo habla
// con el puerto: vale para los dos almacenes. RS-9 a RS-11 (la clave de caché, ReadScopes desde un principal y el 403 del
// cable) no necesitan base: son la prueba emitida ReadScopeTests, que ejecuta cs-check.
//
// Un [Fact] por caso, con el id en el nombre (`Asset_RS8_…`): así cada sabotaje se juzga por los casos que caen. Las filas
// se siembran UNA vez por raíz (un static, como los Ensure de las referencias): tres de dos dueños, A y B.
//
// Las etiquetas importan para el falsado, como en keel-spring y keel-nest: en una raíz cuyo campo acotado está al otro
// lado de una relación, lo que solo es verdad si el camino es el correcto (la fila propia se ve, la ajena no, el total,
// within con varios valores, la carga propia) es RS-8; lo que sigue siendo verdad con el camino roto conserva su caso.

import { findersOf } from '@keel-system/keel-core/gen';
import { LOCK_VERSION } from '@keel-system/keel-core/gen';
import { READ_SCOPE_SABOTAGES, readScopePath, scopedReadsOf, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { scopedLoadsOf } from '../../src/scaffold/read-scope.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { portClass } from '../../src/scaffold/repositories.js';
import { csLocal, csMember, csString, namespaceOf, typeUsings } from '../../src/scaffold/render.js';
import { sampleState } from './db-probes.js';

/**
 * Los sabotajes, por almacén: [sufijo del archivo, texto o expresión, sustituto]. Rompen lo emitido CONSERVANDO LA FORMA
 * (sigue compilando), y cada uno tiene que caer en exactamente sus casos.
 */
export const READ_SCOPE_SABOTAGE_SPECS = {
  'rs-no-filter': {
    relational: ['Repositories/', /^ {8}query = Scoped\(query, scope\);\n/gm, ''],
    document: ['Repositories/', /^ {8}query = await Scoped\(query, scope, cancellationToken\);\n/gm, '']
  },
  // El total se cuenta ANTES de sumar el alcance: las filas salen bien y el total cuenta las de todos.
  'rs-count-unscoped': {
    relational: ['Repositories/', /( {8}query = Scoped\(query, scope\);\n)( {8}var total = await query\.LongCountAsync\(cancellationToken\);\n)/g, '$2$1'],
    document: [
      'Repositories/',
      /( {8}query = await Scoped\(query, scope, cancellationToken\);\n)( {8}\/\/ Una tras otra[^\n]*\n {8}var total = [^\n]*\n[^\n]*\n[^\n]*\n)/g,
      '$2$1'
    ]
  },
  'rs-get-leak': {
    relational: ['Repositories/', '        if (admitted)\n', '        if (admitted || found is not null)\n'],
    document: ['Repositories/', '        if (admitted)\n', '        if (admitted || found is not null)\n']
  },
  // El conjunto vacío (un claim ausente, un dueño nulo) se trata como sin filtro. La mitad del borde (ReadScopes) la mide
  // ReadScopeTests en cs-check.
  'rs-empty-is-all': {
    relational: ['Repositories/', '        var allowed = scope.Values.ToList();\n', '        var allowed = scope.Values.ToList();\n        if (allowed.Count == 0)\n        {\n            return query;\n        }\n'],
    document: ['Repositories/', '        var allowed = new BsonArray(scope.Values);\n', '        var allowed = new BsonArray(scope.Values);\n        if (allowed.Count == 0)\n        {\n            return FilterDefinition<BsonDocument>.Empty;\n        }\n']
  },
  // El predicado sustituye a los criterios en vez de sumarse.
  'rs-finder-replace': {
    relational: ['Repositories/', '        query = Scoped(query, scope);', '        query = Scoped(Graph().AsNoTracking(), scope);'],
    document: ['Repositories/', '        query = await Scoped(query, scope, cancellationToken);', '        query = await Scoped(FilterDefinition<BsonDocument>.Empty, scope, cancellationToken);']
  },
  // Compara otro campo de texto de la raíz del otro lado del camino (Owner.displayName, Profile.username).
  'rs-path': {
    relational: ['Repositories/', /allowed\.Contains\(hop1\.Code\)/g, 'allowed.Contains(hop1.DisplayName)'],
    document: ['Repositories/', /new BsonDocument\("(code|subject)", new BsonDocument\("\$in", allowed\)\)/g, (_, field) => `new BsonDocument("${field === 'code' ? 'display_name' : 'username'}", new BsonDocument("$in", allowed))`]
  }
};

export const isReadScopeSabotage = (id) => Boolean(READ_SCOPE_SABOTAGE_SPECS[id]);

/** Los sujetos de los sabotajes por almacén: los de read-scope-designs.js con esa rama. */
export const READ_SCOPE_SUBJECTS = { relational: ['vault-scoped', 'shop-scoped'], document: ['vault-scoped-mongo', 'conduit-scoped'] };

/** El primer criterio del finder con el que se puede pedir algo que ninguna fila sembrada cumple (RS-7). */
function compositionFilter(finder) {
  return finder.criteria.find((criterion) => criterion.op === 'eq' && criterion.match === 'exact' && (criterion.input.kind === 'enum' || criterion.input.csType === 'string' || criterion.input.csType === 'string?')) ?? null;
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
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/_RS(\d+)_/g)].map((match) => `RS-${match[1]}`)))].sort();
  // Un sujeto al que el sabotaje no toca (rs-path sin salto) no tiene que caer en nada; otro sujeto lo caza.
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/** Las muestras que guarda el bloque de una raíz acotada: las filas de A y de B. */
export function readScopeSampleCount(model, root) {
  if (!scopedRootsOf(model).some((candidate) => candidate.entity?.name === root.name)) return 0;
  return findersOf(model, root.name).some((finder) => finder.scope) ? 3 : 2;
}

/** Los miembros del estado de una entidad, los que se copian al sobrescribir uno. */
function stateMembers(entity, model) {
  return [...domainMembers(model, entity).map((member) => member.name), ...(entity.usesOptimisticLocking && !entity.declaresLockVersion ? [LOCK_VERSION.field] : [])];
}

/** Un estado copiado de otro con algunos miembros sustituidos. */
function copied(entity, model, source, overrides) {
  return `new ${entity.name}State
            {
                ${stateMembers(entity, model)
                  .map((name) => `${csMember(name)} = ${overrides[name] ?? `${source}.${csMember(name)}`},`)
                  .join('\n                ')}
            }`;
}

/**
 * Los [Fact] de RS-1 a RS-8 de una raíz acotada, y la siembra que comparten. `state(n)` es la muestra n de la raíz,
 * `ctx` el de las muestras (sus `usings` y sus `refs`), `index` distingue los valores entre raíces.
 */
export function readScopeProbes(model, root, { state, first, port, id, ctx, index }) {
  const found = scopedRootsOf(model).find((candidate) => candidate.entity?.name === root.name);
  if (!found) return { tests: [], members: [] };
  const { read } = found;
  ctx.usings.push(namespaceOf(model, 'repositories'), namespaceOf(model, 'errors'));
  const path = readScopePath(model, read);
  if (path.hops.length > 1) throw new Error(`read-scope-probes: ${root.name} se acota por ${path.hops.length} saltos; la sonda recorre uno`);
  const hop = path.hops[0] ?? null;
  const finders = findersOf(model, root.name).filter((finder) => finder.scope);
  const loads = scopedLoadsOf(model, root);
  const rows = finders.length > 0 ? ['A1', 'A2', 'B1'] : ['A1', 'B1'];
  const seed = `${root.name}ScopeSeed`;
  const scopeOf = (value) => (read.kind === 'scoping' ? `ReadScope.Within(new[] { ${value} })` : `ReadScope.OwnedBy(${value})`);
  const empty = read.kind === 'scoping' ? 'ReadScope.Within(Array.Empty<string>())' : 'ReadScope.OwnedBy(null)';
  const field = csMember(read.field);

  // La siembra: dos dueños (A y B) y filas de A y de B. El campo acotado lleva un valor que NINGÚN otro campo de texto
  // del dueño repite: si coincidieran, comparar el campo equivocado del camino daría lo mismo y RS-8 no lo vería.
  const lines = [];
  if (hop) {
    const inner = { usings: ctx.usings, refs: new Set(), unsampled: ctx.unsampled, counter: ctx.counter, document: ctx.document };
    const ownerStates = ['a', 'b'].map((tag) => sampleState(model, hop.entity, inner, `${hop.to.toLowerCase()}rs${index}${tag}`));
    for (const ref of inner.refs) {
      ctx.refs.add(ref);
      lines.push(`        var ${csLocal(`${ref}Id`)} = await Ensure${ref}(services);`);
    }
    ctx.usings.push(namespaceOf(model, 'aggregates'));
    ['a', 'b'].forEach((tag, k) => {
      const owner = `owner${tag.toUpperCase()}`;
      lines.push(
        `        var raw${owner} = ${ownerStates[k]};`,
        `        var ${owner} = new ${hop.to}(${copied(hop.entity, model, `raw${owner}`, { [read.field]: csString(`rs-own-${index}-${tag}`) })});`,
        `        await InScope(other => other.GetRequiredService<${portClass(hop.entity)}>().Save(${owner}, Cancel));`
      );
    });
    lines.push(`        var valueA = ownerA.${field};`, `        var valueB = ownerB.${field};`);
  } else {
    lines.push(`        var valueA = ${csString(`rs-${index}-a@x.io`)};`, `        var valueB = ${csString(`rs-${index}-b@x.io`)};`);
  }
  rows.forEach((row, k) => {
    const value = hop ? `owner${row[0]}.${csMember(hop.entity.idField?.name ?? 'id')}` : `value${row[0]}`;
    const member = hop ? `${hop.relation}Id` : read.field;
    lines.push(
      `        var raw${row} = ${state(first + k)};`,
      `        var ${csLocal(row)} = new ${root.name}(${copied(root, model, `raw${row}`, { [member]: value })});`,
      `        await InScope(other => other.GetRequiredService<${port}>().Save(${csLocal(row)}, Cancel));`
    );
  });
  const seedMembers = [
    `    private sealed record ${seed}(string ValueA, string ValueB, ${rows.map((row) => `${root.name} ${row}`).join(', ')});`,
    `    private static ${seed}? ${csLocal(seed)};`,
    `    /// <summary>Las filas de la lectura acotada de ${root.name} (${read.block}.reads), sembradas una vez.</summary>
    private static async Task<${seed}> Seed${root.name}Scope(IServiceProvider services)
    {
        if (${csLocal(seed)} is { } known)
        {
            return known;
        }
${lines.join('\n')}
        ${csLocal(seed)} = new ${seed}(valueA, valueB, ${rows.map(csLocal).join(', ')});
        return ${csLocal(seed)};
    }`
  ];

  const tests = [];
  const fact = (caseId, title, body) =>
    tests.push(`    [Fact]
    public async Task ${root.name}_${caseId.replace('-', '')}_${title}() =>
        await InScope(async services =>
        {
            var seed = await Seed${root.name}Scope(services);
${body}
        });`);
  const tag = (base) => (hop ? 'RS-8' : base);
  for (const finder of finders) {
    if (finder.criteria.some((criterion) => criterion.required)) throw new Error(`read-scope-probes: ${finder.method} tiene un filtro obligatorio; la sonda pide sin filtros`);
    const method = csMember(finder.method);
    const nulls = finder.criteria.length > 0 ? `new ${finder.filterType}(${finder.criteria.map(() => 'null').join(', ')})` : null;
    const call = (scope, { size = 1000, filter = nulls } = {}) =>
      `await InScope(other => other.GetRequiredService<${port}>().${method}(${[filter, finder.result === 'page' ? `new Pageable(0, ${size}, [])` : null, scope, 'Cancel'].filter(Boolean).join(', ')}))`;
    const ids = (scope, options) => `(${call(scope, options)})${finder.result === 'page' ? '.Items' : ''}.Select(row => row.${id}).ToList()`;
    const all = rows.map((row) => `seed.${row}.${id}`).join(', ');
    fact(
      tag('RS-1'),
      `${method}_ElListadoVeSoloLasFilasDelScope`,
      `            var seen = ${ids(scopeOf('seed.ValueA'))};
            Assert.Contains(seed.A1.${id}, seen);
            Assert.Contains(seed.A2.${id}, seen);
            Assert.DoesNotContain(seed.B1.${id}, seen);`
    );
    if (finder.result === 'page') {
      fact(
        tag('RS-2'),
        `${method}_ElTotalYLasPaginasSonLosDelScope`,
        `            var page = ${call(scopeOf('seed.ValueA'), { size: 1 })};
            Assert.Equal((2L, 2), (page.TotalElements, page.TotalPages));`
      );
    }
    fact(
      'RS-3',
      `${method}_UnrestrictedLoVeTodo`,
      `            var seen = ${ids('ReadScope.Unrestricted()')};
            Assert.All(new[] { ${all} }, row => Assert.Contains(row, seen));`
    );
    fact(
      'RS-6',
      `${method}_ElScopeVacioNoVeNada`,
      `            Assert.Empty(${ids(empty)});`
    );
    if (read.kind === 'scoping') {
      fact(
        tag('RS-6'),
        `${method}_WithinConDosValoresVeLasDeLosDos`,
        `            var seen = ${ids('ReadScope.Within(new[] { seed.ValueA, seed.ValueB })')};
            Assert.All(new[] { ${all} }, row => Assert.Contains(row, seen));`
      );
    }
    const composed = compositionFilter(finder);
    if (composed) {
      const filterWith = (value) => `new ${finder.filterType}(${finder.criteria.map((criterion) => (criterion === composed ? value : 'null')).join(', ')})`;
      if (composed.input.kind === 'enum') {
        // Para CADA valor, todo lo que sale lo lleva: si el predicado sustituye a los criterios, salen las de A con otro.
        // No «un valor que ninguna fila tiene»: otras sondas (el barrido, la reconciliación) mueven el estado de las
        // filas sembradas, y en MySQL ese valor dejó de estar libre (medido).
        const enumType = composed.input.csType.replace(/\?$/, '');
        const target = csMember(composed.target.field.name);
        ctx.usings.push(...typeUsings(model, [enumType]));
        const page = `await InScope(other => other.GetRequiredService<${port}>().${method}(${[filterWith('value'), finder.result === 'page' ? 'new Pageable(0, 1000, [])' : null, scopeOf('seed.ValueA'), 'Cancel'].filter(Boolean).join(', ')}))`;
        fact(
          'RS-7',
          `${method}_ElScopeSeSumaALosCriterios`,
          `            foreach (var value in Enum.GetValues<${enumType}>())
            {
                var found = (${page})${finder.result === 'page' ? '.Items' : ''};
                Assert.All(found, row => Assert.Equal<${enumType}?>(value, row.${target}));
            }`
        );
      } else {
        // Un texto que ninguna fila tiene: vacío. Si el predicado sustituye a los criterios, salen las de A.
        fact('RS-7', `${method}_ElScopeSeSumaALosCriterios`, `            Assert.Empty(${ids(scopeOf('seed.ValueA'), { filter: filterWith(csString('rs7-ninguna-fila-lo-tiene')) })});`);
      }
    }
  }
  if (loads.length > 0) {
    const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.root === root.name && candidate.readScope.shape === 'single');
    const error = read.readMiss === 'forbidden' ? operationError(model, operation.name, read.error) : null;
    const missCase = read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4';
    for (const load of loads) {
      // Con `!`: la clave natural puede ser anulable en el dominio (Article.Slug), y la sembrada la lleva.
      const key = (row) => `seed.${row}.${load.by === 'id' ? id : csMember(load.field)}!`;
      const nonexistent = load.param.type === 'long' ? '987654321987L' : load.param.type === 'int' ? '987654321' : load.param.type === 'Guid' ? 'Guid.CreateVersion7()' : csString('rs-no-existe');
      const loadCall = (value, scope) => `InScope(other => other.GetRequiredService<${port}>().${load.method}(${value}, ${scope}, Cancel))`;
      // Con el camino roto la fila propia sale como ajena, y con forbidden eso lanza: no cargó.
      fact(
        tag(missCase),
        `${load.method}_CargaLaFilaPropia`,
        `            ${root.name}? mine;
            try
            {
                mine = await ${loadCall(key('A1'), scopeOf('seed.ValueA'))};
            }
            catch (DomainException)
            {
                mine = null;
            }
            Assert.NotNull(mine);`
      );
      fact(
        missCase,
        `${load.method}_UnaFilaAjenaEsElReadMissDelDiseño`,
        error
          ? `            var error = await Assert.ThrowsAsync<${error.exceptionClass}>(() => ${loadCall(key('B1'), scopeOf('seed.ValueA'))});
            Assert.Equal((403, ${csString(read.error)}), (error.HttpStatus, error.Code));`
          : `            Assert.Null(await ${loadCall(key('B1'), scopeOf('seed.ValueA'))});`
      );
      // Orden de la 2.25 (D5): lo que no existe es null —su 404— antes que el 403 de lo ajeno.
      fact(missCase, `${load.method}_UnaFilaQueNoExisteEsNull`, `            Assert.Null(await ${loadCall(nonexistent, scopeOf('seed.ValueA'))});`);
      fact('RS-3', `${load.method}_UnrestrictedCargaCualquiera`, `            Assert.NotNull(await ${loadCall(key('B1'), 'ReadScope.Unrestricted()')});`);
    }
  }
  return { tests, members: seedMembers };
}
