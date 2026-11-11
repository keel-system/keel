// La prueba del contrato del token que build deja en cada proyecto. Que PASE lo mide `npm run token-check` con JDK; esto
// comprueba sin JDK qué se emite con cada proveedor y que cada sabotaje de esa red se sigue aplicando al Java de hoy.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { usesJwtConverter } from '../src/scaffold/security.js';
import { TOKEN_SABOTAGES } from '../src/lib/token-sabotages.js';
import { IDENTITY_DESIGNS } from '../../keel-core/test/helpers/identity-designs.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function emit(fixture, auth, mutate = () => {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  mutate(layers);
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return new Map(planService({ manifest, layers, workspace: '.', stack: { auth } }).files.map((file) => [file.path.split(path.sep).join('/'), file.content]));
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const find = (files, className) => [...files].find(([file]) => file.endsWith(`/${className}.java`))?.[1];
const oneToOne = IDENTITY_DESIGNS.find((design) => design.name === 'mailer-one-to-one');

test('todo proyecto con proveedor lleva su prueba; sin proveedor, ninguna', () => {
  assert.match(find(emit('asset-vault', 'cognito'), 'TokenContractTest'), /void idtNotAccessToken\(\)/);
  assert.match(find(emit('asset-vault', 'keycloak'), 'TokenContractTest'), /void idtRole\(\)/);
  assert.equal(find(emit('asset-vault', 'none'), 'TokenContractTest'), undefined);
});

test('solo con un proveedor que genera el id se traduce el cliente', () => {
  assert.ok(find(emit('asset-vault', 'cognito'), 'ServiceClientIds'));
  assert.equal(find(emit('asset-vault', 'keycloak'), 'ServiceClientIds'), undefined);
  // Con resolvedBy, la lista del recurso guarda los ids.
  assert.equal(find(emit('notification-mailer', 'cognito'), 'ServiceClientIds'), undefined);
  assert.doesNotMatch(find(emit('notification-mailer', 'cognito'), 'CallerIdentity'), /declaredName/);
  assert.match(find(emit('notification-mailer', 'cognito', oneToOne.mutate), 'CallerIdentity'), /ServiceClientIds\.declaredName\(value\)/);
});

test('el perfil test trae los ids, o el contexto de @SpringBootTest no arranca', () => {
  const files = emit('asset-vault', 'cognito');
  assert.match(files.get('src/main/resources/parameters/test/security.yaml'), /security:\n[\s\S]*client-ids:\n\s+rendering-service: opaque-id-of-rendering-service/);
});

test('el servidor con Cognito no acepta otro tipo de token ni el scope de otra API', () => {
  const converter = find(emit('asset-vault', 'cognito'), 'JwtAuthConverter');
  assert.match(converter, /"access"\.equals\(jwt\.getClaimAsString\("token_use"\)\)/);
  assert.doesNotMatch(converter, /indexOf\('\/'\)/);
});

test('un diseño sin reglas por rol también rechaza lo que no es un access token', () => {
  const security = { protocol: 'oidc', usesAuthorities: false };
  assert.equal(usesJwtConverter({ security, stack: { auth: 'cognito' } }), true);
  assert.equal(usesJwtConverter({ security, stack: { auth: 'keycloak' } }), false);
});

for (const [name, { edits }] of Object.entries(TOKEN_SABOTAGES)) {
  test(`el sabotaje ${name} se aplica al Java de hoy`, () => {
    const translated = emit('asset-vault', 'cognito');
    for (const [className, from] of edits) {
      const text = find(translated, className);
      assert.ok(text, `${name}: no se emite ${className}`);
      assert.ok(typeof from === 'string' ? text.includes(from) : from.test(text), `${name}: el texto de ${className} ya no está`);
    }
  });
}
