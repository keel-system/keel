// Lo que cada proveedor de identidad del stack ES y SABE HACER, como datos: la forma de su token, lo que el arnés puede
// pedirle y cómo se aprovisiona su doble de prueba.
//
// NEUTRAL (keel-core/gen): es contrato con el PROVEEDOR, no con un lenguaje. Los cuatro servidores del mismo diseño leen
// los mismos claims, y una pregunta por el nombre del proveedor repartida por los generadores es lo que dejaba en una
// rama distinta cada diferencia. Quien necesita saber algo de un proveedor le pregunta a este descriptor; añadir uno es
// añadir su entrada aquí y la de su contenedor en `AUTH` (infra-catalog.js), más sus casos y sus skills.
//
// Las tres mitades responden a preguntas distintas y cambian por motivos distintos:
//
//   · `token`: lo que el servidor generado consume. Vale en producción.
//   · `harness`: lo que el arnés de pruebas puede pedir por petición. Solo vale en local.
//   · `provisioning`: cómo se levanta y se siembra el proveedor de prueba. Solo vale en local.
//
// Lo de Cognito sale de su documentación y de leer el código, no de un pool real: lo que eso no demuestra está en la
// fase 5 de PLAN-PROVEEDOR-IDENTIDAD.md, y lo emitido lo dice (`emulationMessage`).

/** Los claims de un access token de Cognito sin disparador de pre-generación. */
const COGNITO_ACCESS_TOKEN_CLAIMS = [
  'sub',
  'iss',
  'client_id',
  'origin_jti',
  'event_id',
  'token_use',
  'scope',
  'auth_time',
  'exp',
  'iat',
  'jti',
  'username',
  'version',
  'cognito:groups'
];

/**
 * Los claims de un access token de Keycloak con los client scopes por defecto de un realm (`profile`, `email`, `roles`,
 * `web-origins`, `acr`, `basic`). Cualquier otro llega con un mapper de protocolo del realm.
 */
const KEYCLOAK_ACCESS_TOKEN_CLAIMS = [
  'sub',
  'iss',
  'aud',
  'azp',
  'client_id',
  'typ',
  'scope',
  'sid',
  'acr',
  'auth_time',
  'exp',
  'iat',
  'jti',
  'allowed-origins',
  'realm_access',
  'resource_access',
  'preferred_username',
  'name',
  'given_name',
  'family_name',
  'email',
  'email_verified'
];

const OIDC_REALM_PATHS = {
  issuerPath: '/realms/{service}',
  tokenPath: '/realms/{service}/protocol/openid-connect/token',
  jwksPath: '/realms/{service}/protocol/openid-connect/certs'
};

