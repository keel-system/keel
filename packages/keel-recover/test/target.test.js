// `keel-recover target` y la siembra de personas de `parity` (inc. 9). El target sale del deploy/ que emiten de verdad
// los TRES generadores para la fixture conduit —recuperada de RealWorld—, y tiene que decir lo mismo que el
// `target-conduit-dotnet.yaml` que se escribió a mano en el laboratorio (salvo el contenedor de herramientas, que ahora
// crea y borra parity). La siembra se mide con un runtime falso que hace de kcadm.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from 'keel-core';
import { planTarget } from '../src/lib/target.js';
import { seedPersona } from '../src/lib/parity-target.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', '..', '..', 'fixtures', 'designs');
const STACK = { database: 'mongodb', auth: 'keycloak', broker: null, cache: null, storage: null, paymentGateway: null, telemetry: 'none' };

async function deployOf(generator) {
  const { planService } = await import(`../../${generator}/src/scaffold/index.js`);
  const { manifest, layers } = loadService(path.join(FIXTURES, 'conduit'));
  const files = planService({ manifest, layers, workspace: FIXTURES, stack: STACK }).files;
  const read = (suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
  return { compose: YAML.parse(read('deploy/docker-compose.yaml')), realm: JSON.parse(read('deploy/keycloak/realm-export.json')) };
}

// Los nombres de podman-compose, que son los del laboratorio.
const podmanCompose = (project) => (service) => `${project}_${service}_1`;

for (const [generator, tech] of [['keel-dotnet', 'dotnet'], ['keel-nest', 'nest'], ['keel-spring', 'spring']]) {
  test(`${generator}: el target de conduit sale de su deploy/, como el del laboratorio`, async () => {
    const { compose, realm } = await deployOf(generator);
    const project = `conduit-${tech}-deploy`;
    const { doc, errors } = planTarget({
      compose,
      realm,
      name: `conduit-${tech}`,
      projectRel: `services/conduit-${tech}`,
      containerOf: podmanCompose(project),
      networkOf: () => [`${project}_keel-conduit-deploy`]
    });
    assert.deepEqual(errors, []);
    assert.equal(doc.base, 'http://app:8080');
    assert.deepEqual(doc.tool, { container: `keel-recover-tool-conduit-${tech}`, network: `${project}_keel-conduit-deploy` });
    assert.deepEqual(doc.database, { container: `${project}_db_1`, tech: 'mongodb', name: 'conduit', auth: { user: 'conduit', password: 'changeme', authDb: 'admin' } });
    assert.equal(doc.idp.tokenUrl, 'http://keycloak:8080/realms/conduit/protocol/openid-connect/token');
    assert.equal(doc.idp.clientId, `conduit-${tech}-test`);
    assert.equal(doc.idp.password, 'password');
    assert.deepEqual(doc.idp.seed, { container: `${project}_keycloak_1`, realm: 'conduit', admin: { user: 'admin', password: 'admin' } });
  });
}

test('un deploy sin levantar, o con otra base, es un error que lo dice', async () => {
  const { compose, realm } = await deployOf('keel-dotnet');
  const down = planTarget({ compose, realm, name: 'conduit-dotnet', projectRel: 'x', containerOf: () => null, networkOf: () => [] });
  assert.match(down.errors.join('\n'), /no hay contenedor del servicio 'app'.*bash deploy\/up\.sh/);
  const postgres = { ...compose, services: { ...compose.services, db: { ...compose.services.db, image: 'postgres:17' } } };
  const other = planTarget({ compose: postgres, realm, name: 'c', projectRel: 'x', containerOf: () => 'c', networkOf: () => ['n'] });
  assert.match(other.errors.join('\n'), /postgres:17: la paridad solo sabe vaciar MongoDB/);
});

/** Un kcadm falso: guarda los usuarios del realm y registra cada llamada. */
function fakeKeycloak(existing = []) {
  const users = new Set(existing);
  const calls = [];
  const rt = {
    exec: (container, args) => {
      calls.push([container, ...args.slice(1)].join(' '));
      const [, verb, what] = args;
      if (verb === 'get' && what === 'users') {
        const name = args[args.indexOf('-q') + 1].split('=')[1];
        return { status: 0, stdout: users.has(name) ? `[ { "username" : "${name}" } ]` : '[ ]', stderr: '' };
      }
      if (verb === 'create' && what === 'users') users.add(args.find((a) => a.startsWith('username=')).split('=')[1]);
      return { status: 0, stdout: '', stderr: '' };
    }
  };
  return { rt, users, calls };
}

test('parity da de alta a cada persona una vez, abre la sesión de administración una vez, y respeta la que ya existe', () => {
  const seed = { container: 'kc', realm: 'conduit', admin: { user: 'admin', password: 'admin' } };
  const { rt, users, calls } = fakeKeycloak(['bob']);
  const session = { open: false };
  for (const name of ['alice', 'bob']) assert.deepEqual(seedPersona(rt, seed, name, 'password', session), { ok: true });
  assert.deepEqual([...users].sort(), ['alice', 'bob']);
  assert.equal(calls.filter((c) => c.includes('config credentials')).length, 1, 'una sola sesión');
  assert.equal(calls.filter((c) => c.startsWith('kc create users')).length, 1, 'bob ya existía');
  assert.equal(calls.filter((c) => c.includes('set-password')).length, 2, 'la contraseña se fija siempre: es la del target');
});

test('una administración que falla para con su motivo, sin pedir tokens a ciegas', () => {
  const seed = { container: 'kc', realm: 'conduit', admin: { user: 'admin', password: 'mala' } };
  const rt = { exec: () => ({ status: 1, stdout: '', stderr: 'Invalid user credentials' }) };
  const r = seedPersona(rt, seed, 'alice', 'password');
  assert.equal(r.ok, false);
  assert.match(r.error, /no se pudo administrar el realm en kc: Invalid user credentials/);
});

test('characterize dice UNA vez que falta el snapshot, antes del primer flujo', async () => {
  const { legacyContext } = await import('../src/lib/characterize-legacy.js');
  const prep = {
    map: { legacy: {} },
    sandbox: {
      dir: path.join('legacy', 'stock', 'sandbox'),
      spec: { tool: { service: 'tool' }, database: { service: 'db', name: 'stock' }, app: { base: 'http://app:3000' } },
      compose: { services: { tool: { container_name: 'rec-stock-tool' }, db: { container_name: 'rec-stock-db' } } }
    }
  };
  const runtime = (snapshot) => ({ exec: (container, args) => ({ status: args[0] === 'test' && !snapshot ? 1 : 0, stdout: '', stderr: '' }) });
  assert.deepEqual(legacyContext(prep, runtime(true)).preflight(), { ok: true });
  const missing = legacyContext(prep, runtime(false)).preflight();
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no hay snapshot en rec-stock-db:\/tmp\/recover-snapshot\.archive .*keel-recover verify legacy\/stock\/sandbox --no-up/);
});
