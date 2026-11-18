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
  'read-scope-check':
    'npm run read-scope-check — la LECTURA ACOTADA (DSL 2.27) contra el motor y en el borde: el listado y su total acotados, el camino de relaciones, loadScoped con su readMiss, el conjunto vacío, la composición con los filtros, la clave de caché, ReadScopes desde el token y el 403 (RS-1 a RS-11)',
  'lifecycle-check':
    'npm run lifecycle-check — el CICLO DE VIDA DEL DATO (DSL 2.28) contra el motor con el contexto del perfil local: las lecturas vivas y su total, la clave que se libera, la restauración con su ventana, la lectura por referencia, la vida sumada al alcance, la retención y sus dos réplicas, y el valor personal fuera de los logs (LC-1 a LC-10, RT-1 a RT-4, PD-2)',
  'history-check':
    'npm run history-check — el HISTORIAL DE CAMBIOS (DSL 2.29) contra el motor con el contexto del perfil local: la entrada en la transacción de la escritura, el diff, lo que no entra, el autor, la página con su orden y sus filtros, la lectura acotada como la ficha, la restauración y la retención que se lleva o anonimiza el historial (HI-1 a HI-10)',
  'batch-check':
    'npm run batch-check — los LOTES (DSL 2.30) contra el motor: el 207 por elemento, la validación de cada elemento, la transacción por elemento o la que abarca el lote, el lote que se detiene (BA-1 a BA-9), y el trabajo asíncrono con su alta idempotente, el chunk sobre el cronómetro, la reanudación desde el cursor, la valla y el dueño (BJ-1 a BJ-9)',
  'invariant-check':
    'npm run invariant-check — la GUARDA DEL AGREGADO (DSL 2.31) contra el motor por el save del puerto: las cotas y los checks del agregado entero, las hijas primero, el 422 o el error del diseño, la fila rechazada sin escribir y el derivado recalculado, redondeado y persistido (IC-1 a IC-11, CP-1 a CP-5)',
  'finder-check':
    'npm run finder-check — los FINDERS de las búsquedas (DSL 2.22 y 2.32) contra el motor y en el borde: los filtros del input y el where de la query, in, ne con la fila sin valor, la búsqueda libre como literal (FS-1 a FS-10), ?sort= contra sortable y la lista de la query (SO-1 a SO-11), la collation del orden y la página vacía',
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
  'timer-telemetry': {
    title: 'Telemetría del cronómetro (DSL 2.26, inc. 11; solo con telemetry: otel): el retraso de lo vencido sin reclamar, los aparcados y la duración de cada disparo por kind',
    axis: 'model'
  },
  'conditional-write': {
    title: 'Escritura condicional (DSL 2.25, api.concurrency): ETag, If-Match, 412 y 428, loadExpecting y la versión persistida',
    axis: 'model'
  },
  'read-scope': {
    title: 'Lectura acotada (DSL 2.27, reads y readMiss): el predicado del alcance en el adaptador, su total, loadScoped, el ReadScope del borde y la clave de caché',
    axis: 'model'
  },
  'data-lifecycle': {
    title: 'Ciclo de vida del dato (DSL 2.28): el borrado lógico con sus lecturas vivas y su unicidad entre vivas, la restauración con su ventana, la retención sobre el cronómetro y los datos personales fuera de los logs',
    axis: 'model'
  },
  history: {
    title: 'Historial de cambios (DSL 2.29): una entrada por escritura confirmada en su misma transacción, con el diff del agregado, el autor, la página ordenada y filtrada, la lectura acotada como la ficha y la retención que se lo lleva o lo anonimiza',
    axis: 'model'
  },
  batch: {
    title: 'Lotes con resultado por elemento (DSL 2.30): el 207 con una transacción por elemento o una que abarca el lote, cada elemento validado y traducido como la operación sola, y el trabajo asíncrono por chunks sobre el cronómetro con su cursor como valla, su clave y su dueño',
    axis: 'model'
  },
  'entity-checks': {
    title: 'Guarda del agregado (DSL 2.31): ensureInvariants() con las cotas de la entidad y sus checks sobre el agregado entero, las hijas antes que su padre, llamada por el save antes de escribir nada, con el 422 INVARIANT_VIOLATED o el error del diseño',
    axis: 'model'
  },
  computed: {
    title: 'Derivado del agregado (DSL 2.31, computed: { sum, count }): calculado desde las hijas con la aritmética de D5 y D24, su desbordamiento como INVARIANT_VIOLATED y el valor recalculado persistido en cada save',
    axis: 'model'
  },
  'finder-in-ne': {
    title: 'Criterios in y ne del finder (DSL 2.32): in restringe a los valores de una lista, plegados si el input pliega (D10, D12), y ne incluye la fila sin valor (D11)',
    axis: 'model'
  },
  search: {
    title: 'Búsqueda libre del finder (DSL 2.32, search): un OR de match sobre la sombra de cada campo de over con un solo compare, y el texto del cliente como literal: LIKE escapado o expresión regular citada (D13)',
    axis: 'model'
  },
  sortable: {
    title: 'Orden del cliente (DSL 2.32, sortable): ?sort= contra la lista blanca de la query con el 400 de readClientSort (D15, D16), la lista en la query (U8, D10), la collation binaria del texto ordenado (U7, D17) y el orden en la clave de la caché (D18)',
    axis: 'model'
  }
};
