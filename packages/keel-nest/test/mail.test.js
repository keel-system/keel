// El correo saliente (incremento 12e, capa mail adelantada del 13). Como en keel-spring, build genera TAMBIÉN el
// adaptador, porque lo que lleva dentro son defensas cuya ausencia no rompe ningún escenario. Aquí se EJECUTA lo
// emitido, no se compara su texto:
//
//   · MailMessage: el asunto y las cabeceras saneados en el constructor (la inyección de cabeceras SMTP);
//   · el renderizador: la tabla cerrada de escapado (& < > " ' → &#39;, no el &#x27; de Handlebars), solo en
//     HTML; los marcadores que compiten con el motor (if, this, lookup, else…) como variables; compile() que
//     falla al compilar y no al renderizar; la caché acotada;
//   · el adaptador SMTP contra un servidor SMTP falso de node:net: el envío con sus dos partes, el remitente de
//     respaldo y el Reply-To fijo, el rechazo PARCIAL (sale para unos, y aun así lanza diciendo a quién) y el
//     rechazo total;
//   · el arnés del buzón contra un Mailpit falso de node:http: la búsqueda por destinatario con su repaginación
//     y el rechazo del relay;
//   · y la paridad con keel-spring: las mismas variables de entorno en mail.yaml y el mismo reclamo de guarda.
// Contra un Mailpit real lo mide `npm run mail-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const plan = (name = 'notification-mailer', stack = STACK) => planFixture(name, { stack });
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));

let treePromise;
function tree() {
  treePromise ??= Promise.resolve(transpileTree(plan().files, { stubs: { '@nestjs/common': NEST_STUB } }));
  return treePromise;
}

// ─── El mensaje ──────────────────────────────────────────────────────────────

test('MailMessage: el asunto y las cabeceras se sanean al construir; un nombre reservado o malformado se rechaza', async () => {
  const { MailMessage } = await (await tree()).load('src/domain/mail/mail-message.ts');
  const message = new MailMessage({ to: ['a@x.test'], subject: 'Hola\r\nBcc: espia@x.test', headers: { 'X-Notification-Id': 'n-1\r\nBcc: espia@x.test' } });
  assert.equal(message.subject, 'Hola  Bcc: espia@x.test');
  assert.equal(message.headers['X-Notification-Id'], 'n-1  Bcc: espia@x.test');
  assert.throws(() => new MailMessage({ to: [], subject: 'x', headers: { Bcc: 'espia@x.test' } }), /la compone el propio mensaje/);
  assert.throws(() => new MailMessage({ to: [], subject: 'x', headers: { 'Content-Type': 'text/plain' } }), /la compone el propio mensaje/);
  assert.throws(() => new MailMessage({ to: [], subject: 'x', headers: { 'X Mal': 'v' } }), /no válido/);
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.to));
});

// ─── El renderizador ─────────────────────────────────────────────────────────

test('el renderizador escapa con la tabla CERRADA en HTML, y no escapa el texto ni el asunto', async () => {
  const t = await tree();
  const { HandlebarsTemplateRenderer } = await t.load('src/infrastructure/mail/handlebars-template-renderer.ts');
  const { TemplatePart } = await t.load('src/application/port/out/template-renderer.ts');
  const renderer = new HandlebarsTemplateRenderer();
  const variables = { name: `O'Hara <b>&"x"\`=` };
  assert.equal(renderer.render(TemplatePart.HTML, 'k1', '<p>{{ name }}</p>', variables), '<p>O&#39;Hara &lt;b&gt;&amp;&quot;x&quot;`=</p>');
  assert.equal(renderer.render(TemplatePart.TEXT, 'k1', 'Hola {{name}}', variables), `Hola O'Hara <b>&"x"\`=`);
  assert.equal(renderer.render(TemplatePart.SUBJECT, 'k1', 'Pedido & {{name}}', { name: 'factura' }), 'Pedido & factura');
});

test('el renderizador: las palabras del motor son variables, no helpers', async () => {
  const t = await tree();
  const { HandlebarsTemplateRenderer } = await t.load('src/infrastructure/mail/handlebars-template-renderer.ts');
  const { TemplatePart } = await t.load('src/application/port/out/template-renderer.ts');
  const renderer = new HandlebarsTemplateRenderer();
  const variables = { if: 'si', this: 'esto', lookup: 'L', log: 'G', else: 'E', each: 'EA', with: 'W', unless: 'U', true: 'T' };
  const source = Object.keys(variables).map((name) => `{{${name}}}`).join('|');
  assert.equal(renderer.render(TemplatePart.TEXT, 'words', source, variables), 'si|esto|L|G|E|EA|W|U|T');
  // Con bloques, else y this conservan su sentido de Handlebars.
  assert.equal(renderer.render(TemplatePart.TEXT, 'block', '{{#if vip}}VIP{{else}}normal{{/if}}', { vip: false }), 'normal');
});

