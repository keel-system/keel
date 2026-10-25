// Las sondas de clase que pide la superficie (src/lib/class-probes.js), y la fase explore de status, que no se cierra
// mientras quede alguna sin grabar ni descartar. La corrida de control de shop-api cerró la exploración sin mover nunca
// `product_info.product_status`, y el diseño afirmó sus transiciones leyendo el código.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { pendingClassProbes } from '../src/lib/class-probes.js';
import { recoveryStatus } from '../src/lib/status.js';
import { tmpDir } from './helpers/tmp.js';

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

const SURFACE = {
  kind: 'surface',
  schema: 1,
  data: {
    tech: 'postgresql',
    tables: [
      { name: 'users', columns: [{ name: 'id' }, { name: 'email' }], unique: [['email']] },
      { name: 'product_category', columns: [{ name: 'category_type' }], unique: [['category_type']] },
      { name: 'order_main', columns: [{ name: 'order_id' }, { name: 'order_status' }] },
      { name: 'product_info', columns: [{ name: 'product_id' }, { name: 'product_status' }] }
    ]
  }
};

/** Un legacy con la superficie de shop-api en pequeño y las grabaciones dadas, en una ronda en verde. */
function legacyWith(recordings, { exploration = null } = {}) {
  const legacy = path.join(tmpDir('keel-recover-class-'), 'legacy', 'shop-api');
  write(path.join(legacy, 'surface.yaml'), YAML.stringify(SURFACE));
  write(path.join(legacy, 'recordings', 'round-0', 'round.json'), { ok: true, criteria: [] });
  for (const recording of recordings) write(path.join(legacy, 'recordings', 'round-0', `${recording.id}.json`), recording);
  // Lo que no es exploración no cuenta: una caracterización que cambia el estado no graba su ciclo de vida.
  write(path.join(legacy, 'recordings', 'characterization', 'FL-ORD-001.json'), { id: 'FL-ORD-001', class: 'lifecycle', effects: { db: { product_info: { changed: [{ before: { product_status: 0 }, after: { product_status: 1 } }] } } } });
  if (exploration) write(path.join(legacy, 'exploration.yaml'), YAML.stringify(exploration));
  return legacy;
}

const insert = (id, cls, table) => ({ id, class: cls, effects: { db: { [table]: { added: [{}], changed: [], removed: [] } } } });
const change = (id, cls, table, column, from, to) => ({ id, class: cls, effects: { db: { [table]: { added: [], removed: [], changed: [{ before: { [column]: from }, after: { [column]: to } }] } } } });

test('un índice único en una tabla que se escribe pide su carrera; una que solo se siembra, no', () => {
  const keys = pendingClassProbes(legacyWith([insert('R0-011', 'basic', 'users')])).map((p) => p.key);
  assert.ok(keys.includes('concurrency:users'));
  assert.ok(!keys.some((key) => key.startsWith('concurrency:product_category')), 'product_category no la escribe ninguna sonda');
  const done = pendingClassProbes(legacyWith([insert('R0-011', 'basic', 'users'), insert('R0-067', 'concurrency', 'users')])).map((p) => p.key);
  assert.ok(!done.includes('concurrency:users'), 'la sonda de concurrencia que inserta en users la cumple');
});

test('una columna de estado pide una sonda de ciclo de vida que la CAMBIE; la de otra clase no basta', () => {
  const recordings = [
    insert('R0-046', 'basic', 'order_main'),
    change('R0-054', 'basic', 'order_main', 'order_status', 0, 2),
    insert('R0-057', 'basic', 'product_info')
  ];
  const pending = pendingClassProbes(legacyWith(recordings));
  const order = pending.find((p) => p.key === 'lifecycle:order_main.order_status');
  assert.match(order.why, /la cambian R0-054, pero ninguna sonda de ciclo de vida/);
  const product = pending.find((p) => p.key === 'lifecycle:product_info.product_status');
  assert.match(product.why, /ninguna sonda la ha cambiado nunca/, 'la caracterización no cuenta como exploración');
  const done = pendingClassProbes(legacyWith([...recordings, change('R0-049', 'lifecycle', 'order_main', 'order_status', 0, 1)])).map((p) => p.key);
  assert.ok(!done.includes('lifecycle:order_main.order_status'));
});

test('status no da la exploración por cerrada con sondas de clase pendientes, salvo que se descarten con su motivo', () => {
  const recordings = [insert('R0-057', 'basic', 'product_info')];
  const stopped = { date: '2026-10-23', rounds: ['round-0'], coverage: 85, reason: 'la cobertura dejó de subir' };
  const base = (exploration) => {
    const legacy = legacyWith(recordings, { exploration });
    write(path.join(legacy, 'legacy.yaml'), YAML.stringify({ kind: 'legacy', schema: 1, name: 'shop-api', repo: '../../repo' }));
    write(path.join(legacy, 'sandbox', 'verify.json'), { kind: 'verify', schema: 1, ok: true, criteria: [] });
    return recoveryStatus(legacy, { assess: () => ({ criteria: [] }) });
  };
  const open = base(null);
  assert.equal(open.phase, 'explore');
  assert.deepEqual(open.details.pending.map((p) => p.key), ['lifecycle:product_info.product_status']);
  const closed = base({ kind: 'exploration', schema: 1, stopped });
  assert.equal(closed.phase, 'explore', 'cerrar sin grabar ni descartar no basta');
  assert.match(closed.reason, /1 sonda\(s\) de clase que pide la superficie sin grabar ni descartar/);
  const waived = base({ kind: 'exploration', schema: 1, stopped, waived: [{ key: 'lifecycle:product_info.product_status', reason: 'ninguna operación mueve el estado del producto' }] });
  assert.equal(waived.phase, 'design');
});
