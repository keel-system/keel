// Helpers de render compartidos por los generadores de scaffolding.
// El patrón es "context precomputado" (src/lib/model.js) + template literals:
// aquí solo vive el ensamblado del archivo Java.

import { packageToPath } from '../lib/naming.js';

// Ensambla un archivo .java: package + imports ordenados + cuerpo.
export function javaFile(pkg, imports, body) {
  const lines = [`package ${pkg};`, ''];
  // Un tipo del PROPIO paquete no se importa: es legal pero redundante, y todo análisis
  // estático lo marca. Se filtra aquí y no en cada emisor porque el emisor no siempre
  // sabe dónde acabará el archivo —añade el nombre cualificado y ya está—, y porque
  // repetir la comprobación en veinte módulos garantiza que alguno se la salte. Los
  // pases de calidad de varias corridas venían borrando estos imports a mano en el
  // proyecto generado, que es la señal de que el arreglo iba aquí.
  const sorted = [...new Set(imports)]
    .filter(Boolean)
    .filter((name) => name.slice(0, name.lastIndexOf('.')) !== pkg)
    .sort();
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
