// keel-spring frente al CONTRATO DEL CABLE (keel-core/gen/wire.js), que comparten todos los
// generadores. Aquí se mide sobre lo que build emite —la configuración de Jackson, el módulo de
// instantes, los records de los cuerpos y las anotaciones de los DTO—, sin levantar la JVM: cada
// regla del contrato tiene en Spring una pieza que la realiza, y este test exige que esa pieza
// esté. Lo que solo se ve ejecutando (que Jackson haga de verdad lo que esa pieza promete) lo
// miden los escenarios de una corrida.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { WIRE_SHAPES, WIRE_OUTPUT_CASES } from 'keel-core/gen/wire';
import { resolveType } from 'keel-core/gen/types';
import { planService } from '../src/scaffold/index.js';
import { JAVA_PROJECTION } from '../src/lib/java-projection.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

function plan(fixture, stack = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return planService({ manifest, layers, workspace: tmpDir('keel-wire-'), stack });
}

const fileNamed = (files, suffix) => files.find((file) => file.path.split(/[\\/]/).join('/').endsWith(suffix));
const components = (content, record) => {
  const match = content.match(new RegExp(`record ${record}(?:<[^>]+>)?\\(([^)]*)\\)`));
  assert.ok(match, `sin record ${record}`);
  return match[1].split(',').map((part) => part.trim().split(/\s+/).pop());
};

const catalog = plan('catalog-extended');
const checkout = plan('payment-checkout', { broker: 'rabbitmq', paymentGateway: 'stripe' });

test('decimal-plain + timestamp: Jackson escribe BigDecimal en notación plana y las fechas como texto', () => {
  const yaml = fileNamed(catalog.files, 'src/main/resources/application.yaml').content;
  assert.match(yaml, /generator:\n\s+write-bigdecimal-as-plain: true/);
  assert.match(yaml, /write-dates-as-timestamps: false/);
});

test('timestamp-utc-millis: el módulo de instantes fija tres decimales en UTC (appendInstant trunca)', () => {
  const module = fileNamed(catalog.files, '/TimestampModule.java').content;
  assert.match(module, /\.appendInstant\(3\)/);
});

test('los tipos del contrato tienen su tipo Java exacto (nunca double, nunca int para un long)', () => {
  const javaOf = (type) => JAVA_PROJECTION.fieldType(resolveType(type)).javaType;
  const expected = { decimal: 'BigDecimal', long: 'Long', int: 'Integer', timestamp: 'Instant', date: 'LocalDate', uuid: 'UUID', boolean: 'Boolean' };
  for (const type of new Set(WIRE_OUTPUT_CASES.map((entry) => entry.type))) {
    if (expected[type]) assert.equal(javaOf(type), expected[type], type);
  }
});

test('el cuerpo de error tiene las claves del contrato, en su orden', () => {
  const error = fileNamed(catalog.files, '/ErrorResponse.java').content;
  assert.deepEqual(components(error, 'ErrorResponse'), WIRE_SHAPES.errorResponse);
  // Nunca omite nulos, aunque el diseño declare conventions.nulls: omit (catalog-extended lo hace).
  assert.doesNotMatch(error, /JsonInclude/);
});

test('la página tiene las claves del contrato, en su orden', () => {
  const page = fileNamed(catalog.files, '/PagedResponse.java').content;
  assert.deepEqual(components(page, 'PagedResponse'), WIRE_SHAPES.pagedResponse);
});

test('la envoltura y la metadata de un evento tienen las claves del contrato, en su orden', () => {
  assert.deepEqual(components(fileNamed(checkout.files, '/EventEnvelope.java').content, 'EventEnvelope'), WIRE_SHAPES.eventEnvelope);
  assert.deepEqual(components(fileNamed(checkout.files, '/EventMetadata.java').content, 'EventMetadata'), WIRE_SHAPES.eventMetadata);
});

test('nulls-omit: con conventions.nulls: omit los DTO de respuesta omiten nulos; sin ella, viajan', () => {
  const omitting = catalog.files.filter((file) => /ResponseDto\.java$/.test(file.path));
  assert.ok(omitting.length > 0);
  for (const file of omitting) assert.match(file.content, /@JsonInclude\(JsonInclude\.Include\.NON_NULL\)/, file.path);
  const including = checkout.files.filter((file) => /ResponseDto\.java$/.test(file.path));
  assert.ok(including.length > 0);
  for (const file of including) assert.doesNotMatch(file.content, /NON_NULL/, file.path);
});

test('json-embedded y enum-value: el json viaja embebido y el enum por su valor', () => {
  const rawJson = checkout.files.filter((file) => file.content?.includes('@JsonRawValue'));
  assert.ok(rawJson.length > 0, 'ningún campo json embebido en payment-checkout');
  const enums = catalog.files.filter((file) => file.path.split(/[\\/]/).join('/').includes('/domain/enums/'));
  assert.ok(enums.length > 0);
  for (const file of enums) assert.match(file.content, /@JsonValue/, file.path);
});
