// Cada clave que `introspect` escribe en surface.yaml → data, en los tres motores, tiene su fila en la skill
// (assets/skills/keel-recover/references/evidence-to-dsl.md): la tabla que dice qué elemento del DSL sostiene y con
// qué nivel. Sin ella, el diseñador recibe evidencia que nadie le ha dicho cómo leer —y la de MySQL (collation,
// sqlMode, onUpdate…) se lee mal por defecto—.
//
// Las claves salen de ejecutar el `introspect` de cada adaptador contra un runtime falso que contesta cada consulta
// con filas que encienden todas sus ramas. Una consulta que el falso no conoce es un error: un adaptador que gane una
// consulta (y con ella, claves nuevas) rompe este test hasta que se le dé respuesta, y la clave, su fila.
//
// Qué se exige: las claves de `data` (`data.sqlMode`), las de cada tabla o colección (`engine`, `count`), las de cada
// columna (`columns[].collation`) y las de cada índice documental (`indexes[].sparse`). Lo anidado más abajo (las
// partes de una FK, de un trigger, de una columna de estado) lo cubre la fila de su clave. `name` solo identifica.
// En la skill, una fila cubre las claves que nombra entre comillas invertidas en su primera celda; las de una tabla o
// colección, dentro de su sección (`## Base relacional` y `## Base documental`, por el `data.tables`/`data.collections`
// de su título), y las de `data` en cualquier sitio.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_TECHS, databaseAdapter } from '../src/lib/db/index.js';
import * as pg from '../src/lib/db/postgresql.js';
import * as my from '../src/lib/db/mysql.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(here, '..', 'assets', 'skills', 'keel-recover', 'references', 'evidence-to-dsl.md');

/** Un runtime que contesta por la consulta, y falla con la que no conoce. */
function fakeRuntime(answers) {
  return {
    exec: (c, args, opts = {}) => {
      const asked = opts.input ?? args.join(' ');
      const hit = answers.find(([match]) => (typeof match === 'string' ? asked.includes(match) : match.test(asked)));
      if (!hit) throw new Error(`consulta sin respuesta en el runtime falso: ${asked.slice(0, 200)}`);
      return { status: 0, stdout: hit[1], stderr: '' };
    },
  };
}

const tsv = (...rows) => `${rows.map((r) => r.join('\t')).join('\n')}\n`;

