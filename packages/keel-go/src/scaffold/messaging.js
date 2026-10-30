// La mensajería del servicio (incremento 9): los contratos transversales al broker, los mismos que emiten keel-spring,
// keel-nest y keel-dotnet, en el paquete `internal/infrastructure/messaging`.
//
// Build genera:
//   · la Envelope (metadata + data) que viaja por el cable, con la EventMetadata que el agregado estampó al emitir: el
//     EventID es la clave de idempotencia del consumidor y no se regenera;
//   · por evento, el <Evento>IntegrationEvent: el gemelo de cable del evento de dominio, desacoplado de él, cuya
//     metadata NO se serializa en `data` (la autoritativa es la de la envoltura);
//   · el Bridge, al que el adaptador de repositorio entrega los eventos que drena al guardar: con `reliability: outbox`
//     los traduce a las filas del outbox que el adaptador escribe DENTRO de la transacción del cambio; con
//     `best-effort` los publica DESPUÉS del commit por el puerto <Evento>Publisher, que mientras el agente no lo
//     implemente es un respaldo que solo avisa;
//   · por suscripción, el mensaje con su lector del cable (Read<Mensaje>) y su RequireContract, y la envoltura propia de
//     la fuente cuando `envelope: wrapped`;
//   · la configuración (`config/parameters/<perfil>/messaging.yaml`, el MISMO texto que keel-nest y keel-dotnet:
//     keel-core/gen/messaging-plan.js) y Settings, que la lee y la valida al arrancar;
//   · el relay del outbox (outbox.go), la guarda de los mensajes procesados (guard.go) y sus puertos: el SQL de cada
//     motor lo pone el adaptador relacional (messaging-stores.js), que es quien sabe de transacciones.
//
// Lo único que depende del broker (`keel-stack.json`) es el ENVÍO y la RECEPCIÓN: el messaging.Dispatcher del outbox,
// los <Evento>Publisher de best-effort y los listeners. Los escribe el agente en `cmd/server/broker.go`, el único archivo
// del arranque que es suyo: es lo que en Spring hace el component-scan y en keel-dotnet BrokerBindings.cs.
//
// Solo con persistencia RELACIONAL: el puente sale del adaptador de repositorio y el registro de procesados vive en la
// base. La documental llega con el incremento 12.

import { missingTargetRetryDestinations, subscriptionDestination, subscriptionGroupId, deadLetterDestination } from '@keel-system/keel-core/gen';
import { OUTBOX_LAST_ERROR_LENGTH, OUTBOX_RELAY, outboxBackoffMs } from '@keel-system/keel-core/gen/messaging-stores';
import { usesMessaging, usesBridge, usesProcessedEvents, usesRelational } from '@keel-system/keel-core/gen/features';
import { consumerUnits, consumesFromQueue, messagingYaml, routingKeyName, subscriptionKey } from '@keel-system/keel-core/gen/messaging-plan';
import { acknowledgeNote } from '@keel-system/keel-core/gen/rejection-notes';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString, keyedLiteral } from '../lib/go-source.js';
import { appType, declType, fieldImports, goFileName, layout, packageFile } from './render.js';
import { wireTag } from './dtos.js';
import { componentChecks } from './endpoints.js';
import { VALIDATION, patternsBlock } from './rest-support.js';
import { messageType, operations, useCaseField } from './services.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const PRESENCE = new Set(['notNull', 'notBlank', 'notEmpty']);

// ─── Qué se genera ───────────────────────────────────────────────────────────────────────────────

/** ¿Hay mensajería que generar? Sobre la persistencia relacional: la documental llega con el incremento 12. */
export function usesGoMessaging(model) {
  return usesMessaging(model) && usesRelational(model);
}

/** ¿Salen los eventos por el outbox? Lo decide el diseño (`reliability: outbox`). */
export function usesGoOutbox(model) {
  return usesGoMessaging(model) && usesBridge(model) && model.messaging?.reliability === 'outbox';
}

/** ¿Salen los eventos best-effort, después del commit? */
export function usesBestEffort(model) {
  return usesGoMessaging(model) && usesBridge(model) && !usesGoOutbox(model);
}

/** ¿Consume el servicio? Entonces hay registro de procesados y guarda. */
export function usesGoProcessedEvents(model) {
  return usesGoMessaging(model) && usesProcessedEvents(model);
}

/** ¿Emite eventos esta raíz? Entonces su adaptador de repositorio los entrega al puente al guardar. */
export function emitsEvents(model, entity) {
  return usesGoMessaging(model) && usesBridge(model) && (model.events ?? []).some((event) => event.aggregates.includes(entity.name));
}

export const integrationType = (event) => goExported(event.integrationClass);
export const publisherPort = (event) => goExported(event.publisherClass);
export const messageStruct = (sub) => goExported(sub.messageRecord);
export const readerFunc = (sub) => `Read${messageStruct(sub)}`;

const MESSAGING_IMPORT = 'internal/infrastructure/messaging';

export function generate(model) {
  if (!usesGoMessaging(model)) return [];
  const { messaging } = layout(model);
  const file = (name, imports, body, { test = false } = {}) => ({
    path: `${messaging.dir}/${name}${test ? '_test' : ''}.go`,
    content: packageFile(model, messaging, { imports, body, test, doc: name === 'doc' ? PACKAGE_DOC : null })
  });
  const plan = { uses: new Set(), enums: new Set(), patterns: new Map(), files: [] };
  const files = [
    ...PROFILES.map((profile) => ({
      path: `config/parameters/${profile}/messaging.yaml`,
      content: messagingYaml(model, profile, { outbox: usesGoOutbox(model), processedEvents: usesGoProcessedEvents(model) })
    })),
    file('doc', [], ''),
    file('settings', ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], settingsBody(model)),
    file('envelope', ['context', 'encoding/json/jsontext', 'fmt', 'time', 'internal/domain', 'internal/platform/correlation', 'internal/platform/wire'], envelopeBody()),
    file('inbound', ['context', 'internal/domain', 'internal/platform/correlation'], inboundBody())
  ];
  for (const event of model.events ?? []) {
    files.push(file(goFileName(event.integrationClass), ['internal/domain', ...event.fields.flatMap(fieldImports)], integrationEventBody(model, event)));
  }
  if (usesBridge(model)) files.push(file('bridge', ['context', 'fmt', 'log/slog', 'internal/domain'], bridgeBody(model)));
  if (usesBestEffort(model)) files.push(file('publishers', ['context', 'log/slog'], publishersBody(model)));
  if (usesGoOutbox(model)) files.push(file('outbox', ['context', 'fmt', 'log/slog', 'math', 'slices', 'strings', 'sync', 'sync/atomic', 'time', 'unicode/utf8', 'github.com/google/uuid'], outboxBody()));
  if (usesGoProcessedEvents(model)) files.push(file('guard', ['context', 'log/slog'], guardBody()));
  for (const sub of model.subscriptions ?? []) {
    files.push(file(goFileName(sub.messageRecord), messageImports(sub), messageBody(model, sub, plan)));
    if (sub.envelopeRecord) files.push(file(goFileName(sub.envelopeRecord), ['encoding/json/jsontext', 'encoding/json/v2', 'internal/platform/wire'], wrappedEnvelopeBody(sub)));
  }
  if (plan.uses.has('violations')) files.push(file('contract', ['regexp', 'strings', 'unicode/utf16', 'internal/platform/wire'], contractBody(plan)));
  files.push(file('messaging', ['errors', 'strings', 'testing', 'time', 'internal/domain', 'internal/platform/correlation', MESSAGING_IMPORT], emittedTest(model), { test: true }));
  return files;
}

