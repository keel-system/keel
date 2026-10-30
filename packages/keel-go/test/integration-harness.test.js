// El arnés de integración de keel-go (incremento 7): la infraestructura de prueba es la MISMA que la de keel-spring del
// mismo diseño, el script que puntúa la matriz lee el XML de gotestsum con los MISMOS programas, el reset respeta el
// historial de goose, y las pruebas de flujo son de caja negra (solo la biblioteca estándar, tras la restricción
// `integration`). Lo que solo se ve con Go y contenedores —que todo eso funcione— lo mide `npm run harness-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK } from '@keel-system/keel-core/gen/junit-scoring';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { SPRING_INFRA } from '../../keel-spring/src/scaffold/devtools.js';
import { planService } from '../src/scaffold/index.js';
import { GO_INFRA, MIGRATIONS_TABLE } from '../src/scaffold/infra.js';
import { HARNESS_SMOKE_TEST, INTEGRATION_TAG } from '../src/scaffold/integration-tests.js';
import { isStdlib } from '../src/lib/go-source.js';
import { FIXTURES_DIR, GO_READY_DESIGN } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const fixtureNames = () => fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

function planFixture(name, { mutate = null } = {}) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  if (mutate) mutate(manifest, layers);
  return planService({ manifest, layers, workspace: FIXTURES_DIR });
}

/**
 * Lo que un script de infra/ dice, sin lo que es de la plataforma: los comentarios, la cabecera y los textos y la
 * tabla de historial de cada generador, sustituidos por la misma marca.
 */
function neutral(content, platform, projectName) {
  let text = content;
  const texts = [
    projectName,
    platform.historyTable,
    platform.historyTable.toUpperCase(),
    platform.generator,
    platform.strayProcess.hint,
    platform.strayProcess.close,
    platform.schemaRebuiltBy.relational,
    platform.schemaRebuiltBy.document
  ];
  for (const value of texts) text = text.split(value).join('<plataforma>');
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

for (const name of fixtureNames()) {
  test(`${name}: infra/ es la de keel-spring salvo los textos de la plataforma`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = byPath(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files);
    const go = byPath(planFixture(name).files);
    const shared = ['infra/docker-compose.yaml', 'infra/up.sh', 'infra/down.sh', 'infra/docker/Dockerfile', 'infra/validate-infra.sh', 'infra/reset-db.sh'];
    for (const file of shared) {
      assert.equal(file in go, file in spring, `${file}: lo emiten los dos o ninguno`);
      if (!(file in spring)) continue;
      const normalize = (content, platform, suffix) =>
        neutral(content, platform, `${manifest.service?.name ?? name}-${suffix}`).replace(/devtools:[0-9a-f]{12}/g, 'devtools:<etiqueta>');
      assert.equal(normalize(go[file], GO_INFRA, 'go'), normalize(spring[file], SPRING_INFRA, 'spring'), file);
    }
  });
}

test('el reset respeta la tabla de historial de goose, que el adaptador no renombra', () => {
  const files = byPath(planFixture(GO_READY_DESIGN.name).files);
  assert.equal(MIGRATIONS_TABLE, 'goose_db_version');
  assert.equal(GO_INFRA.historyTable, MIGRATIONS_TABLE);
  // goose con su tabla por defecto: si alguien la renombra en el adaptador, el reset la truncaría.
  const store = Object.entries(files).filter(([file]) => file.startsWith('internal/infrastructure/'));
  assert.ok(store.length > 0);
  for (const [file, content] of store) assert.doesNotMatch(content, /SetTableName|WithTableName/, file);
  // El comando va entre comillas simples de bash: la del literal SQL sale escapada.
  const quoted = String.raw`'\''` + MIGRATIONS_TABLE + String.raw`'\''`;
  assert.ok(files['infra/reset-db.sh'].includes(`tablename <> ${quoted}`), 'el reset excluye la tabla de historial');
  assert.doesNotMatch(files['infra/reset-db.sh'], /flyway|typeorm|ef_migrations|\{history\}/i);
});

