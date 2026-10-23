import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { comparable, normalizer } from '../src/lib/normalize.js';
import { actuatorRoutes, expressRoutes, parseSpringPredicate, springHandler, springLogRoutes } from '../src/lib/routes.js';
import { dbDiff, fromExtendedJson, parseShellDoc, shapeCollection, tojsonToJson } from '../src/lib/db/mongodb.js';
import { shapeTopology, traceToMessage } from '../src/lib/rabbit.js';
import { journalEntry } from '../src/lib/stubs.js';
import { mailEntry } from '../src/lib/mail.js';
import { buildParallel, parseCurlOutput, parseParallelOutput } from '../src/lib/tool-http.js';
import { channelsCriterion, fill, loadRound, outcomeKey, pick, runRound, verifyCriterion } from '../src/lib/probe.js';
import { mergeSurface } from '../src/lib/introspect.js';
import { istanbulUncovered, jacocoUncovered, v8Uncovered } from '../src/lib/coverage.js';
import { loadSandbox } from '../src/lib/sandbox.js';
import { validateDoc } from '../src/lib/schema.js';

// Paso 1 sin contenedores: cada pieza pura de introspect y probe. La red en vivo, con los canales
// de verdad y un sabotaje por canal, es `npm run probe-check`.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sandbox', 'node-effects');

// ── normalización ────────────────────────────────────────────────────────────────────────────

const jwt = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.firma-${claims.iat}`;

test('normalización: el JWT por sus claims sin iat/exp, ids por orden y el _id de Mongo también', () => {
  const a = '6ada29daa9a21c74956e888f';
  const b = '6ada29daa9a21c74956e8890';
  const rec = {
    steps: [{ response: { _timeSeconds: 0.123, body: { id: a, token: jwt({ sub: 'ana', iat: 1, exp: 2 }), at: '2026-10-22T10:00:00.000Z' } } }],
    effects: { db: { orders: { added: [{ _id: a, ref: b, createdAt: 1761127200000 }] } } },
    other: jwt({ sub: 'ana', iat: 5, exp: 9 }),
  };
  const n = normalizer()(rec);
  assert.equal(n.steps[0].response.body.id, '<oid#1>');
  assert.equal(n.effects.db.orders.added[0]._id, '<oid#1>', 'el _id de Mongo se normaliza: no es una clave de medida');
  assert.equal(n.effects.db.orders.added[0].ref, '<oid#2>');
  assert.equal(n.effects.db.orders.added[0].createdAt, '<epoch-ms>');
  assert.equal(n.steps[0].response.body.at, '<date>');
  assert.equal(n.steps[0].response.body.token, n.other, 'dos tokens del mismo usuario en segundos distintos son el mismo');
  assert.equal(n.steps[0].response._timeSeconds, 0.123, 'la medida se graba tal cual');
  assert.equal(comparable(n).steps[0].response._timeSeconds, undefined, 'y no se compara');
});

test('normalización: las reglas propias del legacy, con sustitución fija o etiqueta', () => {
  const n = normalizer([
    { pattern: '-[a-z0-9]{6}$', replace: '-<slug>' },
    { pattern: 'tx-\\d+', replace: 'tag' },
  ]);
  assert.deepEqual(n({ slug: 'hola-mundo-x1y2z3', a: 'tx-17', b: 'tx-17', c: 'tx-18' }), { slug: 'hola-mundo-<slug>', a: '<v#1>', b: '<v#1>', c: '<v#2>' });
});

// ── rutas ────────────────────────────────────────────────────────────────────────────────────

test('rutas de Express: la tabla de la precarga, con el prefijo del router montado', () => {
  const out = expressRoutes([
    { middleware: 'jsonParser', mount: '/' },
    { method: 'POST', path: '/api/orders', handlers: ['<anonymous>'] },
    { method: 'GET', path: '/health', handlers: ['health'] },
    { method: 'GET', path: '/api/orders/:id', handlers: ['auth', 'get'] },
    { method: 'GET', path: '/x', handlers: [], mount: 'unknown' },
  ]);
  assert.deepEqual(out.routes.map((r) => `${r.method} ${r.path}`), ['POST /api/orders', 'GET /api/orders/:id', 'GET /health', 'GET /x'], 'orden por código, no por idioma');
  assert.equal(out.routes[1].handler, 'auth → get');
  assert.equal(out.routes[3].mount, 'unknown');
  assert.deepEqual(out.middleware, [{ name: 'jsonParser', mount: '/' }]);
});

test('rutas de Spring 4: las líneas Mapped del log de arranque, Spring Data REST incluido', () => {
  const log = [
    '2017-01-01 INFO 1 --- [main] s.w.s.m.m.a.RequestMappingHandlerMapping : Mapped "{[/orders],methods=[POST],produces=[application/json]}" onto public works.weave.socks.orders.entities.CustomerOrder works.weave.socks.orders.controllers.OrdersController.newOrder(works.weave.socks.orders.resources.NewOrderResource)',
    '2017-01-01 INFO 1 --- [main] o.s.d.r.w.RepositoryRestHandlerMapping : Mapped "{[/{repository}/{id}],methods=[GET],produces=[application/hal+json || application/json]}" onto public org.springframework.http.ResponseEntity<org.springframework.hateoas.Resource<?>> org.springframework.data.rest.webmvc.RepositoryEntityController.getItemResource(org.springframework.data.rest.webmvc.RootResourceInformation,java.io.Serializable)',
    'Mapped "{[/health || /healthz]}" onto public java.util.Map works.HealthCheckController.getHealth()',
    'otra línea cualquiera',
  ].join('\n');
  const { routes } = springLogRoutes(log);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path} ${r.handler}`), [
    '* /health HealthCheckController.getHealth',
    '* /healthz HealthCheckController.getHealth',
    'POST /orders OrdersController.newOrder',
    'GET /{repository}/{id} RepositoryEntityController.getItemResource',
  ]);
  assert.deepEqual(parseSpringPredicate('{[/a],methods=[GET || POST]}'), { paths: ['/a'], methods: ['GET', 'POST'] });
  assert.equal(springHandler('public void a.b.C.d()'), 'C.d');
});

