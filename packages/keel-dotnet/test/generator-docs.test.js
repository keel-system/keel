// El conocimiento del generador dentro del proyecto (incremento 7c): la skill orquestadora, los cinco agentes, las
// convenciones y la skill de la base, proyectados a cada harness. Lo que se mide es lo que se rompe en silencio: un
// asset que existe y nadie instala, un token sin resolver que el agente lee literal, una doc compartida que cita la
// ruta de UN harness, y —lo que más cuesta— una ruta o una firma que la doc enseña y build no emite: el agente
// escribiría contra algo inventado.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES } from 'keel-core';
import { AGENTS, CONVENTIONS, GUIDES, DOCS_DIR } from '../src/scaffold/generator-docs.js';
import { solution } from '../src/scaffold/render.js';
import { SKILL } from '../src/lib/assets.js';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { DOTNET_READY_DESIGN, FIXTURES_DIR, planFixture } from './helpers/workspace.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const plan = await planFixture(DOTNET_READY_DESIGN.name);
const files = byPath(plan.files);
const sln = solution(plan.model);

/** Todos los markdown de assets/ (agentes, guías, convenciones, skills), recursivo. */
function assetSources(dir = assets) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? assetSources(full) : entry.name.endsWith('.md') ? [full] : [];
  });
}

test('todo agente y toda convención de assets/ se instala (las listas son el único punto de instalación)', () => {
  assert.deepEqual([...AGENTS].sort(), fs.readdirSync(path.join(assets, 'agents')).sort());
  assert.deepEqual([...CONVENTIONS].sort(), fs.readdirSync(path.join(assets, 'generators', 'dotnet', 'conventions')).sort());
  for (const name of [...GUIDES, ...CONVENTIONS.map((c) => `conventions/${c}`), 'framework-errors.md', 'wire-contract.md']) {
    assert.ok(`${DOCS_DIR}/${name}` in files, `${name} se emite en ${DOCS_DIR}/`);
  }
});

test('cada harness recibe su contexto, la skill orquestadora, los cinco agentes y la skill de la base', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.contextFile in files, `${harness.id}: ${harness.contextFile}`);
    assert.ok(harness.skillPath(SKILL, 'SKILL.md') in files, `${harness.id}: skill orquestadora`);
    assert.ok(harness.skillPath('keel-dotnet-database', 'SKILL.md') in files, `${harness.id}: skill de la base`);
    assert.ok(harness.skillPath('keel-dotnet-database', 'references/migrations.md') in files, `${harness.id}: sus referencias`);
    for (const agent of AGENTS) {
      const name = agent.replace(/\.md$/, '');
      assert.ok(Object.keys(files).some((file) => file.includes(name) && !file.startsWith(DOCS_DIR)), `${harness.id}: agente ${name}`);
    }
  }
});

test('ningún archivo emitido deja un token {{keel:…}} sin resolver', () => {
  const leftovers = Object.entries(files).filter(([, content]) => /\{\{keel:\w+\}\}/.test(content)).map(([file]) => file);
  assert.deepEqual(leftovers, []);
});

test('las docs compartidas y los assets no citan la ruta ni el archivo de contexto de un harness concreto', () => {
  const harnessPaths = /\.claude\/|\.opencode\/|CLAUDE\.md|AGENTS\.md/;
  for (const [file, content] of Object.entries(files)) {
    if (file.startsWith(`${DOCS_DIR}/`)) assert.doesNotMatch(content, harnessPaths, file);
  }
  for (const source of assetSources()) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\.claude\/|\.opencode\//, path.relative(assets, source));
});

test('los agentes son hojas: ninguno puede lanzar subagentes', () => {
  for (const agent of AGENTS) {
    assert.match(fs.readFileSync(path.join(assets, 'agents', agent), 'utf8'), /^spawns: false$/m, agent);
  }
});

test('la skill de la base y el baseline solo se instalan con persistencia relacional', async () => {
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
  assert.ok(!Object.keys(bare).some((file) => file.includes('keel-dotnet-database')));
  assert.equal('infra/verify-baseline.sh' in bare, false);
  const skill = bare[HARNESSES[0].skillPath(SKILL, 'SKILL.md')];
  assert.doesNotMatch(skill, /baseline/i);
});

