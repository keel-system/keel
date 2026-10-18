// Los dos gates de prohibición de keel-dotnet (incremento 14e), EJECUTADOS con bash sobre árboles generados:
//   · nacen VERDES sobre lo que build escribe, en todas las fixtures (si no, el agente aprendería a ignorarlos);
//   · cada regla se pone ROJA con su forma prohibida, nombrando su id y el archivo, y se queda VERDE con la forma que la
//     convención enseña (un gate que veta lo correcto tiene como salida romper el código para callarlo);
//   · un comentario no cuenta, y un awk que no corre no da verde: sale sin veredicto.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { sourceGate } from 'keel-core/gen/source-gate';
import { CS_SOURCE, LOGGING_RULES } from '../src/scaffold/logging-check.js';
import { TAG_RULES, allowedTagKeys } from '../src/scaffold/telemetry-gate.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR, fixtureNames } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const GATES = ['infra/check-logging.sh', 'infra/check-telemetry.sh'];

function stackFor(layers) {
  return {
    database: layers.persistence?.model === 'document' ? 'mongodb' : 'postgresql',
    ...(layers.messaging ? { broker: 'rabbitmq' } : {}),
    ...(layers.payments ? { paymentGateway: 'stripe' } : {}),
    telemetry: 'otel'
  };
}

function materialize(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const dir = tmpDir(`keel-dotnet-gates-${name}-`);
  for (const file of planService({ manifest, layers, workspace: FIXTURES_DIR, stack: stackFor(layers) }).files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  return dir;
}

function run(dir, script) {
  const result = spawnSync('bash', [script], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('los dos gates nacen verdes sobre el árbol recién generado de toda fixture', () => {
  for (const name of fixtureNames()) {
    const dir = materialize(name);
    for (const script of GATES.filter((gate) => fs.existsSync(path.join(dir, gate)))) {
      const { status, output } = run(dir, script);
      assert.equal(status, 0, `${name} ${script}\n${output}`);
      assert.match(output, / OK$/m, `${name} ${script}`);
    }
  }
});

const base = materialize('catalog-extended');
const project = fs.readdirSync(path.join(base, 'src')).find((entry) => entry.endsWith('.Infrastructure')).replace(/\.Infrastructure$/, '');

/** Escribe `code` en un archivo del agente, ejecuta el gate y deshace el cambio. */
function withAgentCode(file, code, script) {
  const target = path.join(base, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `namespace Agent;\n\npublic static class AgentCode\n{\n    public static async Task Run()\n    {\n        ${code}\n    }\n}\n`);
  try {
    return run(base, script);
  } finally {
    fs.rmSync(target);
  }
}

for (const rule of LOGGING_RULES) {
  // Cada regla en un archivo donde aplica: errorLevel solo mira Domain y Application.
  const file = rule.paths ? `src/${project}.Application/UseCases/AgentCode.cs` : `src/${project}.Infrastructure/AgentCode.cs`;
  test(`check-logging.sh: «${rule.id}» sale rojo con la forma prohibida y verde con la correcta`, () => {
    const red = withAgentCode(file, rule.sample, GATES[0]);
    assert.equal(red.status, 1, red.output);
    assert.match(red.output, new RegExp(`\\[${rule.id}\\] ${file.replaceAll('/', '\\/').replaceAll('.', '\\.')}`));
    const green = withAgentCode(file, rule.allowed, GATES[0]);
    assert.equal(green.status, 0, green.output);
  });
}

test('check-logging.sh: el ERROR fuera de Domain y Application no cuenta (la frontera lo registra)', () => {
  const rule = LOGGING_RULES.find((candidate) => candidate.id === 'errorLevel');
  const { status, output } = withAgentCode(`src/${project}.Infrastructure/AgentCode.cs`, rule.sample, GATES[0]);
  assert.equal(status, 0, output);
});

test('check-logging.sh: una forma prohibida dentro de un comentario no cuenta (las notas de build la explican)', () => {
  const code = '// no hagas Console.WriteLine(command);\n        /* ni logger.LogInformation($"{id}");\n           en varias líneas */ var url = "http://x/y"; // y una URL no es un comentario';
  const { status, output } = withAgentCode(`src/${project}.Infrastructure/AgentCode.cs`, code, GATES[0]);
  assert.equal(status, 0, output);
  const after = withAgentCode(`src/${project}.Infrastructure/AgentCode.cs`, '/* cierra */ Console.WriteLine("x");', GATES[0]);
  assert.equal(after.status, 1, 'lo que sigue al cierre de un comentario de bloque sí cuenta');
});

for (const rule of TAG_RULES) {
  test(`check-telemetry.sh: «${rule.id}» sale rojo con una etiqueta fuera del vocabulario, y verde con la del vocabulario`, () => {
    const file = `src/${project}.Infrastructure/AgentMetrics.cs`;
    const red = withAgentCode(file, rule.sample, GATES[1]);
    assert.equal(red.status, 1, red.output);
    assert.match(red.output, new RegExp(`\\[${rule.id}\\] src\\/${project}\\.Infrastructure\\/AgentMetrics\\.cs`));
    const green = withAgentCode(file, rule.allowed, GATES[1]);
    assert.equal(green.status, 0, green.output);
  });
}

test('la correlación es atributo del span y nunca etiqueta de métrica', () => {
  assert.ok(!allowedTagKeys().some((key) => /correlation/i.test(key)));
  const red = withAgentCode(
    `src/${project}.Infrastructure/AgentMetrics.cs`,
    'var options = new ObserveOptions { Labels = new Dictionary<string, string> { [TelemetryAttributes.CorrelationId] = id } };',
    GATES[1]
  );
  assert.equal(red.status, 1, red.output);
  assert.match(red.output, /<- TelemetryAttributes\.CorrelationId/);
});

test('un awk que no corre no da verde: el gate sale sin veredicto', () => {
  const broken = sourceGate({ title: 'X', label: 'x', rules: [{ id: 'roto', pattern: '(', why: 'y' }], footer: 'z', platform: CS_SOURCE });
  const script = path.join(base, 'infra', 'broken-gate.sh');
  fs.writeFileSync(script, `#!/usr/bin/env bash\nset -u\n${broken}\n`);
  try {
    const { status, output } = run(base, 'infra/broken-gate.sh');
    assert.equal(status, 2, output);
    assert.match(output, /sin veredicto/);
  } finally {
    fs.rmSync(script);
  }
});

test('el motor rechaza una regla con barra invertida o comilla simple (viajan dentro de una cadena de awk)', () => {
  assert.throws(() => sourceGate({ title: 'X', label: 'x', rules: [{ id: 'a', pattern: 'a\\.b', why: 'y' }], footer: 'z', platform: CS_SOURCE }), /barra invertida/);
  assert.throws(() => sourceGate({ title: 'X', label: 'x', rules: [{ id: 'a', pattern: "a'b", why: 'y' }], footer: 'z', platform: CS_SOURCE }), /comilla simple/);
});

test('sin telemetría no hay gate de cardinalidad; el de logs, siempre que haya casos de uso', () => {
  const files = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  const byPath = new Map(files.map((file) => [file.path, file]));
  assert.ok(byPath.has('infra/check-logging.sh'));
  assert.ok(byPath.get('infra/check-logging.sh').executable);
  assert.ok(!byPath.has('infra/check-telemetry.sh'));
});
