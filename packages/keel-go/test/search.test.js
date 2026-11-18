// La BÚSQUEDA de DSL 2.32 (in, ne, search y el ?sort= del cliente) en keel-go: la forma de lo que emite build sobre el
// sujeto de keel-core/test/helpers/finder-designs.js (SEARCH_DESIGNS) y que cada sabotaje de las sondas se aplique a lo
// emitido. Lo que esto NO dice —que el finder devuelva lo que dice la referencia, que el lector rechace lo que no ofrece
// sortable, que el texto se ordene igual en los dos motores— lo miden db-check y doc-check contra el motor real
// (scripts/lib/search-probes.js: FS-1 a FS-10 y SO-1 a SO-11), con el Go compilado.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { SEARCH_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { SEARCH_SABOTAGE_SPECS, searchCases, searchProbeFiles } from '../scripts/lib/search-probes.js';

const emitted = new Map();
function plan(name, { database = null, mutate = null } = {}) {
  const key = `${name}:${database}:${Boolean(mutate)}`;
  if (!emitted.has(key)) {
    const design = SEARCH_DESIGNS.find((entry) => entry.name === name);
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
    manifest.service.name = name;
    design.mutate(layers);
    if (mutate) mutate(layers);
    const document = layers.persistence.default.model === 'document';
    emitted.set(key, planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : (database ?? 'postgresql'), ...(mutate ? { cache: 'redis' } : {}) } }));
  }
  return emitted.get(key);
}
const file = (files, pattern) => files.find((entry) => pattern.test(entry.path))?.content ?? '';

