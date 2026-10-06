// Lo que el harness del agente carga en el proyecto generado: el archivo de contexto del repo
// (`CLAUDE.md`, `AGENTS.md`) y la skill `keel-generate-nest`, proyectados a cada harness
// soportado por `keel-core` (HARNESSES). Se emiten todos: el proyecto sirve para cualquiera sin
// decidir nada al generarlo.
//
// Estado (incremento 2 de PLAN-KEEL-NEST.md): todavía no hay pipeline de agentes —llega en el
// incremento 7, con el arnés de integración—, así que la skill dice exactamente eso y lo que sí
// se puede hacer ya, en vez de prometer una generación que no existe.

import { HARNESSES, applyTokens } from 'keel-core';
import { SKILL } from '../lib/assets.js';
import { describeStack } from 'keel-core/gen/stack';

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
  const layers = Object.keys(model.layersPresent).filter((layer) => model.layersPresent[layer]);
  return `# ${service.projectName}

Servicio NestJS generado por \`keel-nest build\` desde \`specs/${service.name}\` v${service.version}.

- **Diseño**: \`specs/\` es un snapshot del diseño Keel; el canónico vive en el workspace de diseño. No se edita aquí.
- **Capas declaradas**: ${layers.length > 0 ? layers.join(', ') : '(ninguna)'}.
- **Stack** (\`keel-stack.json\`): ${describeStack(model.stack)}.
- **Arquitectura**: hexagonal + CQRS, la misma que el servidor de keel-spring del mismo diseño. \`src/domain\` y \`src/application\` no importan el framework; \`src/infrastructure\` es el único sitio que lo conoce.
- **Configuración**: perfil por \`PROFILE\` (default \`local\`), \`config/application.yaml\` + \`config/parameters/<perfil>/\`; \`\${VAR}\` es obligatoria y \`\${VAR:default}\` opcional.
- **Inyección**: siempre con \`@Inject(<token>)\` explícito; el arranque no depende de los metadatos de decoradores.

## Verificación

\`\`\`bash
npm install          # la primera vez crea package-lock.json: commitéalo, y a partir de ahí npm ci
npm run typecheck      # tipos de todo el proyecto, pruebas incluidas
npm test               # arranque bajo el perfil test y sondas
npm run build && npm start   # GET /livez y /readyz → {"status":"UP"}
\`\`\`

## Estado del generador

keel-nest se construye por incrementos (PLAN-KEEL-NEST.md del repo de Keel). Esta versión genera el
proyecto que arranca, su configuración y sus sondas; el código del dominio, los casos de uso y la API
llega en los incrementos 4 y 5, y el pipeline de agentes de \`/${SKILL}\` en el 7.
`;
}

function skillMd(model) {
  const { service } = model;
  return `---
name: ${SKILL}
description: Completa la generación de este microservicio NestJS a partir del diseño Keel incluido en specs/. Usar dentro de este proyecto, sin argumentos.
---

# /${SKILL} — completar ${service.projectName}

Este proyecto lo generó \`keel-nest build\` desde \`specs/${service.name}\` v${service.version}.

**Todavía no hay pipeline de completado.** keel-nest se construye por incrementos y el orquestador de
subagentes (código, infraestructura, pruebas de integración, validación funcional y calidad) llega en el
incremento 7 de PLAN-KEEL-NEST.md, junto con el arnés que puntúa los escenarios \`FL-*\`. No escribas el
servidor a mano a partir de \`specs/\` para suplirlo: sin el arnés no hay forma de saber si es equivalente
al que genera keel-spring del mismo diseño, que es el objetivo.

Lo que sí puedes hacer ahora, con el cwd en esta raíz:

1. \`npm install\` (o \`npm ci\` si el repo ya tiene \`package-lock.json\`)
2. \`npm run typecheck && npm test\` — el proyecto compila y arranca bajo el perfil \`test\`.
3. \`npm run build && npm start\` — \`GET /livez\` y \`GET /readyz\` responden \`{"status":"UP"}\`.

Si algo de eso falla en un proyecto recién generado, es un defecto de keel-nest: repórtalo con la salida.
`;
}
