// Los dos límites que acotan una transacción en la rama relacional, y que van juntos:
//
//  - el TOPE (`spring.transaction.default-timeout`): sin él una consulta lenta o una espera de
//    bloqueo —infinita por defecto en PostgreSQL, SQL Server y Oracle— retiene su conexión sin
//    límite, y lo cancelado tiene que salir como 503 TRANSACTION_TIMEOUT y no como 500;
//  - la PURGA POR LOTES: un DELETE único es una transacción del tamaño del atraso, que con el tope
//    puesto no terminaría nunca.
//
// Lo que se afirma aquí es lo que build EMITE. Que el motor cancele de verdad la espera y que el
// bucle borre por lotes lo mide `store-check` contra PostgreSQL y MySQL
// (`unaEsperaDeBloqueoSeCancelaAlAgotarElTope`, `laPurgaVaPorLotesYRespetaSuTope`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import YAML from 'yaml';
import { loadService, FRAMEWORK_ERRORS } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { DB_TRANSACTION_TIMEOUT } from '../src/scaffold/config.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function generate(fixture) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-txlimits-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, 'services', `${manifest.service.name}-spring`);
  const all = fs.readdirSync(root, { recursive: true }).map((file) => file.split(path.sep).join('/'));
  const read = (suffix) => {
    const found = all.find((file) => file.endsWith(suffix));
    return found ? fs.readFileSync(path.join(root, found), 'utf8') : null;
  };
  return { read, all };
}

