// La lectura acotada (DSL 2.27, src/lib/gen/read-scope.js): qué lecturas se acotan, por qué camino y con qué predicado,
// qué preguntas abre un diseño que no lo dice, y la referencia ejecutable del ReadScope (D1, D3, D5). Y `level:
// optional` (R3c). Los sujetos son los de test/helpers/read-scope-designs.js, los mismos que medirán los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { accessRequirement } from '../src/lib/gen/access-plan.js';
import {
  OPTIONAL_AUTH_CASES,
  OPTIONAL_AUTH_SABOTAGES,
  READ_SCOPE_CASES,
  READ_SCOPE_SABOTAGES,
  UNRESTRICTED,
  claimValues,
  optionalAuthPendingErrors,
  optionalAuthRules,
  ownedBy,
  readScopeFor,
  readScopeNote,
  readScopePendingErrors,
  readScopesOfLayers,
  scopeAdmits,
  scopedLoadOutcome,
  toOnePaths,
  within
} from '../src/lib/gen/read-scope.js';
import { READ_SCOPE_DESIGNS } from './helpers/read-scope-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function designOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return { manifest, layers, model: buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }) };
}
const derived = (name) => {
  const design = READ_SCOPE_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, design.mutate);
};
const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);
const summary = (read) => ({ operation: read.operation, root: read.root, shape: read.shape, relations: read.relations, field: read.field });

test('los sujetos validan sin errores y su plan no tiene problemas ni preguntas abiertas', () => {
  for (const design of READ_SCOPE_DESIGNS) {
    const { layers } = derived(design.name);
    assert.deepEqual(checkCrossRefs({ layers }).errors, [], design.name);
    const plan = readScopesOfLayers(layers);
    assert.deepEqual(plan.problems, [], design.name);
    assert.deepEqual(plan.undecided, [], design.name);
  }
});

test('vault-scoped: el alcance por claim llega a Owner.code por la relación owner, con sus exentos', () => {
  const { layers, model } = derived('vault-scoped');
  const { reads } = readScopesOfLayers(layers);
  assert.deepEqual(reads.map(summary), [
    { operation: 'getAsset', root: 'Asset', shape: 'single', relations: ['owner'], field: 'code' },
    { operation: 'listAssets', root: 'Asset', shape: 'page', relations: ['owner'], field: 'code' }
  ]);
  const [getAsset] = reads;
  assert.equal(getAsset.kind, 'scoping');
  assert.equal(getAsset.claim, 'vaults');
  assert.equal(getAsset.readMiss, 'forbidden');
  assert.deepEqual(getAsset.exemptRoles, ['vault-admin']);
  assert.deepEqual(getAsset.exemptClients, ['rendering-service']);
  // El modelo lleva lo mismo: en la operación y en la seguridad.
  assert.deepEqual(operationOf(model, 'getAsset').readScope, getAsset);
  assert.deepEqual(model.security.readScopes, reads);
  assert.equal(operationOf(model, 'uploadAsset').readScope, null);
  // El listado acotado tiene finder aunque no filtre nada más: el predicado es su criterio (D4).
  const finder = operationOf(model, 'listAssets').finder;
  assert.equal(finder?.result, 'page');
  assert.deepEqual(finder.criteria, []);
  assert.deepEqual(finder.scope, reads[1]);
});

test('shop-scoped: la propiedad con roles exentos y forbidden; las escrituras siguen en operations', () => {
  const { layers } = derived('shop-scoped');
  const { reads } = readScopesOfLayers(layers);
  assert.deepEqual(reads.map(summary), [
    { operation: 'getOrder', root: 'OrderMain', shape: 'single', relations: [], field: 'buyerEmail' },
    { operation: 'listOrders', root: 'OrderMain', shape: 'page', relations: [], field: 'buyerEmail' },
    { operation: 'getProfile', root: 'User', shape: 'single', relations: [], field: 'email' }
  ]);
  assert.deepEqual(reads[0].exemptRoles, ['employee', 'manager']);
  assert.equal(reads[0].error, 'ORDER_NOT_OWNED');
  // El 403 de readMiss: forbidden lo produce la regla: no abre OBL-RESOURCE-SCOPE.
  assert.ok(!checkCrossRefs({ layers }).obligations.some((o) => o.id === 'OBL-RESOURCE-SCOPE'));
});

