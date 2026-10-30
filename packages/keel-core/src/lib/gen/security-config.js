// La configuración de la seguridad por perfil (`config/parameters/<perfil>/security.yaml`): de dónde salen las claves
// con las que se valida un token, la clave de API, la audiencia, las claves por cliente máquina y los orígenes de CORS.
//
// La comparten keel-nest, keel-dotnet y keel-go byte a byte, con las variables que keel-spring declara en su forma de
// Spring: las imágenes del mismo diseño se despliegan con el mismo .env. Estaba escrita en keel-nest y copiada en
// keel-dotnet; salió aquí al llegar el cuarto generador (PLAN-KEEL-GO.md, incremento 8).

import { audienceOf } from './access-plan.js';
import { envRequired } from './profile-values.js';
import { envFor, runtimeDefault } from './runtime-env.js';
import { localIssuer } from './identity-realm.js';
import { securityPlan, usesHttpSecurity, usesJwt } from './features.js';

/** La variable con la que las pruebas del perfil `test` publican el JWKS con el que firman. */
export const TEST_JWKS_VARIABLE = 'SECURITY_TEST_JWKS';

/** Clave de API del perfil local (catálogo neutral: runtime-env). */
export const LOCAL_API_KEY = runtimeDefault('SECURITY_API_KEY');

/** Clave de API del perfil local de un cliente máquina del diseño. */
export const localClientApiKey = (client) => `local-${client}-key`;

/** Los perfiles con fragmento propio. */
const PROFILES = ['local', 'develop', 'production', 'test'];

/** El `security.yaml` de un perfil, o null si el diseño no le da nada que configurar. */
export function securityYaml(model, profile) {
  const sec = model.security;
  const plan = securityPlan(model);
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
      lines.push(`    issuer-uri: ${envFor('OAUTH2_ISSUER_URI', profile, localIssuer(model))}`);
      if (profile === 'develop' || profile === 'production') {
        // El JWKS directo, si se da: gana al discovery del issuer y no comprueba `iss`. Es la salida del emisor PARTIDO
        // de deploy/ (el token lo emite localhost:8180, la app alcanza keycloak:8080), la misma que keel-spring toma con
        // su jwk-set-uri. Vacía, manda issuer-uri.
        lines.push(`    jwk-set-uri: \${OAUTH2_JWK_SET_URI:}`);
      }
    }
  }
  if (plan?.protocol === 'api-key' && !plan.open) {
    lines.push(
      profile === 'production'
        ? '  # Clave que deben enviar los clientes; obligatoria (sin ella la app no arranca).'
        : '  # Clave que deben enviar los clientes; esta es la de los escenarios de validación.',
      `  api-key: ${envFor('SECURITY_API_KEY', profile)}`
    );
  }
  // Como keel-spring: la variable existe siempre que el diseño valida la audiencia (y en production es obligatoria),
  // aunque hoy ninguna ruta de máquinas la compruebe.
  if (usesJwt(model) && sec.serviceAuth?.validateAudience === true) {
    lines.push('  # Audiencia que tienen que traer los tokens de los clientes máquina.', `  audience: ${envFor('SECURITY_AUDIENCE', profile, audienceOf(model))}`);
  }
  if (plan?.serviceApiKeys) {
    lines.push('  # Clave por cliente máquina del diseño (serviceClients); vacía = cliente deshabilitado.', '  api-keys:');
    for (const client of sec.serviceClients) {
      lines.push(`    ${client.name}: ${envRequired(profile, `API_KEY_${client.name.replace(/-/g, '_').toUpperCase()}`, localClientApiKey(client.name))}`);
    }
  }
  if (sec?.cors) {
    lines.push(
      '  cors:',
      profile === 'local' || profile === 'test'
        ? '    # Orígenes del navegador (CSV); estos son los puertos de dev habituales de una SPA.'
        : '    # Orígenes del navegador (CSV); obligatorio (sin él la app no arranca).',
      `    allowed-origins: ${envFor('SECURITY_CORS_ALLOWED_ORIGINS', profile)}`
    );
  }
  return lines.length > 1 ? `${lines.join('\n')}\n` : null;
}

/** Los fragmentos de todos los perfiles, como archivos del proyecto. Sin capa security, ninguno. */
export function securityConfigFiles(model) {
  if (!usesHttpSecurity(model)) return [];
  return PROFILES.map((profile) => ({ path: `config/parameters/${profile}/security.yaml`, content: securityYaml(model, profile) })).filter((file) => file.content);
}
