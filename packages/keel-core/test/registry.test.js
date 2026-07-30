import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_TTL_MS,
  DEFAULT_REGISTRY_URL,
  baseUrlOf,
  downloadDesign,
  dslMismatchMessage,
  dslSupport,
  findDesign,
  loadRegistryIndex,
  parseRegistryRef,
  resolveSourceUrl,
  searchDesigns
} from '../src/lib/registry-source.js';
import { supportedDsl } from '../src/lib/assets.js';

const URL_INDEX = 'https://example.test/registry/index.json';

function design(slug, overrides = {}) {
  return {
    slug,
    family: overrides.family ?? slug,
    variant: overrides.variant ?? null,
    service: { name: slug, version: '1.0.0', dsl: '2.3', domain: 'commerce', basedOn: null, description: `Diseño ${slug}.` },
    metadata: overrides.metadata ?? null,
    layers: ['domain', 'use-cases'],
    counts: { entities: 1, operations: 2 },
    status: { ok: true, pending: 0, errors: 0 },
    derivatives: {},
    docs: { design: `docs/${slug}/DESIGN.md`, overview: null, integration: null },
    files: overrides.files ?? [
      `specs/${slug}/service.keel.yaml`,
      `specs/${slug}/domain.keel.yaml`,
      `specs/${slug}/use-cases.keel.yaml`,
      `docs/${slug}/DESIGN.md`
    ],
    ...(overrides.extra ?? {})
  };
}

function indexOf(designs, families) {
  return {
    schemaVersion: 1,
    designs,
    families: families ?? designs.map((entry) => ({ name: entry.family, designs: [entry.slug] }))
  };
}

/** fetch de mentira: mapa url → { status, body, etag } y registro de llamadas. */
function fakeFetch(routes, { calls = [] } = {}) {
  const impl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} });
    const route = typeof routes === 'function' ? routes(url, options) : routes[url];
    if (!route) return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' };
    if (route.throws) throw new Error(route.throws);
    return {
      ok: route.status === undefined || (route.status >= 200 && route.status < 300),
      status: route.status ?? 200,
      headers: { get: (name) => (name.toLowerCase() === 'etag' ? (route.etag ?? null) : null) },
      text: async () => route.body ?? ''
    };
  };
  impl.calls = calls;
  return impl;
}

const tmpCache = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regcache-'));

test('parseRegistryRef distingue el prefijo del registry de una ruta o nombre local', () => {
  assert.deepEqual(parseRegistryRef('registry:catalog'), { slug: 'catalog' });
  assert.deepEqual(parseRegistryRef('registry:notifications-push-only'), { slug: 'notifications-push-only' });
  assert.equal(parseRegistryRef('catalog'), null);
  assert.equal(parseRegistryRef('specs/catalog'), null);
  assert.equal(parseRegistryRef('../otro/specs/catalog'), null);
  assert.equal(parseRegistryRef(undefined), null);
});

test('registry: sin slug es un error accionable, no un slug vacío', () => {
  const parsed = parseRegistryRef('registry:');

  assert.equal(parsed.slug, null);
  assert.match(parsed.error, /Usa registry:<diseño>/);
});

test('la fuente respeta la precedencia --source > KEEL_REGISTRY_URL > oficial', () => {
  assert.equal(resolveSourceUrl({ env: {} }), DEFAULT_REGISTRY_URL);
  assert.equal(resolveSourceUrl({ env: { KEEL_REGISTRY_URL: 'https://mi.test/i.json' } }), 'https://mi.test/i.json');
  assert.equal(
    resolveSourceUrl({ source: 'https://cli.test/i.json', env: { KEEL_REGISTRY_URL: 'https://env.test/i.json' } }),
    'https://cli.test/i.json'
  );
});

test('baseUrlOf da la raíz del registry, que es contra la que resuelven los files', () => {
  assert.equal(baseUrlOf(URL_INDEX), 'https://example.test/registry/');
  assert.equal(baseUrlOf('http://localhost:8000/index.json'), 'http://localhost:8000/');
});

