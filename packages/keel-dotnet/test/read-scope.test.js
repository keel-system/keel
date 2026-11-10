// La LECTURA ACOTADA (DSL 2.27) en keel-dotnet: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/read-scope-designs.js y la paridad con keel-spring y keel-nest. RS-1 a RS-8 los miden db-check y
// doc-check contra el motor real (scripts/lib/read-scope-probes.js); RS-9 a RS-11, la prueba emitida ReadScopeTests, que
// ejecuta cs-check (`--fixtures --only=vault-scoped,shop-scoped`, falsada con rs-cache-key y rs-empty-is-all).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { READ_SCOPE_KEY_CASES, scopedReadsOf } from '@keel-system/keel-core/gen/read-scope';
import { READ_SCOPE_DESIGNS } from '../../keel-core/test/helpers/read-scope-designs.js';
import { FIXTURES_DIR, planFixture } from './helpers/workspace.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { planService } from '../src/scaffold/index.js';
import { scopedLoadsOf as dotnetLoads, readScopesMethod } from '../src/scaffold/read-scope.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { scopedLoadsOf as springLoads } from '../../keel-spring/src/scaffold/read-scope.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { scopedLoadsOf as nestLoads, readScopesMethod as nestMethod } from '../../keel-nest/src/scaffold/read-scope.js';

const design = (name) => READ_SCOPE_DESIGNS.find((entry) => entry.name === name);
const plan = (name) => planFixture(design(name).from, { mutate: (manifest, layers) => design(name).mutate(layers) });
const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

test('los sujetos pasan la frontera de keel-dotnet, conduit-optional incluido', () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
  }
});

test('conduit-optional: PermitAll, el lector estampa ResolveOptional() y la prueba emitida OptionalAuthTests', async () => {
  const { files } = await plan('conduit-optional');
  const content = (suffix) => files.find((file) => file.path.endsWith(suffix)).content;
  assert.match(content('Security/AccessRules.cs'), /"\/api\/v1\/articles\/\{slug\}", Requirement\.PermitAll/);
  assert.match(content('Security/CallerIdentity.cs'), /public static string\? ResolveOptional\(\) =>/);
  assert.match(content('Endpoints/ArticleV1Endpoints.cs'), /CallerSubject = CallerIdentity\.ResolveOptional\(\),/);
  assert.match(content('UseCases/GetArticleQueryHandler.cs'), /Identidad opcional \(level: optional, DSL 2\.27\): sin token, query\.CallerSubject llega null/);
  const tests = content('OptionalAuthTests.cs');
  for (const id of ['OA1', 'OA2', 'OA3']) assert.match(tests, new RegExp(`public async Task ${id}_GetArticle_`));
  // Sin ninguna operación optional, ni ResolveOptional ni la prueba.
  const conduit = (await planFixture('conduit')).files;
  assert.doesNotMatch(conduit.find((file) => file.path.endsWith('Security/CallerIdentity.cs')).content, /ResolveOptional/);
  assert.ok(!conduit.some((file) => file.path.endsWith('OptionalAuthTests.cs')));
});

test('vault-scoped: el finder pide el scope, el predicado se SUMA tras los criterios y el salto es una subconsulta', async () => {
  const { files } = await plan('vault-scoped');
  const port = fileOf(files, 'Domain/Repository/IAssetRepository.cs');
  assert.match(port, /Task<Asset\?> LoadScoped\(Guid id, ReadScope scope, CancellationToken cancellationToken = default\);/);
  assert.match(port, /Task<Page<Asset>> ListAssets\(ListAssetsFilter filter, Pageable pageable, ReadScope scope, CancellationToken cancellationToken = default\);/);
  assert.doesNotMatch(port, /Task<Page<Asset>> List\(Pageable/, 'una raíz con sus listados acotados no tiene List(pageable) sin scope');
  const adapter = fileOf(files, 'Repositories/AssetRepository.cs');
  assert.match(adapter, / {12}query = query\.Where\(r => r\.Status == status\);\n {8}\}\n {8}query = Scoped\(query, scope\);\n {8}var total = await query\.LongCountAsync\(cancellationToken\);/);
  assert.match(adapter, /var ids1 = db\.Set<OwnerRow>\(\)\.AsNoTracking\(\)\.Where\(hop1 => allowed\.Contains\(hop1\.Code\)\)\.Select\(hop1 => hop1\.Id\);\n {8}return query\.Where\(r => ids1\.Contains\(r\.OwnerId\)\);/);
  assert.match(adapter, /var allowed = scope\.Values\.ToList\(\);/);
  assert.match(adapter, /throw new AssetOutOfScopeError\("El archivo pertenece a un propietario que no está en el alcance del solicitante\."\);/);
  const endpoints = fileOf(files, 'Endpoints/AssetV1Endpoints.cs');
  assert.equal((endpoints.match(/ReadScope = ReadScopes\.Scoping\(\),/g) ?? []).length, 2);
  assert.match(fileOf(files, 'Queries/GetAssetQuery.cs'), /public required ReadScope ReadScope \{ get; init; \}/);
  assert.match(fileOf(files, 'Support/CachedOperations.cs'), /message => CacheKey\.Of\(message\.Id, message\.ReadScope\.CacheKey\(\)\)/);
  const handler = fileOf(files, 'UseCases/GetAssetQueryHandler.cs').replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(handler, /Lectura acotada \(security\.authentication\.scoping\.reads\)/);
  assert.match(handler, /await assetRepository\.LoadScoped\(query\.Id, query\.ReadScope, cancellationToken\)/);
  // La nota vieja del alcance (comprobar a mano con callerScope) ya no: lo aplica el adaptador.
  assert.doesNotMatch(handler, /callerScope\.Covers/);
  const scopes = fileOf(files, 'Security/ReadScopes.cs');
  assert.match(scopes, /return scope\.IsExempt\(\) \? ReadScope\.Unrestricted\(\) : ReadScope\.Within\(scope\.ScopedValues\(\)\);/);
});

