// La clave única GLOBAL de una hija (keel-core/gen/internal-unique.js): `existsBy<Campo>` en el puerto de la raíz, en
// TypeORM (sobre la tabla de la hija) y en MongoDB (la ruta del array embebido), sobre los sujetos de
// keel-core/test/helpers/internal-unique-designs.js; y el mismo nombre que en keel-spring. Corrida payment-dotnet, 2026-11-27.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { INTERNAL_UNIQUE_DESIGNS } from '../../keel-core/test/helpers/internal-unique-designs.js';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function filesOf(plan, design, document) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  manifest.service.name = design.name;
  design.mutate(layers);
  return plan({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } }).files;
}
const all = (files, pattern) => files.filter((file) => pattern.test(file.path)).map((file) => file.content).join('\n');

test('relacional: el puerto pregunta y el adaptador consulta la tabla de la hija', () => {
  const files = filesOf(planService, INTERNAL_UNIQUE_DESIGNS[0], false);
  assert.match(all(files, /template-repository\.ts$/), /abstract existsByCode\(code: string\): Promise<boolean>;/);
  assert.match(all(files, /template-repository.*\.ts$/), /async existsByCode\(code: string\): Promise<boolean> \{\n {4}return this\.manager\.exists\(TemplateVariableOrm, \{ where: \{ code \} \}\);/);
});

test('documental: la consulta va por la ruta del array embebido', () => {
  const files = filesOf(planService, INTERNAL_UNIQUE_DESIGNS[1], true);
  assert.match(all(files, /template-repository.*\.ts$/), /countDocuments\(\{ 'variables\.code': code \}, \{ session: this\.session, limit: 1 \}\)\) > 0;/);
});

test('el mismo método en keel-spring: un solo nombre por clave en los dos puertos', () => {
  for (const [index, document] of [[0, false], [1, true]]) {
    const nest = all(filesOf(planService, INTERNAL_UNIQUE_DESIGNS[index], document), /\.ts$/);
    const spring = all(filesOf(planSpring, INTERNAL_UNIQUE_DESIGNS[index], document), /domain\/repository\/.*\.java$/);
    const names = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]).sort();
    assert.deepEqual(names(nest, /abstract (existsBy\w+)\(/g), names(spring, /boolean (existsBy\w+)\(/g));
    assert.deepEqual(names(nest, /abstract (existsBy\w+)\(/g), ['existsByCode']);
  }
});
