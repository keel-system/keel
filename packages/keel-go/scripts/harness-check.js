#!/usr/bin/env node
// Ejercita el ARNÉS DE INTEGRACIÓN que emite keel-go contra su infraestructura real.
//
// Por qué no está en `npm test`: necesita Go, red (proxy.golang.org la primera vez), podman o docker, y tarda minutos.
// La suite del paquete compara el texto emitido y ejecuta el awk de la matriz contra un XML fabricado; esto es lo único
// que dice que la cadena entera funciona: que `infra/up.sh` levanta lo que el diseño pide, que `validate-infra.sh` lo
// ve listo, que el arnés compila y arranca el servidor como proceso contra esa base, que `reset-db.sh` vacía los datos
// y RESPETA el historial de goose, que gotestsum escribe el XML que `score-scenarios.sh` sabe leer, y que cada desenlace
// sale con su código y su evidencia.
//
//   node packages/keel-go/scripts/harness-check.js [--keep] [--database=mysql]
//   npm run harness-check --workspace packages/keel-go
//
// --database=mysql genera el proyecto sobre MySQL: la misma cadena con su CLI y su reset.
//
// Las pruebas de flujo son SONDAS escritas aquí (los handlers del proyecto recién generado fallan con
// ErrNotImplemented): una que pasa, una que falla a propósito, una que entra en pánico, una cuyo flujo no llega a
// arrancar, una que comprueba el orden de los escenarios y una que rompe la caja negra. Cada una afirma un desenlace
// distinto del script. Es el gemelo del harness-check de keel-dotnet y keel-nest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, GO_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';
import { MIGRATIONS_TABLE } from '../src/scaffold/infra.js';

const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const results = [];

