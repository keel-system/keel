// Kafka en keel-go (tramo 9f): lo que en el servidor de keel-spring ponen Spring Boot y build sin que el agente escriba
// nada, en el paquete `internal/infrastructure/kafka`. El gemelo de `kafka.js` de keel-dotnet y keel-nest:
//
//   · el CONSUMO como datos (consumption.go), de keel-core (gen/messaging-plan.js, `kafkaConsumption`): por
//     suscripción, su topic y su consumer group (`<servicio>-<evento>`), si descarta en `<topic>.DLT` y si reintenta el
//     «no existe», y el REINTENTO del consumidor (`kafkaListenerRetry`, neutral): la curva del `DeadLetterConfig` de
//     keel-spring, con lo que no se reintenta —el rechazo de negocio (*domain.Error) y el contrato incumplido
//     (*messaging.ContractError)—;
//   · la CONEXIÓN (connection.go, sobre github.com/twmb/franz-go, en Go puro): las mismas variables que keel-spring
//     (KAFKA_BOOTSTRAP_SERVERS y los plazos del productor de keel-core/gen/infra-catalog.js), un productor que espera el
//     ack de todas las réplicas con idempotencia (lo que kafka-clients 3 trae por defecto en Spring), un consumidor por
//     suscripción (`Consume`, bloqueante: un listener del errgroup) que hace lo que el `DefaultErrorHandler` +
//     `DeadLetterPublishingRecoverer` de keel-spring —reintentar en memoria y, agotado o no reintentable, publicar en
//     `<topic>.DLT` solo los topics que lo declaran, con los headers de Spring Kafka—, y el arranque SIN broker: el
//     cliente conecta bajo demanda y reintenta solo. El offset se confirma DESPUÉS del desenlace, uno a uno.
//
// Lo que escribe el agente (skill keel-go-kafka) es lo mismo que en keel-spring: el messaging.Dispatcher del outbox o los
// publishers best-effort sobre `Connection.Publish`, y un listener por SUSCRIPCIÓN sobre `Connection.Consume`, en
// cmd/server/broker.go. No crea topics: los autocrea el broker de infra/ con el primer mensaje y en producción los
// gobierna la plataforma.

