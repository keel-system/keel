// RabbitMQ en keel-go (incremento 9): lo que en el servidor de keel-spring ponen Spring Boot y build sin que el agente
// escriba nada, en el paquete `internal/infrastructure/rabbitmq`. El gemelo de `rabbitmq.js` de keel-dotnet y keel-nest:
//
//   · la TOPOLOGÍA de consumo y de publicación (topology.go), como DATOS de keel-core (gen/messaging-plan.js): por cola,
//     el exchange topic del canal de origen, la cola propia de este servicio enlazada con `#` y su DLQ por argumentos
//     `x-dead-letter-*`; por canal publicado, una cola durable enlazada con la routing key de cada evento. Es la de
//     `RabbitTopologyConfig` de keel-spring, con los mismos nombres. Y la política de REINTENTO del listener
//     (`rabbitListenerRetry`, neutral), con lo que no se reintenta: el rechazo de negocio (*domain.Error) y el contrato
//     incumplido (*messaging.ContractError);
//   · la CONEXIÓN (connection.go, sobre github.com/rabbitmq/amqp091-go): las mismas variables que keel-spring, el
//     servicio arranca SIN broker y conecta en segundo plano, y una conexión que cae se rehace con la misma espera
//     creciente. La reconexión es un bucle PROPIO (`Run`, en el errgroup del arranque), no la recuperación automática de
//     la biblioteca: es de 2026 y cada versión trae arreglos de corrección. Al conectar declara la topología, y cada
//     consumidor (`Consume`, uno por cola y bloqueante: un listener del errgroup) se reabre sobre la conexión nueva.
//     Publicación con confirmación del broker y `mandatory` (lo que en Spring son `publisher-confirm-type: correlated`
//     y `template.mandatory`), y un consumo que hace lo que el contenedor de Spring: confirmar al terminar bien,
//     reintentar en memoria con la curva del diseño y, agotado o no reintentable, rechazar SIN reencolar
//     (`default-requeue-rejected: false`), que es lo que lleva el mensaje a su DLQ.
//
// Lo que escribe el agente (skill keel-go-rabbitmq) es lo mismo que en keel-spring: el messaging.Dispatcher del outbox o
// los publishers best-effort sobre `Connection.Publish`, y los listeners sobre `Connection.Consume`, en
// cmd/server/broker.go. No declara topología.

import { rabbitListenerRetry } from '@keel-system/keel-core/gen';
import { RABBIT_CONFIRM_TIMEOUT_MS, RABBIT_PREFETCH, RABBIT_RECOVERY_INTERVAL_MS, publishedChannels, rabbitTopology, rabbitYaml } from '@keel-system/keel-core/gen/messaging-plan';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { MESSAGING_IMPORT, usesGoMessaging } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const AMQP = { path: 'github.com/rabbitmq/amqp091-go', name: 'amqp' };
export const RABBITMQ_IMPORT = 'internal/infrastructure/rabbitmq';

/** ¿Genera el servicio la conexión con RabbitMQ? */
export function usesGoRabbitMq(model) {
  return usesGoMessaging(model) && model.stack?.broker === 'rabbitmq';
}

/** El nombre con el que el servicio se presenta al broker: el arnés busca así su conexión (el de keel-dotnet). */
export function connectionName(model) {
  return model.service.name;
}

