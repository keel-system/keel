#!/usr/bin/env node
// Las PERSONAS y los TITULARES DEL ALCANCE del emulador de identidad (incremento 4.3 de PLAN-PROVEEDOR-IDENTIDAD.md) contra
// el mock-oauth2-server real del catálogo. El emulador no guarda usuarios: cada forma de token es un mapping de su
// configuración, y el arnés de los cuatro generadores dice cuál quiere con los parámetros de la petición. Aquí se pide cada
// token con la petición de REFERENCIA (`emulatorPersonaForm`, `emulatorScopedForm` de gen/identity-realm.js) contra la
// configuración que emite build (`cognitoMockConfig`), y se lee el token: que casen la forma, los valores y el orden de
// los mappings. Nada de esto lo ve una prueba sin el emulador: un parámetro que no casa da un token VÁLIDO sin los claims
// (T1), o el literal `${x}` dentro.
//
// Uso: node scripts/emulator-check.js [--sabotage=persona-shape|scope-arity|order] (podman o docker; ~30 s). Con
// sabotaje, verde = el sabotaje cae en exactamente sus casos.

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { AUTH } from '../src/lib/gen/infra-catalog.js';
import { IDENTITY_PROVIDERS, credentialClientId, emulatedSubject } from '../src/lib/gen/identity-providers.js';
import { cognitoMockConfig } from '../src/lib/gen/identity-provisioning.js';
import {
  EMULATOR_PARAMS,
  EMULATOR_MAX_SCOPE_VALUES,
  emulatorPersonaForm,
  emulatorScopedForm,
  userTestClient,
  TEST_USER_PASSWORD
} from '../src/lib/gen/identity-realm.js';

