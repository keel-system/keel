// El documento de la persistencia documental como datos (keel-core/gen/document.js): la forma de cada
// documento, la representación física de cada base, las rutas y los índices. Lo que se compara con lo
// que EMITE keel-spring está en keel-spring/test/document-parity.test.js; aquí, los invariantes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_TYPES } from '../src/lib/gen/types.js';
import {
  DOCUMENT_STORAGE,
  documentShape,
  documentValueObjects,
  valueObjectShape,
  documentPathsFor,
  documentIndexSpecs,
  documentIndexes,
  partialDocumentIndexSpecs,
  nestedIndexWarnings,
  storeDocumentIndexes,
  exportIndexesScript
} from '../src/lib/gen/document.js';
import { persistedMembers } from '../src/lib/gen/relational.js';

const scalar = (name, base, extra = {}) => ({ name, kind: 'base', base, list: false, namedType: null, isId: false, required: false, unique: false, fold: null, ...extra });

// Un diseño sintético con todas las formas de miembro: id, escalares de cada base, un enum, un value
// object (con otro dentro), una lista de value objects, una lista de escalares, una referencia a otro
// agregado, una hija uno-a-muchos con su puntero de vuelta y un campo plegado.
function model(overrides = {}) {
  const money = { name: 'Money', fields: [scalar('amount', 'decimal', { required: true }), scalar('currency', 'string')] };
  const price = { name: 'Price', fields: [{ ...scalar('net', null), kind: 'composite', namedType: 'Money' }, scalar('taxRate', 'decimal')] };
  const tag = { name: 'Tag', fields: [scalar('label', 'string')] };
  const order = {
    name: 'Order',
    persisted: true,
    isAggregateRoot: true,
    collectionName: 'orders',
    rootEntity: 'Order',
    usesOptimisticLocking: true,
    declaresLockVersion: false,
    naturalKey: ['reference'],
    indexes: [
      { fields: ['status'], unique: false },
      { fields: ['customerId', 'reference'], unique: true, when: { field: 'status', equals: 'open' } }
    ],
    fields: [
      scalar('id', 'uuid', { isId: true }),
      scalar('reference', 'string', { unique: true, fold: { shadow: 'referenceNormalized', accents: false, maxLength: 40 } }),
      { ...scalar('status', null), kind: 'enum', namedType: 'OrderStatus' },
      scalar('placedOn', 'date'),
      scalar('placedAt', 'timestamp'),
      scalar('quantity', 'int'),
      scalar('sequence', 'long'),
      scalar('urgent', 'boolean'),
      scalar('notes', 'text'),
      scalar('extra', 'json'),
      { ...scalar('price', null), kind: 'composite', namedType: 'Price' },
      { ...scalar('tags', null), kind: 'composite', namedType: 'Tag', list: true },
      scalar('codes', 'string', { list: true })
    ],
    relations: [
      { name: 'customer', entity: 'Customer', cardinality: 'many-to-one', internal: false },
      { name: 'lines', entity: 'OrderLine', cardinality: 'one-to-many', internal: true }
    ]
  };
  const line = {
    name: 'OrderLine',
    persisted: true,
    isAggregateRoot: false,
    collectionName: 'order_lines',
    rootEntity: 'Order',
    naturalKey: ['sku'],
    indexes: [],
    fields: [scalar('id', 'uuid', { isId: true }), scalar('sku', 'string')],
    relations: [{ name: 'order', entity: 'Order', cardinality: 'many-to-one', internal: true, backReference: true }]
  };
  return {
    service: { name: 'order-desk' },
    layersPresent: { persistence: true },
    persistenceKind: 'document',
    valueObjects: [money, price, tag],
    enums: [{ name: 'OrderStatus', values: [{ literal: 'open', constant: 'OPEN' }, { literal: 'closed', constant: 'CLOSED' }] }],
    entities: [order, line],
    audit: { timestamps: 'all', authorship: 'none' },
    services: [],
    warnings: [],
    ...overrides
  };
}

