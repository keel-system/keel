// Evolucionar un proyecto YA completado cuando cambia su diseño, sin regenerarlo desde cero
// (incremento 15). Es el mismo circuito que el design-evolution.test.js de los otros tres, sobre la
// misma fixture y la misma evolución, porque la lógica es la MISMA (keel-core/gen/evolution.js): el
// agente completa dos handlers, el diseño quita una operación (una de las completadas), añade otra
// y cambia una regla de la otra completada. Lo propio de Go es la baseline de goose, al final.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/commands/build.js';
import { build as buildSpring } from '../../keel-spring/src/commands/build.js';
import { build as buildNest } from '../../keel-nest/src/commands/build.js';
import { build as buildDotnet } from '../../keel-dotnet/src/commands/build.js';
import { makeWorkspace, mountDesign, runCommand } from './helpers/workspace.js';

const SPEC = 'product-catalog';
const rel = (name) => `internal/application/${name}.go`;

const CREATE_HANDLER = rel('create_product_command_handler');
const GET_HANDLER = rel('get_product_query_handler');
const GET_QUERY = rel('get_product_query');
const GET_DTO = rel('get_product_response_dto');
const COUNT_HANDLER = rel('count_products_query_handler');
const EVOLUTION = 'build/keel-refresh/EVOLUTION.md';
const BASELINE = 'internal/infrastructure/postgres/migrations/00001_baseline.sql';

function withFixture() {
  const workspace = makeWorkspace('keel-go-evolution-');
  mountDesign(workspace, SPEC);
  return workspace;
}

async function runBuild(workspace, options = {}, command = build) {
  // Diseño parcial a propósito: la puerta de «diseño listo» la prueba build.test.js.
  const { exitCode } = await runCommand(workspace, command, `specs/${SPEC}`, { defaults: true, acceptUnready: true, ...options });
  return exitCode;
}

const project = (workspace, relative = '', tech = 'go') => path.join(workspace, 'services', `${SPEC}-${tech}`, relative);
const read = (workspace, relative, tech) => fs.readFileSync(project(workspace, relative, tech), 'utf8');
const exists = (workspace, relative) => fs.existsSync(project(workspace, relative));
const manifest = (workspace) => JSON.parse(read(workspace, 'keel-generated.json'));

/** Lo que haría el agente de código: completar los stubs. */
function completeHandlers(workspace) {
  for (const relative of [CREATE_HANDLER, GET_HANDLER]) {
    fs.appendFileSync(project(workspace, relative), '\n// completado por el agente\n');
  }
}

const designFile = (workspace, name) => path.join(workspace, 'specs', SPEC, name);
const bump = (workspace, name, from, to) => {
  const file = designFile(workspace, name);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(from, to));
};
const nextVersion = (workspace) => {
  bump(workspace, 'service.keel.yaml', 'version: 1.1.0', 'version: 1.2.0');
  // Cambiar createProduct caduca lo aceptado en v1.1.0: una evolución lo reafirma.
  bump(workspace, 'decisions.yaml', 'since: 1.1.0', 'since: 1.2.0');
};

/** Lo que haría /keel-evolve: la versión siguiente sin getProduct, con countProducts y una regla de createProduct cambiada. */
function evolveDesign(workspace) {
  let useCases = fs.readFileSync(designFile(workspace, 'use-cases.keel.yaml'), 'utf8');
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
  fs.writeFileSync(designFile(workspace, 'use-cases.keel.yaml'), useCases);
  nextVersion(workspace);
}

