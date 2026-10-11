// El orden de una colección hija desempata por id (corrida catalog de keel-spring, 2026-10-11).
//
// `ProductImage.position` ordena la galería, y una regla del diseño dice que dos imágenes pueden
// compartir posición y que el orden entre ellas lo desempata su id. Ninguno de los dos generadores lo
// hacía: el orden de las empatadas lo decidía el motor. Aquí se EJECUTA la comparación que emite el
// adaptador de keel-nest y se compara con la `@OrderBy` que emite keel-spring.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const ADAPTER = 'src/infrastructure/persistence/repositories/product-repository-impl.ts';

function emittedAdapter() {
  const files = Object.fromEntries(planFixture('catalog-extended', { stack: STACK }).files.map((f) => [f.path, f.content]));
  return files[ADAPTER];
}

/** Las dos funciones de comparación del adaptador, transpiladas y listas para llamar. */
function comparators(adapter) {
  const pick = (name) => {
    const start = adapter.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `el adaptador no emite ${name}`);
    const end = adapter.indexOf('\n}', start) + 2;
    return adapter.slice(start, end);
  };
  const source = `${pick('compareOrder')}\n${pick('compareId')}\nmodule.exports = { compareOrder, compareId };`;
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports;
}

test('keel-nest: dos hijas con la misma posición salen en el orden de su id', () => {
  const adapter = emittedAdapter();
  assert.match(adapter, /\.sort\(\(a, b\) => compareOrder\(a\.position, b\.position\) \|\| compareId\(a\.id, b\.id\)\)/);

  const { compareOrder, compareId } = comparators(adapter);
  const images = [
    { id: '0190f5a0-0000-7000-8000-00000000000c', position: 1 },
    { id: '0190f5a0-0000-7000-8000-00000000000a', position: 1 },
    { id: '0190f5a0-0000-7000-8000-00000000000b', position: 0 }
  ];
  const sorted = [...images].sort((a, b) => compareOrder(a.position, b.position) || compareId(a.id, b.id));
  assert.deepEqual(sorted.map((image) => image.id.slice(-1)), ['b', 'a', 'c']);
  // Y el desempate no se come el orden: sin empate, manda la posición.
  assert.ok(compareOrder(0, 1) < 0);
});

test('keel-spring ordena igual: posición y, ante empate, id', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
  const jpa = spring.find((f) => f.path.endsWith('/ProductJpa.java')).content;
  assert.ok(jpa.includes('@OrderBy("position ASC, id ASC")'), jpa);
});