const byName = (shape) => Object.fromEntries(shape.map((entry) => [entry.name, entry]));

test('toda base del DSL tiene representación física, y las que importan son las del contrato', () => {
  assert.deepEqual(Object.keys(DOCUMENT_STORAGE).sort(), [...BASE_TYPES].sort());
  assert.equal(DOCUMENT_STORAGE.decimal, 'decimal128', 'un decimal como texto ordena lexicográficamente');
  assert.equal(DOCUMENT_STORAGE.uuid, 'uuid');
  assert.equal(DOCUMENT_STORAGE.timestamp, 'date');
  assert.equal(DOCUMENT_STORAGE.date, 'date');
  assert.equal(DOCUMENT_STORAGE.json, 'string');
});

test('la raíz: _id, snake_case, sombra plegada, subdocumentos, arrays, referencia, versión y auditoría', () => {
  const m = model();
  const shape = byName(documentShape(m, m.entities[0]));
  assert.deepEqual(Object.keys(shape), [
    '_id', 'reference', 'reference_normalized', 'status', 'placed_on', 'placed_at', 'quantity', 'sequence', 'urgent',
    'notes', 'extra', 'price', 'tags', 'codes', 'customer_id', 'lines', 'lock_version', 'created_at', 'updated_at'
  ]);
  assert.equal(shape._id.storage, 'uuid');
  assert.equal(shape.status.storage, 'string', 'un enum se guarda por su constante');
  assert.equal(shape.placed_on.storage, 'date');
  assert.equal(shape.quantity.storage, 'int');
  assert.equal(shape.sequence.storage, 'long');
  assert.equal(shape.urgent.storage, 'bool');
  assert.deepEqual([shape.reference_normalized.kind, shape.reference_normalized.of], ['folded', 'reference']);
  assert.deepEqual([shape.price.kind, shape.price.valueObject], ['subdocument', 'Price']);
  assert.deepEqual([shape.tags.kind, shape.tags.element], ['array', { valueObject: 'Tag' }]);
  assert.deepEqual(shape.codes.element, { storage: 'string' });
  assert.deepEqual([shape.customer_id.kind, shape.customer_id.storage], ['ref', 'uuid']);
  assert.deepEqual([shape.lines.kind, shape.lines.element], ['array', { entity: 'OrderLine' }]);
  assert.deepEqual([shape.lock_version.kind, shape.lock_version.storage], ['version', 'long']);
  assert.deepEqual([shape.created_at.role, shape.updated_at.role], ['createdDate', 'lastModifiedDate']);
});

test('la hija anidada: su id también es _id, sin puntero de vuelta, sin versión ni auditoría de política', () => {
  const m = model();
  assert.deepEqual(documentShape(m, m.entities[1]).map((entry) => entry.name), ['_id', 'sku']);
});

test('la versión la pone el diseño si declara lockVersion, y sin bloqueo no hay versión', () => {
  const declared = model();
  declared.entities[0].declaresLockVersion = true;
  assert.ok(!documentShape(declared, declared.entities[0]).some((entry) => entry.kind === 'version'));
  const none = model();
  none.entities[0].usesOptimisticLocking = false;
  assert.ok(!documentShape(none, none.entities[0]).some((entry) => entry.name === 'lock_version'));
});

test('los value objects con subdocumento se alcanzan transitivamente, en orden estable', () => {
  const m = model();
  assert.deepEqual([...documentValueObjects(m)].map((vo) => vo.name), ['Price', 'Money', 'Tag']);
  assert.deepEqual(
    valueObjectShape(m.valueObjects[1]).map((entry) => [entry.name, entry.kind, entry.storage ?? entry.valueObject]),
    [['net', 'subdocument', 'Money'], ['tax_rate', 'scalar', 'decimal128']]
  );
});

