// La mensajería en el ARNÉS de integración de keel-go (incremento 9c): lo que una prueba de flujo usa para entregar un
// mensaje a una suscripción, leer lo publicado y lo descartado, tumbar y levantar el broker, y fabricar las
// precondiciones del outbox. Son los helpers del AbstractFlowIT de keel-spring, de `flow.ts` de keel-nest y de
// `Support/Messaging.cs` de keel-dotnet, como métodos del `*Scenario`: `Deliver<Sub>`, `PublishedMessages`,
// `DeadLetterMessages`, `PurgeMessages`, `StopBroker`/`StartBroker`, `DeadLetteredEvents` y `AbandonOutboxEvent`.
//
// Los comandos con los que se habla con el broker NO se escriben aquí: salen de keel-core/gen/broker-probes.js —los
// mismos que ejecutan los arneses de los otros tres generadores y los `broker-check`—, renderizados a Go con
// `renderParts`/`spliceBody`. Viajan por el contenedor devtools de infra/, que está en la red del compose.
//
// El servidor es un PROCESO aparte (caja negra), como en keel-spring y keel-dotnet: lo rendido del outbox y su abandono
// se leen y fabrican en la base (outbox_event), y la espera a que el servidor esté conectado se le pregunta al broker:
// en RabbitMQ, entre sus conexiones, la que se presenta con el nombre del servicio (rabbitmq.connectionName); en Kafka,
// sus consumer groups, con la CLI del propio broker (lo que hace el AdminClient del AbstractFlowIT de keel-spring): el
// arnés solo usa la biblioteca estándar.
//
// Kafka no tiene purga (kcat no borra registros): el aislamiento entre flujos es una MARCA DE OFFSET por canal y por
// topic de descarte, que se fija al abrir cada flujo — la misma que los arneses de los otros tres generadores.
//
// RabbitMQ (9c) y Kafka (9f); SNS/SQS llega con su conexión (tramo 9g).

import {
  ENDPOINTS,
  PROBE_BODY_FILE,
  RECORD_FORMAT,
  UNKNOWN_TOPIC,
  deliverParts,
  deliverShell,
  expr,
  hole,
  kafkaGroupMembersParts,
  offsetsParts,
  purgeParts,
  rabbitProbeBody,
  rabbitPublishBody,
  readParts,
  renderParts,
  shellQuote,
  spliceBody
} from '@keel-system/keel-core/gen/broker-probes';
import { BROKERS, KAFKA_PRODUCER_TIMEOUTS, brokerContainer, devtoolsContainer } from '@keel-system/keel-core/gen/infra-catalog';
import { deadLetterDestination, subscriptionDestination } from '@keel-system/keel-core/gen';
import { OUTBOX_RELAY, parameterValue } from '@keel-system/keel-core/gen/messaging-stores';
import { groupEnv, kafkaConsumption, publishedChannels, topicEnv } from '@keel-system/keel-core/gen/messaging-plan';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { usesGoOutbox } from './messaging.js';
import { connectionName, usesGoRabbitMq } from './rabbitmq.js';
import { usesGoKafka } from './kafka.js';

/** El archivo del arnés: lo nombra la documentación neutral de infra/ (GO_INFRA.messaging.harnessReaders). */
export const MESSAGING_HARNESS_FILE = 'messaging_test.go';

/** ¿Lleva el arnés la mensajería? Con los brokers cuya conexión genera keel-go. */
export function usesMessagingHarness(model) {
  return usesGoRabbitMq(model) || usesGoKafka(model);
}

// Muy por encima de cualquier `outbox.relay.max-attempts`: el abandono no depende del perfil (el mismo número que los
// arneses de keel-spring y keel-dotnet).
const ABANDONED = 1000000;

// Los argumentos de una llamada: gofmt escribe la concatenación sin espacios dentro de una lista de argumentos.
const go = (parts) => renderParts(parts, goString).replaceAll(' + ', '+');

/** Los imports de messaging_test.go. */
export function messagingHarnessImports(model) {
  const imports = ['context', 'crypto/rand', 'encoding/base64', 'encoding/json', 'fmt', 'maps', 'os', 'slices', 'strconv', 'strings', 'sync/atomic', 'time'];
  if (usesGoOutbox(model)) imports.push('errors');
  if (usesGoKafka(model)) imports.push('regexp', 'sync');
  return imports;
}

/** El cuerpo de tests/integration/messaging_test.go, o null sin mensajería. */
export function messagingHarnessBody(model) {
  if (!usesMessagingHarness(model)) return null;
  const sections = [scenarioMethods(model), messageType(model), plumbing(model), usesGoKafka(model) ? kafkaBody(model) : rabbitBody(model), usesGoOutbox(model) ? outboxBody(model) : ''];
  return `\n${sections.map((section) => section.trim()).filter(Boolean).join('\n\n')}\n`;
}

/** El caso del humo: el broker responde y el servidor está conectado a él. */
export function messagingSmokeCase(model) {
  if (!usesMessagingHarness(model)) return null;
  return String.raw`	f.Scenario("SMOKE-8: el broker responde y el servidor está conectado a él", func(s *Scenario) {
		// Sin ella, toda entrega se queda en la cola y los Then de los flujos de mensajería agotan su espera.
		s.AssertBrokerConnected()
	})`;
}

// ─── Los métodos del escenario ───────────────────────────────────────────────────────────────────

