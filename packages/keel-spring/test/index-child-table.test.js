// Un `@Index` sobre un campo que NO es columna de esa tabla produce DDL que no aplica.
//
// Una lista (`list: true`) se materializa como `@ElementCollection` en su TABLA HIJA. Anotar el
// índice en la entidad padre genera un `@Index(columnList = "recipients")` sobre una tabla que no
// tiene esa columna: compila, pasa todos los tests de cadenas, y revienta al aplicar el esquema —
// o se cuela en el baseline exportado y alguien lo corrige a mano, que es lo que pasó en una
// corrida real (el índice de `EmailMessageJpa` sobre `recipients`).
//
// La primera respuesta fue descartarlo con un aviso, y era media respuesta: el índice declarado no
// existía en ninguna parte —ni en la entidad, ni en el appendix de migrations.js, que solo cubre
// los CONDICIONADOS—, así que el filtro que el diseño quería acotar seguía recorriendo entera una
// tabla que crece con cada elemento. Y la tabla hija la genera build: nombre, columna del elemento
// y FK a la raíz salen todos de él. Ahí sí cabe el índice, y ahí es donde va.

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
function withIndexedList(patchLayers = () => {}) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.domain.entities.Reservation.fields.tags = { type: 'string', list: true };
  patched.persistence.entities.Reservation.indexes = [
    ...(patched.persistence.entities.Reservation.indexes ?? []),
    ['tags']
  ];
  patchLayers(patched);

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

test('el índice de una lista no se anota en la tabla del padre', () => {
  const { entity } = withIndexedList();

  // La lista sigue mapeada, que es lo correcto...
  assert.match(entity, /@ElementCollection/);
  // ...y el `@Table` de la entidad no nombra una columna que esa tabla no tiene.
  const tableAnnotation = entity.slice(entity.indexOf('@Table('), entity.indexOf('public class'));
  assert.ok(!tableAnnotation.includes('tags'), 'se anotó un índice sobre una columna inexistente del padre');
});

test('se materializa en la tabla de elementos, que build genera entera', () => {
  // Silencio aquí sería peor que el índice roto: el diseño declaró algo que no se generó, y esa
  // es justo la forma de fallo que el generador tiene prohibida — ignorar en silencio. Pero
  // avisar tampoco era la respuesta cuando el índice SÍ es materializable.
  const { entity, warnings } = withIndexedList();

  assert.match(
    entity,
    /@CollectionTable\(name = "reservation_tags", joinColumns = @JoinColumn\(name = "reservation_id"\), indexes = @Index\(name = "idx_reservations_tags", columnList = "tags, reservation_id"\)\)/,
    'el índice declarado sobre la lista no aparece en su @CollectionTable'
  );
  // La columna del ELEMENTO va primero: el filtro es una igualdad sobre el valor, y la FK
  // detrás para que el salto a la raíz no vuelva a la tabla.
  assert.ok(
    !warnings.some((warning) => warning.includes('tags')),
    `se avisa de un índice que sí se genera: ${warnings.filter((w) => w.includes('tags')).join(' | ')}`
  );
});

test('lo que sigue sin ser materializable avisa, y dice la salida', () => {
  // Un compuesto que mezcla la lista con columnas del padre no cabe en ninguna tabla: los
  // elementos y `status` no viven juntos, y ningún índice de un motor relacional los cubre.
  const { entity, warnings } = withIndexedList((patched) => {
    patched.persistence.entities.Reservation.indexes.push(['tags', 'status']);
  });

  const notice = warnings.find((warning) => warning.includes('tags, status'));
  assert.ok(notice, `no se avisó del índice descartado: ${warnings.join(' | ')}`);
  assert.match(notice, /NO se anota/);
  assert.match(notice, /tabla/);
  const tableAnnotation = entity.slice(entity.indexOf('@Table('), entity.indexOf('public class'));
  assert.ok(!tableAnnotation.includes('tags'), 'el compuesto imposible se anotó igualmente');
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
