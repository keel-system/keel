// El arnés de integración de keel-nest (incremento 7b): la infraestructura de prueba es la MISMA que
// la de keel-spring del mismo diseño, el script que puntúa la matriz lee el XML con los MISMOS
// programas, y el historial de migraciones que el reset respeta es el que el DataSource declara.
// Lo que solo se ve con contenedores —que todo eso funcione— lo mide `npm run harness-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK } from 'keel-core/gen/junit-scoring';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { SPRING_INFRA } from '../../keel-spring/src/scaffold/devtools.js';
import { NEST_INFRA, MIGRATIONS_TABLE } from '../src/scaffold/infra.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR, NEST_READY_DESIGN } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));

/**
 * Lo que un script de infra/ dice, sin lo que es de la plataforma: los comentarios, la cabecera y los
 * textos y la tabla de historial de cada generador, sustituidos por la misma marca.
 */
function neutral(content, platform, projectName) {
  let text = content;
  const texts = [
    projectName,
    platform.historyTable,
    platform.historyTable.toUpperCase(),
    platform.generator,
    platform.strayProcess.hint,
    platform.strayProcess.close,
    platform.schemaRebuiltBy.relational,
    platform.schemaRebuiltBy.document
  ];
  for (const value of texts) text = text.split(value).join('<plataforma>');
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

for (const name of fixtures) {
  test(`${name}: infra/ es la de keel-spring salvo los textos de la plataforma`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = byPath(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files);
    const nest = byPath(planFixture(name).files);
    const shared = ['infra/docker-compose.yaml', 'infra/up.sh', 'infra/down.sh', 'infra/docker/Dockerfile', 'infra/validate-infra.sh', 'infra/reset-db.sh'];
    for (const file of shared) {
      assert.equal(file in nest, file in spring, `${file}: lo emiten los dos o ninguno`);
      if (!(file in spring)) continue;
      // El toolbox y su etiqueta llevan el nombre del generador en la cabecera del Dockerfile: se comparan sin ella.
      const normalize = (content, platform, suffix) =>
        neutral(content, platform, `${manifest.service?.name ?? name}-${suffix}`).replace(/devtools:[0-9a-f]{12}/g, 'devtools:<etiqueta>');
      assert.equal(normalize(nest[file], NEST_INFRA, 'nest'), normalize(spring[file], SPRING_INFRA, 'spring'), file);
    }
  });
}

test('el reset respeta la tabla de historial que declara el DataSource', () => {
  const files = byPath(planFixture(NEST_READY_DESIGN.name).files);
  const dataSource = Object.entries(files).find(([file]) => file.endsWith('data-source-options.ts'))?.[1] ?? '';
  assert.match(dataSource, new RegExp(`migrationsTableName: '${MIGRATIONS_TABLE}'`));
  assert.equal(NEST_INFRA.historyTable, MIGRATIONS_TABLE);
  // El comando va entre comillas simples de bash: la del literal SQL sale escapada.
  const quoted = String.raw`'\''` + MIGRATIONS_TABLE + String.raw`'\''`;
  assert.ok(files['infra/reset-db.sh'].includes(`tablename <> ${quoted}`), 'el reset excluye la tabla de historial');
  assert.doesNotMatch(files['infra/reset-db.sh'], /flyway|\{history\}/i);
});

test('score-scenarios.sh lee la matriz con los programas compartidos y sella specs/ como keel-nest', () => {
  const script = byPath(planFixture(NEST_READY_DESIGN.name).files)['infra/score-scenarios.sh'];
  assert.ok(script.includes(JUNIT_MATRIX_AWK), 'el programa de la matriz, tal cual');
  assert.ok(script.includes(JUNIT_NON_SCENARIO_AWK), 'el de las pruebas que no son escenarios, tal cual');
  assert.match(script, /no es el que escribió keel-nest build/);
  assert.doesNotMatch(script, /gradlew/);
});

test('Vitest escribe el XML con el título del caso en name y el archivo en classname', () => {
  const config = byPath(planFixture(NEST_READY_DESIGN.name).files)['vitest.integration.config.ts'];
  assert.match(config, /outputFile: 'build\/test-results\/integration\/junit\.xml'/);
  assert.match(config, /titleTemplate: '\{title\}'/);
  assert.match(config, /classnameTemplate: \(vars: \{ basename: string \}\) => vars\.basename\.replace/);
  assert.match(config, /fileParallelism: false/);
});

test('la suite unitaria no ejecuta los flujos, y la regla de la caja negra los vigila', () => {
  const files = byPath(planFixture(NEST_READY_DESIGN.name).files);
  assert.match(files['vitest.config.ts'], /exclude: \['test\/integration\/\*\*'/);
  const pkg = JSON.parse(files['package.json']);
  assert.equal(pkg.scripts['test:integration'], 'vitest run --config vitest.integration.config.ts');
  assert.match(pkg.scripts['check:architecture'], /depcruise src test\/integration /);
  const rule = JSON.parse(files['.dependency-cruiser.json']).forbidden.find((r) => r.name === 'flujos-caja-negra');
  assert.deepEqual(rule.from, { path: '^test/integration/', pathNot: '^test/integration/support/' });
  assert.deepEqual(rule.to, { path: '^src/' });
});

test('el humo del arnés cubre lo que el diseño tiene: reset, base y API', () => {
  const smoke = byPath(planFixture(NEST_READY_DESIGN.name).files)['test/integration/harness-smoke.test.ts'];
  for (const id of ['SMOKE-1', 'SMOKE-2', 'SMOKE-3', 'SMOKE-4']) assert.match(smoke, new RegExp(`'${id}:`));
  // Sin persistencia no hay reset ni base que sondear.
  const bare = byPath(planFixture(NEST_READY_DESIGN.name, { withoutLayers: ['persistence'] }).files);
  const bareSmoke = bare['test/integration/harness-smoke.test.ts'];
  assert.doesNotMatch(bareSmoke, /SMOKE-1|SMOKE-3/);
  assert.match(bareSmoke, /SMOKE-2/);
  assert.equal(bare['infra/reset-db.sh'], undefined);
  assert.doesNotMatch(bare['test/integration/support/flow.ts'], /export function (resetState|db)\(/);
});

test('el baseline de migraciones: build deja el mecanismo y develop/production aplican las migraciones', () => {
  const files = byPath(planFixture(NEST_READY_DESIGN.name).files);
  for (const file of ['src/infrastructure/persistence/schema-baseline.ts', 'infra/export-schema.sh', 'infra/verify-baseline.sh', 'src/migrations/README.md']) {
    assert.ok(file in files, `${file} se emite`);
  }
  assert.equal(files['migrations/README.md'], undefined, 'las migraciones viven en src/ (compilan a dist/migrations)');
  const yamlOf = (profile) => Object.entries(files).find(([file]) => file.startsWith(`config/parameters/${profile}/`) && /migrations-run/.test(files[file]))?.[1] ?? '';
  assert.match(yamlOf('local'), /migrations-run: false/);
  assert.match(yamlOf('develop'), /migrations-run: true/);
  assert.match(yamlOf('production'), /migrations-run: true/);
  // El baseline se exporta y se verifica sobre un esquema VACÍO: los dos scripts lo vacían antes.
  for (const script of ['infra/export-schema.sh', 'infra/verify-baseline.sh']) assert.match(files[script], /bash infra\/reset-db\.sh --schema/);
  // Sin persistencia, nada de esto.
  const bare = byPath(planFixture(NEST_READY_DESIGN.name, { withoutLayers: ['persistence'] }).files);
  assert.equal(bare['infra/export-schema.sh'], undefined);
});
