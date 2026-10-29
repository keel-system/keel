// Solo licencias permisivas (PLAN-KEEL-GO.md § 1.6), escrito en código: todo módulo que keel-go puede emitir —de
// ejecución o herramienta— declara una licencia permisiva y una versión exacta, y la regla se comprueba a sí misma
// con módulos que la rompen. Lo que Go resuelve de verdad, transitivos y herramientas incluidos, lo comprueba
// `npm run go-check` con go-licenses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, TOOLS, licenseAllowed, licenseProblems } from '../src/lib/go-stack.js';
import { requiresFor, toolsFor } from '../src/scaffold/project.js';

test('todo módulo de la tabla tiene versión exacta y licencia permisiva', () => {
  for (const [path, { version, license, kind }] of Object.entries(MODULES)) {
    assert.match(version, /^v\d+\.\d+\.\d+$/, `${path}: versión no exacta (${version})`);
    assert.ok(['require', 'tool'].includes(kind), `${path}: kind ${kind}`);
    assert.deepEqual(licenseProblems({ path, version, license }), [], path);
  }
});

test('todo módulo que emite go.mod está en la tabla, y toda herramienta nombra su paquete', () => {
  for (const path of requiresFor()) assert.equal(MODULES[path]?.kind, 'require', `${path} se emite sin estar en go-stack.js`);
  for (const path of TOOLS) assert.ok(MODULES[path].tool?.startsWith(path), `${path}: el paquete de la herramienta no es de su módulo`);
  assert.equal(toolsFor().length, TOOLS.length);
});

test('la regla se pone roja con una licencia copyleft o de fuente disponible, también en una herramienta', () => {
  assert.match(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: 'GPL-3.0-only' }).join(), /prohibida/);
  assert.match(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: 'AGPL-3.0-or-later' }).join(), /prohibida/);
  assert.match(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: 'BUSL-1.1' }).join(), /prohibida/);
  assert.match(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: 'SSPL-1.0' }).join(), /prohibida/);
  assert.match(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: 'MPL-2.0' }).join(), /fuera de/, 'MPL-2.0 solo si es inevitable y queda escrito');
  assert.match(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: null }).join(), /no declara licencia/);
  // golangci-lint es GPL-3.0: vetado por nombre aunque alguien le pusiera otra licencia en la tabla.
  assert.match(licenseProblems({ path: 'github.com/golangci/golangci-lint/v2', version: 'v2.0.0', license: 'MIT' }).join(), /GPL-3\.0/);
});

test('una expresión SPDX compuesta: OR deja elegir, AND obliga a todas', () => {
  assert.equal(licenseAllowed('MIT OR GPL-3.0-only'), true);
  assert.equal(licenseAllowed('(Apache-2.0 OR MIT)'), true);
  assert.equal(licenseAllowed('MIT AND GPL-3.0-only'), false);
  assert.equal(licenseAllowed('MIT AND Apache-2.0'), true);
  assert.deepEqual(licenseProblems({ path: 'example.com/x', version: 'v1.0.0', license: 'MIT OR GPL-3.0-only' }), []);
});
