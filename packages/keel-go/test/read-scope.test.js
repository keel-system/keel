// La LECTURA ACOTADA (DSL 2.27) en keel-go: la forma de lo que emite build sobre los diseños de
// keel-core/test/helpers/read-scope-designs.js y la paridad con keel-spring, keel-nest y keel-dotnet. RS-1 a RS-8 los miden
// db-check y doc-check contra el motor real (scripts/lib/read-scope-probes.js, `--sabotage=rs-*`); RS-9 a RS-11, las
// pruebas emitidas, que ejecuta go-check (`--read-scope`, falsadas con test/helpers/read-scope-sabotages.js). Aquí, lo que no
// necesita Go: que los sabotajes se sigan aplicando y nombren una prueba que existe.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { READ_SCOPE_KEY_CASES, READ_SCOPE_SABOTAGES, scopedReadsOf } from '@keel-system/keel-core/gen/read-scope';
import { READ_SCOPE_DESIGNS } from '../../keel-core/test/helpers/read-scope-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { scopedLoadsOf as goLoads } from '../src/scaffold/read-scope.js';
import { READ_SCOPE_SABOTAGE_SPECS } from '../scripts/lib/read-scope-probes.js';
import { READ_SCOPE_EDGE_SABOTAGES, applyReadScopeSabotage } from './helpers/read-scope-sabotages.js';
import { applyDbSabotage } from './helpers/db-sabotages.js';
import { applyDocSabotage } from './helpers/doc-sabotages.js';
import { FIXTURES_DIR, UNCOVERED_BRANCHES } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { scopedLoadsOf as springLoads } from '../../keel-spring/src/scaffold/read-scope.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { scopedLoadsOf as nestLoads } from '../../keel-nest/src/scaffold/read-scope.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { scopedLoadsOf as dotnetLoads } from '../../keel-dotnet/src/scaffold/read-scope.js';

function plan(name) {
  const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, branch.from));
  branch.mutate(manifest, layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
}
const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

test('los sujetos pasan la frontera de keel-go (salvo conduit-optional, que es del incremento 5)', () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    const { errors } = checkSupportedFeatures(manifest, layers);
    if (name === 'conduit-optional') assert.ok(errors.some((message) => message.includes('level: optional')), name);
    else assert.deepEqual(errors, [], name);
  }
});