import { KAFKA_PRODUCER_TIMEOUTS } from '@keel-system/keel-core/gen/infra-catalog';
import { kafkaListenerRetry } from '@keel-system/keel-core/gen';
import { KAFKA_DEFAULT_METADATA_REFRESH_MS, KAFKA_RECONNECT_INTERVAL_MS, kafkaConsumption, kafkaYaml } from '@keel-system/keel-core/gen/messaging-plan';
import { alignRows, goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { MESSAGING_IMPORT, usesGoMessaging } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const KGO = 'github.com/twmb/franz-go/pkg/kgo';
export const KAFKA_IMPORT = 'internal/infrastructure/kafka';

/** ¿Genera el servicio la conexión con Kafka? */
export function usesGoKafka(model) {
  return usesGoMessaging(model) && model.stack?.broker === 'kafka';
}

/** El client.id con el que el servicio se presenta al broker (el nombre del servicio, como la conexión de RabbitMQ). */
export function clientId(model) {
  return model.service.name;
}

export function generate(model) {
  if (!usesGoKafka(model)) return [];
  const { kafka } = layout(model);
  const file = (name, imports, body, { test = false } = {}) => ({
    path: `${kafka.dir}/${name}${test ? '_test' : ''}.go`,
    content: packageFile(model, kafka, { imports, body, test, doc: name === 'doc' ? PACKAGE_DOC : null })
  });
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/kafka.yaml`, content: kafkaYaml(profile) })),
    file('doc', [], ''),
    file('consumption', ['errors', 'math', 'slices', 'time', 'internal/domain', MESSAGING_IMPORT], consumptionBody(model)),
    file('settings', ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], settingsBody()),
    file('connection', ['context', 'encoding/binary', 'errors', 'fmt', 'log/slog', 'maps', 'slices', 'sync', 'time', KGO, 'internal/domain', MESSAGING_IMPORT], connectionBody(model)),
    file('kafka', ['errors', 'fmt', 'strings', 'testing', 'testing/fstest', 'time', 'internal/domain', 'internal/platform/config', MESSAGING_IMPORT, KAFKA_IMPORT], emittedTest(model), {
      test: true
    })
  ];
}

const PACKAGE_DOC = `Package kafka es la conexión del servicio con Kafka: el consumo que declara build (el mismo que el del servidor de
keel-spring del diseño), la publicación confirmada por todas las réplicas y el consumo por suscripción con reintento y
descarte en <topic>.DLT. El dispatcher del outbox (o los publishers) y los listeners los escribe el agente en
cmd/server/broker.go sobre Connection.Publish y Connection.Consume.`;

// ─── consumption.go ──────────────────────────────────────────────────────────────────────────────

const floatLiteral = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));

/** El reintento como literal de Go: los campos a cero no se escriben. */
export function retryLiteral(retry) {
  const fields = [`Attempts: ${retry.attempts}`];
  if (retry.initialMs > 0) fields.push(`Initial: ${retry.initialMs} * time.Millisecond`);
  fields.push(`Multiplier: ${floatLiteral(retry.multiplier)}`);
  if (retry.maxDelayMs != null) fields.push(`MaxDelay: ${retry.maxDelayMs} * time.Millisecond`);
  return `ListenerRetry{${fields.join(', ')}}`;
}

function consumptionBody(model) {
  const consumption = kafkaConsumption(model);
  const retry = kafkaListenerRetry(model);
  const rows = consumption.map((entry) => {
    const fields = [`Subscription: ${goString(entry.subscription)}`, `Topic: ${goString(entry.topic)}`, `GroupID: ${goString(entry.groupId)}`];
    if (entry.deadLetter) fields.push('DeadLetter: true');
    if (entry.retriesNotFound) fields.push('RetriesNotFound: true');
    return `\t\t{${fields.join(', ')}},`;
  });
  const declared = model.subscriptions.filter((sub) => sub.deadLetter).map((sub) => sub.name);
  return `
// SubscriptionConsumption es cómo consume una suscripción, con los defaults del diseño (el perfil puede renombrar topic
// y grupo en messaging.subscriptions.<clave>): Topic es el de la fuente, del que se consume directamente (en Kafka no hay
// cola intermedia); GroupID, su consumer group, uno por suscripción para que cada una reciba el topic entero;
// DeadLetter, si publica en <topic>.DLT lo que agota sus reintentos (por topic: basta con que una suscripción del topic
// lo declare), y RetriesNotFound, si reintenta el «no existe» del caso de uso (el RETRIES_NOT_FOUND de keel-spring).
type SubscriptionConsumption struct {
	Subscription    string
	Topic           string
	GroupID         string
	DeadLetter      bool
	RetriesNotFound bool
}

// ListenerRetry es el reintento del consumidor (keel-core, kafkaListenerRetry): los intentos de un mensaje (el primero
// incluido), la primera espera, el multiplicador y el techo de la espera (0, sin techo).
type ListenerRetry struct {
	Attempts   int
	Initial    time.Duration
	Multiplier float64
	MaxDelay   time.Duration
}

// El consumo de este servicio: el MISMO que el del servidor de keel-spring del diseño (los grupos de
// messaging.subscriptions.<clave>.group-id y el DEAD_LETTERED de su DeadLetterConfig). Los topics no los crea la
// aplicación: en infra/ los autocrea el broker con el primer mensaje, y en producción los aprovisiona la plataforma.
var (
	subscriptions = ${rows.length === 0 ? '[]SubscriptionConsumption{}' : `[]SubscriptionConsumption{\n${rows.join('\n')}\n\t}`}

	// ${
      declared.length > 0
        ? `El reintento de las suscripciones con descarte (${declared.join(', ')}), aplicado a todas: uno para todo el
	// servicio, como el DefaultErrorHandler de keel-spring, y con varias políticas gana la más paciente.`
        : `Ninguna suscripción declara descarte: rige el DefaultErrorHandler por defecto de Spring Kafka, diez intentos
	// seguidos sin espera, y después se registra y se confirma.`
    }
	retry = ${retryLiteral(retry)}
)

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

// DeadLetterTopic es el destino de descarte de un topic: la convención de Spring Kafka.
func DeadLetterTopic(topic string) string {
	return topic + ".DLT"
}

// ListenerAttempts son los intentos de un mensaje, el primero incluido.
func ListenerAttempts() int {
	return retry.Attempts
}

// ListenerBackoff es la espera antes del intento attempt+1: initial·multiplier^(attempt-1), con su techo.
func ListenerBackoff(attempt int) time.Duration {
	delay := float64(retry.Initial) * math.Pow(retry.Multiplier, float64(max(attempt-1, 0)))
	if retry.MaxDelay > 0 && delay > float64(retry.MaxDelay) {
		return retry.MaxDelay
	}
	return time.Duration(delay)
}

// IsRetryable dice si se reintenta un fallo del handler. No el rechazo de negocio (*domain.Error) ni el contrato
// incumplido (*messaging.ContractError): son el addNotRetryableExceptions(DomainException.class,
// IllegalArgumentException.class) de keel-spring. No mejoran dentro de un segundo, y el reintento en memoria repite la
// MISMA entrega: una guarda que reclama antes (TryRecord) la encontraría ya marcada y la confirmaría sin que llegara
// nunca al descarte.
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
// Settings es la conexión con Kafka del perfil activo, con las mismas variables que keel-spring: Enabled es false en el
// perfil test (las pruebas de build arrancan sin broker); DeliveryTimeout, cuánto puede retener el productor un envío
// sin confirmar (delivery.timeout.ms); MetadataRefreshInterval, cada cuánto refresca el consumidor los metadatos de sus
// topics (un topic creado después de suscribirse no se ve hasta el siguiente refresco), y ReconnectInterval, la espera
// entre intentos de publicar en el descarte mientras el broker no está.
type Settings struct {
	Enabled                 bool
	BootstrapServers        []string
	DeliveryTimeout         time.Duration
	RequestTimeout          time.Duration
	MetadataRefreshInterval time.Duration
	ReconnectInterval       time.Duration
}

// SettingsFrom lee y valida la conexión del perfil al ARRANCAR: un número que no es un entero positivo no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	enabled, _ := cfg.Value("kafka.enabled")
	servers := []string{"localhost:9092"}
	if value, ok := cfg.Value("kafka.bootstrap-servers"); ok && strings.TrimSpace(value) != "" {
		servers = nil
		for server := range strings.SplitSeq(value, ",") {
			if server = strings.TrimSpace(server); server != "" {
				servers = append(servers, server)
			}
		}
	}
	settings := Settings{Enabled: !strings.EqualFold(strings.TrimSpace(enabled), "false"), BootstrapServers: servers}
	for _, field := range []struct {
		key      string
		fallback int
		into     *time.Duration
	}{
		{"kafka.producer.delivery-timeout-ms", ${KAFKA_PRODUCER_TIMEOUTS.delivery.default}, &settings.DeliveryTimeout},
		{"kafka.producer.request-timeout-ms", ${KAFKA_PRODUCER_TIMEOUTS.request.default}, &settings.RequestTimeout},
		{"kafka.consumer.metadata-refresh-interval-ms", ${KAFKA_DEFAULT_METADATA_REFRESH_MS}, &settings.MetadataRefreshInterval},
		{"kafka.reconnect-interval-ms", ${KAFKA_RECONNECT_INTERVAL_MS}, &settings.ReconnectInterval},
	} {
		millis, err := positive(cfg, field.key, field.fallback)
		if err != nil {
			return Settings{}, err
		}
		*field.into = time.Duration(millis) * time.Millisecond
	}
	return settings, nil
}

