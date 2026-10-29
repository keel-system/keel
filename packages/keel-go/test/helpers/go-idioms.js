// La red de IDIOMA de keel-go (PLAN-KEEL-GO.md § 3): lo que hace que el Go emitido se lea como Go y no como Java
// traducido. Cada regla mira el texto de un archivo y devuelve sus hallazgos con la línea; no compila nada, así que
// lo que necesita tipos lo juzgan staticcheck (en go-check) y el agente keel-go-quality.
//
// Las reglas trabajan sobre el código SIN comentarios ni cadenas (`stripCommentsAndStrings`), salvo la de
// documentación, que mira precisamente los comentarios. Una regla nueva entra con su mutación en
// test/go-idioms.test.js: una regla que nunca dispara no se distingue de una que no mira.

import { stripCommentsAndStrings } from '../../src/lib/go-source.js';

const isTest = (file) => file.path.endsWith('_test.go');
const isMain = (file) => /(^|\/)cmd\/[^/]+\/main\.go$/.test(file.path);

/** El código sin comentarios ni cadenas, línea a línea (los saltos de línea se conservan). */
function codeLines(content) {
  return stripCommentsWithLines(content).split('\n');
}

// stripCommentsAndStrings quita los saltos de línea de los comentarios de bloque y de las cadenas crudas; para
// conservar los números de línea se le pasa línea a línea lo que no está dentro de uno de ellos.
function stripCommentsWithLines(content) {
  return content
    .split('\n')
    .map((line) => stripCommentsAndStrings(line))
    .join('\n');
}

function matchLines(content, pattern, { code = true } = {}) {
  const lines = code ? codeLines(content) : content.split('\n');
  const hits = [];
  lines.forEach((line, index) => {
    if (pattern.test(line)) hits.push(index + 1);
  });
  return hits;
}

/** Los identificadores que declara un archivo, con su línea: funciones, métodos, tipos, var, const y campos. */
function declaredIdentifiers(content) {
  const found = [];
  codeLines(content).forEach((line, index) => {
    const decl = line.match(/^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Za-z_][A-Za-z0-9_]*)/);
    if (decl) found.push({ name: decl[1], line: index + 1 });
    // Un campo de struct o un elemento de un bloque const/var: `Nombre Tipo` o `Nombre = valor` con sangría.
    const member = line.match(/^\t+([A-Za-z_][A-Za-z0-9_]*)\s+(?:=|[*[\]A-Za-z])/);
    if (member && !/^(return|if|for|switch|case|go|defer|var|const|type|func|select|else|break|continue|goto|fallthrough|default)$/.test(member[1])) {
      found.push({ name: member[1], line: index + 1 });
    }
  });
  return found;
}

/** Las siglas que Go escribe en un solo caso, mal capitalizadas dentro de un identificador MixedCaps. */
const BAD_INITIALISM = /(?:^|[a-z0-9])(Id|Url|Uri|Http|Https|Json|Uuid|Api|Sql|Xml|Html|Tcp|Udp|Dns|Smtp|Ttl)(?=[A-Z0-9]|s?$)/;

