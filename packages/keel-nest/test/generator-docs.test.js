// El conocimiento del generador dentro del proyecto (incremento 7c): la skill orquestadora, los cinco
// agentes, las convenciones y la skill de la base, proyectados a cada harness. Lo que se mide es lo que
// se rompe en silencio: un asset que existe y nadie instala, un token sin resolver que el agente lee
// literal, o una doc compartida que cita la ruta de UN harness y miente al que usa el otro.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES } from 'keel-core';
import { AGENTS, CONVENTIONS, GUIDES, DOCS_DIR } from '../src/scaffold/generator-docs.js';
import { planFixture } from './helpers/emitted.js';
import { NEST_READY_DESIGN } from './helpers/workspace.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const files = byPath(planFixture(NEST_READY_DESIGN.name).files);

test('todo agente y toda convención de assets/ se instala (las listas son el único punto de instalación)', () => {
  assert.deepEqual([...AGENTS].sort(), fs.readdirSync(path.join(assets, 'agents')).sort());
  assert.deepEqual([...CONVENTIONS].sort(), fs.readdirSync(path.join(assets, 'generators', 'nest', 'conventions')).sort());
  for (const name of [...GUIDES, ...CONVENTIONS.map((c) => `conventions/${c}`)]) {
    assert.ok(`${DOCS_DIR}/${name}` in files, `${name} se emite en ${DOCS_DIR}/`);
  }
});

test('cada harness recibe su contexto, la skill orquestadora, los cinco agentes y la skill de la base', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.contextFile in files, `${harness.id}: ${harness.contextFile}`);
    assert.ok(harness.skillPath('keel-generate-nest', 'SKILL.md') in files, `${harness.id}: skill orquestadora`);
    assert.ok(harness.skillPath('keel-nest-database', 'SKILL.md') in files, `${harness.id}: skill de la base`);
    for (const agent of AGENTS) {
      const name = agent.replace(/\.md$/, '');
      assert.ok(Object.keys(files).some((file) => file.includes(name) && !file.startsWith(DOCS_DIR)), `${harness.id}: agente ${name}`);
    }
  }
});

test('ningún archivo emitido deja un token {{keel:…}} sin resolver', () => {
  const leftovers = Object.entries(files).filter(([, content]) => /\{\{keel:\w+\}\}/.test(content)).map(([file]) => file);
  assert.deepEqual(leftovers, []);
});

test('las docs compartidas no citan la ruta ni el archivo de contexto de un harness concreto', () => {
  const harnessPaths = /\.claude\/|\.opencode\/|CLAUDE\.md|AGENTS\.md/;
  for (const [file, content] of Object.entries(files)) {
    if (!file.startsWith(`${DOCS_DIR}/`)) continue;
    assert.doesNotMatch(content, harnessPaths, file);
  }
});

test('los agentes son hojas: ninguno puede lanzar subagentes', () => {
  for (const agent of AGENTS) {
    const source = fs.readFileSync(path.join(assets, 'agents', agent), 'utf8');
    assert.match(source, /^spawns: false$/m, agent);
  }
});

test('la skill de la base solo se instala con persistencia relacional', () => {
  const bare = byPath(planFixture(NEST_READY_DESIGN.name, { withoutLayers: ['persistence'] }).files);
  assert.ok(!Object.keys(bare).some((file) => file.includes('keel-nest-database')));
});
