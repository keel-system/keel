import { placeholders, resolveDefaults } from '../placeholders.js';

// URLs de conexión en código y configuración, con su tecnología por el esquema. El host puede ser
// un placeholder de Spring (`mongodb://${db:orders-db}:27017/data`): entonces se resuelve con su
// default y se anota la clave que lo cambia, que es lo que el sandbox necesita para no tocar la
// configuración del legacy (publicar el contenedor con el alias que el legacy ya espera).

const SCHEMES = [
  [/^mongodb(\+srv)?$/, 'mongodb'],
  [/^postgres(ql)?$/, 'postgresql'],
  [/^mysql$/, 'mysql'],
  [/^mariadb$/, 'mariadb'],
  [/^rediss?$/, 'redis'],
  [/^amqps?$/, 'rabbitmq'],
  [/^smtps?$/, 'smtp'],
  [/^kafka$/, 'kafka'],
  [/^https?$/, 'http'],
];

const JDBC = {
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlserver: 'sqlserver',
  jtds: 'sqlserver',
  oracle: 'oracle',
  h2: 'h2',
  hsqldb: 'hsqldb',
  derby: 'derby',
  sqlite: 'sqlite',
  db2: 'db2',
};

const START = /\b(jdbc:[a-z0-9]+:|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?|smtps?|kafka|https?):\/\/)/gi;

/**
 * URLs de un texto. Con `quoted` solo cuentan las que están dentro de un literal de cadena (en
 * código, una URL fuera de comillas es un comentario que se escapó o un identificador).
 */
export function findUrls(text, { quoted = false } = {}) {
  const segments = quoted ? [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]) : [text];
  const out = [];
  for (const seg of segments) {
    START.lastIndex = 0;
    let m;
    while ((m = START.exec(seg))) {
      const raw = takeUrl(seg, m.index);
      START.lastIndex = m.index + raw.length;
      const parsed = parseUrl(raw);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function takeUrl(text, start) {
  let i = start;
  while (i < text.length) {
    if (text.startsWith('${', i)) {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      i++;
      continue;
    }
    // Una `}` suelta cierra el placeholder que contiene la URL: `${TAX_URL:http://tax/rates}`.
    if (/[\s"'`<>),}]/.test(text[i])) break;
    i++;
  }
  return text.slice(start, i);
}

export function parseUrl(raw) {
  const jdbc = /^jdbc:([a-z0-9]+):(.*)$/i.exec(raw);
  let tech;
  let rest;
  if (jdbc) {
    tech = JDBC[jdbc[1].toLowerCase()] ?? jdbc[1].toLowerCase();
    rest = jdbc[2];
    if (!rest.startsWith('//')) {
      // jdbc:h2:mem:x, jdbc:oracle:thin:@host:1521:sid
      const at = /@\/*([^:/;]+)(?::(\d+))?/.exec(rest);
      return { url: raw, tech, host: at ? at[1] : null, port: at && at[2] ? Number(at[2]) : null, database: null, embedded: /^(mem|file):/.test(rest) };
    }
    rest = rest.slice(2);
  } else {
    const m = /^([a-z+]+):\/\/(.*)$/i.exec(raw);
    if (!m) return null;
    tech = SCHEMES.find(([re]) => re.test(m[1].toLowerCase()))?.[1];
    if (!tech) return null;
    rest = m[2];
  }
  const authorityEnd = searchOutsidePlaceholders(rest, /[/?;]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const atSign = authority.lastIndexOf('@');
  const userinfo = atSign === -1 ? null : authority.slice(0, atSign);
  const hostport = atSign === -1 ? authority : authority.slice(atSign + 1);
  const first = hostport.split(',')[0]; // mongodb://a:27017,b:27017
  const colon = searchOutsidePlaceholders(first, /:/);
  const hostRaw = colon === -1 ? first : first.slice(0, colon);
  const portRaw = colon === -1 ? null : first.slice(colon + 1);
  if (!hostRaw) return null;

  const hostPh = placeholders(hostRaw);
  const host = hostPh.length === 1 && hostPh[0].raw === hostRaw ? hostPh[0].default ?? null : resolveDefaults(hostRaw) ?? hostRaw;
  const result = { url: raw, tech, host };
  if (hostPh.length === 1 && hostPh[0].raw === hostRaw) result.host_key = hostPh[0].key;
  const port = portRaw == null ? null : resolveDefaults(portRaw);
  result.port = port && /^\d+$/.test(port) ? Number(port) : null;
  if (tech !== 'http' && tech !== 'smtp') {
    const db = /^\/([^/?;]+)/.exec(tail) ?? /databaseName=([^;]+)/.exec(tail);
    result.database = db ? resolveDefaults(db[1]) ?? db[1] : null;
  } else if (tech === 'http') {
    result.path = tail.split('?')[0] || '/';
  }
  if (userinfo) {
    const [user, password] = userinfo.split(':');
    result.user = resolveDefaults(user) ?? user;
    if (password !== undefined) result.password = resolveDefaults(password) ?? password;
  }
  return result;
}

function searchOutsidePlaceholders(text, re) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('${', i)) {
      depth++;
      i++;
      continue;
    }
    if (depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      continue;
    }
    if (re.test(text[i])) return i;
  }
  return -1;
}
