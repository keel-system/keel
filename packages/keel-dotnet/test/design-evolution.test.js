// Evolucionar un proyecto YA completado cuando cambia su diseño, sin regenerarlo desde cero
// (incremento 15). Es el mismo circuito que el design-evolution.test.js de keel-spring y de keel-nest,
// sobre la misma fixture y la misma evolución, porque la lógica es la MISMA (keel-core/gen/evolution.js):
// el agente completa dos handlers, el diseño quita una operación (una de las completadas), añade
// otra y cambia una regla de la otra completada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/commands/build.js';
import { build as buildSpring } from '../../keel-spring/src/commands/build.js';
import { build as buildNest } from '../../keel-nest/src/commands/build.js';
import { schemaStepSql } from '@keel-system/keel-core/gen/schema-steps';
import { generatorTables, migrationsDir, schemaSteps, stepTimestamp } from '../src/scaffold/schema-baseline.js';
import { makeWorkspace, mountDesign, planFixture, runCommand } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const SPEC = 'product-catalog';
const rel = (...parts) => ['src', 'ProductCatalog.Application', ...parts].join('/');

const CREATE_HANDLER = rel('UseCases', 'CreateProductCommandHandler.cs');
const GET_HANDLER = rel('UseCases', 'GetProductQueryHandler.cs');
const GET_QUERY = rel('Queries', 'GetProductQuery.cs');
const GET_DTO = rel('Dtos', 'GetProductResponseDto.cs');
const COUNT_HANDLER = rel('UseCases', 'CountProductsQueryHandler.cs');
const EVOLUTION = 'build/keel-refresh/EVOLUTION.md';

function withFixture() {
  const workspace = makeWorkspace('keel-dotnet-evolution-');
  mountDesign(workspace, SPEC);
  return workspace;
}

async function runBuild(workspace, options = {}, command = build) {
  // Diseño parcial a propósito: la puerta de «diseño listo» la prueba build.test.js.
  const { exitCode } = await runCommand(workspace, command, `specs/${SPEC}`, { defaults: true, acceptUnready: true, ...options });
  return exitCode;
}

const project = (workspace, relative = '', tech = 'dotnet') => path.join(workspace, 'services', `${SPEC}-${tech}`, relative);
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
  assert.match(evolution, /`keel-dotnet build` y lo consume `\/keel-generate-dotnet`/);
  assert.match(evolution, /su id en `tests\/`/);
  assert.match(evolution, /`keel-dotnet build --check` sale en rojo/);
  assert.doesNotMatch(
    evolution,
    /gradle|integrationTest|@Component|keel-spring|keel-nest|test\/integration/i,
    'EVOLUTION.md habla de otra plataforma'
  );

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
// diseño produce el MISMO delta con los tres generadores; solo cambian las rutas y los textos de cada
// plataforma.
test('paridad con keel-spring y keel-nest: el mismo cambio del diseño, el mismo delta y las mismas secciones', async () => {
  const workspace = withFixture();
  const generators = { dotnet: build, spring: buildSpring, nest: buildNest };
  for (const command of Object.values(generators)) await runBuild(workspace, {}, command);
  evolveDesign(workspace);
  for (const command of Object.values(generators)) await runBuild(workspace, { refresh: true, prune: true }, command);

  const stateOf = (tech) => JSON.parse(read(workspace, 'build/keel-refresh/evolution.json', tech));
  const headings = (tech) => read(workspace, EVOLUTION, tech).split('\n').filter((line) => line.startsWith('## '));
  const dotnet = stateOf('dotnet');
  for (const tech of ['spring', 'nest']) {
    const other = stateOf(tech);
    assert.deepEqual(dotnet.delta, other.delta, `el delta del diseño difiere de keel-${tech}`);
    assert.deepEqual([dotnet.from, dotnet.to], [other.from, other.to]);
    assert.deepEqual(dotnet.stack, other.stack);
    assert.deepEqual(headings('dotnet'), headings(tech));
  }
});

// ─── Los pasos de esquema de build (inc. 2b del plan 2.26) ───────────────────────────────────
//
// Una tabla del generador que una base ya desplegada no tiene llega como una migración de EF que escribe build
// (keel-core/gen/schema-steps.js, src/scaffold/schema-baseline.js). `product-catalog` emite `idempotency_record` y, desde el
// inc. 7 del plan 2.26, `keel_timer` (la purga del registro corre en el cronómetro); el baseline «desplegado» de la prueba
// no crea ninguna, como el de un proyecto completado antes de que el diseño ganara la
// idempotencia. Lo propio de EF: el ModelSnapshot, que solo escribe `dotnet ef`, también tiene que nombrarla.

