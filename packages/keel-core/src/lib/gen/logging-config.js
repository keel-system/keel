// La configuración de los logs por perfil (`config/parameters/<perfil>/logging.yaml`): los niveles y, fuera de
// local, el formato estructurado de la consola con los campos `service.*` de cada línea.
//
// Las mismas claves y las mismas variables que el `logging` de keel-spring, con una diferencia de forma: keel-spring
// nombra el nivel del servicio por su paquete base (la convención de logback), y aquí es `app`, porque cada
// plataforma reparte sus categorías de otra manera (los contextos de Nest, los namespaces de .NET). La comparten
// keel-nest y keel-dotnet; estaba escrita en keel-nest y salió aquí al llegar el tercer generador
// (PLAN-KEEL-DOTNET.md, incremento 14b).
//
//   · `LOG_LEVEL_ROOT` para lo que escribe el framework y `LOG_LEVEL_APP` para lo que escribe el servicio, con el
//     gradiente de keel-spring (INFO/DEBUG fuera de production; WARN/INFO en production).
//   · `develop` y `production` escriben JSON ECS (`LOG_FORMAT`, default `ecs`) con la versión, el entorno y la
//     réplica (`SERVICE_INSTANCE_ID`, si no `HOSTNAME`): sin ellos dos despliegues o dos instancias escriben líneas
//     indistinguibles. `local` y `test`, texto, porque lo lee una persona.

import { envFor } from './runtime-env.js';

/** La versión del esquema ECS que declara cada línea: la del formato de Spring Boot 3.5. */
export const ECS_VERSION = '8.11';

/** ¿Escribe este perfil la consola estructurada? */
export function structuredConsole(profile) {
  return profile === 'develop' || profile === 'production';
}

/** El `logging.yaml` de un perfil. `header` es la primera línea de comentario, la de cada generador. */
export function loggingYaml(model, profile, { header = null } = {}) {
  const lines = [
    ...(header ? [`# ${header}`] : []),
    'logging:',
    '  level:',
    `    root: ${envFor('LOG_LEVEL_ROOT', profile)}`,
    `    app: ${envFor('LOG_LEVEL_APP', profile)}`
  ];
  if (structuredConsole(profile)) {
    lines.push(
      '  # Fuera de local la consola es JSON (ECS): la recoge un agente que la separa en campos.',
      '  structured:',
      '    format:',
      `      console: ${envFor('LOG_FORMAT', profile)}`,
      '    ecs:',
      '      service:',
      `        version: "${model.service.version}"`,
      `        environment: ${envFor('DEPLOYMENT_ENVIRONMENT', profile, profile)}`,
      '        node-name: ${SERVICE_INSTANCE_ID:${HOSTNAME:unknown}}'
    );
  }
  return `${lines.join('\n')}\n`;
}
