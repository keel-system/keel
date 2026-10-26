// La sesión entre pasos y la caché entre sondas. En la corrida de control de show-ticketing (ronda 0) un legacy con
// Spring Session sobre Redis solo se pudo grabar por su 401 detrás del login (25 de 31 rutas): `probe` no reenviaba la
// cookie SESSION ni había forma de leerla, y la restauración solo devolvía MySQL, con un @Cacheable delante. Lo que se
// mide aquí, sin contenedores: las cookies de la respuesta, las sesiones de una sonda, las capturas, la normalización
// del id de sesión, el vaciado de la caché y la credencial por cookie de la caracterización.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCurlOutput, parseParallelOutput, parseSetCookies } from '../src/lib/tool-http.js';
import { captureFrom, channelsCriterion, keepSession, withSession } from '../src/lib/probe.js';
import { normalizer } from '../src/lib/normalize.js';
import { flushArgs, flushCaches } from '../src/lib/caches.js';
import { runFlow } from '../src/lib/characterize.js';

const LOGIN = [
  '200 0.02',
  '<<<H',
  'HTTP/1.1 200 \r',
  'Set-Cookie: SESSION=Zjk1YTQ2; Path=/; HttpOnly; SameSite=Lax\r',
  'Set-Cookie: theme=dark\r',
  'Content-Type: application/json\r',
  '\r',
  '<<<B',
  '{"ok":true}',
].join('\n');

test('las cookies de una respuesta: todas las líneas Set-Cookie, y la borrada como null', () => {
  assert.deepEqual(parseCurlOutput(LOGIN).cookies, { SESSION: 'Zjk1YTQ2', theme: 'dark' });
  assert.deepEqual(parseSetCookies(['SESSION=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:10 GMT; Path=/']), { SESSION: null }, 'el logout de Spring Session');
  assert.deepEqual(parseSetCookies(['a=1; Expires=Thu, 01 Jan 1970 00:00:10 GMT', 'b=2; Max-Age=3600']), { a: null, b: '2' });
  const parallel = parseParallelOutput('<<<R 0\nHTTP/1.1 200\r\nSet-Cookie: SESSION=abc; Path=/\r\n\r\n<<<B\n{}\n', 1);
  assert.deepEqual(parallel[0].cookies, { SESSION: 'abc' }, 'también en los pasos a la vez');
});

test('una sonda reenvía la cookie del login a los pasos siguientes de la misma sesión', () => {
  const jars = {};
  const login = {};
  assert.deepEqual(withSession(jars, login, {}), { headers: {}, sent: [] }, 'la sonda empieza sin sesión');
  keepSession(jars, login, { SESSION: 'abc' });
  const next = withSession(jars, {}, { Accept: 'application/json' });
  assert.deepEqual(next.headers, { Accept: 'application/json', Cookie: 'SESSION=abc' });
  assert.deepEqual(next.sent, ['SESSION']);
  keepSession(jars, {}, { SESSION: null });
  assert.deepEqual(withSession(jars, {}, {}).sent, [], 'el logout la borra');
});

test('dos personas en una sonda son dos sesiones; none va sin cookies; una Cookie propia manda', () => {
  const jars = {};
  keepSession(jars, { session: 'gestor' }, { SESSION: 'g' });
  keepSession(jars, { session: 'usuario' }, { SESSION: 'u' });
  assert.equal(withSession(jars, { session: 'gestor' }, {}).headers.Cookie, 'SESSION=g');
  assert.equal(withSession(jars, { session: 'usuario' }, {}).headers.Cookie, 'SESSION=u');
  assert.deepEqual(withSession(jars, {}, {}).sent, [], 'la sesión por defecto es otra');
  assert.deepEqual(withSession(jars, { session: 'none' }, {}).headers, {});
  keepSession(jars, { session: 'none' }, { SESSION: 'x' });
  assert.equal(jars.none, undefined, 'none tampoco guarda');
  assert.deepEqual(withSession(jars, { session: 'gestor' }, { cookie: 'SESSION=otra' }).headers, { cookie: 'SESSION=otra' });
});

test('capture lee el cuerpo, una cookie o una cabecera', () => {
  const r = { body: { user: { id: 7 } }, cookies: { SESSION: 'abc' }, headers: { location: '/users/7' } };
  assert.equal(captureFrom(r, 'user.id'), 7);
  assert.equal(captureFrom(r, 'cookie:SESSION'), 'abc');
  assert.equal(captureFrom(r, 'header:Location'), '/users/7');
  assert.equal(captureFrom(r, 'cookie:otra'), null);
});

test('el id de sesión se normaliza: dos logins iguales graban lo mismo', () => {
  const a = normalizer()({ headers: { 'set-cookie': 'SESSION=Zjk1YTQ2; Path=/; HttpOnly' } });
  const b = normalizer()({ headers: { 'set-cookie': 'SESSION=OTRO; Path=/; HttpOnly' } });
  assert.deepEqual(a, b);
  assert.equal(a.headers['set-cookie'], 'SESSION=<cookie#1>; Path=/; HttpOnly');
  assert.equal(normalizer()({ headers: { 'set-cookie': 'SESSION=; Max-Age=0' } }).headers['set-cookie'], 'SESSION=; Max-Age=0', 'la borrada sigue vacía');
});

