// El arnés del proveedor de prueba de keel-go (incremento 11d), sobre el texto emitido:
//
//   · habla el vocabulario del stub de keel-core (gen/http-stub-probes.js): el corte, el estado inicial de una
//     secuencia, los recursos del admin API y su URL, sin un literal propio;
//   · ofrece los MISMOS helpers que el arnés de keel-dotnet (y por él, los de keel-spring y keel-nest), como métodos
//     del escenario, y el mismo SMOKE-6;
//   · AgeForReconciliation y HoldFromReconciliation ejecutan las MISMAS sentencias que las de keel-dotnet;
//   · la segunda réplica y el reinicio del servidor salen solo cuando el diseño los puede necesitar;
//   · sin clientes salientes no sale nada de esto, y la skill keel-go-httpclient se instala solo con ellos.
// Lo que el stub ENTIENDE de lo que programan los helpers, y lo que llega al adaptador emitido, lo mide
// `npm run stub-check` contra un WireMock real, falsado con sus sabotajes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES, loadService } from '@keel-system/keel-core';
import { HTTP_STUB_ADMIN, HTTP_STUB_ENDPOINTS, HTTP_STUB_FAULT, HTTP_STUB_INITIAL_STATE } from '@keel-system/keel-core/gen/http-stub-probes';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const plan = (name, planner = planService, stack = STACK) => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const { files } = plan('stock-reservation');
const stub = content(files, 'tests/integration/http_stub_test.go');
const flow = content(files, 'tests/integration/flow_test.go');
const smoke = content(files, 'tests/integration/harness_smoke_test.go');
const dotnet = plan('stock-reservation', planDotnet).files;
const dotnetStub = content(dotnet, 'Support/HttpStub.cs');

test('el arnés habla el vocabulario del stub de keel-core', () => {
  assert.ok(stub, 'stock-reservation emite tests/integration/http_stub_test.go');
  for (const literal of [HTTP_STUB_FAULT, HTTP_STUB_INITIAL_STATE, HTTP_STUB_ADMIN, ...Object.values(HTTP_STUB_ENDPOINTS)]) {
    assert.ok(stub.includes(`"${literal}"`), literal);
  }
  assert.match(stub, /os\.Getenv\("HTTP_STUB_ADMIN"\)/, 'el admin API se puede apuntar a otro stub (stub-check)');
  assert.match(stub, /"urlPathPattern": pathPattern/);
});

test('los helpers son los de keel-dotnet, como métodos del escenario', () => {
  for (const helper of ['StubFor', 'StubFailure', 'StubConnectionFault', 'StubTimeout', 'StubSequence', 'StubCallCount', 'StubRequests', 'ResetStubs']) {
    assert.match(dotnetStub, new RegExp(`\\b${helper}\\(`), `keel-dotnet: ${helper}`);
    assert.match(stub, new RegExp(`^func \\(s \\*Scenario\\) ${helper}\\(`, 'm'), `keel-go: ${helper}`);
  }
  // Las respuestas de una secuencia y la lectura de lo que se le mandó.
  for (const member of ['func RespondOK(status int, body any) StubResponse', 'func RespondFailure(status int) StubResponse', 'func RespondTimeout(delay time.Duration) StubResponse', 'func RespondConnectionFault() StubResponse', 'func (r StubRequest) Header(name string) string', 'func (r StubRequest) JSON() (any, error)']) {
    assert.ok(stub.includes(member), member);
  }
  // Una secuencia por ruta y flujo: el flujo siguiente olvida las del anterior.
  assert.match(flow, /stubSequences\.forget\(\)/);
  assert.match(smoke, /SMOKE-6: el proveedor de prueba se deja programar/);
  assert.match(content(dotnet, 'HarnessSmokeTests.cs') ?? dotnet.map((file) => file.content).join('\n'), /SMOKE-6: el proveedor de prueba se deja programar/);
});

