// `keel-dotnet check` es la pasada en seco: el mismo tronco que build sin escribir NADA. La aserción que no
// se puede perder es la huella del workspace: un comando de comprobación que escribe deja de ejecutarse por
// costumbre.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, mountDesign, runCommand, DOTNET_READY_DESIGN } from './helpers/workspace.js';
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
  mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
  const before = treeDigest(workspace);
  await runCommand(workspace, check, `specs/${DOTNET_READY_DESIGN.name}`, {});
  assert.equal(treeDigest(workspace), before);
});

test('un diseño no listo sale en rojo aunque sea generable, y dice por qué', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
  const { exitCode, output } = await runCommand(workspace, check, `specs/${DOTNET_READY_DESIGN.name}`, {});
  assert.equal(exitCode, 1);
  assert.match(output, /Generable, pero no listo/);
});

test('una capa fuera de la frontera sale en rojo sin construir nada', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, 'asset-vault');
  const before = treeDigest(workspace);
  const { exitCode, output } = await runCommand(workspace, check, 'specs/asset-vault', {});
  assert.equal(exitCode, 1);
  assert.match(output, /capa storage/);
  assert.equal(treeDigest(workspace), before);
});

test('con payments, check enseña qué pasarelas del catálogo sirven el diseño, sin escribir nada', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, 'payment-checkout');
  const before = treeDigest(workspace);
  const { output: colored } = await runCommand(workspace, check, 'specs/payment-checkout', {});
  const output = colored.replace(/\[\d+m/g, '');
  assert.match(output, /Pasarelas de pago/);
  assert.match(output, /✔ stripe/);
  assert.match(output, /✔ mercadopago — \d+ sin verificar/);
  assert.equal(treeDigest(workspace), before);
});
