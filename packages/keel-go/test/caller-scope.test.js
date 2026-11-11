// El alcance por recurso de keel-go (tramo 13h-b), sobre el texto emitido. Lo que `CallerScope` HACE lo ejecuta su prueba
// emitida (`caller_scope_test.go`, en go-check, falsada con test/helpers/scope-sabotages.js); y que el usuario del alcance
// lleve el claim al token firmado, `npm run security-check`. Aquí, lo que tiene que coincidir con los otros tres y lo que el
// agente lee:
//   · el claim, los roles y los clientes exentos son los del diseño, como en el JwtCallerScope de keel-dotnet;
//   · lo reciben SOLO los handlers que declaran el error del alcance, y el arranque lo cablea;
//   · la nota del handler es la de keel-dotnet con los nombres de Go;
//   · el arnés da el mismo usuario del alcance que los otros tres.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { SCOPE_SABOTAGES, applyScopeSabotage } from './helpers/scope-sabotages.js';

const STACK = { database: 'mongodb', broker: 'rabbitmq', auth: 'keycloak', cache: 'redis', storage: 'minio' };
const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService, stack = STACK) => planner({ ...design(name), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

const { model, files } = plan('asset-vault');
const adapter = content(files, 'internal/platform/security/caller_scope.go');

test('el adaptador lleva el claim y los exentos del diseño, los mismos que el JwtCallerScope de keel-dotnet', () => {
  const { claim, exemptRoles, exemptClients } = model.security.scoping;
  assert.ok(adapter.includes(`const scopingClaim = "${claim}"`));
  assert.ok(adapter.includes(`[]string{${exemptRoles.map((role) => `"ROLE_${role}"`).join(', ')}}`));
  assert.ok(adapter.includes(`[]string{${exemptClients.map((client) => `"${client}"`).join(', ')}}`));
  const dotnet = content(plan('asset-vault', planDotnet).files, 'Security/JwtCallerScope.cs');
  assert.ok(dotnet.includes(`ScopingClaim = "${claim}"`));
  for (const role of exemptRoles) assert.ok(dotnet.includes(`"ROLE_${role}"`), role);
  for (const client of exemptClients) assert.ok(dotnet.includes(`"${client}"`), client);
  // El cliente de la credencial: los mismos claims y en el mismo orden.
  assert.match(dotnet, /"azp".*"client_id".*principal\.Name/s);
  assert.match(adapter, /"azp", "client_id"[\s\S]*principal\.Name/);
});

test('lo reciben todos los handlers, también el listado que filtra sin declarar el 403, y el arranque lo cablea', () => {
  const { error } = model.security.scoping;
  const operations = model.services.flatMap((service) => service.operations).filter((operation) => operation.handlerClass);
  // listAssets es el caso de la corrida: su regla acota el listado y FL-AST-004-B lo afirma, pero no declara el error.
  const listing = operations.find((operation) => operation.name === 'listAssets');
  assert.ok(listing && !(listing.errors ?? []).includes(error));
  const useCases = content(files, 'internal/application/use_cases.go');
  assert.match(useCases, /NewListAssetsQueryHandler\([^\n]*deps\.CallerScope/);
  assert.equal(useCases.split('\n').filter((line) => line.includes('deps.CallerScope')).length, operations.length);
  const handlers = files.filter((file) => /internal\/application\/\w+_handler\.go$/.test(file.path));
  const withScope = handlers.filter((file) => file.content.includes('callerScope CallerScope'));
  assert.equal(withScope.length, operations.length);
  const handler = content(files, 'internal/application/list_assets_query_handler.go');
  assert.match(handler, /en un listado, IsExempt y ScopedValues con un finder acotado/);
  assert.ok(files.some((file) => /\/server\.go$|\/main\.go$/.test(file.path) && /CallerScope:\s+security\.CallerScope\{\},/.test(file.content)));
});

test('la nota del handler dice lo mismo que la de keel-dotnet, con los nombres de Go', () => {
  // Sin reads (la v1.1.2 de la fixture): una lectura en reads se acota en el adaptador y su nota es otra.
  const withoutReads = () => {
    const loaded = design('asset-vault');
    delete loaded.layers.security.authentication.scoping.reads;
    delete loaded.layers.security.authentication.scoping.readMiss;
    return loaded;
  };
  const handler = content(planService({ ...withoutReads(), workspace: FIXTURES_DIR, stack: STACK }).files, 'internal/application/get_asset_query_handler.go').replace(/\n\t\/\/\s+/g, ' ');
  const dotnet = planDotnet({ ...withoutReads(), workspace: FIXTURES_DIR, stack: STACK }).files.find((file) => /GetAssetQueryHandler\.cs$/.test(file.path)).content.replace(/\n\s*\/\/\s+/g, ' ');
  assert.match(dotnet, /comprueba callerScope\.Covers\(<Owner\.code del recurso>\) donde lo digan las reglas; fuera del alcance, ASSET_OUT_OF_SCOPE\. Exentos: vault-admin, cliente rendering-service\./);
  assert.match(handler, /comprueba h\.callerScope\.Covers\(ctx, <Owner\.code del recurso>\) donde lo digan las reglas; fuera del alcance, ASSET_OUT_OF_SCOPE\. Exentos: vault-admin, cliente rendering-service\./);
  assert.match(handler, /filtra por h\.callerScope\.ScopedValues\(ctx\) con un finder acotado que escribes tú/);
});

test('el arnés da ScopedResource y TokenWithScope con el mismo usuario que los otros tres', () => {
  const credentials = content(files, 'tests/integration/credentials_test.go');
  assert.match(credentials, /func ScopedResource\(\) string/);
  assert.match(credentials, /func \(s \*Scenario\) TokenWithScope\(role string, values \.\.\.string\) string/);
  // El nombre: Integer.toHexString(String.hashCode()) de los valores ordenados. El de ["OTRO"] se mide en security-check.
  assert.match(credentials, /"scoped-%s-%x", role, javaStringHash\(strings\.Join\(wanted, "\\n"\)\)/);
  const dotnet = content(plan('asset-vault', planDotnet).files, 'Support/Credentials.cs');
  assert.match(dotnet, /\$"scoped-\{role\}-\{JavaStringHash\(string\.Join\('\\n', wanted\)\)\}"/);
});

test('con Cognito TokenWithScope lo da el emulador, sin administración del realm, y sin alcance no se emite nada', () => {
  // La petición la ejecuta y la compara con la de referencia `npm run emulator-harness-check` (incremento 4.3).
  const cognito = plan('asset-vault', planService, { ...STACK, auth: 'cognito' }).files;
  const credentials = content(cognito, 'tests/integration/credentials_test.go');
  assert.match(credentials, /func ScopedResource\(\) string/);
  assert.match(credentials, /func \(s \*Scenario\) TokenWithScope\(role string, values \.\.\.string\) string/);
  assert.match(credentials, /"keel_scoped": +\{fmt\.Sprint\(len\(wanted\)\)\}/);
  assert.doesNotMatch(credentials, /func adminToken/);
  const other = plan('profile-directory', planService, { database: 'postgresql', auth: 'keycloak' }).files;
  assert.equal(content(other, 'internal/platform/security/caller_scope.go'), undefined);
  assert.equal(content(other, 'internal/application/caller_scope.go'), undefined);
  assert.doesNotMatch(content(other, 'tests/integration/credentials_test.go'), /TokenWithScope|ScopedResource/);
});

for (const [id, sabotage] of Object.entries(SCOPE_SABOTAGES)) {
  test(`el sabotaje ${id} se aplica y nombra pruebas emitidas que existen`, () => {
    const emitted = [...content(files, 'internal/platform/security/caller_scope_test.go').matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]);
    const changed = applyScopeSabotage(sabotage, files);
    assert.notEqual(changed.find((file) => file.path === sabotage.file).content, files.find((file) => file.path === sabotage.file).content);
    assert.ok(emitted.some((name) => sabotage.expect.test(name)), id);
  });
}
