// La matriz de paridad de keel-go: la MISMA lista de mecanismos que keel-spring, keel-nest y keel-dotnet
// (keel-core/gen/mechanisms.js, que razona por qué existe), con las celdas de este generador.
//
// Cada mecanismo del catálogo tiene aquí su fila, sin excepción (lo vigila test/engine-support.test.js), con su celda por
// modelo o por motor según el `axis` del catálogo y SUS redes. Una celda pasa a `verificado` solo con la red que la ejecuta, y
// a `falsified: true` solo con el sabotaje medido.
//
// La frontera de motores también se dice: keel-go genera la persistencia relacional sobre PostgreSQL y MySQL y RECHAZA en
// build los demás motores del catálogo (`SUPPORTED_DATABASES`), así que sus celdas no son `degradado` —nada se emite que
// prometa menos— sino fuera de la frontera.

import { MECHANISM_CATALOG, STATES } from '@keel-system/keel-core/gen/mechanisms';
import { SUPPORTED_DATABASES } from './supported-features.js';

export { MECHANISM_CATALOG, STATES, SUPPORTED_DATABASES };

/** Los motores relacionales que keel-go genera (el eje `engine` del catálogo): los demás, fuera de la frontera. */
export const RELATIONAL_ENGINES = SUPPORTED_DATABASES.filter((database) => database !== 'mongodb');

/** Las redes de keel-go que EJECUTAN algo. */
export const NETS = {
  'go-check':
    'npm run go-check — genera, tidy sin mover un directo, gofmt/vet/staticcheck vacíos, build sin cgo y las pruebas EMITIDAS de todas las fixtures y variantes, -race, govulncheck, licencias y ARRANCA el binario',
  'db-check':
    'npm run db-check [-- --database=mysql] — los ADAPTADORES contra PostgreSQL y MySQL reales: sondas Go generadas desde el modelo, el esquema contra el catálogo del motor y los almacenes del generador',
  'doc-check': 'npm run doc-check — la persistencia DOCUMENTAL contra un MongoDB real en replica set: documento crudo contra el contrato, índices vivos, transacción, almacenes, reclamos y guarda',
  'harness-check': 'npm run harness-check [-- --database=mysql] — el arnés contra la infra/ real: flujos sonda caja negra, check-flows y cada código de score-scenarios.sh',
  'doc-harness-check': 'npm run doc-harness-check — el arnés documental contra la infra/ real: MongoEval, reset, rescate y export-indexes.sh',
  'broker-check': 'npm run broker-check [-- --broker=rabbitmq|kafka|snssqs] — la mensajería contra RabbitMQ, Kafka y LocalStack reales',
  'telemetry-check': 'npm run telemetry-check — la telemetría con la app ARRANCADA contra PostgreSQL y MySQL y un colector OTLP falso',
  'deploy-check': 'npm run deploy-check — deploy/ entero (imagen distroless, colector y backend) y las preguntas al backend que comparten los generadores',
  ninguna: 'nadie lo ejecuta'
};

// Las rutas de los marcadores son las de internal/ de cada rama: en Go el proyecto no lleva el nombre del servicio.
const PG = 'internal/infrastructure/postgres';
const MONGO = 'internal/infrastructure/mongo';

