// Orden de los listados paginados: el `sort` del diseño como orden por defecto
// del endpoint, y el desempate por id que el adaptador añade SIEMPRE.
//
// El desempate es lo que arregla un defecto de corrección, no una preferencia:
// sin él, una consulta paginada cuyo ORDER BY empata puede devolver la misma fila
// en dos páginas y omitir otra, y ni la compilación ni los escenarios `FL-*`
// —que miran una página— lo ven.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');
const JAVA = 'src/main/java/com/commerce/catalog';
const CONTROLLER = `${JAVA}/infrastructure/rest/controllers/product/v1/ProductV1Controller.java`;
const ADAPTER = `${JAVA}/infrastructure/persistence/repositories/ProductRepositoryImpl.java`;

function scaffold(patch) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  if (patch) patch(patched);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-sort-'));
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');
  return { result, read };
}

test('sin sort declarado, el adaptador ordena igualmente por id: la paginación no queda al azar', () => {
  const { read } = scaffold();
  const adapter = read(ADAPTER);

  assert.ok(adapter.includes('private static final Sort TIE_BREAKER = Sort.by(Sort.Order.asc("id"));'));
  assert.ok(adapter.includes('findAll(withStableOrder(pageable))'));
  assert.ok(adapter.includes('sort.and(TIE_BREAKER)'));
  // El desempate no se salta si el cliente ya ordenó por id.
  assert.ok(adapter.includes('sort.getOrderFor("id") != null'));

  // Y sin sort declarado no hay constante de orden por operación.
  assert.ok(!read(CONTROLLER).includes('_ORDER'));
});

test('sort declarado: constante por operación en el controller, aplicada solo si el cliente no pide orden', () => {
  const { read } = scaffold((layers) => {
    layers['use-cases'].operations.listProducts.output.sort = ['name:asc', 'createdAt:desc'];
  });
  const controller = read(CONTROLLER);

  assert.ok(
    controller.includes(
      'private static final Sort LIST_PRODUCTS_ORDER = Sort.by(Sort.Order.asc("name"), Sort.Order.desc("createdAt"));'
    )
  );
  assert.ok(controller.includes('new ListProductsQuery(withDefaultOrder(pageable, LIST_PRODUCTS_ORDER))'));
  // El orden del cliente manda sobre el del diseño; el desempate del adaptador, sobre ambos.
  assert.ok(controller.includes('if (pageable.getSort().isSorted()) {'));
  // @PageableDefault sigue llevando solo el tamaño: un único `direction` no puede
  // expresar un orden mixto, y no alcanza al ?sort= del cliente.
  assert.ok(controller.includes('@PageableDefault(size = 20) Pageable pageable'));
  assert.ok(!/@PageableDefault\([^)]*sort/.test(controller));
});

test('sort por un subcampo de value object usa la columna aplanada', () => {
  const { read } = scaffold((layers) => {
    layers['use-cases'].operations.listProducts.output.sort = ['dimensions.width:asc'];
  });
  assert.ok(read(CONTROLLER).includes('Sort.by(Sort.Order.asc("dimensionsWidth"))'));
});

test('sort sobre un agregado embebido no se traduce: build avisa y lo deja al agente', () => {
  const { result, read } = scaffold((layers) => {
    layers['use-cases'].operations.listProducts.output.embed = ['category'];
    layers['use-cases'].operations.listProducts.output.sort = ['category.name:asc'];
  });

  assert.ok(
    result.warnings.some(
      (w) => w.includes("ordena por 'category.name'") && w.includes('join proyectado')
    )
  );
  // Sin constante: 'category.name' no es una property path de Spring Data, y
  // generarla haría fallar la consulta en tiempo de ejecución.
  assert.ok(!read(CONTROLLER).includes('_ORDER'));
  // La señal llega al sitio donde el agente decide.
  const handler = read(`${JAVA}/application/usecases/ListProductsQueryHandler.java`);
  assert.ok(handler.includes('campo del agregado embebido'));
  assert.ok(handler.includes('adaptador de LECTURA con JPQL proyectado'));
});

test('una raíz sin operaciones paginadas no gana el desempate: no hay list(Pageable) que ordenar', () => {
  const { read } = scaffold();
  const categoryAdapter = read(`${JAVA}/infrastructure/persistence/repositories/CategoryRepositoryImpl.java`);
  assert.ok(!categoryAdapter.includes('TIE_BREAKER'));
  assert.ok(!categoryAdapter.includes('withStableOrder'));
});
