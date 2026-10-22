// XML mínimo con la línea de cada elemento: lo justo para leer un pom.xml. No resuelve entidades
// ni espacios de nombres; un pom es XML bien formado y lo que se lee de él son textos cortos.

/** Árbol `{ name, line, endLine, text, children }` del primer elemento raíz, o null si no parsea. */
export function parseXml(text) {
  const root = { name: '#document', line: 1, endLine: 1, text: '', children: [] };
  const stack = [root];
  let line = 1;
  let i = 0;
  const advance = (to) => {
    for (; i < to; i++) if (text.charCodeAt(i) === 10) line++;
  };
  try {
    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt === -1) break;
      stack[stack.length - 1].text += text.slice(i, lt);
      advance(lt);
      if (text.startsWith('<!--', i)) {
        advance(text.indexOf('-->', i) + 3);
        continue;
      }
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i);
        stack[stack.length - 1].text += text.slice(i + 9, end);
        advance(end + 3);
        continue;
      }
      if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
        advance(text.indexOf('>', i) + 1);
        continue;
      }
      const gt = text.indexOf('>', i);
      const tag = text.slice(i + 1, gt);
      const startLine = line;
      advance(gt + 1);
      if (tag.startsWith('/')) {
        const node = stack.pop();
        node.endLine = startLine;
        node.text = node.text.trim();
        continue;
      }
      const name = /^([^\s/>]+)/.exec(tag)[1];
      const node = { name, line: startLine, endLine: startLine, text: '', children: [] };
      stack[stack.length - 1].children.push(node);
      if (!tag.endsWith('/')) stack.push(node);
    }
  } catch {
    return null;
  }
  return root.children[0] ?? null;
}

export function child(node, name) {
  return node ? node.children.find((c) => c.name === name) ?? null : null;
}

export function children(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Elemento en una ruta (`parent/version`). */
export function at(node, pathStr) {
  let cur = node;
  for (const part of pathStr.split('/')) cur = child(cur, part);
  return cur;
}

export function textOf(node) {
  return node ? node.text : null;
}
