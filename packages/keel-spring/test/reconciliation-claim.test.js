import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadService, supportedDsl } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { generate as generateReconciliationClaim } from '../src/scaffold/reconciliation-claim.js';
import { generate as generateRepositories } from '../src/scaffold/repositories.js';
import { generate as generateDocumentRepositories } from '../src/scaffold/document-repositories.js';
import { generate as generateServices } from '../src/scaffold/services.js';
import { warnUnsupportedDialect } from '../src/scaffold/claim.js';

// El barrido de una reconciliación es el caso extremo del reclamo: corre en todas las
// réplicas Y lleva una llamada al proveedor entre reclamar y actuar. Por eso su marca no
// puede ser un lock —solo aísla mientras dura su transacción— sino una fila que sobrevive
// al commit y caduca. Estos tests fijan lo que build genera y, tan importante como eso,
// cuándo NO lo genera: inventar la marca de espera sería elegir por el diseño.

const fixture = (name) =>
  loadService(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name));

function modelFor({ database = 'postgresql', persistence = 'relational', mutate = null } = {}) {
  const service = fixture('stock-reservation');
  const layers = structuredClone(service.layers);
  if (mutate) mutate(layers);
  const stack = { database, broker: 'kafka', auth: null, cache: null, storage: null };
  const model = buildModel({ manifest: service.manifest, layers, stack });
  model.stack = stack;
  model.persistenceKind = persistence;
  return model;
}

function documentModel() {
  const service = fixture('asset-vault');
  const stack = { database: 'mongodb', broker: 'kafka', auth: null, cache: null, storage: 'minio' };
  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
  model.stack = stack;
  return model;
}

const claimOf = (model) =>
  model.services
    .flatMap((s) => s.operations)
    .flatMap((op) => op.reconciles ?? [])
    .map((r) => r.claim)[0];

const fileNamed = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

test('el reclamo sale del diseño: entidad en espera, sus estados y la marca de CUÁNDO', () => {
  const claim = claimOf(modelFor());

  assert.deepEqual(
    { entity: claim.entity, states: claim.states, awaitingField: claim.awaitingField, method: claim.method },
    {
      entity: 'Reservation',
      states: ['awaitingStock'],
      // El estado dice que espera; esto dice cuánto lleva. Sin él no hay umbral que aplicar.
      awaitingField: 'reserveStockAwaitingSince',
      method: 'claimForReconcileReservationsReserveStock'
    }
  );
});

