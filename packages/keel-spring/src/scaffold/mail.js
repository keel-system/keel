// Correo saliente (capa mail). A diferencia de storage y de la mensajería, aquí
// build genera TAMBIÉN el adaptador, y es deliberado.
//
// La frontera del generador dice que el código cuya implementación cambia según la
// infraestructura elegida lo escribe el agente. El correo no cumple esa condición:
// el transporte es SMTP en local y en producción, el adaptador es el mismo contra
// Mailpit y contra SES, y lo único que cambia son cuatro parámetros de
// configuración. Lo que sí cambia el reparto es lo que hay dentro del adaptador:
// dos defensas de seguridad que no pueden depender de que alguien se acuerde.
//
//   * El escapado HTML de las variables. Un dato que llega con <script> se escribe
//     como texto, no como marcado. El XSS en correo es real: hay clientes que
//     ejecutan.
//   * El saneado del asunto. Un salto de línea dentro de una variable interpolada
//     en el Subject: permite INYECTAR CABECERAS SMTP — añadir un Bcc: que nadie
//     puso. Se eliminan \r y \n antes de componer el mensaje.
//
// Ninguna de las dos aparece en el camino de menor resistencia de quien implementa
// «manda un correo con este asunto y este cuerpo», y su ausencia no falla ningún
// escenario: el correo sale, y sale mal. Por eso salen de build.
//
// Y el motor: con `templating.source: data` el cuerpo es entrada de origen
// externo, así que el motor no puede evaluar expresiones arbitrarias (ver la nota
// de gradle.js). Eso tampoco se delega.

import { javaFile, javaPath } from './render.js';

const DOMAIN_PKG = 'domain.mail';
const PORT_PKG = 'application.port.out';
const INFRA_PKG = 'infrastructure.mail';

export function generate(model) {
  if (!model.layersPresent.mail) return [];
  const files = [renderMailMessage(model), ...renderMailSenderPort(model), renderSmtpMailSender(model)];
  if (model.mail?.templating) {
    files.push(...renderTemplateRendererPort(model), renderHandlebarsRenderer(model));
  }
  return files;
}

/** Si el diseño declara plantillas de origen externo (modelo A): el caso que exige motor sin lógica. */
export function usesExternalTemplates(model) {
  return model.mail?.templating?.externalContent === true;
}

// ─── El mensaje ──────────────────────────────────────────────────────────────

