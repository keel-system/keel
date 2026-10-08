#!/usr/bin/env node
// mail-check: el correo de keel-nest contra un Mailpit REAL (incremento 12e).
//
//   npm run mail-check --workspace packages/keel-nest [-- --keep] [-- --sabotage=<id>]
//
// Lo que `npm test` no puede juzgar, porque allí el otro lado es un servidor SMTP de pega y un buzón de pega:
// que lo que el adaptador EMITIDO entrega por SMTP llegue al buzón tal como el arnés EMITIDO lo lee. Se levanta
// solo el Mailpit del catálogo (la misma imagen y el mismo entorno que el compose de infra/: chaos y el rechazo
// selectivo de `.invalid`), y contra él corren, transpilados y con un sustituto de @nestjs/common, el adaptador
// SMTP, el renderizador y los helpers de `test/integration/support/mail.ts` de notification-mailer.
//
// Mide: las dos partes y el adjunto, el remitente de respaldo, el Reply-To fijo y la cabecera propia; un cuerpo
// con acentos y comillas byte a byte; el escapado de la tabla cerrada llegando así al buzón; el asunto saneado;
// el rechazo PARCIAL (sale para el aceptado, y el adaptador lanza diciendo a quién); el rechazo total del relay y
// su vuelta; y que dos envíos se cuenten como dos.
//
// `--sabotage=<id>` rompe lo emitido CONSERVANDO LA FORMA (sigue transpilando) y el check tiene que salir rojo:
//   subject   MailMessage deja el asunto sin sanear
//   escape    el renderizador deja el escapado por defecto de Handlebars (&#x27;)
//   partial   el adaptador da por bueno un envío con destinatarios rechazados
//   fallback  el adaptador ignora el remitente de respaldo

import { MAIL_SINK } from 'keel-core/gen/infra-catalog';
import { HTTP_PORT, SMTP_PORT, ROUTES } from 'keel-core/gen/mail-probes';
import { run, resolveRuntime, freePort } from './lib/database-container.js';
import { planFixture, transpileTree } from '../test/helpers/emitted.js';
import { MAIL_HARNESS_TS } from '../src/scaffold/mail-harness.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;

// Los sabotajes: [archivo, texto que se sustituye, sustituto]. Si el texto ya no está, el check lo dice y sale
// rojo: un sabotaje que dejó de aplicarse no puede pasar por medido.
const SABOTAGES = {
  subject: ['src/domain/mail/mail-message.ts', "return value == null ? null : value.replace(/[\\r\\n]/g, ' ').trim();", 'return value == null ? null : value;'],
  escape: [
    'src/infrastructure/mail/handlebars-template-renderer.ts',
    '(Handlebars.Utils as { escapeExpression: (value: unknown) => string }).escapeExpression = escapeHtmlFive;',
    'void escapeHtmlFive;'
  ],
  partial: ['src/infrastructure/mail/smtp-mail-sender.ts', 'if (rejected.length > 0) {', 'if (rejected.length > 0 && rejected.length < 0) {'],
  fallback: ['src/infrastructure/mail/smtp-mail-sender.ts', 'const from = hasText(message.from) ? message.from : this.settings.senderFallback;', 'const from = message.from;']
};

const runtime = resolveRuntime();
if (!runtime) {
  console.error('mail-check necesita podman o docker en marcha.');
  process.exit(2);
}

const { files } = planFixture('notification-mailer', { stack: { database: 'postgresql', broker: 'rabbitmq' } });
if (sabotage) {
  const [file, from, to] = SABOTAGES[sabotage] ?? [];
  const target = files.find((candidate) => candidate.path === file);
  if (!target || !target.content.includes(from)) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
    process.exit(2);
  }
  target.content = target.content.replace(from, to);
  console.log(`(sabotaje: ${sabotage})`);
}

