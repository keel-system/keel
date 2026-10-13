// Ninguna librería con licencia comercial (PLAN-KEEL-DOTNET.md § 1.6), escrito en código: todo paquete que
// keel-dotnet puede emitir declara una licencia permisiva, ninguno es de los que pasaron a licencia
// comercial, y la regla se comprueba a sí misma con paquetes que sí la rompen. Lo que NuGet resuelve de
// verdad, transitivas incluidas, lo comprueba `npm run cs-check` contra el catálogo de nuget.org.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGES, licenseAllowed, licenseProblems, commercialRule } from '../src/lib/dotnet-stack.js';
import { packagesFor } from '../src/scaffold/project.js';

test('todo paquete de la tabla tiene versión exacta y licencia permisiva', () => {
  for (const [id, { version, license }] of Object.entries(PACKAGES)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${id}: versión no exacta (${version})`);
    assert.deepEqual(licenseProblems({ id, version, license }), [], id);
  }
});

test('todo paquete que emite el proyecto está en la tabla', () => {
  for (const id of packagesFor()) assert.ok(PACKAGES[id], `${id} se emite sin estar en dotnet-stack.js`);
});

test('la regla se pone roja con lo que pasó a licencia comercial, por versión', () => {
  assert.match(licenseProblems({ id: 'MediatR', version: '13.0.0', license: 'MIT' }).join(), /comercial/);
  assert.match(licenseProblems({ id: 'mediatr', version: '14.1.0', license: 'MIT' }).join(), /comercial/, 'el id no distingue mayúsculas');
  assert.match(licenseProblems({ id: 'MassTransit', version: '9.0.0', license: 'Apache-2.0' }).join(), /comercial/);
  assert.match(licenseProblems({ id: 'FluentAssertions', version: '8.0.0', license: 'Apache-2.0' }).join(), /no comercial/);
  assert.deepEqual(licenseProblems({ id: 'MediatR', version: '12.4.1', license: 'Apache-2.0' }), [], 'la última libre no está vetada por la regla');
  assert.ok(commercialRule('AutoMapper'));
});

test('la regla se pone roja con una licencia que no es permisiva o que no se puede leer', () => {
  assert.match(licenseProblems({ id: 'X', version: '1.0.0', license: 'GPL-3.0-only' }).join(), /fuera de/);
  assert.match(licenseProblems({ id: 'X', version: '1.0.0', license: null }).join(), /no declara licencia/);
});

test('una expresión SPDX compuesta: OR deja elegir, AND obliga a todas', () => {
  assert.equal(licenseAllowed('MIT OR GPL-3.0-only'), true);
  assert.equal(licenseAllowed('(Apache-2.0 OR MIT)'), true);
  assert.equal(licenseAllowed('MIT AND GPL-3.0-only'), false);
  assert.equal(licenseAllowed('MIT AND Apache-2.0'), true);
});
