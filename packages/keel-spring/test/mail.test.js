// La silueta del correo: un servicio cuya SALIDA es correo electrónico.
//
// Ninguna otra fixture la tiene, y es la que ejercita cuatro piezas que no comparte
// con nadie: el adaptador SMTP con sus dos defensas, el motor de plantillas sin
// lógica, la sección del buzón en el arnés de integración y el appendix de índices
// únicos condicionados —que es lo que sostiene «como máximo una versión activa».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import {
  SEARCH_PREFIX,
  SEARCH_LIMIT,
  SEARCH_LIMIT_PARAM,
  searchSuffix,
  ROUTES,
  FIELDS,
  validateCommand,
  resetCommand
} from '../src/lib/mail-probes.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notification-mailer');
const PROJECT = path.join('services', 'notification-mailer-spring');
const JAVA = 'src/main/java/com/platform/notificationmailer';

function scaffoldMailer(stack = undefined) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-mail-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack });
  const root = path.join(workspace, PROJECT);
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const exists = (relative) => fs.existsSync(path.join(root, relative));
  return { result, read, exists };
}

// ─── El adaptador y sus defensas ─────────────────────────────────────────────

test('build genera el adaptador SMTP entero, no un TODO para el agente', () => {
  // La frontera habitual (build deja el puerto, el agente escribe el adaptador) no
  // aplica aquí: el transporte no cambia con la infraestructura elegida, y lo que
  // el adaptador lleva dentro son dos defensas que nadie recuerda escribir.
  const { exists, read } = scaffoldMailer();
  assert.ok(exists(`${JAVA}/application/port/out/MailSender.java`));
  assert.ok(exists(`${JAVA}/infrastructure/mail/SmtpMailSender.java`));

  const adapter = read(`${JAVA}/infrastructure/mail/SmtpMailSender.java`);
  assert.ok(!adapter.includes('TODO'), 'el adaptador no puede quedar como TODO del agente');
  assert.ok(adapter.includes('implements MailSender'));
  assert.ok(adapter.includes('javaMailSender.send(mime)'));
});