export function generate(model) {
  if (!usesGoRabbitMq(model)) return [];
  const { rabbitmq } = layout(model);
  const file = (name, imports, body, { test = false } = {}) => ({
    path: `${rabbitmq.dir}/${name}${test ? '_test' : ''}.go`,
    content: packageFile(model, rabbitmq, { imports, body, test, doc: name === 'doc' ? PACKAGE_DOC : null })
  });
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/rabbitmq.yaml`, content: rabbitYaml(profile) })),
    file('doc', [], ''),
    file('topology', ['errors', 'fmt', 'math', 'slices', 'time', AMQP, 'internal/domain', MESSAGING_IMPORT], topologyBody(model)),
    file('settings', ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], settingsBody()),
    file('connection', ['context', 'errors', 'fmt', 'log/slog', 'net', 'strconv', 'sync', 'time', AMQP, 'github.com/google/uuid', MESSAGING_IMPORT], connectionBody(model)),
    file('rabbitmq', ['errors', 'fmt', 'strings', 'testing', 'testing/fstest', 'time', 'internal/domain', 'internal/platform/config', MESSAGING_IMPORT, RABBITMQ_IMPORT], emittedTest(model), {
      test: true
    })
  ];
}

const PACKAGE_DOC = `Package rabbitmq es la conexión del servicio con RabbitMQ: la topología que declara build (la misma que la del
servidor de keel-spring del diseño), la reconexión, la publicación con confirmación y el consumo con reintento y
descarte. El dispatcher del outbox (o los publishers) y los listeners los escribe el agente en cmd/server/broker.go
sobre Connection.Publish y Connection.Consume.`;

// ─── topology.go ─────────────────────────────────────────────────────────────────────────────────

const goStrings = (items) => `[]string{${items.map(goString).join(', ')}}`;

function topologyBody(model) {
  const topology = rabbitTopology(model);
  const retry = rabbitListenerRetry(model);
  const published = publishedChannels(model);
  const queues = topology.map((entry) => {
    const fields = [`Source: ${goString(entry.source)}`, `Queue: ${goString(entry.queue)}`];
    if (entry.deadLetter) fields.push(`DeadLetter: ${goString(entry.deadLetter)}`);
    if (entry.retriesNotFound) fields.push('RetriesNotFound: true');
    fields.push(`Subscriptions: ${goStrings(entry.subscriptions)}`);
    return `\t{${fields.join(', ')}},`;
  });
  const channels = published.map((entry) => `\t{Channel: ${goString(entry.channel)}, Events: ${goStrings(entry.events)}},`);
  const multiplier = Number.isInteger(retry?.multiplier) ? `${retry.multiplier}.0` : retry?.multiplier;
  const retryLiteral = retry
    ? `&ListenerRetry{Attempts: ${retry.attempts}, Initial: ${retry.initialMs} * time.Millisecond, Multiplier: ${multiplier}${retry.maxDelayMs != null ? `, MaxDelay: ${retry.maxDelayMs} * time.Millisecond` : ''}}`
    : 'nil';
  const list = (rows, type) => (rows.length === 0 ? `[]${type}{}` : `[]${type}{\n${rows.join('\n')}\n}`);
  return `
// QueueTopology es la topología de consumo de una cola de este servicio: Source es el exchange (topic) del canal de
// origen, el del emisor; Queue, la cola PROPIA de este servicio, enlazada al exchange con '#'; DeadLetter, su descarte,
// enlazado por argumentos x-dead-letter-* (vacío si ninguna suscripción lo declara); RetriesNotFound, si se reintenta
// aquí el «no existe» del caso de uso (el RETRIES_NOT_FOUND de keel-spring), y Subscriptions, las suscripciones del
// diseño que consumen de ella.
type QueueTopology struct {
	Source          string
	Queue           string
	DeadLetter      string
	RetriesNotFound bool
	Subscriptions   []string
}

// PublishedChannel es un canal del diseño en el que este servicio publica, con los eventos que viajan por él.
type PublishedChannel struct {
	Channel string
	Events  []string
}

// ListenerRetry es el reintento del listener, de onFailure.retry (keel-core, rabbitListenerRetry): los intentos de una
// entrega (el primero incluido), la primera espera, el multiplicador y el techo de la espera (0, sin techo).
type ListenerRetry struct {
	Attempts   int
	Initial    time.Duration
	Multiplier float64
	MaxDelay   time.Duration
}

// La topología RabbitMQ del servicio: la MISMA que declara RabbitTopologyConfig en el servidor de keel-spring del diseño.
//
// El canal que nombra el diseño es el exchange del emisor, y de un exchange no se consume: cuelga de él una cola propia de
// este servicio (dos servicios en el mismo canal necesitan colas distintas, o el broker les repartiría los mensajes). El
// binding es '#' porque el canal transporta todo lo que publica su emisor: el filtro por tipo va en el listener.
//
// Lo que este servicio PUBLICA: por canal, sus eventos. De ahí sale la topología de publicación —el exchange del
// servicio (messaging.publishing.destination) y una cola durable por canal, nombrada como el canal y enlazada con la
// routing key de cada uno de sus eventos—. Sin una cola enlazada, un exchange topic descarta en silencio lo publicado, y
// con mandatory la publicación falla y el outbox reintenta hasta rendirse. Es también la cola de la que el arnés lee lo
// publicado.
//
// Es de BUILD: no la redeclares en un listener. Dos declaraciones de la misma cola con argumentos distintos hacen que
// RabbitMQ rechace la segunda con PRECONDITION_FAILED.
var (
	queues = ${list(queues, 'QueueTopology')}

	published = ${list(channels, 'PublishedChannel')}

	// El reintento ${retry ? `que declaran ${retry.subscriptions.join(', ')}` : 'de las suscripciones: ninguna lo declara, así que un fallo va al descarte al primer intento'}. Uno para todo el
	// contenedor, como en keel-spring: con varias políticas gana la más paciente.
	retry = ${retryLiteral}
)

// Queues es la topología de consumo, una entrada por cola.
func Queues() []QueueTopology {
	return slices.Clone(queues)
}

// Published son los canales en los que publica el servicio.
func Published() []PublishedChannel {
	return slices.Clone(published)
}

// ListenerAttempts son los intentos de una entrega, el primero incluido.
func ListenerAttempts() int {
	if retry == nil {
		return 1
	}
	return retry.Attempts
}

// ListenerBackoff es la espera antes del intento attempt+1: initial·multiplier^(attempt-1), con su techo.
func ListenerBackoff(attempt int) time.Duration {
	if retry == nil {
		return 0
	}
	delay := float64(retry.Initial) * math.Pow(retry.Multiplier, float64(max(attempt-1, 0)))
	if retry.MaxDelay > 0 && delay > float64(retry.MaxDelay) {
		return retry.MaxDelay
	}
	return time.Duration(delay)
}

// IsRetryable dice si se reintenta un fallo del handler. No el rechazo de negocio (*domain.Error): no se resuelve mejor
// dentro de un segundo, y peor, el reintento en memoria repite la MISMA entrega, así que una guarda que reclama antes
// (TryRecord) encontraría el evento ya marcado y lo confirmaría sin que llegara nunca al descarte. Ni el contrato
// incumplido (*messaging.ContractError): un mensaje mal formado no se vuelve válido.
//
// Salvo el «no existe» donde la cola lo admite (retriesNotFound): suele ser la carrera de orden de un consumo asíncrono
// (llegó antes que el hecho del que depende) y el reintento la resuelve. Solo con guarda de dominio, que con TryRecord el
// reintento encontraría el evento ya marcado.
func IsRetryable(err error, retriesNotFound bool) bool {
	var rejected *domain.Error
	if errors.As(err, &rejected) {
		return retriesNotFound && rejected.Kind() == domain.KindNotFound
	}
	var contract *messaging.ContractError
	return !errors.As(err, &contract)
}

// RetriesNotFoundOn dice si queue reintenta el «no existe», por el nombre con el que se consume, como la política de
// keel-spring.
func RetriesNotFoundOn(queue string) bool {
	return slices.ContainsFunc(queues, func(entry QueueTopology) bool { return entry.Queue == queue && entry.RetriesNotFound })
}

// declare declara la topología: la de publicación (con el destino y las routing keys del perfil) y la de consumo.
// Idempotente: se repite en cada conexión.
func declare(ch *amqp.Channel, publishing messaging.Settings) error {
	if len(published) > 0 {
		if err := ch.ExchangeDeclare(publishing.Destination, amqp.ExchangeTopic, true, false, false, false, nil); err != nil {
			return fmt.Errorf("declarar el exchange %s: %w", publishing.Destination, err)
		}
		for _, entry := range published {
			if _, err := ch.QueueDeclare(entry.Channel, true, false, false, false, nil); err != nil {
				return fmt.Errorf("declarar la cola %s: %w", entry.Channel, err)
			}
			for _, event := range entry.Events {
				key, ok := publishing.RoutingKeys[event]
				if !ok {
					return fmt.Errorf("sin routing key para el evento %s en la configuración de mensajería", event)
				}
				if err := ch.QueueBind(entry.Channel, key, publishing.Destination, false, nil); err != nil {
					return fmt.Errorf("enlazar la cola %s con %s: %w", entry.Channel, key, err)
				}
			}
		}
	}
	for _, entry := range queues {
		if err := ch.ExchangeDeclare(entry.Source, amqp.ExchangeTopic, true, false, false, false, nil); err != nil {
			return fmt.Errorf("declarar el exchange %s: %w", entry.Source, err)
		}
		var arguments amqp.Table
		if entry.DeadLetter != "" {
			if _, err := ch.QueueDeclare(entry.DeadLetter, true, false, false, false, nil); err != nil {
				return fmt.Errorf("declarar la cola de descarte %s: %w", entry.DeadLetter, err)
			}
			arguments = amqp.Table{"x-dead-letter-exchange": "", "x-dead-letter-routing-key": entry.DeadLetter}
		}
		if _, err := ch.QueueDeclare(entry.Queue, true, false, false, false, arguments); err != nil {
			return fmt.Errorf("declarar la cola %s: %w", entry.Queue, err)
		}
		if err := ch.QueueBind(entry.Queue, "#", entry.Source, false, nil); err != nil {
			return fmt.Errorf("enlazar la cola %s con %s: %w", entry.Queue, entry.Source, err)
		}
	}
	return nil
}
`;
}

// ─── settings.go ─────────────────────────────────────────────────────────────────────────────────

function settingsBody() {
  return `
// Settings es la conexión con RabbitMQ del perfil activo, con las mismas variables que keel-spring: Enabled es false
// en el perfil test (las pruebas de build arrancan sin broker), RecoveryInterval el techo de la espera entre
// reconexiones (la recuperación del listener de keel-spring) y ConfirmTimeout cuánto espera una publicación la
// confirmación del broker.
type Settings struct {
	Enabled          bool
	Host             string
	Port             int
	Username         string
	Password         string
	RecoveryInterval time.Duration
	ConfirmTimeout   time.Duration
}

// SettingsFrom lee y valida la conexión del perfil al ARRANCAR: un número que no es un entero positivo no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key, fallback string) string {
		if value, ok := cfg.Value(key); ok && strings.TrimSpace(value) != "" {
			return value
		}
		return fallback
	}
	enabled, _ := cfg.Value("rabbitmq.enabled")
	port, err := positive(cfg, "rabbitmq.port", 5672)
	if err != nil {
		return Settings{}, err
	}
	recovery, err := positive(cfg, "rabbitmq.listener.recovery-interval-ms", ${RABBIT_RECOVERY_INTERVAL_MS})
	if err != nil {
		return Settings{}, err
	}
	confirm, err := positive(cfg, "rabbitmq.publisher.confirm-timeout-ms", ${RABBIT_CONFIRM_TIMEOUT_MS})
	if err != nil {
		return Settings{}, err
	}
	return Settings{
		Enabled:          !strings.EqualFold(strings.TrimSpace(enabled), "false"),
		Host:             text("rabbitmq.host", "localhost"),
		Port:             port,
		Username:         text("rabbitmq.username", "guest"),
		Password:         text("rabbitmq.password", "guest"),
		RecoveryInterval: time.Duration(recovery) * time.Millisecond,
		ConfirmTimeout:   time.Duration(confirm) * time.Millisecond,
	}, nil
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
// ErrUnavailable es una publicación que no salió: sin conexión, rechazada por el broker, sin cola a la que ir o sin
// confirmación a tiempo. El relay del outbox cuenta el intento y la reintenta.
var ErrUnavailable = errors.New("RabbitMQ no aceptó la publicación")

