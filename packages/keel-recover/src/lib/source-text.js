// Texto de código fuente sin comentarios, con los saltos de línea en su sitio para que las líneas
// sigan casando con el archivo. Sirve para Java, Groovy, Kotlin y JavaScript: una licencia en la
// cabecera trae URLs http, y una URL en un comentario no es una dependencia.

export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      // Un bloque de texto de Java/Groovy/Kotlin (""" … """) se copia entero.
      if (src.startsWith(c.repeat(3), i)) {
        const end = src.indexOf(c.repeat(3), i + 3);
        const stop = end === -1 ? n : end + 3;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (src[i] === '\n' && c !== '`') break; // cadena sin cerrar: no se arrastra al resto
        out += src[i];
        i++;
      }
      if (i < n && src[i] === c) {
        out += c;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