// Los sabotajes: cada uno rompe UNA pieza de lo emitido conservando su forma, y tiene que tumbar exactamente los pasos
// de `expect` (por el principio de su nombre). Se aplican al proyecto ya generado; si el texto que buscan no está, el
// sabotaje no se aplica y el script lo dice en vez de dar un verde falso.
const SABOTAGES = {
  // El reset trunca también el historial de goose. Medido (2026-10-30): no hace falta la sonda del reset para verlo. El
  // humo resetea, y el servidor de la invocación siguiente (la suite) ya no ARRANCA: goose reaplica la baseline sobre
  // tablas que existen. Todos los flujos salen OMITIDOS con «el servidor no arrancó», que es el fallo real que la regla
  // evita, y caen todos los pasos que esperan un escenario ejecutado.
  history: {
    file: 'infra/reset-db.sh',
    from: MIGRATIONS_TABLE,
    to: 'keel_otra_tabla',
    all: true,
    expect: [
      'score: un escenario en verde sale OK',
      'score: los escenarios de un flujo corren en el orden escrito',
      'score: el que falla sale FALLO',
      'score: un pánico es el FALLO',
      'score: y lo nombra como arnés roto',
      'score: un id FL-* que el documento no declara',
      'score: con algo que arbitrar sale con 1',
      'la evidencia del fallo lleva escenario',
      'la evidencia del pánico',
      'el flujo que no arranca deja TestProbeInit-init.json',
      'score: todo en verde sale con 0'
    ]
  },
  // Un flujo que no arrancó deja correr sus escenarios: salen OK (o en rojo por la causa del arranque) en vez de OMITIDOS.
  skip: {
    file: 'tests/integration/flow_test.go',
    from: '\t\tif f.failure != "" {\n\t\t\tt.Skipf("el flujo no llegó a arrancar: %s", f.failure)\n\t\t}\n',
    to: '',
    expect: ['score: el flujo que no arranca deja sus casos OMITIDOS', 'score: un id FL-* que el documento no declara']
  },
  // La evidencia sin el intercambio: el árbitro tendría que reproducir el escenario a mano.
  capture: {
    file: 'tests/integration/harness_test.go',
    from: '\tcapture.recordExchange(sent, responseReport{Status: got.Status, Headers: flatten(response.Header, true), Body: got.Body})\n',
    to: '\t_ = sent\n',
    expect: ['la evidencia del fallo lleva escenario']
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
  console.error('harness-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function go(projectDir, args) {
  const result = spawnSync('go', args, { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const engine = process.argv.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const workspace = makeWorkspace('keel-go-harness-');
mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN);
const projectDir = path.join(workspace, 'services', `${GO_READY_DESIGN.name}-go`);
if (engine !== 'postgresql') {
  // El motor, en el keel-stack.json del proyecto: build lo lee antes de preguntar.
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'keel-stack.json'), JSON.stringify({ database: engine }));
}
const generated = await runCommand(workspace, build, `specs/${GO_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}
const tidy = go(projectDir, ['mod', 'tidy']);
if (!step('go mod tidy', tidy.ok, tidy.ok ? '' : tidy.output.slice(-1200))) process.exit(1);
const module = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(projectDir, 'go.mod'), 'utf8'))[1];
if (sabotage) {
  const target = path.join(projectDir, sabotage.file);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(sabotage.from)) {
    console.error(`El sabotaje ${sabotageId} no se aplica a lo emitido hoy: ${sabotage.file} ya no contiene lo que busca.`);
    process.exit(2);
  }
  fs.writeFileSync(target, sabotage.all ? text.replaceAll(sabotage.from, sabotage.to) : text.replace(sabotage.from, sabotage.to));
  console.log(`(sabotaje: ${sabotageId})`);
}

// ── go test ./... en la raíz NO ejecuta las pruebas de flujo: necesitan infra/ ──
const unit = go(projectDir, ['test', '-count=1', './...']);
step('go test ./... pasa sin infraestructura y no ejecuta las pruebas de flujo', unit.ok && !/tests\/integration/.test(unit.output), unit.ok ? '' : unit.output.slice(-1200));

const flowsDir = path.join(projectDir, 'tests', 'integration');
const probe = (name, body) => fs.writeFileSync(path.join(flowsDir, `${name}_test.go`), `//go:build integration\n\npackage integration\n${body}`);
const unprobe = (name) => fs.rmSync(path.join(flowsDir, `${name}_test.go`), { force: true });

// ── La caja negra: un flujo que importa un paquete del servicio ──
probe(
  'probe_import_flow',
  `
import (
	"testing"

	"${module}/internal/domain"
)

func TestProbeImport(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-PROBE-009-A: nombra el dominio", func(s *Scenario) {
		_ = domain.ErrInvalidValue
	})
}
`
);
const blind = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh sale en rojo si una prueba de flujo importa un paquete del servicio', blind.status === 1 && /Caja negra rota/.test(blind.output) && /internal\/domain/.test(blind.output), `código ${blind.status}: ${blind.output.slice(-400)}`);
unprobe('probe_import_flow');

// ── El gate del agente de pruebas: compila SOLO las pruebas de flujo ──
probe('probe_types_flow', '\nfunc TestProbeTypes(t *testing.T) {\n\tvar n int = "texto"\n\t_ = n\n}\n');
const typesRed = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh sale en rojo con una prueba de flujo que no compila', typesRed.status === 1 && /probe_types_flow_test\.go/.test(typesRed.output), `código ${typesRed.status}: ${typesRed.output.slice(-400)}`);
unprobe('probe_types_flow');
// Un error en internal/ (el agente de código a medio trabajo) no es de las pruebas: no las pone en rojo.
const domainDoc = path.join(projectDir, 'internal', 'domain', 'doc.go');
const domainSource = fs.readFileSync(domainDoc, 'utf8');
const broken = `${domainSource}\nvar roto int = "internal a medio escribir"\n`;
fs.writeFileSync(domainDoc, broken);
const flowsSrc = bash(projectDir, 'infra/check-flows.sh');
fs.writeFileSync(domainDoc, domainSource);
step('check-flows.sh no se pone rojo por un error en internal/', flowsSrc.status === 0, `código ${flowsSrc.status}: ${flowsSrc.output.slice(-400)}`);
const flowsGreen = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh en verde sobre el proyecto recién generado', flowsGreen.status === 0, flowsGreen.output.slice(-400));

// ── La infraestructura, con sus propios scripts ──
const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  // Una que pasa, y que además mide el reset contra la base real: vacía los datos y respeta el historial de goose,
  // que el servidor llenó al arrancar.
  probe(
    'probe_ok_flow',
    `
import (
	"strings"
	"testing"
)

func TestProbeOk(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-PROBE-001-A: una ruta inexistente responde 404 con ErrorResponse", func(s *Scenario) {
		got := s.Get(RouteBase + "/keel-probe")
		s.ExpectStatus(got, 404)
		// Las piezas de aserción del arnés: el JSON estricto con la forma de lo generado.
		s.AssertJSON(\`{"timestamp":"<instant>","status":404,"error":"Not Found","code":null,"message":"Recurso no encontrado","details":null,"correlationId":"<uuid>"}\`, got)
	})
	f.Scenario("FL-PROBE-001-B: el reset vacía los datos y respeta el historial de migraciones", func(s *Scenario) {
		history := strings.TrimSpace(s.Db("SELECT count(*) FROM ${MIGRATIONS_TABLE}"))
		if history == "0" {
			s.Fatal("el servidor no dejó historial de goose al arrancar")
		}
		s.Db("CREATE TABLE IF NOT EXISTS keel_probe (id int)")
		s.Db("INSERT INTO keel_probe VALUES (1)")
		s.ResetState()
		if got := strings.TrimSpace(s.Db("SELECT count(*) FROM keel_probe")); got != "0" {
			s.Errorf("keel_probe tiene %s filas tras el reset", got)
		}
		if got := strings.TrimSpace(s.Db("SELECT count(*) FROM ${MIGRATIONS_TABLE}")); got != history {
			s.Errorf("el historial de goose pasó de %s a %s filas con el reset", history, got)
		}
		s.Db("DROP TABLE keel_probe")
	})
	// AssertJSON compara las cadenas por su VALOR (el escape no es contrato) y los números por su TEXTO.
	f.Scenario("FL-PROBE-001-C: AssertJSON compara las cadenas por su valor y los números por su texto", func(s *Scenario) {
		literal := &Response{Status: 200, Body: \`{"motivo":"sin respuesta del almacén","importe":2.50}\`}
		s.AssertJSON(\`{"motivo":"sin respuesta del almac\\u00e9n","importe":2.50}\`, literal)
		if len(jsonMismatches(\`{"motivo":"sin respuesta del almacen","importe":2.50}\`, literal.Body)) == 0 {
			s.Error("una cadena distinta casó")
		}
		if len(jsonMismatches(\`{"motivo":"sin respuesta del almacén","importe":2.5}\`, literal.Body)) == 0 {
			s.Error("2.5 casó con 2.50")
		}
		if len(jsonMismatches(\`{"motivo":"sin respuesta del almacén"}\`, literal.Body)) == 0 {
			s.Error("una clave de más casó")
		}
	})
	// ExchangeAll: las peticiones a la vez, con las respuestas en el orden en que se pidieron.
	f.Scenario("FL-PROBE-001-D: ExchangeAll lanza las peticiones a la vez y devuelve cada respuesta en su sitio", func(s *Scenario) {
		got := s.ExchangeAll(
			Request{Method: "GET", Path: RouteBase + "/keel-probe"},
			Request{Method: "GET", Path: "/livez"},
			Request{Method: "GET", Path: RouteBase + "/keel-probe-2"},
		)
		if len(got) != 3 || got[0].Status != 404 || got[1].Status != 200 || got[2].Status != 404 {
			s.Fatalf("respuestas fuera de su sitio: %v", got)
		}
	})
	// Un id que el documento no declara: sale AJENO y no puntúa (keel-core/gen/junit-scoring).
	f.Scenario("FL-PROBE-099-A: un caso fuera del documento", func(s *Scenario) {})
}
`
  );
  // Una que falla a propósito: su evidencia tiene que llevar la petición y la respuesta.
  probe(
    'probe_fail_flow',
    `
import "testing"

func TestProbeFail(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-PROBE-002-A: espera un 200 que no llega", func(s *Scenario) {
		s.ExpectStatus(s.Get(RouteBase+"/keel-probe-rojo"), 200)
	})
}
`
  );
  // Un flujo que no llega a arrancar: su Given común falla. StartFlow da sus escenarios por OMITIDOS y deja
  // <Flujo>-init.json.
  probe(
    'probe_init_flow',
    `
import "testing"

func TestProbeInit(t *testing.T) {
	f := StartFlow(t, func(s *Scenario) {
		s.Db("SELECT * FROM keel_tabla_que_no_existe")
	})
	f.Scenario("FL-PROBE-003-A: no llega a ejecutarse", func(s *Scenario) {})
}
`
  );
  // Los escenarios de un flujo corren en el orden ESCRITO.
  probe(
    'probe_order_flow',
    `
import (
	"slices"
	"testing"
)

func TestProbeOrder(t *testing.T) {
	var ran []string
	f := StartFlow(t, nil)
	f.Scenario("FL-PROBE-005-C: va primero", func(s *Scenario) { ran = append(ran, "C") })
	f.Scenario("FL-PROBE-005-A: va segundo", func(s *Scenario) { ran = append(ran, "A") })
	f.Scenario("FL-PROBE-005-B: va tercero y lo comprueba", func(s *Scenario) {
		ran = append(ran, "B")
		if !slices.Equal(ran, []string{"C", "A", "B"}) {
			s.Errorf("orden %v", ran)
		}
	})
}
`
  );
  // Un pánico en un escenario es un FALLO de ese escenario, no el final de la suite: el nombre del archivo lo pone
  // ANTES que los demás (Go ejecuta los Test… por archivo, en orden alfabético), así que los OK de después lo prueban.
  probe(
    'probe_early_panic_flow',
    `
import "testing"

func TestProbeEarlyPanic(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-PROBE-006-A: entra en pánico", func(s *Scenario) {
		var nothing map[string]int
		nothing["boom"] = 1
	})
}
`
  );

  // Un documento de escenarios con un flujo que ninguna prueba ejercita: tiene que salir NO_EJERC. Sustituye al del
  // diseño, así que su línea sale del sello: specs.sha256 vigila lo que lista, y el documento sonda no lo escribió build.
  fs.writeFileSync(
    path.join(projectDir, 'specs', 'validation-scenarios.md'),
    ['FL-PROBE-001', 'FL-PROBE-002', 'FL-PROBE-003', 'FL-PROBE-004', 'FL-PROBE-005', 'FL-PROBE-006'].map((id) => `#### ${id} — sonda\n`).join('\n')
  );
  const seal = path.join(projectDir, 'specs.sha256');
  if (fs.existsSync(seal)) {
    const kept = fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md'));
    fs.writeFileSync(seal, kept.join('\n'));
  }

  const evidence = path.join(projectDir, 'build', 'keel-failures');
  const run1 = bash(projectDir, 'infra/score-scenarios.sh');
  const lines = run1.output;
  const has = (pattern) => pattern.test(lines);
  step('score: un escenario en verde sale OK', has(/OK\s+FL-PROBE-001-A/) && has(/OK\s+FL-PROBE-001-B/) && has(/OK\s+FL-PROBE-001-C/) && has(/OK\s+FL-PROBE-001-D/), has(/OK\s+FL-PROBE-001-D/) ? '' : lines.slice(-2500));
  step('score: los escenarios de un flujo corren en el orden escrito', has(/OK\s+FL-PROBE-005-B/), has(/FL-PROBE-005-B/) ? '' : 'sin fila FL-PROBE-005-B');
  step('score: el que falla sale FALLO con la ruta de su evidencia', has(/FALLO\s+FL-PROBE-002-A\s+\S+\s+build\/keel-failures\/FL-PROBE-002-A\.json/));
  step('score: un pánico es el FALLO de su escenario y la suite sigue', has(/FALLO\s+FL-PROBE-006-A/) && has(/OK\s+FL-PROBE-005-A/));
  step('score: el flujo que no arranca deja sus casos OMITIDOS', has(/OMITIDO\s+FL-PROBE-003-A/), has(/OMITIDO/) ? '' : 'sin fila OMITIDO');
  step('score: y lo nombra como arnés roto, con su causa', has(/ARNÉS/) && has(/TestProbeInit\s+\(arranque del flujo\)/) && has(/keel_tabla_que_no_existe/));
  step('score: un id FL-* que el documento no declara sale AJENO y no puntúa', has(/AJENO\s+FL-PROBE-099-A/) && !has(/^\s+OK\s+FL-PROBE-099-A/m) && /RESULTADO: KO — 7 OK/.test(lines), lines.match(/RESULTADO:.*/)?.[0] ?? '');
  step('score: un flujo del documento sin prueba sale NO_EJERC', has(/NO_EJERC\s+FL-PROBE-004/) && !has(/NO_EJERC\s+FL-PROBE-00[12356]/));
  step('score: con algo que arbitrar sale con 1', run1.status === 1, `código ${run1.status}`);
  const readJson = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));
    } catch {
      return null;
    }
  };
  const report = readJson('FL-PROBE-002-A.json');
  step(
    'la evidencia del fallo lleva escenario, aserción, petición y respuesta',
    report?.scenario === 'FL-PROBE-002-A' &&
      report.testClass === 'TestProbeFail' &&
      /200/.test(report.assertion ?? '') &&
      report.request?.method === 'GET' &&
      report.request?.path?.endsWith('/keel-probe-rojo') &&
      report.response?.status === 404,
    report ? JSON.stringify(report).slice(0, 300) : 'no existe'
  );
  const panicked = readJson('FL-PROBE-006-A.json');
  step('la evidencia del pánico lleva el pánico y su pila', /pánico: assignment to entry in nil map/.test(panicked?.assertion ?? ''), panicked ? JSON.stringify(panicked).slice(0, 300) : 'no existe');
  const init = readJson('TestProbeInit-init.json');
  step('el flujo que no arranca deja TestProbeInit-init.json con el sondeo que falló', init?.phase === 'init' && /keel_tabla_que_no_existe/.test(init?.probe?.output ?? ''), init ? JSON.stringify(init).slice(0, 300) : 'no existe');
  // El servidor es un proceso aparte: al terminar la suite no puede quedar vivo (en Windows retendría el binario y
  // seguiría escribiendo en la base).
  const binary = path.join(projectDir, 'build', 'keel-scenarios', isWindows ? 'server.exe' : 'server');
  let removed = true;
  try {
    fs.rmSync(binary);
  } catch {
    removed = false;
  }
  step('el servidor no sobrevive a la suite (su binario se puede borrar)', removed);
  step('el log del servidor queda en build/keel-scenarios/server.log', fs.existsSync(path.join(projectDir, 'build', 'keel-scenarios', 'server.log')));

  // Sin escenarios en FALLO, un flujo que no arranca es el arnés, no algo que arbitrar: sale con 2.
  unprobe('probe_fail_flow');
  unprobe('probe_early_panic_flow');
  const run2 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: un flujo que no arranca y ningún FALLO sale con 2', run2.status === 2, `código ${run2.status}`);

  // Todo en verde: sin el documento de escenarios (ni su sello), la matriz limpia sale con 0.
  unprobe('probe_init_flow');
  fs.rmSync(path.join(projectDir, 'specs.sha256'), { force: true });
  fs.rmSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), { force: true });
  const run3 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: todo en verde sale con 0', run3.status === 0 && /RESULTADO: OK/.test(run3.output), `código ${run3.status}: ${run3.output.slice(-600)}`);

  // Un servicio que no compila no se puntúa: sale con 2 diciéndolo.
  fs.writeFileSync(domainDoc, broken);
  const run4 = bash(projectDir, 'infra/score-scenarios.sh');
  fs.writeFileSync(domainDoc, domainSource);
  step('score: con el servicio sin compilar sale con 2 y lo dice', run4.status === 2 && /BUILD: KO/.test(run4.output) && /doc\.go/.test(run4.output), `código ${run4.status}: ${run4.output.slice(-400)}`);

  // Un snapshot editado desde el proyecto no se puntúa.
  fs.writeFileSync(path.join(projectDir, 'specs.sha256'), `${'0'.repeat(64)}  specs/service.keel.yaml\n`);
  const run5 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: un specs/ que no casa con su sello sale con 2 sin ejecutar nada', run5.status === 2 && /DISEÑO/.test(run5.output), `código ${run5.status}`);
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-go-harness-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
if (sabotage) {
  // Verde = el sabotaje cae en rojo con EXACTAMENTE sus pasos.
  const red = results.filter((result) => !result.ok).map((result) => result.name);
  const expected = (name) => sabotage.expect.some((prefix) => name.startsWith(prefix));
  const missing = sabotage.expect.filter((prefix) => !red.some((name) => name.startsWith(prefix)));
  const extra = red.filter((name) => !expected(name));
  const caught = missing.length === 0 && extra.length === 0;
  console.log(
    caught
      ? `\nharness-check --sabotage=${sabotageId}: falsado, en rojo exactamente ${red.length} paso(s).`
      : `\nharness-check --sabotage=${sabotageId}: NO falsado.${missing.length ? ` Siguen en verde: ${missing.join(' | ')}.` : ''}${extra.length ? ` En rojo de más: ${extra.join(' | ')}.` : ''}`
  );
  process.exit(caught ? 0 : 1);
}
console.log(failed === 0 ? `\nharness-check: ${results.length}/${results.length} en verde.` : `\nharness-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
