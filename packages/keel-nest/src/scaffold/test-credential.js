// La credencial de las pruebas que build deja escritas (`test/*.test.ts`, perfil `test`), cuando el
// diseño protege la API: sin ella, cada petición de esas pruebas sería un 401 y medirían la autorización
// en vez de lo que dicen medir (el contrato del cable, la lectura de peticiones, los errores).
//
// Con un token, la prueba genera su par de claves, publica el JWKS en SECURITY_TEST_JWKS (lo lee el
// perfil test: `security.oauth2.jwks`) y firma ella misma: la validación que se ejercita es la real, sin
// red ni proveedor. Sin variable publicada, el perfil test no acepta ningún token, así que no hay ninguna
// clave en el repositorio que un despliegue con el perfil equivocado aceptara.

import { fullAccessClaims as neutralFullAccessClaims } from '@keel-system/keel-core/gen/access-plan';
import { securityPlan, usesJwt, TEST_JWKS_VARIABLE, LOCAL_API_KEY } from './security.js';
import { tsString } from './render.js';

export const TEST_CREDENTIAL_TS = 'test/support/test-credential.ts';

/** ¿Necesitan credencial las pruebas del perfil test? Sí si alguna regla exige algo. */
export function usesTestCredential(model) {
  const plan = securityPlan(model);
  return Boolean(plan && !plan.open);
}

export function generate(model) {
  if (!usesTestCredential(model)) return [];
  return [{ path: TEST_CREDENTIAL_TS, content: usesJwt(model) ? tokenCredential(model) : keyCredential(model) }];
}

/**
 * Los claims que satisfacen TODA regla de acceso del diseño: el cálculo es neutral (keel-core/gen/access-plan.js, el
 * mismo token de acceso total que escriben las pruebas de keel-dotnet).
 */
export function fullAccessClaims(model) {
  return neutralFullAccessClaims(model, securityPlan(model));
}

function tokenCredential(model) {
  return `// La credencial de las pruebas del perfil test: un par de claves propio, su JWKS publicado al perfil
// en ${TEST_JWKS_VARIABLE} y tokens firmados aquí. La validación que se ejercita es la del servidor, sin red.
// Lo generó keel-nest build: no se edita.
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWTPayload } from 'jose';

/** Lo que satisface toda regla de acceso del diseño: sus roles, permisos y scopes, y la audiencia. */
export const FULL_ACCESS: JWTPayload = ${JSON.stringify(fullAccessClaims(model))};
export const KEY_ID = 'keel-test';

export interface TestCredential {
  /** Lo que hay que añadir al entorno de loadConfiguration para que el perfil test acepte los tokens. */
  readonly env: Readonly<Record<string, string>>;
  /** La cabecera con la que una petición pasa toda regla de acceso. */
  readonly headers: Readonly<Record<string, string>>;
  /** Un token con esos claims, firmado con la clave de la prueba (caducidad: '5m' o un instante en segundos). */
  tokenWith(claims: JWTPayload, expiresAt?: number | string): Promise<string>;
}

let credential: Promise<TestCredential> | null = null;

/** La credencial de la prueba: se crea una vez por proceso. */
export function testCredential(): Promise<TestCredential> {
  credential ??= create();
  return credential;
}

async function create(): Promise<TestCredential> {
  const keys = await generateKeyPair('RS256');
  const signingKey: CryptoKey = keys.privateKey;
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }] };
  const tokenWith = (claims: JWTPayload, expiresAt: number | string = '5m'): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: KEY_ID }).setIssuedAt().setExpirationTime(expiresAt).sign(signingKey);
  return {
    env: { ${TEST_JWKS_VARIABLE}: JSON.stringify(jwks) },
    headers: { authorization: \`Bearer \${await tokenWith(FULL_ACCESS)}\` },
    tokenWith
  };
}
`;
}

function keyCredential(model) {
  const plan = securityPlan(model);
  const client = plan.serviceApiKeys ? model.security.serviceClients[0] : null;
  const key = plan.protocol === 'api-key' ? LOCAL_API_KEY : `local-${client.name}-key`;
  return `// La credencial de las pruebas del perfil test: la clave de API que siembra su configuración.
// Lo generó keel-nest build: no se edita.

export interface TestCredential {
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

export function testCredential(): Promise<TestCredential> {
  return Promise.resolve({ env: {}, headers: { 'x-api-key': ${tsString(key)} } });
}
`;
}
