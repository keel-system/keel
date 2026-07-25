// Inventario de la documentación derivada que la skill /keel-docs escribe en
// docs/<service.name>/ del workspace. Es una allowlist explícita (no «todo lo
// que haya en el directorio menos dos archivos») porque ahí conviven salidas de
// otras skills que no viajan al proyecto generado: DESIGN.md (/keel-handoff) e
// INTEGRATION.md (/keel-integrate).

import fs from 'node:fs';
import path from 'node:path';

// Archivos de la raíz de docs/<servicio>/. Los .yaml son los contratos formales
// y los .html sus visores autocontenidos (spec embebido, abren con file://).
// asyncapi.* solo existe cuando el diseño declara capa messaging.
const TOP_LEVEL = ['overview.html', 'openapi.yaml', 'openapi.html', 'asyncapi.yaml', 'asyncapi.html'];

// Subdirectorio con las colecciones Postman: la de flujos (nombre dependiente
// del servicio) y auth-collection.json. Ambas son salida de /keel-docs.
const POSTMAN_DIR = 'postman';

/**
 * Lista la documentación de /keel-docs de un servicio como descriptores
 * { path, sourceFile } listos para writeFiles(), con path relativo al futuro
 * docs/ del proyecto generado (p. ej. `openapi.yaml`, `postman/x.json`).
 * Si el diseñador aún no ha ejecutado /keel-docs, devuelve la lista vacía.
 */
export function listKeelDocs(workspace, serviceName) {
  const sourceDir = path.join(workspace, 'docs', serviceName);
  if (!serviceName || !fs.existsSync(sourceDir)) return { sourceDir, files: [] };

  const files = [];
  for (const name of TOP_LEVEL) {
    const sourceFile = path.join(sourceDir, name);
    if (fs.existsSync(sourceFile)) files.push({ path: name, sourceFile });
  }

  const postmanDir = path.join(sourceDir, POSTMAN_DIR);
  if (fs.existsSync(postmanDir)) {
    const collections = fs
      .readdirSync(postmanDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    for (const name of collections) {
      files.push({ path: `${POSTMAN_DIR}/${name}`, sourceFile: path.join(postmanDir, name) });
    }
  }

  return { sourceDir, files };
}
