// El conocimiento del generador dentro del proyecto (incremento 7c): la skill orquestadora, los cinco agentes, las
// convenciones y la skill de la base, proyectados a cada harness. Lo que se mide es lo que se rompe en silencio: un
// asset que existe y nadie instala, un token sin resolver que el agente lee literal, una doc compartida que cita la
// ruta de UN harness, y —lo que más cuesta— una ruta o un símbolo que la doc enseña y build no emite: el agente
// escribiría contra algo inventado. Los ejemplos de Go de las docs se juzgan con tree-sitter, como el Go emitido.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES, loadService } from '@keel-system/keel-core';
import { AGENTS, CONVENTIONS, DOCS_DIR, GUIDES } from '../src/scaffold/generator-docs.js';
import { planService } from '../src/scaffold/index.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { SKILL } from '../src/lib/assets.js';
import { checkGoTree, goParser } from './helpers/go-tree.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));

function planWith(fixture, { stack = null, mutate = null } = {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(manifest, layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
}

const files = byPath(planWith('product-catalog').files);
const mysql = byPath(planWith('product-catalog', { stack: { database: 'mysql' } }).files);
// Lo que solo existe con seguridad: el diseño con personas, en los dos proveedores.
const keycloak = byPath(planWith('profile-directory').files);
const cognito = byPath(planWith('profile-directory', { stack: { auth: 'cognito' } }).files);
// Lo que solo existe con un broker: la mensajería sobre RabbitMQ.
const rabbit = byPath(planWith('stock-reservation-events', { stack: { broker: 'rabbitmq' } }).files);

/** Todos los markdown de assets/ (agentes, guías, convenciones, skills), recursivo. */
function assetSources(dir = assets) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? assetSources(full) : entry.name.endsWith('.md') ? [full] : [];
  });
}

const read = (...parts) => fs.readFileSync(path.join(assets, ...parts), 'utf8');

test('todo agente, guía y convención de assets/ se instala (las listas son el único punto de instalación)', () => {
  assert.deepEqual([...AGENTS].sort(), fs.readdirSync(path.join(assets, 'agents')).sort());
  assert.deepEqual([...CONVENTIONS].sort(), fs.readdirSync(path.join(assets, 'generators', 'go', 'conventions')).sort());
  const guides = fs.readdirSync(path.join(assets, 'generators', 'go')).filter((name) => name.endsWith('.md'));
  assert.deepEqual([...GUIDES].sort(), guides.sort());
  for (const name of [...GUIDES, ...CONVENTIONS.map((c) => `conventions/${c}`), 'framework-errors.md', 'wire-contract.md']) {
    assert.ok(`${DOCS_DIR}/${name}` in files, `${name} se emite en ${DOCS_DIR}/`);
  }
});

test('cada harness recibe su contexto, la skill orquestadora, los cinco agentes y la skill de la base', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.contextFile in files, `${harness.id}: ${harness.contextFile}`);
    assert.ok(harness.skillPath(SKILL, 'SKILL.md') in files, `${harness.id}: skill orquestadora`);
    assert.ok(harness.skillPath('keel-go-database', 'SKILL.md') in files, `${harness.id}: skill de la base`);
    for (const reference of fs.readdirSync(path.join(assets, 'generators', 'go', 'skills', 'keel-go-database', 'references'))) {
      assert.ok(harness.skillPath('keel-go-database', `references/${reference}`) in files, `${harness.id}: ${reference}`);
    }
    for (const agent of AGENTS) {
      const name = agent.replace(/\.md$/, '');
      assert.ok(Object.keys(files).some((file) => file.includes(name) && !file.startsWith(DOCS_DIR)), `${harness.id}: agente ${name}`);
    }
  }
});

test('ningún archivo emitido deja un token {{keel:…}} sin resolver', () => {
  const leftovers = Object.entries(files).filter(([, content]) => /\{\{keel:\w+\}\}/.test(content)).map(([file]) => file);
  assert.deepEqual(leftovers, []);
});

test('las docs compartidas y los assets no citan la ruta ni el archivo de contexto de un harness concreto', () => {
  const harnessPaths = /\.claude\/|\.opencode\/|CLAUDE\.md|AGENTS\.md/;
  for (const [file, content] of Object.entries(files)) {
    if (file.startsWith(`${DOCS_DIR}/`)) assert.doesNotMatch(content, harnessPaths, file);
  }
  for (const source of assetSources()) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\.claude\/|\.opencode\//, path.relative(assets, source));
});