test('rutas de actuator: /mappings de Boot 1.x (claves predicado) y /actuator/mappings de Boot 2+', () => {
  const v1 = actuatorRoutes({
    '/webjars/**': { bean: 'resourceHandlerMapping' },
    '{[/orders],methods=[GET]}': { bean: 'requestMappingHandlerMapping', method: 'public java.util.List x.OrdersController.list()' },
  });
  assert.deepEqual(v1.routes, [{ method: 'GET', path: '/orders', handler: 'OrdersController.list' }]);
  const v2 = actuatorRoutes({
    contexts: {
      app: {
        mappings: {
          dispatcherServlets: {
            dispatcherServlet: [
              { handler: 'x.OrdersController#create(Order)', predicate: '{POST [/orders]}', details: { requestMappingConditions: { methods: ['POST'], patterns: ['/orders'] } } },
              { handler: 'x.Health.get()', predicate: '{GET [/health], produces [application/json]}' },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(v2.routes.map((r) => `${r.method} ${r.path}`), ['GET /health', 'POST /orders']);
});

// ── MongoDB ──────────────────────────────────────────────────────────────────────────────────

test('Mongo: Extended JSON relajado (mongosh) y tojson (shell antiguo) llegan al mismo JSON plano', () => {
  const modern = parseShellDoc(
    'aviso del shell\n@@EJSON {"orders":[{"_id":{"$oid":"6ada29daa9a21c74956e888f"},"at":{"$date":"2026-10-22T10:00:00Z"},"n":{"$numberLong":"7"},"d":{"$numberDecimal":"1.5"}}]}'
  );
  const legacy = parseShellDoc(
    '@@TOJSON {"orders" : [ { "_id" : ObjectId("6ada29daa9a21c74956e888f"), "at" : ISODate("2026-10-22T10:00:00Z"), "n" : NumberLong(7), "d" : NumberDecimal("1.5") } ]}'
  );
  assert.deepEqual(modern, { orders: [{ _id: '6ada29daa9a21c74956e888f', at: '2026-10-22T10:00:00Z', n: 7, d: '1.5' }] });
  assert.deepEqual(legacy, modern);
  assert.deepEqual(fromExtendedJson({ $date: { $numberLong: '0' } }), '1970-01-01T00:00:00.000Z');
  assert.equal(tojsonToJson('Timestamp(5, 1)'), '"5:1"');
  assert.throws(() => parseShellDoc('sin marca'), /marcada/);
});

test('Mongo: el diff por _id distingue altas, bajas y cambios', () => {
  const before = { orders: [{ _id: 'a', s: 'PAID' }, { _id: 'b', s: 'PAID' }], gone: [{ _id: 'x' }] };
  const after = { orders: [{ _id: 'a', s: 'CANCELLED' }, { _id: 'c', s: 'PAID' }], fresh: [{ _id: 'y' }] };
  const d = dbDiff(before, after);
  assert.deepEqual(Object.keys(d), ['fresh', 'gone', 'orders']);
  assert.deepEqual(d.orders.added, [{ _id: 'c', s: 'PAID' }]);
  assert.deepEqual(d.orders.removed, [{ _id: 'b', s: 'PAID' }]);
  assert.deepEqual(d.orders.changed, [{ before: { _id: 'a', s: 'PAID' }, after: { _id: 'a', s: 'CANCELLED' } }]);
  assert.deepEqual(dbDiff(before, before), {});
});

test('Mongo: una columna de estado se reconoce por su forma (texto, pocos valores, más de un documento)', () => {
  const c = shapeCollection({
    name: 'orders',
    count: 3,
    sampled: 3,
    indexes: [],
    fields: [],
    values: [
      { field: 'status', values: ['CANCELLED', 'PAID'] },
      { field: 'email', values: ['a@x', 'b@x', 'c@x'] },
      { field: '_id', values: ['1', '2'] },
    ],
  });
  assert.deepEqual(c.enums, [{ field: 'status', values: ['CANCELLED', 'PAID'] }]);
  assert.equal(shapeCollection({ name: 'o', count: 1, sampled: 1, values: [{ field: 'status', values: ['PAID'] }] }).enums, undefined, 'con un documento no hay forma');
});

// ── canales ──────────────────────────────────────────────────────────────────────────────────

test('firehose: la publicación original con su origen; el cuerpo en base64 se decodifica', () => {
  const trace = (props, payload, encoding = 'string') => ({
    exchange: 'amq.rabbitmq.trace',
    routing_key: 'publish.orders',
    payload_encoding: encoding,
    payload,
    properties: { headers: { exchange_name: 'orders', routing_keys: ['order.created'], properties: props } },
  });
  const legacy = traceToMessage(trace({ content_type: 'application/json', timestamp: 1761127200 }, '{"id":"1"}'));
  assert.deepEqual(legacy, { exchange: 'orders', routingKeys: ['order.created'], _timestamp: 1761127200, origin: 'legacy', properties: { content_type: 'application/json' }, payload: { id: '1' } });
  assert.equal(traceToMessage(trace({ message_id: 'keel-recover-canary-r1-P-1-open' }, 'x')).origin, 'canary');
  assert.equal(traceToMessage(trace({ message_id: 'keel-recover-probe-P-1-1' }, Buffer.from('hola').toString('base64'), 'base64')).payload, 'hola');
});

test('topología del broker: sin lo del sistema ni la cola espía de la herramienta', () => {
  const t = shapeTopology(
    [{ name: '' }, { name: 'amq.topic', type: 'topic' }, { name: 'orders', type: 'topic', durable: true, auto_delete: false, internal: false, arguments: {} }],
    [{ name: 'keel-recover.spy', durable: true }, { name: 'shipping-task', durable: false, consumers: 1, arguments: {} }],
    [
      { source: '', destination: 'shipping-task', routing_key: 'shipping-task' },
      { source: 'amq.rabbitmq.trace', destination: 'keel-recover.spy', routing_key: 'publish.#' },
      { source: 'orders', destination: 'shipping-task', destination_type: 'queue', routing_key: 'order.*', arguments: {} },
    ]
  );
  assert.deepEqual(t, {
    exchanges: [{ name: 'orders', type: 'topic', durable: true }],
    queues: [{ name: 'shipping-task', consumers: 1 }],
    bindings: [{ source: 'orders', destination: 'shipping-task', destination_type: 'queue', routing_key: 'order.*' }],
  });
});

test('diario de WireMock y buzón de Mailpit: el canario se reconoce, el resto se graba', () => {
  const call = journalEntry({ request: { method: 'POST', url: '/payments', headers: { Host: 'payment:8080', 'Content-Type': 'application/json', 'User-Agent': 'node' }, body: '{"amount":30}' }, wasMatched: true, responseDefinition: { status: 200 } });
  assert.deepEqual(call, { method: 'POST', host: 'payment:8080', url: '/payments', headers: { 'content-type': 'application/json' }, body: { amount: 30 }, matched: true, status: 200 });
  assert.equal(journalEntry({ request: { method: 'GET', url: '/__keel-recover/canary/r1-P-1-open-h1', headers: {} } }).canary, 'r1-P-1-open-h1');

  const mail = mailEntry({ From: { Address: 'shop@x' }, To: [{ Address: 'ana@x' }], Cc: [], Subject: 'Pedido 1', Text: 'hola\r\n', HTML: '', Attachments: [] });
  assert.deepEqual(mail, { from: 'shop@x', to: ['ana@x'], subject: 'Pedido 1', text: 'hola' });
  assert.equal(mailEntry({ Subject: 'keel-recover canary r1-P-1-close', To: [] }).canary, 'r1-P-1-close');
});

test('curl desde la herramienta: estado, tiempo, cabeceras del ÚLTIMO bloque y cuerpo', () => {
  const out = '201 0.042\n<<<H\nHTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: application/json\r\nLocation: /orders/1\r\n\r\n<<<B\n{"id":"1"}';
  const r = parseCurlOutput(out);
  assert.equal(r.status, 201);
  assert.equal(r.timeSeconds, 0.042);
  assert.deepEqual(r.headers, { 'content-type': 'application/json', location: '/orders/1' });
  assert.deepEqual(r.body, { id: '1' });
  assert.equal(parseCurlOutput('000 0\n<<<H\n<<<B\n').status, 0, 'sin respuesta: estado 0, nunca un acierto');
});

// ── la ronda ─────────────────────────────────────────────────────────────────────────────────

test('ronda: el schema admite anclas x-*, pasos de publicación y clases; rechaza un paso sin request ni publish', () => {
  const ok = loadRound(path.join(fixture, 'probes', 'round-1.yaml'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.doc.probes.find((p) => p.id === 'P-002').steps[0].capture.id, 'id', 'el ancla se resuelve');
  const dir = tmpDir('recover-round-');
  const bad = path.join(dir, 'round-9.yaml');
  fs.writeFileSync(bad, YAML.stringify({ probes: [{ id: 'X', steps: [{ name: 'nada' }] }, { id: 'X', steps: [{ request: { method: 'GET', path: '/' } }] }] }));
  const r = loadRound(bad);
  assert.ok(r.errors.some((e) => /ids repetidos: X/.test(e)));
  assert.ok(r.errors.some((e) => /steps\/0/.test(e)));
});

test('ronda: plantillas, capturas y la clave del desenlace, que no depende del orden de los paralelos', () => {
  assert.deepEqual(fill({ path: '/o/{{id}}/{{nada}}', n: 3 }, { id: 'a1' }), { path: '/o/a1/', n: 3 });
  assert.equal(pick({ user: { token: 't' } }, 'user.token'), 't');
  const rec = (a, b) => ({ steps: [{ response: { status: 201 } }, { parallel: true, response: { status: a } }, { parallel: true, response: { status: b, body: { status: 'X' } } }] });
  assert.equal(outcomeKey(rec(409, 200)), outcomeKey(rec(200, 409)));
  assert.equal(outcomeKey(rec(200, 409)), '201,{200,409}');
  assert.equal(outcomeKey(rec(200, 409), 'status'), '201,{200,409}|status="X"');
});

test('curl paralelo: un solo proceso, una transferencia por petición, cabeceras como argumentos y cuerpo desde archivo', () => {
  const args = buildParallel(
    [
      { method: 'POST', url: 'http://app/a', headers: { Authorization: 'Bearer "t"' }, body: { x: 1 } },
      { method: 'PATCH', url: 'http://app/b', body: 'crudo', timeoutSeconds: 3 },
    ],
    'ab12'
  );
  assert.deepEqual(args.slice(0, 2), ['sh', '-c']);
  assert.match(args[2], /^curl -s -Z --parallel-immediate --parallel-max 2 "\$@";/);
  assert.doesNotMatch(args[2], /Bearer|app\/a/, 'nada de la petición pasa por el intérprete');
  const rest = args.slice(4);
  assert.equal(rest.filter((a) => a === '--next').length, 1);
  const [first, second] = [rest.slice(0, rest.indexOf('--next')), rest.slice(rest.indexOf('--next') + 1)];
  assert.deepEqual(first, ['-m', '15', '-D', '/tmp/kr-ab12-0.h', '-o', '/tmp/kr-ab12-0.b', '-X', 'POST', '-H', 'Authorization: Bearer "t"', '-H', 'Content-Type: application/json', '--data-binary', '@/tmp/kr-ab12-0.in', 'http://app/a']);
  assert.deepEqual(second, ['-m', '3', '-D', '/tmp/kr-ab12-1.h', '-o', '/tmp/kr-ab12-1.b', '-X', 'PATCH', '--data-binary', '@/tmp/kr-ab12-1.in', 'http://app/b'], 'un cuerpo de texto va sin Content-Type forzado');

  const out = [
    '<<<R 0',
    'HTTP/1.1 100 Continue',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    '<<<B',
    '{"ok":true}',
    '<<<R 1',
    '<<<B',
    '',
  ].join('\n');
  const [a, b] = parseParallelOutput(out, 2);
  assert.equal(a.status, 200, 'vale el último bloque de cabeceras');
  assert.deepEqual(a.body, { ok: true });
  assert.equal(a.headers['content-type'], 'application/json');
  assert.equal(b.status, 0, 'sin respuesta (timeout o conexión rechazada)');
  assert.equal(parseParallelOutput('', 1)[0].status, 0);
});

function effectsSandbox({ environment, verifyReport } = {}) {
  const root = tmpDir('recover-probe-');
  fs.cpSync(path.join(fixture, 'sandbox'), path.join(root, 'sandbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'environment.yaml'), YAML.stringify(environment ?? { kind: 'environment', dependencies: [] }));
  if (verifyReport) fs.writeFileSync(path.join(root, 'sandbox', 'verify.json'), JSON.stringify(verifyReport));
  const sb = loadSandbox(path.join(root, 'sandbox'));
  assert.deepEqual(sb.errors, []);
  return sb;
}

test('sandbox.yaml de la fixture del paso 1 cumple su schema, con sus cuatro canales', () => {
  const sb = effectsSandbox();
  assert.deepEqual(Object.keys(sb.spec).filter((k) => ['database', 'broker', 'stubs', 'mail'].includes(k)), ['database', 'broker', 'stubs', 'mail']);
  assert.ok(validateDoc({ ...sb.spec, mail: { ...sb.spec.mail, smtp: 'mail' } }).some((e) => /smtp/.test(e)), 'smtp sin puerto no vale');
});

test('ronda: sin verify.json en verde con snapshot no se sondea (PRB-VERIFY)', async () => {
  assert.match(verifyCriterion(effectsSandbox()).detail, /no hay verify.json/);
  assert.equal(verifyCriterion(effectsSandbox({ verifyReport: { ok: true, criteria: [] } })).ok, false, 'sin snapshot de la base');
  const green = verifyCriterion(effectsSandbox({ verifyReport: { ok: true, criteria: [], snapshot: { ok: true, hash: 'h1' } } }));
  assert.equal(green.ok, true);
  assert.equal(green.snapshotHash, 'h1');

  const calls = [];
  const rt = new Proxy({}, { get: (_, k) => (...args) => (calls.push(k), { status: 0, stdout: '', stderr: '' }) });
  const report = await runRound(effectsSandbox(), rt, { probes: [{ id: 'P', steps: [{ request: { method: 'GET', path: '/' } }] }] }, { tag: 'r' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.criteria.filter((c) => !c.ok && !c.skipped).map((c) => c.id), ['PRB-VERIFY']);
  assert.deepEqual(calls, [], 'no toca el sandbox');
});

test('ronda: los pasos paralelos salen de UN curl; el fallo parallel-exec vuelve a un exec por paso', async () => {
  const run = async (faults) => {
    const shots = [];
    const ok = { status: 0, stdout: '', stderr: '' };
    const rt = new Proxy({}, {
      get: (_, k) => (container, args = []) => {
        if (k === 'execAsync') {
          shots.push(args.includes('-Z') || String(args[2]).includes(' -Z ') ? 'paralelo' : 'uno');
          return Promise.resolve({ status: 0, stdout: '<<<R 0\nHTTP/1.1 200 OK\n\n<<<B\n\n<<<R 1\nHTTP/1.1 409 Conflict\n\n<<<B\n\n', stderr: '' });
        }
        return ok;
      },
    });
    const round = { probes: [{ id: 'C', class: 'concurrency', steps: [], then_parallel: [{ name: 'a', request: { method: 'POST', path: '/x', body: { n: 1 } } }, { name: 'b', request: { method: 'POST', path: '/x' } }] }] };
    const report = await runRound(effectsSandbox({ verifyReport: { ok: true, criteria: [], snapshot: { ok: true, hash: 'h1' } } }), rt, round, { tag: 'r', faults: new Set(faults), pollMs: 1 });
    return { shots, steps: report.recordings[0]?.recording.steps ?? [] };
  };
  const fixed = await run([]);
  assert.deepEqual(fixed.shots, ['paralelo']);
  assert.deepEqual(fixed.steps.map((s) => [s.name, s.parallel, s.response.status]), [['a', true, 200], ['b', true, 409]]);
  const sabotaged = await run(['parallel-exec']);
  assert.deepEqual(sabotaged.shots, ['uno', 'uno']);
});

test('ronda: un efecto del legacy sin canal de captura grabaría silencio (PRB-CHANNELS)', () => {
  const environment = {
    kind: 'environment',
    dependencies: [
      { kind: 'smtp', tech: 'smtp', endpoints: [{ host: 'mail', evidence: 'src/a.js:3' }], provision: { via: 'mailpit' } },
      { kind: 'http', tech: 'http', endpoints: [{ host: 'payment', evidence: 'src/a.js:4' }], provision: { via: 'wiremock' } },
    ],
  };
  const sb = effectsSandbox({ environment });
  assert.equal(channelsCriterion(sb).ok, true);
  delete sb.spec.mail;
  delete sb.spec.stubs;
  const c = channelsCriterion(sb);
  assert.equal(c.ok, false);
  assert.match(c.detail, /smtp\/smtp \(src\/a.js:3\) sin `mail`/);
  assert.match(c.detail, /http\/http \(src\/a.js:4\) sin `stubs`/);
});

// ── superficie y cobertura ───────────────────────────────────────────────────────────────────

test('superficie: la fusión conserva en qué pasada apareció cada elemento y marca lo que deja de verse', () => {
  const first = { kind: 'surface', schema: 1, http: { source: 'express', routes: [{ method: 'GET', path: '/a' }] }, broker: { tech: 'rabbitmq', exchanges: [], queues: [{ name: 'q-temp' }], bindings: [] } };
  const second = { kind: 'surface', schema: 1, http: { source: 'express', routes: [{ method: 'GET', path: '/a' }, { method: 'POST', path: '/a' }] }, broker: { tech: 'rabbitmq', exchanges: [{ name: 'orders' }], queues: [], bindings: [] }, data: { collections: [{ name: 'orders' }] } };
  const s = mergeSurface(mergeSurface(null, first, 'introspect'), second, 'round-1');
  assert.deepEqual(s.http.routes, [{ method: 'GET', path: '/a', seen: 'introspect' }, { method: 'POST', path: '/a', seen: 'round-1' }]);
  assert.deepEqual(s.broker.exchanges, [{ name: 'orders', seen: 'round-1' }]);
  assert.deepEqual(s.broker.queues, [{ name: 'q-temp', seen: 'introspect', absent: 'round-1' }], 'una cola que no sobrevive también es un hallazgo');
  assert.deepEqual(s.data.collections, [{ name: 'orders', seen: 'round-1' }]);
  assert.deepEqual(s.passes, ['introspect', 'round-1']);
  const third = mergeSurface(s, { kind: 'surface', schema: 1 }, 'round-2');
  assert.deepEqual(third.http, s.http, 'una sección que la pasada no pudo preguntar se conserva');
});

test('lo no cubierto: V8 en líneas (funciones y ramas), istanbul por línea y JaCoCo por clase', () => {
  const src = 'function a() {\n  if (x) {\n    y();\n  }\n}\nfunction b() {}\n';
  const off = (line) => src.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
  const docs = [
    { result: [{ url: 'file:///app/src/s.js', functions: [{ functionName: 'a', ranges: [{ startOffset: 0, endOffset: off(6), count: 1 }, { startOffset: off(2) + 9, endOffset: off(4) + 3, count: 0 }] }, { functionName: 'b', ranges: [{ startOffset: off(6), endOffset: off(6) + 15, count: 0 }] }] }] },
    { result: [{ url: 'file:///app/node_modules/x/i.js', functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: 1, count: 0 }] }] }] },
  ];
  assert.deepEqual(v8Uncovered(docs, '/app/src/', { '/app/src/s.js': src }), { '/app/src/s.js': ['rama en a (2-4)', 'función b (6-6)'] });
  assert.deepEqual(Object.keys(v8Uncovered(docs, null, {})), ['/app/src/s.js'], 'node_modules nunca cuenta');

  const ist = [{ '/app/src/s.js': { s: { 0: 1, 1: 0, 2: 0 }, statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 3 } }, 2: { start: { line: 3 } } } } }];
  assert.deepEqual(istanbulUncovered(ist), { '/app/src/s.js': [3] });
  const csv = 'GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED\napp,a.b,Orders,1,2,0,0,4,10\napp,a.b,Health,0,2,0,0,0,3';
  assert.deepEqual(jacocoUncovered(csv), { 'a.b.Orders': 4 });
});
