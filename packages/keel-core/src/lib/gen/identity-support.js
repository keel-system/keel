// Lo que el PROVEEDOR de identidad tiene que cumplir para servir a un diseño, como datos (fase 3 de
// PLAN-PROVEEDOR-IDENTIDAD.md).
//
// El servidor generado puede estar bien y el proveedor mal configurado: un claim que el diseño lee y que el proveedor no
// pone en el access token no rompe ninguna prueba del proyecto —el emulador lo pone—, y en producción se ve como un 401
// en toda operación con identidad, o como un listado vacío. Aquí se cruza lo que el diseño exige al token con lo que el
// descriptor dice del proveedor, con el patrón de la matriz de las pasarelas (payment-gateways.js):
//
//   - `supported`: el proveedor lo pone en el access token sin nada especial, o con su configuración ordinaria.
//   - `requires-configuration`: solo con una pieza que no siempre está disponible (un disparador, un plan). build genera
//     y AVISA, y el aviso dice qué pieza y en qué plan.
//   - `unsupported`: el proveedor no tiene forma de ponerlo. build se NIEGA.
//
// NEUTRAL: ni el diseño ni este módulo nombran un proveedor; lo que cambia entre ellos está en su descriptor.

import { identityProvider, tokenContract } from './identity-providers.js';
import { audienceOf } from './access-plan.js';
import { needsAudience, translatedClients } from './security-config.js';

export const IDENTITY_STATES = ['supported', 'requires-configuration', 'unsupported'];

/** El documento de precondiciones del proyecto generado. */
export const IDENTITY_CONTRACT_DOC = 'docs/keel/identity-contract.md';

const HOLDERS = { user: 'un usuario', machine: 'un cliente máquina' };

/**
 * Los claims que el diseño lee del access token y que no son de la forma fija del proveedor (roles, scopes, principal,
 * cliente), sacados de la capa security TAL COMO SE ESCRIBE. Cada uno con quién tiene que llevarlo (`holder`) y para qué.
 * `claim: null` es el claim de permisos, cuyo nombre pone el proveedor.
 */
export function identityClaimDemands(security) {
  const authentication = security?.authentication;
  if (authentication?.protocol !== 'oidc' && authentication?.protocol !== 'jwt') return [];
  const demands = [];

  const identity = authentication.callerIdentity;
  if (identity?.from?.source === 'claim') {
    demands.push({
      id: 'caller-identity',
      claim: identity.from.name,
      holder: 'user',
      purpose: `la identidad del llamante (authentication.callerIdentity → ${identity.field})`
    });
  }

  const scoping = authentication.scoping;
  if (scoping) {
    demands.push({ id: 'scoping-user', claim: scoping.claim, holder: 'user', purpose: `el alcance por recurso (authentication.scoping, sobre ${scoping.over})` });
    // Un cliente máquina con token y sin exención se acota igual: su token tiene que traer el claim.
    const exempt = new Set(scoping.exemptClients ?? []);
    const scoped = authentication.serviceAuth?.protocol === 'api-key' ? [] : Object.keys(security.serviceClients ?? {}).filter((name) => !exempt.has(name));
    if (scoped.length > 0) {
      demands.push({
        id: 'scoping-machine',
        claim: scoping.claim,
        holder: 'machine',
        clients: scoped,
        purpose: `el alcance por recurso de ${scoped.join(', ')} (authentication.scoping, sin exemptClients)`
      });
    }
  }

  // Un permiso que nombra una regla y que ningún rol otorga (roleGrants) solo puede llegar en el token.
  const granted = new Set(Object.values(security.roleGrants ?? {}).flat());
  const rules = [security.access?.default ?? {}, ...Object.values(security.access?.rules ?? {})];
  const direct = [...new Set(rules.flatMap((rule) => rule?.permissions ?? []))].filter((permission) => !granted.has(permission)).sort();
  if (direct.length > 0) {
    demands.push({
      id: 'permissions',
      claim: null,
      holder: 'user',
      permissions: direct,
      purpose: `los permisos que ningún rol otorga (${direct.join(', ')})`
    });
  }
  return demands;
}

/** Qué hace falta para que el proveedor ponga el claim de una exigencia en el access token. */
export function claimSupport(provider, demand) {
  const claim = demand.claim ?? provider.token.claims.permissionsClaim;
  const native = provider.token.accessTokenClaims ?? null;
  if (native === null || native.includes(claim)) return { claim, state: 'supported', via: null, plan: null };
  const custom = provider.token.customClaims?.[demand.holder] ?? null;
  if (!custom) return { claim, state: 'unsupported', via: null, plan: null };
  return { claim, state: custom.state, via: custom.via, plan: custom.plan ?? null };
}

/**
 * El veredicto de un proveedor sobre un diseño: `errors` (no puede servirlo: no se genera), `warnings` (solo con una pieza
 * que hay que tener) y las celdas de cada exigencia. Sin proveedor conocido no hay descriptor que consultar.
 */
