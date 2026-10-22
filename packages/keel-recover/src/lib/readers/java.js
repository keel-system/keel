import path from 'node:path';
import { isTestPath, lineAt } from '../repo.js';
import { stripComments } from '../source-text.js';
import { flattenLeaves, parseYamlDocs } from '../yaml-lines.js';
import { placeholders, springEnvName } from '../placeholders.js';
import { findUrls } from './urls.js';

// Lo que un servicio Spring lee del entorno: los `application*.properties|yml` (cada `${clave:def}`
// es un punto de variación), `@Value`, `@ConfigurationProperties`, `System.getenv` y
// `System.getProperty`. Y, de paso, lo que el código fija sin preguntar a nadie: credenciales
// literales, URLs y las llamadas HTTP salientes.

const CONFIG_FILE = /(^|\/)(application|bootstrap)(-[\w.-]+)?\.(properties|ya?ml)$/;

export function readJava(repo) {
  const out = { reads: [], settings: [], urls: [], credentials: [], callSites: [] };

  for (const rel of repo.files) {
    if (!CONFIG_FILE.test(rel) || isTestPath(rel) || /(^|\/)src\/test\//.test(rel)) continue;
    const base = path.posix.basename(rel);
    const profile = /-([\w.-]+)\.(properties|ya?ml)$/.exec(base)?.[1] ?? null;
    const leaves = rel.endsWith('.properties') ? propertiesLeaves(repo.lines(rel) ?? []) : yamlLeaves(repo.text(rel) ?? '');
    for (const leaf of leaves) {
      const setting = { key: leaf.key, value: leaf.value, file: rel, line: leaf.line, ...(profile ? { profile } : {}) };
      out.settings.push(setting);
      for (const ph of placeholders(leaf.value)) {
        out.reads.push({ key: ph.key, env: springEnvName(ph.key), default: ph.default, via: 'placeholder', target: leaf.key, file: rel, line: leaf.line, ...(profile ? { profile } : {}) });
      }
      for (const url of findUrls(leaf.value)) out.urls.push({ ...url, file: rel, line: leaf.line, context: 'config', key: leaf.key });
    }
  }

  for (const rel of repo.files) {
    if (!/\.(java|kt|groovy)$/.test(rel) || !rel.startsWith('src/main/')) continue;
    const raw = repo.text(rel);
    if (raw === null) continue;
    const src = stripComments(raw);
    readValueAnnotations(src, rel, out);
    readGetenv(src, rel, out);
    readConfigurationProperties(src, rel, out);
    readCredentials(src, rel, out);
    src.split(/\r?\n/).forEach((l, i) => {
      for (const url of findUrls(l, { quoted: true })) out.urls.push({ ...url, file: rel, line: i + 1, context: 'code' });
      for (const site of javaCallSites(l)) out.callSites.push({ ...site, file: rel, line: i + 1 });
    });
  }
  return out;
}

function propertiesLeaves(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) return;
    const m = /^([^=:\s]+)\s*[=:\s]\s*(.*)$/.exec(t);
    if (m) out.push({ key: m[1], value: m[2], line: i + 1 });
  });
  return out;
}

function yamlLeaves(text) {
  return parseYamlDocs(text).flatMap((entry) => flattenLeaves(entry));
}

// `@Value("${a:b}")`, con la cadena partida en literales concatenados: orders escribe
// `@Value("${prometheus.metrics" + ".path:/metrics}")`.
function readValueAnnotations(src, rel, out) {
  const re = /@Value\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const close = closingParen(src, m.index + m[0].length - 1);
    const args = src.slice(m.index + m[0].length, close);
    const joined = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('');
    const line = lineAt(src, m.index);
    for (const ph of placeholders(joined)) {
      out.reads.push({ key: ph.key, env: springEnvName(ph.key), default: ph.default, via: 'value-annotation', file: rel, line });
      if (ph.default) for (const url of findUrls(ph.default)) out.urls.push({ ...url, file: rel, line, context: 'code', key: ph.key });
    }
  }
}

function closingParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return src.length;
}

function readGetenv(src, rel, out) {
  for (const m of src.matchAll(/System\.getenv\(\s*"([^"]+)"\s*\)/g)) {
    out.reads.push({ key: m[1], env: m[1], default: null, via: 'getenv', file: rel, line: lineAt(src, m.index) });
  }
  for (const m of src.matchAll(/System\.getProperty\(\s*"([^"]+)"\s*(?:,\s*"((?:[^"\\]|\\.)*)"\s*)?\)/g)) {
    out.reads.push({ key: m[1], env: null, default: m[2] ?? null, via: 'system-property', file: rel, line: lineAt(src, m.index) });
  }
}