test('score-scenarios.sh lee la matriz con los programas compartidos, con gotestsum y la restricción de las pruebas', () => {
  const script = byPath(planFixture(GO_READY_DESIGN.name).files)['infra/score-scenarios.sh'];
  assert.ok(script.includes(JUNIT_MATRIX_AWK), 'el programa de la matriz, tal cual');
  assert.ok(script.includes(JUNIT_NON_SCENARIO_AWK), 'el de las pruebas que no son escenarios, tal cual');
  assert.match(script, /no es el que escribió keel-go build/);
  assert.doesNotMatch(script, /\.\/gradlew|node_modules|npm |dotnet /);
  // gotestsum de la directiva tool, con el classname corto que lee la matriz (keel-core/test/junit-scoring.test.js).
  assert.match(script, /go tool gotestsum .*--junitfile "\$RESULTS\/\$report"/);
  assert.match(script, /--junitfile-testcase-classname short/);
  // Sin la caché de resultados: el estado está fuera del proceso, y un PASS cacheado no ejecutaría nada.
  assert.match(script, new RegExp(`-tags ${INTEGRATION_TAG} -count=1 `));
  // El humo va solo y primero, por su función.
  assert.match(script, new RegExp(`flows smoke\\.xml -run '\\^${HARNESS_SMOKE_TEST}\\$'`));
});

for (const name of fixtureNames()) {
  test(`${name}: las pruebas de flujo son caja negra y quedan fuera de go test ./...`, () => {
    const { model, files } = planFixture(name);
    const harness = files.filter((file) => file.path.startsWith('tests/integration/'));
    assert.ok(harness.some((file) => file.path === 'tests/integration/flow_test.go'));
    for (const file of harness) {
      // La restricción antes de la cláusula package, separada por una línea en blanco: si no, Go la ignora.
      assert.match(file.content, new RegExp(`^(// Code generated by keel-go\\. DO NOT EDIT\\.\\n\\n)?//go:build ${INTEGRATION_TAG}\\n\\n`), file.path);
      assert.match(file.content, /^package integration$/m, file.path);
      // Solo la biblioteca estándar: ningún paquete del servicio ni de terceros (tidy no tiene nada que añadir).
      const block = /^import \(\n([\s\S]*?)\n\)/m.exec(file.content)?.[1] ?? /^import ("[^"]+")/m.exec(file.content)?.[1] ?? '';
      for (const [, imported] of block.matchAll(/"([^"]+)"/g)) {
        assert.ok(isStdlib(imported), `${file.path}: importa ${imported}`);
        assert.ok(!imported.startsWith(model.service.goModule), `${file.path}: importa ${imported}`);
      }
      // Todo archivo con pruebas es de prueba: go build ./... no lo compila nunca.
      if (file.path !== 'tests/integration/doc.go') assert.match(file.path, /_test\.go$/);
    }
  });
}

