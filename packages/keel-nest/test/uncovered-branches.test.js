// Las ramas del DSL que ninguna fixture declara y keel-nest genera: las tres que `capability-coverage.test.js`
// anota como `soloCadenas`. Sin fixture, ts-syntax y ts-check no las recorren nunca, así que aquí se derivan de
// catalog-extended parcheando el diseño en memoria —como hace keel-spring en dependencies.test.js— y se exige lo
// mismo que a una fixture: que el TypeScript parsee y sus imports lleven a lo que exportan, más la rama en sí.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/emitted.js';
import { checkTree } from './helpers/ts-tree.js';
import { declaredAuthorship } from './helpers/workspace.js';

const SUBJECT = 'catalog-extended';
const PRICING = (layers) => layers.dependencies.dependencies.pricing.needs;

function emitted(mutate) {
  const { files } = planFixture(SUBJECT, { mutate });
  assert.deepEqual(checkTree(files), []);
  return files;
}

const replicaNeed = (layers) => Object.values(PRICING(layers)).find((need) => need.replica);

test(`${SUBJECT}: réplica con onMiss fail — el lector lanza el error declarado (replica.onMiss.error)`, () => {
  const files = emitted((layers) => {
    replicaNeed(layers).replica.onMiss = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
  });
  const reader = files.find((file) => /PRICE_UNAVAILABLE|PriceUnavailable/.test(file.content) && /replica|copia local/i.test(file.content));
  assert.ok(reader, 'ningún archivo emitido lee la réplica con el error declarado');
});

test(`${SUBJECT}: réplica con onMiss degrade — el resultado degradado lleva la prosa del diseño (replica.onMiss.degradedTo)`, () => {
  const prose = 'Se cotiza sin precio del proveedor y la ficha lo dice.';
  const files = emitted((layers) => {
    replicaNeed(layers).replica.onMiss = { action: 'degrade', degradedTo: prose };
  });
  assert.ok(files.some((file) => file.content.includes(prose)), 'la prosa de degradedTo no llega a lo emitido');
});

test(`${SUBJECT}: activación con onFailure degrade — el fallback deja el TODO con la prosa (activations.onFailure.degradedTo)`, () => {
  const prose = 'El producto queda sin reindexar hasta el próximo cambio; la búsqueda lo encuentra con sus datos viejos.';
  const files = emitted((layers) => {
    layers.dependencies.dependencies['search-index'].activations.indexProduct.onFailure = { action: 'degrade', degradedTo: prose };
  });
  assert.ok(files.some((file) => file.content.includes(prose)), 'la prosa de degradedTo no llega a lo emitido');
});

// La autoría declarada: vacía es AUSENTE. El alta la deja en '' (domain-modeling.md), y con `??=` el adaptador guardaba
// ese '' en lugar del actor (corrida catalog-dotnet del registry, la misma forma en keel-nest).
for (const fixture of ['notification-mailer', 'notification-mailer-mongo']) {
  test(`${fixture}: la autoría declarada vacía se estampa con el actor, en la raíz y en la hija (audit.authorship: declared)`, () => {
    const { files } = planFixture(fixture, { mutate: declaredAuthorship });
    assert.deepEqual(checkTree(files), []);
    const adapter = files.find((file) => file.path.endsWith('template-repository-impl.ts'));
    assert.ok(adapter, 'no se emitió el adaptador de Template');
    if (fixture === 'notification-mailer') {
      assert.match(adapter.content, /orm\.createdBy \|\|= actor;/);
      assert.match(adapter.content, /child\.createdBy \|\|= actor;/);
    } else {
      assert.match(adapter.content, /node\.created_by \|\|= actor;/);
    }
    for (const file of files) assert.doesNotMatch(file.content, /created_?[bB]y \?\?= actor/, file.path);
  });
}

test('la escritura condicional entera, en las dos ramas (api.concurrency, concurrency.operations)', async () => {
  const { CONDITIONAL_WRITE_DESIGNS } = await import('../../keel-core/test/helpers/conditional-write-designs.js');
  const { checkSupportedFeatures } = await import('../src/lib/supported-features.js');
  const { loadService } = await import('@keel-system/keel-core');
  const { FIXTURES_DIR } = await import('./helpers/workspace.js');
  const path = await import('node:path');
  for (const name of ['catalog-conditional', 'catalog-conditional-mongo']) {
    const design = CONDITIONAL_WRITE_DESIGNS.find((entry) => entry.name === name);
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
    design.mutate(layers);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], `${name}: la frontera todavía lo rechaza`);
    const { files } = planFixture(design.from, { mutate: design.mutate });
    const find = (suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';
    assert.match(find('update-product-command.ts'), /readonly expectedVersions: readonly number\[\] \| null;/);
    const controller = files.find((file) => /controllers\/.*product.*controller\.ts$/.test(file.path))?.content ?? '';
    assert.match(controller, /@Headers\('if-match'\) ifMatch: string \| undefined/);
    assert.match(controller, /const expectedVersions = readExpectedVersions\(ifMatch, true\);/);
    assert.equal((controller.match(/void reply\.header\('ETag', etagOf\(versioned\.version\)\);/g) ?? []).length, 3);
    assert.match(find('get-product-by-slug-query-handler.ts'), /QueryHandler<GetProductBySlugQuery, Versioned<GetProductBySlugResponseDto>>/);
    assert.match(find('product-repository.ts'), /abstract loadExpecting\(id: string, expectedVersions: readonly number\[\] \| null\)/);
    assert.ok(files.some((file) => /product-repository-impl\.ts$/.test(file.path) && file.content.includes('throw new PreconditionFailedException();')), name);
    assert.match(find('infra/check-conditional-writes.sh'), /check 'updateProduct' 'Product'/);
    checkTree(files);
  }
});

// El ciclo de vida del dato (DSL 2.28): *.deletion, *.restorableFor, *.retention y *.restores, que ninguna fixture declara
// hasta el incremento 6 de PLAN-DSL-228-CICLO-DE-VIDA.md. Los sujetos son los de keel-core (los mismos que mide keel-spring).
test('el ciclo de vida del dato entero (persistence *.deletion, *.restorableFor, *.retention y use-cases *.restores)', async () => {
  const { DATA_LIFECYCLE_DESIGNS } = await import('../../keel-core/test/helpers/data-lifecycle-designs.js');
  for (const design of DATA_LIFECYCLE_DESIGNS) {
    const { files } = planFixture(design.from, { mutate: design.mutate });
    assert.deepEqual(checkTree(files), [], design.name);
    const find = (pattern) => files.find((file) => pattern.test(file.path))?.content ?? '';
    if (/^cards/.test(design.name)) {
      assert.match(find(/contact-card-repository\.ts$/), /abstract restore\(id: string\)/, design.name);
      assert.match(find(/restore-my-card-command-handler\.ts$/), /Restauración \(restores: ContactCard/, design.name);
    }
    assert.ok(files.some((file) => /-retention-timer\.ts$/.test(file.path)), `${design.name}: sin el recurrente de la retención`);
  }
});