test('las rutas: un value object es un subdocumento y una hija se atraviesa', () => {
  const m = model();
  const [order] = m.entities;
  const members = persistedMembers(m, order);
  const paths = (name) => documentPathsFor(m, order, members, name, m.warnings);
  assert.deepEqual(paths('price.taxRate'), ['price.tax_rate']);
  assert.deepEqual(paths('price'), ['price.net', 'price.tax_rate']);
  assert.deepEqual(paths('customerId'), ['customer_id']);
  assert.deepEqual(paths('lines.sku'), ['lines.sku']);
  assert.deepEqual(paths('codes'), ['codes']);
  assert.equal(m.warnings.length, 0);
  assert.deepEqual(paths('ghost'), ['ghost']);
  assert.match(m.warnings[0], /"ghost", que no es un campo/);
});

test('los índices: la clave natural por la sombra plegada, el único y el parcial por la CONSTANTE', () => {
  const m = model();
  const specs = documentIndexSpecs(m, m.entities[0], m.warnings);
  assert.deepEqual(
    specs.map((spec) => [spec.name, spec.unique, spec.paths, spec.partialFilter]),
    [
      ['uk_orders_natural', true, ['reference_normalized'], null],
      ['idx_orders_status', false, ['status'], null],
      ['uk_orders_customer_id_reference', true, ['customer_id', 'reference'], { path: 'status', equals: 'OPEN' }]
    ]
  );
  const [partial] = partialDocumentIndexSpecs(m);
  assert.equal(partial.collection, 'orders');
  assert.equal(partial.naturalKeyName, 'uk_orders_natural');
  assert.deepEqual(partial.partialFilter, { path: 'status', equals: 'OPEN' });
});

test('una hija con clave natural no crea índice: se avisa de dónde queda la garantía', () => {
  const m = model();
  const [warning] = nestedIndexWarnings(m);
  assert.match(warning, /OrderLine: declara naturalKey.*anidada dentro del documento de Order/);
  assert.deepEqual(documentIndexes(m).map((entry) => entry.collection), ['orders']);
});

test('los índices de los almacenes salen con el mecanismo que los usa, y ninguno es único', () => {
  assert.deepEqual(storeDocumentIndexes(model()), []);
  const busy = model({
    layersPresent: { persistence: true, messaging: true },
    messaging: { reliability: 'outbox' },
    events: [{ name: 'OrderPlaced' }],
    subscriptions: [{ name: 'onPayment' }],
    services: [
      {
        operations: [
          { name: 'placeOrder', idempotency: { keySource: 'client-key' } },
          { name: 'sweep', reconciles: [{ claim: { entity: 'Order' } }] }
        ]
      }
    ]
  });
  const stores = storeDocumentIndexes(busy);
  assert.deepEqual(stores.map((entry) => entry.collection), ['outbox_event', 'processed_event', 'idempotency_record', 'reconciliation_claim']);
  assert.ok(stores.every((entry) => entry.specs.every((spec) => spec.unique === false)));
  assert.deepEqual(stores[0].specs[0].paths, ['published_at', 'created_at'], 'el orden del reclamo del relay');
  // Con la clave natural como guarda no hay registro de claves que indexar.
  busy.services[0].operations[0].idempotency.guard = 'natural-key';
  assert.ok(!storeDocumentIndexes(busy).some((entry) => entry.collection === 'idempotency_record'));
});

test('export-indexes.sh nombra las piezas de la plataforma y la base del servicio', () => {
  const script = exportIndexesScript(model(), { indexCreator: 'IndexCreator', errorTranslator: 'ErrorFilter' });
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /DB="order_desk"/);
  assert.match(script, /exec -i "order-desk-db" mongosh/);
  assert.match(script, /Cada uk_\*\/idx_\* de IndexCreator/);
  assert.match(script, /no lo conoce el ErrorFilter/);
  assert.doesNotMatch(script, /undefined/);
});
