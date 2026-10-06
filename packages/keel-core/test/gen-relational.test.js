// El esquema relacional de keel-core/gen: tablas, columnas, constraints e índices como DATOS, sin
// lenguaje. keel-spring lo escribe como anotaciones JPA y keel-nest como decoradores de TypeORM, así
// que lo que aquí se fija es lo que los dos servidores del mismo diseño comparten en la base.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { resolveType } from '../src/lib/gen/types.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import {
  columnSpec,
  persistedMembers,
  crossAggregateForeignKeys,
  uniqueConstraints,
  storedWhenValue,
  quoteIdentifierFor,
  foreignKeyIndexColumns,
  elementTable
} from '../src/lib/gen/relational.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

// Una proyección mínima que no es de ningún lenguaje: el esquema no puede depender de ella.
const PROBE = {
  projectSuffix: 'probe',
  service: () => ({}),
  parameterType: () => ({}),
  fieldType: (resolved) => ({ probeType: resolved.name ?? resolved.base }),
  elementType: () => ({}),
  namedType: (name) => ({ probeType: name }),
  namedElement: () => ({}),
  renamed: (name) => ({ probeType: name }),
  typeNameOf: (field) => field?.probeType,
  carryType: (field) => ({ probeType: field.probeType }),
  uploadType: () => ({}),
  uploadValidation: () => ({ validation: [], inputValidation: [] }),
  replicaKey: () => ({}),
  errorBase: () => 'base',
  fieldDetails: () => ({ validation: [], numeric: null, inputValidation: [], inheritedPattern: null, columns: [], elementColumns: [], initializer: null }),
  messages: { lockVersionReserved: () => '', readQueriesRef: () => '', pathParamFallback: () => '', cognitoEmulated: () => '' }
};

function modelOf(name, database = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const stack = { ...STACK_DEFAULTS, database: database ?? defaultDatabaseFor(layers.persistence?.default?.model) };
  return buildModel({ manifest, layers, stack, projection: PROBE });
}

test('columnSpec: nombre, nulabilidad y cotas de cada forma de campo', () => {
  const text = columnSpec('notes', {}, resolveType('text'));
  assert.equal(text.long, true);
  assert.equal(text.length, null);

  const bounded = columnSpec('displayName', { required: true, constraints: { maxLength: 80 } }, resolveType('string'));
  assert.deepEqual([bounded.name, bounded.nullable, bounded.length, bounded.collation], ['display_name', false, 80, null]);

  // La collation solo se fuerza donde llega, y entonces la cota sin declarar se queda en 255.
  const collated = columnSpec('code', {}, resolveType('string'), { collation: 'utf8mb4_bin' });
  assert.deepEqual([collated.length, collated.collation], [255, 'utf8mb4_bin']);
  const collatedLong = columnSpec('body', {}, resolveType('text'), { collation: 'utf8mb4_bin' });
  assert.deepEqual([collatedLong.long, collatedLong.length, collatedLong.collation], [true, null, 'utf8mb4_bin']);

  const money = columnSpec('amount', { constraints: { scale: 2 } }, resolveType('decimal'));
  assert.equal(money.scale, 2);
  assert.equal(money.length, null);

  const id = columnSpec('id', { id: true }, resolveType('uuid'));
  assert.deepEqual([id.nullable, id.updatable], [false, false]);

  const status = columnSpec('status', { type: 'enum' }, { kind: 'enum', name: 'JobStatus', constraints: {} });
  assert.equal(status.enum, true);
  // Una cota de texto no se aplica a lo que no es texto.
  assert.equal(columnSpec('count', { constraints: { maxLength: 9 } }, resolveType('int')).length, null);
});

test('las reservadas se citan con el carácter de cada motor, y solo ellas', () => {
  assert.equal(quoteIdentifierFor('postgresql', 'order'), '"order"');
  assert.equal(quoteIdentifierFor('mysql', 'order'), '`order`');
  assert.equal(quoteIdentifierFor('sqlserver', 'order'), '[order]');
  assert.equal(quoteIdentifierFor('postgresql', 'reference'), 'reference');
});

