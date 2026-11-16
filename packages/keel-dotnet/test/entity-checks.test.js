// La GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) en keel-dotnet: la forma
// de lo que emite build sobre el sujeto de keel-core/test/helpers/entity-check-designs.js y su paridad con keel-spring y
// keel-nest (los mismos casos, las mismas notas del handler y el mismo mensaje). Lo que esto NO dice —que la guarda
// responda a cada vector lo que dice la referencia, que el Save la llame antes de escribir, que un rechazo no deje nada
// escrito, que la columna guarde el derivado de ahora— lo miden db-check y doc-check contra el motor real
// (scripts/lib/invariant-probes.js: IC-1 a IC-11, CP-1 a CP-5), con el C# compilado.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService, FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { invariantsHandlerNote, invariantMessage, resolvedChecks } from '@keel-system/keel-core/gen/entity-checks';
import { computedHandlerNote } from '@keel-system/keel-core/gen/computed';
import { ENTITY_CHECK_DESIGNS, INVARIANT_VECTORS } from '../../keel-core/test/helpers/entity-check-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { INVARIANT_SABOTAGE_SPECS, invariantCases } from '../scripts/lib/invariant-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/invariant-probes.js';
import { invariantCases as nestCases } from '../../keel-nest/scripts/lib/invariant-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';

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

/** El primer renglón con código del cuerpo de la transacción del Save, sin comentarios. */
const firstStatement = (source) => {
  const body = source.slice(source.indexOf('public async Task<Product> Save('));
  return body
    .slice(body.indexOf('async () =>'))
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line && line !== '{' && !line.startsWith('//') && !line.startsWith('var session'));
};

