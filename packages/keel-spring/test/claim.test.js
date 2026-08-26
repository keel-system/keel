import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { generate as generateOutbox } from '../src/scaffold/outbox.js';
import { generate as generateRepositories } from '../src/scaffold/repositories.js';
import { generate as generateDocumentRepositories } from '../src/scaffold/document-repositories.js';
import { warnUnsupportedDialect } from '../src/scaffold/claim.js';
import { supportsSkipLocked } from '../src/lib/claim-sql.js';

// Un barrido corre en TODAS las réplicas: @Scheduled es «una vez por instancia», no «una
// vez en el clúster». Estos tests fijan qué reclamo genera build y —tan importante como
// eso— cuál NO genera: un reclamo inventado sobre el estado equivocado le arranca el
// trabajo de las manos a la réplica que lo está haciendo.

const manifest = { keel: '2.0', service: { name: 'dispatch', version: '0.1.0' }, layers: {} };

function layersWith({ sweepTransitions, extraOps = {}, subscriptions = null, stampField = null, extraStates = [] }) {
  const states = ['queued', 'running', ...extraStates, 'done'];
  const transitions = { queued: ['running'], running: ['done', ...extraStates], done: [] };
  for (const state of extraStates) transitions[state] = ['done'];
  return {
    domain: {
      entities: {
        Job: {
          description: 'Trabajo encolado.',
          fields: {
            id: { type: 'uuid', id: true, generated: true },
            status: { type: 'enum', values: states },
            createdAt: { type: 'timestamp', generated: true },
            // El reloj del rescate: cuándo entró la fila en el estado en vuelo. Lo declara
            // el diseño porque no hay ningún otro campo que signifique eso.
            ...(stampField ? { [stampField]: { type: 'timestamp' } } : {})
          },
          lifecycle: { field: 'status', transitions }
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

// ─── El rescate de un estado EN VUELO ────────────────────────────────────────
//
// `running` es un estado al que otra transición lleva: hay una réplica trabajando en esas
// filas AHORA. Reclamarlas a secas se lo arrancaría de las manos, así que el rescate solo
// existe con una cota temporal encima. La cota tiene dos mitades y solo una la aporta el
// diseño: el RELOJ (el campo que dice cuándo se entró en el estado) y el PLAZO, que es la
// caducidad de un reclamo y vive en parameters/. Sin el reloj no hay rescate que generar.

const rescueSweep = () =>
  layersWith({
    sweepTransitions: [{ entity: 'Job', from: ['running'], to: 'done' }],
    stampField: 'runningSince'
  });

test('un rescate con su reloj declarado SÍ recibe reclamo, y es el de la cola más una cota', () => {
  const model = modelFor(rescueSweep());
  const [claim] = sweepOf(model).claim;

  assert.equal(sweepOf(model).sweep, true);
  assert.equal(claim.method, 'claimForStalledDrainJobs');
  assert.deepEqual(claim.from, ['running']);
  assert.equal(claim.stalled.stampField, 'runningSince');
  assert.equal(claim.stalled.configKey, 'drain-jobs');
  // Y ya no se avisa de un hueco que dejó de serlo.
  assert.deepEqual(model.warnings.filter((warning) => warning.includes('EN VUELO')), []);
});

test('la cota va en las DOS consultas: sin ella en el UPDATE se rescata lo que acaba de entrar', () => {
  const jpa = fileNamed(generateRepositories(modelFor(rescueSweep())), 'JobJpaRepository.java');

  assert.match(
    jpa,
    /select e\.id from JobJpa e where e\.status in :states and e\.runningSince < :staleBefore order by e\.runningSince asc/
  );
  assert.match(
    jpa,
    /update JobJpa e set e\.status = :to where e\.id = :id and e\.status in :states and e\.runningSince < :staleBefore/
  );
  assert.match(jpa, /int claimForStalledDrainJobs\(.*Instant staleBefore\);/);
  assert.match(jpa, /import java\.time\.Instant;/);
});

test('el plazo es del generador y se lee por @Value en el ADAPTADOR, no en el handler', () => {
  const adapter = fileNamed(generateRepositories(modelFor(rescueSweep())), 'JobRepositoryImpl.java');

  assert.match(adapter, /@Value\("\$\{sweep\.drain-jobs\.stalled-after-seconds:300\}"\)/);
  assert.match(adapter, /private long stalledDrainJobsAfterSeconds;/);
  // Se calcula UNA vez por tanda: recalcularlo por fila movería la cota entre el select
  // y el update de cada una.
  assert.match(adapter, /Instant staleBefore = Instant\.now\(\)\.minusSeconds\(stalledDrainJobsAfterSeconds\);/);
  assert.match(adapter, /candidatesForStalledDrainJobs\(states, staleBefore, PageRequest\.of\(0, batchSize\)\)/);
  assert.match(adapter, /claimForStalledDrainJobs\(id, states, JobStatus\.DONE, staleBefore\) == 1/);
  assert.match(adapter, /@Transactional\(propagation = Propagation\.REQUIRES_NEW\)/);
});

test('el rescate documental filtra y marca en el mismo findAndModify, y por el más viejo', () => {
  const model = modelFor(rescueSweep(), 'mongodb');
  const adapter = fileNamed(generateDocumentRepositories(model), 'JobRepositoryImpl.java');

  assert.match(adapter, /\.and\("runningSince"\)\.lt\(staleBefore\)/);
  // Sin orden, con más atascados que batchSize los más antiguos no se rescatarían nunca.
  assert.match(adapter, /Sort\.by\(Sort\.Direction\.ASC, "runningSince"\)/);
  assert.match(adapter, /findAndModify\(query, update, options, JobDocument\.class\)/);
});

test('sin el reloj no se inventa ninguno: no hay reclamo y el aviso dice qué falta', () => {
  // La entidad no declara cuándo entró en `running`. `createdAt` es cuándo NACIÓ la fila,
  // no cuándo empezó este trabajo, y usarlo rescataría filas recién tomadas.
  const model = modelFor(layersWith({ sweepTransitions: [{ entity: 'Job', from: ['running'], to: 'done' }] }));

  assert.equal(sweepOf(model).sweep, true);
  assert.equal(sweepOf(model).claim, null);
  const warning = model.warnings.find((w) => w.includes('EN VUELO') && w.includes('drainJobs'));
  assert.ok(warning, model.warnings.join('\n'));
  assert.match(warning, /runningSince o runningAt/);
  assert.ok(!fileNamed(generateRepositories(model), 'JobJpaRepository.java').includes('claimForStalledDrainJobs'));
});

test('con dos estados en vuelo hay dos relojes, así que tampoco se genera', () => {
  const model = modelFor(
    layersWith({
      sweepTransitions: [{ entity: 'Job', from: ['running', 'retrying'], to: 'done' }],
      stampField: 'runningSince',
      extraStates: ['retrying']
    })
  );

  assert.equal(sweepOf(model).claim, null);
  assert.ok(
    model.warnings.some((warning) => warning.includes('son dos estados en vuelo')),
    model.warnings.join('\n')
  );
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

// ─── El reloj del reclamo ────────────────────────────────────────────────────
//
// Un reclamo que solo mueve el estado deja una ventana entre su commit (transacción
// propia) y la escritura que estampa el reloj. La réplica que muera ahí deja la fila en el
// estado nuevo con el reloj a NULL — y quien vendría a recogerla filtra por
// `reloj < :staleBefore`, donde NULL no es «viejo», es UNKNOWN. Esa fila no vuelve a entrar
// en ningún lote nunca más: el fallo que el rescate existía para cerrar, un paso antes.
//
// Lo destapó una corrida en vivo, y ningún gate ni ningún FL-* lo veía: el escenario del
// rescate coloca la fila CON el reloj puesto, que es el estado posterior a la ventana.

/** Una cola que desemboca en un estado en vuelo, que es donde vive el defecto. */
const queueThenRescue = () =>
  layersWith({
    sweepTransitions: [
      { entity: 'Job', from: ['queued'], to: 'running' },
      { entity: 'Job', from: ['running'], to: 'done' }
    ],
    stampField: 'runningSince'
  });

test('el reclamo de una COLA estampa el reloj del rescate en su propio UPDATE', () => {
  const model = modelFor(queueThenRescue());
  const [queue, rescue] = sweepOf(model).claim;

  assert.equal(queue.method, 'claimForDrainJobsRunning');
  assert.deepEqual(queue.stamps, { field: 'runningSince', reason: 'el rescate del barrido' });
  // El rescate SACA de `running`, no mete: su destino (`done`) no lo espera ningún reloj.
  assert.equal(rescue.method, 'claimForStalledDrainJobsDone');
  assert.equal(rescue.stamps, undefined);

  const jpa = fileNamed(generateRepositories(model), 'JobJpaRepository.java');
  assert.match(
    jpa,
    /update JobJpa e set e\.status = :to, e\.runningSince = :claimedAt where e\.id = :id and e\.status in :states"\)/
  );
  assert.match(jpa, /int claimForDrainJobsRunning\(.*@Param\("claimedAt"\) Instant claimedAt\);/);
});

test('el instante es uno por tanda, no uno por fila', () => {
  const adapter = fileNamed(generateRepositories(modelFor(queueThenRescue())), 'JobRepositoryImpl.java');

  // Fuera del bucle: recalcularlo por fila daría relojes distintos a filas que la misma
  // instancia se llevó en la misma pasada.
  const method = adapter.slice(adapter.indexOf('claimForDrainJobsRunning(int batchSize)'));
  const body = method.slice(0, method.indexOf('\n    }'));
  assert.match(body, /Instant claimedAt = Instant\.now\(\);[\s\S]*for \(UUID id : candidates\)/);
  assert.match(body, /claimForDrainJobsRunning\(id, states, JobStatus\.RUNNING, claimedAt\) == 1/);
});

test('sin nadie que espere ese reloj, el reclamo no estampa nada', () => {
  // `drainJobs` saca de la cola y punto: a `done` no lo barre ningún mecanismo con cota,
  // así que estampar ahí sería escribir en una columna que nadie lee.
  const model = modelFor(queueSweep());
  const [claim] = sweepOf(model).claim;

  assert.equal(claim.stamps, undefined);
  const jpa = fileNamed(generateRepositories(model), 'JobJpaRepository.java');
  assert.match(jpa, /update JobJpa e set e\.status = :to where e\.id = :id and e\.status in :states"\)/);
  assert.ok(!jpa.includes('claimedAt'));
});

test('la rama documental estampa el reloj dentro del mismo findAndModify', () => {
  const adapter = fileNamed(generateDocumentRepositories(modelFor(queueThenRescue(), 'mongodb')), 'JobRepositoryImpl.java');

  // En el mismo Update: fuera de él habría la misma ventana que en SQL.
  assert.match(adapter, /new Update\(\)\.set\("status", JobStatus\.RUNNING\)\.set\("runningSince", claimedAt\)/);
  assert.match(adapter, /Instant claimedAt = Instant\.now\(\);/);
});

test('el reclamo de una cola fija READ_COMMITTED donde el motor lo exige', () => {
  // Es el mismo defecto de gap locks que destapó la corrida de MySQL, visto sobre el reclamo
  // de COLA: el SELECT de candidatos escanea por rango con SKIP LOCKED, y bajo REPEATABLE READ
  // eso bloquea los INSERT de filas NUEVAS hasta el lock-wait timeout. Con el barrido cada
  // minuto, es la API dejando de aceptar altas mientras pasa.
  const mysql = fileNamed(generateRepositories(modelFor(queueSweep(), 'mysql')), 'JobRepositoryImpl.java');
  assert.match(mysql, /@Transactional\(propagation = Propagation\.REQUIRES_NEW, isolation = Isolation\.READ_COMMITTED\)/);
  assert.match(mysql, /import org\.springframework\.transaction\.annotation\.Isolation;/);

  // Y donde el motor ya arranca en READ COMMITTED no se anota: sería sugerir una decisión
  // donde no hay ninguna, y dejar un import muerto.
  const postgres = fileNamed(generateRepositories(modelFor(queueSweep(), 'postgresql')), 'JobRepositoryImpl.java');
  assert.match(postgres, /@Transactional\(propagation = Propagation\.REQUIRES_NEW\)/);
  assert.ok(!postgres.includes('Isolation'), postgres);
});
