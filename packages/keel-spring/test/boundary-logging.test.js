// Los logs de las FRONTERAS, que fija build con y sin telemetría, y la higiene de los que añade
// el agente (infra/check-logging.sh). Lo que se ata aquí salió de arrancar el servidor contra un
// colector real: cada fallo salía con DOS pilas idénticas (la de @LogExceptions y la de
// ApiExceptionHandler), y una tarea lanzada a otro hilo perdía el correlationId y la traza.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { HARNESSES, loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function generate(fixture, stack) {
  const { manifest, layers } = loadService(path.join(fixturesDir, fixture));
  const workspace = tmpDir('keel-logging-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack });
  const root = path.join(workspace, result.outDir);
  const find = (suffix) => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    const hit = walk(root).find((file) => file.split(path.sep).join('/').endsWith(suffix));
    assert.ok(hit, `no se generó ${suffix}`);
    return fs.readFileSync(hit, 'utf8');
  };
  return { root, find, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8') };
}

for (const telemetry of ['none', 'otel']) {
  test(`frontera del caso de uso (telemetry=${telemetry}): resultado y duración en el mediator, sin pila`, () => {
    const mediator = generate('stock-reservation', { broker: 'kafka', telemetry }).find('/UseCaseMediator.java');
    assert.ok(mediator.includes('private static final Logger log = LoggerFactory.getLogger(UseCaseMediator.class);'));
    assert.ok(mediator.includes('callUseCase(query, () ->'));
    for (const outcome of ['"ok"', '"rejected"', '"error"']) assert.ok(mediator.includes(`.addKeyValue("keel.outcome", ${outcome})`), outcome);
    assert.ok(mediator.includes('catch (DomainException ex)'));
    // La pila la imprime el adaptador por el que entró el fallo: aquí no se le pasa la excepción al log.
    assert.ok(!/\.log\([^;]*,\s*ex\)\s*;/.test(mediator), 'el mediator no puede imprimir la pila');
    assert.equal(mediator.includes('observationOf(operation)'), telemetry === 'otel');
  });
}

test('una sola pila por fallo: @LogExceptions deja de imprimirla y ApiExceptionHandler la conserva', () => {
  const project = generate('stock-reservation', { broker: 'kafka' });
  const aspect = project.find('/LogExceptionsAspect.java');
  assert.ok(!/log\.(trace|debug|info|warn)\([^;]*,\s*exception\)\s*;/.test(aspect), 'el aspecto no puede pasar la excepción al log');
  assert.ok(aspect.includes('exception.getClass().getSimpleName()'));
  assert.ok(project.find('/ApiExceptionHandler.java').includes('log.error("Excepción no controlada", exception);'));
});

test('frontera del consumo: el guard registra el duplicado descartado', () => {
  const guard = generate('stock-reservation', { broker: 'kafka' }).find('/IdempotencyGuard.java');
  assert.ok(guard.includes('logDuplicate(handlerId, eventId, "ya procesado")'));
  assert.ok(guard.includes('.addKeyValue("keel.outcome", "duplicate")'));
});

test('trabajo en paralelo: el executor que propaga el contexto existe con y sin telemetría y la convention lo enseña', () => {
  const project = generate('stock-reservation', { broker: 'kafka' });
  const helper = project.find('/application/support/ContextPropagatingExecutors.java');
  assert.ok(helper.includes('ContextExecutorService.wrap(Executors.newVirtualThreadPerTaskExecutor()'));
  assert.ok(helper.includes('new Slf4jThreadLocalAccessor()'));
  assert.ok(project.read('build.gradle').includes("io.micrometer:context-propagation:"));
  const convention = project.read('docs/keel/conventions/virtual-threads.md');
  assert.ok(convention.includes('ContextPropagatingExecutors.newVirtualThreadPerTaskExecutor()'));
  assert.ok(!convention.includes('try (ExecutorService exec = Executors.newVirtualThreadPerTaskExecutor())'));
  assert.ok(project.read('docs/keel/conventions/logging.md').includes('Lo que ya loguea build'));
});

// El gate se EJECUTA: un includes() no distingue un gate que caza de uno que no mira.
function runGate(root) {
  return spawnSync('bash', ['infra/check-logging.sh'], { cwd: root, encoding: 'utf8' });
}

test('check-logging.sh: verde recién generado en todas las fixtures', () => {
  for (const fixture of fs.readdirSync(fixturesDir)) {
    if (!fs.existsSync(path.join(fixturesDir, fixture, 'service.keel.yaml'))) continue;
    const { root } = generate(fixture, { broker: 'kafka', telemetry: 'otel' });
    const result = runGate(root);
    assert.equal(result.status, 0, `${fixture}:\n${result.stdout}${result.stderr}`);
  }
});

