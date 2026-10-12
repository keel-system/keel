// El TypeScript que emite `build` no lo compila nadie en esta suite: el resto de tests comparan
// CADENAS. Un template literal mal cerrado, un import a un archivo que se escribió en otro directorio
// o un símbolo que el módulo no exporta pasan todos los `includes(...)` y revientan mucho después,
// cuando un agente ejecuta `npm run typecheck` dentro del proyecto generado.
//
// Esto no sustituye a compilar (`npm run ts-check`, con red y minutos): cubre, en segundos y SIN
// instalar el proyecto, las tres familias de error que introduce construir código con plantillas
// —sintaxis, imports relativos que no llevan a ningún archivo y símbolos que el destino no exporta—
// sobre TODAS las fixtures. Es el equivalente de java-syntax.test.js de keel-spring, y como él se
// autocomprueba con código roto: un linter que solo sale en verde no distingue «no hay errores» de
// «no mira».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkCrossRefs, loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkTree } from './helpers/ts-tree.js';
import { DERIVED_SILHOUETTES, FIXTURES_DIR, derivedDesign } from './helpers/workspace.js';

test('el comprobador detecta TypeScript roto (autocomprobación)', () => {
  const broken = [
    { path: 'src/a.ts', content: 'export class A {\n  m() { return 1;\n}\n' },
    { path: 'src/b.ts', content: "import { A } from './no-existe.js';\nexport const b = A;\n" },
    { path: 'src/c.ts', content: "import { Missing } from './d.js';\nexport const c = Missing;\n" },
    { path: 'src/d.ts', content: 'export class D {}\n' },
    { path: 'src/e.ts', content: 'export const e = `sin cerrar;\n' }
  ];
  const problems = checkTree(broken);
  assert.ok(problems.some((p) => p.startsWith('src/a.ts:')), 'llave sin cerrar');
  assert.ok(problems.some((p) => /src\/b\.ts: importa '\.\/no-existe\.js'/.test(p)), 'import a un archivo inexistente');
  assert.ok(problems.some((p) => /src\/c\.ts: importa Missing/.test(p)), 'símbolo que el módulo no exporta');
  assert.ok(problems.some((p) => p.startsWith('src/e.ts:')), 'template literal sin cerrar');
  assert.ok(!problems.some((p) => p.startsWith('src/d.ts')), 'un archivo correcto no da hallazgos');
});

for (const name of fs.readdirSync(FIXTURES_DIR)) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  // Con mensajería, sobre cada broker que keel-nest genera.
  for (const broker of layers.messaging ? ['rabbitmq', 'kafka', 'snssqs'] : [null]) {
    test(`${name}${broker ? ` (${broker})` : ''}: el TypeScript emitido parsea y sus imports llevan a lo que exportan`, () => {
      const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: broker ? { broker } : null });
      assert.deepEqual(checkTree(files), []);
    });
  }
  // Con pagos, también con la otra pasarela del catálogo: lo que cambia es su adaptador y su verificador.
  if (layers.payments) {
    test(`${name} (mercadopago): el TypeScript emitido parsea y sus imports llevan a lo que exportan`, () => {
      const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { paymentGateway: 'mercadopago' } });
      assert.deepEqual(checkTree(files), []);
    });
  }
}

// Las siluetas que ninguna fixture tiene (incremento 16): mensajería sin persistencia y el compuesto saliente.
for (const silhouette of DERIVED_SILHOUETTES) {
  const { manifest, layers } = derivedDesign(silhouette, loadService);
  test(`${silhouette.name}: es un diseño válido (si no, build no llegaría a generarlo)`, () => {
    assert.deepEqual(checkCrossRefs({ layers, manifest }).errors, []);
  });
  for (const broker of layers.messaging ? ['rabbitmq', 'kafka', 'snssqs'] : [null]) {
    test(`${silhouette.name}${broker ? ` (${broker})` : ''}: el TypeScript emitido parsea y sus imports llevan a lo que exportan`, () => {
      const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: broker ? { broker } : null });
      assert.deepEqual(checkTree(files), []);
    });
  }
}
