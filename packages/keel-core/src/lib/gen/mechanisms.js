// El vocabulario NEUTRAL de la matriz de paridad: qué mecanismos bifurcan su código por modelo
// de persistencia o por motor, en qué estados puede estar una celda y qué pares de fixtures los
// miden, y con qué redes se ejecutan (cada generador porta las mismas, con el mismo nombre). Lo
// comparten todos los generadores (keel-core/gen): cada uno declara sus celdas —qué
// genera, quién lo ejecuta, si está falsado— contra ESTOS ids, y así la paridad entre generadores
// del mismo diseño se lee fila a fila en vez de suponerse.
//
// La implementación de referencia de las celdas es la de keel-spring (`src/lib/engine-support.js`,
// que también razona por qué existe la matriz). Un id nuevo nace aquí, con su título y su eje, y
// cada generador le añade su fila o deja la celda declarada como pendiente.

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
  'index-check':
    'npm run index-check — la unicidad CONDICIONADA, contra el motor y en sus dos ramas: en relacional el appendix .sql ejecutado dos veces; en documental el MongoIndexConfig generado, invocado dos veces desde un JUnit. Las mismas preguntas: que sea idempotente y que sostenga el invariante sin prohibir las versiones históricas',
  'telemetry-check':
    'npm run telemetry-check — la telemetría con la APLICACIÓN ARRANCADA: que la serie que el panel consulta exista de verdad en la exposición, con sus etiquetas',
  'precondition-check':
    'npm run precondition-check — la ESCRITURA CONDICIONAL (DSL 2.25) contra el motor y en el borde: loadExpecting, la versión persistida, el 409 de la ventana, el 428, la cabecera, el 412, CORS y la caché (CW-1 a CW-11)',
  'timer-check':
    'npm run timer-check — el CRONÓMETRO y los PLAZOS (DSL 2.26) contra el motor: el rechazo tardío del dominio, el armado en la transacción, el reclamo con arriendo y valla, la revalidación, el sueño y el aparcado (DL-1 a DL-10)',
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
  'notification-mailer': { relational: 'notification-mailer', document: 'notification-mailer-mongo' },
  'verification-codes': { relational: 'verification-codes', document: 'verification-codes-mongo' }
};

/**
 * El catálogo de mecanismos: id estable, título y eje (`model` si se bifurca por modelo de
 * persistencia, `engine` si por motor). El orden es el de la matriz impresa.
 */
export const MECHANISM_CATALOG = {
  'runtime-panel': {
    title: 'Fila de runtime del panel y alerta de saturación del pool',
    axis: 'model'
  },
  'outbox-relay': {
    title: 'Relay del outbox: reclamo con lease, backoff, purga y rendición',
    axis: 'model'
  },
  'idempotency-request': {
    title: 'Claves de idempotencia de petición (idempotency_record)',
    axis: 'model'
  },
  'idempotency-consume': {
    title: 'Deduplicación de consumo (processed_event)',
    axis: 'model'
  },
  'reconciliation-claim': {
    title: 'Reclamo de reconciliación: candidatos + marca con caducidad',
    axis: 'model'
  },
  'sweep-claim-queue': {
    title: 'Reclamo de un barrido de cola',
    axis: 'model'
  },
  'sweep-claim-rescue': {
    title: 'Rescate de filas EN VUELO: el reclamo más su cota temporal',
    axis: 'model'
  },
  'guard-claim': {
    title: 'Guarda de fila de un efecto externo irreversible',
    axis: 'model'
  },
  'harness-db-probes': {
    title: 'Sondas del arnés contra la base (atascar, envejecer, contar, abandonar)',
    axis: 'model'
  },
  'schema-baseline': {
    title: 'Baseline del esquema exportado de las entidades finales',
    axis: 'model'
  },
  'transient-write-conflict': {
    title: 'Reintento del conflicto de escritura transitorio (UseCaseMediator)',
    axis: 'model'
  },
  'document-indexes': {
    title: 'Índices del modelo documental (MongoIndexConfig)',
    axis: 'model'
  },
  'partial-unique-index': {
    title: 'Unicidad CONDICIONADA al estado',
    axis: 'engine'
  },
  'unique-collation': {
    title: 'Sensibilidad a mayúsculas de una columna ÚNICA',
    axis: 'engine'
  },
  'claim-dialect': {
    title: 'Reparto de candidatos entre réplicas (SKIP LOCKED o su ausencia)',
    axis: 'engine'
  },
  'harness-sql-literals': {
    title: 'Literales con los que el arnés habla con la base (staleTimestamp, uuidLiteral, forma de invocación)',
    axis: 'engine'
  },
  'telemetry-store-spans': {
    title: 'Telemetría: spans del almacén (solo con telemetry: otel)',
    axis: 'model'
  },
  'folded-text': {
    title: 'Sombra plegada de un campo con `compare` (DSL 2.14): unicidad y filtro sin mayúsculas ni acentos',
    axis: 'model'
  },
  'persistence-adapter': {
    title: 'Espejo de persistencia y repositorios (mapeo, embebidos, colecciones, orden y desempate)',
    axis: 'model'
  },
  deadline: {
    title: 'Plazo de negocio (DSL 2.26): rechazo tardío en el dominio y armado del temporizador en la transacción',
    axis: 'model'
  },
  timer: {
    title: 'Cronómetro del servicio: keel_timer, reclamo con arriendo y valla, revalidación, sueño y aparcado',
    axis: 'model'
  },
  'timer-purge': {
    title: 'Purgas de las tablas del generador en modo clúster (DSL 2.26, inc. 7): un recurrente por tabla en keel_timer, una réplica por tick',
    axis: 'model'
  },
  'timer-schedule': {
    title: 'El schedule de las operaciones en modo clúster con drenaje (DSL 2.26, inc. 8): un recurrente por operación en keel_timer, una réplica por tick, que repite la pasada mientras el lote salga lleno',
    axis: 'model'
  },
  'timer-relay': {
    title: 'El relay del outbox en modo por réplica (DSL 2.26, inc. 9): lo despierta el commit que escribe en el outbox, con un sondeo de respaldo y el reintento a su backoff',
    axis: 'model'
  },
  'conditional-write': {
    title: 'Escritura condicional (DSL 2.25, api.concurrency): ETag, If-Match, 412 y 428, loadExpecting y la versión persistida',
    axis: 'model'
  }
};
