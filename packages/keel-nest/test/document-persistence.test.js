// La persistencia DOCUMENTAL de keel-nest (incremento 12b), sin red: lo que emite build para las fixtures
// documentales, EJECUTADO con un sustituto del driver de MongoDB y una colección en memoria.
//
//   · el documento que escribe el adaptador es el de keel-core/gen/document.js —el que escribe
//     keel-spring—, a todo nivel y con el tipo BSON de cada valor, y se lee de vuelta sin perder nada;
//   · la versión va en el filtro: guardar una lectura obsoleta es un conflicto;
//   · los índices que crea el servidor al arrancar son los neutrales;
//   · la `DB_URL` de keel-spring vale tal cual (la URL de local es la MISMA);
//   · nada de TypeORM en un proyecto documental.
//
// Contra un MongoDB real (índices vivos, transacción, E11000, WriteConflict) lo mide `npm run doc-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { documentShape, documentValueObjects, valueObjectShape, documentIndexes } from 'keel-core/gen/document';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { sampleEntity, PROBE_HELPERS } from '../scripts/lib/samples.js';
import { repositoryRoots, adapterClass, adapterPath, emitsDomainEvents } from '../src/scaffold/repositories.js';
import { claimsForEntity } from 'keel-core/gen';
import { reconciliationClaims } from 'keel-core/gen/reconciliation-stores';

// Las fixtures documentales enteras, salvo el correo de notification-mailer-mongo (incremento 13).
const SUBJECTS = [
  { name: 'inspection-reports', withoutLayers: [] },
  { name: 'job-dispatch-mongo', withoutLayers: [] },
  { name: 'notification-mailer-mongo', withoutLayers: ['mail'] }
];

/** El stack de un sujeto: MongoDB y, con mensajería, RabbitMQ (los almacenes son los mismos con cualquiera). */
const stackOf = (name) => ({ database: 'mongodb', ...(loadService(path.join(FIXTURES_DIR, name)).layers.messaging ? { broker: 'rabbitmq' } : {}) });

/**
 * Los argumentos del adaptador de una raíz, en el orden de repositories.js (constructorOf): la transacción, el
 * puente si la raíz emite, la configuración de los barridos (y los parámetros de un rescate), y la tienda y los
 * números de la reconciliación. Aquí basta con que existan: se mide el mapeo.
 */
