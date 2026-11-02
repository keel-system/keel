// El panel y las alertas de keel-go (incremento 14d): los neutrales, los mismos que los de keel-spring salvo la fila de runtime y
// lo declarado. La pregunta que importa —¿publica el servidor TODA serie que consultan?— la EJECUTA la prueba emitida
// `TestTodaSerieQueConsultanElPanelYLasAlertasLaPublicaElScrape`, con la lista que build saca de ESTE diseño.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { seriesOf } from '@keel-system/keel-core/gen/observability-assets';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { GO_RUNTIME } from '../src/scaffold/telemetry.js';
import { consultedSeries } from '../src/scaffold/observability-assets.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

// Cada subsistema del panel: outbox y consumo con Kafka (catalog-extended), storage + caché + documental (asset-vault) y correo.
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

const titles = (dashboard) => dashboard.panels.map((panel) => panel.title);

for (const { name, stack } of SUBJECTS) {
  const go = plan(name, stack);

  test(`${name}: el panel y las alertas son los de keel-spring, salvo el runtime y el retraso del consumidor`, () => {
    const mine = assetsOf(go.files);
    const theirs = assetsOf(plan(name, stack, planSpring).files);
    const neutral = (list) => list.filter((title) => !/GC|heap|Heap|pool|Pool|Goroutines|retraso|Retraso|lag|Lag|hilo|JVM|memoria|Memoria/.test(title));
    assert.deepEqual(neutral(titles(mine.dashboard)), neutral(titles(theirs.dashboard)));
    const alertTitles = (alerts) => alerts.groups.flatMap((group) => group.rules.map((rule) => rule.uid)).filter((uid) => !/lag|pool/i.test(uid));
    assert.deepEqual(alertTitles(mine.alerts), alertTitles(theirs.alerts));
  });

  test(`${name}: el panel consulta el runtime de Go`, () => {
    const consulted = consultedSeries(go.model);
    for (const series of [GO_RUNTIME.heapUsed, GO_RUNTIME.heapLimit, GO_RUNTIME.gcSeconds, GO_RUNTIME.goroutines]) assert.ok(consulted.includes(series), series);
    assert.ok(!consulted.some((series) => series.startsWith('jvm_')), 'una serie de la JVM dejaría el panel vacío');
  });
}

test('el pool solo en el modelo relacional: el driver de MongoDB no lo publica sin suscribirse a sus eventos', () => {
  assert.ok(consultedSeries(plan('catalog-extended', SUBJECTS[0].stack).model).includes(GO_RUNTIME.pool.saturation));
  assert.ok(!consultedSeries(plan('asset-vault', SUBJECTS[1].stack).model).includes(GO_RUNTIME.pool.saturation));
});

test('toda serie consultada es del vocabulario o del runtime: la prueba emitida exige que el scrape la publique', () => {
  const emitted = Object.fromEntries(plan('catalog-extended', SUBJECTS[0].stack).files.map((file) => [file.path, file.content]))['internal/platform/telemetry/telemetry_test.go'];
  for (const series of consultedSeries(plan('catalog-extended', SUBJECTS[0].stack).model)) assert.ok(emitted.includes(`"${series}"`), series);
});

test('seriesOf saca los nombres de serie de una expresión PromQL', () => {
  assert.deepEqual(
    seriesOf('sum by (le, keel_operation) (rate(keel_use_case_seconds_bucket{keel_outcome="error"}[5m])) / clamp_min(sum(keel_runtime_heap_limit_bytes), 1)'),
    ['keel_use_case_seconds_bucket', 'keel_runtime_heap_limit_bytes']
  );
});
