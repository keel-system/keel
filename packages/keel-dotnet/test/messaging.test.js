// La mensajería de keel-dotnet (incremento 9) sobre el texto emitido: qué se emite y dónde, la configuración —la MISMA
// que keel-nest, byte a byte—, la topología de RabbitMQ contra la RabbitTopologyConfig que EMITE keel-spring, las claves
// que lee MessagingSettings contra las que escribe messaging.yaml, y el puente en el adaptador de repositorio. Lo que
// ejecuta el C# (la envoltura en el cable, la lectura, el contrato de cada suscripción, el backoff) lo mide la prueba
// emitida MessagingTests en `npm run cs-check`; las tablas, `schema-parity.test.js`; contra un broker real,
// `broker-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { rabbitTopology, snsSqsConsumption } from '@keel-system/keel-core/gen/messaging-plan';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const RABBIT = { broker: 'rabbitmq', database: 'postgresql' };
const MESSAGING_FIXTURES = ['metering-digest', 'notification-mailer', 'stock-reservation', 'stock-reservation-events', 'catalog-extended', 'payment-checkout'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: RABBIT });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

test('stock-reservation-events: la envoltura, el puente, el outbox, la guarda, los mensajes y la conexión con RabbitMQ', () => {
  const { files } = plan('stock-reservation-events');
  const root = 'src/StockReservationEvents.Infrastructure/Messaging';
  for (const name of ['EventEnvelope', 'MessageContractViolation', 'MessagingSettings', 'InboundContext', 'BrokerBindings', 'MessagingRegistration', 'StockReservationEventsDomainEventBridge']) {
    assert.ok(content(files, `${root}/${name}.cs`), name);
  }
  for (const name of ['IOutboxDispatcher', 'OutboxDispatcherFallback', 'OutboxBackoff', 'OutboxRelayStore', 'OutboxRelay']) assert.ok(content(files, `${root}/Outbox/${name}.cs`), name);
  assert.ok(content(files, `${root}/Idempotency/IdempotencyGuard.cs`));
  for (const name of ['RabbitTopology', 'RabbitMqSettings', 'RabbitConnection']) assert.ok(content(files, `${root}/RabbitMq/${name}.cs`), name);
  for (const name of ['StockReservedMessage', 'StockCountAdjustedMessage', 'StockRejectedMessage']) assert.ok(content(files, `${root}/Subscriptions/${name}.cs`), name);
  // Con outbox no hay publisher best-effort.
  assert.equal(content(files, 'IStockReservationRequestedPublisher.cs'), undefined);
  assert.ok(content(files, 'tests/StockReservationEvents.UnitTests/MessagingTests.cs'));
});

for (const name of MESSAGING_FIXTURES) {
  test(`${name}: messaging.yaml y rabbitmq.yaml son los de keel-nest, byte a byte, en los cuatro perfiles`, () => {
    const ours = plan(name).files;
    const nest = plan(name, planNest).files;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      for (const fragment of ['messaging', 'rabbitmq']) {
        const file = `config/parameters/${profile}/${fragment}.yaml`;
        assert.ok(content(ours, file), `${file} se emite`);
        assert.equal(content(ours, file), content(nest, file), file);
      }
    }
  });
}

