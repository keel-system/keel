// El MANUAL DE OPERACIÓN (`docs/keel/operations.md`, keel-core/gen/operations-manual.js) en los cuatro generadores: el
// mismo documento byte a byte para el mismo diseño y el mismo stack, salvo las alertas, que dependen de la plataforma
// (pool, outbox, retraso del consumidor) y tienen que ser exactamente las que provisiona el Grafana de cada uno.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { OPERATIONS_MANUAL_FILE } from '@keel-system/keel-core/gen/operations-manual';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planGo } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';

const GENERATORS = { spring: planSpring, nest: planNest, dotnet: planDotnet, go: planGo };

const CASES = [
  { fixture: 'notification-mailer', stack: { broker: 'rabbitmq' } },
  { fixture: 'notification-mailer', stack: { broker: 'kafka', telemetry: 'otel' } },
  { fixture: 'verification-codes', stack: { telemetry: 'otel' } },
  { fixture: 'catalog-extended', stack: { broker: 'snssqs' } }
];

function emitted(generator, { fixture, stack }) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const { files } = generator({ manifest, layers, workspace: FIXTURES_DIR, stack });
  const manual = files.find((file) => file.path === OPERATIONS_MANUAL_FILE);
  assert.ok(manual, `no se emitió ${OPERATIONS_MANUAL_FILE}`);
  return { manual: manual.content, files };
}

const withoutAlerts = (text) => text.replace(/\n## Alertas\n[\s\S]*?(?=\n## |$)/, '');
const alertTitles = (text) =>
  (text.match(/\n## Alertas\n[\s\S]*?(?=\n## |$)/)?.[0] ?? '')
    .split('\n')
    .filter((line) => /^\| (?!Alerta|---)/.test(line))
    .map((line) => line.split(' | ')[0].slice(2));

for (const scenario of CASES) {
  const label = `${scenario.fixture} con ${JSON.stringify(scenario.stack)}`;

  test(`el manual de operación es el mismo en los cuatro, salvo las alertas: ${label}`, () => {
    const manuals = Object.fromEntries(Object.entries(GENERATORS).map(([name, plan]) => [name, emitted(plan, scenario).manual]));
    for (const name of ['nest', 'dotnet', 'go']) {
      assert.equal(withoutAlerts(manuals[name]), withoutAlerts(manuals.spring), `${name} frente a spring`);
    }
  });

  test(`cada alerta del manual es una que el generador provisiona, y no falta ninguna: ${label}`, () => {
    for (const [name, plan] of Object.entries(GENERATORS)) {
      const { manual, files } = emitted(plan, scenario);
      const titles = alertTitles(manual);
      if (scenario.stack.telemetry !== 'otel') {
        assert.deepEqual(titles, [], name);
        continue;
      }
      const provisioned = files.find((file) => /alerting|alert-rules/.test(file.path) && file.path.endsWith('.yaml'));
      assert.ok(provisioned, `${name}: no se encontró el archivo de alertas provisionado`);
      const declared = [...provisioned.content.matchAll(/^\s+title: (.+)$/gm)].map(([, title]) => title.replace(/^['"]|['"]$/g, ''));
      assert.deepEqual(titles, declared, name);
    }
  });
}
