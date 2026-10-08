// La segunda réplica del arnés (preparación de la corrida 11e): `startReplica`, `stopReplica` y `onReplica`,
// con los mismos nombres que el AbstractFlowIT de keel-spring, para los escenarios de clúster (FL-CLU-*). Se
// emite con las mismas condiciones que allí —outbox, barrido por reloj o registro de idempotencia— y el flujo
// la para al cerrar: una réplica viva seguiría publicando y barriendo en el flujo siguiente.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/emitted.js';
import { FLOW_SUPPORT_TS } from '../src/scaffold/integration-tests.js';

const flowOf = (name, options = {}) => planFixture(name, options).files.find((file) => file.path === FLOW_SUPPORT_TS).content;

test('stock-reservation: el arnés arranca, para y apunta a una segunda réplica, y el flujo la para al cerrar', () => {
  const flow = flowOf('stock-reservation', { stack: { database: 'postgresql', broker: 'rabbitmq' } });
  assert.match(flow, /export async function startReplica\(\): Promise<string>/);
  assert.match(flow, /export async function stopReplica\(\): Promise<void>/);
  assert.match(flow, /export function onReplica\(method: string, route: string, body\?: unknown, headers\?: Headers\): Promise<Response>/);
  // La réplica es un servidor más, arrancado igual que el del flujo (startServer), con su propio puerto.
  assert.match(flow, /replica = await startServer\(\);/);
  // La red: afterAll la para ANTES de cerrar el servidor del flujo.
  assert.match(flow, /afterAll\(async \(\) => \{\s*\/\/[^\n]*\n\s*await stopReplica\(\);\s*await app\?\.close\(\);/);
});

test('sin outbox, barrido ni registro de idempotencia no hay réplica que arrancar', () => {
  // profile-directory: API con seguridad, sin mensajería, sin reloj y sin idempotencia de petición.
  const flow = flowOf('profile-directory');
  assert.doesNotMatch(flow, /startReplica|stopReplica|onReplica/);
});
