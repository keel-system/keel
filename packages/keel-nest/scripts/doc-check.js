#!/usr/bin/env node
// La persistencia DOCUMENTAL de keel-nest contra un MongoDB REAL (incremento 12): lo único que juzga si
// lo emitido sostiene lo que el diseño pidió. `ts-check` dice que compila; esto dice que el documento que
// escribe el adaptador es el del contrato (keel-core/gen/document.js, el mismo que escribe keel-spring)
// y que los índices, la transacción y la traducción de errores hacen lo que dicen.
//
// Sobre un MongoDB miembro de un replica set (en contenedor) y por sujeto (fixtures documentales):
//
//   conexión     la `DB_URL` de keel-spring vale tal cual: la opción que el driver de Node rechaza se quita;
//   índices      los vivos (listIndexes) contra keel-core/gen/document.js: nombre, claves en orden,
//                unicidad y filtro parcial; crearlos dos veces no falla;
//   documento    el documento CRUDO contra la forma neutral, campo a campo y a todo nivel (subdocumentos
//                e hijas anidadas): cada clave del contrato con su tipo BSON —uuid binario de subtipo 4,
//                decimal Decimal128 con su escala, fechas, Int64, el enum por su constante— y NINGUNA de
//                más (ni `_class` ni nada que el otro servidor no espere);
//   ida y vuelta el adaptador guarda un agregado entero y lo vuelve a leer igual;
//   versión      guardar dos veces la MISMA lectura: la segunda es un conflicto de concurrencia (409);
//   unicidad     la clave natural duplicada y el índice condicionado salen como el error del diseño;
//   carrera      dos transacciones que escriben el mismo documento: la segunda es un conflicto
//                TRANSITORIO (el que el mediator reintenta), no un 500;
//   auditoría    `created_at` no cambia al reescribir; `updated_at` sí;
//   página       list(pageable) con orden, desempate y total; deleteById borra el documento.
//
//   node packages/keel-nest/scripts/doc-check.js [--keep]
//   npm run doc-check --workspace packages/keel-nest
//
// Necesita podman o docker, y red la primera vez (npm instala el driver).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadService } from 'keel-core';
import { documentShape, documentValueObjects, valueObjectShape, documentIndexes, partialDocumentIndexSpecs } from 'keel-core/gen/document';
import { planService } from '../src/scaffold/index.js';
import { DB_NAME, run, resolveRuntime, startMongo, stopDatabase } from './lib/database-container.js';
import { sampleEntity, PROBE_HELPERS } from './lib/samples.js';
import { makeWorkspace, mountDesign, runCommand, FIXTURES_DIR, NEST_READY_DESIGN } from '../test/helpers/workspace.js';
import { JOSE_VERSION, MONGODB_VERSION } from '../src/lib/assets.js';
import { build } from '../src/commands/build.js';
import { classPath, DIRS } from '../src/scaffold/render.js';
import { repositoryRoots, adapterPath, adapterClass, naturalKeyFinder, occupantFinders } from '../src/scaffold/repositories.js';

const keep = process.argv.includes('--keep');
// Los sujetos y lo que cubre cada uno: hijas anidadas en dos niveles, un value object dentro de otro,
// fechas sin hora y listas de escalares (inspection-reports, sin su mensajería, que es del 12c); el
// reloj y la clave natural del barrido (job-dispatch-mongo); value objects en listas, sombras plegadas,
// índices condicionados y la auditoría de política (notification-mailer-mongo).
const SUBJECTS = [
  { name: 'inspection-reports', withoutLayers: ['messaging'] },
  { name: 'job-dispatch-mongo', withoutLayers: [] },
  { name: 'notification-mailer-mongo', withoutLayers: ['messaging', 'mail'] }
];
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const distOf = (file) => `./${file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')}`;