// Una ruta que la documentación cita y build no emite manda al agente a buscar algo que no existe. Se comprueban
// todas las de los assets contra lo que build emite para el diseño de referencia: las que llevan un marcador
// (`<Flujo>Flow.cs`) son plantillas y no se miran; `<Raíz>` se sustituye por la raíz del servicio.
test('cada ruta src/, tests/ e infra/ que citan los assets existe en lo que emite build', () => {
  // Lo de infra/ no lleva el nombre del servicio: vale también lo que emiten los diseños con seguridad (el realm de
  // prueba, sus credenciales y el emulador de Cognito), que las guías comunes citan para cuando el diseño lo pide.
  const securityInfra = Object.values(SKILL_SUBJECTS).flatMap(({ fixtures, auth }) =>
    fixtures.flatMap((fixture) => planWith(fixture, auth).files.map((file) => file.path).filter((route) => route.startsWith('infra/')))
  );
  const emitted = [...Object.keys(files), ...securityInfra];
  // Lo que crea otro después: las migraciones (el pase de calidad), la salida de compilación y las pruebas de flujo
  // (el agente de pruebas; `<Flujo>Flow.cs` en los ejemplos).
  const createdLater = [`${sln.infrastructure.dir}/Persistence/Migrations`, `${sln.integrationTests.dir}/bin/`];
  const agentFlow = new RegExp(`^${sln.integrationTests.dir}/\\w+Flow\\.cs$`);
  const missing = [];
  for (const source of assetSources()) {
    // Las skills de un proveedor de identidad citan lo que build emite CON seguridad: se miden contra su diseño.
    const target = Object.entries(SKILL_SUBJECTS).find(([skill]) => source.includes(`${path.sep}${skill}${path.sep}`))?.[1];
    if (target) continue;
    missing.push(...missingRoutes(source, sln, emitted, createdLater, agentFlow));
  }
  for (const [skill, subject] of Object.entries(SKILL_SUBJECTS)) {
    // La skill vale para cualquier diseño con ese proveedor: una ruta cuenta si la emite alguno de sus sujetos.
    const plans = subject.fixtures.map((fixture) => planWith(fixture, subject.auth));
    for (const source of assetSources(path.join(assets, 'generators', 'dotnet', 'skills', skill))) {
      const perSubject = plans.map(({ model, files: subjectFiles }) => missingRoutes(source, solution(model), subjectFiles.map((file) => file.path), [], agentFlow));
      // Lo que falta en TODOS (por la ruta citada, que no depende del nombre del servicio salvo por <Raíz>).
      const routeOf = (entry) => entry.split(' → ')[1].replace(/^(src|tests)\/[A-Za-z]+\./, '$1/<Raíz>.');
      const everywhere = perSubject[0].filter((entry) => perSubject.every((list) => list.some((other) => routeOf(other) === routeOf(entry))));
      missing.push(...everywhere);
    }
  }
  assert.deepEqual(missing, []);
});

/** Las skills que solo se instalan con un stack, y el diseño y el stack contra los que se miden sus rutas. */
const SKILL_SUBJECTS = {
  'keel-dotnet-keycloak': { fixtures: ['profile-directory', 'asset-vault'], auth: 'keycloak' },
  'keel-dotnet-cognito': { fixtures: ['profile-directory', 'asset-vault'], auth: 'cognito' }
};

function planWith(fixture, auth) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } });
}

/** Las rutas src/, tests/ e infra/ que cita un asset y no están en lo emitido. */
function missingRoutes(source, solutionOf, emitted, createdLater, agentFlow) {
  const missing = [];
  const text = fs.readFileSync(source, 'utf8').replaceAll('<Raíz>', solutionOf.root);
  for (const [cited] of text.matchAll(/\b(?:src|tests|infra)\/[\w./-]+/g)) {
    const route = cited.replace(/[.,:;]+$/, '');
    if (route.includes('<') || createdLater.some((later) => route.startsWith(later)) || agentFlow.test(route)) continue;
    const exists = emitted.includes(route) || emitted.some((file) => file.startsWith(route.endsWith('/') ? route : `${route}/`));
    if (!exists) missing.push(`${path.relative(assets, source)} → ${route}`);
  }
  return missing;
}

