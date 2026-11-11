// Que el camino para otro proveedor de identidad exista de verdad (inc. 1.4 de PLAN-PROVEEDOR-IDENTIDAD.md). Vive en
// keel-go porque es el último generador en la cadena y el único que ya compara con los otros tres.
//
// Tres redes, cada una con la forma de su precedente: un proveedor ficticio registrado solo aquí, que genera en los
// cuatro sin tocar un generador (gen-model.test.js); la prohibición de preguntar por el nombre del proveedor fuera de
// sus módulos (gen-neutral.test.js); y la lista cerrada de lo que puede diferir entre dos proveedores
// (payment-parity.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { AUTH } from '@keel-system/keel-core/gen/infra-catalog';
import { IDENTITY_PROVIDERS } from '@keel-system/keel-core/gen/identity-providers';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planGo } from '../src/scaffold/index.js';
import { FIXTURES_DIR, makeWorkspace, mountDesign, runCommand } from './helpers/workspace.js';
import { resolveStack, writeStackConfig } from '@keel-system/keel-core/gen/stack';

const packagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATORS = { spring: planSpring, nest: planNest, dotnet: planDotnet, go: planGo };
const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

function generate(plan, fixture, auth) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return plan({ manifest, layers, workspace: '.', stack: { auth } });
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const textOf = (file) => file.content ?? fs.readFileSync(file.sourceFile, 'utf8');
const pathOf = (file) => file.path.split(path.sep).join('/');

// ─── El proveedor ficticio ───────────────────────────────────────────────────

function fakeProvider(id, token, emulation = null) {
  return {
    id,
    displayName: id,
    skill: false,
    token: { accessTokenClaims: null, customClaims: null, ...token },
    harness: { personaTokens: false, scopedTokens: false },
    provisioning: {
      kind: 'token-emulator',
      issuerPath: '/{service}',
      tokenPath: '/{service}/oauth/token',
      jwksPath: '/{service}/oauth/keys',
      internalPort: 8080,
      emulatorDir: id,
      localIssuerNote: [`Emulador de ${id} en el docker-compose.`],
      console: null,
      adminEnv: null,
      emulation
    }
  };
}

const PLAIN = fakeProvider('acme-plain', {
  claims: { type: 'flat', rolesClaim: 'acme_roles', permissionsClaim: 'acme_perms', principalClaim: 'acme_name' },
  scopes: { format: 'plain' },
  audience: { via: 'aud' },
  client: { claims: ['cid'], valueIsDeclaredName: true },
  accepted: null
});
const PREFIXED = fakeProvider('acme-prefix', {
  claims: { type: 'nested', rolesParent: 'acme', rolesField: 'groups', permissionsClaim: 'acme_perms', principalClaim: 'acme_name' },
  scopes: { format: 'resource-server-prefix' },
  audience: { via: 'scope-prefix' },
  client: { claims: ['cid'], valueIsDeclaredName: false },
  accepted: { claim: 'kind', value: 'at', rejected: 'it' }
}, { product: 'Acme IdP', shape: 'grupos anidados bajo acme', unproven: 'el alta de usuarios' });
const FAKES = [PLAIN, PREFIXED];

function catalogEntry({ id }) {
  const config = `/${id}/mock-oauth2-config.json`;
  return {
    id,
    label: `${id} (ficticio)`,
    image: 'ghcr.io/navikt/mock-oauth2-server:6.0.1',
    port: 9333,
    serviceKey: `${id}-idp`,
    cliTool: 'curl',
    cliVia: 'devtools',
    cliValidateCmd: `curl -sf http://${id}-idp:8080/isalive`,
    alpinePackages: [],
    composeServices: () => ({
      [`${id}-idp`]: {
        image: 'ghcr.io/navikt/mock-oauth2-server:6.0.1',
        environment: { JSON_CONFIG_PATH: config },
        volumes: [`./${id}/mock-oauth2-config.json:${config}:ro`],
        ports: ['9333:8080']
      }
    })
  };
}

