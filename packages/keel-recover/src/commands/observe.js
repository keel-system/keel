import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import pc from 'picocolors';
import { loadSandbox } from '../lib/sandbox.js';
import { containerRuntime, resolveRuntime } from '../lib/containers.js';
import { introspect as ask, mergeSurface } from '../lib/introspect.js';
import { loadRound, runRound } from '../lib/probe.js';

// Paso 1: `keel-recover introspect` (1a) y `keel-recover probe` (1b). Los dos trabajan sobre el
// sandbox que dejó verify arriba y escriben en `legacy/<servicio>/`, junto a sandbox/:
//   surface.yaml                     la superficie, fundida pasada a pasada
//   recordings/<ronda>/<id>.json     una grabación por sonda
//   recordings/<ronda>/round.json    los criterios PRB-*, el resumen y la cobertura de la ronda
//   recordings/coverage.json         la serie de cobertura, ronda a ronda (el estancamiento)

function openSandbox(target) {
  const sandbox = loadSandbox(target);
  if (sandbox.errors.length) {
    for (const e of sandbox.errors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  return sandbox;
}

function openRuntime(options) {
  const runtime = options.runtime ?? resolveRuntime();
  if (!runtime) {
    console.error(pc.red('✗ hace falta podman o docker en marcha'));
    process.exit(2);
  }
  return containerRuntime(runtime);
}

const readYaml = (file) => (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : null);
const writeYaml = (file, doc, header) => fs.writeFileSync(file, `${header}\n${YAML.stringify(doc, { lineWidth: 0 })}`);
const SURFACE_HEADER =
  '# Superficie del legacy (paso 1a), preguntada al runtime: rutas del framework, colecciones y topología\n# del broker. La escriben `keel-recover introspect` y cada ronda de `keel-recover probe`; `seen` dice en\n# qué pasada apareció cada elemento y `absent`, en cuál dejó de verse.';

function updateSurface(sandbox, rt, label, out) {
  const file = out ?? path.join(path.dirname(sandbox.dir), 'surface.yaml');
  const fresh = ask(sandbox, rt);
  writeYaml(file, mergeSurface(readYaml(file), fresh.surface, label), SURFACE_HEADER);
  return { file, ...fresh };
}

export function introspect(target, options) {
  const sandbox = openSandbox(target ?? '.');
  const rt = openRuntime(options);
  const r = updateSurface(sandbox, rt, 'introspect', options.out);
  const s = r.surface;
  console.log(`${pc.green('✓')} ${path.relative(process.cwd(), r.file)}`);
  if (s.http) console.log(`  http     ${s.http.routes.length} ruta(s) (${s.http.source})`);
  if (s.data) console.log(`  datos    ${s.data.collections.length} colección(es) en ${s.data.database}`);
  if (s.broker) console.log(`  broker   ${s.broker.exchanges.length} exchange(s), ${s.broker.queues.length} cola(s), ${s.broker.bindings.length} enlace(s)`);
  for (const e of r.errors) console.error(pc.red(`✗ ${e}`));
  process.exit(r.ok ? 0 : 1);
}

export async function probe(roundFile, options) {
  const roundAbs = path.resolve(roundFile);
  const legacyDir = path.dirname(path.dirname(roundAbs));
  const sandbox = openSandbox(options.sandbox ?? path.join(legacyDir, 'sandbox'));
  const { doc, errors } = loadRound(roundAbs);
  if (errors.length) {
    for (const e of errors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  const rt = openRuntime(options);
  const tag = path.basename(roundAbs).replace(/\.ya?ml$/, '');
  const recDir = path.join(legacyDir, 'recordings');
  const outDir = options.out ? path.resolve(options.out) : path.join(recDir, tag);
  const historyFile = path.join(recDir, 'coverage.json');
  const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
  const previous = history.filter((h) => h.round !== tag).at(-1)?.cumulative ?? null;

  const report = await runRound(sandbox, rt, doc, {
    tag,
    only: options.only ? new Set(String(options.only).split(',')) : null,
    previous,
    log: (s) => console.log(`${s.untrusted ? pc.red('✗') : ' '} ${s.id.padEnd(12)} [${s.codes}] ${s.effects}${s.outcomes ? `  ${JSON.stringify(s.outcomes)}` : ''}${s.untrusted ? pc.red(`  sin fiar: ${s.untrusted.join(', ')}`) : ''}`),
  });

  fs.mkdirSync(outDir, { recursive: true });
  for (const { id, recording } of report.recordings) fs.writeFileSync(path.join(outDir, `${id}.json`), `${JSON.stringify(recording, null, 2)}\n`);
  const { recordings, ...round } = report;
  fs.writeFileSync(path.join(outDir, 'round.json'), `${JSON.stringify(round, null, 2)}\n`);
  if (report.coverage && !options.only) {
    const next = [...history.filter((h) => h.round !== tag), { round: tag, ...report.coverage }];
    fs.writeFileSync(historyFile, `${JSON.stringify(next, null, 2)}\n`);
  }
  if (report.recordings.length) {
    const s = updateSurface(sandbox, rt, tag);
    for (const e of s.errors) console.error(pc.yellow(`! superficie: ${e}`));
  }
  console.log('');
  for (const c of report.criteria) console.log(`${c.ok ? pc.green('✓') : c.skipped ? pc.dim('·') : pc.red('✗')} ${c.id}  ${c.detail}`);
  console.log(report.ok ? pc.green(`\nronda ${tag} en verde: ${path.relative(process.cwd(), outDir)}`) : pc.red(`\nronda ${tag} en rojo: lo grabado en un canal en rojo no es evidencia`));
  process.exit(report.ok ? 0 : 1);
}
