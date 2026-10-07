// Las credenciales del arnés de integración: lo que en keel-spring da AbstractFlowIT (`tokenFor`,
// `serviceCredential`, `tokenAs`, `scopedResource`, `apiKey`), aquí como funciones de
// test/integration/support/flow.ts.
//
// Los valores salen de `infra/test-credentials.env`, que escribe build junto al script que siembra el
// proveedor (keel-core/gen/identity-provisioning.js): un solo productor, un solo consumidor, ningún
// literal inventado a los dos lados. Una variable de entorno del mismo nombre manda sobre el archivo.
//
// Se emite solo con capa security; y cada función, solo si el diseño la hace posible: sin roles no hay
// usuarios a los que pedir un token (`tokenFor` no existiría y su promesa sería mentira), sin
// `serviceAuth` no hay clientes máquina.

import { usesTokenProtocol, accessPlan } from 'keel-core/gen/access-plan';
import { tokenUrl, userTestClient, usesPersonaTokens, keycloakAdminCredentials, TEST_USER_PASSWORD } from 'keel-core/gen/identity-realm';
import { LOCAL_API_KEY, localClientApiKey } from './security.js';
import { tsString } from './render.js';

/** ¿Lleva el arnés sección de credenciales? */
export function usesIdentityHarness(model) {
  return Boolean(model.layersPresent?.security && model.security && model.security.protocol !== 'none');
}

/**
 * La expresión TypeScript que da una credencial que SATISFACE la regla de cierre del diseño, no una
 * cualquiera (la lección de keel-spring: con `access.default` de nivel admin, el primer rol recibía un
 * 403 y el humo caía sin hablar del servicio). Devuelve las cabeceras, o null si nada la satisface.
 */
export function closingCredential(model) {
  if (!usesIdentityHarness(model)) return null;
  const sec = model.security;
  if (!usesTokenProtocol(sec)) {
    return sec.protocol === 'api-key' ? `{ 'X-API-Key': apiKey() }` : null;
  }
  const plan = accessPlan(model);
  const fallback = plan.chains[plan.chains.length - 1].fallback;
  if (fallback.kind === 'public') return '{}';
  const roles = sec.roles ?? [];
  const clients = sec.serviceAuth && sec.serviceAuth.protocol !== 'api-key' ? sec.serviceClients ?? [] : [];
  const asRole = (role) => (roles.includes(role) ? `bearer(await tokenFor(${tsString(role)}))` : null);
  const asClient = (client) => `bearer(await serviceCredential(${tsString(client.name)}))`;
  const wanted = fallback.authorities ?? [];
  const candidates = [
    ...wanted.filter((a) => a.startsWith('ROLE_')).map((a) => asRole(a.slice(5))),
    ...wanted
      .filter((a) => !a.startsWith('ROLE_') && !a.startsWith('SCOPE_'))
      .flatMap((permission) => (sec.roleGrants ?? []).filter((grant) => grant.permissions.includes(permission)).map((grant) => asRole(grant.role))),
    ...wanted
      .filter((a) => a.startsWith('SCOPE_'))
      .flatMap((scope) => clients.filter((client) => client.scopes.includes(scope.slice(6))).map(asClient))
  ].filter(Boolean);
  if (candidates.length > 0) return candidates[0];
  if (roles[0]) return asRole(roles[0]);
  if (clients[0]) return asClient(clients[0]);
  return null;
}

/** La sección de flow.ts: lectura de test-credentials.env y las funciones de credencial. */
export function identitySection(model) {
  if (!usesIdentityHarness(model)) return '';
  const sec = model.security;
  const parts = [credentialsReader()];
  if (!usesTokenProtocol(sec)) {
    parts.push(apiKeySection(model));
    return parts.join('\n');
  }
  parts.push(tokenCache(model));
  if ((sec.roles ?? []).length > 0) parts.push(tokenForSection(model));
  if (sec.serviceAuth) parts.push(serviceCredentialSection(model));
  if (usesPersonaTokens(model)) parts.push(personaSection(model));
  if (sec.scoping) parts.push(scopedResourceSection(model));
  return parts.join('\n');
}

