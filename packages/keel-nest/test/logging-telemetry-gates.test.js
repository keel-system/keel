// Los dos gates de prohibición de keel-nest (incremento 14e), EJECUTADOS con bash sobre árboles generados:
//   · nacen VERDES sobre lo que build escribe (si no, el agente aprendería a ignorarlos);
//   · cada regla se pone ROJA con su forma prohibida, nombrando su id y el archivo, y se queda VERDE con la forma que
//     la convención enseña (un gate que veta lo correcto tiene como salida romper el código para callarlo).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOGGING_RULES, CLI_FILES } from '../src/scaffold/logging-check.js';
import { allowedTagKeys } from '../src/scaffold/telemetry-gate.js';
import { planFixture } from './helpers/emitted.js';
import { tmpDir } from './helpers/tmp.js';

const SUBJECTS = [
  ['product-catalog', { telemetry: 'otel' }],
  ['catalog-extended', { database: 'postgresql', broker: 'kafka', telemetry: 'otel', cache: 'redis', storage: 'minio' }],
  ['asset-vault', { broker: 'snssqs', telemetry: 'otel', cache: 'redis', storage: 'minio' }],
  ['notification-mailer', { database: 'mysql', broker: 'rabbitmq', telemetry: 'otel' }],
  ['payment-checkout', { database: 'postgresql', broker: 'rabbitmq', paymentGateway: 'stripe', telemetry: 'otel' }]
];

function materialize(name, stack) {
  const dir = tmpDir(`keel-nest-gates-${name}-`);
  for (const file of planFixture(name, { stack }).files) {
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

for (const [name, stack] of SUBJECTS) {
  test(`${name}: los dos gates nacen verdes sobre el árbol recién generado`, () => {
    const dir = materialize(name, stack);
    for (const script of ['infra/check-logging.sh', 'infra/check-telemetry.sh']) {
      const { status, output } = run(dir, script);
      assert.equal(status, 0, `${script}\n${output}`);
      assert.match(output, / OK$/m);
    }
  });
}

const base = materialize('catalog-extended', SUBJECTS[1][1]);

/** Escribe `code` en un archivo del agente, ejecuta el gate y deshace el cambio. */
function withAgentCode(file, code, script) {
  const target = path.join(base, file);
  const existed = fs.existsSync(target);
  const original = existed ? fs.readFileSync(target, 'utf8') : null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${original ?? ''}\nexport function agentCode(command: any, id: string, port: any, a: any, b: any) {\n  ${code}\n}\n`);
  try {
    return run(base, script);
  } finally {
    if (existed) fs.writeFileSync(target, original);
    else fs.rmSync(target);
  }
}

for (const rule of LOGGING_RULES) {
  // Cada regla en un archivo donde aplica: errorLevel solo mira domain/ y application/.
  const file = rule.paths ? `${rule.paths[1]}usecases/agent-code.ts` : 'src/infrastructure/agent-code.ts';
  test(`check-logging.sh: «${rule.id}» sale rojo con la forma prohibida y verde con la correcta`, () => {
    const red = withAgentCode(file, rule.sample, 'infra/check-logging.sh');
    assert.equal(red.status, 1, red.output);
    assert.match(red.output, new RegExp(`\\[${rule.id}\\] ${file.replaceAll('/', '\\/')}`));
    const green = withAgentCode(file, rule.allowed, 'infra/check-logging.sh');
    assert.equal(green.status, 0, green.output);
  });
}

test('check-logging.sh: una forma prohibida dentro de un comentario no cuenta (las notas de build la explican)', () => {
  const { status, output } = withAgentCode('src/infrastructure/agent-code.ts', "// no hagas console.log('x', id);\n  /* ni console.error(command) */", 'infra/check-logging.sh');
  assert.equal(status, 0, output);
});

test('check-logging.sh: la consola de las herramientas de línea de comandos que genera build no cuenta', () => {
  for (const file of CLI_FILES) assert.ok(fs.existsSync(path.join(base, file)), file);
  const { status } = run(base, 'infra/check-logging.sh');
  assert.equal(status, 0);
});

const TAG_CASES = [
  ['una métrica nueva con el id en labelNames', "new Counter({ name: 'orders', help: 'x', labelNames: ['orderId'] });", "new Counter({ name: 'orders', help: 'x', labelNames: ['keel_operation', 'keel_outcome'] });"],
  ['una observación con el id en labels', "telemetry.observe('keel.use-case', { labels: { 'order.id': id } }, async () => {});", "telemetry.observe('keel.use-case', { labels: { [ATTRIBUTES.operation]: 'X' }, spanAttributes: { 'order.id': id } }, async () => {});"],
  ['un contador con el id como etiqueta', 'counter.inc({ customerEmail: id });', "counter.inc({ cache: 'products', result: 'hit' });"]
];

for (const [label, forbidden, allowed] of TAG_CASES) {
  test(`check-telemetry.sh: ${label} sale rojo, y la forma correcta verde`, () => {
    const file = 'src/infrastructure/agent-metrics.ts';
    const red = withAgentCode(file, forbidden, 'infra/check-telemetry.sh');
    assert.equal(red.status, 1, red.output);
    assert.match(red.output, /\[(labelNames|labels|inc)\] src\/infrastructure\/agent-metrics\.ts/);
    const green = withAgentCode(file, allowed, 'infra/check-telemetry.sh');
    assert.equal(green.status, 0, green.output);
  });
}

test('la correlación es atributo del span y nunca etiqueta de métrica', () => {
  assert.ok(!allowedTagKeys().some((key) => /correlation/.test(key)));
  const red = withAgentCode('src/infrastructure/agent-metrics.ts', "telemetry.observe('keel.use-case', { labels: { [ATTRIBUTES.correlationId]: id } }, async () => {});", 'infra/check-telemetry.sh');
  assert.equal(red.status, 1, red.output);
});

test('sin telemetría no hay gate de cardinalidad; el de logs, siempre que haya casos de uso', () => {
  const files = planFixture('product-catalog').files.map((file) => file.path);
  assert.ok(files.includes('infra/check-logging.sh'));
  assert.ok(!files.includes('infra/check-telemetry.sh'));
});
