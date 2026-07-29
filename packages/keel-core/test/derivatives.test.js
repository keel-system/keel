import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDerivatives } from '../src/lib/derivatives.js';

const VERSION = '1.2.0';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Monta un workspace de mentira con el diseño de `catalog` y los derivados que
 * se le pidan. `layers` son las capas declaradas; `docs` es un mapa
 * ruta-relativa-a-docs/catalog → contenido.
 */
function workspace({ layers = ['domain', 'use-cases'], docs = {}, scenarios = null, version = VERSION } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-derivatives-'));
  const serviceDir = path.join(cwd, 'specs', 'catalog');

  write(
    path.join(serviceDir, 'service.keel.yaml'),
    [
      'keel: "2.0"',
      'service:',
      '  name: catalog',
      `  version: ${version}`,
      '  description: Catálogo de productos.',
      'layers:',
      ...layers.map((layer) => `  ${layer}: ${layer}.keel.yaml`)
    ].join('\n')
  );

  const layerContent = {
    domain: 'entities:\n  Product:\n    fields:\n      id: { type: uuid, id: true }\n',
    'use-cases': 'operations:\n  createProduct:\n    kind: command\n',
    api: 'basePath: /api/v1\nendpoints:\n  createProduct:\n    method: POST\n    path: /products\n',
    messaging: 'channels:\n  catalog-events: {}\npublishing:\n  events:\n    ProductCreated:\n      channel: catalog-events\n'
  };
  for (const layer of layers) write(path.join(serviceDir, `${layer}.keel.yaml`), layerContent[layer] ?? '{}\n');

  if (scenarios !== null) write(path.join(serviceDir, 'validation-scenarios.md'), scenarios);
  for (const [file, content] of Object.entries(docs)) write(path.join(cwd, 'docs', 'catalog', file), content);

  return { cwd, serviceDir };
}

const byId = (result) => Object.fromEntries(result.derivatives.map((entry) => [entry.id, entry]));

const blockquote = (version) => `# catalog — Escenarios de validación\n\n> specs/catalog v${version}. Contrato de validación.\n`;
const openapi = (version) => `openapi: 3.1.0\ninfo:\n  title: catalog\n  version: ${version}\npaths: {}\n`;
const html = (version) => `<!-- keel:version ${version} -->\n<!doctype html>\n<html></html>\n`;
const postman = (version) =>
  JSON.stringify({ info: { name: 'catalog' }, item: [], variable: [{ key: 'keelVersion', value: version }] });
const frontMatter = (version) => `---\nservice: catalog\nversion: ${version}\n---\n\n# Integración\n`;

test('un derivado con el sello del manifiesto está al día', () => {
  const { cwd, serviceDir } = workspace({ scenarios: blockquote(VERSION), docs: { 'DESIGN.md': blockquote(VERSION) } });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(result.service.version, VERSION);
  assert.equal(byId(result)['validation-scenarios'].status, 'fresh');
  assert.equal(byId(result).design.status, 'fresh');
  assert.equal(byId(result).design.stampedVersion, VERSION);
});

test('un derivado con sello anterior está desactualizado', () => {
  const { cwd, serviceDir } = workspace({ scenarios: blockquote('1.1.0'), docs: { 'DESIGN.md': blockquote('1.1.0') } });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result)['validation-scenarios'].status, 'stale');
  assert.equal(byId(result)['validation-scenarios'].stampedVersion, '1.1.0');
  assert.equal(result.counts.stale, 2);
});

test('un derivado sin sello se reporta como unstamped, no como fresco', () => {
  const { cwd, serviceDir } = workspace({ scenarios: '# catalog — Escenarios de validación\n' });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result)['validation-scenarios'].status, 'unstamped');
  assert.equal(byId(result)['validation-scenarios'].stampedVersion, null);
});

