// El lector de cada operación (`read<Mensaje>(params, query, body)` del controlador) declara una variable por campo. Un campo
// que se llamaba como un parámetro o una variable del propio lector la redeclaraba: `Article.body` y `Comment.body` de
// conduit no compilaban (ts-check, DSL 2.23). ts-syntax no lo ve —redeclarar un const es un error de tipos, no de
// sintaxis—, así que aquí se mira en el texto: ningún lector declara un const con el nombre de sus parámetros ni el de
// otro const suyo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const READER = /^function (read\w+)\(params: Record<string, string>, query: Record<string, unknown>, body: unknown\): \w+ \{\n([\s\S]*?)\n\}/gm;

function readerProblems(files) {
  const problems = [];
  for (const file of files.filter((f) => f.path.endsWith('-controller.ts'))) {
    for (const [, name, body] of file.content.matchAll(READER)) {
      const declared = [...body.matchAll(/^ {2}const (\w+) =/gm)].map((m) => m[1]);
      for (const local of declared) {
        if (['params', 'query', 'body'].includes(local)) problems.push(`${file.path} ${name}: const ${local} redeclara un parámetro`);
      }
      const repeated = declared.filter((local, i) => declared.indexOf(local) !== i);
      for (const local of new Set(repeated)) problems.push(`${file.path} ${name}: const ${local} declarado dos veces`);
    }
  }
  return problems;
}

test('el detector caza un campo que se llama como un parámetro del lector', () => {
  const content = "function readX(params: Record<string, string>, query: Record<string, unknown>, body: unknown): X {\n  const fields = bodyObject(body, true);\n  const body = json.string(fields['body']);\n  return new X({ body: body });\n}";
  assert.deepEqual(readerProblems([{ path: 'x-controller.ts', content }]), ['x-controller.ts readX: const body redeclara un parámetro']);
});

for (const name of fs.readdirSync(FIXTURES_DIR)) {
  test(`${name}: ningún lector redeclara un parámetro ni una variable suya`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
    assert.deepEqual(readerProblems(files), []);
  });
}
