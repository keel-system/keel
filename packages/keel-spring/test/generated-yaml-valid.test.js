// Todo YAML que emite build se PARSEA, con claves únicas.
//
// `parameters/<perfil>/sweep.yaml` salía con la misma clave dos veces cuando un rescate de una
// sola transición tomaba el nombre de su operación —el mismo que la cota del lote—, y SnakeYAML
// rechaza el documento entero: la aplicación no arrancaba (corrida notifications, 2026-09-30).
// Ninguna red lo veía: los tests buscaban subcadenas y `claim-check` pasa las propiedades por
// argumento, sin leer el YAML. Este test no sabe nada de barridos: parsea TODO lo que build
// escribe, en todas las fixtures, con el parser estricto, que es lo que hace Spring al arrancar.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function plan(name, patch = null) {
  const dir = path.join(fixturesDir, name);
  const { manifest, layers, errors } = loadService(dir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  if (patch) patch(patched);
  return planService({ manifest, layers: patched, workspace: dir });
}

test('todo YAML generado se parsea sin errores ni claves duplicadas (todas las fixtures)', () => {
  for (const name of fs.readdirSync(fixturesDir)) {
    if (!fs.existsSync(path.join(fixturesDir, name, 'service.keel.yaml'))) continue;
    for (const file of plan(name).files) {
      if (!/\.ya?ml$/.test(file.path)) continue;
      for (const doc of YAML.parseAllDocuments(file.content, { uniqueKeys: true })) {
        assert.deepEqual(
          doc.errors.map((e) => e.message),
          [],
          `fixture ${name}: ${file.path}`
        );
      }
    }
  }
});

test('un rescate de UNA transición comparte bloque con la cota de su lote en sweep.yaml', () => {
  // La forma de `notifications.dispatchQueuedMessages`: el barrido solo declara la salida del
  // estado en vuelo (`running → done`), así que el rescate toma el nombre de la operación —el
  // mismo que la cota del lote—. Ninguna fixture la tiene tal cual: con las dos transiciones de
  // `job-dispatch` el rescate se llama `dispatch-jobs-done` y no choca.
  const { files } = plan('job-dispatch', (layers) => {
    const op = layers['use-cases'].operations.dispatchJobs;
    // Y sin el enlace al parámetro (DSL 2.18): con él el plazo no va a sweep.yaml y no hay choque.
    op.transitions = op.transitions.filter((t) => t.to === 'done').map(({ stalledAfter, ...rest }) => rest);
  });
  const sweep = files.find((f) => f.path.endsWith('parameters/local/sweep.yaml'));
  assert.ok(sweep, 'falta parameters/local/sweep.yaml');
  const doc = YAML.parseDocument(sweep.content, { uniqueKeys: true });
  assert.deepEqual(doc.errors.map((e) => e.message), [], sweep.content);
  const block = doc.toJS().sweep['dispatch-jobs'];
  assert.ok(block && 'batch-size' in block && 'stalled-after-seconds' in block, sweep.content);
});
