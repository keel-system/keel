// El par del MVP, cerrado de punta a punta: `keel validate --ready` en verde sobre los dos.
//
// R9 de recomendaciones-diseno.md. Hasta aquí el método nunca se había ejercido entero sobre sus
// propios sujetos: ninguna fixture tenía careo, tres de once tenían escenarios y la puerta de
// «diseño listo» (readiness.js) se había construido sin un solo diseño que la pasara. Una puerta
// que nace roja se aprende a ignorar, así que antes de que `build` se niegue a generar sin ella
// (paso 10), tenía que haber un diseño real que la cruzara. Estos dos son ese diseño.
//
// Las demás fixtures son sujetos PARCIALES a propósito: existen para ejercer ramas del generador,
// no el método, y no se les exige estar cerradas. `READY_FIXTURES` (helpers/workspace.js) es la frontera: desde el paso 10
// `build` se niega sobre un diseño no listo, y son estas las que genera sin `--accept-unready`
// (test/build.test.js lo comprueba sobre ellas).
//
// El montaje del workspace no es un truco para el test: el criterio `design-doc` busca
// `docs/<servicio>/DESIGN.md` desde la raíz que deduce de `specs/<servicio>` (workspaceRootOf), y
// una fixture no vive en ningún workspace. Su DESIGN.md está en `fixture-docs/<servicio>/`, fuera
// de `fixtures/`, porque todo lo que hay en la carpeta de un diseño viaja al snapshot del proyecto
// generado y varios checks recorren `fixtures/` como si cada entrada fuera un diseño.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assessReadiness } from 'keel-core';
import { tmpDir } from './helpers/tmp.js';
import { FIXTURES_DIR, READY_FIXTURES, mountDesign } from './helpers/workspace.js';

const fixturesDir = FIXTURES_DIR;

/** Lo que falta, legible: el id del criterio y su porqué, uno por línea. */
function unmet(readiness) {
  return readiness.criteria
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.id}: ${entry.detail}`)
    .join('\n');
}

function mountWorkspace(name) {
  return mountDesign(tmpDir('keel-mvp-ready-'), name);
}

for (const name of READY_FIXTURES) {
  test(`${name}: listo para generar, los diez criterios en verde`, () => {
    const readiness = assessReadiness(mountWorkspace(name));
    assert.equal(readiness.ready, true, `criterios sin cumplir:\n${unmet(readiness)}`);
  });

  test(`${name}: fuera de un workspace solo falta DESIGN.md, que es lo que justifica el montaje`, () => {
    // Si esto deja de fallar por design-doc, o empieza a fallar por otra cosa, el montaje de
    // arriba está escondiendo algo o sobra.
    const readiness = assessReadiness(path.join(fixturesDir, name));
    const missing = readiness.criteria.filter((entry) => !entry.ok).map((entry) => entry.id);
    assert.deepEqual(missing, ['design-doc'], unmet(readiness));
  });
}

test('el par sigue siendo un par: el mismo contrato salvo el modelo de persistencia', () => {
  // La paridad byte a byte de las capas la vigila parity.test.js. Aquí lo que se vigila es que el
  // cierre no diverja: los dos llevan el mismo documento de escenarios, cambiando solo el nombre.
  const [relational, document] = ['notification-mailer', 'notification-mailer-mongo'].map((name) =>
    fs.readFileSync(path.join(fixturesDir, name, 'validation-scenarios.md'), 'utf8')
  );
  assert.equal(document.replaceAll('notification-mailer-mongo', 'notification-mailer'), relational);
});
