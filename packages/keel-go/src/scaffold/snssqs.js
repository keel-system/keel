// SNS/SQS en keel-go (tramo 9g): lo que en el servidor de keel-spring ponen Spring Cloud AWS, build y la skill
// keel-spring-snssqs, en el paquete `internal/infrastructure/snssqs`. El gemelo de `snssqs.js` de keel-dotnet y keel-nest:
//
//   · el CONSUMO como datos (consumption.go), de keel-core (gen/messaging-plan.js, `snsSqsConsumption`): por
//     suscripción, su cola propia, su DLQ y su `maxReceiveCount` —los MISMOS que siembra `infra/init-messaging.sh`—, y la
//     curva del reintento, que en SQS no la aplica la cola sino quien alarga la VISIBILIDAD del mensaje;
//   · la CONEXIÓN (connection.go) sobre el SDK de AWS para Go (aws-sdk-go-v2, sns y sqs): las mismas variables que
//     keel-spring (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SNS_ENDPOINT, AWS_SQS_ENDPOINT); la
//     publicación en SNS con el tipo del evento como message attribute `eventType` y el ARN resuelto LISTANDO y exigiendo
//     un suscriptor confirmado —crear el topic al publicar publica en un topic sin suscriptores, y SNS descarta sin
//     error—; y un consumidor por suscripción (`Consume`, bloqueante: un listener del errgroup) que sondea su cola: borra
//     al terminar bien, alarga la visibilidad con la curva del diseño lo transitorio (y al agotar `maxReceiveCount` la
//     RedrivePolicy lo lleva a la DLQ), y lo no reintentable lo lleva él mismo a la DLQ.
//
// En AWS real la topología la crea la plataforma (IaC), no la aplicación. Lo que escribe el agente (skill keel-go-snssqs)
// es lo mismo que en keel-spring: el messaging.Dispatcher del outbox o los publishers best-effort sobre
// `Connection.Publish`, y un listener por suscripción sobre `Connection.Consume`, en cmd/server/broker.go.

