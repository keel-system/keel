// La mensajería de keel-go (incremento 9) sobre el texto emitido: qué se emite y dónde, la configuración —la MISMA que
// keel-nest y keel-dotnet, byte a byte—, las claves que lee messaging.Settings contra las que escribe messaging.yaml, las
// tablas de los almacenes contra las que EMITE keel-spring, el puente en el adaptador de repositorio y el cableado del
// arranque con el archivo del agente. Lo que ejecuta el Go (la envoltura en el cable, sus rechazos, el backoff) lo mide
// la prueba emitida messaging_test.go en `npm run go-check`; el reclamo, el lease y la guarda contra un motor real,
// `npm run db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { OUTBOX_EVENT, PROCESSED_EVENT, OUTBOX_RELAY } from '@keel-system/keel-core/gen/messaging-stores';
import { kafkaConsumption, rabbitTopology } from '@keel-system/keel-core/gen/messaging-plan';
import { kafkaListenerRetry, rabbitListenerRetry } from '@keel-system/keel-core/gen';
import { retryLiteral } from '../src/scaffold/kafka.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springSchema } from '../../keel-spring/test/helpers/schema-table.js';
import { planService } from '../src/scaffold/index.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { goSchema } from './helpers/schema.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const MESSAGING_FIXTURES = ['metering-digest', 'notification-mailer', 'stock-reservation', 'stock-reservation-events', 'catalog-extended', 'payment-checkout'];
const BROKERS = ['rabbitmq', 'kafka', 'snssqs'];
const PROFILES = ['local', 'develop', 'production', 'test'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, stack = { broker: 'rabbitmq' }, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack }).files;
const content = (files, file) => files.find((candidate) => candidate.path === file)?.content;
const MESSAGING = 'internal/infrastructure/messaging';

test('stock-reservation-events (outbox): la envoltura, el puente, el outbox, la guarda, los mensajes y el cableado', () => {
  const files = plan('stock-reservation-events');
  for (const name of ['doc', 'settings', 'envelope', 'inbound', 'bridge', 'outbox', 'guard', 'stock_reservation_requested_integration_event', 'messaging_test']) {
    assert.ok(content(files, `${MESSAGING}/${name}.go`), name);
  }
  for (const name of ['stock_reserved_message', 'stock_count_adjusted_message', 'stock_rejected_message']) assert.ok(content(files, `${MESSAGING}/${name}.go`), name);
  // Con outbox no hay publishers best-effort.
  assert.equal(content(files, `${MESSAGING}/publishers.go`), undefined);
  for (const name of ['outbox', 'processed_events']) assert.ok(content(files, `internal/infrastructure/postgres/${name}.go`), name);
});

