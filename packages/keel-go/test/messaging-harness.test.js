// La mensajería del ARNÉS de integración de keel-go (incremento 9c) sobre el texto emitido: qué ayudantes tiene el
// escenario —los MISMOS que el `Support/Messaging.cs` de keel-dotnet, en sus nombres de Go—, que los comandos con los
// que habla con el broker son los de keel-core/gen/broker-probes.js, que las colas que lee son las de la topología que
// declara la conexión emitida, y que el flujo y el humo esperan al broker. Lo que hacen contra un RabbitMQ real lo mide
// `npm run broker-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { deadLetterDestination, subscriptionDestination } from '@keel-system/keel-core/gen';
import { ENDPOINTS, PROBE_BODY_FILE, RECORD_FORMAT, UNKNOWN_TOPIC, deliverShell, kafkaGroupMembersParts, rabbitProbeBody, shellQuote } from '@keel-system/keel-core/gen/broker-probes';
import { KAFKA_PRODUCER_TIMEOUTS } from '@keel-system/keel-core/gen/infra-catalog';
import { kafkaConsumption } from '@keel-system/keel-core/gen/messaging-plan';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, stack = { broker: 'rabbitmq' }, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((candidate) => candidate.path.endsWith(suffix))?.content;
const HARNESS = 'tests/integration/messaging_test.go';