import {
  SNSSQS_RECONNECT_INTERVAL_MS,
  SNS_MAX_ATTEMPTS,
  SNS_REQUEST_TIMEOUT_MS,
  SQS_MAX_MESSAGES,
  SQS_POLL_WAIT_SECONDS,
  snsSqsConsumption,
  snssqsYaml
} from '@keel-system/keel-core/gen/messaging-plan';
import { alignRows, goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { MESSAGING_IMPORT, usesGoMessaging } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const AWS = 'github.com/aws/aws-sdk-go-v2/aws';
const AWS_HTTP = { path: 'github.com/aws/aws-sdk-go-v2/aws/transport/http', name: 'awshttp' };
const AWS_CONFIG = 'github.com/aws/aws-sdk-go-v2/config';
const AWS_CREDENTIALS = 'github.com/aws/aws-sdk-go-v2/credentials';
const SNS = 'github.com/aws/aws-sdk-go-v2/service/sns';
const SNS_TYPES = { path: 'github.com/aws/aws-sdk-go-v2/service/sns/types', name: 'snstypes' };
const SQS = 'github.com/aws/aws-sdk-go-v2/service/sqs';
const SQS_TYPES = { path: 'github.com/aws/aws-sdk-go-v2/service/sqs/types', name: 'sqstypes' };
export const SNSSQS_IMPORT = 'internal/infrastructure/snssqs';

/** El techo de la visibilidad de un mensaje en SQS: doce horas. */
const MAX_VISIBILITY_SECONDS = 43200;

/** ¿Genera el servicio la conexión con SNS/SQS? */
export function usesGoSnsSqs(model) {
  return usesGoMessaging(model) && model.stack?.broker === 'snssqs';
}

export function generate(model) {
  if (!usesGoSnsSqs(model)) return [];
  const { snssqs } = layout(model);
  const file = (name, imports, body, { test = false } = {}) => ({
    path: `${snssqs.dir}/${name}${test ? '_test' : ''}.go`,
    content: packageFile(model, snssqs, { imports, body, test, doc: name === 'doc' ? PACKAGE_DOC : null })
  });
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/snssqs.yaml`, content: snssqsYaml(profile) })),
    file('doc', [], ''),
    file('consumption', ['errors', 'math', 'slices', 'time', 'internal/domain', MESSAGING_IMPORT], consumptionBody(model)),
    file('settings', ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], settingsBody()),
    file(
      'connection',
      ['context', 'errors', 'fmt', 'log/slog', 'strconv', 'strings', 'sync', 'time', AWS, AWS_HTTP, AWS_CONFIG, AWS_CREDENTIALS, SNS, SNS_TYPES, SQS, SQS_TYPES, MESSAGING_IMPORT],
      connectionBody()
    ),
    file('snssqs', ['errors', 'fmt', 'strings', 'testing', 'testing/fstest', 'time', 'internal/domain', 'internal/platform/config', MESSAGING_IMPORT, SNSSQS_IMPORT], emittedTest(model), {
      test: true
    })
  ];
}

const PACKAGE_DOC = `Package snssqs es la conexión del servicio con SNS/SQS: el consumo que declara build (las mismas colas, DLQ y
recepciones que siembra infra/init-messaging.sh y que consume el servidor de keel-spring del diseño), la publicación en
SNS con el tipo como message attribute y el consumo por suscripción con el reintento por visibilidad. El dispatcher del
outbox (o los publishers) y los listeners los escribe el agente en cmd/server/broker.go sobre Connection.Publish y
Connection.Consume.`;

// ─── consumption.go ──────────────────────────────────────────────────────────────────────────────

const floatLiteral = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));

/** Una entrada del consumo como literal de Go: los campos vacíos o a cero no se escriben. */
export function consumptionLiteral(entry) {
  const fields = [`Subscription: ${goString(entry.subscription)}`, `Queue: ${goString(entry.queue)}`];
  if (entry.deadLetterQueue) fields.push(`DeadLetterQueue: ${goString(entry.deadLetterQueue)}`);
  if (entry.retriesNotFound) fields.push('RetriesNotFound: true');
  fields.push(`MaxReceive: ${entry.maxReceive}`);
  if (entry.initialMs > 0) fields.push(`Initial: ${entry.initialMs} * time.Millisecond`);
  fields.push(`Multiplier: ${floatLiteral(entry.multiplier)}`);
  if (entry.maxDelayMs != null) fields.push(`MaxDelay: ${entry.maxDelayMs} * time.Millisecond`);
  return `{${fields.join(', ')}}`;
}

function consumptionBody(model) {
  const rows = snsSqsConsumption(model).map((entry) => `\t${consumptionLiteral(entry)},`);
  return `
// SubscriptionConsumption es cómo consume una suscripción, con los defaults del diseño (el perfil puede renombrar la cola
// en messaging.subscriptions.<clave>.queue): Queue es la cola PROPIA de este servicio, suscrita al topic de la fuente con
// filtro por eventType; DeadLetterQueue, su DLQ (la RedrivePolicy de infra/init-messaging.sh), vacía si la suscripción no
// declara onFailure.deadLetter; RetriesNotFound, si reintenta el «no existe» del caso de uso; MaxReceive, las recepciones
// antes del descarte (onFailure.retry.maxAttempts, una sin retry), que cuenta SQS; y la curva del reintento: Initial,
// Multiplier (2 con backoff exponential, la de la skill keel-spring-snssqs; 1 con fixed) y MaxDelay (0, sin techo).
type SubscriptionConsumption struct {
	Subscription    string
	Queue           string
	DeadLetterQueue string
	RetriesNotFound bool
	MaxReceive      int
	Initial         time.Duration
	Multiplier      float64
	MaxDelay        time.Duration
}

// maxVisibility es el techo de la visibilidad de un mensaje en SQS: doce horas.
const maxVisibility = ${MAX_VISIBILITY_SECONDS} * time.Second

// El consumo de este servicio: las MISMAS colas, DLQ y recepciones que siembra infra/init-messaging.sh y que consume el
// servidor de keel-spring del diseño. En producción la topología la aprovisiona la plataforma, no la aplicación.
var subscriptions = ${rows.length === 0 ? '[]SubscriptionConsumption{}' : `[]SubscriptionConsumption{\n${rows.join('\n')}\n}`}

// Subscriptions es el consumo, una entrada por suscripción.
func Subscriptions() []SubscriptionConsumption {
	return slices.Clone(subscriptions)
}

// consumptionOf es el consumo de la suscripción subscription (su NOMBRE en el diseño).
func consumptionOf(subscription string) (SubscriptionConsumption, bool) {
	index := slices.IndexFunc(subscriptions, func(entry SubscriptionConsumption) bool { return entry.Subscription == subscription })
	if index < 0 {
		return SubscriptionConsumption{}, false
	}
	return subscriptions[index], true
}

// RetryVisibility es cuánto queda oculto un mensaje tras su recepción received fallida: initial·multiplier^(received-1),
// con su techo, redondeado hacia arriba al segundo (SQS no admite menos) y dentro de las doce horas de SQS. Es el backoff
// del diseño: SQS no tiene otro, y sin alargar la visibilidad el mensaje volvería con la de la cola.
func RetryVisibility(consumption SubscriptionConsumption, received int) time.Duration {
	delay := float64(consumption.Initial) * math.Pow(consumption.Multiplier, float64(max(received-1, 0)))
	if consumption.MaxDelay > 0 && delay > float64(consumption.MaxDelay) {
		delay = float64(consumption.MaxDelay)
	}
	seconds := time.Duration(math.Ceil(delay/float64(time.Second))) * time.Second
	return min(max(seconds, 0), maxVisibility)
}

// IsRetryable dice si se reintenta un fallo del handler. No el rechazo de negocio (*domain.Error) ni el contrato
// incumplido (*messaging.ContractError): no mejoran con otra recepción, y repetirlos con una guarda que reclama antes
// (TryRecord) haría que la segunda recepción encontrara el mensaje marcado y lo borrara sin que llegara nunca a la DLQ.
// SQS no distingue tipos de fallo: a la DLQ lo lleva la conexión.
//
// Salvo el «no existe» donde la suscripción lo admite (retriesNotFound): suele ser la carrera de orden de un consumo
// asíncrono, y el reintento la resuelve.
func IsRetryable(err error, retriesNotFound bool) bool {
	var rejected *domain.Error
	if errors.As(err, &rejected) {
		return retriesNotFound && rejected.Kind() == domain.KindNotFound
	}
	var contract *messaging.ContractError
	return !errors.As(err, &contract)
}
`;
}

// ─── settings.go ─────────────────────────────────────────────────────────────────────────────────

function settingsBody() {
  return `
// Settings es la conexión con SNS/SQS del perfil activo, con las mismas variables que keel-spring: Enabled es false en el
// perfil test (las pruebas de build arrancan sin broker); AccessKey y SecretKey, las credenciales estáticas (vacías, la
// cadena por defecto del SDK: un rol IAM en producción); SNSEndpoint y SQSEndpoint, LocalStack fuera de producción
// (vacíos, el de AWS de la región); PollWait, el sondeo largo de SQS; MaxMessagesPerPoll, los mensajes por sondeo, y
// ReconnectInterval, la espera entre intentos mientras el broker o una cola no están.
type Settings struct {
	Enabled            bool
	Region             string
	AccessKey          string
	SecretKey          string
	SNSEndpoint        string
	SQSEndpoint        string
	PollWait           time.Duration
	MaxMessagesPerPoll int
	ReconnectInterval  time.Duration
}

// SettingsFrom lee y valida la conexión del perfil al ARRANCAR: un número fuera de su rango no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key string) string {
		value, _ := cfg.Value(key)
		return strings.TrimSpace(value)
	}
	settings := Settings{
		Enabled:     !strings.EqualFold(text("aws.enabled"), "false"),
		Region:      text("aws.region"),
		SNSEndpoint: text("aws.sns.endpoint"),
		SQSEndpoint: text("aws.sqs.endpoint"),
	}
	if settings.Region == "" {
		settings.Region = "us-east-1"
	}
	// Las dos o ninguna: con una sola, la cadena por defecto del SDK.
	if accessKey, secretKey := text("aws.credentials.access-key"), text("aws.credentials.secret-key"); accessKey != "" && secretKey != "" {
		settings.AccessKey, settings.SecretKey = accessKey, secretKey
	}
	pollWait, err := bounded(text("aws.sqs.listener.poll-timeout-seconds"), "aws.sqs.listener.poll-timeout-seconds", ${SQS_POLL_WAIT_SECONDS}, 0, 20)
	if err != nil {
		return Settings{}, err
	}
	settings.PollWait = time.Duration(pollWait) * time.Second
	if settings.MaxMessagesPerPoll, err = bounded(text("aws.sqs.listener.max-messages-per-poll"), "aws.sqs.listener.max-messages-per-poll", ${SQS_MAX_MESSAGES}, 1, 10); err != nil {
		return Settings{}, err
	}
	reconnect, err := bounded(text("aws.reconnect-interval-ms"), "aws.reconnect-interval-ms", ${SNSSQS_RECONNECT_INTERVAL_MS}, 1, 1<<31-1)
	if err != nil {
		return Settings{}, err
	}
	settings.ReconnectInterval = time.Duration(reconnect) * time.Millisecond
	return settings, nil
}

