import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { generate as generateOutbox } from '../src/scaffold/outbox.js';
import { generate as generateRepositories } from '../src/scaffold/repositories.js';
import { warnUnsupportedDialect } from '../src/scaffold/claim.js';
import { supportsSkipLocked } from '../src/lib/claim-sql.js';

// Un barrido corre en TODAS las réplicas: @Scheduled es «una vez por instancia», no «una
// vez en el clúster». Estos tests fijan qué reclamo genera build y —tan importante como
// eso— cuál NO genera: un reclamo inventado sobre el estado equivocado le arranca el
// trabajo de las manos a la réplica que lo está haciendo.

const manifest = { keel: '2.0', service: { name: 'dispatch', version: '0.1.0' }, layers: {} };

function layersWith({ sweepTransitions, extraOps = {}, subscriptions = null }) {
  return {
    domain: {
      entities: {
        Job: {
          description: 'Trabajo encolado.',
          fields: {
            id: { type: 'uuid', id: true, generated: true },
            status: { type: 'enum', values: ['queued', 'running', 'done'] },
            createdAt: { type: 'timestamp', generated: true }
          },
          lifecycle: { field: 'status', transitions: { queued: ['running'], running: ['done'], done: [] } }
        }
      },
      aggregates: { Job: { root: 'Job', entities: [] } }
    },
    'use-cases': {
      operations: {
        drainJobs: {
          description: 'Toma los trabajos encolados y los ejecuta.',
          kind: 'command',
          input: 'void',
          output: 'void',
          schedule: { cron: '* * * * *' },
          ...(sweepTransitions ? { transitions: sweepTransitions } : {})
        },
        ...extraOps
      }
    },
    persistence: { entities: { Job: {} } },
    ...(subscriptions ? { messaging: { subscriptions } } : {})
  };
}

// `model.stack` lo cuelga scaffoldService después de construir el modelo, y de él sale
// la decisión de dialecto. Aquí se replica ese paso porque los tests llaman al generador
// de repositorios directamente, sin pasar por el scaffolding completo.
const modelFor = (layers, database = 'postgresql') => {
  const stack = { database, broker: 'kafka' };
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return model;
};

const sweepOf = (model, name = 'drainJobs') =>
  model.services.flatMap((service) => service.operations).find((operation) => operation.name === name);

const fileNamed = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

const queueSweep = () => layersWith({ sweepTransitions: [{ entity: 'Job', from: ['queued'], to: 'running' }] });

test('un barrido que saca filas de la COLA recibe su reclamo generado', () => {
  const sweep = sweepOf(modelFor(queueSweep()));

  assert.equal(sweep.sweep, true);
  assert.deepEqual(
    sweep.claim.map((claim) => [claim.from.join(), claim.to, claim.method]),
    [['queued', 'running', 'claimForDrainJobs']]
  );
});

test('el reclamo es un UPDATE condicional, no un finder: es lo único que no depende del motor', () => {
  const files = generateRepositories(modelFor(queueSweep()));
  const jpa = fileNamed(files, 'JobJpaRepository.java');
  const adapter = fileNamed(files, 'JobRepositoryImpl.java');

  // El WHERE con el estado de partida ES la exclusión mutua: 1 = la fila era mía.
  assert.match(jpa, /@Modifying/);
  assert.match(jpa, /update JobJpa e set e\.status = :to where e\.id = :id and e\.status in :states/);
  assert.match(jpa, /int claimForDrainJobs\(/);
  // El orden no es opcional: sin ORDER BY el «más antiguo primero» deja de cumplirse.
  assert.match(jpa, /order by e\.createdAt asc/);

  // El reclamo se commitea antes de volver, o no lo ven las demás réplicas.
  assert.match(adapter, /@Transactional\(propagation = Propagation\.REQUIRES_NEW\)/);
  assert.match(adapter, /== 1\)/);
});

test('el puerto expone el reclamo, que es lo que hace que no usarlo cueste más que usarlo', () => {
  const port = fileNamed(generateRepositories(modelFor(queueSweep())), 'JobRepository.java');

  assert.match(port, /List<Job> claimForDrainJobs\(int batchSize\);/);
  assert.match(port, /Reclama, no lee/);
});

