import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { emitHarnessFiles } from 'keel-core';
import { renderDoc } from './emit.js';
import { fingerprint } from './fingerprint.js';
import { envDeps } from './env-deps.js';

// `keel-recover init`: prepara `legacy/<servicio>/` en el workspace de diseño. Es la primera pieza
// de Keel que escribe en el workspace sin ser keel-core: keel-recover es una ENTRADA al diseño, no
// un generador. Escribe lo determinista (los pasos 0a y 0b), la instrumentación que el sandbox
// monta y la skill que lo construye; el sandbox lo escribe el agente.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILLS = ['keel-recover-sandbox'];
const INSTRUMENTS = ['v8-coverage-exit.cjs'];

export function kebab(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Lo que vuelve a escribir la herramienta en environment.yaml conserva lo que puso el agente: la
 * lista `adaptations` y lo que añadió a cada `provision` (la imagen, su versión, su motivo).
 */
export function mergeEnvironment(fresh, previous) {
  if (!previous) return fresh;
  const out = { ...fresh, adaptations: previous.adaptations ?? [] };
  const key = (d) => `${d.kind}|${d.tech}|${d.endpoints?.[0]?.host ?? d.endpoints?.[0]?.key ?? d.endpoints?.[0]?.env ?? ''}`;
  const before = new Map((previous.dependencies ?? []).map((d) => [key(d), d]));
  out.dependencies = (fresh.dependencies ?? []).map((d) => {
    const old = before.get(key(d));
    if (!old?.provision) return d;
    const extra = Object.fromEntries(Object.entries(old.provision).filter(([k]) => !(k in d.provision)));
    return { ...d, provision: { ...d.provision, ...extra } };
  });
  return out;
}

/** Archivos que escribe `init` (rutas relativas al workspace), sin escribirlos. */
export function planInit({ workspace, repo, name }) {
  const ws = path.resolve(workspace);
  const repoAbs = path.resolve(repo);
  const service = kebab(name ?? path.basename(repoAbs));
  if (!service) throw new Error('no se puede derivar el nombre del servicio: usa --name');
  const base = `legacy/${service}`;
  const legacyDir = path.join(ws, base);
  const rel = path.relative(legacyDir, repoAbs).replace(/\\/g, '/');
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('el repo del legacy no puede vivir dentro de legacy/<servicio>/: es la entrada, no la evidencia');

  const runtime = renderDoc(fingerprint(repoAbs));
  const freshEnv = renderDoc(envDeps(repoAbs));
  for (const d of [runtime, freshEnv]) if (d.errors.length) throw new Error(`defecto de keel-recover: ${d.errors.join('; ')}`);
  const envFile = path.join(legacyDir, 'environment.yaml');
  const previous = fs.existsSync(envFile) ? YAML.parse(fs.readFileSync(envFile, 'utf8')) : null;
  const env = renderDoc(mergeEnvironment(freshEnv.plain, previous));
  if (env.errors.length) throw new Error(`environment.yaml existente no cumple su schema tras la fusión: ${env.errors.join('; ')}`);

  const files = [
    { path: `${base}/legacy.yaml`, content: YAML.stringify({ kind: 'legacy', schema: 1, name: service, repo: rel }) },
    { path: `${base}/runtime.yaml`, content: runtime.text },
    { path: `${base}/environment.yaml`, content: env.text },
    ...INSTRUMENTS.map((f) => ({ path: `${base}/sandbox/instrument/${f}`, content: fs.readFileSync(path.join(packageRoot, 'assets', 'sandbox', f), 'utf8') })),
    ...emitHarnessFiles({ skills: SKILLS.map((s) => path.join(packageRoot, 'assets', 'skills', s)) }),
  ];
  return { service, base, files, unsupported: runtime.plain.unsupported ?? null };
}

export function writePlan(workspace, files) {
  for (const f of files) {
    const target = path.join(workspace, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
}
