// La lectura de peticiones que emite keel-nest (infrastructure/rest/request-reading.ts), EJECUTADA:
// convierte lo que llega como lo convierte Spring y valida con los mensajes de Bean Validation. Un
// servidor que aceptara `?active=yes` y otro que respondiera 400 al mismo diseño no serían
// equivalentes, y eso no lo ve ninguna comparación de cadenas.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, transpileTree } from './helpers/emitted.js';

const tree = transpileTree(planFixture('product-catalog').files);
const reading = await tree.load('src/infrastructure/rest/request-reading.ts');
const errors = await tree.load('src/infrastructure/rest/request-errors.ts');
const { Decimal } = await tree.load('src/domain/support/decimal.ts');
const { ProductStatus } = await tree.load('src/domain/enums/product-status.ts');
const { text, json, Violations, bodyObject, requireParameter } = reading;

const malformed = (fn) => assert.throws(fn, errors.MalformedRequestError);

test('un booleano de query admite lo que admite Spring (true/on/yes/1, false/off/no/0) y vacío es sin valor', () => {
  for (const value of ['true', 'ON', 'yes', '1']) assert.equal(text.boolean(value), true, value);
  for (const value of ['false', 'Off', 'no', '0']) assert.equal(text.boolean(value), false, value);
  assert.equal(text.boolean(''), null);
  malformed(() => text.boolean('quizá'));
});

test('un uuid de ruta se lee como UUID.fromString de Java; en el cuerpo, solo en su forma canónica', () => {
  assert.equal(text.uuid('0192F1D2-0000-7000-8000-000000000001'), '0192f1d2-0000-7000-8000-000000000001');
  assert.equal(text.uuid('1-2-3-4-5'), '00000001-0002-0003-0004-000000000005');
  malformed(() => text.uuid('no-es-un-uuid'));
  malformed(() => text.uuid('123456789-0000-7000-8000-000000000001'));
  assert.equal(json.uuid('0192F1D2-0000-7000-8000-000000000001'), '0192f1d2-0000-7000-8000-000000000001');
  malformed(() => json.uuid('1-2-3-4-5'));
  malformed(() => json.uuid(42));
});

test('un enum se lee por su literal en el cuerpo; en la query, también por el nombre de la constante', () => {
  assert.equal(json.enumOf(ProductStatus)('active'), ProductStatus.ACTIVE);
  malformed(() => json.enumOf(ProductStatus)('ACTIVE'));
  assert.equal(text.enumOf(ProductStatus)('ACTIVE'), ProductStatus.ACTIVE);
  assert.equal(text.enumOf(ProductStatus)('retired'), ProductStatus.RETIRED);
  malformed(() => text.enumOf(ProductStatus)('borrado'));
});

test('un entero de query fuera de int32 o con decimales es malformado; un long cabe en 64 bits', () => {
  assert.equal(text.int('-2147483648'), -2147483648);
  malformed(() => text.int('2147483648'));
  malformed(() => text.int('1.5'));
  assert.equal(text.long('9223372036854775807'), 9223372036854775807n);
  malformed(() => text.long('9223372036854775808'));
});

test('el cuerpo: sin cuerpo solo si es opcional; un array no es un objeto; un tipo que no encaja es malformado', () => {
  assert.deepEqual(bodyObject(undefined, false), {});
  malformed(() => bodyObject(undefined, true));
  malformed(() => bodyObject([], false));
  malformed(() => json.string(3));
  malformed(() => json.boolean('true'));
});

test('falta un parámetro obligatorio solo si NO viene; vacío cuenta como presente', () => {
  assert.throws(() => requireParameter({}, 'q'), (error) => error instanceof errors.MissingParameterError && error.message === "Falta el parámetro 'q' en la petición");
  assert.doesNotThrow(() => requireParameter({ q: '' }, 'q'));
});

test('las violaciones salen todas juntas, «campo mensaje», con los mensajes de Hibernate Validator', () => {
  const violations = new Violations('body')
    .check('sku', '  ', [{ rule: 'notBlank' }, { rule: 'size', min: null, max: 8 }])
    .check('name', 'x'.repeat(10), [{ rule: 'size', min: 2, max: 5 }])
    .check('code', 'abc', [{ rule: 'pattern', regexp: '[A-Z]+' }])
    .check('price', null, [{ rule: 'notNull' }])
    .check('tags', [], [{ rule: 'notEmpty' }])
    .check('quantity', 0, [{ rule: 'min', value: 1, decimal: false }])
    .check('amount', Decimal.parse('100.50'), [{ rule: 'max', value: '100', decimal: true }])
    .check('total', Decimal.parse('1.234'), [{ rule: 'digits', integer: 17, fraction: 2 }])
    .check('ok', 'ABC', [{ rule: 'pattern', regexp: '[A-Z]+' }]);
  assert.throws(
    () => violations.throwIfAny(),
    (error) => {
      assert.ok(error instanceof errors.RequestValidationError);
      assert.equal(error.source, 'body');
      assert.deepEqual(error.details, [
        'sku must not be blank',
        'name size must be between 2 and 5',
        'code must match "[A-Z]+"',
        'price must not be null',
        'tags must not be empty',
        'quantity must be greater than or equal to 1',
        'amount must be less than or equal to 100',
        'total numeric value out of bounds (<17 digits>.<2 digits> expected)'
      ]);
      return true;
    }
  );
});

test('un valor ausente no viola más regla que la de presencia (como Bean Validation)', () => {
  assert.doesNotThrow(() =>
    new Violations('params')
      .check('q', null, [{ rule: 'size', min: 3, max: 5 }, { rule: 'pattern', regexp: 'x' }, { rule: 'min', value: 1, decimal: false }])
      .throwIfAny()
  );
});

test('un value object del cuerpo que su constructor rechaza es una petición malformada', async () => {
  const { readMoney } = await tree.load('src/infrastructure/rest/value-readers.ts');
  // Lo que llega es lo que deja el lector del cable: los números con su texto fuente.
  const { parseWireJson } = await tree.load('src/application/support/wire.ts');
  assert.equal(readMoney(parseWireJson('{"amount":3,"currency":"EUR"}')).amount.toString(), '3.00');
  malformed(() => readMoney(parseWireJson('{"amount":3}')));
  malformed(() => readMoney(parseWireJson('{"amount":-1,"currency":"EUR"}')));
  malformed(() => readMoney('3 EUR'));
  assert.equal(readMoney(null), null);
});

test('la prueba emitida de la API ejercita, con el diseño de referencia, los cinco caminos del contrato', async () => {
  const { apiCases } = await import('../src/scaffold/api-tests.js');
  const { model, files } = planFixture('product-catalog', { withoutLayers: ['persistence'] });
  assert.deepEqual(Object.keys(apiCases(model)).sort(), ['invalidBody', 'malformedBody', 'malformedPath', 'reachesHandler', 'wrongMethod']);
  const emitted = files.find((file) => file.path === 'test/api.test.ts').content;
  assert.equal((emitted.match(/^ {2}it\(/gm) ?? []).length, 7);
});