const (
	// prefetch es el del contenedor de listeners del servidor de keel-spring.
	prefetch = ${RABBIT_PREFETCH}
	// firstRetry es la primera espera entre intentos de conexión; se dobla hasta Settings.RecoveryInterval.
	firstRetry = 200 * time.Millisecond
	// dialTimeout es cuánto espera un intento de conexión.
	dialTimeout = 5 * time.Second
	// closeTimeout es cuánto espera el apagado a que la conexión se cierre: un broker que no contesta no puede retener
	// el apagado del servicio, que tiene su propio margen (server.shutdown-timeout).
	closeTimeout = 5 * time.Second
	// connectionName es el nombre con el que se presenta al broker: el arnés busca así la conexión del servicio.
	connectionName = ${goString(connectionName(model))}
)

// Message es un mensaje recibido de una cola: Body es el cuerpo (JSON con el contrato del cable), Type el tipo nativo
// del mensaje (la propiedad type de AMQP) y Headers sus cabeceras, con los valores de texto ya decodificados.
type Message struct {
	Queue      string
	Body       []byte
	RoutingKey string
	Type       string
	MessageID  string
	Headers    map[string]string
}

// Handler procesa un mensaje. Un error que IsRetryable admite se reintenta con la curva del diseño; el resto, o el
// último intento, lo descarta (a la DLQ si la cola la tiene). El contexto no se cancela con el apagado: un mensaje
// empezado se termina.
type Handler func(ctx context.Context, message Message) error

