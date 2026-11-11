// El contrato entre el servidor y el TOKEN, como datos (keel-core/gen): dado un token con la forma del proveedor elegido,
// qué principal, qué authorities, qué identidad y qué exención tiene que ver el servidor, y cuándo responde 401 o 403.
//
// Lo mismo que wire.js para el cable. Dos servidores «equivalentes» que leen distinto un claim no se distinguen en
// ningún escenario contra el emulador, porque el emulador se escribió con la forma que esperamos; estos casos dicen la
// forma del proveedor, y la prueba que build emite (fase 2 de PLAN-PROVEEDOR-IDENTIDAD.md) los ejecuta sin necesitarlo.
//
// Se derivan del descriptor y del diseño: nada de aquí nombra a un proveedor. Un caso con `defect` describe un fallo
// conocido del servidor generado (D1 a D4 del plan) que ningún generador cumple hasta la fase 2.

import { accessPlan, audienceOf, tokenClaims } from './access-plan.js';
import { credentialClientId, identityProvider, roleClaims, tokenContract } from './identity-providers.js';
import { FOREIGN_RESOURCE_SERVER, usesTokens } from './identity-realm.js';

/** Reglas, por id estable. Cada caso de abajo cita la suya. */
export const TOKEN_RULES = {
  'role-claim': 'Los roles se leen del claim donde los pone el proveedor y dan ROLE_<rol> y los permisos que el rol otorga.',
  'no-role': 'Un token sin roles se autentica y no da ninguna authority de rol: el 403 es del acceso, no de la credencial.',
  'permission-claim': 'Los permisos se leen del claim de permisos del proveedor.',
  'scope-claim': 'Un scope de este servicio, con el formato del proveedor, da SCOPE_<scope>.',
  'scope-foreign': 'Un scope prefijado por otro resource server no da authority: el permiso es de otra API.',
  'audience-own': 'Un token de máquina emitido para este servicio pasa la comprobación de audiencia.',
  'audience-foreign': 'Un token válido emitido para otro servicio se autentica y las rutas de máquina responden 403.',
  'token-kind': 'Solo se acepta el tipo de token que el proveedor marca como access token; otro del mismo emisor da 401.',
  'identity-claim': 'La identidad del llamante sale del claim que declara el diseño.',
  'identity-client': 'Con correspondencia 1:1, la identidad es el nombre que declara el diseño, aunque el proveedor genere otro id.',
  'identity-client-resolved': 'Con `resolvedBy`, la identidad es el valor crudo de la credencial: lo que guarda la lista del recurso.',
  'exempt-client': 'Un cliente de `exemptClients` no se acota, aunque el proveedor genere otro id para él.',
  'scoped-client': 'Un cliente fuera de `exemptClients` se acota.',
  'exempt-role': 'Un rol de `exemptRoles` no se acota.',
  'scoped-role': 'Un rol acotado ve los valores del claim del alcance.'
};

const USER = 'idt-user';
const SUB = 'idt-sub';
const IDENTITY = 'idt-identity';
const RESOURCE = 'idt-resource';
const UNKNOWN_CLIENT = 'idt-other-client';

/**
 * Los casos del token de este diseño con el proveedor de su stack. Vacío sin identidad por token o sin proveedor conocido:
 * ahí no hay forma de token que afirmar.
 */
