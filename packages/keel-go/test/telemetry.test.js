// La telemetría de keel-go (incremento 14c) sin Go: el `telemetry.yaml` contra el de keel-nest, las claves que lee
// `SettingsFrom`, el vocabulario, el cableado de cada punto de paso y que sin telemetría no se emite nada ni un módulo. Lo que
// hace de verdad lo EJECUTAN las pruebas emitidas (`telemetry_test.go`), falsadas en go-check, y telemetry-check en vivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { ATTRIBUTES, OBSERVATIONS, OUTBOX_DEAD_LETTERED } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { MODULES, TELEMETRY_REQUIRES } from '../src/lib/go-stack.js';
import { FIXTURES_DIR, TELEMETRY_DESIGNS } from './helpers/workspace.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

const plan = (name, stack, planner = planService) => {
  const { files } = planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack });
  return Object.fromEntries(files.map((file) => [file.path, file.content]));
};

const otel = (name, stack = {}) => plan(name, { telemetry: 'otel', ...stack });

const withoutHeader = (text) => text.split('\n').slice(1).join('\n');

for (const [name, stack] of [['product-catalog', {}], ['catalog-extended', { cache: 'redis', storage: 'minio' }], ['notification-mailer', {}]]) {
  test(`${name}: el telemetry.yaml de cada perfil es el de keel-nest, salvo la cabecera`, () => {
    const go = otel(name, stack);
    const nest = plan(name, { telemetry: 'otel', ...stack }, planNest);
    for (const profile of PROFILES) {
      const file = `config/parameters/${profile}/telemetry.yaml`;
      assert.equal(withoutHeader(go[file]), withoutHeader(nest[file]), `${name} ${profile}`);
    }
  });
}

test('SettingsFrom lee las claves que el telemetry.yaml declara', () => {
  const reader = otel('product-catalog')['internal/platform/telemetry/settings.go'];
  for (const key of ['telemetry.tracing.sampling-probability', 'telemetry.export.enabled', 'telemetry.export.endpoint', 'telemetry.logs.export-enabled', 'telemetry.metrics.prometheus-enabled', 'telemetry.resource.service-version', 'telemetry.resource.deployment-environment', 'telemetry.resource.service-instance-id', 'management.server.port']) {
    assert.ok(reader.includes(`"${key}"`), key);
  }
});

test('los interruptores son los de los subsistemas del diseño, con la clave del yaml', () => {
  const files = otel('catalog-extended', { cache: 'redis', storage: 'minio' });
  assert.ok(files['internal/platform/telemetry/settings.go'].includes('"keel.telemetry.instrumentation."+id+".enabled"'));
  assert.match(files['config/parameters/develop/telemetry.yaml'], /storage:\n\s+enabled: /);
  assert.match(files['internal/platform/telemetry/settings.go'], /var instrumented = \[\]string\{[^}]*"storage"/);
});

test('el vocabulario de las observaciones y los atributos es el neutral', () => {
  const body = otel('product-catalog')['internal/platform/telemetry/telemetry.go'];
  for (const value of [...Object.values(OBSERVATIONS), ...Object.values(ATTRIBUTES), OUTBOX_DEAD_LETTERED]) assert.ok(body.includes(`"${value}"`), value);
});

test('sin telemetría no se emite nada: ni el paquete, ni un módulo, ni el gate, ni el panel', () => {
  const files = plan('product-catalog');
  assert.ok(!Object.keys(files).some((file) => file.startsWith('internal/platform/telemetry/') || file === 'infra/check-telemetry.sh' || file.startsWith('deploy/observability/') || file === 'docs/keel/conventions/observability.md'));
  for (const module of TELEMETRY_REQUIRES) assert.ok(!files['go.mod'].includes(module), module);
  assert.ok(!Object.values(files).some((content) => content.includes('platform/telemetry"')));
});

test('con telemetría, go.mod declara sus módulos con la versión fijada', () => {
  const goMod = otel('product-catalog')['go.mod'];
  for (const module of TELEMETRY_REQUIRES) assert.ok(goMod.includes(`\t${module} ${MODULES[module].version}\n`), module);
});

