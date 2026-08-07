// Escotilla para muertes duras. La suite se limpia sola (test/helpers/tmp.js
// cuelga todo de una raíz que el proceso borra al salir), pero un Ctrl-C con
// SIGKILL o un cuelgue del runner no llegan a ejecutar ese barrido y dejan una
// raíz `keel-tests-*` por archivo de test.
//
// Solo ese prefijo: un barrido de `keel-*` se llevaría por delante temporales
// legítimos de la propia CLI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = os.tmpdir();
const roots = fs.readdirSync(tmp, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('keel-tests-'));

let borrados = 0;
for (const root of roots) {
  try {
    fs.rmSync(path.join(tmp, root.name), { recursive: true, force: true, maxRetries: 3 });
    borrados += 1;
  } catch (error) {
    console.warn(`No se pudo borrar ${root.name}: ${error.message}`);
  }
}

console.log(borrados === 0 ? `Sin residuos de tests en ${tmp}.` : `Borrados ${borrados} directorios de tests en ${tmp}.`);
