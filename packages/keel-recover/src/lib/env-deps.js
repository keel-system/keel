import { cmp, cmpEvidence, evidence, gitSource, joinEvidence, openRepo } from './repo.js';
import { readStacks } from './stacks.js';
import { readJava } from './readers/java.js';
import { readNode } from './readers/node.js';
import { parseUrl } from './readers/urls.js';
import { placeholders, resolveDefaults } from './placeholders.js';
import { inventoryAssets } from './assets-inventory.js';
import { TECH_KIND, envTech, isLocalHost, libraryTech, provisionFor, springKey } from './catalog.js';

// Paso 0b: lo que el legacy necesita del entorno para arrancar. Determinista: lee el repo y nada
// más. Sale `environment.yaml` con tres bloques que escribe la herramienta (`config`,
// `dependencies`, `assets`) y dos que completa el agente al montar el sandbox (la imagen y el
// alias de cada `provision`, y `adaptations` con su motivo).
//
// Lo que no se puede resolver leyendo no se adivina: un host que el código compone en tiempo de
// ejecución queda como llamada saliente sin destino (`outbound_http`), y una variable con pinta de
// dependencia que no casa con ninguna tecnología sale como dependencia `unknown` con
// `provision: ask`.

const KIND_ORDER = ['database', 'cache', 'broker', 'smtp', 'http', 'tracing', 'discovery', 'unknown'];

export function envDeps(root) {
  const repo = openRepo(root);
  const stacks = readStacks(repo);
  const primary = stacks[0] ?? null;

  const doc = { kind: 'environment', schema: 1 };
  const source = gitSource(repo.root);
  if (source) doc.source = { commit: source.commit };
  if (!primary) {
    doc.unsupported = 'ningún adaptador reconoce el repo (Maven, Gradle o Node)';
    doc.assets = inventoryAssets(repo);
    return doc;
  }
  doc.stack = primary.stack;

  const facts = primary.language === 'java' ? readJava(repo) : readNode(repo);
  doc.listen = listenOf(primary, facts);
  doc.config = buildConfig(facts.reads);
  const { dependencies, credentials } = buildDependencies(primary, facts);
  doc.dependencies = dependencies;
  if (credentials.length) doc.credentials = credentials;
  doc.outbound_http = outboundHttp(primary, facts);
  doc.assets = inventoryAssets(repo);
  doc.adaptations = [];
  return doc;
}

// ── puerto ────────────────────────────────────────────────────────────────────────────────────

function listenOf(primary, facts) {
  if (primary.language === 'java') {
    const read = facts.reads.find((r) => r.target === 'server.port' && !r.profile);
    if (read) return { port: read.default != null && /^\d+$/.test(read.default) ? Number(read.default) : null, key: read.key, env: read.env, evidence: evidence(read.file, [read.line]) };
    const fixed = facts.settings.find((s) => s.key === 'server.port' && !s.profile);
    if (fixed && /^\d+$/.test(fixed.value)) return { port: Number(fixed.value), key: 'server.port', env: 'SERVER_PORT', evidence: evidence(fixed.file, [fixed.line]) };
    if (primary.framework && primary.server) return { port: 8080, key: 'server.port', env: 'SERVER_PORT', via: 'framework-default', evidence: null };
    return null;
  }
  const l = facts.listen[0];
  return l ? { port: l.port, ...(l.env ? { env: l.env } : {}), evidence: evidence(l.file, [l.line]) } : null;
}

// ── configuración ─────────────────────────────────────────────────────────────────────────────

function evidenceOf(items) {
  const byFile = new Map();
  for (const it of items) {
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(...(it.lines ?? [it.line]));
  }
  return joinEvidence([...byFile.keys()].sort(cmp).map((f) => evidence(f, byFile.get(f))));
}

