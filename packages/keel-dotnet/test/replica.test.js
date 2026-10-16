// La RÉPLICA (`dependencies.needs` con `strategy: replicated`, incremento 13j-b) de keel-dotnet, sobre el texto emitido de
// catalog-extended:
//
//   · el proyector (Application/Projection) construye la copia con el constructor de rehidratación —una réplica no lleva
//     invariantes del dominio propio— y descarta un hecho anterior o igual al guardado;
//   · el lector aplica onMiss (fetch, con su Hydrate del agente) y lee por lote cuando lo lee un listado;
//   · el adaptador de la réplica guarda en su PROPIA transacción (un ámbito nuevo) y tiene el finder por lote;
//   · el handler del usedBy recibe el lector con su nota, la operación de proyección el proyector, y los dos están
//     registrados.
// Lo que EJECUTA el C# contra PostgreSQL —crear, la reentrega, el hecho viejo y el nuevo, la transacción propia que sobrevive
// a la que se revierte, el lote— lo mide `npm run db-check -- --only=catalog-extended`, falsado con replica-tx,
// replica-order y replica-batch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const notesOf = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');

test('el proyector crea y actualiza la copia sin TODO y descarta el hecho anterior o igual', async () => {
  const { files } = await planFixture('catalog-extended');
  const projector = content(files, '/Projection/SupplierPriceProjector.cs');
  assert.match(projector, /public sealed record SupplierPriceSnapshot\(string Sku, decimal Amount, string Currency, DateTimeOffset OccurredAt\);/);
  assert.match(projector, /var existing = await repository\.FindBySku\(snapshot\.Sku, cancellationToken\);/);
  assert.match(projector, /if \(snapshot\.OccurredAt <= existing\.OccurredAt\)\s+\{\s+return;/);
  assert.match(projector, /Id = existing\.Id,\s+Sku = existing\.Sku,\s+Amount = snapshot\.Amount,/);
  assert.match(projector, /Id = Guid\.CreateVersion7\(\),\s+Sku = snapshot\.Sku,/);
  assert.doesNotMatch(projector, /TODO|NotImplementedException/);
});

test('el lector aplica onMiss fetch con el Hydrate del agente y lee por lote para los listados', async () => {
  const { files } = await planFixture('catalog-extended');
  const reader = content(files, '/Projection/SupplierPriceReader.cs');
  assert.match(reader, /SupplierPriceReader\(ISupplierPriceRepository repository, IPricingClient pricingClient\)/);
  assert.match(reader, /await repository\.FindBySku\(sku, cancellationToken\) \?\? await Hydrate\(sku, cancellationToken\)/);
  assert.match(reader, /TODO \(agente\): invoca await pricingClient\.GetPrice/);
  assert.match(reader, /public async Task<IReadOnlyDictionary<string, SupplierPrice>> ByKeys\(IReadOnlyCollection<string> skus/);
  assert.match(reader, /await repository\.FindAllBySkuIn\(skus, cancellationToken\)/);
});

test('el adaptador de la réplica guarda en un ámbito propio y tiene el finder por lote; los demás no', async () => {
  const { files } = await planFixture('catalog-extended');
  const adapter = content(files, '/Repositories/SupplierPriceRepository.cs');
  assert.match(adapter, /SupplierPriceRepository\(CatalogDbContext db, PersistenceTransactions transactions, IServiceScopeFactory scopes\)/);
  assert.match(adapter, /await using var scope = scopes\.CreateAsyncScope\(\);\s+var own = \(SupplierPriceRepository\)scope\.ServiceProvider\.GetRequiredService<ISupplierPriceRepository>\(\);\s+return await own\.SaveHere\(entity, cancellationToken\);/);
  assert.match(adapter, /internal async Task<SupplierPrice> SaveHere\(/);
  assert.match(adapter, /Where\(r => keys\.Contains\(r\.Sku\)\)/);
  assert.doesNotMatch(content(files, '/Repositories/ProductRepository.cs'), /SaveHere|CreateAsyncScope/);
});

test('el handler del usedBy recibe el lector con su nota; la proyección, el proyector; los dos están registrados', async () => {
  const { files } = await planFixture('catalog-extended');
  const list = content(files, '/UseCases/ListProductsQueryHandler.cs');
  assert.match(list, /SupplierPriceReader supplierPriceReader/);
  assert.match(notesOf(list), /lee SupplierPrice con await supplierPriceReader\.ByKey\(\.\.\., cancellationToken\), que ya aplica onMiss: fetch/);
  assert.match(notesOf(list), /lee la página entera con await supplierPriceReader\.ByKeys/);
  assert.doesNotMatch(list, /IPricingClient/);
  const project = content(files, '/UseCases/ProjectSupplierPriceCommandHandler.cs');
  assert.match(project, /SupplierPriceProjector supplierPriceProjector/);
  assert.match(notesOf(project), /Proyección de SupplierPrice: aplica el estado que informa el evento con await supplierPriceProjector\.Apply/);
  const registration = content(files, '/UseCase/UseCaseRegistration.cs');
  assert.match(registration, /services\.AddScoped<SupplierPriceProjector>\(\);/);
  assert.match(registration, /services\.AddScoped<SupplierPriceReader>\(\);/);
});