/** La forma esperada de cada documento y subdocumento, como datos que viajan a la sonda. */
function expectedShapes(model) {
  const entities = {};
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    entities[entity.name] = documentShape(model, entity).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      storage: entry.storage ?? null,
      valueObject: entry.valueObject ?? entry.element?.valueObject ?? null,
      entity: entry.entity ?? entry.element?.entity ?? null,
      elementStorage: entry.element?.storage ?? null,
      required: Boolean(entry.field?.required || entry.field?.isId || entry.kind === 'id' || entry.kind === 'version' || entry.kind === 'audit'),
      enumType: entry.field?.kind === 'enum' ? entry.field.namedType : null
    }));
  }
  const valueObjects = {};
  for (const vo of documentValueObjects(model)) {
    valueObjects[vo.name] = valueObjectShape(vo).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      storage: entry.storage ?? null,
      valueObject: entry.valueObject ?? null,
      required: Boolean(entry.field?.required),
      enumType: entry.field?.kind === 'enum' ? entry.field.namedType : null
    }));
  }
  return { entities, valueObjects };
}

function probeScript(model, db) {
  const roots = repositoryRoots(model);
  const ctx = { imports: new Set(), unsampled: [], nestedValueObjects: true };
  const blocks = roots.map((root, index) => rootBlock(model, root, index, ctx));
  const raceRoot = roots.find((root) => root.usesOptimisticLocking) ?? roots[0];
  const race = raceBlock(model, raceRoot, ctx);
  const shapes = expectedShapes(model);
  const enums = new Set([
    ...Object.values(shapes.entities).flat(),
    ...Object.values(shapes.valueObjects).flat()
  ].map((entry) => entry.enumType).filter(Boolean));
  for (const name of enums) ctx.imports.add(`${name}|${classPath(DIRS.enums, name)}`);
  const imports = [...ctx.imports].map((entry) => {
    const [symbol, file] = entry.split('|');
    return `import { ${symbol} } from '${distOf(file)}';`;
  });
  const adapters = roots.map((root) => `import { ${adapterClass(root)} } from '${distOf(adapterPath(root))}';`);
  const indexes = documentIndexes(model, []).map(({ collection, specs }) => ({
    collection,
    specs: specs.map((spec) => ({ name: spec.name, paths: spec.paths, unique: spec.unique, partialFilter: spec.partialFilter }))
  }));
  return {
    root: roots.map((root) => root.name).join(', '),
    unsampled: [...new Set(ctx.unsampled)],
    script: `import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Binary, Decimal128, MongoClient } from 'mongodb';
import { databaseSettings } from './dist/infrastructure/persistence/mongo-settings.js';
import { ensureDocumentIndexes } from './dist/infrastructure/persistence/document-indexes.js';
import { TransactionContext } from './dist/infrastructure/persistence/transaction-context.js';
import { translatePersistenceError, OptimisticLockConflict, isTransientWriteConflict } from './dist/infrastructure/persistence/persistence-errors.js';
${adapters.join('\n')}
${imports.join('\n')}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail) });
const UNORDERED = new Set([]);
const ENUMS = { ${[...enums].join(', ')} };
const SHAPES = ${JSON.stringify(shapes)};
const INDEXES = ${JSON.stringify(indexes)};

// ── Conexión: la URI de keel-spring tal cual.
const settings = databaseSettings({ get: (key) => ({ 'database.url': ${JSON.stringify(db.url)} })[key] });
check('la URI de keel-spring vale: se quita uuidRepresentation y se lee la base', !/uuidRepresentation/i.test(settings.url) && settings.database === '${DB_NAME}', settings.url);
const client = await new MongoClient(settings.url, { useBigInt64: true }).connect();
const database = client.db(settings.database);
await database.dropDatabase();
await ensureDocumentIndexes(database);
const tx = new TransactionContext(client, settings);

// ── Índices: los vivos contra los del contrato.
try {
  await ensureDocumentIndexes(database);
  check('crear los índices otra vez no falla (idempotente)', true);
} catch (error) {
  check('crear los índices otra vez no falla (idempotente)', false, error?.message);
}
for (const { collection, specs } of INDEXES) {
  const live = await database.collection(collection).listIndexes().toArray();
  const byName = new Map(live.map((index) => [index.name, index]));
  for (const spec of specs) {
    const got = byName.get(spec.name);
    if (!got) { check(\`\${collection}: índice \${spec.name}\`, false, [...byName.keys()].join(', ')); continue; }
    const problems = [];
    if (JSON.stringify(Object.keys(got.key)) !== JSON.stringify(spec.paths)) problems.push(\`claves \${JSON.stringify(got.key)}\`);
    if (Object.values(got.key).some((direction) => Number(direction) !== 1)) problems.push('dirección');
    if (Boolean(got.unique) !== spec.unique) problems.push(\`unique \${got.unique}\`);
    const filter = spec.partialFilter ? { [spec.partialFilter.path]: spec.partialFilter.equals } : undefined;
    if (JSON.stringify(got.partialFilterExpression) !== JSON.stringify(filter)) problems.push(\`filtro \${JSON.stringify(got.partialFilterExpression)}\`);
    check(\`\${collection}: índice \${spec.name} es el del contrato\`, problems.length === 0, problems.join(', '));
  }
}

${blocks.join('\n')}
${race}

await client.close();
console.log('@@RESULTS@@' + JSON.stringify(results));

/**
 * El documento crudo contra la forma del contrato, a todo nivel: cada clave con su tipo BSON y ninguna
 * de más. Devuelve las discrepancias.
 */
function shapeProblems(document, shape, at) {
  const problems = [];
  if (document == null || typeof document !== 'object') return [\`\${at}: no es un documento\`];
  const expected = new Set(shape.map((entry) => entry.name));
  for (const key of Object.keys(document)) if (!expected.has(key)) problems.push(\`\${at}.\${key}: clave que el contrato no tiene\`);
  for (const entry of shape) {
    const value = document[entry.name];
    const where = \`\${at}.\${entry.name}\`;
    if (!(entry.name in document)) { problems.push(\`\${where}: falta\`); continue; }
    if (value == null) { if (entry.required) problems.push(\`\${where}: null en un campo obligatorio\`); continue; }
    if (entry.kind === 'subdocument' && entry.valueObject) problems.push(...shapeProblems(value, SHAPES.valueObjects[entry.valueObject], where));
    else if (entry.kind === 'subdocument' && entry.entity) problems.push(...shapeProblems(value, SHAPES.entities[entry.entity], where));
    else if (entry.kind === 'array') {
      if (!Array.isArray(value)) { problems.push(\`\${where}: no es un array\`); continue; }
      value.forEach((element, i) => {
        if (entry.valueObject) problems.push(...shapeProblems(element, SHAPES.valueObjects[entry.valueObject], \`\${where}[\${i}]\`));
        else if (entry.entity) problems.push(...shapeProblems(element, SHAPES.entities[entry.entity], \`\${where}[\${i}]\`));
        else problems.push(...typeProblems(element, entry.elementStorage, null, \`\${where}[\${i}]\`));
      });
    } else problems.push(...typeProblems(value, entry.storage, entry.enumType, where));
  }
  return problems;
}

function typeProblems(value, storage, enumType, where) {
  const ok = {
    uuid: () => value instanceof Binary && value.sub_type === 4,
    decimal128: () => value instanceof Decimal128,
    date: () => value instanceof Date,
    long: () => typeof value === 'bigint',
    int: () => typeof value === 'number' && Number.isInteger(value),
    bool: () => typeof value === 'boolean',
    string: () => typeof value === 'string'
  }[storage];
  if (ok && !ok()) return [\`\${where}: \${value?.constructor?.name ?? typeof value} en vez de \${storage}\`];
  if (enumType && !(value in ENUMS[enumType])) return [\`\${where}: '\${value}' no es una constante de \${enumType}\`];
  return [];
}

${PROBE_HELPERS}
`
  };
}

