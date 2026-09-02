import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { buildModel } from '../src/lib/model.js';
import { generate as generateScheduling, scheduledTaskCount } from '../src/scaffold/scheduling.js';
import {
  isEmptyRead,
  emptyReadValue,
  READ_BATCH_LIMIT,
  READ_DEDUPE_KEY,
  readAttemptLimit,
  readParts,
  releaseParts
} from '../src/lib/broker-probes.js';
import { needsReadCommitted, claimTransaction } from '../src/lib/claim-sql.js';
import { harnessQueueName } from '../src/scaffold/messaging-provisioning.js';
import { outboxRelayBeanName } from '../src/scaffold/outbox.js';
import { storedWhenValue } from '../src/scaffold/persistence-members.js';
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

// Un escenario cuyo disparador es un mensaje ENTRANTE con el canal de SALIDA caído no se
// podía escribir: stopBroker() tumba el contenedor entero y tarda en cortar conexiones de
// verdad, así que el relay publica dentro de esa ventana y el reinicio se lleva el mensaje
// ya entregado — un fallo de outbox que en realidad es de timing. En la corrida de
// customer-refunds el agente lo resolvió PARCHEANDO el arnés, que es 100% de build: el
// siguiente `build --force` se lo habría llevado.
// El barrido era el único de los seis mecanismos con cobertura conductual CERO, y la razón
// escrita —un cron no se llama desde fuera— era cierta pero incompleta: lo que decide es si
// hay algo que cambie ahí fuera, y aquí lo hay por partida doble. Lo que faltaba era llegar a
// su condición de entrada sin esperar el plazo real ni bajarlo (el umbral es global y se
// llevaría por delante las filas de los demás escenarios).
// Rendirse era invisible. Una fila que agota `outbox.relay.max-attempts` deja de reclamarse
// y se queda ahí —pérdida de datos en el mecanismo cuya única promesa es que no se pierde
// nada—, y lo único que ocurría era un log.error: nada que alertar en producción, y nada
// que un escenario pueda afirmar.
// Salió del cierre de la corrida de customer-refunds: la suite acabó al 100% y en
// `build/keel-failures/` seguían los cinco volcados de la pasada anterior. Un volcado que
// sobrevive a una corrida verde se lee igual que uno recién escrito, y la matriz solo cita
// la ruta de los fallos de ESTA pasada — así que no informa de nada, engaña.
test('la puntuación borra la evidencia de la corrida anterior antes de empezar', () => {
  const script = project('stock-reservation', SNSSQS).file('score-scenarios.sh');

  const iPurga = script.indexOf('rm -rf "$EVIDENCE"');
  assert.ok(iPurga > 0, 'la puntuación no purga los volcados de la pasada anterior');
  // Antes de correr nada, no después: purgar al final dejaría sin evidencia el fallo que
  // acaba de ocurrir, que es justo para lo que existe.
  assert.ok(iPurga < script.indexOf('./gradlew integrationTest'), script.slice(iPurga - 120, iPurga + 120));
});

// La señal del outbox solo se afirmaba en la dirección que no importa: todos los escenarios
// comprueban que vale CERO. Si la sonda estuviera rota y devolviera siempre cero, las cinco
// aserciones pasarían en vacío. Esto es lo que permite verla en la dirección positiva.
test('el arnés sabe agotar el presupuesto de reintentos de un evento, y limpiarlo', () => {
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');

  assert.match(harness, /protected static void abandonOutboxEvent\(String eventType\)/);
  assert.match(harness, /protected static void clearAbandonedOutboxEvents\(\)/);

  // Se localiza la fila por su TIPO DE EVENTO, que es texto: ni literal de fecha ni de uuid,
  // así que alcanza a todos los motores con CLI de consulta y no solo a los dos de
  // ageForReconciliation.
  assert.ok(harness.includes('WHERE event_type = '), harness);
  // Y el valor va muy por encima de cualquier max-attempts (40 en local, 10 en el resto):
  // leer el parámetro ataría el arnés al perfil con el que corre.
  assert.ok(harness.includes('SET attempts = 1000000'), harness);
  // La limpieza existe porque el cron de purga NO borra lo abandonado: solo borra lo
  // publicado, así que la fila sobrevive dentro de la clase y ensucia el contador.
  assert.ok(harness.includes('DELETE FROM outbox_event WHERE published_at IS NULL'), harness);
});

test('sin outbox no hay nada que abandonar', () => {
  // metering-digest publica best-effort: no hay fila que agotar ni contador que ensuciar.
  const harness = project('metering-digest', { ...SNSSQS, database: 'postgresql' }).file('AbstractFlowIT.java');
  assert.ok(!harness.includes('abandonOutboxEvent'), 'se emitió el helper sin outbox');
  assert.ok(!harness.includes('deadLetteredEvents'), 'se emitió la sonda sin outbox');
});

test('el outbox publica cuántos eventos se rindió, y el arnés lo lee por HTTP', () => {
  const generated = project('stock-reservation', SNSSQS);
  const relay = generated.file('OutboxRelay.java');

  // Gauge y no contador: un contador se reinicia con el proceso y no ve lo que se rindió
  // antes de arrancar, que son justo las filas que llevan más tiempo perdidas.
  assert.ok(relay.includes('Gauge.builder("keel.outbox.dead_lettered"'), relay);
  assert.ok(relay.includes('countDeadLettered(maxAttempts)'), relay);

  // Y sale por el actuator, que es lo que la hace observable desde fuera: sin esto la
  // señal existiría en la tabla y seguiría sin mirarla nadie.
  const harness = generated.file('AbstractFlowIT.java');
  assert.ok(harness.includes('get("/actuator/metrics/keel.outbox.dead_lettered")'), harness);
  // Instancia, no estático: usa get(...), que también lo es. Mezclarlos solo lo ve javac.
  assert.match(harness, /protected long deadLetteredEvents\(\)/);
});

test('el arnés sabe envejecer la marca de espera de una fila concreta', () => {
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');

  assert.match(harness, /protected static void ageForReconciliation\(String activation, String id\)/);
  // El UPDATE nombra la tabla y la columna que el diseño declara, no una convención: el
  // escenario no tiene por qué conocer ninguna de las dos.
  assert.ok(harness.includes('reserve_stock_awaiting_since ='), harness);
  assert.ok(harness.includes("TIMESTAMP '1970-01-01 00:00:00'"), harness);
  // Y el id entra por el literal del motor, no concatenado a pelo: en MySQL es binario.
  assert.ok(harness.includes('+ uuidLiteral(id));'), harness);
});

