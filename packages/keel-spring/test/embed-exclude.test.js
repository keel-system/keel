// El recorte de un agregado EMBEBIDO (`exclude: [category.createdAt]` junto a `embed: [category]`)
// lo aplica build. Hasta la corrida `catalog` (2026-09-29) era un aviso por campo —40 en ese
// diseño— que pedía al agente «quitarle X» a un <E>RefDto que otras operaciones necesitaban
// entero, y el agente acabó inventando BrandSummaryDto/CategorySummaryDto y reescribiendo cuatro
// DTOs y el mapper. Las dos ramas: mismo recorte en todas las proyecciones (se recorta el propio
// RefDto) y recortes distintos (el RefDto queda completo y sale una variante).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtureDir = path.join(FIXTURES_DIR, 'catalog-extended');

function load(patch = () => {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patch(patched.use_cases ?? patched['use-cases']);
  return { manifest, layers: patched };
}

const nested = (warnings) => warnings.filter((w) => w.includes('DTO anidado'));
const opOutput = (useCases, name) => useCases.operations[name].output;

test('recortes distintos: el RefDto sigue completo y la proyección recortada usa una variante con from()', () => {
  // La fixture ya lo declara: addProductImage recorta la categoría y updateProduct no.
  const { manifest, layers } = load();
  const model = buildModel({ manifest, layers });
  assert.deepEqual(nested(model.warnings), []);

  const ref = model.refDtos.find((dto) => dto.name === 'CategoryRefDto');
  assert.ok(ref.fields.some((f) => f.name === 'recordWithdrawalAwaitingSince'), 'el RefDto tiene que quedar completo');
  assert.deepEqual(
    model.refVariants.map((v) => [v.name, v.source]),
    [['CategorySummaryDto', 'CategoryRefDto']]
  );
  assert.ok(!model.refVariants[0].fields.some((f) => f.name === 'recordWithdrawalAwaitingSince'));

  const { files } = planService({ manifest, layers, workspace: fixtureDir });
  const get = (suffix) => files.find((f) => f.path.split(path.sep).join('/').endsWith(suffix))?.content;
  const variant = get('/CategorySummaryDto.java');
  assert.ok(variant, 'no se generó la variante');
  assert.match(variant, /public static CategorySummaryDto from\(CategoryRefDto ref\) \{\n\s+return ref == null \? null : new CategorySummaryDto\(ref\.id\(\), /);
  assert.ok(!variant.includes('recordWithdrawalAwaitingSince'));

  const mapper = get('/ProductApplicationMapper.java');
  // El parámetro sigue siendo el RefDto completo (lo da el resolver, un lote por raíz)…
  assert.match(mapper, /toAddProductImageResponseDto\(Product entity, CategoryRefDto category\)/);
  // …y el recorte se hace al construir la respuesta.
  assert.ok(mapper.includes('CategorySummaryDto.from(category)'));
  assert.match(mapper, /toUpdateProductResponseDto\(Product entity, CategoryRefDto category\)/);
  assert.ok(get('/AddProductImageResponseDto.java').includes('CategorySummaryDto category'));
  assert.ok(get('/UpdateProductResponseDto.java').includes('CategoryRefDto category'));
});

test('mismo recorte en todas las proyecciones: se recorta el propio RefDto, sin variante', () => {
  const { manifest, layers } = load((useCases) => {
    opOutput(useCases, 'updateProduct').exclude.push('category.recordWithdrawalAwaitingSince');
  });
  const model = buildModel({ manifest, layers });
  assert.deepEqual(nested(model.warnings), []);
  assert.deepEqual(model.refVariants, []);
  const ref = model.refDtos.find((dto) => dto.name === 'CategoryRefDto');
  assert.ok(!ref.fields.some((f) => f.name === 'recordWithdrawalAwaitingSince'));
});

test('sin recorte en ninguna proyección: todo como antes (RefDto completo, sin variante)', () => {
  const { manifest, layers } = load((useCases) => {
    const out = opOutput(useCases, 'addProductImage');
    out.exclude = out.exclude.filter((p) => !p.includes('.'));
  });
  const model = buildModel({ manifest, layers });
  assert.deepEqual(model.refVariants, []);
  assert.ok(model.refDtos.find((dto) => dto.name === 'CategoryRefDto').fields.some((f) => f.name === 'recordWithdrawalAwaitingSince'));
});
