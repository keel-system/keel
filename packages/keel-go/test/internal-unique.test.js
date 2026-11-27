// La clave única GLOBAL de una hija (keel-core/gen/internal-unique.js): `ExistsBy<Campo>` en el puerto de la raíz, con
// SQL sobre la tabla de la hija y con MongoDB sobre la ruta del array embebido, sobre los sujetos de
// keel-core/test/helpers/internal-unique-designs.js; y el mismo método en los cuatro generadores. Corrida payment-dotnet,
// 2026-11-27: el agente lo escribió a mano en el puerto y el adaptador generados.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { INTERNAL_UNIQUE_DESIGNS } from '../../keel-core/test/helpers/internal-unique-designs.js';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function filesOf(plan, design, database) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  manifest.service.name = design.name;
  design.mutate(layers);
  return plan({ manifest, layers, workspace: FIXTURES_DIR, stack: { database } }).files;
}
const all = (files, pattern) => files.filter((file) => pattern.test(file.path)).map((file) => file.content).join('\n');

test('relacional: el puerto pregunta y el adaptador consulta la tabla de la hija', () => {
  for (const database of ['postgresql', 'mysql']) {
    const files = filesOf(planService, INTERNAL_UNIQUE_DESIGNS[0], database);
    const go = all(files, /\.go$/);
    assert.match(go, /ExistsByCode\(ctx context\.Context, code string\) \(bool, error\)/, database);
    const query = /"SELECT EXISTS \(SELECT 1 FROM (\S+) WHERE (\S+) = (\S+)\)"/.exec(go);
    assert.ok(query, database);
    assert.deepEqual(query.slice(1).map((part) => part.replaceAll('`', '')), ['template_variables', 'code', database === 'mysql' ? '?' : '$1'], database);
  }
});

test('documental: la consulta va por la ruta del array embebido', () => {
  const go = all(filesOf(planService, INTERNAL_UNIQUE_DESIGNS[1], 'mongodb'), /\.go$/);
  assert.match(go, /CountDocuments\(ctx, bson\.D\{\{Key: "variables\.code", Value: code\}\}, options\.Count\(\)\.SetLimit\(1\)\)/);
});

test('el mismo método en los cuatro generadores, relacional y documental', () => {
  const names = (text, pattern) => [...new Set([...text.matchAll(pattern)].map((match) => match[1].toLowerCase()))].sort();
  for (const [index, database] of [[0, 'postgresql'], [1, 'mongodb']]) {
    const design = INTERNAL_UNIQUE_DESIGNS[index];
    const expected = names(all(filesOf(planService, design, database), /\.go$/), /\b(ExistsBy\w+)\(ctx/g);
    assert.deepEqual(expected, ['existsbycode'], database);
    assert.deepEqual(names(all(filesOf(planSpring, design, database), /domain\/repository\/.*\.java$/), /boolean (existsBy\w+)\(/g), expected, `spring ${database}`);
    assert.deepEqual(names(all(filesOf(planNest, design, database), /\.ts$/), /abstract (existsBy\w+)\(/g), expected, `nest ${database}`);
    assert.deepEqual(names(all(filesOf(planDotnet, design, database), /Repository\/I\w+\.cs$/), /Task<bool> (ExistsBy\w+)\(/g), expected, `dotnet ${database}`);
  }
});
