// La matriz de paridad de keel-nest: la MISMA lista de mecanismos que keel-spring
// (keel-core/gen/mechanisms.js, que razona por qué existe), con las celdas de este generador.
//
// Cada mecanismo del catálogo tiene aquí su fila, sin excepción (lo vigila test/engine-support.test.js):
//   · `pending`  keel-nest todavía no lo genera, y la fila nombra el incremento que lo trae. No es una
//                celda «razonada»: no hay código que razonar. Es la frontera de supported-features.js
//                vista mecanismo a mecanismo;
//   · `coverage` lo genera, celda por modelo o por motor (según el `axis` del catálogo), con el mismo
//                vocabulario de estados que keel-spring y SUS redes: `db-check` (la persistencia contra
//                PostgreSQL y MySQL reales) y `ts-check` (compila, prueba y arranca).
//
// La frontera de motores también se dice: keel-nest genera la persistencia relacional sobre PostgreSQL
// y MySQL y RECHAZA en build los demás del catálogo (`SUPPORTED_DATABASES`), así que sus celdas no son
// `degradado` —nada se emite que prometa menos— sino fuera de la frontera, y la matriz las imprime así.

import { MECHANISM_CATALOG, STATES } from '@keel-system/keel-core/gen/mechanisms';
import { SUPPORTED_DATABASES } from './supported-features.js';

export { MECHANISM_CATALOG, STATES };

/** Las redes de keel-nest que EJECUTAN algo. */
export const NETS = {
  'db-check':
    'npm run db-check — la persistencia contra PostgreSQL y MySQL reales: esquema contra el catálogo del motor, cotas, ida y vuelta por el adaptador generado, fila en crudo, versión, unicidad (también la condicionada), página y borrado; y los almacenes de la mensajería (el outbox con su reclamo, y el registro de procesados); y el cronómetro y los plazos (DSL 2.26, DL-1 a DL-10 y R1 sobre verification-codes, con los sabotajes dl-*)',
  'ts-check': 'npm run ts-check — compila con strict las 13 fixtures, ejecuta sus pruebas y ARRANCA el servidor contra PostgreSQL',
  'harness-check':
    'npm run harness-check [-- --database=mysql] — levanta infra/ con sus propios scripts, puntúa flujos sonda con score-scenarios.sh (cada código de salida y su evidencia) y exporta, aplica y verifica el baseline de migraciones',
  'broker-check':
    'npm run broker-check [-- --broker=rabbitmq|kafka|snssqs] — la mensajería contra RabbitMQ, Kafka y LocalStack reales de infra/: la topología, los consumer groups o las colas sembradas, el consumo con reintento y descarte (la DLQ, <topic>.DLT con los headers de Spring Kafka, o la RedrivePolicy de SQS), el relay del outbox con el broker caído y los helpers del arnés',
  'doc-harness-check':
    'npm run doc-harness-check — el arnés de integración documental contra la infra/ real: mongoEval, el reset, los ayudantes del rescate y de la reconciliación, el humo y la puntuación',
  'doc-check':
    'npm run doc-check — la persistencia documental contra un MongoDB real en replica set: los índices vivos, el documento crudo contra la forma neutral, ida y vuelta, versión, unicidad (también la condicionada), la carrera de dos transacciones, la auditoría, página y borrado; y el cronómetro y los plazos (DL-1 a DL-10 y R1 sobre verification-codes-mongo, con los sabotajes dl-*)',
  'telemetry-check':
    'npm run telemetry-check — la telemetría con la APLICACIÓN ARRANCADA contra PostgreSQL y MySQL reales: la serie del caso de uso atravesado por HTTP con su desenlace y el exemplar de la traza de quien llamó, la plantilla de la ruta, el runtime de Node, el pool del driver real con su tamaño, la traza en un receptor OTLP, los logs con su trace.id, el puerto de gestión en production y el scrape sin token con seguridad',
  'deploy-check':
    'npm run deploy-check — deploy/ ENTERO en contenedores (imagen de la app, colector, backend de prueba) y las preguntas al backend que comparte con keel-spring (keel-core/gen/deploy-probes.js): scrape, serie con su servicio, exemplar, traza en Tempo, logs en Loki, panel, alertas y la entrega de una alerta al contacto',
  ninguna: 'nadie lo ejecuta'
};

export { SUPPORTED_DATABASES };

