import path from 'node:path';
import { cmp, cmpEvidence, findLine, isTestPath } from './repo.js';
import { ciSystemOf } from './declarations.js';

// Inventario de activos del repo (paso 0b): pruebas, specs, colecciones, stubs, seeds,
// migraciones y scripts. Son ENTRADA para la herramienta —la ronda 0 de sondas, los stubs de
// WireMock, los datos— y a la vez AFIRMACIONES de sus autores, que pueden estar desfasadas
// (principio 7): por eso cada uno sale con lo que dice de sí mismo (cuántas rutas documenta una
// spec, cuántas peticiones trae una colección), para que se pueda comparar con lo medido.

const JSON_OR_YAML = /\.(json|ya?ml)$/;
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function inventoryAssets(repo) {
  const out = [];
  for (const rel of repo.files) {
    if (ciSystemOf(rel)) continue; // la CI va en runtime.yaml
    const asset = classify(repo, rel);
    if (asset) out.push(asset);
  }
  if (repo.has('package.json')) out.push(...packageScripts(repo));
  return out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.path, b.path) || cmpEvidence(a.evidence, b.evidence));
}

function classify(repo, rel) {
  const base = path.posix.basename(rel);
  const lower = rel.toLowerCase();
  const test = isTestPath(rel) || /(^|\/)src\/test\//.test(rel);

  if (JSON_OR_YAML.test(rel)) {
    const text = repo.text(rel) ?? '';
    const head = text.slice(0, 4000);
    if (/schema\.getpostman\.com|"_postman_id"/.test(head) || /\.postman_collection\.json$/.test(lower)) {
      return { kind: 'collection', path: rel, format: 'postman', ...countPostman(text) };
    }
    if (/"_postman_variable_scope"\s*:\s*"environment"/.test(text) || /\.postman_environment\.json$/.test(lower)) {
      return { kind: 'collection-environment', path: rel, format: 'postman' };
    }
    const spec = /^\s*["']?(swagger|openapi)["']?\s*:\s*["']?([\d.]+)/m.exec(head);
    if (spec) return { kind: 'api-spec', path: rel, format: `${spec[1]} ${spec[2]}`, ...countPaths(text, rel) };
    if (/(^|\/)mappings\/[^/]+\.json$/.test(rel) && /"request"\s*:/.test(head) && /"response"\s*:/.test(head)) {
      return { kind: 'stub', path: rel, format: 'wiremock' };
    }
    if (base === 'db.json' && test) return { kind: 'stub', path: rel, format: 'json-server' };
    if (/(^|\/)(db\/)?changelog\//.test(rel) || /changelog[^/]*\.(xml|ya?ml|json)$/.test(base)) {
      return { kind: 'migration', path: rel, format: 'liquibase' };
    }
    if (/(^|\/)(seeds?|fixtures)\//.test(rel)) return { kind: 'seed', path: rel };
  }

  if (/(^|\/)db\/migration\/V[\d._]+__.+\.sql$/.test(rel)) return { kind: 'migration', path: rel, format: 'flyway' };
  if (/(^|\/)(migrations?)\/[^/]+\.(js|ts|sql)$/.test(rel) && !test) return { kind: 'migration', path: rel };
  if (/(^|\/)prisma\/schema\.prisma$/.test(rel)) return { kind: 'migration', path: rel, format: 'prisma' };
  if (/^(data|import|seed[^/]*)\.sql$/.test(base) || /(^|\/)(seeds?|fixtures)\/[^/]+\.(js|ts|sql|json)$/.test(rel)) {
    return { kind: 'seed', path: rel };
  }
  if (/\.(dredd|apib)$/.test(base) || base === 'dredd.yml') return { kind: 'contract-test', path: rel, format: 'dredd' };

  if (/\.(js|ts|mjs|cjs|py|rb|go|java|kt|groovy)$/.test(rel)) {
    const text = repo.text(rel) ?? '';
    if (/require\(\s*['"](hooks|dredd-hooks)['"]\s*\)|from\s+['"]dredd/.test(text)) {
      return { kind: 'contract-test', path: rel, format: 'dredd-hooks', ...(/\.insert(Many|One)?\s*\(|\.create\s*\(/.test(text) ? { seeds: true } : {}) };
    }
    if (test && /\bFlask\s*\(|\bexpress\s*\(\s*\)|http\.createServer\s*\(|\bnew\s+WireMockServer\b/.test(text)) {
      return { kind: 'stub', path: rel, format: /\bFlask\s*\(/.test(text) ? 'flask' : /WireMockServer/.test(text) ? 'wiremock' : 'http-server' };
    }
    if (test) return { kind: 'test', path: rel, language: languageOf(rel), ...testLevel(rel) };
  }

  if (rel.endsWith('.sh') || base === 'Makefile') return { kind: 'script', path: rel };
  if (/(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(rel)) return { kind: 'compose', path: rel };
  return null;
}

function languageOf(rel) {
  const ext = path.posix.extname(rel).slice(1);
  return { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', go: 'go', java: 'java', kt: 'kotlin', groovy: 'groovy' }[ext] ?? ext;
}

// Nivel declarado por el nombre, que es lo que usan surefire y failsafe para separarlas.
function testLevel(rel) {
  const base = path.posix.basename(rel);
  if (/^IT[A-Z]|IT\.(java|kt)$|IntegrationTests?\.(java|kt)$/.test(base)) return { level: 'integration' };
  if (/^Unit[A-Z]|Tests?\.(java|kt)$/.test(base)) return { level: 'unit' };
  return {};
}

function countPostman(text) {
  try {
    const col = JSON.parse(text);
    let n = 0;
    const walk = (items) => {
      for (const it of items ?? []) {
        if (it.request) n++;
        if (it.item) walk(it.item);
      }
    };
    walk(col.item);
    return { requests: n };
  } catch {
    return {};
  }
}

function countPaths(text, rel) {
  if (rel.endsWith('.json')) {
    try {
      const doc = JSON.parse(text);
      if (!doc.paths) return {};
      const ops = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item ?? {}).filter((k) => HTTP_METHODS.has(k)).length, 0);
      return { paths: Object.keys(doc.paths).length, operations: ops };
    } catch {
      return {};
    }
  }
  // YAML: las claves de primer nivel bajo `paths:`.
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^paths\s*:/.test(l));
  if (start === -1) return {};
  let n = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (/^ {2}['"]?\//.test(lines[i])) n++;
  }
  return { paths: n };
}

function packageScripts(repo) {
  let pkg;
  try {
    pkg = JSON.parse(repo.text('package.json'));
  } catch {
    return [];
  }
  const lines = repo.lines('package.json');
  const start = findLine(lines, '"scripts"');
  return Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({
    kind: 'script',
    path: 'package.json',
    name: `scripts.${name}`,
    command: String(command),
    evidence: `package.json:${findLine(lines, `"${name}"`, start)}`,
  }));
}