// positive es el entero positivo de key, o fallback si el perfil no lo declara.
func positive(cfg *config.Config, key string, fallback int) (int, error) {
	value, ok := cfg.Value(key)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s tiene que ser un entero positivo: %q", key, value)
	}
	return n, nil
}
`;
}

// ─── connection.go ───────────────────────────────────────────────────────────────────────────────

function connectionBody(model) {
  return `
// ErrUnavailable es una publicación que no salió: sin conexión, rechazada por el broker o sin confirmación dentro de
// delivery.timeout.ms. El relay del outbox cuenta el intento y la reintenta.
var ErrUnavailable = errors.New("kafka no aceptó la publicación")

const (
	// clientID es el client.id con el que el servicio se presenta al broker.
	clientID = ${goString(clientId(model))}
	// closeTimeout es cuánto espera el apagado a que el productor vacíe su cola: un broker que no contesta no puede
	// retener el apagado del servicio, que tiene su propio margen (server.shutdown-timeout).
	closeTimeout = 5 * time.Second
	// metadataMinAge es la espera mínima entre dos lecturas de metadatos (la del cliente), o el refresco si es menor.
	metadataMinAge = 5 * time.Second
)

// Message es un registro recibido de un topic: Key es su clave (la routing key, si lo publicó un servicio Keel; vacía si
// no trae), Value el valor tal cual viajó (el JSON de la envoltura) y Headers sus headers como texto (el último, si
// viene repetido).
type Message struct {
	Topic     string
	Partition int32
	Offset    int64
	Key       string
	Value     []byte
	Headers   map[string]string
}

