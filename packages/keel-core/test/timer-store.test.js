// El contrato neutral del cronómetro y de los plazos, sin base (PLAN-DSL-226-PLAZOS.md, incremento 2): las sentencias y
// sus marcadores, y lo que el modelo da a los cuatro generadores. Que las sentencias CASEN lo mide
// scripts/timer-sql-check.js contra PostgreSQL y MySQL (con tres sabotajes); el algoritmo del sondeador,
// test/timer-poller.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { BASE_DIR } from './design-mutations/runner.js';
import { EXTENSIONS } from './design-mutations/catalog.js';
import { PROBE } from './helpers/probe-projection.js';
import { KEEL_TIMER, KEEL_TIMER_DOCUMENT, TIMER_ENGINES, TIMER_PARAMETERS, bindNamed, expandList, timerStatements, timerDocumentId, NIL_ENTITY_ID } from '../src/lib/gen/timer-store.js';
import { CLOCK_PORT, DEADLINE_CASES, DEADLINE_SABOTAGES, deadlineHandlerNote, deadlineKind, deadlineOf, lateGuards, lateTransitionNote, modelDeadlines, usesDeadlines } from '../src/lib/gen/deadlines.js';
import { DEADLINE_GATE, ENTRY_GATES, carriesEntryGate, entryGates } from '../src/lib/gen/entry-gates.js';

function ticketDesk({ deadline = true, mutate = null } = {}) {
  const { manifest, layers } = loadService(BASE_DIR);
  // La extensión añade su fila a la matriz y su escenario: necesita el documento real del diseño base.
  const design = { manifest, layers, scenarios: fs.readFileSync(path.join(BASE_DIR, 'validation-scenarios.md'), 'utf8') };
  if (deadline) EXTENSIONS.deadline(design);
  if (mutate) mutate(design.layers);
  return buildModel({ manifest: design.manifest, layers: design.layers, stack: STACK_DEFAULTS, projection: PROBE });
}
const operation = (model, name) => model.services.flatMap((service) => service.operations).find((op) => op.name === name);

test('las sentencias de cada motor: solo comparan con la hora del motor, y el reclamo es el mismo en los dos', () => {
  for (const engine of TIMER_ENGINES) {
    const statements = timerStatements(engine);
    // Ninguna compara con una hora que venga de fuera: la única que entra es due_at (since + after, o el siguiente tick).
    const timeParams = Object.values(statements).flatMap((sql) => [...sql.matchAll(/:(\w*(?:[Nn]ow|[Aa]t))\b/g)].map((match) => match[1]));
    assert.deepEqual([...new Set(timeParams)], ['dueAt'], engine);
    assert.match(statements.claimLock, /FOR UPDATE SKIP LOCKED$/);
    assert.match(statements.claimMark, /claim_token = :token/);
    for (const name of ['complete', 'reschedule', 'fail']) assert.match(statements[name], /AND claim_token = :token$/, `${engine}.${name} sin valla`);
  }
  // En MySQL, las columnas del upsert de un recurrente van calificadas: a secas son ambiguas con el alias `new` (ERROR 1052).
  assert.match(timerStatements('mysql').ensureRecurring, /IF\(NOT \(keel_timer\.spec <=> new\.spec\), new\.due_at, keel_timer\.due_at\)/);
  // Y parked_at va antes que attempts: MySQL asigna de izquierda a derecha con los valores ya asignados.
  assert.match(timerStatements('mysql').fail, /SET parked_at = CASE WHEN attempts \+ 1 >= :maxAttempts .* END, attempts = attempts \+ 1/);
  assert.throws(() => timerStatements('oracle'), /no tiene sentencias para 'oracle'/);
});

test('el retraso del cronómetro (inc. 11): lo reclamable de los kinds que conoce, con la hora del motor, en los dos modelos', () => {
  for (const engine of TIMER_ENGINES) {
    const { lagMs, claimLock, parkedCount } = timerStatements(engine);
    // El mismo filtro que el reclamo: lo que el retraso cuenta es exactamente lo que una réplica podría reclamar ya.
    assert.equal(lagMs.slice(lagMs.indexOf(' WHERE ')), claimLock.slice(claimLock.indexOf(' WHERE '), claimLock.indexOf(' ORDER BY ')), engine);
    assert.match(lagMs, /min\(due_at\)/);
    assert.doesNotMatch(parkedCount, /:kinds/, 'los aparcados se cuentan de todos los kinds');
  }
  const [match, group, project] = KEEL_TIMER_DOCUMENT.lagPipeline(['purge:x']);
  assert.deepEqual(match.$match, KEEL_TIMER_DOCUMENT.claimFilter(['purge:x']));
  assert.deepEqual(group.$group.oldest, { $min: '$due_at' });
  assert.deepEqual(project.$project.lagMs, { $subtract: ['$$NOW', '$oldest'] });
  assert.deepEqual(KEEL_TIMER_DOCUMENT.parkedFilter, { parked_at: { $ne: null } });
});

