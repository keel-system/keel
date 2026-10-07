// `keel-nest check` es la pasada en seco: el mismo tronco que build sin escribir NADA. La aserción
// que no se puede perder es la huella del workspace: un comando de comprobación que escribe deja
// de ejecutarse por costumbre.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, mountDesign, runCommand, NEST_READY_DESIGN } from './helpers/workspace.js';
import { check } from '../src/commands/check.js';

function treeDigest(root) {
  const lines = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else lines.push(`${path.relative(root, full)} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  return lines.join('\n');
}

test('no escribe nada en el workspace', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
  const before = treeDigest(workspace);
  await runCommand(workspace, check, `specs/${NEST_READY_DESIGN.name}`, {});
  assert.equal(treeDigest(workspace), before);
});

test('un diseño no listo sale en rojo aunque sea generable, y dice por qué', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
  const { exitCode, output } = await runCommand(workspace, check, `specs/${NEST_READY_DESIGN.name}`, {});
  assert.equal(exitCode, 1);
  assert.match(output, /Generable, pero no listo/);
});

test('una capa fuera de la frontera sale en rojo sin construir nada', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, 'inspection-reports');
  const before = treeDigest(workspace);
  const { exitCode, output } = await runCommand(workspace, check, 'specs/inspection-reports', {});
  assert.equal(exitCode, 1);
  assert.match(output, /persistence.default.model: document/);
  assert.equal(treeDigest(workspace), before);
});

test('imprime los huecos que reportó la generación (design-gaps.yaml del proyecto -nest)', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
  const projectDir = path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'design-gaps.yaml'),
    'service: product-catalog\nversion: 0.0.1\ngenerator: keel-nest\ngaps:\n  - layer: use-cases\n    unit: createProduct\n    kind: undeclared\n    proposal: Declara el error del precio a cero.\n    source: keel-nest-code\n'
  );
  const { output } = await runCommand(workspace, check, `specs/${NEST_READY_DESIGN.name}`, {});
  assert.match(output, /Huecos que reportó la generación/);
  assert.match(output, /use-cases\.createProduct.*\[undeclared\] Declara el error del precio a cero\./);
  assert.match(output, /Son de la v0\.0\.1/, 'una versión que no es la del diseño se dice');
});
