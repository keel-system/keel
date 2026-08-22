// La causa de un rojo que NO es escenario tiene que llegar por stdout.
//
// `score-scenarios.sh` compone su matriz desde el XML de JUnit, que guarda el mensaje entero de
// cada fallo — y el awk extraía solo `name=` y `classname=`. Por stdout salía
// `initializationError (MessageDispatchRescueFlowIT)` y nada más, mientras el `message=` del
// mismo `<testcase>` decía literalmente cuál era el problema. Diagnosticarlo costaba un ciclo
// completo, cuatro veces documentadas.
//
// Esto se prueba EJECUTANDO el awk con bash, no comparando cadenas: un `includes('message=')` no
// distingue un extractor correcto de uno que no imprime nada. Mismo argumento que motivó
// `keycloak-script-runs.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** El `score-scenarios.sh` que genera build para la fixture. */
function scoreScript() {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-score-');
  scaffoldService({ manifest, layers, workspace, force: true });
  return fs.readFileSync(
    path.join(workspace, 'services', 'stock-reservation-spring', 'infra', 'score-scenarios.sh'),
    'utf8'
  );
}

/**
 * Ejecuta la función `non_scenario_failures` DEL SCRIPT GENERADO contra un XML fabricado.
 * Se extrae la función en vez de correr el script entero porque el script arranca Gradle; lo que
 * se mide aquí es el extractor, y es texto suyo, sin copiar.
 */
function runExtractor(xml) {
  const script = scoreScript();
  const start = script.indexOf('non_scenario_failures() {');
  assert.notEqual(start, -1, 'el script generado ya no define non_scenario_failures');
  const end = script.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'no se encontró el cierre de non_scenario_failures');
  const fn = script.slice(start, end + 3);

  const dir = tmpDir('keel-score-run-');
  const results = path.join(dir, 'results');
  fs.mkdirSync(results);
  fs.writeFileSync(path.join(results, 'TEST-fabricado.xml'), xml);
  const runner = path.join(dir, 'run.sh');
  fs.writeFileSync(runner, `RESULTS="${results.replaceAll('\\', '/')}"\n${fn}\nnon_scenario_failures\n`);

  const result = spawnSync('bash', [runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, `el extractor salió con ${result.status}: ${result.stderr}`);
  return result.stdout;
}

const INIT_ERROR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.flows.MessageDispatchRescueFlowIT" tests="1" failures="0" errors="1">
  <testcase name="initializationError" classname="com.example.flows.MessageDispatchRescueFlowIT">
    <error message="java.lang.IllegalStateException: Falló el sondeo de infraestructura (código 1): podman exec db psql&#10;ERROR:  new row violates check constraint &quot;email_messages_status_check&quot;" type="java.lang.IllegalStateException">stack trace completo
    </error>
  </testcase>
</testsuite>
`;

test('el mensaje del fallo llega por stdout, no solo la clase', () => {
  const out = runExtractor(INIT_ERROR_XML);

  assert.match(out, /initializationError/);
  assert.match(out, /MessageDispatchRescueFlowIT/);
  // Lo que antes se perdía, que es lo único accionable de las tres líneas.
  assert.match(out, /violates check constraint/, `el mensaje no salió:\n${out}`);
  assert.match(out, /código 1/, 'se perdió el código de salida del comando');
});

test('el mensaje se colapsa a una línea y con las entidades XML resueltas', () => {
  // Multilinea rompería el formato de la lista, y un `&quot;` crudo delata que nadie lo miró.
  const out = runExtractor(INIT_ERROR_XML);
  const detail = out.split('\n').find((line) => line.includes('violates check constraint'));
  assert.ok(detail, `no hay línea de detalle:\n${out}`);
  assert.ok(!detail.includes('&quot;'), `entidad XML sin resolver: ${detail}`);
  assert.ok(!detail.includes('&#10;'), `salto de línea sin resolver: ${detail}`);
  assert.match(detail, /"email_messages_status_check"/);
});

test('un escenario FL-* NO entra en esta lista: su sitio es la matriz', () => {
  // La frontera del extractor. Si un FL-* se colara aquí, aparecería dos veces y el orquestador
  // lo trataría como arnés roto en vez de como fallo de comportamiento.
  const out = runExtractor(`<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.flows.OrderFlowIT" tests="1" failures="1" errors="0">
  <testcase name="FL-ORD-001-A: alta de pedido" classname="com.example.flows.OrderFlowIT">
    <failure message="expected: 201 but was: 500" type="AssertionError">x</failure>
  </testcase>
</testsuite>
`);
  assert.equal(out.trim(), '', `un FL-* se coló en la lista de no-escenarios:\n${out}`);
});

test('AUTOCOMPROBACIÓN: sin la extracción del mensaje el test se pone rojo', () => {
  // Sin esto solo se demuestra que el awk de hoy pasa, no que mañana no se pueda volver al que
  // solo imprimía nombre y clase.
  const script = scoreScript();
  assert.ok(
    script.includes('message="[^"]*"'),
    'el awk ya no busca el atributo message: la extracción se perdió'
  );
});
