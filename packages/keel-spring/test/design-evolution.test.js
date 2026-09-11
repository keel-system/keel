// Evolucionar un proyecto YA completado cuando cambia su diseño, sin regenerarlo desde cero.
//
// Lo que había antes: `--refresh` ponía al día lo de build sin pisar al agente, pero un
// conflicto era perpetuo (el manifiesto guardaba la huella vieja), el handler de una
// operación retirada seguía vivo, una capa nueva no preguntaba su tecnología y nadie le
// decía al pipeline qué había cambiado. Aquí se prueba el circuito entero sobre
// `product-catalog`: el agente completa dos handlers, el diseño quita una operación (una
// de las completadas), añade otra y cambia una regla de la otra completada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { build } from '../src/commands/build.js';
import { askStackConfig, stackDrift } from '../src/lib/stack-config.js';
import { STACK_DEFAULTS } from '../src/lib/stack-catalog.js';

const SPEC = 'product-catalog';
const APP = ['src', 'main', 'java', 'com', 'commerce', 'productcatalog', 'application'];
const rel = (...parts) => [...APP, ...parts].join('/');

const CREATE_HANDLER = rel('usecases', 'CreateProductCommandHandler.java');
const GET_HANDLER = rel('usecases', 'GetProductQueryHandler.java');
const GET_QUERY = rel('queries', 'GetProductQuery.java');
const GET_DTO = rel('dtos', 'GetProductResponseDto.java');
const COUNT_HANDLER = rel('usecases', 'CountProductsQueryHandler.java');
const EVOLUTION = 'build/keel-refresh/EVOLUTION.md';

function withFixture() {
  const workspace = tmpDir('keel-evolution-');
  fs.mkdirSync(path.join(workspace, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'schema', 'service.schema.json'), '{}');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', SPEC);
  fs.cpSync(fixture, path.join(workspace, 'specs', SPEC), { recursive: true });
  return workspace;
}

async function runBuild(workspace, options = {}) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const silenced = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await build(`specs/${SPEC}`, { defaults: true, ...options });
    return process.exitCode;
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, silenced);
  }
}

const project = (workspace, relative = '') => path.join(workspace, 'services', `${SPEC}-spring`, relative);
const read = (workspace, relative) => fs.readFileSync(project(workspace, relative), 'utf8');
const exists = (workspace, relative) => fs.existsSync(project(workspace, relative));
const manifest = (workspace) => JSON.parse(read(workspace, 'keel-generated.json'));

/** Lo que haría el agente de código: completar los stubs. */
function completeHandlers(workspace) {
  for (const relative of [CREATE_HANDLER, GET_HANDLER]) {
    fs.appendFileSync(project(workspace, relative), '\n// completado por el agente\n');
  }
}

/** Lo que haría /keel-evolve: v1.1.0 sin getProduct, con countProducts y una regla de createProduct cambiada. */
function evolveDesign(workspace) {
  const dir = path.join(workspace, 'specs', SPEC);
  const file = (name) => path.join(dir, name);
  let useCases = fs.readFileSync(file('use-cases.keel.yaml'), 'utf8');
  useCases = useCases.replace(/ {2}getProduct:[\s\S]*?(?= {2}listProducts:)/, '');
  useCases = useCases.replace(
    'Verificar que el sku no existe antes de crear.',
    'Verificar que el sku no existe antes de crear, sin distinguir mayúsculas.'
  );
  useCases += [
    '  countProducts:',
    '    description: Cuenta los productos del catálogo.',
    '    kind: query',
    '    input: "void"',
    '    output:',
    '      fields:',
    '        total:',
    '          type: long',
    '          required: true',
    ''
  ].join('\n');
  fs.writeFileSync(file('use-cases.keel.yaml'), useCases);
  const bump = (name, from, to) => fs.writeFileSync(file(name), fs.readFileSync(file(name), 'utf8').replaceAll(from, to));
  bump('service.keel.yaml', 'version: 1.0.0', 'version: 1.1.0');
  // Cambiar createProduct caduca lo aceptado en v1.0.0: una evolución lo reafirma.
  bump('decisions.yaml', 'since: 1.0.0', 'since: 1.1.0');
}

test('la primera generación no deja EVOLUTION.md: todo es nuevo y el pipeline ya lo sabe', async () => {
  const workspace = withFixture();
  assert.equal(await runBuild(workspace), undefined);
  assert.equal(exists(workspace, EVOLUTION), false);
  // Y un segundo build sin cambios tampoco: no hay nada que evolucionar.
  assert.equal(await runBuild(workspace), undefined);
  assert.equal(exists(workspace, EVOLUTION), false);
  assert.equal(await runBuild(workspace, { check: true }), undefined);
});

test('--prune sin --refresh se rechaza', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  assert.equal(await runBuild(workspace, { prune: true }), 1);
});