test('los agentes son hojas: ninguno puede lanzar subagentes', () => {
  for (const agent of AGENTS) assert.match(read('agents', agent), /^spawns: false$/m, agent);
});

test('la skill de la base solo se instala con persistencia relacional, y la orquestadora no habla del esquema sin ella', () => {
  const bare = byPath(
    planWith('product-catalog', {
      mutate: (manifest, layers) => {
        delete manifest.layers.persistence;
        delete layers.persistence;
      }
    }).files
  );
  assert.ok(!Object.keys(bare).some((file) => file.includes('keel-go-database')));
  assert.doesNotMatch(bare[HARNESSES[0].skillPath(SKILL, 'SKILL.md')], /goose|schema: OK/);
  assert.ok(Object.keys(mysql).some((file) => file.endsWith('skills/keel-go-database/SKILL.md')), 'y con MySQL también');
});

// Una ruta que la documentación cita y build no emite manda al agente a buscar algo que no existe. Se comprueban
// todas las de los assets contra lo que build emite para las fixtures (y product-catalog sobre MySQL): una ruta que
// solo existe con un rasgo del diseño (internal/platform/textfold, con un campo que pliega) cuenta si alguna la emite.
// Las que llevan un marcador (`<entidad>_behavior.go`) son plantillas y no se miran.
test('cada ruta internal/, cmd/, tests/ e infra/ que citan los assets existe en lo que emite build', () => {
  const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
  const emitted = [...Object.keys(mysql), ...Object.keys(cognito), ...Object.keys(rabbit), ...fixtures.flatMap((name) => planWith(name).files.map((file) => file.path))];
  // Lo que escriben los agentes (las pruebas de flujo, con nombre de ejemplo).
  const agentWritten = /^tests\/integration\/\w+_test\.go$/;
  const missing = [];
  for (const source of assetSources()) {
    const text = fs.readFileSync(source, 'utf8');
    for (const [cited] of text.matchAll(/\b(?:internal|cmd|tests|infra)\/[\w./{},<>*-]+/g)) {
      const route = cited.replace(/[.,:;]+$/, '');
      if (/[<{*]/.test(route) || agentWritten.test(route)) continue;
      const exists = emitted.includes(route) || emitted.some((file) => file.startsWith(route.endsWith('/') ? route : `${route}/`));
      if (!exists) missing.push(`${path.relative(assets, source)} → ${route}`);
    }
  }
  assert.deepEqual(missing, []);
});

// Los símbolos y firmas que la documentación ENSEÑA a usar, contra el código emitido.
test('el arnés que enseñan integration-tests.md y el agente de pruebas es el emitido', () => {
  const flow = files['tests/integration/flow_test.go'];
  const harness = files['tests/integration/harness_test.go'];
  for (const member of [
    'func StartFlow(t *testing.T, given func(s *Scenario)) *Flow',
    'func (f *Flow) Scenario(title string, body func(s *Scenario))',
    'func (s *Scenario) Get(path string, headers ...http.Header) *Response',
    'func (s *Scenario) Post(path string, body any, headers ...http.Header) *Response',
    'func (s *Scenario) Put(path string, body any, headers ...http.Header) *Response',
    'func (s *Scenario) Patch(path string, body any, headers ...http.Header) *Response',
    'func (s *Scenario) Delete(path string, headers ...http.Header) *Response',
    'func (s *Scenario) Exchange(method, path string, body any, headers http.Header) *Response',
    'func (s *Scenario) ExchangeAll(requests ...Request) []*Response',
    'func (s *Scenario) ExpectStatus(got *Response, want int)',
    'func (s *Scenario) AssertJSON(expected string, got *Response)',
    'func (s *Scenario) Eventually(condition func() bool, timeout time.Duration, message string)',
    'func (s *Scenario) ResetState()',
    'func (s *Scenario) Db(sql string) string',
    'func (s *Scenario) BaseURL() string',
    'const RouteBase = "/api/v1"'
  ]) {
    assert.ok(flow.includes(member), member);
  }
  assert.match(flow, /type Request struct \{\n\tMethod +string\n\tPath +string\n\tBody +any\n\tHeaders http\.Header\n\}/);
  for (const member of ['type Response struct {', '\tStatus int', '\tHeader http.Header', '\tBody   string', 'func (r *Response) JSON() (any, error)']) {
    assert.ok(harness.includes(member), member);
  }
  for (const shape of ['"<uuid>"', '"<instant>"', '"<any>"']) assert.ok(flow.includes(shape), shape);
  assert.match(files['tests/integration/harness_smoke_test.go'], /^func TestHarnessSmoke\(t \*testing\.T\)/m);
  // La captura admite las peticiones a la vez de ExchangeAll.
  assert.match(files['tests/integration/failure_capture_test.go'], /type failureCapture struct \{\n\tmu +sync\.Mutex/);
});

test('las credenciales que enseñan la convención, el agente de pruebas y las skills del proveedor son las emitidas', () => {
  const credentials = keycloak['tests/integration/credentials_test.go'];
  for (const member of [
    'func Bearer(token string) http.Header',
    'func (s *Scenario) TokenFor(role string) string',
    'func (s *Scenario) SecondTokenFor(role string) string',
    'func (s *Scenario) TokenAs(p Persona) string',
    'type Persona struct {',
    '	Sub string',
    '	Claims map[string]string',
    '	Without []string',
    '	Role string'
  ]) {
    assert.ok(credentials.includes(member), member);
  }
  // ServiceCredential solo existe con clientes máquina: notification-mailer los declara.
  const machine = byPath(planWith('notification-mailer').files)['tests/integration/credentials_test.go'];
  assert.ok(machine.includes('func (s *Scenario) ServiceCredential(client string) string'));
  // Con Cognito no hay personas (el emulador fija los claims en su configuración): la skill lo dice y build no lo emite.
  assert.doesNotMatch(cognito['tests/integration/credentials_test.go'], /TokenAs|Persona/);
  // Y sin seguridad, ni el archivo.
  assert.equal('tests/integration/credentials_test.go' in files, false);
});

test('la skill del proveedor de identidad se instala con el suyo, y solo con seguridad', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-go-keycloak', 'SKILL.md') in keycloak, `${harness.id}: keycloak`);
    for (const reference of fs.readdirSync(path.join(assets, 'generators', 'go', 'skills', 'keel-go-keycloak', 'references'))) {
      assert.ok(harness.skillPath('keel-go-keycloak', `references/${reference}`) in keycloak, `${harness.id}: ${reference}`);
    }
    assert.ok(!(harness.skillPath('keel-go-cognito', 'SKILL.md') in keycloak));
    assert.ok(harness.skillPath('keel-go-cognito', 'SKILL.md') in cognito, `${harness.id}: cognito`);
    assert.ok(!(harness.skillPath('keel-go-keycloak', 'SKILL.md') in cognito));
  }
  assert.ok(!Object.keys(files).some((file) => /keel-go-(keycloak|cognito)/.test(file)), 'product-catalog no declara seguridad');
});

