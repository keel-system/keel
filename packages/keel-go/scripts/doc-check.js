#!/usr/bin/env node
// La persistencia DOCUMENTAL de keel-go contra un MongoDB REAL miembro de un replica set (incremento 12): por sujeto (las
// fixtures documentales), una prueba Go generada desde el modelo (scripts/lib/doc-probes.js) que EJECUTA los adaptadores
// emitidos: arranca como el servicio (Open + Migrate, que crea los índices), compara el documento CRUDO con el contrato de
// keel-core a todo nivel, los índices vivos con los del contrato, la ida y vuelta, la versión, cada unicidad con su code y
// su mensaje, la página, la fusión, la carrera de dos transacciones y el conflicto agotado, los almacenes del generador
// (outbox, registro de procesados, registro de idempotencia, purgas) y los reclamos de barrido.
//
// Por qué hace falta además de las pruebas sin red: el documento crudo, el replica set y el driver solo existen aquí. Un
// uuid como texto o un decimal como double hacen ida y vuelta con el propio adaptador y los lee mal el otro servidor.
//
//   node packages/keel-go/scripts/doc-check.js [--only=<fixture>] [--sabotage=<id>] [--keep]
//   npm run doc-check --workspace packages/keel-go
//
// --sabotage=<id> rompe lo emitido EN MEMORIA, conservando la forma (sigue compilando): el check tiene que salir rojo en
// las sondas que miden ese mecanismo y solo en ellas.
//
// Necesita Go, podman o docker y la caché de módulos (o red la primera vez).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { usesDocument } from '@keel-system/keel-core/gen/features';
import { planService } from '../src/scaffold/index.js';
import { AUTHORSHIP_DESIGNS, FIXTURES_DIR, makeWorkspace } from '../test/helpers/workspace.js';
import { docProbeFile } from './lib/doc-probes.js';
import { DOC_SABOTAGES as SABOTAGES, applyDocSabotage } from '../test/helpers/doc-sabotages.js';
import { resolveRuntime, startMongo, stopDatabase } from '../../keel-nest/scripts/lib/database-container.js';

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null;
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.slice('--sabotage='.length) ?? null;
const keep = process.argv.includes('--keep');
const storePath = 'internal/infrastructure/mongo';
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime))) process.exit(1);
if (!step('Go disponible', spawnSync('go', ['version']).status === 0)) process.exit(1);

let database;
try {
  database = await startMongo(runtime);
} catch (error) {
  step('MongoDB en replica set en marcha', false, error.message);
  process.exit(1);
}
step('MongoDB en replica set en marcha', true, `puerto ${database.port}`);
const root = makeWorkspace('keel-go-doc-check-');