export const MECHANISMS = {
  'timer-purge': {
    emitter: 'src/scaffold/timer.js (un <Tabla>PurgeTimer por purga, TimerPoller) · src/scaffold/purge.js (TablePurges ya no las registra en el reloj)',
    why: 'Una purga que vuelve a correr en todas las réplicas no rompe nada visible —borrar es idempotente—: el precio es que cada réplica repite el mismo recorrido de la tabla a la vez, y nada lo dice. Y una purga que no arbitra con UNA fila (un kind por instancia) compila, arranca y purga igual.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'file:src/infrastructure/timer/outbox-event-purge-timer.ts',
          'src/infrastructure/timer/outbox-event-purge-timer.ts::implements RecurringTimerHandler',
          'file:src/infrastructure/timer/sql-timer-store.ts'
        ],
        document: [
          'file:src/infrastructure/timer/outbox-event-purge-timer.ts',
          'src/infrastructure/timer/outbox-event-purge-timer.ts::implements RecurringTimerHandler',
          'file:src/infrastructure/timer/mongo-timer-store.ts'
        ]
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'notification-mailer: dos réplicas (dos TimerPoller con sus propias instancias de cada <Tabla>PurgeTimer, TablePurges doblado) sobre SqlTimerStore contra el motor: una fila por purga (R1), un solo tick ejecutado (RC-1) y el rearme para el siguiente cron (R2), los casos de la sonda de keel-spring. Falsado con timer-every-replica, que cae en R1 y RC-1'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'notification-mailer-mongo: los mismos tres casos sobre MongoTimerStore en el replica set. Falsado con timer-every-replica, que cae en R1 y RC-1'
      }
    }
  },
  'timer-schedule': {
    emitter: 'src/scaffold/timer.js (un <Operación>ScheduleTimer por schedule, SweepPass) · src/scaffold/scheduling.js (el scheduler ya no se registra en el reloj) · src/scaffold/claim.js · src/scaffold/reconciliation-claim.js · src/scaffold/document-stores.js',
    why: 'Un barrido que vuelve a correr en todas las réplicas, o que en una sola réplica hace una pasada por tick, compila, arranca y barre: el precio es un atraso que crece con la carga sin que nada lo diga, o N réplicas compitiendo por el mismo lote. Y un reclamo que no avisa del lote lleno deja el tick sin drenar, igual de callado.',
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'src/infrastructure/timer/dispatch-jobs-schedule-timer.ts::implements RecurringTimerHandler',
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::SweepPass.claimed(candidates.length',
          'file:src/infrastructure/timer/sql-timer-store.ts'
        ],
        document: [
          'src/infrastructure/timer/dispatch-jobs-schedule-timer.ts::implements RecurringTimerHandler',
          'SweepPass.claimed(claimed.length',
          'file:src/infrastructure/timer/mongo-timer-store.ts'
        ]
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'job-dispatch: el <Operación>ScheduleTimer drena con el reclamo real contra el motor (DR-1 a DR-3), falsado con drain-no-signal (DR-1) y drain-no-budget (DR-3); notification-mailer: dos réplicas aseguran y sondean el schedule y cada tick lo ejecuta una (R1, RC-1, R2), falsado con timer-every-replica-schedule. Los casos de keel-spring'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'job-dispatch-mongo y notification-mailer-mongo: los mismos casos sobre MongoTimerStore y el findOneAndUpdate del reclamo, con los mismos sabotajes'
      }
    }
  },
  'timer-relay': {
    emitter: 'src/scaffold/messaging-stores.js (OutboxRelay por réplica y OutboxAppendedSignal) · src/scaffold/messaging.js (el bridge avisa tras el commit) · src/scaffold/document-stores.js',
    why: 'Un relay que no despierta con el commit sigue entregando, solo que al sondeo de respaldo: nada falla, y la salida de cada evento pasa de milisegundos a decenas de segundos. Y uno que olvida el reintento de una fila que falló la deja esperando al respaldo en vez de a su backoff.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['class OutboxAppendedSignal', 'this.appended.notify()', 'nextRun(full: boolean, retryAtMs: number, passStartMs: number)'],
        document: ['class OutboxAppendedSignal', 'this.appended.notify()', 'nextRun(full: boolean, retryAtMs: number, passStartMs: number)']
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'notification-mailer: el OutboxRelay emitido arrancado con el sondeo de respaldo a 600 s y el bridge emitido escribiendo la fila en la transacción (RW-1 a RW-3, scripts/lib/relay-wake-probes.js). Falsado: relay-no-wake cae en RW-1 y relay-no-retry en RW-3. Los casos de keel-spring'
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
  'timer-telemetry': {
    emitter: 'src/scaffold/timer.js (TimerPoller: observedTick y los dos gauges; lagMs en SqlTimerStore y MongoTimerStore) · src/scaffold/observability-assets.js',
    why: 'El retraso se lee con una consulta por almacén y un gauge que no casa con nada no falla: publica 0, el panel dice que el cronómetro va al día y la alerta no dispara nunca. Y un disparo sin su kind deja el p95 del panel sin nada por lo que agrupar.',
    parity: {
      pair: 'notification-mailer',
      // Las series solo existen con telemetría: sin el stack, ninguna rama tendría marcadores.
      stack: { telemetry: 'otel' },
      markers: {
        relational: ['observedTick(timer.kind', "'keel.timer.lag.seconds'", 'SQL.lagMs'],
        document: ['observedTick(timer.kind', "'keel.timer.lag.seconds'", "lagMs: { $subtract: ['$$NOW', '$oldest'] }"]
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'telemetry-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'job-dispatch: TEL-12 con la app arrancada en develop y el sueño máximo a 10 min: la purga de keel_timer vencida por SQL hace 120 s publica ese retraso, y al rearrancar la primera pasada deja keel_timer_tick_seconds con kind y desenlace. db-check (TL-1, verification-codes) ejecuta la consulta del retraso contra los dos motores: lo vencido, un kind ajeno y lo arrendado. test/observability-assets.test.js EJECUTA el TimerPoller emitido y exige sus series. Falsado: sin el kind en la observación cae TEL-12 en los dos motores, y lagMs con la sentencia equivocada cae TL-1. De paso destapó un defecto: un gauge cuya lectura fallaba devolvía 500 en el scrape ENTERO; ahora publica NaN'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'verification-codes-mongo: TL-1 ejecuta la agregación del retraso ($match del reclamo, $min de due_at y $$NOW) contra el replica set. El disparo observado es el mismo TimerPoller que mide la rama relacional. Falsado: la resta invertida ($oldest - $$NOW) cae en TL-1, y dl-no-lease cae además en TL-1 (lo arrendado vuelve a contar)'
      }
    }
  },
  deadline: {
    emitter: 'src/scaffold/timer.js (lateGuardBlock, adapterArming) · src/scaffold/entities.js · src/scaffold/repositories.js · src/scaffold/document-repositories.js',
    why: 'Un rechazo tardío con < en vez de <= o un armado fuera de la transacción compilan igual de bien, y ningún escenario de un solo instante los ve: el precio es confirmar lo que el negocio daba por caducado, o un temporizador huérfano de una alta que revirtió.',
    parity: {
      pair: 'verification-codes',
      markers: {
        relational: [
          'src/infrastructure/persistence/repositories/verification-code-repository-impl.ts::await this.timers.arm(TimerKinds.',
          'src/infrastructure/persistence/repositories/verification-code-repository-impl.ts::select: { id: true, status: true }',
          'src/domain/aggregate/verification-code.ts::deadlines.verificationCodePendingMs <= now.getTime()'
        ],
        document: [
          'src/infrastructure/persistence/repositories/verification-code-repository-impl.ts::await this.timers.arm(TimerKinds.',
          'src/infrastructure/persistence/repositories/verification-code-repository-impl.ts::projection: { status: 1 }, session',
          'src/domain/aggregate/verification-code.ts::deadlines.verificationCodePendingMs <= now.getTime()'
        ]
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'verification-codes (db-check --subject=verification-codes): DL-1 a DL-3 contra el método de transición del dominio emitido (la hora y los plazos por argumento) y DL-4 contra el adaptador TypeORM en una transacción que confirma y otra que revierte. Falsado con dl-boundary y dl-no-guard (caen en DL-2) y dl-outside-tx (el armado en una transacción NUEVA: cae DL-4). dl-wrong-field no tiene sujeto en esta fixture (una sola marca de tiempo). Medido el 2026-11-08: 62/62 en PostgreSQL y en MySQL, y cada sabotaje en exactamente sus casos'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'verification-codes-mongo (doc-check --subject=verification-codes-mongo): los mismos casos, con el estado previo leído con la sesión de la transacción del caso de uso y el armado en ella, sobre un replica set real. Falsado con dl-boundary, dl-no-guard y dl-outside-tx (aquí sí tiene sujeto, a diferencia de keel-spring: el armado sin la sesión escribe fuera de la transacción y DL-4 lo ve). Medido el 2026-11-08 (db-check 62/62 en PostgreSQL y MySQL, doc-check 40/40), con cada sabotaje en exactamente sus casos'
      }
    }
  },
  timer: {
    emitter: 'src/scaffold/timer.js (SqlTimerStore, MongoTimerStore, TimerPoller, KeelTimerPurge, un handler por plazo, TimerModule)',
    why: 'Las sentencias viajan dentro de literales y un reclamo que no casa con nada no falla: devuelve cero temporizadores y el plazo no vence nunca. Un arriendo de cero o un sondeador que no revalida tampoco rompen nada visible hasta que dos réplicas despachan lo mismo.',
    parity: {
      pair: 'verification-codes',
      markers: {
        relational: [
          'file:src/infrastructure/timer/sql-timer-store.ts',
          'src/infrastructure/timer/sql-timer-store.ts::FOR UPDATE SKIP LOCKED',
          "file:src/infrastructure/persistence/timer/keel-timer-orm.ts",
          "src/infrastructure/persistence/timer/keel-timer-orm.ts::@Entity({ name: 'keel_timer' })"
        ],
        document: [
          'file:src/infrastructure/timer/mongo-timer-store.ts',
          'src/infrastructure/timer/mongo-timer-store.ts::findOneAndUpdate(',
          'src/infrastructure/timer/mongo-timer-store.ts::$$NOW'
        ]
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'verification-codes: las sentencias de keel-core tal cual (test/deadlines.test.js comprueba que cada una está en sql-timer-store.ts), ejecutadas por el QueryRunner de la transacción de TypeORM; DL-5 a DL-10 y el recurrente de la purga (R1) contra el motor. Falsado con dl-no-lease (cae en DL-6 y DL-7) y dl-no-revalidate (DL-8 y DL-9). dl-app-clock no tiene sujeto: la instancia y la base comparten reloj en la máquina de la red. Medido el 2026-11-08 (db-check 62/62 en PostgreSQL y MySQL, doc-check 40/40), con cada sabotaje en exactamente sus casos'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'verification-codes-mongo: findOneAndUpdate de uno en uno con $$NOW, el _id aplanado y entity_id/claim_token como texto, la hora de la base de un $documents sin la sesión. Falsado con dl-no-lease (cae en DL-5, DL-6 y DL-7, como en keel-spring: sin arriendo el bucle vuelve a llevarse en el mismo lote lo que acaba de reclamar) y dl-no-revalidate (DL-8 y DL-9). El índice de due_at lo pide ahora storeDocumentIndexes de keel-core (lo crean los cuatro generadores al arrancar). Medido el 2026-11-08 (db-check 62/62 en PostgreSQL y MySQL, doc-check 40/40), con cada sabotaje en exactamente sus casos'
      }
    }
  },
  'runtime-panel': {
    parity: {
      pair: 'notification-mailer',
      stack: {
        telemetry: 'otel'
      },
      markers: {
        relational: ['keel_db_pool_pending', 'KeelConnectionPoolSaturated'],
        document: ['keel_runtime_heap_limit_bytes']
      },
      absent: {
        document: ['KeelConnectionPoolSaturated']
      }
    },
    emitter: 'src/scaffold/observability-assets.js (los neutrales de keel-core/gen/observability-assets.js con NODE_RUNTIME) · el pool en src/scaffold/persistence-runtime.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'telemetry-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la fila de runtime de Node (heap contra su límite —keel_runtime_heap_limit_bytes, porque el total de V8 crece a demanda y la alerta del 90 % dispararía en un servicio sano—, GC, retraso del bucle de eventos) y el pool del driver (keel_db_pool_*: pg lo lee de DataSource.driver.master; mysql2, de los campos INTERNOS de su pool, sin API pública). test/observability-assets.test.js EJECUTA la telemetría emitida y exige que toda serie del panel y de las alertas salga en el scrape. telemetry-check, con la app arrancada contra PostgreSQL y MySQL reales: el pool con el tamaño configurado y sus conexiones de vuelta como libres tras el tráfico; falsado renombrando el campo interno de mysql2 (cae el pool en MySQL y solo ahí). deploy-check: las series llegan al backend y el panel y las alertas entran'
      },
      document: {
        state: 'degradado',
        why:
          'el driver de Mongo no expone sus contadores de pool sin suscribirse a sus eventos de conexión, así que keel-nest no publica serie de pool en el modelo documental: el panel no trae esa celda ni la alerta de saturación (keel-spring sí, con mongodb_driver_pool_*). Sin serie, ni fila ni alerta: una consulta sobre una serie que nadie publica dejaría el panel vacío y la alerta muda'
      }
    }
  },
  'outbox-relay': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          "src/infrastructure/messaging/outbox/outbox-relay-store.ts::setOnLocked('skip_locked')",
          'file:src/infrastructure/persistence/entities/outbox-event-orm.ts'
        ],
        document: [
          'src/infrastructure/messaging/outbox/outbox-relay-store.ts::findOneAndUpdate(',
          'src/infrastructure/messaging/outbox/outbox-relay-store.ts::claimed_at'
        ]
      }
    },
    emitter: 'src/scaffold/messaging-stores.js (sobre OUTBOX_EVENT y OUTBOX_RELAY de keel-core/gen/messaging-stores.js) · el puente de src/scaffold/messaging.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la tabla outbox_event es la de keel-spring (schema-parity contra OutboxEventJpa) y los parámetros del relay, los de keel-core (messaging.test.js contra el messaging.yaml de keel-spring; el backoff, contra la referencia ejecutable). db-check, en los dos motores y en notification-mailer y catalog-extended: la tabla contra el catálogo del motor, el puente escribiendo la fila en la transacción del cambio (y nada si revierte), el reclamo en orden y con su lote, el lease, SKIP LOCKED sin esperar a la fila retenida por otra réplica, el backoff de un fallo, la rendición al alcanzar el máximo y su cuenta, y que ni la publicada ni la rendida vuelven. Falsado el 2026-10-07 quitando el lease (cae su comprobación y solo esa) y quitando SKIP LOCKED (el reclamo espera a la fila retenida hasta el tope). Y broker-check, contra RabbitMQ real: el relay con un dispatcher sobre RabbitConnection.publish entrega la fila al canal con su envoltura y su tipo, no da por publicado lo que no tenía cola (mandatory), espera con el broker caído y sale al volver sin rendirse, y un evento abandonado no sale y se cuenta (falsado publicando sin mandatory: cae ese flujo y solo ese). Y contra Kafka real (9f): el mismo relay con un dispatcher sobre KafkaConnection.publish entrega la fila con la routing key como clave, espera con el broker caído y sale al volver, y el abandonado no sale. Y contra LocalStack (9g): con un dispatcher sobre SnsSqsConnection.publish, lo mismo, más que una fila cuyo topic no existe no se da por publicada (la conexión no crea el topic), y que tras levantar el broker la topología se resiembra y la fila sale. Y la purga por lotes (10b), en db-check: lo publicado y caducado sale en lotes de dos con instantes repetidos en la frontera, con el tope alcanzado la pasada siguiente lo termina, y lo vigente y lo PENDIENTE no se tocan (falsado cortando por created_at: caen esas tres y solo esas)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          "el puente escribe el documento de outbox_event (el de keel-core/gen/document.js: _id uuid binario y sus campos en orden, claimed_at incluido) en la sesión de la transacción del cambio, y nada si aborta; el reclamo del relay con findOneAndUpdate en orden de llegada, con su lote, la marca claimed_at que retira de la pasada siguiente y que CADUCA, dos réplicas a la vez sin duplicar, el backoff, el error guardado tal cual (también si empieza por $) y la rendición con su cuenta; y la purga por lotes sin tocar lo pendiente. doc-check en inspection-reports, notification-mailer-mongo y asset-vault. Falsado el 2026-10-08: sin la condición de la marca, sin el orden (con el índice de pendientes retirado: con él el plan regalaba el orden y el sabotaje salía VERDE), con el error como expresión del pipeline y con el puente fuera de la sesión, cada uno cazado por su comprobación. Quitar la condición published_at de la purga es una mutación EQUIVALENTE: un published_at nulo nunca cumple el corte, en Mongo como en SQL"
      }
    }
  },
  'idempotency-request': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'src/infrastructure/persistence/idempotency-store-impl.ts::manager.insert(IdempotencyRecordOrm',
          'IdempotencyConflictException'
        ],
        document: [
          'src/infrastructure/persistence/idempotency-store-impl.ts::this.records.insertOne(',
          'IdempotencyConflictException'
        ]
      }
    },
    emitter: 'src/scaffold/request-idempotency.js (sobre IDEMPOTENCY_RECORD de keel-core/gen/request-idempotency.js)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la tabla idempotency_record es la de keel-spring (schema-parity la compara con IdempotencyRecordJpa, falsado con una cota distinta: caen las 4 fixtures con idempotencia). db-check, en los dos motores y en las 3 fixtures relacionales que la declaran: la tabla contra el catálogo del motor, guardar y encontrar, el ámbito dentro de la clave, la clave repetida y la CARRERA de dos transacciones como el conflicto con su code (el del diseño si lo declara), la clave caducada sustituible y el rollback del registro con su comando. Falsado el 2026-10-06 quitando la traducción de la violación: caen exactamente esas dos comprobaciones en las tres. La purga de las caducadas (10b), en db-check: por lotes, con tope y pasada siguiente, sin tocar las vigentes. Lo que no ejecuta ninguna red: el USO en el handler, que escribe el agente'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          "el registro de idempotency_record con el _id subdocumento {operation_scope, idempotency_key} EN ESE ORDEN —MongoDB compara el subdocumento en orden—, en la sesión del caso de uso: lo guardado se encuentra, el ámbito es parte de la clave, la repetición y la carrera de dos transacciones son su conflicto, aborta con el comando y la clave caducada se reusa. doc-check en notification-mailer-mongo y asset-vault. Falsado el 2026-10-08 sin borrar la caducada (cae el reuso) y con la clave en otro orden (find y save siguen casando entre sí: solo lo caza el documento crudo contra el contrato)"
      }
    }
  },
  'idempotency-consume': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['src/infrastructure/messaging/idempotency/idempotency-guard.ts::manager.insert(ProcessedEventOrm'],
        document: ['src/infrastructure/messaging/idempotency/idempotency-guard.ts::this.processed.insertOne(']
      }
    },
    emitter: 'src/scaffold/messaging-stores.js (IdempotencyGuard, sobre PROCESSED_EVENT de keel-core/gen/messaging-stores.js)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la tabla processed_event es la de keel-spring (schema-parity contra ProcessedEventJpa). db-check, en los dos motores y en notification-mailer y catalog-extended: la tabla y sus cotas contra el catálogo del motor, la repetición arbitrada por la clave primaria, dos consumidores del mismo mensaje sin pisarse, el registro que sobrevive al rollback del handler (su transacción es propia) y la carrera de dos entregas, de la que registra UNA. Falsado el 2026-10-07 haciendo que el registro use la transacción del llamante: cae «sobrevive al rollback» y solo esa. Y la purga por retención (10b), en db-check. Lo que no mide: el ORDEN en el listener (alreadyProcessed/record o tryRecord), que escribe el agente y vigilará el gate de idempotencia (incremento 10d)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          "la guarda sobre processed_event con el _id subdocumento {handler_id, event_id}: la repetición la arbitra el _id, el registro sobrevive al fallo del handler, dos consumidores no se pisan y de dos entregas a la vez registra una. doc-check en inspection-reports, notification-mailer-mongo y asset-vault. Falsado el 2026-10-08 con un upsert en vez de insertOne (cae la repetición); el gate check-idempotency.sh exige insertOne y prohíbe el reemplazo y el upsert, y idempotency-check.test.js lo ejecuta"
      }
    }
  },
  'reconciliation-claim': {
    parity: {
      skip: 'su sujeto NO es un par byte a byte sino dos diseños distintos (stock-reservation relacional y asset-vault documental), igual que en keel-spring; las dos ramas las EJECUTAN db-check y doc-check, y la forma la fija este test',
      test: 'test/reconciliation.test.js'
    },
    emitter: 'src/scaffold/reconciliation-claim.js (sobre RECONCILIATION_CLAIM de keel-core/gen/reconciliation-stores.js) · src/scaffold/document-stores.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'la tienda (insertar, marca viva, caducada, por activación, tres réplicas a la vez y gana una), el reclamo del adaptador (umbral, orden, lote, estado intacto, marcas, caducidad, dos réplicas a la vez) y la purga, en stock-reservation y catalog-extended sobre PostgreSQL y MySQL (incremento 11c). Falsado sin la condición de caducidad en el UPDATE y sin el umbral de espera'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          "la tienda es un upsert sobre la marca CADUCADA con la clave aplanada <activación>|<entidad> y las dos columnas también como campos (el documento de keel-spring): si no existe, insertarla es el reclamo; viva, lo niega; caducada, se renueva; de tres réplicas a la vez gana una. El reclamo del adaptador: umbral, el que más lleva primero, lote, estado de espera intacto, una marca por candidato y otra vez cuando caducan. doc-check sobre asset-vault (sin su autoría de política, que la frontera rechaza). Falsado el 2026-10-08 sin la condición de caducidad: caen la marca viva, la carrera y la pasada siguiente"
      }
    }
  },
  'sweep-claim-queue': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::claimForDispatchJobsRunning',
          "src/infrastructure/persistence/repositories/job-repository-impl.ts::setOnLocked('skip_locked')"
        ],
        document: [
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::claimForDispatchJobsRunning',
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::findOneAndUpdate('
        ]
      }
    },
    emitter: 'src/scaffold/claim.js (sobre operation.claim[], claimOrderField y sweepConfig de keel-core/gen) · el puerto y el adaptador de repositories.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check, en los dos motores, sobre job-dispatch (cola que estampa el reloj del rescate), payout-runs y notification-mailer: el lote del más antiguo al más nuevo y con su tamaño, ya en el estado de destino y con el reloj estampado en el MISMO UPDATE, la pasada siguiente con el resto, dos réplicas a la vez sin llevarse ninguna fila dos veces, y la fila bloqueada por otra réplica saltada sin esperar. sweep.yaml es el de keel-spring (claim.test.js). Falsado el 2026-10-07 por capas: sin el bloqueo cae SOLO el caso de SKIP LOCKED (la condición del UPDATE sigue impidiendo el doble reclamo); sin el bloqueo ni la condición cae también la carrera. Quitar solo la condición no pone nada rojo: con SKIP LOCKED dos réplicas nunca seleccionan la misma fila, y la condición es la segunda defensa'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          "findOneAndUpdate filtra y pasa al estado de destino (estampando el reloj si un rescate lo lee) en la MISMA operación atómica, ordenado: el lote sale del más antiguo al más nuevo, la pasada siguiente se lleva el resto y la tercera nada, y dos réplicas a la vez no se llevan el mismo documento. doc-check sobre job-dispatch-mongo y notification-mailer-mongo. Falsado el 2026-10-08 sin el orden: caen el lote y la pasada siguiente"
      }
    }
  },
  'sweep-claim-rescue': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::claimForStalledDispatchJobsDone',
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::staleBefore'
        ],
        document: [
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::claimForStalledDispatchJobsDone',
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::staleBefore'
        ]
      }
    },
    emitter: 'src/scaffold/claim.js (claim.stalled de keel-core/gen/model.js) · el plazo desde service.parameters (src/scaffold/service-parameters.js) o sweep.<x>.stalled-after-seconds',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check sobre job-dispatch (plazo enlazado al parámetro abandonAfterMinutes, DSL 2.18): se lleva solo lo abandonado, no cambia el estado (lo arrienda), renueva el reloj en el mismo UPDATE, la pasada siguiente ya no lo ve, y lo recién entrado en vuelo no se toca. Falsado el 2026-10-07 quitando la cota temporal: caen esas tres comprobaciones y solo esas'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          "el rescate arrienda: renueva el reloj SOLO si sigue atascado más que su plazo, sin mover el estado; lo recién entrado en vuelo no se toca y la pasada siguiente ya no lo ve. doc-check sobre job-dispatch-mongo. Falsado el 2026-10-08 moviendo el estado en el mismo $set: cae «no cambia el estado» y solo esa"
      }
    }
  },
  'guard-claim': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'src/infrastructure/persistence/repositories/notification-repository-impl.ts::claimForSendAcceptedNotification',
          'src/infrastructure/persistence/repositories/notification-repository-impl.ts::inNewTransaction'
        ],
        document: [
          'src/infrastructure/persistence/repositories/notification-repository-impl.ts::claimForSendAcceptedNotification',
          'src/infrastructure/persistence/repositories/notification-repository-impl.ts::findOneAndUpdate('
        ]
      }
    },
    emitter: 'src/scaffold/claim.js (adapterGuardMethods, sobre operation.guardClaim de keel-core/gen) · src/scaffold/document-stores.js (documentGuardMethods) · el puerto de repositories.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check, en los dos motores, sobre notification-mailer: la primera ejecución se lleva la fila y la pasa al estado en vuelo con su reloj estampado, la SEGUNDA devuelve null y una lectura posterior ve la marca confirmada (inNewTransaction, fuera de la del caso de uso). Falsado el 2026-10-08 quitando la condición de estado del UPDATE: cae «por segunda vez devuelve null» y solo esa. El USO en el handler (llamarla antes del envío) lo vigila la familia mailDelivery del gate'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'findOneAndUpdate por _id y estado de partida, sin la sesión del caso de uso: lo mismo que la rama relacional, en doc-check sobre notification-mailer-mongo. Falsado el 2026-10-08 quitando el estado del filtro: cae «por segunda vez devuelve null» y solo esa'
      }
    }
  },
  'harness-db-probes': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'test/integration/support/flow.ts::export function stallInFlight(',
          'test/integration/support/flow.ts::export function putInFlight(',
          'test/integration/support/flow.ts::export function inFlightWithoutClock(',
          'test/integration/support/flow.ts::UPDATE jobs SET'
        ],
        document: [
          'test/integration/support/flow.ts::export function stallInFlight(',
          'test/integration/support/flow.ts::export function putInFlight(',
          'test/integration/support/flow.ts::export function inFlightWithoutClock(',
          'test/integration/support/flow.ts::export function mongoEval('
        ]
      }
    },
    emitter: 'src/scaffold/integration-tests.js (rescueSection: stallInFlight, putInFlight, inFlightWithoutClock, sobre rescueProbes de keel-core/gen) · src/scaffold/messaging-harness.js (abandonOutboxEvent)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: false,
        why:
          'las MISMAS sentencias del arnés, con los literales del motor, ejecutadas por db-check contra PostgreSQL y MySQL: la fila que deja stallInFlight la rescata el reclamo generado y la de putInFlight no, e inFlightWithoutClock cuenta cero y ve la fila sin reloj. Sin falsar por mutación'
      },
      document: {
        state: 'verificado',
        net: 'doc-harness-check',
        falsified: true,
        why:
          'mongoEval por ARCHIVO y envuelto en print (keel-core/gen/mongo-probes.js, la fuente del AbstractFlowIT de keel-spring), el reset que vacía documentos y conserva índices, stallInFlight y putInFlight con setStateScript (estado y reloj rancio, o a ahora), inFlightWithoutClock discriminando y ageForReconciliation con ageClockScript. doc-harness-check los ejecuta contra la infra/ real de job-dispatch-mongo (y el script de envejecimiento que emite asset-vault), con el humo y score-scenarios.sh. Falsado el 2026-10-08: sin el print cae el humo (score sale con 2); putInFlight con el reloj rancio, el recuento sobre otro campo y el envejecimiento sobre otro campo caen cada uno en su sonda. Y el outbox del arnés lee la colección por la TransactionContext del servidor arrancado, sin SQL'
      }
    }
  },
  'schema-baseline': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'file:infra/export-schema.sh',
          'file:infra/verify-baseline.sh',
          'file:src/infrastructure/persistence/schema-baseline.ts'
        ],
        document: ['file:infra/export-indexes.sh', 'file:src/infrastructure/persistence/document-indexes.ts']
      }
    },
    emitter: 'src/scaffold/schema-baseline.js (schema-baseline.ts, infra/export-schema.sh e infra/verify-baseline.sh)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'harness-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'export-schema.sh vacía el esquema local y le pide a TypeORM el DDL completo de las entidades; verify-baseline.sh aplica las migraciones sobre un esquema vacío —lo que hace el arranque en develop y production con migrationsRun— y exige que TypeORM no vea diferencia. harness-check lo ejecuta en los dos motores sobre product-catalog. Falsado el 2026-10-06 quitándole al baseline su última sentencia: la verificación sale en rojo nombrando lo que falta. A diferencia de keel-spring (baselineTested: PENDING), la prueba en vivo SÍ cabe en el pipeline: en local el esquema lo recrea synchronize. Lo que no mide: un diseño con FK entre tablas, porque product-catalog tiene una sola'
      },
      document: {
        state: 'verificado',
        net: 'doc-harness-check',
        falsified: true,
        why:
          'no hay baseline que redactar: los índices salen enteros del diseño (document-indexes.ts, los de keel-core/gen/document.js) y el servidor los crea al arrancar. Lo que hace el agente de calidad, doc-harness-check lo EJECUTA contra la infra/ real de job-dispatch-mongo, con el servidor ya arrancado por los flujos: infra/export-indexes.sh exporta los vivos y cada índice del contrato está, con sus claves, su unicidad y su filtro, y no sobra ninguno. Falsado el 2026-10-12 quitándole uk_jobs_natural al document-indexes.ts emitido (--sabotage=index): cae «están los índices del contrato» nombrando jobs.uk_jobs_natural (y la sonda del arnés que mira ese índice); las otras dos del baseline siguen en verde'
      }
    }
  },
  'transient-write-conflict': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ["src/infrastructure/persistence/persistence-errors.ts::'40P01'", 'WRITE_CONFLICT_ATTEMPTS'],
        document: [
          'src/infrastructure/persistence/persistence-errors.ts::TransientTransactionError',
          'WRITE_CONFLICT_ATTEMPTS'
        ]
      }
    },
    emitter: 'src/scaffold/mediator.js · src/scaffold/persistence-runtime.js (isTransientWriteConflict)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'el UseCaseMediator reintenta tres veces la transacción de escritura que pierde un interbloqueo y, agotado, sale como 409 de concurrencia. db-check fabrica un interbloqueo DE VERDAD con el TransactionContext generado (dos transacciones, dos filas en orden inverso) y exige que se clasifique como transitorio, y una espera de bloqueo más allá del tope que tiene que salir como tope (503) y no como conflicto. Falsado el 2026-10-06 rompiendo cada clasificación por separado (40P01/1213, y 57014/1205/3024): cae su comprobación en los dos motores y solo esa. En MySQL el tope llega casi siempre por max_execution_time (3024), no por la espera de bloqueo. Lo que no se ejecuta es el BUCLE de reintento del mediator, que necesita un handler implementado'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'dos transacciones que escriben el mismo documento: MongoDB aborta a la segunda con un WriteConflict (112, TransientTransactionError), y doc-check exige que isTransientWriteConflict lo clasifique como transitorio —el que el mediator reintenta tres veces y, agotado, es un 409—. La transacción es manual y no withTransaction, que reintentaría dos minutos por su cuenta. Falsado el 2026-10-08 con un clasificador que no reconoce el código: cae la carrera en los tres sujetos y solo ella'
      }
    }
  },
  'document-indexes': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [],
        document: [
          'file:src/infrastructure/persistence/document-indexes.ts',
          'ensureDocumentIndexes',
          'file:infra/export-indexes.sh'
        ]
      }
    },
    emitter: 'src/scaffold/document-persistence.js (document-indexes.ts, sobre documentIndexes de keel-core/gen/document.js)',
    coverage: {
      relational: { state: 'no-aplica', why: 'en relacional los índices los declara la entidad y los crea el esquema (migraciones)' },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'los índices se crean al ARRANCAR con los nombres del diseño, y doc-check lee los VIVOS (listIndexes) contra keel-core/gen/document.js: nombre, claves en orden, unicidad y filtro parcial, y que crearlos otra vez no falla. El filtro parcial va con el valor ALMACENADO (la constante del enum). Falsado el 2026-10-08 con el literal del diseño en el filtro: cae el índice de Template y el invariante condicionado, y solo esos'
      }
    }
  },
  'partial-unique-index': {
    emitter: 'src/scaffold/persistence-entities.js (sobre partialIndexSpecs de keel-core/gen/relational.js)',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'índice parcial (@Index con where). db-check pregunta al MOTOR el invariante entero sobre Template (notification-mailer): dos con la misma clave en `active` no conviven y sale el error del diseño, una tercera en otro estado sí, y el finder del ocupante la encuentra. Falsado el 2026-10-06 con el predicado en minúsculas (el literal del diseño en vez de la constante): cae «no conviven» y solo ese. schema-parity compara además el predicado letra a letra con el apéndice SQL de keel-spring'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'la columna generada DECLARADA `<índice>_flag` (1 dentro de la condición, NULL fuera) dentro del índice único, la misma forma que keel-spring. Falsado el 2026-10-06 quitando el discriminador del índice (la unicidad normal, el invariante CONTRARIO): cae «la misma clave en otro estado sí convive» con el Duplicate entry del propio índice. El predicado en minúsculas NO lo pone rojo en MySQL, y es correcto: su collation por defecto no distingue mayúsculas, así que el predicado casa igual'
      }
    }
  },
  'unique-collation': {
    emitter: 'src/scaffold/persistence-entities.js (collation de columnSpec, de caseSensitiveCollationFor)',
    coverage: {
      postgresql: { state: 'no-aplica', why: 'PostgreSQL compara el texto distinguiendo mayúsculas: no hay collation que forzar' },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'db-check lee del catálogo de MySQL la collation de cada columna de constraint única y exige utf8mb4_bin. Falsado el 2026-10-06 quitándole la collation al emisor: caen las columnas únicas de los cuatro sujetos. Lo que NO mide todavía es el COMPORTAMIENTO (que `acme-1` y `ACME-1` convivan), que keel-spring sí mide con mapping-check'
      }
    }
  },
  'claim-dialect': {
    emitter: 'src/scaffold/claim.js y messaging-stores.js (setLock pessimistic_write + setOnLocked skip_locked; READ COMMITTED en MySQL)',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'FOR UPDATE SKIP LOCKED: la fila bloqueada por otra transacción se salta sin esperar (el reclamo de barrido y el del outbox). Falsado quitando el bloqueo: el reclamo espera a la fila hasta el tope'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why: 'FOR UPDATE SKIP LOCKED en READ COMMITTED (en REPEATABLE READ bloquearía también los huecos entre claves y frenaría las altas). Mismo caso y misma falsación que en PostgreSQL'
      }
    }
  },
  'harness-sql-literals': {
    emitter: 'src/scaffold/integration-tests.js (staleTimestamp, nowTimestamp y uuidLiteral de DATABASES en keel-core/gen/infra-catalog.js)',
    coverage: {
      postgresql: { state: 'verificado', net: 'db-check', falsified: false, why: "TIMESTAMP '1970-01-01 00:00:00' y el uuid entre comillas CASAN: la fila atascada por la sentencia del arnés la rescata el reclamo generado" },
      mysql: { state: 'verificado', net: 'db-check', falsified: false, why: "el mismo instante sobre datetime(6) y UUID_TO_BIN('…') sobre la columna binary(16): la fila atascada la rescata el reclamo generado" }
    }
  },
  'telemetry-store-spans': {
    parity: {
      skip: 'la telemetría es una elección de STACK (telemetry: otel) y el par se genera sin ella; lo que hay que ver es que NO se emiten spans de los drivers en ninguna rama (degradado), y lo fija este test generando con la opción',
      test: 'test/telemetry.test.js'
    },
    emitter: 'src/scaffold/telemetry.js (los spans que abre el código generado: caso de uso, HTTP de entrada y salida, mensajería, caché, storage y correo)',
    coverage: {
      relational: {
        state: 'degradado',
        why:
          'keel-spring cuelga de cada caso de uso los spans de JDBC (datasource-micrometer); keel-nest no instrumenta los drivers (pg, mysql2): en ESM la instrumentación automática de OpenTelemetry exige un loader hook (import-in-the-middle) delante de la aplicación, y el proyecto arranca sin él. La traza llega hasta el span del caso de uso, con su duración y su desenlace, y ahí se para: la consulta lenta se ve como un caso de uso lento, no como la sentencia. El eje de telemetría del plan (las series y sus etiquetas, que consultan el panel y las alertas) no depende de esto, y telemetry-check lo mide entero. Salida: registrar @opentelemetry/instrumentation-pg y -mysql2 con su hook en el arranque, y medirlo en telemetry-check'
      },
      document: {
        state: 'degradado',
        why:
          'lo mismo con el driver de MongoDB (keel-spring: MongoObservationCommandListener) y con @redis/client: sin el hook de ESM no hay span del comando, y la traza se para en el caso de uso. Salida: @opentelemetry/instrumentation-mongodb y -redis con el mismo hook'
      }
    }
  },
  'folded-text': {
    parity: {
      skip: 'ningún par declara `compare` —meterlo en uno movería la clave natural que miden db-check y doc-check—, así que las dos ramas las cubre un test que genera las dos con la opción (y las EJECUTAN db-check sobre catalog-extended y doc-check sobre job-dispatch-mongo derivada)',
      test: 'test/filter-fold.test.js'
    },
    emitter: 'src/scaffold/persistence-entities.js (la columna sombra) · src/scaffold/repositories.js (TextFold al guardar)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'la sombra se crea con su cota y la estampa el adaptador (catalog-extended: Category.slug, clave natural sobre la sombra), y db-check guarda la misma clave EN MAYÚSCULAS y exige que el motor la rechace. Falsado el 2026-10-06 con un TextFold que no pliega: cae esa comprobación y solo esa'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'ninguna fixture documental declara compare, así que doc-check lo mide sobre un sujeto DERIVADO (job-dispatch-mongo con compare: ignore-case-accents en la clave natural): el documento guarda en reference_normalized el valor plegado por TextFold (y documentShape la exige, sin claves de más), y el mismo valor en mayúsculas y sin acentos es la MISMA clave para el índice único → 409. Falsado el 2026-10-12 con un TextFold que no pliega: caen esas dos comprobaciones y solo esas (26/28; los demás sujetos, en verde)'
      }
    }
  },
  'persistence-adapter': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: ['file:src/infrastructure/persistence/entities/job-orm.ts', 'class JobRepositoryImpl'],
        document: [
          'src/infrastructure/persistence/repositories/job-repository-impl.ts::Collection',
          'class JobRepositoryImpl'
        ]
      }
    },
    emitter: 'src/scaffold/persistence-entities.js · src/scaffold/repositories.js · src/scaffold/persistence-runtime.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check sobre 4 sujetos y 8 raíces en los dos motores: el esquema contra el catálogo del motor, la cota que rechaza el motor, ida y vuelta por el adaptador (escala, bigint, uuid, fechas, listas de escalares y de value objects, hijas uni y bidireccionales), la fila en crudo, la versión obsoleta → conflicto, la clave natural duplicada → el error del diseño, página y borrado del grafo. Falsado el 2026-10-06 con tres sabotajes aislados (sin comprobar la versión, hijas en orden inverso, enum por su literal), cada uno cazado por su comprobación y solo por ella. Destapó la FK de una relación escrita sin el transformador del id (en MySQL, texto en un binary(16))'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'doc-check contra un MongoDB en replica set sobre inspection-reports, job-dispatch-mongo y notification-mailer-mongo (6 raíces): el documento CRUDO contra documentShape a todo nivel —cada clave con su tipo BSON y ninguna de más—, ida y vuelta, versión obsoleta → 409, clave natural e índice condicionado → el error del diseño, created_at que no cambia, página con orden por la ruta del espejo y borrado; y la DB_URL de keel-spring tal cual. Falsado el 2026-10-08 con seis sabotajes que compilan (decimal como texto, la versión fuera del filtro, _class en el documento, created_at reescrito, uuid como texto en los dos sentidos —la ida y vuelta sigue en verde: solo lo caza el documento crudo—), cada uno cazado por su comprobación. Sin red: document-persistence.test.js lo ejecuta con un sustituto del driver'
      }
    }
  },
  'conditional-write': {
    parity: {
      skip: 'ningún par declara api.concurrency (catalog-extended la declara sobre updateProduct, pero no tiene gemela documental); el texto lo fijan test/uncovered-branches.test.js y test/conditional-writes.test.js, que lo compara con keel-dotnet, sobre las siluetas de keel-core/test/helpers/conditional-write-designs.js',
      test: 'test/conditional-writes.test.js'
    },
    emitter: 'src/scaffold/conditional-writes.js (Versioned, las excepciones, conditional-requests.ts, loadExpecting, el gate y las pruebas emitidas) · controllers.js · services.js · repositories.js y document-repositories.js · cache.js · security.js (CORS)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'catalog-conditional: CW-1 a CW-5 contra el adaptador de TypeORM en PostgreSQL y MySQL (scripts/lib/conditional-probes.js). Falsado con --subject=catalog-conditional: cw-ignore-expected cae en CW-2, cw-stale-version en CW-4 y cw-collapse-409 en CW-5 (y en las sondas previas de la versión obsoleta, que miden el mismo 409). El borde, en ts-check sobre las siluetas: CW-6 a CW-10 en las pruebas emitidas, falsadas con --sabotage=cw-no-428 (CW-6), cw-weak-match (CW-7), cw-error-map (CW-8) y cw-cors (CW-9); CW-11 (el codec de la caché, ejecutado) y CW-12 (el gate, ejecutado con bash) en test/conditional-writes.test.js, falsados con cw-cache-etag y cw-gate'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'catalog-conditional-mongo: CW-1 a CW-5 contra el adaptador del driver de MongoDB en un replica set real, con las MISMAS sondas que db-check. Falsado con --subject=catalog-conditional-mongo: cw-ignore-expected cae en CW-2, cw-stale-version en CW-4 y cw-collapse-409 en CW-5 (y en las sondas previas de la versión obsoleta)'
      }
    }
  },
  'read-scope': {
    parity: {
      skip: 'ningún par byte a byte declara reads (asset-vault, documental, y shop-api, relacional, los declaran desde el incremento 7 de PLAN-DSL-227-LECTURA-ACOTADA.md, pero ninguna tiene gemelo con el otro modelo): los sujetos son los diseños de keel-core/test/helpers/read-scope-designs.js (vault-scoped y vault-scoped-mongo, el mismo diseño salvo el modelo; shop-scoped y conduit-scoped), los MISMOS que mide keel-spring; test/read-scope.test.js fija la forma y la compara con keel-spring',
      test: 'test/read-scope.test.js'
    },
    emitter: 'src/scaffold/read-scope.js (ReadScope, ReadScopes, el predicado en el where y en el filtro, loadScoped) · finders.js · repositories.js y document-repositories.js · controllers.js · services.js · cache.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'vault-scoped (el salto Asset.owner → Owner.code como subconsulta del QueryBuilder dentro de un Raw) y shop-scoped (la propiedad sobre la propia fila, forbidden, la carga por la clave de la ruta y un filtro sumado): RS-1 a RS-8 contra el adaptador de TypeORM en PostgreSQL y MySQL (scripts/lib/read-scope-probes.js). Falsado: rs-no-filter cae en RS-1, RS-2 y RS-6, rs-count-unscoped en RS-2, rs-get-leak en RS-5, rs-empty-is-all en RS-6, rs-finder-replace en RS-7 (shop-scoped); rs-path en RS-8 (vault-scoped). RS-9 a RS-11 (la clave de caché, ReadScopes desde un principal y el 403 del filtro de errores), ejecutando lo emitido en test/read-scope.test.js, falsados con rs-cache-key y la mitad del borde de rs-empty-is-all'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'vault-scoped-mongo (el salto resuelve los ids de owners y filtra owner_id) y conduit-scoped (el dueño por Article.author → Profile.subject, not-found y la carga por slug) contra el driver de MongoDB en un replica set real, con las MISMAS sondas que db-check. Falsado con los mismos sabotajes, cada uno en exactamente sus casos'
      }
    }
  },
  'data-lifecycle': {
    parity: {
      skip: 'ninguna fixture declara el ciclo de vida del dato hasta el incremento 6 de PLAN-DSL-228-CICLO-DE-VIDA.md: los sujetos son los diseños derivados de keel-core/test/helpers/data-lifecycle-designs.js (cards-logical y cards-logical-mongo, el mismo diseño salvo el modelo; codes-anonymize y codes-anonymize-mongo; codes-delete y vault-logical-scoped), los MISMOS que mide keel-spring; test/data-lifecycle-parity.test.js fija la forma y la compara con keel-spring (los mismos casos, índices, kind y claves del barrido)',
      test: 'test/data-lifecycle-parity.test.js'
    },
    emitter: 'src/scaffold/data-lifecycle.js (marcas, lecturas vivas, deleteById que marca, restore, retención y su recurrente) · repositories.js y document-repositories.js · finders.js · persistence-entities.js y document-persistence.js (la unicidad entre vivas) · claim.js, reconciliation-claim.js y document-stores.js · timer.js · services.js · logging-check.js, persistence-runtime.js y rest-support.js (PD-1 y PD-2)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'cards-logical, codes-anonymize, codes-delete y vault-logical-scoped contra el adaptador de TypeORM (scripts/lib/lifecycle-probes.js): LC-1 a LC-10, RT-1 a RT-4 y PD-2; PD-1 es el gate ejecutado con bash en test/data-lifecycle-parity.test.js. La unicidad entre vivas es el índice parcial en PostgreSQL y la columna generada en MySQL (T2). Medido aquí y no supuesto: en PostgreSQL el mensaje del driver de una unicidad violada NO lleva el valor (va en detail, que ningún log copia), así que pd-log-value solo cae en MySQL; en MySQL lo lleva, y lo copiaban el logger de TypeORM y la rama sin constraint del filtro de la API. Y en MySQL, con una columna generada (el discriminador de la unicidad entre vivas o de la condicionada), TypeORM recarga la fila tras el INSERT y volvía a pasar el id por UUID_BINARY.from, que lo deformaba: save devolvía un id que no existe. El transformador es idempotente desde entonces. Falsado: lc-no-filter cae en LC-1 y LC-2, lc-count en LC-2, lc-get-leak en LC-3 y LC-4, lc-unique-all-rows en LC-5, lc-restore-window en LC-7, lc-embed-hidden en LC-9, lc-implicit-replace en LC-10, rt-early en RT-1, rt-anonymize-miss en RT-2, rt-every-replica en RT-3 y pd-log-value en PD-2'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'cards-logical-mongo y codes-anonymize-mongo contra el driver de MongoDB en un replica set real, con las MISMAS sondas que la rama relacional; el índice parcial lleva deletedAt: null (T1). Medido: el mensaje E11000 SÍ lleva el valor duplicado, así que pd-log-value cae aquí. Falsado: lc-get-leak en LC-3 y LC-4, lc-unique-all-rows en LC-5, lc-restore-window en LC-7, rt-early en RT-1, rt-anonymize-miss en RT-2, rt-every-replica en RT-3 y pd-log-value en PD-2. LC-1, LC-2, LC-9 y LC-10 no tienen sujeto documental (ningún diseño derivado lista, embebe ni acota con borrado lógico sobre documentos): su código es el mismo filtro deletedAt: null que miden LC-3 y LC-4, pero sin ejecutar'
      }
    }
  }
};

/** Todas las celdas, aplanadas: { id, branch, cell } (sin las filas pendientes enteras). */
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

/** Lo que keel-nest todavía no genera, con el incremento que lo trae (filas y celdas). */
export function pending() {
  const rows = Object.entries(MECHANISMS).filter(([, row]) => row.pending).map(([id, row]) => ({ id, branch: null, pending: row.pending }));
  const branches = cells().filter(({ cell }) => cell.pending).map(({ id, branch, cell }) => ({ id, branch, pending: cell.pending }));
  return [...rows, ...branches];
}
