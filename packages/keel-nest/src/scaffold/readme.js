// README del proyecto generado: de dónde sale, cómo se arranca y qué falta.

import { describeStack } from 'keel-core/gen/stack';
import { postmanEnvironmentPath, publishedUrls } from './deploy.js';

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
\`CONTAINER_RUNTIME=podman\`). La imagen se construye con \`npm ci\`, así que necesita el \`package-lock.json\` versionado.

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