function withFakes(body) {
  for (const provider of FAKES) {
    IDENTITY_PROVIDERS[provider.id] = provider;
    AUTH[provider.id] = catalogEntry(provider);
  }
  try {
    return body();
  } finally {
    for (const provider of FAKES) {
      delete IDENTITY_PROVIDERS[provider.id];
      delete AUTH[provider.id];
    }
  }
}

const usesTokenIdentity = (fixture) => {
  const { layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return ['oidc', 'jwt'].includes(layers.security?.authentication?.protocol ?? layers.security?.protocol);
};
const tokenFixtures = fixtures.filter(usesTokenIdentity);

test('hay fixtures con identidad por token que recorrer', () => {
  assert.ok(tokenFixtures.length >= 4, `solo ${tokenFixtures.length}: ${tokenFixtures.join(', ')}`);
});

for (const [name, plan] of Object.entries(GENERATORS)) {
  test(`${name}: un proveedor ficticio genera toda fixture sin tocar el generador`, () => {
    withFakes(() => {
      for (const provider of FAKES) {
        for (const fixture of tokenFixtures) {
          const { files, model } = generate(plan, fixture, provider.id);
          const label = `${name}/${fixture}/${provider.id}`;
          const byPath = new Map(files.map((file) => [pathOf(file), file]));

          for (const where of ['infra', 'deploy']) {
            assert.ok(byPath.has(`${where}/${provider.id}/mock-oauth2-config.json`), `${label}: sin la configuración del emulador en ${where}/`);
          }
          const emulator = JSON.parse(textOf(byPath.get(`infra/${provider.id}/mock-oauth2-config.json`)));
          const mappings = emulator.tokenCallbacks[0].requestMappings;
          const users = mappings.filter((mapping) => mapping.requestParam === 'username');
          for (const user of users) {
            const carriesRoles = provider.token.claims.type === 'nested' ? 'acme' in user.claims : provider.token.claims.rolesClaim in user.claims;
            assert.ok(carriesRoles, `${label}: el emulador no pone los roles donde los lee el proveedor`);
          }

          const compose = textOf(byPath.get('infra/docker-compose.yaml'));
          assert.ok(compose.includes(`${provider.id}-idp`), `${label}: el compose no levanta el proveedor`);
          const leaked = [...byPath.keys()].filter((file) => /\/(cognito|keycloak)\b/i.test(`/${file}`));
          assert.deepEqual(leaked, [], `${label}: archivos de otro proveedor`);
          assert.ok(tokenCases(model).length > 0, `${label}: sin casos del token`);
        }
      }
    });
  });

  test(`${name}: el servidor lee los claims del proveedor, y ninguna rama de otro proveedor se cuela`, () => {
    withFakes(() => {
      for (const provider of FAKES) {
        const { files } = generate(plan, 'asset-vault', provider.id);
        const emitted = files.filter((file) => /security|Security|auth/i.test(pathOf(file)) && /\.(java|ts|cs|go)$/.test(pathOf(file)));
        const text = emitted.map(textOf).join('\n');
        const roles = provider.token.claims.type === 'nested' ? provider.token.claims.rolesParent : provider.token.claims.rolesClaim;
        assert.ok(text.includes(roles), `${name}/${provider.id}: no lee ${roles}`);
        assert.ok(text.includes(provider.token.claims.principalClaim), `${name}/${provider.id}: no lee el principal`);
        assert.equal(/cognito/i.test(text), false, `${name}/${provider.id}: el servidor nombra a Cognito`);
      }
    });
  });
}

// ─── La prohibición ──────────────────────────────────────────────────────────

const ALLOWED_MODULES = new Set([
  path.join('keel-core', 'src', 'lib', 'gen', 'identity-providers.js'),
  path.join('keel-core', 'src', 'lib', 'gen', 'infra-catalog.js'),
  // Las combinaciones fixture × stack de la línea base: eligen un proveedor, no preguntan por él.
  path.join('keel-spring', 'src', 'lib', 'golden-digest.js'),
  path.join('keel-nest', 'src', 'lib', 'golden-digest.js')
]);

function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// `org.keycloak…` es el nombre de un componente dentro del formato del realm, no una pregunta por el proveedor.
const NAME_BRANCH = /['"](?:keycloak|cognito)['"]|(?<!\borg)\.(?:keycloak|cognito)\b|\b(?:keycloak|cognito)\s*(?:\?|&&|\|\||===|!==)/;

/** Las líneas de un módulo que preguntan por el nombre de un proveedor. */
function nameBranches(source) {
  return codeOf(source)
    .split('\n')
    .filter((line) => NAME_BRANCH.test(line));
}

function sourcesOf() {
  const roots = [path.join('keel-core', 'src', 'lib', 'gen'), ...Object.keys(GENERATORS).map((name) => path.join(`keel-${name}`, 'src'))];
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(packagesDir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) out.push(child);
    }
  };
  roots.forEach(walk);
  return out;
}

