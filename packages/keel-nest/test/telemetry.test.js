// La telemetría que emite keel-nest (incremento 14c), EJECUTADA: se transpila el árbol de catalog-extended generado
// con `telemetry: otel`, se arranca su telemetría con la configuración real del perfil develop contra un receptor OTLP
// falso de node:http, y se ejercita lo que el código generado observa — el caso de uso, la entrada HTTP sobre un
// Fastify real, la publicación y el consumo de un evento, una llamada saliente, el storage y la caché—. Lo que se
// afirma es la equivalencia del plan: las MISMAS series (nombres, etiquetas, unidades) que consultan el panel y las
// alertas de keel-spring, el exemplar que enlaza el punto con su traza y la traza que cruza HTTP y eventos.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import Fastify from 'fastify';
import { loadService } from '@keel-system/keel-core';
import { promMetric, promTag, OBSERVATIONS, ATTRIBUTES, INSTRUMENTATION, METRICS_TRANSPORT } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const SUBJECT = 'catalog-extended';
const STACK = { database: 'postgresql', broker: 'rabbitmq', telemetry: 'otel', cache: 'redis', storage: 'minio' };
const plan = planFixture(SUBJECT, { stack: STACK });
const byPath = Object.fromEntries(plan.files.map((file) => [file.path, file.content]));
const tree = transpileTree(plan.files);
const load = (file) => tree.load(file);

// Los config/ emitidos, para cargar la configuración real de cada perfil.
const root = tmpDir('keel-nest-telemetry-');
for (const file of plan.files.filter((candidate) => candidate.path.startsWith('config/'))) {
  fs.mkdirSync(path.join(root, path.dirname(file.path)), { recursive: true });
  fs.writeFileSync(path.join(root, file.path), file.content);
}

