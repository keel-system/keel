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
  mountDesign(workspace, 'product-catalog');
  const before = treeDigest(workspace);
  const { exitCode, output } = await runCommand(workspace, check, 'specs/product-catalog', {});
  assert.equal(exitCode, 1);
  assert.match(output, /capa persistence/);
  assert.equal(treeDigest(workspace), before);
});
