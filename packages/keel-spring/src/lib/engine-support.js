// La matriz de paridad: qué genera keel-spring en cada rama, quién lo EJECUTA, y si esa red
// está falsada.
//
// Por qué existe. El MVP no promete «soporta tres motores»: promete que el mismo diseño produce
// un servidor equivalente en los tres. Esa promesa la sostiene hoy un reparto muy desigual de
// evidencia —de 28 corridas en vivo, 20 sobre PostgreSQL— y, sobre todo, un montón de código que
// se genera para las dos ramas y solo se ha ejecutado en una. El modo de fallo no es un error: es
// que una rama se queda atrás de la otra **en silencio**. Ha pasado, contado, ocho veces:
//
//   · el relay del outbox partía la transacción en la rama relacional y la documental no lo tuvo
//     nunca dentro;
//   · la guarda del value object opcional la tenía la documental y no la relacional;
//   · el `Sort` del reclamo de cola lo tenía la relacional y no la documental;
//   · `reconciliationAgingSection` exigía literales SQL a todos los motores, así que un diseño
//     documental con `reconciledBy` se quedaba sin `ageForReconciliation` y no podía tener el
//     escenario que `crossrefs.js` le EXIGE;
//   · la purga del outbox documental era un método derivado con dos criterios sobre el mismo
//     campo: compilaba, arrancaba, y el cron moría en cada pasada sin decir nada;
//   · la nota del stub del barrido decía «UPDATE condicional» también sobre Mongo, mandando al
//     agente a buscar un `@Modifying` donde hay un `findAndModify`;
//   · `mongoEval` no envolvía el script en un `print(...)`, así que `pendingOutboxRows()` leía
//     cadena vacía como CERO y `awaitOutboxDrained` no esperó en NINGUNA corrida documental;
//   · y `mongo-check`, la red que existe justo para eso, ponía su propio `print(` alrededor de
//     cada consulta: medía el predicado y jamás el transporte — se medía a sí misma.
//
// Los ocho se encontraron de uno en uno, casi siempre porque una persona apuntó una corrida a ese
// sitio. Esto es lo que convierte «apuntar bien» en «enumerar».
//
// ─── Las tres columnas, y por qué la tercera ────────────────────────────────
//
// `state` dice qué hay generado. `net` dice QUIÉN lo ejecuta — no quién lo compila ni quién
// compara sus cadenas: los tests comparan texto, `java-syntax` tokeniza y javac da por bueno
// cualquier JPQL sintácticamente válido, así que un predicado que no casa con nada pasa las tres
// redes y reclama cero filas sin fallar.
//
// `falsified` es la que costó aprender. Una red que nunca se ha roto a propósito no distingue
// «no hay errores» de «no mira»: `mongo-check` llevaba meses en verde midiendo una copia de sí
// misma. Una fila con `falsified: false` declara una red que existe y que nadie ha comprobado que
// pueda ponerse roja — es una promesa, no una medición, y por eso exige `why`.
//
// ─── Alcance deliberado ─────────────────────────────────────────────────────
//
// Aquí SOLO están los mecanismos cuyo código se BIFURCA por modelo de persistencia o por motor.
// Es donde vive «una rama se queda atrás de la otra», que es lo que esta matriz existe para hacer
// visible, y es lo que el test de paridad puede comprobar generando los pares byte a byte.
//
// Lo que NO está, a propósito: las capacidades cuyo código no se bifurca (correo, clientes HTTP,
// storage, caché). Su código es el mismo en los tres motores, así que no hay paridad de RAMAS que
// vigilar — lo desigual ahí es la evidencia EN VIVO (sobre MySQL no ha corrido nunca ninguna de
// las cuatro), y eso es un inventario de corridas, no de ramas. Meterlo aquí mezclaría dos cosas
// que se comprueban de formas distintas y dejaría media tabla sin poder verificar.

/** Los dos modelos de persistencia, que es el eje que más código bifurca. */
export const MODELS = ['relational', 'document'];

/**
 * De dónde sale la confianza de una celda. La distinción importa porque el modo de fallo de todo
 * lo que hay aquí es SILENCIOSO: nada lanza, nada se loguea, y el escenario pasa en verde.
 */
