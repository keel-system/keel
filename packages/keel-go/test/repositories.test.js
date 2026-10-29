// La PERSISTENCIA que emite keel-go (tramo 6b), sobre el árbol en memoria de las fixtures compartidas. Lo que solo se
// ve contra un PostgreSQL real (el SQL de cada adaptador, la versión, la traducción de una violación) lo mide db-check;
// aquí va lo que se juzga sin Go y sin base:
//   · PARIDAD: el traductor de errores del motor conoce las MISMAS constraints que el de keel-dotnet, y cada una sale
//     con el error que dice keel-core/gen/constraint-errors.js; db.yaml lleva las claves y valores de keel-dotnet;
//   · el puerto de cada raíz, el adaptador que lo implementa, el handler que recibe su repositorio y el arranque que
//     los cablea;
//   · go.mod: pgx y goose con la persistencia relacional, x/text solo con un pliegue de acentos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { constraintErrors } from '@keel-system/keel-core/gen/constraint-errors';
import { repositoryOf, repositoryRoots, usesApi, usesRelational } from '@keel-system/keel-core/gen/features';
import { planService } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { pendingLayers } from '../src/lib/supported-features.js';
import { foldKinds } from '../src/scaffold/persistence-runtime.js';
import { portName, repositoryParam } from '../src/scaffold/repositories.js';
import { handlerType, operations } from '../src/scaffold/services.js';
import { sentinelOf } from '../src/scaffold/errors.js';
import { FIXTURES_DIR, makeWorkspace, mountDesign } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

/** Lo que keel-go genera de una fixture: sin las capas que su frontera rechaza todavía. */
function goPlan(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const withoutLayers = pendingLayers(layers).filter((layer) => manifest.layers?.[layer]);
  const workspace = makeWorkspace();
  const spec = mountDesign(workspace, name, { withoutLayers });
  const loaded = loadService(spec);
  return { loaded, plan: planService({ ...loaded, workspace }) };
}

const relational = fixtures
  .map((name) => ({ name, ...goPlan(name) }))
  .filter(({ plan }) => usesRelational(plan.model) && repositoryRoots(plan.model).length > 0);
const file = (plan, filePath) => plan.files.find((candidate) => candidate.path === filePath)?.content;

test('hay fixtures relacionales que medir', () => {
  assert.ok(relational.length >= 10, `solo ${relational.length}`);
});