/** La topología que declara RabbitTopologyConfig de keel-spring: una entrada por @Bean. */
function springTopology(files) {
  const java = content(files, '/RabbitTopologyConfig.java') ?? '';
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

/** Las colas que declara RabbitTopology.cs: `new("<origen>", "<cola>", "<dlq>"|null, …)`. */
function dotnetTopology(files) {
  const cs = content(files, '/RabbitMq/RabbitTopology.cs');
  const queues = /Queues \{ get; \} =\s*\[([\s\S]*?)\];/.exec(cs)[1];
  return [...queues.matchAll(/new\("([^"]+)", "([^"]+)", (?:"([^"]+)"|null), (true|false), /g)].map((m) => ({ source: m[1], queue: m[2], deadLetter: m[3] ?? null }));
}

for (const name of ['metering-digest', 'notification-mailer', 'stock-reservation', 'catalog-extended']) {
  test(`${name}: la topología de RabbitMQ es la de keel-spring`, () => {
    assert.deepEqual(dotnetTopology(plan(name).files), springTopology(plan(name, planSpring).files));
  });
}

test('el reintento del «no existe» va por COLA, como RETRIES_NOT_FOUND de keel-spring', () => {
  for (const name of MESSAGING_FIXTURES) {
    const { model, files } = plan(name);
    const cs = content(files, '/RabbitMq/RabbitTopology.cs');
    for (const entry of rabbitTopology(model)) {
      assert.match(cs, new RegExp(`new\\("${entry.source}", "${entry.queue}", [^,]+, ${entry.retriesNotFound}, `), `${name}: ${entry.queue}`);
    }
  }
});

/** Las claves de un YAML, aplanadas con `:` (como las lee ServiceConfiguration). */
function flatKeys(text, prefix = '') {
  const keys = [];
  const walk = (node, at) => {
    for (const [key, value] of Object.entries(node ?? {})) {
      const full = at ? `${at}:${key}` : key;
      if (value && typeof value === 'object') walk(value, full);
      else keys.push(full);
    }
  };
  walk(parseYaml(text), prefix);
  return keys;
}

for (const name of MESSAGING_FIXTURES) {
  test(`${name}: lo que lee MessagingSettings y RabbitMqSettings existe en su YAML (una clave mal escrita sería una palanca muerta)`, () => {
    const { files } = plan(name);
    const declared = new Set([...flatKeys(content(files, 'config/parameters/develop/messaging.yaml')), ...flatKeys(content(files, 'config/parameters/develop/rabbitmq.yaml'))]);
    const read = [content(files, '/Messaging/MessagingSettings.cs'), content(files, '/RabbitMq/RabbitMqSettings.cs')]
      .flatMap((cs) => [...cs.matchAll(/"((?:messaging|outbox|processed-event|rabbitmq):[a-z0-9:.-]+)"/g)].map((m) => m[1]));
    assert.ok(read.length > 0);
    for (const key of read) assert.ok(declared.has(key), `${name}: ${key} no está en el YAML`);
  });
}

test('el adaptador de repositorio entrega los eventos al puente ANTES de SaveChanges (la fila del outbox va en el mismo)', () => {
  const { files } = plan('stock-reservation-events');
  const adapter = content(files, '/Persistence/Repositories/ReservationRepository.cs');
  assert.match(adapter, /StockReservationEventsDomainEventBridge events\)/);
  const publish = adapter.indexOf('events.Publish(entity.PullDomainEvents());');
  assert.ok(publish > 0);
  assert.ok(publish < adapter.indexOf('await db.SaveChangesAsync(cancellationToken);', publish - 2000) || adapter.indexOf('await db.SaveChangesAsync(cancellationToken);', publish) > publish);
  const bridge = content(files, '/Messaging/StockReservationEventsDomainEventBridge.cs');
  assert.match(bridge, /db\.Set<OutboxEventRow>\(\)\.Add/);
  assert.doesNotMatch(bridge, /AfterCommit/);
});

test('best-effort (metering-digest): el puente publica tras el commit por el puerto, con un respaldo que avisa', () => {
  const { files } = plan('metering-digest');
  const bridge = content(files, '/Messaging/MeteringDigestDomainEventBridge.cs');
  assert.match(bridge, /transactions\.AfterCommit\(\(\) => dailyDigestClosedPublisher\.Publish\(integration, correlationId, CancellationToken\.None\)\)/);
  assert.doesNotMatch(bridge, /OutboxEventRow/);
  assert.ok(content(files, '/Messaging/IDailyDigestClosedPublisher.cs'));
  assert.ok(content(files, '/Messaging/DailyDigestClosedPublisherStub.cs'));
  assert.equal(content(files, '/Outbox/OutboxRelay.cs'), undefined, 'sin outbox no hay relay');
  const registration = content(files, '/Messaging/MessagingRegistration.cs');
  // Lo del agente entra antes, y el respaldo con TryAdd: ocupa solo el hueco libre.
  assert.ok(registration.indexOf('BrokerBindings.AddBrokerAdapters(services);') < registration.indexOf('services.AddDomainEvents(settings);'));
  assert.match(registration, /services\.TryAddSingleton<IDailyDigestClosedPublisher, DailyDigestClosedPublisherStub>\(\);/);
});

test('una fuente ajena (metering-digest): el mensaje se lee por los nombres de la fuente y su envoltura propia por payloadPath', () => {
  const { files } = plan('metering-digest');
  const message = content(files, '/Subscriptions/MeterReadingCapturedMessage.cs');
  assert.match(message, /JsonBodyReader\.Value<Guid\?>\(fields, "meter_id"\)/);
  assert.match(message, /MeterReadingCaptured: el mensaje no trae 'meterId', que el contrato declara obligatorio/);
  const envelope = content(files, '/Subscriptions/MeterReadingCapturedEnvelope.cs');
  assert.match(envelope, /public MeterReadingCapturedMessage Message\(\)/);
});

test('el paquete de RabbitMQ solo viaja con RabbitMQ, y la frontera aún no deja elegir Kafka', () => {
  const rabbit = plan('stock-reservation-events').files;
  assert.match(content(rabbit, 'Directory.Packages.props'), /RabbitMQ\.Client" Version="7\.2\.2"/);
  const plain = planService({ ...design('product-catalog'), workspace: FIXTURES_DIR, stack: RABBIT }).files;
  assert.doesNotMatch(content(plain, 'Directory.Packages.props'), /RabbitMQ/);
});

// ─── El arnés (incremento 9c) ────────────────────────────────────────────────

test('el arnés de mensajería: los helpers de keel-spring y keel-nest, con los comandos de broker-probes y la conexión por su nombre', () => {
  const { files } = plan('stock-reservation-events');
  const harness = content(files, '.IntegrationTests/Support/Messaging.cs');
  for (const helper of ['PublishedMessages', 'DeadLetterMessages', 'PurgeMessages', 'DeliverMessage', 'DeliverStockReserved', 'StopBroker', 'StartBroker', 'DeadLetteredEvents', 'AbandonOutboxEvent', 'ClearAbandonedOutboxEvents']) {
    assert.ok(harness.split('\n').some((line) => line.includes('protected static ') && line.includes(` ${helper}(`)), helper);
  }
  // Los comandos son los de keel-core/gen/broker-probes.js (la API de gestión por el contenedor devtools).
  assert.match(harness, /"http:\/\/rabbitmq:15672\/api\/queues\/%2F\/"/);
  assert.ok(harness.includes('ack_requeue_true'), 'el cuerpo del peek es el de rabbitProbeBody');
  // El arnés busca la conexión del servicio por el nombre que declara la conexión emitida.
  assert.match(harness, /ConnectionName = "stock-reservation-events"/);
  assert.match(content(files, '/RabbitMq/RabbitConnection.cs'), /ClientProvidedName = "stock-reservation-events"/);
  // Cada flujo abre con el broker arriba y el servidor conectado, y el humo lo afirma.
  assert.match(content(files, '.IntegrationTests/Support/FlowTest.cs'), /await BrokerHarness\.PrepareAsync\(\);/);
  assert.match(content(files, '.IntegrationTests/HarnessSmoke.cs'), /SMOKE-8: el broker responde y el servidor está conectado a él/);
});

test('sin outbox (metering-digest) el arnés no trae los helpers del outbox; sin mensajería, ni el archivo', () => {
  const harness = content(plan('metering-digest').files, '.IntegrationTests/Support/Messaging.cs');
  assert.doesNotMatch(harness, /DeadLetteredEvents|AbandonOutboxEvent/);
  assert.match(harness, /public static Task AwaitOutboxDrained\(string channel\) => Task\.CompletedTask;/);
  assert.equal(content(plan('product-catalog').files, '.IntegrationTests/Support/Messaging.cs'), undefined);
});

// ─── Kafka (incremento 9f) ───────────────────────────────────────────────────

test('con Kafka: messaging.yaml (con el group-id) y kafka.yaml son los de keel-nest, byte a byte', () => {
  const stack = { broker: 'kafka', database: 'postgresql' };
  for (const name of ['stock-reservation-events', 'metering-digest']) {
    const ours = planService({ ...design(name), workspace: FIXTURES_DIR, stack }).files;
    const nest = planNest({ ...design(name), workspace: FIXTURES_DIR, stack }).files;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      for (const fragment of ['messaging', 'kafka']) {
        const file = `config/parameters/${profile}/${fragment}.yaml`;
        assert.ok(content(ours, file), `${name}: ${file}`);
        assert.equal(content(ours, file), content(nest, file), `${name}: ${file}`);
      }
    }
    assert.equal(content(ours, 'rabbitmq.yaml'), undefined, 'sin RabbitMQ');
    assert.match(content(ours, 'Directory.Packages.props'), /Confluent\.Kafka" Version="2\.15\.1"/);
  }
});

test('con Kafka: el consumo es el de keel-core (un grupo por suscripción) y el arnés marca offsets en vez de purgar', () => {
  const { files } = planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack: { broker: 'kafka', database: 'postgresql' } });
  const consumption = content(files, '/Kafka/KafkaConsumption.cs');
  for (const group of ['stock-reservation-events-stock-reserved', 'stock-reservation-events-stock-rejected', 'stock-reservation-events-stock-count-adjusted']) {
    assert.ok(consumption.includes(`"${group}"`), group);
  }
  const harness = content(files, '.IntegrationTests/Support/Messaging.cs');
  assert.ok(harness.includes('MarkChannels()') && harness.includes('DescribeConsumerGroupsAsync'));
  assert.match(content(files, '.IntegrationTests/StockReservationEvents.IntegrationTests.csproj'), /PackageReference Include="Confluent.Kafka"/);
});

// ─── SNS/SQS (incremento 9g) ─────────────────────────────────────────────────

test('con SNS/SQS: messaging.yaml y snssqs.yaml son los de keel-nest, byte a byte, y la topología la siembra init-messaging.sh', () => {
  const stack = { broker: 'snssqs', database: 'postgresql' };
  for (const name of ['stock-reservation-events', 'metering-digest']) {
    const ours = planService({ ...design(name), workspace: FIXTURES_DIR, stack }).files;
    const nest = planNest({ ...design(name), workspace: FIXTURES_DIR, stack }).files;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      for (const fragment of ['messaging', 'snssqs']) {
        const file = `config/parameters/${profile}/${fragment}.yaml`;
        assert.ok(content(ours, file), `${name}: ${file}`);
        assert.equal(content(ours, file), content(nest, file), `${name}: ${file}`);
      }
    }
    assert.equal(content(ours, 'rabbitmq.yaml'), undefined, 'sin RabbitMQ');
    assert.match(content(ours, 'Directory.Packages.props'), /AWSSDK\.SimpleNotificationService" Version="4\.0\.100\.15"/);
    assert.match(content(ours, 'Directory.Packages.props'), /AWSSDK\.SQS" Version="4\.0\.100\.14"/);
    // El script de la topología es el neutral: crea las MISMAS colas que el de keel-nest.
    const queuesOf = (files) => [...content(files, 'infra/init-messaging.sh').matchAll(/^create_queue(?:_with_dlq)? '([\w.-]+)'/gm)].map((match) => match[1]).sort();
    assert.ok(queuesOf(ours).length > 0, `${name}: init-messaging.sh crea colas`);
    assert.deepEqual(queuesOf(ours), queuesOf(nest), `${name}: las colas`);
  }
});

test('con SNS/SQS: el consumo es el de keel-core (una cola por suscripción, su DLQ y su maxReceiveCount)', () => {
  const generated = planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack: { broker: 'snssqs', database: 'postgresql' } });
  const consumption = content(generated.files, '/SnsSqs/SnsSqsConsumption.cs');
  for (const entry of snsSqsConsumption(generated.model)) {
    assert.ok(consumption.includes(`new("${entry.subscription}", "${entry.queue}", ${entry.deadLetterQueue ? `"${entry.deadLetterQueue}"` : 'null'}, ${entry.retriesNotFound}, ${entry.maxReceive},`), entry.subscription);
  }
  const harness = content(generated.files, '.IntegrationTests/Support/Messaging.cs');
  assert.ok(harness.includes('init-messaging.sh'), 'el arnés resiembra la topología al levantar el broker');
});

