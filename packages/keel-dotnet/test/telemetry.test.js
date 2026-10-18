// La telemetría de keel-dotnet (incremento 14c), sobre el texto emitido:
//
//   · telemetry.yaml es el de keel-nest en los cuatro perfiles salvo la cabecera (keel-core/gen/telemetry-config.js), y
//     TelemetrySettings solo lee claves que ese YAML declara;
//   · los nombres de las observaciones y de los atributos son los del vocabulario neutral, el de keel-spring y keel-nest;
//   · cada punto de paso está cableado: Program.cs (arranque antes de la aplicación, el middleware el primero, el scrape y
//     el vaciado), el mediator, la envoltura, el relay, el consumo, el cliente saliente, la caché, storage y correo;
//   · sin telemetría no se emite nada de ella, ni un paquete.
// Lo que EJECUTA el C# (los spans, el scrape con sus exemplars, la propagación, los logs) lo mide la prueba emitida
// TelemetryTests en `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { ATTRIBUTES, OBSERVATIONS, instrumentationFor } from 'keel-core/gen/telemetry-vocabulary';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const TELEMETRY_PACKAGES = ['OpenTelemetry', 'OpenTelemetry.Exporter.OpenTelemetryProtocol', 'OpenTelemetry.Extensions.Propagators', 'prometheus-net'];
const stackOf = (telemetry, database = 'postgresql', broker = 'rabbitmq') => ({ database, broker, telemetry });
const plan = (name, { telemetry = 'otel', database, broker, planner = planService } = {}) =>
  planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack: stackOf(telemetry, database, broker) });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const withoutHeader = (yaml) => yaml.replace(/^# Generado por keel-[a-z]+ build\./, '');

function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}:`) : [`${prefix}${key}`]));
}

test('telemetry.yaml es el de keel-nest en los cuatro perfiles, salvo la cabecera, con los interruptores del diseño', () => {
  for (const [name, database] of [['product-catalog'], ['asset-vault', 'mongodb'], ['notification-mailer']]) {
    const own = plan(name, { database }).files;
    const nest = plan(name, { database, planner: planNest }).files;
    for (const profile of PROFILES) {
      const yaml = content(own, `config/parameters/${profile}/telemetry.yaml`);
      assert.match(yaml, /^# Generado por keel-dotnet build\./, `${name} ${profile}`);
      assert.equal(withoutHeader(yaml), withoutHeader(content(nest, `config/parameters/${profile}/telemetry.yaml`)), `${name} ${profile}`);
    }
  }
});

test('TelemetrySettings solo lee claves que declara telemetry.yaml, y cada interruptor del diseño tiene la suya', () => {
  const { files, model } = plan('asset-vault', { database: 'mongodb' });
  const declared = new Set(['application:name']);
  for (const profile of PROFILES) for (const key of flatKeys(parseYaml(content(files, `config/parameters/${profile}/telemetry.yaml`)))) declared.add(key);
  const settings = content(files, 'Telemetry/TelemetrySettings.cs');
  const read = [...settings.matchAll(/(?:Text|Flag)\(configuration, "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(read.length >= 9, read.join(', '));
  for (const key of read) assert.ok(declared.has(key), `TelemetrySettings lee ${key}, que telemetry.yaml no declara`);
  const switches = instrumentationFor(model);
  assert.ok(switches.length >= 2);
  for (const entry of switches) {
    const key = entry.property.replaceAll('.', ':');
    assert.ok(declared.has(key), key);
    assert.match(settings, new RegExp(`\\["${entry.id}"\\] = "${key}"`));
  }
});

test('las observaciones y los atributos son los del vocabulario neutral', () => {
  const names = content(plan('product-catalog').files, 'Telemetry/TelemetryNames.cs');
  for (const value of [...Object.values(OBSERVATIONS), ...Object.values(ATTRIBUTES)]) assert.ok(names.includes(`= "${value}";`), value);
});

test('Program.cs arranca la telemetría antes de la aplicación, pone su middleware el primero y sirve el scrape', () => {
  const program = content(plan('product-catalog').files, 'Program.cs');
  const at = (text) => {
    const index = program.indexOf(text);
    assert.ok(index >= 0, text);
    return index;
  };
  assert.ok(at('KeelTelemetry.Start(TelemetrySettings.From(configuration))') < at('WebApplication.CreateBuilder(args)'));
  assert.ok(at('builder.Logging.AddServiceLogging(') < at('builder.Logging.AddTelemetryLogs(telemetry);'));
  assert.ok(at('app.UseMiddleware<HttpTelemetryMiddleware>();') < at('app.UseMiddleware<CorrelationMiddleware>();'));
  at('app.MapTelemetryEndpoints(telemetry);');
  at('app.Lifetime.ApplicationStopped.Register(telemetry.Flush);');
  // En production, también el puerto de gestión.
  assert.match(program, /telemetry\.Settings\.ManagementPort is \{ \} management/);
});

test('cada punto de paso está cableado: mediator, envoltura, relay, consumo, cliente saliente y caché', () => {
  const { files } = plan('catalog-extended', { broker: 'kafka' });
  assert.match(content(files, 'UseCase/UseCaseMediator.cs'), /telemetry\.Observe\(Observations\.UseCase, observing, \(\) => Logged\(operation, work\)\)/);
  assert.match(content(files, 'UseCase/UseCaseMediator.cs'), /IsRejection = error => error is DomainException/);
  assert.match(content(files, 'Messaging/EventEnvelope.cs'), /metadata\.WithContext\(correlationId, KeelTelemetry\.CurrentTraceparent\(\)\)/);
  assert.match(content(files, 'Outbox/OutboxRelay.cs'), /telemetry\.Publishing\(eventType, TraceparentOf\(payload\), dispatch\)/);
  assert.match(content(files, 'Outbox/OutboxRelay.cs'), /RegisterGauge\(Observations\.OutboxDeadLettered/);
  assert.match(content(files, 'Messaging/InboundContext.cs'), /telemetry\.Consuming\(metadata\.EventType, metadata\.Traceparent, action\)/);
  const exchange = content(files, 'Clients/HttpExchange.cs');
  assert.match(exchange, /telemetry\?\.StartClient\(client\.Id, request\.Method, request\.Path, message\.Headers\)/);
  assert.match(exchange, /finally\s*\{\s*telemetry\?\.FinishClient\(span, started, client\.Id, request\.Method, request\.Path, observed\);/);
  assert.match(exchange, /ActivityHeadersPropagator = null,/);
  assert.match(content(files, 'Cache/RedisOperationCache.cs'), /KeelTelemetry\.Current\?\.CacheGet\(cache\.Name, hit\);/);
});

test('storage y correo van observados sobre el PUERTO, con su interruptor', () => {
  const vault = plan('asset-vault', { database: 'mongodb' }).files;
  assert.match(content(vault, 'Storage/ObservedFileStorage.cs'), /public sealed class ObservedFileStorage\(IFileStorage inner, KeelTelemetry telemetry\) : IFileStorage/);
  assert.match(content(vault, 'Storage/StorageRegistration.cs'), /Instrumented\("storage"\)\s*\? new ObservedFileStorage\(provider\.GetRequiredService<S3FileStorage>\(\), telemetry\)/);
  const mailer = plan('notification-mailer').files;
  assert.match(content(mailer, 'Mail/ObservedMailSender.cs'), /telemetry\.Observe\(Observations\.MailSend, Sending, \(\) => inner\.Send\(message, cancellationToken\)\)/);
  assert.match(content(mailer, 'Mail/MailRegistration.cs'), /services\.AddSingleton<SmtpMailSender>\(\);\s*services\.AddSingleton<IMailSender>\(provider => KeelTelemetry\.Current is \{ \} telemetry && telemetry\.Settings\.Instrumented\("mail"\)/);
});

test('sin telemetría no se emite nada de ella, ni un paquete', () => {
  for (const [name, database] of [['catalog-extended'], ['asset-vault', 'mongodb'], ['notification-mailer']]) {
    const { files } = plan(name, { telemetry: 'none', database });
    const leaks = files.filter((file) => /KeelTelemetry|OpenTelemetry|Prometheus|TelemetryTests/.test(file.content) || file.path.includes('/Telemetry/'));
    assert.deepEqual(leaks.map((file) => file.path), [], name);
    const props = content(files, 'Directory.Packages.props');
    for (const id of TELEMETRY_PACKAGES) assert.ok(!props.includes(`"${id}"`), `${name}: ${id}`);
  }
  const props = content(plan('product-catalog').files, 'Directory.Packages.props');
  for (const id of TELEMETRY_PACKAGES) assert.ok(props.includes(`"${id}"`), id);
});

test('la convención de observabilidad se instala solo con telemetría, y lo que cita existe en lo emitido', () => {
  const { files } = plan('catalog-extended', { broker: 'kafka' });
  const convention = files.find((file) => file.path.endsWith('conventions/observability.md'))?.content;
  assert.ok(convention);
  const cited = [...convention.matchAll(/`(Infrastructure\/[A-Za-z/]+(?:\.cs)?)`/g)].map((match) => match[1]);
  assert.ok(cited.length >= 6, cited.join(', '));
  for (const reference of cited) {
    const suffix = reference.replace(/^Infrastructure\//, '');
    assert.ok(files.some((file) => /\.Infrastructure\//.test(file.path) && file.path.split('.Infrastructure/')[1].startsWith(suffix)), `${reference} no se emite`);
  }
  assert.ok(!plan('catalog-extended', { broker: 'kafka', telemetry: 'none' }).files.some((file) => file.path.endsWith('conventions/observability.md')));
});

test('el proveedor solo escucha el origen keel: los spans de los drivers no salen (celda degradada de la matriz)', () => {
  const telemetry = content(plan('catalog-extended', { broker: 'kafka' }).files, 'Telemetry/KeelTelemetry.cs');
  assert.deepEqual([...telemetry.matchAll(/\.AddSource\(([^)]*)\)/g)].map((match) => match[1]), ['SourceName']);
  assert.match(telemetry, /public const string SourceName = "keel";/);
  // Ni la instrumentación automática de ASP.NET Core o de HttpClient. Del Meter de Npgsql solo se lee el pool (14d): sus spans no.
  assert.doesNotMatch(telemetry, /AddAspNetCoreInstrumentation|AddHttpClientInstrumentation|AddNpgsql|ActivitySource\("Npgsql"\)/);
});
