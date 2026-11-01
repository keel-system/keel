#!/usr/bin/env node
// El CORREO de keel-go (capa mail, 12e-b) contra un Mailpit REAL: el adaptador SMTP y el renderizador que emite build para
// notification-mailer-mongo, ejecutados por una prueba Go en su paquete (`internal/infrastructure/smtp`). Mide lo que solo
// ve un relay de verdad: las dos partes (multipart/alternative), el adjunto, el remitente de respaldo y el del dato, el
// Reply-To fijo, la cabecera propia, un cuerpo con acentos byte a byte, la tabla cerrada de escapes en el HTML, el asunto
// saneado, el rechazo PARCIAL (sale para los aceptados y se dice) y el total.
//
//   node packages/keel-go/scripts/mail-check.js [--sabotage=<id>] [--keep]
//   npm run mail-check --workspace packages/keel-go
//
// --sabotage=<id> rompe una defensa de lo emitido conservando que compile: verde = cae en exactamente sus sondas.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { IMAGE, HTTP_PORT, SMTP_PORT, SELECTIVE_REJECT_ENV, CHAOS_ENV, REJECTED_DOMAIN } from '@keel-system/keel-core/gen/mail-probes';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR, makeWorkspace } from '../test/helpers/workspace.js';
import { freePort, resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';

const SUBJECT = 'notification-mailer-mongo';
const keep = process.argv.includes('--keep');
const SABOTAGES = {
  // El asunto sin sanear: un salto de línea abre otra cabecera.
  subject: { file: 'internal/domain/mail.go', from: 'clean.Subject = strings.TrimSpace(mailLineBreaks.Replace(parts.Subject))', to: 'clean.Subject = parts.Subject', expect: /Subject/ },
  // El apóstrofo con la entidad de otro motor: el HTML deja de ser el del contrato.
  escape: { file: 'internal/infrastructure/smtp/renderer.go', from: `"'", "&#39;"`, to: `"'", "&apos;"`, expect: /Escape/ },
  // El primer destinatario rechazado aborta el envío: el parcial deja de salir para los aceptados.
  partial: {
    file: 'internal/infrastructure/smtp/sender.go',
    from: '\t\t\trejected = append(rejected, recipient)\n\t\t\tresponses = append(responses, err.Error())\n',
    to: '\t\t\treturn []string{recipient}, []string{err.Error()}, err\n',
    expect: /Partial/
  },
  // Sin el remitente de respaldo: un dato sin remitente deja de enviarse.
  fallback: { file: 'internal/infrastructure/smtp/sender.go', from: '\tfrom := s.settings.SenderFallback\n', to: '\tfrom := ""\n', expect: /Fallback/ }
};
const sabotageId = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const sabotage = sabotageId ? SABOTAGES[sabotageId] : null;
if (sabotageId && !sabotage) {
  console.error(`Sabotaje desconocido: ${sabotageId}. Los que hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime))) process.exit(1);

const root = makeWorkspace('keel-go-mail-check-');
const dir = path.join(root, SUBJECT);
const { files, model } = planService({ ...loadService(path.join(FIXTURES_DIR, SUBJECT)), workspace: FIXTURES_DIR });
for (const file of files) {
  const target = path.join(dir, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content);
}
if (sabotage) {
  const target = path.join(dir, sabotage.file);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(sabotage.from)) {
    console.error(`El sabotaje ${sabotageId} no se aplica: ${sabotage.file} ya no contiene lo que busca.`);
    process.exit(2);
  }
  fs.writeFileSync(target, text.replace(sabotage.from, sabotage.to));
  console.log(`(sabotaje: ${sabotageId})`);
}
const fallback = model.mail.sender.fallback;
fs.writeFileSync(path.join(dir, 'internal/infrastructure/smtp/mail_probe_test.go'), probeSource(fallback, model.service.goModule));

const smtpPort = await freePort();
const httpPort = await freePort();
const name = `keel-go-mail-check-${process.pid}`;
const env = Object.entries({ ...SELECTIVE_REJECT_ENV, ...CHAOS_ENV }).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const started = run(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${smtpPort}:${SMTP_PORT}`, '-p', `${httpPort}:${HTTP_PORT}`, ...env, IMAGE]);
if (!step(`Mailpit (${IMAGE}) en marcha`, started.ok, started.ok ? `SMTP ${smtpPort}, API ${httpPort}` : started.output)) process.exit(1);
try {
  const api = `http://127.0.0.1:${httpPort}/api/v1`;
  for (let i = 0; i < 60; i++) {
    if (run('curl', ['-sf', '-o', '/dev/null', `${api}/info`]).ok) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const tidy = run('go', ['mod', 'tidy'], { cwd: dir });
  if (!step('go mod tidy', tidy.ok, tidy.ok ? '' : tidy.output.slice(-1500))) process.exit(1);
  const binary = path.join(dir, process.platform === 'win32' ? 'mail-probe.test.exe' : 'mail-probe.test');
  const built = run('go', ['test', '-c', '-o', binary, './internal/infrastructure/smtp/'], { cwd: dir });
  if (!step('la prueba del correo compila', built.ok, built.ok ? '' : built.output.slice(-2000))) process.exit(1);
  const tested = await runAsync(binary, ['-test.count=1', '-test.v', '-test.run', 'Probe'], { cwd: path.join(dir, 'internal/infrastructure/smtp'), env: { ...process.env, MAIL_CHECK_SMTP: String(smtpPort), MAIL_CHECK_API: api } });
  const failed = [...tested.output.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]);
  const passed = [...tested.output.matchAll(/^\s*--- PASS: (\S+)/gm)].map((m) => m[1]);
  if (!sabotage) {
    step(`el adaptador SMTP y el renderizador contra Mailpit (${passed.length} sondas)`, tested.ok && passed.length > 0, failed.join(', ') || (tested.ok ? '' : tested.output.slice(-2000)));
    if (failed.length > 0) console.error(tested.output.split('\n').filter((line) => /_test\.go:\d+:|--- FAIL/.test(line)).slice(0, 30).join('\n'));
  } else {
    const expected = failed.filter((test) => sabotage.expect.test(test));
    const stray = failed.filter((test) => !sabotage.expect.test(test));
    step(`falsado: ${sabotageId} → ${expected.length > 0 ? `rojo en ${expected.join(', ')}` : 'ninguna sonda lo ve'}`, expected.length > 0 && stray.length === 0, stray.length > 0 ? `caen además ${stray.join(', ')}` : '');
  }
} finally {
  if (keep) console.log(`\nMailpit sigue en marcha (${name}); sujeto en ${dir}`);
  else run(runtime, ['rm', '-f', name]);
}

const failedSteps = results.filter((result) => !result.ok).length;
console.log(failedSteps === 0 ? `\nmail-check: ${results.length}/${results.length} en verde.` : `\nmail-check: ${failedSteps} paso(s) en rojo.`);
process.exitCode = failedSteps === 0 ? 0 : 1;

function runAsync(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ ok: status === 0, output }));
  });
}