test('vault-scoped: el finder pide el scope, el predicado se SUMA tras los criterios y el salto es una subconsulta', () => {
  const { files } = plan('vault-scoped');
  const port = fileOf(files, 'internal/domain/asset_repository.go');
  assert.match(port, /\tLoadScoped\(ctx context\.Context, id uuid\.UUID, scope ReadScope\) \(\*Asset, bool, error\)/);
  assert.match(port, /\tListAssets\(ctx context\.Context, filter ListAssetsFilter, pageable Pageable, scope ReadScope\) \(Page\[\*Asset\], error\)/);
  assert.doesNotMatch(port, /\tList\(ctx context\.Context, pageable Pageable\)/, 'una raíz con sus listados acotados no tiene List sin scope');
  const adapter = fileOf(files, 'internal/infrastructure/postgres/asset_repository.go');
  // El alcance va tras los criterios y antes del total: la misma consulta da las filas y el total.
  assert.match(adapter, /\t\tf\.add\("status", "=", [^\n]+\n\t\}\n\tr\.scoped\(&f, scope\)\n[\s\S]*?SELECT count\(\*\) FROM assets "\+f\.where\(\)/);
  assert.match(adapter, /f\.in\("owner_id IN \(SELECT id FROM owners WHERE code", scope\.Values\(\), "\)"\)/);
  assert.match(adapter, /return nil, false, domain\.Errorf\(domain\.ErrAssetOutOfScope, "El archivo pertenece a un propietario que no está en el alcance del solicitante\."\)/);
  const endpoints = files.filter((file) => file.path.startsWith('internal/httpapi/') && file.path.endsWith('_endpoints.go')).map((file) => file.content).join('\n');
  assert.equal((endpoints.match(/query\.ReadScope = readScopeScoping\(r\.Context\(\)\)/g) ?? []).length, 2);
  assert.match(fileOf(files, 'internal/application/get_asset_query.go'), /\tReadScope domain\.ReadScope `json:"-"`/);
  assert.match(fileOf(files, 'internal/application/cached_operations.go'), /return CacheKey\(query\.ID, query\.ReadScope\.CacheKey\(\)\)/);
  const handler = fileOf(files, 'internal/application/get_asset_query_handler.go').replace(/\n\t\/\/ ?/g, ' ');
  assert.match(handler, /Lectura acotada \(security\.authentication\.scoping\.reads\)/);
  assert.match(handler, /h\.assetRepository\.LoadScoped\(ctx, query\.ID, query\.ReadScope\)/);
  // La nota vieja del alcance (comprobar a mano con callerScope) ya no: lo aplica el adaptador.
  assert.doesNotMatch(handler, /callerScope\.Covers/);
  assert.match(fileOf(files, 'internal/httpapi/read_scope.go'), /\tif scope\.IsExempt\(ctx\) \{\n\t\treturn domain\.UnrestrictedScope\(\)\n\t\}\n\treturn domain\.ScopeWithin\(scope\.ScopedValues\(ctx\)\)/);
});

test('el valor cero de domain.ReadScope es el conjunto vacío, y la clave lleva los casos de keel-core', () => {
  const { files } = plan('vault-scoped');
  assert.match(fileOf(files, 'internal/domain/read_scope.go'), /\tReadScopeWithin ReadScopeKind = iota\n/);
  const tests = fileOf(files, 'internal/domain/read_scope_test.go');
  for (const entry of READ_SCOPE_KEY_CASES) assert.ok(tests.includes(`"${entry.key.replaceAll('\\', '\\\\')}"},`), entry.id);
});

test('vault-scoped-mongo y conduit-scoped: el salto resuelve los ids de la otra colección; not-found da found false', () => {
  const mongo = fileOf(plan('vault-scoped-mongo').files, 'internal/infrastructure/mongo/asset_repository.go');
  assert.match(mongo, /ids1, err := r\.idsIn\(ctx, "owners", bson\.D\{\{Key: "code", Value: bson\.D\{\{Key: "\$in", Value: allowed\}\}\}\}\)/);
  assert.match(mongo, /return append\(conditions, bson\.D\{\{Key: "owner_id", Value: bson\.D\{\{Key: "\$in", Value: ids1\}\}\}\}\), nil/);
  assert.match(mongo, /\tconditions, err := r\.scoped\(ctx, conditions, scope\)\n\tif err != nil \{\n\t\treturn domain\.Page\[\*domain\.Asset\]\{\}, err\n\t\}\n/);
  const conduit = plan('conduit-scoped').files;
  const article = fileOf(conduit, 'internal/infrastructure/mongo/article_repository.go');
  assert.match(article, /func \(r \*ArticleRepository\) LoadScopedBySlug\(ctx context\.Context, slug string, scope domain\.ReadScope\) \(\*domain\.Article, bool, error\) \{\n\tfound, ok, err := r\.FindBySlug\(ctx, slug\)/);
  assert.match(article, /readMiss: not-found[^\n]*\n\treturn nil, false, nil/);
  assert.match(fileOf(conduit, 'internal/httpapi/read_scope.go'), /owner, err := callerIdentity\(ctx\)/);
});

test('shop-scoped: la propiedad sobre la propia fila, con los roles exentos y la identidad del llamante', () => {
  const { files } = plan('shop-scoped');
  const scopes = fileOf(files, 'internal/httpapi/read_scope.go');
  assert.match(scopes, /principal\.Has\("ROLE_employee"\) \|\| principal\.Has\("ROLE_manager"\)/);
  assert.match(scopes, /func readScopeOwnerOfOrderMain\(ctx context\.Context\) \(domain\.ReadScope, error\)/);
  assert.match(fileOf(files, 'internal/infrastructure/postgres/order_main_repository.go'), /f\.in\("buyer_email", scope\.Values\(\), ""\)/);
  assert.match(fileOf(files, 'internal/domain/user_repository.go'), /LoadScopedByEmail\(ctx context\.Context, email string, scope ReadScope\)/);
  const edge = fileOf(files, 'internal/httpapi/read_scope_test.go');
  assert.match(edge, /func TestRS10ReadScopeOwnerOfOrderMain/);
  assert.match(edge, /func TestRS11GetOrderLaFilaAjenaEs403ConSuCodeYSuTexto/);
  assert.match(edge, /func TestRS11GetProfileLaFilaAjenaEs403ConSuCodeYSuTexto/);
});

test('la frontera neutral: un listado acotado sin finder (T8) no se genera', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
  Object.assign(layers.security.ownership.Article, { reads: ['listArticles'], readMiss: 'not-found' });
  layers.security.access.rules.listArticles = { level: 'required' };
  assert.throws(() => planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null }), /use-cases\.listArticles .*el listado no tiene finder de build/);
});

