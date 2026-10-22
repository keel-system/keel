import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { loadSandbox } from '../src/lib/sandbox.js';
import { engineCriterion, staticCriteria } from '../src/lib/verify-static.js';
import { egressCriterion, probe, verify } from '../src/lib/verify.js';
import { readIstanbul, readJacocoCsv, readV8, splitDump } from '../src/lib/coverage.js';

// El juez con un doble del runtime: lo que la red en vivo (npm run verify-check) no puede falsar
// —la sonda de egreso, que con la red no interna ni se llega a ejecutar— y cada regla del inc. 1
// en aislamiento. Las imágenes son de mentira: el doble no las baja.

const PIN = '@sha256:' + 'a'.repeat(64);
const COMPOSE = {
  name: 'rec-t',
  services: {
    app: { container_name: 'rec-t-app', image: 'localhost/recover/t:sandbox', networks: { sandbox: {} } },
    db: { container_name: 'rec-t-db', image: `docker.io/library/mongo:3.4.9${PIN}`, networks: ['sandbox'] },
    tool: { container_name: 'rec-t-tool', image: `docker.io/curlimages/curl:8.10.1${PIN}`, networks: ['sandbox'] },
  },
  networks: { sandbox: { internal: true } },
};
const SPEC = {
  kind: 'sandbox',
  schema: 1,
  compose: 'compose.yaml',
  app: { service: 'app', base: 'http://conduit:3000', startup_seconds: 1 },
  tool: { service: 'tool' },
  database: { service: 'db', tech: 'mongodb', name: 'conduit' },
  coverage: { kind: 'jacoco', cli: '/opt/jacoco/jacococli.jar', classes: '/opt/app/classes' },
  judge: {
    read: { method: 'GET', path: '/api/tags', expect: [200] },
    write: { method: 'POST', path: '/api/users', body: { user: { email: 'v-{{nonce}}@x.invalid' } }, expect: [200] },
  },
};
const RUNTIME = { kind: 'runtime', services: [{ tech: 'mongodb', version: '3.4.9', via: 'circleci', evidence: '.circleci/config.yml:7' }] };

function writeSandbox({ compose = COMPOSE, spec = SPEC, runtime = RUNTIME, environment = { kind: 'environment', adaptations: [] } } = {}) {
  const root = tmpDir('recover-verify-');
  fs.mkdirSync(path.join(root, 'sandbox'));
  fs.writeFileSync(path.join(root, 'sandbox', 'compose.yaml'), YAML.stringify(compose));
  fs.writeFileSync(path.join(root, 'sandbox', 'sandbox.yaml'), YAML.stringify(spec));
  fs.writeFileSync(path.join(root, 'runtime.yaml'), YAML.stringify(runtime));
  fs.writeFileSync(path.join(root, 'environment.yaml'), YAML.stringify(environment));
  const sb = loadSandbox(path.join(root, 'sandbox'));
  assert.deepEqual(sb.errors, []);
  return sb;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const byId = (list, id) => list.find((c) => c.id === id);

/** Doble del runtime: un legacy sano salvo lo que cada prueba cambie. */
function fakeRuntime(over = {}) {
  let hash = 0;
  const calls = [];
  const http = over.http ?? ((method, url) => (method === 'POST' ? (hash++, [200, '{"user":{}}']) : [200, '{"tags":[]}']));
  return {
    calls,
    name: 'fake',
    compose: () => ({ status: 0, stdout: '', stderr: '' }),
    image: () => 'curl-image',
    networks: () => ['rec-t_sandbox'],
    stop: () => ({ status: 0 }),
    start: () => ({ status: 0 }),
    run: (args) => {
      calls.push(['run', ...args]);
      return over.egress ? over.egress(args) : { status: 6, stdout: '000', stderr: 'Could not resolve host' };
    },
    exec: (container, args, opts) => {
      calls.push(['exec', container, ...args]);
      if (args[0] === 'curl') {
        const method = args[args.indexOf('-X') + 1] ?? 'GET';
        const url = args[args.length - 1];
        const [status, body] = http(method, url, opts?.input);
        if (args.includes('/dev/null')) return { status: 0, stdout: String(status), stderr: '' };
        return { status: 0, stdout: `${body}\n@@STATUS ${status}`, stderr: '' };
      }
      if (args[0] === 'mongosh') return { status: 126, stdout: '', stderr: 'executable file `mongosh` not found in $PATH' };
      if (args[0] === 'mongo') return { status: 0, stdout: `md5-${hash}\n`, stderr: '' };
      if (args[0] === 'mongodump') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'java') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'cat') return { status: 0, stdout: over.csv ?? 'GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED\napp,p,A,0,0,2,1,10,5\n', stderr: '' };
      return { status: 1, stdout: '', stderr: `sin doble para ${args[0]}` };
    },
  };
}