export function tokenCases(model) {
  const auth = model.stack?.auth;
  const provider = identityProvider(auth);
  if (!provider.id || !model.layersPresent?.security || !usesTokens(model)) return [];

  const sec = model.security;
  const { token } = provider;
  const claims = tokenClaims(auth);
  const { prefixedScopes, audienceInScopePrefix } = tokenContract(auth);
  const opaqueClients = !token.client.valueIsDeclaredName;
  const acceptedClaim = token.accepted ? { [token.accepted.claim]: token.accepted.value } : {};
  const clientClaim = token.client.claims[0];

  const roles = sec.roles ?? [];
  const grantsOf = (role) => (sec.roleGrants ?? []).filter((grant) => grant.role === role).flatMap((grant) => grant.permissions);
  const principalOf = (claimsOfToken) => claimsOfToken[sec.usesAuthorities ? claims.principalClaim : 'sub'];

  const userToken = (userRoles, extra = {}) => ({
    sub: SUB,
    [claims.principalClaim]: USER,
    ...acceptedClaim,
    ...roleClaims(claims, userRoles),
    ...extra
  });

  const usesMachineTokens = Boolean(sec.serviceAuth) && sec.serviceAuth.protocol !== 'api-key';
  const audience = audienceOf(model);
  const scopeText = (scope, resourceServer) => (prefixedScopes ? `${resourceServer}/${scope}` : scope);
  const machineToken = (clientId, scopes = [], { resourceServer = audience, aud = audience } = {}) => ({
    sub: clientId,
    ...acceptedClaim,
    [clientClaim]: clientId,
    ...(scopes.length > 0 ? { scope: scopes.map((scope) => scopeText(scope, resourceServer)).join(' ') } : {}),
    ...(audienceInScopePrefix ? {} : { aud })
  });
  const translated = (name) => (opaqueClients ? { clientIds: { [name]: credentialClientId(auth, name) } } : {});
  const clientIdOf = (name) => credentialClientId(auth, name);

  const cases = [];
  const add = (id, rule, tokenClaimsOfCase, expect, extra = {}) => cases.push({ id, rule, token: tokenClaimsOfCase, expect, ...extra });

  if (roles.length > 0) {
    const [role] = roles;
    const claimsOfCase = userToken([role]);
    add('IDT-ROLE', 'role-claim', claimsOfCase, {
      authenticated: true,
      principal: principalOf(claimsOfCase),
      ...(sec.usesAuthorities ? { authorities: { includes: [`ROLE_${role}`, ...grantsOf(role)] } } : {})
    });
    if (sec.usesAuthorities) add('IDT-NO-ROLE', 'no-role', userToken([]), { authenticated: true, authorities: { excludes: roles.map((name) => `ROLE_${name}`) } });
  }

  const plan = accessPlan(model);
  const permissions = [
    ...new Set(
      plan.chains
        .flatMap((chain) => [...chain.rules.map((rule) => rule.requirement), chain.fallback])
        .flatMap((requirement) => requirement.authorities ?? [])
        .filter((authority) => !authority.startsWith('ROLE_') && !authority.startsWith('SCOPE_'))
    )
  ];
  if (permissions.length > 0) {
    add('IDT-PERMISSION', 'permission-claim', userToken([], { [claims.permissionsClaim]: [permissions[0]] }), {
      authenticated: true,
      authorities: { includes: [permissions[0]] }
    });
  }

  if (token.accepted) {
    add(
      'IDT-NOT-ACCESS-TOKEN',
      'token-kind',
      { ...userToken(roles.slice(0, 1)), [token.accepted.claim]: token.accepted.rejected },
      { authenticated: false, status: 401 },
      { defect: 'D1' }
    );
  }

  const clients = sec.serviceClients ?? [];
  const scopes = sec.scopes ?? [];
  if (usesMachineTokens && scopes.length > 0 && sec.usesAuthorities) {
    const clientId = clientIdOf(clients[0]?.name ?? UNKNOWN_CLIENT);
    add('IDT-SCOPE', 'scope-claim', machineToken(clientId, [scopes[0]]), { authenticated: true, authorities: { includes: [`SCOPE_${scopes[0]}`] } });
    if (prefixedScopes) {
      add(
        'IDT-SCOPE-FOREIGN',
        'scope-foreign',
        machineToken(clientId, [scopes[0]], { resourceServer: FOREIGN_RESOURCE_SERVER }),
        { authenticated: true, authorities: { excludes: [`SCOPE_${scopes[0]}`] } },
        { defect: 'D2' }
      );
    }
    if (sec.serviceAuth.validateAudience === true) {
      add('IDT-AUDIENCE-OWN', 'audience-own', machineToken(clientId, [scopes[0]]), { authenticated: true, issuedForService: true });
      add(
        'IDT-AUDIENCE-FOREIGN',
        'audience-foreign',
        machineToken(clientId, [scopes[0]], { resourceServer: FOREIGN_RESOURCE_SERVER, aud: FOREIGN_RESOURCE_SERVER }),
        { authenticated: true, issuedForService: false, status: 403 }
      );
    }
  }

  const identity = sec.callerIdentity;
  if (identity?.source === 'claim') {
    const name = identity.claim ?? 'sub';
    add('IDT-IDENTITY-CLAIM', 'identity-claim', userToken(roles.slice(0, 1), { [name]: IDENTITY }), { authenticated: true, identity: IDENTITY });
  }
  if (identity?.source === 'serviceClient' && clients.length > 0) {
    const { name } = clients[0];
    const claimsOfCase = machineToken(clientIdOf(name), scopes.slice(0, 1));
    if (identity.resolvedBy) {
      add('IDT-IDENTITY-CLIENT-RESOLVED', 'identity-client-resolved', claimsOfCase, { authenticated: true, identity: clientIdOf(name) });
    } else {
      add(
        'IDT-IDENTITY-CLIENT',
        'identity-client',
        claimsOfCase,
        { authenticated: true, identity: name },
        { ...translated(name), ...(opaqueClients ? { defect: 'D4' } : {}) }
      );
    }
  }

  const scoping = sec.scoping;
  if (scoping) {
    const [exemptRole] = sec.usesAuthorities ? scoping.exemptRoles : [];
    const scopedRole = sec.usesAuthorities ? roles.find((role) => !scoping.exemptRoles.includes(role)) : undefined;
    if (exemptRole) add('IDT-EXEMPT-ROLE', 'exempt-role', userToken([exemptRole]), { authenticated: true, exempt: true });
    if (scopedRole) {
      add('IDT-SCOPED-ROLE', 'scoped-role', userToken([scopedRole], { [scoping.claim]: [RESOURCE] }), {
        authenticated: true,
        exempt: false,
        scope: [RESOURCE]
      });
    }
    const [exemptClient] = scoping.exemptClients;
    if (exemptClient && usesMachineTokens) {
      add(
        'IDT-EXEMPT-CLIENT',
        'exempt-client',
        machineToken(clientIdOf(exemptClient), scopes.slice(0, 1)),
        { authenticated: true, exempt: true },
        { ...translated(exemptClient), ...(opaqueClients ? { defect: 'D3' } : {}) }
      );
      add('IDT-SCOPED-CLIENT', 'scoped-client', machineToken(clientIdOf(UNKNOWN_CLIENT), scopes.slice(0, 1)), { authenticated: true, exempt: false }, translated(exemptClient));
    }
  }

  return cases;
}
