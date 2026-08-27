import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { buildModel } from '../src/lib/model.js';
import { generate as generateScheduling, scheduledTaskCount } from '../src/scaffold/scheduling.js';
import { isEmptyRead, emptyReadValue } from '../src/lib/broker-probes.js';
import { needsReadCommitted, claimTransaction } from '../src/lib/claim-sql.js';
import { harnessQueueName } from '../src/scaffold/messaging-provisioning.js';
import { outboxRelayBeanName } from '../src/scaffold/outbox.js';
import { tmpDir } from './helpers/tmp.js';

// Los defectos que destapó la corrida en vivo `corrida-claim-mysql` (MySQL + RabbitMQ +
// Keycloak, el primer diseño que ejercita los cuatro reclamos a la vez). Todos comparten la
// misma forma: código que build emite por plantilla, correcto de leer y equivocado de
// ejecutar, sobre el que la suite de cadenas salía verde.
//
// Cada bloque dice qué se rompía y por qué nadie lo veía; sin eso, el test de al lado es una
// aserción arbitraria que el siguiente que pase por aquí relaja para que deje de molestar.

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

/** El proyecto generado de una fixture, con el stack pedido. */
function project(fixture, stack) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-corrida-fixes-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack });
  const root = path.join(workspace, result.outDir);
  return {
    root,
    file: (suffix) => {
      const found = walk(root).find((f) => f.endsWith(suffix));
      assert.ok(found, `no se generó ${suffix}`);
      return fs.readFileSync(found, 'utf8');
    }
  };
}

function modelFor(fixture, stack) {
  const { manifest, layers } = loadService(path.join(fixturesDir, fixture));
  const model = buildModel({ manifest, layers, stack });
  model.stack = stack;
  return model;
}

const RELATIONAL = { group: 'com.test', database: 'postgresql', broker: 'rabbitmq', auth: null, cache: null, storage: null };

// ─── El cliente de MySQL contra un servidor MySQL 8 ──────────────────────────

test('con MySQL, devtools instala el connector que trae caching_sha2_password', () => {
  // `mysql-client` en Alpine es el cliente de MariaDB y NO trae ese plugin, que es el de
  // autenticación por defecto de mysql:8.0 — la imagen que el propio catálogo levanta. Sin
  // el connector, todo lo que hable con la base desde devtools muere con `ERROR 1045`
  // aunque el servidor esté sano: el sondeo, los dos modos del reset y el `db(...)` del
  // arnés. Y muere como FALSO NEGATIVO, que es lo caro — se busca el fallo donde no está.
  //
  // Hasta esta corrida nadie generaba un proyecto MySQL para mirar su Dockerfile: la única
  // mención de `mysql-client` en toda la suite era una aserción NEGATIVA.
  const dockerfile = project('stock-reservation', { ...RELATIONAL, database: 'mysql' }).file(
    path.join('infra', 'docker', 'Dockerfile')
  );

  assert.match(dockerfile, /mysql-client/);
  assert.match(dockerfile, /mariadb-connector-c/);
});

test('y el resto de motores no arrastran ese paquete', () => {
  // La simétrica: MariaDB usa mysql_native_password y no lo necesita. Un paquete de más en
  // todas partes convertiría el arreglo en ruido que nadie podría justificar después.
  const dockerfile = project('stock-reservation', RELATIONAL).file(path.join('infra', 'docker', 'Dockerfile'));

  assert.match(dockerfile, /postgresql-client/);
  assert.ok(!dockerfile.includes('mariadb-connector-c'), dockerfile);
});

// ─── El scheduler no va sobre hilos virtuales ────────────────────────────────

test('se genera un TaskScheduler de hilos de plataforma donde hay algo programado', () => {
  // Con `spring.threads.virtual.enabled: true` Boot sustituye el TaskScheduler por uno de
  // hilos virtuales. Un barrido empieza reclamando contra la base, y el driver JDBC se
  // bloquea dentro de secciones `synchronized`: ahí el hilo virtual no suelta su carrier,
  // se queda clavado. Con varias tareas coincidiendo los carriers se agotan y los
  // @Scheduled dejan de dispararse a su hora — medido en vivo: casi cuatro minutos tarde.
  //
  // No da error: llega tarde. Y en un mecanismo con cota temporal encima, eso hace que la
  // cota deje de medir lo que decía.
  const config = project('stock-reservation', RELATIONAL).file('SchedulingConfig.java');

  assert.match(config, /class SchedulingConfig/);
  assert.match(config, /ThreadPoolTaskScheduler/);
  assert.match(config, /public TaskScheduler taskScheduler\(\)/);
  // Declararlo como bean es lo que lo hace efectivo: la auto-configuración de Boot solo
  // pone el suyo si no hay ninguno. `spring.task.scheduling.pool.size` NO sirve aquí.
  assert.match(config, /@Bean/);
  // Al apagar se espera a la tarea en vuelo: cortarla deja filas reclamadas sin trabajo
  // hecho, y esas solo las recupera un rescate.
  assert.match(config, /setWaitForTasksToCompleteOnShutdown\(true\)/);
});

