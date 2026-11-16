// La GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) en keel-go: la forma de
// lo que emite build sobre el sujeto de keel-core/test/helpers/entity-check-designs.js y su paridad con los otros tres (los
// mismos casos, las mismas notas del handler y el mismo mensaje). Lo que esto NO dice —que la guarda responda a cada
// vector lo que dice la referencia, que el Save la llame antes de escribir, que un rechazo no deje nada escrito, que la
// columna guarde el derivado de ahora— lo miden db-check y doc-check contra el motor real (scripts/lib/invariant-probes.js:
// IC-1 a IC-11, CP-1 a CP-5), con el Go compilado.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService, FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { invariantsHandlerNote, invariantMessage, resolvedChecks } from '@keel-system/keel-core/gen/entity-checks';
import { computedHandlerNote } from '@keel-system/keel-core/gen/computed';
import { INVARIANT_VECTORS } from '../../keel-core/test/helpers/entity-check-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { INVARIANT_SABOTAGE_SPECS, invariantCases } from '../scripts/lib/invariant-probes.js';
import { FIXTURES_DIR, UNCOVERED_BRANCHES } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/invariant-probes.js';
import { invariantCases as dotnetCases } from '../../keel-dotnet/scripts/lib/invariant-probes.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { goString } from '../src/lib/go-source.js';

const design = (name) => UNCOVERED_BRANCHES.find((entry) => entry.name === name);

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(manifest, layers);
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