test('con SKIP LOCKED el select de candidatos lo pide; sin él, se dice en voz alta', () => {
  const jpaWith = fileNamed(generateRepositories(modelFor(queueSweep(), 'postgresql')), 'JobJpaRepository.java');
  assert.match(jpaWith, /@Lock\(LockModeType\.PESSIMISTIC_WRITE\)/);
  assert.match(jpaWith, /jakarta\.persistence\.lock\.timeout/);

  const withoutSkip = modelFor(queueSweep(), 'h2');
  const jpaWithout = fileNamed(generateRepositories(withoutSkip), 'JobJpaRepository.java');
  // Sin reparto el reclamo SIGUE siendo correcto: lo garantiza el UPDATE, no el lock.
  assert.ok(!jpaWithout.includes('PESSIMISTIC_WRITE'));
  assert.match(jpaWithout, /update JobJpa e set e\.status = :to/);
  assert.match(jpaWithout, /no tiene SKIP LOCKED/);

  warnUnsupportedDialect(withoutSkip);
  assert.ok(withoutSkip.warnings.some((warning) => warning.includes('h2 no tiene SKIP LOCKED')));
  assert.equal(supportsSkipLocked('h2'), false);
  assert.equal(supportsSkipLocked('postgresql'), true);
});

test('un barrido que saca filas de un estado EN VUELO no recibe reclamo: es un rescate', () => {
  // `running` es un estado al que otra transición lleva: hay una réplica trabajando en
  // esas filas AHORA. Reclamarlas todas se lo arrancaría de las manos, y el rescate
  // legítimo necesita una cota temporal («lleva más de N minutos ahí») que el DSL no
  // declara y que build no puede inventar.
  const model = modelFor(layersWith({ sweepTransitions: [{ entity: 'Job', from: ['running'], to: 'done' }] }));

  assert.equal(sweepOf(model).sweep, true);
  assert.equal(sweepOf(model).claim, null);
  assert.ok(
    model.warnings.some((warning) => warning.includes('EN VUELO') && warning.includes('drainJobs')),
    model.warnings.join('\n')
  );
  assert.ok(!fileNamed(generateRepositories(model), 'JobJpaRepository.java').includes('claimForDrainJobs'));
});

test('una purga sin transiciones no es un barrido que reclame', () => {
  // Borrar lo caducado es idempotente por forma: solaparse entre réplicas no produce
  // ningún efecto doble, así que no hay nada que reclamar.
  assert.equal(sweepOf(modelFor(layersWith({ sweepTransitions: null }))).sweep, undefined);
});

test('una operación que RECIBE el id de lo que procesa no reclama: eligió el llamante', () => {
  const model = modelFor(
    layersWith({
      sweepTransitions: [{ entity: 'Job', from: ['queued'], to: 'running' }],
      extraOps: {
        runJob: {
          description: 'Ejecuta un trabajo concreto.',
          kind: 'command',
          internal: true,
          input: { fields: { jobId: { type: 'uuid', required: true } } },
          output: 'void',
          schedule: { cron: '* * * * *' },
          transitions: [{ entity: 'Job', from: ['queued'], to: 'running' }]
        }
      }
    })
  );
  assert.equal(sweepOf(model, 'runJob').sweep, undefined);
});

test('una operación disparada por una suscripción no es un barrido: procesa su mensaje', () => {
  const model = modelFor(
    layersWith({
      sweepTransitions: [{ entity: 'Job', from: ['queued'], to: 'running' }],
      subscriptions: { JobRequested: { triggers: 'drainJobs', payload: {} } }
    })
  );
  assert.equal(sweepOf(model).sweep, undefined);
});

