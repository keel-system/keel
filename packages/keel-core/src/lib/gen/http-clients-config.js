// La configuración de los clientes HTTP salientes por perfil (`config/parameters/<perfil>/http-clients.yaml`): la URL
// del proveedor y las credenciales de su autenticación, que nunca vienen del diseño.
//
// La comparten keel-nest y keel-dotnet byte a byte, y es la de keel-spring sin su bloque de resilience4j (que en
// los otros dos va en código, desde `outbound-resilience.js`): los tres servidores del mismo diseño leen las MISMAS
// claves y las MISMAS variables de entorno. Estaba escrita en keel-nest; salió aquí al llegar el tercer generador
// (PLAN-KEEL-DOTNET.md, incremento 11b).

import { envValue } from './profile-values.js';
import { LOCAL_STUB_BASE_URL, UNREACHABLE_BASE_URL } from './infra-catalog.js';

/**
 * El endpoint de token en `local`: el PATH del diseño sobre el proveedor de prueba (el WireMock de infra/), como
 * keel-spring. Solo en local: fuera, el valor del diseño es el default (develop) o la variable obligatoria.
 */
function tokenUri(client, profile) {
  if (profile !== 'local') return client.auth.tokenUrl;
  try {
    return LOCAL_STUB_BASE_URL + new URL(client.auth.tokenUrl).pathname;
  } catch {
    return client.auth.tokenUrl;
  }
}

/**
 * El `http-clients.yaml` de un perfil. La URL del proveedor: el WireMock de `infra/` en `local`, una que no responde
 * en `test` (ninguna prueba del perfil sale a la red) y la variable `<CLIENTE>_BASE_URL`, OBLIGATORIA, fuera: un
 * despliegue sin configurar falla al arrancar en vez de llamarse a sí mismo en silencio.
 */
export function httpClientsYaml(model, profile) {
  const lines = ['http-clients:'];
  for (const client of model.httpClients ?? []) {
    lines.push(`  ${client.id}:`);
    if (profile === 'local') {
      lines.push('    # Proveedor de prueba (WireMock de infra/docker-compose.yaml).', '    # Los mappings los programa cada test; nada que configurar aquí.');
    }
    const baseUrl = profile === 'local' ? LOCAL_STUB_BASE_URL : profile === 'test' ? UNREACHABLE_BASE_URL : `\${${client.envPrefix}_BASE_URL}`;
    lines.push(`    base-url: ${baseUrl}`);
    if (client.auth?.type === 'api-key') {
      lines.push('    auth:', `      api-key: ${envValue(profile, `${client.envPrefix}_API_KEY`, 'changeme')}`);
    } else if (client.auth?.type === 'bearer-static') {
      lines.push('    auth:', `      token: ${envValue(profile, `${client.envPrefix}_TOKEN`, 'changeme')}`);
    } else if (client.auth?.type === 'basic') {
      lines.push(
        '    auth:',
        `      username: ${envValue(profile, `${client.envPrefix}_USERNAME`, 'changeme')}`,
        `      password: ${envValue(profile, `${client.envPrefix}_PASSWORD`, 'changeme')}`
      );
    } else if (client.auth?.type === 'oauth2-client-credentials') {
      // Las MISMAS variables que la registration de keel-spring (<CLIENTE>_CLIENT_ID, _CLIENT_SECRET, _TOKEN_URL).
      lines.push(
        '    auth:',
        `      client-id: ${profile === 'test' ? 'test' : envValue(profile, `${client.envPrefix}_CLIENT_ID`, 'changeme')}`,
        `      client-secret: ${profile === 'test' ? 'test' : envValue(profile, `${client.envPrefix}_CLIENT_SECRET`, 'changeme')}`,
        `      token-uri: ${profile === 'test' ? 'http://localhost/token' : envValue(profile, `${client.envPrefix}_TOKEN_URL`, tokenUri(client, profile))}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
