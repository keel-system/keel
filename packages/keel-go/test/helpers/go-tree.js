// El comprobador de árboles Go sin SDK: un parser de Go en WebAssembly (web-tree-sitter + tree-sitter-go, MIT, de
// desarrollo) sobre el árbol en memoria que planifica build. Cubre las familias de error que introduce construir Go
// con plantillas y que los tests de cadenas no ven:
//   · la SINTAXIS (una llave sin cerrar, un `${` de la plantilla que se comió un trozo);
//   · el import del propio módulo que no lleva a ningún paquete emitido;
//   · el import que el archivo NO USA, que en Go no es un aviso sino un error de compilación (PLAN-KEEL-GO.md § 6).
// No sustituye a compilar (`npm run go-check`, con Go y minutos): no resuelve tipos ni miembros.
//
// Vive en un helper y no en el test para que lo pueda importar otro test sin registrar las pruebas dos veces.

import path from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import { packageNameOf } from '../../src/lib/go-source.js';

const require = createRequire(import.meta.url);
let parser = null;

export async function goParser() {
  if (parser) return parser;
  await Parser.init();
  const wasm = path.join(path.dirname(require.resolve('tree-sitter-go/package.json')), 'tree-sitter-go.wasm');
  parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  return parser;
}

/** Los nodos ERROR y MISSING del árbol, en orden: solo se baja por las ramas que tienen alguno. */
function syntaxProblems(node, out = []) {
  if (node.isError || node.isMissing) {
    out.push(node);
    return out;
  }
  for (const child of node.children) if (child.hasError || child.isMissing) syntaxProblems(child, out);
  return out;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

/** Los imports de un archivo: ruta, nombre con el que se usa y línea. */
function importsOf(root) {
  const imports = [];
  walk(root, (node) => {
    if (node.type !== 'import_spec') return;
    const pathNode = node.childForFieldName('path');
    const nameNode = node.childForFieldName('name');
    const importPath = pathNode.text.slice(1, -1);
    imports.push({ path: importPath, name: nameNode ? nameNode.text : packageNameOf(importPath), line: node.startPosition.row + 1 });
  });
  return imports;
}

/** Los identificadores que se usan como operando de un selector (`fmt.Println` → `fmt`). */
function selectorOperands(root) {
  const used = new Set();
  walk(root, (node) => {
    if (node.type === 'selector_expression' || node.type === 'qualified_type') {
      const operand = node.childForFieldName('operand') ?? node.childForFieldName('package');
      if (operand && (operand.type === 'identifier' || operand.type === 'package_identifier')) used.add(operand.text);
    }
  });
  return used;
}

/** El paquete que declara un archivo: el nombre de su cláusula package. */
function packageClause(root) {
  const clause = root.namedChildren.find((node) => node.type === 'package_clause');
  return clause?.namedChildren[0]?.text ?? null;
}

/**
 * Los hallazgos de un árbol emitido, como texto (`<ruta>:<línea>: …`); vacío si está limpio. Mira los `.go`: la
 * sintaxis de cada uno, que todo import del propio módulo nombre un directorio con algún `.go` emitido, que todo
 * import se use, y que todos los archivos de un directorio declaren el mismo paquete (con su `_test`).
 */
export async function checkGoTree(files, module) {
  const sources = files.filter((file) => file.path.endsWith('.go') && typeof file.content === 'string');
  const go = await goParser();
  const problems = [];
  const directories = new Set(sources.map((file) => path.posix.dirname(file.path)));
  const packagesByDir = new Map();
  for (const file of sources) {
    const tree = go.parse(file.content);
    try {
      const root = tree.rootNode;
      if (root.hasError) {
        const [first, ...rest] = syntaxProblems(root);
        const at = first ?? root;
        const line = file.content.split('\n')[at.startPosition.row]?.trim().slice(0, 120) ?? '';
        problems.push(`${file.path}:${at.startPosition.row + 1}: sintaxis (${at.isMissing ? `falta ${at.type}` : 'ERROR'}${rest.length ? ` y ${rest.length} más` : ''}) — ${line}`);
        continue;
      }
      const pkg = packageClause(root);
      const dir = path.posix.dirname(file.path);
      const base = pkg?.replace(/_test$/, '');
      if (!packagesByDir.has(dir)) packagesByDir.set(dir, new Set());
      packagesByDir.get(dir).add(base);
      const used = selectorOperands(root);
      for (const spec of importsOf(root)) {
        if (spec.path.startsWith(`${module}/`) && !directories.has(spec.path.slice(module.length + 1))) {
          problems.push(`${file.path}:${spec.line}: importa ${spec.path}, que no es ningún paquete emitido`);
        }
        if (spec.name !== '_' && spec.name !== '.' && !used.has(spec.name)) {
          problems.push(`${file.path}:${spec.line}: importa ${spec.path} y no lo usa (en Go no compila)`);
        }
      }
    } finally {
      tree.delete();
    }
  }
  for (const [dir, names] of packagesByDir) {
    if (names.size > 1) problems.push(`${dir}: declara más de un paquete (${[...names].join(', ')})`);
  }
  return problems;
}
