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
  // Skills por tecnología del stack (build las instala condicionalmente en el
  // proyecto generado según keel-stack.json).
  assert.ok(fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'skills', 'README.md')), 'falta skills/README.md');
  for (const tech of ['kafka', 'rabbitmq', 'snssqs', 's3', 'redis', 'keycloak', 'cognito', 'database']) {
    const skillDir = path.join(assetsDir, 'generators', 'spring', 'skills', `keel-spring-${tech}`);
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), `falta skills/keel-spring-${tech}/SKILL.md`);
    // Progressive disclosure: cada skill trae al menos references/configuration.md.
    assert.ok(
      fs.existsSync(path.join(skillDir, 'references', 'configuration.md')),
      `falta skills/keel-spring-${tech}/references/configuration.md`
    );
  }
  // La skill de BD agrupa los seis dialectos del catálogo en references/dialects/.
  for (const dialect of ['postgresql', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'h2']) {
    assert.ok(
      fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'skills', 'keel-spring-database', 'references', 'dialects', `${dialect}.md`)),
      `falta dialects/${dialect}.md`
    );
  }
  const kafkaSkill = fs.readFileSync(
    path.join(assetsDir, 'generators', 'spring', 'skills', 'keel-spring-kafka', 'SKILL.md'),
    'utf8'
  );
  assert.ok(kafkaSkill.includes('name: keel-spring-kafka'));

  // Subagentes de la orquestación (fuente única; build los instala vía copyTree
  // y generator-docs los copia al proyecto generado).
  for (const agent of ['keel-spring-code.md', 'keel-spring-infra.md', 'keel-spring-validate.md', 'keel-spring-quality.md']) {
    assert.ok(fs.existsSync(path.join(assetsDir, '.claude', 'agents', agent)), `falta .claude/agents/${agent}`);
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
  // Los subagentes de la orquestación se instalan junto a la skill.
  for (const agent of ['keel-spring-code.md', 'keel-spring-infra.md', 'keel-spring-validate.md', 'keel-spring-quality.md']) {
    assert.ok(fs.existsSync(path.join(workspace, '.claude', 'agents', agent)), `falta .claude/agents/${agent}`);
  }
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

  // Repo autosuficiente: CLAUDE.md + architecture.md + constitution.md + skill propia + snapshot del diseño.
  assert.ok(fs.existsSync(path.join(outDir, '.claude', 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(outDir, '.claude', 'architecture.md')));
  assert.ok(fs.existsSync(path.join(outDir, '.claude', 'constitution.md')));
  assert.ok(fs.existsSync(path.join(outDir, '.claude', 'skills', 'keel-generate-spring', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(outDir, '.claude', 'conventions', 'mapping.md')));
  assert.ok(fs.existsSync(path.join(outDir, 'specs', 'service.keel.yaml')));
  assert.ok(fs.existsSync(path.join(outDir, 'specs', 'domain.keel.yaml')));

  // El snapshot de specs/ SIEMPRE se refresca (el canónico es el del workspace).
  const snapshotFile = path.join(outDir, 'specs', 'domain.keel.yaml');
  fs.writeFileSync(snapshotFile, 'desincronizado');
  await runBuild(workspace, 'specs/product-catalog');
  assert.notEqual(fs.readFileSync(snapshotFile, 'utf8'), 'desincronizado');
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