function renderMailMessage(model) {
  const mail = model.mail;
  const attachments = mail.attachments
    ? `
    /**
     * Archivos adjuntos. Viajan en base64, que infla un 33%: el límite de tamaño
     * del proveedor se cuenta sobre el mensaje YA codificado, no sobre el fichero.
     */
    public record Attachment(String filename, String contentType, byte[] content) {
    }
`
    : '';
  const attachmentsField = mail.attachments ? ', List<Attachment> attachments' : '';
  const attachmentsArg = mail.attachments ? ', attachments' : '';
  const attachmentsNormalize = mail.attachments
    ? '\n        attachments = attachments == null ? List.of() : List.copyOf(attachments);'
    : '';

  const body = `/**
 * Un correo listo para salir: destinatarios, asunto y cuerpo ya renderizados.
 *
 * <p>Es un value object de DOMINIO y no un DTO de infraestructura, y la diferencia
 * importa: quien decide qué correo sale es el caso de uso, y tiene que poder
 * componerlo sin depender de jakarta.mail ni de Spring. El adaptador solo lo
 * traduce al protocolo.
 *
 * <p><b>El asunto se sanea en el constructor</b>, no en el adaptador. Un \\r o un \\n
 * dentro del asunto permite inyectar cabeceras SMTP —un Bcc: que nadie puso—, y
 * ponerlo aquí significa que <b>ningún</b> camino puede construir un mensaje con el
 * asunto sin sanear, ni siquiera uno que se escriba después y no pase por el
 * adaptador de hoy.
 *
 * @param from    remitente${mail.sender.source === 'data' ? ' (sale de un dato del servicio)' : ' declarado en el diseño'}
 * @param replyTo dirección de respuesta, o null para que se responda al remitente
 * @param to      destinatarios
 * @param subject asunto ya interpolado
 * @param html    cuerpo HTML${mail.hasHtml ? '' : ' (el diseño no lo declara: siempre null)'}
 * @param text    cuerpo en texto plano${mail.hasText ? '' : ' (el diseño no lo declara: siempre null)'}
 * @param headers cabeceras propias (p. ej. un {@code X-…} con el id del envío, que el proveedor
 *                devuelve con el rebote), ya saneadas; vacío si no hay ninguna
 */
public record MailMessage(String from, String replyTo, List<String> to, List<String> cc, String subject, String html,
        String text${attachmentsField}, Map<String, String> headers) {

    /**
     * Cabeceras que este record ya gobierna con sus propios campos, o que compone el
     * transporte. Una cabecera propia con uno de estos nombres duplicaría o pisaría lo que el
     * resto del mensaje dice, así que se rechaza al construir.
     */
    private static final Set<String> RESERVED_HEADERS = Set.of(
            "from", "sender", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id",
            "mime-version", "return-path");

    /** Nombre de cabecera (RFC 5322): imprimibles sin espacio ni dos puntos. */
    private static final Pattern HEADER_NAME = Pattern.compile("[!-9;-~]+");

    public MailMessage {
        to = to == null ? List.of() : List.copyOf(to);
        cc = cc == null ? List.of() : List.copyOf(cc);
        subject = sanitizeSubject(subject);${attachmentsNormalize}
        headers = sanitizeHeaders(headers);
    }

    /** Sin cabeceras propias: la forma habitual. */
    public MailMessage(String from, String replyTo, List<String> to, List<String> cc, String subject, String html,
            String text${attachmentsField}) {
        this(from, replyTo, to, cc, subject, html, text${attachmentsArg}, Map.of());
    }

    /**
     * Quita los saltos de línea del asunto. No es cosmética: con ellos, una variable
     * interpolada puede cerrar la cabecera Subject: y abrir otra.
     */
    private static String sanitizeSubject(String value) {
        return value == null ? null : value.replaceAll("[\\\\r\\\\n]", " ").trim();
    }

    /**
     * Las cabeceras propias se sanean AQUÍ y no en el adaptador, por lo mismo que el asunto: un
     * salto de línea en el valor abre otra cabecera, y ningún camino debe poder construir el
     * mensaje sin pasar por esto. El NOMBRE se valida en vez de sanearse: un nombre malformado o
     * reservado es un error de quien compone el mensaje, no un dato que haya que arreglar.
     */
    private static Map<String, String> sanitizeHeaders(Map<String, String> value) {
        if (value == null || value.isEmpty()) {
            return Map.of();
        }
        Map<String, String> clean = new LinkedHashMap<>();
        value.forEach((name, content) -> {
            if (name == null || !HEADER_NAME.matcher(name).matches()) {
                throw new IllegalArgumentException("Nombre de cabecera no válido: " + name);
            }
            String lower = name.toLowerCase(Locale.ROOT);
            if (RESERVED_HEADERS.contains(lower) || lower.startsWith("content-")) {
                throw new IllegalArgumentException("La cabecera " + name + " la compone el propio mensaje");
            }
            clean.put(name, content == null ? "" : content.replaceAll("[\\\\r\\\\n]", " ").trim());
        });
        return Collections.unmodifiableMap(clean);
    }
${attachments}}`;

  return {
    path: javaPath(model, DOMAIN_PKG, 'MailMessage'),
    content: javaFile(
      `${model.service.basePackage}.${DOMAIN_PKG}`,
      [
        'java.util.Collections',
        'java.util.LinkedHashMap',
        'java.util.List',
        'java.util.Locale',
        'java.util.Map',
        'java.util.Set',
        'java.util.regex.Pattern'
      ],
      body
    )
  };
}

