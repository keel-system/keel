// Los almacenes de la mensajería como DATOS (keel-core/gen/messaging-stores.js). Lo que aquí se fija es
// la forma que el servidor de cada generador tiene que crear; que keel-spring la emita lo comprueba
// `keel-spring/test/messaging-stores-parity.test.js`, y keel-nest su `schema-parity`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTBOX_EVENT,
  OUTBOX_LAST_ERROR_LENGTH,
  OUTBOX_PURGE,
  OUTBOX_RELAY,
  PROCESSED_EVENT,
  PROCESSED_EVENT_PURGE,
  outboxBackoffMs,
  outboxDeadLettered,
  parameterValue,
  storeColumns,
  usesMessageDeduplication,
  usesOutbox
} from '../src/lib/gen/messaging-stores.js';

const model = (over = {}) => ({
  layersPresent: { messaging: true, persistence: true },
  messaging: { reliability: 'outbox' },
  events: [{ name: 'Placed' }],
  subscriptions: [{ name: 'onPaid' }],
  ...over
});

test('outbox: necesita persistencia, reliability outbox y eventos', () => {
  assert.equal(usesOutbox(model()), true);
  assert.equal(usesOutbox(model({ layersPresent: { messaging: true } })), false);
  assert.equal(usesOutbox(model({ messaging: { reliability: 'best-effort' } })), false);
  assert.equal(usesOutbox(model({ events: [] })), false);
});

test('deduplicación de mensajes: toda suscripción con persistencia', () => {
  assert.equal(usesMessageDeduplication(model()), true);
  assert.equal(usesMessageDeduplication(model({ subscriptions: [] })), false);
  assert.equal(usesMessageDeduplication(model({ layersPresent: { messaging: true } })), false);
});

test('outbox_event: columnas, clave e índice de pendientes', () => {
  assert.equal(OUTBOX_EVENT.table, 'outbox_event');
  assert.deepEqual(
    storeColumns(OUTBOX_EVENT).map((c) => c.name),
    ['id', 'destination', 'routing_key', 'event_type', 'payload', 'created_at', 'published_at', 'attempts', 'next_attempt_at', 'last_error']
  );
  assert.deepEqual(OUTBOX_EVENT.columns.filter((c) => c.primary).map((c) => c.name), ['id']);
  // Solo lo que distingue una fila pendiente o aplazada admite null.
  assert.deepEqual(
    OUTBOX_EVENT.columns.filter((c) => c.nullable).map((c) => c.name),
    ['published_at', 'next_attempt_at', 'claimed_at', 'last_error']
  );
  assert.equal(OUTBOX_EVENT.columns.find((c) => c.name === 'payload').base, 'text');
  assert.equal(OUTBOX_LAST_ERROR_LENGTH, 1024);
  assert.deepEqual(OUTBOX_EVENT.indexes, [{ name: 'ix_outbox_event_pending', columns: ['published_at', 'created_at'] }]);
});

test('outbox_event: claimed_at solo existe en el modelo documental', () => {
  assert.ok(!storeColumns(OUTBOX_EVENT, 'relational').some((c) => c.name === 'claimed_at'));
  assert.ok(storeColumns(OUTBOX_EVENT, 'document').some((c) => c.name === 'claimed_at'));
});

test('processed_event: la clave compuesta (handler, evento) y el índice de la purga', () => {
  assert.equal(PROCESSED_EVENT.table, 'processed_event');
  assert.deepEqual(
    PROCESSED_EVENT.columns.filter((c) => c.primary).map((c) => [c.name, c.length]),
    [['handler_id', 128], ['event_id', 255]]
  );
  assert.ok(PROCESSED_EVENT.columns.every((c) => !c.nullable));
  assert.deepEqual(PROCESSED_EVENT.indexes, [{ name: 'ix_processed_event_processed_at', columns: ['processed_at'] }]);
});

test('toda columna de texto acotada lleva su cota', () => {
  for (const spec of [OUTBOX_EVENT, PROCESSED_EVENT]) {
    for (const column of spec.columns.filter((c) => c.base === 'string')) {
      assert.ok(Number.isInteger(column.length), `${spec.table}.${column.name}`);
    }
  }
});

test('parámetros: claves y variables únicas, con su prefijo', () => {
  const all = [...Object.values(OUTBOX_RELAY), ...Object.values(OUTBOX_PURGE), ...Object.values(PROCESSED_EVENT_PURGE)];
  assert.equal(new Set(all.map((p) => p.key)).size, all.length);
  assert.equal(new Set(all.map((p) => p.env)).size, all.length);
  for (const p of Object.values(OUTBOX_RELAY)) assert.match(p.key, /^outbox\.relay\./);
  for (const p of Object.values(OUTBOX_PURGE)) assert.match(p.key, /^outbox\.purge\./);
  for (const p of Object.values(PROCESSED_EVENT_PURGE)) assert.match(p.key, /^processed-event\.purge\./);
  for (const p of all) assert.match(p.env, /^[A-Z][A-Z0-9_]*$/);
});

test('parámetros: el perfil local tiene más intentos y un tope de backoff más corto', () => {
  assert.equal(parameterValue(OUTBOX_RELAY.maxAttempts, 'local'), 40);
  assert.equal(parameterValue(OUTBOX_RELAY.maxAttempts, 'production'), 10);
  assert.equal(parameterValue(OUTBOX_RELAY.backoffMaxMs, 'local'), 2000);
  assert.equal(parameterValue(OUTBOX_RELAY.backoffMaxMs, 'test'), 60000);
  // Sin valor propio de local, el default en todos los perfiles.
  assert.equal(parameterValue(OUTBOX_RELAY.batchSize, 'local'), 100);
  // El presupuesto de local cubre un reinicio de broker de más de un minuto.
  const budget = parameterValue(OUTBOX_RELAY.maxAttempts, 'local') * parameterValue(OUTBOX_RELAY.backoffMaxMs, 'local');
  assert.ok(budget >= 60000, String(budget));
});

test('backoff: initial·2^(n-1) saturado en el tope, sin desbordar', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => outboxBackoffMs(n, 1000, 10000)), [1000, 2000, 4000, 8000, 10000]);
  assert.equal(outboxBackoffMs(2000, 1000, 60000), 60000);
  assert.equal(outboxBackoffMs(1, 5000, 2000), 2000);
});

test('rendición: con el contador ya incrementado, al alcanzar el máximo', () => {
  assert.equal(outboxDeadLettered(9, 10), false);
  assert.equal(outboxDeadLettered(10, 10), true);
});
