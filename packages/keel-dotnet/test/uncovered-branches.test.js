// Las ramas del DSL que ninguna fixture declara y keel-dotnet genera: las que `capability-coverage.test.js` anota como
// `soloCadenas`. Sin fixture, cs-check no las compila nunca, así que aquí se derivan de una fixture real parcheando el
// diseño en memoria —como keel-spring en dependencies.test.js y keel-nest en su uncovered-branches.test.js— y se exige la
// rama en lo emitido. La compilación y las pruebas emitidas de cada una las pone su variante DERIVED de cs-check, con el
// MISMO parche (`UNCOVERED_BRANCHES`): las dos redes no pueden mirar diseños distintos.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkCrossRefs, loadService } from '@keel-system/keel-core';
import { FIXTURES_DIR, planFixture, UNCOVERED_BRANCHES } from './helpers/workspace.js';

const branch = (name) => UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);

async function emitted(name) {
  const { from, mutate } = branch(name);
  const { files } = await planFixture(from, { mutate: (manifest, layers) => mutate(manifest, layers, from) });
  return files;
}

test('catalog-extended: réplica con onMiss fail — el lector lanza el error declarado (replica.onMiss.error)', async () => {
  const files = await emitted('catalog-extended-replica-fail');
  const reader = files.find((file) => /Reader\.cs$/.test(file.path) && file.content.includes('PRICE_UNAVAILABLE'));
  assert.ok(reader, 'ningún lector de réplica falla con el error declarado');
  assert.match(reader.content, /throw new PriceUnavailable\w*\(/, 'el lector no lanza la excepción del error del diseño');
});

test('catalog-extended: réplica con onMiss degrade — el lector lleva la prosa del diseño (replica.onMiss.degradedTo)', async () => {
  const files = await emitted('catalog-extended-replica-degrade');
  const prose = branch('catalog-extended-replica-degrade').prose;
  assert.ok(files.some((file) => /Reader\.cs$/.test(file.path) && file.content.includes(prose)), 'la prosa de degradedTo no llega al lector');
  assert.ok(files.some((file) => /Handler\.cs$/.test(file.path) && file.content.includes(prose)), 'la nota del handler no dice cómo degradar');
});

test('catalog-extended: activación con onFailure degrade — el fallback deja el TODO con la prosa (activations.onFailure.degradedTo)', async () => {
  const files = await emitted('catalog-extended-activation-degrade');
  const prose = branch('catalog-extended-activation-degrade').prose;
  assert.ok(files.some((file) => file.path.endsWith('.cs') && file.content.includes(prose)), 'la prosa de degradedTo no llega a lo emitido');
});

test('payment-checkout: captura parcial — el puerto y el adaptador llevan el importe (payments.capture.amount)', async () => {
  const files = await emitted('payment-checkout-partial-capture');
  const port = files.find((file) => file.path.endsWith('IPaymentGateway.cs'));
  assert.ok(port, 'no se emitió el puerto de la pasarela');
  assert.match(port.content, /Task<GatewayOutcome> Capture\(string reference, string gatewayPaymentId, decimal\? amount, string\? currency,/);
  const adapter = files.find((file) => file.path.endsWith('StripePaymentGateway.cs'));
  assert.ok(adapter, 'no se emitió el adaptador de Stripe');
  assert.match(adapter.content, /"amount_to_capture"/, 'el adaptador no manda el importe a capturar');
});

test('stock-reservation: un compuesto en la respuesta se lee con el lector de la entrada; en el cuerpo, lo escribe el cable', async () => {
  const files = await emitted('stock-reservation-compuesto-saliente');
  const { checkSupportedFeatures } = await import('../src/lib/supported-features.js');
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'stock-reservation'));
  branch('stock-reservation-compuesto-saliente').mutate(manifest, layers, 'stock-reservation');
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], 'la frontera todavía lo rechaza');
  const response = files.find((file) => file.path.endsWith('CancelStockResponse.cs'));
  assert.ok(response.content.includes('ResponseReading.Composite(fields, "refund", "inventory.cancelStock.refund", "un Refund", ValueReaders.ReadRefund)'));
  const report = files.find((file) => file.path.endsWith('ReportRefundResponse.cs'));
  assert.ok(report.content.includes('ResponseReading.CompositeList(fields, "refunds"'));
  const reading = files.find((file) => file.path.endsWith('ResponseReading.cs'));
  assert.ok(reading.content.includes('public static T RequiredComposite<T>'));
  const request = files.find((file) => file.path.endsWith('ReportRefundRequest.cs'));
  assert.ok(request.content.includes('public Refund Refund { get; }'), 'el cuerpo no lleva el value object');
  // La prueba emitida lo EJECUTA (cs-check): llega como su value object, y lo que no se construye viola el contrato.
  const tests = files.find((file) => file.path.endsWith('OutboundClientsTests.cs'));
  assert.ok(tests.content.includes('Assert.Equal(new Refund(12.5m, "x"), result.Refund)'));
  assert.ok(tests.content.includes('QueNoSeConstruyeViolaElContrato'));
});

