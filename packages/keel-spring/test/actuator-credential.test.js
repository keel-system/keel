// La credencial con la que el arnés lee el actuator SATISFACE la regla de cierre del diseño.
//
// `metrics` no tiene matcher propio: cae en `anyRequest()`, que es el `access.default` del diseño.
// El arnés daba por hecho `authenticated()` y usaba el primer rol; con
// `default: { level: admin, roles: [notifications-admin] }` ese primer rol era
// `application-operator` (orden alfabético), el actuator respondía 403 y `queryCount()` tumbaba
// los escenarios de coste sin decir nada del servicio (corrida notifications, 2026-09-30).
//
// Los roles se eligen para que el bueno NO sea el primero alfabéticamente: si lo fuera, el test
// pasaría también con el defecto.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');

function harnessWith(access, extra = {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'oauth2', audience: 'catalog-api' }
    },
    access: { rules: { createProduct: { roles: ['editor'] } }, ...access },
    serviceClients: { billing: { scopes: ['catalog:write'] }, auditor: { scopes: ['catalog:audit'] } },
    ...extra
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const { files } = planService({
    manifest: patchedManifest,
    layers: patched,
    workspace: fixtureDir,
    stack: { auth: 'keycloak', database: 'postgresql' }
  });
  const harness = files.find((f) => f.path.endsWith('/AbstractFlowIT.java'));
  assert.ok(harness, 'no se generó AbstractFlowIT.java');
  const call = /Response response = (get\("\/actuator\/metrics\/hibernate\.statements[^;]*);/.exec(harness.content);
  assert.ok(call, 'no se encontró la lectura de hibernate.statements');
  return call[1];
}

test('cierre por ROL: se usa el rol que la regla nombra, no el primero', () => {
  const call = harnessWith({ default: { level: 'admin', roles: ['zz-admin'] } });
  assert.match(call, /tokenFor\("zz-admin"\)/, call);
});

test('cierre por PERMISO: se usa un rol que lo otorga (roleGrants)', () => {
  const call = harnessWith(
    { default: { level: 'required', permissions: ['catalog:govern'] } },
    {
      permissions: { 'catalog:govern': { description: 'Gobierna el catálogo.' } },
      roles: { editor: { description: 'Edita.' }, 'zz-governor': { description: 'Gobierna.' } },
      roleGrants: { 'zz-governor': ['catalog:govern'] }
    }
  );
  assert.match(call, /tokenFor\("zz-governor"\)/, call);
});

test('cierre por SCOPE: se usa el cliente máquina que lo tiene', () => {
  const call = harnessWith({ default: { level: 'required', scopes: ['catalog:audit'] } });
  assert.match(call, /serviceCredential\("auditor"\)/, call);
});

test('cierre authenticated(): vale la primera credencial', () => {
  const call = harnessWith({ default: { level: 'required' } });
  assert.match(call, /tokenFor\("editor"\)/, call);
});

test('queryExecutions() existe junto a queryCount() y pide la métrica con la MISMA credencial', () => {
  // El coste de una lectura dentro de un comando que escribe (FL-NTF-040 en la corrida
  // notifications): con queryCount() contaban también los INSERT de la colección.
  const { manifest, layers } = loadService(fixtureDir);
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc' },
    access: { default: { level: 'admin', roles: ['zz-admin'] }, rules: { createProduct: { roles: ['editor'] } } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const { files } = planService({ manifest: patchedManifest, layers: patched, workspace: fixtureDir, stack: { auth: 'keycloak', database: 'postgresql' } });
  const harness = files.find((f) => f.path.endsWith('/AbstractFlowIT.java')).content;
  assert.match(harness, /protected long queryExecutions\(\)/);
  assert.ok(
    harness.includes('get("/actuator/metrics/hibernate.query.executions", tokenFor("zz-admin"))'),
    'queryExecutions() no usa la credencial de la regla de cierre'
  );
});