for (const name of ['catalog-invariants', 'catalog-invariants-mongo']) {
  test(`${name}: la frontera ya no rechaza los checks ni los derivados, y la sonda ejecuta los MISMOS casos que keel-spring y keel-nest`, () => {
    const { manifest, layers } = load(name);
    const { errors } = checkSupportedFeatures(manifest, layers);
    assert.deepEqual(errors.filter((error) => error.includes('DSL 2.31')), []);
    const { model } = plan(name);
    assert.deepEqual(invariantCases(model), springCases(INVARIANT_VECTORS));
    assert.deepEqual(invariantCases(model), nestCases(plan(name, planNest).model));
  });

  test(`${name}: la raíz emite EnsureInvariants() con las hijas primero, sus cotas y sus checks en orden`, () => {
    const { files } = plan(name);
    const product = fileOf(files, '.Domain/Aggregate/Product.cs');
    const guard = product.slice(product.indexOf('public void EnsureInvariants()'));
    const at = (text) => {
      const index = guard.indexOf(text);
      assert.ok(index >= 0, `falta ${text}`);
      return index;
    };
    // D23: hijas, derivados, cotas, checks.
    const order = [
      at('child.EnsureInvariants();'),
      at('ExceedsDecimal(Math.Round(printTotalSum, 2, MidpointRounding.AwayFromZero), 2)'),
      at('!SkuPattern().IsMatch(Sku)'),
      at('StockCount > 1000'),
      at('// check 0:'),
      at('// check 3:'),
      at('// check 6:')
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(guard, /throw new DiscountExceedsPriceError\("Product: discount ≤ listPrice\."\);/);
    assert.match(guard, /throw new InvariantViolatedException\("Product: publishedAt es obligatorio cuando status es active\."\);/);
    // D19: un operando ausente cumple la comparación.
    assert.match(guard, /!\(Discount is null \|\| ListPrice is null \|\| Discount <= ListPrice\)/);
    // D20: el json solo cuenta como ausente si es nulo.
    assert.match(guard, /Status == ProductStatus\.Active && \(Attributes is null\)/);
    // La longitud de un texto en puntos de código (D24).
    assert.match(guard, /Ean\.EnumerateRunes\(\)\.Count\(\) > 13/);
    // El derivado es una propiedad que calcula, a la escala del campo; su TODO de prosa desaparece y el constructor no lo asigna.
    assert.match(product, /public decimal\? PrintTotal => Math\.Round\(ComputePrintTotal\(\) \?\? throw new InvariantViolatedException\([^)]*\), 2, MidpointRounding\.AwayFromZero\) \+ 0\.00m;/);
    assert.match(product, /public int\? ImageCount => Images\.Count;/);
    assert.doesNotMatch(product, /TODO computed/);
    assert.doesNotMatch(product, /PrintTotal = state\.PrintTotal;/);
    // Los patrones con GeneratedRegex: la clase es parcial.
    assert.match(product, /public partial class Product\b/);
    // La hija guarda su propio check.
    assert.match(fileOf(files, '.Domain/Entity/ProductImage.cs'), /public void EnsureInvariants\(\)[\s\S]*position ≥ 0/);
  });

  test(`${name}: el Save llama a la guarda antes de leer o escribir nada, y el mapeo guarda el derivado de la propiedad`, () => {
    const { files } = plan(name);
    const adapter = fileOf(files, 'Repositories/ProductRepository.cs');
    assert.equal(firstStatement(adapter), 'entity.EnsureInvariants();');
    assert.match(adapter, /\/\/ Derivado \(DSL 2\.31\): el valor que calcula la propiedad de la entidad\.\n\s+(row\.PrintTotal = entity\.PrintTotal;|\{ "print_total", )/);
  });

  test(`${name}: el 422 tiene su clase con el code del catálogo, y el handler las MISMAS notas que keel-spring`, () => {
    const { files } = plan(name);
    const exception = fileOf(files, '.Domain/Errors/InvariantViolatedException.cs');
    assert.match(exception, /: BusinessException\(message, code: "INVARIANT_VIOLATED", httpStatus: 422\);/);
    const { layers } = load(name);
    // Los tres parten las notas en renglones de comentario: se comparan con el texto unido.
    const prose = (source) => source.replace(/\n\s*(\/\/|\*)\s+/g, ' ');
    const handler = prose(fileOf(files, 'UpdateProductCommandHandler.cs'));
    const spring = prose(fileOf(plan(name, planSpring).files, '/UpdateProductCommandHandler.java'));
    for (const note of [invariantsHandlerNote(layers, 'Product'), computedHandlerNote(layers.domain, 'Product')]) {
      assert.ok(spring.includes(note), `keel-spring no lleva la nota: ${note.slice(0, 60)}…`);
      assert.ok(handler.includes(note), `falta la nota: ${note.slice(0, 60)}…`);
    }
  });

  test(`${name}: cada mensaje de la guarda es el neutral, el mismo que lanza keel-spring`, () => {
    const { files } = plan(name);
    const product = fileOf(files, '.Domain/Aggregate/Product.cs');
    const spring = fileOf(plan(name, planSpring).files, '/Product.java');
    const { layers } = load(name);
    const messages = [
      ...resolvedChecks(layers, 'Product').map((check) => invariantMessage('Product', { kind: 'check', check })),
      invariantMessage('Product', { kind: 'bound', field: 'stockCount' }),
      invariantMessage('Product', { kind: 'computed', field: 'printTotal' })
    ];
    for (const message of messages) {
      assert.ok(product.includes(JSON.stringify(message)), `falta: ${message}`);
      assert.ok(spring.includes(JSON.stringify(message)), `keel-spring no lanza: ${message}`);
    }
  });

  test(`${name}: cada sabotaje de la guarda se aplica a lo emitido`, () => {
    const { files } = plan(name);
    const branch = name.endsWith('-mongo') ? 'document' : 'relational';
    for (const [id, specs] of Object.entries(INVARIANT_SABOTAGE_SPECS)) {
      const [suffix, from, to] = specs[branch];
      const hits = files.filter((file) => file.path.includes(suffix) && file.path.startsWith('src/') && typeof file.content === 'string').filter((file) => {
        const changed = typeof from === 'string' ? file.content.replaceAll(from, to) : file.content.replace(from, to);
        return changed !== file.content;
      });
      assert.ok(hits.length > 0, `${id} no cambia nada de lo emitido`);
    }
  });
}

test('sin checks, cotas ni derivados no se emite la guarda ni su excepción', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'job-dispatch'));
  for (const entity of Object.values(layers.domain.entities)) {
    for (const field of Object.values(entity.fields ?? {})) delete field.constraints;
  }
  for (const type of Object.values(layers.domain.types ?? {})) delete type.constraints;
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.ok(!files.some((file) => file.path.endsWith('InvariantViolatedException.cs')));
  // El código, no los agentes: el agente de código nombra la guarda en todo proyecto.
  assert.ok(!files.some((file) => !file.path.endsWith('.md') && typeof file.content === 'string' && file.content.includes('EnsureInvariants()')));
});

test('un diseño que sustituye INVARIANT_VIOLATED con su propio error no emite la clase por defecto y lanza el suyo', () => {
  const { manifest, layers } = load('catalog-invariants');
  layers['use-cases'].operations.updateProduct.errors.push({ code: 'PRODUCT_INVARIANT_BROKEN', when: 'El producto quedaría incoherente.', http: 422 });
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.equal(FRAMEWORK_ERRORS.invariantViolated.family.test('PRODUCT_INVARIANT_BROKEN'), true);
  assert.ok(!files.some((file) => file.path.endsWith('InvariantViolatedException.cs')));
  assert.match(fileOf(files, '.Domain/Aggregate/Product.cs'), /throw new ProductInvariantBrokenError\("Product: publishedAt es obligatorio/);
});
