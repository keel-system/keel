import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAP_CLASSES, gapInventory } from '../src/lib/gap-classes.js';

// El catálogo de clases es la mitad mecánica de gap-analysis.md: si el documento gana una clase o
// la renombra y el código no, el inventario que imprime `keel validate --ready` deja de ser el del
// procedimiento que sigue el agente.

const DOC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets/skills/keel-design/references/gap-analysis.md'),
  'utf8'
);
const headings = new Map([...DOC.matchAll(/^### (\d+)\. (.+)$/gm)].map((match) => [Number(match[1]), match[2].trim()]));

test('las clases del catálogo son las de gap-analysis.md, con el mismo nombre', () => {
  assert.deepEqual(
    Object.keys(GAP_CLASSES).map(Number).sort((a, b) => a - b),
    [...headings.keys()].sort((a, b) => a - b)
  );
  for (const [number, entry] of Object.entries(GAP_CLASSES)) {
    assert.equal(entry.title, headings.get(Number(number)), `clase ${number}`);
  }
});

test('solo las clases 9 y 12 vetan el cierre accepted entero, como dice la doctrina', () => {
  const vetoed = Object.entries(GAP_CLASSES)
    .filter(([, entry]) => entry.acceptable === false)
    .map(([number]) => Number(number));
  assert.deepEqual(vetoed, [9, 12]);
  // El `http` de los errores (clase 2) y el orden (clase 5) también lo vetan, pero son UNA pregunta
  // dentro de su clase: vetar la clase entera prohibiría aceptar cualquier otro hallazgo suyo.
  assert.match(DOC, /toda la clase 9/);
  assert.match(DOC, /las convenciones de la clase 12/);
});

const layers = () => ({
  domain: {
    types: { OrderStatus: { values: ['open', 'closed'] } },
    entities: {
      Order: { fields: { id: { type: 'uuid', id: true }, status: { type: 'OrderStatus' }, receipt: { type: 'file', bucket: 'receipts' } } },
      Customer: { fields: { id: { type: 'uuid', id: true } } }
    }
  },
  'use-cases': {
    operations: {
      placeOrder: { kind: 'command' },
      listOrders: { kind: 'query', output: { entity: 'Order', list: true } },
      purgeOrders: { kind: 'command', internal: true, schedule: { cron: '0 0 * * *' } }
    }
  },
  api: { auto: true, endpoints: { listOrders: { audience: 'services' } } },
  messaging: { publishing: { events: { OrderPlaced: {} } }, subscriptions: { PaymentFailed: {} } },
  persistence: { entities: { Order: {} } }
});

const unitsOf = (inventory, number) => inventory.find((entry) => entry.class === number)?.units;

test('las unidades salen del diseño, con la forma con la que se escriben en gaps.yaml', () => {
  const inventory = gapInventory(layers());
  assert.deepEqual(unitsOf(inventory, 1), ['Order'], 'el enum sin lifecycle también cuenta');
  assert.deepEqual(unitsOf(inventory, 2), ['placeOrder', 'purgeOrders']);
  assert.deepEqual(unitsOf(inventory, 5), ['listOrders']);
  assert.deepEqual(unitsOf(inventory, 6), ['Order', 'Customer']);
  assert.deepEqual(unitsOf(inventory, 7), ['publishing.OrderPlaced', 'subscriptions.PaymentFailed']);
  assert.deepEqual(unitsOf(inventory, 9), ['placeOrder', 'listOrders', 'purgeOrders']);
  assert.deepEqual(unitsOf(inventory, 10), ['Order.receipt'], 'sin capa storage, el campo file es la unidad');
  assert.deepEqual(unitsOf(inventory, 11), ['listOrders']);
  assert.deepEqual(unitsOf(inventory, 12), ['service']);
  assert.deepEqual(unitsOf(inventory, 13), ['purgeOrders']);
  assert.deepEqual(unitsOf(inventory, 14), ['Order']);
  assert.deepEqual(unitsOf(inventory, 15), ['placeOrder', 'listOrders'], 'las internas no tienen superficie HTTP');
  assert.deepEqual(unitsOf(inventory, 16), ['3.1', '3.2', '3.3', '3.4', '3.5', '3.7', '3.8', '3.9', '3.9b']);
});

test('la clase 16 incluye la auditoría y la compensación, que también son entradas del catálogo', () => {
  // Faltaban en el inventario: la clase 16 no preguntaba quién decidió el rastro de auditoría ni la
  // compensación, y el registro estructural (decisions.yaml → structural) hereda este inventario.
  const conCompensacion = { ...layers(), dependencies: { dependencies: { ledger: { compensations: [{ onEvent: 'X' }] } } } };
  assert.ok(unitsOf(gapInventory(conCompensacion), 16).includes('3.11'));
  const sinPersistencia = { ...layers(), persistence: undefined };
  assert.ok(!unitsOf(gapInventory(sinPersistencia), 16).includes('3.9b'));
});

test('una clase sin unidades no aplica: el disparador y el inventario son la misma pregunta', () => {
  const inventory = gapInventory(layers());
  assert.equal(unitsOf(inventory, 17), undefined, 'sin capa mail no hay correo que recorrer');
  // Sin dependencies ni http-clients, la clase 8 aplica igual: una suscripción es un evento ajeno.
  assert.deepEqual(unitsOf(inventory, 8), ['subscriptions.PaymentFailed']);
});

test('tolera un diseño a medias: una capa rota no hace lanzar el inventario', () => {
  const broken = { domain: { entities: { Order: null } }, 'use-cases': { operations: { x: null } }, mail: { sentBy: 'x' } };
  assert.doesNotThrow(() => gapInventory(broken));
  assert.deepEqual(gapInventory({}), []);
});