test('el pool da un hilo por tarea programada: acotarlo serializa los barridos', () => {
  // Un hilo de menos y dos tareas comparten hilo, con lo que la segunda espera a la
  // primera. Ese acoplamiento es el que hace que un barrido lento acabe retrasando la
  // entrega de eventos del outbox, y es la razón por la que `conventions/dependencies.md`
  // descarta acotar la concurrencia global del scheduler.
  const model = modelFor('stock-reservation', RELATIONAL);
  const scheduled = [...model.services.flatMap((s) => s.operations).filter((o) => o.schedule)];

  const count = scheduledTaskCount(model);
  // Las del diseño más las del generador (relay y purga del outbox, purgas de los dos
  // registros de idempotencia y la de las marcas de reconciliación).
  assert.ok(count > scheduled.length, `${count} no cubre ni las ${scheduled.length} del diseño`);
  assert.match(generateScheduling(model)[0].content, new RegExp(`scheduling\\.pool-size:${count}`));
});

test('sin nada programado no se genera el bean', () => {
  // La simétrica: donde no hay `@Scheduled` no hay nada que decidir, y un bean de más es
  // un hilo de más arrancando en cada instancia.
  const model = modelFor('product-catalog', { ...RELATIONAL, broker: null });
  if (scheduledTaskCount(model) === 0) assert.deepEqual(generateScheduling(model), []);
});

// ─── La espera al drenaje del outbox ─────────────────────────────────────────

test('la espera del outbox consulta el destino FÍSICO, no el canal del diseño', () => {
  // El publicador escribe en `outbox_event.destination` el valor de
  // `messaging.publishing.destination` (`<slug>.events`), mientras que el arnés consultaba
  // por el canal lógico (`stockEvents`). El COUNT(*) daba SIEMPRE 0: la espera volvía al
  // instante sin esperar a nada, que es justo lo que su javadoc dice evitar. Y no lo
  // cubría ningún test.
  const harness = project('stock-reservation', RELATIONAL).file('AbstractFlowIT.java');

  assert.match(harness, /private static final String OUTBOX_DESTINATION =/);
  assert.match(harness, /FROM outbox_event WHERE destination = '" \+ OUTBOX_DESTINATION \+ "'/);
  assert.ok(!harness.includes(`destination = '" + destination + "'`), harness);
});

test('y no se traga el fallo de la consulta, porque cero significa «drenado»', () => {
  // Devolver 0 ante un error convierte una consulta rota en una espera que siempre pasa:
  // los escenarios de outbox seguirían corriendo, en verde, sin esperar a nada. Es
  // exactamente el modo en que este defecto sobrevivió sin que nadie lo notara.
  const harness = project('stock-reservation', RELATIONAL).file('AbstractFlowIT.java');
  const body = harness.slice(harness.indexOf('private static int pendingOutboxRows()'));

  assert.match(body.slice(0, body.indexOf('\n    }\n')), /throw new IllegalStateException/);
});

