// Los almacenes de la mensajería que EMITE keel-spring son los que declara keel-core
// (`keel-core/gen/messaging-stores.js`): la tabla del outbox y la de los mensajes procesados —nombre,
// columnas, nulabilidad, cota, clave e índice— y los parámetros del relay y de las purgas —clave,
// variable de entorno y default, en el YAML de cada perfil y en el respaldo de los @Value—.
//
// Las entidades JPA siguen escritas a mano en outbox.js e idempotency.js, así que esto es lo que impide
// que se separen de los datos que keel-nest emite como TypeORM: el servidor de los dos generadores del
// mismo diseño tiene que encontrar en la base las mismas tablas y leer las mismas variables.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import {
  OUTBOX_EVENT,
  OUTBOX_PURGE,
  OUTBOX_RELAY,
  PROCESSED_EVENT,
  PROCESSED_EVENT_PURGE,
  parameterValue,
  storeColumns
} from 'keel-core/gen/messaging-stores';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

// El par del MVP: las dos ramas del mismo diseño, con outbox y suscripción.
const RELATIONAL = 'notification-mailer';
const DOCUMENT = 'notification-mailer-mongo';
const PROFILES = ['local', 'develop', 'production'];

function plan(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR }).files;
}

function javaFile(files, className) {
  const file = files.find((f) => f.path.endsWith(`/${className}.java`));
  assert.ok(file, `keel-spring emite ${className}`);
  return file.content;
}

/** Las columnas que declara una entidad JPA: @Id sin @Column es la clave `id`. */
function jpaColumns(content) {
  const columns = new Map();
  if (/@Id\s+private UUID id;/.test(content)) columns.set('id', { nullable: false, length: null, text: false, primary: true });
  for (const m of content.matchAll(/@Column\(name = "([^"]+)"([^)]*)\)\s+private (\w+) \w+;/g)) {
    const length = /length = (\d+)/.exec(m[2])?.[1];
    columns.set(m[1], {
      nullable: !/nullable = false/.test(m[2]),
      // Un String sin cota es el varchar(255) que Hibernate deja al dialecto.
      length: length ? Number(length) : m[3] === 'String' && !/columnDefinition/.test(m[2]) ? 255 : null,
      text: /columnDefinition = "text"/.test(m[2]),
      primary: false
    });
  }
  return columns;
}

function jpaIndexes(content) {
  return [...content.matchAll(/@Index\(name = "([^"]+)", columnList = "([^"]+)"\)/g)].map((m) => ({
    name: m[1],
    columns: m[2].split(',').map((c) => c.trim())
  }));
}

function assertRelational(content, spec, { primaryFromEmbeddedId = false } = {}) {
  assert.match(content, new RegExp(`@Table\\(name = "${spec.table}"`), `la tabla ${spec.table}`);
  const got = jpaColumns(content);
  const want = storeColumns(spec, 'relational');
  assert.deepEqual([...got.keys()].sort(), want.map((c) => c.name).sort(), `${spec.table}: las mismas columnas`);
  for (const column of want) {
    const have = got.get(column.name);
    assert.equal(have.nullable, column.nullable, `${spec.table}.${column.name}: nulabilidad`);
    if (column.base === 'string') assert.equal(have.length, column.length, `${spec.table}.${column.name}: cota`);
    assert.equal(have.text, column.base === 'text', `${spec.table}.${column.name}: text`);
  }
  const primary = want.filter((c) => c.primary).map((c) => c.name);
  if (primaryFromEmbeddedId) {
    // La clave compuesta es la del @Embeddable que hace de @EmbeddedId.
    const embeddable = content.slice(content.indexOf('@Embeddable'));
    assert.deepEqual([...jpaColumns(embeddable).keys()], primary, `${spec.table}: la clave primaria`);
  } else {
    assert.deepEqual([...got].filter(([, c]) => c.primary).map(([n]) => n), primary, `${spec.table}: la clave primaria`);
  }
  assert.deepEqual(jpaIndexes(content), spec.indexes, `${spec.table}: los índices`);
}

test(`${RELATIONAL}: outbox_event y processed_event son los de keel-core`, () => {
  const files = plan(RELATIONAL);
  assertRelational(javaFile(files, 'OutboxEventJpa'), OUTBOX_EVENT);
  assertRelational(javaFile(files, 'ProcessedEventJpa'), PROCESSED_EVENT, { primaryFromEmbeddedId: true });
});

test(`${DOCUMENT}: las colecciones llevan los campos de keel-core, claimed_at incluido`, () => {
  const files = plan(DOCUMENT);
  const fields = (content) => [...content.matchAll(/@Field\(name = "([^"]+)"\)/g)].map((m) => m[1]);
  const outbox = javaFile(files, 'OutboxEventDocument');
  assert.match(outbox, new RegExp(`@Document\\(collection = "${OUTBOX_EVENT.table}"\\)`));
  // El id es el _id del documento (@Id), no un @Field.
  assert.deepEqual(
    ['id', ...fields(outbox)].sort(),
    storeColumns(OUTBOX_EVENT, 'document').map((c) => c.name).sort()
  );
  const processed = javaFile(files, 'ProcessedEventDocument');
  assert.match(processed, new RegExp(`@Document\\(collection = "${PROCESSED_EVENT.table}"\\)`));
  assert.deepEqual(fields(processed).sort(), PROCESSED_EVENT.columns.map((c) => c.name).sort());
});

const PARAMETERS = [
  ...Object.values(OUTBOX_RELAY),
  ...Object.values(OUTBOX_PURGE),
  ...Object.values(PROCESSED_EVENT_PURGE)
];

for (const name of [RELATIONAL, DOCUMENT]) {
  test(`${name}: cada parámetro del relay y de las purgas está en el YAML de cada perfil, con su variable`, () => {
    const files = plan(name);
    for (const profile of PROFILES) {
      const file = files.find((f) => f.path.endsWith(`parameters/${profile}/messaging.yaml`));
      const yaml = parseYaml(file.content);
      for (const parameter of PARAMETERS) {
        const value = parameter.key.split('.').reduce((node, segment) => node?.[segment], yaml);
        const expected = parameterValue(parameter, profile);
        const want = profile === 'local' ? expected : `\${${parameter.env}:${expected}}`;
        assert.equal(String(value), String(want), `${profile}: ${parameter.key}`);
      }
    }
  });

  test(`${name}: el respaldo de los @Value es el default de keel-core`, () => {
    const files = plan(name);
    const java = javaFile(files, 'OutboxRelay') + javaFile(files, 'IdempotencyGuard');
    for (const parameter of PARAMETERS) {
      assert.ok(java.includes(`\${${parameter.key}:${parameter.default}}`), `${parameter.key}:${parameter.default}`);
    }
  });
}
