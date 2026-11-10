// La LECTURA ACOTADA (DSL 2.27) en keel-spring: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/read-scope-designs.js. Lo que esto NO dice —que el predicado filtre de verdad, que el total no
// cuente filas ajenas, que la carga compare— lo mide scripts/read-scope-check.js contra el motor real (RS-1 a RS-11).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { READ_SCOPE_DESIGNS } from '../../keel-core/test/helpers/read-scope-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { casesOf } from '../src/lib/read-scope-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => READ_SCOPE_DESIGNS.find((entry) => entry.name === name);

function plan(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  const document = layers.persistence?.default?.model === 'document';
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-spring, conduit-optional incluido', () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
  }
});

test('conduit-optional: la ruta entra como pública y el controller estampa la identidad que puede faltar', () => {
  const { files } = plan('conduit-optional');
  const chain = fileOf(files, '/security/SecurityConfig.java');
  assert.match(chain, /requestMatchers\(HttpMethod\.GET, "\/api\/v1\/articles\/\{slug\}"\)\.permitAll\(\)/);
  // El bearer inválido es 401 en toda ruta: lo decide el resource server, con los mismos manejadores de error.
  assert.match(chain, /oauth2ResourceServer\(oauth2 -> oauth2\.authenticationEntryPoint\(securityErrorHandlers\)/);
  const identity = fileOf(files, '/security/CallerIdentity.java');
  assert.match(identity, /public static String resolveOptional\(\) \{\s+if \(!\(SecurityContextHolder\.getContext\(\)\.getAuthentication\(\) instanceof JwtAuthenticationToken\)\) \{\s+return null;\s+\}\s+return resolve\(\);/);
  const articles = fileOf(files, '/ArticleV1Controller.java');
  assert.match(articles, /new GetArticleQuery\(slug, CallerIdentity\.resolveOptional\(\)\)/);
  // Las que no son optional siguen con resolve(), que lanza sin identidad.
  assert.match(articles, /CallerIdentity\.resolve\(\)/);
  assert.match(fileOf(files, '/GetArticleQueryHandler.java'), /Identidad opcional \(level: optional, DSL 2\.27\): sin token, query\.callerSubject\(\) llega null/);
});

test('sin ninguna operación optional, CallerIdentity no gana resolveOptional', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb' } });
  assert.doesNotMatch(fileOf(files, '/security/CallerIdentity.java'), /resolveOptional/);
});

test('la frontera de optional: sobre una clave de API se rechaza, con el mensaje neutral', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  design('conduit-optional').mutate(layers);
  layers.security.authentication.protocol = 'api-key';
  const { errors } = checkSupportedFeatures(manifest, layers);
  assert.ok(errors.some((message) => message.includes('keel-spring solo la genera sobre una identidad de token')), errors.join('\n'));
});

test('vault-scoped: puerto con el scope obligatorio, predicado con la subconsulta del salto y carga que compara', () => {
  const { files } = plan('vault-scoped');
  const port = fileOf(files, '/domain/repository/AssetRepository.java');
  assert.match(port, /Optional<Asset> loadScoped\(UUID id, ReadScope scope\);/);
  assert.match(port, /Page<Asset> listAssets\(AssetRepository\.ListAssetsFilter filter, Pageable pageable, ReadScope scope\);|Page<Asset> listAssets\(ListAssetsFilter filter, Pageable pageable, ReadScope scope\);/);
  const adapter = fileOf(files, '/persistence/repositories/AssetRepositoryImpl.java');
  // El predicado se SUMA a los criterios (D4) en la misma Specification que da el total.
  assert.match(adapter, /if \(filter\.status\(\) != null\) \{[\s\S]*?\}\n\s*where\.add\(readScope\(root, query, cb, scope\)\);/);
  // El salto Asset.owner → Owner.code: una subconsulta sobre el espejo de la otra raíz, no un id que se pasa.
  assert.match(adapter, /Subquery<UUID> ids1 = query\.subquery\(UUID\.class\);/);
  assert.match(adapter, /ids1\.select\(hop1\.get\("id"\)\)\.where\(scoped\(cb, hop1\.<String>get\("code"\), scope\)\);/);
  assert.match(adapter, /return root\.get\("ownerId"\)\.in\(ids1\);/);
  // D3: el vacío no ve nada; D5: la carga pregunta al motor con el MISMO predicado, y la ajena es el 403 del diseño.
  assert.match(adapter, /return cb\.disjunction\(\);/);
  assert.match(adapter, /assetJpaRepository\.exists\(\(root, query, cb\) -> cb\.and\(cb\.equal\(root\.get\("id"\), key\), readScope\(root, query, cb, scope\)\)\)/);
  assert.match(adapter, /throw new AssetOutOfScopeError\("El archivo pertenece a un propietario que no está en el alcance del solicitante\."\);/);
  assert.match(fileOf(files, '/persistence/repositories/AssetJpaRepository.java'), /JpaSpecificationExecutor<AssetJpa>/);
});

test('vault-scoped: el borde estampa el ReadScope desde el token y el mensaje no lo acepta del cuerpo', () => {
  const { files } = plan('vault-scoped');
  const controller = fileOf(files, '/AssetV1Controller.java');
  assert.match(controller, /new GetAssetQuery\(id, readScopes\.scoping\(\)\)/);
  assert.match(controller, /public AssetV1Controller\(UseCaseMediator mediator, ReadScopes readScopes\)/);
  assert.match(fileOf(files, '/queries/GetAssetQuery.java'), /@JsonIgnore ReadScope readScope/);
  const scopes = fileOf(files, '/security/ReadScopes.java');
  assert.match(scopes, /if \(callerScope\.isExempt\(\)\) \{\s*return ReadScope\.unrestricted\(\);\s*\}\s*return ReadScope\.within\(callerScope\.scopedValues\(\)\);/);
  const type = fileOf(files, '/domain/repository/ReadScope.java');
  assert.match(type, /public sealed interface ReadScope/);
  assert.match(type, /default String cacheKey\(\)/);
});

