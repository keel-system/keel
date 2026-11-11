// La prueba que demuestra el contrato entre el servidor y el TOKEN (casos IDT-* de keel-core/gen/token-cases.js), escrita
// en cada proyecto con la forma de token del proveedor elegido. Firma sus tokens con la clave del perfil test y los pasa
// por el autenticador real, sin red ni proveedor. Usa node:assert y no el expect de Vitest: así test/token-contract.test.js
// de este paquete la ejecuta tal cual, sin instalar el proyecto.

import { audienceOf, checksAudience } from '@keel-system/keel-core/gen/access-plan';
import { credentialClientId } from '@keel-system/keel-core/gen/identity-providers';
import { translatedClients } from '@keel-system/keel-core/gen/security-config';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { tsModule, tsString } from './render.js';
import { CALLER_IDENTITY_TS, JWT_AUTHENTICATOR_TS, JWT_CALLER_SCOPE_TS, SECURITY_CONTEXT_TS, TEST_JWKS_VARIABLE, usesJwt } from './security.js';
import { usesTestCredential } from './test-credential.js';

export const TOKEN_CONTRACT_TEST_TS = 'test/token-contract.test.ts';

/** Las líneas que afirman un caso, o [] si ninguna pieza de este diseño lo lee. */
function assertions(entry, { audienceChecked }) {
  const { expect } = entry;
  if (expect.authenticated === false) return ['await assert.rejects(principalOf(claims), InvalidCredential);'];
  const lines = [];
  if (expect.principal !== undefined) lines.push(`assert.equal((await principalOf(claims)).name, ${tsString(expect.principal)});`);
  for (const authority of expect.authorities?.includes ?? []) lines.push(`assert.ok((await principalOf(claims)).authorities.has(${tsString(authority)}));`);
  for (const authority of expect.authorities?.excludes ?? []) lines.push(`assert.equal((await principalOf(claims)).authorities.has(${tsString(authority)}), false);`);
  if (expect.identity !== undefined) lines.push(`assert.equal(SecurityContext.runWith(await principalOf(claims), () => CallerIdentity.resolve()), ${tsString(expect.identity)});`);
  if (expect.exempt !== undefined) lines.push(`assert.equal(SecurityContext.runWith(await principalOf(claims), () => new JwtCallerScope().isExempt()), ${expect.exempt});`);
  if (expect.scope !== undefined) lines.push(`assert.deepEqual([...SecurityContext.runWith(await principalOf(claims), () => new JwtCallerScope().scopedValues())], ${JSON.stringify(expect.scope)});`);
  if (expect.issuedForService !== undefined && audienceChecked) lines.push(`assert.equal(issuedFor(await principalOf(claims), ${tsString('AUDIENCE')}), ${expect.issuedForService});`.replace("'AUDIENCE'", 'AUDIENCE'));
  return lines;
}

export function generate(model) {
  if (!usesJwt(model) || !usesTestCredential(model)) return [];
  const cases = tokenCases(model);
  const audienceChecked = checksAudience(model.security);
  const tests = cases.flatMap((entry) => {
    const lines = assertions(entry, { audienceChecked });
    if (lines.length === 0) return [];
    return [`test(${tsString(`${entry.id}: ${entry.rule}`)}, async () => {
  const claims = ${JSON.stringify(entry.token)};
${lines.map((line) => `  ${line}`).join('\n')}
});`];
  });
  if (tests.length === 0) return [];

  const clientIds = Object.fromEntries(translatedClients(model).map((client) => [client.name, credentialClientId(model.stack.auth, client.name)]));
  const body = `// El contrato entre este servidor y el token del proveedor de identidad (${model.stack.auth}): dado un token con la
// forma que emite el proveedor, qué principal, qué authorities, qué identidad y qué exención ve el servidor. Los casos
// los deriva el generador del diseño y del descriptor del proveedor.
// Lo generó keel-nest build: no se edita.

const AUDIENCE = ${tsString(audienceOf(model))};

async function principalOf(claims: JWTPayload): Promise<Principal> {
  const credential = await testCredential();
  const values: Record<string, unknown> = {
    'security.oauth2.jwks': credential.env[${tsString(TEST_JWKS_VARIABLE)}],
    'security.audience': AUDIENCE,
    'security.client-ids': ${JSON.stringify(clientIds)}
  };
  const configuration = { get: (path: string) => values[path] } as unknown as Parameters<typeof JwtAuthenticator.from>[0];
  return JwtAuthenticator.from(configuration).authenticate(await credential.tokenWith(claims));
}

${tests.join('\n\n')}`;

  const uses = (name) => new RegExp(`\\b${name}\\b`).test(body.slice(body.indexOf('test(')));
  return [
    {
      path: TOKEN_CONTRACT_TEST_TS,
      content: tsModule(
        TOKEN_CONTRACT_TEST_TS,
        [
          { default: 'assert', from: 'node:assert/strict' },
          { symbol: 'test', from: 'vitest' },
          { symbol: 'JWTPayload', from: 'jose', type: true },
          { symbol: 'testCredential', from: './support/test-credential.js' },
          { symbol: 'JwtAuthenticator', from: JWT_AUTHENTICATOR_TS },
          { symbol: 'Principal', from: SECURITY_CONTEXT_TS, type: true },
          uses('InvalidCredential') ? { symbol: 'InvalidCredential', from: JWT_AUTHENTICATOR_TS } : null,
          uses('issuedFor') ? { symbol: 'issuedFor', from: JWT_AUTHENTICATOR_TS } : null,
          uses('SecurityContext') ? { symbol: 'SecurityContext', from: SECURITY_CONTEXT_TS } : null,
          uses('CallerIdentity') ? { symbol: 'CallerIdentity', from: CALLER_IDENTITY_TS } : null,
          uses('JwtCallerScope') ? { symbol: 'JwtCallerScope', from: JWT_CALLER_SCOPE_TS } : null
        ],
        body
      )
    }
  ];
}