test('el índice se descarga, se parsea y se guarda en caché con su ETag', async () => {
  const cacheDir = tmpCache();
  const body = JSON.stringify(indexOf([design('catalog')]));
  const fetchImpl = fakeFetch({ [URL_INDEX]: { body, etag: 'W/"v1"' } });

  const result = await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: 1_000 });

  assert.equal(result.from, 'red');
  assert.equal(result.index.designs[0].slug, 'catalog');
  const meta = JSON.parse(fs.readFileSync(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.meta.json')).map((f) => path.join(cacheDir, f))[0], 'utf8'));
  assert.equal(meta.etag, 'W/"v1"');
  assert.equal(meta.fetchedAt, 1_000);
  assert.equal(meta.url, URL_INDEX);
});

test('dentro del TTL se sirve de caché sin tocar la red', async () => {
  const cacheDir = tmpCache();
  const body = JSON.stringify(indexOf([design('catalog')]));
  const calls = [];
  const fetchImpl = fakeFetch({ [URL_INDEX]: { body } }, { calls });

  await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: 1_000 });
  assert.equal(calls.length, 1);

  const second = await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: 1_000 + CACHE_TTL_MS - 1 });
  assert.equal(second.from, 'caché');
  assert.equal(calls.length, 1, 'no debe volver a la red dentro del TTL');
});

test('pasado el TTL se revalida, y --refresh fuerza aunque el TTL no haya vencido', async () => {
  const cacheDir = tmpCache();
  const body = JSON.stringify(indexOf([design('catalog')]));
  const calls = [];
  const fetchImpl = fakeFetch({ [URL_INDEX]: { body, etag: 'W/"v1"' } }, { calls });

  await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: 0 });
  await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: CACHE_TTL_MS + 1 });
  assert.equal(calls.length, 2, 'pasado el TTL debe revalidar');
  assert.equal(calls[1].headers['If-None-Match'], 'W/"v1"', 'debe revalidar con el ETag');

  await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, refresh: true, now: CACHE_TTL_MS + 2 });
  assert.equal(calls.length, 3, '--refresh ignora el TTL');
});

test('un 304 sirve la caché y renueva su marca de tiempo', async () => {
  const cacheDir = tmpCache();
  const body = JSON.stringify(indexOf([design('catalog')]));
  let status = 200;
  const fetchImpl = fakeFetch(() => ({ body, etag: 'W/"v1"', status }));

  await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: 0 });
  status = 304;
  const result = await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, refresh: true, now: 5_000 });

  assert.equal(result.from, 'caché');
  assert.equal(result.index.designs[0].slug, 'catalog');
  const metaFile = fs.readdirSync(cacheDir).find((f) => f.endsWith('.meta.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, metaFile), 'utf8')).fetchedAt, 5_000);
});

test('--offline sirve la caché sin red', async () => {
  const cacheDir = tmpCache();
  const body = JSON.stringify(indexOf([design('catalog')]));
  await loadRegistryIndex({ source: URL_INDEX, fetchImpl: fakeFetch({ [URL_INDEX]: { body } }), cacheDir, env: {}, now: 0 });

  const result = await loadRegistryIndex({
    source: URL_INDEX,
    fetchImpl: () => assert.fail('--offline no debe tocar la red'),
    cacheDir,
    env: {},
    offline: true,
    now: 10 * CACHE_TTL_MS
  });

  assert.equal(result.from, 'caché');
  assert.equal(result.index.designs[0].slug, 'catalog');
});

test('--offline sin caché explica el camino manual en vez de fallar a secas', async () => {
  const result = await loadRegistryIndex({ source: URL_INDEX, cacheDir: tmpCache(), env: {}, offline: true });

  assert.match(result.error, /No hay copia local/);
  assert.match(result.error, /--from <ruta>/);
});

test('si la red falla y hay caché, se usa la caché con un aviso', async () => {
  const cacheDir = tmpCache();
  const body = JSON.stringify(indexOf([design('catalog')]));
  await loadRegistryIndex({ source: URL_INDEX, fetchImpl: fakeFetch({ [URL_INDEX]: { body } }), cacheDir, env: {}, now: 0 });

  const result = await loadRegistryIndex({
    source: URL_INDEX,
    fetchImpl: fakeFetch({ [URL_INDEX]: { throws: 'ENOTFOUND' } }),
    cacheDir,
    env: {},
    now: 10 * CACHE_TTL_MS
  });

  assert.equal(result.from, 'caché');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ENOTFOUND/);
});

