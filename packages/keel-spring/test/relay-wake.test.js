// El relay del outbox por réplica (DSL 2.26, inc. 9): que lo emitido diga lo que la referencia neutral
// (`relayNextRunMs` de keel-core/gen/timer-plan.js), que la sonda de store-check (src/lib/relay-wake-probes.js) nombre
// las piezas que build emite, y que sus dos sabotajes sigan aplicándose al Java de hoy. Lo que la sonda afirma contra el
// motor (el despertar, el reposo, el reintento) solo lo dice `npm run store-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { OUTBOX_RELAY } from '@keel-system/keel-core/gen/messaging-stores';
import { RELAY_SABOTAGES, RELAY_WAKE_CASES } from '@keel-system/keel-core/gen/timer-plan';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { CLASS_RELAY_WAKE, RELAY_WAKE_METHODS, RELAY_WAKE_SABOTAGES, relayWakeTestClass } from '../src/lib/relay-wake-probes.js';

function plan(name, database) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: tmpDir('keel-relay-wake-'), stack: { database } });
}
const javaNamed = (files, basename) => files.find((file) => file.path.endsWith(`/${basename}`))?.content;

for (const [name, database] of [['notification-mailer', 'postgresql'], ['notification-mailer-mongo', 'mongodb'], ['notification-mailer', 'mariadb']]) {
  test(`${name} (${database}): el relay va por réplica, sin @Scheduled, y lo despierta el bridge`, () => {
    const { model, files } = plan(name, database);
    const relay = javaNamed(files, 'OutboxRelay.java');
    const bridge = javaNamed(files, `${model.service.className}DomainEventBridge.java`);
    assert.ok(!relay.includes('@Scheduled('), 'el relay ya no es una tarea programada');
    assert.match(relay, /class OutboxRelay implements SmartLifecycle/);
    assert.ok(relay.includes(`@Value("\${${OUTBOX_RELAY.pollMs.key}:${OUTBOX_RELAY.pollMs.default}}")`));
    assert.ok(relay.includes('@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)'));
    assert.match(relay, /public boolean pause\(\)/);
    assert.match(relay, /public void resume\(\)/);
    // La purga sale del relay: pausar el relay ya no la pausa.
    assert.ok(!relay.includes('public void purge()'));
    assert.match(javaNamed(files, 'OutboxPurge.java'), /public void purge\(\)/);
    // El aviso va tras escribir la fila, dentro del mismo try.
    const append = bridge.slice(bridge.indexOf('private void append('));
    assert.ok(append.indexOf('outboxRepository.save(') < append.indexOf('events.publishEvent(OutboxAppended.INSTANCE);'));
    // Los dos sabotajes encuentran lo que rompen.
    for (const [id, sabotage] of Object.entries(RELAY_WAKE_SABOTAGES)) {
      assert.ok(javaNamed(files, sabotage.file(model)).includes(sabotage.find), `${id} ya no aplica a ${sabotage.file(model)}`);
      assert.deepEqual(sabotage.breaks, RELAY_SABOTAGES[id]);
    }
  });
}

test('el relay emitido reproduce relayNextRunMs: lote lleno en el acto, si no el primero del reintento y el respaldo', () => {
  const relay = javaNamed(plan('notification-mailer', 'postgresql').files, 'OutboxRelay.java');
  const nextRun = relay.slice(relay.indexOf('long nextRun('), relay.indexOf('public void onAppended'));
  assert.match(nextRun, /long remembered = pendingRetryMs > passStartMs \? pendingRetryMs : Long\.MAX_VALUE;/);
  assert.match(nextRun, /if \(full\) \{\s+return now;/);
  assert.match(nextRun, /return Math\.min\(pendingRetryMs, now \+ pollMs\);/);
  // El reintento, redondeado hacia arriba: truncado, la pasada lo encontraba sin vencer y lo olvidaba.
  assert.ok(javaNamed(plan('notification-mailer', 'postgresql').files, 'OutboxRelayStore.java').includes('nextAttemptAtMs = nextAttempt.toEpochMilli() + 1;'));
  assert.ok(javaNamed(plan('notification-mailer-mongo', 'mongodb').files, 'OutboxRelay.java').includes('retryAt = Math.min(retryAt, nextAttempt.toEpochMilli() + 1);'));
});

test('la sonda tiene un método por caso RW y cierra su contexto', () => {
  const { model } = plan('notification-mailer', 'postgresql');
  const java = relayWakeTestClass(model, {
    datasource: { url: 'jdbc:postgresql://localhost/x', username: 'u', password: 'p' },
    packages: { relay: 'com.example.outbox', bridge: 'com.example.messaging' }
  });
  assert.match(java, new RegExp(`class ${CLASS_RELAY_WAKE}`));
  for (const { id } of RELAY_WAKE_CASES) assert.ok(java.includes(`void ${RELAY_WAKE_METHODS[id]}()`), id);
  assert.match(java, /@DirtiesContext\(classMode = DirtiesContext\.ClassMode\.AFTER_CLASS\)/);
  assert.match(java, /"outbox\.relay\.poll-ms=600000"/);
});
