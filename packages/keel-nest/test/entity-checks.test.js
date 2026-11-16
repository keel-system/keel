// La GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) en keel-nest: la forma
// de lo que emite build sobre el sujeto de keel-core/test/helpers/entity-check-designs.js, su paridad con keel-spring (los
// mismos casos, las mismas notas del handler y el mismo mensaje) y la guarda emitida EJECUTADA, transpilada y sin base,
// contra cada vector que no necesita persistencia. Lo que esto NO dice —que el save la llame antes de escribir, que un
// rechazo no deje nada escrito, que la columna guarde el derivado de ahora— lo miden db-check y doc-check contra el motor
// real (scripts/lib/invariant-probes.js: IC-1 a IC-11, CP-1 a CP-5).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { invariantsHandlerNote } from '@keel-system/keel-core/gen/entity-checks';
import { computedHandlerNote } from '@keel-system/keel-core/gen/computed';
import { ENTITY_CHECK_DESIGNS, INVARIANT_VECTORS } from '../../keel-core/test/helpers/entity-check-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { invariantCases } from '../scripts/lib/invariant-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { transpileTree } from './helpers/emitted.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/invariant-probes.js';

const design = (name) => ENTITY_CHECK_DESIGNS.find((entry) => entry.name === name);

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  return { manifest, layers };
}

