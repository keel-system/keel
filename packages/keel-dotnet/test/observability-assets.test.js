// El panel y las alertas de keel-dotnet (incremento 14d): los NEUTRALES de keel-core, con la fila de runtime de .NET.
//
// Dos preguntas, y la segunda es la que importa:
//   1. ¿Son los de keel-spring? Mismas filas, mismos paneles y mismas alertas, salvo la fila de runtime (cada
//      plataforma la suya) y lo que esta plataforma no publica, que se declara (el pool del modelo documental y el
//      retraso del consumidor), como en keel-nest.
//   2. ¿Publica keel-dotnet TODA serie que consultan? La prueba emitida TelemetryTests lleva la lista que build saca del
//      panel y las alertas de ESE diseño, ejercita cada observación y la busca en el scrape (en cs-check). Aquí se
//      comprueba que la lista es la de los artefactos y que nombra las series de la fila de runtime de .NET.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { DOTNET_RUNTIME } from '../src/scaffold/telemetry.js';
import { consultedSeries, seriesOf } from '../src/scaffold/telemetry-tests.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

// Cada subsistema del panel: outbox y consumo con Kafka (catalog-extended), storage + caché + documental
// (asset-vault) y correo (notification-mailer).
const SUBJECTS = [
  { name: 'catalog-extended', stack: { database: 'postgresql', broker: 'kafka', telemetry: 'otel', cache: 'redis', storage: 'minio' } },
  { name: 'asset-vault', stack: { database: 'mongodb', broker: 'rabbitmq', telemetry: 'otel', cache: 'redis', storage: 'minio' } },
  { name: 'notification-mailer', stack: { database: 'postgresql', broker: 'rabbitmq', telemetry: 'otel' } }
];

const plan = (name, stack, planner = planService) => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack });

function assetsOf(files) {
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const dashboard = JSON.parse(Object.entries(byPath).find(([file]) => file.startsWith('deploy/observability/dashboards/') && file.endsWith('.json'))[1]);
  const alerts = parseYaml(byPath['deploy/observability/alerting/keel-alerts.yaml']);
  return { dashboard, alerts };
}

for (const { name, stack } of SUBJECTS) {
  const dotnet = plan(name, stack);
  const own = assetsOf(dotnet.files);
  const spring = assetsOf(plan(name, stack, planSpring).files);
  const document = dotnet.model.persistenceKind === 'document';

  test(`${name}: el panel y las alertas son los de keel-spring salvo la fila de runtime`, () => {
    const rowsOf = (dashboard) => dashboard.panels.filter((panel) => panel.type === 'row').map((panel) => panel.title);
    assert.deepEqual(rowsOf(own.dashboard), rowsOf(spring.dashboard));
    const businessOf = (dashboard) => {
      const panels = [];
      let row = null;
      for (const panel of dashboard.panels) {
        if (panel.type === 'row') row = panel.title;
        else if (row !== 'Runtime') panels.push({ title: panel.title, exprs: panel.targets.map((target) => target.expr) });
      }
      return panels;
    };
    // La diferencia declarada: el retraso del consumidor, que solo publica el cliente de Kafka de la JVM.
    const LAG_PANEL = 'Retraso del consumidor (mensajes por detrás)';
    assert.deepEqual(businessOf(own.dashboard), businessOf(spring.dashboard).filter((panel) => panel.title !== LAG_PANEL));
    assert.equal(own.dashboard.uid, spring.dashboard.uid);
    const uids = (alerts) => alerts.groups.flatMap((group) => group.rules.map((rule) => rule.uid));
    const missing = uids(spring.alerts).filter((uid) => !uids(own.alerts).includes(uid));
    assert.ok(missing.every((uid) => (document && uid.endsWith('-pool')) || uid.endsWith('-lag')), `alertas de keel-spring que keel-dotnet no trae: ${missing.join(', ')}`);
    assert.ok(uids(own.alerts).every((uid) => uids(spring.alerts).includes(uid)), 'ninguna alerta propia');
    assert.deepEqual(own.alerts.contactPoints, spring.alerts.contactPoints);
    assert.deepEqual(own.alerts.policies, spring.alerts.policies);
  });

  test(`${name}: la prueba emitida exige cada serie que consultan, y entre ellas las del runtime de .NET`, () => {
    const consulted = consultedSeries(dotnet.model);
    const tests = dotnet.files.find((file) => file.path.endsWith('TelemetryTests.cs')).content;
    assert.match(tests, new RegExp(`private static readonly string\\[\\] Consulted = \\[${consulted.map((series) => `"${series}"`).join(', ')}\\];`));
    for (const series of [DOTNET_RUNTIME.heapUsed, DOTNET_RUNTIME.heapLimit, DOTNET_RUNTIME.gcSeconds, DOTNET_RUNTIME.threadPoolQueue]) assert.ok(consulted.includes(series), series);
    // El pool solo con persistencia relacional: en documental no hay serie, ni fila ni alerta.
    assert.equal(consulted.includes(DOTNET_RUNTIME.pool.saturation), !document);
    assert.ok(consulted.length >= 12, `se cruzan ${consulted.length} series`);
  });
}

test('sin telemetría no hay panel ni alertas', () => {
  const { files } = plan('catalog-extended', { database: 'postgresql', broker: 'kafka' });
  assert.ok(!files.some((file) => file.path.startsWith('deploy/observability/')));
});

test('el detector de series ve lo que tiene que ver (se autocomprueba)', () => {
  assert.deepEqual(
    seriesOf('sum by (le, keel_operation) (rate(keel_use_case_seconds_bucket{keel_outcome="error"}[5m])) / clamp_min(sum(keel_runtime_heap_limit_bytes), 1)'),
    ['keel_use_case_seconds_bucket', 'keel_runtime_heap_limit_bytes']
  );
});