export function checkIdentitySupport(layers, auth) {
  const provider = identityProvider(auth);
  const errors = [];
  const warnings = [];
  const cells = [];
  if (!provider.id) return { errors, warnings, cells };
  for (const demand of identityClaimDemands(layers?.security)) {
    const cell = claimSupport(provider, demand);
    cells.push({ ...demand, ...cell });
    const subject = `el claim '${cell.claim}' en el access token de ${HOLDERS[demand.holder]}`;
    if (cell.state === 'unsupported') {
      errors.push(`security: ${demand.id}: ${provider.displayName} no tiene forma de poner ${subject}, y lo necesita ${demand.purpose}`);
    } else if (cell.state === 'requires-configuration') {
      warnings.push(
        `security: ${demand.id}: ${provider.displayName} solo pone ${subject} con ${cell.via}` +
          `${cell.plan ? ` (plan ${cell.plan})` : ''}, y lo necesita ${demand.purpose}. Queda escrito en ${IDENTITY_CONTRACT_DOC}`
      );
    }
  }
  return { errors, warnings, cells };
}

/** Qué proveedores del catálogo pueden servir este diseño: la portabilidad del diseño, de un vistazo. */
export function identityCoverage(layers, authIds) {
  return authIds.filter((id) => identityProvider(id).id).map((id) => ({ id, ...checkIdentitySupport(layers, id) }));
}

// ─── El documento de precondiciones ──────────────────────────────────────────

const STATE_TEXT = { supported: 'sí', 'requires-configuration': 'con configuración', unsupported: '**no**' };

/**
 * `docs/keel/identity-contract.md`: lo que el proveedor tiene que traer para que el servidor generado funcione con él. Se
 * emite SIEMPRE que el servidor consume un token, también sin proveedor elegido: un archivo ausente sería ambiguo.
 */
export function identityContractFile(model) {
  const protocol = model.security?.protocol;
  if (!model.layersPresent?.security || (protocol !== 'oidc' && protocol !== 'jwt')) return null;
  return { path: IDENTITY_CONTRACT_DOC, content: identityContractDoc(model) };
}

