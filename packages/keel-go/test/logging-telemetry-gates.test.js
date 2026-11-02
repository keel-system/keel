// Los dos gates de prohibición de keel-go (incremento 14e), EJECUTADOS con bash sobre árboles generados:
//   · nacen VERDES sobre lo que build escribe, en todas las fixtures (si no, el agente aprendería a ignorarlos);
//   · cada regla se pone ROJA con su forma prohibida, nombrando su id y el archivo, y se queda VERDE con la forma que la
//     convención enseña (un gate que veta lo correcto tiene como salida romper el código para callarlo);
//   · un comentario y una prueba no cuentan.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { LOGGING_RULES } from '../src/scaffold/logging-check.js';
import { CONSUME_RULE, TAG_RULES } from '../src/scaffold/telemetry-gate.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const GATES = ['infra/check-logging.sh', 'infra/check-telemetry.sh'];
const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

function materialize(name, stack = { telemetry: 'otel' }) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const dir = tmpDir(`keel-go-gates-${name}-`);
  const broker = layers.messaging ? { broker: 'rabbitmq' } : {};
  for (const file of planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { ...broker, ...stack } }).files) {
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
  for (const name of fixtures) {
    const dir = materialize(name);
    for (const script of GATES.filter((gate) => fs.existsSync(path.join(dir, gate)))) {
      const { status, output } = run(dir, script);
      assert.equal(status, 0, `${name} ${script}\n${output}`);
      assert.match(output, / OK$/m, `${name} ${script}`);
    }
  }
});

test('los gates nacen verdes con cada broker', () => {
  for (const broker of ['kafka', 'snssqs']) {
    const dir = materialize('stock-reservation-events', { telemetry: 'otel', broker });
    for (const script of GATES) assert.equal(run(dir, script).status, 0, `${broker} ${script}`);
  }
});

test('sin telemetría no hay gate de cardinalidad, y el de logs sigue', () => {
  const dir = materialize('product-catalog', {});
  assert.ok(!fs.existsSync(path.join(dir, GATES[1])));
  assert.equal(run(dir, GATES[0]).status, 0);
});

const base = materialize('catalog-extended');

/** Escribe `code` en un archivo del agente, ejecuta el gate y deshace el cambio. */
function withAgentCode(file, code, script) {
  const target = path.join(base, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `package agent\n\nfunc run() {\n\t${code}\n}\n`);
  try {
    return run(base, script);
  } finally {
    fs.rmSync(target);
  }
}

for (const rule of LOGGING_RULES) {
  // Cada regla en un archivo donde aplica: errorLevel solo mira el dominio y la aplicación.
  const file = rule.paths ? 'internal/application/agent_code.go' : 'internal/infrastructure/agent/agent_code.go';
  test(`check-logging.sh: «${rule.id}» sale rojo con la forma prohibida y verde con la correcta`, () => {
    const red = withAgentCode(file, rule.sample, GATES[0]);
    assert.equal(red.status, 1, red.output);
    assert.match(red.output, new RegExp(`\\[${rule.id}\\] \\./${file.replaceAll('/', '\\/').replaceAll('.', '\\.')}`));
    const green = withAgentCode(file, rule.allowed, GATES[0]);
    assert.equal(green.status, 0, green.output);
  });
}

for (const rule of [...TAG_RULES, CONSUME_RULE]) {
  const file = 'cmd/server/agent_code.go';
  test(`check-telemetry.sh: «${rule.id}» sale rojo con la forma prohibida y verde con la correcta`, () => {
    const red = withAgentCode(file, rule.sample, GATES[1]);
    assert.equal(red.status, 1, red.output);
    assert.match(red.output, new RegExp(`\\[${rule.id}\\] \\./cmd/server/agent_code\\.go`));
    const green = withAgentCode(file, rule.allowed, GATES[1]);
    assert.equal(green.status, 0, green.output);
  });
}

test('el ERROR fuera del dominio y de la aplicación no cuenta: el borde es quien lo registra', () => {
  const rule = LOGGING_RULES.find((candidate) => candidate.id === 'errorLevel');
  assert.equal(withAgentCode('internal/infrastructure/agent/agent_code.go', rule.sample, GATES[0]).status, 0);
});

test('la correlación nunca es etiqueta de métrica', () => {
  const { status, output } = withAgentCode('cmd/server/agent_code.go', 'orders.With(prometheus.Labels{"keel.correlation_id": id}).Inc()', GATES[1]);
  assert.equal(status, 1, output);
  assert.match(output, /keel\.correlation_id/);
});

test('un comentario y una prueba no cuentan', () => {
  const rule = LOGGING_RULES.find((candidate) => candidate.id === 'console');
  assert.equal(withAgentCode('internal/infrastructure/agent/agent_code.go', `// ${rule.sample}`, GATES[0]).status, 0);
  assert.equal(withAgentCode('internal/infrastructure/agent/agent_code_test.go', rule.sample, GATES[0]).status, 0);
});