export const IDENTITY_PROVIDERS = {
  keycloak: {
    id: 'keycloak',
    displayName: 'Keycloak',
    skill: true,
    token: {
      issuer: 'https://<host>/realms/<realm>',
      claims: { type: 'nested', rolesParent: 'realm_access', rolesField: 'roles', permissionsClaim: 'permissions', principalClaim: 'preferred_username' },
      scopes: { format: 'plain' },
      audience: { via: 'aud' },
      client: { claims: ['azp', 'client_id'], valueIsDeclaredName: true },
      accepted: null,
      accessTokenClaims: KEYCLOAK_ACCESS_TOKEN_CLAIMS,
      // Cualquier otro claim llega con un mapper del realm, que es lo que siembra el aprovisionamiento de prueba.
      customClaims: {
        user: { state: 'supported', via: 'un mapper de protocolo del realm (de atributo de usuario, o de grupo para una lista)' },
        machine: { state: 'supported', via: 'un mapper de protocolo del realm sobre el cliente (atributo del service account o claim fijo)' }
      },
      // Lo que hay que crear en el proveedor, con sus nombres.
      setup: { roles: 'roles del realm', scopes: 'client scopes del realm, asignados como opcionales a cada cliente máquina', clients: 'clientes confidenciales con service account' }
    },
    // Medido contra un Keycloak real: el security-check de keel-nest, keel-dotnet y keel-go.
    verification: { level: 'live', note: 'medido contra un Keycloak real (la red security-check de los generadores)' },
    harness: { personaTokens: true, scopedTokens: true },
    provisioning: {
      kind: 'realm-import',
      ...OIDC_REALM_PATHS,
      internalPort: 8080,
      localIssuerNote: ['Keycloak de prueba del docker-compose; crea el realm y ajusta el nombre.'],
      console: { label: 'Keycloak (admin/admin)', url: 'http://localhost:${KEYCLOAK_PORT:-8180}' },
      adminEnv: { user: 'KC_BOOTSTRAP_ADMIN_USERNAME', password: 'KC_BOOTSTRAP_ADMIN_PASSWORD' },
      emulationMessage: null
    }
  },
  cognito: {
    id: 'cognito',
    displayName: 'Cognito',
    skill: true,
    token: {
      issuer: 'https://cognito-idp.<región>.amazonaws.com/<id del user pool>',
      claims: { type: 'flat', rolesClaim: 'cognito:groups', permissionsClaim: 'permissions', principalClaim: 'username' },
      scopes: { format: 'resource-server-prefix' },
      // Un access token de client_credentials no lleva `aud`: el prefijo del scope dice para qué API vale.
      audience: { via: 'scope-prefix' },
      // Cognito genera el id del app client: el valor del claim no es el nombre que declara el diseño.
      client: { claims: ['client_id'], valueIsDeclaredName: false },
      // Un ID token del mismo pool tiene el mismo emisor y la misma firma: solo este claim los distingue.
      accepted: { claim: 'token_use', value: 'access', rejected: 'id' },
      accessTokenClaims: COGNITO_ACCESS_TOKEN_CLAIMS,
      // Lo que no está en esa lista solo llega con un disparador, y el disparador depende del plan del pool (documentación de
      // AWS consultada el 2026-11-10). Los tokens de máquina solo pasan por la versión 3.
      customClaims: {
        user: {
          state: 'requires-configuration',
          via: 'un disparador de pre-generación de tokens (Lambda) V2 o V3 que añada el claim al access token',
          plan: 'Essentials o Plus; en Lite, solo con las funciones de seguridad avanzada'
        },
        machine: {
          state: 'requires-configuration',
          via: 'un disparador de pre-generación de tokens (Lambda) V3, el único que reciben los tokens de client_credentials',
          plan: 'Essentials o Plus'
        }
      },
      setup: {
        roles: 'grupos del user pool',
        scopes: 'scopes personalizados de un resource server cuyo identificador es la audiencia del servicio',
        clients: 'app clients con secreto y el grant client_credentials'
      }
    },
    // Ni la forma del token ni el disparador se han ejecutado contra un pool real: fase 5 de PLAN-PROVEEDOR-IDENTIDAD.md.
    verification: { level: 'emulated', note: 'verificado contra el contrato documentado por AWS y el emulador del docker-compose, no contra un pool real' },
    harness: { personaTokens: false, scopedTokens: false },
    provisioning: {
      kind: 'token-emulator',
      issuerPath: '/{service}',
      tokenPath: '/{service}/token',
      jwksPath: '/{service}/jwks',
      internalPort: 8080,
      emulatorDir: 'cognito',
      localIssuerNote: [
        'Emulador del contrato de token de Cognito en el docker-compose. El issuer es',
        'DETERMINISTA porque el issuerId lo elige el diseño (el nombre del servicio):',
        'no hay ningún id de user pool que descubrir después de crearlo.',
        'Fuera de local, aquí va el pool real: https://cognito-idp.<región>.amazonaws.com/<poolId>.'
      ],
      console: null,
      adminEnv: null,
      emulationMessage: 'cognitoEmulated'
    }
  }
};

// Sin proveedor conocido (`none`, o un stack sin identidad): claims planos y ningún doble de prueba. Las rutas son las
// que el arnés llamaría si el agente deja el proveedor como dice `test-credentials.env`.
const GENERIC_PROVIDER = {
  id: null,
  displayName: null,
  skill: false,
  token: {
    issuer: null,
    claims: { type: 'flat', rolesClaim: 'roles', permissionsClaim: 'permissions', principalClaim: 'sub' },
    scopes: { format: 'plain' },
    audience: { via: 'aud' },
    client: { claims: ['azp', 'client_id'], valueIsDeclaredName: true },
    accepted: null,
    accessTokenClaims: null,
    customClaims: null,
    setup: null
  },
  verification: null,
  harness: { personaTokens: false, scopedTokens: false },
  provisioning: { kind: null, ...OIDC_REALM_PATHS, internalPort: null, localIssuerNote: null, console: null, adminEnv: null, emulationMessage: null }
};

