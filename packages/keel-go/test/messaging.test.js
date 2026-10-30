// La mensajería de keel-go (incremento 9) sobre el texto emitido: qué se emite y dónde, la configuración —la MISMA que
// keel-nest y keel-dotnet, byte a byte—, las claves que lee messaging.Settings contra las que escribe messaging.yaml, las
// tablas de los almacenes contra las que EMITE keel-spring, el puente en el adaptador de repositorio y el cableado del
// arranque con el archivo del agente. Lo que ejecuta el Go (la envoltura en el cable, sus rechazos, el backoff) lo mide
// la prueba emitida messaging_test.go en `npm run go-check`; el reclamo, el lease y la guarda contra un motor real,
// `npm run db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { OUTBOX_EVENT, PROCESSED_EVENT, OUTBOX_RELAY } from '@keel-system/keel-core/gen/messaging-stores';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springSchema } from '../../keel-spring/test/helpers/schema-table.js';
import { planService } from '../src/scaffold/index.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { goSchema } from './helpers/schema.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const MESSAGING_FIXTURES = ['metering-digest', 'notification-mailer', 'stock-reservation', 'stock-reservation-events', 'catalog-extended', 'payment-checkout'];
const BROKERS = ['rabbitmq', 'kafka', 'snssqs'];
const PROFILES = ['local', 'develop', 'production', 'test'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, stack = { broker: 'rabbitmq' }, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack }).files;
const content = (files, file) => files.find((candidate) => candidate.path === file)?.content;
const MESSAGING = 'internal/infrastructure/messaging';

test('stock-reservation-events (outbox): la envoltura, el puente, el outbox, la guarda, los mensajes y el cableado', () => {
  const files = plan('stock-reservation-events');
  for (const name of ['doc', 'settings', 'envelope', 'inbound', 'bridge', 'outbox', 'guard', 'stock_reservation_requested_integration_event', 'messaging_test']) {
    assert.ok(content(files, `${MESSAGING}/${name}.go`), name);
  }
  for (const name of ['stock_reserved_message', 'stock_count_adjusted_message', 'stock_rejected_message']) assert.ok(content(files, `${MESSAGING}/${name}.go`), name);
  // Con outbox no hay publishers best-effort.
  assert.equal(content(files, `${MESSAGING}/publishers.go`), undefined);
  for (const name of ['outbox', 'processed_events']) assert.ok(content(files, `internal/infrastructure/postgres/${name}.go`), name);
});

