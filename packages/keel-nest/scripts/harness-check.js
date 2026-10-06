#!/usr/bin/env node
// Ejercita el ARNÉS DE INTEGRACIÓN que emite keel-nest contra su infraestructura real.
//
// Por qué no está en `npm test`: necesita red (npm instala el proyecto), podman o docker, y tarda
// minutos. La suite del paquete compara el texto emitido y ejecuta el awk de la matriz contra un XML
// fabricado; esto es lo único que dice que la cadena entera funciona: que `infra/up.sh` levanta lo que
// el diseño pide, que `validate-infra.sh` lo ve listo, que el arnés arranca el servidor contra esa
// base, que `reset-db.sh` vacía los datos y RESPETA el historial de migraciones, que Vitest escribe el
// XML que `score-scenarios.sh` sabe leer, y que cada desenlace sale con su código y su evidencia.
//
//   node packages/keel-nest/scripts/harness-check.js [--keep]
//   npm run harness-check --workspace packages/keel-nest
//
// Las pruebas de flujo son SONDAS escritas aquí (los handlers del proyecto recién generado son TODOs):
// una que pasa, una que falla a propósito, una cuyo flujo no llega a arrancar y una que rompe la caja
// negra. Cada una afirma un desenlace distinto del script.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, NEST_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { resolveRuntime } from './lib/database-container.js';
import { loadService } from 'keel-core';
import { resolveStack, writeStackConfig } from 'keel-core/gen/stack';

