// La capa de APLICACIÓN que emite keel-go, sobre el árbol en memoria de las fixtures compartidas. Que compila, que
// gofmt, vet y staticcheck no tienen nada que decir y que cada operación queda cableada lo miden la prueba emitida
// use_cases_test.go y `npm run go-check` (las 17 fixtures); aquí, lo que se juzga sin Go:
//   · PARIDAD con lo que EMITEN keel-nest y keel-dotnet: los mismos mensajes con la misma clase (comando, comando con
//     resultado o consulta) y cada DTO con las mismas claves del cable en el mismo orden;
//   · el registro: cada operación tiene su campo en UseCases con el contrato de SU mensaje, y su handler nace
//     fallando con la operación nombrada;
//   · las notas del diseño van en el handler, y lo que build no sabe derivar en un mapeo se dice en vez de inventarse.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { planService } from '../src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { contractOf, handlerType, messageType, operations, scaleRounding, useCaseField } from '../src/scaffold/services.js';
import { goExported } from '../src/lib/go-projection.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { goFileName as fileOf } from '../src/scaffold/render.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const loaded = new Map(fixtures.map((name) => [name, loadService(path.join(FIXTURES_DIR, name))]));
const plans = new Map(fixtures.map((name) => [name, planService({ ...loaded.get(name), workspace: FIXTURES_DIR })]));
const other = (plan, name) => plan({ ...loaded.get(name), workspace: FIXTURES_DIR }).files;
const app = (files, name) => files.find((file) => file.path === `internal/application/${name}.go`)?.content;
const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

