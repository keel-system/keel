#!/usr/bin/env node
// mail-check: el correo de keel-dotnet contra un Mailpit REAL (capa mail, adelantada al incremento 12e). El gemelo del
// mail-check de keel-nest.
//
//   npm run mail-check --workspace packages/keel-dotnet [-- --keep] [-- --sabotage=<id>]
//
// Lo que `npm test` no puede juzgar: que lo que el adaptador SMTP EMITIDO entrega llegue al buzón tal como el arnés
// EMITIDO (Support/Mail.cs) lo lee, y que el renderizador emitido escape con la tabla cerrada. Se levanta SOLO el
// Mailpit del catálogo (la misma imagen y el mismo entorno que el compose de infra/: chaos y el rechazo selectivo de
// `.invalid`), y contra él corren las sondas de scripts/probes/MailProbes sobre lo emitido de notification-mailer.
//
// --sabotage=<id> rompe lo emitido CONSERVANDO LA FORMA (sigue compilando), y el check tiene que salir rojo:
//   subject   MailMessage deja el asunto sin sanear
//   escape    el renderizador deja el escapado por defecto de Handlebars.Net
//   partial   el adaptador da por bueno un envío con destinatarios rechazados
//   fallback  el adaptador ignora el remitente de respaldo
//
// Necesita el SDK de .NET 10 y podman o docker; red la primera vez (la imagen y NuGet).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAIL_SINK } from '@keel-system/keel-core/gen/infra-catalog';
import { HTTP_PORT, SMTP_PORT, ROUTES } from '@keel-system/keel-core/gen/mail-probes';
import { run, resolveRuntime, freePort } from '../../keel-nest/scripts/lib/database-container.js';
import { planFixture, makeWorkspace } from '../test/helpers/workspace.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const MAIL = 'src/NotificationMailer.Infrastructure/Mail';
const SABOTAGES = {
  subject: ['src/NotificationMailer.Domain/Mail/MailMessage.cs', 'value is null ? null : LineBreaks().Replace(value, " ").Trim();', 'value;'],
  escape: [`${MAIL}/HandlebarsTemplateRenderer.cs`, 'new HandlebarsConfiguration { TextEncoder = new HtmlFiveEncoder() }', 'new HandlebarsConfiguration()'],
  partial: [`${MAIL}/SmtpMailSender.cs`, 'if (client.Rejected.Count > 0)', 'if (client.Rejected.Count < 0)'],
  fallback: [`${MAIL}/SmtpMailSender.cs`, 'var from = HasText(message.From) ? message.From : settings.SenderFallback;', 'var from = message.From;']
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

function dotnet(cwd, args, env = {}) {
  const result = spawnSync('dotnet', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env },
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);

const httpPort = await freePort();
const smtpPort = await freePort();
const container = `keel-dotnet-mail-check-${process.pid}`;
const sink = MAIL_SINK.composeServices().mailpit;
const env = Object.entries(sink.environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const started = run(runtime, ['run', '-d', '--rm', '--name', container, ...env, '-p', `${httpPort}:${HTTP_PORT}`, '-p', `${smtpPort}:${SMTP_PORT}`, sink.image]);
if (!step(`Mailpit arranca (${sink.image})`, started.status === 0, started.stderr?.trim().slice(-300))) process.exit(1);

const api = `http://127.0.0.1:${httpPort}/api/v1`;
const root = makeWorkspace('keel-dotnet-mail-check-');
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`${api}${ROUTES.info()}`).then((response) => response.ok, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!step('la API del buzón responde', ready)) throw new Error('Mailpit no respondió');

  // El proyecto de notification-mailer y las sondas, en una solución.
  const { files } = await planFixture('notification-mailer');
  for (const file of files) {
    const target = path.join(root, 'notification-mailer', file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  for (const shared of ['global.json', 'Directory.Build.props', 'Directory.Packages.props']) {
    fs.copyFileSync(path.join(root, 'notification-mailer', shared), path.join(root, shared));
  }
  const probes = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes', 'MailProbes');
  fs.cpSync(probes, path.join(root, 'MailProbes'), { recursive: true });
  if (sabotage) {
    const [file, from, to] = SABOTAGES[sabotage];
    const target = path.join(root, 'notification-mailer', file);
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(from)) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
      process.exit(2);
    }
    fs.writeFileSync(target, text.replace(from, to));
    console.log(`(sabotaje: ${sabotage})`);
  }

  const built = dotnet(root, ['build', 'MailProbes/MailProbes.csproj', '-c', 'Release']);
  if (!step('el arnés emitido (solo), el adaptador y el renderizador compilan con las sondas', built.ok)) {
    console.error([...new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)))].slice(0, 40).join('\n'));
    throw new Error('no compila');
  }
  const tested = dotnet(root, ['test', '--project', 'MailProbes/MailProbes.csproj', '--no-build', '-c', 'Release'], {
    MAIL_API: api,
    MAIL_CHECK_SMTP_PORT: String(smtpPort)
  });
  const total = Number(/total: (\d+)/.exec(tested.output)?.[1] ?? 0);
  const failures = tested.output.split('\n').filter((line) => /^\s*(con errores|failed)\s/i.test(line)).map((line) => line.trim().replace(/^.*MailProbes\./, ''));
  step('las sondas pasan contra el Mailpit real', tested.ok && total > 0, tested.ok ? `${total} sondas` : failures.join('; ') || 'sin resumen');
  if (!tested.ok) {
    const log = path.join(os.tmpdir(), `keel-dotnet-mail-check-${Date.now()}.log`);
    fs.writeFileSync(log, tested.output);
    console.error(`Salida completa de dotnet test en ${log}`);
  }
} catch (error) {
  if (!results.some((result) => !result.ok)) step('mail-check', false, error.message);
} finally {
  if (!keep) run(runtime, ['rm', '-f', container]);
  else console.log(`(contenedor conservado: ${container}, API en ${api})`);
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-mail-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Conservado en ${kept}`);
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nmail-check: ${results.length}/${results.length} en verde.` : `\nmail-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