test('los miembros persistidos salen sin nada de la proyección, y con las columnas crudas', () => {
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'persistence.keel.yaml')));
  assert.ok(fixtures.length >= 10);
  for (const name of fixtures) {
    const model = modelOf(name);
    for (const entity of model.entities.filter((e) => e.persisted)) {
      for (const member of persistedMembers(model, entity)) {
        assert.equal(member.probeType, undefined, `${name}.${entity.name}.${member.name}`);
        for (const sub of member.subs ?? []) assert.match(sub.column, /^[a-z0-9_]+$/, `${name}: ${sub.column}`);
        if (member.kind === 'vo') assert.ok(member.vo, `${name}.${entity.name}.${member.name}: value object sin resolver`);
      }
    }
  }
});

test('las FK entre agregados y las constraints únicas tienen nombre estable', () => {
  const model = modelOf('catalog-extended');
  const fks = crossAggregateForeignKeys(model);
  assert.ok(fks.length > 0);
  for (const fk of fks) assert.match(fk.name, new RegExp(`^fk_${fk.table}_`));
  const constraints = uniqueConstraints(model).map((entry) => entry.constraint);
  assert.ok(constraints.some((name) => /^uk_[a-z_]+_natural$/.test(name)), constraints.join(', '));
});

test('la condición de un índice compara con la CONSTANTE del enum, no con el literal del diseño', () => {
  const model = modelOf('notification-mailer');
  const entity = model.entities.find((candidate) => (candidate.indexes ?? []).some((index) => index.when));
  assert.ok(entity, 'el par del MVP declara un índice condicionado');
  const index = entity.indexes.find((candidate) => candidate.when);
  const enumDef = model.enums.find((candidate) => candidate.values.some((value) => value.literal === index.when.equals));
  assert.ok(enumDef, 'la condición es sobre un enum');
  const expected = enumDef.values.find((value) => value.literal === index.when.equals).constant;
  assert.notEqual(expected, index.when.equals);
  assert.equal(storedWhenValue(model, entity, index.when), expected);
});

test('la tabla de elementos de una lista y el índice de su FK', () => {
  const model = modelOf('notification-mailer');
  const entity = model.entities.find((candidate) => candidate.persisted && candidate.fields.some((field) => field.list));
  const member = persistedMembers(model, entity).find((m) => m.kind === 'elementCollection');
  const table = elementTable(entity, member);
  assert.match(table.foreignKey, new RegExp(`^fk_${table.table}_`));
  assert.equal(table.foreignKeyIndex, `ix_${table.table}_${table.joinColumn}`);
  // La FK de una lista se indexa en su tabla, no en la de la entidad.
  assert.ok(!foreignKeyIndexColumns(model, entity).includes(table.joinColumn));
});

test('el índice condicionado se resuelve con la CONSTANTE del enum y el quoting de cada motor', async () => {
  const { partialIndexSpecs } = await import('../src/lib/gen/relational.js');
  const postgres = partialIndexSpecs(modelOf('notification-mailer', 'postgresql'), 'postgresql');
  assert.equal(postgres.length, 1);
  const [spec] = postgres;
  assert.equal(spec.name, 'uk_templates_application_key_locale');
  // `key` es reservada: se cita con el carácter del motor.
  assert.equal(spec.columns, 'application_id, "key", locale');
  assert.equal(spec.predicate, "status = 'ACTIVE'");
  const [mysql] = partialIndexSpecs(modelOf('notification-mailer', 'mysql'), 'mysql');
  assert.equal(mysql.columns, 'application_id, `key`, locale');
});

test('la operación que RELEVA en un índice condicionado es la que declara entrar y salir del estado', async () => {
  const { relievingOperations } = await import('../src/lib/gen/relational.js');
  const relieving = relievingOperations(modelOf('notification-mailer'));
  assert.deepEqual(relieving.map((r) => [r.operation.name, r.entity.name, r.state]), [['publishTemplate', 'Template', 'active']]);
  assert.deepEqual(relievingOperations(modelOf('product-catalog')), []);
});
