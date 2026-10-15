#!/usr/bin/env node
// Ejercita el ARNÉS DE INTEGRACIÓN documental de keel-dotnet (incremento 12d) contra su infraestructura real: el gemelo
// de harness-check para MongoDB, y el doc-harness-check de keel-nest.
//
// Lo que solo la base real juzga, porque un script de mongosh roto no falla: devuelve cero o no modifica nada.
//   · que `MongoEval` haga llegar un script con comillas INTACTO (viaja por archivo) y que su salida se imprima (por
//     archivo mongosh no imprime la última expresión: vacío parecería un cero);
//   · que `ResetState()` (infra/reset-db.sh) vacíe los documentos y CONSERVE los índices;
//   · que `StallInFlight` deje el estado Y el reloj rancio, que `PutInFlight` deje un reloj DISTINTO (a ahora), y que
//     `InFlightWithoutClock` discrimine (cero con el reloj estampado, uno sin él);
//   · que `AgeForReconciliation` envejezca SOLO la marca de espera, con el script que emite un diseño que la tiene
//     (asset-vault, que build no genera entero —storage es del incremento 13—: se lee de lo que emite);
//   · la cadena entera: up.sh, validate-infra.sh, el humo del arnés (SMOKE-3 por MongoEval) y score-scenarios.sh;
//   · y lo que hace el agente de calidad: infra/export-indexes.sh exporta los índices vivos y cada uno es el del contrato
//     (keel-core/gen/document.js), sin que falte ni sobre ninguno. Falsable: --sabotage=index le quita un índice al
//     DocumentIndexes.cs emitido, y tiene que caer ESTA comprobación.
//
//   node packages/keel-dotnet/scripts/doc-harness-check.js [--keep] [--sabotage=index]
//   npm run doc-harness-check --workspace packages/keel-dotnet
//
// Necesita el SDK de .NET 10, podman o docker y red la primera vez (NuGet).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { resolveStack, writeStackConfig } from 'keel-core/gen/stack';
import { documentIndexes, INDEX_EXPORT_FILE } from 'keel-core/gen/document';
import { makeWorkspace, mountDesign, runCommand, planFixture } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.slice('--sabotage='.length) ?? null;
const SUBJECT = 'job-dispatch-mongo';
// Los sabotajes del arnés emitido, cada uno conservando la forma: [archivo de Support/, texto, sustituto].
//   print        MongoEval sin el print(...): por archivo, mongosh no devuelve nada (SMOKE-3 lo caza: score sale con 2)
//   put-clock    PutInFlight deja el reloj rancio, como StallInFlight (la sonda C lo caza)
//   missing      InFlightWithoutClock cuenta sobre otro campo (la sonda D lo caza)
const HARNESS_SABOTAGES = {
  print: ['Harness.cs', '"print((function () { return ("', '"((function () { return ("'],
  'put-clock': ['FlowTest.cs', 'running_since: new Date() } })', 'running_since: new Date(0) } })'],
  missing: ['FlowTest.cs', 'running_since: null })', 'reference: null })']
};
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
const env = { ...process.env, CONTAINER_RUNTIME: runtime, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
const bash = (dir, script, args = []) => {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: dir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const dotnet = (dir, args) => {
  const result = spawnSync('dotnet', args, { cwd: dir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/**
 * El script de `AgeForReconciliation` que EMITE keel-dotnet para asset-vault, leído de su FlowTest.cs: medir una copia
 * escrita aquí comprobaría que mongosh sabe hacer un $set, no que el generador acierta. Se devuelven los literales C# tal
 * cual, para pegarlos en la sonda.
 */
async function emittedAging() {
  const { files } = await planFixture('asset-vault');
  const flow = files.find((file) => file.path.endsWith('Support/FlowTest.cs')).content;
  const table = flow.match(/ReconciliationAging = new\(StringComparer\.Ordinal\)\s*\{([\s\S]*?)\};/)?.[1];
  if (!table) throw new Error('asset-vault ya no emite AgeForReconciliation');
  const entry = table.match(/\["([^"]+)"\] = \[\(("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\)\]/);
  if (!entry) throw new Error(`la tabla de AgeForReconciliation de asset-vault cambió de forma: ${table.trim().slice(0, 200)}`);
  return { activation: entry[1], prefix: entry[2], suffix: entry[3] };
}

const workspace = makeWorkspace('keel-dotnet-doc-harness-');
const specDir = mountDesign(workspace, SUBJECT);
const projectDir = path.join(workspace, 'services', `${SUBJECT}-dotnet`);
fs.mkdirSync(projectDir, { recursive: true });
writeStackConfig(projectDir, resolveStack({ database: 'mongodb' }, loadService(specDir).layers));
const generated = await runCommand(workspace, build, `specs/${SUBJECT}`, { defaults: true, acceptUnready: true });
if (!step('build genera el proyecto documental', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, 'global.json')), generated.exitCode ? generated.output.slice(-1200) : '')) {
  process.exit(1);
}
// El sabotaje: el índice de la clave natural fuera del DocumentIndexes.cs emitido (el servidor no lo crea).
const SABOTAGED_INDEX = 'uk_jobs_natural';
if (sabotage === 'index') {
  const file = path.join(projectDir, 'src', 'JobDispatchMongo.Infrastructure', 'Persistence', 'DocumentIndexes.cs');
  const source = fs.readFileSync(file, 'utf8');
  const line = source.split('\n').find((candidate) => candidate.includes(`"${SABOTAGED_INDEX}"`));
  if (!line) throw new Error(`DocumentIndexes.cs ya no declara ${SABOTAGED_INDEX} en una línea: el sabotaje no se aplica`);
  // La línea lleva una coma detrás si no es la última de su colección: se quita con ella, y la anterior pierde la suya.
  fs.writeFileSync(file, source.replace(`${line}\n`, '').replace(/\),(\s*\])/, ')$1'));
  console.log(`(sabotaje: ${SABOTAGED_INDEX} fuera de DocumentIndexes.cs)`);
} else if (sabotage && HARNESS_SABOTAGES[sabotage]) {
  const [suffix, from, to] = HARNESS_SABOTAGES[sabotage];
  const file = path.join(projectDir, 'tests', 'JobDispatchMongo.IntegrationTests', 'Support', suffix);
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(from)) throw new Error(`el sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?)`);
  fs.writeFileSync(file, source.replace(from, to));
  console.log(`(sabotaje: ${sabotage})`);
} else if (sabotage) {
  throw new Error(`sabotaje desconocido: ${sabotage}. Los hay: index, ${Object.keys(HARNESS_SABOTAGES).join(', ')}`);
}
const flows = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh en verde (las pruebas de flujo y su arnés compilan)', flows.status === 0, flows.output.slice(-600));

