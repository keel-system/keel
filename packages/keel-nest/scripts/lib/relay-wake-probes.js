// El relay del outbox por réplica (DSL 2.26, inc. 9), EJECUTADO contra el motor real por db-check y doc-check: los casos
// RW de keel-core/gen/timer-plan.js (`RELAY_WAKE_CASES`), los mismos que mide `store-check` en keel-spring
// (src/lib/relay-wake-probes.js). El relay EMITIDO arranca de verdad (onApplicationBootstrap) con el sondeo de respaldo a
// 600 s, el bridge EMITIDO escribe la fila en la transacción del caso de uso y el dispatcher es un doble que apunta cada
// intento: todo lo que salga antes de 600 s lo ha hecho salir un despertar o un reintento.

import { RELAY_SABOTAGES, RELAY_WAKE_CASES } from '@keel-system/keel-core/gen/timer-plan';
import { OUTBOX_WAKE_LINE } from '../../src/scaffold/messaging.js';

export const PROBE_POLL_MS = 600000;
export const PROBE_BACKOFF_MS = 300;
export const PROBE_WAIT_MS = 5000;

/**
 * Los sabotajes, sobre lo emitido y conservando la compilación (noUnusedLocals): el bridge que ya no despierta al relay
 * (cae RW-1) y el relay que olvida el reintento que programó (cae RW-3).
 */
export const RELAY_WAKE_SABOTAGES = Object.freeze({
  'relay-no-wake': {
    spec: ['-domain-event-bridge.ts', OUTBOX_WAKE_LINE, 'await this.transactions.afterCommit(() => void this.appended);'],
    breaks: RELAY_SABOTAGES['relay-no-wake']
  },
  'relay-no-retry': {
    spec: ['outbox-relay.ts', 'this.pendingRetryMs = Math.min(remembered, retryAtMs);', 'this.pendingRetryMs = Number.MAX_SAFE_INTEGER + 0 * Math.min(remembered, retryAtMs);'],
    breaks: RELAY_SABOTAGES['relay-no-retry']
  }
});

export const isRelayWakeSabotage = (id) => Boolean(id && RELAY_WAKE_SABOTAGES[id]);

/** El veredicto: los casos RW que cayeron (`RW-<n>: …`) contra los esperados, y que no cayera nada más. */
export function relayWakeSabotageVerdict(checks, id) {
  const failed = [...new Set(checks.filter((check) => !check.ok).map((check) => /^(RW-\d+):/.exec(check.name)?.[1] ?? check.name))].sort();
  const want = [...RELAY_WAKE_SABOTAGES[id].breaks].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

/**
 * El bloque, para pegar DESPUÉS de las comprobaciones del bridge: usa `Bridge`, `DomainEventClass` y `messagingSettings`
 * ya importados allí, y `tx`. `paths` son los dist del relay, de la señal y del almacén; `handle` es la expresión del
 * DataSource o del MongoClient (el relay no arranca sin base); `clear` vacía el outbox; `newEvent` construye un evento.
 */
export function relayWakeBlock({ paths, handle, clear, newEvent }) {
  const [rw1, rw2, rw3] = RELAY_WAKE_CASES;
  return `
  // ── El relay por réplica (DSL 2.26, inc. 9): RW-1 a RW-3 con el relay EMITIDO en marcha.
  {
    const { OutboxRelay } = await import('${paths.relay}');
    const { OutboxAppendedSignal } = await import('${paths.signal}');
    const { OutboxRelayStore: WakeStore } = await import('${paths.store}');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const intentos = [];
    let fallan = 0;
    const dispatcher = {
      dispatch: async (destination, routingKey, eventType) => {
        intentos.push({ eventType, at: Date.now() });
        if (fallan > 0) {
          fallan -= 1;
          throw new Error('el broker no contesta');
        }
      }
    };
    const wakeSettings = {
      ...messagingSettings({ get: () => undefined }),
      outboxRelay: { enabled: true, pollMs: ${PROBE_POLL_MS}, batchSize: 3, maxAttempts: 5, backoffInitialMs: ${PROBE_BACKOFF_MS}, backoffMaxMs: ${PROBE_BACKOFF_MS}, claimTimeoutMs: 60000 }
    };
    const signal = new OutboxAppendedSignal();
    ${clear}
    const wakeRelay = new OutboxRelay(new WakeStore(tx), dispatcher, wakeSettings, ${handle}, signal);
    const wakeBridge = new Bridge(tx, wakeSettings, signal);
    const espera = async (n) => {
      const limite = Date.now() + ${PROBE_WAIT_MS};
      while (Date.now() < limite && intentos.length < n) await sleep(20);
      return [...intentos];
    };
    wakeRelay.onApplicationBootstrap();
    try {
      await sleep(300);
      intentos.length = 0;
      const antes = Date.now();
      await tx.inTransaction(() => wakeBridge.publish([${newEvent}]));
      const vistos1 = await espera(1);
      check(${JSON.stringify(`${rw1.id}: ${rw1.what}`)}, vistos1.length >= 1, vistos1.length ? \`a los \${vistos1[0].at - antes} ms del commit\` : 'no salió en ${PROBE_WAIT_MS} ms: espera al sondeo de respaldo');

      await sleep(500);
      const pasadas = wakeRelay.passes();
      await sleep(3000);
      check(${JSON.stringify(`${rw2.id}: ${rw2.what}`)}, wakeRelay.passes() === pasadas, \`\${wakeRelay.passes() - pasadas} pasadas en reposo\`);

      ${clear}
      intentos.length = 0;
      fallan = 1;
      await tx.inTransaction(() => wakeBridge.publish([${newEvent}]));
      // El primer intento lo despierta el caso: RW-3 mide el reintento, y así el sabotaje del despertar no lo tumba.
      wakeRelay.wake();
      const vistos3 = await espera(2);
      const separacion = vistos3.length === 2 ? vistos3[1].at - vistos3[0].at : null;
      check(${JSON.stringify(`${rw3.id}: ${rw3.what}`)}, vistos3.length === 2 && separacion >= ${PROBE_BACKOFF_MS - 50}, separacion == null ? \`\${vistos3.length} intentos en ${PROBE_WAIT_MS} ms\` : \`reintento a los \${separacion} ms\`);
    } finally {
      await wakeRelay.beforeApplicationShutdown();
    }
  }`;
}