// Handler procesa un mensaje. Un error que IsRetryable admite se reintenta con la curva del diseño; el resto, o el
// último intento, va al descarte (<topic>.DLT si el topic lo declara; si no, se registra y se confirma). El contexto no
// se cancela con el apagado: un mensaje empezado se termina.
type Handler func(ctx context.Context, message Message) error

// Connection es la conexión con Kafka: una por proceso. Run mantiene el productor; cada Consume, el consumidor de una
// suscripción con su propio cliente. El servicio arranca SIN broker, como el de keel-spring: el cliente conecta bajo
// demanda y se reconecta solo si el broker se va y vuelve.
//
// Lo que escribe el agente usa dos métodos:
//   - Publish: vuelve cuando el broker CONFIRMA (acks de todas las réplicas, productor idempotente); si no hay
//     productor, si el broker lo rechaza o si vence delivery.timeout.ms, devuelve ErrUnavailable. Es lo que necesita el
//     dispatcher del outbox: marcar como publicado lo que el broker no confirmó es lo que el outbox existe para impedir;
//   - Consume: el consumidor de una suscripción (por su NOMBRE en el diseño), con su consumer group, hasta que ctx se
//     cancela: es un listener del arranque. Confirma el offset al terminar bien; reintenta en memoria con la curva del
//     diseño lo transitorio, y lo agotado o no reintentable lo publica en <topic>.DLT si el topic lo declara, o lo
//     registra y lo confirma si no.
type Connection struct {
	settings  Settings
	messaging messaging.Settings
	logger    *slog.Logger

	// mu guarda el productor, que existe mientras Run está en marcha.
	mu       sync.Mutex
	producer *kgo.Client

	// settling lo tiene cada mensaje mientras se procesa y se resuelve (su descarte incluido); el apagado lo toma entero
	// antes de cerrar el productor, así que espera a los que estén en vuelo.
	settling sync.RWMutex
}

// New construye la conexión; el productor nace en Run.
func New(settings Settings, publishing messaging.Settings, logger *slog.Logger) *Connection {
	return &Connection{settings: settings, messaging: publishing, logger: logger}
}

// options son las opciones comunes a los clientes de la conexión, más extra.
func (c *Connection) options(extra ...kgo.Opt) []kgo.Opt {
	return append([]kgo.Opt{
		kgo.SeedBrokers(c.settings.BootstrapServers...),
		kgo.ClientID(clientID),
		kgo.WithLogger(clientLogger{logger: c.logger}),
	}, extra...)
}