export const MECHANISMS = {
  'timer-purge': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['file:internal/infrastructure/timer/purge.go', 'internal/infrastructure/timer/purge.go::func NewRecurring(', 'cmd/server/main.go::timer.NewRecurring(timer.KindPurgeOutboxEvent'],
        document: ['file:internal/infrastructure/timer/purge.go', 'internal/infrastructure/timer/purge.go::func NewRecurring(', 'cmd/server/main.go::timer.NewRecurring(timer.KindPurgeOutboxEvent']
      }
    },
    emitter: 'src/scaffold/timer.js (timer.NewRecurring y el cableado de cada purga sobre su scheduler.PurgeTask) · src/scaffold/server.js (las purgas ya no van al reloj)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'notification-mailer y todo sujeto con purgas: dos réplicas (dos Poller sobre la misma base, cada uno con sus recurrentes, que cuentan sus ticks): una fila por purga (R1), un solo tick ejecutado (RC-1) y el rearme para el siguiente cron (R2), los casos de la sonda de keel-spring. Falsado con timer-every-replica, que asegura el recurrente con un entity_id nuevo (cada réplica, su fila) y cae en R1 y RC-1'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'notification-mailer-mongo: los mismos tres casos sobre el almacén documental en el replica set. Falsado con timer-every-replica (un _id nuevo por aseguramiento), que cae en R1 y RC-1'
      }
    }
  },
  'timer-schedule': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'file:internal/infrastructure/timer/schedules.go',
          'internal/infrastructure/timer/schedules.go::func NewSchedule(',
          `${PG}/job_repository.go::application.SweepClaimed(ctx, len(ids), batch)`,
          'file:internal/application/sweep_pass.go',
          'cmd/server/main.go::timer.NewSchedule(task.Name, task.Cron, task.Run, timerSettings)'
        ],
        document: [
          'file:internal/infrastructure/timer/schedules.go',
          'internal/infrastructure/timer/schedules.go::func NewSchedule(',
          `${MONGO}/job_repository.go::application.SweepClaimed(ctx, len(claimed), batch)`,
          'file:internal/application/sweep_pass.go',
          'cmd/server/main.go::timer.NewSchedule(task.Name, task.Cron, task.Run, timerSettings)'
        ]
      }
    },
    emitter: 'src/scaffold/timer.js (timer.NewSchedule, que drena, y application.SweepClaimed) · src/scaffold/server.js (las tareas de los schedule ya no van al reloj) · src/scaffold/claim.js · src/scaffold/reconciliation-claim.js · src/scaffold/document-repositories.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'job-dispatch: un tick de timer.NewSchedule drena con el reclamo real contra el motor (DR-1 a DR-3), falsado con drain-no-signal (DR-1) y drain-no-budget (DR-3); todo sujeto con schedule: dos réplicas aseguran y sondean el schedule y cada tick lo ejecuta una (R1, RC-1, R2), falsado con timer-every-replica-schedule. Los casos de keel-spring'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'job-dispatch-mongo: los mismos casos sobre el almacén documental y el FindOneAndUpdate del reclamo, con los mismos sabotajes'
      }
    }
  },
  'timer-telemetry': {
    parity: {
      pair: 'notification-mailer',
      // Las series solo existen con telemetría: sin el stack, ninguna rama tendría marcadores.
      stack: { telemetry: 'otel' },
      markers: {
        relational: ['cmd/server/main.go::poller.Observe(', 'cmd/server/main.go::telemetry.TimerLag', `${PG}/timers.go::timerSQL(timerLagMs,`],
        document: ['cmd/server/main.go::poller.Observe(', 'cmd/server/main.go::telemetry.TimerLag', `${MONGO}/timers.go::bson.A{"$$NOW", "$oldest"}`]
      }
    },
    emitter: 'src/scaffold/timer.js (Poller.Observe, Store.Lag en los dos motores y el cableado con telemetría en main) · src/scaffold/telemetry.js (TimerLag, TimerParked) · src/scaffold/observability-assets.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'telemetry-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'job-dispatch: TEL-12 con la app arrancada en develop y el sueño máximo a 10 min: la purga de keel_timer vencida por SQL hace 120 s publica ese retraso, y al rearrancar la primera pasada deja keel_timer_tick_seconds con kind y desenlace. db-check (TestTimer_TL1, verification-codes) ejecuta Store.Lag contra los dos motores, y la prueba emitida telemetry_test.go (go-check) exige las series del panel. Falsado: timer-kind (telemetry-check) cae en TEL-12 en los dos motores; tl-lag (db-check --only=verification-codes) en TL1; dl-no-lease arrastra TL1, ya declarado'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'verification-codes-mongo: TestTimer_TL1 ejecuta la agregación del retraso ($match del reclamo, $min de due_at y $$NOW) contra el replica set; el disparo observado es el mismo Poller que mide la rama relacional. Falsado: tl-lag (la resta invertida) cae en TL1, y dl-no-lease en DL5, DL6, DL7 y TL1'
      }
    }
  },
  'timer-relay': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          `${PG}/outbox.go::func (t *Transactions) relayWake(ctx context.Context)`,
          'internal/infrastructure/messaging/outbox.go::func (r *Relay) nextRun(',
          'cmd/server/main.go::transactions.OnOutboxAppended(relay.Wake)'
        ],
        document: [
          `${MONGO}/outbox.go::func (t *Transactions) relayWake(ctx context.Context)`,
          'internal/infrastructure/messaging/outbox.go::func (r *Relay) nextRun(',
          'cmd/server/main.go::transactions.OnOutboxAppended(relay.Wake)'
        ]
      }
    },
    emitter: 'src/scaffold/messaging.js (el Relay por réplica, Wake y nextRun) · src/scaffold/messaging-stores.js y document-stores.js (Transactions.relayWake) · src/scaffold/repositories.js y document-repositories.js (el Save avisa) · src/scaffold/server.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'notification-mailer: el messaging.Relay emitido corriendo con el sondeo de respaldo a 600 s, la fila escrita por appendOutbox y el aviso de Transactions.relayWake (RW-1 a RW-3, scripts/lib/relay-wake-probes.js). Falsado: relay-no-wake cae en RW-1 y relay-no-retry en RW-3. Los casos de keel-spring'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'notification-mailer-mongo: los mismos tres casos sobre el relay documental, con los mismos sabotajes'
      }
    }
  },
  deadline: {
    parity: {
      pair: 'verification-codes',
      markers: {
        relational: [
          `${PG}/verification_code_repository.go::r.tx.armTimer(ctx, q, timer.KindVerificationCodePending`,
          `${PG}/verification_code_repository.go::SELECT status FROM verification_codes WHERE id = $1`,
          'internal/domain/verification_code.go::.Add(deadlines.VerificationCodePending()).After(now)'
        ],
        document: [
          `${MONGO}/verification_code_repository.go::r.tx.armTimer(ctx, timer.KindVerificationCodePending`,
          'internal/domain/verification_code.go::.Add(deadlines.VerificationCodePending()).After(now)'
        ]
      }
    },
    emitter: 'src/scaffold/timer.js (lateGuardParts, relationalArming, documentArming) · src/scaffold/entities.js · src/scaffold/repositories.js · src/scaffold/document-repositories.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'verification-codes (db-check --only=verification-codes, scripts/lib/timer-probes.js): DL-1 a DL-3 contra transitionAt del dominio emitido (la hora y los plazos por argumento) y DL-4 contra el adaptador en una transacción que confirma y otra que revierte. Falsado con dl-boundary y dl-no-guard (caen en DL-2) y dl-outside-tx (el armado por la base y no por la transacción: cae DL-4). dl-wrong-field no tiene sujeto en esta fixture (una sola marca de tiempo). Medido el 2026-11-08: db-check 8/8 en PostgreSQL (20 sondas) y 7/7 en MySQL, y cada sabotaje en exactamente sus casos'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'verification-codes-mongo (doc-check --only=verification-codes-mongo): los mismos casos, con el estado previo leído en la transacción del caso de uso y el armado en ella, sobre un replica set real. Falsado con dl-boundary, dl-no-guard y dl-outside-tx (el armado fuera de la sesión: DL-4 lo ve). Medido el 2026-11-08: doc-check 5/5 (20 sondas), y cada sabotaje en exactamente sus casos'
      }
    }
  },
  timer: {
    parity: {
      pair: 'verification-codes',
      markers: {
        relational: [`file:${PG}/timers.go`, `${PG}/timers.go::FOR UPDATE SKIP LOCKED`, 'file:internal/infrastructure/timer/poller.go'],
        document: [`file:${MONGO}/timers.go`, `${MONGO}/timers.go::FindOneAndUpdate(outside(ctx)`, `${MONGO}/timers.go::$NOW`]
      }
    },
    emitter: 'src/scaffold/timer.js (el paquete timer: Store, Poller, la purga y un handler por plazo; timers.go en el paquete del motor; el cableado en main.go)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'verification-codes: las sentencias de keel-core tal cual (test/deadlines.test.js comprueba que cada una está en timers.go), con los marcadores nombrados traducidos en tiempo de ejecución; DL-5 a DL-10 y el recurrente de la purga (R1) contra el motor, con el Poller emitido. Falsado con dl-no-lease (cae en DL-6 y DL-7) y dl-no-revalidate (DL-8 y DL-9). dl-app-clock no tiene sujeto: la instancia y la base comparten reloj en la máquina de la red. Medido el 2026-11-08: db-check 8/8 en PostgreSQL (20 sondas) y 7/7 en MySQL, y cada sabotaje en exactamente sus casos'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'verification-codes-mongo: FindOneAndUpdate de uno en uno con $NOW, fuera de toda transacción, el _id aplanado y entity_id/claim_token como texto. Falsado con dl-no-lease (cae en DL-5, DL-6 y DL-7, como en los otros tres) y dl-no-revalidate (DL-8 y DL-9). Medido el 2026-11-08: doc-check 5/5 (20 sondas), y cada sabotaje en exactamente sus casos'
      }
    }
  },
  'runtime-panel': {
    parity: {
      skip: 'la telemetría es una elección de STACK (telemetry: otel) y el par se genera sin ella; el panel y sus series los comparan con los otros generadores test/observability-assets.test.js y la prueba emitida telemetry_test.go, generando con la opción',
      test: 'test/observability-assets.test.js'
    },
    emitter: 'src/scaffold/observability-assets.js (los neutrales de keel-core/gen/observability-assets.js con GO_RUNTIME) · las series en src/scaffold/telemetry.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'telemetry-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la fila de runtime de Go y el pool leído de sql.DBStats (keel_db_pool_*): DBStats no da las peticiones esperando ahora sino las acumuladas, así que su saturación son las esperas desde el scrape anterior. telemetry-check, con la app arrancada contra PostgreSQL y MySQL, lee el pool configurado y sus conexiones. Falsado con --sabotage=pool-name: cae TEL-7. deploy-check: las series llegan al backend y el panel y las alertas entran'
      },
      document: {
        state: 'degradado',
        why: 'mongo-driver no publica sus contadores de pool sin suscribirse a sus eventos de conexión, así que keel-go, como keel-nest y keel-dotnet, no publica serie de pool en el modelo documental: el panel no trae esa celda ni la alerta de saturación. Sin serie, ni fila ni alerta: una consulta sobre una serie que nadie publica dejaría la alerta muda'
      }
    }
  },
  'outbox-relay': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [`${PG}/outbox.go::FOR UPDATE SKIP LOCKED`, `file:${PG}/outbox.go`],
        document: [`${MONGO}/outbox.go::FindOneAndUpdate`, `${MONGO}/outbox.go::claimed_at`]
      }
    },
    emitter: 'src/scaffold/messaging-stores.js (sobre OUTBOX_EVENT y OUTBOX_RELAY de keel-core/gen/messaging-stores.js) · document-stores.js en la rama documental · el relay en messaging.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'la fila en la transacción del cambio, el reclamo en orden y con su lease, SKIP LOCKED, el backoff, la rendición y la purga por lotes. Falsado con lease, skip-locked, purge y purge-batch, cada uno cazado por su sonda. broker-check lo ejecuta además contra los tres brokers reales, con el broker caído'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'el reclamo con FindOneAndUpdate en orden de llegada y la marca claimed_at que caduca, la fila en la sesión del cambio. Falsado con outbox-order'
      }
    }
  },
  'idempotency-request': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [`file:${PG}/idempotency_store.go`, `${PG}/idempotency_store.go::duplicateIdempotencyRecord`],
        document: [`file:${MONGO}/idempotency_store.go`, `${MONGO}/idempotency_store.go::InsertOne`]
      }
    },
    emitter: 'src/scaffold/request-idempotency.js (sobre IDEMPOTENCY_RECORD de keel-core/gen/request-idempotency.js) · document-stores.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'guardar y encontrar, el ámbito en la clave, la clave repetida y la carrera como su conflicto con su code, la caducada sustituible, el rollback con el comando y la purga. Falsado con idempotency. Lo que no ejecuta ninguna red: el USO en el handler, que escribe el agente'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'el _id subdocumento en la sesión del caso de uso. Falsado con idempotency-outside: abortado el comando, la clave quedaba marcada'
      }
    }
  },
  'idempotency-consume': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [`${PG}/processed_events.go::duplicateProcessedEvent`],
        document: [`file:${MONGO}/processed_events.go`]
      }
    },
    emitter: 'src/scaffold/messaging-stores.js (sobre PROCESSED_EVENT de keel-core/gen/messaging-stores.js) · document-stores.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'la primera entrega marca, la repetida se reconoce, dos a la vez gana una y la purga por lotes. Falsado con guard: caen la clave y la carrera. broker-check lo ejecuta con la reentrega real de los tres brokers'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'el mismo registro sobre su _id subdocumento. Falsado con guard-in-session'
      }
    }
  },
  'reconciliation-claim': {
    parity: {
      skip: 'su sujeto NO es un par byte a byte sino dos diseños distintos (stock-reservation relacional, asset-vault documental), igual que en los otros tres; las dos ramas las EJECUTAN db-check y doc-check, y la forma la fija este test',
      test: 'test/reconciliation.test.js'
    },
    emitter: 'src/scaffold/reconciliation-claim.js (sobre RECONCILIATION_CLAIM de keel-core/gen/reconciliation-stores.js)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'la marca en reconciliation_claim (ON CONFLICT en PostgreSQL, UPDATE + INSERT IGNORE en MySQL), candidatos sin marca viva, umbral, caducidad y purga. Falsado con reconciliation-expiry, -threshold y -head'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'el upsert sobre la marca caducada, fuera de toda transacción. Falsado con reconciliation-held, -threshold, -expiry y -key'
      }
    }
  },
  'sweep-claim-queue': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [`${PG}/job_repository.go::ClaimForDispatchJobsRunning`, `${PG}/claims.go::claimCandidates`],
        document: [`${MONGO}/job_repository.go::ClaimForDispatchJobsRunning`, `${MONGO}/job_repository.go::FindOneAndUpdate`]
      }
    },
    emitter: 'src/scaffold/claim.js (sobre operation.claim[], claimOrderField y sweepConfig de keel-core/gen)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'orden, lote, destino, reloj estampado, dos réplicas sin repetir, SKIP LOCKED con otra transacción reteniendo una fila y la negativa a correr dentro de otra transacción. Falsado con claim-skip-locked'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'FindOneAndUpdate en orden y con lote, sin repetir entre dos réplicas. Falsado con claim (el filtro del estado de partida invertido)'
      }
    }
  },
  'sweep-claim-rescue': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [`${PG}/job_repository.go::ClaimForStalledDispatchJobsDone`, `${PG}/job_repository.go::staleBefore`],
        document: [`${MONGO}/job_repository.go::ClaimForStalledDispatchJobsDone`, `${MONGO}/job_repository.go::staleBefore`]
      }
    },
    emitter: 'src/scaffold/claim.js (claim.stalled de keel-core/gen/model.js) · el plazo desde service.parameters (src/scaffold/service-parameters.js) o sweep.yaml',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'solo lo abandonado, arrienda sin cambiar el estado, el fresco intacto y lo renovado no se repite. Falsado con claim-stale'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'las mismas preguntas sobre la marca del documento. Falsado con claim-stale'
      }
    }
  },
  'guard-claim': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [`${PG}/notification_repository.go::ClaimForSendAcceptedNotification`, `${PG}/notification_repository.go::r.tx.fresh(`],
        document: [`${MONGO}/notification_repository.go::ClaimForSendAcceptedNotification`, `${MONGO}/notification_repository.go::outside(ctx)`]
      }
    },
    emitter: 'src/scaffold/claim.js · src/scaffold/mail.js (documentGuardMethods y la guarda del envío)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'el UPDATE condicional en una transacción PROPIA: de dos a la vez gana una, y la marca existe para los demás durante el efecto externo. Falsado con guard-state (la guarda sin mirar el estado)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'FindOneAndUpdate fuera de la sesión del caso de uso. Falsado con send-guard (la marca en la sesión, que se deshace con ella)'
      }
    }
  },
  'harness-db-probes': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: ['tests/integration/flow_test.go::) StallInFlight(', 'tests/integration/flow_test.go::) PutInFlight(', 'tests/integration/flow_test.go::) InFlightWithoutClock(', 'tests/integration/flow_test.go::UPDATE jobs SET'],
        document: ['tests/integration/flow_test.go::) StallInFlight(', 'tests/integration/flow_test.go::) PutInFlight(', 'tests/integration/flow_test.go::) InFlightWithoutClock(', 'tests/integration/flow_test.go::) MongoEval(']
      }
    },
    emitter: 'src/scaffold/integration-tests.js (sobre rescueProbes de keel-core/gen) · document-harness.js · messaging-harness.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'db-check ejecuta las sentencias de StallInFlight, PutInFlight e InFlightWithoutClock TAL COMO LAS EMITE el arnés (leídas del flow_test.go) contra el motor, y exige que el reclamo generado rescate la atascada y deje la fresca. Falsado con harness-stall'
      },
      document: {
        state: 'verificado',
        net: 'doc-harness-check',
        falsified: true,
        why: 'MongoEval, el reset y los ayudantes del rescate contra la infra/ real. Falsado con print, put, missing y aging'
      }
    }
  },
  'schema-baseline': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [`file:${PG}/migrations/00001_baseline.sql`, `file:${PG}/migrations.go`],
        document: ['file:infra/export-indexes.sh', `file:${MONGO}/indexes.go`]
      }
    },
    emitter: 'src/scaffold/persistence.js (la baseline de goose, escrita por build) · document-persistence.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'la baseline aplicada con goose contra el catálogo del motor, en los dos sentidos, y sin un índice sale roja en la propia comprobación. Y la evolución medida: la baseline reescrita no llega a una base desplegada y el paso 00002 sí, con su falsado. Falsado con index, y con el índice retirado en el paso del esquema'
      },
      document: {
        state: 'verificado',
        net: 'doc-harness-check',
        falsified: true,
        why: 'export-indexes.sh exporta los índices VIVOS y cada uno es el del contrato (keel-core/gen/document.js). Falsado con --sabotage=index'
      }
    }
  },
  'transient-write-conflict': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [`${PG}/transactions.go::writeConflictAttempts`, `${PG}/transactions.go::40P01`],
        document: [`${MONGO}/transactions.go::writeConflictAttempts`, `${MONGO}/transactions.go::TransientTransactionError`]
      }
    },
    emitter: 'src/scaffold/persistence-runtime.js · document-persistence.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'dos transacciones bloquean dos filas en orden inverso, el motor aborta una y se repite ENTERA; agotada, sale como el 409 de concurrencia. Falsado con deadlock y retry'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'la carrera de dos transacciones sobre el mismo documento y el conflicto agotado como su 409. Falsado con transient'
      }
    }
  },
  'document-indexes': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [],
        document: [`file:${MONGO}/indexes.go`, 'file:infra/export-indexes.sh']
      }
    },
    emitter: 'src/scaffold/document-persistence.js (indexes.go, sobre documentIndexes de keel-core/gen/document.js)',
    coverage: {
      relational: { state: 'no-aplica', why: 'en relacional los índices los crea la baseline' },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'los índices VIVOS contra keel-core/gen/document.js: nombre, claves en orden, unicidad y filtro parcial, ninguno de más, y crearlos dos veces no falla. Falsado con el translator (el índice no reconocido) y, en doc-harness-check, con index'
      }
    }
  },
  'partial-unique-index': {
    emitter: 'src/scaffold/persistence.js (sobre partialIndexSpecs de keel-core/gen/relational.js)',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'índice parcial. La misma clave en el estado condicionado choca con el error del diseño. Falsado con partial-literal (el literal del diseño en minúsculas)'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'la columna GENERADA <índice>_flag al final del índice único, la forma de los otros tres (schema-parity). Falsado con partial-flag (la columna vale NULL también dentro de la condición)'
      }
    }
  },
  'unique-collation': {
    emitter: 'src/scaffold/persistence.js',
    coverage: {
      postgresql: { state: 'no-aplica', why: 'PostgreSQL compara el texto distinguiendo mayúsculas: no hay collation que forzar' },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'utf8mb4_bin en cada columna única de texto: la sonda lee collation_name del motor contra el DISEÑO (caseSensitiveCollationFor de keel-core). Falsado con collation. Hallazgo neutral sin arreglar: la SOMBRA de ignore-case hereda utf8mb4_0900_ai_ci y pliega también acentos, en los cuatro generadores'
      }
    }
  },
  'claim-dialect': {
    emitter: 'src/scaffold/claim.js y messaging-stores.js (FOR UPDATE SKIP LOCKED en SQL crudo)',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'la fila bloqueada por otra transacción se salta sin esperar, en el reclamo de barrido y en el del outbox. Falsado con skip-locked y claim-skip-locked'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'FOR UPDATE SKIP LOCKED en READ COMMITTED: en el REPEATABLE READ por defecto bloquearía los huecos entre claves. Falsado con claim-isolation, skip-locked y claim-skip-locked'
      }
    }
  },
  'harness-sql-literals': {
    emitter: 'src/scaffold/integration-tests.js (staleTimestamp, nowTimestamp y uuidLiteral de DATABASES en keel-core/gen/infra-catalog.js)',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'el TIMESTAMP rancio y el uuid entre comillas CASAN: la fila atascada por la sentencia del arnés emitido, con su idLiteral emitido, la rescata el reclamo. Falsado con stale-literal y uuid-literal'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'lo mismo con datetime(6) y UUID_TO_BIN sobre el binary(16). Falsado con stale-literal y uuid-literal (como texto no casa con ninguna fila ni falla)'
      }
    }
  },
  'telemetry-store-spans': {
    parity: {
      skip: 'la telemetría es una elección de STACK (telemetry: otel) y el par se genera sin ella; que solo se abran los spans del código generado (degradado) lo fija test/telemetry.test.js generando con la opción',
      test: 'test/telemetry.test.js'
    },
    emitter: 'src/scaffold/telemetry.js (los spans que abre el código generado: caso de uso, HTTP de entrada y salida, mensajería, caché, storage y correo)',
    coverage: {
      relational: {
        state: 'degradado',
        why: 'keel-spring cuelga de cada caso de uso los spans de JDBC; keel-go, como keel-nest y keel-dotnet, no instrumenta database/sql: la traza llega hasta el span del caso de uso, con su duración y su desenlace, y ahí se para. Las series y sus etiquetas no dependen de esto'
      },
      document: {
        state: 'degradado',
        why: 'lo mismo con mongo-driver y go-redis: sin span del comando, la traza se para en el caso de uso'
      }
    }
  },
  'folded-text': {
    parity: {
      skip: 'ningún par declara `compare` —meterlo en uno movería la clave natural que miden db-check y doc-check—, así que el texto lo fija un test sobre catalog-extended y jobs-mongo-finder, y lo EJECUTAN db-check y doc-check',
      test: 'test/uncovered-branches.test.js'
    },
    emitter: 'src/scaffold/persistence.js (la columna sombra) · internal/platform/textfold · repositories.js y document-repositories.js (la sombra estampada al guardar y consultada por los finders)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'catalog-extended: la clave natural plegada y la sombra del filtro. Falsado con fold y finder-fold, solo en PostgreSQL: en MySQL la collation de la sombra pliega por su cuenta (el hallazgo neutral de unique-collation)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'jobs-mongo-finder: el filtro por prefijo compara contra la sombra plegada del documento. Falsado con finder-fold (el texto sin plegar): cae el finder y solo él. La clave natural plegada sobre documentos no la declara ninguna fixture documental'
      }
    }
  },
  'persistence-adapter': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [`${PG}/job_repository.go::database/sql`, 'type JobRepository struct'],
        document: [`${MONGO}/job_repository.go::go.mongodb.org/mongo-driver`, 'type JobRepository struct']
      }
    },
    emitter: 'src/scaffold/persistence.js · repositories.js · persistence-runtime.js · document-persistence.js · document-repositories.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'el esquema contra el catálogo del motor, ida y vuelta, fusión de hijas, versión obsoleta → 409, cada unicidad con su error, la cota del motor, página y borrado. Falsado con version, enum, constraint, index, merge, list-order y timeout'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'el documento CRUDO contra documentShape a todo nivel, ida y vuelta, versión, unicidades y página. Falsado con decimal-as-text y uuid-legacy (la ida y vuelta sigue en verde: solo lo ve el documento crudo), version y translator'
      }
    }
  },
  'conditional-write': {
    parity: {
      skip: 'ningún par declara api.concurrency (catalog-extended la declara sobre updateProduct, pero no tiene gemela documental); lo emitido lo fijan test/conditional-writes.test.js, que lo compara con keel-nest y keel-dotnet, y test/uncovered-branches.test.js sobre las siluetas de keel-core/test/helpers/conditional-write-designs.js',
      test: 'test/conditional-writes.test.js'
    },
    emitter: 'src/scaffold/conditional-writes.js (Versioned, CheckVersion, conditional.go, las pruebas emitidas y el gate) · services.js · endpoints.js · repositories.js y document-repositories.js · cache.js · security.js (CORS) · errors.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'catalog-conditional y shop-conditional: CW-1 a CW-5 contra el adaptador de database/sql en PostgreSQL y MySQL (scripts/lib/conditional-probes.js). Falsado con --only=catalog-conditional: cw-ignore-expected cae en CW-2 y CW-3, cw-stale-version en CW-4 y cw-collapse-409 en CW-5, en los dos motores. El borde, en go-check sobre las siluetas: CW-6 a CW-11 en las pruebas emitidas, falsadas con cw-no-428, cw-weak-match, cw-error-map, cw-cors y cw-cache-etag (test/helpers/conditional-sabotages.js); CW-12 (el gate, ejecutado con bash) en test/conditional-writes.test.js, falsado con cw-gate'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'catalog-conditional-mongo: CW-1 a CW-5 contra el adaptador del driver de MongoDB en un replica set real, con las MISMAS sondas que db-check. Falsado con --only=catalog-conditional-mongo: cw-ignore-expected cae en CW-2 y CW-3, cw-stale-version en CW-4 y cw-collapse-409 en CW-5'
      }
    }
  },
  'read-scope': {
    pending: 'la lectura acotada (DSL 2.27) llega en el incremento 4 de PLAN-DSL-227-LECTURA-ACOTADA.md: hasta entonces supported-features.js la rechaza entera (readScopePendingErrors)'
  }
};

/** Todas las celdas, aplanadas: { id, branch, cell }. */
export function cells() {
  const out = [];
  for (const [id, row] of Object.entries(MECHANISMS)) {
    for (const [branch, cell] of Object.entries(row.coverage ?? {})) out.push({ id, branch, cell });
  }
  return out;
}

/** Lo generado que ninguna red ejecuta: la cola de trabajo. */
export function unverified() {
  return cells().filter(({ cell }) => cell.state === 'razonado');
}

/** Hay red pero nadie ha comprobado que pueda ponerse roja. */
export function unfalsified() {
  return cells().filter(({ cell }) => cell.state === 'verificado' && !cell.falsified);
}

/** Lo que keel-go todavía no genera, con el incremento que lo trae (ninguno desde el 16). */
export function pending() {
  const rows = Object.entries(MECHANISMS).filter(([, row]) => row.pending).map(([id, row]) => ({ id, branch: null, pending: row.pending }));
  const branches = cells().filter(({ cell }) => cell.pending).map(({ id, branch, cell }) => ({ id, branch, pending: cell.pending }));
  return [...rows, ...branches];
}