test('el tope de transacción se emite en los tres perfiles, redirigible por entorno', () => {
  const { read } = generate('stock-reservation');
  for (const profile of ['local', 'develop', 'production']) {
    const db = read(`parameters/${profile}/db.yaml`);
    assert.match(db, /^ {2}transaction:\n(?: {4}#.*\n)? {4}default-timeout: .+$/m, `${profile}: sin tope de transacción`);
    const value = db.match(/default-timeout: (.+)$/m)[1];
    if (profile === 'local') assert.equal(value, DB_TRANSACTION_TIMEOUT);
    else assert.equal(value, `\${DB_TRANSACTION_TIMEOUT:${DB_TRANSACTION_TIMEOUT}}`);
  }
});

test('lo cancelado por el tope sale como 503 con el code del catálogo, no como 500', () => {
  const handler = generate('stock-reservation').read('/ApiExceptionHandler.java');
  const block = handler.slice(handler.indexOf('onTransactionTimeout') - 200, handler.indexOf('onTransactionTimeout') + 700);
  assert.match(handler, /@ExceptionHandler\(\{ QueryTimeoutException\.class, TransactionTimedOutException\.class \}\)/);
  assert.ok(block.includes(`HttpStatus.valueOf(${FRAMEWORK_ERRORS.transactionTimeout.http})`), block);
  assert.ok(block.includes(`"${FRAMEWORK_ERRORS.transactionTimeout.code}"`), block);
  assert.ok(block.includes('HttpHeaders.RETRY_AFTER'), 'sin Retry-After el cliente no sabe que reintentar es seguro');
});

test('la rama documental no recibe ni el tope ni el handler: el tope se fija en la relacional', () => {
  const { read } = generate('job-dispatch-mongo');
  assert.ok(!read('parameters/develop/db.yaml').includes('default-timeout'));
  assert.ok(!read('/ApiExceptionHandler.java').includes('onTransactionTimeout'));
});

test('las purgas relacionales van por lotes, y sin transacción alrededor del bucle', () => {
  const { read } = generate('stock-reservation');
  const purges = [
    { owner: '/OutboxRelay.java', repo: '/OutboxEventJpaRepository.java', del: 'deletePublishedBefore' },
    { owner: '/IdempotencyGuard.java', repo: '/ProcessedEventJpaRepository.java', del: 'deleteProcessedBefore' },
    { owner: '/JpaIdempotencyStore.java', repo: '/IdempotencyRecordJpaRepository.java', del: 'deleteExpiredBefore' },
    { owner: '/ReconciliationClaimPurge.java', repo: '/ReconciliationClaimJpaRepository.java', del: 'deleteClaimedBefore' }
  ];
  assert.ok(read('/BatchedPurge.java'), 'no se generó el bucle de la purga');
  for (const { owner, repo, del } of purges) {
    const source = read(owner);
    assert.ok(source, `no se generó ${owner}`);
    const purge = source.slice(source.indexOf('public void purge()') - 300, source.indexOf('public void purge()') + 600);
    assert.match(purge, /BatchedPurge\.run\(/, `${owner}: la purga no pasa por el bucle por lotes`);
    // Una transacción alrededor del bucle volvería a ser el DELETE único que esto sustituye.
    assert.ok(!/@Transactional\s+public void purge\(\)/.test(source), `${owner}: la purga sigue envuelta en una transacción`);

    const repository = read(repo);
    assert.match(repository, /List<Instant> findPurgeBoundary\(@Param\("cutoff"\) Instant cutoff, Pageable position\)/);
    // El borrado acotado, en SU transacción: es lo que hace que cada lote confirme.
    assert.match(
      repository,
      new RegExp(`@Modifying\\s+@Transactional\\s+@Query\\("delete [^"]+ <= :upTo"\\)\\s+int ${del}\\(@Param\\("cutoff"\\) Instant cutoff, @Param\\("upTo"\\) Instant upTo\\)`),
      `${repo}: el borrado no va acotado por lote o no tiene transacción propia`
    );
  }
});

test('la frontera y el borrado cuentan las MISMAS filas: el outbox no toca lo pendiente en ninguna', () => {
  const repository = generate('stock-reservation').read('/OutboxEventJpaRepository.java');
  const queries = repository.match(/@Query\("(select o\.publishedAt|delete) [^"]+"\)/g);
  assert.equal(queries.length, 2);
  for (const query of queries) assert.ok(query.includes('o.publishedAt is not null'), query);
});

test('la rama documental no recibe el bucle: su deleteMany no retiene bloqueos que escalen', () => {
  const { read } = generate('job-dispatch-mongo');
  assert.equal(read('/BatchedPurge.java'), null);
});

// ─── El reintento del interbloqueo (R3) ──────────────────────────────────────
//
// El UseCaseMediator relacional reintenta la transacción que pierde un INTERBLOQUEO, como el
// documental reintenta el WriteConflict. Que el motor interbloquee de verdad y que las dos
// escrituras terminen lo mide store-check (`MediatorStoreCheckTest`); aquí, lo que build emite.

test('el mediator relacional reintenta el interbloqueo, y solo eso', () => {
  const mediator = generate('stock-reservation').read('/UseCaseMediator.java');
  assert.match(mediator, /retryingWriteConflicts\(\(\) -> writeTransaction\.execute/, 'la escritura no pasa por el reintento');
  const classifier = mediator.slice(mediator.indexOf('static boolean isTransientWriteConflict'));
  assert.match(classifier, /cause instanceof PessimisticLockingFailureException/);
  // Ni el conflicto de @Version ni el tope de transacción se reintentan: el clasificador no los nombra.
  assert.ok(!/instanceof (Object)?OptimisticLockingFailureException|instanceof QueryTimeoutException/.test(classifier));
  // Agotado, sale como la excepción que el handler 409 de la rama relacional captura.
  assert.match(mediator, /throw new ObjectOptimisticLockingFailureException\(/);
  // La lectura NO se reintenta: no toma bloqueos de escritura.
  assert.match(mediator, /return callUseCase\(query, \(\) -> readTransaction\.execute/);
});

test('dentro de una transacción ajena no se reintenta: la del llamante ya está condenada', () => {
  for (const fixture of ['stock-reservation', 'job-dispatch-mongo']) {
    const mediator = generate(fixture).read('/UseCaseMediator.java');
    const retry = mediator.slice(mediator.indexOf('private <T> T retryingWriteConflicts'));
    assert.match(retry, /^[^]*?\{\s+if \(TransactionSynchronizationManager\.isActualTransactionActive\(\)\) \{\s+return transaction\.get\(\);/, fixture);
  }
});

test('el 409 del conflicto agotado existe aunque el diseño no use @Version', () => {
  // profile-directory declara `optimisticLocking: none`. Antes el handler solo se emitía con
  // @Version, y el interbloqueo agotado acababa en el 500 del catch-all.
  const handler = generate('profile-directory').read('/ApiExceptionHandler.java');
  assert.match(handler, /@ExceptionHandler\(ObjectOptimisticLockingFailureException\.class\)/);
});

// ─── El pool y las redes de Hibernate (R5, R7) ───────────────────────────────

/** Las claves del YAML aplanadas como lo hace Spring (`a:\n  b.c: x` → `a.b.c`). */
function flatten(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node ?? {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

test('el pool falla rápido, tiene nombre y su vida máxima es configurable', () => {
  const { read } = generate('stock-reservation');
  const local = flatten(YAML.parse(read('parameters/local/db.yaml')));
  const production = flatten(YAML.parse(read('parameters/production/db.yaml')));
  // El default de Hikari son 30 s, y con hilos virtuales eso es una cola de miles de peticiones.
  assert.equal(local['spring.datasource.hikari.connection-timeout'], 5000);
  assert.equal(production['spring.datasource.hikari.connection-timeout'], '${DB_POOL_CONNECTION_TIMEOUT_MS:5000}');
  assert.equal(production['spring.datasource.hikari.max-lifetime'], '${DB_POOL_MAX_LIFETIME_MS:1800000}');
  // La etiqueta `pool` de sus métricas: con HikariPool-1 dos servicios no se distinguen.
  assert.equal(production['spring.datasource.hikari.pool-name'], 'stock-reservation-pool');
});

test('las dos redes de Hibernate llegan con el nombre que Hibernate lee, en todos los perfiles', () => {
  const { read } = generate('stock-reservation');
  for (const profile of ['local', 'develop', 'production']) {
    const db = flatten(YAML.parse(read(`parameters/${profile}/db.yaml`)));
    // Nombres leídos de QuerySettings de hibernate-core 6.6.18: una errata no falla, se ignora.
    assert.equal(db['spring.jpa.properties.hibernate.query.fail_on_pagination_over_collection_fetch'], true, profile);
    assert.equal(db['spring.jpa.properties.hibernate.query.in_clause_parameter_padding'], true, profile);
  }
});