function scenarioMethods(model) {
  const outbox = usesGoOutbox(model);
  const kafka = usesGoKafka(model);
  const deliverDoc = kafka
    ? `// DeliverMessage publica un registro crudo en un topic (el de una fuente), con key como su clave y headers como sus
// headers. El cuerpo viaja en UNA línea: kcat publica un registro por línea.`
    : `// DeliverMessage publica un mensaje crudo en un exchange (el canal de una fuente), con key como message_id y routing
// key y headers como sus cabeceras. Falla si RabbitMQ no lo enrutó a ninguna cola: lo acepta con 200 y "routed":false,
// y sin esto el escenario moriría mucho después en una espera que habla de otra cosa.`;
  const purgeDoc = kafka
    ? `// PurgeMessages «vacía» un canal publicado o el descarte de una suscripción: Kafka no borra, así que mueve su marca al
// final y lo anterior deja de leerse (el topic de una suscripción no se toca: lo que publicó la fuente, ahí sigue).`
    : '// PurgeMessages vacía un canal publicado, el descarte de una suscripción o su cola (por el nombre de la suscripción).';
  return String.raw`
// PublishedMessages es lo publicado en un canal del diseño desde el último reset (como mucho los readLimit primeros).${outbox ? `
// Espera antes a que el relay del outbox entregue lo que tenga pendiente: si no, lo que se lee depende de su fase.` : ''}
// Leer no consume: un escenario puede afirmar dos veces sobre el mismo mensaje.
func (s *Scenario) PublishedMessages(channel string) []BrokerMessage {
	s.Helper()
	messages, err := published(s.Context(), channel)
	if err != nil {
		s.Fatal(err)
	}
	return messages
}

// DeadLetterMessages es lo que acabó en el descarte de una suscripción desde el último reset. Úsalo también —y sobre
// todo— para la aserción NEGATIVA: un duplicado absorbido se confirma SIN acabar aquí.
func (s *Scenario) DeadLetterMessages(subscription string) []BrokerMessage {
	s.Helper()
	messages, err := deadLetters(s.Context(), subscription)
	if err != nil {
		s.Fatal(err)
	}
	return messages
}

${purgeDoc}
// El reset ya lo hace al abrir el flujo; repítelo justo antes de la acción cuyo Then afirma que NO se publica nada.
func (s *Scenario) PurgeMessages(channelOrSubscription string) {
	s.Helper()
	if err := purge(s.Context(), channelOrSubscription); err != nil {
		s.Fatal(err)
	}
}

${deliverDoc}
func (s *Scenario) DeliverMessage(destination, key, body string, headers map[string]string) {
	s.Helper()
	if err := deliver(s.Context(), destination, key, body, headers); err != nil {
		s.Fatal(err)
	}
}
${(model.subscriptions ?? []).map((sub) => deliverMethod(sub)).join('')}
// StopBroker detiene el broker (el escenario del canal indisponible). Las lecturas devuelven vacío mientras tanto.
func (s *Scenario) StopBroker() {
	s.Helper()
	if err := stopBroker(s.Context()); err != nil {
		s.Fatal(err)
	}
}

// StartBroker lo vuelve a levantar y espera a que la conexión del servicio se recupere.
func (s *Scenario) StartBroker() {
	s.Helper()
	if err := startBroker(s.Context()); err != nil {
		s.Fatal(err)
	}
}

// AssertBrokerConnected falla el escenario si el broker no responde o el servidor no está conectado a él.
func (s *Scenario) AssertBrokerConnected() {
	s.Helper()
	if err := prepareBroker(s.Context()); err != nil {
		s.Fatal(err)
	}
}
${outbox ? outboxMethods() : ''}`;
}

function deliverMethod(sub) {
  const headers = [];
  if (sub.discriminator?.location === 'header') headers.push([goString(sub.discriminator.name), goString(sub.discriminator.value ?? sub.name)]);
  // El tipo como atributo nativo, además de donde lo lleve la envoltura: es lo que estampa un emisor real.
  if (sub.discriminator?.location !== 'header' || sub.discriminator.name !== 'eventType') headers.push(['"eventType"', goString(sub.name)]);
  if (sub.messageId?.location === 'header') headers.push([goString(sub.messageId.name), 'messageID']);
  const delivery = sub.identityDelivery;
  if (delivery?.placement === 'header') headers.push([goString(delivery.name), 'source']);
  const params = delivery ? 'messageID, source, payloadJSON string' : 'messageID, payloadJSON string';
  let body;
  if (sub.envelope === 'keel') {
    // La envoltura COMPLETA, como la publica cualquier servicio Keel: la metadata en el orden del cable.
    const source = delivery?.placement === 'metadata' && delivery.name === 'source' ? 'source' : goString(sub.source ?? 'keel-harness');
    body = [
      '`{"metadata":{"eventId":` + jsonText(messageID)',
      `\`,"eventType":\` + jsonText(${goString(sub.name)})`,
      '`,"eventVersion":1,"occurredAt":` + jsonText(time.Now().UTC().Format(instantLayout))',
      `\`,"source":\` + jsonText(${source})`,
      '`,"correlationId":null,"traceparent":null},"data":` + payloadJSON + `}`'
    ].join(' +\n\t\t');
  } else if (sub.envelope === 'wrapped') {
    const fields = [];
    if (sub.discriminator?.location === 'field') fields.push(`\`"${sub.discriminator.name}":\` + jsonText(${goString(sub.discriminator.value ?? sub.name)})`);
    if (sub.messageId?.location === 'field') fields.push(`\`"${sub.messageId.name}":\` + jsonText(messageID)`);
    if (delivery?.placement === 'envelopeField') fields.push(`\`"${delivery.name}":\` + jsonText(source)`);
    fields.push(`\`"${sub.payloadPath}":\` + payloadJSON`);
    body = `"{" + ${fields.join(' + "," + ')} + "}"`;
  } else {
    body = 'payloadJSON';
  }
  const identity =
    sub.envelope === 'keel' ? 'el eventId de la envoltura Keel' : sub.messageId ? `el ${sub.messageId.location === 'header' ? 'header' : 'campo'} '${sub.messageId.name}' del contrato` : null;
  const name = goExported(sub.name);
  return `
// Deliver${name} entrega ${sub.name} en su canal real, con la envoltura que declara el contrato (${sub.envelope}).
//
// messageID es la identidad del mensaje${identity ? `, que viaja en ${identity}` : ''}: llamar dos veces con el MISMO
// valor es la REENTREGA que el consumidor debe absorber sin segundo efecto.${
    identity ? '' : '\n// OJO: el contrato no declara messageId ni usa la envoltura Keel, así que el consumidor no tiene con qué deduplicar.'
  }${delivery ? `\n// source es la identidad de quien pide el trabajo (${sub.identity.from.name}).` : ''}
// payloadJSON es el payload ya escrito como JSON.
func (s *Scenario) Deliver${name}(${params}) {
	s.Helper()
	destination := envOr(${goString(topicEnv(sub))}, ${goString(sub.topicDefault)})
	body := ${body}
	s.DeliverMessage(destination, messageID, body, map[string]string{${headers.map(([key, value]) => `${key}: ${value}`).join(', ')}})
}
`;
}

function outboxMethods() {
  return String.raw`
// DeadLetteredEvents es cuántos eventos se rindió el outbox: agotaron sus reintentos y no salieron nunca. El Then natural
// de casi cualquier escenario del outbox es que esto siga en CERO: entregar tarde es correcto, rendirse es perder.
func (s *Scenario) DeadLetteredEvents() int64 {
	s.Helper()
	count, err := deadLetteredEvents(s.Context())
	if err != nil {
		s.Fatal(err)
	}
	return count
}

// AbandonOutboxEvent agota el presupuesto de reintentos de los eventos pendientes de tipo eventType (el NOMBRE del
// evento en el diseño): la precondición del escenario de la rendición, que de verdad costaría max-attempts intentos.
// El relay sigue corriendo y deja de reclamarlos. Deja el contador sucio hasta el siguiente reset: emparéjalo con
// ClearAbandonedOutboxEvents o pon el escenario el último de su flujo.
func (s *Scenario) AbandonOutboxEvent(eventType string) {
	s.Helper()
	if err := abandonOutboxEvent(s.Context(), eventType); err != nil {
		s.Fatal(err)
	}
}

// ClearAbandonedOutboxEvents retira lo que AbandonOutboxEvent rindió: la purga no lo borra (solo lo publicado), y
// ensuciaría a los demás.
func (s *Scenario) ClearAbandonedOutboxEvents() {
	s.Helper()
	s.Db("DELETE FROM outbox_event WHERE published_at IS NULL AND attempts >= ${ABANDONED}")
}
`;
}

// ─── El mensaje leído ────────────────────────────────────────────────────────────────────────────

function messageType(model) {
  const what = usesGoKafka(model)
    ? '// BrokerMessage es un registro leído del broker: su routing key (la clave del registro), sus propiedades (sus headers)\n// y su cuerpo.'
    : '// BrokerMessage es un mensaje leído del broker: su routing key, sus propiedades (las de AMQP: type, message_id,\n// headers…) y su cuerpo.';
  const typeDoc = usesGoKafka(model) ? ' (en Kafka, el header type si lo trae)' : '';
  return String.raw`${what}
type BrokerMessage struct {
	RoutingKey string
	Properties map[string]any
	Body       string
}

// Payload es el cuerpo leído como JSON (la envoltura Keel: Payload()["metadata"]), o nil si no es un objeto JSON.
func (m BrokerMessage) Payload() map[string]any {
	var payload map[string]any
	if err := json.Unmarshal([]byte(m.Body), &payload); err != nil {
		return nil
	}
	return payload
}

// EventID es el metadata.eventId de la envoltura Keel, o "".
func (m BrokerMessage) EventID() string {
	return m.metadata("eventId")
}

// EventType es el metadata.eventType de la envoltura Keel, o "".
func (m BrokerMessage) EventType() string {
	return m.metadata("eventType")
}

func (m BrokerMessage) metadata(name string) string {
	metadata, _ := m.Payload()["metadata"].(map[string]any)
	value, _ := metadata[name].(string)
	return value
}

// Type es la propiedad type del mensaje: el tipo nativo con el que lo publicó el servicio${typeDoc}.
func (m BrokerMessage) Type() string {
	value, _ := m.Properties["type"].(string)
	return value
}
`;
}

// ─── Lo común a los brokers ──────────────────────────────────────────────────────────────────────

function plumbing(model) {
  const service = model.service.name;
  const kafka = usesGoKafka(model);
  const prepared = kafka
    ? `	if err := awaitServerConnected(ctx); err != nil {
		return err
	}
	return markChannels(ctx)`
    : '	return awaitServerConnected(ctx)';
  const channels = publishedChannels(model).map((entry) => goString(entry.channel));
  return String.raw`
const (
	// devtoolsContainer es el contenedor de infra/ desde el que se habla con el broker, en la red del compose.
	devtoolsContainer = ${goString(devtoolsContainer(service))}
	// brokerContainer es el contenedor del broker, que StopBroker y StartBroker paran y levantan.
	brokerContainer = ${goString(brokerContainer(service, BROKERS[model.stack.broker]))}
	// bodyFilePrefix es el prefijo de los archivos por los que viajan los cuerpos dentro de devtools: UNO POR LLAMADA.
	// Con uno fijo, dos entregas lanzadas a la vez por un escenario de carrera se pisaban el cuerpo (corrida
	// stock-reservation-events de keel-dotnet, FL-CMP-001-C).
	bodyFilePrefix = ${goString(PROBE_BODY_FILE.replace(/\.json$/, ''))}
	// brokerTimeout es lo que se espera a que el broker pare, vuelva o acepte la conexión del servicio.
	brokerTimeout = 90 * time.Second
	// readLimit es cuántos mensajes se leen como mucho de un canal o de un descarte.
	readLimit = 50
	// instantLayout es el instante del contrato del cable: UTC, tres decimales y Z.
	instantLayout = "2006-01-02T15:04:05.000Z"
)

// publishedChannels son los canales que publica este servicio.
var publishedChannels = []string{${channels.join(', ')}}

// brokerStopped dice si el broker está parado POR EL ESCENARIO: entonces «no hay mensajes» es la lectura correcta.
var brokerStopped atomic.Bool

// devtools ejecuta args dentro del contenedor devtools, con input en su entrada estándar si no está vacío.
func devtools(ctx context.Context, input string, args ...string) (string, error) {
	all := []string{"exec"}
	if input != "" {
		all = append(all, "-i")
	}
	all = append(all, devtoolsContainer)
	return runCommand(ctx, containerRuntime(), append(all, args...), "¿Está la infraestructura arriba (bash infra/up.sh)?", input)
}

// withBodyFile deja content en un archivo propio de esta llamada dentro de devtools, se lo pasa a use y lo borra al
// terminar. Los cuerpos viajan así, nunca embebidos en la línea de comandos: en Windows el cliente de contenedores se
// come las comillas de dentro de un argumento.
func withBodyFile(ctx context.Context, content string, use func(bodyFile string) (string, error)) (string, error) {
	bodyFile := bodyFilePrefix + "-" + rand.Text() + ".json"
	if _, err := devtools(ctx, content, "sh", "-c", "cat > "+bodyFile); err != nil {
		return "", err
	}
	// Un archivo temporal que no se pudo borrar no invalida la lectura ni la entrega.
	defer func() { _, _ = devtools(context.WithoutCancel(ctx), "", "rm", "-f", bodyFile) }()
	return use(bodyFile)
}

func requirePublished(channel string) error {
	if !slices.Contains(publishedChannels, channel) {
		return fmt.Errorf("%q no es un canal que este servicio publique; publicados: %v", channel, publishedChannels)
	}
	return nil
}

func requireDeadLetter(subscription string) (string, error) {
	destination, ok := deadLetterOf[subscription]
	if !ok {
		return "", fmt.Errorf("la suscripción %q no declara onFailure.deadLetter: no hay descarte; declaradas: %v", subscription, slices.Sorted(maps.Keys(deadLetterOf)))
	}
	return destination, nil
}

func stopBroker(ctx context.Context) error {
	if _, err := runCommand(ctx, containerRuntime(), []string{"stop", brokerContainer}, "", ""); err != nil {
		return err
	}
	brokerStopped.Store(true)
	return poll(ctx, brokerTimeout, "el broker sigue aceptando conexiones tras detenerlo", func() bool { return !accepts(ctx) })
}

func startBroker(ctx context.Context) error {
	if _, err := runCommand(ctx, containerRuntime(), []string{"start", brokerContainer}, "", ""); err != nil {
		return err
	}
	if err := poll(ctx, brokerTimeout, "el broker no volvió a aceptar conexiones", func() bool { return accepts(ctx) }); err != nil {
		return err
	}
	brokerStopped.Store(false)
	return awaitServerConnected(ctx)
}

// prepareBroker es lo que hace StartFlow al abrir cada flujo: el broker arriba (un flujo anterior pudo dejarlo parado)
// y el servidor conectado a él${kafka ? '; en Kafka, además, la marca de cada canal y de cada descarte' : ''}.
func prepareBroker(ctx context.Context) error {
	if !accepts(ctx) {
		if err := startBroker(ctx); err != nil {
			return err
		}
	}
	brokerStopped.Store(false)
${prepared}
}

// accepts dice si el broker responde a su comprobación de salud.
func accepts(ctx context.Context) bool {
	_, err := devtools(ctx, "", "sh", "-c", ${goString(BROKERS[model.stack.broker].cliValidateCmd)})
	return err == nil
}

// poll espera a que condition se cumpla, mirando cada 300 ms, o falla con message cuando pasa timeout.
func poll(ctx context.Context, timeout time.Duration, message string, condition func() bool) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
	for !condition() {
		select {
		case <-deadline.C:
			return fmt.Errorf("%s (tras %s)", message, timeout)
		case <-ctx.Done():
			return fmt.Errorf("%s: %w", message, ctx.Err())
		case <-tick.C:
		}
	}
	return nil
}