test('AgeForReconciliation y HoldFromReconciliation ejecutan las sentencias de keel-dotnet', () => {
  const statements = (text) => [...text.matchAll(/"(UPDATE [^"]+ WHERE id = )"/g)].map((match) => match[1]).sort();
  const dotnetFlow = dotnet.find((file) => file.content.includes('ReconciliationAging')).content;
  const goAging = statements(flow.slice(flow.indexOf('var reconciliationAging'), flow.indexOf('var reconciliationHolding')));
  const goHolding = statements(flow.slice(flow.indexOf('var reconciliationHolding')).split('\n}\n')[0]);
  const dotnetAging = statements(dotnetFlow.slice(dotnetFlow.indexOf('ReconciliationAging = '), dotnetFlow.indexOf('ReconciliationHolding = ')));
  const dotnetHolding = statements(dotnetFlow.slice(dotnetFlow.indexOf('ReconciliationHolding = ')).split('};')[0]);
  assert.ok(goAging.length > 0 && goHolding.length > 0);
  assert.deepEqual(goAging, dotnetAging);
  assert.deepEqual(goHolding, dotnetHolding);
  assert.match(flow, /^func \(s \*Scenario\) AgeForReconciliation\(activation, id string\)/m);
  assert.match(flow, /^func \(s \*Scenario\) HoldFromReconciliation\(activation, id string\)/m);
  // idLiteral, una sola vez aunque lo usen el rescate y la reconciliación.
  assert.equal(flow.match(/^func idLiteral\(/gm)?.length, 1);
});

test('la réplica y el reinicio salen solo cuando el diseño los puede necesitar', () => {
  // stock-reservation tiene outbox y barridos (escenarios de clúster) y un circuito (estado en memoria).
  for (const member of ['func (s *Scenario) StartReplica() string', 'func (s *Scenario) StopReplica()', 'func (s *Scenario) OnReplica(', 'func (s *Scenario) RestartServer()', '\tOnReplica bool']) {
    assert.ok(flow.includes(member), member);
  }
  assert.match(content(files, 'tests/integration/server_test.go'), /var replica = flowServer\{logName: "server-replica\.log"\}/);
  // profile-directory: sin clientes, sin outbox, sin barridos y sin registro de idempotencia.
  const bare = plan('profile-directory', planService, { database: 'postgresql', auth: 'keycloak' }).files;
  const bareFlow = content(bare, 'tests/integration/flow_test.go');
  for (const member of ['StartReplica', 'RestartServer', 'OnReplica bool', 'stubSequences']) assert.ok(!bareFlow.includes(member), member);
  assert.ok(!content(bare, 'tests/integration/http_stub_test.go'));
  assert.doesNotMatch(content(bare, 'tests/integration/harness_smoke_test.go'), /SMOKE-6/);
});

test('cada método que enseñan integration-tests.md y la skill keel-go-httpclient es uno del escenario', () => {
  const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'generators', 'go');
  const doc = fs.readFileSync(path.join(assets, 'conventions', 'integration-tests.md'), 'utf8');
  const skill = ['SKILL.md', 'references/implementation.md', 'references/flows.md'].map((file) => fs.readFileSync(path.join(assets, 'skills', 'keel-go-httpclient', file), 'utf8')).join('\n');
  const sections = doc.slice(doc.indexOf('## El proveedor de prueba'), doc.indexOf('## Una función por flujo'));
  const harness = files.filter((file) => file.path.startsWith('tests/integration/')).map((file) => file.content).join('\n');
  const taught = [...new Set([...`${sections}\n${skill}`.matchAll(/\bs\.([A-Z]\w*)\(/g)].map((match) => match[1]))];
  assert.ok(taught.length >= 14, taught.join(', '));
  for (const name of taught) assert.match(harness, new RegExp(`func \\(s \\*Scenario\\) ${name}\\(`), name);
  for (const name of ['RespondOK', 'RespondFailure', 'RespondTimeout', 'RespondConnectionFault']) {
    assert.ok(`${sections}\n${skill}`.includes(name), `la doc enseña ${name}`);
    assert.match(harness, new RegExp(`^func ${name}\\(`, 'm'), name);
  }
});

test('la skill keel-go-httpclient se instala con los clientes salientes, y solo con ellos', () => {
  const bare = plan('product-catalog', planService, { database: 'postgresql' }).files.map((file) => file.path);
  for (const harness of HARNESSES) {
    for (const file of ['SKILL.md', 'references/implementation.md', 'references/flows.md']) {
      assert.ok(files.some((emitted) => emitted.path === harness.skillPath('keel-go-httpclient', file)), `${harness.id}: ${file}`);
    }
    assert.ok(!bare.includes(harness.skillPath('keel-go-httpclient', 'SKILL.md')), `${harness.id}: sin clientes`);
  }
});
