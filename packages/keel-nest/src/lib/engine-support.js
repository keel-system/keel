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

import { MECHANISM_CATALOG, STATES } from 'keel-core/gen/mechanisms';
import { SUPPORTED_DATABASES } from './supported-features.js';

export { MECHANISM_CATALOG, STATES };

/** Las redes de keel-nest que EJECUTAN algo. */
export const NETS = {
  'db-check':
    'npm run db-check — la persistencia contra PostgreSQL y MySQL reales: esquema contra el catálogo del motor, cotas, ida y vuelta por el adaptador generado, fila en crudo, versión, unicidad (también la condicionada), página y borrado; y los almacenes de la mensajería (el outbox con su reclamo, y el registro de procesados)',
  'ts-check': 'npm run ts-check — compila con strict las 13 fixtures, ejecuta sus pruebas y ARRANCA el servidor contra PostgreSQL',
  'harness-check':
    'npm run harness-check [-- --database=mysql] — levanta infra/ con sus propios scripts, puntúa flujos sonda con score-scenarios.sh (cada código de salida y su evidencia) y exporta, aplica y verifica el baseline de migraciones',
  'broker-check':
    'npm run broker-check [-- --broker=rabbitmq|kafka|snssqs] — la mensajería contra RabbitMQ, Kafka y LocalStack reales de infra/: la topología, los consumer groups o las colas sembradas, el consumo con reintento y descarte (la DLQ, <topic>.DLT con los headers de Spring Kafka, o la RedrivePolicy de SQS), el relay del outbox con el broker caído y los helpers del arnés',
  'doc-harness-check':
    'npm run doc-harness-check — el arnés de integración documental contra la infra/ real: mongoEval, el reset, los ayudantes del rescate y de la reconciliación, el humo y la puntuación',
  'doc-check':
    'npm run doc-check — la persistencia documental contra un MongoDB real en replica set: los índices vivos, el documento crudo contra la forma neutral, ida y vuelta, versión, unicidad (también la condicionada), la carrera de dos transacciones, la auditoría, página y borrado',
  ninguna: 'nadie lo ejecuta'
};

export { SUPPORTED_DATABASES };

export const MECHANISMS = {
  'runtime-panel': { pending: 'incremento 14 (telemetría)' },
  'outbox-relay': {
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
        state: 'razonado',
        why:
          'no hay baseline que redactar: los índices salen enteros del diseño (document-indexes.ts, los de keel-core/gen/document.js) y infra/export-indexes.sh, neutral, exporta los vivos para contrastarlos. La creación al arrancar la mide doc-check; el script lo ejecutará el pase de calidad, que llega con los agentes del arnés documental (12d)'
      }
    }
  },
  'transient-write-conflict': {
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
  'telemetry-store-spans': { pending: 'incremento 14 (telemetría)' },
  'folded-text': {
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
        state: 'razonado',
        why:
          'la sombra plegada se escribe en el documento con TextFold (documentShape la incluye y los índices de unicidad van sobre ella), pero ninguna fixture documental declara compare: sin sujeto, nadie la ejecuta'
      }
    }
  },
  'persistence-adapter': {
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
