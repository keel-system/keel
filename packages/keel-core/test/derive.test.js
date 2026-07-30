import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { rewriteManifestForDerivation, rewriteScenariosForDerivation } from '../src/lib/derive.js';
import { schemaPathFor, supportedDsl } from '../src/lib/assets.js';
import { loadRegistryIndex } from '../src/lib/registry-source.js';
import { createService } from '../src/commands/new.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

const MANIFEST_ORIGIN = `# Manifiesto del servicio
keel: "2.0"

service:
  name: billing            # kebab-case
  version: 1.2.0
  description: Gestiona la facturación de pedidos.
  domain: commerce

layers:
  domain: domain.keel.yaml
  use-cases: use-cases.keel.yaml
`;

test('rewriteManifestForDerivation reescribe identidad y conserva comentarios', () => {
  const out = rewriteManifestForDerivation(MANIFEST_ORIGIN, { name: 'billing-eu', basedOn: 'billing@1.2.0' });

  assert.match(out, /# Manifiesto del servicio/);
  assert.match(out, /# kebab-case/);
  assert.match(out, /name: billing-eu/);
  assert.match(out, /version: 0\.1\.0/);
  assert.match(out, /basedOn: billing@1\.2\.0/);
  assert.match(out, /description: "?TODO: revisar descripción heredada de billing — Gestiona la facturación de pedidos\./);
});

test('rewriteManifestForDerivation no doble-prefija una description ya pendiente', () => {
  const source = MANIFEST_ORIGIN.replace(
    'description: Gestiona la facturación de pedidos.',
    'description: "TODO: describe en una frase qué resuelve."'
  );
  const out = rewriteManifestForDerivation(source, { name: 'billing-eu', basedOn: 'billing@1.2.0' });

  assert.doesNotMatch(out, /revisar descripción heredada/);
  assert.match(out, /TODO: describe en una frase qué resuelve\./);
});

const SCENARIOS_ORIGIN = `# Escenarios de validación — billing

> specs/billing v1.2.0. Derivados del diseño; regenerar al cambiarlo.

## FL-1 Emitir factura
`;

test('rewriteScenariosForDerivation reapunta la ruta y conserva la versión del origen', () => {
  const out = rewriteScenariosForDerivation(SCENARIOS_ORIGIN, { name: 'billing-eu' });

  assert.match(out, /^> specs\/billing-eu v1\.2\.0\. Derivados/m);
  // La versión no se toca: el manifiesto derivado nace en 0.1.0, así que el sello
  // heredado es justo lo que deja los escenarios `stale` en keel describe.
  assert.doesNotMatch(out, /v0\.1\.0/);
  assert.match(out, /## FL-1 Emitir factura/);
});

test('rewriteScenariosForDerivation deja intacto un archivo sin cabecera de sello', () => {
  const source = '# escenarios\n\n## FL-1\n';
  assert.equal(rewriteScenariosForDerivation(source, { name: 'billing-eu' }), source);
});

test('el schema del manifiesto acepta basedOn con formato servicio@versión y rechaza el resto', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(fs.readFileSync(schemaPathFor('common'), 'utf8')));
  const check = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('service'), 'utf8')));

  const manifest = (basedOn) => ({
    keel: '2.0',
    service: { name: 'billing-eu', version: '0.1.0', description: 'Facturación para la región europea.', basedOn },
    layers: { domain: 'domain.keel.yaml', 'use-cases': 'use-cases.keel.yaml' }
  });

  assert.equal(check(manifest('billing@1.2.0')), true, JSON.stringify(check.errors));
  assert.equal(check(manifest('billing')), false);
  assert.equal(check(manifest('billing@1.2')), false);
});

function makeWorkspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-derive-'));
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  t.after(() => {
    process.chdir(prevCwd);
    process.exitCode = prevExitCode;
    fs.rmSync(base, { recursive: true, force: true });
  });

  // isKeelWorkspace solo comprueba que exista schema/service.schema.json
  fs.mkdirSync(path.join(base, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(base, 'schema', 'service.schema.json'), '{}');

  const originDir = path.join(base, 'specs', 'billing');
  fs.mkdirSync(originDir, { recursive: true });
  fs.writeFileSync(path.join(originDir, 'service.keel.yaml'), MANIFEST_ORIGIN);
  fs.writeFileSync(path.join(originDir, 'domain.keel.yaml'), 'entities:\n  Invoice:\n    fields: {}\n');
  fs.writeFileSync(path.join(originDir, 'use-cases.keel.yaml'), 'operations: {}\n');
  fs.writeFileSync(path.join(originDir, 'validation-scenarios.md'), SCENARIOS_ORIGIN);

  process.chdir(base);
  return base;
}