/** Mensaje → clase, de lo que emite keel-go: la clase la dice el cableado de NewUseCases. */
function goMessages(files) {
  const wiring = app(files, 'use_cases');
  const messages = new Map();
  for (const [, call, name, kind] of wiring.matchAll(/^\tuc\.\w+ = (observe|observeCommand)\(logger, tx, "(\w+)"(?:, (Kind\w+))?,/gm)) {
    messages.set(name, call === 'observeCommand' ? 'command' : kind === 'KindQuery' ? 'query' : 'returningCommand');
  }
  return messages;
}

/** Lo mismo, de lo que emite keel-dotnet, con el nombre Go (las siglas en un solo caso). */
function dotnetMessages(files) {
  const kinds = { ICommand: 'command', 'IReturningCommand<': 'returningCommand', 'IQuery<': 'query' };
  const messages = new Map();
  for (const file of files.filter((f) => /\.Application\/(Commands|Queries)\//.test(f.path))) {
    const match = /public sealed class (\w+) : (ICommand|IReturningCommand<|IQuery<)/.exec(file.content);
    if (match) messages.set(goExported(match[1]), kinds[match[2]]);
  }
  return messages;
}

/** Lo mismo, de lo que emite keel-nest. */
function nestMessages(files) {
  const kinds = { Command: 'command', ReturningCommand: 'returningCommand', Query: 'query' };
  const messages = new Map();
  for (const file of files.filter((f) => /^src\/application\/(commands|queries)\//.test(f.path))) {
    const match = /export class (\w+) extends (Command|ReturningCommand|Query)\b/.exec(file.content);
    if (match) messages.set(goExported(match[1]), kinds[match[2]]);
  }
  return messages;
}

/** DTO → sus claves del cable en orden, de lo que emite keel-go. */
function goDtos(files) {
  const dtos = new Map();
  for (const file of files.filter((f) => /^internal\/application\/\w+_dto\.go$/.test(f.path))) {
    const name = /^type (\w+) struct \{$/m.exec(file.content)?.[1];
    const struct = file.content.slice(file.content.indexOf(`type ${name} struct {`), file.content.indexOf('\n}\n'));
    dtos.set(name, [...struct.matchAll(/`json:"([^",]+)/g)].map((match) => match[1]));
  }
  return dtos;
}

/** Lo mismo, de lo que emite keel-dotnet (que ya se mide contra keel-nest). */
function dotnetDtos(files) {
  const dtos = new Map();
  for (const file of files.filter((f) => /\.Application\/Dtos\//.test(f.path))) {
    const name = /public sealed record (\w+)/.exec(file.content)?.[1];
    if (!name || name === 'PagedResponse' || name === 'FileUpload') continue;
    dtos.set(goExported(name), [...file.content.matchAll(/\[JsonPropertyName\("([^"]+)"\)\]/g)].map((match) => match[1]));
  }
  return dtos;
}

for (const name of fixtures) {
  test(`${name}: los mensajes y su clase son los que emiten keel-nest y keel-dotnet`, () => {
    const go = goMessages(plans.get(name).files);
    assert.ok(go.size > 0);
    assert.deepEqual(sorted(go), sorted(dotnetMessages(other(planDotnet, name))));
    assert.deepEqual(sorted(go), sorted(nestMessages(other(planNest, name))));
  });

  test(`${name}: cada DTO lleva las claves de keel-dotnet, en el mismo orden (el del cable)`, () => {
    assert.deepEqual(sorted(goDtos(plans.get(name).files)), sorted(dotnetDtos(other(planDotnet, name))));
  });

  test(`${name}: cada operación tiene su campo en UseCases con el contrato de SU mensaje, y su handler nace fallando con su nombre`, () => {
    const { model, files } = plans.get(name);
    const wiring = app(files, 'use_cases');
    const test = files.find((file) => file.path === 'internal/application/use_cases_test.go').content;
    for (const operation of operations(model)) {
      const field = useCaseField(operation);
      assert.match(wiring, new RegExp(`^\\t${field} +${contractOf(operation).handler.replace(/[[\]]/g, '\\$&')}$`, 'm'), `${operation.name}: sin campo`);
      assert.ok(wiring.includes(`New${handlerType(operation)}(`), `${operation.name}: sin cablear`);
      assert.ok(test.includes(`{"${operation.name}", uc.${field} != nil},`), `${operation.name}: sin fila en la prueba del cableado`);
      const handler = files.find((file) => file.path.endsWith(`/${fileOf(handlerType(operation))}.go`)).content;
      assert.ok(!handler.includes(GENERATED_HEADER), `${operation.name}: el handler es del agente`);
      assert.ok(handler.includes(`fmt.Errorf("%w: %s", ErrNotImplemented, "${operation.name}")`), `${operation.name}: no nace fallando`);
      assert.match(handler, new RegExp(`func \\(h \\*${handlerType(operation)}\\) Handle\\(ctx context\\.Context, \\w+ ${messageType(operation)}\\)`));
    }
  });
}

test('la página lleva sus claves en el orden del cable', () => {
  const page = app(plans.get('product-catalog').files, 'paged_response');
  assert.deepEqual([...page.matchAll(/`json:"([^"]+)"`/g)].map((match) => match[1]), WIRE_SHAPES.pagedResponse);
});

test('con conventions.nulls: omit lo opcional lleva omitzero y una lista nunca; sin ella, nada lo lleva', () => {
  const omitting = plans.get('catalog-extended');
  assert.equal(omitting.model.service.omitNulls, true);
  const dtos = omitting.files.filter((f) => /^internal\/application\/\w+_dto\.go$/.test(f.path));
  assert.ok(dtos.some((file) => /\*\w+ +`json:"\w+,omitzero"`/.test(file.content)), 'algún opcional se omite');
  for (const file of dtos) assert.doesNotMatch(file.content, /\[\][\w.]+ +`json:"\w+,omitzero"`/, `${file.path}: una lista no se omite`);
  for (const file of plans.get('product-catalog').files.filter((f) => /_dto\.go$/.test(f.path))) assert.doesNotMatch(file.content, /omitzero/, file.path);
});

test('un PATCH declara sus opcionales con tres estados (wire.Optional) y lo de la ruta no viaja en el cuerpo', () => {
  const command = app(plans.get('catalog-extended').files, 'update_product_command');
  assert.match(command, /^\tID +uuid\.UUID +`json:"-"`$/m);
  assert.match(command, /^\tName +wire\.Optional\[string\] +`json:"name,omitzero"`$/m);
});

test('la consulta paginada recibe la página fuera del cuerpo: un Pageable con persistencia, dos enteros sin ella', () => {
  const query = app(plans.get('product-catalog').files, 'list_products_query');
  assert.match(query, /^\tPageable domain\.Pageable `json:"-"`$/m);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  delete layers.persistence;
  const { persistence, ...declared } = manifest.layers;
  assert.ok(persistence);
  const bare = planService({ manifest: { ...manifest, layers: declared }, layers, workspace: FIXTURES_DIR });
  const plain = app(bare.files, 'list_products_query');
  assert.match(plain, /^\tPage int32 `json:"-"`$/m);
  assert.match(plain, /^\tSize int32 `json:"-"`$/m);
  assert.ok(!bare.files.some((file) => file.path === 'internal/domain/pageable.go'), 'sin persistencia no hay Pageable');
});

test('las notas del diseño van en el handler: precondiciones, errores con su centinela, transiciones y eventos', () => {
  const { model, files } = plans.get('product-catalog');
  const operation = operations(model).find((op) => (op.errors ?? []).length > 0);
  const handler = files.find((file) => file.path.endsWith(`/${fileOf(handlerType(operation))}.go`)).content;
  assert.match(handler, /Error: devolver domain\.Errorf\(domain\.ErrSkuAlreadyExists, "…"\) \(SKU_ALREADY_EXISTS, HTTP 409\)/);
  const transitioning = operations(model).find((op) => (op.transitions ?? []).length > 0);
  assert.match(files.find((file) => file.path.endsWith(`/${fileOf(handlerType(transitioning))}.go`)).content, /Transición: Product .*\n.*transitionTo/);
  const mailer = plans.get('notification-mailer');
  const emitting = operations(mailer.model).find((op) => (op.emits ?? []).length > 0);
  assert.match(mailer.files.find((file) => file.path.endsWith(`/${fileOf(handlerType(emitting))}.go`)).content, /Emite: \w+ — lo hace \w+ con raise\(New\w+Event\(/);
});

test('el despacho entre casos de uso: el handler que despacha recibe UseCases y la nota nombra el campo por el que va', () => {
  const { model, files } = plans.get('asset-vault');
  const dispatching = operations(model).filter((op) => (op.dispatches ?? []).length > 0);
  assert.ok(dispatching.length > 0);
  for (const operation of dispatching) {
    const handler = files.find((file) => file.path.endsWith(`/${fileOf(handlerType(operation))}.go`)).content;
    assert.match(handler, /^\tuseCases \*UseCases$/m);
    assert.match(handler, new RegExp(`func New${handlerType(operation)}\\(useCases \\*UseCases\\)`));
    for (const target of operation.dispatches) {
      const invoked = operations(model).find((op) => op.name === target);
      // La nota va partida en líneas de comentario: se compara con el texto seguido.
      const notes = handler.replace(/\n\t\/\/ +/g, ' ');
      assert.ok(notes.includes(`h.useCases.${useCaseField(invoked)}.Handle(ctx, ${messageType(invoked)}{...})`), handler);
    }
    assert.doesNotMatch(handler, /CommandDispatcher|dispatchWithoutTransaction/, 'la nota nombra un puerto que keel-go no tiene');
    assert.ok(app(files, 'use_cases').includes(`New${handlerType(operation)}(uc)`));
  }
});

test('un mapeo que no se puede derivar devuelve ErrNotImplemented con el campo nombrado, y su archivo es del agente', () => {
  const mapper = app(plans.get('catalog-extended').files, 'product_image_mapper');
  assert.ok(!mapper.includes(GENERATED_HEADER));
  assert.match(mapper, /func ToProductImageDto\(entity \*domain\.ProductImage, productID uuid\.UUID\) \(ProductImageDto, error\)/);
  assert.match(mapper, /TODO \(agente\): ProductImageDto\.storageKey/);
  // Quien lo llama propaga el error en vez de tragárselo.
  const product = app(plans.get('catalog-extended').files, 'product_mapper');
  assert.match(product, /mapped, err := ToProductImageDto\(item, entity\.ID\(\)\)\n\t\tif err != nil \{\n\t\t\treturn \w+\{\}, err/);
  // Un mapeo completo no declara un error que nunca devuelve.
  assert.match(app(plans.get('product-catalog').files, 'product_mapper'), /func ToGetProductResponseDto\(entity \*domain\.Product\) GetProductResponseDto \{/);
});

test('scalePolicy: round en un decimal escalar de entrada se redondea al leer el mensaje (ninguna fixture lo declara)', () => {
  const operation = { route: { method: 'POST' } };
  const required = { name: 'amount', kind: 'base', base: 'decimal', goType: 'wire.Decimal', required: true, numeric: { decimal: true, scale: 2, scalePolicy: 'round' } };
  assert.equal(scaleRounding(operation, required), '\tm.Amount = m.Amount.Rescale(2, wire.RoundHalfUp)');
  assert.match(scaleRounding(operation, { ...required, required: false }), /if m\.Amount != nil \{\n\t\trounded := \(\*m\.Amount\)\.Rescale\(2, wire\.RoundHalfUp\)\n\t\tm\.Amount = &rounded/);
  assert.equal(scaleRounding(operation, { ...required, numeric: { ...required.numeric, scalePolicy: 'reject' } }), null);
  assert.equal(scaleRounding({ route: { method: 'PATCH' } }, { ...required, required: false }), null, 'un opcional de PATCH lo redondea el handler');
});

test('la aplicación solo importa el dominio, la plataforma del cable y la biblioteca estándar', () => {
  for (const [name, { model, files }] of plans) {
    for (const file of files.filter((f) => f.path.startsWith('internal/application/') && f.path.endsWith('.go'))) {
      for (const [, imported] of file.content.matchAll(/^\t?(?:\w+ )?"([^"]+)"$/gm)) {
        const own = imported.startsWith(`${model.service.goModule}/`);
        if (own) assert.match(imported, /\/internal\/(domain|platform\/wire)$/, `${name}: ${file.path} importa ${imported}`);
        else assert.ok(!imported.includes('.') || imported === 'github.com/google/uuid', `${name}: ${file.path} importa ${imported}`);
      }
    }
  }
});