// envOr es la variable name, o fallback si no está: como el perfil local del servidor.
func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// jsonText es value como cadena JSON.
func jsonText(value string) string {
	data, err := json.Marshal(value)
	if err != nil {
		// Una cadena siempre se serializa: no se llega aquí.
		return strconv.Quote(value)
	}
	return string(data)
}
`;
}

// ─── RabbitMQ ────────────────────────────────────────────────────────────────────────────────────

function rabbitBody(model) {
  const subscriptions = model.subscriptions ?? [];
  const deadLetters = subscriptions.filter((sub) => sub.deadLetter);
  const read = readParts('rabbitmq', { destination: expr('queue'), bodyFile: expr('bodyFile'), base: expr('rabbitAPI') });
  const purgeCmd = purgeParts('rabbitmq', { destination: expr('queue'), base: expr('rabbitAPI') });
  const deliverCmd = deliverParts('rabbitmq', { destination: expr('exchange'), bodyFile: expr('bodyFile'), base: expr('rabbitExchangeAPI') });
  const probeBody = spliceBody(rabbitProbeBody(hole(0)), ['strconv.Itoa(readLimit)'], goString);
  const publishBody = spliceBody(
    rabbitPublishBody({ routingKey: hole(0), key: hole(1), headersJson: hole(2), payloadBase64: hole(3) }),
    ['key', 'key', 'string(headersJSON)', 'base64.StdEncoding.EncodeToString([]byte(body))'],
    goString
  );
  const connections = `${ENDPOINTS.rabbitmq.queuesApi.replace(/queues\/%2F\/$/, '')}connections`;
  const entries = (rows) => (rows.length === 0 ? '' : `\n${alignRows(rows.map(([key, value]) => ({ indent: '\t', cells: [`${key}:`, `${value},`] }))).join('\n')}\n`);
  const outbox = usesGoOutbox(model);
  return String.raw`
