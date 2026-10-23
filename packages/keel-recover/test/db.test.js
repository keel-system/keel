import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_FUNCTIONS, DATABASE_TECHS, databaseAdapter } from '../src/lib/db/index.js';
import { emptyDatabase } from '../src/lib/db/mongodb.js';
import * as pg from '../src/lib/db/postgresql.js';

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
  assert.equal(databaseAdapter('mysql'), null, 'sin medir, sin adaptador');
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

// ── PostgreSQL, sin contenedores: el SQL que se envía y la lectura de lo que psql devuelve ──────

// Un runtime falso que responde a cada SQL según lo que pregunta (el catálogo, el volcado…).
function pgRuntime(answers) {
  const sent = [];
  return {
    sent,
    exec: (c, args, opts = {}) => {
      sent.push({ c, args, sql: opts.input ?? null });
      const hit = answers.find(([match]) => (opts.input ?? args.join(' ')).match(match));
      return hit ? { status: 0, stdout: hit[1], stderr: '' } : { status: 0, stdout: '', stderr: '' };
    },
  };
}

const CATALOG = [
  [/information_schema\.tables/, 'items\tid\nmovements\tid\nnotes\t\n'],
  [/information_schema\.sequences/, 'items_id_seq\nmovements_id_seq\n'],
];