// ─── El puerto ───────────────────────────────────────────────────────────────

function renderMailSenderPort(model) {
  const senders = model.mail.sentBy;
  const body = `/**
 * Salida de correo del servicio. Puerto de la capa APPLICATION: lo invocan los
 * handlers de ${senders.map((op) => `{@code ${op}}`).join(', ')} —las operaciones que
 * el diseño declara en {@code mail.sentBy}— y lo implementa un adaptador de
 * infraestructura.
 *
 * <p>Lo que este puerto <b>no</b> promete: que el correo llegue. Promete que se
 * entregó al proveedor. Que acabe en la bandeja de entrada depende de SPF, DKIM,
 * DMARC y de la reputación del remitente, que son trabajo de DNS y de proveedor y
 * no tienen equivalente en ninguna prueba local.
 */
public interface MailSender {

    /**
     * Entrega el mensaje al proveedor.
     *
     * @throws MailDeliveryException si el proveedor no lo acepta. Es una excepción
     *         y no un booleano a propósito: un envío que falla en silencio es un
     *         correo que nadie recibe y del que nadie se entera.
     */
    void send(MailMessage message);
}`;

  const exception = `/**
 * El proveedor no aceptó el mensaje, o no lo aceptó para TODOS los destinatarios. Envuelve la
 * causa del transporte para que la capa de aplicación no tenga que conocer jakarta.mail.
 *
 * <p><b>Un fallo puede ser parcial</b>, y el caso de uso tiene que poder distinguirlo sin
 * desenvolver la causa: el transporte envía con {@code mail.smtp.sendpartial=true}, así que si el
 * relay rechaza a un destinatario y acepta a otro, el correo SALE para los aceptados y aun así se
 * lanza esta excepción. Tratarla como «no salió» repetiría o daría por fallido un envío que ya
 * llegó. Por eso lleva quién lo recibió ({@link #accepted()}), a quién se rechazó
 * ({@link #rejected()}) y la respuesta del relay ({@link #detail()}). Sin envío parcial (un error
 * de conexión, un rechazo del remitente) {@code accepted()} está vacío.
 */
public class MailDeliveryException extends RuntimeException {

    private final Set<String> accepted;
    private final Set<String> rejected;
    private final String detail;

    public MailDeliveryException(String message, Throwable cause) {
        this(message, cause, Set.of(), Set.of(), cause == null ? null : cause.getMessage());
    }

    public MailDeliveryException(String message, Throwable cause, Set<String> accepted, Set<String> rejected, String detail) {
        super(message, cause);
        this.accepted = accepted == null ? Set.of() : Set.copyOf(accepted);
        this.rejected = rejected == null ? Set.of() : Set.copyOf(rejected);
        this.detail = detail;
    }

    /** Destinatarios a los que el relay SÍ entregó: si no está vacío, el correo salió para ellos. */
    public Set<String> accepted() {
        return accepted;
    }

    /** Destinatarios que el relay rechazó de forma definitiva (un 5xx a su RCPT TO). */
    public Set<String> rejected() {
        return rejected;
    }

    /** ¿El correo salió para alguno? Es la pregunta que decide el desenlace del envío. */
    public boolean partial() {
        return !accepted.isEmpty();
    }

    /** La respuesta del relay, para registrarla junto al desenlace; puede ser null. */
    public String detail() {
        return detail;
    }
}`;

  // Las dos piezas del contrato viajan juntas: un puerto que declara lanzar algo
  // que no existe no compila, y separarlas en dos módulos solo añade un sitio más
  // donde olvidarse de una.
  return [
    {
      path: javaPath(model, PORT_PKG, 'MailSender'),
      content: javaFile(
        `${model.service.basePackage}.${PORT_PKG}`,
        [`${model.service.basePackage}.${DOMAIN_PKG}.MailMessage`, `${model.service.basePackage}.${DOMAIN_PKG}.MailDeliveryException`],
        body
      )
    },
    {
      path: javaPath(model, DOMAIN_PKG, 'MailDeliveryException'),
      content: javaFile(`${model.service.basePackage}.${DOMAIN_PKG}`, ['java.util.Set'], exception)
    }
  ];
}

