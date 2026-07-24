import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select } from '../src/lib/prompt.js';
import { DATABASES, BROKERS, AUTH, CACHES, STORAGE, STACK_DEFAULTS, selectedInfra } from '../src/lib/stack-catalog.js';
import {
  askStackConfig,
  designUsesCache,
  readStackConfig,
  writeStackConfig,
  describeStack,
  STACK_FILE
} from '../src/lib/stack-config.js';

test('select devuelve el default sin TTY (tests/CI) o con defaults', async () => {
  // En el runner de tests stdin no es TTY: no debe colgarse esperando input.
  const options = Object.values(DATABASES);
  assert.equal(await select('¿BD?', options, 'postgresql'), 'postgresql');
  assert.equal(await select('¿BD?', options, 'mysql', { defaults: true }), 'mysql');
});

test('askStackConfig pregunta solo por lo que el diseño necesita', async () => {
  const layers = {
    persistence: { default: { model: 'relational' }, entities: { X: {} } },
    'use-cases': { operations: { getX: { cache: { ttlSeconds: 60, keyFields: ['id'] } } } }
  };
  const manifest = { service: { name: 'demo', domain: 'shop' } };
  const stack = await askStackConfig(manifest, layers, { defaults: true });
  assert.equal(stack.group, 'com.shop'); // default derivado del domain
  assert.equal(stack.database, STACK_DEFAULTS.database);
  assert.equal(stack.broker, null); // sin capa messaging
  assert.equal(stack.auth, null); // sin capa security
  assert.equal(stack.cache, STACK_DEFAULTS.cache); // hay operación con cache
});

test('askStackConfig pregunta por object storage solo con capa storage', async () => {
  const manifest = { service: { name: 'demo', domain: 'shop' } };
  const sinStorage = await askStackConfig(manifest, { 'use-cases': { operations: {} } }, { defaults: true });
  assert.equal(sinStorage.storage, null);

  const conStorage = await askStackConfig(
    manifest,
    { 'use-cases': { operations: {} }, storage: { buckets: { fotos: { allowedContentTypes: ['image/png'] } } } },
    { defaults: true }
  );
  assert.equal(conStorage.storage, STACK_DEFAULTS.storage);
});

test('designUsesCache detecta operaciones con política de caché', () => {
  assert.equal(designUsesCache({ 'use-cases': { operations: { a: {} } } }), false);
  assert.equal(designUsesCache({ 'use-cases': { operations: { a: { cache: { ttlSeconds: 1, keyFields: ['x'] } } } } }), true);
});

test('read/writeStackConfig persisten y recuperan keel-stack.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-stack-'));
  assert.equal(readStackConfig(dir), null);
  const stack = { group: 'com.example', database: 'mariadb', broker: 'rabbitmq', auth: null, cache: null };
  writeStackConfig(dir, stack);
  assert.ok(fs.existsSync(path.join(dir, STACK_FILE)));
  assert.deepEqual(readStackConfig(dir), stack);
});

test('el catálogo declara metadata de validación coherente por opción con contenedor', () => {
  const all = { ...DATABASES, ...BROKERS, ...AUTH, ...CACHES, ...STORAGE };
  for (const [id, entry] of Object.entries(all)) {
    if (!entry.serviceKey) continue; // opciones sin contenedor no se validan
    assert.ok(entry.label, `${id}: falta label`);
    assert.ok(entry.cliVia, `${id}: con serviceKey debe declarar cliVia`);
    assert.ok(entry.cliValidateCmd, `${id}: con serviceKey debe declarar cliValidateCmd`);
    assert.ok(Array.isArray(entry.alpinePackages), `${id}: alpinePackages debe ser array`);
  }
});

test('cada dialecto declara su módulo Flyway y protege el historial en el reset', () => {
  for (const [id, entry] of Object.entries(DATABASES)) {
    // Motor + módulo del dialecto: sin él Flyway no reconoce la BD en runtime.
    assert.ok(Array.isArray(entry.flywayDependencies), `${id}: falta flywayDependencies`);
    assert.ok(
      entry.flywayDependencies.some((dep) => dep.includes('org.flywaydb:flyway-core')),
      `${id}: flywayDependencies debe incluir flyway-core`
    );
    // El reset entre flujos vacía datos, no el historial de migraciones: si lo
    // truncara, el arranque siguiente reaplicaría el baseline y fallaría.
    if (entry.cliResetCmd) {
      assert.ok(
        /flyway_schema_history/i.test(entry.cliResetCmd),
        `${id}: cliResetCmd debe excluir flyway_schema_history`
      );
    }
  }
  // H2 es el único sin módulo propio: su soporte vive dentro de flyway-core.
  assert.equal(DATABASES.h2.flywayDependencies.length, 1);
  // MySQL y MariaDB comparten módulo.
  assert.deepEqual(DATABASES.mysql.flywayDependencies, DATABASES.mariadb.flywayDependencies);
});

test('el catálogo incorpora las técnicas de la referencia', () => {
  assert.ok(DATABASES.oracle && DATABASES.h2, 'faltan oracle/h2');
  assert.ok(BROKERS.snssqs, 'falta snssqs');
  assert.ok(AUTH.cognito, 'falta cognito');
  assert.ok(CACHES.valkey, 'falta valkey');
  // Oracle valida dentro de su propio contenedor; h2 no levanta contenedor.
  assert.equal(DATABASES.oracle.cliVia, 'dbcontainer');
  assert.equal(DATABASES.h2.serviceKey, undefined);
  // snssqs declara BOM + starters SNS/SQS como array.
  assert.ok(Array.isArray(BROKERS.snssqs.gradleDependencies));
  assert.ok(BROKERS.snssqs.gradleDependencies.length >= 3);
});

test('selectedInfra lista solo las opciones con contenedor', () => {
  const sinContenedores = selectedInfra({
    layersPresent: { persistence: true, messaging: false, storage: false },
    stack: { database: 'h2', broker: null, auth: 'none', cache: null, storage: null }
  });
  assert.deepEqual(sinContenedores, []);

  const conContenedores = selectedInfra({
    layersPresent: { persistence: true, messaging: true, storage: false },
    stack: { database: 'postgresql', broker: 'kafka', auth: null, cache: 'redis', storage: null }
  });
  assert.deepEqual(conContenedores.map((s) => s.id), ['postgresql', 'kafka', 'redis']);
  assert.deepEqual(conContenedores.map((s) => s.serviceKey), ['db', 'kafka', 'redis']);
});

test('describeStack resume las elecciones con sus labels', () => {
  const text = describeStack({ group: 'com.example', database: 'postgresql', broker: 'kafka', auth: 'none', cache: null });
  assert.ok(text.includes('com.example')); // el grupo se antepone
  assert.ok(text.includes(DATABASES.postgresql.label));
  assert.ok(text.includes(BROKERS.kafka.label));
  assert.ok(!text.includes('Ninguno')); // auth none no se lista
});
