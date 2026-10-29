// La proyección Go cumple el contrato de keel-core/gen/projection.js y construye el modelo de TODAS las fixtures
// compartidas —también las que keel-go todavía no sabe generar—: el modelo es neutral y no depende de la frontera
// del generador. Donde los cuatro generadores deben decir lo mismo (el nombre del proyecto salvo el sufijo, las
// entidades, las operaciones con sus rutas y status, los avisos), lo dicen. Y los nombres siguen la regla de Go:
// MixedCaps con las siglas en un solo caso (PLAN-KEEL-GO.md § 3.1).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { assertProjection } from '@keel-system/keel-core/gen/projection';
import { buildModel } from '@keel-system/keel-core/gen/model';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
import { GO_PROJECTION, UUID_V7_CALL, enumConstant, errorKindFor, goExported, goPackageName, goUnexported } from '../src/lib/go-projection.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

test('cumple el contrato de la proyección', () => {
  assert.doesNotThrow(() => assertProjection(GO_PROJECTION));
});

test('los tipos del DSL tienen su representación Go; ningún decimal es float', () => {
  const goOf = (base) => GO_PROJECTION.fieldType({ kind: 'base', base, constraints: {} });
  assert.equal(goOf('decimal').goType, 'wire.Decimal');
  assert.equal(goOf('int').goType, 'int32', 'el int del DSL es de 32 bits, como en Java y C#');
  assert.equal(goOf('long').goType, 'int64');
  assert.deepEqual(goOf('uuid'), { goType: 'uuid.UUID', goImports: ['github.com/google/uuid'] });
  assert.equal(goOf('date').goType, 'wire.Date');
  assert.deepEqual(goOf('timestamp'), { goType: 'time.Time', goImports: ['time'] });
  assert.deepEqual(goOf('json'), { goType: 'jsontext.Value', goImports: ['encoding/json/jsontext'] });
  assert.equal(GO_PROJECTION.fieldType({ kind: 'base', base: 'string', constraints: {} }, { list: true }).goType, '[]string');
  for (const base of ['string', 'text', 'int', 'long', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'json', 'file']) {
    assert.doesNotMatch(goOf(base).goType, /float/, base);
  }
});

test('los valores por defecto se escriben como literales Go que conservan lo declarado', () => {
  const init = (field, base) => GO_PROJECTION.fieldDetails(field, { kind: 'base', base, constraints: {} }, {}).initializer;
  // El texto conserva la escala: 2.50 no es 2.5.
  assert.equal(init({ default: '2.50' }, 'decimal'), 'wire.MustDecimal("2.50")');
  assert.equal(init({ default: 10 }, 'long'), '10');
  assert.equal(init({ default: 'x"y' }, 'string'), '"x\\"y"');
  assert.equal(init({ generated: true }, 'uuid'), UUID_V7_CALL);
  assert.equal(init({ generated: true }, 'timestamp'), 'time.Now().UTC()');
  assert.equal(GO_PROJECTION.fieldDetails({ default: 'in-stock' }, { kind: 'enum', name: 'Availability' }, {}).initializer, 'AvailabilityInStock');
});

test('los nombres: MixedCaps con las siglas en un solo caso, y sin palabras reservadas', () => {
  const cases = [
    ['customerId', 'CustomerID', 'customerID'],
    ['imageUrls', 'ImageURLs', 'imageURLs'],
    ['id', 'ID', 'id'],
    ['ids', 'IDs', 'ids'],
    ['httpClient', 'HTTPClient', 'httpClient'],
    ['apiKey', 'APIKey', 'apiKey'],
    ['customer-id', 'CustomerID', 'customerID'],
    ['sku', 'Sku', 'sku'],
    ['in-review', 'InReview', 'inReview'],
    ['type', 'Type', 'typ'],
    ['range', 'Range', 'rng'],
    ['select', 'Select', 'selectValue']
  ];
  for (const [name, exported, unexported] of cases) {
    assert.equal(goExported(name), exported, name);
    assert.equal(goUnexported(name), unexported, name);
  }
  assert.equal(enumConstant('OrderStatus', 'in-review'), 'OrderStatusInReview');
  assert.equal(goPackageName('product-catalog'), 'productcatalog');
});

test('el error de un code no hereda: su categoría sale de la jerarquía neutral', () => {
  assert.equal(errorKindFor(404), 'KindNotFound');
  assert.equal(errorKindFor(409), 'KindConflict');
  assert.equal(errorKindFor(422), 'KindBusiness');
  assert.equal(errorKindFor(418), 'KindDomain');
});

test('la ruta del módulo es el nombre del servicio', () => {
  assert.deepEqual(GO_PROJECTION.service({ service: { name: 'product-catalog' } }), { goModule: 'product-catalog' });
});

for (const fixture of fixtures) {
  test(`${fixture}: el modelo se construye con la proyección Go y nombra lo mismo que con las otras tres`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
    const stack = resolveStack(null, layers);
    const go = buildModel({ manifest, layers, stack, projection: GO_PROJECTION });
    const { JAVA_PROJECTION } = await import('../../keel-spring/src/lib/java-projection.js');
    const { TS_PROJECTION } = await import('../../keel-nest/src/lib/ts-projection.js');
    const { CS_PROJECTION } = await import('../../keel-dotnet/src/lib/cs-projection.js');
    const java = buildModel({ manifest, layers, stack, projection: JAVA_PROJECTION });
    const ts = buildModel({ manifest, layers, stack, projection: TS_PROJECTION });
    const cs = buildModel({ manifest, layers, stack, projection: CS_PROJECTION });
    assert.equal(go.service.projectName.replace(/-go$/, ''), java.service.projectName.replace(/-spring$/, ''));
    assert.deepEqual(go.entities.map((e) => e.name), java.entities.map((e) => e.name));
    const routes = (model) =>
      model.services.flatMap((group) => group.operations.map((op) => [op.name, op.http?.method ?? null, op.http?.path ?? null, op.successStatus ?? null]));
    assert.deepEqual(routes(go), routes(java));
    // Los avisos del modelo, los mismos que con las proyecciones de keel-nest y keel-dotnet: ninguna fixture dispara
    // los que nombran el framework de cada uno.
    assert.deepEqual(go.warnings, ts.warnings);
    assert.deepEqual(go.warnings, cs.warnings);
    assert.ok(go.entities.every((entity) => entity.fields.every((field) => typeof field.goType === 'string')), 'algún campo sin tipo Go');
    assert.ok(
      go.entities.every((entity) => entity.fields.every((field) => field.javaType === undefined && field.tsType === undefined && field.csType === undefined)),
      'se coló otro lenguaje'
    );
  });
}