test('si la red falla y no hay caché, es un error', async () => {
  const result = await loadRegistryIndex({
    source: URL_INDEX,
    fetchImpl: fakeFetch({ [URL_INDEX]: { throws: 'ENOTFOUND' } }),
    cacheDir: tmpCache(),
    env: {}
  });

  assert.match(result.error, /No se pudo descargar el registry/);
});

test('un índice de un formato más nuevo se rechaza pidiendo actualizar la CLI', async () => {
  const body = JSON.stringify({ schemaVersion: 99, designs: [] });
  const result = await loadRegistryIndex({
    source: URL_INDEX,
    fetchImpl: fakeFetch({ [URL_INDEX]: { body } }),
    cacheDir: tmpCache(),
    env: {}
  });

  assert.match(result.error, /formato 99/);
  assert.match(result.error, /Actualiza keel-core/);
});

test('un índice que no es JSON o no tiene la forma esperada se rechaza', async () => {
  const cacheDir = tmpCache();
  const roto = await loadRegistryIndex({ source: URL_INDEX, fetchImpl: fakeFetch({ [URL_INDEX]: { body: 'no json' } }), cacheDir, env: {} });
  assert.match(roto.error, /no es JSON válido/);

  const raro = await loadRegistryIndex({
    source: URL_INDEX,
    fetchImpl: fakeFetch({ [URL_INDEX]: { body: '{"cosas":[]}' } }),
    cacheDir: tmpCache(),
    env: {}
  });
  assert.match(raro.error, /no tiene la forma esperada/);
});

test('un HTTP 404 sin caché es un error con su código', async () => {
  const result = await loadRegistryIndex({
    source: URL_INDEX,
    fetchImpl: fakeFetch({}),
    cacheDir: tmpCache(),
    env: {}
  });

  assert.match(result.error, /HTTP 404/);
});

test('cada URL tiene su propia entrada de caché: un registry privado no pisa al oficial', async () => {
  const cacheDir = tmpCache();
  const otra = 'https://privado.test/index.json';
  const fetchImpl = fakeFetch({
    [URL_INDEX]: { body: JSON.stringify(indexOf([design('catalog')])) },
    [otra]: { body: JSON.stringify(indexOf([design('interno')])) }
  });

  await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, now: 0 });
  await loadRegistryIndex({ source: otra, fetchImpl, cacheDir, env: {}, now: 0 });

  const oficial = await loadRegistryIndex({ source: URL_INDEX, fetchImpl, cacheDir, env: {}, offline: true });
  const privado = await loadRegistryIndex({ source: otra, fetchImpl, cacheDir, env: {}, offline: true });

  assert.equal(oficial.index.designs[0].slug, 'catalog');
  assert.equal(privado.index.designs[0].slug, 'interno');
});

test('findDesign encuentra por slug', () => {
  const index = indexOf([design('catalog'), design('order')]);

  assert.equal(findDesign(index, 'order').design.slug, 'order');
});

test('pedir una familia en vez de una variante lista las variantes', () => {
  const index = indexOf(
    [
      design('notifications-multichannel', { family: 'notifications', variant: 'multichannel' }),
      design('notifications-push-only', { family: 'notifications', variant: 'push-only' })
    ],
    [{ name: 'notifications', designs: ['notifications-multichannel', 'notifications-push-only'] }]
  );

  const { error } = findDesign(index, 'notifications');
  assert.match(error, /es una familia con 2 variante/);
  assert.match(error, /registry:notifications-multichannel/);
});

test('un slug inexistente sugiere los parecidos', () => {
  const index = indexOf([design('notifications-multichannel', { family: 'notifications' })]);

  const { error } = findDesign(index, 'notifications-multi');
  assert.match(error, /No existe el diseño/);
  assert.match(error, /registry:notifications-multichannel/);
});

