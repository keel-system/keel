// Los documentos de CONTRATO que viajan al proyecto generado, en `docs/keel/`, para los dos generadores.
//
// Son del método, no de un generador: el catálogo cerrado de los `code` que pone el generador cuando el diseño no
// nombra el conflicto de un mecanismo (`framework-errors.md`) y el contrato del cable —cómo viaja cada tipo en JSON y
// la forma del error, la página y la envoltura— (`wire-contract.md`). Hasta la corrida notification-mailer-mongo
// (2026-10-08) vivían solo en el workspace de diseño, y el agente de pruebas —que trabaja en caja negra, desde los
// escenarios— reportó `INVALID_STATE_TRANSITION` como un `code` «sin declarar»: no podía saber que es del generador.
// Una sola copia aquí, y cada generador los instala tal cual.

import fs from 'node:fs';
import path from 'node:path';
import { coreDir } from '../assets.js';

/** Los documentos, por nombre de archivo (el mismo en `docs/keel/` del proyecto generado). */
export const CONTRACT_DOCS = ['framework-errors.md', 'wire-contract.md'];

/** `{ name, content }` de cada documento de contrato, leído del payload de keel-core. */
export function contractDocs() {
  return CONTRACT_DOCS.map((name) => ({ name, content: fs.readFileSync(path.join(coreDir, 'docs', name), 'utf8') }));
}
