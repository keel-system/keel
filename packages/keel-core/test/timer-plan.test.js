// QUÉ corre sobre el cronómetro (PLAN-DSL-226-PLAZOS.md, incremento 7): cuándo existe y qué purgas monta como
// recurrentes en modo clúster, sobre las fixtures reales del repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { PROBE } from './helpers/probe-projection.js';
import { usesDeadlines } from '../src/lib/gen/deadlines.js';
import { GENERATOR_TABLES } from '../src/lib/gen/schema-steps.js';
import { KEEL_TIMER, TIMER_PURGE_KIND, purgeKind } from '../src/lib/gen/timer-store.js';
import { TIMER_DATABASES, clusterRecurrings, generatorPurges, purgedByTimer, timerPurges, usesTimer } from '../src/lib/gen/timer-plan.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/designs');
const fixtures = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'service.keel.yaml')));

function model(name, database = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES, name));
  const document = layers.persistence?.default?.model === 'document';
  const stack = { ...STACK_DEFAULTS, database: database ?? (document ? 'mongodb' : 'postgresql') };
  // Los generadores cuelgan el stack del modelo después de construirlo; aquí, igual.
  return { ...buildModel({ manifest, layers, stack, projection: PROBE }), stack };
}

test('cada purga del generador es la de una de sus tablas, con su kind en keel_timer y su cron de keel-core', () => {
  const tables = GENERATOR_TABLES.map((table) => table.table);
  let seen = 0;
  for (const name of fixtures) {
    for (const purge of generatorPurges(model(name))) {
      seen += 1;
      assert.ok(tables.includes(purge.table), `${name}: ${purge.table} no es una tabla del generador`);
      assert.notEqual(purge.table, KEEL_TIMER.table, 'la purga de keel_timer no es una purga del generador: es de la propia tabla');
      assert.equal(purge.kind, purgeKind(purge.table));
      assert.equal(purge.cron.cron, true, `${purge.table}: su parámetro no es un cron`);
      assert.match(purge.cron.key, /\.purge\.cron$/);
    }
  }
  assert.ok(seen > 0, 'ninguna fixture tiene purgas: la prueba no mide nada');
});

test('el cronómetro existe con plazos o con purgas, y entonces las lleva TODAS en modo clúster', () => {
  let withPurges = 0;
  for (const name of fixtures) {
    const subject = model(name);
    const purges = generatorPurges(subject);
    const expected = Boolean(subject.layersPresent.persistence) && (usesDeadlines(subject) || purges.length > 0);
    assert.equal(usesTimer(subject), expected, name);
    if (!usesTimer(subject)) {
      assert.deepEqual(timerPurges(subject), [], name);
      assert.deepEqual(clusterRecurrings(subject), [], name);
      continue;
    }
    if (purges.length > 0) withPurges += 1;
    assert.deepEqual(timerPurges(subject), purges, name);
    // La purga de la propia tabla (R7) va primero, y después las del generador, sin repetir un kind.
    const kinds = clusterRecurrings(subject).map((recurring) => recurring.kind);
    assert.equal(kinds[0], TIMER_PURGE_KIND, name);
    assert.deepEqual(kinds.slice(1), purges.map((purge) => purge.kind), name);
    assert.equal(new Set(kinds).size, kinds.length, `${name}: kinds repetidos`);
    for (const purge of purges) assert.ok(purgedByTimer(subject, purge.table), `${name}: ${purge.table}`);
  }
  assert.ok(withPurges >= 4, `solo ${withPurges} fixtures montan purgas en el cronómetro`);
});

test('un motor sin sentencias del cronómetro conserva el cron por réplica de sus purgas (degradado)', () => {
  // notification-mailer tiene outbox y guarda de mensajes: sobre MariaDB no hay cronómetro, y sus purgas se quedan fuera.
  for (const database of ['mariadb', 'sqlserver', 'oracle']) {
    assert.ok(!TIMER_DATABASES.includes(database));
    const subject = model('notification-mailer', database);
    assert.ok(generatorPurges(subject).length > 0);
    assert.equal(usesTimer(subject), false, database);
    assert.deepEqual(timerPurges(subject), [], database);
    assert.equal(purgedByTimer(subject, 'outbox_event'), false);
  }
  for (const database of TIMER_DATABASES.filter((id) => id !== 'mongodb')) {
    const subject = model('notification-mailer', database);
    assert.equal(usesTimer(subject), true, database);
    assert.ok(purgedByTimer(subject, 'outbox_event'), database);
  }
  assert.ok(purgedByTimer(model('notification-mailer-mongo'), 'outbox_event'));
});
