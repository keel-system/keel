// El conocimiento del generador dentro del proyecto (incremento 7c): la skill orquestadora, los cinco agentes, las
// convenciones y la skill de la base, proyectados a cada harness. Lo que se mide es lo que se rompe en silencio: un
// asset que existe y nadie instala, un token sin resolver que el agente lee literal, una doc compartida que cita la
// ruta de UN harness, y —lo que más cuesta— una ruta o una firma que la doc enseña y build no emite: el agente
// escribiría contra algo inventado.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES } from 'keel-core';
import { AGENTS, CONVENTIONS, GUIDES, DOCS_DIR } from '../src/scaffold/generator-docs.js';
import { solution } from '../src/scaffold/render.js';
import { SKILL } from '../src/lib/assets.js';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { DOTNET_READY_DESIGN, FIXTURES_DIR, planFixture } from './helpers/workspace.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const plan = await planFixture(DOTNET_READY_DESIGN.name);
const files = byPath(plan.files);
const sln = solution(plan.model);

/** Todos los markdown de assets/ (agentes, guías, convenciones, skills), recursivo. */
function assetSources(dir = assets) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? assetSources(full) : entry.name.endsWith('.md') ? [full] : [];
  });
}

test('todo agente y toda convención de assets/ se instala (las listas son el único punto de instalación)', () => {
  assert.deepEqual([...AGENTS].sort(), fs.readdirSync(path.join(assets, 'agents')).sort());
  assert.deepEqual([...CONVENTIONS].sort(), fs.readdirSync(path.join(assets, 'generators', 'dotnet', 'conventions')).sort());
  for (const name of [...GUIDES, ...CONVENTIONS.map((c) => `conventions/${c}`), 'framework-errors.md', 'wire-contract.md']) {
    assert.ok(`${DOCS_DIR}/${name}` in files, `${name} se emite en ${DOCS_DIR}/`);
  }
});

test('cada harness recibe su contexto, la skill orquestadora, los cinco agentes y la skill de la base', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.contextFile in files, `${harness.id}: ${harness.contextFile}`);
    assert.ok(harness.skillPath(SKILL, 'SKILL.md') in files, `${harness.id}: skill orquestadora`);
    assert.ok(harness.skillPath('keel-dotnet-database', 'SKILL.md') in files, `${harness.id}: skill de la base`);
    assert.ok(harness.skillPath('keel-dotnet-database', 'references/migrations.md') in files, `${harness.id}: sus referencias`);
    for (const agent of AGENTS) {
      const name = agent.replace(/\.md$/, '');
      assert.ok(Object.keys(files).some((file) => file.includes(name) && !file.startsWith(DOCS_DIR)), `${harness.id}: agente ${name}`);
    }
  }
});

test('ningún archivo emitido deja un token {{keel:…}} sin resolver', () => {
  const leftovers = Object.entries(files).filter(([, content]) => /\{\{keel:\w+\}\}/.test(content)).map(([file]) => file);
  assert.deepEqual(leftovers, []);
});

test('las docs compartidas y los assets no citan la ruta ni el archivo de contexto de un harness concreto', () => {
  const harnessPaths = /\.claude\/|\.opencode\/|CLAUDE\.md|AGENTS\.md/;
  for (const [file, content] of Object.entries(files)) {
    if (file.startsWith(`${DOCS_DIR}/`)) assert.doesNotMatch(content, harnessPaths, file);
  }
  for (const source of assetSources()) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\.claude\/|\.opencode\//, path.relative(assets, source));
});

test('los agentes son hojas: ninguno puede lanzar subagentes', () => {
  for (const agent of AGENTS) {
    assert.match(fs.readFileSync(path.join(assets, 'agents', agent), 'utf8'), /^spawns: false$/m, agent);
  }
});

test('la skill de la base y el baseline solo se instalan con persistencia relacional', async () => {
  const bare = byPath(
    (
      await planFixture(DOTNET_READY_DESIGN.name, {
        mutate: (manifest, layers) => {
          delete manifest.layers.persistence;
          delete layers.persistence;
        }
      })
    ).files
  );
  assert.ok(!Object.keys(bare).some((file) => file.includes('keel-dotnet-database')));
  assert.equal('infra/verify-baseline.sh' in bare, false);
  const skill = bare[HARNESSES[0].skillPath(SKILL, 'SKILL.md')];
  assert.doesNotMatch(skill, /baseline/i);
});

