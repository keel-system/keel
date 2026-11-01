#!/usr/bin/env node
// Ejercita el ARNÉS DOCUMENTAL que emite keel-go (incremento 12) contra su infraestructura real, sobre job-dispatch-mongo:
// `infra/up.sh` levanta el MongoDB en replica set, `validate-infra.sh` lo ve listo, el humo pasa (el SMOKE-3 documental:
// la base responde a un script), y un flujo sonda usa los ayudantes emitidos —MongoEval con sus comillas y su print, el
// reset que vacía los documentos y CONSERVA los índices, el rescate (StallInFlight, PutInFlight, InFlightWithoutClock)—,
// puntuado por `score-scenarios.sh`. Después, `infra/export-indexes.sh` tiene que dar los índices del contrato
// (keel-core/gen/document.js): ni falta ni sobra ninguno, con sus claves, su unicidad y su filtro.
//
//   node packages/keel-go/scripts/doc-harness-check.js [--keep] [--sabotage=<id>]
//   npm run doc-harness-check --workspace packages/keel-go
//
// --sabotage=<id> rompe UNA pieza de lo emitido conservando su forma: verde = caen en rojo EXACTAMENTE sus pasos. Es el
// gemelo del doc-harness-check de keel-dotnet y keel-nest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { indexEntries } from '../src/scaffold/document-persistence.js';

const SUBJECT = 'job-dispatch-mongo';
const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const results = [];