test('metering-digest (best-effort, envoltura propia): publishers con respaldo, sin outbox, y la envoltura de la fuente', () => {
  const files = plan('metering-digest');
  assert.match(content(files, `${MESSAGING}/publishers.go`), /type DailyDigestClosedPublisher interface/);
  assert.match(content(files, `${MESSAGING}/bridge.go`), /func \(b \*Bridge\) Deliver\(/);
  assert.equal(content(files, `${MESSAGING}/outbox.go`), undefined);
  assert.equal(content(files, 'internal/infrastructure/postgres/outbox.go'), undefined);
  assert.match(content(files, `${MESSAGING}/meter_reading_captured_envelope.go`), /func \(e MeterReadingCapturedEnvelope\) Message\(\) \(MeterReadingCapturedMessage, error\)/);
  // La envoltura propia se lee con los nombres de la fuente (wireName).
  assert.match(content(files, `${MESSAGING}/meter_reading_captured_message.go`), /`json:"meter_id"`/);
});

for (const name of MESSAGING_FIXTURES) {
  test(`${name}: messaging.yaml es el de keel-dotnet (y keel-nest), byte a byte, con los tres brokers y en los cuatro perfiles`, () => {
    for (const broker of BROKERS) {
      const ours = plan(name, { broker });
      const dotnet = plan(name, { broker }, planDotnet);
      for (const profile of PROFILES) {
        const file = `config/parameters/${profile}/messaging.yaml`;
        assert.ok(content(ours, file), `${broker}: ${file} se emite`);
        assert.equal(content(ours, file), content(dotnet, file), `${broker}: ${file}`);
      }
    }
  });

  test(`${name}: toda clave que lee messaging.Settings existe en su messaging.yaml`, () => {
    for (const broker of BROKERS) {
      const files = plan(name, { broker });
      const yaml = flatten(parseYaml(content(files, 'config/parameters/local/messaging.yaml')));
      const settings = content(files, `${MESSAGING}/settings.go`);
      const keys = [...settings.matchAll(/read\.(?:text|positive|millis)\("([^"]+)"/g)].map((match) => match[1]);
      assert.ok(keys.length > 0, 'lee alguna clave');
      for (const key of keys) assert.ok(yaml.has(key), `${broker}: ${key} no está en messaging.yaml`);
      // Y lo que lee del relay con el default de keel-core.
      if (settings.includes('OutboxRelaySettings{\n')) {
        for (const parameter of Object.values(OUTBOX_RELAY)) assert.match(settings, new RegExp(`"${parameter.key.replaceAll('.', '\\.')}", ${parameter.default}\\)`), parameter.key);
      }
    }
  });
}

function flatten(node, prefix = '', into = new Map()) {
  for (const [key, value] of Object.entries(node ?? {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, full, into);
    else into.set(full, value);
  }
  return into;
}

for (const database of ['postgresql', 'mysql']) {
  test(`stock-reservation-events (${database}): outbox_event y processed_event son las tablas de keel-spring`, () => {
    const stack = { broker: 'rabbitmq', database };
    const go = goSchema(plan('stock-reservation-events', stack));
    const spring = springSchema(plan('stock-reservation-events', stack, planSpring));
    for (const table of [OUTBOX_EVENT.table, PROCESSED_EVENT.table]) {
      const want = spring.get(table);
      const got = go.get(table);
      assert.ok(want && got, `${table} en los dos`);
      assert.deepEqual([...got.names].sort(), [...want.names].sort(), `${table}: los mismos nombres`);
      assert.deepEqual([...got.columns.keys()].sort(), [...want.columns.keys()].sort(), `${table}: las mismas columnas`);
      for (const [column, spec] of want.columns) {
        if (spec.length != null) assert.equal(got.columns.get(column).length, spec.length, `${table}.${column}: la cota`);
        assert.equal(got.columns.get(column).nullable, spec.nullable, `${table}.${column}: la nulabilidad`);
      }
    }
  });
}

test('metering-digest (best-effort): processed_event sí, outbox_event no', () => {
  const go = goSchema(plan('metering-digest'));
  assert.ok(go.get(PROCESSED_EVENT.table));
  assert.equal(go.get(OUTBOX_EVENT.table), undefined);
});

test('el adaptador de repositorio entrega los eventos al puente al guardar, y solo el de la raíz que los emite', () => {
  const outbox = plan('stock-reservation-events');
  const adapter = content(outbox, 'internal/infrastructure/postgres/reservation_repository.go');
  assert.match(adapter, /func NewReservationRepository\(tx \*Transactions, events \*messaging\.Bridge\)/);
  // Se drenan ANTES de la transacción (un reintento repite el caso de uso entero, que los vuelve a emitir) y sus filas
  // van DENTRO de ella, tras escribir el agregado.
  const save = adapter.slice(adapter.indexOf('func (r *ReservationRepository) Save('));
  assert.ok(save.indexOf('PullEvents()') < save.indexOf('r.tx.write('), 'drena antes de abrir');
  assert.ok(save.indexOf('writeReservation(') < save.indexOf('r.events.Route(') && save.indexOf('r.events.Route(') < save.indexOf('appendOutbox('), 'las filas tras el agregado');

  const bestEffort = plan('metering-digest');
  const digest = content(bestEffort, 'internal/infrastructure/postgres/daily_digest_repository.go');
  assert.match(digest, /r\.tx\.afterCommit\(ctx, func\(ctx context\.Context\) \{\n\t\t\tr\.events\.Deliver\(ctx, events\)/);
  assert.doesNotMatch(digest, /appendOutbox/);
  // La raíz que no emite nada no recibe el puente.
  const meter = content(bestEffort, 'internal/infrastructure/postgres/meter_reading_repository.go');
  assert.match(meter, /func NewMeterReadingRepository\(tx \*Transactions\) \*MeterReadingRepository/);
});

test('el arranque cablea la mensajería y deja al agente un solo archivo, sin la cabecera de código generado', () => {
  const files = plan('stock-reservation-events');
  const main = content(files, 'cmd/server/main.go');
  assert.match(main, /messagingSettings, err := messaging\.SettingsFrom\(cfg\)/);
  assert.match(main, /adapters, err := brokerAdapters\(messagingSettings, logger\)/);
  assert.match(main, /messaging\.NewDispatcherFallback\(cfg\.Profiles, logger\)/);
  assert.match(main, /return relay\.Run\(groupCtx\)/);
  assert.match(main, /listeners, err := messageListeners\(inbound\{/);
  // El puente existe antes que los repositorios que lo reciben, y los listeners después de los casos de uso.
  assert.ok(main.indexOf('bridge := ') < main.indexOf('NewReservationRepository(transactions, bridge)'));
  assert.ok(main.indexOf('useCases := ') < main.indexOf('messageListeners('));
  const broker = content(files, 'cmd/server/broker.go');
  assert.ok(!broker.startsWith(GENERATED_HEADER), 'broker.go es del agente');
  assert.match(broker, /func brokerAdapters\(settings messaging\.Settings, logger \*slog\.Logger\) \(outbound, error\)/);
  assert.match(broker, /func messageListeners\(deps inbound\) \(\[\]listener, error\)/);
  assert.match(broker, /UNO POR COLA/);
  assert.ok(content(files, 'cmd/server/messaging.go').startsWith(GENERATED_HEADER), 'los tipos son de build');
  // Con Kafka, un listener por suscripción.
  assert.match(content(plan('stock-reservation-events', { broker: 'kafka' }), 'cmd/server/broker.go'), /UNO POR SUSCRIPCIÓN/);
});

test('cada mensaje de suscripción comprueba la presencia de lo obligatorio y sus cotas, y nombra al consumidor', () => {
  const files = plan('stock-reservation-events');
  const rejected = content(files, `${MESSAGING}/stock_rejected_message.go`);
  // La prosa del comentario va partida en líneas: se lee de corrido.
  const prose = rejected.replaceAll('\n// ', ' ');
  assert.match(rejected, /if m\.Reason == nil \{\n\t\treturn &ContractError\{Reason: "StockRejected: el mensaje no trae 'reason', que el contrato declara obligatorio"\}/);
  assert.match(rejected, /textLength\(\*m\.Reason\)/);
  assert.match(prose, /useCases\.ReleaseReservation\.Handle\(messaging\.Inbound\(ctx, envelope\.Metadata\), application\.ReleaseReservationCommand\{/);
  const reserved = content(files, `${MESSAGING}/stock_reserved_message.go`);
  // Sin cotas fuera de la presencia, sin acumulador.
  assert.doesNotMatch(reserved, /violations/);
});