test('el detector caza una rama por nombre y deja pasar lo que no lo es', () => {
  for (const code of [
    "if (model.stack.auth === 'cognito') x();",
    'const env = AUTH.keycloak.composeServices();',
    "const skills = ['keycloak', 'cognito'];",
    'const a = cognito ? 1 : 2;'
  ]) {
    assert.equal(nameBranches(code).length, 1, code);
  }
  for (const code of [
    '// si es cognito ? eso',
    "const path = 'infra/init-keycloak.sh';",
    "const scope = 'cognito:groups';",
    "components: { 'org.keycloak.userprofile.UserProfileProvider': [] }",
    'export function cognitoMockConfig(model) {}'
  ]) {
    assert.deepEqual(nameBranches(code), [], code);
  }
});

test('nadie pregunta por el nombre del proveedor fuera de sus módulos', () => {
  const findings = [];
  for (const file of sourcesOf()) {
    if (ALLOWED_MODULES.has(file)) continue;
    for (const line of nameBranches(fs.readFileSync(path.join(packagesDir, file), 'utf8'))) findings.push(`${file}: ${line.trim().slice(0, 120)}`);
  }
  assert.deepEqual(findings, []);
});

// ─── La paridad entre proveedores ────────────────────────────────────────────

// Lo que PUEDE cambiar entre dos proveedores, y por qué.
const ALLOWED_DIFFERENCES = {
  common: [
    // Su skill, y las que nombran el stack elegido.
    /^\.[a-z]+\/skills\/keel-[a-z]+-(keycloak|cognito)\//,
    /^\.[a-z]+\/skills\/keel-generate-[a-z]+\/SKILL\.md$/,
    /^(README|AGENTS|CLAUDE)\.md$/,
    // Lo que el proveedor tiene que traer: nombra sus claims, su configuración y su nivel de verificación.
    /^docs\/keel\/identity-contract\.md$/,
    // Levantar y sembrar el proveedor de prueba.
    /^infra\/(docker-compose\.yaml|test-credentials\.env|validate-infra\.sh|init-keycloak\.sh|cognito\/)/,
    /^deploy\/(\.env|docker-compose\.yaml|up\.sh|postman\/|keycloak\/|cognito\/)/
  ],
  // El lector del token, su configuración, y el arnés que pide los tokens.
  spring: [
    /^src\/main\/java\/.+\/infrastructure\/configurations\/security\/(AudienceAuthorizationFilter|JwtAuthConverter|SecurityConfig|JwtCallerScope|CallerIdentity|ServiceClientIds)\.java$/,
    /^src\/test\/java\/.+\/infrastructure\/configurations\/security\/TokenContractTest\.java$/,
    /^src\/main\/resources\/parameters\/(develop|local)\/oauth2\.yaml$/,
    /^src\/main\/resources\/parameters\/(develop|local|production|test)\/security\.yaml$/,
    /^src\/main\/resources\/application-test\.yaml$/,
    /^src\/integrationTest\/java\/.+\/flows\/AbstractFlowIT\.java$/
  ],
  nest: [
    /^config\/parameters\/(develop|local|production|test)\/security\.yaml$/,
    /^src\/infrastructure\/security\/(jwt-authenticator|caller-identity|jwt-caller-scope|service-client-ids)\.ts$/,
    /^test\/(token-contract|api)\.test\.ts$/,
    /^test\/integration\/(harness-smoke\.test\.ts|support\/flow\.ts)$/,
    /^test\/support\/test-credential\.ts$/
  ],
  dotnet: [
    /^config\/parameters\/(develop|local|production|test)\/security\.yaml$/,
    /^src\/[A-Za-z]+\.Infrastructure\/Security\/(JwtAuthenticator|CallerIdentity|JwtCallerScope|ServiceClientIds)\.cs$/,
    /^tests\/[A-Za-z]+\.IntegrationTests\/(HarnessSmoke\.cs|Support\/(Credentials|FlowTest)\.cs)$/,
    /^tests\/[A-Za-z]+\.UnitTests\/(TestCredential|TokenContractTests|ApiTests|ReadScopeTests|OptionalAuthTests)\.cs$/
  ],
  go: [
    /^config\/parameters\/(develop|local|production|test)\/security\.yaml$/,
    /^internal\/platform\/security\/(jwt|principal|caller_scope|caller_scope_test)\.go$/,
    /^internal\/httpapi\/(api_test|security|read_scope_test|token_contract_test|optional_auth_test)\.go$/,
    /^tests\/integration\/(credentials_test|flow_test|harness_smoke_test)\.go$/
  ]
};

