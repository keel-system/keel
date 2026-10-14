#!/usr/bin/env node
// La MENSAJERÍA de keel-dotnet contra un RabbitMQ y un Kafka reales (incrementos 9c y 9f): lo único que dice que la conexión, la
// topología, la publicación con confirmación y `mandatory`, el consumo con su reintento y su descarte, el relay del
// outbox y los helpers del arnés funcionan juntos. Es el broker-check de keel-nest y keel-spring para este generador.
//
// Por qué no está en `npm test`: necesita el SDK 10, red (NuGet restaura el proyecto), podman o docker, y minutos.
//
//   node packages/keel-dotnet/scripts/broker-check.js [--broker=rabbitmq,kafka] [--keep]
//   npm run broker-check --workspace packages/keel-dotnet
//
// El sujeto es stock-reservation-events: outbox, y tres suscripciones Keel de la misma fuente que comparten cola, con
// reintento y descarte. Lo que en el proyecto escribiría el agente se escribe aquí como SONDA, registrado donde lo
// registraría él (BrokerBindings.cs): un dispatcher del outbox sobre RabbitConnection.Publish y un listener sobre
// RabbitConnection.Consume cuyo comportamiento lo decide el eventId (7e000000-… falla de forma transitoria, b0000000-…
// es un rechazo de negocio, el resto se procesa con IdempotencyGuard.TryRecord). Como el servidor es un proceso aparte,
// el listener anota cada intento en build/broker-probe/attempts.log, que los flujos leen.
//
// Los flujos sonda usan SOLO los helpers que el arnés emite (DeliverStockReserved, PublishedMessages,
// DeadLetterMessages, StopBroker…) y los puntúa infra/score-scenarios.sh, así que lo que se mide es lo que el agente de
// pruebas tendrá. Al final se falsa: con el rechazo de negocio tratado como reintentable, sale FALLO el caso que lo
// afirma, y solo él.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { kafkaListenerRetry, rabbitListenerRetry } from 'keel-core/gen';
import { resolveStack, writeStackConfig } from 'keel-core/gen/stack';
import { makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { solution } from '../src/scaffold/render.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';

const DESIGN = 'stock-reservation-events';
const brokerArg = process.argv.find((arg) => arg.startsWith('--broker='));
const BROKERS = brokerArg ? brokerArg.slice('--broker='.length).split(',') : ['rabbitmq', 'kafka'];
const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function bashExecutable() {
  if (process.env.BASH_EXECUTABLE) return process.env.BASH_EXECUTABLE;
  if (isWindows) {
    for (const candidate of [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('broker-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function dotnet(cwd, args) {
  const result = spawnSync('dotnet', args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function checkBroker(broker) {
  const kafka = broker === 'kafka';
  const label = kafka ? 'Kafka' : 'RabbitMQ';
  const stack = { database: 'postgresql', broker };
  const step = (name, ok, detail = '') => record(`${label}: ${name}`, ok, detail);
  console.log(`\n── ${label} ──`);
  // ── El proyecto, generado por build como en una corrida ──────────────────────────────────────────
  const workspace = makeWorkspace(`keel-dotnet-broker-${broker}-`);
  const specDir = mountDesign(workspace, DESIGN);
  const projectDir = path.join(workspace, 'services', `${DESIGN}-dotnet`);
  fs.mkdirSync(projectDir, { recursive: true });
  const design = loadService(specDir);
  writeStackConfig(projectDir, resolveStack(stack, design.layers));
  const generated = await runCommand(workspace, build, `specs/${DESIGN}`, { defaults: true, acceptUnready: true });
  const { model } = planService({ ...design, workspace, stack });
  const sln = solution(model);
  if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, sln.file)), generated.exitCode ? generated.output : '')) {
    return;
  }

  // ── Lo del agente, como sonda: lo único que cambia de un broker a otro es la conexión ─────────────
  const root = sln.root;
  const dir = kafka ? 'Kafka' : 'RabbitMq';
  const connection = kafka ? 'KafkaConnection' : 'RabbitConnection';
  const publishCall = kafka
    ? 'connection.Publish(destination, routingKey, payload, cancellationToken: cancellationToken)'
    : 'connection.Publish(destination, routingKey, payload, eventType, cancellationToken: cancellationToken)';
  const bodyMember = kafka ? 'Value' : 'Body';
  const sub = model.subscriptions.find((candidate) => candidate.name === 'StockReserved');
  // RabbitMQ consume de la COLA de la suscripción; Kafka, de la suscripción por su nombre (con su consumer group).
  // En Kafka cada suscripción tiene su grupo y su listener: la sonda registra TODAS (un proyecto completo las tiene, y el
  // arnés espera a sus grupos), y cada consumidor actúa solo sobre la suya.
  const allSubscriptions = model.subscriptions.map((candidate) => `"${candidate.name}"`).join(', ');
  const consumeCall = kafka
    ? `foreach (var subscription in (string[])[${allSubscriptions}]) connection.Consume(subscription`
    : `connection.Consume(settings.Subscriptions["${sub.name}"].Queue!`;
  const ownFilter = kafka ? `subscription != "${sub.name}" || envelope.Metadata.EventType != "${sub.name}"` : `envelope.Metadata.EventType != "${sub.name}"`;
  const listenerParams = kafka ? `${connection} connection, IdempotencyGuard guard` : `${connection} connection, IdempotencyGuard guard, MessagingSettings settings`;
  const event = model.events[0];
  const channel = model.messaging.publishChannels[0];
  const attempts = kafka ? kafkaListenerRetry(model).attempts : rabbitListenerRetry(model).attempts;
  const messagingDir = path.join(projectDir, sln.infrastructure.dir, 'Messaging');

  fs.writeFileSync(
    path.join(messagingDir, dir, 'ProbeOutboxDispatcher.cs'),
    `namespace ${root}.Infrastructure.Messaging.${dir};

  using ${root}.Infrastructure.Messaging.Outbox;

  /// <summary>Sonda del dispatcher que escribiría el agente: la fila tal cual, con su tipo, y espera la confirmación.</summary>
  public sealed class ProbeOutboxDispatcher(${connection} connection) : IOutboxDispatcher
  {
      public Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default) =>
          ${publishCall};
  }
  `
  );
  fs.writeFileSync(
    path.join(messagingDir, dir, 'ProbeListener.cs'),
    `namespace ${root}.Infrastructure.Messaging.${dir};

  using Microsoft.Extensions.Hosting;
  using ${root}.Domain.Errors;
  using ${root}.Infrastructure.Messaging.Idempotency;
  using ${root}.Infrastructure.Messaging.Subscriptions;

  /// <summary>
  /// Sonda del listener que escribiría el agente. Lo que hace lo decide el eventId: 7e000000-… falla de forma transitoria
  /// (se reintenta y acaba en el descarte), b0000000-… es un rechazo de negocio (descarte sin reintento); el resto se
  /// procesa con IdempotencyGuard.TryRecord. Cada intento queda anotado en build/broker-probe/attempts.log.
  /// </summary>
  public sealed class ProbeListener(${listenerParams}) : IHostedService
  {
      private static readonly Lock Gate = new();

      public Task StartAsync(CancellationToken cancellationToken)
      {
          ${consumeCall}, async (message, token) =>
          {
              var envelope = EventEnvelope.Parse(message.${bodyMember});
              // El canal lo comparten varias suscripciones: lo que no es nuestro se descarta SIN lanzar.
              if (${ownFilter})
              {
                  return;
              }
              var eventId = envelope.Metadata.EventId.ToString();
              lock (Gate)
              {
                  Directory.CreateDirectory(Path.Combine("build", "broker-probe"));
                  File.AppendAllText(Path.Combine("build", "broker-probe", "attempts.log"), eventId + "\\n");
              }
              var payload = ${sub.messageRecord}.FromWire(envelope.Data);
              payload.RequireContract();
              if (eventId.StartsWith("7e000000", StringComparison.Ordinal))
              {
                  throw new InvalidOperationException("fallo transitorio de la sonda");
              }
              if (eventId.StartsWith("b0000000", StringComparison.Ordinal))
              {
                  throw new BusinessException("rechazo de negocio de la sonda", code: "PROBE_REJECTED");
              }
              await guard.TryRecord("ProbeListener", eventId, token);
          });
          return Task.CompletedTask;
      }

      public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
  }
  `
  );
  fs.writeFileSync(
    path.join(messagingDir, 'BrokerBindings.cs'),
    `namespace ${root}.Infrastructure.Messaging;

  using Microsoft.Extensions.DependencyInjection;
  using ${root}.Infrastructure.Messaging.Outbox;
  using ${root}.Infrastructure.Messaging.${dir};

  /// <summary>Lo de la sonda, registrado donde lo registraría el agente.</summary>
  public static class BrokerBindings
  {
      public static void AddBrokerAdapters(IServiceCollection services) => services.AddSingleton<IOutboxDispatcher, ProbeOutboxDispatcher>();

      public static void AddMessageListeners(IServiceCollection services) => services.AddHostedService<ProbeListener>();
  }
  `
  );

  // ── Los flujos sonda: SOLO helpers del arnés (y el contador de la sonda) ─────────────────────────
  const orderJson = JSON.stringify({ orderId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' });
  const destination = model.messaging.destinationDefault;
  const routingKey = event.routingKeyDefault;
  const cs = (value) => JSON.stringify(value);
  const envelopeTemplate = JSON.stringify({
    metadata: { eventId: 'EVENT_ID', eventType: event.name, eventVersion: 1, occurredAt: '2026-10-14T10:00:00.000Z', source: DESIGN, correlationId: null, traceparent: null },
    data: { orderId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }
  });
  const foreign = JSON.stringify({
    metadata: { eventId: 'EVENT_ID', eventType: 'SomethingElse', eventVersion: 1, occurredAt: '2026-10-14T10:00:00.000Z', source: 'inventory', correlationId: null, traceparent: null },
    data: {}
  });
  const flowsDir = path.join(projectDir, sln.integrationTests.dir);
  // Lo propio de cada broker. RabbitMQ: el tipo nativo y `mandatory` (lo que no tiene cola no se da por publicado).
  // Kafka: la clave del registro es la routing key, y el descarte conserva la clave y lleva los headers de Spring Kafka.
  const publishedShape = kafka
    ? `Assert.Equal(${cs(routingKey)}, message.RoutingKey);`
    : `Assert.Equal(${cs(routingKey)}, message.RoutingKey);
          Assert.Equal(${cs(event.name)}, message.Properties.GetProperty("type").GetString());`;
  const mandatoryCase = kafka
    ? ''
    : `
      [Scenario("FL-BRK-002-B: lo que no tiene cola (mandatory) no se da por publicado")]
      public async Task SinColaNoSePublica()
      {
          var id = BrokerProbe.Id();
          BrokerProbe.OutboxRow(id, "keel.sin-ruta", BrokerProbe.Envelope(BrokerProbe.Id()));
          // Hasta que el relay la intente o la dé por publicada: lo segundo es el fallo que se mide, y tiene que decirlo.
          await Eventually(() => Task.FromResult(BrokerProbe.Count($"SELECT COUNT(*) FROM outbox_event WHERE id = '{id}' AND (attempts >= 1 OR published_at IS NOT NULL)") == 1), TimeSpan.FromSeconds(20), "el relay no lo intentó");
          Assert.Equal(1, BrokerProbe.Count($"SELECT COUNT(*) FROM outbox_event WHERE id = '{id}' AND published_at IS NULL"));
          Db($"DELETE FROM outbox_event WHERE id = '{id}'");
      }
  `;
  const deadLetterShape = kafka
    ? `

      [Scenario("FL-BRK-001-H: el descarte conserva la clave y lleva los headers de Spring Kafka (topic de origen y excepción)")]
      public async Task ElDescarteLlevaLosHeadersDeSpringKafka()
      {
          var id = BrokerProbe.Id("b0000000");
          Deliver${sub.name}(id, BrokerProbe.Order);
          await Eventually(() => Task.FromResult(DeadLetterMessages("${sub.name}").Any(message => message.EventId == id)), TimeSpan.FromSeconds(20), "no llegó al descarte");
          var dead = DeadLetterMessages("${sub.name}").First(message => message.EventId == id);
          Assert.Equal(id, dead.RoutingKey);
          Assert.Equal(${cs(sub.topicDefault)}, dead.Properties.GetProperty("kafka_dlt-original-topic").GetString());
          Assert.Equal("rechazo de negocio de la sonda", dead.Properties.GetProperty("kafka_dlt-exception-message").GetString());
      }`
    : '';
  // Con Kafka el arranque tras levantar el broker suma el reparto del grupo: más margen.
  const recoverySeconds = kafka ? 90 : 30;
  fs.writeFileSync(
    path.join(flowsDir, 'BrokerProbeFlows.cs'),
    `namespace ${sln.integrationTests.name};

  using ${sln.integrationTests.name}.Support;
  using Xunit;

  internal static class BrokerProbe
  {
      public const string Order = ${cs(orderJson)};

      public static string Id(string prefix = "") => prefix.Length == 0 ? Guid.NewGuid().ToString() : prefix + Guid.NewGuid().ToString()[8..];

      /// <summary>Cuántas veces vio el listener sonda este eventId (lo anota el servidor, que es otro proceso).</summary>
      public static int Attempts(string eventId)
      {
          var file = Path.Combine(Harness.Root, "build", "broker-probe", "attempts.log");
          if (!File.Exists(file)) return 0;
          using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
          using var reader = new StreamReader(stream);
          return reader.ReadToEnd().Split('\\n').Count(line => line.Trim() == eventId);
      }

      public static long Count(string sql)
      {
          var last = Harness.Db(sql).Trim().Split('\\n').Last();
          return long.Parse(new string([.. last.Where(char.IsAsciiDigit)]), System.Globalization.CultureInfo.InvariantCulture);
      }

      public static long Processed(string eventId) => Count($"SELECT COUNT(*) FROM processed_event WHERE handler_id = 'ProbeListener' AND event_id = '{eventId}'");

      public static string Envelope(string eventId) => ${cs(envelopeTemplate)}.Replace("EVENT_ID", eventId, StringComparison.Ordinal);

      public static void OutboxRow(string id, string routingKey, string payload) =>
          Harness.Db($"INSERT INTO outbox_event (id, destination, routing_key, event_type, payload, created_at, attempts) VALUES ('{id}', '${destination}', '{routingKey}', '${event.name}', '{payload.Replace("'", "''", StringComparison.Ordinal)}', now(), 0)");
  }

  public sealed class BrokerConsumptionFlow : FlowTest
  {
      [Scenario("FL-BRK-001-A: una entrega llega al listener y se procesa una vez")]
      public async Task UnaEntregaSeProcesa()
      {
          var id = BrokerProbe.Id();
          Deliver${sub.name}(id, BrokerProbe.Order);
          await Eventually(() => Task.FromResult(BrokerProbe.Processed(id) == 1), TimeSpan.FromSeconds(20), "el listener no procesó el mensaje");
          Assert.Equal(1, BrokerProbe.Attempts(id));
      }

      [Scenario("FL-BRK-001-B: la reentrega del mismo messageId no se procesa dos veces ni va al descarte")]
      public async Task LaReentregaSeAbsorbe()
      {
          var id = BrokerProbe.Id();
          Deliver${sub.name}(id, BrokerProbe.Order);
          await Eventually(() => Task.FromResult(BrokerProbe.Processed(id) == 1), TimeSpan.FromSeconds(20));
          Deliver${sub.name}(id, BrokerProbe.Order);
          await Eventually(() => Task.FromResult(BrokerProbe.Attempts(id) == 2), TimeSpan.FromSeconds(20), "la reentrega no llegó");
          Assert.Equal(1, BrokerProbe.Processed(id));
          Assert.DoesNotContain(DeadLetterMessages("${sub.name}"), message => message.EventId == id);
      }

      [Scenario("FL-BRK-001-C: un fallo transitorio se reintenta ${attempts} veces y acaba en el descarte")]
      public async Task ElFalloTransitorioSeReintentaYSeDescarta()
      {
          var id = BrokerProbe.Id("7e000000");
          Deliver${sub.name}(id, BrokerProbe.Order);
          await Eventually(() => Task.FromResult(DeadLetterMessages("${sub.name}").Any(message => message.EventId == id)), TimeSpan.FromSeconds(60), "no llegó al descarte");
          Assert.Equal(${attempts}, BrokerProbe.Attempts(id));
      }

      [Scenario("FL-BRK-001-D: un rechazo de negocio va al descarte SIN reintento")]
      public async Task ElRechazoDeNegocioNoSeReintenta()
      {
          var id = BrokerProbe.Id("b0000000");
          Deliver${sub.name}(id, BrokerProbe.Order);
          await Eventually(() => Task.FromResult(DeadLetterMessages("${sub.name}").Any(message => message.EventId == id)), TimeSpan.FromSeconds(20), "no llegó al descarte");
          Assert.Equal(1, BrokerProbe.Attempts(id));
      }

      [Scenario("FL-BRK-001-E: un payload que incumple el contrato va al descarte sin reintento")]
      public async Task ElContratoIncumplidoSeDescarta()
      {
          var id = BrokerProbe.Id();
          Deliver${sub.name}(id, "{}");
          await Eventually(() => Task.FromResult(DeadLetterMessages("${sub.name}").Any(message => message.EventId == id)), TimeSpan.FromSeconds(20), "no llegó al descarte");
          Assert.Equal(1, BrokerProbe.Attempts(id));
          Assert.Equal(0, BrokerProbe.Processed(id));
      }

      [Scenario("FL-BRK-001-F: un evento ajeno del canal compartido se confirma sin efecto y sin descarte")]
      public async Task ElEventoAjenoSeIgnora()
      {
          var before = DeadLetterMessages("${sub.name}").Count;
          var id = BrokerProbe.Id();
          DeliverMessage(${cs(sub.topicDefault)}, id, ${cs(foreign)}.Replace("EVENT_ID", id, StringComparison.Ordinal));
          await Task.Delay(1500);
          Assert.Equal(0, BrokerProbe.Attempts(id));
          Assert.Equal(before, DeadLetterMessages("${sub.name}").Count);
      }

      [Scenario("FL-BRK-001-G: entregas DISTINTAS lanzadas a la vez llegan todas, cada una con su cuerpo")]
      public async Task LasEntregasALaVezNoSePisan()
      {
          // El escenario de carrera de una corrida (dos entregas a la vez): con un archivo de cuerpo compartido en devtools,
          // una entrega se llevaba el cuerpo de la otra.
          var ids = Enumerable.Range(0, 8).Select(_ => BrokerProbe.Id()).ToList();
          await Task.WhenAll(ids.Select(id => Task.Run(() => Deliver${sub.name}(id, BrokerProbe.Order), TestContext.Current.CancellationToken)));
          await Eventually(() => Task.FromResult(ids.All(id => BrokerProbe.Processed(id) == 1)), TimeSpan.FromSeconds(30), "alguna entrega no llegó con su cuerpo");
          Assert.All(ids, id => Assert.Equal(1, BrokerProbe.Attempts(id)));
      }${deadLetterShape}
  }

  public sealed class BrokerPublicationFlow : FlowTest
  {
      [Scenario("FL-BRK-002-A: una fila del outbox sale al canal con su envoltura y queda publicada")]
      public async Task LaFilaSale()
      {
          var id = BrokerProbe.Id();
          var eventId = BrokerProbe.Id();
          BrokerProbe.OutboxRow(id, ${cs(routingKey)}, BrokerProbe.Envelope(eventId));
          await Eventually(async () => (await PublishedMessages(${cs(channel)})).Any(message => message.EventId == eventId), TimeSpan.FromSeconds(20), "no se publicó");
          var message = (await PublishedMessages(${cs(channel)})).First(candidate => candidate.EventId == eventId);
          ${publishedShape}
          Assert.Equal(1, BrokerProbe.Count($"SELECT COUNT(*) FROM outbox_event WHERE id = '{id}' AND published_at IS NOT NULL"));
      }

  ${mandatoryCase}
      [Scenario("FL-BRK-002-C: con el broker caído la fila espera, y sale al volver sin rendirse")]
      public async Task ConElBrokerCaidoEspera()
      {
          await StopBroker();
          var eventId = BrokerProbe.Id();
          BrokerProbe.OutboxRow(BrokerProbe.Id(), ${cs(routingKey)}, BrokerProbe.Envelope(eventId));
          await Task.Delay(3000);
          Assert.Empty(await PublishedMessages(${cs(channel)}));
          await StartBroker();
          await Eventually(async () => (await PublishedMessages(${cs(channel)})).Any(message => message.EventId == eventId), TimeSpan.FromSeconds(${recoverySeconds}), "no salió tras levantar el broker");
          Assert.Equal(0, DeadLetteredEvents());
      }

      [Scenario("FL-BRK-002-D: un evento abandonado no se publica y se cuenta como rendido")]
      public async Task ElAbandonadoSeRinde()
      {
          await PurgeMessages(${cs(channel)});
          await StopBroker();
          var eventId = BrokerProbe.Id();
          BrokerProbe.OutboxRow(BrokerProbe.Id(), ${cs(routingKey)}, BrokerProbe.Envelope(eventId));
          AbandonOutboxEvent(${cs(event.name)});
          await StartBroker();
          await Task.Delay(3000);
          Assert.DoesNotContain(await PublishedMessages(${cs(channel)}), message => message.EventId == eventId);
          Assert.Equal(1, DeadLetteredEvents());
          ClearAbandonedOutboxEvents();
          Assert.Equal(0, DeadLetteredEvents());
      }

      [Scenario("FL-BRK-002-E: PurgeMessages vacía el canal")]
      public async Task LaPurgaVacia()
      {
          BrokerProbe.OutboxRow(BrokerProbe.Id(), ${cs(routingKey)}, BrokerProbe.Envelope(BrokerProbe.Id()));
          await Eventually(async () => (await PublishedMessages(${cs(channel)})).Count > 0, TimeSpan.FromSeconds(20));
          await PurgeMessages(${cs(channel)});
          Assert.Empty(await PublishedMessages(${cs(channel)}));
      }
  }
  `
  );

  const compiled = dotnet(projectDir, ['build', sln.file, '-c', 'Debug']);
  if (!step('el proyecto con las sondas y los flujos compila sin warnings', compiled.ok, compiled.ok ? '' : compiled.output.split('\n').filter((line) => /error|warning/.test(line)).slice(0, 30).join('\n'))) {
    return;
  }

  const CASES = { 'FL-BRK-001': kafka ? 'ABCDEFGH' : 'ABCDEFG', 'FL-BRK-002': kafka ? 'ACDE' : 'ABCDE' };
  const up = bash(projectDir, 'infra/up.sh');
  if (!step('bash infra/up.sh (PostgreSQL y el broker)', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) return;
  try {
    const validate = bash(projectDir, 'infra/validate-infra.sh');
    step('bash infra/validate-infra.sh (el broker incluido)', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

    // El documento de escenarios declara SOLO las sondas: un id que el documento no declara es AJENO, y su FALLO dejaría
    // el script en 2 (arnés roto), no en 1, así que el falsado no se podría leer. Su línea sale del sello.
    fs.writeFileSync(
      path.join(projectDir, 'specs', 'validation-scenarios.md'),
      '#### FL-BRK-001 — sonda del consumo\n\n#### FL-BRK-002 — sonda de la publicación por el outbox\n'
    );
    const seal = path.join(projectDir, 'specs.sha256');
    if (fs.existsSync(seal)) {
      fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md')).join('\n'));
    }
    const scored = bash(projectDir, 'infra/score-scenarios.sh');
    const lines = scored.output;
    for (const [flow, ids] of Object.entries(CASES)) {
      for (const id of ids) {
        const ok = new RegExp(`OK\\s+${flow}-${id}`).test(lines);
        step(`score: ${flow}-${id}`, ok, ok ? '' : (lines.match(new RegExp(`.*${flow}-${id}.*`))?.[0] ?? 'sin fila'));
      }
    }
    const measured = scored.status === 0 && /Humo del arnés: OK/.test(lines);
    step('score: el humo del arnés (con SMOKE-6, el broker y la conexión) en verde y el script con 0', measured, measured ? '' : lines.slice(-2500));

    // Falsado: con el rechazo de negocio tratado como reintentable, el caso que afirma «sin reintento» sale FALLO, y solo él.
    const topologyFile = path.join(messagingDir, dir, kafka ? 'KafkaConsumption.cs' : 'RabbitTopology.cs');
    const topology = fs.readFileSync(topologyFile, 'utf8');
    const weakened = topology.replace('return error is not DomainException and not MessageContractViolation;', 'return error is not MessageContractViolation;');
    if (step('falsado: el no-reintento del rechazo de negocio se puede quitar en lo emitido', weakened !== topology)) {
      fs.writeFileSync(topologyFile, weakened);
      const sabotaged = bash(projectDir, 'infra/score-scenarios.sh');
      const caught = sabotaged.status === 1 && /FALLO\s+FL-BRK-001-D/.test(sabotaged.output) && !/FALLO\s+FL-BRK-00[12]-[^D]/.test(sabotaged.output);
      step('falsado: con el rechazo reintentado, FL-BRK-001-D sale FALLO (y solo él) y el script con 1', caught, caught ? '' : `código ${sabotaged.status}\n${sabotaged.output.slice(-2000)}`);
      fs.writeFileSync(topologyFile, topology);
    }

    // Falsado: con el archivo de cuerpo COMPARTIDO entre llamadas (el arnés antes del arreglo), las entregas a la vez se
    // pisan el cuerpo y FL-BRK-001-G sale FALLO.
    const harnessFile = path.join(flowsDir, 'Support', 'Messaging.cs');
    const harness = fs.readFileSync(harnessFile, 'utf8');
    const shared = harness.replace('$"{BodyFilePrefix}-{Guid.NewGuid():N}.json"', '$"{BodyFilePrefix}.json"');
    if (step('falsado: el archivo de cuerpo por llamada se puede volver compartido en lo emitido', shared !== harness)) {
      fs.writeFileSync(harnessFile, shared);
      const sabotaged = bash(projectDir, 'infra/score-scenarios.sh');
      const caught = sabotaged.status === 1 && /FALLO\s+FL-BRK-001-G/.test(sabotaged.output);
      step('falsado: con el cuerpo compartido, FL-BRK-001-G sale FALLO y el script con 1', caught, caught ? '' : `código ${sabotaged.status}
  ${sabotaged.output.slice(-2000)}`);
      fs.writeFileSync(harnessFile, harness);
    }
  } finally {
    const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
    step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
    if (keep) {
      const kept = fs.mkdtempSync(path.join(os.tmpdir(), `keel-dotnet-broker-kept-${broker}-`));
      fs.cpSync(projectDir, kept, { recursive: true });
      console.log(`Proyecto conservado en ${kept}`);
    }
  }
}

for (const broker of BROKERS) await checkBroker(broker);

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nbroker-check: ${results.length}/${results.length} en verde.` : `\nbroker-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
