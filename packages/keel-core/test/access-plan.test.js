// La autorización de la entrada HTTP es UNA decisión para los dos generadores (gen/access-plan.js): lo
// que exige cada regla y qué rutas van a la cadena que comprueba la audiencia. Aquí se ata a la
// traducción que ya escribe keel-spring (`accessAuthority`, en el modelo) y se miden las tres formas
// del plan: una sola cadena, cadena de máquinas aparte, y todo abierto.

import test from 'node:test';
import assert from 'node:assert/strict';
import { accessRequirement, accessPlan, TECHNICAL_OPEN_PATHS } from '../src/lib/gen/access-plan.js';
import { accessAuthority } from '../src/lib/gen/model.js';

/** Lee la llamada de Spring Security como el mismo dato que da accessRequirement. */
function fromSpring(call) {
  if (call === 'permitAll()') return { kind: 'public', authorities: [] };
  if (call === 'authenticated()') return { kind: 'authenticated', authorities: [] };
  const match = /^(hasAnyRole|hasAnyAuthority|hasRole)\((.*)\)$/.exec(call);
  assert.ok(match, call);
  const values = JSON.parse(`[${match[2]}]`);
  return { kind: 'anyOf', authorities: match[1] === 'hasAnyAuthority' ? values : values.map((role) => `ROLE_${role}`) };
}

const RULES = [
  { level: 'public' },
  { level: 'required' },
  { level: 'service' },
  { level: 'admin' },
  { level: 'admin', roles: ['ops'] },
  { level: 'required', roles: ['a', 'b'] },
  { level: 'required', permissions: ['card:self'] },
  { level: 'service', scopes: ['product:read'] },
  { level: 'required', roles: ['a'], permissions: ['x:y'], scopes: ['s:t'] },
  { level: 'required', roles: ['a'], scopes: ['s:t'] }
];

test('lo que exige cada regla es lo mismo que la cadena de Spring', () => {
  for (const rule of RULES) {
    const expected = fromSpring(accessAuthority(rule));
    const actual = accessRequirement(rule);
    assert.equal(actual.kind, expected.kind, JSON.stringify(rule));
    assert.deepEqual([...actual.authorities].sort(), [...expected.authorities].sort(), JSON.stringify(rule));
  }
});

function modelWith(matchers, { validateAudience = true, serviceAuthProtocol = 'client-credentials', protocol = 'oidc', defaultRule = { level: 'required' } } = {}) {
  return {
    service: { artifactId: 'ticket-desk' },
    layersPresent: { security: true },
    security: {
      protocol,
      matchers: matchers.map(([method, path, audience, access]) => ({ method, path, audience, access })),
      defaultRule: { roles: [], permissions: [], scopes: [], ...defaultRule },
      serviceAuth: { protocol: serviceAuthProtocol, validateAudience, audience: null },
      serviceClients: [{ name: 'billing', scopes: ['ticket:read'] }]
    }
  };
}

const machine = ['GET', '/api/v1/prices/{id}', 'services', { level: 'service', scopes: ['ticket:read'] }];
const user = ['POST', '/api/v1/tickets', 'users', { level: 'required', roles: ['agent'] }];

test('rutas de los dos públicos con audiencia: la de máquinas es una cadena aparte, primero', () => {
  const plan = accessPlan(modelWith([machine, user]));
  assert.equal(plan.audience, 'ticket-desk');
  assert.equal(plan.chains.length, 2);
  const [machines, main] = plan.chains;
  assert.deepEqual(machines.paths, ['/api/v1/prices/{id}']);
  assert.equal(machines.checksAudience, true);
  // Su cierre es «autenticado», no el del diseño, y no abre las sondas.
  assert.deepEqual(machines.fallback, { kind: 'authenticated', authorities: [] });
  assert.ok(!machines.rules.some((rule) => TECHNICAL_OPEN_PATHS.includes(rule.path)));
  assert.equal(main.paths, null);
  assert.equal(main.checksAudience, false);
  assert.deepEqual(main.rules.slice(0, TECHNICAL_OPEN_PATHS.length).map((rule) => rule.path), TECHNICAL_OPEN_PATHS);
  assert.deepEqual(main.rules.at(-1), { method: 'POST', path: '/api/v1/tickets', requirement: { kind: 'anyOf', authorities: ['ROLE_agent'] } });
});

test('todas las rutas de máquinas: una sola cadena, que comprueba la audiencia', () => {
  const plan = accessPlan(modelWith([machine]));
  assert.equal(plan.chains.length, 1);
  assert.equal(plan.chains[0].checksAudience, true);
});

test('sin rutas de máquinas, sin validateAudience o con claves por cliente, no se comprueba la audiencia', () => {
  for (const model of [
    modelWith([user]),
    modelWith([machine, user], { validateAudience: false }),
    modelWith([machine, user], { serviceAuthProtocol: 'api-key' })
  ]) {
    const plan = accessPlan(model);
    assert.equal(plan.audience, null);
    assert.equal(plan.chains.length, 1);
    assert.equal(plan.chains[0].checksAudience, false);
  }
  assert.equal(accessPlan(modelWith([machine, user], { serviceAuthProtocol: 'api-key' })).serviceApiKeys, true);
});

test('el cierre es el access.default del diseño; los POST abiertos de otra capa van tras las sondas', () => {
  const plan = accessPlan(modelWith([user], { defaultRule: { level: 'admin' } }), { extraOpenPosts: ['/payments/notices'] });
  assert.deepEqual(plan.chains[0].fallback, { kind: 'anyOf', authorities: ['ROLE_admin'] });
  assert.deepEqual(plan.chains[0].rules[TECHNICAL_OPEN_PATHS.length], { method: 'POST', path: '/payments/notices', requirement: { kind: 'public', authorities: [] } });
});

test('protocolo none: todo abierto; sin capa security: sin plan', () => {
  assert.deepEqual(accessPlan(modelWith([user], { protocol: 'none' })), { protocol: 'none', open: true, chains: [] });
  assert.equal(accessPlan({ ...modelWith([user]), layersPresent: {} }), null);
});
