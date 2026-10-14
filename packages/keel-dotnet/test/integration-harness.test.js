// El arnés de integración de keel-dotnet (incremento 7): la infraestructura de prueba es la MISMA que la de
// keel-spring del mismo diseño, el script que puntúa la matriz lee el XML con los MISMOS programas, el reset respeta
// el historial de migraciones de EF Core, y el proyecto de flujos es caja negra por construcción. Lo que solo se ve
// con el SDK y contenedores —que todo eso funcione— lo mide `npm run harness-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK } from 'keel-core/gen/junit-scoring';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { SPRING_INFRA } from '../../keel-spring/src/scaffold/devtools.js';
import { DOTNET_INFRA } from '../src/scaffold/infra.js';
import { MIGRATIONS_TABLE } from '../src/scaffold/persistence-runtime.js';
import { solution } from '../src/scaffold/render.js';
import { FIXTURES_DIR, DOTNET_READY_DESIGN, fixtureNames, planFixture } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));

/**
 * Lo que un script de infra/ dice, sin lo que es de la plataforma: los comentarios, la cabecera y los textos y la
 * tabla de historial de cada generador, sustituidos por la misma marca.
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

for (const name of fixtureNames()) {
  test(`${name}: infra/ es la de keel-spring salvo los textos de la plataforma`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = byPath(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files);
    const dotnet = byPath((await planFixture(name)).files);
    const shared = ['infra/docker-compose.yaml', 'infra/up.sh', 'infra/down.sh', 'infra/docker/Dockerfile', 'infra/validate-infra.sh', 'infra/reset-db.sh'];
    for (const file of shared) {
      assert.equal(file in dotnet, file in spring, `${file}: lo emiten los dos o ninguno`);
      if (!(file in spring)) continue;
      const normalize = (content, platform, suffix) =>
        neutral(content, platform, `${manifest.service?.name ?? name}-${suffix}`).replace(/devtools:[0-9a-f]{12}/g, 'devtools:<etiqueta>');
      assert.equal(normalize(dotnet[file], DOTNET_INFRA, 'dotnet'), normalize(spring[file], SPRING_INFRA, 'spring'), file);
    }
  });
}

test('el reset respeta la tabla de historial que declara el contexto de EF Core', async () => {
  const files = byPath((await planFixture(DOTNET_READY_DESIGN.name)).files);
  const registration = Object.entries(files).find(([file]) => file.endsWith('PersistenceRegistration.cs'))?.[1] ?? '';
  assert.match(registration, new RegExp(`MigrationsHistoryTable\\("${MIGRATIONS_TABLE}"\\)`));
  assert.equal(DOTNET_INFRA.historyTable, MIGRATIONS_TABLE);
  // El comando va entre comillas simples de bash: la del literal SQL sale escapada.
  const quoted = String.raw`'\''` + MIGRATIONS_TABLE + String.raw`'\''`;
  assert.ok(files['infra/reset-db.sh'].includes(`tablename <> ${quoted}`), 'el reset excluye la tabla de historial');
  assert.doesNotMatch(files['infra/reset-db.sh'], /flyway|typeorm|\{history\}/i);
});

test('score-scenarios.sh lee la matriz con los programas compartidos y sella specs/ como keel-dotnet', async () => {
  const script = byPath((await planFixture(DOTNET_READY_DESIGN.name)).files)['infra/score-scenarios.sh'];
  assert.ok(script.includes(JUNIT_MATRIX_AWK), 'el programa de la matriz, tal cual');
  assert.ok(script.includes(JUNIT_NON_SCENARIO_AWK), 'el de las pruebas que no son escenarios, tal cual');
  assert.match(script, /no es el que escribió keel-dotnet build/);
  assert.doesNotMatch(script, /\.\/gradlew|node_modules|npm /);
  // El humo va solo y primero, por su clase.
  assert.match(script, /-class "ProductCatalog\.IntegrationTests\.HarnessSmoke"/);
});

for (const name of fixtureNames()) {
  test(`${name}: el proyecto de flujos es caja negra y queda fuera de dotnet test`, async () => {
    const { model, files } = await planFixture(name);
    const sln = solution(model);
    const csproj = byPath(files)[sln.integrationTests.csproj];
    // La única referencia es la que ordena la compilación del Api, sin ver sus tipos.
    const references = [...csproj.matchAll(/<ProjectReference [^>]*\/>/g)].map((match) => match[0]);
    assert.deepEqual(references, [`<ProjectReference Include="..\\..\\${sln.api.csproj.replaceAll('/', '\\')}" ReferenceOutputAssembly="false" />`]);
    // Fuera de dotnet test (Microsoft.Testing.Platform elige por esta propiedad), con el runner propio de xUnit.
    assert.match(csproj, /<IsTestingPlatformApplication>false<\/IsTestingPlatformApplication>/);
    // Y en la solución, para que dotnet build lo compile.
    assert.ok(byPath(files)[sln.file].includes(sln.integrationTests.csproj));
    // Ningún archivo del arnés nombra un namespace del servicio fuera del suyo.
    const harness = files.filter((file) => file.path.startsWith(`${sln.integrationTests.dir}/`) && file.path.endsWith('.cs'));
    for (const file of harness) {
      for (const [, used] of file.content.matchAll(/^using ([\w.]+);/gm)) {
        assert.ok(!used.startsWith(`${sln.root}.`) || used.startsWith(sln.integrationTests.name), `${file.path}: using ${used}`);
      }
    }
  });
}

test('el humo comprueba la fontanería que el diseño usa, y nada más', async () => {
  const files = byPath((await planFixture(DOTNET_READY_DESIGN.name)).files);
  const smoke = files['tests/ProductCatalog.IntegrationTests/HarnessSmoke.cs'];
  for (const id of ['SMOKE-1', 'SMOKE-2', 'SMOKE-3', 'SMOKE-4']) assert.match(smoke, new RegExp(`\\[Scenario\\("${id}:`));
  // Sin persistencia no hay reset ni base que sondear.
  const bare = byPath(
    (
      await planFixture(DOTNET_READY_DESIGN.name, {
        mutate: (manifest, layers) => {
          delete manifest.layers.persistence;
          delete layers.persistence;
        }
      })
    ).files
  );
  const bareSmoke = bare['tests/ProductCatalog.IntegrationTests/HarnessSmoke.cs'];
  assert.doesNotMatch(bareSmoke, /SMOKE-1|SMOKE-3/);
  assert.match(bareSmoke, /SMOKE-2/);
  assert.equal('infra/reset-db.sh' in bare, false);
  assert.doesNotMatch(bare['tests/ProductCatalog.IntegrationTests/Support/FlowTest.cs'], /ResetState|Db\(/);
});

// ── El script EJECUTADO en modo --score (sin SDK: solo lee el XML) ──

const XML = String.raw`<testsuites name="Test results" tests="5" failures="2" errors="0" disabled="0"><testsuite name="ProductCatalog.IntegrationTests.dll" tests="5" failures="2" skipped="1"><testcase name="FL-PRD-001-A: crea el producto" time="0.008000" classname="ProductCatalog.IntegrationTests.ProductCreationFlow" /><testcase name="FL-PRD-001-B: rechaza el duplicado" time="0.013000" classname="ProductCatalog.IntegrationTests.ProductCreationFlow"><failure message="Assert.Equal() Failure: Values differ&#xD;&#xA;Expected: 409&#xD;&#xA;Actual:   201">   at Rojo()</failure></testcase><testcase name="FL-PRD-002-A: no arranca" time="0.000000" classname="ProductCatalog.IntegrationTests.ProductUpdateFlow"><skipped>El flujo no llegó a arrancar: Given roto</skipped></testcase><testcase name="SMOKE-2: el servidor responde" time="0.003000" classname="ProductCatalog.IntegrationTests.HarnessSmoke" /><testcase name="ProductCatalog.IntegrationTests.ProductCreationFlow.Ayuda" time="0.003000" classname="ProductCatalog.IntegrationTests.ProductCreationFlow"><failure message="un rojo que no es escenario">   at Ayuda()</failure></testcase></testsuite></testsuites>
`;

function scoreProject(xml, { scenarios, init = null }) {
  const dir = tmpDir('keel-dotnet-score-');
  fs.mkdirSync(path.join(dir, 'infra'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'build', 'test-results', 'integration'), { recursive: true });
  return planFixture(DOTNET_READY_DESIGN.name).then(({ files, model }) => {
    const all = byPath(files);
    fs.writeFileSync(path.join(dir, 'infra', 'score-scenarios.sh'), all['infra/score-scenarios.sh']);
    fs.writeFileSync(path.join(dir, solution(model).file), all[solution(model).file]);
    fs.writeFileSync(path.join(dir, 'specs', 'validation-scenarios.md'), scenarios.map((id) => `#### ${id} — flujo\n`).join('\n'));
    fs.writeFileSync(path.join(dir, 'build', 'test-results', 'integration', 'junit.xml'), xml);
    if (init) {
      // El volcado de un flujo que no arrancó lo escribe FailureCapture con WriteIndented: una clave por línea.
      fs.mkdirSync(path.join(dir, 'build', 'keel-failures'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'build', 'keel-failures', `${init.flow}-init.json`), `{\n  "scenario": "${init.flow}-init",\n  "assertion": "${init.message}",\n  "phase": "init"\n}\n`);
    }
    // --score no borra la evidencia de la corrida que puntúa: la escribe la suite, que aquí no corre.
    const script = fs.readFileSync(path.join(dir, 'infra', 'score-scenarios.sh'), 'utf8').replace('rm -rf "$EVIDENCE"\n', '[ "${1:-}" = "--score" ] || rm -rf "$EVIDENCE"\n');
    fs.writeFileSync(path.join(dir, 'infra', 'score-scenarios.sh'), script);
    const result = spawnSync('bash', ['infra/score-scenarios.sh', '--score'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  });
}

test('score-scenarios.sh --score puntúa el XML de xUnit: OK, FALLO, OMITIDO, NO_EJERC y lo que no es escenario', async () => {
  const { status, output } = await scoreProject(XML, {
    scenarios: ['FL-PRD-001', 'FL-PRD-002', 'FL-PRD-003'],
    init: { flow: 'ProductUpdateFlow', message: 'Given roto' }
  });
  assert.equal(status, 1, output);
  assert.match(output, /OK\s+FL-PRD-001-A\s+ProductCreationFlow/);
  assert.match(output, /FALLO\s+FL-PRD-001-B\s+ProductCreationFlow\s+build\/keel-failures\/FL-PRD-001-B\.json/);
  assert.match(output, /OMITIDO\s+FL-PRD-002-A\s+ProductUpdateFlow/);
  assert.match(output, /NO_EJERC\s+FL-PRD-003/);
  assert.match(output, /ProductCreationFlow\.Ayuda\s+\(ProductCreationFlow\)\n\s+un rojo que no es escenario/);
  assert.match(output, /ProductUpdateFlow\s+\(arranque del flujo\)\n\s+Given roto/);
  assert.match(output, /RESULTADO: KO — 1 OK · 1 FALLO · 1 omitido\(s\) · 1 no ejercitado\(s\)/);
});

test('score-scenarios.sh --score sale con 0 con todo en verde, y con 2 sin nada que arbitrar', async () => {
  const green = String.raw`<testsuites><testsuite name="x"><testcase name="FL-PRD-001-A: crea" time="0.1" classname="ProductCatalog.IntegrationTests.ProductCreationFlow" /></testsuite></testsuites>`;
  const ok = await scoreProject(green, { scenarios: ['FL-PRD-001'] });
  assert.equal(ok.status, 0, ok.output);
  assert.match(ok.output, /RESULTADO: OK — 1 escenario\(s\) al 100%/);
  const empty = String.raw`<testsuites><testsuite name="x"><testcase name="SMOKE-2: vivo" time="0.1" classname="ProductCatalog.IntegrationTests.HarnessSmoke" /></testsuite></testsuites>`;
  const none = await scoreProject(empty, { scenarios: [] });
  assert.equal(none.status, 2, none.output);
  assert.match(none.output, /matriz está VACÍA/);
});