// ─── El adaptador SMTP ───────────────────────────────────────────────────────

function renderSmtpMailSender(model) {
  const mail = model.mail;
  const pkg = `${model.service.basePackage}.${INFRA_PKG}`;
  const imports = [
    `${model.service.basePackage}.${DOMAIN_PKG}.MailDeliveryException`,
    `${model.service.basePackage}.${DOMAIN_PKG}.MailMessage`,
    `${model.service.basePackage}.${PORT_PKG}.MailSender`,
    'jakarta.mail.Address',
    'jakarta.mail.MessagingException',
    'jakarta.mail.SendFailedException',
    'jakarta.mail.internet.InternetAddress',
    'jakarta.mail.internet.MimeMessage',
    'java.util.LinkedHashSet',
    'java.util.Set',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.beans.factory.annotation.Value',
    'org.springframework.mail.MailException',
    'org.springframework.mail.MailSendException',
    'org.springframework.mail.javamail.JavaMailSender',
    'org.springframework.mail.javamail.MimeMessageHelper',
    'org.springframework.stereotype.Component'
  ];
  if (mail.attachments) imports.push('org.springframework.core.io.ByteArrayResource');

  // El fallback del remitente y el reply-to fijo salen de la configuración, no de
  // constantes: el diseño los fija y el entorno puede moverlos sin recompilar.
  // Parámetros inyectados por CONSTRUCTOR, no por campo: un bean con la mitad de
  // su estado puesto por reflexión no se puede construir en una prueba sin un
  // contexto de Spring entero, y eso convierte cualquier verificación del
  // adaptador en una prueba de integración.
  const params = [];
  if (mail.sender.source === 'fixed') {
    params.push({ prop: 'mail.sender', field: 'configuredSender', optional: false });
  } else if (mail.sender.fallback) {
    params.push({ prop: 'mail.sender-fallback', field: 'senderFallback', optional: true });
  }
  if (mail.replyTo?.source === 'fixed') {
    params.push({ prop: 'mail.reply-to', field: 'configuredReplyTo', optional: true });
  }

  const paramFields = params.map(({ field }) => `
    private final String ${field};`).join('');
  const ctorParams = params
    .map(({ prop, field, optional }) => `,
            @Value("\${${prop}${optional ? ':' : ''}}") String ${field}`)
    .join('');
  const ctorAssigns = params.map(({ field }) => `
        this.${field} = ${field};`).join('');

  const resolveFrom =
    mail.sender.source === 'fixed'
      ? `        String from = configuredSender;`
      : mail.sender.fallback
        ? `        // El dato manda; el respaldo solo entra cuando no lo resuelve. Sin respaldo
        // declarado el diseño prefiere NO enviar antes que enviar desde una dirección
        // que nadie verificó ante el proveedor, y eso se ve abajo como un fallo.
        String from = hasText(message.from()) ? message.from() : senderFallback;`
        : `        String from = message.from();`;

  const fromGuard = `        if (!hasText(from)) {
            throw new MailDeliveryException(
                    "El mensaje no tiene remitente y el diseño no declara uno de respaldo: no se envía", null);
        }`;

  const replyToBlock =
    mail.replyTo?.source === 'fixed'
      ? `
            if (hasText(configuredReplyTo)) {
                helper.setReplyTo(configuredReplyTo);
            }`
      : mail.replyTo
        ? `
            if (hasText(message.replyTo())) {
                helper.setReplyTo(message.replyTo());
            }`
        : '';

  // multipart/alternative con las dos partes. No es por los clientes de texto
  // —quedan pocos— sino porque los filtros antispam desconfían de un HTML sin
  // alternativa textual, y eso no falla en ninguna prueba: se ve en la carpeta de
  // spam de quien lo recibe.
  const bodyBlock = mail.multipart
    ? `            // multipart/alternative: el cliente elige. El ORDEN importa —la parte
            // preferida va la última— y MimeMessageHelper#setText(text, html) ya lo
            // respeta.
            helper.setText(nullToEmpty(message.text()), nullToEmpty(message.html()));`
    : mail.hasHtml
      ? `            helper.setText(nullToEmpty(message.html()), true);`
      : `            helper.setText(nullToEmpty(message.text()), false);`;

  const attachmentsBlock = mail.attachments
    ? `
            for (MailMessage.Attachment attachment : message.attachments()) {
                helper.addAttachment(attachment.filename(),
                        new ByteArrayResource(attachment.content()), attachment.contentType());
            }`
    : '';

  const multipartFlag = mail.multipart || mail.attachments ? 'true' : 'false';

  const body = `/**
 * Entrega el correo por SMTP. Mismo adaptador en local (contra el Mailpit de
 * infra/) y en producción (contra el proveedor contratado): lo único que cambia son
 * los parámetros de {@code parameters/<perfil>/mail.yaml}, así que cambiar de
 * proveedor es cambiar variables de entorno y reiniciar, con el mismo binario.
 *
 * <p>El saneado del asunto NO está aquí: vive en el constructor de
 * {@link MailMessage}, para que ningún camino pueda saltárselo.
 */
@Component
public class SmtpMailSender implements MailSender {

    private static final Logger log = LoggerFactory.getLogger(SmtpMailSender.class);

    private final JavaMailSender javaMailSender;${paramFields}

    public SmtpMailSender(JavaMailSender javaMailSender${ctorParams}) {
        this.javaMailSender = javaMailSender;${ctorAssigns}
    }

    @Override
    public void send(MailMessage message) {
${resolveFrom}
${fromGuard}
        if (message.to().isEmpty()) {
            throw new MailDeliveryException("El mensaje no tiene destinatarios: no se envía", null);
        }

        try {
            MimeMessage mime = javaMailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, ${multipartFlag}, "UTF-8");
            helper.setFrom(from);
            helper.setTo(message.to().toArray(String[]::new));
            if (!message.cc().isEmpty()) {
                helper.setCc(message.cc().toArray(String[]::new));
            }
            helper.setSubject(nullToEmpty(message.subject()));${replyToBlock}
            // Cabeceras propias: nombre y valor ya vienen validados y saneados por el
            // constructor de MailMessage.
            for (var header : message.headers().entrySet()) {
                mime.addHeader(header.getKey(), header.getValue());
            }
${bodyBlock}${attachmentsBlock}
            javaMailSender.send(mime);
            log.info("Correo entregado al proveedor: destinatarios={} asunto=\\"{}\\"",
                    message.to().size(), message.subject());
        } catch (MailException | MessagingException e) {
            // Se envuelve y se relanza: un envío que falla en silencio es un correo
            // que nadie recibe y del que nadie se entera. Pero se dice A QUIÉN: con
            // sendpartial el relay puede haber entregado a unos y rechazado a otros, y
            // eso solo lo sabe el SendFailedException que viaja dentro.
            SendFailedException rejection = sendFailure(e);
            if (rejection == null) {
                throw new MailDeliveryException("El proveedor no aceptó el mensaje", e);
            }
            Set<String> accepted = addresses(rejection.getValidSentAddresses());
            Set<String> rejected = addresses(rejection.getInvalidAddresses());
            String detail = rejection.getNextException() != null
                    ? rejection.getNextException().getMessage()
                    : rejection.getMessage();
            throw new MailDeliveryException(
                    accepted.isEmpty() ? "El proveedor no aceptó el mensaje" : "El proveedor rechazó a parte de los destinatarios",
                    e, accepted, rejected, detail);
        }
    }

    /**
     * El SendFailedException de la cadena de causas, si lo hay. JavaMailSenderImpl lo envuelve
     * en un MailSendException, una entrada por mensaje; aquí se manda uno.
     */
    private static SendFailedException sendFailure(Exception e) {
        if (e instanceof MailSendException send) {
            for (Exception failure : send.getMessageExceptions()) {
                SendFailedException found = sendFailure(failure);
                if (found != null) {
                    return found;
                }
            }
        }
        for (Throwable cause = e; cause != null; cause = cause.getCause()) {
            if (cause instanceof SendFailedException failed) {
                return failed;
            }
        }
        return null;
    }

    private static Set<String> addresses(Address[] value) {
        Set<String> result = new LinkedHashSet<>();
        if (value != null) {
            for (Address address : value) {
                result.add(address instanceof InternetAddress internet ? internet.getAddress() : address.toString());
            }
        }
        return result;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}`;

  return { path: javaPath(model, INFRA_PKG, 'SmtpMailSender'), content: javaFile(pkg, imports, body) };
}