// Run mantiene el productor hasta que ctx se cancela; entonces espera a los mensajes en vuelo, vacía el productor (con
// tope) y lo cierra. Con Enabled a false (el perfil test) no hace nada.
func (c *Connection) Run(ctx context.Context) error {
	if !c.settings.Enabled {
		return nil
	}
	producer, err := kgo.NewClient(c.options(
		// Lo que kafka-clients hace por defecto en Spring: el broker de infra/ crea el topic con el primer mensaje.
		kgo.AllowAutoTopicCreation(),
		kgo.RecordDeliveryTimeout(c.settings.DeliveryTimeout),
		// El plazo es un tope DURO, como delivery.timeout.ms en kafka-clients y librdkafka. Sin esta opción, el productor
		// idempotente retiene sin plazo un envío que llegó a escribirse en una conexión que cayó (no sabe si el broker lo
		// guardó), así que con el broker caído Publish no volvía y el relay quedaba parado; y al volver el broker salía una
		// fila que el outbox ya había abandonado (broker-check, FL-BRK-002-D). El duplicado que puede dejar lo absorbe la
		// guarda del consumidor, por el eventId.
		kgo.AllowIdempotentProduceCancellation(),
		kgo.ProduceRequestTimeout(c.settings.RequestTimeout),
	)...)
	if err != nil {
		return fmt.Errorf("crear el productor de Kafka: %w", err)
	}
	c.mu.Lock()
	c.producer = producer
	c.mu.Unlock()
	c.logger.InfoContext(ctx, "Kafka: productor listo", "bootstrapServers", c.settings.BootstrapServers)
	<-ctx.Done()
	c.settling.Lock()
	defer c.settling.Unlock()
	c.mu.Lock()
	c.producer = nil
	c.mu.Unlock()
	flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), closeTimeout)
	defer cancel()
	if err := producer.Flush(flushCtx); err != nil {
		c.logger.WarnContext(ctx, "Kafka: el productor no se vació antes de cerrar", "error", err)
	}
	producer.Close()
	return nil
}

// Publish publica payload (JSON ya serializado con el contrato del cable) en topic con key como clave del registro (la
// routing key: los registros con la misma clave van a la misma partición, en orden) y headers como sus headers. Vuelve
// cuando el broker confirma; si no salió, el error es ErrUnavailable (errors.Is).
func (c *Connection) Publish(ctx context.Context, topic, key, payload string, headers map[string]string) error {
	record := &kgo.Record{Topic: topic, Value: []byte(payload)}
	if key != "" {
		record.Key = []byte(key)
	}
	for _, name := range slices.Sorted(maps.Keys(headers)) {
		record.Headers = append(record.Headers, kgo.RecordHeader{Key: name, Value: []byte(headers[name])})
	}
	return c.send(ctx, record)
}

// send produce record y espera su confirmación.
func (c *Connection) send(ctx context.Context, record *kgo.Record) error {
	c.mu.Lock()
	producer := c.producer
	c.mu.Unlock()
	if producer == nil {
		return fmt.Errorf("%w: no está conectado", ErrUnavailable)
	}
	if err := producer.ProduceSync(ctx, record).FirstErr(); err != nil {
		return fmt.Errorf("%w en %s: %w", ErrUnavailable, record.Topic, err)
	}
	return nil
}

// subscriber es una suscripción que se consume, ya resuelta contra el perfil.
type subscriber struct {
	subscription    string
	topic           string
	group           string
	deadLetter      bool
	retriesNotFound bool
	handle          Handler
}

