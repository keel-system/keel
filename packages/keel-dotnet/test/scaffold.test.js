// Rasgos del proyecto que emite keel-dotnet, sobre el árbol renderizado en memoria (planService). Cada test
// nombra el rasgo que está en juego, nunca congela el árbol entero (building-a-generator.md § Fixtures). Lo
// que solo un compilador o un servidor arrancado puede juzgar lo juzga `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from 'keel-core';
import { makeWorkspace, mountDesign, DOTNET_READY_DESIGN } from './helpers/workspace.js';
import { planService } from '../src/scaffold/index.js';
import { PACKAGES } from '../src/lib/dotnet-stack.js';
import { DOTNET_SDK_BAND, TARGET_FRAMEWORK } from '../src/lib/assets.js';

function plan() {
  const workspace = makeWorkspace();
  const dir = mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
  const { manifest, layers } = loadService(dir);
  return planService({ manifest, layers, workspace });
}

const { model, files } = plan();
const byPath = new Map(files.map((file) => [file.path, file.content]));
const csFiles = files.filter((file) => file.path.endsWith('.cs'));
const xmlFiles = files.filter((file) => /\.(csproj|props|slnx)$/.test(file.path));

/**
 * ¿Está bien formado? Lo justo para cazar lo que MSBuild descarta EN SILENCIO: un comentario con dos guiones
 * seguidos (pasó: el TargetFramework llegaba vacío y la restauración fallaba sin decir por qué) y etiquetas
 * desparejadas.
 */
function xmlProblems(xml) {
  const problems = [];
  for (const [, comment] of xml.matchAll(/<!--([\s\S]*?)-->/g)) if (comment.includes('--')) problems.push(`comentario con "--": ${comment.trim().slice(0, 60)}`);
  const stack = [];
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const [tag, closing, name, selfClosing] of withoutComments.matchAll(/<(\/?)([A-Za-z][\w.]*)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) problems.push(`etiqueta desparejada: ${tag}`);
  }
  if (stack.length > 0) problems.push(`sin cerrar: ${stack.join(', ')}`);
  return problems;
}

test('todo XML emitido (proyectos, props, solución) está bien formado', () => {
  assert.ok(xmlFiles.length >= 8);
  for (const { path, content } of xmlFiles) assert.deepEqual(xmlProblems(content), [], path);
});

test('el comprobador de XML ve lo que tiene que ver (se autocomprueba)', () => {
  assert.equal(xmlProblems('<a><!-- un -- dos --></a>').length, 1);
  assert.equal(xmlProblems('<a><b></a>').length > 0, true);
  assert.deepEqual(xmlProblems('<a><b x="1" /><!-- bien --></a>'), []);
});

test('la plataforma: SDK fijado con su runner de pruebas, framework y warnings como errores', () => {
  const global = JSON.parse(byPath.get('global.json'));
  assert.deepEqual(global.sdk, { version: DOTNET_SDK_BAND, rollForward: 'latestFeature' });
  assert.equal(global.test.runner, 'Microsoft.Testing.Platform');
  const props = byPath.get('Directory.Build.props');
  assert.match(props, new RegExp(`<TargetFramework>${TARGET_FRAMEWORK}</TargetFramework>`));
  assert.match(props, /<Nullable>enable<\/Nullable>/);
  assert.match(props, /<TreatWarningsAsErrors>true<\/TreatWarningsAsErrors>/);
  assert.match(props, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/);
});

test('las versiones viven en un solo sitio: los .csproj nombran paquetes sin versión', () => {
  const central = byPath.get('Directory.Packages.props');
  for (const [, id, version] of central.matchAll(/<PackageVersion Include="([^"]+)" Version="([^"]+)"/g)) {
    assert.equal(version, PACKAGES[id]?.version, `${id}: versión distinta de dotnet-stack.js`);
  }
  for (const { path, content } of xmlFiles.filter((file) => file.path.endsWith('.csproj'))) {
    assert.doesNotMatch(content, /<PackageReference [^>]*Version=/, `${path} fija una versión`);
  }
});

