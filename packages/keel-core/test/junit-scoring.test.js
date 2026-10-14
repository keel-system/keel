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
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK, SCENARIO_DOCUMENT_SCORING, FOREIGN_ROWS_PRINT } from '../src/lib/gen/junit-scoring.js';

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

// El XML que escribe xUnit v3 (3.2.2, `-jUnit <archivo>`), CAPTURADO de una ejecución real y no
// fabricado (solo se recortan las trazas): el runner de keel-dotnet. Tiene tres cosas que Gradle y Vitest
// no: todo en UNA línea, las clases anidadas con `+` y los mensajes con el salto de línea en hexadecimal
// (`&#xA;`) y las comillas escapadas con barra (`\&quot;`). Con la decodificación de antes, un mensaje
// de varias líneas salía con el `&#xA;` literal.
const XUNIT_V3_XML = String.raw`<testsuites name="Test results" time="0.118" tests="8" failures="3" errors="0" disabled="1"><testsuite name="Test collection for Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest+Nested (id: 49c2a93b)" time="0.009" tests="1" failures="0" skipped="0"><testcase name="FL-RES-005: anidado" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest+Nested" time="0.0089095" /></testsuite><testsuite name="Test collection for Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest (id: 35b3238d)" time="0.014" tests="7" failures="3" skipped="1"><testcase name="FL-RES-001: alta de reserva" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest" time="0.0088853" /><testcase name="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest.NotAScenario" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest" time="0.0029523"><failure type="System.InvalidOperationException" message="System.InvalidOperationException : arranque roto">   at Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest.NotAScenario()</failure></testcase><testcase name="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest.Multiline" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest" time="0.0003"><failure type="Xunit.Sdk.FailException" message="esperaba 409 STOCK_EXHAUSTED&#xA;y llegó 200 &lt;ok&gt; &amp; \&quot;x\&quot;">   at Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest.Multiline()</failure></testcase><testcase name="FL-RES-004-A: variantes(n: 1)" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest" time="0.0012794" /><testcase name="FL-RES-003: barrido" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest" time="0"><skipped message="sin broker" /></testcase><testcase name="FL-RES-002: rechazo con \&quot;stock\&quot; agotado" classname="Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest" time="0.0003124"><failure type="Xunit.Sdk.FailException" message="esperaba 409">   at Fulfillment.Stock.IntegrationTests.Flows.ReservationFlowsTest.Fails()</failure></testcase></testsuite></testsuites>
`;

test('la matriz lee el XML real de xUnit v3 (una línea, clases anidadas con +)', () => {
  const rows = runAwk(JUNIT_MATRIX_AWK, XUNIT_V3_XML).trim().split('\n').sort();
  assert.deepEqual(rows, [
    'FALLO\tFL-RES-002\tReservationFlowsTest',
    'OK\tFL-RES-001\tReservationFlowsTest',
    'OK\tFL-RES-004-A\tReservationFlowsTest',
    'OK\tFL-RES-005\tReservationFlowsTest+Nested',
    'OMITIDO\tFL-RES-003\tReservationFlowsTest'
  ]);
});

