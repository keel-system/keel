// La capa `mail` (adelantada del incremento 13 al 12e-b): el reparto de keel-spring, keel-nest y keel-dotnet —build genera
// TAMBIÉN el adaptador y el renderizador, porque lo que llevan dentro son dos defensas cuya ausencia no rompe ninguna
// prueba—.
//
//   · `internal/domain/mail.go` — el mensaje (MailMessage, que sanea asunto y cabeceras al construirse con las reservadas
//     de keel-core/gen/mail-message.js), el fallo de entrega (MailDeliveryError, con quién lo recibió y a quién se rechazó:
//     un envío PARCIAL es un correo que salió) y los dos puertos, MailSender y TemplateRenderer;
//   · `internal/infrastructure/smtp` — el adaptador sobre go-mail: compone el MIME con su Msg y habla SMTP destinatario a
//     destinatario con su paquete smtp, apuntando el rechazado en vez de abortar (el Send de go-mail aborta el envío entero
//     con el primero, y entonces el parcial no se podría decir); y el renderizador Handlebars sobre raymond, con la tabla
//     CERRADA de escapes de keel-core (las variables viajan ya escapadas como SafeString), los marcadores simples como
//     segmento literal (`{{this.[x]}}`) y el LRU de COMPILED_TEMPLATES_LIMIT;
//   · `config/parameters/<perfil>/mail.yaml` — las variables MAIL_* de keel-spring;
//   · la guarda contra el doble envío `ClaimFor<Op>` (el `guardClaim` de keel-core) en el puerto y en los dos adaptadores,
//     con transacción PROPIA: un correo que sale no lo deshace ningún rollback.

import { RESERVED_MAIL_HEADERS, MAIL_HEADER_NAME_CLASS, HTML_ESCAPES, COMPILED_TEMPLATES_LIMIT } from '@keel-system/keel-core/gen/mail-message';
import { envFor } from '@keel-system/keel-core/gen/runtime-env';
import { sendsMail, usesDocument, usesMail } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { domainPath, layout, packageFile } from './render.js';
import { usesDependencies } from './use-cases.js';
import { storedState } from './claim.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { snakeCase } from '@keel-system/keel-core/gen';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** El paquete smtp de go-mail se importa con otro nombre: el del adaptador también se llama smtp. */
const GOMAIL_SMTP = { path: 'github.com/wneessen/go-mail/smtp', name: 'gomailsmtp' };

/** ¿Se genera el correo? Con la capa y con los casos de uso cableados (la guarda va en el repositorio). */
export function usesGoMail(model) {
  return usesMail(model) && usesDependencies(model);
}

/** ¿Hay plantillas que renderizar? */
export function usesTemplating(model) {
  return usesGoMail(model) && Boolean(model.mail.templating);
}

/** Los campos de Dependencies y los parámetros del handler que manda correo. */
export const MAIL_SENDER = { field: 'MailSender', param: 'mailSender', port: 'domain.MailSender' };
export const TEMPLATE_RENDERER = { field: 'TemplateRenderer', param: 'templateRenderer', port: 'domain.TemplateRenderer' };

/** Lo que recibe el handler de una operación de mail.sentBy. */
export function mailDependencies(model, operation) {
  if (!usesGoMail(model) || !sendsMail(model, operation)) return [];
  return [MAIL_SENDER, ...(usesTemplating(model) ? [TEMPLATE_RENDERER] : [])];
}

