// README del proyecto generado: de dónde sale, cómo se arranca y qué falta. Pensado también para quien
// no conoce .NET: cada comando dice qué hace.

import { describeStack } from 'keel-core/gen/stack';
import { solution } from './render.js';

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

## Pruebas

\`\`\`bash
dotnet test                       # xUnit v3 sobre Microsoft.Testing.Platform, bajo el perfil test
\`\`\`

## La solución

| Proyecto | Qué contiene | Ve a |
|---|---|---|
| \`${sln.domain.name}\` | el dominio, en C# puro: value objects, agregados, eventos, errores | nadie |
| \`${sln.application.name}\` | los casos de uso: mensajes, handlers, DTOs, mappers, contrato del cable | Domain |
| \`${sln.infrastructure.name}\` | configuración, mediator, persistencia, mensajería, sondas | Application |
| \`${sln.api.name}\` | el arranque y la API HTTP | Infrastructure |
| \`${sln.unitTests.name}\` | las pruebas del arranque, del cable y del cableado de los casos de uso | Api |

La frontera hexagonal la impone el compilador: un proyecto solo ve a los que referencia.
`
    }
  ];
}
