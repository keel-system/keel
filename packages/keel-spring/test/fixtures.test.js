// Las fixtures del generador tienen que ser diseños VÁLIDOS.
//
// El resto de la suite llama a scaffoldService(...) directamente, que es lo
// correcto para probar el scaffolding, pero se salta la validación que
// `keel-spring build` hace antes de generar (src/commands/build.js). Sin este
// test una fixture puede referenciar una relación que no existe y pasar años
// verde: es exactamente lo que ocurrió con un `embed: [brand]` sobre una entidad
// que nunca declaró esa relación.
//
// Se comprueban ERRORES, no warnings: `catalog-extended` lleva warnings a
// propósito (asimetría de embed, caché sin invalidación completa, api sin
// security) porque existen para ejercitar esos avisos. Exigir cero warnings la
// convertiría en un diseño ejemplar y le quitaría lo que la hace útil.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateService } from 'keel-core';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Por directorio, no por lista escrita a mano: una fixture nueva queda cubierta
// sin que nadie tenga que acordarse de añadirla aquí.
const fixtures = fs
  .readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(fixturesDir, entry.name, 'service.keel.yaml')))
  .map((entry) => entry.name);

test('hay fixtures que validar', () => {
  assert.ok(fixtures.length >= 3, `esperaba al menos 3 fixtures, encontré ${fixtures.length}`);
});

for (const name of fixtures) {
  test(`la fixture '${name}' es un diseño válido`, () => {
    const result = validateService(path.join(fixturesDir, name));

    assert.deepEqual(result.loadErrors, [], 'errores de carga');
    assert.deepEqual(result.schemaErrors, [], 'errores de schema');
    assert.deepEqual(result.crossRefErrors, [], 'errores de referencias cruzadas');
    assert.deepEqual(result.pending, [], 'capas en estado plantilla o descripciones placeholder');
    assert.equal(result.ok, true);
  });
}