const aging = await emittedAging();
step(`AgeForReconciliation de asset-vault emitido para '${aging.activation}'`, Boolean(aging.prefix && aging.suffix), aging.prefix);
const flowsDir = path.join(projectDir, 'tests', 'JobDispatchMongo.IntegrationTests');
fs.writeFileSync(
  path.join(flowsDir, 'ProbeDocumentFlow.cs'),
  `namespace JobDispatchMongo.IntegrationTests;

using JobDispatchMongo.IntegrationTests.Support;
using Xunit;

public sealed class ProbeDocumentFlow : FlowTest
{
    private const string Jobs = "db.getCollection(\\"jobs\\")";

    private static long Count(string filter) => long.Parse(MongoEval($"{Jobs}.countDocuments({filter})").Trim(), System.Globalization.CultureInfo.InvariantCulture);

    private static string Field(string id, string name) => MongoEval($"{Jobs}.findOne({{ _id: UUID(\\"{id}\\") }}).{name}").Trim();

    private static void Seed(string id, string status, string clock) =>
        MongoEval($"{Jobs}.insertOne({{ _id: UUID(\\"{id}\\"), reference: \\"probe-{id}\\", status: \\"{status}\\", running_since: {clock} }}).acknowledged");

    [Scenario("FL-PROBE-101-A: MongoEval hace llegar las comillas y devuelve lo impreso")]
    public void LasComillasLlegan()
    {
        Assert.Equal("true", MongoEval("""db.getCollection("keel_probe").insertOne({ a: "x 'y'" }).acknowledged""").Trim());
        Assert.Equal("1", MongoEval("""db.getCollection("keel_probe").countDocuments({ a: "x 'y'" })""").Trim());
    }

    [Scenario("FL-PROBE-101-B: ResetState vacía los documentos y conserva los índices")]
    public void ElResetConservaLosIndices()
    {
        MongoEval("""db.getCollection("keel_probe").createIndex({ a: 1 }, { name: "ix_keel_probe_a" })""");
        ResetState();
        Assert.Equal("0", MongoEval("""db.getCollection("keel_probe").countDocuments({})""").Trim());
        Assert.Contains("ix_keel_probe_a", MongoEval("""db.getCollection("keel_probe").getIndexes().map((ix) => ix.name).join(",")""").Trim(), StringComparison.Ordinal);
        Assert.Contains("uk_jobs_natural", MongoEval("""db.getCollection("jobs").getIndexes().map((ix) => ix.name).join(",")""").Trim(), StringComparison.Ordinal);
    }

    [Scenario("FL-PROBE-101-C: StallInFlight deja el estado y el reloj rancio; PutInFlight, el reloj a ahora")]
    public void ElRescateFabricaSuPrecondicion()
    {
        var stalled = Guid.NewGuid().ToString();
        var current = Guid.NewGuid().ToString();
        Seed(stalled, "QUEUED", "null");
        Seed(current, "QUEUED", "null");
        StallInFlight("dispatchJobs", stalled);
        PutInFlight("dispatchJobs", current);
        Assert.Equal("RUNNING", Field(stalled, "status"));
        Assert.Equal("0", Field(stalled, "running_since.getTime()"));
        Assert.Equal("RUNNING", Field(current, "status"));
        var clock = long.Parse(Field(current, "running_since.getTime()"), System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - clock < 60_000, $"reloj {clock}");
    }

    [Scenario("FL-PROBE-101-D: InFlightWithoutClock discrimina: cero con reloj, uno sin él")]
    public void LaCuentaSinRelojDiscrimina()
    {
        Assert.Equal(0, InFlightWithoutClock("dispatchJobs"));
        Seed(Guid.NewGuid().ToString(), "RUNNING", "null");
        Seed(Guid.NewGuid().ToString(), "QUEUED", "null");
        Assert.Equal(1, InFlightWithoutClock("dispatchJobs"));
        // Dentro del flujo el estado se acumula (el reset es por flujo): los dos de C y el de aquí.
        Assert.Equal(3, Count("""{ status: "RUNNING" }"""));
    }

    [Scenario("FL-PROBE-101-E: el script de AgeForReconciliation (el que emite asset-vault) envejece solo su marca")]
    public void LaReconciliacionEnvejeceSoloSuMarca()
    {
        var id = Guid.NewGuid().ToString();
        MongoEval($"db.getCollection(\\"assets\\").insertOne({{ _id: UUID(\\"{id}\\"), status: \\"SCANNING\\", last_scanned_at: new Date() }}).acknowledged");
        MongoEval(${aging.prefix} + id + ${aging.suffix});
        Assert.Equal("0", MongoEval($"db.getCollection(\\"assets\\").findOne({{ _id: UUID(\\"{id}\\") }}).last_scanned_at.getTime()").Trim());
        Assert.Equal("SCANNING", MongoEval($"db.getCollection(\\"assets\\").findOne({{ _id: UUID(\\"{id}\\") }}).status").Trim());
    }
}
`
);
// Los FL-* de la sonda, en el documento de escenarios (y fuera del sello): si no, saldrían AJENO y no puntuarían.
fs.writeFileSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), '#### FL-PROBE-101 — el arnés documental\n');
const seal = path.join(projectDir, 'specs.sha256');
if (fs.existsSync(seal)) {
  fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md')).join('\n'));
}
const probeFlows = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh en verde con el flujo sonda (los ayudantes que usa existen)', probeFlows.status === 0, probeFlows.output.slice(-1200));

