// La reconciliación y la compensación de keel-go (tramo 11c), sobre el texto emitido. Lo que el reclamo HACE contra el
// motor (la marca viva, la caducada en el límite, dos réplicas a la vez, la cabeza de la cola) lo mide `npm run db-check`;
// aquí, lo que tiene que coincidir con los otros tres y lo que el agente lee:
//   · reconciliation.yaml es el de keel-nest y keel-dotnet byte a byte, y ReconciliationSettings lee esas claves con los
//     defaults de keel-core;
//   · la marca va en reconciliation_claim con la sentencia de cada motor, y la lectura de candidatos excluye la marca viva;
//   · el reclamo está en el puerto y en el adaptador de la raíz que espera, en su propia transacción;
//   · las marcas se purgan como en keel-nest; el arranque lee los barridos y se los da al adaptador;
//   · el handler del barrido dice que el reclamo existe, y el de la compensación qué devuelve y con qué guarda.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { reconciledActivations, reconciliationClaims, reconciliationParameters } from '@keel-system/keel-core/gen/reconciliation-stores';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { tablePurges } from '../src/scaffold/purge.js';
import { tablePurges as nestTablePurges } from '../../keel-nest/src/scaffold/purge.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService, stack = { database: 'postgresql', broker: 'rabbitmq' }) => planner({ ...design(name), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

test('stock-reservation: reconciliation.yaml es el de keel-nest y keel-dotnet, y ReconciliationSettings lee sus claves con los defaults de keel-core', () => {
  const { model, files } = plan('stock-reservation');
  const nest = plan('stock-reservation', planNest).files;
  const dotnet = plan('stock-reservation', planDotnet).files;
  for (const profile of ['local', 'develop', 'production']) {
    const file = `config/parameters/${profile}/reconciliation.yaml`;
    assert.equal(content(files, file), content(nest, file), `${profile}: el de keel-nest`);
    assert.equal(content(files, file), content(dotnet, file), `${profile}: el de keel-dotnet`);
  }
  // En test valen los defaults del código, como en los otros tres.
  assert.equal(content(files, 'config/parameters/test/reconciliation.yaml'), undefined);
  const settings = content(files, 'internal/infrastructure/postgres/reconciliation.go');
  for (const { activation, sweeper } of reconciledActivations(model)) {
    const parameters = reconciliationParameters(activation, sweeper);
    const prefix = parameters.batchSize.key.replace(/\.batch-size$/, '');
    assert.ok(settings.includes(`"${activation.name}": "${prefix}",`), `${activation.name}: su prefijo`);
    assert.ok(
      settings.includes(`{UnansweredAfterSeconds: ${parameters.unansweredAfterSeconds.default}, ClaimTimeoutMs: ${parameters.claimTimeoutMs.default}, BatchSize: ${parameters.batchSize.default}}`),
      `${activation.name}: los defaults de keel-core`
    );
  }
  // Las hojas que lee son las del YAML.
  for (const leaf of ['unanswered-after-seconds', 'claim-timeout-ms', 'batch-size']) {
    assert.ok(settings.includes(`{"${leaf}", &window.`), leaf);
    assert.match(content(files, 'config/parameters/local/reconciliation.yaml'), new RegExp(`^    ${leaf}: `, 'm'), leaf);
  }
});

test('la marca: UNA sentencia en PostgreSQL; UPDATE de la caducada e INSERT IGNORE en MySQL', () => {
  const postgres = content(plan('stock-reservation').files, 'internal/infrastructure/postgres/reconciliation.go');
  assert.ok(
    postgres.includes(
      '"INSERT INTO reconciliation_claim (activation, entity_id, claimed_at) VALUES ($1, $2, $3) ON CONFLICT (activation, entity_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at WHERE reconciliation_claim.claimed_at <= $4", activation, entityID, now, expiredBefore'
    )
  );
  assert.match(postgres, /return won == 1, err/);
  const mysql = content(plan('stock-reservation', planService, { database: 'mysql', broker: 'rabbitmq' }).files, 'internal/infrastructure/mysql/reconciliation.go');
  assert.ok(mysql.includes('"UPDATE reconciliation_claim SET claimed_at = ? WHERE activation = ? AND entity_id = ? AND claimed_at <= ?", now, activation, entityID, expiredBefore'));
  assert.ok(mysql.includes('"INSERT IGNORE INTO reconciliation_claim (activation, entity_id, claimed_at) VALUES (?, ?, ?)", activation, entityID, now'));
  // Solo en la prosa: ninguna sentencia lo usa.
  assert.doesNotMatch(mysql, /"[^"\n]*ON DUPLICATE KEY/);
});