// session es una conexión viva; lost se cierra cuando cae.
type session struct {
	conn *amqp.Connection
	lost chan struct{}
}

// Connection es la conexión con RabbitMQ: una por proceso. Run la mantiene (conecta, declara la topología de build y
// reconecta cuando cae); el servicio arranca SIN broker, como el de keel-spring: la conexión se intenta en segundo plano
// y se reintenta sin fin.
//
// Lo que escribe el agente usa dos métodos:
//   - Publish, con confirmación del broker y mandatory. Vuelve cuando el broker CONFIRMA; si no hay conexión, si lo
//     rechaza, si el mensaje no tenía cola a la que ir o si vence el plazo, devuelve ErrUnavailable. Es lo que necesita
//     el dispatcher del outbox: marcar como publicado lo que el broker descartó es lo que el outbox existe para impedir;
//   - Consume, el consumidor de una cola de la topología, hasta que ctx se cancela: es un listener del arranque.
//     Confirma al terminar bien, reintenta en memoria con la curva del diseño lo que es transitorio y rechaza sin
//     reencolar el resto.
type Connection struct {
	settings  Settings
	messaging messaging.Settings
	logger    *slog.Logger

	// mu guarda la sesión viva y changed, que se cierra (y se reemplaza) cada vez que la sesión cambia.
	mu      sync.Mutex
	current *session
	changed chan struct{}

	// publishing es una publicación a la vez sobre el canal de confirmaciones: así la devolución de un mensaje sin cola
	// (basic.return, que el broker manda ANTES de su confirmación) es siempre la de la publicación en curso.
	publishing sync.Mutex
	confirm    *amqp.Channel
	confirmOf  *session
	returns    chan amqp.Return

	// settling lo tiene cada entrega mientras se procesa y se confirma; el apagado lo toma entero antes de cerrar, así
	// que espera a las que estén en vuelo.
	settling sync.RWMutex
}