/** La propiedad del dominio de un campo del diseño: una relación a otro agregado es `<relación>Id`. */
function memberOf(entity, field) {
  const relation = (entity.relations ?? []).find((candidate) => candidate.name === field && !candidate.internal);
  return relation ? `${field}Id` : field;
}

/** Lo que se comprueba de una raíz. */
function rootBlock(model, root, index, ctx) {
  const name = root.name;
  const first = sampleEntity(model, root, ctx, `${index}a`);
  const second = sampleEntity(model, root, ctx, `${index}b`);
  const finder = naturalKeyFinder(model, root);
  const paginated = model.services.some((group) => group.entity === root.name && group.operations.some((op) => op.paginated));
  const policyAudit = model.audit?.timestamps === 'all';
  const partial = partialDocumentIndexSpecs(model).find((spec) => spec.entity === root.name && !spec.when.field.includes('.'));
  const occupant = partial ? occupantFinders(model, root).find((candidate) => candidate.state === partial.when.equals) : null;
  const otherState = partial?.whenField?.kind === 'enum'
    ? model.enums.find((candidate) => candidate.name === partial.whenField.namedType)?.values.find((value) => value.literal !== partial.when.equals)?.literal
    : null;
  return `
// ═══ ${name} ═══
try {
  const repository = new ${adapterClass(root)}(tx);
  const collection = database.collection('${root.collectionName}');
  const original = ${first};
  await repository.save(original);
  const loaded = await repository.findById(original.id);
  check('${name}: findById devuelve lo que se guardó', loaded != null);
  const diff = differences(snapshot(original), snapshot(loaded));
  check('${name}: ida y vuelta sin perder nada (escala, uuid, fechas, enums, orden)', diff.length === 0, diff.slice(0, 6).join(' | '));
  const raw = await collection.findOne({});
  const problems = shapeProblems(raw, SHAPES.entities['${name}'], '${root.collectionName}');
  check('${name}: el documento crudo es el del contrato (claves, tipos BSON, nada de más)', problems.length === 0, problems.slice(0, 8).join(' | '));
${policyAudit ? `  const born = raw?.created_at;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await repository.save(loaded);
  const rewritten = await collection.findOne({ _id: raw._id });
  check('${name}: reescribir conserva created_at y mueve updated_at', born instanceof Date && rewritten?.created_at?.getTime() === born.getTime() && rewritten?.updated_at > raw.updated_at, JSON.stringify({ born, now: rewritten?.created_at }));
  const current = await repository.findById(original.id);` : '  const current = loaded;'}
${root.usesOptimisticLocking ? `  check('${name}: nace con la versión 0', loaded?.lockVersion === 0, loaded?.lockVersion);
  await repository.save(current);
  try {
    await repository.save(current);
    check('${name}: guardar una lectura obsoleta es un conflicto de concurrencia', false, 'se guardó');
  } catch (error) {
    const translated = translatePersistenceError(error);
    check('${name}: guardar una lectura obsoleta es un conflicto de concurrencia', error instanceof OptimisticLockConflict && translated?.httpStatus === 409, translated?.code ?? error?.message);
  }` : ''}
${finder ? `  const found = await repository.${finder.name}(${finder.params.map((param) => `original.${param.name}`).join(', ')});
  check('${name}: el finder de la clave natural encuentra el agregado', found?.id === original.id);
  const rival = ${second};
  const clash = new ${name}({ ...stateOf(rival), ${finder.params.map((param) => `${param.name}: original.${param.name}`).join(', ')} });
  try {
    await repository.save(clash);
    check('${name}: la clave natural duplicada la rechaza el motor', false, 'se guardó');
  } catch (error) {
    const translated = translatePersistenceError(error);
    check('${name}: la clave natural duplicada sale como el error del diseño', translated && translated !== 'integrity' && translated !== 'timeout' && translated.httpStatus === 409, translated?.code ?? translated ?? error?.message);
  }` : ''}
${partial && occupant && otherState ? `  // El índice condicionado (${partial.name}): la misma clave convive fuera del estado, no dentro.
  {
    const keyed = (sample, state) => new ${name}({ ...stateOf(sample), ${partial.fields.map((field) => `${memberOf(root, field)}: original.${memberOf(root, field)}`).join(', ')}, ${partial.when.field}: state });
    const a = keyed(${sampleEntity(model, root, ctx, `${index}p1`)}, ${JSON.stringify(partial.when.equals)});
    const b = keyed(${sampleEntity(model, root, ctx, `${index}p2`)}, ${JSON.stringify(otherState)});
    const c = keyed(${sampleEntity(model, root, ctx, `${index}p3`)}, ${JSON.stringify(partial.when.equals)});
    // Colección vacía: el original podría ocupar ya el índice con esa misma clave.
    await collection.deleteMany({});
    await repository.save(a);
    let bOk = true;
    try { await repository.save(b); } catch (error) { bOk = false; check('${name}: fuera del estado ${partial.when.equals} la clave se repite', false, error?.message); }
    if (bOk) check('${name}: fuera del estado ${partial.when.equals} la clave se repite', true);
    try {
      await repository.save(c);
      check('${name}: dentro del estado ${partial.when.equals} la clave repetida la rechaza ${partial.name}', false, 'se guardó');
    } catch (error) {
      const translated = translatePersistenceError(error);
      check('${name}: dentro del estado ${partial.when.equals} la clave repetida sale como el error del diseño', translated && translated !== 'integrity' && translated.httpStatus === 409, translated?.code ?? translated ?? error?.message);
    }
    const occupying = await repository.${occupant.name}(${occupant.params.map((param) => (param.name === partial.when.field ? JSON.stringify(partial.when.equals) : `a.${param.name}`)).join(', ')});
    check('${name}: el finder del índice condicionado encuentra al que lo ocupa', occupying?.id === a.id, occupying?.id);
  }` : ''}
${paginated ? `  const page = await repository.list({ page: 0, size: 5, sort: [{ property: 'id', direction: 'desc' }] });
  check('${name}: list devuelve la página con su total y en el orden pedido', page.totalElements >= 1 && page.items.length >= 1 && page.items.every((item, i, all) => i === 0 || String(all[i - 1].id) >= String(item.id)), JSON.stringify({ total: page.totalElements, n: page.items.length }));
  try {
    await repository.list({ page: 0, size: 5, sort: [{ property: 'noExiste', direction: 'asc' }] });
    check('${name}: ordenar por una propiedad que no existe es un error', false, 'ordenó');
  } catch {
    check('${name}: ordenar por una propiedad que no existe es un error', true);
  }` : ''}
  await repository.deleteById(original.id);
  check('${name}: deleteById borra el documento', (await repository.findById(original.id)) == null && (await collection.countDocuments({ _id: raw._id })) === 0);
} catch (error) {
  // Un fallo inesperado es una comprobación roja con su causa, no una sonda muerta sin resumen.
  check('${name}: la sonda recorre la raíz sin un error inesperado', false, String(error?.stack ?? error).slice(0, 400));
}`;
}