function plan(name, generator = planService) {
  const { manifest, layers } = load(name);
  const document = layers.persistence.default.model === 'document';
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

/** El primer renglón con código de un método emitido, sin comentarios. */
const firstStatement = (source, signature) =>
  source.slice(source.indexOf(signature)).split('\n').slice(1).map((line) => line.trim()).find((line) => line && !line.startsWith('//') && !line.startsWith('return this.transactions'));

for (const name of ['catalog-invariants', 'catalog-invariants-mongo']) {
  test(`${name}: la frontera ya no rechaza los checks ni los derivados, y la sonda ejecuta los MISMOS casos que keel-spring`, () => {
    const { manifest, layers } = load(name);
    const { errors } = checkSupportedFeatures(manifest, layers);
    assert.deepEqual(errors.filter((error) => error.includes('DSL 2.31')), []);
    assert.deepEqual(invariantCases(plan(name).model), springCases(INVARIANT_VECTORS));
  });

  test(`${name}: la raíz emite ensureInvariants() con las hijas primero, sus cotas y sus checks en orden`, () => {
    const { files } = plan(name);
    const product = fileOf(files, 'src/domain/aggregate/product.ts');
    const guard = product.slice(product.indexOf('ensureInvariants(): void {'));
    const at = (text) => {
      const index = guard.indexOf(text);
      assert.ok(index >= 0, `falta ${text}`);
      return index;
    };
    // D23: hijas, derivados, cotas, checks.
    const order = [
      at('child.ensureInvariants();'),
      at("exceedsDecimal(this.#computePrintTotal().setScale(2, 'HALF_UP'), 2)"),
      at('SKU_PATTERN.test(this.#sku)'),
      at('this.#stockCount > 1000'),
      at('// check 0:'),
      at('// check 3:'),
      at('// check 6:')
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(guard, /throw new DiscountExceedsPriceError\('Product: discount ≤ listPrice\.'\);/);
    assert.match(guard, /throw new InvariantViolatedException\('Product: publishedAt es obligatorio cuando status es active\.'\);/);
    // D20: el json solo cuenta como ausente si es nulo.
    assert.match(guard, /this\.#status === ProductStatus\.ACTIVE && \(this\.#attributes == null\)/);
    // El derivado es un getter que calcula; su TODO de prosa desaparece.
    assert.match(product, /get printTotal\(\): Decimal \| null \{\n {4}return this\.#computePrintTotal\(\)\.setScale\(2, 'HALF_UP'\);/);
    assert.match(product, /get imageCount\(\): number \| null \{\n {4}return this\.#images\.length;/);
    assert.doesNotMatch(product, /TODO computed/);
    // La hija guarda su propio check.
    assert.match(fileOf(files, 'src/domain/entity/product-image.ts'), /ensureInvariants\(\): void \{[\s\S]*position ≥ 0/);
  });

  test(`${name}: el save llama a la guarda antes de leer o escribir nada, y el mapeo guarda el derivado del getter`, () => {
    const { files } = plan(name);
    const adapter = fileOf(files, 'product-repository-impl.ts');
    assert.equal(firstStatement(adapter, 'async save(entity: Product)'), 'entity.ensureInvariants();');
    assert.match(adapter, /\/\/ Derivado \(DSL 2\.31\): el valor que calcula el getter de la entidad\.\n\s+(orm\.printTotal = entity\.printTotal;|print_total: )/);
  });

  test(`${name}: el 422 tiene su clase con el code del catálogo, y el handler las MISMAS notas que keel-spring`, () => {
    const { files } = plan(name);
    const exception = fileOf(files, 'src/domain/errors/invariant-violated-exception.ts');
    assert.match(exception, /extends BusinessException/);
    assert.match(exception, /static readonly CODE = 'INVARIANT_VIOLATED';/);
    assert.match(exception, /httpStatus: 422/);
    const { layers } = load(name);
    // Los dos parten las notas en renglones de comentario: se comparan con el texto unido.
    const prose = (source) => source.replace(/\n\s*(\/\/|\*)\s+/g, ' ');
    const handler = prose(fileOf(files, 'update-product-command-handler.ts'));
    const spring = prose(fileOf(plan(name, planSpring).files, '/UpdateProductCommandHandler.java'));
    for (const note of [invariantsHandlerNote(layers, 'Product'), computedHandlerNote(layers.domain, 'Product')]) {
      assert.ok(spring.includes(note), `keel-spring no lleva la nota: ${note.slice(0, 60)}…`);
      assert.ok(handler.includes(note), `falta la nota: ${note.slice(0, 60)}…`);
    }
  });
}

test('la guarda emitida, EJECUTADA, responde a cada vector lo que dice la referencia (sin base: los que no necesitan persistencia)', async () => {
  const { files, model } = plan('catalog-invariants');
  const tree = transpileTree(files);
  const { Product } = await tree.load('src/domain/aggregate/product.ts');
  const { ProductImage } = await tree.load('src/domain/entity/product-image.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const { RawJson } = await tree.load('src/domain/support/raw-json.ts');
  const root = model.entities.find((entity) => entity.name === 'Product');
  const image = model.entities.find((entity) => entity.name === 'ProductImage');
  const convert = (field, value) => {
    if (value === null || value === undefined || !field) return value ?? null;
    if (field.base === 'decimal') return Decimal.parse(String(value));
    if (field.base === 'json') return RawJson.of(JSON.stringify(value));
    if (field.base === 'timestamp') return new Date(value);
    if (field.base === 'long') return BigInt(value);
    return value;
  };
  const stateOf = (entity, values) => {
    const state = { lockVersion: null };
    for (const field of entity.fields) state[field.name] = field.list ? [] : null;
    for (const relation of entity.relations) if (!relation.backReference) state[relation.internal ? relation.name : `${relation.name}Id`] = relation.cardinality === 'one-to-many' ? [] : null;
    for (const [key, value] of Object.entries(values)) {
      state[key] = key === 'images' ? value.map((entry) => new ProductImage(stateOf(image, entry))) : convert(entity.fields.find((field) => field.name === key), value);
    }
    return state;
  };
  let checked = 0;
  for (const vector of INVARIANT_VECTORS.filter((entry) => entry.case !== 'IC-10' && entry.case !== 'CP-5')) {
    const product = new Product(stateOf(root, vector.state));
    let code = null;
    try {
      product.ensureInvariants();
    } catch (error) {
      code = error.code ?? error.message;
    }
    assert.equal(code, vector.expect, `${vector.case}: ${vector.title}`);
    for (const [name, value] of Object.entries(vector.derived ?? {})) {
      assert.equal(String(product[name]), String(value), `${vector.case}: ${vector.title} (${name})`);
    }
    checked += 1;
  }
  assert.ok(checked > 20);
});

test('sin checks, cotas ni derivados no se emite la guarda ni su excepción', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'job-dispatch'));
  for (const entity of Object.values(layers.domain.entities)) {
    for (const field of Object.values(entity.fields ?? {})) delete field.constraints;
  }
  for (const type of Object.values(layers.domain.types ?? {})) delete type.constraints;
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.ok(!files.some((file) => file.path.endsWith('invariant-violated-exception.ts')));
  // El código, no los agentes: el agente de código nombra la guarda en todo proyecto.
  assert.ok(!files.some((file) => !file.path.endsWith('.md') && typeof file.content === 'string' && file.content.includes('ensureInvariants()')));
});