test('un derivado que procede y no existe está missing', () => {
  const { cwd, serviceDir } = workspace();
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result).design.status, 'missing');
  assert.equal(byId(result).overview.status, 'missing');
  assert.equal(byId(result)['validation-scenarios'].status, 'missing');
});

test('sin capa messaging, asyncapi no aplica; sin capa api, tampoco openapi ni postman', () => {
  const { cwd, serviceDir } = workspace();
  const derivatives = byId(listDerivatives(serviceDir, { cwd }));

  for (const id of ['asyncapi', 'asyncapi-viewer']) {
    assert.equal(derivatives[id].status, 'not-applicable');
    assert.equal(derivatives[id].reason, 'sin capa messaging');
  }
  for (const id of ['openapi', 'openapi-viewer', 'postman']) {
    assert.equal(derivatives[id].status, 'not-applicable');
    assert.equal(derivatives[id].reason, 'sin capa api');
  }
});

test('un asyncapi que sobrevive a la retirada de su capa es huérfano', () => {
  const { cwd, serviceDir } = workspace({ docs: { 'asyncapi.yaml': openapi(VERSION) } });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result).asyncapi.status, 'orphan');
  assert.equal(result.counts.orphan, 1);
});

test('con messaging y api, todos los formatos de sello se leen', () => {
  const { cwd, serviceDir } = workspace({
    layers: ['domain', 'use-cases', 'api', 'messaging'],
    scenarios: blockquote(VERSION),
    docs: {
      'DESIGN.md': blockquote(VERSION),
      'openapi.yaml': openapi(VERSION),
      'asyncapi.yaml': `asyncapi: 3.0.0\ninfo:\n  title: catalog\n  version: ${VERSION}\nchannels: {}\n`,
      'openapi.html': html(VERSION),
      'asyncapi.html': html(VERSION),
      'overview.html': html(VERSION),
      'INTEGRATION.md': frontMatter(VERSION),
      'postman/catalog-collection.json': postman(VERSION)
    }
  });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(result.counts.fresh, 9, JSON.stringify(result.derivatives, null, 2));
  assert.equal(result.counts.stale + result.counts.missing + result.counts.unstamped, 0);
});

test('INTEGRATION.md no aplica sin superficie servidor-a-servidor', () => {
  const { cwd, serviceDir } = workspace({ layers: ['domain', 'use-cases', 'api'] });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result).integration.status, 'not-applicable');
});

test('un endpoint audience: services hace aplicable INTEGRATION.md', () => {
  const { cwd, serviceDir } = workspace({ layers: ['domain', 'use-cases', 'api'] });
  write(
    path.join(serviceDir, 'api.keel.yaml'),
    'basePath: /api/v1\nendpoints:\n  createProduct:\n    method: POST\n    path: /products\n    audience: services\n'
  );
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result).integration.status, 'missing');
});

test('los eventos publicados también hacen aplicable INTEGRATION.md', () => {
  const { cwd, serviceDir } = workspace({ layers: ['domain', 'use-cases', 'messaging'] });
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(byId(result).integration.status, 'missing');
});

test('un manifiesto ilegible devuelve inventario vacío con sus errores', () => {
  const { cwd, serviceDir } = workspace();
  fs.writeFileSync(path.join(serviceDir, 'service.keel.yaml'), 'keel: "2.0"\nservice: [');
  const result = listDerivatives(serviceDir, { cwd });

  assert.equal(result.service, null);
  assert.deepEqual(result.derivatives, []);
  assert.ok(result.errors.length > 0);
});

test('las rutas se reportan relativas al workspace y en POSIX', () => {
  const { cwd, serviceDir } = workspace();
  const derivatives = byId(listDerivatives(serviceDir, { cwd }));

  assert.equal(derivatives.design.path, 'docs/catalog/DESIGN.md');
  assert.equal(derivatives['validation-scenarios'].path, 'specs/catalog/validation-scenarios.md');
  assert.equal(derivatives.postman.path, 'docs/catalog/postman/catalog-collection.json');
});
