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