test('postgresql: psql con el SQL por stdin, sin psqlrc, y la contraseña por entorno solo si la hay', () => {
  const rt = pgRuntime([]);
  pg.psql(rt, 'db1', { name: 'stock' }, 'select 1;');
  assert.deepEqual(rt.sent[0].args, ['psql', '-X', '-q', '-U', 'postgres', '-d', 'stock', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
  assert.equal(rt.sent[0].sql, 'select 1;');
  pg.psql(rt, 'db1', { name: 'shop', auth: { user: 'svc', password: 'p w' } }, 'select 1;');
  assert.deepEqual(rt.sent[1].args.slice(0, 6), ['env', 'PGPASSWORD=p w', 'psql', '-X', '-q', '-U']);
  assert.equal(rt.sent[1].args[6], 'svc');
  assert.equal(pg.ident('a"b'), '"a""b"');
  assert.equal(pg.literal("o'k"), "'o''k'");
});

test('postgresql: el volcado ordena cada tabla por su clave (sin ella, por la fila) y trae las secuencias', () => {
  const sql = pg.exportSql({ tables: { items: ['id'], notes: [] }, sequences: ['items_id_seq'] });
  assert.match(sql, /json_agg\(x order by x\."id"\) from "items" x/);
  assert.match(sql, /json_agg\(x order by x::text\) from "notes" x/);
  assert.match(sql, /'_sequences\.items_id_seq'.*last_value.*is_called.*from "items_id_seq"/);
  assert.match(sql, /chr\(10\), ' '\)/, 'json_agg separa con saltos de línea: se quitan');
  const doc = pg.parseExport('items\t[{"id":1,"sku":"a\\tb"}]\nnotes\t[]\n_sequences.items_id_seq\t{"name" : "items_id_seq", "last_value" : 1, "is_called" : true}\n');
  assert.deepEqual(doc, { items: [{ id: 1, sku: 'a\tb' }], notes: [], _sequences: [{ name: 'items_id_seq', last_value: 1, is_called: true }] });
});

test('postgresql: el diff casa por clave primaria, cuenta el consumo de una secuencia y no compara $keys', () => {
  const $keys = { items: ['id'], notes: [] };
  const before = { $keys, items: [{ id: 1, sku: 'a', quantity: 2 }], notes: [{ text: 'x' }], _sequences: [{ name: 's', last_value: 1, is_called: true }] };
  const after = { $keys, items: [{ id: 1, sku: 'a', quantity: 5 }, { id: 2, sku: 'b', quantity: 0 }], notes: [], _sequences: [{ name: 's', last_value: 2, is_called: true }] };
  const d = pg.dbDiff(before, after);
  assert.deepEqual(Object.keys(d), ['_sequences', 'items', 'notes']);
  assert.deepEqual(d.items.added, [{ id: 2, sku: 'b', quantity: 0 }]);
  assert.deepEqual(d.items.changed, [{ before: { id: 1, sku: 'a', quantity: 2 }, after: { id: 1, sku: 'a', quantity: 5 } }]);
  assert.deepEqual(d.notes.removed, [{ text: 'x' }], 'sin clave, la fila entera es su clave');
  assert.equal(d._sequences.changed[0].after.last_value, 2);
  assert.deepEqual(pg.dbDiff(before, before), {});
});

test('postgresql: la huella es la del contenido, secuencias incluidas, y no la de las estadísticas', () => {
  const dump = (seq) => [...CATALOG, [/json_agg/, `items\t[{"id":1}]\nmovements\t[]\nnotes\t[]\n_sequences.items_id_seq\t{"name":"items_id_seq","last_value":${seq},"is_called":true}\n_sequences.movements_id_seq\t{"name":"movements_id_seq","last_value":1,"is_called":false}\n`]];
  const rt = pgRuntime(dump(1));
  const a = pg.fingerprint(rt, 'db1', { name: 'stock' });
  const b = pg.fingerprint(pgRuntime(dump(1)), 'db1', { name: 'stock' });
  const c = pg.fingerprint(pgRuntime(dump(2)), 'db1', { name: 'stock' });
  assert.ok(a.ok && /^[0-9a-f]{32}$/.test(a.value));
  assert.equal(a.value, b.value);
  assert.notEqual(a.value, c.value, 'consumir un id cambia la huella');
  assert.ok(!rt.sent.some((s) => /pg_stat/.test(s.sql ?? '')), 'los contadores de estadísticas llegan tarde en 9.4');
});

test('postgresql: snapshot con pg_dump -Fc a un archivo y restauración con pg_restore --clean --if-exists', () => {
  const rt = pgRuntime([...CATALOG, [/json_agg/, 'items\t[]\nmovements\t[]\nnotes\t[]\n']]);
  const s = pg.takeSnapshot(rt, 'db1', { name: 'stock', user: 'app' });
  assert.equal(s.ok, true);
  assert.equal(s.where, 'db1:/tmp/recover-snapshot.pgdump');
  assert.deepEqual(rt.sent.at(-1).args, ['pg_dump', '-U', 'app', '-Fc', '-f', '/tmp/recover-snapshot.pgdump', 'stock']);
  pg.restoreSnapshot(rt, 'db1', { name: 'stock', user: 'app' });
  assert.deepEqual(rt.sent.at(-1).args, ['pg_restore', '-U', 'app', '--clean', '--if-exists', '-d', 'stock', '/tmp/recover-snapshot.pgdump']);
  const failing = { exec: () => ({ status: 1, stdout: '', stderr: 'pg_restore: error: could not open input file' }) };
  assert.match(pg.restoreSnapshot(failing, 'db1', { name: 'stock' }).error, /pg_restore salió con 1 sobre \/tmp\/recover-snapshot\.pgdump: pg_restore: error/);
});

test('postgresql: la introspección lleva el catálogo a surface.yaml, con las columnas de estado por su forma', () => {
  const tables = pg.shapeTables({
    tables: [['items', '3'], ['movements', '3']],
    columns: [
      ['items', 'id', 'integer', '', '32', '0', 'NO', "nextval('items_id_seq'::regclass)"],
      ['items', 'sku', 'text', '', '', '', 'NO', ''],
      ['items', 'price', 'numeric', '', '10', '2', 'YES', ''],
      ['items', 'status', 'character varying', '20', '', '', 'NO', "'AVAILABLE'::character varying"],
      ['movements', 'id', 'integer', '', '32', '0', 'NO', "nextval('movements_id_seq'::regclass)"],
      ['movements', 'item_id', 'integer', '', '32', '0', 'NO', ''],
    ],
    constraints: [
      ['items', 'items_pkey', 'p', 'id', '', '', ' ', 'PRIMARY KEY (id)'],
      ['items', 'items_sku_key', 'u', 'sku', '', '', ' ', 'UNIQUE (sku)'],
      ['items', 'items_quantity_check', 'c', 'quantity', '', '', ' ', 'CHECK ((quantity >= 0))'],
      ['movements', 'movements_item_id_fkey', 'f', 'item_id', 'items', 'id', 'c', 'FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE'],
    ],
    indexes: [['items', 'items_status_idx', "CREATE INDEX items_status_idx ON public.items USING btree (status) WHERE ((status)::text <> 'GONE'::text)"]],
  });
  assert.deepEqual(tables[0], {
    name: 'items',
    rows: 3,
    columns: [
      { name: 'id', type: 'integer', nullable: false, default: "nextval('items_id_seq'::regclass)" },
      { name: 'sku', type: 'text', nullable: false },
      { name: 'price', type: 'numeric', nullable: true, precision: 10, scale: 2 },
      { name: 'status', type: 'character varying', nullable: false, length: 20, default: "'AVAILABLE'::character varying" },
    ],
    primaryKey: ['id'],
    unique: [['sku']],
    checks: ['CHECK ((quantity >= 0))'],
    indexes: [{ name: 'items_status_idx', definition: "CREATE INDEX items_status_idx ON public.items USING btree (status) WHERE ((status)::text <> 'GONE'::text)" }],
  });
  assert.deepEqual(tables[1].foreignKeys, [{ name: 'movements_item_id_fkey', columns: ['item_id'], references: { table: 'items', columns: ['id'] }, onDelete: 'cascade' }]);
  // estado: pocos valores en más de una fila; no si cada fila tiene el suyo, ni con una sola fila
  assert.deepEqual(
    pg.shapeStates([['items', 'status', '3', '2', '["AVAILABLE","SOLD"]'], ['items', 'note', '3', '3', '["a","b","c"]'], ['x', 'y', '1', '1', '[0]']]),
    [{ table: 'items', column: 'status', values: ['AVAILABLE', 'SOLD'] }]
  );
});

test('postgresql: la paridad vacía todo menos el historial de migraciones, reinicia las secuencias y cuenta lo que queda', () => {
  const rt = pgRuntime([[/information_schema\.tables/, 'flyway_schema_history\tinstalled_rank\norders\tid\ntypeorm_migrations\tid\n'], [/information_schema\.sequences/, ''], [/truncate/, '0\n']]);
  assert.deepEqual(pg.emptyDatabase(rt, 'db1', { name: 'shop', auth: { user: 'svc', password: 'x' } }), { ok: true, remaining: '0' });
  const sql = rt.sent.at(-1).sql;
  assert.match(sql, /^truncate table "orders" restart identity cascade;/);
  assert.doesNotMatch(sql, /flyway_schema_history|typeorm_migrations/);
});