const SABOTAGES = {
  // Sin el print, por archivo mongosh no devuelve nada: el humo lo ve y el script sale con 2 (arnés roto).
  print: {
    file: 'tests/integration/harness_test.go',
    from: '"print((function () { return ("',
    to: '"(function () { return ("',
    // Sin humo no se ejecuta la suite: caen también los pasos que esperan sus escenarios.
    expect: ['score: el flujo sonda documental sale OK', 'score: el humo documental', 'PutInFlight', 'InFlightWithoutClock']
  },
  // PutInFlight con el reloj rancio: la sonda que distingue «recién en vuelo» de «abandonado» lo ve.
  put: {
    file: 'tests/integration/flow_test.go',
    from: 'running_since: new Date() } })',
    to: 'running_since: new Date(0) } })',
    expect: ['score: el flujo sonda documental sale OK', 'PutInFlight']
  },
  // El recuento sin reloj sobre OTRO campo: deja de discriminar.
  missing: {
    file: 'tests/integration/flow_test.go',
    from: 'countDocuments({ status: \\"RUNNING\\", running_since: null })',
    to: 'countDocuments({ status: \\"RUNNING\\", keel_otro_campo: null })',
    expect: ['score: el flujo sonda documental sale OK', 'InFlightWithoutClock']
  },
  // Un índice que no sale del contrato: la verificación de los vivos lo ve.
  index: {
    file: 'internal/infrastructure/mongo/indexes.go',
    from: '\t"jobs": {\n',
    to: '\t"jobs": {\n\t\t{Keys: bson.D{{Key: "title", Value: 1}}, Options: options.Index().SetName("ix_jobs_fuera_del_contrato")},\n',
    expect: ['export-indexes.sh da los índices del contrato']
  }
};
const sabotageId = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const sabotage = sabotageId ? SABOTAGES[sabotageId] : null;
if (sabotageId && !sabotage) {
  console.error(`Sabotaje desconocido: ${sabotageId}. Los que hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

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
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: dir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const go = (dir, args) => {
  const result = spawnSync('go', args, { cwd: dir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const workspace = makeWorkspace('keel-go-doc-harness-');
mountDesign(workspace, SUBJECT);
const projectDir = path.join(workspace, 'services', `${SUBJECT}-go`);
const generated = await runCommand(workspace, build, `specs/${SUBJECT}`, { defaults: true, acceptUnready: true });
if (!step('build genera el proyecto documental', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, 'internal/infrastructure/mongo/indexes.go')), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}
if (sabotage) {
  const target = path.join(projectDir, sabotage.file);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(sabotage.from)) {
    console.error(`El sabotaje ${sabotageId} no se aplica a lo emitido hoy: ${sabotage.file} ya no contiene lo que busca.`);
    process.exit(2);
  }
  fs.writeFileSync(target, text.replace(sabotage.from, sabotage.to));
  console.log(`(sabotaje: ${sabotageId})`);
}
const tidy = go(projectDir, ['mod', 'tidy']);
if (!step('go mod tidy', tidy.ok, tidy.ok ? '' : tidy.output.slice(-1200))) process.exit(1);
const flows = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh en verde sobre el proyecto recién generado', flows.status === 0, flows.output.slice(-400));

const flowsDir = path.join(projectDir, 'tests', 'integration');
// Las rutas únicas de jobs, con el id: dos documentos sin la clave natural chocarían en su índice único (dos null).
const { model: subjectModel } = planService({ ...loadService(path.join(projectDir, 'specs')), workspace });
const uniquePaths = indexEntries(subjectModel)
  .find((entry) => entry.collection === 'jobs')
  .specs.filter((spec) => spec.unique)
  .flatMap((spec) => spec.paths);
const uniqueFields = uniquePaths.map((key) => `, ${key}: "\` + id + \`"`).join('');
// El flujo sonda: ayudantes emitidos contra la base real. Los documentos se insertan con MongoEval: los handlers del
// proyecto recién generado devuelven ErrNotImplemented.
fs.writeFileSync(
  path.join(flowsDir, 'probe_document_flow_test.go'),
  `//go:build integration

package integration

import (
	"strings"
	"testing"
)

// insertJob inserta un documento de jobs con su _id binario y lo devuelve.
func insertJob(s *Scenario, id, status, extra string) {
	s.Helper()
	s.MongoEval(\`db.getCollection("jobs").insertOne({ _id: UUID("\` + id + \`"), status: "\` + status + \`", title: "sonda"${uniqueFields}\` + extra + \` })\`)
}

func TestProbeDocument(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-PROBE-001-A: MongoEval conserva las comillas y devuelve el valor impreso", func(s *Scenario) {
		if got := strings.TrimSpace(s.MongoEval(\`"comillas \\"dobles\\" y 'simples'"\`)); got != \`comillas "dobles" y 'simples'\` {
			s.Errorf("MongoEval = %q", got)
		}
	})
	f.Scenario("FL-PROBE-001-B: el reset vacía los documentos y conserva los índices", func(s *Scenario) {
		insertJob(s, "0192f000-0000-7000-8000-000000000001", "QUEUED", "")
		s.ResetState()
		if got := strings.TrimSpace(s.MongoEval(\`db.getCollection("jobs").countDocuments({})\`)); got != "0" {
			s.Errorf("tras el reset quedan %s documentos", got)
		}
		if got := strings.TrimSpace(s.MongoEval(\`db.getCollection("jobs").getIndexes().length > 1\`)); got != "true" {
			s.Errorf("el reset se llevó los índices: %s", got)
		}
	})
	f.Scenario("FL-PROBE-001-C: StallInFlight deja el documento en vuelo con el reloj de la época", func(s *Scenario) {
		insertJob(s, "0192f000-0000-7000-8000-000000000002", "QUEUED", "")
		s.StallInFlight("dispatchJobs", "0192f000-0000-7000-8000-000000000002")
		got := strings.TrimSpace(s.MongoEval(\`(function () { const d = db.getCollection("jobs").findOne({ _id: UUID("0192f000-0000-7000-8000-000000000002") }); return d.status + "|" + d.running_since.getTime(); })()\`))
		if got != "RUNNING|0" {
			s.Errorf("StallInFlight dejó %q", got)
		}
	})
	f.Scenario("FL-PROBE-001-D: PutInFlight deja el reloj a ahora", func(s *Scenario) {
		insertJob(s, "0192f000-0000-7000-8000-000000000003", "QUEUED", "")
		s.PutInFlight("dispatchJobs", "0192f000-0000-7000-8000-000000000003")
		got := strings.TrimSpace(s.MongoEval(\`Date.now() - db.getCollection("jobs").findOne({ _id: UUID("0192f000-0000-7000-8000-000000000003") }).running_since.getTime() < 60000\`))
		if got != "true" {
			s.Errorf("PutInFlight no puso el reloj a ahora: %q", got)
		}
	})
	f.Scenario("FL-PROBE-001-E: InFlightWithoutClock cuenta lo que está en vuelo sin reloj, y solo eso", func(s *Scenario) {
		before := s.InFlightWithoutClock("dispatchJobs")
		insertJob(s, "0192f000-0000-7000-8000-000000000004", "RUNNING", "")
		insertJob(s, "0192f000-0000-7000-8000-000000000005", "RUNNING", ", running_since: new Date()")
		if after := s.InFlightWithoutClock("dispatchJobs"); after != before+1 {
			s.Errorf("InFlightWithoutClock pasó de %d a %d; quiero +1", before, after)
		}
	})
}
`
);
fs.writeFileSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), '#### FL-PROBE-001 — sonda documental\n');
const seal = path.join(projectDir, 'specs.sha256');
if (fs.existsSync(seal)) fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md')).join('\n'));

const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh (el replica set)', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));
  const score = bash(projectDir, 'infra/score-scenarios.sh');
  const has = (pattern) => pattern.test(score.output);
  step('score: el humo documental (SMOKE-3) pasa', !has(/FALLO\s+SMOKE-3/) && score.status !== 2, `código ${score.status}`);
  step('score: el flujo sonda documental sale OK', score.status === 0 && ['A', 'B', 'C', 'D', 'E'].every((c) => has(new RegExp(`OK\\s+FL-PROBE-001-${c}`))), `código ${score.status}: ${score.output.slice(-1500)}`);
  step('PutInFlight deja el reloj a ahora', has(/OK\s+FL-PROBE-001-D/));
  step('InFlightWithoutClock discrimina', has(/OK\s+FL-PROBE-001-E/));

  // Los índices vivos (el servidor de la suite los creó al arrancar) contra los del contrato.
  const exported = bash(projectDir, 'infra/export-indexes.sh');
  let differences = [];
  if (exported.status !== 0) differences = [`export-indexes.sh salió con ${exported.status}: ${exported.output.slice(-400)}`];
  else {
    const live = JSON.parse(fs.readFileSync(path.join(projectDir, 'build', 'schema', 'indexes.json'), 'utf8'));
    const { model } = planService({ ...loadService(path.join(projectDir, 'specs')), workspace });
    for (const { collection, specs } of indexEntries(model)) {
      const found = (live[collection] ?? []).filter((index) => index.name !== '_id_');
      for (const spec of specs) {
        const index = found.find((candidate) => candidate.name === spec.name);
        if (!index) differences.push(`${collection}: falta ${spec.name}`);
        else if (Object.keys(index.key).join() !== spec.paths.join() || index.unique !== Boolean(spec.unique)) differences.push(`${collection}.${spec.name}: ${JSON.stringify(index)}`);
        else if (JSON.stringify(index.partialFilterExpression ?? null) !== JSON.stringify(spec.partialFilter ? { [spec.partialFilter.path]: spec.partialFilter.equals } : null)) differences.push(`${collection}.${spec.name}: filtro ${JSON.stringify(index.partialFilterExpression)}`);
      }
      for (const index of found) if (!specs.some((spec) => spec.name === index.name)) differences.push(`${collection}: sobra ${index.name}`);
    }
  }
  step('export-indexes.sh da los índices del contrato', differences.length === 0, differences.slice(0, 6).join(' | '));
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-go-doc-harness-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
if (sabotage) {
  const red = results.filter((result) => !result.ok).map((result) => result.name);
  const expected = (name) => sabotage.expect.some((prefix) => name.startsWith(prefix));
  const missing = sabotage.expect.filter((prefix) => !red.some((name) => name.startsWith(prefix)));
  const extra = red.filter((name) => !expected(name));
  const caught = missing.length === 0 && extra.length === 0;
  console.log(
    caught
      ? `\ndoc-harness-check --sabotage=${sabotageId}: falsado, en rojo exactamente ${red.length} paso(s).`
      : `\ndoc-harness-check --sabotage=${sabotageId}: NO falsado.${missing.length ? ` Siguen en verde: ${missing.join(' | ')}.` : ''}${extra.length ? ` En rojo de más: ${extra.join(' | ')}.` : ''}`
  );
  process.exit(caught ? 0 : 1);
}
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ndoc-harness-check: ${results.length}/${results.length} en verde.` : `\ndoc-harness-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
