// La seguridad del servicio (capa security del diseño): quién llama y qué puede pedir.
//
// El contrato es el del servidor de keel-spring del mismo diseño, y la decisión la toma keel-core
// (gen/access-plan.js): qué exige cada regla, qué rutas comprueban la audiencia y en qué orden se
// evalúa todo. Aquí solo se escribe en TypeScript:
//
//   · un HOOK de la entrada HTTP (no un Guard de Nest) que evalúa el plan por método y ruta. Un Guard
//     solo corre cuando una ruta casa, y Spring Security decide ANTES de enrutar: sin credencial, un
//     camino que no existe responde 401 y no 404, y uno que existe con otro método también. Con un
//     Guard, los dos servidores darían status distintos a la misma petición;
//   · la validación del JWT con `jose` contra el JWKS del proveedor (issuer-uri con su discovery,
//     como el resource server de Spring), con las authorities de Spring: `ROLE_<rol>`, el permiso tal
//     cual y `SCOPE_<scope>`, los roles del diseño expandidos a sus permisos (`roleGrants`);
//   · los rechazos como ErrorResponse con los `code` del catálogo (UNAUTHENTICATED, ACCESS_DENIED);
//   · CORS con la semántica del DefaultCorsProcessor de Spring, dentro del mismo hook y ANTES de
//     autenticar: el preflight no lleva credencial, y un 401 tiene que llegar con sus cabeceras CORS
//     o el navegador no deja leerlo;
//   · la identidad del llamante (`callerIdentity`) en un único punto, y el alcance por recurso
//     (`scoping`) como un puerto de la aplicación con su adaptador.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { accessPlan, audienceOf, tokenClaims, usesTokenProtocol } from 'keel-core/gen/access-plan';
import { classPath, DIRS, tsModule, tsString } from './render.js';
import { usesApi, ERROR_RESPONSE_TS } from './rest-support.js';

const DIR = 'src/infrastructure/security';
export const SECURITY_CONTEXT_TS = `${DIR}/security-context.ts`;
export const ACCESS_RULES_TS = `${DIR}/access-rules.ts`;
export const JWT_AUTHENTICATOR_TS = `${DIR}/jwt-authenticator.ts`;
export const API_KEY_AUTHENTICATOR_TS = `${DIR}/api-key-authenticator.ts`;
export const CORS_POLICY_TS = `${DIR}/cors-policy.ts`;
export const HTTP_SECURITY_TS = `${DIR}/http-security.ts`;
export const CALLER_IDENTITY_TS = `${DIR}/caller-identity.ts`;
export const JWT_CALLER_SCOPE_TS = `${DIR}/jwt-caller-scope.ts`;
export const SECURITY_MODULE_TS = `${DIR}/security-module.ts`;
export const CALLER_SCOPE_TS = classPath(DIRS.appSupport, 'CallerScope');
const CONFIGURATION_TS = 'src/infrastructure/config/configuration.ts';

/** Clave de API del perfil local: la misma que siembra keel-spring (config.js, LOCAL_API_KEY). */
export const LOCAL_API_KEY = 'local-dev-api-key';
export const localClientApiKey = (client) => `local-${client}-key`;
/** Orígenes CORS del perfil local: los mismos que keel-spring. */
export const LOCAL_CORS_ORIGINS = 'http://localhost:3000,http://localhost:5173';
/** La variable con la que las pruebas del perfil `test` publican el JWKS con el que firman. */
export const TEST_JWKS_VARIABLE = 'SECURITY_TEST_JWKS';

/** El plan de autorización, o null sin capa security o sin API que proteger. */
export function securityPlan(model) {
  if (!usesApi(model)) return null;
  return accessPlan(model);
}

/** ¿Hay que instalar el hook en la entrada HTTP? Con el protocolo `none`, solo si hay CORS. */
export function usesHttpSecurity(model) {
  const plan = securityPlan(model);
  return Boolean(plan && (!plan.open || model.security?.cors));
}

export function usesJwt(model) {
  return Boolean(securityPlan(model)) && usesTokenProtocol(model.security);
}

function apiKeyClients(model) {
  const plan = securityPlan(model);
  if (!plan || plan.open) return [];
  if (plan.protocol === 'api-key') return [{ name: 'api-key-client', key: 'security.api-key', authorities: [] }];
  if (plan.serviceApiKeys) {
    return model.security.serviceClients.map((client) => ({
      name: client.name,
      key: `security.api-keys.${client.name}`,
      authorities: client.scopes.map((scope) => `SCOPE_${scope}`)
    }));
  }
  return [];
}

/** ¿Resuelve el servidor la identidad del llamante desde la credencial? */
export function usesCallerIdentity(model) {
  return Boolean(securityPlan(model) && model.security?.callerIdentity);
}

/** ¿Hay alcance por recurso con su puerto? Solo sobre un token: es un claim. */
export function usesCallerScope(model) {
  return Boolean(usesJwt(model) && model.security?.scoping);
}

/** Las operaciones cuyo handler recibe el alcance: las que declaran su error. */
export function scopedOperation(model, operation) {
  const scoping = model.security?.scoping;
  return Boolean(usesCallerScope(model) && scoping && (operation.errors ?? []).includes(scoping.error));
}