export const STATES = {
  verificado: 'ejecutado contra el motor real por la red que la fila nombra',
  razonado:
    'generado y NO ejecutado por ninguna red. Declarado con su porqué escrito, y con dueño: es una ' +
    'excepción, nunca el estado por defecto',
  degradado:
    'el motor no puede sostener el mecanismo y el generador lo dice en voz alta en vez de emitir algo ' +
    'que prometa lo que no cumple',
  'no-aplica': 'esa rama no existe en este modelo o motor'
};

/** Las redes que EJECUTAN algo, con qué ejes recorren. */
export const NETS = {
  'store-check': 'npm run store-check — relay del outbox, almacenes de idempotencia y reclamo de reconciliación',
  'claim-check': 'npm run claim-check — reclamos de barrido y guarda de fila, contra el motor',
  'mongo-check': 'npm run mongo-check — los scripts de mongosh del arnés, por la vía del arnés',
  'mapping-check': 'npm run mapping-check — el ESPEJO de persistencia: que la columna que el diseño pidió sea la que el motor creó',
  corrida: 'una corrida en vivo: no es determinista ni repetible en CI, así que nombra cuál',
  ninguna: 'nadie lo ejecuta'
};

/**
 * Los pares byte a byte: el mismo diseño con una única diferencia, `persistence.default.model`.
 * Esa identidad es el instrumento — cualquier cosa que salga distinta se le atribuye al modelo y
 * a nada más — y por eso hay tests que vigilan que sigan siendo pares.
 */
export const PAIRS = {
  'job-dispatch': { relational: 'job-dispatch', document: 'job-dispatch-mongo' },
  'notification-mailer': { relational: 'notification-mailer', document: 'notification-mailer-mongo' }
};

/**
 * Una fila por mecanismo. `axis` dice qué granularidad tiene su bifurcación:
 *
 *   model   el código cambia con `persistence.default.model` (relational | document).
 *   engine  el código cambia con el MOTOR concreto dentro del modelo relacional.
 *
 * `coverage` se indexa por modelo o por motor según el `axis`.
 *
 * Un marcador que empieza por `file:` afirma que ESE ARCHIVO EXISTE; cualquier otro afirma que
 * ese texto aparece en el árbol. La distinción no es cosmética y costó el primer rojo de este
 * mecanismo: un proyecto documental no trae `infra/export-schema.sh` —correcto— pero siete
 * documentos suyos lo MENCIONAN, así que buscarlo como texto da positivo. Mención no es
 * declaración, que es la misma lección que `ageForReconciliation` ya había dejado escrita.
 *
 * `parity` es lo que convierte la tabla en una comprobación. Un mecanismo del eje de modelo
 * declara con qué PAR se mira y, para cada rama, los `markers` que tienen que aparecer en el
 * árbol generado — subcadenas, no regexes, por la misma razón por la que los patrones del gate de
 * idempotencia se escriben con clases entre corchetes: un escape mal puesto no falla, aborta la
 * comprobación, y eso es indistinguible de un verde.
 *
 * Los marcadores comprueban PRESENCIA, no corrección. La corrección de cada mecanismo la miden
 * sus redes (`store-check`, `claim-check`, `mongo-check`) y sus tests de forma; lo que aquí se
 * caza es la otra familia entera, la que nunca tuvo red: **una rama deja de emitir algo y nadie
 * se entera**. Las ocho asimetrías de la cabecera son todas de esa familia.
 *
 * Y la regla que hace que esto no se pueda rellenar a medias: toda celda que no sea
 * `no-aplica` necesita sus marcadores. No se puede declarar que un mecanismo se bifurca por
 * modelo y decir solo cómo se ve en una de las dos ramas — que es, literalmente, la forma que
 * tenían los ocho fallos.
 *
 * Una celda `degradado` lleva además un bloque `degraded`: qué GARANTÍA pidió el diseño, qué
 * pasa de verdad sobre este motor, y cuáles son las salidas. No es prosa decorativa: es lo único
 * que el diseñador recibe a cambio de la garantía que no va a tener, y por eso viaja dos veces —al
 * avisar en `build` y a `docs/keel/engine-limits.md` del proyecto generado, que es donde sigue
 * estando dentro de seis meses, cuando el aviso de consola ya no lo recuerde nadie.
 *
 * `appliesWhen` es el id del predicado que decide si la degradación LE TOCA a este diseño: una
 * garantía que el diseño no pidió no se degrada, y anunciarla sería ruido. El id se resuelve en
 * `src/scaffold/engine-limits.js` y no aquí, porque evaluarlo necesita el modelo ya construido y
 * esta tabla es dato.
 *
 * Un mecanismo sin par lo dice con `parity: { skip, test }`: `skip` es el motivo y `test` el
 * archivo que lo cubre en su lugar. La reconciliación es el caso: sus sujetos son dos diseños
 * DISTINTOS (`stock-reservation` y `asset-vault`), no un par, así que la propiedad que el par
 * garantiza gratis allí la garantiza un test dedicado.
 */
