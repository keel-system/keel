// El correo saliente (capa mail, adelantada al incremento 12e como en keel-nest). Como en keel-spring y keel-nest, build
// genera TAMBIÉN el adaptador SMTP y el renderizador. El C# no se ejecuta aquí: lo ejecuta `npm run mail-check` contra un
// Mailpit real (adaptador, renderizador y arnés) y `db-check`/`doc-check` (la guarda). Esto fija lo que se puede leer:
//
//   · las defensas llevan el DATO de keel-core (las cabeceras reservadas y la tabla cerrada del escapado);
//   · el handler de mail.sentBy recibe los puertos y la nota de la guarda, y ningún otro;
//   · y la paridad con keel-spring: las mismas variables de entorno en mail.yaml y el mismo reclamo de guarda.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { HTML_ESCAPES, RESERVED_MAIL_HEADERS, COMPILED_TEMPLATES_LIMIT } from 'keel-core/gen/mail-message';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, FIXTURES_DIR } from './helpers/workspace.js';
import { PACKAGES } from '../src/lib/dotnet-stack.js';

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const find = (files, suffix) => {
  const hit = Object.keys(files).find((file) => file.endsWith(suffix));
  assert.ok(hit, `no se emitió …${suffix}`);
  return files[hit];
};

test('MailMessage y el renderizador llevan el dato de keel-core: las cabeceras reservadas y la tabla CERRADA', async () => {
  const files = byPath((await planFixture('notification-mailer')).files);
  const message = find(files, 'Domain/Mail/MailMessage.cs');
  for (const header of RESERVED_MAIL_HEADERS) assert.match(message, new RegExp(`"${header}"`), header);
  assert.match(message, /LineBreaks\(\)\.Replace\(value, " "\)\.Trim\(\)/, 'el asunto se sanea en el constructor');
  const renderer = find(files, 'Infrastructure/Mail/HandlebarsTemplateRenderer.cs');
  for (const [from, to] of HTML_ESCAPES) assert.ok(renderer.includes(`target.Write("${to}")`), `${from} → ${to}`);
  assert.match(renderer, new RegExp(`MaxCompiled = ${COMPILED_TEMPLATES_LIMIT};`));
  assert.match(renderer, /Handlebars\.Create\(new HandlebarsConfiguration \{ TextEncoder = new HtmlFiveEncoder\(\) \}\)/);
  assert.match(renderer, /"\{\{this\.\[" \+ name \+ "\]\}\}"/, 'los marcadores simples como segmento literal');
  assert.doesNotMatch(renderer, /RegisterHelper|RegisterTemplate/, 'sin helpers ni partials');
});

test('mail.yaml: las MISMAS variables de entorno y defaults que keel-spring, en cada perfil', async () => {
  const dotnet = byPath((await planFixture('notification-mailer')).files);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'notification-mailer'));
  const spring = byPath(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'rabbitmq' } }).files);
  const placeholders = (text) => [...text.matchAll(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g)].map(([, name, value]) => `${name}=${value ?? ''}`).sort();
  for (const profile of ['develop', 'production']) {
    const springFile = Object.keys(spring).find((file) => file.endsWith(`parameters/${profile}/mail.yaml`));
    assert.ok(springFile, profile);
    assert.deepEqual(placeholders(dotnet[`config/parameters/${profile}/mail.yaml`]), placeholders(spring[springFile]), profile);
  }
  // En local y test, Mailpit: ni autenticación ni STARTTLS.
  assert.match(dotnet['config/parameters/local/mail.yaml'], /auth: false\n {4}starttls: false/);
});

