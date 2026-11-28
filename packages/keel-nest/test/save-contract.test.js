// Dos defectos de la corrida payment-nest (2026-11-27), los dos en el save de la raíz:
//
//  · el RELEVO de un índice único condicionado sobre una HIJA (keel-core/test/helpers/child-conditional-designs.js): el
//    agregado se guarda con UN save en cascada y TypeORM inserta la hija nueva antes de actualizar las que ya existían,
//    así que cambiar la preferente moría con el error de unicidad (FL-MTH-003). El adaptador baja antes la condición de
//    lo que sale de ella;
//  · el save que ABRE su transacción (un handler despachado sin ella) devuelve ya el error del diseño (`translate:
//    asContractError`),
//    como keel-dotnet y keel-go, para que el handler capture la carrera perdida sin añadir métodos al puerto (el agente
//    escribió `trySave`). Unido a una transacción abierta no traduce nada: lo que ven los listeners no cambia.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILD_CONDITIONAL_DESIGNS } from '../../keel-core/test/helpers/child-conditional-designs.js';
import { planFixture, transpileTree } from './helpers/emitted.js';

const design = CHILD_CONDITIONAL_DESIGNS[0];
const fileOf = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';
const ADAPTER = 'repositories/template-repository-impl.ts';

test('relevo: la hija que sale de la condición la deja en la base ANTES del save en cascada', () => {
  const { files } = planFixture(design.from, { mutate: design.mutate });
  const adapter = fileOf(files, ADAPTER);
  const relief = adapter.indexOf('for (const child of orm.variables ?? [])');
  assert.ok(relief > 0, 'el save recorre las hijas antes de guardar');
  assert.match(adapter, /if \(child\.isPrimary === true\) continue;\n {8}await manager\.createQueryBuilder\(\)\.update\(TemplateVariableOrm\)\.set\(\{ isPrimary: child\.isPrimary \}\)\.where\(\{ id: child\.id, isPrimary: true \}\)\.execute\(\);/);
  assert.ok(relief < adapter.indexOf('await manager.save(TemplateOrm, orm)'), 'antes del save en cascada');
  // Después de leer lo que había para el historial: si no, el «antes» ya vendría relevado.
  const history = adapter.indexOf('const historyRow');
  if (history > 0) assert.ok(history < relief);
});

test('relevo: un índice condicionado sobre la RAÍZ, o el documento, no lo llevan', () => {
  // notification-mailer tiene su índice condicionado en Template (la raíz): ahí releva el handler, con su nota.
  assert.doesNotMatch(fileOf(planFixture('notification-mailer').files, ADAPTER), /Relevo del índice único condicionado/);
  // En el documento el agregado es UNA escritura: no hay orden que forzar.
  const mongo = planFixture(design.from, { mutate: design.mutate, stack: { database: 'mongodb' } }).files;
  assert.doesNotMatch(mongo.map((file) => file.content).join('\n'), /Relevo del índice único condicionado/);
});

test('el save de la raíz pide el error del diseño a la transacción que abre, en los dos modelos', () => {
  for (const database of ['postgresql', 'mongodb']) {
    const { files } = planFixture(design.from, { mutate: design.mutate, stack: { database } });
    assert.match(fileOf(files, ADAPTER), /async save\(entity: Template\)[\s\S]*?\n {4}\}, \{ translate: asContractError \}\);\n {2}\}/, database);
  }
});

const NEST_STUB = `export const Inject = () => () => {};
export const Injectable = () => (target) => target;
export class Logger { error() {} warn() {} debug() {} log() {} }`;

const DUPLICATE = 'uk_templates_natural';

test('relacional: con `translate`, la transacción que abre devuelve el error del diseño; unida a otra, el crudo', async () => {
  const { files } = planFixture('notification-mailer');
  const typeorm = `export class QueryFailedError extends Error {
  constructor(driverError) { super(driverError.message); this.driverError = driverError; }
}`;
  const { load } = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB, typeorm } });
  const { TransactionContext } = await load('src/infrastructure/persistence/transaction-context.ts');
  const { QueryFailedError } = await load('node_modules/typeorm/index.js');
  const { asContractError } = await load('src/infrastructure/persistence/persistence-errors.ts');
  const runner = {
    manager: {},
    isTransactionActive: false,
    async connect() {},
    async query() {},
    async startTransaction() { this.isTransactionActive = true; },
    async commitTransaction() { this.isTransactionActive = false; },
    async rollbackTransaction() { this.isTransactionActive = false; },
    async release() {}
  };
  const transactions = new TransactionContext({ createQueryRunner: () => runner, manager: {} }, { transactionTimeoutMs: 1000 });
  const duplicate = () => {
    throw new QueryFailedError({ code: '23505', constraint: DUPLICATE, message: `duplicate key value violates unique constraint "${DUPLICATE}"` });
  };

  await assert.rejects(transactions.inTransaction(duplicate, { translate: asContractError }), (error) => error.code === 'TEMPLATE_VERSION_ALREADY_EXISTS' && error.httpStatus === 409);
  await assert.rejects(transactions.inTransaction(duplicate), (error) => error instanceof QueryFailedError, 'sin translate, el crudo');
  // Unida a la transacción del mediator, el save no traduce: el crudo llega a quien la abrió.
  await assert.rejects(
    transactions.inTransaction(() => transactions.inTransaction(duplicate, { translate: asContractError })),
    (error) => error instanceof QueryFailedError
  );
  // Un fallo que el diseño no nombra (un interbloqueo) sigue siendo el mismo error, para quien lo repite.
  const deadlock = () => {
    throw new QueryFailedError({ code: '40P01', message: 'deadlock detected' });
  };
  await assert.rejects(transactions.inTransaction(deadlock, { translate: asContractError }), (error) => error instanceof QueryFailedError);
});

test('documental: con `translate`, la transacción que abre devuelve el error del diseño; unida a otra, el crudo', async () => {
  const { files } = planFixture('notification-mailer-mongo', { stack: { database: 'mongodb' } });
  const mongodb = `export class MongoError extends Error {
  constructor(message, code) { super(message); this.code = code; }
  hasErrorLabel() { return false; }
}
export class MongoServerError extends MongoError {}
export class MongoClient {}`;
  const { load } = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB, mongodb } });
  const { TransactionContext } = await load('src/infrastructure/persistence/transaction-context.ts');
  const { MongoServerError } = await load('node_modules/mongodb/index.js');
  const { asContractError } = await load('src/infrastructure/persistence/persistence-errors.ts');
  const session = {
    active: false,
    startTransaction() { this.active = true; },
    inTransaction() { return this.active; },
    async commitTransaction() { this.active = false; },
    async abortTransaction() { this.active = false; },
    async endSession() {}
  };
  const client = { startSession: () => session };
  const transactions = new TransactionContext(client, { database: 'notifications' });
  const duplicate = () => {
    throw new MongoServerError(`E11000 duplicate key error collection: notifications.templates index: ${DUPLICATE} dup key: { }`, 11000);
  };

  await assert.rejects(transactions.inTransaction(duplicate, { translate: asContractError }), (error) => error.code === 'TEMPLATE_VERSION_ALREADY_EXISTS' && error.httpStatus === 409);
  await assert.rejects(transactions.inTransaction(duplicate), (error) => error instanceof MongoServerError);
  await assert.rejects(
    transactions.inTransaction(() => transactions.inTransaction(duplicate, { translate: asContractError })),
    (error) => error instanceof MongoServerError
  );
});
