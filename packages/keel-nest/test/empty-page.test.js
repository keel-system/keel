// La página vacía del contrato (wire-contract.md): sin elementos, cero elementos y cero páginas, también fuera de rango. keel-go lo
// hizo en su NewPage tras la corrida catalog (2026-11-02); aquí EJECUTA `pageOf` y comprueba que keel-spring, keel-nest y keel-dotnet
// construyen su página en un solo sitio, con todas las fixtures. Con motor, lo miden db-check, doc-check y finder-check (`--sabotage=empty-page`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planNest } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const FIXTURES = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

function plannedFiles(plan, fixture) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return plan({ manifest, layers, workspace: FIXTURES_DIR }).files;
}

test('keel-nest: pageOf da la página vacía fuera de rango y los totales con elementos', async () => {
  const { files } = planFixture('product-catalog');
  const { load } = transpileTree(files);
  const { pageOf, mapPage } = await load('src/domain/repository/page.ts');
  const pageable = { page: 5, size: 2, sort: [] };
  assert.deepEqual(pageOf([], pageable, 3), { items: [], page: 5, size: 2, totalElements: 0, totalPages: 0 });
  assert.deepEqual(pageOf(['a'], { page: 1, size: 2, sort: [] }, 3), { items: ['a'], page: 1, size: 2, totalElements: 3, totalPages: 2 });
  assert.deepEqual(mapPage(pageOf([], pageable, 3), (item) => item), { items: [], page: 5, size: 2, totalElements: 0, totalPages: 0 });
});

for (const fixture of FIXTURES) {
  test(`keel-nest, ${fixture}: ningún adaptador compone los totales de una página por su cuenta`, () => {
    const adapters = plannedFiles(planNest, fixture).filter((file) => file.path.endsWith('.ts') && !file.path.endsWith('repository/page.ts'));
    assert.deepEqual(adapters.filter((file) => /totalElements: total|Math\.ceil\(total/.test(file.content)).map((file) => file.path), []);
  });

  test(`keel-dotnet, ${fixture}: ningún adaptador compone los totales de una página por su cuenta`, () => {
    const adapters = plannedFiles(planDotnet, fixture).filter((file) => file.path.endsWith('.cs') && !file.path.endsWith('Repository/Page.cs'));
    assert.deepEqual(adapters.filter((file) => /new Page<|Math\.Ceiling\(total/.test(file.content)).map((file) => file.path), []);
  });
}

test('keel-dotnet: la fábrica de la página lleva la forma de la página vacía', () => {
  const page = plannedFiles(planDotnet, 'product-catalog').find((file) => file.path.endsWith('Repository/Page.cs'));
  assert.ok(page, 'no se emite Page.cs');
  assert.match(page.content, /if \(items\.Count == 0\)\s+\{\s+return new Page<T>\(items, pageable\.Page, pageable\.Size, 0, 0\);/);
});

test('keel-spring: PagedResponse.from lleva la forma de la página vacía', () => {
  const response = plannedFiles(planSpring, 'product-catalog').find((file) => file.path.endsWith('/PagedResponse.java'));
  assert.ok(response, 'no se emite PagedResponse.java');
  assert.match(response.content, /if \(page\.getContent\(\)\.isEmpty\(\)\) \{\s+return new PagedResponse<>\(page\.getContent\(\), page\.getNumber\(\), page\.getSize\(\), 0, 0\);/);
});