// New construye la conexión; no conecta hasta Run.
func New(settings Settings, publishing messaging.Settings, logger *slog.Logger) *Connection {
	return &Connection{settings: settings, messaging: publishing, logger: logger, changed: make(chan struct{})}
}

// Connected dice si hay conexión ahora mismo.
func (c *Connection) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current != nil
}

// Run mantiene la conexión hasta que ctx se cancela: conecta, declara la topología y, cuando la conexión cae, vuelve a
// conectar con una espera que se dobla hasta Settings.RecoveryInterval. Al cancelarse espera a las entregas en vuelo y
// cierra. Con Enabled a false (el perfil test) no conecta nunca.
func (c *Connection) Run(ctx context.Context) error {
	if !c.settings.Enabled {
		return nil
	}
	wait := firstRetry
	for {
		conn, err := c.connect()
		if err != nil {
			c.logger.WarnContext(ctx, "RabbitMQ: no se pudo conectar", "retryIn", wait.String(), "error", err)
			if !sleep(ctx, wait) {
				return nil
			}
			wait = min(wait*2, c.settings.RecoveryInterval)
			continue
		}
		wait = firstRetry
		closed := conn.NotifyClose(make(chan *amqp.Error, 1))
		live := c.publish(&session{conn: conn, lost: make(chan struct{})})
		c.logger.InfoContext(ctx, "RabbitMQ: conectado, topología declarada")
		select {
		case <-ctx.Done():
			c.settling.Lock()
			c.retire(live)
			if err := conn.CloseDeadline(time.Now().Add(closeTimeout)); err != nil && !errors.Is(err, amqp.ErrClosed) {
				c.logger.WarnContext(ctx, "RabbitMQ: cerrar la conexión", "error", err)
			}
			c.settling.Unlock()
			return nil
		case reason := <-closed:
			c.retire(live)
			c.logger.WarnContext(ctx, "RabbitMQ: la conexión se cerró", "reason", fmt.Sprint(reason))
		}
	}
}

// connect abre una conexión y declara la topología en ella.
func (c *Connection) connect() (*amqp.Connection, error) {
	properties := amqp.NewConnectionProperties()
	properties.SetClientConnectionName(connectionName)
	uri := amqp.URI{Scheme: "amqp", Host: c.settings.Host, Port: c.settings.Port, Username: c.settings.Username, Password: c.settings.Password, Vhost: "/"}
	conn, err := amqp.DialConfig(uri.String(), amqp.Config{Properties: properties, Dial: amqp.DefaultDial(dialTimeout)})
	if err != nil {
		return nil, fmt.Errorf("conectar con %s: %w", net.JoinHostPort(c.settings.Host, strconv.Itoa(c.settings.Port)), err)
	}
	ch, err := conn.Channel()
	if err == nil {
		err = declare(ch, c.messaging)
		if closeErr := ch.Close(); err == nil && closeErr != nil && !errors.Is(closeErr, amqp.ErrClosed) {
			err = closeErr
		}
	}
	if err != nil {
		if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, amqp.ErrClosed) {
			c.logger.Warn("RabbitMQ: cerrar la conexión fallida", "error", closeErr)
		}
		return nil, fmt.Errorf("declarar la topología: %w", err)
	}
	return conn, nil
}

