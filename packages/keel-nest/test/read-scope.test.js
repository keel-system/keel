// La LECTURA ACOTADA (DSL 2.27) en keel-nest: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/read-scope-designs.js, la paridad con keel-spring, y RS-9 a RS-11 EJECUTANDO lo emitido: la clave
// de caché por scope, ReadScopes desde un principal y el 403 del cable. RS-1 a RS-8 los mide db-check y doc-check contra
// el motor real (scripts/lib/read-scope-probes.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { READ_SCOPE_KEY_CASES, readMissMessage, scopedReadsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { DOMAIN_ERROR_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { READ_SCOPE_DESIGNS } from '../../keel-core/test/helpers/read-scope-designs.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { planService } from '../src/scaffold/index.js';
import { READ_SCOPE_TS, READ_SCOPES_TS, scopedLoadsOf as nestLoads, readScopesMethod } from '../src/scaffold/read-scope.js';
import { EXCEPTION_FILTER_TS } from '../src/scaffold/rest-support.js';
import { SECURITY_CONTEXT_TS } from '../src/scaffold/security.js';
import { classPath, DIRS } from '../src/scaffold/render.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { scopedLoadsOf as springLoads } from '../../keel-spring/src/scaffold/read-scope.js';

const design = (name) => READ_SCOPE_DESIGNS.find((entry) => entry.name === name);
const plan = (name, stack = null) => planFixture(design(name).from, { mutate: design(name).mutate, stack });
const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Optional = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export const Catch = () => () => {};
export class Logger { log() {} warn() {} error() {} debug() {} }
export class HttpException extends Error { getStatus() { return 500; } getResponse() { return {}; } }
export class NotFoundException extends HttpException {}
`;
const TYPEORM_STUB = `
export class QueryFailedError extends Error {}
export class EntityNotFoundError extends Error {}
export class OptimisticLockVersionMismatchError extends Error {}
export class TypeORMError extends Error {}
`;
const stubs = { '@nestjs/common': NEST_STUB, typeorm: TYPEORM_STUB };

test('los sujetos pasan la frontera de keel-nest, conduit-optional incluido', () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
  }
});

test('vault-scoped: el finder pide el scope, el predicado se SUMA en el where y el salto es una subconsulta', () => {
  const { files } = plan('vault-scoped');
  const port = fileOf(files, 'domain/repository/asset-repository.ts');
  assert.match(port, /abstract loadScoped\(id: string, scope: ReadScope\): Promise<Asset \| null>;/);
  assert.match(port, /abstract listAssets\(filter: ListAssetsFilter, pageable: Pageable, scope: ReadScope\): Promise<Page<Asset>>;/);
  assert.doesNotMatch(port, /abstract list\(pageable/, 'una raíz con sus listados acotados no tiene list(pageable) sin scope');
  const adapter = fileOf(files, 'repositories/asset-repository-impl.ts');
  assert.match(adapter, /if \(filter\.status != null\) and\('status', Equal\(filter\.status\)\);\n {4}for \(const \[property, condition\] of Object\.entries\(this\.readScopeWhere\(scope\)\)\) and\(property, condition\);/);
  assert.match(adapter, /const hop1 = this\.manager\.createQueryBuilder\(OwnerOrm, 'hop1'\)\.select\('hop1\.id'\);/);
  assert.match(adapter, /return \{ ownerId: Raw\(\(alias\) => `\$\{alias\} IN \(\$\{hop1\.getQuery\(\)\}\)`, hop1\.getParameters\(\)\) \};/);
  assert.match(adapter, /return \{ sql: '1 = 0', parameters: \{\} \};/);
  assert.match(adapter, /throw new AssetOutOfScopeError\('El archivo pertenece a un propietario que no está en el alcance del solicitante\.'\);/);
  const controller = fileOf(files, 'asset-v1-controller.ts');
  assert.match(controller, /const readScope = ReadScopes\.scoping\(\);\n {4}return this\.mediator\.dispatch\(readGetAssetQuery\(params, query, body, readScope\)\);/);
  assert.match(fileOf(files, 'application/queries/get-asset-query.ts'), /readonly readScope: ReadScope;/);
  assert.match(fileOf(files, 'application/support/cached-operations.ts'), /keyOf: \(message\) => cacheKey\(message\.id, ReadScope\.cacheKey\(message\.readScope\)\)/);
  // La nota va partida en líneas de comentario: se lee como un solo texto.
  const handler = fileOf(files, 'usecases/get-asset-query-handler.ts').replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(handler, /Lectura acotada \(security\.authentication\.scoping\.reads\)/);
  assert.match(handler, /await this\.assetRepository\.loadScoped\(query\.id, query\.readScope\)/);
  assert.doesNotMatch(handler, /callerScope\.covers/, 'la nota vieja del alcance (filtra tú) no sale en una lectura acotada');
});

test('vault-scoped-mongo y conduit-scoped: el salto resuelve los ids de la otra colección; not-found devuelve null', () => {
  const mongo = fileOf(plan('vault-scoped-mongo').files, 'repositories/asset-repository-impl.ts');
  // Tipada: sin el parámetro, el filtro no casa con la colección y no compila (lo cazó doc-check).
  assert.match(mongo, /this\.transactions\.collection<StoredDocument>\('owners'\)\.find\(scopedFilter\('code', scope\)/);
  assert.match(mongo, /return \{ 'owner_id': \{ \$in: ids1 \} \};/);
  assert.match(mongo, /if \(scope\.kind !== 'unrestricted'\) conditions\.push\(await this\.readScopeFilter\(scope\)\);/);
  const conduit = fileOf(plan('conduit-scoped').files, 'repositories/article-repository-impl.ts');
  assert.match(conduit, /async loadScopedBySlug\(slug: string, scope: ReadScope\)/);
  assert.match(conduit, /readMiss: not-found[\s\S]*?return null;/);
});

test('la frontera neutral: un listado acotado sin finder (T8) no se genera', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  Object.assign(layers.security.ownership.Article, { reads: ['listArticles'], readMiss: 'not-found' });
  layers.security.access.rules.listArticles = { level: 'required' };
  assert.throws(() => planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb' } }), /use-cases\.listArticles .*el listado no tiene finder de build/);
});

test('paridad con keel-spring: las mismas cargas por raíz, los mismos constructores del borde y las mismas lecturas', () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS.filter((entry) => entry.name !== 'conduit-optional')) {
    const nest = plan(name);
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    const document = layers.persistence?.default?.model === 'document';
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
    const loads = (model, of) => model.entities.filter((entity) => entity.isAggregateRoot).flatMap((entity) => of(model, entity).map((load) => `${entity.name}.${load.method}(${load.param.name})`));
    assert.deepEqual(loads(nest.model, nestLoads), loads(spring.model, springLoads), name);
    const methods = (model) => [...new Set(scopedReadsOf(model).map((operation) => readScopesMethod(operation.readScope)))];
    assert.deepEqual(methods(nest.model), methods(spring.model), name);
    assert.deepEqual(scopedReadsOf(nest.model).map((operation) => operation.name), scopedReadsOf(spring.model).map((operation) => operation.name), name);
  }
});

// ─── RS-9 a RS-11, ejecutando lo emitido ──────────────────────────────────────────────────────────────────────

async function emitted(name, { sabotage = (file) => file.content, stack = null } = {}) {
  const { files, model } = plan(name, stack);
  const tree = transpileTree(files.map((file) => ({ ...file, content: typeof file.content === 'string' ? sabotage(file) : file.content })), { stubs });
  return { tree, model, files };
}

const principal = (roles, claims) => ({ kind: 'token', name: 'rs10', authorities: new Set(roles.map((role) => `ROLE_${role}`)), claims: { sub: 'rs10', ...claims } });

test('RS-9: la parte del scope en la clave es la de keel-core, y dos llamantes no comparten entrada', async () => {
  const { tree } = await emitted('vault-scoped', { stack: { cache: 'redis' } });
  const { ReadScope } = await tree.load(READ_SCOPE_TS);
  const toScope = (scope) => (scope.kind === 'unrestricted' ? ReadScope.unrestricted() : scope.kind === 'ownedBy' ? ReadScope.ownedBy(scope.value) : ReadScope.within(scope.values));
  for (const entry of READ_SCOPE_KEY_CASES) assert.equal(ReadScope.cacheKey(toScope(entry.scope)), entry.key, entry.id);
  const { GET_ASSET_CACHE } = await tree.load('src/application/support/cached-operations.ts');
  const key = (scope) => GET_ASSET_CACHE.keyOf({ id: 'a1', readScope: scope });
  assert.notEqual(key(ReadScope.within(['a'])), key(ReadScope.within(['b'])), 'RS-9: dos scopes distintos comparten entrada');
  assert.notEqual(key(ReadScope.within(['a'])), key(ReadScope.ownedBy('a')), 'RS-9: within(a) y ownedBy(a) comparten entrada');
  assert.equal(key(ReadScope.unrestricted()), key(ReadScope.unrestricted()), 'RS-9: dos exentos no comparten entrada');
  assert.equal(key(ReadScope.within(['b', 'a'])), 'a1:in:a,b');
});

test('rs-cache-key: una clave sin el scope sirve a un llamante la entrada de otro, y RS-9 lo ve', async () => {
  const { tree } = await emitted('vault-scoped', {
    stack: { cache: 'redis' },
    sabotage: (file) => (file.path.endsWith('cached-operations.ts') ? file.content.replace(', ReadScope.cacheKey(message.readScope))', ')') : file.content)
  });
  const { ReadScope } = await tree.load(READ_SCOPE_TS);
  const { GET_ASSET_CACHE } = await tree.load('src/application/support/cached-operations.ts');
  const key = (scope) => GET_ASSET_CACHE.keyOf({ id: 'a1', readScope: scope });
  assert.equal(key(ReadScope.within(['a'])), key(ReadScope.within(['b'])), 'el sabotaje no se aplicó');
});

async function readScopes(name, sabotage) {
  const { tree } = await emitted(name, { sabotage });
  const { ReadScopes } = await tree.load(READ_SCOPES_TS);
  const { SecurityContext } = await tree.load(SECURITY_CONTEXT_TS);
  return { ReadScopes, as: (who, action) => SecurityContext.runWith(who, action) };
}

test('RS-10: ReadScopes construye el scope desde el principal; el claim ausente es el conjunto vacío, nunca todo', async () => {
  const vault = await readScopes('vault-scoped');
  assert.deepEqual(vault.as(principal(['vault-admin'], {}), () => vault.ReadScopes.scoping()), { kind: 'unrestricted' }, 'RS-10: el rol exento');
  assert.deepEqual(vault.as(principal([], { azp: 'rendering-service' }), () => vault.ReadScopes.scoping()), { kind: 'unrestricted' }, 'RS-10: el cliente exento');
  assert.deepEqual([...vault.as(principal(['vault-reader'], { vaults: ['A', 'B'] }), () => vault.ReadScopes.scoping()).values], ['A', 'B'], 'RS-10: el claim');
  const absent = vault.as(principal(['vault-reader'], {}), () => vault.ReadScopes.scoping());
  assert.equal(absent.kind, 'within', 'RS-10: el claim ausente no da el conjunto vacío');
  assert.equal(absent.values.size, 0);
  const shop = await readScopes('shop-scoped');
  assert.deepEqual(shop.as(principal(['employee'], { email: 'ana@x.io' }), () => shop.ReadScopes.ownerOfOrderMain()), { kind: 'unrestricted' }, 'RS-10: el rol exento de la propiedad');
  assert.deepEqual(shop.as(principal(['customer'], { email: 'ana@x.io' }), () => shop.ReadScopes.ownerOfOrderMain()), { kind: 'ownedBy', value: 'ana@x.io' }, 'RS-10: el dueño es la identidad');
});

test('rs-empty-is-all (la mitad del borde): el claim ausente leído como todo, y RS-10 lo ve', async () => {
  const vault = await readScopes('vault-scoped', (file) =>
    file.path === READ_SCOPES_TS ? file.content.replace('return ReadScope.within(scope.scopedValues());', 'return scope.scopedValues().size === 0 ? ReadScope.unrestricted() : ReadScope.within(scope.scopedValues());') : file.content
  );
  assert.equal(vault.as(principal(['vault-reader'], {}), () => vault.ReadScopes.scoping()).kind, 'unrestricted', 'el sabotaje no se aplicó');
});

test('RS-11: el readMiss forbidden sale como 403 con su code y el when del error declarado', async () => {
  for (const name of ['vault-scoped', 'shop-scoped']) {
    const { tree, model } = await emitted(name);
    const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.readMiss === 'forbidden' && candidate.readScope.shape === 'single');
    const error = operationError(model, operation.name, operation.readScope.error);
    const { [error.exceptionClass]: ErrorClass } = await tree.load(classPath(DIRS.errors, error.exceptionClass));
    const { ApiExceptionFilter } = await tree.load(EXCEPTION_FILTER_TS);
    let status = null;
    let body = null;
    const reply = { status: (code) => ((status = code), reply), send: (sent) => ((body = sent), reply), header: () => reply };
    const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ method: 'GET', url: '/' }) }) };
    new ApiExceptionFilter().catch(new ErrorClass(readMissMessage(model, operation.readScope)), host);
    assert.equal(status, 403, `${name}: status`);
    assert.equal(body.status, 403, `${name}: status del cuerpo`);
    assert.equal(body.error, DOMAIN_ERROR_RESPONSES.ForbiddenException.error, `${name}: error`);
    assert.equal(body.code, operation.readScope.error, `${name}: code`);
    assert.equal(body.message, readMissMessage(model, operation.readScope), `${name}: message`);
  }
});

test('sin reads con lecturas no se emite nada de la lectura acotada', () => {
  // conduit declara reads: [] (ninguna lectura se acota por construcción): es una decisión, no una petición.
  const { files } = planFixture('conduit');
  assert.ok(!files.filter((file) => !file.path.endsWith('.md')).some((file) => /ReadScope|loadScoped/.test(file.content ?? '')));
});