// bounded es el entero de value entre lo y hi, o fallback si el perfil no lo declara.
func bounded(value, key string, fallback, lo, hi int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < lo || n > hi {
		return 0, fmt.Errorf("%s tiene que ser un entero entre %d y %d: %q", key, lo, hi, value)
	}
	return n, nil
}
`;
}

// ─── connection.go ───────────────────────────────────────────────────────────────────────────────

function connectionBody() {
  return `
// ErrUnavailable es una publicación que no salió: el topic no existe o no tiene ningún suscriptor confirmado, SNS no
// responde o la conexión se está cerrando. El relay del outbox cuenta el intento y la reintenta.
var ErrUnavailable = errors.New("SNS no aceptó la publicación")

const (
	// Los plazos de una llamada a SNS: los de la skill keel-spring-snssqs (${SNS_REQUEST_TIMEOUT_MS} ms por intento, ${SNS_MAX_ATTEMPTS} intentos). Sin
	// ellos el SDK reintenta puertas adentro con su política, y ese tiempo se suma al backoff del relay en vez de estar
	// gobernado por él.
	snsAttemptTimeout = ${SNS_REQUEST_TIMEOUT_MS} * time.Millisecond
	snsMaxAttempts    = ${SNS_MAX_ATTEMPTS}
	// sqsMargin es lo que una recepción puede tardar por encima del sondeo largo: con menos, cada sondeo vacío sería un
	// error.
	sqsMargin = 10 * time.Second
	// pendingConfirmation es el ARN de una suscripción SNS que aún no se ha confirmado.
	pendingConfirmation = "PendingConfirmation"
)

