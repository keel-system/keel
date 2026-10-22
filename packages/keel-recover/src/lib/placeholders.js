// Placeholders de Spring (`${clave:default}`), con anidamiento: `${a:${b:c}}`.

/** Placeholders de un texto, en orden: `{ key, default, raw }` (`default` null si no lo trae). */
export function placeholders(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf('${', i)) !== -1) {
    const end = matchBrace(text, i + 1);
    if (end === -1) break;
    const inner = text.slice(i + 2, end);
    const sep = topLevelColon(inner);
    const key = (sep === -1 ? inner : inner.slice(0, sep)).trim();
    const def = sep === -1 ? null : inner.slice(sep + 1);
    if (key && !key.startsWith('#')) out.push({ key, default: def, raw: text.slice(i, end + 1) });
    i = end + 1;
  }
  return out;
}

/** El texto con cada placeholder sustituido por su default (recursivo), o null si alguno no lo tiene. */
export function resolveDefaults(text) {
  let unresolved = false;
  const resolve = (t) => {
    let out = '';
    let i = 0;
    while (true) {
      const at = t.indexOf('${', i);
      if (at === -1) return out + t.slice(i);
      const end = matchBrace(t, at + 1);
      if (end === -1) return out + t.slice(i);
      out += t.slice(i, at);
      const inner = t.slice(at + 2, end);
      const sep = topLevelColon(inner);
      if (sep === -1) {
        unresolved = true;
        out += t.slice(at, end + 1);
      } else {
        out += resolve(inner.slice(sep + 1));
      }
      i = end + 1;
    }
  };
  const value = resolve(text);
  return unresolved ? null : value;
}

function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelColon(inner) {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '{') depth++;
    else if (inner[i] === '}') depth--;
    else if (inner[i] === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Variable de entorno que alimenta una propiedad de Spring por el binding relajado:
 * `spring.data.mongodb.uri` → `SPRING_DATA_MONGODB_URI`, `port` → `PORT`.
 */
export function springEnvName(key) {
  return key
    .replace(/\[(\d+)\]/g, '_$1_')
    .replace(/-/g, '')
    .replace(/\./g, '_')
    .replace(/_+$/, '')
    .toUpperCase();
}