// Consume consume la suscripción subscription (su NOMBRE en el diseño) con handle hasta que ctx se cancela. Es un
// listener del arranque: va en su goroutine. Sus mensajes se procesan de uno en uno y el offset avanza después de cada
// desenlace, así que lo que no lo tuvo (el apagado a mitad) se vuelve a entregar.
func (c *Connection) Consume(ctx context.Context, subscription string, handle Handler) error {
	consumption, ok := consumptionOf(subscription)
	if !ok {
		names := make([]string, 0, len(subscriptions))
		for _, entry := range subscriptions {
			names = append(names, entry.Subscription)
		}
		return fmt.Errorf("%q no es una suscripción de este servicio; declaradas: %v", subscription, names)
	}
	s := subscriber{subscription: subscription, topic: consumption.Topic, group: consumption.GroupID, deadLetter: consumption.DeadLetter, retriesNotFound: consumption.RetriesNotFound, handle: handle}
	if configured, ok := c.messaging.Subscriptions[subscription]; ok {
		if configured.Topic != "" {
			s.topic = configured.Topic
		}
		if configured.GroupID != "" {
			s.group = configured.GroupID
		}
	}
	if !c.settings.Enabled {
		<-ctx.Done()
		return nil
	}
	consumer, err := kgo.NewClient(c.options(
		kgo.ConsumerGroup(s.group),
		kgo.ConsumeTopics(s.topic),
		// Desde el principio: un grupo nuevo lee lo publicado antes de unirse. Con el final, lo que llega mientras el
		// grupo se forma se pierde (y un escenario que entrega al abrir el flujo, también).
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// El offset se confirma a mano DESPUÉS del desenlace de cada mensaje.
		kgo.DisableAutoCommit(),
		kgo.MetadataMinAge(min(metadataMinAge, c.settings.MetadataRefreshInterval)),
		kgo.MetadataMaxAge(c.settings.MetadataRefreshInterval),
	)...)
	if err != nil {
		return fmt.Errorf("crear el consumidor de %s: %w", subscription, err)
	}
	// Close sale del grupo: sus particiones pasan enseguida a otra réplica.
	defer consumer.Close()
	c.logger.InfoContext(ctx, "Kafka: consumidor en marcha", "subscription", subscription, "topic", s.topic, "group", s.group)
	for {
		fetches := consumer.PollFetches(ctx)
		if ctx.Err() != nil || fetches.IsClientClosed() {
			return nil
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			// El topic que aún no existe (lo crea el primer mensaje) o el broker que se fue: el cliente sigue solo.
			c.logger.DebugContext(ctx, "Kafka: el consumidor no pudo leer; sigue", "subscription", subscription, "topic", topic, "partition", partition, "error", err)
		})
		for _, record := range fetches.Records() {
			if !c.deliver(ctx, s, record) {
				// El apagado: sin desenlace no se confirma, y el grupo lo volverá a entregar.
				return nil
			}
			commitCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.settings.RequestTimeout)
			err := consumer.CommitRecords(commitCtx, record)
			cancel()
			if err != nil {
				// Se volverá a entregar: la guarda de mensajes procesados lo absorbe.
				c.logger.WarnContext(ctx, "Kafka: no se pudo confirmar el offset", "subscription", subscription, "offset", record.Offset, "error", err)
			}
		}
	}
}

// deliver es lo que hace el DefaultErrorHandler de keel-spring con cada mensaje. Dice si hubo desenlace: sin él (el
// apagado a mitad, o el descarte que no se pudo escribir) el offset no avanza.
func (c *Connection) deliver(ctx context.Context, s subscriber, record *kgo.Record) bool {
	if ctx.Err() != nil {
		return false
	}
	c.settling.RLock()
	defer c.settling.RUnlock()
	message := messageOf(record)
	work := context.WithoutCancel(ctx)
	attempts := ListenerAttempts()
	for attempt := 1; ; attempt++ {
		err := s.handle(work, message)
		if err == nil {
			return true
		}
		if !IsRetryable(err, s.retriesNotFound) || attempt >= attempts {
			return c.recover(ctx, s, record, err, attempt)
		}
		c.logger.WarnContext(ctx, "Kafka: fallo procesando un mensaje", "topic", record.Topic, "attempt", attempt, "error", err)
		if !sleep(ctx, ListenerBackoff(attempt)) {
			return false
		}
	}
}

// recover es el DeadLetterPublishingRecoverer de keel-spring: la clave, el valor y los headers originales, y los suyos.
// Sin descarte declarado, se registra y se confirma.
func (c *Connection) recover(ctx context.Context, s subscriber, record *kgo.Record, failure error, attempts int) bool {
	if !s.deadLetter {
		c.logger.ErrorContext(ctx, "Kafka: mensaje descartado; el diseño no declara dead-letter para esta suscripción", "topic", record.Topic, "attempts", attempts, "error", failure)
		return true
	}
	target := DeadLetterTopic(record.Topic)
	for {
		// Un registro nuevo en cada intento: el cliente rellena el que produce.
		dead := &kgo.Record{Topic: target, Key: record.Key, Value: record.Value, Headers: deadLetterHeaders(record, s.group, failure)}
		err := c.send(ctx, dead)
		if err == nil {
			c.logger.ErrorContext(ctx, "Kafka: mensaje llevado al descarte", "topic", record.Topic, "target", target, "attempts", attempts, "error", failure)
			return true
		}
		// Sin descarte escrito no hay desenlace: se insiste, y al apagar se suelta sin confirmar.
		c.logger.WarnContext(ctx, "Kafka: no se pudo publicar en el descarte; se reintenta", "target", target, "error", err)
		if !sleep(ctx, c.settings.ReconnectInterval) {
			return false
		}
	}
}

