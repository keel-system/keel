// El Java que emite `build` no lo compila nadie en esta suite: el resto de tests
// comparan CADENAS. Un template literal mal cerrado, una comilla que se come el
// resto del archivo o un import que se olvidó al añadir una clase producen código
// que pasa todos los `includes(...)` y no compila — y el fallo aparece muy lejos,
// cuando un agente ejecuta `./gradlew build` dentro del proyecto generado.
//
// Esto no sustituye a compilar (`npm run compile-check`, que sí lo hace de verdad
// con el JDK y la red): cubre las dos familias de error que el generador puede
// introducir por su forma de construir el código, y las cubre SIN JDK, en toda la
// matriz de fixtures y stacks, en segundos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Tipos de java.lang y de la propia sintaxis que nunca llevan import.
const IMPLICIT = new Set([
  'String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Short', 'Byte', 'Boolean',
  'Character', 'Number', 'Void', 'Class', 'Enum', 'Record', 'Math', 'System', 'Thread',
  'ThreadLocal', 'StringBuilder', 'StringBuffer', 'CharSequence', 'Comparable', 'Iterable',
  'Runnable', 'Throwable', 'AutoCloseable', 'Cloneable', 'Process', 'ProcessBuilder',
  'StackTraceElement', 'Package', 'Module', 'Exception', 'Error', 'AssertionError',
  'RuntimeException', 'IllegalStateException', 'IllegalArgumentException',
  'UnsupportedOperationException', 'NullPointerException', 'ClassCastException',
  'NumberFormatException', 'InterruptedException', 'ArithmeticException', 'SecurityException',
  'IndexOutOfBoundsException', 'ArrayIndexOutOfBoundsException', 'ClassNotFoundException',
  'CloneNotSupportedException', 'ReflectiveOperationException', 'NoSuchMethodException',
  'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs'
]);

/**
 * Quita comentarios y literales, sustituyéndolos por espacios para no mover offsets, y
 * dice si alguno se quedó sin cerrar. Es lo que hace verificable todo lo demás: sin
 * esto, una llave dentro de una cadena —que las hay, los cuerpos JSON del arnés— o el
 * `"""` de un text block desbalancearían el recuento y harían salir texto de dentro de
 * un literal como si fuera código.
 */
function stripLiteralsAndComments(source) {
  let out = '';
  let i = 0;
  let unterminated = null;
  const blank = (char) => (char === '\n' ? '\n' : ' ');
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') out += ' ', i++;
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') out += blank(source[i]), i++;
      if (i >= source.length) unterminated ??= 'comentario de bloque sin cerrar';
      out += '  ';
      i += 2;
      continue;
    }
    // Text block: se abre y se cierra con tres comillas, y dentro las comillas sueltas
    // son texto. Tratarlo como una cadena normal desincroniza el resto del archivo.
    if (source.slice(i, i + 3) === '"""') {
      out += '   ';
      i += 3;
      while (i < source.length && source.slice(i, i + 3) !== '"""') out += blank(source[i]), i++;
      if (i >= source.length) unterminated ??= 'text block sin cerrar';
      out += '   ';
      i += 3;
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      out += ' ';
      i++;
      while (i < source.length && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') out += ' ', i++;
        if (i < source.length) out += blank(source[i]), i++;
      }
      if (i >= source.length || source[i] === '\n') {
        unterminated ??= `literal ${quote === '"' ? 'de cadena' : 'de carácter'} sin cerrar`;
      }
      out += ' ';
      i++;
      continue;
    }
    out += source[i];
    i++;
  }
  return { code: out, unterminated };
}

/** Balance de delimitadores sobre el código ya despojado de literales. */
function unbalanced(code) {
  const pairs = { '}': '{', ')': '(', ']': '[' };
  const stack = [];
  for (const char of code) {
    if (char === '{' || char === '(' || char === '[') stack.push(char);
    else if (pairs[char]) {
      if (stack.pop() !== pairs[char]) return `cierre '${char}' sin su apertura`;
    }
  }
  return stack.length > 0 ? `quedan ${stack.length} sin cerrar: ${stack.join('')}` : null;
}