function buildConfig(reads) {
  const byKey = new Map();
  for (const r of reads) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const out = [];
  for (const key of [...byKey.keys()].sort(cmp)) {
    const rs = byKey.get(key).sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.via, b.via));
    const defaults = [...new Set(rs.map((r) => r.default).filter((d) => d !== null && d !== undefined))];
    const compared = [...new Set(rs.map((r) => r.compared_with).filter((v) => v !== undefined))].sort(cmp);
    const feeds = [...new Set(rs.map((r) => r.target).filter(Boolean))].sort(cmp);
    const profiles = [...new Set(rs.map((r) => r.profile).filter(Boolean))].sort(cmp);
    const envs = [...new Set(rs.map((r) => r.env).filter(Boolean))];
    const entry = {
      key,
      env: envs[0] ?? null,
      default: defaults[0] ?? null,
      ...(defaults.length > 1 ? { defaults } : {}),
      via: [...new Set(rs.map((r) => r.via))].sort(cmp),
      ...(feeds.length ? { feeds } : {}),
      ...(compared.length ? { compared_with: compared } : {}),
      ...(profiles.length && profiles.length === rs.length ? { profiles } : {}),
      ...(rs.some((r) => r.masked) ? { masked: true } : {}),
      evidence: evidenceOf(rs),
    };
    out.push(entry);
  }
  return out;
}

// ── dependencias ──────────────────────────────────────────────────────────────────────────────