test('stock-reservation-events: el escenario tiene los ayudantes de mensajería del arnés de keel-dotnet', () => {
  const go = content(plan('stock-reservation-events').files, HARNESS);
  const cs = content(plan('stock-reservation-events', { broker: 'rabbitmq' }, planDotnet).files, 'Support/Messaging.cs');
  assert.ok(go, 'messaging_test.go');
  const goMethods = new Set([...go.matchAll(/^func \(s \*Scenario\) ([A-Z]\w*)\(/gm)].map((match) => match[1]));
  const csMethods = new Set([...cs.matchAll(/protected static [\w<>[\]?, ]+ ([A-Z]\w*)\(/g)].map((match) => match[1]));
  assert.deepEqual([...goMethods].sort(), [...csMethods].sort());
  for (const name of ['DeliverStockReserved', 'DeliverStockCountAdjusted', 'DeliverStockRejected', 'AbandonOutboxEvent', 'DeadLetteredEvents']) assert.ok(goMethods.has(name), name);
});

test('los comandos son los de keel-core/gen/broker-probes.js', () => {
  const go = content(plan('stock-reservation-events').files, HARNESS);
  assert.match(go, new RegExp(`rabbitAPI\\s+= "${ENDPOINTS.rabbitmq.queuesApi.replace(/[%/]/g, (c) => `\\${c}`)}"`));
  assert.ok(go.includes(`rabbitExchangeAPI = "${ENDPOINTS.rabbitmq.exchangeApi}"`));
  assert.ok(go.includes(`bodyFilePrefix = "${PROBE_BODY_FILE.replace(/\.json$/, '')}"`));
  // El peek, con su cuerpo partido donde va el tope.
  const [head, tail] = rabbitProbeBody(' 0 ').split(' 0 ');
  assert.ok(go.includes(`${JSON.stringify(head)} + strconv.Itoa(readLimit) + ${JSON.stringify(tail)}`));
  assert.match(go, /"-XPOST", "-d", "@"\+bodyFile, rabbitAPI\+queue\+"\/get"/);
  assert.match(go, /"-XPOST", "-d", "@"\+bodyFile, rabbitExchangeAPI\+exchange\+"\/publish"/);
  assert.match(go, /"-XDELETE", rabbitAPI\+queue\+"\/contents"/);
  // Un archivo de cuerpo POR LLAMADA: con uno fijo, dos entregas a la vez se pisan.
  assert.match(go, /bodyFile := bodyFilePrefix \+ "-" \+ rand\.Text\(\) \+ "\.json"/);
  assert.match(go, /strings\.Contains\(answer, "\\"routed\\":true"\)/);
});

test('las colas del arnés son las de la topología, y la conexión que espera es la que nombra la conexión emitida', () => {
  for (const name of ['stock-reservation-events', 'stock-reservation', 'notification-mailer', 'catalog-extended', 'payment-checkout']) {
    const { files, model } = plan(name);
    const go = content(files, HARNESS);
    for (const sub of model.subscriptions) {
      assert.match(go, new RegExp(`"${sub.name}":\\s+"${subscriptionDestination('rabbitmq', model, sub)}",`), `${name}: cola de ${sub.name}`);
      if (sub.deadLetter) assert.match(go, new RegExp(`"${sub.name}":\\s+"${deadLetterDestination('rabbitmq', model, sub)}",`), `${name}: descarte de ${sub.name}`);
    }
    const emitted = /connectionName = ("[^"]+")/.exec(content(files, 'internal/infrastructure/rabbitmq/connection.go'))?.[1];
    assert.ok(emitted, `${name}: la conexión emitida declara su nombre`);
    assert.match(go, new RegExp(`connectionName = ${emitted.replace(/[.-]/g, '\\$&')}\\n`), name);
  }
});

test('el flujo prepara el broker al abrir, y el humo lo comprueba (SMOKE-8)', () => {
  const { files } = plan('stock-reservation-events');
  assert.match(content(files, 'tests/integration/flow_test.go'), /if err := prepareBroker\(f\.t\.Context\(\)\); err != nil \{/);
  assert.match(content(files, 'tests/integration/harness_smoke_test.go'), /SMOKE-8: el broker responde y el servidor está conectado a él[\s\S]*s\.AssertBrokerConnected\(\)/);
  assert.match(content(files, 'tests/integration/harness_test.go'), /func containerRuntime\(\) string/);
});

test('sin broker con conexión de keel-go no hay mensajería en el arnés', () => {
  for (const stack of [{ broker: 'snssqs' }]) {
    const { files } = plan('stock-reservation-events', stack);
    assert.equal(content(files, HARNESS), undefined, stack.broker);
    assert.doesNotMatch(content(files, 'tests/integration/flow_test.go'), /prepareBroker/);
  }
  assert.equal(content(plan('product-catalog').files, HARNESS), undefined);
});

test('el outbox del arnés: rendición, abandono y espera a que el relay drene, con los defaults de keel-core', () => {
  const go = content(plan('stock-reservation-events').files, HARNESS);
  assert.match(go, /envOr\("MESSAGING_DESTINATION", "stock-reservation-events\.events"\)/);
  assert.match(go, /os\.Getenv\("OUTBOX_RELAY_MAX_ATTEMPTS"\)/);
  assert.match(go, /UPDATE outbox_event SET attempts = 1000000 WHERE event_type = /);
  assert.match(go, /DELETE FROM outbox_event WHERE published_at IS NULL AND attempts >= 1000000/);
  // Sin outbox (best-effort) no hay ninguno de los tres.
  const bestEffort = content(plan('metering-digest').files, HARNESS);
  assert.ok(bestEffort);
  assert.doesNotMatch(bestEffort, /AbandonOutboxEvent|awaitOutboxDrained/);
});

// ─── Kafka (tramo 9f) ────────────────────────────────────────────────────────────────────────────

const kafka = (name) => plan(name, { broker: 'kafka' });

test('con Kafka, el escenario tiene los MISMOS ayudantes que con RabbitMQ (y que el arnés de keel-dotnet con Kafka)', () => {
  const methods = (go) => [...go.matchAll(/^func \(s \*Scenario\) ([A-Z]\w*)\(/gm)].map((match) => match[1]).sort();
  const go = content(kafka('stock-reservation-events').files, HARNESS);
  assert.ok(go, 'messaging_test.go');
  assert.deepEqual(methods(go), methods(content(plan('stock-reservation-events').files, HARNESS)));
  const cs = content(plan('stock-reservation-events', { broker: 'kafka' }, planDotnet).files, 'Support/Messaging.cs');
  assert.deepEqual(methods(go), [...new Set([...cs.matchAll(/protected static [\w<>[\]?, ]+ ([A-Z]\w*)\(/g)].map((match) => match[1]))].sort());
});

test('con Kafka, los comandos son los de keel-core/gen/broker-probes.js y el arnés solo usa la biblioteca estándar', () => {
  const go = content(kafka('stock-reservation-events').files, HARNESS);
  assert.ok(go.includes(`kcatProduce  = ${JSON.stringify(deliverShell({ destination: '', key: '', bodyFile: '' }).split(shellQuote(''))[0])}`));
  assert.ok(go.includes(`unknownTopic = ${JSON.stringify(UNKNOWN_TOPIC)}`));
  assert.ok(go.includes(`"-o", offset, "-e", "-q", "-f", ${JSON.stringify(RECORD_FORMAT)}`), 'la lectura con el formato del registro entero');
  assert.match(go, /"kcat", "-C", "-b", "kafka:29092", "-t", topic, "-o", "beginning", "-e", "-q", "-f", "%o\\\\n"/);
  // La espera a los grupos, con la CLI del broker y en su contenedor: el arnés no necesita un cliente de Kafka.
  assert.ok(go.includes(`cli := []string{${kafkaGroupMembersParts([]).map((part) => JSON.stringify(part)).join(', ')}}`));
  assert.match(go, /runCommand\(ctx, containerRuntime\(\), \[\]string\{"exec", brokerContainer, "sh", "-c", strings\.Join\(quoted, " "\) \+ " 2>&1 \|\| true"\}/);
  assert.doesNotMatch(go, /franz-go|kadm/);
  // Un registro por línea de kcat: el cuerpo se aplana.
  assert.match(go, /singleLine := strings\.Join\(strings\.Fields\(/);
});

test('con Kafka, los topics, los descartes y los grupos del arnés son los del consumo de keel-core', () => {
  for (const name of ['stock-reservation-events', 'stock-reservation', 'notification-mailer', 'catalog-extended', 'payment-checkout']) {
    const { files, model } = kafka(name);
    const go = content(files, HARNESS);
    for (const entry of kafkaConsumption(model)) {
      const sub = model.subscriptions.find((candidate) => candidate.name === entry.subscription);
      assert.match(go, new RegExp(`"${sub.name}":\\s+envOr\\("[A-Z_]+", "${entry.topic.replace(/\./g, '\\.')}"\\),`), `${name}: topic de ${sub.name}`);
      assert.match(go, new RegExp(`"${sub.name}":\\s+envOr\\("[A-Z_]+", "${entry.groupId}"\\),`), `${name}: grupo de ${sub.name}`);
      assert.equal(new RegExp(`"${sub.name}":\\s+topicOf\\["${sub.name}"\\] \\+ "\\.DLT",`).test(go), entry.deadLetter, `${name}: descarte de ${sub.name}`);
    }
  }
});

test('con Kafka, abrir el flujo marca cada canal y cada descarte, y el abandono espera al envío en vuelo', () => {
  const go = content(kafka('stock-reservation-events').files, HARNESS);
  assert.match(go, /\tif err := awaitServerConnected\(ctx\); err != nil \{\n\t\treturn err\n\t\}\n\treturn markChannels\(ctx\)\n\}/);
  assert.match(go, new RegExp(`time\\.Sleep\\(${KAFKA_PRODUCER_TIMEOUTS.delivery.local + 2000} \\* time\\.Millisecond\\)`));
  // La purga mueve la marca; el topic de una suscripción no se toca.
  assert.match(go, /\} else if _, ok := topicOf\[channelOrSubscription\]; ok \{\n\t\treturn nil\n\t\}/);
  assert.match(content(kafka('stock-reservation-events').files, 'tests/integration/flow_test.go'), /prepareBroker\(f\.t\.Context\(\)\)/);
});
