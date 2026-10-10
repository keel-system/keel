// El code de la carrera y de la clave reutilizada, OPERACIÓN A OPERACIÓN (keel-core/gen/declared-errors.js,
// `idempotencyOutcomeCodes`). El override es de la operación que lo declara: con la búsqueda sobre todos los
// errores del servicio, el PRODUCT_KEY_IN_PROGRESS de createProduct salía también en la carrera de
// removeProductImage (corrida catalog de keel-nest, FL-IMG-001-G).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { idempotencyOutcomeCodes } from '../src/lib/gen/declared-errors.js';
import { FRAMEWORK_ERRORS } from '../src/lib/framework-errors.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

const nameOf = (resolved) => resolved.name ?? resolved.base;
const PROBE = {
  projectSuffix: 'probe',
  service: () => ({ module: 'probe' }),
  parameterType: (type) => ({ typeRef: `ref:${type}` }),
  fieldType: (resolved, { list = false } = {}) => ({ typeRef: `ref:${nameOf(resolved)}${list ? '[]' : ''}` }),
  elementType: (resolved) => ({ elementRef: `ref:${nameOf(resolved)}` }),
  namedType: (name, { list = false } = {}) => ({ typeRef: `ref:${name}${list ? '[]' : ''}` }),
  namedElement: (name) => ({ elementRef: `ref:${name}` }),
  renamed: (name) => ({ typeRef: `ref:${name}`, elementRef: `ref:${name}` }),
  typeNameOf: (field) => field?.typeRef?.replace(/^ref:/, ''),
  carryType: (field) => ({ typeRef: field.typeRef }),
  uploadType: () => ({ typeRef: 'ref:upload', elementRef: 'ref:upload' }),
  uploadValidation: () => ({ validation: [], inputValidation: [] }),
  replicaKey: (keyField) => ({ keyRef: keyField?.typeRef ?? 'ref:uuid' }),
  errorBase: (http) => `error-${http}`,
  fieldDetails: () => ({ validation: [], numeric: null, inputValidation: [], inheritedPattern: null, columns: [], elementColumns: [], initializer: null }),
  messages: {
    lockVersionReserved: (entity) => `lockVersion reservado en ${entity}`,
    readQueriesRef: (kind) => `lecturas-${kind}`,
    pathParamFallback: (op, route, name) => `${op}: ${route} sin ${name}`,
    cognitoEmulated: () => 'cognito emulado'
  }
};

function modelOf(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model), cache: 'redis' };
  return buildModel({ manifest, layers, stack, projection: PROBE });
}

test('la carrera lleva el code que declara SU operación, y la que no declara nada lleva el canónico', () => {
  const rows = idempotencyOutcomeCodes(modelOf('catalog-extended'), FRAMEWORK_ERRORS.idempotencyRace);
  assert.deepEqual(rows, [
    { operation: 'createProduct', code: 'PRODUCT_KEY_IN_PROGRESS', declared: true },
    { operation: 'removeProductImage', code: FRAMEWORK_ERRORS.idempotencyRace.code, declared: false }
  ]);
});

test('la clave reutilizada sigue la misma regla', () => {
  const rows = idempotencyOutcomeCodes(modelOf('catalog-extended'), FRAMEWORK_ERRORS.idempotencyReuse);
  assert.deepEqual(rows.map((row) => [row.operation, row.code]), [
    ['createProduct', 'PRODUCT_KEY_REUSED'],
    ['removeProductImage', FRAMEWORK_ERRORS.idempotencyReuse.code]
  ]);
});

test('una operación cuya guarda es la clave natural no tiene registro, así que no tiene desenlace que nombrar', () => {
  for (const name of ['notification-mailer', 'stock-reservation', 'asset-vault']) {
    const model = modelOf(name);
    const guarded = model.services.flatMap((service) => service.operations).filter((operation) => operation.idempotency?.guard === 'natural-key');
    const rows = idempotencyOutcomeCodes(model, FRAMEWORK_ERRORS.idempotencyRace).map((row) => row.operation);
    for (const operation of guarded) assert.ok(!rows.includes(operation.name), `${name}: ${operation.name}`);
  }
});