export function generate(model) {
  if (!usesHttpSecurity(model)) return [];
  const files = [
    { path: SECURITY_CONTEXT_TS, content: tsModule(SECURITY_CONTEXT_TS, [{ symbol: 'AsyncLocalStorage', from: 'node:async_hooks' }], securityContextBody()) },
    { path: ACCESS_RULES_TS, content: tsModule(ACCESS_RULES_TS, [{ symbol: 'Principal', from: SECURITY_CONTEXT_TS, type: true }], accessRulesBody(model)) },
    { path: HTTP_SECURITY_TS, content: httpSecurity(model) }
  ];
  if (usesJwt(model)) files.push({ path: JWT_AUTHENTICATOR_TS, content: jwtAuthenticator(model) });
  if (apiKeyClients(model).length > 0) files.push({ path: API_KEY_AUTHENTICATOR_TS, content: apiKeyAuthenticator(model) });
  if (model.security?.cors) files.push({ path: CORS_POLICY_TS, content: corsPolicy(model) });
  if (usesCallerIdentity(model)) files.push({ path: CALLER_IDENTITY_TS, content: callerIdentity(model) });
  if (usesCallerScope(model)) files.push(...callerScope(model));
  files.push(...configFragments(model));
  return files;
}

// ─── security-context.ts ─────────────────────────────────────────────────────

function securityContextBody() {
  return `/**
 * Quién hace la petición en curso, ya autenticado: lo que en Spring es el SecurityContextHolder.
 *
 * Vive en un AsyncLocalStorage que abre el hook de seguridad de la entrada HTTP (http-security.ts)
 * y que sigue a la petición por todos sus awaits. Fuera de una petición (un listener, un barrido) no
 * hay ninguno: \`current()\` devuelve null.
 */
export interface Principal {
  /** Un token validado (\`token\`) o una clave de API (\`key\`). */
  readonly kind: 'token' | 'key';
  /** El nombre del principal: el claim del proveedor en un token, el cliente en una clave. */
  readonly name: string;
  /** \`ROLE_<rol>\`, el permiso tal cual (\`recurso:accion\`) y \`SCOPE_<scope>\`, como en Spring. */
  readonly authorities: ReadonlySet<string>;
  /** Los claims del token (vacío con una clave de API). */
  readonly claims: Readonly<Record<string, unknown>>;
}

const storage = new AsyncLocalStorage<Principal | null>();

export const SecurityContext = {
  /** El principal de la petición en curso, o null si es anónima o no hay petición. */
  current(): Principal | null {
    return storage.getStore() ?? null;
  },

  /** Ejecuta la acción con ese principal (null: anónima). */
  runWith<T>(principal: Principal | null, action: () => T): T {
    return storage.run(principal, action);
  }
};`;
}

// ─── access-rules.ts ─────────────────────────────────────────────────────────

function requirementLiteral(requirement) {
  if (requirement.kind === 'anyOf') return `{ kind: 'anyOf', authorities: [${requirement.authorities.map(tsString).join(', ')}] }`;
  return `{ kind: '${requirement.kind}' }`;
}

function accessRulesBody(model) {
  const plan = securityPlan(model);
  const chains = plan.chains.map((chain) => {
    const rules = chain.rules
      .map((rule) => `      { method: ${rule.method ? tsString(rule.method) : 'null'}, path: ${tsString(rule.path)}, requirement: ${requirementLiteral(rule.requirement)} }`)
      .join(',\n');
    return `  {
    paths: ${chain.paths ? `[${chain.paths.map(tsString).join(', ')}]` : 'null'},
    checksAudience: ${chain.checksAudience},
    rules: [
${rules}
    ],
    fallback: ${requirementLiteral(chain.fallback)}
  }`;
  });
  return `/**
 * La autorización de la entrada HTTP como DATOS, derivada del diseño (security.access) por el plan
 * neutral de keel-core: el mismo que el servidor de keel-spring escribe como su SecurityFilterChain.
 *
 * Se evalúa como una cadena de filtros: la petición cae en la PRIMERA cadena cuyo patrón de rutas
 * casa (sin mirar el método) y, dentro, en la PRIMERA regla que casa por método y ruta; si ninguna
 * casa, en el cierre de esa cadena. Un camino que no existe también cae ahí.
 */
export type Requirement =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'anyOf'; readonly authorities: readonly string[] };

interface Rule {
  readonly method: string | null;
  readonly path: string;
  readonly requirement: Requirement;
}

interface Chain {
  /** Las rutas que cubre la cadena (todas si es null). */
  readonly paths: readonly string[] | null;
  /** ¿Exige que el token esté emitido para este servicio (audiencia)? */
  readonly checksAudience: boolean;
  readonly rules: readonly Rule[];
  readonly fallback: Requirement;
}

export const CHAINS: readonly Chain[] = [
${chains.join(',\n')}
];

/** Lo que se decide para una petición: qué exige y si comprueba la audiencia. */
export interface Decision {
  readonly requirement: Requirement;
  readonly checksAudience: boolean;
}

/**
 * La petición vista por las reglas: su método, su camino ya decodificado y, si una ruta casó, su
 * patrón (\`/api/products/:id\`). Con patrón se compara la FORMA de la ruta, que es lo que vio el
 * enrutador: una regla no se puede esquivar codificando un carácter del camino.
 */
export interface Target {
  readonly method: string;
  readonly path: string;
  readonly pattern: string | null;
}

const PARAMETER = /\\{[^}]+\\}|:[^/]+/g;
const shapeOf = (path: string): string => path.replace(PARAMETER, '{}');
const REGEX = new Map<string, RegExp>();

function matches(rulePath: string, target: Target): boolean {
  if (target.pattern != null) return shapeOf(rulePath) === shapeOf(target.pattern);
  let regex = REGEX.get(rulePath);
  if (!regex) {
    const source = rulePath.split(/\\{[^}]+\\}/).map((part) => part.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('[^/]+');
    regex = new RegExp(\`^\${source}$\`);
    REGEX.set(rulePath, regex);
  }
  return regex.test(target.path);
}

/** La regla que se aplica a la petición. */
export function decide(target: Target): Decision {
  const method = target.method.toUpperCase();
  const chain = CHAINS.find((candidate) => candidate.paths == null || candidate.paths.some((path) => matches(path, target))) ?? CHAINS[CHAINS.length - 1]!;
  const rule = chain.rules.find((candidate) => (candidate.method == null || candidate.method === method) && matches(candidate.path, target));
  return { requirement: rule?.requirement ?? chain.fallback, checksAudience: chain.checksAudience };
}

/** El veredicto: concedida, falta credencial (401) o la credencial no basta (403). */
export function verdict(requirement: Requirement, principal: Principal | null): 'granted' | 'unauthenticated' | 'denied' {
  if (requirement.kind === 'public') return 'granted';
  if (principal == null) return 'unauthenticated';
  if (requirement.kind === 'authenticated') return 'granted';
  return requirement.authorities.some((authority) => principal.authorities.has(authority)) ? 'granted' : 'denied';
}`;
}