// ─── El renderizado ──────────────────────────────────────────────────────────

function renderTemplateRendererPort(model) {
  const external = usesExternalTemplates(model);
  const body = `/**
 * Interpola una plantilla con las variables de un envío.
 *
 * <p>${
   external
     ? 'El cuerpo de la plantilla es un <b>dato de este servicio</b>, no un recurso del\n * repositorio: lo escribe alguien que puede ser ajeno al equipo. De ahí que el\n * contrato hable de <i>fuente</i> y no de <i>nombre de plantilla</i> — no hay nada\n * que resolver en el classpath— y de ahí la restricción que la implementación tiene\n * que cumplir: <b>el motor no puede evaluar expresiones arbitrarias</b>.'
     : 'El cuerpo viaja con el código, versionado en el repositorio.'
 }
 *
 * <p>El escapado depende de la PARTE, y por eso la parte es un argumento y no una
 * convención de la clave: en {@link Part#HTML} las variables se escapan como HTML —un
 * dato que llegue con {@code <script>} tiene que escribirse como texto, porque hay
 * clientes de correo que ejecutan—; en {@link Part#TEXT} y {@link Part#SUBJECT} NO,
 * porque ahí no hay HTML que proteger y el escapado se vería: «Pedido &amp;amp; factura»
 * en el asunto. Con un solo motor el agente deshacía el escapado a mano en la parte de
 * texto, con pérdida, y el asunto seguía saliendo escapado (corrida notification-mailer
 * R8). Los saltos de línea del asunto los neutraliza el adaptador SMTP, no esto.
 */
public interface TemplateRenderer {

    /** Qué parte del correo se renderiza: decide el escapado. */
    enum Part { SUBJECT, TEXT, HTML }

    /**
     * @param part     la parte del correo: decide el escapado de las variables
     * @param cacheKey identidad estable de la plantilla (clave y versión), con la que
     *                 se cachea la compilación. Dos contenidos distintos no pueden
     *                 compartir clave: la caché serviría el viejo para siempre. La parte
     *                 NO hace falta ponerla en la clave: la añade la implementación.
     * @param source   el cuerpo literal de la plantilla, con sus llaves sin procesar
     * @param variables valores del envío
     * @return el resultado ya interpolado
     * @throws TemplateRenderException si la plantilla no compila o el renderizado falla
     */
    String render(Part part, String cacheKey, String source, Map<String, Object> variables);

    /**
     * Comprueba que la fuente compila, SIN cachearla. Es lo que usa la operación que da de
     * alta una plantilla para rechazarla antes de guardarla (el 422 que declare el diseño):
     * validar con {@link #render} y una clave nueva cada vez hacía crecer la caché sin límite.
     *
     * @throws TemplateRenderException si no compila
     */
    void compile(String source);
}`;

  const exception = `/**
 * La plantilla no compila o el renderizado falla. Se distingue del fallo de entrega
 * a propósito: aquí no se ha llegado a hablar con el proveedor, y el problema es del
 * contenido, no del transporte.
 */
public class TemplateRenderException extends RuntimeException {

    public TemplateRenderException(String message, Throwable cause) {
        super(message, cause);
    }
}`;

  return [
    {
      path: javaPath(model, PORT_PKG, 'TemplateRenderer'),
      content: javaFile(
        `${model.service.basePackage}.${PORT_PKG}`,
        ['java.util.Map', `${model.service.basePackage}.${DOMAIN_PKG}.TemplateRenderException`],
        body
      )
    },
    {
      path: javaPath(model, DOMAIN_PKG, 'TemplateRenderException'),
      content: javaFile(`${model.service.basePackage}.${DOMAIN_PKG}`, [], exception)
    }
  ];
}