/**
 * Dos transacciones que escriben el MISMO documento: MongoDB no hace esperar a la segunda, la aborta con
 * un WriteConflict. Tiene que salir como conflicto TRANSITORIO —el que el mediator reintenta y, agotado,
 * es un 409—, nunca como un 500.
 */
function raceBlock(model, root, ctx) {
  if (!root) return '';
  return `
// ═══ Carrera: dos transacciones sobre el mismo documento ═══
try {
  const repository = new ${adapterClass(root)}(tx);
  const subject = ${sampleEntity(model, root, ctx, 'race')};
  await repository.save(subject);
  const collection = database.collection('${root.collectionName}');
  const raw = await collection.findOne({});
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const touch = (delay) => tx.inNewTransaction(async (session) => {
    await pause(delay);
    await collection.updateOne({ _id: raw._id }, { $set: { race_probe: delay } }, { session });
    await pause(300);
  });
  const outcomes = await Promise.allSettled([touch(0), touch(100)]);
  const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
  check('carrera: una de las dos transacciones pierde', failed.length === 1, outcomes.map((o) => o.status).join(', '));
  check('carrera: la que pierde es un conflicto TRANSITORIO (lo reintenta el mediator)', failed.length === 1 && isTransientWriteConflict(failed[0].reason), failed[0]?.reason?.message);
  await collection.deleteMany({});
} catch (error) {
  check('carrera: la sonda corre sin un error inesperado', false, error?.message ?? error);
}`;
}