const PACKAGE_DOC = `Package messaging lleva lo de la mensajería que no depende del broker: la envoltura del cable, los eventos de
integración, el puente que traduce los eventos de dominio, los mensajes de las suscripciones con su contrato, el relay
del outbox y la guarda de los mensajes procesados. El envío y la recepción con el broker los escribe el agente en
cmd/server/broker.go.`;

// ─── settings.go ─────────────────────────────────────────────────────────────────────────────────

const RELAY_FIELDS = {
  fixedDelayMs: { field: 'FixedDelay', millis: true },
  batchSize: { field: 'BatchSize', millis: false },
  maxAttempts: { field: 'MaxAttempts', millis: false },
  backoffInitialMs: { field: 'BackoffInitial', millis: true },
  backoffMaxMs: { field: 'BackoffMax', millis: true },
  claimTimeoutMs: { field: 'ClaimTimeout', millis: true }
};

function settingsBody(model) {
  const outbox = usesGoOutbox(model);
  const events = model.events ?? [];
  const subscriptions = model.subscriptions ?? [];
  const relay = Object.entries(OUTBOX_RELAY).map(([name, parameter]) => {
    const spec = RELAY_FIELDS[name];
    if (!spec) throw new Error(`messaging: OUTBOX_RELAY.${name} no tiene campo en OutboxRelaySettings`);
    return { ...spec, parameter };
  });
  const routingKeys = keyedLiteral(
    events.map((event) => [goString(event.name), `read.text(${goString(`messaging.publishing.routing-keys.${routingKeyName(event)}`)}, ${goString(event.routingKeyDefault)})`]),
    '\t\t'
  );
  const subscriptionEntries = subscriptions.map((sub) => {
    const key = `messaging.subscriptions.${subscriptionKey(sub)}`;
    const pairs = [['Topic', `read.text(${goString(`${key}.topic`)}, ${goString(sub.topicDefault)})`]];
    if (consumesFromQueue(model)) pairs.push(['Queue', `read.text(${goString(`${key}.queue`)}, ${goString(subscriptionDestination(model.stack.broker, model, sub))})`]);
    if (model.stack?.broker === 'kafka') pairs.push(['GroupID', `read.text(${goString(`${key}.group-id`)}, ${goString(subscriptionGroupId(model, sub))})`]);
    return `\t\t${goString(sub.name)}: {\n${keyedLiteral(pairs, '\t\t\t').join('\n')}\n\t\t},`;
  });
  const relayLiteral = keyedLiteral(
    relay.map(({ field, millis, parameter }) => [field, `read.${millis ? 'millis' : 'positive'}(${goString(parameter.key)}, ${parameter.default})`]),
    '\t\t'
  );
  const relayDoc = relay.map(({ field, parameter }) => `//   - ${field}: ${parameter.key} (${parameter.env}).`).join('\n');
  return `
// SubscriptionSettings es una suscripción del perfil activo: Topic es el canal (exchange o topic) de la fuente, Queue
// la cola propia de la que consume este servicio (RabbitMQ y SNS/SQS; vacía en Kafka) y GroupID su consumer group
// (Kafka; vacío en los demás brokers).
type SubscriptionSettings struct {
	Topic   string
	Queue   string
	GroupID string
}

// OutboxRelaySettings gobierna el relay del outbox, con las claves y los defaults de keel-core/gen/messaging-stores.js
// (OUTBOX_RELAY), los mismos que los servidores de keel-spring, keel-nest y keel-dotnet:
${relayDoc}
type OutboxRelaySettings struct {
	FixedDelay     time.Duration
	BatchSize      int
	MaxAttempts    int
	BackoffInitial time.Duration
	BackoffMax     time.Duration
	ClaimTimeout   time.Duration
}

// Settings es la mensajería del perfil activo, con las claves de config/parameters/<perfil>/messaging.yaml: Destination
// es el destino (exchange o topic) donde se publican los eventos de este servicio, RoutingKeys la routing key de cada
// evento y Subscriptions cada suscripción, las dos por su NOMBRE en el diseño. OutboxRelay es nil si los eventos salen
// best-effort.
type Settings struct {
	Destination   string
	RoutingKeys   map[string]string
	Subscriptions map[string]SubscriptionSettings
	OutboxRelay   *OutboxRelaySettings
}

// SettingsFrom lee y valida la mensajería del perfil al ARRANCAR: un valor que no es un entero positivo no deja
// arrancar, en vez de dejar el relay parado o en bucle apretado. Lo que el perfil no declara toma el default del
// diseño o de keel-core.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	read := &reader{cfg: cfg}
	routingKeys := map[string]string{${routingKeys.length > 0 ? `\n${routingKeys.join('\n')}\n\t` : ''}}
	subscriptions := map[string]SubscriptionSettings{${subscriptionEntries.length > 0 ? `\n${subscriptionEntries.join('\n')}\n\t` : ''}}
	settings := Settings{
		Destination:   read.text("messaging.publishing.destination", ${goString(events[0]?.destinationDefault ?? '')}),
		RoutingKeys:   routingKeys,
		Subscriptions: subscriptions,
	}${outbox ? `
	settings.OutboxRelay = &OutboxRelaySettings{
${relayLiteral.join('\n')}
	}` : ''}
	if read.err != nil {
		return Settings{}, read.err
	}
	return settings, nil
}

// reader lee claves de la configuración y se queda con el primer valor inválido.
type reader struct {
	cfg *config.Config
	err error
}

// text es el valor de key, o fallback si el perfil no lo declara o lo deja vacío.
func (r *reader) text(key, fallback string) string {
	if value, ok := r.cfg.Value(key); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}${outbox ? `

// positive es el entero positivo de key, o fallback si el perfil no lo declara.
func (r *reader) positive(key string, fallback int) int {
	value, ok := r.cfg.Value(key)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		if r.err == nil {
			r.err = fmt.Errorf("%s tiene que ser un entero positivo: %q", key, value)
		}
		return fallback
	}
	return n
}

// millis es positive leído como milisegundos.
func (r *reader) millis(key string, fallback int) time.Duration {
	return time.Duration(r.positive(key, fallback)) * time.Millisecond
}` : ''}
`;
}

// ─── envelope.go ─────────────────────────────────────────────────────────────────────────────────