test('el reclamo está en el puerto y en el adaptador: candidatos sin marca viva, SKIP LOCKED sobre la entidad, transacción propia', () => {
  for (const database of ['postgresql', 'mysql']) {
    const { model, files } = plan('stock-reservation', planService, { database, broker: 'rabbitmq' });
    const store = database === 'mysql' ? 'mysql' : 'postgres';
    const p = database === 'mysql' ? ['?', '?', '?'] : ['$1', '$2', '$3'];
    for (const claim of reconciliationClaims(model)) {
      const method = claim.method[0].toUpperCase() + claim.method.slice(1);
      assert.ok(content(files, 'internal/domain/reservation_repository.go').includes(`\t${method}(ctx context.Context) ([]*Reservation, error)`), method);
      const adapter = content(files, `internal/infrastructure/${store}/reservation_repository.go`);
      assert.ok(adapter.includes(`func (r *ReservationRepository) ${method}(ctx context.Context) ([]*domain.Reservation, error) {`));
      assert.ok(adapter.includes(`ownTransaction(ctx, "${method}")`));
      assert.ok(adapter.includes(`window := r.reconciliation.Windows["${claim.activation}"]`));
      assert.match(adapter, /r\.tx\.fresh\(ctx, claimOptions,/);
      assert.ok(
        adapter.includes(
          `"SELECT e.id FROM reservations e WHERE e.status IN ('AWAITING_STOCK') AND e.reserve_stock_awaiting_since < ${p[0]} AND NOT EXISTS (SELECT 1 FROM reconciliation_claim c WHERE c.activation = 'reserveStock' AND c.entity_id = e.id AND c.claimed_at > ${p[1]}) ORDER BY e.reserve_stock_awaiting_since LIMIT ${p[2]} FOR UPDATE OF e SKIP LOCKED", unansweredBefore, claimExpiredBefore, window.BatchSize`
        ),
        database
      );
      assert.ok(adapter.includes(`claimReconciliation(ctx, q, "${claim.activation}", id, now, claimExpiredBefore)`));
      // El estado no se toca: ninguna sentencia del reclamo escribe en reservations.
      assert.doesNotMatch(adapter.split(`func (r *ReservationRepository) ${method}`)[1].split('\n}\n')[0], /UPDATE reservations/);
    }
    // La tabla, en el baseline.
    const migration = files.find((file) => file.path.startsWith(`internal/infrastructure/${store}/migrations/`) && file.path.endsWith('.sql')).content;
    assert.match(migration, /CREATE TABLE reconciliation_claim \(/);
    assert.match(migration, /CREATE INDEX ix_reconciliation_claim_claimed_at ON reconciliation_claim \(claimed_at\)/);
  }
});

test('las marcas se purgan como en keel-nest, y el arranque lee los barridos y se los da al adaptador', () => {
  const { model, files } = plan('stock-reservation');
  assert.deepEqual(
    tablePurges(model).map((purge) => purge.what),
    nestTablePurges(plan('stock-reservation', planNest).model).map((purge) => purge.what)
  );
  const purge = tablePurges(model).find((candidate) => candidate.what === 'reconciliation_claim');
  assert.equal(purge.column, 'claimed_at');
  assert.equal(purge.prefix, 'reconciliation.purge');
  assert.match(content(files, 'internal/infrastructure/postgres/purges.go'), /"DELETE FROM reconciliation_claim WHERE claimed_at < \$1 AND claimed_at <= \$2"/);
  const main = content(files, 'cmd/server/main.go');
  assert.ok(main.indexOf('reconciliation, err := postgres.ReconciliationSettingsFrom(cfg)') < main.indexOf('postgres.NewReservationRepository(transactions, bridge, reconciliation'));
  assert.match(main, /scheduler\.PurgeTask\("reconciliation_claim", purges\.ReconciliationClaim, postgres\.NewReconciliationClaimPurge\(transactions\), logger\)/);
});

test('el handler del barrido dice que el reclamo existe; el de la compensación, qué devuelve y con qué guarda', () => {
  const { files } = plan('stock-reservation');
  const sweep = content(files, 'internal/application/reconcile_reservations_command_handler.go').replace(/\n\t\/\/ {3}/g, ' ');
  assert.match(sweep, /EL RECLAMO YA ESTÁ GENERADO: toma el lote con h\.reservationRepository\.ClaimForReconcileReservationsReserveStock\(ctx\)/);
  // reconcileReservations deshace con cancelStock: la entidad se resuelve ANTES de llamar.
  assert.match(sweep, /lo DESHACE con inventory\.cancelStock/);
  assert.match(sweep, /domain\.ErrInvalidStateTransition, o el Save domain\.ErrConcurrentModification/);
  const compensation = content(files, 'internal/application/release_reservation_command_handler.go').replace(/\n\t\/\/ {3}/g, ' ');
  assert.match(compensation, /Compensación de inventory — deshace la activación 'reserveStock': la dispara la suscripción a StockRejected/);
  assert.match(compensation, /la guarda es la transición del agregado/);
});

test('sin barridos de reconciliación no se emite nada de esto', () => {
  const { files } = plan('job-dispatch');
  assert.ok(!files.some((file) => /reconciliation/.test(file.path)));
  assert.doesNotMatch(content(files, 'cmd/server/main.go'), /Reconciliation/);
});

// ─── Sobre documentos (tramo 13h-b): asset-vault ─────────────────────────────────────────────────

test('asset-vault: el reclamo sobre documentos, con los documentos y los parámetros de los otros tres', () => {
  const stack = { database: 'mongodb', broker: 'rabbitmq', auth: 'keycloak', cache: 'redis', storage: 'minio' };
  const { model, files } = plan('asset-vault', planService, stack);
  for (const profile of ['local', 'develop', 'production']) {
    const file = `config/parameters/${profile}/reconciliation.yaml`;
    assert.equal(content(files, file), content(plan('asset-vault', planNest, stack).files, file), `${profile}: el de keel-nest`);
    assert.equal(content(files, file), content(plan('asset-vault', planDotnet, stack).files, file), `${profile}: el de keel-dotnet`);
  }
  const mark = content(files, 'internal/infrastructure/mongo/reconciliation.go');
  // Un solo upsert sobre la marca caducada, con la clave aplanada de keel-core y las dos columnas como campos.
  assert.match(mark, /Value: activation \+ "\|" \+ entityID\.String\(\)\}, \{Key: "claimed_at", Value: bson\.D\{\{Key: "\$lte", Value: instantValue\(expiredBefore\)\}\}\}/);
  assert.match(mark, /"\$setOnInsert", Value: bson\.D\{\{Key: "activation", Value: activation\}, \{Key: "entity_id", Value: uuidValue\(entityID\)\}\}/);
  assert.match(mark, /SetUpsert\(true\)/);
  assert.match(mark, /mongodriver\.IsDuplicateKeyError\(err\)/);
  assert.doesNotMatch(mark, /database\/sql|DBTX/);

  const [claim] = reconciliationClaims(model);
  const adapter = content(files, `internal/infrastructure/mongo/${claim.entity.toLowerCase()}_repository.go`);
  const method = claim.method[0].toUpperCase() + claim.method.slice(1);
  assert.ok(adapter.includes(`func (r *${claim.entity}Repository) ${method}(ctx context.Context)`));
  // Fuera de toda transacción, y la lectura excluye la marca viva.
  assert.match(adapter, /confirma por su cuenta y hay una transacción abierta/);
  assert.match(adapter, /heldReconciliations\(ctx, r\.tx,/);
  assert.match(adapter, /"\$nin", Value: held/);
  assert.match(content(files, `internal/domain/${claim.entity.toLowerCase()}_repository.go`), new RegExp(`${method}\\(ctx context\\.Context\\)`));

  // Las marcas se purgan e indexan por claimed_at; el arranque lee los barridos y se los da al adaptador.
  assert.match(content(files, 'internal/infrastructure/mongo/purges.go'), /NewReconciliationClaimPurge/);
  assert.match(content(files, 'internal/infrastructure/mongo/indexes.go'), /"reconciliation_claim": \{\n\t\t\{Keys: bson\.D\{\{Key: "claimed_at", Value: 1\}\}/);
  const server = files.find((file) => file.path.startsWith('cmd/server/') && file.content.includes('ReconciliationSettingsFrom')).content;
  assert.match(server, new RegExp(`New${claim.entity}Repository\\(transactions, [^)]*reconciliation\\)`));

  // El barrido lo enseña, y el arnés mueve solo la marca del documento con los scripts de keel-core.
  assert.match(content(files, 'internal/application/reconcile_scans_command_handler.go'), /EL RECLAMO YA ESTÁ GENERADO/);
  const flow = content(files, 'tests/integration/flow_test.go');
  assert.match(flow, /func \(s \*Scenario\) AgeForReconciliation\(activation, id string\)/);
  assert.match(flow, /func \(s \*Scenario\) HoldFromReconciliation\(activation, id string\)/);
  assert.match(flow, /"scanAsset":\s+\{scriptPair\{.*last_scanned_at/);
  assert.doesNotMatch(content(files, 'tests/integration/http_stub_test.go'), /AgeForReconciliation/);
});