test('conduit-scoped: el dueño a través de una relación, con el 404 del diseño', () => {
  const { layers } = derived('conduit-scoped');
  const { reads } = readScopesOfLayers(layers);
  assert.deepEqual(reads.map(summary), [
    { operation: 'getArticle', root: 'Article', shape: 'single', relations: ['author'], field: 'subject' },
    { operation: 'listArticles', root: 'Article', shape: 'page', relations: ['author'], field: 'subject' }
  ]);
  assert.equal(reads[0].readMiss, 'not-found');
  assert.equal(reads[0].notFound, 'ARTICLE_NOT_FOUND');
});

test('conduit-optional: las cuatro reglas optional, como un requisito propio del plan de acceso', () => {
  const { layers } = derived('conduit-optional');
  assert.deepEqual(
    optionalAuthRules(layers).map((rule) => rule.operation),
    ['getProfile', 'listArticles', 'getArticle', 'listComments']
  );
  assert.deepEqual(accessRequirement({ level: 'optional' }), { kind: 'optional', authorities: [] });
});

test('las fixtures: las preguntas abiertas son exactamente las aceptadas en su decisions.yaml', () => {
  const undecided = (fixture) => readScopesOfLayers(designOf(fixture).layers).undecided.map((u) => u.scope);
  assert.deepEqual(undecided('asset-vault'), [
    'security.authentication.scoping.reads.getAsset',
    'security.authentication.scoping.reads.listAssets'
  ]);
  // getOrder está en ownership.operations (la nota de la 2.23): no es una pregunta abierta.
  assert.deepEqual(undecided('shop-api'), ['security.ownership.OrderMain.reads.listOrders']);
  // reads: [] cierra el bloque entero: listFeed devuelve artículos y no se acota por su autor.
  assert.deepEqual(undecided('conduit'), []);
});

test('toOnePaths: el vacío desde la propia entidad, ninguno, y varios cuando hay dos caminos', () => {
  const domain = {
    entities: {
      A: { relations: { b: { entity: 'B', cardinality: 'many-to-one' }, c: { entity: 'C', cardinality: 'many-to-one' } } },
      B: { relations: { d: { entity: 'D', cardinality: 'many-to-one' }, items: { entity: 'C', cardinality: 'one-to-many' } } },
      C: { relations: { d: { entity: 'D', cardinality: 'one-to-one' } } },
      D: {}
    }
  };
  assert.deepEqual(toOnePaths(domain, 'D', 'D'), [[]]);
  assert.deepEqual(toOnePaths(domain, 'D', 'A'), []);
  assert.deepEqual(toOnePaths(domain, 'B', 'D'), [['d']]);
  assert.deepEqual(toOnePaths(domain, 'A', 'D'), [['b', 'd'], ['c', 'd']]);
});

test('readScopeFor (D1, D3): solo una exención da unrestricted; un claim ausente es el conjunto vacío', () => {
  const scoping = { kind: 'scoping', claim: 'vaults', exemptRoles: ['vault-admin'], exemptClients: ['rendering-service'] };
  assert.deepEqual(readScopeFor(scoping, { roles: ['vault-admin'] }), UNRESTRICTED);
  assert.deepEqual(readScopeFor(scoping, { client: 'rendering-service' }), UNRESTRICTED);
  assert.deepEqual(readScopeFor(scoping, { claims: { vaults: ['ACME', 'Beta', 'ACME'] } }), within(['ACME', 'Beta']));
  assert.deepEqual(readScopeFor(scoping, { claims: { vaults: 'ACME Beta' } }), within(['ACME', 'Beta']));
  assert.deepEqual(readScopeFor(scoping, { claims: {} }), within([]));
  assert.deepEqual(readScopeFor(scoping, { client: 'other' }), within([]));
  const ownership = { kind: 'ownership', exemptRoles: ['employee'], exemptClients: [] };
  assert.deepEqual(readScopeFor(ownership, { caller: 'ana@x' }), ownedBy('ana@x'));
  assert.deepEqual(readScopeFor(ownership, { roles: ['employee'], caller: 'ana@x' }), UNRESTRICTED);
  assert.deepEqual(claimValues(null), []);
  assert.deepEqual(claimValues('a, b'), ['a', 'b']);
});

