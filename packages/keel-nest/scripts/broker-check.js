#!/usr/bin/env node
// La mensajería de keel-nest contra un broker REAL (incremento 9c, y Kafka en el 9f): lo único que dice que la
// conexión, la topología, la publicación con confirmación, el consumo con su reintento y su descarte, el relay
// del outbox y los helpers del arnés funcionan juntos. Es el broker-check de keel-spring para este generador.
//
// Por qué no está en `npm test`: necesita red (npm instala el proyecto), podman o docker, y minutos.
//
//   node packages/keel-nest/scripts/broker-check.js [--broker=rabbitmq,kafka,snssqs] [--keep]
//   npm run broker-check --workspace packages/keel-nest
//
// El sujeto es stock-reservation: outbox, y tres suscripciones Keel de la misma fuente con reintento y descarte
// (en RabbitMQ comparten cola; en Kafka cada una tiene su consumer group sobre el mismo topic; en SNS/SQS cada
// una su cola, suscrita al topic de la fuente con filtro por eventType). Lo que en el
// proyecto escribiría el agente se escribe aquí como SONDA, registrado donde lo registraría él
// (broker-bindings.ts): un dispatcher del outbox sobre la conexión del broker y un listener cuyo comportamiento
// lo decide el eventId del mensaje. Los flujos sonda usan SOLO los helpers que el arnés emite
// (deliverStockReserved, publishedMessages, deadLetterMessages, stopBroker…), así que lo que se mide es lo que
// el agente de pruebas tendrá.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { kafkaListenerRetry, rabbitListenerRetry } from 'keel-core/gen';
import { makeWorkspace, FIXTURES_DIR } from '../test/helpers/workspace.js';
import { planService } from '../src/scaffold/index.js';
import { resolveRuntime } from './lib/database-container.js';

