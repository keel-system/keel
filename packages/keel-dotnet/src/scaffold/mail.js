// Correo saliente (capa mail, adelantada al incremento 12e como en keel-nest). Como en keel-spring y keel-nest, aquí
// build genera TAMBIÉN el adaptador, y es deliberado: el transporte es SMTP en local y en producción —contra Mailpit y
// contra el proveedor, con el mismo código—, y lo que lleva dentro son dos defensas cuya ausencia no rompe ningún
// escenario: el correo sale igual, y sale mal.
//
//   · El saneado del asunto y de las cabeceras: un salto de línea dentro de una variable interpolada en el Subject:
//     permite INYECTAR CABECERAS SMTP (un Bcc: que nadie puso). Vive en el constructor de MailMessage, para que ningún
//     camino pueda construir un mensaje sin pasar por él.
//   · El escapado HTML de las variables, con la MISMA tabla cerrada que keel-spring y keel-nest (`& < > " '`,
//     keel-core/gen/mail-message.js): un dato que llega con <script> se escribe como texto. Y solo en la parte HTML: en
//     el texto y en el asunto el escapado se vería («Pedido &amp; factura»).
//
// Y el motor: con `templating.source: data` el cuerpo es entrada de origen externo, así que no puede evaluar
// expresiones arbitrarias. Handlebars.Net (MIT), como el Handlebars de los otros dos: solo sustituye, recorre y
// condiciona. El SMTP, MailKit (MIT): resuelve el envío PARCIAL (un destinatario rechazado no aborta a los demás) con
// su gancho OnRecipientNotAccepted.
//
// Las claves de config/parameters/<perfil>/mail.yaml y sus VARIABLES de entorno son las de keel-spring y keel-nest
// (MAIL_HOST, MAIL_PORT…): el mismo .env sirve para los tres servidores del diseño.