// El receptor OTLP: guarda lo que le llega por ruta (las trazas en JSON, la forma del exportador por defecto).
const received = [];
const receiver = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    let body = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
    received.push({ path: request.url, body: JSON.parse(body.toString('utf8')) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${receiver.address().port}`;

const { loadConfiguration } = await load('src/infrastructure/config/configuration.ts');
const configuration = loadConfiguration(
  {
    PROFILE: 'develop',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    LOG_EXPORT_OTLP: 'true',
    HOSTNAME: 'pod-7',
    // Las que develop exige sin default (los proveedores y la URL pública del storage): no son de esta prueba.
    ...Object.fromEntries(['PRICING', 'SEARCH_INDEX', 'COMPLIANCE', 'LEGACY_ERP', 'PARTNER_CATALOG'].map((id) => [`${id}_BASE_URL`, 'http://127.0.0.1:1'])),
    STORAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:1'
  },
  root
);
const { Telemetry, instrumentStorage } = await load('src/infrastructure/telemetry/telemetry.ts');
const telemetry = Telemetry.start(configuration);
after(async () => {
  await telemetry.shutdown();
  receiver.close();
});

const CALLER_TRACE = '0af7651916cd43dd8448eb211c80319c';
const CALLER = `00-${CALLER_TRACE}-b7ad6b7169203331-01`;

/** Las líneas del scrape que empiezan por `prefix`. */
async function scrape(prefix) {
  const text = await telemetry.registry.metrics();
  return text.split('\n').filter((line) => line.startsWith(prefix));
}

/** Todos los spans exportados hasta ahora, con su traceId y su padre en hex. */
async function exportedSpans() {
  await telemetry.flush();
  return received
    .filter((entry) => entry.path === '/v1/traces')
    .flatMap((entry) => entry.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((span) => ({ ...span, resource: rs.resource })))));
}

test('el caso de uso: keel_use_case_seconds con operación y desenlace, y el rechazo del dominio no es un error del span', async () => {
  const { DomainException } = await load('src/domain/errors/domain-exception.ts');
  class Rejected extends DomainException {}
  const parent = telemetry.contextFrom(CALLER);
  const observe = (outcome) =>
    telemetry.observe(
      OBSERVATIONS.useCase,
      { name: 'CreateProductCommand', labels: { [ATTRIBUTES.operation]: 'CreateProductCommand' }, parent, isRejection: (error) => error instanceof DomainException },
      async () => {
        if (outcome === 'rejected') throw new Rejected('SKU_ALREADY_EXISTS', 'ya existe');
        if (outcome === 'error') throw new TypeError('boom');
        return 'ok';
      }
    );
  assert.equal(await observe('ok'), 'ok');
  await assert.rejects(observe('rejected'), Rejected);
  await assert.rejects(observe('error'), TypeError);
  const counts = await scrape(promMetric(OBSERVATIONS.useCase).count);
  for (const outcome of ['ok', 'rejected', 'error']) {
    assert.ok(
      counts.some((line) => line.includes(`${promTag(ATTRIBUTES.operation)}="CreateProductCommand"`) && line.includes(`${promTag(ATTRIBUTES.outcome)}="${outcome}"`)),
      `${outcome}: ${counts.join(' | ')}`
    );
  }
  // El exemplar va pegado a un cubo y apunta a la traza del llamante.
  const buckets = await scrape(promMetric(OBSERVATIONS.useCase).bucket);
  assert.ok(buckets.some((line) => line.includes(` # {trace_id="${CALLER_TRACE}",span_id="`)), buckets.join('\n'));
  const spans = (await exportedSpans()).filter((span) => span.name === 'CreateProductCommand');
  assert.equal(spans.length, 3);
  assert.ok(spans.every((span) => span.traceId === CALLER_TRACE && span.parentSpanId === 'b7ad6b7169203331'));
  const statusOf = (outcome) => spans.find((span) => span.attributes.some((a) => a.key === ATTRIBUTES.outcome && a.value.stringValue === outcome)).status.code ?? 0;
  assert.equal(statusOf('rejected'), 0, 'un rechazo del dominio no marca el span como error');
  assert.equal(statusOf('error'), 2, 'un fallo sí');
  // El recurso: quién emitió el span (servicio, versión, entorno y réplica).
  const attrs = Object.fromEntries(spans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.deepEqual(
    [attrs['service.name'], attrs['service.version'], attrs['deployment.environment'], attrs['service.instance.id']],
    [plan.model.service.name, plan.model.service.version, 'develop', 'pod-7']
  );
});

test('la entrada HTTP: span SERVER que continúa la traza de quien llama y http_server_requests_seconds con la plantilla de la ruta', async () => {
  const fastify = Fastify();
  telemetry.installHttp(fastify);
  fastify.get('/api/v1/products/:id', async () => ({ ok: true }));
  fastify.get('/livez', async () => ({ status: 'UP' }));
  await fastify.ready();
  const ok = await fastify.inject({ method: 'GET', url: '/api/v1/products/0190c6a4?x=1', headers: { traceparent: CALLER } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await fastify.inject({ method: 'GET', url: '/nada' })).statusCode, 404);
  await fastify.inject({ method: 'GET', url: '/livez' });
  const counts = await scrape(promMetric('http.server.requests').count);
  assert.ok(counts.some((line) => line.includes('method="GET"') && line.includes('uri="/api/v1/products/{id}"') && line.includes('status="200"') && line.includes('outcome="SUCCESS"')), counts.join('\n'));
  assert.ok(counts.some((line) => line.includes('uri="NOT_FOUND"') && line.includes('status="404"') && line.includes('outcome="CLIENT_ERROR"')));
  // Las sondas cuentan en la métrica pero no abren traza.
  assert.ok(counts.some((line) => line.includes('uri="/livez"')));
  const spans = await exportedSpans();
  const server = spans.find((span) => span.name === 'GET /api/v1/products/{id}');
  assert.ok(server && server.traceId === CALLER_TRACE && server.kind === 2, 'SERVER, en la traza del llamante');
  assert.ok(!spans.some((span) => span.name.includes('/livez')), 'una sonda no abre traza');
  // El scrape se sirve en el puerto principal fuera de production, en OpenMetrics (lo que lleva los exemplars).
  const scraped = await fastify.inject({ method: 'GET', url: METRICS_TRANSPORT.scrapePath });
  assert.equal(scraped.statusCode, 200);
  assert.match(scraped.headers['content-type'], /^application\/openmetrics-text/);
  assert.match(scraped.body, /# EOF\n?$/);
  await fastify.close();
});

test('un evento: la envoltura lleva el traceparent de la petición, el relay lo continúa al publicar y el consumo al recibir', async () => {
  const { EventEnvelope } = await load('src/infrastructure/messaging/event-envelope.ts');
  const { EventMetadata } = await load('src/domain/events/event-metadata.ts');
  const { runInbound } = await load('src/infrastructure/messaging/inbound-context.ts');
  const metadata = new EventMetadata('evt-1', 'ProductCreated', 1, new Date(), plan.model.service.name, null, null);
  // Dentro de la petición: el traceparent estampado es el de la traza en curso.
  let stamped = null;
  await telemetry.observe(OBSERVATIONS.useCase, { name: 'CreateProductCommand', labels: { [ATTRIBUTES.operation]: 'CreateProductCommand' }, parent: telemetry.contextFrom(CALLER) }, async () => {
    stamped = EventEnvelope.of(metadata, { id: 1 }, 'pedido-42').metadata;
  });
  assert.match(stamped.traceparent, new RegExp(`^00-${CALLER_TRACE}-[0-9a-f]{16}-01$`));
  // El relay publica en otro instante: continúa la traza de la fila.
  await telemetry.publishing('ProductCreated', stamped.traceparent, async () => {});
  // El consumidor: runInbound abre la correlación de origen y continúa la traza del emisor.
  let correlation = null;
  const { CorrelationContext } = await load('src/infrastructure/correlation/correlation-context.ts');
  await runInbound(stamped, async () => {
    correlation = CorrelationContext.get();
  });
  assert.equal(correlation, 'pedido-42');
  const spans = await exportedSpans();
  const producer = spans.find((span) => span.name === 'ProductCreated publish');
  const consumer = spans.find((span) => span.name === 'ProductCreated consume');
  assert.ok(producer && producer.kind === 4 && producer.traceId === CALLER_TRACE, 'PRODUCER en la traza de la petición');
  assert.ok(consumer && consumer.kind === 5 && consumer.traceId === CALLER_TRACE, 'CONSUMER en la misma traza');
  for (const observation of [OBSERVATIONS.outboxPublish, OBSERVATIONS.messageConsume]) {
    const counts = await scrape(promMetric(observation).count);
    assert.ok(counts.some((line) => line.includes(`${promTag(ATTRIBUTES.eventType)}="ProductCreated"`)), `${observation}: ${counts.join(' | ')}`);
  }
});

test('una llamada saliente: propaga la traza al proveedor y mide http_client_requests_seconds con la plantilla', async () => {
  const seen = [];
  const provider = http.createServer((request, response) => {
    seen.push(request.headers.traceparent);
    response.writeHead(request.url.startsWith('/fail') ? 503 : 200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const { exchange } = await load('src/infrastructure/clients/http-exchange.ts');
  const client = { id: 'pricing', baseUrl: `http://127.0.0.1:${provider.address().port}`, timeoutMs: 2000, headers: {} };
  await telemetry.observe(OBSERVATIONS.useCase, { name: 'X', labels: { [ATTRIBUTES.operation]: 'X' }, parent: telemetry.contextFrom(CALLER) }, async () => {
    await exchange(client, { method: 'GET', path: '/prices/{sku}', params: { sku: 'ABC-1' } });
    await assert.rejects(exchange(client, { method: 'GET', path: '/fail/{sku}', params: { sku: 'ABC-1' } }));
  });
  provider.close();
  assert.ok(seen.every((value) => typeof value === 'string' && value.startsWith(`00-${CALLER_TRACE}-`)), seen.join(','));
  const counts = await scrape(promMetric('http.client.requests').count);
  assert.ok(counts.some((line) => line.includes('uri="/prices/{sku}"') && line.includes('status="200"') && line.includes('client_name="pricing"') && line.includes('outcome="SUCCESS"')), counts.join('\n'));
  assert.ok(counts.some((line) => line.includes('uri="/fail/{sku}"') && line.includes('status="503"') && line.includes('outcome="SERVER_ERROR"')));
  assert.ok(!counts.some((line) => line.includes('ABC-1')), 'la plantilla, nunca la URL con sus valores');
});

test('el storage: el puerto observado con la operación y el bucket lógico; la key no sale nunca', async () => {
  const port = {
    async upload(bucket, key) {
      return { bucket, key };
    },
    publicUrl(bucket, key) {
      return `https://cdn/${bucket}/${key}`;
    }
  };
  const observed = instrumentStorage(port);
  assert.notEqual(observed, port, 'con el interruptor encendido (default), el puerto se entrega observado');
  assert.deepEqual(await observed.upload('product-images', 'personas/ana.png'), { bucket: 'product-images', key: 'personas/ana.png' });
  assert.equal(observed.publicUrl('product-images', 'x.png'), 'https://cdn/product-images/x.png', 'lo síncrono pasa tal cual');
  const counts = await scrape(promMetric(OBSERVATIONS.storage).count);
  assert.ok(counts.some((line) => line.includes(`${promTag(ATTRIBUTES.storageOperation)}="upload"`) && line.includes(`${promTag(ATTRIBUTES.storageBucket)}="product-images"`)), counts.join('\n'));
  assert.ok(!(await telemetry.registry.metrics()).includes('ana.png'));
});

test('la caché: cache_gets_total{cache,result}, la serie del ratio de acierto del panel', async () => {
  telemetry.cacheGet('catalog:get-product-by-slug', true);
  telemetry.cacheGet('catalog:get-product-by-slug', false);
  const lines = await scrape('cache_gets_total');
  assert.ok(lines.some((line) => line.includes('cache="catalog:get-product-by-slug"') && line.includes('result="hit"')));
  assert.ok(lines.some((line) => line.includes('result="miss"')));
});

test('el gauge del outbox se lee en cada scrape', async () => {
  let rendidas = 0;
  telemetry.gauge('keel.outbox.dead_lettered', 'rendidas', async () => rendidas);
  rendidas = 3;
  assert.deepEqual(await scrape('keel_outbox_dead_lettered '), ['keel_outbox_dead_lettered 3']);
});

test('el logger: con una traza en curso, cada línea lleva trace.id y span.id, y sale también por OTLP', async () => {
  const { KeelLogger } = await load('src/infrastructure/logging/keel-logger.ts');
  const lines = [];
  const logger = new KeelLogger({ ...KeelLogger.from(configuration, telemetry).options, write: (line) => lines.push(line) });
  await telemetry.observe(OBSERVATIONS.useCase, { name: 'L', labels: { [ATTRIBUTES.operation]: 'L' }, parent: telemetry.contextFrom(CALLER) }, async () => {
    logger.log('dentro de la traza', 'UseCaseMediator');
  });
  const line = JSON.parse(lines[0]);
  assert.equal(line.trace.id, CALLER_TRACE);
  assert.match(line.span.id, /^[0-9a-f]{16}$/);
  await telemetry.flush();
  const logs = received.filter((entry) => entry.path === '/v1/logs').flatMap((entry) => entry.body.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords)));
  const record = logs.find((candidate) => candidate.body?.stringValue === 'dentro de la traza');
  assert.ok(record && record.traceId === CALLER_TRACE, 'el registro OTLP lleva la traza');
});

test('telemetry.yaml usa las MISMAS variables y defaults que el de keel-spring (salvo el push de métricas, que keel-nest no tiene)', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
  // Las del push OTLP de métricas: una salida apagada por defecto en keel-spring que keel-nest no ofrece.
  const PUSH_ONLY = new Set([METRICS_TRANSPORT.otlp.envVar, 'METRICS_EXPORT_STEP', 'METRICS_OTLP_HISTOGRAM_FLAVOR']);
  const variables = (text) =>
    [...text.matchAll(/\$\{([A-Z_]+):?([^}$]*)/g)].map(([, name, value]) => `${name}=${value}`).filter((entry) => !PUSH_ONLY.has(entry.split('=')[0])).sort();
  for (const profile of ['local', 'develop', 'production']) {
    const nest = byPath[`config/parameters/${profile}/telemetry.yaml`];
    const fromSpring = spring.find((file) => file.path.endsWith(`/parameters/${profile}/telemetry.yaml`)).content;
    const fromSpringManagement = spring.find((file) => file.path.endsWith(`/parameters/${profile}/management.yaml`))?.content ?? '';
    const springVariables = new Set([...variables(fromSpring), ...variables(fromSpringManagement).filter((entry) => entry.startsWith('MANAGEMENT_PORT='))]);
    assert.deepEqual(variables(nest), [...springVariables].sort(), profile);
  }
  // Un interruptor por subsistema que el diseño trae, ni uno más.
  for (const entry of Object.values(INSTRUMENTATION)) {
    const declared = byPath['config/parameters/develop/telemetry.yaml'].includes(entry.envVar);
    assert.equal(declared, ['cache', 'storage'].includes(entry.id), entry.id);
  }
});

test('production: el scrape vive en el puerto de gestión, no en el principal', async () => {
  const yaml = byPath['config/parameters/production/telemetry.yaml'];
  assert.match(yaml, /management:\n {2}server:\n(?: {4}#.*\n)* {4}port: \$\{MANAGEMENT_PORT:8081\}/);
  assert.doesNotMatch(byPath['config/parameters/develop/telemetry.yaml'], /MANAGEMENT_PORT/);
});

test('la convención de observabilidad se instala solo con telemetría', () => {
  assert.ok('docs/keel/conventions/observability.md' in byPath);
  assert.ok(!planFixture(SUBJECT, { stack: { ...STACK, telemetry: 'none' } }).files.some((file) => file.path.endsWith('conventions/observability.md')));
});