function buildDependencies(primary, factsIn) {
  let facts = factsIn;
  const deps = new Map(); // clave: tech (o `http:<host>`, `unknown:<clave>`)
  const credentials = [];
  const consumedUrls = new Set();
  const hostKeys = new Set();
  const endpointKeys = new Set(); // claves que ya dieron un endpoint
  const dep = (tech, keyOverride) => {
    const id = keyOverride ?? tech;
    if (!deps.has(id)) deps.set(id, { kind: TECH_KIND[tech] ?? 'unknown', tech, endpoints: [], clients: [], credentials: [] });
    return deps.get(id);
  };
  const addEndpoint = (tech, endpoint, keyOverride) => {
    const d = dep(tech, keyOverride);
    if (!d.endpoints.some((e) => e.evidence === endpoint.evidence && e.url === endpoint.url && e.host === endpoint.host)) d.endpoints.push(endpoint);
    if (endpoint.host_key) hostKeys.add(endpoint.host_key);
    if (endpoint.key) for (const k of endpoint.key.split(', ')) endpointKeys.add(k);
  };
  const urlEndpoint = (u, ev, extra = {}) => {
    const e = { ...(u.host != null ? { host: u.host } : {}) };
    if (u.host_key) e.host_key = u.host_key;
    if (u.port != null) e.port = u.port;
    if (u.database) e.database = u.database;
    if (u.path && u.tech === 'http') e.path = u.path;
    if (u.embedded) e.embedded = true;
    return { ...e, ...extra, url: u.url, evidence: ev };
  };
  const urlCredentials = (u, tech, ev) => {
    if (u.user || u.password) credentials.push({ tech, user: u.user ?? null, password: u.password ?? null, where: 'url', evidence: ev });
  };

  // Spring: propiedades que nombran una dependencia.
  const perFile = new Map();
  for (const s of facts.settings) {
    const sk = springKey(s.key);
    if (!sk) continue;
    const ev = evidence(s.file, [s.line]);
    if (sk.role === 'url') {
      const u = parseUrl(s.value.trim());
      if (!u) continue;
      consumedUrls.add(`${s.file}:${s.line}`);
      const tech = sk.tech && sk.tech !== 'relational' ? sk.tech : u.tech;
      addEndpoint(tech, urlEndpoint(u, ev, { key: s.key, ...(s.profile ? { profile: s.profile } : {}) }));
      urlCredentials(u, tech, ev);
    } else if (sk.role === 'host' || sk.role === 'port') {
      const tech = sk.tech;
      const slot = `${s.file}|${s.profile ?? ''}|${tech}`;
      if (!perFile.has(slot)) perFile.set(slot, { tech, file: s.file, lines: [], profile: s.profile, keys: [] });
      const acc = perFile.get(slot);
      acc.lines.push(s.line);
      acc.keys.push(s.key);
      const ph = placeholders(s.value);
      const whole = ph.length === 1 && ph[0].raw === s.value.trim();
      const value = whole ? ph[0].default : resolveDefaults(s.value) ?? s.value;
      if (sk.role === 'host') {
        acc.host = (value ?? '').split(',')[0].split(':')[0] || null;
        if (whole) acc.host_key = ph[0].key;
      } else if (value && /^\d+$/.test(value)) acc.port = Number(value);
    } else if (sk.role === 'user' || sk.role === 'password') {
      const ph = placeholders(s.value);
      const fixed = ph.length === 0;
      const value = fixed ? s.value : resolveDefaults(s.value);
      const cred = credentials.find((c) => c.where === 'config' && c.tech === sk.tech && c.file === s.file) ?? null;
      const entry = cred ?? { tech: sk.tech, where: 'config', file: s.file, lines: [] };
      entry[sk.role] = value ?? null;
      if (!fixed) entry[`${sk.role}_key`] = ph[0].key;
      entry.lines.push(s.line);
      if (!cred) credentials.push(entry);
    } else if (sk.role === 'enabled') {
      const ph = placeholders(s.value);
      const value = ph.length ? resolveDefaults(s.value) : s.value;
      const d = dep(sk.tech);
      d.enabled_by_default = value === 'true';
      d.enabled_evidence = evidence(s.file, [s.line]);
      if (ph.length) d.enabled_key = ph[0].key;
    }
  }
  for (const acc of perFile.values()) {
    addEndpoint(acc.tech, {
      ...(acc.host ? { host: acc.host } : {}),
      ...(acc.host_key ? { host_key: acc.host_key } : {}),
      ...(acc.port ? { port: acc.port } : {}),
      key: acc.keys.sort(cmp).join(', '),
      ...(acc.profile ? { profile: acc.profile } : {}),
      evidence: evidence(acc.file, acc.lines),
    });
  }

  // Una misma URL puede llegar dos veces de la misma línea (como default de una variable y como
  // literal): cuenta una, la que sabe su clave.
  const seenUrls = new Map();
  for (const u of facts.urls) {
    const id = `${u.file}:${u.line}:${u.url}`;
    if (!seenUrls.has(id) || (u.key && !seenUrls.get(id).key)) seenUrls.set(id, u);
  }
  facts = { ...facts, urls: [...seenUrls.values()] };

  // URLs de la configuración que no consumió ninguna propiedad conocida, y las de conexión del
  // código. Una URL http literal en el código NO es una dependencia por sí sola (en RealWorld es la
  // imagen por defecto de un perfil): va a `outbound_http.urls` como candidata, y quien la cruza
  // con las llamadas salientes es el agente. En la configuración, o como default de una clave, sí
  // lo es: alguien la hizo configurable.
  for (const u of facts.urls) {
    if (u.context === 'config' && consumedUrls.has(`${u.file}:${u.line}`)) continue;
    if (u.tech === 'http' && u.context === 'code' && !u.key) continue;
    const ev = evidence(u.file, [u.line]);
    const keyOverride = u.tech === 'http' ? `http:${u.host}` : undefined;
    addEndpoint(u.tech, urlEndpoint(u, ev, u.key ? { key: u.key } : {}), keyOverride);
    urlCredentials(u, u.tech, ev);
  }

  // Variables que nombran una tecnología (MONGODB_URI, DATABASE_URL…).
  for (const r of facts.reads) {
    const tech = envTech(r.env ?? r.key);
    // Un placeholder dentro de una propiedad ya mapeada (`${zipkin_host:zipkin}`) es parte de ese
    // endpoint, no otro.
    if (!tech || r.target || (r.default && parseUrl(r.default))) continue;
    const host = /HOST$/i.test(r.key) && r.default && /^[\w.-]+$/.test(r.default) ? r.default : null;
    addEndpoint(tech, { ...(host ? { host } : {}), env: r.env ?? r.key, evidence: evidence(r.file, [r.line]) });
  }

  // Credenciales fijas en el código.
  for (const c of facts.credentials) {
    credentials.push({ tech: c.tech, user: c.user ?? null, password: c.password ?? null, where: c.where, file: c.file, lines: c.lines });
  }

  // Clientes: las librerías del build que hablan con cada tecnología.
  for (const lib of primary.libraries.filter((l) => l.scope === 'main')) {
    const tech = libraryTech(lib.id, primary.stack);
    if (!tech || tech === 'http') continue;
    dep(tech).clients.push({ library: lib.id, version: lib.version ?? null, evidence: lib.evidence });
  }

  // `relational` (JPA, Sequelize…) se pliega en el motor concreto si solo hay uno.
  const concrete = [...deps.values()].filter((d) => d.kind === 'database' && !['relational', 'mongodb', 'cassandra', 'elasticsearch'].includes(d.tech));
  if (deps.has('relational') && concrete.length === 1) {
    const rel = deps.get('relational');
    concrete[0].endpoints.push(...rel.endpoints);
    concrete[0].clients.push(...rel.clients);
    deps.delete('relational');
  }
  for (const c of credentials) if (c.tech === 'relational' && concrete.length === 1) c.tech = concrete[0].tech;

  // Variables con pinta de destino que nadie explicó: dependencia desconocida, se pregunta.
  for (const r of facts.reads) {
    const name = r.key;
    if (hostKeys.has(name) || endpointKeys.has(name) || envTech(r.env ?? name) || r.target || springKey(name)) continue;
    if (!/(^|[._-])(url|uri|host|hostname|endpoint|addr|address|server)s?$/i.test(name)) continue;
    if (r.default && parseUrl(r.default)) continue;
    if (r.default && !isLocalHost(r.default) && r.default.length && !/^[\w.-]+$/.test(r.default)) continue;
    addEndpoint(null, { key: name, ...(r.env && r.env !== name ? { env: r.env } : {}), ...(r.default ? { default: r.default } : {}), evidence: evidence(r.file, [r.line]) }, `unknown:${name}`);
  }

  // Credenciales a su dependencia; las que no tienen dueño quedan sueltas.
  const loose = [];
  for (const c of credentials) {
    const target = c.tech && deps.get(c.tech);
    const ev = c.evidence ?? evidence(c.file, c.lines);
    const out = { ...(c.user !== undefined ? { user: c.user } : {}), ...(c.password !== undefined ? { password: c.password } : {}), ...(c.user_key ? { user_key: c.user_key } : {}), ...(c.password_key ? { password_key: c.password_key } : {}), hardcoded: !c.user_key && !c.password_key, where: c.where, evidence: ev };
    if (target) target.credentials.push(out);
    else loose.push({ tech: c.tech, ...out });
  }

  const list = [...deps.values()].map((d) => {
    d.endpoints.sort((a, b) => cmpEvidence(a.evidence, b.evidence));
    d.clients.sort((a, b) => cmp(a.library, b.library));
    d.credentials.sort((a, b) => cmpEvidence(a.evidence, b.evidence));
    const out = { kind: d.kind, tech: d.tech, endpoints: d.endpoints, clients: d.clients };
    if (d.credentials.length) out.credentials = d.credentials;
    if (d.enabled_by_default !== undefined) {
      out.enabled_by_default = d.enabled_by_default;
      out.enabled = { ...(d.enabled_key ? { key: d.enabled_key } : {}), evidence: d.enabled_evidence };
    }
    out.provision = provisionFor(d.kind, d.tech, d);
    return out;
  });
  list.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      cmp(a.tech ?? '', b.tech ?? '') ||
      cmp(a.endpoints[0]?.host ?? a.endpoints[0]?.key ?? '', b.endpoints[0]?.host ?? b.endpoints[0]?.key ?? '')
  );
  return { dependencies: list, credentials: loose };
}

// ── HTTP saliente ─────────────────────────────────────────────────────────────────────────────

function outboundHttp(primary, facts) {
  const clients = primary.libraries
    .filter((l) => l.scope === 'main' && libraryTech(l.id, primary.stack) === 'http')
    .map((l) => ({ library: l.id, version: l.version ?? null, evidence: l.evidence }))
    .sort((a, b) => cmp(a.library, b.library));
  const callSites = facts.callSites
    .map((s) => ({ client: s.client, call: s.call, evidence: evidence(s.file, [s.line]) }))
    .sort((a, b) => cmpEvidence(a.evidence, b.evidence) || cmp(a.call, b.call));
  const urls = facts.urls
    .filter((u) => u.tech === 'http' && u.context === 'code' && !u.key)
    .map((u) => ({ url: u.url, host: u.host, evidence: evidence(u.file, [u.line]) }))
    .sort((a, b) => cmpEvidence(a.evidence, b.evidence) || cmp(a.url, b.url));
  return { clients, call_sites: callSites, urls };
}