export const MECHANISMS = {
  'outbox-relay': {
    title: 'Relay del outbox: reclamo con lease, backoff, purga y rendición',
    emitter: 'src/scaffold/outbox.js',
    axis: 'model',
    why: 'El único mecanismo cuya promesa es que no se pierde nada, y sus dos ramas no se parecen: JPQL con lease sobre next_attempt_at frente a findAndModify.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        // El bean aparte existe porque un @Transactional invocado desde la misma clase no pasa
        // por el proxy: sin él, la publicación vuelve a caer dentro de la transacción.
        relational: ['class OutboxRelayStore', 'claimBatch'],
        // La rama documental nunca tuvo la publicación dentro, así que aquí lo que se afirma es
        // el reclamo a solas.
        document: ['findAndModify(', 'claimPending']
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'store-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'diez mutaciones; quitar el scheduleNextAttempt(leaseUntil) o invertir el operador del backoff caen en sus casos'
      },
      document: {
        state: 'verificado',
        net: 'store-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'ocho mutaciones; quitarle al claimPending su criterio sobre claimed_at cae en el caso de la exclusión'
      }
    }
  },

  'idempotency-request': {
    title: 'Claves de idempotencia de petición (idempotency_record)',
    emitter: 'src/scaffold/http-idempotency.js',
    axis: 'model',
    why: 'Una carrera perdida que no se traduzca a su code acaba en 500 justo en el caso que menos se reproduce a mano.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['class JpaIdempotencyStore', 'IdempotencyConflictException'],
        document: ['class MongoIdempotencyStore', 'IdempotencyConflictException']
      }
    },
    coverage: {
      relational: { state: 'verificado', net: 'store-check', engines: ['postgresql', 'mysql'], falsified: true, why: 'la purga invertida cae en su caso' },
      document: { state: 'verificado', net: 'store-check', engines: ['mongodb'], falsified: true, why: 'idem en la rama documental' }
    }
  },

  'idempotency-consume': {
    title: 'Deduplicación de consumo (processed_event)',
    emitter: 'src/scaffold/idempotency.js',
    axis: 'model',
    why: 'Una clave compuesta sin su handlerId deduplica de MÁS y descarta mensajes que nadie procesó, sin excepción, sin log y sin métrica.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['ProcessedEventJpaRepository', 'class ProcessedEventWriter'],
        document: ['ProcessedEventMongoRepository', 'class ProcessedEventWriter']
      }
    },
    coverage: {
      relational: { state: 'verificado', net: 'store-check', engines: ['postgresql', 'mysql'], falsified: true, why: 'construir la clave con un handlerId constante cae en el caso de los dos handlers' },
      document: { state: 'verificado', net: 'store-check', engines: ['mongodb'], falsified: true, why: 'idem' }
    }
  },

  'reconciliation-claim': {
    title: 'Reclamo de reconciliación: candidatos + marca con caducidad',
    emitter: 'src/scaffold/reconciliation-claim.js',
    axis: 'model',
    why: 'Sus dos mitades son un JPQL de candidatos y un UPDATE condicional (o su Criteria), y ninguna pasa por javac de forma útil.',
    parity: {
      skip: 'su sujeto NO es un par byte a byte sino dos diseños distintos (stock-reservation relacional y asset-vault documental), así que la identidad que hace del par un instrumento aquí no existe',
      test: 'test/reconciliation-shape-coverage.test.js'
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'store-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'la segunda pasada inmediata ata las dos mitades; además destapó que el READ_COMMITTED es PORTANTE en MySQL (gap locks)'
      },
      document: { state: 'verificado', net: 'store-check', engines: ['mongodb'], falsified: true, why: 'su sujeto es asset-vault; lo vigila reconciliation-shape-coverage.test.js porque aquí NO hay par byte a byte' }
    }
  },

  'sweep-claim-queue': {
    title: 'Reclamo de un barrido de cola',
    emitter: 'src/scaffold/claim.js',
    axis: 'model',
    why: 'Un predicado que no casa con nada compila, arranca y reclama cero filas sin fallar.',
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: ['claimForDispatchJobsRunning', '@Modifying'],
        document: ['claimForDispatchJobsRunning', 'findAndModify(']
      }
    },
    coverage: {
      relational: { state: 'verificado', net: 'claim-check', engines: ['postgresql', 'mysql', 'mariadb'], falsified: true, why: 'romper el UPDATE condicional cae exactamente un caso' },
      document: { state: 'verificado', net: 'claim-check', engines: ['mongodb'], falsified: true, why: 'ahí la exclusividad se mide llamando al adaptador dos veces: no hay SELECT de candidatos delante' }
    }
  },

  'sweep-claim-rescue': {
    title: 'Rescate de filas EN VUELO: el reclamo más su cota temporal',
    emitter: 'src/scaffold/claim.js',
    axis: 'model',
    why: 'NULL < :cota no es falso, es UNKNOWN: una fila reclamada sin reloj no vuelve a entrar en ningún lote nunca.',
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: ['claimForStalledDispatchJobsDone', 'staleBefore'],
        document: ['claimForStalledDispatchJobsDone', 'staleBefore']
      }
    },
    coverage: {
      relational: { state: 'verificado', net: 'claim-check', engines: ['postgresql', 'mysql', 'mariadb'], falsified: true, why: 'romper la cota cae su caso; romper la derivación de la columna del arnés cae sus tres' },
      document: { state: 'verificado', net: 'claim-check', engines: ['mongodb'], falsified: true, why: 'par job-dispatch / job-dispatch-mongo, vigilado por rescue-shape-coverage.test.js' }
    }
  },

  'guard-claim': {
    title: 'Guarda de fila de un efecto externo irreversible',
    emitter: 'src/scaffold/claim.js',
    axis: 'model',
    why: 'Su fallo no produce ningún error —el servidor responde 2xx las dos veces— sino un segundo correo a una persona real.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['claimForSendAcceptedNotification', '@Modifying'],
        document: ['claimForSendAcceptedNotification', 'findAndModify(']
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'claim-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: 'quitarle la condición de estado al @Modifying cae en los dos casos que existen para eso, y cae en LOS DOS motores: era la única celda de rama que le faltaba a MySQL por ejecutar'
      },
      document: { state: 'verificado', net: 'claim-check', engines: ['mongodb'], falsified: true, why: 'idem sobre el findAndModify; par notification-mailer / -mongo, vigilado por guard-claim.test.js' }
    }
  },

  'harness-db-probes': {
    title: 'Sondas del arnés contra la base (atascar, envejecer, contar, abandonar)',
    emitter: 'src/lib/mongo-probes.js · src/lib/claim-probes.js · src/scaffold/integration-tests.js',
    axis: 'model',
    why: 'Fabrican la PRECONDICIÓN de los escenarios. Una sonda que no casa deja el escenario en verde sin haber atascado, envejecido ni contado nada.',
    parity: {
      pair: 'job-dispatch',
      markers: {
        // La DECLARACIÓN, no la mención: estos nombres aparecen en el javadoc de otros helpers, y
        // buscar la cadena a secas ya dio verde una vez sobre un arnés que no los emitía.
        relational: ['void stallInFlight(', 'void putInFlight(', 'long inFlightWithoutClock('],
        document: ['void stallInFlight(', 'void putInFlight(', 'long inFlightWithoutClock(']
      }
    },
    coverage: {
      relational: { state: 'verificado', net: 'claim-check', engines: ['postgresql', 'mysql', 'mariadb'], falsified: true, why: 'una columna que EXISTE pero no es la buena es el rojo silencioso, y cae' },
      document: {
        state: 'verificado',
        net: 'mongo-check',
        engines: ['mongodb'],
        falsified: true,
        why: 'y el TRANSPORTE también, desde que mongo-check dejó de poner su propio print(: sin el envoltorio del arnés, el check ni arranca'
      }
    }
  },

  'schema-baseline': {
    title: 'Baseline del esquema exportado de las entidades finales',
    emitter: 'src/scaffold/migrations.js',
    axis: 'model',
    why: 'El esquema y el mapeo no pueden divergir porque el baseline se EXPORTA, no se escribe. Lo que ninguna red hace es aplicarlo.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: ['file:infra/export-schema.sh', 'file:src/main/resources/application-schema-export.yaml'],
        document: []
      }
    },
    coverage: {
      relational: {
        state: 'razonado',
        net: 'corrida',
        engines: ['postgresql', 'mysql'],
        falsified: false,
        why: 'el agente de calidad lo revisa en ESTÁTICO y devuelve baselineTested: PENDING a propósito — probarlo en vivo exige borrar el volumen de la misma base sobre la que corre su no-regresión, así que la prueba es del diseñador. Exportado en vivo sobre postgresql y mysql; sobre mariadb, sqlserver y oracle no lo ha exportado nadie'
      },
      document: { state: 'no-aplica', net: 'ninguna', engines: [], falsified: false, why: 'sin esquema no hay baseline: su equivalente son los índices, y esos sí se verifican en vivo' }
    }
  },

  'document-indexes': {
    title: 'Índices del modelo documental (MongoIndexConfig)',
    emitter: 'src/scaffold/document-indexes.js',
    axis: 'model',
    why: 'Salen enteros del diseño, así que un índice que no se cree deja sin sostener un invariante que el diseño declaró.',
    parity: {
      pair: 'notification-mailer',
      markers: {
        relational: [],
        document: ['class MongoIndexConfig', 'PartialIndexFilter', 'file:infra/export-indexes.sh']
      }
    },
    coverage: {
      relational: { state: 'no-aplica', net: 'ninguna', engines: [], falsified: false, why: 'su equivalente es el baseline' },
      document: {
        state: 'verificado',
        net: 'corrida',
        engines: ['mongodb'],
        falsified: true,
        why: 'corrida notification-mailer-mongo: quitarle el .partial(...) al índice condicionado tumba cuatro escenarios de plantilla. Además el agente de calidad los verifica EN VIVO con export-indexes.sh, y su indexesTested nunca sale PENDING'
      }
    }
  },

  'partial-unique-index': {
    title: 'Unicidad CONDICIONADA al estado',
    appliesWhen: 'partialUniqueIndexes',
    emitter: 'src/scaffold/migrations.js · src/scaffold/document-indexes.js',
    axis: 'engine',
    why: 'No es una unicidad de columnas: sin la condición hay que elegir entre no poder tener dos versiones o no garantizar nada. Y es el único sitio donde el mismo diseño obtiene una garantía DISTINTA según el motor.',
    coverage: {
      postgresql: {
        state: 'verificado',
        net: 'corrida',
        falsified: true,
        why: "ejercitado el 2026-09-07 sobre la corrida mail-rabbit, y por primera vez con el indice DE VERDAD en vigor: hasta entonces su predicado iba en minusculas (= active contra una columna que guarda ACTIVE), asi que indexaba cero filas y tapaba debajo un segundo defecto. Verificado en las dos direcciones: con el contrato de orden puesto (flushPendingWrites entre las dos escrituras) FL-TPL-001-B/-C/-D en verde y como maximo una fila ACTIVE por clave en la base; quitando SOLO esa llamada, los tres en rojo con 409 en el camino feliz. Y el gate acompana: la familia conditionalUniqueness sale OK con la llamada y KO sin ella, con el mismo sujeto. Y CON UN AGENTE DELANTE el 2026-09-07 (corrida-mail-postgres, 29 OK / 0 fallos): el agente leyo la nota del stub y puso flushPendingWrites() ENTRE las dos escrituras, el gate paso de KO a OK por el camino correcto, el indice quedo intacto con su predicado, y la base cerro con cero claves con mas de una fila ACTIVA. Es la primera vez que FL-TPL-001-B/-C/-D salen verdes con el indice EN VIGOR"
      },
      mongodb: { state: 'verificado', net: 'corrida', falsified: true, why: 'partialFilterExpression; falsado en la corrida notification-mailer-mongo' },
      sqlserver: { state: 'razonado', net: 'ninguna', falsified: false, why: 'tiene índice filtrado y se emite, pero ninguna corrida ha usado SQL Server' },
      mysql: {
        state: 'degradado',
        degraded: {
          guarantee: "como máximo una fila por la clave declarada mientras esté en el estado que la condición nombra (persistence.entities.<E>.indexes con `when`)",
          consequence: "el índice NO se crea, así que la unicidad condicionada se queda ENTERA en el caso de uso — y la comprobación previa de un handler no cierra la ventana de dos peticiones simultáneas: dos publicaciones a la vez dejan dos filas activas y el invariante que el diseño declaró no lo sostiene nadie",
          ways: [
            "una columna generada que valga NULL fuera de la condición, con una constraint única encima (un índice único ignora los NULL)",
            "un bloqueo explícito en el caso de uso que publica",
            "aceptar la ventana: si el flujo real no tiene concurrencia sobre esa clave puede ser la decisión correcta, pero tomada y no heredada",
          ]
        },
        net: 'ninguna',
        falsified: false,
        why: "no tiene índices parciales: build NO los crea y avisa de que la garantía se queda entera en el caso de uso. La salida sería una columna generada que valga NULL fuera de la condición, y es una decisión con coste que el generador no toma sola"
      },
      mariadb: {
        state: 'degradado',
        degraded: {
          guarantee: "como máximo una fila por la clave declarada mientras esté en el estado que la condición nombra (persistence.entities.<E>.indexes con `when`)",
          consequence: "el índice NO se crea, así que la unicidad condicionada se queda ENTERA en el caso de uso — y la comprobación previa de un handler no cierra la ventana de dos peticiones simultáneas: dos publicaciones a la vez dejan dos filas activas y el invariante que el diseño declaró no lo sostiene nadie",
          ways: [
            "una columna generada que valga NULL fuera de la condición, con una constraint única encima (un índice único ignora los NULL)",
            "un bloqueo explícito en el caso de uso que publica",
            "aceptar la ventana: si el flujo real no tiene concurrencia sobre esa clave puede ser la decisión correcta, pero tomada y no heredada",
          ]
        },
        net: 'ninguna',
        falsified: false,
        why: 'tampoco tiene índices parciales; misma degradación anunciada que MySQL, y la misma salida disponible (columna generada que valga NULL fuera de la condición) que el generador no elige solo'
      },
      oracle: {
        state: 'degradado',
        degraded: {
          guarantee: "como máximo una fila por la clave declarada mientras esté en el estado que la condición nombra (persistence.entities.<E>.indexes con `when`)",
          consequence: "el índice NO se crea, así que la unicidad condicionada se queda ENTERA en el caso de uso — y la comprobación previa de un handler no cierra la ventana de dos peticiones simultáneas: dos publicaciones a la vez dejan dos filas activas y el invariante que el diseño declaró no lo sostiene nadie",
          ways: [
            "un índice único sobre una expresión CASE que devuelva NULL fuera de la condición",
            "un bloqueo explícito en el caso de uso que publica",
            "aceptar la ventana, dicho en voz alta",
          ]
        },
        net: 'ninguna',
        falsified: false,
        why: 'no tiene índice parcial declarativo; la salida clásica ahí es un índice sobre una expresión CASE que devuelva NULL fuera de la condición, y vale lo mismo: es una decisión con coste, no un default'
      }
    }
  },

  'claim-dialect': {
    title: 'Reparto de candidatos entre réplicas (SKIP LOCKED o su ausencia)',
    emitter: 'src/lib/claim-sql.js',
    axis: 'engine',
    why: 'Sin reparto el reclamo SIGUE siendo correcto —lo garantiza la escritura condicional— pero N-1 réplicas pierden su intento, y eso hay que decirlo en voz alta en vez de emitir un lock silencioso.',
    coverage: {
      postgresql: { state: 'verificado', net: 'claim-check', falsified: true, why: 'la carrera perdida (segundo reclamo devuelve 0) es un caso propio' },
      mysql: { state: 'verificado', net: 'claim-check', falsified: true, why: 'y aquí el READ_COMMITTED resultó PORTANTE, no una optimización: bajo REPEATABLE READ el reclamo de reconciliación muere en Lock wait timeout y el barrido no reclama nada, nunca' },
      mariadb: { state: 'verificado', net: 'claim-check', falsified: true, why: 'ejecutado —de ahí que su uuidLiteral se corrigiera— y falsado el 2026-09-07: rompiendo el UPDATE condicional del reclamo cae elSegundoReclamoDeLaMismaFilaDevuelveCero, que es el caso donde vive toda la exclusión mutua' },
      sqlserver: { state: 'razonado', net: 'ninguna', falsified: false, why: 'usa hints de tabla en vez de SKIP LOCKED, y van en otro sitio de la consulta. Declarado y no ejecutado: se cierra con claim-check --database=sqlserver' },
      oracle: { state: 'razonado', net: 'ninguna', falsified: false, why: 'declarado y no ejecutado. Su arnés además cambia de ESTRUCTURA (la sentencia viaja por archivo), y eso sí lo compila compile-check' },
      mongodb: { state: 'no-aplica', net: 'ninguna', falsified: false, why: 'findAndModify es atómico por documento: no hay página de candidatos que repartir' }
    }
  },

  'harness-sql-literals': {
    title: 'Literales con los que el arnés habla con la base (staleTimestamp, uuidLiteral, forma de invocación)',
    emitter: 'src/lib/stack-catalog.js',
    axis: 'engine',
    why: 'Donde no constan, el arnés NO emite stallInFlight, putInFlight, inFlightWithoutClock ni ageForReconciliation — y calla. Sobre ese motor, un diseño con rescate o con reconciledBy no puede tener el escenario que crossrefs.js le EXIGE.',
    coverage: {
      postgresql: { state: 'verificado', net: 'claim-check', falsified: true, why: 'lo ata engine-claim-coverage.test.js, que obliga a declarar CÓMO se sabe' },
      mysql: { state: 'verificado', net: 'claim-check', falsified: true, why: 'su uuidLiteral es UUID_TO_BIN porque la columna es binary(16); el literal en texto no casa y NO falla' },
      mariadb: { state: 'verificado', net: 'claim-check', falsified: true, why: 'la medición contradijo a la deducción: contra mariadb:11 la columna es uuid NATIVO, así que el literal es el texto entrecomillado' },
      sqlserver: {
        state: 'razonado',
        net: 'ninguna',
        falsified: false,
        why: 'sus literales están declarados en el catálogo y NADIE los ha ejecutado: si no casan, el UPDATE afecta a cero filas sin fallar y el escenario del rescate pasa en verde sin haber atascado nada. Se cierra con claim-check --database=sqlserver'
      },
      oracle: { state: 'razonado', net: 'ninguna', falsified: false, why: 'declarado sin ejecutar; su cliQueryForm: scriptFile sí lo compila compile-check' },
      mongodb: { state: 'verificado', net: 'mongo-check', falsified: true, why: 'aquí no hay literales SQL: lo que se mide son los scripts de mongosh y su transporte' }
    }
  },

  'persistence-adapter': {
    title: 'Espejo de persistencia y repositorios (mapeo, embebidos, colecciones, orden y desempate)',
    emitter:
      'src/scaffold/persistence-entities.js · src/scaffold/repositories.js · src/scaffold/document-entities.js · src/scaffold/document-repositories.js',
    axis: 'model',
    why: 'Es la superficie más grande que se bifurca por modelo, y la única cuya red es COMPILAR: paginar sin desempate determinista repite una fila y omite otra, y eso compila igual de bien.',
    parity: {
      pair: 'job-dispatch',
      markers: {
        relational: ['class JobJpa', 'JobJpaRepository'],
        document: ['class JobDocument', 'JobMongoRepository']
      }
    },
    coverage: {
      relational: {
        state: 'verificado',
        net: 'mapping-check',
        engines: ['postgresql', 'mysql'],
        falsified: true,
        why: "la COTA de una columna esta medida desde el 2026-09-07 con mapping-check, sobre postgresql y mysql: un valor en el limite entra y uno de un caracter mas lo rechaza el motor. Falsado quitandole al @Column su length — el caso del exceso cae con «un valor de 33 caracteres entro en una columna declarada de 32», que es exactamente el defecto documentado (una columna compuesta a mano pierde length, nullable, precision/scale). Lo que sigue SIN medir es el resto del espejo: la escala del decimal, el value object aplanado, la tabla hija de una coleccion y el desempate de la paginacion — este ultimo se descarto a proposito como sujeto de ejecucion, porque sin desempate el orden que devuelve el motor es ARBITRARIO y no incorrecto, asi que el caso saldria verde por suerte mas veces de las que saldria rojo"
      },
      document: {
        state: 'verificado',
        net: 'mapping-check',
        engines: ['mongodb'],
        falsified: true,
        why: "el NOMBRE con el que se guarda un campo esta medido desde el 2026-09-07 con mapping-check. El sujeto es otro que en la rama relacional y no por gusto: en Mongo la cota de un texto no la impone el almacen, asi que medirla seria medir Bean Validation. Lo que si es del mapeo es que el Update del reclamo —que nombra la PROPIEDAD JAVA— acabe escribiendo el @Field. Se ejecuta el reclamo GENERADO y se lee el documento CRUDO: leerlo por el mapeo no serviria, porque Spring Data usa la misma anotacion para escribir y leer y un @Field equivocado pero consistente daria la vuelta entera sin que se note. Falsado haciendo que el Update nombre un campo que el mapeo no conoce: el caso cae y ensena el campo PARALELO al lado del que falta. Es la sonda que la corrida notification-mailer-mongo tuvo que anadir a mano (FL-SND-001-B), hecha repetible. Sigue SIN medir el resto del espejo documental: el subdocumento anidado de un value object y la hija de una coleccion"
      }
    }
  }
};