function identityContractDoc(model) {
  const auth = model.stack?.auth ?? null;
  const provider = identityProvider(auth);
  const contract = tokenContract(auth);
  const { token } = provider;
  const sec = model.security;
  const name = provider.displayName ?? 'el proveedor de identidad';
  const audience = needsAudience(model) ? audienceOf(model) : null;
  const machines = sec.serviceAuth?.protocol === 'api-key' ? [] : sec.serviceClients ?? [];
  const exempt = new Set(sec.scoping?.exemptClients ?? []);
  const translated = translatedClients(model);
  const demands = (sec.claimDemands ?? []).map((demand) => ({ ...demand, ...(provider.id ? claimSupport(provider, demand) : { claim: demand.claim ?? token.claims.permissionsClaim }) }));
  const code = (text) => `\`${text}\``;
  const out = [];

  out.push(
    '# El contrato con el proveedor de identidad',
    '',
    '> Generado por `build` desde el descriptor del proveedor (keel-core). **No se edita a mano**: se regenera en cada build.',
    '',
    'El servicio es un resource server: no crea usuarios, grupos ni clientes, solo valida el access token y lee sus claims.',
    `Funciona con ${name} si el token que emite tiene la forma de este documento. Ninguna prueba del proyecto comprueba que un`,
    'despliegue concreto esté bien configurado —las pruebas firman sus propios tokens, y el proveedor de prueba los emite con',
    'la forma esperada—: lo comprueba esta lista.',
    ''
  );
  if (provider.id) {
    out.push(`- **Proveedor elegido:** ${provider.displayName}.`);
    if (provider.verification) out.push(`- **Nivel de verificación:** ${provider.verification.note}.`);
  } else {
    out.push(
      '- **Proveedor elegido:** ninguno del catálogo. Los claims de abajo son los que el servidor lee por defecto; un proveedor',
      '  que los ponga con otro nombre necesita un mapper o un cambio en el lector del token.'
    );
  }
  out.push('');

  out.push('## El token que el servidor acepta', '');
  out.push(`- **Emisor y firma**: los de ${code('OAUTH2_ISSUER_URI')}${token.issuer ? ` (${code(token.issuer)})` : ''}; las claves, de su JWKS.`);
  if (token.accepted) {
    out.push(
      `- **Solo access tokens**: ${code(`${token.accepted.claim}: ${token.accepted.value}`)}. Otro token del mismo emisor (${code(`${token.accepted.claim}: ${token.accepted.rejected}`)}) se rechaza con 401.`
    );
  }
  if ((sec.roles ?? []).length > 0) {
    const where = token.claims.type === 'nested' ? `${token.claims.rolesParent}.${token.claims.rolesField}` : token.claims.rolesClaim;
    out.push(`- **Roles**: lista de textos en ${code(where)}: ${sec.roles.map(code).join(', ')}.`);
  }
  if (sec.usesAuthorities) out.push(`- **Principal**: ${code(token.claims.principalClaim)}.`);
  if ((sec.scopes ?? []).length > 0 && machines.length > 0) {
    out.push(
      contract.prefixedScopes
        ? `- **Scopes**: ${code('scope')}, separados por espacios y con el prefijo ${code(`${audience}/`)} (el identificador del resource server, ${code('SECURITY_AUDIENCE')}). Un scope con el prefijo de otro resource server, o sin prefijo, no da permiso aquí.`
        : `- **Scopes**: ${code('scope')}, separados por espacios y sin prefijo.`
    );
  }
  if (sec.serviceAuth?.validateAudience && !contract.audienceInScopePrefix) {
    out.push(`- **Audiencia**: ${code('aud')} incluye ${code(audience)} (${code('SECURITY_AUDIENCE')}) en los tokens de los clientes máquina.`);
  }
  if (machines.length > 0) {
    out.push(
      `- **Cliente máquina**: ${token.client.claims.map(code).join(' o ')}` +
        (contract.opaqueClients ? ', con el id que el proveedor generó para él (ver Variables).' : ', con el nombre que declara el diseño.')
    );
  }
  out.push('');

  if (provider.id && token.setup && ((sec.roles ?? []).length > 0 || machines.length > 0)) {
    out.push(`## Lo que hay que crear en ${provider.displayName}`, '');
    if ((sec.roles ?? []).length > 0) out.push(`- **${capitalize(token.setup.roles)}**: ${sec.roles.map(code).join(', ')}.`);
    if ((sec.scopes ?? []).length > 0 && machines.length > 0) {
      out.push(`- **${capitalize(token.setup.scopes)}**${audience && contract.prefixedScopes ? ` (${code(audience)})` : ''}: ${sec.scopes.map(code).join(', ')}.`);
    }
    if (machines.length > 0) {
      out.push(`- **${capitalize(token.setup.clients)}**, uno por cliente del diseño:`);
      for (const client of machines) {
        const notes = [client.scopes.length > 0 ? `scopes ${client.scopes.map(code).join(', ')}` : 'sin scopes', ...(exempt.has(client.name) ? ['exento del alcance'] : [])];
        out.push(`  - ${code(client.name)}: ${notes.join('; ')}.`);
      }
    }
    out.push('');
  }

  out.push('## Claims que el diseño lee además de los anteriores', '');
  if (demands.length === 0) {
    out.push('Ninguno: el servidor no lee del token nada más que lo de arriba.', '');
  } else {
    out.push(provider.id ? `| Claim | Para qué | En el token de | Con ${provider.displayName} | Cómo |` : '| Claim | Para qué | En el token de |');
    out.push(provider.id ? '|---|---|---|---|---|' : '|---|---|---|');
    for (const demand of demands) {
      const cells = [code(demand.claim), demand.purpose, HOLDERS[demand.holder]];
      if (provider.id) cells.push(STATE_TEXT[demand.state], demand.via ? `${demand.via}${demand.plan ? ` (plan ${demand.plan})` : ''}` : demand.state === 'supported' ? 'viene en el access token' : 'sin forma conocida');
      out.push(`| ${cells.join(' | ')} |`);
    }
    out.push('');
    const scopingClaim = demands.find((demand) => demand.id.startsWith('scoping-'))?.claim;
    if (scopingClaim) {
      out.push(
        `${code(scopingClaim)} se lee como lista de textos (un array JSON, lo recomendado) o como un texto con los valores separados`,
        'por comas o espacios. Ausente es una lista vacía: el titular no alcanza ningún recurso. Quien añada el claim desde un',
        'disparador o un mapper tiene que respetar una de esas dos formas.',
        ''
      );
    }
  }

  const variables = [['OAUTH2_ISSUER_URI', `El emisor de los tokens${token.issuer ? `: ${code(token.issuer)}` : ''}.`]];
  if (audience) {
    variables.push([
      'SECURITY_AUDIENCE',
      contract.audienceInScopePrefix ? 'El identificador del resource server de este servicio: el prefijo de sus scopes.' : 'La audiencia que tienen que traer los tokens de los clientes máquina.'
    ]);
  }
  for (const client of translated) variables.push([client.variable, `El id que el proveedor generó para ${code(client.name)}. Obligatoria en production: sin ella el servicio no arranca.`]);
  out.push('## Variables', '', '| Variable | Qué es |', '|---|---|', ...variables.map(([variable, what]) => `| ${code(variable)} | ${what} |`), '');

  if (provider.verification?.level === 'emulated') {
    out.push(
      '## Lo que no está demostrado',
      '',
      `El contrato de ${provider.displayName} sale de su documentación, y las pruebas del proyecto lo ejecutan contra tokens firmados`,
      'con esa forma y contra el emulador de `infra/`. Nada de eso es un proveedor real: si el real se aparta de su documentación,',
      'se verá en el primer despliegue, casi siempre como un 401 o un 403. Antes de dar por bueno un despliegue, pide a mano un token',
      'de cada tipo (usuario y máquina) y comprueba que trae lo que dice este documento.',
      ''
    );
  }
  return out.join('\n');
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
