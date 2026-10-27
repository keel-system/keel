// README del proyecto generado: de dónde sale, cómo se arranca y qué falta. Pensado también para quien
// no conoce .NET: cada comando dice qué hace.

import { describeStack } from '@keel-system/keel-core/gen/stack';
import { SKILL } from '../lib/assets.js';
import { solution } from './render.js';
import { postmanEnvironmentPath, publishedUrls } from './deploy.js';

export function generate(model) {
  const { service } = model;
  const sln = solution(model);
  return [
    {
      path: 'README.md',
      content: `# ${service.projectName}

${service.description}

Generado desde \`specs/${service.name}\` v${service.version} con \`keel-dotnet\`. El diseño es la fuente de
verdad: un cambio funcional se hace en el workspace de diseño y se vuelve a ejecutar
\`keel-dotnet build specs/${service.name}\`.

Stack: ${describeStack(model.stack)}.

## Arrancar

Requiere el SDK de .NET 10 (\`global.json\` fija la banda; \`dotnet --list-sdks\` dice cuáles tienes).

\`\`\`bash
dotnet restore                    # descarga los paquetes; la primera vez escribe packages.lock.json (commitéalos)
dotnet build                      # compila la solución ${sln.file}; un warning es un error
dotnet run --project ${sln.api.dir}   # PROFILE=local por defecto, puerto 8080
\`\`\`

| Variable | Default | Qué controla |
|---|---|---|
| \`PROFILE\` | \`local\` | Perfil activo (varios separados por coma) |
| \`SERVER_PORT\` | \`8080\` | Puerto HTTP |
| \`SERVER_ADDRESS\` | \`0.0.0.0\` | Interfaz en la que escucha |
| \`SHUTDOWN_TIMEOUT\` | \`30s\` | Margen del apagado ordenado |

Sondas: \`GET /livez\` y \`GET /readyz\` → \`{"status":"UP"}\`; durante el apagado, \`/readyz\` responde
503 \`{"status":"OUT_OF_SERVICE"}\`.

## Completar el servicio

Build deja el proyecto compilando y arrancando, con la lógica de negocio por escribir (los handlers terminan en
\`TODO\`). La completa \`/${SKILL}\`, sin argumentos y desde esta raíz: orquesta los agentes de código,
infraestructura, pruebas, arbitraje y calidad hasta el 100% de los escenarios \`FL-*\` de
\`specs/validation-scenarios.md\` (\`docs/keel/orchestration.md\`).

## Pruebas

\`\`\`bash
dotnet test                       # xUnit v3 sobre Microsoft.Testing.Platform, bajo el perfil test (sin infraestructura)
bash infra/up.sh                  # la infraestructura de prueba (docker o podman)
bash infra/score-scenarios.sh     # compila, y ejecuta y puntúa las pruebas de flujo FL-* contra el servidor real
\`\`\`

Las pruebas de flujo (\`${sln.integrationTests.dir}\`) están fuera de \`dotnet test\` a propósito: necesitan la
infraestructura. Son caja negra: no ven ningún tipo del servicio y lo arrancan como proceso aparte.

**Una ruta corta.** Windows limita las rutas a 260 caracteres y el compilador no lo dice: bajo un directorio muy
profundo, un proyecto compila sin dejar su DLL (\`MSB3030\`). Si aparece, mueve el proyecto a una ruta más corta.

## La solución

| Proyecto | Qué contiene | Ve a |
|---|---|---|
| \`${sln.domain.name}\` | el dominio, en C# puro: value objects, agregados, eventos, errores | nadie |
| \`${sln.application.name}\` | los casos de uso: mensajes, handlers, DTOs, mappers, contrato del cable | Domain |
| \`${sln.infrastructure.name}\` | configuración, mediator, persistencia, mensajería, sondas | Application |
| \`${sln.api.name}\` | el arranque y la API HTTP | Infrastructure |
| \`${sln.unitTests.name}\` | las pruebas del arranque, del cable y del cableado de los casos de uso | Api |
| \`${sln.integrationTests.name}\` | las pruebas de flujo \`FL-*\`, contra el servidor arrancado | ninguno (caja negra) |

La frontera hexagonal la impone el compilador: un proyecto solo ve a los que referencia.
${manualTestingSection(model)}`
    }
  ];
}

/**
 * «Pruebas manuales en contenedor»: cómo levantar `deploy/` (el servicio y su infraestructura) para probarlo con
 * Postman o con un front. La sección existe sobre todo para que nadie lo confunda con infra/, la de la generación.
 */
function manualTestingSection(model) {
  const plain = (url) => `<${url.replace(/\$\{[A-Z_]+:-(\d+)\}/g, '$1')}>`;
  return `
## Pruebas manuales en contenedor

Cuando el flujo de generación termina en verde, \`deploy/\` levanta el servicio **y** su infraestructura en
contenedores. No es \`infra/\` (la infraestructura de los escenarios): no conviene tener los dos arriba a la vez, porque
publican los mismos puertos. Funciona igual con Docker que con Podman (el runtime se detecta solo; se fuerza con
\`CONTAINER_RUNTIME=podman\`). La imagen se publica con el SDK de .NET dentro del contenedor: no hace falta tenerlo
instalado para esto.

\`\`\`bash
bash deploy/up.sh      # construye la imagen, levanta todo y espera a /readyz
bash deploy/down.sh    # apaga (con -v borra además los datos)
\`\`\`

| URL | Qué es |
|---|---|
${publishedUrls(model).map(({ label, url }) => `| ${plain(url)} | ${label} |`).join('\n')}

Los puertos publicados salen de \`deploy/.env\`. Para Postman, importa \`${postmanEnvironmentPath(model)}\` junto con las
colecciones de \`docs/postman/\`.
`;
}