// ─── jwt-authenticator.ts ────────────────────────────────────────────────────

function jwtAuthenticator(model) {
  const sec = model.security;
  const claims = tokenClaims(model.stack?.auth);
  const cognito = model.stack?.auth === 'cognito';
  // Sin roles, permisos ni scopes en ninguna regla, Spring usa su conversor por defecto, cuyo
  // principal es el `sub`: el nombre que ve la identidad del llamante tiene que ser el mismo.
  const principalClaim = sec.usesAuthorities ? claims.principalClaim : 'sub';
  const grants = (sec.roleGrants ?? []).map((grant) => `  ${tsString(grant.role)}: [${grant.permissions.map(tsString).join(', ')}]`).join(',\n');
  const roles =
    claims.type === 'nested'
      ? `  const parent = payload[${tsString(claims.rolesParent)}];
  const roles = parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[${tsString(claims.rolesField)}] : undefined;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [];`
      : `  return textList(payload[${tsString(claims.rolesClaim)}]).filter((role) => role.trim() !== '');`;
  const audienceCheck = cognito
    ? `/**
 * ¿Está el token emitido para ESTE servicio? Cognito no pone \`aud\` en los tokens de
 * client_credentials: dice a qué API vale cada permiso con el PREFIJO del scope
 * (\`<audiencia>/<scope>\`), así que la audiencia es ese prefijo. Un token de usuario, sin scopes de
 * máquina, tampoco pasa — que es lo que la cadena de máquinas tiene que rechazar.
 */
export function issuedFor(principal: Principal, audience: string): boolean {
  const scope = principal.claims['scope'];
  return typeof scope === 'string' && scope.split(' ').some((value) => value.startsWith(\`\${audience}/\`));
}`
    : `/** ¿Está el token emitido para ESTE servicio? Su claim \`aud\` tiene que incluir la audiencia. */
export function issuedFor(principal: Principal, audience: string): boolean {
  const aud = principal.claims['aud'];
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}`;
  const body = `/**
 * Valida el JWT de la petición y lo convierte en un Principal con las authorities de Spring:
 * \`ROLE_<rol>\` (claim de roles del proveedor${claims.type === 'nested' ? `, anidado en \`${claims.rolesParent}.${claims.rolesField}\`` : `, \`${claims.rolesClaim}\``}),
 * \`SCOPE_<scope>\` (claim \`scope\`${cognito ? ', sin el prefijo del resource server que pone Cognito' : ''}), los permisos del claim
 * \`${claims.permissionsClaim}\` y los que otorga cada rol según el diseño (security.roleGrants).
 *
 * Las claves salen de la configuración, como en el resource server de Spring:
 *   · \`security.oauth2.issuer-uri\`: el discovery OIDC del emisor da el JWKS, y el claim \`iss\` tiene
 *     que ser exactamente ese emisor;
 *   · \`security.oauth2.jwk-set-uri\`: el JWKS directamente, sin comprobar \`iss\` (el emisor visto
 *     desde dentro de una red de contenedores no es el que firma los tokens pedidos desde fuera);
 *   · \`security.oauth2.jwks\`: el JWKS en línea, que solo usa el perfil \`test\` (lo publican las
 *     pruebas en ${TEST_JWKS_VARIABLE} con la clave con la que firman).
 * Se resuelven en la PRIMERA petición con token, no al arrancar: el servicio arranca aunque el
 * proveedor aún no esté, igual que el de keel-spring. Un fallo al resolverlas es un 500 (el servidor
 * no puede decidir), nunca un 401: diría al cliente que su credencial no vale cuando quien falla es
 * el proveedor.
 */
export class InvalidCredential extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidCredential';
  }
}

/** Permisos que otorga cada rol (security.roleGrants del diseño): ningún proveedor los emite. */
const ROLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
${grants}
};

/** El claim del nombre del principal. */
const PRINCIPAL_CLAIM = ${tsString(principalClaim)};

/** Margen de reloj al comprobar \`exp\` y \`nbf\`: el de Spring (60 s). */
const CLOCK_TOLERANCE_SECONDS = 60;

/** La forma de un bearer token (RFC 6750): Spring rechaza con 401 lo que no la tiene. */
const TOKEN_FORMAT = /^[A-Za-z0-9\\-._~+/]+=*$/;

interface Keys {
  readonly getKey: JWTVerifyGetKey | null;
  readonly issuer: string | undefined;
}

export class JwtAuthenticator {
  private keys: Promise<Keys> | null = null;

  private constructor(
    private readonly issuerUri: string | null,
    private readonly jwkSetUri: string | null,
    private readonly inlineJwks: string | null
  ) {}

  static from(configuration: Configuration): JwtAuthenticator {
    const text = (path: string): string | null => {
      const value = configuration.get(path);
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    };
    return new JwtAuthenticator(text('security.oauth2.issuer-uri'), text('security.oauth2.jwk-set-uri'), text('security.oauth2.jwks'));
  }

  /** El principal del token, o InvalidCredential si no vale (401). */
  async authenticate(token: string): Promise<Principal> {
    if (!TOKEN_FORMAT.test(token)) throw new InvalidCredential('El bearer token no tiene la forma de RFC 6750');
    const { getKey, issuer } = await this.resolveKeys();
    if (getKey == null) throw new InvalidCredential('No hay ninguna clave configurada con la que validar el token');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer, clockTolerance: CLOCK_TOLERANCE_SECONDS }));
    } catch (error) {
      // Lo que dice del TOKEN es un 401; lo que dice del PROVEEDOR (no responde, JWKS roto) no.
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout) && !(error instanceof errors.JWKSInvalid)) {
        throw new InvalidCredential(error.message);
      }
      throw error;
    }
    return toPrincipal(payload);
  }

  private resolveKeys(): Promise<Keys> {
    // Una resolución fallida no se queda en caché: la siguiente petición lo vuelve a intentar.
    this.keys ??= this.load().catch((error: unknown) => {
      this.keys = null;
      throw error;
    });
    return this.keys;
  }

  private async load(): Promise<Keys> {
    if (this.inlineJwks) return { getKey: createLocalJWKSet(JSON.parse(this.inlineJwks) as JSONWebKeySet), issuer: undefined };
    if (this.jwkSetUri) return { getKey: createRemoteJWKSet(new URL(this.jwkSetUri)), issuer: undefined };
    if (this.issuerUri) {
      const discovery = \`\${this.issuerUri.replace(/\\/$/, '')}/.well-known/openid-configuration\`;
      const response = await fetch(discovery, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(\`El discovery del emisor respondió \${response.status}: \${discovery}\`);
      const document = (await response.json()) as { jwks_uri?: unknown };
      if (typeof document.jwks_uri !== 'string') throw new Error(\`El discovery del emisor no trae jwks_uri: \${discovery}\`);
      return { getKey: createRemoteJWKSet(new URL(document.jwks_uri)), issuer: this.issuerUri };
    }
    // Sin ninguna fuente (el perfil test sin ${TEST_JWKS_VARIABLE}): ningún token vale.
    return { getKey: null, issuer: undefined };
  }
}

function toPrincipal(payload: JWTPayload): Principal {
  const roles = rolesOf(payload);
  const authorities = new Set<string>(roles.map((role) => \`ROLE_\${role}\`));
  for (const scope of scopesOf(payload)) authorities.add(\`SCOPE_\${scope}\`);
  for (const permission of textList(payload[${tsString(claims.permissionsClaim)}])) if (permission.trim() !== '') authorities.add(permission);
  for (const role of roles) for (const permission of ROLE_GRANTS[role] ?? []) authorities.add(permission);
  const name = payload[PRINCIPAL_CLAIM] ?? payload.sub;
  return { kind: 'token', name: name == null ? '' : String(name), authorities, claims: payload };
}

function rolesOf(payload: JWTPayload): string[] {
${roles}
}

function scopesOf(payload: JWTPayload): string[] {
  const scope = payload['scope'];
  if (typeof scope !== 'string') return [];
  return scope
    .split(' ')
    .filter((value) => value.trim() !== '')${cognito ? `
    // Cognito: <resource-server>/<scope>. Sin prefijo, se queda igual.
    .map((value) => value.slice(value.indexOf('/') + 1))` : ''};
}

/** Un claim de lista; un texto suelto cuenta como lista de uno, como getClaimAsStringList. */
function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? [value] : [];
}

${audienceCheck}`;
  return tsModule(
    JWT_AUTHENTICATOR_TS,
    [
      { symbol: 'createLocalJWKSet', from: 'jose' },
      { symbol: 'createRemoteJWKSet', from: 'jose' },
      { symbol: 'errors', from: 'jose' },
      { symbol: 'jwtVerify', from: 'jose' },
      { symbol: 'JSONWebKeySet', from: 'jose', type: true },
      { symbol: 'JWTPayload', from: 'jose', type: true },
      { symbol: 'JWTVerifyGetKey', from: 'jose', type: true },
      { symbol: 'Configuration', from: CONFIGURATION_TS, type: true },
      { symbol: 'Principal', from: SECURITY_CONTEXT_TS, type: true }
    ],
    body
  );
}

