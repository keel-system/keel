// La matriz de paridad de keel-go se ata al catálogo neutral: una fila por mecanismo, sin inventar ids, con el vocabulario de
// estados común y, en cada celda, una promesa que se pueda leer (una red que existe, y el sabotaje que la falsa).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MODELS } from '@keel-system/keel-core/gen/mechanisms';
import { MECHANISMS, MECHANISM_CATALOG, STATES, NETS, RELATIONAL_ENGINES, cells, pending, unfalsified, unverified } from '../src/lib/engine-support.js';
import { DB_SABOTAGES } from './helpers/db-sabotages.js';
import { DOC_SABOTAGES } from './helpers/doc-sabotages.js';
import { DRAIN_SABOTAGES, PURGE_TIMER_SABOTAGES, TIMER_SABOTAGES } from '../scripts/lib/timer-probes.js';

test('una fila por cada mecanismo del catálogo neutral, y ninguna inventada', () => {
  assert.deepEqual(Object.keys(MECHANISMS).sort(), Object.keys(MECHANISM_CATALOG).sort());
});

test('cada fila nombra su emisor y sus celdas, indexadas por el eje del catálogo y con el vocabulario común', () => {
  for (const [id, row] of Object.entries(MECHANISMS)) assert.ok(row.pending ? /incremento [0-9]+/.test(row.pending) : row.emitter && row.coverage, id);
  for (const { id, branch, cell } of cells()) {
    if (MECHANISM_CATALOG[id].axis === 'model') assert.ok(MODELS.includes(branch), `${id}: ${branch} no es un modelo`);
    else assert.ok(RELATIONAL_ENGINES.includes(branch), `${id}: ${branch} está fuera de la frontera de motores`);
    assert.ok(STATES[cell.state], `${id}/${branch}: estado ${cell.state}`);
    assert.ok(cell.why, `${id}/${branch}: sin porqué escrito`);
    if (cell.state === 'verificado') {
      assert.ok(NETS[cell.net] && cell.net !== 'ninguna', `${id}/${branch}: verificado por una red que no existe (${cell.net})`);
      assert.equal(typeof cell.falsified, 'boolean', `${id}/${branch}: falsado o no, dicho`);
    }
  }
});

test('cada motor relacional que la frontera admite tiene su celda en los mecanismos por motor', () => {
  for (const [id, row] of Object.entries(MECHANISMS)) {
    if (MECHANISM_CATALOG[id].axis === 'engine') assert.deepEqual(Object.keys(row.coverage).sort(), [...RELATIONAL_ENGINES].sort(), id);
  }
});

test('la puerta del incremento 16: nada pendiente, nada sin ejecutar y nada sin falsar', () => {
  assert.deepEqual(pending().map(({ id }) => id), []);
  assert.deepEqual(unverified().map(({ id, branch }) => `${id}/${branch}`), []);
  assert.deepEqual(unfalsified().map(({ id, branch }) => `${id}/${branch}`), []);
});

// Los sabotajes con que se falsa cada celda de db-check y doc-check: todos tienen que existir.
const FALSIFIED_BY = {
  'outbox-relay/relational': ['lease', 'skip-locked', 'purge', 'purge-batch'],
  'outbox-relay/document': ['outbox-order'],
  'idempotency-request/relational': ['idempotency'],
  'idempotency-request/document': ['idempotency-outside'],
  'idempotency-consume/relational': ['guard'],
  'idempotency-consume/document': ['guard-in-session'],
  'reconciliation-claim/relational': ['reconciliation-expiry', 'reconciliation-threshold', 'reconciliation-head'],
  'reconciliation-claim/document': ['reconciliation-held', 'reconciliation-threshold', 'reconciliation-expiry', 'reconciliation-key'],
  'sweep-claim-queue/relational': ['claim-skip-locked'],
  'sweep-claim-queue/document': ['claim'],
  'sweep-claim-rescue/relational': ['claim-stale'],
  'sweep-claim-rescue/document': ['claim-stale'],
  'guard-claim/relational': ['guard-state'],
  'guard-claim/document': ['send-guard'],
  'harness-db-probes/relational': ['harness-stall'],
  'schema-baseline/relational': ['index'],
  'transient-write-conflict/relational': ['deadlock', 'retry'],
  'transient-write-conflict/document': ['transient'],
  'document-indexes/document': ['translator'],
  'partial-unique-index/postgresql': ['partial-literal'],
  'partial-unique-index/mysql': ['partial-flag'],
  'unique-collation/mysql': ['collation'],
  'claim-dialect/postgresql': ['skip-locked', 'claim-skip-locked'],
  'claim-dialect/mysql': ['claim-isolation', 'skip-locked', 'claim-skip-locked'],
  'harness-sql-literals/postgresql': ['stale-literal', 'uuid-literal'],
  'harness-sql-literals/mysql': ['stale-literal', 'uuid-literal'],
  'folded-text/relational': ['fold', 'finder-fold'],
  'folded-text/document': ['finder-fold'],
  'persistence-adapter/relational': ['version', 'enum', 'constraint', 'index', 'merge', 'list-order', 'timeout'],
  'persistence-adapter/document': ['decimal-as-text', 'uuid-legacy', 'version', 'translator'],
  'conditional-write/relational': ['cw-ignore-expected', 'cw-stale-version', 'cw-collapse-409'],
  'conditional-write/document': ['cw-ignore-expected', 'cw-stale-version', 'cw-collapse-409'],
  'deadline/relational': ['dl-boundary', 'dl-no-guard', 'dl-outside-tx'],
  'deadline/document': ['dl-boundary', 'dl-no-guard', 'dl-outside-tx'],
  'timer/relational': ['dl-no-lease', 'dl-no-revalidate'],
  'timer/document': ['dl-no-lease', 'dl-no-revalidate'],
  'timer-purge/relational': ['timer-every-replica'],
  'timer-purge/document': ['timer-every-replica'],
  'timer-schedule/relational': ['drain-no-signal', 'drain-no-budget', 'timer-every-replica-schedule'],
  'timer-schedule/document': ['drain-no-signal', 'drain-no-budget', 'timer-every-replica-schedule']
};

test('el sabotaje con que se falsa cada celda de db-check o doc-check existe de verdad', () => {
  const known = { 'db-check': { ...DB_SABOTAGES, ...TIMER_SABOTAGES, ...PURGE_TIMER_SABOTAGES, ...DRAIN_SABOTAGES }, 'doc-check': { ...DOC_SABOTAGES, ...TIMER_SABOTAGES, ...PURGE_TIMER_SABOTAGES, ...DRAIN_SABOTAGES } };
  for (const { id, branch, cell } of cells()) {
    if (!known[cell.net]) continue;
    const named = FALSIFIED_BY[`${id}/${branch}`];
    assert.ok(named, `${id}/${branch}: una celda falsada dice con qué`);
    for (const word of named) assert.ok(known[cell.net][word], `${id}/${branch}: no hay sabotaje '${word}' en ${cell.net}`);
  }
});

test('npm run matrix existe', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.matrix, 'node scripts/support-matrix.js');
});