// `@ConfigurationProperties(prefix = "x")` sobre una clase: cada campo con setter (o con Lombok)
// es una clave `x.campo-en-kebab`, con su inicializador literal como default.
function readConfigurationProperties(src, rel, out) {
  const re = /@ConfigurationProperties\b(?:\s*\(\s*(?:(?:prefix|value)\s*=\s*)?"([^"]*)"\s*\))?/g;
  let m;
  while ((m = re.exec(src))) {
    const prefix = m[1] ?? '';
    const cls = /\bclass\s+\w+[^{]*\{/g;
    cls.lastIndex = m.index;
    const c = cls.exec(src);
    if (!c) continue;
    const bodyStart = c.index + c[0].length;
    const lombok = /@(Data|Setter)\b/.test(src.slice(m.index, c.index));
    let depth = 1;
    let lineStart = bodyStart;
    for (let i = bodyStart; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === ';' && depth === 1) {
        const stmt = src.slice(lineStart, i);
        const f = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:private|protected|public)\s+)?(?!static\b)(?!final\b)[\w.<>\[\], ?]+?\s+(\w+)\s*(?:=\s*([\s\S]+))?$/.exec(stmt);
        if (f && !/\bstatic\b|\bfinal\b|\breturn\b|\(/.test(stmt.split('=')[0])) {
          const name = f[1];
          const setter = new RegExp(`\\bset${name[0].toUpperCase()}${name.slice(1)}\\s*\\(`).test(src);
          if (setter || lombok) {
            const key = (prefix ? `${prefix}.` : '') + name.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`);
            out.reads.push({ key, env: springEnvName(key), default: literal(f[2]), via: 'configuration-properties', file: rel, line: lineAt(src, lineStart + stmt.search(/\S/)) });
          }
        }
        lineStart = i + 1;
      }
      if (ch === '{' || ch === '}') lineStart = i + 1;
    }
  }
}

function literal(expr) {
  if (expr == null) return null;
  const t = expr.trim();
  const s = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (s) return s[1];
  if (/^-?\d+(\.\d+)?[lLfFdD]?$/.test(t)) return t.replace(/[lLfFdD]$/, '');
  if (t === 'true' || t === 'false') return t;
  return null;
}

// Tecnología de un archivo por lo que importa: a quién pertenece una credencial fija.
const IMPORT_TECH = [
  [/import\s+(org\.springframework\.amqp|com\.rabbitmq)\./, 'rabbitmq'],
  [/import\s+(com\.mongodb|org\.springframework\.data\.mongodb)\./, 'mongodb'],
  [/import\s+(org\.springframework\.data\.redis|redis\.clients|io\.lettuce)\./, 'redis'],
  [/import\s+(org\.apache\.kafka|org\.springframework\.kafka)\./, 'kafka'],
  [/import\s+(javax\.mail|jakarta\.mail|org\.springframework\.mail)\./, 'smtp'],
  [/import\s+(javax\.sql|java\.sql|org\.springframework\.jdbc|com\.zaxxer)\./, 'relational'],
];

function readCredentials(src, rel, out) {
  const found = {};
  const lines = [];
  for (const m of src.matchAll(/\.set(Username|User|Password)\(\s*"([^"]*)"\s*\)/g)) {
    found[m[1] === 'Password' ? 'password' : 'user'] = m[2];
    lines.push(lineAt(src, m.index));
  }
  if (!lines.length) return;
  const tech = IMPORT_TECH.find(([re]) => re.test(src))?.[1] ?? null;
  out.credentials.push({ tech, ...found, where: 'code', file: rel, lines });
}

// El receptor tiene que ser un cliente HTTP: `rabbitTemplate.execute` o `jdbcTemplate.update` no lo son.
const REST_TEMPLATE_CALL =
  /\b(\w*(?:[Rr]est|[Hh]al|[Hh]ttp)\w*[Tt]emplate(?:\(\))?|getRestTemplate\(\))\s*\.\s*(getForObject|getForEntity|postForObject|postForEntity|postForLocation|exchange|put|patchForObject|delete|execute)\s*\(/;

function javaCallSites(line) {
  const out = [];
  const rt = REST_TEMPLATE_CALL.exec(line);
  if (rt) out.push({ client: 'RestTemplate', call: `${rt[1]}.${rt[2]}` });
  const wc = /\b(\w*[Ww]ebClient(?:\(\))?)\s*\.\s*(get|post|put|patch|delete|method)\s*\(/.exec(line);
  if (wc) out.push({ client: 'WebClient', call: `${wc[1]}.${wc[2]}` });
  const feign = /@FeignClient\s*\(/.exec(line);
  if (feign) out.push({ client: 'Feign', call: line.trim() });
  return out;
}
