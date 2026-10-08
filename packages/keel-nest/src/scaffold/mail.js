// Correo saliente (capa mail, incremento 12e). Como en keel-spring, aquí build genera TAMBIÉN el adaptador, y
// es deliberado: el transporte es SMTP en local y en producción —contra Mailpit y contra el proveedor, con el
// mismo código—, y lo que lleva dentro son dos defensas cuya ausencia no rompe ningún escenario: el correo
// sale igual, y sale mal.
//
//   · El saneado del asunto y de las cabeceras: un salto de línea dentro de una variable interpolada en el
//     Subject: permite INYECTAR CABECERAS SMTP (un Bcc: que nadie puso). Vive en el constructor de
//     MailMessage, para que ningún camino pueda construir un mensaje sin pasar por él.
//   · El escapado HTML de las variables, con la MISMA tabla cerrada que keel-spring (`& < > " '`): un dato que
//     llega con <script> se escribe como texto. Y solo en la parte HTML: en el texto y en el asunto el escapado
//     se vería («Pedido &amp; factura»).
//
// Y el motor: con `templating.source: data` el cuerpo es entrada de origen externo, así que no puede evaluar
// expresiones arbitrarias. Handlebars, como en keel-spring: solo sustituye, recorre y condiciona.
//
// Las claves de config/parameters/<perfil>/mail.yaml son de Nest, pero las VARIABLES de entorno son las de
// keel-spring (MAIL_HOST, MAIL_PORT…): el mismo .env sirve para los dos servidores del diseño.

import { DIRS, classPath, tsModule } from './render.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const MAIL_DIR = 'domain/mail';
const INFRA_DIR = 'infrastructure/mail';
const PROFILES = ['local', 'develop', 'production', 'test'];

export const MAIL_MESSAGE_TS = classPath(MAIL_DIR, 'MailMessage');
export const MAIL_DELIVERY_EXCEPTION_TS = classPath(MAIL_DIR, 'MailDeliveryException');
export const TEMPLATE_RENDER_EXCEPTION_TS = classPath(MAIL_DIR, 'TemplateRenderException');
export const MAIL_SENDER_TS = classPath(DIRS.portOut, 'MailSender');
export const TEMPLATE_RENDERER_TS = classPath(DIRS.portOut, 'TemplateRenderer');
export const SMTP_MAIL_SENDER_TS = `src/${INFRA_DIR}/smtp-mail-sender.ts`;
export const HANDLEBARS_RENDERER_TS = `src/${INFRA_DIR}/handlebars-template-renderer.ts`;
export const MAIL_SETTINGS_TS = `src/${INFRA_DIR}/mail-settings.ts`;
export const MAIL_MODULE_TS = `src/${INFRA_DIR}/mail-module.ts`;

export function usesMail(model) {
  return Boolean(model.layersPresent?.mail && model.mail);
}

/** ¿El diseño le atribuye a esta operación la salida por correo? (`mail.sentBy`) */
export function sendsMail(model, operation) {
  return usesMail(model) && (model.mail.sentBy ?? []).includes(operation.name);
}