for (const name of ['catalog-invariants', 'catalog-invariants-mongo']) {
  const store = name.endsWith('-mongo') ? 'mongo' : 'postgres';

  test(`${name}: la frontera ya no rechaza los checks ni los derivados, y la sonda ejecuta los MISMOS casos que keel-spring y keel-dotnet`, () => {
    const { manifest, layers } = load(name);
    const { errors } = checkSupportedFeatures(manifest, layers);
    assert.deepEqual(errors.filter((error) => error.includes('DSL 2.31')), []);
    const { model } = plan(name);
    assert.deepEqual(invariantCases(model), springCases(INVARIANT_VECTORS));
    assert.deepEqual(invariantCases(model), dotnetCases(plan(name, planDotnet).model));
  });

  test(`${name}: la raíz emite EnsureInvariants() con las hijas primero, sus cotas y sus checks en orden`, () => {
    const { files } = plan(name);
    const product = fileOf(files, 'internal/domain/product.go');
    const guard = product.slice(product.indexOf('func (p *Product) EnsureInvariants() error {'));
    const at = (text) => {
      const index = guard.indexOf(text);
      assert.ok(index >= 0, `falta ${text}`);
      return index;
    };
    // D23: hijas, derivados, cotas, checks.
    const order = [
      at('if err := child.EnsureInvariants(); err != nil {'),
      at('if _, fits := p.computePrintTotal(); !fits {'),
      at('if !productSkuPattern.MatchString(p.sku) {'),
      at('*p.stockCount > 1000'),
      at('// check 0:'),
      at('// check 3:'),
      at('// check 6:')
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(guard, /return Errorf\(ErrDiscountExceedsPrice, "Product: discount ≤ listPrice\."\)/);
    assert.match(guard, /return Errorf\(ErrInvariantViolated, "Product: publishedAt es obligatorio cuando status es active\."\)/);
    // D19: un operando ausente cumple la comparación (la rota exige los dos presentes).
    assert.match(guard, /if p\.discount != nil && p\.listPrice != nil && \(\*p\.discount\)\.Cmp\(\*p\.listPrice\) > 0 \{/);
    // D20: el json solo cuenta como ausente si es nulo.
    assert.match(guard, /if p\.status == ProductStatusActive && p\.attributes == nil \{/);
    // D6: un texto vacío cuenta como ausente.
    assert.match(guard, /presentCount\(p\.ean != nil && \*p\.ean != "", p\.internalCode != nil && \*p\.internalCode != ""\) != 1/);
    // La longitud de un texto en puntos de código (D24).
    assert.match(guard, /utf8\.RuneCountInString\(\*p\.ean\) > 13/);
    // El derivado es un accesor que calcula, a la escala del campo, con HALF_UP; su TODO de prosa desaparece y Rehydrate
    // no lo asigna (el struct no tiene el miembro, el estado sí).
    assert.match(product, /func \(p \*Product\) PrintTotal\(\) \*wire\.Decimal \{\n\tvalue, _ := p\.computePrintTotal\(\)\n\treturn &value\n\}/);
    assert.match(product, /total = total\.Rescale\(2, wire\.RoundHalfUp\)\n\treturn total, !exceedsDecimal\(total, 2\)/);
    assert.match(product, /func \(p \*Product\) ImageCount\(\) \*int32 \{\n\tvalue := int32\(len\(p\.images\)\)\n\treturn &value\n\}/);
    assert.doesNotMatch(product, /printTotal: +state\.PrintTotal/);
    assert.match(product, /\tPrintTotal +\*wire\.Decimal\n/);
    assert.doesNotMatch(fileOf(files, 'internal/domain/product_behavior.go'), /printTotal es computed/);
    // La hija guarda su propio check.
    assert.match(fileOf(files, 'internal/domain/product_image.go'), /func \(p \*ProductImage\) EnsureInvariants\(\) error \{[\s\S]*if p\.position < 0 \{/);
    // Las ayudas, una sola vez en el paquete.
    const helpers = fileOf(files, 'internal/domain/invariants.go');
    assert.match(helpers, /func exceedsDecimal\(value wire\.Decimal, scale int32\) bool \{/);
    assert.match(helpers, /func presentCount\(present \.\.\.bool\) int \{/);
  });

  test(`${name}: el Save llama a la guarda antes de drenar los eventos y de abrir la transacción`, () => {
    const { files } = plan(name);
    const adapter = fileOf(files, `internal/infrastructure/${store}/product_repository.go`);
    const save = adapter.slice(adapter.indexOf('func (r *ProductRepository) Save('));
    const first = save.split('\n')[1].trim().startsWith('//') ? save.split('\n')[2].trim() : save.split('\n')[1].trim();
    assert.equal(first, 'if err := product.EnsureInvariants(); err != nil {');
    assert.ok(save.indexOf('EnsureInvariants()') < save.indexOf('PullEvents()'));
  });

  test(`${name}: el 422 tiene su centinela con el code del catálogo, y el handler las MISMAS notas que keel-spring`, () => {
    const { files } = plan(name);
    assert.match(fileOf(files, 'internal/domain/errors.go'), /^var ErrInvariantViolated = &Error\{kind: \w+, code: "INVARIANT_VIOLATED", status: 422\}$/m);
    const { layers } = load(name);
    // Los generadores parten las notas en renglones de comentario: se comparan con el texto unido.
    const prose = (source) => source.replace(/\n\s*(\/\/|\*)\s+/g, ' ');
    const handler = prose(fileOf(files, 'update_product_command_handler.go'));
    const spring = prose(fileOf(plan(name, planSpring).files, '/UpdateProductCommandHandler.java'));
    for (const note of [invariantsHandlerNote(layers, 'Product'), computedHandlerNote(layers.domain, 'Product')]) {
      assert.ok(spring.includes(note), `keel-spring no lleva la nota: ${note.slice(0, 60)}…`);
      assert.ok(handler.includes(note), `falta la nota: ${note.slice(0, 60)}…`);
    }
  });

  test(`${name}: cada mensaje de la guarda es el neutral, el mismo que lanza keel-spring`, () => {
    const { files } = plan(name);
    const product = fileOf(files, 'internal/domain/product.go');
    const spring = fileOf(plan(name, planSpring).files, '/Product.java');
    const { layers } = load(name);
    const messages = [
      ...resolvedChecks(layers, 'Product').map((check) => invariantMessage('Product', { kind: 'check', check })),
      invariantMessage('Product', { kind: 'bound', field: 'stockCount' }),
      invariantMessage('Product', { kind: 'computed', field: 'printTotal' })
    ];
    for (const message of messages) {
      assert.ok(product.includes(goString(message)), `falta: ${message}`);
      assert.ok(spring.includes(JSON.stringify(message)), `keel-spring no lanza: ${message}`);
    }
  });

  test(`${name}: cada sabotaje de la guarda se aplica a lo emitido`, () => {
    const { files } = plan(name);
    const branch = name.endsWith('-mongo') ? 'document' : 'relational';
    for (const [id, specs] of Object.entries(INVARIANT_SABOTAGE_SPECS)) {
      const { files: where, from, to } = specs[branch];
      const hits = files.filter((file) => where.test(file.path) && typeof file.content === 'string').filter((file) => {
        const changed = typeof from === 'string' ? file.content.replaceAll(from, to) : file.content.replace(from, to);
        return changed !== file.content;
      });
      assert.ok(hits.length > 0, `${id} no cambia nada de lo emitido`);
    }
  });
}

test('sin checks, cotas ni derivados no se emite la guarda ni su centinela', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'job-dispatch'));
  for (const entity of Object.values(layers.domain.entities)) {
    for (const field of Object.values(entity.fields ?? {})) delete field.constraints;
  }
  for (const type of Object.values(layers.domain.types ?? {})) delete type.constraints;
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.doesNotMatch(fileOf(files, 'internal/domain/errors.go'), /ErrInvariantViolated/);
  assert.ok(!files.some((file) => file.path === 'internal/domain/invariants.go'));
  // El código, no los agentes: el agente de código nombra la guarda en todo proyecto.
  assert.ok(!files.some((file) => !file.path.endsWith('.md') && typeof file.content === 'string' && file.content.includes('EnsureInvariants()')));
});

test('un diseño que sustituye INVARIANT_VIOLATED con su propio error devuelve el suyo', () => {
  const { manifest, layers } = load('catalog-invariants');
  layers['use-cases'].operations.updateProduct.errors.push({ code: 'PRODUCT_INVARIANT_BROKEN', when: 'El producto quedaría incoherente.', http: 422 });
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  assert.equal(FRAMEWORK_ERRORS.invariantViolated.family.test('PRODUCT_INVARIANT_BROKEN'), true);
  assert.match(fileOf(files, 'internal/domain/product.go'), /return Errorf\(ErrProductInvariantBroken, "Product: publishedAt es obligatorio/);
});
