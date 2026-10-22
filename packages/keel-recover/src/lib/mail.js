import { ROUTES } from 'keel-core/gen/mail-probes';
import { toolRequest } from './tool-http.js';

// El correo del legacy, recogido por Mailpit (paso 1b). Las rutas de su API son las del
// vocabulario que comparten los arneses de los generadores (keel-core/gen/mail-probes.js). El
// canario sale por SMTP, con curl, hacia el MISMO host:puerto con el que envía el legacy
// (`mail.smtp`): si ese no es el buzón que se lee, el canario falta y el canal sale en rojo.

export const CANARY_SUBJECT = 'keel-recover canary ';
const CANARY_FROM = 'keel-recover@canary.invalid';
const CANARY_TO = 'canary@keel-recover.invalid';
export const MAILBOX_LIMIT = 500;

const api = (mail, p) => `${mail.api.replace(/\/$/, '')}${p}`;

export function clearMail(rt, tool, mail) {
  const r = toolRequest(rt, tool, { method: 'DELETE', url: api(mail, ROUTES.messages()) });
  return r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, error: `vaciar el buzón: ${r.status || 'sin respuesta'}` };
}

export function sendCanary(rt, tool, mail, tag) {
  const message = `From: ${CANARY_FROM}\r\nTo: ${CANARY_TO}\r\nSubject: ${CANARY_SUBJECT}${tag}\r\n\r\ncanario ${tag}\r\n`;
  const r = rt.exec(tool, ['curl', '-sS', '-m', '10', `smtp://${mail.smtp}`, '--mail-from', CANARY_FROM, '--mail-rcpt', CANARY_TO, '-T', '-'], { input: message });
  return r.status === 0 ? { ok: true } : { ok: false, error: `el canario no salió por smtp://${mail.smtp}: ${(r.stderr || '').trim().slice(-160)}` };
}

const addresses = (list) => (list ?? []).map((a) => a.Address).filter(Boolean);

/** El buzón en orden de llegada, con el cuerpo de cada mensaje (el listado solo trae el resumen). */
export function readMail(rt, tool, mail) {
  const list = toolRequest(rt, tool, { method: 'GET', url: api(mail, `${ROUTES.messages()}?limit=${MAILBOX_LIMIT}`) });
  if (list.status !== 200 || !Array.isArray(list.body?.messages)) return { ok: false, error: `leer el buzón: ${list.status || 'sin respuesta'} ${JSON.stringify(list.body ?? '').slice(0, 160)}` };
  if ((list.body.messages_count ?? list.body.total ?? 0) > MAILBOX_LIMIT) return { ok: false, error: `más de ${MAILBOX_LIMIT} correos en una sonda: no se leen enteros` };
  const out = [];
  for (const m of [...list.body.messages].reverse()) {
    const full = toolRequest(rt, tool, { method: 'GET', url: api(mail, ROUTES.message(m.ID)) });
    if (full.status !== 200) return { ok: false, error: `leer el correo ${m.ID}: ${full.status}` };
    out.push(mailEntry(full.body));
  }
  return { ok: true, value: out };
}

export function mailEntry(m) {
  const out = {
    from: m.From?.Address ?? null,
    to: addresses(m.To),
    subject: m.Subject ?? '',
    text: (m.Text ?? '').replace(/\r\n/g, '\n').trimEnd(),
  };
  if (addresses(m.Cc).length) out.cc = addresses(m.Cc);
  if (addresses(m.Bcc).length) out.bcc = addresses(m.Bcc);
  if (m.HTML) out.html = m.HTML;
  if ((m.Attachments ?? []).length) out.attachments = m.Attachments.map((a) => ({ name: a.FileName, type: a.ContentType, size: a.Size }));
  if (out.subject.startsWith(CANARY_SUBJECT)) out.canary = out.subject.slice(CANARY_SUBJECT.length);
  return out;
}