// Message es un mensaje recibido de la cola: MessageID es el de SQS (cambia en cada reenvío a la cola: NO sirve para
// deduplicar), Body el cuerpo tal cual viajó (con raw delivery, el JSON de la envoltura si lo publicó un servicio Keel),
// Attributes sus message attributes de texto (eventType y los que declare el contrato) y ReceiveCount cuántas veces se ha
// recibido (ApproximateReceiveCount: 1 en la primera entrega).
type Message struct {
	MessageID    string
	Body         []byte
	Attributes   map[string]string
	ReceiveCount int
}

// Attribute es el message attribute de texto name, o "" si no viene.
func (m Message) Attribute(name string) string {
	return m.Attributes[name]
}

// Handler procesa un mensaje. Un error que IsRetryable admite se reintenta alargando la visibilidad con la curva del
// diseño (al agotar MaxReceive, la RedrivePolicy lo lleva a la DLQ); el resto va a la DLQ sin reintento si la hay, o se
// registra y se borra. El contexto no se cancela con el apagado: un mensaje empezado se termina.
type Handler func(ctx context.Context, message Message) error

// Connection es la conexión con SNS/SQS: un cliente de cada, por proceso. Run la mantiene en el errgroup del arranque;
// cada Consume sondea la cola de una suscripción. El servicio arranca SIN broker, como el de keel-spring: el sondeo
// reintenta mientras la cola no existe o LocalStack no responde.
//
// Lo que escribe el agente usa dos métodos:
//   - Publish: publica en el topic con sus message attributes y vuelve cuando SNS lo acepta; devuelve ErrUnavailable si
//     el topic no existe, no tiene ningún suscriptor confirmado o SNS no responde. Es lo que necesita el dispatcher del
//     outbox: dar por publicado lo que SNS descartó por no tener a quién entregar es lo que el outbox existe para impedir;
//   - Consume: el consumidor de una suscripción (por su NOMBRE en el diseño), sobre su cola, hasta que ctx se cancela: es
//     un listener del arranque. Borra el mensaje al terminar bien; alarga su visibilidad con la curva del diseño si el
//     fallo es transitorio; y lo no reintentable lo lleva a la DLQ si la hay, o lo registra y lo borra.
type Connection struct {
	settings  Settings
	messaging messaging.Settings
	logger    *slog.Logger

	// clients son los clientes del SDK, construidos una vez y sin red: el primero que los pide.
	clients func() (*awsClients, error)

	// mu guarda los ARN resueltos y si la conexión se está cerrando.
	mu        sync.Mutex
	topicArns map[string]string
	closing   bool

	// settling lo tiene cada mensaje mientras se procesa y se resuelve (su paso a la DLQ incluido); el apagado lo toma
	// entero, así que espera a los que estén en vuelo.
	settling sync.RWMutex
}

// awsClients son los dos clientes del SDK.
type awsClients struct {
	sns *sns.Client
	sqs *sqs.Client
}

// New construye la conexión; los clientes nacen con el primer uso.
func New(settings Settings, publishing messaging.Settings, logger *slog.Logger) *Connection {
	c := &Connection{settings: settings, messaging: publishing, logger: logger, topicArns: map[string]string{}}
	c.clients = sync.OnceValues(c.newClients)
	return c
}

// newClients construye los clientes: credenciales estáticas si el perfil las da (si no, la cadena por defecto del SDK),
// el endpoint de LocalStack si lo hay, y los plazos de cada uno.
func (c *Connection) newClients() (*awsClients, error) {
	options := []func(*config.LoadOptions) error{config.WithRegion(c.settings.Region)}
	if c.settings.AccessKey != "" {
		options = append(options, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.settings.AccessKey, c.settings.SecretKey, "")))
	}
	// Cargar la configuración no habla con AWS: lee el entorno y, sin claves, los archivos de la cadena por defecto.
	cfg, err := config.LoadDefaultConfig(context.Background(), options...)
	if err != nil {
		return nil, fmt.Errorf("configurar el SDK de AWS: %w", err)
	}
	snsClient := sns.NewFromConfig(cfg, func(o *sns.Options) {
		if c.settings.SNSEndpoint != "" {
			o.BaseEndpoint = aws.String(c.settings.SNSEndpoint)
		}
		o.RetryMaxAttempts = snsMaxAttempts
		o.HTTPClient = awshttp.NewBuildableClient().WithTimeout(snsAttemptTimeout)
	})
	sqsClient := sqs.NewFromConfig(cfg, func(o *sqs.Options) {
		if c.settings.SQSEndpoint != "" {
			o.BaseEndpoint = aws.String(c.settings.SQSEndpoint)
		}
		o.HTTPClient = awshttp.NewBuildableClient().WithTimeout(c.settings.PollWait + sqsMargin)
	})
	return &awsClients{sns: snsClient, sqs: sqsClient}, nil
}