test('con SNS/SQS y un servicio que solo PUBLICA: MessagingTests no lleva un [Theory] sin filas (xUnit1003 rompía el build)', () => {
  // La corrida catalog-dotnet-mysql-sns (2026-10-21): el catálogo publica y no se suscribe a nada. Ninguna fixture tenía
  // esa forma con SNS/SQS, así que la curva de visibilidad salía como [Theory] vacío y el proyecto no compilaba.
  const publishing = design('catalog-extended');
  const onlyPublishes = { ...publishing, layers: { ...publishing.layers, messaging: { ...publishing.layers.messaging, subscriptions: {} } } };
  const generated = planService({ ...onlyPublishes, workspace: FIXTURES_DIR, stack: { broker: 'snssqs', database: 'mysql' } });
  assert.equal(snsSqsConsumption(generated.model).length, 0, 'el diseño derivado no consume nada');
  const tests = content(generated.files, 'tests/CatalogExtended.UnitTests/MessagingTests.cs') ?? content(generated.files, '/MessagingTests.cs');
  assert.ok(tests, 'MessagingTests se emite');
  assert.doesNotMatch(tests, /LaVisibilidadTrasUnFalloSigueLaCurvaDelDiseño/);
  assert.doesNotMatch(tests, /\[Theory\]\s*\n\s*public/, 'ningún [Theory] sin InlineData');
  assert.match(tests, /ElContratoIncumplidoNoSeReintentaEnSqs/);
  // Con suscripciones, la curva sigue ahí.
  const consuming = planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack: { broker: 'snssqs', database: 'mysql' } });
  assert.match(content(consuming.files, '/MessagingTests.cs'), /\[InlineData\(0, 1, \d+\)\]\s*\n(?:\s*\[InlineData[^\n]*\n)*\s*public void LaVisibilidadTrasUnFalloSigueLaCurvaDelDiseño/);
});