test('la frontera hexagonal son las referencias entre proyectos', () => {
  const refs = (layer) =>
    [...byPath.get(`src/ProductCatalog.${layer}/ProductCatalog.${layer}.csproj`).matchAll(/<ProjectReference Include="([^"]+)"/g)].map(([, ref]) =>
      ref.split('\\').pop().replace('.csproj', '')
    );
  assert.deepEqual(refs('Domain'), []);
  assert.deepEqual(refs('Application'), ['ProductCatalog.Domain']);
  assert.deepEqual(refs('Infrastructure'), ['ProductCatalog.Application']);
  assert.deepEqual(refs('Api'), ['ProductCatalog.Infrastructure']);
  assert.doesNotMatch(byPath.get('src/ProductCatalog.Domain/ProductCatalog.Domain.csproj'), /PackageReference|FrameworkReference/);
});

test('la solución lista todos los proyectos que se emiten', () => {
  const slnx = byPath.get('ProductCatalog.slnx');
  for (const { path } of xmlFiles.filter((file) => file.path.endsWith('.csproj'))) assert.ok(slnx.includes(`Path="${path}"`), `${path} fuera de la solución`);
});

test('la configuración sigue el gradiente y las variables de los otros dos servidores', () => {
  const yaml = byPath.get('config/application.yaml');
  assert.match(yaml, /port: \$\{SERVER_PORT:8080\}/);
  assert.match(yaml, /address: \$\{SERVER_ADDRESS:0\.0\.0\.0\}/);
  assert.match(yaml, /shutdown-timeout: \$\{SHUTDOWN_TIMEOUT:30s\}/);
  const loader = byPath.get('src/ProductCatalog.Infrastructure/Config/ServiceConfiguration.cs');
  assert.match(loader, /environment\("PROFILE"\) \?\? "local"/);
  assert.match(loader, /"\$\{"/, 'el cargador busca los placeholders literales ${');
  // config/ viaja con el ejecutable, y con él a las pruebas que lo referencian.
  assert.match(byPath.get('src/ProductCatalog.Api/ProductCatalog.Api.csproj'), /config\\\*\*\\\*\.yaml" LinkBase="config" CopyToOutputDirectory/);
});

test('config/application.yaml dice lo mismo que el de keel-nest para el mismo diseño', async () => {
  const workspace = makeWorkspace();
  const dir = mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
  const { manifest, layers } = loadService(dir);
  const { planService: nestPlan } = await import('../../keel-nest/src/scaffold/index.js');
  const nest = nestPlan({ manifest, layers, workspace }).files.find((file) => file.path === 'config/application.yaml').content;
  const keys = (yaml) => yaml.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.deepEqual(keys(byPath.get('config/application.yaml')), keys(nest));
});

test('el arranque carga y valida la configuración ANTES de crear la aplicación', () => {
  const program = byPath.get('src/ProductCatalog.Api/Program.cs');
  assert.ok(program.indexOf('ServiceConfiguration.Load()') < program.indexOf('WebApplication.CreateBuilder('));
  assert.match(program, /options\.ShutdownTimeout = configuration\.Server\.ShutdownTimeout/);
  assert.match(program, /public partial class Program;/);
});

test('las sondas tienen el contrato de los otros dos: /livez y /readyz con {"status":…}', () => {
  const endpoints = byPath.get('src/ProductCatalog.Infrastructure/Health/HealthEndpoints.cs');
  assert.match(endpoints, /MapGet\("\/livez"/);
  assert.match(endpoints, /MapGet\("\/readyz"/);
  assert.match(endpoints, /"OUT_OF_SERVICE"/);
  assert.match(endpoints, /Status503ServiceUnavailable/);
});

test('todo using de un namespace del servicio apunta a uno que se emite', () => {
  const declared = new Set(csFiles.map(({ content }) => content.match(/^namespace ([\w.]+);/m)?.[1]).filter(Boolean));
  for (const { path, content } of csFiles) {
    for (const [, namespace] of content.matchAll(/^using (ProductCatalog[\w.]*);/gm)) assert.ok(declared.has(namespace), `${path}: using ${namespace}`);
  }
});

test('nada de lo emitido importa Java, Spring ni Nest', () => {
  for (const { path, content } of files) {
    assert.doesNotMatch(content, /\bjava\.|springframework|@nestjs/, path);
  }
});

test('el proyecto se llama <servicio>-dotnet y el modelo es el de keel-core/gen con la proyección C#', () => {
  assert.equal(model.service.projectName, 'product-catalog-dotnet');
  assert.equal(model.service.rootNamespace, 'ProductCatalog');
  const product = model.entities.find((entity) => entity.name === 'Product');
  assert.ok(product, 'el modelo no tiene la entidad del diseño');
  assert.ok(product.fields.every((field) => typeof field.csType === 'string'), 'algún campo sin tipo C#');
});
