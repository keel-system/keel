// La GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) en keel-spring: la forma
// de lo que emite build sobre el sujeto de keel-core/test/helpers/entity-check-designs.js. Lo que esto NO dice —que la
// guarda se cumpla vector a vector, que el code sea el del check, que la suma redondee una vez y HALF_UP, que la columna
// guarde el derivado de ahora— lo mide scripts/invariant-check.js contra el motor real (IC-1 a IC-11, CP-1 a CP-5).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { invariantsHandlerNote } from '@keel-system/keel-core/gen/entity-checks';
import { computedHandlerNote } from '@keel-system/keel-core/gen/computed';
import { ENTITY_CHECK_DESIGNS } from '../../keel-core/test/helpers/entity-check-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => ENTITY_CHECK_DESIGNS.find((entry) => entry.name === name);

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  return { manifest, layers };
}

function plan(name) {
  const { manifest, layers } = load(name);
  const document = layers.persistence.default.model === 'document';
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

for (const name of ['catalog-invariants', 'catalog-invariants-mongo']) {
  test(`${name}: la frontera ya no rechaza los checks ni los derivados`, () => {
    const { manifest, layers } = load(name);
    const { errors } = checkSupportedFeatures(manifest, layers);
    assert.deepEqual(errors.filter((error) => error.includes('DSL 2.31')), []);
  });

  test(`${name}: la raíz emite ensureInvariants() con las hijas primero, sus cotas y sus checks en orden`, () => {
    const { files } = plan(name);
    const product = fileOf(files, '/domain/aggregate/Product.java');
    const guard = product.slice(product.indexOf('public void ensureInvariants()'));
    const at = (text) => {
      const index = guard.indexOf(text);
      assert.ok(index >= 0, `falta ${text}`);
      return index;
    };
    // D23: hijas, derivados, cotas, checks.
    const order = [
      at('child.ensureInvariants();'),
      at('exceedsDecimal(computePrintTotal(), 2)'),
      at('SKU_PATTERN.matcher(sku).matches()'),
      at('stockCount > 1000'),
      at('// check 0:'),
      at('// check 3:'),
      at('// check 6:')
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(guard, /throw new DiscountExceedsPriceError\("Product: discount ≤ listPrice\."\);/);
    assert.match(guard, /throw new InvariantViolatedException\("Product: publishedAt es obligatorio cuando status es active\."\);/);
    // D20: el json solo cuenta como ausente si es nulo.
    assert.match(guard, /status == ProductStatus\.ACTIVE && \(attributes == null\)/);
    // El derivado es un getter que calcula; su TODO de prosa desaparece.
    assert.match(product, /public BigDecimal getPrintTotal\(\) \{\n        return computePrintTotal\(\);/);
    assert.match(product, /public Integer getImageCount\(\) \{\n        return images\.size\(\);/);
    assert.match(product, /return total\.setScale\(2, RoundingMode\.HALF_UP\);/);
    assert.doesNotMatch(product, /TODO computed/);
    // La hija guarda su propio check.
    assert.match(fileOf(files, '/domain/entity/ProductImage.java'), /public void ensureInvariants\(\) \{[\s\S]*position ≥ 0/);
  });

  test(`${name}: el save llama a la guarda antes de leer o escribir nada`, () => {
    const { files } = plan(name);
    const adapter = fileOf(files, '/ProductRepositoryImpl.java');
    const save = adapter.slice(adapter.indexOf('public Product save(Product entity)'));
    const first = save.split('\n').slice(1).find((line) => line.trim() && !line.trim().startsWith('//'));
    assert.equal(first.trim(), 'entity.ensureInvariants();');
  });

  test(`${name}: el 422 tiene su clase con el code del catálogo, y el handler su nota`, () => {
    const { files } = plan(name);
    const exception = fileOf(files, '/domain/errors/InvariantViolatedException.java');
    assert.match(exception, /extends BusinessException/);
    assert.match(exception, /CODE = "INVARIANT_VIOLATED"/);
    assert.match(exception, /super\(message, CODE, 422, null\);/);
    const { layers } = load(name);
    const handler = fileOf(files, '/UpdateProductCommandHandler.java');
    assert.ok(handler.includes(invariantsHandlerNote(layers, 'Product')), 'falta la nota de la guarda');
    assert.ok(handler.includes(computedHandlerNote(layers.domain, 'Product')), 'falta la nota de los derivados');
  });
}

test('sin checks, cotas ni derivados no se emite la guarda ni su excepción', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'job-dispatch'));
  for (const entity of Object.values(layers.domain.entities)) {
    for (const field of Object.values(entity.fields ?? {})) delete field.constraints;
    delete entity.checks;
  }
  for (const type of Object.values(layers.domain.types ?? {})) delete type.constraints;
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.ok(!files.some((file) => file.path.endsWith('InvariantViolatedException.java')));
  // El código, no los agentes: el agente de código nombra la guarda en todo proyecto.
  assert.ok(!files.some((file) => !file.path.endsWith('.md') && typeof file.content === 'string' && file.content.includes('ensureInvariants()')));
});