const SUBJECT = 'stock-reservation';
const keep = process.argv.includes('--keep');
const brokerArg = process.argv.find((arg) => arg.startsWith('--broker='));
const BROKERS = brokerArg ? brokerArg.slice('--broker='.length).split(',') : ['rabbitmq', 'kafka', 'snssqs'];
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function bashExecutable() {
  if (process.env.BASH_EXECUTABLE) return process.env.BASH_EXECUTABLE;
  if (isWindows) {
    for (const candidate of [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('broker-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };
const bash = (dir, script, args = []) => {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: dir, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const npm = (dir, args) => {
  const result = spawnSync('npm', args, { cwd: dir, encoding: 'utf8', shell: isWindows, env });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ── Lo del agente, como sonda: lo único que cambia de un broker a otro es la conexión ──
const CONNECTIONS = {
  rabbitmq: { dir: 'rabbitmq', connection: 'RabbitConnection', file: 'rabbit-connection' },
  kafka: { dir: 'kafka', connection: 'KafkaConnection', file: 'kafka-connection' },
  snssqs: { dir: 'snssqs', connection: 'SnsSqsConnection', file: 'snssqs-connection' }
};

function probes(broker, sub) {
  const rabbit = broker === 'rabbitmq';
  const { dir, connection, file: connectionFile } = CONNECTIONS[broker];
  const publishCall = {
    rabbitmq: 'this.connection.publish(destination, routingKey, payload, eventType)',
    kafka: 'this.connection.publish(destination, routingKey, payload)',
    snssqs: 'this.connection.publish(destination, payload, { eventType, routingKey })'
  }[broker];
  const dispatcher = `import { Inject, Injectable } from '@nestjs/common';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher.js';
import { ${connection} } from './${connectionFile}.js';

/** Sonda del dispatcher que escribiría el agente: la fila tal cual, con lo que su broker necesita, y espera la confirmación. */
@Injectable()
export class ProbeOutboxDispatcher extends OutboxDispatcher {
  constructor(@Inject(${connection}) private readonly connection: ${connection}) {
    super();
  }

  dispatch(destination: string, routingKey: string, eventType: string, payload: string): Promise<void> {
    return ${publishCall};
  }
}
`;
  const register = broker === 'snssqs'
    ? `this.connection.consume('${sub.name}', async (message) => {
      const envelope = EventEnvelope.parse(message.body);`
    : rabbit
    ? `const queue = this.settings.subscriptions['${sub.name}']!.queue!;
    this.connection.consume(queue, async (message) => {
      const envelope = EventEnvelope.parse(message.content.toString('utf8'));`
    : `this.connection.consume('${sub.name}', async (message) => {
      const envelope = EventEnvelope.parse(message.value);`;
  const listener = `import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { BusinessException } from '../../../domain/errors/business-exception.js';
import { EventEnvelope } from '../event-envelope.js';
import { IdempotencyGuard } from '../idempotency/idempotency-guard.js';
import { ${sub.messageRecord} } from '../subscriptions/${kebab(sub.messageRecord)}.js';
import { MESSAGING_SETTINGS, type MessagingSettings } from '../messaging-settings.js';
import { ${connection} } from './${connectionFile}.js';

/** Cuántas veces vio el listener cada eventId: las sondas lo leen para contar reintentos. */
export const ATTEMPTS = new Map<string, number>();

class ProbeRejection extends BusinessException {
  constructor() {
    super('rechazo de negocio de la sonda', { code: 'PROBE_REJECTED', httpStatus: 422 });
  }
}

/**
 * Sonda del listener que escribiría el agente. Lo que hace lo decide el eventId: 'transient-…' falla de
 * forma transitoria (se reintenta y acaba en el descarte), 'business-…' es un rechazo de negocio (descarte sin
 * reintento); el resto se procesa con IdempotencyGuard.tryRecord.
 */
@Injectable()
export class ProbeListener implements OnApplicationBootstrap {
  constructor(
    @Inject(${connection}) private readonly connection: ${connection},
    @Inject(IdempotencyGuard) private readonly guard: IdempotencyGuard,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {}

  onApplicationBootstrap(): void {
    void this.settings;
    ${register}
      // El canal lo comparten varias suscripciones: lo que no es nuestro se descarta SIN lanzar.
      if (envelope.metadata.eventType !== '${sub.name}') return;
      const eventId = envelope.metadata.eventId;
      ATTEMPTS.set(eventId, (ATTEMPTS.get(eventId) ?? 0) + 1);
      const payload = ${sub.messageRecord}.fromWire(envelope.data);
      payload.requireContract();
      if (eventId.startsWith('transient-')) throw new Error('fallo transitorio de la sonda');
      if (eventId.startsWith('business-')) throw new ProbeRejection();
      await this.guard.tryRecord('ProbeListener', eventId);
    });
  }
}
`;
  const bindings = `import type { Provider } from '@nestjs/common';
import { OutboxDispatcher } from './outbox/outbox-dispatcher.js';
import { ProbeOutboxDispatcher } from './${dir}/probe-outbox-dispatcher.js';
import { ProbeListener } from './${dir}/probe-listener.js';

export const BROKER_ADAPTERS: Provider[] = [{ provide: OutboxDispatcher, useClass: ProbeOutboxDispatcher }];
export const MESSAGE_LISTENERS: Provider[] = [ProbeListener];
`;
  return { dir, dispatcher, listener, bindings };
}

// ── Los flujos sonda: SOLO helpers del arnés (y el contador de la sonda) ──
function flows(broker, model) {
  const rabbit = broker === 'rabbitmq';
  const sub = model.subscriptions.find((candidate) => candidate.name === 'StockReserved');
  const event = model.events[0];
  const channel = model.messaging.publishChannels[0];
  const attempts = { rabbitmq: () => rabbitListenerRetry(model).attempts, kafka: () => kafkaListenerRetry(model).attempts, snssqs: () => sub.retry?.maxAttempts ?? 1 }[broker]();
  const routingKey = event.routingKeyDefault;
  const destination = model.messaging.destinationDefault;
  const orderId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  // Con Kafka el arranque tras levantar el broker suma el reparto del grupo, y con SNS/SQS la resiembra: más margen.
  const recoveryMs = rabbit ? 30_000 : 90_000;
  const envelopeOf = (eventId) =>
    JSON.stringify({
      metadata: { eventId, eventType: event.name, eventVersion: 1, occurredAt: '2026-10-07T10:00:00.000Z', source: 'stock-reservation', correlationId: null, traceparent: null },
      data: { reservationId: orderId }
    });
  const foreign = JSON.stringify({ metadata: { eventId: 'X', eventType: 'SomethingElse', eventVersion: 1, occurredAt: '2026-10-07T10:00:00.000Z', source: 'inventory', correlationId: null, traceparent: null }, data: {} });

  // Lo propio de cada broker. RabbitMQ: el tipo nativo y `mandatory` (lo que no tiene cola no se da por
  // publicado). Kafka: la clave del registro es la routing key, y el descarte lleva los headers de Spring Kafka.
  // SNS/SQS: no hay clave de mensaje (el tipo viaja como message attribute, y si no casara con el filtro la cola
  // de arnés no lo recibiría), y una fila cuyo topic no existe no se da por publicada.
  const publishedShape = {
    rabbitmq: `expect(message.routingKey).toBe('${routingKey}');
    expect(message.properties.type).toBe('${event.name}');`,
    kafka: `expect(message.routingKey).toBe('${routingKey}');`,
    snssqs: `expect(message.payload.metadata.eventType).toBe('${event.name}');`
  }[broker];
  const brokerSpecific = broker === 'snssqs'
    ? `
  it('FL-BRK-002-B: una fila cuyo topic no existe no se da por publicada (la conexión no lo crea)', async () => {
    const id = randomUUID();
    db(\`INSERT INTO outbox_event (id, destination, routing_key, event_type, payload, created_at, attempts) VALUES ('\${id}', 'keel-sin-topic', '${routingKey}', '${event.name}', '{}', now(), 0)\`);
    // Hasta que el relay la intente o la dé por publicada: lo segundo es el fallo que se mide, y tiene que decirlo.
    await eventually(() => db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND (attempts >= 1 OR published_at IS NOT NULL)\`).trim() === '1', 20_000, 'el relay no lo intentó');
    expect(db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND published_at IS NULL\`).trim(), 'se dio por publicada').toBe('1');
    db(\`DELETE FROM outbox_event WHERE id = '\${id}'\`);
  });
`
    : rabbit
    ? `
  it('FL-BRK-002-B: lo que no tiene cola (mandatory) no se da por publicado', async () => {
    const id = randomUUID();
    outboxRow(id, 'keel.sin-ruta', envelope(randomUUID()));
    // Hasta que el relay la intente o la dé por publicada: lo segundo es el fallo que se mide, y tiene que decirlo.
    await eventually(() => db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND (attempts >= 1 OR published_at IS NOT NULL)\`).trim() === '1', 20_000, 'el relay no lo intentó');
    expect(db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND published_at IS NULL\`).trim(), 'se dio por publicada').toBe('1');
    db(\`DELETE FROM outbox_event WHERE id = '\${id}'\`);
  });
`
    : '';
  const deadLetterShape = broker !== 'kafka'
    ? ''
    : `

  it('FL-BRK-001-G: el descarte conserva la clave y lleva los headers de Spring Kafka (topic de origen y excepción)', async () => {
    const id = \`business-\${randomUUID()}\`;
    deliver${sub.name}(id, ORDER);
    await eventually(() => deadLetterMessages('${sub.name}').some((m) => m.payload?.metadata?.eventId === id), 20_000, 'no llegó al descarte');
    const dead = deadLetterMessages('${sub.name}').find((m) => m.payload?.metadata?.eventId === id)!;
    expect(dead.routingKey).toBe(id);
    expect(dead.properties['kafka_dlt-original-topic']).toBe('${sub.topicDefault}');
    expect(dead.properties['kafka_dlt-exception-message']).toBe('rechazo de negocio de la sonda');
  });`;

  return `import { randomUUID } from 'node:crypto';
import {
  abandonOutboxEvent,
  clearAbandonedOutboxEvents,
  db,
  deadLetterMessages,
  deadLetteredEvents,
  deliverMessage,
  deliver${sub.name},
  eventually,
  publishedMessages,
  purgeMessages,
  startBroker,
  stopBroker,
  useFlow
} from './support/flow.js';
import { ATTEMPTS } from '../../src/infrastructure/messaging/${CONNECTIONS[broker].dir}/probe-listener.js';

const ORDER = ${JSON.stringify(JSON.stringify({ orderId }))};
const processed = (eventId: string) => Number(db(\`SELECT COUNT(*) FROM processed_event WHERE handler_id = 'ProbeListener' AND event_id = '\${eventId}'\`).trim());
const outboxRow = (id: string, routingKey: string, payload: string) =>
  db(\`INSERT INTO outbox_event (id, destination, routing_key, event_type, payload, created_at, attempts) VALUES ('\${id}', '${destination}', '\${routingKey}', '${event.name}', '\${payload.replaceAll("'", "''")}', now(), 0)\`);
const envelope = (eventId: string) => ${JSON.stringify(envelopeOf('EVENT_ID'))}.replace('EVENT_ID', eventId);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FL-BRK-001 · consumo', () => {
  useFlow();

  it('FL-BRK-001-A: una entrega llega al listener y se procesa una vez', async () => {
    const id = randomUUID();
    deliver${sub.name}(id, ORDER);
    await eventually(() => processed(id) === 1, 20_000, 'el listener no procesó el mensaje');
    expect(ATTEMPTS.get(id)).toBe(1);
  });

  it('FL-BRK-001-B: la reentrega del mismo messageId no se procesa dos veces ni va al descarte', async () => {
    const id = randomUUID();
    deliver${sub.name}(id, ORDER);
    await eventually(() => processed(id) === 1, 20_000);
    deliver${sub.name}(id, ORDER);
    await eventually(() => ATTEMPTS.get(id) === 2, 20_000, 'la reentrega no llegó');
    expect(processed(id)).toBe(1);
    expect(deadLetterMessages('${sub.name}')).toHaveLength(0);
  });

  it('FL-BRK-001-C: un fallo transitorio se reintenta ${attempts} veces y acaba en el descarte', async () => {
    const id = \`transient-\${randomUUID()}\`;
    deliver${sub.name}(id, ORDER);
    await eventually(() => deadLetterMessages('${sub.name}').some((m) => m.payload?.metadata?.eventId === id), 60_000, 'no llegó al descarte');
    expect(ATTEMPTS.get(id)).toBe(${attempts});
  });

  it('FL-BRK-001-D: un rechazo de negocio va al descarte SIN reintento', async () => {
    const id = \`business-\${randomUUID()}\`;
    deliver${sub.name}(id, ORDER);
    await eventually(() => deadLetterMessages('${sub.name}').some((m) => m.payload?.metadata?.eventId === id), 20_000, 'no llegó al descarte');
    expect(ATTEMPTS.get(id)).toBe(1);
  });

  it('FL-BRK-001-E: un payload que incumple el contrato va al descarte sin reintento', async () => {
    const id = randomUUID();
    deliver${sub.name}(id, '{}');
    await eventually(() => deadLetterMessages('${sub.name}').some((m) => m.payload?.metadata?.eventId === id), 20_000, 'no llegó al descarte');
    expect(ATTEMPTS.get(id)).toBe(1);
    expect(processed(id)).toBe(0);
  });

  it('FL-BRK-001-F: un evento ajeno del canal compartido se confirma sin efecto y sin descarte', async () => {
    await purgeMessages('${sub.name}');
    const before = deadLetterMessages('${sub.name}').length;
    const id = randomUUID();
    deliverMessage('${sub.topicDefault}', id, ${JSON.stringify(foreign)}.replace('"X"', JSON.stringify(id)));
    await pause(1500);
    expect(ATTEMPTS.has(id)).toBe(false);
    expect(deadLetterMessages('${sub.name}')).toHaveLength(before);
  });${deadLetterShape}
});

describe('FL-BRK-002 · publicación por el outbox', () => {
  useFlow();

  it('FL-BRK-002-A: una fila del outbox sale al canal con su envoltura y queda publicada', async () => {
    const id = randomUUID();
    const eventId = randomUUID();
    outboxRow(id, '${routingKey}', envelope(eventId));
    await eventually(async () => (await publishedMessages('${channel}')).some((m) => m.payload?.metadata?.eventId === eventId), 20_000, 'no se publicó');
    const message = (await publishedMessages('${channel}')).find((m) => m.payload?.metadata?.eventId === eventId)!;
    ${publishedShape}
    expect(db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND published_at IS NOT NULL\`).trim()).toBe('1');
  });
${brokerSpecific}
  it('FL-BRK-002-C: con el broker caído la fila espera, y sale al volver sin rendirse', async () => {
    await stopBroker();
    const eventId = randomUUID();
    outboxRow(randomUUID(), '${routingKey}', envelope(eventId));
    await pause(3000);
    expect(await publishedMessages('${channel}')).toHaveLength(0);
    await startBroker();
    await eventually(async () => (await publishedMessages('${channel}')).some((m) => m.payload?.metadata?.eventId === eventId), ${recoveryMs}, 'no salió tras levantar el broker');
    expect(await deadLetteredEvents()).toBe(0);
  });

  it('FL-BRK-002-D: un evento abandonado no se publica y se cuenta como rendido', async () => {
    await purgeMessages('${channel}');
    await stopBroker();
    const eventId = randomUUID();
    outboxRow(randomUUID(), '${routingKey}', envelope(eventId));
    await abandonOutboxEvent('${event.name}');
    await startBroker();
    await pause(3000);
    expect((await publishedMessages('${channel}')).some((m) => m.payload?.metadata?.eventId === eventId)).toBe(false);
    expect(await deadLetteredEvents()).toBe(1);
    clearAbandonedOutboxEvents();
    expect(await deadLetteredEvents()).toBe(0);
  });

  it('FL-BRK-002-E: purgeMessages vacía el canal', async () => {
    outboxRow(randomUUID(), '${routingKey}', envelope(randomUUID()));
    await eventually(async () => (await publishedMessages('${channel}')).length > 0, 20_000);
    await purgeMessages('${channel}');
    expect(await publishedMessages('${channel}')).toHaveLength(0);
  });
});
`;
}

function checkBroker(broker) {
  const label = { rabbitmq: 'RabbitMQ', kafka: 'Kafka', snssqs: 'SNS/SQS' }[broker];
  console.log(`\n── ${label} ──`);
  // ── El proyecto: lo que build emite para el sujeto con el broker y PostgreSQL ──
  const workspace = makeWorkspace(`keel-nest-broker-check-${broker}-`);
  const projectDir = path.join(workspace, 'services', `${SUBJECT}-nest`);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  const { files, model } = planService({ manifest, layers, workspace, stack: { database: 'postgresql', broker } });
  for (const file of files) {
    const out = path.join(projectDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  step(`${label}: el proyecto se genera`, files.length > 0, `${files.length} archivos`);
  const install = npm(projectDir, ['install', '--no-audit', '--no-fund']);
  if (!step(`${label}: npm install`, install.ok)) {
    console.error(install.output.slice(-2000));
    return;
  }

  const sub = model.subscriptions.find((candidate) => candidate.name === 'StockReserved');
  const probe = probes(broker, sub);
  fs.writeFileSync(path.join(projectDir, `src/infrastructure/messaging/${probe.dir}/probe-outbox-dispatcher.ts`), probe.dispatcher);
  fs.writeFileSync(path.join(projectDir, `src/infrastructure/messaging/${probe.dir}/probe-listener.ts`), probe.listener);
  fs.writeFileSync(path.join(projectDir, 'src/infrastructure/messaging/broker-bindings.ts'), probe.bindings);
  const typecheck = npm(projectDir, ['run', 'typecheck']);
  if (!step(`${label}: el proyecto con las sondas compila con strict`, typecheck.ok, typecheck.ok ? '' : typecheck.output.slice(-1500))) return;
  fs.writeFileSync(path.join(projectDir, 'test/integration/broker-probe.test.ts'), flows(broker, model));

  // ── La infraestructura, con sus propios scripts, y los flujos ──
  const up = bash(projectDir, 'infra/up.sh');
  if (!step(`${label}: bash infra/up.sh`, up.status === 0, up.status === 0 ? '' : up.output.slice(-1500))) return;
  try {
    // La topología de SNS/SQS no la crea la aplicación: la siembra init-messaging.sh, que en una corrida ejecuta el
    // agente de infraestructura.
    if (fs.existsSync(path.join(projectDir, 'infra', 'init-messaging.sh'))) {
      const seed = bash(projectDir, 'infra/init-messaging.sh');
      step(`${label}: bash infra/init-messaging.sh`, seed.status === 0, seed.status === 0 ? '' : seed.output.slice(-1500));
    }
    const validate = bash(projectDir, 'infra/validate-infra.sh');
    step(`${label}: bash infra/validate-infra.sh (el broker incluido)`, validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1500));
    const vitest = path.join(projectDir, 'node_modules', 'vitest', 'vitest.mjs');
    const smoke = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.integration.config.ts', 'test/integration/harness-smoke.test.ts'], { cwd: projectDir, encoding: 'utf8', env });
    step(`${label}: el humo del arnés pasa con la mensajería`, smoke.status === 0, smoke.status === 0 ? '' : `${smoke.stdout}${smoke.stderr}`.slice(-2000));
    const probesRun = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.integration.config.ts', 'test/integration/broker-probe.test.ts'], { cwd: projectDir, encoding: 'utf8', env, timeout: 1_200_000 });
    const junit = path.join(projectDir, 'build', 'test-results', 'integration', 'junit.xml');
    const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
    const cases = [...xml.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
    if (cases.length === 0) step(`${label}: los flujos sonda se ejecutan`, false, `${probesRun.stdout}${probesRun.stderr}`.slice(-3000));
    for (const match of cases) {
      // <error> también es rojo: Vitest pone ahí los errores sin manejar (un rechazo, un process.exit), que no
      // son de ningún caso y que en el servidor real tumbarían el proceso.
      const failure = /<(?:failure|error)[^>]*message="([^"]*)"/.exec(match[3] ?? '')?.[1];
      const skipped = /<skipped/.test(match[3] ?? '');
      step(
        `${label}: ${match[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'")}`,
        !failure && !skipped,
        failure ? failure.replace(/&quot;/g, '"').slice(0, 400) : skipped ? 'omitido' : ''
      );
    }
  } finally {
    const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
    step(`${label}: bash infra/down.sh --volumes`, down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
    if (keep) {
      const kept = fs.mkdtempSync(path.join(os.tmpdir(), `keel-nest-broker-kept-${broker}-`));
      fs.cpSync(projectDir, kept, { recursive: true, filter: (source) => !source.includes('node_modules') });
      console.log(`Proyecto conservado en ${kept}`);
    }
  }
}

for (const broker of BROKERS) checkBroker(broker);

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nbroker-check: ${results.length}/${results.length} en verde.` : `\nbroker-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