test('el finder relacional: in con la lista, ne que deja pasar el nulo y la búsqueda como un OR del patrón literal', () => {
  const adapter = file(plan('catalog-search').files, /postgres\/product_repository\.go$/);
  assert.match(adapter, /if statuses := filter\.Statuses; statuses != nil \{/);
  assert.match(adapter, /statusesValues = append\(statusesValues, productStatusColumn\(item\)\)/);
  assert.match(adapter, /f\.oneOf\("status", statusesValues\)/);
  assert.match(adapter, /f\.distinct\("notes", notNotes\)/);
  assert.match(adapter, /f\.anyLike\(\[\]string\{"name_normalized", "notes_normalized"\}, "%"\+likeLiteral\(textfold\.CaseAndAccents\(q\)\)\+"%"\)/);
  const values = file(plan('catalog-search').files, /postgres\/values\.go$/);
  assert.match(values, /"\("\+column\+" IS NULL OR "\+column\+" <>"/);
  assert.match(values, /func \(f \*filters\) anyLike\(columns \[\]string, pattern string\) \{/);
});

test('el finder documental: $in escrito como se guarda, $ne y un $or de expresiones citadas', () => {
  const adapter = file(plan('catalog-search-mongo').files, /mongo\/product_repository\.go$/);
  assert.match(adapter, /statusesValues = append\(statusesValues, productStatusStored\[item\]\)/);
  assert.match(adapter, /\{Key: "status", Value: bson\.D\{\{Key: "\$in", Value: statusesValues\}\}\}/);
  assert.match(adapter, /\{Key: "notes", Value: bson\.D\{\{Key: "\$ne", Value: notNotes\}\}\}/);
  assert.match(adapter, /qFolded := textfold\.CaseAndAccents\(q\)/);
  assert.match(adapter, /\{Key: "\$or", Value: bson\.A\{.*regexp\.QuoteMeta\(qFolded\).*regexp\.QuoteMeta\(qFolded\).*\}\}/);
});

test('el borde: ?sort= contra sortable (400 invalidSortError) y la lista de la query, con U8 y D10', () => {
  const { files } = plan('catalog-search');
  const reading = file(files, /httpapi\/reading\.go$/);
  assert.match(reading, /func pageableParam\(r \*http\.Request, defaultSize, maxSize int32, defaultSort \[\]domain\.SortOrder, sortable map\[string\]string\) \(domain\.Pageable, error\)/);
  assert.match(reading, /return nil, &invalidSortError\{value: value\}/);
  assert.match(reading, /items = append\(items, strings\.Split\(value, ","\)\.\.\.\)/);
  assert.match(reading, /return nil, &validationError\{params: true, details: \[\]string\{name\}\}/);
  const endpoints = file(files, /httpapi\/product_endpoints\.go$/);
  assert.match(endpoints, /map\[string\]string\{"name": "name", "sku": "sku", "price\.amount": "priceAmount"\}\); err != nil/);
  // El listado de product-catalog declara su sortable desde B8.
  assert.match(endpoints, /pageableParam\(r, \d+, \d+, \[\]domain\.SortOrder\{\{Property: "sku", Direction: domain\.SortAsc\}\}, map\[string\]string\{"sku": "sku", "name": "name", "price\.amount": "priceAmount"\}\)/);
  // Sin sortable (los resultados de un trabajo de lote), ningún orden del cliente: el lector recibe nil.
  assert.match(file(files, /httpapi\/batch_jobs\.go$/), /pageableParam\(r, defaultSize, maxSize, nil, nil\)/);
  const errors = file(files, /httpapi\/errors\.go$/);
  assert.match(errors, /case errors\.As\(err, &invalidSort\):/);
  // La tabla de rutas anuncia `sort` solo en el listado con sortable (U3).
  const routes = file(files, /httpapi\/routes\.go$/);
  assert.match(routes, /"page", "size", "sort"/);
});

test('la collation binaria del orden en cada columna de texto ordenable (U7)', () => {
  const postgres = file(plan('catalog-search').files, /migrations\/00001_baseline\.sql$/);
  assert.match(postgres, /^\s+name\s+varchar\(120\) COLLATE "C"\s+NOT NULL,$/m);
  assert.match(postgres, /^\s+sku\s+varchar\(\d+\) COLLATE "C"\s+NOT NULL,$/m);
  const mysql = file(plan('catalog-search', { database: 'mysql' }).files, /migrations\/00001_baseline\.sql$/);
  assert.match(mysql, /^\s+name\s+varchar\(120\) COLLATE utf8mb4_bin\s+NOT NULL,$/m);
});

test('la clave de la caché de un listado paginado suma la página, el tamaño y el orden (D18)', () => {
  const { files } = plan('catalog-search', {
    mutate: (layers) => {
      layers['use-cases'].operations.searchCatalog.cache = { ttlSeconds: 60, keyFields: ['q'] };
    }
  });
  const cached = file(files, /application\/cached_operations\.go$/);
  assert.match(cached, /return CacheKey\(query\.Q, query\.Pageable\.Page, query\.Pageable\.Size, sortKey\(query\.Pageable\.Sort\)\)/);
  assert.match(cached, /func sortKey\(sort \[\]domain\.SortOrder\) string \{/);
});

for (const [name, branch] of [['catalog-search', 'relational'], ['catalog-search-mongo', 'document']]) {
  test(`${name}: cada sabotaje de la búsqueda se aplica a lo emitido`, () => {
    const { model, files } = plan(name);
    assert.equal(searchCases(model).length, 21, 'FS-1 a FS-10 y SO-1 a SO-11');
    assert.equal(searchProbeFiles(model).length, 2, 'FS-* en el almacén y SO-* en internal/httpapi');
    for (const [id, specs] of Object.entries(SEARCH_SABOTAGE_SPECS)) {
      const spec = specs[branch];
      if (!spec) continue;
      const hit = files.some(
        (entry) =>
          spec.files.test(entry.path) &&
          typeof entry.content === 'string' &&
          (typeof spec.from === 'string' ? entry.content.includes(spec.from) : new RegExp(spec.from.source, spec.from.flags.replace('g', '')).test(entry.content))
      );
      assert.ok(hit, `${id} (${branch}) no se aplica a lo emitido`);
    }
  });
}