test('la búsqueda cubre slug, tags, dominio, resumen y descripción', () => {
  const index = indexOf([
    design('catalog', { metadata: { summary: 'Catálogo comercial.', maturity: 'reference', tags: ['products', 'outbox'] } }),
    design('order', { metadata: { summary: 'Pedidos con compensación.', maturity: 'stable', tags: ['saga'] } })
  ]);

  assert.deepEqual(searchDesigns(index, 'outbox').map((d) => d.slug), ['catalog']);
  assert.deepEqual(searchDesigns(index, 'saga').map((d) => d.slug), ['order']);
  assert.deepEqual(searchDesigns(index, 'compensación').map((d) => d.slug), ['order']);
  assert.deepEqual(searchDesigns(index, 'commerce').map((d) => d.slug), ['catalog', 'order']);
  assert.deepEqual(searchDesigns(index, 'CATALOG').map((d) => d.slug), ['catalog'], 'debe ignorar mayúsculas');
  assert.deepEqual(searchDesigns(index, 'inexistente'), []);
});

test('dslSupport clasifica soportado, más nuevo y sin declarar', () => {
  const [primera] = supportedDsl();

  assert.equal(dslSupport(design('catalog')), 'ok', 'el fixture usa una versión soportada');
  assert.equal(dslSupport({ service: { dsl: primera } }), 'ok');
  assert.equal(dslSupport({ service: { dsl: '9.0' } }), 'nueva');
  assert.equal(dslSupport({ service: { dsl: null } }), 'desconocida');
  assert.equal(dslSupport({ service: {} }), 'desconocida');
  assert.equal(dslSupport({}), 'desconocida');
});

test('dslSupport acepta una lista de soportadas inyectada', () => {
  assert.equal(dslSupport({ service: { dsl: '3.0' } }, { supported: ['3.0'] }), 'ok');
  assert.equal(dslSupport({ service: { dsl: '2.3' } }, { supported: ['3.0'] }), 'nueva');
});

test('el mensaje de DSL incompatible dice qué declara, qué se soporta y qué hacer', () => {
  const message = dslMismatchMessage({ slug: 'futuro', service: { dsl: '9.0' } }, { supported: ['2.3'] });

  assert.match(message, /'futuro'/);
  assert.match(message, /keel 9\.0/);
  assert.match(message, /2\.3/);
  assert.match(message, /Actualiza keel-core/);
});

test('un diseño con DSL más nuevo no se descarga: el gate va antes de la red', async () => {
  // downloadDesign se llamaría después del gate; si el gate falla y aun así se
  // descarga, este fetch tumba el test en vez de dejar pasar el bug.
  const futuro = design('futuro', { extra: { service: { name: 'futuro', version: '1.0.0', dsl: '9.0' } } });

  assert.equal(dslSupport(futuro), 'nueva');
  const result = await downloadDesign(
    { ...futuro, files: ['docs/futuro/DESIGN.md'] },
    { indexUrl: URL_INDEX, fetchImpl: () => assert.fail('no debe tocar la red') }
  );
  assert.match(result.error, /no lista el manifiesto/);
});

// Fixture completo: spec + escenarios + los derivados de docs/, incluido uno en
// subcarpeta (Postman) para fijar que la subruta se conserva.
function fullDesign(slug = 'catalog') {
  return design(slug, {
    files: [
      `specs/${slug}/service.keel.yaml`,
      `specs/${slug}/domain.keel.yaml`,
      `specs/${slug}/use-cases.keel.yaml`,
      `specs/${slug}/validation-scenarios.md`,
      `docs/${slug}/DESIGN.md`,
      `docs/${slug}/overview.html`,
      `docs/${slug}/postman/${slug}-collection.json`
    ]
  });
}

function fullRoutes(base = 'https://example.test/registry/', slug = 'catalog') {
  return {
    [`${base}specs/${slug}/service.keel.yaml`]: { body: 'keel: "2.3"\n' },
    [`${base}specs/${slug}/domain.keel.yaml`]: { body: 'entities: {}\n' },
    [`${base}specs/${slug}/use-cases.keel.yaml`]: { body: 'operations: {}\n' },
    [`${base}specs/${slug}/validation-scenarios.md`]: { body: '# FL-1\n' },
    [`${base}docs/${slug}/DESIGN.md`]: { body: '# Diseño\n' },
    [`${base}docs/${slug}/overview.html`]: { body: '<html></html>' },
    [`${base}docs/${slug}/postman/${slug}-collection.json`]: { body: '{}' }
  };
}

