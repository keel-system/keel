import { cmp, evidence, findLine } from '../repo.js';
import { parseYamlDocs } from '../yaml-lines.js';

// Adaptador Node: package.json, los archivos de versión (.nvmrc, .node-version, .tool-versions),
// los lockfiles —todos los que haya: en el inc. 1 la hoja de RealWorld dio por hecho que no había
// ninguno porque solo buscó *.js— y los registros de los que se resolvieron las dependencias.

export function detect(repo) {
  return repo.has('package.json');
}

const FRAMEWORKS = [
  ['@nestjs/core', 'nestjs'],
  ['express', 'express'],
  ['koa', 'koa'],
  ['fastify', 'fastify'],
  ['@hapi/hapi', 'hapi'],
  ['hapi', 'hapi'],
  ['restify', 'restify'],
  ['sails', 'sails'],
  ['loopback', 'loopback'],
  ['@loopback/core', 'loopback'],
];

const PUBLIC_REGISTRIES = new Set(['registry.npmjs.org', 'registry.yarnpkg.com', 'registry.npmmirror.com']);

export function read(repo) {
  const file = 'package.json';
  const lines = repo.lines(file) ?? [];
  let pkg;
  try {
    pkg = JSON.parse(repo.text(file));
  } catch {
    return { stack: 'node', language: 'node', unreadable: file };
  }
  // Línea de una clave dentro de un bloque (`"express"` dentro de `"dependencies"`).
  const lineIn = (block, key) => {
    const start = block ? findLine(lines, `"${block}"`) : 1;
    if (!start) return 0;
    return findLine(lines, `"${key}"`, block ? start : 0);
  };
  const ev = (block, key) => evidence(file, [lineIn(block, key)]);

  const declarations = [];
  const versionFile = (rel, via) => {
    const l = repo.lines(rel);
    if (!l) return;
    const i = l.findIndex((x) => x.trim() && !x.trim().startsWith('#'));
    if (i >= 0) declarations.push({ what: 'language', name: 'node', version: l[i].trim().replace(/^v/, ''), via, evidence: evidence(rel, [i + 1]) });
  };
  versionFile('.nvmrc', 'nvmrc');
  versionFile('.node-version', 'node-version');
  for (const [i, l] of (repo.lines('.tool-versions') ?? []).entries()) {
    const m = /^\s*(nodejs|node)\s+(\S+)/.exec(l);
    if (m) declarations.push({ what: 'language', name: 'node', version: m[2], via: 'tool-versions', evidence: evidence('.tool-versions', [i + 1]) });
  }
  const engines = pkg.engines && pkg.engines.node ? { range: String(pkg.engines.node), evidence: ev('engines', 'node') } : null;
  if (engines) declarations.push({ what: 'language', name: 'node', version: engines.range, via: 'engines', evidence: engines.evidence });
  if (pkg.volta && pkg.volta.node) declarations.push({ what: 'language', name: 'node', version: String(pkg.volta.node), via: 'volta', evidence: ev('volta', 'node') });

  const libraries = [];
  for (const [block, scope] of [
    ['dependencies', 'main'],
    ['devDependencies', 'dev'],
    ['optionalDependencies', 'main'],
  ]) {
    for (const [name, version] of Object.entries(pkg[block] ?? {})) {
      libraries.push({ id: name, version: String(version), scope, evidence: ev(block, name) });
    }
  }

  let framework = null;
  for (const [id, name] of FRAMEWORKS) {
    const lib = libraries.find((l) => l.id === id && l.scope === 'main');
    if (lib) {
      framework = { name, version: lib.version, evidence: lib.evidence };
      break;
    }
  }

  let entrypoint = null;
  if (pkg.scripts && pkg.scripts.start) {
    entrypoint = { command: String(pkg.scripts.start), via: 'scripts.start', evidence: ev('scripts', 'start') };
  } else if (pkg.main) {
    entrypoint = { command: `node ${pkg.main}`, via: 'main', evidence: ev(null, 'main') };
  }

  const lockfiles = readLockfiles(repo);
  const packageManager = choosePackageManager(pkg, lockfiles, ev);
  const registries = readRegistries(repo, lockfiles);

  return {
    stack: 'node',
    language: 'node',
    declarations,
    engines,
    packageManager,
    lockfiles,
    framework,
    entrypoint,
    registries,
    libraries,
  };
}