// ─── El mismo criterio en el relay del outbox ────────────────────────────────
//
// El relay lee candidatos desde N réplicas exactamente igual que un barrido, así que la
// decisión de dialecto tiene que ser la MISMA — y estaba quemada. Emitir el hint donde el
// motor no lo entiende no es inocuo: H2 lo acepta y lo IGNORA (el javadoc prometía
// reparto y no lo había) y MySQL 5.7, MariaDB <10.6 u Oracle 11 fallan por sintaxis.

const outboxModel = (database) => {
  const service = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stock-reservation')
  );
  const stack = { database, broker: 'kafka', auth: null, cache: null, storage: null };
  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
  model.stack = stack;
  return model;
};

test('el relay del outbox reclama con SKIP LOCKED solo donde el motor lo tiene', () => {
  const withSkip = fileNamed(generateOutbox(outboxModel('postgresql')), 'OutboxEventJpaRepository.java');
  assert.match(withSkip, /@Lock\(LockModeType\.PESSIMISTIC_WRITE\)/);
  assert.match(withSkip, /jakarta\.persistence\.lock\.timeout/);
  assert.match(withSkip, /import jakarta\.persistence\.LockModeType;/);

  const withoutSkip = fileNamed(generateOutbox(outboxModel('h2')), 'OutboxEventJpaRepository.java');
  assert.ok(!withoutSkip.includes('PESSIMISTIC_WRITE'));
  // Los imports del lock son condicionales, o quedarían sin usar.
  assert.ok(!withoutSkip.includes('import jakarta.persistence.LockModeType;'));
  assert.ok(!withoutSkip.includes('import org.springframework.data.jpa.repository.Lock;'));
  // Y la consulta sigue entera: la entrega no se duplica porque la fila se marca dentro
  // de la transacción del relay, no porque el lock la aísle.
  assert.match(withoutSkip, /List<OutboxEventJpa> findPending\(/);
  assert.match(withoutSkip, /o\.publishedAt is null and o\.attempts < :maxAttempts/);
  assert.ok(withoutSkip.includes('no reparte'), 'el javadoc tiene que decir que no hay reparto');
});

test('el aviso de dialecto es UNO solo y enumera todos los mecanismos afectados', () => {
  const model = outboxModel('h2');
  warnUnsupportedDialect(model);

  const warnings = model.warnings.filter((warning) => warning.includes('SKIP LOCKED'));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /OutboxRelay\.findPending\(\)/);
  assert.match(warnings[0], /claimForReconcileReservationsReserveStock\(\)/);

  // Y con un motor que sí reparte no se avisa de nada.
  const fine = outboxModel('postgresql');
  warnUnsupportedDialect(fine);
  assert.deepEqual(fine.warnings.filter((warning) => warning.includes('SKIP LOCKED')), []);
});

test('el aviso de dialecto alcanza también al barrido cuyo reclamo NO generó build', () => {
  // El caso que se quedaba fuera, y es el que MÁS lo necesita: cuando build no genera el
  // reclamo (rescate de filas en vuelo), las dos capas las escribe el agente — y la que
  // depende del motor es justo la que nadie le iba a mencionar. `warnUnsupportedDialect`
  // solo recorría `operation.claim`, que aquí está vacío, así que callaba.
  const model = modelFor(layersWith({ sweepTransitions: [{ entity: 'Job', from: ['running'], to: 'done' }] }), 'h2');

  assert.equal(sweepOf(model).claim, null, 'la premisa del test: build no generó reclamo');
  model.warnings = [];
  warnUnsupportedDialect(model);

  assert.equal(model.warnings.length, 1, model.warnings.join('\n'));
  assert.match(model.warnings[0], /h2 no tiene SKIP LOCKED/);
  assert.match(model.warnings[0], /drainJobs/);
});

test('y con un motor que sí reparte no se avisa de nada', () => {
  // La simétrica: el aviso habla de un motor concreto, no del barrido. Sin ella, un
  // `push` incondicional pasaría este archivo entero igual.
  const model = modelFor(layersWith({ sweepTransitions: [{ entity: 'Job', from: ['running'], to: 'done' }] }), 'postgresql');
  model.warnings = [];
  warnUnsupportedDialect(model);

  assert.deepEqual(model.warnings, []);
});
