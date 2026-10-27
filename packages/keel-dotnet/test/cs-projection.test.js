// La proyección C# cumple el contrato de keel-core/gen/projection.js y construye el modelo de TODAS las
// fixtures compartidas —también las que keel-dotnet todavía no sabe generar—: el modelo es neutral y no
// depende de la frontera del generador. Y donde los tres generadores deben decir lo mismo (el nombre del
// proyecto salvo el sufijo, las entidades, las operaciones con sus rutas y status, los avisos), lo dicen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { assertProjection } from '@keel-system/keel-core/gen/projection';
import { buildModel } from '@keel-system/keel-core/gen/model';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
import { CS_PROJECTION, UUID_V7_CALL } from '../src/lib/cs-projection.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

test('cumple el contrato de la proyección', () => {
  assert.doesNotThrow(() => assertProjection(CS_PROJECTION));
});

test('los tipos del DSL tienen su representación C#; ningún decimal es double', () => {
  const csOf = (base) => CS_PROJECTION.fieldType({ kind: 'base', base, constraints: {} }).csType;
  assert.equal(csOf('decimal'), 'decimal');
  assert.equal(csOf('long'), 'long');
  assert.equal(csOf('uuid'), 'Guid');
  assert.equal(csOf('date'), 'DateOnly');
  assert.equal(csOf('timestamp'), 'DateTimeOffset');
  assert.equal(csOf('json'), 'JsonElement');
  assert.deepEqual(CS_PROJECTION.fieldType({ kind: 'base', base: 'json', constraints: {} }).usings, ['System.Text.Json']);
  assert.equal(CS_PROJECTION.fieldType({ kind: 'base', base: 'string', constraints: {} }, { list: true }).csType, 'IReadOnlyList<string>');
});

test('los valores por defecto se escriben como literales C# que conservan lo declarado', () => {
  const init = (field, base) => CS_PROJECTION.fieldDetails(field, { kind: 'base', base, constraints: {} }, {}).initializer;
  // El sufijo m conserva la escala: 2.50m no es 2.5m.
  assert.equal(init({ default: '2.50' }, 'decimal'), '2.50m');
  assert.equal(init({ default: 10 }, 'long'), '10L');
  assert.equal(init({ default: 'x"y' }, 'string'), '"x\\"y"');
  assert.equal(init({ generated: true }, 'uuid'), UUID_V7_CALL);
  assert.equal(CS_PROJECTION.fieldDetails({ default: 'in-stock' }, { kind: 'enum', name: 'Availability' }, {}).initializer, 'Availability.InStock');
});

test('el namespace raíz sale del nombre del servicio', () => {
  assert.deepEqual(CS_PROJECTION.service({ service: { name: 'product-catalog' } }), { rootNamespace: 'ProductCatalog' });
});

for (const fixture of fixtures) {
  test(`${fixture}: el modelo se construye con la proyección C# y nombra lo mismo que con las de Java y TypeScript`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
    const stack = resolveStack(null, layers);
    const cs = buildModel({ manifest, layers, stack, projection: CS_PROJECTION });
    const { JAVA_PROJECTION } = await import('../../keel-spring/src/lib/java-projection.js');
    const { TS_PROJECTION } = await import('../../keel-nest/src/lib/ts-projection.js');
    const java = buildModel({ manifest, layers, stack, projection: JAVA_PROJECTION });
    const ts = buildModel({ manifest, layers, stack, projection: TS_PROJECTION });
    // Mismo servicio salvo el sufijo del proyecto, mismas entidades, mismas operaciones con las mismas rutas
    // y los mismos status: es el principio de la equivalencia.
    assert.equal(cs.service.projectName.replace(/-dotnet$/, ''), java.service.projectName.replace(/-spring$/, ''));
    assert.deepEqual(cs.entities.map((e) => e.name), java.entities.map((e) => e.name));
    const routes = (model) =>
      model.services.flatMap((group) => group.operations.map((op) => [op.name, op.http?.method ?? null, op.http?.path ?? null, op.successStatus ?? null]));
    assert.deepEqual(routes(cs), routes(java));
    // Los avisos del modelo, los mismos que con la proyección de keel-nest: ninguna fixture dispara los que
    // nombran el framework de cada uno.
    assert.deepEqual(cs.warnings, ts.warnings);
    assert.ok(cs.entities.every((entity) => entity.fields.every((field) => typeof field.csType === 'string')), 'algún campo sin tipo C#');
    assert.ok(cs.entities.every((entity) => entity.fields.every((field) => field.javaType === undefined && field.tsType === undefined)), 'se coló otro lenguaje');
  });
}