for (const name of ['notification-mailer', 'notification-mailer-mongo']) {
  test(`${name}: el reclamo de guarda está en el puerto y el adaptador, con el nombre de keel-spring`, async () => {
    const files = byPath((await planFixture(name)).files);
    assert.match(find(files, 'Domain/Repository/INotificationRepository.cs'), /Task<Notification\?> ClaimForSendAcceptedNotification\(Guid id, CancellationToken cancellationToken = default\);/);
    const adapter = find(files, 'Repositories/NotificationRepository.cs');
    const method = adapter.slice(adapter.indexOf('public async Task<Notification?> ClaimForSendAcceptedNotification('));
    if (name.endsWith('-mongo')) {
      assert.match(method, /FindOneAndUpdateAsync<BsonDocument>\(\s*new BsonDocument \{ \{ "_id", BsonValues\.Of\(id\) \}, \{ "status", new BsonDocument\("\$in", new BsonArray \{ "QUEUED" \}\) \} \},\s*new BsonDocument\("\$set", new BsonDocument \{ \{ "status", "SENDING" \}, \{ "sending_since", /);
      assert.doesNotMatch(method.slice(0, method.indexOf('\n    }')), /Session/, 'sin la sesión del caso de uso: la marca confirma al volver');
    } else {
      assert.match(method, /scopes\.CreateAsyncScope\(\)/, 'un ámbito propio: no el contexto del caso de uso');
      assert.match(method, /UPDATE notifications SET status = 'SENDING', sending_since = \{claimedAt\} WHERE id = \{id\} AND status IN \('QUEUED'\)/);
    }
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const stack = { database: name.endsWith('-mongo') ? 'mongodb' : 'postgresql', broker: 'rabbitmq' };
    const springPort = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.find((file) => file.path.endsWith('/NotificationRepository.java')).content;
    assert.match(springPort, /Optional<Notification> claimForSendAcceptedNotification\(UUID id\);/);
  });
}

test('el handler de mail.sentBy recibe los puertos inyectados y la nota de la guarda; los demás no', async () => {
  const files = byPath((await planFixture('notification-mailer')).files);
  const handler = find(files, 'UseCases/SendAcceptedNotificationCommandHandler.cs');
  assert.match(handler, /SendAcceptedNotificationCommandHandler\([^)]*IMailSender mailSender, ITemplateRenderer templateRenderer\)/);
  assert.match(handler, /ClaimForSendAcceptedNotification\(\.\.\.\)/);
  assert.match(handler, /skill keel-dotnet-mail/);
  const others = Object.entries(files).filter(([file, content]) => file.includes('/UseCases/') && content.includes('IMailSender') && !file.includes('SendAccepted'));
  assert.deepEqual(others.map(([file]) => file), []);
  assert.match(find(files, 'Api/Program.cs'), /builder\.Services\.AddMail\(MailSettings\.From\(configuration\)\);/);
});

test('los paquetes del correo: MailKit, Handlebars.Net y la transitiva de MimeKit fijada en su versión corregida', async () => {
  const files = byPath((await planFixture('notification-mailer')).files);
  const props = files['Directory.Packages.props'];
  for (const id of ['MailKit', 'Handlebars.Net', 'System.Security.Cryptography.Pkcs']) {
    assert.match(props, new RegExp(`<PackageVersion Include="${id.replaceAll('.', '\\.')}" Version="${PACKAGES[id].version.replaceAll('.', '\\.')}" />`), id);
  }
  // La 10.0.0 a 10.0.12 tienen avisos publicados (GHSA-846f-f764-76mx): bajar de la 10.0.13 los reabre.
  const [, , patch] = PACKAGES['System.Security.Cryptography.Pkcs'].version.split('.').map(Number);
  assert.ok(patch >= 13);
  // Sin correo, ninguno.
  const plain = byPath((await planFixture('product-catalog')).files)['Directory.Packages.props'];
  assert.doesNotMatch(plain, /MailKit|Handlebars|Cryptography\.Pkcs/);
});

test('la skill keel-dotnet-mail se instala y el arnés trae el buzón y su humo', async () => {
  const files = byPath((await planFixture('notification-mailer')).files);
  assert.ok(Object.keys(files).some((file) => file.endsWith('keel-dotnet-mail/SKILL.md')));
  assert.ok(Object.keys(files).some((file) => file.endsWith('keel-dotnet-mail/references/security.md')));
  const harness = find(files, 'Support/Mail.cs');
  for (const helper of ['AwaitMailTo', 'LastMailTo', 'MailCount', 'AssertNoMailTo', 'RelayRejectsRecipients', 'RejectedAddress', 'RelayAccepts', 'MailSubject', 'MailHtml', 'MailText', 'MailFrom']) {
    assert.match(harness, new RegExp(`protected static [^=]+ ${helper}\\(`), helper);
  }
  assert.match(Object.values(files).find((content) => content.includes('SMOKE-6') || content.includes('SMOKE-7')) ?? '', /SMOKE-7: el buzón de prueba responde/);
  const plain = byPath((await planFixture('product-catalog')).files);
  assert.ok(!Object.keys(plain).some((file) => file.endsWith('Support/Mail.cs') || file.includes('keel-dotnet-mail')));
});