const httpPort = await freePort();
const smtpPort = await freePort();
const name = `keel-nest-mail-check-${process.pid}`;
const sink = MAIL_SINK.composeServices().mailpit;
const env = Object.entries(sink.environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const started = run(runtime, ['run', '-d', '--rm', '--name', name, ...env, '-p', `${httpPort}:${HTTP_PORT}`, '-p', `${smtpPort}:${SMTP_PORT}`, sink.image]);
if (!step(`Mailpit arranca (${sink.image})`, started.status === 0, started.stderr.trim().slice(-300))) process.exit(1);

const api = `http://127.0.0.1:${httpPort}/api/v1`;
let current = 'arranque';
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`${api}${ROUTES.info()}`).then((response) => response.ok, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!step('la API del buzón responde', ready)) process.exit(1);

  // Lo emitido: el adaptador, el renderizador y el arnés, con el buzón apuntando a este Mailpit.
  process.env.MAIL_API = api;
  const tree = transpileTree(
    files.map((file) => (file.path === MAIL_HARNESS_TS ? { ...file, path: 'src/harness-mail.ts' } : file)),
    { stubs: { '@nestjs/common': NEST_STUB } }
  );
  const mail = await tree.load('src/harness-mail.ts');
  const { SmtpMailSender } = await tree.load('src/infrastructure/mail/smtp-mail-sender.ts');
  const { MailMessage } = await tree.load('src/domain/mail/mail-message.ts');
  const { MailDeliveryException } = await tree.load('src/domain/mail/mail-delivery-exception.ts');
  const { HandlebarsTemplateRenderer } = await tree.load('src/infrastructure/mail/handlebars-template-renderer.ts');
  const { TemplatePart } = await tree.load('src/application/port/out/template-renderer.ts');
  // La configuración del perfil local, con el puerto de este Mailpit.
  const sender = new SmtpMailSender({
    host: '127.0.0.1',
    port: smtpPort,
    username: '',
    password: '',
    auth: false,
    starttls: false,
    connectTimeoutMs: 5000,
    readTimeoutMs: 5000,
    writeTimeoutMs: 5000,
    sender: null,
    senderFallback: 'no-reply@ejemplo.com',
    replyTo: 'soporte@ejemplo.com'
  });
  const renderer = new HandlebarsTemplateRenderer();

  current = 'envío completo';
  const text = 'Hola, Ñandú: «comillas» "dobles" y \'simples\' — áéíóú';
  await sender.send(
    new MailMessage({
      to: ['ana@ejemplo.com'],
      subject: 'Bienvenida',
      html: '<p>Hola</p>',
      text,
      headers: { 'X-Notification-Id': 'n-1' },
      attachments: [{ filename: 'factura.txt', contentType: 'text/plain', content: new TextEncoder().encode('adjunto') }]
    })
  );
  const full = await mail.lastMailTo('ana@ejemplo.com');
  step('el asunto y las dos partes llegan separadas', mail.mailSubject(full) === 'Bienvenida' && mail.mailHtml(full).includes('<p>Hola</p>'), mail.mailSubject(full));
  step('un cuerpo con acentos y comillas vuelve byte a byte', mail.mailText(full).trim() === text, JSON.stringify(mail.mailText(full)));
  step('sin remitente del dato, sale desde el de respaldo', mail.mailFrom(full) === 'no-reply@ejemplo.com', mail.mailFrom(full));
  const replyTo = (full.ReplyTo ?? []).map((address) => address.Address);
  step('el Reply-To fijo de la configuración', replyTo.includes('soporte@ejemplo.com'), JSON.stringify(replyTo));
  const attachments = (full.Attachments ?? []).map((attachment) => attachment.FileName);
  step('el adjunto viaja', attachments.includes('factura.txt'), JSON.stringify(attachments));
  const headers = await fetch(`${api}/message/${full.ID}/headers`).then((response) => response.json());
  const notificationId = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-notification-id')?.[1];
  step('la cabecera propia llega', JSON.stringify(notificationId) === JSON.stringify(['n-1']), JSON.stringify(notificationId));

  current = 'escapado';
  const html = renderer.render(TemplatePart.HTML, 'saludo:v1', '<p>Hola {{ name }}</p>', { name: "O'Hara <b>" });
  const subject = renderer.render(TemplatePart.SUBJECT, 'saludo:v1', 'Pedido & {{ name }}', { name: "O'Hara" });
  await sender.send(new MailMessage({ from: 'app@ejemplo.com', to: ['beto@ejemplo.com'], subject, html, text: 't' }));
  const escaped = await mail.lastMailTo('beto@ejemplo.com');
  step('el HTML llega con la tabla cerrada (&#39;, no &#x27;)', mail.mailHtml(escaped).includes('<p>Hola O&#39;Hara &lt;b&gt;</p>'), mail.mailHtml(escaped));
  step('el asunto no se escapa', mail.mailSubject(escaped) === "Pedido & O'Hara", mail.mailSubject(escaped));
  step('el remitente del dato manda sobre el de respaldo', mail.mailFrom(escaped) === 'app@ejemplo.com', mail.mailFrom(escaped));

  current = 'asunto';
  await sender.send(new MailMessage({ from: 'app@ejemplo.com', to: ['carla@ejemplo.com'], subject: 'Hola\r\nBcc: espia@ejemplo.com', text: 't' }));
  const injected = await mail.lastMailTo('carla@ejemplo.com');
  step('el asunto llega saneado en una sola línea', mail.mailSubject(injected) === 'Hola  Bcc: espia@ejemplo.com', JSON.stringify(mail.mailSubject(injected)));

  current = 'rechazo parcial';
  const partial = await sender
    .send(new MailMessage({ from: 'app@ejemplo.com', to: ['dani@ejemplo.com', mail.rejectedAddress('luis')], subject: 'Parcial', text: 't' }))
    .then(() => null, (error) => error);
  step(
    'el rechazo PARCIAL lanza diciendo a quién llegó y a quién no',
    partial instanceof MailDeliveryException && partial.partial() && [...partial.accepted].join() === 'dani@ejemplo.com' && [...partial.rejected].join() === 'luis@rejected.invalid',
    partial ? `${partial.message} accepted=${[...(partial.accepted ?? [])]} rejected=${[...(partial.rejected ?? [])]}` : 'no lanzó'
  );
  step('…y el correo SALIÓ para el aceptado', (await mail.awaitMailTo('dani@ejemplo.com', 1)).length === 1);

  current = 'rechazo total';
  await mail.relayRejectsRecipients();
  const rejected = await sender.send(new MailMessage({ from: 'app@ejemplo.com', to: ['eva@ejemplo.com'], subject: 'x', text: 't' })).then(() => null, (error) => error);
  step('con el relay rechazando, MailDeliveryException sin envío parcial', rejected instanceof MailDeliveryException && !rejected.partial(), rejected?.message ?? 'no lanzó');
  await mail.relayAccepts();
  await sender.send(new MailMessage({ from: 'app@ejemplo.com', to: ['eva@ejemplo.com'], subject: 'x', text: 't' }));
  step('relayAccepts: el relay vuelve a aceptar', (await mail.awaitMailTo('eva@ejemplo.com', 1)).length === 1);

  current = 'conteo';
  await sender.send(new MailMessage({ from: 'app@ejemplo.com', to: ['fede@ejemplo.com'], subject: 'uno', text: 't' }));
  await sender.send(new MailMessage({ from: 'app@ejemplo.com', to: ['fede@ejemplo.com'], subject: 'dos', text: 't' }));
  await mail.awaitMailTo('fede@ejemplo.com', 2);
  step('dos envíos se cuentan como dos, y la búsqueda discrimina', (await mail.mailCount('fede@ejemplo.com')) === 2 && (await mail.mailCount('nadie@ejemplo.com')) === 0);
} catch (error) {
  step(`${current}: el paso no llegó a terminar`, false, error instanceof Error ? error.message : String(error));
} finally {
  if (!keep) run(runtime, ['rm', '-f', name]);
  else console.log(`(contenedor conservado: ${name}, API en ${api})`);
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nmail-check: ${results.length}/${results.length} en verde.` : `\nmail-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
