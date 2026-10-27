// El paso 7 sin contenedores: los mismos flujos contra el legacy falso y contra un regenerado falso que
// cumple el contrato de Keel (test/helpers/stock-design.js), y la comparación de TODOS sus datos. Lo que
// importa medir es el COMPARADOR: cada sabotaje del regenerado conserva la forma y tiene que salir como
// diferencia sin declarar, porque en el inc. 1 los tres defectos del diseño recuperado no los vio ningún
// escenario y solo los vio comparar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readCharacterization } from '@keel-system/keel-core';
import { tmpDir } from './helpers/tmp.js';
import { CONTRACT_MAP, PROVENANCE, SCENARIOS, fakeStock, fakeStockKeel, writeStockDesign } from './helpers/stock-design.js';
import { plannedFlows, runCharacterization } from '../src/lib/characterize.js';
import { prepareCharacterization, writeCharacterization } from '../src/lib/characterize-legacy.js';
import { TARGET_MARKS, compareRecords, flatten, parityVerdict, renderParity } from '../src/lib/parity.js';
import { prepareParity, writeParity } from '../src/lib/parity-target.js';

const marks = readCharacterization(SCENARIOS, PROVENANCE).flows;
const ctx = (fake, side, sideName) => ({ side, sideName, semantics: CONTRACT_MAP.semantics, base: 'http://x', http: fake.http, reset: fake.reset, random: () => 'r' });

async function both({ sabotage = null } = {}) {
  const legacy = await runCharacterization(ctx(fakeStock(), CONTRACT_MAP.legacy, 'legacy'), plannedFlows(SCENARIOS, marks));
  const planned = plannedFlows(SCENARIOS, marks, { marks: TARGET_MARKS });
  const target = await runCharacterization(ctx(fakeStockKeel({ sabotage }), CONTRACT_MAP.keel, 'keel'), planned);
  const comparison = compareRecords({ legacy, target, planned, map: CONTRACT_MAP });
  return { legacy, target, planned, comparison, verdict: parityVerdict(target, comparison) };
}

const red = (records) => records.filter((r) => !r.ok).map((r) => r.id);

test('el regenerado fiel: keep, fix y new en verde, el id expuesto declarado y nada sin declarar', async () => {
  const { target, comparison, verdict } = await both();
  assert.deepEqual(target.map((r) => `${r.id}:${r.mark}`), ['FL-ITM-001:keep', 'FL-ITM-002:fix', 'FL-ITM-003:keep', 'FL-ITM-004:frontier', 'FL-ITM-005:new']);
  assert.deepEqual(red(target), ['FL-ITM-004'], 'la frontera no se cumple en el regenerado, y se informa sin contar');
  assert.ok(comparison.compared >= 4);
  assert.deepEqual(comparison.undeclared, []);
  assert.ok(comparison.rows.every((r) => r.kind === 'solo-keel' && r.declared));
  assert.deepEqual(verdict, { ok: true, reasons: [] });
});

// El comparador, falsado: cada sabotaje del regenerado sale como diferencia SIN DECLARAR. El primero
// pasa todos los flujos, porque ningún escenario afirma ese campo: es exactamente el caso del `sub`
// expuesto del inc. 1. Los otros dos los ve también un keep, y la paridad tiene que verlos igual.
const SABOTAGES = [
  ['subject', 'solo-keel', 'createItem', 'subject', ['FL-ITM-004']],
  ['default', 'valor', 'listItems', 'items[].quantity', ['FL-ITM-003', 'FL-ITM-004']],
  ['second', 'solo-legacy', 'listItems', 'items[].sku', ['FL-ITM-003', 'FL-ITM-004']],
];
for (const [sabotage, kind, op, field, redFlows] of SABOTAGES) {
  test(`un regenerado saboteado (${sabotage}): la paridad lo caza como ${kind} ${op} ${field}`, async () => {
    const { target, comparison, verdict } = await both({ sabotage });
    assert.deepEqual(red(target), redFlows);
    assert.ok(comparison.undeclared.some((r) => r.kind === kind && r.op === op && r.path === field), JSON.stringify(comparison.undeclared));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reasons.join(';'), /sin declarar/);
  });
}

test('el segundo elemento de una lista cuenta (el prototipo solo comparaba el primero)', async () => {
  const { comparison } = await both({ sabotage: 'second' });
  const row = comparison.undeclared.find((r) => r.path === 'items[].sku');
  assert.deepEqual(row.flows, ['FL-ITM-003']);
  assert.deepEqual(Object.keys(flatten({ items: [{ a: 1 }, { a: 2 }] })), ['.', 'items', 'items[0].a', 'items[1].a'].filter((k) => k !== '.'));
});

test('un fix que el regenerado no corrige, o un keep que no cumple, saca el veredicto en rojo', async () => {
  const unfixed = await both({ sabotage: 'unfixed' });
  assert.deepEqual(red(unfixed.target), ['FL-ITM-002', 'FL-ITM-004']);
  assert.match(unfixed.verdict.reasons.join(';'), /fix en rojo contra el regenerado: FL-ITM-002/);
  const status = await both({ sabotage: 'status' });
  assert.match(status.verdict.reasons.join(';'), /keep en rojo contra el regenerado: FL-ITM-001$/);
});

