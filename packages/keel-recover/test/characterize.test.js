// El paso 5 sin contenedores: el ejecutor de los escenarios de caracterización contra un legacy falso
// en memoria que se porta como el de fixture (test/helpers/stock-design.js). Lo que importa medir es
// el COMPROBADOR: que una expectativa saboteada salga en rojo con su flujo, porque un comprobador que
// nunca falla da el mismo verde que un legacy fiel. La red en vivo es `npm run characterize-check`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadCharacterized, loadProvenance, readCharacterization, resolveCharacterized } from 'keel-core';
import { tmpDir } from './helpers/tmp.js';
import { CONTRACT_MAP, PROVENANCE, SCENARIOS, fakeStock, writeStockDesign } from './helpers/stock-design.js';
import { check, forgeToken, plannedFlows, readFlowBlock, runCharacterization, runFlow, sealDocument, tally } from '../src/lib/characterize.js';
import { prepareCharacterization, writeCharacterization } from '../src/lib/characterize-legacy.js';
import { renderFidelity, routeKey, routesWithoutOperation } from '../src/lib/fidelity.js';

const marks = (scenarios = SCENARIOS) => readCharacterization(scenarios, PROVENANCE).flows;

function ctxFor(legacy, map = CONTRACT_MAP) {
  return { side: map.legacy, sideName: 'legacy', semantics: map.semantics, base: 'http://stock:4000', http: legacy.http, reset: legacy.reset, random: () => 'r'.repeat(24) };
}

async function run(scenarios = SCENARIOS, legacy = fakeStock(), map = CONTRACT_MAP) {
  return runCharacterization(ctxFor(legacy, map), plannedFlows(scenarios, marks(scenarios)));
}

const byId = (records) => Object.fromEntries(records.map((r) => [r.id, r]));

test('los flujos marcados se ejecutan; new no, porque no existe en el legacy', async () => {
  const records = await run();
  assert.deepEqual(records.map((r) => `${r.id}:${r.mark}`), ['FL-ITM-001:keep', 'FL-ITM-002:fix', 'FL-ITM-003:keep', 'FL-ITM-004:frontier']);
  assert.deepEqual(records.filter((r) => !r.ok).map((r) => [r.id, r.failures]), []);
  assert.deepEqual(tally(records), { keep: { ok: 2, total: 2 }, fix: { ok: 1, total: 1 }, frontier: { ok: 1, total: 1 } });
  // Los datos se guardan siempre, en la forma del diseño: la paridad del paso 7 compara todo.
  assert.deepEqual(byId(records)['FL-ITM-001'].steps[1].data, { items: [{ sku: 'a', quantity: 2 }] });
});