const SANDBOX = {
  compose: { services: { 'redis-cache': { container_name: 'rec-x-redis-cache' }, 'redis-session': { container_name: 'rec-x-redis-session' } } },
  spec: { caches: [{ service: 'redis-cache', tech: 'redis' }, { service: 'redis-session', tech: 'redis', password: 's3cr3t' }] },
};

test('la restauración vacía cada caché con redis-cli, la contraseña por entorno', () => {
  const sent = [];
  const rt = { exec: (c, args) => (sent.push([c, args]), { status: 0, stdout: 'OK\n', stderr: '' }) };
  assert.deepEqual(flushCaches(rt, SANDBOX), { ok: true });
  assert.deepEqual(sent, [
    ['rec-x-redis-cache', ['redis-cli', 'FLUSHALL']],
    ['rec-x-redis-session', ['env', 'REDISCLI_AUTH=s3cr3t', 'redis-cli', 'FLUSHALL']],
  ]);
  assert.deepEqual(flushArgs({ tech: 'redis' }), ['redis-cli', 'FLUSHALL']);
  assert.deepEqual(flushCaches(rt, { compose: {}, spec: {} }), { ok: true }, 'sin caches, nada');
});

test('un vaciado que no contesta OK es un error, aunque redis-cli salga con 0', () => {
  const noauth = { exec: () => ({ status: 0, stdout: '(error) NOAUTH Authentication required.\n', stderr: '' }) };
  assert.match(flushCaches(noauth, SANDBOX).error, /no se pudo vaciar redis-cache: \(error\) NOAUTH/);
  const ghost = { ...SANDBOX, spec: { caches: [{ service: 'otro', tech: 'redis' }] } };
  assert.match(flushCaches(noauth, ghost).error, /el servicio otro no está en el compose/);
});

test('PRB-CHANNELS: una caché de environment.yaml sin `caches` en sandbox.yaml sale en rojo', () => {
  const environment = { dependencies: [{ kind: 'cache', tech: 'redis', clients: [{ evidence: 'pom.xml:76' }] }] };
  const without = channelsCriterion({ environment, spec: {} });
  assert.equal(without.ok, false);
  assert.match(without.detail, /cache\/redis .* sin `caches` en sandbox\.yaml/);
  assert.equal(channelsCriterion({ environment, spec: { caches: SANDBOX.spec.caches } }).ok, true);
});

// Un legacy en memoria con sesión por cookie: el login fija SESSION; /me la exige; el logout la borra.
function sessionLegacy() {
  const sessions = new Set();
  const requests = [];
  return {
    requests,
    http: async ({ method, url, headers }) => {
      requests.push({ method, url, cookie: headers.Cookie ?? null });
      const sid = /SESSION=([^;]+)/.exec(headers.Cookie ?? '')?.[1];
      if (url.endsWith('/login')) {
        const id = `s${sessions.size + 1}`;
        sessions.add(id);
        return { status: 200, body: {}, cookies: { SESSION: id } };
      }
      if (url.endsWith('/logout')) {
        sessions.delete(sid);
        return { status: 200, body: {}, cookies: { SESSION: null } };
      }
      return sessions.has(sid) ? { status: 200, body: { me: sid } } : { status: 401, body: null };
    },
  };
}

const SIDE = {
  auth: { cookie: 'SESSION' },
  actors: { user: { via: 'op', op: 'login', input: { userId: '{{actor}}' }, token: 'cookie:SESSION' } },
  operations: { login: { method: 'POST', path: '/login' }, me: { method: 'GET', path: '/me' }, logout: { method: 'POST', path: '/logout' } },
};

test('characterize: la credencial de un actor es su cookie de sesión, sacada del login y renovada por el logout', async () => {
  const legacy = sessionLegacy();
  const ctx = { side: SIDE, sideName: 'legacy', semantics: {}, base: 'http://app', http: legacy.http, reset: async () => ({ ok: true }), random: () => 'r' };
  const planned = {
    id: 'FL-SES-001',
    mark: 'keep',
    sha256: 'x',
    flow: {
      actors: { ana: 'user', bea: 'user' },
      steps: [
        { op: 'me', as: 'ana', expect: { status: 200, body: { me: 's1' } } },
        { op: 'me', as: 'bea', expect: { status: 200, body: { me: 's2' } } },
        { op: 'logout', as: 'ana', expect: { status: 200 } },
        { op: 'me', as: 'ana', expect: { status: 401 } },
        { op: 'me', as: 'bea', expect: { status: 200 } },
      ],
    },
  };
  const record = await runFlow(ctx, planned);
  assert.deepEqual(record.failures, []);
  assert.equal(record.ok, true);
  assert.deepEqual(legacy.requests.filter((r) => r.url.endsWith('/me')).map((r) => r.cookie), ['SESSION=s1', 'SESSION=s2', 'SESSION=', 'SESSION=s2']);
  // sin la cookie en el lado, el actor no tendría con qué entrar
  const bearer = await runFlow({ ...ctx, side: { ...SIDE, auth: {} } }, planned);
  assert.equal(bearer.ok, false);
});
