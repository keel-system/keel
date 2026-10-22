exports.seed = (knex) => knex('orders').insert([{ sku: 'SKU-1', price: 10 }]);
