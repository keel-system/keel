// El panel y las alertas de keel-nest (incremento 14d): los NEUTRALES de keel-core, con la fila de runtime de Node.
//
// Dos preguntas, y la segunda es la que importa:
//   1. ¿Son los de keel-spring? Mismas filas, mismos paneles y mismas alertas, salvo la fila de runtime (cada
//      plataforma la suya) y lo que esta plataforma no publica, que se declara (el pool del modelo documental y el
//      retraso del consumidor).
//   2. ¿Publica keel-nest TODA serie que consultan? Se EJECUTA la telemetría emitida, se ejercitan sus observaciones y
//      se mira el scrape: una alerta sobre una serie que nadie publica no falla, no dispara nunca.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { OBSERVATIONS, ATTRIBUTES } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

// Cada subsistema del panel: outbox y consumo con Kafka (catalog-extended), storage + caché + documental
// (asset-vault), correo (notification-mailer) y el relacional sobre MySQL.
const SUBJECTS = [
  { name: 'catalog-extended', stack: { database: 'postgresql', broker: 'kafka', telemetry: 'otel', cache: 'redis', storage: 'minio' } },
  { name: 'asset-vault', stack: { broker: 'rabbitmq', telemetry: 'otel', cache: 'redis', storage: 'minio' } },
  { name: 'notification-mailer', stack: { database: 'mysql', broker: 'rabbitmq', telemetry: 'otel' } }
];

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger {
  log() {}
  warn() {}
  error() {}
}
`;

// Y el de `cron`: el sondeador solo le pide el siguiente tick de un recurrente, al rearmarlo tras el disparo.
const CRON_STUB = `
export class CronTime {
  getNextDateFrom() {
    return { toJSDate: () => new Date(Date.now() + 86_400_000) };
  }
}
`;

const PROMQL_WORDS = new Set([
  'sum', 'max', 'min', 'rate', 'by', 'le', 'histogram_quantile', 'clamp_min', 'max_over_time', 'min_over_time', 'irate', 'avg', 'count', 'without', 'on'
]);

/** Los nombres de serie que nombra una expresión PromQL (sin funciones, etiquetas ni literales). */
function seriesOf(expr) {
  const withoutLabels = expr.replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '').replace(/by \([^)]*\)/g, '');
  return [...withoutLabels.matchAll(/[a-z_][a-z0-9_]*/g)].map(([name]) => name).filter((name) => !PROMQL_WORDS.has(name) && name.includes('_'));
}

function assetsOf(files) {
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const dashboard = JSON.parse(Object.entries(byPath).find(([file]) => file.startsWith('deploy/observability/dashboards/') && file.endsWith('.json'))[1]);
  const alerts = parseYaml(byPath['deploy/observability/alerting/keel-alerts.yaml']);
  const rules = parseYaml(byPath['deploy/observability/prometheus-rules.example.yaml']);
  return { dashboard, alerts, rules };
}

function expressionsOf({ dashboard, alerts, rules }) {
  return [
    ...dashboard.panels.flatMap((panel) => (panel.targets ?? []).map((target) => target.expr)),
    ...alerts.groups.flatMap((group) => group.rules.map((rule) => rule.data[0].model.expr)),
    ...rules.groups.flatMap((group) => group.rules.map((rule) => rule.expr))
  ];
}

for (const { name, stack } of SUBJECTS) {
  const nest = planFixture(name, { stack });
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
  const nestAssets = assetsOf(nest.files);
  const springAssets = assetsOf(spring);
  const document = nest.model.persistenceKind === 'document';

  test(`${name}: el panel y las alertas son los de keel-spring salvo la fila de runtime`, () => {
    const rowsOf = (dashboard) => dashboard.panels.filter((panel) => panel.type === 'row').map((panel) => panel.title);
    assert.deepEqual(rowsOf(nestAssets.dashboard), rowsOf(springAssets.dashboard));
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
    assert.deepEqual(businessOf(nestAssets.dashboard), businessOf(springAssets.dashboard).filter((panel) => panel.title !== LAG_PANEL));
    assert.equal(nestAssets.dashboard.uid, springAssets.dashboard.uid);
    // Las alertas: las mismas, menos lo que keel-nest no publica (el pool documental, el retraso del consumidor).
    const uids = (alerts) => alerts.groups.flatMap((group) => group.rules.map((rule) => rule.uid));
    const missing = uids(springAssets.alerts).filter((uid) => !uids(nestAssets.alerts).includes(uid));
    const declared = missing.every((uid) => (document && uid.endsWith('-pool')) || uid.endsWith('-lag'));
    assert.ok(declared, `alertas de keel-spring que keel-nest no trae: ${missing.join(', ')}`);
    assert.ok(uids(nestAssets.alerts).every((uid) => uids(springAssets.alerts).includes(uid)), 'ninguna alerta propia');
    // El contacto y la política, idénticos: es lo que hace que una alerta salga a alguna parte.
    assert.deepEqual(nestAssets.alerts.contactPoints, springAssets.alerts.contactPoints);
    assert.deepEqual(nestAssets.alerts.policies, springAssets.alerts.policies);
  });

  test(`${name}: toda serie que consultan el panel y las alertas la publica la telemetría emitida`, async () => {
    // El sustituto de @nestjs/common: el sondeador del cronómetro lo importa (sus decoradores y su Logger) y aquí no hay Nest.
    const tree = transpileTree(nest.files, { stubs: { '@nestjs/common': NEST_STUB, cron: CRON_STUB } });
    const { Telemetry, instrumentStorage, instrumentMail } = await tree.load('src/infrastructure/telemetry/telemetry.ts');
    const configuration = {
      profiles: ['local'],
      application: { name },
      server: { port: 0, address: '127.0.0.1', shutdownTimeoutMs: 0 },
      get: () => null
    };
    const telemetry = Telemetry.start(configuration);
    after(() => telemetry.shutdown());
    try {
      // Cada observación del vocabulario, con las etiquetas con las que la emite el código generado.
      await telemetry.observe(OBSERVATIONS.useCase, { labels: { [ATTRIBUTES.operation]: 'X' } }, async () => {});
      await telemetry.publishing('E', null, async () => {});
      await telemetry.consuming('E', null, async () => {});
      await instrumentStorage({ async upload() {} }).upload('b', 'k');
      await instrumentMail({ async send() {} }).send({});
      telemetry.cacheGet('c', true);
      telemetry.gauge('keel.outbox.dead_lettered', 'x', async () => 0);
      telemetry.connectionPool(() => ({ active: 1, idle: 1, max: 4, pending: 0 }));
      // El cronómetro (DSL 2.26, inc. 11): el TimerPoller EMITIDO, con un almacén falso que entrega la purga de la tabla ya
      // vencida. Arrancarlo registra el retraso y los aparcados; su primera pasada dispara la purga y la observa.
      const pollerFile = nest.files.find((file) => file.path.endsWith('/timer-poller.ts'));
      if (pollerFile) {
        const { TimerPoller } = await tree.load(pollerFile.path);
        const kind = 'purge:keel_timer';
        let claims = 0;
        const store = {
          dbNow: async () => new Date(),
          ensureRecurring: async () => {},
          claim: async () => (claims++ === 0 ? [{ id: 't1', kind, entityId: null, dueAt: new Date(), attempts: 0 }] : []),
          reschedule: async () => true,
          nextDueMs: async () => null,
          lagMs: async () => 120_000,
          parkedCount: async () => 0
        };
        const settings = { enabled: true, maxSleepMs: 30_000, batchSize: 10, leaseMs: 60_000, maxAttempts: 3, retryDelayMs: 0, drainBudgetMs: 1_000, retentionDays: 7, purgeCron: '0 30 5 * * *' };
        const poller = new TimerPoller(store, [], [{ kind, spec: '0 30 5 * * *', tick: async () => {} }], settings, { inTransaction: (work) => work() }, { subscribe: () => () => {} });
        poller.onApplicationBootstrap();
        while (claims === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        await poller.beforeApplicationShutdown();
        const exposition = await telemetry.registry.metrics();
        assert.match(exposition, /^keel_timer_lag_seconds 120$/m, 'el gauge del retraso no publica lo que dice el almacén, en segundos');
        assert.match(exposition, /^keel_timer_tick_seconds_count\{[^}]*keel_timer_kind="purge:keel_timer"[^}]*\} 1$/m, 'el disparo no dejó su serie con el kind');
      }
      // Un gauge cuya lectura falla (la base caída) no puede tumbar el scrape entero: publica NaN y lo demás sale.
      telemetry.gauge('keel.probe.failing', 'sonda', async () => {
        throw new Error('base caída');
      });
      assert.match(await telemetry.registry.metrics(), /^keel_probe_failing nan$/im, 'un gauge que falla tumba el scrape');
      const { default: Fastify } = await import('fastify');
      const fastify = Fastify();
      telemetry.installHttp(fastify);
      fastify.get('/x/:id', async () => ({}));
      await fastify.inject({ method: 'GET', url: '/x/1' });
      await fastify.close();
      // La serie de GC aparece con la primera recolección y la del bucle de eventos con su primera muestra: se
      // provocan (en un servicio en marcha ocurren solas en los primeros segundos).
      let garbage = [];
      for (let round = 0; round < 200; round += 1) garbage = Array.from({ length: 5000 }, (_, index) => ({ index, round }));
      assert.ok(garbage.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const published = new Set(
        (await telemetry.registry.metrics())
          .split('\n')
          .filter((line) => line && !line.startsWith('#'))
          .map((line) => line.split(/[{ ]/)[0])
      );
      const consulted = new Set(expressionsOf(nestAssets).flatMap(seriesOf));
      const unpublished = [...consulted].filter((series) => !published.has(series));
      assert.deepEqual(unpublished, [], `series consultadas que nadie publica: ${unpublished.join(', ')}`);
      assert.ok(consulted.size >= 8, `se cruzaron ${consulted.size} series`);
    } finally {
      await telemetry.shutdown();
    }
  });
}

test('el detector de series ve lo que tiene que ver (se autocomprueba)', () => {
  assert.deepEqual(
    seriesOf('sum by (le, keel_operation) (rate(keel_use_case_seconds_bucket{keel_outcome="error"}[5m])) / clamp_min(sum(keel_runtime_heap_limit_bytes), 1)'),
    ['keel_use_case_seconds_bucket', 'keel_runtime_heap_limit_bytes']
  );
});