/** Una evolución que SÍ cambia el esquema: un campo nuevo en la raíz. */
function evolveSchema(workspace) {
  bump(
    workspace,
    'domain.keel.yaml',
    '      sku:\n        type: SKU\n        required: true\n        unique: true\n',
    '      sku:\n        type: SKU\n        required: true\n        unique: true\n      weight:\n        type: int\n'
  );
  nextVersion(workspace);
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

  // El conflicto: no se toca, su versión nueva queda fuera de internal/ y entra en pendingMerge.
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
  assert.match(evolution, /`keel-go build` y lo consume `\/keel-generate-go`/);
  assert.match(evolution, /su id en `tests\/integration\/`/);
  assert.match(evolution, /`keel-go build --check` sale en rojo/);
  assert.doesNotMatch(
    evolution,
    /gradle|integrationTest|@Component|keel-spring|keel-nest|keel-dotnet|dotnet|test\/integration/i,
    'EVOLUTION.md habla de otra plataforma'
  );
  // Ni una operación tocó el esquema: nada que preguntar.
  assert.doesNotMatch(evolution, /El esquema cambió/);

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
// diseño produce el MISMO delta con los cuatro generadores; solo cambian las rutas y los textos de
// cada plataforma.
test('paridad con los otros tres: el mismo cambio del diseño, el mismo delta y las mismas secciones', async () => {
  const workspace = withFixture();
  const generators = { go: build, spring: buildSpring, nest: buildNest, dotnet: buildDotnet };
  for (const command of Object.values(generators)) await runBuild(workspace, {}, command);
  evolveDesign(workspace);
  for (const command of Object.values(generators)) await runBuild(workspace, { refresh: true, prune: true }, command);

  const stateOf = (tech) => JSON.parse(read(workspace, 'build/keel-refresh/evolution.json', tech));
  const headings = (tech) => read(workspace, EVOLUTION, tech).split('\n').filter((line) => line.startsWith('## '));
  const go = stateOf('go');
  for (const tech of ['spring', 'nest', 'dotnet']) {
    const other = stateOf(tech);
    assert.deepEqual(go.delta, other.delta, `el delta del diseño difiere de keel-${tech}`);
    assert.deepEqual([go.from, go.to], [other.from, other.to]);
    assert.deepEqual(go.stack, other.stack);
    assert.deepEqual(headings('go'), headings(tech));
  }
});

// Lo que no tiene ningún otro generador: la baseline la escribe build, y goose no reaplica una migración que su
// historial ya tiene. Sin el aviso, el servidor arranca contra una base desplegada y falla en la primera consulta.
test('un cambio de esquema reescribe la baseline y hace la pregunta, y un segundo build no la pierde', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  const anterior = read(workspace, BASELINE);
  evolveSchema(workspace);

  // --check lo dice sin escribir nada.
  await runBuild(workspace, { check: true });
  assert.equal(read(workspace, BASELINE), anterior, '--check escribió');

  await runBuild(workspace, { refresh: true, prune: true });
  assert.match(read(workspace, BASELINE), /weight/, 'la baseline no recogió la columna nueva');
  const avisa = (evolution) => {
    assert.match(evolution, /El esquema cambió/);
    assert.ok(evolution.includes(BASELINE), 'el aviso no nombra la baseline');
    assert.match(evolution, /alguna base desplegada/);
    assert.match(evolution, /reset-db\.sh --schema/);
    assert.match(evolution, /schema-evolution\.md/);
  };
  avisa(read(workspace, EVOLUTION));

  // El manifiesto ya registra la baseline nueva: esta pasada no ve el cambio, y el aviso tiene que seguir.
  await runBuild(workspace, { refresh: true, prune: true });
  avisa(read(workspace, EVOLUTION));
});

