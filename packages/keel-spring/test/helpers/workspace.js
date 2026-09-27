// Montar una fixture como la tendría un workspace de diseño: `specs/<n>/` con el diseño y, si la
// fixture tiene documento de diseño, `docs/<n>/DESIGN.md`.
//
// Hace falta porque el criterio `design-doc` de `keel validate --ready` busca el DESIGN.md desde la
// raíz que deduce de `specs/<n>` (workspaceRootOf), y una fixture no vive en ningún workspace. El
// DESIGN.md de una fixture está en `test/fixture-docs/<n>/`, fuera de `fixtures/`, porque todo lo
// que hay en la carpeta de un diseño viaja al snapshot del proyecto generado y varios checks recorren
// `fixtures/` como si cada entrada fuera un diseño.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURES_DIR = path.join(here, 'fixtures');
export const FIXTURE_DOCS_DIR = path.join(here, 'fixture-docs');

/**
 * Las fixtures cerradas de punta a punta: el par del MVP, en 10/10 de `keel validate --ready`
 * (test/mvp-ready.test.js). Las demás son sujetos parciales a propósito, y `build` solo las genera
 * con `acceptUnready` (fase 2 de la puerta).
 */
export const READY_FIXTURES = ['notification-mailer', 'notification-mailer-mongo'];

/** Copia la fixture `name` (y su DESIGN.md si lo tiene) al workspace `root`. Devuelve `specs/<n>`. */
export function mountDesign(root, name) {
  const specDir = path.join(root, 'specs', name);
  fs.cpSync(path.join(FIXTURES_DIR, name), specDir, { recursive: true });
  const design = path.join(FIXTURE_DOCS_DIR, name, 'DESIGN.md');
  if (fs.existsSync(design)) {
    fs.mkdirSync(path.join(root, 'docs', name), { recursive: true });
    fs.copyFileSync(design, path.join(root, 'docs', name, 'DESIGN.md'));
  }
  return specDir;
}