// ─── Orquestación ────────────────────────────────────────────────────────────

const runtime = resolveRuntime();
if (!runtime) {
  console.error('No hay podman ni docker en marcha: este check los necesita; el resto de la suite no.');
  process.exit(2);
}

// Un proyecto real para el node_modules, que comparten todos los sujetos: el de referencia más el driver
// (los sujetos se renderizan con planService, sin la frontera de build: miden la persistencia).
const workspace = makeWorkspace('keel-nest-doc-check-');
mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${NEST_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);
if (!step('build genera el proyecto de referencia', generated.exitCode === undefined, generated.output.slice(0, 600))) process.exit(1);
// jose: la seguridad de los sujetos que la declaran (notification-mailer-mongo) también tiene que compilar.
const install = run('npm', ['install', '--no-audit', '--no-fund', `mongodb@${MONGODB_VERSION}`, `jose@${JOSE_VERSION}`], { cwd: projectDir });
if (!step('npm install (el driver de MongoDB)', install.status === 0, install.status === 0 ? '' : install.stderr.slice(-800))) process.exit(1);
const tsc = path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');

let db;
try {
  db = await startMongo(runtime);
  step('MongoDB arranca como primario de su replica set', true, `puerto ${db.port}`);
} catch (error) {
  step('MongoDB arranca como primario de su replica set', false, error.message);
  process.exit(1);
}
try {
  for (const subject of SUBJECTS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, subject.name));
    for (const layer of subject.withoutLayers) {
      delete manifest.layers[layer];
      delete layers[layer];
    }
    const { files, model } = planService({ manifest, layers, workspace, stack: { database: 'mongodb' } });
    if (repositoryRoots(model).length === 0) continue;
    const dir = path.join(workspace, 'doc-check', subject.name);
    for (const file of files) {
      const out = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, file.content);
    }
    fs.symlinkSync(path.join(projectDir, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    const compiled = run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: dir });
    if (!step(`${subject.name}: compila`, compiled.status === 0, compiled.stdout.slice(0, 1200))) continue;
    const probe = probeScript(model, db);
    fs.writeFileSync(path.join(dir, 'doc-probe.mjs'), probe.script);
    const result = run(process.execPath, ['doc-probe.mjs'], { cwd: dir, timeout: 180_000 });
    const marker = result.stdout.split('@@RESULTS@@')[1];
    if (!marker) {
      step(`${subject.name}: la sonda corre`, false, (result.stderr || result.stdout).slice(-3000));
      continue;
    }
    const checks = JSON.parse(marker);
    const failed = checks.filter((check) => !check.ok);
    for (const check of failed) console.log(`        ✘ ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    step(
      `${subject.name} (${probe.root}): índices, documento, ida y vuelta, versión, unicidad, carrera`,
      failed.length === 0,
      `${checks.length - failed.length}/${checks.length}${probe.unsampled.length > 0 ? `; sin muestra: ${probe.unsampled.join(', ')}` : ''}`
    );
  }
} finally {
  if (!keep) stopDatabase(runtime, db);
  else console.log(`(contenedor conservado: ${db.name}, puerto ${db.port})`);
}

if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-doc-check-'));
  fs.cpSync(path.join(workspace, 'doc-check'), kept, { recursive: true, filter: (source) => !source.includes('node_modules') });
  console.log(`Sujetos conservados en ${kept}`);
}
const failedSteps = results.filter((result) => !result.ok).length;
console.log(failedSteps === 0 ? `\ndoc-check: ${results.length}/${results.length} en verde.` : `\ndoc-check: ${failedSteps} paso(s) en rojo.`);
process.exit(failedSteps === 0 ? 0 : 1);
