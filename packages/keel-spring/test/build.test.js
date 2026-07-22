import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/commands/build.js';
import { assetsDir, SUPPORTED_DSL } from '../src/lib/assets.js';

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-spring-'));
  // Marcador de workspace Keel (isKeelWorkspace)
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}');
  return dir;
}

function writeService(workspace, { keel = '2.0' } = {}) {
  const dir = path.join(workspace, 'specs', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'service.keel.yaml'),
    [
      `keel: "${keel}"`,
      'service:',
      '  name: demo',
      '  version: 0.1.0',
      '  description: "TODO: describir"',
      'layers:',
      '  domain: domain.keel.yaml',
      '  use-cases: use-cases.keel.yaml',
      ''
    ].join('\n')
  );
  fs.writeFileSync(path.join(dir, 'domain.keel.yaml'), 'entities: {}\n');
  fs.writeFileSync(path.join(dir, 'use-cases.keel.yaml'), 'operations: {}\n');
  return dir;
}

async function runBuild(workspace, inputPath, options) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const silenced = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await build(inputPath, options);
    return process.exitCode;
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, silenced);
  }
}

test('los assets del generador existen en el paquete', async () => {
  assert.ok(fs.existsSync(path.join(assetsDir, '.claude', 'skills', 'keel-generate-spring', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'README.md')));
  // Referencias por tecnología del stack (las consume el agente según keel-stack.json).
  for (const ref of ['README.md', 'kafka.md', 'rabbitmq.md', 'snssqs.md', 's3.md', 'redis.md', 'keycloak.md', 'cognito.md']) {
    assert.ok(fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'references', ref)), `falta references/${ref}`);
  }
});

test('build rechaza una versión de DSL no soportada sin copiar assets', async () => {
  const workspace = makeWorkspace();
  writeService(workspace, { keel: '9.0' });
  assert.ok(!SUPPORTED_DSL.includes('9.0'));

  const exitCode = await runBuild(workspace, 'specs/demo');
  assert.equal(exitCode, 1);
  assert.ok(!fs.existsSync(path.join(workspace, '.claude', 'skills', 'keel-generate-spring')));
});

test('build copia skill y conventions, y falla la validación de un diseño en plantilla', async () => {
  const workspace = makeWorkspace();
  writeService(workspace);

  const exitCode = await runBuild(workspace, 'specs/demo');
  assert.equal(exitCode, 1); // diseño incompleto: no generable todavía
  assert.ok(fs.existsSync(path.join(workspace, '.claude', 'skills', 'keel-generate-spring', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(workspace, 'generators', 'spring', 'conventions', 'mapping.md')));
});

test('build con un diseño válido genera el scaffolding y sale con éxito', async () => {
  const workspace = makeWorkspace();
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product-catalog');
  const specDir = path.join(workspace, 'specs', 'product-catalog');
  fs.mkdirSync(specDir, { recursive: true });
  fs.cpSync(fixture, specDir, { recursive: true });

  const exitCode = await runBuild(workspace, 'specs/product-catalog');
  assert.equal(exitCode, undefined); // éxito
  const outDir = path.join(workspace, 'services', 'product-catalog-spring');
  assert.ok(fs.existsSync(path.join(outDir, 'build.gradle')));
  assert.ok(fs.existsSync(path.join(outDir, 'gradlew')));
  assert.ok(fs.existsSync(path.join(outDir, 'src', 'main', 'java', 'com', 'commerce', 'productcatalog', 'domain', 'aggregate', 'Product.java')));

  // El cuestionario (sin TTY → defaults) queda persistido en keel-stack.json.
  const stackFile = path.join(outDir, 'keel-stack.json');
  assert.ok(fs.existsSync(stackFile));
  const stack = JSON.parse(fs.readFileSync(stackFile, 'utf8'));
  assert.equal(stack.database, 'postgresql');
  assert.equal(stack.broker, null); // la fixture no declara messaging

  // Segunda pasada: reutiliza el stack guardado (aunque se edite a mano).
  fs.writeFileSync(stackFile, JSON.stringify({ database: 'mysql', broker: null, auth: null, cache: null }, null, 2));
  await runBuild(workspace, 'specs/product-catalog');
  assert.equal(JSON.parse(fs.readFileSync(stackFile, 'utf8')).database, 'mysql');

  // Segunda pasada: el scaffolding no pisa lo existente.
  const marker = path.join(outDir, 'README.md');
  fs.writeFileSync(marker, 'editado');
  await runBuild(workspace, 'specs/product-catalog');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'editado');
});

test('build es idempotente: la segunda pasada no reescribe los assets', async () => {
  const workspace = makeWorkspace();
  writeService(workspace);
  await runBuild(workspace, 'specs/demo');

  const skillPath = path.join(workspace, '.claude', 'skills', 'keel-generate-spring', 'SKILL.md');
  fs.writeFileSync(skillPath, 'modificado localmente');
  await runBuild(workspace, 'specs/demo');
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'modificado localmente');

  await runBuild(workspace, 'specs/demo', { force: true });
  assert.notEqual(fs.readFileSync(skillPath, 'utf8'), 'modificado localmente');
});