// Run mantiene la conexión hasta que ctx se cancela; entonces deja de publicar y espera a los mensajes en vuelo. Con
// Enabled a false (el perfil test) no hace nada.
func (c *Connection) Run(ctx context.Context) error {
	if !c.settings.Enabled {
		return nil
	}
	if _, err := c.clients(); err != nil {
		return err
	}
	c.logger.InfoContext(ctx, "SNS/SQS: conexión lista", "region", c.settings.Region, "snsEndpoint", c.settings.SNSEndpoint, "sqsEndpoint", c.settings.SQSEndpoint)
	<-ctx.Done()
	c.mu.Lock()
	c.closing = true
	c.mu.Unlock()
	c.settling.Lock()
	defer c.settling.Unlock()
	return nil
}

// Publish publica payload (JSON ya serializado con el contrato del cable) en el topic topic (su NOMBRE), con attributes
// como message attributes —eventType es obligatorio: sobre él filtran las suscripciones—. Vuelve cuando SNS lo acepta;
// si no salió, el error es ErrUnavailable (errors.Is).
func (c *Connection) Publish(ctx context.Context, topic, payload string, attributes map[string]string) error {
	if attributes["eventType"] == "" {
		return fmt.Errorf("SNS: falta el message attribute eventType para %s, y sin él ninguna suscripción recibe el mensaje", topic)
	}
	c.mu.Lock()
	closing := c.closing
	c.mu.Unlock()
	if closing || !c.settings.Enabled {
		return fmt.Errorf("%w: la conexión no está abierta", ErrUnavailable)
	}
	clients, err := c.clients()
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	arn, err := c.topicArn(ctx, clients.sns, topic)
	if err != nil {
		return err
	}
	values := make(map[string]snstypes.MessageAttributeValue, len(attributes))
	for name, value := range attributes {
		values[name] = snstypes.MessageAttributeValue{DataType: aws.String("String"), StringValue: aws.String(value)}
	}
	if _, err := clients.sns.Publish(ctx, &sns.PublishInput{TopicArn: aws.String(arn), Message: aws.String(payload), MessageAttributes: values}); err != nil {
		// Un topic que desapareció (LocalStack reiniciado sin resembrar) obliga a resolverlo de nuevo.
		c.mu.Lock()
		delete(c.topicArns, topic)
		c.mu.Unlock()
		return fmt.Errorf("%w en %s: %w", ErrUnavailable, topic, err)
	}
	return nil
}

// topicArn es el ARN de un topic que EXISTE y tiene al menos un suscriptor confirmado. Nunca se crea: SNS entrega en el
// momento, y un topic sin suscriptores descarta lo publicado sin decir nada.
func (c *Connection) topicArn(ctx context.Context, client *sns.Client, topic string) (string, error) {
	c.mu.Lock()
	cached, ok := c.topicArns[topic]
	c.mu.Unlock()
	if ok {
		return cached, nil
	}
	arn := ""
	topics := sns.NewListTopicsPaginator(client, &sns.ListTopicsInput{})
	for arn == "" && topics.HasMorePages() {
		page, err := topics.NextPage(ctx)
		if err != nil {
			return "", fmt.Errorf("%w: no se resolvió el topic %s: %w", ErrUnavailable, topic, err)
		}
		for _, candidate := range page.Topics {
			if strings.HasSuffix(aws.ToString(candidate.TopicArn), ":"+topic) {
				arn = aws.ToString(candidate.TopicArn)
				break
			}
		}
	}
	if arn == "" {
		return "", fmt.Errorf("%w: el topic %s no existe", ErrUnavailable, topic)
	}
	confirmed := false
	subscribers := sns.NewListSubscriptionsByTopicPaginator(client, &sns.ListSubscriptionsByTopicInput{TopicArn: aws.String(arn)})
	for !confirmed && subscribers.HasMorePages() {
		page, err := subscribers.NextPage(ctx)
		if err != nil {
			return "", fmt.Errorf("%w: no se listaron los suscriptores de %s: %w", ErrUnavailable, topic, err)
		}
		for _, subscription := range page.Subscriptions {
			if value := aws.ToString(subscription.SubscriptionArn); value != "" && value != pendingConfirmation {
				confirmed = true
				break
			}
		}
	}
	if !confirmed {
		return "", fmt.Errorf("%w: el topic %s todavía no tiene ningún suscriptor confirmado", ErrUnavailable, topic)
	}
	c.mu.Lock()
	c.topicArns[topic] = arn
	c.mu.Unlock()
	return arn, nil
}

