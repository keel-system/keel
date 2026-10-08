// La reconciliación y la compensación de keel-nest (incremento 11c), sobre stock-reservation, sin base de
// datos: lo que el servidor de keel-spring del mismo diseño lee y lo que el agente encuentra en el stub. La
// tienda y el reclamo se miden contra PostgreSQL y MySQL reales en `npm run db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { RECONCILIATION_PURGE, reconciledActivations, reconciliationParameters } from 'keel-core/gen/reconciliation-stores';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { RECONCILIATION_SETTINGS_TS } from '../src/scaffold/reconciliation-claim.js';
import { TABLE_PURGES_TS } from '../src/scaffold/purge.js';

const SUBJECT = 'stock-reservation';
const { files, model } = planFixture(SUBJECT);
const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
// Las notas se parten en líneas de comentario: se leen unidas.
const notesOf = (file) => byPath[file].replace(/\n\s*\/\/\s*/g, ' ');

test(`${SUBJECT}: reconciliation.yaml es el de keel-spring en los tres perfiles`, () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  const spring = Object.fromEntries(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.map((file) => [file.path, file.content]));
  for (const profile of ['local', 'develop', 'production']) {
    assert.deepEqual(
      parseYaml(byPath[`config/parameters/${profile}/reconciliation.yaml`]),
      parseYaml(spring[`src/main/resources/parameters/${profile}/reconciliation.yaml`]),
      profile
    );
  }
});

test(`${SUBJECT}: la configuración del código respalda con los mismos defaults de keel-core`, () => {
  const settings = byPath[RECONCILIATION_SETTINGS_TS];
  for (const { activation, sweeper } of reconciledActivations(model)) {
    for (const parameter of Object.values(reconciliationParameters(activation, sweeper))) {
      assert.ok(settings.includes(`positive(configuration, '${parameter.key}', ${parameter.default})`), parameter.key);
    }
  }
});

test(`${SUBJECT}: reconciliation_claim se purga por lotes con el reloj y la retención de keel-spring`, () => {
  const purges = byPath[TABLE_PURGES_TS];
  assert.match(purges, /reconciliation_claim/);
  assert.ok(purges.includes(RECONCILIATION_PURGE.cron.key) && purges.includes(RECONCILIATION_PURGE.cron.default), 'el cron');
  assert.ok(purges.includes(RECONCILIATION_PURGE.retentionDays.key), 'la retención');
});

test(`${SUBJECT}: el barrido usa el reclamo generado, sin transacción abarcadora y en el orden de un deshacer`, () => {
  const notes = notesOf('src/application/usecases/reconcile-reservations-command-handler.ts');
  assert.match(notes, /EL RECLAMO YA ESTÁ GENERADO: toma el lote con this\.reservationRepository\.claimForReconcileReservationsReserveStock\(\)/);
  assert.match(notes, /SIN TRANSACCIÓN ABARCADORA/);
  // reconcileReservations no reintenta reserveStock: lo DESHACE con cancelStock, así que la entidad va primero.
  assert.match(notes, /lo DESHACE con inventory\.cancelStock, así que va al revés que un reintento/);
  assert.match(notes, /CARRERA CON EL CAMINO FELIZ/);
  // Y la nota general de ORDEN (transición antes de la llamada) no aparece: serían dos órdenes en el mismo stub.
  assert.doesNotMatch(notes, /ORDEN de los efectos: aplica PRIMERO/);
  // El puerto lo declara, y el adaptador lo implementa con la tienda.
  assert.match(byPath['src/domain/repository/reservation-repository.ts'], /abstract claimForReconcileReservationsReserveStock\(\): Promise<Reservation\[\]>;/);
  assert.match(byPath['src/infrastructure/persistence/repositories/reservation-repository-impl.ts'], /this\.reconciliationClaims\.claim\('reserveStock', id, now, claimExpiredBefore\)/);
});

test(`${SUBJECT}: la compensación dice qué deshace, qué estado devuelve y cuál es su guarda`, () => {
  const notes = notesOf('src/application/usecases/release-reservation-command-handler.ts');
  assert.match(notes, /Compensación de inventory — deshace la activación 'reserveStock': la dispara la suscripción a StockRejected/);
  assert.match(notes, /movió el lifecycle de Reservation: devolver ese estado es parte de la compensación/);
  assert.match(notes, /la guarda es la transición del agregado/);
});

test(`${SUBJECT}: la tienda y la configuración están en el módulo de persistencia`, () => {
  const module = byPath['src/infrastructure/persistence/persistence-module.ts'];
  assert.match(module, /\{ provide: RECONCILIATION_SETTINGS, useValue: reconciliationSettings\(configuration\) \}/);
  assert.match(module, /ReconciliationClaimStore/);
  assert.match(byPath['src/infrastructure/persistence/data-source-options.ts'], /ReconciliationClaimOrm/);
});

test('sin reconciledBy no se emite nada de la reconciliación', () => {
  const bare = planFixture('product-catalog').files.map((file) => file.path);
  assert.ok(!bare.some((file) => /reconciliation/.test(file)));
});
