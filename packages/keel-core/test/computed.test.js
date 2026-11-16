// Los derivados estructurados (DSL 2.31, `computed: { sum, times }` y `{ count }`): la resolución del derivado y la
// aritmética de D5, que es la referencia que las redes de los cuatro generadores comparan. Los vectores del sujeto y
// sus sabotajes se ejecutan en entity-checks.test.js; aquí, la aritmética en los bordes.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/lib/loader.js';
import {
  computedSpec, computedFieldsOf, evaluateComputed, parseDecimal, roundDecimal, formatDecimal, compareDecimals,
  computedHandlerNote, INTEGER_LIMITS
} from '../src/lib/gen/computed.js';
import { INVARIANT_VIOLATED } from '../src/lib/gen/entity-checks.js';
import { ENTITY_CHECK_DESIGNS } from './helpers/entity-check-designs.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function subjectDomain() {
  const design = ENTITY_CHECK_DESIGNS[0];
  const { layers } = loadService(path.join(FIXTURES, design.from));
  design.mutate(layers);
  return layers.domain;
}

test('computedSpec resuelve la suma con su factor y la escala del resultado, y el count', () => {
  const domain = subjectDomain();
  assert.deepEqual({ ...computedSpec(domain, 'Product', 'printTotal') }, {
    kind: 'sum', relation: 'images', child: 'ProductImage', field: 'printPrice', times: 'copies', base: 'decimal', scale: 2
  });
  assert.deepEqual({ ...computedSpec(domain, 'Product', 'imageCount') }, {
    kind: 'count', relation: 'images', child: 'ProductImage', field: null, times: null, base: 'int', scale: null
  });
  assert.equal(computedSpec(domain, 'Product', 'name'), null);
  assert.deepEqual(computedFieldsOf(domain, 'Product').map(({ fieldName }) => fieldName), ['printTotal', 'imageCount']);
});

test('un computed en prosa no es un derivado estructurado', () => {
  const { layers } = loadService(path.join(FIXTURES, 'shop-api'));
  assert.equal(computedSpec(layers.domain, 'OrderMain', 'orderAmount'), null);
});

test('decimales exactos: lectura, redondeo HALF_UP y HALF_EVEN, texto con su escala y comparación', () => {
  assert.deepEqual(parseDecimal('-1.250'), { units: -1250n, scale: 3 });
  assert.deepEqual(roundDecimal({ units: 2465n, scale: 3 }, 2), { units: 247n, scale: 2 });
  assert.deepEqual(roundDecimal({ units: 2465n, scale: 3 }, 2, 'HALF_EVEN'), { units: 246n, scale: 2 });
  assert.deepEqual(roundDecimal({ units: -2465n, scale: 3 }, 2), { units: -247n, scale: 2 });
  assert.equal(formatDecimal({ units: 5n, scale: 2 }), '0.05');
  assert.equal(formatDecimal({ units: -240n, scale: 2 }), '-2.40');
  assert.equal(compareDecimals('1.10', '1.1'), 0);
  assert.equal(compareDecimals('0.99', '1'), -1);
  assert.throws(() => parseDecimal('1e3'), /no es un número decimal/);
});

test('una suma de enteros es exacta y desborda en el límite de su tipo', () => {
  const spec = { kind: 'sum', relation: 'lines', field: 'qty', times: null, base: 'int', scale: null };
  assert.deepEqual(evaluateComputed(spec, [{ qty: 2 }, { qty: 3 }]), { value: 5 });
  const max = Number(INTEGER_LIMITS.int.max);
  assert.deepEqual(evaluateComputed(spec, [{ qty: max }]), { value: max });
  assert.deepEqual(evaluateComputed(spec, [{ qty: max }, { qty: 1 }]), { error: INVARIANT_VIOLATED });
  const long = { ...spec, base: 'long' };
  assert.deepEqual(evaluateComputed(long, [{ qty: max }, { qty: 1 }]), { value: max + 1 });
});

test('la suma de un decimal sin escala declarada redondea a entero', () => {
  const spec = { kind: 'sum', relation: 'lines', field: 'amount', times: null, base: 'decimal', scale: null };
  assert.deepEqual(evaluateComputed(spec, [{ amount: '1.5' }]), { value: '2' });
});

test('la nota del handler nombra cada derivado', () => {
  assert.match(computedHandlerNote(subjectDomain(), 'Product'), /printTotal \(sum de images\.printPrice × copies\), imageCount \(count de images\)/);
  assert.equal(computedHandlerNote(subjectDomain(), 'ProductImage'), null);
});
