// El Go que emite build, juzgado como Go sin tener Go instalado: sintaxis, imports del propio módulo que llevan a un
// paquete emitido, imports que se usan (en Go uno sin usar no compila) y un solo paquete por directorio. Sobre el
// árbol de TODAS las fixtures: planService no pasa por la frontera, así que lo que emite para un diseño que build
// todavía rechaza también se juzga. Lo que esto no ve (tipos, miembros) lo ve `npm run go-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkGoTree } from './helpers/go-tree.js';
import { FIXTURES_DIR, makeWorkspace } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const workspace = makeWorkspace();

for (const fixture of fixtures) {
  test(`${fixture}: el Go emitido es sintaxis válida y sus imports se resuelven y se usan`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
    const { model, files } = planService({ manifest, layers, workspace });
    assert.ok(files.some((file) => file.path.endsWith('.go')), 'no se emitió ningún .go');
    assert.deepEqual(await checkGoTree(files, model.service.goModule), []);
  });
}

test('el comprobador se pone rojo con Go roto, un import sin usar y un paquete que no existe', async () => {
  const files = [
    { path: 'internal/a/a.go', content: 'package a\n\nfunc F() {\n' },
    { path: 'internal/b/b.go', content: 'package b\n\nimport "fmt"\n\nfunc G() {}\n' },
    { path: 'internal/c/c.go', content: 'package c\n\nimport "svc/internal/nope"\n\nvar _ = nope.X\n' },
    { path: 'internal/d/d.go', content: 'package d\n' },
    { path: 'internal/d/e.go', content: 'package e\n' }
  ];
  const problems = await checkGoTree(files, 'svc');
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems[0], /internal\/a\/a\.go:\d+: sintaxis/);
  assert.match(problems[1], /importa fmt y no lo usa/);
  assert.match(problems[2], /importa svc\/internal\/nope, que no es ningún paquete emitido/);
  assert.match(problems[3], /internal\/d: declara más de un paquete/);
});

test('un import con alias cuenta por su alias, y el de un paquete de prueba por su base', async () => {
  const files = [
    { path: 'cmd/server/main.go', content: 'package main\n\nimport configfiles "svc/config"\n\nvar _ = configfiles.Files\n' },
    { path: 'config/embed.go', content: 'package config\n\nvar Files int\n' },
    { path: 'config/embed_test.go', content: 'package config_test\n' }
  ];
  assert.deepEqual(await checkGoTree(files, 'svc'), []);
});