// ─── La deuda del índice parcial relacional ─────────────────────────────────
//
// Encontrada al intentar falsar `partial-unique-index/postgresql`, que era una de las dos celdas
// «sin falsar» y resultó ser algo peor que eso.
//
// El generador emite hoy el índice correcto. Lo que nunca se comprobó es si el FLUJO puede vivir
// con él. Con el índice en vigor, publicar una versión nueva —retirar la activa y activar la
// nueva, en la misma transacción— choca contra él: un índice único parcial de PostgreSQL se
// comprueba por FILA y no se puede diferir (`DEFERRABLE` es de constraints, y una constraint
// única parcial no existe), así que si el UPDATE que activa la nueva se vuelca antes que el que
// retira la vieja, hay un instante con dos filas ACTIVE y la escritura se rechaza.
//
// Eso convierte el índice en un CONTRATO que el generador impone y no dice en ninguna parte: el
// caso de uso que publica tiene que forzar el orden (retirar y hacer `flush` antes de activar).
// No está en el .sql, ni en las conventions, ni en la nota del stub, y ningún gate lo comprueba.
// La rama documental no lo sufre —cada `save` es su propia escritura— y por eso pasó verde en la
// corrida `notification-mailer-mongo`.
//
// CERRADO el 2026-09-07. El contrato está escrito donde el agente lo lee (el puerto
// `flushPendingWrites()`, la nota del stub, la cabecera del `.sql` y `conventions/mapping.md`), lo
// verifica el gate (familia `conditionalUniqueness`) y se ha medido en vivo en las dos direcciones.
// Lo que sigue debajo es el porqué, que conviene no perder:
//
// [histórico] Mientras eso no se cerró, esta celda fue `razonado` y no `verificado`: lo honesto era decir que
// el mecanismo relacional está generado, sin ejercitar, y con una sospecha fundada en contra.

