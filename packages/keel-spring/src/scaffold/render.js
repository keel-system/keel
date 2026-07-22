// Helpers de render compartidos por los generadores de scaffolding.
// El patrón es "context precomputado" (src/lib/model.js) + template literals:
// aquí solo vive el ensamblado del archivo Java.

import { packageToPath } from '../lib/naming.js';

// Ensambla un archivo .java: package + imports ordenados + cuerpo.
export function javaFile(pkg, imports, body) {
  const lines = [`package ${pkg};`, ''];
  const sorted = [...new Set(imports)].filter(Boolean).sort();
  if (sorted.length > 0) {
    for (const name of sorted) lines.push(`import ${name};`);
    lines.push('');
  }
  lines.push(body.trimEnd(), '');
  return lines.join('\n');
}

// Ruta de una clase Java dentro del proyecto generado (root: 'main' o 'test').
export function javaPath(model, subpackage, className, root = 'main') {
  const pkg = subpackage ? `${model.service.basePackage}.${subpackage}` : model.service.basePackage;
  return `src/${root}/java/${packageToPath(pkg)}/${className}.java`;
}

export function subPackage(model, subpackage) {
  return subpackage ? `${model.service.basePackage}.${subpackage}` : model.service.basePackage;
}

// Javadoc de una línea (descripciones del diseño).
export function javadoc(text, indent = '') {
  if (!text) return '';
  return `${indent}/**\n${indent} * ${text.trim().replace(/\n/g, `\n${indent} * `)}\n${indent} */\n`;
}

export function indentBlock(text, indent) {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}
