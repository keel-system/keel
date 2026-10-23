// La autorización por propietario (`security.ownership`, DSL 2.23) en el modelo neutral y en la nota del handler que
// escriben los tres generadores (keel-core/gen/ownership.js). La comparación entre los tres vive en
// keel-dotnet/test/ownership.test.js, sobre la fixture conduit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipNotes, ownershipRulesOf } from '../src/lib/gen/ownership.js';

const model = (ownership, callerIdentity = { field: 'callerSubject', source: 'claim', claim: 'sub' }) => ({
  security: { callerIdentity, ownership }
});
const ARTICLE = { entity: 'Article', owner: 'author.subject', relations: ['author'], field: 'subject', error: 'NOT_ARTICLE_AUTHOR', operations: ['updateArticle', 'deleteArticle'], exemptRoles: [] };
const TICKET = { entity: 'Ticket', owner: 'openedBy', relations: [], field: 'openedBy', error: 'TICKET_NOT_OWNED', operations: ['closeTicket'], exemptRoles: ['supervisor'] };
const read = (field) => `command.${field}()`;

test('la nota dice la entidad, el camino al dueño, el campo del llamante y el code, solo en las operaciones nombradas', () => {
  const m = model([ARTICLE]);
  const [note] = ownershipNotes(m, { name: 'updateArticle' }, { read });
  assert.match(note, /^Propiedad \(security\.ownership\.Article\): solo el dueño del Article/);
  assert.match(note, /sigue author hasta subject \(author\.subject\) y compáralo con command\.callerSubject\(\)/);
  assert.match(note, /si no coincide, NOT_ARTICLE_AUTHOR \(403\), antes de cambiar nada\.$/);
  assert.doesNotMatch(note, /Exentos/, 'sin exemptRoles no hay exentos que nombrar');
  assert.deepEqual(ownershipNotes(m, { name: 'getArticle' }, { read }), []);
  assert.deepEqual(ownershipRulesOf(m, { name: 'deleteArticle' }).map((rule) => rule.entity), ['Article']);
});

test('un dueño en un campo propio, y los roles exentos nombrados uno a uno', () => {
  const [note] = ownershipNotes(model([TICKET]), { name: 'closeTicket' }, { read: (field) => `command.${field}` });
  assert.match(note, /su campo openedBy y compáralo con command\.callerSubject,/);
  assert.match(note, /Exentos, que operan sobre cualquier Ticket: el rol supervisor\.$/);
});

test('sin identidad del llamante no hay nota: la validación ya lo rechaza (CHK-SECURITY-OWNERSHIP-NO-CALLER)', () => {
  assert.deepEqual(ownershipNotes(model([ARTICLE], null), { name: 'updateArticle' }, { read }), []);
  assert.deepEqual(ownershipNotes({ security: null }, { name: 'updateArticle' }, { read }), []);
});