// deadLetterHeaders son los headers del registro original más los de Spring Kafka, con su misma codificación (la
// partición en 4 bytes y el offset en 8, big-endian): quien vigila los descartes de los cuatro servidores lee lo mismo.
func deadLetterHeaders(record *kgo.Record, group string, failure error) []kgo.RecordHeader {
	return append(slices.Clone(record.Headers),
		kgo.RecordHeader{Key: "kafka_dlt-original-topic", Value: []byte(record.Topic)},
		kgo.RecordHeader{Key: "kafka_dlt-original-partition", Value: binary.BigEndian.AppendUint32(nil, uint32(record.Partition))},
		kgo.RecordHeader{Key: "kafka_dlt-original-offset", Value: binary.BigEndian.AppendUint64(nil, uint64(record.Offset))},
		kgo.RecordHeader{Key: "kafka_dlt-original-consumer-group", Value: []byte(group)},
		kgo.RecordHeader{Key: "kafka_dlt-exception-fqcn", Value: []byte(failureType(failure))},
		kgo.RecordHeader{Key: "kafka_dlt-exception-message", Value: []byte(failure.Error())},
	)
}

// failureType es el tipo del fallo que lo decidió: el rechazo de negocio o el contrato incumplido si están en la
// cadena, y si no el error tal cual llegó.
func failureType(err error) string {
	var rejected *domain.Error
	if errors.As(err, &rejected) {
		return fmt.Sprintf("%T", rejected)
	}
	var contract *messaging.ContractError
	if errors.As(err, &contract) {
		return fmt.Sprintf("%T", contract)
	}
	return fmt.Sprintf("%T", err)
}

// messageOf copia el registro en un Message.
func messageOf(record *kgo.Record) Message {
	headers := make(map[string]string, len(record.Headers))
	for _, header := range record.Headers {
		headers[header.Key] = string(header.Value)
	}
	return Message{Topic: record.Topic, Partition: record.Partition, Offset: record.Offset, Key: string(record.Key), Value: record.Value, Headers: headers}
}

// clientLogger lleva al logger del servicio lo que el cliente avisa (de Warn para arriba). El cliente no pasa contexto.
type clientLogger struct {
	logger *slog.Logger
}

// Level es el nivel desde el que el cliente escribe.
func (l clientLogger) Level() kgo.LogLevel {
	return kgo.LogLevelWarn
}

