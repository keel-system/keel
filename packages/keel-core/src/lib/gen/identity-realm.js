// El proveedor de identidad de prueba como DATO derivado del diseño (keel-core/gen).
//
// NEUTRAL: el realm, sus usuarios, sus clientes y sus credenciales son los mismos para cualquier
// generador del mismo diseño —el servicio de keel-spring y el de keel-nest se prueban contra el
// mismo realm—. Sus artefactos de infra/ (el script de kcadm, `test-credentials.env` y la
// configuración del emulador de Cognito) también son neutrales: identity-provisioning.js, con los
// textos de la plataforma de cada generador. Lo de abajo cuenta cómo lo consume keel-spring, que es
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
import { identityProvider, providerPath, realmImportProvider } from './identity-providers.js';

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

/** Clave del id del cliente en test-credentials.env (`AUTH_CLIENT_ID_<CLIENTE>`), solo con un proveedor que genera ese id. */
export function clientIdEnvKey(clientName) {
  return `AUTH_CLIENT_ID_${clientName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
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
 * su propia lista comprobaría una copia de sí mismo. Con Keycloak y con el emulador de Cognito, que sirven
 * los dos el password grant del arnés.
 */
export function scopingClaimChecks(model) {
  const provider = model.stack?.auth;
  if (!identityProvider(provider).provisioning.kind) return [];
  const spec = realmSpec(model);
  if (!spec?.scoping || !spec.userClient) return [];
  const claim = spec.scoping.claim;
  // La red del compose: el token lo sirve el proveedor de prueba por su nombre de servicio. El emulador empareja al
  // usuario por el parámetro `username` del mismo grant.
  const url = providerInternalUrl(model, identityProvider(provider).provisioning.tokenPath);
  return spec.users
    .filter((user) => (user.attributes?.[claim] ?? []).length > 0)
    .map((user) => {
      const expected = JSON.stringify({ [claim]: user.attributes[claim] }).slice(1, -1);
      return {
        label: `Claim '${claim}' en el token de ${user.username} (${provider})`,
        cmd:
          `T=$(curl -sf -d grant_type=password -d client_id=${spec.userClient} -d username=${user.username} ` +
          // El emulador de Cognito responde el JSON formateado (varias líneas, `"access_token" : "…"`) y Keycloak
          // compacto: se aplana y se admiten espacios, o con Cognito la extracción no casaba y el sondeo salía rojo.
          `-d password=${spec.password} ${url} | tr -d '\\n\\r' | sed 's/.*"access_token" *: *"\\([^"]*\\)".*/\\1/'); ` +
          `P=$(echo "$T" | cut -d. -f2 | tr '_-' '/+'); ` +
          `while [ $((\${#P} % 4)) -ne 0 ]; do P="$P="; done; ` +
          `echo "$P" | base64 -d 2>/dev/null | grep -qF '${expected}'`
      };
    });
}

/** URL del endpoint de token del proveedor del stack. */
export function tokenUrl(model) {
  const port = AUTH[model.stack.auth]?.port ?? 8180;
  // El emulador sirve OAuth2 estándar bajo el issuerId (el nombre del servicio): por eso el arnés no necesita ninguna
  // rama propia y pide los tokens igual con cualquier proveedor.
  return `http://localhost:${port}${providerPath(identityProvider(model.stack.auth).provisioning.tokenPath, model.service.name)}`;
}

/** Una ruta del proveedor de prueba vista desde la red del compose, donde se le alcanza por su nombre de servicio. */
export function providerInternalUrl(model, template) {
  const { provisioning } = identityProvider(model.stack.auth);
  return `http://${AUTH[model.stack.auth].serviceKey}:${provisioning.internalPort}${providerPath(template, model.service.name)}`;
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
 * Con Keycloak la persona se da de alta por la API de administración del realm; con un emulador
 * (mock-oauth2-server, el de Cognito) viaja en la petición y cada forma es un mapping de su
 * configuración (incremento 4.3 de PLAN-PROVEEDOR-IDENTIDAD.md: `personaTokenMechanism`). Un proveedor
 * sin ninguno de los dos mecanismos no lo emite. No hace falta ningún rol: un diseño sin roles cuya identidad es el `sub`
 * (conduit, recuperado de RealWorld: «solo el autor edita su artículo») necesita dos personas
 * distintas más que nadie, y hasta el DSL 2.23 se quedaba sin cliente de usuario y sin `tokenAs` —
 * el agente de pruebas del inc. 1 de keel-recover escribió su propio emisor de personas a mano.
 *
 * Y no solo con el `sub`: con la identidad en OTRO claim (`email`, en shop-api, recuperado de un legacy que identificaba
 * por email) los escenarios nombran a sus actores por ese valor («customer1@email.com», «un token sin email», «Bob@x.io
 * frente a bob@x.io»), y los usuarios del realm, con su `<rol>@example.com`, no los pueden dar. La persona lleva el claim
 * como cualquier otro (`kp_<claim>` con su mapper), y un claim quitado da el token sin él. La corrida de control de
 * shop-api dejó así 12 escenarios sin poder pedir su token.
 */
export function usesPersonaTokens(model) {
  const identity = model.security?.callerIdentity;
  return identityProvider(model.stack.auth).harness.personaTokens && identity?.source === 'claim';
}

/**
 * ¿Lleva el realm el cliente público de los tokens de usuario? Con roles (sus usuarios piden token
 * por él) o con personas (`tokenAs` también): fuente única de las tres proyecciones del realm y de
 * `test-credentials.env`.
 */
export function usesUserClient(model) {
  return (model.security?.roles ?? []).length > 0 || usesPersonaTokens(model);
}

/**
 * ¿Necesita el arnés tokens con OTRO valor del claim del alcance (`tokenWithScope(rol, valores…)`)?
 *
 * El realm siembra a cada usuario no exento con UN valor del claim (`scopedValue`), y es el único
 * que `tokenFor(rol)` puede dar. Los escenarios del alcance hablan además de un titular cuyo claim
 * enumera OTRO recurso, o varios, o ninguno («un custodio con vaults = ["OTRO"]»), y eso no se podía
 * pedir: las tres corridas de asset-vault (dos de keel-spring y una de keel-nest) lo dejaron como
 * hueco del arnés (`test-realm-claim-values`). Con el mecanismo que diga el descriptor, como
 * `usesPersonaTokens`: con el emulador, un mapping por cantidad de valores. Y hace falta un rol
 * no exento: con todos exentos el claim no acota nada.
 */
export function usesScopedTokens(model) {
  const scoping = model.security?.scoping;
  const roles = model.security?.roles ?? [];
  return identityProvider(model.stack.auth).harness.scopedTokens && Boolean(scoping) && roles.some((role) => !scoping.exemptRoles.includes(role));
}

/**
 * CÓMO da el arnés esos tokens con el proveedor del stack, o null si no los da: `realm-admin` (los da de alta por la API de
 * administración del realm, Keycloak) o `emulator` (los pide al emulador con la forma en la petición: medido en el
 * incremento 4.2 de PLAN-PROVEEDOR-IDENTIDAD.md, sin estado que sembrar).
 */
export function personaTokenMechanism(model) {
  return usesPersonaTokens(model) ? identityProvider(model.stack.auth).harness.personaTokens : null;
}

/** Lo mismo para `tokenWithScope`. */
export function scopedTokenMechanism(model) {
  return usesScopedTokens(model) ? identityProvider(model.stack.auth).harness.scopedTokens : null;
}

/** ¿Hace falta la API de administración del realm en el arnés (y sus credenciales en test-credentials.env)? */
export function usesRealmAdmin(model) {
  return personaTokenMechanism(model) === 'realm-admin' || scopedTokenMechanism(model) === 'realm-admin';
}

// ─── Personas y alcance contra el emulador ───────────────────────────────────
//
// El emulador (mock-oauth2-server) no guarda usuarios: sustituye en cada token los parámetros de la PETICIÓN (T1, medido
// con la 6.0.1). Pero solo dentro de la forma fija de un mapping: un parámetro ausente deja el literal `${x}` en el token
// y uno vacío da `[""]`, no la lista vacía (incremento 4.2). Así que hay un mapping por FORMA —con o sin rol, qué claims
// lleva la persona, cuántos valores lleva el claim del alcance— y el arnés dice cuál quiere. Los nombres de los
// parámetros son contrato entre el emulador (identity-provisioning.js) y el arnés de los cuatro generadores.

export const EMULATOR_PARAMS = {
  persona: 'keel_persona',
  sub: 'keel_sub',
  role: 'keel_role',
  claimPrefix: 'keel_claim_',
  scoped: 'keel_scoped',
  user: 'keel_user',
  valuePrefix: 'keel_value_'
};

/** Cuántos valores del claim del alcance puede pedir `tokenWithScope` al emulador: un mapping por aridad, de 0 a este. */
export const EMULATOR_MAX_SCOPE_VALUES = 4;

/**
 * Los claims, además del `sub`, que una persona puede llevar en el emulador: los que el diseño lee del token para la
 * identidad. Otro no tiene mapping, y el arnés lo rechaza con `EMULATOR_PERSONA_CLAIM_UNKNOWN`.
 */
export function emulatorPersonaClaims(model) {
  const claim = model.security?.callerIdentity?.claim;
  return claim && claim !== 'sub' ? [claim] : [];
}

/** La forma de una persona: con rol o sin él, y qué claims lleva (ordenados). La misma cadena en el emulador y en los arneses. */
export function emulatorPersonaShape(hasRole, claimNames) {
  return `${hasRole ? 'role' : 'norole'}:${[...claimNames].sort().join(',')}`;
}

export const EMULATOR_PERSONA_CLAIM_UNKNOWN =
  'el emulador del proveedor solo pone en una persona los claims que el diseño lee del token (la identidad del llamante), porque cada forma de token es un mapping de su configuración';
export const EMULATOR_SCOPE_VALUES_EXCEEDED = `el emulador del proveedor da como mucho ${EMULATOR_MAX_SCOPE_VALUES} valores del claim del alcance, uno por mapping de su configuración`;

/**
 * La petición que pide al emulador el token de una persona: la REFERENCIA EJECUTABLE de lo que escribe el `tokenAs` de los
 * cuatro arneses. `claims` como el de `tokenAs`: un valor null quita el claim.
 */
export function emulatorPersonaForm(model, sub, claims = {}, role = null) {
  const allowed = emulatorPersonaClaims(model);
  const present = Object.entries(claims).filter(([, value]) => value !== null && value !== undefined);
  const unknown = present.map(([name]) => name).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) throw new Error(`tokenAs: ${unknown.join(', ')}: ${EMULATOR_PERSONA_CLAIM_UNKNOWN}`);
  return {
    [EMULATOR_PARAMS.persona]: emulatorPersonaShape(role !== null, present.map(([name]) => name)),
    [EMULATOR_PARAMS.sub]: sub,
    ...(role !== null ? { [EMULATOR_PARAMS.role]: role } : {}),
    ...Object.fromEntries(present.map(([name, value]) => [`${EMULATOR_PARAMS.claimPrefix}${name}`, value]))
  };
}

/** La petición de `tokenWithScope(role, ...values)` al emulador; `user` es el nombre determinista del titular. */
export function emulatorScopedForm(user, role, values) {
  const wanted = [...new Set(values)].sort();
  if (wanted.length > EMULATOR_MAX_SCOPE_VALUES) throw new Error(`tokenWithScope: ${wanted.length} valores: ${EMULATOR_SCOPE_VALUES_EXCEEDED}`);
  return {
    [EMULATOR_PARAMS.scoped]: String(wanted.length),
    [EMULATOR_PARAMS.user]: user,
    [EMULATOR_PARAMS.role]: role,
    ...Object.fromEntries(wanted.map((value, i) => [`${EMULATOR_PARAMS.valuePrefix}${i + 1}`, value]))
  };
}

/**
 * El `sub` de una persona es el id del usuario en Keycloak (`USER_ENTITY.ID`, VARCHAR(36)): con uno más largo, `partialImport`
 * responde 500 y no hay token, y el fallo sale lejos de su causa (71 flujos de shop-api en keel-spring, 2026-11-10). El arnés
 * de los cuatro generadores lo rechaza antes de llamar a nadie, con este motivo.
 */
export const PERSONA_SUB_MAX = 36;
export const PERSONA_SUB_TOO_LONG = 'Keycloak guarda el sub como id del usuario, VARCHAR(36), y con uno más largo responde 500 al darlo de alta: usa un sub de hasta 36 caracteres, como un UUID';

/** Credenciales de administración del contenedor de Keycloak, tal como las declara el catálogo. */
export function keycloakAdminCredentials() {
  const { id, provisioning } = realmImportProvider();
  const env = AUTH[id].composeServices()[AUTH[id].serviceKey].environment;
  return { user: env[provisioning.adminEnv.user], password: env[provisioning.adminEnv.password] };
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
    userClient: usesUserClient(model) ? userTestClient(model) : null,
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

/** El issuer del perfil local: el del proveedor de prueba de infra/, el mismo en todos los generadores. */
export function localIssuer(model) {
  const { provisioning } = identityProvider(model.stack?.auth);
  if (!provisioning.kind) return 'https://tu-issuer';
  return `http://localhost:${AUTH[model.stack.auth].port}${providerPath(provisioning.issuerPath, model.service.name)}`;
}
