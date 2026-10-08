#!/usr/bin/env node
// Ejercita el ARNÉS DE INTEGRACIÓN documental de keel-nest (incremento 12d) contra su infraestructura real:
// el gemelo de harness-check para MongoDB, y lo que en keel-spring mide mongo-check sobre su AbstractFlowIT.
//
// Lo que solo la base real juzga, porque un script de mongosh roto no falla: devuelve cero o no modifica nada.
//   · que `mongoEval` haga llegar un script con comillas INTACTO (viaja por archivo) y que su salida se
//     imprima (por archivo mongosh no imprime la última expresión: vacío parecería un cero);
//   · que `resetState()` (infra/reset-db.sh) vacíe los documentos y CONSERVE los índices;
//   · que `stallInFlight` deje el estado Y el reloj rancio, que `putInFlight` deje un reloj DISTINTO (a ahora),
//     y que `inFlightWithoutClock` discrimine (cero con el reloj estampado, uno sin él);
//   · que `ageForReconciliation` envejezca SOLO la marca de espera, con el script que emite un diseño que la
//     tiene (asset-vault, que build no genera entero —storage es del incremento 13—: se lee de lo que emite);
//   · y la cadena entera: up.sh, validate-infra.sh, el humo del arnés y score-scenarios.sh puntuando.
//
//   node packages/keel-nest/scripts/doc-harness-check.js [--keep]
//   npm run doc-harness-check --workspace packages/keel-nest
//
// Necesita podman o docker, y red la primera vez.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { resolveStack, writeStackConfig } from 'keel-core/gen/stack';
import { makeWorkspace, mountDesign, runCommand, FIXTURES_DIR } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { resolveRuntime } from './lib/database-container.js';