test('la descarga reparte el spec plano y los derivados del origen, con sus subrutas', async () => {
  const fetchImpl = fakeFetch(fullRoutes());

  const result = await downloadDesign(fullDesign(), { indexUrl: URL_INDEX, fetchImpl, tmpRoot: os.tmpdir() });

  assert.equal(result.error, undefined);
  assert.deepEqual(fs.readdirSync(result.dir).sort(), [
    'domain.keel.yaml',
    'service.keel.yaml',
    'use-cases.keel.yaml',
    'validation-scenarios.md'
  ]);
  assert.equal(fs.readFileSync(path.join(result.dir, 'service.keel.yaml'), 'utf8'), 'keel: "2.3"\n');

  assert.deepEqual(fs.readdirSync(result.docsDir).sort(), ['DESIGN.md', 'overview.html', 'postman', 'validation-scenarios.md']);
  assert.equal(fs.readFileSync(path.join(result.docsDir, 'DESIGN.md'), 'utf8'), '# Diseño\n');
  assert.ok(fs.existsSync(path.join(result.docsDir, 'postman', 'catalog-collection.json')), 'la subcarpeta postman/ se conserva');
  // Los escenarios viajan al bundle de referencia sin volver a pedirse.
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('validation-scenarios.md')).length, 1);
  assert.deepEqual(result.warnings, []);

  fs.rmSync(result.root, { recursive: true, force: true });
});

test('con docs: false solo se piden los artefactos del spec', async () => {
  const fetchImpl = fakeFetch(fullRoutes());

  const result = await downloadDesign(fullDesign(), { indexUrl: URL_INDEX, fetchImpl, tmpRoot: os.tmpdir(), docs: false });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.docsFiles, []);
  assert.deepEqual(fs.readdirSync(result.docsDir), []);
  assert.equal(fetchImpl.calls.length, 4, 'no debe descargar docs/');
  fs.rmSync(result.root, { recursive: true, force: true });
});

test('un derivado que no se puede descargar es un aviso, no un error: la derivación sigue', async () => {
  const routes = fullRoutes();
  delete routes['https://example.test/registry/docs/catalog/DESIGN.md'];
  const fetchImpl = fakeFetch(routes);

  const result = await downloadDesign(fullDesign(), { indexUrl: URL_INDEX, fetchImpl, tmpRoot: os.tmpdir() });

  assert.equal(result.error, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /docs\/catalog\/DESIGN\.md/);
  assert.ok(fs.existsSync(path.join(result.dir, 'service.keel.yaml')), 'el spec se descarga entero');
  assert.ok(fs.existsSync(path.join(result.docsDir, 'overview.html')), 'los demás derivados siguen llegando');
  fs.rmSync(result.root, { recursive: true, force: true });
});

test('un índice cuyo diseño no lista el manifiesto no se puede derivar', async () => {
  const entry = design('catalog', { files: ['docs/catalog/DESIGN.md'] });
  const result = await downloadDesign(entry, { indexUrl: URL_INDEX, fetchImpl: fakeFetch({}) });

  assert.match(result.error, /no lista el manifiesto/);
});

test('si falla la descarga de un archivo, no queda directorio temporal a medias', async () => {
  const entry = design('catalog');
  const base = 'https://example.test/registry/';
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('keel-registry-')).length;

  const result = await downloadDesign(entry, {
    indexUrl: URL_INDEX,
    fetchImpl: fakeFetch({ [`${base}specs/catalog/service.keel.yaml`]: { body: 'keel: "2.3"\n' } }),
    tmpRoot: os.tmpdir()
  });

  assert.match(result.error, /HTTP 404/);
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('keel-registry-')).length;
  assert.equal(after, before, 'el directorio temporal debe limpiarse');
});