test('la rama de una base desplegada: la baseline restaurada no se pisa, y el aviso cambia de pregunta a instrucción', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  const desplegada = read(workspace, BASELINE);
  evolveSchema(workspace);
  await runBuild(workspace, { refresh: true, prune: true });

  // Lo que dice references/schema-evolution.md: devolver la baseline y escribir el paso.
  fs.writeFileSync(project(workspace, BASELINE), desplegada);
  const paso = BASELINE.replace('00001_baseline', '00002_add_product_weight');
  fs.writeFileSync(project(workspace, paso), '-- +goose Up\n-- +goose Down\n');
  fs.rmSync(project(workspace, 'build/keel-refresh'), { recursive: true, force: true });

  // Sin cambio de esquema: nadie la toca y no se avisa de nada, aunque difiera de lo que build emite.
  assert.equal(await runBuild(workspace, { refresh: true }), undefined);
  assert.equal(read(workspace, BASELINE), desplegada, 'el refresco pisó la baseline desplegada');
  assert.equal(exists(workspace, EVOLUTION), false, 'sin nada nuevo no hay nada que evolucionar');

  // Una evolución que no toca el esquema: la baseline del disco difiere de la que emite build, A PROPÓSITO, y eso
  // no es un cambio. Por eso se compara con lo que build registró.
  bump(workspace, 'use-cases.keel.yaml', 'Verificar que el sku no existe antes de crear.', 'Verificar que el sku no existe antes de crear ni de reactivar.');
  assert.equal(await runBuild(workspace, { refresh: true, prune: true }), undefined);
  assert.doesNotMatch(read(workspace, EVOLUTION), /El esquema cambió/, 'aviso falso: el esquema no cambió');
  fs.rmSync(project(workspace, 'build/keel-refresh'), { recursive: true, force: true });

  // Otro cambio de esquema: ya no se pregunta, y la versión nueva se queda al lado como referencia.
  bump(workspace, 'domain.keel.yaml', '      weight:\n        type: int\n', '      weight:\n        type: int\n      height:\n        type: int\n');
  bump(workspace, 'service.keel.yaml', 'version: 1.2.0', 'version: 1.3.0');
  bump(workspace, 'decisions.yaml', 'since: 1.2.0', 'since: 1.3.0');
  assert.equal(await runBuild(workspace, { refresh: true, prune: true }), undefined);

  assert.equal(read(workspace, BASELINE), desplegada, 'el refresco pisó la baseline desplegada');
  assert.match(read(workspace, `build/keel-refresh/${BASELINE}`), /height/, 'no se dejó la referencia del esquema nuevo');
  const evolution = read(workspace, EVOLUTION);
  assert.match(evolution, /ya migra por pasos/);
  assert.ok(evolution.includes('00002_add_product_weight.sql'), 'el aviso no nombra los pasos que hay');
  assert.match(evolution, /no se fusiona/);
  assert.doesNotMatch(evolution, /alguna base desplegada/, 'los archivos ya contestaron la pregunta');
  assert.ok(exists(workspace, paso), 'el paso del agente tiene que seguir ahí');
});

test('un diseño sin persistencia relacional no tiene baseline de la que avisar', async () => {
  const workspace = makeWorkspace('keel-go-evolution-');
  mountDesign(workspace, 'notification-mailer-mongo');
  const run = (options = {}) =>
    runCommand(workspace, build, 'specs/notification-mailer-mongo', { defaults: true, acceptUnready: true, ...options });
  await run();
  const file = path.join(workspace, 'specs', 'notification-mailer-mongo', 'service.keel.yaml');
  const text = fs.readFileSync(file, 'utf8');
  // Un patch: subir el minor caducaría lo aceptado en decisions.yaml, y la puerta rechazaría el diseño.
  const version = text.match(/version: (\d+)\.(\d+)\.(\d+)/);
  fs.writeFileSync(file, text.replace(version[0], `version: ${version[1]}.${version[2]}.${Number(version[3]) + 1}`));
  const useCases = path.join(workspace, 'specs', 'notification-mailer-mongo', 'use-cases.keel.yaml');
  fs.writeFileSync(useCases, fs.readFileSync(useCases, 'utf8').replace('Da de alta un sistema consumidor', 'Registra un sistema consumidor'));
  await run({ refresh: true, prune: true });
  const evolution = path.join(workspace, 'services', 'notification-mailer-mongo-go', EVOLUTION);
  assert.doesNotMatch(fs.readFileSync(evolution, 'utf8'), /El esquema cambió/);
});