/** La prueba Go: el adaptador y el renderizador emitidos, y lo que llega al buzón leído por su API. */
function probeSource(fallbackSender, module) {
  return `package smtp_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"${module}/internal/domain"
	"${module}/internal/infrastructure/smtp"
)

func settings(t *testing.T) smtp.Settings {
	t.Helper()
	port, err := strconv.Atoi(os.Getenv("MAIL_CHECK_SMTP"))
	if err != nil {
		t.Fatal(err)
	}
	return smtp.Settings{Host: "127.0.0.1", Port: port, ConnectTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, SenderFallback: ${JSON.stringify(fallbackSender ?? '')}, ReplyTo: "soporte@ejemplo.com"}
}

func ptr(s string) *string { return &s }

func send(t *testing.T, parts domain.MailParts) error {
	t.Helper()
	message, err := domain.NewMailMessage(parts)
	if err != nil {
		t.Fatalf("NewMailMessage: %v", err)
	}
	return smtp.NewSender(settings(t), slog.New(slog.DiscardHandler)).Send(context.Background(), message)
}

// last es el último correo para address, entero (lo espera hasta 10 s).
func last(t *testing.T, address string) map[string]any {
	t.Helper()
	api := os.Getenv("MAIL_CHECK_API")
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		var found struct {
			Messages []struct{ ID string } \`json:"messages"\`
		}
		get(t, api+"/search?query="+url.QueryEscape("to:"+address), &found)
		if len(found.Messages) > 0 {
			var message map[string]any
			get(t, api+"/message/"+found.Messages[0].ID, &message)
			return message
		}
	}
	t.Fatalf("no llegó ningún correo para %s", address)
	return nil
}

func get(t *testing.T, target string, out any) {
	t.Helper()
	response, err := http.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, out); err != nil {
		t.Fatalf("%s: %v (%s)", target, err, body)
	}
}

func text(message map[string]any, field string) string {
	value, _ := message[field].(string)
	return value
}

func TestProbeBodyPartsAttachmentReplyToAndHeader(t *testing.T) {
	to := "partes-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@keel.test"
	err := send(t, domain.MailParts{To: []string{to}, Subject: "Partes", HTML: ptr("<p>Ñandú café</p>"), Text: ptr("Ñandú café"), From: ptr("remitente@ejemplo.com"),
		Headers: map[string]string{"X-Keel-Envio": "envio-1"}, Attachments: []domain.MailAttachment{{Filename: "nota.txt", ContentType: "text/plain", Content: []byte("adjunto")}}})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	message := last(t, to)
	if text(message, "HTML") != "<p>Ñandú café</p>" || text(message, "Text") != "Ñandú café" {
		t.Errorf("las dos partes no llegan byte a byte: HTML=%q Text=%q", text(message, "HTML"), text(message, "Text"))
	}
	if attachments, _ := message["Attachments"].([]any); len(attachments) != 1 {
		t.Errorf("llegan %d adjuntos, no 1", len(attachments))
	}
	if from, _ := message["From"].(map[string]any); from["Address"] != "remitente@ejemplo.com" {
		t.Errorf("el remitente del dato no manda: %v", from)
	}
	if replies, _ := message["ReplyTo"].([]any); len(replies) != 1 || replies[0].(map[string]any)["Address"] != "soporte@ejemplo.com" {
		t.Errorf("Reply-To = %v", message["ReplyTo"])
	}
	var headers map[string][]string
	get(t, os.Getenv("MAIL_CHECK_API")+"/message/"+message["ID"].(string)+"/headers", &headers)
	if len(headers["X-Keel-Envio"]) != 1 || headers["X-Keel-Envio"][0] != "envio-1" {
		t.Errorf("la cabecera propia no llega: %v", headers["X-Keel-Envio"])
	}
}

func TestProbeFallbackSender(t *testing.T) {
	to := "respaldo-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@keel.test"
	if err := send(t, domain.MailParts{To: []string{to}, Subject: "Respaldo", Text: ptr("x"), HTML: ptr("x")}); err != nil {
		t.Fatalf("sin remitente del dato, el de respaldo: %v", err)
	}
	if from, _ := last(t, to)["From"].(map[string]any); from["Address"] != ${JSON.stringify(fallbackSender ?? '')} {
		t.Errorf("el remitente de respaldo no manda: %v", from)
	}
}

func TestProbeSubjectSanitized(t *testing.T) {
	to := "asunto-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@keel.test"
	if err := send(t, domain.MailParts{To: []string{to}, Subject: "Hola\\r\\nBcc: intruso@ejemplo.com", Text: ptr("x"), HTML: ptr("x"), From: ptr("a@ejemplo.com")}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	message := last(t, to)
	// Cada salto de línea pasa a un espacio, como en keel-dotnet: con CR y LF quedan dos.
	if text(message, "Subject") != "Hola  Bcc: intruso@ejemplo.com" {
		t.Errorf("el asunto no se sanea: %q", text(message, "Subject"))
	}
	if bcc, _ := message["Bcc"].([]any); len(bcc) > 0 {
		t.Errorf("el asunto inyectó un Bcc: %v", bcc)
	}
}

func TestProbeEscapeTableInTheMailbox(t *testing.T) {
	to := "escape-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@keel.test"
	html, err := smtp.NewRenderer().Render(domain.TemplateHTML, "escape:1", "<p>{{name}}</p>", map[string]any{"name": \`O'Hara & "<b>"\`})
	if err != nil {
		t.Fatal(err)
	}
	if err := send(t, domain.MailParts{To: []string{to}, Subject: "Escape", HTML: &html, Text: ptr("x"), From: ptr("a@ejemplo.com")}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if got := text(last(t, to), "HTML"); got != "<p>O&#39;Hara &amp; &quot;&lt;b&gt;&quot;</p>" {
		t.Errorf("el HTML del buzón no lleva la tabla del contrato: %q", got)
	}
}

func TestProbePartialRejectionIsSaid(t *testing.T) {
	accepted := "parcial-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@keel.test"
	rejected := "rechazo@${REJECTED_DOMAIN}"
	err := send(t, domain.MailParts{To: []string{accepted, rejected}, Subject: "Parcial", Text: ptr("x"), HTML: ptr("x"), From: ptr("a@ejemplo.com")})
	var delivery *domain.MailDeliveryError
	if !errors.As(err, &delivery) || !delivery.Partial() || len(delivery.Rejected) != 1 || !strings.EqualFold(delivery.Rejected[0], rejected) {
		t.Fatalf("el envío parcial no se dice: %v", err)
	}
	last(t, accepted)
}

func TestProbeTotalRejection(t *testing.T) {
	err := send(t, domain.MailParts{To: []string{"nadie@${REJECTED_DOMAIN}"}, Subject: "Total", Text: ptr("x"), HTML: ptr("x"), From: ptr("a@ejemplo.com")})
	var delivery *domain.MailDeliveryError
	if !errors.As(err, &delivery) || delivery.Partial() {
		t.Errorf("el rechazo total sale %v", err)
	}
}
`;
}
