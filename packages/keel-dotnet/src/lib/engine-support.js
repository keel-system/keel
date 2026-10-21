// La matriz de paridad de keel-dotnet: la MISMA lista de mecanismos que keel-spring y keel-nest
// (keel-core/gen/mechanisms.js, que razona por qué existe), con las celdas de este generador.
//
// Cada mecanismo del catálogo tiene aquí su fila, sin excepción (lo vigila test/engine-support.test.js):
//   · `pending`  keel-dotnet todavía no lo genera, y la fila nombra el incremento que lo trae. No es una
//                celda «razonada»: no hay código que razonar. Es la frontera de supported-features.js
//                vista mecanismo a mecanismo;
//   · `coverage` lo genera, celda por modelo o por motor (según el `axis` del catálogo), con el mismo
//                vocabulario de estados que keel-spring y keel-nest, y SUS redes.
//
// La frontera de motores también se dice: keel-dotnet genera la persistencia relacional sobre PostgreSQL y MySQL
// y RECHAZA en build los demás motores relacionales del catálogo (`SUPPORTED_DATABASES`), así que sus celdas no
// son `degradado` —nada se emite que prometa menos— sino fuera de la frontera, y la matriz las imprime así.
//
// La matriz nació al cerrar el incremento 13 (PLAN-KEEL-DOTNET.md, tramo previo al 14): hasta entonces la
// cobertura de cada mecanismo estaba escrita en prosa en el plan. Pasarla aquí destapó tres celdas que ninguna red
// ejecutaba (`transient-write-conflict` en relacional y `folded-text` en las dos ramas); el mismo tramo les dio sus
// sondas y sus sabotajes en db-check y doc-check.

import { MECHANISM_CATALOG, STATES } from 'keel-core/gen/mechanisms';
import { SUPPORTED_DATABASES } from './supported-features.js';

export { MECHANISM_CATALOG, STATES };

/** Los motores relacionales que keel-dotnet genera (el eje `engine` del catálogo): los demás, fuera de la frontera. */
export const RELATIONAL_ENGINES = SUPPORTED_DATABASES.filter((database) => database !== 'mongodb');

/** Las redes de keel-dotnet que EJECUTAN algo. */
export const NETS = {
  'cs-check':
    'npm run cs-check — restaura, compila sin warnings y prueba la solución de todas las fixtures (las pruebas EMITIDAS incluidas), comprueba licencias, genera el baseline con dotnet ef y ARRANCA el servidor contra PostgreSQL (con --database=mysql, contra MySQL)',
  'db-check':
    'npm run db-check [-- --database=postgresql|mysql] — los ADAPTADORES contra PostgreSQL y MySQL reales: sondas xUnit generadas desde el modelo (ida y vuelta, fila en crudo, versión, unicidad también condicionada, cota, página y borrado), el esquema contra el catálogo del motor, y los almacenes del generador (outbox, procesados, idempotencia, reclamos, rescate, reconciliación, purgas)',
  'doc-check':
    'npm run doc-check — la persistencia DOCUMENTAL contra un MongoDB real en replica set: el documento crudo contra el contrato, índices vivos, versión, unicidad, la carrera de dos transacciones, la auditoría y los almacenes del generador sobre colecciones',
  'harness-check':
    'npm run harness-check [-- --database=mysql] — el arnés contra la infra/ real: flujos sonda caja negra, cada código de score-scenarios.sh y el baseline de dotnet ef verificado y falsado',
  'doc-harness-check':
    'npm run doc-harness-check — el arnés documental contra la infra/ real: MongoEval, reset, rescate, reconciliación, puntuación e índices vivos con export-indexes.sh',
  'broker-check':
    'npm run broker-check [-- --broker=rabbitmq|kafka|snssqs] — la mensajería contra RabbitMQ, Kafka y LocalStack reales: dispatcher y listener, el relay con el broker caído y los helpers del arnés',
  'telemetry-check':
    'npm run telemetry-check — la telemetría con la app ARRANCADA contra PostgreSQL y MySQL y un colector OTLP falso: series, exemplar, runtime, el pool de Npgsql y el de MySqlConnector, la traza, los logs y el puerto de gestión',
  'deploy-check':
    'npm run deploy-check — deploy/ entero con su up.sh (la app en contenedor, el colector y el backend) y las preguntas al backend que comparten los tres generadores',
  ninguna: 'nadie lo ejecuta'
};

