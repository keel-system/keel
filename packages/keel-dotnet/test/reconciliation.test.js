// La reconciliación y la compensación de keel-dotnet (incremento 11c), sobre el texto emitido:
//
//   · reconciliation.yaml es el MISMO texto que el de keel-nest (keel-core/gen/reconciliation-stores.js), y lo que
//     ReconciliationSettings lee son esas claves con los defaults de keel-core;
//   · la tienda del reclamo es la regla de keel-core (sin marca, se inserta; con marca, solo si caducó, con el MISMO `<=`),
//     en UNA sentencia: un error aborta la transacción entera en PostgreSQL;
//   · el reclamo del adaptador: SKIP LOCKED sobre el estado de espera y la marca del diseño, el lote del perfil, sin tocar el
//     estado, y negándose a correr dentro de otra transacción;
//   · las purgas son las de keel-nest (la marca de reconciliation_claim incluida);
//   · las notas del barrido y de la compensación, y el registro en Program.cs y en AddPersistence.
// Lo que dice el motor (la carrera, la caducidad, el orden, el lote) lo mide `npm run db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { reconciledActivations, reconciliationParameters } from 'keel-core/gen/reconciliation-stores';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { tablePurges as nestTablePurges } from '../../keel-nest/src/scaffold/purge.js';
import { planService } from '../src/scaffold/index.js';
import { tablePurges } from '../src/scaffold/purge.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const SUBJECTS = ['stock-reservation', 'catalog-extended'];
const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

test('reconciliation.yaml es el de keel-nest, y ReconciliationSettings lee sus claves con los defaults de keel-core', () => {
  for (const name of SUBJECTS) {
    const { files, model } = plan(name);
    const nest = plan(name, planNest).files;
    for (const profile of ['local', 'develop', 'production']) {
      const suffix = `config/parameters/${profile}/reconciliation.yaml`;
      assert.equal(content(files, suffix), content(nest, suffix), `${name}: ${profile}`);
    }
    assert.ok(!content(files, 'config/parameters/test/reconciliation.yaml'), 'en test valen los defaults del código');
    const settings = content(files, '/Persistence/ReconciliationSettings.cs');
    const yaml = parseYaml(content(files, 'config/parameters/local/reconciliation.yaml')).reconciliation;
    for (const { activation, sweeper } of reconciledActivations(model)) {
      const parameters = reconciliationParameters(activation, sweeper);
      for (const parameter of Object.values(parameters)) {
        const key = parameter.key.replaceAll('.', ':');
        assert.match(settings, new RegExp(`Positive\\(configuration, "${key}", ${parameter.default}\\)`), `${name}: ${parameter.key}`);
        const [, activationKey, leaf] = parameter.key.split('.');
        assert.ok(yaml[activationKey]?.[leaf] != null, `${name}: el YAML declara ${parameter.key}`);
      }
      assert.match(settings, new RegExp(`\\["${activation.name}"\\] = new\\(`));
    }
  }
});

test('la tienda del reclamo es la regla de keel-core en una sola sentencia', () => {
  const store = content(plan('stock-reservation').files, '/Persistence/ReconciliationClaimStore.cs');
  assert.match(
    store,
    /INSERT INTO reconciliation_claim \(activation, entity_id, claimed_at\) VALUES \(\{activation\}, \{entityId\}, \{claimedAt\}\) ON CONFLICT \(activation, entity_id\) DO UPDATE SET claimed_at = EXCLUDED\.claimed_at WHERE reconciliation_claim\.claimed_at <= \{expired\}/
  );
  assert.match(store, /return won == 1;/);
  assert.doesNotMatch(store, /catch/, 'la carrera no se resuelve capturando la violación de clave');
});

