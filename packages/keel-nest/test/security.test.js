// La seguridad (incremento 8), EJECUTADA sin red: las reglas emitidas deciden como el plan neutral de
// keel-core (el mismo del que sale la SecurityFilterChain de keel-spring), el autenticador valida tokens
// de verdad firmados con jose, y la identidad del llamante y el alcance leen el principal de la petición.
// Lo que solo se ve con el servidor arrancado (el hook, el 401 antes de enrutar, CORS) lo miden la prueba
// emitida de la API (`npm run ts-check`) y `npm run security-check` contra un Keycloak real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { accessPlan } from 'keel-core/gen/access-plan';
import { planFixture, transpileTree } from './helpers/emitted.js';

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const SECURITY = 'src/infrastructure/security';
// asset-vault es la fixture con audiencia, CORS y alcance por recurso; sin las capas que keel-nest aún no
// genera, su seguridad es entera.
const ASSET_VAULT = { withoutLayers: ['messaging', 'storage', 'http-clients', 'dependencies'] };

function configuration(values) {
  return { get: (key) => values[key] };
}

test('profile-directory: el hook, las reglas, el JWT y la identidad; jose como dependencia', () => {
  const files = byPath(planFixture('profile-directory', { stack: { auth: 'keycloak' } }).files);
  for (const name of ['security-context', 'access-rules', 'http-security', 'jwt-authenticator', 'caller-identity']) {
    assert.ok(`${SECURITY}/${name}.ts` in files, name);
  }
  assert.match(JSON.parse(files['package.json']).dependencies.jose, /^\^6\./);
  assert.match(files['src/infrastructure/http/http-platform.ts'], /installSecurity\(fastify, app\.get<Configuration>\(CONFIGURATION\)\)/);
  // La identidad se estampa desde la credencial, nunca desde el cuerpo.
  const controller = Object.entries(files).find(([file]) => file.includes('rest/controllers/contact-card'))[1];
  assert.equal((controller.match(/callerSubject: CallerIdentity\.resolve\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(controller, /fields\['callerSubject'\]/);
  assert.ok('.claude/skills/keel-nest-keycloak/SKILL.md' in files);
});

test('la configuración usa las MISMAS variables de entorno que keel-spring, con su gradiente', () => {
  const files = byPath(planFixture('asset-vault', { ...ASSET_VAULT, stack: { auth: 'keycloak' } }).files);
  const local = files['config/parameters/local/security.yaml'];
  const develop = files['config/parameters/develop/security.yaml'];
  const production = files['config/parameters/production/security.yaml'];
  assert.match(local, /issuer-uri: http:\/\/localhost:8180\/realms\/asset-vault/);
  assert.match(develop, /issuer-uri: \$\{OAUTH2_ISSUER_URI:http:\/\/localhost:8180\/realms\/asset-vault\}/);
  assert.match(production, /issuer-uri: \$\{OAUTH2_ISSUER_URI\}/);
  assert.match(production, /audience: \$\{SECURITY_AUDIENCE\}/);
  assert.match(production, /allowed-origins: \$\{SECURITY_CORS_ALLOWED_ORIGINS\}/);
  assert.match(files['config/parameters/test/security.yaml'], /jwks: \$\{SECURITY_TEST_JWKS:\}/);
});

test('las reglas emitidas deciden lo que dice el plan neutral, cadena por cadena', async () => {
  const { files, model } = planFixture('asset-vault', { ...ASSET_VAULT, stack: { auth: 'keycloak' } });
  const { load } = transpileTree(files);
  const rules = await load(`${SECURITY}/access-rules.ts`);
  const plan = accessPlan(model);
  assert.equal(rules.CHAINS.length, plan.chains.length);
  for (const [index, chain] of plan.chains.entries()) {
    for (const rule of chain.rules.filter((candidate) => candidate.method)) {
      // Que la petición caiga en ESTA cadena depende de las anteriores: se pregunta como lo haría el hook.
      const decision = rules.decide({ method: rule.method, path: rule.path.replace(/\{[^}]+\}/g, 'x-1'), pattern: null });
      const owner = plan.chains.findIndex((candidate) => candidate.paths == null || candidate.paths.includes(rule.path));
      if (owner !== index) continue;
      const expected = chain.rules.find((candidate) => (candidate.method == null || candidate.method === rule.method) && candidate.path === rule.path);
      assert.deepEqual(decision.requirement.kind, expected.requirement.kind, `${rule.method} ${rule.path}`);
      assert.equal(decision.checksAudience, chain.checksAudience, `${rule.method} ${rule.path}`);
    }
  }
  // Un camino que no existe cae en el cierre de la cadena principal.
  const unknown = rules.decide({ method: 'GET', path: '/api/v1/no-existe', pattern: null });
  assert.deepEqual(unknown.requirement.kind, plan.chains.at(-1).fallback.kind);
  // Con patrón de ruta se compara la FORMA: los nombres de los parámetros no cuentan.
  const routed = plan.chains.flatMap((chain) => chain.rules).find((rule) => rule.method && rule.path.includes('{'));
  if (routed) {
    const byShape = rules.decide({ method: routed.method, path: '/x', pattern: routed.path.replace(/\{[^}]+\}/g, ':otro') });
    assert.equal(byShape.requirement.kind, routed.requirement.kind);
  }
  // Las sondas, abiertas; y el veredicto: anónimo → 401, sin la authority → 403.
  assert.equal(rules.decide({ method: 'GET', path: '/livez', pattern: null }).requirement.kind, 'public');
  const anyOf = { kind: 'anyOf', authorities: ['ROLE_a', 'x:y'] };
  assert.equal(rules.verdict(anyOf, null), 'unauthenticated');
  assert.equal(rules.verdict(anyOf, { authorities: new Set(['ROLE_b']) }), 'denied');
  assert.equal(rules.verdict(anyOf, { authorities: new Set(['x:y']) }), 'granted');
  assert.equal(rules.verdict({ kind: 'authenticated' }, { authorities: new Set() }), 'granted');
});

test('el autenticador valida de verdad: firma, caducidad, forma; y da las authorities de Spring', async () => {
  const { files } = planFixture('profile-directory', { stack: { auth: 'keycloak' } });
  const { load } = transpileTree(files);
  const { JwtAuthenticator, InvalidCredential } = await load(`${SECURITY}/jwt-authenticator.ts`);
  const keys = await generateKeyPair('RS256');
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' }] });
  const authenticator = JwtAuthenticator.from(configuration({ 'security.oauth2.jwks': jwks }));
  const sign = (claims, exp = '5m', key = keys.privateKey) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setExpirationTime(exp).sign(key);

  // Keycloak: roles anidados en realm_access; card-holder otorga card:self (roleGrants del diseño).
  const principal = await authenticator.authenticate(await sign({ sub: 'ana', preferred_username: 'ana', realm_access: { roles: ['card-holder'] }, scope: 'openid profile' }));
  assert.equal(principal.kind, 'token');
  assert.equal(principal.name, 'ana');
  assert.deepEqual([...principal.authorities].sort(), ['ROLE_card-holder', 'SCOPE_openid', 'SCOPE_profile', 'card:self']);

  const rejects = async (token) => assert.rejects(() => authenticator.authenticate(token), InvalidCredential);
  await rejects(await sign({ sub: 'ana' }, Math.floor(Date.now() / 1000) - 120));
  await rejects(await sign({ sub: 'ana' }, '5m', (await generateKeyPair('RS256')).privateKey));
  await rejects('no es un token');
  // Dentro del margen de reloj de Spring (60 s), un token recién caducado todavía vale.
  assert.equal((await authenticator.authenticate(await sign({ sub: 'ana' }, Math.floor(Date.now() / 1000) - 30))).name, 'ana');
  // Sin ninguna fuente de claves (el perfil test sin JWKS publicado), ningún token vale.
  await assert.rejects(() => JwtAuthenticator.from(configuration({})).authenticate(principal.name.length ? 'a.b.c' : ''), InvalidCredential);
});

test('Cognito: grupos planos, el prefijo del scope fuera, y la audiencia es ese prefijo', async () => {
  const { files } = planFixture('asset-vault', { ...ASSET_VAULT, stack: { auth: 'cognito' } });
  const { load } = transpileTree(files);
  const { JwtAuthenticator, issuedFor } = await load(`${SECURITY}/jwt-authenticator.ts`);
  const keys = await generateKeyPair('RS256');
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' }] });
  const authenticator = JwtAuthenticator.from(configuration({ 'security.oauth2.jwks': jwks }));
  const token = await new SignJWT({ sub: 'm2m', client_id: 'm2m', scope: 'asset-vault/asset:read', 'cognito:groups': ['ops'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  const principal = await authenticator.authenticate(token);
  assert.ok(principal.authorities.has('SCOPE_asset:read'));
  assert.ok(principal.authorities.has('ROLE_ops'));
  assert.equal(issuedFor(principal, 'asset-vault'), true);
  assert.equal(issuedFor(principal, 'otro-servicio'), false);
});

test('la identidad del llamante y el alcance leen el principal de la petición en curso, y solo de ahí', async () => {
  const { files } = planFixture('profile-directory', { stack: { auth: 'keycloak' } });
  const { load } = transpileTree(files);
  const { SecurityContext } = await load(`${SECURITY}/security-context.ts`);
  const { CallerIdentity } = await load(`${SECURITY}/caller-identity.ts`);
  const token = { kind: 'token', name: 'ana', authorities: new Set(), claims: { sub: 'sub-ana-001' } };
  assert.equal(SecurityContext.runWith(token, () => CallerIdentity.resolve()), 'sub-ana-001');
  assert.throws(() => CallerIdentity.resolve(), /No hay credencial/);
  assert.throws(() => SecurityContext.runWith({ ...token, claims: {} }, () => CallerIdentity.resolve()), /no identifica/);

  const vault = planFixture('asset-vault', { ...ASSET_VAULT, stack: { auth: 'keycloak' } });
  const scoping = vault.model.security.scoping;
  const tree = transpileTree(vault.files);
  const context = await tree.load(`${SECURITY}/security-context.ts`);
  const { JwtCallerScope } = await tree.load(`${SECURITY}/jwt-caller-scope.ts`);
  const scope = new JwtCallerScope();
  const holder = { kind: 'token', name: 'u', authorities: new Set(), claims: { [scoping.claim]: 'app-1, app-2' } };
  assert.equal(context.SecurityContext.runWith(holder, () => scope.covers('app-2')), true);
  assert.equal(context.SecurityContext.runWith(holder, () => scope.covers('app-3')), false);
  for (const role of scoping.exemptRoles) {
    const exempt = { ...holder, claims: {}, authorities: new Set([`ROLE_${role}`]) };
    assert.equal(context.SecurityContext.runWith(exempt, () => scope.covers('cualquiera')), true, role);
  }
  // El puerto vive en la aplicación y no importa nada: ni Nest ni el token.
  assert.doesNotMatch(byPath(vault.files)['src/application/support/caller-scope.ts'], /^import /m);
});

test('el handler que declara el error del alcance recibe CallerScope inyectado, con su nota', () => {
  const { files, model } = planFixture('asset-vault', { ...ASSET_VAULT, stack: { auth: 'keycloak' } });
  const scoped = model.services.flatMap((service) => service.operations).filter((op) => op.errors.includes(model.security.scoping.error));
  assert.ok(scoped.length > 0);
  const tree = byPath(files);
  for (const operation of scoped) {
    const handler = Object.entries(tree).find(([file]) => file.endsWith(`/${operation.handlerClass.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.ts`))[1];
    assert.match(handler, /static readonly inject = \[.*CallerScope.*\]/, operation.name);
    assert.match(handler, /this\.callerScope\.covers/, operation.name);
  }
  assert.match(tree['src/app.module.ts'], /SecurityModule/);
});

test('la infra de prueba lleva el realm del proveedor con los textos de keel-nest', () => {
  const files = byPath(planFixture('profile-directory', { stack: { auth: 'keycloak' } }).files);
  assert.match(files['infra/init-keycloak.sh'], /por keel-nest build a partir de specs\/security\.keel\.yaml/);
  assert.match(files['infra/test-credentials.env'], /^AUTH_TEST_CLIENT=profile-directory-nest-test$/m);
  assert.doesNotMatch(files['infra/init-keycloak.sh'] + files['infra/test-credentials.env'], /AbstractFlowIT|keel-spring/);
  // El arnés las lee: tokenFor y, con la identidad en el claim sub, tokenAs.
  assert.match(files['test/integration/support/flow.ts'], /export async function tokenFor\(role: string, n = 1\)/);
  assert.match(files['test/integration/support/flow.ts'], /export async function tokenAs\(sub: string/);
});