test('keel new --from clona las capas, reescribe el manifiesto y hereda validation-scenarios.md', (t) => {
  const base = makeWorkspace(t);

  createService('billing-eu', { from: 'billing' });

  assert.notEqual(process.exitCode, 1);
  const destDir = path.join(base, 'specs', 'billing-eu');
  const manifest = fs.readFileSync(path.join(destDir, 'service.keel.yaml'), 'utf8');
  assert.match(manifest, /name: billing-eu/);
  assert.match(manifest, /basedOn: billing@1\.2\.0/);
  assert.equal(
    fs.readFileSync(path.join(destDir, 'domain.keel.yaml'), 'utf8'),
    fs.readFileSync(path.join(base, 'specs', 'billing', 'domain.keel.yaml'), 'utf8')
  );
  assert.equal(fs.existsSync(path.join(destDir, 'use-cases.keel.yaml')), true);

  // Los escenarios llegan como punto de partida, con la ruta reapuntada y el
  // sello del origen: `keel describe` los verá stale, que es lo que toca hasta
  // que se regeneren al cerrar el diseño derivado.
  const scenarios = fs.readFileSync(path.join(destDir, 'validation-scenarios.md'), 'utf8');
  assert.match(scenarios, /^> specs\/billing-eu v1\.2\.0\./m);
  assert.match(scenarios, /## FL-1 Emitir factura/);
});

test('keel new --from deriva igual si el origen no tiene escenarios', (t) => {
  const base = makeWorkspace(t);
  fs.rmSync(path.join(base, 'specs', 'billing', 'validation-scenarios.md'));

  createService('billing-eu', { from: 'billing' });

  assert.notEqual(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'validation-scenarios.md')), false);
});

test('keel new --from acepta el origen como ruta (specs/billing)', (t) => {
  const base = makeWorkspace(t);

  createService('billing-eu', { from: path.join('specs', 'billing') });

  assert.notEqual(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml')), true);
});

test('keel new --from falla si el origen no existe', (t) => {
  makeWorkspace(t);

  createService('billing-eu', { from: 'no-existe' });

  assert.equal(process.exitCode, 1);
});

test('keel new --from falla si origen y destino son el mismo servicio', (t) => {
  makeWorkspace(t);

  createService('billing', { from: 'billing' });

  assert.equal(process.exitCode, 1);
});

// --- Derivación desde el registry: los derivados del origen ---------------

const REGISTRY_URL = 'https://example.test/registry/index.json';

function registryFixture({ files, missing = [] }) {
  const [dsl] = supportedDsl();
  const index = {
    schemaVersion: 1,
    designs: [
      {
        slug: 'billing',
        family: 'billing',
        variant: null,
        service: { name: 'billing', version: '1.2.0', dsl, domain: 'commerce', basedOn: null, description: 'Facturación.' },
        metadata: null,
        layers: ['domain', 'use-cases'],
        counts: {},
        status: { ok: true, pending: 0, errors: 0 },
        derivatives: {},
        docs: { design: 'docs/billing/DESIGN.md', overview: null, integration: null },
        files: Object.keys(files)
      }
    ],
    families: []
  };
  const routes = { [REGISTRY_URL]: JSON.stringify(index) };
  for (const [file, body] of Object.entries(files)) routes[`https://example.test/registry/${file}`] = body;
  for (const file of missing) delete routes[`https://example.test/registry/${file}`];

  return async (url) => {
    const body = routes[typeof url === 'string' ? url : url.toString()];
    if (body === undefined) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
}

const REGISTRY_FILES = {
  'specs/billing/service.keel.yaml': MANIFEST_ORIGIN,
  'specs/billing/domain.keel.yaml': 'entities:\n  Invoice:\n    fields: {}\n',
  'specs/billing/use-cases.keel.yaml': 'operations: {}\n',
  'specs/billing/validation-scenarios.md': SCENARIOS_ORIGIN,
  'docs/billing/DESIGN.md': '# Diseño de billing\n',
  'docs/billing/overview.html': '<html></html>',
  'docs/billing/postman/billing-collection.json': '{}'
};

function withRegistry(t, fetchImpl) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = previous;
  });
  return { source: REGISTRY_URL, fetchImpl, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regcache-')) };
}

