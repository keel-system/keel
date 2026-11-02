// Los logs de keel-go (incremento 14b), con y sin telemetría: el `logging.yaml` es el mismo que el de keel-nest salvo la
// cabecera, las claves que lee `SettingsFrom` existen y el cableado es el que dice el plan. Que la línea sea la ECS anidada, los
// niveles y la pila lo EJECUTA la prueba emitida (`logging_test.go`), y go-check lee la consola del servidor arrancado.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

const plan = (name, stack, planner = planService) => {
  const { files } = planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack });
  return Object.fromEntries(files.map((file) => [file.path, file.content]));
};

const withoutHeader = (text) => text.split('\n').slice(1).join('\n');

test('el logging.yaml de cada perfil es el de keel-nest, salvo la cabecera', () => {
  const go = plan('product-catalog');
  const nest = plan('product-catalog', undefined, planNest);
  for (const profile of PROFILES) {
    const file = `config/parameters/${profile}/logging.yaml`;
    assert.equal(withoutHeader(go[file]), withoutHeader(nest[file]), profile);
    assert.match(go[file], /keel-go build/);
  }
});

test('SettingsFrom lee las claves que el logging.yaml declara', () => {
  const go = plan('product-catalog');
  const reader = go['internal/platform/logging/logging.go'];
  for (const key of ['logging.level.root', 'logging.level.app', 'logging.structured.format.console', 'logging.structured.ecs.service.version', 'logging.structured.ecs.service.environment', 'logging.structured.ecs.service.node-name']) {
    assert.ok(reader.includes(`"${key}"`), key);
  }
  for (const part of ['root:', 'app:', 'console:', 'version:', 'environment:', 'node-name:']) assert.ok(go['config/parameters/develop/logging.yaml'].includes(part), part);
});

test('el arranque escribe con el logger del perfil, y una biblioteca también', () => {
  const main = plan('product-catalog')['cmd/server/main.go'];
  assert.ok(main.includes('logging.SettingsFrom(cfg)'));
  assert.ok(main.includes('logging.New(logSettings, stdout)'));
  assert.ok(main.includes('slog.SetDefault(logger)'));
  assert.ok(!main.includes('NewJSONHandler'), 'el JSON de serie de slog escribe otra forma');
});

test('la correlación solo entra si el servicio la tiene, y los ids de la traza solo con telemetría', () => {
  const plain = plan('product-catalog')['internal/platform/logging/logging.go'];
  assert.ok(plain.includes('correlation.ID(ctx)'));
  assert.ok(!plain.includes('go.opentelemetry.io'), 'sin telemetría no se importa ningún módulo de OpenTelemetry');
  assert.ok(plan('product-catalog', { telemetry: 'otel' })['internal/platform/logging/logging.go'].includes('trace.SpanContextFromContext(ctx)'));
  // Un servicio sin API ni mensajes no tiene correlación: el paquete ni existe.
  for (const [name, stack] of [['metering-digest', { broker: 'rabbitmq' }]]) {
    const files = plan(name, stack);
    if (!files['internal/platform/correlation/correlation.go']) assert.ok(!files['internal/platform/logging/logging.go'].includes('correlation.ID'));
  }
});

test('la correlación ya no lleva su propio handler: lo escribe el de los logs', () => {
  assert.ok(!plan('product-catalog')['internal/platform/correlation/correlation.go'].includes('LogHandler'));
});