/** Los ids, en orden estable. */
export const mechanismIds = () => Object.keys(MECHANISMS);

/** Todas las celdas de la matriz, aplanadas: `{ id, mechanism, key, cell }`. */
export function cells() {
  const out = [];
  for (const [id, mechanism] of Object.entries(MECHANISMS)) {
    for (const [key, cell] of Object.entries(mechanism.coverage)) {
      out.push({ id, mechanism, key, cell });
    }
  }
  return out;
}

/**
 * Lo que queda sin ejecutar por ninguna red, que es la lista con la que se decide la siguiente
 * corrida. Devolverla ORDENADA y sin timestamps la hace comparable entre ejecuciones.
 */
export function unverified() {
  return cells()
    .filter(({ cell }) => cell.state === 'razonado')
    .map(({ id, key, cell }) => ({ id, key, net: cell.net, why: cell.why }))
    .sort((a, b) => (a.id === b.id ? a.key.localeCompare(b.key) : a.id.localeCompare(b.id)));
}

/**
 * Las redes que existen pero que nadie ha roto a propósito. No es lo mismo que `unverified`: aquí
 * hay algo ejecutándose, y lo que falta es saber si podría ponerse rojo.
 */
export function unfalsified() {
  return cells()
    .filter(({ cell }) => cell.state === 'verificado' && cell.falsified !== true)
    .map(({ id, key, cell }) => ({ id, key, net: cell.net, why: cell.why }))
    .sort((a, b) => (a.id === b.id ? a.key.localeCompare(b.key) : a.id.localeCompare(b.id)));
}
