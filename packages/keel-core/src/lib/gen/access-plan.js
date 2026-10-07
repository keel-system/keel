// La autorización de la entrada HTTP como DATOS (keel-core/gen): qué exige cada regla de acceso del
// diseño, qué rutas comprueban la audiencia del token y en qué orden se evalúa todo.
//
// NEUTRAL: el servidor de keel-spring lo escribe como su SecurityFilterChain y el de keel-nest como un
// hook de la entrada HTTP, y los dos tienen que responder lo MISMO a la misma petición — el mismo 401,
// el mismo 403, la misma ruta abierta. Las decisiones que hay aquí se tomaban dentro del emisor de
// Spring; escritas dos veces, divergirían al primer matiz (qué rutas van a la cadena de máquinas, o si
// `level: admin` sin roles exige el rol `admin`).
//
// El modelo de evaluación es el de una cadena de filtros, que es el que tiene Spring Security y el que
// keel-nest reproduce: una petición cae en la PRIMERA cadena cuyo patrón de rutas casa (sin mirar el
// método), y dentro de ella en la PRIMERA regla que casa por método y ruta; si ninguna casa, en la
// regla de cierre de esa cadena. Las rutas que no existen también caen ahí: sin credencial, un camino
// inexistente responde 401 y no 404, igual en los dos servidores.

/** Las rutas técnicas abiertas: las sondas del servicio. No cuentan nada del negocio. */
export const TECHNICAL_OPEN_PATHS = ['/livez', '/readyz'];

/**
 * Lo que exige una regla de acceso del diseño (`security.access`), en authorities con el prefijo
 * convencional: `ROLE_<rol>` para un rol, el permiso tal cual (`recurso:accion`) y `SCOPE_<scope>`
 * para el scope de un cliente máquina. Varias a la vez son «cualquiera de».
 *
 *   · `public`                        → { kind: 'public' }
 *   · con roles, permisos o scopes    → { kind: 'anyOf', authorities }
 *   · `admin` sin nada nombrado       → { kind: 'anyOf', authorities: ['ROLE_admin'] }
 *   · `required`/`service` sin nada   → { kind: 'authenticated' }
 */
export function accessRequirement(rule) {
  if ((rule?.level ?? 'required') === 'public') return { kind: 'public', authorities: [] };
  const authorities = [
    ...(rule.roles ?? []).map((role) => `ROLE_${role}`),
    ...(rule.permissions ?? []),
    ...(rule.scopes ?? []).map((scope) => `SCOPE_${scope}`)
  ];
  if (authorities.length > 0) return { kind: 'anyOf', authorities };
  if (rule.level === 'admin') return { kind: 'anyOf', authorities: ['ROLE_admin'] };
  return { kind: 'authenticated', authorities: [] };
}

/** ¿La identidad es un token (oidc/jwt)? Las demás no tienen audiencia ni claims. */
export function usesTokenProtocol(security) {
  return security?.protocol === 'oidc' || security?.protocol === 'jwt';
}

/**
 * Clientes máquina por clave propia (`serviceAuth.protocol: api-key`) sobre una identidad de token: una
 * clave por `serviceClient`, con sus scopes como authorities. Con el protocolo principal `api-key`
 * basta la clave única del servicio.
 */
export function usesServiceApiKeys(security) {
  return security?.serviceAuth?.protocol === 'api-key' && security?.protocol !== 'api-key' && (security?.serviceClients?.length ?? 0) > 0;
}

/**
 * Las reglas de las rutas de audiencia `services` (clientes máquina). Las `both` quedan fuera a
 * propósito: las sirve también un usuario, cuyo token no lleva la audiencia del servicio.
 */
export function serviceMatchers(security) {
  return (security?.matchers ?? []).filter((matcher) => matcher.audience === 'services');
}

/**
 * ¿Se comprueba la audiencia del token? Solo donde hay rutas `audience: services`: sin ninguna, colgar
 * la comprobación de toda la API rechazaba con 403 cualquier token de usuario, cuya audiencia es la del
 * proveedor (`aud: account` en Keycloak) — lo vio dos veces seguidas la corrida asset-vault (R8).
 */