// Tipos anidados de una interfaz que la clase IMPLEMENTA: están en su ámbito sin
// import, y saber cuáles hay exige el classpath (los de un framework no se pueden
// leer del código generado). La lista es explícita a propósito: añadir uno es un acto
// deliberado, no un agujero que crece solo.
const INHERITED_NESTED = new Set([
  'StoredRequest', // IdempotencyStore.StoredRequest, en su adaptador
  'ValueReceiver' // ValueExtractor.ValueReceiver, de Hibernate Validator
]);

/**
 * Tipos citados por nombre simple que el archivo no puede resolver. Es el error que
 * introduce quien añade una clase al generador y olvida el import: compila en su
 * cabeza y no en javac.
 */
function missingImports(source, resolvableTypes) {
  const { code } = stripLiteralsAndComments(source);
  const imported = new Set(
    [...source.matchAll(/^import\s+(?:static\s+)?([\w.]+);/gm)].map((m) => m[1].split('.').pop())
  );
  // Tipos que el propio archivo declara, anidados incluidos.
  const declared = new Set(
    [...code.matchAll(/\b(?:class|interface|enum|record|@interface)\s+(\w+)/g)].map((m) => m[1])
  );
  const missing = new Set();
  // Nombre en PascalCase que no venga precedido de un punto (eso es un miembro, no un
  // tipo: `Map.Entry` resuelve por `Map`). El guion bajo entra en el token a propósito,
  // para capturar `EVENT_TOPIC` entero y descartarlo como constante en vez de leer
  // `EVENT` como si fuera un tipo.
  for (const match of code.matchAll(/(^|[^.\w])([A-Z][A-Za-z0-9_]*)\b/g)) {
    const name = match[2];
    if (name.length === 1) continue; // parámetro genérico <T>
    if (/^[A-Z0-9_]+$/.test(name)) continue; // constante o valor de enum, no un tipo
    if (IMPLICIT.has(name) || INHERITED_NESTED.has(name)) continue;
    if (imported.has(name) || declared.has(name) || resolvableTypes.has(name)) continue;
    missing.add(name);
  }
  return [...missing];
}

/** Genera un proyecto y devuelve todos sus .java con su paquete. */
function generatedJava(fixture, stack) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, [], `${fixture}: la fixture no carga`);
  const workspace = tmpDir('keel-syntax-');
  scaffoldService({ manifest, layers, workspace, force: true, stack });
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) {
        const source = fs.readFileSync(full, 'utf8');
        files.push({
          path: path.relative(workspace, full).replace(/\\/g, '/'),
          source,
          package: source.match(/^package\s+([\w.]+);/m)?.[1] ?? '',
          types: [...source.matchAll(/\b(?:class|interface|enum|record)\s+(\w+)/g)].map((m) => m[1])
        });
      }
    }
  };
  walk(workspace);
  return files;
}

// La matriz: cada fixture con el stack que la hace interesante. Los tres brokers
// porque cada uno tiene su rama de `deliverMessage`, y la base documental porque
// tiene su propia rama de espejo y repositorios.
const MATRIX = [
  ['catalog-extended', { broker: 'kafka' }],
  ['catalog-extended', { broker: 'rabbitmq' }],
  ['catalog-extended', { broker: 'snssqs' }],
  ['metering-digest', { broker: 'kafka' }],
  // La silueta de la saga: compensación + las tres idempotencias, con la superficie
  // mínima para que un pipeline completo quepa en una corrida.
  ['stock-reservation', { broker: 'kafka' }],
  // La misma silueta con un motor que NO reparte candidatos: es la rama SIN @Lock del
  // reclamo (barrido, relay del outbox y reconciliación), que en las demás filas no la
  // tokeniza nadie — y un import condicional mal puesto ahí no lo ve ningún includes().
  ['stock-reservation', { broker: 'kafka', database: 'h2' }],
  ['inspection-reports', {}],
  // La silueta documental TRANSVERSAL: seguridad, caché, storage, clientes salientes
  // e idempotencia de petición sobre Mongo. Dos brokers porque su listener y su relay
  // son los de la rama documental, que no comparten código con los de la relacional.
  ['asset-vault', { broker: 'kafka' }],
  ['asset-vault', { broker: 'snssqs' }],
  // Y con Cognito, que es la ÚNICA combinación que renderiza las dos variantes propias
  // de ese proveedor: el corte del prefijo de scope en el converter y el filtro de
  // audiencia que mira el scope en vez de `aud`. Sin esta fila, ese Java no lo tokeniza
  // nadie — y es Java emitido por plantilla, que es justo donde se cuela un paréntesis.
  ['asset-vault', { broker: 'kafka', auth: 'cognito' }],
  ['product-catalog', {}],
  // La silueta del correo: la ÚNICA que renderiza la sección de buzón de
  // AbstractFlowIT, el adaptador SMTP, el motor de plantillas y el appendix de
  // índices condicionados. Sin esta fila, todo ese Java no lo tokeniza nadie.
  ['notification-mailer', { broker: 'kafka' }]
];