// La fontanería de RabbitMQ: su API de gestión, vista desde devtools.
const (
	rabbitAPI         = ${goString(ENDPOINTS.rabbitmq.queuesApi)}
	rabbitExchangeAPI = ${goString(ENDPOINTS.rabbitmq.exchangeApi)}
	connectionsAPI    = ${goString(connections)}
	rabbitCredentials = ${goString(ENDPOINTS.rabbitmq.credentials)}
	// connectionName es el nombre con el que la conexión del servicio se presenta al broker.
	connectionName = ${goString(connectionName(model))}
)

// queueOf es, por suscripción, la cola de la que consume este servicio.
var queueOf = map[string]string{${entries(subscriptions.map((sub) => [goString(sub.name), goString(subscriptionDestination('rabbitmq', model, sub))]))}}

// deadLetterOf es, por suscripción, su cola de descarte (las que declaran onFailure.deadLetter).
var deadLetterOf = map[string]string{${entries(deadLetters.map((sub) => [goString(sub.name), goString(deadLetterDestination('rabbitmq', model, sub))]))}}

// published es lo publicado en un canal: la cola del canal, que se llama como él (la topología del servicio).
func published(ctx context.Context, channel string) ([]BrokerMessage, error) {
	if err := requirePublished(channel); err != nil {
		return nil, err
	}${outbox ? `
	if err := awaitOutboxDrained(ctx, channel); err != nil {
		return nil, err
	}` : ''}
	return readQueue(ctx, channel)
}

