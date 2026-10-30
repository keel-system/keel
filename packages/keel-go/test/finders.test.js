// Los FINDERS de las búsquedas (DSL 2.22) que emite keel-go, sin Go ni base: sobre catalog-extended (la fixture que
// declara filtros) y los diseños derivados que comparten los generadores (keel-core/test/helpers/finder-designs.js).
//   · PARIDAD: cada raíz tiene los mismos finders que en keel-dotnet, con los mismos filtros en el mismo orden;
//   · el puerto lleva el struct de filtros y la firma; el adaptador, el método, y cada valor viaja como PARÁMETRO;
//   · values.go emite de `filters` solo lo que algún finder usa (U1000), y la nota del handler nombra la llamada.
// Lo que solo se ve contra la base (que el WHERE restringe, los extremos, el texto literal y plegado) lo mide db-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { findersOf } from '@keel-system/keel-core/gen/query-filters';
import { repositoryRoots } from '@keel-system/keel-core/gen/features';
import { planService } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { filterTypeName, finderMethod } from '../src/scaffold/finders.js';
import { goExported } from '../src/lib/go-projection.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { FINDER_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';

const designs = [{ name: 'catalog-extended', from: 'catalog-extended', mutate: null }, ...FINDER_DESIGNS.filter((design) => design.from === 'product-catalog')];

function plans({ from, mutate }) {
  const load = () => {
    const loaded = loadService(path.join(FIXTURES_DIR, from));
    if (mutate) mutate(loaded.layers);
    return loaded;
  };
  return { go: planService({ ...load(), workspace: FIXTURES_DIR }), dotnet: planDotnet({ ...load(), workspace: FIXTURES_DIR }) };
}

for (const design of designs) {
  const { go, dotnet } = plans(design);
  const file = (suffix) => go.files.find((candidate) => candidate.path.endsWith(suffix))?.content ?? '';

  test(`${design.name}: cada raíz tiene los finders de keel-dotnet, con sus filtros en el mismo orden`, () => {
    const dotnetFiles = dotnet.files.map((candidate) => candidate.content).join('\n');
    let seen = 0;
    for (const root of repositoryRoots(go.model)) {
      for (const finder of findersOf(go.model, root.name)) {
        seen += 1;
        assert.match(dotnetFiles, new RegExp(`Task<[^>]+>+ ${goExported(finder.method)}\\(`), `keel-dotnet no tiene ${finder.method}`);
        if (finder.criteria.length === 0) continue;
        const record = new RegExp(`record ${finder.filterType}\\(([^)]*)\\)`).exec(dotnetFiles)?.[1] ?? '';
        const dotnetNames = record.split(',').map((param) => param.trim().split(/\s+/).at(-1));
        const struct = new RegExp(`type ${filterTypeName(finder)} struct \\{([\\s\\S]*?)\\n\\}`).exec(go.files.map((f) => f.content).join('\n'))?.[1] ?? '';
        const goNames = [...struct.matchAll(/^\t(\w+) /gm)].map((m) => m[1]);
        // Sin distinguir mayúsculas: las siglas van en un solo caso en Go (CategoryID) y no en C# (CategoryId).
        assert.deepEqual(goNames.map((n) => n.toLowerCase()), dotnetNames.map((n) => n.toLowerCase()), `${finder.filterType}`);
      }
    }
    assert.ok(seen > 0, 'el diseño no tiene finders');
  });

  test(`${design.name}: puerto, adaptador y nota del handler; los valores viajan como parámetros`, () => {
    for (const root of repositoryRoots(go.model)) {
      const finders = findersOf(go.model, root.name);
      if (finders.length === 0) continue;
      const ports = go.files.filter((candidate) => candidate.path.startsWith('internal/domain/') && candidate.path.endsWith('_repository.go')).map((f) => f.content).join('\n');
      const adapters = go.files.filter((candidate) => candidate.path.startsWith('internal/infrastructure/postgres/') && candidate.path.endsWith('_repository.go')).map((f) => f.content).join('\n');
      for (const finder of finders) {
        const method = finderMethod(finder);
        assert.match(ports, new RegExp(`\\t${method}\\(ctx context\\.Context`), `el puerto no declara ${method}`);
        const body = new RegExp(`func \\(r \\*${root.name}Repository\\) ${method}\\([\\s\\S]*?\\n\\}`).exec(adapters)?.[0];
        assert.ok(body, `el adaptador no implementa ${method}`);
        // Ningún dato de la petición entra en el texto del SQL: solo por f.add/f.prefix/f.contains, que lo parametrizan.
        assert.doesNotMatch(body, /"\s*\+\s*filter\./, `${method} concatena un filtro en el SQL`);
        for (const criterion of finder.criteria) assert.match(body, new RegExp(`filter\\.${goExported(criterion.name)}\\b`), `${method} no aplica ${criterion.name}`);
        const handler = go.files.find((candidate) => candidate.content.includes(`h.${root.name[0].toLowerCase()}${root.name.slice(1)}Repository.${method}(`));
        assert.ok(handler, `ninguna nota de handler nombra ${method}`);
      }
    }
  });

  test(`${design.name}: values.go emite de filters solo lo que algún finder usa`, () => {
    const values = file('postgres/values.go');
    const all = go.model.services.flatMap((group) => group.operations).filter((operation) => operation.finder);
    const criteria = all.flatMap((operation) => operation.finder.criteria);
    assert.match(values, /^type filters struct/m);
    assert.equal(/func \(f \*filters\) contains\(/.test(values), criteria.some((c) => c.match === 'contains'));
    assert.equal(/func \(f \*filters\) prefix\(/.test(values), criteria.some((c) => c.match === 'prefix'));
    assert.equal(/func \(f \*filters\) page\(/.test(values), all.some((operation) => operation.finder.result === 'page'));
  });
}

test('sin finders, values.go no lleva filters', () => {
  const loaded = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  const { files } = planService({ ...loaded, workspace: FIXTURES_DIR });
  assert.doesNotMatch(files.find((f) => f.path.endsWith('postgres/values.go')).content, /type filters struct/);
});
