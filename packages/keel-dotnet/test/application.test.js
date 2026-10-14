// La capa de APLICACIÓN que emite keel-dotnet, sobre el árbol en memoria de las fixtures compartidas. Que
// compila, que el contenedor la construye entera y que cada mensaje llega a su handler lo miden la prueba
// emitida UseCasesTests y `npm run cs-check` (la solución de todas las fixtures); aquí, lo que se juzga sin
// SDK:
//   · PARIDAD con lo que EMITE keel-nest: los mismos mensajes con la misma clase (comando, comando con
//     resultado o consulta), y cada DTO con las mismas claves en el mismo orden, que es el orden del cable;
//   · el registro: cada operación tiene su handler registrado con el contrato de SU mensaje;
//   · los handlers nacen fallando con la operación nombrada, y las notas del diseño van en ellos.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { FIXTURES_DIR, fixtureNames, planFixture } from './helpers/workspace.js';
import { contractOf } from '../src/scaffold/services.js';

const fixtures = fixtureNames();
const plans = new Map();
for (const name of fixtures) plans.set(name, await planFixture(name));

function nestFiles(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planNest({ manifest, layers, workspace: FIXTURES_DIR }).files;
}

const operationsOf = (model) => model.services.flatMap((service) => service.operations);

/** Mensaje → clase, de lo que emite keel-nest. */
function nestMessages(files) {
  const kinds = { Command: 'command', ReturningCommand: 'returningCommand', Query: 'query' };
  const messages = new Map();
  for (const file of files.filter((f) => /^src\/application\/(commands|queries)\//.test(f.path))) {
    const match = /export class (\w+) extends (Command|ReturningCommand|Query)\b/.exec(file.content);
    if (match) messages.set(match[1], kinds[match[2]]);
  }
  return messages;
}

/** Lo mismo, de lo que emite keel-dotnet. */
function dotnetMessages(files) {
  const kinds = { ICommand: 'command', 'IReturningCommand<': 'returningCommand', 'IQuery<': 'query' };
  const messages = new Map();
  for (const file of files.filter((f) => /\.Application\/(Commands|Queries)\//.test(f.path))) {
    const match = /public sealed class (\w+) : (ICommand|IReturningCommand<|IQuery<)/.exec(file.content);
    if (match) messages.set(match[1], kinds[match[2]]);
  }
  return messages;
}

/** DTO → sus claves en orden, de lo que emite keel-nest (los campos de la clase, antes del constructor). */
function nestDtos(files) {
  const dtos = new Map();
  for (const file of files.filter((f) => /^src\/application\/dtos\//.test(f.path))) {
    const name = /export class (\w+)/.exec(file.content)?.[1];
    if (!name || name === 'PagedResponse' || name === 'FileUpload') continue;
    const declared = file.content.slice(0, file.content.indexOf('constructor('));
    dtos.set(name, [...declared.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((match) => match[1]));
  }
  return dtos;
}

/** Lo mismo, de lo que emite keel-dotnet: los nombres del cable, en el orden de las propiedades. */
function dotnetDtos(files) {
  const dtos = new Map();
  for (const file of files.filter((f) => /\.Application\/Dtos\//.test(f.path))) {
    const name = /public sealed record (\w+)/.exec(file.content)?.[1];
    if (!name || name === 'PagedResponse' || name === 'FileUpload') continue;
    dtos.set(name, [...file.content.matchAll(/\[JsonPropertyName\("([^"]+)"\)\]/g)].map((match) => match[1]));
  }
  return dtos;
}

const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

for (const name of fixtures) {
  test(`${name}: los mensajes y su clase son los que emite keel-nest`, () => {
    const dotnet = dotnetMessages(plans.get(name).files);
    assert.ok(dotnet.size > 0);
    assert.deepEqual(sorted(dotnet), sorted(nestMessages(nestFiles(name))));
  });

  test(`${name}: cada DTO lleva las claves de keel-nest, en el mismo orden (el del cable)`, () => {
    assert.deepEqual(sorted(dotnetDtos(plans.get(name).files)), sorted(nestDtos(nestFiles(name))));
  });

  test(`${name}: cada operación tiene su handler registrado con el contrato de SU mensaje, y nace fallando con su nombre`, () => {
    const { model, files } = plans.get(name);
    const registration = files.find((f) => f.path.endsWith('/UseCase/UseCaseRegistration.cs')).content;
    const wiring = files.find((f) => f.path.endsWith('/UseCasesTests.cs')).content;
    for (const operation of operationsOf(model)) {
      const contract = contractOf(operation).handler;
      assert.ok(registration.includes(`services.AddScoped<${contract}, ${operation.handlerClass}>();`), `${operation.name}: sin registrar`);
      assert.ok(wiring.includes(`[InlineData(typeof(${contract}), typeof(${operation.handlerClass}))]`), `${operation.name}: sin fila en UseCasesTests`);
      const handler = files.find((f) => f.path.endsWith(`/UseCases/${operation.handlerClass}.cs`)).content;
      assert.match(handler, new RegExp(`public sealed class ${operation.handlerClass}\\b[^\\n]*\\n? *: ${contract.replace(/[<>,]/g, '\\$&')}`));
      assert.ok(handler.includes(`throw new NotImplementedException("TODO: ${operation.name}");`), `${operation.name}: no nace fallando`);
    }
  });
}

test('la página lleva sus claves en el orden del cable', () => {
  const { files } = plans.get('product-catalog');
  const page = files.find((f) => f.path.endsWith('/Dtos/PagedResponse.cs')).content;
  assert.deepEqual([...page.matchAll(/\[JsonPropertyName\("([^"]+)"\)\]/g)].map((match) => match[1]), WIRE_SHAPES.pagedResponse);
});

test('con conventions.nulls: omit los DTOs llevan [OmitNulls]; sin ella, no', () => {
  const omitting = plans.get('catalog-extended');
  assert.equal(omitting.model.service.omitNulls, true);
  for (const file of omitting.files.filter((f) => /\.Application\/Dtos\/\w+Dto\.cs$/.test(f.path))) assert.match(file.content, /\[OmitNulls\]\npublic sealed record/, file.path);
  for (const file of plans.get('product-catalog').files.filter((f) => /\.Application\/Dtos\//.test(f.path))) assert.doesNotMatch(file.content, /\[OmitNulls\]/, file.path);
});

test('las notas del diseño van en el handler: precondiciones, errores con su archivo, transiciones y eventos', () => {
  const { model, files } = plans.get('product-catalog');
  const operation = operationsOf(model).find((op) => (op.errors ?? []).length > 0 && (op.transitions ?? []).length > 0);
  assert.ok(operation, 'product-catalog tiene una operación con errores y transición');
  const handler = files.find((f) => f.path.endsWith(`/UseCases/${operation.handlerClass}.cs`)).content;
  for (const code of operation.errors) {
    const error = model.errors.find((e) => e.code === code);
    assert.match(handler, new RegExp(`Error: lanzar ${error.exceptionClass} \\(${code}`));
  }
  assert.match(handler, /Transición: Product[\s\S]*TransitionTo/);
  assert.doesNotMatch(handler, /\{ get; set; \}/);
});

test('el despacho entre casos de uso: el handler que despacha recibe ICommandDispatcher, y el puerto solo existe si alguien lo usa', () => {
  const mailer = plans.get('asset-vault');
  const dispatching = operationsOf(mailer.model).filter((op) => (op.dispatches ?? []).length > 0);
  assert.ok(dispatching.length > 0);
  for (const operation of dispatching) {
    const handler = mailer.files.find((f) => f.path.endsWith(`/UseCases/${operation.handlerClass}.cs`)).content;
    // Puede recibir además el puerto de un cliente saliente (una activación de la misma operación).
    assert.match(handler, /\(ICommandDispatcher commandDispatcher[,)]/);
    assert.match(handler, /Despacha \(use-cases\.dispatches\)/);
  }
  assert.ok(mailer.files.some((f) => f.path.endsWith('/Ports/ICommandDispatcher.cs')));
  assert.ok(!plans.get('product-catalog').files.some((f) => f.path.endsWith('/Ports/ICommandDispatcher.cs')));
});

test('la capa de aplicación no conoce ASP.NET Core, la inyección de dependencias ni la persistencia', () => {
  for (const [name, { files }] of plans) {
    for (const file of files.filter((f) => /\.Application\//.test(f.path) && f.path.endsWith('.cs'))) {
      assert.doesNotMatch(file.content, /Microsoft\.(AspNetCore|EntityFrameworkCore|Extensions\.DependencyInjection)/, `${name}: ${file.path}`);
    }
  }
});