function readLockfiles(repo) {
  const out = [];
  if (repo.has('yarn.lock')) {
    const text = repo.text('yarn.lock') ?? '';
    out.push({ file: 'yarn.lock', manager: 'yarn', format: /^__metadata:/m.test(text) ? 'yarn-berry' : 'yarn-v1' });
  }
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (!repo.has(file)) continue;
    let version = null;
    try {
      version = JSON.parse(repo.text(file)).lockfileVersion ?? null;
    } catch {
      /* lockfile roto: se declara igual, sin versión */
    }
    out.push({ file, manager: 'npm', format: 'npm', lockfileVersion: version });
  }
  if (repo.has('pnpm-lock.yaml')) {
    const m = /^lockfileVersion:\s*['"]?([\d.]+)/m.exec(repo.text('pnpm-lock.yaml') ?? '');
    out.push({ file: 'pnpm-lock.yaml', manager: 'pnpm', format: 'pnpm', lockfileVersion: m ? m[1] : null });
  }
  return out;
}

function choosePackageManager(pkg, lockfiles, ev) {
  if (pkg.packageManager) {
    const [name, version] = String(pkg.packageManager).split('@');
    return { name, version: version ?? null, via: 'packageManager', evidence: ev(null, 'packageManager') };
  }
  const managers = [...new Set(lockfiles.map((l) => l.manager))];
  if (managers.length === 1) return { name: managers[0], version: null, via: 'lockfile', evidence: lockfiles.map((l) => l.file).join(', ') };
  if (managers.length > 1) return { name: null, version: null, via: 'lockfile', evidence: lockfiles.map((l) => l.file).join(', '), note: 'varios lockfiles de gestores distintos' };
  return { name: 'npm', version: null, via: 'default', evidence: 'package.json (sin lockfile)' };
}

/**
 * Registros de los que sale el árbol de dependencias: los configurados (.npmrc, .yarnrc) y los
 * hosts de los `resolved` del lockfile. Uno privado sin credenciales en el repo es un rechazo
 * con motivo del paso 0d: no hay otra entrada que el repo.
 */
function readRegistries(repo, lockfiles) {
  const found = new Map();
  const add = (url, ev) => {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const key = host;
    if (!found.has(key)) found.set(key, { url: `${new URL(url).protocol}//${host}`, evidence: ev, private: !PUBLIC_REGISTRIES.has(host) });
  };
  for (const rel of ['.npmrc', '.yarnrc']) {
    (repo.lines(rel) ?? []).forEach((l, i) => {
      const m = /^\s*(?:@[\w-]+:)?registry\s*[= ]\s*"?([^"\s]+)"?/.exec(l);
      if (m) add(m[1], evidence(rel, [i + 1]));
    });
  }
  const yarnrc = repo.text('.yarnrc.yml');
  if (yarnrc) {
    for (const entry of parseYamlDocs(yarnrc)) {
      if (entry.value && entry.value.npmRegistryServer) add(entry.value.npmRegistryServer, '.yarnrc.yml');
    }
  }
  for (const lock of lockfiles) {
    const text = repo.text(lock.file) ?? '';
    const hosts = new Map();
    const re = lock.manager === 'yarn' ? /^\s+resolved\s+"?(https?:\/\/[^/"\s]+)/gm : /"resolved"\s*:\s*"(https?:\/\/[^/"]+)/g;
    let m;
    while ((m = re.exec(text))) if (!hosts.has(m[1])) hosts.set(m[1], true);
    for (const host of [...hosts.keys()].sort(cmp)) add(host, `${lock.file} (resolved)`);
  }
  return [...found.values()].sort((a, b) => cmp(a.url, b.url));
}