for (const name of ['product-catalog-declared-lock', 'mailer-mongo-lock']) {
  test(`${name}: el lockVersion declarado es nullable en el dominio, como el que añade build (optimisticLocking: declared)`, async () => {
    const { root } = branch(name);
    const files = await emitted(name);
    const aggregate = files.find((file) => file.path.endsWith(`Aggregate/${root}.cs`));
    assert.ok(aggregate, `no se emitió el agregado ${root}`);
    assert.match(aggregate.content, /public required int\? LockVersion \{ get; init; \}/, 'el estado lleva el lockVersion sin null');
    assert.match(aggregate.content, /public int\? LockVersion \{ get; private set; \}/, 'el agregado lleva el lockVersion sin null');
    const adapter = files.find((file) => file.path.endsWith(`Repositories/${root}Repository.cs`));
    assert.ok(adapter, `no se emitió el adaptador de ${root}`);
    assert.ok(adapter.content.includes('if (expected is null)'), 'el Save no distingue el agregado nuevo por la versión');
    // Sobre documentos, la versión se guarda con el tipo del campo declarado: un `int` es Int32 en el contrato.
    if (name === 'mailer-mongo-lock') {
      assert.ok(adapter.content.includes('new BsonInt32(expected.Value + 1)'), 'la versión declarada int se guarda como Int64');
      assert.ok(!adapter.content.includes('BsonInt64'), 'queda una versión Int64 en el adaptador');
    }
    // Una respuesta sale de un agregado guardado: el mapper no deja un TODO por la versión.
    const mapper = files.find((file) => file.path.endsWith(`Mappers/${root}ApplicationMapper.cs`));
    assert.ok(mapper, `no se emitió el mapper de ${root}`);
    assert.ok(mapper.content.includes('LockVersion = entity.LockVersion ?? throw new InvalidOperationException('), 'el mapper no exige la versión');
    assert.ok(!/Todo\.Value<int>\("lockVersion/.test(mapper.content), 'el mapper deja la versión al agente');
  });
}

// La autoría declarada: el campo es `generated` y no `required`, así que su columna es nullable; el alta la deja vacía, y
// vacía es AUSENTE. Con `??=` el adaptador guardaba el "" del dominio en lugar del actor (corrida catalog-dotnet).
test('mailer-author: la autoría declarada vacía se estampa con el actor, en la raíz y en la hija (audit.authorship: declared)', async () => {
  const files = await emitted('mailer-author');
  const adapter = files.find((file) => file.path.endsWith('Repositories/TemplateRepository.cs'));
  assert.ok(adapter, 'no se emitió el adaptador de Template');
  assert.match(adapter.content, /if \(string\.IsNullOrEmpty\(row\.CreatedBy\)\) \{ row\.CreatedBy = actor; \}\s+row\.UpdatedBy = actor;/);
  assert.match(adapter.content, /if \(string\.IsNullOrEmpty\(child\.CreatedBy\)\) \{ child\.CreatedBy = actor; \} child\.UpdatedBy = actor;/);
  for (const file of files.filter((candidate) => candidate.path.endsWith('.cs'))) {
    assert.doesNotMatch(file.content, /CreatedBy \?\?= actor/, file.path);
  }
});

test('mailer-mongo-author: en un documento, la autoría declarada vacía también es ausente', async () => {
  const files = await emitted('mailer-mongo-author');
  const adapter = files.find((file) => file.path.endsWith('Repositories/TemplateRepository.cs'));
  assert.ok(adapter, 'no se emitió el adaptador de Template');
  assert.ok(adapter.content.includes('BsonValues.StampCreated(node, "created_by", actor);'), 'created_by no pasa por StampCreated');
  const values = files.find((file) => file.path.endsWith('/BsonValues.cs'));
  assert.ok(values?.content.includes('current is BsonString { Value: "" }'), 'StampCreated no trata "" como ausente');
});

// Cada parche es un diseño VÁLIDO: uno que la validación rechaza no llegaría nunca a build, y su rama no la genera nadie.
for (const { name, from, mutate } of UNCOVERED_BRANCHES) {
  test(`${name}: es un diseño válido (si no, build no llegaría a generarlo)`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(manifest, layers, from);
    assert.deepEqual(checkCrossRefs({ layers, manifest }).errors, []);
  });
}

test('catalog-conditional y catalog-conditional-mongo: la escritura condicional entera (api.concurrency, concurrency.operations)', async () => {
  const { checkSupportedFeatures } = await import('../src/lib/supported-features.js');
  for (const name of ['catalog-conditional', 'catalog-conditional-mongo']) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, branch(name).from));
    branch(name).mutate(manifest, layers, name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], `${name}: la frontera todavía lo rechaza`);
    const files = await emitted(name);
    const find = (suffix) => files.find((file) => file.path.endsWith(suffix));
    // El mensaje lleva la versión esperada; el lector del endpoint la lee lo primero (428 antes que todo 400).
    assert.match(find('UpdateProductCommand.cs').content, /public IReadOnlyList<long>\? ExpectedVersions \{ get; init; \}/);
    const endpoints = files.find((file) => /Endpoints\/ProductV1Endpoints\.cs$/.test(file.path)).content;
    assert.match(endpoints, /var expectedVersions = ConditionalRequests\.ExpectedVersions\(httpRequest, required: true\);\n {8}var id = /);
    assert.match(endpoints, /ExpectedVersions = expectedVersions,/);
    // La lectura derivada y las escrituras que devuelven la raíz escriben el ETag desde Versioned<T>.
    assert.equal((endpoints.match(/ConditionalRequests\.WriteETag\(http, versioned\.Version\);/g) ?? []).length, 3);
    assert.match(find('GetProductBySlugQueryHandler.cs').content, /IQueryHandler<GetProductBySlugQuery, Versioned<GetProductBySlugResponseDto>>/);
    assert.match(find('UpdateProductCommandHandler.cs').content, /productRepository\.LoadExpecting\(command\.Id, command\.ExpectedVersions, cancellationToken\)/);
    // El puerto y el adaptador de la rama comparan; el gate nace con las dos escrituras.
    assert.match(find('IProductRepository.cs').content, /Task<Product\?> LoadExpecting\(Guid id, IReadOnlyList<long>\? expectedVersions/);
    assert.ok(files.some((file) => /Repository\.cs$/.test(file.path) && file.content.includes('throw new PreconditionFailedException()')));
    const gate = find('infra/check-conditional-writes.sh').content;
    assert.match(gate, /check 'updateProduct' 'Product'/);
    assert.match(gate, /check 'retireProduct' 'Product'/);
  }
});