test('--refresh --prune sobre un diseño evolucionado: el circuito entero', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  completeHandlers(workspace);
  const completado = read(workspace, CREATE_HANDLER);
  evolveDesign(workspace);

  assert.equal(await runBuild(workspace, { refresh: true, prune: true }), undefined);

  // Lo nuevo existe.
  assert.ok(exists(workspace, COUNT_HANDLER), 'no se generó el stub de la operación nueva');

  // Huérfanos: lo intacto se va; lo que el agente completó se queda para él.
  assert.equal(exists(workspace, GET_QUERY), false, 'un huérfano intacto sobrevivió a --prune');
  assert.equal(exists(workspace, GET_DTO), false, 'un huérfano intacto sobrevivió a --prune');
  assert.ok(exists(workspace, GET_HANDLER), '--prune borró trabajo del agente');

  // El conflicto: no se toca, su versión nueva queda fuera de src/ y entra en pendingMerge.
  assert.equal(read(workspace, CREATE_HANDLER), completado, 'el refresco pisó el handler completado');
  assert.ok(exists(workspace, `build/keel-refresh/${CREATE_HANDLER}`), 'no se dejó la versión nueva del conflicto');
  assert.ok(manifest(workspace).pendingMerge?.[CREATE_HANDLER], 'el conflicto no quedó en pendingMerge');

  // El traspaso al pipeline nombra las tres cosas y el delta.
  const evolution = read(workspace, EVOLUTION);
  assert.match(evolution, /v1\.0\.0 → v1\.1\.0/);
  assert.ok(evolution.includes(CREATE_HANDLER), 'EVOLUTION.md no nombra la fusión pendiente');
  assert.ok(evolution.includes(GET_HANDLER), 'EVOLUTION.md no nombra el huérfano a retirar');
  assert.ok(evolution.includes(COUNT_HANDLER), 'EVOLUTION.md no nombra el stub nuevo');
  assert.match(evolution, /añadidas `countProducts` · quitadas `getProduct` · cambiadas `createProduct`/);

  // Y --check lo ve: hay una evolución y una fusión sin cerrar.
  assert.equal(await runBuild(workspace, { check: true }), 1);
});

test('un segundo build antes de entrar al proyecto no pierde la evolución ni reabre el conflicto', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  completeHandlers(workspace);
  evolveDesign(workspace);
  await runBuild(workspace, { refresh: true, prune: true });
  const pendiente = manifest(workspace).pendingMerge[CREATE_HANDLER];

  // El snapshot ya está en v1.1.0: sin la base congelada, este build compararía el
  // diseño consigo mismo y borraría la evolución que el agente aún no ha hecho.
  assert.equal(await runBuild(workspace, { refresh: true, prune: true }), undefined);
  const evolution = read(workspace, EVOLUTION);
  assert.match(evolution, /quitadas `getProduct`/, 'la segunda pasada perdió el delta');
  assert.ok(evolution.includes(COUNT_HANDLER), 'la segunda pasada perdió el stub nuevo que aún tiene TODO');
  assert.equal(manifest(workspace).pendingMerge[CREATE_HANDLER], pendiente, 'la fusión pendiente cambió sin motivo');
});

test('cerrada la evolución por el orquestador, --check vuelve a verde', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  completeHandlers(workspace);
  evolveDesign(workspace);
  await runBuild(workspace, { refresh: true, prune: true });

  // Lo que hacen el agente y el orquestador: completar el stub nuevo, fusionar, retirar el
  // huérfano, vaciar pendingMerge y borrar build/keel-refresh/.
  fs.writeFileSync(project(workspace, COUNT_HANDLER), read(workspace, COUNT_HANDLER).replaceAll('TODO', 'HECHO'));
  fs.rmSync(project(workspace, GET_HANDLER));
  const cerrado = manifest(workspace);
  delete cerrado.pendingMerge;
  fs.writeFileSync(project(workspace, 'keel-generated.json'), JSON.stringify(cerrado, null, 2));
  fs.rmSync(project(workspace, 'build/keel-refresh'), { recursive: true, force: true });

  assert.equal(await runBuild(workspace, { check: true }), undefined);
  // El conflicto fusionado es ahora «tuyo»: un refresco no lo vuelve a sacar.
  assert.equal(await runBuild(workspace, { refresh: true }), undefined);
  assert.equal(exists(workspace, `build/keel-refresh/${CREATE_HANDLER}`), false, 'el conflicto se reabrió');
  // Y el huérfano que el agente retiró se olvida: si no, el manifiesto lo arrastra para
  // siempre y cada build lo reporta como «el generador ya no lo emite» sobre algo que no está.
  assert.ok(!(GET_HANDLER in manifest(workspace).files), 'el manifiesto sigue registrando un huérfano que ya no existe');
});

test('stack: lo que el diseño empieza a pedir se pregunta (solo eso) y lo que deja de pedir se anula', async () => {
  const layers = { persistence: {}, messaging: {} };
  const persisted = { group: 'com.example', database: 'postgresql', broker: null, auth: null, cache: null, storage: 'minio' };
  assert.deepEqual(stackDrift(persisted, layers), { missing: ['broker'], stale: ['storage'] });

  const answers = await askStackConfig({ service: { name: 'demo' } }, layers, { defaults: true, only: ['broker'] });
  assert.equal(answers.broker, STACK_DEFAULTS.broker);
  assert.equal(answers.group, null, 'con only no se vuelve a preguntar el grupo');
  assert.equal(answers.database, null, 'con only no se vuelve a preguntar lo ya elegido');
});
