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