test('con SNS/SQS y outbox relacional: la marca del aparcado no lleva zona y aparcar va dentro del try', () => {
  // MySQL rechaza '…+00' en un DATETIME (ERROR 1292): la resiembra de la topología moría antes de init-messaging.sh y los
  // flujos siguientes caían con NonExistentQueue. Y con ParkOutbox fuera del try, una segunda pasada fallida dejaba las
  // filas de la primera aparcadas para siempre.
  for (const database of ['mysql', 'postgresql']) {
    const generated = planService({ ...design('stock-reservation-events'), workspace: FIXTURES_DIR, stack: { broker: 'snssqs', database } });
    const harness = content(generated.files, '.IntegrationTests/Support/Messaging.cs');
    assert.match(harness, /private const string Parked = "2999-01-01 00:00:00";/, database);
    const connected = /public static async Task AwaitServerConnectedAsync\(\)\s*\{([\s\S]*?)\n    \}\n/.exec(harness)[1];
    const tryAt = connected.indexOf('try');
    assert.ok(tryAt >= 0 && tryAt < connected.indexOf('ParkOutbox();'), `${database}: ParkOutbox dentro del try`);
    assert.ok(connected.indexOf('ParkOutbox();') < connected.indexOf('init-messaging.sh'), `${database}: se aparca antes de resembrar`);
    assert.match(connected, /finally\s*\{\s*UnparkOutbox\(\);/, `${database}: el finally devuelve lo aparcado`);
  }
});