test('el asunto se sanea en el CONSTRUCTOR del mensaje, no en el adaptador', () => {
  // Es lo que impide que un camino escrito después —uno que no pase por el
  // adaptador de hoy— construya un mensaje con el asunto sin sanear. Un \r\n dentro
  // del asunto cierra la cabecera Subject: y abre otra: así se inyecta un Bcc:.
  const { read } = scaffoldMailer();
  const message = read(`${JAVA}/domain/mail/MailMessage.java`);
  assert.ok(message.includes('public MailMessage {'), 'falta el constructor compacto del record');
  assert.match(message, /subject = sanitizeSubject\(subject\);/);
  assert.match(message, /replaceAll\("\[\\\\r\\\\n\]"/);

  const adapter = read(`${JAVA}/infrastructure/mail/SmtpMailSender.java`);
  assert.ok(
    !adapter.includes('sanitizeSubject'),
    'el saneado no puede estar TAMBIÉN en el adaptador: dos sitios es uno que se olvidará'
  );
});

test('el motor de plantillas no evalúa expresiones y cachea por clave', () => {
  // Con templating.source: data el cuerpo lo escribe alguien de fuera del equipo.
  // Un motor con SpEL (Thymeleaf) sería ejecución remota de código.
  const { read } = scaffoldMailer();
  const renderer = read(`${JAVA}/infrastructure/mail/HandlebarsTemplateRenderer.java`);
  assert.ok(renderer.includes('com.github.jknack.handlebars.Handlebars'));
  assert.ok(renderer.includes('compileInline'), 'la plantilla llega como cadena: sin resolvers de fichero');
  assert.ok(renderer.includes('ConcurrentHashMap'), 'la compilación se cachea por clave');

  const gradle = read('build.gradle');
  assert.ok(gradle.includes('spring-boot-starter-mail'));
  assert.ok(gradle.includes('com.github.jknack:handlebars'));
  assert.ok(!gradle.includes('spring-boot-starter-thymeleaf'), 'Thymeleaf está vetado con plantillas de origen externo');
});

test('los parámetros del correo entran por constructor, no por campo con @Value', () => {
  // Un bean con la mitad del estado puesto por reflexión no se puede construir en
  // una prueba sin un contexto de Spring entero.
  const { read } = scaffoldMailer();
  const adapter = read(`${JAVA}/infrastructure/mail/SmtpMailSender.java`);
  assert.match(adapter, /public SmtpMailSender\(JavaMailSender javaMailSender,/);
  assert.match(adapter, /@Value\("\$\{mail\.sender-fallback:\}"\) String senderFallback/);
  assert.match(adapter, /@Value\("\$\{mail\.reply-to:\}"\) String configuredReplyTo/);
});

// ─── Configuración e infraestructura ─────────────────────────────────────────

test('el gradiente de configuración va de literal en local a variable obligatoria en production', () => {
  const { read } = scaffoldMailer();
  const local = read('src/main/resources/parameters/local/mail.yaml');
  assert.ok(local.includes('host: localhost'));
  assert.ok(local.includes('port: 1025'));
  assert.ok(local.includes('auth: false'), 'Mailpit no exige autenticación: pedirla rompería el envío local');

  const production = read('src/main/resources/parameters/production/mail.yaml');
  assert.ok(production.includes('${MAIL_HOST}'));
  assert.ok(production.includes('${MAIL_PASSWORD}'));
  // Los defaults de JavaMail son SIN timeout: un proveedor caído deja el hilo
  // esperando para siempre.
  assert.ok(production.includes('connectiontimeout:'));
  assert.ok(production.includes('timeout:'));
});

test('la decisión del diseño viaja bajo la clave mail, no bajo spring.mail', () => {
  const { read } = scaffoldMailer();
  const local = read('src/main/resources/parameters/local/mail.yaml');
  assert.ok(local.includes('multipart: true'), 'delivery.parts: [html, text] ⇒ multipart/alternative');
  assert.ok(local.includes('sender-fallback: no-reply@ejemplo.com'));
  assert.ok(local.includes('reply-to: soporte@ejemplo.com'));
});

test('la infraestructura de prueba levanta el buzón, lo sondea y lo purga', () => {
  const { read } = scaffoldMailer();
  const compose = read('infra/docker-compose.yaml');
  assert.ok(compose.includes('axllent/mailpit'));
  assert.ok(compose.includes('1025:1025'));
  assert.ok(compose.includes('8025:8025'));

  // Sondeo y purga salen del MISMO módulo que las rutas del arnés: escritos a mano
  // en cada sitio, el gate en vivo comprobaría algo distinto de lo que se genera.
  assert.ok(read('infra/validate-infra.sh').includes(validateCommand()));
  assert.ok(read('infra/reset-db.sh').includes(resetCommand()));
});

test('el buzón también está en deploy/, o la app arranca contra un SMTP inexistente', () => {
  const { read } = scaffoldMailer();
  const compose = read('deploy/docker-compose.yaml');
  assert.ok(compose.includes('axllent/mailpit'));
  // Dentro de la red se habla por nombre de servicio: localhost sería el propio
  // contenedor de la app.
  assert.ok(read('deploy/.env').includes('MAIL_HOST=mailpit'));
});

// ─── El arnés ────────────────────────────────────────────────────────────────

test('el arnés sabe leer el buzón por las rutas compartidas', () => {
  const { read } = scaffoldMailer();
  const harness = read('src/integrationTest/java/com/platform/notificationmailer/flows/AbstractFlowIT.java');
  for (const helper of ['awaitMailTo', 'lastMailTo', 'mailCount', 'assertNoMailTo', 'mailSubject', 'mailHtml', 'mailText', 'mailFrom']) {
    assert.ok(harness.includes(helper), `falta el helper ${helper}`);
  }
  assert.ok(harness.includes(`"${SEARCH_PREFIX}"`), 'la búsqueda no usa el prefijo compartido');
  assert.ok(harness.includes(`"${ROUTES.message('')}"`), 'el detalle no usa la ruta compartida');
  assert.ok(harness.includes(FIELDS.searchIds), 'los ids no se leen por la ruta compartida');
});

// El techo de la búsqueda no es una preferencia: `limit` recorta la lista de mensajes,
// y todos los helpers de correo cuentan por esa lista. Con el valor anterior (50) y sin
// mirar el conteo real, un escenario de volumen fallaba con un conteo plano que ningún
// cambio en la aplicación podía superar — ocurrió en una corrida real.
test('la búsqueda del arnés no tiene techo: lee el conteo real y repagina con él', () => {
  const { read } = scaffoldMailer();
  const harness = read('src/integrationTest/java/com/platform/notificationmailer/flows/AbstractFlowIT.java');
  assert.ok(
    harness.includes(FIELDS.searchTotal),
    'mailIdsTo no lee el conteo de coincidencias: los helpers saturan en el límite de la búsqueda'
  );
  assert.ok(
    harness.includes(`private static final int MAIL_SEARCH_LIMIT = ${SEARCH_LIMIT};`),
    'el techo de la búsqueda no sale de mail-probes.js'
  );
  assert.ok(
    harness.includes(`"${SEARCH_LIMIT_PARAM}" + matching.intValue()`),
    'no se repite la búsqueda con el total: el techo sigue ahí aunque se lea'
  );
  assert.ok(
    harness.includes(`"${SEARCH_PREFIX}" + query + "${searchSuffix()}"`),
    'la primera búsqueda no compone el sufijo compartido: el límite estaría escrito a mano'
  );
});

test('el humo del arnés comprueba que el buzón responde y arranca vacío', () => {
  // Que arranque vacío importa tanto como que responda: un correo de la corrida
  // anterior hace que el primer awaitMailTo devuelva el mensaje equivocado.
  const { read } = scaffoldMailer();
  const smoke = read('src/integrationTest/java/com/platform/notificationmailer/flows/HarnessSmokeIT.java');
  assert.ok(smoke.includes('mailSinkIsReachable'));
  assert.ok(smoke.includes('mailCount('));
});

// ─── El índice único condicionado ────────────────────────────────────────────

// Una lista no es una columna de la entidad, pero cada elemento suyo SÍ es una
// columna de la tabla hija que genera build. Las dos mitades del mapeo se perdían
// ahí: el `length` del value type (la única cota que llega al DDL) y el índice que
// el diseño declara sobre la lista, que se descartaba con un aviso y no existía en
// ninguna parte —ni en la entidad, ni en el appendix de migrations—.
test('la tabla de elementos hereda la longitud del value type y el índice de la lista', () => {
  const { read } = scaffoldMailer();
  const entity = read(`${JAVA}/infrastructure/persistence/entities/NotificationJpa.java`);
  assert.ok(
    entity.includes('@Column(name = "copy_recipients", length = 254)'),
    'la columna del elemento sale sin length: el maxLength del value type no llega al DDL'
  );
  assert.ok(
    entity.includes(
      '@CollectionTable(name = "notification_copy_recipients", joinColumns = @JoinColumn(name = "notification_id"), ' +
        'indexes = @Index(name = "idx_notifications_copy_recipients", columnList = "copy_recipients, notification_id"))'
    ),
    'el índice declarado sobre la lista no se materializa en su tabla de elementos'
  );
  // Y no puede salir además en el @Table de la entidad: ahí la columna no existe y
  // el DDL revienta al aplicarse.
  assert.ok(
    !/@Table\([^)]*copy_recipients/.test(entity),
    'el índice de la lista se coló en el @Table de la entidad: esa columna no está en esa tabla'
  );
});

test('«como máximo una activa» sale como índice parcial, no como constraint de columnas', () => {
  // Con UNIQUE (application, key, locale) a secas no podrías tener nunca dos
  // versiones; sin nada, dos publicaciones simultáneas dejan dos activas.
  const { read } = scaffoldMailer();
  const sql = read('src/main/resources/db/partial-indexes.sql');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uk_templates_application_key_locale/);
  assert.match(sql, /WHERE status = 'active'/);
  // Quoting del DIALECTO, no el backtick de Hibernate: este SQL va directo al motor.
  assert.ok(sql.includes('"key"'), 'una palabra reservada tiene que citarse como la cita PostgreSQL');
  assert.ok(!sql.includes('`key`'), 'el backtick solo vale dentro de una anotación que Hibernate traduzca');
});

test('el índice condicionado NO se anota en la entidad JPA', () => {
  // @Index no tiene predicado: anotarlo crearía un índice único sobre TODAS las
  // filas, que es el invariante contrario al declarado.
  const { read } = scaffoldMailer();
  const entity = read(`${JAVA}/infrastructure/persistence/entities/TemplateJpa.java`);
  assert.ok(
    !entity.includes('uk_templates_application_key_locale'),
    'el índice condicionado no puede salir por anotación: prohibiría también las versiones históricas'
  );
});

test('solo local aplica el appendix: en Flyway ya viaja en el baseline, y en test no cabe', () => {
  const { read } = scaffoldMailer();
  const local = read('src/main/resources/parameters/local/db.yaml');
  assert.ok(local.includes('classpath:db/partial-indexes.sql'), 'sin el appendix, en local el invariante no lo sostiene nada');
  // Sin esto, Boot ejecuta el script ANTES de que Hibernate cree las tablas.
  assert.ok(local.includes('defer-datasource-initialization: true'), 'el orden de las dos mitades');

  const production = read('src/main/resources/parameters/production/db.yaml');
  assert.ok(
    !production.includes('partial-indexes.sql'),
    'en production el esquema lo pone Flyway y el appendix ya viaja dentro del baseline'
  );

  // El perfil test corre sobre H2, que no tiene índices parciales: ejecutar ahí un
  // appendix escrito para el dialecto elegido rompería el arranque del contexto.
  const testProfile = read('src/main/resources/parameters/test/db.yaml');
  assert.ok(!testProfile.includes('partial-indexes.sql'), 'H2 no puede ejecutar el appendix del dialecto elegido');
});

test('el export del esquema añade el appendix al baseline', () => {
  // Pedírselo al agente como un paso más sería pedirle que recuerde algo que build
  // ya sabe, y su olvido no lo detecta nadie hasta que hay dos filas activas.
  const { read } = scaffoldMailer();
  assert.ok(read('infra/export-schema.sh').includes('db/partial-indexes.sql'));
});

test('un motor sin índices parciales lo dice en voz alta en vez de generar el índice equivocado', () => {
  const { result, read } = scaffoldMailer({ database: 'mysql', broker: 'kafka', auth: 'keycloak' });
  assert.ok(
    result.warnings.some((warning) => warning.includes('no tiene índices parciales')),
    `esperaba el aviso del motor: ${result.warnings.join(' | ')}`
  );
  const sql = read('src/main/resources/db/partial-indexes.sql');
  assert.ok(sql.includes('ATENCIÓN'));
  assert.ok(!sql.includes('CREATE UNIQUE INDEX'), 'no se genera un índice que el motor no puede condicionar');
});

// ─── La violación se traduce al error del diseño ─────────────────────────────

test('el nombre del índice único llega al mapa del ApiExceptionHandler', () => {
  // Un índice parcial existe para sostener un invariante que el diseño nombró: si
  // el handler no reconoce su nombre, ese error se degrada a un 409 genérico.
  const { read } = scaffoldMailer();
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);
  assert.ok(handler.includes('uk_templates_application_key_locale'));
});

