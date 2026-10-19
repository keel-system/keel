// El comprobador de árboles C# sin SDK: un parser de C# en WebAssembly (web-tree-sitter + tree-sitter-c-sharp, MIT, de
// desarrollo) sobre el árbol en memoria que planifica build. Cubre las dos familias de error que introduce construir C# con
// plantillas y que los tests de cadenas no ven: la SINTAXIS (una llave sin cerrar, un `${` de la plantilla que se comió un
// trozo) y el `using` del propio servicio que no lleva a ningún namespace emitido. No sustituye a compilar
// (`npm run cs-check`, con SDK y minutos): no resuelve tipos ni miembros.
//
// Vive en un helper y no en el test para que lo pueda importar otro test sin registrar las pruebas dos veces.

import path from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
let parser = null;

async function csParser() {
  if (parser) return parser;
  await Parser.init();
  const wasm = path.join(path.dirname(require.resolve('tree-sitter-c-sharp/package.json')), 'tree-sitter-c_sharp.wasm');
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

/** El nombre al que apunta un `using`, o null si es `using static` o un alias (`using X = …`), que no nombran un namespace. */
function usedNamespace(directive) {
  if (directive.childForFieldName('name')) return null;
  if (directive.children.some((child) => child.type === 'static')) return null;
  return directive.children.find((child) => child.type === 'qualified_name' || child.type === 'identifier')?.text ?? null;
}

/**
 * Los hallazgos de un árbol emitido, como texto (`<ruta>:<línea>: …`); vacío si está limpio. Mira los `.cs`: la sintaxis
 * de cada uno y que todo `using` del PROPIO servicio (el que empieza por uno de los segmentos raíz de los namespaces
 * declarados) nombre un namespace que algún archivo emitido declara.
 */
export async function checkCsTree(files) {
  const cs = files.filter((file) => file.path.endsWith('.cs') && typeof file.content === 'string');
  const csharp = await csParser();
  const problems = [];
  const declared = new Set();
  const usings = [];
  for (const file of cs) {
    const tree = csharp.parse(file.content);
    try {
      const root = tree.rootNode;
      if (root.hasError) {
        const [first, ...rest] = syntaxProblems(root);
        const at = first ?? root;
        const line = file.content.split('\n')[at.startPosition.row]?.trim().slice(0, 120) ?? '';
        problems.push(`${file.path}:${at.startPosition.row + 1}: sintaxis${at.isMissing ? ` (falta ${at.type})` : ''} — «${line}»${rest.length ? ` y ${rest.length} más` : ''}`);
      }
      for (const ns of root.descendantsOfType(['namespace_declaration', 'file_scoped_namespace_declaration'])) {
        const name = ns.childForFieldName('name')?.text;
        if (name) declared.add(name);
      }
      for (const directive of root.descendantsOfType('using_directive')) {
        const name = usedNamespace(directive);
        if (name) usings.push({ file: file.path, row: directive.startPosition.row + 1, name });
      }
    } finally {
      tree.delete();
    }
  }
  // Los segmentos raíz del propio servicio: un `using System.Text;` no es asunto de build, uno de `<Servicio>.X` sí.
  const own = new Set([...declared].map((name) => name.split('.')[0]));
  for (const { file, row, name } of usings) {
    if (own.has(name.split('.')[0]) && !declared.has(name)) problems.push(`${file}:${row}: using ${name}, que ningún archivo emitido declara`);
  }
  return problems;
}