test('keel new --from registry deja la documentación del origen en docs/<nuevo>/origin/', async (t) => {
  const base = makeWorkspace(t);
  const registry = withRegistry(t, registryFixture({ files: REGISTRY_FILES }));

  await createService('billing-eu', { from: 'registry:billing', ...registry });

  assert.notEqual(process.exitCode, 1);
  assert.match(fs.readFileSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml'), 'utf8'), /basedOn: billing@1\.2\.0/);

  const originDir = path.join(base, 'docs', 'billing-eu', 'origin');
  assert.deepEqual(fs.readdirSync(originDir).sort(), [
    'DESIGN.md',
    'README.md',
    'overview.html',
    'postman',
    'validation-scenarios.md'
  ]);
  assert.equal(fs.readFileSync(path.join(originDir, 'DESIGN.md'), 'utf8'), '# Diseño de billing\n');
  assert.ok(fs.existsSync(path.join(originDir, 'postman', 'billing-collection.json')));
  assert.match(fs.readFileSync(path.join(originDir, 'README.md'), 'utf8'), /billing@1\.2\.0/);
  // La carpeta de referencia no invade los derivados propios del servicio nuevo.
  assert.equal(fs.existsSync(path.join(base, 'docs', 'billing-eu', 'DESIGN.md')), false);
  // Y los escenarios también quedan en el spec, reapuntados: origin/ es la copia
  // congelada, specs/ el punto de partida editable.
  assert.match(
    fs.readFileSync(path.join(base, 'specs', 'billing-eu', 'validation-scenarios.md'), 'utf8'),
    /^> specs\/billing-eu v1\.2\.0\./m
  );
});

test('derivar del registry revalida el índice aunque la caché siga dentro del TTL', async (t) => {
  const base = makeWorkspace(t);
  // El índice viejo no listaba los derivados: es exactamente el escenario que
  // dejaba docs/<nuevo>/origin/ incompleto sin decir nada.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regcache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const viejo = Object.fromEntries(Object.entries(REGISTRY_FILES).filter(([file]) => file.startsWith('specs/')));
  await loadRegistryIndex({ source: REGISTRY_URL, fetchImpl: registryFixture({ files: viejo }), cacheDir, env: {} });

  const registry = withRegistry(t, registryFixture({ files: REGISTRY_FILES }));
  await createService('billing-eu', { from: 'registry:billing', ...registry, cacheDir });

  assert.notEqual(process.exitCode, 1);
  assert.ok(fs.existsSync(path.join(base, 'docs', 'billing-eu', 'origin', 'DESIGN.md')));
});

test('derivar con --offline no toca la red: se sirve de la caché', async (t) => {
  const base = makeWorkspace(t);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regcache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  await loadRegistryIndex({
    source: REGISTRY_URL,
    fetchImpl: registryFixture({ files: REGISTRY_FILES }),
    cacheDir,
    env: {}
  });

  // El índice solo puede salir de la caché; los artefactos sí se descargan.
  let indexHits = 0;
  const fetchImpl = registryFixture({ files: REGISTRY_FILES });
  const spy = async (url) => {
    if (String(url) === REGISTRY_URL) indexHits += 1;
    return fetchImpl(url);
  };
  const registry = withRegistry(t, spy);

  await createService('billing-eu', { from: 'registry:billing', ...registry, offline: true, cacheDir });

  assert.notEqual(process.exitCode, 1);
  assert.equal(indexHits, 0);
  assert.ok(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml')));
});

test('keel new --from registry --no-docs no escribe docs/<nuevo>/', async (t) => {
  const base = makeWorkspace(t);
  const registry = withRegistry(t, registryFixture({ files: REGISTRY_FILES }));

  await createService('billing-eu', { from: 'registry:billing', docs: false, ...registry });

  assert.notEqual(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu', 'service.keel.yaml')), true);
  assert.equal(fs.existsSync(path.join(base, 'docs', 'billing-eu')), false);
});

test('keel new --from registry deriva igual aunque falte un derivado', async (t) => {
  const base = makeWorkspace(t);
  const registry = withRegistry(t, registryFixture({ files: REGISTRY_FILES, missing: ['docs/billing/DESIGN.md'] }));

  await createService('billing-eu', { from: 'registry:billing', ...registry });

  assert.notEqual(process.exitCode, 1);
  const originDir = path.join(base, 'docs', 'billing-eu', 'origin');
  assert.equal(fs.existsSync(path.join(originDir, 'DESIGN.md')), false);
  assert.equal(fs.existsSync(path.join(originDir, 'overview.html')), true);
});

test('keel new --from falla si el YAML del origen está roto', (t) => {
  const base = makeWorkspace(t);
  fs.writeFileSync(path.join(base, 'specs', 'billing', 'domain.keel.yaml'), 'entities: [inválido\n');

  createService('billing-eu', { from: 'billing' });

  assert.equal(process.exitCode, 1);
  assert.equal(fs.existsSync(path.join(base, 'specs', 'billing-eu')), false);
});