const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.slice('--sabotage='.length) ?? null;
const SABOTAGES = {
  // El emulador escribe la forma con los claims antes que el rol: la misma información, otra cadena. El arnés ya no
  // encuentra el mapping de una persona con claims, y el token sale sin ellos.
  'persona-shape': {
    breaks: ['EMU-2', 'EMU-4'],
    apply: (mappings) =>
      mappings.map((m) => (m.requestParam === EMULATOR_PARAMS.persona && m.match.split(':')[1] ? { ...m, match: `${m.match.split(':')[1]}:${m.match.split(':')[0]}` } : m))
  },
  // Un solo mapping de alcance con un parámetro para la lista: el que el 4.2 midió que no sirve.
  'scope-arity': {
    breaks: ['EMU-6', 'EMU-7'],
    apply: (mappings) =>
      mappings.map((m) => (m.requestParam === EMULATOR_PARAMS.scoped && Number(m.match) > 1 ? { ...m, claims: { ...m.claims, vaults: [`\${${EMULATOR_PARAMS.valuePrefix}1}`] } } : m))
  },
  // Los usuarios fijos delante: tokenAs con el nombre de un usuario del rol cae en ese usuario.
  order: {
    breaks: ['EMU-8'],
    apply: (mappings) => [...mappings.filter((m) => m.requestParam === 'username'), ...mappings.filter((m) => m.requestParam !== 'username')]
  }
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const runtime = ['podman', 'docker'].find((name) => spawnSync(name, ['ps'], { encoding: 'utf8' }).status === 0);
if (!runtime) {
  console.error('Hace falta podman o docker en marcha.');
  process.exit(2);
}

// El sujeto: un diseño con la identidad en `email` (lo que el proveedor no da de serie: P3), dos roles —uno exento del
// alcance— y el alcance en `vaults`. Es la forma de shop-api y asset-vault juntas.
const model = {
  service: { name: 'emulator-probe', projectName: 'emulator-probe-check', artifactId: 'emulator-probe' },
  layersPresent: { security: true },
  stack: { auth: 'cognito' },
  security: {
    protocol: 'oidc',
    roles: ['custodian', 'auditor'],
    scopes: [],
    serviceClients: [],
    scoping: { claim: 'vaults', over: 'Vault.code', error: 'VAULT_FORBIDDEN', exemptRoles: ['auditor'], exemptClients: [], testResource: 'MAIN' },
    callerIdentity: { field: 'callerEmail', source: 'claim', claim: 'email', resolvedBy: null },
    claimDemands: [{ id: 'caller-identity', claim: 'email', holder: 'user' }]
  }
};

// Cognito da personas y titulares por el emulador desde el 4.3; mientras un generador no lo implemente, el descriptor
// puede decir otra cosa, y esta red mide el emulador igual.
const cognito = IDENTITY_PROVIDERS.cognito;
const harness = cognito.harness;
cognito.harness = { personaTokens: 'emulator', scopedTokens: 'emulator' };
const config = JSON.parse(cognitoMockConfig(model).content);
cognito.harness = harness;
if (sabotage) config.tokenCallbacks[0].requestMappings = SABOTAGES[sabotage].apply(config.tokenCallbacks[0].requestMappings);

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const image = AUTH.cognito.composeServices()[AUTH.cognito.serviceKey].image;
const port = await freePort();
const name = `keel-emulator-check-${process.pid}`;
// La configuración viaja en JSON_CONFIG, no montada: ninguna ruta del host que traducir.
const started = spawnSync(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${port}:8080`, '-e', `JSON_CONFIG=${JSON.stringify(config)}`, image], { encoding: 'utf8' });
if (started.status !== 0) {
  console.error(started.stderr);
  process.exit(2);
}

const base = `http://localhost:${port}/${model.service.name}`;
const results = [];
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = await fetch(`${base}/.well-known/openid-configuration`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('el emulador no arrancó en 60 s');

  const userClient = credentialClientId('cognito', userTestClient(model));
  const token = async (extra, username) => {
    const form = new URLSearchParams({ grant_type: 'password', client_id: userClient, username, password: TEST_USER_PASSWORD, ...extra });
    const response = await fetch(`${base}/token`, { method: 'POST', body: form });
    const body = await response.json();
    if (!body.access_token) throw new Error(`sin token: ${JSON.stringify(body)}`);
    return JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString('utf8'));
  };
  const persona = (sub, claims, role) => token(emulatorPersonaForm(model, sub, claims, role), sub);
  const scoped = (user, role, values) => token(emulatorScopedForm(user, role, values), user);

  const check = async (id, label, body) => {
    try {
      await body();
      results.push({ id, label, ok: true });
    } catch (error) {
      results.push({ id, label, ok: false, why: error.message });
    }
  };
  const equal = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: ${JSON.stringify(actual)} en vez de ${JSON.stringify(expected)}`);
  };
  const userShape = (claims) => {
    equal(claims.token_use, 'access', 'token_use');
    equal(claims.client_id, userClient, 'client_id');
  };

  await check('EMU-1', 'persona sin rol ni claims: el sub que pide, sin grupos y sin email', async () => {
    const claims = await persona('7c1e0f9a-0000-4000-8000-000000000001', {}, null);
    userShape(claims);
    equal(claims.sub, '7c1e0f9a-0000-4000-8000-000000000001', 'sub');
    equal(claims.username, claims.sub, 'username');
    equal(claims['cognito:groups'], [], 'grupos');
    equal('email' in claims, false, 'email presente');
  });
  await check('EMU-2', 'persona con rol y email', async () => {
    const claims = await persona('ana', { email: 'customer1@email.com' }, 'custodian');
    userShape(claims);
    equal(claims['cognito:groups'], ['custodian'], 'grupos');
    equal(claims.email, 'customer1@email.com', 'email');
  });
  await check('EMU-3', 'persona con el email QUITADO (null): el token sin él', async () => {
    const claims = await persona('ana', { email: null }, 'custodian');
    equal('email' in claims, false, 'email presente');
    equal(JSON.stringify(claims).includes('${'), false, 'hueco sin sustituir');
  });
  await check('EMU-4', 'un valor con comillas, acentos y mayúsculas vuelve tal cual', async () => {
    const value = 'Bob"Ñandú"@X.io';
    const claims = await persona('bob', { email: value }, null);
    equal(claims.email, value, 'email');
  });
  await check('EMU-5', 'titular del alcance sin valores: el rol y SIN el claim', async () => {
    const claims = await scoped('scoped-custodian-0', 'custodian', []);
    userShape(claims);
    equal(claims['cognito:groups'], ['custodian'], 'grupos');
    equal('vaults' in claims, false, 'vaults presente');
  });
  await check('EMU-6', 'titular del alcance con uno, dos y el máximo de valores: la lista exacta', async () => {
    for (const values of [['OTRO'], ['A', 'B'], Array.from({ length: EMULATOR_MAX_SCOPE_VALUES }, (_, i) => `V${i}`)]) {
      const claims = await scoped(`scoped-custodian-${values.length}`, 'custodian', values);
      equal(claims.vaults, [...values].sort(), `vaults con ${values.length}`);
    }
  });
  await check('EMU-7', 'el titular del alcance lleva el claim de la identidad (P3), con el hueco dentro de un texto', async () => {
    const claims = await scoped('scoped-custodian-x', 'custodian', ['A', 'B']);
    equal(claims.email, 'scoped-custodian-x@example.com', 'email');
    equal(claims.vaults, ['A', 'B'], 'vaults');
  });
  await check('EMU-8', 'una persona con el nombre de un usuario fijo es la persona, no el usuario', async () => {
    const claims = await persona('custodian', {}, null);
    equal(claims.sub, 'custodian', 'sub');
    equal(claims['cognito:groups'], [], 'grupos');
  });
  await check('EMU-9', 'los usuarios fijos siguen intactos: sub uuid y el alcance sembrado', async () => {
    const claims = await token({}, 'custodian');
    equal(claims.sub, emulatedSubject('custodian'), 'sub');
    equal(claims.vaults, ['MAIN'], 'vaults');
    equal(claims.email, 'custodian@example.com', 'email');
  });
  await check('EMU-10', 'lo que el emulador no puede dar se rechaza ANTES de pedirlo', async () => {
    let rejected = 0;
    try {
      emulatorPersonaForm(model, 'ana', { name: 'x' }, null);
    } catch {
      rejected += 1;
    }
    try {
      emulatorScopedForm('u', 'custodian', Array.from({ length: EMULATOR_MAX_SCOPE_VALUES + 1 }, (_, i) => `V${i}`));
    } catch {
      rejected += 1;
    }
    equal(rejected, 2, 'rechazos');
  });
} finally {
  spawnSync(runtime, ['rm', '-f', name], { encoding: 'utf8' });
}

for (const result of results) console.log(`${result.ok ? 'OK ' : 'KO '} ${result.id}  ${result.label}${result.ok ? '' : `\n      ${result.why}`}`);
const failed = results.filter((result) => !result.ok).map((result) => result.id);
if (!sabotage) {
  console.log(failed.length === 0 ? `\nVerde: ${results.length}/${results.length}.` : `\nRojo: ${failed.join(', ')}.`);
  process.exit(failed.length === 0 ? 0 : 1);
}
const expected = SABOTAGES[sabotage].breaks;
const exact = failed.length === expected.length && expected.every((id) => failed.includes(id));
console.log(`\nSabotaje ${sabotage}: cae en ${failed.join(', ') || '(nada)'}; se esperaba ${expected.join(', ')}. ${exact ? 'Verde' : 'ROJO'}.`);
process.exit(exact ? 0 : 1);