function envelopeBody() {
  return `
// Envelope es la envoltura estándar de los eventos: metadata + payload, en el orden del cable (keel-core,
// WIRE_SHAPES.eventEnvelope). Es la misma que publican y consumen los servidores de keel-spring, keel-nest y
// keel-dotnet del diseño.
//
// La metadata es la que el agregado estampó al emitir el evento de dominio: conserva el EventID, que es la clave de
// idempotencia del consumidor. Aquí solo se le añade la correlación de la petición, que el dominio no conoce; este
// servicio no tiene telemetría, así que el traceparent viaja a null.
type Envelope[T any] struct {
	Metadata domain.EventMetadata \`json:"metadata"\`
	Data     T                    \`json:"data"\`
}

// NewEnvelope es la envoltura de un evento que sale, con la correlación de la petición o del mensaje en curso (la de
// ctx).
func NewEnvelope[T any](ctx context.Context, metadata domain.EventMetadata, data T) Envelope[T] {
	var correlationID *string
	if id, ok := correlation.ID(ctx); ok {
		correlationID = &id
	}
	return Envelope[T]{Metadata: metadata.WithContext(correlationID, nil), Data: data}
}

// Wire es la envoltura en JSON con el contrato del cable: lo que viaja y lo que guarda el outbox.
func (e Envelope[T]) Wire() (string, error) {
	data, err := wire.Marshal(e)
	if err != nil {
		return "", fmt.Errorf("serializar la envoltura de %s: %w", e.Metadata.EventType, err)
	}
	return string(data), nil
}

// keelMetadata es la metadata tal como llega, para decir qué falta en vez de leer ceros.
type keelMetadata struct {
	EventID       *string    \`json:"eventId"\`
	EventType     *string    \`json:"eventType"\`
	EventVersion  *int32     \`json:"eventVersion"\`
	OccurredAt    *time.Time \`json:"occurredAt"\`
	Source        *string    \`json:"source"\`
	CorrelationID *string    \`json:"correlationId"\`
	Traceparent   *string    \`json:"traceparent"\`
}

// missing es la primera clave obligatoria que no llegó, en el orden del cable, o "".
func (m keelMetadata) missing() string {
	switch {
	case m.EventID == nil:
		return "eventId"
	case m.EventType == nil:
		return "eventType"
	case m.EventVersion == nil:
		return "eventVersion"
	case m.OccurredAt == nil:
		return "occurredAt"
	case m.Source == nil:
		return "source"
	}
	return ""
}

// ParseEnvelope lee una envoltura Keel del cable (lo que llega a una suscripción con envelope: keel). El Data queda sin
// leer: se lee DESPUÉS de filtrar por Metadata.EventType, con el lector del mensaje de la suscripción, porque el canal
// transporta también eventos que no son de este servicio. Una envoltura que no lo es incumple el contrato y no se
// reintenta (*ContractError).
//
// El eventId se lee como texto, sin exigirle forma: es la clave de deduplicación, y los otros tres servidores aceptan
// cualquier texto.
func ParseEnvelope(text []byte) (Envelope[jsontext.Value], error) {
	if !jsontext.Value(text).IsValid() {
		return Envelope[jsontext.Value]{}, &ContractError{Reason: "El mensaje no es JSON válido"}
	}
	var raw struct {
		Metadata jsontext.Value \`json:"metadata"\`
		Data     jsontext.Value \`json:"data"\`
	}
	if jsontext.Value(text).Kind() != '{' || wire.Unmarshal(text, &raw) != nil || raw.Metadata.Kind() != '{' || len(raw.Data) == 0 {
		return Envelope[jsontext.Value]{}, &ContractError{Reason: "El mensaje no trae la envoltura Keel (metadata + data)"}
	}
	var metadata keelMetadata
	if err := wire.Unmarshal(raw.Metadata, &metadata); err != nil {
		return Envelope[jsontext.Value]{}, &ContractError{Reason: "La metadata de la envoltura no cumple el contrato del cable", Err: err}
	}
	if missing := metadata.missing(); missing != "" {
		return Envelope[jsontext.Value]{}, &ContractError{Reason: "La envoltura no trae metadata." + missing}
	}
	return Envelope[jsontext.Value]{
		Metadata: domain.EventMetadata{
			EventID:       *metadata.EventID,
			EventType:     *metadata.EventType,
			EventVersion:  *metadata.EventVersion,
			OccurredAt:    *metadata.OccurredAt,
			Source:        *metadata.Source,
			CorrelationID: metadata.CorrelationID,
			Traceparent:   metadata.Traceparent,
		},
		Data: raw.Data,
	}, nil
}

// ContractError es un mensaje que incumple el contrato de su suscripción: un campo obligatorio que falta, uno fuera de
// su cota o de su tipo, una envoltura que no lo es. Es el IllegalArgumentException del servidor de keel-spring, y como
// él NO se reintenta: un mensaje mal formado no se vuelve válido dentro de un segundo, así que va directo al descarte
// (la DLQ, si la suscripción la declara).
type ContractError struct {
	Reason string
	Err    error
}

// Error implementa error.
func (e *ContractError) Error() string {
	if e.Err != nil {
		return e.Reason + ": " + e.Err.Error()
	}
	return e.Reason
}

// Unwrap devuelve la causa, si la hay.
func (e *ContractError) Unwrap() error {
	return e.Err
}
`;
}

function inboundBody() {
  return `
// Inbound es el contexto de un mensaje consumido: lleva la correlación de origen de su envoltura Keel, que heredan los
// eventos que provoque. Sin correlación de origen (o con una que no cumple el formato), una nueva: correlation.Accept.
// El listener despacha el caso de uso con él.
func Inbound(ctx context.Context, metadata domain.EventMetadata) context.Context {
	received := ""
	if metadata.CorrelationID != nil {
		received = *metadata.CorrelationID
	}
	return correlation.WithID(ctx, correlation.Accept(received))
}
`;
}

// ─── Eventos de integración ──────────────────────────────────────────────────────────────────────

function integrationEventBody(model, event) {
  const name = integrationType(event);
  const domainEvent = `domain.${goExported(event.className)}`;
  const struct = alignRows([
    { indent: '\t', cells: ['Metadata', 'domain.EventMetadata', '`json:"-"`'] },
    ...event.fields.map((field) => ({ indent: '\t', cells: [goExported(field.name), declType(field, { qualify: true }), wireTag(model, field)] }))
  ]);
  const literal = keyedLiteral([['Metadata', 'event.Metadata'], ...event.fields.map((field) => [goExported(field.name), `event.${goExported(field.name)}`])], '\t\t');
  return `
// ${name} es la proyección de cable del evento de dominio ${event.className}${event.channel ? `, publicado en el canal '${event.channel}'` : ''}.
//
// Desacoplado del dominio a propósito: cambiar el broker o la serialización no alcanza a internal/domain. La metadata
// se conserva (el puente la necesita para la envoltura) pero NO se serializa: la autoritativa es la de la envoltura, y
// duplicarla en data confundiría al consumidor.${model.service?.omitNulls ? '\n// conventions.nulls: omit — un campo sin valor no viaja (service.keel.yaml).' : ''}
type ${name} struct {
${struct.join('\n')}
}

// New${name} proyecta el evento de dominio.
func New${name}(event ${domainEvent}) ${name} {
	return ${name}{
${literal.join('\n')}
	}
}
`;
}

// ─── El puente ───────────────────────────────────────────────────────────────────────────────────