/** Las rutas que difieren entre keycloak y cognito y no están en la lista. */
function unexpectedDifferences(name, reference, other, allowed = ALLOWED_DIFFERENCES) {
  const contents = (files) => new Map(files.map((file) => [pathOf(file), textOf(file)]));
  const a = contents(reference);
  const b = contents(other);
  const patterns = [...allowed.common, ...allowed[name]];
  return [...new Set([...a.keys(), ...b.keys()])].filter((file) => a.get(file) !== b.get(file)).filter((file) => !patterns.some((pattern) => pattern.test(file)));
}

for (const [name, plan] of Object.entries(GENERATORS)) {
  test(`${name}: el mismo diseño genera el mismo servidor con cada proveedor, salvo lo que es del proveedor`, () => {
    for (const fixture of tokenFixtures) {
      const unexpected = unexpectedDifferences(name, generate(plan, fixture, 'keycloak').files, generate(plan, fixture, 'cognito').files);
      assert.deepEqual(unexpected, [], `${name}/${fixture}: el proveedor se coló en piezas neutras`);
    }
  });
}

test('la paridad falla si difiere un archivo fuera de la lista', () => {
  const reference = [{ path: 'src/domain/Thing.java', content: 'a' }];
  const other = [{ path: 'src/domain/Thing.java', content: 'b' }];
  assert.deepEqual(unexpectedDifferences('spring', reference, other), ['src/domain/Thing.java']);
});

// ─── Lo que el proveedor tiene que cumplir (fase 3) ──────────────────────────

for (const [name, plan] of Object.entries(GENERATORS)) {
  test(`${name}: el proyecto lleva el documento de precondiciones, y su skill de Cognito lo cita en vez de repetirlo`, () => {
    const { files } = generate(plan, 'asset-vault', 'cognito');
    const doc = files.find((file) => pathOf(file) === 'docs/keel/identity-contract.md');
    assert.ok(doc, `${name}: sin docs/keel/identity-contract.md`);
    assert.match(textOf(doc), /no contra un pool real/);
    const skills = files.filter((file) => /\/skills\/keel-[a-z]+-cognito\/SKILL\.md$/.test(pathOf(file)));
    assert.ok(skills.length > 0, `${name}: sin la skill de Cognito`);
    for (const skill of skills) {
      const text = textOf(skill);
      assert.match(text, /docs\/keel\/identity-contract\.md/, `${pathOf(skill)}: no cita el documento`);
      assert.doesNotMatch(text, /disparador de pre-generación de tokens \(V2\)/, `${pathOf(skill)}: repite el disparador`);
    }
  });
}

