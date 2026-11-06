// La guarda por clave natural con la clave guardada en otro campo (DSL 2.24, `storedIn`): lo que el modelo
// decide y la frase que los cuatro generadores escriben con ello (`storedInNote`). El sujeto es el par del MVP
// en memoria, que es el caso real: `acceptNotificationRequest` recibe `eventId` y la clave natural de
// Notification es [applicationKey, dedupeKey], con dedupeKey derivado de eventId en una rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { storedInNote, idempotencyStoredField, guardedByNaturalKey } from '../src/lib/gen/natural-key-guard.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function modelWith(fixture, idempotency) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const patched = structuredClone(layers);
  patched['use-cases'].operations.acceptNotificationRequest.idempotency = idempotency;
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model) };
  return buildModel({ manifest, layers: patched, stack, projection: PROBE });
}

const subscriptionOf = (model) => model.subscriptions.find((sub) => sub.trigger === 'acceptNotificationRequest');
const operationOf = (model) =>
  model.services.flatMap((service) => service.operations).find((op) => op.name === 'acceptNotificationRequest');

for (const fixture of ['notification-mailer', 'notification-mailer-mongo']) {
  test(`${fixture}: con storedIn, la guarda es la clave natural y el listener la ve`, () => {
    const model = modelWith(fixture, { keySource: 'payload-field', keyField: 'eventId', storedIn: 'dedupeKey' });
    const op = operationOf(model);
    assert.equal(op.idempotency.guard, 'natural-key');
    assert.deepEqual(op.idempotency.naturalKey, ['applicationKey', 'dedupeKey']);
    const sub = subscriptionOf(model);
    assert.equal(sub.triggerHasDomainGuard, true);
    assert.equal(sub.triggerGuardKind, 'natural-key');
    assert.equal(sub.triggerNaturalKeyGuard.storedIn, 'dedupeKey');
  });

  test(`${fixture}: sin storedIn, eventId no está en la clave natural y la rama sigue siendo tryRecord`, () => {
    const model = modelWith(fixture, { keySource: 'payload-field', keyField: 'eventId' });
    assert.equal(operationOf(model).idempotency.guard, 'store');
    const sub = subscriptionOf(model);
    assert.equal(sub.triggerHasDomainGuard, false);
    assert.equal(sub.triggerNaturalKeyGuard, null);
  });
}

test('el campo guardado es storedIn si se declara, y keyField si no', () => {
  assert.equal(idempotencyStoredField({ keySource: 'payload-field', keyField: 'eventId', storedIn: 'dedupeKey' }), 'dedupeKey');
  assert.equal(idempotencyStoredField({ keySource: 'payload-field', keyField: 'dedupeKey' }), 'dedupeKey');
  assert.equal(idempotencyStoredField({ keySource: 'client-key' }), null);
  assert.equal(guardedByNaturalKey({ keySource: 'payload-field', keyField: 'eventId', storedIn: 'dedupeKey' }, ['dedupeKey']), true);
  assert.equal(guardedByNaturalKey({ keySource: 'payload-field', keyField: 'eventId' }, ['dedupeKey']), false);
});

test('la frase nombra los dos campos y la clave natural, y calla si no hay nada que decir', () => {
  const note = storedInNote({ keyField: 'eventId', storedIn: 'dedupeKey', naturalKey: ['applicationKey', 'dedupeKey'] });
  assert.match(note, /La clave eventId se guarda en dedupeKey \(storedIn\)/);
  assert.match(note, /\(applicationKey, dedupeKey\)/);
  assert.match(note, /no con eventId tal cual/);
  // Sin storedIn, o con el mismo campo, la nota de siempre ya es exacta.
  assert.equal(storedInNote({ keyField: 'dedupeKey', naturalKey: ['dedupeKey'] }), '');
  assert.equal(storedInNote({ keyField: 'dedupeKey', storedIn: 'dedupeKey', naturalKey: ['dedupeKey'] }), '');
  assert.equal(storedInNote(null), '');
});
