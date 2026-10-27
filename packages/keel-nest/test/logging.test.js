// Los logs que emite keel-nest (incremento 14b), EJECUTADOS: se transpila el árbol de una fixture, se carga la
// configuración real de cada perfil (los `config/` emitidos) y se escribe con el logger emitido. Lo que se
// afirma es lo que keel-spring hace con y sin telemetría: texto en local, JSON ECS anidado (el de Spring Boot
// 3.5) fuera de él, el correlationId en cada línea, los niveles de LOG_LEVEL_ROOT/LOG_LEVEL_APP y una pila
// solo donde se pasa.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FRAMEWORK_CONTEXTS } from '../src/scaffold/logging.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const plan = planFixture('product-catalog');
const tree = transpileTree(plan.files);
const { loadConfiguration } = await tree.load('src/infrastructure/config/configuration.ts');
const { KeelLogger } = await tree.load('src/infrastructure/logging/keel-logger.ts');
const { CorrelationContext } = await tree.load('src/infrastructure/correlation/correlation-context.ts');

// Los config/ emitidos, en un directorio propio: loadConfiguration los lee de `<root>/config`.
const root = tmpDir('keel-nest-logging-');
for (const file of plan.files.filter((candidate) => candidate.path.startsWith('config/'))) {
  fs.mkdirSync(path.join(root, path.dirname(file.path)), { recursive: true });
  fs.writeFileSync(path.join(root, file.path), file.content);
}

// production exige las variables de la base (sin default): no son de esta prueba.
const DB = { DB_URL: 'postgres://db/x', DB_USERNAME: 'u', DB_PASSWORD: 'p' };

function loggerFor(env) {
  const configuration = loadConfiguration({ ...DB, ...env }, root);
  const lines = [];
  const base = KeelLogger.from(configuration);
  const logger = new KeelLogger({ ...base.options, write: (line) => lines.push(line) });
  return { logger, lines, configuration };
}