function credentialsReader() {
  return `
// ── Credenciales ─────────────────────────────────────────────────────────────

/**
 * Credenciales del proveedor de identidad de prueba, por orden: variable de entorno →
 * \`infra/test-credentials.env\` → valor convencional. El archivo lo escribe build junto al script que
 * siembra el proveedor, así que los nombres de cliente y los secretos tienen un ÚNICO productor.
 */
const PROVISIONED: Readonly<Record<string, string>> = loadProvisionedCredentials();

function loadProvisionedCredentials(): Record<string, string> {
  const file = path.join('infra', 'test-credentials.env');
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator > 0) values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

function credential(name: string, fallback: string): string {
  const fromEnv = process.env[name];
  if (fromEnv != null && fromEnv.trim() !== '') return fromEnv;
  return PROVISIONED[name] ?? fallback;
}

/** La cabecera \`Authorization\` de un token: \`flow.get(ruta, bearer(await tokenFor('rol')))\`. */
export function bearer(token: string): Headers {
  return { Authorization: \`Bearer \${token}\` };
}`;
}

function apiKeySection(model) {
  const sec = model.security;
  const clients = sec.serviceAuth?.protocol === 'api-key' ? sec.serviceClients ?? [] : [];
  const single = sec.protocol === 'api-key';
  return `${
    single
      ? `
/**
 * La clave de API del perfil local, ya sembrada en config/parameters/local/security.yaml. No se
 * inventa: cambiarla solo tiene sentido para ejercitar el 401 con una clave inválida.
 * Uso: \`flow.get(ruta, { 'X-API-Key': apiKey() })\`.
 */
export function apiKey(): string {
  return ${tsString(LOCAL_API_KEY)};
}
`
      : ''
  }${
    clients.length > 0
      ? `
/** La clave del cliente máquina declarado en el diseño (security.api-keys.<cliente> del perfil local). */
export function serviceCredential(client: string): string {
  const keys: Record<string, string> = { ${clients.map((client) => `${tsString(client.name)}: ${tsString(localClientApiKey(client.name))}`).join(', ')} };
  const key = keys[client];
  if (key == null) throw new Error(\`Cliente de servicio no declarado en el diseño: \${client}\`);
  return key;
}
`
      : ''
  }`;
}

function tokenCache(model) {
  return `
/** Margen con el que se renueva un token antes de su \`exp\`. */
const TOKEN_RENEWAL_MARGIN_MS = 30_000;
const tokens = new Map<string, string>();

/**
 * El token cacheado de esa clave, pedido de nuevo si le queda poca vida. El realm de prueba emite
 * tokens de CINCO minutos: un flujo con esperas reales se pasa de ahí, y un token guardado en una
 * variable empieza a dar 401 a mitad del flujo, con un síntoma que no se parece a su causa. Por eso
 * las funciones de credencial se llaman en CADA petición: si el token sigue valiendo, es el mismo.
 */
async function cachedToken(key: string, mint: () => Promise<string>): Promise<string> {
  const cached = tokens.get(key);
  if (cached != null && !expiresWithin(cached, TOKEN_RENEWAL_MARGIN_MS)) return cached;
  const fresh = await mint();
  tokens.set(key, fresh);
  return fresh;
}

/** ¿Le quedan a este token menos de \`marginMs\`? Uno cuyo \`exp\` no se lee se da por caducado. */
function expiresWithin(token: string, marginMs: number): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp !== 'number' || Date.now() + marginMs >= payload.exp * 1000;
  } catch {
    return true;
  }
}

