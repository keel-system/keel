// Los dos programas awk que puntúan la matriz se EJECUTAN con bash contra XML JUnit fabricado, con
// los dos órdenes de atributos que escriben los runners de los dos generadores: Gradle pone `name`
// antes que `classname` y Vitest al revés. Con el orden de Vitest, un `/name="…"/` a secas casaba
// dentro de `classname="…"` y la matriz salía VACÍA sobre una suite en verde — lo encontró
// harness-check de keel-nest la primera vez que puntuó un XML de Vitest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK } from '../src/lib/gen/junit-scoring.js';

const CASES = [
  { id: 'FL-PRD-001-A', title: 'FL-PRD-001-A: crea el producto', outcome: 'ok' },
  { id: 'FL-PRD-001-B', title: 'FL-PRD-001-B: rechaza el duplicado', outcome: 'failure', message: 'expected 201 to be 409' },
  { id: 'FL-PRD-002-A', title: 'FL-PRD-002-A: no llega a ejecutarse', outcome: 'skipped' },
  { id: null, title: 'SMOKE-2: el servidor responde', outcome: 'ok' },
  { id: null, title: 'caso borde del agente', outcome: 'failure', message: 'un rojo que no es escenario' }
];

function testcase(order, classname, { title, outcome, message }) {
  const attrs = order === 'gradle' ? `name="${title}" classname="${classname}"` : `classname="${classname}" name="${title}"`;
  const inner =
    outcome === 'failure'
      ? `<failure message="${message}" type="AssertionError">${message}</failure>`
      : outcome === 'skipped'
        ? '<skipped/>'
        : '';
  return `    <testcase ${attrs} time="0.01">${inner}</testcase>`;
}

function xmlFor(order, classname) {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="suite" tests="${CASES.length}">
  <testsuite name="flows" tests="${CASES.length}">
${CASES.map((c) => testcase(order, classname, c)).join('\n')}
  </testsuite>
</testsuites>
`;
}

function runAwk(program, xml) {
  const dir = tmpDir('keel-junit-scoring-');
  const xmlFile = path.join(dir, 'junit.xml');
  fs.writeFileSync(xmlFile, xml);
  const runner = path.join(dir, 'run.sh');
  // Igual que en los scripts: el programa va entre comillas simples, tal cual se emite.
  fs.writeFileSync(runner, `awk '\n${program}\n' "${xmlFile.replaceAll('\\', '/')}"\n`);
  const result = spawnSync('bash', [runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, `awk salió con ${result.status}: ${result.stderr}`);
  return result.stdout;
}

for (const [order, classname, shown] of [
  ['gradle', 'com.acme.catalog.flows.ProductFlowIT', 'ProductFlowIT'],
  ['vitest', 'product-flow', 'product-flow']
]) {
  test(`la matriz lee cada escenario con su desenlace (orden de atributos de ${order})`, () => {
    const rows = runAwk(JUNIT_MATRIX_AWK, xmlFor(order, classname)).trim().split('\n').sort();
    assert.deepEqual(rows, [
      `FALLO\tFL-PRD-001-B\t${shown}`,
      `OK\tFL-PRD-001-A\t${shown}`,
      `OMITIDO\tFL-PRD-002-A\t${shown}`
    ]);
  });

  test(`las pruebas en rojo que no son escenarios salen con su mensaje (orden de ${order})`, () => {
    const out = runAwk(JUNIT_NON_SCENARIO_AWK, xmlFor(order, classname));
    assert.match(out, new RegExp(`caso borde del agente\\s+\\(${shown}\\)`));
    assert.match(out, /un rojo que no es escenario/);
    assert.doesNotMatch(out, /FL-PRD/);
  });
}