// subscriber es una suscripción que se consume, ya resuelta contra el perfil.
type subscriber struct {
	consumption SubscriptionConsumption
	queue       string
	handle      Handler
}

// Consume consume la suscripción subscription (su NOMBRE en el diseño) con handle hasta que ctx se cancela. Es un
// listener del arranque: va en su goroutine. Sus mensajes se procesan de uno en uno; lo que el apagado deja sin
// desenlace vuelve a la cola al vencer su visibilidad.
func (c *Connection) Consume(ctx context.Context, subscription string, handle Handler) error {
	consumption, ok := consumptionOf(subscription)
	if !ok {
		names := make([]string, 0, len(subscriptions))
		for _, entry := range subscriptions {
			names = append(names, entry.Subscription)
		}
		return fmt.Errorf("%q no es una suscripción de este servicio; declaradas: %v", subscription, names)
	}
	s := subscriber{consumption: consumption, queue: consumption.Queue, handle: handle}
	if configured, ok := c.messaging.Subscriptions[subscription]; ok && configured.Queue != "" {
		s.queue = configured.Queue
	}
	if !c.settings.Enabled {
		<-ctx.Done()
		return nil
	}
	clients, err := c.clients()
	if err != nil {
		return err
	}
	queueURL, deadLetterURL := "", ""
	polling := false
	for ctx.Err() == nil {
		messages, err := c.receive(ctx, clients.sqs, s, &queueURL, &deadLetterURL)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// La cola o el broker no están (LocalStack reiniciado, la topología sin sembrar): se resuelve otra vez.
			polling, queueURL, deadLetterURL = false, "", ""
			c.logger.WarnContext(ctx, "SQS: no se pudo sondear la cola; se reintenta", "subscription", subscription, "queue", s.queue, "error", err)
			if !sleep(ctx, c.settings.ReconnectInterval) {
				return nil
			}
			continue
		}
		if !polling {
			polling = true
			c.logger.InfoContext(ctx, "SQS: consumidor en marcha", "subscription", subscription, "queue", s.queue)
		}
		for _, message := range messages {
			if !c.deliver(ctx, clients.sqs, s, queueURL, deadLetterURL, message) {
				return nil
			}
		}
	}
	return nil
}

// receive resuelve las URL que falten y hace un sondeo largo de la cola.
func (c *Connection) receive(ctx context.Context, client *sqs.Client, s subscriber, queueURL, deadLetterURL *string) ([]sqstypes.Message, error) {
	if *queueURL == "" {
		out, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(s.queue)})
		if err != nil {
			return nil, err
		}
		*queueURL = aws.ToString(out.QueueUrl)
	}
	if dead := s.consumption.DeadLetterQueue; dead != "" && *deadLetterURL == "" {
		out, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(dead)})
		if err != nil {
			return nil, err
		}
		*deadLetterURL = aws.ToString(out.QueueUrl)
	}
	out, err := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:                    aws.String(*queueURL),
		MaxNumberOfMessages:         int32(c.settings.MaxMessagesPerPoll),
		WaitTimeSeconds:             int32(c.settings.PollWait / time.Second),
		MessageAttributeNames:       []string{"All"},
		MessageSystemAttributeNames: []sqstypes.MessageSystemAttributeName{sqstypes.MessageSystemAttributeNameApproximateReceiveCount},
	})
	if err != nil {
		return nil, err
	}
	return out.Messages, nil
}