func deadLetters(ctx context.Context, subscription string) ([]BrokerMessage, error) {
	queue, err := requireDeadLetter(subscription)
	if err != nil {
		return nil, err
	}
	return readQueue(ctx, queue)
}

func purge(ctx context.Context, channelOrSubscription string) error {
	queue := channelOrSubscription
	if own, ok := queueOf[channelOrSubscription]; ok {
		queue = own
	} else if dead, ok := deadLetterOf[channelOrSubscription]; ok {
		queue = dead
	}${outbox ? `
	if err := awaitOutboxDrained(ctx, channelOrSubscription); err != nil {
		return err
	}` : ''}
	_, err := devtools(ctx, "", ${go(purgeCmd)})
	return err
}

// readQueue es un peek de queue: leer no consume.
func readQueue(ctx context.Context, queue string) ([]BrokerMessage, error) {
	request := ${probeBody}
	raw, err := withBodyFile(ctx, request, func(bodyFile string) (string, error) {
		return devtools(ctx, "", ${go(read)})
	})
	if err != nil {
		if brokerStopped.Load() {
			// Con el broker parado POR EL ESCENARIO, «no hay mensajes» es la lectura correcta.
			return nil, nil
		}
		return nil, err
	}
	var got []struct {
		RoutingKey string         ${'`json:"routing_key"`'}
		Properties map[string]any ${'`json:"properties"`'}
		Payload    string         ${'`json:"payload"`'}
	}
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		return nil, fmt.Errorf("leer la cola %s: %w (respuesta: %s)", queue, err, raw)
	}
	messages := make([]BrokerMessage, 0, len(got))
	for _, message := range got {
		messages = append(messages, BrokerMessage{RoutingKey: message.RoutingKey, Properties: message.Properties, Body: message.Payload})
	}
	return messages, nil
}

func deliver(ctx context.Context, exchange, key, body string, headers map[string]string) error {
	if headers == nil {
		headers = map[string]string{}
	}
	headersJSON, err := json.Marshal(headers)
	if err != nil {
		return fmt.Errorf("serializar las cabeceras: %w", err)
	}
	request := ${publishBody}
	answer, err := withBodyFile(ctx, request, func(bodyFile string) (string, error) {
		return devtools(ctx, "", ${go(deliverCmd)})
	})
	if err != nil {
		return err
	}
	if !strings.Contains(answer, ${goString('"routed":true')}) {
		return fmt.Errorf("RabbitMQ aceptó la publicación en %q pero no la enrutó a ninguna cola (routed:false): ¿arrancó la conexión del servicio y declaró su topología? Respuesta: %s", exchange, answer)
	}
	return nil
}

// awaitServerConnected espera a que el servidor esté conectado al broker (y su topología, declarada): entre las
// conexiones del broker, la que se presenta con el nombre del servicio, abierta. Lo está desde que su conexión se
// recupera.
func awaitServerConnected(ctx context.Context) error {
	return poll(ctx, brokerTimeout, "la conexión del servicio con RabbitMQ no se recuperó", func() bool { return serverConnected(ctx) })
}

// rabbitConnection es una conexión tal como la lista la API de gestión.
type rabbitConnection struct {
	ClientProperties struct {
		ConnectionName string ${'`json:"connection_name"`'}
	} ${'`json:"client_properties"`'}
	State string ${'`json:"state"`'}
}

