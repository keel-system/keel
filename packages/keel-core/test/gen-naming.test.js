import test from 'node:test';
import assert from 'node:assert/strict';
import { pascalCase, camelCase, kebabCase, snakeCase, screamingSnake, pluralize, brokerSafeName } from '../src/lib/gen/naming.js';

test('pascalCase desde kebab, camel y snake', () => {
  assert.equal(pascalCase('product-catalog'), 'ProductCatalog');
  assert.equal(pascalCase('createProduct'), 'CreateProduct');
  assert.equal(pascalCase('dead_letter'), 'DeadLetter');
  assert.equal(pascalCase('Product'), 'Product');
});

test('camelCase y kebabCase', () => {
  assert.equal(camelCase('ProductCreated'), 'productCreated');
  assert.equal(kebabCase('ProductCreated'), 'product-created');
  assert.equal(kebabCase('retireProduct'), 'retire-product');
});

test('snakeCase y screamingSnake', () => {
  assert.equal(snakeCase('apiToken'), 'api_token');
  assert.equal(screamingSnake('draft'), 'DRAFT');
  assert.equal(screamingSnake('inReview'), 'IN_REVIEW');
});

test('pluralize con reglas simples', () => {
  assert.equal(pluralize('product'), 'products');
  assert.equal(pluralize('category'), 'categories');
  assert.equal(pluralize('box'), 'boxes');
  assert.equal(pluralize('batch'), 'batches');
});

test('brokerSafeName solo sanea donde el broker no admite el punto', () => {
  assert.equal(brokerSafeName('stock.events', 'kafka'), 'stock.events');
  assert.equal(brokerSafeName('stock.events', 'rabbitmq'), 'stock.events');
  assert.equal(brokerSafeName('stock.events', 'snssqs'), 'stock-events');
});