// deliver es lo que hacen Spring Cloud AWS (ack ON_SUCCESS) y el ErrorHandler de la skill keel-spring-snssqs con cada
// mensaje. Dice si siguió: false es el apagado antes de empezarlo.
func (c *Connection) deliver(ctx context.Context, client *sqs.Client, s subscriber, queueURL, deadLetterURL string, received sqstypes.Message) bool {
	if ctx.Err() != nil {
		return false
	}
	c.settling.RLock()
	defer c.settling.RUnlock()
	message := messageOf(received)
	work := context.WithoutCancel(ctx)
	failure := s.handle(work, message)
	if failure == nil {
		c.remove(work, client, queueURL, received)
		return true
	}
	consumption := s.consumption
	if !IsRetryable(failure, consumption.RetriesNotFound) {
		if deadLetterURL == "" {
			c.logger.ErrorContext(ctx, "SQS: mensaje descartado sin reintento; la suscripción no declara dead-letter", "queue", s.queue, "error", failure)
			c.remove(work, client, queueURL, received)
			return true
		}
		_, err := client.SendMessage(work, &sqs.SendMessageInput{QueueUrl: aws.String(deadLetterURL), MessageBody: received.Body, MessageAttributes: received.MessageAttributes})
		if err != nil {
			// Sin la copia en la DLQ no se borra: vuelve al vencer su visibilidad y se decide otra vez.
			c.logger.WarnContext(ctx, "SQS: no se pudo llevar el mensaje a la DLQ; volverá a la cola", "queue", s.queue, "deadLetter", consumption.DeadLetterQueue, "error", err)
			return true
		}
		c.logger.ErrorContext(ctx, "SQS: mensaje llevado a la DLQ sin reintento", "queue", s.queue, "deadLetter", consumption.DeadLetterQueue, "error", failure)
		c.remove(work, client, queueURL, received)
		return true
	}
	if message.ReceiveCount >= consumption.MaxReceive {
		if deadLetterURL == "" {
			// Sin RedrivePolicy volvería para siempre: se registra y se borra, como en los demás brokers.
			c.logger.ErrorContext(ctx, "SQS: mensaje descartado; la suscripción no declara dead-letter", "queue", s.queue, "received", message.ReceiveCount, "error", failure)
			c.remove(work, client, queueURL, received)
			return true
		}
		// Agotado: visible ya, y la RedrivePolicy lo lleva a la DLQ en la próxima recepción.
		c.logger.ErrorContext(ctx, "SQS: mensaje agotó sus recepciones; va a la DLQ", "queue", s.queue, "maxReceive", consumption.MaxReceive, "deadLetter", consumption.DeadLetterQueue, "error", failure)
		c.changeVisibility(work, client, queueURL, received, 0)
		return true
	}
	c.logger.WarnContext(ctx, "SQS: fallo procesando un mensaje", "queue", s.queue, "received", message.ReceiveCount, "error", failure)
	c.changeVisibility(work, client, queueURL, received, RetryVisibility(consumption, message.ReceiveCount))
	return true
}

// remove borra un mensaje con desenlace. Si no se pudo, vuelve al vencer su visibilidad: la guarda de mensajes
// procesados lo absorbe.
func (c *Connection) remove(ctx context.Context, client *sqs.Client, queueURL string, message sqstypes.Message) {
	if _, err := client.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(queueURL), ReceiptHandle: message.ReceiptHandle}); err != nil {
		c.logger.WarnContext(ctx, "SQS: no se pudo borrar un mensaje; volverá a la cola", "error", err)
	}
}

// changeVisibility oculta un mensaje visibility. Si no se pudo, vuelve al vencer la visibilidad de la cola: más tarde,
// pero vuelve.
func (c *Connection) changeVisibility(ctx context.Context, client *sqs.Client, queueURL string, message sqstypes.Message, visibility time.Duration) {
	input := &sqs.ChangeMessageVisibilityInput{QueueUrl: aws.String(queueURL), ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: int32(visibility / time.Second)}
	if _, err := client.ChangeMessageVisibility(ctx, input); err != nil {
		c.logger.WarnContext(ctx, "SQS: no se pudo cambiar la visibilidad de un mensaje", "error", err)
	}
}

// messageOf copia el mensaje recibido en un Message.
func messageOf(received sqstypes.Message) Message {
	attributes := make(map[string]string, len(received.MessageAttributes))
	for name, value := range received.MessageAttributes {
		if value.StringValue != nil {
			attributes[name] = *value.StringValue
		}
	}
	count, err := strconv.Atoi(received.Attributes[string(sqstypes.MessageSystemAttributeNameApproximateReceiveCount)])
	if err != nil || count < 1 {
		count = 1
	}
	return Message{MessageID: aws.ToString(received.MessageId), Body: []byte(aws.ToString(received.Body)), Attributes: attributes, ReceiveCount: count}
}

// sleep espera d o a que ctx se cancele; dice si esperó entero.
func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
`;
}

// ─── snssqs_test.go ──────────────────────────────────────────────────────────────────────────────

/** La visibilidad de referencia, en segundos: la misma cuenta que RetryVisibilitySeconds de keel-dotnet. */
export function retryVisibilitySeconds(entry, received) {
  const delay = entry.initialMs * entry.multiplier ** Math.max(received - 1, 0);
  const capped = entry.maxDelayMs != null ? Math.min(delay, entry.maxDelayMs) : delay;
  return Math.min(Math.max(Math.ceil(capped / 1000), 0), MAX_VISIBILITY_SECONDS);
}

function emittedTest(model) {
  const consumption = snsSqsConsumption(model);
  const curve = consumption[0];
  const retriesNotFound = consumption.find((entry) => entry.retriesNotFound);
  const deadLettered = consumption.find((entry) => entry.deadLetterQueue);
  return `