test('scopeAdmits y scopedLoadOutcome: el predicado y la lectura por id (D3, D5)', () => {
  assert.ok(scopeAdmits(UNRESTRICTED, 'x'));
  assert.ok(scopeAdmits(within(['ACME']), 'ACME'));
  // Distingue mayúsculas: el IN respeta la colación de la unicidad (T3).
  assert.ok(!scopeAdmits(within(['ACME']), 'acme'));
  assert.ok(!scopeAdmits(within([]), 'ACME'));
  assert.ok(scopeAdmits(ownedBy('ana'), 'ana'));
  assert.ok(!scopeAdmits(ownedBy('ana'), 'luis'));
  assert.ok(!scopeAdmits(ownedBy(null), null));
  assert.equal(scopedLoadOutcome({ exists: false, admitted: false, readMiss: 'forbidden' }), 'not-found');
  assert.equal(scopedLoadOutcome({ exists: true, admitted: true, readMiss: 'forbidden' }), 'found');
  assert.equal(scopedLoadOutcome({ exists: true, admitted: false, readMiss: 'forbidden' }), 'forbidden');
  assert.equal(scopedLoadOutcome({ exists: true, admitted: false, readMiss: 'not-found' }), 'not-found');
});

test('la nota del handler dice el predicado, los exentos y el desenlace de una fila ajena', () => {
  const { layers } = derived('vault-scoped');
  const [getAsset, listAssets] = readScopesOfLayers(layers).reads;
  const single = readScopeNote(getAsset, { scope: 'query.readScope()', call: 'assets.loadScoped(id, scope)' });
  assert.match(single, /Asset\.owner\.code ∈ claim vaults/);
  assert.match(single, /el rol vault-admin, el cliente rendering-service/);
  assert.match(single, /loadScoped: una fila ajena da ASSET_OUT_OF_SCOPE \(403\)/);
  const list = readScopeNote(listAssets, { scope: 'query.readScope()', call: 'assets.listAssets(…, scope)' });
  assert.doesNotMatch(list, /loadScoped/);
  assert.equal(readScopeNote(null, { scope: 's', call: 'c' }), null);
});

test('la frontera: reads con lecturas y optional se rechazan hasta el incremento; reads: [] no pide nada', () => {
  const vault = derived('vault-scoped').layers;
  const [message] = readScopePendingErrors(vault, 'keel-go', 4);
  assert.match(message, /^security\.authentication\.scoping\.reads \(lectura acotada, DSL 2\.27\): keel-go todavía no la genera — llega en el incremento 4/);
  assert.deepEqual(readScopePendingErrors(designOf('conduit').layers, 'keel-go', 4), [], 'reads: [] no se rechaza');
  assert.equal(optionalAuthPendingErrors(derived('conduit-optional').layers, 'keel-nest', 5).length, 4);
  assert.deepEqual(optionalAuthPendingErrors(designOf('conduit').layers, 'keel-nest', 5), []);
});

test('los casos y los sabotajes: ids únicos, y cada sabotaje cae en casos que existen', () => {
  for (const [cases, sabotages] of [
    [READ_SCOPE_CASES, READ_SCOPE_SABOTAGES],
    [OPTIONAL_AUTH_CASES, OPTIONAL_AUTH_SABOTAGES]
  ]) {
    const ids = cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const sabotage of sabotages) for (const id of sabotage.falls) assert.ok(ids.includes(id), `${sabotage.id} → ${id}`);
  }
});
