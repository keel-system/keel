// El 415 del tipo de archivo rechazado (UNSUPPORTED_CONTENT_TYPE, keel-core/src/lib/framework-errors.js), el mismo en los
// cuatro generadores. Lo destapó la corrida catalog de 2026-11-07: con el mismo diseño, el agente de keel-spring respondió
// 400 UNSUPPORTED_CONTENT_TYPE y el de keel-nest 400 VALIDATION_ERROR, porque el tamaño tenía su código de framework y el
// tipo no, y la nota del handler decía qué comprobar pero no qué responder. Ahora cada generador emite el rechazo ya hecho
// —la excepción, o el centinela en Go— y su nota lo nombra con su código y su status.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { restrictsContentTypes } from '@keel-system/keel-core/gen/buckets';
import { planService as planGo } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const GENERATORS = {
  spring: { plan: planSpring, rejection: /UnsupportedContentTypeException\.java$/, handler: /AddProductImageCommandHandler\.java$/ },
  nest: { plan: planNest, rejection: /unsupported-content-type-exception\.ts$/, handler: /add-product-image-command-handler\.ts$/ },
  dotnet: { plan: planDotnet, rejection: /UnsupportedContentTypeException\.cs$/, handler: /AddProductImageCommandHandler\.cs$/ },
  go: { plan: planGo, rejection: /internal\/domain\/errors\.go$/, handler: /add_product_image_command_handler\.go$/ }
};

function plan(generator, mutate = () => {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  mutate(layers);
  return GENERATORS[generator].plan({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
}

const fileOf = (files, pattern) => files.find((file) => pattern.test(file.path))?.content ?? '';

for (const generator of Object.keys(GENERATORS)) {
  test(`${generator}: el bucket con tipos admitidos trae el 415 hecho, y la nota del handler lo nombra`, () => {
    const { files, model } = plan(generator);
    assert.ok(restrictsContentTypes(model), 'catalog-extended sube a un bucket con allowedContentTypes');
    const rejection = fileOf(files, GENERATORS[generator].rejection);
    assert.match(rejection, /UNSUPPORTED_CONTENT_TYPE/);
    assert.match(rejection, /415/);
    // La nota se emite en un comentario partido en líneas: se compara sin los saltos ni los marcadores de comentario.
    const note = fileOf(files, GENERATORS[generator].handler).replace(/\n\s*(\/\/)?\s*/g, ' ');
    assert.match(note, /UNSUPPORTED_CONTENT_TYPE \(415\) si no lo admite/);
  });

  test(`${generator}: con el error declarado por el diseño, no emite el suyo y la nota nombra el del diseño`, () => {
    const { files } = plan(generator, (layers) => {
      layers['use-cases'].operations.addProductImage.errors.push({ code: 'IMAGE_CONTENT_TYPE_NOT_ALLOWED', when: 'El archivo no es una imagen admitida.', http: 415 });
    });
    assert.doesNotMatch(fileOf(files, GENERATORS[generator].rejection), /UNSUPPORTED_CONTENT_TYPE/);
    const note = fileOf(files, GENERATORS[generator].handler).replace(/\n\s*(\/\/)?\s*/g, ' ');
    assert.match(note, /IMAGE_CONTENT_TYPE_NOT_ALLOWED \(415\) si no lo admite/);
  });
}

test('sin tipos admitidos en el bucket no hay 415 que emitir', () => {
  const { files, model } = plan('go', (layers) => {
    for (const bucket of Object.values(layers.storage.buckets)) delete bucket.allowedContentTypes;
  });
  assert.equal(restrictsContentTypes(model), false);
  assert.doesNotMatch(fileOf(files, GENERATORS.go.rejection), /UNSUPPORTED_CONTENT_TYPE/);
});
