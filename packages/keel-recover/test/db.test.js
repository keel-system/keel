import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_FUNCTIONS, DATABASE_TECHS, databaseAdapter } from '../src/lib/db/index.js';
import { emptyDatabase } from '../src/lib/db/mongodb.js';
import * as pg from '../src/lib/db/postgresql.js';
import * as my from '../src/lib/db/mysql.js';
import { COUNTER_TABLES, ON_UPDATE_MARK, contentHash, isTechnicalKey } from '../src/lib/db/relational.js';

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
  assert.equal(databaseAdapter('mariadb'), null, 'sin medir, sin adaptador');
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

test('relacional: el contador de ids de cada motor no es una tabla del legacy', () => {
  assert.deepEqual(COUNTER_TABLES, ['_sequences', '_auto_increment']);
  assert.ok(isTechnicalKey('_auto_increment') && isTechnicalKey('_sequences') && isTechnicalKey('$keys'));
  assert.ok(!isTechnicalKey('user') && !isTechnicalKey('auto_increment'));
});

// ── MySQL, sin contenedores: el SQL que se envía y la lectura de lo que mysql devuelve ──────────
// Las salidas están grabadas del cliente `mysql -N -B -r` contra show-ticketing (MySQL 8.0.26,
// keel-recover-lab/show-ticketing/sandbox), con el snapshot de la ronda 0.

const MY_COLUMNS = 'seat\tid\tint\nseat\tperfTimeId\tint\nseat\treserved\ttinyint\nseatPrice\tid\tint\nseatPrice\tperformanceId\tint\nseatPrice\tprice\tint\nseatPrice\tratingType\tint\nseatPrice\tstartRowNum\tint\nseatPrice\tendRowNum\tint\n';
const MY_PKS = 'seat\tid\nseatPrice\tid\n';
const myExport = (pickNext) =>
  'seatPrice\t{"id": 1, "price": 150000, "endRowNum": 1, "ratingType": 1, "startRowNum": 1, "performanceId": 1}\n' +
  'seatPrice\t{"id": 2, "price": 90000, "endRowNum": 3, "ratingType": 2, "startRowNum": 2, "performanceId": 1}\n' +
  `_auto_increment\t{"name": "pick", "next": ${pickNext}}\n_auto_increment\t{"name": "seatPrice", "next": 3}\n`;
const MY_CATALOG = [
  [/information_schema\.columns c/, MY_COLUMNS],
  [/constraint_name = 'PRIMARY'/, MY_PKS],
];

