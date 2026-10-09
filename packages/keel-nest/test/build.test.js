// La puerta y la escritura de `keel-nest build`. La puerta es la de keel-core/gen (la misma que la
// de keel-spring) y aquí se afirma que keel-nest la usa de verdad: un diseño no listo no se genera
// sin --accept-unready, una capa fuera de la frontera no se genera nunca, y una segunda pasada no
// pisa nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, mountDesign, mountOutsideFrontier, runCommand, NEST_READY_DESIGN } from './helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { packageVersion } from '../src/lib/assets.js';

const SPEC = `specs/${NEST_READY_DESIGN.name}`;
const projectOf = (workspace) => path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);

async function generated(options = {}) {
  const workspace = makeWorkspace();
  mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
  const result = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, ...options });
  return { workspace, project: projectOf(workspace), ...result };
}

test('genera el proyecto en services/<servicio>-nest con su manifiesto, su stack y el snapshot sellado', async () => {
  const { project, exitCode } = await generated();
  assert.equal(exitCode, undefined);
  for (const file of [
    'package.json',
    'tsconfig.json',
    'src/main.ts',
    'src/app.module.ts',
    'config/application.yaml',
    'test/application.test.ts',
    'keel-stack.json',
    'keel-generated.json',
    'specs.sha256',
    'specs/service.keel.yaml',
    'CLAUDE.md',
    'AGENTS.md',
    '.claude/skills/keel-generate-nest/SKILL.md',
    '.opencode/skills/keel-generate-nest/SKILL.md'
  ]) {
    assert.ok(fs.existsSync(path.join(project, file)), `falta ${file}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'keel-generated.json'), 'utf8'));
  assert.equal(manifest.generator, `keel-nest@${packageVersion()}`);
  // El diseño no está listo y se generó a sabiendas: queda estampado, como en keel-spring.
  assert.equal(manifest.design.acceptedUnready, true);
  assert.ok(Object.keys(manifest.files).includes('src/main.ts'));
});

test('un diseño no listo NO se genera sin --accept-unready, y no se escribe nada', async () => {
  const { workspace, exitCode, output } = await generated({ acceptUnready: false });
  assert.equal(exitCode, 1);
  assert.match(output, /Diseño no listo para generar/);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('lo que está fuera de la frontera se rechaza nombrando keel-nest, antes de escribir nada', async () => {
  const workspace = makeWorkspace();
  // Desde el 13j todas las fixtures entran: el diseño se deriva con lo único que keel-nest todavía rechaza.
  const spec = await mountOutsideFrontier(workspace);
  const { exitCode, output } = await runCommand(workspace, build, spec, { defaults: true, acceptUnready: true });
  assert.equal(exitCode, 1);
  assert.match(output, /capacidades que keel-nest no genera/);
  assert.match(output, /calls.cancelStock: refund es un value object compuesto/);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('la telemetría pedida por flag se rechaza antes de escribir', async () => {
  const { workspace, exitCode, output } = await generated({ telemetry: 'otel' });
  assert.equal(exitCode, 1);
  assert.match(output, /keel-nest todavía no genera telemetría/);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('una segunda pasada no pisa lo que ya existe, y --check dice que está al día', async () => {
  const { workspace, project } = await generated();
  const main = path.join(project, 'src', 'main.ts');
  fs.appendFileSync(main, '// tocado por el agente\n');
  const again = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true });
  assert.equal(again.exitCode, undefined);
  assert.match(fs.readFileSync(main, 'utf8'), /tocado por el agente/);
  const checked = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, check: true });
  assert.equal(checked.exitCode, undefined, checked.output);
  assert.match(checked.output, /al día con el generador instalado/);
});

test('un archivo del generador que se quedó atrás: --check en rojo, --refresh lo pone al día', async () => {
  const { workspace, project } = await generated();
  // Simula que el generador cambió: el registro dice que build escribió OTRA versión de ese archivo.
  const manifestFile = path.join(project, 'keel-generated.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const readme = path.join(project, 'README.md');
  fs.writeFileSync(readme, 'versión anterior del generador\n');
  const { digestOf } = await import('keel-core');
  manifest.files['README.md'] = digestOf({ content: 'versión anterior del generador\n' });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const checked = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, check: true });
  assert.equal(checked.exitCode, 1);
  assert.match(checked.output, /README\.md/);
  const refreshed = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, refresh: true });
  assert.equal(refreshed.exitCode, undefined);
  assert.notEqual(fs.readFileSync(readme, 'utf8'), 'versión anterior del generador\n');
});

test('un DSL que keel-nest no soporta se rechaza', async () => {
  const workspace = makeWorkspace();
  const spec = mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
  const manifestFile = path.join(spec, 'service.keel.yaml');
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(/^keel: .*$/m, 'keel: "2.18"'));
  const { exitCode, output } = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true });
  assert.equal(exitCode, 1);
  assert.match(output, /no soportado por keel-nest/);
});
