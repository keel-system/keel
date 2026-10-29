// La red de idioma (PLAN-KEEL-GO.md § 3): el Go que emite build se lee como Go. Sobre el árbol de TODAS las
// fixtures, y cada regla FALSADA con una mutación del texto emitido que la dispara a ella y solo a ella, como el
// corpus de design-mutations: una regla que nunca dispara no se distingue de una que no mira.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { IDIOM_RULES, checkGoIdioms } from './helpers/go-idioms.js';
import { FIXTURES_DIR, GO_READY_DESIGN, makeWorkspace } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const workspace = makeWorkspace();

function plan(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace }).files;
}

for (const fixture of fixtures) {
  test(`${fixture}: el Go emitido no tiene hallazgos de idioma`, () => {
    assert.deepEqual(checkGoIdioms(plan(fixture)), []);
  });
}

// Cada mutación toca UN archivo emitido: `file` es su ruta y `edit` lo transforma. Lo que se afirma es que dispara
// su regla y ninguna otra.
const MUTATIONS = {
  'no-init': { file: 'internal/httpapi/server.go', edit: (s) => `${s}\nfunc init() {\n}\n` },
  'no-default-client': {
    file: 'internal/httpapi/server.go',
    edit: (s) => `${s}\n// Ping pregunta.\nfunc Ping() {\n\t_, _ = http.Get("http://example.com")\n}\n`
  },
  'no-background-context': {
    file: 'internal/httpapi/server.go',
    edit: (s) => `${s}\n// Root devuelve un contexto.\nfunc Root() any {\n\treturn context.Background()\n}\n`
  },
  'no-panic': { file: 'internal/platform/health/health.go', edit: (s) => s.replace('p.draining.Store(true)', 'panic("drenando")') },
  'no-math-rand': { file: 'internal/httpapi/server.go', edit: (s) => s.replace('import (', 'import (\n\t"math/rand"') },
  'no-sleep-in-tests': { file: 'internal/platform/health/health_test.go', edit: (s) => s.replace('probes := &health.Probes{}', 'time.Sleep(time.Millisecond)\n\tprobes := &health.Probes{}') },
  'mixed-caps': { file: 'internal/platform/config/config.go', edit: (s) => s.replace('func splitProfiles(', 'func split_profiles(') },
  initialisms: { file: 'internal/platform/config/config.go', edit: (s) => s.replace('ApplicationName string', 'ApplicationName string\n\t// ServiceId identifica el servicio.\n\tServiceId string') },
  'package-name': { file: 'internal/platform/health/health.go', edit: (s) => s.replace('package health', 'package util') },
  'wrap-errors': {
    file: 'internal/platform/config/config.go',
    edit: (s) => s.replace('return nil, fmt.Errorf("leer %s: %w", name, err)', 'return nil, fmt.Errorf("leer %s: %v", name, err)')
  },
  'doc-comments': { file: 'internal/platform/health/health.go', edit: (s) => s.replace('// Draining dice si ha empezado el apagado ordenado.\n', '') },
  'server-timeouts': { file: 'internal/httpapi/server.go', edit: (s) => s.replace('\t\tIdleTimeout:       IdleTimeout,\n', '') }
};

test('no-panic admite el panic de una función Must… y solo ese', () => {
  const content = [
    'package wire',
    '',
    '// MustX lee un literal.',
    'func MustX(s string) int {',
    '\tpanic(s)',
    '}',
    '',
    '// Y no.',
    'func Y() {',
    '\tpanic("y")',
    '}',
    ''
  ].join('\n');
  assert.deepEqual(checkGoIdioms([{ path: 'internal/platform/wire/x.go', content }]), [
    'internal/platform/wire/x.go:10: no-panic — panic en el código emitido fuera de una función Must…: los errores se devuelven'
  ]);
});

test('no-panic admite relanzar lo que la misma función recuperó, y nada más', () => {
  const content = [
    'package httpapi',
    '',
    'func recoverPanic() {',
    '\trecovered := recover()',
    '\tif recovered == nil {',
    '\t\treturn',
    '\t}',
    '\tpanic(recovered)',
    '}',
    '',
    'func other(recovered any) {',
    '\tpanic(recovered)',
    '}',
    ''
  ].join('\n');
  assert.deepEqual(checkGoIdioms([{ path: 'internal/httpapi/x.go', content }]), [
    'internal/httpapi/x.go:12: no-panic — panic en el código emitido fuera de una función Must…: los errores se devuelven'
  ]);
});

test('toda regla de idioma tiene su mutación, y toda mutación nombra una regla', () => {
  assert.deepEqual(Object.keys(MUTATIONS).sort(), IDIOM_RULES.map((rule) => rule.id).sort());
});

for (const rule of IDIOM_RULES) {
  test(`${rule.id}: su mutación la dispara a ella sola`, () => {
    const mutation = MUTATIONS[rule.id];
    const files = plan(GO_READY_DESIGN.name).filter((file) => file.path.endsWith('.go'));
    const target = files.find((file) => file.path === mutation.file);
    assert.ok(target, `no se emite ${mutation.file}`);
    const mutated = mutation.edit(target.content);
    assert.notEqual(mutated, target.content, 'la mutación ya no se aplica: el texto que buscaba cambió');
    const findings = checkGoIdioms([{ path: mutation.file, content: mutated }]);
    assert.ok(findings.length > 0, `${rule.id} no dispara`);
    assert.deepEqual([...new Set(findings.map((finding) => finding.split(': ')[1].split(' — ')[0]))], [rule.id], findings.join('\n'));
  });
}
