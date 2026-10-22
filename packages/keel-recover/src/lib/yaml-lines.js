import { LineCounter, isMap, isPair, isScalar, isSeq, parseAllDocuments } from 'yaml';

/**
 * Documentos YAML de un texto con la línea de cada nodo. Un YAML roto no es un error de la
 * herramienta: devuelve `[]` y quien llama lo trata como un archivo sin hechos.
 */
export function parseYamlDocs(text) {
  const lineCounter = new LineCounter();
  let docs;
  try {
    docs = parseAllDocuments(text, { lineCounter, uniqueKeys: false });
  } catch {
    return [];
  }
  if (!Array.isArray(docs)) docs = [docs];
  return docs
    .filter((d) => d.errors.length === 0)
    .map((doc) => ({
      doc,
      value: doc.toJS({ maxAliasCount: -1 }),
      lineOf: (node) => (node && node.range ? lineCounter.linePos(node.range[0]).line : 0),
    }));
}

/** Nodo en una ruta de claves (sin convertir), para pedirle la línea. */
export function nodeAt(entry, keys) {
  try {
    return entry.doc.getIn(keys, true);
  } catch {
    return undefined;
  }
}

/** Línea de la CLAVE de una ruta (la del valor puede estar en otra línea, en un bloque). */
export function keyLine(entry, keys) {
  const parentKeys = keys.slice(0, -1);
  const parent = parentKeys.length ? nodeAt(entry, parentKeys) : entry.doc.contents;
  if (!parent) return 0;
  if (isMap(parent)) {
    const pair = parent.items.find((p) => isPair(p) && keyOf(p) === String(keys[keys.length - 1]));
    if (pair) return entry.lineOf(pair.key);
  }
  if (isSeq(parent)) return entry.lineOf(parent.items[keys[keys.length - 1]]);
  return 0;
}

function keyOf(pair) {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

/**
 * Hojas de un documento como claves con puntos (`spring.datasource.url`, `list[0]`), con su
 * valor escalar y la línea de su clave. Es la forma en que Spring lee un `application.yml`.
 */
export function flattenLeaves(entry) {
  const out = [];
  const visit = (node, prefix) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const key = prefix ? `${prefix}.${keyOf(pair)}` : keyOf(pair);
        if (isScalar(pair.value) || pair.value == null) {
          out.push({
            key,
            value: pair.value == null || pair.value.value == null ? '' : String(pair.value.value),
            line: entry.lineOf(pair.key),
          });
        } else {
          visit(pair.value, key);
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const key = `${prefix}[${i}]`;
        if (isScalar(item)) out.push({ key, value: item.value == null ? '' : String(item.value), line: entry.lineOf(item) });
        else visit(item, key);
      });
    }
  };
  visit(entry.doc.contents, '');
  return out;
}
