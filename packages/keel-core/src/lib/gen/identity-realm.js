// El proveedor de identidad de prueba como DATO derivado del diseño (keel-core/gen).
//
// NEUTRAL: el realm, sus usuarios, sus clientes y sus credenciales son los mismos para cualquier
// generador del mismo diseño —el servicio de keel-spring y el de keel-nest se prueban contra el
// mismo realm—. Cada generador renderiza desde aquí sus artefactos (en keel-spring,
// `src/scaffold/auth-provisioning.js`: el script de kcadm, `test-credentials.env` y la
// configuración del emulador de Cognito). Lo de abajo cuenta cómo lo consume keel-spring, que es
// la implementación de referencia.
//
// Existe porque el realm, el cliente de test, los usuarios y los secretos M2M son
// un CONTRATO entre dos agentes (keel-spring-infra los crea, keel-spring-tests los
// consume desde AbstractFlowIT) que hasta ahora solo vivía en prosa: cada uno lo
// reinventaba desde su lectura de la convention y el desajuste solo aparecía al
// ejecutar la suite entera. Aquí se materializa una única vez, derivado del diseño:
//
//   infra/init-keycloak.sh     — lo que hay que crear (realm, roles, usuarios,
//                                clientes de diseño y la matriz M2M de prueba).
//   infra/test-credentials.env — los valores con los que se crea, que es lo que
//                                AbstractFlowIT lee. Un solo productor, un solo
//                                consumidor, ningún literal inventado a los dos lados.
//
// El agente de infraestructura ya no escribe el script: lo ejecuta y verifica.

import { AUTH } from './infra-catalog.js';

export const TEST_USER_PASSWORD = 'password';
// Secreto de los clientes M2M que solo existen para las variantes negativas de los
// escenarios; es el valor que documenta skills/keel-spring-keycloak/references/test-clients.md.
export const TEST_CLIENT_SECRET = 'test-secret';
// Usuario sin ningún rol: el 403 por rol insuficiente necesita un sujeto autenticado.
export const NO_ROLE_USER = 'no-role';
// Resource server ajeno, para la variante negativa de la matriz M2M con Cognito: es
// el prefijo de scope que hace que el token esté emitido para OTRA API.
export const FOREIGN_RESOURCE_SERVER = 'audiencia-ajena';
// Valor del claim de alcance cuando el diseño no declara ningún `serviceClient`: sin superficie
// M2M, el recurso acotado no tiene que originar tráfico y cualquier código sirve.
const SCOPED_FALLBACK = 'keel-scoped-resource';

/** El recurso acotado con el que se siembran los usuarios de prueba: lo deriva el modelo. */
export function scopedValue(model) {
  return model.security?.scoping?.testResource ?? SCOPED_FALLBACK;
}
/** El segundo usuario de un rol: `tokenFor(rol, 2)` en el arnés. */
export function secondUserOf(role) {
  return `${role}-2`;
}

/** Los roles de un usuario de prueba: el suyo si es `<rol>` o `<rol>-2`, ninguno si es `no-role`. */
function roleOfUser(username, roles) {
  if (roles.includes(username)) return [username];
  const base = roles.find((role) => secondUserOf(role) === username);
  return base ? [base] : [];
}

/** Protocolos de identidad basados en token: son los que necesitan aprovisionamiento. */
export function usesTokens(model) {
  const protocol = model.security?.protocol ?? 'none';
  return protocol === 'oidc' || protocol === 'jwt';
}

/** Secreto del cliente máquina declarado en el diseño. Convención: `<cliente>-secret`. */
export function serviceClientSecret(clientName) {
  return `${clientName}-secret`;
}

