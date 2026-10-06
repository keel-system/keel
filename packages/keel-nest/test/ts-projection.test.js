// La proyección TypeScript cumple el contrato de keel-core/gen/projection.js y construye el modelo
// de TODAS las fixtures compartidas —también las que keel-nest todavía no sabe generar—: el modelo
// es neutral y no depende de la frontera del generador. Y donde los dos generadores deben decir lo
// mismo (el nombre del proyecto salvo el sufijo, las entidades, las operaciones), lo dicen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { assertProjection } from 'keel-core/gen/projection';
import { buildModel } from 'keel-core/gen/model';
import { resolveStack } from 'keel-core/gen/stack';
import { TS_PROJECTION } from '../src/lib/ts-projection.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

test('cumple el contrato de la proyección', () => {
  assert.doesNotThrow(() => assertProjection(TS_PROJECTION));
});

test('los tipos del DSL tienen su representación TS; ninguno decimal es number', () => {
  const tsOf = (base) => TS_PROJECTION.fieldType({ kind: 'base', base, constraints: {} }).tsType;
  assert.equal(tsOf('decimal'), 'Decimal');
  assert.equal(tsOf('long'), 'bigint');
  assert.equal(tsOf('timestamp'), 'Date');
  assert.equal(tsOf('uuid'), 'string');
  assert.equal(TS_PROJECTION.fieldType({ kind: 'base', base: 'string', constraints: {} }, { list: true }).tsType, 'string[]');
  assert.deepEqual(TS_PROJECTION.fieldType({ kind: 'base', base: 'decimal', constraints: {} }).imports, [{ symbol: 'Decimal', from: 'src/domain/support/decimal.js' }]);
  assert.equal(tsOf('json'), 'RawJson');
});

for (const fixture of fixtures) {
  test(`${fixture}: el modelo se construye con la proyección TS y nombra lo mismo que con la de Java`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
    const stack = resolveStack(null, layers);
    const ts = buildModel({ manifest, layers, stack, projection: TS_PROJECTION });
    const { JAVA_PROJECTION } = await import('../../keel-spring/src/lib/java-projection.js');
    const java = buildModel({ manifest, layers, stack, projection: JAVA_PROJECTION });
    // Mismo servicio salvo el sufijo del proyecto, mismas entidades, mismas operaciones con las
    // mismas rutas y los mismos status: es el principio de la equivalencia.
    assert.equal(ts.service.projectName.replace(/-nest$/, ''), java.service.projectName.replace(/-spring$/, ''));
    assert.deepEqual(ts.entities.map((e) => e.name), java.entities.map((e) => e.name));
    const routes = (model) =>
      model.services.flatMap((group) => group.operations.map((op) => [op.name, op.http?.method ?? null, op.http?.path ?? null, op.successStatus ?? null]));
    assert.deepEqual(routes(ts), routes(java));
    assert.deepEqual(ts.warnings, java.warnings.map((w) => w.replace(/@Version de JPA/, '@VersionColumn de TypeORM').replace(/keel-spring-/g, 'keel-nest-')));
  });
}
