// El modelo de keel-core/gen se construye SIN Java. Es la prueba de que la interpretación del
// diseño es neutral de verdad y no solo de nombre: con una proyección de juguete —que no es la de
// ningún lenguaje— el modelo de cada fixture se construye entero, y en lo que produce no aparece
// ni un tipo, ni un import, ni una anotación de Java. Si un día el modelo vuelve a escribir Java
// por su cuenta, este test lo dice antes que keel-nest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { PROJECTION_MEMBERS, PROJECTION_MESSAGES, assertProjection } from '../src/lib/gen/projection.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');
const fixtures = fs
  .readdirSync(FIXTURES_DIR)
  .filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')))
  .sort();

// Una proyección que no es de ningún lenguaje: escribe los tipos como `ref:<nombre>` y no pone
// anotaciones. Lo único que importa es que cumpla el contrato.
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
  uploadValidation: (required) => ({ validation: required ? ['required'] : [], inputValidation: required ? ['required'] : [] }),
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

function stackFor(layers) {
  const model = layers.persistence?.default?.model;
  return { ...STACK_DEFAULTS, database: defaultDatabaseFor(model) };
}

// Todo lo que el modelo produce, como texto, sin ciclos (el modelo los tiene a propósito).
function textOf(root) {
  const seen = new Set();
  const out = [];
  const walk = (value) => {
    if (typeof value === 'string') return out.push(value);
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) return [...value.entries()].forEach(([k, v]) => (walk(k), walk(v)));
    if (value instanceof Set) return [...value].forEach(walk);
    for (const [key, v] of Object.entries(value)) {
      out.push(key);
      walk(v);
    }
  };
  walk(root);
  return out;
}

// Lo que delataría que el modelo escribió Java por su cuenta.
const LEAKS = [/^java[A-Z]|javaType/, /\bjava\.(util|time|math)\b/, /^@[A-Z][A-Za-z]+/, /^List<|^Map</, /^(BigDecimal|LocalDate|Instant)$/, /Uuids\.v7|Instant\.now|new BigDecimal/];

test('el contrato de la proyección se comprueba entero al entrar', () => {
  assert.doesNotThrow(() => assertProjection(PROBE));
  assert.throws(() => assertProjection(null), /falta la proyección/);
  const { fieldType, ...sinTipo } = PROBE;
  assert.throws(() => assertProjection(sinTipo), /no implementa fieldType/);
  assert.throws(() => assertProjection({ ...PROBE, messages: {} }), /messages\.lockVersionReserved/);
  assert.ok(Object.keys(PROJECTION_MEMBERS).length >= 10);
  assert.ok(Object.keys(PROJECTION_MESSAGES).length >= 4);
});

test('buildModel exige proyección', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixtures[0]));
  assert.throws(() => buildModel({ manifest, layers, stack: stackFor(layers) }), /falta la proyección/);
});

for (const fixture of fixtures) {
  test(`${fixture}: el modelo se construye sin Java y no lo inventa`, () => {
    const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
    assert.deepEqual(errors, []);
    const model = buildModel({ manifest, layers, stack: stackFor(layers), projection: PROBE });
    assert.equal(model.service.projectName, `${model.service.artifactId}-probe`);
    assert.ok(model.services.length > 0 || model.subscriptions.length > 0, 'un modelo sin operaciones no prueba nada');
    const leaks = textOf(model).filter((text) => LEAKS.some((pattern) => pattern.test(text)));
    assert.deepEqual([...new Set(leaks)], [], 'el modelo escribió Java sin pedírselo a la proyección');
  });
}
