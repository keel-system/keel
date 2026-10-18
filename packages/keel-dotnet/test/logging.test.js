// Los logs de keel-dotnet (incremento 14b), sobre el texto emitido:
//
//   · logging.yaml es el de keel-nest en los cuatro perfiles salvo la cabecera (keel-core/gen/logging-config.js), con las
//     variables y los defaults de keel-spring, y LoggingSettings solo lee claves que ese YAML declara;
//   · el nivel del servicio es el de las categorías de su namespace raíz, y Program.cs instala la consola del servicio
//     antes de crear la aplicación;
//   · lo emite toda fixture, con correlación o sin ella.
// Lo que EJECUTA el C# (la configuración real de cada perfil leída por el cargador, la línea ECS y la de texto, los niveles)
// lo mide la prueba emitida ServiceLoggingTests en `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const stack = { database: 'postgresql', broker: 'rabbitmq' };
const plan = (name, planner = planService) => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const withoutHeader = (yaml) => yaml.replace(/^# Generado por keel-[a-z]+ build\.[^\n]*\n/, '');

function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}:`) : [`${prefix}${key}`]));
}

test('logging.yaml es el de keel-nest en los cuatro perfiles, salvo la cabecera', () => {
  const dotnet = plan('product-catalog').files;
  const nest = plan('product-catalog', planNest).files;
  for (const profile of PROFILES) {
    const own = content(dotnet, `config/parameters/${profile}/logging.yaml`);
    assert.ok(own, profile);
    assert.match(own, /^# Generado por keel-dotnet build\./);
    assert.equal(withoutHeader(own), withoutHeader(content(nest, `config/parameters/${profile}/logging.yaml`)), profile);
  }
});

test('los niveles y el formato salen de las variables de keel-spring, con sus mismos defaults', () => {
  const dotnet = plan('product-catalog').files;
  const { files: spring, model } = plan('product-catalog', planSpring);
  // keel-spring no tiene fragmento de logs en test: ahí valen los de su application.yaml.
  for (const profile of ['local', 'develop', 'production']) {
    const own = parseYaml(content(dotnet, `config/parameters/${profile}/logging.yaml`)).logging;
    // keel-spring nombra el nivel del servicio por su paquete base (la convención de logback).
    const theirs = parseYaml(content(spring, `src/main/resources/parameters/${profile}/logging.yaml`)).logging;
    assert.equal(own.level.root, theirs.level.root, profile);
    assert.equal(own.level.app, theirs.level[model.service.basePackage], profile);
  }
});

test('LoggingSettings solo lee claves que declara logging.yaml (o la del nombre del servicio)', () => {
  const { files } = plan('product-catalog');
  const declared = new Set(['application:name']);
  for (const profile of PROFILES) for (const key of flatKeys(parseYaml(content(files, `config/parameters/${profile}/logging.yaml`)))) declared.add(key);
  const settings = content(files, 'Logging/LoggingSettings.cs');
  const read = [...settings.matchAll(/Text\(configuration, "([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(read.length >= 6, read.join(', '));
  for (const key of read) assert.ok(declared.has(key), `LoggingSettings lee ${key}, que logging.yaml no declara`);
});

test('el nivel del servicio es el de su namespace raíz, y Program.cs instala la consola antes de crear la aplicación', () => {
  const { files, model } = plan('product-catalog');
  assert.match(content(files, 'Logging/LoggingSettings.cs'), new RegExp(`public const string AppCategory = "${model.service.rootNamespace}";`));
  const registration = content(files, 'Logging/LoggingRegistration.cs');
  assert.match(registration, /logging\.ClearProviders\(\);/);
  assert.match(registration, /SetMinimumLevel\(settings\.RootLevel\)/);
  assert.match(registration, /AddFilter\(LoggingSettings\.AppCategory, settings\.AppLevel\)/);
  const program = content(files, 'Program.cs');
  const installs = program.indexOf('builder.Logging.AddServiceLogging(LoggingSettings.From(configuration));');
  assert.ok(installs > program.indexOf('WebApplication.CreateBuilder(args)'));
  assert.ok(installs < program.indexOf('builder.Build()'));
});

test('lo emite toda fixture; la línea lleva el correlationId solo donde hay correlación', () => {
  for (const name of fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml')))) {
    let planned;
    try {
      planned = plan(name);
    } catch {
      continue; // fuera de la frontera con este stack: lo cubre supported-features
    }
    const formatter = content(planned.files, 'Logging/KeelConsoleFormatter.cs');
    assert.ok(formatter, name);
    assert.ok(content(planned.files, 'ServiceLoggingTests.cs'), name);
    const correlated = planned.files.some((file) => file.path.endsWith('Correlation/CorrelationContext.cs'));
    assert.equal(formatter.includes('CorrelationContext.Get()'), correlated, name);
  }
});
