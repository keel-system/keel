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
import ts from 'typescript';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

/**
 * Errores de sintaxis de un archivo TypeScript: los del PARSER, sin tipos. `parseDiagnostics` no es
 * API pública del compilador, pero es la única que da los errores de sintaxis de cualquier archivo
 * —`transpileModule` no sirve con un `.d.ts`, que no produce salida—; si una versión la quitara, la
 * autocomprobación de abajo caería en vez de dejar esto en verde sin mirar.
 */
export function syntaxErrors(fileName, content) {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  if (!Array.isArray(source.parseDiagnostics)) throw new Error('typescript ya no expone parseDiagnostics');
  return source.parseDiagnostics.map((d) => `${fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

/** Lo que un módulo exporta y lo que importa, leídos del AST. */
function moduleShape(fileName, content) {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.ES2023, true);
  const exported = new Set();
  const imports = [];
  for (const statement of source.statements) {
    const isExported = ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export;
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      const named = statement.importClause?.namedBindings;
      const names = named && ts.isNamedImports(named) ? named.elements.map((e) => (e.propertyName ?? e.name).text) : [];
      imports.push({ specifier, names });
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add(element.name.text);
    } else if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) exported.add(declaration.name.getText(source));
    } else if (isExported && statement.name) {
      exported.add(statement.name.text);
    }
  }
  return { exported, imports };
}

/** Comprueba un árbol emitido entero: sintaxis, imports relativos y símbolos importados. */
export function checkTree(files) {
  const problems = [];
  const tsFiles = files.filter((file) => file.path.endsWith('.ts'));
  const shapes = new Map();
  for (const file of tsFiles) {
    problems.push(...syntaxErrors(file.path, file.content));
    shapes.set(file.path, moduleShape(file.path, file.content));
  }
  for (const [from, { imports }] of shapes) {
    for (const { specifier, names } of imports) {
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.join(path.posix.dirname(from), specifier).replace(/\.js$/, '.ts');
      const shape = shapes.get(target);
      if (!shape) {
        problems.push(`${from}: importa '${specifier}', que no es ningún archivo emitido`);
        continue;
      }
      for (const name of names) {
        if (!shape.exported.has(name)) problems.push(`${from}: importa ${name} de '${specifier}', que no lo exporta`);
      }
    }
  }
  return problems;
}

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
  // Con mensajería, sobre cada broker que keel-nest genera (SNS/SQS, la frontera lo rechaza todavía).
  for (const broker of layers.messaging ? ['rabbitmq', 'kafka'] : [null]) {
    test(`${name}${broker ? ` (${broker})` : ''}: el TypeScript emitido parsea y sus imports llevan a lo que exportan`, () => {
      const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: broker ? { broker } : null });
      assert.deepEqual(checkTree(files), []);
    });
  }
}
