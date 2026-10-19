// Los finders de las búsquedas (DSL 2.22, src/scaffold/finders.js): la forma de lo emitido en las dos ramas. Qué
// restringe cada input lo decide keel-core/gen/query-filters.js; lo EJECUTAN db-check (catalog-extended y
// product-catalog-finder) y doc-check (jobs-mongo-finder), falsados con --sabotage=finder-*.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, UNCOVERED_BRANCHES } from './helpers/workspace.js';

const fileOf = (files, suffix) => files.find((file) => file.path.endsWith(suffix));

async function branchFiles(name) {
  const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);
  return (await planFixture(branch.from, { mutate: (manifest, layers) => branch.mutate(manifest, layers, branch.from) })).files;
}

test('relacional, página: el record, la firma del puerto y el where, la relación y el rango sobre la fila', async () => {
  const { files } = await planFixture('catalog-extended');
  assert.ok(fileOf(files, 'Repository/ListDraftProductsFilter.cs').content.includes('public sealed record ListDraftProductsFilter(Guid? CategoryId, DateTimeOffset? CreatedFrom, DateTimeOffset? CreatedTo);'));
  assert.ok(fileOf(files, 'Repository/IProductRepository.cs').content.includes('Task<Page<Product>> ListDraftProducts(ListDraftProductsFilter filter, Pageable pageable, CancellationToken cancellationToken = default);'));
  const adapter = fileOf(files, 'Repositories/ProductRepository.cs').content;
  assert.ok(adapter.includes('var query = Graph().AsNoTracking().Where(r => r.Status == ProductStatus.Draft);'));
  assert.ok(adapter.includes('query = query.Where(r => r.CategoryId == categoryId);'));
  // timestamptz solo admite UTC: el instante se convierte fuera de la expresión.
  assert.ok(adapter.includes('var createdFromUtc = createdFrom.ToUniversalTime();'));
  assert.ok(adapter.includes('query = query.Where(r => r.CreatedAt >= createdFromUtc);'));
  assert.ok(adapter.includes('query = query.Where(r => r.CreatedAt <= createdToUtc);'));
});

test('relacional, lista: el subcampo aplanado, el prefijo plegado y el orden fijo del diseño', async () => {
  const files = await branchFiles('product-catalog-finder');
  assert.ok(fileOf(files, 'Repository/IProductRepository.cs').content.includes('Task<IReadOnlyList<Product>> ListActiveProducts(ListActiveProductsFilter filter, CancellationToken cancellationToken = default);'));
  const adapter = fileOf(files, 'Repositories/ProductRepository.cs').content;
  assert.ok(adapter.includes('query = query.Where(r => r.NameNormalized.StartsWith(nameFolded));'));
  assert.ok(adapter.includes('query = query.Where(r => r.PriceAmount >= minPrice);'));
  // El orden es el del campo: la sombra de un FILTRO no lleva el orden (keel-core/gen/relational.js, filterOnly).
  assert.ok(adapter.includes('private static readonly IReadOnlyList<SortOrder> ListActiveProductsSort = [new SortOrder("name", ProductCatalog.Domain.Repository.SortDirection.Asc)];'));
  assert.ok(adapter.includes('var rows = await Ordered(query, ListActiveProductsSort).ToListAsync(cancellationToken);'));
});

test('documental: condiciones BSON con el convertidor de cada campo, el patrón escapado y la página contada con el filtro', async () => {
  const files = await branchFiles('jobs-mongo-finder');
  const adapter = fileOf(files, 'Repositories/JobRepository.cs').content;
  assert.ok(adapter.includes('conditions.Add(new BsonDocument("status", BsonValues.Enum(JobStatus.Queued, EnumColumns.JobStatusConstant)));'));
  assert.ok(adapter.includes('new BsonRegularExpression("^" + Regex.Escape(referenceFolded))'));
  assert.ok(adapter.includes('new BsonDocument("created_at", new BsonDocument("$lt", BsonValues.Of(createdBefore)))'));
  assert.ok(adapter.includes('new BsonRegularExpression(Regex.Escape(payload))'));
  assert.ok(adapter.includes('Collection.CountDocumentsAsync(session, query, cancellationToken: cancellationToken)'));
});

test('el handler recibe la llamada al finder y no las notas de plegado; sin finder, la nota dice por qué', async () => {
  const handler = fileOf(await branchFiles('product-catalog-finder'), 'ListActiveProductsQueryHandler.cs').content.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(handler.includes('await productRepository.ListActiveProducts(new ListActiveProductsFilter(query.Name, query.MinPrice), cancellationToken)'));
  assert.doesNotMatch(handler, /pliega el parámetro/);
  const { files } = await planFixture('catalog-extended', {
    mutate: (manifest, layers) => {
      layers['use-cases'].operations.listDraftProducts.input.fields.search = { type: 'string', constraints: { maxLength: 60 } };
    }
  });
  assert.equal(fileOf(files, 'Repository/ListDraftProductsFilter.cs'), undefined);
  assert.ok(fileOf(files, 'ListDraftProductsQueryHandler.cs').content.includes('Sin finder de build: search'));
});
