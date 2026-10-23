import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_FUNCTIONS, DATABASE_TECHS, databaseAdapter } from '../src/lib/db/index.js';
import { emptyDatabase } from '../src/lib/db/mongodb.js';

// La base detrás de un adaptador por motor: la interfaz completa en cada uno, y los schemas que
// aceptan un motor diciendo lo mismo que el registro (un motor en el schema sin adaptador fallaría
// en vivo; uno con adaptador fuera del schema no se podría usar).

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(fs.readFileSync(path.join(here, '..', 'assets', 'schema', `${name}.schema.json`), 'utf8'));

test('cada motor con adaptador trae la interfaz entera', () => {
  assert.ok(DATABASE_TECHS.length > 0);
  for (const tech of DATABASE_TECHS) {
    const a = databaseAdapter(tech);
    assert.equal(a.tech, tech);
    for (const fn of ADAPTER_FUNCTIONS) assert.equal(typeof a[fn], 'function', `${tech}.${fn}`);
    assert.equal(typeof a.snapshotFile, 'string');
    assert.equal(typeof a.rowNoun, 'string');
  }
  assert.equal(databaseAdapter('postgresql'), null, 'sin medir, sin adaptador');
  assert.equal(databaseAdapter('toString'), null, 'solo claves propias del registro');
});

test('sandbox.schema.json y target.schema.json aceptan exactamente los motores con adaptador', () => {
  assert.deepEqual(schema('sandbox').properties.database.properties.tech.enum, DATABASE_TECHS);
  const target = schema('target').properties.database.properties.tech;
  assert.deepEqual(target.enum ?? [target.const], DATABASE_TECHS);
});

test('mongodb: el vaciado de la paridad borra todas las colecciones menos las de sistema y cuenta lo que queda', () => {
  const sent = [];
  const rt = { exec: (c, args) => (sent.push({ c, args }), { status: 0, stdout: '0\n', stderr: '' }) };
  assert.deepEqual(emptyDatabase(rt, 'db1', 'conduit', { auth: { user: 'u', password: 'p' } }), { ok: true, remaining: '0' });
  const { c, args } = sent[0];
  assert.equal(c, 'db1');
  assert.deepEqual(args.slice(0, 8), ['mongosh', '--quiet', '-u', 'u', '-p', 'p', '--authenticationDatabase', 'admin']);
  const js = args.at(-1);
  assert.match(js, /db\.getSiblingDB\("conduit"\)/);
  assert.match(js, /indexOf\('system\.'\) !== 0/);
  assert.match(js, /deleteMany\(\{\}\)/);
  assert.match(js, /countDocuments\(\{\}\)/);
  const rtLeft = { exec: () => ({ status: 0, stdout: '3\n', stderr: '' }) };
  assert.deepEqual(emptyDatabase(rtLeft, 'db1', 'conduit'), { ok: true, remaining: '3' });
});