test('un sandbox sano sale en verde y toma el snapshot', async () => {
  const report = await verify(writeSandbox(), fakeRuntime(), { pollMs: 1 });
  assert.equal(report.ok, true, JSON.stringify(report.criteria.filter((c) => !c.ok)));
  assert.equal(report.snapshot.ok, true);
  assert.deepEqual(report.coverage, { unit: 'lines', covered: 5, total: 15, files: 1, branches: { covered: 1, total: 3 } });
});

test('con salida a internet, VER-EGRESS en rojo (la parte que la red en vivo no puede falsar)', async () => {
  const report = await verify(writeSandbox(), fakeRuntime({ egress: () => ({ status: 0, stdout: '200', stderr: '' }) }), { pollMs: 1 });
  assert.equal(byId(report.criteria, 'VER-EGRESS').ok, false);
  assert.equal(report.ok, false);
  assert.equal(report.snapshot, undefined, 'en rojo no hay snapshot');
});

test('un fallo de curl que no es «no llega» no prueba el bloqueo', () => {
  const c = egressCriterion(fakeRuntime({ egress: () => ({ status: 125, stdout: '', stderr: 'container is part of a pod' }) }), 'app', 'tool', ['https://example.com']);
  assert.equal(c.ok, false);
  assert.match(c.detail, /no prueba el bloqueo/);
});

test('«sin 5xx» no basta: el 422 de RealWorld contra un Mongo 7 sale en rojo', async () => {
  const http = (method) => (method === 'POST' ? [422, '{"errors":{"username":"is already taken."}}'] : [200, '{}']);
  const report = await verify(writeSandbox(), fakeRuntime({ http }), { pollMs: 1 });
  assert.equal(byId(report.criteria, 'VER-WRITE').ok, false);
  assert.match(byId(report.criteria, 'VER-WRITE').detail, /422, se esperaba 200/);
  assert.equal(byId(report.criteria, 'VER-DB-TRACE').ok, false);
});

test('la salud del legacy no cuenta: con las consultas en 500, rojo aunque /health diga OK', async () => {
  const http = (method, url) => (url.endsWith('/health') ? [200, '{"status":"OK"}'] : [500, '{"error":"Unsupported OP_QUERY"}']);
  const report = await verify(writeSandbox(), fakeRuntime({ http }), { pollMs: 1 });
  assert.deepEqual(
    report.criteria.filter((c) => !c.ok).map((c) => c.id),
    ['VER-READ', 'VER-WRITE', 'VER-DB-TRACE']
  );
});

test('la escritura lleva un nonce nuevo: repetir el juez no choca con su propio registro', async () => {
  const rt = fakeRuntime();
  const bodies = [];
  const exec = rt.exec;
  rt.exec = (c, args, opts) => {
    if (opts?.input) bodies.push(opts.input);
    return exec(c, args, opts);
  };
  await verify(writeSandbox(), rt, { pollMs: 1, nonce: 'n1' });
  await verify(writeSandbox(), rt, { pollMs: 1, nonce: 'n2' });
  assert.deepEqual(bodies, ['{"user":{"email":"v-n1@x.invalid"}}', '{"user":{"email":"v-n2@x.invalid"}}']);
});

test('un sandbox que no pasa los estáticos no se arranca', async () => {
  const compose = clone(COMPOSE);
  compose.networks.sandbox.internal = false;
  const rt = fakeRuntime();
  let started = false;
  rt.compose = () => ((started = true), { status: 0 });
  const report = await verify(writeSandbox({ compose }), rt, { pollMs: 1 });
  assert.equal(started, false);
  assert.equal(byId(report.criteria, 'VER-NET-INTERNAL').ok, false);
  assert.ok(report.criteria.filter((c) => c.skipped).length === 6);
});

test('un estático que no es de seguridad (el motor) sale en rojo pero no impide arrancar', async () => {
  const compose = clone(COMPOSE);
  compose.services.db.image = `docker.io/library/mongo:7.0${PIN}`;
  const report = await verify(writeSandbox({ compose }), fakeRuntime(), { pollMs: 1 });
  assert.equal(byId(report.criteria, 'VER-ENGINE').ok, false);
  assert.equal(report.criteria.some((c) => c.skipped), false);
  assert.equal(byId(report.criteria, 'VER-COVERAGE').ok, true);
  assert.equal(report.ok, false);
  assert.equal(report.snapshot, undefined);
});

