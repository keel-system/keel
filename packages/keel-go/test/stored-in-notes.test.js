// Con `storedIn` (DSL 2.24) la clave del mensaje no es el campo de la clave natural, y las dos notas que lee el
// agente —el contrato del listener y la del handler— tienen que nombrarlo, o busca por un campo que la entidad
// no tiene. La frase es neutral (`storedInNote`, keel-core/gen/natural-key-guard.js) y los cuatro generadores
// la escriben igual: aquí se compara la de cada uno contra esa fuente. Sujeto: el par del MVP en memoria.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { storedInNote } from '@keel-system/keel-core/gen/natural-key-guard';
import { planService as planGo } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const GENERATORS = { 'keel-go': planGo, 'keel-dotnet': planDotnet, 'keel-nest': planNest, 'keel-spring': planSpring };
const GUARD = { keySource: 'payload-field', keyField: 'eventId', storedIn: 'dedupeKey' };
const EXPECTED = storedInNote({ ...GUARD, naturalKey: ['applicationKey', 'dedupeKey'] });

const compact = (text = '') => text.replace(/\/\/\s?|\*\s?|\s+/g, ' ').replace(/\s+/g, ' ');

function plan(generator, fixture, idempotency) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const patched = structuredClone(layers);
  if (idempotency) patched['use-cases'].operations.acceptNotificationRequest.idempotency = idempotency;
  return GENERATORS[generator]({ manifest, layers: patched, workspace: FIXTURES_DIR }).files;
}

const isHandler = (file) => {
  const base = path.basename(file.path).replace(/[-_]/g, '').toLowerCase();
  return base.startsWith('acceptnotificationrequest') && base.includes('handler');
};
// El contrato del listener: el único archivo que prescribe el orden del registro de ESTA suscripción.
const isListenerContract = (file) =>
  path.basename(file.path).replace(/[-_]/g, '').toLowerCase().startsWith('notificationrequested') && compact(file.content).includes('Orden: IdempotencyGuard');

for (const generator of Object.keys(GENERATORS)) {
  for (const fixture of ['notification-mailer', 'notification-mailer-mongo']) {
    test(`${generator}, ${fixture}: con storedIn, el listener y el handler nombran el campo guardado`, () => {
      const files = plan(generator, fixture, GUARD);
      const contract = files.filter(isListenerContract);
      assert.equal(contract.length, 1, `contrato del listener: ${contract.map((file) => file.path).join(', ') || 'ninguno'}`);
      const listener = compact(contract[0].content);
      assert.ok(listener.includes(EXPECTED), `${contract[0].path}: no lleva la frase de storedIn`);
      assert.ok(/Orden: IdempotencyGuard\.alreadyProcessed/i.test(listener), `${contract[0].path}: no prescribe comprobar y registrar después`);
      const handlers = files.filter(isHandler);
      assert.ok(handlers.length > 0, 'no se encuentra el handler de acceptNotificationRequest');
      const notes = handlers.map((file) => compact(file.content));
      assert.ok(notes.some((note) => note.includes(EXPECTED)), 'la nota del handler no lleva la frase de storedIn');
      assert.ok(notes.some((note) => note.includes('keyField=eventId, storedIn=dedupeKey')), 'la nota del handler no nombra storedIn');
    });
  }

  test(`${generator}: sin storedIn la frase no aparece en ningún archivo`, () => {
    for (const file of plan(generator, 'notification-mailer', null)) {
      assert.ok(!compact(file.content).includes('(storedIn)'), file.path);
    }
  });
}