test('un canal que no publicamos no espera a ningún relay', () => {
  // La espera solo tiene sentido sobre lo que sale por NUESTRO outbox. Sobre la cola de un
  // proveedor sería esperar a un relay que no existe.
  const harness = project('stock-reservation', RELATIONAL).file('AbstractFlowIT.java');

  assert.match(harness, /OUTBOX_CHANNELS = Set\.of\("stockEvents"\)/);
  assert.match(harness, /if \(!OUTBOX_CHANNELS\.contains\(destination\)\) \{\s*return;/);
});

// ─── El token cacheado caduca ────────────────────────────────────────────────

test('el token cacheado se renueva por su claim exp, no vive para siempre', () => {
  // La clase es PER_CLASS y el realm de prueba emite tokens de cinco minutos (el default
  // de Keycloak: el aprovisionamiento no fija `accessTokenLifespan`). Cualquier flujo con
  // esperas largas —un rescate, una reconciliación— pasa de ahí y empieza a recoger 401
  // que no tienen nada que ver con lo que el escenario prueba.
  const harness = project('asset-vault', {
    group: 'com.test',
    database: 'postgresql',
    broker: 'rabbitmq',
    auth: 'keycloak',
    cache: null,
    storage: 'minio'
  }).file('AbstractFlowIT.java');

  assert.match(harness, /TOKEN_RENEWAL_MARGIN = Duration\.ofSeconds\(30\)/);
  assert.match(harness, /EXP_CLAIM =/);
  assert.match(harness, /private static boolean expiresWithin\(String token, Duration margin\)/);
  // Las dos puertas, no solo la de usuario: `serviceCredential` cacheaba igual.
  assert.match(harness, /return cachedToken\(role, \(\) ->/);
  assert.match(harness, /return cachedToken\("client:" \+ client, \(\) ->/);
  assert.ok(!harness.includes('credentials.computeIfAbsent'), harness);
});

// ─── El invariante del valor vacío ───────────────────────────────────────────

test('el vacío que fabrica el arnés lo reconoce el predicado de su propio broker', () => {
  // La autocomprobación del arreglo: `emptyIfBrokerStopped` tiene que devolver algo que
  // `isEmptyRead` dé por vacío. Con RabbitMQ devolvía `""` y el predicado espera `"[]"`,
  // así que la aserción de canal vacío fallaba justo en el único escenario para el que la
  // palanca del broker existe. Los dos lados salen ya del mismo módulo; esto lo ata.
  for (const broker of ['rabbitmq', 'snssqs', 'kafka']) {
    assert.ok(isEmptyRead(broker, emptyReadValue(broker)), `${broker}: '${emptyReadValue(broker)}' no cuenta como vacío`);
  }
  // Y que no sean todos la cadena vacía, que haría el invariante trivialmente cierto.
  assert.equal(emptyReadValue('rabbitmq'), '[]');
});

// ─── Segunda corrida: SNS/SQS con el pipeline completo ───────────────────────
//
// Tres hallazgos más, y el primero es de la MISMA familia que `publishedDestination`: un
// destino de broker compuesto a mano en vez de derivado de su resolutor. El anterior estaba
// en PHYSICAL_OF; este, en la sonda de topología, que no se tocó entonces.

const SNSSQS = { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null };

test('la sonda de topología lee de la COLA de arnés, no del topic al que publica', () => {
  // El defecto: una sola constante para dos roles incompatibles. `deliverMessage` compone
  // TOPIC_ARN + destino (y ahí `<slug>-events` es correcto), pero `sqs receive-message`
  // compone QUEUE_URL + destino, y con ese mismo valor pide una cola que NO EXISTE —
  // NonExistentQueue garantizado, siempre.
  //
  // Y no fallaba en un sitio inocuo: `awaitTopologyWired()` lanza, `startBroker()` no llega
  // a `BROKER_STOPPED.set(false)`, el flag se queda en true para toda la JVM (no hay
  // forkEvery) y `restoreBroker()` —que abre cada @BeforeAll— vuelve a matar cada clase
  // posterior. En la corrida: 4 clases, 8 escenarios. Con el flag puesto, además,
  // `emptyIfBrokerStopped` da por «canal vacío» cualquier fallo de lectura.
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');

  // Dos constantes, y cada una con su papel.
  assert.match(harness, /TOPOLOGY_PROBE_DESTINATION = "stock-reservation-events"/);
  assert.match(harness, /TOPOLOGY_PROBE_QUEUE = "stockEvents"/);
  // La cola es la que siembra el aprovisionamiento, derivada de la misma fuente.
  assert.equal(harnessQueueName('stockEvents'), 'stockEvents');
  // Se publica en el topic…
  assert.match(harness, /deliverMessage\(\s*TOPOLOGY_PROBE_DESTINATION/);
  // …y se lee y se borra en la cola. Ninguna de las dos contra el topic.
  assert.ok(!harness.includes('QUEUE_URL + TOPOLOGY_PROBE_DESTINATION'), harness);
  assert.equal((harness.match(/QUEUE_URL \+ TOPOLOGY_PROBE_QUEUE/g) ?? []).length, 2);
});

test('y el eventType de la sonda pertenece al canal del que lee', () => {
  // La URL correcta no basta: la suscripción de cada cola de arnés lleva filtro por
  // `eventType` (messaging-provisioning § harnessQueues). Leer de la cola de otro canal no
  // entregaría la sonda nunca, y el síntoma sería idéntico al del defecto anterior.
  const model = modelFor('stock-reservation', SNSSQS);
  const probe = model.events[0];
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');

  assert.match(harness, new RegExp(`TOPOLOGY_PROBE_QUEUE = "${probe.channel}"`));
  assert.match(harness, new RegExp(`Map\\.of\\("eventType", "${probe.name}"\\)`));
  assert.ok(
    (model.messaging.eventTypesByChannel[probe.channel] ?? []).includes(probe.name),
    'el evento de la sonda no pasa el filtro de la cola de la que se lee'
  );
});

test('la sonda retira solo su mensaje, nunca purga la cola', () => {
  // El defecto simétrico, y no es hipotético: la primera versión de este arreglo usó
  // purge-queue y se llevó por delante un evento de negocio real que el relay acababa de
  // publicar en esa misma cola. El Then se quedó esperando un mensaje que sí se publicó y
  // que el outbox ya había dado por entregado.
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');
  const from = harness.indexOf('private static boolean topologyProbeArrived');
  const body = harness.slice(from, harness.indexOf('return false;', from));

  assert.match(body, /"delete-message"/);
  assert.match(body, /ReceiptHandle/);
  assert.ok(!body.includes('purge-queue'), body);
});

test('el relay se pausa mientras se recrea la topología, y solo donde se pierde', () => {
  // startBroker() reinicia el contenedor entero y con él se van destinos y suscripciones.
  // Entre que el destino existe y su suscripción queda wireada, SNS ACEPTA el publish y
  // descarta el mensaje sin error: el relay marca published_at y el evento no existe para
  // nadie. `awaitTopologyWired` cierra esa ventana para su propia sonda, no para un
  // publicador que corre en paralelo — hacen falta las dos mitades.
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');
  const start = harness.slice(harness.indexOf('protected static void startBroker()'));
  const body = start.slice(0, start.indexOf('\n    }\n'));

  // La pausa envuelve TODO el arranque, y se levanta en un finally: dejar el relay parado
  // por una excepción sería cambiar un fallo por otro mucho peor y mudo.
  assert.ok(body.indexOf('pauseOutboxRelay();') < body.indexOf('reseedTopology();'));
  assert.ok(body.indexOf('awaitTopologyWired();') < body.indexOf('resumeOutboxRelay();'));
  assert.match(body, /\} finally \{/);
  // El bean se resuelve por NOMBRE (su clase vive en src/main, fuera de este classpath) y
  // ese nombre lo deriva build de la clase que él mismo genera.
  assert.match(harness, new RegExp(`OUTBOX_RELAY_BEAN = "${outboxRelayBeanName()}"`));
  assert.ok(!harness.includes('import com.test.'), 'el arnés importó algo de la aplicación');
  // Una pausa que no pausa deja el defecto igual con apariencia de arreglado.
  assert.match(harness, /No se canceló ninguna tarea programada/);
});

test('los brokers que conservan su topología no llevan nada de eso', () => {
  // Kafka y RabbitMQ no la pierden al reiniciar, así que no hay ventana que cerrar y un
  // mecanismo de más solo añade una forma de romperse.
  for (const broker of ['rabbitmq', 'kafka']) {
    const harness = project('stock-reservation', { ...SNSSQS, broker }).file('AbstractFlowIT.java');
    assert.ok(!harness.includes('pauseOutboxRelay'), broker);
    assert.ok(!harness.includes('TOPOLOGY_PROBE'), broker);
    assert.ok(!harness.includes('ScheduledAnnotationBeanPostProcessor'), broker);
  }
});

test('el javadoc de tokenFor dice que se pida por llamada, donde el agente lo lee', () => {
  // Las 8 clases de flujo capturaron `token = tokenFor(...)` en @BeforeAll y lo reutilizaron.
  // `cachedToken` renueva con margen, pero solo si se le pregunta: un token capturado esquiva
  // la renovación entera. La advertencia existía… en el javadoc de `cachedToken`, que es
  // private y por tanto invisible para quien escribe el test.
  const harness = project('asset-vault', {
    group: 'com.test', database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak', cache: null, storage: 'minio'
  }).file('AbstractFlowIT.java');

  const from = harness.indexOf('Bearer token de un usuario con el rol pedido');
  const javadoc = harness.slice(from, harness.indexOf('protected String tokenFor', from));
  assert.match(javadoc, /no guardes lo que devuelve/i);
  assert.match(javadoc, /cinco minutos/);
});

// ─── Tercera corrida: Kafka, y lo que destapó fue de MySQL ───────────────────
//
// La corrida de Kafka no encontró nada del broker: encontró que el MOTOR llevaba roto desde
// el principio, en algo que ninguna corrida anterior había ejercitado con carga concurrente
// de verdad. Los dos primeros bloques son defectos de producción, no de pruebas.

const MYSQL = { group: 'com.test', database: 'mysql', broker: 'kafka', auth: null, cache: null, storage: null };

test('bajo MySQL, todo reclamo que escanea con SKIP LOCKED fija READ_COMMITTED', () => {
  // InnoDB arranca en REPEATABLE READ, y ahí una lectura con bloqueo no toma solo los
  // registros que devuelve: toma NEXT-KEY LOCKS, que incluyen el hueco anterior a cada clave.
  // El hueco bloqueado impide INSERTAR filas nuevas en ese rango. `SKIP LOCKED` no salva de
  // esto — salta las filas que otro tiene tomadas, pero los huecos los toma esta consulta.
  //
  // El efecto en vivo: el barrido escanea `status IN (...)` para reclamar su lote y, mientras,
  // un alta nueva espera hasta `ERROR 1205: Lock wait timeout exceeded`. No es un problema de
  // pruebas: en producción es la API dejando de aceptar altas cada vez que pasa un barrido.
  //
  // La documentación de MySQL lo dice del nivel de al lado: «In the READ COMMITTED isolation
  // level, InnoDB disables gap locking for locking reads, UPDATE, and DELETE statements».
  const project_ = project('stock-reservation', MYSQL);
  const adapter = project_.file('ReservationRepositoryImpl.java');
  const relay = project_.file('OutboxRelay.java');

  // Los DOS que esta fixture tiene —el barrido de reconciliación y el relay del outbox—, y no
  // solo el primero: el relay sostiene su transacción durante TODA la entrega al broker, así
  // que ahí los gap locks no duran lo que un UPDATE, duran segundos. Y corre cada segundo.
  // (El reclamo de COLA se cubre en claim.test.js, que es donde hay un diseño con cola.)
  assert.match(adapter, /@Transactional\(isolation = Isolation\.READ_COMMITTED\)/);
  assert.match(relay, /@Transactional\(isolation = Isolation\.READ_COMMITTED\)/);
  assert.match(adapter, /import org\.springframework\.transaction\.annotation\.Isolation;/);
});

test('y los motores que ya arrancan en READ COMMITTED no se anotan', () => {
  // PostgreSQL, Oracle y SQL Server ya están ahí: declararlo sería sugerir una decisión donde
  // no hay ninguna, y ensuciar cinco motores por el defecto de uno.
  const project_ = project('stock-reservation', { ...MYSQL, database: 'postgresql' });

  assert.ok(!project_.file('ReservationRepositoryImpl.java').includes('Isolation.READ_COMMITTED'));
  assert.ok(!project_.file('OutboxRelay.java').includes('Isolation.READ_COMMITTED'));
  assert.equal(needsReadCommitted('postgresql'), false);
  assert.equal(needsReadCommitted('mysql'), true);
  assert.equal(needsReadCommitted('mariadb'), true);
});

test('perder la carrera de un INSERT tiene DOS formas, y las dos se capturan', () => {
  // Dos INSERT concurrentes con la misma clave no siempre acaban en violación de restricción:
  // InnoDB hace esperar al segundo sobre el lock del primero, y si el desenlace tarda sale por
  // lock-wait timeout o deadlock — que Spring traduce a PessimisticLockingFailureException, no
  // a DataIntegrityViolationException. La documentación de MySQL tiene una sección entera
  // titulada «duplicate-key deadlock».
  //
  // Capturando solo la primera, el barrido revienta en vez de ceder el candidato, y la carrera
  // de idempotencia acaba en 500 en vez de en el code que el diseño declara. Justo cuando hay
  // competencia, que es lo único que estos dos registros existen para arbitrar.
  const project_ = project('stock-reservation', MYSQL);

  for (const clazz of ['ReconciliationClaimStore.java', 'JpaIdempotencyStore.java']) {
    const src = project_.file(clazz);
    // Las TRES, y cada una llega por su camino: la violación de restricción, el lock-wait o
    // deadlock que InnoDB produce cuando el perdedor espera al ganador, y el fallo al CONFIRMAR
    // la transacción — que no es una excepción de acceso a datos y se escapa de las otras dos.
    // Las tres significan lo mismo aquí: el registro no quedó escrito, luego perdí la carrera.
    assert.match(src, /catch \(DataIntegrityViolationException\s*\|\s*PessimisticLockingFailureException\s*\|\s*TransactionSystemException/, clazz);
    assert.match(src, /import org\.springframework\.dao\.PessimisticLockingFailureException;/, clazz);
    assert.match(src, /import org\.springframework\.transaction\.TransactionSystemException;/, clazz);
  }
});

test('el arnés sabe escribir un UUID para su motor, en vez de que se adivine', () => {
  // Tres clases de flujo distintas, en una misma corrida, adivinaron mal el tipo de la columna.
  // En MySQL, Hibernate mapea `java.util.UUID` a `binary(16)`: el literal en texto plano no
  // casa con ninguna fila NI da error — el WHERE sale vacío y el INSERT guarda basura. El
  // síntoma no se lee como un SQL mal escrito, se lee como un servicio que no hizo su trabajo,
  // y se arbitra dos veces antes de que alguien mire la columna.
  const harness = project('stock-reservation', MYSQL).file('AbstractFlowIT.java');

  assert.match(harness, /protected static String uuidLiteral\(String id\)/);
  // Lo que se genera es una EXPRESIÓN JAVA que produce SQL, no SQL. Este test afirmaba antes
  // `return UUID_TO_BIN("'" + id + "'");`, que es una llamada a un método Java inexistente:
  // congeló el código roto y tumbó la compilación del source set entero en una corrida.
  // De ahí que la aserción empiece por la comilla: si `UUID_TO_BIN` no está DENTRO de una
  // cadena, no es SQL — es una llamada.
  assert.match(harness, /return "UUID_TO_BIN\('" \+ id \+ "'\)";/);
  assert.ok(!/return UUID_TO_BIN\(/.test(harness), 'UUID_TO_BIN fuera de la cadena es una llamada a método');
  // La otra que se adivinó mal, documentada junto al helper.
  assert.match(harness, /lock_version/);

  // Y en Postgres la forma es otra, porque el tipo es nativo.
  const pg = project('stock-reservation', { ...MYSQL, database: 'postgresql' }).file('AbstractFlowIT.java');
  assert.match(pg, /return "'" \+ id \+ "'";/);
});

test('la regla del token está donde se decide guardarlo, no solo donde se usa', () => {
  // El javadoc de `tokenFor` ya avisaba —se añadió tras la corrida anterior— y NO bastó: dos
  // clases de esta corrida volvieron a capturarlo. El javadoc se lee al usar el método; la
  // decisión de guardarlo se toma antes, al montar la clase. Así que la regla va también en la
  // convención que el agente de pruebas lee al empezar.
  const convention = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', 'assets', 'generators', 'spring', 'conventions', 'integration-tests.md'
    ),
    'utf8'
  );

  assert.match(convention, /El token se pide en cada petición; nunca se guarda en una variable/);
  assert.match(convention, /cinco minutos/);
  // Y la lista sigue numerada de forma consecutiva: insertar una regla en medio y dejar dos
  // con el mismo número hace que las referencias cruzadas dejen de apuntar a lo que dicen.
  const numbers = [...convention.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  const rules = numbers.slice(0, numbers.indexOf(1, 1) === -1 ? numbers.length : numbers.indexOf(1, 1));
  assert.deepEqual(rules, rules.map((_, i) => i + 1), `la lista de reglas no es consecutiva: ${rules}`);
});

// ─── La doctrina, no solo el código ──────────────────────────────────────────
//
// Los dos defectos de MySQL no salieron caros por difíciles: salieron caros porque ninguna
// guía que el agente lee los mencionaba. Arreglar lo que build genera evita que build lo
// genere mal; no evita que el agente lo escriba mal, y sigue habiendo sitios donde escribe
// él (los barridos de `unclaimedSweeps`, y todo el SQL crudo del arnés).
//
// Y hay un precedente que obliga a preguntar SIEMPRE quién va a leer cada nota: lo del UUID
// ya estaba documentado en la guía de base de datos… que lee el agente de CÓDIGO, mientras
// que quien lo necesitaba era el de PRUEBAS. El dato existía, en el documento equivocado.

const asset = (...parts) =>
  fs
    .readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'generators', 'spring', ...parts),
      'utf8'
    )
    // Normalizado: en el working copy de Windows estos assets llevan CRLF y en el índice LF, así
    // que una aserción multilínea atada a `\n` pasaría o fallaría según dónde se corra.
    .replace(/\r\n/g, '\n');

test('la guía de MySQL manda fijar READ_COMMITTED donde se reclama', () => {
  const guide = asset('skills', 'keel-spring-database', 'references', 'dialects', 'mysql.md');
  const section = guide.slice(guide.indexOf('### Reclamo de un barrido'), guide.indexOf('## Validación'));

  // Dentro de la subsección del reclamo, no en cualquier parte del documento: quien llega
  // aquí con el síntoma delante busca en esa sección, no lee las 60 líneas.
  assert.match(section, /READ_COMMITTED/);
  assert.match(section, /next-key locks/);
  // El síntoma, que es lo que permite reconocerlo: no se parece a un problema de bloqueo.
  assert.match(section, /Lock wait timeout/);
  // Y que no es un problema de pruebas.
  assert.match(section, /API dejando de aceptar altas/);
});

test('y el bullet vecino deja de dar el consejo equivocado para ese caso', () => {
  // Antes decía «ordena las escrituras y reintenta» hablando de gap locks, que es correcto
  // para deadlocks entre inserts y NO aplica al escaneo de un barrido. Quien llegara con el
  // síntoma se quedaba con la respuesta de al lado.
  const guide = asset('skills', 'keel-spring-database', 'references', 'dialects', 'mysql.md');
  const concurrency = guide.slice(guide.indexOf('## Concurrencia'), guide.indexOf('### Reclamo de un barrido'));

  assert.ok(!/gap locks\): ordena/.test(concurrency), concurrency);
  assert.match(concurrency, /tienen otra\n  respuesta|otra respuesta/);
  // Y la otra mitad del mismo motor: perder un INSERT duplicado tiene dos desenlaces.
  assert.match(concurrency, /DataIntegrityViolationException/);
});

test('MariaDB lleva la misma nota: es el mismo InnoDB con el mismo default', () => {
  const guide = asset('skills', 'keel-spring-database', 'references', 'dialects', 'mariadb.md');
  const section = guide.slice(guide.indexOf('### Reclamo de un barrido'), guide.indexOf('## Validación'));

  assert.match(section, /READ_COMMITTED/);
  assert.match(section, /next-key locks/);
});

test('y los motores que no lo necesitan no lo mencionan', () => {
  // PostgreSQL no tiene gap locks. Repetir la nota ahí sería enseñar a fijar un aislamiento
  // por una razón que en ese motor no existe.
  const guide = asset('skills', 'keel-spring-database', 'references', 'dialects', 'postgresql.md');
  assert.ok(!guide.includes('READ_COMMITTED'), guide);
});

test('la convención del arnés dice cómo se escribe un UUID y cómo se llama la versión', () => {
  // Estaba documentado… en la guía de base de datos, que el agente de PRUEBAS no lee. Por eso
  // tres clases distintas lo adivinaron mal de forma independiente.
  const convention = asset('conventions', 'integration-tests.md');
  const section = convention.slice(
    convention.indexOf('## Lo que no se ve por HTTP'),
    convention.indexOf('## Eventos entrantes')
  );

  assert.match(section, /uuidLiteral\(id\)/);
  assert.match(section, /binary\(16\)/);
  // Lo que lo hace caro, y por qué no basta con decir «usa el helper»: falla en silencio.
  assert.match(section, /ni da error/);
  assert.match(section, /lock_version/);
});

test('lo que la guía manda escribir es lo que build genera', () => {
  // El test que de verdad paga: ata la doctrina al generador. Una guía que enseñe a escribir
  // algo distinto de lo que hay generado al lado es peor que no tenerla — el agente ve dos
  // formas y elige, y la que elija será la de la guía porque es la que le hablaba a él.
  const guide = asset('skills', 'keel-spring-database', 'references', 'dialects', 'mysql.md');
  const generated = claimTransaction('mysql').annotation;

  const annotation = generated.split('\n').find((line) => line.trim().startsWith('@Transactional'));
  assert.match(guide, new RegExp(annotation.trim().replace(/[.()]/g, (c) => `\\${c}`)));

  // Y el simétrico: donde el motor no lo necesita, ni la guía lo pide ni build lo emite.
  assert.ok(!claimTransaction('postgresql').annotation.includes('Isolation'));
});

test('y el enrutado lleva a esa guía cuando toca: una nota que nadie abre no existe', () => {
  // El error que esta misma corrección estuvo a punto de repetir. Lo del UUID ya estaba escrito
  // en la guía de dialecto y aun así se adivinó mal tres veces, porque quien lo necesitaba no
  // tenía motivo para abrirla. Poner la nota en el sitio correcto no basta: hay que darle al
  // agente la razón para ir.
  //
  // Los dos disparadores que la tabla ofrecía eran «tipos de columna» y «drift H2». Escribir un
  // reclamo no es ninguno de los dos.
  const skill = asset('skills', 'keel-spring-database', 'SKILL.md');
  const table = skill.slice(skill.indexOf('| Referencia | Cuándo leerla |'));

  const dialectRow = table.split('\n').find((line) => line.includes('references/dialects/'));
  assert.match(dialectRow, /bloqueo/, 'la fila del dialecto no dispara por una consulta con bloqueo');

  const readQueriesRow = table.split('\n').find((line) => line.includes('references/read-queries.md'));
  assert.match(readQueriesRow, /barrido/, 'la fila de read-queries no dispara por un barrido');

  // Y el paso del procedimiento, que es lo que se lee en orden.
  assert.match(skill, /antes de escribir\n   cualquier consulta \*\*con bloqueo\*\*/);
});

test('read-queries remite al dialecto desde la lista de lo no opcional', () => {
  // Es donde el agente está mirando cuando escribe la consulta del reclamo: la lista de las
  // cosas que no puede saltarse. El aislamiento es la cuarta.
  const guide = asset('skills', 'keel-spring-database', 'references', 'read-queries.md');

  assert.match(guide, /Cuatro cosas que no son opcionales/);
  assert.match(guide, /NIVEL DE AISLAMIENTO/);
  assert.match(guide, /dialects\/mysql\.md/);
});

// ─── Cuarta corrida: la de validación, y encontró tres más ───────────────────
//
// `corrida-claim-snssqs-v2` era la primera con el criterio invertido: comprobar arreglos, no
// buscarlos. Encontró cuatro parches al arnés igualmente, y los tres de aquí comparten una
// propiedad: NINGUNO se manifiesta con la clase de flujo aislada. Salen bajo la contención de
// la suite completa, con dos réplicas y más de diez mensajes — el terreno que ni los tests de
// cadenas ni compile-check pueden pisar.

const SQS = { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null };

test('la lectura de SQS deduplica por MessageId: la repesca no es un duplicado real', () => {
  // Con `--visibility-timeout 0` un mensaje devuelto vuelve a estar visible AL INSTANTE, así
  // que el lote siguiente puede repescarlo. Cortar en el primer lote incompleto —lo que hacía
  // el arnés— no evita el solape: si el primero devuelve 10 completos y el segundo repesca
  // alguno, se cuenta dos veces. Y los lotes se concatenaban tal cual, con lo que la salida
  // con más de 10 mensajes ni siquiera era JSON válido.
  //
  // El modo de fallo es el peor de los dos posibles: un conteo inflado **acusa de duplicar
  // eventos a un servicio que no duplica nada**, y se arbitra como `culprit: code` contra
  // código correcto. Se vio en FL-CLU-004, el único punto de la suite que pide más de 10.
  const harness = project('stock-reservation', SQS).file('AbstractFlowIT.java');

  assert.match(harness, /seen\.add\(String\.valueOf\(message\.get\("MessageId"\)\)\)/);
  assert.match(harness, /Set<String> seen = new LinkedHashSet<>\(\)/);
  // Cota de intentos: sin ella, una cola que solo puede repescar lo ya visto —menos mensajes
  // reales que los pedidos— deja el bucle sondeando para siempre.
  assert.match(harness, /int maxAttempts =/);
  // El desescapado va al final: decodeBodies es TEXTUAL y deja de ser JSON navegable, así que
  // deduplicar después sería tarde.
  assert.match(harness, /return decodeBodies\(seen\.isEmpty\(\)/);
});

test('la clave del dedupe es el MessageId del broker, nunca el cuerpo', () => {
  // Es la distinción que sostiene un escenario entero. Dos entregas legítimas del mismo
  // evento —la reentrega que un escenario de idempotencia provoca a propósito— comparten
  // cuerpo y `metadata.eventId`: deduplicar por ahí las fundiría en una y el escenario
  // pasaría en verde sin haber probado nada. El MessageId de SQS es único por MENSAJE.
  const harness = project('stock-reservation', SQS).file('AbstractFlowIT.java');
  const from = harness.indexOf('protected static String publishedMessages');
  const raw = harness.slice(from, harness.indexOf('\n    }', harness.indexOf('return decodeBodies', from)));
  // Sin comentarios: el javadoc de este método EXPLICA por qué no se deduplica por `eventId`,
  // y buscar el término sobre el texto crudo hacía que el test fallara por su propia prosa. Es
  // el mismo cuidado que check-idempotency.sh se aplica a sí mismo, en el sentido contrario.
  const body = raw.replace(/\/\/[^\n]*/g, '');

  assert.ok(!body.includes('eventId'), 'deduplica por el id de aplicación: fundiría dos entregas legítimas');
  assert.ok(!body.includes('hashCode'), body);
});

test('y las otras dos ramas no lo llevan, porque no tienen el defecto', () => {
  // RabbitMQ pide un solo `get` con peek explícito (una petición no puede repescarse a sí
  // misma) y Kafka lee por offset desde una marca. Añadir el dedupe ahí sería código muerto
  // que además sugiere un problema que ese broker no tiene.
  for (const broker of ['rabbitmq', 'kafka']) {
    const harness = project('stock-reservation', { ...SQS, broker }).file('AbstractFlowIT.java');
    assert.ok(!harness.includes('MessageId'), broker);
    assert.ok(!harness.includes('LinkedHashSet'), broker);
  }
});

test('leer un canal agotado no revienta: la salida vacía no es un camino ausente', () => {
  // `JsonPath.read` sobre una cadena vacía lanza IllegalArgumentException («json string can
  // not be null or empty»), que NO es el PathNotFoundException que ya se toleraba. Y como
  // esto corre con BROKER_STOPPED todavía en true, la excepción mata el @BeforeAll de la
  // clase entera: se llevó por delante ReconciliationFlowIT y CompensationFlowIT.
  const harness = project('stock-reservation', SQS).file('AbstractFlowIT.java');
  const from = harness.indexOf('private static List<Map<String, Object>> receivedMessages');
  const body = harness.slice(from, harness.indexOf('\n    }', from));

  // La guarda va ANTES del JsonPath.read, que es lo único que la hace efectiva.
  assert.ok(body.indexOf('raw.isBlank()') < body.indexOf('JsonPath.read'), body);
  assert.match(body, /PathNotFoundException/);
  // Y se emite una sola vez: antes vivía dentro de la sonda de topología, que solo existe
  // con la palanca de broker — emitirlo en los dos sitios no compilaría.
  assert.equal((harness.match(/private static List<Map<String, Object>> receivedMessages/g) ?? []).length, 1);
});

test('toda lectura espera a que el outbox drene, sin que nadie tenga que acordarse', () => {
  // El relay corre en su propio fixed-delay, INDEPENDIENTE del commit del estado: cuando un
  // Then ve el estado ya cambiado, el evento puede no haber salido. Solo se nota bajo la
  // contención de la suite (FL-CLU-003), no con la clase sola.
  //
  // El agente lo resolvió llamando a awaitOutboxDrained trece veces en cinco clases. Funciona,
  // y es la forma que ya falló dos veces en este repo: el javadoc de tokenFor avisaba y dos
  // corridas volvieron a capturar el token. Trece llamadas que recordar son trece ocasiones de
  // olvidar una — y el fallo que produce olvidarla se parece a un servicio que no publicó.
  for (const broker of ['snssqs', 'rabbitmq', 'kafka']) {
    const harness = project('stock-reservation', { ...SQS, broker }).file('AbstractFlowIT.java');
    const from = harness.indexOf('protected static String publishedMessages');
    const head = harness.slice(from, from + 600);
    assert.match(head, /awaitOutboxDrained\(/, broker);
    // Y sigue siendo privado: si hiciera falta llamarlo desde fuera, volveríamos al problema.
    assert.match(harness, /private static void awaitOutboxDrained/, broker);
  }
});

test('salvo cuando el escenario paró el broker a propósito', () => {
  // Ahí las filas están pendientes POR DISEÑO —es la premisa entera del escenario del canal
  // indisponible— y el relay no puede drenarlas contra un broker caído: la espera no
  // convergería nunca, se agotaría el timeout completo en cada lectura de ese flujo. El gate
  // es el mismo flag que ya usa emptyIfBrokerStopped, y acierta en las dos mitades del
  // escenario: tras startBroker() el flag ya está limpio y la espera vuelve a hacerse.
  const harness = project('stock-reservation', SQS).file('AbstractFlowIT.java');
  const from = harness.indexOf('private static void awaitOutboxDrained');
  const body = harness.slice(from, harness.indexOf('\n    }', harness.indexOf('OUTBOX_DRAIN_TIMEOUT', from)));

  assert.match(body, /if \(brokerIntentionallyStopped\(\)\) \{\s*\n\s*return;/);
  // Y antes que eso, el canal que no publicamos: no hay relay que pueda entregar tarde.
  assert.ok(body.indexOf('OUTBOX_CHANNELS.contains') < body.indexOf('brokerIntentionallyStopped'), body);
});

test('sin outbox no se espera nada, porque no hay relay', () => {
  // La publicación va dentro de la transacción: cuando el estado se commitea, el evento ya
  // está en el broker. Emitir la llamada ahí sería citar un método que no existe.
  const harness = project('product-catalog', { ...SQS, broker: 'rabbitmq' }).file('AbstractFlowIT.java');

  assert.ok(!harness.includes('awaitOutboxDrained'), harness.slice(0, 400));
});
