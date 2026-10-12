// El comprobador de árboles TypeScript emitidos, SIN instalar el proyecto: sintaxis, imports relativos que no llevan a
// ningún archivo y símbolos que el destino no exporta. Lo usan ts-syntax.test.js (todas las fixtures) y los tests que
// derivan una silueta que ninguna fixture tiene; su autocomprobación vive en ts-syntax.test.js.

import path from 'node:path';
import ts from 'typescript';

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