// Log escribe un aviso del cliente.
func (l clientLogger) Log(level kgo.LogLevel, message string, keyvals ...any) {
	if level == kgo.LogLevelError {
		l.logger.Error("Kafka: "+message, keyvals...)
		return
	}
	l.logger.Warn("Kafka: "+message, keyvals...)
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

// ─── kafka_test.go ───────────────────────────────────────────────────────────────────────────────

function emittedTest(model) {
  const retry = kafkaListenerRetry(model);
  const backoff = (attempt) => {
    const delay = retry.initialMs * retry.multiplier ** Math.max(attempt - 1, 0);
    return Math.floor(retry.maxDelayMs != null ? Math.min(delay, retry.maxDelayMs) : delay);
  };
  const consumption = kafkaConsumption(model);
  const retriesNotFound = consumption.find((entry) => entry.retriesNotFound);
  const deadLettered = consumption.find((entry) => entry.deadLetter);
  return `
// Lo que la conexión decide sin broker: la curva del reintento contra la de keel-core (kafkaListenerRetry), qué fallo se
// reintenta, el consumo y la configuración del perfil. Lo que hace con un broker real (confirmación, consumo por grupo,
// descarte en <topic>.DLT, reconexión) lo mide broker-check.

func TestListenerRetry(t *testing.T) {
	if got := kafka.ListenerAttempts(); got != ${retry.attempts} {
		t.Errorf("ListenerAttempts() = %d, quiero ${retry.attempts}", got)
	}
	for attempt, want := range map[int]time.Duration{
${alignRows([1, 2, 3, 5, 12].map((attempt) => ({ indent: '\t\t', cells: [`${attempt}:`, `${backoff(attempt)} * time.Millisecond,`] }))).join('\n')}
	} {
		// La referencia es entera en milisegundos; la curva, en nanosegundos.
		if got := kafka.ListenerBackoff(attempt).Truncate(time.Millisecond); got != want {
			t.Errorf("ListenerBackoff(%d) = %v, quiero %v", attempt, got, want)
		}
	}
}

func TestIsRetryable(t *testing.T) {
	transient := errors.New("la base no contesta")
	contract := fmt.Errorf("leer el mensaje: %w", &messaging.ContractError{Reason: "falta un campo"})
	rejected := fmt.Errorf("despachar: %w", &domain.Error{})
	if !kafka.IsRetryable(transient, false) {
		t.Error("un fallo transitorio se reintenta")
	}
	if kafka.IsRetryable(contract, true) {
		t.Error("el contrato incumplido no se reintenta")
	}
	if kafka.IsRetryable(rejected, true) {
		t.Error("el rechazo de negocio no se reintenta")
	}
}

func TestConsumption(t *testing.T) {
	consumption := kafka.Subscriptions()
	if len(consumption) != ${consumption.length} {
		t.Fatalf("consumo: %d suscripciones", len(consumption))
	}
	groups := map[string]bool{}
	for _, entry := range consumption {
		if groups[entry.GroupID] {
			t.Errorf("el grupo %s se repite: cada suscripción necesita el suyo para recibir el topic entero", entry.GroupID)
		}
		groups[entry.GroupID] = true
	}
${deadLettered ? `	if got := kafka.DeadLetterTopic(${goString(deadLettered.topic)}); got != ${goString(`${deadLettered.topic}.DLT`)} {
		t.Errorf("DeadLetterTopic = %q", got)
	}
` : ''}${retriesNotFound ? `	if !consumption[${consumption.indexOf(retriesNotFound)}].RetriesNotFound {
		t.Error(${goString(`${retriesNotFound.subscription} reintenta el «no existe»`)})
	}
` : ''}	if len(consumption) > 0 {
		consumption[0].Topic = "otro"
		if kafka.Subscriptions()[0].Topic == "otro" {
			t.Error("Subscriptions() devuelve el consumo de build, no una copia")
		}
	}
}

func TestSettings(t *testing.T) {
	load := func(t *testing.T, yaml string) (kafka.Settings, error) {
		t.Helper()
		files := fstest.MapFS{
			"application.yaml":            {Data: []byte("server:\\n  port: 8080\\n")},
			"parameters/local/kafka.yaml": {Data: []byte(yaml)},
		}
		cfg, err := config.Load(files, func(string) string { return "" })
		if err != nil {
			t.Fatal(err)
		}
		return kafka.SettingsFrom(cfg)
	}
	settings, err := load(t, "kafka:\\n  bootstrap-servers: uno:9092, dos:9092\\n")
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled || strings.Join(settings.BootstrapServers, ",") != "uno:9092,dos:9092" || settings.DeliveryTimeout != ${KAFKA_PRODUCER_TIMEOUTS.delivery.default}*time.Millisecond || settings.MetadataRefreshInterval != ${KAFKA_DEFAULT_METADATA_REFRESH_MS}*time.Millisecond {
		t.Errorf("defaults: %+v", settings)
	}
	if settings, _ := load(t, "kafka:\\n  enabled: false\\n"); settings.Enabled {
		t.Error("enabled: false apaga la conexión")
	}
	if _, err := load(t, "kafka:\\n  producer:\\n    delivery-timeout-ms: nunca\\n"); err == nil || !strings.Contains(err.Error(), "delivery-timeout-ms") {
		t.Errorf("un plazo que no es un entero positivo no deja arrancar: %v", err)
	}
}
`;
}