export function generate(model) {
  if (!usesGoMail(model)) return [];
  const { domain, mail } = layout(model);
  const files = [
    { path: domainPath(model, 'Mail'), content: packageFile(model, domain, { imports: ['context', 'regexp', 'slices', 'strings', 'maps'], body: domainBody(model) }) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/mail.yaml`, content: mailYaml(model, profile) })),
    {
      path: `${mail.dir}/doc.go`,
      content: packageFile(model, mail, { doc: `Package ${mail.name} es la salida de correo del servicio: el adaptador SMTP de domain.MailSender y el renderizador\nHandlebars de domain.TemplateRenderer.`, body: '' })
    },
    { path: `${mail.dir}/settings.go`, content: packageFile(model, mail, { imports: ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], body: settingsBody(model) }) },
    {
      path: `${mail.dir}/sender.go`,
      content: packageFile(model, mail, {
        imports: ['bytes', 'context', 'crypto/tls', 'errors', 'log/slog', 'maps', 'net', 'slices', 'strconv', 'strings', 'time', 'github.com/wneessen/go-mail', GOMAIL_SMTP, 'internal/domain'],
        body: senderBody(model)
      })
    }
  ];
  if (usesTemplating(model)) {
    files.push({ path: `${mail.dir}/renderer.go`, content: packageFile(model, mail, { imports: ['container/list', 'fmt', 'regexp', 'strings', 'sync', 'github.com/mailgun/raymond/v2', 'internal/domain'], body: rendererBody() }) });
    files.push({ path: `${mail.dir}/renderer_test.go`, content: packageFile(model, mail, { test: true, imports: ['testing', mail.dir, 'internal/domain'], body: rendererTest(mail) }) });
  }
  return files;
}

// ─── El dominio ──────────────────────────────────────────────────────────────────────────────────

function domainBody(model) {
  const mail = model.mail;
  const attachments = mail.attachments;
  return `
// MailAttachment es un archivo adjunto. Viaja en base64, que infla un 33%: el límite de tamaño del proveedor se cuenta sobre
// el mensaje YA codificado, no sobre el fichero.
type MailAttachment struct {
	Filename    string
	ContentType string
	Content     []byte
}

// MailParts son las partes con las que se compone un MailMessage.
type MailParts struct {
	// To son los destinatarios; al menos uno para que salga.
	To []string
	// Cc son las copias.
	Cc []string
	// Subject es el asunto ya interpolado; se sanea al construir.
	Subject string
	// HTML es el cuerpo HTML${mail.hasHtml ? '' : ' (el diseño no lo declara: se ignora)'}.
	HTML *string
	// Text es el cuerpo en texto plano${mail.hasText ? '' : ' (el diseño no lo declara: se ignora)'}.
	Text *string
	// From es el remitente${mail.sender.source === 'data' ? ' (sale de un dato del servicio; nil para el de respaldo)' : ' (lo pone la configuración: el diseño lo fija)'}.
	From *string
	// ReplyTo es la dirección de respuesta, o nil para que se responda al remitente.
	ReplyTo *string
	// Headers son cabeceras propias (un X-… con el id del envío, que el proveedor devuelve con el rebote).
	Headers map[string]string${attachments ? '\n\t// Attachments son los adjuntos.\n\tAttachments []MailAttachment' : ''}
}

// MailMessage es un correo listo para salir: destinatarios, asunto y cuerpo ya renderizados. Es un value object de
// DOMINIO: quien decide qué correo sale es el caso de uso, y lo compone sin conocer el transporte.
//
// EL ASUNTO Y LAS CABECERAS SE SANEAN AL CONSTRUIRLO, no en el adaptador: un \\r o un \\n en el asunto permite inyectar
// cabeceras SMTP —un Bcc que nadie puso—, y hacerlo aquí significa que ningún camino construye un mensaje sin sanear.
type MailMessage struct {
	parts MailParts
}

// reservedMailHeaders son las cabeceras que el propio mensaje gobierna con sus campos, o que compone el transporte
// (keel-core/gen/mail-message.js): una propia con uno de esos nombres duplicaría o pisaría lo que dice el resto.
var reservedMailHeaders = []string{${RESERVED_MAIL_HEADERS.map(goString).join(', ')}}

// mailHeaderName es un nombre de cabecera (RFC 5322): imprimibles sin espacio ni dos puntos.
var mailHeaderName = regexp.MustCompile(${goString(`^${MAIL_HEADER_NAME_CLASS}$`)})

// mailLineBreaks son los saltos de línea que se neutralizan en el asunto y en el valor de una cabecera.
var mailLineBreaks = strings.NewReplacer("\\r", " ", "\\n", " ")

// NewMailMessage construye el mensaje: sanea el asunto y el valor de cada cabecera, y rechaza el NOMBRE de una cabecera
// malformada o reservada (es un error de quien compone el mensaje, no un dato que arreglar).
func NewMailMessage(parts MailParts) (MailMessage, error) {
	clean := parts
	clean.To = slices.Clone(parts.To)
	clean.Cc = slices.Clone(parts.Cc)
	clean.Subject = strings.TrimSpace(mailLineBreaks.Replace(parts.Subject))
	clean.Headers = make(map[string]string, len(parts.Headers))
	for name, value := range parts.Headers {
		if !mailHeaderName.MatchString(name) {
			return MailMessage{}, Errorf(ErrInvalidValue, "Nombre de cabecera no válido: %s", name)
		}
		lower := strings.ToLower(name)
		if slices.Contains(reservedMailHeaders, lower) || strings.HasPrefix(lower, "content-") {
			return MailMessage{}, Errorf(ErrInvalidValue, "La cabecera %s la compone el propio mensaje", name)
		}
		clean.Headers[name] = strings.TrimSpace(mailLineBreaks.Replace(value))
	}${attachments ? '\n\tclean.Attachments = slices.Clone(parts.Attachments)' : ''}
	return MailMessage{parts: clean}, nil
}

// To son los destinatarios.
func (m MailMessage) To() []string { return slices.Clone(m.parts.To) }

// Cc son las copias.
func (m MailMessage) Cc() []string { return slices.Clone(m.parts.Cc) }

// Subject es el asunto, ya saneado.
func (m MailMessage) Subject() string { return m.parts.Subject }

// HTML es el cuerpo HTML, o nil.
func (m MailMessage) HTML() *string { return m.parts.HTML }

// Text es el cuerpo en texto, o nil.
func (m MailMessage) Text() *string { return m.parts.Text }

// From es el remitente, o nil.
func (m MailMessage) From() *string { return m.parts.From }

// ReplyTo es la dirección de respuesta, o nil.
func (m MailMessage) ReplyTo() *string { return m.parts.ReplyTo }

// Headers son las cabeceras propias, ya validadas y saneadas.
func (m MailMessage) Headers() map[string]string { return maps.Clone(m.parts.Headers) }${attachments ? '\n\n// Attachments son los adjuntos.\nfunc (m MailMessage) Attachments() []MailAttachment { return slices.Clone(m.parts.Attachments) }' : ''}

// MailDeliveryError es que el proveedor no aceptó el mensaje, o no lo aceptó para TODOS los destinatarios.
//
// UN FALLO PUEDE SER PARCIAL, y el caso de uso tiene que poder distinguirlo: si el relay rechaza a un destinatario y acepta
// a otro, el correo SALE para los aceptados y aun así se devuelve este error. Tratarlo como «no salió» repetiría o daría
// por fallido un envío que ya llegó. Es el MailDeliveryException de keel-spring, keel-nest y keel-dotnet.
type MailDeliveryError struct {
	// Reason es qué pasó, en palabras.
	Reason string
	// Accepted son los destinatarios que sí lo recibieron (vacío sin envío parcial).
	Accepted []string
	// Rejected son los destinatarios que el relay rechazó.
	Rejected []string
	// Detail es la respuesta del relay.
	Detail string
	// Cause es el fallo del transporte, si lo hubo.
	Cause error
}

// Error implementa error.
func (e *MailDeliveryError) Error() string {
	if e.Detail != "" {
		return e.Reason + ": " + e.Detail
	}
	return e.Reason
}

// Unwrap es el fallo del transporte.
func (e *MailDeliveryError) Unwrap() error { return e.Cause }

// Partial dice si el correo salió para alguno: es la pregunta que decide el desenlace del envío.
func (e *MailDeliveryError) Partial() bool { return len(e.Accepted) > 0 }

// MailSender es la salida de correo del servicio: lo invocan los handlers de ${mail.sentBy.join(', ')} (mail.sentBy) y lo
// implementa el adaptador SMTP. Lo que NO promete: que el correo llegue a la bandeja; promete que se entregó al proveedor.
type MailSender interface {
	// Send entrega el mensaje al proveedor, o devuelve un *MailDeliveryError. Un error y no un booleano a propósito: un
	// envío que falla en silencio es un correo que nadie recibe y del que nadie se entera.
	Send(ctx context.Context, message MailMessage) error
}${
    model.mail.templating
      ? `

// TemplatePart es la parte del correo que se renderiza: decide el escapado de las variables.
type TemplatePart int

// Las partes de un correo.
const (
	// TemplateSubject es el asunto: sin escapado (los saltos de línea los neutraliza MailMessage).
	TemplateSubject TemplatePart = iota
	// TemplateText es el cuerpo en texto: sin escapado.
	TemplateText
	// TemplateHTML es el cuerpo HTML: las variables se escapan con la tabla cerrada del contrato.
	TemplateHTML
)

// TemplateRenderer interpola una plantilla con las variables de un envío. ${
          model.mail.templating.externalContent
            ? 'El cuerpo de la plantilla es un DATO del servicio, lo escribe alguien que puede\n// ser ajeno al equipo: el motor no evalúa expresiones arbitrarias, solo marcadores y bloques.'
            : 'El cuerpo viaja con el código, versionado en el repositorio.'
        }
type TemplateRenderer interface {
	// Render renderiza source con variables. cacheKey es la identidad estable de la plantilla (clave y versión), con la
	// que se cachea la compilación: dos contenidos distintos no pueden compartirla. Un error si no compila o falla.
	Render(part TemplatePart, cacheKey, source string, variables map[string]any) (string, error)
	// Compile comprueba que source compila, SIN cachearla: lo que usa la operación que da de alta una plantilla para
	// rechazarla antes de guardarla.
	Compile(source string) error
}`
      : ''
  }
`;
}

// ─── mail.yaml ───────────────────────────────────────────────────────────────────────────────────

/** config/parameters/<perfil>/mail.yaml: las mismas variables y defaults que el de keel-spring, keel-nest y keel-dotnet. */
export function mailYaml(model, profile) {
  const mail = model.mail;
  const localish = profile === 'local' || profile === 'test';
  const scalar = (text) => (text === '' ? "''" : text);
  const lines = ['mail:', `  host: ${envFor('MAIL_HOST', profile)}`, `  port: ${envFor('MAIL_PORT', profile)}`, `  username: ${scalar(envFor('MAIL_USERNAME', profile))}`, `  password: ${scalar(envFor('MAIL_PASSWORD', profile))}`, '  smtp:'];
  if (localish) lines.push('    auth: false', '    starttls: false');
  else lines.push(`    auth: ${envFor('MAIL_SMTP_AUTH', profile)}`, `    starttls: ${envFor('MAIL_SMTP_STARTTLS', profile)}`);
  lines.push(
    '    # Un envío esperando a un proveedor caído retiene a quien lo hace: sin plazos esperaría para siempre.',
    `    connect-timeout-ms: ${envFor('MAIL_CONNECT_TIMEOUT_MS', profile)}`,
    `    read-timeout-ms: ${envFor('MAIL_READ_TIMEOUT_MS', profile)}`,
    `    write-timeout-ms: ${envFor('MAIL_WRITE_TIMEOUT_MS', profile)}`
  );
  if (mail.sender?.source === 'fixed') lines.push(`  sender: ${envFor('MAIL_SENDER', profile, mail.sender.address)}`);
  else if (mail.sender?.fallback) lines.push('  # Remitente de respaldo: se usa cuando el dato del servicio no lo resuelve.', `  sender-fallback: ${envFor('MAIL_SENDER_FALLBACK', profile, mail.sender.fallback)}`);
  if (mail.replyTo?.source === 'fixed') lines.push(`  reply-to: ${envFor('MAIL_REPLY_TO', profile, mail.replyTo.address)}`);
  return `${lines.join('\n')}\n`;
}

// ─── settings.go ─────────────────────────────────────────────────────────────────────────────────

function settingsBody() {
  return `
// Settings es lo que el adaptador SMTP lee de config/parameters/<perfil>/mail.yaml (las variables de keel-spring).
type Settings struct {
	Host     string
	Port     int
	Username string
	Password string
	// Auth y Starttls los exige la configuración fuera de local y test (Mailpit no los ofrece).
	Auth     bool
	Starttls bool
	// ConnectTimeout, ReadTimeout y WriteTimeout son los plazos de la conversación con el relay.
	ConnectTimeout time.Duration
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
	// Sender es el remitente fijo (mail.sender.source: fixed), o "".
	Sender string
	// SenderFallback es el remitente de respaldo cuando el dato del servicio no lo resuelve, o "".
	SenderFallback string
	// ReplyTo es el Reply-To fijo (mail.replyTo.source: fixed), o "".
	ReplyTo string
}

// SettingsFrom lee mail.* de la configuración del perfil. Un número que no se entiende no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key, fallback string) string {
		if value, ok := cfg.Value(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}
	number := func(key string, fallback int) (int, error) {
		value := text(key, "")
		if value == "" {
			return fallback, nil
		}
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 {
			return 0, fmt.Errorf("%s tiene que ser un número no negativo: %q", key, value)
		}
		return parsed, nil
	}
	s := Settings{
		Host:           text("mail.host", "localhost"),
		Username:       text("mail.username", ""),
		Password:       text("mail.password", ""),
		Auth:           !strings.EqualFold(text("mail.smtp.auth", "true"), "false"),
		Starttls:       !strings.EqualFold(text("mail.smtp.starttls", "true"), "false"),
		Sender:         text("mail.sender", ""),
		SenderFallback: text("mail.sender-fallback", ""),
		ReplyTo:        text("mail.reply-to", ""),
	}
	var err error
	if s.Port, err = number("mail.port", 1025); err != nil {
		return Settings{}, err
	}
	for _, timeout := range []struct {
		key    string
		target *time.Duration
	}{
		{"mail.smtp.connect-timeout-ms", &s.ConnectTimeout},
		{"mail.smtp.read-timeout-ms", &s.ReadTimeout},
		{"mail.smtp.write-timeout-ms", &s.WriteTimeout},
	} {
		ms, err := number(timeout.key, 5000)
		if err != nil {
			return Settings{}, err
		}
		*timeout.target = time.Duration(ms) * time.Millisecond
	}
	return s, nil
}
`;
}

// ─── sender.go ───────────────────────────────────────────────────────────────────────────────────

function senderBody(model) {
  const mail = model.mail;
  const resolveFrom =
    mail.sender.source === 'fixed'
      ? '\tfrom := s.settings.Sender'
      : mail.sender.fallback
        ? `	// El dato manda; el respaldo solo entra cuando no lo resuelve. Sin respaldo declarado el diseño prefiere NO enviar antes
	// que enviar desde una dirección que nadie verificó ante el proveedor.
	from := s.settings.SenderFallback
	if value := message.From(); value != nil && strings.TrimSpace(*value) != "" {
		from = *value
	}`
        : `	from := ""
	if value := message.From(); value != nil {
		from = *value
	}`;
  const replyTo =
    mail.replyTo?.source === 'fixed'
      ? `	if s.settings.ReplyTo != "" {
		if err := msg.ReplyTo(s.settings.ReplyTo); err != nil {
			return &domain.MailDeliveryError{Reason: "El Reply-To no es una dirección válida", Cause: err, Detail: err.Error()}
		}
	}`
      : mail.replyTo
        ? `	if value := message.ReplyTo(); value != nil && *value != "" {
		if err := msg.ReplyTo(*value); err != nil {
			return &domain.MailDeliveryError{Reason: "El Reply-To no es una dirección válida", Cause: err, Detail: err.Error()}
		}
	}`
        : '';
  const body = mail.multipart
    ? `	// multipart/alternative con las dos partes: los filtros antispam desconfían de un HTML sin alternativa textual.
	msg.SetBodyString(mail.TypeTextPlain, valueOf(message.Text()))
	msg.AddAlternativeString(mail.TypeTextHTML, valueOf(message.HTML()))`
    : mail.hasHtml
      ? '\tmsg.SetBodyString(mail.TypeTextHTML, valueOf(message.HTML()))'
      : '\tmsg.SetBodyString(mail.TypeTextPlain, valueOf(message.Text()))';
  const attachments = mail.attachments
    ? `
	for _, attachment := range message.Attachments() {
		if err := msg.AttachReader(attachment.Filename, bytes.NewReader(attachment.Content), mail.WithFileContentType(mail.ContentType(attachment.ContentType))); err != nil {
			return &domain.MailDeliveryError{Reason: "El adjunto no se pudo componer", Cause: err, Detail: err.Error()}
		}
	}`
    : '';
  return `
// Sender entrega el correo por SMTP: el mismo adaptador en local (contra el Mailpit de infra/) y en producción (contra el
// proveedor contratado). Solo cambian los parámetros de mail.yaml, así que cambiar de proveedor es cambiar variables de
// entorno y reiniciar. El saneado del asunto NO está aquí: vive en domain.NewMailMessage.
type Sender struct {
	settings Settings
	logger   *slog.Logger
}

var _ domain.MailSender = (*Sender)(nil)

// NewSender construye el adaptador con la configuración del perfil.
func NewSender(settings Settings, logger *slog.Logger) *Sender {
	return &Sender{settings: settings, logger: logger}
}

// Send implementa domain.MailSender. Compone el MIME con go-mail y habla SMTP destinatario a destinatario: un rechazado se
// apunta y se sigue con los demás, para que el correo salga para los aceptados y el envío parcial se pueda decir.
func (s *Sender) Send(ctx context.Context, message domain.MailMessage) error {
${resolveFrom}
	if strings.TrimSpace(from) == "" {
		return &domain.MailDeliveryError{Reason: "El mensaje no tiene remitente y el diseño no declara uno de respaldo: no se envía"}
	}
	recipients := slices.Concat(message.To(), message.Cc())
	if len(message.To()) == 0 {
		return &domain.MailDeliveryError{Reason: "El mensaje no tiene destinatarios: no se envía"}
	}
	msg := mail.NewMsg()
	if err := msg.From(from); err != nil {
		return &domain.MailDeliveryError{Reason: "El remitente no es una dirección válida", Cause: err, Detail: err.Error()}
	}
	if err := msg.To(message.To()...); err != nil {
		return &domain.MailDeliveryError{Reason: "Un destinatario no es una dirección válida", Cause: err, Detail: err.Error()}
	}
	if cc := message.Cc(); len(cc) > 0 {
		if err := msg.Cc(cc...); err != nil {
			return &domain.MailDeliveryError{Reason: "Una copia no es una dirección válida", Cause: err, Detail: err.Error()}
		}
	}
${replyTo}${replyTo ? '\n' : ''}	msg.Subject(message.Subject())
	msg.SetDate()
	msg.SetMessageID()
	// Cabeceras propias, en orden estable: nombre y valor ya vienen validados y saneados por el mensaje.
	headers := message.Headers()
	names := slices.Sorted(maps.Keys(headers))
	for _, name := range names {
		msg.SetGenHeader(mail.Header(name), headers[name])
	}
${body}${attachments}
	var content bytes.Buffer
	if _, err := msg.WriteTo(&content); err != nil {
		return &domain.MailDeliveryError{Reason: "El mensaje no se pudo componer", Cause: err, Detail: err.Error()}
	}
	rejected, responses, err := s.deliver(ctx, from, recipients, content.Bytes())
	if err != nil {
		// Un envío que falla en silencio es un correo que nadie recibe: se devuelve, con a quién se rechazó.
		return &domain.MailDeliveryError{Reason: "El proveedor no aceptó el mensaje", Rejected: rejected, Detail: detailOf(err, responses), Cause: err}
	}
	if len(rejected) > 0 {
		// Envío PARCIAL: el relay entregó a unos y rechazó a otros. El correo SALIÓ para los aceptados, y aun así se devuelve.
		accepted := slices.DeleteFunc(slices.Clone(recipients), func(address string) bool {
			return slices.ContainsFunc(rejected, func(other string) bool { return strings.EqualFold(other, address) })
		})
		return &domain.MailDeliveryError{Reason: "El proveedor rechazó a parte de los destinatarios", Accepted: accepted, Rejected: rejected, Detail: strings.Join(responses, "; ")}
	}
	s.logger.InfoContext(ctx, "correo entregado al proveedor", "recipients", len(recipients), "subject", message.Subject())
	return nil
}

// errAllRejected es que el relay rechazó a todos los destinatarios: no hay a quién entregar.
var errAllRejected = errors.New("el relay rechazó a todos los destinatarios")

// deliver es la conversación SMTP: conecta con su plazo, STARTTLS y autenticación si la configuración los pide, y
// entrega el contenido a los destinatarios que el relay acepte. Devuelve los rechazados y sus respuestas.
func (s *Sender) deliver(ctx context.Context, from string, recipients []string, content []byte) (rejected, responses []string, err error) {
	dialer := net.Dialer{Timeout: s.settings.ConnectTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(s.settings.Host, strconv.Itoa(s.settings.Port)))
	if err != nil {
		return nil, nil, err
	}
	// Un relay que se queda callado retiene a quien envía: la conversación entera tiene su plazo.
	if err := conn.SetDeadline(time.Now().Add(max(s.settings.ReadTimeout, s.settings.WriteTimeout) + s.settings.ConnectTimeout)); err != nil {
		return nil, nil, errors.Join(err, conn.Close())
	}
	client, err := gomailsmtp.NewClient(conn, s.settings.Host)
	if err != nil {
		return nil, nil, errors.Join(err, conn.Close())
	}
	defer func() {
		// Cerrar tras QUIT es liberar el socket; un error aquí ya no cambia el desenlace del envío.
		_ = client.Close()
	}()
	if s.settings.Starttls {
		if err := client.StartTLS(&tls.Config{ServerName: s.settings.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return nil, nil, err
		}
	}
	if s.settings.Auth && s.settings.Username != "" {
		if err := client.Auth(gomailsmtp.PlainAuth("", s.settings.Username, s.settings.Password, s.settings.Host, false)); err != nil {
			return nil, nil, err
		}
	}
	// El paquete smtp de go-mail escribe la dirección tal cual: los corchetes del protocolo los pone quien llama.
	if err := client.Mail("<" + from + ">"); err != nil {
		return nil, nil, err
	}
	for _, recipient := range recipients {
		if err := client.Rcpt("<" + recipient + ">"); err != nil {
			rejected = append(rejected, recipient)
			responses = append(responses, err.Error())
		}
	}
	if len(rejected) == len(recipients) {
		return rejected, responses, errAllRejected
	}
	writer, err := client.Data()
	if err != nil {
		return rejected, responses, err
	}
	if _, err := writer.Write(content); err != nil {
		return rejected, responses, errors.Join(err, writer.Close())
	}
	if err := writer.Close(); err != nil {
		return rejected, responses, err
	}
	return rejected, responses, client.Quit()
}

// detailOf es la respuesta del relay de un fallo.
func detailOf(err error, responses []string) string {
	if len(responses) > 0 {
		return strings.Join(responses, "; ")
	}
	return err.Error()
}

// valueOf es el texto de un cuerpo opcional ("" si no lo hay).
func valueOf(text *string) string {
	if text == nil {
		return ""
	}
	return *text
}
`;
}

// ─── renderer.go ─────────────────────────────────────────────────────────────────────────────────

function rendererBody() {
  const escapes = HTML_ESCAPES.map(([from, to]) => `${goString(from)}, ${goString(to)}`).join(', ');
  return `
// compiledLimit es el techo de la caché de plantillas compiladas: las vivas de un servicio son decenas, no miles, y la
// clave la aporta quien llama —con la versión dentro—, así que sin techo cada versión publicada se quedaría en memoria.
const compiledLimit = ${COMPILED_TEMPLATES_LIMIT}

// htmlEscapes es el escapado HTML de las variables, con una tabla CERRADA (keel-core/gen/mail-message.js): el conjunto que
// basta para escribir un dato como texto dentro de un elemento o de un atributo entrecomillado. Es CONTRATO: un escenario
// que afirma el cuerpo HTML afirma exactamente esto en los cuatro servidores del diseño. No es el de Handlebars por
// defecto, que escribe el apóstrofo de otra forma.
var htmlEscapes = strings.NewReplacer(${escapes})

// simpleMarker es un marcador simple: {{ nombre }}, sin una tercera llave a ningún lado.
var simpleMarker = regexp.MustCompile(\`\\{\\{\\s*([A-Za-z_][A-Za-z0-9_-]*)\\s*\\}\\}\`)

// Renderer interpola las plantillas con Handlebars (raymond). Las variables viajan YA escapadas como raymond.SafeString
// (con la tabla del contrato en HTML; tal cual en el asunto y el texto): el motor no vuelve a escapar lo seguro, así que
// el escapado es el del contrato y no el suyo.
type Renderer struct {
	// mu protege la caché: el renderizador lo comparten todas las peticiones.
	mu       sync.Mutex
	compiled map[string]*list.Element
	recency  *list.List
}

// cached es una plantilla compilada en la caché, con su clave.
type cached struct {
	key      string
	template *raymond.Template
}

var _ domain.TemplateRenderer = (*Renderer)(nil)

// NewRenderer construye el renderizador con su caché vacía.
func NewRenderer() *Renderer {
	return &Renderer{compiled: map[string]*list.Element{}, recency: list.New()}
}

// Render implementa domain.TemplateRenderer.
func (r *Renderer) Render(part domain.TemplatePart, cacheKey, source string, variables map[string]any) (string, error) {
	template, err := r.templateFor(fmt.Sprintf("%d:%s", part, cacheKey), source)
	if err != nil {
		return "", fmt.Errorf("plantilla %s: %w", cacheKey, err)
	}
	out, err := template.Exec(safe(variables, part == domain.TemplateHTML))
	if err != nil {
		return "", fmt.Errorf("renderizar la plantilla %s: %w", cacheKey, err)
	}
	return out, nil
}

// Compile implementa domain.TemplateRenderer: compila sin cachear.
func (r *Renderer) Compile(source string) error {
	if _, err := raymond.Parse(LiteralMarkers(source)); err != nil {
		return fmt.Errorf("la plantilla no compila: %w", err)
	}
	return nil
}

// templateFor es la plantilla compilada de key, de la caché (LRU: lo usado pasa al final, lo que sale es lo de delante).
func (r *Renderer) templateFor(key, source string) (*raymond.Template, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if element, ok := r.compiled[key]; ok {
		r.recency.MoveToBack(element)
		return element.Value.(cached).template, nil
	}
	template, err := raymond.Parse(LiteralMarkers(source))
	if err != nil {
		return nil, fmt.Errorf("la plantilla no compila: %w", err)
	}
	r.compiled[key] = r.recency.PushBack(cached{key: key, template: template})
	if r.recency.Len() > compiledLimit {
		oldest := r.recency.Front()
		r.recency.Remove(oldest)
		delete(r.compiled, oldest.Value.(cached).key)
	}
	return template, nil
}

// LiteralMarkers compila un marcador simple —{{ nombre }}— como {{this.[nombre]}}: el segmento literal, que Handlebars
// resuelve SIEMPRE como variable del contexto. Sin esto, el nombre de la variable compite con el motor (else no compila;
// if, each, with y unless se resuelven como helpers; this vuelca el mapa entero). Si la plantilla usa bloques ({{#…}},
// {{^…}}), else y this conservan su sentido: ahí son sintaxis del bloque.
func LiteralMarkers(source string) string {
	blocks := strings.Contains(source, "{{#") || strings.Contains(source, "{{^")
	var out strings.Builder
	last := 0
	for _, match := range simpleMarker.FindAllStringSubmatchIndex(source, -1) {
		start, end := match[0], match[1]
		name := source[match[2]:match[3]]
		triple := (start > 0 && source[start-1] == '{') || (end < len(source) && source[end] == '}')
		if triple || (blocks && (name == "else" || name == "this")) {
			continue
		}
		out.WriteString(source[last:start])
		out.WriteString("{{this.[" + name + "]}}")
		last = end
	}
	out.WriteString(source[last:])
	return out.String()
}

// safe son las variables como raymond.SafeString, escapadas con la tabla del contrato si escape (la parte HTML), a todo
// nivel: una lista o un mapa de valores para un bloque {{#each}} también.
func safe(value any, escape bool) any {
	switch v := value.(type) {
	case nil:
		return nil
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = safe(item, escape)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = safe(item, escape)
		}
		return out
	case []string:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = safe(item, escape)
		}
		return out
	case bool:
		// Un booleano conserva su verdad para un {{#if}}.
		return v
	case string:
		if escape {
			return raymond.SafeString(htmlEscapes.Replace(v))
		}
		return raymond.SafeString(v)
	default:
		text := fmt.Sprint(v)
		if escape {
			text = htmlEscapes.Replace(text)
		}
		return raymond.SafeString(text)
	}
}
`;
}

function rendererTest(mail) {
  return `
// TestRendererEscapesWithTheContractTable: en HTML la tabla cerrada del contrato; en el asunto y el texto, nada.
func TestRendererEscapesWithTheContractTable(t *testing.T) {
	r := ${mail.name}.NewRenderer()
	variables := map[string]any{"name": \`O'Hara & "<b>"\`}
	html, err := r.Render(domain.TemplateHTML, "k:1", "Hola {{name}}", variables)
	if err != nil || html != "Hola O&#39;Hara &amp; &quot;&lt;b&gt;&quot;" {
		t.Errorf("HTML = %q, %v", html, err)
	}
	text, err := r.Render(domain.TemplateText, "k:1", "Hola {{name}}", variables)
	if err != nil || text != \`Hola O'Hara & "<b>"\` {
		t.Errorf("texto = %q, %v", text, err)
	}
}

// TestRendererReadsEngineWordsAsVariables: una variable que se llama como una palabra del motor es una variable.
func TestRendererReadsEngineWordsAsVariables(t *testing.T) {
	r := ${mail.name}.NewRenderer()
	out, err := r.Render(domain.TemplateText, "k:2", "{{if}}-{{each}}-{{this}}", map[string]any{"if": "a", "each": "b", "this": "c"})
	if err != nil || out != "a-b-c" {
		t.Errorf("= %q, %v", out, err)
	}
	blocks, err := r.Render(domain.TemplateText, "k:3", "{{#if vip}}VIP {{name}}{{else}}normal{{/if}}", map[string]any{"vip": true, "name": "Ana"})
	if err != nil || blocks != "VIP Ana" {
		t.Errorf("bloques = %q, %v", blocks, err)
	}
}

// TestRendererRejectsATemplateThatDoesNotCompile: Compile lo dice, sin cachear nada.
func TestRendererRejectsATemplateThatDoesNotCompile(t *testing.T) {
	if err := ${mail.name}.NewRenderer().Compile("{{#if x}}sin cerrar"); err == nil {
		t.Error("una plantilla sin cerrar compila")
	}
}
`;
}

// ─── La guarda contra el doble envío ─────────────────────────────────────────────────────────────

/** Las guardas (`operation.guardClaim`) que apuntan a una raíz. */
export function guardClaimsOf(model, entity) {
  if (!usesGoMail(model)) return [];
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .map((operation) => operation.guardClaim)
    .filter((claim) => claim && claim.entity === entity.name);
}

/** El método de la guarda en Go: `ClaimForSendAcceptedNotification`. */
export const guardMethod = (claim) => goExported(claim.method);

/** Los métodos de la guarda en el puerto, como [doc, firma]. */
export function portGuardMethods(model, entity) {
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  return guardClaimsOf(model, entity).map((claim) => [
    `pasa el ${entity.name} a ${claim.to} SOLO si sigue en ${claim.from.join(' o ')}${claim.stampField ? `, estampando ${claim.stampField}` : ''}, en su PROPIA transacción, que confirma ANTES de volver: es la guarda contra el doble envío de ${claim.operation} (un correo que sale no lo deshace ningún rollback). found es false si otra ejecución llegó antes: la carrera perdida, y entonces NO se envía.`,
    `${guardMethod(claim)}(ctx context.Context, id ${idType}) (*${entity.name}, bool, error)`
  ]);
}

/** Los métodos de la guarda en el adaptador relacional: un UPDATE condicional en una transacción nueva. */
export function relationalGuardMethods(model, entity, type) {
  const d = sqlDialect(model);
  const table = d.quote(entity.tableName);
  const state = d.quote(snakeCase(entity.lifecycle?.field ?? 'status'));
  const idColumn = d.quote(entity.idField?.columns?.name ?? 'id');
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  return guardClaimsOf(model, entity).map((claim) => {
    const states = claim.from.map((s) => `'${storedState(model, entity, s)}'`).join(', ');
    const set = [`${state} = '${storedState(model, entity, claim.to)}'`];
    const args = [];
    if (claim.stampField) {
      set.push(`${d.quote(snakeCase(claim.stampField))} = ${d.param(1)}`);
      args.push('time.Now().UTC()');
    }
    args.push('id');
    const sql = `UPDATE ${table} SET ${set.join(', ')} WHERE ${idColumn} = ${d.param(args.length)} AND ${state} IN (${states})`;
    return `// ${guardMethod(claim)} implementa domain.${entity.name}Repository (la guarda de ${claim.operation}): en una transacción NUEVA,
// aunque el contexto traiga la del caso de uso, para que la marca exista para todos antes del envío.
func (r *${type}) ${guardMethod(claim)}(ctx context.Context, id ${idType}) (*domain.${entity.name}, bool, error) {
	var claimed *domain.${entity.name}
	err := r.tx.fresh(ctx, sql.TxOptions{}, func(ctx context.Context, q DBTX) error {
		claimed = nil
		result, err := q.ExecContext(ctx, ${goString(sql)}, ${args.join(', ')})
		if err != nil {
			return err
		}
		// 1 = es mía; 0 = otra ejecución la movió antes (o no existe). Esa comparación es toda la exclusión mutua.
		won, err := result.RowsAffected()
		if err != nil || won != 1 {
			return err
		}
		found, err := r.load(ctx, ${goString(`WHERE ${idColumn} = ${d.param(1)}`)}, id)
		if err != nil || len(found) == 0 {
			return err
		}
		claimed = found[0]
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return claimed, claimed != nil, nil
}`;
  });
}

/** Los métodos de la guarda en el adaptador documental: FindOneAndUpdate sin la sesión del caso de uso. */
export function documentGuardMethods(model, entity, type, constant, idWrite) {
  const state = snakeCase(entity.lifecycle?.field ?? 'status');
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  return guardClaimsOf(model, entity).map((claim) => {
    const states = claim.from.map((s) => goString(storedState(model, entity, s))).join(', ');
    const set = [`{Key: ${goString(state)}, Value: ${goString(storedState(model, entity, claim.to))}}`];
    if (claim.stampField) set.push(`{Key: ${goString(snakeCase(claim.stampField))}, Value: instantValue(time.Now().UTC())}`);
    return `// ${guardMethod(claim)} implementa domain.${entity.name}Repository (la guarda de ${claim.operation}): FindOneAndUpdate filtra por
// id y estado y marca en la MISMA operación atómica, SIN la sesión del caso de uso: la marca confirma al volver, antes del
// efecto externo.
func (r *${type}) ${guardMethod(claim)}(ctx context.Context, id ${idType}) (*domain.${entity.name}, bool, error) {
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return nil, false, err
	}
	filter := bson.D{{Key: "_id", Value: ${idWrite}}, {Key: ${goString(state)}, Value: bson.D{{Key: "$in", Value: bson.A{${states}}}}}}
	update := bson.D{{Key: "$set", Value: bson.D{${set.join(', ')}}}}
	raw, err := documents.FindOneAndUpdate(outside(ctx), filter, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongodriver.ErrNoDocuments) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, translate(err)
	}
	aggregate, err := decode${entity.name}(raw)
	if err != nil {
		return nil, false, fmt.Errorf("%s: %w", ${constant}, err)
	}
	return aggregate, true, nil
}`;
  });
}

/** La nota del handler que manda correo. */
export function mailNote(model, operation) {
  if (!usesGoMail(model) || !sendsMail(model, operation)) return null;
  const guard = operation.guardClaim;
  return (
    'Correo: esta operación lo manda (mail.sentBy). Compón el mensaje con domain.NewMailMessage(...)' +
    (usesTemplating(model) ? ' (asunto y cuerpos con h.templateRenderer.Render, una vez por parte)' : '') +
    ' y llama a h.mailSender.Send(ctx, ...). Un correo que sale NO lo deshace ningún rollback, así que la guarda tiene que estar ' +
    'CONFIRMADA antes del envío —no basta con que haya ocurrido—: ' +
    (guard
      ? `empieza por h.${guard.entity[0].toLowerCase()}${guard.entity.slice(1)}Repository.${guardMethod(guard)}(ctx, id), que pasa el agregado a ${guard.to} en su PROPIA transacción y devuelve found=false si otra ejecución llegó antes (la carrera perdida: NO envíes, y termina como digan las reglas). Hacer esa transición solo en memoria la deja sin existir para nadie hasta el commit final, que llega DESPUÉS del envío: si el proceso cae en medio, el agregado vuelve a ${guard.from.join(' o ')} y el ciclo siguiente manda un SEGUNDO correo a una persona real`
      : 'la transición declarada tiene que estar persistida y confirmada antes de llamar a Send, no solo aplicada en memoria') +
    '. Un *domain.MailDeliveryError con Partial() es un correo que SALIÓ para alguien: no lo trates como «no salió». ' +
    'El adaptador y el renderizador ya están escritos: no los toques — ver la skill keel-go-mail'
  );
}

export { usesDocument };