test('el arnés da la palanca fina para tumbar la salida con la entrada viva', () => {
  const harness = project('stock-reservation', SNSSQS).file('AbstractFlowIT.java');

  // Los tres, y los tres accesibles desde una clase de flujo: en `protected` no por
  // gusto, sino porque el escenario que los necesita vive en otra clase.
  assert.match(harness, /protected static void pauseOutboxRelay\(\)/);
  assert.match(harness, /protected static void resumeOutboxRelay\(\)/);
  assert.match(harness, /protected static void awaitBrokerStopped\(\)/);
  // Y el javadoc enseña el patrón entero, con el resume en un finally: pausar el relay y
  // no reanudarlo es un servicio que deja de publicar sin que nadie lo note.
  assert.ok(harness.includes('resumeOutboxRelay();       // SIEMPRE'), harness);
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
  // El reclamo del outbox vive en OutboxRelayStore desde que la publicación salió de la
  // transacción: la anotación va donde está el SELECT con SKIP LOCKED, no donde está el
  // @Scheduled. Ya no dura lo que la entrega al broker —esa era la razón por la que aquí
  // dolía más que en ningún otro sitio—, pero los gap locks siguen siendo reales mientras
  // la consulta escanea, y sigue corriendo cada segundo.
  const relayStore = project_.file('OutboxRelayStore.java');

  assert.match(adapter, /@Transactional\(isolation = Isolation\.READ_COMMITTED\)/);
  assert.match(relayStore, /@Transactional\(isolation = Isolation\.READ_COMMITTED\)/);
  assert.match(adapter, /import org\.springframework\.transaction\.annotation\.Isolation;/);
});

