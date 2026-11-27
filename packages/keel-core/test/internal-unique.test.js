// La unicidad global de una entidad interna (src/lib/gen/internal-unique.js): qué claves de una hija necesitan una
// consulta en el puerto de su raíz y dónde viven en el documento. Los sujetos son los de
// test/helpers/internal-unique-designs.js, los mismos que recorren los cuatro generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { internalUniqueKeys } from '../src/lib/gen/internal-unique.js';
import { INTERNAL_UNIQUE_DESIGNS } from './helpers/internal-unique-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function designOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return { layers, model: buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }) };
}
const rootsOf = (model) => model.entities.filter((entity) => entity.isAggregateRoot);
const keysOf = (model) => rootsOf(model).flatMap((root) => internalUniqueKeys(model, root).map((key) => ({ root: root.name, child: key.entity.name, field: key.field.name, documentPath: key.documentPath })));

test('los sujetos validan sin errores y dan su clave en la raíz, con la ruta del documento', () => {
  for (const design of INTERNAL_UNIQUE_DESIGNS) {
    const { layers, model } = designOf(design.from, design.mutate);
    assert.deepEqual(checkCrossRefs({ layers }).errors, [], design.name);
    assert.deepEqual(keysOf(model), [{ root: design.root, child: design.child, field: design.field, documentPath: 'variables.code' }], design.name);
  }
});

test('ninguna fixture tiene hoy una clave única global en una hija: la clave acotada a la colección no cuenta', () => {
  for (const fixture of fs.readdirSync(FIXTURES_DIR)) {
    const { model } = designOf(fixture);
    assert.deepEqual(keysOf(model), [], fixture);
  }
});

test('la clave natural de un solo campo de la hija cuenta; la que incluye la relación al padre, no', () => {
  const natural = designOf('notification-mailer', (layers) => {
    layers.domain.entities.TemplateVariable.fields.code = { type: 'string', required: true, constraints: { maxLength: 64 } };
    layers.persistence.entities.TemplateVariable.naturalKey = ['code'];
  });
  assert.deepEqual(keysOf(natural.model).map((key) => key.field), ['code']);
});