function bridgeBody(model) {
  const outbox = usesGoOutbox(model);
  if (outbox) {
    const cases = model.events.map(
      (event) => `		case domain.${goExported(event.className)}:
			record, err = b.record(ctx, ${goString(event.name)}, e.Metadata, New${integrationType(event)}(e))`
    );
    return `
// OutboxRecord es una fila por escribir en el outbox: la envoltura ya serializada, con su destino, su routing key y su
// tipo (el NOMBRE del evento en el diseño, el mismo literal que estampa domain.NewEventMetadata: es sobre ese valor que
// filtran los consumidores).
type OutboxRecord struct {
	Destination string
	RoutingKey  string
	EventType   string
	Payload     string
}

// Bridge traduce cada evento de dominio a su evento de integración y lo entrega al outbox DENTRO de la transacción que
// provocó el cambio (reliability: outbox): la fila y el cambio del agregado confirman o revierten juntos. El relay la
// publica después, fuera de ella.
//
// Los eventos llegan aquí porque el adaptador de repositorio drena PullEvents al guardar el agregado. Nadie más publica
// eventos.
type Bridge struct {
	settings Settings
}

// NewBridge construye el puente con la mensajería del perfil.
func NewBridge(settings Settings) *Bridge {
	return &Bridge{settings: settings}
}

// Route traduce los eventos a las filas del outbox, que el adaptador de repositorio escribe en la transacción del
// cambio.
func (b *Bridge) Route(ctx context.Context, events []domain.Event) ([]OutboxRecord, error) {
	records := make([]OutboxRecord, 0, len(events))
	for _, event := range events {
		var (
			record OutboxRecord
			err    error
		)
		switch e := event.(type) {
${cases.join('\n')}
		default:
			// Un evento de dominio sin evento de integración es un hueco del scaffolding: que no pase en silencio.
			return nil, fmt.Errorf("el evento %s no tiene ruta de integración", event.EventMetadata().EventType)
		}
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

// record es la fila de un evento.
func (b *Bridge) record(ctx context.Context, eventType string, metadata domain.EventMetadata, data any) (OutboxRecord, error) {
	payload, err := NewEnvelope(ctx, metadata, data).Wire()
	if err != nil {
		return OutboxRecord{}, err
	}
	return OutboxRecord{Destination: b.settings.Destination, RoutingKey: b.settings.RoutingKeys[eventType], EventType: eventType, Payload: payload}, nil
}
`;
  }
  const cases = model.events.map(
    (event) => `		case domain.${goExported(event.className)}:
			err = b.publishers.${goExported(event.name)}.Publish(ctx, New${integrationType(event)}(e))`
  );
  return `
// Bridge traduce cada evento de dominio a su evento de integración y lo publica tras confirmar la transacción
// (reliability: best-effort): un rollback no publica nada, pero un fallo del broker sí pierde el evento.
//
// Los eventos llegan aquí porque el adaptador de repositorio drena PullEvents al guardar el agregado, y los entrega
// DESPUÉS del commit. Nadie más publica eventos.
type Bridge struct {
	publishers Publishers
	logger     *slog.Logger
}

// NewBridge construye el puente con los publishers del broker; los que falten son el respaldo que avisa.
func NewBridge(publishers Publishers, logger *slog.Logger) *Bridge {
	return &Bridge{publishers: publishers.withFallbacks(logger), logger: logger}
}

// Deliver publica los eventos ya confirmados. Un fallo no se propaga (el cambio ya se confirmó): se registra, y el
// evento se pierde, que es lo que best-effort acepta.
func (b *Bridge) Deliver(ctx context.Context, events []domain.Event) {
	for _, event := range events {
		var err error
		switch e := event.(type) {
${cases.join('\n')}
		default:
			// Un evento de dominio sin evento de integración es un hueco del scaffolding: que no pase en silencio.
			err = fmt.Errorf("el evento %s no tiene ruta de integración", event.EventMetadata().EventType)
		}
		if err != nil {
			b.logger.ErrorContext(ctx, "evento no publicado (best-effort)", "eventType", event.EventMetadata().EventType, "eventId", event.EventMetadata().EventID, "error", err)
		}
	}
}
`;
}

function publishersBody(model) {
  const ports = model.events.map(
    (event) => `// ${publisherPort(event)} publica el evento de integración ${event.name} (reliability: best-effort). La implementación
// del broker la escribe el agente en cmd/server/broker.go (NewEnvelope con el ctx que recibe, Wire, y el destino y la
// routing key de Settings); el único que lo invoca es el puente, DESPUÉS del commit.
type ${publisherPort(event)} interface {
	Publish(ctx context.Context, event ${integrationType(event)}) error
}`
  );
  const fields = alignRows(model.events.map((event) => ({ indent: '\t', cells: [goExported(event.name), publisherPort(event)] })));
  const fallbacks = model.events.map(
    (event) => `	if p.${goExported(event.name)} == nil {
		p.${goExported(event.name)} = publisherFallback[${integrationType(event)}]{eventType: ${goString(event.name)}, logger: logger}
	}`
  );
  return `
${ports.join('\n\n')}

// Publishers son los publishers de los eventos del servicio, uno por evento.
type Publishers struct {
${fields.join('\n')}
}

// withFallbacks pone el respaldo que avisa en cada publisher que el agente no implementó.
func (p Publishers) withFallbacks(logger *slog.Logger) Publishers {
${fallbacks.join('\n')}
	return p
}

// publisherFallback es el respaldo de un publisher mientras no hay uno real: el servicio arranca sin broker y cada
// evento deja un aviso. Cede el sitio en cuanto cmd/server/broker.go devuelva el suyo.
type publisherFallback[E any] struct {
	eventType string
	logger    *slog.Logger
}

// Publish avisa de que el evento no salió.
func (p publisherFallback[E]) Publish(ctx context.Context, _ E) error {
	p.logger.WarnContext(ctx, "publisher no implementado: el evento no salió del servicio", "eventType", p.eventType)
	return nil
}
`;
}

// ─── outbox.go ───────────────────────────────────────────────────────────────────────────────────