// Una ruta que la documentación cita y build no emite manda al agente a buscar algo que no existe. Se comprueban
// todas las de los assets contra lo que build emite para el diseño de referencia: las que llevan un marcador
// (`<Flujo>Flow.cs`) son plantillas y no se miran; `<Raíz>` se sustituye por la raíz del servicio.
test('cada ruta src/, tests/ e infra/ que citan los assets existe en lo que emite build', () => {
  // Lo de infra/ no lleva el nombre del servicio: vale también lo que emiten los diseños con seguridad (el realm de
  // prueba, sus credenciales y el emulador de Cognito), que las guías comunes citan para cuando el diseño lo pide.
  const securityInfra = Object.values(SKILL_SUBJECTS).flatMap(({ fixtures, stack }) =>
    fixtures.flatMap((fixture) => planWith(fixture, stack).files.map((file) => file.path).filter((route) => route.startsWith('infra/')))
  );
  const emitted = [...Object.keys(files), ...securityInfra];
  // Lo que crea otro después: las migraciones (el pase de calidad), la salida de compilación y las pruebas de flujo
  // (el agente de pruebas; `<Flujo>Flow.cs` en los ejemplos).
  const createdLater = [`${sln.infrastructure.dir}/Persistence/Migrations`, `${sln.integrationTests.dir}/bin/`];
  const agentFlow = new RegExp(`^${sln.integrationTests.dir}/\\w+Flow\\.cs$`);
  const missing = [];
  for (const source of assetSources()) {
    // Las skills de un proveedor de identidad citan lo que build emite CON seguridad: se miden contra su diseño.
    const target = Object.entries(SKILL_SUBJECTS).find(([skill]) => source.includes(`${path.sep}${skill}${path.sep}`))?.[1];
    if (target) continue;
    missing.push(...missingRoutes(source, sln, emitted, createdLater, agentFlow));
  }
  for (const [skill, subject] of Object.entries(SKILL_SUBJECTS)) {
    // La skill vale para cualquier diseño con ese proveedor: una ruta cuenta si la emite alguno de sus sujetos.
    const plans = subject.fixtures.map((fixture) => planWith(fixture, subject.stack));
    for (const source of assetSources(path.join(assets, 'generators', 'dotnet', 'skills', skill))) {
      const perSubject = plans.map(({ model, files: subjectFiles }) => missingRoutes(source, solution(model), subjectFiles.map((file) => file.path), [], agentFlow));
      // Lo que falta en TODOS (por la ruta citada, que no depende del nombre del servicio salvo por <Raíz>).
      const routeOf = (entry) => entry.split(' → ')[1].replace(/^(src|tests)\/[A-Za-z]+\./, '$1/<Raíz>.');
      const everywhere = perSubject[0].filter((entry) => perSubject.every((list) => list.some((other) => routeOf(other) === routeOf(entry))));
      missing.push(...everywhere);
    }
  }
  assert.deepEqual(missing, []);
});

/** Las skills que solo se instalan con un stack, y el diseño y el stack contra los que se miden sus rutas. */
const SKILL_SUBJECTS = {
  'keel-dotnet-keycloak': { fixtures: ['profile-directory', 'asset-vault'], stack: { auth: 'keycloak' } },
  'keel-dotnet-cognito': { fixtures: ['profile-directory', 'asset-vault'], stack: { auth: 'cognito' } },
  // Con outbox y best-effort: la skill cita las piezas de los dos.
  'keel-dotnet-rabbitmq': { fixtures: ['stock-reservation-events', 'metering-digest'], stack: { broker: 'rabbitmq', database: 'postgresql' } },
  'keel-dotnet-kafka': { fixtures: ['stock-reservation-events', 'metering-digest'], stack: { broker: 'kafka', database: 'postgresql' } },
  'keel-dotnet-snssqs': { fixtures: ['stock-reservation-events', 'metering-digest'], stack: { broker: 'snssqs', database: 'postgresql' } },
  // Con barrido de reconciliación y compensación.
  'keel-dotnet-httpclient': { fixtures: ['stock-reservation'], stack: { broker: 'rabbitmq', database: 'postgresql' } },
  // El correo, sobre las dos persistencias: la guarda vive en un adaptador u otro.
  'keel-dotnet-mail': { fixtures: ['notification-mailer', 'notification-mailer-mongo'], stack: { broker: 'rabbitmq' } }
};

function planWith(fixture, stack) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
}

