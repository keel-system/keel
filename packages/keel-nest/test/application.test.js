// Rasgos de la capa APPLICATION que emite keel-nest: mensajes, handlers, mappers y el contenedor de
// casos de uso. Lo que se puede, se juzga EJECUTANDO el código emitido (transpilado, sin instalar el
// proyecto); el resto, sobre el texto. Las fixtures son las compartidas con keel-spring.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { MODEL_PACKAGES } from '../src/scaffold/architecture.js';

const FIXTURES = fs.readdirSync(FIXTURES_DIR);

const operationsOf = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []);
const messageFile = (op) => `src/application/${op.messageKind === 'query' ? 'queries' : 'commands'}/${fileOf(op.messageClass)}.ts`;
const handlerFile = (op) => `src/application/usecases/${fileOf(op.handlerClass)}.ts`;
function fileOf(className) {
  return className.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

for (const name of FIXTURES) {
  test(`${name}: cada operación llega a SU handler por el contenedor, y el handler falla con su TODO`, async () => {
    const { model, files } = planFixture(name);
    const tree = transpileTree(files);
    const { UseCaseContainer } = await tree.load('src/infrastructure/usecase/use-case-container.ts');
    const operations = operationsOf(model);
    assert.ok(operations.length > 0);
    const instances = [];
    const messages = [];
    for (const operation of operations) {
      const Handler = (await tree.load(handlerFile(operation)))[operation.handlerClass];
      // Las dependencias se construyen desde lo que el handler DECLARA: si `inject` no casara con su
      // constructor, el módulo de Nest le pasaría otra cosa.
      const deps = await Promise.all(Handler.inject.map(async (dep) => new dep()));
      instances.push(new Handler(...deps));
      messages.push([operation, (await tree.load(messageFile(operation)))[operation.messageClass]]);
    }
    const container = UseCaseContainer.of(instances);
    for (const [operation, Message] of messages) {
      const handler = container.resolve(Object.create(Message.prototype));
      assert.equal(handler.constructor.name, operation.handlerClass);
      await assert.rejects(handler.handle(Object.create(Message.prototype)), new RegExp(`TODO: ${operation.name}$`));
    }
  });

  test(`${name}: dominio y aplicación no importan más paquetes que los del modelo`, () => {
    const { files } = planFixture(name);
    const allowed = new Set(MODEL_PACKAGES);
    const offenders = [];
    for (const file of files.filter((f) => /^src\/(domain|application)\/.+\.ts$/.test(f.path))) {
      for (const [, specifier] of file.content.matchAll(/from '([^']+)'/g)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:') || allowed.has(specifier)) continue;
        offenders.push(`${file.path}: ${specifier}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
}

test('el mapper copia el agregado al DTO campo a campo, en el orden del diseño', async () => {
  const { model, files } = planFixture('product-catalog');
  const tree = transpileTree(files);
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const { Money } = await tree.load('src/domain/valueobject/money.ts');
  const { ProductStatus } = await tree.load('src/domain/enums/product-status.ts');
  const { Product } = await tree.load('src/domain/aggregate/product.ts');
  const { ProductApplicationMapper } = await tree.load('src/application/mappers/product-application-mapper.ts');
  const product = new Product({
    id: '0192f1d2-0000-7000-8000-000000000001',
    sku: 'ABC-1234',
    name: 'Lámpara',
    notes: null,
    price: new Money(Decimal.parse('10'), 'EUR'),
    apiToken: 'secreto',
    status: ProductStatus.ACTIVE,
    lockVersion: 3
  });
  const operation = operationsOf(model).find((op) => op.name === 'getProduct');
  const dto = new ProductApplicationMapper()[`to${operation.responseDto.name}`](product);
  assert.deepEqual(Object.keys(dto), operation.responseDto.fields.map((field) => field.name));
  assert.equal(dto.sku, 'ABC-1234');
  assert.equal(dto.price.amount.toString(), '10.00');
  assert.ok(!('apiToken' in dto), 'un campo sensible no sale al contrato');
});

test('un decimal escalar con scalePolicy: round se redondea al entrar en el mensaje', async () => {
  // Ninguna fixture lo declara en una entrada (las que hay son reject): se deriva de una real.
  let target = null;
  const { model, files } = planFixture('payout-runs', {
    mutate: (layers) => {
      for (const [name, operation] of Object.entries(layers['use-cases'].operations)) {
        const amount = operation.input?.fields?.amount;
        if (amount?.constraints?.scalePolicy === 'reject') {
          amount.constraints.scalePolicy = 'round';
          target ??= name;
        }
      }
    }
  });
  assert.ok(target, 'payout-runs declara un importe de entrada con scalePolicy');
  const operation = operationsOf(model).find((op) => op.name === target);
  const tree = transpileTree(files);
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const Message = (await tree.load(messageFile(operation)))[operation.messageClass];
  const props = Object.fromEntries(
    [...(operation.pathParams ?? []), ...operation.bodyFields].map((field) => [field.name, field.name === 'amount' ? Decimal.parse('1.005') : null])
  );
  assert.equal(new Message(props).amount.toString(), '1.01');
});

test('en un PATCH, un opcional del cuerpo distingue ausente de null en su tipo', () => {
  let found = 0;
  for (const name of FIXTURES) {
    const { model, files } = planFixture(name);
    for (const operation of operationsOf(model).filter((op) => op.route?.method === 'PATCH')) {
      const content = files.find((file) => file.path === messageFile(operation)).content;
      for (const field of operation.bodyFields.filter((f) => !f.required && !f.list)) {
        found += 1;
        assert.match(content, new RegExp(`readonly ${field.name}\\?: [^;]*\\| null;`), `${operation.messageClass}.${field.name}`);
      }
    }
  }
  assert.ok(found > 0, 'alguna fixture declara un PATCH con opcionales');
});

test('el formato heredado de un value type escalar se valida en la entrada, y el mensaje apunta a la guarda del dominio', () => {
  const { files } = planFixture('product-catalog');
  const command = files.find((file) => file.path === 'src/application/commands/create-product-command.ts').content;
  assert.match(command, /El formato del value type SKU \(\^\[A-Z\]\{3\}-\[0-9\]\{4\}\$\) se valida YA en la entrada/);
  // Y el lector de la petición lo comprueba de verdad: es lo que hace que el 400 llegue antes que el negocio.
  const reader = files.filter((file) => file.path.includes('/rest/controllers/')).map((file) => file.content).join(' ');
  assert.match(reader, /\.check\('sku', sku, \[[^\]]*\{ rule: 'pattern', regexp: '\^\[A-Z\]\{3\}-\[0-9\]\{4\}\$' \}/);
  assert.match(command, /SKUFormat\.validate\(\.\.\.\) \(src\/domain\/valueobject\/sku-format\.ts\)/);
});

test('la operación interna sin disparador recibe el puerto CommandDispatcher y su adaptador', () => {
  let checked = 0;
  for (const name of FIXTURES) {
    const { model, files } = planFixture(name);
    const bySubscription = new Set((model.subscriptions ?? []).map((s) => s.trigger));
    const orphans = operationsOf(model).filter((op) => op.internal && !op.schedule && !bySubscription.has(op.name));
    const paths = new Set(files.map((file) => file.path));
    assert.equal(paths.has('src/application/port/out/command-dispatcher.ts'), orphans.length > 0, name);
    if (orphans.length === 0) continue;
    checked += 1;
    const module = files.find((file) => file.path === 'src/infrastructure/usecase/use-case-module.ts').content;
    assert.match(module, /\{ provide: CommandDispatcher, useClass: CommandDispatcherAdapter \}/);
  }
  assert.ok(checked > 0, 'alguna fixture declara una operación interna sin disparador');
});

// Corrida notification-mailer-mongo (12e): un handler que inyecta CommandDispatcher cerraba el ciclo
// contenedor → handler → adaptador → mediator → contenedor, y Nest no arrancaba. El adaptador resuelve el mediator
// en el primer despacho (ModuleRef), no por constructor. Se ejecuta lo emitido con sustitutos de Nest.
test('CommandDispatcherAdapter resuelve el mediator en el PRIMER despacho, no al construirse', async () => {
  const { files } = planFixture('notification-mailer', { stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const adapterFile = files.find((file) => file.path === 'src/infrastructure/usecase/command-dispatcher-adapter.ts').content;
  assert.doesNotMatch(adapterFile, /@Inject\(UseCaseMediator\)/, 'inyectar el mediator por constructor cierra el ciclo');
  // El mediator solo hace de token aquí: se sustituye por una clase vacía para no arrastrar la persistencia.
  const alone = files.map((file) =>
    file.path === 'src/infrastructure/usecase/use-case-mediator.ts' ? { ...file, content: 'export class UseCaseMediator {}' } : file
  );
  const tree = transpileTree(alone, {
    stubs: {
      '@nestjs/common': 'export const Inject = () => () => {}; export const Injectable = () => () => {}; export const Global = () => () => {}; export const Module = () => () => {}; export class Logger { log() {} warn() {} error() {} }',
      '@nestjs/core': 'export class ModuleRef {}'
    }
  });
  const { CommandDispatcherAdapter } = await tree.load('src/infrastructure/usecase/command-dispatcher-adapter.ts');
  const calls = [];
  const mediator = { dispatch: async (m) => calls.push(['dispatch', m]), dispatchWithoutTransaction: async (m) => calls.push(['without', m]) };
  let lookups = 0;
  const adapter = new CommandDispatcherAdapter({ get: () => (lookups++, mediator) });
  assert.equal(lookups, 0, 'construirlo no toca el contenedor');
  await adapter.dispatch('a');
  await adapter.dispatchWithoutTransaction('b');
  assert.deepEqual(calls, [['dispatch', 'a'], ['without', 'b']]);
  assert.equal(lookups, 1, 'se resuelve una sola vez');
});
