// La evolución de un proyecto ya generado es NEUTRAL (keel-core/gen/evolution.js): el documento que
// lee el orquestador dice lo mismo para cualquier generador, y lo único de cada plataforma entra
// por parámetro. Aquí se fija esa frontera con una plataforma inventada: todo lo que la nombra sale
// del parámetro, y lo demás no nombra ninguna.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import {
  EVOLUTION_PLATFORM_KEYS,
  evolutionState,
  mergePrevious,
  renderEvolutionMarkdown,
  writeEvolution
} from '../src/lib/gen/evolution.js';

const PLATFORM = {
  generator: 'keel-zzz',
  skill: 'keel-generate-zzz',
  keepBuild: '**AVISO-DE-ZZZ**',
  scenarioWork: 'TRABAJO-DE-PRUEBAS-ZZZ.',
  duplicateStub: 'STUB-DUPLICADO-ZZZ'
};

const delta = {
  empty: false,
  from: '1.0.0',
  to: '1.1.0',
  layers: { added: [], removed: [] },
  sections: [{ layer: 'use-cases', section: 'operations', added: ['b'], removed: ['a'], changed: [] }],
  scenarios: { added: ['FL-B-001'], changed: [], removed: ['FL-A-001'], families: [] }
};

const state = () =>
  evolutionState({
    service: { name: 'demo', version: '1.1.0' },
    delta,
    pendingMerge: ['src/x'],
    notRecreated: ['src/stub']
  });

test('todo lo de la plataforma sale del parámetro, y lo demás no nombra ninguna', () => {
  const md = renderEvolutionMarkdown(state(), PLATFORM);
  for (const key of EVOLUTION_PLATFORM_KEYS) assert.ok(md.includes(PLATFORM[key]), `no se usa platform.${key}`);
  assert.match(md, /`keel-zzz build --check` sale en rojo/);
  assert.doesNotMatch(md, /gradle|integrationTest|@Component|spring|nest\b|vitest/i);
  assert.match(md, /v1\.0\.0 → v1\.1\.0/);
});

test('una plataforma incompleta se rechaza en vez de dejar un hueco en el documento', () => {
  const { scenarioWork, ...incomplete } = PLATFORM;
  assert.throws(() => renderEvolutionMarkdown(state(), incomplete), /scenarioWork/);
});

test('sin nada pendiente, writeEvolution retira el documento y la base congelada', () => {
  const dir = tmpDir('keel-evolution-');
  assert.equal(writeEvolution(dir, state(), PLATFORM), true);
  const refresh = path.join(dir, 'build', 'keel-refresh');
  fs.mkdirSync(path.join(refresh, 'base-specs'), { recursive: true });
  const done = evolutionState({ service: { name: 'demo', version: '1.1.0' } });
  assert.equal(done.pending, false);
  assert.equal(writeEvolution(dir, done, PLATFORM), false);
  assert.deepEqual(fs.readdirSync(refresh), []);
});

test('mergePrevious conserva el stub nuevo que aún tiene TODO y olvida el que ya no', () => {
  const dir = tmpDir('keel-evolution-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pendiente'), '// TODO');
  fs.writeFileSync(path.join(dir, 'src', 'hecho'), '// listo');
  const previous = { newWithTodo: ['src/pendiente', 'src/hecho'], stack: { added: [{ category: 'cache', value: 'redis' }], removed: [] } };
  const merged = mergePrevious(evolutionState({ service: { name: 'demo', version: '1.1.0' } }), previous, dir);
  assert.deepEqual(merged.newWithTodo, ['src/pendiente']);
  assert.deepEqual(merged.stack.added, [{ category: 'cache', value: 'redis' }]);
  assert.equal(merged.pending, true);
});
