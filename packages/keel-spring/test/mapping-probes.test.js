// La elección del sujeto de `mapping-check`, que es donde este check se puede engañar solo.
//
// El runner necesita podman y un JDK, así que no corre en `npm test`. Lo que sí corre aquí es la
// parte que decide QUÉ se mide — y es la que ya estuvo mal una vez: la primera versión sacaba la
// cota del mismo `@Column` que iba a medir, así que quitarle el `length` hacía desaparecer el
// sujeto («no hay columna que medir») en vez de poner el caso en rojo. Una red que deriva su
// expectativa de la cosa que mide se mide a sí misma; ya pasó con `mongo-check` y su `print(`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { mappingSubject, hasSubject } from '../src/lib/mapping-probes.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const modeloDe = (fixture, database) => {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  return buildModel({ manifest, layers, stack: { database } });
};

test('el sujeto es una raíz de agregado con una cota que declaró el DISEÑO', () => {
  const subject = mappingSubject(modeloDe('stock-reservation', 'postgresql'));
  assert.ok(hasSubject(subject));
  assert.equal(subject.entity.name, 'Reservation');
  assert.equal(subject.field.name, 'sku');
  assert.equal(subject.maxLength, 32);
  assert.equal(subject.entity.isAggregateRoot, true, 'una hija no tiene repositorio propio con el que sembrarla');
});

test('la cota NO se lee del @Column que se va a medir', () => {
  // El caso que ata la lección. Se le quita al campo su `@Column` entero: el sujeto tiene que
  // seguir en pie, porque su expectativa viene de la validación —otra proyección del mismo dato
  // del diseño, emitida por otro camino—. Si volviera a leerse de la columna, esto devolvería
  // null y el check se quedaría sin nada que medir justo cuando hay algo que encontrar.
  const model = modeloDe('stock-reservation', 'postgresql');
  const entity = model.entities.find((e) => e.name === 'Reservation');
  const field = entity.fields.find((f) => f.name === 'sku');
  const original = field.columns;
  field.columns = ['@Column(name = "sku", nullable = false)'];
  try {
    const subject = mappingSubject(model);
    assert.ok(hasSubject(subject), 'sin @Column length el sujeto desapareció: la expectativa sale de lo que se mide');
    assert.equal(subject.maxLength, 32);
  } finally {
    field.columns = original;
  }
});

test('se descarta lo que la siembra compartida no sabe fabricar', () => {
  // `product-catalog` tiene un value object obligatorio (`Money`) en su raíz. Darlo por sembrable
  // produce un `Money.values()[0]` que no compila, y el mensaje de javac no dice lo que pasa.
  assert.equal(mappingSubject(modeloDe('product-catalog', 'postgresql')), null);
});

test('el modelo documental tiene OTRO sujeto, y por una razón', () => {
  // La cota de un `String` en Mongo no la impone el almacén: el documento acepta el texto que sea,
  // así que medirla ahí sería medir Bean Validation y no el mapeo. Lo que sí es del mapeo es el
  // NOMBRE con el que se guarda el campo — y hay un camino que no pasa por la anotación: el
  // `Update` del reclamo, que nombra la propiedad Java.
  const subject = mappingSubject(modeloDe('job-dispatch-mongo', 'mongodb'));
  assert.ok(hasSubject(subject));
  assert.equal(subject.kind, 'document');
  assert.equal(subject.entity.name, 'Job');
  assert.equal(subject.javaName, 'runningSince');
  assert.equal(subject.storedName, 'running_since');
  assert.notEqual(subject.javaName, subject.storedName, 'sin traducción que hacer, el check no mediría nada');
  assert.ok(subject.claim?.method, 'el sujeto documental es el reclamo GENERADO, no una copia suya');
});

test('y un diseño documental sin reclamo que estampe no tiene sujeto', () => {
  // `notification-mailer-mongo` reclama, pero ninguno de sus reclamos estampa un reloj: sin campo
  // que traducir no hay traducción que comprobar, y decirlo es mejor que inventar un sujeto.
  assert.equal(mappingSubject(modeloDe('notification-mailer-mongo', 'mongodb')), null);
});
