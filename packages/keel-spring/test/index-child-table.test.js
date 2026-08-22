// Un `@Index` sobre un campo que NO es columna de esa tabla produce DDL que no aplica.
//
// Una lista (`list: true`) se materializa como `@ElementCollection` en su TABLA HIJA. Anotar el
// índice en la entidad padre genera un `@Index(columnList = "recipients")` sobre una tabla que no
// tiene esa columna: compila, pasa todos los tests de cadenas, y revienta al aplicar el esquema —
// o se cuela en el baseline exportado y alguien lo corrige a mano, que es lo que pasó en una
// corrida real (el índice de `EmailMessageJpa` sobre `recipients`).
//
// build ya avisaba de que no sabía resolver el campo, y lo anotaba igual. Avisar y hacerlo mal es
// peor que no hacerlo: el aviso se pierde entre los demás y el DDL roto sobrevive.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** La fixture relacional con un campo lista indexado — la forma que rompía. */
function withIndexedList() {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.domain.entities.Reservation.fields.tags = { type: 'string', list: true };
  patched.persistence.entities.Reservation.indexes = [
    ...(patched.persistence.entities.Reservation.indexes ?? []),
    ['tags']
  ];

  const workspace = tmpDir('keel-childindex-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const entity = fs.readFileSync(
    path.join(
      workspace,
      'services/stock-reservation-spring/src/main/java/com/fulfillment/stockreservation',
      'infrastructure/persistence/entities/ReservationJpa.java'
    ),
    'utf8'
  );
  return { entity, warnings: result?.warnings ?? [] };
}

test('no se anota el índice de una lista: su columna vive en la tabla hija', () => {
  const { entity } = withIndexedList();

  // La lista sigue mapeada, que es lo correcto...
  assert.match(entity, /@ElementCollection/);
  // ...pero su índice NO se anota en la tabla del padre.
  assert.ok(!/@Index\([^)]*columnList = "`?tags`?"/.test(entity), 'se anotó un índice sobre una columna inexistente');
});

test('y se dice por qué, con la salida a tomar', () => {
  // Silencio aquí sería peor que el índice roto: el diseño declaró algo que no se generó, y esa
  // es justo la forma de fallo que el generador tiene prohibida — ignorar en silencio.
  const { warnings } = withIndexedList();
  const notice = warnings.find((warning) => warning.includes('tags'));
  assert.ok(notice, `no se avisó del índice descartado: ${warnings.join(' | ')}`);
  assert.match(notice, /NO se anota/);
  assert.match(notice, /tabla/);
});

test('los índices que SÍ son columnas del padre se siguen anotando', () => {
  // La regresión que hay que no cometer: filtrar de más y quedarse sin índices.
  const { manifest, layers } = loadService(path.join(fixturesDir, 'stock-reservation'));
  const workspace = tmpDir('keel-childindex-ok-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const entity = fs.readFileSync(
    path.join(
      workspace,
      'services/stock-reservation-spring/src/main/java/com/fulfillment/stockreservation',
      'infrastructure/persistence/entities/ReservationJpa.java'
    ),
    'utf8'
  );
  assert.match(entity, /@Index\(/, 'se perdieron los índices legítimos');
});