/** El descriptor del proveedor elegido en el stack (`stack.auth`), o el genérico si no hay ninguno conocido. */
export function identityProvider(auth) {
  return Object.hasOwn(IDENTITY_PROVIDERS, auth ?? '') ? IDENTITY_PROVIDERS[auth] : GENERIC_PROVIDER;
}

/** Lo que el servidor generado necesita saber del token del proveedor, sin preguntar por su nombre. */
export function tokenContract(auth) {
  const { displayName, token } = identityProvider(auth);
  return {
    displayName,
    prefixedScopes: token.scopes.format === 'resource-server-prefix',
    audienceInScopePrefix: token.audience.via === 'scope-prefix',
    clientClaims: token.client.claims,
    opaqueClients: !token.client.valueIsDeclaredName,
    accepted: token.accepted
  };
}

/** El valor del claim del cliente para un cliente declarado en las pruebas: el nombre, o un id opaco si el proveedor lo genera. */
export function credentialClientId(auth, clientName) {
  return identityProvider(auth).token.client.valueIsDeclaredName ? clientName : `opaque-id-of-${clientName}`;
}

// ─── La referencia ejecutable de cada regla ──────────────────────────────────
//
// Lo que los cuatro servidores escriben en su lenguaje, escrito una vez y ejecutable: `token-cases.test.js` comprueba
// contra estas funciones los casos IDT-*, y la prueba que build emite comprueba lo mismo contra el servidor generado.
// `contract` es lo que devuelve tokenContract().

/** D1. ¿Es este token del tipo que el proveedor marca como access token? Sin marca, todos lo son. */
export function acceptsToken(contract, claims) {
  return !contract.accepted || claims[contract.accepted.claim] === contract.accepted.value;
}

/**
 * D2. El scope que da authority, o null. Con scopes prefijados solo cuenta el prefijo propio, que puede tener barras (un
 * identificador con forma de URL): lo prefijado por otra API es un permiso de otra API, y lo que no lleva prefijo no es
 * un scope de ningún resource server.
 */
export function grantedScope(contract, scope, resourceServer) {
  if (!contract.prefixedScopes) return scope;
  const prefix = `${resourceServer}/`;
  return scope.startsWith(prefix) && scope.length > prefix.length ? scope.slice(prefix.length) : null;
}

/**
 * El cliente de la credencial, tal como viene, o null. A falta del claim, el nombre de la autenticación solo vale si el
 * proveedor usa el nombre declarado: con ids generados, un usuario que se llamase como un cliente pasaría por él.
 */
export function credentialClient(contract, claims, principalName) {
  for (const claim of contract.clientClaims) {
    if (typeof claims[claim] === 'string' && claims[claim].trim() !== '') return claims[claim];
  }
  return contract.opaqueClients ? null : principalName ?? null;
}

/** D3. ¿Es el cliente de la credencial uno de los exentos? Con ids generados se compara con el id configurado de cada uno. */
export function isExemptClient(contract, client, exemptClients, clientIds = {}) {
  if (client === null) return false;
  return exemptClients.some((name) => client === (contract.opaqueClients ? clientIds[name] : name));
}

/**
 * D4. La identidad de un cliente con correspondencia 1:1: el nombre que declara el diseño. Un id que no está en el mapa
 * sigue crudo y no encuentra recurso, igual que un cliente desconocido con un proveedor que usa el nombre.
 */
export function declaredClient(contract, client, clientIds = {}) {
  if (!contract.opaqueClients) return client;
  return Object.entries(clientIds).find(([, id]) => id === client)?.[0] ?? client;
}

/** Los claims que llevan los roles de un usuario, con la forma del proveedor. */
export function roleClaims(claims, roles) {
  return claims.type === 'nested' ? { [claims.rolesParent]: { [claims.rolesField]: roles } } : { [claims.rolesClaim]: roles };
}

/** Sustituye el servicio en una ruta del descriptor. */
export function providerPath(template, serviceName) {
  return template.replaceAll('{service}', serviceName);
}

/** El descriptor del proveedor que se siembra importando un realm: el formato de ese archivo es suyo. */
export function realmImportProvider() {
  return Object.values(IDENTITY_PROVIDERS).find((provider) => provider.provisioning.kind === 'realm-import');
}
