#!/usr/bin/env node
// EJECUTA la prueba del contrato del token que build deja en el proyecto (TokenContractTest, casos IDT-* de
// keel-core/gen/token-cases.js): genera, compila y corre esa clase con Gradle. Sin contenedores ni proveedor.
//
// Por qué existe: lo que se mide aquí compila diga lo que diga, y contra un emulador más cómodo que el proveedor no se
// ve. Un ID token aceptado como access token, o el scope de otra API convertido en permiso, conceden de más sin que
// ningún escenario falle.
//
//   node packages/keel-spring/scripts/token-check.js [diseño] [--auth=<proveedor>] [--sabotage=<id>] [--keep]
//   npm run token-check --workspace packages/keel-spring
//
// Diseños: el nombre de una fixture o de una silueta de keel-core/test/helpers/identity-designs.js. Necesita JDK y red.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando), y verde significa que cae en EXACTAMENTE los
// casos marcados con su defecto.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { tmpDir } from '../test/helpers/tmp.js';
import { planService, scaffoldService } from '../src/scaffold/index.js';
import { TOKEN_SABOTAGES as SABOTAGES } from '../src/lib/token-sabotages.js';
import { IDENTITY_DESIGNS } from '../../keel-core/test/helpers/identity-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? null;
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'asset-vault';
const auth = option('auth') ?? 'cognito';
const sabotage = option('sabotage');

const methodOf = (id) => id.toLowerCase().replace(/-(.)/g, (_, letter) => letter.toUpperCase());

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

function readResults(projectDir) {
  const dir = path.join(projectDir, 'build', 'test-results', 'test');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.includes('TokenContractTest') && name.endsWith('.xml'))
    .flatMap((name) => [...fs.readFileSync(path.join(dir, name), 'utf8').matchAll(/<testcase name="([^"(]+)[^"]*"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)])
    .map((match) => ({ method: match[1], ok: !/<failure/.test(match[3] ?? ''), detail: /<failure message="([^"]*)"/.exec(match[3] ?? '')?.[1]?.slice(0, 140) ?? null }));
}

if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}
if (spawnSync('java', ['-version']).status !== 0) {
  console.error('No hay JDK en el PATH.');
  process.exit(2);
}

const silhouette = IDENTITY_DESIGNS.find((design) => design.name === designName);
const service = loadService(path.join(fixturesDir, silhouette?.from ?? designName));
silhouette?.mutate(service.layers);
const stack = { auth };
const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};
let cases;
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-token-keep-')) : tmpDir('keel-token-check-');
try {
  cases = tokenCases(planService({ manifest: service.manifest, layers: service.layers, workspace: '.', stack }).model);
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
} finally {
  Object.assign(console, quiet);
}
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

let expected = [];
if (sabotage) {
  const { defects, methods = [], edits } = SABOTAGES[sabotage];
  expected = [...cases.filter((entry) => defects.includes(entry.defect)).map((entry) => methodOf(entry.id)), ...methods].sort();
  if (expected.length === 0) {
    console.error(`El sabotaje '${sabotage}' no tiene casos en ${designName} con ${auth}.`);
    process.exit(2);
  }
  const sources = walk(path.join(projectDir, 'src', 'main', 'java'));
  let applied = 0;
  for (const [className, from, to] of edits) {
    for (const file of sources.filter((candidate) => candidate.endsWith(`${path.sep}${className}.java`))) {
      const text = fs.readFileSync(file, 'utf8');
      const changed = typeof from === 'string' ? text.replaceAll(from, to) : text.replace(from, to);
      if (changed !== text) {
        fs.writeFileSync(file, changed);
        applied += 1;
      }
    }
  }
  if (applied === 0) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy para ${designName} (¿cambió el texto?).`);
    process.exit(2);
  }
  console.log(`(sabotaje: ${sabotage}; tiene que caer en ${expected.join(', ')})`);
}

console.log(`Contrato del token de ${designName} con ${auth}: ${cases.length} casos`);
const gradle = spawnSync('sh', ['gradlew', 'test', '--tests', '*.TokenContractTest', '--console=plain', '--no-daemon'], { cwd: projectDir, encoding: 'utf8' });
const results = readResults(projectDir);
let exitCode = 1;
if (results.length === 0) {
  console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
  console.error(`${gradle.stdout}${gradle.stderr}`.split('\n').slice(-60).join('\n'));
} else {
  for (const item of results) console.log(`  ${item.ok ? 'OK  ' : 'KO  '} ${item.method}${item.detail ? ` — ${item.detail}` : ''}`);
  const fell = results.filter((item) => !item.ok).map((item) => item.method).sort();
  if (sabotage) {
    const exact = fell.join() === expected.join();
    console.log(`\n  cayeron ${fell.join(', ') || 'ninguno'}; tenían que caer ${expected.join(', ')} → ${exact ? 'VERDE (el sabotaje se ve, y solo en sus casos)' : 'ROJO'}`);
    exitCode = exact ? 0 : 1;
  } else {
    console.log(`\n  ${results.length - fell.length}/${results.length} en verde`);
    exitCode = fell.length > 0 ? 1 : 0;
  }
}
if (keep) console.log(`\n  --keep: el proyecto queda en ${projectDir}.`);
process.exit(exitCode);
