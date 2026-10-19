// Por qué puerta entra una operación (keel-core/gen/entry-gates.js): el mensaje lleva su puerta solo cuando entra por
// HTTP y por alguna otra, porque HTTP es la única que puede responder un error a quien llamó. Que los tres generadores lo
// emitan igual lo compara keel-dotnet/test/entry-gate.test.js (keel-core no importa de los generadores).

import test from 'node:test';
import assert from 'node:assert/strict';
import { carriesEntryGate, dispatchNote, entryGateNote, entryGates, usesEntryGate } from '../src/lib/gen/index.js';

const op = (name, extra = {}) => ({ name, messageClass: `${name[0].toUpperCase()}${name.slice(1)}Command`, ...extra });
const modelOf = (operations, subscriptions = []) => ({ services: [{ operations }], subscriptions });

test('las puertas de una operación: HTTP, cada suscripción, cada despacho y el reloj', () => {
  const charge = op('requestCharge', { route: { method: 'POST', path: '/payments' } });
  const sweep = op('reconcile', { schedule: { cron: '* * * * *' }, dispatches: ['requestCharge'] });
  const model = modelOf([charge, sweep], [{ name: 'ChargeRequested', trigger: 'requestCharge' }]);
  assert.deepEqual(entryGates(model, charge), [
    { gate: 'HTTP', by: null },
    { gate: 'SUBSCRIPTION', by: 'ChargeRequested' },
    { gate: 'DISPATCH', by: 'reconcile' }
  ]);
  assert.deepEqual(entryGates(model, sweep), [{ gate: 'SCHEDULE', by: null }]);
});

test('la lleva la operación con HTTP y otra puerta; no la que solo tiene HTTP, ni la que tiene varias sin HTTP', () => {
  const charge = op('requestCharge', { route: { method: 'POST', path: '/payments' } });
  const read = op('getPayment', { route: { method: 'GET', path: '/payments/{id}' } });
  const quarantine = op('quarantineAsset', { internal: true });
  const sweep = op('reconcileScans', { schedule: { cron: '* * * * *' }, dispatches: ['quarantineAsset'] });
  const model = modelOf([charge, read, quarantine, sweep], [
    { name: 'ChargeRequested', trigger: 'requestCharge' },
    { name: 'MalwareDetected', trigger: 'quarantineAsset' }
  ]);
  assert.equal(carriesEntryGate(model, charge), true);
  assert.equal(carriesEntryGate(model, read), false, 'una sola puerta: no hay nada que distinguir');
  assert.equal(carriesEntryGate(model, quarantine), false, 'suscripción y despacho, sin HTTP: ninguna puerta responde');
  assert.equal(usesEntryGate(model), true);
  assert.equal(usesEntryGate(modelOf([read])), false);
});

test('la nota del handler nombra las puertas y cómo se lee; la del despacho dicta DISPATCH', () => {
  const charge = op('requestCharge', { route: { method: 'POST', path: '/payments' } });
  const sweep = op('reconcile', { schedule: { cron: '* * * * *' }, dispatches: ['requestCharge'] });
  const model = modelOf([charge, sweep], [{ name: 'ChargeRequested', trigger: 'requestCharge' }]);
  const note = entryGateNote(model, charge, { read: 'command.entryGate', value: (gate) => `EntryGate.${gate}` });
  assert.match(note, /entra por HTTP y por EntryGate\.SUBSCRIPTION \(ChargeRequested\), EntryGate\.DISPATCH \(reconcile\)/);
  assert.match(note, /command\.entryGate dice por cuál llegó/);
  assert.match(note, /el endpoint generado pone EntryGate\.HTTP/);
  assert.equal(entryGateNote(model, sweep, { read: 'x', value: String }), null);
  assert.match(dispatchNote(model, sweep, { call: 'dispatcher.{variant}(new {message}(...))' }), /new RequestChargeCommand\(\.\.\.\)\), con entryGate DISPATCH\)/);
});