/** Las rutas src/, tests/ e infra/ que cita un asset y no están en lo emitido. */
function missingRoutes(source, solutionOf, emitted, createdLater, agentFlow) {
  const missing = [];
  const text = fs.readFileSync(source, 'utf8').replaceAll('<Raíz>', solutionOf.root);
  for (const [cited] of text.matchAll(/\b(?:src|tests|infra)\/[\w./-]+/g)) {
    const route = cited.replace(/[.,:;]+$/, '');
    if (route.includes('<') || createdLater.some((later) => route.startsWith(later)) || agentFlow.test(route)) continue;
    const exists = emitted.includes(route) || emitted.some((file) => file.startsWith(route.endsWith('/') ? route : `${route}/`));
    if (!exists) missing.push(`${path.relative(assets, source)} → ${route}`);
  }
  return missing;
}

// Los símbolos y firmas que la documentación ENSEÑA a usar, contra el código emitido.
test('los tipos y miembros que enseñan las convenciones son los del código emitido', () => {
  const find = (suffix) => Object.entries(files).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.match(find('Domain/Support/Decimals.cs'), /public static decimal SetScale\(decimal value, int scale, MidpointRounding rounding = MidpointRounding\.AwayFromZero\)/);
  assert.match(find('Domain/Repository/Page.cs'), /record Page<T>\(IReadOnlyList<T> Items, int Number, int Size, long TotalElements, int TotalPages\)/);
  assert.match(find('Application/Dtos/PagedResponse.cs'), /required IReadOnlyList<T> Items[\s\S]*required int Page[\s\S]*required int Size[\s\S]*required long TotalElements[\s\S]*required int TotalPages/);
  assert.match(find('Domain/Aggregate/Product.cs'), /private void TransitionTo\(ProductStatus target\)/);
  assert.match(find('Domain/Aggregate/Product.cs'), /public sealed class ProductState/);
  assert.match(find('Domain/ValueObject/SKUFormat.cs'), /public static void Validate\(string\? value\)/);
  assert.match(find('Domain/Errors/ProductAlreadyRetiredError.cs'), /ProductAlreadyRetiredError\(string message\)/);
  assert.match(find('Infrastructure/Config/ServiceConfiguration.cs'), /public string\? Get\(string/);
  assert.match(find('Persistence/Repositories/ProductRepository.cs'), /ProductRepository\(ProductCatalogDbContext db,/);
  assert.match(find('Persistence/Repositories/ProductRepository.cs'), /private IQueryable<ProductRow> Graph\(\)/);
  for (const symbol of ['UseCaseRegistration', 'IUseCaseTransactions', 'PersistenceErrors', 'ApiErrorMiddleware', 'ApiRoutes', 'WireJson', 'RowValues']) {
    assert.ok(Object.keys(files).some((file) => file.endsWith(`/${symbol}.cs`)), `${symbol}.cs`);
  }
  // El arnés: lo que integration-tests.md y el agente de pruebas enseñan.
  const flowTest = files[`${sln.integrationTests.dir}/Support/FlowTest.cs`];
  for (const member of ['protected virtual Task GivenAsync()', 'public const string RouteBase', 'protected static void AssertJson(string expected, FlowResponse response)', 'protected static string Db(string sql)', 'protected static void ResetState()', 'protected static Task Eventually(', 'protected static string BaseUrl']) {
    assert.ok(flowTest.includes(member), member);
  }
  for (const verb of ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Exchange']) assert.match(flowTest, new RegExp(`protected static Task<FlowResponse> ${verb}\\(`));
  const response = files[`${sln.integrationTests.dir}/Support/FlowResponse.cs`];
  for (const member of ['public int Status', 'public string Body', 'public string? Header(string name)', 'public JsonElement Json()']) assert.ok(response.includes(member), member);
  assert.match(files[`${sln.integrationTests.dir}/Support/ScenarioOrder.cs`], /public ScenarioAttribute\(string title,/);
  for (const shape of ['"<uuid>"', '"<instant>"', '"<any>"']) assert.ok(files[`${sln.integrationTests.dir}/Support/JsonShape.cs`].includes(shape), shape);
});

test('el Optional de un PATCH tiene el miembro que enseña mapping.md', async () => {
  // Ninguna operación de product-catalog es un PATCH: la de catalog-extended sí.
  const extended = byPath((await planFixture('catalog-extended')).files);
  const optional = Object.entries(extended).find(([file]) => file.endsWith('/Optional.cs'))?.[1] ?? '';
  assert.match(optional, /public bool IsPresent \{ get; \}/);
  assert.match(optional, /public T Value =>/);
  assert.match(fs.readFileSync(path.join(assets, 'generators', 'dotnet', 'conventions', 'mapping.md'), 'utf8'), /`IsPresent`/);
});

test('la skill orquestadora enseña los comandos de esta plataforma, no los de otra', () => {
  for (const harness of HARNESSES) {
    const skill = files[harness.skillPath(SKILL, 'SKILL.md')];
    assert.match(skill, /bash infra\/score-scenarios\.sh/);
    assert.match(skill, /bash infra\/check-flows\.sh/);
    assert.match(skill, /dotnet ef migrations add Baseline --project src\/ProductCatalog\.Infrastructure --output-dir Persistence\/Migrations/);
    assert.match(skill, new RegExp(`-class "${sln.integrationTests.name}\\.HarnessSmoke"`));
    assert.doesNotMatch(skill, /npm |gradlew|vitest|check:architecture/i);
  }
});

test('la skill de RabbitMQ se instala con el broker y enseña las firmas del código emitido', () => {
  const outbox = byPath(planWith('stock-reservation-events', { broker: 'rabbitmq', database: 'postgresql' }).files);
  const bestEffort = byPath(planWith('metering-digest', { broker: 'rabbitmq', database: 'postgresql' }).files);
  const find = (tree, suffix) => Object.entries(tree).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.ok(Object.keys(outbox).some((file) => file.endsWith('skills/keel-dotnet-rabbitmq/SKILL.md')), 'se instala con rabbitmq');
  assert.ok(!Object.keys(files).some((file) => file.includes('keel-dotnet-rabbitmq')), 'y no sin mensajería');
  const connection = find(outbox, '/RabbitMq/RabbitConnection.cs');
  assert.ok(connection.includes('public async Task Publish(string exchange, string routingKey, string payload, string type, IReadOnlyDictionary<string, string>? headers = null, CancellationToken cancellationToken = default)'));
  assert.ok(connection.includes('public void Consume(string queue, Func<RabbitMessage, CancellationToken, Task> handler)'));
  assert.ok(connection.includes('public string? Header(string name)'));
  assert.ok(find(outbox, '/Outbox/IOutboxDispatcher.cs').includes('Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default);'));
  assert.ok(find(outbox, '/Messaging/InboundContext.cs').includes('public static async Task Run(EventMetadata metadata, Func<Task> action)'));
  const guard = find(outbox, '/Idempotency/IdempotencyGuard.cs');
  for (const member of ['AlreadyProcessed(string handlerId, string eventId', 'Record(string handlerId, string eventId', 'TryRecord(string handlerId, string eventId']) assert.ok(guard.includes(member), member);
  assert.ok(find(outbox, '/Messaging/BrokerBindings.cs').includes('public static void AddBrokerAdapters(IServiceCollection services)'));
  assert.ok(find(outbox, '/Messaging/MessagingSettings.cs').includes('IReadOnlyDictionary<string, SubscriptionSettings> Subscriptions'));
  assert.ok(find(bestEffort, '/Messaging/IDailyDigestClosedPublisher.cs').includes('Task Publish(DailyDigestClosedIntegrationEvent integrationEvent, string? correlationId, CancellationToken cancellationToken = default);'));
  assert.ok(find(outbox, '/Commands/ApplyStockReservedCommand.cs').includes('public required Guid OrderId { get; init; }'));
});

test('la skill de Kafka se instala con el broker y enseña las firmas del código emitido', () => {
  const tree = byPath(planWith('stock-reservation-events', { broker: 'kafka', database: 'postgresql' }).files);
  const find = (suffix) => Object.entries(tree).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.ok(Object.keys(tree).some((file) => file.endsWith('skills/keel-dotnet-kafka/SKILL.md')), 'se instala con kafka');
  assert.ok(!Object.keys(tree).some((file) => file.includes('keel-dotnet-rabbitmq')), 'y no la de RabbitMQ');
  const connection = find('/Kafka/KafkaConnection.cs');
  assert.ok(connection.includes('public Task Publish(string topic, string? key, string payload, IReadOnlyDictionary<string, string>? headers = null, CancellationToken cancellationToken = default)'));
  assert.ok(connection.includes('public void Consume(string subscription, Func<KafkaMessage, CancellationToken, Task> handler)'));
  assert.ok(connection.includes('public sealed record KafkaMessage(string Topic, int Partition, long Offset, string? Key, string Value,'));
  assert.ok(find('/Messaging/MessagingSettings.cs').includes('SubscriptionSettings(string Topic, string? Queue, string? GroupId)'));
});

test('la skill de SNS/SQS se instala con el broker y enseña las firmas del código emitido', () => {
  const tree = byPath(planWith('stock-reservation-events', { broker: 'snssqs', database: 'postgresql' }).files);
  const find = (suffix) => Object.entries(tree).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.ok(Object.keys(tree).some((file) => file.endsWith('skills/keel-dotnet-snssqs/SKILL.md')), 'se instala con snssqs');
  assert.ok(!Object.keys(tree).some((file) => file.includes('keel-dotnet-rabbitmq') || file.includes('keel-dotnet-kafka')), 'y no las de los otros brokers');
  const connection = find('/SnsSqs/SnsSqsConnection.cs');
  assert.ok(connection.includes('public async Task Publish(string topic, string payload, IReadOnlyDictionary<string, string> attributes, CancellationToken cancellationToken = default)'));
  assert.ok(connection.includes('public void Consume(string subscription, Func<SqsMessage, CancellationToken, Task> handler)'));
  assert.ok(connection.includes('public sealed record SqsMessage(string MessageId, string Body, IReadOnlyDictionary<string, string> Attributes, int ReceiveCount)'));
  assert.ok(connection.includes('public string? Attribute(string name)'));
  assert.ok(find('/Messaging/MessagingSettings.cs').includes('SubscriptionSettings(string Topic, string? Queue, string? GroupId)'));
  assert.ok(tree['infra/init-messaging.sh'], 'la topología la siembra init-messaging.sh');
});

test('la skill de clientes salientes se instala con la capa y enseña las firmas del código emitido', () => {
  const tree = byPath(planWith('stock-reservation', { broker: 'rabbitmq', database: 'postgresql' }).files);
  const find = (suffix) => Object.entries(tree).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.ok(Object.keys(tree).some((file) => file.endsWith('skills/keel-dotnet-httpclient/SKILL.md')), 'se instala con http-clients');
  assert.ok(!Object.keys(files).some((file) => file.includes('keel-dotnet-httpclient')), 'y no sin clientes');
  const adapter = find('/Clients/InventoryHttpAdapter.cs');
  for (const line of [
    'public async Task<CancelStockResult> CancelStock(Guid orderId, CancellationToken cancellationToken = default)',
    'return await OutboundResilience.Run(CancelStockPolicy, cancelStockCircuit, () => CancelStockOnce(orderId, cancellationToken), cancellationToken);',
    'catch (ProviderFailureException failure) when (CancelStockFallback.Contains(failure.Kind))',
    'private async Task<CancelStockResult> CancelStockOnce(Guid orderId, CancellationToken cancellationToken)',
    'var response = await http.Send(client, new OutboundRequest("DELETE", "/stock/reservations/{orderId}")'
  ]) {
    assert.ok(adapter.includes(line), line);
  }
  const failures = find('/Clients/ProviderFailures.cs');
  for (const member of ['public sealed class ProviderTransportException', 'public sealed class ProviderStatusException', 'public sealed class CallNotPermittedException', 'public int? Status', 'public string Body']) assert.ok(failures.includes(member), member);
  const reading = find('/Clients/ResponseReading.cs');
  for (const member of ['public static T Required<T>(', 'public static T Optional<T>(', 'public static IReadOnlyList<T> List<T>(']) assert.ok(reading.includes(member), member);
  assert.ok(find('/Clients/HttpExchange.cs').includes('public static SocketsHttpHandler DefaultHandler()'));
  assert.ok(find('/Clients/OutboundIdempotency.cs').includes('public static string FromPayload(string call, object? payload)'));
  assert.ok(find('/Clients/HttpClientsRegistration.cs').includes('public static IServiceCollection AddOutboundClients(this IServiceCollection services, HttpClientsSettings settings)'));
  assert.ok(find('/Repository/IReservationRepository.cs').includes('Task<IReadOnlyList<Reservation>> ClaimForReconcileReservationsReserveStock(CancellationToken cancellationToken = default);'));
  assert.ok(find('/Errors/ConflictException.cs').includes('class ConflictException'));
  const stub = find('/Support/HttpStub.cs');
  for (const member of [
    'protected static Task StubFor(string method, string pathPattern, int status, object? body = null)',
    'protected static Task StubFailure(string method, string pathPattern, int status)',
    'protected static Task StubConnectionFault(string method, string pathPattern)',
    'protected static Task StubTimeout(string method, string pathPattern, int delayMs)',
    'protected static Task StubSequence(string method, string pathPattern, params JsonObject[] responses)',
    'protected static Task<int> StubCallCount(string method, string pathPattern)',
    'protected static Task<IReadOnlyList<StubRequest>> StubRequests(string method, string pathPattern)',
    'protected static JsonElement? StubRequestBody(StubRequest request)',
    'protected static string? StubRequestHeader(StubRequest request, string name)',
    'public static JsonObject ConnectionFault()',
    'public static JsonObject Ok(int status, object? body = null)'
  ]) {
    assert.ok(stub.includes(member), member);
  }
  const flowTest = find('/Support/FlowTest.cs');
  assert.ok(flowTest.includes('protected static void AgeForReconciliation(string activation, string id)'));
  assert.ok(flowTest.includes('protected static void HoldFromReconciliation(string activation, string id)'));
  assert.ok(flowTest.includes('HttpStubHarness.ForgetSequences();'));
  assert.match(find('HarnessSmoke.cs'), /SMOKE-6: el proveedor de prueba se deja programar/);
});

// La persistencia DOCUMENTAL (incremento 12d): su skill en lugar de la relacional, y lo que enseña existe en lo emitido.
test('sobre MongoDB se instala keel-dotnet-mongodb y no keel-dotnet-database; la orquestadora pide verificar los índices vivos', async () => {
  const mongo = byPath((await planFixture('job-dispatch-mongo')).files);
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-dotnet-mongodb', 'SKILL.md') in mongo, `${harness.id}: skill documental`);
    for (const reference of ['repository-adapters.md', 'harness.md', 'indexes.md', 'troubleshooting.md']) {
      assert.ok(harness.skillPath('keel-dotnet-mongodb', `references/${reference}`) in mongo, `${harness.id}: ${reference}`);
    }
  }
  assert.ok(!Object.keys(mongo).some((file) => file.includes('keel-dotnet-database')));
  assert.equal('infra/verify-baseline.sh' in mongo, false);
  assert.ok('infra/export-indexes.sh' in mongo);
  const skill = mongo[HARNESSES[0].skillPath(SKILL, 'SKILL.md')];
  assert.match(skill, /índices vivos/);
  assert.match(skill, /indexesTested: OK/);
});

test('lo que enseña keel-dotnet-mongodb existe en lo emitido: rutas, valores de BsonValues y ayudantes del arnés', async () => {
  const sources = fs
    .readdirSync(path.join(assets, 'generators', 'dotnet', 'skills', 'keel-dotnet-mongodb', 'references'))
    .map((name) => fs.readFileSync(path.join(assets, 'generators', 'dotnet', 'skills', 'keel-dotnet-mongodb', 'references', name), 'utf8'))
    .concat(fs.readFileSync(path.join(assets, 'generators', 'dotnet', 'skills', 'keel-dotnet-mongodb', 'SKILL.md'), 'utf8'))
    .join('\n');
  // Las fixtures que, juntas, tienen todo lo que la skill nombra: rescate, reconciliación y outbox.
  const emitted = [];
  for (const name of ['job-dispatch-mongo', 'inspection-reports', 'asset-vault']) emitted.push(...(await planFixture(name)).files);
  const all = emitted.map((file) => `${file.path}\n${file.content}`).join('\n');
  for (const file of ['BsonValues.cs', 'PersistenceTransactions.cs', 'DocumentIndexes.cs', 'PersistenceErrors.cs', 'FlowTest.cs']) {
    if (sources.includes(file)) assert.ok(emitted.some((candidate) => candidate.path.endsWith(`/${file}`)), `la skill cita ${file}`);
  }
  for (const member of ['BsonValues.Of(', 'BsonValues.Day(', 'BsonValues.Enum(', 'DocumentIndexes.ByCollection', 'EnumColumns.']) {
    if (sources.includes(member)) assert.ok(all.includes(member.replace('BsonValues.', 'public static BsonValue ').replace('(', '')) || all.includes(member), `la skill enseña ${member}`);
  }
  for (const helper of ['MongoEval', 'StallInFlight', 'PutInFlight', 'InFlightWithoutClock', 'AgeForReconciliation', 'HoldFromReconciliation', 'DeadLetteredEvents', 'AbandonOutboxEvent', 'ClearAbandonedOutboxEvents', 'ResetState', 'Eventually']) {
    assert.ok(sources.includes(helper), `la skill nombra ${helper}`);
    assert.match(all, new RegExp(`protected static [^\\n]*\\b${helper}\\(`), `el arnés emite ${helper}`);
  }
});