test('cada punto de paso queda cableado', () => {
  const files = otel('catalog-extended', { cache: 'redis', storage: 'minio', broker: 'rabbitmq' });
  const main = files['cmd/server/main.go'];
  for (const call of ['telemetry.New(ctx, telemetrySettings)', 'observability.Shutdown(flushCtx)', 'observability.LogHandlers()...', 'observability.RegisterPool(db.Stats)', 'exchange.Telemetry = observability', 'operationCache.OnRead = observability.CacheGet', 'storage.Observed(fileStorage, observability)', 'observability.ServesManagementPort()']) {
    assert.ok(main.includes(call), call);
  }
  assert.match(files['internal/application/use_cases.go'], /func NewUseCases\(logger \*slog\.Logger, observer Observer, deps Dependencies\)/);
  assert.match(files['internal/application/use_cases.go'], /= tracedCommand\(observer, |= traced\(observer, /);
  assert.ok(files['internal/httpapi/server.go'].includes('observability.Instrument('));
  assert.ok(files['internal/infrastructure/messaging/envelope.go'].includes('telemetry.Traceparent(ctx)'));
  assert.ok(files['internal/infrastructure/messaging/outbox.go'].includes('r.Telemetry.Publishing('));
  assert.ok(files['internal/infrastructure/messaging/inbound.go'].includes('func Consume('));
  assert.ok(files['internal/infrastructure/clients/exchange.go'].includes('e.Telemetry.Client('));
  assert.ok(files['cmd/server/messaging.go'].includes('*telemetry.Telemetry'));
});

test('la aplicación se observa por su puerto: no importa la plataforma', () => {
  const files = otel('catalog-extended', { cache: 'redis', storage: 'minio' });
  for (const [file, content] of Object.entries(files)) {
    if (file.startsWith('internal/application/') && !file.endsWith('_test.go')) assert.ok(!content.includes('platform/telemetry"'), file);
  }
  assert.ok(files['internal/application/usecase.go'].includes('type Observer interface'));
});

test('el relay publica solo si la fila tiene quien la mire, y el gauge se lee del relay', () => {
  const main = otel('stock-reservation-events', { broker: 'rabbitmq' })['cmd/server/main.go'];
  assert.ok(main.includes('telemetry.OutboxDeadLettered'));
  assert.ok(main.includes('relay.CountDeadLettered(ctx)'));
});

test('el correo y el almacenamiento se observan en el puerto, y la clave y el destinatario no salen', () => {
  const mail = otel('notification-mailer')['internal/infrastructure/smtp/observed.go'];
  assert.ok(mail.includes('telemetry.MailSend'));
  assert.ok(!/message\.(To|Subject)/.test(mail));
  const storage = otel('catalog-extended', { storage: 'minio' })['internal/infrastructure/storage/observed.go'];
  assert.ok(storage.includes('telemetry.AttrStorageBucket'));
  assert.ok(!/Attr[A-Za-z]*: key|, key\)\s*\}/.test(storage.split('func (s *observedStorage) observe')[1].split('\n}')[0]));
});

test('la convención de observabilidad se instala solo con telemetría y cita lo que existe', () => {
  const files = otel('catalog-extended', { cache: 'redis', storage: 'minio', broker: 'rabbitmq' });
  const convention = files['docs/keel/conventions/observability.md'];
  assert.ok(convention);
  for (const [, route] of convention.matchAll(/`(internal\/[a-z/_.]+\.go)`/g)) assert.ok(files[route], route);
  for (const symbol of ['messaging.Consume', 'storage.Observed', 'smtp.Observed']) assert.ok(convention.includes(symbol), symbol);
});

test('la nota de la suscripción enseña el consumo observado, y sin telemetría no lo nombra', () => {
  const file = 'internal/infrastructure/messaging/stock_reserved_message.go';
  const name = Object.keys(otel('stock-reservation-events', { broker: 'rabbitmq' })).find((candidate) => candidate.endsWith('_message.go'));
  assert.ok(otel('stock-reservation-events', { broker: 'rabbitmq' })[name].includes('messaging.Consume('), file);
  assert.ok(!plan('stock-reservation-events', { broker: 'rabbitmq' })[name].includes('messaging.Consume('));
});

test('toda silueta con telemetría se planifica', () => {
  for (const design of TELEMETRY_DESIGNS) assert.ok(plan(design.from, design.stack)['internal/platform/telemetry/telemetry.go'], design.name);
});