export const IDIOM_RULES = [
  {
    id: 'no-init',
    what: 'init() con efectos: el cableado va en run, a la vista',
    check: (file) => matchLines(file.content, /^func init\(\)/)
  },
  {
    id: 'no-default-client',
    what: 'http.DefaultClient, http.Get o http.Post: sin plazo',
    check: (file) => matchLines(file.content, /\bhttp\.(DefaultClient|Get|Post|PostForm|Head)\b/)
  },
  {
    id: 'no-background-context',
    what: 'context.Background() fuera de main o de las pruebas, o context.TODO() en cualquier sitio',
    check: (file) => [
      ...(isMain(file) || isTest(file) ? [] : matchLines(file.content, /\bcontext\.Background\(\)/)),
      ...matchLines(file.content, /\bcontext\.TODO\(\)/)
    ]
  },
  {
    id: 'no-panic',
    what: 'panic en el código emitido fuera de una función Must…: los errores se devuelven',
    // Dos excepciones. La convención de la biblioteca estándar (regexp.MustCompile, template.Must): una función
    // Must… es para un literal que escribe el programador, y un literal mal escrito es un invariante imposible, no un
    // error que el llamante pueda tratar (PLAN-KEEL-GO.md § 3.2). Y RELANZAR lo que la misma función recuperó con
    // recover(): no crea un pánico, deja seguir uno que no era suyo (el http.ErrAbortHandler del borde HTTP).
    check: (file) => {
      if (isTest(file)) return [];
      let current = '';
      let recovered = null;
      const hits = [];
      codeLines(file.content).forEach((line, index) => {
        const opened = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/);
        if (opened) {
          current = opened[1];
          recovered = null;
        } else if (/^\S/.test(line)) current = '';
        const caught = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*recover\(\)/);
        if (caught) recovered = caught[1];
        if (!/(^|[^A-Za-z0-9_.])panic\(/.test(line) || /^Must[A-Z]/.test(current)) return;
        if (recovered && new RegExp(String.raw`(^|[^A-Za-z0-9_.])panic\(${recovered}\)`).test(line)) return;
        hits.push(index + 1);
      });
      return hits;
    }
  },
  {
    id: 'no-math-rand',
    what: 'math/rand fuera de las pruebas: la aleatoriedad que importa sale de crypto/rand',
    check: (file) => (isTest(file) ? [] : matchLines(file.content, /"math\/rand(\/v2)?"/, { code: false }))
  },
  {
    id: 'no-sleep-in-tests',
    what: 'time.Sleep en una prueba unitaria: se espera a una señal o se usa testing/synctest',
    check: (file) => (isTest(file) && !/^\/\/go:build integration/m.test(file.content) ? matchLines(file.content, /\btime\.Sleep\(/) : [])
  },
  {
    id: 'mixed-caps',
    what: 'snake_case en un identificador: Go usa MixedCaps',
    check: (file) =>
      declaredIdentifiers(file.content)
        .filter(({ name }) => name.includes('_') && name !== '_' && !/^(Test|Fuzz|Benchmark|Example)[A-Z0-9_]/.test(name))
        .map(({ line }) => line)
  },
  {
    id: 'initialisms',
    what: 'una sigla mal capitalizada (Id, Url, Http…): se escribe ID, URL, HTTP',
    check: (file) =>
      declaredIdentifiers(file.content)
        .filter(({ name }) => BAD_INITIALISM.test(name))
        .map(({ line }) => line)
  },
  {
    id: 'package-name',
    what: 'un paquete util, utils, common, helpers, models, base o types: no dice qué hay dentro',
    check: (file) => matchLines(file.content, /^package (util|utils|common|helpers|models|base|types)(_test)?$/)
  },
  {
    id: 'wrap-errors',
    what: 'fmt.Errorf que recibe un error sin %w: el llamante no puede inspeccionarlo',
    check: (file) =>
      file.content
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /fmt\.Errorf\(/.test(line) && /,\s*err\)?\s*\)/.test(line) && !/%w/.test(line))
        .map(({ index }) => index + 1)
  },
  {
    id: 'doc-comments',
    what: 'un identificador exportado sin comentario de documentación que empiece por su nombre',
    check: (file) => {
      if (isTest(file)) return [];
      const lines = file.content.split('\n');
      const missing = [];
      let depth = 0;
      lines.forEach((line, index) => {
        const code = stripCommentsAndStrings(line);
        const top = depth === 0 ? line.match(/^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Z][A-Za-z0-9_]*)/) : null;
        const inBlock = depth === 1 && /^(const|var) \($/.test(blockOpener(lines, index)) ? line.match(/^\t([A-Z][A-Za-z0-9_]*)\b/) : null;
        const name = top?.[1] ?? inBlock?.[1];
        // El comentario de documentación es el bloque de líneas `//` justo encima (las directivas como //go:embed
        // van dentro); su PRIMERA línea es la que empieza por el nombre.
        let first = index;
        while (first > 0 && /^\s*\/\//.test(lines[first - 1])) first--;
        const opening = lines.slice(first, index).find((comment) => !/^\s*\/\/go:/.test(comment) && comment.trim() !== '//');
        if (name && !new RegExp(`^\\s*// ${name}\\b`).test(opening ?? '')) missing.push(index + 1);
        depth += (code.match(/[({]/g) ?? []).length - (code.match(/[)}]/g) ?? []).length;
      });
      return missing;
    }
  },
  {
    id: 'server-timeouts',
    what: 'un http.Server sin ReadHeaderTimeout, ReadTimeout, WriteTimeout o IdleTimeout',
    check: (file) => {
      const hits = [];
      const pattern = /http\.Server\{/g;
      let match;
      while ((match = pattern.exec(file.content))) {
        const literal = file.content.slice(match.index, closingBrace(file.content, match.index + match[0].length - 1) + 1);
        if (!['ReadHeaderTimeout', 'ReadTimeout', 'WriteTimeout', 'IdleTimeout'].every((field) => new RegExp(`\\b${field}:`).test(literal))) {
          hits.push(file.content.slice(0, match.index).split('\n').length);
        }
      }
      return hits;
    }
  }
];

/** La línea que abrió el bloque en el que está `index` (la última anterior sin sangría). */
function blockOpener(lines, index) {
  for (let i = index - 1; i >= 0; i--) if (!/^\s/.test(lines[i]) && lines[i].trim()) return lines[i].trim();
  return '';
}

function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Los hallazgos de idioma de un árbol emitido, como texto (`<ruta>:<línea>: <regla> — <qué>`). */
export function checkGoIdioms(files) {
  const findings = [];
  for (const file of files.filter((f) => f.path.endsWith('.go') && typeof f.content === 'string')) {
    for (const rule of IDIOM_RULES) {
      for (const line of rule.check(file)) findings.push(`${file.path}:${line}: ${rule.id} — ${rule.what}`);
    }
  }
  return findings;
}