// El comprobador, falsado: cada sabotaje conserva la forma del escenario y cambia lo que afirma.
const SABOTAGES = [
  ['un status', 'FL-ITM-001', (s) => s.replace('expect: { status: created, body: { sku: a } }', 'expect: { status: ok, body: { sku: a } }'), /status 201, se esperaba 200 \(ok\)/],
  ['un valor', 'FL-ITM-001', (s) => s.replace('items.0.quantity: 2 }', 'items.0.quantity: 3 }'), /items\.0\.quantity = 2, se esperaba 3/],
  ['un miembro', 'FL-ITM-003', (s) => s.replace('{ sku: b, quantity: 0 }', '{ sku: b, quantity: 1 }'), /items = .*se esperaba \{"sameMembers"/],
  ['el defecto de un fix', 'FL-ITM-002', (s) => s.replace('legacy: { status: 422 }', 'legacy: { status: 400 }'), /status 422, se esperaba 400/],
  ['una plantilla', 'FL-ITM-001', (s) => s.replace('items.0.sku: "{{sku}}"', 'items.0.sku: "{{otro}}"'), /items\.0\.sku = "a", se esperaba "\{\{otro\}\}"/],
];

for (const [what, id, sabotage, message] of SABOTAGES) {
  test(`una expectativa saboteada (${what}) saca en rojo ${id} y solo ${id}`, async () => {
    const scenarios = sabotage(SCENARIOS);
    assert.notEqual(scenarios, SCENARIOS, 'el sabotaje tiene que aplicarse');
    const records = await run(scenarios);
    assert.deepEqual(records.filter((r) => !r.ok).map((r) => r.id), [id]);
    assert.match(byId(records)[id].failures.join('\n'), message);
  });
}

test('el orden de una lista se afirma con la lista literal y sameMembers lo ignora', async () => {
  const literal = SCENARIOS.replace('items: { sameMembers: [{ sku: b, quantity: 0 }, { sku: c, quantity: 5 }] }', 'items: [{ sku: c, quantity: 5 }, { sku: b, quantity: 0 }]');
  const records = await run(literal);
  assert.match(byId(records)['FL-ITM-003'].failures[0], /se esperaba \[\{"sku":"c"/);
});

test('sin restaurar el estado entre flujos, el verde de un flujo dependería del anterior', async () => {
  const legacy = fakeStock();
  const leaky = { ...legacy, reset: async () => ({ ok: true }) };
  const records = await run(SCENARIOS, leaky);
  assert.ok(records.some((r) => !r.ok), 'sin reset, FL-ITM-001 deja su artículo y el siguiente listado ya no es el esperado');
  const broken = { ...legacy, reset: async () => ({ ok: false, error: 'mongorestore salió con 1' }) };
  for (const r of await run(SCENARIOS, broken)) assert.match(r.failures[0], /no se pudo restaurar el estado de partida: mongorestore/);
});

test('un paso sin expectativa no es un paso sin comprobar: un 5xx lo saca en rojo', async () => {
  const legacy = fakeStock();
  const flaky = { ...legacy, http: async (req) => (req.method === 'POST' && req.body?.sku === 'b' ? { status: 500, body: 'boom' } : legacy.http(req)) };
  const records = await run(SCENARIOS, flaky);
  assert.match(byId(records)['FL-ITM-003'].failures[0], /paso 1 \(createItem\): status 500 en un paso sin expectativa/);
});

test('los defectos del flujo se dicen antes de tocar el legacy', async () => {
  const cases = [
    [SCENARIOS.replace('    legacy: { status: 422 }\n', ''), 'FL-ITM-002', /ningún paso dice qué hace el legacy/],
    [SCENARIOS.replace('  - { op: createItem, input: { sku: d, quantity: muchos }, expect: { status: created } }', '  - { op: createItem, input: { sku: d, quantity: muchos }, legacy: { status: 201 } }'), 'FL-ITM-004', /trae `legacy:`, que solo tiene sentido en un fix/],
    [SCENARIOS.replace('    expect: { status: ok, body: { items.0.quantity: muchos } }', '').replace(', expect: { status: created } }', ' }'), 'FL-ITM-004', /ningún paso afirma nada/],
    [SCENARIOS.replace('  - op: listItems\n    expect: { status: ok, body: { items.length: 1', '  - op: listItem\n    expect: { status: ok, body: { items.length: 1'), 'FL-ITM-001', /la operación listItem no está en contract-map.yaml/],
  ];
  for (const [scenarios, id, message] of cases) {
    const legacy = fakeStock();
    let calls = 0;
    const counted = { ...legacy, http: (req) => (calls++, legacy.http(req)) };
    const planned = plannedFlows(scenarios, marks(scenarios)).filter((p) => p.id === id);
    const record = await runFlow(ctxFor(counted), planned[0]);
    assert.equal(record.ok, false, id);
    assert.match(record.failures.join('\n'), message);
    if (!/listItem no está/.test(message)) assert.equal(calls, 0, 'un flujo defectuoso no se ejecuta');
  }
});

test('el bloque ```keel-flow```: uno por flujo, cerrado, YAML válido y sin un «# » que corte el sello', () => {
  const block = (body) => `FL-X-001: algo\n\n**Caracterización**: \`keep\`.\n\n${body}\n`;
  assert.match(readFlowBlock(block('nada')).error, /no trae su bloque/);
  assert.match(readFlowBlock(block('```keel-flow\nsteps: [{ op: a }]\n```\n```keel-flow\nsteps: [{ op: b }]\n```')).error, /más de un bloque/);
  assert.match(readFlowBlock(block('```keel-flow\nsteps: [{ op: a }]')).error, /no se cierra/);
  assert.match(readFlowBlock(block('```keel-flow\n# comentario\nsteps: [{ op: a }]\n```')).error, /empieza por «# »: corta el flujo/);
  assert.match(readFlowBlock(block('```keel-flow\nsteps: []\n```')).error, /keel-flow```: \/steps/);
  assert.match(readFlowBlock(block('```keel-flow\nsteps: [{ op: a, expect: { estado: 200 } }]\n```')).error, /estado/);
  assert.deepEqual(readFlowBlock(block('```keel-flow\nsteps: [{ op: a }]\n```')).flow, { steps: [{ op: 'a' }] });
});

test('las credenciales de los actores: por la propia API, forjadas con el secreto de desarrollo o ninguna', async () => {
  const secret = 'recover-sandbox-secret';
  const seen = [];
  const http = async (req) => {
    seen.push(req);
    if (req.url.endsWith('/api/users')) return { status: 200, body: { user: { token: `tok-${req.body.user.username}` } } };
    return { status: 200, body: { user: { username: 'x' } } };
  };
  const map = {
    legacy: {
      statusClasses: { ok: 200 },
      auth: { scheme: 'Token' },
      actors: {
        profile: { via: 'op', op: 'register', input: { username: '{{actor}}' }, token: 'token' },
        ghost: { via: 'forge', secret, claims: { id: '{{random}}', username: '{{actor}}' } },
        anon: { via: 'none' },
      },
      operations: {
        register: { method: 'POST', path: '/api/users', wrap: 'user', extraInput: { email: '{{username}}@x.io' }, result: 'user' },
        me: { method: 'GET', path: '/api/user', result: 'user' },
      },
    },
  };
  const planned = {
    id: 'FL-AUT-001',
    mark: 'keep',
    sha256: '0'.repeat(64),
    flow: { actors: { alice: 'profile', zed: 'ghost', nadie: 'anon' }, steps: [{ op: 'me', as: 'alice', expect: { status: 'ok' } }, { op: 'me', as: 'zed' }, { op: 'me', as: 'nadie' }] },
  };
  const record = await runFlow({ side: map.legacy, sideName: 'legacy', semantics: {}, base: 'http://x', http, reset: async () => ({ ok: true }), random: () => 'f'.repeat(24) }, planned);
  assert.deepEqual(record.failures, []);
  assert.deepEqual(seen[0].body, { user: { email: 'alice@x.io', username: 'alice' } }, 'el registro lleva lo que el lado exige y el diseño no');
  assert.equal(seen[1].headers.Authorization, 'Token tok-alice');
  const forged = seen[2].headers.Authorization.split(' ')[1];
  const [h, p, sig] = forged.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { id: 'f'.repeat(24), username: 'zed' });
  assert.equal(sig, crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'), 'firmado con el secreto de desarrollo');
  assert.equal(forged, forgeToken(secret, { id: 'f'.repeat(24), username: 'zed' }));
  assert.equal(seen[3].headers.Authorization, undefined, 'el actor sin credencial no manda cabecera');
});

test('el code solo se compara en el lado que dice dónde lo lleva', () => {
  const res = { status: 409, raw: { error: { code: 'TAKEN' } }, data: null };
  assert.deepEqual(check({ status: 409, code: 'USERNAME_TAKEN' }, res, { side: { statusClasses: {} } }), []);
  assert.deepEqual(check({ status: 409, code: 'USERNAME_TAKEN' }, res, { side: { errorCode: 'error.code' } }), ['code "TAKEN", se esperaba USERNAME_TAKEN']);
  assert.deepEqual(check({ status: 'gone' }, res, { side: { statusClasses: {} } }), ['la clase de status «gone» no tiene valor en contract-map.yaml']);
  assert.deepEqual(check({ body: { image: null } }, { status: 200, data: {} }, { side: {}, semantics: { absentIsNull: true } }), []);
  assert.equal(check({ body: { image: null } }, { status: 200, data: {} }, { side: {}, semantics: {} }).length, 1);
});

test('el sello lo lee el criterio characterized de keel-core: en verde, y un flujo tocado deja de estarlo', async () => {
  const root = tmpDir('keel-recover-characterize-');
  const { legacyDir, specDir } = writeStockDesign(root);
  fs.mkdirSync(path.join(legacyDir, 'recordings'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'recordings', 'coverage.json'), JSON.stringify([{ round: 'round-1', cumulative: { unit: 'lines', covered: 20, total: 25, files: 1 } }]));
  fs.writeFileSync(path.join(legacyDir, 'surface.yaml'), YAML.stringify({ http: { routes: [{ method: 'GET', path: '/items' }, { method: 'POST', path: '/items/' }, { method: 'GET', path: '/health' }] } }));
  fs.writeFileSync(path.join(legacyDir, 'unobserved.yaml'), YAML.stringify({ races: [{ id: 'U-1', what: 'dos altas del mismo sku', why: 'sin unicidad: no observada' }] }));

  // prepareCharacterization lee lo mismo que el comando, salvo el sandbox (que aquí no hay).
  const prep = prepareCharacterization(legacyDir);
  assert.deepEqual(prep.errors.filter((e) => !/[\\/]sandbox$/.test(e)), []);
  assert.deepEqual(prep.planned.map((p) => p.id), ['FL-ITM-001', 'FL-ITM-002', 'FL-ITM-003', 'FL-ITM-004']);
  assert.equal(prep.newFlows, 1);

  const records = await run();
  writeCharacterization(prep, records, { snapshotHash: 'abc' });
  const resolve = (scenarios) => resolveCharacterized(loadCharacterized(specDir), scenarios, readCharacterization(scenarios, loadProvenance(specDir).doc).flows, 'stock');
  const green = resolve(SCENARIOS);
  assert.deepEqual([green.passed, green.failed, green.notRun, green.changed, green.orphans, green.errors], [['FL-ITM-001', 'FL-ITM-002', 'FL-ITM-003', 'FL-ITM-004'], [], [], [], [], []]);
  assert.equal(loadCharacterized(specDir).doc.legacy.snapshot, 'abc');

  const touched = SCENARIOS.replace('**Then**: Status `201`; `sku` es `"a"`.', '**Then**: Status `201`; `sku` es `"a"` y nada más.');
  assert.deepEqual(resolve(touched).changed, ['FL-ITM-001'], 'tocar la prosa de un flujo también lo deja sin ejecutar');

  const fidelity = fs.readFileSync(path.join(legacyDir, 'FIDELITY.md'), 'utf8');
  assert.match(fidelity, /^# Fidelidad del diseño recuperado: stock ← stock @ ba04b70$/m);
  assert.match(fidelity, /\| `keep` \| \*\*2 \/ 2\*\* \|/);
  assert.match(fidelity, /\| `fix` \| \*\*1 \/ 1\*\* \|/);
  assert.match(fidelity, /\| `frontier` \| \*\*1 \/ 1\*\* \|/);
  assert.match(fidelity, /\| `new` \| no aplica \| 1 flujo/);
  assert.match(fidelity, /20\/25 líneas \(80,0 %\)/);
  assert.match(fidelity, /Rutas del legacy sin operación en el diseño\*\* \(1\)[^\n]*\n {2}- `GET \/health`/);
  assert.match(fidelity, /races: `U-1` — dos altas del mismo sku — sin unicidad/);
  assert.match(fidelity, /`fix-validation-400`: el legacy responde 422 a un alta sin sku → .*\(FL-ITM-002\)/);
  assert.match(fidelity, /\| F-UNTYPED-QUANTITY \| guarda cualquier valor/);
  assert.doesNotMatch(fidelity, /\d{4}-\d{2}-\d{2}/, 'sin fechas: determinista');
  assert.equal(fs.readdirSync(path.join(legacyDir, 'recordings', 'characterization')).length, 4);
});

test('FIDELITY.md nombra los flujos en rojo con su primer motivo', () => {
  const records = [{ id: 'FL-A-001', mark: 'keep', ok: false, failures: ['paso 1 (x): status 500', 'otro'] }];
  const md = renderFidelity({ service: 's', legacy: { name: 'l' }, records, map: { legacy: { operations: {} } } });
  assert.match(md, /\| `keep` \| \*\*0 \/ 1\*\* \|/);
  assert.match(md, /- `FL-A-001` \(keep\): paso 1 \(x\): status 500 \(y 1 más\)/);
  assert.match(md, /sin serie/);
  assert.match(md, /sin `surface.yaml` con rutas/);
});

test('una ruta del legacy es la misma con :param, {param} o barra final', () => {
  assert.equal(routeKey('get', '/api/profiles/:username/'), routeKey('GET', '/api/profiles/{name}'));
  assert.deepEqual(routesWithoutOperation({ http: { routes: [{ method: '*', path: '/x' }] } }, { legacy: { operations: {} } }), [], 'un * es un middleware, no una operación');
});

test('el sello no se escribe con un subconjunto (--only), y lleva la huella de lo ejecutado', async () => {
  const root = tmpDir('keel-recover-characterize-only-');
  const { legacyDir, specDir } = writeStockDesign(root);
  const prep = prepareCharacterization(legacyDir);
  writeCharacterization(prep, (await run()).slice(0, 1), { seal: false });
  assert.equal(loadCharacterized(specDir).present, false);
  assert.equal(fs.existsSync(path.join(legacyDir, 'FIDELITY.md')), false);
  const doc = sealDocument({ legacy: { name: 'stock', commit: null }, scenariosText: SCENARIOS, records: await run() });
  assert.deepEqual(doc.legacy, { name: 'stock' }, 'lo que no se sabe no se escribe');
  assert.ok(doc.flows.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test('el diseño se llama como su directorio, aunque no se llame como el legacy (conduit ← realworld-node)', () => {
  const root = tmpDir('keel-recover-characterize-spec-');
  const { legacyDir, specDir } = writeStockDesign(root);
  const other = path.join(root, 'specs', 'almacen');
  fs.cpSync(specDir, other, { recursive: true });
  const prep = prepareCharacterization(legacyDir, { spec: other, sandbox: false });
  assert.deepEqual([prep.name, prep.service, prep.legacy.name], ['stock', 'almacen', 'stock']);
});
