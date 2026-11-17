// La BÚSQUEDA de DSL 2.32 (in, ne, search y el ?sort= del cliente) en keel-dotnet: la forma de lo que emite build sobre
// el sujeto de keel-core/test/helpers/finder-designs.js (SEARCH_DESIGNS) y que cada sabotaje de las sondas se aplique a lo
// emitido. Lo que esto NO dice —que el finder devuelva lo que dice la referencia, que el lector rechace lo que no ofrece
// sortable, que el texto se ordene igual en los dos motores— lo miden db-check y doc-check contra el motor real
// (scripts/lib/search-probes.js: FS-1 a FS-10 y SO-1 a SO-11), con el C# compilado.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';
import { planFixture } from './helpers/workspace.js';
import { SEARCH_SABOTAGE_SPECS, searchCases } from '../scripts/lib/search-probes.js';

const emitted = new Map();
async function plan(name, engine = null) {
  const key = `${name}:${engine}`;
  if (!emitted.has(key)) {
    const design = SEARCH_DESIGNS.find((entry) => entry.name === name);
    emitted.set(key, await planFixture(design.from, { mutate: (manifest, layers) => { manifest.service.name = name; design.mutate(layers); }, stack: engine ? { database: engine } : null }));
  }
  return emitted.get(key);
}
const file = (files, suffix) => files.find((entry) => entry.path.endsWith(suffix))?.content ?? '';

test('el finder relacional: in con la lista, ne que deja pasar el nulo y la búsqueda como un OR sobre las sombras', async () => {
  const { files } = await plan('catalog-search');
  const adapter = file(files, 'Repositories/ProductRepository.cs');
  assert.match(adapter, /query = query\.Where\(r => statuses\.Contains\(r\.Status\)\);/);
  assert.match(adapter, /query = query\.Where\(r => r\.Notes == null \|\| r\.Notes != notNotes\);/);
  assert.match(adapter, /var qFolded = TextFold\.FoldCaseAndAccents\(q\);/);
  assert.match(adapter, /r\.NameNormalized\.Contains\(qFolded\) \|\| \(r\.NotesNormalized != null && r\.NotesNormalized\.Contains\(qFolded\)\)/);
});

test('el finder documental: $in escrito como se guarda, $ne y un $or de expresiones citadas', async () => {
  const { files } = await plan('catalog-search-mongo');
  const adapter = file(files, 'Repositories/ProductRepository.cs');
  assert.match(adapter, /"\$in", new BsonArray\(statuses\.Select\(item => BsonValues\.Enum\(item, /);
  assert.match(adapter, /new BsonDocument\("\$ne", BsonValues\.Of\(notNotes\)\)/);
  assert.match(adapter, /new BsonDocument\("\$or", new BsonArray \{ .*Regex\.Escape\(qFolded\).*Regex\.Escape\(qFolded\).* \}\)/);
});

test('el borde: ?sort= contra sortable (400 InvalidSortException) y la lista de la query con su nombre', async () => {
  const { files } = await plan('catalog-search');
  const reading = file(files, 'Rest/PageableReading.cs');
  assert.match(reading, /IReadOnlyDictionary<string, string>\? sortable = null/);
  assert.match(reading, /throw new InvalidSortException\(value\);/);
  const endpoints = files.filter((entry) => entry.path.includes('/Endpoints/')).map((entry) => entry.content).join('\n');
  assert.match(endpoints, /sortable: new Dictionary<string, string> \{ \["name"\] = "name", \["sku"\] = "sku", \["price\.amount"\] = "priceAmount" \}/);
  assert.match(endpoints, /TextValues\.List<ProductStatus>\(httpRequest\.Query\["statuses"\], "statuses", /);
  // Sin sortable (el listado de product-catalog), ningún orden del cliente: el lector no recibe el diccionario.
  assert.ok(!/ListProducts[\s\S]*?sortable: new Dictionary/.test(endpoints.split('SearchCatalog')[0]));
  const middleware = file(files, 'Rest/ApiErrorMiddleware.cs');
  assert.match(middleware, /case InvalidSortException invalidSort:/);
});

test('la collation binaria del orden en cada columna de texto ordenable (U7)', async () => {
  const postgres = file((await plan('catalog-search')).files, 'Rows/ProductRow.cs');
  assert.match(postgres, /r\.Name\)\.HasColumnName\("name"\)\.HasMaxLength\(\d+\)\.UseCollation\("C"\)/);
  const mysql = file((await plan('catalog-search', 'mysql')).files, 'Rows/ProductRow.cs');
  assert.match(mysql, /r\.Name\)\.HasColumnName\("name"\)\.HasMaxLength\(\d+\)\.UseCollation\("utf8mb4_bin"\)/);
});

test('la clave de la caché de un listado paginado suma la página, el tamaño y el orden (D18)', async () => {
  const design = SEARCH_DESIGNS.find((entry) => entry.name === 'catalog-search');
  const { files } = await planFixture(design.from, {
    mutate: (manifest, layers) => {
      manifest.service.name = 'catalog-search-cached';
      design.mutate(layers);
      layers['use-cases'].operations.searchCatalog.cache = { ttlSeconds: 60, keyFields: ['q'] };
    },
    stack: { cache: 'redis' }
  });
  const cached = file(files, 'CachedOperations.cs');
  assert.match(cached, /CacheKey\.Of\(message\.Q, message\.Pageable\.Page, message\.Pageable\.Size, string\.Join\(";", message\.Pageable\.Sort\.Select/);
});

for (const [name, branch] of [['catalog-search', 'relational'], ['catalog-search-mongo', 'document']]) {
  test(`${name}: cada sabotaje de la búsqueda se aplica a lo emitido`, async () => {
    const { model, files } = await plan(name);
    assert.equal(searchCases(model).length, 21, 'FS-1 a FS-10 y SO-1 a SO-11');
    for (const [id, specs] of Object.entries(SEARCH_SABOTAGE_SPECS)) {
      const spec = specs[branch];
      if (!spec) continue;
      const [suffix, from] = spec;
      const hit = files.some((entry) => entry.path.includes(suffix) && typeof entry.content === 'string' && (typeof from === 'string' ? entry.content.includes(from) : new RegExp(from.source).test(entry.content)));
      assert.ok(hit, `${id} (${branch}) no se aplica a lo emitido`);
    }
  });
}