/** Clave por cliente en test-credentials.env (`AUTH_CLIENT_SECRET_<CLIENTE>`). */
export function secretEnvKey(clientName) {
  return `AUTH_CLIENT_SECRET_${clientName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Sondeos de `validate-infra.sh` para el ALCANCE POR RECURSO: cada usuario que debe llevar el
 * claim lo lleva de verdad en su token.
 *
 * Existe porque el aprovisionamiento puede salir en verde con el atributo escrito en el usuario
 * equivocado (corrida notifications, 2026-09-30: `user_id_of` resolvía `editor` a `editor-2`), y
 * entonces lo único que se ve son veinte escenarios en 403 sin pista. Aquí se pide el token por
 * la red del compose, se decodifica el payload (base64url) y se exige el claim con su valor.
 * Usuarios y valor salen de `realmSpec()`, la misma fuente que siembra el realm: un sondeo con
 * su propia lista comprobaría una copia de sí mismo. Solo con Keycloak: es el proveedor cuyo
 * realm siembra un script.
 */
export function scopingClaimChecks(model) {
  if (model.stack?.auth !== 'keycloak') return [];
  const spec = realmSpec(model);
  if (!spec?.scoping || !spec.userClient) return [];
  const claim = spec.scoping.claim;
  const url = `http://keycloak:8080/realms/${spec.realm}/protocol/openid-connect/token`;
  return spec.users
    .filter((user) => (user.attributes?.[claim] ?? []).length > 0)
    .map((user) => {
      const expected = JSON.stringify({ [claim]: user.attributes[claim] }).slice(1, -1);
      return {
        label: `Claim '${claim}' en el token de ${user.username} (keycloak)`,
        cmd:
          `T=$(curl -sf -d grant_type=password -d client_id=${spec.userClient} -d username=${user.username} ` +
          `-d password=${spec.password} ${url} | sed 's/.*"access_token":"\\([^"]*\\)".*/\\1/'); ` +
          `P=$(echo "$T" | cut -d. -f2 | tr '_-' '/+'); ` +
          `while [ $((\${#P} % 4)) -ne 0 ]; do P="$P="; done; ` +
          `echo "$P" | base64 -d 2>/dev/null | grep -qF '${expected}'`
      };
    });
}

/** URL del endpoint de token del proveedor del stack. */
export function tokenUrl(model) {
  const port = AUTH[model.stack.auth]?.port ?? 8180;
  // Con cognito, el emulador local sirve OAuth2 estándar bajo el issuerId (que es
  // el nombre del servicio): por eso el arnés no necesita ninguna rama propia y
  // pide los tokens igual que con Keycloak.
  return model.stack.auth === 'cognito'
    ? `http://localhost:${port}/${model.service.name}/token`
    : `http://localhost:${port}/realms/${model.service.name}/protocol/openid-connect/token`;
}

/**
 * Cliente público con el que AbstractFlowIT pide tokens de usuario. El nombre es el
 * artifactId **del proyecto Gradle** (`<servicio>-spring`), que es lo que dice la
 * convention infra-validation.md § Obtener un token — no el nombre del servicio.
 */
export function userTestClient(model) {
  return `${model.service.projectName}-test`;
}

/**
 * ¿Necesita el arnés tokens de PERSONA —un `sub` elegido por el escenario y claims por petición—?
 *
 * Cuando la identidad del llamante sale del claim `sub`, los escenarios hablan de titulares
 * concretos («el perfil de `sub-ana-001`», «el mismo token sin `email`»), y `tokenFor(rol)` no
 * los puede dar: su `sub` es el id aleatorio que Keycloak asigna al usuario del rol y no lleva
 * más claims que los del realm. En la corrida user-profile (2026-10-01) el agente de pruebas
 * escribió 300 líneas de soporte para suplirlo, y su primera pasada dejó 38 escenarios sin
 * ejercitar porque Keycloak 26 ignora el `id` de `POST /users`.
 *
 * Solo Keycloak: el emulador de Cognito (mock-oauth2-server) fija los claims en su configuración
 * con plantillas de valores conocidos (`${clientId}`, `${username}`), no por petición, así que
 * ahí el método no se emite. Y sin roles no hay cliente de usuario contra el que pedir el token.
 */
export function usesPersonaTokens(model) {
  const identity = model.security?.callerIdentity;
  return (
    model.stack.auth === 'keycloak' &&
    identity?.source === 'claim' &&
    (identity.claim ?? 'sub') === 'sub' &&
    (model.security?.roles ?? []).length > 0
  );
}

/** Credenciales de administración del contenedor de Keycloak, tal como las declara el catálogo. */
export function keycloakAdminCredentials() {
  const env = AUTH.keycloak.composeServices().keycloak.environment;
  return { user: env.KC_BOOTSTRAP_ADMIN_USERNAME, password: env.KC_BOOTSTRAP_ADMIN_PASSWORD };
}

/** Clientes M2M que solo existen para las variantes negativas (matriz scope × audiencia). */
export function testM2mClients(model) {
  const serviceAuth = model.security?.serviceAuth;
  if (!serviceAuth || serviceAuth.protocol === 'api-key') return [];
  if ((model.security?.scopes ?? []).length === 0) return [];
  const clients = ['test-m2m-ok', 'test-m2m-no-scope'];
  if (serviceAuth.validateAudience) clients.push('test-m2m-bad-aud', 'test-m2m-none');
  // El recurso acotado necesita PODER ORIGINAR TRÁFICO, y con el valor derivado del diseño ya lo
  // puede: ES un `serviceClient` declarado, así que su credencial se crea con las demás. Aquí se
  // añadía antes un cliente de prueba con ese nombre — el parche a un problema que la derivación
  // elimina, y que además creaba una credencial que no correspondía a ningún recurso real.
  return clients;
}

