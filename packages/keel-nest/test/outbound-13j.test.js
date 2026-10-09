// Incremento 13j, EJECUTADO sobre catalog-extended: lo que faltaba de la capa dependencies y de los clientes salientes.
//
//   · `onUnavailable: lastKnown` — el adaptador recuerda lo que contesta el proveedor y, caído, sirve el último valor
//     DE ESOS parámetros mientras esté dentro de `maxAgeSeconds`; fuera, se rinde con el error del diseño;
//   · `oauth2-client-credentials` — la concesión con la semántica de Spring Security: una petición al emisor por
//     token, secreto por client_secret_basic, scope en el formulario, y un emisor caído es `auth-grant` (el fallback
//     del diseño, nunca un 500 y nunca una petición de negocio sin Authorization);
//   · la réplica — el proyector descarta la reentrega tardía y el lector aplica `onMiss`;
//   · la configuración — las mismas variables y valores que la de keel-spring, perfil a perfil.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Optional = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;

const { files } = planFixture('catalog-extended');
const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });

/** Un servidor falso con una respuesta por ruta (`'POST /oauth2/token'`), y lo que recibió. */
async function fakeServer(routes) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const key = `${request.method} ${request.url.split('?')[0]}`;
      requests.push({ key, headers: request.headers, body });
      const route = routes[key];
      if (!route) {
        response.writeHead(404);
        response.end();
        return;
      }
      route(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const json = (status, value) => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

// ─── lastKnown ────────────────────────────────────────────────────────────────

test('lastKnown: caído, sirve el último precio DE ESE sku dentro de la ventana; fuera, el error del diseño', async (t) => {
  const { PricingHttpAdapter } = await tree.load('src/infrastructure/clients/pricing-http-adapter.ts');
  const { PricingMapper } = await tree.load('src/infrastructure/clients/pricing-mapper.ts');
  const { LastKnownValues } = await tree.load('src/infrastructure/clients/last-known-values.ts');
  const { PriceUnavailableError } = await tree.load('src/domain/errors/price-unavailable-error.ts');
  let up = true;
  const prices = { 'SKU-1': { amount: 12.5, currency: 'EUR' }, 'SKU-2': { amount: 99, currency: 'EUR' } };
  // El sku va en el camino: el proveedor falso lo resuelve a mano.
  const server = http.createServer((request, response) => {
    if (!up) return request.socket.destroy();
    const sku = decodeURIComponent(request.url.split('/').pop());
    json(200, prices[sku])(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = { pricing: { id: 'pricing', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500, headers: {} } };
  const adapter = new PricingHttpAdapter(settings, new PricingMapper(), new LastKnownValues());
  const first = await adapter.getPrice('SKU-1');
  const second = await adapter.getPrice('SKU-2');
  assert.notDeepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)), 'dos precios distintos');
  up = false;
  const served = await adapter.getPrice('SKU-1');
  assert.deepEqual(JSON.parse(JSON.stringify(served)), JSON.parse(JSON.stringify(first)), 'el último valor de SKU-1, no el del último consultado');
  // Pasada la ventana (900 s), ya no es ese dato.
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => realNow() + 901_000;
  await assert.rejects(adapter.getPrice('SKU-1'), (error) => error instanceof PriceUnavailableError && /supera los 900s/.test(error.message));
  Date.now = realNow;
  // Nunca leído: no hay nada que servir.
  await assert.rejects(adapter.getPrice('SKU-3'), (error) => error instanceof PriceUnavailableError);
});

test('lastKnown: el almacén está acotado por tamaño y tira primero lo más viejo', async () => {
  const { LastKnownValues } = await tree.load('src/infrastructure/clients/last-known-values.ts');
  const store = new LastKnownValues();
  for (let i = 0; i < 10_000; i++) store.remember('getPrice', `k${i}`, i);
  store.remember('getPrice', 'nuevo', 'n');
  assert.equal(store.recall('getPrice', 'nuevo', 60), 'n');
  assert.equal(store.recall('getPrice', 'k0', 60), null, 'la más vieja se fue');
  assert.equal(store.recall('getPrice', 'k9999', 60), 9999, 'las recientes siguen');
  store.remember('getPrice', 'nulo', null);
  assert.equal(store.recall('getPrice', 'nulo', 60), null, 'lo nulo no se recuerda');
});

// ─── OAuth2 client-credentials ────────────────────────────────────────────────

async function partnerAdapter(baseUrl, tokenUri) {
  const { PartnerCatalogHttpAdapter } = await tree.load('src/infrastructure/clients/partner-catalog-http-adapter.ts');
  const { PartnerCatalogMapper } = await tree.load('src/infrastructure/clients/partner-catalog-mapper.ts');
  const { clientCredentials } = await tree.load('src/infrastructure/clients/oauth2-client-credentials.ts');
  const authorization = clientCredentials({ id: 'partner-catalog', tokenUri, clientId: 'mi cliente', clientSecret: 's3cr3t:+', scopes: ['catalog.write'], timeoutMs: 500 });
  const settings = { 'partner-catalog': { id: 'partner-catalog', baseUrl, timeoutMs: 500, headers: {}, authorization } };
  return new PartnerCatalogHttpAdapter(settings, new PartnerCatalogMapper());
}

test('oauth2: pide el token UNA vez y lo reutiliza; Bearer exacto; secreto por client_secret_basic y scope en el formulario', async (t) => {
  const fake = await fakeServer({
    'POST /oauth2/token': json(200, { access_token: 'tok-partner-1', token_type: 'Bearer', expires_in: 3600 }),
    'POST /partner/catalog-changes': json(200, { acceptedAt: '2026-10-09T10:00:00.000Z' })
  });
  t.after(fake.close);
  const adapter = await partnerAdapter(fake.baseUrl, `${fake.baseUrl}/oauth2/token`);
  // Dos llamadas a la vez y una después: una sola concesión.
  await Promise.all([adapter.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f', 'A-1', 'Silla'), adapter.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e70', 'A-2', 'Mesa')]);
  await adapter.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e71', 'A-3', 'Banco');
  const tokens = fake.requests.filter((request) => request.key === 'POST /oauth2/token');
  const business = fake.requests.filter((request) => request.key === 'POST /partner/catalog-changes');
  assert.equal(tokens.length, 1, 'el emisor recibió exactamente una petición');
  assert.equal(business.length, 3);
  assert.ok(business.every((request) => request.headers.authorization === 'Bearer tok-partner-1'));
  assert.equal(tokens[0].headers.authorization, `Basic ${Buffer.from('mi+cliente:s3cr3t%3A%2B').toString('base64')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokens[0].body)), { grant_type: 'client_credentials', scope: 'catalog.write' });
});

test('oauth2: el token se renueva al acercarse su caducidad (expires_in menos 60 s)', async (t) => {
  let issued = 0;
  const fake = await fakeServer({
    'POST /oauth2/token': (request, response) => json(200, { access_token: `tok-${++issued}`, token_type: 'bearer', expires_in: 61 })(request, response),
    'POST /partner/catalog-changes': json(200, { acceptedAt: '2026-10-09T10:00:00.000Z' })
  });
  t.after(fake.close);
  const adapter = await partnerAdapter(fake.baseUrl, `${fake.baseUrl}/oauth2/token`);
  await adapter.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f', 'A-1', 'Silla');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await adapter.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f', 'A-1', 'Silla');
  assert.equal(issued, 2, 'con 61 s de vida y 60 de margen, a los 1,1 s ya se renueva');
});

test('oauth2: el emisor caído es auth-grant — sale el fallback del diseño, no un 500, y ninguna petición de negocio', async (t) => {
  const fake = await fakeServer({
    'POST /oauth2/token': json(500, { error: 'down' }),
    'POST /partner/catalog-changes': json(200, { acceptedAt: '2026-10-09T10:00:00.000Z' })
  });
  t.after(fake.close);
  const adapter = await partnerAdapter(fake.baseUrl, `${fake.baseUrl}/oauth2/token`);
  const result = await adapter.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f', 'A-1', 'Silla');
  assert.equal(result.acceptedAt, null, 'onFailure: ignore — el resultado neutro');
  assert.equal(fake.requests.filter((request) => request.key === 'POST /partner/catalog-changes').length, 0, 'sin token no se sale');
  // Un token sin token_type Bearer tampoco es una concesión.
  const typeless = await fakeServer({ 'POST /oauth2/token': json(200, { access_token: 'x', expires_in: 60 }), 'POST /partner/catalog-changes': json(200, { acceptedAt: null }) });
  t.after(typeless.close);
  const strict = await partnerAdapter(typeless.baseUrl, `${typeless.baseUrl}/oauth2/token`);
  assert.equal((await strict.notifyCatalogChange('0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f', 'A-1', 'Silla')).acceptedAt, null);
  assert.equal(typeless.requests.filter((request) => request.key === 'POST /partner/catalog-changes').length, 0);
});

test('oauth2 y lastKnown: http-clients.yaml lleva las mismas variables y valores que el de keel-spring', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files;
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const springYaml = parseYaml(spring.find((file) => file.path.endsWith(`/parameters/${profile}/http-clients.yaml`)).content);
    const nest = parseYaml(byPath[`config/parameters/${profile}/http-clients.yaml`])['http-clients']['partner-catalog'].auth;
    const registration = springYaml.spring.security.oauth2.client.registration['partner-catalog'];
    const provider = springYaml.spring.security.oauth2.client.provider['partner-catalog'];
    assert.equal(String(nest['client-id']), String(registration['client-id']), `${profile}: client-id`);
    assert.equal(String(nest['client-secret']), String(registration['client-secret']), `${profile}: client-secret`);
    assert.equal(String(nest['token-uri']), String(provider['token-uri']), `${profile}: token-uri`);
  }
});

// ─── La réplica ───────────────────────────────────────────────────────────────

test('réplica: el proyector crea, actualiza y descarta la reentrega tardía; el lector pide al proveedor lo que falta', async () => {
  const { SupplierPriceProjector } = await tree.load('src/application/projection/supplier-price-projector.ts');
  const { SupplierPrice } = await tree.load('src/domain/aggregate/supplier-price.ts');
  // Lo que escribe el agente en el dominio: el factory de la copia y la actualización.
  SupplierPrice.projectionOf = (snapshot) => new SupplierPrice({ id: 'id-1', ...snapshot, lockVersion: null });
  SupplierPrice.prototype.applySnapshot = function (amount, currency, occurredAt) {
    this.updated = { amount, currency, occurredAt };
  };
  const saved = [];
  const store = new Map();
  const repository = {
    findBySku: async (sku) => store.get(sku) ?? null,
    save: async (entity) => {
      saved.push(entity);
      store.set(entity.sku, entity);
      return entity;
    }
  };
  const projector = new SupplierPriceProjector(repository);
  const t0 = new Date('2026-10-09T10:00:00Z');
  await projector.apply({ sku: 'A-1', amount: '10.00', currency: 'EUR', occurredAt: t0 });
  assert.equal(saved.length, 1, 'la primera noticia crea la copia');
  await projector.apply({ sku: 'A-1', amount: '9.00', currency: 'EUR', occurredAt: new Date('2026-10-09T09:00:00Z') });
  assert.equal(saved.length, 1, 'un hecho más viejo no pisa al nuevo');
  await projector.apply({ sku: 'A-1', amount: '11.00', currency: 'EUR', occurredAt: new Date('2026-10-09T11:00:00Z') });
  assert.equal(saved.length, 2);
  assert.equal(saved[1].updated.amount, '11.00');
  const reader = byPath['src/application/projection/supplier-price-reader.ts'];
  assert.match(reader, /static readonly inject = \[SupplierPriceRepository, PricingClient\] as const;/);
  assert.match(reader, /return \(await this\.repository\.findBySku\(sku\)\) \?\? \(await this\.hydrate\(sku\)\);/);
  // La copia se guarda en su PROPIA transacción (el REQUIRES_NEW de keel-spring).
  assert.match(byPath['src/infrastructure/persistence/repositories/supplier-price-repository-impl.ts'], /return this\.transactions\.inNewTransaction\(async \(manager\) => \{/);
  assert.match(byPath['src/application/usecases/list-products-query-handler.ts'], /SupplierPriceReader/);
  assert.match(byPath['src/application/usecases/project-supplier-price-command-handler.ts'], /SupplierPriceProjector/);
  assert.match(byPath['src/infrastructure/usecase/use-case-module.ts'], /const PROJECTIONS = \[\n {2}SupplierPriceProjector,\n {2}SupplierPriceReader\n\] as const;/);
});
