// El C# que emite `build` no lo compila nadie en esta suite: el resto de tests comparan CADENAS. Una llave sin cerrar, un
// `${` de la plantilla JS que se evaluó dentro del C# o un `using` a un namespace que no se emitió pasan todos los
// `includes(...)` y revientan mucho después, en `cs-check` (SDK 10 y minutos) o cuando el agente compila el proyecto.
//
// Esto cubre, en segundos y SIN el SDK, la sintaxis y los `using` del propio servicio sobre TODAS las fixtures y las
// mismas variantes que compila cs-check (CS_VARIANTS). Es el equivalente de java-syntax.test.js de keel-spring y de
// ts-syntax.test.js de keel-nest, y como ellos se autocomprueba con código roto: un comprobador que solo sale en verde no
// distingue «no hay errores» de «no mira». La gramática entiende el C# 12-14 que emite keel-dotnet (constructores
// primarios, `field`, `required`, colecciones con spread); lo único que no leía, una expresión de colección como rama de
// un `?:`, se emite con `new Type[] { … }` (mediator.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkCsTree } from './helpers/cs-tree.js';
import { CS_VARIANTS, FIXTURES_DIR, fixtureNames, variantStack } from './helpers/workspace.js';

test('el comprobador detecta C# roto (autocomprobación)', async () => {
  const broken = [
    { path: 'src/A/Domain/A.cs', content: 'namespace A.Domain;\n\npublic sealed class A\n{\n    public int M() { return 1;\n}\n' },
    { path: 'src/A/Domain/B.cs', content: 'namespace A.Domain;\n\npublic static class B\n{\n    public static string S => "sin cerrar;\n}\n' },
    { path: 'src/A/Application/C.cs', content: 'namespace A.Application\n{\n    using A.NoExiste;\n    using System.Text;\n    using static A.Domain.B;\n    using D = A.Domain.A;\n\n    public sealed class C { }\n}\n' },
    { path: 'src/A/Application/D.cs', content: 'namespace A.Application;\n\nusing A.Domain;\n\npublic sealed class D { }\n' },
    { path: 'src/A/Application/E.cs', content: 'namespace A.Application;\n\npublic sealed class E { int X = ${count}; }\n' }
  ];
  const problems = await checkCsTree(broken);
  assert.ok(problems.some((p) => p.startsWith('src/A/Domain/A.cs:')), 'llave sin cerrar');
  assert.ok(problems.some((p) => p.startsWith('src/A/Domain/B.cs:')), 'cadena sin cerrar');
  assert.ok(problems.some((p) => p.startsWith('src/A/Application/E.cs:')), 'un ${ de la plantilla dentro del C#');
  assert.ok(problems.some((p) => /src\/A\/Application\/C\.cs:3: using A\.NoExiste/.test(p)), 'using del servicio a un namespace que no se emitió');
  // Lo ajeno al servicio, el using static y el alias no se juzgan; el using a un namespace emitido es correcto.
  assert.ok(!problems.some((p) => /System\.Text|A\.Domain\.B|A\.Domain\.A/.test(p)), problems.join('\n'));
  assert.ok(!problems.some((p) => p.startsWith('src/A/Application/D.cs')), 'un archivo correcto no da hallazgos');
});

const designs = [...fixtureNames().map((name) => ({ name, from: name })), ...CS_VARIANTS];
for (const { name, from, mutate, broker, paymentGateway, telemetry } of designs) {
  test(`${name}: el C# emitido parsea y sus using del servicio llevan a un namespace emitido`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    if (mutate) mutate(manifest, layers, name);
    const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: variantStack(layers, { broker, paymentGateway, telemetry }) });
    assert.ok(files.some((file) => file.path.endsWith('.cs')), 'emite C#');
    assert.deepEqual(await checkCsTree(files), []);
  });
}
