import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pascalCase,
  camelCase,
  kebabCase,
  snakeCase,
  screamingSnake,
  pluralize,
  basePackage,
  packageToPath
} from '../src/lib/naming.js';

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

test('basePackage combina domain y nombre sin guiones', () => {
  assert.equal(
    basePackage({ service: { name: 'product-catalog', domain: 'commerce' } }),
    'com.commerce.productcatalog'
  );
  assert.equal(basePackage({ service: { name: 'demo' } }), 'com.app.demo');
});

test('basePackage respeta el grupo introducido por el usuario', () => {
  assert.equal(
    basePackage({ service: { name: 'product-catalog', domain: 'commerce' } }, 'com.example'),
    'com.example.productcatalog'
  );
  // Grupo inválido → cae al default com.<domain>.
  assert.equal(basePackage({ service: { name: 'demo', domain: 'shop' } }, 'Com.BAD'), 'com.shop.demo');
});

test('packageToPath', () => {
  assert.equal(packageToPath('com.commerce.productcatalog'), 'com/commerce/productcatalog');
});