// publish hace de s la sesión viva y avisa a quien la espera.
func (c *Connection) publish(s *session) *session {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.current = s
	close(c.changed)
	c.changed = make(chan struct{})
	return s
}

// retire da por perdida la sesión s.
func (c *Connection) retire(s *session) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current == s {
		c.current = nil
		close(c.changed)
		c.changed = make(chan struct{})
	}
	close(s.lost)
}

// await espera a que haya una sesión viva, o a que ctx se cancele.
func (c *Connection) await(ctx context.Context) (*session, error) {
	for {
		c.mu.Lock()
		s, changed := c.current, c.changed
		c.mu.Unlock()
		if s != nil {
			return s, nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Publish publica payload (JSON ya serializado con el contrato del cable) en exchange con routingKey, con eventType como
// tipo nativo del mensaje (sobre él filtran los consumidores). Vuelve cuando el broker confirma; si no salió, el error
// es ErrUnavailable (errors.Is).
func (c *Connection) Publish(ctx context.Context, exchange, routingKey, eventType, payload string, headers map[string]string) error {
	c.publishing.Lock()
	defer c.publishing.Unlock()
	ch, err := c.confirmChannel()
	if err != nil {
		return err
	}
	// Una devolución de una publicación anterior que se quedó sin leer no es de esta.
	select {
	case <-c.returns:
	default:
	}
	id := uuid.NewString()
	message := amqp.Publishing{ContentType: "application/json", DeliveryMode: amqp.Persistent, Type: eventType, MessageId: id, Body: []byte(payload)}
	if len(headers) > 0 {
		message.Headers = amqp.Table{}
		for name, value := range headers {
			message.Headers[name] = value
		}
	}
	confirmCtx, cancel := context.WithTimeout(ctx, c.settings.ConfirmTimeout)
	defer cancel()
	confirmation, err := ch.PublishWithDeferredConfirmWithContext(confirmCtx, exchange, routingKey, true, false, message)
	if err != nil {
		c.confirm = nil
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	acked, err := confirmation.WaitContext(confirmCtx)
	switch {
	case err != nil && ctx.Err() != nil:
		return fmt.Errorf("%w: %w", ErrUnavailable, ctx.Err())
	case err != nil:
		// Sin confirmación a tiempo el canal no sirve: la siguiente publicación abre otro.
		c.confirm = nil
		return fmt.Errorf("%w: RabbitMQ no confirmó la publicación en %v", ErrUnavailable, c.settings.ConfirmTimeout)
	case !acked:
		return fmt.Errorf("%w: RabbitMQ rechazó la publicación", ErrUnavailable)
	}
	select {
	case returned := <-c.returns:
		if returned.MessageId == id {
			return fmt.Errorf("%w: el mensaje no tenía cola en %s con %s", ErrUnavailable, exchange, routingKey)
		}
	default:
	}
	return nil
}

// confirmChannel es el canal de confirmaciones de la sesión viva, abierto bajo demanda. Un canal que el broker cierra
// (una publicación a un exchange que no existe lo hace) se reabre en la publicación siguiente.
func (c *Connection) confirmChannel() (*amqp.Channel, error) {
	c.mu.Lock()
	s := c.current
	c.mu.Unlock()
	if s == nil {
		return nil, fmt.Errorf("%w: no está conectado", ErrUnavailable)
	}
	if c.confirm != nil && c.confirmOf == s && !c.confirm.IsClosed() {
		return c.confirm, nil
	}
	ch, err := s.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("%w: abrir el canal de confirmaciones: %w", ErrUnavailable, err)
	}
	if err := ch.Confirm(false); err != nil {
		return nil, fmt.Errorf("%w: activar las confirmaciones: %w", ErrUnavailable, err)
	}
	c.confirm, c.confirmOf, c.returns = ch, s, ch.NotifyReturn(make(chan amqp.Return, 1))
	return ch, nil
}

// Consume consume queue (una cola de la topología) con handle hasta que ctx se cancela, y vuelve a consumir sobre cada
// conexión nueva. Es un listener del arranque: va en su goroutine. Las entregas de la cola se procesan de una en una.
func (c *Connection) Consume(ctx context.Context, queue string, handle Handler) error {
	retriesNotFound := RetriesNotFoundOn(queue)
	for {
		s, err := c.await(ctx)
		if err != nil {
			return nil
		}
		if err := c.consume(ctx, s, queue, handle, retriesNotFound); err != nil {
			c.logger.WarnContext(ctx, "RabbitMQ: el consumo se interrumpió", "queue", queue, "error", err)
		}
		if ctx.Err() != nil {
			return nil
		}
		// Si cayó la conexión, se espera a la siguiente; si cayó solo el canal, se reabre tras la espera de recuperación.
		timer := time.NewTimer(c.settings.RecoveryInterval)
		select {
		case <-s.lost:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
	}
}

// consume abre un canal en la sesión s y procesa sus entregas hasta que el canal se cierra o ctx se cancela.
func (c *Connection) consume(ctx context.Context, s *session, queue string, handle Handler, retriesNotFound bool) error {
	ch, err := s.conn.Channel()
	if err != nil {
		return fmt.Errorf("abrir el canal: %w", err)
	}
	defer func() {
		if err := ch.Close(); err != nil && !errors.Is(err, amqp.ErrClosed) {
			c.logger.WarnContext(ctx, "RabbitMQ: cerrar el canal del consumidor", "queue", queue, "error", err)
		}
	}()
	if err := ch.Qos(prefetch, 0, false); err != nil {
		return fmt.Errorf("fijar el prefetch: %w", err)
	}
	deliveries, err := ch.ConsumeWithContext(ctx, queue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consumir %s: %w", queue, err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case delivery, ok := <-deliveries:
			if !ok {
				return errors.New("el broker cerró el consumo")
			}
			c.deliver(ctx, queue, delivery, handle, retriesNotFound)
		}
	}
}

// deliver es lo que hace el contenedor de listeners de Spring con cada entrega.
func (c *Connection) deliver(ctx context.Context, queue string, delivery amqp.Delivery, handle Handler, retriesNotFound bool) {
	c.settling.RLock()
	defer c.settling.RUnlock()
	message := messageOf(queue, delivery)
	work := context.WithoutCancel(ctx)
	attempts := ListenerAttempts()
	for attempt := 1; ; attempt++ {
		err := handle(work, message)
		if err == nil {
			c.settle(ctx, delivery, true)
			return
		}
		if !IsRetryable(err, retriesNotFound) || attempt >= attempts {
			// Rechazo SIN reencolar: con DLQ declarada, el broker lo lleva al descarte.
			c.logger.ErrorContext(ctx, "RabbitMQ: mensaje descartado", "queue", queue, "routingKey", delivery.RoutingKey, "attempts", attempt, "error", err)
			c.settle(ctx, delivery, false)
			return
		}
		c.logger.WarnContext(ctx, "RabbitMQ: fallo procesando un mensaje", "queue", queue, "attempt", attempt, "error", err)
		if !sleep(ctx, ListenerBackoff(attempt)) {
			// El apagado: ni se confirma ni se descarta, y el broker lo reentrega al cerrarse el canal.
			return
		}
	}
}

// settle confirma o rechaza; con el canal ya cerrado (el broker se fue) no hay a quién, y el broker lo reentregará.
func (c *Connection) settle(ctx context.Context, delivery amqp.Delivery, accept bool) {
	var err error
	if accept {
		err = delivery.Ack(false)
	} else {
		err = delivery.Nack(false, false)
	}
	if err != nil {
		c.logger.WarnContext(ctx, "RabbitMQ: no se pudo resolver la entrega (canal cerrado)", "accept", accept, "error", err)
	}
}

// messageOf copia la entrega en un Message.
func messageOf(queue string, delivery amqp.Delivery) Message {
	headers := make(map[string]string, len(delivery.Headers))
	for name, value := range delivery.Headers {
		switch v := value.(type) {
		case string:
			headers[name] = v
		case []byte:
			headers[name] = string(v)
		default:
			headers[name] = fmt.Sprint(v)
		}
	}
	return Message{Queue: queue, Body: delivery.Body, RoutingKey: delivery.RoutingKey, Type: delivery.Type, MessageID: delivery.MessageId, Headers: headers}
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

// ─── rabbitmq_test.go ────────────────────────────────────────────────────────────────────────────

function emittedTest(model) {
  const retry = rabbitListenerRetry(model);
  const backoff = (attempt) => {
    if (!retry) return 0;
    const delay = retry.initialMs * retry.multiplier ** Math.max(attempt - 1, 0);
    return Math.floor(retry.maxDelayMs != null ? Math.min(delay, retry.maxDelayMs) : delay);
  };
  const retriesNotFound = rabbitTopology(model).find((entry) => entry.retriesNotFound);
  return `
// Lo que la conexión decide sin broker: la curva del reintento contra la de keel-core (rabbitListenerRetry), qué fallo se
// reintenta y la configuración del perfil. Lo que hace con un broker real (topología, confirmación, descarte a la DLQ,
// reconexión) lo mide broker-check.

func TestListenerRetry(t *testing.T) {
	if got := rabbitmq.ListenerAttempts(); got != ${retry ? retry.attempts : 1} {
		t.Errorf("ListenerAttempts() = %d, quiero ${retry ? retry.attempts : 1}", got)
	}
	for attempt, want := range map[int]time.Duration{
${[1, 2, 3, 5, 12].map((attempt) => `		${attempt}: ${backoff(attempt)} * time.Millisecond,`).join('\n')}
	} {
		// La referencia es entera en milisegundos; la curva, en nanosegundos.
		if got := rabbitmq.ListenerBackoff(attempt).Truncate(time.Millisecond); got != want {
			t.Errorf("ListenerBackoff(%d) = %v, quiero %v", attempt, got, want)
		}
	}
}

func TestIsRetryable(t *testing.T) {
	transient := errors.New("la base no contesta")
	contract := fmt.Errorf("leer el mensaje: %w", &messaging.ContractError{Reason: "falta un campo"})
	rejected := fmt.Errorf("despachar: %w", &domain.Error{})
	if !rabbitmq.IsRetryable(transient, false) {
		t.Error("un fallo transitorio se reintenta")
	}
	if rabbitmq.IsRetryable(contract, true) {
		t.Error("el contrato incumplido no se reintenta")
	}
	if rabbitmq.IsRetryable(rejected, true) {
		t.Error("el rechazo de negocio no se reintenta")
	}
${retriesNotFound
    ? `	if !rabbitmq.RetriesNotFoundOn(${goString(retriesNotFound.queue)}) {
		t.Error(${goString(`${retriesNotFound.queue} reintenta el «no existe»`)})
	}
`
    : ''}	if rabbitmq.RetriesNotFoundOn("no-es-una-cola") {
		t.Error("una cola que no es de la topología no reintenta nada")
	}
}

func TestTopologyIsCopied(t *testing.T) {
	queues := rabbitmq.Queues()
	if len(queues) != ${rabbitTopology(model).length} || len(rabbitmq.Published()) != ${publishedChannels(model).length} {
		t.Fatalf("topología: %d colas y %d canales", len(queues), len(rabbitmq.Published()))
	}
	if len(queues) > 0 {
		queues[0].Queue = "otra"
		if rabbitmq.Queues()[0].Queue == "otra" {
			t.Error("Queues() devuelve la topología de build, no una copia")
		}
	}
}

func TestSettings(t *testing.T) {
	load := func(t *testing.T, yaml string) (rabbitmq.Settings, error) {
		t.Helper()
		files := fstest.MapFS{
			"application.yaml":               {Data: []byte("server:\\n  port: 8080\\n")},
			"parameters/local/rabbitmq.yaml": {Data: []byte(yaml)},
		}
		cfg, err := config.Load(files, func(string) string { return "" })
		if err != nil {
			t.Fatal(err)
		}
		return rabbitmq.SettingsFrom(cfg)
	}
	settings, err := load(t, "rabbitmq:\\n  host: broker\\n")
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled || settings.Host != "broker" || settings.Port != 5672 || settings.RecoveryInterval != ${RABBIT_RECOVERY_INTERVAL_MS}*time.Millisecond || settings.ConfirmTimeout != ${RABBIT_CONFIRM_TIMEOUT_MS}*time.Millisecond {
		t.Errorf("defaults: %+v", settings)
	}
	if settings, _ := load(t, "rabbitmq:\\n  enabled: false\\n"); settings.Enabled {
		t.Error("enabled: false apaga la conexión")
	}
	if _, err := load(t, "rabbitmq:\\n  port: cero\\n"); err == nil || !strings.Contains(err.Error(), "rabbitmq.port") {
		t.Errorf("un puerto que no es un entero positivo no deja arrancar: %v", err)
	}
}
`;
}