// ─── api-key-authenticator.ts ────────────────────────────────────────────────

function apiKeyAuthenticator(model) {
  const clients = apiKeyClients(model);
  const single = securityPlan(model).protocol === 'api-key';
  const body = `/**
 * Autentica por clave de API: compara la cabecera \`X-API-Key\` con ${
    single
      ? 'la clave del servicio (`security.api-key`). Coincide → el cliente `api-key-client`, sin authorities'
      : 'la de cada cliente máquina del diseño (`security.api-keys.<cliente>`). Coincide → ese cliente, con sus scopes como `SCOPE_<scope>`'
  }.
 * Sin coincidencia, la petición sigue sin autenticar (la rechaza la regla de la ruta si exige
 * credencial). Una clave vacía en la configuración deja a ese cliente deshabilitado.
 */
export const API_KEY_HEADER = 'X-API-Key';

interface Client {
  readonly name: string;
  readonly key: string;
  readonly authorities: readonly string[];
}

export class ApiKeyAuthenticator {
  private constructor(private readonly clients: readonly Client[]) {}

  static from(configuration: Configuration): ApiKeyAuthenticator {
    const key = (path: string): string => {
      const value = configuration.get(path);
      return value == null ? '' : String(value);
    };
    return new ApiKeyAuthenticator([
${clients.map((client) => `      { name: ${tsString(client.name)}, key: key(${tsString(client.key)}), authorities: [${client.authorities.map(tsString).join(', ')}] }`).join(',\n')}
    ]);
  }

  authenticate(provided: string): Principal | null {
    const offered = Buffer.from(provided);
    for (const client of this.clients) {
      if (client.key === '') continue;
      const expected = Buffer.from(client.key);
      // En tiempo constante: la comparación no dice cuántos caracteres acertó quien prueba claves.
      if (expected.length === offered.length && timingSafeEqual(expected, offered)) {
        return { kind: 'key', name: client.name, authorities: new Set(client.authorities), claims: {} };
      }
    }
    return null;
  }
}`;
  return tsModule(
    API_KEY_AUTHENTICATOR_TS,
    [
      { symbol: 'Buffer', from: 'node:buffer' },
      { symbol: 'timingSafeEqual', from: 'node:crypto' },
      { symbol: 'Configuration', from: CONFIGURATION_TS, type: true },
      { symbol: 'Principal', from: SECURITY_CONTEXT_TS, type: true }
    ],
    body
  );
}

