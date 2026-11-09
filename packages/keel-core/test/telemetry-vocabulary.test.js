// El vocabulario neutral de la telemetría: los nombres de serie que consultan el panel y las alertas de
// `deploy/` y que tienen que publicar los dos servidores (incremento 14 de PLAN-KEEL-NEST.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTES,
  INSTRUMENTATION,
  METRICS_TRANSPORT,
  OBSERVATIONS,
  OUTBOX_DEAD_LETTERED,
  OUTCOMES,
  TIMER_LAG,
  TIMER_PARKED,
  promGauge,
  promMetric,
  promTag,
  usesTelemetry
} from '../src/lib/gen/telemetry-vocabulary.js';

test('una observación se ve como histograma en segundos, con sus tres derivadas', () => {
  assert.deepEqual(promMetric(OBSERVATIONS.useCase), {
    base: 'keel_use_case_seconds',
    bucket: 'keel_use_case_seconds_bucket',
    sum: 'keel_use_case_seconds_sum',
    count: 'keel_use_case_seconds_count'
  });
  assert.equal(promGauge(OUTBOX_DEAD_LETTERED), 'keel_outbox_dead_lettered');
  assert.equal(promTag(ATTRIBUTES.outcome), 'keel_outcome');
});

test('todo nombre propio vive en keel.*, y ningún nombre de serie colisiona con otro', () => {
  const names = [...Object.values(OBSERVATIONS), OUTBOX_DEAD_LETTERED, TIMER_LAG, TIMER_PARKED, ...Object.values(ATTRIBUTES)];
  for (const name of names) assert.match(name, /^keel\./, name);
  const series = Object.values(OBSERVATIONS).map((o) => promMetric(o).base);
  assert.equal(new Set(series).size, series.length);
});

test('el cronómetro (DSL 2.26, inc. 11): el retraso lleva la unidad en el nombre, el disparo es un histograma', () => {
  assert.equal(promGauge(TIMER_LAG), 'keel_timer_lag_seconds');
  assert.equal(promGauge(TIMER_PARKED), 'keel_timer_parked');
  assert.equal(promMetric(OBSERVATIONS.timerTick).bucket, 'keel_timer_tick_seconds_bucket');
  assert.equal(promTag(ATTRIBUTES.timerKind), 'keel_timer_kind');
});

test('cada interruptor tiene clave de configuración y variable propias', () => {
  const entries = Object.values(INSTRUMENTATION);
  assert.equal(new Set(entries.map((e) => e.envVar)).size, entries.length);
  assert.equal(new Set(entries.map((e) => e.property)).size, entries.length);
  for (const [id, entry] of Object.entries(INSTRUMENTATION)) assert.equal(entry.id, id);
  assert.notEqual(METRICS_TRANSPORT.prometheus.envVar, METRICS_TRANSPORT.otlp.envVar);
  assert.match(METRICS_TRANSPORT.scrapePath, /^\/.+/);
});

test('los desenlaces del caso de uso y la pregunta de si hay telemetría', () => {
  assert.deepEqual(OUTCOMES, ['ok', 'rejected', 'error']);
  assert.equal(usesTelemetry({ stack: { telemetry: 'otel' } }), true);
  assert.equal(usesTelemetry({ stack: { telemetry: 'none' } }), false);
  assert.equal(usesTelemetry({}), false);
});
