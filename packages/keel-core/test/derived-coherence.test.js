// Coherencia de CONTENIDO de openapi.yaml, asyncapi.yaml y la colección Postman con el diseño.
//
// Cada id tiene su derivado saboteado a propósito, y el sabotaje de uno no puede disparar a
// otro: un detector que sale en verde sobre un derivado roto no distingue «coherente» de «no
// mira». Su primera pasada sobre el catalog publicado en el registry encontró 18 requests de
// Postman afirmando el status de OTRO paso del flujo (un GET de la ficha esperando 201).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { checkDerivedCoherence } from '../src/lib/derived-coherence.js';

const layers = () => ({
  domain: { entities: { Product: { fields: { id: { type: 'uuid', id: true, generated: true } } } } },
  'use-cases': {
    operations: {
      createProduct: { input: 'void', output: 'void', errors: [{ code: 'SKU_TAKEN', when: 'x', http: 409 }] },
      getProduct: { kind: 'query', input: 'void', output: 'void', errors: [{ code: 'PRODUCT_NOT_FOUND', when: 'x', http: 404 }] }
    }
  },
  api: {
    basePath: '/api/v1',
    endpoints: {
      createProduct: { method: 'POST', path: '/products', successStatus: 201 },
      getProduct: { method: 'GET', path: '/products/{id}' }
    }
  },
  messaging: {
    channels: { productEvents: {} },
    publishing: {
      events: {
        ProductCreated: {
          channel: 'productEvents',
          payload: { productId: { type: 'uuid', required: true }, description: { type: 'text' } }
        }
      }
    }
  }
});

const openapi = () => ({
  openapi: '3.1.0',
  info: { version: '1.0.0' },
  paths: {
    '/api/v1/products': { post: { operationId: 'createProduct', responses: { 201: {}, 409: {} } } },
    '/api/v1/products/{id}': { get: { operationId: 'getProduct', responses: { 200: {}, 404: {} } } }
  }
});

const asyncapi = () => ({
  asyncapi: '3.0.0',
  info: { version: '1.0.0' },
  channels: { productEvents: { address: 'productEvents', messages: { ProductCreated: { $ref: '#/components/messages/ProductCreated' } } } },
  components: {
    messages: {
      ProductCreated: {
        payload: { type: 'object', properties: { metadata: {}, data: { $ref: '#/components/schemas/ProductCreatedPayload' } } }
      }
    },
    schemas: {
      ProductCreatedPayload: { type: 'object', required: ['productId'], properties: { productId: {}, description: {} } }
    }
  }
});

const request = (name, method, url, status) => ({
  name,
  request: { method, url: { raw: `{{baseUrl}}${url}` } },
  event: [{ listen: 'test', script: { exec: [`pm.test('status ${status}', () => pm.response.to.have.status(${status}));`] } }]
});

const postman = () => ({
  info: { name: 'catalog' },
  item: [
    {
      name: 'FL-PRD-001 — alta',
      item: [
        request('FL-PRD-001 · A — Alta (201)', 'POST', '/api/v1/products', 201),
        request('FL-PRD-001 · B — Ficha (200)', 'GET', '/api/v1/products/{{productId}}', 200)
      ]
    }
  ]
});

const SCENARIOS = '### FL-PRD-001: alta\n**Then**:\n1. Status `201`.\n';

function run(mutate = {}) {
  const docsDir = tmpDir('keel-derived-');
  const docs = { openapi: openapi(), asyncapi: asyncapi(), postman: postman() };
  for (const [key, fn] of Object.entries(mutate)) if (typeof fn === "function") fn(docs[key]);
  fs.writeFileSync(path.join(docsDir, 'openapi.yaml'), YAML.stringify(docs.openapi));
  fs.writeFileSync(path.join(docsDir, 'asyncapi.yaml'), YAML.stringify(docs.asyncapi));
  fs.mkdirSync(path.join(docsDir, 'postman'));
  fs.writeFileSync(path.join(docsDir, 'postman', 'catalog-collection.json'), JSON.stringify(docs.postman));
  const { findings } = checkDerivedCoherence({
    layers: layers(),
    manifest: { service: { name: 'catalog' } },
    docsDir,
    scenarios: mutate.scenarios ?? SCENARIOS
  });
  return findings;
}
const ids = (findings) => [...new Set(findings.map((f) => f.id))];