// El aviso de build con un proveedor EMULADO sale del descriptor (`provisioning.emulation`), no de un texto por proveedor
// en cada proyección: la proyección solo pone el nombre de su skill, y esa skill es la que el proyecto instala.
for (const [name, plan] of Object.entries(GENERATORS)) {
  test(`${name}: el aviso de un proveedor emulado sale del descriptor y cita la skill que se instala`, () => {
    const emulated = (model) => model.warnings.filter((warning) => warning.startsWith('stack auth:'));
    const cognito = generate(plan, 'asset-vault', 'cognito');
    const [warning] = emulated(cognito.model);
    assert.match(warning ?? '', /^stack auth: cognito — .*no Amazon Cognito\./, `${name}: sin el aviso de Cognito`);
    const skill = /siguiendo la skill (\S+)\.$/.exec(warning)?.[1];
    assert.ok(skill && cognito.files.some((file) => pathOf(file).endsWith(`/skills/${skill}/SKILL.md`)), `${name}: el aviso cita ${skill}, que no se instala`);
    assert.deepEqual(emulated(generate(plan, 'asset-vault', 'keycloak').model), [], `${name}: Keycloak no es un emulador`);
    withFakes(() => {
      const [fake] = emulated(generate(plan, 'asset-vault', PREFIXED.id).model);
      assert.match(fake ?? '', /^stack auth: acme-prefix — .*forma de Acme IdP: grupos anidados bajo acme\), no Acme IdP\. Lo que NO queda probado ahí: el alta de usuarios\. Se verifica contra Acme IdP real\.$/, `${name}: ${fake}`);
      assert.doesNotMatch(fake, /Cognito/, `${name}: el aviso del ficticio habla de Cognito`);
      assert.deepEqual(emulated(generate(plan, 'asset-vault', PLAIN.id).model), [], `${name}: un proveedor sin emulación declarada no avisa`);
    });
  });
}

// El aviso de lo que el proveedor tiene que traer configurado (`checkIdentitySupport`) lo imprime el BUILD de cada
// generador, no el plan: en keel-nest, keel-dotnet y keel-go quedó dentro del `if (layers.payments)` de la pasarela, y
// solo avisaba en un diseño con pagos. Se ejecuta el comando entero, que es donde estaba el fallo.
const BUILDS = {
  spring: () => import('../../keel-spring/src/commands/build.js'),
  nest: () => import('../../keel-nest/src/commands/build.js'),
  dotnet: () => import('../../keel-dotnet/src/commands/build.js'),
  go: () => import('../src/commands/build.js')
};
for (const [name, load] of Object.entries(BUILDS)) {
  test(`${name}: build avisa de lo que Cognito tiene que traer configurado aunque el diseño no tenga pagos`, async () => {
    const { build } = await load();
    const workspace = makeWorkspace(`keel-identity-build-${name}-`);
    const specDir = mountDesign(workspace, 'asset-vault');
    const projectDir = path.join(workspace, 'services', `asset-vault-${name}`);
    fs.mkdirSync(projectDir, { recursive: true });
    writeStackConfig(projectDir, resolveStack({ database: 'mongodb', broker: 'rabbitmq', auth: 'cognito', cache: 'redis', storage: 'minio' }, loadService(specDir).layers));
    const { exitCode, output } = await runCommand(workspace, build, 'specs/asset-vault', { defaults: true, acceptUnready: true });
    assert.equal(exitCode, undefined, output.slice(-2000));
    assert.match(output, /security: scoping-user: Cognito solo pone el claim 'vaults' en el access token/, `${name}: sin el aviso de D6`);
  });
}