// ─── La skill viaja con el proyecto ──────────────────────────────────────────

test('la skill del correo se instala solo cuando el diseño declara la capa', () => {
  const { exists } = scaffoldMailer();
  assert.ok(exists('.claude/skills/keel-spring-mail/SKILL.md'));
  assert.ok(exists('.claude/skills/keel-spring-mail/references/security.md'));
});

// ─── El inquilino que llega por el canal genérico ────────────────────────────

test('la identidad de la suscripción sale de la envoltura, con su asunción declarada', () => {
  // Por el canal de eventos no llega ningún token: hay que decir qué lo sustituye,
  // o cada implementación supondrá una cosa distinta. Aquí sale de `metadata.source`,
  // que es procedencia declarada y no identidad verificada — de ahí que el schema
  // exija escribir en `trustedPublishers` la asunción que lo sostiene.
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  const identity = layers.messaging.subscriptions.NotificationRequested.identity;
  assert.equal(identity.field, 'applicationKey');
  assert.deepEqual(identity.from, { location: 'field', name: 'metadata.source' });
  assert.ok(identity.trustedPublishers.length > 20, 'la asunción tiene que estar escrita, no supuesta');
  // Fallo permanente: reintentar no hace aparecer una aplicación que no existe.
  assert.equal(identity.onUnresolved, 'discard');
  // Y en un solo sitio: el mismo campo en `input` serían dos versiones de la verdad.
  assert.ok(!(identity.field in (layers.messaging.subscriptions.NotificationRequested.input ?? {})));
});