// ─── cors-policy.ts ──────────────────────────────────────────────────────────

function corsPolicy(model) {
  const cors = model.security.cors;
  const list = (values) => `[${values.map(tsString).join(', ')}]`;
  const body = `/**
 * La política CORS del diseño (security.cors), con la semántica del DefaultCorsProcessor de Spring
 * que aplica el servidor de keel-spring:
 *   · una petición es CORS si trae \`Origin\` y no es del mismo origen;
 *   · un origen no permitido, o un método o unas cabeceras que la política no admite, se rechaza con
 *     403 «Invalid CORS request» — también la petición real, no solo el preflight;
 *   · el preflight (OPTIONS con \`Access-Control-Request-Method\`) se contesta aquí con 200, sin
 *     llegar a autenticar: no lleva credencial.
 * Los métodos salen de los endpoints del diseño (más OPTIONS); los orígenes, de la configuración
 * (\`security.cors.allowed-origins\`, una lista separada por comas, con \`*\` como comodín). Sin
 * ninguno, el servicio no acepta peticiones cross-origin.
 */
const ALLOWED_METHODS: readonly string[] = ${list(cors.methods)};
const ALLOWED_HEADERS: readonly string[] = ${list(cors.allowedHeaders)};
const EXPOSED_HEADERS: readonly string[] = ${list(cors.exposedHeaders)};
const ALLOW_CREDENTIALS = ${cors.allowCredentials};
const MAX_AGE_SECONDS = ${cors.maxAgeSeconds};

export type CorsOutcome = 'not-cors' | 'allowed' | 'preflight' | 'rejected';

export class CorsPolicy {
  private constructor(private readonly origins: readonly RegExp[]) {}

  static from(configuration: Configuration): CorsPolicy {
    const raw = configuration.get('security.cors.allowed-origins');
    const values = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(','))
      .map((origin) => origin.trim().replace(/\\/$/, ''))
      .filter((origin) => origin !== '');
    return new CorsPolicy(values.map(originPattern));
  }

  /** Decide y escribe las cabeceras; con \`rejected\` o \`preflight\` la respuesta la da quien llama. */
  apply(request: FastifyRequest, reply: FastifyReply): CorsOutcome {
    void reply.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    const origin = header(request, 'origin');
    if (origin == null || origin === \`\${request.protocol}://\${request.host}\`) return 'not-cors';
    const requestedMethod = header(request, 'access-control-request-method');
    const preflight = request.method === 'OPTIONS' && requestedMethod != null;

    if (!this.origins.some((pattern) => pattern.test(origin))) return 'rejected';
    const method = (preflight ? requestedMethod! : request.method).toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) return 'rejected';
    const requestedHeaders = preflight
      ? (header(request, 'access-control-request-headers') ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
      : [];
    const allowedHeaders = ALLOWED_HEADERS.includes('*')
      ? requestedHeaders
      : requestedHeaders.filter((name) => ALLOWED_HEADERS.some((allowed) => allowed.toLowerCase() === name.toLowerCase()));
    if (requestedHeaders.length > 0 && allowedHeaders.length === 0) return 'rejected';

    void reply.header('Access-Control-Allow-Origin', origin);
    if (preflight) {
      void reply.header('Access-Control-Allow-Methods', ALLOWED_METHODS.join(','));
      if (allowedHeaders.length > 0) void reply.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
    } else if (EXPOSED_HEADERS.length > 0) {
      void reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(', '));
    }
    if (ALLOW_CREDENTIALS) void reply.header('Access-Control-Allow-Credentials', 'true');
    if (preflight) void reply.header('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
    return preflight ? 'preflight' : 'allowed';
  }
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Un patrón de origen de Spring: \`*\` es cualquier cosa y \`:[*]\` cualquier puerto (o ninguno). */
function originPattern(pattern: string): RegExp {
  if (pattern === '*') return /^.*$/;
  const source = pattern
    .split(':[*]')
    .map((part) => part.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*'))
    .join('(:\\\\d+)?');
  return new RegExp(\`^\${source}$\`, 'i');
}`;
  return tsModule(
    CORS_POLICY_TS,
    [
      { symbol: 'FastifyReply', from: 'fastify', type: true },
      { symbol: 'FastifyRequest', from: 'fastify', type: true },
      { symbol: 'Configuration', from: CONFIGURATION_TS, type: true }
    ],
    body
  );
}

// ─── http-security.ts ────────────────────────────────────────────────────────

