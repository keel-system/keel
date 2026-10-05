// Las raíces nacen con un UUID versión 7, no con `UUID.randomUUID()`.
//
// Con la versión 4 —aleatoria— cada alta cae en un punto cualquiera del índice de la PK, y en los
// motores que guardan la tabla ordenada por ella (MySQL, MariaDB) eso la reordena con cada
// inserción. Nada falla: se degrada con el tamaño. Medido el 2026-10-05 que `ORDER BY id` devuelve
// el orden temporal de los v7 en PostgreSQL, MySQL (`binary(16)`) y MariaDB 11 (`uuid` nativo), y
// que el helper generado, compilado con javac, da versión 7, variante RFC y orden entre milisegundos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function generate(fixture) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-ids-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const java = fs
    .readdirSync(workspace, { recursive: true })
    .filter((file) => file.endsWith('.java'))
    .map((file) => ({ name: path.basename(file), source: fs.readFileSync(path.join(workspace, file), 'utf8') }));
  return (name) => java.find((file) => file.name === name)?.source ?? null;
}

test('el id generado de una raíz nace con Uuids.v7(), en las dos ramas', () => {
  for (const [fixture, root] of [
    ['stock-reservation', 'Reservation.java'],
    ['job-dispatch-mongo', 'Job.java']
  ]) {
    const read = generate(fixture);
    const entity = read(root);
    assert.match(entity, /private UUID id = Uuids\.v7\(\);/, `${fixture}: el id no nace con v7`);
    assert.match(entity, /^import [\w.]+\.domain\.identity\.Uuids;$/m, `${fixture}: falta el import del helper`);
    assert.ok(!entity.includes('UUID.randomUUID()'), `${fixture}: queda un v4`);
  }
});

test('el helper compone un v7 de RFC 9562: tiempo delante, versión 7, variante 10', () => {
  const uuids = generate('stock-reservation')('Uuids.java');
  assert.ok(uuids, 'no se generó el helper');
  assert.match(uuids, /package [\w.]+\.domain\.identity;/);
  // Java puro: el dominio no importa Spring ni nada fuera del JDK.
  assert.deepEqual(uuids.match(/^import .+;$/gm), ['import java.security.SecureRandom;', 'import java.util.UUID;']);
  assert.match(uuids, /long msb = \(millis << 16\) \| 0x7000L \| /, 'el tiempo no va delante o falta la versión 7');
  assert.match(uuids, /long lsb = 0x8000000000000000L \| /, 'falta la variante 10');
});