test('el humo comprueba la fontanería que el diseño usa, y nada más', () => {
  const files = byPath(planFixture(GO_READY_DESIGN.name).files);
  const smoke = files['tests/integration/harness_smoke_test.go'];
  for (const id of ['SMOKE-1', 'SMOKE-2', 'SMOKE-3', 'SMOKE-4']) assert.match(smoke, new RegExp(`f\\.Scenario\\("${id}:`));
  // Sin persistencia no hay reset ni base que sondear.
  const bare = byPath(
    planFixture(GO_READY_DESIGN.name, {
      mutate: (manifest, layers) => {
        delete manifest.layers.persistence;
        delete layers.persistence;
      }
    }).files
  );
  const bareSmoke = bare['tests/integration/harness_smoke_test.go'];
  assert.doesNotMatch(bareSmoke, /SMOKE-1|SMOKE-3/);
  assert.match(bareSmoke, /SMOKE-2/);
  assert.equal('infra/reset-db.sh' in bare, false);
  assert.doesNotMatch(bare['tests/integration/flow_test.go'], /ResetState|resetState|Db\(/);
  // Y sin el bash ni el runtime de contenedores, que staticcheck rechazaría sin usar (U1000).
  assert.doesNotMatch(bare['tests/integration/harness_test.go'], /bashExecutable|containerRuntime/);
});

// ── El script EJECUTADO en modo --score (sin Go: solo lee el XML) ──

const XML = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="9" failures="5" errors="0" time="0.000000">
	<testsuite tests="9" failures="5" skipped="1" time="0.000000" name="integration" timestamp="2026-10-30T10:30:00-05:00">
		<testcase classname="integration" name="TestProductCreation/FL-PRD-001-A:_crea_el_producto" time="0.010000"></testcase>
		<testcase classname="integration" name="TestProductCreation/FL-PRD-001-B:_rechaza_el_duplicado" time="0.010000">
			<failure message="Failed" type="">=== RUN   TestProductCreation/FL-PRD-001-B:_rechaza_el_duplicado&#xA;    flow_test.go:252: status = 201, quiero 409; cuerpo: {}&#xA;--- FAIL: TestProductCreation/FL-PRD-001-B:_rechaza_el_duplicado (0.01s)&#xA;</failure>
		</testcase>
		<testcase classname="integration" name="TestProductCreation" time="0.020000">
			<failure message="Failed" type="">=== RUN   TestProductCreation&#xA;--- FAIL: TestProductCreation (0.02s)&#xA;</failure>
		</testcase>
		<testcase classname="integration" name="TestProductUpdate/Given" time="0.000000">
			<failure message="Failed" type="">=== RUN   TestProductUpdate/Given&#xA;    product_update_flow_test.go:9: Given roto&#xA;--- FAIL: TestProductUpdate/Given (0.00s)&#xA;</failure>
		</testcase>
		<testcase classname="integration" name="TestProductUpdate/FL-PRD-002-A:_no_arranca" time="0.000000">
			<skipped message="=== RUN   TestProductUpdate/FL-PRD-002-A:_no_arranca&#xA;    flow_test.go:197: el flujo no llegó a arrancar: Given roto&#xA;--- SKIP: TestProductUpdate/FL-PRD-002-A:_no_arranca (0.00s)&#xA;"></skipped>
		</testcase>
		<testcase classname="integration" name="TestProductUpdate" time="0.000000">
			<failure message="Failed" type="">=== RUN   TestProductUpdate&#xA;--- FAIL: TestProductUpdate (0.00s)&#xA;</failure>
		</testcase>
		<testcase classname="integration" name="TestHelper" time="0.000000">
			<failure message="Failed" type="">=== RUN   TestHelper&#xA;    helper_test.go:7: un rojo que no es escenario&#xA;--- FAIL: TestHelper (0.00s)&#xA;</failure>
		</testcase>
		<testcase classname="integration" name="TestHarnessSmoke/SMOKE-2:_el_servidor_responde" time="0.000000"></testcase>
		<testcase classname="integration" name="TestHarnessSmoke" time="0.000000"></testcase>
	</testsuite>
</testsuites>
`;

function scoreProject(xml, { scenarios, init = null }) {
  const dir = tmpDir('keel-go-score-');
  for (const sub of ['infra', 'specs', 'tests/integration', 'build/test-results/integration']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const all = byPath(planFixture(GO_READY_DESIGN.name).files);
  fs.writeFileSync(path.join(dir, 'go.mod'), all['go.mod']);
  fs.writeFileSync(path.join(dir, 'specs', 'validation-scenarios.md'), scenarios.map((id) => `#### ${id} — flujo\n`).join('\n'));
  fs.writeFileSync(path.join(dir, 'build', 'test-results', 'integration', 'junit.xml'), xml);
  if (init) {
    // El volcado de un flujo que no arrancó lo escribe failureCapture con sangría de dos espacios: una clave por línea.
    fs.mkdirSync(path.join(dir, 'build', 'keel-failures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'keel-failures', `${init.flow}-init.json`), `{\n  "scenario": "${init.flow}-init",\n  "phase": "init",\n  "assertion": "${init.message}",\n  "probe": null\n}\n`);
  }
  // --score no borra la evidencia de la corrida que puntúa: la escribe la suite, que aquí no corre.
  const script = all['infra/score-scenarios.sh'].replace('rm -rf "$EVIDENCE"\n', '[ "${1:-}" = "--score" ] || rm -rf "$EVIDENCE"\n');
  fs.writeFileSync(path.join(dir, 'infra', 'score-scenarios.sh'), script);
  const result = spawnSync('bash', ['infra/score-scenarios.sh', '--score'], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('score-scenarios.sh --score puntúa el XML de gotestsum: OK, FALLO, OMITIDO, NO_EJERC y lo que no es escenario', () => {
  const { status, output } = scoreProject(XML, {
    scenarios: ['FL-PRD-001', 'FL-PRD-002', 'FL-PRD-003'],
    init: { flow: 'TestProductUpdate', message: 'el Given del flujo falló: Given roto' }
  });
  assert.equal(status, 1, output);
  assert.match(output, /OK\s+FL-PRD-001-A\s+integration/);
  assert.match(output, /FALLO\s+FL-PRD-001-B\s+integration\s+build\/keel-failures\/FL-PRD-001-B\.json/);
  assert.match(output, /OMITIDO\s+FL-PRD-002-A\s+integration/);
  assert.match(output, /NO_EJERC\s+FL-PRD-003/);
  assert.match(output, /TestHelper\s+\(integration\)\n\s+helper_test\.go:7: un rojo que no es escenario/);
  assert.match(output, /TestProductUpdate\s+\(arranque del flujo\)\n\s+el Given del flujo falló: Given roto/);
  // El padre de los subtests no puntúa: cae porque cae un hijo, y no es otra fila.
  assert.doesNotMatch(output, /^\s+TestProductCreation\s+\(integration\)/m);
  assert.match(output, /RESULTADO: KO — 1 OK · 1 FALLO · 1 omitido\(s\) · 1 no ejercitado\(s\)/);
});

test('score-scenarios.sh --score sale con 0 con todo en verde, y con 2 sin nada que arbitrar', () => {
  const green = String.raw`<testsuites><testsuite name="integration"><testcase classname="integration" name="TestProductCreation/FL-PRD-001-A:_crea" time="0.1"></testcase><testcase classname="integration" name="TestProductCreation" time="0.1"></testcase></testsuite></testsuites>`;
  const ok = scoreProject(green, { scenarios: ['FL-PRD-001'] });
  assert.equal(ok.status, 0, ok.output);
  assert.match(ok.output, /RESULTADO: OK — 1 escenario\(s\) al 100%/);
  const empty = String.raw`<testsuites><testsuite name="integration"><testcase classname="integration" name="TestHarnessSmoke/SMOKE-2:_vivo" time="0.1"></testcase></testsuite></testsuites>`;
  const none = scoreProject(empty, { scenarios: [] });
  assert.equal(none.status, 2, none.output);
  assert.match(none.output, /matriz está VACÍA/);
});

test('check-flows.sh: la caja negra filtra los paquetes del módulo salvo el de las pruebas, EJECUTADO con bash', () => {
  const { model, files } = planFixture(GO_READY_DESIGN.name);
  const script = files.find((file) => file.path === 'infra/check-flows.sh').content;
  const line = script.split('\n').find((candidate) => candidate.trim().startsWith('visible="$('));
  assert.ok(line, 'el filtro existe');
  const module = model.service.goModule;
  // Lo que imprime `go list -test -deps` del paquete de pruebas: él mismo en sus tres formas, la biblioteca estándar y,
  // aquí, un paquete del servicio y otro que solo EMPIEZA por el nombre del módulo.
  const deps = ['fmt', 'net/http', `${module}/internal/domain`, `${module}-otro/x`, `${module}/tests/integration`, `${module}/tests/integration [${module}/tests/integration.test]`, `${module}/tests/integration.test`].join('\n');
  const dir = tmpDir('keel-go-check-flows-');
  const run = spawnSync('bash', ['-c', `deps="$(cat)"\n${line.trim()}\nprintf '%s' "$visible"`], { cwd: dir, encoding: 'utf8', input: deps });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${module}/internal/domain`);
});