import { envFor } from 'keel-core/gen/runtime-env';
import { COMPILED_TEMPLATES_LIMIT, HTML_ESCAPES, MAIL_HEADER_NAME_CLASS, RESERVED_MAIL_HEADERS } from 'keel-core/gen/mail-message';
import { csFile, csString, csVerbatim, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { observedMailFile, observedRegistration, telemetryNamespace, usesTelemetry } from './telemetry.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export const MAIL_SENDER_PORT = 'IMailSender';
export const TEMPLATE_RENDERER_PORT = 'ITemplateRenderer';

export function usesMail(model) {
  return Boolean(model.layersPresent?.mail && model.mail);
}

/** ¿El diseño le atribuye a esta operación la salida por correo? (`mail.sentBy`) */
export function sendsMail(model, operation) {
  return usesMail(model) && (model.mail.sentBy ?? []).includes(operation.name);
}

/** Los puertos que recibe el handler de una operación de `mail.sentBy`. */
export function mailPorts(model) {
  if (!usesMail(model)) return [];
  return [MAIL_SENDER_PORT, ...(model.mail.templating ? [TEMPLATE_RENDERER_PORT] : [])];
}

export function mailNamespace(model) {
  return namespaceOf(model, 'mail');
}

export function mailInfraNamespace(model) {
  return namespaceOf(model, 'mailInfra');
}

export function generate(model) {
  if (!usesMail(model)) return [];
  const file = (place, name, usings, body) => {
    const { namespace, path } = located(model, place, name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [
    file('mail', 'MailMessage', ['System.Text.RegularExpressions'], mailMessageBody(model)),
    file('mail', 'MailDeliveryException', [], mailDeliveryExceptionBody()),
    file('ports', MAIL_SENDER_PORT, [mailNamespace(model)], mailSenderBody(model)),
    file('mailInfra', 'SmtpMailSender', ['MailKit', 'MailKit.Net.Smtp', 'MailKit.Security', 'Microsoft.Extensions.Logging', 'MimeKit', mailNamespace(model), namespaceOf(model, 'ports')], smtpMailSenderBody(model)),
    file('mailInfra', 'MailSettings', ['System.Globalization', configNamespace(model)], mailSettingsBody(model)),
    file('mailInfra', 'MailRegistration', ['Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'ports'), ...(usesTelemetry(model) ? [telemetryNamespace(model)] : [])], mailRegistrationBody(model)),
    // Con telemetría, el puerto observado (keel.mail.send), con su interruptor TELEMETRY_INSTRUMENT_MAIL.
    ...[observedMailFile(model, { ...located(model, 'mailInfra', 'ObservedMailSender'), usings: [namespaceOf(model, 'ports'), mailNamespace(model)] })].filter(Boolean),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/mail.yaml`, content: mailYaml(model, profile) }))
  ];
  if (model.mail.templating) {
    files.push(
      file('mail', 'TemplateRenderException', [], templateRenderExceptionBody()),
      file('ports', TEMPLATE_RENDERER_PORT, [], templateRendererBody(model)),
      file('mailInfra', 'HandlebarsTemplateRenderer', ['System.Text', 'System.Text.RegularExpressions', 'HandlebarsDotNet', mailNamespace(model), namespaceOf(model, 'ports')], handlebarsRendererBody())
    );
  }
  return files;
}

// ─── El mensaje (dominio) ────────────────────────────────────────────────────────────────────────

function mailMessageBody(model) {
  const mail = model.mail;
  const attachment = mail.attachments
    ? `/// <summary>
/// Un archivo adjunto. Viaja en base64, que infla un 33%: el límite de tamaño del proveedor se cuenta sobre el mensaje YA
/// codificado, no sobre el fichero.
/// </summary>
public sealed record MailAttachment(string Filename, string ContentType, byte[] Content);

`
    : '';
  return `${attachment}/// <summary>
/// Un correo listo para salir: destinatarios, asunto y cuerpo ya renderizados.
/// </summary>
/// <remarks>
/// <para>
/// Es un value object de DOMINIO y no un DTO de infraestructura: quien decide qué correo sale es el caso de uso, y tiene
/// que poder componerlo sin conocer el transporte. El adaptador solo lo traduce al protocolo.
/// </para>
/// <para>
/// EL ASUNTO Y LAS CABECERAS SE SANEAN AQUÍ, no en el adaptador. Un \\r o un \\n dentro del asunto permite inyectar
/// cabeceras SMTP —un Bcc: que nadie puso—, y ponerlo en el constructor significa que NINGÚN camino puede construir un
/// mensaje sin sanear, tampoco uno que se escriba después y no pase por el adaptador de hoy.
/// </para>
/// </remarks>
public sealed partial class MailMessage
{
    /// <summary>
    /// Cabeceras que el propio mensaje ya gobierna con sus campos, o que compone el transporte. Una cabecera propia con
    /// uno de estos nombres duplicaría o pisaría lo que dice el resto del mensaje: se rechaza al construir.
    /// </summary>
    private static readonly HashSet<string> ReservedHeaders = new(StringComparer.OrdinalIgnoreCase) { ${RESERVED_MAIL_HEADERS.map(csString).join(', ')} };

    /// <param name="to">Destinatarios; al menos uno para que salga.</param>
    /// <param name="subject">Asunto ya interpolado; se sanea aquí.</param>
    /// <param name="html">Cuerpo HTML${mail.hasHtml ? '' : ' (el diseño no lo declara: siempre null)'}.</param>
    /// <param name="text">Cuerpo en texto plano${mail.hasText ? '' : ' (el diseño no lo declara: siempre null)'}.</param>
    /// <param name="from">Remitente${mail.sender.source === 'data' ? ' (sale de un dato del servicio; null para usar el de respaldo)' : ' (lo pone la configuración: el diseño lo fija)'}.</param>
    /// <param name="replyTo">Dirección de respuesta, o null para que se responda al remitente.</param>
    /// <param name="cc">Copias.</param>
    /// <param name="headers">Cabeceras propias (p. ej. un X-… con el id del envío, que el proveedor devuelve con el rebote): se validan los nombres y se sanean los valores.</param>${
      mail.attachments ? '\n    /// <param name="attachments">Adjuntos.</param>' : ''
    }
    public MailMessage(
        IReadOnlyList<string> to,
        string? subject,
        string? html = null,
        string? text = null,
        string? from = null,
        string? replyTo = null,
        IReadOnlyList<string>? cc = null,
        IReadOnlyDictionary<string, string?>? headers = null${mail.attachments ? ',\n        IReadOnlyList<MailAttachment>? attachments = null' : ''})
    {
        ArgumentNullException.ThrowIfNull(to);
        To = [.. to];
        Cc = [.. cc ?? []];
        Subject = SanitizeSubject(subject);
        Html = html;
        Text = text;
        From = from;
        ReplyTo = replyTo;
        Headers = SanitizeHeaders(headers);${mail.attachments ? '\n        Attachments = [.. attachments ?? []];' : ''}
    }

    public string? From { get; }

    public string? ReplyTo { get; }

    public IReadOnlyList<string> To { get; }

    public IReadOnlyList<string> Cc { get; }

    public string? Subject { get; }

    public string? Html { get; }

    public string? Text { get; }
${mail.attachments ? '\n    public IReadOnlyList<MailAttachment> Attachments { get; }\n' : ''}
    public IReadOnlyDictionary<string, string> Headers { get; }

    /// <summary>Quita los saltos de línea del asunto. No es cosmética: con ellos, una variable cierra Subject: y abre otra.</summary>
    private static string? SanitizeSubject(string? value) => value is null ? null : LineBreaks().Replace(value, " ").Trim();

    /// <summary>
    /// El NOMBRE se valida en vez de sanearse: uno malformado o reservado es un error de quien compone el mensaje, no un
    /// dato que haya que arreglar. El VALOR se sanea, por lo mismo que el asunto.
    /// </summary>
    private static Dictionary<string, string> SanitizeHeaders(IReadOnlyDictionary<string, string?>? headers)
    {
        var clean = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (name, content) in headers ?? new Dictionary<string, string?>())
        {
            if (!HeaderName().IsMatch(name))
            {
                throw new ArgumentException($"Nombre de cabecera no válido: {name}", nameof(headers));
            }
            if (ReservedHeaders.Contains(name) || name.StartsWith("content-", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException($"La cabecera {name} la compone el propio mensaje", nameof(headers));
            }
            clean[name] = LineBreaks().Replace(content ?? string.Empty, " ").Trim();
        }
        return clean;
    }

    [GeneratedRegex("[\\r\\n]")]
    private static partial Regex LineBreaks();

    /// <summary>Nombre de cabecera (RFC 5322): imprimibles sin espacio ni dos puntos.</summary>
    [GeneratedRegex(${csVerbatim(`^${MAIL_HEADER_NAME_CLASS}$`)})]
    private static partial Regex HeaderName();
}`;
}

function mailDeliveryExceptionBody() {
  return `/// <summary>
/// El proveedor no aceptó el mensaje, o no lo aceptó para TODOS los destinatarios. Envuelve la causa del transporte para
/// que la capa de aplicación no tenga que conocerlo.
/// </summary>
/// <remarks>
/// UN FALLO PUEDE SER PARCIAL, y el caso de uso tiene que poder distinguirlo sin desenvolver la causa: si el relay rechaza
/// a un destinatario y acepta a otro, el correo SALE para los aceptados y aun así se lanza esta excepción. Tratarla como
/// «no salió» repetiría o daría por fallido un envío que ya llegó. Por eso lleva quién lo recibió (Accepted), a quién se
/// rechazó (Rejected) y la respuesta del relay (Detail). Sin envío parcial (un error de conexión, un rechazo del
/// remitente) Accepted está vacío. Es lo mismo que el MailDeliveryException de keel-spring y keel-nest.
/// </remarks>
public sealed class MailDeliveryException(
    string message,
    Exception? cause = null,
    IEnumerable<string>? accepted = null,
    IEnumerable<string>? rejected = null,
    string? detail = null) : Exception(message, cause)
{
    public IReadOnlySet<string> Accepted { get; } = new HashSet<string>(accepted ?? [], StringComparer.OrdinalIgnoreCase);

    public IReadOnlySet<string> Rejected { get; } = new HashSet<string>(rejected ?? [], StringComparer.OrdinalIgnoreCase);

    public string? Detail { get; } = detail ?? cause?.Message;

    /// <summary>¿El correo salió para alguno? Es la pregunta que decide el desenlace del envío.</summary>
    public bool Partial() => Accepted.Count > 0;
}`;
}

function templateRenderExceptionBody() {
  return `/// <summary>
/// La plantilla no compila o el renderizado falla. Se distingue del fallo de entrega a propósito: aquí no se ha llegado a
/// hablar con el proveedor, y el problema es del contenido, no del transporte.
/// </summary>
public sealed class TemplateRenderException(string message, Exception? cause = null) : Exception(message, cause);`;
}

// ─── Los puertos (Application/Ports) ─────────────────────────────────────────────────────────────

function mailSenderBody(model) {
  return `/// <summary>
/// Salida de correo del servicio. Puerto de la capa de aplicación: lo invocan los handlers de ${model.mail.sentBy.join(', ')}
/// —las operaciones que el diseño declara en mail.sentBy— y lo implementa un adaptador de infraestructura.
/// </summary>
/// <remarks>
/// Lo que este puerto NO promete: que el correo llegue. Promete que se entregó al proveedor. Que acabe en la bandeja de
/// entrada depende de SPF, DKIM, DMARC y de la reputación del remitente, que no tienen equivalente en ninguna prueba local.
/// </remarks>
public interface ${MAIL_SENDER_PORT}
{
    /// <summary>
    /// Entrega el mensaje al proveedor. Lanza <see cref="MailDeliveryException"/> si el proveedor no lo acepta (o no para
    /// todos). Es una excepción y no un booleano a propósito: un envío que falla en silencio es un correo que nadie recibe
    /// y del que nadie se entera.
    /// </summary>
    Task Send(MailMessage message, CancellationToken cancellationToken = default);
}`;
}

function templateRendererBody(model) {
  const external = model.mail.templating?.externalContent === true;
  return `/// <summary>Qué parte del correo se renderiza: decide el escapado.</summary>
public enum TemplatePart
{
    Subject,
    Text,
    Html
}

/// <summary>Interpola una plantilla con las variables de un envío.</summary>
/// <remarks>
/// <para>
/// ${
    external
      ? `El cuerpo de la plantilla es un DATO de este servicio, no un recurso del repositorio: lo escribe alguien que puede
/// ser ajeno al equipo. De ahí que el contrato hable de fuente y no de nombre de plantilla, y de ahí la restricción que la
/// implementación tiene que cumplir: el motor no puede evaluar expresiones arbitrarias.`
      : 'El cuerpo viaja con el código, versionado en el repositorio.'
  }
/// </para>
/// <para>
/// El escapado depende de la PARTE, y por eso la parte es un argumento: en HTML las variables se escapan —un dato con
/// &lt;script&gt; se escribe como texto, porque hay clientes de correo que ejecutan—; en Text y Subject NO, porque ahí no hay
/// HTML que proteger y el escapado se vería («Pedido &amp;amp; factura» en el asunto). Los saltos de línea del asunto los
/// neutraliza MailMessage, no esto.
/// </para>
/// </remarks>
public interface ${TEMPLATE_RENDERER_PORT}
{
    /// <summary>Renderiza. Lanza TemplateRenderException si la plantilla no compila o el renderizado falla.</summary>
    /// <param name="part">La parte del correo: decide el escapado de las variables.</param>
    /// <param name="cacheKey">
    /// Identidad estable de la plantilla (clave y versión), con la que se cachea la compilación. Dos contenidos distintos no
    /// pueden compartir clave: la caché serviría el viejo para siempre. La parte no hace falta ponerla: la añade la
    /// implementación.
    /// </param>
    /// <param name="source">El cuerpo literal de la plantilla, con sus llaves sin procesar.</param>
    /// <param name="variables">Valores del envío.</param>
    string Render(TemplatePart part, string cacheKey, string source, IReadOnlyDictionary<string, object?>? variables);

    /// <summary>
    /// Comprueba que la fuente compila, SIN cachearla. Es lo que usa la operación que da de alta una plantilla para
    /// rechazarla antes de guardarla (el error que declare el diseño): validar con Render y una clave nueva cada vez haría
    /// crecer la caché sin límite. Lanza TemplateRenderException si no compila.
    /// </summary>
    void Compile(string source);
}`;
}

// ─── El adaptador SMTP ───────────────────────────────────────────────────────────────────────────

function smtpMailSenderBody(model) {
  const mail = model.mail;
  const resolveFrom =
    mail.sender.source === 'fixed'
      ? '        var from = settings.Sender;'
      : mail.sender.fallback
        ? `        // El dato manda; el respaldo solo entra cuando no lo resuelve. Sin respaldo declarado el diseño prefiere NO
        // enviar antes que enviar desde una dirección que nadie verificó ante el proveedor.
        var from = HasText(message.From) ? message.From : settings.SenderFallback;`
        : '        var from = message.From;';
  const replyTo =
    mail.replyTo?.source === 'fixed'
      ? `
        if (HasText(settings.ReplyTo))
        {
            mime.ReplyTo.Add(MailboxAddress.Parse(settings.ReplyTo));
        }`
      : mail.replyTo
        ? `
        if (HasText(message.ReplyTo))
        {
            mime.ReplyTo.Add(MailboxAddress.Parse(message.ReplyTo));
        }`
        : '';
  // multipart/alternative con las dos partes: los filtros antispam desconfían de un HTML sin alternativa textual, y eso
  // no falla en ninguna prueba: se ve en la carpeta de spam de quien lo recibe.
  const bodyLines = mail.multipart
    ? '        // multipart/alternative: el cliente elige (MimeKit pone el texto primero y el HTML, la preferida, al final).\n        var body = new BodyBuilder { TextBody = message.Text ?? string.Empty, HtmlBody = message.Html ?? string.Empty };'
    : mail.hasHtml
      ? '        var body = new BodyBuilder { HtmlBody = message.Html ?? string.Empty };'
      : '        var body = new BodyBuilder { TextBody = message.Text ?? string.Empty };';
  const attachments = mail.attachments
    ? `
        foreach (var attachment in message.Attachments)
        {
            body.Attachments.Add(attachment.Filename, attachment.Content, ContentType.Parse(attachment.ContentType));
        }`
    : '';
  return `/// <summary>
/// Entrega el correo por SMTP. Mismo adaptador en local (contra el Mailpit de infra/) y en producción (contra el proveedor
/// contratado): lo único que cambia son los parámetros de config/parameters/&lt;perfil&gt;/mail.yaml, así que cambiar de
/// proveedor es cambiar variables de entorno y reiniciar.
/// </summary>
/// <remarks>El saneado del asunto NO está aquí: vive en el constructor de MailMessage, para que ningún camino pueda saltárselo.</remarks>
public sealed partial class SmtpMailSender(MailSettings settings, ILogger<SmtpMailSender> logger) : ${MAIL_SENDER_PORT}
{
    public async Task Send(MailMessage message, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);
${resolveFrom}
        if (!HasText(from))
        {
            throw new MailDeliveryException("El mensaje no tiene remitente y el diseño no declara uno de respaldo: no se envía");
        }
        if (message.To.Count == 0)
        {
            throw new MailDeliveryException("El mensaje no tiene destinatarios: no se envía");
        }
        var mime = new MimeMessage();
        mime.From.Add(MailboxAddress.Parse(from));
        foreach (var address in message.To)
        {
            mime.To.Add(MailboxAddress.Parse(address));
        }
        foreach (var address in message.Cc)
        {
            mime.Cc.Add(MailboxAddress.Parse(address));
        }${replyTo}
        mime.Subject = message.Subject ?? string.Empty;
        // Cabeceras propias: nombre y valor ya vienen validados y saneados por MailMessage.
        foreach (var (name, value) in message.Headers)
        {
            mime.Headers.Add(name, value);
        }
${bodyLines}${attachments}
        mime.Body = body.ToMessageBody();

        using var client = new RecordingSmtpClient
        {
            // Un envío que se queda esperando a un proveedor caído retiene a quien lo hace: los mismos plazos que keel-spring
            // (conexión aparte; lectura y escritura de cada respuesta).
            Timeout = Math.Max(settings.ReadTimeoutMs, settings.WriteTimeoutMs)
        };
        try
        {
            using (var connect = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                connect.CancelAfter(settings.ConnectTimeoutMs);
                // STARTTLS: exigido donde la configuración lo pide; en local y test, Mailpit no lo ofrece.
                await client.ConnectAsync(settings.Host, settings.Port, settings.Starttls ? SecureSocketOptions.StartTls : SecureSocketOptions.None, connect.Token);
            }
            if (settings.Auth && HasText(settings.Username))
            {
                await client.AuthenticateAsync(settings.Username, settings.Password, cancellationToken);
            }
            await client.SendAsync(mime, cancellationToken);
            await client.DisconnectAsync(quit: true, cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Se envuelve y se relanza: un envío que falla en silencio es un correo que nadie recibe. Con TODOS los
            // destinatarios rechazados el servidor corta el envío; sin rechazos (conexión, remitente) no salió para nadie.
            throw new MailDeliveryException("El proveedor no aceptó el mensaje", error, [], client.Rejected, DetailOf(error));
        }
        // Envío PARCIAL: el relay entregó a unos y rechazó a otros. El correo SALIÓ para los aceptados, y aun así se lanza,
        // diciendo a quién llegó y a quién no (lo mismo que keel-spring con sendpartial).
        if (client.Rejected.Count > 0)
        {
            var accepted = message.To.Concat(message.Cc).Where(address => !client.Rejected.Contains(address, StringComparer.OrdinalIgnoreCase));
            throw new MailDeliveryException("El proveedor rechazó a parte de los destinatarios", null, accepted, client.Rejected, string.Join("; ", client.Responses));
        }
        LogDelivered(message.To.Count, message.Subject ?? string.Empty);
    }

    private static string? DetailOf(Exception error) => error is SmtpCommandException command ? $"{(int)command.StatusCode} {command.Message}" : error.Message;

    private static bool HasText([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? value) => !string.IsNullOrWhiteSpace(value);

    [LoggerMessage(Level = LogLevel.Information, Message = "Correo entregado al proveedor: destinatarios={Count} asunto=\\"{Subject}\\"")]
    private partial void LogDelivered(int count, string subject);

    /// <summary>
    /// El cliente SMTP que NO aborta el envío con el primer destinatario rechazado (lo que hace MailKit por defecto):
    /// lo apunta y sigue con los demás, para que el correo salga para los aceptados y el envío parcial se pueda decir.
    /// </summary>
    private sealed class RecordingSmtpClient : SmtpClient
    {
        public List<string> Rejected { get; } = [];

        public List<string> Responses { get; } = [];

        protected override void OnRecipientNotAccepted(MimeMessage message, MailboxAddress mailbox, SmtpResponse response)
        {
            Rejected.Add(mailbox.Address);
            Responses.Add($"{(int)response.StatusCode} {response.Response}");
        }
    }
}`;
}

// ─── El renderizador ─────────────────────────────────────────────────────────────────────────────

function handlebarsRendererBody() {
  const cases = HTML_ESCAPES.map(([from, to]) => `                case '${from === "'" ? "\\'" : from}':\n                    target.Write(${csString(to)});\n                    break;`).join('\n');
  return `/// <summary>
/// Renderizado con Handlebars.Net. La elección de motor es una decisión de SEGURIDAD: un motor que evalúa expresiones (o
/// que puede llamar a código) con plantillas que entran por una API y rellenan equipos ajenos es una ejecución remota de
/// código esperando a suceder. Handlebars solo sustituye variables, recorre listas y evalúa condiciones simples.
/// </summary>
/// <remarks>
/// NO SE AÑADEN HELPERS ni partials: cada uno nuevo es superficie que quien escribe la plantilla puede alcanzar. Las
/// variables llegan ya formateadas (un importe tiene reglas de locale que se prueban mejor en el llamante). Dos entornos
/// propios, sin nada registrado por nadie más: uno con el escapado de la tabla cerrada (Html) y otro sin escapado
/// (Text y Subject).
/// </remarks>
public sealed partial class HandlebarsTemplateRenderer : ${TEMPLATE_RENDERER_PORT}
{
    /// <summary>Techo de la caché: las plantillas vivas de un servicio son decenas, no miles.</summary>
    private const int MaxCompiled = ${COMPILED_TEMPLATES_LIMIT};

    private readonly IHandlebars html = Handlebars.Create(new HandlebarsConfiguration { TextEncoder = new HtmlFiveEncoder() });

    private readonly IHandlebars plain = Handlebars.Create(new HandlebarsConfiguration { NoEscape = true });

    /// <summary>
    /// Compilación cacheada por parte + identidad de plantilla, en un LRU acotado. La parte va en la clave porque el mismo
    /// texto compilado escapa distinto; y el techo existe porque la clave la aporta quien llama —con la versión dentro—, así
    /// que sin él cada versión publicada se quedaría en memoria para siempre.
    /// </summary>
    private readonly Dictionary<string, LinkedListNode<(string Key, HandlebarsTemplate<object, object> Template)>> compiled = new(StringComparer.Ordinal);

    private readonly LinkedList<(string Key, HandlebarsTemplate<object, object> Template)> recency = new();

    private readonly Lock guard = new();

    public string Render(TemplatePart part, string cacheKey, string source, IReadOnlyDictionary<string, object?>? variables)
    {
        var key = $"{part}:{cacheKey}";
        try
        {
            HandlebarsTemplate<object, object> template;
            lock (guard)
            {
                if (compiled.TryGetValue(key, out var node))
                {
                    // LRU: lo usado pasa al final; lo que sale es lo de delante.
                    recency.Remove(node);
                    recency.AddLast(node);
                    template = node.Value.Template;
                }
                else
                {
                    template = CompileWith(part, source);
                    compiled[key] = recency.AddLast((key, template));
                    if (compiled.Count > MaxCompiled)
                    {
                        compiled.Remove(recency.First!.Value.Key);
                        recency.RemoveFirst();
                    }
                }
            }
            return template(new Dictionary<string, object?>(variables ?? new Dictionary<string, object?>(), StringComparer.Ordinal));
        }
        catch (Exception error) when (error is not TemplateRenderException)
        {
            throw new TemplateRenderException($"No se pudo renderizar la plantilla {cacheKey} ({part})", error);
        }
    }

    public void Compile(string source)
    {
        try
        {
            plain.Compile(LiteralMarkers(source ?? string.Empty));
        }
        catch (Exception error)
        {
            throw new TemplateRenderException("La plantilla no compila", error);
        }
    }

    private HandlebarsTemplate<object, object> CompileWith(TemplatePart part, string source)
    {
        Compile(source);
        // Html: el escapado de la tabla cerrada. Text y Subject: ninguno.
        return (part == TemplatePart.Html ? html : plain).Compile(LiteralMarkers(source ?? string.Empty));
    }

    /// <summary>
    /// Un marcador simple —{{ nombre }}— se compila como {{this.[nombre]}}: el segmento literal, que Handlebars resuelve
    /// SIEMPRE como variable del contexto. Sin esto, el nombre de la variable compite con el motor: else no compila; if,
    /// each, with, unless y log se resuelven como helpers; y this o lookup vuelcan el mapa entero de variables en el
    /// correo. El diseño no conoce esas palabras y no tiene por qué: el motor es mecánica del generador. Si la plantilla
    /// usa bloques ({{#…}}, {{^…}}), else y this conservan su sentido: ahí son sintaxis del bloque.
    /// </summary>
    public static string LiteralMarkers(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        var blocks = source.Contains("{{#", StringComparison.Ordinal) || source.Contains("{{^", StringComparison.Ordinal);
        return SimpleMarker().Replace(source, match =>
        {
            var name = match.Groups[1].Value;
            return blocks && name is "else" or "this" ? match.Value : "{{this.[" + name + "]}}";
        });
    }

    [GeneratedRegex(@"(?<!\\{)\\{\\{\\s*([A-Za-z_][A-Za-z0-9_-]*)\\s*\\}\\}(?!\\})")]
    private static partial Regex SimpleMarker();

    /// <summary>
    /// El escapado HTML, con una tabla CERRADA: &amp; &lt; &gt; " ' → &amp;amp; &amp;lt; &amp;gt; &amp;quot; &amp;#39;. Es el
    /// conjunto que basta para escribir un dato como texto dentro de un elemento o de un atributo entrecomillado, y es
    /// CONTRATO: un escenario que afirma el cuerpo HTML afirma exactamente esto, en los tres servidores del diseño. No es el
    /// de Handlebars por defecto, que escapa además otros caracteres (un O'Hara saldría distinto que en keel-spring).
    /// </summary>
    private sealed class HtmlFiveEncoder : ITextEncoder
    {
        public void Encode(StringBuilder? text, TextWriter target) => Encode(text?.ToString(), target);

        public void Encode(string? text, TextWriter target)
        {
            ArgumentNullException.ThrowIfNull(target);
            foreach (var character in text ?? string.Empty)
            {
                Write(character, target);
            }
        }

        public void Encode<T>(T? text, TextWriter target)
            where T : IEnumerator<char>
        {
            ArgumentNullException.ThrowIfNull(target);
            while (text is not null && text.MoveNext())
            {
                Write(text.Current, target);
            }
        }

        private static void Write(char character, TextWriter target)
        {
            switch (character)
            {
${cases}
                default:
                    target.Write(character);
                    break;
            }
        }
    }
}`;
}

// ─── Configuración y registro ────────────────────────────────────────────────────────────────────

function mailSettingsBody(model) {
  const mail = model.mail;
  return `/// <summary>Lo que el adaptador SMTP lee de config/parameters/&lt;perfil&gt;/mail.yaml (las variables de keel-spring).</summary>
/// <param name="Sender">Remitente fijo (mail.sender.source: fixed), o null.</param>
/// <param name="SenderFallback">Remitente de respaldo cuando el dato del servicio no lo resuelve, o null.</param>
/// <param name="ReplyTo">Reply-To fijo (mail.replyTo.source: fixed), o null.</param>
public sealed record MailSettings(
    string Host,
    int Port,
    string Username,
    string Password,
    bool Auth,
    bool Starttls,
    int ConnectTimeoutMs,
    int ReadTimeoutMs,
    int WriteTimeoutMs,
    string? Sender,
    string? SenderFallback,
    string? ReplyTo)
{
    /// <summary>Los defaults, sin configuración: los de un contenedor que no la tiene (las pruebas de build).</summary>
    public static MailSettings Defaults { get; } = new("localhost", 1025, string.Empty, string.Empty, false, false, 5000, 5000, 5000, null, null, null);

    public static MailSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new MailSettings(
            Text(configuration, "mail:host") ?? "localhost",
            Number(configuration, "mail:port", 1025),
            Text(configuration, "mail:username") ?? string.Empty,
            Text(configuration, "mail:password") ?? string.Empty,
            Flag(configuration, "mail:smtp:auth", true),
            Flag(configuration, "mail:smtp:starttls", true),
            Number(configuration, "mail:smtp:connect-timeout-ms", 5000),
            Number(configuration, "mail:smtp:read-timeout-ms", 5000),
            Number(configuration, "mail:smtp:write-timeout-ms", 5000),
            ${mail.sender.source === 'fixed' ? 'Text(configuration, "mail:sender")' : 'null'},
            ${mail.sender.source !== 'fixed' && mail.sender.fallback ? 'Text(configuration, "mail:sender-fallback")' : 'null'},
            ${mail.replyTo?.source === 'fixed' ? 'Text(configuration, "mail:reply-to")' : 'null'});
    }

    private static string? Text(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static int Number(ServiceConfiguration configuration, string key, int fallback)
    {
        var value = Text(configuration, key);
        if (value is null)
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un número no negativo: '{value}'");
    }

    private static bool Flag(ServiceConfiguration configuration, string key, bool fallback) =>
        Text(configuration, key) is { } value ? string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) : fallback;
}`;
}

function mailRegistrationBody(model) {
  const templating = Boolean(model.mail.templating);
  const observed = observedRegistration(model, { port: MAIL_SENDER_PORT, adapter: 'SmtpMailSender', decorator: 'ObservedMailSender', instrumentation: 'mail' });
  return `/// <summary>
/// El correo saliente en el contenedor: el adaptador SMTP${templating ? ' y el renderizador de plantillas' : ''}, con la configuración del perfil.
/// </summary>
public static class MailRegistration
{
    public static IServiceCollection AddMail(this IServiceCollection services, MailSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        ${observed ? `services.AddSingleton<SmtpMailSender>();
        ${observed}` : `services.AddSingleton<${MAIL_SENDER_PORT}, SmtpMailSender>();`}${templating ? `\n        services.AddSingleton<${TEMPLATE_RENDERER_PORT}, HandlebarsTemplateRenderer>();` : ''}
        return services;
    }
}`;
}

/** config/parameters/<perfil>/mail.yaml: las mismas variables y defaults que el mail.yaml de keel-spring y keel-nest. */
export function mailYaml(model, profile) {
  const mail = model.mail;
  const localish = profile === 'local' || profile === 'test';
  const lines = [
    'mail:',
    `  host: ${envFor('MAIL_HOST', profile)}`,
    `  port: ${envFor('MAIL_PORT', profile)}`,
    `  username: ${yamlScalar(envFor('MAIL_USERNAME', profile))}`,
    `  password: ${yamlScalar(envFor('MAIL_PASSWORD', profile))}`,
    '  smtp:'
  ];
  if (localish) {
    // Mailpit no exige ni autenticación ni cifrado, y pedirlos haría fallar el envío contra la infra de prueba.
    lines.push('    auth: false', '    starttls: false');
  } else {
    lines.push(`    auth: ${envFor('MAIL_SMTP_AUTH', profile)}`, `    starttls: ${envFor('MAIL_SMTP_STARTTLS', profile)}`);
  }
  lines.push(
    '    # Un envío esperando a un proveedor caído retiene a quien lo hace: sin plazos esperaría para siempre.',
    `    connect-timeout-ms: ${envFor('MAIL_CONNECT_TIMEOUT_MS', profile)}`,
    `    read-timeout-ms: ${envFor('MAIL_READ_TIMEOUT_MS', profile)}`,
    `    write-timeout-ms: ${envFor('MAIL_WRITE_TIMEOUT_MS', profile)}`
  );
  if (mail.sender?.source === 'fixed') {
    lines.push(`  sender: ${envFor('MAIL_SENDER', profile, mail.sender.address)}`);
  } else if (mail.sender?.fallback) {
    lines.push('  # Remitente de respaldo: se usa cuando el dato del servicio no lo resuelve.', `  sender-fallback: ${envFor('MAIL_SENDER_FALLBACK', profile, mail.sender.fallback)}`);
  }
  if (mail.replyTo?.source === 'fixed') lines.push(`  reply-to: ${envFor('MAIL_REPLY_TO', profile, mail.replyTo.address)}`);
  return `${lines.join('\n')}\n`;
}

// El cargador de config/ lee un escalar vacío como nulo, y las credenciales del SMTP son cadenas: el vacío va
// entrecomillado. Es cómo lee YAML esta plataforma, no el contrato (keel-spring escribe `username: ` y Spring lo trata
// como ausente: las dos dicen «sin credencial»).
function yamlScalar(text) {
  return text === '' ? "''" : text;
}
