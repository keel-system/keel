// Corrida order de prueba-gelsa (G5 y G6) en keel-go, sobre la silueta `catalog-gelsa-order` (UNCOVERED_BRANCHES): la
// retirada de catalog-extended pasada a `acknowledgement` y la réplica del precio con `keyField: id`.
//
// G5: una operación que encarga una activación HTTP y la deja esperando (`awaitingSince`, `awaits: acknowledgement`)
// confirma la espera ANTES de llamar, así que el endpoint la despacha con `application.WithoutTransaction`. La decisión y
// la nota son de keel-core (`gen/outbound-boundary.js`); aquí se mira que keel-go las aplique en las mismas operaciones
// que los otros tres y con la misma nota.
//
// G6: keel-core ya no mete la identidad en la clave natural. Aquí se mira que keel-go busque la copia por FindByID (lo
// hacía por la clave natural de persistencia pasándole el id: no compilaba), que la copia NUEVA conserve el id del
// proveedor (uno nuevo crearía otra copia en cada evento) y que su lote vaya por FindAllByID, como keel-dotnet.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { FIXTURES_DIR, UNCOVERED_BRANCHES } from './helpers/workspace.js';

const gelsa = UNCOVERED_BRANCHES.find((branch) => branch.name === 'catalog-gelsa-order');

function filesOf(plan, fixture, { mutate = null, stack = null } = {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(manifest, layers);
  return plan({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
}

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';
const countOf = (text, needle) => text.split(needle).length - 1;

/** La línea del endpoint que despacha la operación. */
function dispatchLine(files, useCase) {
  const line = files
    .filter((f) => f.path.startsWith('internal/httpapi/') && !f.path.endsWith('_test.go'))
    .flatMap((f) => f.content.split('\n'))
    .find((l) => l.includes(`a.useCases.${useCase}.Handle(`));
  assert.ok(line, `ningún endpoint despacha ${useCase}`);
  return line;
}

const boundaryNote = (text) =>
  text.match(/SIN TRANSACCIÓN ABARCADORA: el mediator despacha[\s\S]*?que reconciliar/)?.[0].replace(/\s*\n\s*(\*|\/\/\/?)\s*/g, ' ');

test('G5: una activación HTTP que deja esperando se despacha sin transacción, con la nota de keel-spring y keel-dotnet', () => {
  const files = filesOf(planService, 'catalog-extended', { mutate: gelsa.mutate });
  assert.match(dispatchLine(files, 'RetireProduct'), /Handle\(application\.WithoutTransaction\(r\.Context\(\)\), cmd\)/);
  const endpoints = files.filter((f) => f.path.startsWith('internal/httpapi/') && !f.path.endsWith('_test.go')).map((f) => f.content).join('\n');
  assert.equal(countOf(endpoints, 'application.WithoutTransaction('), 1, 'solo retireProduct cambia');

  const handler = files.find((f) => f.path.startsWith('internal/application/') && f.content.includes('SIN TRANSACCIÓN ABARCADORA: el mediator despacha'));
  assert.ok(handler, 'el handler de keel-go lleva la nota');
  const go = boundaryNote(handler.content);
  assert.match(go, /compliance\.recordWithdrawal \(marca recordWithdrawalAwaitingSince\)/);
  const other = (plan, suffix) => boundaryNote(content(filesOf(plan, 'catalog-extended', { mutate: gelsa.mutate }), suffix));
  assert.equal(go, other(planSpring, '/RetireProductCommandHandler.java'), 'la misma nota que keel-spring');
  assert.equal(go, other(planDotnet, '/RetireProductCommandHandler.cs'), 'la misma nota que keel-dotnet');
});

for (const [fixture, useCase] of [
  ['catalog-extended', 'RetireProduct'],
  ['asset-vault', 'PublishAsset'],
  ['stock-reservation', 'ConfirmReservation']
]) {
  test(`G5: ${fixture}: ${useCase} (awaits: outcome o activación publicada) conserva la transacción única`, () => {
    const files = filesOf(planService, fixture);
    assert.match(dispatchLine(files, useCase), /Handle\(r\.Context\(\), /);
    assert.ok(!files.some((f) => f.content.includes('SIN TRANSACCIÓN ABARCADORA: el mediator despacha')), fixture);
  });
}

test('G6: la réplica con keyField: id se busca por FindByID, y la copia nueva lleva el id del snapshot', () => {
  const files = filesOf(planService, 'catalog-extended', { mutate: gelsa.mutate });
  const projector = content(files, 'internal/application/supplier_price_projector.go');
  assert.match(projector, /existing, found, err := p\.repository\.FindByID\(ctx, snapshot\.ID\)/);
  assert.match(projector, /\n\t\tID: +snapshot\.ID,/, 'la copia nueva conserva el id que informa el proveedor');
  assert.match(projector, /\n\t\t\tID: +existing\.ID\(\),/);
  assert.match(content(files, 'internal/application/supplier_price_reader.go'), /r\.repository\.FindByID\(ctx, id\)/);
  const port = files.find((f) => f.content.includes('type SupplierPriceRepository interface')).content;
  assert.equal(countOf(port, 'FindByID('), 1, 'un solo FindByID en el puerto');
});

test('G6: la réplica con keyField: id lee su lote por FindAllByID', () => {
  const reader = content(filesOf(planService, 'catalog-extended', { mutate: gelsa.mutate }), 'internal/application/supplier_price_reader.go');
  assert.match(reader, /ByKeys\(ctx context\.Context, ids \[\]uuid\.UUID\)[^\n]*\{\n\tcopies, err := r\.repository\.FindAllByID\(ctx, ids\)/);
  assert.match(reader, /byKey\[found\.ID\(\)\] = found/);
});

test('G6: con la clave natural de siempre nada cambia: la copia se busca por sku y nace con id nuevo', () => {
  const projector = content(filesOf(planService, 'catalog-extended'), 'internal/application/supplier_price_projector.go');
  assert.match(projector, /p\.repository\.FindBySku\(ctx, snapshot\.Sku\)/);
  assert.doesNotMatch(projector, /ID: +snapshot\.ID/);
});