test('metering-digest (best-effort, envoltura propia): publishers con respaldo, sin outbox, y la envoltura de la fuente', () => {
  const files = plan('metering-digest');
  assert.match(content(files, `${MESSAGING}/publishers.go`), /type DailyDigestClosedPublisher interface/);
  assert.match(content(files, `${MESSAGING}/bridge.go`), /func \(b \*Bridge\) Deliver\(/);
  assert.equal(content(files, `${MESSAGING}/outbox.go`), undefined);
  assert.equal(content(files, 'internal/infrastructure/postgres/outbox.go'), undefined);
  assert.match(content(files, `${MESSAGING}/meter_reading_captured_envelope.go`), /func \(e MeterReadingCapturedEnvelope\) Message\(\) \(MeterReadingCapturedMessage, error\)/);
  // La envoltura propia se lee con los nombres de la fuente (wireName).
  assert.match(content(files, `${MESSAGING}/meter_reading_captured_message.go`), /`json:"meter_id"`/);
});

for (const name of MESSAGING_FIXTURES) {
  test(`${name}: messaging.yaml es el de keel-dotnet (y keel-nest), byte a byte, con los tres brokers y en los cuatro perfiles`, () => {
    for (const broker of BROKERS) {
      const ours = plan(name, { broker });
      const dotnet = plan(name, { broker }, planDotnet);
      for (const profile of PROFILES) {
        const file = `config/parameters/${profile}/messaging.yaml`;
        assert.ok(content(ours, file), `${broker}: ${file} se emite`);
        assert.equal(content(ours, file), content(dotnet, file), `${broker}: ${file}`);
      }
    }
  });

  test(`${name}: toda clave que lee messaging.Settings existe en su messaging.yaml`, () => {
    for (const broker of BROKERS) {
      const files = plan(name, { broker });
      const yaml = flatten(parseYaml(content(files, 'config/parameters/local/messaging.yaml')));
      const settings = content(files, `${MESSAGING}/settings.go`);
      const keys = [...settings.matchAll(/read\.(?:text|positive|millis)\("([^"]+)"/g)].map((match) => match[1]);
      assert.ok(keys.length > 0, 'lee alguna clave');
      for (const key of keys) assert.ok(yaml.has(key), `${broker}: ${key} no está en messaging.yaml`);
      // Y lo que lee del relay con el default de keel-core.
      if (settings.includes('OutboxRelaySettings{\n')) {
        for (const parameter of Object.values(OUTBOX_RELAY)) assert.match(settings, new RegExp(`"${parameter.key.replaceAll('.', '\\.')}", ${parameter.default}\\)`), parameter.key);
      }
    }
  });
}

function flatten(node, prefix = '', into = new Map()) {
  for (const [key, value] of Object.entries(node ?? {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, full, into);
    else into.set(full, value);
  }
  return into;
}

for (const database of ['postgresql', 'mysql']) {
  test(`stock-reservation-events (${database}): outbox_event y processed_event son las tablas de keel-spring`, () => {
    const stack = { broker: 'rabbitmq', database };
    const go = goSchema(plan('stock-reservation-events', stack));
    const spring = springSchema(plan('stock-reservation-events', stack, planSpring));
    for (const table of [OUTBOX_EVENT.table, PROCESSED_EVENT.table]) {
      const want = spring.get(table);
      const got = go.get(table);
      assert.ok(want && got, `${table} en los dos`);
      assert.deepEqual([...got.names].sort(), [...want.names].sort(), `${table}: los mismos nombres`);
      assert.deepEqual([...got.columns.keys()].sort(), [...want.columns.keys()].sort(), `${table}: las mismas columnas`);
      for (const [column, spec] of want.columns) {
        if (spec.length != null) assert.equal(got.columns.get(column).length, spec.length, `${table}.${column}: la cota`);
        // El texto SIN cota (el payload: columnDefinition = "text" en keel-spring). Una cota que keel-spring no pone corta
        // un evento real: broker-check lo encontró el 2026-10-30, el payload del outbox salía como varchar(255).
        if (spec.text) assert.equal(got.columns.get(column).type, 'text', `${table}.${column}: texto sin cota`);
        assert.equal(got.columns.get(column).nullable, spec.nullable, `${table}.${column}: la nulabilidad`);
      }
    }
  });
}

test('metering-digest (best-effort): processed_event sí, outbox_event no', () => {
  const go = goSchema(plan('metering-digest'));
  assert.ok(go.get(PROCESSED_EVENT.table));
  assert.equal(go.get(OUTBOX_EVENT.table), undefined);
});

test('el adaptador de repositorio entrega los eventos al puente al guardar, y solo el de la raíz que los emite', () => {
  const outbox = plan('stock-reservation-events');
  const adapter = content(outbox, 'internal/infrastructure/postgres/reservation_repository.go');
  assert.match(adapter, /func NewReservationRepository\(tx \*Transactions, events \*messaging\.Bridge\)/);
  // Se drenan ANTES de la transacción (un reintento repite el caso de uso entero, que los vuelve a emitir) y sus filas
  // van DENTRO de ella, tras escribir el agregado.
  const save = adapter.slice(adapter.indexOf('func (r *ReservationRepository) Save('));
  assert.ok(save.indexOf('PullEvents()') < save.indexOf('r.tx.write('), 'drena antes de abrir');
  assert.ok(save.indexOf('writeReservation(') < save.indexOf('r.events.Route(') && save.indexOf('r.events.Route(') < save.indexOf('appendOutbox('), 'las filas tras el agregado');

  const bestEffort = plan('metering-digest');
  const digest = content(bestEffort, 'internal/infrastructure/postgres/daily_digest_repository.go');
  assert.match(digest, /r\.tx\.afterCommit\(ctx, func\(ctx context\.Context\) \{\n\t\t\tr\.events\.Deliver\(ctx, events\)/);
  assert.doesNotMatch(digest, /appendOutbox/);
  // La raíz que no emite nada no recibe el puente.
  const meter = content(bestEffort, 'internal/infrastructure/postgres/meter_reading_repository.go');
  assert.match(meter, /func NewMeterReadingRepository\(tx \*Transactions\) \*MeterReadingRepository/);
});

test('el arranque cablea la mensajería y deja al agente un solo archivo, sin la cabecera de código generado', () => {
  const files = plan('stock-reservation-events');
  const main = content(files, 'cmd/server/main.go');
  assert.match(main, /messagingSettings, err := messaging\.SettingsFrom\(cfg\)/);
  assert.match(main, /rabbit := rabbitmq\.New\(rabbitSettings, messagingSettings, logger\)/);
  assert.match(main, /adapters, err := brokerAdapters\(messagingSettings, rabbit, logger\)/);
  assert.match(main, /return rabbit\.Run\(groupCtx\)/);
  assert.match(main, /Rabbit:   rabbit,/);
  assert.match(main, /messaging\.NewDispatcherFallback\(cfg\.Profiles, logger\)/);
  assert.match(main, /return relay\.Run\(groupCtx\)/);
  assert.match(main, /listeners, err := messageListeners\(inbound\{/);
  // El puente existe antes que los repositorios que lo reciben, y los listeners después de los casos de uso.
  assert.ok(main.indexOf('bridge := ') < main.indexOf('NewReservationRepository(transactions, bridge)'));
  assert.ok(main.indexOf('useCases := ') < main.indexOf('messageListeners('));
  const broker = content(files, 'cmd/server/broker.go');
  assert.ok(!broker.startsWith(GENERATED_HEADER), 'broker.go es del agente');
  assert.match(broker, /func brokerAdapters\(settings messaging\.Settings, rabbit \*rabbitmq\.Connection, logger \*slog\.Logger\) \(outbound, error\)/);
  assert.match(content(files, 'cmd/server/messaging.go'), /\tRabbit   \*rabbitmq\.Connection\n/);
  assert.match(broker, /func messageListeners\(deps inbound\) \(\[\]listener, error\)/);
  assert.match(broker, /UNO POR COLA/);
  assert.ok(content(files, 'cmd/server/messaging.go').startsWith(GENERATED_HEADER), 'los tipos son de build');
  // Con Kafka, un listener por suscripción, y sin la conexión de RabbitMQ.
  const kafka = plan('stock-reservation-events', { broker: 'kafka' });
  assert.match(content(kafka, 'cmd/server/broker.go'), /UNO POR SUSCRIPCIÓN/);
  assert.equal(kafka.find((file) => file.path.startsWith('internal/infrastructure/rabbitmq/')), undefined);
});

test('cada mensaje de suscripción comprueba la presencia de lo obligatorio y sus cotas, y nombra al consumidor', () => {
  const files = plan('stock-reservation-events');
  const rejected = content(files, `${MESSAGING}/stock_rejected_message.go`);
  // La prosa del comentario va partida en líneas: se lee de corrido.
  const prose = rejected.replaceAll('\n// ', ' ');
  assert.match(rejected, /if m\.Reason == nil \{\n\t\treturn &ContractError\{Reason: "StockRejected: el mensaje no trae 'reason', que el contrato declara obligatorio"\}/);
  assert.match(rejected, /textLength\(\*m\.Reason\)/);
  assert.match(prose, /useCases\.ReleaseReservation\.Handle\(messaging\.Inbound\(ctx, envelope\.Metadata\), application\.ReleaseReservationCommand\{/);
  const reserved = content(files, `${MESSAGING}/stock_reserved_message.go`);
  // Sin cotas fuera de la presencia, sin acumulador.
  assert.doesNotMatch(reserved, /violations/);
  // Una fuente sin envoltura Keel no trae metadata de la que heredar la correlación: el despacho abre una nueva
  // (la nota decía messaging.Inbound(ctx, envelope.Metadata), que con una envoltura ajena no compila).
  const wrapped = content(plan('metering-digest'), `${MESSAGING}/meter_reading_captured_message.go`).replaceAll('\n// ', ' ');
  assert.match(wrapped, /useCases\.RecordReading\.Handle\(correlation\.WithID\(ctx, correlation\.Accept\(""\)\), application\.RecordReadingCommand\{/);
  assert.doesNotMatch(wrapped, /envelope\.Metadata/);
});

// ─── RabbitMQ (tramo 9b-2) ───────────────────────────────────────────────────────────────────────

const RABBIT = 'internal/infrastructure/rabbitmq';

/** La topología que declara RabbitTopologyConfig de keel-spring: una entrada por @Bean (el lector de keel-dotnet). */
function springTopology(files) {
  const java = files.find((file) => file.path.endsWith('/RabbitTopologyConfig.java'))?.content ?? '';
  return java
    .split('@Bean')
    .slice(1)
    .filter((block) => block.includes('new TopicExchange('))
    .map((block) => ({
      source: /new TopicExchange\("([^"]+)"/.exec(block)[1],
      queue: /QueueBuilder\.durable\("([^"]+)"\)/.exec(block)[1],
      deadLetter: /"x-dead-letter-routing-key", "([^"]+)"/.exec(block)?.[1] ?? null
    }));
}

/** Las colas que declara topology.go: `{Source: "…", Queue: "…", DeadLetter: "…", …}`. */
function goTopology(files) {
  const go = content(files, `${RABBIT}/topology.go`);
  const queues = /\tqueues = \[\]QueueTopology\{([\s\S]*?)\n\t\}\n/.exec(go)?.[1] ?? '';
  return [...queues.matchAll(/\{Source: "([^"]+)", Queue: "([^"]+)"(?:, DeadLetter: "([^"]+)")?/g)].map((m) => ({ source: m[1], queue: m[2], deadLetter: m[3] ?? null }));
}

test('stock-reservation-events: la conexión con RabbitMQ, su configuración y el cliente en go.mod', () => {
  const files = plan('stock-reservation-events');
  for (const name of ['doc', 'topology', 'settings', 'connection', 'rabbitmq_test']) assert.ok(content(files, `${RABBIT}/${name}.go`), name);
  assert.match(content(files, 'go.mod'), /\tgithub\.com\/rabbitmq\/amqp091-go v1\.15\.0\n/);
  const connection = content(files, `${RABBIT}/connection.go`);
  // Publicación con confirmación y mandatory; consumo sin autoack y descarte sin reencolar.
  assert.match(connection, /PublishWithDeferredConfirmWithContext\(confirmCtx, exchange, routingKey, true, false, message\)/);
  assert.match(connection, /ch\.Confirm\(false\)/);
  assert.match(connection, /ConsumeWithContext\(ctx, queue, "", false, false, false, false, nil\)/);
  assert.match(connection, /delivery\.Nack\(false, false\)/);
  assert.match(connection, /connectionName = "stock-reservation-events"/);
  // Sin la recuperación automática de la biblioteca: la reconexión es el bucle de Run.
  assert.doesNotMatch(connection, /Recovery:/);
  // Sin RabbitMQ, ni el paquete ni el módulo.
  const kafka = plan('stock-reservation-events', { broker: 'kafka' });
  assert.doesNotMatch(content(kafka, 'go.mod'), /amqp091/);
  assert.equal(content(kafka, 'config/parameters/local/rabbitmq.yaml'), undefined);
});

for (const name of MESSAGING_FIXTURES) {
  test(`${name}: rabbitmq.yaml es el de keel-dotnet, byte a byte, en los cuatro perfiles`, () => {
    const ours = plan(name);
    const dotnet = plan(name, { broker: 'rabbitmq' }, planDotnet);
    for (const profile of PROFILES) {
      const file = `config/parameters/${profile}/rabbitmq.yaml`;
      assert.ok(content(ours, file), file);
      assert.equal(content(ours, file), content(dotnet, file), file);
    }
  });

  test(`${name}: toda clave que lee rabbitmq.SettingsFrom existe en su rabbitmq.yaml`, () => {
    const files = plan(name);
    const yaml = flatten(parseYaml(content(files, 'config/parameters/local/rabbitmq.yaml')));
    const settings = content(files, `${RABBIT}/settings.go`);
    const keys = [...settings.matchAll(/"(rabbitmq\.[a-z0-9.-]+)"/g)].map((match) => match[1]);
    assert.ok(keys.length >= 7, keys.join(', '));
    for (const key of keys) assert.ok(yaml.has(key), `${key} no está en rabbitmq.yaml`);
  });

  test(`${name}: la topología de RabbitMQ es la de keel-spring, y el reintento del «no existe» va por cola`, () => {
    const { model, files } = planService({ ...design(name), workspace: FIXTURES_DIR, stack: { broker: 'rabbitmq' } });
    assert.deepEqual(goTopology(files), springTopology(plan(name, { broker: 'rabbitmq' }, planSpring)));
    const go = content(files, `${RABBIT}/topology.go`);
    for (const entry of rabbitTopology(model)) {
      const row = new RegExp(`\\{Source: "${entry.source}", Queue: "${entry.queue}"[^\\n]*\\}`).exec(go)?.[0];
      assert.ok(row, entry.queue);
      assert.equal(/RetriesNotFound: true/.test(row), entry.retriesNotFound, `${entry.queue}: RetriesNotFound`);
    }
  });
}

test('el reintento del listener es el de keel-core (rabbitListenerRetry), y sin onFailure.retry un solo intento', () => {
  for (const name of MESSAGING_FIXTURES) {
    const { model, files } = planService({ ...design(name), workspace: FIXTURES_DIR, stack: { broker: 'rabbitmq' } });
    const go = content(files, `${RABBIT}/topology.go`);
    const retry = rabbitListenerRetry(model);
    if (!retry) {
      assert.match(go, /\tretry = nil\n/, name);
      continue;
    }
    const multiplier = Number.isInteger(retry.multiplier) ? `${retry.multiplier}\\.0` : String(retry.multiplier).replace('.', '\\.');
    assert.match(go, new RegExp(`retry = &ListenerRetry\\{Attempts: ${retry.attempts}, Initial: ${retry.initialMs} \\* time\\.Millisecond, Multiplier: ${multiplier}[,}]`), name);
  }
});

// ─── Kafka (tramo 9f) ────────────────────────────────────────────────────────────────────────────

const KAFKA = 'internal/infrastructure/kafka';

/** El consumo que declara consumption.go: `{Subscription: "…", Topic: "…", GroupID: "…", …}`. */
function goConsumption(files) {
  const go = content(files, `${KAFKA}/consumption.go`);
  return [...go.matchAll(/\{Subscription: "([^"]+)", Topic: "([^"]+)", GroupID: "([^"]+)"([^}]*)\}/g)].map((m) => ({
    subscription: m[1],
    topic: m[2],
    groupId: m[3],
    deadLetter: m[4].includes('DeadLetter: true'),
    retriesNotFound: m[4].includes('RetriesNotFound: true')
  }));
}

/** Lo que decide el servidor de keel-spring con Kafka: los dos conjuntos por topic, la curva del reintento y los grupos. */
function springKafka(files) {
  const java = files.find((file) => file.path.endsWith('/DeadLetterConfig.java')).content;
  const set = (name) => [...(new RegExp(`Set<String> ${name} = Set\\.of\\(([^)]*)\\)`).exec(java)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const exponential = /setInitialInterval\((\d+)L\);(?:\s*backOff\.setMaxInterval\((\d+)L\);)?\s*backOff\.setMaxAttempts\((\d+)\)/.exec(java);
  const fixed = /new FixedBackOff\((\d+)L, (\d+)L\)/.exec(java);
  const retry = exponential
    ? { initialMs: Number(exponential[1]), maxDelayMs: exponential[2] ? Number(exponential[2]) : 30000, attempts: Number(exponential[3]) + 1 }
    : { initialMs: Number(fixed[1]), maxDelayMs: null, attempts: Number(fixed[2]) + 1 };
  const flow = files.find((file) => file.path.endsWith('/AbstractFlowIT.java')).content;
  const groups = /CONSUMER_GROUP_IDS = List\.of\(([^)]*)\)/.exec(flow)[1];
  return { deadLettered: set('DEAD_LETTERED'), retriesNotFound: set('RETRIES_NOT_FOUND'), retry, groups: [...groups.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() };
}

test('stock-reservation-events: la conexión con Kafka, su configuración y el cliente en go.mod', () => {
  const files = plan('stock-reservation-events', { broker: 'kafka' });
  for (const name of ['doc', 'consumption', 'settings', 'connection', 'kafka_test']) assert.ok(content(files, `${KAFKA}/${name}.go`), name);
  assert.match(content(files, 'go.mod'), /\tgithub\.com\/twmb\/franz-go v1\.22\.2\n/);
  assert.doesNotMatch(content(files, 'go.mod'), /amqp091|kadm/);
  const connection = content(files, `${KAFKA}/connection.go`);
  // El productor crea el topic con el primer mensaje y espera la confirmación; el offset se confirma a mano tras el
  // desenlace, y un grupo nuevo lee desde el principio.
  assert.match(connection, /kgo\.AllowAutoTopicCreation\(\)/);
  // El plazo de delivery.timeout.ms es un tope duro también para el envío en vuelo (FL-BRK-002-D de broker-check).
  assert.match(connection, /kgo\.AllowIdempotentProduceCancellation\(\)/);
  assert.match(connection, /producer\.ProduceSync\(ctx, record\)\.FirstErr\(\)/);
  assert.match(connection, /kgo\.DisableAutoCommit\(\)/);
  assert.match(connection, /consumer\.CommitRecords\(commitCtx, record\)/);
  assert.match(connection, /kgo\.ConsumeResetOffset\(kgo\.NewOffset\(\)\.AtStart\(\)\)/);
  // El descarte con los headers de Spring Kafka.
  for (const header of ['original-topic', 'original-partition', 'original-offset', 'original-consumer-group', 'exception-fqcn', 'exception-message']) {
    assert.ok(connection.includes(`"kafka_dlt-${header}"`), header);
  }
  assert.match(connection, /clientID = "stock-reservation-events"/);
  // Sin Kafka, ni el paquete ni el módulo.
  const rabbit = plan('stock-reservation-events');
  assert.doesNotMatch(content(rabbit, 'go.mod'), /franz-go/);
  assert.equal(rabbit.find((file) => file.path.startsWith(`${KAFKA}/`)), undefined);
});

for (const name of MESSAGING_FIXTURES) {
  test(`${name}: kafka.yaml es el de keel-dotnet, byte a byte, en los cuatro perfiles`, () => {
    const ours = plan(name, { broker: 'kafka' });
    const dotnet = plan(name, { broker: 'kafka' }, planDotnet);
    for (const profile of PROFILES) {
      const file = `config/parameters/${profile}/kafka.yaml`;
      assert.ok(content(ours, file), file);
      assert.equal(content(ours, file), content(dotnet, file), file);
    }
  });

  test(`${name}: toda clave que lee kafka.SettingsFrom existe en su kafka.yaml`, () => {
    const files = plan(name, { broker: 'kafka' });
    const yaml = flatten(parseYaml(content(files, 'config/parameters/local/kafka.yaml')));
    const keys = [...content(files, `${KAFKA}/settings.go`).matchAll(/"(kafka\.[a-z0-9.-]+)"/g)].map((match) => match[1]);
    assert.ok(keys.length >= 6, keys.join(', '));
    for (const key of keys) assert.ok(yaml.has(key), `${key} no está en kafka.yaml`);
  });

  test(`${name}: el consumo de Kafka es el de keel-spring (grupos, descarte y «no existe» por topic, y la curva del reintento)`, () => {
    const { model, files } = planService({ ...design(name), workspace: FIXTURES_DIR, stack: { broker: 'kafka' } });
    const consumption = goConsumption(files);
    assert.deepEqual(consumption, kafkaConsumption(model));
    if (consumption.length === 0) return;
    const spring = springKafka(plan(name, { broker: 'kafka' }, planSpring));
    assert.deepEqual(consumption.map((entry) => entry.groupId).sort(), spring.groups);
    assert.deepEqual([...new Set(consumption.filter((entry) => entry.deadLetter).map((entry) => entry.topic))].sort(), spring.deadLettered);
    assert.deepEqual([...new Set(consumption.filter((entry) => entry.retriesNotFound).map((entry) => entry.topic))].sort(), spring.retriesNotFound);
    const retry = kafkaListenerRetry(model);
    if (retry.deadLetteredTopics.length > 0) {
      assert.deepEqual({ initialMs: retry.initialMs, maxDelayMs: retry.maxDelayMs, attempts: retry.attempts }, spring.retry);
    }
    assert.ok(content(files, `${KAFKA}/consumption.go`).includes(`\tretry = ${retryLiteral(retry)}\n`), name);
  });
}

test('con Kafka, el arranque cablea su conexión y lo del agente la recibe', () => {
  const files = plan('stock-reservation-events', { broker: 'kafka' });
  const main = content(files, 'cmd/server/main.go');
  assert.match(main, /kafkaConnSettings, err := kafka\.SettingsFrom\(cfg\)/);
  assert.match(main, /kafkaConn := kafka\.New\(kafkaConnSettings, messagingSettings, logger\)/);
  assert.match(main, /adapters, err := brokerAdapters\(messagingSettings, kafkaConn, logger\)/);
  assert.match(main, /return kafkaConn\.Run\(groupCtx\)/);
  assert.match(main, /Kafka: +kafkaConn,/);
  assert.match(content(files, 'cmd/server/broker.go'), /func brokerAdapters\(settings messaging\.Settings, kafkaConn \*kafka\.Connection, logger \*slog\.Logger\) \(outbound, error\)/);
  assert.match(content(files, 'cmd/server/messaging.go'), /\tKafka +\*kafka\.Connection\n/);
});