/**
 * El realm de prueba como ESTRUCTURA DE DATOS, derivada del diseño.
 *
 * Fuente única de dos artefactos que describen lo mismo en formatos distintos:
 * `infra/init-keycloak.sh` (bash contra kcadm, para la generación) y
 * `deploy/keycloak/realm-export.json` (import declarativo, para las pruebas
 * manuales). Los dos renderizan desde aquí y ninguno recalcula nada, que es lo
 * único que impide que diverjan: un rol añadido al diseño aparece en ambos o en
 * ninguno. Hay además un test de paridad que compara los dos artefactos ya
 * renderizados, por si alguien se salta esta puerta.
 *
 * Devuelve null si el diseño no lleva identidad basada en token.
 */
export function realmSpec(model) {
  if (!model.layersPresent.security || !usesTokens(model)) return null;
  const security = model.security;
  const roles = security?.roles ?? [];
  const scopes = security?.scopes ?? [];
  const scoping = security?.scoping ?? null;
  const serviceClients = (security?.serviceClients ?? []).map((client) => ({
    name: client.name,
    secret: serviceClientSecret(client.name),
    // Un cliente sin scopes propios recibe todos los del servicio (mismo criterio
    // que el script original); se filtra por los declarados para no asignar uno
    // que no existe como client scope.
    scopes: (client.scopes.length > 0 ? client.scopes : scopes).filter((scope) => scopes.includes(scope))
  }));
  const m2m = testM2mClients(model);

  // Cada cliente de prueba varía UNA sola condición respecto al camino feliz:
  // 'ok' lleva audiencia buena y todos los scopes, 'no-scope' pierde los scopes,
  // 'bad-aud' cambia la audiencia, y 'none' es el control sin nada.
  const m2mClients = m2m.map((name) => ({
    name,
    secret: TEST_CLIENT_SECRET,
    audience: name === 'test-m2m-bad-aud' ? 'wrong' : name === 'test-m2m-none' ? null : 'ok',
    scopes: name === 'test-m2m-no-scope' || name === 'test-m2m-none' ? [] : scopes
  }));

  return {
    realm: model.service.name,
    audience: security?.serviceAuth?.audience ?? model.service.name,
    validateAudience: security?.serviceAuth?.validateAudience === true,
    password: TEST_USER_PASSWORD,
    // Sin roles no hay a quién pedirle un token de usuario —el arnés ni emite `tokenFor`—, así que
    // tampoco hay cliente público ni usuarios. Antes el script los prometía en su cabecera y en
    // `test-credentials.env` sin crear ninguno (corrida notification-mailer R8).
    userClient: roles.length > 0 ? userTestClient(model) : null,
    roles,
    // DOS usuarios por rol (`<rol>` y `<rol>-2`) más uno sin ninguno: el 403 por rol
    // insuficiente necesita un sujeto autenticado, y la titularidad («solo el que lo creó»)
    // necesita dos sujetos distintos con el MISMO rol. Con uno solo, el agente creaba el segundo
    // a mano en el arnés (corrida room-booking R8).
    users: (roles.length > 0 ? [...roles, ...roles.map(secondUserOf), NO_ROLE_USER] : []).map((username) => ({
      username,
      roles: roleOfUser(username, roles),
      // Alcance por recurso: el claim se proyecta desde un atributo de usuario del mismo
      // nombre, y solo lo llevan los roles que NO están exentos. Un usuario exento sin el
      // atributo es justamente lo que hace observable la exención — si todos lo llevaran,
      // el escenario que prueba que el administrador alcanza cualquier recurso no probaría
      // nada. El valor sale del DISEÑO (ver scopedValue) y viaja a test-credentials.env, de
      // donde lo lee el arnés: el escenario nombra la variable, nunca el literal.
      // El segundo usuario de un rol lleva el MISMO recurso: dos titulares del mismo alcance,
      // que es lo que separa «es de otro usuario» de «es de otro recurso».
      attributes:
        scoping && roleOfUser(username, roles).length > 0 && !scoping.exemptRoles.includes(roleOfUser(username, roles)[0])
          ? { [scoping.claim]: [scopedValue(model)] }
          : {}
    })),
    scoping,
    scopes,
    serviceClients,
    m2mClients
  };
}