const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1500))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh (MongoDB primario de su replica set)', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));
  const scored = bash(projectDir, 'infra/score-scenarios.sh');
  const has = (pattern) => pattern.test(scored.output);
  // El humo corre antes que los flujos: con SMOKE-3 (MongoEval) roto, score sale con 2 y nombra el arnés.
  step('el humo del arnés en verde (reset, servidor, la base responde a un script)', scored.status !== 2, scored.status === 2 ? scored.output.slice(-2500) : '');
  step('score-scenarios.sh sale con 0 y la matriz limpia', scored.status === 0 && has(/RESULTADO: OK/), `código ${scored.status}`);
  for (const letter of ['A', 'B', 'C', 'D', 'E']) {
    const id = `FL-PROBE-101-${letter}`;
    step(`sonda ${id} en verde`, has(new RegExp(`OK\\s+${id}`)), has(new RegExp(`OK\\s+${id}`)) ? '' : (scored.output.match(new RegExp(`.*${id}.*`))?.[0] ?? scored.output.slice(-2500)));
  }
  await indexSteps();
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

/**
 * Lo que hace el agente de calidad sobre documentos: export-indexes.sh contra los índices del contrato. Los flujos ya
 * arrancaron el servidor (que crea los índices al arrancar), así que lo vivo es lo que crea lo emitido.
 */