export { SUPPORTED_DATABASES };

export const MECHANISMS = {
  'runtime-panel': {
    parity: {
      skip: 'la telemetría es una elección de STACK (telemetry: otel) y el par se genera sin ella; el panel y sus series los comparan con keel-spring test/observability-assets.test.js y la prueba emitida TelemetryTests, generando con la opción',
      test: 'test/observability-assets.test.js'
    },
    emitter: 'src/scaffold/observability-assets.js (los neutrales de keel-core/gen/observability-assets.js con DOTNET_RUNTIME) · las series en src/scaffold/telemetry.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'telemetry-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la fila de runtime de .NET (heap gestionado contra TotalAvailableMemoryBytes, pausas de GC, cola del thread pool) y el pool de Npgsql leído de su Meter (keel_db_pool_*). La prueba emitida TelemetryTests exige en cs-check que el scrape publique toda serie del panel y de las alertas, y que el pool salga de los instrumentos que publica Npgsql 10.0.3, medidos con un MeterListener: db.client.connection.count por estado, .max y db.client.connection.npgsql.pending_requests (sabotaje telemetry-pool: con el nombre sin npgsql la saturación salía siempre a 0). En MySQL, el de MySqlConnector 2.6.2, con OTROS nombres (medidos igual): db.client.connections.usage por state (incrementos, no observable), .max y .pending_requests; su sabotaje es telemetry-pool-mysql. telemetry-check, con la app arrancada contra PostgreSQL y contra MySQL: el pool con el tamaño configurado y sus conexiones de vuelta como libres; falsado leyendo un instrumento que no existe (cae TEL-7 y solo él, en los dos motores). deploy-check: las series llegan al backend y el panel y las alertas entran'
      },
      document: {
        state: 'degradado',
        why:
          'MongoDB.Driver no publica sus contadores de pool sin suscribirse a sus eventos de conexión, así que keel-dotnet, como keel-nest, no publica serie de pool en el modelo documental: el panel no trae esa celda ni la alerta de saturación (keel-spring sí, con mongodb_driver_pool_*). Sin serie, ni fila ni alerta: una consulta sobre una serie que nadie publica dejaría el panel vacío y la alerta muda'
      }
    }
  },
  'outbox-relay': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'src/NotificationMailer.Infrastructure/Messaging/Outbox/OutboxRelayStore.cs::FOR UPDATE SKIP LOCKED',
          'file:src/NotificationMailer.Infrastructure/Persistence/Rows/OutboxEventRow.cs'
        ],
        document: [
          'src/NotificationMailerMongo.Infrastructure/Messaging/Outbox/OutboxRelayStore.cs::FindOneAndUpdateAsync',
          'src/NotificationMailerMongo.Infrastructure/Messaging/Outbox/OutboxRelayStore.cs::claimed_at'
        ]
      }
    },
    emitter: 'src/scaffold/messaging-stores.js (sobre OUTBOX_EVENT y OUTBOX_RELAY de keel-core/gen/messaging-stores.js) · document-stores.js en la rama documental · el puente de messaging.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la tabla outbox_event es la de keel-spring (schema-parity) y los parámetros del relay, los de keel-core. db-check: el puente escribe la fila en la transacción del cambio (y nada si revierte), el reclamo en orden y con su lote, el lease, SKIP LOCKED sin esperar a la fila retenida por otra transacción, el backoff, la rendición y su cuenta, y la purga por lotes sin tocar lo pendiente. Falsado con --sabotage=lease (el lease en el pasado), skip-locked y purge (el corte por created_at), cada uno cazado por su sonda. broker-check lo ejecuta además contra los tres brokers reales con el broker caído'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'el reclamo con FindOneAndUpdate en orden de llegada, la marca claimed_at que caduca, dos réplicas sin repetir, backoff y rendición, el puente en la sesión del cambio y la purga por lotes. Falsado con outbox-order (medido con el índice de pendientes RETIRADO: con él el sabotaje salía verde), outbox-mark, bridge-session, purge-batch y purge-column (12c)'
      }
    }
  },
  'idempotency-request': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'file:src/NotificationMailer.Infrastructure/Persistence/Rows/IdempotencyRecordRow.cs',
          'src/NotificationMailer.Infrastructure/Persistence/IdempotencyStore.cs::IdempotencyConflictException'
        ],
        document: [
          'src/NotificationMailerMongo.Infrastructure/Persistence/IdempotencyStore.cs::Records.InsertOneAsync(',
          'src/NotificationMailerMongo.Infrastructure/Persistence/IdempotencyStore.cs::IdempotencyConflictException'
        ]
      }
    },
    emitter: 'src/scaffold/request-idempotency.js (sobre IDEMPOTENCY_RECORD de keel-core/gen/request-idempotency.js) · document-stores.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'idempotency_record es la tabla de keel-spring (schema-parity). db-check: guardar y encontrar, el ámbito en la clave, la clave repetida y la CARRERA de dos transacciones como su conflicto con su code, la caducada sustituible, el rollback con el comando y la purga de las caducadas por lotes. Falsado con --sabotage=idempotency (el traductor no reconoce la PK): caen exactamente las dos del conflicto. Lo que no ejecuta ninguna red: el USO en el handler, que escribe el agente'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'el _id subdocumento {operation_scope, idempotency_key} EN ESE ORDEN, en la sesión del caso de uso, con las mismas sondas que la rama relacional (solo usan la API) más el documento crudo. Falsado con key-order: find y save siguen casando entre sí, solo lo caza el documento crudo contra el contrato'
      }
    }
  },
  'idempotency-consume': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['src/NotificationMailer.Infrastructure/Messaging/Idempotency/IdempotencyGuard.cs::ProcessedEventRow'],
        document: ['src/NotificationMailerMongo.Infrastructure/Messaging/Idempotency/IdempotencyGuard.cs::Processed.InsertOneAsync(']
      }
    },
    emitter: 'src/scaffold/messaging-stores.js (IdempotencyGuard, sobre PROCESSED_EVENT de keel-core/gen/messaging-stores.js) · document-stores.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'processed_event es la tabla de keel-spring; db-check: la primera entrega marca, la repetida se reconoce, dos entregas a la vez gana una y la purga por lotes. Falsado con --sabotage=guard (la violación de unicidad confundida con otra): cae la carrera. broker-check lo ejecuta con la reentrega real de los tres brokers'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'el mismo registro con su _id subdocumento y las mismas sondas que la rama relacional. Falsado con guard (el duplicado no se reconoce): cae la repetición'
      }
    }
  },
  'reconciliation-claim': {
    parity: {
      skip: 'su sujeto NO es un par byte a byte sino dos diseños distintos (stock-reservation y catalog-extended relacionales, asset-vault documental), igual que en keel-spring y keel-nest; las dos ramas las EJECUTAN db-check y doc-check, y la forma la fija este test',
      test: 'test/reconciliation.test.js'
    },
    emitter: 'src/scaffold/reconciliation-claim.js (sobre RECONCILIATION_CLAIM de keel-core/gen/reconciliation-stores.js) · document-stores.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la marca en reconciliation_claim con UNA sentencia INSERT … ON CONFLICT DO UPDATE … WHERE (en PostgreSQL un error aborta la transacción), la lectura que excluye los candidatos de marca viva, el umbral, la caducidad de la marca y la purga. Falsado con reconciliation-expiry, -threshold y -head, cada uno cazado por su sonda (11c)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'upsert sobre la marca caducada y candidatos que excluyen los retenidos, en asset-vault. Falsado con reconciliation-held, -threshold y -expiry (12c)'
      }
    }
  },
  'sweep-claim-queue': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'src/JobDispatch.Infrastructure/Persistence/Repositories/JobRepository.cs::ClaimForDispatchJobsRunning',
          'src/JobDispatch.Infrastructure/Persistence/Repositories/JobRepository.cs::SKIP LOCKED'
        ],
        document: [
          'src/JobDispatchMongo.Infrastructure/Persistence/Repositories/JobRepository.cs::ClaimForDispatchJobsRunning',
          'src/JobDispatchMongo.Infrastructure/Persistence/Repositories/JobRepository.cs::FindOneAndUpdate'
        ]
      }
    },
    emitter: 'src/scaffold/claim.js (sobre operation.claim[], claimOrderField y sweepConfig de keel-core/gen) · document-stores.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'la cola (orden, lote, destino, reloj estampado y la pasada siguiente), dos réplicas a la vez sin repetir, SKIP LOCKED con otra transacción reteniendo una fila y la negativa a correr dentro de otra transacción (RequireOwnTransaction). Falsado con --sabotage=claim-skip-locked: cae solo la sonda de SKIP LOCKED (10c)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'FindOneAndUpdate en orden y con lote, sin repetir entre dos réplicas. Falsado con claim-state y claim-order; el del orden era una mutación equivalente mientras los instantes de las muestras crecían como el _id (UUIDv7), y ahora se siembran al revés de la inserción'
      }
    }
  },
  'sweep-claim-rescue': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'src/JobDispatch.Infrastructure/Persistence/Repositories/JobRepository.cs::ClaimForStalledDispatchJobsDone',
          'src/JobDispatch.Infrastructure/Persistence/Repositories/JobRepository.cs::staleBefore'
        ],
        document: [
          'src/JobDispatchMongo.Infrastructure/Persistence/Repositories/JobRepository.cs::ClaimForStalledDispatchJobsDone',
          'src/JobDispatchMongo.Infrastructure/Persistence/Repositories/JobRepository.cs::staleBefore'
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
        why: 'solo lo abandonado, arrienda sin cambiar el estado, el fresco intacto y lo renovado no se repite. Falsado con --sabotage=claim-stale (el rescate sin cota temporal): caen solo las dos del rescate (10c)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'las mismas preguntas sobre la marca del documento. Falsado con claim-stale (12c)'
      }
    }
  },
  'guard-claim': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'src/NotificationMailer.Infrastructure/Persistence/Repositories/NotificationRepository.cs::ClaimForSendAcceptedNotification',
          'src/NotificationMailer.Infrastructure/Persistence/Repositories/NotificationRepository.cs::CreateAsyncScope'
        ],
        document: [
          'src/NotificationMailerMongo.Infrastructure/Persistence/Repositories/NotificationRepository.cs::ClaimForSendAcceptedNotification',
          'src/NotificationMailerMongo.Infrastructure/Persistence/Repositories/NotificationRepository.cs::FindOneAndUpdate'
        ]
      }
    },
    emitter: 'src/scaffold/claim.js (ClaimFor<Op>, sobre operation.guardClaim de keel-core/gen) · document-stores.js · mail.js (la guarda del envío)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'el UPDATE condicional en un ámbito y una transacción PROPIOS: de dos a la vez gana una, y la marca existe para los demás durante el efecto externo. Falsado con --sabotage=send-guard (la guarda escribe en la transacción del caso de uso): cae la carrera (12e-b)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'FindOneAndUpdate sin la sesión del caso de uso. Falsado con send-guard (la marca en la sesión, que se deshace con ella)'
      }
    }
  },
  'harness-db-probes': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: [
          'tests/JobDispatch.IntegrationTests/Support/FlowTest.cs::protected static void StallInFlight(',
          'tests/JobDispatch.IntegrationTests/Support/FlowTest.cs::protected static void PutInFlight(',
          'tests/JobDispatch.IntegrationTests/Support/FlowTest.cs::protected static int InFlightWithoutClock(',
          'tests/JobDispatch.IntegrationTests/Support/FlowTest.cs::UPDATE jobs SET'
        ],
        document: [
          'tests/JobDispatchMongo.IntegrationTests/Support/FlowTest.cs::protected static void StallInFlight(',
          'tests/JobDispatchMongo.IntegrationTests/Support/FlowTest.cs::protected static void PutInFlight(',
          'tests/JobDispatchMongo.IntegrationTests/Support/FlowTest.cs::protected static int InFlightWithoutClock(',
          'tests/JobDispatchMongo.IntegrationTests/Support/Harness.cs::public static string MongoEval('
        ]
      }
    },
    emitter: 'src/scaffold/integration-tests.js (StallInFlight, PutInFlight, InFlightWithoutClock, sobre rescueProbes de keel-core/gen) · document-harness.js · messaging-harness.js (AbandonOutboxEvent)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check ejecuta las sentencias de StallInFlight, PutInFlight e InFlightWithoutClock TAL COMO LAS EMITE el arnés (el diccionario Rescues de Support/FlowTest.cs, leído del texto emitido) contra el motor, y exige que el reclamo generado rescate la fila atascada y deje la fresca. Falsado con harness-stall (StallInFlight atasca todas menos la pedida) y harness-missing-clock (InFlightWithoutClock cuenta las que sí tienen reloj): cae solo la sonda del rescate de job-dispatch y job-dispatch-cycles'
      },
      document: {
        state: 'verificado',
        net: 'doc-harness-check',
        falsified: true,
        why: 'MongoEval, el reset y los ayudantes del rescate y de la reconciliación contra la infra/ real, puntuados por score-scenarios.sh. Falsado con print (cae el humo: score sale con 2), put-clock y missing (12d)'
      }
    }
  },
  'schema-baseline': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['file:infra/export-schema.sh', 'file:infra/verify-baseline.sh', 'file:.config/dotnet-tools.json'],
        document: ['file:infra/export-indexes.sh', 'file:src/NotificationMailerMongo.Infrastructure/Persistence/DocumentIndexes.cs']
      }
    },
    emitter: 'src/scaffold/schema-baseline.js (infra/export-schema.sh, infra/verify-baseline.sh y la herramienta local dotnet-ef) · document-persistence.js en la rama documental',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'harness-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'cs-check genera el baseline con dotnet ef y arranca contra él; harness-check lo exporta, lo aplica y lo verifica. Falsado en sus dos ramas: una migración a la que le falta un índice y una cota cambiada sin migración ponen verify-baseline.sh en rojo (7c)'
      },
      document: {
        state: 'verificado',
        net: 'doc-harness-check',
        falsified: true,
        why: 'export-indexes.sh exporta los índices VIVOS y cada uno es el del contrato (keel-core/gen/document.js), sin que falte ni sobre ninguno. Falsado con --sabotage=index (un índice de menos)'
      }
    }
  },
  'transient-write-conflict': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [
          'src/NotificationMailer.Infrastructure/Persistence/PersistenceErrors.cs::PostgresErrorCodes.DeadlockDetected',
          'src/NotificationMailer.Infrastructure/Persistence/PersistenceTransactions.cs::WriteConflictAttempts'
        ],
        document: [
          'src/NotificationMailerMongo.Infrastructure/Persistence/PersistenceErrors.cs::TransientTransactionError',
          'src/NotificationMailerMongo.Infrastructure/Persistence/PersistenceTransactions.cs::WriteConflictAttempts'
        ]
      }
    },
    emitter: 'src/scaffold/persistence-runtime.js (PersistenceTransactions e IsTransientWriteConflict) · document-persistence.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check, en los 12 sujetos: dos ámbitos con su PersistenceTransactions bloquean dos filas en orden inverso, el motor aborta a uno (40P01) y la transacción lo repite ENTERA hasta que las dos terminan (tres intentos); y un interbloqueo que agota sus intentos sale como el 409 de concurrencia, no como un 500. Falsado con --sabotage=deadlock (el clasificador sin el 40P01) y retry (el bucle sin repetir): caen exactamente esas dos sondas'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'la carrera de dos transacciones: el clasificador del conflicto (la etiqueta TransientTransactionError y el código 112) y el 409 tras los reintentos. Falsado con transient; la primera versión quitaba solo la etiqueta y salía VERDE (el código 112 dice lo mismo: mutación equivalente), ahora quita las dos vías'
      }
    }
  },
  'document-indexes': {
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [],
        document: [
          'file:src/NotificationMailerMongo.Infrastructure/Persistence/DocumentIndexes.cs',
          'CreateIndexModel<BsonDocument>',
          'file:infra/export-indexes.sh'
        ]
      }
    },
    emitter: 'src/scaffold/document-persistence.js (DocumentIndexes.cs, sobre documentIndexes de keel-core/gen/document.js)',
    coverage: {
      relational: { state: 'no-aplica', why: 'en relacional los índices los declara el mapeo fluente de EF y los crea el esquema (migraciones)' },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why: 'los índices VIVOS contra keel-core/gen/document.js: nombre, claves en orden, unicidad y filtro parcial, ninguno de más, y crearlos dos veces no falla. Falsado con partial (el literal del diseño en el filtro parcial en vez de la constante almacenada)'
      }
    }
  },
  'partial-unique-index': {
    emitter: 'src/scaffold/persistence.js (HasFilter con el nombre del índice, sobre partialIndexSpecs de keel-core/gen/relational.js)',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'índice parcial (HasFilter). db-check pregunta al motor el predicado, contra el DISEÑO (partialIndexSpecs de keel-core) y no contra el mapeo emitido, que se daba la razón a sí mismo, y el invariante: la misma clave en el estado condicionado choca con el error del diseño. Falsado con partial-literal (el literal del diseño en minúsculas, el tropiezo de keel-nest): caen exactamente el predicado del catálogo y la sonda de la unicidad condicionada de notification-mailer'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'MySQL no tiene índices parciales: la columna GENERADA <índice>_flag (CASE WHEN <predicado> THEN 1 END, STORED, como propiedad sombra de EF) al final del índice único, la forma de keel-spring y keel-nest (schema-parity lo compara con el partial-indexes.sql de keel-spring). db-check lee de information_schema la expresión de la columna contra la constante ALMACENADA del diseño y que es la última columna del índice, y ejecuta el invariante. Falsado con discriminator (el índice sin la columna: caen la unicidad del diseño y el catálogo) y partial-literal (el literal en minúsculas: cae el catálogo; la sonda NO, porque la collation por defecto compara sin mayúsculas, lo mismo que midió keel-nest)'
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
        why:
          'utf8mb4_bin en cada columna única de texto (caseSensitiveCollationFor de keel-core, por UseCollation): la collation por defecto pliega mayúsculas y una unicidad rechazaría acme-1 por ACME-1. db-check lee collation_name de information_schema contra el DISEÑO (no contra el mapeo emitido). Falsado con collation (sin UseCollation): cae el catálogo de product-catalog. El comportamiento (las dos claves conviven) no lo ejecuta ninguna sonda: el patrón de los campos de las fixtures no admite minúsculas'
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
        why: 'FOR UPDATE SKIP LOCKED: la fila bloqueada por otra transacción se salta sin esperar, en el reclamo de barrido y en el del outbox. Falsado con skip-locked y claim-skip-locked: el reclamo espera a la fila retenida hasta el tope'
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          'FOR UPDATE SKIP LOCKED en READ COMMITTED (PersistenceTransactions.ClaimIsolation, needsReadCommitted de keel-core): en el REPEATABLE READ por defecto la lectura con bloqueo toma los huecos entre claves y un INSERT puede esperar al lock wait timeout. db-check mira la causa en performance_schema.data_locks (solo bloqueos REC_NOT_GAP) y que la fila retenida se salte sin esperar, en el barrido y en el outbox. Falsado con read-committed, claim-skip-locked y skip-locked. Medido además: con el orden resuelto por filesort (varios estados de partida, o sin índice que dé el orden) InnoDB bloquea TODAS las filas que examina y no solo las del LIMIT, así que dos réplicas a la vez pueden llevarse menos que dos lotes; no se repite ninguna y la pasada siguiente recoge el resto (el mismo SQL en keel-spring y keel-nest)'
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
        why: "TIMESTAMP '1970-01-01 00:00:00' y el uuid entre comillas CASAN: la fila atascada por la sentencia del arnés emitido, con el id pegado por su IdLiteral emitido, la rescata el reclamo generado. Falsado con stale-literal (el reloj rancio es CURRENT_TIMESTAMP) y uuid-literal (el id sin comillas): cae solo la sonda del rescate"
      },
      mysql: {
        state: 'verificado',
        net: 'db-check',
        falsified: true,
        why:
          "datetime(6) y UUID_TO_BIN('…') sobre el binary(16): la fila atascada por la sentencia del arnés emitido, con su IdLiteral emitido, la rescata el reclamo generado, y el id en la fila son los bytes de UUID_TO_BIN (GuidFormat=Binary16, fijado en el registro). Falsado con uuid-literal (el id como texto: no casa con ninguna fila ni falla), stale-literal (cae la sonda del rescate) y guid-format (el orden de bytes de .NET: la ida y vuelta sigue bien y cae la sonda del id en la fila)"
      }
    }
  },
  'telemetry-store-spans': {
    parity: {
      skip: 'la telemetría es una elección de STACK (telemetry: otel) y el par se genera sin ella; lo que hay que ver es que el proveedor solo escucha el origen keel (degradado), y lo fija test/telemetry.test.js generando con la opción',
      test: 'test/telemetry.test.js'
    },
    emitter: 'src/scaffold/telemetry.js (los spans que abre el código generado: caso de uso, HTTP de entrada y salida, mensajería, caché, storage y correo)',
    coverage: {
      relational: {
        state: 'degradado',
        why:
          'keel-spring cuelga de cada caso de uso los spans de JDBC (datasource-micrometer); keel-dotnet no escucha los de Npgsql: el proveedor solo atiende el origen keel. Npgsql ya publica su ActivitySource, pero escucharlo sin más convertiría cada pasada del relay, del reloj y de las purgas en una traza raíz por segundo, y falta el filtro anti-ruido de keel-spring (solo la sentencia con un padre del servicio). La traza llega hasta el span del caso de uso, con su duración y su desenlace, y ahí se para. El eje de telemetría del plan (las series y sus etiquetas, que consultan el panel y las alertas) no depende de esto. Salida: AddSource("Npgsql") con un procesador que descarte la raíz, y medirlo en telemetry-check'
      },
      document: {
        state: 'degradado',
        why:
          'lo mismo con MongoDB.Driver (keel-spring: MongoObservationCommandListener) y con StackExchange.Redis (su instrumentación de OpenTelemetry sigue en beta): sin span del comando, la traza se para en el caso de uso. Salida: el suscriptor de eventos del driver de MongoDB con el mismo filtro anti-ruido'
      }
    }
  },
  'folded-text': {
    parity: {
      skip: 'ningún par declara `compare` —meterlo en uno movería la clave natural que miden db-check y doc-check—, así que el texto lo fija un test sobre catalog-extended (la sombra y la nota del filtro con la grafía de C#) y lo EJECUTAN db-check sobre catalog-extended y doc-check sobre la derivada job-dispatch-mongo-compare',
      test: 'test/persistence.test.js'
    },
    emitter: 'src/scaffold/persistence.js (la columna sombra y TextFold) · repositories.js y document-repositories.js (la sombra estampada al guardar)',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'catalog-extended: Category.slug (compare: ignore-case, clave natural sobre slug_normalized) en MAYÚSCULAS es la MISMA clave → el error del diseño; y la sombra del filtro de Product.name (ignore-case-accents) guarda el valor plegado por TextFold y no lleva unicidad (el mismo nombre en mayúsculas convive). Falsado con --sabotage=fold (FoldCase no pliega: cae solo la de la clave) y fold-accents (no quita los acentos: cae solo la del filtro)'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'la derivada job-dispatch-mongo-compare (reference con compare: ignore-case-accents en la clave natural): el documento guarda en reference_normalized el valor plegado, y la misma clave en mayúsculas y sin tildes es la MISMA para el índice único → el error del diseño. Falsado con --sabotage=fold-accents: cae esa sonda y solo esa. La sombra de un FILTRO sobre documentos no la declara ninguna fixture documental'
      }
    }
  },
  'persistence-adapter': {
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: ['src/JobDispatch.Infrastructure/Persistence/Rows/JobRow.cs::IEntityTypeConfiguration<JobRow>', 'class JobRepository'],
        document: ['src/JobDispatchMongo.Infrastructure/Persistence/Repositories/JobRepository.cs::IMongoCollection<BsonDocument>', 'class JobRepository']
      }
    },
    emitter: 'src/scaffold/persistence.js · repositories.js · persistence-runtime.js · document-persistence.js · document-repositories.js',
    coverage: {
      relational: {
        state: 'verificado',
        net: 'db-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why:
          'db-check sobre 12 sujetos: el esquema contra el catálogo del motor sin ningún nombre puesto por EF, ida y vuelta del agregado entero comparada con el cable, la fila en crudo (el enum por su constante), la versión obsoleta → 409, la clave natural y la condicionada → su error, la cota que rechaza el motor (22001), página y borrado del grafo. Falsado con version, enum, constraint e index, cada uno cazado por su comprobación (6c); después id-batch, created-by, credential y replica-* en sus mecanismos'
      },
      document: {
        state: 'verificado',
        net: 'doc-check',
        falsified: true,
        why:
          'el documento CRUDO contra documentShape a todo nivel (cada clave con su tipo BSON y ninguna de más), ida y vuelta, versión, clave natural e índice condicionado, la auditoría, página con orden por la ruta del espejo. Falsado con diez sabotajes que compilan (decimal y uuid como texto —la ida y vuelta sigue en verde: solo lo ve el documento crudo—, la versión fuera del filtro, el traductor, created_at, el enum, el día en otra zona…) (12b)'
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

/** Lo que keel-dotnet todavía no genera, con el incremento que lo trae (filas y celdas). */
export function pending() {
  const rows = Object.entries(MECHANISMS).filter(([, row]) => row.pending).map(([id, row]) => ({ id, branch: null, pending: row.pending }));
  const branches = cells().filter(({ cell }) => cell.pending).map(({ id, branch, cell }) => ({ id, branch, pending: cell.pending }));
  return [...rows, ...branches];
}