test('sin reads con lecturas no se emite nada de la lectura acotada', () => {
  // conduit declara reads: [] (ninguna lectura se acota por construcción): es una decisión, no una petición.
  const { files } = planService({ ...loadService(path.join(FIXTURES_DIR, 'conduit')), workspace: FIXTURES_DIR, stack: null });
  assert.ok(!files.filter((file) => !file.path.endsWith('.md')).some((file) => /ReadScope|LoadScoped/.test(file.content ?? '')));
});

test('los sabotajes rs-* de keel-core tienen su sitio en keel-go, con el mismo id, y se siguen aplicando', () => {
  const edge = new Set(READ_SCOPE_EDGE_SABOTAGES.map((sabotage) => sabotage.id));
  for (const { id } of READ_SCOPE_SABOTAGES) assert.ok(READ_SCOPE_SABOTAGE_SPECS[id] || edge.has(id), id);
  // Cada sabotaje del adaptador toca lo emitido de algún sujeto de su almacén.
  const relational = ['vault-scoped', 'shop-scoped'].map((name) => plan(name).files);
  const document = ['vault-scoped-mongo', 'conduit-scoped'].map((name) => plan(name).files);
  for (const [id, spec] of Object.entries(READ_SCOPE_SABOTAGE_SPECS)) {
    assert.ok(relational.some((files) => applyDbSabotage(spec.relational, files).changed > 0), `${id}: ya no se aplica al relacional`);
    assert.ok(document.some((files) => applyDocSabotage(spec.document, files).changed > 0), `${id}: ya no se aplica al documental`);
  }
  for (const sabotage of READ_SCOPE_EDGE_SABOTAGES) {
    const { files } = plan(sabotage.subject);
    const file = files.find((candidate) => candidate.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applyReadScopeSabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca ${sabotage.id}`);
    const emitted = files.filter((candidate) => candidate.path.endsWith('_test.go')).map((candidate) => candidate.content).join('\n');
    assert.match(emitted, new RegExp(`^func ${sabotage.fails}\\(t \\*testing\\.T\\)`, 'm'), sabotage.id);
  }
});

test('paridad con keel-spring, keel-nest y keel-dotnet: las mismas cargas por raíz y las mismas lecturas acotadas', async () => {
  for (const { name, from, mutate } of READ_SCOPE_DESIGNS.filter((entry) => entry.name !== 'conduit-optional')) {
    const go = plan(name);
    const fresh = () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
      mutate(layers);
      return { manifest, layers, workspace: FIXTURES_DIR, stack: { database: layers.persistence?.default?.model === 'document' ? 'mongodb' : 'postgresql' } };
    };
    // El parámetro sin caja: Go escribe las siglas en mayúsculas (orderID).
    const loads = (model, of) =>
      model.entities
        .filter((entity) => entity.isAggregateRoot)
        .flatMap((entity) => of(model, entity).map((load) => `${entity.name}.${decap(load.method)}(${String(load.param.name).replace(/^@/, '').toLowerCase()})`));
    const mine = loads(go.model, goLoads);
    assert.deepEqual(mine, loads(planSpring(fresh()).model, springLoads), `${name}: keel-spring`);
    assert.deepEqual(mine, loads(planNest(fresh()).model, nestLoads), `${name}: keel-nest`);
    assert.deepEqual(mine, loads((await planDotnet(fresh())).model, dotnetLoads), `${name}: keel-dotnet`);
    assert.deepEqual(
      scopedReadsOf(go.model).map((operation) => operation.name),
      scopedReadsOf(planSpring(fresh()).model).map((operation) => operation.name),
      name
    );
  }
});