test('el mensaje de xUnit v3 sale en una línea legible: salto en hexadecimal y comillas con barra', () => {
  const out = runAwk(JUNIT_NON_SCENARIO_AWK, XUNIT_V3_XML);
  assert.match(out, /ReservationFlowsTest\.NotAScenario\s+\(ReservationFlowsTest\)\n\s+System\.InvalidOperationException : arranque roto/);
  assert.match(out, /esperaba 409 STOCK_EXHAUSTED y llegó 200 <ok> & "x"/);
  assert.doesNotMatch(out, /&#x|\\"|&quot;/);
  assert.doesNotMatch(out, /FL-RES/);
});

// El XML del runner que usa HOY el arnés de keel-dotnet: xUnit v3 4.0.2 con su runner propio (`-result-junit`; el
// proyecto de flujos está fuera de Microsoft.Testing.Platform), CAPTURADO en Windows y recortado (trazas y rutas). Frente
// al de 3.2.2: `time` va entre `name` y `classname`, el salto es `&#xD;&#xA;` y un caso omitido en tiempo de ejecución
// (el flujo que no llegó a arrancar, que se salta con Assert.Skip) lleva su motivo como TEXTO de `<skipped>`.
const XUNIT_V3_4_XML = String.raw`<testsuites name="Test results" tests="4" failures="2" errors="0" disabled="0" time="7.064000" timestamp="2026-10-14T11:20:19"><testsuite name="C:\proyecto\tests\ProductCatalog.IntegrationTests\bin\Debug\net10.0\ProductCatalog.IntegrationTests.dll" tests="4" failures="2" errors="0" disabled="0" skipped="1" time="7.064000" timestamp="2026-10-14T11:20:19" hostname="host"><testcase name="FL-CAP-001-A: en verde" time="0.008000" classname="ProductCatalog.IntegrationTests.CaptureFlow" /><testcase name="FL-CAP-001-B: en rojo con &quot;comillas&quot;" time="0.013000" classname="ProductCatalog.IntegrationTests.CaptureFlow"><failure message="Assert.Equal() Failure: Values differ&#xD;&#xA;Expected: 201&#xD;&#xA;Actual:   409">   at ProductCatalog.IntegrationTests.CaptureFlow.Rojo() in C:\proyecto\tests\ProductCatalog.IntegrationTests\CaptureFlow.cs:line 12</failure></testcase><testcase name="ProductCatalog.IntegrationTests.CaptureFlow.NoEsEscenario" time="0.003000" classname="ProductCatalog.IntegrationTests.CaptureFlow"><failure message="Assert.Equal() Failure: Strings differ&#xD;&#xA;           ↓ (pos 0)&#xD;&#xA;Expected: &quot;409 &lt;ok&gt; &amp; &quot;x&quot;&quot;&#xD;&#xA;Actual:   &quot;200&quot;&#xD;&#xA;           ↑ (pos 0)">   at ProductCatalog.IntegrationTests.CaptureFlow.NoEsEscenario() in C:\proyecto\tests\ProductCatalog.IntegrationTests\CaptureFlow.cs:line 15</failure></testcase><testcase name="FL-CAP-002-A: no arranca" time="0.000000" classname="ProductCatalog.IntegrationTests.CaptureInitFlow"><skipped>El flujo no llegó a arrancar: el servidor no arrancó (salió con código -532462766). Log: C:\proyecto\build\keel-scenarios\server.log</skipped></testcase></testsuite></testsuites>
`;

test('la matriz lee el XML real de xUnit v3 4.x (runner propio, omitido con motivo como texto)', () => {
  const rows = runAwk(JUNIT_MATRIX_AWK, XUNIT_V3_4_XML).trim().split('\n').sort();
  assert.deepEqual(rows, ['FALLO\tFL-CAP-001-B\tCaptureFlow', 'OK\tFL-CAP-001-A\tCaptureFlow', 'OMITIDO\tFL-CAP-002-A\tCaptureInitFlow']);
});

test('el mensaje de xUnit v3 4.x sale en una línea: el salto CRLF en hexadecimal también', () => {
  const out = runAwk(JUNIT_NON_SCENARIO_AWK, XUNIT_V3_4_XML);
  assert.match(out, /CaptureFlow\.NoEsEscenario\s+\(CaptureFlow\)\n\s+Assert\.Equal\(\) Failure: Strings differ .*Expected: "409 <ok> & "x"" Actual: "200"/);
  assert.doesNotMatch(out, /&#x|&quot;/);
  assert.doesNotMatch(out, /FL-CAP/);
});

// El cruce con el documento de escenarios, EJECUTADO: lo que no declara el documento no puntúa (las corridas
// `catalog` de los dos generadores dieron 66 en OK sobre 56 escenarios) y sale aparte, también en rojo.
function runScoring(document, matrixRows) {
  const dir = tmpDir('keel-junit-document-');
  const scenarios = path.join(dir, 'validation-scenarios.md');
  if (document != null) fs.writeFileSync(scenarios, document);
  const runner = path.join(dir, 'run.sh');
  fs.writeFileSync(
    runner,
    `set -u
SCENARIOS="${scenarios.replaceAll('\\', '/')}"
matrix="$(printf '${matrixRows.map((row) => row.join('\\t')).join('\\n')}')"
${SCENARIO_DOCUMENT_SCORING}
echo "MATRIX<<"; printf '%s\\n' "$matrix"; echo ">>"
echo "UNCOVERED:$uncovered"
echo "FOREIGN:$foreign"
echo "FAILURES<<"; printf '%s\\n' "$foreign_failures"; echo ">>"
echo "PRINT<<"
${FOREIGN_ROWS_PRINT}
echo ">>"
`
  );
  const result = spawnSync('bash', [runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, `bash salió con ${result.status}: ${result.stderr}`);
  const out = result.stdout;
  const block = (name) => out.split(`${name}<<\n`)[1].split('>>')[0].split('\n').filter(Boolean);
  return {
    matrix: block('MATRIX'),
    uncovered: out.match(/^UNCOVERED:(.*)$/m)[1].trim().split(/\s+/).filter(Boolean),
    foreign: out.match(/^FOREIGN:(.*)$/m)[1].trim().split(/\s+/).filter(Boolean),
    failures: block('FAILURES').join('\n'),
    print: block('PRINT').join('\n')
  };
}

const DOCUMENT = `# Escenarios

### FL-PRD-001 — alta de producto
### FL-PRD-002 — listado
#### FL-REC-002 — barrido
#### FL-REC-002-B — lo que acaba de entrar no se toca
`;

test('solo puntúa lo que el documento declara; lo ajeno sale aparte y su rojo no se pierde', () => {
  const scored = runScoring(DOCUMENT, [
    ['OK', 'FL-PRD-001', 'ProductFlowIT'],
    ['OK', 'FL-PRD-001-A', 'ProductFlowIT'],
    ['OK', 'FL-REC-002-B', 'SweepFlowIT'],
    ['OK', 'FL-REC-002-V1', 'SweepFlowIT'],
    ['OK', 'FL-PRD-0010', 'ProductFlowIT'],
    ['FALLO', 'FL-XYZ-999', 'OtherFlowIT']
  ]);
  // Un prefijo sin guion no es pertenencia: FL-PRD-0010 no es un caso de FL-PRD-001.
  assert.deepEqual(scored.foreign.sort(), ['FL-PRD-0010', 'FL-XYZ-999']);
  assert.deepEqual(scored.matrix, [
    'OK\tFL-PRD-001\tProductFlowIT',
    'OK\tFL-PRD-001-A\tProductFlowIT',
    'OK\tFL-REC-002-B\tSweepFlowIT',
    'OK\tFL-REC-002-V1\tSweepFlowIT'
  ]);
  assert.deepEqual(scored.uncovered, ['FL-PRD-002']);
  assert.match(scored.failures, /FL-XYZ-999\s+\(OtherFlowIT\)/);
  assert.match(scored.failures, /no declara FL-XYZ-999/);
  assert.doesNotMatch(scored.failures, /FL-PRD-0010/);
  assert.match(scored.print, /AJENO\s+FL-PRD-0010\s+ProductFlowIT\s+\(OK: el documento no lo declara; no puntúa\)/);
  assert.match(scored.print, /AJENO\s+FL-XYZ-999/);
});

test('sin documento de escenarios no se filtra nada', () => {
  const rows = [
    ['OK', 'FL-PRD-001', 'ProductFlowIT'],
    ['FALLO', 'FL-XYZ-999', 'OtherFlowIT']
  ];
  const scored = runScoring(null, rows);
  assert.deepEqual(scored.matrix, rows.map((row) => row.join('\t')));
  assert.deepEqual(scored.foreign, []);
  assert.deepEqual(scored.uncovered, []);
  assert.equal(scored.print, '');
});

test('con todo dentro del documento la matriz queda intacta', () => {
  const rows = [
    ['OK', 'FL-PRD-001-A', 'ProductFlowIT'],
    ['OK', 'FL-PRD-002', 'ProductFlowIT'],
    ['OK', 'FL-REC-002', 'SweepFlowIT'],
    ['OK', 'FL-REC-002-B', 'SweepFlowIT']
  ];
  const scored = runScoring(DOCUMENT, rows);
  assert.deepEqual(scored.matrix, rows.map((row) => row.join('\t')));
  assert.deepEqual(scored.foreign, []);
  assert.deepEqual(scored.uncovered, []);
});