func serverConnected(ctx context.Context) bool {
	raw, err := devtools(ctx, "", "curl", "-sf", "-u", rabbitCredentials, connectionsAPI)
	if err != nil {
		return false
	}
	var connections []rabbitConnection
	if err := json.Unmarshal([]byte(raw), &connections); err != nil {
		return false
	}
	return slices.ContainsFunc(connections, func(connection rabbitConnection) bool {
		return connection.ClientProperties.ConnectionName == connectionName && connection.State == "running"
	})
}
`;
}

// ─── Kafka ───────────────────────────────────────────────────────────────────────────────────────
//
// El servicio publica en UN topic (messaging.publishing.destination) con la routing key como clave, y los canales del
// diseño se distinguen por el tipo del evento; cada suscripción consume del topic de su fuente con su consumer group, y
// descarta en `<topic>.DLT` si el topic lo declara. Sin purga: marca de offset.

function kafkaBody(model) {
  const subscriptions = model.subscriptions ?? [];
  const consumption = kafkaConsumption(model);
  const eventTypes = model.messaging?.eventTypesByChannel ?? {};
  const read = readParts('kafka', { destination: expr('topic'), offset: expr('offset'), format: RECORD_FORMAT });
  const offsets = offsetsParts({ destination: expr('topic') });
  // La cabeza de la línea de kcat, del mismo constructor que ejecuta broker-check: el destino, la clave y los headers
  // los añade el arnés, que es quien los comilla en tiempo de ejecución.
  const produce = deliverShell({ destination: '', key: '', bodyFile: '' }).split(shellQuote(''))[0];
  const entries = (rows) => (rows.length === 0 ? '' : `\n${alignRows(rows.map(([key, value]) => ({ indent: '\t', cells: [`${key}:`, `${value},`] }))).join('\n')}\n`);
  const outbox = usesGoOutbox(model);
  return String.raw`
// La fontanería de Kafka: kcat desde devtools para leer y entregar, y la CLI del broker para los consumer groups.
const (
	kcatProduce  = ${goString(produce)}
	unknownTopic = ${goString(UNKNOWN_TOPIC)}
	// assignmentTimeout es lo que se espera a que cada consumer group del servidor reciba sus particiones.
	assignmentTimeout = 60 * time.Second
)

// eventTopic es el topic FÍSICO donde publica este servicio, que no es el canal del diseño: todos los eventos comparten
// el destino y se distinguen por su tipo. Como el perfil local: la variable si está, y si no el default.
var eventTopic = envOr("MESSAGING_DESTINATION", ${goString(model.messaging?.destinationDefault ?? '')})

// channelEventTypes es, por canal, el metadata.eventType de sus eventos: lo que separa los canales dentro del topic único.
var channelEventTypes = map[string][]string{${entries(Object.entries(eventTypes).map(([channel, names]) => [goString(channel), `{${names.map(goString).join(', ')}}`]))}}

// topicOf es, por suscripción, el topic de su fuente, del que consume directamente.
var topicOf = map[string]string{${entries(subscriptions.map((sub) => [goString(sub.name), `envOr(${goString(topicEnv(sub))}, ${goString(sub.topicDefault)})`]))}}

// deadLetterOf es, por suscripción, su topic de descarte (<topic>.DLT), las que lo declaran (por topic, como en keel-spring).
var deadLetterOf = map[string]string{${entries(consumption.filter((entry) => entry.deadLetter).map((entry) => [goString(entry.subscription), `topicOf[${goString(entry.subscription)}] + ".DLT"`]))}}

// groupOf es, por suscripción, su consumer group: el del perfil local, o su variable.
var groupOf = map[string]string{${entries(subscriptions.map((sub) => [goString(sub.name), `envOr(${goString(groupEnv(sub))}, ${goString(consumption.find((entry) => entry.subscription === sub.name).groupId)})`]))}}

// marks es desde qué offset se lee cada canal y cada descarte: la marca de su último reset o purga.
var (
	marksMu sync.Mutex
	marks   = map[string]int64{}
)

// offsetFor es desde dónde leer key: su marca, o los últimos readLimit si aún no tiene.
func offsetFor(key string) string {
	marksMu.Lock()
	defer marksMu.Unlock()
	if mark, ok := marks[key]; ok {
		return strconv.FormatInt(mark, 10)
	}
	return "-" + strconv.Itoa(readLimit)
}

func setMark(key string, offset int64) {
	marksMu.Lock()
	defer marksMu.Unlock()
	marks[key] = offset
}

func published(ctx context.Context, channel string) ([]BrokerMessage, error) {
	if err := requirePublished(channel); err != nil {
		return nil, err
	}${outbox ? `
	if err := awaitOutboxDrained(ctx, channel); err != nil {
		return nil, err
	}` : ''}
	messages, err := readTopic(ctx, eventTopic, offsetFor(channel))
	if err != nil {
		return nil, err
	}
	types := channelEventTypes[channel]
	own := make([]BrokerMessage, 0, len(messages))
	for _, message := range messages {
		if len(types) == 0 || slices.Contains(types, message.EventType()) {
			own = append(own, message)
		}
	}
	return own[:min(len(own), readLimit)], nil
}

func deadLetters(ctx context.Context, subscription string) ([]BrokerMessage, error) {
	topic, err := requireDeadLetter(subscription)
	if err != nil {
		return nil, err
	}
	messages, err := readTopic(ctx, topic, offsetFor(topic))
	if err != nil {
		return nil, err
	}
	return messages[:min(len(messages), readLimit)], nil
}