// Lo que la conexión decide sin broker: la curva del reintento contra la de keel-core (snsSqsConsumption), qué fallo se
// reintenta, el consumo y la configuración del perfil. Lo que hace con un broker real (publicación, filtro por eventType,
// visibilidad, DLQ, resiembra) lo mide broker-check.
${
  curve
    ? `
func TestRetryVisibility(t *testing.T) {
	consumption := snssqs.Subscriptions()[0]
	for received, want := range map[int]time.Duration{
${alignRows([1, 2, 3, 5, 12].map((received) => ({ indent: '\t\t', cells: [`${received}:`, `${retryVisibilitySeconds(curve, received)} * time.Second,`] }))).join('\n')}
	} {
		if got := snssqs.RetryVisibility(consumption, received); got != want {
			t.Errorf("RetryVisibility(%d) = %v, quiero %v", received, got, want)
		}
	}
	if got := snssqs.RetryVisibility(snssqs.SubscriptionConsumption{Initial: time.Hour, Multiplier: 10}, 5); got != 12*time.Hour {
		t.Errorf("la visibilidad no pasa de las doce horas de SQS: %v", got)
	}
}
`
    : ''
}
func TestIsRetryable(t *testing.T) {
	transient := errors.New("la base no contesta")
	contract := fmt.Errorf("leer el mensaje: %w", &messaging.ContractError{Reason: "falta un campo"})
	rejected := fmt.Errorf("despachar: %w", &domain.Error{})
	if !snssqs.IsRetryable(transient, false) {
		t.Error("un fallo transitorio se reintenta")
	}
	if snssqs.IsRetryable(contract, true) {
		t.Error("el contrato incumplido no se reintenta")
	}
	if snssqs.IsRetryable(rejected, true) {
		t.Error("el rechazo de negocio no se reintenta")
	}
}

func TestConsumption(t *testing.T) {
	consumption := snssqs.Subscriptions()
	if len(consumption) != ${consumption.length} {
		t.Fatalf("consumo: %d suscripciones", len(consumption))
	}
	queues := map[string]bool{}
	for _, entry := range consumption {
		if queues[entry.Queue] {
			t.Errorf("la cola %s se repite: cada suscripción necesita la suya para recibir el topic con su filtro", entry.Queue)
		}
		queues[entry.Queue] = true
		if entry.MaxReceive < 1 {
			t.Errorf("%s: MaxReceive = %d", entry.Subscription, entry.MaxReceive)
		}
	}
${deadLettered ? `	if got := consumption[${consumption.indexOf(deadLettered)}].DeadLetterQueue; got != ${goString(deadLettered.deadLetterQueue)} {
		t.Errorf("DeadLetterQueue = %q", got)
	}
` : ''}${retriesNotFound ? `	if !consumption[${consumption.indexOf(retriesNotFound)}].RetriesNotFound {
		t.Error(${goString(`${retriesNotFound.subscription} reintenta el «no existe»`)})
	}
` : ''}	if len(consumption) > 0 {
		consumption[0].Queue = "otra"
		if snssqs.Subscriptions()[0].Queue == "otra" {
			t.Error("Subscriptions() devuelve el consumo de build, no una copia")
		}
	}
}

func TestSettings(t *testing.T) {
	load := func(t *testing.T, yaml string) (snssqs.Settings, error) {
		t.Helper()
		files := fstest.MapFS{
			"application.yaml":             {Data: []byte("server:\\n  port: 8080\\n")},
			"parameters/local/snssqs.yaml": {Data: []byte(yaml)},
		}
		cfg, err := config.Load(files, func(string) string { return "" })
		if err != nil {
			t.Fatal(err)
		}
		return snssqs.SettingsFrom(cfg)
	}
	settings, err := load(t, "aws:\\n  credentials:\\n    access-key: test\\n")
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled || settings.Region != "us-east-1" || settings.AccessKey != "" || settings.PollWait != ${SQS_POLL_WAIT_SECONDS}*time.Second || settings.MaxMessagesPerPoll != ${SQS_MAX_MESSAGES} || settings.ReconnectInterval != ${SNSSQS_RECONNECT_INTERVAL_MS}*time.Millisecond {
		t.Errorf("defaults (una clave sin la otra es la cadena por defecto): %+v", settings)
	}
	if settings, _ := load(t, "aws:\\n  enabled: false\\n"); settings.Enabled {
		t.Error("enabled: false apaga la conexión")
	}
	if _, err := load(t, "aws:\\n  sqs:\\n    listener:\\n      poll-timeout-seconds: 21\\n"); err == nil || !strings.Contains(err.Error(), "poll-timeout-seconds") {
		t.Errorf("un sondeo por encima de los 20 s de SQS no deja arrancar: %v", err)
	}
}
`;
}