test('un comparador sin nada que comparar no sale en verde', async () => {
  const { target, planned } = await both();
  const comparison = compareRecords({ legacy: [], target, planned, map: CONTRACT_MAP });
  assert.equal(comparison.compared, 0);
  assert.match(parityVerdict(target, comparison).reasons.join(';'), /ningún paso comparado/);
});

test('null frente a ausente es equivalente solo si el mapa lo dice, y lo volátil compara presencia y no valor', () => {
  const planned = [{ id: 'F', mark: 'keep', flow: { steps: [{ op: 'o' }] } }];
  const rec = (data) => [{ id: 'F', steps: [{ op: 'o', status: 200, data }] }];
  const cmp = (map, l, t) => compareRecords({ legacy: rec(l), target: rec(t), planned, map }).rows.map((r) => `${r.kind}:${r.path}`);
  assert.deepEqual(cmp({ semantics: { absentIsNull: true } }, {}, { image: null }), []);
  assert.deepEqual(cmp({ semantics: {} }, {}, { image: null }), ['solo-keel-null:image']);
  assert.deepEqual(cmp({ semantics: { volatile: ['(^|\\.)slug$'] } }, { slug: 'a-1' }, { slug: 'a-2' }), []);
  assert.deepEqual(cmp({ semantics: { volatile: ['(^|\\.)slug$'] } }, { slug: 'a-1' }, {}), ['solo-legacy:slug']);
  // Una diferencia declarada solo en otra operación sigue sin declarar en esta.
  const map = { declaredDifferences: [{ kind: 'solo-keel', path: '^x$', ops: ['otra'], reason: 'fix-x' }] };
  assert.equal(compareRecords({ legacy: rec({}), target: rec({ x: 1 }), planned, map }).undeclared.length, 1);
});

// shop-api: las líneas de un carrito o un pedido salían del legacy en orden aleatorio (un HashSet), y la paridad las daba
// por distintas elemento a elemento (14 de 23 diferencias). Y la consecuencia de un fix en una lectura posterior de un
// flujo se declara para ESE flujo, sin tapar la misma ruta en los demás.
test('una colección que el legacy no ordena se compara como conjunto, y una declarada puede acotarse a sus flujos', () => {
  const planned = [{ id: 'F', mark: 'keep', flow: { steps: [{ op: 'o' }] } }, { id: 'G', mark: 'keep', flow: { steps: [{ op: 'o' }] } }];
  const rec = (id, data) => ({ id, steps: [{ op: 'o', status: 200, data }] });
  const lines = (...ids) => ({ products: ids.map((productId, i) => ({ id: 100 + i, productId })) });
  const semantics = { volatile: ['(^|\\.)id$'], unordered: ['^products\\[\\]$'] };
  const cmp = (map, l, t) => compareRecords({ legacy: [rec('F', l)], target: [rec('F', t)], planned, map }).rows.map((r) => `${r.kind}:${r.path}`);
  assert.deepEqual(cmp({ semantics }, lines('F0001', 'B0005'), lines('B0005', 'F0001')), [], 'el mismo conjunto en otro orden');
  assert.ok(cmp({ semantics: { volatile: semantics.volatile } }, lines('F0001', 'B0005'), lines('B0005', 'F0001')).length > 0, 'sin declararlo, el orden cuenta');
  assert.deepEqual(cmp({ semantics }, lines('F0001', 'B0005'), lines('B0005', 'C0001')), ['valor:products[].productId'], 'un elemento distinto sigue siendo una diferencia');
  const map = { declaredDifferences: [{ kind: 'valor', path: '^x$', flows: ['F'], reason: 'fix-x en la lectura de F' }] };
  const both = compareRecords({ legacy: [rec('F', { x: 1 }), rec('G', { x: 1 })], target: [rec('F', { x: 2 }), rec('G', { x: 2 })], planned, map });
  assert.deepEqual(both.undeclared.map((r) => r.flows), [['G']], 'declarada en F, no en G');
});

test('el paso de un fix con expectativa del legacy no se compara: es la diferencia declarada', async () => {
  const { comparison } = await both({ sabotage: 'subject' });
  assert.ok(comparison.rows.every((r) => !r.flows.includes('FL-ITM-002')));
});