// Una tabla con todo: PK con contador, texto con collation, ENUM, ON UPDATE, sin signo, decimal, CHECK, FK, índice,
// trigger y columna de estado; y una rutina.
const MYSQL_ANSWERS = [
  [my.TABLES_SQL, tsv(['items', 'InnoDB'], ['movements', 'MyISAM'])],
  [/select 'items', count\(\*\)/, tsv(['items', '2'], ['movements', '3'])],
  [my.INTROSPECT_COLUMNS_SQL, tsv(
    ['items', 'id', 'int', '', '10', '0', 'NO', '', '', 'auto_increment', 'int unsigned'],
    ['items', 'sku', 'varchar', '64', '', '', 'NO', '', 'utf8mb4_0900_ai_ci', '', 'varchar(64)'],
    ['items', 'status', 'enum', '9', '', '', 'NO', 'AVAILABLE', 'utf8mb4_0900_ai_ci', '', "enum('AVAILABLE','SOLD')"],
    ['items', 'price', 'decimal', '', '10', '2', 'YES', '', '', '', 'decimal(10,2)'],
    ['items', 'updated_at', 'timestamp', '', '', '', 'NO', 'CURRENT_TIMESTAMP', '', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP', 'timestamp'],
    ['movements', 'id', 'int', '', '10', '0', 'NO', '', '', 'auto_increment', 'int'],
    ['movements', 'item_id', 'int', '', '10', '0', 'NO', '', '', '', 'int'],
    ['movements', 'kind', 'varchar', '8', '', '', 'NO', '', 'utf8mb4_0900_ai_ci', '', 'varchar(8)'],
  )],
  [my.CONSTRAINTS_SQL, tsv(
    ['items', 'PRIMARY', 'PRIMARY KEY', 'id', '', '', '', ''],
    ['items', 'sku', 'UNIQUE', 'sku', '', '', '', ''],
    ['items', 'items_chk_1', 'CHECK', '', '', '', '', '(`price` >= 0)'],
    ['movements', 'movements_item_fk', 'FOREIGN KEY', 'item_id', 'items', 'id', 'CASCADE', ''],
  )],
  [my.INDEXES_SQL, tsv(['movements', 'movements_item_fk', '1', 'item_id'])],
  [my.TRIGGERS_SQL, tsv(['movements', 'movement_logged', 'after', 'insert', 'insert into movement_log values (new.id)'])],
  [my.ROUTINES_SQL, tsv(['procedure', 'restock'])],
  [my.SQL_MODE_SQL, 'NO_ENGINE_SUBSTITUTION\n'],
  [/count\(distinct v\)/, tsv(['movements', 'kind', '3', '2', '["in", "out"]'])],
];

const PG_ANSWERS = [
  [pg.TABLES_SQL, tsv(['items', 'id'], ['movements', 'id'])],
  [pg.SEQUENCES_SQL, 'items_id_seq\n'],
  [/select 'items', count\(\*\)/, tsv(['items', '2'], ['movements', '3'])],
  [pg.COLUMNS_SQL, tsv(
    ['items', 'id', 'integer', '', '32', '0', 'NO', "nextval('items_id_seq'::regclass)"],
    ['items', 'sku', 'character varying', '64', '', '', 'NO', ''],
    ['items', 'price', 'numeric', '', '10', '2', 'YES', ''],
    ['items', 'status', 'item_status', '', '', '', 'NO', "'AVAILABLE'::item_status"],
    ['movements', 'id', 'integer', '', '32', '0', 'NO', ''],
    ['movements', 'item_id', 'integer', '', '32', '0', 'NO', ''],
    ['movements', 'kind', 'text', '', '', '', 'NO', ''],
  )],
  [pg.CONSTRAINTS_SQL, tsv(
    ['items', 'items_pkey', 'p', 'id', '', '', 'a', 'PRIMARY KEY (id)'],
    ['items', 'items_sku_key', 'u', 'sku', '', '', 'a', 'UNIQUE (sku)'],
    ['items', 'items_price_check', 'c', 'price', '', '', 'a', 'CHECK ((price >= 0))'],
    ['movements', 'movements_item_fk', 'f', 'item_id', 'items', 'id', 'c', 'FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE'],
  )],
  [pg.INDEXES_SQL, tsv(['items', 'items_live_sku', 'CREATE UNIQUE INDEX items_live_sku ON public.items USING btree (sku) WHERE (status <> \'SOLD\'::item_status)'])],
  [pg.TYPES_SQL, tsv(['item_status', 'AVAILABLE,SOLD'])],
  [/count\(distinct v\)/, tsv(['movements', 'kind', '3', '2', '["in","out"]'])],
];

// Una colección con un campo de dos tipos, un índice único disperso con TTL y un campo de estado.
const MONGO_COLLECTIONS = [
  {
    name: 'items',
    count: 3,
    sampled: 3,
    indexes: [{ name: '_id_', key: { _id: 1 } }, { name: 'sku_1', key: { sku: 1 }, unique: true, sparse: true, expireAfterSeconds: 3600 }],
    fields: [{ name: '_id', types: ['objectid'] }, { name: 'sku', types: ['string'] }, { name: 'note', types: ['null', 'string'] }, { name: 'status', types: ['string'] }],
    values: [{ field: 'status', values: ['AVAILABLE', 'SOLD'] }],
  },
];
const MONGO_ANSWERS = [[/getCollectionNames/, `@@EJSON ${JSON.stringify(MONGO_COLLECTIONS)}\n`]];

const ANSWERS = { mongodb: MONGO_ANSWERS, postgresql: PG_ANSWERS, mysql: MYSQL_ANSWERS };

/** Lo que el adaptador de `tech` escribe en data, con todas sus ramas encendidas. */
function introspected(tech) {
  const r = databaseAdapter(tech).introspect(fakeRuntime(ANSWERS[tech]), 'db1', { name: 'stock', tech });
  assert.ok(r.ok, `${tech}: ${r.error}`);
  return r.value;
}

/** Las claves que se exigen, como las escribe la skill: `{ data: Set, element: Set, section }`. */
function surfaceKeys(data) {
  const keys = { data: new Set(), element: new Set() };
  const elementKeys = (prefix, obj) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'name') continue;
      // las columnas y los índices documentales se exigen clave a clave; la lista en sí, por sus elementos
      if (prefix === '' && (key === 'columns' || (key === 'indexes' && value.some((i) => typeof i.key === 'object')))) {
        for (const item of value) elementKeys(`${key}[].`, item);
        if (key === 'columns') continue;
      }
      keys.element.add(`${prefix}${key}`);
    }
  };
  for (const [key, value] of Object.entries(data)) {
    keys.data.add(`data.${key}`);
    if (key === 'tables' || key === 'collections') for (const element of value) elementKeys('', element);
  }
  return keys;
}