test('el dominio, la aplicación y la persistencia que enseñan las convenciones y la skill son los emitidos', () => {
  const find = (suffix) => Object.entries(files).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  assert.match(find('internal/domain/errors.go'), /func Errorf\(of \*Error, format string, args \.\.\.any\) error/);
  assert.match(find('internal/domain/errors.go'), /var ErrSkuAlreadyExists = /);
  assert.match(find('internal/domain/format.go'), /func \(f Format\) Validate\(value string\) error/);
  assert.match(find('internal/domain/product.go'), /func \(p \*Product\) transitionTo\(target ProductStatus\) error/);
  assert.match(find('internal/domain/product.go'), /func RehydrateProduct\(state ProductState\) \*Product/);
  assert.match(find('internal/domain/pageable.go'), /func MapPage\[T, R any\]\(page Page\[T\], convert func\(T\) R\) Page\[R\]/);
  assert.match(find('internal/domain/pageable.go'), /type Page\[T any\] struct \{\n\tItems +\[\]T\n\tNumber +int32\n\tSize +int32\n\tTotalElements int64\n\tTotalPages +int32/);
  assert.match(find('internal/application/paged_response.go'), /Items +\[\]T +`json:"items"`/);
  assert.match(find('internal/application/list_products_query.go'), /Pageable domain\.Pageable `json:"-"`/);
  assert.match(find('internal/application/usecase.go'), /var ErrNotImplemented = errors\.New\("sin implementar"\)/);
  assert.match(find('internal/platform/wire/decimal.go'), /func \(d Decimal\) Rescale\(scale int32, mode RoundingMode\) Decimal/);
  assert.match(find('internal/platform/wire/decimal.go'), /func \(d Decimal\) Quo\(other Decimal, scale int32, mode RoundingMode\) \(Decimal, error\)/);
  assert.match(find('internal/platform/wire/decimal.go'), /RoundHalfUp RoundingMode = iota/);
  // La idempotencia de petición: el algoritmo de flow-fidelity.md se escribe con estas piezas.
  assert.match(find('internal/application/idempotency_key.go'), /func IdempotencyKeyFrom\(ctx context\.Context\) \(string, bool\)/);
  assert.match(find('internal/application/create_product_command.go'), /func \(m CreateProductCommand\) IdempotencyScope\(\) string/);
  assert.match(find('internal/application/create_product_command.go'), /func \(m CreateProductCommand\) IdempotencySignature\(\) \(string, error\)/);
  const store = find('internal/domain/idempotency.go');
  assert.match(store, /Find\(ctx context\.Context, scope, key string\) \(StoredRequest, bool, error\)/);
  assert.match(store, /Save\(ctx context\.Context, scope, key, signature string, resourceID \*string, ttlSeconds int\) error/);
  assert.match(store, /ResourceID \*string/);
  for (const name of ['IdempotencyConflict', 'IdempotencyReuse']) assert.match(store, new RegExp(`func ${name}\\(scope, key string\\) error`));
  // El puerto y su uso.
  const port = find('internal/domain/product_repository.go');
  for (const member of ['FindByID(ctx context.Context, id uuid.UUID) (*Product, bool, error)', 'FindBySku(ctx context.Context, sku string) (*Product, bool, error)', 'List(ctx context.Context, pageable Pageable) (Page[*Product], error)', 'Save(ctx context.Context, product *Product) (*Product, error)']) {
    assert.ok(port.includes(member), member);
  }
  // goose: el historial que el reset respeta y la migración que se aplica al arrancar en todos los perfiles.
  assert.match(files['infra/reset-db.sh'], /goose_db_version/);
  assert.match(find('internal/infrastructure/postgres/database.go'), /Migrate aplica las migraciones de goose que falten, en todos los perfiles/);
  assert.ok('internal/infrastructure/postgres/migrations/00001_baseline.sql' in files);
  assert.match(find('internal/domain/errors.go'), /code: "CONCURRENT_MODIFICATION"/);
});

test('el handler de ejemplo de flow-fidelity.md usa la misma clave que la nota del handler emitido', () => {
  const doc = read('generators', 'go', 'conventions', 'flow-fidelity.md');
  const note = files['internal/application/create_product_command_handler.go'];
  for (const piece of ['IdempotencyKeyFrom(ctx)', 'cmd.IdempotencyScope()', 'cmd.IdempotencySignature()', 'domain.IdempotencyReuse(scope', 'domain.IdempotencyConflict', 'uuid.NewV7()', '86400']) {
    assert.ok(doc.includes(piece), `flow-fidelity.md: ${piece}`);
    assert.ok(note.includes(piece.replace('domain.IdempotencyReuse(scope', 'domain.IdempotencyReuse(scope')), `la nota del handler: ${piece}`);
  }
  assert.match(note, /RECLAMA\s+(\/\/\s+)?PRIMERO/);
});

// Los ejemplos de Go de las docs se copian tal cual: tienen que ser Go. Un bloque con su cláusula package se juzga
// entero (sintaxis e imports usados); un fragmento, como declaraciones de un paquete o, si no, como un cuerpo.
test('los ejemplos de Go de las convenciones y las skills son sintaxis válida', async () => {
  const go = await goParser();
  const parses = (source) => {
    const tree = go.parse(source);
    try {
      return !tree.rootNode.hasError;
    } finally {
      tree.delete();
    }
  };
  let blocks = 0;
  const problems = [];
  for (const source of assetSources()) {
    const text = fs.readFileSync(source, 'utf8');
    for (const [, raw] of text.matchAll(/```go\n([\s\S]*?)```/g)) {
      blocks++;
      // Un ejemplo dentro de una lista va sangrado, y `…` marca lo que el ejemplo no escribe.
      const code = raw.replace(/^ {2}/gm, '').replaceAll('…', '');
      const where = path.relative(assets, source);
      if (/^package \w+/m.test(code)) {
        problems.push(...(await checkGoTree([{ path: 'tests/integration/example_test.go', content: code }], 'product-catalog')).map((p) => `${where}: ${p}`));
      } else if (!parses(`package example\n\n${code}`) && !parses(`package example\n\nfunc _() {\n${code}\n}\n`)) {
        problems.push(`${where}: un fragmento que no es Go:\n${code.slice(0, 200)}`);
      }
    }
  }
  assert.ok(blocks >= 6, `se esperaban los ejemplos de las convenciones (${blocks})`);
  assert.deepEqual(problems, []);
});

test('el ejemplo de flujo de integration-tests.md tiene la forma que exige el arnés', () => {
  const doc = read('generators', 'go', 'conventions', 'integration-tests.md');
  const [, example] = doc.match(/## Una función por flujo\n\n```go\n([\s\S]*?)```/);
  assert.ok(example.startsWith('//go:build integration\n\npackage integration\n'), 'la restricción y el paquete');
  assert.ok(!example.includes(GENERATED_HEADER), 'sin la cabecera de código generado: es del agente');
  assert.match(example, /f := StartFlow\(t, nil\)/);
  assert.match(example, /f\.Scenario\("FL-PRD-001: /);
  assert.doesNotMatch(example, /"product-catalog\//, 'la caja negra: ningún import del servicio');
});

test('la skill orquestadora y el contexto enseñan los comandos de esta plataforma, no los de otra', () => {
  for (const harness of HARNESSES) {
    const skill = files[harness.skillPath(SKILL, 'SKILL.md')];
    for (const command of ['bash infra/score-scenarios.sh', 'bash infra/check-flows.sh', 'go mod tidy', "go test -tags integration -count=1 -run '^TestHarnessSmoke$' ./tests/integration/", 'keel-go-quality', 'keel-go-validate']) {
      assert.ok(skill.includes(command), `${harness.id}: ${command}`);
    }
    assert.doesNotMatch(skill, /npm |gradlew|vitest|dotnet |check:architecture|Todavía no hay pipeline/i);
    assert.match(files[harness.contextFile], new RegExp(`/${SKILL}`));
  }
  assert.match(files['README.md'], new RegExp(`/${SKILL}`));
  assert.match(files['README.md'], /_behavior\.go/);
});

test('el cierre no reporta como hueco lo que el diseño ya aceptó por escrito (specs/gaps.yaml, specs/decisions.yaml)', () => {
  const docs = [`${DOCS_DIR}/orchestration.md`, ...Object.keys(files).filter((file) => file.endsWith(`${SKILL}/SKILL.md`))];
  assert.ok(docs.length > 1);
  for (const file of docs) {
    for (const words of ['`specs/gaps.yaml`', '`specs/decisions.yaml`', '`state: accepted`', 'no se reporta']) assert.ok(files[file].includes(words), `${file}: ${words}`);
  }
});

// En la fase 1 code y tests escriben a la vez: el agente de código no puede medir con algo que compile
// tests/integration, o reportaría un `compiles: false` que no es suyo (corrida catalog-dotnet del registry).
test('el agente de código verifica con lo que NO compila las pruebas de flujo, y todo lo que escribe tests lleva la restricción', () => {
  const code = read('agents', 'keel-go-code.md');
  assert.ok(code.includes('`go build ./...` y `go vet ./...` limpios. No ven `tests/integration`'));
  assert.doesNotMatch(code, /go vet -tags integration/);
  for (const file of Object.keys(files).filter((name) => name.startsWith('tests/integration/'))) {
    assert.match(files[file], /^(\/\/ Code generated by keel-go\. DO NOT EDIT\.\n\n)?\/\/go:build integration\n\n(\/\/.*\n)*package integration\n/, file);
  }
  const tests = read('agents', 'keel-go-tests.md');
  assert.ok(tests.includes('`//go:build integration`'));
  assert.ok(tests.includes('**Prohibido leer `internal/` y `cmd/`**'));
});

// La mensajería (incremento 9d): la skill del broker y la tabla del arnés de integration-tests.md, contra lo emitido.

test('la skill de RabbitMQ se instala con ese broker, y solo con él', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-go-rabbitmq', 'SKILL.md') in rabbit, `${harness.id}: rabbitmq`);
    for (const reference of fs.readdirSync(path.join(assets, 'generators', 'go', 'skills', 'keel-go-rabbitmq', 'references'))) {
      assert.ok(harness.skillPath('keel-go-rabbitmq', `references/${reference}`) in rabbit, `${harness.id}: ${reference}`);
    }
  }
  assert.ok(!Object.keys(files).some((file) => file.includes('keel-go-rabbitmq')), 'product-catalog no tiene mensajería');
  const kafka = byPath(planWith('stock-reservation-events', { stack: { broker: 'kafka' } }).files);
  assert.ok(!Object.keys(kafka).some((file) => file.includes('keel-go-rabbitmq')), 'con Kafka, no');
});

test('lo que enseñan la skill de RabbitMQ y integration-tests.md de la mensajería es lo emitido', () => {
  const find = (suffix) => Object.entries(rabbit).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  const all = Object.values(rabbit).join('\n');
  // La conexión y la topología.
  const connection = find('internal/infrastructure/rabbitmq/connection.go');
  assert.match(connection, /func \(c \*Connection\) Publish\(ctx context\.Context, exchange, routingKey, eventType, payload string, headers map\[string\]string\) error/);
  assert.match(connection, /func \(c \*Connection\) Consume\(ctx context\.Context, queue string, handle Handler\) error/);
  assert.match(connection, /type Handler func\(ctx context\.Context, message Message\) error/);
  assert.match(connection, /\tHeaders +map\[string\]string/);
  assert.match(all, /var ErrUnavailable = /);
  const topology = find('internal/infrastructure/rabbitmq/topology.go');
  for (const member of ['func IsRetryable(err error, retriesNotFound bool) bool', 'func RetriesNotFoundOn(queue string) bool', 'func ListenerAttempts() int', 'func Queues() []QueueTopology']) {
    assert.ok(topology.includes(member), member);
  }
  // La mensajería neutral y el archivo del agente.
  assert.match(find('internal/infrastructure/messaging/envelope.go'), /func ParseEnvelope\(text \[\]byte\) \(Envelope\[jsontext\.Value\], error\)/);
  assert.match(find('internal/infrastructure/messaging/envelope.go'), /func \(e Envelope\[T\]\) Wire\(\) \(string, error\)/);
  assert.match(find('internal/infrastructure/messaging/inbound.go'), /func Inbound\(ctx context\.Context, metadata domain\.EventMetadata\) context\.Context/);
  const guard = find('internal/infrastructure/messaging/guard.go');
  for (const member of ['AlreadyProcessed(ctx context.Context, handlerID, eventID string) (bool, error)', 'Record(ctx context.Context, handlerID, eventID string) error', 'TryRecord(ctx context.Context, handlerID, eventID string) (bool, error)']) {
    assert.ok(guard.includes(member), member);
  }
  assert.match(find('internal/infrastructure/messaging/outbox.go'), /Dispatch\(ctx context\.Context, destination, routingKey, eventType, payload string\) error/);
  assert.match(find('internal/infrastructure/messaging/stock_reserved_message.go'), /func ReadStockReservedMessage\(data jsontext\.Value\) \(StockReservedMessage, error\)/);
  assert.match(rabbit['cmd/server/broker.go'], /func brokerAdapters\(settings messaging\.Settings, rabbit \*rabbitmq\.Connection, logger \*slog\.Logger\) \(outbound, error\)/);
  assert.match(rabbit['cmd/server/broker.go'], /func messageListeners\(deps inbound\) \(\[\]listener, error\)/);
  assert.ok(!rabbit['cmd/server/broker.go'].startsWith(GENERATED_HEADER), 'broker.go es del agente');
  assert.match(rabbit['cmd/server/messaging.go'], /\tRabbit +\*rabbitmq\.Connection/);
  assert.match(all, /ApplyStockReserved CommandHandler\[ApplyStockReservedCommand\]/);
  for (const name of ['ErrInvalidStateTransition', 'ErrConcurrentModification']) assert.match(find('internal/domain/errors.go'), new RegExp(`var ${name} = `));
  // El best-effort del ejemplo de la skill, sobre metering-digest.
  const bestEffort = Object.values(byPath(planWith('metering-digest', { stack: { broker: 'rabbitmq' } }).files)).join('\n');
  assert.match(bestEffort, /Publish\(ctx context\.Context, event DailyDigestClosedIntegrationEvent\) error/);
  assert.match(bestEffort, /\tDailyDigestClosed DailyDigestClosedPublisher/);
  assert.match(bestEffort, /func NewEnvelope\[T any\]\(ctx context\.Context, metadata domain\.EventMetadata, data T\) Envelope\[T\]/);
  // La tabla del arnés de integration-tests.md: cada método que enseña es uno del escenario.
  const doc = read('generators', 'go', 'conventions', 'integration-tests.md');
  const section = doc.slice(doc.indexOf('## La mensajería'), doc.indexOf('## Una función por flujo'));
  const harness = rabbit['tests/integration/messaging_test.go'];
  const taught = [...section.matchAll(/`s\.([A-Z]\w*)\(/g)].map((match) => match[1]).filter((name) => name !== 'Deliver');
  assert.ok(taught.length >= 9, taught.join(', '));
  for (const name of taught) assert.match(harness + rabbit['tests/integration/flow_test.go'], new RegExp(`func \\(s \\*Scenario\\) ${name}\\(`), name);
  for (const member of ['RoutingKey string', 'func (m BrokerMessage) EventID() string', 'func (m BrokerMessage) EventType() string', 'func (m BrokerMessage) Type() string', 'func (m BrokerMessage) Payload() map[string]any']) {
    assert.ok(harness.includes(member), member);
  }
});

// Kafka (tramo 9f): la skill del broker, contra lo emitido.

test('la skill de Kafka se instala con ese broker, y solo con él', () => {
  const kafka = byPath(planWith('stock-reservation-events', { stack: { broker: 'kafka' } }).files);
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-go-kafka', 'SKILL.md') in kafka, `${harness.id}: kafka`);
    for (const reference of fs.readdirSync(path.join(assets, 'generators', 'go', 'skills', 'keel-go-kafka', 'references'))) {
      assert.ok(harness.skillPath('keel-go-kafka', `references/${reference}`) in kafka, `${harness.id}: ${reference}`);
    }
  }
  assert.ok(!Object.keys(rabbit).some((file) => file.includes('keel-go-kafka')), 'con RabbitMQ, no');
  assert.ok(!Object.keys(files).some((file) => file.includes('keel-go-kafka')), 'product-catalog no tiene mensajería');
});

test('lo que enseña la skill de Kafka es lo emitido', () => {
  const kafka = byPath(planWith('stock-reservation-events', { stack: { broker: 'kafka' } }).files);
  const find = (suffix) => Object.entries(kafka).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
  const skill = read('generators', 'go', 'skills', 'keel-go-kafka', 'SKILL.md');
  const connection = find('internal/infrastructure/kafka/connection.go');
  assert.match(connection, /func \(c \*Connection\) Publish\(ctx context\.Context, topic, key, payload string, headers map\[string\]string\) error/);
  assert.match(connection, /func \(c \*Connection\) Consume\(ctx context\.Context, subscription string, handle Handler\) error/);
  assert.match(connection, /type Handler func\(ctx context\.Context, message Message\) error/);
  assert.match(connection, /\tValue +\[\]byte/);
  assert.match(connection, /var ErrUnavailable = /);
  const consumption = find('internal/infrastructure/kafka/consumption.go');
  for (const member of ['func IsRetryable(err error, retriesNotFound bool) bool', 'func ListenerAttempts() int', 'func Subscriptions() []SubscriptionConsumption', 'func DeadLetterTopic(topic string) string']) {
    assert.ok(consumption.includes(member), member);
  }
  // Las llamadas de los ejemplos: la firma que enseñan es la emitida.
  assert.ok(skill.includes('d.kafka.Publish(ctx, destination, routingKey, payload, nil)'));
  assert.ok(skill.includes('deps.Kafka.Consume(ctx, "StockReserved", handleStockReserved)'));
  assert.ok(skill.includes('messaging.ParseEnvelope(message.Value)'));
  assert.match(kafka['cmd/server/broker.go'], /func brokerAdapters\(settings messaging\.Settings, kafkaConn \*kafka\.Connection, logger \*slog\.Logger\) \(outbound, error\)/);
  assert.match(kafka['cmd/server/messaging.go'], /\tKafka +\*kafka\.Connection/);
  assert.match(kafka['cmd/server/broker.go'], /con la skill keel-go-kafka/);
  // Lo que dice el diagnóstico que escribe el log, lo escribe.
  assert.ok(read('generators', 'go', 'skills', 'keel-go-kafka', 'references', 'troubleshooting.md').includes('el diseño no declara dead-letter para esta suscripción'));
  assert.ok(connection.includes('el diseño no declara dead-letter para esta suscripción'));
  assert.ok(find('tests/integration/messaging_test.go').includes('¿falta el listener de su suscripción en cmd/server/broker.go?'));
});