test('los tres derivados coherentes con el diseño no dan ningún hallazgo', () => {
  assert.deepEqual(run(), []);
});

test('CHK-DOCS-OPENAPI-DRIFT: ruta, successStatus, errores y operaciones de más', () => {
  const findings = run({
    openapi: (doc) => {
      doc.paths['/api/v1/products'].post.responses = { 200: {} }; // ni 201 ni 409
      doc.paths['/api/v1/extra'] = { get: { operationId: 'listSecrets', responses: { 200: {} } } };
    }
  });
  assert.deepEqual(ids(findings), ['CHK-DOCS-OPENAPI-DRIFT']);
  const text = findings.map((f) => f.message).join('\n');
  assert.match(text, /no trae la respuesta 201 de 'createProduct'/);
  assert.match(text, /no documenta 409 en 'createProduct'/);
  assert.match(text, /documenta 'listSecrets', que api no declara/);

  const movida = run({ openapi: (doc) => {
    doc.paths['/api/v1/items/{id}'] = doc.paths['/api/v1/products/{id}'];
    delete doc.paths['/api/v1/products/{id}'];
  } });
  assert.match(movida[0].message, /documenta 'getProduct' como GET \/api\/v1\/items\/\{id\}/);
});

test('CHK-DOCS-ASYNCAPI-DRIFT: canal, campos del payload y obligatoriedad', () => {
  const findings = run({
    asyncapi: (doc) => {
      doc.components.schemas.ProductCreatedPayload = { type: 'object', required: ['productId', 'description'], properties: { productId: {}, description: {}, internalNote: {} } };
    }
  });
  assert.deepEqual(ids(findings), ['CHK-DOCS-ASYNCAPI-DRIFT']);
  const text = findings.map((f) => f.message).join('\n');
  assert.match(text, /añade a 'ProductCreated' 'internalNote'/);
  assert.match(text, /obligatorios: 'description'/);

  const sinCampo = run({ asyncapi: (doc) => { delete doc.components.schemas.ProductCreatedPayload.properties.description; } });
  assert.match(sinCampo[0].message, /omite en 'ProductCreated' 'description'/);
  const sinCanal = run({ asyncapi: (doc) => { doc.channels = { other: { address: 'other', messages: {} } }; } });
  assert.ok(sinCanal.some((f) => /no tiene el canal 'productEvents'/.test(f.message)));
});

test('CHK-DOCS-POSTMAN-DRIFT: el status de otro paso copiado a una request, y carpetas sin flujo', () => {
  // La firma exacta de lo que había en el catalog del registry: el GET de la ficha esperando el 201 del alta.
  const findings = run({
    postman: (doc) => {
      doc.item[0].item[1] = request('FL-PRD-001 · B — Ficha (201)', 'GET', '/api/v1/products/{{productId}}', 201);
    }
  });
  assert.deepEqual(ids(findings), ['CHK-DOCS-POSTMAN-DRIFT']);
  assert.match(findings[0].message, /afirma 201 sobre 'getProduct'/);

  // Un 404 SÍ lo puede dar getProduct: no es un hallazgo.
  assert.deepEqual(run({ postman: (doc) => { doc.item[0].item[1] = request('FL-PRD-001 · B — Ficha (404)', 'GET', '/api/v1/products/{{x}}', 404); } }), []);

  const carpetas = run({ scenarios: '### FL-PRD-002: otro\n**Then**:\n1. Status `200`.\n' });
  const text = carpetas.map((f) => f.message).join('\n');
  assert.match(text, /no tiene carpeta para FL-PRD-002/);
  assert.match(text, /carpeta de FL-PRD-001, que validation-scenarios\.md ya no define/);

  const fueraDeApi = run({ postman: (doc) => { doc.item[0].item.push(request('FL-PRD-001 · C — ? (200)', 'DELETE', '/api/v1/products/{{id}}', 200)); } });
  assert.match(fueraDeApi[0].message, /no casa con ningún endpoint de api/);
});

test('sin docs/<servicio>/ no hay nada que contrastar', () => {
  assert.deepEqual(checkDerivedCoherence({ layers: layers(), manifest: {}, docsDir: null }).findings, []);
});