test('el renderizador: compile() falla al compilar, no al renderizar; y un error de plantilla es TemplateRenderException', async () => {
  const t = await tree();
  const { HandlebarsTemplateRenderer } = await t.load('src/infrastructure/mail/handlebars-template-renderer.ts');
  const { TemplateRenderException } = await t.load('src/domain/mail/template-render-exception.ts');
  const { TemplatePart } = await t.load('src/application/port/out/template-renderer.ts');
  const renderer = new HandlebarsTemplateRenderer();
  assert.throws(() => renderer.compile('Hola {{#if x}}sin cerrar'), TemplateRenderException);
  assert.doesNotThrow(() => renderer.compile('Hola {{nombre}}'));
  assert.throws(() => renderer.render(TemplatePart.HTML, 'rota', '{{#each}}', {}), TemplateRenderException);
  // La caché va por clave: la misma clave sirve la compilación anterior aunque cambie la fuente.
  assert.equal(renderer.render(TemplatePart.TEXT, 'v1', 'A {{x}}', { x: 1 }), 'A 1');
  assert.equal(renderer.render(TemplatePart.TEXT, 'v1', 'B {{x}}', { x: 1 }), 'A 1');
});

// ─── El adaptador SMTP ───────────────────────────────────────────────────────

/** Un servidor SMTP mínimo: rechaza con 550 todo RCPT TO a una dirección `@rejected.invalid`. */
async function fakeSmtp(t) {
  const received = [];
  const server = net.createServer((socket) => {
    let data = null;
    let current = { from: null, rcpt: [], body: '' };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 fake ESMTP');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data != null) {
          if (line === '.') {
            current.body = data.join('\n');
            received.push(current);
            current = { from: null, rcpt: [], body: '' };
            data = null;
            reply('250 OK');
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) reply('250 fake');
        else if (upper.startsWith('MAIL FROM')) {
          current.from = /<([^>]*)>/.exec(line)?.[1];
          reply('250 OK');
        } else if (upper.startsWith('RCPT TO')) {
          const address = /<([^>]*)>/.exec(line)?.[1];
          if (address.endsWith('@rejected.invalid')) reply('550 5.1.1 rechazado');
          else {
            current.rcpt.push(address);
            reply('250 OK');
          }
        } else if (upper === 'DATA') {
          data = [];
          reply('354 adelante');
        } else if (upper === 'QUIT') {
          reply('221 adiós');
          socket.end();
        } else if (upper === 'RSET') reply('250 OK');
        else reply('250 OK');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, received };
}

async function sender(t, settings = {}) {
  const smtp = await fakeSmtp(t);
  const tr = await tree();
  const { SmtpMailSender } = await tr.load('src/infrastructure/mail/smtp-mail-sender.ts');
  const { MailMessage } = await tr.load('src/domain/mail/mail-message.ts');
  const { MailDeliveryException } = await tr.load('src/domain/mail/mail-delivery-exception.ts');
  const adapter = new SmtpMailSender({
    host: '127.0.0.1',
    port: smtp.port,
    username: '',
    password: '',
    auth: false,
    starttls: false,
    connectTimeoutMs: 2000,
    readTimeoutMs: 2000,
    writeTimeoutMs: 2000,
    sender: null,
    senderFallback: 'no-reply@ejemplo.com',
    replyTo: 'soporte@ejemplo.com',
    ...settings
  });
  return { adapter, smtp, MailMessage, MailDeliveryException };
}

test('el adaptador SMTP entrega las dos partes, con el remitente de respaldo, el Reply-To fijo y la cabecera propia', async (t) => {
  const { adapter, smtp, MailMessage } = await sender(t);
  await adapter.send(
    new MailMessage({
      to: ['ana@x.test'],
      subject: 'Bienvenida',
      html: '<p>Hola</p>',
      text: 'Hola',
      headers: { 'X-Notification-Id': 'n-1' },
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: new TextEncoder().encode('adjunto') }]
    })
  );
  assert.equal(smtp.received.length, 1);
  const [mail] = smtp.received;
  assert.equal(mail.from, 'no-reply@ejemplo.com', 'sin remitente del dato, el de respaldo');
  assert.deepEqual(mail.rcpt, ['ana@x.test']);
  assert.match(mail.body, /^Reply-To: soporte@ejemplo\.com$/m);
  // El nombre de cabecera no distingue mayúsculas (RFC 5322); nodemailer lo normaliza.
  assert.match(mail.body, /^X-Notification-Id: n-1$/im);
  assert.match(mail.body, /multipart\/alternative/);
  assert.match(mail.body, /Content-Type: text\/plain/);
  assert.match(mail.body, /Content-Type: text\/html/);
  assert.match(mail.body, /filename=a\.txt/);
});

