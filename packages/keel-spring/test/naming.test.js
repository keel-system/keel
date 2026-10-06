import test from 'node:test';
import assert from 'node:assert/strict';
import { basePackage, packageToPath } from '../src/lib/naming.js';

// Las formas neutrales (pascal, kebab, snake, plural…) viven en keel-core/gen y se prueban allí.
// Aquí solo lo propio de Java: el paquete base y su ruta.

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