test('estáticos: red del host, red por defecto, imagen sin digest y build en el compose', () => {
  const compose = clone(COMPOSE);
  compose.services.app.network_mode = 'host';
  delete compose.services.tool.networks;
  compose.services.db.image = 'mongo:3.4.9';
  compose.services.extra = { build: '.', image: 'x' };
  const ids = staticCriteria(writeSandbox({ compose })).filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(ids, ['VER-NET-INTERNAL', 'VER-DIGEST', 'VER-NO-BUILD']);
});

test('motor: la versión de la CI, otra sin adaptación (rojo) y otra con adaptación que la nombra', () => {
  assert.equal(engineCriterion(writeSandbox()).ok, true);
  const compose = clone(COMPOSE);
  compose.services.db.image = `docker.io/library/mongo:7.0${PIN}`;
  const red = engineCriterion(writeSandbox({ compose }));
  assert.equal(red.ok, false);
  assert.match(red.detail, /la CI declara 3\.4\.9/);
  const justified = engineCriterion(
    writeSandbox({ compose, environment: { adaptations: [{ what: 'mongo:7.0', why: 'medido: el driver habla con 7.0' }] } })
  );
  assert.equal(justified.ok, true);
  // Sin versión en la CI (orders): la imagen elegida necesita su motivo escrito.
  const orders = engineCriterion(writeSandbox({ runtime: { services: [{ tech: 'mongodb', version: null, via: 'compose', evidence: 'docker-compose-zipkin.yml:21' }] } }));
  assert.equal(orders.ok, false);
  assert.match(orders.detail, /sin versión en la CI/);
});

test('el contenedor de la app, la herramienta y la base necesitan nombre fijo', () => {
  const compose = clone(COMPOSE);
  delete compose.services.tool.container_name;
  assert.equal(byId(staticCriteria(writeSandbox({ compose })), 'VER-COMPOSE').ok, false);
});

test('una sonda que no responde no cuenta como acierto', () => {
  const rt = fakeRuntime();
  rt.exec = () => ({ status: 7, stdout: '', stderr: 'Failed to connect' });
  const r = probe(rt, 'tool', 'http://x:1', { method: 'GET', path: '/', expect: [200] }, 'n');
  assert.equal(r.ok, false);
  assert.match(r.detail, /sin respuesta/);
});

test('cobertura: JaCoCo, istanbul (nyc) y V8, sin contar node_modules', () => {
  assert.equal(readJacocoCsv('GROUP,PACKAGE,CLASS,LINE_MISSED,LINE_COVERED\na,b,C,3,4\na,b,D,1,0\n').covered, 4);
  const ist = readIstanbul([
    { '/app/routes/a.js': { s: { 0: 1, 1: 0 } }, '/app/node_modules/x/i.js': { s: { 0: 9 } } },
    { '/app/routes/a.js': { s: { 0: 0, 1: 2 } } },
  ]);
  assert.deepEqual(ist, { unit: 'statements', covered: 2, total: 2, files: 1 });
  const v8 = readV8(
    [
      {
        result: [
          { url: 'file:///app/src/server.js', functions: [{ functionName: '', ranges: [{ startOffset: 0, count: 1 }] }, { functionName: 'f', ranges: [{ startOffset: 9, count: 0 }] }] },
          { url: 'node:internal/main', functions: [{ functionName: 'x', ranges: [{ startOffset: 0, count: 5 }] }] },
          { url: 'file:///app/node_modules/m/i.js', functions: [{ functionName: 'y', ranges: [{ startOffset: 0, count: 5 }] }] },
        ],
      },
    ],
    '/app/src/'
  );
  assert.deepEqual(v8, { unit: 'functions', covered: 1, total: 2, files: 1 });
  assert.deepEqual(splitDump('@@FILE /c/a.json\n{"a":1}\n@@FILE /c/b.json\n{}\n').map((f) => f.path), ['/c/a.json', '/c/b.json']);
});

test('sandbox.yaml que no cumple su schema no se juzga', () => {
  const sb = writeSandbox();
  const spec = clone(SPEC);
  spec.judge.write.expect = [500];
  fs.writeFileSync(sb.file, YAML.stringify(spec));
  assert.ok(loadSandbox(sb.file).errors.some((e) => /expect/.test(e)));
});
