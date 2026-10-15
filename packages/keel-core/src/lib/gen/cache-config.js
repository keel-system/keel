// La configuración de la caché de lectura por perfil (`config/parameters/<perfil>/cache.yaml`): si hay caché, dónde
// está el store (Redis o Valkey: el mismo protocolo) y cuánto se le espera.
//
// La comparten keel-nest y keel-dotnet byte a byte, con las variables del `redis.yaml` de keel-spring (REDIS_HOST,
// REDIS_PORT): los tres servidores del mismo diseño se despliegan con el mismo .env. Estaba escrita en keel-nest;
// salió aquí al llegar el tercer generador (PLAN-KEEL-DOTNET.md, incremento 13f).

import { envFor } from './runtime-env.js';

/** El `cache.yaml` de un perfil. En `test` no hay caché: sus pruebas no levantan infraestructura. */
export function cacheYaml(profile) {
  const lines = ['cache:'];
  if (profile === 'test') {
    lines.push('  # Las pruebas del perfil test no levantan infraestructura: sin caché, toda lectura va al origen.', '  enabled: false');
  } else {
    lines.push('  enabled: true');
  }
  lines.push(
    '  redis:',
    `    host: ${envFor('REDIS_HOST', profile)}`,
    `    port: ${envFor('REDIS_PORT', profile)}`,
    '    # Una caché caída no puede retener a quien lee: pasado el plazo, la lectura va al origen.',
    '    connect-timeout-ms: 2000',
    '    command-timeout-ms: 2000'
  );
  return `${lines.join('\n')}\n`;
}
