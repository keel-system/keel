// La escala de un decimal de ENTRADA (`adjustsInputScale` de keel-core/gen/constraints.js): con `scalePolicy: round` el
// mensaje lo redondea, y con `reject` lo rellena, porque el borde ya rechazó los decimales de más. Un `productPrice` de
// `30` tiene que salir `30.00`: keel-spring y keel-go lo daban porque su save relee la fila, y keel-nest y keel-dotnet
// devolvían la entidad en memoria con la escala que llegó, así que su agente escalaba a mano (corridas de shop-api de la
// 2.27 y la 2.31). Los cuatro generadores, sobre shop-api, cuyos importes declaran `scalePolicy: reject`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { adjustsInputScale } from '@keel-system/keel-core/gen/constraints';
import { planService as planGo } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

/** Por generador: el mensaje de una operación y la línea que pone `productPrice` a escala 2. */
const GENERATORS = {
  'keel-spring': { plan: planSpring, file: (op) => new RegExp(`/application/commands/${op}Command\\.java$`), adjust: /productPrice = productPrice\.setScale\(2, RoundingMode\.HALF_UP\)/ },
  'keel-nest': { plan: planNest, file: (op) => new RegExp(`/application/commands/${kebab(op)}-command\\.ts$`), adjust: /productPrice[^\n]*\.setScale\(2, 'HALF_UP'\)/ },
  'keel-dotnet': { plan: planDotnet, file: (op) => new RegExp(`/Commands/${op}Command\\.cs$`), adjust: /ProductPrice\s*\{[^}]*Decimals\.SetScale\(value, 2\)/ },
  'keel-go': { plan: planGo, file: (op) => new RegExp(`/application/${snake(op)}_command\\.go$`), adjust: /m\.ProductPrice = m\.ProductPrice\.Rescale\(2, wire\.RoundHalfUp\)/ }
};

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

test('adjustsInputScale: round redondea, reject rellena, sin política ni escala no hace nada', () => {
  assert.equal(adjustsInputScale({ decimal: true, scale: 2, scalePolicy: 'round' }), true);
  assert.equal(adjustsInputScale({ decimal: true, scale: 2, scalePolicy: 'reject' }), true);
  assert.equal(adjustsInputScale({ decimal: true, scale: 2, scalePolicy: null }), false);
  assert.equal(adjustsInputScale({ decimal: true, scale: null, scalePolicy: null }), false);
  assert.equal(adjustsInputScale({ decimal: false, scale: null, scalePolicy: null }), false);
  assert.equal(adjustsInputScale(null), false);
});

for (const [name, generator] of Object.entries(GENERATORS)) {
  test(`${name}: el mensaje de createProduct y de updateProduct pone a escala 2 el productPrice con scalePolicy: reject`, () => {
    const service = loadService(path.join(FIXTURES_DIR, 'shop-api'));
    const { files } = generator.plan({ ...service, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
    for (const operation of ['CreateProduct', 'UpdateProduct']) {
      const message = files.find((file) => generator.file(operation).test(file.path));
      assert.ok(message, `${name}: no encuentro el mensaje de ${operation}`);
      assert.match(message.content, generator.adjust, `${name}: ${operation} no ajusta la escala de productPrice`);
    }
  });
}

test('keel-go: el lector de la API ajusta la escala igual que el mensaje', () => {
  const service = loadService(path.join(FIXTURES_DIR, 'shop-api'));
  const { files } = planGo({ ...service, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } });
  const endpoints = files.find((file) => file.path === 'internal/httpapi/product_info_endpoints.go');
  assert.equal((endpoints.content.match(/ProductPrice\.Rescale\(2, wire\.RoundHalfUp\)/g) ?? []).length, 2);
});