test('el arnés puede variar el emisor: identity.from es un parámetro del deliver, no una constante', () => {
  // Sin esto, todos los mensajes que entrega el arnés vienen del mismo emisor y ningún
  // escenario multi-inquilino es escribible — que es exactamente lo que ocurría: el
  // sobre se emitía como literal cerrado con eventId y eventType, y nada más.
  const { read } = scaffoldMailer();
  const harness = read('src/integrationTest/java/com/platform/notificationmailer/flows/AbstractFlowIT.java');

  assert.ok(harness.includes('deliverNotificationRequested(String messageId, String source, String payloadJson)'));
  // Y el valor va DONDE el contrato dice que viaja: metadata.source de la envoltura.
  assert.ok(harness.includes('+ ",\\"source\\":\\"" + source + "\\""'));
});

test('el javadoc del mensaje dice de dónde sale la identidad y qué hacer con un emisor desconocido', () => {
  // Es lo único que lee quien escribe el listener. Sin ello el inquilino acaba saliendo
  // del payload —que lo elige el llamante— o el mensaje desconocido se confirma en
  // silencio, que son correos que no salen sin que nada dé error en ningún sitio.
  const { read } = scaffoldMailer();
  const message = read(`${JAVA}/infrastructure/messaging/subscriptions/NotificationRequestedMessage.java`);

  assert.ok(message.includes("resuelve applicationKey desde el campo 'metadata.source'"));
  assert.ok(message.includes('No la leas del payload'));
  assert.ok(message.includes('onUnresolved: discard'));
});