test('check-logging.sh: falsado — rojo con cada forma vetada, verde con la correcta y con la comentada', () => {
  const { root } = generate('stock-reservation', { broker: 'kafka' });
  const dir = path.join(root, 'src', 'main', 'java', 'x');
  fs.mkdirSync(dir, { recursive: true });
  const write = (body) => fs.writeFileSync(path.join(dir, 'Probe.java'), `package x;\nclass Probe {\n    void a(Object command, String id) {\n${body}\n    }\n}\n`);

  write('        log.info("Pedido {} partido en {} envíos", id, 2);\n        // log.info("comentado " + id);\n        log.info("Pedido {}", command.toString().length());');
  assert.equal(runGate(root).status, 0, 'la forma correcta y la comentada no pueden dar rojo');

  for (const [rule, body] of [
    ['concat', '        log.info("pedido " + id + " partido");'],
    ['wholeObject', '        log.info("Recibido {}", command);'],
    ['context', '        var exec = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();']
  ]) {
    write(body);
    const result = runGate(root);
    assert.equal(result.status, 1, `${rule}: tenía que salir rojo\n${result.stdout}`);
    assert.ok(result.stdout.includes(`[${rule}]`), `${rule}: el hallazgo no nombra su regla\n${result.stdout}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // errorLevel: el MISMO log.error es rojo en domain/ y application/ y verde en infrastructure/,
  // que es donde un ERROR es legítimo. Sin la mitad verde, una regla que prohibiera log.error en
  // todo el árbol pasaría este test.
  const errorProbe = (layer, body) => {
    const target = path.join(root, 'src', 'main', 'java', 'x', layer);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'ErrorProbe.java'),
      `package x.${layer};\nclass ErrorProbe {\n    void a(String id) {\n${body}\n    }\n}\n`
    );
    return target;
  };
  for (const [layer, body] of [
    ['domain', '        log.error("Pedido {} inválido", id);'],
    ['application', '        log.atError().addKeyValue("keel.order_id", id).log("falló");']
  ]) {
    const target = errorProbe(layer, body);
    const result = runGate(root);
    assert.equal(result.status, 1, `errorLevel en ${layer}: tenía que salir rojo\n${result.stdout}`);
    assert.ok(result.stdout.includes('[errorLevel]'), result.stdout);
    fs.rmSync(target, { recursive: true, force: true });
  }
  const infra = errorProbe('infrastructure', '        log.error("Relay: evento {} abandonado", id);');
  assert.equal(runGate(root).status, 0, 'un ERROR en infrastructure es legítimo');
  fs.rmSync(infra, { recursive: true, force: true });
  errorProbe('application', '        // log.error("comentado {}", id);\n        log.warn("Degradado {}", id);');
  assert.equal(runGate(root).status, 0, 'WARN y el ERROR comentado no pueden dar rojo');
});

// Quien escribe los logs de negocio es el agente de código, así que es a él a quien hay que
// mandar a la convención ANTES de escribir, y no solo al de calidad después. Mientras solo lo
// citaba el de calidad, el agente de código logueaba sin haber leído las reglas y el gate las
// imponía tarde, y solo en lo que un grep puede ver (un ERROR desde el dominio o una frontera
// repetida no los ve).
test('el agente de código lee la convención de logs antes de loguear y ejecuta el gate antes de entregar', () => {
  const { root } = generate('stock-reservation', { broker: 'kafka' });
  // Las rutas salen de HARNESSES y no se escriben a mano: con una lista literal y un filtro por
  // existencia, la de opencode (`.opencode/agent/`, en singular) se quedaba fuera EN SILENCIO y
  // el test solo miraba un harness.
  for (const harness of HARNESSES) {
    const file = path.join(root, harness.agentPath('keel-spring-code'));
    assert.ok(fs.existsSync(file), `${harness.id}: no se proyectó el agente de código`);
    const agent = fs.readFileSync(file, 'utf8');
    assert.ok(agent.includes('docs/keel/conventions/logging.md'), `${file}: no manda a la convención de logs`);
    assert.ok(agent.includes('bash infra/check-logging.sh'), `${file}: no ejecuta el gate de logs`);
    assert.ok(/^logging: OK \| KO/m.test(agent), `${file}: el reporte no lleva la familia logging`);
    assert.ok(!agent.includes('{{keel:'), `${file}: queda un token sin resolver`);
  }
});
