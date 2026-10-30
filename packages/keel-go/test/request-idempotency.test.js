// La idempotencia de petición de keel-go (adelantada del incremento 10 al 7, como en keel-dotnet): el registro sale con
// la persistencia relacional, cada operación que lo usa recibe el puerto y su nota, su mensaje lleva el ámbito y la
// firma generados, la cabecera llega al contexto solo con client-key, y el code de cada conflicto por operación es el que
// EMITE keel-dotnet para el mismo diseño. La tabla la compara schema-parity.test.js (y mysql.test.js) con keel-spring;
// lo que solo juzga el motor (la carrera, la caducidad, el rollback) lo mide db-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { registryOperations } from '@keel-system/keel-core/gen/request-idempotency';
import { planFixture as planDotnet } from '../../keel-dotnet/test/helpers/workspace.js';
import { planService } from '../src/scaffold/index.js';
import { usesIdempotencyHeader, usesRequestIdempotency } from '../src/scaffold/request-idempotency.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtureNames = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));

function plan(name, stack = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, ...(stack ? { stack } : {}) });
}

const withRegistry = fixtureNames.filter((name) => usesRequestIdempotency(plan(name).model));

test('hay fixtures con registro de idempotencia, y con las tres fuentes de clave entre ellas', () => {
  assert.ok(withRegistry.length >= 4, withRegistry.join(', '));
  const sources = new Set(withRegistry.flatMap((name) => registryOperations(plan(name).model).map((operation) => operation.idempotency.keySource)));
  assert.ok(sources.has('client-key') && sources.has('payload-hash'), [...sources].join(', '));
});

for (const name of fixtureNames) {
  test(`${name}: el registro sale si y solo si el diseño lo usa sobre persistencia relacional, y cableado entero`, () => {
    const { model, files } = plan(name);
    const all = byPath(files);
    const store = Object.keys(all).find((file) => /^internal\/infrastructure\/(postgres|mysql)\/idempotency_store\.go$/.test(file));
    if (!usesRequestIdempotency(model)) {
      assert.equal(store, undefined);
      assert.ok(!('internal/domain/idempotency.go' in all));
      assert.doesNotMatch(all['internal/application/use_cases.go'] ?? '', /IdempotencyStore/);
      return;
    }
    assert.ok(store, 'el adaptador del motor');
    assert.match(all['internal/domain/idempotency.go'], /type IdempotencyStore interface/);
    assert.match(all['internal/application/use_cases.go'], /\tIdempotencyStore +domain\.IdempotencyStore\n/);
    assert.match(all['cmd/server/main.go'], /IdempotencyStore: +(postgres|mysql)\.NewIdempotencyStore\(transactions\),/);
    for (const operation of registryOperations(model)) {
      const message = Object.entries(all).find(([file, content]) => file.startsWith('internal/application/') && new RegExp(`^type \\w+ struct`, 'm').test(content) && content.includes(`IdempotencyScope es el ámbito de la clave de idempotencia de ${operation.name}.`));
      assert.ok(message, `${operation.name}: su mensaje lleva el ámbito`);
      const partition = operation.idempotency.partitionBy ?? [];
      assert.match(message[1], new RegExp(`return "${operation.name}"${partition.map(() => ' \\+ ":" \\+ [^\\n]+').join('')}\\n`), `${operation.name}: el ámbito con su partitionBy`);
      assert.match(message[1], /\) IdempotencySignature\(\) \(string, error\) \{\n\tvar s signer\n/);
      // El handler recibe el puerto y la nota del algoritmo; el constructor, el registro de Dependencies.
      const handler = Object.values(all).find((content) => content.includes(`// Handle ejecuta ${operation.name}.`));
      assert.match(handler, /idempotencyStore domain\.IdempotencyStore/);
      assert.match(handler, /Idempotencia: keySource=/);
      assert.match(handler, /Algoritmo, dentro de la transacción del comando/);
      assert.match(all['internal/application/use_cases.go'], new RegExp(`New\\w+Handler\\([^)]*deps\\.IdempotencyStore`));
    }
    // La cabecera, solo con client-key: el borde la lleva al contexto.
    const header = usesIdempotencyHeader(model);
    assert.equal('internal/application/idempotency_key.go' in all, header);
    assert.equal(/application\.WithIdempotencyKey\(r\.Context\(\), r\.Header\.Get\(application\.IdempotencyHeader\)\)/.test(all['internal/httpapi/middleware.go'] ?? ''), header);
  });
}

/** Las filas (operación, code de la carrera, code de la clave reutilizada) de la prueba emitida de keel-go. */
function goConflictRows(files) {
  const test = files.find((file) => file.path === 'internal/application/idempotency_test.go')?.content ?? '';
  return [...test.matchAll(/\{operation: "(\w+)", race: "(\w+)", reuse: "(\w+)"\}/g)].map((match) => match.slice(1).join(' ')).sort();
}

/** Las mismas filas de la prueba emitida de keel-dotnet (IdempotencyTests, [InlineData]). */
function dotnetConflictRows(files) {
  const test = files.find((file) => file.path.endsWith('/IdempotencyTests.cs'))?.content ?? '';
  return [...test.matchAll(/\[InlineData\("(\w+)", "(\w+)", "(\w+)"\)\]/g)].map((match) => match.slice(1).join(' ')).sort();
}

for (const name of withRegistry) {
  test(`${name}: el code de cada conflicto por operación es el que emite keel-dotnet`, async () => {
    const go = goConflictRows(plan(name).files);
    assert.ok(go.length > 0);
    assert.deepEqual(go, dotnetConflictRows((await planDotnet(name)).files));
  });

  test(`${name}: el adaptador sobre MySQL no lleva el dialecto de PostgreSQL, y al revés`, () => {
    const pg = byPath(plan(name).files)['internal/infrastructure/postgres/idempotency_store.go'];
    const my = byPath(plan(name, { database: 'mysql' }).files)['internal/infrastructure/mysql/idempotency_store.go'];
    assert.match(pg, /engine\.Code == "23505" && engine\.ConstraintName == "idempotency_record_pkey"/);
    assert.match(pg, /operation_scope = \$1/);
    assert.match(my, /engine\.Number == 1062 && strings\.Contains\(engine\.Message, "'idempotency_record\.PRIMARY'"\)/);
    assert.doesNotMatch(my, /\$\d|::|ON CONFLICT|pgconn/);
  });
}

test('payload-hash: la nota dice que la clave es la propia firma, sin cabecera', () => {
  const { model, files } = plan('catalog-extended');
  const operation = registryOperations(model, 'payload-hash')[0];
  assert.ok(operation, 'catalog-extended tiene una operación con payload-hash');
  const handler = files.find((file) => file.content.includes(`// Handle ejecuta ${operation.name}.`)).content;
  assert.match(handler, /La clave es la propia firma, cmd\.IdempotencySignature\(\)/);
  assert.doesNotMatch(handler, /IdempotencyKeyFrom/);
});