test('la espera de correo cubre la cadencia del barrido que hay en medio', () => {
  // El correo de esta fixture NO sale dentro de la operación que atiende la petición: lo manda
  // `sendAcceptedNotification`, a quien un cron encola cada minuto. Una espera fija de 15 s
  // haría que el escenario saliera verde o rojo según el segundo en que arrancara la suite —
  // intermitente por el reloj, no por el código—, así que se DERIVA del `schedule` declarado:
  // el periodo del barrido más el margen, con el suelo y el techo del arnés.
  const { read } = scaffoldMailer();
  const harness = read('src/integrationTest/java/com/platform/notificationmailer/flows/AbstractFlowIT.java');

  // 60 s de cadencia + 15 de margen. El valor importa menos que de dónde sale.
  assert.ok(harness.includes('private static final int MAIL_AWAIT_SECONDS = 75;'), harness.slice(0, 0) || 'no deriva del cron');
  assert.ok(harness.includes('Instant.now().plusSeconds(MAIL_AWAIT_SECONDS)'));
  // Y el margen del Then negativo es el MISMO: con uno menor, «no ha llegado» y
  // «todavía no ha llegado» son indistinguibles y el escenario sale verde siempre.
  assert.ok(harness.includes('sleepQuietly(MAIL_AWAIT_SECONDS * 1000L)'));
  // Sin literales sueltos: el valor repetido era lo que hacía imposible derivarlo.
  assert.ok(!harness.includes('plusSeconds(15)'));
});