// El comprobador se comprueba a sí mismo. Un linter que solo sale en verde no
// distingue "no hay errores" de "no mira": estas cuatro pruebas son la evidencia
// afirmativa que su propia convención exige para toda aserción negativa.

test('el comprobador detecta llaves sin cerrar', () => {
  const { code } = stripLiteralsAndComments('class A { void f() { if (x) { } }');
  assert.ok(unbalanced(code)?.includes('sin cerrar'));
});

test('el comprobador detecta una cadena sin cerrar', () => {
  const { unterminated } = stripLiteralsAndComments('class A { String s = "roto;\n}');
  assert.equal(unterminated, 'literal de cadena sin cerrar');
});

test('el comprobador detecta un tipo usado sin import', () => {
  const source = 'package p;\n\nclass A {\n    private Base64 encoder;\n}\n';
  assert.deepEqual(missingImports(source, new Set()), ['Base64']);
  const withImport = 'package p;\n\nimport java.util.Base64;\n\nclass A {\n    private Base64 encoder;\n}\n';
  assert.deepEqual(missingImports(withImport, new Set()), []);
});

test('un text block no desincroniza el análisis', () => {
  // El caso real que lo destapó: `"""` leído como cadena vacía + comilla suelta hacía
  // salir el contenido del bloque como si fuera código, y el archivo entero quedaba
  // desalineado a partir de ahí.
  const source = 'package p;\n\nclass A {\n    String s = """\n        {"Content-Type": "x"}\n        """;\n    int n = 1;\n}\n';
  const { code, unterminated } = stripLiteralsAndComments(source);
  assert.equal(unterminated, null);
  assert.equal(unbalanced(code), null);
  assert.deepEqual(missingImports(source, new Set()), []);
});

for (const [fixture, stack] of MATRIX) {
  const label = `${fixture}${stack.broker ? ` (${stack.broker})` : ''}${stack.database ? ` / ${stack.database}` : ''}${stack.auth ? ` + ${stack.auth}` : ''}`;

  test(`${label}: todo .java generado está estructuralmente balanceado`, () => {
    const problems = [];
    for (const file of generatedJava(fixture, stack)) {
      const { code, unterminated } = stripLiteralsAndComments(file.source);
      if (unterminated) problems.push(`${file.path}: ${unterminated}`);
      const balanceError = unbalanced(code);
      if (balanceError) problems.push(`${file.path}: ${balanceError}`);
    }
    assert.deepEqual(problems, [], `estructura rota:\n  ${problems.join('\n  ')}`);
  });

  test(`${label}: ningún .java generado cita un tipo sin import`, () => {
    const files = generatedJava(fixture, stack);
    // Tipos del propio proyecto. No se distingue por paquete a propósito: lo que este
    // check persigue es el tipo del JDK o del framework usado sin import (el error de
    // quien amplía el generador), no la higiene de imports entre paquetes propios —
    // que exigiría resolver herencia y tipos anidados sin tener el classpath.
    const projectTypes = new Set(files.flatMap((file) => file.types));
    const problems = [];
    for (const file of files) {
      const missing = missingImports(file.source, projectTypes);
      if (missing.length > 0) problems.push(`${file.path}: ${missing.join(', ')}`);
    }
    assert.deepEqual(problems, [], `tipos sin resolver:\n  ${problems.join('\n  ')}`);
  });
}