// purge mueve la marca: el topic de una suscripción no se vacía (lo que publicó la fuente, ahí sigue).
func purge(ctx context.Context, channelOrSubscription string) error {
	if slices.Contains(publishedChannels, channelOrSubscription) {${outbox ? `
		if err := awaitOutboxDrained(ctx, channelOrSubscription); err != nil {
			return err
		}` : ''}
		next, err := nextOffset(ctx, eventTopic)
		if err != nil {
			return err
		}
		setMark(channelOrSubscription, next)
		return nil
	}
	topic := channelOrSubscription
	if dead, ok := deadLetterOf[channelOrSubscription]; ok {
		topic = dead
	} else if _, ok := topicOf[channelOrSubscription]; ok {
		return nil
	}
	next, err := nextOffset(ctx, topic)
	if err != nil {
		return err
	}
	setMark(topic, next)
	return nil
}

func deliver(ctx context.Context, topic, key, body string, headers map[string]string) error {
	command := kcatProduce + shellQuote(topic) + " -k " + shellQuote(key)
	for _, name := range slices.Sorted(maps.Keys(headers)) {
		command += " -H " + shellQuote(name+"="+headers[name])
	}
	// kcat manda UN registro por línea del archivo: un JSON escrito en varias se publicaría troceado.
	singleLine := strings.Join(strings.Fields(strings.ReplaceAll(body, "\r", "")), " ")
	_, err := withBodyFile(ctx, singleLine, func(bodyFile string) (string, error) {
		return devtools(ctx, "", "sh", "-c", command+" -l "+bodyFile)
	})
	return err
}

// shellQuote comilla un valor para la shell del contenedor (una clave o un header, nunca un cuerpo).
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", ${goString("'\\''")}) + "'"
}

// readTopic lee un topic desde un offset, un registro por línea (clave, headers y valor). Kafka crea el topic con el
// PRIMER mensaje: leer antes es «no hay mensajes», no una avería.
func readTopic(ctx context.Context, topic, offset string) ([]BrokerMessage, error) {
	raw, err := devtools(ctx, "", ${go(read)})
	if err != nil {
		if strings.Contains(err.Error(), unknownTopic) || brokerStopped.Load() {
			return nil, nil
		}
		return nil, err
	}
	var messages []BrokerMessage
	for line := range strings.SplitSeq(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) < 3 {
			messages = append(messages, BrokerMessage{Properties: map[string]any{}, Body: line})
			continue
		}
		properties := map[string]any{}
		for pair := range strings.SplitSeq(fields[1], ",") {
			if name, value, ok := strings.Cut(pair, "="); ok && name != "" {
				properties[name] = value
			}
		}
		messages = append(messages, BrokerMessage{RoutingKey: fields[0], Properties: properties, Body: fields[2]})
	}
	return messages, nil
}

// nextOffset es el offset en el que caerá lo siguiente que se publique en topic: el último existente más uno. Asume UNA
// partición por topic, que es la decisión de infra/: con varias, una marca escalar no aísla.
func nextOffset(ctx context.Context, topic string) (int64, error) {
	raw, err := devtools(ctx, "", ${go(offsets)})
	if err != nil {
		if strings.Contains(err.Error(), unknownTopic) || brokerStopped.Load() {
			return 0, nil
		}
		return 0, err
	}
	last := int64(-1)
	for line := range strings.SplitSeq(raw, "\n") {
		if value, err := strconv.ParseInt(strings.TrimSpace(line), 10, 64); err == nil {
			last = value
		}
	}
	return last + 1, nil
}

// markChannels marca todos los canales y todos los topics de descarte: la parte del reset que el script no puede hacer.
// Los descartes entran por lo mismo que los canales, y su fallo es peor de ver: la aserción típica sobre un descarte es
// NEGATIVA, así que un mensaje muerto de un flujo anterior haría fallar uno posterior por algo que no hizo.
func markChannels(ctx context.Context) error {
	next, err := nextOffset(ctx, eventTopic)
	if err != nil {
		return err
	}
	for _, channel := range publishedChannels {
		setMark(channel, next)
	}
	for _, topic := range slices.Sorted(maps.Values(deadLetterOf)) {
		dead, err := nextOffset(ctx, topic)
		if err != nil {
			return err
		}
		setMark(topic, dead)
	}
	return nil
}

// topicPattern lee un topic de la salida de kcat -L.
var topicPattern = regexp.MustCompile(${'`topic "([^"]+)"`'})

// existingTopics son los topics que existen ahora en el broker (kcat -L).
func existingTopics(ctx context.Context) map[string]bool {
	listing, err := devtools(ctx, "", "sh", "-c", ${goString(BROKERS.kafka.cliValidateCmd)})
	topics := map[string]bool{}
	if err != nil {
		return topics
	}
	for _, match := range topicPattern.FindAllStringSubmatch(listing, -1) {
		topics[match[1]] = true
	}
	return topics
}

// awaitServerConnected espera a que cada consumer group del servidor cuyo topic YA existe tenga un miembro con
// particiones asignadas: hasta entonces, lo que se le entregue espera al reparto del grupo, y un escenario que entrega y
// mira enseguida lo vería tarde. El de un topic que aún no existe no se espera: lo recibirá cuando lo cree el primer
// mensaje (el perfil local refresca los metadatos cada pocos segundos). Se pregunta al broker con su CLI: el servidor
// es otro proceso.
func awaitServerConnected(ctx context.Context) error {
	topics := existingTopics(ctx)
	var groups []string
	for _, subscription := range slices.Sorted(maps.Keys(groupOf)) {
		if group := groupOf[subscription]; topics[topicOf[subscription]] && !slices.Contains(groups, group) {
			groups = append(groups, group)
		}
	}
	if len(groups) == 0 {
		return nil
	}
	pending := groups
	err := poll(ctx, assignmentTimeout, "la espera terminó", func() bool {
		pending = pendingGroups(ctx, groups)
		return len(pending) == 0
	})
	if err != nil {
		// Un grupo que no llega nunca es casi siempre una suscripción SIN listener: nadie se une a él.
		return fmt.Errorf("los consumer groups del servicio no recibieron sus particiones: %s (¿falta el listener de su suscripción en cmd/server/broker.go?): %w", strings.Join(pending, ", "), err)
	}
	return nil
}