try {
  const subjects = [];
  let applied = 0;
  // Las fixtures y el diseño derivado de la autoría declarada (13g).
  const designs = [
    ...fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml'))).map((name) => ({ name, from: name, mutate: null })),
    ...AUTHORSHIP_DESIGNS
  ];
  for (const { name, from, mutate } of designs) {
    if (only && name !== only) continue;
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    if (mutate) mutate(manifest, layers);
    // Los sujetos son los diseños DOCUMENTALES (lo dice su persistence.keel.yaml), con su stack por defecto.
    if (layers?.persistence?.default?.model !== 'document') continue;
    // Toda la fixture, como go-check --fixtures: planService no pasa por la frontera.
    const plan = planService({ manifest, layers, workspace: FIXTURES_DIR });
    if (!usesDocument(plan.model)) continue;
    let files = plan.files;
    if (sabotage) {
      const sabotaged = applyDocSabotage(SABOTAGES[sabotage], files);
      if (sabotaged.changed === 0) continue;
      applied += sabotaged.changed;
      files = sabotaged.files;
    }
    const probe = docProbeFile(plan.model);
    if (!probe) continue;
    const dir = path.join(root, name);
    for (const file of [...files, probe]) {
      const target = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    if (probe.unsampled.length > 0) console.log(`  (${name}: sin muestra para ${probe.unsampled.join(', ')})`);
    subjects.push({ name, dir, db: `${name.replace(/-/g, '_')}_doc_probes` });
  }
  const url = (db) => database.url.replace(/\/keel_db_check\?/, `/${db}?`);
  const outcomes = await pool(subjects, 2, async ({ dir, db }) => {
    const tidied = await runAsync('go', ['mod', 'tidy'], { cwd: dir });
    if (!tidied.ok) return { tidied };
    // Compilada aparte y ejecutada desde el sujeto: en Windows el antivirus puede denegar el .test.exe de %TEMP%\go-build.
    const binary = path.join(dir, process.platform === 'win32' ? 'doc-probe.test.exe' : 'doc-probe.test');
    const built = await runAsync('go', ['test', '-c', '-o', binary, `./${storePath}/`], { cwd: dir });
    if (!built.ok) return { tidied, tested: built };
    return { tidied, tested: await runAsync(binary, ['-test.count=1', '-test.v'], { cwd: path.join(dir, storePath), env: { DOC_CHECK_URL: url(db) } }) };
  });
  subjects.forEach(({ name }, index) => {
    const { tidied, tested } = outcomes[index];
    if (!step(`${name}: go mod tidy`, tidied.ok, tidied.ok ? '' : tidied.output.slice(0, 2000))) return;
    const failed = [...tested.output.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]).filter((test) => !test.includes('/'));
    const passed = [...tested.output.matchAll(/^\s*--- PASS: (\S+)/gm)].map((m) => m[1]);
    const ran = failed.length + passed.length;
    if (!sabotage) {
      const ok = tested.ok && ran > 0;
      step(`${name}: los adaptadores documentales guardan, leen y traducen contra MongoDB (${passed.length} sondas)`, ok, ok ? '' : failed.join(', ') || tested.output.slice(-3000));
      if (!ok && failed.length > 0) console.error(failureLines(tested.output));
      return;
    }
    const { expect, also } = SABOTAGES[sabotage];
    const expected = failed.filter((test) => expect.test(test));
    const stray = failed.filter((test) => !expect.test(test) && !(also && also.test(test)));
    const compiled = ran > 0;
    step(
      `falsado: ${sabotage} en ${name} → ${expected.length > 0 ? `rojo en ${expected.join(', ')}` : 'ninguna sonda lo mide aquí'}`,
      compiled && stray.length === 0,
      compiled ? (stray.length > 0 ? `caen además ${stray.join(', ')}` : '') : `no compila: ${tested.output.slice(0, 2000)}`
    );
    if (expected.length > 0) results.at(-1).caught = true;
  });
  if (sabotage) {
    if (step(`el sabotaje ${sabotage} se aplica a lo emitido`, applied > 0, applied === 0 ? '¿cambió el texto emitido?' : `${applied} archivo(s)`)) {
      step(`el sabotaje ${sabotage} lo ve al menos una sonda`, results.some((result) => result.caught));
    }
  }
} finally {
  if (keep) console.log(`\nMongoDB sigue en marcha (${runtime} exec -it ${database.name} mongosh); sujetos en ${root}`);
  else stopDatabase(runtime, database);
}

const failedSteps = results.filter((result) => !result.ok).length;
console.log(failedSteps === 0 ? `\ndoc-check: ${results.length}/${results.length} en verde.` : `\ndoc-check: ${failedSteps} paso(s) en rojo.`);
process.exitCode = failedSteps === 0 ? 0 : 1;

function runAsync(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ ok: status === 0, output }));
  });
}

async function pool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

function failureLines(output) {
  return output
    .split('\n')
    .filter((line) => /^\s+\S+_test\.go:\d+:|--- FAIL|panic:/.test(line))
    .slice(0, 40)
    .join('\n');
}
