// Quien escribe SQL de fixture tiene que saber cómo se GUARDA un enum, y no puede deducirlo.
//
// El agente de pruebas no puede leer `src/main/java` (el source set deja `main` fuera de su
// compileClasspath), así que todo lo que ve del enum —`specs/`, `openapi.yaml`, el `@JsonValue`—
// muestra el literal del diseño en minúsculas. La columna, en cambio, guarda `name()`: la
// constante en SCREAMING_SNAKE. El generador conocía las dos mitades y no cruzaba ninguna hacia
// el arnés.
//
// Lo que costó: `UPDATE email_messages SET status = 'sending'` contra un
// `check (status in ('QUEUED','SENDING','SENT','FAILED'))`. psql sale != 0, el helper lanza, y
// como el fixture vive en un `@BeforeAll` se cae la clase entera con `initializationError` — el
// síntoma más caro de diagnosticar que tiene este arnés.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function harnessFor(fixture, stack = {}) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-enumdoc-');
  scaffoldService({ manifest, layers, workspace, force: true, stack });

  const root = path.join(workspace, 'services', `${manifest.service.name}-spring`, 'src/integrationTest/java');
  let harness = null;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'AbstractFlowIT.java') harness = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  assert.ok(harness, `no se generó AbstractFlowIT para ${fixture}`);
  return harness;
}

test('el arnés lista los valores de enum EN LA FORMA DE LA COLUMNA', () => {
  const harness = harnessFor('stock-reservation');

  assert.match(harness, /Valores tal como se GUARDAN/);
  // La constante, que es lo que va en la columna...
  assert.match(harness, /ReservationStatus: PENDING, AWAITING_STOCK, CONFIRMED, RELEASED/);
  // ...y no el literal del diseño, que es lo que muestran specs/ y openapi.yaml.
  assert.ok(!/ReservationStatus:.*awaitingStock/.test(harness), 'lista el literal del cable, no la constante');
});

test('el ejemplo del motor documental ya no enseña un enum en minúsculas', () => {
  // Era lo único con pinta de enum que el arnés ponía delante, y mostraba la forma equivocada.
  // Un ejemplo que enseña el valor incorrecto es peor que no tener ejemplo.
  const harness = harnessFor('asset-vault', { database: 'mongodb' });
  assert.ok(!harness.includes('countDocuments({ status: "active" })'), 'el ejemplo sigue mostrando un enum en minúsculas');
});

test('solo se listan los enums que llegan a una columna', () => {
  // Un puerto no se ensancha con métodos que nadie llama, y un javadoc tampoco con valores que
  // no aparecen en ninguna tabla: serían ruido justo donde hace falta precisión.
  const harness = harnessFor('stock-reservation');
  const block = harness.slice(harness.indexOf('Valores tal como se GUARDAN'));
  const listed = [...block.matchAll(/^\s+\* (\w+): [A-Z]/gm)].map((match) => match[1]);
  assert.deepEqual(listed, ['ReservationStatus'], `enums listados: ${listed.join(', ')}`);
});

test('un diseño sin enums persistidos no genera el bloque', () => {
  // La ausencia importa: un encabezado vacío enseña a saltarse el javadoc.
  const { manifest, layers } = loadService(path.join(fixturesDir, 'stock-reservation'));
  const patched = structuredClone(layers);
  for (const entity of Object.values(patched.domain.entities ?? {})) {
    for (const [name, field] of Object.entries(entity.fields ?? {})) {
      if (field?.type && String(field.type).endsWith('Status')) delete entity.fields[name];
    }
    delete entity.lifecycle;
  }
  // Las operaciones que transicionan dejan de tener sentido sin el lifecycle: se limpian también.
  for (const operation of Object.values(patched['use-cases'].operations ?? {})) delete operation.transitions;

  const workspace = tmpDir('keel-enumdoc-none-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  let harness = null;
  const root = path.join(workspace, 'services', 'stock-reservation-spring', 'src/integrationTest/java');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'AbstractFlowIT.java') harness = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  assert.ok(harness, 'no se generó AbstractFlowIT');
  assert.ok(!harness.includes('Valores tal como se GUARDAN'), 'sin enums persistidos no hay tabla que enseñar');
});