function adapterArgs(model, root, transactions) {
  const args = [transactions];
  if (emitsDomainEvents(model, root)) args.push({ publish: async () => {} });
  const claims = claimsForEntity(model, root.name);
  if (claims.length > 0) {
    args.push({ batchSize: {}, stalledAfterSeconds: {} });
    if (claims.some((claim) => claim.stalled?.parameter)) args.push({});
  }
  if (reconciliationClaims(model).some((claim) => claim.entity === root.name)) args.push({ claim: async () => true }, {});
  return args;
}

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { log() {} warn() {} error() {} }
`;

// Lo mínimo del driver para ejecutar el mapeo: los tipos BSON como clases reconocibles.
const MONGODB_STUB = `
export class Binary {
  constructor(hex, subType) { this.hex = hex; this.sub_type = subType; }
  toUUID() { return new UUID(this.hex); }
}
export class UUID extends Binary {
  constructor(hex) { super(hex, 4); }
  toHexString() { return this.hex; }
}
export class Decimal128 {
  constructor(text) { this.text = text; }
  static fromString(text) { return new Decimal128(text); }
  toString() { return this.text; }
}
export class MongoError extends Error { hasErrorLabel() { return false; } }
export class MongoServerError extends MongoError {}
export class MongoClient {}
`;

/** Una colección en memoria: lo que el adaptador escribe, tal cual, y los filtros por igualdad. */
function memoryCollection() {
  const documents = [];
  const key = (value) => (value?.hex ?? (typeof value === 'bigint' ? `${value}n` : JSON.stringify(value)));
  const matches = (document, filter) => Object.entries(filter).every(([field, value]) => key(document[field]) === key(value));
  return {
    documents,
    async findOne(filter) {
      return documents.find((document) => matches(document, filter)) ?? null;
    },
    async insertOne(document) {
      if (documents.some((existing) => key(existing._id) === key(document._id))) throw new Error('E11000 _id');
      documents.push({ ...document });
    },
    async updateOne(filter, update, options = {}) {
      const found = documents.find((document) => matches(document, filter));
      if (!found) {
        if (!options.upsert) return { matchedCount: 0 };
        documents.push({ ...filter, ...update.$setOnInsert, ...update.$set });
        return { matchedCount: 0, upsertedCount: 1 };
      }
      Object.assign(found, update.$set);
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      const index = documents.findIndex((document) => matches(document, filter));
      if (index >= 0) documents.splice(index, 1);
    }
  };
}

function fakeTransactions(collections) {
  return {
    active: false,
    session: () => undefined,
    collection: (name) => (collections[name] ??= memoryCollection()),
    inTransaction: (work) => work(undefined),
    afterCommit: async (callback) => callback()
  };
}

/** El documento contra la forma neutral, a todo nivel; devuelve las discrepancias. */
function shapeProblems(document, shape, shapes, at) {
  const problems = [];
  const expected = new Set(shape.map((entry) => entry.name));
  for (const keyName of Object.keys(document)) if (!expected.has(keyName)) problems.push(`${at}.${keyName}: de más`);
  for (const entry of shape) {
    const where = `${at}.${entry.name}`;
    if (!(entry.name in document)) {
      // La versión y la auditoría de política las pone save(); aquí se mira el documento guardado.
      problems.push(`${where}: falta`);
      continue;
    }
    const value = document[entry.name];
    if (value == null) continue;
    const element = entry.element ?? {};
    if (entry.kind === 'subdocument') problems.push(...shapeProblems(value, entry.valueObject ? shapes.vo[entry.valueObject] : shapes.entity[entry.entity], shapes, where));
    else if (entry.kind === 'array') {
      value.forEach((item, i) => {
        if (element.valueObject) problems.push(...shapeProblems(item, shapes.vo[element.valueObject], shapes, `${where}[${i}]`));
        else if (element.entity) problems.push(...shapeProblems(item, shapes.entity[element.entity], shapes, `${where}[${i}]`));
        else problems.push(...typeProblem(item, element.storage, `${where}[${i}]`));
      });
    } else problems.push(...typeProblem(value, entry.storage, where));
  }
  return problems;
}

function typeProblem(value, storage, where) {
  const ok = {
    uuid: () => value?.constructor?.name === 'UUID' && value.sub_type === 4,
    decimal128: () => value?.constructor?.name === 'Decimal128',
    date: () => value instanceof Date,
    long: () => typeof value === 'bigint',
    int: () => Number.isInteger(value),
    bool: () => typeof value === 'boolean',
    string: () => typeof value === 'string'
  }[storage];
  return ok && !ok() ? [`${where}: ${value?.constructor?.name ?? typeof value} en vez de ${storage}`] : [];
}

for (const subject of SUBJECTS) {
  const { files, model } = planFixture(subject.name, { withoutLayers: subject.withoutLayers, stack: stackOf(subject.name) });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));

  test(`${subject.name}: un proyecto documental lleva el driver y ni rastro de TypeORM`, () => {
    const pkg = JSON.parse(byPath['package.json']);
    assert.ok(pkg.dependencies.mongodb, 'depende del driver oficial');
    assert.equal(pkg.dependencies.typeorm, undefined);
    assert.ok(!files.some((file) => /\.orm-entity\.ts$|data-source-options\.ts$|migrations\//.test(file.path)), 'sin entidades ORM ni migraciones');
    for (const required of ['transaction-context', 'persistence-errors', 'persistence-module', 'document-indexes', 'bson-values', 'mongo-settings']) {
      assert.ok(byPath[`src/infrastructure/persistence/${required}.ts`], `emite ${required}.ts`);
    }
    assert.ok(byPath['infra/export-indexes.sh'], 'emite export-indexes.sh');
    assert.ok(!files.some((file) => file.content.includes("from 'typeorm'")), 'nada importa typeorm');
  });

  test(`${subject.name}: la DB_URL de local es la de keel-spring, y la del despliegue sin default en production`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, subject.name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR });
    const springLocal = parseYaml(spring.files.find((file) => file.path.endsWith('parameters/local/db.yaml')).content);
    const nest = (profile) => parseYaml(byPath[`config/parameters/${profile}/db.yaml`]).database;
    assert.equal(nest('local').url, springLocal.spring.data.mongodb.uri);
    assert.equal(nest('production').url, '${DB_URL}');
    assert.match(nest('develop').url, /^\$\{DB_URL:mongodb:\/\//);
    assert.equal(nest('test').enabled, false);
  });
}

test('la URI de keel-spring vale para el driver de Node: se quita solo uuidRepresentation', async () => {
  const { files } = planFixture('job-dispatch-mongo', { stack: { database: 'mongodb' } });
  const { load } = transpileTree(files);
  const { driverUrl, databaseOf } = await load('src/infrastructure/persistence/mongo-settings.ts');
  assert.equal(
    driverUrl('mongodb://u:p@localhost:27017/jobs?authSource=admin&directConnection=true&uuidRepresentation=standard'),
    'mongodb://u:p@localhost:27017/jobs?authSource=admin&directConnection=true'
  );
  assert.equal(driverUrl('mongodb://h/jobs?uuidRepresentation=standard'), 'mongodb://h/jobs');
  assert.equal(driverUrl('mongodb://h/jobs?replicaSet=rs0'), 'mongodb://h/jobs?replicaSet=rs0', 'lo demás no se toca');
  assert.equal(databaseOf('mongodb://u:p@db:27017/job_dispatch?replicaSet=rs0'), 'job_dispatch');
  assert.throws(() => driverUrl('jdbc:postgresql://h/x'), /no es una URI de MongoDB/);
  assert.throws(() => databaseOf('mongodb://h/'), /no nombra la base/);
});

for (const subject of SUBJECTS) {
  test(`${subject.name}: los índices que crea el servidor son los de keel-core/gen/document.js`, async () => {
    const { files, model } = planFixture(subject.name, { withoutLayers: subject.withoutLayers, stack: stackOf(subject.name) });
    const { load } = transpileTree(files);
    const { DOCUMENT_INDEXES } = await load('src/infrastructure/persistence/document-indexes.ts');
    const expected = documentIndexes(model, []).map(({ collection, specs }) => ({
      collection,
      indexes: specs.map((spec) => ({
        keys: Object.fromEntries(spec.paths.map((p) => [p, 1])),
        options: {
          name: spec.name,
          ...(spec.unique ? { unique: true } : {}),
          ...(spec.partialFilter ? { partialFilterExpression: { [spec.partialFilter.path]: spec.partialFilter.equals } } : {})
        }
      }))
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(DOCUMENT_INDEXES)), expected);
  });

  test(`${subject.name}: el adaptador escribe el documento del contrato y lo lee sin perder nada`, async () => {
    const { files, model } = planFixture(subject.name, { withoutLayers: subject.withoutLayers, stack: stackOf(subject.name) });
    const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB, mongodb: MONGODB_STUB } });
    const shapes = { entity: {}, vo: {} };
    for (const entity of model.entities.filter((e) => e.persisted)) shapes.entity[entity.name] = documentShape(model, entity);
    for (const vo of documentValueObjects(model)) shapes.vo[vo.name] = valueObjectShape(vo);
    const { OptimisticLockConflict } = await tree.load('src/infrastructure/persistence/persistence-errors.ts');
    for (const root of repositoryRoots(model)) {
      // La muestra, como un módulo del árbol transpilado: importa las clases del dominio emitido.
      const ctx = { imports: new Set(), unsampled: [], nestedValueObjects: true };
      const expression = sampleEntity(model, root, ctx, 'u');
      const imports = [...ctx.imports].map((entry) => {
        const [symbol, file] = entry.split('|');
        return `import { ${symbol} } from ${JSON.stringify(pathToFileURL(path.join(tree.root, file.replace(/\.ts$/, '.js'))).href)};`;
      });
      const sampleFile = path.join(tree.root, `sample-${root.name}.mjs`);
      fs.writeFileSync(sampleFile, `${imports.join('\n')}\nconst UNORDERED = new Set([]);\nexport const sample = () => ${expression};\n${PROBE_HELPERS}\nexport { snapshot, differences };\n`);
      const { sample, snapshot, differences } = await import(pathToFileURL(sampleFile).href);
      const { [adapterClass(root)]: Adapter } = await tree.load(adapterPath(root));
      const collections = {};
      const repository = new Adapter(...adapterArgs(model, root, fakeTransactions(collections)));
      const original = sample();
      await repository.save(original);
      const [stored] = collections[root.collectionName].documents;
      assert.deepEqual(shapeProblems(stored, shapes.entity[root.name], shapes, root.collectionName), [], `${root.name}: el documento es el del contrato`);
      const loaded = await repository.findById(original.id);
      assert.deepEqual(differences(snapshot(original), snapshot(loaded)), [], `${root.name}: ida y vuelta`);
      if (root.usesOptimisticLocking) {
        assert.equal(loaded.lockVersion, 0);
        await repository.save(loaded);
        await assert.rejects(repository.save(loaded), (error) => error instanceof OptimisticLockConflict, `${root.name}: la lectura obsoleta es un conflicto`);
      }
    }
  });
}
