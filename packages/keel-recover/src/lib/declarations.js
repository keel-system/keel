import path from 'node:path';
import { cmp, cmpEvidence, evidence, findLine, isTestPath } from './repo.js';
import { dockerRunImages, imageFacts, parseImage, travisServiceTech } from './images.js';
import { keyLine, nodeAt, parseYamlDocs } from './yaml-lines.js';

// Lo que el repo dice de su propio runtime FUERA del archivo de build: la CI, los Dockerfiles, los
// compose y los scripts. Cada hecho sale como una declaración con su `via` (quién lo dice) y su
// `archivo:línea`. No se decide nada aquí: elegir entre declaraciones es de `fingerprint`.

const CI_SYSTEMS = [
  [/^\.travis\.ya?ml$/, 'travis'],
  [/^\.circleci\/config\.ya?ml$/, 'circleci'],
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'github-actions'],
  [/^\.gitlab-ci\.ya?ml$/, 'gitlab-ci'],
  [/^bitbucket-pipelines\.ya?ml$/, 'bitbucket'],
  [/^azure-pipelines\.ya?ml$/, 'azure-pipelines'],
  [/^Jenkinsfile$/, 'jenkins'],
];

export function ciSystemOf(rel) {
  for (const [re, system] of CI_SYSTEMS) if (re.test(rel)) return system;
  return null;
}

const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$|\.Dockerfile$/;
const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;

export function collectDeclarations(repo) {
  const ci = [];
  const dockerfiles = [];
  const composeFiles = [];
  const declarations = [];
  const commands = [];

  for (const rel of repo.files) {
    const system = ciSystemOf(rel);
    if (system) {
      ci.push({ file: rel, system });
      const text = repo.text(rel);
      if (text !== null && system !== 'jenkins') {
        readCi(rel, system, text, declarations, commands);
      }
      continue;
    }
    if (DOCKERFILE.test(rel)) {
      const df = readDockerfile(rel, repo.lines(rel) ?? []);
      dockerfiles.push(df);
      for (const stage of df.stages) pushImage(declarations, stage.image, 'dockerfile', stage.evidence);
      continue;
    }
    if (COMPOSE.test(rel)) {
      composeFiles.push(rel);
      readCompose(rel, repo.text(rel) ?? '', declarations);
      continue;
    }
    if (rel.endsWith('.sh') || path.posix.basename(rel) === 'Makefile') {
      const lines = repo.lines(rel) ?? [];
      lines.forEach((line, i) => {
        for (const image of dockerRunImages(line)) pushImage(declarations, image, 'script', evidence(rel, [i + 1]));
      });
    }
  }

  if (repo.has('package.json')) readPackageScripts(repo, declarations);

  return {
    ci,
    dockerfiles,
    composeFiles,
    declarations: declarations.sort(byEvidence),
    commands,
  };
}

function byEvidence(a, b) {
  return cmpEvidence(a.evidence, b.evidence) || cmp(a.what, b.what) || cmp(a.name, b.name);
}

function pushImage(out, image, via, ev, extra = {}) {
  if (!image || /\$/.test(image)) return; // una imagen con variables no dice nada por sí sola
  for (const fact of imageFacts(image)) out.push({ ...fact, via, evidence: ev, ...extra });
}