function httpSecurity(model) {
  const plan = securityPlan(model);
  const jwt = usesJwt(model);
  const keys = apiKeyClients(model).length > 0;
  const cors = Boolean(model.security?.cors);
  const audience = plan.audience;
  const unauthenticated = FRAMEWORK_ERRORS.unauthenticated.code;
  const denied = FRAMEWORK_ERRORS.accessDenied.code;
  const imports = [
    { symbol: 'FastifyInstance', from: 'fastify', type: true },
    { symbol: 'Configuration', from: CONFIGURATION_TS, type: true },
    { symbol: 'SecurityContext', from: SECURITY_CONTEXT_TS }
  ];
  if (!plan.open) {
    imports.push(
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'FastifyReply', from: 'fastify', type: true },
      { symbol: 'FastifyRequest', from: 'fastify', type: true },
      { symbol: 'ErrorResponse', from: ERROR_RESPONSE_TS },
      { symbol: 'Principal', from: SECURITY_CONTEXT_TS, type: true },
      { symbol: 'decide', from: ACCESS_RULES_TS },
      { symbol: 'verdict', from: ACCESS_RULES_TS }
    );
  }
  if (jwt) imports.push({ symbol: 'JwtAuthenticator', from: JWT_AUTHENTICATOR_TS }, { symbol: 'InvalidCredential', from: JWT_AUTHENTICATOR_TS });
  if (jwt && audience) imports.push({ symbol: 'issuedFor', from: JWT_AUTHENTICATOR_TS });
  if (keys) imports.push({ symbol: 'ApiKeyAuthenticator', from: API_KEY_AUTHENTICATOR_TS }, { symbol: 'API_KEY_HEADER', from: API_KEY_AUTHENTICATOR_TS });
  if (cors) imports.push({ symbol: 'CorsPolicy', from: CORS_POLICY_TS });

  const setup = [
    cors ? '  const cors = CorsPolicy.from(configuration);' : null,
    jwt ? '  const tokens = JwtAuthenticator.from(configuration);' : null,
    keys ? '  const keys = ApiKeyAuthenticator.from(configuration);' : null,
    jwt && audience ? `  const audience = String(configuration.get('security.audience') ?? ${tsString(audience)});` : null
  ].filter(Boolean);

  const corsBlock = cors
    ? `    // CORS antes que nada: el preflight no lleva credencial, y un rechazo tiene que salir con sus
    // cabeceras o el navegador no deja leerlo.
    const outcome = cors.apply(request, reply);
    if (outcome === 'rejected') {
      void reply.code(403).type('text/plain').send('Invalid CORS request');
      return;
    }
    if (outcome === 'preflight') {
      void reply.code(200).send();
      return;
    }
`
    : '';

  const decision = plan.open
    ? `    // El diseño declara la capa security sin autenticación (protocol: none): todo abierto.
    SecurityContext.runWith(null, done);`
    : `    authenticate(request${jwt ? ', tokens' : ''}${keys ? ', keys' : ''})
      .then((principal) => {
        const decision = decide({ method: request.method, path: decodedPath(request.url), pattern: request.routeOptions.url ?? null });${
          jwt && audience
            ? `
        // La audiencia es AUTORIZACIÓN, no autenticación: un token legítimo emitido para otro servicio
        // está autenticado y no autorizado (403), no es un token inválido (401).
        if (decision.checksAudience && principal?.kind === 'token' && !issuedFor(principal, audience)) return reject(reply, 403);`
            : ''
        }
        const outcome = verdict(decision.requirement, principal);
        if (outcome === 'unauthenticated') return reject(reply, 401);
        if (outcome === 'denied') return reject(reply, 403);
        SecurityContext.runWith(principal, done);
      })
      .catch((error: unknown) => {
        ${jwt ? 'if (error instanceof InvalidCredential) return reject(reply, 401);\n        ' : ''}// El servidor no puede decidir (el proveedor no responde): 500, nunca un 401 que culpe a la credencial.
        log.error('No se pudo autenticar la petición', error instanceof Error ? error.stack : String(error));
        void reply.code(500).send(ErrorResponse.of(500, 'Internal Server Error', null, 'Ocurrió un error inesperado'));
      });`;

  const authenticate = plan.open
    ? ''
    : `
/**
 * Quién llama. Un bearer token${jwt ? ' se valida, y si no vale es un 401 aunque la ruta sea pública (como el resource server de Spring)' : ' no se mira: el protocolo del diseño no es de token'};${
        keys ? ' si no hay, una clave de API que coincida autentica a su cliente;' : ''
      } si no hay nada, la petición es anónima.
 */
async function authenticate(request: FastifyRequest${jwt ? ', tokens: JwtAuthenticator' : ''}${keys ? ', keys: ApiKeyAuthenticator' : ''}): Promise<Principal | null> {
${
  jwt
    ? `  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && /^bearer/i.test(authorization)) {
    const token = /^bearer (.+)$/i.exec(authorization)?.[1]?.trim() ?? '';
    return tokens.authenticate(token);
  }
`
    : ''
}${
  keys
    ? `  const key = request.headers[API_KEY_HEADER.toLowerCase()];
  if (typeof key === 'string' && key !== '') return keys.authenticate(key);