const MIGRATIONS = 'src/ProductCatalog.Infrastructure/Persistence/Migrations';
const BASELINE_MIGRATION = `${MIGRATIONS}/20261001120000_Baseline.cs`;
const SNAPSHOT = `${MIGRATIONS}/ProductCatalogDbContextModelSnapshot.cs`;
const STEP = `${MIGRATIONS}/20261002090001_KeelIdempotencyRecordTimer.cs`;
const efCreate = (table) => `migrationBuilder.CreateTable(\n                name: "${table}",\n                columns: table => new { });\n`;
const keelSteps = (workspace, tech = 'dotnet', dir = MIGRATIONS) =>
  fs.readdirSync(project(workspace, dir, tech)).filter((name) => /_Keel|__keel_/.test(name));

/** Lo que dejó el pase de calidad: el baseline de `dotnet ef` y su snapshot, sin la tabla del generador. */
function deployBaseline(workspace, ...created) {
  const tables = created.length > 0 ? created : ['products'];
  fs.mkdirSync(project(workspace, MIGRATIONS), { recursive: true });
  fs.writeFileSync(project(workspace, BASELINE_MIGRATION), tables.map(efCreate).join(''));
  fs.writeFileSync(project(workspace, SNAPSHOT), tables.map((table) => `b.ToTable("${table}", (string)null);\n`).join(''));
}

/** El SQL de un paso de EF: las sentencias de sus `migrationBuilder.Sql(@"…")`, unidas como las da `schemaStepSql`. */
const stepSql = (content) =>
  [...content.matchAll(/migrationBuilder\.Sql\(@"([\s\S]*?)"\);/g)].map((match) => match[1].replaceAll('""', '"')).join('\n\n') + '\n';

test('pasos de esquema: sin baseline no hay paso; con él, build escribe el de la tabla que falta tras los del agente', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  assert.equal(fs.existsSync(project(workspace, MIGRATIONS)), false, 'sin migraciones, build no escribe ninguna');

  // El agente creó el baseline y una migración suya; la base desplegada las aplicó.
  deployBaseline(workspace);
  fs.writeFileSync(project(workspace, `${MIGRATIONS}/20261002090000_AddProductSkuIndex.cs`), 'migrationBuilder.CreateIndex(name: "ix", table: "products", column: "id");\n');
  fs.writeFileSync(project(workspace, `${MIGRATIONS}/20261002090000_AddProductSkuIndex.Designer.cs`), '// modelo de destino\n');
  await runBuild(workspace, { refresh: true });
  const step = read(workspace, STEP);
  assert.match(step, /^\/\/ keel:generator-step idempotency_record keel_timer\n/);
  assert.match(step, /namespace ProductCatalog\.Infrastructure\.Persistence\.Migrations;/);
  assert.match(step, /\[DbContext\(typeof\(ProductCatalogDbContext\)\)\]\n\[Migration\("20261002090001_KeelIdempotencyRecordTimer"\)\]\npublic partial class KeelIdempotencyRecordTimer : Migration/);
  assert.match(step, /CREATE TABLE IF NOT EXISTS idempotency_record \([\s\S]*PRIMARY KEY \(operation_scope, idempotency_key\)/);
  assert.match(step, /migrationBuilder\.Sql\(@"CREATE INDEX IF NOT EXISTS ix_idempotency_record_expires_at ON idempotency_record \(expires_at\);"\);/);
  assert.ok(manifest(workspace).files[STEP], 'el paso es de build: va en el manifiesto');

  // El snapshot no la nombra: EVOLUTION.md lo pide al agente y --check sale en rojo.
  assert.match(read(workspace, EVOLUTION), /ModelSnapshot de EF no recoge `idempotency_record`, `keel_timer`[\s\S]*dotnet ef migrations add SyncIdempotencyRecordTimerSnapshot/);
  assert.equal(await runBuild(workspace, { check: true }), 1, '--check en rojo mientras el snapshot no la recoja');

  // El agente sincronizó el snapshot. El segundo build no escribe otro paso ni el mismo con otra marca: lo vuelve a emitir
  // tal cual, así que no queda huérfano, y --check vuelve a verde.
  fs.appendFileSync(project(workspace, SNAPSHOT), 'b.ToTable("idempotency_record", (string)null);\nb.ToTable("keel_timer", (string)null);\n');
  fs.writeFileSync(project(workspace, `${MIGRATIONS}/20261103100000_SyncIdempotencyRecordTimerSnapshot.cs`), '// Up y Down vacíos\n');
  await runBuild(workspace, { refresh: true });
  assert.deepEqual(keelSteps(workspace), ['20261002090001_KeelIdempotencyRecordTimer.cs']);
  assert.equal(read(workspace, STEP), step);
  assert.equal(await runBuild(workspace, { check: true }), undefined, '--check en verde: el paso y el snapshot están al día');
});