function renderHandlebarsRenderer(model) {
  const pkg = `${model.service.basePackage}.${INFRA_PKG}`;
  const body = `/**
 * Renderizado con Handlebars. La elección de motor es una decisión de SEGURIDAD y
 * está razonada aquí porque es lo primero que alguien querría cambiar.
 *
 * <p>Lo natural en Spring sería Thymeleaf, pero Thymeleaf está pensado para
 * plantillas <i>que escribes tú</i>: evalúa expresiones SpEL, y SpEL puede invocar
 * métodos arbitrarios. Con plantillas que entran por una API y rellenan equipos
 * ajenos, eso es una ejecución remota de código esperando a suceder. Handlebars solo
 * sustituye variables, recorre listas y evalúa condiciones simples: no hay forma de
 * llamar a nada.
 *
 * <p>Se paga en expresividad, y es más una virtud que un defecto: el formato de un
 * importe tiene reglas de locale y se prueba mucho mejor en el sistema llamante que
 * dentro de una cadena de texto guardada en una fila. Las variables llegan ya
 * formateadas.
 *
 * <p><b>No se añaden helpers</b> que salgan de esa frontera (nada de {@code
 * StringHelpers} con acceso a la JVM, nada de resolvers de fichero): cada helper
 * nuevo es superficie que quien escribe la plantilla puede alcanzar.
 */
@Component
public class HandlebarsTemplateRenderer implements TemplateRenderer {

    /**
     * Dos motores sin resolvers: el cuerpo llega como cadena y no hay nada que buscar en
     * el classpath ni en disco (un resolver de fichero convertiría un {@code
     * {{> ../../etc/passwd}}} en una lectura de fichero). Difieren SOLO en el escapado:
     * HTML para la parte HTML, ninguno para el texto y el asunto.
     */
    private final Handlebars html = new Handlebars().with(HTML_FIVE);
    private final Handlebars plain = new Handlebars().with(EscapingStrategy.NOOP);

    /**
     * El escapado HTML, con una tabla CERRADA: {@code & < > " '} → {@code &amp; &lt; &gt; &quot;
     * &#39;}. Es el conjunto que basta para escribir un dato como texto dentro de un elemento o de un
     * atributo entrecomillado, y es contrato: un escenario que afirma el cuerpo HTML afirma
     * exactamente esto.
     *
     * <p>No es el de {@code new Handlebars()}, y la diferencia se ve: aquel escribe el apóstrofo
     * como {@code &#x27;} y escapa además {@code \`} y {@code =}, así que un {@code O'Hara} salía
     * {@code O&#x27;Hara} y el escenario que lo afirma con {@code &#39;} fallaba con un servidor
     * correcto (corrida notifications, 2026-09-30).
     */
    static final EscapingStrategy HTML_FIVE = new EscapingStrategy.Hbs(new String[][] {
        {"&", "&amp;"}, {"<", "&lt;"}, {">", "&gt;"}, {"\\"", "&quot;"}, {"'", "&#39;"}
    });

    /**
     * Un marcador simple —{@code {{ nombre }}}— se compila como {@code {{[nombre]}}}: el segmento
     * literal, que Handlebars resuelve SIEMPRE como variable.
     *
     * <p>Sin esto, el nombre de la variable compite con el motor: {@code else} y {@code true} no
     * compilan; {@code log}, {@code if}, {@code each}, {@code with} y {@code unless} se resuelven
     * como helpers y salen VACÍOS, sin error; y {@code this} o {@code lookup} vuelcan el mapa entero
     * de variables en el correo. Medido contra handlebars 4.4.0. El diseño no conoce esas palabras
     * —declara sus variables con su propio formato— y no tiene por qué: el motor es mecánica del
     * generador.
     *
     * <p>Si la plantilla usa bloques ({@code {{#…}}}, {@code {{^…}}}), {@code else} y {@code this}
     * conservan su sentido de Handlebars: ahí son sintaxis del bloque, no variables.
     */
    private static final Pattern SIMPLE_MARKER =
            Pattern.compile("(?<!\\\\{)\\\\{\\\\{\\\\s*([A-Za-z_][A-Za-z0-9_-]*)\\\\s*}}(?!})");

    static String literalMarkers(String source) {
        if (source == null) {
            return null;
        }
        boolean blocks = source.contains("{{#") || source.contains("{{^");
        return SIMPLE_MARKER.matcher(source).replaceAll(match -> {
            String name = match.group(1);
            if (blocks && (name.equals("else") || name.equals("this"))) {
                return Matcher.quoteReplacement(match.group());
            }
            return Matcher.quoteReplacement("{{[" + name + "]}}");
        });
    }

    /** Techo de la caché: las plantillas vivas de un servicio son decenas, no miles. */
    private static final int MAX_COMPILED = 500;

    /**
     * Compilación cacheada por parte + identidad de plantilla, en un LRU acotado. La parte
     * va en la clave porque el mismo texto compilado con uno u otro motor escapa distinto;
     * y el techo existe porque la clave la aporta quien llama —con la versión dentro—, así
     * que sin él cada versión publicada se quedaba en memoria para siempre.
     */
    private final Map<String, Template> compiled = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Template> eldest) {
                    return size() > MAX_COMPILED;
                }
            });

    @Override
    public String render(Part part, String cacheKey, String source, Map<String, Object> variables) {
        try {
            Handlebars engine = part == Part.HTML ? html : plain;
            Template template = compiled.computeIfAbsent(part + ":" + cacheKey, key -> compileWith(engine, source));
            return template.apply(variables == null ? Map.of() : variables);
        } catch (IOException | RuntimeException e) {
            throw new TemplateRenderException("No se pudo renderizar la plantilla " + cacheKey + " (" + part + ")", e);
        }
    }

    @Override
    public void compile(String source) {
        // La sintaxis es la misma para los dos motores: basta uno.
        compileWith(plain, source);
    }

    private static Template compileWith(Handlebars engine, String source) {
        try {
            return engine.compileInline(literalMarkers(source));
        } catch (IOException | RuntimeException e) {
            throw new TemplateRenderException("La plantilla no compila", e);
        }
    }
}`;

  return {
    path: javaPath(model, INFRA_PKG, 'HandlebarsTemplateRenderer'),
    content: javaFile(
      pkg,
      [
        'com.github.jknack.handlebars.EscapingStrategy',
        'com.github.jknack.handlebars.Handlebars',
        'com.github.jknack.handlebars.Template',
        'java.io.IOException',
        'java.util.Collections',
        'java.util.LinkedHashMap',
        'java.util.Map',
        'java.util.regex.Matcher',
        'java.util.regex.Pattern',
        'org.springframework.stereotype.Component',
        `${model.service.basePackage}.${DOMAIN_PKG}.TemplateRenderException`,
        `${model.service.basePackage}.${PORT_PKG}.TemplateRenderer`
      ],
      body
    )
  };
}
