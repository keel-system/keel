// Lo que el harness del agente carga en el proyecto generado: el archivo de contexto del repo
// (`CLAUDE.md`, `AGENTS.md`) y la skill `keel-generate-dotnet`, proyectados a cada harness soportado por
// `keel-core` (HARNESSES). Se emiten todos: el proyecto sirve para cualquiera sin decidir nada al generarlo.
//
// Estado (incremento 4 de PLAN-KEEL-DOTNET.md): todavía no hay pipeline de agentes —llega en el
// incremento 7, con el arnés de integración—, así que la skill dice exactamente eso y lo que sí se puede
// hacer ya, en vez de prometer una generación que no existe.

import { HARNESSES, applyTokens } from 'keel-core';
import { describeStack } from 'keel-core/gen/stack';
import { SKILL } from '../lib/assets.js';
import { solution } from './render.js';

export function generate(model) {
  const files = [];
  for (const harness of HARNESSES) {
    const tokens = harness.tokens;
    files.push({ path: harness.contextFile, content: applyTokens(contextMd(model), tokens) });
    files.push({ path: harness.skillPath(SKILL, 'SKILL.md'), content: applyTokens(skillMd(model), tokens) });
  }
  return files;
}

function contextMd(model) {
  const { service } = model;
  const sln = solution(model);
  const layers = Object.keys(model.layersPresent).filter((layer) => model.layersPresent[layer]);
  return `# ${service.projectName}

Servicio .NET generado por \`keel-dotnet build\` desde \`specs/${service.name}\` v${service.version}.

- **Diseño**: \`specs/\` es un snapshot del diseño Keel; el canónico vive en el workspace de diseño. No se edita aquí.
- **Capas declaradas**: ${layers.length > 0 ? layers.join(', ') : '(ninguna)'}.
- **Stack** (\`keel-stack.json\`): ${describeStack(model.stack)}.
- **Arquitectura**: hexagonal + CQRS, la misma que los servidores de keel-spring y keel-nest del mismo diseño. Un proyecto por capa (\`${sln.domain.name}\`, \`${sln.application.name}\`, \`${sln.infrastructure.name}\`, \`${sln.api.name}\`); la frontera la impone el compilador con las referencias entre proyectos.
- **Configuración**: perfil por \`PROFILE\` (default \`local\`), \`config/application.yaml\` + \`config/parameters/<perfil>/\`; \`\${VAR}\` es obligatoria y \`\${VAR:default}\` opcional.
- **Paquetes**: solo con licencia permisiva; nunca uno que haya pasado a licencia comercial (MediatR, AutoMapper, MassTransit, FluentAssertions…).

## Verificación

\`\`\`bash
dotnet build         # un warning es un error
dotnet test          # arranque bajo el perfil test y sondas
dotnet run --project ${sln.api.dir}   # GET /livez y /readyz → {"status":"UP"}
\`\`\`

## Estado del generador

keel-dotnet se construye por incrementos (PLAN-KEEL-DOTNET.md del repo de Keel). Esta versión genera el
proyecto que arranca, su configuración, sus sondas, el contrato del cable, el dominio (value objects con sus
guardas, agregados con su lifecycle, eventos y errores) y la capa de aplicación (mensajes, handlers que nacen
fallando con su TODO, DTOs, mappers y el mediator). La API llega en el incremento 5 y el pipeline de agentes de
\`/${SKILL}\` en el 7.
`;
}

function skillMd(model) {
  const { service } = model;
  const sln = solution(model);
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio .NET a partir del diseño Keel incluido en specs/. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto lo generó \`keel-dotnet build\` desde \`specs/${service.name}\` v${service.version}.

**Todavía no hay pipeline de completado.** keel-dotnet se construye por incrementos y el orquestador de
subagentes (código, infraestructura, pruebas de integración, validación funcional y calidad) llega en el
incremento 7 de PLAN-KEEL-DOTNET.md, junto con el arnés que puntúa los escenarios \`FL-*\`. No escribas el
servidor a mano a partir de \`specs/\` para suplirlo: sin el arnés no hay forma de saber si es equivalente
al que generan keel-spring y keel-nest del mismo diseño, que es el objetivo.

Lo que sí puedes hacer ahora, con el cwd en esta raíz:

1. \`dotnet build\` — la solución compila sin warnings.
2. \`dotnet test\` — el proyecto arranca bajo el perfil \`test\`, sus sondas responden y cada mensaje del diseño
   llega a su handler por el contenedor real.
3. \`dotnet run --project ${sln.api.dir}\` — \`GET /livez\` y \`GET /readyz\` responden \`{"status":"UP"}\`.

Si algo de eso falla en un proyecto recién generado, es un defecto de keel-dotnet: repórtalo con la salida.
`;
}
