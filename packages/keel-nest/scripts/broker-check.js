#!/usr/bin/env node
// La mensajería de keel-nest contra un RabbitMQ REAL (incremento 9c): lo único que dice que la conexión,
// la topología, la publicación con confirmación, el consumo con su reintento y su DLQ, el relay del outbox
// y los helpers del arnés funcionan juntos. Es el broker-check de keel-spring para este generador.
//
// Por qué no está en `npm test`: necesita red (npm instala el proyecto), podman o docker, y minutos.
//
//   node packages/keel-nest/scripts/broker-check.js [--keep]
//   npm run broker-check --workspace packages/keel-nest
//
// El sujeto es stock-reservation con RabbitMQ: outbox, y tres suscripciones Keel que comparten cola con
// reintento y DLQ. Lo que en el proyecto escribiría el agente se escribe aquí como SONDA, registrado donde
// lo registraría él (broker-bindings.ts): un dispatcher del outbox sobre RabbitConnection.publish y un
// listener sobre RabbitConnection.consume cuyo comportamiento lo decide el eventId del mensaje. Los flujos
// sonda usan SOLO los helpers que el arnés emite (deliverStockReserved, publishedMessages,
// deadLetterMessages, stopBroker…), así que lo que se mide es lo que el agente de pruebas tendrá.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { makeWorkspace, FIXTURES_DIR } from '../test/helpers/workspace.js';
import { planService } from '../src/scaffold/index.js';
import { resolveRuntime } from './lib/database-container.js';

const SUBJECT = 'stock-reservation';
const keep = process.argv.includes('--keep');
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

// ── El proyecto: lo que build emite para el sujeto con RabbitMQ y PostgreSQL ──
const workspace = makeWorkspace('keel-nest-broker-check-');
const projectDir = path.join(workspace, 'services', `${SUBJECT}-nest`);
const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
const { files, model } = planService({ manifest, layers, workspace, stack: { database: 'postgresql', broker: 'rabbitmq' } });
for (const file of files) {
  const out = path.join(projectDir, file.path);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, file.content);
}
step('el proyecto se genera', files.length > 0, `${files.length} archivos`);
const install = npm(projectDir, ['install', '--no-audit', '--no-fund']);
if (!step('npm install', install.ok)) {
  console.error(install.output.slice(-2000));
  process.exit(1);
}

// ── Lo del agente, como sonda ──
const sub = model.subscriptions.find((candidate) => candidate.name === 'StockReserved');
const event = model.events[0];
const channel = model.messaging.publishChannels[0];
fs.writeFileSync(
  path.join(projectDir, 'src/infrastructure/messaging/rabbitmq/probe-outbox-dispatcher.ts'),
  `import { Inject, Injectable } from '@nestjs/common';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher.js';
import { RabbitConnection } from './rabbit-connection.js';

/** Sonda del dispatcher que escribiría el agente: la fila tal cual, con su tipo, y espera la confirmación. */
@Injectable()
export class ProbeOutboxDispatcher extends OutboxDispatcher {
  constructor(@Inject(RabbitConnection) private readonly connection: RabbitConnection) {
    super();
  }

  dispatch(destination: string, routingKey: string, eventType: string, payload: string): Promise<void> {
    return this.connection.publish(destination, routingKey, payload, eventType);
  }
}
`
);
fs.writeFileSync(
  path.join(projectDir, 'src/infrastructure/messaging/rabbitmq/probe-listener.ts'),
  `import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { BusinessException } from '../../../domain/errors/business-exception.js';
import { EventEnvelope } from '../event-envelope.js';
import { IdempotencyGuard } from '../idempotency/idempotency-guard.js';
import { ${sub.messageRecord} } from '../subscriptions/${sub.messageRecord.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.js';
import { MESSAGING_SETTINGS, type MessagingSettings } from '../messaging-settings.js';
import { RabbitConnection } from './rabbit-connection.js';

/** Cuántas veces vio el listener cada eventId: las sondas lo leen para contar reintentos. */
export const ATTEMPTS = new Map<string, number>();

class ProbeRejection extends BusinessException {
  constructor() {
    super('rechazo de negocio de la sonda', { code: 'PROBE_REJECTED', httpStatus: 422 });
  }
}

/**
 * Sonda del listener que escribiría el agente. Lo que hace lo decide el eventId: 'transient-…' falla de
 * forma transitoria (se reintenta y acaba en la DLQ), 'business-…' es un rechazo de negocio (DLQ sin
 * reintento); el resto se procesa con IdempotencyGuard.tryRecord.
 */
@Injectable()
export class ProbeListener implements OnApplicationBootstrap {
  constructor(
    @Inject(RabbitConnection) private readonly connection: RabbitConnection,
    @Inject(IdempotencyGuard) private readonly guard: IdempotencyGuard,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {}

  onApplicationBootstrap(): void {
    const queue = this.settings.subscriptions['${sub.name}']!.queue!;
    this.connection.consume(queue, async (message) => {
      const envelope = EventEnvelope.parse(message.content.toString('utf8'));
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
`
);
fs.writeFileSync(
  path.join(projectDir, 'src/infrastructure/messaging/broker-bindings.ts'),
  `import type { Provider } from '@nestjs/common';
import { OutboxDispatcher } from './outbox/outbox-dispatcher.js';
import { ProbeOutboxDispatcher } from './rabbitmq/probe-outbox-dispatcher.js';
import { ProbeListener } from './rabbitmq/probe-listener.js';

export const BROKER_ADAPTERS: Provider[] = [{ provide: OutboxDispatcher, useClass: ProbeOutboxDispatcher }];
export const MESSAGE_LISTENERS: Provider[] = [ProbeListener];
`
);
const typecheck = npm(projectDir, ['run', 'typecheck']);
if (!step('el proyecto con las sondas compila con strict', typecheck.ok, typecheck.ok ? '' : typecheck.output.slice(-1500))) process.exit(1);