const keep = process.argv.includes('--keep');
// El motor relacional: postgresql por defecto; --database=mysql pasa la misma batería por el otro.
const database = (process.argv.find((arg) => arg.startsWith('--database=')) ?? '--database=postgresql').split('=')[1];
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
  console.error('harness-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function npm(projectDir, args) {
  const result = spawnSync('npm', args, { cwd: projectDir, encoding: 'utf8', shell: isWindows, env });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const workspace = makeWorkspace('keel-nest-harness-check-');
const specDir = mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
// El stack se fija ANTES del build escribiendo su keel-stack.json: build lo respeta en vez de preguntar.
const preProjectDir = path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);
fs.mkdirSync(preProjectDir, { recursive: true });
writeStackConfig(preProjectDir, resolveStack({ database }, loadService(specDir).layers));
const generated = await runCommand(workspace, build, `specs/${NEST_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}
const install = npm(projectDir, ['install', '--no-audit', '--no-fund']);
if (!step('npm install', install.ok)) {
  console.error(install.output);
  process.exit(1);
}

const flowsDir = path.join(projectDir, 'test', 'integration');
const probe = (name, content) => fs.writeFileSync(path.join(flowsDir, `${name}.test.ts`), content);
const unprobe = (name) => fs.rmSync(path.join(flowsDir, `${name}.test.ts`), { force: true });

// ── La caja negra: una prueba de flujo que importa el servicio no pasa check:architecture ──
probe(
  'probe-import',
  `import { AppModule } from '../../src/app.module.js';
it('FL-PROBE-009-A: importa el servicio', () => expect(AppModule).toBeDefined());
`
);
const architecture = npm(projectDir, ['run', 'check:architecture']);
step(
  'una prueba de flujo que importa src/ rompe check:architecture (flujos-caja-negra)',
  !architecture.ok && architecture.output.includes('flujos-caja-negra'),
  architecture.ok ? 'salió en verde' : ''
);
unprobe('probe-import');
const clean = npm(projectDir, ['run', 'check:architecture']);
step('sin ella, check:architecture vuelve a verde', clean.ok, clean.ok ? '' : clean.output.slice(-800));

// ── La infraestructura, con sus propios scripts ──
const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  // Una que pasa, y que además mide el reset contra la base real: vacía los datos y respeta el
  // historial de migraciones (el placeholder {history} del catálogo, sustituido por la plataforma).
  probe(
    'probe-ok',
    `import { ROUTE_BASE, db, resetState, useFlow } from './support/flow.js';
describe('FL-PROBE-001 · sonda en verde', () => {
  const flow = useFlow();
  it('FL-PROBE-001-A: una ruta inexistente responde 404 con ErrorResponse', async () => {
    const response = await flow.get(\`\${ROUTE_BASE}/keel-probe\`);
    expect(response.status, response.body).toBe(404);
  });
  it('FL-PROBE-001-B: el reset vacía los datos y respeta el historial de migraciones', () => {
    db('CREATE TABLE IF NOT EXISTS keel_probe (id int)');
    db('INSERT INTO keel_probe VALUES (1)');
    db('CREATE TABLE IF NOT EXISTS typeorm_migrations (id int)');
    db('INSERT INTO typeorm_migrations VALUES (1)');
    resetState();
    expect(db('SELECT count(*) FROM keel_probe').trim()).toBe('0');
    expect(db('SELECT count(*) FROM typeorm_migrations').trim()).toBe('1');
    db('DROP TABLE typeorm_migrations');
    db('DROP TABLE keel_probe');
  });
});
`
  );
  // Una que falla a propósito: su evidencia tiene que llevar la petición y la respuesta.
  probe(
    'probe-fail',
    `import { ROUTE_BASE, useFlow } from './support/flow.js';
describe('FL-PROBE-002 · sonda en rojo', () => {
  const flow = useFlow();
  it('FL-PROBE-002-A: espera un 200 que no llega', async () => {
    const response = await flow.get(\`\${ROUTE_BASE}/keel-probe-rojo\`);
    expect(response.status).toBe(200);
  });
});
`
  );
  // Un flujo que no llega a arrancar: bajo production faltan variables obligatorias y la
  // configuración se niega. Vitest da sus casos por OMITIDOS; el arnés deja <flujo>-init.json.
  probe(
    'probe-init',
    `import { useFlow } from './support/flow.js';
describe('FL-PROBE-003 · sonda que no arranca', () => {
  const previous = process.env.PROFILE;
  beforeAll(() => {
    process.env.PROFILE = 'production';
  });
  afterAll(() => {
    process.env.PROFILE = previous;
  });
  useFlow();
  it('FL-PROBE-003-A: no llega a ejecutarse', () => {
    expect(true).toBe(true);
  });
});
`
  );

  // Un documento de escenarios con un flujo que ninguna prueba ejercita: tiene que salir NO_EJERC.
  // (No rompe el sello: specs.sha256 vigila los archivos que lista, y este no estaba.)
  fs.writeFileSync(
    path.join(projectDir, 'specs', 'validation-scenarios.md'),
    ['FL-PROBE-001', 'FL-PROBE-002', 'FL-PROBE-003', 'FL-PROBE-004'].map((id) => `#### ${id} — sonda\n`).join('\n')
  );

  const evidence = path.join(projectDir, 'build', 'keel-failures');
  const run1 = bash(projectDir, 'infra/score-scenarios.sh');
  const lines = run1.output;
  const has = (pattern) => pattern.test(lines);
  step('score: un escenario en verde sale OK', has(/OK\s+FL-PROBE-001-A/) && has(/OK\s+FL-PROBE-001-B/), has(/OK\s+FL-PROBE-001-B/) ? '' : lines.slice(-2500));
  step('score: el que falla sale FALLO con la ruta de su evidencia', has(/FALLO\s+FL-PROBE-002-A\s+probe-fail\s+build\/keel-failures\/FL-PROBE-002-A\.json/));
  step('score: el flujo que no arranca deja sus casos OMITIDOS', has(/OMITIDO\s+FL-PROBE-003-A/), has(/OMITIDO/) ? '' : 'sin fila OMITIDO');
  step('score: y lo nombra como arnés roto, con su causa', has(/ARNÉS/) && has(/probe-init\s+\(arranque del flujo\)/) && has(/DB_URL|obligatori/i));
  step('score: un flujo del documento sin prueba sale NO_EJERC', has(/NO_EJERC\s+FL-PROBE-004/) && !has(/NO_EJERC\s+FL-PROBE-00[123]/));
  step('score: con algo que arbitrar sale con 1', run1.status === 1, `código ${run1.status}`);
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(path.join(evidence, 'FL-PROBE-002-A.json'), 'utf8'));
  } catch {
    report = null;
  }
  step(
    'la evidencia del fallo lleva escenario, aserción, petición y respuesta',
    report?.scenario === 'FL-PROBE-002-A' &&
      report.testClass === 'probe-fail' &&
      /200/.test(report.assertion ?? '') &&
      report.request?.method === 'GET' &&
      report.request?.path?.endsWith('/keel-probe-rojo') &&
      report.response?.status === 404,
    report ? JSON.stringify(report).slice(0, 300) : 'no existe'
  );
  step('el flujo que no arranca deja probe-init-init.json', fs.existsSync(path.join(evidence, 'probe-init-init.json')));

  // Sin escenarios en FALLO, un flujo que no arranca es el arnés, no algo que arbitrar: sale con 2.
  unprobe('probe-fail');
  const run2 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: un flujo que no arranca y ningún FALLO sale con 2', run2.status === 2, `código ${run2.status}`);

  // Todo en verde: sin el documento de escenarios (ni su sello), la matriz limpia sale con 0.
  unprobe('probe-init');
  fs.rmSync(path.join(projectDir, 'specs.sha256'), { force: true });
  fs.rmSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), { force: true });
  const run3 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: todo en verde sale con 0', run3.status === 0 && /RESULTADO: OK/.test(run3.output), `código ${run3.status}`);

  // El baseline de migraciones: se exporta desde las entidades, se copia a src/migrations/ y se
  // verifica aplicándolo a un esquema vacío (lo que hace el arranque en develop y production).
  const exported = bash(projectDir, 'infra/export-schema.sh');
  const baselineSql = path.join(projectDir, 'build', 'schema', 'baseline.sql');
  const candidate = path.join(projectDir, 'build', 'schema', '1000000000000-baseline-schema.ts');
  step(
    'export-schema.sh escribe el DDL de las entidades y la migración candidata',
    exported.status === 0 && fs.existsSync(baselineSql) && /CREATE TABLE/i.test(fs.readFileSync(baselineSql, 'utf8')) && fs.existsSync(candidate),
    exported.status === 0 ? '' : exported.output.slice(-1500)
  );
  if (fs.existsSync(candidate)) {
    const migration = path.join(projectDir, 'src', 'migrations', '1000000000000-baseline-schema.ts');
    fs.copyFileSync(candidate, migration);
    const verified = bash(projectDir, 'infra/verify-baseline.sh');
    step('verify-baseline.sh: las migraciones crean exactamente el esquema de las entidades', verified.status === 0 && /baseline: OK/.test(verified.output), verified.status === 0 ? '' : verified.output.slice(-1500));
    // Falsado: un baseline al que le falta una sentencia (la última: un índice o una FK) no pasa.
    const original = fs.readFileSync(migration, 'utf8');
    const upCalls = [...original.matchAll(/^    await queryRunner.query(.*);$/gm)];
    const downStart = original.indexOf('async down(');
    const lastUp = upCalls.filter((m) => m.index < downStart).pop();
    fs.writeFileSync(migration, original.slice(0, lastUp.index) + original.slice(lastUp.index + lastUp[0].length + 1));
    const sabotaged = bash(projectDir, 'infra/verify-baseline.sh');
    step('verify-baseline.sh sale en rojo con un baseline al que le falta una sentencia', sabotaged.status === 1 && /baseline: KO/.test(sabotaged.output), `código ${sabotaged.status}`);
    fs.writeFileSync(migration, original);
    const develop = bash(projectDir, 'infra/verify-baseline.sh');
    step('restaurado, vuelve a verde (y la base queda con el esquema de las migraciones)', develop.status === 0);
  }

  // Un snapshot editado desde el proyecto no se puntúa.
  fs.writeFileSync(path.join(projectDir, 'specs.sha256'), `${'0'.repeat(64)}  specs/service.keel.yaml\n`);
  const run4 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: un specs/ que no casa con su sello sale con 2 sin ejecutar nada', run4.status === 2 && /DISEÑO/.test(run4.output), `código ${run4.status}`);
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-harness-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nharness-check: ${results.length}/${results.length} en verde.` : `\nharness-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