for (const { name, loaded, plan } of relational) {
  const { model } = plan;
  const dotnet = planDotnet({ ...loaded, workspace: FIXTURES_DIR }).files;

  test(`${name}: el traductor conoce las constraints de keel-dotnet, cada una con su error de constraint-errors.js`, () => {
    const errorsGo = file(plan, 'internal/infrastructure/postgres/errors.go');
    const go = new Map([...errorsGo.matchAll(/^\t"([a-z0-9_]+)":\s+domain\.(?:Status)?Errorf\(domain\.(Err\w+),/gm)].map(([, constraint, sentinel]) => [constraint, sentinel]));
    const persistenceErrors = dotnet.find((candidate) => candidate.path.endsWith('/PersistenceErrors.cs'))?.content ?? '';
    const cs = new Set([...persistenceErrors.matchAll(/\["([a-z0-9_]+)"\] = \(\) =>/g)].map(([, constraint]) => constraint));
    assert.deepEqual([...go.keys()].sort(), [...cs].sort());
    for (const entry of constraintErrors(model)) {
      assert.equal(go.get(entry.constraint.toLowerCase()), sentinelOf(entry.declared ? entry.declared.code : entry.code), entry.constraint);
    }
  });

  test(`${name}: db.yaml de cada perfil lleva las claves y valores de keel-dotnet`, () => {
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const pairs = (text) =>
        (text ?? '')
          .split('\n')
          .filter((line) => /^\s*[a-z-]+:/.test(line))
          .map((line) => line.trim());
      const go = pairs(file(plan, `config/parameters/${profile}/db.yaml`));
      const cs = pairs(dotnet.find((candidate) => candidate.path.endsWith(`config/parameters/${profile}/db.yaml`))?.content);
      assert.ok(go.length > 0, profile);
      // keel-dotnet añade cómo gobierna el esquema EF (`schema:`); en keel-go lo gobiernan siempre las migraciones.
      assert.deepEqual(go, cs.filter((line) => !line.startsWith('schema:')), profile);
    }
  });

  test(`${name}: un puerto por raíz, su adaptador, y el arranque los cablea`, () => {
    const main = file(plan, 'cmd/server/main.go');
    for (const root of repositoryRoots(model)) {
      const port = file(plan, `internal/domain/${portFileName(root)}`);
      assert.match(port, new RegExp(`type ${portName(root)} interface \\{`), root.name);
      assert.match(port, /\tSave\(ctx context\.Context, \w+ \*\w+\) \(\*\w+, error\)/);
      assert.match(port, /\tFindByID\(ctx context\.Context, \w+ [\w.]+\) \(\*\w+, bool, error\)/);
      const adapter = plan.files.find((candidate) => candidate.path.startsWith('internal/infrastructure/postgres/') && candidate.content.includes(`var _ domain.${portName(root)} = (*${root.name}Repository)(nil)`));
      assert.ok(adapter, `${root.name}: el adaptador no declara que implementa el puerto`);
      // Sin API, el arranque todavía no construye los casos de uso (los despachará el reloj, incremento 10).
      if (usesApi(model)) assert.match(main, new RegExp(`\\t\\t[A-Z]\\w*:\\s+postgres\\.New${root.name}Repository\\(transactions\\),`));
    }
    if (usesApi(model)) assert.match(main, /postgres\.Migrate\(ctx, db, logger\)/);
  });

  test(`${name}: cada handler recibe el repositorio de su agregado, y NewUseCases se lo pasa`, () => {
    const wiring = file(plan, 'internal/application/use_cases.go');
    for (const operation of operations(model)) {
      const root = repositoryOf(model, operation);
      if (!root) continue;
      const handler = plan.files.find((candidate) => candidate.path.startsWith('internal/application/') && candidate.content.includes(`func New${handlerType(operation)}(`))?.content;
      assert.match(handler, new RegExp(`func New${handlerType(operation)}\\(${repositoryParam(root)} domain\\.${portName(root)}`), operation.name);
      assert.ok(wiring.includes(`New${handlerType(operation)}(deps.`), operation.name);
    }
  });

  test(`${name}: go.mod pide pgx y goose, y x/text solo con un pliegue de acentos`, () => {
    const goMod = file(plan, 'go.mod');
    assert.match(goMod, /\tgithub\.com\/jackc\/pgx\/v5 v/);
    assert.match(goMod, /\tgithub\.com\/pressly\/goose\/v3 v/);
    assert.equal(/\tgolang\.org\/x\/text v/.test(goMod), foldKinds(model).has('accents'));
    assert.equal(Boolean(file(plan, 'internal/platform/textfold/textfold.go')), foldKinds(model).size > 0);
  });
}

function portFileName(root) {
  return `${root.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_repository.go`;
}

test('sin persistencia no hay repositorios, ni Dependencies, ni pgx', () => {
  const { plan } = goPlan('product-catalog');
  assert.ok(file(plan, 'internal/domain/product_repository.go'));
  const workspace = makeWorkspace();
  const spec = mountDesign(workspace, 'product-catalog', { withoutLayers: ['persistence'] });
  const bare = planService({ ...loadService(spec), workspace });
  assert.equal(bare.files.some((candidate) => candidate.path.startsWith('internal/infrastructure/')), false);
  assert.doesNotMatch(file(bare, 'internal/application/use_cases.go'), /Dependencies/);
  assert.doesNotMatch(file(bare, 'go.mod'), /pgx/);
});