function outboxBody() {
  return `
// LastErrorLength es la cota de outbox_event.last_error: el mensaje de un fallo se trunca a ella antes de guardarse.
const LastErrorLength = ${OUTBOX_LAST_ERROR_LENGTH}

// OutboxEvent es lo que el relay necesita de una fila reclamada para publicarla.
type OutboxEvent struct {
	ID          uuid.UUID
	Destination string
	RoutingKey  string
	EventType   string
	Payload     string
}

// FailedOutcome es el desenlace de un fallo: cuántos intentos lleva la fila y si se rindió.
type FailedOutcome struct {
	Attempts     int
	DeadLettered bool
}

// OutboxStore son las transacciones CORTAS del relay, separadas de la publicación al broker. Las implementa el
// adaptador relacional, cada una en su propia transacción:
//   - ClaimBatch reclama con SKIP LOCKED más un LEASE sobre next_attempt_at, que retira la fila de las siguientes
//     pasadas mientras dura el despacho; confirma y suelta el lock en cuanto reclama;
//   - MarkPublished y MarkFailed registran el desenlace; MarkFailed incrementa el intento y decide rendición o backoff
//     con el contador YA incrementado, en la misma transacción.
type OutboxStore interface {
	ClaimBatch(ctx context.Context, maxAttempts, batchSize int, lease time.Duration) ([]OutboxEvent, error)
	MarkPublished(ctx context.Context, id uuid.UUID) error
	MarkFailed(ctx context.Context, id uuid.UUID, reason string, maxAttempts int, backoffInitial, backoffMax time.Duration) (FailedOutcome, error)
	CountDeadLettered(ctx context.Context, maxAttempts int) (int, error)
}

// Dispatcher entrega al broker una fila ya serializada. Es lo ÚNICO acoplado al broker en todo el patrón; la
// implementación la escribe el agente en cmd/server/broker.go. Tiene que FALLAR si el broker no confirma la entrega: el
// relay cuenta el intento y reintenta en la pasada siguiente.
type Dispatcher interface {
	Dispatch(ctx context.Context, destination, routingKey, eventType, payload string) error
}

// tolerated son los perfiles en los que arrancar sin dispatcher es legítimo.
var tolerated = []string{"local", "test"}

// NewDispatcherFallback es el respaldo del Dispatcher mientras no hay uno real. Su Dispatch NO falla —si fallara, las
// filas acumularían intentos hasta la rendición—, y eso tiene un precio: el relay marca como publicadas filas que nunca
// salieron. En local y test es lo que se quiere (arrancar sin broker); en cualquier otro perfil reliability: outbox se
// convertiría en perder TODOS los eventos sin un error, así que ahí no deja arrancar.
func NewDispatcherFallback(profiles []string, logger *slog.Logger) (Dispatcher, error) {
	if len(profiles) > 0 && !slices.ContainsFunc(profiles, func(profile string) bool { return slices.Contains(tolerated, profile) }) {
		return nil, fmt.Errorf("no hay implementación de messaging.Dispatcher y el perfil activo es %s: el relay marcaría como publicados "+
			"eventos que nunca salen del proceso; impleméntalo en cmd/server/broker.go con la skill keel-go-<broker> del stack de keel-stack.json",
			strings.Join(profiles, ","))
	}
	logger.Warn("messaging.Dispatcher sin implementar: los eventos NO salen del proceso", "profiles", strings.Join(profiles, ","))
	return dispatcherFallback{logger: logger}, nil
}

type dispatcherFallback struct {
	logger *slog.Logger
}

// Dispatch avisa de que el evento no salió.
func (d dispatcherFallback) Dispatch(ctx context.Context, destination, routingKey, eventType, _ string) error {
	d.logger.WarnContext(ctx, "messaging.Dispatcher no implementado: el evento no salió", "eventType", eventType, "destination", destination, "routingKey", routingKey)
	return nil
}

// BackoffDelay es el aplazamiento tras el fallo número attempts (1 = el primero): initial·2^(attempts-1), saturado en
// ceiling. La referencia es outboxBackoffMs de keel-core, la fórmula que aplica el relay de keel-spring.
func BackoffDelay(attempts int, initial, ceiling time.Duration) time.Duration {
	delay := float64(initial) * math.Pow(2, float64(max(attempts-1, 0)))
	if math.IsInf(delay, 0) || delay > float64(ceiling) {
		return ceiling
	}
	return time.Duration(delay)
}

// DeadLettered dice si una fila se rinde con este número de fallos, con el contador YA incrementado.
func DeadLettered(attempts, maxAttempts int) bool {
	return attempts >= maxAttempts
}

// TruncateError es el mensaje de un fallo truncado a la cota de la columna, sin partir un carácter.
func TruncateError(err error) string {
	message := err.Error()
	if len(message) <= LastErrorLength {
		return message
	}
	cut := LastErrorLength
	for cut > 0 && !utf8.RuneStart(message[cut]) {
		cut--
	}
	return message[:cut]
}

// Relay reenvía al broker las filas pendientes del outbox, ya fuera de la transacción que las creó.
//
// Tres pasos, y la publicación no está dentro de ninguna transacción: OutboxStore.ClaimBatch reclama el lote en una
// transacción corta, el dispatcher publica sin conexión retenida, y el desenlace va en otra transacción corta. Un fallo
// de entrega no revierte nada: cuenta el intento y la fila se reintenta tras su backoff (entrega at-least-once: el
// consumidor deduplica por metadata.eventId). La que agota MaxAttempts se rinde: deja de reclamarse y se registra a
// ERROR, sin borrarse.
type Relay struct {
	store      OutboxStore
	dispatcher Dispatcher
	settings   OutboxRelaySettings
	logger     *slog.Logger
	// pass es una pasada a la vez; también guarda paused, así que pausar espera a la pasada en vuelo.
	pass   sync.Mutex
	paused bool
}

// NewRelay construye el relay.
func NewRelay(store OutboxStore, dispatcher Dispatcher, settings OutboxRelaySettings, logger *slog.Logger) *Relay {
	return &Relay{store: store, dispatcher: dispatcher, settings: settings, logger: logger}
}

// Run hace una pasada cada FixedDelay (un retardo FIJO entre el final de una y el principio de la siguiente) hasta que
// ctx se cancela. Al cancelarse no empieza otra publicación: las filas que quedan conservan su lease y otra pasada las
// recoge. Una pasada que falla entera (la base caída) no para el relay: lo intenta en la siguiente.
func (r *Relay) Run(ctx context.Context) error {
	timer := time.NewTimer(r.settings.FixedDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
		if _, err := r.scheduledPass(ctx); err != nil && ctx.Err() == nil {
			r.logger.ErrorContext(ctx, "outbox: la pasada del relay falló", "error", err)
		}
		timer.Reset(r.settings.FixedDelay)
	}
}

// scheduledPass es la pasada del reloj: ninguna mientras el relay esté en pausa.
func (r *Relay) scheduledPass(ctx context.Context) (int, error) {
	r.pass.Lock()
	defer r.pass.Unlock()
	if r.paused {
		return 0, nil
	}
	return r.relay(ctx)
}

// RelayOnce es una pasada fuera del reloj, también en pausa: reclama, publica y registra el desenlace de cada fila.
// Devuelve cuántas reclamó.
func (r *Relay) RelayOnce(ctx context.Context) (int, error) {
	r.pass.Lock()
	defer r.pass.Unlock()
	return r.relay(ctx)
}

func (r *Relay) relay(ctx context.Context) (int, error) {
	claimed, err := r.store.ClaimBatch(ctx, r.settings.MaxAttempts, r.settings.BatchSize, r.settings.ClaimTimeout)
	if err != nil {
		return 0, err
	}
	// La publicación y el desenlace no se cortan a medias: una fila cuyo envío empezó termina de registrarse.
	work := context.WithoutCancel(ctx)
	for _, row := range claimed {
		if ctx.Err() != nil {
			break
		}
		if err := r.dispatcher.Dispatch(work, row.Destination, row.RoutingKey, row.EventType, row.Payload); err != nil {
			reason := TruncateError(err)
			outcome, markErr := r.store.MarkFailed(work, row.ID, reason, r.settings.MaxAttempts, r.settings.BackoffInitial, r.settings.BackoffMax)
			switch {
			case markErr != nil:
				return len(claimed), markErr
			case outcome.DeadLettered:
				// La rendición: queda parada para inspección, sin borrarse ni bloquear al resto.
				r.logger.ErrorContext(ctx, "outbox: la fila agotó sus reintentos y queda como dead-letter", "id", row.ID, "maxAttempts", r.settings.MaxAttempts, "reason", reason)
			default:
				r.logger.WarnContext(ctx, "outbox: fallo entregando la fila", "id", row.ID, "attempt", outcome.Attempts, "reason", reason)
			}
			continue
		}
		if err := r.store.MarkPublished(work, row.ID); err != nil {
			return len(claimed), err
		}
		r.logger.DebugContext(ctx, "outbox: evento publicado", "eventType", row.EventType, "id", row.ID)
	}
	return len(claimed), nil
}

// Pause suspende las pasadas, esperando a la que esté en vuelo. Es para el arnés de integración, que fabrica así la
// precondición de un escenario del outbox (una fila pendiente que nadie entrega todavía).
func (r *Relay) Pause() {
	r.pass.Lock()
	defer r.pass.Unlock()
	r.paused = true
}

// Resume reanuda las pasadas suspendidas con Pause.
func (r *Relay) Resume() {
	r.pass.Lock()
	defer r.pass.Unlock()
	r.paused = false
}

// CountDeadLettered son las filas rendidas ahora mismo: la señal de que el outbox perdió algo.
func (r *Relay) CountDeadLettered(ctx context.Context) (int, error) {
	return r.store.CountDeadLettered(ctx, r.settings.MaxAttempts)
}
`;
}

// ─── guard.go ────────────────────────────────────────────────────────────────────────────────────