export function checksAudience(security) {
  return (
    usesTokenProtocol(security) &&
    security?.serviceAuth?.validateAudience === true &&
    !usesServiceApiKeys(security) &&
    serviceMatchers(security).length > 0
  );
}

/** La audiencia que tiene que traer el token: la del diseño o, por defecto, el nombre del servicio. */
export function audienceOf(model, security = model.security) {
  return security?.serviceAuth?.audience ?? model.service.artifactId;
}

/**
 * El plan completo de autorización de la entrada HTTP, o null sin capa security. Con el protocolo
 * `none` no hay nada que comprobar: todo abierto (`open: true`).
 *
 * `extraOpenPosts` son los POST que entran sin credencial por diseño de OTRA capa (el aviso de la
 * pasarela de pago, que se protege con su firma): van detrás de las rutas técnicas.
 *
 * Con audiencia comprobada y rutas de los DOS públicos, una sola cadena no sirve —la comprobación
 * rechazaría los tokens de usuario—, así que las rutas de máquinas van a una cadena PROPIA que se
 * evalúa primero, que no abre las rutas técnicas y cuyo cierre es «autenticado», no el del diseño.
 */
export function accessPlan(model, { extraOpenPosts = [] } = {}) {
  const security = model.layersPresent?.security ? model.security : null;
  if (!security) return null;
  if (security.protocol === 'none') return { protocol: 'none', open: true, chains: [] };

  const rule = (matcher) => ({ method: matcher.method, path: matcher.path, requirement: accessRequirement(matcher.access) });
  const machines = checksAudience(security) ? serviceMatchers(security) : [];
  const split = machines.length > 0 && machines.length < security.matchers.length;
  const mainRules = split ? security.matchers.filter((matcher) => !machines.includes(matcher)) : security.matchers;
  const open = { kind: 'public', authorities: [] };

  const chains = [];
  if (split) {
    chains.push({
      paths: [...new Set(machines.map((matcher) => matcher.path))],
      checksAudience: true,
      rules: machines.map(rule),
      fallback: { kind: 'authenticated', authorities: [] }
    });
  }
  chains.push({
    paths: null,
    // Sin cadena aparte y con rutas de máquinas, TODAS lo son: la audiencia se comprueba en la única.
    checksAudience: machines.length > 0 && !split,
    rules: [
      ...TECHNICAL_OPEN_PATHS.map((path) => ({ method: null, path, requirement: open })),
      ...extraOpenPosts.map((path) => ({ method: 'POST', path, requirement: open })),
      ...mainRules.map(rule)
    ],
    fallback: accessRequirement(security.defaultRule)
  });

  return {
    protocol: security.protocol,
    open: false,
    audience: machines.length > 0 ? audienceOf(model, security) : null,
    serviceApiKeys: usesServiceApiKeys(security),
    chains
  };
}

/**
 * Dónde lleva cada proveedor de identidad del stack los roles, los permisos y el nombre del principal.
 * Es conocimiento del TOKEN, no del lenguaje: los dos servidores leen los mismos claims. Keycloak anida
 * los roles en `realm_access.roles`; Cognito los da como grupos. Sin proveedor conocido, claims planos.
 */
export const TOKEN_CLAIMS = {
  keycloak: { type: 'nested', rolesParent: 'realm_access', rolesField: 'roles', permissionsClaim: 'permissions', principalClaim: 'preferred_username' },
  cognito: { type: 'flat', rolesClaim: 'cognito:groups', permissionsClaim: 'permissions', principalClaim: 'username' }
};

const GENERIC_TOKEN_CLAIMS = { type: 'flat', rolesClaim: 'roles', permissionsClaim: 'permissions', principalClaim: 'sub' };

/** Los claims del proveedor elegido en el stack (`stack.auth`). */
export function tokenClaims(auth) {
  return TOKEN_CLAIMS[auth] ?? GENERIC_TOKEN_CLAIMS;
}
