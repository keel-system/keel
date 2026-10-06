// El gate del formato de los value types escalares (infra/check-domain-guards.sh) se EJECUTA con
// bash sobre el árbol emitido, como en keel-spring: un `includes(...)` no distingue un script que
// busca bien de uno que no encuentra nada. Y sus filas son las MISMAS que las del gate de keel-spring
// para el mismo diseño: los dos servidores vigilan los mismos campos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const bash = spawnSync('bash', ['--version']).status === 0;

function writeTree(files) {
  const dir = tmpDir('keel-nest-guards-');
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  return dir;
}

const run = (dir) => spawnSync('bash', ['infra/check-domain-guards.sh'], { cwd: dir, encoding: 'utf8' });
const HANDLER = 'src/application/usecases/create-product-command-handler.ts';

test('recién generado sale ROJO nombrando el campo; con la llamada en un comentario, también', { skip: !bash && 'sin bash' }, () => {
  const { files } = planFixture('product-catalog');
  const dir = writeTree(files);
  const fresh = run(dir);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stdout, /Product\.sku: nadie llama a SKUFormat\.validate/);
  const handler = path.join(dir, HANDLER);
  fs.writeFileSync(handler, fs.readFileSync(handler, 'utf8').replace("throw new Error('TODO: createProduct');", "// SKUFormat.validate(command.sku);\n    throw new Error('TODO: createProduct');"));
  assert.equal(run(dir).status, 1, 'una llamada en un comentario no cuenta');
});

test('con una llamada real sale VERDE; sin la clase generada, lo dice en vez de pedir la llamada', { skip: !bash && 'sin bash' }, () => {
  const { files } = planFixture('product-catalog');
  const dir = writeTree(files);
  const handler = path.join(dir, HANDLER);
  fs.writeFileSync(handler, fs.readFileSync(handler, 'utf8').replace("throw new Error('TODO: createProduct');", "SKUFormat.validate(command.sku);\n    throw new Error('TODO: createProduct');"));
  const green = run(dir);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /valueTypeFormat {6}OK/);
  fs.rmSync(path.join(dir, 'src/domain/valueobject/sku-format.ts'));
  const missing = run(dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no existe src\/domain\/valueobject\/sku-format\.ts — lo genera build/);
});

/** Los sujetos (`Entidad.campo`) de un check-domain-guards.sh. */
const subjects = (script) => [...script.matchAll(/^guard '([^']+)'/gm)].map((match) => match[1]);

for (const name of fs.readdirSync(FIXTURES_DIR)) {
  test(`${name}: el gate vigila los mismos campos que el de keel-spring`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.find((f) => f.path === 'infra/check-domain-guards.sh');
    const nest = planFixture(name).files.find((f) => f.path === 'infra/check-domain-guards.sh');
    assert.equal(Boolean(nest), Boolean(spring), 'los dos generan el gate, o ninguno');
    if (spring) assert.deepEqual(subjects(nest.content), subjects(spring.content));
  });
}