test('mysql: el cliente lleva el SQL por stdin y la contraseña por entorno, la de la base o la de la imagen', () => {
  const rt = pgRuntime([]);
  my.mysql(rt, 'db1', { name: 'shop', auth: { user: 'svc', password: 'p w' } }, 'select 1;');
  assert.deepEqual(rt.sent[0].args, ['env', 'MYSQL_PWD=p w', 'mysql', '-u', 'svc', '-N', '-B', '-r', '--default-character-set=utf8mb4', 'shop']);
  assert.match(rt.sent[0].sql, /^set session information_schema_stats_expiry = 0;\nset session time_zone = '\+00:00';\nselect 1;$/, 'contador fresco y TIMESTAMP en UTC');
  // sandbox.yaml sin contraseña: la del MYSQL_USER de la imagen, o root
  my.mysql(rt, 'db1', { name: 'shop', user: 'flab' }, 'select 1;');
  assert.deepEqual(rt.sent[1].args.slice(0, 7), ['sh', '-c', 'MYSQL_PWD=$MYSQL_PASSWORD exec "$0" "$@"', 'mysql', '-u', 'flab', '-N']);
  my.mysql(rt, 'db1', { name: 'shop' }, 'select 1;');
  assert.deepEqual(rt.sent[2].args.slice(0, 6), ['sh', '-c', 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD exec "$0" "$@"', 'mysql', '-u', 'root']);
  const old = { exec: () => ({ status: 1, stdout: '', stderr: "ERROR 1193 (HY000) at line 1: Unknown system variable 'information_schema_stats_expiry'" }) };
  assert.match(my.mysql(old, 'db1', { name: 'shop' }, 'select 1;').error, /^MySQL anterior a 8\.0 \(sin medir/);
  assert.equal(my.ident('a`b'), '`a``b`');
  assert.equal(my.literal("o'k\\x"), "'o''k\\\\x'", 'la barra es un escape en los literales de MySQL');
});

test('mysql: una línea de JSON_OBJECT por fila, en orden de la clave, con DECIMAL a texto, binario a hex y fechas ISO', () => {
  const cat = my.shapeCatalog([['items', 'id', 'int'], ['items', 'price', 'decimal'], ['items', 'photo', 'varbinary'], ['items', 'at', 'datetime'], ['notes', 'text', 'varchar']], [['items', 'id']]);
  assert.deepEqual(cat, { items: { columns: [['id', 'int'], ['price', 'decimal'], ['photo', 'varbinary'], ['at', 'datetime']], pk: ['id'], onUpdate: [] }, notes: { columns: [['text', 'varchar']], pk: [], onUpdate: [] } });
  const sql = my.exportSql({ tables: cat });
  assert.match(sql, /select 'items', json_object\('id', `id`, 'price', cast\(`price` as char\), 'photo', hex\(`photo`\), 'at', replace\(cast\(`at` as char\), ' ', 'T'\)\) from `items` order by `id`;/);
  assert.match(sql, /from `notes` order by cast\(json_object\('text', `text`\) as char\);/, 'sin clave, por la fila entera');
  assert.match(sql, /'_auto_increment', json_object\('name', table_name, 'next', auto_increment\) from information_schema\.tables/);
  // grabado: así llegan esas tres expresiones desde 8.0.26
  assert.deepEqual(my.parseExport('items\t{"b": "0102FF", "d": "12.50", "t": "2027-01-01T10:00:00.250"}\n', ['items']).items, [{ b: '0102FF', d: '12.50', t: '2027-01-01T10:00:00.250' }]);
});

test('mysql: la exportación grabada se lee con las tablas vacías presentes y el AUTO_INCREMENT aparte', () => {
  const doc = my.parseExport(myExport(1), ['pick', 'seatPrice']);
  assert.deepEqual(doc.pick, [], 'una tabla vacía no da líneas y está igual');
  assert.equal(doc.seatPrice.length, 2);
  assert.deepEqual(doc.seatPrice[1], { id: 2, price: 90000, endRowNum: 3, ratingType: 2, startRowNum: 2, performanceId: 1 });
  assert.deepEqual(doc._auto_increment, [{ name: 'pick', next: 1 }, { name: 'seatPrice', next: 3 }]);
  assert.throws(() => my.parseExport('ghost\t{}\n', ['pick']), /tabla que el catálogo no tiene: ghost/);
  const e = my.exportDb(pgRuntime([...MY_CATALOG, [/json_object/, myExport(1)]]), 'db1', { name: 'show' });
  assert.deepEqual(e.value.$keys, { seat: ['id'], seatPrice: ['id'] });
  assert.deepEqual(e.value.seat, []);
});

test('mysql: la huella es la del contenido y cambia con el AUTO_INCREMENT que consume una escritura fallida (ST-ENV-11)', () => {
  const rt = pgRuntime([...MY_CATALOG, [/json_object/, myExport(1)]]);
  const a = my.fingerprint(rt, 'db1', { name: 'show' });
  const b = my.fingerprint(pgRuntime([...MY_CATALOG, [/json_object/, myExport(1)]]), 'db1', { name: 'show' });
  const c = my.fingerprint(pgRuntime([...MY_CATALOG, [/json_object/, myExport(2)]]), 'db1', { name: 'show' });
  assert.ok(a.ok && /^[0-9a-f]{32}$/.test(a.value));
  assert.equal(a.value, b.value);
  assert.notEqual(a.value, c.value, 'el insert que falla por FK consume el contador de pick');
  assert.ok(!rt.sent.some((s) => /table_rows|update_time/.test(s.sql ?? '')), 'nada de las estadísticas cacheadas');
  // y el diff lo trae como efecto, casado por nombre
  const before = { ...my.parseExport(myExport(1), ['pick', 'seatPrice']), $keys: { pick: ['id'], seatPrice: ['id'] } };
  const after = { ...my.parseExport(myExport(2), ['pick', 'seatPrice']), $keys: before.$keys };
  assert.deepEqual(my.dbDiff(before, after), { _auto_increment: { added: [], removed: [], changed: [{ before: { name: 'pick', next: 1 }, after: { name: 'pick', next: 2 } }] } });
});

test('mysql: snapshot con mysqldump sin tablespaces a un archivo, y restauración con source dentro del contenedor', () => {
  const rt = pgRuntime([...MY_CATALOG, [/json_object/, myExport(1)]]);
  const s = my.takeSnapshot(rt, 'db1', { name: 'show', user: 'flab' });
  assert.equal(s.ok, true);
  assert.equal(s.where, 'db1:/tmp/recover-snapshot.sql');
  assert.deepEqual(rt.sent.at(-1).args.slice(3), ['mysqldump', '-u', 'flab', '--single-transaction', '--routines', '--triggers', '--no-tablespaces', '--set-gtid-purged=OFF', '--result-file=/tmp/recover-snapshot.sql', 'show']);
  my.restoreSnapshot(rt, 'db1', { name: 'show', user: 'flab' });
  assert.match(rt.sent.at(-1).sql, /\nset session lock_wait_timeout = 20;\nsource \/tmp\/recover-snapshot\.sql\n$/, 'con tope: el metadata lock esperaría un año (M-01)');
  const failing = { exec: () => ({ status: 1, stdout: '', stderr: "ERROR 1146 (42S02) at line 2 in file: '/tmp/recover-snapshot.sql'" }) };
  assert.match(my.restoreSnapshot(failing, 'db1', { name: 'show' }).error, /la restauración de \/tmp\/recover-snapshot\.sql falló: ERROR 1146/);
});

test('mysql: una transacción abierta retiene la tabla y la restauración sale en rojo con quién la tiene (M-01)', () => {
  // grabado de fixtures/sandbox/node-mysql: una sesión con un SELECT dentro de una transacción abierta
  const locked = (open) => ({
    exec: (c, args, opts) =>
      /source/.test(opts.input)
        ? { status: 1, stdout: '', stderr: "ERROR 1205 (HY000) at line 22 in file: '/tmp/recover-snapshot.sql': Lock wait timeout exceeded; try restarting transaction" }
        : { status: 0, stdout: open, stderr: '' },
  });
  const r = my.restoreSnapshot(locked('32\troot\tlocalhost\t11\n'), 'db1', { name: 'stock' });
  assert.equal(r.ok, false);
  assert.match(r.error, /esperó 20 s el metadata lock de una tabla y no lo obtuvo: una transacción abierta la retiene \(sesión 32 de root@localhost, abierta hace 11 s\)/);
  assert.match(r.error, /a medias: cuando se cierre, vuelve a restaurar \(ERROR 1205/);
  assert.match(my.restoreSnapshot(locked(''), 'db1', { name: 'stock' }).error, /sin ninguna en innodb_trx: un LOCK TABLES o una sesión sobre MyISAM/);
});

test('mysql: la introspección grabada lleva motor, collation, AUTO_INCREMENT, FK con su acción, índices y estados', () => {
  const tables = my.shapeTables({
    tables: [['user', 'InnoDB', '2'], ['seatPrice', 'InnoDB', '2'], ['performance', 'MyISAM', '1']],
    columns: [
      ['user', 'id', 'int', '', '10', '0', 'NO', '', '', 'auto_increment', 'int unsigned'],
      ['user', 'userId', 'varchar', '45', '', '', 'NO', '', 'utf8mb4_0900_ai_ci', '', 'varchar(45)'],
      ['performance', 'status', 'enum', '7', '', '', 'NO', 'DRAFT', 'utf8mb4_0900_ai_ci', '', "enum('DRAFT','ON','O''K')"],
      ['performance', 'price', 'decimal', '', '10', '2', 'YES', '', '', '', 'decimal(10,2)'],
    ],
    constraints: [
      ['seatPrice', 'seatPrice_ibfk_1', 'FOREIGN KEY', 'performanceId', 'performance', 'id', 'CASCADE', ''],
      ['seatPrice', 'PRIMARY', 'PRIMARY KEY', 'id', '', '', '', ''],
      ['performance', 'performance_chk_1', 'CHECK', '', '', '', '', '(`price` >= 0)'],
      ['user', 'user_uk', 'UNIQUE', 'userId', '', '', '', ''],
    ],
    indexes: [['performance', 'hallId', '1', 'hallId'], ['performance', 'performance_Index', '1', 'title']],
  });
  assert.deepEqual(tables[0], {
    name: 'user', rows: 2, engine: 'InnoDB',
    columns: [
      { name: 'id', type: 'int', nullable: false, autoIncrement: true, unsigned: true },
      { name: 'userId', type: 'varchar', nullable: false, length: 45, collation: 'utf8mb4_0900_ai_ci' },
    ],
    unique: [['userId']],
  });
  assert.deepEqual(tables[1].foreignKeys, [{ name: 'seatPrice_ibfk_1', columns: ['performanceId'], references: { table: 'performance', columns: ['id'] }, onDelete: 'cascade' }]);
  assert.deepEqual(tables[1].primaryKey, ['id']);
  const perf = tables[2];
  assert.equal(perf.engine, 'MyISAM', 'el motor de cada tabla: MyISAM no aplica las FK (M-10)');
  assert.deepEqual(perf.columns[0].values, ['DRAFT', 'ON', "O'K"], 'los valores de un ENUM, de COLUMN_TYPE, sin el escape de la comilla');
  assert.deepEqual(perf.columns[1], { name: 'price', type: 'decimal', nullable: true, precision: 10, scale: 2 });
  assert.deepEqual(perf.checks, ['(`price` >= 0)']);
  assert.deepEqual(perf.indexes, [{ name: 'hallId', definition: 'INDEX hallId (hallId)' }, { name: 'performance_Index', definition: 'INDEX performance_Index (title)' }]);
  // JSON_ARRAYAGG no ordena: los valores salen ordenados, los números como números
  assert.deepEqual(
    my.shapeStates([['seat', 'reserved', '12', '2', '[1, 0]'], ['user', 'userType', '2', '2', '[2, 1]'], ['performanceTime', 'id', '1', '1', '[1]'], ['t', 's', '5', '2', '["ON", "DRAFT"]']]),
    [{ table: 'seat', column: 'reserved', values: [0, 1] }, { table: 't', column: 's', values: ['DRAFT', 'ON'] }]
  );
});

// De fixtures/sandbox/node-mysql (8.0.26): EXTRA de un TIMESTAMP con DEFAULT y ON UPDATE, y su trigger.
const ON_UPDATE_EXTRA = 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP';

test('mysql: ON UPDATE y los triggers llegan a la superficie, y las rutinas aparte (M-09, M-11)', () => {
  const [items, movements] = my.shapeTables({
    tables: [['items', 'InnoDB', '2'], ['movements', 'InnoDB', '3']],
    columns: [
      ['items', 'updated_at', 'timestamp', '', '', '', 'NO', 'CURRENT_TIMESTAMP', '', ON_UPDATE_EXTRA, 'timestamp'],
      ['items', 'created_at', 'timestamp', '', '', '', 'NO', 'CURRENT_TIMESTAMP', '', 'DEFAULT_GENERATED', 'timestamp'],
    ],
    constraints: [],
    indexes: [],
    triggers: [['movements', 'movement_logged', 'after', 'insert', 'insert into movement_log (movement_id, delta) values (new.id, new.delta)']],
  });
  assert.deepEqual(items.columns[0], { name: 'updated_at', type: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' });
  assert.equal(items.columns[1].onUpdate, undefined, 'un DEFAULT CURRENT_TIMESTAMP solo no es ON UPDATE');
  assert.equal(items.triggers, undefined);
  assert.deepEqual(movements.triggers, [{ name: 'movement_logged', timing: 'after', event: 'insert', statement: 'insert into movement_log (movement_id, delta) values (new.id, new.delta)' }]);
  // el cuerpo del trigger viaja en una línea: la salida es una fila por línea
  assert.match(my.TRIGGERS_SQL, /replace\(replace\(replace\(action_statement, '\\r', ' '\), '\\n', ' '\), '\\t', ' '\)/);

  const rt = pgRuntime([
    [/from information_schema\.tables\s+where table_schema = database\(\) and table_type/, 'items\tInnoDB\n'],
    [/count\(\*\)/, 'items\t2\n'],
    [/from information_schema\.routines/, 'procedure\trestock\n'],
  ]);
  const r = my.introspectDb(rt, 'db1', { name: 'stock' });
  assert.ok(r.ok);
  assert.deepEqual(r.value.routines, [{ name: 'restock', type: 'procedure' }]);
  assert.equal(my.introspectDb(pgRuntime([[/table_type = 'BASE TABLE' order by table_name/, 'items\tInnoDB\n']]), 'db1', { name: 'stock' }).value.routines, undefined, 'sin rutinas, sin la clave');
});

test('mysql: las columnas con ON UPDATE viajan en $onUpdate, no cuentan en la huella y el diff las graba como del motor (M-09)', () => {
  const columns = `items\tid\tint\tauto_increment\nitems\tquantity\tjson\t\nitems\tupdated_at\ttimestamp\t${ON_UPDATE_EXTRA}\nmovements\tid\tint\tauto_increment\n`;
  const catalog = [[/information_schema\.columns c/, columns], [/constraint_name = 'PRIMARY'/, 'items\tid\nmovements\tid\n']];
  const rowAt = (q, at) => `items\t{"id": 1, "quantity": ${q}, "updated_at": "${at}"}\n_auto_increment\t{"name": "items", "next": 2}\n`;
  const before = my.exportDb(pgRuntime([...catalog, [/json_object/, rowAt(5, '2026-10-26T13:31:31')]]), 'db1', { name: 'stock' }).value;
  const after = my.exportDb(pgRuntime([...catalog, [/json_object/, rowAt(4, '2026-10-26T13:31:34')]]), 'db1', { name: 'stock' }).value;
  assert.deepEqual(before.$onUpdate, { items: ['updated_at'] }, 'solo las tablas que las tienen');
  assert.equal(before.items[0].updated_at, '2026-10-26T13:31:31', 'la exportación es fiel: el valor está');
  const { $onUpdate, ...plain } = before;
  assert.equal(contentHash(before), contentHash(plain), 'la huella no cuenta lo que describe la base');

  const diff = my.dbDiff(before, after);
  assert.deepEqual(diff.items.changed, [{ before: { id: 1, quantity: 5, updated_at: ON_UPDATE_MARK }, after: { id: 1, quantity: 4, updated_at: ON_UPDATE_MARK } }]);
  // una fila que solo cambia en la columna del motor no es un cambio del flujo
  const touched = my.exportDb(pgRuntime([...catalog, [/json_object/, rowAt(5, '2026-10-26T13:31:40')]]), 'db1', { name: 'stock' }).value;
  assert.deepEqual(my.dbDiff(before, touched), {});
  assert.equal(my.exportDb(pgRuntime([[/information_schema\.columns c/, 'items\tid\tint\tauto_increment\n'], [/PRIMARY/, 'items\tid\n']]), 'db1', { name: 'stock' }).value.$onUpdate, undefined);
});

test('mysql: la paridad vacía con TRUNCATE y las FK desactivadas, sin tocar el historial de migraciones, y carga en una transacción', () => {
  const rt = pgRuntime([[/information_schema\.columns c/, 'flyway_schema_history\tinstalled_rank\tint\norders\tid\tbinary\ntypeorm_migrations\tid\tint\n'], [/constraint_name = 'PRIMARY'/, 'orders\tid\n'], [/truncate/, '0\n']]);
  assert.deepEqual(my.emptyDatabase(rt, 'db1', { name: 'shop', auth: { user: 'svc', password: 'x' } }), { ok: true, remaining: '0' });
  const sql = rt.sent.at(-1).sql;
  assert.match(sql, /set foreign_key_checks = 0;\ntruncate table `orders`;\nset foreign_key_checks = 1;/);
  assert.doesNotMatch(sql, /flyway_schema_history|typeorm_migrations/);
  my.loadScript(rt, 'db1', { name: 'shop', auth: { user: 'svc', password: 'x' } }, "insert into `orders` values (1);");
  assert.match(rt.sent.at(-1).sql, /start transaction;\ninsert into `orders` values \(1\);\ncommit;\n$/);
});