test('fuera de local la línea es JSON ECS anidado, con el servicio, la réplica y el correlationId', () => {
  const { logger, lines } = loggerFor({ PROFILE: 'production', HOSTNAME: 'pod-7' });
  CorrelationContext.runWith('pedido-42', () => logger.log('Caso de uso createProduct: ok (3 ms)', 'UseCaseMediator'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  const line = JSON.parse(lines[0]);
  assert.match(line['@timestamp'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(line.log, { level: 'INFO', logger: 'UseCaseMediator' });
  assert.equal(line.process.pid, process.pid);
  assert.deepEqual(line.service, {
    name: plan.model.service.name,
    version: plan.model.service.version,
    environment: 'production',
    node: { name: 'pod-7' }
  });
  assert.equal(line.message, 'Caso de uso createProduct: ok (3 ms)');
  assert.equal(line.correlationId, 'pedido-42');
  assert.deepEqual(line.ecs, { version: '8.11' });
  assert.equal('error' in line, false);
});

test('la réplica sale de SERVICE_INSTANCE_ID, si no de HOSTNAME, y si no es unknown (el placeholder anidado de keel-spring)', () => {
  const nodeName = (env) => loggerFor({ PROFILE: 'develop', ...env }).configuration.get('logging.structured.ecs.service.node-name');
  assert.equal(nodeName({ SERVICE_INSTANCE_ID: 'replica-2', HOSTNAME: 'pod-7' }), 'replica-2');
  assert.equal(nodeName({ HOSTNAME: 'pod-7' }), 'pod-7');
  assert.equal(nodeName({}), 'unknown');
  // Lo que llega de una variable se usa tal cual: no se vuelve a resolver.
  assert.equal(nodeName({ SERVICE_INSTANCE_ID: '${HOSTNAME}' }), '${HOSTNAME}');
});

test('los niveles: el framework con LOG_LEVEL_ROOT y el servicio con LOG_LEVEL_APP, con el gradiente de keel-spring', () => {
  const production = loggerFor({ PROFILE: 'production' });
  production.logger.log('Nest application successfully started', FRAMEWORK_CONTEXTS[1]);
  production.logger.warn('pool casi lleno', 'InstanceLoader');
  production.logger.log('publicado', 'OutboxRelay');
  production.logger.debug('detalle', 'OutboxRelay');
  assert.deepEqual(production.lines.map((line) => JSON.parse(line).message), ['pool casi lleno', 'publicado']);

  const tuned = loggerFor({ PROFILE: 'production', LOG_LEVEL_ROOT: 'INFO', LOG_LEVEL_APP: 'DEBUG' });
  tuned.logger.log('arrancado', 'NestApplication');
  tuned.logger.debug('detalle', 'OutboxRelay');
  assert.equal(tuned.lines.length, 2);

  assert.throws(() => loggerFor({ PROFILE: 'production', LOG_LEVEL_APP: 'CHATTY' }), /Nivel de log desconocido: 'CHATTY'/);
});

test('un error con su pila la lleva en error.stack_trace; sin pila no se inventa una', () => {
  const { logger, lines } = loggerFor({ PROFILE: 'develop' });
  const failure = new TypeError('no se pudo leer');
  logger.error('Excepción no controlada', failure.stack, 'ApiExceptionFilter');
  logger.error('Caso de uso createProduct: falló con TypeError (2 ms)', 'UseCaseMediator');
  const [withStack, withoutStack] = lines.map((line) => JSON.parse(line));
  assert.equal(withStack.log.level, 'ERROR');
  assert.match(withStack.error.stack_trace, /TypeError: no se pudo leer\n\s+at /);
  assert.equal('error' in withoutStack, false);
});

test('en local la línea es texto, con el correlationId entre corchetes y la pila debajo', () => {
  const { logger, lines } = loggerFor({ PROFILE: 'local' });
  CorrelationContext.runWith('pedido-42', () => logger.log('publicado', 'OutboxRelay'));
  logger.error('Excepción no controlada', new Error('boom').stack, 'ApiExceptionFilter');
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z  INFO \d+ --- \[pedido-42\] \[OutboxRelay\] publicado\n$/);
  assert.match(lines[1], /ERROR \d+ --- \[ApiExceptionFilter\] Excepción no controlada\nError: boom\n\s+at /);
  // Sin LOG_FORMAT, develop es JSON; con LOG_FORMAT=text, texto.
  const forced = loggerFor({ PROFILE: 'develop', LOG_FORMAT: 'text' });
  forced.logger.log('hola', 'OutboxRelay');
  assert.doesNotThrow(() => assert.match(forced.lines[0], / INFO .*\[OutboxRelay\] hola/));
});

test('logging.yaml usa las MISMAS variables y defaults que el de keel-spring en los tres perfiles comunes', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  const spring = Object.fromEntries(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.map((file) => [file.path, file.content]));
  const variables = (text) => [...text.matchAll(/\$\{([A-Z_]+):?([^}$]*)/g)].map(([, name, value]) => `${name}=${value}`).sort();
  for (const profile of ['local', 'develop', 'production']) {
    const nest = plan.files.find((file) => file.path === `config/parameters/${profile}/logging.yaml`).content;
    const fromSpring = Object.entries(spring).find(([file]) => file.endsWith(`/parameters/${profile}/logging.yaml`))?.[1];
    assert.ok(fromSpring, `keel-spring ${profile}`);
    assert.deepEqual(variables(nest), variables(fromSpring), profile);
    const springLevels = levelValues(fromSpring);
    const nestLevels = ['root', 'app'].map((key) => nest.split('\n').find((line) => line.startsWith(`    ${key}: `)).split(': ')[1]);
    assert.deepEqual(nestLevels, springLevels, profile);
  }
});

/** Los dos primeros niveles de keel-spring: la raíz y el paquete del servicio. */
function levelValues(yaml) {
  return yaml
    .split('\n')
    .filter((line) => line.startsWith('    ') && !line.startsWith('     ') && line.includes(': ') && !line.trimStart().startsWith('#'))
    .slice(0, 2)
    .map((line) => line.split(': ')[1]);
}

test('main.ts instala el logger de la configuración', () => {
  const main = plan.files.find((file) => file.path === 'src/main.ts').content;
  assert.match(main, /logger: KeelLogger\.from\(configuration\)/);
});
