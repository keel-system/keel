// Rasgos del proyecto que emite keel-nest, sobre el árbol renderizado en memoria (planService).
// Cada test nombra el rasgo que está en juego, nunca congela el árbol entero
// (building-a-generator.md § Fixtures). Lo que solo un compilador o un servidor arrancado puede
// juzgar lo juzga `npm run ts-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { makeWorkspace, mountDesign, NEST_READY_DESIGN } from './helpers/workspace.js';
import { planService } from '../src/scaffold/index.js';
import { NODE_ENGINE } from '../src/lib/assets.js';

function plan() {
  const workspace = makeWorkspace();
  const dir = mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
  const { manifest, layers } = loadService(dir);
  return planService({ manifest, layers, workspace });
}

const { model, files } = plan();
const byPath = new Map(files.map((file) => [file.path, file.content]));
const tsFiles = files.filter((file) => file.path.endsWith('.ts'));

test('el proyecto es ESM sobre Node 22.12+, como exige NestJS 12', () => {
  const pkg = JSON.parse(byPath.get('package.json'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, NODE_ENGINE);
  assert.match(pkg.dependencies['@nestjs/core'], /^\^12\./);
  assert.ok(pkg.devDependencies.vitest && pkg.devDependencies.vite, 'Vitest 5 necesita Vite declarada');
  const tsconfig = JSON.parse(byPath.get('tsconfig.json'));
  assert.equal(tsconfig.compilerOptions.module, 'nodenext');
  assert.equal(tsconfig.compilerOptions.strict, true);
});

test('todo import relativo lleva extensión .js (ESM con nodenext no resuelve sin ella)', () => {
  const offenders = [];
  for (const { path: file, content } of tsFiles) {
    for (const [, specifier] of content.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
      if (!specifier.endsWith('.js')) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('toda dependencia de un constructor se inyecta con @Inject explícito (sin depender de emitDecoratorMetadata)', () => {
  // Solo las clases que construye el contenedor de Nest; un valor (Decimal, WireNumber) tiene un
  // constructor normal.
  const injectable = /@(Injectable|Controller|Module|Catch)\(/;
  const offenders = [];
  for (const { path: file, content } of tsFiles.filter((entry) => injectable.test(entry.content))) {
    for (const [, params] of content.matchAll(/constructor\(([^)]*)\)/g)) {
      for (const param of params.split(',').map((p) => p.trim()).filter(Boolean)) {
        if (!param.startsWith('@Inject(')) offenders.push(`${file}: ${param}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('la configuración sigue el gradiente y las variables del servidor de keel-spring', () => {
  const yaml = byPath.get('config/application.yaml');
  assert.match(yaml, /port: \$\{SERVER_PORT:8080\}/);
  assert.match(yaml, /shutdown-timeout: \$\{SHUTDOWN_TIMEOUT:30s\}/);
  assert.match(byPath.get('src/infrastructure/config/configuration.ts'), /env\.PROFILE \?\? 'local'/);
});

test('el arranque carga y valida la configuración ANTES de crear la aplicación, y apaga en orden', () => {
  const main = byPath.get('src/main.ts');
  assert.ok(main.indexOf('loadConfiguration()') < main.indexOf('NestFactory.create'));
  // Fastify escucha por defecto solo en 127.0.0.1: la dirección tiene que pasarse.
  assert.ok(main.includes('app.listen(configuration.server.port, configuration.server.address)'));
  assert.match(main, /app\.enableShutdownHooks\(\)/);
});

test('las sondas tienen el contrato de keel-spring: /livez y /readyz con {"status":…}', () => {
  const controller = byPath.get('src/infrastructure/health/health.controller.ts');
  assert.match(controller, /@Get\('livez'\)/);
  assert.match(controller, /@Get\('readyz'\)/);
  assert.match(controller, /status: 'OUT_OF_SERVICE'/);
  assert.match(controller, /HttpStatus\.SERVICE_UNAVAILABLE/);
});

test('nada de lo emitido importa Java ni Spring', () => {
  for (const { path: file, content } of files) {
    assert.doesNotMatch(content, /\bjava\.|springframework|@Autowired/, file);
  }
});

test('el proyecto se llama <servicio>-nest y el modelo es el de keel-core/gen con la proyección TS', () => {
  assert.equal(model.service.projectName, 'product-catalog-nest');
  assert.equal(path.basename(model.service.projectName), 'product-catalog-nest');
  const product = model.entities.find((entity) => entity.name === 'Product');
  assert.ok(product, 'el modelo no tiene la entidad del diseño');
  assert.ok(product.fields.every((field) => typeof field.tsType === 'string'), 'algún campo sin tipo TS');
  assert.ok(product.fields.every((field) => field.javaType === undefined), 'se coló un tipo Java');
});

test('la prueba del contrato del cable trae TODOS los casos de keel-core/gen/wire.js', async () => {
  const { WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS } = await import('keel-core/gen/wire');
  const emitted = byPath.get('test/wire-contract.test.ts');
  for (const entry of [...WIRE_OUTPUT_CASES, ...WIRE_INPUT_CASES, ...WIRE_REJECTED_INPUTS]) {
    assert.ok(emitted.includes(`"id": "${entry.id}"`), `falta el caso ${entry.id}`);
  }
});

test('dominio y aplicación no importan el framework ni la plataforma HTTP', () => {
  const inner = tsFiles.filter((file) => /^src\/(domain|application)\//.test(file.path));
  assert.ok(inner.length >= 3, 'el contrato del cable vive en domain/ y application/');
  for (const { path: file, content } of inner) {
    assert.doesNotMatch(content, /from '(@nestjs\/|fastify)/, file);
  }
});