test('PARITY.md: la tabla de flujos de los dos lados, lo sin declarar y lo declarado por motivo', async () => {
  const { target, comparison, verdict, legacy } = await both({ sabotage: 'subject' });
  const md = renderParity({
    service: 'stock',
    legacy: { name: 'stock', commit: 'ba04b70' },
    target: { name: 'stock-nest', project: 'services/stock-nest' },
    records: target,
    legacyTally: { keep: { ok: 2, total: 2 }, fix: { ok: 1, total: 1 }, frontier: { ok: 1, total: 1 } },
    comparison,
    verdict,
  });
  assert.equal(legacy.length, 4);
  assert.match(md, /^# Paridad: stock ← stock @ ba04b70 frente a stock-nest$/m);
  assert.match(md, /\*\*Veredicto: en rojo\.\*\* .*sin declarar/);
  assert.match(md, /\| `keep` \| 2\/2 \| \*\*2\/2\*\* \|/);
  assert.match(md, /\| `fix` \| 1\/1 \(defecto presente\) \| \*\*1\/1\*\* \|/);
  assert.match(md, /\| `new` \| no aplica \| \*\*1\/1\*\* \|/);
  assert.match(md, /\| `frontier` \| 1\/1 \| 0\/1 \| informativo/);
  assert.match(md, /\| solo-keel \| createItem \| `subject` \| — \| `"u-1"` \|/);
  assert.match(md, /\| \d+ \| fix-wire: Keel expone el id del recurso \|/);
  assert.doesNotMatch(md, /\d{4}-\d{2}-\d{2}/);
});

test('parity exige la caracterización del legacy al día y en verde, y el lado keel del mapa', async () => {
  const root = tmpDir('keel-recover-parity-');
  const { legacyDir, specDir } = writeStockDesign(root);
  const targetFile = path.join(legacyDir, 'target.yaml');
  fs.writeFileSync(targetFile, YAML.stringify({ kind: 'target', schema: 1, name: 'stock-nest', base: 'http://app:3000', tool: { container: 'rec-stock-tool', network: 'stock_default' } }));
  const errorsOf = () => prepareParity(legacyDir, { targetFile }).errors;

  assert.match(errorsOf().join('\n'), /no está al día y en verde \(no hay sello;/);

  const prep = prepareCharacterization(legacyDir);
  writeCharacterization(prep, await runCharacterization(ctx(fakeStock(), CONTRACT_MAP.legacy, 'legacy'), prep.planned), { snapshotHash: 'abc' });
  assert.deepEqual(errorsOf(), []);

  // Tocar un flujo después de caracterizarlo deja la grabación del legacy sin valor.
  const scenariosFile = path.join(specDir, 'validation-scenarios.md');
  fs.writeFileSync(scenariosFile, SCENARIOS.replace('una página vacía', 'una página sin nada'));
  assert.deepEqual(errorsOf(), [], 'un flujo new no está en el sello');
  fs.writeFileSync(scenariosFile, SCENARIOS.replace('`a` con cantidad `2`', '`a` con cantidad dos'));
  assert.match(errorsOf().join('\n'), /cambiados desde la ejecución: FL-ITM-001/);
  fs.writeFileSync(scenariosFile, SCENARIOS);

  // Un `new` sin bloque keel-flow no se ejecuta en la paridad ni cuenta en rojo: la skill no lo exige (corrida de
  // control de shop-api: 19 así). Se dice en el informe.
  const NEW_BLOCK = '```keel-flow\nsteps:\n  - op: listItems\n    expect: { status: ok, body: { items.length: 0, totalElements: 0 } }\n```\n';
  assert.ok(SCENARIOS.includes(NEW_BLOCK));
  fs.writeFileSync(scenariosFile, SCENARIOS.replace(NEW_BLOCK, ''));
  const unblocked = prepareParity(legacyDir, { targetFile });
  assert.deepEqual([unblocked.errors, unblocked.unblockedNew, unblocked.planned.some((p) => p.id === 'FL-ITM-005')], [[], ['FL-ITM-005'], false]);
  fs.writeFileSync(scenariosFile, SCENARIOS);

  const { keel, ...legacyOnly } = CONTRACT_MAP;
  assert.ok(keel);
  fs.writeFileSync(path.join(legacyDir, 'contract-map.yaml'), YAML.stringify(legacyOnly));
  assert.match(errorsOf().join('\n'), /no tiene lado `keel`/);
});

test('writeParity escribe cada flujo, la comparación y PARITY-<destino>.md', async () => {
  const root = tmpDir('keel-recover-parity-write-');
  const { legacyDir } = writeStockDesign(root);
  const targetFile = path.join(legacyDir, 'target.yaml');
  fs.writeFileSync(targetFile, YAML.stringify({ kind: 'target', schema: 1, name: 'stock-nest', base: 'http://app:3000', tool: { container: 'rec-stock-tool' } }));
  const prep = prepareCharacterization(legacyDir);
  writeCharacterization(prep, await runCharacterization(ctx(fakeStock(), CONTRACT_MAP.legacy, 'legacy'), prep.planned));
  const pp = prepareParity(legacyDir, { targetFile });
  const records = await runCharacterization(ctx(fakeStockKeel(), CONTRACT_MAP.keel, 'keel'), pp.planned);
  const { verdict, written } = writeParity(pp, records);
  assert.equal(verdict.ok, true);
  assert.deepEqual(written.map((f) => path.basename(f)), ['stock-nest.json', 'PARITY-stock-nest.md']);
  assert.equal(fs.readdirSync(path.join(legacyDir, 'recordings', 'parity', 'stock-nest')).length, 5);
});