test('el reclamo del adaptador: SKIP LOCKED sobre la espera, el lote del perfil, la marca por candidato y el estado intacto', () => {
  const { files } = plan('stock-reservation');
  const port = content(files, '/Repository/IReservationRepository.cs');
  assert.match(port, /Task<IReadOnlyList<Reservation>> ClaimForReconcileReservationsReserveStock\(CancellationToken cancellationToken = default\);/);
  const adapter = content(files, '/Repositories/ReservationRepository.cs');
  assert.match(adapter, /ReconciliationSettings reconciliation, ReconciliationClaimStore reconciliationClaims\) : IReservationRepository/);
  assert.match(adapter, /RequireOwnTransaction\("ClaimForReconcileReservationsReserveStock"\);/);
  assert.match(adapter, /var window = reconciliation\.Windows\["reserveStock"\];/);
  assert.match(
    adapter,
    /SELECT e\.id AS \\"Value\\" FROM reservations e WHERE e\.status IN \('AWAITING_STOCK'\) AND e\.reserve_stock_awaiting_since < \{unansweredBefore\} AND NOT EXISTS \(SELECT 1 FROM reconciliation_claim c WHERE c\.activation = 'reserveStock' AND c\.entity_id = e\.id AND c\.claimed_at > \{claimExpiredBefore\}\) ORDER BY e\.reserve_stock_awaiting_since LIMIT \{window\.BatchSize\} FOR UPDATE OF e SKIP LOCKED/  );
  assert.match(adapter, /reconciliationClaims\.Claim\("reserveStock", id, now, claimExpiredBefore, cancellationToken\)/);
  // El reclamo de reconciliación NO cambia el estado: no hay UPDATE sobre la tabla de la raíz en él.
  const method = adapter.slice(adapter.indexOf('public Task<IReadOnlyList<Reservation>> ClaimForReconcile'), adapter.indexOf('private void RequireOwnTransaction'));
  assert.doesNotMatch(method, /UPDATE reservations/);
  // El ayudante, una sola vez aunque la raíz tuviera además un reclamo de barrido.
  assert.equal(adapter.match(/private void RequireOwnTransaction/g).length, 1);
});

test('las purgas son las de keel-nest, con la marca de reconciliation_claim', () => {
  for (const name of SUBJECTS) {
    assert.deepEqual(
      tablePurges(plan(name).model).map((purge) => purge.what),
      nestTablePurges(plan(name, planNest).model).map((purge) => purge.what),
      name
    );
  }
  assert.ok(tablePurges(plan('stock-reservation').model).some((purge) => purge.what === 'reconciliation_claim'));
});

test('registro: Program.cs lee los barridos del perfil y AddPersistence pone la tienda y los defaults', () => {
  const { files } = plan('stock-reservation');
  const program = content(files, '/Program.cs');
  assert.match(program, /builder\.Services\.AddSingleton\(ReconciliationSettings\.From\(configuration\)\);\nbuilder\.Services\.AddPersistence/);
  const registration = content(files, '/Persistence/PersistenceRegistration.cs');
  assert.match(registration, /services\.TryAddSingleton\(ReconciliationSettings\.Defaults\);/);
  assert.match(registration, /services\.AddScoped<ReconciliationClaimStore>\(\);/);
  assert.match(content(files, 'DbContext.cs'), /new ReconciliationClaimRowConfiguration\(\)/);
});

test('las notas: el barrido usa el reclamo generado y el orden de deshacer; la compensación, su guarda', () => {
  const { files } = plan('stock-reservation');
  const sweep = content(files, '/UseCases/ReconcileReservationsCommandHandler.cs').replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(sweep, /EL RECLAMO YA ESTÁ GENERADO: toma el lote con await reservationRepository\.ClaimForReconcileReservationsReserveStock\(cancellationToken\)/);
  // El barrido de stock-reservation DESHACE con cancelStock: la entidad se resuelve antes de llamar.
  assert.match(sweep, /lo DESHACE con inventory\.cancelStock/);
  assert.match(sweep, /CARRERA CON EL CAMINO FELIZ/);
  const release = content(files, '/UseCases/ReleaseReservationCommandHandler.cs').replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(release, /Compensación de inventory — deshace la activación 'reserveStock': la dispara la suscripción a StockRejected/);
  assert.match(release, /la guarda es la transición del agregado/);
});

test('la frontera ya no avisa de la reconciliación ni de la compensación', async () => {
  const { checkSupportedFeatures } = await import('../src/lib/supported-features.js');
  const { manifest, layers } = design('stock-reservation');
  assert.deepEqual(checkSupportedFeatures(manifest, layers), { errors: [], warnings: [] });
});