const keep = process.argv.includes('--keep');
const SUBJECT = 'job-dispatch-mongo';
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function bashExecutable() {
  if (process.env.BASH_EXECUTABLE) return process.env.BASH_EXECUTABLE;
  if (isWindows) {
    for (const candidate of [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('doc-harness-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };
const bash = (dir, script, args = []) => {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: dir, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const npm = (dir, args) => {
  const result = spawnSync('npm', args, { cwd: dir, encoding: 'utf8', shell: isWindows, env });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/**
 * Los scripts de `ageForReconciliation` que EMITE keel-nest para asset-vault, leídos de su flow.ts: medir una
 * copia escrita aquí comprobaría que mongosh sabe hacer un $set, no que el generador acierta.
 */
function emittedAging() {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'asset-vault'));
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'mongodb', broker: 'rabbitmq' } });
  const flow = files.find((file) => file.path.endsWith('support/flow.ts')).content;
  const table = flow.match(/const RECONCILIATION_AGING[^=]*= \{\n([\s\S]*?)\n\};/)?.[1];
  if (!table) throw new Error('asset-vault ya no emite ageForReconciliation');
  // Una entrada: 'activación': [['prefijo', 'sufijo']].
  const [, activation, prefix, suffix] = table.match(/'([^']+)': \[\['(.*)', '(.*)'\]\]/);
  return { activation, prefix: prefix.replace(/\\'/g, "'"), suffix: suffix.replace(/\\'/g, "'") };
}

const workspace = makeWorkspace('keel-nest-doc-harness-');
const specDir = mountDesign(workspace, SUBJECT);
const projectDir = path.join(workspace, 'services', `${SUBJECT}-nest`);
fs.mkdirSync(projectDir, { recursive: true });
writeStackConfig(projectDir, resolveStack({ database: 'mongodb' }, loadService(specDir).layers));
const generated = await runCommand(workspace, build, `specs/${SUBJECT}`, { defaults: true, acceptUnready: true });
if (!step('build genera el proyecto documental', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, 'package.json')), generated.exitCode ? generated.output.slice(-1200) : '')) {
  process.exit(1);
}
const install = npm(projectDir, ['install', '--no-audit', '--no-fund']);
if (!step('npm install', install.ok, install.ok ? '' : install.output.slice(-800))) process.exit(1);
const flows = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh en verde (las pruebas de flujo y su arnés compilan)', flows.status === 0, flows.output.slice(-600));

const aging = emittedAging();
const flowsDir = path.join(projectDir, 'test', 'integration');
fs.writeFileSync(
  path.join(flowsDir, 'probe-document.test.ts'),
  `import { inFlightWithoutClock, mongoEval, putInFlight, resetState, stallInFlight, useFlow } from './support/flow.js';
import { randomUUID } from 'node:crypto';

const jobs = 'db.getCollection("jobs")';
const count = (filter: string) => Number(mongoEval(\`\${jobs}.countDocuments(\${filter})\`).trim());
const field = (id: string, name: string) => mongoEval(\`\${jobs}.findOne({ _id: UUID("\${id}") }).\${name}\`).trim();
const seed = (id: string, status: string, clock: string) =>
  mongoEval(\`\${jobs}.insertOne({ _id: UUID("\${id}"), reference: "probe-\${id}", status: "\${status}", running_since: \${clock} }).acknowledged\`);

describe('FL-PROBE-101 · el arnés documental', () => {
  useFlow();
  it('FL-PROBE-101-A: mongoEval hace llegar las comillas y devuelve lo impreso', () => {
    expect(mongoEval('db.getCollection("keel_probe").insertOne({ a: "x \\'y\\'" }).acknowledged').trim()).toBe('true');
    expect(mongoEval('db.getCollection("keel_probe").countDocuments({ a: "x \\'y\\'" })').trim()).toBe('1');
  });
  it('FL-PROBE-101-B: resetState vacía los documentos y conserva los índices', () => {
    mongoEval('db.getCollection("keel_probe").createIndex({ a: 1 }, { name: "ix_keel_probe_a" })');
    resetState();
    expect(mongoEval('db.getCollection("keel_probe").countDocuments({})').trim()).toBe('0');
    expect(mongoEval('db.getCollection("keel_probe").getIndexes().map((ix) => ix.name).join(",")').trim()).toContain('ix_keel_probe_a');
    expect(mongoEval('db.getCollection("jobs").getIndexes().map((ix) => ix.name).join(",")').trim()).toContain('uk_jobs_natural');
  });
  it('FL-PROBE-101-C: stallInFlight deja el estado y el reloj rancio; putInFlight, el reloj a ahora', () => {
    const stalled = randomUUID();
    const current = randomUUID();
    seed(stalled, 'QUEUED', 'null');
    seed(current, 'QUEUED', 'null');
    stallInFlight('dispatchJobs', stalled);
    putInFlight('dispatchJobs', current);
    expect(field(stalled, 'status')).toBe('RUNNING');
    expect(field(stalled, 'running_since.getTime()')).toBe('0');
    expect(field(current, 'status')).toBe('RUNNING');
    expect(Date.now() - Number(field(current, 'running_since.getTime()'))).toBeLessThan(60_000);
  });
  it('FL-PROBE-101-D: inFlightWithoutClock discrimina: cero con reloj, uno sin él', () => {
    expect(inFlightWithoutClock('dispatchJobs')).toBe(0);
    seed(randomUUID(), 'RUNNING', 'null');
    seed(randomUUID(), 'QUEUED', 'null');
    expect(inFlightWithoutClock('dispatchJobs')).toBe(1);
    // Dentro del flujo el estado se acumula (el reset es por flujo): los dos de C y el de aquí.
    expect(count('{ status: "RUNNING" }')).toBe(3);
  });
  it('FL-PROBE-101-E: el script de ageForReconciliation (el que emite asset-vault) envejece solo su marca', () => {
    const id = randomUUID();
    mongoEval(\`db.getCollection("assets").insertOne({ _id: UUID("\${id}"), status: "SCANNING", last_scanned_at: new Date() }).acknowledged\`);
    mongoEval(${JSON.stringify(aging.prefix)} + id + ${JSON.stringify(aging.suffix)});
    expect(mongoEval(\`db.getCollection("assets").findOne({ _id: UUID("\${id}") }).last_scanned_at.getTime()\`).trim()).toBe('0');
    expect(mongoEval(\`db.getCollection("assets").findOne({ _id: UUID("\${id}") }).status\`).trim()).toBe('SCANNING');
  });
});
`
);
step(`ageForReconciliation de asset-vault emitido para '${aging.activation}'`, Boolean(aging.prefix && aging.suffix), aging.prefix);

const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1500))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh (MongoDB primario de su replica set)', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));
  const scored = bash(projectDir, 'infra/score-scenarios.sh');
  const has = (pattern) => pattern.test(scored.output);
  // El humo corre antes que los flujos: con SMOKE-3 (mongoEval) roto, score sale con 2 y nombra el arnés.
  // score sale con 2 cuando el arnés está roto (el humo falla y no corre ningún flujo): con mongoEval sin su
  // print(...), SMOKE-3 lo pone así (medido).
  step('el humo del arnés en verde (reset, servidor, la base responde a un script)', scored.status !== 2 && !has(/Humo del arnés[^\n]*\n[^\n]*(FALLO|KO)/), scored.status === 2 ? scored.output.slice(-1500) : '');
  step('score-scenarios.sh sale con 0 y la matriz limpia', scored.status === 0 && has(/RESULTADO: OK/), `código ${scored.status}`);
  for (const letter of ['A', 'B', 'C', 'D', 'E']) {
    const id = `FL-PROBE-101-${letter}`;
    step(`sonda ${id} en verde`, has(new RegExp(`OK\\s+${id}`)), has(new RegExp(`OK\\s+${id}`)) ? '' : (scored.output.match(new RegExp(`.*${id}.*`))?.[0] ?? scored.output.slice(-2500)));
  }
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-doc-harness-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true, filter: (source) => !source.includes('node_modules') });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\ndoc-harness-check: ${results.length}/${results.length} en verde.` : `\ndoc-harness-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