function guardBody() {
  return `
// ProcessedEvents es el registro de los mensajes ya procesados (la tabla processed_event): lo implementa el adaptador
// relacional, cada operación en su PROPIA transacción, que sobrevive al fallo del handler. Insert devuelve false si el
// par ya estaba: la clave primaria arbitra la carrera entre dos entregas simultáneas.
type ProcessedEvents interface {
	Exists(ctx context.Context, handlerID, eventID string) (bool, error)
	Insert(ctx context.Context, handlerID, eventID string) (bool, error)
}

// IdempotencyGuard es la guarda de idempotencia del consumidor. La entrega de cualquier broker es at-least-once y el
// relay del outbox reintenta: la reentrega no es un caso raro, es lo normal ante cualquier corte.
//
// Hay DOS órdenes y no son intercambiables, porque el registro va en su propia transacción:
//  1. procesar y luego registrar (AlreadyProcessed antes, Record después de que el handler termine bien). Es el
//     predeterminado: un fallo transitorio deja el mensaje sin marcar y la reentrega lo reintenta. Si el proceso muere
//     entre el commit del negocio y el registro, la reentrega se procesa dos veces: por eso este orden pide una guarda
//     de dominio detrás;
//  2. registrar y luego procesar (TryRecord, atómico). Cierra la ventana del duplicado, pero convierte un fallo
//     transitorio en un mensaje PERDIDO. Solo si reprocesar es inaceptable y perder tolerable.
//
// Cuál toca lo dice el comentario del mensaje de cada suscripción. Con varias réplicas, el árbitro es la clave primaria
// de processed_event, que es compartida.
type IdempotencyGuard struct {
	store  ProcessedEvents
	logger *slog.Logger
}

// NewIdempotencyGuard construye la guarda sobre el registro.
func NewIdempotencyGuard(store ProcessedEvents, logger *slog.Logger) *IdempotencyGuard {
	return &IdempotencyGuard{store: store, logger: logger}
}

// AlreadyProcessed dice si el consumidor handlerID ya procesó el mensaje eventID (el messageId del diseño o
// Metadata.EventID), sin efectos: para descartar la reentrega antes de despachar.
func (g *IdempotencyGuard) AlreadyProcessed(ctx context.Context, handlerID, eventID string) (bool, error) {
	seen, err := g.store.Exists(ctx, handlerID, eventID)
	if err == nil && seen {
		g.logger.InfoContext(ctx, "mensaje duplicado: ya procesado", "handler", handlerID, "eventId", eventID)
	}
	return seen, err
}

// Record registra el mensaje DESPUÉS de procesarlo. Que ya estuviera no es un error: otra entrega llegó antes y el
// mensaje quedó atendido igual.
func (g *IdempotencyGuard) Record(ctx context.Context, handlerID, eventID string) error {
	inserted, err := g.store.Insert(ctx, handlerID, eventID)
	if err == nil && !inserted {
		g.logger.InfoContext(ctx, "mensaje duplicado: ya registrado", "handler", handlerID, "eventId", eventID)
	}
	return err
}

// TryRecord registra el mensaje ANTES de procesarlo y dice si esta entrega lo reclamó; false es que otra ya lo hizo.
func (g *IdempotencyGuard) TryRecord(ctx context.Context, handlerID, eventID string) (bool, error) {
	inserted, err := g.store.Insert(ctx, handlerID, eventID)
	if err == nil && !inserted {
		g.logger.InfoContext(ctx, "mensaje duplicado: otra entrega lo reclamó", "handler", handlerID, "eventId", eventID)
	}
	return inserted, err
}
`;
}

// ─── Mensajes de suscripción ─────────────────────────────────────────────────────────────────────

/** El tipo con el que el mensaje DECLARA un campo: todo admite ausencia salvo la lista (la presencia la juzga RequireContract). */
function messageFieldType(field) {
  if (field.list) return appType(field);
  return `*${appType({ ...field, required: true })}`;
}

function messageImports(sub) {
  return ['encoding/json/jsontext', 'encoding/json/v2', 'fmt', 'strings', 'internal/domain', 'internal/platform/wire', 'github.com/google/uuid', 'time', ...sub.fields.flatMap(fieldImports)];
}

function messageBody(model, sub, plan) {
  const name = messageStruct(sub);
  const struct = alignRows(sub.fields.map((field) => ({ indent: '\t', cells: [goExported(field.name), messageFieldType(field), `\`json:"${field.wireName ?? field.name}"\``] })));
  const presence = sub.fields
    .filter((field) => field.required && !field.list)
    .map(
      (field) => `	if m.${goExported(field.name)} == nil {
		return &ContractError{Reason: ${goString(`${sub.name}: el mensaje no trae '${field.name}', que el contrato declara obligatorio`)}}
	}`
    );
  const bounds = sub.fields.flatMap((field) => {
    const rules = (field.inputValidation ?? field.validation ?? []).filter((rule) => !PRESENCE.has(rule.rule));
    const each = field.list ? (field.elementInputValidation ?? []).filter((rule) => !PRESENCE.has(rule.rule)) : [];
    if (rules.length === 0 && each.length === 0) return [];
    const member = `m.${goExported(field.name)}`;
    return componentChecks(field, {
      rules,
      each,
      present: field.list ? null : `${member} != nil`,
      value: field.list ? member : `*${member}`,
      sink: 'checks',
      path: goString(field.name),
      plan
    });
  });
  if (bounds.length > 0) plan.uses.add('violations');
  const boundsBlock =
    bounds.length > 0
      ? `	var checks violations
${bounds.join('\n')}
	if len(checks.details) > 0 {
		field, detail, _ := strings.Cut(checks.details[0], " ")
		return &ContractError{Reason: fmt.Sprintf(${goString(`${sub.name}: el mensaje incumple el contrato en '%s': %s`)}, field, detail)}
	}`
      : '';
  const contract = [...presence, boundsBlock].filter(Boolean);
  const reject = sub.unknownFields === 'fail' ? ', json.RejectUnknownMembers(true)' : '';
  return `
// ${name} es el payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.
//
${contractDoc(model, sub).join('\n')}
type ${name} struct {
${struct.join('\n')}
}

// ${readerFunc(sub)} lee el payload del cable${sub.fields.some((f) => f.wireName) ? ' (con los nombres de la fuente: wireName)' : ''}. Un valor que no es de su tipo incumple el contrato y
// no se reintenta. ${sub.unknownFields === 'fail' ? 'Un campo de más también (unknownFields: fail).' : 'Los campos de más se ignoran (unknownFields: ignore).'} La PRESENCIA no se comprueba aquí: la comprueba
// RequireContract, después de filtrar.
func ${readerFunc(sub)}(data jsontext.Value) (${name}, error) {
	var message ${name}
	if data.Kind() != '{' {
		return ${name}{}, &ContractError{Reason: ${goString(`${sub.name}: el payload no cumple el contrato del cable`)}}
	}
	if err := json.Unmarshal(data, &message, wire.Options()${reject}); err != nil {
		return ${name}{}, &ContractError{Reason: ${goString(`${sub.name}: el payload no cumple el contrato del cable`)}, Err: err}
	}
	return message, nil
}

// RequireContract comprueba el contrato de la fuente: los campos que el diseño declara obligatorios tienen que venir, y
// dentro de sus cotas. Llámalo DESPUÉS de filtrar por el tipo del mensaje —uno ajeno del canal compartido se descarta
// SIN error, y un error aquí lo mandaría al descarte—. Lo que incumple el contrato es un *ContractError, que va al
// descarte SIN reintentos.
func (m ${name}) RequireContract() error {
${contract.length > 0 ? `${contract.join('\n')}\n` : ''}	return nil
}
`;
}

function wrappedEnvelopeBody(sub) {
  const path = sub.payloadPath.split('.');
  const rows = [{ indent: '\t', cells: [goExported(path[0]), 'jsontext.Value', `\`json:"${path[0]}"\``] }];
  for (const part of [sub.discriminator, sub.messageId]) {
    if (part?.location === 'field' && !part.name.includes('.')) rows.push({ indent: '\t', cells: [goExported(part.name), '*string', `\`json:"${part.name}"\``] });
  }
  const name = goExported(sub.envelopeRecord);
  const descend =
    path.length > 1
      ? `	// payloadPath anidado: se desciende por '${sub.payloadPath}'.
	node := e.${goExported(path[0])}
	for _, key := range []string{${path.slice(1).map(goString).join(', ')}} {
		var object map[string]jsontext.Value
		if node.Kind() != '{' || json.Unmarshal(node, &object) != nil {
			node = nil
			break
		}
		node = object[key]
	}
	return ${readerFunc(sub)}(node)`
      : `	return ${readerFunc(sub)}(e.${goExported(path[0])})`;
  return `
// ${name} es la envoltura con la que ${sub.source ?? 'la fuente'} publica ${sub.name}: el payload cuelga de '${sub.payloadPath}'. Los campos que
// no se nombran se ignoran.
type ${name} struct {
${alignRows(rows).join('\n')}
}

// Parse${name} lee la envoltura del cable; el payload queda sin leer hasta que se sepa que el mensaje es nuestro.
func Parse${name}(text []byte) (${name}, error) {
	var envelope ${name}
	if !jsontext.Value(text).IsValid() || jsontext.Value(text).Kind() != '{' || wire.Unmarshal(text, &envelope) != nil {
		return ${name}{}, &ContractError{Reason: ${goString(`${sub.name}: el mensaje no es la envoltura de la fuente`)}}
	}
	return envelope, nil
}

// Message lee el payload con el contrato de ${messageStruct(sub)}.
func (e ${name}) Message() (${messageStruct(sub)}, error) {
${descend}
}
`;
}