// pendingGroups son los grupos que todavía no tienen un miembro con particiones asignadas. La CLI escribe una fila por
// miembro (GROUP, CONSUMER-ID, HOST, CLIENT-ID, #PARTITIONS) y sale con error si un grupo aún no existe: se lee su
// salida igualmente.
func pendingGroups(ctx context.Context, groups []string) []string {
	cli := []string{${go(kafkaGroupMembersParts([]))}}
	for _, group := range groups {
		cli = append(cli, "--group", group)
	}
	quoted := make([]string, len(cli))
	for i, part := range cli {
		quoted[i] = shellQuote(part)
	}
	output, err := runCommand(ctx, containerRuntime(), []string{"exec", brokerContainer, "sh", "-c", strings.Join(quoted, " ") + " 2>&1 || true"}, "", "")
	if err != nil {
		// El broker aún no contesta: se reintenta hasta el plazo.
		return groups
	}
	var pending []string
	for _, group := range groups {
		assigned := false
		for line := range strings.SplitSeq(output, "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 5 && fields[0] == group {
				partitions, err := strconv.Atoi(fields[len(fields)-1])
				assigned = assigned || (err == nil && partitions > 0)
			}
		}
		if !assigned {
			pending = append(pending, group)
		}
	}
	return pending
}
`;
}

// ─── El outbox ───────────────────────────────────────────────────────────────────────────────────

function outboxBody(model) {
  const maxAttempts = parameterValue(OUTBOX_RELAY.maxAttempts, 'local');
  const abandoned = usesGoKafka(model)
    ? `
	if err != nil {
		return err
	}
	// El envío que el relay tenía EN VUELO cuando se abandona el evento sigue en el productor hasta que caduca
	// (delivery.timeout.ms: ${KAFKA_PRODUCER_TIMEOUTS.delivery.local} ms en local) o el broker lo confirma: hasta entonces podría salir y quedar publicado.
	time.Sleep(${KAFKA_PRODUCER_TIMEOUTS.delivery.local + 2000} * time.Millisecond)
	return nil`
    : `
	return err`;
  return String.raw`
// outboxDrainTimeout es lo que se espera a que el relay entregue lo pendiente antes de leer o purgar un canal.
const outboxDrainTimeout = 15 * time.Second

// outboxDestination es el destino de los eventos del servidor arrancado: el de su configuración local, o
// MESSAGING_DESTINATION.
func outboxDestination() string {
	return envOr("MESSAGING_DESTINATION", ${goString(model.messaging?.destinationDefault ?? '')})
}

// maxAttempts son los intentos antes de rendirse del servidor arrancado (perfil local), o ${OUTBOX_RELAY.maxAttempts.env}.
func maxAttempts() int {
	if configured, err := strconv.Atoi(os.Getenv(${goString(OUTBOX_RELAY.maxAttempts.env)})); err == nil && configured > 0 {
		return configured
	}
	return ${maxAttempts}
}

// countOf es el número de una consulta de una sola fila: la última línea. Vacío NO es cero.
func countOf(output string) (int64, error) {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	count, err := strconv.ParseInt(last, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("la consulta de outbox_event no devolvió un número (salida: %q): %w", strings.TrimSpace(output), err)
	}
	return count, nil
}

func queryCount(ctx context.Context, sql string) (int64, error) {
	out, err := db(ctx, sql)
	if err != nil {
		return 0, err
	}
	return countOf(out)
}

// quoted es value como literal de SQL.
func quoted(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// awaitOutboxDrained espera a que no queden filas del outbox sin entregar para este servicio. Un canal que no
// publicamos no pasa por nuestro outbox, y con el broker parado por el escenario las filas esperan a propósito. La fila
// RENDIDA no cuenta: no va a salir nunca.
func awaitOutboxDrained(ctx context.Context, channel string) error {
	if !slices.Contains(publishedChannels, channel) || brokerStopped.Load() {
		return nil
	}
	sql := fmt.Sprintf("SELECT COUNT(*) FROM outbox_event WHERE destination = %s AND published_at IS NULL AND attempts < %d", quoted(outboxDestination()), maxAttempts())
	deadline := time.Now().Add(outboxDrainTimeout)
	for time.Now().Before(deadline) {
		pending, err := queryCount(ctx, sql)
		if err != nil {
			return err
		}
		if pending == 0 {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return nil
}

func deadLetteredEvents(ctx context.Context) (int64, error) {
	return queryCount(ctx, fmt.Sprintf("SELECT COUNT(*) FROM outbox_event WHERE published_at IS NULL AND attempts >= %d", maxAttempts()))
}

func abandonOutboxEvent(ctx context.Context, eventType string) error {
	pending, err := queryCount(ctx, "SELECT COUNT(*) FROM outbox_event WHERE event_type = "+quoted(eventType)+" AND published_at IS NULL")
	if err != nil {
		return err
	}
	if pending == 0 {
		return errors.New("no hay ningún evento " + eventType + " pendiente en el outbox que abandonar")
	}
	_, err = db(ctx, "UPDATE outbox_event SET attempts = ${ABANDONED} WHERE event_type = "+quoted(eventType)+" AND published_at IS NULL")${abandoned}
}
`;
}
