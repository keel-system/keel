// Corrida order de prueba-gelsa (G5): una operación que encarga una activación HTTP y la deja esperando
// (`awaitingSince`, `awaits: acknowledgement`) confirma la espera ANTES de llamar, así que el endpoint la despacha sin
// transacción abarcadora. La decisión y la nota son de keel-core (`gen/outbound-boundary.js`); aquí se mira que keel-dotnet
// la aplique en las mismas operaciones que keel-spring y keel-nest y con la misma nota. Silueta: `catalog-gelsa-order`
// (UNCOVERED_BRANCHES), la retirada de catalog-extended pasada a `acknowledgement`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { FIXTURES_DIR, planFixture, UNCOVERED_BRANCHES } from './helpers/workspace.js';

const gelsa = UNCOVERED_BRANCHES.find((branch) => branch.name === 'catalog-gelsa-order');

async function filesOf(fixture, mutate = null) {
  const { files } = await planFixture(fixture, { mutate: mutate && ((manifest, layers) => mutate(manifest, layers, fixture)) });
  return files.map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
}

function otherGenerator(plan, handlerSuffix) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  gelsa.mutate(manifest, layers, 'catalog-extended');
  return plan({ manifest, layers, workspace: FIXTURES_DIR }).files.find((f) => f.path.split(path.sep).join('/').endsWith(handlerSuffix)).content;
}

/** El método del endpoint de la operación, hasta la línea que despacha. */
function dispatchOf(files, operation) {
  const endpoints = files.filter((f) => /\/Endpoints\/[^/]*Endpoints\.cs$/.test(f.path)).map((f) => f.content).join('\n');
  const start = endpoints.indexOf(`public static async Task ${operation}(HttpContext http)`);
  assert.ok(start >= 0, `ningún endpoint para ${operation}`);
  return endpoints.slice(start, endpoints.indexOf('\n', endpoints.indexOf('Mediator(http).', start)));
}

const boundaryNote = (text) =>
  text.match(/SIN TRANSACCIÓN ABARCADORA: el mediator despacha[\s\S]*?que reconciliar/)?.[0].replace(/\s*\n\s*(\*|\/\/\/?)\s*/g, ' ');

test('una activación HTTP que deja esperando se despacha sin transacción, con la nota de keel-spring y keel-nest', async () => {
  const files = await filesOf('catalog-extended', gelsa.mutate);
  assert.match(dispatchOf(files, 'RetireProduct'), /Mediator\(http\)\.DispatchWithoutTransaction\(/);
  const endpoints = files.filter((f) => /\/Endpoints\/[^/]*Endpoints\.cs$/.test(f.path)).map((f) => f.content).join('\n');
  assert.equal(endpoints.split('Mediator(http).DispatchWithoutTransaction(').length - 1, 1, 'solo retireProduct cambia');

  const handler = files.find((f) => f.path.endsWith('/RetireProductCommandHandler.cs')).content;
  const dotnet = boundaryNote(handler);
  assert.ok(dotnet, 'el handler de keel-dotnet lleva la nota');
  assert.match(dotnet, /compliance\.recordWithdrawal \(marca recordWithdrawalAwaitingSince\)/);
  assert.equal(dotnet, boundaryNote(otherGenerator(planSpring, '/RetireProductCommandHandler.java')), 'la misma nota que keel-spring');
  assert.equal(dotnet, boundaryNote(otherGenerator(planNest, '/retire-product-command-handler.ts')), 'la misma nota que keel-nest');
});

for (const [fixture, operation] of [
  ['catalog-extended', 'RetireProduct'],
  ['asset-vault', 'PublishAsset'],
  ['stock-reservation', 'ConfirmReservation']
]) {
  test(`${fixture}: ${operation} (awaits: outcome o activación publicada) conserva la transacción única`, async () => {
    const files = await filesOf(fixture);
    assert.match(dispatchOf(files, operation), /Mediator\(http\)\.Dispatch\(/);
    const handler = files.find((f) => f.path.endsWith(`/${operation}CommandHandler.cs`))?.content;
    assert.ok(handler, operation);
    assert.doesNotMatch(handler, /SIN TRANSACCIÓN ABARCADORA: el mediator/);
  });
}