// El contrato de recepción, escrito donde lo va a leer el agente al escribir el listener. Es el de keel-spring
// (`contractJavadoc`), keel-nest y keel-dotnet, con los nombres de keel-go.
function contractDoc(model, sub) {
  const lines = [];
  if (sub.envelope === 'wrapped') {
    lines.push(`Llega envuelto en ${goExported(sub.envelopeRecord)} (Parse${goExported(sub.envelopeRecord)} y después Message); el payload cuelga de '${sub.payloadPath}'.`);
  } else if (sub.envelope === 'keel') {
    lines.push(`Llega en la Envelope estándar de Keel (metadata + data): ParseEnvelope, y después ${readerFunc(sub)}(envelope.Data).`);
  } else {
    lines.push(`Llega plano: el mensaje es este payload (${readerFunc(sub)} sobre el cuerpo).`);
  }
  if (sub.format !== 'json') lines.push(`Formato: ${sub.format}${sub.schemaRef ? ` (schema '${sub.schemaRef}')` : ''}.`);
  if (sub.discriminator) {
    lines.push(`Se reconoce por ${sub.discriminator.location} '${sub.discriminator.name}' == '${sub.discriminator.value}': el canal transporta más tipos, descarta el resto SIN error.`);
  } else if (sub.envelope === 'keel') {
    const shared = (model.subscriptions ?? []).filter((other) => other.name !== sub.name && other.topicDefault === sub.topicDefault).map((other) => other.name);
    lines.push(
      `Se reconoce por Metadata.EventType == '${sub.name}': '${sub.topicDefault}' transporta todos los eventos de ${sub.source ?? 'la fuente'}, ` +
        'así que descarta el resto SIN error (un error dispara el reintento y acaba mandando al descarte un mensaje válido que no era para ti).' +
        (shared.length > 0 ? ` En este diseño el destino lo comparten ${shared.join(', ')}.` : '')
    );
  }
  const dedupeKey = sub.messageId
    ? `${sub.messageId.location} '${sub.messageId.name}'`
    : sub.envelope === 'keel'
      ? 'Metadata.EventID de la envoltura (lo estampa el emisor al emitir y viaja intacto)'
      : null;
  if (dedupeKey) {
    lines.push(`Deduplica por ${dedupeKey} antes de despachar (la entrega es at-least-once).`);
    const guardReason =
      sub.triggerGuardKind === 'natural-key'
        ? 'la clave de idempotencia participa en la clave natural del agregado, así que esa constraint ES la guarda'
        : 'la operación declara transiciones, así que la repetición la frena el agregado';
    lines.push(
      sub.triggerHasDomainGuard
        ? `Orden: IdempotencyGuard.AlreadyProcessed antes de despachar y Record DESPUÉS de que el handler termine bien: ${guardReason}, y lo que no puede perderse es el mensaje —registrar ANTES haría que un fallo terminal se viera como «ya procesado» y su reintento no llegara nunca al descarte—.`
        : 'Orden: IdempotencyGuard.TryRecord antes de despachar —la operación no declara ninguna guarda de dominio que frene la repetición, así que la ventana se cierra reclamando antes—. Un fallo del handler deja el mensaje marcado y perdido; si eso no es tolerable, lo que falta es la guarda de dominio en el diseño.'
    );
    lines.push(
      'La deduplicación tiene VENTANA: el registro se purgará a los processed-event.purge.retention-days (default 14), así que una reentrega posterior se procesa como nueva.' +
        (sub.triggerHasDomainGuard ? ' Aquí es inocuo: la guarda de dominio sigue rechazándola, y esa no caduca.' : ' Aquí NO es inocuo: sin guarda de dominio, pasada la retención el efecto se vuelve a aplicar.')
    );
  }
  const broker = model.stack?.broker;
  if (broker && missingTargetRetryDestinations(model, broker).includes(subscriptionDestination(broker, model, sub))) {
    lines.push(
      'Un «no existe» (domain.KindNotFound) del caso de uso SÍ se reintenta: aquí suele ser la carrera de orden de un consumo asíncrono —el mensaje llega antes que el hecho del que depende— y el reintento la resuelve; agotado, va al descarte igual. Devuélvelo como error: no lo confirmes ni lo trates como un rechazo más.'
    );
  }
  if (sub.identity) {
    lines.push(
      `Identidad del emisor: resuelve ${sub.identity.field} desde ${sub.identity.from.location === 'header' ? `el header '${sub.identity.from.name}'` : `el campo '${sub.identity.from.name}' del mensaje`}, y pásala YA RESUELTA a la operación. No la leas del payload. Se resuelve 1:1: el valor leído ES la clave natural del recurso que identifica.`
    );
    lines.push(
      sub.identity.onUnresolved === 'deadLetter'
        ? 'Un emisor que no corresponda a nadie registrado va al descarte (onUnresolved: deadLetter): NO lo proceses y NO lo confirmes en silencio.'
        : 'Un emisor que no corresponda a nadie registrado se descarta (onUnresolved: discard): confirma el mensaje y déjalo en el log. Es un fallo PERMANENTE.'
    );
  }
  if ((sub.triggerRaces ?? []).length > 0) {
    lines.push(
      `Compite con ${sub.triggerRaces.join(', ')}: sacan la entidad del mismo estado. Si al despachar la transición se rechaza porque otro llegó antes, es la carrera resuelta y NO un fallo: confirma el mensaje y no lo reintentes.`,
      'Se rechaza de DOS formas y las dos son esta carrera: la transición inválida (otro camino ya movió el estado) y el conflicto de concurrencia (llegasteis a la vez y perdió el commit); trátalas juntas.'
    );
    if (sub.triggerHasDomainGuard) lines.push('Esa rama termina igualmente en IdempotencyGuard.Record: el mensaje quedó atendido, por el otro camino.');
  }
  if (sub.deadLetter) {
    lines.push(
      broker === 'rabbitmq' || !broker
        ? 'Con onFailure.deadLetter: tras agotar los reintentos el broker lo mueve al descarte de su cola. La topología la genera build: NO la declares tú.'
        : `Con onFailure.deadLetter: su descarte es ${deadLetterDestination(broker, model, sub)}. La conexión con el broker es de build: NO lo publiques tú.`
    );
  }
  const acknowledged = acknowledgeNote(sub);
  if (acknowledged) lines.push(acknowledged);
  const unit = consumerUnits(model).find((entry) => entry.subscriptions.includes(sub.name));
  let consumer;
  if (unit?.group) consumer = `el listener de su consumer group (${unit.group}), que recibe el topic ${unit.topic} entero`;
  else if (unit && unit.subscriptions.length > 1)
    consumer = `el listener de la cola ${unit.queue}, que comparte con ${unit.subscriptions.filter((other) => other !== sub.name).join(', ')} y enruta por el tipo del mensaje`;
  else consumer = `el listener de su cola${unit ? ` (${unit.queue})` : ''}`;
  const operation = operations(model).find((candidate) => candidate.name === sub.trigger);
  if (operation) {
    const paymentToken = model.payments?.charge?.operation === sub.trigger ? model.payments.charge.source.token : null;
    const fields = sub.triggerArguments.map((a) => {
      const value =
        a.from === 'envelope'
          ? `envelope.Metadata.${goExported(a.source)}`
          : a.from === 'identity'
            ? 'la identidad resuelta'
            : a.source
              ? // Lo obligatorio llega como puntero y RequireContract ya garantizó que viene.
                `${sub.fields.some((field) => field.name === a.source && field.required && !field.list) ? '*' : ''}message.${goExported(a.source)}`
              : a.component === paymentToken
                ? 'nil (por evento no hay cliente delante: solo se cobra un medio guardado)'
                : '<lo decide el agente: el mensaje no lo trae>';
      return `${goExported(a.component)}: ${value}`;
    });
    lines.push(
      `Lo consume ${consumer}: lo escribe el agente en cmd/server/broker.go y despacha con useCases.${useCaseField(operation)}.Handle(messaging.Inbound(ctx, envelope.Metadata), application.${messageType(operation)}{${fields.join(', ')}}).`
    );
  } else {
    lines.push(`Lo consume ${consumer}: lo escribe el agente en cmd/server/broker.go.`);
  }
  return lines.flatMap((line, index) => [...(index > 0 ? ['//'] : []), ...wrap(line).map((text) => `// ${text}`)]);
}