// ── Los flujos sonda: SOLO helpers del arnés (y el contador de la sonda) ──
const retry = sub.retry;
const routingKey = event.routingKeyDefault;
const destination = model.messaging.destinationDefault;
const orderId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const envelopeOf = (eventId) =>
  JSON.stringify({
    metadata: { eventId, eventType: event.name, eventVersion: 1, occurredAt: '2026-10-07T10:00:00.000Z', source: 'stock-reservation', correlationId: null, traceparent: null },
    data: { reservationId: orderId }
  });
fs.writeFileSync(
  path.join(projectDir, 'test/integration/broker-probe.test.ts'),
  `import { randomUUID } from 'node:crypto';
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
import { ATTEMPTS } from '../../src/infrastructure/messaging/rabbitmq/probe-listener.js';

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

  it('FL-BRK-001-C: un fallo transitorio se reintenta ${retry.maxAttempts} veces y acaba en el descarte', async () => {
    const id = \`transient-\${randomUUID()}\`;
    deliver${sub.name}(id, ORDER);
    await eventually(() => deadLetterMessages('${sub.name}').some((m) => m.payload?.metadata?.eventId === id), 60_000, 'no llegó al descarte');
    expect(ATTEMPTS.get(id)).toBe(${retry.maxAttempts});
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
    deliverMessage('${sub.topicDefault}', id, ${JSON.stringify(JSON.stringify({ metadata: { eventId: 'X', eventType: 'SomethingElse', eventVersion: 1, occurredAt: '2026-10-07T10:00:00.000Z', source: 'inventory', correlationId: null, traceparent: null }, data: {} }))}.replace('"X"', JSON.stringify(id)));
    await pause(1500);
    expect(ATTEMPTS.has(id)).toBe(false);
    expect(deadLetterMessages('${sub.name}')).toHaveLength(before);
  });
});

describe('FL-BRK-002 · publicación por el outbox', () => {
  useFlow();

  it('FL-BRK-002-A: una fila del outbox sale al canal con su envoltura y queda publicada', async () => {
    const id = randomUUID();
    const eventId = randomUUID();
    outboxRow(id, '${routingKey}', envelope(eventId));
    await eventually(async () => (await publishedMessages('${channel}')).some((m) => m.payload?.metadata?.eventId === eventId), 20_000, 'no se publicó');
    const message = (await publishedMessages('${channel}')).find((m) => m.payload?.metadata?.eventId === eventId)!;
    expect(message.routingKey).toBe('${routingKey}');
    expect(message.properties.type).toBe('${event.name}');
    expect(db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND published_at IS NOT NULL\`).trim()).toBe('1');
  });

  it('FL-BRK-002-B: lo que no tiene cola (mandatory) no se da por publicado', async () => {
    const id = randomUUID();
    outboxRow(id, 'keel.sin-ruta', envelope(randomUUID()));
    await eventually(() => Number(db(\`SELECT attempts FROM outbox_event WHERE id = '\${id}'\`).trim()) >= 1, 20_000, 'el relay no lo intentó');
    expect(db(\`SELECT COUNT(*) FROM outbox_event WHERE id = '\${id}' AND published_at IS NULL\`).trim()).toBe('1');
    db(\`DELETE FROM outbox_event WHERE id = '\${id}'\`);
  });

  it('FL-BRK-002-C: con el broker caído la fila espera, y sale al volver sin rendirse', async () => {
    await stopBroker();
    const eventId = randomUUID();
    outboxRow(randomUUID(), '${routingKey}', envelope(eventId));
    await pause(3000);
    expect(await publishedMessages('${channel}')).toHaveLength(0);
    await startBroker();
    await eventually(async () => (await publishedMessages('${channel}')).some((m) => m.payload?.metadata?.eventId === eventId), 30_000, 'no salió tras levantar el broker');
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
`
);

// ── La infraestructura, con sus propios scripts, y los flujos ──
const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1500))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh (RabbitMQ incluido)', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1500));
  const vitest = path.join(projectDir, 'node_modules', 'vitest', 'vitest.mjs');
  const smoke = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.integration.config.ts', 'test/integration/harness-smoke.test.ts'], { cwd: projectDir, encoding: 'utf8', env });
  step('el humo del arnés pasa con la mensajería', smoke.status === 0, smoke.status === 0 ? '' : `${smoke.stdout}${smoke.stderr}`.slice(-2000));
  const probes = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.integration.config.ts', 'test/integration/broker-probe.test.ts'], { cwd: projectDir, encoding: 'utf8', env, timeout: 900_000 });
  const junit = path.join(projectDir, 'build', 'test-results', 'integration', 'junit.xml');
  const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
  const cases = [...xml.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
  if (cases.length === 0) step('los flujos sonda se ejecutan', false, `${probes.stdout}${probes.stderr}`.slice(-3000));
  for (const match of cases) {
    // <error> también es rojo: Vitest pone ahí los errores sin manejar (un rechazo, un process.exit), que no
    // son de ningún caso y que en el servidor real tumbarían el proceso.
    const failure = /<(?:failure|error)[^>]*message="([^"]*)"/.exec(match[3] ?? '')?.[1];
    const skipped = /<skipped/.test(match[3] ?? '');
    step(match[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'"), !failure && !skipped, failure ? failure.replace(/&quot;/g, '"').slice(0, 400) : skipped ? 'omitido' : '');
  }
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-broker-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true, filter: (source) => !source.includes('node_modules') });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nbroker-check: ${results.length}/${results.length} en verde.` : `\nbroker-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
