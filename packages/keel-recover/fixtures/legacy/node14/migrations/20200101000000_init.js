exports.up = (knex) => knex.schema.createTable('orders', (t) => { t.increments('id'); t.string('sku'); t.decimal('price'); });
exports.down = (knex) => knex.schema.dropTable('orders');