test('vault-scoped: la clave de caché de la ficha lleva el scope (D6) y el handler la nota neutral', () => {
  const { files } = plan('vault-scoped', (layers) => layers);
  const cached = files.find((file) => file.path.endsWith('/CachedOperations.java'));
  if (cached) assert.match(cached.content, /return key\(query\.id\(\), query\.readScope\(\)\.cacheKey\(\)\);/);
  const handler = fileOf(files, '/usecases/GetAssetQueryHandler.java');
  assert.match(handler, /Lectura acotada \(security\.authentication\.scoping\.reads\)/);
  assert.match(handler, /assetRepository\.loadScoped\(query\.id\(\), query\.readScope\(\)\)/);
  // La nota vieja del alcance (filtra tú en el handler) ya no sale en una lectura acotada.
  assert.doesNotMatch(handler, /callerScope\.covers/);
  const list = fileOf(files, '/usecases/ListAssetsQueryHandler.java');
  assert.match(list, /query\.readScope\(\)\)/);
});

test('vault-scoped-mongo: el salto resuelve los ids de la otra raíz y la carga pregunta con exists', () => {
  const { files } = plan('vault-scoped-mongo');
  const adapter = fileOf(files, '/persistence/repositories/AssetRepositoryImpl.java');
  assert.match(adapter, /Query hop1 = new Query\(scoped\("code", scope\)\);/);
  assert.match(adapter, /return Criteria\.where\("ownerId"\)\.in\(ids1\);/);
  assert.match(adapter, /if \(!\(scope instanceof ReadScope\.Unrestricted\)\) \{\s*where\.add\(readScope\(scope\)\);/);
  assert.match(adapter, /boolean admitted = mongoTemplate\.exists\(mine, AssetDocument\.class\);/);
  assert.match(adapter, /return Criteria\.where\(property\)\.in\(List\.of\(\)\);/);
});

test('shop-scoped: la propiedad con roles exentos, la carga por la clave de la ruta (T7) y el filtro sumado', () => {
  const { files } = plan('shop-scoped');
  const scopes = fileOf(files, '/security/ReadScopes.java');
  assert.match(scopes, /public ReadScope ownerOfOrderMain\(\) \{\s*if \(hasAny\("ROLE_employee", "ROLE_manager"\)\) \{\s*return ReadScope\.unrestricted\(\);\s*\}\s*return ReadScope\.ownedBy\(CallerIdentity\.resolve\(\)\);/);
  assert.match(scopes, /public ReadScope ownerOfUser\(\) \{\s*return ReadScope\.ownedBy\(CallerIdentity\.resolve\(\)\);/);
  assert.match(fileOf(files, '/domain/repository/UserRepository.java'), /Optional<User> loadScopedByEmail\(String email, ReadScope scope\);/);
  const user = fileOf(files, '/persistence/repositories/UserRepositoryImpl.java');
  assert.match(user, /return admittedOrMiss\(findByEmail\(email\), scope\);/);
  assert.match(user, /return cb\.equal\(value, owned\.value\(\)\);/);
  assert.match(fileOf(files, '/usecases/GetProfileQueryHandler.java'), /userRepository\.loadScopedByEmail\(query\.email\(\), query\.readScope\(\)\)/);
});

test('conduit-scoped: not-found devuelve vacío, no lanza: el 404 del diseño no revela que la fila existe', () => {
  const { files } = plan('conduit-scoped');
  const adapter = fileOf(files, '/persistence/repositories/ArticleRepositoryImpl.java');
  assert.match(adapter, /readMiss: not-found[\s\S]*?return Optional\.empty\(\);/);
  assert.doesNotMatch(adapter, /throw new \w+Error\(/);
  assert.match(adapter, /return Criteria\.where\("authorId"\)\.in\(ids1\);/);
});

test('la frontera neutral: un listado acotado sin finder (T8) no se genera', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  Object.assign(layers.security.ownership.Article, { reads: ['listArticles'], readMiss: 'not-found' });
  layers.security.access.rules.listArticles = { level: 'required' };
  assert.throws(() => planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb' } }), /use-cases\.listArticles .*el listado no tiene finder de build/);
});

test('sin reads con lecturas no se emite nada de la lectura acotada', () => {
  // conduit declara reads: [] (ninguna lectura se acota por construcción): es una decisión, no una petición.
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb' } });
  assert.ok(!files.some((file) => /ReadScope|loadScoped/.test(file.content ?? '') && !file.path.endsWith('.md')));
});

test('las sondas: los casos que ejecuta cada sujeto, y RS-8 solo donde hay un salto', () => {
  const cases = (name) => {
    const { model } = plan(name);
    return casesOf(model);
  };
  assert.deepEqual(cases('shop-scoped'), ['RS-1', 'RS-2', 'RS-3', 'RS-5', 'RS-6', 'RS-7', 'RS-10', 'RS-11']);
  assert.deepEqual(cases('vault-scoped'), ['RS-3', 'RS-5', 'RS-6', 'RS-7', 'RS-8', 'RS-9', 'RS-10', 'RS-11']);
  assert.deepEqual(cases('conduit-scoped'), ['RS-3', 'RS-4', 'RS-8', 'RS-10']);
  assert.deepEqual(cases('conduit-optional'), ['OA-1', 'OA-2', 'OA-3']);
});