test('bindNamed y expandList: los marcadores al estilo de cada driver, en orden, y las listas expandidas', () => {
  const sql = expandList(timerStatements('postgresql').claimLock, 'kinds', 2);
  assert.match(sql, /kind IN \(:kinds0, :kinds1\)/);
  const dollar = bindNamed(sql, 'dollar');
  assert.deepEqual(dollar.names, ['kinds0', 'kinds1', 'limit']);
  assert.match(dollar.sql, /kind IN \(\$1, \$2\).*LIMIT \$3/);
  assert.equal(bindNamed(sql, 'question').sql.match(/\?/g).length, 3);
  // Un `::uuid` de PostgreSQL no es un marcador.
  assert.deepEqual(bindNamed("SELECT 'x'::uuid, :id", 'question').names, ['id']);
  assert.throws(() => expandList(sql, 'kinds', 0), /al menos un elemento/);
});

test('la tabla: unicidad (kind, entity_id), índice de due_at, uuid nulo para los recurrentes y _id aplanado en documentos', () => {
  assert.deepEqual(KEEL_TIMER.uniques[0].columns, ['kind', 'entity_id']);
  assert.deepEqual(KEEL_TIMER.indexes[0].columns, ['due_at']);
  assert.equal(KEEL_TIMER.columns.find((column) => column.name === 'entity_id').nullable, false);
  assert.equal(timerDocumentId('schedule:sweep'), `schedule:sweep|${NIL_ENTITY_ID}`);
  // El arriendo cubre más que un lote de despachos: T4.
  assert.ok(TIMER_PARAMETERS.leaseMs.default > TIMER_PARAMETERS.maxSleepMs.default);
});

test('el modelo lleva los plazos, y gen/deadlines.js da a los cuatro lo mismo: kind, rechazo tardío y notas', () => {
  const model = ticketDesk();
  assert.equal(usesDeadlines(model), true);
  assert.equal(usesDeadlines(ticketDesk({ deadline: false })), false);
  const [found] = modelDeadlines(model);
  assert.equal(found.kind, deadlineKind('Ticket', 'open'));
  assert.deepEqual(found.duration, { seconds: 259200 });
  assert.equal(deadlineOf(model, operation(model, 'expireTicket')).kind, 'deadline:Ticket.open');
  assert.equal(deadlineOf(model, operation(model, 'closeTicket')), null);
  const ticket = model.entities.find((entity) => entity.name === 'Ticket');
  assert.deepEqual(lateGuards(ticket).map(({ from, exempt, error }) => ({ from, exempt, error })), [{ from: 'OPEN', exempt: 'EXPIRED', error: 'TICKET_EXPIRED' }]);
  // Con `allow`, no hay rechazo tardío que hacer.
  const allowed = ticketDesk({ mutate: (layers) => (layers.domain.entities.Ticket.lifecycle.deadlines.open.lateAction = 'allow') });
  assert.deepEqual(lateGuards(allowed.entities.find((entity) => entity.name === 'Ticket')), []);
  assert.match(lateTransitionNote(allowed, operation(allowed, 'closeTicket')), /lateAction: allow/);
  // Las notas: la de by (la despacha el cronómetro, sin volver a mirar el plazo) y la de quien sale tarde (la hora del reloj).
  assert.match(deadlineHandlerNote(model, operation(model, 'expireTicket')), /La despacha el cronómetro del servicio, una vez por cada Ticket/);
  assert.equal(deadlineHandlerNote(model, operation(model, 'closeTicket')), null);
  assert.match(lateTransitionNote(model, operation(model, 'closeTicket')), new RegExp(`TICKET_EXPIRED.*${CLOCK_PORT.name}`));
  assert.equal(lateTransitionNote(model, operation(model, 'expireTicket')), null);
});

test('la puerta del plazo: la operación by entra por el cronómetro, y su mensaje nunca lleva la puerta (es internal)', () => {
  const model = ticketDesk();
  const expire = operation(model, 'expireTicket');
  assert.deepEqual(entryGates(model, expire), [{ gate: DEADLINE_GATE, by: 'Ticket.open' }]);
  assert.equal(carriesEntryGate(model, expire), false);
  assert.ok(!ENTRY_GATES.includes(DEADLINE_GATE));
});

test('los casos y sabotajes nombran casos que existen', () => {
  const ids = new Set(DEADLINE_CASES.map((entry) => entry.id));
  for (const [name, sabotage] of Object.entries(DEADLINE_SABOTAGES)) for (const id of sabotage.breaks) assert.ok(ids.has(id), `${name} → ${id}`);
});