/** Parte un párrafo en líneas de comentario de hasta 116 caracteres. */
function wrap(text, width = 116) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// ─── contract.go ─────────────────────────────────────────────────────────────────────────────────

/** Lo que comparten los RequireContract: el acumulador de detalles y los auxiliares de las cotas que se usan. */
function contractBody(plan) {
  const helpers = Object.entries(VALIDATION)
    .filter(([name]) => name !== 'violations' && plan.uses.has(name))
    .map(([, snippet]) => snippet.code.trim());
  return [
    `
// violations acumula lo que un mensaje incumple dentro de sus cotas, con los mensajes de Bean Validation de los otros
// tres servidores: cada detalle es «campo mensaje». RequireContract informa del primero.
type violations struct {
	details []string
}

func (v *violations) add(path, message string) {
	v.details = append(v.details, path+" "+message)
}`.trim(),
    ...helpers,
    patternsBlock(plan)
  ]
    .filter(Boolean)
    .join('\n\n')
    .replace(/^/, '\n')
    .concat('\n');
}

// ─── La prueba emitida ───────────────────────────────────────────────────────────────────────────

function emittedTest(model) {
  const outbox = usesGoOutbox(model);
  const backoff = outbox
    ? `
// El backoff del relay, contra la referencia de keel-core (outboxBackoffMs) con los defaults del diseño.
func TestBackoffDelay(t *testing.T) {
	initial := ${OUTBOX_RELAY.backoffInitialMs.default} * time.Millisecond
	ceiling := ${OUTBOX_RELAY.backoffMaxMs.default} * time.Millisecond
	cases := []struct {
		attempts int
		want     time.Duration
	}{
${[0, 1, 2, 3, 6, 7, 40, 2000].map((attempts) => `		{${attempts}, ${outboxBackoffMs(attempts, OUTBOX_RELAY.backoffInitialMs.default, OUTBOX_RELAY.backoffMaxMs.default)} * time.Millisecond},`).join('\n')}
	}
	for _, c := range cases {
		if got := messaging.BackoffDelay(c.attempts, initial, ceiling); got != c.want {
			t.Errorf("BackoffDelay(%d) = %v, quiero %v", c.attempts, got, c.want)
		}
	}
	if messaging.DeadLettered(${OUTBOX_RELAY.maxAttempts.default - 1}, ${OUTBOX_RELAY.maxAttempts.default}) || !messaging.DeadLettered(${OUTBOX_RELAY.maxAttempts.default}, ${OUTBOX_RELAY.maxAttempts.default}) {
		t.Error("DeadLettered: una fila se rinde al alcanzar max-attempts, no antes")
	}
}

func TestTruncateError(t *testing.T) {
	long := errors.New(strings.Repeat("ñ", messaging.LastErrorLength))
	got := messaging.TruncateError(long)
	if len(got) > messaging.LastErrorLength || !strings.HasPrefix(long.Error(), got) || !utf8Valid(got) {
		t.Errorf("TruncateError dejó %d bytes", len(got))
	}
}

func utf8Valid(text string) bool {
	return strings.ToValidUTF8(text, "?") == text
}
`
    : '';
  return `
// La envoltura en el cable (el orden de WIRE_SHAPES y los nulos), su lectura y sus rechazos${outbox ? ', y el backoff del relay' : ''}. Lo que
// solo juzga la base (el reclamo, el lease, la guarda) lo mide db-check, y lo del broker, broker-check.

func TestEnvelopeWireShape(t *testing.T) {
	metadata := domain.EventMetadata{
		EventID:      "0190a8a8-0000-7000-8000-000000000001",
		EventType:    "Something",
		EventVersion: 1,
		OccurredAt:   time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC),
		Source:       "some-service",
	}
	ctx := correlation.WithID(t.Context(), "corr-1")
	text, err := messaging.NewEnvelope(ctx, metadata, map[string]int{"n": 1}).Wire()
	if err != nil {
		t.Fatal(err)
	}
	want := \`{"metadata":{"eventId":"0190a8a8-0000-7000-8000-000000000001","eventType":"Something","eventVersion":1,"occurredAt":"2026-01-02T03:04:05.006Z","source":"some-service","correlationId":"corr-1","traceparent":null},"data":{"n":1}}\`
	if text != want {
		t.Errorf("envoltura\\n got %s\\nwant %s", text, want)
	}
	parsed, err := messaging.ParseEnvelope([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Metadata.EventID != metadata.EventID || !parsed.Metadata.OccurredAt.Equal(metadata.OccurredAt) || *parsed.Metadata.CorrelationID != "corr-1" {
		t.Errorf("la envoltura leída no es la escrita: %+v", parsed.Metadata)
	}
	if string(parsed.Data) != \`{"n":1}\` {
		t.Errorf("data = %s", parsed.Data)
	}
	inbound := messaging.Inbound(t.Context(), parsed.Metadata)
	if id, _ := correlation.ID(inbound); id != "corr-1" {
		t.Errorf("Inbound no conserva la correlación de origen: %q", id)
	}
}

func TestEnvelopeRejections(t *testing.T) {
	for name, text := range map[string]string{
		"no es JSON":          \`{"metadata":\`,
		"no es un objeto":     \`[]\`,
		"sin envoltura":       \`{"n":1}\`,
		"metadata no objeto":  \`{"metadata":1,"data":{}}\`,
		"sin eventId":         \`{"metadata":{"eventType":"X","eventVersion":1,"occurredAt":"2026-01-02T03:04:05.006Z","source":"s"},"data":{}}\`,
		"occurredAt sin zona": \`{"metadata":{"eventId":"e","eventType":"X","eventVersion":1,"occurredAt":"2026-01-02T03:04:05","source":"s"},"data":{}}\`,
	} {
		_, err := messaging.ParseEnvelope([]byte(text))
		var contract *messaging.ContractError
		if !errors.As(err, &contract) {
			t.Errorf("%s: ParseEnvelope = %v, quiero un *ContractError", name, err)
		}
	}
}
${backoff}`;
}


export { MESSAGING_IMPORT };