test('el adaptador SMTP: el rechazo PARCIAL sale para los aceptados y aun así lanza diciendo a quién', async (t) => {
  const { adapter, smtp, MailMessage, MailDeliveryException } = await sender(t);
  const error = await adapter
    .send(new MailMessage({ from: 'app@x.test', to: ['ana@x.test', 'luis@rejected.invalid'], subject: 's', html: '<p>h</p>', text: 't' }))
    .then(() => null, (failure) => failure);
  assert.ok(error instanceof MailDeliveryException, String(error));
  assert.equal(error.partial(), true);
  assert.deepEqual([...error.accepted], ['ana@x.test']);
  assert.deepEqual([...error.rejected], ['luis@rejected.invalid']);
  assert.match(error.detail, /550/);
  assert.equal(smtp.received.length, 1, 'el correo SALIÓ para ana');
  assert.equal(smtp.received[0].from, 'app@x.test', 'el remitente del dato manda sobre el de respaldo');
});

test('el adaptador SMTP: con todos rechazados no sale para nadie; sin destinatarios ni remitente no se envía', async (t) => {
  const { adapter, smtp, MailMessage, MailDeliveryException } = await sender(t, { senderFallback: null });
  const all = await adapter.send(new MailMessage({ from: 'app@x.test', to: ['luis@rejected.invalid'], subject: 's', text: 't' })).then(() => null, (e) => e);
  assert.ok(all instanceof MailDeliveryException);
  assert.equal(all.partial(), false);
  assert.deepEqual([...all.rejected], ['luis@rejected.invalid']);
  await assert.rejects(adapter.send(new MailMessage({ to: ['ana@x.test'], subject: 's', text: 't' })), /no tiene remitente/);
  await assert.rejects(adapter.send(new MailMessage({ from: 'app@x.test', to: [], subject: 's', text: 't' })), /no tiene destinatarios/);
  assert.equal(smtp.received.length, 0);
});

test('el adaptador SMTP: el relay caído es MailDeliveryException, no un error del transporte', async () => {
  const tr = await tree();
  const { SmtpMailSender } = await tr.load('src/infrastructure/mail/smtp-mail-sender.ts');
  const { MailMessage } = await tr.load('src/domain/mail/mail-message.ts');
  const { MailDeliveryException } = await tr.load('src/domain/mail/mail-delivery-exception.ts');
  const adapter = new SmtpMailSender({ host: '127.0.0.1', port: 9, username: '', password: '', auth: false, starttls: false, connectTimeoutMs: 1000, readTimeoutMs: 1000, writeTimeoutMs: 1000, sender: null, senderFallback: 'no-reply@x.test', replyTo: null });
  await assert.rejects(adapter.send(new MailMessage({ to: ['ana@x.test'], subject: 's', text: 't' })), (error) => error instanceof MailDeliveryException && !error.partial());
});

// ─── El arnés del buzón ──────────────────────────────────────────────────────

