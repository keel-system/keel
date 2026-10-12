// Evolucionar un proyecto YA completado cuando cambia su diseño, sin regenerarlo desde cero
// (incremento 15). Es el mismo circuito que keel-spring/test/design-evolution.test.js, sobre la
// misma fixture y la misma evolución, porque la lógica es la MISMA (keel-core/gen/evolution.js):
// el agente completa dos handlers, el diseño quita una operación (una de las completadas), añade
// otra y cambia una regla de la otra completada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/commands/build.js';
import { build as buildSpring } from '../../keel-spring/src/commands/build.js';
import { makeWorkspace, mountDesign, runCommand } from './helpers/workspace.js';

const SPEC = 'product-catalog';
const rel = (...parts) => ['src', 'application', ...parts].join('/');

const CREATE_HANDLER = rel('usecases', 'create-product-command-handler.ts');
const GET_HANDLER = rel('usecases', 'get-product-query-handler.ts');
const GET_QUERY = rel('queries', 'get-product-query.ts');
const GET_DTO = rel('dtos', 'get-product-response-dto.ts');
const COUNT_HANDLER = rel('usecases', 'count-products-query-handler.ts');
const EVOLUTION = 'build/keel-refresh/EVOLUTION.md';

function withFixture() {
  const workspace = makeWorkspace('keel-nest-evolution-');
  mountDesign(workspace, SPEC);
  return workspace;
}

async function runBuild(workspace, options = {}, command = build) {
  // Diseño parcial a propósito: la puerta de «diseño listo» la prueba build.test.js.
  const { exitCode } = await runCommand(workspace, command, `specs/${SPEC}`, { defaults: true, acceptUnready: true, ...options });
  return exitCode;
}

const project = (workspace, relative = '', tech = 'nest') => path.join(workspace, 'services', `${SPEC}-${tech}`, relative);
const read = (workspace, relative, tech) => fs.readFileSync(project(workspace, relative, tech), 'utf8');
const exists = (workspace, relative) => fs.existsSync(project(workspace, relative));
const manifest = (workspace) => JSON.parse(read(workspace, 'keel-generated.json'));

/** Lo que haría el agente de código: completar los stubs. */
function completeHandlers(workspace) {
  for (const relative of [CREATE_HANDLER, GET_HANDLER]) {
    fs.appendFileSync(project(workspace, relative), '\n// completado por el agente\n');
  }
}

/** Lo que haría /keel-evolve: la versión siguiente sin getProduct, con countProducts y una regla de createProduct cambiada. */
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
  bump('service.keel.yaml', 'version: 1.1.0', 'version: 1.2.0');
  // Cambiar createProduct caduca lo aceptado en v1.1.0: una evolución lo reafirma.
  bump('decisions.yaml', 'since: 1.1.0', 'since: 1.2.0');
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

  // El traspaso al pipeline nombra las tres cosas, el delta y su plataforma.
  const evolution = read(workspace, EVOLUTION);
  assert.match(evolution, /v1\.1\.0 → v1\.2\.0/);
  assert.ok(evolution.includes(CREATE_HANDLER), 'EVOLUTION.md no nombra la fusión pendiente');
  assert.ok(evolution.includes(GET_HANDLER), 'EVOLUTION.md no nombra el huérfano a retirar');
  assert.ok(evolution.includes(COUNT_HANDLER), 'EVOLUTION.md no nombra el stub nuevo');
  assert.match(evolution, /añadidas `countProducts` · quitadas `getProduct` · cambiadas `createProduct`/);
  assert.match(evolution, /`keel-nest build` y lo consume `\/keel-generate-nest`/);
  assert.match(evolution, /`test\/integration\/`/);
  assert.match(evolution, /`keel-nest build --check` sale en rojo/);
  assert.doesNotMatch(evolution, /gradle|integrationTest|@Component|keel-spring/i, 'EVOLUTION.md habla de la plataforma Spring');

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

  // El snapshot ya está en v1.2.0: sin la base congelada, este build compararía el
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
  // Y el huérfano que el agente retiró se olvida.
  assert.ok(!(GET_HANDLER in manifest(workspace).files), 'el manifiesto sigue registrando un huérfano que ya no existe');
});

test('una capa nueva en el diseño pregunta su tecnología y llega a EVOLUTION.md como cambio de stack', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  const stackFile = project(workspace, 'keel-stack.json');
  // Un stack persistido al que le falta una categoría que el diseño pide: es lo que deja una capa
  // nueva (la base de datos de la persistencia, aquí) en un proyecto que ya existía.
  const stack = JSON.parse(fs.readFileSync(stackFile, 'utf8'));
  const database = stack.database;
  assert.ok(database, 'product-catalog persiste: el stack tiene base de datos');
  fs.writeFileSync(stackFile, JSON.stringify({ ...stack, database: null }, null, 2));

  // --check no pregunta ni escribe, pero lo cuenta y sale en rojo.
  assert.equal(await runBuild(workspace, { check: true }), 1);
  assert.equal(JSON.parse(fs.readFileSync(stackFile, 'utf8')).database, null, '--check escribió el stack');

  assert.equal(await runBuild(workspace, { refresh: true }), undefined);
  assert.equal(JSON.parse(fs.readFileSync(stackFile, 'utf8')).database, database, 'no se preguntó la categoría nueva');
  const evolution = JSON.parse(read(workspace, 'build/keel-refresh/evolution.json'));
  assert.deepEqual(evolution.stack.added, [{ category: 'database', value: database }]);
  assert.match(read(workspace, EVOLUTION), new RegExp(`\`database\`: añadido → \`${database}\``));
});

// La promesa del incremento: la evolución la decide keel-core, así que el mismo cambio del mismo
// diseño produce el MISMO delta con los dos generadores; solo cambian las rutas y los textos de cada
// plataforma.
test('paridad con keel-spring: el mismo cambio del diseño, el mismo delta y las mismas secciones', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  await runBuild(workspace, {}, buildSpring);
  evolveDesign(workspace);
  await runBuild(workspace, { refresh: true, prune: true });
  await runBuild(workspace, { refresh: true, prune: true }, buildSpring);

  const stateOf = (tech) => JSON.parse(read(workspace, 'build/keel-refresh/evolution.json', tech));
  const nest = stateOf('nest');
  const spring = stateOf('spring');
  assert.deepEqual(nest.delta, spring.delta, 'el delta del diseño difiere entre generadores');
  assert.deepEqual([nest.from, nest.to], [spring.from, spring.to]);
  assert.deepEqual(nest.stack, spring.stack);

  const headings = (tech) => read(workspace, EVOLUTION, tech).split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(headings('nest'), headings('spring'));
  assert.match(read(workspace, EVOLUTION, 'spring'), /`src\/integrationTest\/`/);
});