`
    : ''
}  return null;
}

/** El camino de la petición, sin query y decodificado: lo que compara una regla cuando no casó ninguna ruta. */
function decodedPath(url: string): string {
  const path = url.split('?')[0] ?? url;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** 401 y 403 con el ErrorResponse del contrato y su code del catálogo, como SecurityErrorHandlers. */
function reject(reply: FastifyReply, status: 401 | 403): void {
  const body =
    status === 401
      ? ErrorResponse.of(401, 'Unauthorized', '${unauthenticated}', 'Credenciales ausentes o no válidas')
      : ErrorResponse.of(403, 'Forbidden', '${denied}', 'La credencial no autoriza esta operación');
  void reply.code(status).send(body);
}`;

  const body = `/**
 * La seguridad de la entrada HTTP: un hook \`onRequest\` que se instala DESPUÉS del de correlación
 * (el rechazo lleva su correlationId) y ANTES de que Nest enrute.
 *
 * Es un hook y no un Guard por equivalencia con el servidor de keel-spring: Spring Security decide
 * antes de enrutar, así que sin credencial un camino que no existe responde 401 (no 404) y uno que
 * existe con otro método, también. Un Guard solo corre cuando una ruta casa.
 *
 * Deja el principal abierto (SecurityContext) para todo lo que haga la petición: la identidad del
 * llamante y el alcance por recurso lo leen de ahí.
 */
${plan.open ? '' : "const log = new Logger('HttpSecurity');\n\n"}export function installSecurity(fastify: FastifyInstance, configuration: Configuration): void {
${setup.join('\n')}${setup.length > 0 ? '\n' : ''}
  fastify.addHook('onRequest', (request, reply, done) => {
${corsBlock}${decision}
  });
}
${authenticate}`;
  return tsModule(HTTP_SECURITY_TS, imports, body);
}

// ─── caller-identity.ts ──────────────────────────────────────────────────────

function callerIdentity(model) {
  const identity = model.security.callerIdentity;
  const extract =
    identity.source === 'claim'
      ? `    const value = text(principal.claims[${tsString(identity.claim ?? 'sub')}]);`
      : `    // El cliente máquina de la credencial: Keycloak lo pone en \`azp\` y otros proveedores en
    // \`client_id\`; con client_credentials, el nombre del principal también es el cliente.
    const value = text(principal.claims['azp']) ?? text(principal.claims['client_id']) ?? text(principal.name);`;
  const body = `/**
 * De dónde sale, por HTTP, la identidad de QUIÉN pide el trabajo (security.authentication.callerIdentity):
 * ${identity.source === 'claim' ? `el claim \`${identity.claim ?? 'sub'}\` del token` : 'el cliente máquina de la credencial'}, que llega al campo \`${identity.field}\` del mensaje.
 *
 * Un solo punto de resolución: la operación la recibe ya resuelta y en ningún otro sitio se vuelve a
 * mirar el token. El campo NO se acepta del cuerpo de la petición: quien la hace es justamente quien
 * no debería poder elegir en nombre de quién actúa.
 */
export const CallerIdentity = {
  /**
   * El identificador del llamante, ya resuelto. Lanza si no hay: una operación que lo necesita no
   * puede continuar sin él, y seguir con un valor vacío escribiría datos a nombre de nadie. La regla
   * de acceso ya rechaza al anónimo, así que llegar aquí sin token es un fallo de configuración.
   */
  resolve(): string {
    const principal = SecurityContext.current();
    if (principal == null || principal.kind !== 'token') {
      throw new Error("No hay credencial en el contexto: '${identity.field}' se resuelve de la identidad del llamante.");
    }
${extract}
    if (value == null || value.trim() === '') {
      throw new Error("La credencial no identifica ningún recurso para '${identity.field}'.");
    }
    return value;
  }
};

/** Un claim como texto, como getClaimAsString: un número o un booleano se convierten; lo demás no. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}`;
  return tsModule(CALLER_IDENTITY_TS, [{ symbol: 'SecurityContext', from: SECURITY_CONTEXT_TS }], body);
}

// ─── El alcance por recurso: CallerScope ─────────────────────────────────────

function callerScope(model) {
  const scoping = model.security.scoping;
  const exempt = scoping.exemptRoles;
  const exemptDoc = exempt.length > 0 ? exempt.map((role) => `\`${role}\``).join(', ') : 'ninguno';
  const port = `/**
 * Alcance por recurso del llamante (security.authentication.scoping: claim \`${scoping.claim}\` sobre
 * \`${scoping.over}\`).
 *
 * Es un puerto para que los handlers no sepan de tokens: lo implementa JwtCallerScope en
 * infrastructure leyendo el principal de la petición en curso. Solo tiene sentido dentro de una
 * petición HTTP; los listeners y los barridos no lo consultan.
 */
export abstract class CallerScope {
  /** El llamante está exento del alcance (roles exentos del diseño: ${exemptDoc}). */
  abstract isExempt(): boolean;

  /** Los valores de \`${scoping.over}\` que enumera el claim del llamante (vacío si no trae ninguno). */
  abstract scopedValues(): ReadonlySet<string>;

  /** ¿El valor está en el alcance? Se evalúa contra el valor tal como llega, exista o no. */
  covers(value: string | null | undefined): boolean {
    return this.isExempt() || (value != null && this.scopedValues().has(value));
  }
}`;
  const adapter = `/**
 * Alcance por recurso leído del token de la petición en curso (security.authentication.scoping):
 * el claim \`${scoping.claim}\` como lista o como texto separado por comas o espacios; exentos, los roles
 * ${exemptDoc}. Sin dependencias: Nest lo construye sin decorador (SecurityModule).
 */
const SCOPING_CLAIM = ${tsString(scoping.claim)};
const EXEMPT_AUTHORITIES: readonly string[] = [${exempt.map((role) => tsString(`ROLE_${role}`)).join(', ')}];

export class JwtCallerScope extends CallerScope {
  isExempt(): boolean {
    const principal = SecurityContext.current();
    return principal != null && EXEMPT_AUTHORITIES.some((authority) => principal.authorities.has(authority));
  }

  scopedValues(): ReadonlySet<string> {
    const principal = SecurityContext.current();
    if (principal == null || principal.kind !== 'token') return new Set();
    const claim = principal.claims[SCOPING_CLAIM];
    if (Array.isArray(claim)) return new Set(claim.map(String));
    if (typeof claim === 'string') return new Set(claim.split(/[\\s,]+/).filter((part) => part !== ''));
    return new Set();
  }
}`;
  const module = `/**
 * El puerto del alcance por recurso y su adaptador, a disposición de todos los handlers (global):
 * los cablea UseCaseModule por el token CallerScope.
 */
@Global()
@Module({
  providers: [{ provide: CallerScope, useClass: JwtCallerScope }],
  exports: [CallerScope]
})
export class SecurityModule {}`;
  return [
    { path: CALLER_SCOPE_TS, content: tsModule(CALLER_SCOPE_TS, [], port) },
    {
      path: JWT_CALLER_SCOPE_TS,
      content: tsModule(
        JWT_CALLER_SCOPE_TS,
        [
          { symbol: 'CallerScope', from: CALLER_SCOPE_TS },
          { symbol: 'SecurityContext', from: SECURITY_CONTEXT_TS }
        ],
        adapter
      )
    },
    {
      path: SECURITY_MODULE_TS,
      content: tsModule(
        SECURITY_MODULE_TS,
        [
          { symbol: 'Global', from: '@nestjs/common' },
          { symbol: 'Module', from: '@nestjs/common' },
          { symbol: 'CallerScope', from: CALLER_SCOPE_TS },
          { symbol: 'JwtCallerScope', from: JWT_CALLER_SCOPE_TS }
        ],
        module
      )
    }
  ];
}