test('y los motores que ya arrancan en READ COMMITTED no se anotan', () => {
  // PostgreSQL, Oracle y SQL Server ya están ahí: declararlo sería sugerir una decisión donde
  // no hay ninguna, y ensuciar cinco motores por el defecto de uno.
  const project_ = project('stock-reservation', { ...MYSQL, database: 'postgresql' });

  assert.ok(!project_.file('ReservationRepositoryImpl.java').includes('Isolation.READ_COMMITTED'));
  assert.ok(!project_.file('OutboxRelayStore.java').includes('Isolation.READ_COMMITTED'));
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

test('la política de lectura es una sola: el arnés y el gate en vivo la comparten', () => {
  // Por qué esto merece un test propio. El módulo de sondas declaraba que la orquestación
  // con estado «vive en Java y el runner la reimplementa», y con esa frontera el gate en
  // vivo leía de UNA vez lo que el arnés lee por lotes — así que no podía ver, y no vio, que
  // el arnés contaba dos veces un mensaje repescado. Cuatro corridas con el defecto dentro.
  //
  // El tope de diez no es del arnés: es de SQS. Y que un mensaje leído con
  // `--visibility-timeout 0` pueda volver, también. Eso es política del canal, y va donde
  // van los comandos.
  const harness = project('stock-reservation', SQS).file('AbstractFlowIT.java');

  // El Java sale de las constantes, no de literales sueltos.
  assert.ok(harness.includes(`Math.min(wanted - seen.size(), ${READ_BATCH_LIMIT.snssqs})`), 'el tope de lote no sale del catálogo');
  assert.ok(harness.includes(`message.get("${READ_DEDUPE_KEY.snssqs}")`), 'la clave de dedupe no sale del catálogo');

  // Y la cota de intentos que el Java calcula es la MISMA que aplica el runner. Si divergen,
  // el gate en vivo mide una orquestación distinta de la que se genera — que es exactamente
  // el agujero por el que el defecto sobrevivió.
  const [, offset, divisor, extra] = harness.match(/\(wanted \+ (\d+)\) \/ (\d+) \+ (\d+)/).map(Number);
  // División ENTERA, como en Java: con Math.round o la división de JS este test daría por
  // equivalentes dos fórmulas que no lo son.
  const javaLimit = (count) => Math.floor((Math.max(count, 1) + offset) / divisor) + extra;
  for (const count of [1, 10, 11, 15, 25]) {
    assert.equal(javaLimit(count), readAttemptLimit('snssqs', count), `divergen en count=${count}`);
  }
});

test('y donde el broker no acota la llamada, no se lee por lotes ni se deduplica', () => {
  // RabbitMQ y Kafka aceptan el número de una vez, y una sola petición no puede repescarse a
  // sí misma. Deduplicar ahí sería código muerto que sugiere un problema que no tienen.
  for (const broker of ['rabbitmq', 'kafka']) {
    assert.equal(READ_BATCH_LIMIT[broker], Infinity, broker);
    assert.equal(READ_DEDUPE_KEY[broker], null, broker);
    assert.equal(readAttemptLimit(broker, 25), 1, broker);
  }
});

// ─── Antes de la quinta corrida: la rama documental y el gate que no medía ────
//
// Cuatro corridas sobre MySQL relacional, 19 arreglos. Cada uno tiene un gemelo documental
// que NUNCA ha corrido — sobre Mongo solo se han visto 2 de los 4 reclamos, y con otro
// diseño. Al revisar esa rama antes de estrenarla salieron estos defectos.

const DOCUMENT = { group: 'com.test', broker: 'kafka', auth: null, cache: null, storage: null };

test('el raise de cada evento publicado se exige donde build lo dejó como TODO', () => {
  // El punto ciego que llevaba cinco corridas anotado, y era más ancho de lo que decía la
  // nota. No es «el gate de compensación no ve una activación publicada»: es que el
  // `raise(...)` de CUALQUIER evento vive en el AGREGADO —build deja ahí un TODO por evento,
  // ver scaffold/entities.js § renderDomainEvents— y el `forbid` de la familia `compensation`
  // mira el HANDLER, que es otra clase.
  //
  // Un handler impecable con el raise olvidado salía VERDE, y el evento no existía: el outbox
  // no tiene qué entregar, ninguna suscripción recibe nada, y el único síntoma es un escenario
  // esperando un mensaje que nunca sale.
  const script = project('stock-reservation', { ...DOCUMENT, database: 'postgresql' }).file('check-idempotency.sh');

  assert.match(script, /unit 'domainEvent'/);
  // La clase es el AGREGADO, no el handler: es donde build dejó el TODO.
  assert.match(script, /unit 'domainEvent' 'StockReservationRequested' 'Reservation'/);
  // Y lo que se exige es que exista el raise de ESE evento, sin suponer en qué método.
  assert.match(script, /raise\\s\*\\\(\\s\*StockReservationRequestedEvent/);
  // El veredicto sale en la matriz como una familia más.
  assert.match(script, /domainEvent\s+OK|domainEvent_ko/);
});

test('el reclamo de cola documental ordena, igual que el relacional', () => {
  // El comentario del propio código daba el argumento —«con más candidatos que batchSize los
  // más antiguos podrían no reclamarse nunca»— y lo aplicaba solo al RESCATE, mientras la rama
  // relacional ordena siempre (`order by e.<campo> asc`). No era una diferencia del motor: era
  // el mismo razonamiento aplicado a medias, y deja filas viejas al fondo indefinidamente en
  // cuanto hay más candidatos de los que caben en un lote.
  const adapter = project('asset-vault', DOCUMENT).file('AssetRepositoryImpl.java');

  const claims = [...adapter.matchAll(/public List<Asset> claimFor\w+\(/g)];
  assert.ok(claims.length > 0, 'la fixture no genera ningún reclamo documental');
  // Un Sort por reclamo, tenga cota temporal o no.
  const sorts = [...adapter.matchAll(/\.with\(Sort\.by\(Sort\.Direction\.ASC/g)];
  assert.equal(sorts.length, claims.length, `${claims.length} reclamos y solo ${sorts.length} ordenados`);
  assert.match(adapter, /import org\.springframework\.data\.domain\.Sort;/);
});

test('los stores documentales capturan también el fallo al confirmar', () => {
  // El gemelo del arreglo que obligó la corrida de MySQL. No es transportable literal
  // —`PessimisticLockingFailureException` no es lo que lanza Mongo— pero el hueco funcional es
  // el mismo, y aquí es MÁS probable: el save() documental es @Transactional REQUIRED sobre
  // MongoTransactionManager, así que se une a la transacción del caso de uso y un duplicado
  // puede fallar al CONFIRMAR, no en el insert. Eso llega como TransactionSystemException, que
  // no es DataAccessException y se escapaba.
  //
  // Hay precedente en vivo: `FL-AST-001-D` de la corrida documental de agosto falló
  // exactamente en el desenlace de esa carrera.
  const generated = project('asset-vault', DOCUMENT);

  const idempotency = generated.file('MongoIdempotencyStore.java');
  assert.match(idempotency, /catch \(DataIntegrityViolationException \| TransactionSystemException/);
  assert.match(idempotency, /import org\.springframework\.transaction\.TransactionSystemException;/);

  const claims = generated.file('ReconciliationClaimStore.java');
  assert.match(claims, /catch \(DuplicateKeyException \| TransactionSystemException/);
});

test('y lo que NO aplica en documental sigue sin emitirse', () => {
  // La simétrica, que es la mitad que evita el arreglo por analogía: `READ_COMMITTED` existe
  // por los gap locks de InnoDB y en Mongo no hay ninguno; `uuidLiteral` existe porque en
  // MySQL el id es una columna binaria y aquí es un UUID nativo del driver. Emitirlos aquí
  // sería sugerir decisiones que este motor no tiene.
  const generated = project('asset-vault', DOCUMENT);

  assert.ok(!generated.file('AssetRepositoryImpl.java').includes('Isolation'), 'emite un aislamiento que no aplica');
  assert.ok(!generated.file('AbstractFlowIT.java').includes('uuidLiteral'), 'emite un helper que aquí no significa nada');
  // Y la espera al drenaje sí se emite, en su forma de mongosh.
  assert.match(generated.file('AbstractFlowIT.java'), /countDocuments\(\{ destination/);
});

// ─── Lo que encontró `broker-check` al ejecutarse por primera vez ─────────────
//
// `BRK-14` se añadió para cazar la repesca de SQS y nunca se había corrido. Al correrlo cazó
// algo distinto de lo que buscaba, y peor: no un conteo inflado sino un TECHO. Es exactamente
// para lo que existe un gate en vivo — el defecto llevaba cuatro corridas pasando por debajo de
// los tests de cadenas, de `java-syntax` y de `compile-check`, porque los tres juzgan el texto
// del comando y ninguno lo que el broker contesta.

const SWEEP = { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null };

test('leer más mensajes de los que cabe en una llamada BARRE: oculta y suelta', () => {
  // El techo: con `--visibility-timeout 0` lo devuelto vuelve a estar visible al instante, así
  // que la llamada siguiente trae OTRA VEZ los mismos diez. `publishedMessages(x, 15)` no podía
  // devolver más de 10 jamás, se publicaran los que se publicaran.
  //
  // Deduplicar —el arreglo de la cuarta corrida— quitó el conteo inflado y dejó el techo intacto,
  // y el modo de fallo que queda es igual de malo: un conteo CORTO acusa de no publicar a un
  // servicio que publicó los quince, y se arbitra `culprit: code` contra código correcto.
  const harness = project('stock-reservation', SWEEP).file('AbstractFlowIT.java');

  // El barrido solo se activa por encima del lote, que es donde está el techo: por debajo, la
  // lectura suelta ya era correcta y no hay razón para tocarla.
  assert.match(harness, /boolean sweeping = wanted > 10;/);
  assert.match(harness, /sweeping \? aws\(.*"--visibility-timeout", "10".*\) : aws\(.*"--visibility-timeout", "0"\)/);
  // Y suelta lo oculto, que es lo que conserva el peek para todos los demás.
  assert.match(harness, /aws\("sqs", "change-message-visibility".*"--visibility-timeout", "0"\)/);
  assert.match(harness, /hidden\.add\(String\.valueOf\(message\.get\("ReceiptHandle"\)\)\)/);
});

test('la suelta va en un finally, no al final del camino feliz', () => {
  // Si la lectura revienta a mitad —y revienta: `emptyIfBrokerStopped` existe porque un escenario
  // para el broker a propósito— lo ya leído se quedaría oculto los diez segundos, y el escenario
  // SIGUIENTE fallaría por una cola ciega que no es asunto suyo.
  const harness = project('stock-reservation', SWEEP).file('AbstractFlowIT.java');
  const from = harness.indexOf('protected static String publishedMessages');
  const body = harness.slice(from, harness.indexOf('return decodeBodies', from));

  assert.ok(body.indexOf('} finally {') > body.indexOf('emptyIfBrokerStopped'), body);
  assert.match(body, /\} finally \{[\s\S]*change-message-visibility/);
});

test('barriendo, un lote corto ya no corta el bucle', () => {
  // El corte por lote incompleto era correcto SIN ocultar y es falso barriendo: lo devuelto queda
  // oculto, así que un lote corto no dice que no quede nada — dice que ese sondeo trajo poco. El
  // único final fiable barriendo es el lote vacío, y por eso la condición se gatea.
  const harness = project('stock-reservation', SWEEP).file('AbstractFlowIT.java');

  assert.match(harness, /if \(!sweeping && messages\.size\(\) < size\) \{/);
});

test('la lectura suelta conserva el peek, que es lo que no se podía romper', () => {
  // La mitad simétrica: subir el timeout para todos habría arreglado la lectura larga rompiendo
  // la propiedad de la que dependen los Then que afirman dos veces sobre el mismo mensaje.
  assert.deepEqual(
    readParts('snssqs', { destination: 'q', count: '5' }).slice(-2),
    ['--visibility-timeout', '0']
  );
  // Y el barrido no existe en los otros dos: rabbitmq lee con un peek explícito y kafka por
  // offset, así que ninguno esconde nada que haya que devolver.
  for (const broker of ['rabbitmq', 'kafka']) {
    assert.equal(releaseParts(broker, { destination: 'q', receiptHandle: 'h' }), null, broker);
    const harness = project('stock-reservation', { ...SWEEP, broker }).file('AbstractFlowIT.java');
    assert.ok(!harness.includes('change-message-visibility'), broker);
    assert.ok(!harness.includes('sweeping'), broker);
  }
});

// ─── Quinta corrida: la documental, cerrada al 100% y con dos defectos del arnés ──
//
// `corrida-claim-mongodb` terminó 25/25, pero el agente tuvo que parchear el arnés a mano para
// llegar. Los dos defectos son de `build`, y los dos comparten algo peor que el fallo: el
// generador YA SABÍA la regla que incumplía. El primero la tenía implementada al lado
// (`copyToDevtools`) y aun así emitía la forma rota y la enseñaba en un javadoc; el segundo la
// tenía resuelta en la rama hermana del mismo archivo.

const MONGO = { group: 'com.test', broker: 'kafka', auth: null, cache: null, storage: null };
const SQS_PG = { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null };

test('el script de mongosh viaja por archivo, no por --eval', () => {
  // El argv protege las comillas que ENVUELVEN un argumento, no las de DENTRO. Un script de
  // mongosh lleva comillas dentro casi siempre, y en Windows el cliente de contenedores las
  // pierde al reconstruir la línea de comandos: mongosh recibía `db.getCollection(outbox_event)`
  // y respondía `ReferenceError`. Cayó `HarnessSmokeIT` y con él la suite ENTERA —
  // `score-scenarios.sh` salió con código 2, ningún flujo llegó a ejercitarse.
  const harness = project('asset-vault', MONGO).file('AbstractFlowIT.java');

  assert.match(harness, /protected static String mongoEval\(String script\)/);
  assert.match(harness, /private static void copyIntoContainer\(/);
  // La consulta que build emite usa el helper: era ella la que fallaba, no código del agente.
  const from = harness.indexOf('private static int pendingOutboxRows');
  assert.match(harness.slice(from, harness.indexOf('}', from)), /mongoEval\("db\.getCollection/);
  // Y la URI va DENTRO del helper: pedirla por parámetro es invitar a que alguien la reescriba
  // a mano con otro authSource.
  assert.ok(!/mongoEval\(String uri/.test(harness), harness.slice(from, from + 200));
});

test('y el javadoc deja de ENSEÑAR la forma que no funciona', () => {
  // Esta es la mitad que importa. El fallo no fue que el agente inventara nada: fue que copió
  // el ejemplo del javadoc de `db(...)`, que prometía «la sentencia entra como un elemento más
  // del argv, con sus comillas intactas». En documental esa promesa es falsa, y un ejemplo que
  // miente se copia igual de bien que uno que acierta — el repo ya lo aprendió con `tokenFor`.
  const doc = project('asset-vault', MONGO).file('AbstractFlowIT.java');
  assert.match(doc, /NO — las comillas de dentro no sobreviven: db\("mongosh"/);
  assert.match(doc, /Salvo un script de mongosh, que va por \{@link #mongoEval\}/);

  // Y donde la promesa SÍ se sostiene, el ejemplo sigue limpio: marcar de contraejemplo el argv
  // de psql sería desaconsejar la única forma correcta que tiene ese motor.
  const rel = project('stock-reservation', SQS_PG).file('AbstractFlowIT.java');
  assert.ok(!rel.includes('NO — las comillas de dentro no sobreviven'), 'marca un contraejemplo donde no lo hay');
  assert.ok(!rel.includes('mongoEval'), 'emite un helper de mongo en un proyecto relacional');
});

test('decodeBodies EMBEBE el cuerpo, que es lo que cumple las dos cosas a la vez', () => {
  // El informe proponía re-serializar con el mapper. Arregla la validez del JSON y rompe la otra
  // mitad: la aserción por substring `.contains("\"status\":\"active\"")` dejaría de casar, que
  // es exactamente la trampa muda que el javadoc de PAYLOAD_FIELD documenta haber costado cuatro
  // clases de flujo (falso negativo, no error: quien la "arregla" aflojándola pasa de chiripa).
  //
  // La forma correcta ya estaba escrita en el mismo archivo para RabbitMQ. Embebido, el
  // documento es JSON navegable Y el texto del evento aparece literal.
  const sqs = project('stock-reservation', SQS_PG).file('AbstractFlowIT.java');

  assert.match(sqs, /private static String embeddedBody\(String escaped\)/);
  assert.match(sqs, /result\.append\("\\"Body\\": "\)\.append\(embeddedBody\(matcher\.group\(1\)\)\)/);
  // Comprueba que ES JSON antes de embeber, igual que su hermano: un cuerpo que no lo sea
  // vuelve entrecomillado, o el documento quedaría roto por el camino contrario.
  const from = sqs.indexOf('private static String embeddedBody');
  assert.match(sqs.slice(from, sqs.indexOf('\n    }', from)), /JSON\.readTree\(decoded\)/);
});

test('el disparador del barrido se afirma por lo que hace, no por dónde vive', () => {
  // El gate daba ROJO sobre código CORRECTO. build emite un scheduler por servicio, y este
  // diseño produce dos clases que se distinguen por una sola «s» —DispatchOrderScheduler y
  // DispatchOrdersScheduler—: el agente las leyó como duplicado y las fusionó en una, con los
  // dos @Scheduled dentro. Funciona; el check, que solo miraba el nombre canónico, no.
  //
  // Y el modo de fallo era el peor de los posibles: la reconciliación NO tiene ningún escenario
  // `FL-*` detrás (un cron no se alcanza en caja negra), así que este gate es su ÚNICA
  // verificación — y el camino de menor resistencia para apagarlo era recrear la segunda clase,
  // o sea DOS beans disparando el mismo barrido y el doble de pasadas contra el proveedor.
  // Es la lección (a) por tercera vez: lo afirmable sin suponer arquitectura es que exista.
  const script = project('stock-reservation', SQS_PG).file('check-idempotency.sh');

  const line = script.split('\n').find((l) => l.startsWith("unit 'reconciliation'") && l.includes('Scheduler'));
  assert.ok(line, 'no se emite el check del disparador');
  // Localizador por CONTENIDO: la operación que dispara, no el nombre del archivo.
  assert.ok(line.includes(String.raw`\breconcile`), line);
  // Y confirmador, porque el handler y el mediador también nombran la operación: solo vale
  // el archivo que además es un disparador.
  assert.match(line, /'@Scheduled'\s*$/);
});

test('y sigue pudiendo fallar, que es lo que lo hace valer algo', () => {
  // Un gate que solo sabe ponerse verde no distingue «correcto» de «no mira». Las dos formas
  // de romperlo tienen que seguir viéndose: sin disparador en ninguna parte, y con el
  // disparador presente pero todavía en el stub que build deja.
  const script = project('stock-reservation', SQS_PG).file('check-idempotency.sh');
  const line = script.split('\n').find((l) => l.startsWith("unit 'reconciliation'") && l.includes('Scheduler'));

  assert.match(line, /'@Scheduled'/);
  assert.match(line, /'UnsupportedOperationException'/);
  // El confirmador es un parámetro del `unit`, no un literal incrustado: antes estaba
  // hardcodeado a IdempotencyGuard —servía al listener y a nadie más—, y un scheduler no lo
  // tiene, así que la búsqueda por contenido no podía encontrarlo nunca.
  assert.match(script, /confirm="\$\{8:-\}"/);
  assert.ok(!/grep -qE -- 'IdempotencyGuard' "\$candidate"/.test(script), 'el confirmador sigue hardcodeado');
});

test('un servicio no produce dos clases que se distingan por una sola «s»', () => {
  // El olor de fondo del arreglo anterior. Las operaciones se agrupan por la ENTIDAD que
  // tocan, y lo que no se puede atribuir a ninguna cae a un cajón nombrado por el SERVICIO.
  // Como un servicio se llama casi siempre como el plural de su agregado, ese cajón chocaba:
  // `inspection-reports` sobre `InspectionReport` daba InspectionReportsService junto a
  // InspectionReportService.
  //
  // Nadie lee eso como dos cosas distintas: se lee como un duplicado, y alguien lo fusiona —
  // que es exactamente lo que pasó en la quinta corrida con los dos schedulers.
  const model = modelFor('inspection-reports', { group: 'com.test', database: 'postgresql', broker: 'kafka' });
  const names = model.services.map((service) => service.className);

  assert.ok(!names.includes('InspectionReportsService'), names.join(', '));
  assert.ok(names.includes('InspectionReportService'), names.join(', '));
  // Y no queda ningún par que se diferencie solo por la pluralización.
  for (const name of names) {
    assert.ok(!names.includes(name.replace(/Service$/, 'sService')), `gemelas: ${name}`);
  }
});

test('pero sin colisión el nombre del servicio se conserva', () => {
  // La mitad simétrica, que es la que evita convertir el arreglo en «todo al agregado».
  // `asset-vault` no es el plural de `Asset`, así que su cajón sigue llamándose como el
  // servicio: renombrarlo también ahí sería perder información por una colisión que no existe.
  const model = modelFor('asset-vault', { group: 'com.test', broker: 'kafka' });
  const names = model.services.map((service) => service.className);

  assert.ok(names.includes('AssetVaultService'), names.join(', '));
  assert.ok(names.includes('AssetService'), names.join(', '));
});

test('una pasada de barrido abre su propia correlación', () => {
  // El tercer punto de entrada. La correlación la establecen el filtro HTTP y —a mano— los
  // listeners del broker; el reloj no la establecía nadie, así que el hilo del @Scheduled no
  // tenía ninguna abierta y TODO lo que un barrido publica viajaba con correlationId nulo.
  //
  // Salió como un fallo arbitrado de la quinta corrida: el agente afirmó que el evento traía
  // correlación y el escenario cayó. Se leyó como «aserción más estricta que el contrato», y
  // documentar que ahí puede ser nulo habría fijado el hueco en vez de cerrarlo — el rastro
  // que no se podía seguir era justo el del trabajo que nadie pidió por HTTP.
  const scheduler = project('asset-vault', { group: 'com.test', broker: 'kafka' })
    .file('Scheduler.java');

  assert.match(scheduler, /CorrelationContext\.runWith\(UUID\.randomUUID\(\)\.toString\(\), \(\) -> mediator\./);
  assert.match(scheduler, /import java\.util\.UUID;/);
  assert.match(scheduler, /import [\w.]+\.correlation\.CorrelationContext;/);
});

test('un barrido que alimenta una guarda se despacha SIN transacción abarcadora', () => {
  // El defecto que sobrevivió a dos pasadas de la corrida de correo porque el agente lo
  // arreglaba a mano cada vez: build decidía `dispatchWithoutTransaction` solo por `reconciles`,
  // y un barrido que delega su trabajo por elemento se despachaba transaccional.
  //
  // Con la transacción del lote, el reclamo por fila NO confirma hasta el final: ninguna réplica
  // lo ve, el envío cae DENTRO de la transacción y el estado intermedio no llega a existir para
  // nadie. Es decir, la guarda deja de guardar — que es todo lo que la corrida existe para
  // probar.
  //
  // El enlace es mecánico y no necesita leer prosa: el reclamo del barrido deja las filas en
  // `queued` y la guarda las toma de `queued`, sobre la misma entidad.
  const scheduler = project('notification-mailer', { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: 'keycloak' })
    .file('Scheduler.java');

  assert.match(scheduler, /mediator\.dispatchWithoutTransaction\(new QueueAcceptedNotificationsCommand\(\)\)/);
  assert.ok(!/mediator\.dispatch\(new QueueAcceptedNotificationsCommand/.test(scheduler), scheduler);
  // Y el porqué viaja con el método, o la siguiente lectura lo «unifica por coherencia».
  assert.match(scheduler, /sin transacción abarcadora/);
  assert.match(scheduler, /produce un efecto que no se deshace/);
});

test('y un barrido que no alimenta ninguna guarda sigue en su transacción única', () => {
  // La mitad simétrica, que es la que evita convertir el arreglo en «todo sin transacción».
  // Una purga o un cierre diario no llaman a nadie en medio: la transacción única es lo correcto
  // para ellos, y quitársela sería pagar un precio sin comprar nada.
  const scheduler = project('asset-vault', { group: 'com.test', broker: 'kafka', auth: null, cache: null, storage: null })
    .file('Scheduler.java');

  // asset-vault barre una reconciliación: esa sí va sin transacción, pero por `reconciles`.
  assert.match(scheduler, /dispatchWithoutTransaction\(new ReconcileScansCommand\(\)\)/);
  // Lo que no puede es haberse llevado por delante el camino transaccional del resto.
  const model = modelFor('asset-vault', { group: 'com.test', broker: 'kafka' });
  const guards = (model.services ?? []).flatMap((s) => s.operations ?? []).filter((o) => o.guardClaim);
  assert.deepEqual(guards, [], 'la fixture dejó de ser el caso «sin guarda» que este test necesita');
});

test('la cola de la sonda de topología sale del canal EFECTIVO, no del campo crudo', () => {
  // El defecto que llegó a bloquear 7 de 22 escenarios en la sexta corrida, y era mío: la sonda
  // resolvía su cola con `probe.channel`, que es null cuando el evento no declara canal — el
  // modelo lo deriva del destino del servicio, pero el campo crudo sigue vacío. Interpolarlo
  // producía la cadena literal "null".
  //
  // Y no fallaba en un sitio inocuo: el `receive-message` contra `.../000000000000/null` revienta
  // ANTES de que startBroker() suelte BROKER_STOPPED, así que el flag se queda en true para toda
  // la JVM y cada clase posterior muere en su @BeforeAll. Con el flag puesto, además,
  // `emptyIfBrokerStopped` da por «canal vacío» cualquier fallo de lectura: las aserciones
  // negativas habrían salido verdes sin mirar nada.
  const sinCanal = project('notification-mailer', { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: 'keycloak' })
    .file('AbstractFlowIT.java');

  assert.match(sinCanal, /TOPOLOGY_PROBE_QUEUE = "notification-mailer-events"/);
  assert.ok(!/TOPOLOGY_PROBE_QUEUE = "(null|undefined)"/.test(sinCanal), 'la sonda leería de una cola inexistente');

  // Y donde el diseño SÍ declara canal, sigue siendo ese: la cola de arnés lleva su nombre.
  const conCanal = project('stock-reservation', { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null })
    .file('AbstractFlowIT.java');
  assert.match(conCanal, /TOPOLOGY_PROBE_QUEUE = "stockEvents"/);
});

test('el correo lleva copias: el campo del agregado viaja hasta la cabecera Cc', () => {
  // `Notification.copyRecipients` se congelaba con el envío y no llegaba a ninguna parte:
  // `MailMessage` no tenía componente de copia, así que el campo quedaba siempre vacío y el
  // diseño prometía una capacidad que el servidor no cumplía. Es la misma familia que las dos
  // defensas del correo —el saneado del asunto y el escapado de variables—: nada falla, y sale
  // mal.
  const generated = project('notification-mailer', { group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: 'keycloak' });

  const message = generated.file('MailMessage.java');
  assert.match(message, /public record MailMessage\(String from, String replyTo, List<String> to, List<String> cc,/);
  // Normalizada como `to`: copia inmutable y nunca null, o el adaptador revienta con un envío
  // sin copias, que es el caso normal.
  assert.match(message, /cc = cc == null \? List\.of\(\) : List\.copyOf\(cc\);/);

  const smtp = generated.file('SmtpMailSender.java');
  assert.match(smtp, /helper\.setCc\(message\.cc\(\)\.toArray\(String\[\]::new\)\)/);
  // Vacía no se toca: `setCc` con un array vacío deja una cabecera Cc: vacía en algunos
  // servidores, que es basura visible en el correo de alguien.
  assert.match(smtp, /if \(!message\.cc\(\)\.isEmpty\(\)\) \{/);
});

// ─── Sexta corrida: notification-mailer, y lo que faltaba era un `tokenFor` que no debía existir ──
//
// `corrida-mail-guard` cerró 22/22, pero el informe (`INFORME-INTENTO-3-cerrado-22-22.md` §1)
// dejó anotado un hallazgo del generador sin test que lo fijara: el diseño es todo `level:
// service` — `security.roles` sale vacío — y aun así `AbstractFlowIT` prometía en el javadoc de
// `tokenFor` «un usuario por rol», que `init-keycloak.sh` nunca crea cuando no hay roles. Quien
// lo invocara se llevaba un `invalid_grant` sin relación aparente con la causa real.

test('sin roles de usuario, tokenFor no se emite: nadie promete un usuario que el aprovisionamiento no siembra', () => {
  // `init-keycloak.sh` solo abre el bloque "Usuarios de prueba" cuando `roles.length > 0`
  // (auth-provisioning.js § keycloakScript). Con un diseño todo `level: service` ese bloque no
  // existe, así que emitir `tokenFor` sería documentar y ofrecer un método que solo puede
  // fallar. El arreglo no fue corregir el javadoc —el mismo método cuyo javadoc ya falló dos
  // veces en este repo, ver más arriba «la regla del token está donde se decide guardarlo»—:
  // fue no emitirlo. `serviceCredential` sigue disponible, porque la superficie M2M no depende
  // de que haya roles de usuario.
  const harness = project('notification-mailer', {
    group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: 'keycloak'
  }).file('AbstractFlowIT.java');

  assert.ok(!harness.includes('protected String tokenFor(String role)'), harness.slice(0, 200));
  assert.ok(!harness.includes('un usuario por rol'), 'no debe prometer un usuario que nadie crea');
  assert.match(harness, /protected String serviceCredential\(String client\)/);
});

test('y el aprovisionamiento no siembra el bloque de usuarios que ya no se promete', () => {
  // La otra mitad de la misma verdad: si el arnés dejó de prometer usuarios, el script que
  // aprovisiona el realm tampoco debería fingir crearlos. `keycloakScript()` ya lo hacía bien
  // —el bloque va dentro de `if (roles.length > 0)`— pero nada lo ataba al lado del arnés hasta
  // ahora: los dos podían divergir sin que ningún test lo notara.
  const initKeycloak = project('notification-mailer', {
    group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: 'keycloak'
  }).file('init-keycloak.sh');

  assert.ok(!initKeycloak.includes('Usuarios de prueba'));
  // Y el aprovisionamiento M2M sí sigue, porque el diseño lo necesita: tres clientes de servicio.
  assert.match(initKeycloak, /clientId=orders-service/);
});

test('y con roles declarados, las dos piezas vuelven a aparecer juntas', () => {
  // La simétrica: `asset-vault` sí declara roles de usuario, así que aquí `tokenFor`
  // y el bloque de usuarios tienen que estar los dos — si solo apareciera uno, el arnés y
  // el aprovisionamiento medirían cosas distintas otra vez.
  const project_ = project('asset-vault', {
    group: 'com.test', database: 'postgresql', broker: 'snssqs', auth: 'keycloak', cache: null, storage: 'minio'
  });

  assert.match(project_.file('AbstractFlowIT.java'), /protected String tokenFor\(String role\)/);
  assert.match(project_.file('init-keycloak.sh'), /Usuarios de prueba/);
});

// ─── Séptima corrida: RabbitMQ, y el canal de origen no era una cola ─────────
//
// `corrida-mail-rabbit` cerró 22/22, pero llegó ahí con un parche al arnés y arrastrando un
// AVISO en cada reset que el informe no recogía. Los dos son el mismo hueco: build y la skill
// modelaban la topología de una suscripción de forma INCOMPATIBLE. Build daba por hecho que el
// canal del emisor ERA una cola —la declaraba con ese nombre, entregaba por `amq.default` y
// purgaba ese nombre—; la skill enseñaba exchange + cola propia, que es lo correcto con
// fan-out. Y build solo generaba esa topología cuando el diseño declaraba `onFailure.deadLetter`,
// así que un diseño sin descarte se quedaba sin dueño y el agente improvisaba.

const RABBIT_PG = { group: 'com.test', database: 'postgresql', broker: 'rabbitmq', auth: null, cache: null, storage: null };

test('la entrega entrante publica en el EXCHANGE del canal, no en amq.default', () => {
  // El defecto, y por qué era mudo: `amq.default` enruta por nombre de COLA, así que publicar
  // ahí con el nombre de un exchange no entrega a nadie. RabbitMQ no lo trata como error —
  // responde 200 con `"routed":false`— y `curl -sf` sale con 0. El mensaje no llega, el
  // consumidor no reacciona, y lo que se ve es un escenario muriendo en un timeout que habla de
  // otra cosa. Tumbó FL-EVT-001 y FL-EVT-001-B; FL-EVT-001-C pasó por casualidad, porque su
  // resultado esperado —nada registrado— es indistinguible de que el mensaje no llegara nunca.
  const harness = project('notification-mailer', { ...RABBIT_PG, auth: 'keycloak' }).file('AbstractFlowIT.java');

  assert.match(harness, /RABBIT_EXCHANGE_API = "http:\/\/rabbitmq:15672\/api\/exchanges\/%2F\/"/);
  assert.ok(harness.includes('RABBIT_EXCHANGE_API + destination + "/publish"'), harness.slice(0, 200));
  // Sobre el código, no sobre la prosa: el javadoc explica por qué NO se usa el exchange por
  // defecto, así que buscarlo en crudo haría fallar el test por su propio comentario.
  const code = harness.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!code.includes('amq.default'), 'sigue publicando por el exchange por defecto');
});

test('y un mensaje que no se enruta deja de pasar por entregado', () => {
  // La mitad que convierte esta familia entera en un fallo inmediato. Sin esta guarda el mismo
  // error vuelve con otra cara: cualquier desajuste entre el exchange y sus bindings se ve como
  // un consumidor que no hizo su trabajo, y se arbitra `culprit: code` contra código correcto.
  const harness = project('notification-mailer', { ...RABBIT_PG, auth: 'keycloak' }).file('AbstractFlowIT.java');

  assert.ok(harness.includes(String.raw`if (!published.contains("\"routed\":true"))`), harness.slice(0, 200));
  assert.match(harness, /throw new IllegalStateException\(\s*\n\s*"RabbitMQ aceptó la publicación en/);
  // El mensaje nombra el destino: sin él, el diagnóstico empieza por averiguar cuál falló.
  assert.match(harness, /\+ destination \+ "' pero no la enrutó/);
});

test('la topología de la suscripción la declara build aunque no haya descarte', () => {
  // El `return []` por `deadLetter` era el que dejaba la topología huérfana. `notification-mailer`
  // no declara descarte en su única suscripción, así que build no generaba nada y el agente
  // montaba la suya con otro nombre de cola — que ni la purga ni la entrega conocían.
  const generated = project('notification-mailer', { ...RABBIT_PG, auth: 'keycloak' });
  const topology = generated.file('RabbitTopologyConfig.java');

  assert.match(topology, /class RabbitTopologyConfig/);
  // El canal del emisor es el EXCHANGE, y la cola es nuestra: lleva delante el nombre del
  // servicio, porque otro consumidor del mismo canal tiene la suya.
  assert.match(topology, /new TopicExchange\("any-registered-system\.events", true, false\)/);
  assert.match(topology, /QueueBuilder\.durable\("notification-mailer\.any-registered-system"\)/);
  assert.match(topology, /BindingBuilder\.bind\(queue\)\.to\(source\)\.with\("#"\)/);
  // Sin descarte declarado no se inventa ninguno.
  assert.ok(!topology.includes('x-dead-letter-exchange'), topology);
});

test('el nombre de esa cola viaja a config, que es de donde el agente debe leerlo', () => {
  // La otra mitad del arreglo, y la que evita que vuelva a pasar: si build declara la cola pero
  // nadie le dice al agente cómo se llama, el listener sigue consumiendo de la que él invente.
  // Es el mismo reparto que ya regía en SNS/SQS.
  const generated = project('notification-mailer', { ...RABBIT_PG, auth: 'keycloak' });

  const local = generated.file(path.join('parameters', 'local', 'messaging.yaml'));
  assert.match(local, /queue: notification-mailer\.any-registered-system/);
  // Y redirigible por entorno, igual que el topic.
  const production = generated.file(path.join('parameters', 'production', 'messaging.yaml'));
  assert.match(production, /\$\{MESSAGING_SUBSCRIPTIONS_NOTIFICATION_REQUESTED_QUEUE:/);
});

test('el reset purga esa misma cola, y no el exchange del que cuelga', () => {
  // El segundo síntoma, el que el informe NO recogía: `AVISO: no se pudo purgar` en cada reset,
  // tolerado por diseño y por tanto invisible salvo leyendo el log línea a línea. La cola de
  // entrada no se vaciaba entre flujos; la corrida salió al 100% solo porque ningún escenario
  // dependía de que estuviera limpia.
  const reset = project('notification-mailer', { ...RABBIT_PG, auth: 'keycloak' }).file('reset-db.sh');

  assert.match(reset, /\/api\/queues\/%2F\/notification-mailer\.any-registered-system\/contents/);
  assert.ok(
    !reset.includes('/api/queues/%2F/any-registered-system.events/contents'),
    'pide el contenido de un exchange: eso es el AVISO que nadie leía'
  );
});

test('y Kafka no gana nada de esto, porque ahí no hay ninguna cola', () => {
  // La simétrica, que es la que impide convertir el arreglo en «todos los brokers igual». En
  // Kafka cada consumidor tiene su grupo sobre el mismo topic: no hay cola que nombrar, y
  // declararla sugeriría una decisión que ese broker no tiene.
  const generated = project('notification-mailer', { ...RABBIT_PG, broker: 'kafka', auth: 'keycloak' });

  assert.ok(!generated.file(path.join('parameters', 'local', 'messaging.yaml')).includes('queue:'));
  // Y se consume del topic directamente: el reset no purga nada (Kafka no tiene primitiva de
  // purga; su aislamiento es la marca de offset), y no hay clase de topología que declarar.
  assert.ok(!generated.file(path.join('parameters', 'local', 'messaging.yaml')).includes('any-registered-system'.concat('-queue')));
  assert.throws(
    () => generated.file('RabbitTopologyConfig.java'),
    'emite la topología de otro broker'
  );
});

// ─── El predicado del índice parcial hablaba el idioma equivocado ────────────
//
// Lo encontró el pase de calidad al REGENERAR `corrida-mail-rabbit`, no la suite: el
// invariante «como máximo una versión activa por clave» salía como
// `WHERE status = 'active'`, tomando el literal de `persistence.keel.yaml`, mientras la
// columna guarda el `name()` del enum (`ACTIVE`). El índice se crea sin error y no casa con
// ninguna fila: la garantía de base de datos que el diseño declaró no la sostiene nadie.
//
// Lo que lo hace caro es que NO hay síntoma. No falla el arranque, ni el baseline, ni ningún
// escenario `FL-*` — la ausencia de un rechazo no rompe ninguna aserción. Y el dato correcto
// existía desde siempre en el modelo (`enums[].values[].constant`) y estaba documentado en
// `integration-tests.js § persistedEnums`, que cuenta cómo esta misma asimetría ya había
// tumbado una clase entera con `SET status = 'sending'` contra un `check (… 'SENDING' …)`.
// El emisor del predicado no lo cruzaba, y el test de al lado congelaba la forma rota.

test('el predicado del índice parcial compara con la CONSTANTE, no con el literal del diseño', () => {
  const sql = project('notification-mailer', {
    group: 'com.test', database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak'
  }).file('partial-indexes.sql');

  assert.match(sql, /WHERE status = 'ACTIVE'/);
  assert.ok(!sql.includes("WHERE status = 'active'"), 'el literal del diseño no casa con ninguna fila');
});

test('y la prosa de al lado dice las dos formas, para no contradecir a la sentencia', () => {
  // El comentario habla el idioma del diseñador porque el invariante es suyo. Pero un
  // comentario que dijera `status = active` justo encima de un `WHERE status = 'ACTIVE'`
  // invita a "corregir" la sentencia, que es exactamente el camino de vuelta al defecto.
  const sql = project('notification-mailer', {
    group: 'com.test', database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak'
  }).file('partial-indexes.sql');

  assert.match(sql, /con status = active \(almacenado como 'ACTIVE'\)/);
});

test('lo que NO es un enum se emite intacto: convertirlo sería el error simétrico', () => {
  // Para un booleano o un número el literal del diseño ES el valor almacenado. La conversión
  // se hace por `field.kind === 'enum'`, no por «parece una cadena».
  const { manifest, layers } = loadService(path.join(fixturesDir, 'notification-mailer'));
  const model = buildModel({
    manifest,
    layers,
    stack: { group: 'com.test', database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak' }
  });
  const template = model.entities.find((entity) => entity.name === 'Template');

  assert.equal(storedWhenValue(model, template, { field: 'status', equals: 'active' }), 'ACTIVE');
  // Un campo que no existe, o uno no-enum: se devuelve tal cual.
  assert.equal(storedWhenValue(model, template, { field: 'version', equals: 3 }), 3);
  assert.equal(storedWhenValue(model, template, { field: 'noExiste', equals: true }), true);
  // Y un valor que el enum no tiene NO se inventa: lo caza `keel validate`, y taparlo aquí
  // dejaría el mismo índice inútil con mejor aspecto.
  assert.equal(storedWhenValue(model, template, { field: 'status', equals: 'activo' }), 'activo');
});

test('la rama documental convierte igual: Spring Data también guarda el name()', () => {
  // El gemelo, que no tenía cobertura y fallaba por lo mismo: `Criteria.where("status")
  // .is("approved")` no casa con un documento que guarda "APPROVED". La fixture documental no
  // declara ningún índice condicionado, así que se parchea el diseño — lo que hay que cubrir
  // es la conversión, no una silueta de servicio nueva.
  const { manifest, layers } = loadService(path.join(fixturesDir, 'inspection-reports'));
  const patched = structuredClone(layers);
  patched.persistence.entities.InspectionReport.indexes.push({
    fields: ['siteCode'],
    unique: true,
    when: { field: 'status', equals: 'approved' }
  });

  const workspace = tmpDir('keel-doc-partial-');
  scaffoldService({ manifest, layers: patched, workspace, force: true, stack: { group: 'com.example' } });
  const config = fs.readFileSync(
    path.join(
      workspace,
      'services/inspection-reports-spring/src/main/java/com/example/inspectionreports',
      'infrastructure/persistence/config/MongoIndexConfig.java'
    ),
    'utf8'
  );

  assert.match(config, /PartialIndexFilter\.of\(Criteria\.where\("status"\)\.is\("APPROVED"\)\)/);
  assert.ok(!config.includes('.is("approved")'), 'el literal del diseño no casa con ningún documento');
});

// ─── Lo que destapó la corrida `refunds-http` ────────────────────────────────
//
// Los dos defectos que el INFORME-GENERACION.md de esa corrida NO recogía: salieron de
// comparar los digests de `keel-generated.json` contra el árbol final, o sea de mirar qué
// archivos tocó el agente y preguntar por qué. Los dos son de plantilla y los dos pasaban
// la suite de cadenas en verde.

test('el value object hace cumplir la escala y las cotas, no solo el patrón', () => {
  // `Money` de esta fixture NO declara ningún `pattern`, y hasta aquí eso significaba que no
  // se generaba constructor compacto NINGUNO: ni escala, ni `min`. Un value object de solo
  // importes —el caso más común— se quedaba sin una sola guarda.
  const money = project('product-catalog', RELATIONAL).file('Money.java');

  assert.match(money, /public Money \{/, 'sin patrón no se emitió constructor compacto');
  // La cota del diseño (min: 0), con compareTo: un BigDecimal no se compara con operadores.
  assert.match(money, /amount\.compareTo\(new BigDecimal\("0"\)\) < 0/);
  // Y la normalización, que es la que no rompe nada visible al faltar: un record compara con
  // BigDecimal.equals, sensible a la escala, así que 12.5 y 12.50 son objetos distintos —el
  // mismo importe leído de la BD y construido desde el cuerpo de una petición—.
  assert.match(money, /amount = amount\.setScale\(2, RoundingMode\.HALF_UP\)/);
  assert.match(money, /import java\.math\.RoundingMode;/);
});

test('las dos cotas de un value object se emiten, y sobre cada campo', () => {
  // GeoPoint declara min Y max sobre latitude y longitude, con escala 6. Es la fixture que
  // distingue "se emite la cota" de "se emiten las dos cotas de los dos campos".
  const geo = project('inspection-reports', RELATIONAL).file('GeoPoint.java');

  for (const [campo, min, max] of [['latitude', '-90', '90'], ['longitude', '-180', '180']]) {
    assert.ok(geo.includes(`${campo}.compareTo(new BigDecimal("${min}")) < 0`), `falta el mínimo de ${campo}`);
    assert.ok(geo.includes(`${campo}.compareTo(new BigDecimal("${max}")) > 0`), `falta el máximo de ${campo}`);
    assert.ok(geo.includes(`${campo} = ${campo}.setScale(6, RoundingMode.HALF_UP)`), `falta la escala de ${campo}`);
  }
});

test('generate_statistics viene con el logger que silencia su volcado, y bajo level', () => {
  // build enciende `generate_statistics` en local y test para que el arnés pueda leer
  // `hibernate.statements` por el actuator. Ese flag activa además un listener que escribe
  // ~15 líneas a INFO por CADA sesión de Hibernate —cada tick del relay, cada petición, cada
  // mensaje—, y nadie lo apagaba: miles de bloques compitiendo por CPU e IO con el proceso
  // bajo prueba, en una suite cuyos `await` se miden en segundos.
  const generado = project('product-catalog', RELATIONAL);
  const local = generado.file(path.join('parameters', 'local', 'logging.yaml'));
  const produccion = generado.file(path.join('parameters', 'production', 'logging.yaml'));
  const LOGGER = 'org.hibernate.engine.internal.StatisticalLoggingSessionEventListener: WARN';

  assert.ok(local.includes(LOGGER), 'el perfil local no silencia el volcado por sesión');
  // Y va bajo `level:`, no bajo `pattern:`. La primera versión de este arreglo lo emitió
  // después del bloque de la correlación y el YAML quedaba en logging.pattern.<logger>, que
  // no configura ningún nivel: la suite pasó en verde igual.
  const nivel = local.indexOf('  level:');
  const patron = local.indexOf('  pattern:');
  assert.ok(nivel >= 0 && local.indexOf(LOGGER) > nivel, 'el logger no está bajo level:');
  assert.ok(patron === -1 || local.indexOf(LOGGER) < patron, 'el logger cayó bajo pattern:');

  // En producción no hay contador que silenciar: el flag tampoco está.
  assert.ok(!produccion.includes(LOGGER), 'production silencia un logger cuyo flag no enciende');
  assert.ok(!generado.file(path.join('parameters', 'production', 'db.yaml')).includes('generate_statistics'));
});

test('un evento que emiten DOS agregados se genera en los dos, y el gate mira los dos', () => {
  // El defecto que el informe de la corrida describió como "build solo lo generó en el primer
  // agregado". La regla real era `emitted[0]`: ganaba el primer EMISOR, así que el agregado
  // que se quedaba sin buffer, sin raise() y sin drenaje dependía del orden en que el diseño
  // declara sus operaciones. Y el gate compartía la atribución: comprobaba el raise en una
  // sola clase, de modo que el segundo agregado podía no emitir nunca y salir verde.
  const { manifest, layers } = loadService(path.join(fixturesDir, 'catalog-extended'));
  // `projectSupplierPrice` opera sobre SupplierPrice, que es su propia raíz. Emitiendo un
  // evento que ya emite una operación de Product, el evento pasa a salir de DOS agregados.
  layers['use-cases'].operations.projectSupplierPrice.emits = ['ProductUpdated'];
  const workspace = tmpDir('keel-dos-emisores-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack: RELATIONAL });
  const root = path.join(workspace, result.outDir);
  const leer = (sufijo) => {
    const found = walk(root).find((f) => f.endsWith(sufijo));
    assert.ok(found, `no se generó ${sufijo}`);
    return fs.readFileSync(found, 'utf8');
  };

  // Los dos agregados tienen el buffer y su TODO.
  for (const clase of ['Product.java', 'SupplierPrice.java']) {
    const codigo = leer(clase);
    assert.match(codigo, /private final List<DomainEvent> domainEvents/, `${clase} sin buffer`);
    assert.match(codigo, /public List<DomainEvent> pullDomainEvents/, `${clase} sin pullDomainEvents`);
  }
  // Y cada TODO cita SOLO las operaciones de su propio agregado: citarle a SupplierPrice las
  // de Product manda a escribir el raise() en la clase equivocada.
  assert.match(leer('SupplierPrice.java'), /TODO \(agente\): emitir ProductUpdated en el método de negocio de projectSupplierPrice:/);
  assert.ok(!leer('SupplierPrice.java').includes('updateProduct'), 'el TODO cita operaciones del otro agregado');

  // El adaptador del segundo agregado drena: sin esto el raise() acumula y no sale nada.
  assert.match(leer('SupplierPriceRepositoryImpl.java'), /pullDomainEvents\(\)/);

  // Y el gate emite una fila POR AGREGADO, no una por evento.
  const gate = leer(path.join('infra', 'check-idempotency.sh'));
  assert.match(gate, /unit 'domainEvent' 'ProductUpdated · Product' 'Product'/);
  assert.match(gate, /unit 'domainEvent' 'ProductUpdated · SupplierPrice' 'SupplierPrice'/);
});