// Los símbolos y firmas que la documentación ENSEÑA a usar, contra el código emitido.
test('los tipos y miembros que enseñan las convenciones son los del código emitido', () => {
  const find = (suffix) => Object.entries(files).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.match(find('Domain/Support/Decimals.cs'), /public static decimal SetScale\(decimal value, int scale, MidpointRounding rounding = MidpointRounding\.AwayFromZero\)/);
  assert.match(find('Domain/Repository/Page.cs'), /record Page<T>\(IReadOnlyList<T> Items, int Number, int Size, long TotalElements, int TotalPages\)/);
  assert.match(find('Application/Dtos/PagedResponse.cs'), /required IReadOnlyList<T> Items[\s\S]*required int Page[\s\S]*required int Size[\s\S]*required long TotalElements[\s\S]*required int TotalPages/);
  assert.match(find('Domain/Aggregate/Product.cs'), /private void TransitionTo\(ProductStatus target\)/);
  assert.match(find('Domain/Aggregate/Product.cs'), /public sealed class ProductState/);
  assert.match(find('Domain/ValueObject/SKUFormat.cs'), /public static void Validate\(string\? value\)/);
  assert.match(find('Domain/Errors/ProductAlreadyRetiredError.cs'), /ProductAlreadyRetiredError\(string message\)/);
  assert.match(find('Infrastructure/Config/ServiceConfiguration.cs'), /public string\? Get\(string/);
  assert.match(find('Persistence/Repositories/ProductRepository.cs'), /ProductRepository\(ProductCatalogDbContext db,/);
  assert.match(find('Persistence/Repositories/ProductRepository.cs'), /private IQueryable<ProductRow> Graph\(\)/);
  for (const symbol of ['UseCaseRegistration', 'IUseCaseTransactions', 'PersistenceErrors', 'ApiErrorMiddleware', 'ApiRoutes', 'WireJson', 'RowValues']) {
    assert.ok(Object.keys(files).some((file) => file.endsWith(`/${symbol}.cs`)), `${symbol}.cs`);
  }
  // El arnés: lo que integration-tests.md y el agente de pruebas enseñan.
  const flowTest = files[`${sln.integrationTests.dir}/Support/FlowTest.cs`];
  for (const member of ['protected virtual Task GivenAsync()', 'public const string RouteBase', 'protected static void AssertJson(string expected, FlowResponse response)', 'protected static string Db(string sql)', 'protected static void ResetState()', 'protected static Task Eventually(', 'protected static string BaseUrl']) {
    assert.ok(flowTest.includes(member), member);
  }
  for (const verb of ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Exchange']) assert.match(flowTest, new RegExp(`protected static Task<FlowResponse> ${verb}\\(`));
  const response = files[`${sln.integrationTests.dir}/Support/FlowResponse.cs`];
  for (const member of ['public int Status', 'public string Body', 'public string? Header(string name)', 'public JsonElement Json()']) assert.ok(response.includes(member), member);
  assert.match(files[`${sln.integrationTests.dir}/Support/ScenarioOrder.cs`], /public ScenarioAttribute\(string title,/);
  for (const shape of ['"<uuid>"', '"<instant>"', '"<any>"']) assert.ok(files[`${sln.integrationTests.dir}/Support/JsonShape.cs`].includes(shape), shape);
});

test('el Optional de un PATCH tiene el miembro que enseña mapping.md', async () => {
  // Ninguna operación de product-catalog es un PATCH: la de catalog-extended sí.
  const extended = byPath((await planFixture('catalog-extended')).files);
  const optional = Object.entries(extended).find(([file]) => file.endsWith('/Optional.cs'))?.[1] ?? '';
  assert.match(optional, /public bool IsPresent \{ get; \}/);
  assert.match(optional, /public T Value =>/);
  assert.match(fs.readFileSync(path.join(assets, 'generators', 'dotnet', 'conventions', 'mapping.md'), 'utf8'), /`IsPresent`/);
});

test('la skill orquestadora enseña los comandos de esta plataforma, no los de otra', () => {
  for (const harness of HARNESSES) {
    const skill = files[harness.skillPath(SKILL, 'SKILL.md')];
    assert.match(skill, /bash infra\/score-scenarios\.sh/);
    assert.match(skill, /bash infra\/check-flows\.sh/);
    assert.match(skill, /dotnet ef migrations add Baseline --project src\/ProductCatalog\.Infrastructure --output-dir Persistence\/Migrations/);
    assert.match(skill, new RegExp(`-class "${sln.integrationTests.name}\\.HarnessSmoke"`));
    assert.doesNotMatch(skill, /npm |gradlew|vitest|check:architecture/i);
  }
});
