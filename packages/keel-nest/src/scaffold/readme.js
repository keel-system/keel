// README del proyecto generado: de dónde sale, cómo se arranca y qué falta.

import { describeStack } from 'keel-core/gen/stack';

export function generate(model) {
  const { service } = model;
  return [
    {
      path: 'README.md',
      content: `# ${service.projectName}

${service.description}

Generado desde \`specs/${service.name}\` v${service.version} con \`keel-nest\`. El diseño es la fuente de
verdad: un cambio funcional se hace en el workspace de diseño y se vuelve a ejecutar
\`keel-nest build specs/${service.name}\`.

Stack: ${describeStack(model.stack)}.

## Arrancar

Requiere Node.js 22.12 o superior (\`.nvmrc\` fija la versión de desarrollo).

\`\`\`bash
npm install          # la primera vez crea package-lock.json: commitéalo, y a partir de ahí npm ci
npm run build
npm start                         # PROFILE=local por defecto, puerto 8080
\`\`\`

| Variable | Default | Qué controla |
|---|---|---|
| \`PROFILE\` | \`local\` | Perfil activo (varios separados por coma) |
| \`SERVER_PORT\` | \`8080\` | Puerto HTTP |
| \`SHUTDOWN_TIMEOUT\` | \`30s\` | Margen del apagado ordenado |

Sondas: \`GET /livez\` y \`GET /readyz\` → \`{"status":"UP"}\`; durante el apagado, \`/readyz\` responde
503 \`{"status":"OUT_OF_SERVICE"}\`.

## Pruebas

\`\`\`bash
npm run typecheck
npm test
\`\`\`
`
    }
  ];
}