test('vault-scoped-mongo y conduit-scoped: el salto resuelve los ids de la otra colección; not-found devuelve null', async () => {
  const mongo = fileOf((await plan('vault-scoped-mongo')).files, 'Repositories/AssetRepository.cs');
  assert.match(mongo, /var ids1 = new BsonArray\(await IdsIn\("owners", new BsonDocument\("code", new BsonDocument\("\$in", allowed\)\), cancellationToken\)\);/);
  assert.match(mongo, /return new BsonDocument\("owner_id", new BsonDocument\("\$in", ids1\)\);/);
  assert.match(mongo, / {8}var query = conditions\.Count == 0 \? FilterDefinition<BsonDocument>\.Empty : Builders<BsonDocument>\.Filter\.And\(conditions\);\n {8}query = await Scoped\(query, scope, cancellationToken\);/);
  const conduit = fileOf((await plan('conduit-scoped')).files, 'Repositories/ArticleRepository.cs');
  assert.match(conduit, /public async Task<Article\?> LoadScopedBySlug\(string slug, ReadScope scope, CancellationToken cancellationToken = default\) =>\n {8}await AdmittedOrMiss\(await FindBySlug\(slug, cancellationToken\), scope, cancellationToken\);/);
  assert.match(conduit, /readMiss: not-found[\s\S]*?return null;/);
});

test('shop-scoped: la propiedad sobre la propia fila, con los roles exentos y la identidad del llamante', async () => {
  const { files } = await plan('shop-scoped');
  const scopes = fileOf(files, 'Security/ReadScopes.cs');
  assert.match(scopes, /principal\.Authorities\.Contains\("ROLE_employee"\) \|\| principal\.Authorities\.Contains\("ROLE_manager"\)/);
  assert.match(scopes, /public static ReadScope OwnerOfOrderMain\(\) => OwnerOfOrderMain\(CallerIdentity\.Resolve\(\)\);/);
  const adapter = fileOf(files, 'Repositories/OrderMainRepository.cs');
  assert.match(adapter, /return query\.Where\(r => allowed\.Contains\(r\.BuyerEmail\)\);/);
  assert.match(fileOf(files, 'Repositories/UserRepository.cs'), /LoadScopedByEmail\(string email, ReadScope scope/);
  // La prueba emitida del borde: los casos de la clave de keel-core, los dos constructores y el 403 de cada error.
  const tests = fileOf(files, 'ReadScopeTests.cs');
  for (const entry of READ_SCOPE_KEY_CASES) assert.ok(tests.includes(`Assert.Equal("${entry.key.replaceAll('\\', '\\\\')}", `), entry.id);
  assert.match(tests, /RS10_OwnerOfOrderMain_/);
  assert.match(tests, /RS11_GetOrder_LaFilaAjenaEs403ConSuCodeYSuTexto/);
  assert.match(tests, /RS11_GetProfile_LaFilaAjenaEs403ConSuCodeYSuTexto/);
});

test('la frontera neutral: un listado acotado sin finder (T8) no se genera', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  Object.assign(layers.security.ownership.Article, { reads: ['listArticles'], readMiss: 'not-found' });
  layers.security.access.rules.listArticles = { level: 'required' };
  assert.throws(() => planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb' } }), /use-cases\.listArticles .*el listado no tiene finder de build/);
});

test('paridad con keel-spring y keel-nest: las mismas cargas por raíz, los mismos constructores del borde y las mismas lecturas', async () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS.filter((entry) => entry.name !== 'conduit-optional')) {
    const dotnet = await plan(name);
    const fresh = () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
      mutate(layers);
      return { manifest, layers, workspace: FIXTURES_DIR, stack: { database: layers.persistence?.default?.model === 'document' ? 'mongodb' : 'postgresql' } };
    };
    const spring = planSpring(fresh());
    const nest = planNest(fresh());
    const loads = (model, of) =>
      model.entities.filter((entity) => entity.isAggregateRoot).flatMap((entity) => of(model, entity).map((load) => `${entity.name}.${decap(load.method)}(${decap(String(load.param.name).replace(/^@/, ''))})`));
    assert.deepEqual(loads(dotnet.model, dotnetLoads), loads(spring.model, springLoads), `${name}: keel-spring`);
    assert.deepEqual(loads(dotnet.model, dotnetLoads), loads(nest.model, nestLoads), `${name}: keel-nest`);
    const methods = (model, of) => [...new Set(scopedReadsOf(model).map((operation) => decap(of(operation.readScope))))];
    assert.deepEqual(methods(dotnet.model, readScopesMethod), methods(nest.model, nestMethod), name);
    assert.deepEqual(scopedReadsOf(dotnet.model).map((operation) => operation.name), scopedReadsOf(spring.model).map((operation) => operation.name), name);
  }
});

test('sin reads con lecturas no se emite nada de la lectura acotada', async () => {
  // conduit declara reads: [] (ninguna lectura se acota por construcción): es una decisión, no una petición.
  const { files } = await planFixture('conduit');
  assert.ok(!files.filter((file) => !file.path.endsWith('.md')).some((file) => /ReadScope|LoadScoped/.test(file.content ?? '')));
});
