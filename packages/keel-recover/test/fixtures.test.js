// `keel-recover fixtures`: el estado de partida de los escenarios derivado del snapshot del legacy, con la forma de la
// exportación de shop-api (PostgreSQL, ids de secuencia, estados guardados como enteros, una contraseña que el diseño ya
// no lleva). Lo que se mide: la convención y sus excepciones, que los valores del legacy se traduzcan a los del diseño, y
// que nada se pierda en silencio (una columna sin mapear ni descartar, un valor sin traducción, una tabla que no está).

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFixtures } from 'keel-core';
import { deriveFixtures } from '../src/lib/fixtures.js';

const layers = {
  domain: {
    types: { OrderStatus: { values: ['NEW', 'FINISHED', 'CANCELED'] } },
    entities: {
      User: { fields: { id: { type: 'long', id: true, generated: true }, email: { type: 'string', required: true } } },
      Cart: {
        fields: { cartId: { type: 'long', id: true, computed: 'el id del usuario' } },
        relations: { user: { entity: 'User', cardinality: 'one-to-one', required: true }, products: { entity: 'Line', cardinality: 'one-to-many' } },
      },
      OrderMain: {
        fields: { orderId: { type: 'long', id: true, generated: true }, orderStatus: { type: 'OrderStatus', required: true }, orderAmount: { type: 'decimal', required: true }, createTime: { type: 'timestamp', generated: true } },
      },
      Line: {
        fields: { id: { type: 'long', id: true, generated: true }, count: { type: 'int', required: true }, version: { type: 'int', generated: true } },
        relations: { cart: { entity: 'Cart', cardinality: 'many-to-one' }, order: { entity: 'OrderMain', cardinality: 'many-to-one' } },
      },
    },
  },
  persistence: { default: { model: 'relational' }, entities: {} },
};

const exported = {
  users: [
    { id: 2147483642, email: 'customer1@email.com', password: '$2a$10$x', role: 'ROLE_CUSTOMER' },
    { id: 2147483641, email: 'manager1@email.com', password: '$2a$10$y', role: 'ROLE_MANAGER' },
  ],
  cart: [{ user_id: 2147483642 }],
  order_main: [{ order_id: 2147483648, order_status: 1, order_amount: 30.5, create_time: '2019-03-27T20:34:25.21' }],
  product_in_order: [{ id: 2147483650, count: 2, cart_user_id: null, order_id: 2147483648 }],
  _sequences: [{ name: 'hibernate_sequence', last_value: 1 }],
  $keys: { users: ['id'] },
};

const data = {
  User: { table: 'users', drop: ['password', 'role'] },
  Cart: { table: 'cart', columns: { cartId: 'user_id', user: 'user_id' } },
  OrderMain: { table: 'order_main', values: { orderStatus: { 0: 'NEW', 1: 'FINISHED', 2: 'CANCELED' } } },
  Line: { table: 'product_in_order', columns: { cart: 'cart_user_id' }, defaults: { version: 0 } },
};

test('del snapshot a los nombres del diseño: convención, columnas, valores, defaults y descartes', () => {
  const { doc, errors } = deriveFixtures({ exported, data, layers, source: { legacy: 'shop-api', snapshot: 'abc' } });
  assert.deepEqual(errors, []);
  assert.deepEqual(doc.source, { legacy: 'shop-api', snapshot: 'abc' });
  assert.deepEqual(doc.entities.User.records, [
    { id: 2147483641, email: 'manager1@email.com' },
    { id: 2147483642, email: 'customer1@email.com' },
  ], 'por id, sin la contraseña ni el rol');
  assert.deepEqual(doc.entities.Cart.records, [{ cartId: 2147483642, user: 2147483642 }], 'la clave compartida con el usuario');
  assert.deepEqual(doc.entities.OrderMain.records, [{ orderId: 2147483648, orderStatus: 'FINISHED', orderAmount: 30.5, createTime: '2019-03-27T20:34:25.21' }]);
  assert.deepEqual(doc.entities.Line.records, [{ id: 2147483650, count: 2, version: 0, cart: null, order: 2147483648 }]);
  assert.deepEqual(checkFixtures(layers, doc), [], 'y lo que sale casa con el diseño');
});

test('nada se pierde en silencio: columna sin decidir, valor sin traducción, tabla que no está, campo que no existe', () => {
  const broken = {
    ...data,
    User: { table: 'users', drop: ['password'] },
    OrderMain: { table: 'order_main', values: { orderStatus: { 0: 'NEW' } } },
    Ghost: { table: 'ghost' },
    Line: { table: 'lines', columns: { colour: 'x' } },
  };
  const { doc, errors } = deriveFixtures({ exported, data: broken, layers });
  assert.equal(doc, null, 'con errores no hay documento');
  const has = (pattern) => assert.ok(errors.some((e) => pattern.test(e)), `${pattern}\n${errors.join('\n')}`);
  has(/^data\.User: users tiene columnas que ni se mapean a un campo ni se descartan \(drop\): role$/);
  has(/^data\.OrderMain\.values\.orderStatus: el legacy guarda 1 en order_main\.order_status y el mapa no dice qué valor del diseño es$/);
  has(/^data\.Ghost: no es una entidad del dominio$/);
  has(/^data\.Line: el legacy no tiene la tabla lines \(las que hay: cart, order_main, product_in_order, users\)$/);
});