function asList(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ── CI ────────────────────────────────────────────────────────────────────────────────────────

function readCi(rel, system, text, out, commands) {
  for (const entry of parseYamlDocs(text)) {
    const v = entry.value;
    if (!v || typeof v !== 'object') continue;
    const line = (keys) => evidence(rel, [entry.lineOf(nodeAt(entry, keys)) || keyLine(entry, keys)]);
    const cmd = (keys, value) => {
      for (const [i, c] of asList(value).entries()) {
        const body = typeof c === 'string' ? c : c && typeof c.command === 'string' ? c.command : null;
        if (!body) continue;
        const k = Array.isArray(value) ? [...keys, i] : keys;
        const node = nodeAt(entry, typeof c === 'string' ? k : [...k, 'command']);
        const first = entry.lineOf(node) || keyLine(entry, k);
        // Un bloque `|` empieza en la línea del indicador: su primera línea de texto es la siguiente.
        const shift = node && /^BLOCK_/.test(String(node.type)) ? 1 : 0;
        body.split('\n').forEach((t, j) => {
          if (t.trim()) commands.push({ text: t.trim(), via: system, evidence: evidence(rel, [first + shift + j]) });
        });
      }
    };

    if (system === 'travis') {
      asList(v.jdk).forEach((jdk, i) => {
        const m = /(\d+)$/.exec(String(jdk));
        out.push({ what: 'language', name: 'java', version: m ? m[1] : null, via: 'travis', note: String(jdk), evidence: line(Array.isArray(v.jdk) ? ['jdk', i] : ['jdk']) });
      });
      asList(v.node_js).forEach((n, i) => {
        out.push({ what: 'language', name: 'node', version: String(n), via: 'travis', evidence: line(Array.isArray(v.node_js) ? ['node_js', i] : ['node_js']) });
      });
      asList(v.services).forEach((s, i) => {
        const tech = travisServiceTech(s);
        if (tech) {
          const version = v.addons && v.addons[tech] != null ? String(v.addons[tech]) : null;
          out.push({ what: 'service', name: tech, version, via: 'travis', image: null, pinned: false, evidence: line(Array.isArray(v.services) ? ['services', i] : ['services']) });
        }
      });
      for (const k of ['before_install', 'install', 'before_script', 'script']) cmd([k], v[k]);
    }

    if (system === 'circleci') {
      for (const group of ['jobs', 'executors']) {
        for (const [job, def] of Object.entries(v[group] ?? {})) {
          asList(def && def.docker).forEach((d, i) => {
            if (d && d.image) pushImage(out, d.image, 'circleci', line([group, job, 'docker', i, 'image']));
          });
          asList(def && def.steps).forEach((step, i) => {
            if (step && typeof step === 'object' && step.run !== undefined) cmd([group, job, 'steps', i, 'run'], step.run);
          });
        }
      }
    }

    if (system === 'github-actions') {
      for (const [job, def] of Object.entries(v.jobs ?? {})) {
        if (!def || typeof def !== 'object') continue;
        const matrix = (def.strategy && def.strategy.matrix) || {};
        const container = typeof def.container === 'string' ? def.container : def.container && def.container.image;
        if (container) pushImage(out, container, 'github-actions', line(typeof def.container === 'string' ? ['jobs', job, 'container'] : ['jobs', job, 'container', 'image']));
        for (const [alias, svc] of Object.entries(def.services ?? {})) {
          if (svc && svc.image) pushImage(out, svc.image, 'github-actions', line(['jobs', job, 'services', alias, 'image']), { alias });
        }
        asList(def.steps).forEach((step, i) => {
          if (!step || typeof step !== 'object') return;
          const uses = String(step.uses ?? '');
          const setup = /^actions\/setup-(node|java)@/.exec(uses);
          if (setup) {
            const lang = setup[1];
            const key = lang === 'node' ? 'node-version' : 'java-version';
            const raw = step.with ? step.with[key] : undefined;
            if (raw !== undefined) {
              const ref = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(String(raw));
              const values = ref ? asList(matrix[ref[1]]) : [raw];
              const keys = ref ? ['jobs', job, 'strategy', 'matrix', ref[1]] : ['jobs', job, 'steps', i, 'with', key];
              values.forEach((val, j) => {
                out.push({ what: 'language', name: lang, version: String(val), via: 'github-actions', evidence: line(ref && Array.isArray(matrix[ref[1]]) ? [...keys, j] : keys) });
              });
            }
          }
          if (step.run !== undefined) cmd(['jobs', job, 'steps', i, 'run'], step.run);
        });
      }
    }

    if (system === 'gitlab-ci' || system === 'bitbucket') {
      const scan = (def, keys) => {
        if (!def || typeof def !== 'object') return;
        const image = typeof def.image === 'string' ? def.image : def.image && def.image.name;
        if (image) pushImage(out, image, system, line(typeof def.image === 'string' ? [...keys, 'image'] : [...keys, 'image', 'name']));
        asList(def.services).forEach((s, i) => {
          const ref = typeof s === 'string' ? s : s && s.name;
          if (!ref) return;
          const alias = (s && s.alias) || defaultGitlabAlias(ref);
          pushImage(out, ref, system, line(typeof s === 'string' ? [...keys, 'services', i] : [...keys, 'services', i, 'name']), { alias });
        });
        for (const k of ['before_script', 'script']) if (def[k] !== undefined) cmd([...keys, k], def[k]);
      };
      scan(v, []);
      for (const [job, def] of Object.entries(v)) {
        if (def && typeof def === 'object' && !Array.isArray(def) && (def.script || def.image)) scan(def, [job]);
      }
    }
  }
}

// GitLab publica cada servicio con el nombre de su imagen sin tag (`postgres:9.6` → `postgres`).
function defaultGitlabAlias(ref) {
  return parseImage(ref).repo.replace(/\//g, '__');
}

// ── Dockerfile ────────────────────────────────────────────────────────────────────────────────

function readDockerfile(rel, lines) {
  const stages = [];
  const stageNames = new Set();
  lines.forEach((raw, i) => {
    const m = /^\s*FROM\s+(.+?)\s*$/i.exec(raw);
    if (!m) return;
    const tokens = m[1].split(/\s+/).filter((t) => !t.startsWith('--'));
    const image = tokens[0];
    const as = tokens.length >= 3 && tokens[1].toLowerCase() === 'as' ? tokens[2] : null;
    if (image && !stageNames.has(image)) {
      stages.push({ image, pinned: parseImage(image).pinned, ...(as ? { stage: as } : {}), evidence: evidence(rel, [i + 1]) });
    }
    if (as) stageNames.add(as);
  });
  return { path: rel, role: isTestPath(rel) ? 'test' : 'app', stages };
}

// ── compose ───────────────────────────────────────────────────────────────────────────────────

function readCompose(rel, text, out) {
  for (const entry of parseYamlDocs(text)) {
    const services = entry.value && entry.value.services;
    if (!services || typeof services !== 'object') continue;
    for (const [key, svc] of Object.entries(services)) {
      if (!svc || typeof svc.image !== 'string') continue;
      const alias = typeof svc.hostname === 'string' ? svc.hostname : key;
      pushImage(out, svc.image.trim(), 'compose', evidence(rel, [entry.lineOf(nodeAt(entry, ['services', key, 'image']))]), { alias });
    }
  }
}

// ── package.json#scripts ──────────────────────────────────────────────────────────────────────

function readPackageScripts(repo, out) {
  let pkg;
  try {
    pkg = JSON.parse(repo.text('package.json'));
  } catch {
    return;
  }
  const lines = repo.lines('package.json');
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    const ln = findLine(lines, `"${name}"`);
    for (const image of dockerRunImages(String(script))) {
      pushImage(out, image, 'script', evidence('package.json', [ln]), { note: `scripts.${name}` });
    }
  }
}