async function indexSteps() {
  const exported = bash(projectDir, 'infra/export-indexes.sh');
  if (!step('bash infra/export-indexes.sh', exported.status === 0, exported.status === 0 ? '' : exported.output.slice(-800))) return;
  const live = JSON.parse(fs.readFileSync(path.join(projectDir, INDEX_EXPORT_FILE), 'utf8'));
  const { manifest, layers } = loadService(specDir);
  const { model } = planService({ manifest, layers, workspace, stack: { database: 'mongodb' } });
  const contract = documentIndexes(model, []);
  const missing = [];
  const different = [];
  for (const { collection, specs } of contract) {
    const byName = new Map((live[collection] ?? []).map((index) => [index.name, index]));
    for (const spec of specs) {
      const got = byName.get(spec.name);
      if (!got) {
        missing.push(`${collection}.${spec.name}`);
        continue;
      }
      const filter = spec.partialFilter ? { [spec.partialFilter.path]: spec.partialFilter.equals } : undefined;
      if (JSON.stringify(Object.keys(got.key)) !== JSON.stringify(spec.paths) || got.unique !== spec.unique || JSON.stringify(got.partialFilterExpression) !== JSON.stringify(filter)) {
        different.push(`${collection}.${spec.name}: ${JSON.stringify(got)}`);
      }
    }
  }
  // Lo que sobra: un índice vivo que no sale del contrato (salvo el _id de MongoDB y la colección de la sonda).
  const declared = new Set(contract.flatMap(({ collection, specs }) => specs.map((spec) => `${collection}.${spec.name}`)));
  const extra = Object.entries(live)
    .filter(([collection]) => collection !== 'keel_probe')
    .flatMap(([collection, indexes]) => indexes.map((index) => `${collection}.${index.name}`))
    .filter((id) => !id.endsWith('._id_') && !declared.has(id));
  step(`export-indexes.sh: están los ${declared.size} índices del contrato`, missing.length === 0, missing.join(', '));
  step('export-indexes.sh: cada índice vivo tiene las claves, la unicidad y el filtro del contrato', different.length === 0, different.join(' | '));
  step('export-indexes.sh: no sobra ningún índice', extra.length === 0, extra.join(', '));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-doc-harness-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\ndoc-harness-check: ${results.length}/${results.length} en verde.` : `\ndoc-harness-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