/** Las claves que nombra la skill: las de cada sección de base, y todas (para las de `data`). */
function skillKeys() {
  const text = fs.readFileSync(SKILL, 'utf8');
  const tokens = (chunk) => {
    const out = new Set();
    for (const line of chunk.split('\n')) {
      const cell = line.startsWith('|') ? line.split('|')[1] : line.startsWith('#') ? line : '';
      for (const [, token] of cell.matchAll(/`([^`]+)`/g)) out.add(token.replace(/^surface\.yaml → /, ''));
    }
    return out;
  };
  const sections = {};
  for (const part of text.split(/^(?=## )/m)) {
    const heading = part.split('\n')[0];
    if (/`surface\.yaml → data\.tables`/.test(heading)) sections.tables = tokens(part);
    if (/`surface\.yaml → data\.collections`/.test(heading)) sections.collections = tokens(part);
  }
  return { all: tokens(text), sections };
}

test('el runtime falso enciende todas las ramas de cada introspección (si no, el test no ve sus claves)', () => {
  const mysql = introspected('mysql');
  const items = mysql.tables.find((t) => t.name === 'items');
  for (const key of ['autoIncrement', 'unsigned', 'collation', 'values', 'onUpdate', 'precision', 'default', 'length']) {
    assert.ok(items.columns.some((c) => key in c), `mysql: ninguna columna con ${key}`);
  }
  assert.ok(mysql.tables.some((t) => t.triggers) && mysql.tables.some((t) => t.states) && mysql.tables.some((t) => t.foreignKeys) && mysql.tables.some((t) => t.indexes));
  assert.ok(mysql.routines && mysql.sqlMode === 'NO_ENGINE_SUBSTITUTION');
  const postgres = introspected('postgresql');
  assert.ok(postgres.types && postgres.sequences.length && postgres.tables.some((t) => t.states) && postgres.tables.some((t) => t.checks) && postgres.tables.some((t) => t.indexes));
  const mongo = introspected('mongodb');
  assert.ok(mongo.collections[0].enums, 'mongodb: el campo de estado');
});

test('cada clave que introspect escribe en surface.yaml → data tiene su fila en evidence-to-dsl.md, en los tres motores', () => {
  const skill = skillKeys();
  assert.ok(skill.sections.tables && skill.sections.collections, 'la skill tiene las dos secciones de base');
  const missing = [];
  for (const tech of DATABASE_TECHS) {
    const data = introspected(tech);
    const keys = surfaceKeys(data);
    const section = skill.sections[data.collections ? 'collections' : 'tables'];
    for (const key of keys.data) if (!skill.all.has(key)) missing.push(`${tech}: ${key}`);
    for (const key of keys.element) if (!section.has(key)) missing.push(`${tech}: ${key}`);
  }
  assert.deepEqual(missing, [], 'claves de la superficie sin fila en evidence-to-dsl.md');
});

test('las claves de MySQL que se leen mal por defecto tienen su fila en la sección de MySQL', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  const mysql = text.slice(text.indexOf('### MySQL'), text.indexOf('## Base documental'));
  for (const key of ['columns[].collation', 'data.sqlMode', 'columns[].type', 'columns[].values', 'engine', 'columns[].onUpdate', 'columns[].autoIncrement', 'columns[].unsigned']) {
    assert.ok(mysql.split('\n').some((line) => line.startsWith('|') && line.split('|')[1].includes(`\`${key}\``)), `sin fila para ${key} en § MySQL`);
  }
  assert.match(text, /`_auto_increment`/, 'el contador de MySQL en el diff, como efecto técnico');
});

test('el falso falla con una consulta que no conoce: una consulta nueva del adaptador no pasa sin respuesta', () => {
  const answers = MYSQL_ANSWERS.filter(([match]) => match !== my.SQL_MODE_SQL);
  assert.throws(() => databaseAdapter('mysql').introspect(fakeRuntime(answers), 'db1', { name: 'stock', tech: 'mysql' }), /consulta sin respuesta/);
});