/** Pide un token al endpoint del proveedor (AUTH_TOKEN_URL) con el formulario dado. */
async function requestToken(form: Record<string, string>): Promise<string> {
  const response = await fetch(credential('AUTH_TOKEN_URL', ${tsString(tokenUrl(model))}), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(\`El proveedor de identidad devolvió \${response.status}: \${text}\`);
  const token = (JSON.parse(text) as { access_token?: unknown }).access_token;
  if (typeof token !== 'string') throw new Error(\`El proveedor de identidad no devolvió access_token: \${text}\`);
  return token;
}`;
}

function tokenForSection(model) {
  return `
/**
 * Bearer token de un usuario con el rol pedido. El realm de prueba siembra DOS por rol, \`<rol>\` y
 * \`<rol>-2\`, más uno sin roles (\`no-role\`): \`n = 2\` es el segundo, que es lo que necesita un
 * escenario de titularidad («solo quien lo creó»), donde hacen falta dos sujetos con el MISMO rol.
 * Cliente, contraseña y endpoint salen de infra/test-credentials.env (AUTH_TEST_CLIENT,
 * AUTH_TEST_PASSWORD, AUTH_TOKEN_URL). Llámalo en cada petición; no guardes lo que devuelve.
 */
export async function tokenFor(role: string, n = 1): Promise<string> {
  const username = n <= 1 ? role : \`\${role}-\${n}\`;
  return cachedToken(\`user:\${username}\`, () =>
    requestToken({
      grant_type: 'password',
      client_id: credential('AUTH_TEST_CLIENT', ${tsString(userTestClient(model))}),
      username,
      password: credential('AUTH_TEST_PASSWORD', ${tsString(TEST_USER_PASSWORD)})
    })
  );
}`;
}

function serviceCredentialSection(model) {
  if (model.security.serviceAuth?.protocol === 'api-key') return apiKeySection(model);
  return `
/**
 * Credencial de máquina (client_credentials) de un cliente declarado en security.serviceClients, o de
 * uno de la matriz de prueba (\`test-m2m-*\`): los escenarios \`level: service\` no usan token de usuario.
 * El secreto sale de infra/test-credentials.env: primero el del cliente
 * (\`AUTH_CLIENT_SECRET_<CLIENTE>\`), después el compartido (\`AUTH_CLIENT_SECRET\`).
 */
export async function serviceCredential(client: string): Promise<string> {
  const specific = credential(\`AUTH_CLIENT_SECRET_\${client.toUpperCase().replace(/[^A-Z0-9]/g, '_')}\`, '');
  const secret = specific !== '' ? specific : credential('AUTH_CLIENT_SECRET', \`\${client}-secret\`);
  return cachedToken(\`client:\${client}\`, () => requestToken({ grant_type: 'client_credentials', client_id: client, client_secret: secret }));
}`;
}

function scopedResourceSection(model) {
  const scoping = model.security.scoping;
  return `
/**
 * El recurso al que alcanzan los usuarios de prueba NO exentos del alcance por recurso (el claim
 * \`${scoping.claim}\` de su token). No lo escribas a mano en un escenario: sale de
 * infra/test-credentials.env, el mismo sitio del que lo lee el script que siembra el realm. Los
 * roles exentos (${scoping.exemptRoles.join(', ') || 'ninguno'}) no llevan el claim: alcanzan cualquier recurso.
 */
export function scopedResource(): string {
  return credential('AUTH_SCOPED_RESOURCE', ${tsString(scoping.testResource)});
}`;
}

function personaSection(model) {
  const admin = keycloakAdminCredentials();
  return `
// ── Personas: un sub elegido por el escenario ────────────────────────────────

/**
 * Token de una PERSONA del documento de escenarios: el usuario cuyo claim \`sub\` es exactamente \`sub\`,
 * con los claims de \`claims\`. Un valor \`null\` QUITA ese claim («el token de ana sin email»), y uno
 * que el tipo del campo no admite viaja tal cual («un name de 101 caracteres»). \`role\`, si se da, es
 * un rol del realm concedido a la persona.
 *
 * Existe porque el diseño identifica al llamante por \`sub\`, y \`tokenFor\` no puede elegirlo: su
 * usuario es el del rol y su \`sub\` es el id que asigna Keycloak. Llámalo en cada petición.
 */
export async function tokenAs(sub: string, claims: Readonly<Record<string, string | null>> = {}, role: string | null = null): Promise<string> {
  if ('sub' in claims) throw new Error('El sub de la persona va en el primer argumento, no entre los claims');
  const wanted = Object.fromEntries(Object.entries(claims).filter((entry): entry is [string, string] => entry[1] != null).sort(([a], [b]) => a.localeCompare(b)));
  // Los claims QUITADOS también entran en la clave: «sin email» es otro token que «con email».
  const key = \`persona|\${sub}|\${role}|\${JSON.stringify(wanted)}|\${Object.keys(claims).sort().join(',')}\`;
  return cachedToken(key, async () => {
    await ensurePersona(sub, role, wanted, Object.keys(claims));
    return requestToken({
      grant_type: 'password',
      client_id: credential('AUTH_TEST_CLIENT', ${tsString(userTestClient(model))}),
      username: sub,
      password: credential('AUTH_TEST_PASSWORD', ${tsString(TEST_USER_PASSWORD)})
    });
  });
}

const personaApplied = new Map<string, string>();
const personaMappers = new Set<string>();
let personaRealmReady = false;

/**
 * Deja a la persona como la pide el escenario, por la API de administración del realm. Tres cosas
 * que no son evidentes y costaron una pasada cada una en keel-spring: (1) el alta va por
 * \`partialImport\` y no por \`POST /users\`, porque Keycloak 26 IGNORA el \`id\` de ese cuerpo y el \`sub\`
 * del token es el id del usuario — por eso se comprueba después; (2) los claims salen de atributos
 * propios (\`kp_<claim>\`) con un mapper por claim, porque los campos nativos validan su forma y el
 * escenario necesita poder mandar un email roto; (3) el User Profile del realm deja de exigir email y
 * nombre, o el password grant de una persona sin ellos responde «Account is not fully set up».
 */
async function ensurePersona(sub: string, role: string | null, claims: Record<string, string>, named: readonly string[]): Promise<void> {
  const admin = await personaAdminToken();
  if (!personaRealmReady) {
    await preparePersonaRealm(admin);
    personaRealmReady = true;
  }
  for (const claim of named) {
    if (personaMappers.has(claim)) continue;
    await ensurePersonaMapper(admin, claim);
    personaMappers.add(claim);
  }
  const applied = \`\${role}|\${JSON.stringify(claims)}\`;
  if (personaApplied.get(sub) === applied) return;
  const user: Record<string, unknown> = {
    username: sub,
    enabled: true,
    emailVerified: true,
    requiredActions: [],
    attributes: Object.fromEntries(Object.entries(claims).map(([name, value]) => [\`kp_\${name}\`, [value]]))
  };
  let id = await personaUserId(admin, sub);
  if (id != null && id !== sub) {
    // Resto de otra ejecución creado con id aleatorio: con él el sub no sería el pedido.
    await personaAdmin(admin, 'DELETE', \`/users/\${id}\`);
    id = null;
  }
  if (id == null) {
    const created = { ...user, id: sub, credentials: [{ type: 'password', value: credential('AUTH_TEST_PASSWORD', ${tsString(TEST_USER_PASSWORD)}), temporary: false }] };
    await personaAdmin(admin, 'POST', '/partialImport', { ifResourceExists: 'SKIP', users: [created] });
    id = await personaUserId(admin, sub);
    if (id !== sub) throw new Error(\`Keycloak no respetó el id pedido para la persona \${sub} (asignó \${id}): el claim sub del token no sería el del escenario\`);
    if (role != null) {
      const realmRole = await personaAdmin(admin, 'GET', \`/roles/\${encodeURIComponent(role)}\`);
      await personaAdmin(admin, 'POST', \`/users/\${id}/role-mappings/realm\`, [realmRole]);
    }
  } else {
    await personaAdmin(admin, 'PUT', \`/users/\${id}\`, user);
  }
  personaApplied.set(sub, applied);
}

/** User Profile del realm: email y nombre opcionales, y atributos no declarados admitidos. */
async function preparePersonaRealm(admin: string): Promise<void> {
  const profile = (await personaAdmin(admin, 'GET', '/users/profile')) as { attributes?: Array<Record<string, unknown>>; [key: string]: unknown };
  for (const attribute of profile.attributes ?? []) {
    if (['email', 'firstName', 'lastName'].includes(String(attribute.name))) delete attribute.required;
  }
  profile.unmanagedAttributePolicy = 'ENABLED';
  await personaAdmin(admin, 'PUT', '/users/profile', profile);
}

/** Un mapper por claim en el cliente de prueba: el claim sale del atributo kp_<claim>. */
async function ensurePersonaMapper(admin: string, claim: string): Promise<void> {
  const clientId = credential('AUTH_TEST_CLIENT', ${tsString(userTestClient(model))});
  const clients = (await personaAdmin(admin, 'GET', \`/clients?clientId=\${encodeURIComponent(clientId)}\`)) as Array<{ id: string }>;
  if (clients.length === 0) throw new Error(\`No existe el cliente de prueba '\${clientId}': ¿se ejecutó infra/init-keycloak.sh?\`);
  const base = \`/clients/\${clients[0]!.id}/protocol-mappers/models\`;
  const existing = (await personaAdmin(admin, 'GET', base)) as Array<{ name: string }>;
  if (existing.some((mapper) => mapper.name === \`persona-\${claim}\`)) return;
  await personaAdmin(admin, 'POST', base, {
    name: \`persona-\${claim}\`,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: {
      'user.attribute': \`kp_\${claim}\`,
      'claim.name': claim,
      'jsonType.label': 'String',
      'access.token.claim': 'true',
      'id.token.claim': 'true',
      'userinfo.token.claim': 'true'
    }
  });
}

/** El id del usuario con ese username (Keycloak lo guarda en minúsculas), o null. */
async function personaUserId(admin: string, username: string): Promise<string | null> {
  const users = (await personaAdmin(admin, 'GET', \`/users?exact=true&username=\${encodeURIComponent(username)}\`)) as Array<{ id: string; username: string }>;
  return users.find((user) => user.username.toLowerCase() === username.toLowerCase())?.id ?? null;
}

/** Token de administración del realm master, con las credenciales de test-credentials.env. */
async function personaAdminToken(): Promise<string> {
  const response = await fetch(\`\${keycloakBase()}/realms/master/protocol/openid-connect/token\`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: credential('AUTH_ADMIN_USER', ${tsString(admin.user)}),
      password: credential('AUTH_ADMIN_PASSWORD', ${tsString(admin.password)})
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(\`Keycloak no dio token de administración (\${response.status}): revisa AUTH_ADMIN_USER/AUTH_ADMIN_PASSWORD en infra/test-credentials.env. \${text}\`);
  }
  return (JSON.parse(text) as { access_token: string }).access_token;
}

async function personaAdmin(admin: string, method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(\`\${keycloakBase()}/admin/realms/\${realmName()}\${route}\`, {
    method,
    headers: { authorization: \`Bearer \${admin}\`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) throw new Error(\`Keycloak admin \${method} \${route} devolvió \${response.status}: \${text}\`);
  return text === '' ? null : JSON.parse(text);
}

/** La base del servidor y el realm, sacados de AUTH_TOKEN_URL: una sola fuente de los dos. */
function keycloakBase(): string {
  const url = credential('AUTH_TOKEN_URL', ${tsString(tokenUrl(model))});
  return url.slice(0, url.indexOf('/realms/'));
}

function realmName(): string {
  const url = credential('AUTH_TOKEN_URL', ${tsString(tokenUrl(model))});
  const start = url.indexOf('/realms/') + '/realms/'.length;
  return url.slice(start, url.indexOf('/', start));
}`;
}
