// El manual de operación del proyecto generado (`docs/keel/operations.md`): cada fila sale de la misma fuente que el
// código que describe, así que no puede nombrar una variable, una cola o una alerta que el servidor no tiene.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { resolveStack } from '../src/lib/gen/stack.js';
import { OPERATIONS_MANUAL_FILE, operationsManual } from '../src/lib/gen/operations-manual.js';
import { alertRules } from '../src/lib/gen/observability-assets.js';
import { OUTBOX_RELAY } from '../src/lib/gen/messaging-stores.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

/** Una plataforma de observabilidad de mentira: solo lo que leen las alertas. */
const PLATFORM = {
  generator: 'probe',
  outbox: (model) => model.messaging?.reliability === 'outbox',
  runtime: { heap: { used: 'heap_used', max: 'heap_max', summary: 'El heap del doble.' }, pool: () => ({ saturation: 'pool_wait', label: 'doble' }) }
};

function modelOf(name, choices = {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES, name));
  const stack = resolveStack({ ...STACK_DEFAULTS, ...choices }, layers);
  const model = buildModel({ manifest, layers, stack, projection: PROBE });
  model.stack = stack;
  return model;
}

const manualOf = (name, choices) => operationsManual(modelOf(name, choices), PLATFORM).content;
const section = (text, title) => text.split(/\n(?=## )/).find((part) => part.startsWith(`## ${title}`)) ?? null;

test('va a docs/keel/ y solo lleva las secciones cuyo subsistema existe', () => {
  const file = operationsManual(modelOf('product-catalog'), PLATFORM);
  assert.equal(file.path, OPERATIONS_MANUAL_FILE);
  assert.ok(section(file.content, 'Stack'));
  for (const absent of ['Mensajería', 'Reconciliación', 'Alertas', 'Parámetros del servicio']) {
    assert.equal(section(file.content, absent), null, absent);
  }
});

test('la cola de descarte es la del broker elegido, la misma que crea la topología', () => {
  assert.match(manualOf('notification-mailer', { broker: 'rabbitmq' }), /`notification-mailer\.any-registered-system-dlq` \| 5 \|/);
  assert.match(manualOf('notification-mailer', { broker: 'kafka' }), /`any-registered-system\.events\.DLT` \| 5 \|/);
});

test('el outbox lleva cada variable del relay con su default y el de local', () => {
  const outbox = section(manualOf('notification-mailer'), 'Mensajería');
  for (const parameter of Object.values(OUTBOX_RELAY)) assert.ok(outbox.includes(`\`${parameter.env}\``), parameter.env);
  assert.match(outbox, /`OUTBOX_RELAY_MAX_ATTEMPTS` \| `10` \(en local, `40`\) \|/);
});

test('parámetros, plazos y reconciliación salen del diseño', () => {
  const codes = manualOf('verification-codes');
  assert.match(codes, /\| codeTtlMinutes \| `VERIFICATION_CODES_CODE_TTL_MINUTES` \| `10` \| no \|/);
  assert.match(codes, /\| VerificationCode: pending → expired \| el parámetro codeTtlMinutes \(minutes\), desde issuedAt \| expireCode \|/);
  assert.match(manualOf('catalog-extended'), /\| recordWithdrawal \| compliance \| 3600 s \| reconcileWithdrawals \|/);
});

test('con telemetría, una fila por alerta provisionada y ninguna más; sin ella, ninguna', () => {
  for (const name of ['notification-mailer', 'verification-codes', 'catalog-extended']) {
    const model = modelOf(name, { telemetry: 'otel' });
    const alerts = section(operationsManual(model, PLATFORM).content, 'Alertas');
    const rows = alerts.split('\n').filter((line) => /^\| (?!Alerta|---)/.test(line)).map((line) => line.split(' | ')[0].slice(2));
    assert.deepEqual(rows, alertRules(model, PLATFORM).map((rule) => rule.title), name);
    assert.equal(section(manualOf(name), 'Alertas'), null, name);
  }
});

test('la identidad solo aparece con un proveedor que hay que sembrar', () => {
  assert.match(section(manualOf('notification-mailer'), 'Identidad'), /`bash infra\/init-keycloak\.sh`/);
  assert.equal(section(manualOf('catalog-extended'), 'Identidad'), null);
});

test('es determinista en todas las fixtures', () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    if (!fs.existsSync(path.join(FIXTURES, name, 'service.keel.yaml'))) continue;
    assert.equal(manualOf(name, { telemetry: 'otel' }), manualOf(name, { telemetry: 'otel' }), name);
  }
});
