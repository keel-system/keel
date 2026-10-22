import path from 'node:path';
import { isTestPath, lineAt } from '../repo.js';
import { stripComments } from '../source-text.js';
import { findUrls } from './urls.js';

// Lo que un servicio Node lee del entorno: cada `process.env.X` con su default (`|| 3000`,
// `?? 'x'`), los valores con los que se compara (`=== 'production'`: el modo cambia la conducta),
// la desestructuración de `process.env` y los `.env.example`. Más las URLs literales, las llamadas
// HTTP salientes y el puerto en el que escucha.

const SOURCE = /\.(js|mjs|cjs|ts|mts|cts)$/;
const SKIP_DIRS = /(^|\/)(public|static)\//;
const LITERAL = String.raw`'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|\x60([^\x60$]*)\x60|(-?\d+(?:\.\d+)?)\b|\b(true|false)\b`;
const ENV_EXAMPLES = /(^|\/)\.env(\.(example|sample|template|dist|defaults|local\.example))?$/;

// Clientes HTTP: la llamada solo cuenta si el archivo importa la librería (un `request(` suelto
// puede ser cualquier cosa).
const HTTP_CLIENTS = [
  ['axios', /\baxios(?:\.(?:get|post|put|patch|delete|head|request))?\s*\(/],
  ['got', /\bgot(?:\.(?:get|post|put|patch|delete|head))?\s*\(/],
  ['request', /\brequest(?:\.(?:get|post|put|patch|del|delete|head))?\s*\(/],
  ['superagent', /\bsuperagent\s*\.\s*(?:get|post|put|patch|delete|del)\s*\(/],
  ['needle', /\bneedle(?:\.(?:get|post|put|patch|delete|request))?\s*\(/],
  ['node-fetch', /\bfetch\s*\(/],
];

export function readNode(repo) {
  const out = { reads: [], settings: [], urls: [], credentials: [], callSites: [], listen: [] };
  for (const rel of repo.files) {
    if (ENV_EXAMPLES.test(rel)) readEnvExample(repo, rel, out);
    if (!SOURCE.test(rel) || isTestPath(rel) || SKIP_DIRS.test(rel) || /\.min\.js$/.test(rel) || /\.d\.ts$/.test(rel)) continue;
    const raw = repo.text(rel);
    if (raw === null) continue;
    const src = stripComments(raw);
    readEnv(src, rel, out);
    const imported = new Set(HTTP_CLIENTS.map(([lib]) => lib).filter((lib) => importsLib(src, lib)));
    src.split(/\r?\n/).forEach((l, i) => {
      for (const url of findUrls(l, { quoted: true })) out.urls.push({ ...url, file: rel, line: i + 1, context: 'code' });
      for (const [lib, re] of HTTP_CLIENTS) {
        const m = re.exec(l);
        if (m && (imported.has(lib) || lib === 'node-fetch')) out.callSites.push({ client: lib === 'node-fetch' && !imported.has(lib) ? 'fetch' : lib, call: m[0].replace(/\s*\($/, ''), file: rel, line: i + 1 });
      }
    });
    readListen(src, rel, out);
  }
  return out;
}

function importsLib(src, lib) {
  const q = lib.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  return new RegExp(`require\\(\\s*['"]${q}['"]\\s*\\)|from\\s+['"]${q}['"]|import\\(\\s*['"]${q}['"]\\s*\\)`).test(src);
}

function literalValue(m, base) {
  for (let k = base; k < base + 5; k++) if (m[k] !== undefined) return m[k];
  return null;
}

function readEnv(src, rel, out) {
  const access = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  let m;
  while ((m = access.exec(src))) {
    const key = m[1] ?? m[2];
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const before = src.slice(Math.max(0, m.index - 200), m.index);
    const read = { key, env: key, default: null, via: 'process-env', file: rel, line: lineAt(src, m.index) };
    const def = new RegExp(String.raw`^\s*(?:\|\||\?\?)\s*(?:${LITERAL})`).exec(after);
    if (def) read.default = literalValue(def, 1);
    const cmpAfter = new RegExp(String.raw`^\s*(?:===|!==|==|!=)\s*(?:${LITERAL})`).exec(after);
    const cmpBefore = new RegExp(String.raw`(?:${LITERAL})\s*(?:===|!==|==|!=)\s*$`).exec(before);
    const compared = cmpAfter ? literalValue(cmpAfter, 1) : cmpBefore ? literalValue(cmpBefore, 1) : null;
    if (compared !== null) read.compared_with = compared;
    out.reads.push(read);
    for (const url of read.default ? findUrls(read.default) : []) out.urls.push({ ...url, file: rel, line: read.line, context: 'code', key });
  }
  // const { PORT = 3000, DATABASE_URL } = process.env
  for (const d of src.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    const bodyStart = d.index + 1;
    for (const part of d[1].matchAll(/([A-Za-z_]\w*)(?:\s*:\s*\w+)?(?:\s*=\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)))?/g)) {
      const def = part[2] ?? part[3] ?? part[4] ?? null;
      const line = lineAt(src, bodyStart + part.index);
      out.reads.push({ key: part[1], env: part[1], default: def, via: 'process-env', file: rel, line });
      for (const url of def ? findUrls(def) : []) out.urls.push({ ...url, file: rel, line, context: 'code', key: part[1] });
    }
  }
}

function readEnvExample(repo, rel, out) {
  const base = path.posix.basename(rel);
  const example = base !== '.env';
  (repo.lines(rel) ?? []).forEach((l, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(l);
    if (!m || l.trim().startsWith('#')) return;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    // Un `.env` versionado puede traer secretos de verdad: la clave sí, el valor no se copia.
    const secret = !example && /SECRET|PASSWORD|PASSWD|TOKEN|KEY|CREDENTIAL/i.test(m[1]);
    out.reads.push({ key: m[1], env: m[1], default: secret ? null : value, via: example ? 'env-example' : 'dotenv', ...(secret ? { masked: true } : {}), file: rel, line: i + 1 });
    if (!secret) for (const url of findUrls(value)) out.urls.push({ ...url, file: rel, line: i + 1, context: 'config', key: m[1] });
  });
}

// `app.listen(port)`, con `port` resuelto si es una variable del mismo archivo.
function readListen(src, rel, out) {
  for (const m of src.matchAll(/\.listen\(\s*([^,)]+)/g)) {
    let expr = m[1].trim();
    const ident = /^[A-Za-z_$][\w$]*$/.test(expr) ? expr : null;
    if (ident) {
      const decl = new RegExp(String.raw`(?:const|let|var)\s+${ident.replace(/\$/g, '\\$')}\s*=\s*([^;\n]+)`).exec(src);
      if (decl) expr = decl[1].trim();
    }
    const env = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/.exec(expr);
    const num = /(?:\|\||\?\?)\s*(\d+)|^(\d+)$/.exec(expr);
    if (!env && !num) continue;
    out.listen.push({
      port: num ? Number(num[1] ?? num[2]) : null,
      env: env ? env[1] ?? env[2] : null,
      file: rel,
      line: lineAt(src, m.index),
    });
  }
}