test('el arnés del buzón: busca por destinatario, repagina por encima del techo y programa el rechazo', async (t) => {
  const requests = [];
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      const url = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/v1/search') {
        const limit = Number(url.searchParams.get('limit'));
        const query = url.searchParams.get('query');
        const matching = query === 'to:muchos@x.test' ? ids : query === 'ana@x.test' ? [] : query === 'to:ana@x.test' ? ['m-1'] : [];
        res.end(JSON.stringify({ messages_count: matching.length, messages: matching.slice(0, limit).map((ID) => ({ ID })) }));
      } else if (url.pathname === '/api/v1/message/m-1') {
        res.end(JSON.stringify({ Subject: 'Hola', HTML: '<p>h</p>', Text: 't', From: { Address: 'no-reply@ejemplo.com' } }));
      } else if (url.pathname === '/api/v1/chaos') {
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  process.env.MAIL_API = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(() => delete process.env.MAIL_API);
  const files = plan().files.map((file) => (file.path === 'test/integration/support/mail.ts' ? { ...file, path: 'src/harness-mail.ts' } : file));
  const harness = await transpileTree(files.filter((file) => file.path === 'src/harness-mail.ts')).load('src/harness-mail.ts');

  assert.equal(await harness.mailCount('muchos@x.test'), 250, 'por encima del techo de 200, repagina con el total');
  const message = await harness.lastMailTo('ana@x.test');
  assert.equal(harness.mailSubject(message), 'Hola');
  assert.equal(harness.mailFrom(message), 'no-reply@ejemplo.com');
  assert.equal(harness.mailText(message), 't');
  assert.equal(harness.rejectedAddress('luis'), 'luis@rejected.invalid');
  await harness.relayRejectsRecipients();
  await harness.relayAccepts();
  const chaos = requests.filter((request) => request.url === '/api/v1/chaos');
  assert.deepEqual(chaos.map((request) => [request.method, JSON.parse(request.body)]), [
    ['PUT', { Recipient: { ErrorCode: 550, Probability: 100 } }],
    ['PUT', {}]
  ]);
});

// ─── Paridad con keel-spring ─────────────────────────────────────────────────

test('mail.yaml: las MISMAS variables de entorno y defaults que keel-spring, en cada perfil', () => {
  const nest = byPath(plan().files);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'notification-mailer'));
  const spring = byPath(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files);
  const placeholders = (text) => [...text.matchAll(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g)].map(([, name, value]) => `${name}=${value ?? ''}`).sort();
  for (const profile of ['develop', 'production']) {
    const springFile = Object.keys(spring).find((file) => file.endsWith(`parameters/${profile}/mail.yaml`));
    assert.ok(springFile, profile);
    assert.deepEqual(placeholders(nest[`config/parameters/${profile}/mail.yaml`]), placeholders(spring[springFile]), profile);
  }
});

for (const name of ['notification-mailer', 'notification-mailer-mongo']) {
  test(`${name}: el reclamo de guarda está en el puerto y el adaptador, con el nombre de keel-spring`, () => {
    const stack = name.endsWith('-mongo') ? { database: 'mongodb', broker: 'rabbitmq' } : STACK;
    const files = byPath(plan(name, stack).files);
    assert.match(files['src/domain/repository/notification-repository.ts'], /abstract claimForSendAcceptedNotification\(id: string\): Promise<Notification \| null>;/);
    const adapter = files['src/infrastructure/persistence/repositories/notification-repository-impl.ts'];
    if (name.endsWith('-mongo')) {
      const method = adapter.slice(adapter.indexOf('async claimForSendAcceptedNotification('), adapter.indexOf('async save('));
      assert.match(method, /findOneAndUpdate\(\s*\{ _id: toUuid\(id\), 'status': \{ \$in: \["QUEUED"\] \} \},\s*\{ \$set: \{ 'status': "SENDING", 'sending_since': new Date\(\) \} \}/);
      assert.doesNotMatch(method, /session/, 'sin la sesión del caso de uso: la marca confirma al volver');
    } else {
      assert.match(adapter, /inNewTransaction[\s\S]{0,400}\.set\(\{ status: NotificationStatus\.SENDING, sendingSince: new Date\(\) \}\)/);
    }
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const springPort = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.find((file) => file.path.endsWith('/NotificationRepository.java')).content;
    assert.match(springPort, /Optional<Notification> claimForSendAcceptedNotification\(UUID id\);/);
  });
}

test('el handler de mail.sentBy recibe los puertos inyectados y la nota de la guarda; los demás no', () => {
  const files = byPath(plan().files);
  const handler = files['src/application/usecases/send-accepted-notification-command-handler.ts'];
  assert.match(handler, /static readonly inject = \[NotificationRepository, MailSender, TemplateRenderer, NotificationApplicationMapper\] as const;/);
  assert.match(handler, /claimForSendAcceptedNotification\(\.\.\.\)/);
  const other = Object.entries(files).filter(([file, content]) => file.startsWith('src/application/usecases/') && content.includes('MailSender') && !file.includes('send-accepted'));
  assert.deepEqual(other.map(([file]) => file), []);
  assert.match(files['src/app.module.ts'], /MailModule\.register\(configuration\)/);
  assert.match(files['package.json'], /"nodemailer"/);
  assert.match(files['package.json'], /"handlebars"/);
});
