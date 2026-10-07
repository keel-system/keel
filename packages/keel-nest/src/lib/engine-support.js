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
          'la tabla outbox_event es la de keel-spring (schema-parity contra OutboxEventJpa) y los parámetros del relay, los de keel-core (messaging.test.js contra el messaging.yaml de keel-spring; el backoff, contra la referencia ejecutable). db-check, en los dos motores y en notification-mailer y catalog-extended: la tabla contra el catálogo del motor, el puente escribiendo la fila en la transacción del cambio (y nada si revierte), el reclamo en orden y con su lote, el lease, SKIP LOCKED sin esperar a la fila retenida por otra réplica, el backoff de un fallo, la rendición al alcanzar el máximo y su cuenta, y que ni la publicada ni la rendida vuelven. Falsado el 2026-10-07 quitando el lease (cae su comprobación y solo esa) y quitando SKIP LOCKED (el reclamo espera a la fila retenida hasta el tope). Y broker-check, contra RabbitMQ real: el relay con un dispatcher sobre RabbitConnection.publish entrega la fila al canal con su envoltura y su tipo, no da por publicado lo que no tenía cola (mandatory), espera con el broker caído y sale al volver sin rendirse, y un evento abandonado no sale y se cuenta (falsado publicando sin mandatory: cae ese flujo y solo ese). Y contra Kafka real (9f): el mismo relay con un dispatcher sobre KafkaConnection.publish entrega la fila con la routing key como clave, espera con el broker caído y sale al volver, y el abandonado no sale. Y contra LocalStack (9g): con un dispatcher sobre SnsSqsConnection.publish, lo mismo, más que una fila cuyo topic no existe no se da por publicada (la conexión no crea el topic), y que tras levantar el broker la topología se resiembra y la fila sale. Lo que no mide: la purga (incremento 10)'
      },
      document: { pending: 'incremento 12 (persistencia documental)' }
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
          'la tabla idempotency_record es la de keel-spring (schema-parity la compara con IdempotencyRecordJpa, falsado con una cota distinta: caen las 4 fixtures con idempotencia). db-check, en los dos motores y en las 3 fixtures relacionales que la declaran: la tabla contra el catálogo del motor, guardar y encontrar, el ámbito dentro de la clave, la clave repetida y la CARRERA de dos transacciones como el conflicto con su code (el del diseño si lo declara), la clave caducada sustituible y el rollback del registro con su comando. Falsado el 2026-10-06 quitando la traducción de la violación: caen exactamente esas dos comprobaciones en las tres. Lo que no ejecuta ninguna red: la purga de las caducadas (llega con el scheduling, incremento 10) y el USO en el handler, que escribe el agente'
      },
      document: { pending: 'incremento 12 (persistencia documental)' }
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
          'la tabla processed_event es la de keel-spring (schema-parity contra ProcessedEventJpa). db-check, en los dos motores y en notification-mailer y catalog-extended: la tabla y sus cotas contra el catálogo del motor, la repetición arbitrada por la clave primaria, dos consumidores del mismo mensaje sin pisarse, el registro que sobrevive al rollback del handler (su transacción es propia) y la carrera de dos entregas, de la que registra UNA. Falsado el 2026-10-07 haciendo que el registro use la transacción del llamante: cae «sobrevive al rollback» y solo esa. Lo que no mide: el ORDEN en el listener (alreadyProcessed/record o tryRecord), que escribe el agente y vigilará el gate de idempotencia (incremento 10)'
      },
      document: { pending: 'incremento 12 (persistencia documental)' }
    }
  },
  'reconciliation-claim': { pending: 'incremento 10 (reconciliación)' },
  'sweep-claim-queue': { pending: 'incremento 10 (barridos)' },
  'sweep-claim-rescue': { pending: 'incremento 10 (barridos)' },
  'guard-claim': { pending: 'incremento 10 (guarda de fila)' },
  'harness-db-probes': { pending: 'incremento 10 (las sondas que fabrican la precondición de un barrido)' },
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
      document: { pending: 'incremento 12 (persistencia documental)' }
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
      document: { pending: 'incremento 12 (persistencia documental)' }
    }
  },
  'document-indexes': { pending: 'incremento 12 (persistencia documental)' },
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
  'claim-dialect': { pending: 'incremento 10 (reclamos con SKIP LOCKED)' },
  'harness-sql-literals': { pending: 'incremento 10 (los literales por motor de las sondas del arnés)' },
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
      document: { pending: 'incremento 12 (persistencia documental)' }
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
      document: { pending: 'incremento 12 (persistencia documental)' }
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