export function generate(model) {
  if (!usesMail(model)) return [];
  const files = [
    { path: MAIL_MESSAGE_TS, content: mailMessageTs(model) },
    { path: MAIL_DELIVERY_EXCEPTION_TS, content: mailDeliveryExceptionTs() },
    { path: MAIL_SENDER_TS, content: mailSenderTs(model) },
    { path: SMTP_MAIL_SENDER_TS, content: smtpMailSenderTs(model) },
    { path: MAIL_SETTINGS_TS, content: mailSettingsTs(model) },
    { path: MAIL_MODULE_TS, content: mailModuleTs(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/mail.yaml`, content: mailYaml(model, profile) }))
  ];
  if (model.mail.templating) {
    files.push(
      { path: TEMPLATE_RENDER_EXCEPTION_TS, content: templateRenderExceptionTs() },
      { path: TEMPLATE_RENDERER_TS, content: templateRendererTs(model) },
      { path: HANDLEBARS_RENDERER_TS, content: handlebarsRendererTs() }
    );
  }
  return files;
}

// ─── El mensaje (dominio) ────────────────────────────────────────────────────

function mailMessageTs(model) {
  const mail = model.mail;
  const attachment = mail.attachments
    ? `
/**
 * Un archivo adjunto. Viaja en base64, que infla un 33%: el límite de tamaño del proveedor se cuenta sobre el
 * mensaje YA codificado, no sobre el fichero.
 */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}
`
    : '';
  const body = `${attachment}
export interface MailMessageProps {
  /** Remitente${mail.sender.source === 'data' ? ' (sale de un dato del servicio; null para usar el de respaldo)' : ' (lo pone la configuración: el diseño lo fija)'}. */
  readonly from?: string | null;
  /** Dirección de respuesta, o null para que se responda al remitente. */
  readonly replyTo?: string | null;
  readonly to: readonly string[];
  readonly cc?: readonly string[] | null;
  /** Asunto ya interpolado; se sanea al construir. */
  readonly subject: string | null;
  /** Cuerpo HTML${mail.hasHtml ? '' : ' (el diseño no lo declara: siempre null)'}. */
  readonly html?: string | null;
  /** Cuerpo en texto plano${mail.hasText ? '' : ' (el diseño no lo declara: siempre null)'}. */
  readonly text?: string | null;${mail.attachments ? '\n  readonly attachments?: readonly MailAttachment[] | null;' : ''}
  /**
   * Cabeceras propias (p. ej. un X-… con el id del envío, que el proveedor devuelve con el rebote). Se validan
   * los nombres y se sanean los valores al construir.
   */
  readonly headers?: Readonly<Record<string, string | null>> | null;
}

/**
 * Cabeceras que el propio mensaje ya gobierna con sus campos, o que compone el transporte. Una cabecera propia
 * con uno de estos nombres duplicaría o pisaría lo que dice el resto del mensaje: se rechaza al construir.
 */
const RESERVED_HEADERS = new Set(['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'mime-version', 'return-path']);

/** Nombre de cabecera (RFC 5322): imprimibles sin espacio ni dos puntos. */
const HEADER_NAME = /^[!-9;-~]+$/;

/**
 * Un correo listo para salir: destinatarios, asunto y cuerpo ya renderizados.
 *
 * Es un value object de DOMINIO y no un DTO de infraestructura: quien decide qué correo sale es el caso de
 * uso, y tiene que poder componerlo sin conocer el transporte. El adaptador solo lo traduce al protocolo.
 *
 * EL ASUNTO Y LAS CABECERAS SE SANEAN AQUÍ, no en el adaptador. Un \\r o un \\n dentro del asunto permite
 * inyectar cabeceras SMTP —un Bcc: que nadie puso—, y ponerlo en el constructor significa que NINGÚN camino
 * puede construir un mensaje sin sanear, tampoco uno que se escriba después y no pase por el adaptador de hoy.
 */
export class MailMessage {
  readonly from: string | null;
  readonly replyTo: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
  readonly html: string | null;
  readonly text: string | null;${mail.attachments ? '\n  readonly attachments: readonly MailAttachment[];' : ''}
  readonly headers: Readonly<Record<string, string>>;

  constructor(props: MailMessageProps) {
    this.from = props.from ?? null;
    this.replyTo = props.replyTo ?? null;
    this.to = Object.freeze([...(props.to ?? [])]);
    this.cc = Object.freeze([...(props.cc ?? [])]);
    this.subject = sanitizeSubject(props.subject);
    this.html = props.html ?? null;
    this.text = props.text ?? null;${mail.attachments ? '\n    this.attachments = Object.freeze([...(props.attachments ?? [])]);' : ''}
    this.headers = sanitizeHeaders(props.headers);
    Object.freeze(this);
  }
}

/** Quita los saltos de línea del asunto. No es cosmética: con ellos, una variable cierra Subject: y abre otra. */
function sanitizeSubject(value: string | null | undefined): string | null {
  return value == null ? null : value.replace(/[\\r\\n]/g, ' ').trim();
}

/**
 * El NOMBRE se valida en vez de sanearse: uno malformado o reservado es un error de quien compone el mensaje,
 * no un dato que haya que arreglar. El VALOR se sanea, por lo mismo que el asunto.
 */
function sanitizeHeaders(value: Readonly<Record<string, string | null>> | null | undefined): Readonly<Record<string, string>> {
  const clean: Record<string, string> = {};
  for (const [name, content] of Object.entries(value ?? {})) {
    if (!HEADER_NAME.test(name)) throw new Error(\`Nombre de cabecera no válido: \${name}\`);
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith('content-')) throw new Error(\`La cabecera \${name} la compone el propio mensaje\`);
    clean[name] = (content ?? '').replace(/[\\r\\n]/g, ' ').trim();
  }
  return Object.freeze(clean);
}`;
  return tsModule(MAIL_MESSAGE_TS, [], body);
}

function mailDeliveryExceptionTs() {
  const body = `/**
 * El proveedor no aceptó el mensaje, o no lo aceptó para TODOS los destinatarios. Envuelve la causa del
 * transporte para que la capa de aplicación no tenga que conocerlo.
 *
 * UN FALLO PUEDE SER PARCIAL, y el caso de uso tiene que poder distinguirlo sin desenvolver la causa: si el
 * relay rechaza a un destinatario y acepta a otro, el correo SALE para los aceptados y aun así se lanza esta
 * excepción. Tratarla como «no salió» repetiría o daría por fallido un envío que ya llegó. Por eso lleva
 * quién lo recibió (accepted), a quién se rechazó (rejected) y la respuesta del relay (detail). Sin envío
 * parcial (un error de conexión, un rechazo del remitente) accepted está vacío. Es lo mismo que el
 * MailDeliveryException de keel-spring.
 */
export class MailDeliveryException extends Error {
  readonly accepted: ReadonlySet<string>;
  readonly rejected: ReadonlySet<string>;
  readonly detail: string | null;

  constructor(
    message: string,
    cause?: unknown,
    accepted: Iterable<string> = [],
    rejected: Iterable<string> = [],
    detail: string | null = cause instanceof Error ? cause.message : null
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MailDeliveryException';
    this.accepted = new Set(accepted);
    this.rejected = new Set(rejected);
    this.detail = detail;
  }

  /** ¿El correo salió para alguno? Es la pregunta que decide el desenlace del envío. */
  partial(): boolean {
    return this.accepted.size > 0;
  }
}`;
  return tsModule(MAIL_DELIVERY_EXCEPTION_TS, [], body);
}

function templateRenderExceptionTs() {
  const body = `/**
 * La plantilla no compila o el renderizado falla. Se distingue del fallo de entrega a propósito: aquí no se ha
 * llegado a hablar con el proveedor, y el problema es del contenido, no del transporte.
 */
export class TemplateRenderException extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TemplateRenderException';
  }
}`;
  return tsModule(TEMPLATE_RENDER_EXCEPTION_TS, [], body);
}

// ─── Los puertos (application/port/out) ──────────────────────────────────────

function mailSenderTs(model) {
  const body = `/**
 * Salida de correo del servicio. Puerto de la capa application: lo invocan los handlers de ${model.mail.sentBy.join(', ')}
 * —las operaciones que el diseño declara en mail.sentBy— y lo implementa un adaptador de infraestructura.
 *
 * Lo que este puerto NO promete: que el correo llegue. Promete que se entregó al proveedor. Que acabe en la
 * bandeja de entrada depende de SPF, DKIM, DMARC y de la reputación del remitente, que no tienen equivalente
 * en ninguna prueba local.
 */
export abstract class MailSender {
  /**
   * Entrega el mensaje al proveedor.
   *
   * Lanza MailDeliveryException si el proveedor no lo acepta (o no para todos). Es una excepción y no un
   * booleano a propósito: un envío que falla en silencio es un correo que nadie recibe y del que nadie se entera.
   */
  abstract send(message: MailMessage): Promise<void>;
}`;
  return tsModule(MAIL_SENDER_TS, [{ symbol: 'MailMessage', from: MAIL_MESSAGE_TS, type: true }], body);
}

function templateRendererTs(model) {
  const external = model.mail.templating?.externalContent === true;
  const body = `/** Qué parte del correo se renderiza: decide el escapado. */
export enum TemplatePart {
  SUBJECT = 'SUBJECT',
  TEXT = 'TEXT',
  HTML = 'HTML'
}

/**
 * Interpola una plantilla con las variables de un envío.
 *
 * ${
    external
      ? `El cuerpo de la plantilla es un DATO de este servicio, no un recurso del repositorio: lo escribe alguien que
 * puede ser ajeno al equipo. De ahí que el contrato hable de fuente y no de nombre de plantilla, y de ahí la
 * restricción que la implementación tiene que cumplir: el motor no puede evaluar expresiones arbitrarias.`
      : 'El cuerpo viaja con el código, versionado en el repositorio.'
  }
 *
 * El escapado depende de la PARTE, y por eso la parte es un argumento: en HTML las variables se escapan —un
 * dato con <script> se escribe como texto, porque hay clientes de correo que ejecutan—; en TEXT y SUBJECT NO,
 * porque ahí no hay HTML que proteger y el escapado se vería («Pedido &amp; factura» en el asunto). Los saltos
 * de línea del asunto los neutraliza MailMessage, no esto.
 */
export abstract class TemplateRenderer {
  /**
   * @param part      la parte del correo: decide el escapado de las variables
   * @param cacheKey  identidad estable de la plantilla (clave y versión), con la que se cachea la compilación.
   *                  Dos contenidos distintos no pueden compartir clave: la caché serviría el viejo para siempre.
   *                  La parte no hace falta ponerla: la añade la implementación.
   * @param source    el cuerpo literal de la plantilla, con sus llaves sin procesar
   * @param variables valores del envío
   * Lanza TemplateRenderException si la plantilla no compila o el renderizado falla.
   */
  abstract render(part: TemplatePart, cacheKey: string, source: string, variables: Readonly<Record<string, unknown>> | null): string;

  /**
   * Comprueba que la fuente compila, SIN cachearla. Es lo que usa la operación que da de alta una plantilla
   * para rechazarla antes de guardarla (el error que declare el diseño): validar con render() y una clave
   * nueva cada vez haría crecer la caché sin límite. Lanza TemplateRenderException si no compila.
   */
  abstract compile(source: string): void;
}`;
  return tsModule(TEMPLATE_RENDERER_TS, [], body);
}

// ─── El adaptador SMTP ───────────────────────────────────────────────────────

function smtpMailSenderTs(model) {
  const mail = model.mail;
  const resolveFrom =
    mail.sender.source === 'fixed'
      ? '    const from = this.settings.sender;'
      : mail.sender.fallback
        ? `    // El dato manda; el respaldo solo entra cuando no lo resuelve. Sin respaldo declarado el diseño prefiere
    // NO enviar antes que enviar desde una dirección que nadie verificó ante el proveedor.
    const from = hasText(message.from) ? message.from : this.settings.senderFallback;`
        : '    const from = message.from;';
  const replyTo =
    mail.replyTo?.source === 'fixed'
      ? '\n      replyTo: hasText(this.settings.replyTo) ? this.settings.replyTo! : undefined,'
      : mail.replyTo
        ? '\n      replyTo: hasText(message.replyTo) ? message.replyTo! : undefined,'
        : '';
  // multipart/alternative con las dos partes: los filtros antispam desconfían de un HTML sin alternativa
  // textual, y eso no falla en ninguna prueba: se ve en la carpeta de spam de quien lo recibe.
  const bodyLines = mail.multipart
    ? "\n      // multipart/alternative: el cliente elige (nodemailer pone el texto primero y el HTML, la preferida, al final).\n      text: message.text ?? '',\n      html: message.html ?? '',"
    : mail.hasHtml
      ? "\n      html: message.html ?? '',"
      : "\n      text: message.text ?? '',";
  const attachments = mail.attachments
    ? '\n      attachments: message.attachments.map((attachment) => ({ filename: attachment.filename, contentType: attachment.contentType, content: Buffer.from(attachment.content) })),'
    : '';
  const body = `/**
 * Entrega el correo por SMTP. Mismo adaptador en local (contra el Mailpit de infra/) y en producción (contra el
 * proveedor contratado): lo único que cambia son los parámetros de config/parameters/<perfil>/mail.yaml, así
 * que cambiar de proveedor es cambiar variables de entorno y reiniciar.
 *
 * El saneado del asunto NO está aquí: vive en el constructor de MailMessage, para que ningún camino pueda saltárselo.
 */
@Injectable()
export class SmtpMailSender extends MailSender {
  private readonly logger = new Logger(SmtpMailSender.name);
  private readonly transport: Transporter;

  constructor(@Inject(MAIL_SETTINGS) private readonly settings: MailSettings) {
    super();
    this.transport = createTransport({
      host: settings.host,
      port: settings.port,
      secure: false,
      // STARTTLS: exigido donde la configuración lo pide; en local y test, Mailpit no lo ofrece.
      requireTLS: settings.starttls,
      ignoreTLS: !settings.starttls,
      auth: settings.auth && hasText(settings.username) ? { user: settings.username, pass: settings.password } : undefined,
      // Un envío que se queda esperando a un proveedor caído retiene a quien lo hace: los mismos tres plazos
      // que keel-spring (conexión, lectura del saludo y de cada respuesta, y escritura).
      connectionTimeout: settings.connectTimeoutMs,
      greetingTimeout: settings.readTimeoutMs,
      socketTimeout: Math.max(settings.readTimeoutMs, settings.writeTimeoutMs)
    });
  }

  async send(message: MailMessage): Promise<void> {
${resolveFrom}
    if (!hasText(from)) {
      throw new MailDeliveryException('El mensaje no tiene remitente y el diseño no declara uno de respaldo: no se envía');
    }
    if (message.to.length === 0) {
      throw new MailDeliveryException('El mensaje no tiene destinatarios: no se envía');
    }
    let info: { accepted?: unknown[]; rejected?: unknown[]; response?: string };
    try {
      info = await this.transport.sendMail({
        from: from!,
        to: [...message.to],
        cc: message.cc.length > 0 ? [...message.cc] : undefined,
        subject: message.subject ?? '',${replyTo}
        // Cabeceras propias: nombre y valor ya vienen validados y saneados por MailMessage.
        headers: { ...message.headers },${bodyLines}${attachments}
      });
    } catch (error) {
      // Se envuelve y se relanza: un envío que falla en silencio es un correo que nadie recibe. Con TODOS los
      // destinatarios rechazados el error trae la lista; sin ella (conexión, remitente) no salió para nadie.
      const rejected = addresses((error as { rejected?: unknown[] })?.rejected);
      throw new MailDeliveryException('El proveedor no aceptó el mensaje', error, [], rejected, detailOf(error));
    }
    // Envío PARCIAL: el relay entregó a unos y rechazó a otros. El correo SALIÓ para los aceptados, y aun así se
    // lanza, diciendo a quién llegó y a quién no (lo mismo que keel-spring con sendpartial).
    const rejected = addresses(info.rejected);
    if (rejected.length > 0) {
      const errors = (info as { rejectedErrors?: { response?: string }[] }).rejectedErrors ?? [];
      throw new MailDeliveryException(
        'El proveedor rechazó a parte de los destinatarios',
        undefined,
        addresses(info.accepted),
        rejected,
        errors.map((failure) => failure.response).filter(Boolean).join('; ') || null
      );
    }
    this.logger.log(\`Correo entregado al proveedor: destinatarios=\${message.to.length} asunto="\${message.subject ?? ''}"\`);
  }
}

function addresses(value: unknown[] | undefined): string[] {
  return (value ?? []).map((address) => (typeof address === 'string' ? address : String((address as { address?: string })?.address ?? address)));
}

function detailOf(error: unknown): string | null {
  const response = (error as { response?: string })?.response;
  if (hasText(response)) return response!;
  return error instanceof Error ? error.message : null;
}

function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim() !== '';
}`;
  return tsModule(
    SMTP_MAIL_SENDER_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'createTransport', from: 'nodemailer' },
      { symbol: 'Transporter', from: 'nodemailer', type: true },
      { symbol: 'MailMessage', from: MAIL_MESSAGE_TS, type: true },
      { symbol: 'MailDeliveryException', from: MAIL_DELIVERY_EXCEPTION_TS },
      { symbol: 'MailSender', from: MAIL_SENDER_TS },
      { symbol: 'MAIL_SETTINGS', from: MAIL_SETTINGS_TS },
      { symbol: 'MailSettings', from: MAIL_SETTINGS_TS, type: true }
    ],
    body
  );
}

// ─── El renderizador ─────────────────────────────────────────────────────────

function handlebarsRendererTs() {
  const body = `/**
 * El escapado HTML, con una tabla CERRADA: & < > " ' → &amp; &lt; &gt; &quot; &#39;. Es el conjunto que basta
 * para escribir un dato como texto dentro de un elemento o de un atributo entrecomillado, y es CONTRATO: un
 * escenario que afirma el cuerpo HTML afirma exactamente esto, en los dos servidores del diseño.
 *
 * No es el de Handlebars por defecto: aquel escribe el apóstrofo como &#x27; y escapa además \\\` y =, así que un
 * O'Hara salía O&#x27;Hara y el escenario que lo afirma con &#39; fallaba con un servidor correcto (la misma
 * corrida que corrigió el de keel-spring). Handlebars no admite un escapado por instancia: el runtime lee el
 * de Handlebars.Utils, así que se instala UNA vez, aquí, en el único sitio del servicio que usa Handlebars.
 */
const HTML_FIVE: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtmlFive(value: unknown): string {
  if (typeof value !== 'string') {
    if (value != null && typeof (value as { toHTML?: unknown }).toHTML === 'function') return (value as { toHTML(): string }).toHTML();
    if (value == null) return '';
    if (!value) return String(value);
    value = String(value);
  }
  return (value as string).replace(/[&<>"']/g, (char) => HTML_FIVE[char]!);
}
(Handlebars.Utils as { escapeExpression: (value: unknown) => string }).escapeExpression = escapeHtmlFive;

/**
 * Un marcador simple —{{ nombre }}— se compila como {{this.[nombre]}}: el segmento literal, que Handlebars
 * resuelve SIEMPRE como variable del contexto.
 *
 * Sin esto, el nombre de la variable compite con el motor: else no compila; if, each, with, unless y log se
 * resuelven como helpers (y fallan o salen vacíos); y this o lookup vuelcan el mapa entero de variables en el
 * correo. En Handlebars para JavaScript ni siquiera basta {{[if]}} —sigue llamando al helper—: hace falta el
 * this. delante. El diseño no conoce esas palabras y no tiene por qué: el motor es mecánica del generador.
 *
 * Si la plantilla usa bloques ({{#…}}, {{^…}}), else y this conservan su sentido: ahí son sintaxis del bloque.
 */
const SIMPLE_MARKER = /(?<!\\{)\\{\\{\\s*([A-Za-z_][A-Za-z0-9_-]*)\\s*\\}\\}(?!\\})/g;

export function literalMarkers(source: string): string {
  const blocks = source.includes('{{#') || source.includes('{{^');
  return source.replace(SIMPLE_MARKER, (match, name: string) => {
    if (blocks && (name === 'else' || name === 'this')) return match;
    return \`{{this.[\${name}]}}\`;
  });
}

/** Techo de la caché: las plantillas vivas de un servicio son decenas, no miles. */
const MAX_COMPILED = 500;

/**
 * Renderizado con Handlebars. La elección de motor es una decisión de SEGURIDAD: un motor que evalúa
 * expresiones (o que puede llamar a código) con plantillas que entran por una API y rellenan equipos ajenos
 * es una ejecución remota de código esperando a suceder. Handlebars solo sustituye variables, recorre listas y
 * evalúa condiciones simples, y desde la 4.6 no deja acceder al prototipo de los objetos.
 *
 * NO SE AÑADEN HELPERS ni partials: cada uno nuevo es superficie que quien escribe la plantilla puede alcanzar.
 * Las variables llegan ya formateadas (un importe tiene reglas de locale que se prueban mejor en el llamante).
 */
@Injectable()
export class HandlebarsTemplateRenderer extends TemplateRenderer {
  /**
   * Un entorno propio, sin helpers registrados por nadie más: el global de Handlebars lo comparte todo el proceso.
   */
  private readonly engine = Handlebars.create();

  /**
   * Compilación cacheada por parte + identidad de plantilla, en un LRU acotado. La parte va en la clave porque
   * el mismo texto compilado escapa distinto; y el techo existe porque la clave la aporta quien llama —con la
   * versión dentro—, así que sin él cada versión publicada se quedaría en memoria para siempre.
   */
  private readonly compiled = new Map<string, HandlebarsTemplateDelegate>();

  render(part: TemplatePart, cacheKey: string, source: string, variables: Readonly<Record<string, unknown>> | null): string {
    const key = \`\${part}:\${cacheKey}\`;
    try {
      let template = this.compiled.get(key);
      if (template) {
        // LRU: lo usado pasa al final; lo que sale es lo de delante.
        this.compiled.delete(key);
      } else {
        template = this.compileWith(part, source);
      }
      this.compiled.set(key, template);
      if (this.compiled.size > MAX_COMPILED) this.compiled.delete(this.compiled.keys().next().value!);
      return template({ ...(variables ?? {}) });
    } catch (error) {
      if (error instanceof TemplateRenderException) throw error;
      throw new TemplateRenderException(\`No se pudo renderizar la plantilla \${cacheKey} (\${part})\`, error);
    }
  }

  compile(source: string): void {
    // precompile y no compile: compile es PEREZOSO y solo falla al renderizar por primera vez.
    try {
      this.engine.precompile(literalMarkers(source ?? ''));
    } catch (error) {
      throw new TemplateRenderException('La plantilla no compila', error);
    }
  }

  private compileWith(part: TemplatePart, source: string): HandlebarsTemplateDelegate {
    this.compile(source);
    // HTML: el escapado de la tabla cerrada. TEXT y SUBJECT: ninguno.
    return this.engine.compile(literalMarkers(source ?? ''), { noEscape: part !== TemplatePart.HTML });
  }
}`;
  return tsModule(
    HANDLEBARS_RENDERER_TS,
    [
      { symbol: 'Injectable', from: '@nestjs/common' },
      { default: 'Handlebars', from: 'handlebars' },
      { symbol: 'TemplateRenderer', from: TEMPLATE_RENDERER_TS },
      { symbol: 'TemplatePart', from: TEMPLATE_RENDERER_TS },
      { symbol: 'TemplateRenderException', from: TEMPLATE_RENDER_EXCEPTION_TS }
    ],
    body
  );
}

// ─── Configuración y módulo ──────────────────────────────────────────────────

function mailSettingsTs(model) {
  const mail = model.mail;
  const lines = [
    "    host: text(configuration, 'mail.host') ?? 'localhost',",
    "    port: number(configuration, 'mail.port', 1025),",
    "    username: text(configuration, 'mail.username') ?? '',",
    "    password: text(configuration, 'mail.password') ?? '',",
    "    auth: flag(configuration, 'mail.smtp.auth', true),",
    "    starttls: flag(configuration, 'mail.smtp.starttls', true),",
    "    connectTimeoutMs: number(configuration, 'mail.smtp.connect-timeout-ms', 5000),",
    "    readTimeoutMs: number(configuration, 'mail.smtp.read-timeout-ms', 5000),",
    "    writeTimeoutMs: number(configuration, 'mail.smtp.write-timeout-ms', 5000),",
    `    sender: ${mail.sender.source === 'fixed' ? "text(configuration, 'mail.sender')" : 'null'},`,
    `    senderFallback: ${mail.sender.source !== 'fixed' && mail.sender.fallback ? "text(configuration, 'mail.sender-fallback')" : 'null'},`,
    `    replyTo: ${mail.replyTo?.source === 'fixed' ? "text(configuration, 'mail.reply-to')" : 'null'}`
  ];
  const body = `/** Token de la configuración del correo ya resuelta. */
export const MAIL_SETTINGS = Symbol('MAIL_SETTINGS');

/** Lo que el adaptador SMTP lee de config/parameters/<perfil>/mail.yaml (las variables de keel-spring). */
export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly auth: boolean;
  readonly starttls: boolean;
  readonly connectTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly writeTimeoutMs: number;
  /** Remitente fijo (mail.sender.source: fixed), o null. */
  readonly sender: string | null;
  /** Remitente de respaldo cuando el dato del servicio no lo resuelve, o null. */
  readonly senderFallback: string | null;
  /** Reply-To fijo (mail.replyTo.source: fixed), o null. */
  readonly replyTo: string | null;
}

export function mailSettings(configuration: Configuration): MailSettings {
  return {
${lines.join('\n')}
  };
}

function text(configuration: Configuration, key: string): string | null {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? null : String(value);
}

function number(configuration: Configuration, key: string, fallback: number): number {
  const value = text(configuration, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(\`\${key} tiene que ser un número no negativo: '\${value}'\`);
  return parsed;
}

function flag(configuration: Configuration, key: string, fallback: boolean): boolean {
  const value = text(configuration, key);
  return value == null ? fallback : value.toLowerCase() === 'true';
}`;
  return tsModule(MAIL_SETTINGS_TS, [{ symbol: 'Configuration', from: CONFIG_TS, type: true }], body);
}

function mailModuleTs(model) {
  const templating = Boolean(model.mail.templating);
  const imports = [
    { symbol: 'Global', from: '@nestjs/common' },
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: CONFIG_TS, type: true },
    { symbol: 'MAIL_SETTINGS', from: MAIL_SETTINGS_TS },
    { symbol: 'mailSettings', from: MAIL_SETTINGS_TS },
    { symbol: 'MailSender', from: MAIL_SENDER_TS },
    { symbol: 'SmtpMailSender', from: SMTP_MAIL_SENDER_TS }
  ];
  const providers = ['{ provide: MAIL_SETTINGS, useValue: mailSettings(configuration) }', '{ provide: MailSender, useClass: SmtpMailSender }'];
  const exports = ['MailSender'];
  if (templating) {
    imports.push({ symbol: 'TemplateRenderer', from: TEMPLATE_RENDERER_TS }, { symbol: 'HandlebarsTemplateRenderer', from: HANDLEBARS_RENDERER_TS });
    providers.push('{ provide: TemplateRenderer, useClass: HandlebarsTemplateRenderer }');
    exports.push('TemplateRenderer');
  }
  const body = `/**
 * El correo saliente: el adaptador SMTP${templating ? ' y el renderizador de plantillas' : ''}, con la configuración del perfil. Global: los
 * handlers de application inyectan los puertos sin importarlo.
 */
@Global()
@Module({})
export class MailModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: MailModule,
      providers: [
        ${providers.join(',\n        ')}
      ],
      exports: [${exports.join(', ')}]
    };
  }
}`;
  return tsModule(MAIL_MODULE_TS, imports, body);
}

/** config/parameters/<perfil>/mail.yaml: las mismas variables y defaults que el mail.yaml de keel-spring. */
function mailYaml(model, profile) {
  const mail = model.mail;
  const localish = profile === 'local' || profile === 'test';
  const lines = [
    'mail:',
    `  host: ${envValue(profile, 'MAIL_HOST', 'localhost')}`,
    `  port: ${envValue(profile, 'MAIL_PORT', 1025)}`,
    `  username: ${envValue(profile, 'MAIL_USERNAME', '')}`,
    `  password: ${envValue(profile, 'MAIL_PASSWORD', '')}`,
    '  smtp:'
  ];
  if (localish) {
    // Mailpit no exige ni autenticación ni cifrado, y pedirlos haría fallar el envío contra la infra de prueba.
    lines.push('    auth: false', '    starttls: false');
  } else {
    lines.push(`    auth: ${envWithDefault(profile, 'MAIL_SMTP_AUTH', true)}`, `    starttls: ${envWithDefault(profile, 'MAIL_SMTP_STARTTLS', true)}`);
  }
  lines.push(
    '    # Un envío esperando a un proveedor caído retiene a quien lo hace: sin plazos esperaría para siempre.',
    `    connect-timeout-ms: ${envWithDefault(profile, 'MAIL_CONNECT_TIMEOUT_MS', 5000)}`,
    `    read-timeout-ms: ${envWithDefault(profile, 'MAIL_READ_TIMEOUT_MS', 5000)}`,
    `    write-timeout-ms: ${envWithDefault(profile, 'MAIL_WRITE_TIMEOUT_MS', 5000)}`
  );
  if (mail.sender?.source === 'fixed') {
    lines.push(`  sender: ${envValue(profile, 'MAIL_SENDER', mail.sender.address)}`);
  } else if (mail.sender?.fallback) {
    lines.push('  # Remitente de respaldo: se usa cuando el dato del servicio no lo resuelve.', `  sender-fallback: ${envValue(profile, 'MAIL_SENDER_FALLBACK', mail.sender.fallback)}`);
  }
  if (mail.replyTo?.source === 'fixed') lines.push(`  reply-to: ${envValue(profile, 'MAIL_REPLY_TO', mail.replyTo.address)}`);
  return `${lines.join('\n')}\n`;
}

function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return value === '' ? "''" : String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

function envWithDefault(profile, name, value) {
  if (profile === 'local') return String(value);
  return `\${${name}:${value}}`;
}

/** Para quien compone los avisos: los nombres de los puertos que el handler recibe inyectados. */
export function mailPorts(model) {
  if (!usesMail(model)) return [];
  return [
    { symbol: 'MailSender', from: MAIL_SENDER_TS },
    ...(model.mail.templating ? [{ symbol: 'TemplateRenderer', from: TEMPLATE_RENDERER_TS }] : [])
  ];
}