test('la marca vive en una tabla propia de build, no en la entidad del diseño', () => {
  const files = generateReconciliationClaim(modelFor());
  const entity = fileNamed(files, 'ReconciliationClaimJpa.java');

  assert.match(entity, /@Table\(name = "reconciliation_claim"/);
  // Clave compuesta: una entidad puede esperar dos desenlaces, y una marca compartida
  // haría que el segundo encargo pisara el reclamo del primero.
  assert.match(entity, /class ReconciliationClaimId implements Serializable/);
  assert.match(entity, /name = "activation"/);
  assert.match(entity, /name = "entity_id"/);
  // Sin Persistable, la clave ASIGNADA hace que Spring Data deduzca merge(): el INSERT no
  // violaría nada y las dos réplicas creerían haber reclamado.
  assert.match(entity, /implements Persistable<ReconciliationClaimJpa\.ReconciliationClaimId>/);
});

test('el reclamo es una marca que caduca, y las dos vías de la carrera dicen que no', () => {
  const files = generateReconciliationClaim(modelFor());
  const repository = fileNamed(files, 'ReconciliationClaimJpaRepository.java');
  const store = fileNamed(files, 'ReconciliationClaimStore.java');

  // Renovar solo lo caducado: 1 fila = es mía, y esa comparación no depende del motor.
  assert.match(repository, /update ReconciliationClaimJpa c set c\.claimedAt = :now/);
  assert.match(repository, /c\.claimedAt <= :expiredBefore/);
  assert.match(repository, /int claimIfExpired\(/);
  // Y si la fila no existía, la clave primaria arbitra la inserción simultánea — por sus DOS
  // desenlaces: InnoDB hace esperar al segundo INSERT sobre el lock del primero, y si tarda
  // sale por lock-wait o deadlock, que Spring traduce a PessimisticLockingFailure y no a
  // DataIntegrityViolation. Con solo la primera, el barrido revienta en vez de ceder el
  // candidato — y justo cuando hay competencia, que es lo único que este reclamo arbitra.
  assert.match(
    store,
    /catch \(DataIntegrityViolationException\s*\|\s*PessimisticLockingFailureException\s*\|\s*TransactionSystemException race\)/
  );
  assert.match(store, /return false;/);
  // La inserción va en un bean aparte: capturar la violación dentro de la misma
  // transacción la dejaría rollback-only.
  assert.match(fileNamed(files, 'ReconciliationClaimWriter.java'), /REQUIRES_NEW/);
});

test('el puerto expone el reclamo sin batchSize: el handler no puede leer configuración', () => {
  const model = modelFor();
  const port = fileNamed(generateRepositories(model), 'ReservationRepository.java');

  assert.match(port, /List<Reservation> claimForReconcileReservationsReserveStock\(\);/);
  assert.match(port, /Reclama, no lee/);
});

test('los tres números se leen de parameters/, y el umbral trae el valor del diseño', () => {
  const adapter = fileNamed(generateRepositories(modelFor()), 'ReservationRepositoryImpl.java');

  assert.match(adapter, /reconciliation\.reserve-stock\.unanswered-after-seconds:1800/);
  assert.match(adapter, /reconciliation\.reserve-stock\.claim-timeout-ms:60000/);
  assert.match(adapter, /reconciliation\.reserve-stock\.batch-size:50/);
  // El candidato se elige por la marca de espera y el lote va acotado.
  assert.match(adapter, /PageRequest\.of\(0, reserveStockBatchSize\)/);
  assert.match(adapter, /reconciliationClaims\.claim\("reserveStock", id, now, claimExpiredBefore\)/);
  // Y el reclamo se confirma antes de volver, o no lo ven las demás réplicas.
  assert.match(adapter, /@Transactional\n    public List<Reservation> claimForReconcileReservationsReserveStock/);
});

test('SKIP LOCKED solo donde el motor reparte, y es lo ÚNICO que cambia con el dialecto', () => {
  const withSkip = fileNamed(generateRepositories(modelFor()), 'ReservationJpaRepository.java');
  assert.match(withSkip, /@Lock\(LockModeType\.PESSIMISTIC_WRITE\)/);
  assert.match(withSkip, /jakarta\.persistence\.lock\.timeout/);

  const h2Model = modelFor({ database: 'h2' });
  const withoutSkip = fileNamed(generateRepositories(h2Model), 'ReservationJpaRepository.java');
  assert.ok(!withoutSkip.includes('PESSIMISTIC_WRITE'));
  assert.ok(!withoutSkip.includes('import jakarta.persistence.LockModeType;'), 'import sin uso');
  // El reclamo sigue estando: lo garantiza la tabla, no la consulta.
  assert.match(withoutSkip, /candidatesForReconcileReservationsReserveStock/);
  assert.match(
    fileNamed(generateRepositories(h2Model), 'ReservationRepositoryImpl.java'),
    /reconciliationClaims\.claim\(/
  );

  warnUnsupportedDialect(h2Model);
  assert.ok(
    h2Model.warnings.some((w) => w.includes('h2 no tiene SKIP LOCKED') && w.includes('claimForReconcileReservationsReserveStock()')),
    h2Model.warnings.join('\n')
  );
});

test('en el modelo documental el reclamo es el mismo, sin lock y con upsert atómico', () => {
  // `asset-vault` tal cual, que es la silueta documental de la suite: su marca de espera
  // no sigue la convención de nombre —es la variante de DERIVA, donde no se espera un
  // desenlace sino que se revalida una creencia— y aun así el reclamo se genera, porque
  // la marca la declara el diseño. Al ser una fixture real, este Java pasa además por el
  // tokenizador de java-syntax en sus tres filas de la MATRIX.
  const model = documentModel();
  const store = fileNamed(generateReconciliationClaim(model), 'ReconciliationClaimStore.java');
  const adapter = fileNamed(generateDocumentRepositories(model), 'AssetRepositoryImpl.java');

  assert.match(store, /mongoTemplate\.upsert\(query, update, ReconciliationClaimDocument\.class\)/);
  // Las DOS familias: el upsert puede correr dentro de una transacción de Mongo, y ahí un
  // fallo al confirmar llega como TransactionSystemException — que no es DataAccessException
  // y se escapaba del catch. Es el gemelo del arreglo que la corrida de MySQL obligó a hacer
  // en la rama relacional.
  assert.match(store, /catch \(DuplicateKeyException \| TransactionSystemException race\)/);
  assert.match(adapter, /public List<Asset> claimForReconcileScansScanAsset\(\)/);
  assert.match(adapter, /private final ReconciliationClaimStore reconciliationClaims;/);
  // El predicado sale del diseño: estado de espera + la marca que declara awaitingSince.
  assert.match(adapter, /Criteria\.where\("lastScannedAt"\)\.lt\(staleBefore\)/);
  assert.match(adapter, /reconciliation\.scan-asset\.unanswered-after-seconds:900/);
  // Y ningún lock: en Mongo no lo hay, y aquí no haría falta aunque lo hubiera.
  assert.ok(!adapter.includes('PESSIMISTIC'));

  // El dialecto no entra: Mongo no tiene el problema que SKIP LOCKED resuelve.
  warnUnsupportedDialect(model);
  assert.deepEqual(model.warnings.filter((w) => w.includes('SKIP LOCKED')), []);
});

test('la nota del handler manda LLAMAR al reclamo, no escribir otro', () => {
  const model = modelFor();
  const handler = fileNamed(generateServices(model), 'ReconcileReservationsCommandHandler.java');

  assert.match(handler, /EL RECLAMO YA ESTÁ GENERADO/);
  assert.match(handler, /claimForReconcileReservationsReserveStock\(\)/);
  assert.match(handler, /NO escribas otro reclamo/);
  // Lo que sigue siendo del agente: el orden de los commits y la carrera.
  assert.match(handler, /ORDEN: son DOS commits/);
  assert.match(handler, /CARRERA CON EL CAMINO FELIZ/);
  // Y lo que ya no le pide: inventar una columna que build no genera.
  assert.ok(!handler.includes('ClaimedAt = now'));
});

test('con DOS entidades esperando, build no elige: avisa y el barrido vuelve a ser del agente', () => {
  // El hueco que la validación NO cierra, y por eso sigue siendo del generador: con dos
  // entidades en espera, «el lote» deja de estar definido —¿un reclamo por cada una?, ¿con
  // el umbral de cuál?— y elegir por el diseño sería inventar. El de la marca ausente ya no
  // se alcanza: `awaitingSince` es obligatorio con `reconciledBy` desde el DSL 2.10 y lo
  // rechaza `keel validate`, que es donde tiene que salir.
  //
  // El diseño va escrito aquí y no mutando una fixture porque ninguna tiene esta forma, y
  // dársela para un caso negativo la deformaría para todos los demás tests.
  const waitingState = (name) => ({
    description: `Entidad ${name}.`,
    fields: {
      id: { type: 'uuid', id: true, generated: true },
      status: { type: 'enum', values: ['pending', 'awaiting'], required: true, default: 'pending' },
      orderShipmentAwaitingSince: { type: 'timestamp', description: 'Desde cuándo espera.' }
    },
    lifecycle: { field: 'status', transitions: { pending: ['awaiting'], awaiting: [] } }
  });
  const layers = {
    domain: {
      entities: { Shipment: waitingState('Shipment'), Parcel: waitingState('Parcel') },
      aggregates: { Shipment: { root: 'Shipment', entities: [] }, Parcel: { root: 'Parcel', entities: [] } }
    },
    'use-cases': {
      operations: {
        requestShipment: {
          description: 'Encarga el transporte al operador logístico.',
          kind: 'command',
          input: 'void',
          output: 'void',
          transitions: [
            { entity: 'Shipment', from: ['pending'], to: 'awaiting' },
            { entity: 'Parcel', from: ['pending'], to: 'awaiting' }
          ]
        },
        reconcileShipments: {
          description: 'Barre los encargos de transporte sin desenlace.',
          kind: 'command',
          internal: true,
          input: 'void',
          output: 'void',
          schedule: { cron: '* * * * *' }
        }
      }
    },
    persistence: { entities: { Shipment: {}, Parcel: {} } },
    dependencies: {
      dependencies: {
        carrier: {
          description: 'Operador logístico.',
          activations: {
            orderShipment: {
              description: 'Encarga la recogida.',
              triggeredBy: ['requestShipment', 'reconcileShipments'],
              via: { publishes: 'ShipmentRequested' },
              effect: 'El operador recoge el paquete.',
              reconciledBy: 'reconcileShipments',
              unansweredAfterSeconds: 600,
              awaitingSince: 'orderShipmentAwaitingSince'
            }
          }
        }
      }
    }
  };
  const stack = { database: 'postgresql', broker: 'kafka', auth: null, cache: null, storage: null };
  const model = buildModel({
    manifest: { keel: supportedDsl()[0], service: { name: 'logistics', version: '0.1.0' }, layers: {} },
    layers,
    stack
  });
  model.stack = stack;

  assert.equal(claimOf(model), null);
  assert.ok(
    model.warnings.some(
      (w) => w.includes('no puede generarle el reclamo') && w.includes('Shipment y Parcel')
    ),
    model.warnings.join('\n')
  );
  assert.deepEqual(generateReconciliationClaim(model), []);
  // Y la nota larga —la que le explica al agente cómo reclamar— vuelve.
  const handler = fileNamed(generateServices(model), 'ReconcileShipmentsCommandHandler.java');
  assert.match(handler, /MARCA PERSISTIDA/);
});

// ─── El reloj de la espera lo estampa el reclamo que la crea ─────────────────
//
// El gemelo simétrico del defecto del reclamo de cola. `confirmReservation` deja la reserva
// en `awaitingStock`, y ES un reclamo quien la pone ahí cuando el barrido lo hace: si el
// `awaitingSince` se estampara en una escritura posterior, la réplica que muriese en medio
// dejaría la fila esperando con la marca a NULL, y la reconciliación —que filtra por
// `awaitingSince < :staleBefore`— no la miraría jamás. Justo la fila que más necesita que
// alguien la mire: la que se quedó a medias.

test('un reclamo que deja la fila esperando estampa el awaitingSince del diseño', () => {
  // Se convierte `confirmReservation` en un barrido: pasa a moverse por reloj, sin id ni
  // cuerpo, de modo que sea un RECLAMO quien deje la reserva en `awaitingStock`.
  const model = modelFor({
    mutate: (layers) => {
      const op = layers['use-cases'].operations.confirmReservation;
      op.input = 'void';
      op.output = 'void';
      op.internal = true;
      op.schedule = { cron: '* * * * *' };
    }
  });

  const claim = model.services
    .flatMap((service) => service.operations)
    .flatMap((operation) => operation.claim ?? [])
    .find((entry) => entry.to === 'awaitingStock');
  assert.ok(claim, 'no se generó el reclamo que deja la reserva esperando');
  assert.deepEqual(claim.stamps, {
    field: 'reserveStockAwaitingSince',
    reason: 'el barrido de reconciliación'
  });

  const jpa = generateRepositories(model).find((file) => file.path.endsWith('ReservationJpaRepository.java'));
  assert.match(jpa.content, /set e\.status = :to, e\.reserveStockAwaitingSince = :claimedAt/);
});