test('pasos de esquema: un baseline que ya crea la tabla no recibe paso, y el paso no se reescribe aunque cambie', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  deployBaseline(workspace, 'idempotency_record', 'keel_timer');
  await runBuild(workspace, { refresh: true });
  assert.deepEqual(keelSteps(workspace), []);

  // Una migración que ya se aplicó no cambia nunca: EF no la vuelve a leer en una base que la tiene en su historial.
  deployBaseline(workspace);
  await runBuild(workspace, { refresh: true });
  const stepPath = `${MIGRATIONS}/20261001120001_KeelIdempotencyRecordTimer.cs`;
  const applied = `${read(workspace, stepPath)}// aplicado con otro generador\n`;
  fs.writeFileSync(project(workspace, stepPath), applied);
  await runBuild(workspace, { refresh: true });
  assert.equal(read(workspace, stepPath), applied);
});

test('pasos de esquema: con evolución pendiente, EVOLUTION.md dice qué paso escribió build', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  completeHandlers(workspace);
  deployBaseline(workspace);
  evolveDesign(workspace);
  await runBuild(workspace, { refresh: true, prune: true });
  const md = read(workspace, EVOLUTION);
  assert.match(md, /## Pasos de esquema de build[\s\S]*20261001120001_KeelIdempotencyRecordTimer\.cs/);
  // Un segundo build antes de entrar al proyecto ya no lo ve nuevo, pero lo arrastra.
  await runBuild(workspace, { refresh: true, prune: true });
  assert.match(read(workspace, EVOLUTION), /20261001120001_KeelIdempotencyRecordTimer\.cs/);
});

test('pasos de esquema: la marca suma un segundo en el calendario, no en el entero', () => {
  assert.equal(stepTimestamp(20261002090000 + 1), '20261002090001');
  assert.equal(stepTimestamp(20261231235959 + 1), '20270101000000');
  assert.equal(stepTimestamp(20260228235959 + 1), '20260301000000');
  // Una marca de disco que no es una fecha se respeta como número: sigue siendo mayor por texto.
  assert.equal(stepTimestamp(20269999999999 + 1), '20270000000000');
});

// La promesa del 2b: los cuatro servidores dejan el MISMO esquema. Con la misma fixture y la misma base desplegada, el paso
// de keel-dotnet crea las tablas del de keel-spring con el mismo SQL, byte a byte; y en MySQL, el de schemaStepSql.
test('pasos de esquema: paridad con keel-spring, las mismas tablas y el mismo SQL', async () => {
  const workspace = withFixture();
  await runBuild(workspace);
  await runBuild(workspace, {}, buildSpring);
  deployBaseline(workspace);
  const springMigrations = 'src/main/resources/db/migration';
  fs.writeFileSync(project(workspace, `${springMigrations}/V1__baseline_schema.sql`, 'spring'), 'create table products (id uuid not null, primary key (id));\n');
  await runBuild(workspace, { refresh: true });
  await runBuild(workspace, { refresh: true }, buildSpring);
  const [springStep] = keelSteps(workspace, 'spring', springMigrations);
  const spring = read(workspace, `${springMigrations}/${springStep}`, 'spring');
  const dotnet = read(workspace, `${MIGRATIONS}/20261001120001_KeelIdempotencyRecordTimer.cs`);
  const mark = (content, comment) => content.split('\n')[0].slice(comment.length);
  assert.equal(mark(dotnet, '// '), mark(spring, '-- '), 'la misma marca, con las mismas tablas');
  assert.equal(stepSql(dotnet), spring.slice(spring.indexOf('\n\n') + 2), 'el mismo SQL que el paso de Flyway');

  // MySQL, sobre los archivos del plan: el SQL es el de schemaStepSql para las tablas que emite el proyecto.
  const { model, files } = await planFixture('catalog-extended', { stack: { database: 'mysql', broker: 'rabbitmq' } });
  const dir = tmpDir('keel-dotnet-steps-');
  fs.mkdirSync(path.join(dir, migrationsDir(model)), { recursive: true });
  fs.writeFileSync(path.join(dir, migrationsDir(model), '20261001120000_Baseline.cs'), efCreate('products'));
  const steps = schemaSteps(model, files, dir);
  const tables = generatorTables(files);
  assert.deepEqual(tables.map((table) => table.table), ['outbox_event', 'processed_event', 'idempotency_record', 'reconciliation_claim', 'keel_timer']);
  assert.equal(steps.added.length, 1);
  assert.equal(stepSql(steps.files[0].content), schemaStepSql('mysql', tables));
  assert.match(steps.files[0].path, /\/20261001120001_KeelOutboxEventProcessedEventIdempotencyRecordReconciliationClaimTimer\.cs$/);
});