// ─── Configuración: config/parameters/<perfil>/security.yaml ────────────────

// El gradiente de keel-spring, con sus mismas variables de entorno: literal en local, `${VAR:default}`
// en develop y `${VAR}` sin default en production.
function envValue(profile, name, local) {
  if (profile === 'local' || profile === 'test') return String(local);
  if (profile === 'develop') return `\${${name}:${local}}`;
  return `\${${name}}`;
}

function envRequired(profile, name, local) {
  if (profile === 'local' || profile === 'test') return String(local);
  return `\${${name}}`;
}

/** El issuer del perfil local: el del proveedor de prueba de infra/, el mismo que en keel-spring. */
export function localIssuer(model) {
  if (model.stack?.auth === 'keycloak') return `http://localhost:8180/realms/${model.service.name}`;
  if (model.stack?.auth === 'cognito') return `http://localhost:9229/${model.service.name}`;
  return 'https://tu-issuer';
}

function configFragments(model) {
  const sec = model.security;
  const plan = securityPlan(model);
  return ['local', 'develop', 'production', 'test'].map((profile) => {
    const lines = ['security:'];
    if (usesJwt(model)) {
      lines.push('  oauth2:');
      if (profile === 'test') {
        lines.push(
          '    # Perfil test: no hay proveedor de identidad. Las pruebas firman sus tokens con una clave',
          `    # propia y publican su JWKS en ${TEST_JWKS_VARIABLE}; sin ella, ningún token vale.`,
          `    jwks: \${${TEST_JWKS_VARIABLE}:}`
        );
      } else {
        if (profile === 'local') {
          lines.push(
            model.stack?.auth === 'keycloak' || model.stack?.auth === 'cognito'
              ? '    # El proveedor de identidad de prueba de infra/docker-compose.yaml.'
              : '    # TODO (agente): issuer real del resource server según security.keel.yaml.'
          );
        }
        lines.push(`    issuer-uri: ${envValue(profile, 'OAUTH2_ISSUER_URI', localIssuer(model))}`);
      }
    }
    if (plan.protocol === 'api-key') {
      lines.push(
        profile === 'production'
          ? '  # Clave que deben enviar los clientes; obligatoria (sin ella la app no arranca).'
          : '  # Clave que deben enviar los clientes; esta es la de los escenarios de validación.',
        `  api-key: ${envRequired(profile, 'SECURITY_API_KEY', LOCAL_API_KEY)}`
      );
    }
    // Como keel-spring: la variable existe siempre que el diseño valida la audiencia (y en production
    // es obligatoria), aunque hoy ninguna ruta de máquinas la compruebe. Las dos imágenes del mismo
    // diseño se despliegan con las mismas variables.
    if (usesJwt(model) && sec.serviceAuth?.validateAudience === true) {
      lines.push('  # Audiencia que tienen que traer los tokens de los clientes máquina.', `  audience: ${envValue(profile, 'SECURITY_AUDIENCE', audienceOf(model))}`);
    }
    if (plan.serviceApiKeys) {
      lines.push('  # Clave por cliente máquina del diseño (serviceClients); vacía = cliente deshabilitado.', '  api-keys:');
      for (const client of sec.serviceClients) {
        lines.push(`    ${client.name}: ${envRequired(profile, `API_KEY_${client.name.replace(/-/g, '_').toUpperCase()}`, localClientApiKey(client.name))}`);
      }
    }
    if (sec.cors) {
      lines.push(
        '  cors:',
        profile === 'local' || profile === 'test'
          ? '    # Orígenes del navegador (CSV); estos son los puertos de dev habituales de una SPA.'
          : '    # Orígenes del navegador (CSV); obligatorio (sin él la app no arranca).',
        `    allowed-origins: ${envRequired(profile, 'SECURITY_CORS_ALLOWED_ORIGINS', LOCAL_CORS_ORIGINS)}`
      );
    }
    return lines.length > 1 ? { path: `config/parameters/${profile}/security.yaml`, content: `${lines.join('\n')}\n` } : null;
  }).filter(Boolean);
}

export { audienceOf };
